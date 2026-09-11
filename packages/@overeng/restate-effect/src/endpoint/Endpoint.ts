import * as http2 from 'node:http2'

import * as restate from '@restatedev/restate-sdk'
import { createEndpointHandler } from '@restatedev/restate-sdk/node'
import type { Config, Schema, Scope } from 'effect'
import { Context, Duration, Effect, Exit, Layer, Option } from 'effect'

import { RestateContext, type StateSchemas } from '../authoring/RestateContext.ts'
import type {
  Contract,
  HandlerOptions,
  HandlerSpec,
  HandlerSpecMap,
  ObjectContract,
  ObjectHandlerSpec,
  ObjectHandlerSpecMap,
  ObjectImplementation,
  RetryPolicyOptions,
  ServiceImplementation,
  ServiceLevelOptions,
  WorkflowContract,
  WorkflowHandlerSpec,
  WorkflowHandlerSpecMap,
  WorkflowImplementation,
} from '../authoring/Service.ts'
import { contractSerdeFactory } from '../clients/InvocationPolicy.ts'
import {
  type BoundaryObserver,
  classifyOutcome,
  type EndpointHooks,
  type HandlerMarkers,
  type HandlerWrap,
  provideHandlerCaps,
} from '../error/Boundary.ts'
import { emitAttempt, emitInvocationMetrics, monotonicMs } from '../observability/Metrics.ts'
import { determinismLayer, loggerLayer, withAttemptInterruption } from '../runtime/Runtime.ts'
import {
  readRetention,
  type RetentionOptions,
  validateInputAnnotations,
} from '../schema/Annotations.ts'
import { type RedactionCipher, RestateRedaction } from '../schema/Redaction.ts'
import { RestateError } from '../schema/RestateError.ts'

/* eslint-disable @typescript-eslint/no-explicit-any -- the materialize boundary deliberately erases the contract's phantom map (invisible to users; the public Contract type stays precise) */

/* An untyped Effect handler bound to a single contract handler. */
type EffectHandler = (input: unknown) => Effect.Effect<unknown, unknown, any>

/* The original-invocation header carrying the idempotency key (verified against
 * `@restatedev/restate-sdk-clients` 1.14.5: `IDEMPOTENCY_KEY_HEADER`). Lower-cased
 * — HTTP header names are case-insensitive and the SDK stores them lower-cased. */
const IDEMPOTENCY_KEY_HEADER = 'idempotency-key'

/**
 * Read the idempotency key off the ORIGINAL invocation request headers (decision
 * 0014, #5). It rides as the `idempotency-key` header on the original invocation
 * (NOT the attempt headers), so it is replay-stable across attempts. Defensive:
 * `ctx.request()` may be unavailable on a non-handler context shape — returns
 * `undefined` rather than throwing, so the boundary never fails on a missing key.
 */
