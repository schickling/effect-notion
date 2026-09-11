/**
 * Concrete cp-a member-mount mechanism.
 *
 * This layer copies, protects, publishes, recovers, and tears down mount directories. It delegates
 * manifest construction and content identity to the R6 layer rather than defining a second
 * identity model.
 *
 * ## Why the codename, and why this is a module of its own
 *
 * "cp-a" names the mechanism, not the concept: a validated `cp -a` from the immutable store into a
 * staging directory, followed by a RENAME_EXCHANGE advance that swaps staging into place
 * atomically (decision 0020). Everything here is about that mechanism's lifecycle — staging,
 * mode protection, publish, recover, teardown.
 *
 * Whether the result is *correct* is not this module's judgement to make: it imports
 * `member-mount-r6.ts` for identity and runs the R6 post-condition against its own output. Keeping
 * the mechanism and the identity check in separate modules is what makes the check credible, and
 * is why the two were not merged.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import type { Stats } from 'node:fs'
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  unlink,
  type FileHandle,
} from 'node:fs/promises'
import * as NodePath from 'node:path'

import { Effect, Schema } from 'effect'
import type * as FileSystem from 'effect/FileSystem'

import * as Observability from '../../core/observability.ts'
import {
  CP_A_MEMBER_MOUNT_TRANSACTION_VERSION,
  CpAMemberMountError,
  CpAMemberMountRecoveryRequest,
  CpAMemberMountRequest,
  CpAMemberMountTeardownRequest,
  CpAMemberMountTransaction,
  cpAMemberMountDestinationPath,
  cpAMemberMountTransactionPath,
  encodeCpAMountMemberFilename,
  type CpAMemberMountOperation,
  type CpAMemberMountPhaseHint,
  type CpAMemberMountPlan,
  type CpAMemberMountPlanStep,
  type CpAMemberMountResult,
  type CpAMemberMountTransaction as CpAMemberMountTransactionType,
  type CpAMountInodeIdentity,
  type CpAMountOldIdentity,
} from './member-mount-cp-a-schema.ts'
import {
  assertOwnedCpAMountIdentity,
  computeR6SourcePathIdentity,
  inspectOwnedCpAMount,
  makeOwnedCpAMountMetadata,
  ownedCpAMountMetadataPath,
  readOwnedCpAMountMetadata,
  scanR6ProtectedMount,
  scanR6Source,
  writeOwnedCpAMountMetadata,
  type OwnedCpAMountMetadata,
  type R6MountScan,
} from './member-mount-r6.ts'
import { inspectMemberMount } from './member-mount.ts'

const strictParseOptions = { errors: 'all', onExcessProperty: 'error' } as const
const TransactionJson = Schema.fromJsonString(CpAMemberMountTransaction, { space: 2 })

type RuntimePlatform = 'linux' | 'darwin' | (string & {})

/** Directory namespace durability checkpoints used by the lifecycle and recovery state machines. */
export type CpAMemberMountDirectorySyncReason =
  | 'TransactionCreate'
  | 'TransactionReplace'
  | 'TransactionRemove'
  | 'StageCreate'
  | 'FirstPublish'
  | 'Exchange'
  | 'CandidateCleanup'
  | 'OldCleanup'
  | 'MetadataPublish'
  | 'MetadataRemove'
  | 'MountTeardown'

/**
 * Optional durability seam. Implementations may record or fail a checkpoint but must call `sync`
 * to retain the production power-loss guarantee.
 */
export interface CpAMemberMountDurabilityRuntime {
  readonly directoryFsync?: (input: {
    readonly path: string
    readonly reason: CpAMemberMountDirectorySyncReason
    readonly sync: () => Promise<void>
  }) => Promise<void>
}

/** Injected pinned commands, capability gate, platform policy, and deterministic test seams. */
export interface CpAMemberMountRuntime extends CpAMemberMountDurabilityRuntime {
  /** Absolute pinned GNU coreutils paths. PATH lookup is intentionally impossible. */
  readonly cpPath: string
  readonly mvPath: string
  readonly platform?: RuntimePlatform
  readonly nonce?: () => string
  readonly capabilityCheck: (input: {
    readonly member: string
    readonly stagePath: string
    readonly capabilitiesPath: string
  }) => Promise<void>
  /** Deterministic crash-boundary seam. Throwing preserves the transaction for recovery. */
  readonly afterPhase?: (phase: CpAMemberMountPhaseHint) => Promise<void>
  /** Boundary after the final missing check and immediately before no-clobber first publish. */
  readonly beforeFirstPublish?: (input: {
    readonly destinationPath: string
    readonly stagePath: string
  }) => Promise<void>
}

/** Runtime dependencies needed to reconcile an existing transaction. */
export interface CpAMemberMountRecoveryRuntime extends CpAMemberMountDurabilityRuntime {
  readonly mvPath: string
  readonly platform?: RuntimePlatform
}

const syncDirectoryNative = async (path: string): Promise<void> => {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const syncDirectoryPromise = ({
  runtime,
  path,
  reason,
}: {
  runtime: CpAMemberMountDurabilityRuntime
  path: string
  reason: CpAMemberMountDirectorySyncReason
}): Promise<void> => {
  const sync = (): Promise<void> => syncDirectoryNative(path)
  return runtime.directoryFsync?.({ path, reason, sync }) ?? sync()
}

const error = ({
  reason,
  path,
  message,
  recoveryPaths = [],
  cause,
}: {
  reason: CpAMemberMountError['reason']
  path: string
  message: string
  recoveryPaths?: ReadonlyArray<string>
  cause?: unknown
}): CpAMemberMountError =>
  new CpAMemberMountError({
    reason,
    path,
    message,
    recoveryPaths: [...recoveryPaths],
    ...(cause === undefined ? {} : { cause }),
  })

const normalizeError = ({
  cause,
  path,
  message,
  reason = 'IoFailure',
  recoveryPaths = [],
}: {
  cause: unknown
  path: string
  message: string
  reason?: CpAMemberMountError['reason']
  recoveryPaths?: ReadonlyArray<string>
}): CpAMemberMountError =>
  cause instanceof CpAMemberMountError
    ? cause
    : error({ reason, path, message, recoveryPaths, cause })

const io = <A>({
  path,
  message,
  try: run,
  reason,
  recoveryPaths,
}: {
  path: string
  message: string
  try: () => Promise<A>
  reason?: CpAMemberMountError['reason']
  recoveryPaths?: ReadonlyArray<string>
}): Effect.Effect<A, CpAMemberMountError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      normalizeError({
        cause,
        path,
        message,
        ...(reason === undefined ? {} : { reason }),
        ...(recoveryPaths === undefined ? {} : { recoveryPaths }),
      }),
  })

const syncDirectory = ({
  runtime,
  path,
  reason,
}: {
  runtime: CpAMemberMountDurabilityRuntime
  path: string
  reason: CpAMemberMountDirectorySyncReason
}): Effect.Effect<void, CpAMemberMountError> =>
  io({
    path,
    message: `Cannot make directory namespace durable at '${path}' (${reason})`,
    recoveryPaths: [path],
    try: () => syncDirectoryPromise({ runtime, path, reason }),
  })

const decodeRequest = Schema.decodeUnknownEffect(CpAMemberMountRequest, strictParseOptions)
const decodeRecoveryRequest = Schema.decodeUnknownEffect(
  CpAMemberMountRecoveryRequest,
  strictParseOptions,
)
const decodeTeardownRequest = Schema.decodeUnknownEffect(
  CpAMemberMountTeardownRequest,
  strictParseOptions,
)

const mapRequestError = (path: string) =>
  Effect.mapError((cause: Schema.SchemaError) =>
    error({
      reason: 'InvalidRequest',
      path,
      message: `Invalid cp-a member mount request for '${path}'`,
      cause,
    }),
  )

const identityFromStat = (info: {
  readonly dev: number
  readonly ino: number
}): CpAMountInodeIdentity => ({ dev: info.dev, ino: info.ino })

const identitiesEqual = ({
  left,
  right,
}: {
  left: CpAMountInodeIdentity
  right: CpAMountInodeIdentity
}): boolean => left.dev === right.dev && left.ino === right.ino

const metadataScanMatches = ({
  metadata,
  scan,
}: {
  metadata: OwnedCpAMountMetadata
  scan: R6MountScan
}): boolean => {
  const presentOverlays = scan.overlays.filter((overlay) => overlay.present === true)
  return (
    metadata.repository.digest === scan.repository.digest &&
    metadata.repository.count === scan.repository.count &&
    metadata.capabilities.present === scan.capabilities.present &&
    metadata.capabilities.digest === scan.capabilities.digest &&
    metadata.capabilities.count === scan.capabilities.count &&
    metadata.overlays.length === presentOverlays.length &&
    metadata.overlays.every((overlay, index) => {
      const actual = presentOverlays[index]
      return (
        actual !== undefined &&
        overlay.target === actual.target &&
        overlay.destination === actual.destination &&
        overlay.digest === actual.digest &&
        overlay.count === actual.count
      )
    })
  )
}

