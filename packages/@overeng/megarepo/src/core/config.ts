/**
 * Megarepo configuration schema and types
 *
 * A megarepo uses a `megarepo.kdl` (or `megarepo.json`) config file that declares:
 * - Members: repos to include (via unified source string format)
 * - Generators: optional config file generators (vscode)
 * - Lock sync: automatic syncing of flake.lock/devenv.lock files
 *
 * Source string format:
 * - GitHub shorthand: "owner/repo" or "owner/repo#ref"
 * - HTTPS URL: "https://github.com/owner/repo" or "https://github.com/owner/repo#ref"
 * - SSH URL: "git@github.com:owner/repo" or "git@github.com:owner/repo#ref"
 * - Local path: "./path", "../path", "/absolute/path"
 */

import { Effect, Option, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'

import {
  EffectPath,
  type AbsoluteDirPath,
  type AbsoluteFilePath,
  type RelativeDirPath,
} from '@overeng/effect-path'
import { parseKdl } from '@overeng/kdl-effect'

import { parseSourceRef } from './ref.ts'

// =============================================================================
// Path Type Re-exports
// =============================================================================

// Re-export commonly used path types for convenience
export type {
  AbsoluteDirPath,
  AbsoluteFilePath,
  RelativeDirPath,
  RelativeFilePath,
} from '@overeng/effect-path'
export { EffectPath }

// =============================================================================
// Generator Configuration
// =============================================================================

/**
 * VSCode workspace generator configuration
 *
 * Design: Option B - Typed shortcuts + settings escape hatch
 *
 * Tradeoffs:
 * - `color`: Convenient typed shorthand for the common "branded workspace" pattern.
 *   Auto-generates titleBar, activityBar, and statusBar colors with sensible foregrounds.
 * - `settings`: Raw passthrough for any VSCode workspace settings. No type-safety,
 *   but provides an escape hatch for edge cases and new VSCode features we haven't typed yet.
 *
 * Alternatives considered:
 * - Option A (settings only): Simpler but verbose for common color theming use case
 * - Option C (fully typed): Better DX but high maintenance, would lag behind VSCode
 * - Option D (transform fn): Maximum flexibility but only works in .genie.ts, not JSON
 */
export class VscodeGeneratorConfig extends Schema.Class<VscodeGeneratorConfig>(
  'VscodeGeneratorConfig',
)({
  /** Enable/disable the generator (default: false) */
  enabled: Schema.optional(Schema.Boolean),
  /** Members to exclude from workspace */
  exclude: Schema.optional(Schema.Array(Schema.String)),
  /**
   * Primary accent color for the workspace (hex format, e.g. "#372d8e").
   * Auto-generates titleBar, activityBar, and statusBar background colors
   * with white foreground for contrast.
   *
   * Note: Prefer using `colorEnvVar` to keep megarepo.json stable across worktrees.
   */
  color: Schema.optional(Schema.String),
  /**
   * Environment variable name to read the workspace color from at generation time.
   * This allows per-worktree colors without changing megarepo.json.
   *
   * Example: Set `colorEnvVar: "MEGAREPO_COLOR"` in config, then in the shell:
   *   export MEGAREPO_COLOR="#372d8e"
   *
   * Takes precedence over the `color` field if both are set.
   */
  colorEnvVar: Schema.optional(Schema.String),
  /**
   * Raw VSCode workspace settings passthrough.
   * Merged with (and overrides) auto-generated settings.
   * Use this for any settings not covered by typed shortcuts above.
   *
   * @example { "editor.formatOnSave": true }
   */
  settings: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

const CompositionMemberKey = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u))
const IgnoredCompositionMembers = Schema.Array(Schema.String)

/** Buck2 composition-root generator configuration. */
export class CompositionGeneratorConfig extends Schema.Class<CompositionGeneratorConfig>(
  'CompositionGeneratorConfig',
)({
  /** Enable/disable publication (default: false). */
  enabled: Schema.optional(Schema.Boolean),
  /** Member key whose manifest cell provides the shared execution platform. */
  platformHub: CompositionMemberKey,
  /** Reference-only legacy members excluded completely from the Buck graph. */
  ignoredMembers: Schema.optional(IgnoredCompositionMembers),
  /** Fleet-stable Buck output isolation directory (default: megarepo). */
  isolationDir: Schema.optional(
    Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)),
  ),
  /** Admit Darwin mount advance only after a verified login-session invalidation probe. */
  allowVerifiedDarwinAdvance: Schema.optional(Schema.Boolean),
}) {}

