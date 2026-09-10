import { describe, expect, it } from 'vitest'

import { formatDuration, abbreviateRunner } from '../src/isomorphic/lib/format.ts'

describe('formatDuration', () => {
  it('formats seconds', () => expect(formatDuration(45)).toBe('45s'))
  it('formats minutes', () => expect(formatDuration(125)).toBe('2m 05s'))
  it('formats hours', () => expect(formatDuration(7877)).toBe('2h 11m'))
  it('handles zero', () => expect(formatDuration(0)).toBe('0s'))
  it('handles exactly 1 hour', () => expect(formatDuration(3600)).toBe('1h 00m'))
})

describe('abbreviateRunner', () => {
  it('abbreviates nsc runners', () =>
    expect(abbreviateRunner('nsc-runner-psmnb4mkjm3mq')).toBe('nsc:psmnb4'))
  it('abbreviates self-hosted runner-scaler names', () => {
    expect(abbreviateRunner('dev3-6038ddf9')).toBe('dev3')
    expect(abbreviateRunner('mbp2021-e2387a32')).toBe('mbp2021')
  })
  it('passes through non-matching names', () =>
    expect(abbreviateRunner('some-other-runner')).toBe('some-other-runner'))
  it('handles null', () => expect(abbreviateRunner(null)).toBe('—'))
})
