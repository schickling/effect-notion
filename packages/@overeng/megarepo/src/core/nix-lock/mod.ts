/**
 * Nix Lock File Sync
 *
 * Synchronizes flake.lock and devenv.lock files in megarepo members
 * to match the commits tracked in megarepo.lock.
 *
 * This ensures all lock files stay in sync with megarepo as the single
 * source of truth for dependency versions.
 */

import { Effect, Option, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { type PlatformError } from 'effect/PlatformError'
import * as Command from 'effect/unstable/process/ChildProcess'
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner'

import { EffectPath, type AbsoluteDirPath, type AbsoluteFilePath } from '@overeng/effect-path'

import { findConfigPath, getMemberPath, type MegarepoConfig } from '../config.ts'
import {
  LOCK_FILE_NAME,
  readLockFile,
  type LockFile,
  type LockedMember,
  upsertLockedMember,
  writeLockFile,
} from '../lock.ts'
import * as Observability from '../observability.ts'
import {
  parseNixFlakeUrl,
  getRef,
  getRev,
  updateNixFlakeUrl,
  convertToGitHubScheme,
} from './flake-url.ts'
import {
  extractFlakeNixInputs,
  extractDevenvYamlInputs,
  extractLockFileInputs,
  matchUrlToMember,
} from './input-discovery.ts'
import { matchLockedInputToMember, needsRevUpdate, urlsMatch } from './matcher.ts'
import {
  updateLockedInputRev,
  convertLockedInputToGitHub,
  type NixFlakeMetadata,
} from './schema.ts'
import {
  rewriteFlakeNixUrls,
  rewriteDevenvYamlUrls,
  rewriteLockFileRefs,
  type SourceUrlUpdate,
} from './source-rewriter.ts'

// =============================================================================
// Types
// =============================================================================

/** A single rev or ref update within a lock sync file result */
export type NixLockSyncUpdate =
  | {
      readonly _tag: 'RevUpdate'
      readonly inputName: string
      readonly memberName: string
      readonly oldRev: string
      readonly newRev: string
    }
  | {
      readonly _tag: 'RefUpdate'
      readonly inputName: string
      readonly memberName: string
      readonly oldRef: string
      readonly newRef: string
    }
  | {
      readonly _tag: 'SchemeUpdate'
      readonly inputName: string
    }

/** Result of syncing a single Nix lock file */
export interface NixLockSyncFileResult {
  readonly path: AbsoluteFilePath
  readonly type: 'flake.lock' | 'devenv.lock' | 'megarepo.lock' | 'flake.nix' | 'devenv.yaml'
  readonly updatedInputs: ReadonlyArray<NixLockSyncUpdate>
}

/** Result of syncing all Nix lock files in a megarepo */
export interface NixLockSyncResult {
  /** Member repos that had lock files synced */
  readonly memberResults: ReadonlyArray<{
    /** Name of the megarepo member */
    readonly memberName: string
    /** Lock files synced in this member */
    readonly files: ReadonlyArray<NixLockSyncFileResult>
  }>
  /** Total number of inputs updated across all files */
  readonly totalUpdates: number
  /** Results from shared input source propagation (original-matching) */
  readonly sharedInputSourceResult?: SharedInputSourceResult
}

/** Options for syncing Nix lock files */
export interface NixLockSyncOptions {
  /** Path to the megarepo root */
  readonly megarepoRoot: AbsoluteDirPath
  /** Megarepo configuration */
  readonly config: MegarepoConfig
  /** Megarepo lock file with resolved commits */
  readonly lockFile: LockFile
  /** Members to exclude from sync (opt-out) */
  readonly excludeMembers?: ReadonlySet<string>
  /** Lock sync scope */
  readonly scope?: 'direct' | 'recursive'
  /** Members already identified as nested megarepos (used in recursive mode) */
  readonly recursiveMegarepoMembers?: ReadonlySet<string>
}

// =============================================================================
// Lock File Names
// =============================================================================

const FLAKE_LOCK = 'flake.lock'
const DEVENV_LOCK = 'devenv.lock'

const MEGAREPO_LOCK = LOCK_FILE_NAME

/** Schema for raw flake lock JSON (used to preserve key order during manipulation) */
const RawFlakeLockJson = Schema.fromJsonString(
  Schema.Struct({
    nodes: Schema.Record(
      Schema.String,
      Schema.mutableKey(Schema.Record(Schema.String, Schema.mutableKey(Schema.Unknown))),
    ),
    root: Schema.String,
    version: Schema.Finite,
  }),
  { space: 2 },
)

/**
 * Schema for an opaque JSON object (devenv.lock / flake.lock) whose nodes are
 * manipulated in place. Decodes any JSON object to a mutable record and encodes
 * with 2-space indentation, matching the prior `JSON.stringify(value, null, 2)`
 * output byte-for-byte.
 */
const RawLockJson = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.mutableKey(Schema.Unknown)),
  { space: 2 },
)

/** Encode a manipulated lock object back to its 2-space JSON file content (with trailing newline). */
const encodeRawLockJson = (value: Record<string, unknown>): string =>
  Schema.encodeSync(RawLockJson)(value) + '\n'

// =============================================================================
// Nix Metadata Fetching
// =============================================================================

/** Schema for nix flake prefetch JSON output (parses JSON string directly) */
const NixFlakePrefetchOutput = Schema.fromJsonString(
  Schema.Struct({
    hash: Schema.String,
    locked: Schema.Struct({
      lastModified: Schema.Finite,
      owner: Schema.optional(Schema.String),
      repo: Schema.optional(Schema.String),
      rev: Schema.String,
      type: Schema.String,
    }),
  }),
)