const mountAuthorityEqual = ({
  left,
  right,
}: {
  left: OwnedCpAMountMetadata
  right: OwnedCpAMountMetadata
}): boolean =>
  left.version === right.version &&
  left.member === right.member &&
  left.lockedCommit === right.lockedCommit &&
  left.sourcePathIdentity === right.sourcePathIdentity &&
  left.publishedPath === right.publishedPath &&
  left.repository.digest === right.repository.digest &&
  left.repository.count === right.repository.count &&
  left.capabilities.present === right.capabilities.present &&
  left.capabilities.digest === right.capabilities.digest &&
  left.capabilities.count === right.capabilities.count &&
  left.declaredOverlays.length === right.declaredOverlays.length &&
  left.declaredOverlays.every((overlay, index) => {
    const other = right.declaredOverlays[index]
    return (
      other !== undefined &&
      overlay.target === other.target &&
      overlay.destination === other.destination
    )
  })

interface SourceEntrySnapshot {
  readonly path: string
  readonly dev: number
  readonly ino: number
  readonly mode: number
}

interface SourceSnapshot {
  readonly root: SourceEntrySnapshot
  readonly entries: ReadonlyArray<SourceEntrySnapshot>
}

const captureSourceEntry = async (path: string): Promise<SourceEntrySnapshot> => {
  const info = await lstat(path)
  return { path, dev: info.dev, ino: info.ino, mode: info.mode & 0o7777 }
}

const sourceSnapshot = ({
  root,
  scan,
}: {
  root: string
  scan: R6MountScan
}): Effect.Effect<SourceSnapshot, CpAMemberMountError> =>
  io({
    path: root,
    message: `Cannot capture immutable source identities at '${root}'`,
    reason: 'SourceInvalid',
    try: async () => ({
      root: await captureSourceEntry(root),
      entries: await Promise.all(
        scan.repository.manifest.entries.map((entry) =>
          captureSourceEntry(NodePath.join(root, entry.path)),
        ),
      ),
    }),
  })

const sourceEntriesEqual = ({
  left,
  right,
}: {
  left: SourceEntrySnapshot
  right: SourceEntrySnapshot
}): boolean =>
  left.path === right.path &&
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode

const snapshotsEqual = ({
  left,
  right,
}: {
  left: SourceSnapshot
  right: SourceSnapshot
}): boolean =>
  sourceEntriesEqual({ left: left.root, right: right.root }) === true &&
  left.entries.length === right.entries.length &&
  left.entries.every((entry, index) => {
    const other = right.entries[index]
    return other !== undefined && sourceEntriesEqual({ left: entry, right: other })
  })

/**
 * Permission state of the paths a rename touches, for a failure report.
 *
 * A rename needs write access to the parent entries. The macOS CI environment
 * also refused to move protected `0555` directory roots within a writable
 * shared parent. `Permission denied` alone does not identify which permission
 * check failed, so report the modes and owners of every operand.
 */
const describeRenameOperands = async (paths: ReadonlyArray<string>): Promise<string> => {
  const described = await Promise.all(
    paths.map(async (candidate) => {
      try {
        const info = await lstat(candidate)
        const kind =
          info.isDirectory() === true ? 'dir' : info.isSymbolicLink() === true ? 'link' : 'file'
        return `${candidate} [${kind} mode=${(info.mode & 0o7777).toString(8)} uid=${String(info.uid)}]`
      } catch (cause) {
        return `${candidate} [unreadable: ${cause instanceof Error ? cause.message : String(cause)}]`
      }
    }),
  )
  return described.join('\n  ')
}

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
}): Effect.Effect<void, CpAMemberMountError> =>
  io({
    path,
    message: `${commandName} failed for '${path}'`,
    reason: 'CommandFailure',
    recoveryPaths,
    try: () =>
      new Promise<void>((resolve, reject) => {
        // Capture stderr. These commands are the rename primitives R6 depends on,
        // and a bare exit code is not diagnosable from a CI log: an unsupported
        // option, ENOTSUP or EXDEV from the kernel all look identical. Report the
        // resolved binary (its Nix store path names the coreutils version), the
        // exact argv, and whatever the command said.
        const child = spawn(binary, [...args], { stdio: ['ignore', 'ignore', 'pipe'] })
        let stderr = ''
        child.stderr?.setEncoding('utf8')
        child.stderr?.on('data', (chunk: string) => {
          if (stderr.length < 4096) stderr += chunk
        })
        child.once('error', reject)
        child.once('close', (exitCode, signal) => {
          if (exitCode === 0) {
            resolve()
            return
          }
          const detail = stderr.trim()
          const operands = args.filter((argument) => argument.startsWith('-') === false)
          const parents = [...new Set(operands.map((operand) => NodePath.dirname(operand)))]
          void describeRenameOperands([...operands, ...parents]).then((described) => {
            reject(
              new Error(
                `${commandName} exited ${String(exitCode)}${signal === null ? '' : ` (${signal})`}: ${binary} ${args.join(' ')}${detail === '' ? ' (no stderr)' : `\n${detail}`}\n  ${described}`,
              ),
            )
          })
        })
      }),
  })

const validateRuntimePath = ({
  path,
  name,
}: {
  path: string
  name: 'cp' | 'mv'
}): Effect.Effect<void, CpAMemberMountError> =>
  Effect.gen(function* () {
    if (NodePath.isAbsolute(path) === false) {
      return yield* error({
        reason: 'InvalidRequest',
        path,
        message: `${name} path must be an explicit absolute pinned path`,
      })
    }
    const info = yield* io({
      path,
      message: `Cannot inspect pinned ${name} path '${path}'`,
      reason: 'InvalidRequest',
      try: () => stat(path),
    })
    if (info.isFile() === false) {
      return yield* error({
        reason: 'InvalidRequest',
        path,
        message: `Pinned ${name} path is not a file: '${path}'`,
      })
    }
  })

const lstatMaybe = (path: string): Effect.Effect<Stats | undefined, CpAMemberMountError> =>
  io({
    path,
    message: `Cannot inspect '${path}'`,
    try: async () => {
      try {
        return await lstat(path)
      } catch (cause) {
        if (
          typeof cause === 'object' &&
          cause !== null &&
          'code' in cause &&
          cause.code === 'ENOENT'
        ) {
          return undefined
        }
        throw cause
      }
    },
  })

const transactionExists = (path: string): Effect.Effect<boolean, CpAMemberMountError> =>
  lstatMaybe(path).pipe(Effect.map((info) => info !== undefined))

const encodeTransaction = (transaction: CpAMemberMountTransactionType): string =>
  `${Schema.encodeSync(TransactionJson)(transaction)}\n`

