/**
 * SC-R12 — Weaver `live-check` e2e (the third Weaver gate; additive).
 *
 * Proves that OTLP EMITTED by a first-party telemetry site conforms to the emitted registry.
 * End to end:
 *   1. The demo (`acme.*`) contract's DERIVED encoder (`ProbeSpan.encoder`) produces an attribute
 *      map — the real runtime authoring path, not a fixture.
 *   2. Those attributes are emitted as an OTLP span through the otelite in-process exporter and
 *      CAPTURED on the wire (the harness records the exact `ExportTraceServiceRequest` JSON).
 *   3. An adapter projects the captured OTLP into weaver's live-check "sample" format (weaver's
 *      file input is its own sample schema, NOT raw OTLP — see the module note below).
 *   4. `weaver registry live-check` validates the samples against the ACTUALLY-EMITTED registry
 *      (`genie/weaver-registry/`), with upstream OTel semconv resolved HERMETICALLY against the
 *      local Nix FOD — identical offline rewrite to `weaver:check` (SC-A03).
 *
 * Non-vacuous by construction: a POSITIVE case (only declared attributes → exit 0) AND a NEGATIVE
 * control (an undeclared attribute → nonzero) both run, so the assertion cannot pass trivially.
 *
 * Scope boundary: the registry governs SIGNAL attributes; the adapter emits only `{span:...}`
 * samples (never `{resource:...}`), so OTLP Resource attributes such as `service.name` /
 * `telemetry.sdk.*` — which the registry does not declare — are out of scope and are not checked.
 *
 * Hermetic wiring: the weaver binary + semconv-model path arrive via WEAVER_BIN /
 * WEAVER_SEMCONV_MODEL (mirroring how otelite tests take OTELITE_BIN); WEAVER_REGISTRY_DIR points
 * at the emitted registry. When they are absent (the ordinary `test` lane does not build the heavy
 * weaver flake) the suite SKIPS. The `weaver:live-check` devenv task supplies all three.
 *
 * Deps: this uses `node:*` builtins for file IO + spawning weaver (rather than `@effect/platform`,
 * which is not a direct dependency of `@overeng/otel-contract`); Effect is used only to drive the
 * otelite capture harness (whose platform deps are self-contained via `@overeng/utils-dev`).
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { captureTest } from '@overeng/utils-dev/otelite'

import { ProbeSpan } from './registry-demo.contract.ts'

const WEAVER_BIN = process.env.WEAVER_BIN
const WEAVER_SEMCONV_MODEL = process.env.WEAVER_SEMCONV_MODEL
const WEAVER_REGISTRY_DIR = process.env.WEAVER_REGISTRY_DIR
const enabled =
  WEAVER_BIN !== undefined &&
  WEAVER_SEMCONV_MODEL !== undefined &&
  WEAVER_REGISTRY_DIR !== undefined

// ---- OTLP AnyValue → JS value (weaver infers the sample attribute type from the JSON value) ----
// CRITICAL: OTLP encodes ints as a JSON *string* (`{"intValue":"2"}`); it MUST be coerced back to a
// number, or weaver sees a string where an int is declared and reports a (violation-level) type
// mismatch.
type OtlpAnyValue = {
  stringValue?: string
  intValue?: string | number
  doubleValue?: number
  boolValue?: boolean
  arrayValue?: { values?: ReadonlyArray<OtlpAnyValue> }
}

const anyValueToJs = (v: OtlpAnyValue | undefined): unknown => {
  if (v === undefined) return undefined
  if (v.stringValue !== undefined) return v.stringValue
  if (v.intValue !== undefined) return Number(v.intValue)
  if (v.doubleValue !== undefined) return v.doubleValue
  if (v.boolValue !== undefined) return v.boolValue
  if (v.arrayValue !== undefined) return (v.arrayValue.values ?? []).map(anyValueToJs)
  return undefined
}

// OTLP SpanKind enum → weaver sample kind string.
const SPAN_KIND = ['unspecified', 'internal', 'server', 'client', 'producer', 'consumer'] as const

type OtlpSpan = {
  name: string
  kind?: number
  attributes?: ReadonlyArray<{ key: string; value: OtlpAnyValue }>
}

/** Project captured OTLP NDJSON (one `ExportTraceServiceRequest` per line) into weaver samples. */
const otlpNdjsonToWeaverSamples = (ndjson: string): ReadonlyArray<unknown> => {
  const samples: Array<unknown> = []
  for (const line of ndjson.split('\n')) {
    if (line.trim() === '') continue
    const req = JSON.parse(line) as {
      resourceSpans?: ReadonlyArray<{
        scopeSpans?: ReadonlyArray<{ spans?: ReadonlyArray<OtlpSpan> }>
      }>
    }
    for (const rs of req.resourceSpans ?? []) {
      for (const ss of rs.scopeSpans ?? []) {
        for (const span of ss.spans ?? []) {
          samples.push({
            span: {
              name: span.name,
              kind: SPAN_KIND[span.kind ?? 0] ?? 'unspecified',
              attributes: (span.attributes ?? []).map((a) => ({
                name: a.key,
                value: anyValueToJs(a.value),
              })),
            },
          })
        }
      }
    }
  }
  return samples
}