/** Error for Nix flake metadata fetch failures */
export class NixFlakeMetadataError extends Schema.TaggedError<NixFlakeMetadataError>()(
  'NixFlakeMetadataError',
  {
    message: Schema.String,
    flakeRef: Schema.String,
    rawOutput: Schema.String,
  },
) {}

/**
 * Fetch metadata (narHash, lastModified) for a GitHub flake input.
 *
 * Uses `nix flake prefetch` to get the correct hash and timestamp for the revision.
 */
export const fetchNixFlakeMetadata = ({
  owner,
  repo,
  rev,
}: {
  owner: string
  repo: string
  rev: string
}): Effect.Effect<
  NixFlakeMetadata,
  PlatformError | Schema.SchemaError | NixFlakeMetadataError,
  ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const flakeRef = `github:${owner}/${repo}/${rev}`

    const result = yield* ChildProcessSpawner.use((spawner) =>
      spawner.string(Command.make('nix', ['flake', 'prefetch', flakeRef, '--json'])),
    )

    // Check for empty output - this typically means the command failed.
    // Nix outputs errors to stderr and returns empty stdout with non-zero exit code.
    // Common causes: commit doesn't exist on GitHub (not pushed yet), repo inaccessible.
    const trimmedResult = result.trim()
    if (trimmedResult === '') {
      return yield* new NixFlakeMetadataError({
        message: `Nix returned empty output - the commit may not exist on GitHub (not pushed yet?) or the repository may be inaccessible`,
        flakeRef,
        rawOutput: result,
      })
    }

    // Attempt to parse the JSON output
    const parsed = yield* Schema.decodeEffect(NixFlakePrefetchOutput)(result).pipe(
      Effect.mapError((parseError) => {
        // Check if output looks like a nix error message (shouldn't normally happen
        // since nix errors go to stderr, but handle defensively)
        if (
          trimmedResult.startsWith('error:') === true ||
          trimmedResult.includes('error:') === true
        ) {
          return new NixFlakeMetadataError({
            message: `Nix command failed with error`,
            flakeRef,
            rawOutput: trimmedResult.slice(0, 500), // Truncate for readability
          })
        }
        // Otherwise return the parse error with context
        return parseError
      }),
    )

    return {
      narHash: parsed.hash,
      lastModified: parsed.locked.lastModified,
    }
  }).pipe(
    Observability.withNixFlakeMetadataSpan({
      owner,
      repo,
      rev,
    }),
  )

/**
 * Build a flake reference URL from locked input data.
 * Returns undefined if the locked input is not a type we can fetch metadata for.
 */
const getFlakeRefFromLocked = (
  locked: Record<string, unknown>,
): { owner: string; repo: string } | undefined => {
  const type = locked['type']

  if (type === 'github') {
    const owner = locked['owner']
    const repo = locked['repo']
    if (typeof owner === 'string' && typeof repo === 'string') {
      return { owner, repo }
    }
  }

  // For git type, try to extract owner/repo from GitHub URL
  if (type === 'git') {
    const url = locked['url']
    if (typeof url === 'string' && url.includes('github.com') === true) {
      const match = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/)
      if (match?.[1] !== undefined && match[2] !== undefined) {
        return { owner: match[1], repo: match[2] }
      }
    }
  }

  return undefined
}

// =============================================================================
// Single Lock File Sync
// =============================================================================

/**
 * Sync a single flake.lock or devenv.lock file
 *
 * For each input in the lock file:
 * 1. Try to match it to a megarepo member by URL
 * 2. If matched and rev differs, update to megarepo.lock commit
 * 3. Remove narHash and lastModified (they'd be invalid after rev change)
 */
/**
 * Update a node object in-place, preserving the original key order.
 * Returns a new object with the same key order but updated locked field.
 */
const updateNodePreservingOrder = ({
  node,
  newLocked,
}: {
  node: Record<string, unknown>
  newLocked: Record<string, unknown>
}): Record<string, unknown> => {
  const result: Record<string, unknown> = {}

  // Preserve original key order
  for (const key of Object.keys(node)) {
    if (key === 'locked') {
      result['locked'] = newLocked
    } else {
      result[key] = node[key]
    }
  }

  return result
}

/** Information collected about a node that needs updating */
interface NodeUpdateInfo {
  readonly nodeName: string
  readonly node: Record<string, unknown>
  readonly locked: Record<string, unknown>
  readonly memberName: string
  readonly oldRev: string
  readonly newRev: string
  readonly flakeRef: { owner: string; repo: string } | undefined
}

