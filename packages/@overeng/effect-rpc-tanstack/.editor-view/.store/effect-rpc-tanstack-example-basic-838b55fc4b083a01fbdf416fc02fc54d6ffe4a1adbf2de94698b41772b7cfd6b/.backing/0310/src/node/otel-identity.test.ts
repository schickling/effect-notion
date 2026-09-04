/**
 * End-to-end proof that {@link makeOtelCliLayer}'s typed `identity` stamps
 * `service.{name,namespace,version}` onto the OTLP resource of EVERY signal
 * (traces, metrics, logs), and that the `OTEL_RESOURCE_ATTRIBUTES` env attrs are
 * still inherited onto that resource (explicit identity wins on collision, but
 * env-only attrs survive — the parity seam this test locks).
 *
 * Resource attributes are dropped by otelite's flat-row `inspect`, so these
 * assertions read the raw per-signal `*.ndjson` and walk the resource block.
 */

import { NodeServices } from '@effect/platform-node'
import { Effect, FileSystem, Layer, Metric, Option, Result, Schema, type Scope } from 'effect'
import { expect } from 'vitest'

import { ServiceIdentity } from '@overeng/otel-contract'
import { Vitest } from '@overeng/utils-dev/node-vitest'
import { Otelite } from '@overeng/utils-dev/otelite'

import { makeOtelCliLayer } from './otel.ts'

const identity = Schema.decodeSync(ServiceIdentity)({
  name: 'identity-cli',
  namespace: 'overeng.test',
  version: '9.9.9',
})

/** A workload that emits all three signals (span + counter + log) with no sleeps. */
const workload = Effect.gen(function* () {
  yield* Effect.annotateCurrentSpan('span.label', 'identity-root')
  yield* Metric.update(Metric.counter('identity_requests_total'), 1)
  yield* Effect.log('identity demo log line')
}).pipe(Effect.withSpan('identity-root', { root: true }))

/** Scoped env mutation that restores the previous values on scope close. */
const scopedEnv = (
  values: Readonly<Record<string, string | undefined>>,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previous: Record<string, string | undefined> = {}
      for (const key of Object.keys(values)) {
        previous[key] = process.env[key]
        if (values[key] === undefined) delete process.env[key]
        else process.env[key] = values[key]
      }
      return previous
    }),
    (previous) =>
      Effect.sync(() => {
        for (const key of Object.keys(previous)) {
          if (previous[key] === undefined) delete process.env[key]
          else process.env[key] = previous[key]
        }
      }),
  ).pipe(Effect.asVoid)

/**
 * Read every `<signal>.ndjson` line from a capture out-dir and return the union
 * of resource attribute maps (`key -> stringValue`) found across all signals,
 * keyed by signal so a test can assert the identity rode each one.
 */
const resourceAttrsBySignal = (
  outDir: string,
): Effect.Effect<Record<string, Record<string, string>>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const files: ReadonlyArray<readonly [string, string]> = [
      ['traces', 'resourceSpans'],
      ['metrics', 'resourceMetrics'],
      ['logs', 'resourceLogs'],
    ]
    const out: Record<string, Record<string, string>> = {}
    // @effect-diagnostics-next-line schemaSyncInEffect:off -- reads the tool's own capture ndjson in a controlled test env; a malformed line is a scaffolding bug, so a thrown defect is correct (this helper is annotated `Effect<..., never, FileSystem>`).
    const parseLine = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Record(Schema.String, Schema.Array(Schema.Any))),
    )
    for (const [signal, resourceKey] of files) {
      const raw = yield* fs
        .readFileString(`${outDir}/${signal}.ndjson`)
        .pipe(Effect.orElseSucceed(() => ''))
      const attrs: Record<string, string> = {}
      for (const line of raw.split('\n')) {
        if (line.trim() === '') continue
        const parsed = parseLine(line) as Record<string, ReadonlyArray<Record<string, unknown>>>
        for (const entry of parsed[resourceKey] ?? []) {
          const resource = entry['resource'] as
            | { attributes?: ReadonlyArray<{ key: string; value: { stringValue?: string } }> }
            | undefined
          for (const attr of resource?.attributes ?? []) {
            if (attr.value.stringValue !== undefined) attrs[attr.key] = attr.value.stringValue
          }
        }
      }
      out[signal] = attrs
    }
    return out
  })

