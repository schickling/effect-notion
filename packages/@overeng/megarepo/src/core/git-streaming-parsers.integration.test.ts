/**
 * Parse-correctness for the streaming git parsers (`listWorktrees`,
 * `revListUnpushed`) that fold their (potentially large/unbounded) stdout
 * line-by-line through a `Sink` instead of buffering it (decision 0007).
 *
 * These assert PARSE PARITY with the previous `split('\n')` implementations on
 * real git output — the streaming `Stream.splitLines` boundary handling (interior
 * blank-line record separators preserved, only the trailing empty segment
 * dropped) and the mutable-accumulator folds (O(n), not per-element spreads) must
 * produce identical results. The constant-memory property of the shared streaming
 * helper is proven separately by `git-memory.integration.test.ts`.
 */

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as Command from 'effect/unstable/process/ChildProcess'
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner'
import { expect } from 'vitest'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import { requireTool } from '../test-utils/require-tool.ts'
import * as Git from './git.ts'

const gitBin = requireTool('GIT_BIN')

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    return (yield* ChildProcessSpawner.use((spawner) =>
      spawner.string(Command.make(gitBin, args, { cwd })),
    )).trim()
  })

const makeRepoDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  return EffectPath.unsafe.absoluteDir(
    `${yield* fs.realPath(yield* fs.makeTempDirectoryScoped())}/`,
  )
})

describe('streaming git parsers', () => {
  it.effect('listWorktrees parses every record (branch, detached, multiple)', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* makeRepoDir
      const mainPath = EffectPath.ops.join(root, EffectPath.unsafe.relativeDir('main/'))
      yield* fs.makeDirectory(mainPath, { recursive: true })
      yield* git(mainPath, 'init', '-q', '-b', 'main')
      yield* git(mainPath, 'config', 'user.email', 'test@example.com')
      yield* git(mainPath, 'config', 'user.name', 'Test User')
      yield* git(mainPath, 'config', 'commit.gpgsign', 'false')
      yield* fs.writeFileString(
        EffectPath.ops.join(mainPath, EffectPath.unsafe.relativeFile('a.txt')),
        'a\n',
      )
      yield* git(mainPath, 'add', '-A')
      yield* git(mainPath, 'commit', '--no-verify', '-m', 'init')

      // A branch worktree + a detached worktree (no `branch` porcelain line).
      const wtBranch = EffectPath.ops.join(root, EffectPath.unsafe.relativeDir('wt-branch/'))
      const wtDetached = EffectPath.ops.join(root, EffectPath.unsafe.relativeDir('wt-detached/'))
      yield* git(mainPath, 'worktree', 'add', '-b', 'feature', wtBranch.replace(/\/$/, ''))
      const head = yield* git(mainPath, 'rev-parse', 'HEAD')
      yield* git(mainPath, 'worktree', 'add', '--detach', wtDetached.replace(/\/$/, ''), head)

      const worktrees = yield* Git.listWorktrees(mainPath)

      // Expect 3 records: the primary (main), the feature branch, and the detached.
      expect(worktrees).toHaveLength(3)
      const byBranch = (b: string) => worktrees.find((w) => Option.getOrUndefined(w.branch) === b)
      expect(byBranch('main')).toBeDefined()
      expect(byBranch('feature')).toBeDefined()
      // The detached worktree carries no branch.
      const detached = worktrees.find((w) => Option.isNone(w.branch))
      expect(detached).toBeDefined()
      expect(detached?.head).toBe(head)
      // Every record has a non-empty path + 40-char head SHA (no half-parsed entries).
      for (const w of worktrees) {
        expect(w.path.length).toBeGreaterThan(0)
        expect(w.head).toMatch(/^[0-9a-f]{40}$/)
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('revListUnpushed returns exactly the commits absent from remotes', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* makeRepoDir

      // A bare "remote" + a clone that pushes `main`, then stacks N local commits.
      const remote = EffectPath.ops.join(root, EffectPath.unsafe.relativeDir('remote.bare/'))
      yield* fs.makeDirectory(remote, { recursive: true })
      yield* git(remote, 'init', '--bare', '-q', '-b', 'main')

      const work: AbsoluteDirPath = EffectPath.ops.join(
        root,
        EffectPath.unsafe.relativeDir('work/'),
      )
      yield* fs.makeDirectory(work, { recursive: true })
      yield* git(work, 'init', '-q', '-b', 'main')
      yield* git(work, 'config', 'user.email', 'test@example.com')
      yield* git(work, 'config', 'user.name', 'Test User')
      yield* git(work, 'config', 'commit.gpgsign', 'false')
      yield* git(work, 'remote', 'add', 'origin', remote.replace(/\/$/, ''))
      yield* fs.writeFileString(
        EffectPath.ops.join(work, EffectPath.unsafe.relativeFile('base.txt')),
        'base\n',
      )
      yield* git(work, 'add', '-A')
      yield* git(work, 'commit', '--no-verify', '-m', 'base')
      yield* git(work, 'push', '-q', '-u', 'origin', 'main')

      // Stack N unpushed commits, capturing each SHA in author order. Enough to
      // exercise the streaming line fold across many records; kept modest so the
      // sequential commits stay well under the integration timeout on slow CI.
      const N = 120
      const expected: Array<string> = []
      for (let i = 0; i < N; i++) {
        yield* fs.writeFileString(
          EffectPath.ops.join(work, EffectPath.unsafe.relativeFile(`f${i}.txt`)),
          `${i}\n`,
        )
        yield* git(work, 'add', '-A')
        yield* git(work, 'commit', '--no-verify', '-m', `local ${i}`)
        expected.push(yield* git(work, 'rev-parse', 'HEAD'))
      }
      // Refresh remote-tracking refs so `--not --remotes` excludes pushed history.
      yield* git(work, 'fetch', '-q', 'origin')

      const unpushed = yield* Git.revListUnpushed({ repoPath: work, ref: 'HEAD' })

      // `rev-list HEAD` is newest-first; the N stacked commits are exactly the
      // unpushed set (the pushed base + its ancestors are excluded).
      expect(unpushed).toHaveLength(N)
      expect([...unpushed].sort()).toEqual([...expected].sort())
      // No empty entries leaked through the line fold.
      for (const sha of unpushed) expect(sha).toMatch(/^[0-9a-f]{40}$/)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )
})
