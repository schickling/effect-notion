/**
 * OTEL integration for Effect CLI applications.
 *
 * Provides:
 * - Parent span propagation from devenv tasks run tasks (via W3C TRACEPARENT env var)
 * - OTEL exporter layer for CLI traces
 * - Zero overhead when OTEL is not configured
 *
 * Uses the Effect `Otlp` observability modules which don't require
 * @opentelemetry/sdk-* peer dependencies.
 *
 * @module
 */

import {
  Config,
  Context,
  Duration,
  Effect,
  Layer,
  Metric,
  Option,
  type Scope,
  Tracer,
} from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'
import { Otlp } from 'effect/unstable/observability'

import { ServiceIdentity } from '@overeng/otel-contract'

/**
 * Re-exported so the typed telemetry front door ({@link withTelemetry}) and its
 * identity type live behind one import. Construct it through
 * `Schema.decode(ServiceIdentity)` at the composition root so a malformed
 * `service.name` is a decode error at the edge, not a backend surprise.
 */
export { ServiceIdentity }

export * from './otel-attrs.ts'

/**
 * Resolved OTEL configuration, provided by {@link makeOtelCliLayer} so command
 * code can gate optional telemetry work (e.g. forking a periodic sampler) on the
 * SAME signal the exporter was built from, instead of reading `process.env`
 * directly.
 *
 * `endpoint` is `Some(url)` when telemetry is exported and `None` otherwise. Read
 * it with {@link Effect.serviceOption} so commands stay runnable without the
 * layer (absent tag ≡ telemetry disabled), keeping the tag out of their `R`.
 */
export class OtelConfig extends Context.Service<
  OtelConfig,
  {
    readonly endpoint: Option.Option<string>
  }
>()('@overeng/utils/OtelConfig') {}

/**
 * Resolve the OTLP endpoint at a binary's composition root via Effect `Config`,
 * returning `Option<string>` to hand straight to {@link makeOtelCliLayer}'s
 * `endpoint` field. This keeps env access at the edge: the layer itself becomes a
 * pure function of the resolved endpoint and never touches `process.env`.
 *
 * @default env var 'OTEL_EXPORTER_OTLP_ENDPOINT'
 */
export const otelEndpointFromConfig = (
  envVar = 'OTEL_EXPORTER_OTLP_ENDPOINT',
): Effect.Effect<Option.Option<string>> =>
  // `Config.option` already maps missing data to `None`; any other config error
  // (malformed value) at the composition root is a defect, so die rather than
  // widen every binary's error channel with `ConfigError`.
  Config.option(Config.string(envVar)).pipe(Effect.orDie)

/**
 * Parses a W3C Trace Context TRACEPARENT header/env var.
 *
 * Format: `{version}-{trace-id}-{parent-id}-{trace-flags}`
 * Example: `00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01`
 *
 * @see https://www.w3.org/TR/trace-context/#traceparent-header
 */
const parseTraceparent = (
  traceparent: string,
): { traceId: string; spanId: string; traceFlags: string } | undefined => {
  const parts = traceparent.split('-')
  if (parts.length !== 4) return undefined

  const version = parts[0]!
  const traceId = parts[1]!
  const spanId = parts[2]!
  const traceFlags = parts[3]!

  // Version must be 00 (current spec), traceId 32 hex chars, spanId 16 hex chars
  if (version !== '00' || traceId.length !== 32 || spanId.length !== 16) return undefined

  return { traceId, spanId, traceFlags }
}

/**
 * Gets the parent span from the W3C TRACEPARENT env var (when present and valid).
 *
 * This allows a CLI process to emit spans into the same trace as the
 * parent devenv tasks run task by constructing an external parent span.
 *
 * The `otel-span` shell helper automatically exports TRACEPARENT for child processes,
 * so this works out of the box with devenv tasks run task tracing.
 */
