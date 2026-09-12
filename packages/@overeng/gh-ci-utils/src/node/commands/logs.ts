import { Effect, Option } from 'effect'
/**
 * gh-ci-utils logs [target] [--job <name>] [--step <name>] [--failed] [--tail <n>]
 *
 * Fetch logs for completed jobs. Supports per-step logs when session is available.
 * Accepts run ID, URL, or branch name. Auto-detects current branch when omitted.
 */
import * as Cli from 'effect/unstable/cli'
import React from 'react'

import { outputModeLayer, outputOption } from '@overeng/tui-react/node'

import type { WorkflowJob } from '../../isomorphic/GitHubSchemas.ts'
import { DEFAULT_LOG_TAIL, LOG_POLL_INTERVAL } from '../../isomorphic/lib/constants.ts'
import { splitOwnerRepo } from '../../isomorphic/lib/format.ts'
import { selectLogLines, shouldIncludeFailedLog } from '../../isomorphic/lib/logFilter.ts'
import { isUnsuccessfulConclusion } from '../../isomorphic/lib/summary.ts'
import { LogsApp, LogsView, type LogsAction } from '../../isomorphic/renderers/LogsOutput/mod.ts'
import { resolveConfig } from '../Config.ts'
import { GitHubClient, type GitHubClientShape } from '../GitHubClient.ts'
import { GitHubInternal } from '../GitHubInternal.ts'
import { collectApiMeta } from '../lib/apiMeta.ts'
import {
  resolveTarget,
  resolveTargetOrCurrentBranch,
  targetArg,
  watchModeOption,
  watchOption,
  timeoutOption,
  workflowOption,
} from '../RunId.ts'

interface LogFilterOptions {
  readonly tail: number
  readonly offset: number
  readonly errorOnly: boolean
  readonly grep: Option.Option<string>
  readonly full: boolean
}

/** Collected log output for a single workflow job */
export interface CollectedJobLog {
  readonly jobName: string
  readonly conclusion: string
  /** Verbatim log text; a filter fallback is reported in `notice`, not inlined here. */
  readonly lines: string[]
  readonly notice: string | null
  readonly truncation: { totalLines: number; offset: number; pageSize: number } | null
}

/** A watch must retain an unsuccessful verdict while rendering a live step. */
export const liveStepWatchConclusion = ({
  stepStatus,
  hasUnsuccessfulConclusion,
}: {
  stepStatus: string
  hasUnsuccessfulConclusion: boolean
}): string => (hasUnsuccessfulConclusion ? 'failure' : stepStatus)

/** Derive the logs command's process verdict from the run and every job, as status does. */
export const logsVerdictConclusion = ({
  runConclusion,
  jobConclusions,
}: {
  runConclusion: string | null
  jobConclusions: readonly (string | null)[]
}): 'success' | 'failure' =>
  isUnsuccessfulConclusion(runConclusion) ||
  jobConclusions.some((conclusion) => isUnsuccessfulConclusion(conclusion))
    ? 'failure'
    : 'success'

/** Decide whether watch finalization needs a no-logs state without replacing rendered live output. */
export const shouldFinalizeWatchWithNoLogs = ({
  watch,
  displayedJobCount,
  renderedLiveStepOutput,
}: {
  watch: boolean
  displayedJobCount: number
  renderedLiveStepOutput: boolean
}): boolean => watch && displayedJobCount === 0 && !renderedLiveStepOutput

/** Structured nonzero result when `--step` cannot access GitHub's internal log API. */
export const missingStepSessionAuthError = {
  _tag: 'SetError',
  error: 'Session auth required',
  message: `Step filtering requires session auth (run 'gh-ci-utils auth login')`,
} as const satisfies LogsAction

/** Apply the shared grep/error selection and tail pagination policy to log text. */
export const collectLogText = ({
  logText,
  jobName,
  conclusion,
  filters,
}: {
  logText: string
  jobName: string
  conclusion: string
  filters: LogFilterOptions
}): CollectedJobLog => {
  const { lines, notice } = selectLogLines({
    logText,
    errorOnly: filters.errorOnly,
    grep: Option.getOrUndefined(filters.grep),
  })

  const totalLines = lines.length
  if (filters.full) {
    return { jobName, conclusion, lines, notice, truncation: null }
  }

  const effectiveOffset = Math.min(totalLines, Math.max(0, filters.offset))
  const end = Math.max(0, totalLines - effectiveOffset)
  const start = Math.max(0, end - filters.tail)
  const hasHiddenLines = start > 0 || effectiveOffset > 0
  return {
    jobName,
    conclusion,
    lines: lines.slice(start, end),
    notice,
    truncation: hasHiddenLines
      ? { totalLines, offset: effectiveOffset, pageSize: filters.tail }
      : null,
  }
}