const writeExclusiveTransaction = ({
  path,
  transaction,
  runtime,
}: {
  path: string
  transaction: CpAMemberMountTransactionType
  runtime: CpAMemberMountDurabilityRuntime
}): Effect.Effect<void, CpAMemberMountError> =>
  io({
    path,
    message: `Cannot create cp-a member mount transaction '${path}'`,
    try: async () => {
      await mkdir(NodePath.dirname(path), { recursive: true })
      const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(encodeTransaction(transaction), 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      try {
        await link(temporary, path)
      } catch (cause) {
        if (
          typeof cause === 'object' &&
          cause !== null &&
          'code' in cause &&
          cause.code === 'EEXIST'
        ) {
          throw error({
            reason: 'TransactionCollision',
            path,
            message: `A cp-a member mount transaction already exists at '${path}'`,
            recoveryPaths: [path],
          })
        }
        throw cause
      } finally {
        await unlink(temporary).catch(() => undefined)
      }
      await syncDirectoryPromise({
        runtime,
        path: NodePath.dirname(path),
        reason: 'TransactionCreate',
      })
    },
  })

const replaceTransaction = ({
  path,
  transaction,
  runtime,
}: {
  path: string
  transaction: CpAMemberMountTransactionType
  runtime: CpAMemberMountDurabilityRuntime
}): Effect.Effect<void, CpAMemberMountError> =>
  io({
    path,
    message: `Cannot atomically update cp-a member mount transaction '${path}'`,
    recoveryPaths: [path, transaction.destinationPath, transaction.stagePath],
    try: async () => {
      const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(encodeTransaction(transaction), 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      try {
        await rename(temporary, path)
      } finally {
        await unlink(temporary).catch(() => undefined)
      }
      await syncDirectoryPromise({
        runtime,
        path: NodePath.dirname(path),
        reason: 'TransactionReplace',
      })
    },
  })

const readTransaction = (
  path: string,
): Effect.Effect<CpAMemberMountTransactionType, CpAMemberMountError> =>
  io({
    path,
    message: `Cannot read cp-a member mount transaction '${path}'`,
    reason: 'AmbiguousRecovery',
    recoveryPaths: [path],
    try: async () => {
      const content = await readFile(path, 'utf8')
      return Schema.decodeSync(TransactionJson, strictParseOptions)(content)
    },
  })

const removeTransaction = ({
  path,
  runtime,
}: {
  path: string
  runtime: CpAMemberMountDurabilityRuntime
}): Effect.Effect<void, CpAMemberMountError> =>
  io({
    path,
    message: `Cannot remove completed cp-a member mount transaction '${path}'`,
    try: async () => {
      await unlink(path).catch((cause) => {
        if (
          typeof cause === 'object' &&
          cause !== null &&
          'code' in cause &&
          cause.code === 'ENOENT'
        )
          return
        throw cause
      })
      await syncDirectoryPromise({
        runtime,
        path: NodePath.dirname(path),
        reason: 'TransactionRemove',
      })
    },
  })

const runPhaseHook = ({
  runtime,
  phase,
  transaction,
}: {
  runtime: { readonly afterPhase?: (phase: CpAMemberMountPhaseHint) => Promise<void> }
  phase: CpAMemberMountPhaseHint
  transaction: CpAMemberMountTransactionType
}): Effect.Effect<void, CpAMemberMountError> =>
  runtime.afterPhase === undefined
    ? Effect.void
    : io({
        path: transaction.stagePath,
        message: `Cp-a member mount interrupted after ${phase}`,
        recoveryPaths: [
          transaction.destinationPath,
          transaction.stagePath,
          cpAMemberMountTransactionPath({
            workspaceRoot: NodePath.dirname(NodePath.dirname(transaction.destinationPath)),
            member: transaction.member,
          }),
        ],
        try: () => runtime.afterPhase!(phase),
      })

const updatePhase = ({
  transactionPath,
  transaction,
  phaseHint,
  candidateIdentity,
  runtime,
}: {
  transactionPath: string
  transaction: CpAMemberMountTransactionType
  phaseHint: CpAMemberMountPhaseHint
  candidateIdentity?: CpAMountInodeIdentity
  runtime: CpAMemberMountDurabilityRuntime
}): Effect.Effect<CpAMemberMountTransactionType, CpAMemberMountError> =>
  Effect.gen(function* () {
    const next: CpAMemberMountTransactionType = {
      ...transaction,
      phaseHint,
      newIdentity: {
        ...transaction.newIdentity,
        candidateIdentity: candidateIdentity ?? transaction.newIdentity.candidateIdentity,
      },
    }
    yield* replaceTransaction({ path: transactionPath, transaction: next, runtime })
    return next
  })

interface MovableProtectedRoot {
  readonly path: string
  readonly identity: CpAMountInodeIdentity
}

interface OpenMovableProtectedRoot extends MovableProtectedRoot {
  readonly handle: FileHandle
}

const assertOpenDirectoryIdentity = async ({
  root,
  expectedMode,
}: {
  root: OpenMovableProtectedRoot
  expectedMode?: number
}): Promise<void> => {
  const info = await root.handle.stat()
  if (
    info.isDirectory() === false ||
    identitiesEqual({ left: identityFromStat(info), right: root.identity }) === false
  ) {
    throw new Error(`Cp-a movable root identity changed at '${root.path}'`)
  }
  if (expectedMode !== undefined && (info.mode & 0o777) !== expectedMode) {
    throw new Error(
      `Cp-a movable root '${root.path}' has mode ${(info.mode & 0o777).toString(8)}, expected ${expectedMode.toString(8)}`,
    )
  }
}

const restoreOpenMovableRoot = async (root: OpenMovableProtectedRoot): Promise<void> => {
  try {
    await assertOpenDirectoryIdentity({ root })
    await root.handle.chmod(0o555)
    await assertOpenDirectoryIdentity({ root, expectedMode: 0o555 })
  } finally {
    await root.handle.close()
  }
}

const restoreOpenMovableRoots = async ({
  roots,
  index = 0,
  failures = [],
}: {
  roots: ReadonlyArray<OpenMovableProtectedRoot>
  index?: number
  failures?: Array<unknown>
}): Promise<ReadonlyArray<unknown>> => {
  const root = roots[index]
  if (root === undefined) return failures

  try {
    await restoreOpenMovableRoot(root)
  } catch (cause) {
    failures.push(cause)
  }
  return restoreOpenMovableRoots({ roots, index: index + 1, failures })
}

const openMovableProtectedRoots = async ({
  roots,
  opened,
  index = 0,
}: {
  roots: ReadonlyArray<MovableProtectedRoot>
  opened: Array<OpenMovableProtectedRoot>
  index?: number
}): Promise<ReadonlyArray<OpenMovableProtectedRoot>> => {
  const root = roots[index]
  if (root === undefined) return opened

  const handle = await open(root.path, 'r')
  const openedRoot = { ...root, handle }
  try {
    await assertOpenDirectoryIdentity({ root: openedRoot })
  } catch (cause) {
    await handle.close()
    throw cause
  }
  opened.push(openedRoot)
  await handle.chmod(0o755)
  await assertOpenDirectoryIdentity({ root: openedRoot, expectedMode: 0o755 })
  return openMovableProtectedRoots({ roots, opened, index: index + 1 })
}

/**
 * Darwin's directory rename requires a writable moved root even when its containing directory is
 * writable. Keep the R6-protected inode open across only the rename command, so both chmod calls
 * remain bound to the recorded inode even when exchange changes its pathname. The injected
 * platform also enables this behavior in deterministic tests on non-Darwin hosts.
 */
const withDarwinMovableProtectedRoots = <A>({
  platform,
  roots,
  effect,
  recoveryPaths,
}: {
  platform: RuntimePlatform
  roots: ReadonlyArray<MovableProtectedRoot>
  effect: Effect.Effect<A, CpAMemberMountError>
  recoveryPaths: ReadonlyArray<string>
}): Effect.Effect<A, CpAMemberMountError> => {
  if ((platform !== 'darwin' && process.platform !== 'darwin') || roots.length === 0) return effect

  return Effect.acquireUseRelease(
    io({
      path: roots.map(({ path }) => path).join(','),
      message: 'Cannot prepare protected cp-a roots for an atomic directory move',
      recoveryPaths,
      try: async () => {
        const opened: Array<OpenMovableProtectedRoot> = []
        try {
          return await openMovableProtectedRoots({ roots, opened })
        } catch (cause) {
          const restorationFailures = await restoreOpenMovableRoots({ roots: opened })
          if (restorationFailures.length > 0) {
            const preparationError = Object.assign(
              new Error(
                'Cannot restore cp-a roots after preparing an atomic directory move failed',
                { cause },
              ),
              { restorationFailures },
            )
            throw preparationError
          }
          throw cause
        }
      },
    }),
    () => effect,
    (opened) =>
      io({
        path: opened.map(({ path }) => path).join(','),
        message: 'Cannot restore protected cp-a roots after an atomic directory move',
        recoveryPaths,
        try: async () => {
          const failures = await restoreOpenMovableRoots({ roots: opened })
          if (failures.length > 0) {
            throw new AggregateError(
              failures,
              'Cannot restore protected cp-a roots after an atomic directory move',
            )
          }
        },
      }).pipe(Effect.orDie),
  )
}

/**
 * A process may die while Darwin roots are temporarily movable. Re-protect only transaction-bound
 * directory inodes before R6 observation, so recovery never treats a writable mount as valid.
 */
const restoreTransactionRootProtectionAtPath = async ({
  path,
  identities,
}: {
  path: string
  identities: ReadonlyArray<CpAMountInodeIdentity>
}): Promise<void> => {
  let pathInfo: Stats
  try {
    pathInfo = await lstat(path)
  } catch (cause) {
    if (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT')
      return
    throw cause
  }
  if (pathInfo.isDirectory() === false) return
  const pathIdentity = identityFromStat(pathInfo)
  const expectedIdentity = identities.find((identity) =>
    identitiesEqual({ left: pathIdentity, right: identity }),
  )
  if (expectedIdentity === undefined) return

  const handle = await open(path, 'r')
  const root = { path, identity: expectedIdentity, handle }
  try {
    await assertOpenDirectoryIdentity({ root })
    if ((pathInfo.mode & 0o777) !== 0o555) await handle.chmod(0o555)
    await assertOpenDirectoryIdentity({ root, expectedMode: 0o555 })
  } finally {
    await handle.close()
  }
}

const restoreTransactionRootsProtection = async ({
  paths,
  identities,
  index = 0,
}: {
  paths: ReadonlyArray<string>
  identities: ReadonlyArray<CpAMountInodeIdentity>
  index?: number
}): Promise<void> => {
  const path = paths[index]
  if (path === undefined) return

  await restoreTransactionRootProtectionAtPath({ path, identities })
  return restoreTransactionRootsProtection({ paths, identities, index: index + 1 })
}

const restoreTransactionRootProtection = ({
  transaction,
  platform,
  transactionPath,
}: {
  transaction: CpAMemberMountTransactionType
  platform: RuntimePlatform
  transactionPath: string
}): Effect.Effect<void, CpAMemberMountError> => {
  if (platform !== 'darwin' && process.platform !== 'darwin') return Effect.void

  const identities = [
    ...(transaction.newIdentity.candidateIdentity === null
      ? []
      : [transaction.newIdentity.candidateIdentity]),
    ...(transaction.oldIdentity._tag === 'Owned' ? [transaction.oldIdentity.identity] : []),
  ]
  const recoveryPaths = [
    transaction.destinationPath,
    transaction.stagePath,
    transactionPath,
  ] as const

  return io({
    path: transactionPath,
    message: 'Cannot restore transaction-bound cp-a roots before recovery',
    reason: 'AmbiguousRecovery',
    recoveryPaths,
    try: () =>
      restoreTransactionRootsProtection({
        paths: [transaction.destinationPath, transaction.stagePath],
        identities,
      }),
  })
}

const unprotectDirectoryTree = async (path: string): Promise<void> => {
  const info = await lstat(path)
  if (info.isSymbolicLink() === true || info.isDirectory() === false) return
  await chmod(path, 0o755)
  const children = await readdir(path)
  await Promise.all(children.map((child) => unprotectDirectoryTree(NodePath.join(path, child))))
}

const unprotectDirectories = (root: string): Effect.Effect<void, CpAMemberMountError> =>
  io({
    path: root,
    message: `Cannot unprotect directories under '${root}'`,
    try: () => unprotectDirectoryTree(root),
  })

const protectEntryTree = async (path: string): Promise<void> => {
  const info = await lstat(path)
  if (info.isSymbolicLink() === true) return
  if (info.isDirectory() === true) {
    const children = await readdir(path)
    await Promise.all(children.map((child) => protectEntryTree(NodePath.join(path, child))))
    await chmod(path, 0o555)
  } else if (info.isFile() === true) {
    await chmod(path, (info.mode & 0o111) === 0 ? 0o444 : 0o555)
  }
}

const protectTree = (root: string): Effect.Effect<void, CpAMemberMountError> =>
  io({
    path: root,
    message: `Cannot protect cp-a candidate '${root}'`,
    reason: 'StageInvalid',
    try: () => protectEntryTree(root),
  })

const teardownBoundDirectory = ({
  path,
  identity,
}: {
  path: string
  identity: CpAMountInodeIdentity
}): Effect.Effect<void, CpAMemberMountError> =>
  Effect.gen(function* () {
    yield* assertOwnedCpAMountIdentity({ path, expected: identity }).pipe(
      Effect.mapError((cause) =>
        error({
          reason: 'ExchangeValidationFailed',
          path,
          message: `Refusing to unprotect a different inode at '${path}'`,
          recoveryPaths: [path],
          cause,
        }),
      ),
    )
    yield* unprotectDirectories(path)
    yield* assertOwnedCpAMountIdentity({ path, expected: identity }).pipe(
      Effect.mapError((cause) =>
        error({
          reason: 'ExchangeValidationFailed',
          path,
          message: `Refusing to delete a different inode at '${path}'`,
          recoveryPaths: [path],
          cause,
        }),
      ),
    )
    yield* io({
      path,
      message: `Cannot delete owned cp-a tree '${path}'`,
      recoveryPaths: [path],
      try: () => rm(path, { recursive: true, force: false }),
    })
  })

const replaceCapabilities = ({
  stagePath,
  capabilitiesPath,
  cpPath,
}: {
  stagePath: string
  capabilitiesPath: string
  cpPath: string
}): Effect.Effect<void, CpAMemberMountError> =>
  Effect.gen(function* () {
    const destination = NodePath.join(stagePath, '.buck2', 'capabilities')
    yield* io({
      path: destination,
      message: `Cannot prepare capability projection at '${destination}'`,
      reason: 'StageInvalid',
      try: async () => {
        await rm(destination, { recursive: true, force: true })
        await mkdir(destination, { recursive: true })
      },
    })
    yield* runCommand({
      binary: cpPath,
      args: ['-a', `${capabilitiesPath}${NodePath.sep}.`, destination],
      path: destination,
      commandName: 'GNU cp -a capability copy',
    })
  })

const assertIndependentFileInodes = ({
  sourceRoot,
  destinationRoot,
  scan,
}: {
  sourceRoot: string
  destinationRoot: string
  scan: R6MountScan
}): Effect.Effect<void, CpAMemberMountError> =>
  io({
    path: destinationRoot,
    message: `Cannot verify independent cp-a inodes at '${destinationRoot}'`,
    reason: 'StageInvalid',
    try: () =>
      Promise.all(
        scan.repository.manifest.entries
          .filter((entry) => entry.kind === 'file')
          .map(async (entry) => {
            const [source, destination] = await Promise.all([
              lstat(NodePath.join(sourceRoot, entry.path)),
              lstat(NodePath.join(destinationRoot, entry.path)),
            ])
            if (source.dev === destination.dev && source.ino === destination.ino) {
              throw new Error(`cp -a reused source inode for '${entry.path}'`)
            }
          }),
      ).then(() => undefined),
  })

const assertStagePostcondition = ({
  stagePath,
  sourcePath,
  capabilitiesPath,
  sourceScan,
  capabilitiesScan,
  declaredOverlays,
}: {
  stagePath: string
  sourcePath: string
  capabilitiesPath: string
  sourceScan: R6MountScan
  capabilitiesScan: R6MountScan
  declaredOverlays: CpAMemberMountRequest['distOverlays']
}): Effect.Effect<R6MountScan, CpAMemberMountError> =>
  Effect.gen(function* () {
    const stageScan = yield* scanR6ProtectedMount({ root: stagePath, declaredOverlays }).pipe(
      Effect.mapError((cause) =>
        error({
          reason: 'StageInvalid',
          path: stagePath,
          message: `Protected cp-a candidate failed R6 validation at '${stagePath}'`,
          cause,
        }),
      ),
    )
    const repositoryMatches =
      sourceScan.repository.digest === stageScan.repository.digest &&
      sourceScan.repository.count === stageScan.repository.count
    const capabilitiesMatch =
      stageScan.capabilities.present === true &&
      capabilitiesScan.repository.digest === stageScan.capabilities.digest &&
      capabilitiesScan.repository.count === stageScan.capabilities.count
    if (repositoryMatches === false || capabilitiesMatch === false) {
      return yield* error({
        reason: 'StageInvalid',
        path: stagePath,
        message: `Cp-a candidate R6 postcondition does not match source and capability identities`,
        cause: new Error(
          `repository ${sourceScan.repository.digest}:${sourceScan.repository.count} != ${stageScan.repository.digest}:${stageScan.repository.count}; capabilities ${capabilitiesScan.repository.digest}:${capabilitiesScan.repository.count} != ${stageScan.capabilities.digest}:${stageScan.capabilities.count}`,
        ),
      })
    }
    yield* assertIndependentFileInodes({
      sourceRoot: sourcePath,
      destinationRoot: stagePath,
      scan: sourceScan,
    })
    yield* assertIndependentFileInodes({
      sourceRoot: capabilitiesPath,
      destinationRoot: NodePath.join(stagePath, '.buck2', 'capabilities'),
      scan: capabilitiesScan,
    })
    return stageScan
  })

const assertSourceUnchanged = ({
  sourcePath,
  beforeScan,
  beforeSnapshot,
  declaredOverlays = [],
}: {
  sourcePath: string
  beforeScan: R6MountScan
  beforeSnapshot: SourceSnapshot
  declaredOverlays?: CpAMemberMountRequest['distOverlays']
}): Effect.Effect<void, CpAMemberMountError> =>
  Effect.gen(function* () {
    const afterScan = yield* scanR6Source({ root: sourcePath, declaredOverlays }).pipe(
      Effect.mapError((cause) =>
        error({
          reason: 'SourceChanged',
          path: sourcePath,
          message: `Immutable source became invalid during cp-a staging at '${sourcePath}'`,
          cause,
        }),
      ),
    )
    const afterSnapshot = yield* sourceSnapshot({ root: sourcePath, scan: afterScan })
    if (
      beforeScan.identity.dev !== afterScan.identity.dev ||
      beforeScan.identity.ino !== afterScan.identity.ino ||
      beforeScan.repository.digest !== afterScan.repository.digest ||
      beforeScan.capabilities.digest !== afterScan.capabilities.digest ||
      snapshotsEqual({ left: beforeSnapshot, right: afterSnapshot }) === false
    ) {
      return yield* error({
        reason: 'SourceChanged',
        path: sourcePath,
        message: `Immutable source inode, mode, or digest changed during cp-a staging`,
      })
    }
  })

const classifyDestination = ({
  workspaceRoot,
  member,
  destinationPath,
}: {
  workspaceRoot: string
  member: string
  destinationPath: string
}): Effect.Effect<CpAMountOldIdentity, CpAMemberMountError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const s0 = yield* inspectMemberMount(destinationPath).pipe(
      Effect.mapError((cause) =>
        error({
          reason: 'IoFailure',
          path: destinationPath,
          message: `Cannot inspect member mount '${destinationPath}'`,
          cause,
        }),
      ),
    )
    if (s0._tag === 'Missing') return { _tag: 'Missing' as const }
    if (s0._tag === 'Symlink') {
      const info = yield* io({
        path: destinationPath,
        message: `Cannot capture legacy symlink identity at '${destinationPath}'`,
        try: () => lstat(destinationPath),
      })
      return {
        _tag: 'LegacySymlink' as const,
        target: s0.target,
        identity: identityFromStat(info),
      }
    }

    const info = yield* io({
      path: destinationPath,
      message: `Cannot capture member mount identity at '${destinationPath}'`,
      try: () => lstat(destinationPath),
    })
    if (info.isDirectory() === false) {
      return yield* error({
        reason: 'DestinationRefused',
        path: destinationPath,
        message: `Refusing foreign non-directory member mount at '${destinationPath}'`,
        recoveryPaths: [destinationPath],
      })
    }
    const metadataResult = yield* readOwnedCpAMountMetadata({
      workspaceRoot,
      member,
      publishedPath: destinationPath,
    }).pipe(Effect.result)
    if (metadataResult._tag === 'Failure') {
      return yield* error({
        reason: 'DestinationRefused',
        path: destinationPath,
        message: `Refusing real member directory without valid owned cp-a metadata at '${destinationPath}'`,
        recoveryPaths: [destinationPath],
        cause: metadataResult.failure,
      })
    }
    const metadata = metadataResult.success
    const identity = identityFromStat(info)
    const inspection = yield* inspectOwnedCpAMount({
      workspaceRoot,
      physicalPath: destinationPath,
      expected: {
        member,
        lockedCommit: metadata.lockedCommit,
        sourcePathIdentity: metadata.sourcePathIdentity,
        publishedPath: destinationPath,
      },
      expectedPreExchangeIdentity: identity,
    }).pipe(
      Effect.mapError((cause) =>
        error({
          reason: 'IoFailure',
          path: destinationPath,
          message: `Cannot inspect owned cp-a member mount '${destinationPath}'`,
          cause,
        }),
      ),
    )
    if (inspection._tag !== 'Owned') {
      return yield* error({
        reason: 'DestinationRefused',
        path: destinationPath,
        message: `Refusing invalid or foreign member mount at '${destinationPath}'`,
        recoveryPaths: [destinationPath],
        cause: inspection,
      })
    }
    return { _tag: 'Owned' as const, metadata: inspection.metadata, identity: inspection.identity }
  })

const assertLegacySymlink = ({
  path,
  expected,
}: {
  path: string
  expected: Extract<CpAMountOldIdentity, { readonly _tag: 'LegacySymlink' }>
}): Effect.Effect<void, CpAMemberMountError> =>
  io({
    path,
    message: `Swapped-old legacy symlink identity changed at '${path}'`,
    reason: 'ExchangeValidationFailed',
    recoveryPaths: [path],
    try: async () => {
      const info = await lstat(path)
      const target = await readlink(path)
      if (
        info.isSymbolicLink() === false ||
        identitiesEqual({ left: identityFromStat(info), right: expected.identity }) === false ||
        target !== expected.target
      ) {
        throw new Error(`Legacy symlink identity mismatch at '${path}'`)
      }
    },
  })

const assertStoredOwnedTree = ({
  path,
  expected,
  allowPartial = false,
}: {
  path: string
  expected: Extract<CpAMountOldIdentity, { readonly _tag: 'Owned' }>
  allowPartial?: boolean
}): Effect.Effect<void, CpAMemberMountError> =>
  Effect.gen(function* () {
    yield* assertOwnedCpAMountIdentity({ path, expected: expected.identity }).pipe(
      Effect.mapError((cause) =>
        error({
          reason: 'ExchangeValidationFailed',
          path,
          message: `Swapped-old owned inode identity changed at '${path}'`,
          recoveryPaths: [path],
          cause,
        }),
      ),
    )
    if (allowPartial === true) return
    const result = yield* scanR6ProtectedMount({
      root: path,
      declaredOverlays: expected.metadata.declaredOverlays,
    }).pipe(Effect.result)
    if (
      result._tag === 'Failure' ||
      metadataScanMatches({ metadata: expected.metadata, scan: result.success }) === false
    ) {
      return yield* error({
        reason: 'ExchangeValidationFailed',
        path,
        message: `Swapped-old owned R6 identity changed at '${path}'`,
        recoveryPaths: [path],
        ...(result._tag === 'Failure' ? { cause: result.failure } : {}),
      })
    }
  })

const assertOldAtStage = ({
  stagePath,
  oldIdentity,
}: {
  stagePath: string
  oldIdentity: Exclude<CpAMountOldIdentity, { readonly _tag: 'Missing' }>
}): Effect.Effect<void, CpAMemberMountError> =>
  oldIdentity._tag === 'LegacySymlink'
    ? assertLegacySymlink({ path: stagePath, expected: oldIdentity })
    : assertStoredOwnedTree({ path: stagePath, expected: oldIdentity })

const deleteOldAtStage = ({
  stagePath,
  oldIdentity,
  allowPartial = false,
}: {
  stagePath: string
  oldIdentity: Exclude<CpAMountOldIdentity, { readonly _tag: 'Missing' }>
  allowPartial?: boolean
}): Effect.Effect<void, CpAMemberMountError> =>
  oldIdentity._tag === 'LegacySymlink'
    ? Effect.gen(function* () {
        yield* assertLegacySymlink({ path: stagePath, expected: oldIdentity })
        yield* io({
          path: stagePath,
          message: `Cannot unlink swapped-old legacy symlink '${stagePath}'`,
          recoveryPaths: [stagePath],
          try: () => unlink(stagePath),
        })
      })
    : Effect.gen(function* () {
        yield* assertStoredOwnedTree({ path: stagePath, expected: oldIdentity, allowPartial })
        yield* teardownBoundDirectory({ path: stagePath, identity: oldIdentity.identity })
      })

const ensureExchangeAllowed = ({
  platform,
  allowVerifiedDarwinAdvance,
  destinationPath,
}: {
  platform: RuntimePlatform
  allowVerifiedDarwinAdvance: boolean
  destinationPath: string
}): Effect.Effect<void, CpAMemberMountError> => {
  if (platform === 'linux') return Effect.void
  if (platform === 'darwin' && allowVerifiedDarwinAdvance === true) return Effect.void
  return Effect.fail(
    error({
      reason: 'PlatformAdvanceRefused',
      path: destinationPath,
      message:
        platform === 'darwin'
          ? 'Darwin cp-a mount advance is gated until the caller opts into verified FSEvents and digest primitives'
          : `Cp-a mount exchange is unsupported on platform '${platform}'`,
      recoveryPaths: [destinationPath],
    }),
  )
}

const planSteps = (operation: CpAMemberMountOperation): ReadonlyArray<CpAMemberMountPlanStep> => {
  if (operation === 'AlreadyCurrent') return []
  const publishStep = operation === 'FirstPublish' ? 'PublishRename' : 'Exchange'
  const cleanupSteps: ReadonlyArray<CpAMemberMountPlanStep> =
    operation === 'FirstPublish' ? [] : ['ValidateOldIdentity', 'DeleteOld']
  return [
    'CreateTransaction',
    'CopySource',
    'ReplaceCapabilities',
    'CheckCapabilities',
    'ProtectCandidate',
    'ValidatePostcondition',
    publishStep,
    'PublishMetadata',
    ...cleanupSteps,
    'RemoveTransaction',
  ]
}

/**
 * Materialize or advance one cp-a member mount. This primitive is not wired into syncMember.
 * Transactions make every process-interruption boundary recoverable. Directory fsync orders durable
 * namespace entries, but copied file-byte durability across power loss remains a filesystem/store
 * responsibility; recovery always revalidates observed R6 identities before acting.
 */
export const materializeCpAMemberMount = ({
  request: untrustedRequest,
  runtime,
}: {
  request: CpAMemberMountRequest
  runtime: CpAMemberMountRuntime
}): Effect.Effect<CpAMemberMountResult, CpAMemberMountError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const request = yield* decodeRequest(untrustedRequest).pipe(mapRequestError('request'))
    yield* validateRuntimePath({ path: runtime.cpPath, name: 'cp' })
    yield* validateRuntimePath({ path: runtime.mvPath, name: 'mv' })
    const destinationPath = cpAMemberMountDestinationPath(request)
    const transactionPath = cpAMemberMountTransactionPath(request)
    if ((yield* transactionExists(transactionPath)) === true) {
      return yield* error({
        reason: 'TransactionCollision',
        path: transactionPath,
        message: `A cp-a member mount transaction already exists for '${request.member}'`,
        recoveryPaths: [transactionPath],
      })
    }

    const sourceScan = yield* scanR6Source({
      root: request.sourcePath,
      declaredOverlays: request.distOverlays,
    }).pipe(
      Effect.mapError((cause) =>
        error({
          reason: 'SourceInvalid',
          path: request.sourcePath,
          message: `Immutable source failed R6 validation at '${request.sourcePath}'`,
          cause,
        }),
      ),
    )
    const sourceBefore = yield* sourceSnapshot({ root: request.sourcePath, scan: sourceScan })
    const capabilitiesScan = yield* scanR6Source({ root: request.capabilitiesPath }).pipe(
      Effect.mapError((cause) =>
        error({
          reason: 'SourceInvalid',
          path: request.capabilitiesPath,
          message: `Capability source failed R6 validation at '${request.capabilitiesPath}'`,
          cause,
        }),
      ),
    )
    const capabilitiesBefore = yield* sourceSnapshot({
      root: request.capabilitiesPath,
      scan: capabilitiesScan,
    })
    const sourcePathIdentity = yield* computeR6SourcePathIdentity(request.sourcePath).pipe(
      Effect.mapError((cause) =>
        error({
          reason: 'SourceInvalid',
          path: request.sourcePath,
          message: `Cannot acquire immutable source path identity at '${request.sourcePath}'`,
          cause,
        }),
      ),
    )
    const oldIdentity = yield* classifyDestination({
      workspaceRoot: request.workspaceRoot,
      member: request.member,
      destinationPath,
    })
    const plannedScan: R6MountScan = {
      identity: sourceScan.identity,
      repository: sourceScan.repository,
      capabilities: { ...capabilitiesScan.repository, present: true },
      overlays: sourceScan.overlays,
    }
    const newMetadata = makeOwnedCpAMountMetadata({
      member: request.member,
      lockedCommit: request.lockedCommit,
      sourcePathIdentity,
      publishedPath: destinationPath,
      declaredOverlays: request.distOverlays,
      scan: plannedScan,
    })
    const operation: CpAMemberMountOperation =
      oldIdentity._tag === 'Missing'
        ? 'FirstPublish'
        : oldIdentity._tag === 'LegacySymlink'
          ? 'LegacyConversion'
          : mountAuthorityEqual({ left: oldIdentity.metadata, right: newMetadata }) === true
            ? 'AlreadyCurrent'
            : 'Advance'
    const nonce = runtime.nonce?.() ?? `${process.pid}-${randomBytes(8).toString('hex')}`
    if (/^[A-Za-z0-9_-]+$/u.test(nonce) === false) {
      return yield* error({
        reason: 'InvalidRequest',
        path: nonce,
        message:
          'Cp-a staging nonce must contain only ASCII letters, digits, underscore, or hyphen',
      })
    }
    const stagePath = NodePath.join(
      NodePath.dirname(destinationPath),
      `.mr-stage-${encodeCpAMountMemberFilename(request.member).slice(0, -5)}-${nonce}`,
    )
    const plan: CpAMemberMountPlan = {
      _tag: 'MountPlan',
      operation,
      member: request.member,
      sourcePath: request.sourcePath,
      destinationPath,
      stagePath,
      transactionPath,
      oldIdentity,
      newMetadata:
        operation === 'AlreadyCurrent' && oldIdentity._tag === 'Owned'
          ? oldIdentity.metadata
          : newMetadata,
      steps: [...planSteps(operation)],
    }

    if (operation === 'AlreadyCurrent') {
      if (oldIdentity._tag !== 'Owned') {
        throw new TypeError(`Already-current mount '${request.member}' has no owned metadata`)
      }
      return request.dryRun === true
        ? { _tag: 'DryRun' as const, plan }
        : { _tag: 'AlreadyCurrent' as const, destinationPath, metadata: oldIdentity.metadata }
    }
    if (operation !== 'FirstPublish') {
      yield* ensureExchangeAllowed({
        platform: runtime.platform ?? process.platform,
        allowVerifiedDarwinAdvance: request.allowVerifiedDarwinAdvance,
        destinationPath,
      })
    }
    if (request.dryRun === true) return { _tag: 'DryRun' as const, plan }

    let transaction: CpAMemberMountTransactionType = {
      version: CP_A_MEMBER_MOUNT_TRANSACTION_VERSION,
      member: request.member,
      sourcePath: request.sourcePath,
      destinationPath,
      stagePath,
      operation,
      phaseHint: 'Intent',
      oldIdentity,
      newIdentity: { metadata: newMetadata, candidateIdentity: null },
    }
    yield* writeExclusiveTransaction({ path: transactionPath, transaction, runtime })
    yield* runPhaseHook({ runtime, phase: 'Intent', transaction })

    const stageInfo = yield* io({
      path: stagePath,
      message: `Cannot create unique cp-a staging directory '${stagePath}'`,
      try: async () => {
        await mkdir(stagePath, { recursive: false, mode: 0o755 })
        return lstat(stagePath)
      },
    })
    const candidateIdentity = identityFromStat(stageInfo)
    const candidateRecordResult = yield* updatePhase({
      transactionPath,
      transaction,
      phaseHint: transaction.phaseHint,
      candidateIdentity,
      runtime,
    }).pipe(Effect.result)
    if (candidateRecordResult._tag === 'Failure') {
      const cleanupResult = yield* teardownBoundDirectory({
        path: stagePath,
        identity: candidateIdentity,
      }).pipe(Effect.result)
      if (cleanupResult._tag === 'Success') {
        yield* syncDirectory({
          runtime,
          path: NodePath.dirname(stagePath),
          reason: 'CandidateCleanup',
        })
        yield* removeTransaction({ path: transactionPath, runtime })
      }
      return yield* candidateRecordResult.failure
    }
    transaction = candidateRecordResult.success
    yield* syncDirectory({
      runtime,
      path: NodePath.dirname(stagePath),
      reason: 'StageCreate',
    })
    transaction = yield* updatePhase({
      transactionPath,
      transaction,
      phaseHint: 'CandidateCreated',
      runtime,
    })
    yield* runPhaseHook({ runtime, phase: 'CandidateCreated', transaction })

    const stageResult = yield* Effect.gen(function* () {
      yield* runCommand({
        binary: runtime.cpPath,
        args: ['-a', `${request.sourcePath}${NodePath.sep}.`, stagePath],
        path: stagePath,
        commandName: 'GNU cp -a source copy',
      })
      yield* replaceCapabilities({
        stagePath,
        capabilitiesPath: request.capabilitiesPath,
        cpPath: runtime.cpPath,
      })
      yield* io({
        path: stagePath,
        message: `Capability check failed for cp-a candidate '${stagePath}'`,
        reason: 'CapabilityCheckFailed',
        try: () =>
          runtime.capabilityCheck({
            member: request.member,
            stagePath,
            capabilitiesPath: NodePath.join(stagePath, '.buck2', 'capabilities'),
          }),
      })
      yield* protectTree(stagePath)
      yield* assertStagePostcondition({
        stagePath,
        sourcePath: request.sourcePath,
        capabilitiesPath: request.capabilitiesPath,
        sourceScan,
        capabilitiesScan,
        declaredOverlays: request.distOverlays,
      })
      yield* assertSourceUnchanged({
        sourcePath: request.sourcePath,
        beforeScan: sourceScan,
        beforeSnapshot: sourceBefore,
        declaredOverlays: request.distOverlays,
      })
      yield* assertSourceUnchanged({
        sourcePath: request.capabilitiesPath,
        beforeScan: capabilitiesScan,
        beforeSnapshot: capabilitiesBefore,
      })
    }).pipe(Effect.result)
    if (stageResult._tag === 'Failure') {
      const cleanupResult = yield* teardownBoundDirectory({
        path: stagePath,
        identity: candidateIdentity,
      }).pipe(Effect.result)
      if (cleanupResult._tag === 'Success') {
        yield* syncDirectory({
          runtime,
          path: NodePath.dirname(stagePath),
          reason: 'CandidateCleanup',
        })
        yield* removeTransaction({ path: transactionPath, runtime })
      }
      return yield* stageResult.failure
    }

    transaction = yield* updatePhase({ transactionPath, transaction, phaseHint: 'Staged', runtime })
    yield* runPhaseHook({ runtime, phase: 'Staged', transaction })

    if (operation === 'FirstPublish') {
      const destinationNow = yield* lstatMaybe(destinationPath)
      if (destinationNow !== undefined) {
        return yield* error({
          reason: 'DestinationRefused',
          path: destinationPath,
          message: `Destination appeared after cp-a planning; preserving candidate and transaction`,
          recoveryPaths: [destinationPath, stagePath, transactionPath],
        })
      }
      if (runtime.beforeFirstPublish !== undefined) {
        yield* io({
          path: destinationPath,
          message: `First-publish boundary hook failed for '${destinationPath}'`,
          recoveryPaths: [destinationPath, stagePath, transactionPath],
          try: () => runtime.beforeFirstPublish!({ destinationPath, stagePath }),
        })
      }
      const recoveryPaths = [destinationPath, stagePath, transactionPath]
      yield* withDarwinMovableProtectedRoots({
        platform: runtime.platform ?? process.platform,
        roots: [{ path: stagePath, identity: candidateIdentity }],
        recoveryPaths,
        effect: runCommand({
          binary: runtime.mvPath,
          args: ['-T', '--no-clobber', '--no-copy', stagePath, destinationPath],
          path: destinationPath,
          commandName: 'GNU mv no-clobber first publish',
          recoveryPaths,
        }),
      })
      const [stageAfterPublish, destinationAfterPublish] = yield* Effect.all([
        lstatMaybe(stagePath),
        lstatMaybe(destinationPath),
      ])
      if (
        stageAfterPublish !== undefined ||
        destinationAfterPublish === undefined ||
        destinationAfterPublish.isDirectory() === false ||
        identitiesEqual({
          left: identityFromStat(destinationAfterPublish),
          right: candidateIdentity,
        }) === false
      ) {
        return yield* error({
          reason: 'DestinationRefused',
          path: destinationPath,
          message: `No-clobber first publish did not install the recorded candidate; preserving both paths`,
          recoveryPaths: [destinationPath, stagePath, transactionPath],
        })
      }
      yield* syncDirectory({
        runtime,
        path: NodePath.dirname(destinationPath),
        reason: 'FirstPublish',
      })
    } else {
      const recoveryPaths = [destinationPath, stagePath, transactionPath]
      yield* withDarwinMovableProtectedRoots({
        platform: runtime.platform ?? process.platform,
        roots: [
          { path: stagePath, identity: candidateIdentity },
          ...(oldIdentity._tag === 'Owned'
            ? [{ path: destinationPath, identity: oldIdentity.identity }]
            : []),
        ],
        recoveryPaths,
        effect: runCommand({
          binary: runtime.mvPath,
          args: ['-T', '--exchange', '--no-copy', stagePath, destinationPath],
          path: destinationPath,
          commandName: 'GNU mv exchange',
          recoveryPaths,
        }),
      })
      yield* syncDirectory({
        runtime,
        path: NodePath.dirname(destinationPath),
        reason: 'Exchange',
      })
    }
    transaction = yield* updatePhase({
      transactionPath,
      transaction,
      phaseHint: 'Exchanged',
      runtime,
    })
    yield* runPhaseHook({ runtime, phase: 'Exchanged', transaction })

    if (operation !== 'FirstPublish') {
      if (oldIdentity._tag === 'Missing') {
        return yield* error({
          reason: 'ExchangeValidationFailed',
          path: stagePath,
          message: 'Exchange operation lost its recorded old identity',
          recoveryPaths: [destinationPath, stagePath, transactionPath],
        })
      }
      yield* assertOldAtStage({ stagePath, oldIdentity })
    }
    yield* writeOwnedCpAMountMetadata({
      workspaceRoot: request.workspaceRoot,
      metadata: newMetadata,
    }).pipe(
      Effect.mapError((cause) =>
        error({
          reason: 'IoFailure',
          path: ownedCpAMountMetadataPath({
            workspaceRoot: request.workspaceRoot,
            member: request.member,
          }),
          message: `Cannot publish final cp-a mount metadata for '${request.member}'`,
          recoveryPaths: [destinationPath, stagePath, transactionPath],
          cause,
        }),
      ),
    )
    yield* syncDirectory({
      runtime,
      path: NodePath.dirname(
        ownedCpAMountMetadataPath({ workspaceRoot: request.workspaceRoot, member: request.member }),
      ),
      reason: 'MetadataPublish',
    })
    transaction = yield* updatePhase({
      transactionPath,
      transaction,
      phaseHint: 'MetadataPublished',
      runtime,
    })
    yield* runPhaseHook({ runtime, phase: 'MetadataPublished', transaction })

    if (operation !== 'FirstPublish') {
      if (oldIdentity._tag === 'Missing') {
        return yield* error({
          reason: 'ExchangeValidationFailed',
          path: stagePath,
          message: 'Cleanup operation lost its recorded old identity',
          recoveryPaths: [destinationPath, stagePath, transactionPath],
        })
      }
      transaction = yield* updatePhase({
        transactionPath,
        transaction,
        phaseHint: 'Cleanup',
        runtime,
      })
      yield* runPhaseHook({ runtime, phase: 'Cleanup', transaction })
      yield* deleteOldAtStage({ stagePath, oldIdentity })
      yield* syncDirectory({
        runtime,
        path: NodePath.dirname(stagePath),
        reason: 'OldCleanup',
      })
    }
    yield* removeTransaction({ path: transactionPath, runtime })
    return { _tag: 'Published' as const, operation, destinationPath, metadata: newMetadata }
  }).pipe(
    Observability.withLabelSpan({
      name: 'megarepo/member-mount/cp-a/materialize',
      labelValue: 'cp-a-materialize',
    }),
  )