const runWorkload = (endpoint: string) =>
  Effect.scoped(
    workload.pipe(
      Effect.provide(
        makeOtelCliLayer({
          identity,
          endpoint: Option.some(endpoint),
          exportInterval: 50,
          metricsExportInterval: 100,
          shutdownTimeout: 4000,
        }),
      ),
    ),
  )

Vitest.describe('makeOtelCliLayer — typed ServiceIdentity', () => {
  Vitest.it.effect(
    'stamps service.{name,namespace,version} on the resource of all three signals',
    () =>
      Effect.gen(function* () {
        const otelite = yield* Otelite
        const cap = yield* otelite.capture({})

        // Isolate from any ambient resource env so this test measures only the
        // explicit identity.
        yield* Effect.scoped(
          scopedEnv({ OTEL_RESOURCE_ATTRIBUTES: undefined, OTEL_SERVICE_NAME: undefined }).pipe(
            Effect.andThen(runWorkload(cap.endpoints.http)),
          ),
        )

        // Force the summary to drain by reading rows first (sanity: signals landed).
        const spans = yield* cap.inspect({ signal: 'traces', service: identity.name })
        const metrics = yield* cap.inspect({ signal: 'metrics', service: identity.name })
        const logs = yield* cap.inspect({ signal: 'logs', service: identity.name })
        expect(spans.length).toBeGreaterThan(0)
        expect(metrics.length).toBeGreaterThan(0)
        expect(logs.length).toBeGreaterThan(0)

        const attrs = yield* resourceAttrsBySignal(cap.outDir)
        for (const signal of ['traces', 'metrics', 'logs'] as const) {
          expect(attrs[signal]?.['service.name']).toBe('identity-cli')
          expect(attrs[signal]?.['service.namespace']).toBe('overeng.test')
          expect(attrs[signal]?.['service.version']).toBe('9.9.9')
        }
      }).pipe(Effect.provide(Layer.provideMerge(Otelite.layer, NodeServices.layer))),
  )

  Vitest.it.effect(
    'inherits OTEL_RESOURCE_ATTRIBUTES env attrs onto the resource (explicit identity wins on collision)',
    () =>
      Effect.gen(function* () {
        const otelite = yield* Otelite
        const cap = yield* otelite.capture({})

        // An env-only attr (deployment.environment) plus a colliding one
        // (service.namespace) the explicit identity must override.
        yield* Effect.scoped(
          scopedEnv({
            OTEL_RESOURCE_ATTRIBUTES:
              'deployment.environment=ci-test,service.namespace=env-namespace',
            OTEL_SERVICE_NAME: undefined,
          }).pipe(Effect.andThen(runWorkload(cap.endpoints.http))),
        )

        const spans = yield* cap.inspect({ signal: 'traces', service: identity.name })
        expect(spans.length).toBeGreaterThan(0)

        const attrs = yield* resourceAttrsBySignal(cap.outDir)
        // Env-only attr is inherited (the parity seam).
        expect(attrs['traces']?.['deployment.environment']).toBe('ci-test')
        // Explicit identity wins over the colliding env value.
        expect(attrs['traces']?.['service.namespace']).toBe('overeng.test')
      }).pipe(Effect.provide(Layer.provideMerge(Otelite.layer, NodeServices.layer))),
  )

  Vitest.it.effect('rejects a raw-string name on the typed identity path', () =>
    Effect.gen(function* () {
      // A raw string is not a branded ServiceIdentity.name: names must pass
      // through the ServiceIdentity schema, and malformed names fail at the edge.
      const result = yield* Effect.result(
        Schema.decodeUnknownEffect(ServiceIdentity)({
          name: '1identity-cli',
          namespace: 'overeng',
          version: '1.0.0',
        }),
      )
      expect(Result.isSuccess(result)).toBe(false)
    }),
  )
})
