import { createServer } from 'node:net'

import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import { freePort, freePorts, withFreePort } from './net.ts'

Vitest.describe('net port helpers', () => {
  Vitest.it('freePort returns a bindable port', async () => {
    const port = await freePort()
    expect(port).toBeGreaterThan(0)
    /* The port is bindable right now (the TOCTOU gap notwithstanding). */
    await new Promise<void>((resolve, reject) => {
      const srv = createServer()
      srv.on('error', reject)
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve()))
    })
  })

  Vitest.it('freePorts returns the requested count of DISTINCT ports', async () => {
    const ports = await freePorts(4)
    expect(ports).toHaveLength(4)
    expect(new Set(ports).size).toBe(4)
    for (const p of ports) expect(p).toBeGreaterThan(0)
  })

  Vitest.it('freePorts(0) returns an empty array', async () => {
    expect(await freePorts(0)).toEqual([])
  })

  Vitest.it('withFreePort retries on EADDRINUSE then succeeds', async () => {
    let attempts = 0
    const result = await withFreePort({
      fn: (port) => {
        attempts++
        if (attempts < 3) {
          const err = new Error('listen EADDRINUSE: address already in use') as Error & {
            code: string
          }
          err.code = 'EADDRINUSE'
          return Promise.reject(err)
        }
        return Promise.resolve(`bound:${port}`)
      },
    })
    expect(attempts).toBe(3)
    expect(result.startsWith('bound:')).toBe(true)
  })

  Vitest.it('withFreePort propagates a non-collision error immediately', async () => {
    let attempts = 0
    await expect(
      withFreePort({
        fn: () => {
          attempts++
          return Promise.reject(new Error('something else failed'))
        },
      }),
    ).rejects.toThrow('something else failed')
    expect(attempts).toBe(1)
  })

  Vitest.it('withFreePort gives up after exhausting retries', async () => {
    let attempts = 0
    await expect(
      withFreePort({
        fn: () => {
          attempts++
          const err = new Error('EADDRINUSE') as Error & { code: string }
          err.code = 'EADDRINUSE'
          return Promise.reject(err)
        },
        opts: { retries: 2 },
      }),
    ).rejects.toThrow('EADDRINUSE')
    /* retries: 2 → initial attempt + 2 retries = 3 total */
    expect(attempts).toBe(3)
  })
})
