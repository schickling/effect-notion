import { Effect, Option, Schema } from 'effect'
/**
 * gh-ci-utils rerun [target] [--failed] [-w] [--watch-mode first-failure|until-done] [--workflow]
 * gh-ci-utils run [target] [--workflow] [-w] [--watch-mode first-failure|until-done]
 * gh-ci-utils cancel [target]
 */
import * as Cli from 'effect/unstable/cli'
import * as ChildProcess from 'effect/unstable/process/ChildProcess'
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner'
import React from 'react'

import { outputModeLayer, outputOption } from '@overeng/tui-react/node'

import { ConfigError } from '../../isomorphic/Errors.ts'
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
                message: 'Could not detect repo. Use owner/repo as target.',
              })
              return
            }
            resolved = yield* resolveTargetOrCurrentBranch(targetInput, localRepo, preferWorkflow)
          }

          const { runId, repo: resolvedRepo } = resolved
          const github = yield* GitHubClient

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

        let target: { repo: string; branch: string }
        if (Option.isSome(targetInput)) {
          target = yield* resolveWorkflowDispatchTarget(targetInput.value, localRepo)
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

        const dispatchedAt = new Date()
        yield* ChildProcessSpawner.use((spawner) =>
          spawner.string(
            ChildProcess.make('gh', [
              'workflow',
              'run',
              workflow,
              '--repo',
              targetRepo,
              '--ref',
              branch,
            ]),
          ),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new ConfigError({
                message: `Failed to trigger workflow '${workflow}' for ${targetRepo} on ref '${branch}'`,
                cause,
              }),
          ),
        )

        const triggeredRun = yield* detectTriggeredRun({
          repo: targetRepo,
          branch,
          workflowName: workflow,
          dispatchedAt,
        })
        tui.dispatch({
          _tag: 'SetDispatched',
          runId: triggeredRun.id,
          repo: targetRepo,
          message: `Triggered run ${triggeredRun.id} for ${targetRepo} on ${branch}`,
          url: triggeredRun.html_url,
        })

        if (watch) {
          yield* watchRun({
            tui,
            repo: targetRepo,
            runId: triggeredRun.id,
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

        let resolved: { runId: number; repo: string }
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
  gh-ci-utils cancel 23601797547             Cancel by run ID`,
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

/** Whether GitHub reports a run in the dispatch second or a later second. */
export const isRunCreatedForDispatch = ({
  runCreatedAt,
  dispatchedAt,
}: {
  runCreatedAt: Date
  dispatchedAt: Date
}): boolean =>
  Math.floor(runCreatedAt.getTime() / 1000) >= Math.floor(dispatchedAt.getTime() / 1000)

/** Detect a newly dispatched run without excluding GitHub's whole-second timestamps. */
const detectTriggeredRun = ({
  repo,
  branch,
  workflowName,
  dispatchedAt,
}: {
  repo: string
  branch: string
  workflowName: string
  dispatchedAt: Date
}) =>
  Effect.gen(function* () {
    const github = yield* GitHubClient

    for (let attempt = 0; attempt < 30; attempt++) {
      const runs = yield* github.getRecentRunsForBranch({ repo, branch })
      const match = runs.find(
        (run) =>
          isRunCreatedForDispatch({ runCreatedAt: run.created_at, dispatchedAt }) &&
          (run.name === workflowName || run.path.includes(workflowName)),
      )
      if (match) return match
      yield* Effect.sleep('2 seconds')
    }

    return yield* new ConfigError({
      message: `Timed out waiting for a new '${workflowName}' run on branch '${branch}' in ${repo}`,
      cause: new Error('workflow dispatch timeout'),
    })
  })

const watchRun = ({
  tui,
  repo,
  runId,
  intervalSeconds,
  timeoutSeconds,
  failFast,
}: {
  tui: TuiHandle
  repo: string
  runId: number
  intervalSeconds: number
  timeoutSeconds: number
  failFast: boolean
}) =>
  Effect.gen(function* () {
    const github = yield* GitHubClient
    let previousSignature: string | undefined
    const startTime = Date.now()

    while (true) {
      const run = yield* github.getWorkflowRun({ repo, runId })
      const { jobs } = yield* github.listWorkflowJobs({ repo, runId })
      const signature = encodeJson({
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

      const runFailed =
        run.conclusion !== null && run.conclusion !== 'success' && run.conclusion !== 'skipped'
      const hasFailed = jobs.some(
        (j) => j.conclusion !== null && j.conclusion !== 'success' && j.conclusion !== 'skipped',
      )

      if (run.status === 'completed' || (failFast && hasFailed)) {
        if (runFailed || hasFailed) {
          tui.dispatch({
            _tag: 'SetError',
            error: 'Run failed',
            message: `Workflow run ${runId} ${run.status === 'completed' ? 'completed' : 'has a failed job'} with conclusion '${run.conclusion}'`,
          })
        } else {
          tui.dispatch({ _tag: 'SetDone', message: `Run ${runId} completed successfully` })
        }
        return
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
