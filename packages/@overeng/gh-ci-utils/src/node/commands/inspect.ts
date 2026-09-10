import { Effect, Option } from 'effect'
/**
 * gh-ci-utils inspect --job <id> [--repo owner/name] [--with-usage]
 *
 * Explains one GitHub Actions job's runner: what GitHub saw, what the local
 * `nsc` session saw, and the single conservative verdict derived from both.
 *
 * The GitHub facts are fetched first and are never discarded: a missing,
 * unauthenticated or unreadable `nsc` downgrades the verdict to `unknown` and
 * records why, it does not fail the command.
 */
import * as Cli from 'effect/unstable/cli'
import React from 'react'

import { outputModeLayer, outputOption } from '@overeng/tui-react/node'

import { classifyInspection } from '../../isomorphic/lib/inspectAssessment.ts'
import { toInspectGitHubFacts } from '../../isomorphic/lib/inspectFacts.ts'
import { InspectApp, InspectView } from '../../isomorphic/renderers/InspectOutput/mod.ts'
import { resolveConfig } from '../Config.ts'
import { GitHubClient } from '../GitHubClient.ts'
import { collectApiMeta } from '../lib/apiMeta.ts'
import { observeNamespaceJob } from '../NamespaceClient.ts'

const jobOption = Cli.Flag.integer('job').pipe(
  Cli.Flag.withDescription('Numeric GitHub Actions job id to inspect'),
)

const repoOption = Cli.Flag.string('repo').pipe(
  Cli.Flag.optional,
  Cli.Flag.withDescription('owner/name (default: repo detected from the git remote)'),
)

const withUsageOption = Cli.Flag.boolean('with-usage').pipe(
  Cli.Flag.withDefault(false),
  Cli.Flag.withDescription(
    'Also sample `nsc instance report` for observed CPU/RAM usage (extra Namespace query)',
  ),
)

/** CLI subcommand to inspect the runner behind a single workflow job */
export const inspectCommand = Cli.Command.make('inspect', {
  output: outputOption,
  job: jobOption,
  repo: repoOption,
  withUsage: withUsageOption,
}).pipe(
  Cli.Command.withHandler(({ output, job: jobId, repo: repoOpt, withUsage }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const tui = yield* InspectApp.run(
          React.createElement(InspectView, { stateAtom: InspectApp.stateAtom }),
        )

        const config = yield* resolveConfig({})
        const repo = Option.isSome(repoOpt) ? repoOpt.value : config.repos[0]
        if (repo === undefined) {
          tui.dispatch({
            _tag: 'SetError',
            error: 'No repo',
            message: 'Could not detect a repo from the git remote. Pass --repo owner/name.',
          })
          return
        }

        const github = yield* GitHubClient
        const job = yield* github.getWorkflowJob({ repo, jobId })
        const githubFacts = toInspectGitHubFacts({ job, repo })

        /**
         * The Namespace observation is deliberately sequenced after the GitHub
         * fetch: the runner kind decides whether `nsc` is consulted at all.
         */
        const namespace = yield* observeNamespaceJob({ github: githubFacts, withUsage })

        tui.dispatch({
          _tag: 'SetInspection',
          github: githubFacts,
          namespace,
          assessment: classifyInspection({ github: githubFacts, namespace }),
        })

        const meta = yield* collectApiMeta
        tui.dispatch({ _tag: 'SetMeta', _meta: meta })
      }),
    ).pipe(Effect.provide(outputModeLayer(output))),
  ),
  Cli.Command.withDescription(
    `Explain the runner behind a single job (GitHub facts + Namespace facts + verdict)

Examples:
  gh-ci-utils inspect --job 69067527707              Current repo
  gh-ci-utils inspect --job 69067527707 --with-usage Also sample observed CPU/RAM
  gh-ci-utils inspect --job 69067527707 --repo owner/name`,
  ),
)
