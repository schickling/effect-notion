import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import type { LockedMember } from '../lock.ts'
import { parseNixFlakeUrl, getRef, getRev, updateNixFlakeUrl } from './flake-url.ts'
import {
  extractFlakeNixInputs,
  extractDevenvYamlInputs,
  extractLockFileInputs,
  matchUrlToMember,
} from './input-discovery.ts'
import {
  matchLockedInputToMember,
  needsRevUpdate,
  normalizeGitHubUrl,
  normalizeGitUrl,
  urlsMatch,
} from './matcher.ts'
import {
  FlakeLock,
  GitHubLockedInput,
  GitLockedInput,
  parseLockedInput,
  updateLockedInputRev,
} from './schema.ts'
import {
  rewriteFlakeNixUrls,
  rewriteDevenvYamlUrls,
  rewriteLockFileRefs,
  type SourceUrlUpdate,
} from './source-rewriter.ts'

// =============================================================================
// Helper for full sync flow testing
// =============================================================================

/**
 * Simulates the full sync flow to test order preservation.
 * This mirrors the logic in syncSingleLockFile.
 */
const simulateSyncFlow = (
  lockFileContent: string,
  megarepoMembers: Record<string, LockedMember>,
): string => {
  // Parse raw JSON (preserves key order)
  const rawJson = JSON.parse(lockFileContent) as {
    nodes: Record<string, Record<string, unknown>>
    root: string
    version: number
  }

  // Validate with schema (like real code does)
  Schema.decodeSync(FlakeLock)(rawJson)

  // Process each node
  for (const [nodeName, node] of Object.entries(rawJson.nodes)) {
    const locked = node['locked'] as Record<string, unknown> | undefined
    if (locked === undefined) continue

    const match = matchLockedInputToMember({ locked, members: megarepoMembers })
    if (match !== undefined && needsRevUpdate({ locked, member: match.member }) === true) {
      // Update using our order-preserving functions
      const newLocked = updateLockedInputRev({ locked, newRev: match.member.commit })
      // Preserve node key order
      const result: Record<string, unknown> = {}
      for (const key of Object.keys(node)) {
        if (key === 'locked') {
          result['locked'] = newLocked
        } else {
          result[key] = node[key]
        }
      }
      rawJson.nodes[nodeName] = result
    }
  }

  return JSON.stringify(rawJson, null, 2)
}

// =============================================================================
// Test Helpers
// =============================================================================

const createLockedMember = (overrides: Partial<LockedMember> = {}): LockedMember => ({
  url: 'https://github.com/owner/repo',
  ref: 'main',
  commit: 'abc123def456789012345678901234567890abcd',
  pinned: false,
  lockedAt: '2024-01-15T10:30:00Z',
  ...overrides,
})

// =============================================================================
// Schema Tests
// =============================================================================

describe('nix-lock schema', () => {
  describe('FlakeLock', () => {
    it('should decode a minimal flake.lock', () => {
      const input = {
        nodes: {
          root: {
            inputs: {},
          },
        },
        root: 'root',
        version: 7,
      }
      const result = Schema.decodeSync(FlakeLock)(input)
      expect(result.version).toBe(7)
      expect(result.root).toBe('root')
    })

    it('should decode a flake.lock with GitHub input', () => {
      const input = {
        nodes: {
          nixpkgs: {
            locked: {
              lastModified: 1704067200,
              narHash: 'sha256-abc123',
              owner: 'NixOS',
              repo: 'nixpkgs',
              rev: 'abc123',
              type: 'github',
            },
            original: {
              owner: 'NixOS',
              ref: 'nixos-24.05',
              repo: 'nixpkgs',
              type: 'github',
            },
          },
          root: {
            inputs: {
              nixpkgs: 'nixpkgs',
            },
          },
        },
        root: 'root',
        version: 7,
      }
      const result = Schema.decodeSync(FlakeLock)(input)
      expect(result.nodes['nixpkgs']?.locked?.['owner']).toBe('NixOS')
      expect(result.nodes['nixpkgs']?.locked?.['repo']).toBe('nixpkgs')
    })

    it('should decode a flake.lock with git input', () => {
      const input = {
        nodes: {
          'my-repo': {
            locked: {
              rev: 'def456',
              type: 'git',
              url: 'https://github.com/owner/my-repo',
            },
            original: {
              type: 'git',
              url: 'https://github.com/owner/my-repo',
            },
          },
          root: {
            inputs: {
              'my-repo': 'my-repo',
            },
          },
        },
        root: 'root',
        version: 7,
      }
      const result = Schema.decodeSync(FlakeLock)(input)
      expect(result.nodes['my-repo']?.locked?.['type']).toBe('git')
      expect(result.nodes['my-repo']?.locked?.['url']).toBe('https://github.com/owner/my-repo')
    })
  })

  describe('GitHubLockedInput', () => {
    it('should decode a GitHub locked input', () => {
      const input = {
        type: 'github',
        owner: 'NixOS',
        repo: 'nixpkgs',
        rev: 'abc123',
      }
      const result = Schema.decodeUnknownSync(GitHubLockedInput)(input)
      expect(result.type).toBe('github')
      expect(result.owner).toBe('NixOS')
      expect(result.repo).toBe('nixpkgs')
      expect(result.rev).toBe('abc123')
    })

    it('should decode with optional narHash and lastModified', () => {
      const input = {
        type: 'github',
        owner: 'NixOS',
        repo: 'nixpkgs',
        rev: 'abc123',
        narHash: 'sha256-xxx',
        lastModified: 1704067200,
      }
      const result = Schema.decodeUnknownSync(GitHubLockedInput)(input)
      expect(result.narHash).toBe('sha256-xxx')
      expect(result.lastModified).toBe(1704067200)
    })
  })

  describe('GitLockedInput', () => {
    it('should decode a git locked input', () => {
      const input = {
        type: 'git',
        url: 'https://github.com/owner/repo',
        rev: 'def456',
      }
      const result = Schema.decodeUnknownSync(GitLockedInput)(input)
      expect(result.type).toBe('git')
      expect(result.url).toBe('https://github.com/owner/repo')
      expect(result.rev).toBe('def456')
    })
  })

  describe('parseLockedInput', () => {
    it('should parse GitHub locked input', () => {
      const locked = {
        type: 'github',
        owner: 'effect-ts',
        repo: 'effect',
        rev: 'abc123',
        narHash: 'sha256-xxx',
        lastModified: 1704067200,
      }
      const result = parseLockedInput(locked)
      expect(result).toEqual({
        type: 'github',
        owner: 'effect-ts',
        repo: 'effect',
        rev: 'abc123',
        url: undefined,
        narHash: 'sha256-xxx',
        lastModified: 1704067200,
      })
    })

    it('should parse git locked input', () => {
      const locked = {
        type: 'git',
        url: 'https://github.com/owner/repo',
        rev: 'def456',
      }
      const result = parseLockedInput(locked)
      expect(result).toEqual({
        type: 'git',
        owner: undefined,
        repo: undefined,
        url: 'https://github.com/owner/repo',
        rev: 'def456',
        narHash: undefined,
        lastModified: undefined,
      })
    })

    it('should return undefined for invalid input', () => {
      expect(parseLockedInput(undefined)).toBeUndefined()
      expect(parseLockedInput({})).toBeUndefined()
      expect(parseLockedInput({ notType: 'foo' })).toBeUndefined()
    })
  })

  describe('updateLockedInputRev', () => {
    it('should update rev and remove narHash and lastModified', () => {
      const locked = {
        type: 'github',
        owner: 'effect-ts',
        repo: 'effect',
        rev: 'old-rev',
        narHash: 'sha256-oldHash',
        lastModified: 1704067200,
      }
      const result = updateLockedInputRev({ locked, newRev: 'new-rev' })
      expect(result).toEqual({
        type: 'github',
        owner: 'effect-ts',
        repo: 'effect',
        rev: 'new-rev',
        // narHash and lastModified should be removed
      })
      expect(result['narHash']).toBeUndefined()
      expect(result['lastModified']).toBeUndefined()
    })

    it('should preserve other fields', () => {
      const locked = {
        type: 'git',
        url: 'https://github.com/owner/repo',
        rev: 'old-rev',
        ref: 'main',
        shallow: true,
      }
      const result = updateLockedInputRev({ locked, newRev: 'new-rev' })
      expect(result).toEqual({
        type: 'git',
        url: 'https://github.com/owner/repo',
        rev: 'new-rev',
        ref: 'main',
        shallow: true,
      })
    })

    it('should preserve key order from original object', () => {
      // Nix natural order: lastModified, narHash, owner, repo, rev, type
      const locked = {
        lastModified: 1704067200,
        narHash: 'sha256-oldHash',
        owner: 'effect-ts',
        repo: 'effect',
        rev: 'old-rev',
        type: 'github',
      }
      const result = updateLockedInputRev({ locked, newRev: 'new-rev' })
      const keys = Object.keys(result)
      // narHash and lastModified should be removed, but remaining keys preserve order
      expect(keys).toEqual(['owner', 'repo', 'rev', 'type'])
    })

    it('should preserve Nix natural key order (type first)', () => {
      // Another common Nix order: type, owner, repo, rev, narHash, lastModified
      const locked = {
        type: 'github',
        owner: 'effect-ts',
        repo: 'effect',
        rev: 'old-rev',
        narHash: 'sha256-oldHash',
        lastModified: 1704067200,
      }
      const result = updateLockedInputRev({ locked, newRev: 'new-rev' })
      const keys = Object.keys(result)
      expect(keys).toEqual(['type', 'owner', 'repo', 'rev'])
    })

    it('should handle missing rev in original (adds it at end)', () => {
      const locked = {
        type: 'path',
        path: '/some/path',
      }
      const result = updateLockedInputRev({ locked, newRev: 'new-rev' })
      expect(result).toEqual({
        type: 'path',
        path: '/some/path',
        rev: 'new-rev',
      })
    })
  })

  describe('updateLockedInputRev with metadata', () => {
    it('should update rev and include new narHash and lastModified', () => {
      const locked = {
        lastModified: 1704067200,
        narHash: 'sha256-oldHash',
        owner: 'effect-ts',
        repo: 'effect',
        rev: 'old-rev',
        type: 'github',
      }
      const metadata = {
        narHash: 'sha256-newHash123',
        lastModified: 1704153600,
      }
      const result = updateLockedInputRev({ locked, newRev: 'new-rev', metadata })
      expect(result).toEqual({
        lastModified: 1704153600,
        narHash: 'sha256-newHash123',
        owner: 'effect-ts',
        repo: 'effect',
        rev: 'new-rev',
        type: 'github',
      })
    })

    it('should preserve key order from original object', () => {
      const locked = {
        lastModified: 1704067200,
        narHash: 'sha256-oldHash',
        owner: 'effect-ts',
        repo: 'effect',
        rev: 'old-rev',
        type: 'github',
      }
      const metadata = {
        narHash: 'sha256-newHash',
        lastModified: 1704153600,
      }
      const result = updateLockedInputRev({ locked, newRev: 'new-rev', metadata })
      const keys = Object.keys(result)
      // Key order should be preserved from original
      expect(keys).toEqual(['lastModified', 'narHash', 'owner', 'repo', 'rev', 'type'])
    })

    it('should add missing metadata fields at the end', () => {
      // Original doesn't have narHash/lastModified
      const locked = {
        owner: 'effect-ts',
        repo: 'effect',
        rev: 'old-rev',
        type: 'github',
      }
      const metadata = {
        narHash: 'sha256-newHash',
        lastModified: 1704153600,
      }
      const result = updateLockedInputRev({ locked, newRev: 'new-rev', metadata })
      expect(result['narHash']).toBe('sha256-newHash')
      expect(result['lastModified']).toBe(1704153600)
      expect(result['rev']).toBe('new-rev')
    })

    it('should preserve other fields like ref and shallow', () => {
      const locked = {
        type: 'git',
        url: 'https://github.com/owner/repo',
        rev: 'old-rev',
        ref: 'main',
        shallow: true,
        narHash: 'sha256-old',
        lastModified: 1704067200,
      }
      const metadata = {
        narHash: 'sha256-new',
        lastModified: 1704153600,
      }
      const result = updateLockedInputRev({ locked, newRev: 'new-rev', metadata })
      expect(result).toEqual({
        type: 'git',
        url: 'https://github.com/owner/repo',
        rev: 'new-rev',
        ref: 'main',
        shallow: true,
        narHash: 'sha256-new',
        lastModified: 1704153600,
      })
    })
  })
})

