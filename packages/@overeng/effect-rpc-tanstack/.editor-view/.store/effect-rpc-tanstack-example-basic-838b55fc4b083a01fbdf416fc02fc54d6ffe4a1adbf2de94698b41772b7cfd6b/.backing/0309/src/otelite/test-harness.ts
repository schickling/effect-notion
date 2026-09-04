import type { Scope } from 'effect'
import { Context, Effect, Layer, Semaphore } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'
import { Otlp, OtlpSerialization, OtlpTracer } from 'effect/unstable/observability'

import type { OteliteCliError, OteliteDecodeError, OteliteSpawnError } from './errors.ts'
import { withOteliteLabelSpan, withOteliteRootSpan } from './otel.ts'
import { Otelite } from './Otelite.ts'
import type { CaptureHandle, CaptureOptions } from './Otelite.ts'
import { otlpTracesUrl } from './otlp-url.ts'
import type { LogRow, MetricRow, SpanRow } from './schema.ts'
import { expectLogs, expectMetrics, type LogExpect, type MetricExpect } from './signal-expect.ts'
import { expectTrace, type TraceExpect } from './trace-expect.ts'
import { flushCaptureSpans } from './vitest-bridge.ts'

/** Capture options plus the in-process exporter knobs; `exportInterval` is the per-signal flush cadence (defaults to 100ms). */
export interface OteliteTestHarnessOptions extends CaptureOptions {
  readonly serviceName: string
  readonly rootSpanName?: string
  readonly rootSpanLabel?: string
  readonly exportInterval?: number
}

/** Overrides for the env-var path: which names carry the endpoint/service-name and any `extra` vars to set for the run. */
export interface OteliteEnvOptions {
  readonly endpointVar?: string
  readonly serviceNameVar?: string
  readonly extra?: Readonly<Record<string, string | undefined>>
}

/** Server-side `otelite inspect` row filters; the harness pins `service` to the run's service name unless overridden here. */
export interface TraceInspectOptions {
  readonly service?: string
  readonly name?: string
  readonly attrs?: Readonly<Record<string, string>>
}

/** Trace-assertion options; `spanLabelPolicy` defaults to `'required'`, failing the run if any captured span lacks `span.label`. */
export interface OteliteTraceOptions {
  readonly inspect?: TraceInspectOptions
  readonly spanLabelPolicy?: 'required' | 'off'
}

/**
 * The three signal expectation builders for a captured in-process run. Each is
 * the matcher surface already shipped for that signal — feed selectors into
 * `trace.expectOne(...)`, `metrics.expectOne(...)`, `logs.expectOne(...)`.
 */
export interface AllSignalsExpect {
  readonly trace: TraceExpect
  readonly metrics: MetricExpect
  readonly logs: LogExpect
}

/** Per-signal inspect filters for an all-signals run; metrics/logs inherit the pinned service while `trace` carries label policy. */
export interface OteliteAllSignalsOptions {
  readonly trace?: OteliteTraceOptions
  /** Extra `inspect` filters for the metrics/logs rows (service is pinned). */
  readonly metricsInspect?: TraceInspectOptions
  readonly logsInspect?: TraceInspectOptions
}

/** A booted capture: the spawned receiver plus run/inspect/assert closures bound to its endpoints and service name. */
export interface OteliteTestHandle {
  readonly capture: CaptureHandle
  readonly inProcessLayer: Layer.Layer<never>
  readonly endpointEnv: Readonly<Record<string, string>>
  readonly flush: Effect.Effect<void>
  readonly inspect: CaptureHandle['inspect']
  readonly inspectTraces: (
    options?: TraceInspectOptions,
  ) => Effect.Effect<
    ReadonlyArray<SpanRow>,
    OteliteSpawnError | OteliteCliError | OteliteDecodeError
  >
  readonly trace: (
    options?: OteliteTraceOptions,
  ) => Effect.Effect<TraceExpect, OteliteSpawnError | OteliteCliError | OteliteDecodeError>
  readonly runInProcess: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly runInProcessTrace: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    options?: OteliteTraceOptions,
  ) => Effect.Effect<TraceExpect, E | OteliteSpawnError | OteliteCliError | OteliteDecodeError, R>
  /**
   * Run an in-process program through the all-signals exporter and assert over
   * traces + metrics + logs at once. The exporter's scope-close flush carries
   * the final batch of every signal, so a sub-second run drops nothing.
   */
  readonly runInProcessAllSignals: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    options?: OteliteAllSignalsOptions,
  ) => Effect.Effect<
    AllSignalsExpect,
    E | OteliteSpawnError | OteliteCliError | OteliteDecodeError,
    R
  >
  readonly provideInProcess: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly withEnv: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    options?: OteliteEnvOptions,
  ) => Effect.Effect<A, E, R>
  readonly withEnvTrace: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    envOptions?: OteliteEnvOptions,
    traceOptions?: OteliteTraceOptions,
  ) => Effect.Effect<TraceExpect, E | OteliteSpawnError | OteliteCliError | OteliteDecodeError, R>
}