type ObservedPath =
  | { readonly _tag: 'Missing' }
  | { readonly _tag: 'New' }
  | { readonly _tag: 'NewPartial' }
  | { readonly _tag: 'Old' }
  | { readonly _tag: 'OldPartial' }
  | { readonly _tag: 'Other' }

const observeTransactionPath = ({
  path,
  transaction,
}: {
  path: string
  transaction: CpAMemberMountTransactionType
}): Effect.Effect<ObservedPath, CpAMemberMountError> =>
  Effect.gen(function* () {
    const info = yield* lstatMaybe(path)
    if (info === undefined) return { _tag: 'Missing' as const }
    const actual = identityFromStat(info)
    const candidateIdentity = transaction.newIdentity.candidateIdentity
    if (
      candidateIdentity !== null &&
      identitiesEqual({ left: actual, right: candidateIdentity }) === true &&
      info.isDirectory() === true
    ) {
      const scan = yield* scanR6ProtectedMount({
        root: path,
        declaredOverlays: transaction.newIdentity.metadata.declaredOverlays,
      }).pipe(Effect.result)
      return scan._tag === 'Success' &&
        metadataScanMatches({ metadata: transaction.newIdentity.metadata, scan: scan.success }) ===
          true
        ? { _tag: 'New' as const }
        : { _tag: 'NewPartial' as const }
    }
    const old = transaction.oldIdentity
    if (old._tag === 'Missing') return { _tag: 'Other' as const }
    if (identitiesEqual({ left: actual, right: old.identity }) === false)
      return { _tag: 'Other' as const }
    if (old._tag === 'LegacySymlink') {
      if (info.isSymbolicLink() === false) return { _tag: 'Other' as const }
      const target = yield* io({
        path,
        message: `Cannot read transaction legacy symlink '${path}'`,
        try: () => readlink(path),
      })
      return target === old.target ? { _tag: 'Old' as const } : { _tag: 'Other' as const }
    }
    if (info.isDirectory() === false) return { _tag: 'Other' as const }
    const scan = yield* scanR6ProtectedMount({
      root: path,
      declaredOverlays: old.metadata.declaredOverlays,
    }).pipe(Effect.result)
    return scan._tag === 'Success' &&
      metadataScanMatches({ metadata: old.metadata, scan: scan.success }) === true
      ? { _tag: 'Old' as const }
      : { _tag: 'OldPartial' as const }
  })