// =============================================================================
// Matcher Tests
// =============================================================================

describe('nix-lock matcher', () => {
  describe('normalizeGitHubUrl', () => {
    it('should normalize HTTPS GitHub URLs', () => {
      expect(normalizeGitHubUrl('https://github.com/owner/repo')).toBe(
        'https://github.com/owner/repo',
      )
      expect(normalizeGitHubUrl('https://github.com/owner/repo.git')).toBe(
        'https://github.com/owner/repo',
      )
      expect(normalizeGitHubUrl('https://github.com/owner/repo/')).toBe(
        'https://github.com/owner/repo',
      )
    })

    it('should normalize SSH GitHub URLs', () => {
      expect(normalizeGitHubUrl('git@github.com:owner/repo')).toBe('https://github.com/owner/repo')
      expect(normalizeGitHubUrl('git@github.com:owner/repo.git')).toBe(
        'https://github.com/owner/repo',
      )
    })

    it('should return undefined for non-GitHub URLs', () => {
      expect(normalizeGitHubUrl('https://gitlab.com/owner/repo')).toBeUndefined()
      expect(normalizeGitHubUrl('/local/path')).toBeUndefined()
    })
  })

  describe('normalizeGitUrl', () => {
    it('should remove trailing .git and slashes', () => {
      expect(normalizeGitUrl('https://example.com/repo.git')).toBe('https://example.com/repo')
      expect(normalizeGitUrl('https://example.com/repo/')).toBe('https://example.com/repo')
      expect(normalizeGitUrl('https://example.com/repo.git/')).toBe('https://example.com/repo.git')
    })
  })

  describe('urlsMatch', () => {
    it('should match equivalent GitHub URLs', () => {
      expect(
        urlsMatch({
          url1: 'https://github.com/owner/repo',
          url2: 'https://github.com/owner/repo.git',
        }),
      ).toBe(true)
      expect(
        urlsMatch({ url1: 'https://github.com/owner/repo', url2: 'git@github.com:owner/repo' }),
      ).toBe(true)
      expect(
        urlsMatch({ url1: 'git@github.com:owner/repo.git', url2: 'https://github.com/owner/repo' }),
      ).toBe(true)
    })

    it('should be case-insensitive', () => {
      expect(
        urlsMatch({ url1: 'https://github.com/Owner/Repo', url2: 'https://github.com/owner/repo' }),
      ).toBe(true)
    })

    it('should not match different repos', () => {
      expect(
        urlsMatch({
          url1: 'https://github.com/owner/repo1',
          url2: 'https://github.com/owner/repo2',
        }),
      ).toBe(false)
      expect(
        urlsMatch({
          url1: 'https://github.com/owner1/repo',
          url2: 'https://github.com/owner2/repo',
        }),
      ).toBe(false)
    })
  })

  describe('matchLockedInputToMember', () => {
    it('should match GitHub input to member by URL', () => {
      const locked = {
        type: 'github',
        owner: 'effect-ts',
        repo: 'effect',
        rev: 'abc123',
      }
      const members = {
        effect: createLockedMember({
          url: 'https://github.com/effect-ts/effect',
          commit: 'def456',
        }),
      }
      const result = matchLockedInputToMember({ locked, members })
      expect(result).toEqual({
        memberName: 'effect',
        member: members['effect'],
      })
    })

    it('should match git input to member by URL', () => {
      const locked = {
        type: 'git',
        url: 'https://github.com/owner/my-lib',
        rev: 'abc123',
      }
      const members = {
        'my-lib': createLockedMember({
          url: 'https://github.com/owner/my-lib',
          commit: 'def456',
        }),
      }
      const result = matchLockedInputToMember({ locked, members })
      expect(result).toEqual({
        memberName: 'my-lib',
        member: members['my-lib'],
      })
    })

    it('should not match when URL does not match any member', () => {
      const locked = {
        type: 'github',
        owner: 'unknown',
        repo: 'repo',
        rev: 'abc123',
      }
      const members = {
        effect: createLockedMember({
          url: 'https://github.com/effect-ts/effect',
        }),
      }
      const result = matchLockedInputToMember({ locked, members })
      expect(result).toBeUndefined()
    })

    it('should not match path type inputs', () => {
      const locked = {
        type: 'path',
        path: '/some/local/path',
      }
      const members = {
        effect: createLockedMember(),
      }
      const result = matchLockedInputToMember({ locked, members })
      expect(result).toBeUndefined()
    })

    it('should return undefined for undefined locked', () => {
      const members = {
        effect: createLockedMember(),
      }
      const result = matchLockedInputToMember({ locked: undefined, members })
      expect(result).toBeUndefined()
    })
  })

  describe('needsRevUpdate', () => {
    it('should return true when revs differ', () => {
      const locked = {
        type: 'github',
        owner: 'effect-ts',
        repo: 'effect',
        rev: 'old-rev',
      }
      const member = createLockedMember({ commit: 'new-rev' })
      expect(needsRevUpdate({ locked, member })).toBe(true)
    })

    it('should return false when revs match', () => {
      const locked = {
        type: 'github',
        owner: 'effect-ts',
        repo: 'effect',
        rev: 'same-rev',
      }
      const member = createLockedMember({ commit: 'same-rev' })
      expect(needsRevUpdate({ locked, member })).toBe(false)
    })

    it('should return false when locked has no rev', () => {
      const locked = {
        type: 'path',
        path: '/some/path',
      }
      const member = createLockedMember()
      expect(needsRevUpdate({ locked, member })).toBe(false)
    })

    it('should return false for undefined locked', () => {
      const member = createLockedMember()
      expect(needsRevUpdate({ locked: undefined, member })).toBe(false)
    })
  })
})

