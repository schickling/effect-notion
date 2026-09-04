import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import { sha1Hex, sha256Hex } from './hash.ts'

Vitest.describe('hash helpers', () => {
  Vitest.it('computes stable SHA-1 and SHA-256 hex digests for string input', () => {
    expect(sha1Hex('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d')
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  Vitest.it('computes the same SHA-256 hex digest for equivalent byte input', () => {
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(sha256Hex('abc'))
  })
})
