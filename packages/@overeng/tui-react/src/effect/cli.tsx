/**
 * Effect CLI Integration
 *
 * Provides reusable CLI options for tui-react output modes.
 * Use the `--output` flag in your Effect CLI commands to control output format.
 *
 * @example
 * ```typescript
 * import { Command, Flag as Options } from "effect/unstable/cli"
 * import { Effect } from "effect"
 * import { outputOption, outputModeLayer } from "@overeng/tui-react"
 *
 * const myCommand = Command.make("my-cmd", {
 *   name: Options.text("name"),
 *   output: outputOption,
 * }, ({ name, output }) =>
 *   myProgram(name).pipe(
 *     Effect.provide(outputModeLayer(output))
 *   )
 * )
 * ```
 *
 * @module
 */

import { Cause, Effect, Exit, Layer, Logger, Option, Runtime } from 'effect'
import { Flag } from 'effect/unstable/cli'

import { createLogCapture } from './LogCapture.ts'
import { detectOutputMode, viewOutputStreamStdoutLayer } from './OutputMode.node.ts'
import type { OutputModeTag } from './OutputMode.tsx'
import {
  type OutputMode,
  tty,
  ci,
  ciPlain,
  log,
  altScreen,
  json,
  ndjson,
  layer,
  isJson,
  isReact,
} from './OutputMode.tsx'

// =============================================================================
// Output Mode Values
// =============================================================================

/**
 * Valid values for the `--output` flag.
 */
export const OUTPUT_MODE_VALUES = [
  'auto',
  'tty',
  'alt-screen',
  'ci',
  'ci-plain',
  'log',
  'json',
  'ndjson',
] as const

/**
 * Type for the `--output` flag value.
 */
export type OutputModeValue = (typeof OUTPUT_MODE_VALUES)[number]

// =============================================================================
// CLI Option
// =============================================================================

/**
 * `--output` / `-o` flag for controlling output mode.
 *
 * Available modes:
 * - `auto` (default) - Auto-detect based on environment (TTY, CI, captured stdout)
 * - `tty` - Live output with animated spinners and colors
 * - `alt-screen` - Live output in alternate screen buffer (fullscreen TUI)
 * - `ci` - Live output with static spinners and colors
 * - `ci-plain` - Live output with static spinners, no colors
 * - `log` - Final output only, no colors (for log files)
 * - `json` - Final JSON output (raw state; exit code signals success/failure)
 * - `ndjson` - Live streaming JSON output (newline-delimited)
 *
 * @example
 * ```typescript
 * const myCommand = Command.make("cmd", {
 *   output: outputOption,
 * }, ({ output }) =>
 *   myProgram().pipe(Effect.provide(outputModeLayer(output)))
 * )
 * ```
 */
export const outputOption = Flag.choice('output', OUTPUT_MODE_VALUES).pipe(
  Flag.withAlias('o'),
  Flag.withDescription('Output mode: auto, tty, alt-screen, ci, ci-plain, log, json, ndjson'),
  Flag.withDefault('auto' as OutputModeValue),
)

// =============================================================================
// Layer Helper
// =============================================================================

/**
 * Map from flag value to OutputMode preset.
 */
const modeMap: Record<Exclude<OutputModeValue, 'auto'>, OutputMode> = {
  tty: tty,
  'alt-screen': altScreen,
  ci: ci,
  'ci-plain': ciPlain,
  log: log,
  json: json,
  ndjson: ndjson,
}

/**
 * Create a logger layer that writes to stderr.
 *
 * This is used in JSON modes to ensure all log output goes to stderr,
 * keeping stdout clean for JSON data only.
 *
 * `Logger.consolePretty()` prints by itself and returns `void`, so it must not
 * be wrapped in `Logger.withConsoleError` — that wrapper would print the line
 * to stdout and then hand the `void` result to `console.error`, emitting a
 * stray `undefined` on stderr after every log.
 *
 * The stdout/stderr choice is made by the `Logger.LogToStderr` reference, which
 * `consolePretty` reads on each log call. (`consolePretty({ stderr: true })` is
 * declared in the typings but ignored by the implementation in this Effect
 * version, so the reference is the only switch that actually takes effect.)
 */
const stderrLoggerLayer: Layer.Layer<never> = Layer.merge(
  Logger.layer([Logger.consolePretty()], { mergeWithExisting: false }),
  Layer.succeed(Logger.LogToStderr, true),
)

