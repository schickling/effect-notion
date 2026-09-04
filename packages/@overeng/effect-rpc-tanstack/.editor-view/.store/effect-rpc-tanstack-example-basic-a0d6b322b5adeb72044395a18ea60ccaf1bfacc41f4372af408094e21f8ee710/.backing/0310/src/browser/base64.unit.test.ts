import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import { decode, decodeToString, encode } from './base64.ts'

Vitest.describe('base64', () => {
  Vitest.it('encodes strings and bytes identically (jsdoc contract)', () => {
    expect(encode('Hello')).toBe('SGVsbG8=')
    expect(encode(new Uint8Array([72, 101, 108, 108, 111]))).toBe('SGVsbG8=')
  })

  Vitest.it('pads to a multiple of 4 for 1- and 2-byte remainders', () => {
    expect(encode('a')).toBe('YQ==')
    expect(encode('ab')).toBe('YWI=')
    expect(encode('')).toBe('')
  })

  Vitest.it('encodes multi-byte UTF-8 as UTF-8 bytes', () => {
    expect(encode('héllo ✓')).toBe('aMOpbGxvIOKckw==')
  })

  Vitest.it('decodes to bytes and back to the original string', () => {
    expect(Array.from(decode('SGVsbG8='))).toEqual([72, 101, 108, 108, 111])
    expect(decodeToString('aMOpbGxvIOKckw==')).toBe('héllo ✓')
  })

  Vitest.it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array(256)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i
    expect(Array.from(decode(encode(bytes)))).toEqual(Array.from(bytes))
  })

  Vitest.it('tolerates CRLF inside encoded input (RFC 2045 line wrapping)', () => {
    expect(decodeToString('SGVsbG8=\r\n')).toBe('Hello')
  })

  Vitest.it('throws on invalid base64', () => {
    expect(() => decode('not*base64!')).toThrow()
    expect(() => decode('SGVsbG8')).toThrow() // unpadded
    expect(() => decode('SGV=sbG8=')).toThrow() // '=' in the middle
  })
})
