/**
 * Type-safe package.json generator
 *
 * Simple factories that return `GenieOutput<T>` for composability.
 * Dependency versions are managed externally via catalog imports.
 *
 * Reference: https://github.com/sindresorhus/type-fest/blob/main/source/package-json.d.ts
 */

import { createGenieOutput } from '../core.ts'
import type { GenieContext, GenieOutput, Strict } from '../core.ts'
import type { PnpmPackageClosureConfig } from '../pnpm-workspace/mod.ts'
import { projectPnpmPackageClosure } from '../pnpm-workspace/mod.ts'
import { relativeRepoPath, rootWorkspaceMemberPathsFromPackages } from '../workspace-graph.ts'
import { PackageJsonCompositionBrand, type PackageJsonComposition } from './catalog.ts'
import { matchesPattern, type ValidationIssue } from './validation.ts'
import {
  validatePackageRecompositionForPackage,
  validateWorkspaceMetadataPresenceForPackageJson,
  validateWorkspaceMetadataForPackageJson,
} from './validators/recompose.ts'

// Re-export catalog utilities (useful for defining version catalogs)
export { defineCatalog, CatalogConflictError, type Catalog, type CatalogInput } from './catalog.ts'

export {
  defineOverrides,
  definePatchedDependencies,
  prefixPatchPaths,
  OverrideConflictError,
  type OverridesInput,
  type ExtendedOverridesInput,
} from './overrides.ts'

/**
 * Field ordering for package.json (matches syncpack sortFirst convention).
 * Fields are sorted in this order, with unlisted fields appearing after.
 */
const FIELD_ORDER = [
  '$genie',
  'name',
  'version',
  'type',
  'sideEffects',
  'private',
  'description',
  'keywords',
  'homepage',
  'bugs',
  'license',
  'author',
  'contributors',
  'repository',
  'exports',
  'imports',
  'main',
  'module',
  'types',
  'typings',
  'bin',
  'files',
  'scripts',
  'dependencies',
  'dependenciesMeta',
  'devDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'optionalDependencies',
  'bundledDependencies',
  'engines',
  'os',
  'cpu',
  'publishConfig',
  'workspaces',
  'pnpm',
  'patchedDependencies',
  'resolutions',
] as const

/**
 * Export condition ordering for package.json exports (matches syncpack sortExports convention).
 */
const EXPORT_CONDITION_ORDER = [
  'types',
  'workerd',
  'browser',
  'worker',
  'node-addons',
  'node',
  'bun',
  'react-native',
  'import',
  'require',
  'development',
  'production',
  'default',
] as const

type Person =
  | string
  | {
      name: string
      email?: string
      url?: string
    }

type Bugs =
  | string
  | {
      url?: string
      email?: string
    }

type Repository =
  | string
  | {
      type: string
      url: string
      directory?: string
    }

type ExportsEntry =
  | string
  | Record<string, string>
  | {
      import?: string
      require?: string
      node?: string
      default?: string
      types?: string
      browser?: string
    }

/** Built-in JavaScript runtime/type environments for package export contracts. */
export type ExportEnvironmentName =
  | 'isomorphic-es2024'
  | 'node'
  | 'bun'
  | 'browser'
  | 'webworker'
  | 'workerd'
  | 'react-native'

/** How much type-level proof to run for a package export environment contract. */
export type ExportTypeProofMode = 'off' | 'strict'

/** JavaScript environment contract attached to one package export entry. */
export type ExportEnvironmentContract = {
  /** Named environment profile the export entry must conform to. */
  environment: ExportEnvironmentName | (string & {})
  /** Whether to prove the transitive type closure under the environment profile. */
  typeProof?: ExportTypeProofMode
  /** Source-only exports may be intentionally absent from publishConfig.exports. */
  published?: false
}

/** One or more JavaScript environment contracts attached to one package export entry. */
export type ExportEnvironmentContracts =
  | ExportEnvironmentContract
  | readonly ExportEnvironmentContract[]

type AuthoredExportEntry = ExportsEntry | ExportEntryContract

/** Authored package.json input: standard fields plus environment-contract-annotated `exports`. */
export type PackageJsonInputData = Omit<PackageJsonData, 'exports'> & {
  /** Package entry points, optionally annotated with non-emitted environment contracts. */
  exports?: Record<string, AuthoredExportEntry>
}

type PackageJsonComposedInputData = Omit<
  PackageJsonInputData,
  'dependencies' | 'devDependencies' | 'peerDependencies'
> & {
  dependencies?: never
  devDependencies?: never
  peerDependencies?: never
}

/** Non-emitted package.json validation metadata owned by the package-json generator. */
export type PackageJsonValidationMeta = {
  exportContracts?: Record<string, readonly ExportEnvironmentContract[]>
  validation?: PackageJsonValidationOptions
}

/** Whether package exports must be annotated with environment contracts. */
export type ExportEnvironmentContractCoverage = 'off' | 'warn' | 'error'

