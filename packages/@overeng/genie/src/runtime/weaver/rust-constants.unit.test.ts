import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import type { AttrDef, Provenance, Registry, SignalDef } from './mod.ts'
import { renderAttributes, renderRustConstants, renderSignals } from './mod.ts'
import { otelScrapeFixtureRegistry } from './otel-scrape.fixture.ts'

// The synthetic otel-scrape registry is authored directly as dep-free Layer-1 data
// (`renderRustConstants` renders it below — the true name-projection path).
const registry = otelScrapeFixtureRegistry

const FIXTURE_PROVENANCE: Provenance = {
  source: 'packages/@overeng/genie/src/runtime/weaver/otel-scrape.fixture.ts',
  fingerprint: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
}

// The ~25 names decision 0007 expects the Rust bindings to cover.
const EXPECTED_ATTRIBUTE_KEYS = [
  'otel_scrape.batch.size',
  'otel_scrape.compressed',
  'otel_scrape.duration_ms',
  'otel_scrape.endpoint',
  'otel_scrape.error.type',
  'otel_scrape.payload.size_bytes',
  'otel_scrape.profile.cpu_samples',
  'otel_scrape.profile.heap_bytes',
  'otel_scrape.profile.name',
  'otel_scrape.protocol',
  'otel_scrape.request.header',
  'otel_scrape.result.cached',
  'otel_scrape.retry.count',
  'otel_scrape.schema.tag',
  'otel_scrape.schema.version',
  'otel_scrape.status',
  'otel_scrape.target.name',
  'otel_scrape.target.port',
  'otel_scrape.target.url',
  'otel_scrape.tls.enabled',
] as const
// The `request` span carries a `span_name` (operation projection) so its const emits the RUNTIME
// name; `batch` has none so it falls back to its id. Both paths are covered here.
const EXPECTED_SPAN_IDS = ['otel_scrape/request', 'span.otel_scrape.batch'] as const
const EXPECTED_METRIC_NAMES = [
  'otel_scrape.payload.bytes',
  'otel_scrape.scrape.duration',
  'otel_scrape.scrapes',
] as const
const ALL_EXPECTED_NAMES = [
  ...EXPECTED_ATTRIBUTE_KEYS,
  ...EXPECTED_SPAN_IDS,
  ...EXPECTED_METRIC_NAMES,
]

describe('renderSignals signal deprecation', () => {
  it('keeps lifecycle dates in annotations and out of normative deprecated YAML', () => {
    const signal: SignalDef = {
      kind: 'metric',
      id: 'metric.otel_scrape.old',
      metric_name: 'otel_scrape.old',
      instrument: 'counter',
      unit: '1',
      brief: 'Old scrape metric.',
      stability: 'development',
      deprecated: {
        reason: 'renamed',
        renamed_to: 'otel_scrape.new',
        since: '2026-07-10',
        remove_after: '2026-10-10',
      },
      attributes: [],
    }

    const yaml = renderSignals({ signals: [signal], provenance: FIXTURE_PROVENANCE })
    const deprecatedStart = yaml.indexOf('  deprecated:')
    const annotationsStart = yaml.indexOf('  annotations:')

    expect(yaml).toContain('# regen: devenv tasks run genie:run')
    expect(deprecatedStart).toBeGreaterThan(-1)
    expect(annotationsStart).toBeGreaterThan(deprecatedStart)
    expect(yaml.match(/\bsince:/g)).toHaveLength(1)
    expect(yaml.match(/\bremove_after:/g)).toHaveLength(1)
    expect(yaml.slice(deprecatedStart, annotationsStart).trimEnd()).toBe(
      '  deprecated:\n      reason: renamed\n      renamed_to: otel_scrape.new',
    )
    expect(yaml.slice(annotationsStart)).toContain('overeng_policy:')
    expect(yaml.slice(annotationsStart)).toContain('deprecated:')
    expect(yaml.slice(annotationsStart)).toContain('since: 2026-07-10')
    expect(yaml.slice(annotationsStart)).toContain('remove_after: 2026-10-10')
  })
})