/**
 * Emit one span carrying `attributes` through the otelite in-process OTLP exporter, capture it, and
 * return the captured OTLP NDJSON. Emitting directly through `handle.inProcessLayer` (no harness
 * root-span wrapper) keeps the captured span carrying EXACTLY the given attributes — no synthetic
 * `span.label`. The traces file is read INSIDE the capture scope, before otelite tears the minted
 * out-dir down.
 */
const captureNdjson = (attributes: Record<string, unknown>): Promise<string> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* captureTest({ serviceName: 'acme-live-check' })
        yield* Effect.void.pipe(
          Effect.withSpan('span.acme.probe', { kind: 'server', attributes }),
          Effect.provide(handle.inProcessLayer),
        )
        yield* handle.flush
        return yield* Effect.sync(() =>
          readFileSync(join(handle.capture.outDir, 'traces.ndjson'), 'utf8'),
        )
      }),
    ),
  )

/** Copy the emitted registry into a scratch dir and rewrite its upstream dep to the local FOD. */
const materializeHermeticRegistry = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'weaver-live-check-reg-'))
  for (const name of ['manifest.yaml', 'attributes.yaml', 'signals.yaml']) {
    const contents = readFileSync(join(WEAVER_REGISTRY_DIR!, name), 'utf8')
    const rewritten =
      name === 'manifest.yaml'
        ? contents.replace(/registry_path: .*/g, `registry_path: ${WEAVER_SEMCONV_MODEL}`)
        : contents
    writeFileSync(join(dir, name), rewritten)
  }
  return dir
}

/** Run `weaver registry live-check` on a sample file against the hermetic registry; yield exit code. */
const runLiveCheck = (registryDir: string, sampleFile: string): number => {
  const res = spawnSync(
    WEAVER_BIN!,
    [
      'registry',
      'live-check',
      '-r',
      registryDir,
      '--input-source',
      sampleFile,
      '--input-format',
      'json',
      '--future',
      '--output',
      'none',
      '--no-stream',
    ],
    { encoding: 'utf8' },
  )
  return res.status ?? 1
}

const sampleFileFor = async (attributes: Record<string, unknown>): Promise<string> => {
  const ndjson = await captureNdjson(attributes)
  const samples = otlpNdjsonToWeaverSamples(ndjson)
  expect(samples.length).toBeGreaterThan(0)
  const dir = mkdtempSync(join(tmpdir(), 'weaver-live-check-samples-'))
  const file = join(dir, 'samples.json')
  writeFileSync(file, JSON.stringify(samples))
  return file
}

const declaredAttributes = () =>
  ProbeSpan.encoder.encodeSync({
    probeName: 'liveness',
    region: 'us_east',
    attempt: 2,
    httpMethod: 'GET',
  }) as Record<string, unknown>

describe.skipIf(!enabled)(
  'SC-R12 weaver live-check (emitted OTLP conforms to the registry)',
  () => {
    it('conforming telemetry (only declared attributes) → exit 0', async () => {
      const registryDir = materializeHermeticRegistry()
      const sampleFile = await sampleFileFor(declaredAttributes())
      expect(runLiveCheck(registryDir, sampleFile)).toBe(0)
    })

    it('NEGATIVE control: an undeclared attribute → nonzero (gate has teeth)', async () => {
      const registryDir = materializeHermeticRegistry()
      // Inject an attribute the registry does NOT define → weaver `missing_attribute` (violation).
      const sampleFile = await sampleFileFor({
        ...declaredAttributes(),
        'acme.undeclared.attr': 'nope',
      })
      expect(runLiveCheck(registryDir, sampleFile)).not.toBe(0)
    })
  },
)