/** Package-json export environment contract validation policy. */
export type PackageJsonExportEnvironmentContractValidationOptions = {
  /** Suggest or require `exportEntry(...)` contracts for each package export. */
  coverage?: ExportEnvironmentContractCoverage
  /** Export subpaths to exclude while migrating, supporting `*` and `**` globs. */
  ignore?: readonly string[]
}

/** Package-json validation policy. */
export type PackageJsonValidationOptions = {
  exportEnvironmentContracts?: PackageJsonExportEnvironmentContractValidationOptions
}

/** Non-emitted package.json generator options. */
export type PackageJsonOptions = {
  validation?: PackageJsonValidationOptions
}

type PackageJsonGenerator = typeof createPackageJson & {
  aggregateFromPackages: typeof aggregatePackageJsonFromPackages
}

/** Package-json node validation runtime injected by the Genie engine. */
export type PackageJsonValidationRuntime = {
  validateExportEnvironments: (args: {
    cwd: string
    location: string
    packageName: string
    exports: Record<string, ExportsEntry>
    publishExports?: Record<string, ExportsEntry>
    contracts: Record<string, readonly ExportEnvironmentContract[]>
  }) => {
    issues: ValidationIssue[]
    durationMs: number
    cache?: { hits: number; misses: number }
  }
}

type ExportEntryContract = {
  target: ExportsEntry
  contract: ExportEnvironmentContracts
}

/** Annotate a package export target with a non-emitted JavaScript environment contract. */
// oxlint-disable-next-line overeng/named-args -- authoring DSL mirrors package.json's export target plus adjacent contract.
export const exportEntry = <const TTarget extends ExportsEntry>(
  target: TTarget,
  contract: ExportEnvironmentContracts,
): ExportEntryContract => ({ target, contract })

type Funding =
  | string
  | {
      type?: string
      url?: string
    }

/**
 * Patches registry type.
 * Keys are patch specifiers like `pkg@version`, values are repo-relative paths to patch files.
 *
 * @example
 * ```ts
 * const patches: PatchesRegistry = {
 *   'some-package@1.0.0': 'patches/some-package@1.0.0.patch',
 * }
 * ```
 */
export type PatchesRegistry = Record<string, string>

/**
 * Script value can be a string or a function that resolves at stringify time.
 * Functions receive the package location and return the script string.
 *
 * @example
 * ```ts
 * scripts: {
 *   build: 'tsc',  // static string
 *   postinstall: (location) => `patch -p1 < ${computePath(location)}/patches/foo.patch`,  // dynamic
 * }
 * ```
 */
export type ScriptValue = string | ((location: string) => string)

/** Package.json data structure */
export type PackageJsonData = {
  /** Package name */
  name?: string
  /** Package version (semver) */
  version?: string
  /** Short package description */
  description?: string
  /** Keywords for npm search */
  keywords?: readonly string[]
  /** Homepage URL */
  homepage?: string
  /** Bug tracker URL or configuration */
  bugs?: Bugs
  /** License identifier (SPDX) */
  license?: string
  /** Package author */
  author?: Person
  /** Package contributors */
  contributors?: Person[]
  /** Repository information */
  repository?: Repository
  /** Main entry point (CJS) */
  main?: string
  /** Module entry point (ESM) */
  module?: string
  /** TypeScript types definition file */
  types?: string
  /** TypeScript types definition file (legacy alias) */
  typings?: string
  /** Files to include when publishing */
  files?: string[]
  /** Package entry points (modern ESM exports) */
  exports?: Record<string, ExportsEntry>
  /** Node.js subpath imports (private path aliases, e.g. `#utils/*`) */
  imports?: Record<string, string>
  /** Package type: "module" for ESM, "commonjs" for CJS */
  type?: 'module' | 'commonjs'
  /** Binary executables */
  bin?: string | Record<string, string>
  /** Man pages */
  man?: string | string[]
  /** Directory structure */
  directories?: {
    lib?: string
    bin?: string
    man?: string
    doc?: string
    example?: string
    test?: string
  }
  /** npm scripts (values can be strings or functions resolved at stringify time) */
  scripts?: Record<string, ScriptValue>
  /** Package configuration values */
  config?: Record<string, unknown>
  /** Production dependencies */
  dependencies?: Record<string, string>
  /** Development dependencies */
  devDependencies?: Record<string, string>
  /** Peer dependencies */
  peerDependencies?: Record<string, string>
  /** Peer dependency metadata */
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  /** Dependency metadata (e.g. injected workspace deps for singleton resolution) */
  dependenciesMeta?: Record<string, { injected?: boolean }>
  /** Optional dependencies */
  optionalDependencies?: Record<string, string>
  /** Bundled dependencies */
  bundledDependencies?: string[]
  /** Engine requirements */
  engines?: {
    node?: string
    npm?: string
    pnpm?: string
    yarn?: string
  }
  /** Supported operating systems */
  os?: string[]
  /** Supported CPU architectures */
  cpu?: string[]
  /** Mark as private (prevents publishing) */
  private?: boolean
  /** Publishing configuration */
  publishConfig?: {
    access?: 'public' | 'restricted'
    registry?: string
    tag?: string
    /** Package entry points for published package (typically pointing to dist/) */
    exports?: Record<string, ExportsEntry>
    [key: string]: unknown
  }
  /** Tree-shaking side effects configuration */
  sideEffects?: boolean | string[]
  /** Browser field for bundlers */
  browser?: string | Record<string, string | false>
  /** Funding information */
  funding?: Funding | Funding[]
  /** Package manager for corepack */
  packageManager?: string
  /**
   * Bun patched dependencies (top-level).
   *
   * For pnpm, use `pnpm.patchedDependencies` instead.
   *
   * Paths can be:
   * - Local: `./patches/pkg.patch` (relative to this package)
   * - Repo-relative: `packages/@overeng/utils/patches/pkg.patch` (resolved at stringify time)
   */
  patchedDependencies?: Record<string, string>
  /**
   * pnpm-specific configuration.
   *
   * Use this field to configure pnpm-specific options like
   * `patchedDependencies`.
   *
   * In the current workspace model, the authoritative `pnpm-lock.yaml` lives
   * at the selected topology root rather than inside workspace member
   * packages.
   */
  pnpm?: {
    overrides?: Record<string, string>
    patchedDependencies?: Record<string, string>
    neverBuiltDependencies?: readonly string[]
  }
}

