/**
 * Consumer-style integration test for the `./testing` harness (decision 0009,
 * docs/vrs/09-testing/spec.md). Drives a small Virtual Object + its `appLayer` entirely THROUGH
 * `RestateTestHarness.layer` — proving the productized harness end-to-end:
 *
 * - the scoped Layer boots a native server, threads the consumer `appLayer` into
 *   the served runtime, and exposes a typed `ingress` + `stateOf`;
 * - `stateOf` SEEDS State (a pre-condition) that a handler then reads back, and
 *   ASSERTS State a handler wrote (a post-condition) — both typed against the
 *   contract's `state` block, without going through a handler;
 * - an `alwaysReplay` run is replay-stable (the journaled handler yields the same
 *   result when every suspension forces a replay, R26a).
 *
 * Gracefully skips when no native `restate-server` binary is available
 * (`serverAvailable`) — e.g. outside the dedicated integration job.
 */
import { it } from '@effect/vitest'
import { Context, Effect, Layer, Schema } from 'effect'
import { describe, expect } from 'vitest'

import { Restate, RestateObject, State } from '../mod.ts'
import { RestateTestHarness, serverAvailable } from './testing.ts'

/* ── demo app: an injected Effect service + a counter Virtual Object ── */

/* A trivial application service the handler depends on, to prove `appLayer` is
 * threaded into the served runtime (handler `R` is satisfied). */
class Step extends Context.Service<Step, { readonly by: number }>()('test/Step') {
  static readonly Default = Layer.succeed(Step, { by: 1 })
}

const CounterState = { count: Schema.Finite } as const
const Counter = State.for(CounterState)

const CounterObj = RestateObject.contract({
  name: 'harness-counter',
  def: {
    state: CounterState,
    handlers: {
      /* Exclusive: read-modify-write typed `count` by the injected `Step.by`, with a
       * journaled `Restate.run` step so `alwaysReplay` exercises a real suspension. */
      bump: { input: Schema.Void, success: Schema.Finite },
      /* Shared (read-only): reads the typed `count` back. */
      read: { input: Schema.Void, success: Schema.Finite, shared: true },
    },
  },
})

const CounterLive = RestateObject.implement<typeof CounterObj, Step>({
  contractValue: CounterObj,
  impl: {
    bump: () =>
      Effect.gen(function* () {
        const by = (yield* Step).by
        /* A journaled durable step (replay-stable across `alwaysReplay`). */
        const delta = yield* Restate.run({ name: 'delta', effect: Effect.succeed(by) }).pipe(
          Effect.orDie,
        )
        const current = (yield* Counter.get('count')) ?? 0
        const next = current + delta
        yield* Counter.set({ key: 'count', value: next })
        return next
      }).pipe(Effect.orDie),
    read: () =>
      Counter.get('count').pipe(
        Effect.map((c) => c ?? 0),
        Effect.orDie,
      ),
  },
})

const HarnessLayer = RestateTestHarness.layer({
  services: [CounterLive],
  appLayer: Step.Default,
  /* Surface failures immediately instead of through retry backoff. */
  disableRetries: true,
})

const HarnessReplayLayer = RestateTestHarness.layer({
  services: [CounterLive],
  appLayer: Step.Default,
  /* Force replay at every suspension to hunt non-determinism (R26a). */
  alwaysReplay: true,
  disableRetries: true,
})

describe.skipIf(!serverAvailable)('restate-effect ./testing harness', () => {
  it.layer(HarnessLayer, { timeout: 60_000 })('typed ingress + stateOf', (it) => {
    it.effect('bump reads the seeded State and writes it back (stateOf round-trip)', () =>
      Effect.gen(function* () {
        const harness = yield* RestateTestHarness
        const state = harness.stateOf({ contract: CounterObj, key: 'cart-1' })

        /* SEED a pre-condition via stateOf (typed against `state.count`). */
        yield* state.set({ key: 'count', value: 40 })
        expect(yield* state.get('count')).toBe(40)

        /* The handler reads the seeded State, adds Step.by (=1), writes it back. */
        const bumped = yield* harness.ingress.objectCall({
          contract: CounterObj,
          key: 'cart-1',
          method: 'bump',
          input: undefined,
        })
        expect(bumped).toBe(41)

        /* ASSERT the post-condition via both the shared handler and stateOf. */
        const read = yield* harness.ingress.objectCall({
          contract: CounterObj,
          key: 'cart-1',
          method: 'read',
          input: undefined,
        })
        expect(read).toBe(41)
        expect(yield* state.get('count')).toBe(41)
      }),
    )

    it.effect('stateOf getAll reflects the full key set', () =>
      Effect.gen(function* () {
        const harness = yield* RestateTestHarness
        const state = harness.stateOf({ contract: CounterObj, key: 'cart-2' })
        yield* state.setAll({ count: 7 })
        expect(yield* state.getAll).toEqual({ count: 7 })
      }),
    )

    it.effect('two keys are isolated', () =>
      Effect.gen(function* () {
        const harness = yield* RestateTestHarness
        yield* harness
          .stateOf({ contract: CounterObj, key: 'key-x' })
          .set({ key: 'count', value: 100 })
        yield* harness.ingress.objectCall({
          contract: CounterObj,
          key: 'key-y',
          method: 'bump',
          input: undefined,
        })
        expect(yield* harness.stateOf({ contract: CounterObj, key: 'key-x' }).get('count')).toBe(
          100,
        )
        expect(yield* harness.stateOf({ contract: CounterObj, key: 'key-y' }).get('count')).toBe(1)
      }),
    )
  })

  it.layer(HarnessReplayLayer, { timeout: 60_000 })('alwaysReplay determinism', (it) => {
    it.effect('repeated bumps are replay-stable under alwaysReplay', () =>
      Effect.gen(function* () {
        const harness = yield* RestateTestHarness
        const state = harness.stateOf({ contract: CounterObj, key: 'replay-1' })
        yield* state.set({ key: 'count', value: 0 })
        /* Each bump adds Step.by (=1); under alwaysReplay every suspension forces
         * a replay, so the journaled `Restate.run` step + State read must stay
         * stable. A non-deterministic handler would diverge / wedge here. */
        const first = yield* harness.ingress.objectCall({
          contract: CounterObj,
          key: 'replay-1',
          method: 'bump',
          input: undefined,
        })
        const second = yield* harness.ingress.objectCall({
          contract: CounterObj,
          key: 'replay-1',
          method: 'bump',
          input: undefined,
        })
        expect(first).toBe(1)
        expect(second).toBe(2)
        expect(yield* state.get('count')).toBe(2)
      }),
    )
  })
})
