import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import type { Stats } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises'
import * as NodePath from 'node:path'

import { Effect, Schema } from 'effect'
import type * as FileSystem from 'effect/FileSystem'

import {
  assertOwnedCpAMountIdentity,
  encodeOwnedCpAMountMetadata,
  inspectOwnedCpAMount,
  readOwnedCpAMountMetadata,
  scanR6BuildArtifactTree,
  scanR6ProtectedMount,
  scanR6ProtectedTree,
  writeOwnedCpAMountMetadata,
  type OwnedCpAMountIdentity,
  type OwnedCpAMountMetadata,
  type R6DistOverlayManifestIdentity,
  type R6TreeScan,
} from '../mounts/member-mount-r6.ts'
import {
  DIST_OVERLAY_TRANSACTION_VERSION,
  DistOverlayError,
  DistOverlayPublishRequest,
  DistOverlayRecoveryRequest,
  DistOverlayTransaction,
  distOverlayTransactionPath,
  type DistOverlayOperation,
  type DistOverlayPhase,
  type DistOverlayPlan,
  type DistOverlayResult,
  type DistOverlayTransaction as DistOverlayTransactionType,
} from './dist-overlay-lifecycle-schema.ts'
import { hasDeclaredDistOverlay } from './dist-overlay-schema.ts'

export { publishDistOverlay, recoverDistOverlay }

/** Durable directory checkpoints for overlay namespace mutations. */
export type DistOverlayDirectorySyncReason =
  | 'PublishDestinationParent'
  | 'PublishStageParent'
  | 'RollbackDestinationParent'
  | 'RollbackStageParent'
  | 'RecoveryDestinationParent'
  | 'RecoveryStageParent'
  | 'CleanupStageParent'

/** Required caller-lock assertion plus deterministic lifecycle fault seams. */
export interface DistOverlayRuntime {
  readonly assertUpdateLockOwned: (input: {
    readonly workspaceRoot: string
    readonly member: string
  }) => Promise<void>
  readonly nonce?: () => string
  readonly afterPhase?: (phase: DistOverlayPhase) => Promise<void>
  readonly beforePublish?: (input: {
    readonly mountPath: string
    readonly destinationPath: string
    readonly stagePath: string
  }) => Promise<void>
  readonly beforeMetadataWrite?: (metadata: OwnedCpAMountMetadata) => Promise<void>
  /** Test/telemetry seam that must call `sync` unless deliberately injecting failure. */
  readonly directoryFsync?: (input: {
    readonly path: string
    readonly reason: DistOverlayDirectorySyncReason
    readonly sync: () => Promise<void>
  }) => Promise<void>
}

const strictParseOptions = { errors: 'all', onExcessProperty: 'error' } as const
const TransactionJson = Schema.fromJsonString(DistOverlayTransaction, { space: 2 })

const failure = ({
  reason,
  path,
  message,
  recoveryPaths = [],
  cause,
}: {
  reason: DistOverlayError['reason']
  path: string
  message: string
  recoveryPaths?: ReadonlyArray<string>
  cause?: unknown
}): DistOverlayError =>
  new DistOverlayError({
    reason,
    path,
    message,
    recoveryPaths: [...recoveryPaths],
    ...(cause === undefined ? {} : { cause }),
  })

const io = <A>({
  path,
  message,
  reason = 'IoFailure',
  recoveryPaths = [],
  try: run,
}: {
  path: string
  message: string
  reason?: DistOverlayError['reason']
  recoveryPaths?: ReadonlyArray<string>
  try: () => Promise<A>
}): Effect.Effect<A, DistOverlayError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      cause instanceof DistOverlayError
        ? cause
        : failure({ reason, path, message, recoveryPaths, cause }),
  })

const assertRealDirectory = ({
  path,
  label,
}: {
  path: string
  label: string
}): Effect.Effect<void, DistOverlayError> =>
  io({
    path,
    message: `${label} is missing, foreign, or a symlink: '${path}'`,
    reason: 'DestinationRefused',
    try: async () => {
      const info = await lstat(path)
      if (info.isDirectory() === false || info.isSymbolicLink() === true) {
        throw new Error(`${label} is not a real directory: '${path}'`)
      }
    },
  })

const ensureControlDirectory = ({
  workspaceRoot,
  name,
  create = true,
}: {
  workspaceRoot: string
  name: 'overlay-stages' | 'overlay-transactions'
  create?: boolean
}): Effect.Effect<string, DistOverlayError> =>
  Effect.gen(function* () {
    const reposPath = NodePath.join(workspaceRoot, 'repos')
    const controlRoot = NodePath.join(reposPath, '.mr')
    yield* assertRealDirectory({ path: workspaceRoot, label: 'Workspace root' })
    yield* assertRealDirectory({ path: reposPath, label: 'Workspace repos root' })
    yield* assertRealDirectory({ path: controlRoot, label: 'Workspace control root' })
    const path = NodePath.join(controlRoot, name)
    if (create === true) {
      yield* io({
        path,
        message: `Cannot create workspace control directory '${path}'`,
        reason: 'DestinationRefused',
        try: async () => {
          try {
            await mkdir(path, { recursive: false, mode: 0o755 })
          } catch (cause) {
            if (
              typeof cause !== 'object' ||
              cause === null ||
              'code' in cause === false ||
              cause.code !== 'EEXIST'
            )
              throw cause
          }
        },
      })
    }
    yield* assertRealDirectory({ path, label: 'Workspace overlay control directory' })
    return path
  })

const identity = (info: Pick<Stats, 'dev' | 'ino'>): OwnedCpAMountIdentity => ({
  dev: info.dev,
  ino: info.ino,
})
const identitiesEqual = ({
  left,
  right,
}: {
  left: OwnedCpAMountIdentity
  right: OwnedCpAMountIdentity
}): boolean => left.dev === right.dev && left.ino === right.ino
const metadataEqual = ({
  left,
  right,
}: {
  left: OwnedCpAMountMetadata
  right: OwnedCpAMountMetadata
}): boolean => encodeOwnedCpAMountMetadata(left) === encodeOwnedCpAMountMetadata(right)

const assertLock = ({
  runtime,
  workspaceRoot,
  member,
}: {
  runtime: DistOverlayRuntime
  workspaceRoot: string
  member: string
}): Effect.Effect<void, DistOverlayError> =>
  io({
    path: workspaceRoot,
    message: `Workspace update lock is not owned for member '${member}'`,
    reason: 'UpdateLockNotOwned',
    try: () => runtime.assertUpdateLockOwned({ workspaceRoot, member }),
  })

const lstatMaybe = (path: string): Effect.Effect<Stats | undefined, DistOverlayError> =>
  Effect.tryPromise({
    try: async () => {
      try {
        return await lstat(path)
      } catch (cause) {
        if (
          typeof cause === 'object' &&
          cause !== null &&
          'code' in cause &&
          cause.code === 'ENOENT'
        )
          return undefined
        throw cause
      }
    },
    catch: (cause) =>
      failure({ reason: 'IoFailure', path, message: `Cannot lstat '${path}'`, cause }),
  })

