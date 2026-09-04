/**
 * Playwright step + Effect span integration.
 *
 * @module
 */

import { test } from '@playwright/test'
import { Effect, Exit, Function as F, Schema } from 'effect'

import {
  OtelAttr,
  OtelAttrs,
  OtelOperation,
  type OtelAttrEncodeError,
  type OtelOperationDefinition,
} from '@overeng/otel-contract'

import { PwStep, PwStepName, PwStepParentSpanTag } from './pw.contract.ts'

// DYNAMIC-NAME BRIDGE: the span name is the runtime step `name`, so it has no stable single-signal
// registry projection and stays legacy inline here — but its encoder is REBUILT from the `pw.step*`
// catalog schemas exported by the seam contract (they reach the catalog via docOnlyAttributes).
const pwStepAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: OtelAttr.drop(Schema.NonEmptyString),
    step: PwStep,
    stepName: PwStepName,
    parentSpanTag: Schema.optional(PwStepParentSpanTag),
  }),
)

const PwStepOperation = (name: string) =>
  OtelOperation.define({
    name,
    attributes: pwStepAttrs,
    label: ({ label }) => label,
  })

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

/**
 * Runs an Effect inside a Playwright `test.step(...)` boundary.
 *
 * Why this exists:
 * - Playwright `trace.zip` groups actions by `test.step`, which is very helpful for debugging.
 * - Our tests are Effect-native and already emit OTEL spans.
 * - This helper makes the step boundary show up in both the Playwright trace and OTEL, with a single call.
 *
 * Notes:
 * - This intentionally bridges to Playwright's promise API internally.
 * - The wrapped Effect is executed within the `test.step` callback so Playwright can attribute
 *   all Playwright actions to the step.
 */
export const step: {
  /**
   * Curried form, for `effect.pipe(Pw.Step.step('my-step'))`.
   */
  (name: string): <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  /**
   * Direct form, for `Pw.Step.step(effect, 'my-step')`.
   */
  <A, E, R>(self: Effect.Effect<A, E, R>, name: string): Effect.Effect<A, E, R>
} = F.dual(
  2,
  <A, E, R>(self: Effect.Effect<A, E, R>, name: string): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      const context = yield* Effect.context<R>()
      const parentSpan = yield* Effect.currentSpan.pipe(Effect.option)

      const run =
        parentSpan._tag === 'Some' ? self.pipe(Effect.withParentSpan(parentSpan.value)) : self
      const traced = run.pipe(
        trustedWith({
          operation: PwStepOperation(name),
          attributes: {
            label: name,
            step: true,
            stepName: name,
            ...(parentSpan._tag === 'Some' ? { parentSpanTag: parentSpan.value._tag } : {}),
          },
        }),
      )

      return yield* Effect.callback<A, E>((resume) => {
        void test
          .step(name, async () => {
            const exit = await Effect.runPromiseExit(traced.pipe(Effect.provide(context)))
            resume(
              Exit.match(exit, {
                onFailure: (cause) => Effect.failCause(cause),
                onSuccess: (value) => Effect.succeed(value),
              }),
            )
          })
          .catch((cause) => {
            resume(Effect.die(cause))
          })
        return Effect.void
      })
    }),
)
