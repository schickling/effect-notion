#!/usr/bin/env bun

import { NodeHttpClient, NodeRuntime, NodeServices } from '@effect/platform-node'
import { Cause, Effect, Layer, Logger } from 'effect'
import * as Cli from 'effect/unstable/cli'

import { compactFormatError, runTuiMain } from '@overeng/tui-react/node'
import { rewriteHelpSubcommand } from '@overeng/utils/node/cli-help-rewrite'

import { ghCiUtilsCommand } from '../src/cli.ts'
import { GitHubAuthConfigTag, loadAuthConfig } from '../src/node/Config.ts'
import { GitHubClient } from '../src/node/GitHubClient.ts'
import { GitHubInternal } from '../src/node/GitHubInternal.ts'
import {
  ROUTED_FROM_ENV_VAR,
  TOOL_FAILURE_EXIT_CODE,
  renderToolFailure,
} from '../src/node/lib/toolFailure.ts'

const platformLayer = Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerNodeHttp)
const authConfigLayer = Layer.effect(GitHubAuthConfigTag, loadAuthConfig).pipe(
  Layer.provide(platformLayer),
)
const githubLayer = GitHubClient.Default.pipe(
  Layer.provide(Layer.mergeAll(platformLayer, authConfigLayer)),
)
const internalLayer = GitHubInternal.Default.pipe(Layer.provide(platformLayer))
/**
 * stdout carries the rendered view or the `--output json` document and nothing
 * else, so every log line goes to stderr — a single warning on stdout makes the
 * JSON an agent is parsing unparseable.
 *
 * `Logger.LogToStderr` rather than a `withConsoleError` logger layer: tui-react's
 * json-mode logger wraps `consolePretty` in `withConsoleError`, which still
 * reaches `console.log` (fixed upstream in
 * overengineeringstudio/effect-utils#1201); remove this line once that pin lands.
 */
const stderrLoggerLayer = Layer.succeed(Logger.LogToStderr, true)
const baseLayer = Layer.mergeAll(
  platformLayer,
  authConfigLayer,
  githubLayer,
  internalLayer,
  stderrLoggerLayer,
)

const cli = Cli.Command.runWith(ghCiUtilsCommand, { version: '0.1.0' })
const program = cli(rewriteHelpSubcommand(process.argv.slice(2))).pipe(
  Effect.scoped,
  Effect.provide(baseLayer),
)

/**
 * A cause reaching the top is a tool failure — never a verdict: the renderers
 * map verdicts onto `process.exitCode` and complete successfully. Render it once
 * on stderr (agents read failures there, and a `/$bunfs/root/...` stack is
 * nothing they can act on), claim exit 4, then finish as a success so
 * `runTuiMain`'s teardown honours that code instead of flattening it to 1.
 *
 * `formatError` stays as the backstop for a failure inside this handler itself.
 */
program.pipe(
  Effect.catchCause((cause) =>
    Effect.sync(() => {
      if (Cause.hasInterruptsOnly(cause) === true) {
        process.exitCode = 130
        return
      }
      process.stderr.write(
        renderToolFailure({ cause, routedFrom: process.env[ROUTED_FROM_ENV_VAR] }) + '\n',
      )
      process.exitCode = TOOL_FAILURE_EXIT_CODE
    }),
  ),
  runTuiMain(NodeRuntime, { formatError: compactFormatError }),
)
