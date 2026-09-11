/**
 * Type-level (typecheck-only, never executed) assertions mirroring the validated
 * prototype's `@ts-expect-error` cases against the REAL Phase 1 API:
 *
 * - `call` infers exact input/success/error from a contract (precise, not `any`).
 * - `State.set` in a Service handler is a TYPE error (no `StateWrite` provided).
 * - `Restate.run` SCRUBS durable caps from its inner effect (nested durable op
 *   inside `run` is a compile error).
 * - `Restate.all` rejects an arbitrary `Effect[]` (descriptors only).
 *
 * It is included by `tsconfig`'s `src/**` glob, so `tsc` checks it; it is not a
 * `*.test.ts`, so vitest never runs it.
 */

/**
 * Type-level negative assertions deliberately construct Effects that under-specify
 * required context/error to prove the API rejects them (each guarded by an adjacent
 * `@ts-expect-error`). The Effect LS flags those same constructs, so disable the two
 * relevant rules file-wide here — this is the LS's intended mechanism for type-level
 * assertion files (#811).
 * @effect-diagnostics missingEffectContext:skip-file missingEffectError:skip-file
 */
import { Effect, type Exit, Schema } from 'effect'

import { call, callTyped, objectCall, workflowSubmit } from '../clients/Client.ts'
import { DurablePromise, Restate, RestateObject, RestateWorkflow, State } from '../mod.ts'
import type { RestateError } from '../schema/RestateError.ts'
import { RestateService } from './Service.ts'

/* eslint-disable @typescript-eslint/no-unused-vars -- type-level assertions */

type Assert<T extends true> = T
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

/* ── contract → call inference ───────────────────────────────────────────── */

const GreetInput = Schema.Struct({ name: Schema.String })
const GreetSuccess = Schema.Struct({ message: Schema.String, id: Schema.String })
class EmptyName extends Schema.TaggedError<EmptyName>('test/EmptyName')('EmptyName', {}) {}

const Greeter = RestateService.contract({
  name: 'greeter',
  handlers: {
    greet: { input: GreetInput, success: GreetSuccess, error: EmptyName },
  },
})

const greetCall = call({ contract: Greeter, method: 'greet', input: { name: 'Sarah' } })
/* The success type is precise (not `any`). */
type _A1 = Assert<
  Equals<Effect.Success<typeof greetCall>, { readonly message: string; readonly id: string }>
>
/* `callTyped` lifts the contract's tagged error into the recoverable `E` channel
 * (alongside the wrapper `RestateError`). */
const greetTyped = callTyped({ contract: Greeter, method: 'greet', input: { name: '' } })
type _A2 = Assert<Equals<Effect.Error<typeof greetTyped>, RestateError | EmptyName>>

/* NEGATIVE: wrong input type. */
// @ts-expect-error — `name` must be a string, not a number
const _wrongInput = call({ contract: Greeter, method: 'greet', input: { name: 123 } })

/* NEGATIVE: unknown method. */
// @ts-expect-error — 'shout' is not a method of the greeter contract
const _unknownMethod = call({ contract: Greeter, method: 'shout', input: { name: 'x' } })

/* ── State.set in a Service handler is a type error ───────────────────────── */

const CounterState = { count: Schema.Finite }
const CounterStateApi = State.for(CounterState)

/* A Service handler is provided ONLY RestateContext — never StateWrite. So a
 * handler effect that requires StateWrite cannot satisfy `ServiceImpl`'s
 * `AppR | RestateContext` residual. */
const Counter = RestateService.contract({
  name: 'counter',
  handlers: {
    bump: { input: Schema.Void, success: Schema.Void },
  },
})

const _CounterBad = RestateService.implement<typeof Counter>({
  contractValue: Counter,
  impl: {
    // @ts-expect-error — State.set requires StateWrite, not provided to a Service handler
    bump: () => CounterStateApi.set({ key: 'count', value: 1 }),
  },
})

/* POSITIVE: a pure Service handler typechecks. */
const _CounterOk = RestateService.implement<typeof Counter>({
  contractValue: Counter,
  impl: {
    bump: () => Effect.void,
  },
})

/* ── Restate.run scrubs durable caps ──────────────────────────────────────── */

/* POSITIVE: a pure inner effect runs fine. */
const _runOk = Restate.run({ name: 'gen', effect: Effect.sync(() => crypto.randomUUID()) })

/* NEGATIVE: a nested durable State.get inside `run` — inner R has StateRead. */
// @ts-expect-error — durable capability (StateRead) is not allowed inside Restate.run
const _runNestedState = Restate.run({ name: 'bad', effect: CounterStateApi.get('count') })

