import type { GenieValidationIssue, PackageInfo } from './validation/mod.ts'

/**
 * Filesystem capabilities a validator may need, injected via {@link GenieContext.io}.
 *
 * Keeping these on the context (rather than importing `node:fs` inside a builder/validator) is what lets the
 * builder modules — and therefore the `@overeng/genie` (`.`) entry — stay isomorphic: a typechecking consumer
 * that imports only the builders/types never resolves `node:*` into its program. The genie engine (which is
 * node) injects a real implementation during validation; it is `undefined` during `stringify` and whenever a
 * consumer has not opted into validation, so every validator must guard on `ctx.io === undefined`.
 */
export type GenieIO = {
  /** Whether a path exists on disk. */
  readonly fileExists: (path: string) => boolean
  /** Read a file as UTF-8 text, or `undefined` if it does not exist / cannot be read. */
  readonly readText: (path: string) => string | undefined
}

/** Config for the actionlint workflow validation capability (mirrors `githubWorkflow`'s `actionlint` option). */
export type GenieActionlintConfig = {
  /** Custom self-hosted runner labels (suppresses "unknown label" errors). */
  readonly selfHostedRunnerLabels?: readonly string[]
  /** Extra `-ignore` regex patterns passed to actionlint. */
  readonly ignorePatterns?: readonly string[]
}

/**
 * Actionlint capability injected via {@link GenieContext.actionlint}.
 *
 * The `githubWorkflow` validator shells out to the `actionlint` binary, which is irreducibly node-only
 * (`spawnSync`). Rather than statically importing the spawn runner into the pure builder (which would drag
 * `node:child_process` into the `.` entry's closure), the engine injects this runner during validation. The
 * pure builder calls it only when present, so a typechecking consumer never resolves the node implementation.
 */
export type GenieActionlintRunner = (args: {
  readonly yaml: string
  readonly location: string
  readonly config?: GenieActionlintConfig
}) => { readonly issues: GenieValidationIssue[]; readonly durationMs: number }

/**
 * JSONC parser capability injected via {@link GenieContext.parseJsonc}.
 *
 * Some validators read JSONC config files (e.g. tsconfig.json, which permits comments) and need a tolerant
 * parse. A TypeScript-backed parser is dependency territory (genie's runtime must be dependency-free, issue
 * #138), so the engine injects it; the pure validator calls it only when present and treats `undefined`
 * (absent capability or parse error) as "could not parse".
 */
export type GenieJsoncParser = (args: {
  readonly path: string
  readonly text: string
}) => unknown | undefined

/** Context passed to genie generator functions */
export type GenieContext = {
  /** Repo-relative path to the directory containing this genie file (e.g., 'packages/@overeng/utils') */
  location: string
  /** Absolute path to the working directory (repo root) */
  cwd: string
  /** All workspace packages — populated during validation, undefined during stringify */
  workspace?: {
    packages: PackageInfo[]
    byName: Map<string, PackageInfo>
  }
  /** Filesystem capabilities — injected by the engine during validation, undefined during stringify (GenieIO). */
  io?: GenieIO
  /** Actionlint runner — injected by the engine during validation, undefined during stringify (GenieActionlintRunner). */
  actionlint?: GenieActionlintRunner
  /** JSONC parser — injected by the engine during validation, undefined during stringify (GenieJsoncParser). */
  parseJsonc?: GenieJsoncParser
  /**
   * Optional domain-specific validation runtimes injected by the engine.
   *
   * The core runtime intentionally keeps this as an opaque registry so domain
   * packages own their validator contracts. For example, `package-json`
   * defines the shape of `validation.packageJson` without making Genie core a
   * JavaScript package/export validation framework.
   */
  validation?: Record<string, unknown>
}

/**
 * Enforces that T has no extra keys beyond what's defined in Base.
 * Used to catch typos and disallowed properties at compile time.
 */
export type Strict<T, TBase> = T & {
  [K in Exclude<keyof T, keyof TBase>]: never
}

/** Standard output shape returned by genie factory functions, containing structured data and a serializer. */
type GenieOutputBase<T> = {
  /** The structured configuration data */
  data: T
  /** Serialize the data to a string for file output */
  stringify: (ctx: GenieContext) => string
  /** Optional validation hook — runs during both generation and check */
  validate?: (ctx: GenieContext) => GenieValidationIssue[] | Promise<GenieValidationIssue[]>
}

/** Standard output shape for Genie generators, with canonical emitted `data` and optional non-emitted `meta`. */
export type GenieOutput<T, TMeta = never> = [TMeta] extends [never]
  ? GenieOutputBase<T>
  : GenieOutputBase<T> & { meta: TMeta }

/** Construct a `GenieOutput` while preserving metadata typing for composition. */
export function createGenieOutput<T>(args: GenieOutputBase<T>): GenieOutput<T>
export function createGenieOutput<T, TMeta>(
  args: GenieOutputBase<T> & { meta: TMeta },
): GenieOutput<T, TMeta>
export function createGenieOutput<T, TMeta>(
  args: GenieOutputBase<T> | (GenieOutputBase<T> & { meta: TMeta }),
): GenieOutput<T, TMeta> {
  return args as GenieOutput<T, TMeta>
}
