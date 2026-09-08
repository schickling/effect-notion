import {
  nativeDependencyPolicy,
  nixGraftedStoreOverridePackages,
} from '../../genie/native-dependency-policy.ts'

import type { PnpmLockMetadata, PnpmSha256Sidecar } from './pnpm-lock.ts'
import type {
  PnpmStoreEdgeSet,
  PnpmStoreEntry,
  PnpmStoreProjection,
  PnpmStoreView,
  PnpmPlatform,
} from './pnpm-store.ts'
import { platformGatedPackageNames, pnpmPlatforms } from './pnpm-store.ts'

const compareStrings = ({ left, right }: { left: string; right: string }): number =>
  left < right ? -1 : left > right ? 1 : 0

const sortedEntries = <TValue>(record: Readonly<Record<string, TValue>>) =>
  Object.entries(record).toSorted(([left], [right]) => compareStrings({ left, right }))

const fail = (message: string): never => {
  throw new Error(`Invalid pnpm store declaration: ${message}`)
}

const starlarkString = (value: string): string => JSON.stringify(value)

/**
 * Renders the declared override for one entry's package bytes.
 *
 * The store is normalized: one entry per peer-resolved snapshot for the whole
 * repository. Overriding that single entry therefore reaches every importer
 * and every alias of the package, including a patched dependent that only
 * names it transitively, without copying bytes per consumer.
 *
 * The value is the immutable directory named by `[test_capabilities]`. Left
 * undeclared it is the empty string, which keeps the hash-pinned registry
 * archive: a lane that only typechecks a grafted package needs its sources,
 * not its addon, and a lane that loads the addon declares the capability.
 */
const renderPackageOverride = (entry: PnpmStoreEntry): readonly string[] =>
  nixGraftedStoreOverridePackages[entry.packageName] === undefined
    ? []
    : [
        `    package_override = read_config("test_capabilities", ${starlarkString(
          entry.packageName,
        )}, ""),`,
      ]

const renderDict = ({
  indent,
  record,
}: {
  indent: number
  record: Readonly<Record<string, string>>
}): string => {
  const prefix = ' '.repeat(indent)
  return [
    '{',
    ...sortedEntries(record).map(
      ([key, value]) => `${prefix}    ${starlarkString(key)}: ${starlarkString(value)},`,
    ),
    `${prefix}}`,
  ].join('\n')
}

const renderPlatformDict = ({
  byPlatform,
  field,
}: {
  byPlatform: Readonly<Record<PnpmPlatform, Readonly<Record<string, string>>>>
  field: string
}): readonly string[] => [
  `    ${field} = {`,
  ...pnpmPlatforms.map(
    (platform) =>
      `        ${starlarkString(platform)}: ${renderDict({ indent: 8, record: byPlatform[platform] })},`,
  ),
  '    },',
]

/**
 * Renders either the invariant or the per-platform form of one attribute.
 *
 * A configured `select()` appears only where the projected values actually
 * differ across admitted platforms, so no platform-varying count is written
 * down: the lockfile decides.
 */
const renderMaybeSelected = ({
  byPlatform,
  field,
}: {
  byPlatform: Readonly<Record<PnpmPlatform, Readonly<Record<string, string>>>>
  field: string
}): readonly string[] => {
  const rendered = pnpmPlatforms.map((platform) =>
    renderDict({ indent: 4, record: byPlatform[platform] }),
  )
  if (rendered.every((value) => value === rendered[0])) {
    return [`    ${field} = ${rendered[0]},`]
  }
  return renderPlatformDict({ byPlatform, field: `${field}_by_platform` })
}

const byPlatform = <TValue>(
  project: (platform: PnpmPlatform) => TValue,
): Readonly<Record<PnpmPlatform, TValue>> =>
  Object.fromEntries(pnpmPlatforms.map((platform) => [platform, project(platform)])) as Record<
    PnpmPlatform,
    TValue
  >

