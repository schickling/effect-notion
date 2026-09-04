import { Schema } from 'effect'
import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import { formatReasonMessage, nonEmptyTrimmedString, titleSlug } from './string.ts'

Vitest.describe('formatReasonMessage', () => {
  /* The cause segment is space-separated like the other parts, so it reads
   * `... (method) : message` — preserving the pre-existing `RestateError` /
   * `PtyError` `get message()` output exactly (SSOT consolidation, no behavior
   * change). */
  Vitest.it('joins reason + (method) + Error cause message', () => {
    expect(
      formatReasonMessage({
        reason: 'IngressFailed',
        method: 'call',
        cause: new Error('connection refused'),
      }),
    ).toBe('IngressFailed (call) : connection refused')
  })

  Vitest.it('includes an optional [label] between reason and (method)', () => {
    expect(formatReasonMessage({ reason: 'WriteFailed', label: 'sess-1', method: 'press' })).toBe(
      'WriteFailed [sess-1] (press)',
    )
  })

  Vitest.it('stringifies a non-Error cause', () => {
    expect(formatReasonMessage({ reason: 'RunFailed', method: 'step', cause: 'boom' })).toBe(
      'RunFailed (step) : boom',
    )
  })

  /* Effect 4 defect shapes can reach `cause` without a primitive conversion
   * path (null-prototype objects); `String()` throws on them, which used to
   * crash every consumer's `get message()` (CI: "Cannot convert object to
   * primitive value"). Formatting must never be the failure. */
  Vitest.it('renders a null-prototype cause via its message instead of throwing', () => {
    const nullProtoCause = Object.assign(Object.create(null), { message: 'null-proto boom' })
    expect(
      formatReasonMessage({ reason: 'RunFailed', method: 'run(step)', cause: nullProtoCause }),
    ).toBe('RunFailed (run(step)) : null-proto boom')
  })

  Vitest.it('falls back to JSON for a null-prototype cause without a message', () => {
    const nullProtoCause = Object.assign(Object.create(null), { code: 42 })
    expect(
      formatReasonMessage({ reason: 'SerdeFailed', method: 'State.get', cause: nullProtoCause }),
    ).toBe('SerdeFailed (State.get) : {"code":42}')
  })

  Vitest.it('survives a cause whose toString throws', () => {
    const hostile = Object.create(Object.prototype, {
      toString: {
        value: () => {
          throw new Error('nope')
        },
      },
    })
    expect(formatReasonMessage({ reason: 'EndpointFailed', cause: hostile })).toBe(
      'EndpointFailed : {}',
    )
  })

  Vitest.it('omits absent parts (reason only)', () => {
    expect(formatReasonMessage({ reason: 'Closed' })).toBe('Closed')
  })

  Vitest.it('omits the cause segment when cause is undefined', () => {
    expect(formatReasonMessage({ reason: 'Timeout', method: 'waitFor' })).toBe('Timeout (waitFor)')
  })
})

Vitest.describe('titleSlug', () => {
  Vitest.it('transliterates German titles before general Unicode normalization', () => {
    expect(titleSlug('Werk und künstlerische Themen')).toBe('werk-und-kuenstlerische-themen')
    expect(titleSlug('Quellen und offene Prüfpunkte')).toBe('quellen-und-offene-pruefpunkte')
    expect(titleSlug('ÄÖÜ äöü Straße ẞ')).toBe('aeoeue-aeoeue-strasse-ss')
    expect(titleSlug('Crème brûlée')).toBe('creme-brulee')
  })
})

Vitest.describe('nonEmptyTrimmedString', () => {
  Vitest.it('accepts a non-empty trimmed string', () => {
    expect(Schema.is(nonEmptyTrimmedString)('session-1')).toBe(true)
  })

  Vitest.it('rejects empty and whitespace-only strings', () => {
    expect(Schema.is(nonEmptyTrimmedString)('')).toBe(false)
    expect(Schema.is(nonEmptyTrimmedString)(' ')).toBe(false)
    expect(Schema.is(nonEmptyTrimmedString)('\t\n')).toBe(false)
  })

  Vitest.it('rejects strings with leading or trailing whitespace', () => {
    expect(Schema.is(nonEmptyTrimmedString)(' x')).toBe(false)
    expect(Schema.is(nonEmptyTrimmedString)('x ')).toBe(false)
    expect(Schema.is(nonEmptyTrimmedString)('a b')).toBe(true)
  })

  Vitest.it('rejects non-strings', () => {
    expect(Schema.is(nonEmptyTrimmedString)(123)).toBe(false)
  })
})