const syncSingleLockFile = ({
  lockPath,
  lockType,
  megarepoMembers,
}: {
  lockPath: AbsoluteFilePath
  lockType: 'flake.lock' | 'devenv.lock'
  megarepoMembers: Record<string, LockedMember>
}): Effect.Effect<
  NixLockSyncFileResult,
  PlatformError | Schema.SchemaError,
  FileSystem.FileSystem | ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    // Read and parse the lock file (Schema.parseJson handles both parsing and validation)
    const content = yield* fs.readFileString(lockPath)
    const rawJson = yield* Schema.decodeEffect(RawFlakeLockJson)(content)

    // First pass: collect all nodes that need metadata fetching
    const nodesToUpdate: NodeUpdateInfo[] = []

    for (const [nodeName, node] of Object.entries(rawJson.nodes)) {
      const locked = node['locked'] as Record<string, unknown> | undefined

      // Skip nodes without locked data (e.g., root node)
      if (locked === undefined) {
        continue
      }

      // Try to match this input to a megarepo member
      const match = matchLockedInputToMember({ locked, members: megarepoMembers })

      if (match !== undefined && needsRevUpdate({ locked, member: match.member }) === true) {
        // Found a match and rev differs - collect for update
        const oldRev = typeof locked['rev'] === 'string' ? locked['rev'] : 'unknown'
        const newRev = match.member.commit
        const flakeRef = getFlakeRefFromLocked(locked)

        nodesToUpdate.push({
          nodeName,
          node,
          locked,
          memberName: match.memberName,
          oldRev,
          newRev,
          flakeRef,
        })
      }
    }

    // Second pass: fetch all metadata in parallel (concurrency: 8)
    const metadataResults = yield* Effect.forEach(
      nodesToUpdate,
      (info) =>
        Effect.gen(function* () {
          if (info.flakeRef !== undefined) {
            const result = yield* fetchNixFlakeMetadata({
              owner: info.flakeRef.owner,
              repo: info.flakeRef.repo,
              rev: info.newRev,
            }).pipe(
              Effect.tapError((e) => {
                // Provide more specific error messages based on error type
                if (e._tag === 'NixFlakeMetadataError') {
                  return Effect.logWarning(
                    `Failed to fetch Nix metadata for ${info.flakeRef!.owner}/${info.flakeRef!.repo}@${info.newRev}: ${e.message}`,
                  )
                }
                return Effect.logWarning(
                  `Failed to fetch Nix metadata for ${info.flakeRef!.owner}/${info.flakeRef!.repo}@${info.newRev}: ${e}`,
                )
              }),
              Effect.option,
            )
            return { nodeName: info.nodeName, metadata: result }
          }
          return { nodeName: info.nodeName, metadata: { _tag: 'None' as const } }
        }),
      { concurrency: 8 },
    )

    // Build a map of nodeName -> metadata for quick lookup
    const metadataMap = new Map(metadataResults.map((r) => [r.nodeName, r.metadata]))

    // Third pass: apply the fetched metadata to update the lock file
    const updatedInputs: NixLockSyncUpdate[] = []

    for (const info of nodesToUpdate) {
      updatedInputs.push({
        _tag: 'RevUpdate',
        inputName: info.nodeName,
        memberName: info.memberName,
        oldRev: info.oldRev,
        newRev: info.newRev,
      })

      const metadataResult = metadataMap.get(info.nodeName)
      let newLocked: Record<string, unknown>

      if (metadataResult !== undefined && metadataResult._tag === 'Some') {
        // Use the fetched metadata
        newLocked = updateLockedInputRev({
          locked: info.locked,
          newRev: info.newRev,
          metadata: metadataResult.value,
        })
      } else if (info.flakeRef !== undefined) {
        // Fallback: update rev without metadata (will be incomplete)
        yield* Effect.logWarning(
          `Using incomplete lock entry for ${info.nodeName} (missing narHash/lastModified)`,
        )
        newLocked = updateLockedInputRev({ locked: info.locked, newRev: info.newRev })
      } else {
        // Non-GitHub input, can't fetch metadata
        newLocked = updateLockedInputRev({ locked: info.locked, newRev: info.newRev })
      }

      // Convert git+ssh/git+https GitHub URLs to github: scheme
      const convertedLocked = convertLockedInputToGitHub(newLocked)
      if (convertedLocked !== undefined) newLocked = convertedLocked

      // Also convert the original section if present
      let updatedNode = info.node
      const original = info.node['original'] as Record<string, unknown> | undefined
      if (original !== undefined) {
        const convertedOriginal = convertLockedInputToGitHub(original)
        if (convertedOriginal !== undefined) {
          updatedNode = { ...info.node, original: convertedOriginal }
        }
      }

      // Update node in-place, preserving key order
      rawJson.nodes[info.nodeName] = updateNodePreservingOrder({
        node: updatedNode,
        newLocked,
      })
    }

    // Fourth pass: normalize all remaining git GitHub nodes to github: scheme
    // (nodes not already updated in the third pass)
    const updatedNodeNames = new Set(nodesToUpdate.map((n) => n.nodeName))
    let schemeNormalized = false

    for (const [nodeName, node] of Object.entries(rawJson.nodes)) {
      if (updatedNodeNames.has(nodeName) === true) continue

      const locked = node['locked'] as Record<string, unknown> | undefined
      if (locked === undefined) continue

      const convertedLocked = convertLockedInputToGitHub(locked)
      const original = node['original'] as Record<string, unknown> | undefined
      const convertedOriginal =
        original !== undefined ? convertLockedInputToGitHub(original) : undefined

      if (convertedLocked !== undefined || convertedOriginal !== undefined) {
        const updatedNode = { ...node }
        if (convertedLocked !== undefined) updatedNode['locked'] = convertedLocked
        if (convertedOriginal !== undefined) updatedNode['original'] = convertedOriginal
        rawJson.nodes[nodeName] = updatedNode
        schemeNormalized = true
        updatedInputs.push({ _tag: 'SchemeUpdate', inputName: nodeName })
      }
    }

    // Write updated lock file if any changes were made
    if (updatedInputs.length > 0 || schemeNormalized === true) {
      const updatedContent = yield* Schema.encodeEffect(RawFlakeLockJson)(rawJson)
      yield* fs.writeFileString(lockPath, updatedContent + '\n')
    }

    return {
      path: lockPath,
      type: lockType,
      updatedInputs,
    }
  }).pipe(
    Observability.withNixLockFileSpan({
      lockPath,
      lockType,
    }),
  )

// =============================================================================
// Nested megarepo.lock Sync
// =============================================================================