// =============================================================================
// Full Sync Flow Tests (Order Preservation)
// =============================================================================

describe('nix-lock full sync flow', () => {
  describe('key order preservation', () => {
    it('should preserve Nix natural node order (inputs, locked, original)', () => {
      // This is the natural order Nix generates
      const lockFile = JSON.stringify(
        {
          nodes: {
            'effect-utils': {
              inputs: { nixpkgs: ['nixpkgs'] },
              locked: {
                lastModified: 1704067200,
                narHash: 'sha256-abc',
                owner: 'owner',
                repo: 'effect-utils',
                rev: 'old-rev',
                type: 'github',
              },
              original: { owner: 'owner', repo: 'effect-utils', type: 'github' },
            },
            root: { inputs: { 'effect-utils': 'effect-utils' } },
          },
          root: 'root',
          version: 7,
        },
        null,
        2,
      )

      const members = {
        'effect-utils': createLockedMember({
          url: 'https://github.com/owner/effect-utils',
          commit: 'new-rev-12345',
        }),
      }

      const result = simulateSyncFlow(lockFile, members)
      const parsed = JSON.parse(result)

      // Check that node key order is preserved
      const nodeKeys = Object.keys(parsed.nodes['effect-utils'])
      expect(nodeKeys).toEqual(['inputs', 'locked', 'original'])

      // Check that locked key order is preserved (minus removed keys)
      const lockedKeys = Object.keys(parsed.nodes['effect-utils'].locked)
      expect(lockedKeys).toEqual(['owner', 'repo', 'rev', 'type'])

      // Verify the rev was updated
      expect(parsed.nodes['effect-utils'].locked.rev).toBe('new-rev-12345')

      // Verify narHash and lastModified were removed
      expect(parsed.nodes['effect-utils'].locked.narHash).toBeUndefined()
      expect(parsed.nodes['effect-utils'].locked.lastModified).toBeUndefined()
    })

    it('should preserve node order with flake: false at start', () => {
      const lockFile = JSON.stringify(
        {
          nodes: {
            'some-input': {
              flake: false,
              locked: {
                lastModified: 1704067200,
                narHash: 'sha256-abc',
                owner: 'owner',
                repo: 'some-input',
                rev: 'old-rev',
                type: 'github',
              },
              original: { owner: 'owner', repo: 'some-input', type: 'github' },
            },
            root: { inputs: { 'some-input': 'some-input' } },
          },
          root: 'root',
          version: 7,
        },
        null,
        2,
      )

      const members = {
        'some-input': createLockedMember({
          url: 'https://github.com/owner/some-input',
          commit: 'new-rev',
        }),
      }

      const result = simulateSyncFlow(lockFile, members)
      const parsed = JSON.parse(result)

      // flake should stay at the beginning
      const nodeKeys = Object.keys(parsed.nodes['some-input'])
      expect(nodeKeys).toEqual(['flake', 'locked', 'original'])
    })

    it('should not modify unrelated nodes', () => {
      const lockFile = JSON.stringify(
        {
          nodes: {
            nixpkgs: {
              locked: {
                lastModified: 1704067200,
                narHash: 'sha256-xyz',
                owner: 'NixOS',
                repo: 'nixpkgs',
                rev: 'nixpkgs-rev',
                type: 'github',
              },
              original: { owner: 'NixOS', repo: 'nixpkgs', type: 'github' },
            },
            'effect-utils': {
              inputs: { nixpkgs: ['nixpkgs'] },
              locked: {
                owner: 'owner',
                repo: 'effect-utils',
                rev: 'old-rev',
                type: 'github',
              },
              original: { owner: 'owner', repo: 'effect-utils', type: 'github' },
            },
            root: { inputs: {} },
          },
          root: 'root',
          version: 7,
        },
        null,
        2,
      )

      const members = {
        'effect-utils': createLockedMember({
          url: 'https://github.com/owner/effect-utils',
          commit: 'new-rev',
        }),
      }

      const result = simulateSyncFlow(lockFile, members)
      const parsed = JSON.parse(result)

      // nixpkgs should be completely unchanged (including narHash/lastModified)
      expect(parsed.nodes['nixpkgs'].locked.narHash).toBe('sha256-xyz')
      expect(parsed.nodes['nixpkgs'].locked.lastModified).toBe(1704067200)
      expect(Object.keys(parsed.nodes['nixpkgs'])).toEqual(['locked', 'original'])
    })
  })
})

// =============================================================================
// Source File Rev Sync Tests
// =============================================================================

/**
 * Simulates the source file rev sync logic (pure, no Effect).
 * Mirrors the core of syncSourceFileRevs.
 */
const simulateSourceFileRevSync = ({
  content,
  fileType,
  megarepoMembers,
}: {
  content: string
  fileType: 'flake.nix' | 'devenv.yaml'
  megarepoMembers: Record<string, LockedMember>
}): {
  updatedContent: string
  updatedInputs: Array<{
    inputName: string
    memberName: string
    oldRev: string
    newRev: string
  }>
} => {
  const inputs =
    fileType === 'flake.nix' ? extractFlakeNixInputs(content) : extractDevenvYamlInputs(content)

  const updatedInputs: Array<{
    inputName: string
    memberName: string
    oldRev: string
    newRev: string
  }> = []
  let updatedContent = content

  for (const input of inputs) {
    const memberName = matchUrlToMember({ url: input.url, members: megarepoMembers })
    if (memberName === undefined) continue

    const member = megarepoMembers[memberName]
    if (member === undefined) continue

    const parsed = parseNixFlakeUrl(input.url)
    if (parsed === undefined) continue

    const currentRev = getRev(parsed)
    if (currentRev === undefined) continue
    if (currentRev === member.commit) continue

    const newUrl = updateNixFlakeUrl({ url: input.url, updates: { rev: member.commit } })

    updatedInputs.push({
      inputName: input.inputName,
      memberName,
      oldRev: currentRev,
      newRev: member.commit,
    })

    updatedContent = updatedContent.replaceAll(input.url, newUrl)
  }

  return { updatedContent, updatedInputs }
}