const validateCommandPath = ({
  path,
  name,
}: {
  path: string
  name: 'cp' | 'mv'
}): Effect.Effect<void, DistOverlayError> =>
  io({
    path,
    message: `Cannot inspect pinned ${name} path '${path}'`,
    reason: 'InvalidRequest',
    try: async () => {
      const info = await stat(path)
      if (info.isFile() === false || (info.mode & 0o111) === 0) {
        throw new Error(`${name} path is not a real executable file: '${path}'`)
      }
    },
  })

const runCommand = ({
  binary,
  args,
  path,
  commandName,
  recoveryPaths = [],
}: {
  binary: string
  args: ReadonlyArray<string>
  path: string
  commandName: string
  recoveryPaths?: ReadonlyArray<string>
}): Effect.Effect<void, DistOverlayError> =>
  io({
    path,
    message: `${commandName} failed for '${path}'`,
    reason: 'CommandFailure',
    recoveryPaths,
    try: () =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(binary, [...args], { stdio: ['ignore', 'pipe', 'pipe'] })
        const stderr: Array<Buffer> = []
        child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
        child.on('error', reject)
        child.on('close', (code, signal) => {
          if (code === 0) resolve()
          else
            reject(
              new Error(
                `${commandName} exited code=${String(code)} signal=${String(signal)}: ${Buffer.concat(stderr).toString('utf8')}`,
              ),
            )
        })
      }),
  })

