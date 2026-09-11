/**
 * Integration stress-tests for the self-reschedule surface (#4, decision 0012)
 * against a real native `restate-server` via the `./testing` harness:
 *
 *  - `RestateScheduled.make` (`Restate.pollLoop`) — the narrow durable
 *    recurring-loop primitive: basic recurrence as a chain of BOUNDED self-sends
 *    (journal does not grow with cycle count), `maxIterations` / data-driven stop,
 *    external stop→restart, generation-token idempotency (a duplicate `start`
 *    never produces overlapping chains), and the `skipToNext` / `stopLoop` error
 *    policies.
 *  - `Restate.reschedule` — the building block, driving the hand-rolled
 *    `RawWatcherObj` from the example.
 *
 * These productize the spike stress runs (`tmp/restate-spike-reschedule-{a,b}`).
 * Waits POLL the observable status/State (durable timer actually fired) rather
 * than fixed sleeps. Gracefully skips without a native `restate-server`.
 */
import { Effect, Layer, Schema } from 'effect'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { NotionWatcher, RawWatcherObj, RawWatcherLive } from '../../examples/12-self-reschedule.ts'
import { Restate, RestateObject, RestateScheduled, State } from '../mod.ts'
import {
  liveSleep as liveSleepEff,
  type RestateTestHarnessService,
  serverAvailable,
  withRestateServer,
} from '../testing/testing.ts'

/* ── test watchers (distinct names so they coexist on one deployment) ─────── */

const CounterState = { n: Schema.Finite } as const
const C = State.for(CounterState)

/* A read-only probe contract over the DOMAIN state. A scheduled watcher's domain
 * cursor lives in the SAME Object state map as the control plane, but under a
 * different `State.for` block; the primitive's contract only declares the control
 * plane. This same-named contract lets `harness.stateOf` read the domain `n` key
 * to assert exactly-once (cursor == iteration). */
const DomainProbe = (name: string) =>
  RestateObject.contract({
    name,
    def: {
      state: CounterState,
      handlers: { noop: { input: Schema.Void, success: Schema.Void, shared: true } },
    },
  })
const BasicDomain = DomainProbe('sched-basic')

/* A plain recurring watcher: each cycle bumps a journaled counter. */
const Basic = RestateScheduled.make<typeof CounterState>({
  name: 'sched-basic',
  domainState: CounterState,
  schedule: RestateScheduled.Schedule.fixedDelay(60),
  cycle: ({ key }) =>
    Effect.gen(function* () {
      const n = (yield* C.get('n')) ?? 0
      yield* Restate.run({
        name: `work(${key}@${n})`,
        effect: Effect.succeed(n),
        options: { maxRetryAttempts: 1 },
      })
      yield* C.set({ key: 'n', value: n + 1 })
      return { stop: false }
    }),
})

/* maxIterations: exactly N cycles, then status `completed`. */
const Bounded = RestateScheduled.make<typeof CounterState>({
  name: 'sched-bounded',
  domainState: CounterState,
  schedule: RestateScheduled.Schedule.fixedDelay(40),
  maxIterations: 3,
  cycle: () =>
    Effect.gen(function* () {
      const n = (yield* C.get('n')) ?? 0
      yield* C.set({ key: 'n', value: n + 1 })
      return { stop: false }
    }),
})

/* Data-driven stop: the cycle returns `{ stop: true }` at iteration 2. */
const DataStop = RestateScheduled.make<typeof CounterState>({
  name: 'sched-data-stop',
  domainState: CounterState,
  schedule: RestateScheduled.Schedule.fixedDelay(40),
  cycle: ({ iteration }) => Effect.succeed(iteration >= 2 ? { stop: true } : { stop: false }),
})

/* skipToNext (default): the cycle's bounded `Restate.run` throws on iteration 1.
 * The give-up surfaces as a `RestateError` DEFECT (clean `E`), which the policy
 * catches and swallows; the loop keeps advancing past it. */
const Skip = RestateScheduled.make<typeof CounterState>({
  name: 'sched-skip',
  domainState: CounterState,
  schedule: RestateScheduled.Schedule.fixedDelay(40),
  onCycleError: RestateScheduled.OnCycleError.skipToNext(),
  cycle: ({ iteration }) =>
    Effect.gen(function* () {
      yield* Restate.run({
        name: `skip-poll@${iteration}`,
        effect: Effect.sync(() => {
          if (iteration === 1) throw new Error('transient blip at iteration 1')
          return 0
        }),
        options: { maxRetryAttempts: 1 },
      })
      return { stop: false }
    }),
})

