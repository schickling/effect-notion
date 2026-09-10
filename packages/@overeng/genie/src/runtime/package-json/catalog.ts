/**
 * Type-safe catalog definition with duplicate/conflict detection.
 *
 * Helps detect issues when extending a base catalog:
 * - Duplicate: same package + same version → warning
 * - Conflict: same package + different version → error
 */

import { warn } from '../utils/log.ts'
import type { WorkspaceIdentity, WorkspaceMetadata, WorkspacePackageLike } from './mod.ts'

/** Base catalog type - a record of package names to version strings */
export type CatalogInput = Record<string, string>

type WorkspaceDependencyMap<TWorkspace extends readonly WorkspacePackageLike[]> = {
  [TPkg in TWorkspace[number] as Extract<TPkg['data']['name'], string>]:
    | 'workspace:^'
    | `workspace:${string}`
    | `link:repos/${string}`
    | `file:repos/${string}`
}

type DependencyBucket<
  TWorkspace extends readonly WorkspacePackageLike[],
  TExternal extends CatalogInput,
> = {
  workspace?: TWorkspace
  /**
   * Protocol overrides for dependencies owned by another repository.
   *
   * Use `file` when pnpm must materialize the package with the consumer's peer
   * graph instead of following a source symlink with its repository-local peers.
   */
  crossRepoProtocols?: Partial<
    Record<Extract<TWorkspace[number]['data']['name'], string>, 'link' | 'file'>
  >
  /**
   * Same-repo dependencies that must resolve as live workspace links.
   *
   * `injectWorkspacePackages: true` makes pnpm materialize a same-repo
   * dependency as an injected `file:` copy whenever the consumer's peer graph
   * binds a peer the dependency itself satisfies only through its
   * `devDependencies`, and pnpm 12 ignores `dependenciesMeta.<dep>.injected`
   * while the workspace-wide setting is on. Listing the dependency here emits a
   * path-based `workspace:<relative-path>` specifier, which keeps the workspace
   * protocol while routing the edge through pnpm's local link resolution, so
   * the consumer keeps reading workspace source instead of an install-time
   * snapshot.
   */
  liveWorkspaceLinks?: readonly Extract<TWorkspace[number]['data']['name'], string>[]
  /** Already-picked external dependencies, typically from `catalog.pick(...)`. */
  external?: TExternal
}

type PeerPackagesArgs<TPackages extends readonly WorkspacePackageLike[]> = {
  packages: TPackages
}

type ComposeArgs<
  TDependenciesWorkspace extends readonly WorkspacePackageLike[],
  TDependenciesExternal extends CatalogInput,
  TDevDependenciesWorkspace extends readonly WorkspacePackageLike[],
  TDevDependenciesExternal extends CatalogInput,
  TPeerDependenciesWorkspace extends readonly WorkspacePackageLike[],
  TPeerDependenciesExternal extends CatalogInput,
> = {
  workspace: WorkspaceIdentity
  dependencies?: DependencyBucket<TDependenciesWorkspace, TDependenciesExternal>
  devDependencies?: DependencyBucket<TDevDependenciesWorkspace, TDevDependenciesExternal>
  peerDependencies?: DependencyBucket<TPeerDependenciesWorkspace, TPeerDependenciesExternal>
  /**
   * `manifest`: compose only direct workspace deps + external deps.
   * `install`: also install inherited peer deps of workspace packages using explicit catalog versions.
   */
  mode?: 'manifest' | 'install'
}

type ComposeResult<
  TDependenciesWorkspace extends readonly WorkspacePackageLike[],
  TDependenciesExternal extends CatalogInput,
  TDevDependenciesWorkspace extends readonly WorkspacePackageLike[],
  TDevDependenciesExternal extends CatalogInput,
  _TPeerDependenciesWorkspace extends readonly WorkspacePackageLike[],
  _TPeerDependenciesExternal extends CatalogInput,
> = {
  dependencies: TDependenciesExternal & WorkspaceDependencyMap<TDependenciesWorkspace>
  devDependencies: TDevDependenciesExternal & WorkspaceDependencyMap<TDevDependenciesWorkspace>
  peerDependencies: CatalogInput
  workspace: WorkspaceMetadata
} & {
  readonly [PackageJsonCompositionBrand]: true
}

