import * as restate from '@restatedev/restate-sdk'
import type { Brand, Exit } from 'effect'
import { Context, Effect, Option, Schema } from 'effect'
import * as SchemaAST from 'effect/SchemaAST'

import { contractSerdeFactory, invocationIdempotencyKey } from '../clients/InvocationPolicy.ts'
import { withRestateOperation } from '../observability/effect.ts'
import { emitAwakeableWait, emitDurableStep, monotonicMs } from '../observability/Metrics.ts'
import { type RedactionCipher, RestateRedaction } from '../schema/Redaction.ts'
import { RestateError } from '../schema/RestateError.ts'
import { internalSerde } from '../schema/Serde.ts'

/**
 * The per-invocation Restate `Context`, provided as a `Context.Tag` service.
 *
 * Bound to a single invocation/journal, so it is provided PER CALL at the
 * handler boundary (see `Endpoint.materialize`) — never placed in the
 * long-lived application `Layer`. Durable combinators carry `RestateContext`
 * in their `R` and reach the raw SDK context via `yield* RestateContext`.
 */
export class RestateContext extends Context.Service<RestateContext, restate.Context>()(
  '@overeng/restate-effect/RestateContext',
) {}

/* ── capability markers (flat, independent — see decision 0002) ──────────── */
/*
 * Each marker is a distinct `Context.Tag` service, NOT a subtype lattice
 * (`Context.Tag` models no inheritance). A combinator requiring `StateWrite` is
 * satisfied ONLY by `StateWrite`, never by an umbrella marker — so the right set
 * is PROVIDED per handler kind at `materialize`. The service values carry a
 * DESCRIPTIVE brand (not an opaque empty record), so a capability violation in a
 * handler reads like the missing capability (`'requires a write-enabled (exclusive)
 * handler'`) instead of `StateWrite ≠ ObjectKey` — they gate type-legality, not
 * runtime behavior (the raw `ctx` does the work). The brand value is phantom (the
 * provided runtime value is still an empty marker).
 */

/** A descriptively-branded capability marker value (phantom; describes the requirement). */
type CapabilityMarker<Brand_ extends string> = { readonly [K in Brand_]: never }

/** Permits `State.get` / `State.stateKeys`. Provided to object/workflow handlers. */
export class StateRead extends Context.Service<
  StateRead,
  CapabilityMarker<'requires a State-readable (object/workflow) handler'>
>()('@overeng/restate-effect/StateRead') {}

/** Permits `State.set` / `State.clear` / `State.clearAll`. Exclusive object / workflow `run` only. */
export class StateWrite extends Context.Service<
  StateWrite,
  CapabilityMarker<'requires a write-enabled (exclusive object / workflow run) handler'>
>()('@overeng/restate-effect/StateWrite') {}

/** Permits `DurablePromise.*`. Workflow handlers only. */
export class DurablePromise extends Context.Service<
  DurablePromise,
  CapabilityMarker<'requires a Workflow handler (durable promises)'>
>()('@overeng/restate-effect/DurablePromise') {}

/** Permits the `ctx.key` accessor. Object / workflow handlers (all keyed). */
export class ObjectKey extends Context.Service<ObjectKey, { readonly key: string }>()(
  '@overeng/restate-effect/ObjectKey',
) {}

/**
 * The full set of durable capabilities `Restate.run` scrubs from its inner
 * effect's `R`, so a nested `ctx.*` / `State.*` / `Restate.sleep` inside a `run`
 * closure is a COMPILE error (mirrors Restate's "no nested `ctx.*` inside run").
 */
export type DurableCaps = RestateContext | StateRead | StateWrite | DurablePromise | ObjectKey

/* eslint-disable @typescript-eslint/no-explicit-any -- Schema map value variance */
/**
 * A map of State key → value schema (the contract's typed `state` block). A value
 * may be a plain `Schema` OR a `Schema.optional`-style field (a
 * `PropertySignature`), so an OPTIONAL state key (`Schema.optional(Schema.Number)`)
 * is supported — its value type is `T | undefined`, which matches State's
 * "unset → undefined" semantics. The `Record<string, Schema>` impl detail does not
 * leak: `State.for` accepts the same field shapes `Schema.Struct` does.
 */
export type StateSchemas = Record<string, Schema.Schema<any> | Schema.optional<Schema.Codec<any>>>

/** The decoded value type of a State field (`T | undefined` for an optional field). */
export type StateValueType<F> = F extends { readonly Type: infer A } ? A : never

/**
 * Normalize a State field to a plain value `Schema` for serde: a `Schema` passes
 * through; an OPTIONAL field's value schema is recovered from its
 * `PropertySignature` AST (`.type` is the `value | undefined` union) with the
 * `undefined` member STRIPPED — a SET value is always the present `T` (the
 * "unset → undefined" case never reaches the serde, the State combinator returns
 * `undefined` directly), and keeping `undefined` would break `JSONSchema.make`.
 */
export const normalizeStateSchema = (
  field: Schema.Schema<any> | Schema.optional<Schema.Codec<any>>,
): Schema.Codec<any, any> => {
  if ((field as { readonly '~type.optionality'?: string })['~type.optionality'] !== 'optional') {
    return field as Schema.Codec<any, any>
  }
  /* An optional field's `.schema` is the `value | undefined` union codec; the
   * `undefined` member is STRIPPED — a SET value is always the present `T`. */
  const inner = (field as Schema.optional<Schema.Codec<any>>).schema
  if (inner === undefined) {
    throw new Error('State field is neither a Schema nor a recoverable optional field')
  }
  return Schema.make<Schema.Codec<any>>(stripUndefined(inner.ast))
}

