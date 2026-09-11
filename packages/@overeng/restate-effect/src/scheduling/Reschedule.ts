/**
 * `Restate.reschedule` — the typed durable self-send building block (decision
 * 0012, #4). The idiomatic Restate daemon is a chain of DELAYED SELF-SENDS, not a
 * held-open `for(;;){ poll(); sleep() }`: each invocation does one bounded unit of
 * work, re-arms itself via a delayed self-send, and RETURNS — so each invocation
 * completes with a BOUNDED journal (the journal does not grow with the number of
 * cycles). This is the load-bearing primitive behind {@link RestateScheduled}; it
 * is also exposed directly for hand-rolled durable loops.
 *
 * `reschedule` is a thin, typed wrapper over the package's in-handler object send
 * (`Restate.objectSendClient` = `ctx.objectSendClient(...).handler(...)` with a
 * `key` + `delay`) that re-arms the CURRENT Virtual Object by reading its own key
 * (`Restate.key`) and issuing a delayed send to one of its own handlers.
 *
 * The SDK has no runtime self-reflection ("what contract am I?"), so the author
 * passes the SAME `contract` the handler is implemented against (the lexical
 * `self`). The send targets `Restate.key` — the current invocation's key — so the
 * re-arm stays on the SAME single-writer instance.
 */
import { Effect } from 'effect'

import { objectKey } from '../authoring/RestateContext.ts'
import type { ObjectKey, RestateContext } from '../authoring/RestateContext.ts'
import type { ObjectContract, ObjectInputOf, ObjectMethodsOf } from '../authoring/Service.ts'
import { sendObject } from '../clients/Client.ts'
import { withRestateOperation } from '../observability/effect.ts'
import type { RestateError } from '../schema/RestateError.ts'

/**
 * Re-arm the CURRENT Virtual Object by a delayed self-send of one of its own
 * handlers.
 *
 * `contract` is the SAME contract the handler is implemented against (the lexical
 * `self` — the SDK has no runtime self-reflection, so the author passes it).
 * `method` is the handler to re-arm (usually the loop's `cycle`), `input` its
 * typed input, and `delayMillis` the durable delay before delivery. Reads
 * `Restate.key`, so the send targets the current key — the same single-writer
 * instance.
 *
 * Returns immediately after ENQUEUING the durable delayed send (it does NOT await
 * the next cycle). The send is journaled, so a replay of THIS invocation does not
 * double-send — the re-arm is idempotent under replay (verified by the
 * `Scheduled.integration.test.ts` overlap/idempotency scenarios). For durability,
 * a re-arm journaled BEFORE a later (possibly failing) step is still delivered
 * even if that step fails the invocation — so re-arm BEFORE fallible work to keep
 * a hand-rolled loop alive across a failing cycle (the ordering {@link
 * RestateScheduled} bakes in).
 *
 * Capability-gated: requires `ObjectKey` (so it cannot be issued from a Service —
 * a Service has no key) and `RestateContext`.
 */
export const reschedule = <
  C extends ObjectContract<string, any, any>,
  M extends ObjectMethodsOf<C>,
>(opts: {
  readonly contract: C
  readonly method: M
  readonly input: ObjectInputOf<C, M>
  readonly delayMillis: number
}): Effect.Effect<void, RestateError, ObjectKey | RestateContext> =>
  Effect.gen(function* () {
    const key = yield* objectKey
    yield* sendObject({
      contract: opts.contract,
      key,
      method: opts.method,
      input: opts.input,
      opts: { delayMillis: opts.delayMillis },
    })
  }).pipe(withRestateOperation({ name: 'restate.reschedule', label: opts.method }))
