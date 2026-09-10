import { describe, expect, it } from 'vitest'

import {
  buildCookieHeader,
  isSessionNearExpiry,
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
})
