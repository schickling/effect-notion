/* eslint-disable no-await-in-loop -- Locking, rollback, fsync, and authority order are protocol requirements. */

import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rmdir,
  unlink,
  type FileHandle,
} from 'node:fs/promises'
import * as NodePath from 'node:path'

import { Effect, Schema } from 'effect'

import type { AbsoluteDirPath, CompositionGeneratorConfig } from '../../core/config.ts'
import {
  BUCK_MEMBER_MANIFEST_FILENAME,
  COMPOSITION_GENERATION_MANIFEST_PATH,
  COMPOSITION_ROOT_SCHEMA_VERSION,
  CompositionGenerationManifestSchema,
  GeneratedCompositionFileSchema,
  buckMemberRemoteCacheSections,
  decodeBuckMemberManifestJson,
  generateCompositionRoot,
  type BuckCacheSection,
  type BuckMemberManifest,
  type CompositionGenerationManifest,
  type GeneratedCompositionFile,
} from './composition-root.ts'

const strictParseOptions = { errors: 'all', onExcessProperty: 'error' } as const
const LOCK_PATH = '.megarepo/composition-publisher.lock.json' as const
const TRANSACTION_PATH = '.megarepo/composition-publication.json' as const
const COMMITTED_TRANSACTION_PATH = '.megarepo/composition-publication.committed.json' as const
const TRANSACTION_ROOT = '.megarepo/composition-publication' as const
const OWNED_DIRECTORIES = ['.megarepo/bin', '.megarepo'] as const
const OBSOLETE_GENERATED_DIRECTORIES: Readonly<Record<string, true>> = {
  none: true,
  toolchains: true,
}
const memberKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const lockTokenPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u

const LockOwner = Schema.String.check(
  Schema.makeFilter<string>((value) =>
    value.length > 0 && /^[\x20-\x7e]+$/u.test(value) === true
      ? undefined
      : 'Expected a non-empty printable lock owner',
  ),
)
const LockToken = Schema.String.check(Schema.isPattern(lockTokenPattern))
const Sha256 = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/u))
const FilesystemIdentity = Schema.String.check(Schema.isPattern(/^[0-9]+$/u))

/** Durable exclusive publisher lock identity. Recovery requires the exact recorded token. */
export const CompositionPublisherLockSchema = Schema.Struct({
  schemaVersion: Schema.Literal(COMPOSITION_ROOT_SCHEMA_VERSION),
  owner: LockOwner,
  token: LockToken,
}).annotate({ identifier: 'Megarepo.CompositionPublisherLock' })
export type CompositionPublisherLock = typeof CompositionPublisherLockSchema.Type

const PreviousFileStateSchema = Schema.Union([
  Schema.TaggedStruct('Missing', {}),
  Schema.TaggedStruct('File', {
    mode: GeneratedCompositionFileSchema.fields.mode,
    sha256: Sha256,
  }),
])
type PreviousFileState = typeof PreviousFileStateSchema.Type

const TransactionFileSchema = Schema.Struct({
  path: GeneratedCompositionFileSchema.fields.path,
  mode: GeneratedCompositionFileSchema.fields.mode,
  sha256: Sha256,
  candidatePath: GeneratedCompositionFileSchema.fields.path,
  backupPath: GeneratedCompositionFileSchema.fields.path,
  previous: PreviousFileStateSchema,
})
type TransactionFile = typeof TransactionFileSchema.Type

const ObsoleteTransactionFileSchema = Schema.Struct({
  path: GeneratedCompositionFileSchema.fields.path,
  backupPath: GeneratedCompositionFileSchema.fields.path,
  parentDev: FilesystemIdentity,
  parentIno: FilesystemIdentity,
  previous: Schema.TaggedStruct('File', {
    mode: GeneratedCompositionFileSchema.fields.mode,
    sha256: Sha256,
  }),
})
type ObsoleteTransactionFile = typeof ObsoleteTransactionFileSchema.Type

/** Candidate/backup ownership manifest for one serialized publication attempt. */
export const CompositionPublicationTransactionSchema = Schema.Struct({
  schemaVersion: Schema.Literal(COMPOSITION_ROOT_SCHEMA_VERSION),
  lockOwner: LockOwner,
  lockToken: LockToken,
  phase: Schema.Literals(['AuthorityPending', 'AuthorityCommitted']),
  files: Schema.Array(TransactionFileSchema),
  obsoleteFiles: Schema.Array(ObsoleteTransactionFileSchema).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
})
  .check(
    Schema.makeFilter((transaction) => {
      let previousPath: string | undefined
      for (const file of transaction.files) {
        if (previousPath !== undefined && previousPath >= file.path) {
          return 'Transaction files must be uniquely byte-sorted by final path'
        }
        previousPath = file.path
      }
      previousPath = undefined
      for (const file of transaction.obsoleteFiles) {
        if (previousPath !== undefined && previousPath >= file.path) {
          return 'Transaction obsolete files must be uniquely byte-sorted by final path'
        }
        if (transaction.files.some((candidate) => candidate.path === file.path) === true) {
          return `Transaction path may not be both desired and obsolete: ${file.path}`
        }
        previousPath = file.path
      }
      return transaction.files.some((file) => file.path === '.buckconfig') === true
        ? undefined
        : 'Transaction must include .buckconfig authority'
    }),
  )
  .annotate({ identifier: 'Megarepo.CompositionPublicationTransaction' })
export type CompositionPublicationTransaction = typeof CompositionPublicationTransactionSchema.Type