/**
 * Type-level brand key for catalogs.
 *
 * Exported as a value so TypeScript can reference it in declaration files across project
 * boundaries. Without this export, TS4023 "cannot be named" errors occur.
 */
export const CatalogBrand: unique symbol = Symbol('CatalogBrand')

/**
 * Type-level brand key for package.json compositions.
 *
 * Exported so the package-json runtime can require a coupled composition payload
 * without exposing its internal structure as the main authoring API.
 */
export const PackageJsonCompositionBrand: unique symbol = Symbol('PackageJsonCompositionBrand')

/** Coupled emitted package metadata and non-emitted workspace closure from `catalog.compose(...)`. */
export type PackageJsonComposition = {
  readonly dependencies: CatalogInput
  readonly devDependencies: CatalogInput
  readonly peerDependencies: CatalogInput
  readonly workspace: WorkspaceMetadata
  readonly [PackageJsonCompositionBrand]: true
}

/**
 * Branded catalog type to distinguish validated catalogs.
 * Uses a symbol key which doesn't interfere with Record<string, string> compatibility.
 */
export type Catalog<T extends CatalogInput = CatalogInput> = Readonly<T> & {
  readonly [CatalogBrand]: T
  /**
   * Pick multiple packages from the catalog and return as a dependency object.
   * Useful for spreading into dependencies/devDependencies.
   *
   * @example
   * ```ts
   * devDependencies: {
   *   ...catalog.pick('@overeng/utils', 'effect'),
   * }
   * ```
   */
  pick<K extends keyof T>(...keys: K[]): { [P in K]: T[P] }
  /**
   * Generate peerDependencies object with `^` version prefix.
   * Useful for library packages that expose dependencies as peer deps.
   *
   * @example
   * ```ts
   * peerDependencies: catalog.peers('effect', '@effect/platform'),
   * // → { effect: '^3.19.14', '@effect/platform': '^0.94.1' }
   * ```
   */
  peers<K extends keyof T>(...keys: K[]): { [P in K]: string }
  /**
   * Compose emitted dependencies and non-emitted workspace metadata from imported
   * workspace packages plus external catalog entries.
   *
   * In `manifest` mode, only direct workspace deps are emitted as `workspace:*`
   * and imported workspace peer contracts are recomposed into emitted
   * `peerDependencies`.
   * In `install` mode, inherited peer deps from workspace packages are also
   * installed explicitly using catalog versions.
   */
  compose<
    const TDependenciesWorkspace extends readonly WorkspacePackageLike[],
    const TDependenciesExternal extends CatalogInput,
    const TDevDependenciesWorkspace extends readonly WorkspacePackageLike[],
    const TDevDependenciesExternal extends CatalogInput,
    const TPeerDependenciesWorkspace extends readonly WorkspacePackageLike[],
    const TPeerDependenciesExternal extends CatalogInput,
  >(
    args: ComposeArgs<
      TDependenciesWorkspace,
      TDependenciesExternal,
      TDevDependenciesWorkspace,
      TDevDependenciesExternal,
      TPeerDependenciesWorkspace,
      TPeerDependenciesExternal
    >,
  ): ComposeResult<
    TDependenciesWorkspace,
    TDependenciesExternal,
    TDevDependenciesWorkspace,
    TDevDependenciesExternal,
    TPeerDependenciesWorkspace,
    TPeerDependenciesExternal
  >
}

/** Configuration for extending an existing catalog */
type ExtendedCatalogInput<TBase extends CatalogInput = CatalogInput> = {
  /** Base catalog(s) to extend from */
  extends: Catalog<TBase> | readonly Catalog[]
  /** New packages to add (will be checked for duplicates/conflicts) */
  packages: CatalogInput
}

/** Error thrown when a catalog has conflicting version definitions */
export class CatalogConflictError extends Error {
  public readonly packageName: string
  public readonly baseVersion: string
  public readonly newVersion: string

  constructor(args: { packageName: string; baseVersion: string; newVersion: string }) {
    const { packageName, baseVersion, newVersion } = args
    super(
      `Catalog conflict for "${packageName}": base has "${baseVersion}" but extending with "${newVersion}". ` +
        `Remove "${packageName}" from the extending catalog or update its version to match the base. ` +
        `Note: this error occurs during module initialization and will cascade as TDZ errors ` +
        `(Cannot access 'X' before initialization) in all downstream imports, masking the root cause.`,
    )
    this.packageName = packageName
    this.baseVersion = baseVersion
    this.newVersion = newVersion
    this.name = 'CatalogConflictError'
  }
}

