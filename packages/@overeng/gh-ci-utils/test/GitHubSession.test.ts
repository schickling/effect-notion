import path from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { Effect, FileSystem } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  buildCookieHeader,
  isSessionNearExpiry,
  saveSession,
  type SessionData,
} from '../src/node/GitHubSession.ts'

const makeSession = (overrides: Partial<SessionData> = {}): SessionData => ({
  userSession: 'test-session-token-123',
  expiresAt: Math.floor(Date.now() / 1000) + 14 * 24 * 60 * 60,
  savedAt: new Date().toISOString(),
  user: 'testuser',
  ...overrides,
})

describe('GitHubSession', () => {
  describe('buildCookieHeader', () => {
    it('builds Cookie header with user_session', () => {
      const session = makeSession({ userSession: 'abc123' })
      expect(buildCookieHeader(session)).toBe('user_session=abc123')
    })
  })

  describe('isSessionNearExpiry', () => {
    it('returns false for fresh session (14 days)', () => {
      const session = makeSession()
      expect(isSessionNearExpiry(session)).toBe(false)
    })

    it('returns true for session expiring in 1 day', () => {
      const session = makeSession({
        expiresAt: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
      })
      expect(isSessionNearExpiry(session)).toBe(true)
    })

    it('returns true for already expired session', () => {
      const session = makeSession({
        expiresAt: Math.floor(Date.now() / 1000) - 1000,
      })
      expect(isSessionNearExpiry(session)).toBe(true)
    })

    it('returns true for zero expiry', () => {
      const session = makeSession({ expiresAt: 0 })
      expect(isSessionNearExpiry(session)).toBe(true)
    })
  })

  it('sets directory and file permissions before writing session bytes', async () => {
    const previousHome = process.env.HOME
    try {
      await Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* fs.makeTempDirectoryScoped()
        process.env.HOME = home
        const events: string[] = []
        const observedFs = FileSystem.FileSystem.of({
          ...fs,
          chmod: (target, mode) =>
            Effect.sync(() => {
              events.push(
                `${target.endsWith('gh-ci-utils') ? 'directory' : 'file'}-chmod:${mode.toString(8)}`,
              )
            }).pipe(Effect.andThen(fs.chmod(target, mode))),
          writeFileString: (target, data, options) =>
            Effect.sync(() => {
              events.push(
                data.length === 0
                  ? `empty-file-create:${options?.mode?.toString(8) ?? 'default'}`
                  : 'secret-write',
              )
            }).pipe(Effect.andThen(fs.writeFileString(target, data, options))),
        })

        yield* saveSession(makeSession()).pipe(
          Effect.provideService(FileSystem.FileSystem, observedFs),
        )

        expect(events).toEqual([
          'directory-chmod:700',
          'empty-file-create:600',
          'file-chmod:600',
          'secret-write',
        ])
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise)
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = previousHome
      }
    }
  })

  it('establishes private directory and file modes before replacing an existing session', async () => {
    const previousHome = process.env.HOME
    try {
      await Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* fs.makeTempDirectoryScoped()
        process.env.HOME = home
        const sessionDir = path.join(home, '.config', 'gh-ci-utils')
        const sessionFile = path.join(sessionDir, 'session.json')
        yield* fs.makeDirectory(sessionDir, { recursive: true, mode: 0o755 })
        yield* fs.chmod(sessionDir, 0o755)
        yield* fs.writeFileString(sessionFile, '{"old":"synthetic"}', { mode: 0o644 })
        yield* fs.chmod(sessionFile, 0o644)

        yield* saveSession(makeSession())

        expect((yield* fs.stat(sessionDir)).mode & 0o777).toBe(0o700)
        expect((yield* fs.stat(sessionFile)).mode & 0o777).toBe(0o600)
        expect(yield* fs.readFileString(sessionFile)).toContain('test-session-token-123')
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise)
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = previousHome
      }
    }
  })

  it('removes a private staging file when the final replacement fails', async () => {
    const previousHome = process.env.HOME
    try {
      await Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* fs.makeTempDirectoryScoped()
        process.env.HOME = home
        const sessionDir = path.join(home, '.config', 'gh-ci-utils')
        const sessionFile = path.join(sessionDir, 'session.json')
        yield* fs.makeDirectory(sessionFile, { recursive: true })

        const result = yield* Effect.result(saveSession(makeSession()))

        expect(result._tag).toBe('Failure')
        expect(yield* fs.readDirectory(sessionDir)).toEqual(['session.json'])
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise)
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = previousHome
      }
    }
  })
})