const getParentSpanFromTraceparent = (): Tracer.ExternalSpan | undefined => {
  const traceparent = process.env.TRACEPARENT
  if (traceparent === undefined) return undefined

  const parsed = parseTraceparent(traceparent)
  if (parsed === undefined) return undefined

  return Tracer.externalSpan({
    traceId: parsed.traceId,
    spanId: parsed.spanId,
  })
}

/**
 * Effect version of getParentSpanFromTraceparent for external use.
 */
export const parentSpanFromTraceparent: Effect.Effect<Tracer.ExternalSpan | undefined> =
  Effect.sync(getParentSpanFromTraceparent)

/** Configuration options for the CLI OTEL tracing layer. */
export interface OtelCliLayerConfig {
  /**
   * Typed, decoded service identity stamped onto the OTLP resource for ALL
   * signals (traces, metrics, logs): `service.name` + `service.namespace` +
   * `service.version`. Construct it through `Schema.decode(ServiceIdentity)` so
   * a malformed name is a type/decode error at the composition root.
   */
  identity: ServiceIdentity
  /**
   * Explicitly-resolved OTLP endpoint. When provided, it is authoritative and
   * the layer does NOT read `process.env`: `Some(url)` exports to `url`, `None`
   * disables export (empty layer). Resolve it at the binary's composition root —
   * e.g. {@link otelEndpointFromConfig} — to keep this layer a pure function of
   * its input. When omitted, the layer falls back to reading `endpointEnvVar`
   * (backward-compat for callers not yet resolving at the edge).
   */
  endpoint?: Option.Option<string>
  /**
   * Environment variable containing the OTLP endpoint URL. Only consulted when
   * `endpoint` is omitted (the explicit `endpoint` takes precedence).
   * @default 'OTEL_EXPORTER_OTLP_ENDPOINT'
   */
  endpointEnvVar?: string
  /**
   * Tracer export interval in milliseconds.
   * @default 250
   */
  exportInterval?: number
  /**
   * Metrics reader export interval in milliseconds. The OTLP metrics reader is
   * pull-based and POSTs every registered metric on this cadence; the default
   * (`@effect/opentelemetry`'s 10s) undersamples short CLI runs, so set a small
   * value when a gauge must flush within a ~10s run.
   * @default 10_000 (the @effect/opentelemetry default)
   */
  metricsExportInterval?: number
  /**
   * Safety *ceiling* for the graceful-shutdown flush, in milliseconds. The flush
   * is a scope finalizer that Effect awaits to completion, so this is a ceiling
   * never a floor: it costs nothing on a healthy collector (exit ≈ one
   * round-trip) and only bounds the worst case when the collector is
   * black-holed. Do NOT set a small per-CLI override — that turns the ceiling
   * into a dropped final batch (the cap interrupts the in-flight export).
   * @default 30_000 (non-interactive) / 10_000 (interactive TTY)
   */
  shutdownTimeout?: number
}

/**
 * Default graceful-shutdown cap. The flush is a scope finalizer Effect awaits to
 * completion, so this only bounds the worst case when the collector is
 * black-holed (never the happy path). Interactive TTYs get a tighter bound so a
 * human never waits long on a dead collector; non-interactive (CI) gets a
 * generous one. Ctrl-C escapes either in tens of ms (the flush stays
 * interruptible).
 */
const defaultShutdownTimeoutMs = (): number => (process.stdout.isTTY === true ? 10_000 : 30_000)

/**
 * Parse `OTEL_RESOURCE_ATTRIBUTES` (comma-separated `key=value` pairs with
 * percent-encoded values, per the OpenTelemetry spec) into a plain record.
 * Malformed pairs are skipped rather than failing the whole resource.
 */
const parseOtelResourceAttributes = (raw: string | undefined): Record<string, string> => {
  if (raw === undefined || raw.trim() === '') return {}
  const entries = raw.split(',').flatMap((pair) => {
    const trimmed = pair.trim()
    if (trimmed === '') return []
    const eq = trimmed.indexOf('=')
    const key = eq === -1 ? trimmed : trimmed.slice(0, eq)
    const value = eq === -1 ? '' : trimmed.slice(eq + 1)
    try {
      return [[decodeURIComponent(key), decodeURIComponent(value)] as const]
    } catch {
      return [[key, value] as const]
    }
  })
  return Object.fromEntries(entries)
}

