/**
 * Error Handling for CLI Output
 *
 * Provides schemas and utilities for handling errors in different output modes.
 * In JSON mode, errors must be output as JSON objects, not plain text.
 *
 * @example
 * ```typescript
 * import { CommandError, withJsonErrors } from '@overeng/tui-react'
 *
 * // Run command with JSON error handling
 * runDeploy(services).pipe(
 *   withJsonErrors(DeployState),
 *   Effect.provide(Layer.succeed(OutputMode, { _tag: 'final-json' }))
 * )
 * ```
 */

import { Effect, Schema } from 'effect'

import { OutputModeTag, isJson } from './OutputMode.tsx'

// =============================================================================
// Error Schemas
// =============================================================================

/**
 * Validation error - for invalid input, configuration, etc.
 */
export const ValidationError = Schema.TaggedStruct('CommandError.Validation', {
  message: Schema.String,
  field: Schema.optional(Schema.String),
})
/** Inferred type for a validation error (invalid input, configuration, etc.). */
export type ValidationError = Schema.Schema.Type<typeof ValidationError>

/**
 * Runtime error - for errors during command execution.
 */
export const RuntimeError = Schema.TaggedStruct('CommandError.Runtime', {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
})
/** Inferred type for a runtime error during command execution. */
export type RuntimeError = Schema.Schema.Type<typeof RuntimeError>

/**
 * Cancelled error - for user cancellation, timeout, or signal.
 */
export const CancelledError = Schema.TaggedStruct('CommandError.Cancelled', {
  reason: Schema.Literals(['user', 'timeout', 'signal']),
})
/** Inferred type for a cancellation error (user, timeout, or signal). */
export type CancelledError = Schema.Schema.Type<typeof CancelledError>

/**
 * Union of all command error types.
 */
export const CommandError = Schema.Union([ValidationError, RuntimeError, CancelledError])
/** Inferred union type of all command error variants. */
export type CommandError = Schema.Schema.Type<typeof CommandError>

// =============================================================================
// Error Constructors
// =============================================================================

/**
 * Create a validation error.
 */
export const validationError = ({
  message,
  field,
}: {
  message: string
  field?: string
}): ValidationError => ({
  _tag: 'CommandError.Validation',
  message,
  ...(field !== undefined ? { field } : {}),
})

/**
 * Create a runtime error.
 */
export const runtimeError = ({
  message,
  cause,
}: {
  message: string
  cause?: unknown
}): RuntimeError => ({
  _tag: 'CommandError.Runtime',
  message,
  ...(cause !== undefined ? { cause } : {}),
})

/**
 * Create a cancelled error.
 */
export const cancelledError = (reason: 'user' | 'timeout' | 'signal'): CancelledError => ({
  _tag: 'CommandError.Cancelled',
  reason,
})

// =============================================================================
// Error Output Utilities
// =============================================================================

/**
 * Output an error as JSON to stdout.
 * Used in JSON mode to maintain modal consistency.
 *
 * Written synchronously after loading the Node-only writer: this path runs on
 * the failure exit, where `runMain` calls `process.exit(1)` and would otherwise
 * drop buffered stdout bytes.
 */
export const outputJsonError = (error: CommandError): Effect.Effect<void> =>
  Schema.encodeEffect(Schema.fromJsonString(CommandError))(error).pipe(
    Effect.flatMap((jsonString) =>
      Effect.promise(async () => {
        const stdout = await import('./stdout.node.ts')
        stdout.writeStdoutLineSync(jsonString)
      }),
    ),
    Effect.orDie, // Schema encoding of our own types should never fail
  )

/**
 * Convert any error to a CommandError.
 */
export const toCommandError = (error: unknown): CommandError => {
  if (error instanceof Error === true) {
    return runtimeError({ message: error.message, cause: error.cause })
  }
  if (typeof error === 'string') {
    return runtimeError({ message: error })
  }
  if (typeof error === 'object' && error !== null && '_tag' in error) {
    // Already a tagged error
    const tagged = error as { _tag: string; message?: string }
    if (tagged._tag.startsWith('CommandError.') === true) {
      return error as CommandError
    }
    return runtimeError({ message: tagged.message ?? String(error), cause: error })
  }
  return runtimeError({ message: String(error) })
}

/**
 * Wrap an effect to handle errors in JSON mode.
 *
 * In JSON mode, catches errors and outputs them as JSON objects.
 * In visual mode, lets errors propagate normally.
 *
 * @example
 * ```typescript
 * runDeploy(services).pipe(
 *   withJsonErrors,
 *   Effect.provide(outputModeLayer)
 * )
 * ```
 */
export const withJsonErrors = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A | void, E, R | OutputModeTag> =>
  Effect.gen(function* () {
    const mode = yield* OutputModeTag

    if (isJson(mode) === true) {
      // In JSON mode, catch errors and output as JSON
      const result = yield* effect.pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* outputJsonError(toCommandError(error))
            return undefined as unknown as A
          }),
        ),
      )
      return result
    }

    // In visual mode, let errors propagate normally
    return yield* effect
  })

/**
 * Run an effect and ensure errors are output as JSON in JSON mode.
 *
 * This is a convenience wrapper that:
 * 1. Checks the output mode
 * 2. If JSON mode, catches any error and outputs as JSON
 * 3. If visual mode, lets errors propagate normally
 */
export const runWithJsonErrors = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A | void, never, R | OutputModeTag> =>
  effect.pipe(
    withJsonErrors,
    Effect.catch((error) =>
      Effect.gen(function* () {
        const mode = yield* OutputModeTag
        if (isJson(mode) === true) {
          yield* outputJsonError(toCommandError(error))
          return undefined as unknown as A
        }
        // Re-throw in visual mode (shouldn't happen due to withJsonErrors)
        return yield* Effect.die(error)
      }),
    ),
  )