/** Stable workspace identity used during import-time package composition. */
export type WorkspaceIdentity = {
  repoName: string
  memberPath: string
  pnpmPackageClosure?: PnpmPackageClosureConfig
}

/** Static workspace-composition metadata stored in non-emitted generator meta. */
export type WorkspaceMetadata = WorkspaceIdentity & {
  deps: readonly WorkspacePackageLike[]
}

/** Emitted repository aggregate manifest shape. */
export type AggregatePackageJsonData = {
  name: string
  workspaces: readonly string[]
  private: true
  packageManager: string
}

/** Package-level metadata wrapper attached to generators that participate in workspace recomposition. */
export type WorkspaceMeta = {
  workspace: WorkspaceMetadata
}

/** Minimal shape needed to compose emitted package data with non-emitted workspace metadata. */
export type WorkspacePackageLike = {
  data: PackageJsonData
  meta: WorkspaceMeta
}

/** Workspace package whose emitted dependency identity is statically present. */
export type NamedWorkspacePackageLike<Name extends string = string> = WorkspacePackageLike & {
  data: PackageJsonData & { name: Name }
}

const projectWorkspaceClosureReference = (pkg: WorkspacePackageLike): NamedWorkspacePackageLike => {
  if (pkg.data.name === undefined) {
    throw new Error(
      'workspaceClosureReference requires every package in the closure to have a name',
    )
  }

  return {
    data: { name: pkg.data.name },
    meta: {
      workspace: {
        ...pkg.meta.workspace,
        deps: pkg.meta.workspace.deps.map(projectWorkspaceClosureReference),
      },
    },
  }
}

/**
 * Project a package into a workspace-closure reference.
 *
 * The reference keeps only the package name needed to emit the direct
 * workspace dependency plus the recursive workspace graph needed by
 * projections. Package behavior such as peer contracts and pnpm patch metadata
 * deliberately does not flow through this edge.
 */
export const workspaceClosureReference = <const Name extends string>(
  pkg: NamedWorkspacePackageLike<Name>,
): NamedWorkspacePackageLike<Name> => {
  const reference = projectWorkspaceClosureReference(pkg)
  return { ...reference, data: { name: pkg.data.name } }
}

/** Package.json genie output that carries workspace-composition metadata. */
export type WorkspacePackage = GenieOutput<PackageJsonData, WorkspaceMeta>

const isExportEntryContract = (entry: AuthoredExportEntry): entry is ExportEntryContract =>
  typeof entry === 'object' && entry !== null && 'target' in entry && 'contract' in entry

const normalizeExports = (
  exports: Record<string, AuthoredExportEntry> | undefined,
): {
  exports?: Record<string, ExportsEntry>
  contracts?: Record<string, readonly ExportEnvironmentContract[]>
} => {
  if (exports === undefined) return {}

  const normalized: Record<string, ExportsEntry> = {}
  const contracts: Record<string, readonly ExportEnvironmentContract[]> = {}

  for (const [exportPath, entry] of Object.entries(exports)) {
    if (isExportEntryContract(entry) === true) {
      normalized[exportPath] = entry.target
      contracts[exportPath] =
        Array.isArray(entry.contract) === true ? entry.contract : [entry.contract]
    } else {
      normalized[exportPath] = entry
    }
  }

  return {
    exports: normalized,
    ...(Object.keys(contracts).length === 0 ? {} : { contracts }),
  }
}

