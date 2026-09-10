/**
 * Manifest and content-identity layer for member mounts.
 *
 * R6 defines canonical tree scans, protected-tree verification, and persisted mount identity. It
 * does not copy or publish directories; concrete mount mechanisms such as the cp-a layer consume
 * these identities and enforce them across their own lifecycle.
 *
 * ## Why the codename, and why this is a module of its own
 *
 * "R6" is the manifest post-condition first exercised in
 * `context/buck2/05-composition/.experiments/2026-08-27-macos-apfs-primitives.md`. It answers one
 * question — does what is mounted still match the commit it claims — by comparing a manifest of
 * entries, modes, symlinks and content hashes against the immutable source, without materializing
 * a second copy of the tree to diff against.
 *
 * It is separate from `member-mount-cp-a.ts` because identity is not a property of any one mount
 * mechanism: a mechanism is judged by it, and more than one mechanism can be. Decision 0020
 * Amendment 1 makes the R6 post-condition MANDATORY on Darwin, where case-insensitive APFS can
 * silently collapse colliding paths during a copy and only an entry-count-and-hash comparison
 * catches it. Merging the two modules was considered and rejected on that evidence.
 */
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, readlink, realpath } from 'node:fs/promises'
import * as NodePath from 'node:path'

import { Effect, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import type { PlatformError } from 'effect/PlatformError'

import { EffectPath } from '@overeng/effect-path'

import { writeFileAtomic } from '../../store/store-fs-atomic.ts'
import {
  canonicalizeDistOverlayDeclarations,
  DistOverlayDeclaration,
  DistOverlayDestination,
  DistOverlayTarget,
  R6_CAPABILITIES_DESTINATION,
  type DistOverlayDeclaration as DistOverlayDeclarationType,
} from '../overlays/dist-overlay-schema.ts'
import { inspectMemberMount } from './member-mount.ts'

/** Canonical R6 manifest wire version. */
export const R6_MANIFEST_VERSION = 1 as const
/** Owned cp-a mount metadata wire version. */
export const OWNED_CP_A_MOUNT_METADATA_VERSION = 2 as const

const Sha256 = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/u))
const CanonicalRelativePath = Schema.String.check(
  Schema.makeFilter<string>((value) => {
    try {
      return normalizeManifestPath(value) === value
        ? undefined
        : 'Expected a normalized R6 relative path'
    } catch {
      return 'Expected a normalized R6 relative path'
    }
  }),
)
const ProtectedFileMode = Schema.Literals([0o444, 0o555])

/** Canonical regular-file entry schema. */
export const R6FileEntry = Schema.Struct({
  path: CanonicalRelativePath,
  kind: Schema.Literal('file'),
  mode: ProtectedFileMode,
  payload: Sha256,
}).annotate({ identifier: 'Megarepo.R6FileEntry' })
export type R6FileEntry = typeof R6FileEntry.Type

/** Canonical directory entry schema. */
export const R6DirectoryEntry = Schema.Struct({
  path: CanonicalRelativePath,
  kind: Schema.Literal('directory'),
  mode: Schema.Literal(0o555),
  payload: Schema.Null,
}).annotate({ identifier: 'Megarepo.R6DirectoryEntry' })
export type R6DirectoryEntry = typeof R6DirectoryEntry.Type

/** Canonical COMP-R08-admitted symlink entry schema. */
export const R6SymlinkEntry = Schema.Struct({
  path: CanonicalRelativePath,
  kind: Schema.Literal('symlink'),
  mode: Schema.Null,
  payload: Schema.String.check(Schema.isMinLength(1)),
})
  .check(
    Schema.makeFilter((entry) => {
      try {
        validateR6SymlinkTarget({ path: entry.path, target: entry.payload })
        return undefined
      } catch (cause) {
        return cause instanceof Error ? cause.message : 'Forbidden R6 symlink target'
      }
    }),
  )
  .annotate({ identifier: 'Megarepo.R6SymlinkEntry' })
export type R6SymlinkEntry = typeof R6SymlinkEntry.Type

/** Canonical R6 entry union schema. */
export const R6ManifestEntry = Schema.Union([R6FileEntry, R6DirectoryEntry, R6SymlinkEntry])
export type R6ManifestEntry = typeof R6ManifestEntry.Type

/** Versioned, byte-sorted R6 manifest schema. */
export const R6Manifest = Schema.Struct({
  version: Schema.Literal(R6_MANIFEST_VERSION),
  entries: Schema.Array(R6ManifestEntry),
})
  .check(
    Schema.makeFilter((manifest) => {
      try {
        const canonical = canonicalizeR6Entries(manifest.entries)
        return canonical.every((entry, index) => entry.path === manifest.entries[index]?.path) ===
          true
          ? undefined
          : 'Expected byte-sorted canonical R6 manifest entries'
      } catch (cause) {
        return cause instanceof Error ? cause.message : 'Invalid canonical R6 manifest'
      }
    }),
  )
  .annotate({ identifier: 'Megarepo.R6Manifest' })
export type R6Manifest = typeof R6Manifest.Type

/** Digest and entry-count identity for one R6 tree. */
export const R6ManifestIdentity = Schema.Struct({
  digest: Sha256,
  count: Schema.Natural,
})
export type R6ManifestIdentity = typeof R6ManifestIdentity.Type