const collectJobLog = ({
  github,
  repo,
  job,
  filters,
}: {
  github: GitHubClientShape
  repo: string
  job: WorkflowJob
  filters: LogFilterOptions
}): Effect.Effect<CollectedJobLog, never, never> =>
  Effect.gen(function* () {
    if (job.status !== 'completed') {
      return {
        jobName: job.name,
        conclusion: job.status,
        lines: ['Logs not yet available.'],
        notice: null,
        truncation: null,
      }
    }

    const logResult = yield* Effect.result(github.getJobLogs({ repo, jobId: job.id }))
    if (logResult._tag === 'Failure') {
      return {
        jobName: job.name,
        conclusion: job.conclusion ?? job.status,
        lines: [
          logResult.failure._tag === 'LogsUnavailableError'
            ? `Logs not available: ${logResult.failure.message}`
            : `Failed to fetch logs: ${logResult.failure.message}`,
        ],
        notice: null,
        truncation: null,
      }
    }

    return collectLogText({
      logText: logResult.success,
      jobName: job.name,
      conclusion: job.conclusion ?? job.status,
      filters,
    })
  })

/** CLI subcommand to fetch and display workflow run logs */
export const logsCommand = Cli.Command.make('logs', {
  output: outputOption,
  target: targetArg,
  workflow: workflowOption,
  job: Cli.Flag.string('job').pipe(
    Cli.Flag.optional,
    Cli.Flag.withDescription('Job name (substring) or numeric job ID'),
  ),
  step: Cli.Flag.string('step').pipe(
    Cli.Flag.optional,
    Cli.Flag.withDescription('Step name (requires session auth)'),
  ),
  failed: Cli.Flag.boolean('failed').pipe(
    Cli.Flag.withDefault(false),
    Cli.Flag.withDescription('Only show failed job logs'),
  ),
  tail: Cli.Flag.integer('tail').pipe(
    Cli.Flag.withDefault(DEFAULT_LOG_TAIL),
    Cli.Flag.withDescription(`Show last N lines (default ${DEFAULT_LOG_TAIL})`),
  ),
  offset: Cli.Flag.integer('offset').pipe(
    Cli.Flag.withDefault(0),
    Cli.Flag.withDescription('Skip N lines from the end for pagination'),
  ),
  error: Cli.Flag.boolean('error').pipe(
    Cli.Flag.withDefault(false),
    Cli.Flag.withDescription('Show only extracted error lines'),
  ),
  grep: Cli.Flag.string('grep').pipe(
    Cli.Flag.optional,
    Cli.Flag.withDescription('Filter log lines by pattern'),
  ),
  full: Cli.Flag.boolean('full').pipe(
    Cli.Flag.withDefault(false),
    Cli.Flag.withDescription('Show full log (no truncation)'),
  ),
  watch: watchOption,
  watchMode: watchModeOption,
  timeout: timeoutOption,
}).pipe(
  Cli.Command.withHandler(
    ({
      output,
      target: targetInput,
      workflow: workflowOpt,
      job: jobFilter,
      step: stepFilter,
      failed,
      tail,
      offset,
      error: errorOnly,
      grep,
      full,
      watch,
      watchMode,
      timeout,
    }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const tui = yield* LogsApp.run(
            React.createElement(LogsView, { stateAtom: LogsApp.stateAtom }),
          )

          const config = yield* resolveConfig({})

          const preferWorkflow = Option.isSome(workflowOpt) ? workflowOpt.value : undefined
          const localRepo = config.repos[0]

          let resolved: { runId: number; repo: string }
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
                error: 'No repo configured',
                message: 'Could not detect repo from git remote. Use owner/repo as target.',
              })
              return
            }
            resolved = yield* resolveTargetOrCurrentBranch(targetInput, localRepo, preferWorkflow)
          }

          const { runId, repo: resolvedRepo } = resolved
          const { owner, repo: repoName } = splitOwnerRepo(resolvedRepo)

          const github = yield* GitHubClient
          const logFilters: LogFilterOptions = { tail, offset, errorOnly, grep, full }

          const failFast = watchMode === 'first-failure'
          /** Tracks which completed jobs we already displayed logs for in watch mode. */
          const displayedJobIds = new Set<number>()
          /** Live backscroll is rendered repeatedly and therefore is not a completed displayed job. */
          let renderedLiveStepOutput = false
          /** A required capability failure must survive watch/no-logs finalization. */
          let terminalError = false

          const fetchAndDisplayLogs = () =>
            Effect.gen(function* () {
              const run = yield* github.getWorkflowRun({ repo: resolvedRepo, runId })
              const { jobs } = yield* github.listWorkflowJobs({ repo: resolvedRepo, runId })
              const completed = run.status === 'completed'
              const verdictConclusion = logsVerdictConclusion({
                runConclusion: run.conclusion,
                jobConclusions: jobs.map((job) => job.conclusion),
              })
              const hasUnsuccessfulConclusion = verdictConclusion === 'failure'

              let filteredJobs: WorkflowJob[] = jobs
              if (failed) {
                filteredJobs = filteredJobs.filter((job) => shouldIncludeFailedLog(job.conclusion))
              }
              if (Option.isSome(jobFilter)) {
                const filter = jobFilter.value
                const asNumber = Number(filter)
                if (Number.isFinite(asNumber) && asNumber > 0) {
                  filteredJobs = filteredJobs.filter((j) => j.id === asNumber)
                } else {
                  const pattern = filter.toLowerCase()
                  filteredJobs = filteredJobs.filter((j) => j.name.toLowerCase().includes(pattern))
                }
              }

              /** Try per-step logs via internal API if session available and step filter given */
              if (Option.isSome(stepFilter)) {
                const internal = yield* GitHubInternal
                const sessionResult = yield* internal.getSession

                if (Option.isNone(sessionResult)) {
                  terminalError = true
                  tui.dispatch(missingStepSessionAuthError)
                  return { completed, hasUnsuccessfulConclusion, verdictConclusion }
                }

                if (Option.isSome(sessionResult)) {
                  const session = sessionResult.value
                  let anyStepMatched = false
                  for (const j of filteredJobs) {
                    if (displayedJobIds.has(j.id)) continue

                    const internalId = yield* Effect.result(
                      internal.resolveInternalJobId({
                        owner,
                        repo: repoName,
                        runId,
                        restJobId: j.id,
                        session,
                      }),
                    )

                    if (internalId._tag === 'Failure') continue

                    const steps = yield* internal.getSteps({
                      owner,
                      repo: repoName,
                      runId,
                      internalJobId: internalId.success,
                      session,
                      changeId: 0,
                    })

                    const matchingStep = steps.find((s) =>
                      s.name.toLowerCase().includes(stepFilter.value.toLowerCase()),
                    )

                    if (!matchingStep) continue

                    anyStepMatched = true
                    if (matchingStep.status !== 'completed') {
                      const backscroll = yield* internal.getBackscroll({
                        owner,
                        repo: repoName,
                        runId,
                        internalJobId: internalId.success,
                        stepUuid: matchingStep.id,
                        session,
                      })
                      const result = collectLogText({
                        logText: backscroll.lines.map((line) => line.line).join('\n'),
                        jobName: `${j.name} > ${matchingStep.name}`,
                        conclusion: liveStepWatchConclusion({
                          stepStatus: matchingStep.status,
                          hasUnsuccessfulConclusion,
                        }),
                        filters: logFilters,
                      })
                      tui.dispatch({ _tag: 'SetLogs', ...result })
                      renderedLiveStepOutput = true
                    } else {
                      const logText = yield* internal.getCompletedStepLog({
                        owner,
                        repo: repoName,
                        headSha: run.head_sha,
                        restJobId: j.id,
                        stepNumber: matchingStep.number,
                        session,
                      })
                      const result = collectLogText({
                        logText,
                        jobName: `${j.name} > ${matchingStep.name}`,
                        conclusion: hasUnsuccessfulConclusion
                          ? 'failure'
                          : (matchingStep.conclusion ?? matchingStep.status),
                        filters: logFilters,
                      })
                      tui.dispatch({ _tag: 'SetLogs', ...result })
                      displayedJobIds.add(j.id)
                    }
                  }
                  if (!anyStepMatched && !watch) {
                    tui.dispatch({
                      _tag: 'SetNoLogs',
                      message: `No step matching '${stepFilter.value}' in any job`,
                      conclusion: verdictConclusion,
                    })
                  }
                  return { completed, hasUnsuccessfulConclusion, verdictConclusion }
                }
              }

              if (filteredJobs.length === 0 && !watch) {
                tui.dispatch({
                  _tag: 'SetNoLogs',
                  message: failed
                    ? 'No failed jobs found.'
                    : `No jobs matching filter in run ${runId}.`,
                  conclusion: verdictConclusion,
                })
                return { completed, hasUnsuccessfulConclusion, verdictConclusion }
              }

              /** Tier 1: REST API full job logs */
              /** Only collect logs for completed jobs (in-progress have no logs yet) */
              const completedJobs = filteredJobs.filter((j) => j.status === 'completed')

              /** In watch mode, only show newly completed jobs */
              const newJobs = watch
                ? completedJobs.filter((j) => !displayedJobIds.has(j.id))
                : completedJobs

              if (newJobs.length === 0 && !watch) {
                tui.dispatch({
                  _tag: 'SetNoLogs',
                  message: 'No completed jobs with logs yet.',
                  conclusion: verdictConclusion,
                })
                return { completed, hasUnsuccessfulConclusion, verdictConclusion }
              }

              /** Collect all job logs, then dispatch once to avoid per-job state overwrites */
              const allLines: string[] = []
              /** Distinct per-job notices; identical fallbacks collapse into one line. */
              const notices = new Set<string>()
              for (const j of newJobs) {
                const r = yield* collectJobLog({
                  github,
                  repo: resolvedRepo,
                  job: j,
                  filters: logFilters,
                })
                allLines.push(`── ${r.jobName} (${r.conclusion}) ──`, ...r.lines, '')
                if (r.notice !== null) notices.add(r.notice)
                displayedJobIds.add(j.id)
              }

              if (allLines.length > 0) {
                tui.dispatch({
                  _tag: 'SetLogs',
                  jobName: newJobs.length === 1 ? newJobs[0]!.name : `${newJobs.length} jobs`,
                  conclusion: verdictConclusion,
                  lines: allLines,
                  notice: notices.size === 0 ? null : [...notices].join(' · '),
                  truncation: null,
                })
              }

              return { completed, hasUnsuccessfulConclusion, verdictConclusion }
            })

          let finalResult = yield* fetchAndDisplayLogs()

          if (
            watch &&
            !terminalError &&
            !finalResult.completed &&
            !(failFast && finalResult.hasUnsuccessfulConclusion)
          ) {
            const startTime = Date.now()
            while (true) {
              yield* Effect.sleep(LOG_POLL_INTERVAL)
              finalResult = yield* fetchAndDisplayLogs()
              if (
                terminalError ||
                finalResult.completed ||
                (failFast && finalResult.hasUnsuccessfulConclusion)
              )
                break
              const elapsed = (Date.now() - startTime) / 1000
              if (elapsed >= timeout) {
                tui.dispatch({
                  _tag: 'SetError',
                  error: 'Timeout',
                  message: `Watch timed out after ${Math.round(elapsed)}s. Run is still in progress.`,
                })
                return
              }
            }
          }

          /** If watch completed but no logs were ever rendered, emit a final state. */
          if (
            !terminalError &&
            shouldFinalizeWatchWithNoLogs({
              watch,
              displayedJobCount: displayedJobIds.size,
              renderedLiveStepOutput,
            })
          ) {
            tui.dispatch({
              _tag: 'SetNoLogs',
              message: failed ? 'No failed job logs found.' : 'No matching jobs produced logs.',
              conclusion: finalResult.verdictConclusion,
            })
          }

          const meta = yield* collectApiMeta
          tui.dispatch({ _tag: 'SetMeta', _meta: meta })
        }),
      ).pipe(Effect.provide(outputModeLayer(output))),
  ),
  Cli.Command.withDescription(
    `Show job logs (last ${DEFAULT_LOG_TAIL} lines by default)

Examples:
  gh-ci-utils logs                            Last ${DEFAULT_LOG_TAIL} lines
  gh-ci-utils logs --job lint                 Specific job by name
  gh-ci-utils logs --job 80000000001          Specific job by ID
  gh-ci-utils logs --tail 200                 Last 200 lines
  gh-ci-utils logs --offset 100              Skip last 100 lines (paginate)
  gh-ci-utils logs --error                    Only extracted error lines
  gh-ci-utils logs --grep "got:"             Grep log lines
  gh-ci-utils logs --full                     Full log output
  gh-ci-utils logs owner/repo                 Cross-repo logs
  gh-ci-utils logs -w                         Watch (exit on first failure)
  gh-ci-utils logs -w --watch-mode until-done  Watch until all jobs finish`,
  ),
)
