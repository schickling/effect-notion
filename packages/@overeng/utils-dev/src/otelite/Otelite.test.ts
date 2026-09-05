import { access } from 'node:fs/promises'

import { NodeServices } from '@effect/platform-node'
import { describe, expect, it } from '@effect/vitest'
import { Effect, Exit, Layer, Schema } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

import { SERVICE_NAME, SPAN_NAME } from './emitter.ts'
import {
  Otelite,
  OteliteChildFailed,
  OteliteCliError,
  type SpanRow,
  Summary,
  TraceSummary,
} from './mod.ts'

/** One OTLP/JSON span in the SDK dialect the receiver decodes; raw-POSTed by the
 * capture tests so the primitive is validated without an OTel exporter. */
const captureSpanPayload = (name: string, service: string) =>
  JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
        scopeSpans: [
          {
            scope: { name: 'otelite-capture-e2e' },
            spans: [
              {
                traceId: '5b8efff798038103d269b633813fc60c',
                spanId: 'eee19b7ec3c1b174',
                name,
                kind: 2,
                startTimeUnixNano: '1000000000',
                endTimeUnixNano: '1003000000',
                attributes: [{ key: 'cap.marker', value: { stringValue: 'ok' } }],
              },
            ],
          },
        ],
      },
    ],
  })

/** Reads one Buck-declared immutable tool path; nothing resolves through an ambient PATH. */
const requireTool = (name: string): string => {
  const tool = process.env[name]
  if (tool === undefined || tool === '')
    throw new Error(`declared test tool is unavailable: ${name}`)
  return tool
}

/** Real otelite binary (declared as `OTELITE_BIN`) + Node platform layer. */
const TestLayer = Otelite.layer.pipe(Layer.provideMerge(NodeServices.layer))

/** Child binaries the run tests spawn, each named by its declared tool env. */
const trueBin = requireTool('TRUE_BIN')
const falseBin = requireTool('FALSE_BIN')
const bunBin = requireTool('BUN_BIN')

const tracesFixture = new URL('./fixtures/traces.ndjson', import.meta.url).pathname
const emitter = new URL('./emitter.ts', import.meta.url).pathname