const validateTransactionPaths = ({
  request,
  transaction,
  transactionPath,
}: {
  request: CpAMemberMountRecoveryRequest
  transaction: CpAMemberMountTransactionType
  transactionPath: string
}): Effect.Effect<void, CpAMemberMountError> => {
  const destinationPath = cpAMemberMountDestinationPath(request)
  if (
    transaction.member !== request.member ||
    transaction.destinationPath !== destinationPath ||
    NodePath.dirname(transaction.stagePath) !== NodePath.dirname(destinationPath) ||
    transaction.stagePath === destinationPath
  ) {
    return Effect.fail(
      error({
        reason: 'AmbiguousRecovery',
        path: transactionPath,
        message: `Transaction path bindings do not match recovery request for '${request.member}'`,
        recoveryPaths: [transactionPath, destinationPath, transaction.stagePath],
      }),
    )
  }
  return Effect.void
}

const publishMetadataFromTransaction = ({
  workspaceRoot,
  transaction,
  runtime,
}: {
  workspaceRoot: string
  transaction: CpAMemberMountTransactionType
  runtime: CpAMemberMountDurabilityRuntime
}): Effect.Effect<void, CpAMemberMountError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    yield* writeOwnedCpAMountMetadata({
      workspaceRoot,
      metadata: transaction.newIdentity.metadata,
    }).pipe(
      Effect.mapError((cause) =>
        error({
          reason: 'IoFailure',
          path: transaction.destinationPath,
          message: `Cannot roll forward cp-a metadata for '${transaction.member}'`,
          recoveryPaths: [transaction.destinationPath, transaction.stagePath],
          cause,
        }),
      ),
    )
    yield* syncDirectory({
      runtime,
      path: NodePath.dirname(
        ownedCpAMountMetadataPath({ workspaceRoot, member: transaction.member }),
      ),
      reason: 'MetadataPublish',
    })
  })