const syncDirectory = async (path: string): Promise<void> => {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const syncLifecycleDirectory = ({
  runtime,
  path,
  reason,
}: {
  runtime: DistOverlayRuntime
  path: string
  reason: DistOverlayDirectorySyncReason
}): Effect.Effect<void, DistOverlayError> =>
  io({
    path,
    message: `Cannot durably sync overlay directory '${path}' after ${reason}`,
    recoveryPaths: [path],
    try: () =>
      runtime.directoryFsync?.({ path, reason, sync: () => syncDirectory(path) }) ??
      syncDirectory(path),
  })

const syncOverlayMoveParents = ({
  runtime,
  destinationPath,
  stagePath,
  kind,
}: {
  runtime: DistOverlayRuntime
  destinationPath: string
  stagePath: string
  kind: 'Publish' | 'Rollback' | 'Recovery'
}): Effect.Effect<void, DistOverlayError> =>
  Effect.gen(function* () {
    yield* syncLifecycleDirectory({
      runtime,
      path: NodePath.dirname(destinationPath),
      reason: `${kind}DestinationParent`,
    })
    yield* syncLifecycleDirectory({
      runtime,
      path: NodePath.dirname(stagePath),
      reason: `${kind}StageParent`,
    })
  })

const syncOverlayStageCleanup = ({
  runtime,
  stagePath,
}: {
  runtime: DistOverlayRuntime
  stagePath: string
}): Effect.Effect<void, DistOverlayError> =>
  syncLifecycleDirectory({
    runtime,
    path: NodePath.dirname(stagePath),
    reason: 'CleanupStageParent',
  })

const encodeTransaction = (transaction: DistOverlayTransactionType): string =>
  `${Schema.encodeSync(TransactionJson)(transaction)}
`

const writeTransactionExclusive = ({
  path,
  transaction,
}: {
  path: string
  transaction: DistOverlayTransactionType
}): Effect.Effect<void, DistOverlayError> =>
  io({
    path,
    message: `Cannot create overlay transaction '${path}'`,
    reason: 'TransactionCollision',
    recoveryPaths: [path],
    try: async () => {
      const handle = await open(path, 'wx', 0o600)
      try {
        await handle.writeFile(encodeTransaction(transaction), 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await syncDirectory(NodePath.dirname(path))
    },
  })

const replaceTransaction = ({
  path,
  transaction,
}: {
  path: string
  transaction: DistOverlayTransactionType
}): Effect.Effect<void, DistOverlayError> =>
  io({
    path,
    message: `Cannot replace overlay transaction '${path}'`,
    recoveryPaths: [path],
    try: async () => {
      const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(encodeTransaction(transaction), 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, path)
      await syncDirectory(NodePath.dirname(path))
    },
  })

const removeTransaction = (path: string): Effect.Effect<void, DistOverlayError> =>
  io({
    path,
    message: `Cannot remove overlay transaction '${path}'`,
    recoveryPaths: [path],
    try: async () => {
      await unlink(path)
      await syncDirectory(NodePath.dirname(path))
    },
  })

const readTransaction = (
  path: string,
): Effect.Effect<DistOverlayTransactionType, DistOverlayError> =>
  io({
    path,
    message: `Cannot strictly read overlay transaction '${path}'`,
    reason: 'AmbiguousRecovery',
    recoveryPaths: [path],
    try: async () =>
      Schema.decodeSync(TransactionJson, strictParseOptions)(await readFile(path, 'utf8')),
  })

const persistPhase = ({
  transactionPath,
  transaction,
  phaseHint,
  runtime,
}: {
  transactionPath: string
  transaction: DistOverlayTransactionType
  phaseHint: DistOverlayPhase
  runtime: DistOverlayRuntime
}): Effect.Effect<DistOverlayTransactionType, DistOverlayError> =>
  Effect.gen(function* () {
    const next = { ...transaction, phaseHint }
    yield* replaceTransaction({ path: transactionPath, transaction: next })
    if (runtime.afterPhase !== undefined) {
      yield* io({
        path: transactionPath,
        message: `Overlay phase hook failed after '${phaseHint}'`,
        recoveryPaths: [transaction.destinationPath, transaction.stagePath, transactionPath],
        try: () => runtime.afterPhase!(phaseHint),
      })
    }
    return next
  })

const protectTree = (root: string): Effect.Effect<void, DistOverlayError> =>
  io({
    path: root,
    message: `Cannot protect overlay candidate '${root}'`,
    reason: 'ArtifactInvalid',
    try: async () => {
      const visit = async (path: string): Promise<void> => {
        const info = await lstat(path)
        if (info.isSymbolicLink() === true) return
        if (info.isDirectory() === true) {
          await Promise.all((await readdir(path)).map((child) => visit(NodePath.join(path, child))))
          await chmod(path, 0o555)
          return
        }
        if (info.isFile() === true) {
          await chmod(path, (info.mode & 0o111) === 0 ? 0o444 : 0o555)
          return
        }
        throw new Error(`Unsupported filesystem entry in overlay candidate '${path}'`)
      }
      await visit(root)
    },
  })

const unprotectDirectories = async (root: string): Promise<void> => {
  const info = await lstat(root)
  if (info.isDirectory() === false) throw new Error(`Expected owned overlay directory '${root}'`)
  const visit = async (directory: string): Promise<void> => {
    await chmod(directory, 0o755)
    const children = await readdir(directory, { withFileTypes: true })
    await Promise.all(
      children
        .filter((entry) => entry.isDirectory() === true)
        .map((entry) => visit(NodePath.join(directory, entry.name))),
    )
  }
  await visit(root)
}

const teardownDirectory = ({
  path,
  expectedIdentity,
}: {
  path: string
  expectedIdentity: OwnedCpAMountIdentity
}): Effect.Effect<void, DistOverlayError> =>
  io({
    path,
    message: `Cannot remove identity-bound overlay directory '${path}'`,
    recoveryPaths: [path],
    try: async () => {
      const info = await lstat(path)
      if (
        info.isDirectory() === false ||
        identitiesEqual({ left: identity(info), right: expectedIdentity }) === false
      ) {
        throw new Error(`Overlay directory identity changed at '${path}'`)
      }
      await unprotectDirectories(path)
      const finalInfo = await lstat(path)
      if (identitiesEqual({ left: identity(finalInfo), right: expectedIdentity }) === false) {
        throw new Error(`Overlay directory identity changed during teardown at '${path}'`)
      }
      await rm(path, { recursive: true, force: false })
    },
  })

const withWritableParent = <A>({
  parent,
  effect,
}: {
  parent: string
  effect: Effect.Effect<A, DistOverlayError>
}): Effect.Effect<A, DistOverlayError> =>
  Effect.acquireUseRelease(
    io({
      path: parent,
      message: `Cannot unprotect overlay parent '${parent}'`,
      try: () => chmod(parent, 0o755),
    }),
    () => effect,
    () =>
      io({
        path: parent,
        message: `Cannot restore protected overlay parent '${parent}'`,
        try: () => chmod(parent, 0o555),
      }).pipe(Effect.orDie),
  )

const withMovableOverlayRoots = <A>({
  paths,
  effect,
}: {
  paths: ReadonlyArray<string>
  effect: Effect.Effect<A, DistOverlayError>
}): Effect.Effect<A, DistOverlayError> =>
  Effect.acquireUseRelease(
    io({
      path: paths.join(','),
      message: `Cannot prepare protected overlay roots for an atomic directory move`,
      try: async () => {
        await Promise.all(
          paths.map(async (path) => {
            try {
              const info = await lstat(path)
              if (info.isDirectory() === false)
                throw new Error(`Expected overlay directory '${path}'`)
              await chmod(path, 0o755)
            } catch (cause) {
              if (
                typeof cause === 'object' &&
                cause !== null &&
                'code' in cause &&
                cause.code === 'ENOENT'
              )
                return
              throw cause
            }
          }),
        )
      },
    }),
    () => effect,
    () =>
      io({
        path: paths.join(','),
        message: `Cannot restore protected overlay roots after an atomic directory move`,
        try: async () => {
          await Promise.all(
            paths.map(async (path) => {
              try {
                const info = await lstat(path)
                if (info.isDirectory() === true) await chmod(path, 0o555)
              } catch (cause) {
                if (
                  typeof cause === 'object' &&
                  cause !== null &&
                  'code' in cause &&
                  cause.code === 'ENOENT'
                )
                  return
                throw cause
              }
            }),
          )
        },
      }).pipe(Effect.orDie),
  )

const moveOverlayDirectories = <A>({
  destinationParent,
  paths,
  effect,
}: {
  destinationParent: string
  paths: ReadonlyArray<string>
  effect: Effect.Effect<A, DistOverlayError>
}): Effect.Effect<A, DistOverlayError> =>
  withMovableOverlayRoots({
    paths,
    effect: withWritableParent({ parent: destinationParent, effect }),
  })

const assertNoSymlinkParents = ({
  mountPath,
  destinationPath,
}: {
  mountPath: string
  destinationPath: string
}): Effect.Effect<void, DistOverlayError> =>
  io({
    path: destinationPath,
    message: `Overlay destination has a missing, escaping, or symlink parent: '${destinationPath}'`,
    reason: 'DestinationRefused',
    try: async () => {
      const relative = NodePath.relative(mountPath, destinationPath)
      if (
        relative === '' ||
        relative.startsWith(`..${NodePath.sep}`) === true ||
        NodePath.isAbsolute(relative) === true
      ) {
        throw new Error(`Overlay destination escapes member mount: '${destinationPath}'`)
      }
      const parents = relative
        .split(NodePath.sep)
        .slice(0, -1)
        .map((_, index, segments) => NodePath.join(mountPath, ...segments.slice(0, index + 1)))
      await Promise.all(
        parents.map(async (parent) => {
          const info = await lstat(parent)
          if (info.isDirectory() === false || info.isSymbolicLink() === true) {
            throw new Error(`Overlay parent is not a real directory: '${parent}'`)
          }
        }),
      )
    },
  })

const assertIndependentFileInodes = ({
  sourceRoot,
  destinationRoot,
  scan,
}: {
  sourceRoot: string
  destinationRoot: string
  scan: R6TreeScan
}): Effect.Effect<void, DistOverlayError> =>
  io({
    path: destinationRoot,
    message: `Cannot verify independent overlay file inodes at '${destinationRoot}'`,
    reason: 'ArtifactInvalid',
    try: async () => {
      await Promise.all(
        scan.manifest.entries
          .filter((entry) => entry.kind === 'file')
          .map(async (entry) => {
            const [source, destination] = await Promise.all([
              lstat(NodePath.join(sourceRoot, entry.path)),
              lstat(NodePath.join(destinationRoot, entry.path)),
            ])
            if (source.dev === destination.dev && source.ino === destination.ino) {
              throw new Error(`cp -a reused artifact inode for '${entry.path}'`)
            }
          }),
      )
    },
  })

const nextMetadata = ({
  metadata,
  overlay,
  destination,
}: {
  metadata: OwnedCpAMountMetadata
  overlay: R6DistOverlayManifestIdentity | undefined
  destination: string
}): OwnedCpAMountMetadata => ({
  ...metadata,
  overlays: [
    ...metadata.overlays.filter((item) => item.destination !== destination),
    ...(overlay === undefined ? [] : [overlay]),
  ].toSorted((left, right) =>
    left.destination < right.destination ? -1 : left.destination > right.destination ? 1 : 0,
  ),
})

const assertMountAndMetadata = ({
  workspaceRoot,
  member,
  mountPath,
  expectedIdentity,
  expectedMetadata,
}: {
  workspaceRoot: string
  member: string
  mountPath: string
  expectedIdentity: OwnedCpAMountIdentity
  expectedMetadata: OwnedCpAMountMetadata
}): Effect.Effect<void, DistOverlayError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    yield* assertOwnedCpAMountIdentity({ path: mountPath, expected: expectedIdentity }).pipe(
      Effect.mapError((cause) =>
        failure({
          reason: 'MountIdentityMismatch',
          path: mountPath,
          message: `Owned mount inode changed for member '${member}'`,
          cause,
        }),
      ),
    )
    const actualMetadata = yield* readOwnedCpAMountMetadata({
      workspaceRoot,
      member,
      publishedPath: mountPath,
    }).pipe(
      Effect.mapError((cause) =>
        failure({
          reason: 'MetadataMismatch',
          path: mountPath,
          message: `Cannot read owned mount metadata for member '${member}'`,
          cause,
        }),
      ),
    )
    if (metadataEqual({ left: actualMetadata, right: expectedMetadata }) === false) {
      return yield* failure({
        reason: 'MetadataMismatch',
        path: mountPath,
        message: `Owned mount metadata changed for member '${member}'`,
      })
    }
    const inspected = yield* inspectOwnedCpAMount({
      workspaceRoot,
      physicalPath: mountPath,
      expected: {
        member,
        lockedCommit: expectedMetadata.lockedCommit,
        sourcePathIdentity: expectedMetadata.sourcePathIdentity,
        publishedPath: mountPath,
      },
      expectedPreExchangeIdentity: expectedIdentity,
    }).pipe(
      Effect.mapError((cause) =>
        failure({
          reason: 'MetadataMismatch',
          path: mountPath,
          message: `Cannot inspect owned mount '${mountPath}'`,
          cause,
        }),
      ),
    )
    if (
      inspected._tag !== 'Owned' ||
      metadataEqual({ left: inspected.metadata, right: expectedMetadata }) === false
    ) {
      return yield* failure({
        reason: 'MetadataMismatch',
        path: mountPath,
        message: `Owned mount content is not bound by expected metadata at '${mountPath}': ${inspected._tag}${inspected._tag === 'InvalidOwned' ? `/${inspected.reason}: ${inspected.message}` : ''}`,
        cause: inspected,
      })
    }
  })

const assertRepositoryIdentity = ({
  mountPath,
  expectedMetadata,
}: {
  mountPath: string
  expectedMetadata: OwnedCpAMountMetadata
}): Effect.Effect<void, DistOverlayError> =>
  scanR6ProtectedMount({
    root: mountPath,
    declaredOverlays: expectedMetadata.declaredOverlays,
  }).pipe(
    Effect.mapError((cause) =>
      failure({
        reason: 'RepositoryIdentityChanged',
        path: mountPath,
        message: `Cannot verify repository identity at '${mountPath}'`,
        cause,
      }),
    ),
    Effect.flatMap((scan) =>
      scan.repository.digest === expectedMetadata.repository.digest &&
      scan.repository.count === expectedMetadata.repository.count
        ? Effect.void
        : Effect.fail(
            failure({
              reason: 'RepositoryIdentityChanged',
              path: mountPath,
              message: `Repository R6 identity changed while publishing an overlay at '${mountPath}'`,
            }),
          ),
    ),
  )

const validateExistingOverlay = ({
  destinationPath,
  record,
}: {
  destinationPath: string
  record: R6DistOverlayManifestIdentity | undefined
}): Effect.Effect<OwnedCpAMountIdentity | undefined, DistOverlayError> =>
  Effect.gen(function* () {
    const info = yield* lstatMaybe(destinationPath)
    if (info === undefined) {
      if (record !== undefined) {
        return yield* failure({
          reason: 'DestinationRefused',
          path: destinationPath,
          message: `Published overlay metadata exists but destination is missing at '${destinationPath}'`,
        })
      }
      return undefined
    }
    if (info.isDirectory() === false || record === undefined) {
      return yield* failure({
        reason: 'DestinationRefused',
        path: destinationPath,
        message: `Refusing foreign or undeclared overlay destination '${destinationPath}'`,
      })
    }
    const scan = yield* scanR6ProtectedTree({ root: destinationPath }).pipe(
      Effect.mapError((cause) =>
        failure({
          reason: 'DestinationRefused',
          path: destinationPath,
          message: `Owned overlay is invalid at '${destinationPath}'`,
          cause,
        }),
      ),
    )
    if (scan.digest !== record.digest || scan.count !== record.count) {
      return yield* failure({
        reason: 'DestinationRefused',
        path: destinationPath,
        message: `Owned overlay identity does not match metadata at '${destinationPath}'`,
      })
    }
    return identity(info)
  })

const validateTreeIdentity = ({
  path,
  expectedIdentity,
  record,
}: {
  path: string
  expectedIdentity: OwnedCpAMountIdentity
  record: R6DistOverlayManifestIdentity
}): Effect.Effect<void, DistOverlayError> =>
  Effect.gen(function* () {
    const info = yield* lstatMaybe(path)
    if (
      info === undefined ||
      info.isDirectory() === false ||
      identitiesEqual({ left: identity(info), right: expectedIdentity }) === false
    ) {
      return yield* failure({
        reason: 'DestinationRefused',
        path,
        message: `Overlay inode identity changed at '${path}'`,
        recoveryPaths: [path],
      })
    }
    const scan = yield* scanR6ProtectedTree({ root: path }).pipe(
      Effect.mapError((cause) =>
        failure({
          reason: 'DestinationRefused',
          path,
          message: `Overlay tree is invalid at '${path}'`,
          cause,
        }),
      ),
    )
    if (scan.digest !== record.digest || scan.count !== record.count) {
      return yield* failure({
        reason: 'DestinationRefused',
        path,
        message: `Overlay digest identity changed at '${path}'`,
        recoveryPaths: [path],
      })
    }
  })

const stepsFor = (operation: DistOverlayOperation): DistOverlayPlan['steps'] => [
  'AssertUpdateLock',
  'ValidateMount',
  'CreateTransaction',
  ...(operation === 'Remove'
    ? []
    : (['CopyArtifact', 'ProtectCandidate', 'ValidateCandidate'] as const)),
  'Publish',
  'ValidateRepositoryIdentity',
  'PublishMetadata',
  ...(operation === 'FirstPublish' ? [] : (['ValidateOldIdentity', 'DeleteOld'] as const)),
  'RemoveTransaction',
]

/** Atomically publish, update, or remove one declared overlay under the caller-held update lock. */
const publishDistOverlay = ({
  request: untrustedRequest,
  runtime,
}: {
  request: DistOverlayPublishRequest
  runtime: DistOverlayRuntime
}): Effect.Effect<DistOverlayResult, DistOverlayError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const request = yield* Schema.decodeEffect(
      DistOverlayPublishRequest,
      strictParseOptions,
    )(untrustedRequest).pipe(
      Effect.mapError((cause) =>
        failure({
          reason: 'InvalidRequest',
          path: 'request',
          message: 'Invalid dist overlay request',
          cause,
        }),
      ),
    )
    yield* assertLock({ runtime, workspaceRoot: request.workspaceRoot, member: request.member })
    yield* validateCommandPath({ path: request.cpPath, name: 'cp' })
    yield* validateCommandPath({ path: request.mvPath, name: 'mv' })
    const mountPath = NodePath.join(request.workspaceRoot, 'repos', request.member)
    if (
      request.expectedMetadata.member !== request.member ||
      request.expectedMetadata.publishedPath !== mountPath ||
      hasDeclaredDistOverlay({
        declarations: request.expectedMetadata.declaredOverlays,
        target: request.target,
        destination: request.destination,
      }) === false
    ) {
      return yield* failure({
        reason: 'UndeclaredDestination',
        path: request.destination,
        message: `Overlay target and destination are not exactly declared for member '${request.member}'`,
      })
    }
    yield* assertMountAndMetadata({
      workspaceRoot: request.workspaceRoot,
      member: request.member,
      mountPath,
      expectedIdentity: request.expectedMountIdentity,
      expectedMetadata: request.expectedMetadata,
    })
    const destinationPath = NodePath.join(mountPath, ...request.destination.split('/'))
    yield* assertNoSymlinkParents({ mountPath, destinationPath })
    const oldOverlay = request.expectedMetadata.overlays.find(
      (overlay) => overlay.destination === request.destination,
    )
    if (oldOverlay !== undefined && oldOverlay.target !== request.target) {
      return yield* failure({
        reason: 'DestinationRefused',
        path: destinationPath,
        message: `Overlay metadata target mismatch at '${destinationPath}'`,
      })
    }
    const oldIdentity = yield* validateExistingOverlay({ destinationPath, record: oldOverlay })
    if (request.artifactPath === null && oldIdentity === undefined) {
      return yield* failure({
        reason: 'DestinationRefused',
        path: destinationPath,
        message: `Cannot remove unpublished overlay '${request.destination}'`,
      })
    }

    let artifactScan: R6TreeScan | undefined
    let newOverlay: R6DistOverlayManifestIdentity | undefined
    if (request.artifactPath !== null) {
      artifactScan = yield* scanR6BuildArtifactTree({ root: request.artifactPath }).pipe(
        Effect.mapError((cause) =>
          failure({
            reason: 'ArtifactInvalid',
            path: request.artifactPath!,
            message: `Overlay artifact failed R6 validation`,
            cause,
          }),
        ),
      )
      newOverlay = {
        target: request.target,
        destination: request.destination,
        digest: artifactScan.digest,
        count: artifactScan.count,
      }
    }
    const operation: DistOverlayOperation =
      request.artifactPath === null
        ? 'Remove'
        : oldIdentity === undefined
          ? 'FirstPublish'
          : 'Update'
    const metadataAfter = nextMetadata({
      metadata: request.expectedMetadata,
      overlay: newOverlay,
      destination: request.destination,
    })
    const nonce = runtime.nonce?.() ?? `${process.pid}-${randomBytes(8).toString('hex')}`
    if (/^[A-Za-z0-9_-]+$/u.test(nonce) === false) {
      return yield* failure({
        reason: 'InvalidRequest',
        path: nonce,
        message: 'Overlay staging nonce contains unsupported characters',
      })
    }
    const stagePath = NodePath.join(
      request.workspaceRoot,
      'repos',
      '.mr',
      'overlay-stages',
      `v1-${Buffer.from(request.member, 'utf8').toString('hex')}--${Buffer.from(request.destination, 'utf8').toString('hex')}-${nonce}`,
    )
    const transactionPath = distOverlayTransactionPath(request)
    const plan: DistOverlayPlan = {
      _tag: 'DistOverlayPlan',
      operation,
      member: request.member,
      target: request.target,
      destination: request.destination,
      destinationPath,
      stagePath,
      transactionPath,
      previousMetadata: request.expectedMetadata,
      nextMetadata: metadataAfter,
      steps: [...stepsFor(operation)],
    }
    if (request.dryRun === true) return { _tag: 'DryRun' as const, plan }

    const stageRoot = yield* ensureControlDirectory({
      workspaceRoot: request.workspaceRoot,
      name: 'overlay-stages',
    })
    const transactionRoot = yield* ensureControlDirectory({
      workspaceRoot: request.workspaceRoot,
      name: 'overlay-transactions',
    })
    if (
      NodePath.dirname(stagePath) !== stageRoot ||
      NodePath.dirname(transactionPath) !== transactionRoot
    ) {
      return yield* failure({
        reason: 'InvalidRequest',
        path: stagePath,
        message: `Derived overlay control path escaped its workspace-owned namespace`,
      })
    }
    const stageBefore = yield* lstatMaybe(stagePath)
    if (stageBefore !== undefined) {
      return yield* failure({
        reason: 'DestinationRefused',
        path: stagePath,
        message: `Overlay stage path already exists: '${stagePath}'`,
      })
    }
    let transaction: DistOverlayTransactionType = {
      version: DIST_OVERLAY_TRANSACTION_VERSION,
      member: request.member,
      target: request.target,
      destination: request.destination,
      mountPath,
      destinationPath,
      stagePath,
      operation,
      phaseHint: 'Intent',
      mountIdentity: request.expectedMountIdentity,
      oldIdentity: oldIdentity ?? null,
      candidateIdentity: null,
      oldOverlay: oldOverlay ?? null,
      newOverlay: newOverlay ?? null,
      previousMetadata: request.expectedMetadata,
      nextMetadata: metadataAfter,
    }
    yield* writeTransactionExclusive({ path: transactionPath, transaction })
    if (runtime.afterPhase !== undefined)
      yield* io({
        path: transactionPath,
        message: `Overlay phase hook failed after 'Intent'`,
        recoveryPaths: [transactionPath],
        try: () => runtime.afterPhase!('Intent'),
      })

    let candidateIdentity: OwnedCpAMountIdentity | undefined
    if (operation !== 'Remove') {
      const scan = artifactScan!
      const artifactPath = request.artifactPath!
      const info = yield* io({
        path: stagePath,
        message: `Cannot create overlay candidate '${stagePath}'`,
        reason: 'ArtifactInvalid',
        recoveryPaths: [transactionPath],
        try: async () => {
          await mkdir(stagePath, { recursive: false, mode: 0o755 })
          return lstat(stagePath)
        },
      })
      candidateIdentity = identity(info)
      transaction = { ...transaction, candidateIdentity }
      yield* replaceTransaction({ path: transactionPath, transaction })
      yield* runCommand({
        binary: request.cpPath,
        args: ['-a', `${artifactPath}${NodePath.sep}.`, stagePath],
        path: stagePath,
        commandName: 'GNU cp -a overlay copy',
        recoveryPaths: [stagePath, transactionPath],
      })
      transaction = yield* persistPhase({
        transactionPath,
        transaction,
        phaseHint: 'CandidateCreated',
        runtime,
      })
      yield* protectTree(stagePath)
      const candidateScan = yield* scanR6ProtectedTree({ root: stagePath }).pipe(
        Effect.mapError((cause) =>
          failure({
            reason: 'ArtifactInvalid',
            path: stagePath,
            message: `Protected overlay candidate is invalid`,
            cause,
          }),
        ),
      )
      if (candidateScan.digest !== scan.digest || candidateScan.count !== scan.count) {
        return yield* failure({
          reason: 'ArtifactInvalid',
          path: stagePath,
          message: `Overlay candidate digest differs from artifact`,
          recoveryPaths: [stagePath, transactionPath],
        })
      }
      yield* assertIndependentFileInodes({
        sourceRoot: artifactPath,
        destinationRoot: stagePath,
        scan,
      })
      const artifactAfter = yield* scanR6BuildArtifactTree({ root: artifactPath }).pipe(
        Effect.mapError((cause) =>
          failure({
            reason: 'ArtifactInvalid',
            path: artifactPath,
            message: `Overlay artifact changed during copy`,
            cause,
          }),
        ),
      )
      if (artifactAfter.digest !== scan.digest || artifactAfter.count !== scan.count) {
        return yield* failure({
          reason: 'ArtifactInvalid',
          path: artifactPath,
          message: `Overlay artifact changed during copy`,
          recoveryPaths: [stagePath, transactionPath],
        })
      }
      transaction = yield* persistPhase({
        transactionPath,
        transaction,
        phaseHint: 'CandidateValidated',
        runtime,
      })
    }

    yield* assertLock({ runtime, workspaceRoot: request.workspaceRoot, member: request.member })
    yield* assertMountAndMetadata({
      workspaceRoot: request.workspaceRoot,
      member: request.member,
      mountPath,
      expectedIdentity: request.expectedMountIdentity,
      expectedMetadata: request.expectedMetadata,
    })
    yield* assertRepositoryIdentity({ mountPath, expectedMetadata: request.expectedMetadata })
    if (runtime.beforePublish !== undefined) {
      yield* io({
        path: destinationPath,
        message: `Overlay publish boundary hook failed`,
        recoveryPaths: [destinationPath, stagePath, transactionPath],
        try: () => runtime.beforePublish!({ mountPath, destinationPath, stagePath }),
      })
    }
    yield* assertOwnedCpAMountIdentity({
      path: mountPath,
      expected: request.expectedMountIdentity,
    }).pipe(
      Effect.mapError((cause) =>
        failure({
          reason: 'MountIdentityMismatch',
          path: mountPath,
          message: `Mount exchanged before overlay publication`,
          cause,
        }),
      ),
    )
    const currentOldIdentity = yield* validateExistingOverlay({
      destinationPath,
      record: oldOverlay,
    })
    if (
      (oldIdentity === undefined && currentOldIdentity !== undefined) ||
      (oldIdentity !== undefined &&
        (currentOldIdentity === undefined ||
          identitiesEqual({ left: oldIdentity, right: currentOldIdentity }) === false))
    ) {
      return yield* failure({
        reason: 'DestinationRefused',
        path: destinationPath,
        message: `Overlay destination changed immediately before publication`,
        recoveryPaths: [destinationPath, stagePath, transactionPath],
      })
    }
    yield* moveOverlayDirectories({
      destinationParent: NodePath.dirname(destinationPath),
      paths: [destinationPath, stagePath],
      effect: Effect.gen(function* () {
        const [destinationParentInfo, stageParentInfo] = yield* io({
          path: destinationPath,
          message: `Cannot verify overlay publication directories`,
          reason: 'DestinationRefused',
          recoveryPaths: [destinationPath, stagePath, transactionPath],
          try: () =>
            Promise.all([
              lstat(NodePath.dirname(destinationPath)),
              lstat(NodePath.dirname(stagePath)),
            ]),
        })
        if (
          (destinationParentInfo.mode & 0o777) !== 0o755 ||
          (stageParentInfo.mode & 0o777) !== 0o755 ||
          destinationParentInfo.dev !== stageParentInfo.dev
        ) {
          return yield* failure({
            reason: 'DestinationRefused',
            path: destinationPath,
            message: `Overlay publication directories are not writable on one filesystem: destination=${(destinationParentInfo.mode & 0o777).toString(8)}/${destinationParentInfo.dev}, stage=${(stageParentInfo.mode & 0o777).toString(8)}/${stageParentInfo.dev}`,
            recoveryPaths: [destinationPath, stagePath, transactionPath],
          })
        }
        yield* operation === 'FirstPublish'
          ? runCommand({
              binary: request.mvPath,
              args: ['-T', '--no-clobber', '--no-copy', stagePath, destinationPath],
              path: destinationPath,
              commandName: 'GNU mv no-clobber overlay publish',
              recoveryPaths: [destinationPath, stagePath, transactionPath],
            })
          : operation === 'Update'
            ? runCommand({
                binary: request.mvPath,
                args: ['-T', '--exchange', '--no-copy', stagePath, destinationPath],
                path: destinationPath,
                commandName: 'GNU mv overlay exchange',
                recoveryPaths: [destinationPath, stagePath, transactionPath],
              })
            : runCommand({
                binary: request.mvPath,
                args: ['-T', '--no-clobber', '--no-copy', destinationPath, stagePath],
                path: destinationPath,
                commandName: 'GNU mv overlay remove',
                recoveryPaths: [destinationPath, stagePath, transactionPath],
              })
      }),
    })
    yield* syncOverlayMoveParents({
      runtime,
      destinationPath,
      stagePath,
      kind: 'Publish',
    })
    transaction = yield* persistPhase({
      transactionPath,
      transaction,
      phaseHint: 'Published',
      runtime,
    })
    if (operation === 'Remove') {
      if ((yield* lstatMaybe(destinationPath)) !== undefined) {
        return yield* failure({
          reason: 'DestinationRefused',
          path: destinationPath,
          message: `Overlay removal did not make the destination absent`,
          recoveryPaths: [destinationPath, stagePath, transactionPath],
        })
      }
    } else {
      if (candidateIdentity === undefined || newOverlay === undefined) {
        return yield* failure({
          reason: 'DestinationRefused',
          path: destinationPath,
          message: `Overlay publication lost candidate identity`,
          recoveryPaths: [destinationPath, stagePath, transactionPath],
        })
      }
      yield* validateTreeIdentity({
        path: destinationPath,
        expectedIdentity: candidateIdentity,
        record: newOverlay,
      })
    }
    if (operation !== 'FirstPublish') {
      if (oldIdentity === undefined || oldOverlay === undefined) {
        return yield* failure({
          reason: 'DestinationRefused',
          path: stagePath,
          message: `Overlay publication lost old identity`,
          recoveryPaths: [destinationPath, stagePath, transactionPath],
        })
      }
      yield* validateTreeIdentity({
        path: stagePath,
        expectedIdentity: oldIdentity,
        record: oldOverlay,
      })
    }
    yield* assertLock({ runtime, workspaceRoot: request.workspaceRoot, member: request.member })
    yield* assertOwnedCpAMountIdentity({
      path: mountPath,
      expected: request.expectedMountIdentity,
    }).pipe(
      Effect.mapError((cause) =>
        failure({
          reason: 'MountIdentityMismatch',
          path: mountPath,
          message: `Mount exchanged after overlay publication`,
          cause,
        }),
      ),
    )
    yield* assertRepositoryIdentity({ mountPath, expectedMetadata: request.expectedMetadata })

    const metadataResult = yield* Effect.gen(function* () {
      if (runtime.beforeMetadataWrite !== undefined) {
        yield* io({
          path: transactionPath,
          message: `Metadata publication hook failed`,
          reason: 'MetadataPublishFailed',
          recoveryPaths: [destinationPath, stagePath, transactionPath],
          try: () => runtime.beforeMetadataWrite!(metadataAfter),
        })
      }
      yield* writeOwnedCpAMountMetadata({
        workspaceRoot: request.workspaceRoot,
        metadata: metadataAfter,
      }).pipe(
        Effect.mapError((cause) =>
          failure({
            reason: 'MetadataPublishFailed',
            path: transactionPath,
            message: `Cannot publish overlay metadata`,
            recoveryPaths: [destinationPath, stagePath, transactionPath],
            cause,
          }),
        ),
      )
    }).pipe(Effect.result)
    if (metadataResult._tag === 'Failure') {
      yield* moveOverlayDirectories({
        destinationParent: NodePath.dirname(destinationPath),
        paths: [destinationPath, stagePath],
        effect:
          operation === 'FirstPublish'
            ? runCommand({
                binary: request.mvPath,
                args: ['-T', '--no-clobber', '--no-copy', destinationPath, stagePath],
                path: destinationPath,
                commandName: 'Overlay first-publish rollback',
                recoveryPaths: [destinationPath, stagePath, transactionPath],
              })
            : operation === 'Update'
              ? runCommand({
                  binary: request.mvPath,
                  args: ['-T', '--exchange', '--no-copy', stagePath, destinationPath],
                  path: destinationPath,
                  commandName: 'Overlay update rollback',
                  recoveryPaths: [destinationPath, stagePath, transactionPath],
                })
              : runCommand({
                  binary: request.mvPath,
                  args: ['-T', '--no-clobber', '--no-copy', stagePath, destinationPath],
                  path: destinationPath,
                  commandName: 'Overlay removal rollback',
                  recoveryPaths: [destinationPath, stagePath, transactionPath],
                }),
      })
      yield* syncOverlayMoveParents({
        runtime,
        destinationPath,
        stagePath,
        kind: 'Rollback',
      })
      if (operation !== 'Remove' && candidateIdentity !== undefined) {
        yield* teardownDirectory({ path: stagePath, expectedIdentity: candidateIdentity })
        yield* syncOverlayStageCleanup({ runtime, stagePath })
      }
      yield* assertOwnedCpAMountIdentity({
        path: mountPath,
        expected: request.expectedMountIdentity,
      }).pipe(
        Effect.mapError((cause) =>
          failure({
            reason: 'MountIdentityMismatch',
            path: mountPath,
            message: `Mount changed during metadata rollback`,
            cause,
          }),
        ),
      )
      yield* assertRepositoryIdentity({ mountPath, expectedMetadata: request.expectedMetadata })
      yield* removeTransaction(transactionPath)
      return yield* metadataResult.failure
    }
    transaction = yield* persistPhase({
      transactionPath,
      transaction,
      phaseHint: 'MetadataPublished',
      runtime,
    })
    yield* assertRepositoryIdentity({ mountPath, expectedMetadata: metadataAfter })

    if (operation !== 'FirstPublish') {
      transaction = yield* persistPhase({
        transactionPath,
        transaction,
        phaseHint: 'Cleanup',
        runtime,
      })
      if (oldIdentity === undefined || oldOverlay === undefined) {
        return yield* failure({
          reason: 'AmbiguousRecovery',
          path: stagePath,
          message: `Overlay cleanup lost old identity`,
          recoveryPaths: [stagePath, transactionPath],
        })
      }
      yield* validateTreeIdentity({
        path: stagePath,
        expectedIdentity: oldIdentity,
        record: oldOverlay,
      })
      yield* teardownDirectory({ path: stagePath, expectedIdentity: oldIdentity })
      yield* syncOverlayStageCleanup({ runtime, stagePath })
    }
    yield* removeTransaction(transactionPath)
    return { _tag: 'Published' as const, operation, destinationPath, metadata: metadataAfter }
  })

