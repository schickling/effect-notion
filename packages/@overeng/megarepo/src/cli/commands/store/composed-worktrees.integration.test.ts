import { writeFile } from 'node:fs/promises'
import * as NodePath from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import { EffectPath } from '@overeng/effect-path'

import { createComposedOwnedWorkspace } from '../../../composition/acquisition/owned-worktree-acquisition.ts'
import * as Git from '../../../core/git.ts'
import { makeCanonicalTempDirectoryScoped } from '../../../test-utils/temp-root.ts'
import { collectRepoStoreWorktrees } from './mod.ts'

const GIT_USER = ['-c', 'user.email=test@example.com', '-c', 'user.name=Test User'] as const

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  Git.runCommand({ cwd, args: [...GIT_USER, ...args] })

/** A store repo directory holding one plain worktree and one composed workspace. */
const makeStoreRepo = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const tmp = yield* makeCanonicalTempDirectoryScoped()
  const source = NodePath.join(tmp, 'source')
  const repoPath = NodePath.join(tmp, 'github.com', 'owner', 'repo')
  const bareRepo = NodePath.join(repoPath, '.bare')
  yield* fs.makeDirectory(EffectPath.unsafe.absoluteDir(`${source}/`), { recursive: true })
  yield* git(source, 'init', '-b', 'main')
  yield* fs.writeFileString(
    EffectPath.unsafe.absoluteFile(NodePath.join(source, 'megarepo.kdl')),
    'members {}\n',
  )
  yield* git(source, 'add', '-A')
  yield* git(source, 'commit', '--no-gpg-sign', '--no-verify', '-m', 'base')
  yield* fs.makeDirectory(EffectPath.unsafe.absoluteDir(`${repoPath}/`), { recursive: true })
  yield* git(repoPath, 'clone', '--bare', source, bareRepo)
  yield* fs.makeDirectory(
    EffectPath.unsafe.absoluteDir(`${NodePath.join(repoPath, 'refs', 'heads')}/`),
    { recursive: true },
  )
  return { tmp, repoPath, bareRepo }
})

const collect = (repo: Effect.Success<typeof makeStoreRepo>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* collectRepoStoreWorktrees({
      fs,
      repoPath: EffectPath.unsafe.absoluteDir(`${repo.repoPath}/`),
      bareRepoPath: EffectPath.unsafe.absoluteDir(`${repo.bareRepo}/`),
    })
  })

describe('store worktree collection understands composed workspaces', () => {
  it.effect(
    'reports one entry at the workspace root and keeps the nested checkout addressable',
    () =>
      Effect.gen(function* () {
        const repo = yield* makeStoreRepo
        const plain = NodePath.join(repo.repoPath, 'refs', 'heads', 'main')
        yield* git(repo.bareRepo, 'worktree', 'add', plain, 'main')
        const composedRoot = NodePath.join(repo.repoPath, 'refs', 'heads', 'feature')
        yield* createComposedOwnedWorkspace({
          bareRepo: repo.bareRepo,
          workspaceRoot: composedRoot,
          ownedMember: 'owner',
          branch: 'feature',
          startPoint: 'main',
          generate: () => Effect.void,
        })

        const collected = yield* collect(repo)
        const byRef = Object.fromEntries(collected.map((entry) => [entry.ref, entry]))
        expect(Object.keys(byRef).toSorted()).toEqual(['feature', 'main'])

        // The composed workspace is exactly one reclaimable unit: the root. The polluted
        // `feature/repos/owner` ref that the raw registration would produce must not appear.
        const composed = byRef['feature']!
        expect(composed.path).toBe(`${composedRoot}/`)
        expect(composed.broken).toBe(false)
        expect(composed.ownedWorktree).toBe(`${NodePath.join(composedRoot, 'repos', 'owner')}/`)
        expect(composed.composedRoot).toBe(true)
        expect(byRef['main']!.ownedWorktree).toBeUndefined()
        expect(byRef['main']!.composedRoot).toBeUndefined()
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('sees dirty bytes in the nested owned checkout, not the empty composed root', () =>
    Effect.gen(function* () {
      const repo = yield* makeStoreRepo
      const composedRoot = NodePath.join(repo.repoPath, 'refs', 'heads', 'feature')
      const created = yield* createComposedOwnedWorkspace({
        bareRepo: repo.bareRepo,
        workspaceRoot: composedRoot,
        ownedMember: 'owner',
        branch: 'feature',
        startPoint: 'main',
        generate: () => Effect.void,
      })
      yield* Effect.promise(() =>
        writeFile(NodePath.join(created.ownedWorktree, 'dirty.txt'), 'dirty\n'),
      )

      const collected = yield* collect(repo)
      const composed = collected.find((entry) => entry.ref === 'feature')!
      // Reclamation must read the nested checkout: the root itself is not a git worktree, so a
      // status read against `composed.path` would report nothing and hide the dirty bytes.
      const rootStatus = yield* Effect.option(Git.getWorktreeRemovalStatus(composed.path))
      expect(rootStatus._tag).toBe('None')
      const ownedStatus = yield* Git.getWorktreeRemovalStatus(composed.ownedWorktree!)
      expect(ownedStatus.isDirty).toBe(true)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )
})
