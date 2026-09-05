import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import path from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { Duration, Effect, Option, PubSub, Result } from 'effect'
import { describe, expect, it } from 'vitest'

import { checkAll } from './core.ts'
import { GenieEventBus } from './events.ts'
import type { GenieEvent } from './events.ts'
import { errorOriginatesInFile, isTdzError } from './generation.ts'

describe('isTdzError', () => {
  it('returns true for TDZ ReferenceError', () => {
    const error = new ReferenceError("Cannot access 'catalog' before initialization")
    expect(isTdzError(error)).toBe(true)
  })

  it('returns true for TDZ error with different variable name', () => {
    const error = new ReferenceError("Cannot access 'config' before initialization")
    expect(isTdzError(error)).toBe(true)
  })

  it('returns false for regular ReferenceError', () => {
    const error = new ReferenceError('foo is not defined')
    expect(isTdzError(error)).toBe(false)
  })

  it('returns false for TypeError', () => {
    const error = new TypeError('Cannot read property of undefined')
    expect(isTdzError(error)).toBe(false)
  })

  it('returns false for regular Error', () => {
    const error = new Error('Some error')
    expect(isTdzError(error)).toBe(false)
  })

  it('returns false for non-error values', () => {
    expect(isTdzError('string')).toBe(false)
    expect(isTdzError(null)).toBe(false)
    expect(isTdzError(undefined)).toBe(false)
    expect(isTdzError({})).toBe(false)
  })
})

describe('errorOriginatesInFile', () => {
  it('returns false for TDZ errors (they never originate in the file)', () => {
    const error = new ReferenceError("Cannot access 'catalog' before initialization")
    // Even with a matching stack trace, TDZ errors don't originate in the file
    error.stack = `ReferenceError: Cannot access 'catalog' before initialization
    at /path/to/file.ts:10:5`
    expect(errorOriginatesInFile({ error, filePath: '/path/to/file.ts' })).toBe(false)
  })

  it('returns true when error stack contains the file path', () => {
    const error = new Error('Some initialization error')
    error.stack = `Error: Some initialization error
    at Object.<anonymous> (/path/to/internal.ts:5:9)
    at Module._compile (node:internal/modules/cjs/loader:1358:14)`
    expect(errorOriginatesInFile({ error, filePath: '/path/to/internal.ts' })).toBe(true)
  })

  it('returns false when error stack does not contain the file path', () => {
    const error = new Error('Propagated error from dependency')
    error.stack = `Error: Propagated error from dependency
    at Object.<anonymous> (/path/to/internal.ts:5:9)
    at Module._compile (node:internal/modules/cjs/loader:1358:14)`
    expect(errorOriginatesInFile({ error, filePath: '/path/to/consumer.ts' })).toBe(false)
  })

  it('returns false when error has no stack trace', () => {
    const error = new Error('Error without stack')
    delete error.stack
    expect(errorOriginatesInFile({ error, filePath: '/path/to/file.ts' })).toBe(false)
  })

  it('returns false for non-Error values', () => {
    expect(
      errorOriginatesInFile({
        error: 'string error',
        filePath: '/path/to/file.ts',
      }),
    ).toBe(false)
    expect(errorOriginatesInFile({ error: null, filePath: '/path/to/file.ts' })).toBe(false)
    expect(errorOriginatesInFile({ error: undefined, filePath: '/path/to/file.ts' })).toBe(false)
  })

  it('handles partial file path matches correctly', () => {
    const error = new Error('Error in file')
    error.stack = `Error: Error in file
    at Object.<anonymous> (/path/to/file.ts:5:9)`

    // Full path match - should return true
    expect(errorOriginatesInFile({ error, filePath: '/path/to/file.ts' })).toBe(true)

    // Partial path that exists in stack - should return true (substring match)
    expect(errorOriginatesInFile({ error, filePath: 'file.ts' })).toBe(true)

    // Path not in stack - should return false
    expect(errorOriginatesInFile({ error, filePath: '/other/path.ts' })).toBe(false)
  })
})

/**
 * `checkAll` registers genie's Bun import-map resolver, so the suite needs a
 * `Bun.plugin`. Under the Bun runtime the real one is already present and must
 * not be reassigned — `globalThis.Bun` is a non-writable global there — so the
 * suite installs a no-op stub only on runtimes that have no `Bun` at all.
 */
const installBunPluginHost = (): (() => void) => {
  const globalWithBun = globalThis as { Bun?: unknown }
  if (globalWithBun.Bun !== undefined) return () => undefined
  Object.defineProperty(globalThis, 'Bun', {
    value: { plugin: () => undefined },
    configurable: true,
    writable: true,
  })
  return () => {
    delete globalWithBun.Bun
  }
}

describe('checkAll', () => {
  it('fails fast on fatal import errors and marks interrupted siblings as non-active', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'genie-check-fail-fast-'))
    const restoreBunPluginHost = installBunPluginHost()

    const writeFile = async ({
      relativePath,
      content,
    }: {
      relativePath: string
      content: string
    }) => {
      const filePath = path.join(root, relativePath)
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await fs.writeFile(filePath, content)
    }

    try {
      await writeFile({
        relativePath: 'package.json',
        content: JSON.stringify({ name: 'genie-check-test', private: true, type: 'module' }),
      })

      await writeFile({
        relativePath: 'shared/broken.ts',
        content: `export const duplicate = 1
export const duplicate = 2
`,
      })

      await writeFile({
        relativePath: 'fatal/package.json.genie.ts',
        content: `import { duplicate } from '../shared/broken.ts'

export default {
  data: { duplicate },
  stringify: () => JSON.stringify({ duplicate }),
}
`,
      })

      await writeFile({
        relativePath: 'stuck/package.json.genie.ts',
        content: `await new Promise(() => {})

export default {
  data: { ok: true },
  stringify: () => JSON.stringify({ ok: true }),
}
`,
      })

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const bus = yield* PubSub.unbounded<GenieEvent>()
          return yield* checkAll({
            cwd: root,
            oxfmtConfigPath: Option.none(),
          }).pipe(
            Effect.provideService(GenieEventBus, bus),
            Effect.provide(NodeServices.layer),
            Effect.timeout(Duration.seconds(2)),
            Effect.result,
          )
        }),
      )

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isSuccess(result) === true) return

      const error = result.failure
      expect(error._tag).toBe('GenieGenerationFailedError')
      if (error._tag !== 'GenieGenerationFailedError') return

      expect(error.files.some((file) => file.status === 'active')).toBe(false)

      const canceledSibling = error.files.find(
        (file) => file.message?.includes('Cancelled due to fatal error in another file') === true,
      )
      expect(canceledSibling).toBeDefined()
      expect(canceledSibling?.status).toBe('error')
    } finally {
      restoreBunPluginHost()
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