const observedTree = ({
  path,
  oldIdentity,
  oldOverlay,
  newIdentity,
  newOverlay,
}: {
  path: string
  oldIdentity: OwnedCpAMountIdentity | null
  oldOverlay: R6DistOverlayManifestIdentity | null
  newIdentity: OwnedCpAMountIdentity | null
  newOverlay: R6DistOverlayManifestIdentity | null
}): Effect.Effect<'Missing' | 'Old' | 'New' | 'Other', DistOverlayError> =>
  Effect.gen(function* () {
    const info = yield* lstatMaybe(path)
    if (info === undefined) return 'Missing' as const
    if (info.isDirectory() === false) return 'Other' as const
    const actualIdentity = identity(info)
    const protectedScan = yield* scanR6ProtectedTree({ root: path }).pipe(Effect.result)
    const normalizedScan =
      protectedScan._tag === 'Success'
        ? protectedScan
        : yield* scanR6BuildArtifactTree({ root: path }).pipe(Effect.result)
    if (normalizedScan._tag === 'Failure') return 'Other' as const
    if (
      oldIdentity !== null &&
      oldOverlay !== null &&
      identitiesEqual({ left: actualIdentity, right: oldIdentity }) === true &&
      normalizedScan.success.digest === oldOverlay.digest &&
      normalizedScan.success.count === oldOverlay.count
    )
      return 'Old' as const
    if (
      newIdentity !== null &&
      newOverlay !== null &&
      identitiesEqual({ left: actualIdentity, right: newIdentity }) === true &&
      normalizedScan.success.digest === newOverlay.digest &&
      normalizedScan.success.count === newOverlay.count
    )
      return 'New' as const
    return 'Other' as const
  })

