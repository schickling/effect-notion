import { describe, expect, it } from 'vitest'

import { isRunCreatedForDispatch } from '../src/node/commands/rerun.ts'

describe('isRunCreatedForDispatch', () => {
  const dispatchedAt = new Date('2026-09-12T12:34:56.789Z')

  it('accepts GitHub timestamps rounded down within the dispatch second', () => {
    expect(
      isRunCreatedForDispatch({
        runCreatedAt: new Date('2026-09-12T12:34:56.000Z'),
        dispatchedAt,
      }),
    ).toBe(true)
  })

  it('rejects a run created in an earlier second', () => {
    expect(
      isRunCreatedForDispatch({
        runCreatedAt: new Date('2026-09-12T12:34:55.000Z'),
        dispatchedAt,
      }),
    ).toBe(false)
  })
})
