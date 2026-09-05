import { execFile as execFileCallback } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, mkdir, open, realpath, rm } from 'node:fs/promises'
import * as NodePath from 'node:path'
import { promisify } from 'node:util'

import { Schema } from 'effect'

import type {
  CompositionOwnedCapabilityProjectionPlan,
  CompositionOwnedCapabilityProjectionResult,
} from '../apply/composition-apply-schema.ts'
import {
  assertCapabilityGcRoots,
  capabilityGcRootsPath,
  installCapabilityGcRoots,
  reconcileCapabilityGcRoots,
  removeCapabilityGcRootGeneration,
  type CapabilityGcRootRuntime,
} from './capability-gc-roots.ts'

const execFile = promisify(execFileCallback)
const generationPattern = /^[0-9a-f]{64}$/u

/** Typed owned capability installation refusal. */
export class OwnedCapabilityProjectionError extends Schema.TaggedError<OwnedCapabilityProjectionError>()(
  'OwnedCapabilityProjectionError',
  {
    reason: Schema.Literals([
      'InvalidInput',
      'CopyFailed',
      'VerificationFailed',
      'PublishFailed',
      'GcRootFailed',
    ]),
    path: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** Exact tools and nonce source needed for an atomic owned-worktree projection install. */
export interface OwnedCapabilityProjectionRuntime {
  readonly cpPath: string
  readonly mvPath: string
  /** Pinned Nix identity used to register durable indirect GC roots for the installed outputs. */
  readonly capabilityGcRoots: CapabilityGcRootRuntime
  readonly nonce?: () => string
  /** Deterministic race seam; production runtimes must not provide it. */
  readonly beforeCopy?: (capabilityParent: string) => Promise<void>
  /** Deterministic race seam; production runtimes must not provide it. */
  readonly beforePublish?: (capabilityParent: string) => Promise<void>
}

const failure = ({
  reason,
  path,
  message,
  cause,
}: {
  readonly reason: OwnedCapabilityProjectionError['reason']
  readonly path: string
  readonly message: string
  readonly cause?: unknown
}) =>
  new OwnedCapabilityProjectionError({
    reason,
    path,
    message,
    ...(cause === undefined ? {} : { cause }),
  })

const normalizedAbsolute = ({ value, name }: { readonly value: string; readonly name: string }) => {
  if (NodePath.isAbsolute(value) === false || NodePath.normalize(value) !== value) {
    throw failure({
      reason: 'InvalidInput',
      path: value,
      message: `${name} must be a normalized absolute path`,
    })
  }
  return value
}

const containedBy = ({ root, path }: { readonly root: string; readonly path: string }) =>
  path === root || path.startsWith(`${root}${NodePath.sep}`) === true

const assertDirectory = async ({
  path,
  parent,
}: {
  readonly path: string
  readonly parent?: string
}) => {
  const info = await lstat(path)
  const physical = await realpath(path)
  if (
    info.isDirectory() === false ||
    info.isSymbolicLink() === true ||
    (parent !== undefined && containedBy({ root: parent, path: physical }) === false)
  ) {
    throw new TypeError(`Expected a real contained directory at '${path}'`)
  }
  return physical
}

interface DirectoryIdentity {
  readonly path: string
  readonly realpath: string
  readonly device: number
  readonly inode: number
}

const captureContainedDirectory = async ({
  path,
  parent,
}: {
  readonly path: string
  readonly parent: string
}): Promise<DirectoryIdentity> => {
  const info = await lstat(path)
  const canonicalPath = await realpath(path)
  if (
    info.isDirectory() === false ||
    info.isSymbolicLink() === true ||
    containedBy({ root: parent, path: canonicalPath }) === false
  ) {
    throw new TypeError(`Expected a real contained directory at '${path}'`)
  }
  return { path, realpath: canonicalPath, device: info.dev, inode: info.ino }
}

const assertDirectoryIdentity = async (identity: DirectoryIdentity): Promise<void> => {
  const current = await captureContainedDirectory({
    path: identity.path,
    parent: NodePath.dirname(identity.realpath),
  })
  if (
    current.realpath !== identity.realpath ||
    current.device !== identity.device ||
    current.inode !== identity.inode
  ) {
    throw new TypeError(`Directory identity changed at '${identity.path}'`)
  }
}

const isErrno = ({ cause, code }: { readonly cause: unknown; readonly code: string }): boolean =>
  typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === code

const readGeneration = async ({
  projectionPath,
  expectedParent,
}: {
  readonly projectionPath: string
  readonly expectedParent?: string
}) => {
  const physicalProjection = await assertDirectory({
    path: projectionPath,
    ...(expectedParent === undefined ? {} : { parent: expectedParent }),
  })
  const defsPath = NodePath.join(projectionPath, 'defs.bzl')
  let handle
  try {
    const beforePath = await lstat(defsPath)
    const physicalDefs = await realpath(defsPath)
    if (
      beforePath.isFile() === false ||
      beforePath.isSymbolicLink() === true ||
      containedBy({ root: physicalProjection, path: physicalDefs }) === false
    ) {
      throw new TypeError('defs.bzl must be a contained regular file')
    }
    handle = await open(defsPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    const before = await handle.stat()
    const bytes = await handle.readFile({ encoding: 'utf8' })
    const after = await handle.stat()
    if (
      before.dev !== beforePath.dev ||
      before.ino !== beforePath.ino ||
      after.ino !== before.ino
    ) {
      throw new TypeError('defs.bzl identity changed while reading')
    }
    const matches = [...bytes.matchAll(/^GENERATION = "([0-9a-f]{64})"$/gmu)]
    if (matches.length !== 1 || generationPattern.test(matches[0]![1]!) === false) {
      throw new TypeError('defs.bzl must declare exactly one valid GENERATION')
    }
    return matches[0]![1]!
  } finally {
    await handle?.close()
  }
}

const runExact = async ({
  executable,
  args,
}: {
  readonly executable: string
  readonly args: ReadonlyArray<string>
}) => {
  await execFile(executable, [...args], { maxBuffer: 1024 * 1024 })
}

/** Mutation-free description of the owned capability projection boundary. */
export const planOwnedCapabilityProjection = async ({
  memberKey,
  ownedMemberPath,
  projectionPath,
}: {
  readonly memberKey: string
  readonly ownedMemberPath: string
  readonly projectionPath: string
}): Promise<CompositionOwnedCapabilityProjectionPlan> => {
  normalizedAbsolute({ value: ownedMemberPath, name: 'ownedMemberPath' })
  normalizedAbsolute({ value: projectionPath, name: 'projectionPath' })
  return {
    memberKey,
    ownedMemberPath,
    projectionPath,
    operation: 'InstallOwnedCapabilityProjection',
    steps: ['ValidateOwnedMember', 'InstallProjectionAtomically', 'CheckProjection'],
  }
}

/**
 * Copy a checked scratch projection into the writable member and publish it with one atomic
 * directory exchange. Existing equal projections are left untouched.
 */
export const installOwnedCapabilityProjection = async ({
  memberKey,
  ownedMemberPath: rawOwnedMemberPath,
  projectionPath: rawProjectionPath,
  projectionDigest,
  runtime,
}: {
  readonly memberKey: string
  readonly ownedMemberPath: string
  readonly projectionPath: string
  readonly projectionDigest: string
  readonly runtime: OwnedCapabilityProjectionRuntime
}): Promise<CompositionOwnedCapabilityProjectionResult> => {
  const ownedMemberPath = normalizedAbsolute({ value: rawOwnedMemberPath, name: 'ownedMemberPath' })
  const projectionPath = normalizedAbsolute({ value: rawProjectionPath, name: 'projectionPath' })
  normalizedAbsolute({ value: runtime.cpPath, name: 'cpPath' })
  normalizedAbsolute({ value: runtime.mvPath, name: 'mvPath' })
  if (generationPattern.test(projectionDigest) === false) {
    throw failure({
      reason: 'InvalidInput',
      path: projectionPath,
      message: 'projectionDigest must be a lowercase sha256 identity',
    })
  }

  let physicalOwned: string
  try {
    physicalOwned = await assertDirectory({ path: ownedMemberPath })
    await access(NodePath.join(ownedMemberPath, '.git'), constants.R_OK)
    const physicalProjection = await assertDirectory({ path: projectionPath })
    if (containedBy({ root: physicalOwned, path: physicalProjection }) === true) {
      throw new TypeError('scratch projection must not be inside the owned member')
    }
    if ((await readGeneration({ projectionPath })) !== projectionDigest) {
      throw new TypeError('scratch projection generation does not match its checked digest')
    }
  } catch (cause) {
    throw failure({
      reason: 'VerificationFailed',
      path: projectionPath,
      message: 'Owned capability projection input failed verification',
      cause,
    })
  }

  const capabilityParent = NodePath.join(ownedMemberPath, '.buck2')
  const destination = NodePath.join(capabilityParent, 'capabilities')
  let capabilityParentIdentity: DirectoryIdentity
  try {
    try {
      await mkdir(capabilityParent, { mode: 0o700 })
    } catch (cause) {
      if (isErrno({ cause, code: 'EEXIST' }) === false) throw cause
    }
    capabilityParentIdentity = await captureContainedDirectory({
      path: capabilityParent,
      parent: physicalOwned,
    })
  } catch (cause) {
    throw failure({
      reason: 'VerificationFailed',
      path: capabilityParent,
      message: 'Owned .buck2 parent must be a real contained directory',
      cause,
    })
  }

  const token = runtime.nonce?.() ?? randomBytes(16).toString('hex')
  if (/^[A-Za-z0-9._-]+$/u.test(token) === false) {
    throw failure({
      reason: 'InvalidInput',
      path: capabilityParent,
      message: 'Owned capability projection nonce is not path-safe',
    })
  }
  const stage = NodePath.join(capabilityParent, `.capabilities.stage-${token}`)
  const removeStage = async (): Promise<void> => {
    await assertDirectoryIdentity(capabilityParentIdentity)
    await rm(stage, { recursive: true, force: true })
    await assertDirectoryIdentity(capabilityParentIdentity)
  }

  try {
    await removeStage()
    await runtime.beforeCopy?.(capabilityParent)
    await assertDirectoryIdentity(capabilityParentIdentity)
    await runExact({ executable: runtime.cpPath, args: ['-a', '--', projectionPath, stage] })
    await assertDirectoryIdentity(capabilityParentIdentity)
    if (
      (await readGeneration({
        projectionPath: stage,
        expectedParent: capabilityParentIdentity.realpath,
      })) !== projectionDigest
    ) {
      throw new TypeError('copied projection generation changed')
    }
  } catch (cause) {
    try {
      await removeStage()
    } catch {
      // Never clean through a replaced parent path.
    }
    throw failure({
      reason: 'CopyFailed',
      path: stage,
      message: 'Could not create a verified private capability candidate',
      cause,
    })
  }

  let destinationExists = true
  let currentGeneration: string | undefined
  try {
    await assertDirectoryIdentity(capabilityParentIdentity)
    currentGeneration = await readGeneration({
      projectionPath: destination,
      expectedParent: capabilityParentIdentity.realpath,
    })
  } catch (cause) {
    if (isErrno({ cause, code: 'ENOENT' }) === true) destinationExists = false
    else {
      try {
        await removeStage()
      } catch {
        // Never clean through a replaced parent path.
      }
      throw failure({
        reason: 'VerificationFailed',
        path: destination,
        message: 'Existing owned capability projection is not verifiable',
        cause,
      })
    }
  }

  // Root the candidate's realizations before publishing. The installed generation keeps its own
  // roots until the exchange succeeds, so a failed replacement can never strand the projection
  // that stays installed. Re-running for an unchanged generation re-registers and re-verifies it.
  const gcRootsPath = capabilityGcRootsPath({ ownedMemberPath })
  try {
    await installCapabilityGcRoots({
      projectionPath: stage,
      generation: projectionDigest,
      gcRootsPath,
      runtime: runtime.capabilityGcRoots,
    })
  } catch (cause) {
    try {
      if (currentGeneration !== projectionDigest) {
        await removeCapabilityGcRootGeneration({ gcRootsPath, generation: projectionDigest })
      }
      await removeStage()
    } catch {
      // Never clean through a replaced parent path, and never drop the installed generation.
    }
    throw failure({
      reason: 'GcRootFailed',
      path: gcRootsPath,
      message: 'Could not register durable Nix GC roots for the capability candidate',
      cause,
    })
  }

  const assertInstalledRoots = async (): Promise<void> => {
    try {
      await assertCapabilityGcRoots({
        projectionPath: destination,
        generation: projectionDigest,
        gcRootsPath,
        runtime: runtime.capabilityGcRoots,
      })
    } catch (cause) {
      throw failure({
        reason: 'GcRootFailed',
        path: destination,
        message: 'Installed owned capability projection is not durably rooted',
        cause,
      })
    }
  }

  if (currentGeneration === projectionDigest) {
    await removeStage()
    await assertInstalledRoots()
    await reconcileCapabilityGcRoots({ gcRootsPath, keepGeneration: projectionDigest })
    return { memberKey, projectionPath: destination, projectionDigest, changed: false }
  }

  try {
    await runtime.beforePublish?.(capabilityParent)
    await assertDirectoryIdentity(capabilityParentIdentity)
    if (destinationExists === false) {
      await runExact({
        executable: runtime.mvPath,
        args: ['-T', '--no-clobber', '--', stage, destination],
      })
    } else {
      await runExact({
        executable: runtime.mvPath,
        args: ['-T', '--exchange', '--', stage, destination],
      })
    }
    await assertDirectoryIdentity(capabilityParentIdentity)
    if (
      (await readGeneration({
        projectionPath: destination,
        expectedParent: capabilityParentIdentity.realpath,
      })) !== projectionDigest
    ) {
      throw new TypeError('published projection generation does not match')
    }
  } catch (cause) {
    if (destinationExists === true) {
      try {
        await assertDirectoryIdentity(capabilityParentIdentity)
        await runExact({
          executable: runtime.mvPath,
          args: ['-T', '--exchange', '--', stage, destination],
        })
        await assertDirectoryIdentity(capabilityParentIdentity)
      } catch {
        // Preserve both trees for explicit recovery when rollback cannot be proven.
      }
    }
    try {
      const installedGeneration = await readGeneration({
        projectionPath: destination,
        expectedParent: capabilityParentIdentity.realpath,
      })
      await reconcileCapabilityGcRoots({ gcRootsPath, keepGeneration: installedGeneration })
    } catch {
      // Keep every candidate root when the installed generation cannot be proven.
    }
    throw failure({
      reason: 'PublishFailed',
      path: destination,
      message: 'Could not atomically publish the owned capability projection',
      cause,
    })
  }

  await removeStage()
  await assertInstalledRoots()
  await reconcileCapabilityGcRoots({ gcRootsPath, keepGeneration: projectionDigest })
  return { memberKey, projectionPath: destination, projectionDigest, changed: true }
}
