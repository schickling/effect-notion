import * as NodePath from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { Effect, Option } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import { createComposedOwnedWorkspace } from '../composition/acquisition/owned-worktree-acquisition.ts'
import type { MegarepoConfig } from '../core/config.ts'
import type { MemberSource } from '../core/config.ts'
import * as Git from '../core/git.ts'
import type { LockFile } from '../core/lock.ts'
import { makeCanonicalTempDirectoryScoped } from '../test-utils/temp-root.ts'
import {
  validateStoreMembers,
  runPreflightChecks,
  fixStoreIssues,
  parseWorktreeRef,
  StoreHygieneError,
  type StoreIssue,
} from './store-hygiene.ts'
import type { MegarepoStore } from './store.ts'
const previousAgentPolicyBypass = process.env['AGENT_POLICY_BYPASS']
beforeAll(() => {
  process.env['AGENT_POLICY_BYPASS'] = '1'
})
afterAll(() => {
  if (previousAgentPolicyBypass === undefined) delete process.env['AGENT_POLICY_BYPASS']
  else process.env['AGENT_POLICY_BYPASS'] = previousAgentPolicyBypass
})

// =============================================================================
// Test Helpers
// =============================================================================

const makeTestStore = (basePath: AbsoluteDirPath): MegarepoStore => ({
  basePath,
  getRepoBasePath: (source) => {
    if (source.type === 'github') {
      return EffectPath.unsafe.absoluteDir(`${basePath}github.com/${source.owner}/${source.repo}/`)
    }
    return EffectPath.unsafe.absoluteDir(`${basePath}other/`)
  },
  getBareRepoPath: (source) => {
    if (source.type === 'github') {
      return EffectPath.unsafe.absoluteDir(
        `${basePath}github.com/${source.owner}/${source.repo}/.bare/`,
      )
    }
    return EffectPath.unsafe.absoluteDir(`${basePath}other/.bare/`)
  },
  getWorktreePath: ({ source, ref }) => {
    if (source.type === 'github') {
      return EffectPath.unsafe.absoluteDir(
        `${basePath}github.com/${source.owner}/${source.repo}/refs/heads/${ref}/`,
      )
    }
    return EffectPath.unsafe.absoluteDir(`${basePath}other/refs/heads/${ref}/`)
  },
  hasBareRepo: () => Effect.succeed(true),
  hasWorktree: () => Effect.succeed(true),
  listRepos: Effect.succeed([]),
  listWorktrees: () => Effect.succeed([]),
})

const makeTestConfig = (members: Record<string, string>): MegarepoConfig =>
  ({ members }) as MegarepoConfig

const makeTestLockFile = (members: Record<string, { ref: string; commit: string }>): LockFile =>
  ({
    version: 1,
    members: Object.fromEntries(
      Object.entries(members).map(([name, { ref, commit }]) => [
        name,
        {
          url: `https://github.com/owner/${name}`,
          ref,
          commit,
          pinned: false,
          lockedAt: new Date().toISOString(),
        },
      ]),
    ),
  }) as LockFile

const runWithContext = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)))

// =============================================================================
// Tests
// =============================================================================