/**
 * Creates an OTEL layer for Effect CLI applications.
 *
 * Features:
 * - Optionally joins an existing trace via W3C TRACEPARENT env var (devenv tasks run task integration)
 * - Exports to OTLP endpoint if configured (explicit `endpoint`, else env fallback)
 * - Zero exporter overhead when no endpoint is configured (only the lightweight
 *   {@link OtelConfig} marker is provided so command code can gate on it)
 * - Config-free shutdown flush: the exporter's flush is a scope finalizer Effect
 *   awaits to completion, so natural exit is as fast as the flush. `shutdownTimeout`
 *   is a safety ceiling only (see its docs) — the final batch is delivered by the
 *   scope-close finalizer regardless of the export intervals, so do NOT tune
 *   intervals or the cap to make a metric "land". Known residual: a transient
 *   mid-run export failure trips the exporter's 60s self-disable, after which the
 *   final flush short-circuits (not solvable via `shutdownTimeout`).
 *
 * @example
 * ```typescript
 * // In bin/my-cli.ts
 * import { makeOtelCliLayer } from '@overeng/utils/node/otel'
 *
 * const identity = Schema.decodeSync(ServiceIdentity)({
 *   name: 'my-cli', namespace: 'overeng', version,
 * })
 */
export const makeOtelCliLayer = (config: OtelCliLayerConfig): Layer.Layer<OtelConfig> => {
  const {
    identity,
    endpoint: explicitEndpoint,
    endpointEnvVar = 'OTEL_EXPORTER_OTLP_ENDPOINT',
    exportInterval = 250,
    metricsExportInterval,
    shutdownTimeout = defaultShutdownTimeoutMs(),
  } = config

  // Use Layer.suspend instead of Layer.unwrapEffect to ensure proper scope propagation.
  // Layer.unwrapEffect doesn't properly chain scopes, causing OTEL exporter finalizers
  // (which flush spans via HTTP) to not be awaited on shutdown.
  return Layer.suspend(() => {
    // The explicit `endpoint` is authoritative (pure: no env read). Only fall
    // back to `process.env` when the caller didn't resolve it at the edge.
    const resolved =
      explicitEndpoint !== undefined
        ? explicitEndpoint
        : Option.fromUndefinedOr(process.env[endpointEnvVar])
    // The typed `identity`'s name/namespace/version flow onto every signal's
    // resource. `OTEL_RESOURCE_ATTRIBUTES` env attrs are merged in as well so
    // runtime provenance (e.g. deployment.environment) survives — the explicit
    // identity wins on collision, env-only attrs are preserved.
    const resource = {
      serviceName: identity.name,
      serviceVersion: identity.version,
      attributes: {
        ...parseOtelResourceAttributes(process.env.OTEL_RESOURCE_ATTRIBUTES),
        'service.namespace': identity.namespace,
      },
    }

    // Always provide the resolved config so command code can gate optional
    // telemetry work on the same signal the exporter is built from.
    const configLive = Layer.succeed(OtelConfig, { endpoint: resolved })

    // No endpoint configured - return config-only layer (zero exporter overhead).
    if (Option.isNone(resolved) === true) {
      return configLive
    }

    const endpoint = resolved.value
    const parentSpan = getParentSpanFromTraceparent()

    // Propagate parent trace context from TRACEPARENT without creating a bridge span.
    // Layer.parentSpan sets the external parent so child spans (e.g. command-level
    // schema-first operation spans) appear under the devenv tasks run task span in the trace.
    const parentLive = parentSpan !== undefined ? Layer.parentSpan(parentSpan) : Layer.empty

    const baseUrl = endpoint.endsWith('/') === true ? endpoint.slice(0, -1) : endpoint

    // `Otlp.layerJson` is the pure-Effect front door — it never touches the
    // `@opentelemetry/api` GLOBAL registry. Long-lived SDK-global consumers that
    // read `trace.getActiveSpan()` (restate's `./otel` bridge) intentionally use
    // a SIBLING provider layer that calls `provider.register()`, NOT this layer —
    // serving them here would double-export + drag `@opentelemetry/sdk-*` and a
    // process-global onto every CLI (restate-effect decision 0007).
    const exporterLive = Otlp.layerJson({
      baseUrl,
      resource,
      tracerExportInterval: exportInterval,
      ...(metricsExportInterval === undefined ? {} : { metricsExportInterval }),
      shutdownTimeout,
    }).pipe(Layer.provide(FetchHttpClient.layer))

    return Layer.mergeAll(configLive, parentLive.pipe(Layer.provideMerge(exporterLive)))
  })
}