/** Separate capability-tree identity, including missing-versus-empty presence. */
export const R6CapabilityManifestIdentity = Schema.Struct({
  present: Schema.Boolean,
  digest: Sha256,
  count: Schema.Natural,
})
export type R6CapabilityManifestIdentity = typeof R6CapabilityManifestIdentity.Type

/** Published identity of one declared overlay subtree. Absence means not yet published. */
export const R6DistOverlayManifestIdentity = Schema.Struct({
  target: DistOverlayTarget,
  destination: DistOverlayDestination,
  digest: Sha256,
  count: Schema.Natural,
}).annotate({ identifier: 'Megarepo.R6DistOverlayManifestIdentity' })
export type R6DistOverlayManifestIdentity = typeof R6DistOverlayManifestIdentity.Type

/** Strict persisted ownership binding for one published cp-a mount. */
export const OwnedCpAMountMetadata = Schema.Struct({
  version: Schema.Literal(OWNED_CP_A_MOUNT_METADATA_VERSION),
  member: Schema.String.check(Schema.isMinLength(1)),
  lockedCommit: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40,64}$/u)),
  sourcePathIdentity: Sha256,
  repository: R6ManifestIdentity,
  capabilities: R6CapabilityManifestIdentity,
  declaredOverlays: Schema.Array(DistOverlayDeclaration),
  overlays: Schema.Array(R6DistOverlayManifestIdentity),
  publishedPath: Schema.String.check(Schema.isPattern(/^\//u)),
})
  .check(
    Schema.makeFilter((metadata) => {
      try {
        const declarations = canonicalizeDistOverlayDeclarations(metadata.declaredOverlays)
        if (
          declarations.some(
            (declaration, index) =>
              declaration.target !== metadata.declaredOverlays[index]?.target ||
              declaration.destination !== metadata.declaredOverlays[index]?.destination,
          ) === true
        ) {
          return 'Expected canonical declared overlay order'
        }
        const canonicalOverlays = [...metadata.overlays].toSorted((left, right) =>
          left.destination < right.destination ? -1 : left.destination > right.destination ? 1 : 0,
        )
        if (
          canonicalOverlays.some(
            (overlay, index) =>
              overlay.target !== metadata.overlays[index]?.target ||
              overlay.destination !== metadata.overlays[index]?.destination,
          ) === true
        ) {
          return 'Expected canonical published overlay order'
        }
        const seen = new Set<string>()
        for (const overlay of metadata.overlays) {
          const declaration = declarations.find(
            (item) => item.target === overlay.target && item.destination === overlay.destination,
          )
          if (declaration === undefined)
            return `Published overlay is not declared: ${overlay.destination}`
          if (seen.has(overlay.destination) === true) {
            return `Duplicate published overlay destination: ${overlay.destination}`
          }
          seen.add(overlay.destination)
        }
        return undefined
      } catch (cause) {
        return cause instanceof Error ? cause.message : 'Invalid overlay metadata'
      }
    }),
  )
  .annotate({ identifier: 'Megarepo.OwnedCpAMountMetadata' })
export type OwnedCpAMountMetadata = typeof OwnedCpAMountMetadata.Type

/** A canonical manifest and its deterministic identity. */
export interface R6TreeScan {
  readonly manifest: R6Manifest
  readonly digest: string
  readonly count: number
}

/** No-follow filesystem identity for one mount-directory inode. */
export interface OwnedCpAMountIdentity {
  readonly dev: number
  readonly ino: number
}

/** Deterministic test seam after a scan captures its initial root identity. */
export interface R6ScanHooks {
  readonly afterInitialRootIdentity?: (input: {
    readonly root: string
    readonly identity: OwnedCpAMountIdentity
  }) => Promise<void>
}

/** One separately excluded declared overlay subtree scan. */
export interface R6DistOverlayTreeScan extends R6TreeScan, DistOverlayDeclarationType {
  readonly present: boolean
}

/** Repository and separately excluded capability/overlay subtree scans. */
export interface R6MountScan {
  readonly identity: OwnedCpAMountIdentity
  readonly repository: R6TreeScan
  readonly capabilities: R6TreeScan & { readonly present: boolean }
  readonly overlays: ReadonlyArray<R6DistOverlayTreeScan>
}

/** Closed reasons for source or protected-tree rejection. */
export type R6ScanErrorReason =
  | 'IoFailure'
  | 'InvalidRoot'
  | 'InvalidPath'
  | 'PathCollision'
  | 'SpecialFile'
  | 'UnexpectedMode'
  | 'ForbiddenSymlink'

/** Typed failure from an R6 filesystem scan. */
export interface R6ScanError {
  readonly _tag: 'R6ScanError'
  readonly reason: R6ScanErrorReason
  readonly path: string
  readonly message: string
  readonly cause?: unknown
}

/** Synchronous canonicalization or COMP-R08 validation failure. */
export class R6ManifestValidationError extends Error {
  readonly _tag = 'R6ManifestValidationError'
  readonly reason: R6ScanErrorReason

  constructor({ reason, message }: { reason: R6ScanErrorReason; message: string }) {
    super(message)
    this.reason = reason
  }
}

const normalizeManifestPath = (path: string): string => {
  if (
    path.length === 0 ||
    path.startsWith('/') === true ||
    path.endsWith('/') === true ||
    path.includes('\\') === true ||
    path.includes('\0') === true
  ) {
    throw new R6ManifestValidationError({
      reason: 'InvalidPath',
      message: `Invalid R6 relative path '${path}'`,
    })
  }

  const normalized = path
    .split('/')
    .map((part) => part.normalize('NFC'))
    .join('/')
  const parts = normalized.split('/')
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..') === true) {
    throw new R6ManifestValidationError({
      reason: 'InvalidPath',
      message: `Invalid R6 relative path '${path}'`,
    })
  }
  return normalized
}

