/**
 * `RestateTestEnv` — ONE contract-addressed invocation surface with TWO swappable
 * backends (decision 0017, docs/vrs/09-testing/spec.md). The SAME test body
 * (`invokeService(contract, method, input)`, NEVER `impl.method(input)`) runs on
 * either backend:
 *
 * - `RestateTestEnv.mock({ services, appLayer })` — in-process dispatch over per-key
 *   `Map`s and a shared awakeable registry, NO journal, NO server. Fast (ms): proves
 *   handler logic, typed success+error, typed State + per-key isolation,
 *   `Restate.run` journaled-once-within-an-invoke, deterministic time/rand/sleep, and
 *   awakeable resolve/await. Reuses the package's real building blocks (the in-memory
 *   `makeTestContext`, `Endpoint.provideHandlerCaps`, `determinismLayer`,
 *   `classifyOutcome`) — not a re-implementation of the semantics.
 * - `RestateTestEnv.real({ services, appLayer, alwaysReplay?, disableRetries? })` — a
 *   thin wrapper over the native-server `RestateTestHarness` (decision 0009). The
 *   full runtime: durability/replay/suspension, single-writer, cross-invocation,
 *   serde-on-the-wire, idempotency, OTel reparenting.
 *
 * THE KEY DECISION: `invoke*` carries `RestateError | ErrorOf` (the TYPED declared
 * error) on BOTH backends, so `catchTag(DomainError)` compiles identically. On the
 * mock the typed `E` is recovered by round-tripping the failure through the
 * contract's `error` schema — the SAME decode an ingress caller performs — so a
 * green mock test and a green real test assert through the identical channel.
 *
 * What the mock does NOT model (author these directly against `.real`, or keep them
 * in a dedicated `*.integration.test.ts`; the `kind` field +
 * `it.effect.skipIf(kind === 'real' && !serverAvailable)` is the gate):
 * durability/replay/suspension, exactly-once-across-attempts/retry,
 * single-writer/concurrency, cross-invocation calls/sends/reschedule/pollLoop,
 * admin-cancel, idempotency-keyed result attach, OTel attempt-span reparenting.
 */
import type { Scope } from 'effect'
import { Cause, Context, Effect, Exit, Layer, Option, Schema } from 'effect'

import {
  normalizeStateSchema,
  RestateContext,
  type StateSchemas,
  type StateValueType,
} from '../authoring/RestateContext.ts'
import type {
  Contract,
  ErrorOf,
  HandlerSpec,
  HandlerSpecMap,
  InputOf,
  MethodsOf,
  ObjectContract,
  ObjectErrorOf,
  ObjectHandlerSpec,
  ObjectInputOf,
  ObjectMethodsOf,
  ObjectSuccessOf,
  SuccessOf,
  WorkflowContract,
  WorkflowRunErrorOf,
  WorkflowRunInputOf,
  WorkflowRunSuccessOf,
  WorkflowSignalInputOf,
  WorkflowSignalQueryOf,
  WorkflowSignalSuccessOf,
} from '../authoring/Service.ts'
import { type AnyImplementation } from '../endpoint/Endpoint.ts'
import { classifyOutcome, type HandlerMarkers, provideHandlerCaps } from '../error/Boundary.ts'
import { determinismLayer } from '../runtime/Runtime.ts'
import { RestateError } from '../schema/RestateError.ts'
import { type AwakeableRegistry, makeAwakeableRegistry, makeTestContext } from './TestContext.ts'
import { RestateTestHarness, type RestateTestHarnessService, type StateProxy } from './testing.ts'

/* eslint-disable @typescript-eslint/no-explicit-any -- contract phantoms, mirroring the `Client`/`BoundIngress` signatures these mirror */

/** A contract that carries a typed `state` block (Object or Workflow). */
type StatefulContract<S extends StateSchemas> =
  | ObjectContract<string, S, any>
  | WorkflowContract<string, S, any, any, any>