/* NEGATIVE: a nested Restate.sleep inside `run` — inner R has RestateContext. */
// @ts-expect-error — durable capability (RestateContext) is not allowed inside Restate.run
const _runNestedSleep = Restate.run({ name: 'bad', effect: Restate.sleep({ millis: 1000 }) })

/* ── Restate.run has NO catchable typed failure (decision 0003, #1) ────────── */

/* NEGATIVE: a typed-`E` inner effect is rejected — a durable step carries no
 * catchable typed failure, so the inner must be `Effect<A, never, R>`. Domain
 * errors belong in the handler body / encoded as values; to force a durable retry,
 * DIE inside the step. */
// @ts-expect-error — a durable step has no typed failure channel; the inner effect's E must be `never`
const _runTypedFail = Restate.run({ name: 'bad', effect: Effect.fail(new EmptyName({})) })

/* POSITIVE: `run` erases the typed failure channel — the result `E` is `never`. */
const _runCleanE = Restate.run({ name: 'gen', effect: Effect.succeed(1) })
type _R1 = Assert<Equals<Effect.Error<typeof _runCleanE>, never>>

/* POSITIVE: `runExit` honestly OBSERVES the outcome as `Exit<A>` (failure channel
 * `never` — an observed failure is a defect/interrupt `Cause`, not a typed `E`). */
const _runExitObserve = Restate.runExit({ name: 'gen', effect: Effect.succeed('value') })
type _R2 = Assert<Equals<Effect.Success<typeof _runExitObserve>, Exit.Exit<string, never>>>
type _R3 = Assert<Equals<Effect.Error<typeof _runExitObserve>, never>>

/* ── determinism-hazard verification (stress-run round 2) ──────────────────── */
/*
 * Two claimed hazards from the stress run, verified here at the type level:
 *
 * (a) HAZARD — "a nested journaled op inside `Restate.run`". CONFIRMED prevented by
 *     the #1 run-scrubbing (`Exclude<R, DurableCaps>`, Core A): the two
 *     `@ts-expect-error` cases above (`_runNestedState`, `_runNestedSleep`) are
 *     COMPILE errors, so a nested `State.get` / `Restate.sleep` inside a `run`
 *     closure cannot be written. No new rule is needed — the type system is the
 *     guard (mirrors Restate's "no nested ctx.* inside run").
 *
 * (b) NON-HAZARD — "gate a `Restate.run` on a `State.get`". `State.get` is a
 *     journaled, deterministic read in the HANDLER BODY (not inside the closure);
 *     gating on it replays identically (the journal yields the same value), so it
 *     is the LEGITIMATE pattern, not a hazard. Confirmed legal below — no rule
 *     should flag it.
 */
const _gateRunOnStateGet = (
  CounterState2: ReturnType<typeof State.for<{ count: typeof Schema.Finite }>>,
) =>
  Effect.gen(function* () {
    /* Read journaled State in the handler body (StateRead — legal, deterministic). */
    const current = (yield* CounterState2.get('count')) ?? 0
    /* Gate a durable step on that journaled value: the captured `current` is a
     * plain number, so the `run` closure carries NO durable capability — legal,
     * and replay-stable because `current` came from the journal. */
    if (current > 0) {
      yield* Restate.run({ name: 'gated', effect: Effect.sync(() => current * 2) })
    }
  })

/* ── descriptor concurrency rejects opaque Effects ───────────────────────── */

/* POSITIVE: descriptor tuple → inferred result tuple. */
const _allOk: Effect.Effect<readonly [string, void], unknown, unknown> = Restate.all([
  Restate.runDescriptor({ name: 'a', action: () => 'x' }),
  Restate.sleepDescriptor({ millis: 10 }),
])

/* NEGATIVE: passing arbitrary Effects (not descriptors) is rejected. */
// @ts-expect-error — Restate.all takes Descriptor[], not Effect[]
const _allRejectsEffects = Restate.all([Effect.succeed(1), Effect.succeed('x')])

/* ── Phase 2: Object exclusive vs shared capability discharge (DQ3) ────────── */

const CounterObj = RestateObject.contract({
  name: 'counter',
  def: {
    state: { count: Schema.Finite },
    handlers: {
      add: { input: Schema.Finite, success: Schema.Finite }, // exclusive (default)
      get: { input: Schema.Void, success: Schema.Finite, shared: true }, // read-only
    },
  },
})
const CounterState2 = State.for({ count: Schema.Finite })

/* POSITIVE: an exclusive handler may write State; a shared handler may read it.
 * Both kinds live in one heterogeneous `implement` record and discharge per-kind.
 * Wrapper `RestateError`s are infra → `orDie` (the handler declares no domain error,
 * so its `E` is `never`; decision 0003). */