/**
 * Configuration for syncing flake.lock and devenv.lock files
 *
 * When enabled, megarepo updates `rev` fields in member repos'
 * flake.lock and devenv.lock files to match commits in megarepo.lock.
 * With `mr apply --all`, it also reconciles nested megarepo.lock files.
 * This keeps all lock files in sync with megarepo as the source of truth.
 *
 * Lock sync is **auto-detected** by default: if `devenv.lock` or `flake.lock`
 * exists in the megarepo root, syncing is enabled automatically.
 * Set `enabled: false` to opt-out.
 */
export class LockSyncConfig extends Schema.Class<LockSyncConfig>('LockSyncConfig')({
  /**
   * Enable/disable lock sync.
   * Default: auto-detected (enabled if devenv.lock or flake.lock exists in megarepo root)
   * Set to false to opt-out of automatic lock file synchronization
   */
  enabled: Schema.optional(Schema.Boolean),
  /**
   * Members to exclude from lock sync
   * These members' lock files will not be modified
   */
  exclude: Schema.optional(Schema.Array(Schema.String)),
  /**
   * Propagate all matching devenv.lock inputs from a source member to all others.
   * Only considers top-level declared inputs (from root.inputs). Matches by input
   * name and structurally equal `original` field, then copies the `locked` section.
   * This keeps shared inputs (nixpkgs, devenv, git-hooks, etc.) in sync across
   * members without manual enumeration.
   */
  sharedInputSource: Schema.optional(Schema.String),
}) {}

/** All generator configurations */
export class GeneratorsConfig extends Schema.Class<GeneratorsConfig>('GeneratorsConfig')({
  vscode: Schema.optional(VscodeGeneratorConfig),
  composition: Schema.optional(CompositionGeneratorConfig),
}) {}

// =============================================================================
// Megarepo Configuration
// =============================================================================

/**
 * Main megarepo configuration schema
 *
 * Members use unified source string format:
 * - "owner/repo" - GitHub shorthand, default branch
 * - "owner/repo#ref" - GitHub shorthand, specific ref
 * - "https://..." - HTTPS URL
 * - "git@host:path" - SSH URL
 * - "./path", "../path", "/path" - Local path
 */
export class MegarepoConfig extends Schema.Class<MegarepoConfig>('MegarepoConfig')({
  /** JSON Schema reference (optional, for editor support) */
  $schema: Schema.optional(Schema.String),

  /** Members: repos to include in this megarepo (name -> source string) */
  members: Schema.Record(Schema.String, Schema.String),

  /** Generators: optional config file generation */
  generators: Schema.optional(GeneratorsConfig),

  /**
   * Lock sync configuration for flake.lock and devenv.lock files.
   * Auto-detected by default: enabled if devenv.lock or flake.lock exists in megarepo root.
   */
  lockSync: Schema.optional(LockSyncConfig),
}) {}

// =============================================================================
// Constants
// =============================================================================

/** Config file name (JSON format) */
export const CONFIG_FILE_NAME_JSON = 'megarepo.json'

/** Config file name (KDL format) */
export const CONFIG_FILE_NAME_KDL = 'megarepo.kdl'

/** Supported config file names, ordered by preference (KDL preferred) */
export const CONFIG_FILE_NAMES = [CONFIG_FILE_NAME_KDL, CONFIG_FILE_NAME_JSON] as const

/** Config format discriminator */
export type ConfigFormat = 'kdl' | 'json'

/** Schema: KDL string ↔ MegarepoConfig (analogous to Schema.parseJson) */
const MegarepoConfigFromKdl = parseKdl(MegarepoConfig)

/** Default store location */
export const DEFAULT_STORE_PATH = '~/.megarepo'

