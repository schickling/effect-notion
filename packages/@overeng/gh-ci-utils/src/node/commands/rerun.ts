import { Effect, Option, Schema } from 'effect'
/**
 * gh-ci-utils rerun [target] [--failed] [-w] [--watch-mode first-failure|until-done] [--workflow]
 * gh-ci-utils run [target] [--workflow] [-w] [--watch-mode first-failure|until-done]
 * gh-ci-utils cancel [target]
 */
import * as Cli from 'effect/unstable/cli'
import React from 'react'

import { outputModeLayer, outputOption } from '@overeng/tui-react/node'

import { ConfigError } from '../../isomorphic/Errors.ts'
import {
  isBlockingConclusion,
  isStaleRunSelection,
  isUnsuccessfulConclusion,
  isWrongWorkflowSelection,
} from '../../isomorphic/lib/summary.ts'
import { MutationApp, MutationView } from '../../isomorphic/renderers/MutationOutput/mod.ts'
import type { MutationAction } from '../../isomorphic/renderers/MutationOutput/schema.ts'
import { detectCurrentBranch, resolveConfig } from '../Config.ts'
import { GitHubClient } from '../GitHubClient.ts'
import { collectApiMeta } from '../lib/apiMeta.ts'
import {
  resolveActiveTarget,
  resolveActiveTargetOrCurrentBranch,
  resolveTarget,
  resolveTargetOrCurrentBranch,
  resolveWorkflowDispatchTarget,
  targetArg,
  timeoutOption,
  watchModeOption,
  watchOption,
  workflowOption,
  type ResolvedTarget,
} from '../RunId.ts'

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

// =============================================================================
// rerun command
// =============================================================================

/** CLI subcommand to rerun failed jobs in a workflow run */
export const rerunCommand = Cli.Command.make('rerun', {
  output: outputOption,
  target: targetArg,
  workflow: workflowOption,
  failed: Cli.Flag.boolean('failed').pipe(
    Cli.Flag.withDefault(false),
    Cli.Flag.withDescription('Re-run only failed jobs'),
  ),
  watch: watchOption,
  watchMode: watchModeOption,
  timeout: timeoutOption,
}).pipe(
  Cli.Command.withHandler(
    ({ output, target: targetInput, workflow: workflowOpt, failed, watch, watchMode, timeout }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const tui = (yield* MutationApp.run(
            React.createElement(MutationView, { stateAtom: MutationApp.stateAtom }),
          )) as TuiHandle

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
                message: 'Could not detect repo. Use owner/repo as target.',
              })
              return
            }
            resolved = yield* resolveTargetOrCurrentBranch(targetInput, localRepo, preferWorkflow)
          }
          yield* validateMutationRunSelection({ action: 'rerun', resolved })

          const { runId, repo: resolvedRepo } = resolved
          const github = yield* GitHubClient
          const previousRunAttempt = watch
            ? (yield* github.getWorkflowRun({ repo: resolvedRepo, runId })).run_attempt
            : undefined

          if (failed) {
            yield* github.rerunFailedJobs({ repo: resolvedRepo, runId })
            tui.dispatch({
              _tag: 'SetDispatched',
              runId,
              repo: resolvedRepo,
              message: `Re-running failed jobs for run ${runId}`,
              url: null,
            })
          } else {
            yield* github.rerunWorkflow({ repo: resolvedRepo, runId })
            tui.dispatch({
              _tag: 'SetDispatched',
              runId,
              repo: resolvedRepo,
              message: `Re-running all jobs for run ${runId}`,
              url: null,
            })
          }

          if (watch) {
            yield* watchRun({
              tui,
              repo: resolvedRepo,
              runId,
              intervalSeconds: 5,
              timeoutSeconds: timeout,
              failFast: watchMode === 'first-failure',
              ...(previousRunAttempt !== undefined ? { previousRunAttempt } : {}),
            })
          }

          yield* dispatchMeta(tui)
        }),
      ).pipe(Effect.provide(outputModeLayer(output))),
  ),
  Cli.Command.withDescription(
    `Re-run a workflow run

Examples:
  gh-ci-utils rerun                           Re-run current branch's latest run
  gh-ci-utils rerun --failed                  Re-run only failed jobs
  gh-ci-utils rerun -w                        Re-run and watch (exit on first failure)
  gh-ci-utils rerun -w --watch-mode until-done   Re-run and watch until done
  gh-ci-utils rerun owner/repo                Cross-repo re-run`,
  ),
)

// =============================================================================
// run command — dispatch a new workflow
// =============================================================================