describe('source file rev sync', () => {
  describe('flake.nix', () => {
    it('should update &rev= in git+https URLs', () => {
      const content = `{
  inputs.effect-utils.url = "git+https://github.com/overengineeringstudio/effect-utils?ref=schickling/2026-03-08-foo&rev=51a67f704ddac6afd3a5230e696dbc440257f07d";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.05";
}`

      const members: Record<string, LockedMember> = {
        'effect-utils': createLockedMember({
          url: 'https://github.com/overengineeringstudio/effect-utils',
          commit: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
        }),
      }

      const result = simulateSourceFileRevSync({
        content,
        fileType: 'flake.nix',
        megarepoMembers: members,
      })

      expect(result.updatedInputs).toHaveLength(1)
      expect(result.updatedInputs[0]).toEqual({
        inputName: 'effect-utils',
        memberName: 'effect-utils',
        oldRev: '51a67f704ddac6afd3a5230e696dbc440257f07d',
        newRev: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
      })
      expect(result.updatedContent).toContain('&rev=aaaa1111bbbb2222cccc3333dddd4444eeee5555')
      expect(result.updatedContent).not.toContain('51a67f704ddac6afd3a5230e696dbc440257f07d')
      // nixpkgs should be unchanged
      expect(result.updatedContent).toContain('github:NixOS/nixpkgs/nixos-24.05')
    })

    it('should update ?rev= in git+ssh URLs', () => {
      const content = `{
  inputs.my-lib.url = "git+ssh://git@github.com/owner/my-lib?rev=oldrev1234567890123456789012345678901234";
}`

      const members: Record<string, LockedMember> = {
        'my-lib': createLockedMember({
          url: 'https://github.com/owner/my-lib',
          commit: 'newrev1234567890123456789012345678901234',
        }),
      }

      const result = simulateSourceFileRevSync({
        content,
        fileType: 'flake.nix',
        megarepoMembers: members,
      })

      expect(result.updatedInputs).toHaveLength(1)
      expect(result.updatedContent).toContain('?rev=newrev1234567890123456789012345678901234')
    })

    it('should skip URLs without rev', () => {
      const content = `{
  inputs.effect-utils.url = "github:overengineeringstudio/effect-utils/main";
}`

      const members: Record<string, LockedMember> = {
        'effect-utils': createLockedMember({
          url: 'https://github.com/overengineeringstudio/effect-utils',
          commit: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
        }),
      }

      const result = simulateSourceFileRevSync({
        content,
        fileType: 'flake.nix',
        megarepoMembers: members,
      })

      expect(result.updatedInputs).toHaveLength(0)
      expect(result.updatedContent).toBe(content)
    })

    it('should skip when rev already matches', () => {
      const content = `{
  inputs.effect-utils.url = "git+https://github.com/owner/effect-utils?ref=main&rev=aaaa1111bbbb2222cccc3333dddd4444eeee5555";
}`

      const members: Record<string, LockedMember> = {
        'effect-utils': createLockedMember({
          url: 'https://github.com/owner/effect-utils',
          commit: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
        }),
      }

      const result = simulateSourceFileRevSync({
        content,
        fileType: 'flake.nix',
        megarepoMembers: members,
      })

      expect(result.updatedInputs).toHaveLength(0)
      expect(result.updatedContent).toBe(content)
    })

    it('should update multiple inputs in one file', () => {
      const content = `{
  inputs.lib-a.url = "git+https://github.com/owner/lib-a?ref=main&rev=old_a_rev_01234567890123456789012345678";
  inputs.lib-b.url = "git+https://github.com/owner/lib-b?ref=dev&rev=old_b_rev_01234567890123456789012345678";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.05";
}`

      const members: Record<string, LockedMember> = {
        'lib-a': createLockedMember({
          url: 'https://github.com/owner/lib-a',
          commit: 'new_a_rev_01234567890123456789012345678',
        }),
        'lib-b': createLockedMember({
          url: 'https://github.com/owner/lib-b',
          commit: 'new_b_rev_01234567890123456789012345678',
        }),
      }

      const result = simulateSourceFileRevSync({
        content,
        fileType: 'flake.nix',
        megarepoMembers: members,
      })

      expect(result.updatedInputs).toHaveLength(2)
      expect(result.updatedContent).toContain('&rev=new_a_rev_01234567890123456789012345678')
      expect(result.updatedContent).toContain('&rev=new_b_rev_01234567890123456789012345678')
      expect(result.updatedContent).not.toContain('old_a_rev')
      expect(result.updatedContent).not.toContain('old_b_rev')
    })

    it('should skip inputs that do not match any megarepo member', () => {
      const content = `{
  inputs.unknown-lib.url = "git+https://github.com/someone/unknown-lib?rev=abc123def456789012345678901234567890abcd";
}`

      const members: Record<string, LockedMember> = {
        'my-lib': createLockedMember({
          url: 'https://github.com/owner/my-lib',
          commit: 'new-commit',
        }),
      }

      const result = simulateSourceFileRevSync({
        content,
        fileType: 'flake.nix',
        megarepoMembers: members,
      })

      expect(result.updatedInputs).toHaveLength(0)
      expect(result.updatedContent).toBe(content)
    })

    it('should preserve ref and other params when updating rev', () => {
      const content = `{
  inputs.effect-utils.url = "git+https://github.com/owner/effect-utils?ref=schickling/branch&rev=oldrev12345678901234567890123456789012&dir=packages/core";
}`

      const members: Record<string, LockedMember> = {
        'effect-utils': createLockedMember({
          url: 'https://github.com/owner/effect-utils',
          commit: 'newrev12345678901234567890123456789012',
        }),
      }

      const result = simulateSourceFileRevSync({
        content,
        fileType: 'flake.nix',
        megarepoMembers: members,
      })

      expect(result.updatedInputs).toHaveLength(1)
      expect(result.updatedContent).toContain('ref=schickling/branch')
      expect(result.updatedContent).toContain('rev=newrev12345678901234567890123456789012')
      expect(result.updatedContent).toContain('dir=packages/core')
    })
  })

  describe('devenv.yaml', () => {
    it('should update &rev= in devenv.yaml URLs', () => {
      const content = `inputs:
  effect-utils:
    url: git+https://github.com/overengineeringstudio/effect-utils?ref=schickling/2026-03-08-foo&rev=51a67f704ddac6afd3a5230e696dbc440257f07d
    flake: true
  nixpkgs:
    url: github:NixOS/nixpkgs/nixos-24.05
`

      const members: Record<string, LockedMember> = {
        'effect-utils': createLockedMember({
          url: 'https://github.com/overengineeringstudio/effect-utils',
          commit: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
        }),
      }

      const result = simulateSourceFileRevSync({
        content,
        fileType: 'devenv.yaml',
        megarepoMembers: members,
      })

      expect(result.updatedInputs).toHaveLength(1)
      expect(result.updatedInputs[0]).toEqual({
        inputName: 'effect-utils',
        memberName: 'effect-utils',
        oldRev: '51a67f704ddac6afd3a5230e696dbc440257f07d',
        newRev: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
      })
      expect(result.updatedContent).toContain('&rev=aaaa1111bbbb2222cccc3333dddd4444eeee5555')
      expect(result.updatedContent).not.toContain('51a67f704ddac6afd3a5230e696dbc440257f07d')
      // nixpkgs should be unchanged
      expect(result.updatedContent).toContain('github:NixOS/nixpkgs/nixos-24.05')
    })

    it('should skip devenv.yaml URLs without rev', () => {
      const content = `inputs:
  effect-utils:
    url: github:overengineeringstudio/effect-utils/main
    flake: true
`

      const members: Record<string, LockedMember> = {
        'effect-utils': createLockedMember({
          url: 'https://github.com/overengineeringstudio/effect-utils',
          commit: 'new-commit',
        }),
      }

      const result = simulateSourceFileRevSync({
        content,
        fileType: 'devenv.yaml',
        megarepoMembers: members,
      })

      expect(result.updatedInputs).toHaveLength(0)
      expect(result.updatedContent).toBe(content)
    })

    it('should handle quoted URLs in devenv.yaml', () => {
      const content = `inputs:
  effect-utils:
    url: "git+https://github.com/owner/effect-utils?ref=main&rev=oldrev12345678901234567890123456789012"
`

      const members: Record<string, LockedMember> = {
        'effect-utils': createLockedMember({
          url: 'https://github.com/owner/effect-utils',
          commit: 'newrev12345678901234567890123456789012',
        }),
      }

      const result = simulateSourceFileRevSync({
        content,
        fileType: 'devenv.yaml',
        megarepoMembers: members,
      })

      expect(result.updatedInputs).toHaveLength(1)
      expect(result.updatedContent).toContain('rev=newrev12345678901234567890123456789012')
    })
  })
})