// =============================================================================
// Typed telemetry front door — `withTelemetry({ identity, shape, endpoint })`
// =============================================================================

/**
 * Deployment shape — the kind of process, NOT the consumer. The shape (not each
 * CLI) selects the export/flush mechanics so the hard-won knowledge lives in one
 * table instead of being re-derived per consumer.
 *
 * - `cli`: short-lived. Short export intervals + the TTY-aware safety-ceiling
 *   shutdown, so a sub-second run still ticks once and the scope-close finalizer
 *   force-flushes the final batch of every signal before exit.
 * - `service`: long-lived. Relaxed periodic export; the shutdown ceiling only
 *   bounds a graceful stop against a black-holed collector.
 * - `test`: deterministic short intervals against an explicit (ephemeral)
 *   endpoint, with a tight shutdown window for fast, hermetic assertions.
 */
export type Shape = 'cli' | 'service' | 'test'

/**
 * The underlying {@link makeOtelCliLayer} knobs a {@link Shape} resolves. Kept as
 * a `Partial` `overrides` escape hatch on {@link withTelemetry} for back-compat
 * and edge cases — but reaching for it should be rare; the shape is the contract.
 */
export interface ShapeOverrides {
  readonly exportInterval?: number
  readonly metricsExportInterval?: number
  readonly shutdownTimeout?: number
}

/**
 * The Shape → defaults table. The `cli` row is load-bearing: small intervals so a
 * sub-second run still ticks once, and `shutdownTimeout` left to
 * {@link makeOtelCliLayer}'s TTY-aware default (the safety *ceiling*, not a floor —
 * the final batch lands via the scope-close finalizer regardless). `service` and
 * `test` are explicit since their cadence/flush intent differs.
 */
const shapeDefaults = (shape: Shape): ShapeOverrides => {
  switch (shape) {
    case 'cli':
      // Short intervals so a fast CLI ticks; shutdownTimeout intentionally
      // omitted → makeOtelCliLayer's TTY-aware ceiling (30s/10s) applies.
      return { exportInterval: 250, metricsExportInterval: 1000 }
    case 'service':
      return { exportInterval: 5000, metricsExportInterval: 10_000, shutdownTimeout: 5000 }
    case 'test':
      return { exportInterval: 100, metricsExportInterval: 100, shutdownTimeout: 2000 }
  }
}

/** Inputs to {@link withTelemetry}: the validated identity, process {@link Shape}, resolved endpoint, and rare per-call knob overrides. */
export interface TelemetryLayerOptions {
  /**
   * Typed, decoded service identity stamped onto `service.{name,namespace,version}`
   * of EVERY signal's resource. Construct it via `Schema.decode(ServiceIdentity)`
   * so a malformed name is a type/decode error at the composition root — a raw
   * string is a `tsc` error here.
   */
  readonly identity: ServiceIdentity
  /** The process shape (see {@link Shape}) — picks export intervals + flush. */
  readonly shape: Shape
  /**
   * OTLP base endpoint, resolved once at the edge (e.g. {@link otelEndpointFromConfig}).
   * `Some(url)` exports all three signals to `url`; `None` disables export
   * (config-only layer, zero exporter overhead — only the {@link OtelConfig}
   * marker is provided so samplers can gate on it).
   */
  readonly endpoint: Option.Option<string>
  /**
   * Rare per-call overrides of the shape's underlying knobs. Prefer the shape;
   * reach here only for a genuine edge case (the footgun this surface removes is
   * every consumer hand-tuning these, so document any override).
   */
  readonly overrides?: ShapeOverrides
}