const readIdempotencyKeyHeader = (ctx: restate.Context): string | undefined => {
  try {
    const headers = (
      ctx as { request?: () => { headers?: ReadonlyMap<string, string> } }
    ).request?.()?.headers
    if (headers === undefined) return undefined
    const direct = headers.get(IDEMPOTENCY_KEY_HEADER)
    if (direct !== undefined) return direct
    /* Be tolerant of a non-lower-cased header key. */
    for (const [k, v] of headers) {
      if (k.toLowerCase() === IDEMPOTENCY_KEY_HEADER) return v
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Provide `RestateContext` (always) plus the capability markers legal for this
 * handler kind (docs/vrs/01-authoring/spec.md §3), the per-invocation determinism layer (journaled
 * Clock/Random, R17) and the cancellation↔interruption bridge (R31), run the
 * user's Effect on the captured runtime, and map the exit to a return value or a
 * thrown `TerminalError`/retryable error. The `provide` set is per-kind so an
 * illegal `State.set` in a shared handler is a COMPILE error and the residual `R`
 * collapses to `AppR` at runtime.
 *
 * The sync-clock frozen base is seeded ONCE here at handler entry from
 * `ctx.date.now()` (journaled), so `Clock.unsafeCurrentTime*` reads are
 * replay-stable and do not advance mid-attempt (R17, decision 0004).
 */
const runEffectHandler =
  <AppR>(opts: {
    readonly service: string
    readonly handler: string
    readonly run: EffectHandler
    readonly errorSchema: Schema.Codec<any, any> | undefined
    readonly runtime: Context.Context<AppR>
    readonly markers: HandlerMarkers
    /* The inbound-bridge transform (`./otel` supplies it; undefined in the
     * otel-free core). Applied INSIDE the handler so `trace.getActiveSpan()`
     * (the hook's attempt span, set active via `context.with` around this fn)
     * resolves at capture time and reparents the Effect program (R23, docs/vrs/08-observability/spec.md). */
    readonly inboundBridge: HandlerWrap | undefined
    /* The observability boundary observer (`./otel` supplies it; undefined in the
     * otel-free core). Invoked at entry with the per-invocation identity, then at
     * exit with the classified outcome, so `./otel` stamps span attributes + emits
     * the per-invocation metric (decision 0014). */
    readonly boundaryObserver: BoundaryObserver | undefined
  }) =>
  // oxlint-disable-next-line overeng/named-args -- the materialized SDK handler: Restate invokes it positionally as (ctx, input)
  async (ctx: restate.Context, input: unknown): Promise<unknown> => {
    /* Seed the per-attempt frozen monotonic base ONCE from journaled time. */
    const frozenBaseMillis = await ctx.date.now()
    /* Open the boundary observation at handler ENTRY (the hook's attempt span is
     * active here), with the construct/handler identity + Object/Workflow key. A
     * plain Service has no `key` (undefined). The WORKFLOW ID is the key of a
     * Workflow handler (markers `workflowRun`/`workflowShared`); the IDEMPOTENCY KEY
     * comes from the original-invocation header (auto-stamped so consumers do not
     * hand-roll them, #5). */
    const key = opts.markers !== 'service' ? (ctx as restate.ObjectContext).key : undefined
    const isWorkflow = opts.markers === 'workflowRun' || opts.markers === 'workflowShared'
    const onOutcome =
      opts.boundaryObserver !== undefined
        ? opts.boundaryObserver({
            service: opts.service,
            handler: opts.handler,
            key,
            workflowId: isWorkflow === true ? key : undefined,
            idempotencyKey: readIdempotencyKeyHeader(ctx),
          })
        : undefined
    /* AUTO baseline metrics (decision 0014): the per-attempt counter at ENTRY +
     * the per-invocation outcome/duration at EXIT, run on the CAPTURED runtime so
     * they reach the bound OTel meter (when `RestateOtel.layer` provides it; a
     * harmless in-memory Effect metric otherwise). Both are exactly-once-gated on
     * `ctx.isProcessing()` inside the emit (replays do not re-increment). The
     * start is a monotonic real-time read — only used on a real (non-replay) emit. */
    const attemptStartMs = monotonicMs()
    Effect.runSyncWith(opts.runtime)(
      emitAttempt({ ctx, service: opts.service, handler: opts.handler }),
    )
    /* DYNAMIC USER-HANDLER DISPATCH BOUNDARY (next ~20 lines, through `runPromiseExit`):
     * this materializes an ARBITRARY user `opts.run: EffectHandler` (whose error +
     * requirements channels are intentionally un-nameable here) into the single
     * positional SDK callback. The `any`/`unknown` in the error/requirements channels
     * is STRUCTURAL — there is no more specific type without parameterizing the public
     * `EffectHandler` contract — so `anyUnknownInErrorContext` is waived per-site below.
     * Each `@effect-diagnostics-next-line` covers every column-diagnostic on the line it
     * precedes (145/154/160 each carry several). */
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off
    const effect = provideHandlerCaps({
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off
      effect: opts.run(input).pipe(Effect.provideService(RestateContext, ctx)),
      markers: opts.markers,
      key: opts.markers !== 'service' ? (ctx as restate.ObjectContext).key : undefined,
    })
    /* Bridge the attempt-completed signal to interruption (R31), then provide the
     * journaled Clock/Random (R17) AND the replay-aware logger (decision 0015 —
     * routes `Effect.log*` through `ctx.console`, suppressed on replay) over the
     * handler. The per-invocation layers wrap OUTSIDE the interruption bridge so
     * the forked fiber inherits them. */
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off
    const bridged = withAttemptInterruption({ ctx, effect }).pipe(
      Effect.provide(Layer.merge(determinismLayer({ ctx, frozenBaseMillis }), loggerLayer(ctx))),
    )
    /* Reparent under the OTel attempt span (no-op in the core; `./otel` supplies
     * the transform). Applied last so the active span is read at runtime, inside
     * the hook's `context.with` window, just before the program runs (R23). */
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off
    const program = opts.inboundBridge !== undefined ? opts.inboundBridge(bridged) : bridged
    const exit = await Effect.runPromiseExitWith(opts.runtime)(
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off
      program as Effect.Effect<unknown, unknown, AppR>,
    )
    const emitInvocation = (
      outcomeTag: 'success' | 'terminal' | 'retryable' | 'cancelled',
    ): void => {
      Effect.runSyncWith(opts.runtime)(
        emitInvocationMetrics({
          ctx,
          service: opts.service,
          handler: opts.handler,
          outcome: outcomeTag,
          durationMs: monotonicMs() - attemptStartMs,
        }),
      )
    }
    if (Exit.isSuccess(exit) === true) {
      onOutcome?.({ _tag: 'success' })
      emitInvocation('success')
      return exit.value
    }
    const outcome = classifyOutcome({
      cause: exit.cause,
      ...(opts.errorSchema !== undefined ? { errorSchema: opts.errorSchema } : {}),
    })
    onOutcome?.(outcome)
    /* Count a TERMINAL outcome (success/terminal/cancelled — the invocation truly
     * ends) or a retryable failed attempt; `suspended`/`defect` are NOT terminal
     * outcomes (the invocation parks/retries), so they are not counted here. */
    if (
      outcome._tag === 'terminal' ||
      outcome._tag === 'retryable' ||
      outcome._tag === 'cancelled'
    ) {
      emitInvocation(outcome._tag)
    }
    throw outcome._tag === 'success' ? undefined : outcome.thrown
  }

/* Map the typed `retryPolicy` option to the SDK `RetryPolicy` (decision 0006,
 * docs/vrs/04-error-boundary/spec.md §3). Intervals are already millis (the SDK accepts a number = millis). */
const mapRetryPolicy = (p: RetryPolicyOptions): Record<string, unknown> => ({
  ...(p.maxAttempts !== undefined ? { maxAttempts: p.maxAttempts } : {}),
  ...(p.onMaxAttempts !== undefined ? { onMaxAttempts: p.onMaxAttempts } : {}),
  ...(p.initialIntervalMillis !== undefined ? { initialInterval: p.initialIntervalMillis } : {}),
  ...(p.maxIntervalMillis !== undefined ? { maxInterval: p.maxIntervalMillis } : {}),
  ...(p.exponentiationFactor !== undefined ? { exponentiationFactor: p.exponentiationFactor } : {}),
})

/* Millis for a `Duration.Input` (the SDK retention options take a number = millis). */
const durationToMillis = (d: Duration.Input): number =>
  Duration.toMillis(Duration.fromInputUnsafe(d))

/* Map a `Restate.retention` annotation (decision 0011) to the SDK retention
 * options. `workflow` is dropped unless the construct is a Workflow (the caller
 * decides via `includeWorkflow`). Builder `options` win over the annotation. */
const mapRetention = ({
  retention,
  includeWorkflow,
}: {
  retention: RetentionOptions
  includeWorkflow: boolean
}): Record<string, unknown> => ({
  ...(retention.idempotency !== undefined
    ? { idempotencyRetention: durationToMillis(retention.idempotency) }
    : {}),
  ...(retention.journal !== undefined
    ? { journalRetention: durationToMillis(retention.journal) }
    : {}),
  ...(includeWorkflow === true && retention.workflow !== undefined
    ? { workflowRetention: durationToMillis(retention.workflow) }
    : {}),
})

/**
 * Map a handler spec's serde (R07) + surfaced R35/retry options into the SDK opts
 * bag. The `retention` annotation on the handler's INPUT schema (decision 0011)
 * is folded in first; explicit `spec.options` (incl. its own retention) win.
 * `redaction` (resolved from the runtime context at `materialize`) is threaded
 * into the I/O serdes so `sensitive` fields are encrypted on the wire (docs/vrs/02-schema-serde/spec.md §1).
 */
const handlerOpts = ({
  spec,
  redaction,
}: {
  spec: {
    readonly input: Schema.Codec<any, any>
    readonly success: Schema.Codec<any, any>
    readonly options?: HandlerOptions
  }
  redaction: RedactionCipher | undefined
}): Record<string, unknown> => {
  /* Derive the redaction-threaded I/O serdes through the SHARED contract-invocation
   * policy (decision 0020) — the SAME factory the ingress + in-handler clients use,
   * so a `Restate.sensitive` field is encrypted identically on the served handler's
   * I/O. Handler I/O is a caller-facing boundary → the `ingress` slot. */
  const { input, output } = contractSerdeFactory(redaction).forHandler({ spec, slot: 'ingress' })
  const annotated = readRetention(spec.input.ast).pipe(Option.getOrUndefined)
  return {
    input,
    output,
    ...(annotated !== undefined
      ? mapRetention({ retention: annotated, includeWorkflow: false })
      : {}),
    ...mapHandlerOptions(spec.options),
  }
}

/**
 * Validate the field-annotation placement of every handler input in a contract
 * (decision 0020) — a `Restate.idempotencyKey`/`sensitive` on the STRUCT (wrong
 * AST node → silent no-op) or a DUPLICATE idempotency field. A misplacement is a
 * latent bug (the annotation does nothing), so `materialize*` FAILS LOUDLY here
 * with a clear, aggregated diagnostic rather than serving a contract whose
 * annotation silently does nothing. Runs once per `materialize*` (cheap — an AST
 * walk over the already-built schemas).
 */
const validateContractAnnotations = ({
  contractName,
  handlerInputs,
}: {
  contractName: string
  handlerInputs: ReadonlyArray<readonly [string, Schema.Codec<any, any>]>
}): void => {
  const violations = handlerInputs.flatMap(([handler, input]) =>
    validateInputAnnotations({ ast: input.ast, label: `${contractName}.${handler}` }),
  )
  if (violations.length > 0) {
    throw new RestateError({
      reason: 'EndpointFailed',
      method: `materialize(${contractName})`,
      cause: new Error(
        `invalid Restate annotation placement:\n` +
          violations.map((v) => `  - ${v.message}`).join('\n'),
      ),
    })
  }
}

const mapHandlerOptions = (o?: HandlerOptions): Record<string, unknown> =>
  o === undefined
    ? {}
    : {
        ...(o.idempotencyRetentionMillis !== undefined
          ? { idempotencyRetention: o.idempotencyRetentionMillis }
          : {}),
        ...(o.journalRetentionMillis !== undefined
          ? { journalRetention: o.journalRetentionMillis }
          : {}),
        ...(o.inactivityTimeoutMillis !== undefined
          ? { inactivityTimeout: o.inactivityTimeoutMillis }
          : {}),
        ...(o.abortTimeoutMillis !== undefined ? { abortTimeout: o.abortTimeoutMillis } : {}),
        ...(o.ingressPrivate !== undefined ? { ingressPrivate: o.ingressPrivate } : {}),
        ...(o.enableLazyState !== undefined ? { enableLazyState: o.enableLazyState } : {}),
        ...(o.explicitCancellation !== undefined
          ? { explicitCancellation: o.explicitCancellation }
          : {}),
        ...(o.retryPolicy !== undefined ? { retryPolicy: mapRetryPolicy(o.retryPolicy) } : {}),
        ...(o.asTerminalError !== undefined ? { asTerminalError: o.asTerminalError } : {}),
      }

const mapServiceOptions = (o?: ServiceLevelOptions): Record<string, unknown> | undefined =>
  o === undefined
    ? undefined
    : {
        ...mapHandlerOptions(o),
        ...(o.workflowRetentionMillis !== undefined
          ? { workflowRetention: o.workflowRetentionMillis }
          : {}),
      }

/**
 * The endpoint-level wiring `materialize*` thread into every service: the
 * Restate `hooks` (e.g. the otel `openTelemetryHook`, attached SERVICE-level so
 * they wrap every handler) and the per-invocation inbound-bridge transform. Both
 * are supplied by `layer`/`serve` (and ultimately the `./otel` module); the core
 * itself imports no otel package.
 */
export interface MaterializeWiring {
  readonly hooks?: ReadonlyArray<EndpointHooks> | undefined
  readonly inboundBridge?: HandlerWrap | undefined
  readonly boundaryObserver?: BoundaryObserver | undefined
}

/**
 * Resolve the optional `RestateRedaction` cipher from the captured runtime's
 * context (decision 0011, docs/vrs/02-schema-serde/spec.md §1). It is OPTIONAL: a schema with no `sensitive`
 * field never needs it, so the application Layer need not provide one. When a
 * served schema DOES have a sensitive field but the cipher is absent, the serde
 * fails with a clear `RedactionCipherMissingError` at encode/decode — never
 * plaintext (see `./Redaction.ts`). Resolved once per `materialize*`.
 */
const resolveRedaction = <AppR>(runtime: Context.Context<AppR>): RedactionCipher | undefined =>
  Context.getOption(runtime, RestateRedaction).pipe(Option.getOrUndefined)

/* Build the service-level `options.hooks` fragment from the wiring (omitted when
 * no hooks are configured, so the otel-free path produces an identical bag). The
 * array is copied to a mutable `HooksProvider[]` (the SDK's expected shape). */
const serviceHooksOptions = (
  wiring?: MaterializeWiring,
): { readonly options?: { readonly hooks: Array<EndpointHooks> } } =>
  wiring?.hooks !== undefined && wiring.hooks.length > 0
    ? { options: { hooks: [...wiring.hooks] } }
    : {}

/* Merge the wiring's service-level `hooks` into an existing service-options bag
 * (Objects/Workflows already build one from `ServiceLevelOptions`). */
const withHooks = ({
  serviceOptions,
  wiring,
}: {
  serviceOptions: Record<string, unknown> | undefined
  wiring?: MaterializeWiring
}): Record<string, unknown> | undefined => {
  const hooks =
    wiring?.hooks !== undefined && wiring.hooks.length > 0 ? [...wiring.hooks] : undefined
  if (hooks === undefined) return serviceOptions
  return { ...serviceOptions, hooks }
}

/**
 * Materialize a Service `ServiceImplementation` into a runtime `restate.service`.
 * Each handler runs the user's Effect on the CAPTURED runtime (built once from
 * the application Layer), with `RestateContext` provided PER INVOCATION, and
 * maps the exit to a return value or a thrown `TerminalError`/retryable error.
 *
 * `AppR` is EXPLICIT (from `Context.Context<AppR>`) — never inferred from
 * handler bodies (decision 0002). The contract's precise phantom map survives on
 * the public type; only this boundary widens to `any` (invisible to users).
 */
export const materialize = <AppR>({
  implementation,
  runtime,
  wiring,
}: {
  implementation: ServiceImplementation<Contract<string, HandlerSpecMap>, AppR>
  runtime: Context.Context<AppR>
  wiring?: MaterializeWiring
}): restate.ServiceDefinition<string, unknown> => {
  const { contract, impl } = implementation
  validateContractAnnotations({
    contractName: contract.name,
    handlerInputs: Object.entries(contract.handlers).map(
      ([n, s]: [string, HandlerSpec]) => [n, s.input] as const,
    ),
  })
  const redaction = resolveRedaction(runtime)
  const handlers = Object.fromEntries(
    Object.entries(contract.handlers).map(([name, spec]: [string, HandlerSpec]) => {
      const run = (impl as Record<string, EffectHandler>)[name]!
      return [
        name,
        restate.handlers.handler(
          handlerOpts({ spec, redaction }),
          runEffectHandler({
            service: contract.name,
            handler: name,
            run,
            errorSchema: spec.error,
            runtime,
            markers: 'service',
            inboundBridge: wiring?.inboundBridge,
            boundaryObserver: wiring?.boundaryObserver,
          }),
        ),
      ]
    }),
  )
  const serviceOptions = withHooks({
    serviceOptions: mapServiceOptions(contract.options),
    ...(wiring !== undefined ? { wiring } : {}),
  })
  return restate.service({
    name: contract.name,
    handlers,
    ...(serviceOptions !== undefined ? { options: serviceOptions } : serviceHooksOptions(wiring)),
  } as unknown as Parameters<typeof restate.service>[0]) as restate.ServiceDefinition<
    string,
    unknown
  >
}

/**
 * Materialize an `ObjectImplementation` into a runtime `restate.object`. Each
 * EXCLUSIVE handler gets `ObjectKey + StateRead + StateWrite`; each `shared: true`
 * handler is wrapped with `restate.handlers.object.shared(...)` and gets
 * `ObjectKey + StateRead` only (read-only — a `State.set` there does not
 * typecheck). `AppR` is explicit (decision 0002).
 */
export const materializeObject = <AppR>({
  implementation,
  runtime,
  wiring,
}: {
  implementation: ObjectImplementation<
    ObjectContract<string, StateSchemas, ObjectHandlerSpecMap>,
    AppR
  >
  runtime: Context.Context<AppR>
  wiring?: MaterializeWiring
}): restate.VirtualObjectDefinition<string, unknown> => {
  const { contract, impl } = implementation
  validateContractAnnotations({
    contractName: contract.name,
    handlerInputs: Object.entries(contract.handlers).map(
      ([n, s]: [string, ObjectHandlerSpec]) => [n, s.input] as const,
    ),
  })
  const redaction = resolveRedaction(runtime)
  const handlers = Object.fromEntries(
    Object.entries(contract.handlers).map(([name, spec]: [string, ObjectHandlerSpec]) => {
      const run = (impl as Record<string, EffectHandler>)[name]!
      const opts = handlerOpts({ spec, redaction })
      const handler =
        spec.shared === true
          ? restate.handlers.object.shared(
              opts,
              runEffectHandler({
                service: contract.name,
                handler: name,
                run,
                errorSchema: spec.error,
                runtime,
                markers: 'objectShared',
                inboundBridge: wiring?.inboundBridge,
                boundaryObserver: wiring?.boundaryObserver,
              }),
            )
          : restate.handlers.object.exclusive(
              opts,
              runEffectHandler({
                service: contract.name,
                handler: name,
                run,
                errorSchema: spec.error,
                runtime,
                markers: 'objectExclusive',
                inboundBridge: wiring?.inboundBridge,
                boundaryObserver: wiring?.boundaryObserver,
              }),
            )
      return [name, handler]
    }),
  )
  const serviceOptions = withHooks({
    serviceOptions: mapServiceOptions(contract.options),
    ...(wiring !== undefined ? { wiring } : {}),
  })
  return restate.object({
    name: contract.name,
    handlers,
    ...(serviceOptions !== undefined ? { options: serviceOptions } : {}),
  } as unknown as Parameters<typeof restate.object>[0]) as restate.VirtualObjectDefinition<
    string,
    unknown
  >
}

/**
 * Materialize a `WorkflowImplementation` into a runtime `restate.workflow`. The
 * single `run` handler gets the full set (`ObjectKey + StateRead + StateWrite +
 * DurablePromise`); each signal/query is wrapped with
 * `restate.handlers.workflow.shared(...)` and gets `ObjectKey + StateRead +
 * DurablePromise` (read-only State + durable promises). `AppR` is explicit.
 */
export const materializeWorkflow = <AppR>({
  implementation,
  runtime,
  wiring,
}: {
  implementation: WorkflowImplementation<
    WorkflowContract<
      string,
      StateSchemas,
      WorkflowHandlerSpec,
      WorkflowHandlerSpecMap,
      WorkflowHandlerSpecMap
    >,
    AppR
  >
  runtime: Context.Context<AppR>
  wiring?: MaterializeWiring
}): restate.WorkflowDefinition<string, unknown> => {
  const { contract, impl } = implementation
  validateContractAnnotations({
    contractName: contract.name,
    handlerInputs: [
      ['run', contract.run.input] as const,
      ...Object.entries(contract.signals).map(
        ([n, s]: [string, WorkflowHandlerSpec]) => [n, s.input] as const,
      ),
      ...Object.entries(contract.queries).map(
        ([n, s]: [string, WorkflowHandlerSpec]) => [n, s.input] as const,
      ),
    ],
  })
  const redaction = resolveRedaction(runtime)
  const implMap = impl as Record<string, EffectHandler>
  const runSpec = contract.run
  const runHandler = restate.handlers.workflow.workflow(
    handlerOpts({ spec: runSpec, redaction }),
    runEffectHandler({
      service: contract.name,
      handler: 'run',
      run: implMap['run']!,
      errorSchema: runSpec.error,
      runtime,
      markers: 'workflowRun',
      inboundBridge: wiring?.inboundBridge,
      boundaryObserver: wiring?.boundaryObserver,
    }),
  )
  const shared = (specs: WorkflowHandlerSpecMap): Array<[string, unknown]> =>
    Object.entries(specs).map(([name, spec]: [string, WorkflowHandlerSpec]) => [
      name,
      restate.handlers.workflow.shared(
        handlerOpts({ spec, redaction }),
        runEffectHandler({
          service: contract.name,
          handler: name,
          run: implMap[name]!,
          errorSchema: spec.error,
          runtime,
          markers: 'workflowShared',
          inboundBridge: wiring?.inboundBridge,
          boundaryObserver: wiring?.boundaryObserver,
        }),
      ),
    ])
  const handlers = Object.fromEntries([
    ['run', runHandler],
    ...shared(contract.signals),
    ...shared(contract.queries),
  ])
  const serviceOptions = withHooks({
    serviceOptions: mapServiceOptions(contract.options),
    ...(wiring !== undefined ? { wiring } : {}),
  })
  return restate.workflow({
    name: contract.name,
    handlers,
    ...(serviceOptions !== undefined ? { options: serviceOptions } : {}),
  } as unknown as Parameters<typeof restate.workflow>[0]) as restate.WorkflowDefinition<
    string,
    unknown
  >
}

/**
 * Any bound implementation servable on an endpoint. `materializeAny` dispatches on
 * the `_tag` to the right `materialize*`, so `layer` / `serve` accept a mixed
 * `services` array of Services, Objects, and Workflows.
 */
export type AnyImplementation<AppR> =
  | ServiceImplementation<Contract<string, HandlerSpecMap>, AppR>
  | ObjectImplementation<ObjectContract<string, StateSchemas, ObjectHandlerSpecMap>, AppR>
  | WorkflowImplementation<
      WorkflowContract<
        string,
        StateSchemas,
        WorkflowHandlerSpec,
        WorkflowHandlerSpecMap,
        WorkflowHandlerSpecMap
      >,
      AppR
    >

/** Dispatch a bound implementation to the right `materialize*` by its `_tag`. */
export const materializeAny = <AppR>({
  implementation,
  runtime,
  wiring,
}: {
  implementation: AnyImplementation<AppR>
  runtime: Context.Context<AppR>
  wiring?: MaterializeWiring
}):
  | restate.ServiceDefinition<string, unknown>
  | restate.VirtualObjectDefinition<string, unknown>
  | restate.WorkflowDefinition<string, unknown> => {
  switch (implementation._tag) {
    case 'ServiceImplementation':
      return materialize({ implementation, runtime, ...(wiring !== undefined ? { wiring } : {}) })
    case 'ObjectImplementation':
      return materializeObject({
        implementation,
        runtime,
        ...(wiring !== undefined ? { wiring } : {}),
      })
    case 'WorkflowImplementation':
      return materializeWorkflow({
        implementation,
        runtime,
        ...(wiring !== undefined ? { wiring } : {}),
      })
  }
}

/* eslint-enable @typescript-eslint/no-explicit-any */

/* eslint-disable @typescript-eslint/no-explicit-any -- the AppR extractor walks heterogeneous implementations */

/**
 * The UNION of every served implementation's app requirement `AppR` — the
 * combined requirement `layer`/`serve` need the captured runtime to provide. A
 * homogeneous array collapses to one `AppR`; a HETEROGENEOUS array (services with
 * differing `AppR`s) widens to the union, so a runtime providing all of them is
 * required (fixes the docs-worker mixed-`AppR` array friction — `AppR` no longer
 * forced to a single element via `ReadonlyArray<AnyImplementation<AppR>>`
 * inference). Relies on `_Implementation._AppR` being covariant.
 */
export type AppROf<Services extends ReadonlyArray<AnyImplementation<any>>> =
  Services[number] extends AnyImplementation<infer R> ? R : never

/* eslint-enable @typescript-eslint/no-explicit-any */

/** Options for the endpoint server layer / `serve`. */
export interface EndpointOptions<AppR> {
  /** A mixed array of Service / Object / Workflow implementations to serve. */
  readonly services: ReadonlyArray<AnyImplementation<AppR>>
  /**
   * The handler-endpoint port the server listens on. Either a literal `number`
   * or a `Config<number>` (e.g. `Config.integer('PORT')`) resolved on layer
   * acquisition — so the port can come from the environment without a separate
   * read. A `Config` that fails (unset / unparseable) fails the layer with a
   * `ConfigError`.
   */
  readonly port: number | Config.Config<number>
  /**
   * Restate `HooksProvider`s attached SERVICE-level to every materialized
   * service (so they wrap every handler). The `./otel` module supplies the
   * `openTelemetryHook` here; the otel-free core leaves this undefined (docs/vrs/08-observability/spec.md).
   */
  readonly hooks?: ReadonlyArray<EndpointHooks>
  /**
   * Per-invocation inbound-bridge transform applied to every handler's program
   * (the `./otel` module's attempt-span → Effect-parent bridge, R23 docs/vrs/08-observability/spec.md). A pure
   * `<A, E, R>(effect) => Effect<A, E, R>`; undefined in the otel-free core.
   */
  readonly inboundBridge?: HandlerWrap
  /**
   * Per-invocation observability observer (the `./otel` module's boundary span
   * stamping + per-invocation outcome metric, R23 docs/vrs/08-observability/spec.md, decision 0014). A pure
   * `(BoundaryInfo) => (BoundaryOutcome) => void`; undefined in the otel-free core.
   */
  readonly boundaryObserver?: BoundaryObserver
  /**
   * Restate REQUEST-IDENTITY public keys (ED25519, v1 — e.g.
   * `publickeyv1_2G8dCQhArfvGpzPw5Vx2ALciR4xCLHfS5YaT93XjNxX9`), threaded into the
   * SDK endpoint's `identityKeys` (docs/vrs/07-endpoint-deploy/spec.md §2, decision 0016). When set, the SDK
   * REJECTS any inbound request not signed by the matching private key (the
   * `x-restate-signature-scheme: v1` + `x-restate-jwt-v1` JWT check) — closing the
   * otherwise-unauthenticated handler-endpoint hole. Pure passthrough; the SDK
   * owns the verification. Leave unset for a trusted local network.
   */
  readonly identityKeys?: ReadonlyArray<string>
  /**
   * Restate SDK endpoint logger transport. This is the SDK-level logger (SYSTEM /
   * JOURNAL / USER records around endpoint discovery and invocation processing),
   * distinct from the per-invocation Effect logger bridge that routes
   * `Effect.log*` through `ctx.console`.
   *
   * Leave unset to use the SDK's default console transport. Tests and hosted
   * runtimes can pass a structured transport to preserve SDK diagnostics without
   * writing expected terminal outcomes to process stderr.
   */
  readonly sdkLogger?: restate.LoggerTransport
}

/** Runtime binding details for a started endpoint server. */
export interface EndpointServer {
  readonly port: number
  readonly url: string
}

/** Context service carrying the actual address of a scoped endpoint server. */
export class BoundEndpoint extends Context.Service<BoundEndpoint, EndpointServer>()(
  '@overeng/restate-effect/BoundEndpoint',
) {}

/* eslint-disable @typescript-eslint/no-explicit-any -- the services-tuple AppR extractor */
/**
 * A scoped `Effect` that binds the given service implementations to an h2c
 * (cleartext HTTP/2 prior-knowledge) server on `opts.port`, serves the Restate
 * discovery/invocation protocol, and returns the actual bound address.
 *
 * Passing `port: 0` delegates port selection to the kernel and returns the
 * selected port. That is the race-free pattern for in-process tests: there is no
 * "ask for a free port, close it, then bind by number" gap for another process
 * to steal.
 *
 * The shared application runtime is captured once (`Effect.runtime<AppR>()`),
 * each implementation materialized, the server started on acquire, and a
 * finalizer closes it on scope teardown — so the endpoint participates in
 * graceful (SIGTERM-driven) shutdown when launched via `serve` +
 * `NodeRuntime.runMain`.
 *
 * The failure channel is `RestateError` (a bind/listen failure) plus
 * `ConfigError` — the latter only ever fails when `port` is a `Config<number>`
 * that the environment does not satisfy (a literal-`number` port never produces
 * one).
 *
 * `bidirectional` is left UNSET so the SDK negotiates full `BIDI_STREAM` over
 * h2c prior-knowledge (DQ7, docs/vrs/07-endpoint-deploy/spec.md §2).
 */
export const make = <const S extends ReadonlyArray<AnyImplementation<any>>>(
  opts: Omit<EndpointOptions<AppROf<S>>, 'services'> & { readonly services: S },
): Effect.Effect<EndpointServer, RestateError | Config.ConfigError, AppROf<S> | Scope.Scope> =>
  Effect.gen(function* () {
    type AppR = AppROf<S>
    /* Resolve a `Config<number>` port (e.g. `Config.integer('PORT')`) on
     * acquisition; a literal `number` passes through. A failing Config fails
     * the layer with a `ConfigError`. */
    const port = typeof opts.port === 'number' ? opts.port : yield* opts.port
    const runtime = yield* Effect.context<AppR>()
    const wiring: MaterializeWiring = {
      hooks: opts.hooks,
      inboundBridge: opts.inboundBridge,
      boundaryObserver: opts.boundaryObserver,
    }
    const fn = createEndpointHandler({
      services: opts.services.map((s) =>
        materializeAny({
          implementation: s,
          runtime,
          ...(wiring !== undefined ? { wiring } : {}),
        }),
      ),
      ...(opts.identityKeys !== undefined ? { identityKeys: [...opts.identityKeys] } : {}),
      ...(opts.sdkLogger !== undefined ? { logger: opts.sdkLogger } : {}),
    })
    const server = http2.createServer(fn as Parameters<typeof http2.createServer>[0])

    const bound = yield* Effect.acquireRelease(
      Effect.callback<EndpointServer, RestateError>((resume) => {
        const onError = (cause: Error) => {
          server.off('error', onError)
          resume(
            Effect.fail(new RestateError({ reason: 'EndpointFailed', method: 'listen', cause })),
          )
        }
        server.once('error', onError)
        server.listen(port, () => {
          server.off('error', onError)
          const address = server.address()
          if (address === null || typeof address === 'string') {
            const failure = new RestateError({
              reason: 'EndpointFailed',
              method: 'listen',
              cause: new Error('endpoint did not expose a TCP address'),
            })
            server.close(() => resume(Effect.fail(failure)))
            return
          }
          resume(
            Effect.succeed({
              port: address.port,
              url: `http://localhost:${address.port}`,
            }),
          )
        })
      }),
      () =>
        Effect.callback<void>((resume) => {
          server.close(() => resume(Effect.void))
        }),
    )

    yield* Effect.logInfo(`restate-effect endpoint listening on ${bound.url}`)
    return bound
  })

/** A scoped `Layer` wrapper around {@link make} that exposes the bound address. */
export const layerWithBoundEndpoint = <const S extends ReadonlyArray<AnyImplementation<any>>>(
  opts: Omit<EndpointOptions<AppROf<S>>, 'services'> & { readonly services: S },
): Layer.Layer<BoundEndpoint, RestateError | Config.ConfigError, AppROf<S>> =>
  Layer.effect(BoundEndpoint, make(opts))

/**
 * A scoped `Layer` that starts the endpoint server and discards the bound
 * address. Use {@link make} or {@link layerWithBoundEndpoint} when a test needs
 * to register a kernel-selected `port: 0` URL.
 */
export const layer = <const S extends ReadonlyArray<AnyImplementation<any>>>(
  opts: Omit<EndpointOptions<AppROf<S>>, 'services'> & { readonly services: S },
): Layer.Layer<never, RestateError | Config.ConfigError, AppROf<S>> =>
  Layer.effectDiscard(make(opts))

/**
 * Long-lived production entrypoint: launch the endpoint `layer` and block until
 * interrupted, running finalizers (graceful server close + all scoped
 * application resources) on SIGTERM.
 *
 * ```ts
 * serve({ services: [GreeterLive], port: 9080 }).pipe(
 *   Effect.provide(AppLayer),
 *   NodeRuntime.runMain,
 * )
 * ```
 */
export const serve = <const S extends ReadonlyArray<AnyImplementation<any>>>(
  opts: Omit<EndpointOptions<AppROf<S>>, 'services'> & { readonly services: S },
): Effect.Effect<never, RestateError | Config.ConfigError, AppROf<S>> => Layer.launch(layer(opts))
/* eslint-enable @typescript-eslint/no-explicit-any */