const packageJsonValidationRuntime = (
  ctx: GenieContext,
): PackageJsonValidationRuntime | undefined => {
  const runtime = ctx.validation?.packageJson
  if (runtime === undefined || typeof runtime !== 'object' || runtime === null) return undefined
  if (
    'validateExportEnvironments' in runtime &&
    typeof runtime.validateExportEnvironments === 'function'
  ) {
    return runtime as PackageJsonValidationRuntime
  }
  return undefined
}

const validateExportEnvironmentContracts = ({
  ctx,
  data,
  contracts,
  options,
}: {
  ctx: GenieContext
  data: PackageJsonData
  contracts: Record<string, readonly ExportEnvironmentContract[]> | undefined
  options: PackageJsonExportEnvironmentContractValidationOptions | undefined
}): ValidationIssue[] => {
  const packageName = data.name ?? '(anonymous package)'
  const issues: ValidationIssue[] = []
  const exportContracts = contracts ?? {}

  const coverage = options?.coverage ?? 'off'
  if (coverage !== 'off' && data.exports !== undefined) {
    for (const exportPath of Object.keys(data.exports)) {
      if (exportContracts[exportPath] !== undefined) continue
      if (
        options?.ignore?.some((pattern) => matchesPattern({ name: exportPath, pattern })) === true
      )
        continue

      issues.push({
        severity: coverage === 'warn' ? 'warning' : 'error',
        packageName,
        dependency: exportPath,
        message: `Package export "${exportPath}" has no export environment contract. Wrap the target with exportEntry(...), or add an explicit validation ignore while migrating.`,
        rule: 'package-json-export-environment-contract-coverage',
      })
    }
  }

  for (const exportPath of Object.keys(exportContracts)) {
    if (data.exports?.[exportPath] === undefined) {
      issues.push({
        severity: 'error',
        packageName,
        dependency: exportPath,
        message: `Export environment contract is declared for "${exportPath}", but package.json exports does not contain that subpath.`,
        rule: 'package-json-export-environment-contract-target',
      })
    }

    const requiresPublishMirror =
      exportContracts[exportPath]?.some((contract) => contract.published !== false) ?? true
    if (
      requiresPublishMirror === true &&
      data.publishConfig?.exports !== undefined &&
      data.publishConfig.exports[exportPath] === undefined
    ) {
      issues.push({
        severity: 'error',
        packageName,
        dependency: exportPath,
        message: `Export environment contract is declared for "${exportPath}", but publishConfig.exports does not contain the corresponding published subpath.`,
        rule: 'package-json-export-environment-publish-target',
      })
    }
  }

  const runtime = packageJsonValidationRuntime(ctx)
  if (
    runtime === undefined ||
    data.exports === undefined ||
    Object.keys(exportContracts).length === 0
  )
    return issues

  const result = runtime.validateExportEnvironments({
    cwd: ctx.cwd,
    location: ctx.location,
    packageName,
    exports: data.exports,
    ...(data.publishConfig?.exports === undefined
      ? {}
      : { publishExports: data.publishConfig.exports }),
    contracts: exportContracts,
  })

  issues.push(...result.issues)
  return issues
}

type PackageJsonMetadataInput<TMeta extends object = {}> = TMeta & {
  workspace?: never
  composition?: never
  [PackageJsonCompositionBrand]?: never
}

const isPackageJsonComposition = (meta: unknown): meta is PackageJsonComposition =>
  typeof meta === 'object' && meta !== null && PackageJsonCompositionBrand in meta

/**
 * Sort object keys according to a defined order.
 * Keys in the order array appear first (in that order), then remaining keys alphabetically.
 */
const sortObjectKeys = <T extends Record<string, unknown>>({
  obj,
  order,
}: {
  obj: T
  order: readonly string[]
}): T => {
  const orderSet = new Set(order)
  const orderedKeys = order.filter((key) => key in obj)
  const remainingKeys = Object.keys(obj)
    .filter((key) => !orderSet.has(key))
    .toSorted()
  const sortedKeys = [...orderedKeys, ...remainingKeys]
  return Object.fromEntries(sortedKeys.map((key) => [key, obj[key]])) as T
}

/** Sort export conditions within an exports entry. */
const sortExportConditions = (entry: ExportsEntry): ExportsEntry => {
  if (typeof entry === 'string') return entry
  return sortObjectKeys({ obj: entry, order: EXPORT_CONDITION_ORDER })
}

/** Sort exports object - sort conditions within each entry. */
const sortExports = (
  exports: Record<string, ExportsEntry> | undefined,
): Record<string, ExportsEntry> | undefined => {
  if (exports === undefined) return undefined

  const sorted: Record<string, ExportsEntry> = {}
  // Sort export paths: '.' first, then alphabetically
  const paths = Object.keys(exports).toSorted((a, b) => {
    if (a === '.') return -1
    if (b === '.') return 1
    return a.localeCompare(b)
  })

  for (const exportPath of paths) {
    sorted[exportPath] = sortExportConditions(exports[exportPath]!)
  }
  return sorted
}

