/**
 * Cancellation ↔ interruption integration test against a real native
 * `restate-server` (R31, decision 0003, docs/vrs/04-error-boundary/spec.md §2).
 *
 * Proves the cancel→interrupt boundary end-to-end: a keyed Object handler that
 * suspends on a long durable `Restate.sleep`, guarded by an `acquireRelease`
 * finalizer. The test `send`s the handler (getting its invocation id), waits for
 * the handler to acquire its resource, cancels the invocation via the admin API
 * (`PATCH /invocations/{id}/cancel`), and asserts:
 *
 * - the `acquireRelease` RELEASE finalizer ran (the Restate cancellation surfaced
 *   as an Effect interruption at the suspend point — `onInterrupt`/`acquireRelease`
 *   fire, R31), and
 * - the handler did NOT silently retry (the bridge interrupts the fiber and
 *   `toTerminal` maps the interruption to a `CancelledError`, not a retry).
 *
 * The endpoint runs in-process, so the finalizer's observable side effect is a
 * module-level shared map keyed by the Object key.
 */
import { Deferred, Effect, Layer, Schema } from 'effect'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { objectSend, Restate, RestateIngress, RestateObject } from '../mod.ts'
import { serverAvailable, withRestateServer } from '../testing/testing.ts'

/* ── shared observable: per-key lifecycle the in-process finalizer records ── */

interface Lifecycle {
  acquired: number
  released: number
  /** how many distinct handler attempts ran (to detect a silent retry) */
  attempts: number
}

const lifecycle = new Map<string, Lifecycle>()
const acquireGate = new Map<string, Deferred.Deferred<void>>()

/* The handler never reached its acquire gate within the deadline — the test setup
 * raced the cancel ahead of the suspend point. A typed failure (not a global
 * `Error`) so the `timeoutFail` failure channel stays type-safe. */
class HandlerNeverAcquired extends Schema.TaggedError<HandlerNeverAcquired>()(
  'HandlerNeverAcquired',
  {},
) {}

const observe = (key: string): Lifecycle => {
  let l = lifecycle.get(key)
  if (l === undefined) {
    l = { acquired: 0, released: 0, attempts: 0 }
    lifecycle.set(key, l)
  }
  return l
}

const gateFor = (key: string): Deferred.Deferred<void> => {
  let g = acquireGate.get(key)
  if (g === undefined) {
    g = Deferred.makeUnsafe<void>()
    acquireGate.set(key, g)
  }
  return g
}

/* ── object with a long durable sleep guarded by an acquireRelease finalizer ── */

const Waiter = RestateObject.contract({
  name: 'canceller',
  def: {
    state: {},
    handlers: {
      /* Acquire a (fake) resource, suspend on a long durable timer, release on
       * interruption. A real Restate cancellation aborts the attempt → the bridge
       * interrupts this fiber at the durable-sleep suspend point → release runs. */
      wait: { input: Schema.Void, success: Schema.Void },
    },
  },
})

const WaiterLive = RestateObject.implement<typeof Waiter>({
  contractValue: Waiter,
  impl: {
    wait: () =>
      Effect.gen(function* () {
        const key = yield* Restate.key
        const l = observe(key)
        l.attempts += 1
        yield* Effect.acquireRelease(
          Effect.gen(function* () {
            l.acquired += 1
            yield* Deferred.succeed(gateFor(key), undefined)
          }),
          () => Effect.sync(() => void (l.released += 1)),
        )
        /* A long durable timer: the invocation suspends here until cancelled. */
        yield* Restate.sleep({ millis: 60_000, name: 'wait-timer' })
      }).pipe(Effect.scoped, Effect.orDie),
  },
})

/* ── admin cancel ── */

const cancelInvocation = async (adminUrl: string, invocationId: string): Promise<void> => {
  const res = await fetch(`${adminUrl}/invocations/${invocationId}/cancel`, { method: 'PATCH' })
  if (res.ok === false && res.status !== 202 && res.status !== 200) {
    const text = await res.text().catch(() => '')
    throw new Error(`cancel failed (${res.status}) for ${invocationId}: ${text}`)
  }
}

/* One held native server for the suite (collapses the copy-pasted scope/ingress
 * `beforeAll`). The standalone `objectSend` needs a `RestateIngress` layer built
 * from the booted ingress URL; the admin cancel uses the booted admin URL. */
const held = withRestateServer({ services: [WaiterLive], appLayer: Layer.empty })
const ingressLayer = (): Layer.Layer<RestateIngress> =>
  RestateIngress.layer({ url: held.harness().ingressUrl })

describe('restate-effect cancellation ↔ interruption', () => {
  beforeAll(held.setup, 60_000)
  afterAll(held.teardown, 60_000)

  it.skipIf(!serverAvailable)(
    'a cancelled invocation runs its acquireRelease finalizer and does not silently retry',
    async () => {
      const key = `cancel-${Date.now()}`

      /* Fire-and-forget the long handler; capture its invocation id. */
      const send = await Effect.runPromise(
        objectSend({ contract: Waiter, key, method: 'wait', input: undefined }).pipe(
          Effect.provide(ingressLayer()),
        ),
      )
      expect(send.invocationId).toMatch(/.+/)

      /* Wait until the handler has acquired its resource (so it is suspended on
       * the durable timer) before cancelling — otherwise we'd race the start. */
      await Effect.runPromise(
        Deferred.await(gateFor(key)).pipe(
          Effect.timeoutOrElse({
            duration: '30 seconds',
            orElse: () => Effect.fail(new HandlerNeverAcquired()),
          }),
        ),
      )
      expect(observe(key).acquired).toBe(1)

      /* Cancel via the admin API → Restate aborts the attempt → bridge interrupts
       * the fiber at the suspend point → acquireRelease release runs. */
      await cancelInvocation(held.harness().adminUrl, send.invocationId)

      /* Poll for the release finalizer (cancellation propagation is async). */
      const deadline = Date.now() + 30_000
      while (observe(key).released === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200))
      }

      const l = observe(key)
      /* The finalizer ran (interruption surfaced; R31). */
      expect(l.released).toBe(1)
      /* No silent retry: exactly one attempt acquired+released, never re-entered. */
      expect(l.acquired).toBe(1)
      expect(l.attempts).toBe(1)

      /* Give the server a moment; assert it STILL did not re-run the handler
       * (a mis-mapped interrupt would have been retried). */
      await new Promise((r) => setTimeout(r, 1_500))
      expect(observe(key).attempts).toBe(1)
    },
    90_000,
  )
})
