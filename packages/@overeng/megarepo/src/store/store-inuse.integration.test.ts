/**
 * Live-process in-use probe tests.
 *
 * The pure classifier and lsof parser are exercised directly, and the native
 * process-table reader against a REAL spawned holder whose cwd is inside a temp
 * worktree — the incident shape: a live session sitting in a directory that
 * reclamation is about to rename. These cases deliberately drive real OS
 * processes, because the probe's whole job is to observe them; process
 * lifecycle is awaited through node's `spawn`/`exit` events, never a timer, so
 * no wall-clock guessing is involved.
 *
 * `selfPid` is passed as a sibling process's pid in the observable case: a
 * sibling is never an ancestor of the holder, so the descendant walk never
 * excludes it. That models production, where gc is its own process tree rather
 * than an ancestor of the live session.
 */

import { spawn, type ChildProcess } from 'node:child_process'

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import { EffectPath } from '@overeng/effect-path'

import {
  classifyInUse,
  isInsideWorktree,
  parseLsofProcessCwds,
  readWorktreeInUse,
} from './store-inuse.ts'

const supportsProcessCwdProbe = process.platform === 'linux' || process.platform === 'darwin'

/** Spawn a long-lived holder in `cwd`, resolved once the OS reports it spawned. */
const spawnHolder = (cwd: string): Promise<ChildProcess> => {
  const { promise, resolve, reject } = Promise.withResolvers<ChildProcess>()
  const child = spawn('sleep', ['120'], { cwd, stdio: 'ignore' })
  child.once('spawn', () => resolve(child))
  child.once('error', reject)
  return promise
}

/** Kill a holder and resolve on its real `exit` event. */
const killHolder = (child: ChildProcess): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  child.once('exit', () => resolve())
  child.kill('SIGKILL')
  return promise
}

describe('store-inuse classifier', () => {
  it('parses macOS lsof cwd records with their parent process identities', () => {
    expect(
      parseLsofProcessCwds([
        'p100',
        'R1',
        'fcwd',
        'n/store/repo',
        'p101',
        'R100',
        'fcwd',
        'n/store/repo/src',
        'pnot-a-pid',
        'R101',
        'fcwd',
        'n/ignored',
      ]),
    ).toEqual([
      { pid: 100, parentPid: 1, path: '/store/repo' },
      { pid: 101, parentPid: 100, path: '/store/repo/src' },
    ])
  })

  it('treats the worktree and its descendants as inside, siblings as outside', () => {
    const worktree = '/store/repo/refs/heads/main'
    expect(isInsideWorktree({ candidate: worktree, worktreePath: `${worktree}/` })).toBe(true)
    expect(isInsideWorktree({ candidate: `${worktree}/src/app`, worktreePath: worktree })).toBe(
      true,
    )
    // The bug a raw string prefix would introduce: a sibling directory.
    expect(isInsideWorktree({ candidate: `${worktree}.archive-old`, worktreePath: worktree })).toBe(
      false,
    )
    expect(
      isInsideWorktree({ candidate: '/store/repo/refs/heads/other', worktreePath: worktree }),
    ).toBe(false)
  })

  it('reports the first non-excluded holder and ignores excluded pids', () => {
    const worktreePath = '/store/repo/refs/heads/main'
    const processes = [
      { pid: 10, path: '/elsewhere' },
      { pid: 11, path: `${worktreePath}/src` },
      { pid: 12, path: worktreePath },
    ]

    expect(classifyInUse({ processes, worktreePath, excludePids: new Set() })).toEqual({
      _tag: 'in-use',
      holder: { pid: 11, path: `${worktreePath}/src` },
    })
    expect(classifyInUse({ processes, worktreePath, excludePids: new Set([11]) })).toEqual({
      _tag: 'in-use',
      holder: { pid: 12, path: worktreePath },
    })
    expect(classifyInUse({ processes, worktreePath, excludePids: new Set([11, 12]) })).toEqual({
      _tag: 'free',
    })
  })
})

describe.skipIf(supportsProcessCwdProbe === false)('store-inuse native process probe', () => {
  it.effect(
    'sees a live holder inside the worktree, and frees once it exits',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const root = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const worktree = EffectPath.ops.join(root, EffectPath.unsafe.relativeDir('worktree/'))
        const sibling = EffectPath.ops.join(root, EffectPath.unsafe.relativeDir('worktree-old/'))
        yield* fs.makeDirectory(worktree, { recursive: true })
        yield* fs.makeDirectory(sibling, { recursive: true })

        const holder = yield* Effect.promise(() => spawnHolder(worktree))
        const standIn = yield* Effect.promise(() => spawnHolder(root))

        const occupied = yield* readWorktreeInUse({
          worktreePath: worktree,
          selfPid: standIn.pid!,
        })
        expect(occupied).toMatchObject({ _tag: 'in-use', holder: { pid: holder.pid } })

        // The sibling directory is not the worktree, so it reads free.
        const siblingResult = yield* readWorktreeInUse({
          worktreePath: sibling,
          selfPid: standIn.pid!,
        })
        expect(siblingResult._tag).toBe('free')

        yield* Effect.promise(() => killHolder(holder))
        yield* Effect.promise(() => killHolder(standIn))

        const freed = yield* readWorktreeInUse({ worktreePath: worktree, selfPid: 1 })
        expect(freed._tag).toBe('free')
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'never vetoes on its own descendants',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const worktree = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        // A descendant of this process, exactly like a `git` child megarepo
        // spawns inside the worktree it is reclaiming.
        const child = yield* Effect.promise(() => spawnHolder(worktree))
        const result = yield* readWorktreeInUse({ worktreePath: worktree })
        yield* Effect.promise(() => killHolder(child))
        expect(result._tag).toBe('free')
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )
})