/** Prefixes for internal dependencies that use absolute repo paths */
const INTERNAL_FILE_PREFIX = 'file:packages/'
const INTERNAL_REPO_FILE_PREFIX = 'file:repos/'
const INTERNAL_LINK_PREFIX = 'link:packages/'
const INTERNAL_REPO_LINK_PREFIX = 'link:repos/'

/**
 * Resolve dependency versions, converting internal repo-absolute paths to relative paths.
 * Handles package-local and cross-repo `file:` / `link:` prefixes.
 */
const resolveDeps = ({
  deps,
  currentLocation,
}: {
  deps: Record<string, string> | undefined
  currentLocation: string
}): Record<string, string> | undefined => {
  if (deps === undefined) return undefined

  const resolved: Record<string, string> = {}
  for (const [name, version] of Object.entries(deps).toSorted(([a], [b]) => a.localeCompare(b))) {
    if (
      version.startsWith(INTERNAL_FILE_PREFIX) === true ||
      version.startsWith(INTERNAL_REPO_FILE_PREFIX) === true
    ) {
      const targetLocation = version.slice('file:'.length)
      const relativePath = relativeRepoPath({
        from: currentLocation,
        to: targetLocation,
      })
      resolved[name] = `file:${relativePath}`
    } else if (
      version.startsWith(INTERNAL_LINK_PREFIX) === true ||
      version.startsWith(INTERNAL_REPO_LINK_PREFIX) === true
    ) {
      const targetLocation = version.slice('link:'.length)
      const relativePath = relativeRepoPath({
        from: currentLocation,
        to: targetLocation,
      })
      resolved[name] = `link:${relativePath}`
    } else {
      resolved[name] = version
    }
  }
  return resolved
}

/** Sort dependencies alphabetically (legacy, used when no resolution needed) */
const sortDeps = (deps: Record<string, string> | undefined): Record<string, string> | undefined => {
  if (deps === undefined) return undefined
  return Object.fromEntries(Object.entries(deps).toSorted(([a], [b]) => a.localeCompare(b)))
}

/**
 * Resolve patch paths, converting repo-relative paths to package-relative paths.
 *
 * Paths starting with `./` are kept as-is (already relative to current package).
 * Other paths are treated as repo-relative and converted to relative paths.
 *
 * @param patches - Patched dependencies object
 * @param currentLocation - Current package's repo-relative location
 */
const resolvePatchPaths = ({
  patches,
  currentLocation,
}: {
  patches: Record<string, string> | undefined
  currentLocation: string
}): Record<string, string> | undefined => {
  if (patches === undefined) return undefined

  const resolved: Record<string, string> = {}
  for (const [pkg, patchPath] of Object.entries(patches).toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (patchPath.startsWith('./') === true || patchPath.startsWith('../') === true) {
      // Already relative to current package
      resolved[pkg] = patchPath
    } else {
      // Repo-relative path - compute relative path from current location
      const relativePath = relativeRepoPath({
        from: currentLocation,
        to: patchPath,
      })
      resolved[pkg] = relativePath
    }
  }
  return resolved
}

/**
 * Resolve script values, calling functions with the current location.
 * @param scripts - Scripts object with string or function values
 * @param location - Current package's repo-relative location
 */
const resolveScripts = ({
  scripts,
  location,
}: {
  scripts: Record<string, ScriptValue> | undefined
  location: string
}): Record<string, string> | undefined => {
  if (scripts === undefined) return undefined

  const resolved: Record<string, string> = {}
  for (const [name, value] of Object.entries(scripts)) {
    resolved[name] = typeof value === 'function' ? value(location) : value
  }
  return resolved
}

/**
 * Build the final package.json object with sorting, resolution, and $genie marker.
 * @param data - Package data
 * @param location - Current package's repo-relative location (for resolving internal deps)
 * @param genieMarker - Structured $genie metadata object (defaults to `true` for backwards compat)
 */
const buildPackageJson = <T extends PackageJsonData>({
  data,
  location,
  genieMarker,
}: {
  data: T
  location: string
  genieMarker?: Record<string, unknown>
}): Record<string, unknown> => {
  const sorted = {
    ...data,
    ...(data.exports !== undefined && { exports: sortExports(data.exports) }),
    ...(data.dependencies !== undefined && {
      dependencies: resolveDeps({
        deps: data.dependencies,
        currentLocation: location,
      }),
    }),
    ...(data.devDependencies !== undefined && {
      devDependencies: resolveDeps({
        deps: data.devDependencies,
        currentLocation: location,
      }),
    }),
    ...(data.peerDependencies !== undefined && {
      peerDependencies: sortDeps(data.peerDependencies),
    }),
    ...(data.optionalDependencies !== undefined && {
      optionalDependencies: sortDeps(data.optionalDependencies),
    }),
    ...(data.patchedDependencies !== undefined && {
      patchedDependencies: resolvePatchPaths({
        patches: data.patchedDependencies,
        currentLocation: location,
      }),
    }),
    ...(data.pnpm !== undefined && {
      pnpm: {
        ...data.pnpm,
        ...(data.pnpm.patchedDependencies !== undefined && {
          patchedDependencies: resolvePatchPaths({
            patches: data.pnpm.patchedDependencies,
            currentLocation: location,
          }),
        }),
      },
    }),
    ...(data.scripts !== undefined && {
      scripts: resolveScripts({ scripts: data.scripts, location }),
    }),
  }

  return sortObjectKeys({
    obj: {
      $genie: genieMarker ?? true,
      ...sorted,
    },
    order: FIELD_ORDER,
  })
}