/**
 * The CONTRACT-ADDRESSED invocation surface shared by both backends. Every method
 * is contract-addressed (`invokeService(contract, method, input)`), never bound to
 * a concrete `impl` — so the same body runs on the in-process mock OR the native
 * server. The `invoke*` channels carry `RestateError | ErrorOf` (the TYPED declared
 * error), so a `catchTag(DomainError)` compiles identically on either backend.
 */
export interface RestateTestEnvService {
  /** Whether this is the in-process mock or the native-server backend. */
  readonly kind: 'mock' | 'real'
  /**
   * Request/response call to a stateless Service handler. The `E` channel carries
   * the contract's TYPED declared error alongside `RestateError`, so a domain
   * failure (`EmptyName`) is `catchTag`-recoverable identically on both backends.
   */
  readonly invokeService: <
    C extends Contract<string, HandlerSpecMap>,
    M extends MethodsOf<C>,
  >(args: {
    contract: C
    method: M
    input: InputOf<C, M>
  }) => Effect.Effect<SuccessOf<C, M>, RestateError | ErrorOf<C, M>>
  /** Request/response call to a keyed Virtual Object handler (typed declared error in `E`). */
  readonly invokeObject: <
    C extends ObjectContract<string, any, any>,
    M extends ObjectMethodsOf<C>,
  >(args: {
    contract: C
    key: string
    method: M
    input: ObjectInputOf<C, M>
  }) => Effect.Effect<ObjectSuccessOf<C, M>, RestateError | ObjectErrorOf<C, M>>
  /**
   * Submit a Workflow `run` for a workflow id. On the mock this runs the `run`
   * handler in-process to completion (typed declared error in `E`); on the real
   * server it submits one-way and is followed by {@link attachWorkflow} for the
   * result. Use {@link attachWorkflow} for the awaited outcome on both backends.
   */
  readonly submitWorkflow: <C extends WorkflowContract<string, any, any, any, any>>(args: {
    contract: C
    key: string
    input: WorkflowRunInputOf<C>
  }) => Effect.Effect<void, RestateError | WorkflowRunErrorOf<C>>
  /** Call a Workflow SIGNAL or QUERY handler for a workflow id. */
  readonly signalWorkflow: <
    C extends WorkflowContract<string, any, any, any, any>,
    M extends WorkflowSignalQueryOf<C>,
  >(args: {
    contract: C
    key: string
    method: M
    input: WorkflowSignalInputOf<C, M>
  }) => Effect.Effect<WorkflowSignalSuccessOf<C, M>, RestateError>
  /** Attach to a submitted Workflow and await its `run` outcome (typed declared error in `E`). */
  readonly attachWorkflow: <C extends WorkflowContract<string, any, any, any, any>>(args: {
    contract: C
    key: string
  }) => Effect.Effect<WorkflowRunSuccessOf<C>, RestateError | WorkflowRunErrorOf<C>>
  /**
   * A typed State proxy for one Virtual Object / Workflow key (the SAME
   * {@link StateProxy} the harness exposes): `get` / `getAll` / `set` / `setAll`,
   * key+value typed against the contract's `state` block. Seed pre-conditions and
   * assert post-conditions without going through a handler — per-key isolation on
   * both backends.
   */
  readonly stateOf: <S extends StateSchemas>(args: {
    contract: StatefulContract<S>
    key: string
  }) => StateProxy<S>
  /**
   * Resolve an awakeable from OUTSIDE a handler — the ingress-side completion. On
   * the mock it completes a suspended handler via the env-scoped shared registry
   * (honest — an awakeable is just a promise); on the real server it routes through
   * ingress `resolveAwakeable`.
   */
  readonly resolveAwakeable: <T, I>(args: {
    schema: Schema.Codec<T, I>
    id: string
    payload: T
  }) => Effect.Effect<void, RestateError>
}

