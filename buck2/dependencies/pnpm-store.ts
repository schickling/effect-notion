import { buck2SemanticFingerprint } from '../../genie/buck2/mod.ts'
import type {
  PnpmDependencyReference,
  PnpmImporterMetadata,
  PnpmLockMetadata,
  PnpmSha256Sidecar,
  PnpmSnapshotMetadata,
} from './pnpm-lock.ts'
import { pnpmTargetName, validatePnpmSha256Sidecar } from './pnpm-lock.ts'

/** Schema identifier for the normalized pnpm store projection. */
export const pnpmStoreProjectionSchema = 'effect-utils/buck2-pnpm-store/v1' as const

// The portable platform is not a machine: it admits a package only when the
// lockfile puts no cpu, os, or libc gate on it at all, so a package tree
// configured for it carries exactly the platform-invariant closure.
const platformValues = {
  javascript_portable: { cpu: undefined, libc: undefined, os: undefined },
  linux_aarch64: { cpu: 'arm64', libc: 'glibc', os: 'linux' },
  linux_x86_64: { cpu: 'x64', libc: 'glibc', os: 'linux' },
  macos_aarch64: { cpu: 'arm64', libc: undefined, os: 'darwin' },
} as const

/** The one platform whose package set must be identical on every host. */
export const portablePnpmPlatform = 'javascript_portable' as const

/** Admitted cpu/os configurations for generated dependency selects. */
export type PnpmPlatform = keyof typeof platformValues

/** Every admitted platform in deterministic order. */
export const pnpmPlatforms: readonly PnpmPlatform[] = Object.keys(platformValues).toSorted() as
  readonly PnpmPlatform[]

const compareStrings = ({ left, right }: { left: string; right: string }): number =>
  left < right ? -1 : left > right ? 1 : 0

const sortedEntries = <TValue>(record: Readonly<Record<string, TValue>>) =>
  Object.entries(record).toSorted(([left], [right]) => compareStrings({ left, right }))

const fail = (message: string): never => {
  throw new Error(`Invalid pnpm store projection: ${message}`)
}

/**
 * Split a pnpm virtual-store key into package name and version.
 *
 * The key encodes a scope with `+` rather than `/`, and any peer suffix follows
 * the version in parentheses, e.g. `@playwright+test@1.61.0` or
 * `vitest@4.1.9(vite@8.0.16)`. Returns the name with its scope restored.
 */