const envSemaphore = Semaphore.makeUnsafe(1)

const scopedEnv = (
  values: Readonly<Record<string, string | undefined>>,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previous: Record<string, string | undefined> = {}
      for (const key of Object.keys(values)) {
        previous[key] = process.env[key]
        const value = values[key]
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
      return previous
    }),
    (previous) =>
      Effect.sync(() => {
        for (const key of Object.keys(previous)) {
          const value = previous[key]
          if (value === undefined) {
            delete process.env[key]
          } else {
            process.env[key] = value
          }
        }
      }),
  ).pipe(Effect.asVoid)

const makeInProcessLayer = (
  handle: CaptureHandle,
  options: Required<Pick<OteliteTestHarnessOptions, 'serviceName' | 'exportInterval'>>,
): Layer.Layer<never> => {
  return OtlpTracer.layer({
    url: otlpTracesUrl(handle.endpoints.http),
    resource: { serviceName: options.serviceName },
    exportInterval: options.exportInterval,
  }).pipe(
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(OtlpSerialization.layerJson),
  )
}

/**
 * All-signals in-process exporter: traces + metrics + logs through ONE
 * `Otlp.layerJson`. Unlike the traces-only {@link makeInProcessLayer} (which
 * uses the per-signal `OtlpTracer.layer` and so must hand-append `/v1/traces`),
 * the combined `Otlp.layerJson` takes the BARE receiver base URL and appends
 * `/v1/{traces,metrics,logs}` itself — so all three signal URLs are correct and
 * the verbatim-URL footgun is gone. `Effect.log` bridges to OTLP logs because
 * `Otlp.layerJson` adds the OTLP logger by default.
 *
 * `Layer.suspend` keeps the exporter's scope-close finalizers (the final flush
 * of every signal) tied to the layer scope — matching prod `otel.ts` and the
 * traces-only path.
 *
 * Knobs mirror the prod `test` shape (`@overeng/utils/node` `Shape`/`shapeDefaults('test')`):
 * short, equal intervals on all three signals + a tight `shutdownTimeout`. This
 * is a deliberate SIBLING of the typed front door (`withTelemetry`), not an
 * import of it — `@overeng/utils-dev` is the universal test-harness leaf that
 * every first-party package's tests depend on, so importing `withTelemetry`
 * (from `@overeng/utils`) or `ServiceIdentity` (from `@overeng/otel-contract`)
 * would close a `tsc --build` project-reference cycle. The test↔prod fidelity is
 * instead proven one level up, in `@overeng/utils/src/node/otel-telemetry.test.ts`,
 * which exercises the real `withTelemetry({ shape: 'cli' })` front door against
 * the SAME otelite receiver this harness boots. See the telemetry-foundation VRS
 * (`@overeng/utils/docs/vrs`, decision 0002).
 */
const makeInProcessAllSignalsLayer = (
  handle: CaptureHandle,
  options: Required<Pick<OteliteTestHarnessOptions, 'serviceName' | 'exportInterval'>>,
): Layer.Layer<never> =>
  Layer.suspend(() =>
    Otlp.layerJson({
      baseUrl: handle.endpoints.http.replace(/\/$/, ''),
      resource: { serviceName: options.serviceName },
      tracerExportInterval: options.exportInterval,
      metricsExportInterval: options.exportInterval,
      loggerExportInterval: options.exportInterval,
      // Mirror `shapeDefaults('test').shutdownTimeout` (2000ms): an explicit,
      // tight ceiling on the scope-close flush matching the prod `test` shape, so
      // a hung receiver fails fast in a test (was omitted before, relying on
      // scope-close alone).
      shutdownTimeout: 2000,
    }).pipe(Layer.provide(FetchHttpClient.layer)),
  )