/**
 * Create an OutputMode layer from the `--output` flag value.
 *
 * Behavior by mode type:
 * - **Progressive React modes** (`tty`, `ci`, `ci-plain`, `alt-screen`): Captures all
 *   Effect logs and console output to prevent TUI corruption. Captured logs are
 *   accessible via `useCapturedLogs()` in React components.
 * - **JSON modes** (`json`, `ndjson`): Redirects logs to stderr, keeping stdout
 *   clean for JSON data only.
 * - **Final React modes** (`log`): No log capture (single render at end).
 *
 * @example
 * ```typescript
 * // In command handler:
 * myProgram().pipe(Effect.provide(outputModeLayer(output)))
 * ```
 */
export const outputModeLayer = (value: OutputModeValue): Layer.Layer<OutputModeTag> => {
  const mode = value === 'auto' ? detectOutputMode() : modeMap[value]

  // For JSON modes, configure logger to write to stderr
  // This keeps stdout clean for JSON data only
  if (isJson(mode) === true) {
    return Layer.merge(layer(mode), stderrLoggerLayer)
  }

  // For progressive React modes, capture logs to prevent TUI corruption
  if (isReact(mode) === true && mode.timing === 'progressive') {
    return Layer.unwrap(
      Effect.gen(function* () {
        const { handle, loggerLayer } = yield* createLogCapture()

        const modeWithCapture: OutputMode = {
          ...mode,
          capturedLogs: handle,
        }

        return Layer.merge(layer(modeWithCapture), loggerLayer)
      }),
    )
  }

  // Final React modes (log) -- no capture needed
  return layer(mode)
}

/**
 * Complete TUI runtime layer: combines the output mode with the default
 * `ViewOutputStreamTag` binding (stdout). This is what every entry point
 * except `runResult` should provide — `runResult` overrides the view stream
 * to stderr internally.
 *
 * Prefer this over `outputModeLayer` when wiring a CLI main — it gives you
 * both dependencies in one call. `runTuiMain` uses it internally.
 */
export const tuiRuntimeLayer = (value: OutputModeValue): Layer.Layer<OutputModeTag> =>
  Layer.merge(outputModeLayer(value), viewOutputStreamStdoutLayer)

/**
 * Resolve an OutputModeValue to an OutputMode.
 *
 * Useful when you need the mode object directly rather than a layer.
 *
 * @example
 * ```typescript
 * const mode = resolveOutputMode('json')
 * if (isJson(mode)) {
 *   // Handle JSON mode
 * }
 * ```
 */
export const resolveOutputMode = (value: OutputModeValue): OutputMode => {
  if (value === 'auto') {
    return detectOutputMode()
  }
  return modeMap[value]
}

// =============================================================================
// CLI Main Runner
// =============================================================================

/**
 * Options for `runTuiMain`.
 */
export interface RunTuiMainOptions {
  /**
   * Format an error cause for stderr output.
   *
   * - `Option.some(message)` — write message to stderr
   * - `Option.none()` — suppress this error entirely (exit code still reflects it)
   *
   * @default `defaultFormatError` (verbose with stack traces via `Cause.pretty`)
   *
   * @example Suppress errors already represented in JSON output:
   * ```typescript
   * formatError: (cause) =>
   *   Cause.failures(cause).pipe(chunk =>
   *     [...chunk].some(e => e._tag === 'SyncFailedError')
   *   ) ? Option.none()
   *     : defaultFormatError(cause)
   * ```
   */
  readonly formatError?: (cause: Cause.Cause<unknown>) => Option.Option<string>
}

/** Verbose error formatter — full stack traces via `Cause.pretty`. This is the default. */
export const defaultFormatError = (cause: Cause.Cause<unknown>): Option.Option<string> =>
  Option.some(Cause.pretty(cause))

/** Compact error formatter — just error messages, no stack traces. For machine/agent output. */
export const compactFormatError = (cause: Cause.Cause<unknown>): Option.Option<string> => {
  const messages = Cause.prettyErrors(cause).map((error) => error.message)
  return messages.length > 0 ? Option.some(messages.join('\n')) : Option.none()
}

/**
 * Type for the NodeRuntime parameter required by `runTuiMain`.
 */
export interface TuiRuntime {
  readonly runMain: (options?: {
    readonly disableErrorReporting?: boolean
    readonly disablePrettyLogger?: boolean
    readonly teardown?: <E, A>(exit: Exit.Exit<E, A>, onExit: (code: number) => void) => void
  }) => <E, A>(effect: Effect.Effect<A, E>) => void
}

/**
 * Finalization for `runTuiMain`.
 *
 * The interrupt/failure code is derived from the fiber `Exit` alone —
 * `Runtime.defaultTeardown` maps an interrupt-only cause (Ctrl-C) to **130**, the
 * shell convention, and any other failure to its `Runtime.errorExitCode` marker
 * or 1. Nothing about the run is smuggled through the mutable global
 * `process.exitCode`: a stale ambient value (set by an earlier phase, or by a
 * previous test in the same process) must never turn a clean success non-zero.
 *
 * On success the ambient `process.exitCode` IS honored, because that is the
 * declared channel for app-level codes: `createTuiApp`'s `exitCode` mapper
 * assigns it on unmount (e.g. `Error` state → 1) while the effect itself
 * succeeds. Forwarding it here makes the runner exit explicitly instead of
 * relying on the event loop draining.
 */