/** Directory holding member symlinks/materialized repos in a megarepo */
export const MEMBER_ROOT_DIR = 'repos'

/** Environment variable names */
export const ENV_VARS = {
  /** Global store location */
  STORE: 'MEGAREPO_STORE',
} as const

// =============================================================================
// Path Helpers
// =============================================================================

/** Get the members root directory within a megarepo */
export const getMembersRoot = (megarepoRoot: AbsoluteDirPath): AbsoluteDirPath =>
  EffectPath.ops.join(megarepoRoot, EffectPath.unsafe.relativeDir(`${MEMBER_ROOT_DIR}/`))

/** Get the path to a member within a megarepo */
export const getMemberPath = ({
  megarepoRoot,
  name,
}: {
  megarepoRoot: AbsoluteDirPath
  name: string
}): AbsoluteDirPath =>
  EffectPath.ops.join(megarepoRoot, EffectPath.unsafe.relativeDir(`${MEMBER_ROOT_DIR}/${name}/`))

// =============================================================================
// Config Read/Write
// =============================================================================

/** Error when no megarepo config file is found */
export class ConfigNotFoundError extends Schema.TaggedError<ConfigNotFoundError>()(
  'ConfigNotFoundError',
  {
    megarepoRoot: Schema.String,
    message: Schema.String.pipe(
      Schema.withDecodingDefault(
        Effect.succeed('No megarepo config found (checked megarepo.kdl and megarepo.json)'),
      ),
      Schema.withConstructorDefault(
        Effect.succeed('No megarepo config found (checked megarepo.kdl and megarepo.json)'),
      ),
    ),
  },
) {}

/** Find the config file path in a directory (prefers .kdl over .json) */
export const findConfigPath = (dir: AbsoluteDirPath) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    for (const fileName of CONFIG_FILE_NAMES) {
      const p = EffectPath.ops.join(dir, EffectPath.unsafe.relativeFile(fileName))
      if ((yield* fs.exists(p)) === true) return p
    }
    return undefined
  })

/**
 * Decode a config that is not on disk, such as a blob read out of a bare repository at one commit.
 */
export const decodeMegarepoConfigContent = ({
  content,
  format,
}: {
  readonly content: string
  readonly format: ConfigFormat
}) =>
  Schema.decodeEffect(
    format === 'kdl' ? MegarepoConfigFromKdl : Schema.fromJsonString(MegarepoConfig),
  )(content)

/**
 * Read megarepo config from a workspace root.
 * Checks for megarepo.kdl first, falls back to megarepo.json.
 */
export const readMegarepoConfig = (megarepoRoot: AbsoluteDirPath) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    for (const fileName of CONFIG_FILE_NAMES) {
      const configPath = EffectPath.ops.join(megarepoRoot, EffectPath.unsafe.relativeFile(fileName))

      const exists = yield* fs.exists(configPath)
      if (exists === false) continue

      const content = yield* fs.readFileString(configPath)
      const format: ConfigFormat = fileName.endsWith('.kdl') === true ? 'kdl' : 'json'

      const config = yield* Schema.decodeEffect(
        format === 'kdl' ? MegarepoConfigFromKdl : Schema.fromJsonString(MegarepoConfig),
      )(content)

      return { config, format, path: configPath } as const
    }

    return yield* new ConfigNotFoundError({ megarepoRoot })
  })

/**
 * Write megarepo config to a file.
 * Writes in the format matching the file extension.
 */
export const writeMegarepoConfig = ({
  configPath,
  config,
}: {
  configPath: AbsoluteFilePath
  config: MegarepoConfig
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const format: ConfigFormat = configPath.endsWith('.kdl') === true ? 'kdl' : 'json'

    const content =
      format === 'kdl'
        ? yield* Schema.encodeEffect(MegarepoConfigFromKdl)(config)
        : (yield* Schema.encodeEffect(Schema.fromJsonString(MegarepoConfig, { space: 2 }))(
            config,
          )) + '\n'

    yield* fs.writeFileString(configPath, content)
  })

// =============================================================================
// JSON Schema Generation
// =============================================================================

