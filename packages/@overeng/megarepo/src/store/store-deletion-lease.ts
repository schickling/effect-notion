/**
 * Store Deletion Lease
 *
 * Mutual exclusion between destructive reclamation of a store worktree's
 * generated artifacts and re-activation of that same worktree.
 *
 * The generated-artifact planner reads an EXTERNAL agent-liveness manifest, so
 * rereading it before deleting cannot exclude an activation that starts right
 * after the read. This lease closes that window with a single shared object per
 * canonical owner path: the reclaimer holds it across final classification and
 * deletion, and the activation wrapper holds it from before its first worktree
 * write until after it has published the manifest. Whoever loses the race waits
 * or fails closed — neither side ever proceeds on a stale liveness snapshot.
 *
 * Exclusion primitive is `link(2)` on the lease path: creating a hard link to a
 * freshly written staging file fails with `EEXIST` when the lease exists. That
 * is atomic on POSIX filesystems and needs no daemon, no TTL guessing, and no
 * read-then-write window (unlike `StoreLock`, whose backing is advisory and
 * TTL-expiring — safe for serializing work, unsafe as a deletion barrier).
 *
 * Recovery is deliberately narrow: a lease is reclaimed only when its record is
 * decodable, names THIS host, and names a pid that is provably gone. Anything
 * else (foreign host, unreadable record, live or unprovable pid) keeps the lease
 * and fails the caller closed.
 */

import { createHash, randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

import { Effect, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

/** On-disk lease record version. */
const DELETION_LEASE_VERSION = 1

/** Raised when the lease for an owner path cannot be taken. */
export class DeletionLeaseUnavailableError extends Schema.TaggedError<DeletionLeaseUnavailableError>()(
  'DeletionLeaseUnavailableError',
  {
    ownerPath: Schema.String,
    leasePath: Schema.String,
    message: Schema.String,
  },
) {}

/**
 * Lease record. `token` identifies one acquisition so a holder only ever
 * releases its own lease; `host`/`pid` are the sole recovery evidence.
 */
const DeletionLeaseRecord = Schema.Struct({
  version: Schema.Literal(DELETION_LEASE_VERSION),
  ownerPath: Schema.String,
  host: Schema.String,
  pid: Schema.Finite,
  token: Schema.String,
  acquiredAtMs: Schema.Finite,
})

type DeletionLeaseRecord = Schema.Schema.Type<typeof DeletionLeaseRecord>

const encodeLeaseRecord = Schema.encodeSync(Schema.fromJsonString(DeletionLeaseRecord))
const decodeLeaseRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(DeletionLeaseRecord))

/** A held lease: the path that must be removed, and the token that owns it. */
export interface DeletionLease {
  readonly leasePath: string
  readonly ownerPath: string
  readonly token: string
}

const normalizeOwnerPath = (path: string): string => path.replace(/\/+$/, '')

/** Directory holding every deletion lease of one store. */
export const deletionLeaseDirectory = (storeBasePath: AbsoluteDirPath): AbsoluteDirPath =>
  EffectPath.ops.join(storeBasePath, EffectPath.unsafe.relativeDir('.state/deletion-leases/'))

/**
 * Lease path for one canonical owner worktree path.
 *
 * The owner path is hashed so an arbitrarily deep worktree path always yields
 * one flat `NAME_MAX`-safe filename, and so both sides derive the identical
 * name from the identical canonical path without sharing any other state.
 */
export const deletionLeasePath = ({
  storeBasePath,
  ownerPath,
}: {
  storeBasePath: AbsoluteDirPath
  ownerPath: string
}): string => {
  const digest = createHash('sha256').update(normalizeOwnerPath(ownerPath), 'utf8').digest('hex')
  return `${deletionLeaseDirectory(storeBasePath)}${digest}.lease`
}

/**
 * Canonical lease identity for an owner worktree path.
 *
 * Both sides MUST derive the lease name through this function: the reclaimer
 * names an existing worktree, while the activation wrapper takes the lease
 * BEFORE its first worktree write, when the path may not exist yet. Resolving
 * the deepest existing ancestor and re-appending the remaining segments makes
 * both cases agree — for an existing path the result equals `realPath`.
 */
export const canonicalizeOwnerPath = (
  ownerPath: string,
): Effect.Effect<string, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const normalized = normalizeOwnerPath(ownerPath)
    const segments = normalized.split('/')
    for (let depth = segments.length; depth > 1; depth -= 1) {
      const real = yield* fs
        .realPath(segments.slice(0, depth).join('/'))
        .pipe(Effect.orElseSucceed(() => undefined))
      if (real === undefined) continue
      const suffix = segments.slice(depth)
      return normalizeOwnerPath(suffix.length === 0 ? real : `${real}/${suffix.join('/')}`)
    }
    return normalized
  })