/* stopLoop: the first failing cycle stops the whole loop (status `failed`). */
const StopOnError = RestateScheduled.make<typeof CounterState>({
  name: 'sched-stop',
  domainState: CounterState,
  schedule: RestateScheduled.Schedule.fixedDelay(40),
  onCycleError: RestateScheduled.OnCycleError.stopLoop(),
  cycle: ({ iteration }) =>
    Effect.gen(function* () {
      yield* Restate.run({
        name: `stop-poll@${iteration}`,
        effect: Effect.sync(() => {
          if (iteration === 2) throw new Error('fatal at iteration 2')
          return 0
        }),
        options: { maxRetryAttempts: 1 },
      })
      return { stop: false }
    }),
})

/* OPTIONAL domainState (#2): the cursor is a NULLABLE `highWatermark`
 * (`Schema.optional`) — the `notion-datasource-sync` shape. The cycle advances it
 * for two cycles, then CLEARS it (`set(undefined)`) and stops, proving the shared
 * optional-State handling reaches `domainState`. */
const OptionalState = {
  highWatermark: Schema.optional(Schema.Finite),
} as const
const Opt = State.for(OptionalState)
const OptionalDomain = RestateObject.contract({
  name: 'sched-optional',
  def: {
    state: OptionalState,
    handlers: { noop: { input: Schema.Void, success: Schema.Void, shared: true } },
  },
})
const Optional = RestateScheduled.make<typeof OptionalState>({
  name: 'sched-optional',
  domainState: OptionalState,
  schedule: RestateScheduled.Schedule.fixedDelay(40),
  cycle: ({ iteration }) =>
    Effect.gen(function* () {
      /* An ABSENT optional cursor reads back as `undefined`. */
      const hw = yield* Opt.get('highWatermark')
      if (iteration >= 2) {
        /* Clear the nullable cursor (write `undefined` ≡ remove the key) and stop. */
        yield* Opt.set({ key: 'highWatermark', value: undefined })
        return { stop: true }
      }
      yield* Opt.set({ key: 'highWatermark', value: (hw ?? 0) + 10 })
      return { stop: false }
    }),
})

const services = [
  Basic.implementation,
  Bounded.implementation,
  DataStop.implementation,
  Skip.implementation,
  StopOnError.implementation,
  Optional.implementation,
  NotionWatcher.implementation,
  RawWatcherLive,
]

/* ── shared harness (one native server, held across the suite) ────────────── */

const held = withRestateServer({ services, appLayer: Layer.empty })
const harness = (): RestateTestHarnessService => held.harness()

beforeAll(held.setup, 90_000)
afterAll(held.teardown, 90_000)

/* ── helpers ──────────────────────────────────────────────────────────────── */

const live = <A, E>(eff: Effect.Effect<A, E, never>): Promise<A> =>
  Effect.runPromise(eff as Effect.Effect<A, never, never>)

/* A REAL-time sleep (the harness live-clock util), so the wall-clock waits this
 * suite uses to coordinate with the real server actually elapse. */
const liveSleep = (ms: number): Promise<void> => live(liveSleepEff(ms))

type Status = { readonly status: string; readonly iteration: number; readonly lastError?: string }

const statusOf = (scheduled: { readonly contract: any }, key: string): Promise<Status> =>
  live(
    harness().ingress.objectCall({
      contract: scheduled.contract,
      key,
      method: 'status',
      input: undefined,
    }),
  ) as Promise<Status>

const start = (scheduled: { readonly contract: any }, key: string): Promise<unknown> =>
  live(
    harness().ingress.objectCall({
      contract: scheduled.contract,
      key,
      method: 'start',
      input: undefined,
    }),
  )
const stop = (scheduled: { readonly contract: any }, key: string): Promise<unknown> =>
  live(
    harness().ingress.objectCall({
      contract: scheduled.contract,
      key,
      method: 'stop',
      input: undefined,
    }),
  )

const waitUntil = async (
  scheduled: { readonly contract: any },
  key: string,
  predicate: (s: Status) => boolean,
  timeoutMs = 12_000,
): Promise<Status> => {
  const deadline = Date.now() + timeoutMs
  let last = await statusOf(scheduled, key)
  while (predicate(last) === false && Date.now() < deadline) {
    await liveSleep(60)
    last = await statusOf(scheduled, key)
  }
  return last
}

