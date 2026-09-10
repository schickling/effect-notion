/**
 * Input Discovery — extract Nix flake input URLs from source and lock files
 *
 * Scans flake.nix, devenv.yaml, flake.lock, and devenv.lock to discover
 * which megarepo members are referenced as inputs by other members.
 */

import { Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { type PlatformError } from 'effect/PlatformError'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import { getMemberPath, type MegarepoConfig } from '../config.ts'
import type { LockFile, LockedMember } from '../lock.ts'
import { type NixFlakeUrl, getOwnerRepo, parseNixFlakeUrl } from './flake-url.ts'
import { parseLockedInput } from './schema.ts'

// =============================================================================
// Types
// =============================================================================

/** A discovered input reference from a source or lock file */
export interface DiscoveredInput {
  /** Name of the input (e.g. "effect-utils", "playwright") */
  readonly inputName: string
  /** Which file this was found in */
  readonly file: 'flake.nix' | 'devenv.yaml' | 'flake.lock' | 'devenv.lock'
  /** The megarepo member this input maps to */
  readonly upstreamMember: string
  /** The raw URL string as found in the file */
  readonly currentUrl: string
  /** Parsed URL (undefined if parsing failed) */
  readonly parsedUrl: NixFlakeUrl | undefined
}

/** Per-member dependency information */
export interface MemberDependencies {
  /** The downstream member name */
  readonly memberName: string
  /** All discovered inputs for this member */
  readonly inputs: ReadonlyArray<DiscoveredInput>
}

/** Full dependency graph across all members */
export type DependencyGraph = ReadonlyMap<string, MemberDependencies>

// =============================================================================
// Source file URL extraction
// =============================================================================

/**
 * Extract `inputs.<name>.url = "..."` from a flake.nix file.
 *
 * Uses line-by-line regex matching — not a full Nix parser, but sufficient
 * for the standard `inputs.foo.url = "..."` declaration pattern.
 */
export const extractFlakeNixInputs = (
  content: string,
): ReadonlyArray<{ inputName: string; url: string }> => {
  const results: Array<{ inputName: string; url: string }> = []

  // Match both forms:
  // 1. inputs.NAME.url = "URL";  (top-level declaration)
  // 2. NAME.url = "URL";         (inside inputs = { ... } block)
  const pattern = /(?:inputs\.)?([a-zA-Z0-9_-]+)\.url\s*=\s*"([^"]+)"/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(content)) !== null) {
    const inputName = match[1]!
    const url = match[2]!
    // Filter out false positives — URL must look like a Nix flake URL
    if (
      url.startsWith('github:') === true ||
      url.startsWith('git+https://') === true ||
      url.startsWith('git+ssh://') === true ||
      url.startsWith('https://') === true ||
      url.startsWith('path:') === true
    ) {
      results.push({ inputName, url })
    }
  }

  return results
}

/**
 * Extract input URLs from a devenv.yaml file.
 *
 * devenv.yaml format:
 * ```yaml
 * inputs:
 *   effect-utils:
 *     url: github:owner/repo/ref
 *     flake: true
 * ```
 *
 * Uses line-by-line parsing — not a full YAML parser, but works for
 * the flat structure used in devenv.yaml input declarations.
 */
export const extractDevenvYamlInputs = (
  content: string,
): ReadonlyArray<{ inputName: string; url: string }> => {
  const results: Array<{ inputName: string; url: string }> = []
  const lines = content.split('\n')

  let inInputs = false
  let currentInputName: string | undefined = undefined
  let inputsIndent = -1

  for (const line of lines) {
    const trimmed = line.trimStart()
    const indent = line.length - trimmed.length

    // Detect top-level `inputs:` key
    if (trimmed === 'inputs:') {
      inInputs = true
      inputsIndent = indent
      currentInputName = undefined
      continue
    }

    if (inInputs === false) continue

    // If we hit a line at the same or lower indent as `inputs:`, we've left the section
    if (trimmed !== '' && indent <= inputsIndent && trimmed.startsWith('#') === false) {
      inInputs = false
      currentInputName = undefined
      continue
    }

    // Detect input name (one level deeper than inputs:)
    // e.g. "  effect-utils:" at indent = inputsIndent + 2
    const inputNameMatch = trimmed.match(/^([a-zA-Z0-9_-]+):$/)
    if (inputNameMatch !== null && indent > inputsIndent) {
      currentInputName = inputNameMatch[1]!
      continue
    }

    // Detect url: value under current input name
    if (currentInputName !== undefined) {
      const urlMatch = trimmed.match(/^url:\s*(.+)$/)
      if (urlMatch !== null) {
        const url = urlMatch[1]!.trim()
        // Strip optional YAML quotes
        const cleanUrl =
          url.startsWith('"') === true && url.endsWith('"') === true
            ? url.slice(1, -1)
            : url.startsWith("'") === true && url.endsWith("'") === true
              ? url.slice(1, -1)
              : url
        results.push({ inputName: currentInputName, url: cleanUrl })
      }
    }
  }

  return results
}