/**
 * Creates a package.json configuration for a workspace package.
 *
 * Returns a `GenieOutput` with the structured data accessible via `.data`
 * for composition with other genie files (e.g., peer dependency inheritance).
 *
 * @example
 * ```ts
 * import { packageJson } from '@overeng/genie'
 * import { catalog, privateDefaults } from '../../genie/shared.ts'
 *
 * export default packageJson({
 *   ...privateDefaults,
 *   name: '@myorg/utils',
 *   version: '1.0.0',
 *   dependencies: {
 *     effect: catalog.effect,
 *   },
 *   peerDependencies: {
 *     '@effect/platform': `^${catalog['@effect/platform']}`,
 *   },
 * })
 * ```
 *
 * @example Coupled dependency composition
 * ```ts
 * import utilsPkg from '../utils/package.json.genie.ts'
 * import { catalog, packageJson } from '@overeng/genie'
 *
 * const composition = catalog.compose({
 *   workspace: {
 *     repoName: 'my-repo',
 *     memberPath: 'packages/app',
 *   },
 *   dependencies: {
 *     workspace: [utilsPkg],
 *     external: catalog.pick('effect'),
 *   },
 *   mode: 'install',
 * })
 *
 * export default packageJson(
 *   {
 *     name: '@myorg/app',
 *   },
 *   composition,
 * )
 * ```
 */
function createPackageJson<const T extends PackageJsonInputData>(
  data: Strict<T, PackageJsonInputData>,
  meta: undefined,
  options: PackageJsonOptions,
): GenieOutput<PackageJsonData, PackageJsonValidationMeta>
function createPackageJson<const T extends PackageJsonInputData>(
  data: Strict<T, PackageJsonInputData>,
): GenieOutput<PackageJsonData, PackageJsonValidationMeta>
function createPackageJson<const T extends PackageJsonComposedInputData & { name: string }>(
  data: Strict<T, PackageJsonComposedInputData>,
  composition: PackageJsonComposition,
  options?: PackageJsonOptions,
): GenieOutput<PackageJsonData & { name: T['name'] }, WorkspaceMeta & PackageJsonValidationMeta>
function createPackageJson<const T extends PackageJsonComposedInputData>(
  data: Strict<T, PackageJsonComposedInputData>,
  composition: PackageJsonComposition,
  options?: PackageJsonOptions,
): GenieOutput<PackageJsonData, WorkspaceMeta & PackageJsonValidationMeta>
function createPackageJson<const T extends PackageJsonInputData, const TMeta extends object>(
  data: Strict<T, PackageJsonInputData>,
  meta: PackageJsonMetadataInput<TMeta>,
  options?: PackageJsonOptions,
): GenieOutput<PackageJsonData, TMeta & PackageJsonValidationMeta>
/**
 * Genie convention: the first arg is emitted data and the second arg is
 * non-emitted metadata.
 *
 * For package.json generators, workspace metadata must flow through the
 * branded composition object returned by `catalog.compose(...)` so emitted
 * dependencies and workspace closure stay coupled. Pass plain metadata only
 * for unrelated concerns.
 */