const darwinCaseFold = (path: string): string =>
  path.normalize('NFD').toUpperCase().toLowerCase().normalize('NFC')

/** Validate paths, reject exact/case-fold collisions, and byte-sort entries. */
export const canonicalizeR6Entries = (
  entries: ReadonlyArray<R6ManifestEntry>,
): ReadonlyArray<R6ManifestEntry> => {
  const normalized = entries.map((entry) => ({ ...entry, path: normalizeManifestPath(entry.path) }))
  normalized.sort((left, right) =>
    Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8')),
  )

  const exact = new Set<string>()
  const folded = new Map<string, string>()
  for (const entry of normalized) {
    if (entry.kind === 'symlink') {
      validateR6SymlinkTarget({ path: entry.path, target: entry.payload })
    }
    if (exact.has(entry.path) === true) {
      throw new R6ManifestValidationError({
        reason: 'PathCollision',
        message: `Duplicate R6 manifest path '${entry.path}'`,
      })
    }
    exact.add(entry.path)

    const key = darwinCaseFold(entry.path)
    const prior = folded.get(key)
    if (prior !== undefined && prior !== entry.path) {
      throw new R6ManifestValidationError({
        reason: 'PathCollision',
        message: `Case-fold-colliding R6 manifest paths '${prior}' and '${entry.path}'`,
      })
    }
    folded.set(key, entry.path)
  }
  return normalized
}

/** Construct a validated, byte-sorted R6 manifest. */
export const makeR6Manifest = (entries: ReadonlyArray<R6ManifestEntry>): R6Manifest => ({
  version: R6_MANIFEST_VERSION,
  entries: [...canonicalizeR6Entries(entries)],
})

const frame = (value: Uint8Array): Buffer => {
  const length = Buffer.allocUnsafe(8)
  length.writeBigUInt64BE(BigInt(value.byteLength))
  return Buffer.concat([length, value])
}

const utf8Frame = (value: string): Buffer => frame(Buffer.from(value, 'utf8'))

/** Canonical, length-framed wire bytes used as the sole R6 digest input. */
export const encodeR6ManifestFramed = (manifest: R6Manifest): Uint8Array => {
  const entries = canonicalizeR6Entries(manifest.entries)
  const chunks: Array<Buffer> = [
    utf8Frame('overeng.megarepo.r6-manifest'),
    utf8Frame(String(R6_MANIFEST_VERSION)),
    utf8Frame(String(entries.length)),
  ]
  for (const entry of entries) {
    chunks.push(
      utf8Frame(entry.kind),
      utf8Frame(entry.path),
      utf8Frame(entry.mode === null ? '' : entry.mode.toString(8).padStart(4, '0')),
      utf8Frame(entry.payload === null ? '' : entry.payload),
    )
  }
  return Buffer.concat(chunks)
}

/** Hash only the canonical framed R6 wire bytes. */
export const digestR6Manifest = (manifest: R6Manifest): string =>
  `sha256:${createHash('sha256').update(encodeR6ManifestFramed(manifest)).digest('hex')}`

const scanError = ({
  reason,
  path,
  message,
  cause,
}: {
  reason: R6ScanErrorReason
  path: string
  message: string
  cause?: unknown
}): R6ScanError => ({
  _tag: 'R6ScanError',
  reason,
  path,
  message,
  ...(cause === undefined ? {} : { cause }),
})

class WalkFailure extends Error {
  constructor(readonly error: R6ScanError) {
    super(error.message)
  }
}

const failWalk = (error: R6ScanError): never => {
  throw new WalkFailure(error)
}

const fileSha256 = (path: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(`sha256:${hash.digest('hex')}`))
  })

type ScanPolicy = 'artifact' | 'source' | 'protected'

const expectedModeMessage = ({
  policy,
  kind,
}: {
  policy: ScanPolicy
  kind: 'file' | 'directory'
}): string => {
  if (kind === 'directory')
    return policy === 'artifact' ? '0555 or 0755' : policy === 'protected' ? '0555' : '0755'
  return policy === 'artifact' ? '0444, 0555, 0644, or 0755' : '0444 or 0555'
}

const validateMode = ({
  policy,
  kind,
  mode,
  path,
}: {
  policy: ScanPolicy
  kind: 'file' | 'directory'
  mode: number
  path: string
}): 0o444 | 0o555 => {
  const permissions = mode & 0o7777
  const valid =
    kind === 'directory'
      ? policy === 'artifact'
        ? permissions === 0o555 || permissions === 0o755
        : permissions === (policy === 'protected' ? 0o555 : 0o755)
      : policy === 'artifact'
        ? permissions === 0o444 ||
          permissions === 0o555 ||
          permissions === 0o644 ||
          permissions === 0o755
        : permissions === 0o444 || permissions === 0o555
  if (valid === false) {
    failWalk(
      scanError({
        reason: 'UnexpectedMode',
        path,
        message: `Unexpected ${policy} ${kind} mode ${permissions.toString(8).padStart(4, '0')} at '${path}'; expected ${expectedModeMessage({ policy, kind })}`,
      }),
    )
  }
  if (kind === 'directory') return 0o555
  if (policy === 'artifact') return permissions === 0o755 ? 0o555 : 0o444
  return permissions as 0o444 | 0o555
}