describe('store-hygiene', () => {
  describe('validateStoreMembers', () => {
    it('returns empty array when no remote members', () =>
      runWithContext(
        Effect.gen(function* () {
          const store = makeTestStore(EffectPath.unsafe.absoluteDir('/tmp/test-store/'))
          const config = makeTestConfig({ local: './path/to/repo' })
          const lockFile = makeTestLockFile({})

          const issues = yield* validateStoreMembers({
            memberNames: ['local'],
            config,
            lockFile,
            store,
          })

          expect(issues).toEqual([])
        }),
      ))

    it('returns empty array when member not in lock file', () =>
      runWithContext(
        Effect.gen(function* () {
          const store = makeTestStore(EffectPath.unsafe.absoluteDir('/tmp/test-store/'))
          const config = makeTestConfig({ myrepo: 'owner/myrepo#main' })
          const lockFile = makeTestLockFile({})

          const issues = yield* validateStoreMembers({
            memberNames: ['myrepo'],
            config,
            lockFile,
            store,
          })

          expect(issues).toEqual([])
        }),
      ))

    it('reports missing_bare when bare repo does not exist', () =>
      runWithContext(
        Effect.gen(function* () {
          const store = makeTestStore(
            EffectPath.unsafe.absoluteDir('/tmp/nonexistent-test-store-xyz/'),
          )
          const config = makeTestConfig({ myrepo: 'owner/myrepo#main' })
          const lockFile = makeTestLockFile({
            myrepo: { ref: 'main', commit: 'a'.repeat(40) },
          })

          const issues = yield* validateStoreMembers({
            memberNames: ['myrepo'],
            config,
            lockFile,
            store,
          })

          expect(issues.length).toBe(1)
          expect(issues[0]!.type).toBe('missing_bare')
          expect(issues[0]!.severity).toBe('error')
          expect(issues[0]!.memberName).toBe('myrepo')
        }),
      ))

    it('skips members not in memberNames', () =>
      runWithContext(
        Effect.gen(function* () {
          const store = makeTestStore(
            EffectPath.unsafe.absoluteDir('/tmp/nonexistent-test-store-xyz/'),
          )
          const config = makeTestConfig({
            myrepo: 'owner/myrepo#main',
            other: 'owner/other#main',
          })
          const lockFile = makeTestLockFile({
            myrepo: { ref: 'main', commit: 'a'.repeat(40) },
            other: { ref: 'main', commit: 'b'.repeat(40) },
          })

          const issues = yield* validateStoreMembers({
            memberNames: ['myrepo'],
            config,
            lockFile,
            store,
          })

          expect(issues.every((i) => i.memberName === 'myrepo')).toBe(true)
        }),
      ))

    it('skips local path members', () =>
      runWithContext(
        Effect.gen(function* () {
          const store = makeTestStore(EffectPath.unsafe.absoluteDir('/tmp/test-store/'))
          const config = makeTestConfig({ local: '../some/path' })
          const lockFile = makeTestLockFile({})

          const issues = yield* validateStoreMembers({
            memberNames: ['local'],
            config,
            lockFile,
            store,
          })

          expect(issues).toEqual([])
        }),
      ))

    it('does not report ref_mismatch for tag refs (detached HEAD is expected)', () =>
      runWithContext(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const basePath = `/tmp/test-store-tag-ref-${Date.now()}/`
          const store = makeTestStore(EffectPath.unsafe.absoluteDir(basePath))
          const config = makeTestConfig({ myrepo: 'owner/myrepo#v1.0.0' })
          const lockFile = makeTestLockFile({
            myrepo: { ref: 'v1.0.0', commit: 'a'.repeat(40) },
          })

          // Create bare repo dir and .git file so validation gets past missing_bare/broken_worktree checks
          const bareRepoPath = `${basePath}github.com/owner/myrepo/.bare/`
          const worktreePath = `${basePath}github.com/owner/myrepo/refs/heads/v1.0.0/`
          yield* fs.makeDirectory(bareRepoPath, { recursive: true })
          yield* fs.makeDirectory(worktreePath, { recursive: true })
          yield* fs.writeFileString(`${worktreePath}.git`, 'gitdir: ../../../.bare')

          const issues = yield* validateStoreMembers({
            memberNames: ['myrepo'],
            config,
            lockFile,
            store,
          })

          // Should have no ref_mismatch issues — tags are expected to be detached
          const refMismatchIssues = issues.filter((i) => i.type === 'ref_mismatch')
          expect(refMismatchIssues).toEqual([])

          // Cleanup
          yield* fs.remove(`${basePath}github.com`, { recursive: true })
        }),
      ))

    it('reports missing_bare with fix suggestion and metadata', () =>
      runWithContext(
        Effect.gen(function* () {
          const store = makeTestStore(
            EffectPath.unsafe.absoluteDir('/tmp/nonexistent-test-store-xyz/'),
          )
          const config = makeTestConfig({ myrepo: 'owner/myrepo#main' })
          const lockFile = makeTestLockFile({
            myrepo: { ref: 'main', commit: 'a'.repeat(40) },
          })

          const issues = yield* validateStoreMembers({
            memberNames: ['myrepo'],
            config,
            lockFile,
            store,
          })

          expect(issues[0]!.fix).toBeDefined()
          expect(issues[0]!.meta?._tag).toBe('missing_bare')
        }),
      ))
    it('accepts a composed branch whose registered worktree is nested at P/repos/owned', () =>
      runWithContext(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const tmp = yield* makeCanonicalTempDirectoryScoped()
          const sourcePath = NodePath.join(tmp, 'source')
          const basePath = EffectPath.unsafe.absoluteDir(`${NodePath.join(tmp, 'store')}/`)
          const store = makeTestStore(basePath)
          const source: MemberSource = {
            type: 'github',
            owner: 'owner',
            repo: 'myrepo',
            ref: Option.some('feature'),
          }
          const bareRepoPath = store.getBareRepoPath(source)
          const workspaceRoot = store.getWorktreePath({ source, ref: 'feature' })

          yield* fs.makeDirectory(EffectPath.unsafe.absoluteDir(`${sourcePath}/`), {
            recursive: true,
          })
          yield* Git.runCommand({ cwd: sourcePath, args: ['init', '-b', 'main'] })
          yield* fs.writeFileString(
            EffectPath.unsafe.absoluteFile(NodePath.join(sourcePath, 'megarepo.kdl')),
            'members {}\n',
          )
          yield* Git.runCommand({
            cwd: sourcePath,
            args: ['-c', 'user.name=Test User', '-c', 'user.email=test@example.com', 'add', '-A'],
          })
          yield* Git.runCommand({
            cwd: sourcePath,
            args: [
              '-c',
              'user.name=Test User',
              '-c',
              'user.email=test@example.com',
              'commit',
              '--no-gpg-sign',
              '--no-verify',
              '-m',
              'base',
            ],
          })
          yield* fs.makeDirectory(
            EffectPath.unsafe.absoluteDir(`${NodePath.dirname(bareRepoPath)}/`),
            { recursive: true },
          )
          yield* Git.runCommand({
            cwd: tmp,
            args: ['clone', '--bare', sourcePath, bareRepoPath],
          })
          const commit = yield* Git.getCurrentCommit(sourcePath)
          yield* createComposedOwnedWorkspace({
            bareRepo: bareRepoPath,
            workspaceRoot,
            ownedMember: 'myrepo',
            branch: 'feature',
            startPoint: 'main',
            generate: () => Effect.void,
          })

          const issues = yield* validateStoreMembers({
            memberNames: ['myrepo'],
            config: makeTestConfig({ myrepo: 'owner/myrepo#feature' }),
            lockFile: makeTestLockFile({ myrepo: { ref: 'feature', commit } }),
            store,
          })

          expect(issues.filter((issue) => issue.type === 'broken_worktree')).toEqual([])

          yield* fs.writeFileString(
            EffectPath.unsafe.absoluteFile(NodePath.join(workspaceRoot, 'repos', 'myrepo', '.git')),
            'gitdir: /tmp/foreign\n',
          )
          const ambiguousIssues = yield* validateStoreMembers({
            memberNames: ['myrepo'],
            config: makeTestConfig({ myrepo: 'owner/myrepo#feature' }),
            lockFile: makeTestLockFile({ myrepo: { ref: 'feature', commit } }),
            store,
          })
          expect(ambiguousIssues).toMatchObject([
            { severity: 'error', type: 'ambiguous_worktree', memberName: 'myrepo' },
          ])
          expect(yield* fixStoreIssues({ issues: ambiguousIssues, store })).toMatchObject([
            { status: 'skipped', issueType: 'ambiguous_worktree' },
          ])
          expect(yield* fs.exists(EffectPath.unsafe.absoluteDir(`${workspaceRoot}/`))).toBe(true)
        }).pipe(Effect.scoped),
      ))
  })

  describe('runPreflightChecks', () => {
    it('succeeds when no issues', () =>
      runWithContext(
        runPreflightChecks({
          memberNames: ['local'],
          config: makeTestConfig({ local: './path' }),
          lockFile: makeTestLockFile({}),
          store: makeTestStore(EffectPath.unsafe.absoluteDir('/tmp/test-store/')),
        }),
      ))

    it('fails with StoreHygieneError on error-severity issues', () =>
      runWithContext(
        Effect.gen(function* () {
          const result = yield* Effect.flip(
            runPreflightChecks({
              memberNames: ['myrepo'],
              config: makeTestConfig({ myrepo: 'owner/myrepo#main' }),
              lockFile: makeTestLockFile({
                myrepo: { ref: 'main', commit: 'a'.repeat(40) },
              }),
              store: makeTestStore(
                EffectPath.unsafe.absoluteDir('/tmp/nonexistent-test-store-xyz/'),
              ),
            }),
          )

          expect(result).toBeInstanceOf(StoreHygieneError)
          if (result instanceof StoreHygieneError) {
            expect(result._tag).toBe('StoreHygieneError')
            expect(result.issues.length).toBeGreaterThan(0)
            expect(result.issues[0]!.memberName).toBe('myrepo')
          }
        }),
      ))

    it('blocks on an existing worktree root without a Git registration', () =>
      runWithContext(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const basePath = `/tmp/test-store-broken-wt-${Date.now()}/`
          const store = makeTestStore(EffectPath.unsafe.absoluteDir(basePath))
          const config = makeTestConfig({ myrepo: 'owner/myrepo#main' })
          const lockFile = makeTestLockFile({
            myrepo: { ref: 'main', commit: 'a'.repeat(40) },
          })

          const bareRepoPath = `${basePath}github.com/owner/myrepo/.bare/`
          yield* fs.makeDirectory(
            EffectPath.unsafe.absoluteDir(`${NodePath.dirname(bareRepoPath)}/`),
            { recursive: true },
          )
          yield* Git.runCommand({
            cwd: NodePath.dirname(bareRepoPath),
            args: ['init', '--bare', bareRepoPath],
          })

          const worktreePath = `${basePath}github.com/owner/myrepo/refs/heads/main/`
          yield* fs.makeDirectory(worktreePath, { recursive: true })

          const result = yield* Effect.flip(
            runPreflightChecks({ memberNames: ['myrepo'], config, lockFile, store }),
          )

          expect(result).toBeInstanceOf(StoreHygieneError)
          if (result instanceof StoreHygieneError) {
            expect(result.issues.some((i) => i.type === 'ambiguous_worktree')).toBe(true)
          }

          yield* fs.remove(basePath, { recursive: true })
        }),
      ))

    it('includes actionable error messages', () =>
      runWithContext(
        Effect.gen(function* () {
          const result = yield* Effect.flip(
            runPreflightChecks({
              memberNames: ['myrepo'],
              config: makeTestConfig({ myrepo: 'owner/myrepo#main' }),
              lockFile: makeTestLockFile({
                myrepo: { ref: 'main', commit: 'a'.repeat(40) },
              }),
              store: makeTestStore(
                EffectPath.unsafe.absoluteDir('/tmp/nonexistent-test-store-xyz/'),
              ),
            }),
          )

          expect(result).toBeInstanceOf(StoreHygieneError)
          if (result instanceof StoreHygieneError) {
            expect(result.message).toContain('Store hygiene check failed')
          }
        }),
      ))
  })

  describe('parseWorktreeRef', () => {
    it('parses /refs/heads/ paths', () => {
      expect(parseWorktreeRef('/store/github.com/owner/repo/refs/heads/main/')).toEqual({
        type: 'heads',
        ref: 'main',
      })
    })

    it('parses branch names with slashes', () => {
      expect(
        parseWorktreeRef('/store/github.com/owner/repo/refs/heads/feature/my-branch/'),
      ).toEqual({ type: 'heads', ref: 'feature/my-branch' })
    })

    it('parses /refs/tags/ paths', () => {
      expect(parseWorktreeRef('/store/github.com/owner/repo/refs/tags/v1.0/')).toEqual({
        type: 'tags',
        ref: 'v1.0',
      })
    })

    it('parses /refs/commits/ paths', () => {
      expect(parseWorktreeRef('/store/github.com/owner/repo/refs/commits/abc123def/')).toEqual({
        type: 'commits',
        ref: 'abc123def',
      })
    })

    it('returns undefined for paths without /refs/', () => {
      expect(parseWorktreeRef('/store/github.com/owner/repo/some/other/path/')).toBeUndefined()
    })

    it('handles paths without trailing slash', () => {
      expect(parseWorktreeRef('/store/github.com/owner/repo/refs/heads/main')).toEqual({
        type: 'heads',
        ref: 'main',
      })
    })
  })

  describe('fixStoreIssues', () => {
    const testStore = makeTestStore(
      EffectPath.unsafe.absoluteDir('/tmp/nonexistent-fix-test-store/'),
    )

    const githubSource: MemberSource = {
      type: 'github',
      owner: 'owner',
      repo: 'myrepo',
      ref: Option.some('main'),
    }

    describe('dry-run mode', () => {
      it('reports what would happen for ref_mismatch without doing anything', () =>
        runWithContext(
          Effect.gen(function* () {
            const issues: StoreIssue[] = [
              {
                severity: 'error',
                type: 'ref_mismatch',
                memberName: 'myrepo',
                message: 'worktree HEAD is wrong',
                meta: {
                  _tag: 'ref_mismatch',
                  expectedRef: 'main',
                  actualRef: 'develop',
                  worktreePath: '/tmp/test/refs/heads/main/',
                },
              },
            ]

            const results = yield* fixStoreIssues({ issues, store: testStore, dryRun: true })

            expect(results).toHaveLength(1)
            expect(results[0]!.status).toBe('skipped')
            expect(results[0]!.message).toContain("would checkout 'main'")
          }),
        ))

      it('reports what would happen for broken_worktree without doing anything', () =>
        runWithContext(
          Effect.gen(function* () {
            const issues: StoreIssue[] = [
              {
                severity: 'error',
                type: 'broken_worktree',
                memberName: 'myrepo',
                message: '.git not found',
                meta: {
                  _tag: 'broken_worktree',
                  worktreePath: '/tmp/test/refs/heads/main/',
                  source: githubSource,
                },
              },
            ]

            const results = yield* fixStoreIssues({ issues, store: testStore, dryRun: true })

            expect(results).toHaveLength(1)
            expect(results[0]!.status).toBe('skipped')
            expect(results[0]!.message).toContain('would recreate worktree')
          }),
        ))

      it('reports what would happen for missing_bare without doing anything', () =>
        runWithContext(
          Effect.gen(function* () {
            const issues: StoreIssue[] = [
              {
                severity: 'error',
                type: 'missing_bare',
                memberName: 'myrepo',
                message: 'bare repo not found',
                meta: { _tag: 'missing_bare', source: githubSource },
              },
            ]

            const results = yield* fixStoreIssues({ issues, store: testStore, dryRun: true })

            expect(results).toHaveLength(1)
            expect(results[0]!.status).toBe('skipped')
            expect(results[0]!.message).toContain('would clone bare repo')
          }),
        ))
    })

    it('skips non-error severity issues', () =>
      runWithContext(
        Effect.gen(function* () {
          const issues: StoreIssue[] = [
            {
              severity: 'warning',
              type: 'dirty',
              memberName: 'myrepo',
              message: 'uncommitted changes',
            },
            {
              severity: 'warning',
              type: 'unpushed',
              memberName: 'myrepo',
              message: 'unpushed commits',
            },
            { severity: 'info', type: 'orphaned', memberName: 'myrepo', message: 'orphaned' },
          ]

          const results = yield* fixStoreIssues({ issues, store: testStore })

          expect(results).toHaveLength(0)
        }),
      ))

    it('skips issues with missing metadata', () =>
      runWithContext(
        Effect.gen(function* () {
          const issues: StoreIssue[] = [
            { severity: 'error', type: 'ref_mismatch', memberName: 'myrepo', message: 'mismatch' },
            { severity: 'error', type: 'broken_worktree', memberName: 'myrepo', message: 'broken' },
            { severity: 'error', type: 'missing_bare', memberName: 'myrepo', message: 'missing' },
          ]

          const results = yield* fixStoreIssues({ issues, store: testStore })

          expect(results).toHaveLength(3)
          expect(results.every((r) => r.status === 'skipped')).toBe(true)
          expect(results.every((r) => r.message === 'missing metadata for fix')).toBe(true)
        }),
      ))

    it('skips unsupported issue types', () =>
      runWithContext(
        Effect.gen(function* () {
          const issues: StoreIssue[] = [
            {
              severity: 'error',
              type: 'dirty',
              memberName: 'myrepo',
              message: 'dirty worktree',
            },
          ]

          const results = yield* fixStoreIssues({ issues, store: testStore })

          expect(results).toHaveLength(1)
          expect(results[0]!.status).toBe('skipped')
          expect(results[0]!.message).toContain("no automatic fix for 'dirty'")
        }),
      ))
  })
})
