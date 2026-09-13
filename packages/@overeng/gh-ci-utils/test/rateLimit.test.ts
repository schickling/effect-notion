import { describe, expect, it } from 'vitest'

import { parseRateLimitHeaders } from '../src/isomorphic/lib/rateLimit.ts'

describe('parseRateLimitHeaders', () => {
  it('parses valid headers', () => {
    const result = parseRateLimitHeaders({
      'x-ratelimit-remaining': '4500',
      'x-ratelimit-limit': '5000',
      'x-ratelimit-reset': '1774540000',
    })
    expect(result).toEqual({
      remaining: 4500,
      limit: 5000,
      reset: new Date(1774540000 * 1000),
    })
  })

  it('returns undefined for missing headers', () => {
    expect(parseRateLimitHeaders({})).toBeUndefined()
  })

  it('returns undefined for partial headers', () => {
    expect(parseRateLimitHeaders({ 'x-ratelimit-remaining': '100' })).toBeUndefined()
  })

  it('returns undefined when any header is malformed, treating the sample as absent', () => {
    expect(
      parseRateLimitHeaders({
        'x-ratelimit-remaining': 'soon',
        'x-ratelimit-limit': '5000',
        'x-ratelimit-reset': '1774540000',
      }),
    ).toBeUndefined()
  })
})
