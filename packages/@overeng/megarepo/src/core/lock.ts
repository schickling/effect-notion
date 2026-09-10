/**
 * Megarepo Lock File Management
 *
 * The lock file (`megarepo.lock`) records resolved state for CI reproducibility:
 * - Exact commit SHAs for each member
 * - Pin status (whether a member should be updated)
 * - Timestamp of when the entry was resolved
 *
 * Note: Local path sources are NOT in the lock file - they're already local.
 */

import { Effect, Option, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { type PlatformError } from 'effect/PlatformError'

import type { AbsoluteFilePath } from '@overeng/effect-path'

// =============================================================================
// Lock File Schema
// =============================================================================

/** Lock file version - increment on breaking changes */
export const LOCK_FILE_VERSION = 1

/** Lock file name */
export const LOCK_FILE_NAME = 'megarepo.lock'

/**
 * A locked member entry in the lock file
 */
export class LockedMember extends Schema.Class<LockedMember>('LockedMember')({
  /** Resolved URL (GitHub shorthand expanded) */
  url: Schema.String,

  /** Original ref from config (for context) */
  ref: Schema.String,

  /** Resolved commit SHA (40 chars) */
  commit: Schema.String,

  /** If true, `mr update` won't refresh this member */
  pinned: Schema.Boolean,

  /** ISO timestamp when this entry was resolved */
  lockedAt: Schema.String,
}) {}

/**
 * Lock file schema
 */
export class LockFile extends Schema.Class<LockFile>('LockFile')({
  /** Lock file format version */
  version: Schema.Finite,

  /** Locked members (name -> entry) */
  members: Schema.Record(Schema.String, LockedMember),
}) {}

// =============================================================================
// Lock File Operations
// =============================================================================

/**
 * Read and parse a lock file
 */
export const readLockFile = (
  lockPath: AbsoluteFilePath,
): Effect.Effect<
  Option.Option<LockFile>,
  PlatformError | Schema.SchemaError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    const exists = yield* fs.exists(lockPath)
    if (exists === false) {
      return Option.none()
    }

    const content = yield* fs.readFileString(lockPath)
    const parsed = yield* Schema.decodeEffect(Schema.fromJsonString(LockFile))(content)
    return Option.some(parsed)
  })

/**
 * Write a lock file to disk
 */
export const writeLockFile = ({
  lockPath,
  lockFile,
}: {
  lockPath: AbsoluteFilePath
  lockFile: LockFile
}): Effect.Effect<void, PlatformError | Schema.SchemaError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const content = yield* Schema.encodeEffect(Schema.fromJsonString(LockFile, { space: 2 }))(
      lockFile,
    )
    yield* fs.writeFileString(lockPath, content + '\n')
  })

/**
 * Create a new empty lock file
 */
export const createEmptyLockFile = (): LockFile =>
  new LockFile({
    version: LOCK_FILE_VERSION,
    members: {},
  })

/**
 * Create a new locked member entry
 */
export const createLockedMember = (args: {
  url: string
  ref: string
  commit: string
  pinned?: boolean
}): LockedMember =>
  new LockedMember({
    url: args.url,
    ref: args.ref,
    commit: args.commit,
    pinned: args.pinned ?? false,
    lockedAt: new Date().toISOString(),
  })

/**
 * Update a member in the lock file
 */
export const updateLockedMember = ({
  lockFile,
  memberName,
  member,
}: {
  lockFile: LockFile
  memberName: string
  member: LockedMember
}): LockFile =>
  new LockFile({
    ...lockFile,
    members: {
      ...lockFile.members,
      [memberName]: member,
    },
  })

/**
 * Check if two locked members are equivalent (ignoring lockedAt)
 */
export const lockedMembersEqual = ({ a, b }: { a: LockedMember; b: LockedMember }): boolean =>
  a.url === b.url && a.ref === b.ref && a.commit === b.commit && a.pinned === b.pinned

/**
 * Update or create a member in the lock file, only updating lockedAt if something changed.
 * This prevents unnecessary timestamp updates when nothing actually changed.
 */
