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
import { selectLogLines } from '../../isomorphic/lib/logFilter.ts'
import { LogsApp, LogsView } from '../../isomorphic/renderers/LogsOutput/mod.ts'
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

    const logText = logResult.success

    /** Apply filters: --error flag, --grep pattern, or raw lines */
    const { lines, notice } = selectLogLines({
      logText,
      errorOnly: filters.errorOnly,
      grep: Option.getOrUndefined(filters.grep),
    })

    /** Apply tail + offset pagination (skipped when --full) */
    const totalLines = lines.length
    if (!filters.full && totalLines > filters.tail + filters.offset) {
      const end = totalLines - filters.offset
      const start = Math.max(0, end - filters.tail)
      const paginated = lines.slice(start, end)
      return {
        jobName: job.name,
        conclusion: job.conclusion ?? job.status,
        lines: paginated,
        notice,
        truncation: { totalLines, offset: filters.offset, pageSize: filters.tail },
      }
    }

    /** No truncation needed (or --full) */
    const finalLines =
      filters.offset > 0 && !filters.full ? lines.slice(0, totalLines - filters.offset) : lines
    return {
      jobName: job.name,
      conclusion: job.conclusion ?? job.status,
      lines: finalLines,
      notice,
      truncation: null,
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

          /** Tracks which jobs we already displayed logs for (watch mode) */
          const displayedJobIds = new Set<number>()

          const fetchAndDisplayLogs = () =>
            Effect.gen(function* () {
              const run = yield* github.getWorkflowRun({ repo: resolvedRepo, runId })
              const { jobs } = yield* github.listWorkflowJobs({ repo: resolvedRepo, runId })
              const completed = run.status === 'completed'
              const hasFailed = jobs.some(
                (j) =>
                  j.conclusion !== null && j.conclusion !== 'success' && j.conclusion !== 'skipped',
              )

              let filteredJobs: WorkflowJob[] = jobs
              if (failed) {
                filteredJobs = filteredJobs.filter((j) => j.conclusion === 'failure')
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

              if (filteredJobs.length === 0 && !watch) {
                tui.dispatch({
                  _tag: 'SetNoLogs',
                  message: failed
                    ? 'No failed jobs found.'
                    : `No jobs matching filter in run ${runId}.`,
                })
                return { completed, hasFailed }
              }

              /** Try per-step logs via internal API if session available and step filter given */
              if (Option.isSome(stepFilter)) {
                const internal = yield* GitHubInternal
                const sessionResult = yield* internal.getSession

                if (Option.isNone(sessionResult)) {
                  tui.dispatch({
                    _tag: 'SetNoLogs',
                    message: `Step filtering requires session auth (run 'gh-ci-utils auth login')`,
                  })
                  return { completed, hasFailed }
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

                    if (internalId._tag === 'Failure') {
                      if (j.status === 'completed') {
                        const result = yield* collectJobLog({
                          github,
                          repo: resolvedRepo,
                          job: j,
                          filters: logFilters,
                        })
                        tui.dispatch({ _tag: 'SetLogs', ...result })
                        displayedJobIds.add(j.id)
                        anyStepMatched = true
                      }
                      continue
                    }

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
                    if (matchingStep.status === 'in_progress') {
                      const result = yield* internal.getBackscroll({
                        owner,
                        repo: repoName,
                        runId,
                        internalJobId: internalId.success,
                        stepUuid: matchingStep.id,
                        session,
                      })
                      const lines = result.lines.map((l) => l.line)
                      const displayLines = lines.slice(-tail)
                      tui.dispatch({
                        _tag: 'SetLogs',
                        jobName: `${j.name} > ${matchingStep.name}`,
                        conclusion: 'in_progress',
                        lines: displayLines,
                        notice: null,
                        truncation:
                          lines.length > tail
                            ? { totalLines: lines.length, offset: 0, pageSize: tail }
                            : null,
                      })
                    } else {
                      const logResult = yield* collectJobLog({
                        github,
                        repo: resolvedRepo,
                        job: j,
                        filters: logFilters,
                      })
                      tui.dispatch({
                        _tag: 'SetLogs',
                        jobName: `${j.name} > ${matchingStep.name}`,
                        conclusion: matchingStep.conclusion ?? matchingStep.status,
                        lines: logResult.lines,
                        notice: logResult.notice,
                        truncation: logResult.truncation,
                      })
                      displayedJobIds.add(j.id)
                    }
                  }
                  if (!anyStepMatched && !watch) {
                    tui.dispatch({
                      _tag: 'SetNoLogs',
                      message: `No step matching '${stepFilter.value}' in any job`,
                    })
                  }
                  return { completed, hasFailed }
                }
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
                })
                return { completed, hasFailed }
              }

              /** Collect all job logs, then dispatch once to avoid per-job state overwrites */
              const allLines: string[] = []
              /** Distinct per-job notices; identical fallbacks collapse into one line. */
              const notices = new Set<string>()
              let anyFailed = false
              for (const j of newJobs) {
                const r = yield* collectJobLog({
                  github,
                  repo: resolvedRepo,
                  job: j,
                  filters: logFilters,
                })
                allLines.push(`── ${r.jobName} (${r.conclusion}) ──`, ...r.lines, '')
                if (r.notice !== null) notices.add(r.notice)
                if (
                  r.conclusion !== null &&
                  r.conclusion !== 'success' &&
                  r.conclusion !== 'skipped'
                )
                  anyFailed = true
                displayedJobIds.add(j.id)
              }

              if (allLines.length > 0) {
                tui.dispatch({
                  _tag: 'SetLogs',
                  jobName: newJobs.length === 1 ? newJobs[0]!.name : `${newJobs.length} jobs`,
                  conclusion: anyFailed ? 'failure' : 'success',
                  lines: allLines,
                  notice: notices.size === 0 ? null : [...notices].join(' · '),
                  truncation: null,
                })
              }

              return { completed, hasFailed }
            })

          const failFast = watchMode === 'first-failure'
          const initial = yield* fetchAndDisplayLogs()

          if (watch && !initial.completed && !(failFast && initial.hasFailed)) {
            const startTime = Date.now()
            while (true) {
              yield* Effect.sleep(LOG_POLL_INTERVAL)
              const result = yield* fetchAndDisplayLogs()
              if (result.completed || (failFast && result.hasFailed)) break
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

          /** If watch completed but no logs were ever displayed, emit a final state */
          if (watch && displayedJobIds.size === 0) {
            tui.dispatch({
              _tag: 'SetNoLogs',
              message: failed
                ? 'No failed jobs found (run completed successfully).'
                : 'No matching jobs produced logs.',
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
  gh-ci-utils logs --job 69067527707          Specific job by ID
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
