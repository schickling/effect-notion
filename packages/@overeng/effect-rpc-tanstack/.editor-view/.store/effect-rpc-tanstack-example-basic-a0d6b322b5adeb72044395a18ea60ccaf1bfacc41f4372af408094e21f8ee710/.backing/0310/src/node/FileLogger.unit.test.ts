import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { Effect } from 'effect'
import { afterEach, beforeEach, expect, vi } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import { makeFileLogger } from './FileLogger.ts'

/* Timestamps render via local-time getters; pin the zone so the pinned bytes
 * below are deterministic on every machine. */
const realTz = process.env['TZ']

beforeEach(() => {
  process.env['TZ'] = 'UTC'
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-01-02T03:04:05.678Z'))
})

afterEach(() => {
  vi.useRealTimers()
  if (realTz === undefined) delete process.env['TZ']
  else process.env['TZ'] = realTz
})

Vitest.describe('makeFileLogger', () => {
  Vitest.it('writes pretty-formatted entries with byte-exact output', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-logger-'))
    // nested path: parent-directory creation must keep working
    const logFilePath = path.join(dir, 'nested', 'app.log')

    const program = Effect.gen(function* () {
      const fiberId = yield* Effect.fiberId
      yield* Effect.log('Hello from file logger')
      yield* Effect.logWarning('Watch out', { userId: 123 })
      return fiberId
    }).pipe(Effect.provide(makeFileLogger({ logFilePath, threadName: 'main' })))

    const fiberId = await Effect.runPromise(program)

    const written = fs.readFileSync(logFilePath, 'utf8')
    expect(written).toBe(
      `[03:04:05.678 main] Info (#${fiberId}): Hello from file logger\n` +
        `[03:04:05.678 main] Warn (#${fiberId}): Watch out\n` +
        `  {\n    userId: 123\n  }\n`,
    )
  })

  Vitest.it('flushes on scope close and appends across runs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-logger-'))
    const logFilePath = path.join(dir, 'app.log')

    // The batch window (default 1s) must not delay visibility past scope close:
    // scope finalization flushes and closes the handle before runPromise settles.
    const program = Effect.log('scoped entry').pipe(
      Effect.provide(makeFileLogger({ logFilePath, threadName: 'worker' })),
    )
    await Effect.runPromise(program)
    expect(fs.readFileSync(logFilePath, 'utf8')).toContain('scoped entry')

    // Re-providing appends rather than truncating (flag "a"): two entries now.
    await Effect.runPromise(program)
    const lines = fs
      .readFileSync(logFilePath, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
    expect(lines).toHaveLength(2)
    for (const line of lines) {
      expect(line).toMatch(/^\[03:04:05\.678 worker\] Info \(#\d+\): scoped entry$/u)
    }
  })
})