const edgesFor = ({
  entry,
  platform,
}: {
  entry: PnpmStoreEntry
  platform: PnpmPlatform
}): PnpmStoreEdgeSet =>
  entry.variants.find((variant) => variant.platforms.includes(platform))?.edges ?? {}

const invariantRecord = ({
  field,
  values,
}: {
  field: string
  values: Readonly<Record<PnpmPlatform, Readonly<Record<string, string>>>>
}): Readonly<Record<string, string>> => {
  const rendered = pnpmPlatforms.map((platform) => JSON.stringify(sortedEntries(values[platform])))
  if (rendered.every((value) => value === rendered[0]) === false) {
    return fail(`${field} must not depend on the configured platform`)
  }
  return values[pnpmPlatforms[0]!]
}

const workspaceEdges = (edges: PnpmStoreEdgeSet): Readonly<Record<string, string>> =>
  Object.fromEntries(
    sortedEntries(edges).flatMap(([name, edge]) =>
      edge.kind === 'workspace' ? [[name, edge.workspaceKey] as const] : [],
    ),
  )

const packageEdges = ({
  edges,
  targetByStoreKey,
}: {
  edges: PnpmStoreEdgeSet
  targetByStoreKey: ReadonlyMap<string, string>
}): Readonly<Record<string, string>> =>
  Object.fromEntries(
    sortedEntries(edges).flatMap(([name, edge]) =>
      edge.kind === 'entry'
        ? [
            [
              name,
              targetByStoreKey.get(edge.storeKey) ?? fail(`unknown store entry ${edge.storeKey}`),
            ] as const,
          ]
        : [],
    ),
  )

const renderView = ({
  targetByStoreKey,
  view,
}: {
  targetByStoreKey: ReadonlyMap<string, string>
  view: PnpmStoreView
}): readonly string[] => {
  const variantFor = (platform: PnpmPlatform) =>
    view.variants.find((variant) => variant.platforms.includes(platform)) ??
    fail(`view ${view.importer} has no variant for ${platform}`)
  const direct = byPlatform((platform) =>
    Object.fromEntries(
      sortedEntries(variantFor(platform).direct).flatMap(([name, edge]) =>
        edge.kind === 'entry' ? [[name, edge.storeKey] as const] : [],
      ),
    ),
  )
  const closure = byPlatform((platform) =>
    Object.fromEntries(
      variantFor(platform).closure.map((storeKey) => [
        storeKey,
        targetByStoreKey.get(storeKey) ?? fail(`unknown store entry ${storeKey}`),
      ]),
    ),
  )
  const bins = byPlatform((platform) => variantFor(platform).bins)
  const workspaceDependencies = invariantRecord({
    field: `view ${view.importer} workspace dependencies`,
    values: byPlatform((platform) => workspaceEdges(variantFor(platform).direct)),
  })
  return [
    'pnpm_store_view(',
    `    name = ${starlarkString(view.target)},`,
    '    runtime = ":assemble-store.ts",',
    ...renderMaybeSelected({ byPlatform: direct, field: 'direct' }),
    ...renderMaybeSelected({ byPlatform: closure, field: 'closure' }),
    ...renderMaybeSelected({ byPlatform: bins, field: 'bins' }),
    `    workspace_trees = ${renderDict({ indent: 4, record: view.workspaceTrees })},`,
    `    workspace_dependencies = ${renderDict({ indent: 4, record: workspaceDependencies })},`,
    '    visibility = ["PUBLIC"],',
    ')',
    '',
  ]
}

/**
 * Renders the registry archive targets the normalized store entries point at.
 *
 * One `pnpm_package` per registry-resolved lockfile package, hash-pinned from
 * the freshness-gated sidecar. Store entries reference these targets; the
 * package layer itself is importer-agnostic.
 */