export const parseVirtualStoreKey = (key: string): { name: string; version: string } => {
  const withoutPeers = key.replace(/\(.*$/, '')
  const at = withoutPeers.lastIndexOf('@')
  if (at <= 0) return { name: withoutPeers.replace(/\+/g, '/'), version: '' }
  return {
    name: withoutPeers.slice(0, at).replace(/\+/g, '/'),
    version: withoutPeers.slice(at + 1),
  }
}

/** Release-segment version compare; a prerelease sorts below its release. */
const compareVersions = (a: string, b: string): number => {
  const parts = (v: string): number[] =>
    v
      .split('-')[0]!
      .split('.')
      .map((n) => Number.parseInt(n, 10))
      .map((n) => (Number.isNaN(n) ? 0 : n))
  const [pa, pb] = [parts(a), parts(b)]
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  const prerelease = (v: string): boolean => v.includes('-')
  if (prerelease(a) !== prerelease(b)) return prerelease(a) ? -1 : 1
  return 0
}

/**
 * Choose which of two packages owns an importer's root `.bin/<binName>`.
 *
 * Mirrors pnpm's own conflict order so the projected `.bin` matches the tree
 * pnpm materialises: a package whose own name (less any scope) equals the bin
 * name wins; otherwise the lexicographically greater package name; otherwise
 * the greater version. Ties keep the incumbent, which makes the result
 * independent of visit order.
 */
export const pickRootBin = ({
  binName,
  challenger,
  holder,
}: {
  binName: string
  challenger: string
  holder: string
}): string => {
  const parse = (record: string): { name: string; version: string } =>
    parseVirtualStoreKey(record.split('\t')[0] ?? '')
  const [c, h] = [parse(challenger), parse(holder)]
  const owns = (name: string): boolean => name.replace(/^@[^/]+\//, '') === binName
  if (owns(c.name) !== owns(h.name)) return owns(c.name) ? challenger : holder
  if (c.name !== h.name) return c.name.localeCompare(h.name) > 0 ? challenger : holder
  return compareVersions(c.version, h.version) > 0 ? challenger : holder
}

/** Stable single-component Buck key for one workspace importer path. */
export const workspaceKey = (importer: string): string => {
  const readable = importer
    .replaceAll(/[^A-Za-z0-9_]+/g, '_')
    .replaceAll(/^_+|_+$/g, '')
    .slice(0, 72)
  const digest = buck2SemanticFingerprint({
    generator: 'effect-utils/buck2/dependencies/workspace-key',
    schemaVersion: 1,
    semanticData: importer,
  }).slice('sha256:'.length, 'sha256:'.length + 12)
  return `workspace_${readable === '' ? 'root' : readable}_${digest}`
}

const platformAllows = ({
  constraints,
  value,
}: {
  constraints: readonly string[]
  value: string | undefined
}): boolean => {
  if (value === undefined) return constraints.length === 0
  if (constraints.includes(`!${value}`) === true) return false
  const positive = constraints.filter((constraint) => constraint.startsWith('!') === false)
  return positive.length === 0 || positive.includes(value)
}

/** Whether one resolved lock package may be installed on one admitted platform. */
export const packageAllowed = ({
  metadata,
  packageKey,
  platform,
}: {
  metadata: PnpmLockMetadata
  packageKey: string
  platform: PnpmPlatform
}): boolean => {
  const packageMetadata = metadata.packages[packageKey]
  if (packageMetadata === undefined) return fail(`unknown package ${packageKey}`)
  // The portable platform admits only the ungated: a package the lockfile
  // restricts at all resolves differently per host, so it can never be part of
  // a platform-invariant closure — including a libc-only gate, which a
  // machine-shaped platform would only consult on Linux.
  if (platform === portablePnpmPlatform) {
    return (
      packageMetadata.cpu.length === 0 &&
      packageMetadata.os.length === 0 &&
      packageMetadata.libc.length === 0
    )
  }
  const values = platformValues[platform]
  return (
    platformAllows({ constraints: packageMetadata.cpu, value: values.cpu }) &&
    platformAllows({ constraints: packageMetadata.os, value: values.os }) &&
    (values.os !== 'linux' ||
      platformAllows({ constraints: packageMetadata.libc, value: values.libc }))
  )
}

/**
 * Every locked package name the lockfile gates on cpu, os, or libc.
 *
 * A gated package resolves on some admitted platforms and not on others, so
 * its bytes can never belong to a platform-invariant product: a portable
 * bundle must leave it external and let the runtime dispatch. The gate comes
 * from the lockfile so the answer is the same on every host, including one
 * where the package happens to be installed.
 */
export const platformGatedPackageNames = (metadata: PnpmLockMetadata): readonly string[] => {
  const gated = new Set<string>()
  for (const [packageKey, packageMetadata] of sortedEntries(metadata.packages)) {
    if (packageMetadata.resolution !== 'registry') continue
    if (packageAllowed({ metadata, packageKey, platform: portablePnpmPlatform })) continue
    gated.add(packageMetadata.name)
  }
  return [...gated].toSorted((left, right) => compareStrings({ left, right }))
}

/** One resolved dependency edge of a normalized store entry. */
export type PnpmStoreEdge =
  | { readonly kind: 'entry'; readonly storeKey: string }
  | { readonly kind: 'workspace'; readonly workspaceKey: string; readonly workspacePath: string }

/** Dependency name to resolved edge for one configured entry variant. */
export type PnpmStoreEdgeSet = Readonly<Record<string, PnpmStoreEdge>>

/** A distinct configured edge selection and the platforms that select it. */
export type PnpmStoreEntryVariant = {
  readonly edges: PnpmStoreEdgeSet
  readonly platforms: readonly PnpmPlatform[]
}

/**
 * One normalized per-package store entry.
 *
 * The entry owns exactly one package copy under `node_modules/<packageName>`
 * plus metadata links to sibling entries. `variants.length > 1` means the
 * lockfile itself resolves different dependency edges per platform, so the
 * count of platform-varying entries is derived rather than declared.
 */
export type PnpmStoreEntry = {
  readonly bins: Readonly<Record<string, string>>
  readonly packageKey: string
  readonly packageName: string
  readonly packageTarget: string
  readonly platforms: readonly PnpmPlatform[]
  readonly sccIndex: number | undefined
  readonly snapshot: string
  readonly storeKey: string
  readonly target: string
  readonly variants: readonly PnpmStoreEntryVariant[]
}

/** One strongly connected component that must be assembled as a single group. */
export type PnpmStoreScc = {
  readonly index: number
  readonly members: readonly string[]
  readonly target: string
}

/** Direct links and closure of one importer on one selected platform. */
export type PnpmStoreViewVariant = {
  readonly bins: Readonly<Record<string, string>>
  readonly closure: readonly string[]
  readonly direct: PnpmStoreEdgeSet
  readonly platforms: readonly PnpmPlatform[]
}

/** Metadata-only dependency view for one importer. */
export type PnpmStoreView = {
  readonly importer: string
  readonly target: string
  readonly variants: readonly PnpmStoreViewVariant[]
  readonly workspaceTrees: Readonly<Record<string, string>>
}

/** Complete normalized store projection derived from the verified lockfile. */
export type PnpmStoreProjection = {
  readonly entries: readonly PnpmStoreEntry[]
  readonly fingerprint: `sha256:${string}`
  readonly sccs: readonly PnpmStoreScc[]
  readonly schema: typeof pnpmStoreProjectionSchema
  readonly views: readonly PnpmStoreView[]
}

const isStorePackage = ({
  metadata,
  snapshotKey,
}: {
  metadata: PnpmLockMetadata
  snapshotKey: string
}): boolean => {
  const snapshot = metadata.snapshots[snapshotKey]
  if (snapshot === undefined) return fail(`unknown snapshot ${snapshotKey}`)
  const packageMetadata = metadata.packages[snapshot.package]
  if (packageMetadata === undefined) return fail(`snapshot ${snapshotKey} has unknown package`)
  return packageMetadata.resolution === 'registry'
}

/**
 * DefinitelyTyped companion package name for one runtime package name.
 *
 * Mirrors the `@types` mangling TypeScript itself uses: a scoped name loses its
 * `@` and joins scope and name with `__`, so `@internationalized/date` becomes
 * `@types/internationalized__date`.
 */
const typesCompanionName = (packageName: string): string =>
  packageName.startsWith('@') === true
    ? `@types/${packageName.slice(1).replaceAll('/', '__')}`
    : `@types/${packageName}`

/**
 * Repository-wide resolution of every `@types/*` companion in the lockfile.
 *
 * A peer dependency is resolved by the consumer, so a package's own declaration
 * files reference types that the package never declares as a dependency:
 * `react-aria-components` peers `react`, and its `.d.ts` files import `react`
 * types that only `@types/react` provides. pnpm satisfies this by hoisting the
 * whole install into `node_modules/.pnpm/node_modules`, which is an ancestor of
 * every virtual-store directory, so TypeScript's `node_modules/@types/<name>`
 * fallback finds the companion. Isolated store entries have no such shared
 * ancestor, so the companion must be a declared edge instead.
 *
 * The lockfile resolves each companion once for the whole repository, exactly
 * like the hoisted layer it replaces. Two versions of one companion have no
 * single answer here — the consumer that would disambiguate is not part of a
 * shared entry — so that is rejected rather than guessed. Among peer-qualified
 * snapshots of the one admitted version the most qualified snapshot wins,
 * because it carries the companion's own fully resolved type edges; ties break
 * lexicographically so the choice is order-independent.
 */
const typesCompanionSnapshots = ({
  metadata,
}: {
  metadata: PnpmLockMetadata
}): ReadonlyMap<string, string> => {
  const candidates = new Map<string, string[]>()
  for (const [snapshotKey, snapshot] of sortedEntries(metadata.snapshots)) {
    const packageMetadata = metadata.packages[snapshot.package]
    if (packageMetadata === undefined) return fail(`snapshot ${snapshotKey} has unknown package`)
    if (packageMetadata.resolution !== 'registry') continue
    if (packageMetadata.name.startsWith('@types/') === false) continue
    const forName = candidates.get(packageMetadata.name) ?? []
    forName.push(snapshotKey)
    candidates.set(packageMetadata.name, forName)
  }
  const resolved = new Map<string, string>()
  for (const [companionName, snapshotKeys] of [...candidates].toSorted(([left], [right]) =>
    compareStrings({ left, right }),
  )) {
    const versions = new Set(
      snapshotKeys.map((snapshotKey) => metadata.packages[metadata.snapshots[snapshotKey]!.package]!.version),
    )
    if (versions.size > 1) {
      return fail(
        `${companionName} resolves to ${[...versions].toSorted().join(', ')}; a type companion must have one repository-wide version`,
      )
    }
    const best = snapshotKeys.toSorted((left, right) => {
      const qualification =
        metadata.snapshots[right]!.peerIdentities.length -
        metadata.snapshots[left]!.peerIdentities.length
      return qualification !== 0 ? qualification : compareStrings({ left, right })
    })[0]!
    resolved.set(companionName, best)
  }
  return resolved
}

/** Every dependency name one snapshot declares, platform selection aside. */
const declaredDependencyNames = (snapshot: PnpmSnapshotMetadata): readonly string[] => [
  ...Object.keys(snapshot.dependencies),
  ...Object.keys(snapshot.optionalDependencies),
]

/**
 * Type companions the peers of one snapshot require, as edge name to snapshot.
 *
 * Only peer identities are considered: a regular dependency ships inside the
 * same entry closure and carries its own declarations, whereas a peer is
 * resolved outside the depending package. A companion the snapshot already
 * declares itself is left alone so a real lockfile edge always wins.
 */
const peerTypeCompanions = ({
  companions,
  declared,
  metadata,
  snapshotKey,
}: {
  companions: ReadonlyMap<string, string>
  declared: readonly string[]
  metadata: PnpmLockMetadata
  snapshotKey: string
}): Readonly<Record<string, string>> => {
  const snapshot = metadata.snapshots[snapshotKey]
  if (snapshot === undefined) return fail(`unknown snapshot ${snapshotKey}`)
  const result: Record<string, string> = {}
  for (const peerIdentity of snapshot.peerIdentities) {
    const { name } = parseVirtualStoreKey(peerIdentity)
    if (name.startsWith('@types/') === true) continue
    const companionName = typesCompanionName(name)
    if (declared.includes(companionName) === true) continue
    const companionSnapshot = companions.get(companionName)
    if (companionSnapshot === undefined) continue
    result[companionName] = companionSnapshot
  }
  return result
}

const resolveEdge = ({
  dependencyName,
  metadata,
  optional,
  platform,
  reference,
  owner,
}: {
  dependencyName: string
  metadata: PnpmLockMetadata
  optional: boolean
  platform: PnpmPlatform
  reference: PnpmDependencyReference
  owner: string
}): PnpmStoreEdge | undefined => {
  if (reference.kind === 'workspace') {
    return {
      kind: 'workspace',
      workspaceKey: workspaceKey(reference.path),
      workspacePath: reference.path,
    }
  }
  const snapshot = metadata.snapshots[reference.snapshot]
  if (snapshot === undefined) return fail(`unknown snapshot ${reference.snapshot}`)
  const packageMetadata = metadata.packages[snapshot.package]
  if (packageMetadata === undefined)
    return fail(`snapshot ${reference.snapshot} has unknown package`)
  if (packageMetadata.resolution === 'workspace') {
    const path = packageMetadata.workspacePath
    if (path === undefined) return fail(`workspace package ${snapshot.package} has no path`)
    return { kind: 'workspace', workspaceKey: workspaceKey(path), workspacePath: path }
  }
  if (packageAllowed({ metadata, packageKey: snapshot.package, platform }) === true) {
    return { kind: 'entry', storeKey: snapshot.virtualStoreName }
  }
  if (optional === true || snapshot.optional === true) return undefined
  return fail(
    `${owner} requires ${reference.snapshot} (${dependencyName}) which is incompatible with ${platform}`,
  )
}

const snapshotEdges = ({
  companions,
  metadata,
  platform,
  snapshotKey,
}: {
  companions: ReadonlyMap<string, string>
  metadata: PnpmLockMetadata
  platform: PnpmPlatform
  snapshotKey: string
}): PnpmStoreEdgeSet => {
  const snapshot = metadata.snapshots[snapshotKey]
  if (snapshot === undefined) return fail(`unknown snapshot ${snapshotKey}`)
  const edges: Record<string, PnpmStoreEdge> = {}
  for (const [group, optional] of [
    [snapshot.dependencies, false],
    [snapshot.optionalDependencies, true],
  ] as const) {
    for (const [dependencyName, reference] of sortedEntries(group)) {
      const edge = resolveEdge({
        dependencyName,
        metadata,
        optional,
        platform,
        reference,
        owner: snapshotKey,
      })
      if (edge !== undefined) edges[dependencyName] = edge
    }
  }
  for (const [companionName, companionSnapshot] of sortedEntries(
    peerTypeCompanions({
      companions,
      declared: declaredDependencyNames(snapshot),
      metadata,
      snapshotKey,
    }),
  )) {
    const edge = resolveEdge({
      dependencyName: companionName,
      metadata,
      // A companion the consumer resolves for a peer is type-only: a platform
      // that cannot install it simply typechecks without it.
      optional: true,
      platform,
      reference: { kind: 'package', snapshot: companionSnapshot },
      owner: snapshotKey,
    })
    if (edge !== undefined) edges[companionName] = edge
  }
  return edges
}

const importerEdges = ({
  importer,
  metadata,
  platform,
}: {
  importer: PnpmImporterMetadata
  metadata: PnpmLockMetadata
  platform: PnpmPlatform
}): PnpmStoreEdgeSet => {
  const edges: Record<string, PnpmStoreEdge> = {}
  for (const [group, optional] of [
    [importer.dependencies, false],
    [importer.devDependencies, false],
    [importer.optionalDependencies, true],
  ] as const) {
    for (const [dependencyName, reference] of sortedEntries(group)) {
      const edge = resolveEdge({
        dependencyName,
        metadata,
        optional,
        platform,
        reference,
        owner: importer.target,
      })
      if (edge !== undefined) edges[dependencyName] = edge
    }
  }
  return edges
}

const edgeIdentity = (edges: PnpmStoreEdgeSet): string =>
  JSON.stringify(
    sortedEntries(edges).map(([name, edge]) => [
      name,
      edge.kind === 'entry' ? `entry:${edge.storeKey}` : `workspace:${edge.workspaceKey}`,
    ]),
  )

/**
 * Groups platforms whose projected value is structurally identical.
 *
 * Every returned group carries at least one platform, and a single returned
 * group means the value is platform-invariant. This is the only place that
 * decides whether an entry or view needs a configured `select()`, so no count
 * of platform-varying packages is written down anywhere.
 */
const groupByPlatform = <TValue>({
  identity,
  platforms,
  project,
}: {
  identity: (value: TValue) => string
  platforms: readonly PnpmPlatform[]
  project: (platform: PnpmPlatform) => TValue
}): readonly { readonly platforms: readonly PnpmPlatform[]; readonly value: TValue }[] => {
  const groups = new Map<string, { platforms: PnpmPlatform[]; value: TValue }>()
  for (const platform of platforms) {
    const value = project(platform)
    const key = identity(value)
    const existing = groups.get(key)
    if (existing === undefined) groups.set(key, { platforms: [platform], value })
    else existing.platforms.push(platform)
  }
  return [...groups.entries()]
    .toSorted(([left], [right]) => compareStrings({ left, right }))
    .map(([, group]) => group)
}

/**
 * Tarjan strongly connected components over the platform-union store graph.
 *
 * The union of every platform's selected edges is used so component membership
 * is platform-invariant: a cycle that exists on any platform is assembled as a
 * group on all of them. Splitting components per platform could otherwise
 * silently break a cycle into acyclic entries on one host.
 */
export const computeStoreSccs = ({
  metadata,
}: {
  metadata: PnpmLockMetadata
}): readonly (readonly string[])[] => {
  const nodes = Object.keys(metadata.snapshots)
    .filter((snapshotKey) => isStorePackage({ metadata, snapshotKey }))
    .toSorted((left, right) => compareStrings({ left, right }))
  const storeKeyOf = new Map<string, string>()
  const bySnapshot = new Map<string, readonly string[]>()
  for (const snapshotKey of nodes) {
    const snapshot = metadata.snapshots[snapshotKey]!
    storeKeyOf.set(snapshotKey, snapshot.virtualStoreName)
  }
  const companions = typesCompanionSnapshots({ metadata })
  for (const snapshotKey of nodes) {
    const snapshot = metadata.snapshots[snapshotKey]!
    const targets = new Set<string>()
    for (const group of [snapshot.dependencies, snapshot.optionalDependencies]) {
      for (const [, reference] of sortedEntries(group)) {
        if (reference.kind !== 'package') continue
        if (storeKeyOf.has(reference.snapshot) === false) continue
        targets.add(reference.snapshot)
      }
    }
    // Peer type companions are real entry edges, so a cycle they introduce has
    // to be grouped like any other; component membership stays a property of
    // the whole projected graph rather than of the lockfile records alone.
    for (const [, companionSnapshot] of sortedEntries(
      peerTypeCompanions({
        companions,
        declared: declaredDependencyNames(snapshot),
        metadata,
        snapshotKey,
      }),
    )) {
      if (storeKeyOf.has(companionSnapshot) === false) continue
      targets.add(companionSnapshot)
    }
    bySnapshot.set(snapshotKey, [...targets].toSorted((left, right) => compareStrings({ left, right })))
  }

  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const components: string[][] = []
  let counter = 0

  for (const root of nodes) {
    if (index.has(root) === true) continue
    // Iterative Tarjan: the real graph reaches depths that overflow a
    // recursive walk, so successor progress is tracked on an explicit stack.
    const work: { node: string; next: number }[] = [{ node: root, next: 0 }]
    index.set(root, counter)
    low.set(root, counter)
    counter += 1
    stack.push(root)
    onStack.add(root)
    while (work.length > 0) {
      const frame = work.at(-1)!
      const successors = bySnapshot.get(frame.node) ?? []
      if (frame.next < successors.length) {
        const successor = successors[frame.next]!
        frame.next += 1
        if (index.has(successor) === false) {
          index.set(successor, counter)
          low.set(successor, counter)
          counter += 1
          stack.push(successor)
          onStack.add(successor)
          work.push({ node: successor, next: 0 })
        } else if (onStack.has(successor) === true) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(successor)!))
        }
        continue
      }
      work.pop()
      const parent = work.at(-1)
      if (parent !== undefined) {
        low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!))
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const component: string[] = []
        for (;;) {
          const member = stack.pop()!
          onStack.delete(member)
          component.push(member)
          if (member === frame.node) break
        }
        components.push(component)
      }
    }
  }

  return components
    .filter((component) => {
      if (component.length > 1) return true
      const only = component[0]!
      return (bySnapshot.get(only) ?? []).includes(only)
    })
    .map((component) =>
      component
        .map((snapshotKey) => storeKeyOf.get(snapshotKey)!)
        .toSorted((left, right) => compareStrings({ left, right })),
    )
    .toSorted((left, right) => compareStrings({ left: left[0]!, right: right[0]! }))
}