/** COMP-R08 link admission. Relative targets may contain `..` only while staying in-root. */
export const validateR6SymlinkTarget = ({
  path,
  target,
}: {
  path: string
  target: string
}): void => {
  if (target.length === 0 || target.includes('\0') === true) {
    throw new R6ManifestValidationError({
      reason: 'ForbiddenSymlink',
      message: `Invalid symlink target at '${path}'`,
    })
  }
  if (NodePath.posix.isAbsolute(target) === true) {
    const normalized = NodePath.posix.normalize(target)
    if (
      normalized !== target ||
      /^\/nix\/store\/[0-9abcdfghijklmnpqrsvwxyz]{32}-[^/]+(?:\/.*)?$/u.test(normalized) === false
    ) {
      throw new R6ManifestValidationError({
        reason: 'ForbiddenSymlink',
        message: `Absolute symlink at '${path}' must target a valid /nix/store object descendant, got '${target}'`,
      })
    }
    return
  }

  const resolved = NodePath.posix.normalize(
    NodePath.posix.join(NodePath.posix.dirname(path), target),
  )
  if (
    resolved === '..' ||
    resolved.startsWith('../') === true ||
    NodePath.posix.isAbsolute(resolved) === true
  ) {
    throw new R6ManifestValidationError({
      reason: 'ForbiddenSymlink',
      message: `Relative symlink at '${path}' escapes the repository root: '${target}'`,
    })
  }
}

const mountIdentity = (info: {
  readonly dev: number
  readonly ino: number
}): OwnedCpAMountIdentity => Object.freeze({ dev: info.dev, ino: info.ino })

const mountIdentityMatches = ({
  actual,
  expected,
}: {
  actual: OwnedCpAMountIdentity
  expected: OwnedCpAMountIdentity
}): boolean => actual.dev === expected.dev && actual.ino === expected.ino

const validateAbsoluteStoreTargetExists = async ({
  path,
  target,
}: {
  path: string
  target: string
}): Promise<void> => {
  if (NodePath.posix.isAbsolute(target) === false) return
  const resolved = await realpath(target).catch((cause) =>
    failWalk(
      scanError({
        reason: 'ForbiddenSymlink',
        path,
        message: `Absolute Nix store symlink target does not exist: '${target}'`,
        cause,
      }),
    ),
  )
  try {
    validateR6SymlinkTarget({ path, target: resolved })
  } catch (cause) {
    if (cause instanceof R6ManifestValidationError) {
      failWalk(scanError({ reason: cause.reason, path, message: cause.message }))
    }
    throw cause
  }
}

const scanTreePromise = async ({
  root,
  policy,
  excludedSubtrees,
  hooks,
}: {
  root: string
  policy: ScanPolicy
  excludedSubtrees: ReadonlySet<string>
  hooks?: R6ScanHooks
}): Promise<{ readonly scan: R6TreeScan; readonly identity: OwnedCpAMountIdentity }> => {
  const rootInfo = await lstat(root)
  if (rootInfo.isDirectory() === false) {
    failWalk(
      scanError({
        reason: 'InvalidRoot',
        path: root,
        message: `R6 scan root '${root}' is not a directory`,
      }),
    )
  }
  validateMode({ policy, kind: 'directory', mode: rootInfo.mode, path: root })
  const initialIdentity = mountIdentity(rootInfo)
  await hooks?.afterInitialRootIdentity?.({ root, identity: initialIdentity })

  const entries: Array<R6ManifestEntry> = []
  const visit = async ({
    actualRelative,
    manifestRelative,
  }: {
    actualRelative: string
    manifestRelative: string
  }): Promise<void> => {
    const directoryPath = actualRelative === '' ? root : NodePath.join(root, actualRelative)
    const children = await readdir(directoryPath, { withFileTypes: true })
    await children.reduce(async (previous, child) => {
      await previous
      const actualChild = actualRelative === '' ? child.name : `${actualRelative}/${child.name}`
      const manifestName = normalizeManifestPath(child.name)
      const manifestChild =
        manifestRelative === '' ? manifestName : `${manifestRelative}/${manifestName}`
      if (excludedSubtrees.has(manifestChild) === true) return

      const childPath = NodePath.join(root, ...actualChild.split('/'))
      const info = await lstat(childPath)
      if (info.isSymbolicLink() === true) {
        const target = await readlink(childPath)
        try {
          validateR6SymlinkTarget({ path: manifestChild, target })
        } catch (cause) {
          if (cause instanceof R6ManifestValidationError) {
            failWalk(
              scanError({
                reason: cause.reason,
                path: childPath,
                message: cause.message,
              }),
            )
          }
          throw cause
        }
        await validateAbsoluteStoreTargetExists({ path: childPath, target })
        entries.push({ path: manifestChild, kind: 'symlink', mode: null, payload: target })
      } else if (info.isDirectory() === true) {
        validateMode({ policy, kind: 'directory', mode: info.mode, path: childPath })
        if (manifestChild !== '.buck2' || excludedSubtrees.has('.buck2/capabilities') === false) {
          entries.push({ path: manifestChild, kind: 'directory', mode: 0o555, payload: null })
        }
        await visit({ actualRelative: actualChild, manifestRelative: manifestChild })
      } else if (info.isFile() === true) {
        const mode = validateMode({ policy, kind: 'file', mode: info.mode, path: childPath })
        entries.push({
          path: manifestChild,
          kind: 'file',
          mode,
          payload: await fileSha256(childPath),
        })
      } else {
        failWalk(
          scanError({
            reason: 'SpecialFile',
            path: childPath,
            message: `Special filesystem entry is forbidden in an R6 tree: '${childPath}'`,
          }),
        )
      }
    }, Promise.resolve())
  }

  await visit({ actualRelative: '', manifestRelative: '' })
  let manifest: R6Manifest
  try {
    manifest = makeR6Manifest(entries)
  } catch (cause) {
    if (cause instanceof R6ManifestValidationError) {
      failWalk(scanError({ reason: cause.reason, path: root, message: cause.message }))
    }
    throw cause
  }
  const finalInfo = await lstat(root)
  const finalIdentity = mountIdentity(finalInfo)
  if (
    finalInfo.isDirectory() === false ||
    mountIdentityMatches({ actual: finalIdentity, expected: initialIdentity }) === false
  ) {
    failWalk(
      scanError({
        reason: 'InvalidRoot',
        path: root,
        message: `R6 scan root identity changed during scan: '${root}'`,
      }),
    )
  }
  return {
    scan: { manifest, digest: digestR6Manifest(manifest), count: manifest.entries.length },
    identity: initialIdentity,
  }
}

