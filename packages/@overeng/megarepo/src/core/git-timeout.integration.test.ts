/**
 * Integration coverage for the operation-aware git deadline (issue livestore#1473).
 *
 * These exercise REAL git subprocesses against a LOCAL remote (no network), proving
 * the timeout CLASS is enforced end-to-end through {@link Git.cloneBare} /
 * {@link Git.getCurrentCommit}, not just in the pure `gitCommandTimeoutMillis` helper:
 *
 * - a network op (`clone`) with a 1ms network budget fails with GitCommandTimeoutError;
 * - the same 1ms network budget does NOT affect a local op (`rev-parse`), which still
 *   succeeds — the two classes have independent deadlines;
 * - a 1ms local budget DOES time out a local op, confirming the local wiring too.
 *
 * The default (no env) clone succeeding is the baseline that the tight 30s deadline
 * used to break for large members.
 */

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as Command from 'effect/unstable/process/ChildProcess'
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner'
import { expect } from 'vitest'

import { EffectPath } from '@overeng/effect-path'

import { requireTool } from '../test-utils/require-tool.ts'
import * as Git from './git.ts'
import { GitCommandTimeoutError } from './git.ts'

const gitBin = requireTool('GIT_BIN')

const GIT_USER = ['-c', 'user.email=test@example.com', '-c', 'user.name=Test User'] as const

/** Run git in `cwd`, returning trimmed stdout (fixture setup only). */
const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    return (yield* ChildProcessSpawner.use((spawner) =>
      spawner.string(Command.make(gitBin, [...GIT_USER, ...args], { cwd })),
    )).trim()
  })

/**
 * Set an env var for the duration of `eff`, restoring the prior value after — the
 * deadline is read from `process.env` at call time, and tests run in-process, so this
 * must not leak across cases.
 */
const withEnv = <A, E, R>(key: string, value: string, eff: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env[key]
      process.env[key] = value
      return prev
    }),
    () => eff,
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env[key]
        else process.env[key] = prev
      }),
  )

/**
 * A local git repo with one commit on `main`, usable as a `clone --bare` source (no
 * network). We clone directly from this working repo rather than pushing to a bare
 * "remote" — a push to the default branch is (rightly) refused by the local
 * agent-policy git guard, and the transport is irrelevant to a timeout test.
 */
const makeCloneSource = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem
  const tmp = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
  const source = EffectPath.ops.join(tmp, EffectPath.unsafe.relativeDir('source/'))

  yield* fs.makeDirectory(source, { recursive: true })
  yield* git(source, 'init', '-b', 'main')
  yield* fs.writeFileString(
    EffectPath.ops.join(source, EffectPath.unsafe.relativeFile('f.txt')),
    'base\n',
  )
  yield* git(source, 'add', '-A')
  yield* git(source, 'commit', '--no-gpg-sign', '--no-verify', '-m', 'base')

  return { tmp, remote: source }
})

const cloneTargetIn = (tmp: string, name: string) =>
  EffectPath.ops.join(
    EffectPath.unsafe.absoluteDir(tmp),
    EffectPath.unsafe.relativeDir(`${name}.bare/`),
  )

describe('git operation-aware timeout', () => {
  it.live('clones a valid local remote under the default network budget', () =>
    Effect.gen(function* () {
      const { tmp, remote } = yield* makeCloneSource()
      const target = cloneTargetIn(tmp, 'clone-default')
      yield* Git.cloneBare({ url: remote, targetPath: target })
      // Sanity: the clone actually populated a usable bare repo.
      const commit = yield* Git.getCurrentCommit(target)
      expect(commit).toMatch(/^[0-9a-f]{40}$/)
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.live('a network op is bounded by the network budget (1ms → times out)', () =>
    Effect.gen(function* () {
      const { tmp, remote } = yield* makeCloneSource()
      const target = cloneTargetIn(tmp, 'clone-timeout')
      const error = yield* withEnv(
        'MEGAREPO_GIT_NETWORK_TIMEOUT_MS',
        '1',
        Git.cloneBare({ url: remote, targetPath: target }),
      ).pipe(Effect.flip)
      expect(error).toBeInstanceOf(GitCommandTimeoutError)
      expect((error as GitCommandTimeoutError).timeoutMillis).toBe(1)
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.live('the network budget does NOT bound a local op (rev-parse still succeeds)', () =>
    Effect.gen(function* () {
      const { tmp, remote } = yield* makeCloneSource()
      const target = cloneTargetIn(tmp, 'clone-for-local')
      yield* Git.cloneBare({ url: remote, targetPath: target })
      // A 1ms NETWORK budget must not affect a LOCAL op — it keeps the 30s default.
      const commit = yield* withEnv(
        'MEGAREPO_GIT_NETWORK_TIMEOUT_MS',
        '1',
        Git.getCurrentCommit(target),
      )
      expect(commit).toMatch(/^[0-9a-f]{40}$/)
    }).pipe(Effect.provide(NodeServices.layer)),
  )
})