/** The env service tag. The `mock` / `real` statics below are the only constructors. */
export class RestateTestEnv extends Context.Service<RestateTestEnv, RestateTestEnvService>()(
  '@overeng/restate-effect/RestateTestEnv',
) {
  /**
   * The in-process MOCK backend: no journal, no server. Captures the
   * `Runtime<AppR>` from `appLayer` once, then dispatches each contract-addressed
   * invoke through the package's real building blocks — the in-memory
   * `makeTestContext`, `Endpoint.provideHandlerCaps` (the SAME per-kind marker
   * subset the real boundary grants), the journaled `determinismLayer`, and
   * `classifyOutcome` — against per-key `Map`s and a shared awakeable registry.
   *
   * `appLayer` is the consumer's application Layer; `RIn` is whatever it still
   * requires (usually `never`). The env output is `RestateTestEnv` (kind `'mock'`).
   */
  static mock = <AppR, RIn = never>(opts: {
    readonly services: ReadonlyArray<AnyImplementation<AppR>>
    readonly appLayer: Layer.Layer<AppR, never, RIn>
  }): Layer.Layer<RestateTestEnv, never, RIn> => Layer.effect(RestateTestEnv, makeMockEnv(opts))

  /**
   * The native-server REAL backend: a thin wrapper over the existing
   * `RestateTestHarness.layer` (decision 0009), adapting `h.ingress.*Typed` + `h.stateOf`
   * + an ingress `resolveAwakeable` to the contract-addressed surface. The full
   * runtime — durability/replay/suspension, single-writer, cross-invocation,
   * serde-on-the-wire, idempotency, OTel reparenting — so a real-only behavior is
   * authored against THIS backend. `alwaysReplay` / `disableRetries` mirror the
   * harness's determinism-hunting modes (docs/vrs/09-testing/spec.md §2).
   */
  static real = <AppR, RIn = never>(opts: {
    readonly services: ReadonlyArray<AnyImplementation<AppR>>
    readonly appLayer: Layer.Layer<AppR, never, RIn>
    readonly alwaysReplay?: boolean
    readonly disableRetries?: boolean
  }): Layer.Layer<RestateTestEnv, RestateError, RIn> =>
    RestateTestHarness.layer(opts).pipe(
      Layer.flatMap((ctx) =>
        Layer.succeed(RestateTestEnv, realEnv(Context.get(ctx, RestateTestHarness))),
      ),
    )
}

/* ════════════════════════════════════════════════════════════════════════
 * The `.real` adapter — `RestateTestHarness` → the contract-addressed surface.
 * ════════════════════════════════════════════════════════════════════════ */

/**
 * Adapt a booted `RestateTestHarness` to the contract-addressed surface (kind
 * `'real'`). The typed channels come straight from the harness's `ingress.*Typed`
 * wrappers (which preserve `RestateError | ErrorOf`); `submitWorkflow` is a one-way
 * submit and `attachWorkflow` awaits the typed result.
 */
const realEnv = (h: RestateTestHarnessService): RestateTestEnvService => ({
  kind: 'real',
  invokeService: ({ contract, method, input }) => h.ingress.callTyped({ contract, method, input }),
  invokeObject: ({ contract, key, method, input }) =>
    h.ingress.objectCallTyped({ contract, key, method, input }),
  submitWorkflow: ({ contract, key, input }) =>
    h.ingress.workflowSubmit({ contract, key, input }).pipe(Effect.asVoid),
  signalWorkflow: ({ contract, key, method, input }) =>
    h.ingress.workflowCall({ contract, key, method, input }),
  attachWorkflow: ({ contract, key }) => h.ingress.workflowAttach({ contract, key }),
  stateOf: ({ contract, key }) => h.stateOf({ contract, key }),
  resolveAwakeable: ({ schema, id, payload }) =>
    h.ingress.resolveAwakeable({ schema, id: id as never, payload }),
})

/* ════════════════════════════════════════════════════════════════════════
 * The `.mock` backend — in-process dispatch over per-key Maps + a shared registry.
 * ════════════════════════════════════════════════════════════════════════ */