/** The test-harness service shape exposed by {@link OteliteTestHarness}. */
export interface OteliteTestHarnessService {
  /** Boot a scoped otelite receiver plus the in-process exporter layers bound to it. */
  readonly capture: (
    options: OteliteTestHarnessOptions,
  ) => Effect.Effect<
    OteliteTestHandle,
    OteliteSpawnError | OteliteCliError | OteliteDecodeError,
    Scope.Scope
  >
}

/** Effect service whose `capture` boots a scoped otelite receiver and yields an {@link OteliteTestHandle}; provides its own `Otelite` dependency. */
export class OteliteTestHarness extends Context.Service<
  OteliteTestHarness,
  OteliteTestHarnessService
>()('@overeng/utils-dev/otelite/OteliteTestHarness', {
  make: Effect.gen(function* () {
    const otelite = yield* Otelite

    const capture = (
      options: OteliteTestHarnessOptions,
    ): Effect.Effect<
      OteliteTestHandle,
      OteliteSpawnError | OteliteCliError | OteliteDecodeError,
      Scope.Scope
    > =>
      Effect.gen(function* () {
        const exportInterval = options.exportInterval ?? 100
        const rootSpanName = options.rootSpanName ?? `${options.serviceName}.test`
        const rootSpanLabel = options.rootSpanLabel ?? options.serviceName
        const captureHandle = yield* otelite.capture(options)
        const inProcessLayer = makeInProcessLayer(captureHandle, {
          serviceName: options.serviceName,
          exportInterval,
        })
        const inProcessAllSignalsLayer = makeInProcessAllSignalsLayer(captureHandle, {
          serviceName: options.serviceName,
          exportInterval,
        })
        const endpointEnv = {
          OTEL_EXPORTER_OTLP_ENDPOINT: captureHandle.endpoints.http,
          OTEL_SERVICE_NAME: options.serviceName,
        } as const

        const inspect = captureHandle.inspect

        const inspectTraces = (inspectOptions: TraceInspectOptions = {}) =>
          inspect({ ...inspectOptions, signal: 'traces' })

        const trace = (traceOptions: OteliteTraceOptions = {}) =>
          Effect.gen(function* () {
            const spans = yield* inspectTraces({
              service: options.serviceName,
              ...traceOptions.inspect,
            })
            const traceExpect = expectTrace(spans)
            if ((traceOptions.spanLabelPolicy ?? 'required') === 'required') {
              traceExpect.expectSpanLabels()
            }
            return traceExpect
          })

        const withEnv = <A, E, R>(
          effect: Effect.Effect<A, E, R>,
          envOptions: OteliteEnvOptions = {},
        ): Effect.Effect<A, E, R> =>
          envSemaphore.withPermits(1)(
            Effect.scoped(
              scopedEnv({
                [envOptions.endpointVar ?? 'OTEL_EXPORTER_OTLP_ENDPOINT']:
                  captureHandle.endpoints.http,
                [envOptions.serviceNameVar ?? 'OTEL_SERVICE_NAME']: options.serviceName,
                ...envOptions.extra,
              }).pipe(Effect.andThen(effect)),
            ),
          )

        const runInProcess = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
          effect.pipe(
            withOteliteRootSpan({ name: rootSpanName, label: rootSpanLabel }),
            Effect.provide(inProcessLayer),
          )

        const runInProcessTrace = <A, E, R>(
          effect: Effect.Effect<A, E, R>,
          traceOptions?: OteliteTraceOptions,
        ): Effect.Effect<
          TraceExpect,
          E | OteliteSpawnError | OteliteCliError | OteliteDecodeError,
          R
        > =>
          runInProcess(effect).pipe(
            Effect.andThen(flushCaptureSpans({ exportInterval })),
            Effect.andThen(trace(traceOptions)),
          )

        const runInProcessAllSignals = <A, E, R>(
          effect: Effect.Effect<A, E, R>,
          allSignalsOptions?: OteliteAllSignalsOptions,
        ): Effect.Effect<
          AllSignalsExpect,
          E | OteliteSpawnError | OteliteCliError | OteliteDecodeError,
          R
        > =>
          Effect.gen(function* () {
            // Scope-close on the all-signals layer force-flushes every signal's
            // final batch, so the inspects below see the full capture.
            yield* effect.pipe(
              withOteliteRootSpan({ name: rootSpanName, label: rootSpanLabel }),
              Effect.provide(inProcessAllSignalsLayer),
            )
            yield* flushCaptureSpans({ exportInterval })

            const traceOptions = allSignalsOptions?.trace
            const spans: ReadonlyArray<SpanRow> = yield* inspectTraces({
              service: options.serviceName,
              ...traceOptions?.inspect,
            })
            const metricRows: ReadonlyArray<MetricRow> = yield* inspect({
              signal: 'metrics',
              service: options.serviceName,
              ...allSignalsOptions?.metricsInspect,
            })
            const logRows: ReadonlyArray<LogRow> = yield* inspect({
              signal: 'logs',
              service: options.serviceName,
              ...allSignalsOptions?.logsInspect,
            })

            const trace = expectTrace(spans)
            if ((traceOptions?.spanLabelPolicy ?? 'required') === 'required') {
              trace.expectSpanLabels()
            }
            return { trace, metrics: expectMetrics(metricRows), logs: expectLogs(logRows) }
          })

        const withEnvTrace = <A, E, R>(
          effect: Effect.Effect<A, E, R>,
          envOptions?: OteliteEnvOptions,
          traceOptions?: OteliteTraceOptions,
        ): Effect.Effect<
          TraceExpect,
          E | OteliteSpawnError | OteliteCliError | OteliteDecodeError,
          R
        > =>
          withEnv(effect, envOptions).pipe(
            Effect.andThen(flushCaptureSpans({ exportInterval })),
            Effect.andThen(trace(traceOptions)),
          )

        return {
          capture: captureHandle,
          inProcessLayer,
          endpointEnv,
          flush: flushCaptureSpans({ exportInterval }),
          inspect,
          inspectTraces,
          trace,
          runInProcess,
          runInProcessTrace,
          runInProcessAllSignals,
          provideInProcess: runInProcess,
          withEnv,
          withEnvTrace,
        } satisfies OteliteTestHandle
      }).pipe(withOteliteLabelSpan('otelite.test-harness.capture', 'test-harness.capture'))

    return { capture } satisfies OteliteTestHarnessService
  }),
}) {
  /** Provides {@link OteliteTestHarness}, wiring its `Otelite` dependency. */
  static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(Otelite.layer))
}