/** CLI subcommand to trigger a new workflow run */
export const runCommand = Cli.Command.make('run', {
  output: outputOption,
  workflow: Cli.Flag.string('workflow').pipe(
    Cli.Flag.withDefault('CI'),
    Cli.Flag.withDescription('Workflow name (default: CI)'),
  ),
  target: targetArg,
  watch: watchOption,
  watchMode: watchModeOption,
  timeout: timeoutOption,
}).pipe(
  Cli.Command.withHandler(({ output, workflow, target: targetInput, watch, watchMode, timeout }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const tui = (yield* MutationApp.run(
          React.createElement(MutationView, { stateAtom: MutationApp.stateAtom }),
        )) as TuiHandle

        const config = yield* resolveConfig({})
        const localRepo = Option.fromNullishOr(config.repos[0])
        const github = yield* GitHubClient

        let target: { repo: string; branch: string }
        if (Option.isSome(targetInput)) {
          target = yield* resolveWorkflowDispatchTarget({
            input: targetInput.value,
            localRepo,
            getDefaultBranch: github.getDefaultBranch,
          })
        } else {
          if (Option.isNone(localRepo)) {
            tui.dispatch({
              _tag: 'SetError',
              error: 'No repo configured',
              message: 'Could not detect repo. Use owner/repo as target.',
            })
            return
          }
          target = {
            repo: localRepo.value,
            branch: yield* detectCurrentBranch,
          }
        }

        const { repo: targetRepo, branch } = target

        const dispatched = yield* github.dispatchWorkflow({
          repo: targetRepo,
          workflow,
          ref: branch,
        })
        const runId = dispatched.workflow_run_id
        tui.dispatch({
          _tag: 'SetDispatched',
          runId,
          repo: targetRepo,
          message: `Triggered run ${runId} for ${targetRepo} on ${branch}`,
          url: dispatched.html_url,
        })

        if (watch) {
          yield* watchRun({
            tui,
            repo: targetRepo,
            runId,
            intervalSeconds: 5,
            timeoutSeconds: timeout,
            failFast: watchMode === 'first-failure',
          })
        }

        yield* dispatchMeta(tui)
      }),
    ).pipe(Effect.provide(outputModeLayer(output))),
  ),
  Cli.Command.withDescription(
    `Dispatch a workflow and watch it

Examples:
  gh-ci-utils run                             Dispatch CI on current branch
  gh-ci-utils run -w                          Dispatch and watch (exit on first failure)
  gh-ci-utils run --workflow Deploy            Dispatch specific workflow
  gh-ci-utils run owner/repo@main -w          Cross-repo dispatch`,
  ),
)

// =============================================================================
// cancel command
// =============================================================================

/** CLI subcommand to cancel a running workflow */
export const cancelCommand = Cli.Command.make('cancel', {
  output: outputOption,
  target: targetArg,
  workflow: workflowOption,
}).pipe(
  Cli.Command.withHandler(({ output, target: targetInput, workflow: workflowOpt }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const tui = (yield* MutationApp.run(
          React.createElement(MutationView, { stateAtom: MutationApp.stateAtom }),
        )) as TuiHandle

        const config = yield* resolveConfig({})
        const localRepo = Option.fromNullishOr(config.repos[0])
        const preferWorkflow = Option.isSome(workflowOpt) ? workflowOpt.value : undefined

        let resolved: ResolvedTarget
        if (Option.isSome(targetInput)) {
          resolved = yield* resolveActiveTarget(targetInput.value, localRepo, preferWorkflow)
        } else {
          if (Option.isNone(localRepo)) {
            tui.dispatch({
              _tag: 'SetError',
              error: 'No repo configured',
              message: 'Could not detect repo. Use owner/repo as target.',
            })
            return
          }
          resolved = yield* resolveActiveTargetOrCurrentBranch(
            targetInput,
            localRepo.value,
            preferWorkflow,
          )
        }
        yield* validateMutationRunSelection({ action: 'cancel', resolved })

        const github = yield* GitHubClient
        const { runId, repo: resolvedRepo } = resolved

        yield* github.cancelRun({ repo: resolvedRepo, runId })
        tui.dispatch({
          _tag: 'SetDone',
          message: `Cancelled run ${runId} in ${resolvedRepo}`,
        })

        yield* dispatchMeta(tui)
      }),
    ).pipe(Effect.provide(outputModeLayer(output))),
  ),
  Cli.Command.withDescription(
    `Cancel a running workflow

Examples:
  gh-ci-utils cancel                          Cancel current branch's run
  gh-ci-utils cancel owner/repo              Cancel cross-repo run
  gh-ci-utils cancel https://github.com/owner/repo/pull/506  Cancel active PR CI run
  gh-ci-utils cancel 70000000001             Cancel by run ID`,
  ),
)

// =============================================================================
// Shared helpers
// =============================================================================

interface TuiHandle {
  dispatch: (action: MutationAction) => void
}

const dispatchMeta = (tui: TuiHandle) =>
  Effect.gen(function* () {
    const meta = yield* collectApiMeta
    tui.dispatch({ _tag: 'SetMeta', _meta: meta })
  })