export const upsertLockedMember = ({
  lockFile,
  memberName,
  update,
}: {
  lockFile: LockFile
  memberName: string
  update: {
    url: string
    ref: string
    commit: string
    pinned?: boolean
  }
}): LockFile => {
  const existing = lockFile.members[memberName]
  const pinned = update.pinned ?? false

  // If member exists and nothing changed, return unchanged lock file
  if (
    existing !== undefined &&
    existing.url === update.url &&
    existing.ref === update.ref &&
    existing.commit === update.commit &&
    existing.pinned === pinned
  ) {
    return lockFile
  }

  // Something changed (or new member), create new entry with fresh timestamp
  return updateLockedMember({
    lockFile,
    memberName,
    member: createLockedMember({
      url: update.url,
      ref: update.ref,
      commit: update.commit,
      pinned,
    }),
  })
}

/**
 * Remove a member from the lock file
 */
export const removeLockedMember = ({
  lockFile,
  memberName,
}: {
  lockFile: LockFile
  memberName: string
}): LockFile => {
  const { [memberName]: _, ...rest } = lockFile.members
  return new LockFile({
    ...lockFile,
    members: rest,
  })
}

/**
 * Pin a member in the lock file
 */
export const pinMember = ({
  lockFile,
  memberName,
}: {
  lockFile: LockFile
  memberName: string
}): LockFile => {
  const member = lockFile.members[memberName]
  if (member === undefined) return lockFile

  return updateLockedMember({
    lockFile,
    memberName,
    member: new LockedMember({
      ...member,
      pinned: true,
      lockedAt: new Date().toISOString(),
    }),
  })
}

/**
 * Unpin a member in the lock file
 */
export const unpinMember = ({
  lockFile,
  memberName,
}: {
  lockFile: LockFile
  memberName: string
}): LockFile => {
  const member = lockFile.members[memberName]
  if (member === undefined) return lockFile

  return updateLockedMember({
    lockFile,
    memberName,
    member: new LockedMember({
      ...member,
      pinned: false,
      lockedAt: new Date().toISOString(),
    }),
  })
}

/**
 * Get a member from the lock file
 */
export const getLockedMember = ({
  lockFile,
  memberName,
}: {
  lockFile: LockFile
  memberName: string
}): Option.Option<LockedMember> => {
  return Option.fromUndefinedOr(lockFile.members[memberName])
}

/**
 * Check if a member is in the lock file
 */
export const hasMember = ({
  lockFile,
  memberName,
}: {
  lockFile: LockFile
  memberName: string
}): boolean => {
  return memberName in lockFile.members
}

/**
 * Check if a member is pinned
 */
export const isPinned = ({
  lockFile,
  memberName,
}: {
  lockFile: LockFile
  memberName: string
}): boolean => {
  return lockFile.members[memberName]?.pinned ?? false
}

// =============================================================================
// Lock File Staleness Detection
// =============================================================================

/**
 * Result of comparing lock file against config
 */
export interface LockStalenessCheck {
  /** Members in config but not in lock */
  readonly addedMembers: ReadonlyArray<string>
  /** Members in lock but not in config */
  readonly removedMembers: ReadonlyArray<string>
  /** Whether the lock is stale (has added or removed members) */
  readonly isStale: boolean
}

/**
 * Check if lock file is stale compared to config members
 * Only checks member names, not URLs or refs
 */
export const checkLockStaleness = ({
  lockFile,
  configMemberNames,
}: {
  /** The lock file to check */
  lockFile: LockFile
  /** Set of member names from config (remote sources only) */
  configMemberNames: ReadonlySet<string>
}): LockStalenessCheck => {
  const lockMemberNames = new Set(Object.keys(lockFile.members))

  const addedMembers = [...configMemberNames].filter((name) => !lockMemberNames.has(name))
  const removedMembers = [...lockMemberNames].filter((name) => !configMemberNames.has(name))

  return {
    addedMembers,
    removedMembers,
    isStale: addedMembers.length > 0 || removedMembers.length > 0,
  }
}

/**
 * Synchronize lock file with config - remove members that are no longer in config
 */
export const syncLockWithConfig = ({
  lockFile,
  configMemberNames,
}: {
  lockFile: LockFile
  configMemberNames: ReadonlySet<string>
}): LockFile => {
  const members: Record<string, LockedMember> = {}

  for (const [name, member] of Object.entries(lockFile.members)) {
    if (configMemberNames.has(name) === true) {
      members[name] = member
    }
  }

  return new LockFile({
    ...lockFile,
    members,
  })
}