// =============================================================================
// Shared Input Source Sync Tests (original-matching)
// =============================================================================

describe('shared input source sync logic', () => {
  /**
   * Deep structural equality check (mirrors the implementation).
   */
  const deepEqual = (a: unknown, b: unknown): boolean => {
    if (a === b) return true
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
    const aObj = a as Record<string, unknown>
    const bObj = b as Record<string, unknown>
    const aKeys = Object.keys(aObj)
    if (aKeys.length !== Object.keys(bObj).length) return false
    return aKeys.every((k) => deepEqual(aObj[k], bObj[k]))
  }

  /**
   * Simulates the shared input source sync for a set of devenv.lock contents.
   * Pure function that mirrors the core logic without filesystem effects.
   * Only propagates top-level declared inputs (from root.inputs).
   */
  type SimResult =
    | { _tag: 'error'; message: string }
    | {
        sourceMember: string
        propagatableInputs: number
        updatedMembers: Array<{ name: string; updatedInputs: string[] }>
      }

  type SuccessResult = Exclude<SimResult, { _tag: 'error' }>

  const assertSuccess = (result: SimResult): SuccessResult => {
    if ('_tag' in result) {
      throw new Error(`Expected success but got error: ${JSON.stringify(result)}`)
    }
    return result
  }

  const simulateSharedInputSourceSync = ({
    sourceMemberName,
    memberLocks,
    excludeMembers = new Set<string>(),
  }: {
    sourceMemberName: string
    memberLocks: Record<string, string>
    excludeMembers?: ReadonlySet<string>
  }): {
    updatedLocks: Record<string, string>
    result: SimResult
  } => {
    const updatedLocks: Record<string, string> = { ...memberLocks }

    const sourceContent = memberLocks[sourceMemberName]
    if (sourceContent === undefined) {
      return {
        updatedLocks,
        result: {
          _tag: 'error',
          message: `Source member '${sourceMemberName}' has no devenv.lock`,
        },
      }
    }

    let sourceJson: Record<string, unknown>
    try {
      sourceJson = JSON.parse(sourceContent) as Record<string, unknown>
    } catch {
      return {
        updatedLocks,
        result: {
          _tag: 'error',
          message: `Source member '${sourceMemberName}' has invalid devenv.lock (not valid JSON)`,
        },
      }
    }

    const sourceNodes = sourceJson['nodes'] as Record<string, Record<string, unknown>> | undefined
    if (sourceNodes === undefined) {
      return {
        updatedLocks,
        result: {
          _tag: 'error',
          message: `Source member '${sourceMemberName}' devenv.lock has no nodes`,
        },
      }
    }

    const rootNode = sourceNodes['root']
    if (rootNode === undefined) {
      return {
        updatedLocks,
        result: {
          _tag: 'error',
          message: `Source member '${sourceMemberName}' devenv.lock has no root node`,
        },
      }
    }

    const rootInputs = rootNode['inputs'] as Record<string, string> | undefined
    if (rootInputs === undefined) {
      return {
        updatedLocks,
        result: {
          _tag: 'error',
          message: `Source member '${sourceMemberName}' devenv.lock root node has no inputs`,
        },
      }
    }

    /** Only consider top-level declared inputs */
    const sourceMap = new Map<string, { locked: unknown; original: unknown }>()
    for (const [inputName, nodeName] of Object.entries(rootInputs)) {
      const node = sourceNodes[nodeName]
      if (node === undefined) continue
      if (node['original'] !== undefined && node['locked'] !== undefined) {
        sourceMap.set(inputName, { locked: node['locked'], original: node['original'] })
      }
    }

    const updatedMembers: Array<{ name: string; updatedInputs: string[] }> = []

    for (const memberName of Object.keys(memberLocks)) {
      if (memberName === sourceMemberName) continue
      if (excludeMembers.has(memberName) === true) continue

      const content = memberLocks[memberName]
      if (content === undefined) continue

      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(content) as Record<string, unknown>
      } catch {
        continue
      }

      const targetNodes = parsed['nodes'] as Record<string, Record<string, unknown>> | undefined
      if (targetNodes === undefined) continue

      const targetRoot = targetNodes['root']
      if (targetRoot === undefined) continue
      const targetRootInputs = targetRoot['inputs'] as Record<string, string> | undefined
      if (targetRootInputs === undefined) continue

      const updatedInputs: string[] = []
      for (const [inputName, targetNodeName] of Object.entries(targetRootInputs)) {
        const targetNode = targetNodes[targetNodeName]
        if (targetNode === undefined) continue
        if (targetNode['original'] === undefined || targetNode['locked'] === undefined) continue

        const sourceEntry = sourceMap.get(inputName)
        if (sourceEntry === undefined) continue
        if (deepEqual(sourceEntry.original, targetNode['original']) === false) continue
        if (deepEqual(sourceEntry.locked, targetNode['locked']) === true) continue

        targetNode['locked'] = sourceEntry.locked
        updatedInputs.push(inputName)
      }

      if (updatedInputs.length > 0) {
        updatedLocks[memberName] = JSON.stringify(parsed, null, 2) + '\n'
        updatedMembers.push({ name: memberName, updatedInputs })
      }
    }

    return {
      updatedLocks,
      result: {
        sourceMember: sourceMemberName,
        propagatableInputs: sourceMap.size,
        updatedMembers,
      },
    }
  }

  const makeDevenvLock = (
    nodes: Record<string, { original?: unknown; locked?: unknown; [k: string]: unknown }>,
  ): string =>
    JSON.stringify(
      {
        nodes: {
          root: { inputs: Object.fromEntries(Object.keys(nodes).map((k) => [k, k])) },
          ...nodes,
        },
        root: 'root',
        version: 7,
      },
      null,
      2,
    )

  it('should propagate locked sections for matching originals', () => {
    const sourceLock = makeDevenvLock({
      nixpkgs: {
        original: { type: 'github', owner: 'NixOS', repo: 'nixpkgs', ref: 'nixos-unstable' },
        locked: { type: 'github', owner: 'NixOS', repo: 'nixpkgs', rev: 'source-rev-111' },
      },
    })
    const targetLock = makeDevenvLock({
      nixpkgs: {
        original: { type: 'github', owner: 'NixOS', repo: 'nixpkgs', ref: 'nixos-unstable' },
        locked: { type: 'github', owner: 'NixOS', repo: 'nixpkgs', rev: 'old-rev-999' },
      },
    })

    const { result: rawResult, updatedLocks } = simulateSharedInputSourceSync({
      sourceMemberName: 'repo-a',
      memberLocks: { 'repo-a': sourceLock, 'repo-b': targetLock },
    })
    const result = assertSuccess(rawResult)

    expect(result.propagatableInputs).toBe(1)
    expect(result.updatedMembers).toHaveLength(1)
    expect(result.updatedMembers[0]!.name).toBe('repo-b')
    expect(result.updatedMembers[0]!.updatedInputs).toEqual(['nixpkgs'])
    const updatedTarget = JSON.parse(updatedLocks['repo-b']!)
    expect(updatedTarget.nodes.nixpkgs.locked.rev).toBe('source-rev-111')
  })

  it('should skip nodes with different originals', () => {
    const sourceLock = makeDevenvLock({
      nixpkgs: {
        original: { type: 'github', owner: 'NixOS', repo: 'nixpkgs', ref: 'nixos-unstable' },
        locked: { type: 'github', owner: 'NixOS', repo: 'nixpkgs', rev: 'source-rev' },
      },
    })
    const targetLock = makeDevenvLock({
      nixpkgs: {
        original: { type: 'github', owner: 'NixOS', repo: 'nixpkgs', ref: 'nixos-24.05' },
        locked: { type: 'github', owner: 'NixOS', repo: 'nixpkgs', rev: 'target-rev' },
      },
    })

    const { result: rawResult } = simulateSharedInputSourceSync({
      sourceMemberName: 'repo-a',
      memberLocks: { 'repo-a': sourceLock, 'repo-b': targetLock },
    })
    const result = assertSuccess(rawResult)

    expect(result.updatedMembers).toHaveLength(0)
  })

  it('should skip nodes that are already in sync', () => {
    const lock = makeDevenvLock({
      nixpkgs: {
        original: { type: 'github', owner: 'NixOS', repo: 'nixpkgs', ref: 'nixos-unstable' },
        locked: { type: 'github', owner: 'NixOS', repo: 'nixpkgs', rev: 'same-rev' },
      },
    })

    const { result: rawResult } = simulateSharedInputSourceSync({
      sourceMemberName: 'repo-a',
      memberLocks: { 'repo-a': lock, 'repo-b': lock },
    })
    const result = assertSuccess(rawResult)

    expect(result.updatedMembers).toHaveLength(0)
  })

  it('should respect excludeMembers', () => {
    const sourceLock = makeDevenvLock({
      nixpkgs: {
        original: { type: 'github', owner: 'NixOS', repo: 'nixpkgs', ref: 'nixos-unstable' },
        locked: { type: 'github', owner: 'NixOS', repo: 'nixpkgs', rev: 'source-rev' },
      },
    })
    const targetLock = makeDevenvLock({
      nixpkgs: {
        original: { type: 'github', owner: 'NixOS', repo: 'nixpkgs', ref: 'nixos-unstable' },
        locked: { type: 'github', owner: 'NixOS', repo: 'nixpkgs', rev: 'old-rev' },
      },
    })

    const { result: rawResult } = simulateSharedInputSourceSync({
      sourceMemberName: 'repo-a',
      memberLocks: { 'repo-a': sourceLock, 'repo-b': targetLock },
      excludeMembers: new Set(['repo-b']),
    })
    const result = assertSuccess(rawResult)

    expect(result.updatedMembers).toHaveLength(0)
  })

  it('should propagate multiple inputs to multiple members', () => {
    const sourceLock = makeDevenvLock({
      nixpkgs: {
        original: { type: 'github', owner: 'NixOS', repo: 'nixpkgs', ref: 'nixos-unstable' },
        locked: { type: 'github', owner: 'NixOS', repo: 'nixpkgs', rev: 'new-nixpkgs-rev' },
      },
      devenv: {
        original: { type: 'github', owner: 'cachix', repo: 'devenv' },
        locked: { type: 'github', owner: 'cachix', repo: 'devenv', rev: 'new-devenv-rev' },
      },
    })
    const targetLockB = makeDevenvLock({
      nixpkgs: {
        original: { type: 'github', owner: 'NixOS', repo: 'nixpkgs', ref: 'nixos-unstable' },
        locked: { type: 'github', owner: 'NixOS', repo: 'nixpkgs', rev: 'old-nixpkgs' },
      },
      devenv: {
        original: { type: 'github', owner: 'cachix', repo: 'devenv' },
        locked: { type: 'github', owner: 'cachix', repo: 'devenv', rev: 'old-devenv' },
      },
    })
    const targetLockC = makeDevenvLock({
      nixpkgs: {
        original: { type: 'github', owner: 'NixOS', repo: 'nixpkgs', ref: 'nixos-unstable' },
        locked: { type: 'github', owner: 'NixOS', repo: 'nixpkgs', rev: 'old-nixpkgs-c' },
      },
    })

    const { result: rawResult, updatedLocks } = simulateSharedInputSourceSync({
      sourceMemberName: 'repo-a',
      memberLocks: { 'repo-a': sourceLock, 'repo-b': targetLockB, 'repo-c': targetLockC },
    })
    const result = assertSuccess(rawResult)

    expect(result.propagatableInputs).toBe(2)
    expect(result.updatedMembers).toHaveLength(2)
    expect(result.updatedMembers[0]!.updatedInputs).toEqual(['nixpkgs', 'devenv'])
    expect(result.updatedMembers[1]!.updatedInputs).toEqual(['nixpkgs'])
    expect(JSON.parse(updatedLocks['repo-b']!).nodes.nixpkgs.locked.rev).toBe('new-nixpkgs-rev')
    expect(JSON.parse(updatedLocks['repo-b']!).nodes.devenv.locked.rev).toBe('new-devenv-rev')
    expect(JSON.parse(updatedLocks['repo-c']!).nodes.nixpkgs.locked.rev).toBe('new-nixpkgs-rev')
  })

  it('should skip transitive (non-root) nodes even if original matches', () => {
    /** Source has nixpkgs as root input and nixpkgs_2 as a transitive dependency */
    const sourceLock = JSON.stringify(
      {
        nodes: {
          root: { inputs: { nixpkgs: 'nixpkgs' } },
          nixpkgs: {
            original: { type: 'github', owner: 'NixOS', repo: 'nixpkgs', ref: 'nixos-unstable' },
            locked: { type: 'github', owner: 'NixOS', repo: 'nixpkgs', rev: 'source-rev' },
          },
          nixpkgs_2: {
            original: { type: 'github', owner: 'NixOS', repo: 'nixpkgs', ref: 'nixos-24.05' },
            locked: { type: 'github', owner: 'NixOS', repo: 'nixpkgs', rev: 'transitive-rev' },
          },
        },
        root: 'root',
        version: 7,
      },
      null,
      2,
    )
    /** Target has nixpkgs as root input and also nixpkgs_2 as a root input */
    const targetLock = JSON.stringify(
      {
        nodes: {
          root: { inputs: { nixpkgs: 'nixpkgs', nixpkgs_2: 'nixpkgs_2' } },
          nixpkgs: {
            original: { type: 'github', owner: 'NixOS', repo: 'nixpkgs', ref: 'nixos-unstable' },
            locked: { type: 'github', owner: 'NixOS', repo: 'nixpkgs', rev: 'old-rev' },
          },
          nixpkgs_2: {
            original: { type: 'github', owner: 'NixOS', repo: 'nixpkgs', ref: 'nixos-24.05' },
            locked: { type: 'github', owner: 'NixOS', repo: 'nixpkgs', rev: 'old-transitive' },
          },
        },
        root: 'root',
        version: 7,
      },
      null,
      2,
    )

    const { result: rawResult, updatedLocks } = simulateSharedInputSourceSync({
      sourceMemberName: 'repo-a',
      memberLocks: { 'repo-a': sourceLock, 'repo-b': targetLock },
    })
    const result = assertSuccess(rawResult)

    /** Only nixpkgs (root input in source) should be propagated, not nixpkgs_2 (transitive in source) */
    expect(result.propagatableInputs).toBe(1)
    expect(result.updatedMembers).toHaveLength(1)
    expect(result.updatedMembers[0]!.updatedInputs).toEqual(['nixpkgs'])
    const updatedTarget = JSON.parse(updatedLocks['repo-b']!)
    expect(updatedTarget.nodes.nixpkgs.locked.rev).toBe('source-rev')
    /** nixpkgs_2 should remain unchanged since it's not a root input in the source */
    expect(updatedTarget.nodes.nixpkgs_2.locked.rev).toBe('old-transitive')
  })

  it('should error when source member has no devenv.lock', () => {
    const targetLock = makeDevenvLock({
      nixpkgs: {
        original: { type: 'github', owner: 'NixOS', repo: 'nixpkgs' },
        locked: { rev: 'old' },
      },
    })

    const { result } = simulateSharedInputSourceSync({
      sourceMemberName: 'nonexistent',
      memberLocks: { 'repo-b': targetLock },
    })

    expect(result).toEqual({ _tag: 'error', message: expect.stringContaining('no devenv.lock') })
  })

  it('should error when source devenv.lock is invalid JSON', () => {
    const { result } = simulateSharedInputSourceSync({
      sourceMemberName: 'repo-a',
      memberLocks: { 'repo-a': 'not valid json {{{', 'repo-b': makeDevenvLock({}) },
    })

    expect(result).toEqual({ _tag: 'error', message: expect.stringContaining('not valid JSON') })
  })

  it('should error when source devenv.lock has no nodes', () => {
    const { result } = simulateSharedInputSourceSync({
      sourceMemberName: 'repo-a',
      memberLocks: { 'repo-a': JSON.stringify({ root: 'root', version: 7 }) },
    })

    expect(result).toEqual({ _tag: 'error', message: expect.stringContaining('no nodes') })
  })

  it('should error when source devenv.lock has no root node', () => {
    const { result } = simulateSharedInputSourceSync({
      sourceMemberName: 'repo-a',
      memberLocks: {
        'repo-a': JSON.stringify({ nodes: { nixpkgs: {} }, root: 'root', version: 7 }),
      },
    })

    expect(result).toEqual({ _tag: 'error', message: expect.stringContaining('no root node') })
  })

  it('should error when source devenv.lock root has no inputs', () => {
    const { result } = simulateSharedInputSourceSync({
      sourceMemberName: 'repo-a',
      memberLocks: { 'repo-a': JSON.stringify({ nodes: { root: {} }, root: 'root', version: 7 }) },
    })

    expect(result).toEqual({ _tag: 'error', message: expect.stringContaining('no inputs') })
  })

  it('should skip nodes without both original and locked', () => {
    const sourceLock = makeDevenvLock({
      nixpkgs: {
        original: { type: 'github', owner: 'NixOS', repo: 'nixpkgs', ref: 'nixos-unstable' },
        locked: { type: 'github', owner: 'NixOS', repo: 'nixpkgs', rev: 'source-rev' },
      },
    })
    const targetLock = makeDevenvLock({
      nixpkgs: {
        original: { type: 'github', owner: 'NixOS', repo: 'nixpkgs', ref: 'nixos-unstable' },
      },
    })

    const { result: rawResult } = simulateSharedInputSourceSync({
      sourceMemberName: 'repo-a',
      memberLocks: { 'repo-a': sourceLock, 'repo-b': targetLock },
    })
    const result = assertSuccess(rawResult)

    expect(result.updatedMembers).toHaveLength(0)
  })
})