/**
 * Extract input URLs from a flake.lock or devenv.lock file (JSON).
 *
 * Each node's `original` field contains the input as-specified.
 * We return the locked data for matching, and original for URL context.
 */
export const extractLockFileInputs = (
  content: string,
): ReadonlyArray<{ inputName: string; url: string; locked: Record<string, unknown> }> => {
  const results: Array<{ inputName: string; url: string; locked: Record<string, unknown> }> = []

  let parsed: { root?: string; nodes?: Record<string, Record<string, unknown>> }
  try {
    parsed = JSON.parse(content) as {
      root?: string
      nodes?: Record<string, Record<string, unknown>>
    }
  } catch {
    return results
  }

  if (parsed.nodes === undefined) return results

  const rootNodeName = parsed.root ?? 'root'
  const rootNode = parsed.nodes[rootNodeName]
  if (rootNode === undefined) return results

  const rootInputs = rootNode['inputs'] as Record<string, string> | undefined
  if (rootInputs === undefined) return results

  for (const [inputName, nodeName] of Object.entries(rootInputs)) {
    const node = parsed.nodes[nodeName]
    if (node === undefined) continue

    const locked = node['locked'] as Record<string, unknown> | undefined
    if (locked === undefined) continue

    const parsedInput = parseLockedInput(locked)
    if (parsedInput === undefined) continue

    let url: string
    if (
      parsedInput.type === 'github' &&
      parsedInput.owner !== undefined &&
      parsedInput.repo !== undefined
    ) {
      url = `github:${parsedInput.owner}/${parsedInput.repo}`
    } else if (parsedInput.type === 'git' && parsedInput.url !== undefined) {
      url = parsedInput.url
    } else {
      continue
    }

    results.push({ inputName, url, locked })
  }

  return results
}

// =============================================================================
// Member URL matching
// =============================================================================

/**
 * Normalize a megarepo member URL to (owner, repo) for comparison.
 *
 * megarepo.lock URLs are like: https://github.com/owner/repo
 */
const normalizeMemberUrl = (url: string): { owner: string; repo: string } | undefined => {
  const match = url.match(/github\.com\/([^/]+)\/([^/.]+)/)
  if (match?.[1] !== undefined && match[2] !== undefined) {
    return { owner: match[1].toLowerCase(), repo: match[2].toLowerCase() }
  }
  return undefined
}

/**
 * Match a Nix flake URL to a megarepo member by (owner, repo).
 */
export const matchUrlToMember = ({
  url,
  members,
}: {
  url: string
  members: Record<string, LockedMember>
}): string | undefined => {
  const parsed = parseNixFlakeUrl(url)
  if (parsed === undefined) return undefined

  const { owner, repo } = getOwnerRepo(parsed)
  const normalizedOwner = owner.toLowerCase()
  const normalizedRepo = repo.toLowerCase()

  for (const [memberName, member] of Object.entries(members)) {
    const memberNorm = normalizeMemberUrl(member.url)
    if (memberNorm === undefined) continue

    if (memberNorm.owner === normalizedOwner && memberNorm.repo === normalizedRepo) {
      return memberName
    }
  }

  return undefined
}

/**
 * Match a lock file input (from locked field) to a megarepo member.
 * Uses the existing matcher logic from schema.ts for lock file entries.
 */
const matchLockedToMember = ({
  locked,
  members,
}: {
  locked: Record<string, unknown>
  members: Record<string, LockedMember>
}): string | undefined => {
  const parsedInput = parseLockedInput(locked)
  if (parsedInput === undefined) return undefined

  let url: string | undefined
  if (
    parsedInput.type === 'github' &&
    parsedInput.owner !== undefined &&
    parsedInput.repo !== undefined
  ) {
    url = `https://github.com/${parsedInput.owner}/${parsedInput.repo}`
  } else if (parsedInput.type === 'git' && parsedInput.url !== undefined) {
    url = parsedInput.url
  }

  if (url === undefined) return undefined

  const norm = normalizeMemberUrl(url)
  if (norm === undefined) return undefined

  for (const [memberName, member] of Object.entries(members)) {
    const memberNorm = normalizeMemberUrl(member.url)
    if (memberNorm === undefined) continue
    if (memberNorm.owner === norm.owner && memberNorm.repo === norm.repo) {
      return memberName
    }
  }

  return undefined
}

