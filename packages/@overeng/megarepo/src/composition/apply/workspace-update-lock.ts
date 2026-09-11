import { randomBytes } from 'node:crypto'
import { link, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises'
import * as NodePath from 'node:path'

import { Effect, Schema } from 'effect'

import {
  WORKSPACE_UPDATE_LOCK_PATH,
  WORKSPACE_UPDATE_LOCK_SCHEMA,
  WorkspaceUpdateLockError,
  WorkspaceUpdateLockOwnerSchema,
  WorkspaceUpdateLockTokenSchema,
  type WorkspaceUpdateLockOwner,
} from './workspace-update-lock-schema.ts'

const strictParseOptions = { errors: 'all', onExcessProperty: 'error' } as const
const LockOwnerJson = Schema.fromJsonString(WorkspaceUpdateLockOwnerSchema)
const decodeLockToken = Schema.decodeUnknownSync(WorkspaceUpdateLockTokenSchema, strictParseOptions)

/** Conservative process-liveness result used by exact-token recovery. */
export type WorkspaceUpdateOwnerProcessState = 'alive' | 'dead' | 'unknown'

/** Durability, token, and process seams used to prove the lock protocol. */
export interface WorkspaceUpdateLockRuntime {
  readonly token?: () => string
  readonly processAlive?: (pid: number) => Promise<WorkspaceUpdateOwnerProcessState>
  /** Test seam which must call `sync` to retain the durability guarantee. */
  readonly directoryFsync?: (input: {
    readonly path: string
    readonly sync: () => Promise<void>
  }) => Promise<void>
}

/** Opaque ownership evidence required for ordinary release. */
export interface HeldWorkspaceUpdateLock {
  readonly workspaceRoot: string
  readonly lockPath: string
  readonly ownerPath: string
  readonly owner: WorkspaceUpdateLockOwner
  readonly bytes: string
  readonly dev: number
  readonly ino: number
}

const failure = ({
  reason,
  path,
  message,
  recoveryPaths = [],
  cause,
}: {
  readonly reason: WorkspaceUpdateLockError['reason']
  readonly path: string
  readonly message: string
  readonly recoveryPaths?: ReadonlyArray<string>
  readonly cause?: unknown
}): WorkspaceUpdateLockError =>
  new WorkspaceUpdateLockError({ reason, path, message, recoveryPaths, cause })

const canonicalOwner = (owner: WorkspaceUpdateLockOwner): string =>
  `${JSON.stringify({ schema: owner.schema, token: owner.token, pid: owner.pid })}\n`

const decodeCanonicalOwner = ({
  bytes,
  path,
}: {
  readonly bytes: string
  readonly path: string
}) => {
  let owner: WorkspaceUpdateLockOwner
  try {
    owner = Schema.decodeSync(LockOwnerJson, strictParseOptions)(bytes)
  } catch (cause) {
    throw failure({
      reason: 'RecoveryRefused',
      path,
      message: `Workspace update lock owner at '${path}' is malformed`,
      recoveryPaths: [path],
      cause,
    })
  }
  if (canonicalOwner(owner) !== bytes) {
    throw failure({
      reason: 'RecoveryRefused',
      path,
      message: `Workspace update lock owner at '${path}' is not canonical`,
      recoveryPaths: [path],
    })
  }
  return owner
}

const isErrno = (...[cause, code]: readonly [unknown, string]): boolean =>
  typeof cause === 'object' &&
  cause !== null &&
  'code' in cause &&
  (cause as { readonly code?: unknown }).code === code

const syncDirectoryNative = async (path: string): Promise<void> => {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const syncDirectory = async ({
  path,
  runtime,
}: {
  readonly path: string
  readonly runtime: Pick<WorkspaceUpdateLockRuntime, 'directoryFsync'>
}): Promise<void> => {
  const sync = (): Promise<void> => syncDirectoryNative(path)
  await (runtime.directoryFsync?.({ path, sync }) ?? sync())
}

const lockPaths = (rawWorkspaceRoot: string) => {
  const workspaceRoot = NodePath.resolve(rawWorkspaceRoot)
  const parent = NodePath.join(workspaceRoot, '.megarepo')
  return {
    workspaceRoot,
    parent,
    lockPath: NodePath.join(workspaceRoot, WORKSPACE_UPDATE_LOCK_PATH),
  }
}

const ensureLockParent = async ({
  workspaceRoot,
  parent,
  runtime,
}: {
  readonly workspaceRoot: string
  readonly parent: string
  readonly runtime: Pick<WorkspaceUpdateLockRuntime, 'directoryFsync'>
}): Promise<void> => {
  const root = await lstat(workspaceRoot)
  if (root.isDirectory() === false || root.isSymbolicLink() === true) {
    throw failure({
      reason: 'IoFailure',
      path: workspaceRoot,
      message: `Workspace root must be a real directory: '${workspaceRoot}'`,
    })
  }
  try {
    await mkdir(parent, { mode: 0o700 })
    await syncDirectory({ path: workspaceRoot, runtime })
  } catch (cause) {
    if (isErrno(cause, 'EEXIST') === false) throw cause
    const info = await lstat(parent)
    if (info.isDirectory() === false || info.isSymbolicLink() === true) {
      throw failure({
        reason: 'IoFailure',
        path: parent,
        message: `Workspace lock parent must be a real directory: '${parent}'`,
      })
    }
  }
}

const lockHeldFailure = async ({
  workspaceRoot,
  lockPath,
  cause,
}: {
  readonly workspaceRoot: string
  readonly lockPath: string
  readonly cause: unknown
}): Promise<WorkspaceUpdateLockError> => {
  try {
    const bytes = await readFile(lockPath, 'utf8')
    const owner = decodeCanonicalOwner({ bytes, path: lockPath })
    return failure({
      reason: 'LockHeld',
      path: lockPath,
      message:
        `Workspace update for '${workspaceRoot}' is locked by pid ${owner.pid} with token ` +
        `'${owner.token}'. After that exact owner exits, recover it through mr using this token.`,
      recoveryPaths: [lockPath, `${lockPath}.owner-${owner.token}`],
      cause,
    })
  } catch (ownerCause) {
    return failure({
      reason: 'LockHeld',
      path: lockPath,
      message:
        `Workspace update for '${workspaceRoot}' is locked, but its owner record is malformed or unreadable. ` +
        `Exact-token recovery is unavailable and deletion is refused.`,
      recoveryPaths: [lockPath],
      cause: ownerCause,
    })
  }
}

const normalizeFailure = ({
  cause,
  path,
  message,
  reason = 'IoFailure',
  recoveryPaths = [],
}: {
  readonly cause: unknown
  readonly path: string
  readonly message: string
  readonly reason?: WorkspaceUpdateLockError['reason']
  readonly recoveryPaths?: ReadonlyArray<string>
}): WorkspaceUpdateLockError =>
  cause instanceof WorkspaceUpdateLockError
    ? cause
    : failure({ reason, path, message, recoveryPaths, cause })

/** Acquire `.megarepo/workspace-update.lock` with hardlink no-replace ownership. */
export const acquireWorkspaceUpdateLock = ({
  workspaceRoot: rawWorkspaceRoot,
  runtime = {},
}: {
  readonly workspaceRoot: string
  readonly runtime?: Pick<WorkspaceUpdateLockRuntime, 'token' | 'directoryFsync'>
}): Effect.Effect<HeldWorkspaceUpdateLock, WorkspaceUpdateLockError> => {
  const paths = lockPaths(rawWorkspaceRoot)
  return Effect.tryPromise({
    try: async () => {
      await ensureLockParent({ ...paths, runtime })
      const token = decodeLockToken(runtime.token?.() ?? randomBytes(16).toString('hex'))
      const owner: WorkspaceUpdateLockOwner = {
        schema: WORKSPACE_UPDATE_LOCK_SCHEMA,
        token,
        pid: process.pid,
      }
      const bytes = canonicalOwner(owner)
      const ownerPath = `${paths.lockPath}.owner-${token}`
      let ownerCreated = false
      let linked = false
      try {
        const handle = await open(ownerPath, 'wx', 0o600)
        ownerCreated = true
        try {
          await handle.writeFile(bytes, 'utf8')
          await handle.sync()
        } finally {
          await handle.close()
        }
        await link(ownerPath, paths.lockPath)
        linked = true
        await syncDirectory({ path: paths.parent, runtime })
        const identity = await lstat(ownerPath)
        return {
          workspaceRoot: paths.workspaceRoot,
          lockPath: paths.lockPath,
          ownerPath,
          owner,
          bytes,
          dev: identity.dev,
          ino: identity.ino,
        }
      } catch (cause) {
        const cleanupFailures: unknown[] = []
        if (linked === true) {
          await unlink(paths.lockPath).catch((cleanupCause: unknown) => {
            cleanupFailures.push(cleanupCause)
          })
        }
        if (ownerCreated === true) {
          await unlink(ownerPath).catch((cleanupCause: unknown) => {
            cleanupFailures.push(cleanupCause)
          })
        }
        if (linked === true || ownerCreated === true) {
          await syncDirectory({ path: paths.parent, runtime }).catch((cleanupCause: unknown) => {
            cleanupFailures.push(cleanupCause)
          })
        }
        if (cleanupFailures.length > 0) {
          throw failure({
            reason: 'IoFailure',
            path: paths.lockPath,
            message: `Workspace update lock candidate cleanup failed for '${paths.lockPath}'`,
            recoveryPaths: [paths.lockPath, ownerPath],
            cause: new AggregateError([cause, ...cleanupFailures]),
          })
        }
        if (isErrno(cause, 'EEXIST') === true) {
          throw await lockHeldFailure({
            workspaceRoot: paths.workspaceRoot,
            lockPath: paths.lockPath,
            cause,
          })
        }
        throw cause
      }
    },
    catch: (cause) =>
      normalizeFailure({
        cause,
        path: paths.lockPath,
        message: `Cannot acquire workspace update lock '${paths.lockPath}'`,
        recoveryPaths: [paths.lockPath],
      }),
  })
}

/** Release only the exact hardlinked owner acquired by this process. */
export const releaseWorkspaceUpdateLock = ({
  held,
  runtime = {},
}: {
  readonly held: HeldWorkspaceUpdateLock
  readonly runtime?: Pick<WorkspaceUpdateLockRuntime, 'directoryFsync'>
}): Effect.Effect<void, WorkspaceUpdateLockError> =>
  Effect.tryPromise({
    try: async () => {
      const [lockIdentity, ownerIdentity, lockBytes, ownerBytes] = await Promise.all([
        lstat(held.lockPath),
        lstat(held.ownerPath),
        readFile(held.lockPath, 'utf8'),
        readFile(held.ownerPath, 'utf8'),
      ])
      if (
        lockIdentity.dev !== held.dev ||
        lockIdentity.ino !== held.ino ||
        ownerIdentity.dev !== held.dev ||
        ownerIdentity.ino !== held.ino ||
        lockBytes !== held.bytes ||
        ownerBytes !== held.bytes
      ) {
        throw failure({
          reason: 'ReleaseRefused',
          path: held.lockPath,
          message: 'Workspace update lock ownership changed before release',
          recoveryPaths: [held.lockPath, held.ownerPath],
        })
      }
      await unlink(held.lockPath)
      await unlink(held.ownerPath)
      await syncDirectory({ path: NodePath.dirname(held.lockPath), runtime })
    },
    catch: (cause) =>
      normalizeFailure({
        cause,
        path: held.lockPath,
        message: `Cannot release workspace update lock '${held.lockPath}'`,
        reason: 'ReleaseRefused',
        recoveryPaths: [held.lockPath, held.ownerPath],
      }),
  })

const defaultProcessAlive = async (pid: number): Promise<WorkspaceUpdateOwnerProcessState> => {
  if (process.platform !== 'linux' && process.platform !== 'darwin') return 'unknown'
  try {
    process.kill(pid, 0)
    return 'alive'
  } catch (cause) {
    return isErrno(cause, 'ESRCH') === true ? 'dead' : 'unknown'
  }
}

/** Recover only a canonical, exact-token lock whose process is definitely dead. */
export const recoverStaleWorkspaceUpdateLock = ({
  workspaceRoot: rawWorkspaceRoot,
  token: rawToken,
  runtime = {},
}: {
  readonly workspaceRoot: string
  readonly token: string
  readonly runtime?: Pick<WorkspaceUpdateLockRuntime, 'processAlive' | 'directoryFsync'>
}): Effect.Effect<void, WorkspaceUpdateLockError> => {
  const paths = lockPaths(rawWorkspaceRoot)
  return Effect.tryPromise({
    try: async () => {
      const token = decodeLockToken(rawToken)
      const lockBytes = await readFile(paths.lockPath, 'utf8')
      const owner = decodeCanonicalOwner({ bytes: lockBytes, path: paths.lockPath })
      const ownerPath = `${paths.lockPath}.owner-${owner.token}`
      if (token !== owner.token) {
        throw failure({
          reason: 'RecoveryRefused',
          path: paths.lockPath,
          message: `Recovery token does not match workspace update owner token '${owner.token}'`,
          recoveryPaths: [paths.lockPath, ownerPath],
        })
      }
      const state = await (runtime.processAlive?.(owner.pid) ?? defaultProcessAlive(owner.pid))
      if (state !== 'dead') {
        throw failure({
          reason: 'RecoveryRefused',
          path: paths.lockPath,
          message:
            `Workspace update owner pid ${owner.pid} with token '${owner.token}' is ${state}; ` +
            `only a definitely dead exact-token owner may be recovered.`,
          recoveryPaths: [paths.lockPath, ownerPath],
        })
      }
      const [lockIdentity, ownerIdentity, ownerBytes] = await Promise.all([
        lstat(paths.lockPath),
        lstat(ownerPath),
        readFile(ownerPath, 'utf8'),
      ])
      if (
        lockIdentity.dev !== ownerIdentity.dev ||
        lockIdentity.ino !== ownerIdentity.ino ||
        ownerBytes !== lockBytes
      ) {
        throw failure({
          reason: 'RecoveryRefused',
          path: paths.lockPath,
          message: 'Exact-token workspace update owner identity changed during recovery',
          recoveryPaths: [paths.lockPath, ownerPath],
        })
      }
      await unlink(ownerPath)
      const claimedIdentity = await lstat(paths.lockPath)
      if (claimedIdentity.dev !== lockIdentity.dev || claimedIdentity.ino !== lockIdentity.ino) {
        throw failure({
          reason: 'RecoveryRefused',
          path: paths.lockPath,
          message: 'Workspace update lock identity changed after exact owner claim',
          recoveryPaths: [paths.lockPath],
        })
      }
      await unlink(paths.lockPath)
      await syncDirectory({ path: paths.parent, runtime })
    },
    catch: (cause) =>
      normalizeFailure({
        cause,
        path: paths.lockPath,
        message: `Cannot recover workspace update lock '${paths.lockPath}'`,
        reason: 'RecoveryRefused',
        recoveryPaths: [paths.lockPath],
      }),
  })
}
