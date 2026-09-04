import { NodeServices } from '@effect/platform-node'
import { describe, expect, it } from '@effect/vitest'
import { Effect, FileSystem, Layer, Metric, Schema } from 'effect'

import { TraceJson, writeCaptureDiagnostics } from './diagnostics.ts'
import {
  captureInProcessAllSignals,
  captureInProcessTrace,
  OteliteTestHarness,
} from './test-harness.ts'

describe('OteliteTestHarness', () => {
  it.live(
    'captures in-process spans through the provided OTLP layer',
    () =>
      Effect.gen(function* () {
        const harness = yield* OteliteTestHarness
        const otel = yield* harness.capture({
          serviceName: 'otelite-test-harness',
          rootSpanName: 'otelite-test-harness.root',
          exportInterval: 50,
        })

        yield* otel.runInProcess(
          Effect.void.pipe(
            Effect.withSpan('otelite-test-harness.child', {
              attributes: { 'span.label': 'child' },
            }),
          ),
        )
        yield* otel.flush

        const trace = yield* otel.trace()
        const root = trace.expectOne({ name: 'otelite-test-harness.root' })
        const child = trace.expectOne({ name: 'otelite-test-harness.child' })
        expect(root.attrs['span.label']).toBe('otelite-test-harness')
        expect(child.service).toBe('otelite-test-harness')
        expect(child.attrs['span.label']).toBe('child')
        expect(trace.expectSameTrace([{ name: root.name }, { name: child.name }])).toBe(
          child.trace_id,
        )
      }).pipe(Effect.provide(OteliteTestHarness.layer)),
    30_000,
  )

  it.live(
    'returns trace expectations from the ergonomic capture helper',
    () =>
      Effect.gen(function* () {
        const trace = yield* captureInProcessTrace(
          {
            serviceName: 'otelite-test-harness-helper',
            rootSpanName: 'otelite-test-harness-helper.root',
            exportInterval: 50,
          },
          Effect.void.pipe(
            Effect.withSpan('otelite-test-harness-helper.child', {
              attributes: { 'span.label': 'helper' },
            }),
          ),
        )

        expect(
          trace.expectOne({
            name: 'otelite-test-harness-helper.child',
            attrs: { 'span.label': 'helper' },
          }).service,
        ).toBe('otelite-test-harness-helper')
      }),
    30_000,
  )

  it.live(
    'writes reusable trace diagnostics JSON from a capture',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const outDir = yield* fs.makeTempDirectoryScoped()
        const harness = yield* OteliteTestHarness
        const otel = yield* harness.capture({
          serviceName: 'otelite-diagnostics',
          rootSpanName: 'otelite-diagnostics.root',
          exportInterval: 50,
        })

        yield* otel.runInProcess(
          Effect.void.pipe(
            Effect.withSpan('otelite-diagnostics.child', {
              attributes: { 'span.label': 'child' },
            }),
          ),
        )
        yield* otel.flush

        const files = yield* writeCaptureDiagnostics({
          capture: otel.capture,
          outDir,
          service: 'otelite-diagnostics',
        })

        const traceJson = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(TraceJson))(
          yield* fs.readFileString(files.traceJson),
        )
        expect(traceJson.schema).toBe('otelite.trace-json/v1')
        expect(traceJson.summary.span_count).toBeGreaterThanOrEqual(2)
        expect(traceJson.spans.some((span) => span.name === 'otelite-diagnostics.child')).toBe(true)
      }).pipe(Effect.provide(Layer.mergeAll(OteliteTestHarness.layer, NodeServices.layer))),
    30_000,
  )

  it.live(
    'restores endpoint environment after scoped use',
    () =>
      Effect.gen(function* () {
        const previousEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
        const previousService = process.env.OTEL_SERVICE_NAME
        const previousCustomEndpoint = process.env.OTELITE_TEST_ENDPOINT
        const previousCustomService = process.env.OTELITE_TEST_SERVICE
        const previousExtra = process.env.OTELITE_TEST_EXTRA
        const harness = yield* OteliteTestHarness
        const otel = yield* harness.capture({
          serviceName: 'otelite-env-harness',
          exportInterval: 50,
        })

        yield* otel.withEnv(
          Effect.sync(() => {
            expect(process.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(otel.capture.endpoints.http)
            expect(process.env.OTEL_SERVICE_NAME).toBe('otelite-env-harness')
          }),
        )

        expect(process.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(previousEndpoint)
        expect(process.env.OTEL_SERVICE_NAME).toBe(previousService)

        yield* otel.withEnv(
          Effect.sync(() => {
            expect(process.env.OTELITE_TEST_ENDPOINT).toBe(otel.capture.endpoints.http)
            expect(process.env.OTELITE_TEST_SERVICE).toBe('otelite-env-harness')
            expect(process.env.OTELITE_TEST_EXTRA).toBe('extra')
          }),
          {
            endpointVar: 'OTELITE_TEST_ENDPOINT',
            serviceNameVar: 'OTELITE_TEST_SERVICE',
            extra: { OTELITE_TEST_EXTRA: 'extra' },
          },
        )

        expect(process.env.OTELITE_TEST_ENDPOINT).toBe(previousCustomEndpoint)
        expect(process.env.OTELITE_TEST_SERVICE).toBe(previousCustomService)
        expect(process.env.OTELITE_TEST_EXTRA).toBe(previousExtra)
      }).pipe(Effect.provide(OteliteTestHarness.layer)),
    30_000,
  )

  it.live(
    'captures traces + metrics + logs in one in-process run',
    () => {
      const service = 'otelite-all-signals'
      const counter = Metric.counter('otelite_all_signals_requests_total')
      const gauge = Metric.gauge('otelite_all_signals_queue_depth', { bigint: false })

      const workload = Effect.gen(function* () {
        yield* Metric.update(counter, 1)
        yield* Metric.update(Metric.withAttributes(gauge, { queue: 'primary' }), 7)
        yield* Effect.log('all-signals demo log line')
      }).pipe(Effect.withSpan(`${service}.child`, { attributes: { 'span.label': 'child' } }))

      return captureInProcessAllSignals(
        { serviceName: service, rootSpanName: `${service}.root`, exportInterval: 100 },
        workload,
      ).pipe(
        Effect.flatMap(({ trace, metrics, logs }) =>
          Effect.sync(() => {
            // TRACES: root + child both present, both carry span.label.
            const root = trace.expectOne({ name: `${service}.root` })
            const child = trace.expectOne({ name: `${service}.child` })
            expect(child.parent_span_id).toBe(root.span_id)
            expect(child.attrs['span.label']).toBe('child')

            // METRICS: counter (sum=1) + labeled gauge (=7) via the DSL.
            metrics.expectOne({
              name: 'otelite_all_signals_requests_total',
              service,
              type: 'sum',
              value: 1,
            })
            metrics.expectOne({
              name: 'otelite_all_signals_queue_depth',
              service,
              type: 'gauge',
              value: 7,
              attrs: { queue: 'primary' },
            })

            // LOGS: the Effect.log line bridged to OTLP, correlated to the child span.
            const log = logs.expectOne({
              service,
              severityText: 'Info',
              body: 'all-signals demo log line',
            })
            expect(log.span_id).toBe(child.span_id)
          }),
        ),
      )
    },
    30_000,
  )
})
