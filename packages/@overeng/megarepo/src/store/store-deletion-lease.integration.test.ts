/**
 * Deletion-lease protocol tests.
 *
 * The lease is the ONLY barrier between reclaiming a worktree's generated
 * artifacts and re-activating that worktree, so these cover both directions of
 * the mutual exclusion plus every recovery decision: a provably dead same-host
 * holder is reclaimed, while a foreign host, a live pid, and an unreadable
 * record all keep the lease and fail the caller closed.
 */

import { spawnSync } from 'node:child_process'
import { hostname } from 'node:os'

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import { encodeJson } from '../test-utils/mod.ts'
import {
  acquireDeletionLease,
  canonicalizeOwnerPath,
  deletionLeasePath,
  DeletionLeaseUnavailableError,
  releaseDeletionLease,
  withDeletionLease,
} from './store-deletion-lease.ts'

const NOW = 1_800_000_000_000

/** A pid that is provably gone: the child is reaped before `spawnSync` returns. */
const deadPid = (): number => {
  const result = spawnSync(process.execPath, ['-e', ''])
  const pid = result.pid
  expect(typeof pid).toBe('number')
  return pid!
}

const fixture = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
    const storePath = EffectPath.ops.join(root, EffectPath.unsafe.relativeDir('store/'))
    const owner = EffectPath.ops.join(storePath, EffectPath.unsafe.relativeDir('owner/worktree/'))
    yield* fs.makeDirectory(owner, { recursive: true })
    return { storePath, owner }
  })

const writeLease = ({
  storePath,
  ownerPath,
  content,
}: {
  storePath: AbsoluteDirPath
  ownerPath: string
  content: string
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const leasePath = deletionLeasePath({ storeBasePath: storePath, ownerPath })
    yield* fs.makeDirectory(leasePath.slice(0, leasePath.lastIndexOf('/')), { recursive: true })
    yield* fs.writeFileString(leasePath, content)
    return leasePath
  })

describe('store deletion lease', () => {
  it.effect(
    'excludes a second holder while the lease is held, and admits one after release',
    Effect.fnUntraced(
      function* () {
        const f = yield* fixture()
        const ownerPath = yield* canonicalizeOwnerPath(f.owner)

        const held = yield* acquireDeletionLease({
          storeBasePath: f.storePath,
          ownerPath,
          now: NOW,
        })
        const contended = yield* acquireDeletionLease({
          storeBasePath: f.storePath,
          ownerPath,
          now: NOW,
        }).pipe(Effect.result)
        expect(contended._tag).toBe('Failure')
        expect(contended._tag === 'Failure' && contended.failure).toBeInstanceOf(
          DeletionLeaseUnavailableError,
        )

        yield* releaseDeletionLease(held)
        const reacquired = yield* acquireDeletionLease({
          storeBasePath: f.storePath,
          ownerPath,
          now: NOW,
        })
        expect(reacquired.token).not.toBe(held.token)
        yield* releaseDeletionLease(reacquired)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'activation and deletion cannot both hold the lease, in either order',
    Effect.fnUntraced(
      function* () {
        const f = yield* fixture()
        const ownerPath = yield* canonicalizeOwnerPath(f.owner)
        const attemptDelete = withDeletionLease({
          storeBasePath: f.storePath,
          ownerPath,
          now: NOW,
        })(Effect.succeed('deleted'))

        // Activation holds the lease: reclamation must fail closed.
        const duringActivation = yield* withDeletionLease({
          storeBasePath: f.storePath,
          ownerPath,
          now: NOW,
        })(attemptDelete.pipe(Effect.result))
        expect(duringActivation._tag).toBe('Failure')

        // Nothing leaks: once activation exits, reclamation proceeds.
        expect(yield* attemptDelete).toBe('deleted')
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'lease survives the holder and is released only by its own token',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const f = yield* fixture()
        const ownerPath = yield* canonicalizeOwnerPath(f.owner)
        const held = yield* acquireDeletionLease({
          storeBasePath: f.storePath,
          ownerPath,
          now: NOW,
        })

        yield* releaseDeletionLease({ ...held, token: 'not-our-token' })
        expect(yield* fs.exists(held.leasePath)).toBe(true)

        yield* releaseDeletionLease(held)
        expect(yield* fs.exists(held.leasePath)).toBe(false)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'recovers a same-host lease whose pid is provably dead',
    Effect.fnUntraced(
      function* () {
        const f = yield* fixture()
        const ownerPath = yield* canonicalizeOwnerPath(f.owner)
        yield* writeLease({
          storePath: f.storePath,
          ownerPath,
          content: encodeJson({
            version: 1,
            ownerPath,
            host: hostname(),
            pid: deadPid(),
            token: 'stale-token',
            acquiredAtMs: NOW - 60_000,
          }),
        })

        const recovered = yield* acquireDeletionLease({
          storeBasePath: f.storePath,
          ownerPath,
          now: NOW,
        })
        expect(recovered.token).not.toBe('stale-token')
        yield* releaseDeletionLease(recovered)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'never recovers a foreign-host, live-pid, or unreadable lease',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const f = yield* fixture()
        const ownerPath = yield* canonicalizeOwnerPath(f.owner)
        const refusals: Array<string> = []

        for (const content of [
          encodeJson({
            version: 1,
            ownerPath,
            host: `${hostname()}-other`,
            pid: deadPid(),
            token: 'foreign-host',
            acquiredAtMs: NOW - 60_000,
          }),
          encodeJson({
            version: 1,
            ownerPath,
            host: hostname(),
            pid: process.pid,
            token: 'live-pid',
            acquiredAtMs: NOW - 60_000,
          }),
          'not-json',
        ]) {
          const leasePath = yield* writeLease({ storePath: f.storePath, ownerPath, content })
          const attempt = yield* acquireDeletionLease({
            storeBasePath: f.storePath,
            ownerPath,
            now: NOW,
          }).pipe(Effect.result)
          refusals.push(attempt._tag)
          // The refused lease is left exactly as found, and no staging file remains.
          expect(yield* fs.readFileString(leasePath)).toBe(content)
          const siblings = yield* fs.readDirectory(
            leasePath.slice(0, leasePath.lastIndexOf('/')) as string,
          )
          expect(siblings).toEqual([leasePath.slice(leasePath.lastIndexOf('/') + 1)])
          yield* fs.remove(leasePath)
        }

        expect(refusals).toEqual(['Failure', 'Failure', 'Failure'])
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'names a not-yet-created worktree identically to its created form',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const f = yield* fixture()
        const pending = EffectPath.ops.join(f.owner, EffectPath.unsafe.relativeDir('refs/heads/x/'))

        const beforeCreate = yield* canonicalizeOwnerPath(pending)
        yield* fs.makeDirectory(pending, { recursive: true })
        const afterCreate = yield* canonicalizeOwnerPath(pending)

        expect(beforeCreate).toBe(afterCreate)
        expect(deletionLeasePath({ storeBasePath: f.storePath, ownerPath: beforeCreate })).toBe(
          deletionLeasePath({ storeBasePath: f.storePath, ownerPath: afterCreate }),
        )
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )
})
