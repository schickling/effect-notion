import type * as otel from '@opentelemetry/api'
import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import { getTraceParentHeader } from './misc.ts'

/** Mock OTEL span for testing */
const createMockSpan = (traceId: string, spanId: string, traceFlags = 1): otel.Span => {
  return {
    spanContext: () => ({
      traceId,
      spanId,
      traceFlags,
      traceState: undefined,
    }),
  } as unknown as otel.Span
}

Vitest.describe('misc', () => {
  Vitest.describe('getTraceParentHeader', () => {
    Vitest.it('generates valid W3C traceparent header', () => {
      const span = createMockSpan('0af7651916cd43dd8448eb211c80319c', 'b7ad6b7169203331')

      const header = getTraceParentHeader(span)

      expect(header).toBe('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01')
    })

    Vitest.it('includes version 00', () => {
      const span = createMockSpan('0af7651916cd43dd8448eb211c80319c', 'b7ad6b7169203331')

      const header = getTraceParentHeader(span)

      expect(header.startsWith('00-')).toBe(true)
    })

    Vitest.it('includes trace flags as 01 (sampled)', () => {
      const span = createMockSpan('0af7651916cd43dd8448eb211c80319c', 'b7ad6b7169203331')

      const header = getTraceParentHeader(span)

      expect(header.endsWith('-01')).toBe(true)
    })

    Vitest.it('preserves full 32-character trace ID', () => {
      const traceId = '0af7651916cd43dd8448eb211c80319c'
      const span = createMockSpan(traceId, 'b7ad6b7169203331')

      const header = getTraceParentHeader(span)

      expect(header).toContain(traceId)
      const parts = header.split('-')
      expect(parts[1]).toBe(traceId)
      expect(parts[1]?.length).toBe(32)
    })

    Vitest.it('preserves full 16-character span ID', () => {
      const spanId = 'b7ad6b7169203331'
      const span = createMockSpan('0af7651916cd43dd8448eb211c80319c', spanId)

      const header = getTraceParentHeader(span)

      expect(header).toContain(spanId)
      const parts = header.split('-')
      expect(parts[2]).toBe(spanId)
      expect(parts[2]?.length).toBe(16)
    })

    Vitest.it('works with different trace IDs', () => {
      const span1 = createMockSpan('1234567890abcdef1234567890abcdef', 'fedcba0987654321')
      const span2 = createMockSpan('abcdefabcdefabcdefabcdefabcdefab', '1234123412341234')

      const header1 = getTraceParentHeader(span1)
      const header2 = getTraceParentHeader(span2)

      expect(header1).toBe('00-1234567890abcdef1234567890abcdef-fedcba0987654321-01')
      expect(header2).toBe('00-abcdefabcdefabcdefabcdefabcdefab-1234123412341234-01')
    })

    Vitest.it('generates header with correct format (4 parts)', () => {
      const span = createMockSpan('0af7651916cd43dd8448eb211c80319c', 'b7ad6b7169203331')

      const header = getTraceParentHeader(span)

      const parts = header.split('-')
      expect(parts.length).toBe(4)
      expect(parts[0]).toBe('00') // version
      expect(parts[1]?.length).toBe(32) // trace-id
      expect(parts[2]?.length).toBe(16) // span-id
      expect(parts[3]).toBe('01') // trace-flags
    })

    Vitest.it('can be used for cross-process trace propagation', () => {
      // This is the use case: parent process generates header, child process parses it
      const parentSpan = createMockSpan('0af7651916cd43dd8448eb211c80319c', 'b7ad6b7169203331')

      const header = getTraceParentHeader(parentSpan)

      // Child process would set this as TRACEPARENT env var
      // And parse it back using parseTraceparent (tested in otel.unit.test.ts)
      expect(header).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
    })

    Vitest.it('handles spans with numeric trace IDs', () => {
      const span = createMockSpan('00000000000000000000000000000001', '0000000000000001')

      const header = getTraceParentHeader(span)

      expect(header).toBe('00-00000000000000000000000000000001-0000000000000001-01')
    })

    Vitest.it('handles spans with all-uppercase hex IDs', () => {
      const span = createMockSpan('ABCDEFABCDEFABCDEFABCDEFABCDEFAB', 'FEDCBA0987654321')

      const header = getTraceParentHeader(span)

      expect(header).toBe('00-ABCDEFABCDEFABCDEFABCDEFABCDEFAB-FEDCBA0987654321-01')
    })
  })
})