/** Typed refusal or recoverable filesystem publication failure. */
export class CompositionRootPublicationError extends Schema.TaggedError<CompositionRootPublicationError>()(
  'CompositionRootPublicationError',
  {
    reason: Schema.Literals([
      'InvalidInput',
      'InvalidMemberManifest',
      'CapabilityPrerequisiteFailure',
      'InvalidGenerationManifest',
      'ForeignPath',
      'LockHeld',
      'RecoveryRefused',
      'IoFailure',
      'SimulatedProcessFault',
    ]),
    path: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** One member whose projected capabilities must already have passed their external check. */
export interface CompositionCapabilityProjectionInput {
  readonly workspaceRoot: AbsoluteDirPath
  readonly memberKey: string
  readonly memberRoot: string
  readonly manifest: BuckMemberManifest
  readonly owned: boolean
}

/** Explicit publisher lock identity and optional exact-token stale-lock recovery authorization. */
export interface CompositionPublisherLockOptions {
  readonly owner: string
  readonly token: string
  readonly recoverToken?: string
}

/** Publication callbacks are assertions/observers only; they may not mutate mounts. */
export interface CompositionRootPublicationRuntime {
  readonly assertCapabilityProjection: (
    input: CompositionCapabilityProjectionInput,
  ) => Promise<void>
  /** Ordinary callback failures trigger rollback. */
  readonly afterCandidateFile?: (path: string) => Promise<void>
  /** Runs immediately before the no-follow identity recheck for one destination. */
  readonly beforeInstallFile?: (path: string) => Promise<void>
  /** Observation seam after installation and parent-directory fsync. */
  readonly afterPublishedFile?: (path: string) => Promise<void>
  /** Fault seam after the callback's committed phase is durable, before forward cleanup. */
  readonly afterAuthorityCommitted?: () => Promise<void>
  /** Deterministic process-death seam: true leaves the exact-token lock and transaction durable. */
  readonly simulateProcessFaultAfterCandidate?: (path: string) => boolean
  /** Deterministic process-death seam after one final file is durable. */
  readonly simulateProcessFaultAfterPublishedFile?: (path: string) => boolean
}

/** Complete explicit inputs for composition-root publication. */
export interface PublishCompositionRootOptions {
  readonly workspaceRoot: AbsoluteDirPath
  readonly configMemberKeys: ReadonlyArray<string>
  readonly ownedMemberKey: string
  readonly compositionConfig: CompositionGeneratorConfig
  readonly resolvedBuckExecutable: string
  readonly cacheSections?: ReadonlyArray<BuckCacheSection>
  readonly lock: CompositionPublisherLockOptions
  readonly runtime: CompositionRootPublicationRuntime
  /** Runs after `.buckconfig` is durable, before the transaction is committed or cleaned. */
  readonly afterAuthorityPublished?: () => Promise<void>
}

/** Read-only composition-root planning inputs. */
export interface PlanCompositionRootPublicationOptions {
  readonly workspaceRoot: AbsoluteDirPath
  readonly configMemberKeys: ReadonlyArray<string>
  readonly ownedMemberKey: string
  readonly compositionConfig: CompositionGeneratorConfig
  readonly resolvedBuckExecutable: string
  readonly cacheSections?: ReadonlyArray<BuckCacheSection>
  readonly assertCapabilityProjection: CompositionRootPublicationRuntime['assertCapabilityProjection']
}

/** Exact content identity shown for each planned old/new file. */
export interface CompositionRootPlannedFileIdentity {
  readonly mode: 0o644 | 0o755
  readonly sha256: string
}

/** One ordered file transition; `new` is absent for owned removal and `.buckconfig` is last. */
export interface CompositionRootPlannedFile {
  readonly path: string
  readonly old: CompositionRootPlannedFileIdentity | undefined
  readonly new: CompositionRootPlannedFileIdentity | undefined
}

/** Stable refusal reasons returned as dry-run data rather than Effect failures. */
export type CompositionRootPublicationPlanRefusalReason =
  | CompositionRootPublicationError['reason']
  | 'RecoveryRequired'

/** Pure read-side publication decision. Refusals are data so dry-run callers can render them. */
export type CompositionRootPublicationPlan =
  | {
      readonly _tag: 'Create'
      readonly files: ReadonlyArray<CompositionRootPlannedFile>
      readonly configLast: true
    }
  | {
      readonly _tag: 'NoChange'
      readonly files: readonly []
      readonly configLast: true
    }
  | {
      readonly _tag: 'Update'
      readonly files: ReadonlyArray<CompositionRootPlannedFile>
      readonly configLast: true
    }
  | {
      readonly _tag: 'Refused'
      readonly reason: CompositionRootPublicationPlanRefusalReason
      readonly path: string
      readonly message: string
      readonly files: readonly []
      readonly configLast: false
    }

/** Observable result of an idempotent composition publication. */
export interface CompositionRootPublicationResult {
  readonly changedPaths: ReadonlyArray<string>
  readonly memberManifests: ReadonlyArray<{
    readonly memberKey: string
    readonly manifest: BuckMemberManifest
  }>
}

/** Explicit workspace and lock used for generated composition teardown. */
export interface TeardownCompositionRootOptions {
  readonly workspaceRoot: AbsoluteDirPath
  readonly lock: CompositionPublisherLockOptions
  readonly beforeRemoveFile?: (path: string) => Promise<void>
}

/** Generated files and now-empty owned directories removed by teardown. */
export interface CompositionRootTeardownResult {
  readonly removedPaths: ReadonlyArray<string>
  readonly removedDirectories: ReadonlyArray<string>
}

type PublicationReason = CompositionRootPublicationError['reason']
type FileSnapshot = {
  readonly dev: bigint
  readonly ino: bigint
  readonly mode: number
  readonly bytes: Uint8Array
  readonly sha256: string
}
type DirectoryIdentity = {
  readonly dev: bigint
  readonly ino: bigint
}

class SimulatedProcessFault {
  readonly _tag = 'SimulatedProcessFault'
  constructor(readonly path: string) {}
}

const failure = ({
  reason,
  path,
  message,
  cause,
}: {
  readonly reason: PublicationReason
  readonly path: string
  readonly message: string
  readonly cause?: unknown
}): CompositionRootPublicationError =>
  new CompositionRootPublicationError({ reason, path, message, cause })

const normalizeFailure = ({
  cause,
  path,
  message,
  reason = 'IoFailure',
}: {
  readonly cause: unknown
  readonly path: string
  readonly message: string
  readonly reason?: PublicationReason
}): CompositionRootPublicationError =>
  cause instanceof CompositionRootPublicationError
    ? cause
    : cause instanceof SimulatedProcessFault
      ? failure({
          reason: 'SimulatedProcessFault',
          path: cause.path,
          message: `Simulated process fault after durable candidate: ${cause.path}`,
        })
      : failure({ reason, path, message, cause })

const isErrno = (...[cause, code]: readonly [unknown, string]): boolean =>
  typeof cause === 'object' &&
  cause !== null &&
  'code' in cause &&
  (cause as { readonly code?: unknown }).code === code

const sha256 = (bytes: Uint8Array): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`

const finalPathFor = (...[workspaceRoot, relativePath]: readonly [string, string]): string =>
  NodePath.join(workspaceRoot, ...relativePath.split('/'))

const syncDirectory = async (path: string): Promise<void> => {
  let handle: FileHandle | undefined
  try {
    handle = await open(path, constants.O_RDONLY)
    await handle.sync()
  } finally {
    await handle?.close()
  }
}

const lstatMaybe = async (path: string) => {
  try {
    return await lstat(path)
  } catch (cause) {
    if (isErrno(cause, 'ENOENT') === true) return undefined
    throw cause
  }
}

const containedDirectoryIdentity = async ({
  workspaceRoot,
  relativeDirectory,
}: {
  readonly workspaceRoot: string
  readonly relativeDirectory: string
}): Promise<DirectoryIdentity> => {
  const components = relativeDirectory === '.' ? [] : relativeDirectory.split('/')
  let path = workspaceRoot
  let identity: DirectoryIdentity | undefined
  for (const component of ['', ...components]) {
    if (component !== '') path = NodePath.join(path, component)
    let info
    try {
      info = await lstat(path, { bigint: true })
    } catch (cause) {
      throw normalizeFailure({
        cause,
        path,
        reason: 'ForeignPath',
        message: `Obsolete generated parent is unavailable: ${path}`,
      })
    }
    if (info.isDirectory() === false) {
      throw failure({
        reason: 'ForeignPath',
        path,
        message: `Obsolete generated parent is not a real directory: ${path}`,
      })
    }
    identity = { dev: info.dev, ino: info.ino }
  }
  return identity!
}

const assertObsoleteParentIdentity = async ({
  workspaceRoot,
  file,
}: {
  readonly workspaceRoot: string
  readonly file: ObsoleteTransactionFile
}): Promise<void> => {
  const relativeDirectory = NodePath.posix.dirname(file.path)
  const identity = await containedDirectoryIdentity({ workspaceRoot, relativeDirectory })
  if (identity.dev.toString() !== file.parentDev || identity.ino.toString() !== file.parentIno) {
    const path = finalPathFor(workspaceRoot, relativeDirectory)
    throw failure({
      reason: 'ForeignPath',
      path,
      message: `Obsolete generated parent identity changed: ${path}`,
    })
  }
}

const snapshotMaybe = async (path: string): Promise<FileSnapshot | undefined> => {
  let handle: FileHandle | undefined
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (cause) {
    if (isErrno(cause, 'ENOENT') === true) return undefined
    if (isErrno(cause, 'ELOOP') === true) {
      throw failure({
        reason: 'ForeignPath',
        path,
        message: `Refusing symlink path: ${path}`,
        cause,
      })
    }
    throw cause
  }
  try {
    const info = await handle.stat({ bigint: true })
    if (info.isFile() === false) {
      throw failure({
        reason: 'ForeignPath',
        path,
        message: `Refusing non-regular composition-owned path: ${path}`,
      })
    }
    const bytes = await handle.readFile()
    return {
      dev: info.dev,
      ino: info.ino,
      mode: Number(info.mode & 0o777n),
      bytes,
      sha256: sha256(bytes),
    }
  } finally {
    await handle.close()
  }
}

const bytesEqual = (...[left, right]: readonly [Uint8Array, Uint8Array]): boolean =>
  left.byteLength === right.byteLength && Buffer.from(left).equals(Buffer.from(right))

const snapshotMatchesFile = (
  ...[snapshot, file]: readonly [FileSnapshot, GeneratedCompositionFile]
): boolean => snapshot.mode === file.mode && bytesEqual(snapshot.bytes, file.bytes)

const snapshotMatchesTransaction = (
  ...[snapshot, file]: readonly [FileSnapshot, TransactionFile]
): boolean => snapshot.mode === file.mode && snapshot.sha256 === file.sha256

const snapshotMatchesPrevious = (
  ...[snapshot, previous]: readonly [FileSnapshot, PreviousFileState]
): boolean =>
  previous._tag === 'File' && snapshot.mode === previous.mode && snapshot.sha256 === previous.sha256

const sameIdentity = (...[left, right]: readonly [FileSnapshot, FileSnapshot]): boolean =>
  left.dev === right.dev && left.ino === right.ino

const assertIdentity = async ({
  path,
  expected,
}: {
  readonly path: string
  readonly expected: FileSnapshot | undefined
}): Promise<void> => {
  const actual = await snapshotMaybe(path)
  if (expected === undefined) {
    if (actual !== undefined) {
      throw failure({
        reason: 'ForeignPath',
        path,
        message: `Expected composition destination to remain missing: ${path}`,
      })
    }
    return
  }
  if (
    actual === undefined ||
    sameIdentity(actual, expected) === false ||
    actual.mode !== expected.mode ||
    actual.sha256 !== expected.sha256
  ) {
    throw failure({
      reason: 'ForeignPath',
      path,
      message: `Composition path identity, bytes, or mode changed at mutation boundary: ${path}`,
    })
  }
}

const ensureDirectory = async (
  ...[workspaceRoot, relativePath]: readonly [string, string]
): Promise<void> => {
  let current = workspaceRoot
  for (const segment of relativePath.split('/')) {
    const parent = current
    current = NodePath.join(current, segment)
    const info = await lstatMaybe(current)
    if (info === undefined) {
      await mkdir(current)
      await syncDirectory(parent)
    } else if (info.isDirectory() === false) {
      throw failure({
        reason: 'ForeignPath',
        path: current,
        message: `Refusing non-directory composition-owned path component: ${current}`,
      })
    }
  }
}

const validateWorkspaceRoot = async (workspaceRoot: string): Promise<void> => {
  if (NodePath.isAbsolute(workspaceRoot) === false) {
    throw failure({
      reason: 'InvalidInput',
      path: workspaceRoot,
      message: 'Composition workspace root must be absolute',
    })
  }
  const info = await lstatMaybe(workspaceRoot)
  if (info === undefined || info.isDirectory() === false) {
    throw failure({
      reason: 'InvalidInput',
      path: workspaceRoot,
      message: 'Composition workspace root must be an existing directory',
    })
  }
}

const decodeJson = <T>({
  schema,
  bytes,
  path,
  reason,
}: {
  readonly schema: Schema.Codec<T, unknown>
  readonly bytes: Uint8Array
  readonly path: string
  readonly reason: PublicationReason
}): T => {
  try {
    return Schema.decodeSync(
      Schema.fromJsonString(schema),
      strictParseOptions,
    )(Buffer.from(bytes).toString('utf8'))
  } catch (cause) {
    throw failure({ reason, path, message: `Invalid strict JSON record: ${path}`, cause })
  }
}

const encodeJson = <T, E>(...[schema, value]: readonly [Schema.Codec<T, E>, T]): Uint8Array =>
  Buffer.from(`${Schema.encodeSync(Schema.fromJsonString(schema))(value)}\n`)

const writeExclusive = async ({
  path,
  bytes,
  mode = 0o644,
}: {
  readonly path: string
  readonly bytes: Uint8Array
  readonly mode?: 0o644 | 0o755
}): Promise<FileSnapshot> => {
  let handle: FileHandle | undefined
  try {
    handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode)
    await handle.chmod(mode)
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle?.close()
  }
  await syncDirectory(NodePath.dirname(path))
  const snapshot = await snapshotMaybe(path)
  if (snapshot === undefined) {
    throw failure({ reason: 'IoFailure', path, message: `Exclusive file disappeared: ${path}` })
  }
  return snapshot
}

const removeExact = async ({
  path,
  expected,
}: {
  readonly path: string
  readonly expected: FileSnapshot
}): Promise<void> => {
  await assertIdentity({ path, expected })
  await unlink(path)
  await syncDirectory(NodePath.dirname(path))
}

const atomicWrite = async ({
  path,
  candidatePath,
  bytes,
}: {
  readonly path: string
  readonly candidatePath: string
  readonly bytes: Uint8Array
}): Promise<FileSnapshot> => {
  const existingCandidate = await snapshotMaybe(candidatePath)
  if (existingCandidate !== undefined) {
    if (existingCandidate.mode !== 0o644 || bytesEqual(existingCandidate.bytes, bytes) === false) {
      throw failure({
        reason: 'ForeignPath',
        path: candidatePath,
        message: `Refusing foreign atomic-write candidate: ${candidatePath}`,
      })
    }
  } else {
    await writeExclusive({ path: candidatePath, bytes })
  }
  if ((await snapshotMaybe(path)) !== undefined) {
    throw failure({
      reason: 'ForeignPath',
      path,
      message: `Atomic record path is occupied: ${path}`,
    })
  }
  try {
    await link(candidatePath, path)
  } catch (cause) {
    if (isErrno(cause, 'EEXIST') === true) {
      throw failure({
        reason: 'ForeignPath',
        path,
        message: `Atomic record path raced publication and was preserved: ${path}`,
        cause,
      })
    }
    throw cause
  }
  await syncDirectory(NodePath.dirname(path))
  await removeExact({
    path: candidatePath,
    expected: existingCandidate ?? (await snapshotMaybe(path))!,
  })
  const snapshot = await snapshotMaybe(path)
  if (snapshot === undefined) {
    throw failure({ reason: 'IoFailure', path, message: `Atomic record disappeared: ${path}` })
  }
  return snapshot
}

const transactionRecordCandidatePath = ({ token }: { readonly token: string }): string =>
  `.megarepo/.composition-publication.${token}.candidate`

const transactionFilename = (path: string): string => Buffer.from(path, 'utf8').toString('hex')
const transactionPaths = ({
  token,
  path,
}: {
  readonly token: string
  readonly path: string
}): { readonly candidatePath: string; readonly backupPath: string } => {
  const filename = transactionFilename(path)
  const root = `${TRANSACTION_ROOT}/${token}`
  return {
    candidatePath: `${root}/candidates/${filename}`,
    backupPath: `${root}/backups/${filename}`,
  }
}

const validateTransactionShape = ({
  transaction,
  workspaceRoot,
}: {
  readonly transaction: CompositionPublicationTransaction
  readonly workspaceRoot: string
}): void => {
  for (const file of transaction.files) {
    const expected = transactionPaths({ token: transaction.lockToken, path: file.path })
    if (file.candidatePath !== expected.candidatePath || file.backupPath !== expected.backupPath) {
      throw failure({
        reason: 'RecoveryRefused',
        path: finalPathFor(workspaceRoot, TRANSACTION_PATH),
        message: `Transaction path ownership disagrees for ${file.path}`,
      })
    }
  }
  for (const file of transaction.obsoleteFiles) {
    const expected = transactionPaths({ token: transaction.lockToken, path: file.path })
    if (file.backupPath !== expected.backupPath) {
      throw failure({
        reason: 'RecoveryRefused',
        path: finalPathFor(workspaceRoot, TRANSACTION_PATH),
        message: `Obsolete transaction path ownership disagrees for ${file.path}`,
      })
    }
  }
}

interface PublicationTransactionRecord {
  readonly transaction: CompositionPublicationTransaction
  readonly snapshot: FileSnapshot
}

const readTransactionRecordMaybe = async ({
  workspaceRoot,
  relativePath,
  phase,
}: {
  readonly workspaceRoot: string
  readonly relativePath: string
  readonly phase: CompositionPublicationTransaction['phase']
}): Promise<PublicationTransactionRecord | undefined> => {
  const path = finalPathFor(workspaceRoot, relativePath)
  const snapshot = await snapshotMaybe(path)
  if (snapshot === undefined) return undefined
  if (snapshot.mode !== 0o644) {
    throw failure({
      reason: 'RecoveryRefused',
      path,
      message: `Transaction manifest mode is not publisher-owned: ${path}`,
    })
  }
  const transaction = decodeJson({
    schema: CompositionPublicationTransactionSchema,
    bytes: snapshot.bytes,
    path,
    reason: 'RecoveryRefused',
  })
  validateTransactionShape({ transaction, workspaceRoot })
  if (transaction.phase !== phase) {
    throw failure({
      reason: 'RecoveryRefused',
      path,
      message: `Transaction manifest has unexpected phase ${transaction.phase}: ${path}`,
    })
  }
  return { transaction, snapshot }
}

const readTransactionMaybe = (workspaceRoot: string) =>
  readTransactionRecordMaybe({
    workspaceRoot,
    relativePath: TRANSACTION_PATH,
    phase: 'AuthorityPending',
  })

const readCommittedTransactionMaybe = (workspaceRoot: string) =>
  readTransactionRecordMaybe({
    workspaceRoot,
    relativePath: COMMITTED_TRANSACTION_PATH,
    phase: 'AuthorityCommitted',
  })

const readLock = async (
  workspaceRoot: string,
): Promise<
  { readonly lock: CompositionPublisherLock; readonly snapshot: FileSnapshot } | undefined
> => {
  const path = finalPathFor(workspaceRoot, LOCK_PATH)
  const snapshot = await snapshotMaybe(path)
  if (snapshot === undefined) return undefined
  if (snapshot.mode !== 0o644) {
    throw failure({
      reason: 'RecoveryRefused',
      path,
      message: `Publisher lock mode is not owned: ${path}`,
    })
  }
  return {
    lock: decodeJson({
      schema: CompositionPublisherLockSchema,
      bytes: snapshot.bytes,
      path,
      reason: 'RecoveryRefused',
    }),
    snapshot,
  }
}

const cleanupEmptyTransactionDirectories = async ({
  workspaceRoot,
  token,
}: {
  readonly workspaceRoot: string
  readonly token: string
}): Promise<void> => {
  for (const relativePath of [
    `${TRANSACTION_ROOT}/${token}/candidates`,
    `${TRANSACTION_ROOT}/${token}/backups`,
    `${TRANSACTION_ROOT}/${token}`,
    TRANSACTION_ROOT,
  ]) {
    const path = finalPathFor(workspaceRoot, relativePath)
    try {
      await rmdir(path)
      await syncDirectory(NodePath.dirname(path))
    } catch (cause) {
      if (
        isErrno(cause, 'ENOENT') === false &&
        isErrno(cause, 'ENOTEMPTY') === false &&
        isErrno(cause, 'EEXIST') === false
      ) {
        throw cause
      }
    }
  }
}

const verifyOwnedArtifact = async ({
  workspaceRoot,
  relativePath,
  file,
  previous = false,
}: {
  readonly workspaceRoot: string
  readonly relativePath: string
  readonly file: TransactionFile
  readonly previous?: boolean
}): Promise<FileSnapshot | undefined> => {
  const path = finalPathFor(workspaceRoot, relativePath)
  const snapshot = await snapshotMaybe(path)
  if (snapshot === undefined) return undefined
  const matches =
    previous === true
      ? snapshotMatchesPrevious(snapshot, file.previous)
      : snapshotMatchesTransaction(snapshot, file)
  if (matches === false) {
    throw failure({
      reason: 'ForeignPath',
      path,
      message: `Transaction artifact no longer matches its ownership manifest: ${path}`,
    })
  }
  return snapshot
}

const verifyObsoleteBackup = async ({
  workspaceRoot,
  file,
}: {
  readonly workspaceRoot: string
  readonly file: ObsoleteTransactionFile
}): Promise<FileSnapshot | undefined> => {
  const path = finalPathFor(workspaceRoot, file.backupPath)
  const snapshot = await snapshotMaybe(path)
  if (snapshot === undefined) return undefined
  if (snapshotMatchesPrevious(snapshot, file.previous) === false) {
    throw failure({
      reason: 'ForeignPath',
      path,
      message: `Obsolete backup no longer matches its ownership manifest: ${path}`,
    })
  }
  return snapshot
}

const cleanupTransactionForward = async ({
  workspaceRoot,
  transaction,
  pendingRecord,
  committedRecord,
}: {
  readonly workspaceRoot: string
  readonly transaction: CompositionPublicationTransaction
  readonly pendingRecord?: PublicationTransactionRecord
  readonly committedRecord?: PublicationTransactionRecord
}): Promise<void> => {
  for (const file of transaction.files) {
    const candidate = await verifyOwnedArtifact({
      workspaceRoot,
      relativePath: file.candidatePath,
      file,
    })
    if (candidate !== undefined) {
      await removeExact({
        path: finalPathFor(workspaceRoot, file.candidatePath),
        expected: candidate,
      })
    }
    const backup = await verifyOwnedArtifact({
      workspaceRoot,
      relativePath: file.backupPath,
      file,
      previous: true,
    })
    if (backup !== undefined) {
      await removeExact({ path: finalPathFor(workspaceRoot, file.backupPath), expected: backup })
    }
  }
  for (const file of transaction.obsoleteFiles) {
    const backup = await verifyObsoleteBackup({ workspaceRoot, file })
    if (backup !== undefined) {
      await removeExact({ path: finalPathFor(workspaceRoot, file.backupPath), expected: backup })
    }
  }
  const obsoleteDirectories = [
    ...new Set(
      transaction.obsoleteFiles
        .map((file) => NodePath.posix.dirname(file.path))
        .filter((path) => OBSOLETE_GENERATED_DIRECTORIES[path] === true),
    ),
  ].toSorted()
  for (const relativePath of obsoleteDirectories) {
    const path = finalPathFor(workspaceRoot, relativePath)
    if ((await lstatMaybe(path)) === undefined) continue
    const owner = transaction.obsoleteFiles.find(
      (file) => NodePath.posix.dirname(file.path) === relativePath,
    )!
    await assertObsoleteParentIdentity({ workspaceRoot, file: owner })
    try {
      await rmdir(path)
      await syncDirectory(NodePath.dirname(path))
    } catch (cause) {
      if (isErrno(cause, 'ENOENT') === true) continue
      throw failure({
        reason: 'ForeignPath',
        path,
        message: `Obsolete generated directory is no longer empty: ${path}`,
        cause,
      })
    }
  }
  if (pendingRecord !== undefined) {
    await removeExact({
      path: finalPathFor(workspaceRoot, TRANSACTION_PATH),
      expected: pendingRecord.snapshot,
    })
  }
  // The committed marker remains durable until every rollback artifact and pending record is gone.
  if (committedRecord !== undefined) {
    await removeExact({
      path: finalPathFor(workspaceRoot, COMMITTED_TRANSACTION_PATH),
      expected: committedRecord.snapshot,
    })
  }
  await cleanupEmptyTransactionDirectories({
    workspaceRoot,
    token: transaction.lockToken,
  })
}

const finalMatchesTransaction = async ({
  workspaceRoot,
  transaction,
}: {
  readonly workspaceRoot: string
  readonly transaction: CompositionPublicationTransaction
}): Promise<boolean> => {
  for (const file of transaction.files) {
    const snapshot = await snapshotMaybe(finalPathFor(workspaceRoot, file.path))
    if (snapshot === undefined || snapshotMatchesTransaction(snapshot, file) === false) return false
  }
  const manifestPath = finalPathFor(workspaceRoot, COMPOSITION_GENERATION_MANIFEST_PATH)
  for (const file of transaction.obsoleteFiles) {
    const parentPath = finalPathFor(workspaceRoot, NodePath.posix.dirname(file.path))
    if ((await lstatMaybe(parentPath)) === undefined) continue
    await assertObsoleteParentIdentity({ workspaceRoot, file })
    if ((await snapshotMaybe(finalPathFor(workspaceRoot, file.path))) !== undefined) return false
  }
  const manifestSnapshot = await snapshotMaybe(manifestPath)
  if (manifestSnapshot === undefined || manifestSnapshot.mode !== 0o644) return false
  let manifest: CompositionGenerationManifest
  try {
    manifest = decodeGenerationManifest({ snapshot: manifestSnapshot, path: manifestPath })
  } catch {
    return false
  }
  for (const record of manifest.files) {
    const snapshot = await snapshotMaybe(finalPathFor(workspaceRoot, record.path))
    if (
      snapshot === undefined ||
      snapshot.mode !== record.mode ||
      snapshot.sha256 !== record.sha256
    ) {
      return false
    }
  }
  return true
}

const restoreTransactionFile = async ({
  workspaceRoot,
  file,
}: {
  readonly workspaceRoot: string
  readonly file: TransactionFile
}): Promise<void> => {
  const finalPath = finalPathFor(workspaceRoot, file.path)
  const live = await snapshotMaybe(finalPath)
  const backup = await verifyOwnedArtifact({
    workspaceRoot,
    relativePath: file.backupPath,
    file,
    previous: true,
  })
  if (file.previous._tag === 'Missing') {
    if (backup !== undefined) {
      throw failure({
        reason: 'RecoveryRefused',
        path: finalPathFor(workspaceRoot, file.backupPath),
        message: `Unexpected backup for previously missing path ${file.path}`,
      })
    }
    if (live !== undefined) {
      if (snapshotMatchesTransaction(live, file) === false) {
        throw failure({
          reason: 'ForeignPath',
          path: finalPath,
          message: `Refusing foreign live path during rollback: ${finalPath}`,
        })
      }
      await removeExact({ path: finalPath, expected: live })
    }
    return
  }
  if (backup === undefined) {
    if (live === undefined || snapshotMatchesPrevious(live, file.previous) === false) {
      throw failure({
        reason: 'RecoveryRefused',
        path: finalPath,
        message: `Previous file and owned backup are both unavailable: ${finalPath}`,
      })
    }
    return
  }
  if (live !== undefined) {
    if (snapshotMatchesTransaction(live, file) === false) {
      throw failure({
        reason: 'ForeignPath',
        path: finalPath,
        message: `Refusing foreign live path during rollback: ${finalPath}`,
      })
    }
    await removeExact({ path: finalPath, expected: live })
  }
  await rename(finalPathFor(workspaceRoot, file.backupPath), finalPath)
  await syncDirectory(NodePath.dirname(finalPath))
  const restored = await snapshotMaybe(finalPath)
  if (restored === undefined || snapshotMatchesPrevious(restored, file.previous) === false) {
    throw failure({
      reason: 'RecoveryRefused',
      path: finalPath,
      message: `Restored backup failed ownership validation: ${finalPath}`,
    })
  }
}

const restoreObsoleteTransactionFile = async ({
  workspaceRoot,
  file,
}: {
  readonly workspaceRoot: string
  readonly file: ObsoleteTransactionFile
}): Promise<void> => {
  await assertObsoleteParentIdentity({ workspaceRoot, file })
  const finalPath = finalPathFor(workspaceRoot, file.path)
  const live = await snapshotMaybe(finalPath)
  const backup = await verifyObsoleteBackup({ workspaceRoot, file })
  if (backup === undefined) {
    if (live === undefined || snapshotMatchesPrevious(live, file.previous) === false) {
      throw failure({
        reason: 'RecoveryRefused',
        path: finalPath,
        message: `Obsolete file and owned backup are both unavailable: ${finalPath}`,
      })
    }
    return
  }
  if (live !== undefined) {
    throw failure({
      reason: 'ForeignPath',
      path: finalPath,
      message: `Refusing recreated obsolete path during rollback: ${finalPath}`,
    })
  }
  await assertObsoleteParentIdentity({ workspaceRoot, file })
  await rename(finalPathFor(workspaceRoot, file.backupPath), finalPath)
  await syncDirectory(NodePath.dirname(finalPath))
  const restored = await snapshotMaybe(finalPath)
  if (restored === undefined || snapshotMatchesPrevious(restored, file.previous) === false) {
    throw failure({
      reason: 'RecoveryRefused',
      path: finalPath,
      message: `Restored obsolete backup failed ownership validation: ${finalPath}`,
    })
  }
}

const rollbackTransaction = async ({
  workspaceRoot,
  transactionRecord,
}: {
  readonly workspaceRoot: string
  readonly transactionRecord: {
    readonly transaction: CompositionPublicationTransaction
    readonly snapshot: FileSnapshot
  }
}): Promise<void> => {
  const config = transactionRecord.transaction.files.find((file) => file.path === '.buckconfig')!
  const nonConfig = transactionRecord.transaction.files.filter(
    (file) => file.path !== '.buckconfig',
  )
  for (const file of transactionRecord.transaction.obsoleteFiles.toReversed()) {
    await restoreObsoleteTransactionFile({ workspaceRoot, file })
  }
  for (const file of nonConfig.toReversed()) await restoreTransactionFile({ workspaceRoot, file })
  // Authority is restored only after every non-config path is back in its previous state.
  await restoreTransactionFile({ workspaceRoot, file: config })
  for (const file of transactionRecord.transaction.files) {
    const candidate = await verifyOwnedArtifact({
      workspaceRoot,
      relativePath: file.candidatePath,
      file,
    })
    if (candidate !== undefined) {
      await removeExact({
        path: finalPathFor(workspaceRoot, file.candidatePath),
        expected: candidate,
      })
    }
  }
  const currentRecord = await readTransactionMaybe(workspaceRoot)
  if (currentRecord === undefined) {
    throw failure({
      reason: 'RecoveryRefused',
      path: finalPathFor(workspaceRoot, TRANSACTION_PATH),
      message: 'Transaction manifest disappeared during rollback',
    })
  }
  await removeExact({
    path: finalPathFor(workspaceRoot, TRANSACTION_PATH),
    expected: currentRecord.snapshot,
  })
  await cleanupEmptyTransactionDirectories({
    workspaceRoot,
    token: transactionRecord.transaction.lockToken,
  })
}

const assertTransactionLockIdentity = ({
  transaction,
  lock,
  path,
}: {
  readonly transaction: CompositionPublicationTransaction
  readonly lock: CompositionPublisherLock
  readonly path: string
}): void => {
  if (transaction.lockToken !== lock.token || transaction.lockOwner !== lock.owner) {
    throw failure({
      reason: 'RecoveryRefused',
      path,
      message: 'Transaction identity does not match the exact stale lock identity',
    })
  }
}

const recoverTransaction = async ({
  workspaceRoot,
  lock,
}: {
  readonly workspaceRoot: string
  readonly lock: CompositionPublisherLock
}): Promise<void> => {
  const [record, committedRecord] = await Promise.all([
    readTransactionMaybe(workspaceRoot),
    readCommittedTransactionMaybe(workspaceRoot),
  ])
  if (committedRecord !== undefined) {
    assertTransactionLockIdentity({
      transaction: committedRecord.transaction,
      lock,
      path: finalPathFor(workspaceRoot, COMMITTED_TRANSACTION_PATH),
    })
    if (record !== undefined) {
      assertTransactionLockIdentity({
        transaction: record.transaction,
        lock,
        path: finalPathFor(workspaceRoot, TRANSACTION_PATH),
      })
      const expectedCommitted = encodeJson(CompositionPublicationTransactionSchema, {
        ...record.transaction,
        phase: 'AuthorityCommitted',
      })
      if (bytesEqual(committedRecord.snapshot.bytes, expectedCommitted) === false) {
        throw failure({
          reason: 'RecoveryRefused',
          path: finalPathFor(workspaceRoot, COMMITTED_TRANSACTION_PATH),
          message: 'Committed publication phase disagrees with its pending transaction',
        })
      }
    }
    if (
      (await finalMatchesTransaction({
        workspaceRoot,
        transaction: committedRecord.transaction,
      })) === false
    ) {
      throw failure({
        reason: 'RecoveryRefused',
        path: finalPathFor(workspaceRoot, COMMITTED_TRANSACTION_PATH),
        message: 'Committed publication authority no longer matches its durable transaction',
      })
    }
    await cleanupTransactionForward({
      workspaceRoot,
      transaction: committedRecord.transaction,
      ...(record === undefined ? {} : { pendingRecord: record }),
      committedRecord,
    })
    return
  }
  if (record === undefined) {
    const candidateRelativePath = transactionRecordCandidatePath({ token: lock.token })
    const candidatePath = finalPathFor(workspaceRoot, candidateRelativePath)
    const candidate = await snapshotMaybe(candidatePath)
    if (candidate !== undefined) {
      const candidateTransaction = decodeJson({
        schema: CompositionPublicationTransactionSchema,
        bytes: candidate.bytes,
        path: candidatePath,
        reason: 'RecoveryRefused',
      })
      validateTransactionShape({ transaction: candidateTransaction, workspaceRoot })
      if (candidateTransaction.phase !== 'AuthorityPending') {
        throw failure({
          reason: 'RecoveryRefused',
          path: candidatePath,
          message: 'Transaction-record candidate has an impossible committed phase',
        })
      }
      assertTransactionLockIdentity({
        transaction: candidateTransaction,
        lock,
        path: candidatePath,
      })
      await removeExact({ path: candidatePath, expected: candidate })
    }
    await cleanupEmptyTransactionDirectories({ workspaceRoot, token: lock.token })
    return
  }
  assertTransactionLockIdentity({
    transaction: record.transaction,
    lock,
    path: finalPathFor(workspaceRoot, TRANSACTION_PATH),
  })
  // Without a committed phase, recovery cannot assume the external callback completed.
  await rollbackTransaction({ workspaceRoot, transactionRecord: record })
}

const acquireLock = async ({
  workspaceRoot,
  options,
}: {
  readonly workspaceRoot: string
  readonly options: CompositionPublisherLockOptions
}): Promise<{ readonly lock: CompositionPublisherLock; readonly snapshot: FileSnapshot }> => {
  let requested: CompositionPublisherLock
  try {
    requested = Schema.decodeSync(
      CompositionPublisherLockSchema,
      strictParseOptions,
    )({
      schemaVersion: COMPOSITION_ROOT_SCHEMA_VERSION,
      owner: options.owner,
      token: options.token,
    })
  } catch (cause) {
    throw failure({
      reason: 'InvalidInput',
      path: finalPathFor(workspaceRoot, LOCK_PATH),
      message: 'Invalid composition publisher lock identity',
      cause,
    })
  }
  const existing = await readLock(workspaceRoot)
  if (existing !== undefined) {
    if (options.recoverToken !== existing.lock.token) {
      throw failure({
        reason: 'LockHeld',
        path: finalPathFor(workspaceRoot, LOCK_PATH),
        message: `Composition publisher lock is held by ${existing.lock.owner}; exact token recovery is required`,
      })
    }
    await recoverTransaction({ workspaceRoot, lock: existing.lock })
    await removeExact({ path: finalPathFor(workspaceRoot, LOCK_PATH), expected: existing.snapshot })
  } else if (
    (await readTransactionMaybe(workspaceRoot)) !== undefined ||
    (await readCommittedTransactionMaybe(workspaceRoot)) !== undefined
  ) {
    throw failure({
      reason: 'RecoveryRefused',
      path: finalPathFor(workspaceRoot, TRANSACTION_PATH),
      message: 'Publication transaction exists without its exact-token publisher lock',
    })
  }
  const path = finalPathFor(workspaceRoot, LOCK_PATH)
  const snapshot = await writeExclusive({
    path,
    bytes: encodeJson(CompositionPublisherLockSchema, requested),
  })
  return { lock: requested, snapshot }
}

const releaseLock = async ({
  workspaceRoot,
  acquired,
}: {
  readonly workspaceRoot: string
  readonly acquired: { readonly lock: CompositionPublisherLock; readonly snapshot: FileSnapshot }
}): Promise<void> => {
  const current = await readLock(workspaceRoot)
  if (
    current === undefined ||
    current.lock.owner !== acquired.lock.owner ||
    current.lock.token !== acquired.lock.token ||
    sameIdentity(current.snapshot, acquired.snapshot) === false
  ) {
    throw failure({
      reason: 'RecoveryRefused',
      path: finalPathFor(workspaceRoot, LOCK_PATH),
      message: 'Publisher lock identity changed before release',
    })
  }
  await removeExact({ path: finalPathFor(workspaceRoot, LOCK_PATH), expected: current.snapshot })
}

const expectedGeneratedPaths = (
  files: ReadonlyArray<GeneratedCompositionFile>,
): ReadonlyArray<string> =>
  files
    .filter((file) => file.path !== COMPOSITION_GENERATION_MANIFEST_PATH)
    .map((file) => file.path)
    .toSorted()

const decodeGenerationManifest = ({
  snapshot,
  path,
}: {
  readonly snapshot: FileSnapshot
  readonly path: string
}): CompositionGenerationManifest =>
  decodeJson({
    schema: CompositionGenerationManifestSchema,
    bytes: snapshot.bytes,
    path,
    reason: 'InvalidGenerationManifest',
  })

const assertManifestShape = ({
  manifest,
  expectedPaths,
  path,
}: {
  readonly manifest: CompositionGenerationManifest
  readonly expectedPaths: ReadonlyArray<string>
  readonly path: string
}): void => {
  const actual = manifest.files.map((file) => file.path)
  if (
    actual.length !== expectedPaths.length ||
    actual.some((value, index) => value !== expectedPaths[index]) === true
  ) {
    throw failure({
      reason: 'InvalidGenerationManifest',
      path,
      message: `Generation manifest does not own the canonical file set: ${path}`,
    })
  }
}

interface ObsoleteGeneratedFile {
  readonly path: string
  readonly snapshot: FileSnapshot
  readonly parentIdentity: DirectoryIdentity
}

interface PublicationValidationState {
  readonly snapshots: ReadonlyMap<string, FileSnapshot | undefined>
  readonly obsoleteFiles: ReadonlyArray<ObsoleteGeneratedFile>
}

const validateObsoleteGeneratedDirectories = async ({
  workspaceRoot,
  obsoleteFiles,
}: {
  readonly workspaceRoot: string
  readonly obsoleteFiles: ReadonlyArray<ObsoleteGeneratedFile>
}): Promise<void> => {
  const expectedByDirectory = new Map<
    string,
    { readonly entries: Set<string>; readonly identity: DirectoryIdentity }
  >()
  for (const file of obsoleteFiles) {
    const directory = NodePath.posix.dirname(file.path)
    if (OBSOLETE_GENERATED_DIRECTORIES[directory] !== true) continue
    const expected = expectedByDirectory.get(directory) ?? {
      entries: new Set<string>(),
      identity: file.parentIdentity,
    }
    if (
      expected.identity.dev !== file.parentIdentity.dev ||
      expected.identity.ino !== file.parentIdentity.ino
    ) {
      throw failure({
        reason: 'ForeignPath',
        path: finalPathFor(workspaceRoot, directory),
        message: `Obsolete generated files disagree on parent identity: ${directory}`,
      })
    }
    expected.entries.add(NodePath.posix.basename(file.path))
    expectedByDirectory.set(directory, expected)
  }
  for (const [relativeDirectory, expected] of expectedByDirectory) {
    const directory = finalPathFor(workspaceRoot, relativeDirectory)
    const before = await containedDirectoryIdentity({ workspaceRoot, relativeDirectory })
    if (before.dev !== expected.identity.dev || before.ino !== expected.identity.ino) {
      throw failure({
        reason: 'ForeignPath',
        path: directory,
        message: `Obsolete generated parent identity changed: ${directory}`,
      })
    }
    const entries = await readdir(directory, { withFileTypes: true })
    const after = await containedDirectoryIdentity({ workspaceRoot, relativeDirectory })
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      entries.length !== expected.entries.size ||
      entries.some(
        (entry) => entry.isFile() === false || expected.entries.has(entry.name) === false,
      ) === true
    ) {
      throw failure({
        reason: 'ForeignPath',
        path: directory,
        message: `Obsolete generated directory contains unowned entries: ${directory}`,
      })
    }
  }
}

const validatePublicationState = async ({
  workspaceRoot,
  files,
}: {
  readonly workspaceRoot: string
  readonly files: ReadonlyArray<GeneratedCompositionFile>
}): Promise<PublicationValidationState> => {
  const manifestPath = finalPathFor(workspaceRoot, COMPOSITION_GENERATION_MANIFEST_PATH)
  const manifestSnapshot = await snapshotMaybe(manifestPath)
  let manifest: CompositionGenerationManifest | undefined
  if (manifestSnapshot !== undefined) {
    if (manifestSnapshot.mode !== 0o644) {
      throw failure({
        reason: 'InvalidGenerationManifest',
        path: manifestPath,
        message: `Generation manifest mode is not owned: ${manifestPath}`,
      })
    }
    manifest = decodeGenerationManifest({ snapshot: manifestSnapshot, path: manifestPath })
  }
  const configPath = finalPathFor(workspaceRoot, '.buckconfig')
  if (manifest === undefined && (await snapshotMaybe(configPath)) !== undefined) {
    throw failure({
      reason: 'InvalidGenerationManifest',
      path: configPath,
      message: 'Refusing existing .buckconfig without a valid generation manifest',
    })
  }

  const desiredPaths = new Set(expectedGeneratedPaths(files))
  const manifestPaths = new Set(manifest?.files.map((file) => file.path))
  const obsoleteFiles: ObsoleteGeneratedFile[] = []
  if (manifest !== undefined) {
    for (const record of manifest.files) {
      const obsolete = desiredPaths.has(record.path) === false
      const parentIdentity =
        obsolete === true
          ? await containedDirectoryIdentity({
              workspaceRoot,
              relativeDirectory: NodePath.posix.dirname(record.path),
            })
          : undefined
      const path = finalPathFor(workspaceRoot, record.path)
      const snapshot = await snapshotMaybe(path)
      if (
        snapshot === undefined ||
        snapshot.mode !== record.mode ||
        snapshot.sha256 !== record.sha256
      ) {
        throw failure({
          reason: 'ForeignPath',
          path,
          message: `Generated file no longer matches its ownership manifest: ${path}`,
        })
      }
      if (obsolete === true)
        obsoleteFiles.push({ path: record.path, snapshot, parentIdentity: parentIdentity! })
    }
  }
  await validateObsoleteGeneratedDirectories({ workspaceRoot, obsoleteFiles })

  const snapshots = new Map<string, FileSnapshot | undefined>()
  for (const file of files) {
    const path = finalPathFor(workspaceRoot, file.path)
    const snapshot =
      file.path === COMPOSITION_GENERATION_MANIFEST_PATH
        ? manifestSnapshot
        : await snapshotMaybe(path)
    snapshots.set(file.path, snapshot)
    if (
      manifest !== undefined &&
      file.path !== COMPOSITION_GENERATION_MANIFEST_PATH &&
      manifestPaths.has(file.path) === false &&
      snapshot !== undefined
    ) {
      throw failure({
        reason: 'ForeignPath',
        path,
        message: `Refusing unowned path missing from generation manifest: ${path}`,
      })
    }
    if (
      manifest === undefined &&
      snapshot !== undefined &&
      snapshotMatchesFile(snapshot, file) === false
    ) {
      throw failure({
        reason: 'ForeignPath',
        path,
        message: `Refusing unowned first-create path: ${path}`,
      })
    }
  }
  return { snapshots, obsoleteFiles }
}

const loadMembers = async ({
  workspaceRoot,
  configMemberKeys,
  ownedMemberKey,
}: {
  readonly workspaceRoot: AbsoluteDirPath
  readonly configMemberKeys: ReadonlyArray<string>
  readonly ownedMemberKey: string
}) => {
  const memberKeys = [...configMemberKeys]
  const uniqueKeys = new Set(memberKeys)
  if (
    memberKeys.length === 0 ||
    uniqueKeys.size !== memberKeys.length ||
    memberKeys.some((key) => memberKeyPattern.test(key) === false) === true
  ) {
    throw failure({
      reason: 'InvalidInput',
      path: workspaceRoot,
      message: 'Composition member keys must be non-empty, unique canonical segments',
    })
  }
  if (uniqueKeys.has(ownedMemberKey) === false) {
    throw failure({
      reason: 'InvalidInput',
      path: workspaceRoot,
      message: `Owned member is not configured: ${ownedMemberKey}`,
    })
  }
  const members: Array<{
    readonly memberKey: string
    readonly memberRoot: string
    readonly manifest: BuckMemberManifest
  }> = []
  for (const memberKey of memberKeys) {
    const memberRoot = NodePath.join(workspaceRoot, 'repos', memberKey)
    const info = await lstatMaybe(memberRoot)
    if (info === undefined || info.isDirectory() === false) {
      throw failure({
        reason: 'InvalidMemberManifest',
        path: memberRoot,
        message: `Member root is missing or not a directory: ${memberRoot}`,
      })
    }
    for (const forbiddenRootFile of ['.buckconfig', '.buckroot']) {
      const forbiddenPath = NodePath.join(memberRoot, forbiddenRootFile)
      if ((await lstatMaybe(forbiddenPath)) !== undefined) {
        throw failure({
          reason: 'InvalidMemberManifest',
          path: forbiddenPath,
          message: `Member root must not carry ${forbiddenRootFile}: ${memberRoot}`,
        })
      }
    }
    const manifestPath = NodePath.join(memberRoot, BUCK_MEMBER_MANIFEST_FILENAME)
    try {
      members.push({
        memberKey,
        memberRoot,
        manifest: decodeBuckMemberManifestJson(await readFile(manifestPath, 'utf8')),
      })
    } catch (cause) {
      throw normalizeFailure({
        cause,
        path: manifestPath,
        reason: 'InvalidMemberManifest',
        message: `Could not strictly decode member manifest: ${manifestPath}`,
      })
    }
  }
  return members
}

type CompositionPreparationOptions = Pick<
  PlanCompositionRootPublicationOptions,
  | 'configMemberKeys'
  | 'ownedMemberKey'
  | 'compositionConfig'
  | 'resolvedBuckExecutable'
  | 'cacheSections'
>

const prepareComposition = async ({
  workspaceRoot,
  options,
}: {
  readonly workspaceRoot: AbsoluteDirPath
  readonly options: CompositionPreparationOptions
}): Promise<{
  readonly members: ReadonlyArray<{
    readonly memberKey: string
    readonly memberRoot: string
    readonly manifest: BuckMemberManifest
  }>
  readonly output: ReturnType<typeof generateCompositionRoot>
}> => {
  const members = await loadMembers({
    workspaceRoot,
    configMemberKeys: options.configMemberKeys,
    ownedMemberKey: options.ownedMemberKey,
  })
  const hub = members.find((member) => member.memberKey === options.compositionConfig.platformHub)
  if (hub === undefined) {
    throw failure({
      reason: 'InvalidInput',
      path: workspaceRoot,
      message: `Platform hub is not configured: ${options.compositionConfig.platformHub}`,
    })
  }
  try {
    return {
      members,
      output: generateCompositionRoot({
        schemaVersion: COMPOSITION_ROOT_SCHEMA_VERSION,
        members: members.map(({ memberKey, manifest }) => ({ memberKey, manifest })),
        platformHubCell: hub.manifest.cell,
        isolationDir: options.compositionConfig.isolationDir,
        cacheSections:
          options.cacheSections ??
          (hub.manifest.remoteCache === undefined
            ? []
            : buckMemberRemoteCacheSections(hub.manifest.remoteCache)),
        additionalProjectIgnores: (options.compositionConfig.ignoredMembers ?? []).map(
          (member) => `repos/${member}`,
        ),
        resolvedBuckExecutable: options.resolvedBuckExecutable,
      }),
    }
  } catch (cause) {
    throw failure({
      reason: 'InvalidInput',
      path: workspaceRoot,
      message: 'Composition member and generator inputs are inconsistent',
      cause,
    })
  }
}

const assertCompositionCapabilities = async ({
  workspaceRoot,
  ownedMemberKey,
  members,
  assertCapabilityProjection,
}: {
  readonly workspaceRoot: AbsoluteDirPath
  readonly ownedMemberKey: string
  readonly members: ReadonlyArray<{
    readonly memberKey: string
    readonly memberRoot: string
    readonly manifest: BuckMemberManifest
  }>
  readonly assertCapabilityProjection: CompositionRootPublicationRuntime['assertCapabilityProjection']
}): Promise<void> => {
  for (const member of members) {
    try {
      await assertCapabilityProjection({
        workspaceRoot,
        memberKey: member.memberKey,
        memberRoot: member.memberRoot,
        manifest: member.manifest,
        owned: member.memberKey === ownedMemberKey,
      })
    } catch (cause) {
      throw failure({
        reason: 'CapabilityPrerequisiteFailure',
        path: member.memberRoot,
        message: `Capability prerequisite failed for ${member.memberKey}`,
        cause,
      })
    }
  }
}

const makeTransaction = ({
  lock,
  output,
  state,
}: {
  readonly lock: CompositionPublisherLock
  readonly output: ReadonlyArray<GeneratedCompositionFile>
  readonly state: PublicationValidationState
}): CompositionPublicationTransaction | undefined => {
  const changed = output.filter((file) => {
    const snapshot = state.snapshots.get(file.path)
    return snapshot === undefined || snapshotMatchesFile(snapshot, file) === false
  })
  if (changed.length === 0 && state.obsoleteFiles.length === 0) return undefined
  const config = output.find((file) => file.path === '.buckconfig')!
  if (changed.some((file) => file.path === '.buckconfig') === false) changed.push(config)
  const files = changed
    .map((file): TransactionFile => {
      const snapshot = state.snapshots.get(file.path)
      const paths = transactionPaths({ token: lock.token, path: file.path })
      return {
        path: file.path,
        mode: file.mode,
        sha256: sha256(file.bytes),
        candidatePath: paths.candidatePath,
        backupPath: paths.backupPath,
        previous:
          snapshot === undefined
            ? { _tag: 'Missing' }
            : { _tag: 'File', mode: snapshot.mode as 0o644 | 0o755, sha256: snapshot.sha256 },
      }
    })
    .toSorted((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  const obsoleteFiles = state.obsoleteFiles
    .map(
      (file): ObsoleteTransactionFile => ({
        path: file.path,
        backupPath: transactionPaths({ token: lock.token, path: file.path }).backupPath,
        parentDev: file.parentIdentity.dev.toString(),
        parentIno: file.parentIdentity.ino.toString(),
        previous: {
          _tag: 'File',
          mode: file.snapshot.mode as 0o644 | 0o755,
          sha256: file.snapshot.sha256,
        },
      }),
    )
    .toSorted((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return Schema.decodeSync(
    CompositionPublicationTransactionSchema,
    strictParseOptions,
  )({
    schemaVersion: COMPOSITION_ROOT_SCHEMA_VERSION,
    lockOwner: lock.owner,
    lockToken: lock.token,
    phase: 'AuthorityPending',
    files,
    obsoleteFiles,
  })
}

const writeTransaction = async ({
  workspaceRoot,
  transaction,
}: {
  readonly workspaceRoot: string
  readonly transaction: CompositionPublicationTransaction
}): Promise<{
  readonly transaction: CompositionPublicationTransaction
  readonly snapshot: FileSnapshot
}> => {
  const root = `${TRANSACTION_ROOT}/${transaction.lockToken}`
  await ensureDirectory(workspaceRoot, `${root}/candidates`)
  await ensureDirectory(workspaceRoot, `${root}/backups`)
  const path = finalPathFor(workspaceRoot, TRANSACTION_PATH)
  const candidatePath = finalPathFor(
    workspaceRoot,
    transactionRecordCandidatePath({ token: transaction.lockToken }),
  )
  const snapshot = await atomicWrite({
    path,
    candidatePath,
    bytes: encodeJson(CompositionPublicationTransactionSchema, transaction),
  })
  return { transaction, snapshot }
}

const writeCommittedTransaction = async ({
  workspaceRoot,
  transaction,
}: {
  readonly workspaceRoot: string
  readonly transaction: CompositionPublicationTransaction
}): Promise<PublicationTransactionRecord> => {
  const committed: CompositionPublicationTransaction = {
    ...transaction,
    phase: 'AuthorityCommitted',
  }
  const snapshot = await writeExclusive({
    path: finalPathFor(workspaceRoot, COMMITTED_TRANSACTION_PATH),
    bytes: encodeJson(CompositionPublicationTransactionSchema, committed),
  })
  return { transaction: committed, snapshot }
}

const stageTransaction = async ({
  workspaceRoot,
  transaction,
  desired,
  runtime,
}: {
  readonly workspaceRoot: string
  readonly transaction: CompositionPublicationTransaction
  readonly desired: ReadonlyMap<string, GeneratedCompositionFile>
  readonly runtime: CompositionRootPublicationRuntime
}): Promise<ReadonlyMap<string, FileSnapshot>> => {
  const staged = new Map<string, FileSnapshot>()
  for (const file of transaction.files) {
    const generated = desired.get(file.path)!
    const path = finalPathFor(workspaceRoot, file.candidatePath)
    let snapshot = await snapshotMaybe(path)
    if (snapshot === undefined)
      snapshot = await writeExclusive({ path, bytes: generated.bytes, mode: generated.mode })
    if (snapshotMatchesTransaction(snapshot, file) === false) {
      throw failure({ reason: 'ForeignPath', path, message: `Refusing foreign candidate: ${path}` })
    }
    staged.set(file.path, snapshot)
    await runtime.afterCandidateFile?.(file.path)
    if (runtime.simulateProcessFaultAfterCandidate?.(file.path) === true) {
      throw new SimulatedProcessFault(file.path)
    }
  }
  return staged
}

const movePreviousToBackup = async ({
  workspaceRoot,
  file,
  expected,
  assertParent,
}: {
  readonly workspaceRoot: string
  readonly file: Pick<TransactionFile, 'path' | 'backupPath'>
  readonly expected: FileSnapshot | undefined
  readonly assertParent?: () => Promise<void>
}): Promise<void> => {
  await assertParent?.()
  const finalPath = finalPathFor(workspaceRoot, file.path)
  await assertIdentity({ path: finalPath, expected })
  if (expected === undefined) return
  const backupPath = finalPathFor(workspaceRoot, file.backupPath)
  if ((await snapshotMaybe(backupPath)) !== undefined) {
    throw failure({
      reason: 'ForeignPath',
      path: backupPath,
      message: `Backup path is occupied: ${backupPath}`,
    })
  }
  await assertParent?.()
  await rename(finalPath, backupPath)
  await syncDirectory(NodePath.dirname(finalPath))
  await syncDirectory(NodePath.dirname(backupPath))
  const backup = await snapshotMaybe(backupPath)
  if (backup === undefined || sameIdentity(backup, expected) === false) {
    throw failure({
      reason: 'RecoveryRefused',
      path: backupPath,
      message: `Moved backup identity changed: ${backupPath}`,
    })
  }
}

const installCandidate = async ({
  workspaceRoot,
  file,
  candidateIdentity,
}: {
  readonly workspaceRoot: string
  readonly file: TransactionFile
  readonly candidateIdentity: FileSnapshot
}): Promise<void> => {
  const candidatePath = finalPathFor(workspaceRoot, file.candidatePath)
  const finalPath = finalPathFor(workspaceRoot, file.path)
  await assertIdentity({ path: candidatePath, expected: candidateIdentity })
  if ((await snapshotMaybe(finalPath)) !== undefined) {
    throw failure({
      reason: 'ForeignPath',
      path: finalPath,
      message: `Destination was recreated before candidate install: ${finalPath}`,
    })
  }
  try {
    // link(2) is the no-clobber same-filesystem form of the candidate rename boundary.
    await link(candidatePath, finalPath)
  } catch (cause) {
    if (isErrno(cause, 'EEXIST') === true) {
      throw failure({
        reason: 'ForeignPath',
        path: finalPath,
        message: `Destination raced candidate install and was preserved: ${finalPath}`,
        cause,
      })
    }
    throw cause
  }
  await syncDirectory(NodePath.dirname(finalPath))
  await removeExact({ path: candidatePath, expected: candidateIdentity })
  const installed = await snapshotMaybe(finalPath)
  if (installed === undefined || snapshotMatchesTransaction(installed, file) === false) {
    throw failure({
      reason: 'IoFailure',
      path: finalPath,
      message: `Installed candidate failed validation: ${finalPath}`,
    })
  }
}

const assertDesiredRoot = async ({
  workspaceRoot,
  output,
  obsoleteFiles,
}: {
  readonly workspaceRoot: string
  readonly output: ReadonlyArray<GeneratedCompositionFile>
  readonly obsoleteFiles: ReadonlyArray<ObsoleteTransactionFile>
}): Promise<void> => {
  for (const file of output) {
    if (file.path === '.buckconfig') continue
    const path = finalPathFor(workspaceRoot, file.path)
    const snapshot = await snapshotMaybe(path)
    if (snapshot === undefined || snapshotMatchesFile(snapshot, file) === false) {
      throw failure({
        reason: 'ForeignPath',
        path,
        message: `Root is incomplete before .buckconfig authority: ${path}`,
      })
    }
  }
  for (const file of obsoleteFiles) {
    await assertObsoleteParentIdentity({ workspaceRoot, file })
    const path = finalPathFor(workspaceRoot, file.path)
    if ((await snapshotMaybe(path)) !== undefined) {
      throw failure({
        reason: 'ForeignPath',
        path,
        message: `Obsolete generated path remains before .buckconfig authority: ${path}`,
      })
    }
  }
}

const commitTransaction = async ({
  workspaceRoot,
  transaction,
  state,
  staged,
  output,
  runtime,
}: {
  readonly workspaceRoot: string
  readonly transaction: CompositionPublicationTransaction
  readonly state: PublicationValidationState
  readonly staged: ReadonlyMap<string, FileSnapshot>
  readonly output: ReadonlyArray<GeneratedCompositionFile>
  readonly runtime: CompositionRootPublicationRuntime
}): Promise<ReadonlyArray<string>> => {
  const config = transaction.files.find((file) => file.path === '.buckconfig')!
  await runtime.beforeInstallFile?.(config.path)
  await movePreviousToBackup({
    workspaceRoot,
    file: config,
    expected: state.snapshots.get(config.path),
  })
  const changed: string[] = []
  for (const file of transaction.files.filter((candidate) => candidate.path !== '.buckconfig')) {
    await runtime.beforeInstallFile?.(file.path)
    await movePreviousToBackup({
      workspaceRoot,
      file,
      expected: state.snapshots.get(file.path),
    })
    await installCandidate({ workspaceRoot, file, candidateIdentity: staged.get(file.path)! })
    await runtime.afterPublishedFile?.(file.path)
    if (runtime.simulateProcessFaultAfterPublishedFile?.(file.path) === true) {
      throw new SimulatedProcessFault(file.path)
    }
    changed.push(file.path)
  }
  for (const file of transaction.obsoleteFiles) {
    await runtime.beforeInstallFile?.(file.path)
    const previous = state.obsoleteFiles.find((candidate) => candidate.path === file.path)!
    await movePreviousToBackup({
      workspaceRoot,
      file,
      expected: previous.snapshot,
      assertParent: () => assertObsoleteParentIdentity({ workspaceRoot, file }),
    })
    await runtime.afterPublishedFile?.(file.path)
    if (runtime.simulateProcessFaultAfterPublishedFile?.(file.path) === true) {
      throw new SimulatedProcessFault(file.path)
    }
    changed.push(file.path)
  }
  await assertDesiredRoot({ workspaceRoot, output, obsoleteFiles: transaction.obsoleteFiles })
  await installCandidate({
    workspaceRoot,
    file: config,
    candidateIdentity: staged.get(config.path)!,
  })
  await runtime.afterPublishedFile?.(config.path)
  if (runtime.simulateProcessFaultAfterPublishedFile?.(config.path) === true) {
    throw new SimulatedProcessFault(config.path)
  }
  changed.push(config.path)
  return changed
}

const refusedPlan = ({
  reason,
  path,
  message,
}: {
  readonly reason: CompositionRootPublicationPlanRefusalReason
  readonly path: string
  readonly message: string
}): Extract<CompositionRootPublicationPlan, { readonly _tag: 'Refused' }> => ({
  _tag: 'Refused',
  reason,
  path,
  message,
  files: [],
  configLast: false,
})

/**
 * Read-only dry-run for composition publication. It shares strict preparation and ownership
 * validation with publication but creates no lock, candidate, directory, file, or callback effect.
 */
export const planCompositionRootPublication = Effect.fn('megarepo/composition-root/plan')(
  (options: PlanCompositionRootPublicationOptions) =>
    Effect.promise(async (): Promise<CompositionRootPublicationPlan> => {
      const workspaceRoot = NodePath.resolve(options.workspaceRoot)
      try {
        await validateWorkspaceRoot(workspaceRoot)
        const transaction = await readTransactionMaybe(workspaceRoot)
        if (transaction !== undefined) {
          return refusedPlan({
            reason: 'RecoveryRequired',
            path: finalPathFor(workspaceRoot, TRANSACTION_PATH),
            message: `Composition publication recovery is required for token ${transaction.transaction.lockToken}`,
          })
        }
        const lock = await readLock(workspaceRoot)
        if (lock !== undefined) {
          return refusedPlan({
            reason: 'LockHeld',
            path: finalPathFor(workspaceRoot, LOCK_PATH),
            message: `Composition publisher lock is held by ${lock.lock.owner}`,
          })
        }
        const { members, output } = await prepareComposition({
          workspaceRoot: workspaceRoot as AbsoluteDirPath,
          options,
        })
        await assertCompositionCapabilities({
          workspaceRoot: workspaceRoot as AbsoluteDirPath,
          ownedMemberKey: options.ownedMemberKey,
          members,
          assertCapabilityProjection: options.assertCapabilityProjection,
        })
        const state = await validatePublicationState({ workspaceRoot, files: output.files })
        const changed = output.files.filter((file) => {
          const snapshot = state.snapshots.get(file.path)
          return snapshot === undefined || snapshotMatchesFile(snapshot, file) === false
        })
        if (changed.length === 0 && state.obsoleteFiles.length === 0) {
          return { _tag: 'NoChange', files: [], configLast: true }
        }
        const config = output.files.find((file) => file.path === '.buckconfig')!
        const desiredPlans = changed
          .filter((file) => file.path !== '.buckconfig')
          .toSorted((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
          .map((file): CompositionRootPlannedFile => {
            const previous = state.snapshots.get(file.path)
            return {
              path: file.path,
              old:
                previous === undefined
                  ? undefined
                  : {
                      mode: previous.mode as 0o644 | 0o755,
                      sha256: previous.sha256,
                    },
              new: { mode: file.mode, sha256: sha256(file.bytes) },
            }
          })
        const obsoletePlans = state.obsoleteFiles.map(
          (file): CompositionRootPlannedFile => ({
            path: file.path,
            old: {
              mode: file.snapshot.mode as 0o644 | 0o755,
              sha256: file.snapshot.sha256,
            },
            new: undefined,
          }),
        )
        const previousConfig = state.snapshots.get(config.path)
        const configPlan: CompositionRootPlannedFile = {
          path: config.path,
          old:
            previousConfig === undefined
              ? undefined
              : {
                  mode: previousConfig.mode as 0o644 | 0o755,
                  sha256: previousConfig.sha256,
                },
          new: { mode: config.mode, sha256: sha256(config.bytes) },
        }
        return {
          _tag:
            state.snapshots.get(COMPOSITION_GENERATION_MANIFEST_PATH) === undefined
              ? 'Create'
              : 'Update',
          files: [...desiredPlans, ...obsoletePlans, configPlan],
          configLast: true,
        }
      } catch (cause) {
        const error = normalizeFailure({
          cause,
          path: workspaceRoot,
          message: 'Could not plan Buck2 composition-root publication',
        })
        return refusedPlan({
          reason: error.reason,
          path: error.path,
          message: error.message,
        })
      }
    }),
)

/**
 * Publish a serialized, rollback-capable Buck2 composition root. This primitive performs only
 * filesystem publication; it invokes no Git, Nix, mount, or command operation.
 */
export const publishCompositionRoot = Effect.fn('megarepo/composition-root/publish')(
  (options: PublishCompositionRootOptions) =>
    Effect.tryPromise({
      try: async (): Promise<CompositionRootPublicationResult> => {
        const workspaceRoot = NodePath.resolve(options.workspaceRoot)
        await validateWorkspaceRoot(workspaceRoot)
        await ensureDirectory(workspaceRoot, '.megarepo')
        const acquired = await acquireLock({ workspaceRoot, options: options.lock })
        let leaveForRecovery = false
        try {
          const { members, output } = await prepareComposition({
            workspaceRoot: workspaceRoot as AbsoluteDirPath,
            options,
          })
          await assertCompositionCapabilities({
            workspaceRoot: workspaceRoot as AbsoluteDirPath,
            ownedMemberKey: options.ownedMemberKey,
            members,
            assertCapabilityProjection: options.runtime.assertCapabilityProjection,
          })
          await ensureDirectory(workspaceRoot, '.megarepo/bin')
          const state = await validatePublicationState({ workspaceRoot, files: output.files })
          const transaction = makeTransaction({
            lock: acquired.lock,
            output: output.files,
            state,
          })
          if (transaction === undefined) {
            return {
              changedPaths: [],
              memberManifests: members.map(({ memberKey, manifest }) => ({ memberKey, manifest })),
            }
          }
          let authorityCommitted = false
          try {
            await writeTransaction({ workspaceRoot, transaction })
            const desired = new Map(output.files.map((file) => [file.path, file]))
            const staged = await stageTransaction({
              workspaceRoot,
              transaction,
              desired,
              runtime: options.runtime,
            })
            const changedPaths = await commitTransaction({
              workspaceRoot,
              transaction,
              state,
              staged,
              output: output.files,
              runtime: options.runtime,
            })
            await options.afterAuthorityPublished?.()
            const committedRecord = await writeCommittedTransaction({ workspaceRoot, transaction })
            authorityCommitted = true
            await options.runtime.afterAuthorityCommitted?.()
            const current = await readTransactionMaybe(workspaceRoot)
            if (current === undefined) {
              throw failure({
                reason: 'RecoveryRefused',
                path: finalPathFor(workspaceRoot, TRANSACTION_PATH),
                message: 'Transaction disappeared before committed cleanup',
              })
            }
            await cleanupTransactionForward({
              workspaceRoot,
              transaction: committedRecord.transaction,
              pendingRecord: current,
              committedRecord,
            })
            return {
              changedPaths,
              memberManifests: members.map(({ memberKey, manifest }) => ({ memberKey, manifest })),
            }
          } catch (cause) {
            if (cause instanceof SimulatedProcessFault || authorityCommitted === true) {
              leaveForRecovery = true
              throw cause
            }
            const current = await readTransactionMaybe(workspaceRoot)
            if (current !== undefined) {
              try {
                await rollbackTransaction({ workspaceRoot, transactionRecord: current })
              } catch {
                // A foreign replacement can make restoration unsafe. Preserve the original refusal
                // plus the exact-token lock/manifest so no later publisher mistakes it for clean state.
                leaveForRecovery = true
              }
            } else {
              const candidatePath = finalPathFor(
                workspaceRoot,
                transactionRecordCandidatePath({ token: transaction.lockToken }),
              )
              const candidate = await snapshotMaybe(candidatePath)
              const expectedBytes = encodeJson(CompositionPublicationTransactionSchema, transaction)
              if (
                candidate !== undefined &&
                candidate.mode === 0o644 &&
                bytesEqual(candidate.bytes, expectedBytes) === true
              ) {
                await removeExact({ path: candidatePath, expected: candidate })
              }
              await cleanupEmptyTransactionDirectories({
                workspaceRoot,
                token: transaction.lockToken,
              })
            }
            throw cause
          }
        } finally {
          if (leaveForRecovery === false) await releaseLock({ workspaceRoot, acquired })
        }
      },
      catch: (cause) =>
        normalizeFailure({
          cause,
          path: options.workspaceRoot,
          message: 'Could not publish Buck2 composition root',
        }),
    }),
)

const validateTeardownState = async ({
  workspaceRoot,
}: {
  readonly workspaceRoot: string
}): Promise<{
  readonly manifestSnapshot: FileSnapshot
  readonly manifest: CompositionGenerationManifest
  readonly files: ReadonlyMap<string, FileSnapshot>
}> => {
  const manifestPath = finalPathFor(workspaceRoot, COMPOSITION_GENERATION_MANIFEST_PATH)
  const manifestSnapshot = await snapshotMaybe(manifestPath)
  if (manifestSnapshot === undefined) {
    throw failure({
      reason: 'InvalidGenerationManifest',
      path: manifestPath,
      message: 'Cannot teardown without a generation manifest',
    })
  }
  if (manifestSnapshot.mode !== 0o644) {
    throw failure({
      reason: 'InvalidGenerationManifest',
      path: manifestPath,
      message: `Generation manifest mode is not owned: ${manifestPath}`,
    })
  }
  const manifest = decodeGenerationManifest({ snapshot: manifestSnapshot, path: manifestPath })
  const canonical = [
    '.buckconfig',
    '.buckroot',
    '.megarepo/bin/buck2',
    '.watchmanconfig',
    'BUCK',
  ].toSorted()
  assertManifestShape({ manifest, expectedPaths: canonical, path: manifestPath })
  const files = new Map<string, FileSnapshot>()
  for (const record of manifest.files) {
    const path = finalPathFor(workspaceRoot, record.path)
    const snapshot = await snapshotMaybe(path)
    if (
      snapshot === undefined ||
      snapshot.mode !== record.mode ||
      snapshot.sha256 !== record.sha256
    ) {
      throw failure({
        reason: 'ForeignPath',
        path,
        message: `Generated teardown ownership changed: ${path}`,
      })
    }
    files.set(record.path, snapshot)
  }
  return { manifestSnapshot, manifest, files }
}

/** Remove only immediately revalidated generated files and now-empty generator-owned directories. */
export const teardownCompositionRoot = Effect.fn('megarepo/composition-root/teardown')(
  (options: TeardownCompositionRootOptions) =>
    Effect.tryPromise({
      try: async (): Promise<CompositionRootTeardownResult> => {
        const workspaceRoot = NodePath.resolve(options.workspaceRoot)
        await validateWorkspaceRoot(workspaceRoot)
        await ensureDirectory(workspaceRoot, '.megarepo')
        const acquired = await acquireLock({ workspaceRoot, options: options.lock })
        const removedPaths: string[] = []
        const removedDirectories: string[] = []
        try {
          const state = await validateTeardownState({ workspaceRoot })
          const removalOrder = [
            ...state.manifest.files.filter((file) => file.path === '.buckconfig'),
            ...state.manifest.files.filter((file) => file.path !== '.buckconfig'),
          ]
          for (const record of removalOrder) {
            await options.beforeRemoveFile?.(record.path)
            const path = finalPathFor(workspaceRoot, record.path)
            const expected = state.files.get(record.path)!
            await removeExact({ path, expected })
            removedPaths.push(record.path)
          }
          await options.beforeRemoveFile?.(COMPOSITION_GENERATION_MANIFEST_PATH)
          await removeExact({
            path: finalPathFor(workspaceRoot, COMPOSITION_GENERATION_MANIFEST_PATH),
            expected: state.manifestSnapshot,
          })
          removedPaths.push(COMPOSITION_GENERATION_MANIFEST_PATH)
          for (const relativePath of OWNED_DIRECTORIES.filter((path) => path !== '.megarepo')) {
            const path = finalPathFor(workspaceRoot, relativePath)
            try {
              await rmdir(path)
              await syncDirectory(NodePath.dirname(path))
              removedDirectories.push(relativePath)
            } catch (cause) {
              if (
                isErrno(cause, 'ENOENT') === false &&
                isErrno(cause, 'ENOTEMPTY') === false &&
                isErrno(cause, 'EEXIST') === false
              ) {
                throw cause
              }
            }
          }
        } finally {
          await releaseLock({ workspaceRoot, acquired })
        }
        const metadataPath = finalPathFor(workspaceRoot, '.megarepo')
        try {
          await rmdir(metadataPath)
          await syncDirectory(workspaceRoot)
          removedDirectories.push('.megarepo')
        } catch (cause) {
          if (
            isErrno(cause, 'ENOENT') === false &&
            isErrno(cause, 'ENOTEMPTY') === false &&
            isErrno(cause, 'EEXIST') === false
          ) {
            throw cause
          }
        }
        return { removedPaths, removedDirectories }
      },
      catch: (cause) =>
        normalizeFailure({
          cause,
          path: options.workspaceRoot,
          message: 'Could not teardown Buck2 composition root',
        }),
    }),
)
