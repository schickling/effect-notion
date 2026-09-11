/**
 * Deploy CLI - Full Example with Effect CLI
 *
 * Demonstrates:
 * - Effect CLI for argument parsing and signal handling
 * - Single `--output` flag for controlling output mode
 * - createTuiApp for state management
 * - Multiple output modes (tty, ci, pipe, json, ndjson, etc.)
 * - Graceful Ctrl+C handling with Interrupted state
 *
 * Run:
 *   bun examples/03-cli/deploy/main.ts --services api,web
 *   bun examples/03-cli/deploy/main.ts --services api,web --output json
 *   bun examples/03-cli/deploy/main.ts --services api,web --output ndjson
 *   bun examples/03-cli/deploy/main.ts --services api,web --dry-run
 *   bun examples/03-cli/deploy/main.ts --help
 */

import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect } from 'effect'
import { Command, Flag as Options } from 'effect/unstable/cli'

import { outputOption, outputModeLayer } from '../../../src/node/mod.ts'
import { DeployError, runDeploy } from './deploy.tsx'

// =============================================================================
// Command Options
// =============================================================================

const services = Options.string('services').pipe(
  Options.withAlias('s'),
  Options.withDescription('Comma-separated list of services to deploy'),
)

const env = Options.string('env').pipe(
  Options.withAlias('e'),
  Options.withDefault('production'),
  Options.withDescription('Environment to deploy to'),
)

const dryRun = Options.boolean('dry-run').pipe(
  Options.withDefault(false),
  Options.withDescription('Validate without deploying'),
)

const timeout = Options.integer('timeout').pipe(
  Options.withAlias('t'),
  Options.withDefault(30000),
  Options.withDescription('Deployment timeout in milliseconds'),
)

const force = Options.boolean('force').pipe(
  Options.withAlias('f'),
  Options.withDefault(false),
  Options.withDescription('Force deployment even with warnings'),
)

// =============================================================================
// Command Definition
// =============================================================================

const deploy = Command.make(
  'deploy',
  {
    services,
    env,
    dryRun,
    timeout,
    force,
    output: outputOption,
  },
  ({
    services: servicesArg,
    env: envArg,
    dryRun: dryRunArg,
    timeout: timeoutArg,
    force: forceArg,
    output,
  }) =>
    runDeploy({
      services: servicesArg
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      environment: envArg,
      dryRun: dryRunArg,
      timeout: timeoutArg,
      force: forceArg,
    }).pipe(
      Effect.provide(outputModeLayer(output)),
      Effect.scoped,
      // Exit with appropriate code based on result
      Effect.filterOrFail(
        (result) => result.success !== false,
        (result) => new DeployError({ message: result.error ?? 'Deployment failed' }),
      ),
    ),
)

// =============================================================================
// CLI Runner
// =============================================================================

const cli = Command.runWith(deploy, {
  version: '1.0.0',
})

// Run with Effect CLI (handles SIGINT/SIGTERM properly)
cli(process.argv.slice(2)).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)