const emptyTreeScan = (): R6TreeScan => {
  const manifest = makeR6Manifest([])
  return { manifest, digest: digestR6Manifest(manifest), count: 0 }
}

const isNodeNotFound = (cause: unknown): boolean =>
  typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT'

const scanOptionalExcludedTree = async ({
  root,
  policy,
}: {
  root: string
  policy: ScanPolicy
}): Promise<R6TreeScan & { readonly present: boolean }> => {
  try {
    const info = await lstat(root)
    if (info.isDirectory() === false) {
      failWalk(
        scanError({
          reason: 'InvalidRoot',
          path: root,
          message: `Excluded R6 subtree '${root}' is not a directory`,
        }),
      )
    }
    return {
      ...(await scanTreePromise({ root, policy, excludedSubtrees: new Set() })).scan,
      present: true,
    }
  } catch (cause) {
    if (isNodeNotFound(cause) === true) return { ...emptyTreeScan(), present: false }
    throw cause
  }
}

const scanMount = ({
  root,
  policy,
  declaredOverlays = [],
  hooks,
}: {
  root: string
  policy: ScanPolicy
  declaredOverlays?: ReadonlyArray<DistOverlayDeclarationType>
  hooks?: R6ScanHooks
}) =>
  Effect.tryPromise({
    try: async (): Promise<R6MountScan> => {
      const absoluteRoot = NodePath.resolve(root)
      let canonicalOverlays: ReadonlyArray<DistOverlayDeclarationType> = []
      try {
        canonicalOverlays = canonicalizeDistOverlayDeclarations(declaredOverlays)
      } catch (cause) {
        failWalk(
          scanError({
            reason: 'PathCollision',
            path: absoluteRoot,
            message:
              cause instanceof Error ? cause.message : 'Invalid declared overlay destinations',
            cause,
          }),
        )
      }
      if (policy === 'source') {
        await Promise.all(
          canonicalOverlays.map(async (overlay) => {
            const destinationPath = NodePath.join(absoluteRoot, ...overlay.destination.split('/'))
            try {
              await lstat(destinationPath)
              failWalk(
                scanError({
                  reason: 'PathCollision',
                  path: destinationPath,
                  message: `Immutable source contains declared overlay destination '${overlay.destination}'`,
                }),
              )
            } catch (cause) {
              if (isNodeNotFound(cause) === false) throw cause
            }
          }),
        )
      }
      const excludedSubtrees = new Set<string>([
        R6_CAPABILITIES_DESTINATION,
        ...canonicalOverlays.map((overlay) => overlay.destination),
      ])
      const repositoryResult = await scanTreePromise({
        root: absoluteRoot,
        policy,
        excludedSubtrees,
        ...(hooks === undefined ? {} : { hooks }),
      })
      const capabilities = await scanOptionalExcludedTree({
        root: NodePath.join(absoluteRoot, ...R6_CAPABILITIES_DESTINATION.split('/')),
        policy,
      })
      const overlays: ReadonlyArray<R6DistOverlayTreeScan> = await Promise.all(
        canonicalOverlays.map(async (overlay) => {
          const scan = await scanOptionalExcludedTree({
            root: NodePath.join(absoluteRoot, ...overlay.destination.split('/')),
            policy,
          })
          return {
            target: overlay.target,
            destination: overlay.destination,
            manifest: scan.manifest,
            digest: scan.digest,
            count: scan.count,
            present: scan.present,
          }
        }),
      )
      return {
        identity: repositoryResult.identity,
        repository: repositoryResult.scan,
        capabilities,
        overlays,
      }
    },
    catch: (cause): R6ScanError =>
      cause instanceof WalkFailure
        ? cause.error
        : scanError({
            reason: 'IoFailure',
            path: NodePath.resolve(root),
            message: `Failed to scan R6 tree '${NodePath.resolve(root)}'`,
            cause,
          }),
  })