const syncNestedMegarepoLockFile = ({
  lockPath,
  megarepoMembers,
}: {
  lockPath: AbsoluteFilePath
  megarepoMembers: Record<string, LockedMember>
}): Effect.Effect<
  NixLockSyncFileResult,
  PlatformError | Schema.SchemaError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const nestedLockOpt = yield* readLockFile(lockPath)
    if (Option.isNone(nestedLockOpt) === true) {
      return {
        path: lockPath,
        type: 'megarepo.lock',
        updatedInputs: [],
      } satisfies NixLockSyncFileResult
    }

    let nestedLock = nestedLockOpt.value
    const updatedInputs: NixLockSyncUpdate[] = []

    for (const [nestedMemberName, nestedMember] of Object.entries(nestedLock.members)) {
      if (nestedMember.pinned === true) {
        continue
      }

      const parentMatches = Object.entries(megarepoMembers).filter(([, parentMember]) => {
        return (
          urlsMatch({ url1: nestedMember.url, url2: parentMember.url }) &&
          parentMember.ref === nestedMember.ref
        )
      })
      if (parentMatches.length === 0) {
        continue
      }

      const [, firstParentMember] = parentMatches[0]!
      const hasConflictingParentCommit = parentMatches.some(([, parentMember]) => {
        return parentMember.commit !== firstParentMember.commit
      })
      if (hasConflictingParentCommit === true) {
        continue
      }

      if (nestedMember.commit === firstParentMember.commit) {
        continue
      }

      updatedInputs.push({
        _tag: 'RevUpdate',
        inputName: nestedMemberName,
        memberName: nestedMemberName,
        oldRev: nestedMember.commit,
        newRev: firstParentMember.commit,
      })

      nestedLock = upsertLockedMember({
        lockFile: nestedLock,
        memberName: nestedMemberName,
        update: {
          url: nestedMember.url,
          ref: nestedMember.ref,
          commit: firstParentMember.commit,
          pinned: nestedMember.pinned,
        },
      })
    }

    if (updatedInputs.length > 0) {
      yield* writeLockFile({ lockPath, lockFile: nestedLock })
    }

    return {
      path: lockPath,
      type: 'megarepo.lock',
      updatedInputs,
    } satisfies NixLockSyncFileResult
  }).pipe(
    Observability.withNixLockPathSpan({
      name: 'megarepo/nix-lock/nested',
      path: lockPath,
    }),
  )

// =============================================================================
// Source File Rev Sync
// =============================================================================

const FLAKE_NIX = 'flake.nix'
const DEVENV_YAML = 'devenv.yaml'

/**
 * Update `&rev=` / `?rev=` in a source file's input URLs to match megarepo.lock.
 *
 * For flake.nix: replaces `url = "OLD_URL"` with the updated URL.
 * For devenv.yaml: replaces `url: OLD_URL` lines with the updated URL.
 */
export const syncSourceFileRevs = ({
  filePath,
  fileType,
  megarepoMembers,
}: {
  filePath: AbsoluteFilePath
  fileType: 'flake.nix' | 'devenv.yaml'
  megarepoMembers: Record<string, LockedMember>
}): Effect.Effect<NixLockSyncFileResult, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    const content = yield* fs.readFileString(filePath)
    const inputs =
      fileType === 'flake.nix' ? extractFlakeNixInputs(content) : extractDevenvYamlInputs(content)

    const updatedInputs: NixLockSyncUpdate[] = []
    let updatedContent = content

    for (const input of inputs) {
      const memberName = matchUrlToMember({ url: input.url, members: megarepoMembers })
      if (memberName === undefined) continue

      const member = megarepoMembers[memberName]
      if (member === undefined) continue

      const parsed = parseNixFlakeUrl(input.url)
      if (parsed === undefined) continue

      const currentRev = getRev(parsed)
      if (currentRev === undefined) continue

      if (currentRev !== member.commit) {
        let newUrl = updateNixFlakeUrl({ url: input.url, updates: { rev: member.commit } })
        newUrl = convertToGitHubScheme(newUrl)

        updatedInputs.push({
          _tag: 'RevUpdate',
          inputName: input.inputName,
          memberName,
          oldRev: currentRev,
          newRev: member.commit,
        })

        updatedContent = updatedContent.replaceAll(input.url, newUrl)
      } else {
        // Rev is up to date — still normalize scheme to github: if needed
        const converted = convertToGitHubScheme(input.url)
        if (converted !== input.url) {
          updatedContent = updatedContent.replaceAll(input.url, converted)
          updatedInputs.push({ _tag: 'SchemeUpdate', inputName: input.inputName })
        }
      }
    }

    if (updatedContent !== content) {
      yield* fs.writeFileString(filePath, updatedContent)
    }

    return {
      path: filePath,
      type: fileType,
      updatedInputs,
    }
  }).pipe(
    Observability.withNixLockPathTypeSpan({
      name: 'megarepo/nix-lock/source-file',
      path: filePath,
      type: fileType,
    }),
  )

// =============================================================================
// Shared Lock Source Sync
// =============================================================================

/** Result of syncing shared inputs via original-matching */
export interface SharedInputSourceResult {
  readonly sourceMember: string
  readonly propagatableInputs: number
  readonly updatedMembers: ReadonlyArray<{
    readonly name: string
    readonly updatedInputs: ReadonlyArray<string>
  }>
}

// =============================================================================
// Shared Input Source Sync (original-matching)
// =============================================================================

/**
 * Deep structural equality check for JSON values.
 * Used to compare `original` fields in devenv.lock nodes.
 */
const deepEqual = ({ a, b }: { a: unknown; b: unknown }): boolean => {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  const aObj = a as Record<string, unknown>
  const bObj = b as Record<string, unknown>
  const aKeys = Object.keys(aObj)
  if (aKeys.length !== Object.keys(bObj).length) return false
  return aKeys.every((k) => deepEqual({ a: aObj[k], b: bObj[k] }))
}