// oxlint-disable-next-line overeng/named-args
function createPackageJson<const T extends PackageJsonInputData, const TMeta>(
  data: Strict<T, PackageJsonInputData>,
  meta?: TMeta,
  options?: PackageJsonOptions,
) {
  const hasManualDepsWithComposition =
    isPackageJsonComposition(meta) === true &&
    (data.dependencies !== undefined ||
      data.devDependencies !== undefined ||
      data.peerDependencies !== undefined)
  const hasRawWorkspaceMetadata =
    isPackageJsonComposition(meta) === false &&
    meta !== undefined &&
    typeof meta === 'object' &&
    meta !== null &&
    'workspace' in meta &&
    typeof meta.workspace === 'object' &&
    meta.workspace !== null
  const hasWrappedComposition =
    isPackageJsonComposition(meta) === false &&
    meta !== undefined &&
    typeof meta === 'object' &&
    meta !== null &&
    'composition' in meta
  const composition = isPackageJsonComposition(meta) === true ? meta : undefined
  const normalizedExports = normalizeExports(data.exports)
  const normalizedInputData = {
    ...data,
    ...(normalizedExports.exports === undefined ? {} : { exports: normalizedExports.exports }),
  } satisfies PackageJsonData

  const effectiveData =
    composition !== undefined
      ? ({
          ...normalizedInputData,
          ...(Object.keys(composition.dependencies).length === 0
            ? {}
            : { dependencies: composition.dependencies }),
          ...(Object.keys(composition.devDependencies).length === 0
            ? {}
            : { devDependencies: composition.devDependencies }),
          ...(Object.keys(composition.peerDependencies).length === 0
            ? {}
            : { peerDependencies: composition.peerDependencies }),
        } satisfies PackageJsonData)
      : normalizedInputData

  const packageJsonValidationMeta =
    normalizedExports.contracts === undefined && options?.validation === undefined
      ? undefined
      : ({
          ...(normalizedExports.contracts === undefined
            ? {}
            : { exportContracts: normalizedExports.contracts }),
          ...(options?.validation === undefined ? {} : { validation: options.validation }),
        } satisfies PackageJsonValidationMeta)

  const effectiveMeta = (() => {
    const base =
      composition !== undefined
        ? ({ workspace: composition.workspace } satisfies WorkspaceMeta)
        : meta
    if (packageJsonValidationMeta === undefined) return base
    if (base !== undefined && typeof base === 'object' && base !== null) {
      return { ...base, ...packageJsonValidationMeta }
    }
    return packageJsonValidationMeta
  })()

  const effectiveWorkspaceMeta =
    effectiveMeta !== undefined &&
    typeof effectiveMeta === 'object' &&
    effectiveMeta !== null &&
    'workspace' in effectiveMeta &&
    typeof effectiveMeta.workspace === 'object' &&
    effectiveMeta.workspace !== null
      ? (effectiveMeta.workspace as WorkspaceMetadata)
      : undefined

  return createGenieOutput({
    data: effectiveData,
    stringify: (ctx: GenieContext) => {
      const genieMarker: Record<string, unknown> = {
        source: 'package.json.genie.ts',
        warning: 'DO NOT EDIT - changes will be overwritten',
      }

      /**
       * Embed the workspace closure so Nix can read it from the generated package.json
       * at eval time without import-from-derivation (IFD).
       * Future alternative: NixOS/nix#15380 (builtins.wasm) could compute this natively.
       */
      if (effectiveWorkspaceMeta !== undefined) {
        const closure = projectPnpmPackageClosure({
          pkg: { data: effectiveData, meta: { workspace: effectiveWorkspaceMeta } },
        })
        genieMarker.workspaceClosureDirs = closure.workspaceClosureDirs
      }

      return (
        JSON.stringify(
          buildPackageJson({ data: effectiveData, location: ctx.location, genieMarker }),
          null,
          2,
        ) + '\n'
      )
    },
    validate: (ctx: GenieContext) => [
      ...(effectiveData.name !== undefined
        ? validatePackageRecompositionForPackage({ ctx, pkgName: effectiveData.name })
        : []),
      ...(effectiveWorkspaceMeta === undefined
        ? validateWorkspaceMetadataPresenceForPackageJson({
            data: effectiveData,
          })
        : []),
      ...(effectiveWorkspaceMeta === undefined
        ? []
        : validateWorkspaceMetadataForPackageJson({
            data: effectiveData,
            metadata: effectiveWorkspaceMeta,
          })),
      ...validateExportEnvironmentContracts({
        ctx,
        data: effectiveData,
        contracts: packageJsonValidationMeta?.exportContracts,
        options: packageJsonValidationMeta?.validation?.exportEnvironmentContracts,
      }),
      ...(hasManualDepsWithComposition === true
        ? [
            {
              severity: 'error' as const,
              packageName: effectiveData.name ?? '(anonymous package)',
              dependency: '(composition)',
              message:
                'Do not define dependencies/devDependencies/peerDependencies in packageJson(data, composition). Put them into the composition so emitted deps and workspace metadata stay coupled.',
              rule: 'package-json-composition-coupling',
            },
          ]
        : []),
      ...(hasRawWorkspaceMetadata === true
        ? [
            {
              severity: 'error' as const,
              packageName: effectiveData.name ?? '(anonymous package)',
              dependency: '(workspace metadata)',
              message:
                'Do not pass workspace metadata directly to packageJson(...). Use packageJson(data, composition) so emitted dependencies and workspace closure come from one coupled source.',
              rule: 'package-json-workspace-composition-required',
            },
          ]
        : []),
      ...(hasWrappedComposition === true
        ? [
            {
              severity: 'error' as const,
              packageName: effectiveData.name ?? '(anonymous package)',
              dependency: '(composition)',
              message:
                'Do not wrap the composition object as { composition }. Pass packageJson(data, composition) so the authoring boundary stays crisp.',
              rule: 'package-json-wrapped-composition-disallowed',
            },
          ]
        : []),
    ],
    ...(effectiveMeta === undefined ? {} : { meta: effectiveMeta }),
  })
}