/** Generate JSON Schema (draft 2020-12) from the Effect Schema, for editor support */
export const generateJsonSchema = (): Record<string, unknown> => {
  const doc = Schema.toJsonSchemaDocument(MegarepoConfig)
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    ...doc.schema,
    $defs: doc.definitions,
  }
}

// =============================================================================
// Member Name Validation
// =============================================================================

/** Check if a string contains control characters (0x00-0x1f) */
const hasControlCharacters = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code <= 0x1f) return true
  }
  return false
}

/**
 * Validate that a member name is safe to use as a directory name.
 * Prevents path traversal attacks and filesystem issues.
 */
export const isValidMemberName = (name: string): boolean => {
  // Must not be empty
  if (name.length === 0) return false

  // Must not contain path separators or traversal sequences
  if (name.includes('/') === true || name.includes('\\') === true) return false
  if (name === '.' || name === '..') return false
  if (name.includes('..') === true) return false

  // Must not start with a dot (hidden files) or hyphen (could be confused with flags)
  if (name.startsWith('.') === true || name.startsWith('-') === true) return false

  // Must not contain null bytes or other control characters
  if (hasControlCharacters(name) === true) return false

  return true
}

/**
 * Validate a member name and return an error message if invalid.
 */
export const validateMemberName = (name: string): string | undefined => {
  if (name.length === 0) return 'Member name cannot be empty'
  if (name.includes('/') === true || name.includes('\\') === true)
    return 'Member name cannot contain path separators'
  if (name === '.' || name === '..') return 'Member name cannot be . or ..'
  if (name.includes('..') === true) return 'Member name cannot contain ..'
  if (name.startsWith('.') === true) return 'Member name cannot start with a dot'
  if (name.startsWith('-') === true) return 'Member name cannot start with a hyphen'
  if (hasControlCharacters(name) === true) return 'Member name cannot contain control characters'
  return undefined
}

// =============================================================================
// Source Parsing
// =============================================================================

/** Parsed member source with optional ref */
export type MemberSource =
  | {
      readonly type: 'github'
      readonly owner: string
      readonly repo: string
      readonly ref: Option.Option<string>
    }
  | {
      readonly type: 'url'
      readonly url: string
      readonly ref: Option.Option<string>
    }
  | { readonly type: 'path'; readonly path: string }

/** Result of parsing a source string */
export interface ParsedMemberSource {
  readonly source: MemberSource
  readonly ref: Option.Option<string>
}

/**
 * Check if a string looks like a GitHub shorthand (owner/repo)
 * Must have exactly one slash with non-empty segments, and not start with protocol or path indicators
 */
const isGitHubShorthand = (s: string): boolean => {
  // Not a URL (no protocol)
  if (s.includes('://') === true || s.startsWith('git@') === true) return false
  // Not a path
  if (
    s.startsWith('./') === true ||
    s.startsWith('../') === true ||
    s.startsWith('/') === true ||
    s.startsWith('~') === true
  )
    return false
  // Has exactly one slash with content on both sides
  const parts = s.split('/')
  return parts.length === 2 && parts[0]!.length > 0 && parts[1]!.length > 0
}

/**
 * Check if a string is a local path
 */
const isLocalPath = (s: string): boolean => {
  return s.startsWith('./') || s.startsWith('../') || s.startsWith('/') || s.startsWith('~')
}

/**
 * Parse a source string into a MemberSource.
 * Handles:
 * - GitHub shorthand: "owner/repo" or "owner/repo#ref"
 * - HTTPS URL: "https://..." or "https://...#ref"
 * - SSH URL: "git@host:path" or "git@host:path#ref"
 * - Local path: "./...", "../...", "/...", "~..." (no #ref support)
 */