/** Which handler kind a contract method materializes as (the marker subset, docs/vrs/01-authoring/spec.md §3). */
const objectHandlerKind = (spec: ObjectHandlerSpec): HandlerMarkers =>
  spec.shared === true ? 'objectShared' : 'objectExclusive'

/**
 * Classify a mock handler `Exit` into the env's typed channel — the in-process
 * analogue of the real boundary's `classifyOutcome` + an ingress caller's typed
 * decode (so the mock's `E` is IDENTICAL to what `callTyped`/`objectCallTyped`
 * produce on the real server):
 *
 * - success → succeed with the value.
 * - a declared domain failure (matches `errorSchema`) → FAIL with the typed error,
 *   ROUND-TRIPPED through the schema (encode→decode) exactly as ingress decodes a
 *   terminal body — so a `catchTag(DomainError)` recovers the same value shape.
 * - anything else (an undeclared failure, a defect, an interruption — there is no
 *   journal/replay/cancellation in-memory) → a `RestateError` DEFECT, mirroring the
 *   boundary terminalizing it (the test sees it as a defect, never a typed error).
 */
const classifyMockExit = ({
  exit,
  errorSchema,
}: {
  exit: Exit.Exit<unknown, unknown>
  errorSchema: Schema.Codec<unknown, unknown> | undefined
}): Effect.Effect<unknown, unknown> => {
  if (Exit.isSuccess(exit) === true) return Effect.succeed(exit.value)
  const outcome = classifyOutcome({
    cause: exit.cause,
    ...(errorSchema !== undefined ? { errorSchema } : {}),
  })
  /* A declared domain failure: recover the typed error by round-tripping the
   * ORIGINAL failure value through `errorSchema` (the same decode an ingress caller
   * performs on the terminal body), so the mock and the real backend fail with the
   * identical value. `terminal`/`retryable` both carry a domain `errorTag`. */
  if (
    (outcome._tag === 'terminal' || outcome._tag === 'retryable') &&
    outcome.errorTag !== undefined &&
    errorSchema !== undefined
  ) {
    const failure = Cause.findErrorOption(exit.cause)
    if (Option.isSome(failure) === true) {
      return Schema.encodeUnknownEffect(errorSchema)(failure.value).pipe(
        Effect.flatMap((encoded) => Schema.decodeUnknownEffect(errorSchema)(encoded)),
        Effect.orElseSucceed(() => failure.value),
        // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- re-fails with a value decoded from the user-supplied `errorSchema: Schema.Schema<unknown, unknown>`; there is no nameable error type at this dynamic-decode boundary.
        Effect.flatMap((decoded) => Effect.fail(decoded)),
      )
    }
  }
  /* No journal/replay/cancellation in-memory: any non-domain outcome is a defect. */
  return Effect.die(
    new RestateError({
      reason: 'RunFailed',
      method: 'RestateTestEnv.mock',
      cause: Cause.squash(exit.cause),
    }),
  )
}

/* A `SerdeFailed` mapper for the state proxy's encode/decode boundaries. */
const stateErr = (method: string) => (cause: unknown) =>
  new RestateError({ reason: 'SerdeFailed', method, cause })

/**
 * A typed `StateProxy` over an in-memory per-key State `Map` (the mock backend). The
 * inner `Map` is the SAME one the in-memory handler `ctx` reads/writes, which stores
 * the per-key Schema-ENCODED JS value (what `State.set`'s `Schema.encode` produces,
 * NOT the wire bytes the real server stores). So this proxy round-trips through the
 * SAME `Schema.encode` / `Schema.decodeUnknown` over `normalizeStateSchema` the
 * handler uses — a seed written here decodes identically inside a handler and
 * vice-versa, exactly as the real harness's Admin-API proxy does on the server.
 */