/** Error for shared input source configuration issues */
export class SharedInputSourceError extends Schema.TaggedError<SharedInputSourceError>()(
  'SharedInputSourceError',
  {
    message: Schema.String,
    sourceMemberName: Schema.String,
  },
) {}

/**
 * Propagate top-level declared devenv.lock inputs from a source member to all others.
 *
 * Only considers inputs declared in `nodes[root].inputs` (not transitive dependencies).
 * For each such input that has both `original` and `locked` fields, finds matching
 * nodes in other members (same input name, structurally equal `original`) and copies
 * the `locked` section.
 */
/** Validated source inputs map — result of preflight validation, input to apply phase */
interface ValidatedSharedInputSource {
  readonly sourceMemberName: string
  readonly sourceMap: ReadonlyMap<string, { locked: unknown; original: unknown }>
}

/**
 * Preflight: validate the shared input source configuration and build the source map.
 * Runs before any lock-file writes so a bad config never causes partial mutations.
 */
const validateSharedInputSource = ({
  megarepoRoot,
  sourceMemberName,
}: {
  megarepoRoot: AbsoluteDirPath
  sourceMemberName: string
}): Effect.Effect<
  ValidatedSharedInputSource,
  PlatformError | SharedInputSourceError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    const sourceLockPath = EffectPath.ops.join(
      getMemberPath({ megarepoRoot, name: sourceMemberName }),
      EffectPath.unsafe.relativeFile(DEVENV_LOCK),
    )

    if ((yield* fs.exists(sourceLockPath)) === false) {
      return yield* new SharedInputSourceError({
        message: `Source member '${sourceMemberName}' has no devenv.lock`,
        sourceMemberName,
      })
    }

    const sourceContent = yield* fs.readFileString(sourceLockPath)
    const sourceJson = yield* Schema.decodeEffect(RawLockJson)(sourceContent).pipe(
      Effect.catchTag(
        'SchemaError',
        () =>
          new SharedInputSourceError({
            message: `Source member '${sourceMemberName}' has invalid devenv.lock (not valid JSON)`,
            sourceMemberName,
          }),
      ),
    )

    const sourceNodes = sourceJson['nodes'] as Record<string, Record<string, unknown>> | undefined
    if (sourceNodes === undefined) {
      return yield* new SharedInputSourceError({
        message: `Source member '${sourceMemberName}' devenv.lock has no nodes`,
        sourceMemberName,
      })
    }

    const rootNode = sourceNodes['root']
    if (rootNode === undefined) {
      return yield* new SharedInputSourceError({
        message: `Source member '${sourceMemberName}' devenv.lock has no root node`,
        sourceMemberName,
      })
    }

    const rootInputs = rootNode['inputs'] as Record<string, string> | undefined
    if (rootInputs === undefined) {
      return yield* new SharedInputSourceError({
        message: `Source member '${sourceMemberName}' devenv.lock root node has no inputs`,
        sourceMemberName,
      })
    }

    /** Build map of propagatable source nodes — only top-level declared inputs */
    const sourceMap = new Map<string, { locked: unknown; original: unknown }>()
    for (const [inputName, nodeName] of Object.entries(rootInputs)) {
      const node = sourceNodes[nodeName]
      if (node === undefined) continue
      if (node['original'] !== undefined && node['locked'] !== undefined) {
        sourceMap.set(inputName, { locked: node['locked'], original: node['original'] })
      }
    }

    return { sourceMemberName, sourceMap }
  }).pipe(
    Observability.withLabelSpan({
      name: 'megarepo/nix-lock/shared-input-source/validate',
      labelValue: 'validate',
    }),
  )

/**
 * Apply phase: propagate validated source inputs to all matching members.
 * Only called after validation succeeds and member-sync writes are complete.
 */
const applySharedInputSource = ({
  megarepoRoot,
  validated,
  memberNames,
  excludeMembers,
}: {
  megarepoRoot: AbsoluteDirPath
  validated: ValidatedSharedInputSource
  memberNames: ReadonlyArray<string>
  excludeMembers: ReadonlySet<string>
}): Effect.Effect<SharedInputSourceResult, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const { sourceMemberName, sourceMap } = validated
    const updatedMembers: Array<{ name: string; updatedInputs: string[] }> = []

    for (const memberName of memberNames) {
      if (memberName === sourceMemberName) continue
      if (excludeMembers.has(memberName) === true) continue

      const lockPath = EffectPath.ops.join(
        getMemberPath({ megarepoRoot, name: memberName }),
        EffectPath.unsafe.relativeFile(DEVENV_LOCK),
      )
      if ((yield* fs.exists(lockPath)) === false) continue

      const content = yield* fs.readFileString(lockPath)
      const parsedOpt = Schema.decodeOption(RawLockJson)(content)
      if (Option.isNone(parsedOpt) === true) continue
      const parsed = parsedOpt.value

      const targetNodes = parsed['nodes'] as Record<string, Record<string, unknown>> | undefined
      if (targetNodes === undefined) continue

      /** Only match against the target's top-level declared inputs */
      const targetRoot = targetNodes['root']
      if (targetRoot === undefined) continue
      const targetRootInputs = targetRoot['inputs'] as Record<string, string> | undefined
      if (targetRootInputs === undefined) continue

      const updatedInputs: string[] = []
      for (const [inputName, targetNodeName] of Object.entries(targetRootInputs)) {
        const targetNode = targetNodes[targetNodeName]
        if (targetNode === undefined) continue
        if (targetNode['original'] === undefined || targetNode['locked'] === undefined) continue

        const sourceEntry = sourceMap.get(inputName)
        if (sourceEntry === undefined) continue
        if (deepEqual({ a: sourceEntry.original, b: targetNode['original'] }) === false) continue
        if (deepEqual({ a: sourceEntry.locked, b: targetNode['locked'] }) === true) continue

        targetNode['locked'] = sourceEntry.locked
        updatedInputs.push(inputName)
      }

      if (updatedInputs.length > 0) {
        yield* fs.writeFileString(lockPath, encodeRawLockJson(parsed))
        updatedMembers.push({ name: memberName, updatedInputs })
      }
    }

    return {
      sourceMember: sourceMemberName,
      propagatableInputs: sourceMap.size,
      updatedMembers,
    }
  }).pipe(
    Observability.withLabelSpan({
      name: 'megarepo/nix-lock/shared-input-source/apply',
      labelValue: 'apply',
    }),
  )

