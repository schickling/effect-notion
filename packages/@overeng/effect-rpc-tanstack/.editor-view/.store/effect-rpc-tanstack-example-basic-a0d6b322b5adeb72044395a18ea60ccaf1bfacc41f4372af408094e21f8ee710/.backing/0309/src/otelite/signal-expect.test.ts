import { describe, expect, it } from '@effect/vitest'
import { Schema } from 'effect'

import type { LogRow, MetricRow } from './schema.ts'
import {
  expectLogs,
  expectMetrics,
  metricValue,
  telemetryAttr,
  TelemetryExpectError,
} from './signal-expect.ts'

const metric = (overrides: Partial<MetricRow>): MetricRow => ({
  schema: 'otelite.metric/v1',
  service: 'restate-effect',
  name: 'restate.invocations',
  type: 'sum',
  unit: '1',
  value: 3,
  time_unix_nano: '2',
  start_time_unix_nano: '1',
  temporality: 'cumulative',
  monotonic: true,
  attrs: {
    handler: 'create',
    outcome: 'success',
    replay: 'false',
  },
  ...overrides,
})

const log = (overrides: Partial<LogRow>): LogRow => ({
  schema: 'otelite.log/v1',
  service: 'notion-md',
  scope: 'effect',
  body: 'page pulled',
  severity_number: 9,
  severity_text: 'INFO',
  trace_id: 'trace-1',
  span_id: 'span-1',
  time_unix_nano: '3',
  attrs: {
    page_id: 'page-1',
    cached: 'true',
  },
  ...overrides,
})

describe('signal-expect', () => {
  it('finds metrics by name, service, type, unit, value, and attrs', () => {
    const metrics = expectMetrics([
      metric({}),
      metric({
        name: 'restate.invocation.duration',
        type: 'histogram',
        unit: 'ms',
        value: undefined,
        attrs: { handler: 'create' },
      }),
    ])

    expect(metrics.metric('restate.invocations').expectOne({ value: 3 }).name).toBe(
      'restate.invocations',
    )
    expect(
      metrics.service('restate-effect').expectOne({
        type: 'sum',
        unit: '1',
        attrs: {
          outcome: 'success',
          replay: telemetryAttr.boolean(false),
        },
      }).value,
    ).toBe(3)
  })

  it('supports metric value predicates and schema-backed attr matchers', () => {
    const metrics = expectMetrics([
      metric({ attrs: { outcome: 'success', payload: '{"ok":true}' } }),
    ])

    const row = metrics.expectOne({
      value: metricValue.predicate('greater than two', (actual) => actual > 2),
      attrs: {
        outcome: telemetryAttr.schema(Schema.Literal('success')),
        payload: telemetryAttr.json(Schema.Struct({ ok: Schema.Boolean })),
      },
    })

    expect(row.name).toBe('restate.invocations')
  })

  it('matches structural metric-label contracts without requiring OtelMetric', () => {
    const labels = {
      unsafeEncode: (value: { readonly handler: string; readonly outcome: string }) => ({
        handler: value.handler,
        outcome: value.outcome,
      }),
    }
    const contract = {
      name: 'restate.invocations',
      unit: '1',
      type: 'sum',
      labels,
    }

    const row = expectMetrics([metric({})]).expectMetric({
      metric: contract,
      match: { handler: 'create', outcome: 'success' },
      selector: { value: metricValue.present() },
    })

    expect(row.service).toBe('restate-effect')
  })

  it('finds logs by body, severity, trace linkage, and attrs', () => {
    const logs = expectLogs([
      log({}),
      log({
        body: 'page failed',
        severity_text: 'ERROR',
        severity_number: 17,
        span_id: 'span-2',
        attrs: { page_id: 'page-2', cached: 'false' },
      }),
    ])

    expect(
      logs
        .service('notion-md')
        .severity('INFO')
        .expectOne({ body: /pulled/ }).span_id,
    ).toBe('span-1')
    expect(
      logs.expectOne({
        traceId: 'trace-1',
        spanId: 'span-1',
        attrs: {
          cached: telemetryAttr.boolean(true),
          page_id: telemetryAttr.present(),
        },
      }).body,
    ).toBe('page pulled')
  })

  it('throws runner-agnostic errors when signal expectations fail', () => {
    const metrics = expectMetrics([metric({}), metric({ value: 5 })])
    const logs = expectLogs([log({})])

    expect(() => metrics.expectOne({ name: 'restate.invocations' })).toThrow(TelemetryExpectError)
    expect(() => metrics.expectSome({ attrs: { missing: telemetryAttr.present() } })).toThrow(
      /Expected at least one metric/,
    )
    expect(() => logs.expectOne({ severityText: 'ERROR' })).toThrow(/Expected exactly one log/)
  })
})