/**
 * Reconcile process interruption from observed inode and R6 identities, never phase hints. Directory
 * fsync checkpoints order namespace durability across power loss; they do not fsync every staged file
 * byte, so recovery treats failed R6 observation as ambiguous rather than claiming full byte durability.
 */
export const recoverCpAMemberMount = ({
  request: untrustedRequest,
  runtime,
}: {
  request: CpAMemberMountRecoveryRequest
  runtime: CpAMemberMountRecoveryRuntime
}): Effect.Effect<CpAMemberMountResult, CpAMemberMountError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const request = yield* decodeRecoveryRequest(untrustedRequest).pipe(
      mapRequestError('recovery request'),
    )
    yield* validateRuntimePath({ path: runtime.mvPath, name: 'mv' })
    const transactionPath = cpAMemberMountTransactionPath(request)
    const transaction = yield* readTransaction(transactionPath)
    yield* validateTransactionPaths({ request, transaction, transactionPath })
    const platform = runtime.platform ?? process.platform
    yield* restoreTransactionRootProtection({ transaction, platform, transactionPath })

    let destination = yield* observeTransactionPath({
      path: transaction.destinationPath,
      transaction,
    })
    let stage = yield* observeTransactionPath({ path: transaction.stagePath, transaction })

    const rollbackCandidate = Effect.gen(function* () {
      const identity = transaction.newIdentity.candidateIdentity
      if (identity === null) {
        return yield* error({
          reason: 'AmbiguousRecovery',
          path: transaction.stagePath,
          message: `Cannot delete candidate without a recorded inode identity`,
          recoveryPaths: [transaction.destinationPath, transaction.stagePath, transactionPath],
        })
      }
      yield* teardownBoundDirectory({ path: transaction.stagePath, identity })
      yield* syncDirectory({
        runtime,
        path: NodePath.dirname(transaction.stagePath),
        reason: 'CandidateCleanup',
      })
      yield* removeTransaction({ path: transactionPath, runtime })
      return {
        _tag: 'Recovered' as const,
        action: 'RolledBack' as const,
        destinationPath: transaction.destinationPath,
      }
    })

    if (transaction.operation === 'FirstPublish') {
      if (destination._tag === 'Missing' && stage._tag === 'Missing') {
        yield* removeTransaction({ path: transactionPath, runtime })
        return {
          _tag: 'Recovered' as const,
          action: 'RolledBack' as const,
          destinationPath: transaction.destinationPath,
        }
      }
      if (destination._tag === 'Missing' && stage._tag === 'NewPartial') {
        return yield* rollbackCandidate
      }
      if (destination._tag === 'Missing' && stage._tag === 'New') {
        const candidateIdentity = transaction.newIdentity.candidateIdentity
        const recoveryPaths = [transaction.destinationPath, transaction.stagePath, transactionPath]
        yield* withDarwinMovableProtectedRoots({
          platform,
          roots:
            candidateIdentity === null
              ? []
              : [{ path: transaction.stagePath, identity: candidateIdentity }],
          recoveryPaths,
          effect: runCommand({
            binary: runtime.mvPath,
            args: [
              '-T',
              '--no-clobber',
              '--no-copy',
              transaction.stagePath,
              transaction.destinationPath,
            ],
            path: transaction.destinationPath,
            commandName: 'GNU mv no-clobber recovery publish',
            recoveryPaths,
          }),
        })
        const [stageAfterPublish, destinationAfterPublish] = yield* Effect.all([
          lstatMaybe(transaction.stagePath),
          lstatMaybe(transaction.destinationPath),
        ])
        if (
          candidateIdentity === null ||
          stageAfterPublish !== undefined ||
          destinationAfterPublish === undefined ||
          destinationAfterPublish.isDirectory() === false ||
          identitiesEqual({
            left: identityFromStat(destinationAfterPublish),
            right: candidateIdentity,
          }) === false
        ) {
          return yield* error({
            reason: 'AmbiguousRecovery',
            path: transaction.destinationPath,
            message: 'Recovery no-clobber publish did not install the recorded candidate',
            recoveryPaths: [transaction.destinationPath, transaction.stagePath, transactionPath],
          })
        }
        yield* syncDirectory({
          runtime,
          path: NodePath.dirname(transaction.destinationPath),
          reason: 'FirstPublish',
        })
        destination = { _tag: 'New' }
        stage = { _tag: 'Missing' }
      }
      if (destination._tag === 'New' && stage._tag === 'Missing') {
        yield* publishMetadataFromTransaction({
          workspaceRoot: request.workspaceRoot,
          transaction,
          runtime,
        })
        yield* removeTransaction({ path: transactionPath, runtime })
        return {
          _tag: 'Recovered' as const,
          action: 'RolledForward' as const,
          destinationPath: transaction.destinationPath,
        }
      }
    } else {
      if (destination._tag === 'Old' && stage._tag === 'Missing') {
        yield* removeTransaction({ path: transactionPath, runtime })
        return {
          _tag: 'Recovered' as const,
          action: 'RolledBack' as const,
          destinationPath: transaction.destinationPath,
        }
      }
      if (destination._tag === 'Old' && stage._tag === 'NewPartial') {
        return yield* rollbackCandidate
      }
      if (destination._tag === 'Old' && stage._tag === 'New') {
        yield* ensureExchangeAllowed({
          platform: runtime.platform ?? process.platform,
          allowVerifiedDarwinAdvance: request.allowVerifiedDarwinAdvance,
          destinationPath: transaction.destinationPath,
        })
        const candidateIdentity = transaction.newIdentity.candidateIdentity
        const recoveryPaths = [transaction.destinationPath, transaction.stagePath, transactionPath]
        yield* withDarwinMovableProtectedRoots({
          platform,
          roots: [
            ...(candidateIdentity === null
              ? []
              : [{ path: transaction.stagePath, identity: candidateIdentity }]),
            ...(transaction.oldIdentity._tag === 'Owned'
              ? [
                  {
                    path: transaction.destinationPath,
                    identity: transaction.oldIdentity.identity,
                  },
                ]
              : []),
          ],
          recoveryPaths,
          effect: runCommand({
            binary: runtime.mvPath,
            args: [
              '-T',
              '--exchange',
              '--no-copy',
              transaction.stagePath,
              transaction.destinationPath,
            ],
            path: transaction.destinationPath,
            commandName: 'GNU mv recovery exchange',
            recoveryPaths,
          }),
        })
        yield* syncDirectory({
          runtime,
          path: NodePath.dirname(transaction.destinationPath),
          reason: 'Exchange',
        })
        destination = yield* observeTransactionPath({
          path: transaction.destinationPath,
          transaction,
        })
        stage = yield* observeTransactionPath({ path: transaction.stagePath, transaction })
      }
      if (
        destination._tag === 'New' &&
        (stage._tag === 'Old' || stage._tag === 'OldPartial' || stage._tag === 'Missing')
      ) {
        yield* publishMetadataFromTransaction({
          workspaceRoot: request.workspaceRoot,
          transaction,
          runtime,
        })
        if (stage._tag !== 'Missing') {
          const oldIdentity = transaction.oldIdentity
          if (oldIdentity._tag === 'Missing') {
            return yield* error({
              reason: 'AmbiguousRecovery',
              path: transaction.stagePath,
              message: `Exchange transaction unexpectedly lacks an old identity`,
              recoveryPaths: [transaction.destinationPath, transaction.stagePath, transactionPath],
            })
          }
          yield* deleteOldAtStage({
            stagePath: transaction.stagePath,
            oldIdentity,
            allowPartial: stage._tag === 'OldPartial',
          })
          yield* syncDirectory({
            runtime,
            path: NodePath.dirname(transaction.stagePath),
            reason: 'OldCleanup',
          })
        }
        yield* removeTransaction({ path: transactionPath, runtime })
        return {
          _tag: 'Recovered' as const,
          action: 'RolledForward' as const,
          destinationPath: transaction.destinationPath,
        }
      }
    }

    return yield* error({
      reason: 'AmbiguousRecovery',
      path: transactionPath,
      message: `Observed mount and stage identities are ambiguous; preserving both paths`,
      recoveryPaths: [transaction.destinationPath, transaction.stagePath, transactionPath],
      cause: { destination: destination._tag, stage: stage._tag },
    })
  }).pipe(
    Observability.withLabelSpan({
      name: 'megarepo/member-mount/cp-a/recover',
      labelValue: 'cp-a-recover',
    }),
  )