export const parseSourceString = (sourceString: string): MemberSource | undefined => {
  // Local paths don't support #ref syntax - the entire string is the path
  if (isLocalPath(sourceString) === true) {
    return { type: 'path', path: sourceString }
  }

  // For non-local sources, extract any #ref suffix
  const { source, ref } = parseSourceRef(sourceString)

  // GitHub shorthand: owner/repo
  if (isGitHubShorthand(source) === true) {
    const parts = source.split('/')
    const owner = parts[0]
    const repo = parts[1]
    if (
      parts.length === 2 &&
      owner !== undefined &&
      owner !== '' &&
      repo !== undefined &&
      repo !== ''
    ) {
      return { type: 'github', owner, repo, ref }
    }
    return undefined
  }

  // URL (HTTPS or SSH)
  if (source.includes('://') === true || source.startsWith('git@') === true) {
    return { type: 'url', url: source, ref }
  }

  return undefined
}

/**
 * Get the canonical URL for a member source (expands GitHub shorthand)
 */
export const getSourceUrl = (source: MemberSource): string | undefined => {
  switch (source.type) {
    case 'github':
      return `https://github.com/${source.owner}/${source.repo}`
    case 'url':
      return source.url
    case 'path':
      return undefined // Local paths don't have URLs
  }
}

/**
 * Get the store path for a member based on its source.
 * Returns a relative directory path from the store root.
 */
export const getStorePath = (source: MemberSource): RelativeDirPath => {
  switch (source.type) {
    case 'github':
      return EffectPath.unsafe.relativeDir(`github.com/${source.owner}/${source.repo}/`)
    case 'url':
      return parseUrlToStorePath(source.url)
    case 'path':
      return EffectPath.unsafe.relativeDir(
        `local/${source.path.split('/').findLast(Boolean) ?? 'unknown'}/`,
      )
  }
}

/**
 * Parse a git URL to a store path.
 * Returns a relative directory path from the store root.
 */
const parseUrlToStorePath = (url: string): RelativeDirPath => {
  // Handle SSH URLs: git@github.com:owner/repo.git
  const sshMatch = url.match(/^git@([^:]+):(.+?)(?:\.git)?$/)
  if (sshMatch?.[1] !== undefined && sshMatch[2] !== undefined) {
    return EffectPath.unsafe.relativeDir(`${sshMatch[1]}/${sshMatch[2]}/`)
  }

  // Handle HTTPS URLs: https://github.com/owner/repo.git
  const httpsMatch = url.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/)
  if (httpsMatch?.[1] !== undefined && httpsMatch[2] !== undefined) {
    return EffectPath.unsafe.relativeDir(`${httpsMatch[1]}/${httpsMatch[2]}/`)
  }

  // Fallback: use the URL hash or basename
  const basename = url.split('/').pop()?.replace('.git', '') ?? 'unknown'
  return EffectPath.unsafe.relativeDir(`other/${basename}/`)
}

/**
 * Get the ref from a member source (if specified)
 */
export const getSourceRef = (source: MemberSource): Option.Option<string> => {
  switch (source.type) {
    case 'github':
    case 'url':
      return source.ref
    case 'path':
      return Option.none()
  }
}

/**
 * Check if a source is a remote source (not a local path)
 */
export const isRemoteSource = (source: MemberSource): boolean => {
  return source.type !== 'path'
}

/**
 * Build a source string with a new ref.
 * Takes the base source (without ref) and appends the new ref.
 *
 * @example
 * buildSourceStringWithRef({ sourceString: 'owner/repo', newRef: 'main' }) // 'owner/repo#main'
 * buildSourceStringWithRef({ sourceString: 'owner/repo#old', newRef: 'new' }) // 'owner/repo#new'
 * buildSourceStringWithRef({ sourceString: 'https://github.com/o/r', newRef: 'v1.0' }) // 'https://github.com/o/r#v1.0'
 */
export const buildSourceStringWithRef = ({
  sourceString,
  newRef,
}: {
  sourceString: string
  newRef: string
}): string => {
  const { source } = parseSourceRef(sourceString)
  return `${source}#${newRef}`
}

/**
 * Get the base source string without any ref.
 *
 * @example
 * getBaseSourceString('owner/repo#main') // 'owner/repo'
 * getBaseSourceString('owner/repo') // 'owner/repo'
 */
export const getBaseSourceString = (sourceString: string): string => {
  const { source } = parseSourceRef(sourceString)
  return source
}