/** Scan one writable Buck artifact and normalize its regular modes into R6 identity. */
export const scanR6BuildArtifactTree = ({
  root,
}: {
  root: string
}): Effect.Effect<R6TreeScan, R6ScanError> =>
  Effect.tryPromise({
    try: async () =>
      (
        await scanTreePromise({
          root: NodePath.resolve(root),
          policy: 'artifact',
          excludedSubtrees: new Set(),
        })
      ).scan,
    catch: (cause): R6ScanError =>
      cause instanceof WalkFailure
        ? cause.error
        : scanError({
            reason: 'IoFailure',
            path: NodePath.resolve(root),
            message: `Failed to scan R6 build artifact tree '${NodePath.resolve(root)}'`,
            cause,
          }),
  })

/** Scan one standalone immutable source tree without reserved subtree exclusions. */
export const scanR6SourceTree = ({
  root,
}: {
  root: string
}): Effect.Effect<R6TreeScan, R6ScanError> =>
  Effect.tryPromise({
    try: async () =>
      (
        await scanTreePromise({
          root: NodePath.resolve(root),
          policy: 'source',
          excludedSubtrees: new Set(),
        })
      ).scan,
    catch: (cause): R6ScanError =>
      cause instanceof WalkFailure
        ? cause.error
        : scanError({
            reason: 'IoFailure',
            path: NodePath.resolve(root),
            message: `Failed to scan R6 source tree '${NodePath.resolve(root)}'`,
            cause,
          }),
  })

/** Scan one standalone protected tree without reserved subtree exclusions. */
export const scanR6ProtectedTree = ({
  root,
}: {
  root: string
}): Effect.Effect<R6TreeScan, R6ScanError> =>
  Effect.tryPromise({
    try: async () =>
      (
        await scanTreePromise({
          root: NodePath.resolve(root),
          policy: 'protected',
          excludedSubtrees: new Set(),
        })
      ).scan,
    catch: (cause): R6ScanError =>
      cause instanceof WalkFailure
        ? cause.error
        : scanError({
            reason: 'IoFailure',
            path: NodePath.resolve(root),
            message: `Failed to scan R6 protected tree '${NodePath.resolve(root)}'`,
            cause,
          }),
  })

/** Scan an immutable source tree: files 0444/0555 and directories exactly 0755. */
export const scanR6Source = ({
  root,
  declaredOverlays = [],
  hooks,
}: {
  root: string
  declaredOverlays?: ReadonlyArray<DistOverlayDeclarationType>
  hooks?: R6ScanHooks
}): Effect.Effect<R6MountScan, R6ScanError> =>
  scanMount({ root, policy: 'source', declaredOverlays, ...(hooks === undefined ? {} : { hooks }) })

/** Scan a published protected mount: files 0444/0555 and directories exactly 0555. */
export const scanR6ProtectedMount = ({
  root,
  declaredOverlays = [],
  hooks,
}: {
  root: string
  declaredOverlays?: ReadonlyArray<DistOverlayDeclarationType>
  hooks?: R6ScanHooks
}): Effect.Effect<R6MountScan, R6ScanError> =>
  scanMount({
    root,
    policy: 'protected',
    declaredOverlays,
    ...(hooks === undefined ? {} : { hooks }),
  })

const canonicalAbsolutePath = (path: string): string => {
  if (NodePath.isAbsolute(path) === false) {
    throw new R6ManifestValidationError({
      reason: 'InvalidPath',
      message: `Expected absolute path, got '${path}'`,
    })
  }
  return NodePath.normalize(path)
}

/** Bijective lowercase hex stays collision-free on case-insensitive Darwin filesystems. */
export const encodeOwnedMountMemberFilename = (member: string): string => {
  if (member.length === 0) {
    throw new R6ManifestValidationError({
      reason: 'InvalidPath',
      message: 'Owned mount member name must not be empty',
    })
  }
  return `v1-${Buffer.from(member, 'utf8').toString('hex')}.json`
}

/** Derive the workspace-owned metadata path outside the member mount. */
export const ownedCpAMountMetadataPath = ({
  workspaceRoot,
  member,
}: {
  workspaceRoot: string
  member: string
}): string =>
  NodePath.join(
    canonicalAbsolutePath(workspaceRoot),
    'repos',
    '.mr',
    'mounts',
    encodeOwnedMountMemberFilename(member),
  )

/** Bind expected identity fields to freshly scanned manifest identities. */
export const makeOwnedCpAMountMetadata = ({
  member,
  lockedCommit,
  sourcePathIdentity,
  publishedPath,
  declaredOverlays = [],
  scan,
}: {
  member: string
  lockedCommit: string
  sourcePathIdentity: string
  publishedPath: string
  declaredOverlays?: ReadonlyArray<DistOverlayDeclarationType>
  scan: R6MountScan
}): OwnedCpAMountMetadata => ({
  version: OWNED_CP_A_MOUNT_METADATA_VERSION,
  member,
  lockedCommit,
  sourcePathIdentity,
  repository: {
    digest: scan.repository.digest,
    count: scan.repository.count,
  },
  capabilities: {
    present: scan.capabilities.present,
    digest: scan.capabilities.digest,
    count: scan.capabilities.count,
  },
  declaredOverlays: [...canonicalizeDistOverlayDeclarations(declaredOverlays)],
  overlays: scan.overlays
    .filter((overlay) => overlay.present === true)
    .map((overlay) => ({
      target: overlay.target,
      destination: overlay.destination,
      digest: overlay.digest,
      count: overlay.count,
    }))
    .toSorted((left, right) =>
      left.destination < right.destination ? -1 : left.destination > right.destination ? 1 : 0,
    ),
  publishedPath: canonicalAbsolutePath(publishedPath),
})

