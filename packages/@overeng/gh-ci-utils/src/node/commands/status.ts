import { Duration, Effect, Option } from 'effect'
/**
 * gh-ci-utils status [target] [-w] [--watch-mode first-failure|until-done]
 *
 * Single-run CI view with errors/annotations.
 */
import * as Cli from 'effect/unstable/cli'
import React from 'react'

import type { OutputModeValue } from '@overeng/tui-react/node'
import { isAgentEnv, outputModeLayer, outputOption } from '@overeng/tui-react/node'

import type { WorkflowRun } from '../../isomorphic/GitHubSchemas.ts'
import {
  API_CONCURRENCY,
  MAX_POLL_INTERVAL,
  POLL_INTERVAL,
} from '../../isomorphic/lib/constants.ts'
import { computeDurationSeconds } from '../../isomorphic/lib/format.ts'
import { extractErrorLines } from '../../isomorphic/lib/logFilter.ts'
import { computeSummary, isBlockingConclusion, toJobVM } from '../../isomorphic/lib/summary.ts'
import type { PrHealth, RunInfo } from '../../isomorphic/lib/viewModels.ts'
import {
  type JobFingerprint,
  BUDGET_RESERVE_FRACTION,
  RateLimitWaitPolicy,
  diffJobs,
  nextPollSeconds,
} from '../../isomorphic/lib/watchPlan.ts'
import {
  CiApp,
  CiView,
  type AnnotationInfo,
  type JobError,
  type RunnerHostMap,
} from '../../isomorphic/renderers/CiOutput/mod.ts'
import { resolveConfig } from '../Config.ts'
import { GitHubClient } from '../GitHubClient.ts'
import { collectApiMeta } from '../lib/apiMeta.ts'
import {
  type ResolvedTarget,
  resolveTarget,
  resolveTargetOrCurrentBranch,
  targetArg,
  watchModeOption,
  watchOption,
  timeoutOption,
  workflowOption,
} from '../RunId.ts'
import { fetchAllRunnerJobs } from '../RunnerClient.ts'

const toRunInfo = (run: WorkflowRun): RunInfo => ({
  id: run.id,
  name: run.name,
  runNumber: run.run_number,
  headBranch: run.head_branch,
  status: run.status,
  conclusion: run.conclusion,
  event: run.event,
  workflowPath: run.path,
  htmlUrl: run.html_url,
  elapsedSeconds: computeDurationSeconds({
    startedAt: run.run_started_at,
    completedAt: run.status === 'completed' ? run.updated_at : null,
  }),
})

/**
 * Derived data carried from one watch tick to the next.
 *
 * Log-extracted errors are a function of a job's lifecycle state, so
 * re-fetching them for a job that did not move is pure waste — and with 20-30
 * jobs it is the bulk of the API cost of a watch. Annotations are re-fetched
 * every tick (GitHub attaches them late) but conditionally, so the cache only
 * serves as the fallback when a fetch fails.
 */
interface TickCache {
  readonly fingerprints: ReadonlyMap<number, JobFingerprint>
  readonly annotationsByJob: ReadonlyMap<number, ReadonlyArray<AnnotationInfo>>
  /**
   * Errors from completed log fetches. `null` means the logs were read and
   * held nothing worth reporting. A fetch that failed is deliberately absent,
   * so the next tick retries: GitHub often needs a few seconds after a job
   * ends before its logs resolve.
   */
  readonly errorsByJob: ReadonlyMap<number, JobError | null>
}

/** Cache for the first tick, which necessarily fetches everything. */
const emptyTickCache: TickCache = {
  fingerprints: new Map(),
  annotationsByJob: new Map(),
  errorsByJob: new Map(),
}