const mockStateProxy = <S extends StateSchemas>({
  contract,
  state,
}: {
  contract: StatefulContract<S>
  state: Map<string, unknown>
}): StateProxy<S> => {
  const schemas = contract.state
  const schemaFor = (key: string) => normalizeStateSchema(schemas[key]!)
  return {
    get: (key) =>
      state.has(key) === true
        ? Schema.decodeUnknownEffect(schemaFor(key))(state.get(key)).pipe(
            Effect.mapError(stateErr(`stateOf(${contract.name}).get(${key})`)),
          )
        : // @effect-diagnostics-next-line effectSucceedWithVoid:off -- `get` returns a meaningful `StateValueType | undefined` union (undefined = key absent), not void; `Effect.void` would break the `StateProxy.get` signature.
          Effect.succeed(undefined),
    getAll: Effect.forEach([...state.entries()], ([k, v]) =>
      Schema.decodeUnknownEffect(schemaFor(k))(v).pipe(
        Effect.map((decoded) => [k, decoded] as const),
      ),
    ).pipe(
      Effect.map(
        (pairs) => Object.fromEntries(pairs) as { readonly [K in keyof S]?: StateValueType<S[K]> },
      ),
      Effect.mapError(stateErr(`stateOf(${contract.name}).getAll`)),
    ),
    set: ({ key, value }) =>
      /* `set(key, undefined)` on an OPTIONAL field REMOVES the key (≡ `clear`),
       * matching the in-handler `State.set` semantics: an absent key reads back as
       * `undefined`, so the present-value serde is never asked to encode it (#1). */
      value === undefined
        ? Effect.sync(() => {
            state.delete(key)
          })
        : Schema.encodeEffect(schemaFor(key))(value).pipe(
            Effect.map((encoded) => {
              state.set(key, encoded)
            }),
            Effect.mapError(stateErr(`stateOf(${contract.name}).set(${key})`)),
          ),
    clear: (key) =>
      Effect.sync(() => {
        state.delete(key)
      }),
    setAll: (values) =>
      Effect.forEach(
        Object.entries(values).filter(([, v]) => v !== undefined),
        ([k, v]) =>
          Schema.encodeEffect(schemaFor(k))(v).pipe(Effect.map((encoded) => [k, encoded] as const)),
      ).pipe(
        Effect.map((pairs) => {
          state.clear()
          for (const [k, encoded] of pairs) state.set(k, encoded)
        }),
        Effect.mapError(stateErr(`stateOf(${contract.name}).setAll`)),
      ),
  }
}