// =============================================================================
// Ref Sync Tests
// =============================================================================

/**
 * Simulates the ref sync logic for source files (pure, no Effect).
 * Mirrors the core of syncMemberRefs for flake.nix/devenv.yaml.
 */
const simulateSourceFileRefSync = ({
  content,
  fileType,
  megarepoMembers,
}: {
  content: string
  fileType: 'flake.nix' | 'devenv.yaml'
  megarepoMembers: Record<string, LockedMember>
}): {
  updatedContent: string
  updatedInputs: Array<{
    inputName: string
    memberName: string
    oldRef: string
    newRef: string
  }>
} => {
  const inputs =
    fileType === 'flake.nix' ? extractFlakeNixInputs(content) : extractDevenvYamlInputs(content)

  const updates = new Map<string, SourceUrlUpdate>()
  const updatedInputs: Array<{
    inputName: string
    memberName: string
    oldRef: string
    newRef: string
  }> = []

  for (const input of inputs) {
    const memberName = matchUrlToMember({ url: input.url, members: megarepoMembers })
    if (memberName === undefined) continue

    const member = megarepoMembers[memberName]
    if (member === undefined) continue

    const parsed = parseNixFlakeUrl(input.url)
    if (parsed === undefined) continue

    const currentRef = getRef(parsed)
    if (currentRef === undefined) continue
    if (currentRef === member.ref) continue

    updates.set(input.inputName, { memberName, newRef: member.ref })
    updatedInputs.push({
      inputName: input.inputName,
      memberName,
      oldRef: currentRef,
      newRef: member.ref,
    })
  }

  if (updates.size === 0) return { updatedContent: content, updatedInputs }

  const rewriter = fileType === 'flake.nix' ? rewriteFlakeNixUrls : rewriteDevenvYamlUrls
  const result = rewriter({ content, updates })

  return { updatedContent: result.content, updatedInputs }
}