/**
 * The recommended way to add telemetry to any CLI or service: ONE typed layer
 * that wires traces + metrics + logs through {@link makeOtelCliLayer} with the
 * {@link Shape}'s defaults and a validated {@link ServiceIdentity} on every
 * signal. A thin typed front door over `makeOtelCliLayer`, NOT a reimplementation
 * — it folds the ad-hoc `exportInterval`/`metricsExportInterval`/`shutdownTimeout`
 * knobs behind the shape so the consumer says *what kind of process this is* and
 * gets correct intervals + force-flush-on-shutdown by default.
 *
 * `Effect.log` bridges to OTLP logs automatically (the underlying `Otlp.layerJson`
 * adds the OTLP logger by default; console output is NOT suppressed). The
 * resolved endpoint is published as {@link OtelConfig} so {@link sampleResource}
 * and {@link telemetryEnabled} gate on the same signal the exporter was built from.
 *
 * @example
 * ```typescript
 * const identity = Schema.decodeSync(ServiceIdentity)({
 *   name: 'my-cli', namespace: 'overeng', version,
 * })
 * const endpoint = yield* otelEndpointFromConfig()
 * program.pipe(Effect.provide(withTelemetry({ identity, shape: 'cli', endpoint })))
 * ```
 */
export const withTelemetry = (options: TelemetryLayerOptions): Layer.Layer<OtelConfig> => {
  const { identity, shape, endpoint, overrides } = options
  const defaults = shapeDefaults(shape)
  const knobs = { ...defaults, ...overrides }
  return makeOtelCliLayer({
    identity,
    endpoint,
    ...(knobs.exportInterval === undefined ? {} : { exportInterval: knobs.exportInterval }),
    ...(knobs.metricsExportInterval === undefined
      ? {}
      : { metricsExportInterval: knobs.metricsExportInterval }),
    ...(knobs.shutdownTimeout === undefined ? {} : { shutdownTimeout: knobs.shutdownTimeout }),
  })
}

/**
 * Alias of {@link withTelemetry} for callers that read the typed front door as a
 * `Layer` value rather than a verb.
 */
export const TelemetryLayer = withTelemetry

// =============================================================================
// Telemetry-enabled gate + periodic resource-sampler primitive
// =============================================================================

/**
 * Whether telemetry export is active, read from the same {@link OtelConfig} the
 * exporter was built from (`Some(endpoint)` ⇒ enabled). Resolves to `false` when
 * the layer is absent (`Effect.serviceOption`), so command code stays runnable
 * without the layer and the tag never enters its `R`. Use this instead of
 * hand-rolling the double-`Option` gate or reading `process.env` directly.
 */
export const telemetryEnabled: Effect.Effect<boolean> = Effect.serviceOption(OtelConfig).pipe(
  Effect.map(
    Option.match({
      onNone: () => false,
      onSome: (config) => Option.isSome(config.endpoint),
    }),
  ),
)

/**
 * Run `effect` only when telemetry is enabled (see {@link telemetryEnabled}),
 * otherwise no-op with `void`. Lets a consumer fork optional telemetry work
 * (e.g. a sampler) without paying its cost — or seeing the tag in `R` — when
 * export is off.
 */
export const whenTelemetryEnabled = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<void, E, R> =>
  telemetryEnabled.pipe(
    Effect.flatMap((enabled) => (enabled === true ? Effect.asVoid(effect) : Effect.void)),
  )

