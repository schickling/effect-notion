import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as Command from 'effect/unstable/process/ChildProcess'
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner'
import { expect } from 'vitest'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import { requireTool } from './require-tool.ts'
import {
  createArchiveEntry,
  createStoreFixture,
  createWorkspaceWithLock,
  getWorktreeCommit,
  repinWorkspace,
} from './store-setup.ts'

const gitBin = requireTool('GIT_BIN')

const git = (cwd: AbsoluteDirPath, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    return (yield* ChildProcessSpawner.use((spawner) =>
      spawner.string(Command.make(gitBin, args, { cwd })),
    )).trim()
  })

describe('store-setup fixtures', () => {
  it.effect(
    'withRemote gives the store bare real refs/remotes/origin/* (reachability testable)',
    Effect.fnUntraced(
      function* () {
        const { bareRepoPaths, worktreePaths, upstreamRepoPaths } = yield* createStoreFixture([
          {
            host: 'github.com',
            owner: 'o',
            repo: 'r',
            branches: ['main'],
            withRemote: true,
          },
        ])
        const bare = bareRepoPaths['github.com/o/r']!
        expect(upstreamRepoPaths['github.com/o/r']).toBeDefined()

        // remote-tracking refs exist after the fixture's fetch
        const remotes = yield* git(bare, 'for-each-ref', '--format=%(refname)', 'refs/remotes/')
        expect(remotes).toContain('refs/remotes/origin/main')

        // a worktree head that is on the remote is reachable: rev-list --not --remotes is empty
        const head = yield* getWorktreeCommit(worktreePaths['github.com/o/r#main']!)
        const unpushed = yield* git(bare, 'rev-list', head, '--not', '--remotes')
        expect(unpushed).toBe('')
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'createArchiveEntry registers a reapable worktree under .archive/',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { bareRepoPaths, worktreePaths } = yield* createStoreFixture([
          { host: 'github.com', owner: 'o', repo: 'r', branches: ['main'] },
        ])
        const bare = bareRepoPaths['github.com/o/r']!
        const repoRoot = EffectPath.ops.parent(bare)!
        const commit = yield* getWorktreeCommit(worktreePaths['github.com/o/r#main']!)

        const archivedAt = new Date('2025-01-02T03:04:05.000Z')
        const { archivePath, dirName } = yield* createArchiveEntry({
          bareRepoPath: bare,
          repoRoot,
          branch: 'feature/x',
          commit,
          archivedAt,
        })

        expect(dirName).toBe('feature/x--2025-01-02T03:04:05.000Z')
        expect(yield* fs.exists(archivePath)).toBe(true)
        // git enumerates it as a worktree (the reaper's scan surface)
        const list = yield* git(bare, 'worktree', 'list', '--porcelain')
        expect(list).toContain(archivePath.replace(/\/+$/, ''))
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'repinWorkspace repoints the symlink without touching the registry record',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { worktreePaths } = yield* createStoreFixture([
          { host: 'github.com', owner: 'o', repo: 'r', branches: ['main', 'next'] },
        ])
        const { workspacePath } = yield* createWorkspaceWithLock({
          members: { repo: 'o/r#main' },
        })

        const newTarget = worktreePaths['github.com/o/r#next']!
        yield* repinWorkspace({ workspacePath, memberName: 'repo', newTarget })

        const symlinkPath = EffectPath.ops.join(
          workspacePath,
          EffectPath.unsafe.relativeFile('repos/repo'),
        )
        const resolved = yield* fs.readLink(symlinkPath)
        expect(resolved.replace(/\/+$/, '')).toBe(newTarget.replace(/\/+$/, ''))

        // No registry record was written (no re-registration happened).
        const registryDir = EffectPath.ops.join(
          workspacePath,
          EffectPath.unsafe.relativeDir('.state/workspaces/'),
        )
        expect(yield* fs.exists(registryDir)).toBe(false)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )
})