/** Explicitly remove a currently verified owned mount. Symlinks and foreign directories are refused. */
export const teardownCpAMemberMount = ({
  request: untrustedRequest,
  runtime = {},
}: {
  request: CpAMemberMountTeardownRequest
  runtime?: CpAMemberMountDurabilityRuntime
}): Effect.Effect<CpAMemberMountResult, CpAMemberMountError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const request = yield* decodeTeardownRequest(untrustedRequest).pipe(
      mapRequestError('teardown request'),
    )
    const destinationPath = cpAMemberMountDestinationPath(request)
    const transactionPath = cpAMemberMountTransactionPath(request)
    if ((yield* transactionExists(transactionPath)) === true) {
      return yield* error({
        reason: 'TransactionCollision',
        path: transactionPath,
        message: `Cannot teardown '${request.member}' while a lifecycle transaction exists`,
        recoveryPaths: [transactionPath, destinationPath],
      })
    }
    const oldIdentity = yield* classifyDestination({
      workspaceRoot: request.workspaceRoot,
      member: request.member,
      destinationPath,
    })
    if (oldIdentity._tag !== 'Owned') {
      return yield* error({
        reason: 'DestinationRefused',
        path: destinationPath,
        message: `Explicit cp-a teardown requires a verified owned mount at '${destinationPath}'`,
        recoveryPaths: [destinationPath],
      })
    }
    if (request.dryRun === true) {
      return {
        _tag: 'DryRun' as const,
        plan: {
          _tag: 'TeardownPlan' as const,
          member: request.member,
          destinationPath,
          metadata: oldIdentity.metadata,
          steps: [
            'ValidateOwnership',
            'UnprotectDirectories',
            'DeleteMount',
            'DeleteMetadata',
          ] as const,
        },
      }
    }
    yield* assertStoredOwnedTree({ path: destinationPath, expected: oldIdentity })
    yield* teardownBoundDirectory({ path: destinationPath, identity: oldIdentity.identity })
    yield* syncDirectory({
      runtime,
      path: NodePath.dirname(destinationPath),
      reason: 'MountTeardown',
    })
    const metadataPath = ownedCpAMountMetadataPath({
      workspaceRoot: request.workspaceRoot,
      member: request.member,
    })
    yield* io({
      path: metadataPath,
      message: `Cannot remove owned cp-a metadata '${metadataPath}'`,
      try: async () => {
        await unlink(metadataPath)
      },
    })
    yield* syncDirectory({
      runtime,
      path: NodePath.dirname(metadataPath),
      reason: 'MetadataRemove',
    })
    return { _tag: 'TornDown' as const, destinationPath }
  }).pipe(
    Observability.withLabelSpan({
      name: 'megarepo/member-mount/cp-a/teardown',
      labelValue: 'cp-a-teardown',
    }),
  )