// =============================================================================
// Ref Sync
// =============================================================================

/**
 * Sync branch refs in source and lock files for a single member.
 *
 * For each input that maps to a megarepo member, compares the current ref
 * in the file against the upstream member's ref from megarepo.lock.
 * Updates all 4 file types: flake.nix, devenv.yaml, flake.lock, devenv.lock.
 */
const syncMemberRefs = ({
  memberPath,
  megarepoMembers,
}: {
  memberPath: AbsoluteDirPath
  megarepoMembers: Record<string, LockedMember>
}): Effect.Effect<ReadonlyArray<NixLockSyncFileResult>, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const results: NixLockSyncFileResult[] = []

    /** Sync refs in a source file (flake.nix or devenv.yaml) */
    const syncSourceRefs = ({
      filename,
      fileType,
    }: {
      filename: string
      fileType: 'flake.nix' | 'devenv.yaml'
    }) =>
      Effect.gen(function* () {
        const filePath = EffectPath.ops.join(memberPath, EffectPath.unsafe.relativeFile(filename))
        const exists = yield* fs.exists(filePath)
        if (exists === false) return

        const content = yield* fs.readFileString(filePath)
        const inputs =
          fileType === 'flake.nix'
            ? extractFlakeNixInputs(content)
            : extractDevenvYamlInputs(content)

        const updates = new Map<string, SourceUrlUpdate>()
        const updatedInputDetails: NixLockSyncUpdate[] = []

        for (const input of inputs) {
          const memberName = matchUrlToMember({ url: input.url, members: megarepoMembers })
          if (memberName === undefined) continue

          const member = megarepoMembers[memberName]
          if (member === undefined) continue

          const parsed = parseNixFlakeUrl(input.url)
          if (parsed === undefined) continue

          const currentRef = getRef(parsed)
          /** Don't add a ref to URLs that have no ref (bare `github:owner/repo`) */
          if (currentRef === undefined) continue
          if (currentRef === member.ref) continue

          updates.set(input.inputName, { memberName, newRef: member.ref })
          updatedInputDetails.push({
            _tag: 'RefUpdate',
            inputName: input.inputName,
            memberName,
            oldRef: currentRef,
            newRef: member.ref,
          })
        }

        // Apply ref updates via rewriter (if any)
        let finalContent = content
        if (updates.size > 0) {
          const rewriter = fileType === 'flake.nix' ? rewriteFlakeNixUrls : rewriteDevenvYamlUrls
          const result = rewriter({ content, updates })
          finalContent = result.content
        }

        // Normalize all megarepo-matched URLs to github: scheme
        for (const input of inputs) {
          const currentUrl =
            updates.has(input.inputName) === true
              ? updateNixFlakeUrl({
                  url: input.url,
                  updates: { ref: updates.get(input.inputName)!.newRef },
                })
              : input.url
          const converted = convertToGitHubScheme(currentUrl)
          if (converted !== currentUrl) {
            finalContent = finalContent.replaceAll(currentUrl, converted)
          }
        }

        if (finalContent !== content) {
          yield* fs.writeFileString(filePath, finalContent)
          if (updatedInputDetails.length > 0) {
            results.push({
              path: filePath,
              type: fileType,
              updatedInputs: updatedInputDetails,
            })
          }
        }
      })

    /** Sync refs in a lock file (flake.lock or devenv.lock) */
    const syncLockRefs = ({
      filename,
      fileType,
    }: {
      filename: string
      fileType: 'flake.lock' | 'devenv.lock'
    }) =>
      Effect.gen(function* () {
        const filePath = EffectPath.ops.join(memberPath, EffectPath.unsafe.relativeFile(filename))
        const exists = yield* fs.exists(filePath)
        if (exists === false) return

        const content = yield* fs.readFileString(filePath)
        const inputs = extractLockFileInputs(content)

        const refUpdates = new Map<string, string>()
        const updatedInputDetails: NixLockSyncUpdate[] = []

        for (const input of inputs) {
          const memberName = matchUrlToMember({ url: input.url, members: megarepoMembers })
          if (memberName === undefined) continue

          const member = megarepoMembers[memberName]
          if (member === undefined) continue

          /** Check original.ref in the lock file node */
          const parsedOpt = Schema.decodeOption(RawLockJson)(content)
          if (Option.isNone(parsedOpt) === true) return
          const parsed = parsedOpt.value as { nodes?: Record<string, Record<string, unknown>> }

          const node = parsed.nodes?.[input.inputName]
          if (node === undefined) continue

          const original = node['original'] as Record<string, unknown> | undefined
          if (original === undefined) continue

          const currentRef = typeof original['ref'] === 'string' ? original['ref'] : undefined
          /** Don't add a ref to nodes that have no ref */
          if (currentRef === undefined) continue
          if (currentRef === member.ref) continue

          refUpdates.set(input.inputName, member.ref)
          updatedInputDetails.push({
            _tag: 'RefUpdate',
            inputName: input.inputName,
            memberName,
            oldRef: currentRef,
            newRef: member.ref,
          })
        }

        // Apply ref updates (if any)
        let currentContent = content
        if (refUpdates.size > 0) {
          const result = rewriteLockFileRefs({ content, refUpdates })
          if (result.updatedNodes.length > 0) {
            currentContent = result.content
          }
        }

        // Normalize all git GitHub nodes to github: scheme
        const lockJsonOpt = Schema.decodeOption(RawLockJson)(currentContent)
        if (Option.isNone(lockJsonOpt) === true) {
          if (currentContent !== content) {
            yield* fs.writeFileString(filePath, currentContent)
            results.push({ path: filePath, type: fileType, updatedInputs: updatedInputDetails })
          }
          return
        }
        const lockJson = lockJsonOpt.value as { nodes?: Record<string, Record<string, unknown>> }

        let schemeConverted = false
        if (lockJson.nodes !== undefined) {
          for (const node of Object.values(lockJson.nodes)) {
            const locked = node['locked'] as Record<string, unknown> | undefined
            if (locked !== undefined) {
              const converted = convertLockedInputToGitHub(locked)
              if (converted !== undefined) {
                node['locked'] = converted
                schemeConverted = true
              }
            }

            const original = node['original'] as Record<string, unknown> | undefined
            if (original !== undefined) {
              const converted = convertLockedInputToGitHub(original)
              if (converted !== undefined) {
                node['original'] = converted
                schemeConverted = true
              }
            }
          }
        }

        if (schemeConverted === true) {
          currentContent = encodeRawLockJson(lockJson)
        }

        if (currentContent !== content) {
          yield* fs.writeFileString(filePath, currentContent)
          if (updatedInputDetails.length > 0) {
            results.push({
              path: filePath,
              type: fileType,
              updatedInputs: updatedInputDetails,
            })
          }
        }
      })

    yield* syncSourceRefs({ filename: FLAKE_NIX, fileType: 'flake.nix' })
    yield* syncSourceRefs({ filename: DEVENV_YAML, fileType: 'devenv.yaml' })
    yield* syncLockRefs({ filename: FLAKE_LOCK, fileType: 'flake.lock' })
    yield* syncLockRefs({ filename: DEVENV_LOCK, fileType: 'devenv.lock' })

    return results
  }).pipe(
    Observability.withLabelSpan({ name: 'megarepo/nix-lock/ref-sync', labelValue: memberPath }),
  )