// =============================================================================
// Full Discovery
// =============================================================================

/**
 * Discover all input dependencies for a single member.
 *
 * Scans flake.nix, devenv.yaml, flake.lock, and devenv.lock in the member directory.
 */
export const discoverMemberInputs = ({
  memberPath,
  members,
}: {
  memberPath: AbsoluteDirPath
  members: Record<string, LockedMember>
}): Effect.Effect<ReadonlyArray<DiscoveredInput>, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const results: DiscoveredInput[] = []

    // Helper to read file if it exists
    const readIfExists = (filename: string) =>
      Effect.gen(function* () {
        const path = EffectPath.ops.join(memberPath, EffectPath.unsafe.relativeFile(filename))
        const exists = yield* fs.exists(path)
        if (exists === false) return undefined
        return yield* fs.readFileString(path)
      })

    // Scan flake.nix
    const flakeNixContent = yield* readIfExists('flake.nix')
    if (flakeNixContent !== undefined) {
      for (const input of extractFlakeNixInputs(flakeNixContent)) {
        const memberName = matchUrlToMember({ url: input.url, members })
        if (memberName !== undefined) {
          results.push({
            inputName: input.inputName,
            file: 'flake.nix',
            upstreamMember: memberName,
            currentUrl: input.url,
            parsedUrl: parseNixFlakeUrl(input.url),
          })
        }
      }
    }

    // Scan devenv.yaml
    const devenvYamlContent = yield* readIfExists('devenv.yaml')
    if (devenvYamlContent !== undefined) {
      for (const input of extractDevenvYamlInputs(devenvYamlContent)) {
        const memberName = matchUrlToMember({ url: input.url, members })
        if (memberName !== undefined) {
          results.push({
            inputName: input.inputName,
            file: 'devenv.yaml',
            upstreamMember: memberName,
            currentUrl: input.url,
            parsedUrl: parseNixFlakeUrl(input.url),
          })
        }
      }
    }

    // Scan flake.lock
    const flakeLockContent = yield* readIfExists('flake.lock')
    if (flakeLockContent !== undefined) {
      for (const input of extractLockFileInputs(flakeLockContent)) {
        const memberName = matchLockedToMember({ locked: input.locked, members })
        if (memberName !== undefined) {
          results.push({
            inputName: input.inputName,
            file: 'flake.lock',
            upstreamMember: memberName,
            currentUrl: input.url,
            parsedUrl: parseNixFlakeUrl(input.url),
          })
        }
      }
    }

    // Scan devenv.lock
    const devenvLockContent = yield* readIfExists('devenv.lock')
    if (devenvLockContent !== undefined) {
      for (const input of extractLockFileInputs(devenvLockContent)) {
        const memberName = matchLockedToMember({ locked: input.locked, members })
        if (memberName !== undefined) {
          results.push({
            inputName: input.inputName,
            file: 'devenv.lock',
            upstreamMember: memberName,
            currentUrl: input.url,
            parsedUrl: parseNixFlakeUrl(input.url),
          })
        }
      }
    }

    return results
  })

/**
 * Build the full dependency graph across all megarepo members.
 */
export const buildDependencyGraph = ({
  megarepoRoot,
  config,
  lockFile,
  excludeMembers,
}: {
  megarepoRoot: AbsoluteDirPath
  config: MegarepoConfig
  lockFile: LockFile
  excludeMembers?: ReadonlySet<string>
}): Effect.Effect<DependencyGraph, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const exclude = excludeMembers ?? new Set()
    const members = lockFile.members

    const memberNames = Object.keys(config.members).filter((name) => !exclude.has(name))

    const results = yield* Effect.forEach(
      memberNames,
      (memberName) =>
        Effect.gen(function* () {
          const memberPath = getMemberPath({ megarepoRoot, name: memberName })
          const exists = yield* fs.exists(memberPath)
          if (exists === false) return { memberName, inputs: [] as DiscoveredInput[] }

          const inputs = yield* discoverMemberInputs({ memberPath, members })
          return { memberName, inputs: [...inputs] }
        }),
      { concurrency: 8 },
    )

    const graph = new Map<string, MemberDependencies>()
    for (const result of results) {
      if (result.inputs.length > 0) {
        graph.set(result.memberName, result)
      }
    }

    return graph
  })