const strictParseOptions = { errors: 'all', onExcessProperty: 'error' } as const
const MetadataJson = Schema.fromJsonString(OwnedCpAMountMetadata, { space: 2 })

/** Encode canonical, versioned metadata JSON with one trailing newline. */
export const encodeOwnedCpAMountMetadata = (metadata: OwnedCpAMountMetadata): string =>
  `${Schema.encodeSync(MetadataJson)(metadata)}\n`

/** Strict metadata identity or path mismatch. */
export class OwnedCpAMountMetadataError extends Schema.TaggedError<OwnedCpAMountMetadataError>()(
  'OwnedCpAMountMetadataError',
  {
    path: Schema.String,
    message: Schema.String,
  },
) {}

/** Atomically persist metadata under `repos/.mr/mounts`. */
export const writeOwnedCpAMountMetadata = ({
  workspaceRoot,
  metadata,
}: {
  workspaceRoot: string
  metadata: OwnedCpAMountMetadata
}): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = ownedCpAMountMetadataPath({ workspaceRoot, member: metadata.member })
    yield* fs.makeDirectory(NodePath.dirname(path), { recursive: true })
    yield* writeFileAtomic({
      path: EffectPath.unsafe.absoluteFile(path),
      content: encodeOwnedCpAMountMetadata(metadata),
    })
  })

/** Strictly read metadata, rejecting unknown fields and member/path mismatches. */
export const readOwnedCpAMountMetadata = ({
  workspaceRoot,
  member,
  publishedPath,
}: {
  workspaceRoot: string
  member: string
  publishedPath: string
}): Effect.Effect<
  OwnedCpAMountMetadata,
  PlatformError | Schema.SchemaError | OwnedCpAMountMetadataError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = ownedCpAMountMetadataPath({ workspaceRoot, member })
    const content = yield* fs.readFileString(path)
    const metadata = yield* Schema.decodeEffect(MetadataJson, strictParseOptions)(content)
    const expectedPublishedPath = canonicalAbsolutePath(publishedPath)
    if (metadata.member !== member || metadata.publishedPath !== expectedPublishedPath) {
      return yield* new OwnedCpAMountMetadataError({
        path,
        message: `Owned mount metadata identity mismatch for member '${member}' at '${path}'`,
      })
    }
    return metadata
  })

/** Typed refusal when a lifecycle identity recheck no longer names the authorized inode. */
export class OwnedCpAMountIdentityError extends Schema.TaggedError<OwnedCpAMountIdentityError>()(
  'OwnedCpAMountIdentityError',
  {
    path: Schema.String,
    message: Schema.String,
  },
) {}

/** Deterministic test seam immediately before the no-follow lifecycle recheck. */
export interface OwnedCpAMountIdentityCheckHooks {
  readonly beforeLstat?: (path: string) => Promise<void>
}

/**
 * Recheck an owned mount inode immediately under the caller's lifecycle lock.
 * A successful return authorizes only this exact `{dev, ino}` at this instant.
 */
export const assertOwnedCpAMountIdentity = ({
  path,
  expected,
  hooks,
}: {
  path: string
  expected: OwnedCpAMountIdentity
  hooks?: OwnedCpAMountIdentityCheckHooks
}): Effect.Effect<OwnedCpAMountIdentity, OwnedCpAMountIdentityError> =>
  Effect.gen(function* () {
    const absolutePath = NodePath.resolve(path)
    const beforeLstat = hooks?.beforeLstat
    if (beforeLstat !== undefined) {
      yield* Effect.tryPromise({
        try: () => beforeLstat(absolutePath),
        catch: () =>
          new OwnedCpAMountIdentityError({
            path: absolutePath,
            message: `Owned mount identity hook failed for '${absolutePath}'`,
          }),
      })
    }
    const info = yield* Effect.tryPromise({
      try: () => lstat(absolutePath),
      catch: () =>
        new OwnedCpAMountIdentityError({
          path: absolutePath,
          message: `Cannot lstat owned mount '${absolutePath}'`,
        }),
    })
    const actual = mountIdentity(info)
    if (info.isDirectory() === false || mountIdentityMatches({ actual, expected }) === false) {
      return yield* new OwnedCpAMountIdentityError({
        path: absolutePath,
        message: `Owned mount inode identity changed at '${absolutePath}'`,
      })
    }
    return actual
  })

/** Caller-supplied identity that metadata must match exactly. */
export interface OwnedCpAMountExpectedIdentity {
  readonly member: string
  readonly lockedCommit: string
  readonly sourcePathIdentity: string
  readonly publishedPath: string
}

/** Loud reasons a real directory failed owned-mount proof. */
export type InvalidOwnedCpAMountReason =
  | 'MetadataMissing'
  | 'MetadataInvalid'
  | 'IdentityMismatch'
  | 'MountInvalid'
  | 'MountIdentityMismatch'
  | 'ManifestMismatch'

/** S0 classification refined with metadata and fresh R6 proof. */
export type OwnedCpAMountInspection =
  | { readonly _tag: 'Missing' }
  | { readonly _tag: 'Symlink'; readonly target: string }
  | {
      readonly _tag: 'InvalidOwned'
      readonly reason: InvalidOwnedCpAMountReason
      readonly path: string
      readonly message: string
      readonly cause?: unknown
    }
  | {
      readonly _tag: 'Owned'
      readonly identity: OwnedCpAMountIdentity
      readonly metadata: OwnedCpAMountMetadata
      readonly scan: R6MountScan
    }