/**
 * Simulates the ref sync logic for lock files (pure, no Effect).
 * Mirrors the core of syncMemberRefs for flake.lock/devenv.lock.
 */
const simulateLockFileRefSync = ({
  content,
  megarepoMembers,
}: {
  content: string
  megarepoMembers: Record<string, LockedMember>
}): {
  updatedContent: string
  updatedNodes: Array<{
    inputName: string
    memberName: string
    oldRef: string
    newRef: string
  }>
} => {
  const inputs = extractLockFileInputs(content)

  let parsed: { nodes?: Record<string, Record<string, unknown>> }
  try {
    parsed = JSON.parse(content) as { nodes?: Record<string, Record<string, unknown>> }
  } catch {
    return { updatedContent: content, updatedNodes: [] }
  }

  const refUpdates = new Map<string, string>()
  const updatedNodes: Array<{
    inputName: string
    memberName: string
    oldRef: string
    newRef: string
  }> = []

  for (const input of inputs) {
    const memberName = matchUrlToMember({ url: input.url, members: megarepoMembers })
    if (memberName === undefined) continue

    const member = megarepoMembers[memberName]
    if (member === undefined) continue

    const node = parsed.nodes?.[input.inputName]
    if (node === undefined) continue

    const original = node['original'] as Record<string, unknown> | undefined
    if (original === undefined) continue

    const currentRef = typeof original['ref'] === 'string' ? original['ref'] : undefined
    if (currentRef === undefined) continue
    if (currentRef === member.ref) continue

    refUpdates.set(input.inputName, member.ref)
    updatedNodes.push({
      inputName: input.inputName,
      memberName,
      oldRef: currentRef,
      newRef: member.ref,
    })
  }

  if (refUpdates.size === 0) return { updatedContent: content, updatedNodes }

  const result = rewriteLockFileRefs({ content, refUpdates })
  return { updatedContent: result.content, updatedNodes }
}

