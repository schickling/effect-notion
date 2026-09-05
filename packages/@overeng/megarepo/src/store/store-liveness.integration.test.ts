import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as Command from 'effect/unstable/process/ChildProcess'
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner'
import { expect } from 'vitest'

import { EffectPath } from '@overeng/effect-path'

import { decodeJson } from '../test-utils/mod.ts'
import { requireTool } from '../test-utils/require-tool.ts'
import {
  createStoreFixture,
  createWorkspaceWithLock,
  getWorktreeCommit,
  repinWorkspace,
} from '../test-utils/store-setup.ts'
import {
  collectStoreLiveSet,
  collectWorkspaceLivePaths,
  collectWorkspaceLivePathsStrict,
  refreshWorkspaceRegistry,
} from './store-liveness.ts'
import { makeStoreLayer, Store } from './store.ts'

const gitBin = requireTool('GIT_BIN')

const normalizePath = (path: string): string => path.replace(/\/+$/, '')

const runGitCommand = (cwd: string, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const result = yield* ChildProcessSpawner.use((spawner) =>
      spawner.string(Command.make(gitBin, args, { cwd })),
    )
    return result.trim()
  })

describe('store-liveness', () => {
  it.effect(
    'collectWorkspaceLivePaths includes store symlink targets',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { storePath, worktreePaths } = yield* createStoreFixture([
          {
            host: 'github.com',
            owner: 'test-owner',
            repo: 'symlinked-repo',
            branches: ['main'],
          },
        ])
        const mainWorktreePath = worktreePaths['github.com/test-owner/symlinked-repo#main']!
        const { workspacePath } = yield* createWorkspaceWithLock({
          members: { repo: 'test-owner/symlinked-repo#main' },
        })
        const reposDir = EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeDir('repos/'))
        const externalTarget = EffectPath.ops.join(
          workspacePath,
          EffectPath.unsafe.relativeDir('external-target/'),
        )

        yield* fs.makeDirectory(reposDir, { recursive: true })
        yield* fs.makeDirectory(externalTarget, { recursive: true })
        yield* fs.symlink(
          normalizePath(mainWorktreePath),
          EffectPath.ops.join(reposDir, EffectPath.unsafe.relativeFile('repo')),
        )
        yield* fs.symlink(
          normalizePath(externalTarget),
          EffectPath.ops.join(reposDir, EffectPath.unsafe.relativeFile('local')),
        )

        const store = yield* Effect.provide(Store, makeStoreLayer({ basePath: storePath }))
        const livePaths = yield* collectWorkspaceLivePaths({ workspaceRoot: workspacePath, store })

        expect(livePaths).toEqual(new Set([normalizePath(mainWorktreePath)]))
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'refreshWorkspaceRegistry records locked ref and commit worktree paths',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { storePath, worktreePaths } = yield* createStoreFixture([
          {
            host: 'github.com',
            owner: 'test-owner',
            repo: 'locked-repo',
            branches: ['main'],
          },
        ])
        const mainWorktreePath = worktreePaths['github.com/test-owner/locked-repo#main']!
        const commit = yield* getWorktreeCommit(mainWorktreePath)
        const { workspacePath } = yield* createWorkspaceWithLock({
          members: { repo: 'test-owner/locked-repo#main' },
          lockEntries: {
            repo: {
              url: 'git@github.com:test-owner/locked-repo.git',
              ref: 'main',
              commit,
            },
          },
        })
        const store = yield* Effect.provide(Store, makeStoreLayer({ basePath: storePath }))
        const commitWorktreePath = store.getWorktreePath({
          source: {
            type: 'github',
            owner: 'test-owner',
            repo: 'locked-repo',
            ref: Option.some('main'),
          },
          ref: commit,
          refType: 'commit',
        })

        const record = yield* refreshWorkspaceRegistry({
          workspaceRoot: workspacePath,
          store,
          now: 1_700_000_000_000,
        })

        expect(record.workspaceRoot).toBe(normalizePath(workspacePath))
        expect(record.updatedAt).toBe(new Date(1_700_000_000_000).toISOString())
        expect(record.livePaths).toEqual(
          [normalizePath(commitWorktreePath), normalizePath(mainWorktreePath)].sort(),
        )

        const registryDir = EffectPath.ops.join(
          storePath,
          EffectPath.unsafe.relativeDir('.state/workspaces/'),
        )
        const registryEntries = yield* fs.readDirectory(registryDir)
        expect(registryEntries).toHaveLength(1)

        const registryContent = yield* fs.readFileString(
          EffectPath.ops.join(registryDir, EffectPath.unsafe.relativeFile(registryEntries[0]!)),
        )
        expect(decodeJson(registryContent)).toMatchObject({
          version: 1,
          workspaceRoot: normalizePath(workspacePath),
          livePaths: [normalizePath(commitWorktreePath), normalizePath(mainWorktreePath)].sort(),
        })
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'collectStoreLiveSet protects lock-referenced commit worktree paths',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { storePath, worktreePaths, bareRepoPaths } = yield* createStoreFixture([
          {
            host: 'github.com',
            owner: 'test-owner',
            repo: 'commit-live-repo',
            branches: ['main'],
          },
        ])
        const mainWorktreePath = worktreePaths['github.com/test-owner/commit-live-repo#main']!
        const commit = yield* getWorktreeCommit(mainWorktreePath)
        const store = yield* Effect.provide(Store, makeStoreLayer({ basePath: storePath }))
        const commitWorktreePath = store.getWorktreePath({
          source: {
            type: 'github',
            owner: 'test-owner',
            repo: 'commit-live-repo',
            ref: Option.some('main'),
          },
          ref: commit,
          refType: 'commit',
        })
        const bareRepoPath = bareRepoPaths['github.com/test-owner/commit-live-repo']!

        yield* fs.makeDirectory(EffectPath.ops.parent(commitWorktreePath)!, { recursive: true })
        yield* runGitCommand(
          bareRepoPath,
          'worktree',
          'add',
          '--detach',
          commitWorktreePath,
          commit,
        )

        const { workspacePath } = yield* createWorkspaceWithLock({
          members: { repo: 'test-owner/commit-live-repo#main' },
          lockEntries: {
            repo: {
              url: 'git@github.com:test-owner/commit-live-repo.git',
              ref: 'main',
              commit,
            },
          },
        })

        yield* refreshWorkspaceRegistry({
          workspaceRoot: workspacePath,
          store,
          now: 1_700_000_000_000,
        })
        const liveSet = yield* collectStoreLiveSet({
          store,
          refreshCurrentWorkspace: false,
        })

        expect(liveSet.paths).toContain(normalizePath(commitWorktreePath))
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'reconcileAllWorkspaces re-derives a repinned-without-reregister target (decision 0010 regression)',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { storePath, worktreePaths } = yield* createStoreFixture([
          {
            host: 'github.com',
            owner: 'test-owner',
            repo: 'repin-repo',
            branches: ['main', 'feature'],
          },
        ])
        const mainWorktreePath = worktreePaths['github.com/test-owner/repin-repo#main']!
        const featureWorktreePath = worktreePaths['github.com/test-owner/repin-repo#feature']!
        const store = yield* Effect.provide(Store, makeStoreLayer({ basePath: storePath }))

        // Workspace initially points its member at the `main` worktree and
        // registers that as live.
        const { workspacePath } = yield* createWorkspaceWithLock({
          members: { repo: 'test-owner/repin-repo#main' },
        })
        const reposDir = EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeDir('repos/'))
        yield* fs.makeDirectory(reposDir, { recursive: true })
        yield* fs.symlink(
          normalizePath(mainWorktreePath),
          EffectPath.ops.join(reposDir, EffectPath.unsafe.relativeFile('repo')),
        )
        yield* refreshWorkspaceRegistry({
          workspaceRoot: workspacePath,
          store,
          now: 1_700_000_000_000,
        })

        // Repin to the `feature` target WITHOUT running any refreshing command:
        // the cached record is now stale (still points at `main`).
        yield* repinWorkspace({
          workspacePath,
          memberName: 'repo',
          newTarget: featureWorktreePath,
        })

        // A trusting (non-reconciling) collect would over-protect `main` and miss
        // the live `feature` target — exactly the verified pre-existing bug.
        const stale = yield* collectStoreLiveSet({ store, refreshCurrentWorkspace: false })
        expect(stale.paths).toContain(normalizePath(mainWorktreePath))
        expect(stale.paths).not.toContain(normalizePath(featureWorktreePath))

        // Reconcile-all re-derives from disk: the new target is now protected.
        const reconciled = yield* collectStoreLiveSet({
          store,
          reconcileAllWorkspaces: true,
          now: 1_700_000_001_000,
        })
        expect(reconciled.paths).toContain(normalizePath(featureWorktreePath))
        expect(reconciled.paths).not.toContain(normalizePath(mainWorktreePath))
        expect(reconciled.uncleanReconcilePaths.size).toBe(0)

        // The on-disk record was rewritten fresh with the explicit `now`.
        const registryDir = EffectPath.ops.join(
          storePath,
          EffectPath.unsafe.relativeDir('.state/workspaces/'),
        )
        const entries = yield* fs.readDirectory(registryDir)
        const content = yield* fs.readFileString(
          EffectPath.ops.join(registryDir, EffectPath.unsafe.relativeFile(entries[0]!)),
        )
        const record = decodeJson(content) as {
          updatedAt: string
          livePaths: ReadonlyArray<string>
        }
        expect(record.updatedAt).toBe(new Date(1_700_000_001_000).toISOString())
        expect(record.livePaths).toEqual([normalizePath(featureWorktreePath)])
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'reconcileAllWorkspaces fails safe: a present-but-unreadable workspace keeps its last-known live paths (B2)',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { storePath, worktreePaths } = yield* createStoreFixture([
          {
            host: 'github.com',
            owner: 'test-owner',
            repo: 'unreadable-repo',
            branches: ['main'],
          },
        ])
        const mainWorktreePath = worktreePaths['github.com/test-owner/unreadable-repo#main']!
        const store = yield* Effect.provide(Store, makeStoreLayer({ basePath: storePath }))

        const { workspacePath } = yield* createWorkspaceWithLock({
          members: { repo: 'test-owner/unreadable-repo#main' },
        })
        const reposDir = EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeDir('repos/'))
        yield* fs.makeDirectory(reposDir, { recursive: true })
        yield* fs.symlink(
          normalizePath(mainWorktreePath),
          EffectPath.ops.join(reposDir, EffectPath.unsafe.relativeFile('repo')),
        )
        // Register the live path while still readable.
        yield* refreshWorkspaceRegistry({
          workspaceRoot: workspacePath,
          store,
          now: 1_700_000_000_000,
        })

        // Make the members dir unreadable: a strict reconcile must now fail.
        yield* fs.chmod(reposDir, 0o000)

        // Confirm the strict collector surfaces the read error (rather than
        // degrading to an empty set).
        const strictResult = yield* collectWorkspaceLivePathsStrict({
          workspaceRoot: workspacePath,
          store,
        }).pipe(Effect.result)
        // Restore perms regardless of assertion outcome so scoped cleanup works.
        yield* fs.chmod(reposDir, 0o755).pipe(Effect.catch(() => Effect.void))
        // Re-break for the reconcile-all assertion below.
        yield* fs.chmod(reposDir, 0o000)
        expect(strictResult._tag).toBe('Failure')

        // Reconcile-all keeps the last-known live paths (never overwrites a
        // non-empty record with empty) and flags the workspace unclean.
        const reconciled = yield* collectStoreLiveSet({
          store,
          reconcileAllWorkspaces: true,
          now: 1_700_000_002_000,
        })
        yield* fs.chmod(reposDir, 0o755).pipe(Effect.catch(() => Effect.void))

        expect(reconciled.paths).toContain(normalizePath(mainWorktreePath))
        expect([...reconciled.uncleanReconcilePaths]).toContain(normalizePath(mainWorktreePath))

        // The on-disk record was NOT overwritten (still the original timestamp).
        const registryDir = EffectPath.ops.join(
          storePath,
          EffectPath.unsafe.relativeDir('.state/workspaces/'),
        )
        const entries = yield* fs.readDirectory(registryDir)
        const content = yield* fs.readFileString(
          EffectPath.ops.join(registryDir, EffectPath.unsafe.relativeFile(entries[0]!)),
        )
        const record = decodeJson(content) as { updatedAt: string }
        expect(record.updatedAt).toBe(new Date(1_700_000_000_000).toISOString())
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'reconcileAllWorkspaces prunes a record whose workspace dir is gone',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { storePath, worktreePaths } = yield* createStoreFixture([
          {
            host: 'github.com',
            owner: 'test-owner',
            repo: 'gone-repo',
            branches: ['main'],
          },
        ])
        const mainWorktreePath = worktreePaths['github.com/test-owner/gone-repo#main']!
        const store = yield* Effect.provide(Store, makeStoreLayer({ basePath: storePath }))

        const { workspacePath } = yield* createWorkspaceWithLock({
          members: { repo: 'test-owner/gone-repo#main' },
        })
        const reposDir = EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeDir('repos/'))
        yield* fs.makeDirectory(reposDir, { recursive: true })
        yield* fs.symlink(
          normalizePath(mainWorktreePath),
          EffectPath.ops.join(reposDir, EffectPath.unsafe.relativeFile('repo')),
        )
        yield* refreshWorkspaceRegistry({
          workspaceRoot: workspacePath,
          store,
          now: 1_700_000_000_000,
        })

        // Workspace dir disappears entirely (not merely unreadable).
        yield* fs.remove(workspacePath, { recursive: true })

        const reconciled = yield* collectStoreLiveSet({
          store,
          reconcileAllWorkspaces: true,
          now: 1_700_000_003_000,
        })
        expect(reconciled.workspaceCount).toBe(0)
        expect(reconciled.paths.has(normalizePath(mainWorktreePath))).toBe(false)

        const registryDir = EffectPath.ops.join(
          storePath,
          EffectPath.unsafe.relativeDir('.state/workspaces/'),
        )
        const entries = yield* fs.readDirectory(registryDir)
        expect(entries.filter((e) => e.endsWith('.json'))).toHaveLength(0)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )
})