/**
 * Projects the complete admitted lockfile into one normalized store.
 *
 * Every peer-resolved snapshot becomes exactly one entry regardless of how
 * many importers use it, so no dependency bytes are duplicated per consumer.
 * Importer views carry only direct links, root bin precedence, and the closure
 * they must keep alive.
 */
export const makePnpmStoreProjection = ({
  metadata,
  sidecar,
}: {
  metadata: PnpmLockMetadata
  sidecar: PnpmSha256Sidecar
}): PnpmStoreProjection => {
  validatePnpmSha256Sidecar({ metadata, sidecar })

  const sccs = computeStoreSccs({ metadata })
  const sccByStoreKey = new Map<string, number>()
  sccs.forEach((members, sccIndex) => {
    for (const member of members) {
      if (sccByStoreKey.has(member) === true) return fail(`store key ${member} is in two components`)
      sccByStoreKey.set(member, sccIndex)
    }
  })

  const snapshotKeys = Object.keys(metadata.snapshots)
    .filter((snapshotKey) => isStorePackage({ metadata, snapshotKey }))
    .toSorted((left, right) => compareStrings({ left, right }))
  const companions = typesCompanionSnapshots({ metadata })

  const entries: PnpmStoreEntry[] = []
  const entryByStoreKey = new Map<string, PnpmStoreEntry>()
  for (const snapshotKey of snapshotKeys) {
    const snapshot = metadata.snapshots[snapshotKey]!
    const packageMetadata = metadata.packages[snapshot.package]!
    const platforms = pnpmPlatforms.filter(
      (platform) => packageAllowed({ metadata, packageKey: snapshot.package, platform }) === true,
    )
    const variants = groupByPlatform({
      identity: edgeIdentity,
      platforms,
      project: (platform) => snapshotEdges({ companions, metadata, platform, snapshotKey }),
    }).map((group) => ({ edges: group.value, platforms: group.platforms }))
    const storeKey = snapshot.virtualStoreName
    const entry: PnpmStoreEntry = {
      bins: sidecar.packages[snapshot.package]?.bins ?? {},
      packageKey: snapshot.package,
      packageName: packageMetadata.name,
      packageTarget: packageMetadata.target,
      platforms,
      sccIndex: sccByStoreKey.get(storeKey),
      snapshot: snapshotKey,
      storeKey,
      target: pnpmTargetName({ prefix: 'entry', identity: snapshotKey }),
      variants,
    }
    const existing = entryByStoreKey.get(storeKey)
    if (existing !== undefined) return fail(`virtual store identity collision for ${storeKey}`)
    entryByStoreKey.set(storeKey, entry)
    entries.push(entry)
  }

  const edgesFor = ({
    platform,
    storeKey,
  }: {
    platform: PnpmPlatform
    storeKey: string
  }): PnpmStoreEdgeSet => {
    const entry = entryByStoreKey.get(storeKey)
    if (entry === undefined) return fail(`unknown store entry ${storeKey}`)
    const variant = entry.variants.find((candidate) => candidate.platforms.includes(platform))
    if (variant === undefined) return fail(`entry ${storeKey} is absent on ${platform}`)
    return variant.edges
  }

  const views = Object.keys(metadata.importers)
    .toSorted((left, right) => compareStrings({ left, right }))
    .map((importerPath): PnpmStoreView => {
      const importer = metadata.importers[importerPath]!
      const workspaceTrees: Record<string, string> = {}
      const variants = groupByPlatform({
        identity: (value: PnpmStoreViewVariant) =>
          JSON.stringify([edgeIdentity(value.direct), value.bins, value.closure]),
        platforms: pnpmPlatforms,
        project: (platform) => {
          const direct = importerEdges({ importer, metadata, platform })
          const closure = new Set<string>()
          const pending: string[] = []
          const enqueue = (edges: PnpmStoreEdgeSet): void => {
            for (const [, edge] of sortedEntries(edges)) {
              if (edge.kind === 'workspace') {
                workspaceTrees[edge.workspaceKey] = `//${edge.workspacePath}:package_tree`
                continue
              }
              if (closure.has(edge.storeKey) === true) continue
              closure.add(edge.storeKey)
              pending.push(edge.storeKey)
            }
          }
          enqueue(direct)
          while (pending.length > 0) {
            enqueue(edgesFor({ platform, storeKey: pending.pop()! }))
          }
          const bins: Record<string, string> = {}
          for (const [, edge] of sortedEntries(direct)) {
            if (edge.kind !== 'entry') continue
            const entry = entryByStoreKey.get(edge.storeKey)!
            for (const [binName, executable] of sortedEntries(entry.bins)) {
              const record = `${edge.storeKey}\t${executable}`
              const existing = bins[binName]
              if (
                existing !== undefined &&
                existing !== record &&
                pickRootBin({ binName, challenger: record, holder: existing }) === existing
              ) {
                continue
              }
              bins[binName] = record
            }
          }
          return {
            bins,
            closure: [...closure].toSorted((left, right) => compareStrings({ left, right })),
            direct,
            platforms: [],
          }
        },
      }).map((group) => ({ ...group.value, platforms: group.platforms }))
      return {
        importer: importerPath,
        target: pnpmTargetName({ prefix: 'view', identity: importerPath }),
        variants,
        workspaceTrees,
      }
    })

  return {
    entries,
    fingerprint: buck2SemanticFingerprint({
      generator: 'effect-utils/buck2/dependencies/pnpm-store',
      schemaVersion: 1,
      semanticData: { entries, sccs, views },
    }),
    sccs: sccs.map((members, index) => ({
      index,
      members,
      target: pnpmTargetName({ prefix: 'scc', identity: members.join('\n') }),
    })),
    schema: pnpmStoreProjectionSchema,
    views,
  }
}

/**
 * Entries whose lockfile dependency edges differ across admitted platforms.
 *
 * These are the only entries whose generated declaration needs a configured
 * `select()`; every other entry is platform-invariant even when its own
 * package is restricted to a subset of platforms by `cpu`/`os`/`libc`.
 */
export const platformVaryingEntries = (
  projection: PnpmStoreProjection,
): readonly PnpmStoreEntry[] => projection.entries.filter((entry) => entry.variants.length > 1)