describe('renderAttributes attribute deprecation', () => {
  it('keeps lifecycle dates in namespaced annotations and out of normative deprecated YAML', () => {
    const attribute: AttrDef = {
      id: 'otel_scrape.old_attribute',
      type: 'string',
      brief: 'Old scrape attribute.',
      stability: 'development',
      deprecated: {
        reason: 'renamed',
        renamed_to: 'otel_scrape.new_attribute',
        since: '2026-07-10',
        remove_after: '2026-10-10',
      },
    }
    const registry: Registry = {
      name: 'otel-scrape-test',
      description: 'Test registry.',
      schemaUrl: 'https://example.invalid/schema',
      dependencies: [],
      groups: [
        {
          namespace: 'otel_scrape',
          displayName: 'OTel Scrape',
          attributes: [attribute],
        },
      ],
      signals: [],
    }

    const yaml = renderAttributes({ registry, provenance: FIXTURE_PROVENANCE })
    const deprecatedStart = yaml.indexOf('      deprecated:')
    const annotationsStart = yaml.indexOf('      annotations:')

    expect(deprecatedStart).toBeGreaterThan(-1)
    expect(annotationsStart).toBeGreaterThan(deprecatedStart)
    expect(yaml.match(/\bsince:/g)).toHaveLength(1)
    expect(yaml.match(/\bremove_after:/g)).toHaveLength(1)
    expect(yaml.slice(deprecatedStart, annotationsStart).trimEnd()).toBe(
      '      deprecated:\n          reason: renamed\n          renamed_to: otel_scrape.new_attribute',
    )
    expect(yaml.slice(annotationsStart)).toContain('overeng_policy:')
    expect(yaml.slice(annotationsStart)).toContain('deprecated:')
    expect(yaml.slice(annotationsStart)).toContain('since: 2026-07-10')
    expect(yaml.slice(annotationsStart)).toContain('remove_after: 2026-10-10')
  })
})

/** Reads one Buck-declared immutable tool path; nothing resolves through an ambient PATH. */
const requireTool = (name: string): string => {
  const tool = process.env[name]
  if (tool === undefined || tool === '')
    throw new Error(`declared test tool is unavailable: ${name}`)
  return tool
}

describe('renderRustConstants (otel-scrape fixture)', () => {
  const rust = renderRustConstants({ registry, provenance: FIXTURE_PROVENANCE })

  it('is deterministic (render twice = byte-identical)', () => {
    const again = renderRustConstants({ registry, provenance: FIXTURE_PROVENANCE })
    expect(again).toBe(rust)
  })

  it('covers all ~25 otel-scrape names as Rust string-literal constants', () => {
    // Every expected name appears as a `= "<name>";` const value.
    for (const name of ALL_EXPECTED_NAMES) {
      expect(rust).toContain(`= ${JSON.stringify(name)};`)
    }
    expect(ALL_EXPECTED_NAMES.length).toBe(25)

    // Each kind is projected into its own module (collision-proof by construction).
    expect(rust).toContain('pub mod attribute {')
    expect(rust).toContain('pub mod span {')
    expect(rust).toContain('pub mod metric {')

    // Const count per kind matches the fixture exactly.
    const constCount = (moduleName: string): number => {
      const start = rust.indexOf(`pub mod ${moduleName} {`)
      const end = rust.indexOf('\n}', start)
      const body = rust.slice(start, end)
      return [...body.matchAll(/pub const [A-Z0-9_]+: &str =/g)].length
    }
    expect(constCount('attribute')).toBe(EXPECTED_ATTRIBUTE_KEYS.length)
    expect(constCount('span')).toBe(EXPECTED_SPAN_IDS.length)
    expect(constCount('metric')).toBe(EXPECTED_METRIC_NAMES.length)
  })

  it('emits the runtime span name for operation-projected spans, not the weaver group id', () => {
    // `request` carries `span_name: 'otel_scrape/request'` — the const must read the runtime name…
    expect(rust).toContain('= "otel_scrape/request";')
    // …and NOT the weaver group id it projects from.
    expect(rust).not.toContain('span.otel_scrape.request')
  })

  it('carries the actionable provenance header from the shared Weaver banner', () => {
    expect(rust.startsWith(`// registry-source: ${FIXTURE_PROVENANCE.source}\n`)).toBe(true)
    expect(rust).toContain(`// fingerprint: ${FIXTURE_PROVENANCE.fingerprint}`)
    expect(rust).toContain('// regen: devenv tasks run genie:run')
  })

  const rustfmt = requireTool('RUSTFMT_BIN')
  it('is rustfmt-clean', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'weaver-rust-'))
    const file = path.join(dir, 'constants.rs')
    writeFileSync(file, rust)
    const res = spawnSync(rustfmt, ['--check', file], { encoding: 'utf8' })
    expect(res.stderr + res.stdout).toBe('')
    expect(res.status).toBe(0)
  })

  const rustc = requireTool('RUSTC_BIN')
  it('compiles as valid Rust (rustc --emit=metadata)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'weaver-rust-'))
    const file = path.join(dir, 'constants.rs')
    writeFileSync(file, rust)
    const res = spawnSync(
      rustc,
      ['--emit=metadata', '--crate-type', 'lib', file, '-o', path.join(dir, 'out.rmeta')],
      { encoding: 'utf8' },
    )
    expect(res.stderr).toBe('')
    expect(res.status).toBe(0)
  })
})