/** Creates a pick function for a catalog object */
const createPickFn =
  <T extends CatalogInput>(catalog: T) =>
  <K extends keyof T>(...keys: K[]): { [P in K]: T[P] } => {
    const result = {} as { [P in K]: T[P] }
    for (const key of keys) {
      result[key] = catalog[key]
    }
    return result
  }

/** Creates a peers function for a catalog object (versions with ^ prefix) */
const createPeersFn =
  <T extends CatalogInput>(catalog: T) =>
  <K extends keyof T>(...keys: K[]): { [P in K]: string } => {
    const result = {} as { [P in K]: string }
    for (const key of keys) {
      result[key] = `^${catalog[key]}`
    }
    return result
  }

const collectInheritedPeerInstalls = ({
  packages,
  catalog,
  workspaceDepNames,
  visited = new Set<string>(),
}: PeerPackagesArgs<readonly WorkspacePackageLike[]> & {
  catalog: CatalogInput
  /** Names of packages already listed as explicit workspace deps — skip these from inherited peer resolution */
  workspaceDepNames: ReadonlySet<string>
  visited?: Set<string>
}) => {
  const installs = new Map<string, string>()

  for (const pkg of packages) {
    const pkgKey = `${pkg.meta.workspace.repoName}:${pkg.meta.workspace.memberPath}`
    if (visited.has(pkgKey) === true) continue
    visited.add(pkgKey)

    const installEntries = Object.entries(
      Object.fromEntries(
        Object.keys(pkg.data.peerDependencies ?? {})
          .filter((name) => workspaceDepNames.has(name) === false)
          .map((name) => {
            const version = catalog[name]
            if (typeof version !== 'string') {
              throw new Error(
                `Catalog is missing explicit install version for inherited peer "${name}"`,
              )
            }
            return [name, version] as const
          }),
      ),
    )

    for (const [name, version] of installEntries) {
      installs.set(name, version)
    }

    for (const [name, version] of collectInheritedPeerInstalls({
      packages: pkg.meta.workspace.deps,
      catalog,
      workspaceDepNames,
      visited,
    })) {
      installs.set(name, version)
    }
  }

  return [...installs.entries()].toSorted(([nameA], [nameB]) => nameA.localeCompare(nameB))
}

const resolveInheritedPeerInstalls = <T extends CatalogInput>({
  catalog,
  packages,
  workspaceDepNames,
}: {
  catalog: T
  packages: readonly WorkspacePackageLike[]
  workspaceDepNames: ReadonlySet<string>
}) => Object.fromEntries(collectInheritedPeerInstalls({ packages, catalog, workspaceDepNames }))

const resolvePeerDependencies = <
  TWorkspace extends readonly WorkspacePackageLike[],
  TExternal extends CatalogInput,
>({
  packages,
  external,
}: {
  packages: TWorkspace
  external: TExternal
}) =>
  Object.fromEntries(
    [
      ...packages.flatMap((pkg) => Object.entries(pkg.data.peerDependencies ?? {})),
      ...Object.entries(external).map(
        ([name, version]) =>
          [name, version.startsWith('^') === true ? version : `^${version}`] as const,
      ),
    ].toSorted(([nameA], [nameB]) => nameA.localeCompare(nameB)),
  ) as CatalogInput

/**
 * Repository-relative path from one workspace member directory to another.
 *
 * Both inputs are repository-relative member paths, so the result is the
 * specifier body pnpm resolves against the consumer's own directory.
 */
const relativeMemberPath = ({ from, to }: { from: string; to: string }): string => {
  const fromSegments = from.split('/')
  const toSegments = to.split('/')
  let shared = 0
  while (
    shared < fromSegments.length &&
    shared < toSegments.length &&
    fromSegments[shared] === toSegments[shared]
  ) {
    shared += 1
  }
  return [
    ...fromSegments.slice(shared).map(() => '..'),
    ...toSegments.slice(shared),
  ].join('/')
}

