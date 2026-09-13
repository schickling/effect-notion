import { Effect } from 'effect'
/**
 * gh-ci-utils runners
 *
 * Show active runner jobs across all configured hosts.
 */
import * as Cli from 'effect/unstable/cli'
import React from 'react'

import { outputModeLayer, outputOption } from '@overeng/tui-react/node'

import type { HostResult } from '../../isomorphic/renderers/RunnersOutput/mod.ts'
import { RunnersApp, RunnersView } from '../../isomorphic/renderers/RunnersOutput/mod.ts'
import { resolveConfig } from '../Config.ts'
import { fetchRunnerHostJobs } from '../RunnerClient.ts'

/** CLI subcommand to list self-hosted runners and their jobs */
export const runnersCommand = Cli.Command.make('runners', { output: outputOption }).pipe(
  Cli.Command.withHandler(({ output }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const tui = yield* RunnersApp.run(
          React.createElement(RunnersView, { stateAtom: RunnersApp.stateAtom }),
        )

        const config = yield* resolveConfig({})
        const results = yield* Effect.all(
          config.runnerHosts.map((host) =>
            fetchRunnerHostJobs(host).pipe(
              Effect.map(
                (result) =>
                  ({
                    host: result.host,
                    status: result.status,
                    jobs: result.jobs.map((job) => ({
                      runner: job.runner,
                      scaleSet: job.scaleSet,
                      durationSeconds: job.durationSec,
                    })),
                  }) satisfies HostResult,
              ),
            ),
          ),
          { concurrency: 'unbounded' },
        )

        tui.dispatch({ _tag: 'SetRunners', hosts: results })
      }),
    ).pipe(Effect.provide(outputModeLayer(output))),
  ),
  Cli.Command.withDescription('Show active runner jobs across configured hosts'),
)
