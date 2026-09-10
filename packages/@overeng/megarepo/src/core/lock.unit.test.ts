import { Option, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  checkLockStaleness,
  createEmptyLockFile,
  createLockedMember,
  getLockedMember,
  hasMember,
  isPinned,
  lockedMembersEqual,
  LOCK_FILE_VERSION,
  LockFile,
  LockedMember,
  pinMember,
  removeLockedMember,
  syncLockWithConfig,
  unpinMember,
  updateLockedMember,
  upsertLockedMember,
} from './lock.ts'

describe('lock', () => {
  describe('LockFile schema', () => {
    it('should decode valid lock file', () => {
      const input = {
        version: 1,
        members: {
          effect: {
            url: 'https://github.com/effect-ts/effect',
            ref: 'main',
            commit: 'abc123def456789012345678901234567890abcd',
            pinned: false,
            lockedAt: '2024-01-15T10:30:00Z',
          },
        },
      }
      const result = Schema.decodeSync(LockFile)(input)
      expect(result.version).toBe(1)
      expect(result.members['effect']?.url).toBe('https://github.com/effect-ts/effect')
      expect(result.members['effect']?.pinned).toBe(false)
    })

    it('should decode lock file with pinned member', () => {
      const input = {
        version: 1,
        members: {
          effect: {
            url: 'https://github.com/effect-ts/effect',
            ref: 'v3.0.0',
            commit: 'def456abc789012345678901234567890abcdef1',
            pinned: true,
            lockedAt: '2024-01-10T08:00:00Z',
          },
        },
      }
      const result = Schema.decodeSync(LockFile)(input)
      expect(result.members['effect']?.pinned).toBe(true)
    })

    it('should reject lock file without version', () => {
      const input = {
        members: {},
      }
      expect(() => Schema.decodeUnknownSync(LockFile)(input)).toThrow()
    })

    it('should reject lock file without members', () => {
      const input = {
        version: 1,
      }
      expect(() => Schema.decodeUnknownSync(LockFile)(input)).toThrow()
    })
  })

  describe('LockedMember schema', () => {
    it('should decode valid locked member', () => {
      const input = {
        url: 'https://github.com/owner/repo',
        ref: 'main',
        commit: 'abc123def456789012345678901234567890abcd',
        pinned: false,
        lockedAt: '2024-01-15T10:30:00Z',
      }
      const result = Schema.decodeSync(LockedMember)(input)
      expect(result.url).toBe('https://github.com/owner/repo')
      expect(result.commit).toBe('abc123def456789012345678901234567890abcd')
    })
  })

  describe('createEmptyLockFile', () => {
    it('should create lock file with correct version', () => {
      const lockFile = createEmptyLockFile()
      expect(lockFile.version).toBe(LOCK_FILE_VERSION)
      expect(lockFile.members).toEqual({})
    })
  })

  describe('createLockedMember', () => {
    it('should create locked member with defaults', () => {
      const member = createLockedMember({
        url: 'https://github.com/owner/repo',
        ref: 'main',
        commit: 'abc123',
      })
      expect(member.url).toBe('https://github.com/owner/repo')
      expect(member.ref).toBe('main')
      expect(member.commit).toBe('abc123')
      expect(member.pinned).toBe(false)
      expect(member.lockedAt).toBeDefined()
    })

    it('should create pinned member', () => {
      const member = createLockedMember({
        url: 'https://github.com/owner/repo',
        ref: 'v1.0.0',
        commit: 'abc123',
        pinned: true,
      })
      expect(member.pinned).toBe(true)
    })
  })

  describe('updateLockedMember', () => {
    it('should add new member', () => {
      const lockFile = createEmptyLockFile()
      const member = createLockedMember({
        url: 'https://github.com/owner/repo',
        ref: 'main',
        commit: 'abc123',
      })
      const updated = updateLockedMember({
        lockFile,
        memberName: 'effect',
        member,
      })
      expect(updated.members['effect']).toBe(member)
    })

    it('should update existing member', () => {
      let lockFile = createEmptyLockFile()
      const member1 = createLockedMember({
        url: 'https://github.com/owner/repo',
        ref: 'main',
        commit: 'abc123',
      })
      lockFile = updateLockedMember({
        lockFile,
        memberName: 'effect',
        member: member1,
      })

      const member2 = createLockedMember({
        url: 'https://github.com/owner/repo',
        ref: 'main',
        commit: 'def456',
      })
      const updated = updateLockedMember({
        lockFile,
        memberName: 'effect',
        member: member2,
      })
      expect(updated.members['effect']?.commit).toBe('def456')
    })
  })

  describe('removeLockedMember', () => {
    it('should remove existing member', () => {
      let lockFile = createEmptyLockFile()
      const member = createLockedMember({
        url: 'https://github.com/owner/repo',
        ref: 'main',
        commit: 'abc123',
      })
      lockFile = updateLockedMember({ lockFile, memberName: 'effect', member })

      const updated = removeLockedMember({ lockFile, memberName: 'effect' })
      expect(updated.members['effect']).toBeUndefined()
    })

    it('should handle removing non-existent member', () => {
      const lockFile = createEmptyLockFile()
      const updated = removeLockedMember({ lockFile, memberName: 'effect' })
      expect(updated.members).toEqual({})
    })
  })

  describe('pinMember / unpinMember', () => {
    it('should pin a member', () => {
      let lockFile = createEmptyLockFile()
      const member = createLockedMember({
        url: 'https://github.com/owner/repo',
        ref: 'main',
        commit: 'abc123',
      })
      lockFile = updateLockedMember({ lockFile, memberName: 'effect', member })

      const pinned = pinMember({ lockFile, memberName: 'effect' })
      expect(pinned.members['effect']?.pinned).toBe(true)
    })

    it('should unpin a member', () => {
      let lockFile = createEmptyLockFile()
      const member = createLockedMember({
        url: 'https://github.com/owner/repo',
        ref: 'main',
        commit: 'abc123',
        pinned: true,
      })
      lockFile = updateLockedMember({ lockFile, memberName: 'effect', member })

      const unpinned = unpinMember({ lockFile, memberName: 'effect' })
      expect(unpinned.members['effect']?.pinned).toBe(false)
    })

    it('should handle pinning non-existent member', () => {
      const lockFile = createEmptyLockFile()
      const pinned = pinMember({ lockFile, memberName: 'effect' })
      expect(pinned.members).toEqual({})
    })
  })

  describe('getLockedMember', () => {
    it('should return Some for existing member', () => {
      let lockFile = createEmptyLockFile()
      const member = createLockedMember({
        url: 'https://github.com/owner/repo',
        ref: 'main',
        commit: 'abc123',
      })
      lockFile = updateLockedMember({ lockFile, memberName: 'effect', member })

      const result = getLockedMember({ lockFile, memberName: 'effect' })
      expect(Option.isSome(result)).toBe(true)
      expect(Option.getOrNull(result)?.commit).toBe('abc123')
    })

    it('should return None for non-existent member', () => {
      const lockFile = createEmptyLockFile()
      const result = getLockedMember({ lockFile, memberName: 'effect' })
      expect(Option.isNone(result)).toBe(true)
    })
  })

  describe('hasMember / isPinned', () => {
    it('hasMember should return true for existing member', () => {
      let lockFile = createEmptyLockFile()
      lockFile = updateLockedMember({
        lockFile,
        memberName: 'effect',
        member: createLockedMember({ url: 'url', ref: 'main', commit: 'abc' }),
      })
      expect(hasMember({ lockFile, memberName: 'effect' })).toBe(true)
      expect(hasMember({ lockFile, memberName: 'other' })).toBe(false)
    })

    it('isPinned should return correct status', () => {
      let lockFile = createEmptyLockFile()
      lockFile = updateLockedMember({
        lockFile,
        memberName: 'effect',
        member: createLockedMember({
          url: 'url',
          ref: 'main',
          commit: 'abc',
          pinned: true,
        }),
      })
      lockFile = updateLockedMember({
        lockFile,
        memberName: 'other',
        member: createLockedMember({
          url: 'url',
          ref: 'main',
          commit: 'abc',
          pinned: false,
        }),
      })
      expect(isPinned({ lockFile, memberName: 'effect' })).toBe(true)
      expect(isPinned({ lockFile, memberName: 'other' })).toBe(false)
      expect(isPinned({ lockFile, memberName: 'missing' })).toBe(false)
    })
  })

  describe('checkLockStaleness', () => {
    it('should detect added members', () => {
      const lockFile = createEmptyLockFile()
      const configMemberNames = new Set(['effect', 'other'])

      const result = checkLockStaleness({ lockFile, configMemberNames })
      expect(result.addedMembers).toEqual(['effect', 'other'])
      expect(result.removedMembers).toEqual([])
      expect(result.isStale).toBe(true)
    })

    it('should detect removed members', () => {
      let lockFile = createEmptyLockFile()
      lockFile = updateLockedMember({
        lockFile,
        memberName: 'effect',
        member: createLockedMember({ url: 'url', ref: 'main', commit: 'abc' }),
      })
      lockFile = updateLockedMember({
        lockFile,
        memberName: 'removed',
        member: createLockedMember({ url: 'url', ref: 'main', commit: 'abc' }),
      })
      const configMemberNames = new Set(['effect'])

      const result = checkLockStaleness({ lockFile, configMemberNames })
      expect(result.addedMembers).toEqual([])
      expect(result.removedMembers).toEqual(['removed'])
      expect(result.isStale).toBe(true)
    })

    it('should detect both added and removed', () => {
      let lockFile = createEmptyLockFile()
      lockFile = updateLockedMember({
        lockFile,
        memberName: 'old',
        member: createLockedMember({ url: 'url', ref: 'main', commit: 'abc' }),
      })
      const configMemberNames = new Set(['new'])

      const result = checkLockStaleness({ lockFile, configMemberNames })
      expect(result.addedMembers).toEqual(['new'])
      expect(result.removedMembers).toEqual(['old'])
      expect(result.isStale).toBe(true)
    })

    it('should return not stale when in sync', () => {
      let lockFile = createEmptyLockFile()
      lockFile = updateLockedMember({
        lockFile,
        memberName: 'effect',
        member: createLockedMember({ url: 'url', ref: 'main', commit: 'abc' }),
      })
      const configMemberNames = new Set(['effect'])

      const result = checkLockStaleness({ lockFile, configMemberNames })
      expect(result.addedMembers).toEqual([])
      expect(result.removedMembers).toEqual([])
      expect(result.isStale).toBe(false)
    })
  })

  describe('lockedMembersEqual', () => {
    it('should return true for identical members', () => {
      const member1 = createLockedMember({
        url: 'https://github.com/owner/repo',
        ref: 'main',
        commit: 'abc123',
        pinned: false,
      })
      const member2 = createLockedMember({
        url: 'https://github.com/owner/repo',
        ref: 'main',
        commit: 'abc123',
        pinned: false,
      })
      expect(lockedMembersEqual({ a: member1, b: member2 })).toBe(true)
    })

    it('should return false when url differs', () => {
      const member1 = createLockedMember({
        url: 'url1',
        ref: 'main',
        commit: 'abc',
      })
      const member2 = createLockedMember({
        url: 'url2',
        ref: 'main',
        commit: 'abc',
      })
      expect(lockedMembersEqual({ a: member1, b: member2 })).toBe(false)
    })

    it('should return false when ref differs', () => {
      const member1 = createLockedMember({
        url: 'url',
        ref: 'main',
        commit: 'abc',
      })
      const member2 = createLockedMember({
        url: 'url',
        ref: 'develop',
        commit: 'abc',
      })
      expect(lockedMembersEqual({ a: member1, b: member2 })).toBe(false)
    })

    it('should return false when commit differs', () => {
      const member1 = createLockedMember({
        url: 'url',
        ref: 'main',
        commit: 'abc',
      })
      const member2 = createLockedMember({
        url: 'url',
        ref: 'main',
        commit: 'def',
      })
      expect(lockedMembersEqual({ a: member1, b: member2 })).toBe(false)
    })

    it('should return false when pinned differs', () => {
      const member1 = createLockedMember({
        url: 'url',
        ref: 'main',
        commit: 'abc',
        pinned: false,
      })
      const member2 = createLockedMember({
        url: 'url',
        ref: 'main',
        commit: 'abc',
        pinned: true,
      })
      expect(lockedMembersEqual({ a: member1, b: member2 })).toBe(false)
    })

    it('should ignore lockedAt differences', () => {
      const member1: LockedMember = new LockedMember({
        url: 'url',
        ref: 'main',
        commit: 'abc',
        pinned: false,
        lockedAt: '2024-01-01T00:00:00Z',
      })
      const member2: LockedMember = new LockedMember({
        url: 'url',
        ref: 'main',
        commit: 'abc',
        pinned: false,
        lockedAt: '2024-12-31T23:59:59Z',
      })
      expect(lockedMembersEqual({ a: member1, b: member2 })).toBe(true)
    })
  })

  describe('upsertLockedMember', () => {
    it('should create new member with fresh timestamp', () => {
      const lockFile = createEmptyLockFile()
      const updated = upsertLockedMember({
        lockFile,
        memberName: 'effect',
        update: {
          url: 'https://github.com/owner/repo',
          ref: 'main',
          commit: 'abc123',
        },
      })
      expect(updated.members['effect']).toBeDefined()
      expect(updated.members['effect']?.commit).toBe('abc123')
      expect(updated.members['effect']?.lockedAt).toBeDefined()
    })

    it('should update member and timestamp when commit changes', () => {
      let lockFile = createEmptyLockFile()
      const originalLockedAt = '2024-01-01T00:00:00Z'
      lockFile = updateLockedMember({
        lockFile,
        memberName: 'effect',
        member: {
          url: 'https://github.com/owner/repo',
          ref: 'main',
          commit: 'abc123',
          pinned: false,
          lockedAt: originalLockedAt,
        },
      })

      const updated = upsertLockedMember({
        lockFile,
        memberName: 'effect',
        update: {
          url: 'https://github.com/owner/repo',
          ref: 'main',
          commit: 'def456', // Changed commit
        },
      })

      expect(updated.members['effect']?.commit).toBe('def456')
      expect(updated.members['effect']?.lockedAt).not.toBe(originalLockedAt)
    })

    it('should NOT update timestamp when nothing changes', () => {
      let lockFile = createEmptyLockFile()
      const originalLockedAt = '2024-01-01T00:00:00Z'
      lockFile = updateLockedMember({
        lockFile,
        memberName: 'effect',
        member: {
          url: 'https://github.com/owner/repo',
          ref: 'main',
          commit: 'abc123',
          pinned: false,
          lockedAt: originalLockedAt,
        },
      })

      const updated = upsertLockedMember({
        lockFile,
        memberName: 'effect',
        update: {
          url: 'https://github.com/owner/repo',
          ref: 'main',
          commit: 'abc123', // Same commit
          pinned: false, // Same pinned
        },
      })

      // Should return the same lock file (no update)
      expect(updated).toBe(lockFile)
      expect(updated.members['effect']?.lockedAt).toBe(originalLockedAt)
    })

    it('should preserve existing pinned status when not specified', () => {
      let lockFile = createEmptyLockFile()
      lockFile = updateLockedMember({
        lockFile,
        memberName: 'effect',
        member: createLockedMember({
          url: 'url',
          ref: 'main',
          commit: 'abc',
          pinned: true,
        }),
      })

      // Update without specifying pinned (defaults to false)
      const updated = upsertLockedMember({
        lockFile,
        memberName: 'effect',
        update: {
          url: 'url',
          ref: 'main',
          commit: 'def', // Changed
          // pinned not specified, defaults to false
        },
      })

      // Since pinned changed (true -> false), timestamp should update
      expect(updated.members['effect']?.pinned).toBe(false)
      expect(updated.members['effect']?.commit).toBe('def')
    })
  })

  describe('syncLockWithConfig', () => {
    it('should remove members not in config', () => {
      let lockFile = createEmptyLockFile()
      lockFile = updateLockedMember({
        lockFile,
        memberName: 'effect',
        member: createLockedMember({ url: 'url1', ref: 'main', commit: 'abc' }),
      })
      lockFile = updateLockedMember({
        lockFile,
        memberName: 'removed',
        member: createLockedMember({ url: 'url2', ref: 'main', commit: 'def' }),
      })
      const configMemberNames = new Set(['effect'])

      const synced = syncLockWithConfig({ lockFile, configMemberNames })
      expect(synced.members['effect']).toBeDefined()
      expect(synced.members['removed']).toBeUndefined()
    })

    it('should preserve members in config', () => {
      let lockFile = createEmptyLockFile()
      lockFile = updateLockedMember({
        lockFile,
        memberName: 'effect',
        member: createLockedMember({
          url: 'url',
          ref: 'main',
          commit: 'abc',
          pinned: true,
        }),
      })
      const configMemberNames = new Set(['effect'])

      const synced = syncLockWithConfig({ lockFile, configMemberNames })
      expect(synced.members['effect']?.pinned).toBe(true)
    })
  })
})