/** Drop an `Undefined` member from a recovered optional union (`T | undefined → T`). */
const stripUndefined = (ast: SchemaAST.AST): SchemaAST.AST => {
  if (ast._tag !== 'Union') return ast
  const members = ast.types.filter((t) => t._tag !== 'Undefined')
  if (members.length === ast.types.length) return ast
  return members.length === 1 ? members[0]! : new SchemaAST.Union(members, 'anyOf')
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/* ── descriptors (deterministic concurrency — see decision 0005) ─────────── */

/**
 * A durable-op descriptor: a tagged value carrying how to ISSUE one durable
 * operation against the raw `ctx`, returning the SDK `RestatePromise`. Issued
 * SYNCHRONOUSLY in source order by `Restate.all`/`race`/`any` so the journal
 * order is the source order — NOT `Effect.all` over opaque thunks (whose
 * scheduling, not source order, would decide journal order).
 *
 * The phantom `_A` carrier keeps the precise result type on the descriptor so
 * the combinators recover a precise result tuple/union.
 */
export interface Descriptor<A> {
  readonly _tag: 'run' | 'sleep' | 'promiseGet' | 'awakeable' | 'call'
  /* Issued by the effectful combinator (`all`/`race`/`any`/`timeout`) with the raw
   * `ctx` and the ambient redaction cipher resolved at ISSUE time. The cipher is
   * threaded here (not baked at construction) because a descriptor builder is
   * synchronous (it sits inside a `Restate.all([...])` array) and so cannot resolve
   * `RestateRedaction` itself — only the combinator can. Non-call descriptors ignore
   * it. */
  readonly issue: (
    ctx: restate.Context,
    redaction: RedactionCipher | undefined,
  ) => restate.RestatePromise<A>
  /** phantom result carrier (never read at runtime) */
  readonly _A?: (a: A) => void
}

/** Recover the result tuple from a tuple of descriptors. */
export type ResultsOf<T extends readonly Descriptor<any>[]> = {
  -readonly [P in keyof T]: T[P] extends Descriptor<infer A> ? A : never
}

const descriptor = <A>({
  tag,
  issue,
}: {
  tag: Descriptor<A>['_tag']
  issue: (ctx: restate.Context, redaction: RedactionCipher | undefined) => restate.RestatePromise<A>
}): Descriptor<A> => ({ _tag: tag, issue })

/* ── durable-op rejection handling (cancellation/suspension preservation) ─── */

/**
 * Whether a durable-op rejection is a Restate cancellation (`CancelledError`,
 * which `extends TerminalError`) — the cooperative-cancel signal a suspended
 * durable op (e.g. `ctx.sleep`) rejects with when the invocation is cancelled
 * (R31, docs/vrs/04-error-boundary/spec.md §2). It must NOT be wrapped into a `RestateError` defect (which
 * would be retried); it has to propagate so the boundary terminalizes it as a
 * non-retried cancellation.
 */
const isCancellation = (cause: unknown): cause is restate.CancelledError =>
  cause instanceof restate.CancelledError

/* A durable-op rejection that is a `restate.TerminalError` but NOT a
 * `CancelledError` (which `extends TerminalError` and is handled separately as an
 * interrupt). This is the signal an awaited durable promise / awakeable was
 * `reject`'d — the awaiter must fail TERMINALLY (R34), so the boundary terminalizes
 * the error VERBATIM rather than retrying it. */
const isTerminalReject = (cause: unknown): cause is restate.TerminalError =>
  cause instanceof restate.TerminalError && isCancellation(cause) === false

/**
 * How {@link awaitDurable} classifies a non-cancellation, non-suspension rejection:
 *
 * - `'infra'` (default — `run`/`sleep`/`timeout`/`all`/`race`/`any`): EVERY such
 *   rejection (incl. a `ctx.run` give-up's `TerminalError`) becomes a `RestateError`
 *   DEFECT classified at the boundary (transient → retry; terminal → fail). The
 *   durable op is infra: a rejection never escapes as a typed failure.
 * - `'terminal-reject'` (the blocking durable-promise `get`/`peek` + awakeable
 *   await): a `restate.TerminalError` (the `reject` signal, R34) re-throws VERBATIM
 *   as a defect so the boundary terminalizes it as-is (the awaiter fails terminally,
 *   not a retried infra defect). Any OTHER rejection still becomes a `RestateError`
 *   defect.
 */
type DurableRejectMode = 'infra' | 'terminal-reject'

/**
 * Await a durable-op promise, classifying the rejection so a durable
 * combinator's typed `E` stays CLEAN (no `RestateError`) — infra is handled at
 * the boundary, per decision 0003 (#1):
 *
 * - A `CancelledError` (cooperative cancel; R31) → re-throw as an Effect
 *   INTERRUPT, so the handler's `acquireRelease` / `onInterrupt` finalizers and
 *   compensations RUN. The boundary then re-maps the interrupt to a
 *   `CancelledError` (terminal, not retried).
 * - A Restate SUSPENSION (`isSuspendedError`) → re-throw the original suspended
 *   error AS-IS (as a defect), so `toTerminal` re-throws it verbatim and the SDK
 *   suspends/resumes. Finalizers must NOT run here — the work resumes in a new
 *   attempt (R15).
 * - A `reject`-signal `TerminalError` UNDER `'terminal-reject'` mode (the blocking
 *   durable-promise `get`/`peek` + awakeable await) → re-throw VERBATIM as a defect
 *   so the boundary terminalizes it as-is (the awaiter fails terminally, R34) rather
 *   than wrapping it into a retried `RestateError` infra defect.
 * - Any other rejection (a real infra failure / give-up after `ctx.run` retries)
 *   → DIE with the wrapper's `RestateError` (a DEFECT, never a typed failure), so
 *   it leaves the domain channel and the boundary classifies it: a transient infra
 *   failure → the SDK retries; a give-up after `ctx.run`'s own retries already
 *   arrived terminal. A user never has to `catchTag('RestateError', die)` it away.
 *
 * This is the single seam where a durable rejection is classified, so every
 * durable await (`run` / `sleep` / `timeout` / `all` / `race` / `any` / the
 * blocking durable-promise `get`/`peek` / the awakeable await) handles
 * cancellation/suspension identically. The opt-in `runExit` form re-surfaces the
 * defect as an observable `Exit` value for compensation/sagas.
 */
const awaitDurable = <A>({
  thunk,
  onError,
  mode = 'infra',
}: {
  thunk: () => Promise<A>
  onError: (cause: unknown) => RestateError
  mode?: DurableRejectMode
}): Effect.Effect<A, never, never> =>
  Effect.callback<A, never>((resume) => {
    thunk().then(
      (value) => resume(Effect.succeed(value)),
      (cause: unknown) => {
        /* Cancellation → interrupt (finalizers run, not retried). */
        if (isCancellation(cause) === true) {
          resume(Effect.interrupt)
          return
        }
        /* Suspension → re-throw the original verbatim as a defect (the SDK
         * suspends/resumes; finalizers must NOT run — work resumes next attempt). */
        if (restate.internal.isSuspendedError(cause) === true) {
          resume(Effect.die(cause))
          return
        }
        /* `reject` signal (blocking durable-promise/awakeable await) → re-throw the
         * `TerminalError` VERBATIM so the boundary terminalizes it as-is (R34), not a
         * retried infra defect. Only under `'terminal-reject'` mode; `run`/`sleep`
         * keep give-up `TerminalError`s as `RestateError` infra defects. */
        if (mode === 'terminal-reject' && isTerminalReject(cause) === true) {
          resume(Effect.die(cause))
          return
        }
        /* Real infra failure → DIE with `RestateError` (a defect, not a typed
         * failure), so the combinator's `E` stays clean and the boundary retries. */
        resume(Effect.die(onError(cause)))
      },
    )
  })

/* ── durable combinators ─────────────────────────────────────────────────── */

/**
 * Per-step durable retry controls for a single `Restate.run` (decision 0006,
 * docs/vrs/04-error-boundary/spec.md §3) — the SDK `RunOptions` retry knobs (the `serde` field is excluded; that is
 * the serde layer's concern). Restate retries the step with this backoff; on
 * giving up (`maxRetryAttempts`/`maxRetryDuration`), `ctx.run` converts the
 * failure to a `TerminalError` (surfaced here as a `RestateError` defect). Durable
 * retries are Restate's — `Effect.retry`/`Schedule` are for pure logic only.
 */
export interface RunRetryOptions {
  readonly maxRetryAttempts?: number
  readonly maxRetryDurationMillis?: number
  readonly initialRetryIntervalMillis?: number
  readonly maxRetryIntervalMillis?: number
  readonly retryIntervalFactor?: number
}

/* Map `RunRetryOptions` to the SDK `RunOptions` retry fields (millis = number). */
const mapRunOptions = (o: RunRetryOptions): Record<string, unknown> => ({
  ...(o.maxRetryAttempts !== undefined ? { maxRetryAttempts: o.maxRetryAttempts } : {}),
  ...(o.maxRetryDurationMillis !== undefined ? { maxRetryDuration: o.maxRetryDurationMillis } : {}),
  ...(o.initialRetryIntervalMillis !== undefined
    ? { initialRetryInterval: o.initialRetryIntervalMillis }
    : {}),
  ...(o.maxRetryIntervalMillis !== undefined ? { maxRetryInterval: o.maxRetryIntervalMillis } : {}),
  ...(o.retryIntervalFactor !== undefined ? { retryIntervalFactor: o.retryIntervalFactor } : {}),
})

/**
 * A durable side-effect step backed by `ctx.run(name, …)`. Restate journals the
 * result so subsequent attempts replay it verbatim instead of re-executing.
 *
 * SCRUBS the durable capabilities from `effect`'s `R` (`Exclude<R,
 * DurableCaps>`), so a nested `ctx.*` / `State.get` / `Restate.sleep` inside the
 * closure is a COMPILE error. The inner effect runs on the captured
 * per-invocation runtime, so any residual app `R` is satisfied from the
 * surrounding handler scope.
 *
 * `options` surfaces Restate's per-step durable retry controls (decision 0006,
 * docs/vrs/04-error-boundary/spec.md §3); when given, the step is bounded by `ctx.run`'s own retry/backoff and
 * a give-up becomes a `RestateError` DEFECT. Never wrap a durable step in
 * `Effect.retry` — that double-retries non-durably (R21).
 *
 * The inner effect carries NO catchable typed failure (`Effect<A, never, …>`) and
 * `run` returns `Effect<A, never, …>` (#1, decision 0003). A durable step is
 * journaled and replayed by Restate, so its only outcomes are a journaled success
 * `A` or an infra failure: a closure that DIES (or whose `ctx.run` gives up after
 * its own retries) REJECTS the step, which Restate retries per its policy and which
 * — once terminal — `awaitDurable` surfaces as a `RestateError` DEFECT classified at
 * the boundary, never a typed failure the user must `catchTag('RestateError', die)`
 * away. Domain errors therefore belong in the HANDLER body (classify the step's
 * result there) or are encoded as VALUES inside the step (a tagged success the
 * handler branches on); to force a durable retry, DIE inside the step (a defect →
 * step rejection → retry). Use {@link runExit} to OBSERVE the outcome (success, or
 * the failure/defect `Cause` — incl. the give-up `RestateError` and interruption) as
 * a value for compensation/sagas.
 *
 * The journaled value is the raw success `A` (the contract's serde-friendly
 * value), NOT a wrapped `Exit` — so the SDK's default journal serde stays correct
 * and a replay reproduces it verbatim. A nested `Exit`/`Cause` would not be
 * JSON-journalable.
 *
 * A typed-failure-transport `run` (journaling an encoded `fail(E)` via an error
 * schema, so a typed durable-step failure round-trips) is a DEFERRED alternative
 * (docs/vrs/spec.md Deferred, decision 0003) — not the v1 contract.
 */
export const run = <A, R>({
  name,
  effect,
  options,
}: {
  name: string
  effect: [R] extends [Exclude<R, DurableCaps>] ? Effect.Effect<A, never, R> : never
  options?: RunRetryOptions
}): Effect.Effect<A, never, Exclude<R, DurableCaps> | RestateContext> =>
  Effect.gen(function* () {
    const ctx = yield* RestateContext
    const context = yield* Effect.context<Exclude<R, DurableCaps>>()
    /* The `[R] extends [Exclude<R, DurableCaps>]` guard guarantees `R` carries no
     * durable capability, so the captured `Exclude<R, DurableCaps>` runtime can
     * run it; the cast just reconciles the conditional type. The inner runs to a
     * raw `A` (journaled by the SDK); a defect rejects the step. */
    const inner = effect as Effect.Effect<A, never, Exclude<R, DurableCaps>>
    const action = (): Promise<A> => Effect.runPromiseWith(context)(inner)
    const result = yield* awaitDurable({
      thunk: () =>
        options !== undefined
          ? ctx.run(name, action, mapRunOptions(options) as Parameters<typeof ctx.run<A>>[2])
          : ctx.run(name, action),
      onError: (cause) => new RestateError({ reason: 'RunFailed', method: `run(${name})`, cause }),
    })
    /* AUTO baseline metric (decision 0014): a durable step executed exactly once.
     * The journaled `ctx.run` body runs on real execution and is skipped on replay,
     * so gating the counter on non-replay makes it exactly-once across attempts. */
    yield* emitDurableStep({ ctx, step: name })
    return result
  }).pipe(withRestateOperation({ name: 'restate.run', label: name }))

/**
 * Observe a `Restate.run`'s OBSERVED outcome as an `Exit` VALUE instead of failing
 * — the opt-in seam for compensation / sagas (decision 0003). The `Exit` faithfully
 * captures what actually happened at the durable-step boundary: `Exit.succeed(A)`
 * for a journaled success, or an `Exit.failure(Cause)` for the failure/defect as
 * observed there — a durable-op give-up arrives as a `Cause.Die` carrying the
 * `RestateError` (read via `Cause.dieOption`), and an interruption as a
 * `Cause.Interrupt`. There is NO typed domain `E` (a durable step carries no
 * catchable typed failure, #1), so the failure channel is `never` and an observed
 * failure is always a defect/interrupt the caller branches on. The inner step is
 * still journaled exactly once.
 */
export const runExit = <A, R>({
  name,
  effect,
  options,
}: {
  name: string
  effect: [R] extends [Exclude<R, DurableCaps>] ? Effect.Effect<A, never, R> : never
  options?: RunRetryOptions
}): Effect.Effect<Exit.Exit<A>, never, Exclude<R, DurableCaps> | RestateContext> =>
  Effect.exit(run<A, R>({ name, effect, ...(options !== undefined ? { options } : {}) }))

/** A `run` descriptor for use inside `Restate.all`/`race`/`any`. */
export const runDescriptor = <A>({
  name,
  action,
}: {
  name: string
  action: (() => Promise<A>) | (() => A)
}): Descriptor<A> => descriptor<A>({ tag: 'run', issue: (ctx) => ctx.run<A>(name, action) })

/**
 * A durable timer backed by `ctx.sleep`. The duration is a lower bound; the
 * timer survives suspension and process restarts. The `E` channel is CLEAN: a
 * timer infra failure is a defect classified at the boundary (#1), never a typed
 * `RestateError`.
 */
export const sleep = ({
  millis,
  name,
}: {
  millis: number
  name?: string
}): Effect.Effect<void, never, RestateContext> =>
  Effect.gen(function* () {
    const ctx = yield* RestateContext
    yield* awaitDurable({
      thunk: () => ctx.sleep(millis, name),
      onError: (cause) =>
        new RestateError({ reason: 'SleepFailed', method: `sleep(${millis})`, cause }),
    })
  }).pipe(withRestateOperation({ name: 'restate.sleep', label: name ?? `${millis}ms` }))

/** A `sleep` descriptor for use inside `Restate.all`/`race`/`any`. */
export const sleepDescriptor = ({
  millis,
  name,
}: {
  millis: number
  name?: string
}): Descriptor<void> => descriptor({ tag: 'sleep', issue: (ctx) => ctx.sleep(millis, name) })

/**
 * A durable timeout: race `effect` against a `ctx.sleep` deadline via
 * `RestatePromise.orTimeout`. On timeout the result is `None`; otherwise
 * `Some(value)`. The raced `effect` must itself be a single durable op
 * descriptor issuer — Phase 1 exposes `timeout` over a `run`/`promiseGet`
 * descriptor so the inner op is issued once and bounded.
 */
export const timeout = <A>({
  descr,
  millis,
}: {
  descr: Descriptor<A>
  millis: number
}): Effect.Effect<A | undefined, never, RestateContext> =>
  Effect.gen(function* () {
    const ctx = yield* RestateContext
    const redaction = yield* resolveCallRedaction
    return yield* awaitDurable({
      thunk: () =>
        descr
          .issue(ctx, redaction)
          .orTimeout(millis)
          .map((value?: A) => value),
      onError: (cause) =>
        new RestateError({ reason: 'RunFailed', method: `timeout(${millis})`, cause }),
    })
  }).pipe(withRestateOperation({ name: 'restate.timeout', label: `${millis}ms` }))

/**
 * Combine durable-op descriptors deterministically. Issues every descriptor
 * SYNCHRONOUSLY in source order to obtain the `RestatePromise[]` (fixing the
 * journal order), hands the array to the SDK `combine` (`all`/`race`/`any`), and
 * awaits the SINGLE resulting `RestatePromise` ONCE via `awaitDurable`, mapping
 * the result after (never `.then`-chaining pre-await — `.then` is the SDK's
 * suspension seam; `awaitDurable` also preserves cancellation/suspension). See
 * decision 0005.
 */
const combineDescriptors =
  <Combined>({
    label,
    combine,
  }: {
    label: string
    combine: (
      promises: ReadonlyArray<restate.RestatePromise<unknown>>,
    ) => restate.RestatePromise<Combined>
  }) =>
  <const T extends readonly Descriptor<any>[]>(
    descriptors: T,
  ): Effect.Effect<Combined, never, RestateContext> =>
    Effect.gen(function* () {
      const ctx = yield* RestateContext
      const redaction = yield* resolveCallRedaction
      return yield* awaitDurable({
        thunk: () => combine(descriptors.map((d) => d.issue(ctx, redaction))),
        onError: (cause) => new RestateError({ reason: 'RunFailed', method: label, cause }),
      })
    }).pipe(withRestateOperation({ name: `restate.${label}`, label: label }))

/** Await all durable descriptors → result TUPLE (issued in source order). */
export const all = <const T extends readonly Descriptor<any>[]>(
  descriptors: T,
): Effect.Effect<ResultsOf<T>, never, RestateContext> =>
  combineDescriptors<ResultsOf<T>>({
    label: 'all',
    combine: (promises) =>
      /* The SDK's `all` returns the awaited tuple; the descriptor phantoms make it
       * precise at the call site. */
      restate.RestatePromise.all(promises) as restate.RestatePromise<ResultsOf<T>>,
  })(descriptors)

/** Race durable descriptors → first result (union of branch types). */
export const race = <const T extends readonly Descriptor<any>[]>(
  descriptors: T,
): Effect.Effect<ResultsOf<T>[number], never, RestateContext> =>
  combineDescriptors<ResultsOf<T>[number]>({
    label: 'race',
    combine: (promises) =>
      restate.RestatePromise.race(promises) as restate.RestatePromise<ResultsOf<T>[number]>,
  })(descriptors)

/** First SUCCESSFULLY-resolved durable descriptor (union of branch types). */
export const any = <const T extends readonly Descriptor<any>[]>(
  descriptors: T,
): Effect.Effect<ResultsOf<T>[number], never, RestateContext> =>
  combineDescriptors<ResultsOf<T>[number]>({
    label: 'any',
    combine: (promises) =>
      restate.RestatePromise.any(promises) as restate.RestatePromise<ResultsOf<T>[number]>,
  })(descriptors)

/* ── State combinators (capability-gated, key/value typed against `state`) ─ */
/*
 * Typed against a `StateSchemas` map `S` keyed by the state key. `get`/`stateKeys`
 * require `StateRead`; `set`/`clear`/`clearAll` require `StateWrite`. These
 * compile-fail in a Service handler (no markers provided) — correct: State is an
 * Object/Workflow capability, exercised in Phase 2. Each is decode/encode'd via
 * the contract's per-key Schema (`internal` slot — a State decode failure is a
 * corrupt-journal defect).
 */

const readState = <S extends StateSchemas, K extends keyof S & string>({
  schemas,
  key,
}: {
  schemas: S
  key: K
}): Effect.Effect<StateValueType<S[K]> | undefined, never, StateRead | RestateContext> =>
  Effect.gen(function* () {
    const ctx = yield* RestateContext
    const objectCtx = ctx as restate.ObjectContext
    /* A read infra failure is a defect (clean `E`, #1); a decode failure on the
     * State (internal) slot is a CORRUPT-JOURNAL defect (decision 0003) — neither
     * is a typed `RestateError` a handler must catch. */
    const raw = yield* Effect.tryPromise({
      try: () => objectCtx.get<unknown>(key),
      catch: (cause) =>
        new RestateError({ reason: 'RunFailed', method: `State.get(${key})`, cause }),
    }).pipe(Effect.orDie)
    if (raw === null || raw === undefined) return undefined
    return yield* Schema.decodeEffect(normalizeStateSchema(schemas[key]!))(raw).pipe(
      Effect.mapError(
        (cause) => new RestateError({ reason: 'SerdeFailed', method: `State.get(${key})`, cause }),
      ),
      Effect.orDie,
    )
  }).pipe(withRestateOperation({ name: 'restate.state.get', label: key }))

const writeState = <S extends StateSchemas, K extends keyof S & string>({
  schemas,
  key,
  value,
}: {
  schemas: S
  key: K
  value: StateValueType<S[K]>
}): Effect.Effect<void, never, StateWrite | RestateContext> =>
  Effect.gen(function* () {
    const ctx = yield* RestateContext
    const objectCtx = ctx as restate.ObjectContext
    /* State is K/V: an ABSENT key reads back as `undefined`. So writing `undefined`
     * to an OPTIONAL field REMOVES the key (`set(key, undefined)` ≡ `clear(key)`),
     * rather than encoding it — the inner serde schema is the PRESENT value type
     * (`undefined` stripped by `normalizeStateSchema`), so a `set(undefined)` would
     * otherwise fail to encode. This makes the "unset → undefined" semantics
     * symmetric on read AND write (#1). */
    if (value === undefined) {
      objectCtx.clear(key)
      return
    }
    const encoded = yield* Schema.encodeEffect(normalizeStateSchema(schemas[key]!))(value).pipe(
      Effect.mapError(
        (cause) => new RestateError({ reason: 'SerdeFailed', method: `State.set(${key})`, cause }),
      ),
      Effect.orDie,
    )
    objectCtx.set(key, encoded)
  }).pipe(withRestateOperation({ name: 'restate.state.set', label: key }))

/**
 * Build the typed State combinator family bound to a contract's `state` block.
 * Phase 2's Object/Workflow `implement` calls this with the contract's schema
 * map; the combinators it returns are capability-gated and key/value-typed.
 */
export const stateFor = <S extends StateSchemas>(schemas: S) =>
  ({
    get: <K extends keyof S & string>(key: K) => readState({ schemas, key }),
    set: <K extends keyof S & string>({ key, value }: { key: K; value: StateValueType<S[K]> }) =>
      writeState({ schemas, key, value }),
    clear: <K extends keyof S & string>(
      key: K,
    ): Effect.Effect<void, never, StateWrite | RestateContext> =>
      Effect.gen(function* () {
        const ctx = yield* RestateContext
        ;(ctx as restate.ObjectContext).clear(key)
      }).pipe(withRestateOperation({ name: 'restate.state.clear', label: key })),
    clearAll: (): Effect.Effect<void, never, StateWrite | RestateContext> =>
      Effect.gen(function* () {
        const ctx = yield* RestateContext
        ;(ctx as restate.ObjectContext).clearAll()
      }).pipe(withRestateOperation({ name: 'restate.state.clearAll', label: 'clearAll' })),
    stateKeys: (): Effect.Effect<ReadonlyArray<string>, never, StateRead | RestateContext> =>
      Effect.gen(function* () {
        const ctx = yield* RestateContext
        /* A `stateKeys` infra failure is a defect (clean `E`, #1). */
        return yield* Effect.tryPromise({
          try: () => (ctx as restate.ObjectContext).stateKeys(),
          catch: (cause) =>
            new RestateError({ reason: 'RunFailed', method: 'State.stateKeys', cause }),
        }).pipe(Effect.orDie)
      }).pipe(withRestateOperation({ name: 'restate.state.stateKeys', label: 'stateKeys' })),
  }) as const

/* ── ObjectKey accessor (capability-gated) ───────────────────────────────── */

/**
 * The key of the current Object / Workflow invocation. Requires `ObjectKey`, so
 * it compile-fails in a Service handler (no key). Backed by `ctx.key`.
 */
export const objectKey: Effect.Effect<string, never, ObjectKey | RestateContext> = Effect.gen(
  function* () {
    const ctx = yield* RestateContext
    return (ctx as restate.ObjectContext).key
  },
).pipe(withRestateOperation({ name: 'restate.objectKey', label: 'objectKey' }))

/* ── Durable promises (Workflow cross-handler signalling) ────────────────── */
/*
 * A Workflow durable promise: a named, durable rendezvous between the `run`
 * handler (which awaits it) and a shared signal handler (which resolves/rejects
 * it). Capability-gated on `DurablePromise`. The payload is decode/encode'd via
 * the contract's per-name Schema on the `internal` slot — a decode failure is a
 * corrupt-journal defect (R13, docs/vrs/02-schema-serde/spec.md §1). `get` blocks until resolved; `peek` is a
 * non-blocking read (`undefined` if unresolved); `resolve`/`reject` complete it
 * (a `reject` makes the awaiting `get` fail terminally — drives the `'rejected'`
 * path, R34). `getDescriptor` issues the promise as a `Descriptor` for
 * `Restate.race`/`all`/`any`.
 */

const promiseSerde = <T, I>(schema: Schema.Codec<T, I>): restate.Serde<T> =>
  internalSerde({ schema })

/* A blocking durable-promise `get`, awaited through {@link awaitDurable} (the same
 * seam `run`/`sleep` use) so suspension/cancellation/infra classify identically. An
 * unresolved `get` re-throws the SDK suspension sentinel and PARKS the invocation
 * (not a defect→retry); a `reject` makes the awaiting `get` fail TERMINALLY (R34) —
 * that rejection arrives as a `TerminalError` the boundary terminalizes verbatim; a
 * real infra failure is a defect (clean `E`, #1). */
const promiseGet = <T, I>({
  name,
  schema,
}: {
  name: string
  schema: Schema.Codec<T, I>
}): Effect.Effect<T, never, DurablePromise | RestateContext> =>
  Effect.gen(function* () {
    const ctx = yield* RestateContext
    return yield* awaitDurable({
      thunk: () =>
        (ctx as restate.WorkflowSharedContext).promise<T>(name, promiseSerde(schema)).get(),
      onError: (cause) =>
        new RestateError({ reason: 'RunFailed', method: `DurablePromise.get(${name})`, cause }),
      mode: 'terminal-reject',
    })
  }).pipe(withRestateOperation({ name: 'restate.promise.get', label: name }))

/* A non-blocking read (`undefined` if unresolved — never suspends), awaited through
 * {@link awaitDurable} so a `reject` classifies TERMINALLY like {@link promiseGet}
 * (the suspension branch is inert here). */
const promisePeek = <T, I>({
  name,
  schema,
}: {
  name: string
  schema: Schema.Codec<T, I>
}): Effect.Effect<T | undefined, never, DurablePromise | RestateContext> =>
  Effect.gen(function* () {
    const ctx = yield* RestateContext
    return yield* awaitDurable({
      thunk: () =>
        (ctx as restate.WorkflowSharedContext).promise<T>(name, promiseSerde(schema)).peek(),
      onError: (cause) =>
        new RestateError({ reason: 'RunFailed', method: `DurablePromise.peek(${name})`, cause }),
      mode: 'terminal-reject',
    })
  }).pipe(withRestateOperation({ name: 'restate.promise.peek', label: name }))

const promiseResolve = <T, I>({
  name,
  schema,
  value,
}: {
  name: string
  schema: Schema.Codec<T, I>
  value: T
}): Effect.Effect<void, never, DurablePromise | RestateContext> =>
  Effect.gen(function* () {
    const ctx = yield* RestateContext
    yield* Effect.tryPromise({
      try: () =>
        (ctx as restate.WorkflowSharedContext)
          .promise<T>(name, promiseSerde(schema))
          .resolve(value),
      catch: (cause) =>
        new RestateError({ reason: 'RunFailed', method: `DurablePromise.resolve(${name})`, cause }),
    }).pipe(Effect.orDie)
  }).pipe(withRestateOperation({ name: 'restate.promise.resolve', label: name }))

const promiseReject = <T, I>({
  name,
  schema,
  reason,
}: {
  name: string
  schema: Schema.Codec<T, I>
  reason: string
}): Effect.Effect<void, never, DurablePromise | RestateContext> =>
  Effect.gen(function* () {
    const ctx = yield* RestateContext
    yield* Effect.tryPromise({
      try: () =>
        (ctx as restate.WorkflowSharedContext)
          .promise<T>(name, promiseSerde(schema))
          .reject(reason),
      catch: (cause) =>
        new RestateError({ reason: 'RunFailed', method: `DurablePromise.reject(${name})`, cause }),
    }).pipe(Effect.orDie)
  }).pipe(withRestateOperation({ name: 'restate.promise.reject', label: name }))

/**
 * Build the typed durable-promise combinator family for one payload Schema. Each
 * combinator is capability-gated on `DurablePromise` (Workflow handlers only) and
 * payload-typed. `getDescriptor` issues the promise for deterministic concurrency.
 */
export const durablePromiseFor = <T, I>(schema: Schema.Codec<T, I>) =>
  ({
    get: (name: string) => promiseGet({ name, schema }),
    peek: (name: string) => promisePeek({ name, schema }),
    resolve: ({ name, value }: { name: string; value: T }) =>
      promiseResolve({ name, schema, value }),
    reject: ({ name, reason }: { name: string; reason: string }) =>
      promiseReject({ name, schema, reason }),
    getDescriptor: (name: string): Descriptor<T> =>
      descriptor<T>({
        tag: 'promiseGet',
        issue: (ctx) =>
          (ctx as restate.WorkflowSharedContext).promise<T>(name, promiseSerde(schema)).get(),
      }),
  }) as const

/* ── Awakeables (external completion tokens) ─────────────────────────────── */

/** The nominal awakeable-id brand (independent of payload — the `<T>` tag rides below). */
type AwakeableIdBrand = Brand.Brand<'@overeng/restate-effect/AwakeableId'>

/**
 * Branded awakeable id (typed against its payload — see `Awakeable.make`). The
 * payload `T` rides in a property whose KEY is unique per payload type via the
 * intersection, but `T` is kept OUT of any inference-driving position: the resolve
 * combinators infer their `T` from the payload SCHEMA (the single source), never
 * from the id, so a mismatched id is a plain assignability error, not a `T` shift.
 */
export type AwakeableId<T> = string & AwakeableIdBrand & { readonly _payload?: T }

/**
 * Create an awakeable: a typed external-completion token. Returns its branded
 * `id` (send it to an external system / another handler), a `promise` Effect that
 * SUSPENDS until the awakeable is resolved (via ingress `resolveAwakeable` or
 * another handler), and a `descriptor` to join `Restate.all`/`race`/`any`
 * deterministically (#2). The payload is decode/encode'd via `schema` on the
 * `internal` slot. Requires `RestateContext` (legal in any handler kind).
 *
 * The `promise`'s `E` is CLEAN (#1): an await infra failure is a defect
 * classified at the boundary; a `reject` arrives as a `TerminalError` the
 * boundary terminalizes verbatim (the awaiter fails terminally, R33/R34), not a
 * typed `RestateError`.
 */
export const makeAwakeable = <T, I>(
  schema: Schema.Codec<T, I>,
): Effect.Effect<
  {
    readonly id: AwakeableId<T>
    readonly promise: Effect.Effect<T, never, never>
    readonly descriptor: Descriptor<T>
  },
  never,
  RestateContext
> =>
  Effect.gen(function* () {
    const ctx = yield* RestateContext
    const aw = ctx.awakeable<T>(promiseSerde(schema))
    const promise = Effect.gen(function* () {
      const startMs = monotonicMs()
      /* Await through {@link awaitDurable} (the same seam `run`/`sleep` use): an
       * unresolved awakeable re-throws the SDK suspension sentinel and PARKS the
       * invocation (not a defect→retry); a `reject` arrives as a `TerminalError`
       * the boundary terminalizes verbatim (R33/R34); a real infra failure is a
       * defect (clean `E`, #1). */
      const value = yield* awaitDurable({
        thunk: () => aw.promise,
        onError: (cause) =>
          new RestateError({ reason: 'RunFailed', method: 'Awakeable.await', cause }),
        mode: 'terminal-reject',
      })
      /* AUTO baseline metric (decision 0014): the real external-completion wait.
       * Gated on non-replay — a replay reproduces the journaled completion
       * instantly, so the measured (monotonic) delta is only recorded on a real
       * resolution, never on replay. */
      yield* emitAwakeableWait({ ctx, waitMs: monotonicMs() - startMs })
      return value
    }).pipe(withRestateOperation({ name: 'restate.awakeable.await', label: aw.id }))
    /* The awakeable's completion promise is itself a `RestatePromise`, so it joins
     * the deterministic combinators like any other descriptor — issued in source
     * order, awaited once (decision 0005, #2). It is created ONCE (at `make`), so
     * `issue` just hands the existing promise to the combinator. */
    const descriptor: Descriptor<T> = { _tag: 'awakeable', issue: () => aw.promise }
    return { id: aw.id as AwakeableId<T>, promise, descriptor }
  }).pipe(withRestateOperation({ name: 'restate.awakeable.make', label: 'make' }))

/** Resolve an awakeable in-handler with a typed payload (encoded via `schema`). */
export const resolveAwakeable = <T, I>({
  schema,
  id,
  payload,
}: {
  schema: Schema.Codec<T, I>
  id: AwakeableId<T>
  payload: T
}): Effect.Effect<void, never, RestateContext> =>
  Effect.gen(function* () {
    const ctx = yield* RestateContext
    ctx.resolveAwakeable<T>(id, payload, promiseSerde(schema))
  }).pipe(withRestateOperation({ name: 'restate.awakeable.resolve', label: id }))

/** Reject an awakeable in-handler with a reason (the awaiter fails terminally). */
export const rejectAwakeable = <T>({
  id,
  reason,
}: {
  id: AwakeableId<T>
  reason: string
}): Effect.Effect<void, never, RestateContext> =>
  Effect.gen(function* () {
    const ctx = yield* RestateContext
    ctx.rejectAwakeable(id, reason)
  }).pipe(withRestateOperation({ name: 'restate.awakeable.reject', label: id }))

/* ── In-handler service-to-service clients ───────────────────────────────── */
/*
 * Typed request/response (`call`) and one-way (`send`, optionally delayed)
 * service-to-service invocations from inside a handler, routed by the target
 * contract's name + the `generic*` SDK surface so no `restate.service` value is
 * needed at the call site. Input encoded / success decoded via the target's serde
 * (`ingress` slot — a peer call is a caller-facing boundary). The idempotency key
 * is read from the annotated input field (decision 0011), never a call-site
 * option. `key` routes to a Virtual Object / Workflow instance.
 */

/* The in-handler peer-call serde, built through the SHARED contract-invocation
 * policy (decision 0020) so the redaction cipher is threaded identically to the
 * ingress path — a `Restate.sensitive` field in a peer call's input/output is
 * encrypted on the service-to-service wire. The slot stays `internal`: a peer
 * call is journaled, so a decode failure is a corrupt-journal defect (not a 400
 * to the current caller). The cipher is resolved once from the handler's app
 * context (`RestateRedaction`); absent → no cipher (fine unless a sensitive field
 * is present, which then fails loudly). */
const clientCallSerde = <T, I>({
  schema,
  redaction,
}: {
  schema: Schema.Codec<T, I>
  redaction: RedactionCipher | undefined
}): restate.Serde<T> =>
  contractSerdeFactory(redaction).forSchema({
    schema: schema as Schema.Codec<unknown, unknown>,
    slot: 'internal',
  }) as restate.Serde<T>

/** Resolve the optional in-handler redaction cipher from the app context. */
const resolveCallRedaction: Effect.Effect<RedactionCipher | undefined, never, never> =
  Effect.serviceOption(RestateRedaction).pipe(Effect.map(Option.getOrUndefined))

/** Options threaded through an in-handler one-way `send` (delay only — key is positional). */
export interface SendOptions {
  /** Delay the send by this many milliseconds (durable, fault-tolerant cron). */
  readonly delayMillis?: number
}

const callRpc = <In, InI, Out, OutI>(opts: {
  readonly service: string
  readonly handler: string
  readonly inputSchema: Schema.Codec<In, InI>
  readonly outputSchema: Schema.Codec<Out, OutI>
  readonly input: In
  readonly key?: string
}): Effect.Effect<Out, never, RestateContext> =>
  Effect.gen(function* () {
    const ctx = yield* RestateContext
    const redaction = yield* resolveCallRedaction
    const idempotencyKey = invocationIdempotencyKey({
      inputSchema: opts.inputSchema as Schema.Codec<unknown, unknown>,
      input: opts.input,
    })
    /* Await the peer-call `InvocationPromise` through the SHARED `awaitDurable`
     * seam (the same seam `run`/`sleep`/`promiseGet`/`all`/`race` use), NOT a plain
     * `Effect.tryPromise`: an in-handler call that has not completed rejects the SDK
     * `RestatePromise` with the SUSPENSION sentinel (the invocation must PARK and
     * resume on the result) or a `CancelledError` — wrapping those in a
     * `RestateError` would degrade a park-and-resume into a defect→retry and swallow
     * cancellation. `awaitDurable` re-throws a suspension verbatim (the SDK parks/
     * resumes) and maps cancellation to an interrupt. A peer call only rejects on
     * suspension / cancellation / a callee `TerminalError`, so `'terminal-reject'`
     * mode terminalizes a callee terminal failure VERBATIM (R34) and there is no
     * typed failure left — matching the descriptor call path's `never`. */
    return yield* awaitDurable({
      thunk: () =>
        ctx.genericCall<In, Out>({
          service: opts.service,
          method: opts.handler,
          parameter: opts.input,
          ...(opts.key !== undefined ? { key: opts.key } : {}),
          inputSerde: clientCallSerde({ schema: opts.inputSchema, redaction }),
          outputSerde: clientCallSerde({ schema: opts.outputSchema, redaction }),
          ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
        }),
      onError: (cause) =>
        new RestateError({
          reason: 'IngressFailed',
          method: `call(${opts.service}.${opts.handler})`,
          cause,
        }),
      mode: 'terminal-reject',
    })
  }).pipe(
    withRestateOperation({ name: 'restate.client.call', label: `${opts.service}.${opts.handler}` }),
  )

const sendRpc = <In, InI>(opts: {
  readonly service: string
  readonly handler: string
  readonly inputSchema: Schema.Codec<In, InI>
  readonly input: In
  readonly key?: string
  readonly delayMillis?: number
}): Effect.Effect<void, RestateError, RestateContext> =>
  Effect.gen(function* () {
    const ctx = yield* RestateContext
    const redaction = yield* resolveCallRedaction
    const idempotencyKey = invocationIdempotencyKey({
      inputSchema: opts.inputSchema as Schema.Codec<unknown, unknown>,
      input: opts.input,
    })
    yield* Effect.try({
      try: () =>
        ctx.genericSend<In>({
          service: opts.service,
          method: opts.handler,
          parameter: opts.input,
          ...(opts.key !== undefined ? { key: opts.key } : {}),
          inputSerde: clientCallSerde({ schema: opts.inputSchema, redaction }),
          ...(opts.delayMillis !== undefined ? { delay: opts.delayMillis } : {}),
          ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
        }),
      catch: (cause) =>
        new RestateError({
          reason: 'IngressFailed',
          method: `send(${opts.service}.${opts.handler})`,
          cause,
        }),
    })
  }).pipe(
    withRestateOperation({ name: 'restate.client.send', label: `${opts.service}.${opts.handler}` }),
  )

/**
 * A `call` descriptor: issue an in-handler service-to-service `genericCall` as a
 * `Descriptor` so it joins `Restate.all`/`race`/`any` deterministically (#2). The
 * `genericCall` returns an `InvocationPromise` (a `RestatePromise`), issued in
 * source order with the other descriptors. Input encoded / output decoded via the
 * target's serde (the SHARED policy); the idempotency key is read from the
 * annotated input field (the same path as `callRpc`).
 *
 * The descriptor builder is SYNCHRONOUS (it returns a `Descriptor`, not an
 * Effect, so it can sit inside a `Restate.all([...])` array), so it cannot
 * `yield*` the ambient `RestateRedaction`. The serdes are therefore built LAZILY
 * inside `issue`, which the effectful combinator (`all`/`race`/`any`/`timeout`)
 * calls with the cipher it resolved at issue time — so a `Restate.sensitive` field
 * in a peer call's I/O is encrypted on the descriptor path too (decision 0020),
 * not just the direct `callRpc` path. A redaction cipher is OPTIONAL; absent → no
 * cipher (fine unless a sensitive field is present, which then fails loudly).
 */
const callDescriptor = <In, InI, Out, OutI>(opts: {
  readonly service: string
  readonly handler: string
  readonly inputSchema: Schema.Codec<In, InI>
  readonly outputSchema: Schema.Codec<Out, OutI>
  readonly input: In
  readonly key?: string
}): Descriptor<Out> => {
  const idempotencyKey = invocationIdempotencyKey({
    inputSchema: opts.inputSchema as Schema.Codec<unknown, unknown>,
    input: opts.input,
  })
  return descriptor<Out>({
    tag: 'call',
    issue: (ctx, redaction) =>
      ctx.genericCall<In, Out>({
        service: opts.service,
        method: opts.handler,
        parameter: opts.input,
        ...(opts.key !== undefined ? { key: opts.key } : {}),
        inputSerde: clientCallSerde({ schema: opts.inputSchema, redaction }),
        outputSerde: clientCallSerde({ schema: opts.outputSchema, redaction }),
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      }),
  })
}

/** Internal seam used by the typed `Restate.call/send/objectClient/...` surface. */
export const inHandlerClients = { callRpc, sendRpc, callDescriptor } as const