/** Recover one interrupted overlay transaction from metadata plus exact observed inode/R6 state. */
const recoverDistOverlay = ({
  request: untrustedRequest,
  runtime,
}: {
  request: DistOverlayRecoveryRequest
  runtime: DistOverlayRuntime
}): Effect.Effect<DistOverlayResult, DistOverlayError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const request = yield* Schema.decodeEffect(
      DistOverlayRecoveryRequest,
      strictParseOptions,
    )(untrustedRequest).pipe(
      Effect.mapError((cause) =>
        failure({
          reason: 'InvalidRequest',
          path: 'request',
          message: 'Invalid overlay recovery request',
          cause,
        }),
      ),
    )
    yield* assertLock({ runtime, workspaceRoot: request.workspaceRoot, member: request.member })
    const transactionPath = distOverlayTransactionPath(request)
    const transaction = yield* readTransaction(transactionPath)
    const mountPath = NodePath.join(request.workspaceRoot, 'repos', request.member)
    const destinationPath = NodePath.join(mountPath, ...request.destination.split('/'))
    const expectedStageRoot = NodePath.join(request.workspaceRoot, 'repos', '.mr', 'overlay-stages')
    const expectedTransactionRoot = NodePath.join(
      request.workspaceRoot,
      'repos',
      '.mr',
      'overlay-transactions',
    )
    if (
      NodePath.dirname(transaction.stagePath) !== expectedStageRoot ||
      NodePath.dirname(transactionPath) !== expectedTransactionRoot ||
      transaction.destinationPath !== destinationPath ||
      transaction.member !== request.member ||
      transaction.target !== request.target ||
      transaction.destination !== request.destination ||
      transaction.mountPath !== mountPath ||
      transaction.previousMetadata.member !== request.member ||
      transaction.previousMetadata.publishedPath !== mountPath ||
      transaction.nextMetadata.member !== request.member ||
      transaction.nextMetadata.publishedPath !== mountPath ||
      identitiesEqual({ left: transaction.mountIdentity, right: request.expectedMountIdentity }) ===
        false
    ) {
      return yield* failure({
        reason: 'AmbiguousRecovery',
        path: transactionPath,
        message: `Overlay recovery request does not match transaction`,
        recoveryPaths: [transactionPath],
      })
    }
    yield* validateCommandPath({ path: request.mvPath, name: 'mv' })
    const stageRoot = yield* ensureControlDirectory({
      workspaceRoot: request.workspaceRoot,
      name: 'overlay-stages',
      create: false,
    })
    const transactionRoot = yield* ensureControlDirectory({
      workspaceRoot: request.workspaceRoot,
      name: 'overlay-transactions',
      create: false,
    })
    if (stageRoot !== expectedStageRoot || transactionRoot !== expectedTransactionRoot) {
      return yield* failure({
        reason: 'AmbiguousRecovery',
        path: transactionPath,
        message: `Overlay recovery control namespace identity mismatch`,
        recoveryPaths: [transactionPath],
      })
    }
    yield* assertOwnedCpAMountIdentity({
      path: mountPath,
      expected: transaction.mountIdentity,
    }).pipe(
      Effect.mapError((cause) =>
        failure({
          reason: 'MountIdentityMismatch',
          path: mountPath,
          message: `Mount changed during overlay recovery`,
          cause,
        }),
      ),
    )
    yield* assertNoSymlinkParents({ mountPath, destinationPath: destinationPath })
    const actualMetadata = yield* readOwnedCpAMountMetadata({
      workspaceRoot: request.workspaceRoot,
      member: request.member,
      publishedPath: mountPath,
    }).pipe(
      Effect.mapError((cause) =>
        failure({
          reason: 'AmbiguousRecovery',
          path: transactionPath,
          message: `Cannot read metadata during overlay recovery`,
          cause,
        }),
      ),
    )
    const metadataState =
      metadataEqual({ left: actualMetadata, right: transaction.previousMetadata }) === true
        ? 'Previous'
        : metadataEqual({ left: actualMetadata, right: transaction.nextMetadata }) === true
          ? 'Next'
          : 'Other'
    const [destinationState, stageState] = yield* Effect.all([
      observedTree({
        path: destinationPath,
        oldIdentity: transaction.oldIdentity,
        oldOverlay: transaction.oldOverlay,
        newIdentity: transaction.candidateIdentity,
        newOverlay: transaction.newOverlay,
      }),
      observedTree({
        path: transaction.stagePath,
        oldIdentity: transaction.oldIdentity,
        oldOverlay: transaction.oldOverlay,
        newIdentity: transaction.candidateIdentity,
        newOverlay: transaction.newOverlay,
      }),
    ])
    const parent = NodePath.dirname(destinationPath)

    if (metadataState === 'Previous') {
      if (
        (transaction.operation === 'FirstPublish' &&
          destinationState === 'Missing' &&
          (stageState === 'New' || stageState === 'Missing')) ||
        (transaction.operation !== 'FirstPublish' &&
          destinationState === 'Old' &&
          (stageState === 'New' || stageState === 'Missing'))
      ) {
        if (stageState === 'New' && transaction.candidateIdentity !== null) {
          yield* teardownDirectory({
            path: transaction.stagePath,
            expectedIdentity: transaction.candidateIdentity,
          })
          yield* syncOverlayStageCleanup({ runtime, stagePath: transaction.stagePath })
        }
        yield* removeTransaction(transactionPath)
        return {
          _tag: 'Recovered' as const,
          action: 'RolledBack' as const,
          destinationPath: destinationPath,
        }
      }
      if (
        transaction.operation === 'FirstPublish' &&
        destinationState === 'New' &&
        stageState === 'Missing'
      ) {
        yield* moveOverlayDirectories({
          destinationParent: parent,
          paths: [destinationPath, transaction.stagePath],
          effect: runCommand({
            binary: request.mvPath,
            args: ['-T', '--no-clobber', '--no-copy', destinationPath, transaction.stagePath],
            path: destinationPath,
            commandName: 'Recover overlay first publish',
            recoveryPaths: [destinationPath, transaction.stagePath, transactionPath],
          }),
        })
        yield* syncOverlayMoveParents({
          runtime,
          destinationPath: destinationPath,
          stagePath: transaction.stagePath,
          kind: 'Recovery',
        })
        if (transaction.candidateIdentity === null)
          return yield* failure({
            reason: 'AmbiguousRecovery',
            path: transactionPath,
            message: `Missing candidate identity`,
            recoveryPaths: [transactionPath],
          })
        yield* teardownDirectory({
          path: transaction.stagePath,
          expectedIdentity: transaction.candidateIdentity,
        })
        yield* syncOverlayStageCleanup({ runtime, stagePath: transaction.stagePath })
      } else if (
        transaction.operation === 'Update' &&
        destinationState === 'New' &&
        stageState === 'Old'
      ) {
        yield* moveOverlayDirectories({
          destinationParent: parent,
          paths: [destinationPath, transaction.stagePath],
          effect: runCommand({
            binary: request.mvPath,
            args: ['-T', '--exchange', '--no-copy', transaction.stagePath, destinationPath],
            path: destinationPath,
            commandName: 'Recover overlay update',
            recoveryPaths: [destinationPath, transaction.stagePath, transactionPath],
          }),
        })
        yield* syncOverlayMoveParents({
          runtime,
          destinationPath: destinationPath,
          stagePath: transaction.stagePath,
          kind: 'Recovery',
        })
        if (transaction.candidateIdentity === null)
          return yield* failure({
            reason: 'AmbiguousRecovery',
            path: transactionPath,
            message: `Missing candidate identity`,
            recoveryPaths: [transactionPath],
          })
        yield* teardownDirectory({
          path: transaction.stagePath,
          expectedIdentity: transaction.candidateIdentity,
        })
        yield* syncOverlayStageCleanup({ runtime, stagePath: transaction.stagePath })
      } else if (
        transaction.operation === 'Remove' &&
        destinationState === 'Missing' &&
        stageState === 'Old'
      ) {
        yield* moveOverlayDirectories({
          destinationParent: parent,
          paths: [destinationPath, transaction.stagePath],
          effect: runCommand({
            binary: request.mvPath,
            args: ['-T', '--no-clobber', '--no-copy', transaction.stagePath, destinationPath],
            path: destinationPath,
            commandName: 'Recover overlay removal',
            recoveryPaths: [destinationPath, transaction.stagePath, transactionPath],
          }),
        })
        yield* syncOverlayMoveParents({
          runtime,
          destinationPath: destinationPath,
          stagePath: transaction.stagePath,
          kind: 'Recovery',
        })
      } else {
        return yield* failure({
          reason: 'AmbiguousRecovery',
          path: transactionPath,
          message: `Observed overlay state is unsafe for rollback`,
          recoveryPaths: [destinationPath, transaction.stagePath, transactionPath],
        })
      }
      yield* removeTransaction(transactionPath)
      return {
        _tag: 'Recovered' as const,
        action: 'RolledBack' as const,
        destinationPath: destinationPath,
      }
    }

    const nextDestination = transaction.operation === 'Remove' ? 'Missing' : 'New'
    if (metadataState === 'Next' && destinationState === nextDestination) {
      if (stageState === 'Old') {
        if (transaction.oldIdentity === null)
          return yield* failure({
            reason: 'AmbiguousRecovery',
            path: transactionPath,
            message: `Missing old overlay identity`,
            recoveryPaths: [transactionPath],
          })
        yield* teardownDirectory({
          path: transaction.stagePath,
          expectedIdentity: transaction.oldIdentity,
        })
      } else if (stageState !== 'Missing') {
        return yield* failure({
          reason: 'AmbiguousRecovery',
          path: transactionPath,
          message: `Foreign stage replacement during roll-forward`,
          recoveryPaths: [transaction.stagePath, transactionPath],
        })
      }
      yield* syncOverlayStageCleanup({ runtime, stagePath: transaction.stagePath })
      yield* assertRepositoryIdentity({ mountPath, expectedMetadata: transaction.nextMetadata })
      yield* removeTransaction(transactionPath)
      return {
        _tag: 'Recovered' as const,
        action: 'RolledForward' as const,
        destinationPath: destinationPath,
      }
    }
    return yield* failure({
      reason: 'AmbiguousRecovery',
      path: transactionPath,
      message: `Metadata and observed overlay identities do not admit safe recovery`,
      recoveryPaths: [destinationPath, transaction.stagePath, transactionPath],
    })
  })
