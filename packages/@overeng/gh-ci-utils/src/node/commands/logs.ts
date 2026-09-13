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
import { isUnsuccessfulConclusion, isWrongWorkflowSelection } from '../../isomorphic/lib/summary.ts'
import { LogsApp, LogsView, type LogsAction } from '../../isomorphic/renderers/LogsOutput/mod.ts'
import { resolveConfig } from '../Config.ts'
import { GitHubClient, type GitHubClientShape, isAzureBlobError } from '../GitHubClient.ts'
import { GitHubInternal } from '../GitHubInternal.ts'
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

/** Whether a log lookup succeeded, is definitively absent, may become available, or must stop. */
export type LogAvailability = 'retrieved' | 'absent' | 'retryable' | 'terminal'

/** A collected job log plus whether a watch may retry its retrieval. */
export type CollectedJobLogResult = CollectedJobLog & {
  readonly availability: LogAvailability
}

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

/** A completed job that never ran has no log publication to wait for. */
export const isLoglessTerminalJob = (job: WorkflowJob): boolean =>
  job.status === 'completed' && (job.conclusion === 'skipped' || job.started_at === null)

/** A terminal run is complete once every selected job has a terminal log lookup result. */
export const isLogsWatchComplete = ({
  runCompleted,
  jobs,
  finalizedJobIds,
}: {
  runCompleted: boolean
  jobs: readonly WorkflowJob[]
  finalizedJobIds: ReadonlySet<number>
}): boolean =>
  runCompleted &&
  jobs.every(
    (job) =>
      job.status === 'completed' && (isLoglessTerminalJob(job) || finalizedJobIds.has(job.id)),
  )

/** Keep a selected-step watch alive until every candidate job reaches a terminal lookup result. */
export const shouldRetryStepLogLookup = ({
  watch,
  candidateJobIds,
  finalizedJobIds,
}: {
  watch: boolean
  candidateJobIds: readonly number[]
  finalizedJobIds: ReadonlySet<number>
}): boolean => watch && candidateJobIds.some((jobId) => !finalizedJobIds.has(jobId))

interface StepLookupFailure {
  readonly _tag: string
  readonly message: string
  readonly cause?: unknown
}

/**
 * Only explicit publication-lag responses are retryable. Authentication,
 * transport, parsing, and other API failures are terminal.
 */
export const classifyStepLookupFailure = ({
  operation,
  failure,
}: {
  operation: 'resolve-job' | 'completed-log'
  failure: StepLookupFailure
}): 'retryable' | 'terminal' => {
  if (failure._tag === 'LogsUnavailableError') return 'retryable'
  if (failure._tag !== 'GitHubApiError') return 'terminal'
  if (failure.cause === 'HTTP 404' || /(?:returned|response)\s+404\b/.test(failure.message))
    return 'retryable'
  if (
    operation === 'resolve-job' &&
    failure.message.startsWith('Could not extract internal job ID from HTML')
  )
    return 'retryable'
  return 'terminal'
}

/** Empty and Azure error payloads are successful HTTP responses whose logs are not published yet. */
export const classifyCompletedStepLogText = (logText: string): LogAvailability =>
  logText.trim() === '' || isAzureBlobError(logText) ? 'retryable' : 'retrieved'

/** Preserve the actual internal API failure in structured/TUI output. */
export const terminalStepLogErrorAction = (failure: StepLookupFailure): LogsAction => ({
  _tag: 'SetError',
  error: failure._tag,
  message: failure.message,
})

/** Return a terminal, nonzero result when one-shot selected-step logs are not published yet. */
export const selectedStepLogsUnavailableAction = (jobNames: readonly string[]): LogsAction => ({
  _tag: 'SetError',
  error: 'Logs unavailable',
  message:
    jobNames.length === 1
      ? `Selected step logs are not available yet for job '${jobNames[0]}'.`
      : `Selected step logs are not available yet for jobs: ${jobNames.join(', ')}.`,
})

/** Structured nonzero result when `--step` cannot access GitHub's internal log API. */
export const missingStepSessionAuthError = {
  _tag: 'SetError',
  error: 'Session auth required',
  message: `Step filtering requires session auth (run 'gh-ci-utils auth login')`,
} as const satisfies LogsAction