const readLeaseRecord = ({
  fs,
  leasePath,
}: {
  fs: FileSystem.FileSystem
  leasePath: string
}): Effect.Effect<DeletionLeaseRecord | undefined> =>
  Effect.gen(function* () {
    const content = yield* fs.readFileString(leasePath).pipe(Effect.orElseSucceed(() => undefined))
    if (content === undefined) return undefined
    return yield* decodeLeaseRecord(content).pipe(Effect.orElseSucceed(() => undefined))
  })

/**
 * True only when the record names this host and a pid that is provably gone.
 *
 * `kill(pid, 0)` distinguishes the three cases that matter: success means the
 * process exists, `EPERM` means it exists under another user, and `ESRCH` means
 * it is gone. Only `ESRCH` is proof of death, so any other outcome — including
 * an unexpected error — keeps the lease.
 */
const isProvablyReleasable = (record: DeletionLeaseRecord): boolean => {
  if (record.host !== hostname()) return false
  if (Number.isInteger(record.pid) === false || record.pid <= 0) return false
  if (record.pid === process.pid) return false
  try {
    process.kill(record.pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

/**
 * Take the deletion lease for `ownerPath`, or fail closed.
 *
 * One staging file is written per attempt and hard-linked onto the lease path;
 * the staging link is always dropped, so a crash between link and drop leaves
 * exactly the lease (recoverable) and never a permanent stray.
 */
export const acquireDeletionLease = ({
  storeBasePath,
  ownerPath,
  now,
}: {
  storeBasePath: AbsoluteDirPath
  ownerPath: string
  now: number
}): Effect.Effect<DeletionLease, DeletionLeaseUnavailableError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const canonicalOwnerPath = normalizeOwnerPath(ownerPath)
    const leasePath = deletionLeasePath({ storeBasePath, ownerPath: canonicalOwnerPath })
    const token = randomUUID()
    const record: DeletionLeaseRecord = {
      version: DELETION_LEASE_VERSION,
      ownerPath: canonicalOwnerPath,
      host: hostname(),
      pid: process.pid,
      token,
      acquiredAtMs: now,
    }
    const stagingPath = `${leasePath}.${token}.staging`

    const staged = yield* fs
      .makeDirectory(deletionLeaseDirectory(storeBasePath), { recursive: true })
      .pipe(
        Effect.andThen(fs.writeFileString(stagingPath, encodeLeaseRecord(record))),
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      )
    if (staged === false) {
      return yield* new DeletionLeaseUnavailableError({
        ownerPath: canonicalOwnerPath,
        leasePath,
        message: 'deletion lease staging file could not be written',
      })
    }

    // Link, then prove the lease at the path is OURS. Recovery makes `link`
    // alone insufficient: two acquirers can judge the same dead record
    // releasable, and the loser's `remove` can delete the winner's fresh lease
    // before linking its own (ABA). The record's token is the only ownership
    // proof, so a mismatch fails closed and — critically — removes nothing,
    // leaving the actual holder untouched.
    const linkAndClaim = Effect.gen(function* () {
      const linked = yield* fs.link(stagingPath, leasePath).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      )
      if (linked === false) return false
      const current = yield* readLeaseRecord({ fs, leasePath })
      return current?.token === token
    })
    const acquired = yield* Effect.gen(function* () {
      if ((yield* linkAndClaim) === true) return true
      // Contended: recover only a provably dead same-host holder, then retry once.
      const existing = yield* readLeaseRecord({ fs, leasePath })
      if (existing === undefined || isProvablyReleasable(existing) === false) return false
      const removed = yield* fs.remove(leasePath).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      )
      if (removed === false) return false
      return yield* linkAndClaim
    })

    yield* fs.remove(stagingPath).pipe(Effect.orElseSucceed(() => undefined))

    if (acquired === false) {
      return yield* new DeletionLeaseUnavailableError({
        ownerPath: canonicalOwnerPath,
        leasePath,
        message: 'deletion lease is held by another holder',
      })
    }

    return { leasePath, ownerPath: canonicalOwnerPath, token }
  })

/**
 * Release a held lease.
 *
 * The record is re-read and the token compared so a lease already recovered by
 * another holder is never deleted out from under it.
 */
export const releaseDeletionLease = (
  lease: DeletionLease,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const record = yield* readLeaseRecord({ fs, leasePath: lease.leasePath })
    if (record?.token !== lease.token) return
    yield* fs.remove(lease.leasePath).pipe(Effect.orElseSucceed(() => undefined))
  })

/**
 * Run `effect` while holding the deletion lease for `ownerPath`.
 *
 * The lease is released on every exit path, including interruption.
 */
export const withDeletionLease =
  ({
    storeBasePath,
    ownerPath,
    now,
  }: {
    storeBasePath: AbsoluteDirPath
    ownerPath: string
    now: number
  }) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | DeletionLeaseUnavailableError, R | FileSystem.FileSystem> =>
    Effect.acquireUseRelease(
      acquireDeletionLease({ storeBasePath, ownerPath, now }),
      () => effect,
      (lease) => releaseDeletionLease(lease),
    )