/** Fetch single-run data: jobs, errors from failed job logs, annotations, and PR health. */
const fetchSingleRunData = ({
  resolvedRepo,
  runId,
  runnerHosts,
  includeSteps,
  cache,
  prNumber,
}: {
  resolvedRepo: string
  runId: number
  runnerHosts: readonly string[]
  includeSteps: boolean
  cache: TickCache
  prNumber: number | null
}) =>
  Effect.gen(function* () {
    const github = yield* GitHubClient

    const run = yield* github.getWorkflowRun({ repo: resolvedRepo, runId })
    const { jobs } = yield* github.listWorkflowJobs({ repo: resolvedRepo, runId })

    const runInfo = toRunInfo(run)
    const jobVMs = jobs.map((j) => toJobVM({ job: j, runHtmlUrl: run.html_url, includeSteps }))

    const failedJobs = jobs.filter((j) => isBlockingConclusion(j.conclusion))
    /**
     * Target resolution already knows which PR is under review; a run's own
     * `pull_requests` is empty for anything but a `pull_request` event, which is
     * how PR health used to vanish exactly when resolution had gone wrong.
     */
    const healthPrNumber = prNumber ?? run.pull_requests[0]?.number ?? null

    const { movedIds: moved, changedCount: changed } = diffJobs({
      previous: cache.fingerprints,
      current: jobs,
    })

    const fetchJobErrors = Effect.gen(function* () {
      /** Rendered this tick, including the placeholder a failed fetch leaves. */
      const rendered = new Map<number, JobError>()
      /** Carried to the next tick — completed fetches only, so failures retry. */
      const resolved = new Map<number, JobError | null>()

      /**
       * Job logs take a few seconds to become available after a job ends, so
       * a failed fetch is not cached and its retry cannot wait for another
       * transition — that is the difference between reporting the real error
       * lines and reporting "logs not available" for the rest of the watch.
       */
      const refreshIds = new Set(
        failedJobs.filter((j) => moved.has(j.id) || !cache.errorsByJob.has(j.id)).map((j) => j.id),
      )

      for (const job of failedJobs) {
        const cached = cache.errorsByJob.get(job.id)
        if (refreshIds.has(job.id) || cached === undefined) continue
        resolved.set(job.id, cached)
        if (cached !== null) rendered.set(job.id, cached)
      }

      yield* Effect.forEach(
        failedJobs.filter((job) => refreshIds.has(job.id)),
        (job) =>
          Effect.gen(function* () {
            const logResult = yield* Effect.result(
              github.getJobLogs({ repo: resolvedRepo, jobId: job.id }),
            )
            if (logResult._tag === 'Failure') {
              /**
               * Why the logs are missing is the only diagnosis left for this
               * job — and it is not cached, so the next tick retries.
               */
              rendered.set(job.id, {
                jobName: job.name,
                stepName: 'logs',
                errors: [
                  logResult.failure._tag === 'LogsUnavailableError'
                    ? `Logs not available: ${logResult.failure.message}`
                    : `Failed to fetch logs: ${logResult.failure.message}`,
                ],
              })
              return
            }

            const errors = extractErrorLines(logResult.success)
            if (errors.length === 0) {
              resolved.set(job.id, null)
              return
            }

            const failedStep = job.steps.find((s) => s.conclusion === 'failure')
            const error: JobError = {
              jobName: job.name,
              stepName: failedStep ? `step "${failedStep.name}"` : 'logs',
              errors,
            }
            rendered.set(job.id, error)
            resolved.set(job.id, error)
          }),
        { concurrency: API_CONCURRENCY },
      )

      return { rendered, resolved }
    })

    /**
     * Annotations are fetched for every job every tick, not just the ones that
     * moved: GitHub attaches check-run annotations asynchronously, so they
     * routinely land after a job's last state change. `If-None-Match` turns an
     * unchanged set into an unbilled `304`, so the change gate would buy
     * nothing here — while costing `status -w` annotations `status` reports.
     */
    const fetchAnnotations = Effect.gen(function* () {
      const annotationsByJob = new Map<number, ReadonlyArray<AnnotationInfo>>()

      yield* Effect.forEach(
        jobs,
        (job) =>
          Effect.gen(function* () {
            const result = yield* Effect.result(
              github.getCheckAnnotations({ repo: resolvedRepo, checkRunId: job.id }),
            )
            if (result._tag === 'Failure') {
              /** A transient failure must never blank a job: keep the last set. */
              const cached = cache.annotationsByJob.get(job.id)
              if (cached !== undefined) annotationsByJob.set(job.id, cached)
              return
            }

            annotationsByJob.set(
              job.id,
              result.success.map((a) => ({
                jobName: job.name,
                path: a.path,
                line: a.start_line,
                message: a.message,
                title: a.title ?? null,
              })),
            )
          }),
        { concurrency: API_CONCURRENCY },
      )

      return annotationsByJob
    })

    /**
     * PR health is decorative and bills the GraphQL bucket, so it always fails
     * fast: parking on a spent GraphQL budget would hold the whole tick — and
     * the job data the watch actually needs — hostage for a nullable field.
     */
    const fetchPrHealth =
      healthPrNumber !== null && run.head_branch !== null
        ? github
            .getPrHealth({ repo: resolvedRepo, prNumber: healthPrNumber, headRef: run.head_branch })
            .pipe(
              Effect.provideService(RateLimitWaitPolicy, null),
              Effect.orElseSucceed(() => null as PrHealth | null),
            )
        : Effect.succeed(null as PrHealth | null)

    const [jobErrors, annotationsByJob, activeJobs, prHealth] = yield* Effect.all(
      [fetchJobErrors, fetchAnnotations, fetchAllRunnerJobs(runnerHosts), fetchPrHealth],
      { concurrency: 'unbounded' },
    )

    const runnerHostMap: RunnerHostMap = activeJobs.map((j) => [j.runner, j.host] as const)

    /** Job order drives the rendered order, so rebuild both lists from `jobs`. */
    const renderedErrors = jobs.flatMap((job) => {
      const err = jobErrors.rendered.get(job.id)
      return err === undefined ? [] : [err]
    })
    const annotations = jobs.flatMap((job) => annotationsByJob.get(job.id) ?? [])

    return {
      run: runInfo,
      jobs: jobVMs,
      errors: renderedErrors,
      annotations,
      runnerHostMap,
      prHealth,
      completed: run.status === 'completed',
      hasFailed: failedJobs.length > 0,
      pending: jobs.filter((j) => j.status !== 'completed').length,
      /** Job movement, not fetch work: a cold tick observes everything but moved nothing. */
      changed,
      nextCache: {
        fingerprints: new Map(
          jobs.map(
            (j) => [j.id, { id: j.id, status: j.status, conclusion: j.conclusion }] as const,
          ),
        ),
        annotationsByJob,
        errorsByJob: jobErrors.resolved,
      } satisfies TickCache,
    }
  })