/* ════════════════════════════════════════════════════════════════════════ */

describe.skipIf(!serverAvailable)('self-reschedule (pollLoop + reschedule)', () => {
  it('basic recurrence: a chain of bounded self-sends advances; stop halts it', async () => {
    const key = 'basic-1'
    await start(Basic, key)
    const s = await waitUntil(Basic, key, (st) => st.iteration >= 4)
    expect(s.iteration).toBeGreaterThanOrEqual(4)
    expect(s.status).toBe('running')
    await stop(Basic, key)
    const stopped = await waitUntil(Basic, key, (st) => st.status === 'stopped')
    expect(stopped.status).toBe('stopped')
    /* After stop the chain is dead: iteration stabilizes. */
    const a = stopped.iteration
    await liveSleep(400)
    expect((await statusOf(Basic, key)).iteration).toBe(a)
    /* Exactly-once, checked at QUIESCENCE. The control-plane `iteration` is bumped
     * (Scheduled.ts) BEFORE the cycle body bumps the domain `n`, so while the loop
     * RUNS the two counters are a moving target and lead/lag each other by up to one
     * cycle. The `iteration === n` invariant (no cycle ran twice or was skipped) is
     * only well-defined once the loop is QUIESCENT: after stop the in-flight cycle
     * completes under the per-key write lock and the next armed send no-ops, so both
     * counters are FROZEN and equal. Reading `n` here (against the stabilized
     * `iteration` `a`) makes the comparison atomic — sampling both mid-flight against
     * a still-advancing loop is an inherently racy invariant and was the source of an
     * intermittent `n !== iteration` flake under CPU contention. */
    expect((await live(harness().stateOf({ contract: BasicDomain, key }).get('n'))) ?? 0).toBe(a)
  }, 40_000)

  it('maxIterations: runs exactly N cycles, then completed', async () => {
    const key = 'bounded-1'
    await start(Bounded, key)
    const s = await waitUntil(Bounded, key, (st) => st.status === 'completed')
    expect(s.status).toBe('completed')
    expect(s.iteration).toBe(3)
  }, 40_000)

  it('data-driven stop: cycle returns { stop: true } → completed', async () => {
    const key = 'data-1'
    await start(DataStop, key)
    const s = await waitUntil(DataStop, key, (st) => st.status === 'completed')
    expect(s.status).toBe('completed')
    /* iterations 0,1 continue; iteration 2 returns stop:true → 3 cycles attempted. */
    expect(s.iteration).toBe(3)
  }, 40_000)

  it('optional domainState: a nullable cursor advances then clears (set undefined) (#2)', async () => {
    const key = 'opt-1'
    /* The cursor is ABSENT before the first cycle reads it. */
    expect(
      await live(harness().stateOf({ contract: OptionalDomain, key }).get('highWatermark')),
    ).toBeUndefined()
    await start(Optional, key)
    /* Iterations 0,1 set the nullable cursor (10, 20); iteration 2 CLEARS it
     * (`set(undefined)` ≡ remove the key) and stops. */
    const s = await waitUntil(Optional, key, (st) => st.status === 'completed')
    expect(s.status).toBe('completed')
    /* After the clearing cycle the optional key is ABSENT again (`undefined`). */
    expect(
      await live(harness().stateOf({ contract: OptionalDomain, key }).get('highWatermark')),
    ).toBeUndefined()
  }, 40_000)

  it('stop then restart resumes the chain (generation re-arm)', async () => {
    const key = 'restart-1'
    await start(Basic, key)
    await waitUntil(Basic, key, (st) => st.iteration >= 2)
    await stop(Basic, key)
    const stopped = await waitUntil(Basic, key, (st) => st.status === 'stopped')
    expect(stopped.status).toBe('stopped')
    /* Restart: start resets the counter to 0 and re-arms under a NEW generation —
     * the stale pre-stop re-arm (old generation) no-ops when it lands. */
    await start(Basic, key)
    const resumed = await waitUntil(
      Basic,
      key,
      (st) => st.status === 'running' && st.iteration >= 2,
    )
    expect(resumed.status).toBe('running')
    expect(resumed.iteration).toBeGreaterThanOrEqual(2)
    await stop(Basic, key)
  }, 40_000)

  it('generation idempotency: a duplicate start never overlaps the chain', async () => {
    const key = 'dup-1'
    const readN = (): Promise<number> =>
      live(harness().stateOf({ contract: BasicDomain, key }).get('n')).then((v) => v ?? 0)
    await start(Basic, key)
    await waitUntil(Basic, key, (st) => st.iteration >= 2)
    /* A duplicate start bumps the generation and re-arms; the per-key write lock +
     * the generation guard mean the two chains never run concurrently. `start`
     * re-bases the control-plane `iteration` to 0 (the domain cursor `n` keeps
     * climbing — the user owns it), so the overlap proof is that AFTER the
     * duplicate, the domain `n` advances by EXACTLY the same amount as the
     * control-plane `iteration` (one cycle = one n-bump = one iteration). An
     * overlapping stale chain would bump `n` faster than `iteration`. */
    await start(Basic, key)
    const afterDup = await waitUntil(Basic, key, (st) => st.iteration >= 1)
    const nAfterDup = await readN()
    const later = await waitUntil(Basic, key, (st) => st.iteration >= afterDup.iteration + 3)
    const nLater = await readN()
    await stop(Basic, key)
    /* Single-chain rate: the per-cycle n-delta tracks the iteration-delta within a
     * 1-cycle sampling skew (the two endpoint reads aren't perfectly simultaneous).
     * An overlapping stale chain would roughly DOUBLE the n-rate, far exceeding 1. */
    const nDelta = nLater - nAfterDup
    const iterDelta = later.iteration - afterDup.iteration
    expect(iterDelta).toBeGreaterThanOrEqual(3)
    expect(Math.abs(nDelta - iterDelta)).toBeLessThanOrEqual(1)
  }, 40_000)

  it('skipToNext: a failing cycle is swallowed and the loop continues', async () => {
    const key = 'skip-1'
    await start(Skip, key)
    /* The loop must get PAST iteration 1 (which fails) and keep climbing. */
    const s = await waitUntil(Skip, key, (st) => st.iteration >= 4)
    expect(s.iteration).toBeGreaterThanOrEqual(4)
    expect(s.status).toBe('running')
    await stop(Skip, key)
  }, 40_000)

  it('stopLoop: a failing cycle stops the whole loop (status failed)', async () => {
    const key = 'stop-1'
    await start(StopOnError, key)
    const s = await waitUntil(StopOnError, key, (st) => st.status === 'failed')
    expect(s.status).toBe('failed')
    expect(s.lastError).toContain('fatal at iteration 2')
    /* It stopped AT iteration 2 (cycles 0,1 advanced, cycle 2 failed). */
    expect(s.iteration).toBe(3)
  }, 40_000)

  it('example NotionWatcher: the README headline polls to a data-driven stop', async () => {
    /* Drives the EXACT exported example so the README snippet is CI-verified. The
     * default stub source reports `done` at cursor >= 4 → the loop ends cleanly. */
    const key = 'notion-1'
    await live(
      harness().ingress.objectCall({
        contract: NotionWatcher.contract,
        key,
        method: 'start',
        input: undefined,
      }),
    )
    const s = await waitUntil(NotionWatcher, key, (st) => st.status === 'completed')
    expect(s.status).toBe('completed')
    expect(s.iteration).toBeGreaterThanOrEqual(5)
  }, 40_000)

  it('reschedule building block: the hand-rolled RawWatcher loops and stops', async () => {
    const key = 'raw-1'
    const read = (): Promise<{ running: boolean; cursor: number }> =>
      live(
        harness().ingress.objectCall({
          contract: RawWatcherObj,
          key,
          method: 'read',
          input: undefined,
        }),
      ) as Promise<{
        running: boolean
        cursor: number
      }>
    await live(
      harness().ingress.objectCall({
        contract: RawWatcherObj,
        key,
        method: 'start',
        input: undefined,
      }),
    )
    const deadline = Date.now() + 12_000
    let snap = await read()
    while (snap.cursor < 4 && Date.now() < deadline) {
      await liveSleep(80)
      snap = await read()
    }
    expect(snap.cursor).toBeGreaterThanOrEqual(4)
    expect(snap.running).toBe(true)
    await live(
      harness().ingress.objectCall({
        contract: RawWatcherObj,
        key,
        method: 'stop',
        input: undefined,
      }),
    )
    await liveSleep(500)
    const after = await read()
    expect(after.running).toBe(false)
    /* After stop the chain is dead: cursor stabilizes. */
    const c = after.cursor
    await liveSleep(400)
    expect((await read()).cursor).toBe(c)
  }, 40_000)
})