// oxlint-disable-next-line overeng/named-args -- implements Effect's `Teardown` interface (fixed `(exit, onExit)` signature) passed to `NodeRuntime.runMain`
const tuiTeardown = <E, A>(exit: Exit.Exit<E, A>, onExit: (code: number) => void): void => {
  if (Exit.isSuccess(exit) === true) {
    onExit(process.exitCode === undefined ? 0 : Number(process.exitCode))
    return
  }
  Runtime.defaultTeardown(exit, onExit)
}

/**
 * Run a TUI CLI application as the main entry point.
 *
 * This helper wraps `NodeRuntime.runMain` with proper error handling for TUI apps:
 * - Errors are written to stderr (not stdout) to avoid polluting JSON output
 * - Uses `disableErrorReporting` to prevent `runMain` from logging to stdout
 * - Preserves exit codes from errors
 * - Customizable error formatting via `formatError` (verbose, compact, or custom)
 *
 * Supports Effect's dual API pattern for flexible usage in pipe chains.
 *
 * @example
 * ```typescript
 * // Pipeable usage (recommended):
 * Cli.Command.run(myCommand, { name: 'my-cli', version })(process.argv).pipe(
 *   Effect.scoped,
 *   Effect.provide(baseLayer),
 *   runTuiMain(NodeRuntime)
 * )
 * ```
 *
 * @example
 * ```typescript
 * // Data-first usage:
 * runTuiMain(NodeRuntime, program)
 * ```
 *
 * @example
 * ```typescript
 * // With compact errors (for agent-friendly CLIs):
 * Cli.Command.run(myCommand, { name: 'my-cli', version })(process.argv).pipe(
 *   Effect.scoped,
 *   Effect.provide(baseLayer),
 *   runTuiMain(NodeRuntime, { formatError: compactFormatError })
 * )
 * ```
 */
// Data-last (pipeable): runTuiMain(runtime) or runTuiMain(runtime, options)
export function runTuiMain(
  runtime: TuiRuntime,
  options?: RunTuiMainOptions,
): <E, A>(effect: Effect.Effect<A, E>) => void
// Data-first: runTuiMain(runtime, effect) or runTuiMain(runtime, effect, options)
export function runTuiMain<E, A>(
  runtime: TuiRuntime,
  effect: Effect.Effect<A, E>,
  options?: RunTuiMainOptions,
): void
export function runTuiMain<E, A>(
  ...args: [
    runtime: TuiRuntime,
    effectOrOptions?: Effect.Effect<A, E> | RunTuiMainOptions,
    maybeOptions?: RunTuiMainOptions,
  ]
): ((effect: Effect.Effect<A, E>) => void) | void {
  const [runtime, effectOrOptions, maybeOptions] = args
  // Check if second argument is an Effect (data-first) or options/undefined (data-last)
  if (effectOrOptions !== undefined && Effect.isEffect(effectOrOptions) === true) {
    // Data-first: runTuiMain(runtime, effect, options?)
    return runTuiMainImpl({
      runtime,
      effect: effectOrOptions,
      options: maybeOptions,
    })
  }
  // Data-last: runTuiMain(runtime, options?) returns (effect) => void
  const options = effectOrOptions as RunTuiMainOptions | undefined
  return (effect: Effect.Effect<A, E>) => runTuiMainImpl({ runtime, effect, options })
}

/** Internal implementation of runTuiMain */
const runTuiMainImpl = <E, A>({
  runtime,
  effect,
  options,
}: {
  runtime: TuiRuntime
  effect: Effect.Effect<A, E>
  options?: RunTuiMainOptions | undefined
}): void => {
  const formatError = options?.formatError ?? defaultFormatError

  effect.pipe(
    // Report the failure on stderr (stdout stays clean for JSON/result output) but
    // keep the cause in the error channel: the Exit is the only channel the exit
    // code is derived from, so an interrupt stays an interrupt all the way to
    // {@link tuiTeardown}. Interrupts carry no diagnostic worth printing.
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        if (Cause.hasInterruptsOnly(cause) === true) return
        const formatted = formatError(cause)
        if (Option.isSome(formatted) === true) {
          process.stderr.write(formatted.value + '\n')
        }
      }).pipe(Effect.flatMap(() => Effect.failCause(cause))),
    ),
    runtime.runMain({
      disableErrorReporting: true,
      disablePrettyLogger: true,
      teardown: tuiTeardown,
    }),
  )
}
