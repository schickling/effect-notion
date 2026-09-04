import { describe, expect, it } from '@effect/vitest'
import { Schema } from 'effect'

import type { SpanRow } from './schema.ts'
import { attr, expectTrace, spanLabel, TraceExpectError } from './trace-expect.ts'

const span = (overrides: Partial<SpanRow>): SpanRow => ({
  schema: 'otelite.span/v1',
  service: 'op-proxy',
  name: 'rpc.op.submit',
  trace_id: 'trace-1',
  span_id: 'span-1',
  parent_span_id: null,
  start_unix_nano: '1',
  end_unix_nano: '2',
  duration_ms: 1,
  status_code: 0,
  attrs: {
    'span.label': 'read',
    'op.cache_hit': 'false',
    'retry.count': '2',
    'request.source': 'rpc',
  },
  ...overrides,
})

describe('trace-expect', () => {
  it('finds spans by name, service, and exact normalized attrs', () => {
    const traces = expectTrace([
      span({ span_id: 'span-1' }),
      span({ name: 'rpc.op.write', span_id: 'span-2', attrs: { 'op.cache_hit': 'true' } }),
    ])

    expect(traces.findByName('rpc.op.submit')).toHaveLength(1)
    expect(
      traces.service('op-proxy').expectOne({
        name: 'rpc.op.submit',
        attrs: {
          'op.cache_hit': false,
          'retry.count': 2,
        },
      }).span_id,
    ).toBe('span-1')
  })

  it('supports regex, predicate, schema, and span.label helpers', () => {
    const traces = expectTrace([
      span({ attrs: { ...span({}).attrs, 'request.payload': '{"kind":"rpc"}' } }),
    ])

    const match = traces.expectOne({
      attrs: {
        ...spanLabel(/^re/),
        'request.source': attr.schema(Schema.Literal('rpc')),
        'retry.count': attr.int(2),
        'op.cache_hit': attr.boolean(false),
        'request.payload': attr.json(Schema.Struct({ kind: Schema.Literal('rpc') })),
      },
      requireLabel: true,
    })

    expect(match.name).toBe('rpc.op.submit')
    expect(traces.expectSpanLabels()).toHaveLength(1)
  })

  it('checks same-trace expectations', () => {
    const traces = expectTrace([
      span({ name: 'rpc.op.submit', span_id: 'span-1', trace_id: 'trace-1' }),
      span({ name: 'file-cache.read', span_id: 'span-2', trace_id: 'trace-1' }),
    ])

    expect(traces.expectSameTrace([{ name: 'rpc.op.submit' }, { name: 'file-cache.read' }])).toBe(
      'trace-1',
    )
    expect(traces.sameTrace({ service: 'op-proxy' })).toBe('trace-1')
  })

  it('matches compiled OTEL attribute and span contracts structurally', () => {
    const attributes = {
      unsafeEncode: (value: { readonly label: string; readonly count: number }) => ({
        'span.label': value.label,
        'retry.count': value.count,
      }),
    }
    const contract = {
      name: 'rpc.op.submit',
      attributes,
    }
    const traces = expectTrace([span({})])

    expect(
      traces.expectAttributes({
        attributes,
        match: { label: 'read', count: 2 },
      }),
    ).toHaveLength(1)
    expect(
      traces.expectSpan({
        span: contract,
        match: { label: 'read', count: 2 },
      }).span_id,
    ).toBe('span-1')
  })

  it('throws a runner-agnostic error when expectations fail', () => {
    const traces = expectTrace([
      span({ span_id: 'span-1' }),
      span({ span_id: 'span-2', attrs: { 'span.label': 'read' } }),
    ])

    expect(() => traces.expectOne({ name: 'rpc.op.submit' })).toThrow(TraceExpectError)
    expect(() => traces.expectSome({ attrs: { missing: attr.present() } })).toThrow(
      /Expected at least one span/,
    )
    expect(() => traces.expectOne({ requireLabel: true })).toThrow(/found 2/)
    expect(() =>
      expectTrace([span({ attrs: { 'request.source': 'rpc' } })]).expectSpanLabels(),
    ).toThrow(/span.label/)
  })
})