const invalidOwned = ({
  reason,
  path,
  message,
  cause,
}: {
  reason: InvalidOwnedCpAMountReason
  path: string
  message: string
  cause?: unknown
}): OwnedCpAMountInspection => ({
  _tag: 'InvalidOwned',
  reason,
  path,
  message,
  ...(cause === undefined ? {} : { cause }),
})

const isPlatformNotFound = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  '_tag' in error &&
  error._tag === 'PlatformError' &&
  'reason' in error &&
  typeof error.reason === 'object' &&
  error.reason !== null &&
  '_tag' in error.reason &&
  error.reason._tag === 'NotFound'

const scanIdentityMatches = ({
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

/**
 * Refine S0 for either the published path or a swapped-old staging path.
 * Metadata remains bound to `expected.publishedPath`; the independently supplied
 * physical path is authorized only when its pre-exchange inode and fresh R6
 * repository/capability identities all match.
 */
export const inspectOwnedCpAMount = ({
  workspaceRoot,
  physicalPath,
  expected,
  expectedPreExchangeIdentity,
}: {
  workspaceRoot: string
  physicalPath: string
  expected: OwnedCpAMountExpectedIdentity
  expectedPreExchangeIdentity: OwnedCpAMountIdentity
}): Effect.Effect<OwnedCpAMountInspection, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const absolutePhysicalPath = NodePath.resolve(physicalPath)
    const publishedPath = canonicalAbsolutePath(expected.publishedPath)
    const s0 = yield* inspectMemberMount(absolutePhysicalPath)
    if (s0._tag !== 'Foreign') return s0

    const metadataResult = yield* readOwnedCpAMountMetadata({
      workspaceRoot,
      member: expected.member,
      publishedPath,
    }).pipe(Effect.result)
    if (metadataResult._tag === 'Failure') {
      const cause = metadataResult.failure
      return invalidOwned({
        reason: isPlatformNotFound(cause) === true ? 'MetadataMissing' : 'MetadataInvalid',
        path: absolutePhysicalPath,
        message: `Cannot prove ownership of member '${expected.member}' at '${absolutePhysicalPath}': metadata is ${isPlatformNotFound(cause) === true ? 'missing' : 'invalid'}`,
        cause,
      })
    }
    const metadata = metadataResult.success
    if (
      metadata.member !== expected.member ||
      metadata.lockedCommit !== expected.lockedCommit ||
      metadata.sourcePathIdentity !== expected.sourcePathIdentity ||
      metadata.publishedPath !== publishedPath
    ) {
      return invalidOwned({
        reason: 'IdentityMismatch',
        path: absolutePhysicalPath,
        message: `Owned mount metadata does not match the expected identity for member '${expected.member}'`,
      })
    }

    const scanResult = yield* scanR6ProtectedMount({
      root: absolutePhysicalPath,
      declaredOverlays: metadata.declaredOverlays,
    }).pipe(Effect.result)
    if (scanResult._tag === 'Failure') {
      return invalidOwned({
        reason: 'MountInvalid',
        path: absolutePhysicalPath,
        message: `Owned mount R6 validation failed for member '${expected.member}'`,
        cause: scanResult.failure,
      })
    }
    const scan = scanResult.success
    if (
      mountIdentityMatches({
        actual: scan.identity,
        expected: expectedPreExchangeIdentity,
      }) === false
    ) {
      return invalidOwned({
        reason: 'MountIdentityMismatch',
        path: absolutePhysicalPath,
        message: `Owned mount inode does not match the pre-exchange identity for member '${expected.member}'`,
      })
    }
    if (scanIdentityMatches({ metadata, scan }) === false) {
      return invalidOwned({
        reason: 'ManifestMismatch',
        path: absolutePhysicalPath,
        message: `Owned mount content does not match bound R6 manifests for member '${expected.member}': expected repository ${metadata.repository.digest}/${metadata.repository.count}, capabilities ${metadata.capabilities.digest}/${metadata.capabilities.count}/${String(metadata.capabilities.present)}, overlays ${metadata.overlays.map((item) => `${item.destination}:${item.digest}/${item.count}`).join(',')}; observed repository ${scan.repository.digest}/${scan.repository.count}, capabilities ${scan.capabilities.digest}/${scan.capabilities.count}/${String(scan.capabilities.present)}, overlays ${scan.overlays
          .filter((item) => item.present)
          .map((item) => `${item.destination}:${item.digest}/${item.count}`)
          .join(',')}`,
      })
    }
    return { _tag: 'Owned' as const, identity: scan.identity, metadata, scan }
  })

/** Realpath-based opaque source identity for metadata binding. */
export const computeR6SourcePathIdentity = (
  sourcePath: string,
): Effect.Effect<string, R6ScanError> =>
  Effect.tryPromise({
    try: async () => {
      const canonical = await realpath(sourcePath)
      return `sha256:${createHash('sha256')
        .update(frame(Buffer.from('overeng.megarepo.r6-source-path', 'utf8')))
        .update(frame(Buffer.from(canonical, 'utf8')))
        .digest('hex')}`
    },
    catch: (cause) =>
      scanError({
        reason: 'IoFailure',
        path: sourcePath,
        message: `Failed to resolve R6 source identity for '${sourcePath}'`,
        cause,
      }),
  })
