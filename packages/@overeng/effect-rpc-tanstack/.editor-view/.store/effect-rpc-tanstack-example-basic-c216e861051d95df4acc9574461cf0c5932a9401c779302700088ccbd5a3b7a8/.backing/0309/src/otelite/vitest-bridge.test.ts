import { NodeServices } from '@effect/platform-node'
import { describe, expect, it, layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'
import { OtlpSerialization, OtlpTracer } from 'effect/unstable/observability'

import { Otelite } from './Otelite.ts'
import { otlpTracesUrl } from './otlp-url.ts'
import { flushCaptureSpans, makeOteliteCaptureLayer, OteliteCapture } from './vitest-bridge.ts'

/**
 * The bridge's PER-FILE capture: ONE `Otelite.capture` receiver booted by the
 * shared `layer(...)` scope, the OTLP trace exporter pointed at it. Each test
 * disambiguates by a unique `service.name` / span name and asserts its span
 * round-trips through the live handle — which only holds if the exporter posted
 * to `${endpoint}/v1/traces` (the locked suffix). A misrouted exporter
 * self-disables and these assertions go to 0, failing the test (the
 * silent-failure guard).
 */
const exportInterval = 100
const CaptureLayer = makeOteliteCaptureLayer({ exportInterval })

describe('otlpTracesUrl', () => {
  // Lock the suffix so the trace-exporter URL bug cannot regress: OtlpTracer
  // POSTs `url` VERBATIM, so a bare base endpoint must get `/v1/traces`.
  it('appends /v1/traces and normalizes a trailing slash', () => {
    expect(otlpTracesUrl('http://127.0.0.1:4318')).toBe('http://127.0.0.1:4318/v1/traces')
    expect(otlpTracesUrl('http://127.0.0.1:4318/')).toBe('http://127.0.0.1:4318/v1/traces')
  })
})

// `excludeTestServices: true` removes the virtual TestClock so `it.effect`
// runs on the REAL clock — the OTLP exporter's background batch loop and the
// flush sleep both need wall-clock time to tick.
layer(CaptureLayer, { excludeTestServices: true })('OteliteCapture bridge', (it) => {
  // The core end-to-end gate: emit a span IN-PROCESS through the REAL OTLP
  // exporter layer (NOT a raw POST), then assert via the handle that it landed.
  // This validates the `/v1/traces` fix AND the exporter→receiver path together.
  it.effect('captures a span emitted in-process through the OTLP exporter', () =>
    Effect.gen(function* () {
      const cap = yield* OteliteCapture
      const spanName = 'bridge-inprocess-span-a'

      // Emit through the bridge's tracer (installed by the shared layer).
      yield* Effect.void.pipe(Effect.withSpan(spanName))
      // Force a flush so the batch exports before we inspect (emitter's job).
      yield* flushCaptureSpans({ exportInterval })

      const rows = yield* cap.inspect({ signal: 'traces', name: spanName })
      expect(rows.length).toBeGreaterThanOrEqual(1)
      const span = rows.find((r) => r.name === spanName)!
      expect(span.schema).toBe('otelite.span/v1')
      expect(span.service).toBe('otelite-capture-bridge')

      // Silent-failure guard: a non-zero span count, asserted explicitly.
      const summary = yield* cap.inspect({ signal: 'traces', summary: true })
      expect(summary.span_count).toBeGreaterThanOrEqual(1)
    }),
  )

  // A SECOND test in the SAME file shares the SAME receiver (per-file
  // lifecycle): it disambiguates by a distinct span name and still finds only
  // its own span via the `--name` filter.
  it.effect('shares the per-file receiver and disambiguates by span name', () =>
    Effect.gen(function* () {
      const cap = yield* OteliteCapture
      const spanName = 'bridge-inprocess-span-b'

      yield* Effect.void.pipe(Effect.withSpan(spanName))
      yield* flushCaptureSpans({ exportInterval })

      const rows = yield* cap.inspect({ signal: 'traces', name: spanName })
      expect(rows.every((r) => r.name === spanName)).toBe(true)
      expect(rows.length).toBeGreaterThanOrEqual(1)
    }),
  )
})

/**
 * Regression assertion that a BARE (un-suffixed) exporter URL does NOT capture.
 * This wires the tracer EXACTLY as the pre-fix `makeOtelVitestLayer` did —
 * `OtlpTracer.layer({ url: handle.endpoints.http })`, no `/v1/traces` — so the
 * exporter POSTs to the receiver ROOT, which the receiver does not serve as the
 * traces ingest path; the export fails and the exporter self-disables, so
 * nothing lands. The contrasting suffixed path is the main bridge test above
 * (which DOES capture). Together they prove the suffix is load-bearing.
 */
const BareTestLayer = Otelite.layer.pipe(Layer.provideMerge(NodeServices.layer))

describe('OteliteCapture bridge — suffix regression', () => {
  it.live(
    'a bare (un-suffixed) exporter URL captures nothing',
    () =>
      Effect.gen(function* () {
        const otelite = yield* Otelite
        const handle = yield* otelite.capture()

        // The pre-fix wiring verbatim: bare base endpoint, no `/v1/traces`.
        const bareTracer = OtlpTracer.layer({
          url: handle.endpoints.http,
          resource: { serviceName: 'bare-svc' },
          exportInterval,
        }).pipe(
          Layer.provideMerge(FetchHttpClient.layer),
          Layer.provideMerge(OtlpSerialization.layerJson),
        )

        yield* Effect.void.pipe(
          Effect.withSpan('bare-span'),
          Effect.provide(bareTracer),
          Effect.scoped,
        )
        yield* flushCaptureSpans({ exportInterval })

        const rows = yield* handle.inspect({ signal: 'traces', name: 'bare-span' })
        expect(rows).toHaveLength(0)
      }).pipe(Effect.provide(BareTestLayer)),
    30_000,
  )
})
