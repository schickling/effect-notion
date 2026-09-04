/**
 * End-to-end proof for the typed telemetry front door ({@link withTelemetry}) and
 * the periodic resource-sampler primitive ({@link sampleResource} /
 * {@link sampleGauge} / {@link telemetryEnabled}), captured + asserted via the
 * real otelite DSL.
 *
 * Proves:
 * - The `cli` shape lands all three signals (traces, metrics, logs) with the
 *   typed identity stamped on each.
 * - `sampleGauge` emits when an endpoint is configured and is a true NO-OP (the
 *   per-tick read never runs ⇒ no fiber forked) when telemetry is off.
 * - `telemetryEnabled` reflects the resolved {@link OtelConfig} state (and the
 *   absent-layer case).
 */

import { NodeServices } from '@effect/platform-node'
import { Effect, Layer, Metric, Option, Schema } from 'effect'
import { expect } from 'vitest'

import { ServiceIdentity } from '@overeng/otel-contract'
import { Vitest } from '@overeng/utils-dev/node-vitest'
import { expectLogs, expectMetrics, expectTrace, Otelite } from '@overeng/utils-dev/otelite'

import { OtelConfig, sampleGauge, telemetryEnabled, withTelemetry } from './otel.ts'

const identity = Schema.decodeSync(ServiceIdentity)({
  name: 'telemetry-cli',
  namespace: 'overeng.test',
  version: '4.2.0',
})
const SERVICE = identity.name

/** Emits one span (with a child carrying `span.label`), a counter, a gauge, and
 *  one bridged `Effect.log` line — no sleeps. */
const workload = Effect.gen(function* () {
  yield* Effect.annotateCurrentSpan('span.label', 'parent')
  yield* Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan('span.label', 'child')
    yield* Metric.update(Metric.counter('telemetry_requests_total'), 1)
    yield* Metric.update(Metric.gauge('telemetry_queue_depth', { bigint: false }), 7)
    yield* Effect.log('telemetry demo log line')
  }).pipe(Effect.withSpan('telemetry-child'))
}).pipe(Effect.withSpan('telemetry-parent', { root: true }))

Vitest.describe('withTelemetry — typed front door', () => {
  Vitest.it.effect('cli shape lands all three signals with the typed identity on each', () =>
    Effect.gen(function* () {
      const otelite = yield* Otelite
      const cap = yield* otelite.capture({})

      // Inner scope close = the cli force-flush. No sleeps.
      yield* Effect.scoped(
        workload.pipe(
          Effect.provide(
            withTelemetry({
              identity,
              shape: 'cli',
              endpoint: Option.some(cap.endpoints.http),
            }),
          ),
        ),
      )

      const spans = yield* cap.inspect({ signal: 'traces', service: SERVICE })
      const metrics = yield* cap.inspect({ signal: 'metrics', service: SERVICE })
      const logs = yield* cap.inspect({ signal: 'logs', service: SERVICE })

      // Traces: parent/child tree + span.label on every span.
      const trace = expectTrace(spans)
      trace.expectSpanLabels()
      const parent = trace.expectOne({ name: 'telemetry-parent' })
      const child = trace.expectOne({ name: 'telemetry-child' })
      expect(child.parent_span_id).toBe(parent.span_id)

      // Metrics: counter (sum=1) + gauge (7).
      const m = expectMetrics(metrics)
      m.expectOne({ name: 'telemetry_requests_total', service: SERVICE, type: 'sum', value: 1 })
      m.expectOne({ name: 'telemetry_queue_depth', service: SERVICE, type: 'gauge', value: 7 })

      // Logs: the Effect.log line bridged to OTLP.
      expectLogs(logs).expectOne({
        service: SERVICE,
        severityText: 'Info',
        body: 'telemetry demo log line',
      })

      // Identity (otelite `service` col = service.name) on every signal's rows.
      for (const rows of [spans, metrics, logs]) {
        expect(rows.length).toBeGreaterThan(0)
        expect(rows.every((r) => r.service === SERVICE)).toBe(true)
      }
    }).pipe(Effect.provide(Layer.provideMerge(Otelite.layer, NodeServices.layer))),
  )
})

Vitest.describe('sampleGauge / telemetryEnabled — sampler primitive', () => {
  Vitest.it.effect('emits the gauge when an endpoint is configured', () =>
    Effect.gen(function* () {
      const otelite = yield* Otelite
      const cap = yield* otelite.capture({})
      const gauge = Metric.gauge('telemetry_sampled_bytes', { bigint: false })

      // The sampler forks under the telemetry layer's scope; closing it flushes.
      yield* Effect.scoped(
        sampleGauge({ gauge, read: () => 1234 }).pipe(
          Effect.provide(
            withTelemetry({ identity, shape: 'cli', endpoint: Option.some(cap.endpoints.http) }),
          ),
        ),
      )

      const metrics = yield* cap.inspect({ signal: 'metrics', service: SERVICE })
      expectMetrics(metrics).expectOne({
        name: 'telemetry_sampled_bytes',
        service: SERVICE,
        type: 'gauge',
        value: 1234,
      })
    }).pipe(Effect.provide(Layer.provideMerge(Otelite.layer, NodeServices.layer))),
  )

  Vitest.it.effect('is a true no-op (never reads, never forks) when telemetry is off', () =>
    Effect.gen(function* () {
      // The sampler's `read` is the per-tick side effect. If the gate short-
      // circuits before forking, it is NEVER invoked — so a plain mutable count
      // staying 0 proves "no fork", not merely "metric went nowhere".
      let reads = 0
      const gauge = Metric.gauge('telemetry_unsampled_bytes', { bigint: false })

      // No endpoint ⇒ OtelConfig.endpoint = None ⇒ telemetry disabled. Open and
      // close a scope so any forked fiber would have ticked at least once.
      yield* Effect.scoped(
        sampleGauge({
          gauge,
          read: () => {
            reads += 1
            return reads
          },
        }).pipe(Effect.provide(withTelemetry({ identity, shape: 'cli', endpoint: Option.none() }))),
      )

      expect(reads).toBe(0)
    }),
  )

  Vitest.it.effect('telemetryEnabled is true when an endpoint is configured', () =>
    Effect.gen(function* () {
      const enabled = yield* telemetryEnabled.pipe(
        Effect.provide(
          Layer.succeed(OtelConfig, { endpoint: Option.some('http://127.0.0.1:4318') }),
        ),
      )
      expect(enabled).toBe(true)
    }),
  )

  Vitest.it.effect('telemetryEnabled is false when the endpoint is None', () =>
    Effect.gen(function* () {
      const enabled = yield* telemetryEnabled.pipe(
        Effect.provide(Layer.succeed(OtelConfig, { endpoint: Option.none() })),
      )
      expect(enabled).toBe(false)
    }),
  )

  Vitest.it.effect('telemetryEnabled is false when the OtelConfig layer is absent', () =>
    Effect.gen(function* () {
      const enabled = yield* telemetryEnabled
      expect(enabled).toBe(false)
    }),
  )
})
