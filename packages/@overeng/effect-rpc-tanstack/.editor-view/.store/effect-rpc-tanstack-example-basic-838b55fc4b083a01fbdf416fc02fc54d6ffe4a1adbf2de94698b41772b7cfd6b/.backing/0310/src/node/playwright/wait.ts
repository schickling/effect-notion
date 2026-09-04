/**
 * Generic "poll until ready" helpers for Playwright tests.
 *
 * Prefer these over `while` loops with `page.waitForTimeout()`:
 * - easier to reason about timeouts and retry conditions
 * - spans/attributes for observability
 * - avoids accidental `await` chains spread across test logic
 *
 * @module
 */

import { type Duration, Effect, Schedule, Schema } from 'effect'

import {
  OtelSpan,
  type OtelAttrEncodeError,
  type OtelOperationDefinition,
} from '@overeng/otel-contract'

import { PwWaitAttemptAttrs, PwWaitOperation as PwWaitContract } from './pw.contract.ts'

/** Error thrown when a polling wait operation times out */
export class PwWaitTimeoutError extends Schema.TaggedError<PwWaitTimeoutError>()(
  'PwWaitTimeoutError',
  {
    label: Schema.String,
    timeout: Schema.String,
  },
) {}

// Runtime span DERIVED from the registered seam contract (`./pw.contract.ts`, namespace `pw`).
const PwWaitOperation = PwWaitContract.operation

const trustOtelContract = <A, E, R>(
  effect: Effect.Effect<A, E | OtelAttrEncodeError, R>,
): Effect.Effect<A, E, R> =>
  effect.pipe(Effect.catchTag('OtelAttrEncodeError', (error) => Effect.die(error)))

const trustedWith =
  <S extends Schema.Codec<any>>({
    operation,
    attributes,
  }: {
    operation: OtelOperationDefinition<S>
    attributes: Schema.Schema.Type<S>
  }) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    trustOtelContract<A, E, R>(operation.with({ attributes, effect }))

const annotateWaitAttempt = (attempt: number) =>
  OtelSpan.annotate({ attributes: PwWaitAttemptAttrs, value: { attempt } }).pipe(Effect.orDie)

const hasTag = (error: unknown): error is { _tag: string } => {
  if (typeof error !== 'object' || error === null) return false
  return typeof (error as Record<string, unknown>)._tag === 'string'
}

const errorTag = (error: unknown) => (hasTag(error) === true ? error._tag : undefined)

const errorType = (error: unknown) => {
  if (typeof error === 'object' && error !== null) {
    return (error as { constructor?: { name?: string } }).constructor?.name ?? 'Object'
  }
  return typeof error
}

/**
 * Repeatedly runs `check` until it succeeds, retrying while `while` returns true.
 *
 * The typical pattern is: have `check` fail with a small tagged error (e.g. `{ _tag: 'NotReady' }`)
 * to indicate "keep waiting" and return success when the desired condition is met.
 */
export const until = <TResult, TError, TContext>(args: {
  /** Span/trace label for this polling loop (use a stable identifier). */
  label: string
  /** Effect to evaluate; should succeed when ready and fail with a retryable error when not ready. */
  check: Effect.Effect<TResult, TError, TContext>
  /** Delay between retry attempts. */
  pollInterval: Duration.Input
  /** Maximum time to wait before failing with `PwWaitTimeoutError`. */
  timeout: Duration.Input
  /** Predicate that decides whether to retry for a given error value. */
  while: (error: TError) => boolean
}): Effect.Effect<TResult, TError | PwWaitTimeoutError, TContext> => {
  const { label, check, pollInterval, timeout, while: while_ } = args

  return Effect.gen(function* () {
    let attempt = 0

    const checkWithTelemetry = Effect.gen(function* () {
      attempt += 1
      yield* annotateWaitAttempt(attempt)
      return yield* check
    }).pipe(
      Effect.tapError((error) =>
        Effect.logDebug('pw.wait.retry', {
          'pw.wait.label': label,
          'pw.wait.attempt': attempt,
          'pw.wait.error.tag': errorTag(error as unknown) ?? '',
          'pw.wait.error.type': errorType(error as unknown),
        }),
      ),
    )

    return yield* checkWithTelemetry.pipe(
      Effect.retry({ schedule: Schedule.spaced(pollInterval), while: while_ }),
      // v4 `Effect.timeout` fails with the typed `Cause.TimeoutError`; translate
      // it into the Playwright-specific wait-timeout error.
      Effect.timeout(timeout),
      Effect.catchTag('TimeoutError', () =>
        Effect.fail(new PwWaitTimeoutError({ label, timeout: String(timeout) })),
      ),
    )
  }).pipe(
    trustedWith({
      operation: PwWaitOperation,
      attributes: {
        label,
        waitLabel: label,
        pollInterval: String(pollInterval),
        timeout: String(timeout),
      },
    }),
  )
}