const includeStepsOption = Cli.Flag.boolean('include-steps').pipe(
  Cli.Flag.withDefault(false),
  Cli.Flag.withDescription('Include full step arrays in job output'),
)

/** CLI subcommand to show the status of a CI run */
export const statusCommand = Cli.Command.make('status', {
  output: outputOption,
  target: targetArg,
  workflow: workflowOption,
  watch: watchOption,
  watchMode: watchModeOption,
  timeout: timeoutOption,
  includeSteps: includeStepsOption,
}).pipe(
  Cli.Command.withHandler(
    ({
      output,
      target: targetInput,
      workflow: workflowOpt,
      watch,
      watchMode,
      timeout,
      includeSteps,
    }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const tui = yield* CiApp.run(React.createElement(CiView, { stateAtom: CiApp.stateAtom }))

          const config = yield* resolveConfig({})

          const preferWorkflow = Option.isSome(workflowOpt) ? workflowOpt.value : undefined
          const localRepo = config.repos[0]

          let resolved: ResolvedTarget
          if (Option.isSome(targetInput)) {
            resolved = yield* resolveTarget(
              targetInput.value as string,
              Option.fromNullishOr(localRepo),
              preferWorkflow,
            )
          } else {
            if (!localRepo) {
              tui.dispatch({
                _tag: 'SetError',
                error: 'No repos configured',
                message:
                  'Could not detect repo from git remote. Use owner/repo as target to specify.',
              })
              return
            }
            resolved = yield* resolveTargetOrCurrentBranch(targetInput, localRepo, preferWorkflow)
          }

          const { runId, repo: resolvedRepo, selection } = resolved

          const dispatchMeta = () =>
            Effect.gen(function* () {
              const meta = yield* collectApiMeta
              tui.dispatch({ _tag: 'SetMeta', _meta: meta })
            })

          const dispatchRun = (cache: TickCache) =>
            Effect.gen(function* () {
              const data = yield* fetchSingleRunData({
                resolvedRepo,
                runId,
                runnerHosts: config.runnerHosts,
                includeSteps,
                cache,
                prNumber: selection.prNumber,
              })
              const summary = computeSummary({
                run: data.run,
                jobs: data.jobs,
                prHealth: data.prHealth,
                selection,
              })
              tui.dispatch({
                _tag: 'SetLoaded',
                run: data.run,
                jobs: data.jobs,
                errors: data.errors,
                annotations: data.annotations,
                runnerHostMap: data.runnerHostMap,
                prHealth: data.prHealth,
                summary,
              })
              return data
            })

          if (!watch) {
            yield* dispatchRun(emptyTickCache)
            yield* dispatchMeta()
            return
          }

          const github = yield* GitHubClient
          const failFast = watchMode === 'first-failure'
          const startTime = Date.now()
          const baseSeconds = Duration.toSeconds(POLL_INTERVAL)
          const maxSeconds = Duration.toSeconds(MAX_POLL_INTERVAL)

          /** Report the deadline the caller set — a watch must never stop silently. */
          const abortOnTimeout = Effect.gen(function* () {
            const elapsed = Math.round((Date.now() - startTime) / 1000)
            tui.dispatch({
              _tag: 'SetError',
              error: 'Timeout',
              message: `Watch timed out after ${elapsed}s. Run is still in progress.`,
            })
            yield* dispatchMeta()
          })

          let cache = emptyTickCache
          let idleTicks = 0
          let tick = 0
          let billedSoFar = 0

          while (true) {
            tick++

            /**
             * A watch is the one caller that may park on a spent budget: it
             * owns a deadline, so the park is bounded by what is left of it
             * and the tick can never silently outlive `--timeout`.
             */
            const tickBudgetSeconds = timeout - (Date.now() - startTime) / 1000
            if (tickBudgetSeconds <= 0) return yield* abortOnTimeout

            const tickResult = yield* dispatchRun(cache).pipe(
              Effect.provideService(RateLimitWaitPolicy, tickBudgetSeconds),
              Effect.timeoutOption(Duration.seconds(tickBudgetSeconds)),
            )
            if (Option.isNone(tickResult)) return yield* abortOnTimeout

            const data = tickResult.value
            cache = data.nextCache

            if (data.completed || (failFast && data.hasFailed)) {
              yield* dispatchMeta()
              return
            }

            const elapsed = (Date.now() - startTime) / 1000
            if (elapsed >= timeout) return yield* abortOnTimeout

            /**
             * Idleness needs a previous tick to compare against, so the cold
             * tick — which by definition moved nothing — is not idle, and the
             * second poll still happens at the base interval.
             */
            idleTicks = data.changed === 0 && tick > 1 ? idleTicks + 1 : 0

            /**
             * Pace on what the last tick actually billed to the REST bucket:
             * GraphQL has its own budget and must not stretch this interval.
             */
            const meta = yield* collectApiMeta
            const restRequests = yield* github.getRestRequestCount
            const billed = restRequests - meta.apiRequestsCached
            const costPerTick = Math.max(1, billed - billedSoFar)
            billedSoFar = billed

            const rateLimit = yield* github.getRateLimit
            /** The budget only has to survive the rest of this watch, or the reset. */
            const deadlineSeconds = Math.max(1, timeout - elapsed)
            const paced = nextPollSeconds({
              baseSeconds,
              maxSeconds,
              idleTicks,
              costPerTick,
              remaining: Option.isSome(rateLimit) ? rateLimit.value.remaining : undefined,
              horizonSeconds: Option.isSome(rateLimit)
                ? Math.min(
                    deadlineSeconds,
                    Math.max(0, (rateLimit.value.reset.getTime() - Date.now()) / 1000),
                  )
                : undefined,
              reserveFraction: BUDGET_RESERVE_FRACTION,
            })
            /** Never sleep past the deadline the caller asked for. */
            const sleepSeconds = Math.min(paced, deadlineSeconds)

            tui.dispatch({
              _tag: 'Tick',
              tick,
              elapsedSeconds: Math.round(elapsed),
              pending: data.pending,
              completed: data.jobs.length - data.pending,
              changed: data.changed,
              nextPollSeconds: Math.round(sleepSeconds),
              _meta: meta,
            })

            yield* Effect.sleep(Duration.seconds(sleepSeconds))
          }
        }),
      ).pipe(
        Effect.provide(
          outputModeLayer(
            watch && output === 'auto' && isAgentEnv() ? ('ndjson' as OutputModeValue) : output,
          ),
        ),
      ),
  ),
  Cli.Command.withDescription(
    `Show CI status, jobs, errors, and annotations

Examples:
  gh-ci-utils status                          Current branch
  gh-ci-utils status owner/repo              Cross-repo (default branch)
  gh-ci-utils status owner/repo#506          Cross-repo PR
  gh-ci-utils status owner/repo@main         Cross-repo branch
  gh-ci-utils status '#506'                  Local PR
  gh-ci-utils status @feat/my-branch         Local branch with slashes
  gh-ci-utils status -w                      Watch (exit on first failure)
  gh-ci-utils status -w --watch-mode until-done  Watch until all jobs finish
  gh-ci-utils status 23601797547             Specific run ID`,
  ),
)