/** Scoped one-shot {@link OteliteTestHandle}: provides `OteliteTestHarness.layer` so callers needn't wire the layer. */
export const captureTest = (
  options: OteliteTestHarnessOptions,
): Effect.Effect<
  OteliteTestHandle,
  OteliteSpawnError | OteliteCliError | OteliteDecodeError,
  Scope.Scope
> =>
  // oxlint-disable-next-line react-hooks(rules-of-hooks) -- `use` is a Context.Service combinator, not a React hook
  OteliteTestHarness.use((harness) => harness.capture(options)).pipe(
    Effect.provide(OteliteTestHarness.layer),
  )

/** All-in-one: boot a capture, run `effect` through the in-process traces exporter, flush, and return a {@link TraceExpect}. */
export const captureInProcessTrace = <A, E, R>(
  options: OteliteTestHarnessOptions,
  effect: Effect.Effect<A, E, R>,
  traceOptions?: OteliteTraceOptions,
): Effect.Effect<TraceExpect, E | OteliteSpawnError | OteliteCliError | OteliteDecodeError, R> =>
  Effect.scoped(
    captureTest(options).pipe(
      Effect.flatMap((otel) => otel.runInProcessTrace(effect, traceOptions)),
    ),
  )

/** All-in-one all-signals variant: run `effect` through the combined OTLP exporter and assert over traces + metrics + logs at once. */
export const captureInProcessAllSignals = <A, E, R>(
  options: OteliteTestHarnessOptions,
  effect: Effect.Effect<A, E, R>,
  allSignalsOptions?: OteliteAllSignalsOptions,
): Effect.Effect<
  AllSignalsExpect,
  E | OteliteSpawnError | OteliteCliError | OteliteDecodeError,
  R
> =>
  Effect.scoped(
    captureTest(options).pipe(
      Effect.flatMap((otel) => otel.runInProcessAllSignals(effect, allSignalsOptions)),
    ),
  )

/** All-in-one env-var variant: export via `OTEL_*` env vars (for out-of-process/SDK code under test) rather than an injected layer. */
export const captureEnvTrace = <A, E, R>(
  options: OteliteTestHarnessOptions,
  effect: Effect.Effect<A, E, R>,
  envOptions?: OteliteEnvOptions,
  traceOptions?: OteliteTraceOptions,
): Effect.Effect<TraceExpect, E | OteliteSpawnError | OteliteCliError | OteliteDecodeError, R> =>
  Effect.scoped(
    captureTest(options).pipe(
      Effect.flatMap((otel) => otel.withEnvTrace(effect, envOptions, traceOptions)),
    ),
  )