const _CounterObjOk = RestateObject.implement<typeof CounterObj>({
  contractValue: CounterObj,
  impl: {
    add: (n) =>
      Effect.gen(function* () {
        const cur = (yield* CounterState2.get('count')) ?? 0
        yield* CounterState2.set({ key: 'count', value: cur + n })
        return cur + n
      }).pipe(Effect.orDie),
    get: () =>
      CounterState2.get('count').pipe(
        Effect.map((c) => c ?? 0),
        Effect.orDie,
      ),
  },
})

/* NEGATIVE: `State.set` in the SHARED `get` handler is a handler-LOCAL compile error
 * (no `StateWrite` provided to a shared handler). This is the key R04/R05 gate. */
const _CounterObjBad = RestateObject.implement<typeof CounterObj>({
  contractValue: CounterObj,
  impl: {
    add: (n) => CounterState2.set({ key: 'count', value: n }).pipe(Effect.as(n), Effect.orDie),
    // @ts-expect-error — State.set requires StateWrite, not provided to a shared handler
    get: () => CounterState2.set({ key: 'count', value: 0 }).pipe(Effect.as(0), Effect.orDie),
  },
})

/* The object ingress client infers exact input/success from the contract + key. */
const _objCall = objectCall({ contract: CounterObj, key: 'key-1', method: 'add', input: 1 })
type _O1 = Assert<Equals<Effect.Success<typeof _objCall>, number>>
// @ts-expect-error — `add` takes a number, not a string
const _objCallBad = objectCall({ contract: CounterObj, key: 'key-1', method: 'add', input: 'x' })

/* ── Phase 2: Workflow run vs signal/query capability discharge ────────────── */

class Decision extends Schema.Class<Decision>('test/Decision')({ ok: Schema.Boolean }) {}
const Approval = DurablePromise.for(Decision)

const Approve = RestateWorkflow.contract({
  name: 'approve',
  def: {
    state: { status: Schema.Literals(['pending', 'approved', 'rejected']) },
    payload: { input: Schema.String, success: Schema.Boolean },
    signals: { approve: { input: Decision, success: Schema.Void } },
    queries: { status: { input: Schema.Void, success: Schema.String } },
  },
})
const ApproveState = State.for({
  status: Schema.Literals(['pending', 'approved', 'rejected']),
})

/* POSITIVE: `run` writes State + awaits a durable promise; the signal resolves it
 * (read-only State + durable promise); the query reads State. Wrapper errors `orDie`. */
const _ApproveOk = RestateWorkflow.implement<typeof Approve>({
  contractValue: Approve,
  impl: {
    run: () =>
      Effect.gen(function* () {
        yield* ApproveState.set({ key: 'status', value: 'pending' })
        const decision = yield* Approval.get('decision')
        yield* ApproveState.set({
          key: 'status',
          value: decision.ok === true ? 'approved' : 'rejected',
        })
        return decision.ok
      }).pipe(Effect.orDie),
    approve: (d) => Approval.resolve({ name: 'decision', value: d }).pipe(Effect.orDie),
    status: () =>
      ApproveState.get('status').pipe(
        Effect.map((s) => s ?? 'pending'),
        Effect.orDie,
      ),
  },
})

/* NEGATIVE: `State.set` in a query (shared, read-only) is a compile error. */
const _ApproveBad = RestateWorkflow.implement<typeof Approve>({
  contractValue: Approve,
  impl: {
    run: () => Effect.succeed(true),
    approve: (d) => Approval.resolve({ name: 'decision', value: d }).pipe(Effect.orDie),
    status: () =>
      // @ts-expect-error — State.set requires StateWrite, not provided to a query (shared) handler
      ApproveState.set({ key: 'status', value: 'approved' }).pipe(
        Effect.as('approved'),
        Effect.orDie,
      ),
  },
})

/* NEGATIVE: a durable promise in a SERVICE handler is a compile error (no DurablePromise). */
const _ServiceNoPromise = RestateService.implement<typeof Counter>({
  contractValue: Counter,
  impl: {
    // @ts-expect-error — DurablePromise.resolve requires DurablePromise, not provided to a Service handler
    bump: () => Approval.resolve({ name: 'decision', value: new Decision({ ok: true }) }),
  },
})

/* The workflow submit client omits the `run` handler from the direct call surface
 * but submit/attach derive from `run`'s I/O. */
const _wfSubmit = workflowSubmit({ contract: Approve, key: 'wf-1', input: 'payload' })
type _W1 = Assert<Equals<Effect.Error<typeof _wfSubmit>, RestateError>>

/* eslint-enable @typescript-eslint/no-unused-vars */
