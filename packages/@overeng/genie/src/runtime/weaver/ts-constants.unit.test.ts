import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { withTsVirtualProject } from '../node/ts-api.ts'
import type { Provenance, Registry } from './mod.ts'
import { renderRustConstants, renderTsConstants } from './mod.ts'
import { otelScrapeFixtureRegistry } from './otel-scrape.fixture.ts'

const registry = otelScrapeFixtureRegistry

const FIXTURE_PROVENANCE: Provenance = {
  source: 'packages/@overeng/genie/src/runtime/weaver/otel-scrape.fixture.ts',
  fingerprint: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
}

const typecheck = async (
  files: ReadonlyMap<string, string>,
  rootNames: ReadonlyArray<string>,
): Promise<void> => {
  const root = path.resolve('/genie-virtual/weaver')
  const normalizedFiles = new Map(
    [...files].map(([file, text]) => [path.resolve(root, file.replace(/^\/+/, '')), text]),
  )
  const normalizedRootNames = rootNames.map((file) => path.resolve(root, file.replace(/^\/+/, '')))

  await withTsVirtualProject({
    root,
    files: normalizedFiles,
    rootFiles: normalizedRootNames,
    compilerOptions: {
      allowImportingTsExtensions: true,
      module: 'nodenext',
      moduleResolution: 'nodenext',
      noEmit: true,
      strict: true,
      target: 'es2024',
    },
    use: async (project) => {
      expect(await project.diagnosticMessages()).toEqual([])
    },
  })
}

describe('renderTsConstants (otel-scrape fixture)', () => {
  const source = renderTsConstants({ registry, provenance: FIXTURE_PROVENANCE })

  it('carries actionable provenance from the shared Weaver banner', () => {
    expect(source.startsWith(`// registry-source: ${FIXTURE_PROVENANCE.source}\n`)).toBe(true)
    expect(source).toContain(`// fingerprint: ${FIXTURE_PROVENANCE.fingerprint}`)
    expect(source).toContain('// regen: devenv tasks run genie:run')
  })

  it('emits prefixed metric and span name constants', () => {
    expect(source).toContain(
      `export const METRIC_OtelScrapeScrapes = 'otel_scrape.scrapes' as const`,
    )
    expect(source).toContain(
      `export const METRIC_OtelScrapeScrapeDuration = 'otel_scrape.scrape.duration' as const`,
    )
    expect(source).toContain(`export const SPAN_OtelScrapeRequest = 'otel_scrape/request' as const`)
    expect(source).toContain(
      `export const SPAN_SpanOtelScrapeBatch = 'span.otel_scrape.batch' as const`,
    )
  })

  it('emits name unions for generated metric and span names', () => {
    expect(source).toContain('export type MetricName =')
    expect(source).toContain(`  | 'otel_scrape.scrapes'`)
    expect(source).toContain(`  | 'otel_scrape.scrape.duration'`)
    expect(source).toContain('export type SpanName =')
    expect(source).toContain(`  | 'otel_scrape/request'`)
    expect(source).toContain(`  | 'span.otel_scrape.batch'`)
  })

  it('keeps attribute key constants unprefixed', () => {
    expect(source).toContain(`export const Otel_scrapeStatus = 'otel_scrape.status' as const`)
    expect(source).not.toContain(`export const ATTRIBUTE_Otel_scrapeStatus`)
  })

  it('type-checks consumers importing generated METRIC_ and SPAN_ constants', async () => {
    const constantsFile = '/constants.ts'
    const consumerFile = '/consumer.ts'
    const consumer = [
      "import { METRIC_OtelScrapeScrapes, SPAN_OtelScrapeRequest } from './constants.ts'",
      "import type { MetricName, SpanName } from './constants.ts'",
      '',
      'const metricName: MetricName = METRIC_OtelScrapeScrapes',
      'const spanName: SpanName = SPAN_OtelScrapeRequest',
      'void metricName',
      'void spanName',
    ].join('\n')
    const files = new Map<string, string>([
      [constantsFile, source],
      [consumerFile, consumer],
    ])
    await typecheck(files, [consumerFile])
  })

  it('throws a clear error when folded metric identifiers collide', () => {
    const collidingRegistry: Registry = {
      ...registry,
      signals: [
        {
          kind: 'metric',
          id: 'metric.restate.attempts.total',
          metric_name: 'restate.attempts.total',
          instrument: 'counter',
          unit: '{attempt}',
          brief: 'Attempts.',
          stability: 'development',
          attributes: [],
        },
        {
          kind: 'metric',
          id: 'metric.restate_attempts_total',
          metric_name: 'restate_attempts_total',
          instrument: 'counter',
          unit: '{attempt}',
          brief: 'Attempts.',
          stability: 'development',
          attributes: [],
        },
      ],
    }

    expect(() =>
      renderTsConstants({ registry: collidingRegistry, provenance: FIXTURE_PROVENANCE }),
    ).toThrow(/weaver TS constants: identifier collision "METRIC_RestateAttemptsTotal"/)
    expect(() =>
      renderRustConstants({ registry: collidingRegistry, provenance: FIXTURE_PROVENANCE }),
    ).toThrow(/weaver Rust constants metric: identifier collision "RESTATE_ATTEMPTS_TOTAL"/)
  })

  it('throws when an attribute-key constant collides with a prefixed span-name constant', () => {
    const crossKindRegistry: Registry = {
      ...registry,
      groups: [
        {
          namespace: 'review',
          displayName: 'Review',
          attributes: [
            {
              id: 'SPAN_Foo',
              type: 'string',
              brief: 'A deliberately colliding attribute key.',
              stability: 'development',
            },
          ],
        },
      ],
      signals: [
        {
          kind: 'span',
          id: 'span.review.foo',
          span_name: 'foo',
          span_kind: 'internal',
          brief: 'A deliberately colliding span name.',
          stability: 'development',
          attributes: [],
        },
      ],
    }

    expect(() =>
      renderTsConstants({ registry: crossKindRegistry, provenance: FIXTURE_PROVENANCE }),
    ).toThrow(
      'weaver TS constants: identifier collision "SPAN_Foo" for attribute key "SPAN_Foo" and span name "foo"',
    )
  })

  it('renders empty span-name unions as never for metrics-only registries', async () => {
    const metricsOnlyRegistry: Registry = {
      ...registry,
      signals: [
        {
          kind: 'metric',
          id: 'metric.otel_scrape.scrapes',
          metric_name: 'otel_scrape.scrapes',
          instrument: 'counter',
          unit: '{scrape}',
          brief: 'Scrapes.',
          stability: 'development',
          attributes: [],
        },
      ],
    }
    const constants = renderTsConstants({
      registry: metricsOnlyRegistry,
      provenance: FIXTURE_PROVENANCE,
    })
    expect(constants).toContain('export type SpanName = never')
    expect(constants).toContain(`export const METRIC_OtelScrapeScrapes = 'otel_scrape.scrapes'`)
    await typecheck(new Map([['/constants.ts', constants]]), ['/constants.ts'])
  })
})