/** Inputs to {@link sampleResource}: the per-tick `sample` effect and its real-wall-time `interval`. */
export interface SampleResourceOptions {
  /**
   * The per-tick sampler — typically `Metric.set(gauge, read())`. Runs on every
   * interval tick for the lifetime of the enclosing scope.
   */
  readonly sample: Effect.Effect<void>
  /**
   * Tick cadence on REAL wall time.
   * @default 250ms
   */
  readonly interval?: Duration.Duration
}

/**
 * Fork a fiber that runs `sample` every `interval` for the lifetime of the
 * enclosing scope, generalizing the per-consumer RSS-gauge sampler so no consumer
 * re-derives the two gotchas this primitive encapsulates:
 *
 * 1. **No-op when telemetry is off.** Gated on {@link telemetryEnabled} (the
 *    {@link OtelConfig} marker), so when no endpoint is configured the fiber is
 *    never forked — "zero overhead when unset" means not paying the periodic cost,
 *    not merely a metric going nowhere.
 * 2. **Ticks on real wall time.** Sampling sleeps through `Effect.sleep` on the
 *    contextual clock (a `Context.Reference` defaulting to the system clock);
 *    only an explicitly provided test clock can change that, and this primitive
 *    is infrastructure.
 *
 * @example
 * ```typescript
 * const rss = Metric.gauge('proc_rss_bytes', { bigint: false })
 * yield* sampleResource({ sample: Effect.sync(() => process.memoryUsage().rss)
 *   .pipe(Effect.flatMap((v) => Metric.set(rss, v))) })
 * ```
 */
export const sampleResource = (
  options: SampleResourceOptions,
): Effect.Effect<void, never, OtelConfig | Scope.Scope> => {
  const { sample, interval = Duration.millis(250) } = options
  return whenTelemetryEnabled(
    // First sample runs inline so a short-lived process always lands at least
    // one reading before its scope closes — a forked fiber's first tick races
    // scope close and can be interrupted before it ever runs. The forked loop
    // then sleeps `interval` between subsequent samples.
    Effect.andThen(
      sample,
      Effect.asVoid(
        Effect.forkScoped(Effect.forever(Effect.flatMap(Effect.sleep(interval), () => sample))),
      ),
    ),
  )
}

/** Inputs to {@link sampleGauge}: the target `gauge`, the `read()` closure sampled each tick, optional `labels`, and the `interval`. */
export interface SampleGaugeOptions {
  /**
   * The gauge to sample into. Construct with `Metric.gauge(...)`.
   */
  readonly gauge: Metric.Metric<number, unknown>
  /** Reads the current value on each tick (e.g. `() => process.memoryUsage().rss`). */
  readonly read: () => number
  /**
   * Optional attributes applied to the gauge so a sweep yields one comparable
   * series per operating point (via `Metric.withAttributes`).
   */
  readonly labels?: Readonly<Record<string, string>>
  /** @default 250ms */
  readonly interval?: Duration.Duration
}

/**
 * Convenience over {@link sampleResource} for the common case: periodically `set`
 * a numeric gauge from a `read()` closure. Encapsulates the labeled-gauge `set`
 * so a consumer expresses *what to measure*, not the clock/gate/fork mechanics.
 */
export const sampleGauge = (
  options: SampleGaugeOptions,
): Effect.Effect<void, never, OtelConfig | Scope.Scope> => {
  const { gauge, read, labels, interval } = options
  const target = labels === undefined ? gauge : Metric.withAttributes(gauge, labels)
  return sampleResource({
    // oxlint-disable-next-line overeng/no-raw-otel-primitives -- v4 replaced `Metric.set` with `update`; gauges remain the sanctioned raw path here
    sample: Effect.sync(read).pipe(Effect.flatMap((value) => Metric.update(target, value))),
    ...(interval === undefined ? {} : { interval }),
  })
}