describe('ref sync', () => {
  const megarepoMembers: Record<string, LockedMember> = {
    'effect-utils': createLockedMember({
      url: 'https://github.com/overengineeringstudio/effect-utils',
      ref: 'schickling/2026-03-12-pnpm-refactor',
      commit: 'abc123def456789012345678901234567890abcd',
    }),
    playwright: createLockedMember({
      url: 'https://github.com/nicknisi/playwright-nix',
      ref: 'feature/new-branch',
      commit: 'def456789012345678901234567890abcdef1234',
    }),
  }

  describe('flake.nix ref sync', () => {
    it('should update refs for all matched inputs', () => {
      const content = `{
  inputs = {
    effect-utils.url = "github:overengineeringstudio/effect-utils/main";
    playwright.url = "git+https://github.com/nicknisi/playwright-nix?ref=old-branch";
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };
}`
      const result = simulateSourceFileRefSync({
        content,
        fileType: 'flake.nix',
        megarepoMembers,
      })

      expect(result.updatedInputs).toHaveLength(2)
      expect(result.updatedContent).toContain(
        'effect-utils.url = "github:overengineeringstudio/effect-utils/schickling/2026-03-12-pnpm-refactor"',
      )
      expect(result.updatedContent).toContain(
        'playwright.url = "git+https://github.com/nicknisi/playwright-nix?ref=feature/new-branch"',
      )
      expect(result.updatedContent).toContain('nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable"')
    })

    it('should not add ref to bare URL (no current ref)', () => {
      const content = `{
  inputs = {
    effect-utils.url = "github:overengineeringstudio/effect-utils";
  };
}`
      const result = simulateSourceFileRefSync({
        content,
        fileType: 'flake.nix',
        megarepoMembers,
      })

      expect(result.updatedInputs).toHaveLength(0)
      expect(result.updatedContent).toBe(content)
    })

    it('should handle multiple inputs pointing at same member with ?dir=', () => {
      const content = `{
  inputs = {
    effect-utils.url = "github:overengineeringstudio/effect-utils/main";
    effect-utils-sub.url = "github:overengineeringstudio/effect-utils/main?dir=packages/sub";
  };
}`
      const result = simulateSourceFileRefSync({
        content,
        fileType: 'flake.nix',
        megarepoMembers,
      })

      expect(result.updatedInputs).toHaveLength(2)
      expect(result.updatedContent).toContain(
        'effect-utils.url = "github:overengineeringstudio/effect-utils/schickling/2026-03-12-pnpm-refactor"',
      )
      expect(result.updatedContent).toContain(
        'effect-utils-sub.url = "github:overengineeringstudio/effect-utils/schickling/2026-03-12-pnpm-refactor?dir=packages/sub"',
      )
    })

    it('should be no-op when ref already matches', () => {
      const content = `{
  inputs = {
    effect-utils.url = "github:overengineeringstudio/effect-utils/schickling/2026-03-12-pnpm-refactor";
  };
}`
      const result = simulateSourceFileRefSync({
        content,
        fileType: 'flake.nix',
        megarepoMembers,
      })

      expect(result.updatedInputs).toHaveLength(0)
      expect(result.updatedContent).toBe(content)
    })
  })

  describe('devenv.yaml ref sync', () => {
    it('should update refs in devenv.yaml', () => {
      const content = `inputs:
  effect-utils:
    url: github:overengineeringstudio/effect-utils/main
    flake: true
  playwright:
    url: "git+https://github.com/nicknisi/playwright-nix?ref=old-branch"
  nixpkgs:
    url: github:NixOS/nixpkgs/nixos-unstable
`
      const result = simulateSourceFileRefSync({
        content,
        fileType: 'devenv.yaml',
        megarepoMembers,
      })

      expect(result.updatedInputs).toHaveLength(2)
      expect(result.updatedContent).toContain(
        '    url: github:overengineeringstudio/effect-utils/schickling/2026-03-12-pnpm-refactor',
      )
      expect(result.updatedContent).toContain(
        '    url: "git+https://github.com/nicknisi/playwright-nix?ref=feature/new-branch"',
      )
      expect(result.updatedContent).toContain('    url: github:NixOS/nixpkgs/nixos-unstable')
    })

    it('should not add ref to bare URL', () => {
      const content = `inputs:
  effect-utils:
    url: github:overengineeringstudio/effect-utils
`
      const result = simulateSourceFileRefSync({
        content,
        fileType: 'devenv.yaml',
        megarepoMembers,
      })

      expect(result.updatedInputs).toHaveLength(0)
      expect(result.updatedContent).toBe(content)
    })
  })

  describe('lock file ref sync', () => {
    const lockContent =
      JSON.stringify(
        {
          nodes: {
            root: {
              inputs: {
                'effect-utils': 'effect-utils',
                'effect-utils-sub': 'effect-utils-sub',
                nixpkgs: 'nixpkgs',
              },
            },
            'effect-utils': {
              locked: {
                owner: 'overengineeringstudio',
                repo: 'effect-utils',
                rev: 'abc123',
                type: 'github',
              },
              original: {
                owner: 'overengineeringstudio',
                ref: 'main',
                repo: 'effect-utils',
                type: 'github',
              },
            },
            'effect-utils-sub': {
              locked: {
                owner: 'overengineeringstudio',
                repo: 'effect-utils',
                rev: 'abc123',
                type: 'github',
              },
              original: {
                dir: 'packages/sub',
                owner: 'overengineeringstudio',
                ref: 'main',
                repo: 'effect-utils',
                type: 'github',
              },
            },
            nixpkgs: {
              locked: {
                owner: 'NixOS',
                repo: 'nixpkgs',
                rev: 'def456',
                type: 'github',
              },
              original: {
                owner: 'NixOS',
                ref: 'nixos-unstable',
                repo: 'nixpkgs',
                type: 'github',
              },
            },
          },
          version: 7,
          root: 'root',
        },
        null,
        2,
      ) + '\n'

    it('should update original.ref for matched inputs', () => {
      const result = simulateLockFileRefSync({
        content: lockContent,
        megarepoMembers,
      })

      expect(result.updatedNodes).toHaveLength(2)
      expect(result.updatedNodes[0]!.inputName).toBe('effect-utils')
      expect(result.updatedNodes[0]!.oldRef).toBe('main')
      expect(result.updatedNodes[0]!.newRef).toBe('schickling/2026-03-12-pnpm-refactor')

      const parsed = JSON.parse(result.updatedContent)
      expect(parsed.nodes['effect-utils'].original.ref).toBe('schickling/2026-03-12-pnpm-refactor')
      expect(parsed.nodes['effect-utils-sub'].original.ref).toBe(
        'schickling/2026-03-12-pnpm-refactor',
      )
      expect(parsed.nodes['effect-utils-sub'].original.dir).toBe('packages/sub')
      expect(parsed.nodes.nixpkgs.original.ref).toBe('nixos-unstable')
    })

    it('should be no-op when refs already match', () => {
      const members: Record<string, LockedMember> = {
        'effect-utils': createLockedMember({
          url: 'https://github.com/overengineeringstudio/effect-utils',
          ref: 'main',
        }),
      }

      const result = simulateLockFileRefSync({
        content: lockContent,
        megarepoMembers: members,
      })

      expect(result.updatedNodes).toHaveLength(0)
      expect(result.updatedContent).toBe(lockContent)
    })

    it('should skip nodes without original.ref', () => {
      const content =
        JSON.stringify(
          {
            nodes: {
              root: { inputs: { dep: 'dep' } },
              dep: {
                locked: {
                  owner: 'overengineeringstudio',
                  repo: 'effect-utils',
                  rev: 'abc123',
                  type: 'github',
                },
                original: {
                  owner: 'overengineeringstudio',
                  repo: 'effect-utils',
                  type: 'github',
                },
              },
            },
            version: 7,
            root: 'root',
          },
          null,
          2,
        ) + '\n'

      const result = simulateLockFileRefSync({
        content,
        megarepoMembers,
      })

      expect(result.updatedNodes).toHaveLength(0)
      expect(result.updatedContent).toBe(content)
    })
  })

  describe('end-to-end ref sync across all 4 file types', () => {
    it('should update refs consistently in flake.nix, devenv.yaml, flake.lock, devenv.lock', () => {
      const members: Record<string, LockedMember> = {
        'effect-utils': createLockedMember({
          url: 'https://github.com/overengineeringstudio/effect-utils',
          ref: 'schickling/new-branch',
          commit: 'abc123def456789012345678901234567890abcd',
        }),
      }

      const flakeNix = `{
  inputs = {
    effect-utils.url = "github:overengineeringstudio/effect-utils/main";
  };
}`
      const devenvYaml = `inputs:
  effect-utils:
    url: github:overengineeringstudio/effect-utils/main
`
      const lockJson = {
        nodes: {
          root: { inputs: { 'effect-utils': 'effect-utils' } },
          'effect-utils': {
            locked: {
              owner: 'overengineeringstudio',
              repo: 'effect-utils',
              rev: 'old-rev',
              type: 'github',
            },
            original: {
              owner: 'overengineeringstudio',
              ref: 'main',
              repo: 'effect-utils',
              type: 'github',
            },
          },
        },
        version: 7,
        root: 'root',
      }
      const lockContent = JSON.stringify(lockJson, null, 2) + '\n'

      const flakeNixResult = simulateSourceFileRefSync({
        content: flakeNix,
        fileType: 'flake.nix',
        megarepoMembers: members,
      })
      const devenvYamlResult = simulateSourceFileRefSync({
        content: devenvYaml,
        fileType: 'devenv.yaml',
        megarepoMembers: members,
      })
      const flakeLockResult = simulateLockFileRefSync({
        content: lockContent,
        megarepoMembers: members,
      })
      const devenvLockResult = simulateLockFileRefSync({
        content: lockContent,
        megarepoMembers: members,
      })

      expect(flakeNixResult.updatedInputs).toHaveLength(1)
      expect(flakeNixResult.updatedContent).toContain(
        'effect-utils.url = "github:overengineeringstudio/effect-utils/schickling/new-branch"',
      )

      expect(devenvYamlResult.updatedInputs).toHaveLength(1)
      expect(devenvYamlResult.updatedContent).toContain(
        '    url: github:overengineeringstudio/effect-utils/schickling/new-branch',
      )

      expect(flakeLockResult.updatedNodes).toHaveLength(1)
      const flakeLockParsed = JSON.parse(flakeLockResult.updatedContent)
      expect(flakeLockParsed.nodes['effect-utils'].original.ref).toBe('schickling/new-branch')

      expect(devenvLockResult.updatedNodes).toHaveLength(1)
      const devenvLockParsed = JSON.parse(devenvLockResult.updatedContent)
      expect(devenvLockParsed.nodes['effect-utils'].original.ref).toBe('schickling/new-branch')
    })
  })
})