/** Creates a composition helper for a catalog object */
const createComposeFn =
  <T extends CatalogInput>(catalog: T) =>
  <
    const TDependenciesWorkspace extends readonly WorkspacePackageLike[],
    const TDependenciesExternal extends CatalogInput,
    const TDevDependenciesWorkspace extends readonly WorkspacePackageLike[],
    const TDevDependenciesExternal extends CatalogInput,
    const TPeerDependenciesWorkspace extends readonly WorkspacePackageLike[],
    const TPeerDependenciesExternal extends CatalogInput,
  >({
    workspace,
    dependencies,
    devDependencies,
    peerDependencies,
    mode = 'manifest',
  }: ComposeArgs<
    TDependenciesWorkspace,
    TDependenciesExternal,
    TDevDependenciesWorkspace,
    TDevDependenciesExternal,
    TPeerDependenciesWorkspace,
    TPeerDependenciesExternal
  >): ComposeResult<
    TDependenciesWorkspace,
    TDependenciesExternal,
    TDevDependenciesWorkspace,
    TDevDependenciesExternal,
    TPeerDependenciesWorkspace,
    TPeerDependenciesExternal
  > => {
    const runtimeWorkspace = dependencies?.workspace ?? ([] as unknown as TDependenciesWorkspace)
    const supportWorkspace =
      devDependencies?.workspace ?? ([] as unknown as TDevDependenciesWorkspace)
    const peerWorkspace =
      peerDependencies?.workspace ?? ([] as unknown as TPeerDependenciesWorkspace)
    const runtimeExternal = dependencies?.external ?? ({} as TDependenciesExternal)
    const supportExternal = devDependencies?.external ?? ({} as TDevDependenciesExternal)
    const peerExternal = peerDependencies?.external ?? ({} as TPeerDependenciesExternal)
    const workspaceDepVersion = ({
      pkg,
      crossRepoProtocols,
      liveWorkspaceLinks,
    }: {
      pkg: WorkspacePackageLike
      crossRepoProtocols: Partial<Record<string, 'link' | 'file'>> | undefined
      liveWorkspaceLinks: readonly string[] | undefined
    }): string => {
      if (pkg.meta.workspace.repoName === workspace.repoName) {
        if (pkg.data.name === undefined) return 'workspace:^'
        if (liveWorkspaceLinks?.includes(pkg.data.name) !== true) return 'workspace:^'
        return `workspace:${relativeMemberPath({
          from: workspace.memberPath,
          to: pkg.meta.workspace.memberPath,
        })}`
      }

      const protocol =
        pkg.data.name === undefined ? 'link' : (crossRepoProtocols?.[pkg.data.name] ?? 'link')
      return `${protocol}:repos/${pkg.meta.workspace.repoName}/${pkg.meta.workspace.memberPath}`
    }
    const runtimeWorkspaceDependencies = Object.fromEntries(
      runtimeWorkspace.flatMap((pkg) =>
        pkg.data.name === undefined
          ? []
          : [
              [
                pkg.data.name,
                workspaceDepVersion({
                  pkg,
                  crossRepoProtocols: dependencies?.crossRepoProtocols,
                  liveWorkspaceLinks: dependencies?.liveWorkspaceLinks,
                }),
              ] as const,
            ],
      ),
    ) as WorkspaceDependencyMap<TDependenciesWorkspace>
    const supportWorkspaceDependencies = Object.fromEntries(
      supportWorkspace.flatMap((pkg) =>
        pkg.data.name === undefined
          ? []
          : [
              [
                pkg.data.name,
                workspaceDepVersion({
                  pkg,
                  crossRepoProtocols: devDependencies?.crossRepoProtocols,
                  liveWorkspaceLinks: devDependencies?.liveWorkspaceLinks,
                }),
              ] as const,
            ],
      ),
    ) as WorkspaceDependencyMap<TDevDependenciesWorkspace>
    /** Workspace packages already listed as explicit deps — skip their registry versions from inherited peers */
    const allWorkspaceDepNames = new Set([
      ...Object.keys(runtimeWorkspaceDependencies),
      ...Object.keys(supportWorkspaceDependencies),
    ])
    const inheritedPeerDependencies =
      mode === 'install'
        ? resolveInheritedPeerInstalls({
            catalog,
            packages: [...runtimeWorkspace, ...supportWorkspace, ...peerWorkspace],
            workspaceDepNames: allWorkspaceDepNames,
          })
        : {}
    const peerDependencyEntries = resolvePeerDependencies({
      packages: peerWorkspace,
      external: peerExternal,
    })

    return {
      dependencies: {
        ...runtimeExternal,
        ...inheritedPeerDependencies,
        ...runtimeWorkspaceDependencies,
      },
      devDependencies: {
        ...supportExternal,
        ...supportWorkspaceDependencies,
      },
      peerDependencies: peerDependencyEntries,
      workspace: {
        ...workspace,
        deps: [...runtimeWorkspace, ...supportWorkspace, ...peerWorkspace],
      },
      [PackageJsonCompositionBrand]: true as const,
    }
  }