const mergeExportEnvironmentContractValidationOptions = ({
  defaults,
  overrides,
}: {
  defaults: PackageJsonExportEnvironmentContractValidationOptions | undefined
  overrides: PackageJsonExportEnvironmentContractValidationOptions | undefined
}): PackageJsonExportEnvironmentContractValidationOptions | undefined => {
  if (defaults === undefined) return overrides
  if (overrides === undefined) return defaults
  return {
    ...defaults,
    ...overrides,
  }
}

const mergePackageJsonValidationOptions = ({
  defaults,
  overrides,
}: {
  defaults: PackageJsonValidationOptions | undefined
  overrides: PackageJsonValidationOptions | undefined
}): PackageJsonValidationOptions | undefined => {
  if (defaults === undefined) return overrides
  if (overrides === undefined) return defaults

  const exportEnvironmentContracts = mergeExportEnvironmentContractValidationOptions({
    defaults: defaults.exportEnvironmentContracts,
    overrides: overrides.exportEnvironmentContracts,
  })

  return {
    ...defaults,
    ...overrides,
    ...(exportEnvironmentContracts === undefined ? {} : { exportEnvironmentContracts }),
  }
}

const mergePackageJsonOptions = ({
  defaults,
  overrides,
}: {
  defaults: PackageJsonOptions | undefined
  overrides: PackageJsonOptions | undefined
}): PackageJsonOptions | undefined => {
  if (defaults === undefined) return overrides
  if (overrides === undefined) return defaults

  const validation = mergePackageJsonValidationOptions({
    defaults: defaults.validation,
    overrides: overrides.validation,
  })

  return {
    ...defaults,
    ...overrides,
    ...(validation === undefined ? {} : { validation }),
  }
}

/**
 * Default package manager emitted for aggregate manifests.
 *
 * Aggregates are repository coordination files, not package-level authoring
 * surfaces, so this stays centralized instead of being repeated by callers.
 */
const DEFAULT_AGGREGATE_PACKAGE_MANAGER = 'pnpm@12.3.4'

/**
 * Project an aggregate manifest from package metadata for an explicit repo view.
 *
 * The aggregate manifest is not a runnable package and does not own
 * dependencies, scripts, exports, or publish settings. It exists only to
 * declare related workspace members. Constraining it prevents root-level
 * dependency and tooling creep, while actual package ownership remains with
 * real workspace packages.
 *
 * `extraMembers` allows adding non-genie-managed workspace member paths
 * (e.g. standalone examples) that cannot be derived from package metadata.
 */
const aggregatePackageJsonFromPackages = ({
  packages,
  name,
  repoName,
  extraMembers = [],
}: {
  packages: readonly WorkspacePackageLike[]
  name: string
  repoName: string
  extraMembers?: readonly string[]
}) => {
  const projectedMembers = rootWorkspaceMemberPathsFromPackages({ packages, repoName })
  const allMembers =
    extraMembers.length === 0
      ? projectedMembers
      : [...new Set([...projectedMembers, ...extraMembers])].toSorted((a, b) => a.localeCompare(b))

  const aggregate: AggregatePackageJsonData = {
    name,
    private: true,
    packageManager: DEFAULT_AGGREGATE_PACKAGE_MANAGER,
    workspaces: allMembers,
  }

  return createGenieOutput({
    data: aggregate,
    stringify: (ctx: GenieContext) =>
      JSON.stringify(
        buildPackageJson({
          data: aggregate,
          location: ctx.location,
          genieMarker: {
            source: 'package.json.genie.ts',
            warning: 'DO NOT EDIT - changes will be overwritten',
          },
        }),
        null,
        2,
      ) + '\n',
  })
}

/** Create a package manifest authoring API with repository-level defaults. */
export const definePackageJson = (defaults?: PackageJsonOptions): PackageJsonGenerator => {
  // oxlint-disable-next-line overeng/named-args -- returned function preserves the packageJson(data, meta, options) DSL.
  const configuredPackageJson = function configuredPackageJson(
    data: PackageJsonInputData,
    meta?: PackageJsonComposition | PackageJsonMetadataInput<object>,
    options?: PackageJsonOptions,
  ) {
    const effectiveOptions = mergePackageJsonOptions({
      defaults,
      overrides: options,
    })
    if (meta === undefined) {
      return effectiveOptions === undefined
        ? createPackageJson(data)
        : createPackageJson(data, undefined, effectiveOptions)
    }
    return createPackageJson(data, meta as PackageJsonMetadataInput<object>, effectiveOptions)
  } as unknown as typeof createPackageJson

  return Object.assign(configuredPackageJson, {
    aggregateFromPackages: aggregatePackageJsonFromPackages,
  })
}

/** Package manifest authoring API plus constrained aggregate projection. */
export const packageJson = definePackageJson()