export const renderPnpmPackageTargets = ({
  metadata,
  sidecar,
}: {
  metadata: PnpmLockMetadata
  sidecar: PnpmSha256Sidecar
}): string => {
  const lines: string[] = []
  for (const [packageKey, packageMetadata] of sortedEntries(metadata.packages)) {
    if (packageMetadata.resolution !== 'registry') continue
    const hash = sidecar.packages[packageKey]
    if (hash === undefined || packageMetadata.url === undefined)
      return fail(`missing sidecar entry ${packageKey}`)
    lines.push(
      'pnpm_package(',
      `    name = ${starlarkString(packageMetadata.target)},`,
      `    package_name = ${starlarkString(packageMetadata.name)},`,
      `    url = ${starlarkString(packageMetadata.url)},`,
      `    sha256 = ${starlarkString(hash.sha256)},`,
      `    bins = ${renderDict({ indent: 4, record: hash.bins })},`,
      ...(packageMetadata.patch === undefined
        ? []
        : [`    patches = [${starlarkString(`//:${packageMetadata.patch.path}`)}],`]),
      ')',
      '',
    )
  }
  return lines.join('\n')
}

const POLICY_FAMILIES: readonly string[] = Object.keys(nativeDependencyPolicy).toSorted(
  (left, right) => right.length - left.length,
)

/**
 * Renders the lockfile's platform-gated package families as one Buck target.
 *
 * A portable JavaScript product must leave every cpu/os/libc-gated package
 * external, and a Nix-grafted family must additionally be declared as an
 * external capability by any product that reaches it — Nix, not pnpm, provides
 * those bytes at runtime. Both facts are derived here from the lockfile and
 * the native-dependency policy, so no product can drift from them by hand.
 */
export const renderPnpmPlatformGatedPackages = ({
  metadata,
}: {
  metadata: PnpmLockMetadata
}): string => {
  const byFamily = new Map<string, string[]>()
  for (const name of platformGatedPackageNames(metadata)) {
    const family = POLICY_FAMILIES.find((candidate) => name.startsWith(candidate)) ?? name
    const members = byFamily.get(family)
    if (members === undefined) byFamily.set(family, [name])
    else members.push(name)
  }
  const families = [...byFamily.keys()].toSorted((left, right) =>
    compareStrings({ left, right }),
  )
  const capabilities: Record<string, string> = {}
  for (const family of families) {
    const policy = nativeDependencyPolicy[family as keyof typeof nativeDependencyPolicy]
    if (policy === undefined || policy._tag !== 'nix-grafted') continue
    capabilities[family] = `${family.replace('@', '').replaceAll('/', '-')}-native`
  }
  return [
    'pnpm_platform_gated_packages(',
    '    name = "platform_gated_packages",',
    `    capabilities = ${renderDict({ indent: 4, record: capabilities })},`,
    '    families = {',
    ...families.map(
      (family) =>
        `        ${starlarkString(family)}: [${(byFamily.get(family) ?? [])
          .toSorted((left, right) => compareStrings({ left, right }))
          .map(starlarkString)
          .join(', ')}],`,
    ),
    '    },',
    '    visibility = ["PUBLIC"],',
    ')',
    '',
  ].join('\n')
}

/**
 * Renders the normalized store declarations for the whole repository.
 *
 * One entry per peer-resolved snapshot, one component target per real lockfile
 * cycle, and one metadata-only view per importer. Entries and views declare a
 * `select()` only where the lockfile itself resolves different edges per
 * platform.
 */
export const renderPnpmStoreBuck = (projection: PnpmStoreProjection): string => {
  const targetByStoreKey = new Map(
    projection.entries.map((entry) => [entry.storeKey, `:${entry.target}`]),
  )
  const entryByStoreKey = new Map(projection.entries.map((entry) => [entry.storeKey, entry]))
  const lines = [
    'load(":defs.bzl", "pnpm_platform_configurations", "pnpm_store_entry", "pnpm_store_scc", "pnpm_store_view")',
    '',
    'pnpm_platform_configurations()',
    '',
    'export_file(',
    '    name = "assemble-store.ts",',
    '    src = "assemble-store.ts",',
    '    visibility = ["PUBLIC"],',
    ')',
    '',
  ]

  for (const scc of projection.sccs) {
    const members = new Set(scc.members)
    const internalByPlatform = byPlatform((platform) => {
      const internal: Record<string, string> = {}
      for (const storeKey of scc.members) {
        const entry = entryByStoreKey.get(storeKey) ?? fail(`unknown store entry ${storeKey}`)
        for (const [name, edge] of sortedEntries(edgesFor({ entry, platform }))) {
          if (edge.kind !== 'entry' || members.has(edge.storeKey) === false) continue
          internal[`${storeKey}\t${name}`] = edge.storeKey
        }
      }
      return internal
    })
    const externalByPlatform = byPlatform((platform) => {
      const external: Record<string, string> = {}
      for (const storeKey of scc.members) {
        const entry = entryByStoreKey.get(storeKey) ?? fail(`unknown store entry ${storeKey}`)
        for (const [name, edge] of sortedEntries(edgesFor({ entry, platform }))) {
          if (edge.kind !== 'entry') {
            return fail(`component member ${storeKey} depends on workspace ${name}`)
          }
          if (members.has(edge.storeKey) === true) continue
          external[`${storeKey}\t${name}`] =
            targetByStoreKey.get(edge.storeKey) ?? fail(`unknown store entry ${edge.storeKey}`)
        }
      }
      return external
    })
    lines.push(
      'pnpm_store_scc(',
      `    name = ${starlarkString(scc.target)},`,
      '    runtime = ":assemble-store.ts",',
      `    members = ${renderDict({
        indent: 4,
        record: Object.fromEntries(
          scc.members.map((storeKey) => [
            storeKey,
            `:${(entryByStoreKey.get(storeKey) ?? fail(`unknown store entry ${storeKey}`)).packageTarget}`,
          ]),
        ),
      })},`,
      ...renderMaybeSelected({ byPlatform: internalByPlatform, field: 'internal_edges' }),
      ...renderMaybeSelected({ byPlatform: externalByPlatform, field: 'external_edges' }),
      ')',
      '',
    )
  }

  for (const entry of projection.entries) {
    lines.push(
      'pnpm_store_entry(',
      `    name = ${starlarkString(entry.target)},`,
      `    package = ${starlarkString(`:${entry.packageTarget}`)},`,
      `    store_key = ${starlarkString(entry.storeKey)},`,
      '    runtime = ":assemble-store.ts",',
    )
    const overrideLines = renderPackageOverride(entry)
    if (entry.sccIndex === undefined) {
      lines.push(
        ...overrideLines,
        ...renderMaybeSelected({
          byPlatform: byPlatform((platform) =>
            packageEdges({ edges: edgesFor({ entry, platform }), targetByStoreKey }),
          ),
          field: 'dependencies',
        }),
      )
      const workspaces = invariantRecord({
        field: `entry ${entry.storeKey} workspace dependencies`,
        values: byPlatform((platform) => workspaceEdges(edgesFor({ entry, platform }))),
      })
      if (Object.keys(workspaces).length > 0) {
        return fail(`store entry ${entry.storeKey} must not depend on a workspace tree`)
      }
    } else {
      if (overrideLines.length > 0) {
        return fail(
          `store entry ${entry.storeKey} is a cycle member and cannot graft its package bytes`,
        )
      }
      const scc = projection.sccs[entry.sccIndex] ?? fail(`unknown component ${entry.sccIndex}`)
      lines.push(`    scc = ${starlarkString(`:${scc.target}`)},`)
    }
    lines.push('    visibility = ["PUBLIC"],', ')', '')
  }

  for (const view of projection.views) {
    lines.push(...renderView({ targetByStoreKey, view }))
  }
  return lines.join('\n')
}