/** Adds pick/peers methods as non-enumerable properties and freezes the catalog */
const finalizeCatalog = <T extends CatalogInput>(catalog: T): Catalog<T> => {
  Object.defineProperty(catalog, 'pick', {
    value: createPickFn(catalog),
    enumerable: false,
    writable: false,
    configurable: false,
  })
  Object.defineProperty(catalog, 'peers', {
    value: createPeersFn(catalog),
    enumerable: false,
    writable: false,
    configurable: false,
  })
  Object.defineProperty(catalog, 'compose', {
    value: createComposeFn(catalog),
    enumerable: false,
    writable: false,
    configurable: false,
  })
  return Object.freeze(catalog) as Catalog<T>
}

/**
 * Creates a type-safe catalog with optional duplicate/conflict detection.
 *
 * Two signatures:
 * 1. `defineCatalog({ pkg: 'version' })` - standalone catalog
 * 2. `defineCatalog({ extends: baseCatalog, packages: { ... } })` - extended catalog
 *
 * When extending:
 * - Duplicate (same pkg + same version): Console warning, proceeds
 * - Conflict (same pkg + different version): Throws {@link CatalogConflictError}
 *
 * @example
 * ```ts
 * // Standalone catalog
 * const baseCatalog = defineCatalog({
 *   effect: '3.19.14',
 *   '@effect/platform': '0.94.1',
 * })
 *
 * // Extended catalog with detection
 * const extendedCatalog = defineCatalog({
 *   extends: baseCatalog,
 *   packages: {
 *     '@effect/ai-openai': '0.37.2',  // new - OK
 *     effect: '3.19.14',               // duplicate - WARN
 *     // '@effect/platform': '0.95.0', // conflict - ERROR
 *   },
 * })
 *
 * // Multiple bases
 * const merged = defineCatalog({
 *   extends: [baseCatalog, otherCatalog],
 *   packages: { ... },
 * })
 * ```
 */
export function defineCatalog<const T extends CatalogInput>(input: T): Catalog<T>
export function defineCatalog<
  const TBase extends CatalogInput,
  const TNew extends CatalogInput,
>(input: { extends: Catalog<TBase>; packages: TNew }): Catalog<TBase & TNew>
export function defineCatalog<const TNew extends CatalogInput>(input: {
  extends: readonly Catalog<any>[]
  packages: TNew
}): Catalog<CatalogInput & TNew>
export function defineCatalog<const T extends CatalogInput>(
  input: T | ExtendedCatalogInput,
): Catalog<T> {
  if (!('extends' in input && 'packages' in input)) {
    // Standalone catalog - add pick method and freeze
    return finalizeCatalog({ ...input })
  }

  // Extended catalog - merge and validate
  const bases = Array.isArray(input.extends) === true ? input.extends : [input.extends]
  const merged: Record<string, string> = {}

  // Merge all base catalogs (skip non-string values like the pick method)
  for (const base of bases) {
    for (const pkg of Object.keys(base)) {
      const version = base[pkg]
      if (typeof version !== 'string') continue
      if (pkg in merged && merged[pkg] !== version) {
        // Conflict between bases
        throw new CatalogConflictError({
          packageName: pkg,
          baseVersion: merged[pkg]!,
          newVersion: version,
        })
      }
      merged[pkg] = version
    }
  }

  // Check and merge new packages
  for (const [pkg, version] of Object.entries(input.packages)) {
    if (pkg in merged) {
      if (merged[pkg] === version) {
        // Duplicate - warn but continue
        warn(`[defineCatalog] Duplicate: "${pkg}@${version}" already defined in base catalog`)
      } else {
        // Conflict - throw
        throw new CatalogConflictError({
          packageName: pkg,
          baseVersion: merged[pkg]!,
          newVersion: version,
        })
      }
    }
    merged[pkg] = version
  }

  // Add pick method and freeze
  return finalizeCatalog(merged) as Catalog<T>
}