describe('Otelite', () => {
  it.effect('run() yields a decoded otelite.summary/v1 for a successful child', () =>
    Effect.gen(function* () {
      const otelite = yield* Otelite
      const summary = yield* otelite.run({ command: [trueBin] })

      expect(summary.schema).toBe('otelite.summary/v1')
      expect(summary.child).toEqual({ argv: [trueBin], exit_code: 0 })
      expect(summary.counts).toEqual({ spans: 0, metrics: 0, logs: 0 })
      expect(summary.out).toMatch(/otelite-/)
      expect(summary.endpoints.http).toMatch(/^http:\/\//)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect('a non-zero child surfaces as the tagged OteliteChildFailed error', () =>
    Effect.gen(function* () {
      const otelite = yield* Otelite
      const exit = yield* otelite.run({ command: [falseBin] }).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      const error = yield* otelite.run({ command: [falseBin] }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(OteliteChildFailed)
      expect((error as OteliteChildFailed).exitCode).toBe(1)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect('the scoped out-dir is released after the run scope closes', () =>
    Effect.gen(function* () {
      const otelite = yield* Otelite
      // Capture the minted dir from within a child scope; the finalizer removes
      // it when that inner scope closes.
      const out = yield* Effect.scoped(
        otelite.run({ command: [trueBin] }).pipe(Effect.map((s) => s.out)),
      )
      const exists = yield* Effect.promise(() =>
        access(out)
          .then(() => true)
          .catch(() => false),
      )
      expect(exists).toBe(false)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect('inspect() over a committed traces fixture yields typed span rows', () =>
    Effect.gen(function* () {
      const otelite = yield* Otelite
      const rows = yield* otelite.inspect({ src: tracesFixture, signal: 'traces' })

      expect(rows).toHaveLength(2)
      expect(rows.every((r) => r.schema === 'otelite.span/v1')).toBe(true)
      const op1 = rows.find((r) => r.name === 'op1')!
      expect(op1.service).toBe('svc-a')
      expect(op1.attrs).toEqual({ 'http.method': 'GET' })
      expect(op1.parent_span_id).toBeNull()
      expect(op1.duration_ms).toBe(5)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect('inspect(--name) narrows the flat rows', () =>
    Effect.gen(function* () {
      const otelite = yield* Otelite
      const rows = yield* otelite.inspect({ src: tracesFixture, signal: 'traces', name: 'op2' })
      expect(rows).toHaveLength(1)
      expect(rows[0]!.name).toBe('op2')
      expect(rows[0]!.parent_span_id).toBe('aaaaaaaaaaaaaaaa')
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect('inspect(summary) yields the typed otelite.trace-summary/v1 report', () =>
    Effect.gen(function* () {
      const otelite = yield* Otelite
      const report = yield* otelite.inspect({
        src: tracesFixture,
        signal: 'traces',
        summary: true,
      })
      expect(report.schema).toBe('otelite.trace-summary/v1')
      expect(report.span_count).toBe(2)
      expect(report.root_service).toBe('svc-a')
      expect(report.duration_ms).toBe(5)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect('an inspect source that is missing surfaces as OteliteCliError', () =>
    Effect.gen(function* () {
      const otelite = yield* Otelite
      const error = yield* otelite
        .inspect({ src: '/nonexistent/otelite-effect-missing.ndjson', signal: 'traces' })
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(OteliteCliError)
      expect((error as OteliteCliError).reason).toBe('no-input')
      expect((error as OteliteCliError).exitCode).toBe(66)
    }).pipe(Effect.provide(TestLayer)),
  )

  // The one end-to-end test that closes the loop: a hand-instrumented Effect
  // emitter POSTs a known OTLP/JSON span to the receiver otelite injects, and we
  // assert it round-trips back out through the typed `inspect`. No fixtures —
  // the span travels the real wire.
  it.effect('run(emitter) captures a live OTLP span that round-trips through typed inspect', () =>
    Effect.gen(function* () {
      const otelite = yield* Otelite
      const summary = yield* otelite.run({ command: [bunBin, emitter] })

      // The summary itself is the live receiver's count of what landed.
      expect(summary.schema).toBe('otelite.summary/v1')
      expect(summary.child).toEqual({ argv: [bunBin, emitter], exit_code: 0 })
      expect(summary.counts.spans).toBe(1)
      // The `otelite.summary/v1` contract round-trips through `Schema`.
      expect(Schema.is(Summary)(summary)).toBe(true)

      // Flat rows: the captured span decodes as a typed `SpanRow` with our
      // distinctive name + service.
      const rows = yield* otelite.inspect({ src: summary.out, signal: 'traces' })
      expect(rows).toHaveLength(1)
      const span = rows[0]!
      expect(span.schema).toBe('otelite.span/v1')
      expect(span.name).toBe(SPAN_NAME)
      expect(span.service).toBe(SERVICE_NAME)
      expect(span.attrs).toEqual({ 'e2e.marker': 'ok' })
      expect(span.duration_ms).toBe(7)

      // Summary report: the typed `TraceSummary` agrees and round-trips.
      const report = yield* otelite.inspect({
        src: summary.out,
        signal: 'traces',
        summary: true,
      })
      expect(report.schema).toBe('otelite.trace-summary/v1')
      expect(report.span_count).toBe(1)
      expect(report.root_service).toBe(SERVICE_NAME)
      expect(Schema.is(TraceSummary)(report)).toBe(true)
    }).pipe(Effect.provide(TestLayer)),
  )
})

/** Raw OTLP/JSON POST at a live receiver (no exporter — the primitive under test). */
const postSpan = (httpEndpoint: string, name: string, service: string) =>
  Effect.promise(() =>
    fetch(`${httpEndpoint}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: captureSpanPayload(name, service),
    }),
  )

describe('Otelite.capture', () => {
  // The primitive's core loop while the receiver is LIVE: open the scoped
  // capture, raw-POST a known OTLP span (no exporter — that's the next phase),
  // assert the typed row round-trips through the handle's `inspect`. The bounded
  // retry inside `inspect` absorbs any sub-ms visibility lag; running this a few
  // times exercises that it doesn't flake.
  it.effect('capture() serves a live receiver: a raw OTLP POST round-trips through inspect', () =>
    Effect.gen(function* () {
      const otelite = yield* Otelite
      const handle = yield* otelite.capture()

      expect(handle.endpoints.http).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      expect(handle.endpoints.grpc).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

      const res = yield* postSpan(handle.endpoints.http, SPAN_NAME, SERVICE_NAME)
      expect(res.status).toBe(200)

      const rows: ReadonlyArray<SpanRow> = yield* handle.inspect({ signal: 'traces' })
      expect(rows).toHaveLength(1)
      const span = rows[0]!
      expect(span.schema).toBe('otelite.span/v1')
      expect(span.name).toBe(SPAN_NAME)
      expect(span.service).toBe(SERVICE_NAME)
      expect(span.attrs).toEqual({ 'cap.marker': 'ok' })
    }).pipe(Effect.provide(TestLayer)),
  )

  // The drained `otelite.summary/v1`: opened in a child scope so its finalizer
  // stops + drains the receiver; `handle.summary` (a Deferred) only resolves
  // after that, so we await it AFTER the scope closes.
  it.effect('the drained summary counts the captured span after the scope closes', () =>
    Effect.gen(function* () {
      const otelite = yield* Otelite
      const summary = yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* otelite.capture()
          yield* postSpan(handle.endpoints.http, SPAN_NAME, SERVICE_NAME)
          // @effect-diagnostics-next-line returnEffectInGen:off -- `handle.summary` (a Deferred) only resolves AFTER this scope's finalizer drains the receiver; it must be returned unyielded so `Effect.scoped` completes first, then the outer `.pipe(Effect.flatten)` awaits it. Yielding here would deadlock.
          return handle.summary
        }),
      ).pipe(Effect.flatten)

      expect(summary.schema).toBe('otelite.summary/v1')
      expect(summary.child).toBeNull()
      expect(summary.counts.spans).toBe(1)
      expect(Schema.is(Summary)(summary)).toBe(true)
    }).pipe(Effect.provide(TestLayer)),
  )

  // Lifecycle: after the capture scope closes, the auto-minted out-dir is gone
  // (proves the finalizer ran) and no `otelite` process still references it (no
  // orphaned child). The out-dir path is unique per capture, so this stays
  // robust under concurrent test runs.
  it.effect('the capture scope closes cleanly: out-dir removed, no orphaned process', () =>
    Effect.gen(function* () {
      const otelite = yield* Otelite
      const outDir = yield* Effect.scoped(otelite.capture().pipe(Effect.map((h) => h.outDir)))

      const exists = yield* Effect.promise(() =>
        access(outDir)
          .then(() => true)
          .catch(() => false),
      )
      expect(exists).toBe(false)

      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const psOut = yield* spawner.string(ChildProcess.make(requireTool('PS_BIN'), ['-eo', 'args']))
      const orphaned = psOut
        .split('\n')
        .some((line) => line.includes('otelite') && line.includes(outDir))
      expect(orphaned).toBe(false)
    }).pipe(Effect.provide(TestLayer)),
  )
})