/** Build the in-process mock env. Captures the runtime once, then dispatches per invoke. */
const makeMockEnv = <AppR, RIn>(opts: {
  readonly services: ReadonlyArray<AnyImplementation<AppR>>
  readonly appLayer: Layer.Layer<AppR, never, RIn>
}): Effect.Effect<RestateTestEnvService, never, Scope.Scope | RIn> =>
  Effect.gen(function* () {
    /* 1. Capture the application `Runtime<AppR>` ONCE from `appLayer`, into the env
     * scope (so its scoped resources are torn down with the env — the ambient
     * `Scope.Scope` is provided by the `Layer.effect` this runs under). */
    const runtime = yield* Layer.build(opts.appLayer)

    /* 2. Per-key State: `${service}/${key}` → the inner State `Map` (so object /
     * workflow key isolation is free). `stateOf` reads/writes the SAME inner map. */
    const stateMaps = new Map<string, Map<string, unknown>>()
    const stateMapFor = ({
      service,
      key,
    }: {
      service: string
      key: string
    }): Map<string, unknown> => {
      const id = `${service}/${key}`
      const existing = stateMaps.get(id)
      if (existing !== undefined) return existing
      const fresh = new Map<string, unknown>()
      stateMaps.set(id, fresh)
      return fresh
    }

    /* 3. A SHARED awakeable registry at ENV scope, so a `resolveAwakeable` from
     * OUTSIDE a handler completes a suspended handler (honest — it's a promise). */
    const awakeables: AwakeableRegistry = makeAwakeableRegistry()

    /* 4. Lookup each implementation by its contract name, so a contract-addressed
     * invoke finds the impl fn + spec for `(contract, method)`. */
    const byName = new Map<string, AnyImplementation<AppR>>()
    for (const impl of opts.services) byName.set(impl.contract.name, impl)

    const implFor = (name: string): AnyImplementation<AppR> => {
      const impl = byName.get(name)
      if (impl === undefined) {
        throw new Error(
          `RestateTestEnv.mock: no service registered for contract '${name}' (registered: ${[...byName.keys()].join(', ') || 'none'})`,
        )
      }
      return impl
    }

    /**
     * The core mock dispatch: find the impl fn for `(service, method)`, build the
     * in-memory `ctx` over the per-key State `Map` + shared registry, provide the
     * SAME marker subset `materialize*` provides (via `provideHandlerCaps`), run on
     * the captured runtime under `determinismLayer`, then classify the exit via the
     * EXISTING `classifyOutcome(cause, spec.error)` → the typed domain error in `E`
     * or a `RestateError` defect (matching what an ingress caller decodes).
     */
    const invoke = (params: {
      readonly service: string
      readonly method: string
      readonly key: string | undefined
      readonly markers: HandlerMarkers
      readonly spec: HandlerSpec
      readonly input: unknown
    }): Effect.Effect<unknown, unknown> =>
      Effect.gen(function* () {
        const impl = implFor(params.service)
        const run = (
          impl.impl as Record<string, (input: unknown) => Effect.Effect<unknown, unknown, unknown>>
        )[params.method]
        if (run === undefined) {
          return yield* Effect.die(
            new Error(
              `RestateTestEnv.mock: handler '${params.method}' not found on '${params.service}'`,
            ),
          )
        }
        /* The in-memory ctx is bound to the per-key State map + the shared awakeable
         * registry. A plain Service has no key (an empty inner map, never read). */
        const handle = makeTestContext({
          state:
            params.key !== undefined
              ? stateMapFor({ service: params.service, key: params.key })
              : new Map<string, unknown>(),
          ...(params.key !== undefined ? { key: params.key } : {}),
          handlerKind: params.markers,
          awakeables,
        })
        /* Seed the determinism layer's frozen sync base ONCE from the (deterministic)
         * in-memory `ctx.date.now()` — mirroring `runEffectHandler`'s handler-entry seed. */
        const frozenBaseMillis = yield* Effect.promise(() => handle.context.date.now())
        /* Provide `RestateContext` + the per-kind markers (the SAME subset the real
         * boundary grants) + the journaled determinism layer, then run on the
         * captured `Runtime<AppR>` to an Exit and classify it via the SAME
         * `classifyOutcome` the real boundary uses. */
        /* The handler `run` is dispatched by runtime string from a type-erased
         * `Record<string, (input: unknown) => Effect.Effect<unknown, unknown, unknown>>`
         * and `params.spec.error` is `Schema.Schema<any, any>`, so the error/requirements
         * channels are STRUCTURALLY un-nameable here — `provideHandlerCaps` is already
         * generic `<A, E, R>`, so the `unknown` originates at this dynamic-dispatch source,
         * not in the helper. This mirrors the real boundary in `endpoint/Endpoint.ts`, which
         * waives the identical construct the same way. Each directive covers every
         * column-diagnostic on the line it precedes. */
        // @effect-diagnostics-next-line anyUnknownInErrorContext:off
        const program = provideHandlerCaps({
          // @effect-diagnostics-next-line anyUnknownInErrorContext:off
          effect: run(params.input).pipe(Effect.provideService(RestateContext, handle.context)),
          markers: params.markers,
          key: params.key,
        }).pipe(Effect.provide(determinismLayer({ ctx: handle.context, frozenBaseMillis })))
        const exit = yield* Effect.promise(() =>
          // @effect-diagnostics-next-line anyUnknownInErrorContext:off
          Effect.runPromiseExitWith(runtime)(program as Effect.Effect<unknown, unknown, AppR>),
        )
        // @effect-diagnostics-next-line anyUnknownInErrorContext:off
        return yield* classifyMockExit({ exit, errorSchema: params.spec.error })
      })

    return {
      kind: 'mock',
      invokeService: ((args: {
        contract: Contract<string, HandlerSpecMap>
        method: string
        input: unknown
      }) =>
        // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- `invoke` returns `Effect.Effect<unknown, unknown>` (dynamic-dispatch source); the typed public channel is recovered by the `as RestateTestEnvService[...]` cast on this expression.
        invoke({
          service: args.contract.name,
          method: args.method,
          key: undefined,
          markers: 'service',
          spec: args.contract.handlers[args.method]!,
          input: args.input,
        })) as RestateTestEnvService['invokeService'],
      invokeObject: ((args: {
        contract: ObjectContract<string, any, any>
        key: string
        method: string
        input: unknown
      }) =>
        // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- `invoke` returns `Effect.Effect<unknown, unknown>` (dynamic-dispatch source); the typed public channel is recovered by the `as RestateTestEnvService[...]` cast on this expression.
        invoke({
          service: args.contract.name,
          method: args.method,
          key: args.key,
          markers: objectHandlerKind(args.contract.handlers[args.method] as ObjectHandlerSpec),
          spec: args.contract.handlers[args.method] as HandlerSpec,
          input: args.input,
        })) as RestateTestEnvService['invokeObject'],
      submitWorkflow: ((args: {
        contract: WorkflowContract<string, any, any, any, any>
        key: string
        input: unknown
      }) =>
        // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- `invoke` returns `Effect.Effect<unknown, unknown>` (dynamic-dispatch source); the typed public channel is recovered by the `as RestateTestEnvService[...]` cast on this expression.
        invoke({
          service: args.contract.name,
          method: 'run',
          key: args.key,
          markers: 'workflowRun',
          spec: args.contract.run as HandlerSpec,
          input: args.input,
        }).pipe(Effect.asVoid)) as RestateTestEnvService['submitWorkflow'],
      signalWorkflow: ((args: {
        contract: WorkflowContract<string, any, any, any, any>
        key: string
        method: string
        input: unknown
      }) =>
        // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- `invoke` returns `Effect.Effect<unknown, unknown>` (dynamic-dispatch source); the typed public channel is recovered by the `as RestateTestEnvService[...]` cast on this expression.
        invoke({
          service: args.contract.name,
          method: args.method,
          key: args.key,
          markers: 'workflowShared',
          spec: (args.contract.signals[args.method] ??
            args.contract.queries[args.method]) as HandlerSpec,
          input: args.input,
        })) as RestateTestEnvService['signalWorkflow'],
      /* On the mock, `submitWorkflow` already ran `run` to completion in-process, so
       * `attachWorkflow` re-runs the SAME `run` to recover its typed outcome (the
       * handler is deterministic over the seeded State). The real backend awaits the
       * actual durable result. */
      attachWorkflow: ((args: {
        contract: WorkflowContract<string, any, any, any, any>
        key: string
      }) =>
        // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- `invoke` returns `Effect.Effect<unknown, unknown>` (dynamic-dispatch source); the typed public channel is recovered by the `as RestateTestEnvService[...]` cast on this expression.
        invoke({
          service: args.contract.name,
          method: 'run',
          key: args.key,
          markers: 'workflowRun',
          spec: args.contract.run as HandlerSpec,
          input: undefined,
        })) as RestateTestEnvService['attachWorkflow'],
      stateOf: (<S extends StateSchemas>(args: { contract: StatefulContract<S>; key: string }) =>
        mockStateProxy({
          contract: args.contract,
          state: stateMapFor({ service: args.contract.name, key: args.key }),
        })) as RestateTestEnvService['stateOf'],
      resolveAwakeable: ((args: {
        schema: Schema.Codec<unknown, unknown>
        id: string
        payload: unknown
      }) =>
        Effect.sync(() => {
          awakeables.pending.get(args.id)?.resolve(args.payload)
        })) as RestateTestEnvService['resolveAwakeable'],
    }
  })

/* eslint-enable @typescript-eslint/no-explicit-any */