/** Reject an explicit workflow miss without exposing logs from the resolver's fallback run. */
export const unmatchedWorkflowLogAction = (resolved: ResolvedTarget): LogsAction | null => {
  if (!isWrongWorkflowSelection(resolved.selection)) return null
  return {
    _tag: 'SetNoLogs',
    message: `No run matching workflow '${resolved.selection.expectedWorkflow}' was found in ${resolved.repo}; logs from fallback run ${resolved.runId} were not shown.`,
    conclusion: 'no_checks',
  }
}

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

/** Collect one job log while distinguishing publication lag from terminal failures. */
export const collectJobLog = ({
  github,
  repo,
  job,
  filters,
}: {
  github: Pick<GitHubClientShape, 'getJobLogs'>
  repo: string
  job: WorkflowJob
  filters: LogFilterOptions
}): Effect.Effect<CollectedJobLogResult, never, never> =>
  Effect.gen(function* () {
    if (isLoglessTerminalJob(job)) {
      return {
        jobName: job.name,
        conclusion: job.conclusion ?? job.status,
        lines: [],
        notice: null,
        truncation: null,
        availability: 'absent',
      }
    }

    if (job.status !== 'completed' || job.completed_at === null) {
      return {
        jobName: job.name,
        conclusion: job.status,
        lines: ['Logs not yet available.'],
        notice: null,
        truncation: null,
        availability: 'retryable',
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
        availability: logResult.failure._tag === 'LogsUnavailableError' ? 'retryable' : 'terminal',
      }
    }

    return {
      ...collectLogText({
        logText: logResult.success,
        jobName: job.name,
        conclusion: job.conclusion ?? job.status,
        filters,
      }),
      availability: 'retrieved',
    }
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
                error: 'No repo configured',
                message: 'Could not detect repo from git remote. Use owner/repo as target.',
              })
              return
            }
            resolved = yield* resolveTargetOrCurrentBranch(targetInput, localRepo, preferWorkflow)
          }

          const workflowMiss = unmatchedWorkflowLogAction(resolved)
          if (workflowMiss !== null) {
            tui.dispatch(workflowMiss)
            const meta = yield* collectApiMeta
            tui.dispatch({ _tag: 'SetMeta', _meta: meta })
            return
          }

          const { runId, repo: resolvedRepo } = resolved
          const { owner, repo: repoName } = splitOwnerRepo(resolvedRepo)

          const github = yield* GitHubClient
          const logFilters: LogFilterOptions = { tail, offset, errorOnly, grep, full }

          const failFast = watchMode === 'first-failure'
          /** Tracks which completed jobs we already displayed logs for in watch mode. */
          const displayedJobIds = new Set<number>()
          /** Jobs whose logs were retrieved or are known never to have run. */
          const finalizedJobIds = new Set<number>()
          /** Selected-step candidates that no longer need lookup on a later watch tick. */
          const finalizedStepJobIds = new Set<number>()
          /** Live backscroll is rendered repeatedly and therefore is not a completed displayed job. */
          let renderedLiveStepOutput = false
          /** A required capability failure must survive watch/no-logs finalization. */
          let terminalError = false

          const fetchAndDisplayLogs = () =>
            Effect.gen(function* () {
              const run = yield* github.getWorkflowRun({ repo: resolvedRepo, runId })
              const { jobs } = yield* github.listWorkflowJobs({ repo: resolvedRepo, runId })
              const runCompleted = run.status === 'completed'
              const verdictConclusion = logsVerdictConclusion({
                runConclusion: run.conclusion,
                jobConclusions: jobs.map((job) => job.conclusion),
              })
              const hasUnsuccessfulConclusion = verdictConclusion === 'failure'
              tui.dispatch({ _tag: 'SetVerdict', conclusion: verdictConclusion })

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
                  return {
                    completed: runCompleted,
                    hasUnsuccessfulConclusion,
                    retryableLogsPending: false,
                    verdictConclusion,
                  }
                }

                if (Option.isSome(sessionResult)) {
                  const session = sessionResult.value
                  const unavailableStepJobNames = new Set<string>()
                  let anyStepMatched = false
                  for (const j of filteredJobs) {
                    if (finalizedStepJobIds.has(j.id)) continue
                    if (isLoglessTerminalJob(j)) {
                      finalizedStepJobIds.add(j.id)
                      continue
                    }

                    const internalId = yield* Effect.result(
                      internal.resolveInternalJobId({
                        owner,
                        repo: repoName,
                        runId,
                        restJobId: j.id,
                        session,
                      }),
                    )

                    if (internalId._tag === 'Failure') {
                      if (
                        classifyStepLookupFailure({
                          operation: 'resolve-job',
                          failure: internalId.failure,
                        }) === 'retryable'
                      ) {
                        unavailableStepJobNames.add(j.name)
                        continue
                      }
                      terminalError = true
                      tui.dispatch(terminalStepLogErrorAction(internalId.failure))
                      break
                    }

                    const stepsResult = yield* Effect.result(
                      internal.getSteps({
                        owner,
                        repo: repoName,
                        runId,
                        internalJobId: internalId.success,
                        session,
                        changeId: 0,
                      }),
                    )
                    if (stepsResult._tag === 'Failure') {
                      if (
                        classifyStepLookupFailure({
                          operation: 'resolve-job',
                          failure: stepsResult.failure,
                        }) === 'retryable'
                      ) {
                        unavailableStepJobNames.add(j.name)
                        continue
                      }
                      terminalError = true
                      tui.dispatch(terminalStepLogErrorAction(stepsResult.failure))
                      break
                    }
                    const steps = stepsResult.success

                    const matchingStep = steps.find((s) =>
                      s.name.toLowerCase().includes(stepFilter.value.toLowerCase()),
                    )

                    if (!matchingStep) {
                      if (j.status === 'completed') finalizedStepJobIds.add(j.id)
                      else unavailableStepJobNames.add(j.name)
                      continue
                    }

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
                        conclusion: matchingStep.conclusion ?? matchingStep.status,
                        filters: logFilters,
                      })
                      tui.dispatch({
                        _tag: 'SetLogs',
                        sectionId: `${j.id}:${matchingStep.number}`,
                        jobName: result.jobName,
                        sectionConclusion: result.conclusion,
                        verdictConclusion,
                        lines: result.lines,
                        notice: result.notice,
                        truncation: result.truncation,
                      })
                      renderedLiveStepOutput = true
                    } else {
                      const logResult = yield* Effect.result(
                        internal.getCompletedStepLog({
                          owner,
                          repo: repoName,
                          headSha: run.head_sha,
                          restJobId: j.id,
                          stepNumber: matchingStep.number,
                          session,
                        }),
                      )
                      if (logResult._tag === 'Failure') {
                        if (
                          classifyStepLookupFailure({
                            operation: 'completed-log',
                            failure: logResult.failure,
                          }) === 'retryable'
                        ) {
                          unavailableStepJobNames.add(j.name)
                          continue
                        }
                        terminalError = true
                        tui.dispatch(terminalStepLogErrorAction(logResult.failure))
                        break
                      }
                      if (classifyCompletedStepLogText(logResult.success) === 'retryable') {
                        unavailableStepJobNames.add(j.name)
                        continue
                      }

                      const result = collectLogText({
                        logText: logResult.success,
                        jobName: `${j.name} > ${matchingStep.name}`,
                        conclusion: matchingStep.conclusion ?? matchingStep.status,
                        filters: logFilters,
                      })
                      tui.dispatch({
                        _tag: 'SetLogs',
                        sectionId: `${j.id}:${matchingStep.number}`,
                        jobName: result.jobName,
                        sectionConclusion: result.conclusion,
                        verdictConclusion,
                        lines: result.lines,
                        notice: result.notice,
                        truncation: result.truncation,
                      })
                      displayedJobIds.add(j.id)
                      finalizedStepJobIds.add(j.id)
                    }
                  }
                  if (terminalError) {
                    return {
                      completed: false,
                      hasUnsuccessfulConclusion,
                      retryableLogsPending: false,
                      verdictConclusion,
                    }
                  }
                  if (!watch && unavailableStepJobNames.size > 0) {
                    terminalError = true
                    tui.dispatch(
                      selectedStepLogsUnavailableAction([...unavailableStepJobNames].toSorted()),
                    )
                    return {
                      completed: false,
                      hasUnsuccessfulConclusion,
                      retryableLogsPending: false,
                      verdictConclusion,
                    }
                  }
                  if (!anyStepMatched && !watch) {
                    tui.dispatch({
                      _tag: 'SetNoLogs',
                      message: `No step matching '${stepFilter.value}' in any job`,
                      conclusion: verdictConclusion,
                    })
                  }
                  const retryableLogsPending = shouldRetryStepLogLookup({
                    watch,
                    candidateJobIds: filteredJobs.map((job) => job.id),
                    finalizedJobIds: finalizedStepJobIds,
                  })
                  return {
                    completed: runCompleted && !retryableLogsPending,
                    hasUnsuccessfulConclusion,
                    retryableLogsPending,
                    verdictConclusion,
                  }
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
                return {
                  completed: runCompleted,
                  hasUnsuccessfulConclusion,
                  retryableLogsPending: false,
                  verdictConclusion,
                }
              }

              /** Tier 1: REST API full job logs */
              /** Finalize completed jobs, retrieving logs only for jobs that ran. */
              const completedJobs = filteredJobs.filter((job) => job.status === 'completed')

              /** In watch mode, only show newly completed jobs */
              const newJobs = watch
                ? completedJobs.filter((j) => !finalizedJobIds.has(j.id))
                : completedJobs

              if (newJobs.length === 0 && !watch) {
                tui.dispatch({
                  _tag: 'SetNoLogs',
                  message: 'No completed jobs with logs yet.',
                  conclusion: verdictConclusion,
                })
                return {
                  completed: runCompleted,
                  hasUnsuccessfulConclusion,
                  retryableLogsPending: false,
                  verdictConclusion,
                }
              }

              let retrievedThisTick = false
              let retryableMessage: string | undefined
              for (const j of newJobs) {
                const r = yield* collectJobLog({
                  github,
                  repo: resolvedRepo,
                  job: j,
                  filters: logFilters,
                })
                if (r.availability === 'terminal') {
                  terminalError = true
                  tui.dispatch({
                    _tag: 'SetError',
                    error: 'Log retrieval failed',
                    message: r.lines.join('\n'),
                  })
                  break
                }
                if (r.availability === 'retryable') {
                  retryableMessage ??= r.lines.join('\n')
                  continue
                }
                if (r.availability === 'absent') {
                  finalizedJobIds.add(j.id)
                  continue
                }
                tui.dispatch({
                  _tag: 'SetLogs',
                  sectionId: String(j.id),
                  jobName: r.jobName,
                  sectionConclusion: r.conclusion,
                  verdictConclusion,
                  lines: r.lines,
                  notice: r.notice,
                  truncation: r.truncation,
                })
                displayedJobIds.add(j.id)
                finalizedJobIds.add(j.id)
                retrievedThisTick = true
              }

              if (terminalError) {
                return {
                  completed: false,
                  hasUnsuccessfulConclusion,
                  retryableLogsPending: false,
                  verdictConclusion,
                }
              }

              if (!watch && !retrievedThisTick) {
                tui.dispatch({
                  _tag: 'SetNoLogs',
                  message: retryableMessage ?? 'No completed jobs produced logs.',
                  conclusion: verdictConclusion,
                })
              }

              const retryableLogsPending = filteredJobs.some(
                (job) =>
                  !finalizedJobIds.has(job.id) && (runCompleted || job.status === 'completed'),
              )
              return {
                completed: watch
                  ? isLogsWatchComplete({
                      runCompleted,
                      jobs: filteredJobs,
                      finalizedJobIds,
                    })
                  : runCompleted,
                hasUnsuccessfulConclusion,
                retryableLogsPending,
                verdictConclusion,
              }
            })

          let finalResult = yield* fetchAndDisplayLogs()

          if (
            watch &&
            !terminalError &&
            !finalResult.completed &&
            !(
              failFast &&
              finalResult.hasUnsuccessfulConclusion &&
              !finalResult.retryableLogsPending
            )
          ) {
            const startTime = Date.now()
            while (true) {
              yield* Effect.sleep(LOG_POLL_INTERVAL)
              finalResult = yield* fetchAndDisplayLogs()
              if (
                terminalError ||
                finalResult.completed ||
                (failFast &&
                  finalResult.hasUnsuccessfulConclusion &&
                  !finalResult.retryableLogsPending)
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