/** Refuse a mutation when target resolution selected a run the action may not safely change. */
export const validateMutationRunSelection = Effect.fn('validate-mutation-run-selection')(
  function* ({ action, resolved }: { action: 'rerun' | 'cancel'; resolved: ResolvedTarget }) {
    const selection = resolved.selection
    if (action === 'rerun' && isStaleRunSelection(selection)) {
      return yield* new ConfigError({
        message: `Run ${resolved.runId} targets ${selection.runHeadSha}, not expected PR head ${selection.expectedHeadSha}; refusing to rerun the stale run`,
        cause: 'stale run selection',
      })
    }

    if (!isWrongWorkflowSelection(selection)) return
    return yield* new ConfigError({
      message: `No run matching workflow '${selection.expectedWorkflow}' was found in ${resolved.repo}; refusing to ${action} run ${resolved.runId}`,
      cause: 'workflow not found',
    })
  },
)

/** Whether polling has reached the new attempt created by a rerun request. */
export const isRunAttemptReady = ({
  runAttempt,
  previousRunAttempt,
}: {
  runAttempt: number
  previousRunAttempt: number
}): boolean => runAttempt > previousRunAttempt

/** Decide whether a run watch should continue, succeed, fail, or report cancellation. */
export const classifyRunWatch = ({
  runStatus,
  runConclusion,
  jobConclusions,
  failFast,
}: {
  runStatus: string
  runConclusion: string | null
  jobConclusions: readonly (string | null)[]
  failFast: boolean
}): 'continue' | 'success' | 'failure' | 'cancelled' => {
  const hasBlockingConclusion =
    isBlockingConclusion(runConclusion) || jobConclusions.some(isBlockingConclusion)
  const hasUnsuccessfulConclusion =
    isUnsuccessfulConclusion(runConclusion) || jobConclusions.some(isUnsuccessfulConclusion)
  if (runStatus === 'completed') {
    if (!hasUnsuccessfulConclusion) return 'success'
    return hasBlockingConclusion ? 'failure' : 'cancelled'
  }
  if (!failFast || !hasUnsuccessfulConclusion) return 'continue'
  return hasBlockingConclusion ? 'failure' : 'cancelled'
}

const watchRun = ({
  tui,
  repo,
  runId,
  intervalSeconds,
  timeoutSeconds,
  failFast,
  previousRunAttempt,
}: {
  tui: TuiHandle
  repo: string
  runId: number
  intervalSeconds: number
  timeoutSeconds: number
  failFast: boolean
  previousRunAttempt?: number
}) =>
  Effect.gen(function* () {
    const github = yield* GitHubClient
    let previousSignature: string | undefined
    const startTime = Date.now()

    while (true) {
      const run = yield* github.getWorkflowRun({ repo, runId })
      const attemptReady =
        previousRunAttempt === undefined ||
        isRunAttemptReady({ runAttempt: run.run_attempt, previousRunAttempt })

      if (attemptReady) {
        const { jobs } = yield* github.listWorkflowJobs({ repo, runId })
        const signature = encodeJson({
          runAttempt: run.run_attempt,
          status: run.status,
          conclusion: run.conclusion,
          jobs: jobs.map((j) => ({ name: j.name, status: j.status, conclusion: j.conclusion })),
        })

        if (signature !== previousSignature) {
          previousSignature = signature
          tui.dispatch({
            _tag: 'SetWatching',
            runId,
            repo,
            status: run.status,
            conclusion: run.conclusion,
            jobs: jobs.map((j) => ({
              name: j.name,
              status: j.status,
              conclusion: j.conclusion,
              runner: j.runner_name ?? '',
            })),
          })
        }

        const watchResult = classifyRunWatch({
          runStatus: run.status,
          runConclusion: run.conclusion,
          jobConclusions: jobs.map((job) => job.conclusion),
          failFast,
        })

        if (watchResult !== 'continue') {
          if (watchResult === 'success') {
            tui.dispatch({ _tag: 'SetDone', message: `Run ${runId} completed successfully` })
          } else if (watchResult === 'cancelled') {
            tui.dispatch({
              _tag: 'SetError',
              error: 'Run cancelled',
              message: `Workflow run ${runId} was cancelled`,
            })
          } else {
            tui.dispatch({
              _tag: 'SetError',
              error: 'Run failed',
              message: `Workflow run ${runId} ${run.status === 'completed' ? 'completed' : 'has a failed job'} with conclusion '${run.conclusion}'`,
            })
          }
          return
        }
      }

      const elapsed = (Date.now() - startTime) / 1000
      if (elapsed >= timeoutSeconds) {
        tui.dispatch({
          _tag: 'SetError',
          error: 'Timeout',
          message: `Watch timed out after ${Math.round(elapsed)}s. Run ${runId} is still in progress.`,
        })
        return
      }

      yield* Effect.sleep(`${intervalSeconds} seconds`)
    }
  })