// =============================================================================
// Main Sync Function
// =============================================================================

/**
 * Sync all Nix lock files in megarepo members
 *
 * Scans each member for flake.lock and devenv.lock files,
 * and updates any inputs that match other megarepo members
 * to use the commits from megarepo.lock.
 */
export const syncNixLocks = Effect.fn('megarepo/nix-lock/sync')((options: NixLockSyncOptions) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const excludeMembers = options.excludeMembers ?? new Set()
    const scope = options.scope ?? 'direct'

    // Build a map of megarepo member URLs to their locked data
    const megarepoMembers = options.lockFile.members

    const memberNames = Object.keys(options.config.members).filter(
      (name) => !excludeMembers.has(name),
    )

    // Auto-detect nested megarepos by scanning for megarepo config if not explicitly provided
    const recursiveMegarepoMembers =
      options.recursiveMegarepoMembers ??
      (scope === 'recursive'
        ? yield* Effect.map(
            Effect.forEach(
              memberNames,
              (name) =>
                Effect.gen(function* () {
                  const memberPath = getMemberPath({
                    megarepoRoot: options.megarepoRoot,
                    name,
                  })
                  const nestedConfig = yield* findConfigPath(memberPath).pipe(
                    Effect.orElseSucceed(() => undefined),
                  )
                  return nestedConfig !== undefined ? name : undefined
                }),
              { concurrency: 'unbounded' },
            ),
            (results) => new Set(results.filter((n): n is string => n !== undefined)),
          )
        : new Set<string>())

    // Preflight: validate shared input source before any writes
    const sharedInputSource = options.config.lockSync?.sharedInputSource
    const validatedSharedInputSource =
      sharedInputSource !== undefined
        ? yield* validateSharedInputSource({
            megarepoRoot: options.megarepoRoot,
            sourceMemberName: sharedInputSource,
          })
        : undefined

    // Process all members in parallel
    const allMemberResults = yield* Effect.forEach(
      memberNames,
      (memberName) =>
        Effect.gen(function* () {
          const memberPath = getMemberPath({
            megarepoRoot: options.megarepoRoot,
            name: memberName,
          })

          const memberExists = yield* fs.exists(memberPath)
          if (memberExists === false) return undefined

          const files: NixLockSyncFileResult[] = []

          // Check for flake.lock
          const flakeLockPath = EffectPath.ops.join(
            memberPath,
            EffectPath.unsafe.relativeFile(FLAKE_LOCK),
          )
          const hasFlakeLock = yield* fs.exists(flakeLockPath)
          if (hasFlakeLock === true) {
            const result = yield* syncSingleLockFile({
              lockPath: flakeLockPath,
              lockType: 'flake.lock',
              megarepoMembers,
            }).pipe(
              Effect.catchTag('SchemaError', (e) =>
                Effect.gen(function* () {
                  yield* Effect.logWarning(`Failed to parse ${flakeLockPath}: ${e.message}`)
                  return {
                    path: flakeLockPath,
                    type: 'flake.lock' as const,
                    updatedInputs: [],
                  }
                }),
              ),
            )
            if (result.updatedInputs.length > 0) {
              files.push(result)
            }
          }

          // Check for devenv.lock
          const devenvLockPath = EffectPath.ops.join(
            memberPath,
            EffectPath.unsafe.relativeFile(DEVENV_LOCK),
          )
          const hasDevenvLock = yield* fs.exists(devenvLockPath)
          if (hasDevenvLock === true) {
            const result = yield* syncSingleLockFile({
              lockPath: devenvLockPath,
              lockType: 'devenv.lock',
              megarepoMembers,
            }).pipe(
              Effect.catchTag('SchemaError', (e) =>
                Effect.gen(function* () {
                  yield* Effect.logWarning(`Failed to parse ${devenvLockPath}: ${e.message}`)
                  return {
                    path: devenvLockPath,
                    type: 'devenv.lock' as const,
                    updatedInputs: [],
                  }
                }),
              ),
            )
            if (result.updatedInputs.length > 0) {
              files.push(result)
            }
          }

          if (
            scope === 'recursive' &&
            (recursiveMegarepoMembers?.has(memberName) ?? false) === true
          ) {
            const nestedMegarepoLockPath = EffectPath.ops.join(
              memberPath,
              EffectPath.unsafe.relativeFile(MEGAREPO_LOCK),
            )
            const hasNestedMegarepoLock = yield* fs.exists(nestedMegarepoLockPath)
            if (hasNestedMegarepoLock === true) {
              const result = yield* syncNestedMegarepoLockFile({
                lockPath: nestedMegarepoLockPath,
                megarepoMembers,
              }).pipe(
                Effect.catchTag('SchemaError', (e) =>
                  Effect.gen(function* () {
                    yield* Effect.logWarning(
                      `Failed to parse ${nestedMegarepoLockPath}: ${e.message}`,
                    )
                    return {
                      path: nestedMegarepoLockPath,
                      type: 'megarepo.lock' as const,
                      updatedInputs: [],
                    } satisfies NixLockSyncFileResult
                  }),
                ),
              )
              if (result.updatedInputs.length > 0) {
                files.push(result)
              }
            }
          }

          // Check for flake.nix (source file rev sync)
          const flakeNixPath = EffectPath.ops.join(
            memberPath,
            EffectPath.unsafe.relativeFile(FLAKE_NIX),
          )
          const hasFlakeNix = yield* fs.exists(flakeNixPath)
          if (hasFlakeNix === true) {
            const result = yield* syncSourceFileRevs({
              filePath: flakeNixPath,
              fileType: 'flake.nix',
              megarepoMembers,
            })
            if (result.updatedInputs.length > 0) {
              files.push(result)
            }
          }

          // Check for devenv.yaml (source file rev sync)
          const devenvYamlPath = EffectPath.ops.join(
            memberPath,
            EffectPath.unsafe.relativeFile(DEVENV_YAML),
          )
          const hasDevenvYaml = yield* fs.exists(devenvYamlPath)
          if (hasDevenvYaml === true) {
            const result = yield* syncSourceFileRevs({
              filePath: devenvYamlPath,
              fileType: 'devenv.yaml',
              megarepoMembers,
            })
            if (result.updatedInputs.length > 0) {
              files.push(result)
            }
          }

          // Ref sync: update branch refs in all 4 file types
          const refSyncResults = yield* syncMemberRefs({
            memberPath,
            megarepoMembers,
          })
          files.push(...refSyncResults)

          if (files.length > 0) {
            return { memberName, files }
          }
          return undefined
        }),
      { concurrency: 8 },
    )

    const memberResults = allMemberResults.filter(
      (r): r is NonNullable<typeof r> => r !== undefined,
    )
    const totalUpdates = memberResults.reduce(
      (sum, mr) => sum + mr.files.reduce((s, f) => s + f.updatedInputs.length, 0),
      0,
    )

    // Apply shared input source propagation (validation already passed above)
    const sharedInputSourceResult =
      validatedSharedInputSource !== undefined
        ? yield* applySharedInputSource({
            megarepoRoot: options.megarepoRoot,
            validated: validatedSharedInputSource,
            memberNames,
            excludeMembers,
          })
        : undefined

    return {
      memberResults,
      totalUpdates,
      ...(sharedInputSourceResult !== undefined ? { sharedInputSourceResult } : {}),
    } satisfies NixLockSyncResult
  }),
)

// =============================================================================
// Re-exports
// =============================================================================

export {
  FlakeLock,
  FlakeLockNode,
  updateLockedInputRev,
  convertLockedInputToGitHub,
  parseLockedInput,
  type NixFlakeMetadata,
} from './schema.ts'
export {
  matchLockedInputToMember,
  needsRevUpdate,
  normalizeGitHubUrl,
  normalizeGitUrl,
  urlsMatch,
} from './matcher.ts'
export {
  type NixFlakeUrl,
  parseNixFlakeUrl,
  serializeNixFlakeUrl,
  updateNixFlakeUrl,
  getOwnerRepo,
  getRef,
  getRev,
  getDir,
  toGitHubScheme,
  convertToGitHubScheme,
} from './flake-url.ts'
export {
  type DiscoveredInput,
  type MemberDependencies,
  type DependencyGraph,
  extractFlakeNixInputs,
  extractDevenvYamlInputs,
  extractLockFileInputs,
  matchUrlToMember,
  discoverMemberInputs,
  buildDependencyGraph,
} from './input-discovery.ts'
export {
  type SourceUrlUpdate,
  rewriteFlakeNixUrls,
  rewriteDevenvYamlUrls,
  rewriteLockFileRefs,
} from './source-rewriter.ts'
