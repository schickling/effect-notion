import { createHash } from 'node:crypto'
import * as PosixPath from 'node:path/posix'

import { Schema } from 'effect'

import {
  canonicalizeDistOverlayDeclarations,
  DistOverlayDeclaration as BuckMemberDistOverlaySchema,
  type DistOverlayDeclaration as BuckMemberDistOverlay,
} from '../overlays/dist-overlay-schema.ts'

export { BuckMemberDistOverlaySchema }
export type { BuckMemberDistOverlay }

/** Tracked member-manifest filename at each member root. */
export const BUCK_MEMBER_MANIFEST_FILENAME = 'buck2-member.json' as const
/** Generator ownership manifest path below the synthesized root. */
export const COMPOSITION_GENERATION_MANIFEST_PATH = '.megarepo/composition-generation.json' as const
/** Composition member, input, output, and ownership wire version. */
export const COMPOSITION_ROOT_SCHEMA_VERSION = 1 as const
/** Fleet-stable Buck output isolation directory. */
export const DEFAULT_BUCK_ISOLATION_DIR = 'megarepo' as const

const strictParseOptions = { errors: 'all', onExcessProperty: 'error' } as const
const textEncoder = new TextEncoder()

const compareCodeUnits = ({
  left,
  right,
}: {
  readonly left: string
  readonly right: string
}): number => (left < right ? -1 : left > right ? 1 : 0)

const canonicalStringSet = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(values)].toSorted((left, right) => compareCodeUnits({ left, right }))

const printableAscii = (value: string): boolean => /^[\x20-\x7e]+$/u.test(value)

const CellName = Schema.String.check(
  Schema.makeFilter<string>((value) =>
    /^[A-Za-z][A-Za-z0-9_-]*$/u.test(value) === true
      ? undefined
      : 'Expected a Buck cell name matching [A-Za-z][A-Za-z0-9_-]*',
  ),
).annotate({ identifier: 'Megarepo.BuckCellName' })

const MemberKey = Schema.String.check(
  Schema.makeFilter<string>((value) =>
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value) === true
      ? undefined
      : 'Expected a canonical one-segment member key',
  ),
).annotate({ identifier: 'Megarepo.BuckMemberKey' })

const MemberMount = Schema.String.check(
  Schema.makeFilter<string>((value) =>
    /^repos\/[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value) === true
      ? undefined
      : 'Expected a canonical mount path repos/<member-key>',
  ),
).annotate({ identifier: 'Megarepo.BuckMemberMount' })

const IgnorePattern = Schema.String.check(
  Schema.makeFilter<string>((value) => {
    if (
      printableAscii(value) === false ||
      value.includes(',') === true ||
      value.includes('\\') === true
    ) {
      return 'Expected a printable POSIX ignore pattern without comma or backslash'
    }
    if (
      value.startsWith('/') === true ||
      value.endsWith('/') === true ||
      value.includes('//') === true
    ) {
      return 'Expected a canonical relative ignore pattern'
    }
    const segments = value.split('/')
    return segments.some((segment) => segment === '' || segment === '.' || segment === '..') ===
      true
      ? 'Ignore patterns may not contain empty, dot, or parent segments'
      : undefined
  }),
).annotate({ identifier: 'Megarepo.BuckProjectIgnore' })

const CapabilityToken = Schema.String.check(
  Schema.makeFilter<string>((value) =>
    /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(value) === true
      ? undefined
      : 'Expected a non-empty capability token',
  ),
)

const CapabilityProtocol = Schema.String.check(
  Schema.makeFilter<string>((value) =>
    /^[A-Za-z0-9][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9][A-Za-z0-9._+-]*)*$/u.test(value) === true
      ? undefined
      : 'Expected a non-empty versioned capability protocol',
  ),
)

const CapabilityExecutable = Schema.String.check(
  Schema.makeFilter<string>((value) => {
    if (printableAscii(value) === false || value.includes('\\') === true) {
      return 'Expected a printable POSIX capability executable path'
    }
    if (
      value.startsWith('bin/') === false ||
      value === 'bin/' ||
      PosixPath.normalize(value) !== value
    ) {
      return 'Expected a canonical capability executable below bin/'
    }
    return value
      .split('/')
      .some((segment) => /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(segment) === false) === true
      ? 'Capability executable contains an invalid path segment'
      : undefined
  }),
).annotate({ identifier: 'Megarepo.BuckCapabilityExecutable' })

/** Nix systems a capability can be realized on. Absent means every admitted system. */
const CapabilitySystem = Schema.Literals(['x86_64-linux', 'aarch64-linux', 'aarch64-darwin'])

/**
 * One member-owned Nix executable capability. Toolchain pins remain hub-owned.
 *
 * `systems` scopes a capability whose Nix realization only exists on some admitted systems (for
 * example Bubblewrap, which is Linux-only because Darwin containment is a fixed system Seatbelt
 * capability instead). An absent `systems` means the capability is projected on every system.
 */
export const BuckMemberCapabilitySchema = Schema.Struct({
  toolId: CapabilityToken,
  protocol: CapabilityProtocol,
  flakePackage: CapabilityToken,
  executable: CapabilityExecutable,
  systems: Schema.optional(
    Schema.Array(CapabilitySystem).check(
      Schema.makeFilter<ReadonlyArray<typeof CapabilitySystem.Type>>((value) =>
        value.length === 0
          ? 'Expected at least one capability system'
          : new Set(value).size !== value.length
            ? 'Expected unique capability systems'
            : undefined,
      ),
    ),
  ),
}).annotate({ identifier: 'Megarepo.BuckMemberCapability' })
export type BuckMemberCapability = typeof BuckMemberCapabilitySchema.Type

/**
 * One toolchain kind whose concrete instance and pins are owned by the platform hub.
 *
 * `provides` names the Nix-realizable executables that constitute the toolchain, so every
 * capability the hub's Buck rules require is projected into every mount by the one resolver.
 * A kind that owns only a developer-time pin (pnpm) declares an empty list.
 */
export const BuckMemberToolchainAuthoritySchema = Schema.TaggedStruct('ToolchainAuthority', {
  toolchain: CapabilityToken,
  provides: Schema.Array(BuckMemberCapabilitySchema),
}).annotate({ identifier: 'Megarepo.BuckMemberToolchainAuthority' })
export type BuckMemberToolchainAuthority = typeof BuckMemberToolchainAuthoritySchema.Type

/** A member's explicit dependency on the platform hub's instance of one toolchain kind. */
export const BuckMemberToolchainRequirementSchema = Schema.TaggedStruct('ToolchainRequirement', {
  toolchain: CapabilityToken,
}).annotate({ identifier: 'Megarepo.BuckMemberToolchainRequirement' })
export type BuckMemberToolchainRequirement = typeof BuckMemberToolchainRequirementSchema.Type

/** Every capability form admitted in a tracked member manifest. */
export const BuckMemberManifestCapabilitySchema = Schema.Union([
  BuckMemberCapabilitySchema,
  BuckMemberToolchainAuthoritySchema,
  BuckMemberToolchainRequirementSchema,
]).annotate({ identifier: 'Megarepo.BuckMemberManifestCapability' })
export type BuckMemberManifestCapability = typeof BuckMemberManifestCapabilitySchema.Type

const isExecutableCapability = (
  capability: BuckMemberManifestCapability,
): capability is BuckMemberCapability => '_tag' in capability === false

/** Member-owned Nix capabilities, excluding declarative hub toolchain requirements. */
export const buckMemberExecutableCapabilities = (
  manifest: BuckMemberManifest,
): ReadonlyArray<BuckMemberCapability> => manifest.capabilities.filter(isExecutableCapability)

/**
 * Every Nix capability that must be projected into a mount of this member: member-owned
 * executables plus the executables that realize the hub toolchains this member is authority for.
 */
export const buckMemberProjectedCapabilities = (
  manifest: BuckMemberManifest,
): ReadonlyArray<BuckMemberCapability> => [
  ...buckMemberExecutableCapabilities(manifest),
  ...manifest.capabilities.flatMap((capability) =>
    isExecutableCapability(capability) === false && capability._tag === 'ToolchainAuthority'
      ? capability.provides
      : [],
  ),
]

/** One admitted Nix system a capability projection can be realized for. */
export type BuckMemberCapabilitySystem = typeof CapabilitySystem.Type

/**
 * The projected capabilities realizable on one system.
 *
 * A capability with an explicit `systems` list is skipped on every other system, so a
 * platform-scoped realization (Bubblewrap on Linux) never becomes a Darwin resolution failure.
 */
export const buckMemberProjectedCapabilitiesForSystem = ({
  manifest,
  system,
}: {
  readonly manifest: BuckMemberManifest
  readonly system: BuckMemberCapabilitySystem
}): ReadonlyArray<BuckMemberCapability> =>
  buckMemberProjectedCapabilities(manifest).filter(
    (capability) => capability.systems === undefined || capability.systems.includes(system),
  )

/** Find one declared member-owned Nix capability by its stable tool id. */
export const buckMemberCapabilityByToolId = ({
  manifest,
  toolId,
}: {
  readonly manifest: BuckMemberManifest
  readonly toolId: string
}): BuckMemberCapability | undefined =>
  buckMemberExecutableCapabilities(manifest).find((capability) => capability.toolId === toolId)

/** Strict tracked `buck2-member.json` wire schema, version 1. */
export const BuckMemberManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(COMPOSITION_ROOT_SCHEMA_VERSION),
  cell: CellName,
  mount: MemberMount,
  projectIgnore: Schema.Array(IgnorePattern),
  distOverlays: Schema.Array(BuckMemberDistOverlaySchema),
  capabilities: Schema.Array(BuckMemberManifestCapabilitySchema),
})
  .check(
    Schema.makeFilter((manifest) => {
      const tools = new Set<string>()
      const authorityKinds = new Set<string>()
      const requirementKinds = new Set<string>()
      for (const capability of manifest.capabilities) {
        if (isExecutableCapability(capability) === true) {
          if (tools.has(capability.toolId) === true) {
            return `Duplicate capability toolId: ${capability.toolId}`
          }
          tools.add(capability.toolId)
          continue
        }
        if (capability._tag === 'ToolchainAuthority') {
          if (authorityKinds.has(capability.toolchain) === true) {
            return `Duplicate toolchain authority: ${capability.toolchain}`
          }
          authorityKinds.add(capability.toolchain)
          for (const provided of capability.provides) {
            if (tools.has(provided.toolId) === true) {
              return `Duplicate capability toolId: ${provided.toolId}`
            }
            tools.add(provided.toolId)
          }
          continue
        }
        if (requirementKinds.has(capability.toolchain) === true) {
          return `Duplicate toolchain requirement: ${capability.toolchain}`
        }
        requirementKinds.add(capability.toolchain)
      }
      try {
        canonicalizeDistOverlayDeclarations(manifest.distOverlays)
        return undefined
      } catch (cause) {
        return cause instanceof Error ? cause.message : 'Invalid dist overlay declarations'
      }
    }),
  )
  .annotate({ identifier: 'Megarepo.BuckMemberManifest' })
export type BuckMemberManifest = typeof BuckMemberManifestSchema.Type

const normalizeDistOverlay = (overlay: BuckMemberDistOverlay): BuckMemberDistOverlay => ({
  target: overlay.target,
  destination: overlay.destination,
})

const canonicalCapabilitySystems = (
  systems: ReadonlyArray<typeof CapabilitySystem.Type>,
): ReadonlyArray<typeof CapabilitySystem.Type> =>
  [...new Set(systems)].toSorted((left, right) => compareCodeUnits({ left, right }))

const executableCapabilitySortKey = (capability: BuckMemberCapability): string =>
  `${capability.toolId}:${capability.protocol}:${capability.flakePackage}:${capability.executable}:${capability.systems === undefined ? '*' : canonicalCapabilitySystems(capability.systems).join(',')}`

const normalizeCapability = (
  capability: BuckMemberManifestCapability,
): BuckMemberManifestCapability => {
  if (isExecutableCapability(capability) === true) {
    return {
      toolId: capability.toolId,
      protocol: capability.protocol,
      flakePackage: capability.flakePackage,
      executable: capability.executable,
      ...(capability.systems === undefined
        ? {}
        : { systems: canonicalCapabilitySystems(capability.systems) }),
    }
  }
  if (capability._tag === 'ToolchainAuthority') {
    return {
      _tag: capability._tag,
      toolchain: capability.toolchain,
      provides: capability.provides
        .map((provided) => normalizeCapability(provided) as BuckMemberCapability)
        .toSorted((left, right) =>
          compareCodeUnits({
            left: executableCapabilitySortKey(left),
            right: executableCapabilitySortKey(right),
          }),
        ),
    }
  }
  return { _tag: capability._tag, toolchain: capability.toolchain }
}

const capabilitySortKey = (capability: BuckMemberManifestCapability): string => {
  if (isExecutableCapability(capability) === true) {
    return `0:${executableCapabilitySortKey(capability)}`
  }
  return capability._tag === 'ToolchainAuthority'
    ? `1:${capability.toolchain}`
    : `2:${capability.toolchain}`
}

/** Canonical member-manifest ordering used by both decoder and encoder. */
export const normalizeBuckMemberManifest = (manifest: BuckMemberManifest): BuckMemberManifest => ({
  schemaVersion: COMPOSITION_ROOT_SCHEMA_VERSION,
  cell: manifest.cell,
  mount: manifest.mount,
  projectIgnore: canonicalStringSet(manifest.projectIgnore),
  distOverlays: [...manifest.distOverlays]
    .map(normalizeDistOverlay)
    .toSorted(
      (left, right) =>
        compareCodeUnits({ left: left.target, right: right.target }) ||
        compareCodeUnits({ left: left.destination, right: right.destination }),
    ),
  capabilities: [...manifest.capabilities]
    .map(normalizeCapability)
    .toSorted((left, right) =>
      compareCodeUnits({ left: capabilitySortKey(left), right: capabilitySortKey(right) }),
    ),
})

/** Strictly decode and canonically normalize an untrusted member manifest. */
export const decodeBuckMemberManifest = (input: unknown): BuckMemberManifest =>
  normalizeBuckMemberManifest(
    Schema.decodeUnknownSync(BuckMemberManifestSchema, strictParseOptions)(input),
  )

/** Strictly encode a member manifest with canonical arrays. */
export const encodeBuckMemberManifest = (
  manifest: BuckMemberManifest,
): typeof BuckMemberManifestSchema.Encoded =>
  Schema.encodeSync(
    BuckMemberManifestSchema,
    strictParseOptions,
  )(normalizeBuckMemberManifest(manifest))

/** Strictly decode the tracked JSON representation. */
export const decodeBuckMemberManifestJson = (json: string): BuckMemberManifest =>
  decodeBuckMemberManifest(
    Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown), strictParseOptions)(json),
  )

/** Canonical tracked JSON bytes, including one trailing newline. */
export const encodeBuckMemberManifestJson = (manifest: BuckMemberManifest): string =>
  `${JSON.stringify(encodeBuckMemberManifest(manifest), undefined, 2)}\n`

const DecodedMemberSchema = Schema.Struct({
  memberKey: MemberKey,
  manifest: BuckMemberManifestSchema,
}).annotate({ identifier: 'Megarepo.CompositionDecodedMember' })
export type CompositionDecodedMember = typeof DecodedMemberSchema.Type

const IsolationDir = Schema.String.check(
  Schema.makeFilter<string>((value) =>
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value) === true
      ? undefined
      : 'Expected a fixed one-segment Buck isolation directory',
  ),
)

const ResolvedBuckExecutable = Schema.String.check(
  Schema.makeFilter<string>((value) => {
    if (printableAscii(value) === false || value.startsWith('/') === false || value === '/') {
      return 'Expected an absolute resolved Buck executable path'
    }
    return PosixPath.normalize(value) === value
      ? undefined
      : 'Expected a canonical absolute resolved Buck executable path'
  }),
)

const IniName = Schema.String.check(
  Schema.makeFilter<string>((value) =>
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value) === true
      ? undefined
      : 'Expected a canonical buckconfig section or key name',
  ),
)

const IniValue = Schema.String.check(
  Schema.makeFilter<string>((value) =>
    value.length > 0 && printableAscii(value) === true
      ? undefined
      : 'Expected a non-empty one-line buckconfig value',
  ),
)

/** One structured cache key/value entry. */
export const BuckCacheEntrySchema = Schema.Struct({
  key: IniName,
  value: IniValue,
}).annotate({ identifier: 'Megarepo.BuckCacheEntry' })
export type BuckCacheEntry = typeof BuckCacheEntrySchema.Type

const reservedBuckconfigSections = new Set([
  'cells',
  'cell_aliases',
  'external_cells',
  'parser',
  'build',
  'project',
])

/** One generator-injected cache-only buckconfig section. */
export const BuckCacheSectionSchema = Schema.Struct({
  section: IniName,
  entries: Schema.Array(BuckCacheEntrySchema),
})
  .check(
    Schema.makeFilter((cacheSection) => {
      if (reservedBuckconfigSections.has(cacheSection.section) === true) {
        return `Cache section may not replace generator-owned [${cacheSection.section}]`
      }
      const keys = new Set<string>()
      for (const entry of cacheSection.entries) {
        if (keys.has(entry.key) === true)
          return `Duplicate cache key: ${cacheSection.section}.${entry.key}`
        keys.add(entry.key)
      }
      return undefined
    }),
  )
  .annotate({ identifier: 'Megarepo.BuckCacheSection' })
export type BuckCacheSection = typeof BuckCacheSectionSchema.Type

/** Pure generator input. `isolationDir` defaults to `megarepo`; cache sections default empty. */
export const CompositionRootInputSchema = Schema.Struct({
  schemaVersion: Schema.Literal(COMPOSITION_ROOT_SCHEMA_VERSION),
  members: Schema.Array(DecodedMemberSchema),
  platformHubCell: CellName,
  isolationDir: Schema.optional(IsolationDir),
  cacheSections: Schema.optional(Schema.Array(BuckCacheSectionSchema)),
  additionalProjectIgnores: Schema.optional(Schema.Array(IgnorePattern)),
  resolvedBuckExecutable: ResolvedBuckExecutable,
}).annotate({ identifier: 'Megarepo.CompositionRootInput' })
export type CompositionRootInput = typeof CompositionRootInputSchema.Type

/** One member requirement resolved to the platform hub's unique toolchain authority. */
export interface ResolvedCompositionToolchainRequirement {
  readonly memberKey: string
  readonly memberCell: string
  readonly toolchain: string
  readonly authorityMemberKey: string
  readonly authorityCell: string
}

/** Canonically ordered, default-complete pure generator input. */
export interface NormalizedCompositionRootInput {
  readonly schemaVersion: 1
  readonly members: ReadonlyArray<CompositionDecodedMember>
  readonly platformHubCell: string
  readonly isolationDir: string
  readonly cacheSections: ReadonlyArray<BuckCacheSection>
  readonly additionalProjectIgnores: ReadonlyArray<string>
  readonly resolvedBuckExecutable: string
}

const reservedCellNames: Readonly<Record<string, true>> = {
  prelude: true,
  toolchains: true,
  workspace: true,
}

/** Resolve explicit member requirements to the sole platform-hub toolchain authority. */
export const resolveCompositionToolchainRequirements = ({
  members,
  platformHubCell,
}: {
  readonly members: ReadonlyArray<CompositionDecodedMember>
  readonly platformHubCell: string
}): ReadonlyArray<ResolvedCompositionToolchainRequirement> => {
  const hub = members.find((member) => member.manifest.cell === platformHubCell)
  if (hub === undefined) {
    throw new TypeError(`Platform hub cell is not a composition member: ${platformHubCell}`)
  }

  const authorityKinds = new Set<string>()
  const authorityToolIds = new Set<string>()
  for (const member of members) {
    for (const capability of member.manifest.capabilities) {
      if (isExecutableCapability(capability) === true || capability._tag !== 'ToolchainAuthority')
        continue
      if (member.memberKey !== hub.memberKey) {
        throw new TypeError(
          `Member ${member.memberKey} cannot declare toolchain authority '${capability.toolchain}'; authority belongs to platform hub ${hub.memberKey}`,
        )
      }
      authorityKinds.add(capability.toolchain)
      for (const provided of capability.provides) authorityToolIds.add(provided.toolId)
    }
  }

  const resolved: Array<ResolvedCompositionToolchainRequirement> = []
  for (const member of members) {
    const executableCapabilities = buckMemberExecutableCapabilities(member.manifest)
    if (member.memberKey !== hub.memberKey) {
      const conflictingCapability = executableCapabilities.find(
        ({ toolId }) => authorityKinds.has(toolId) || authorityToolIds.has(toolId),
      )
      if (conflictingCapability !== undefined) {
        throw new TypeError(
          `Member ${member.memberKey} cannot override hub toolchain '${conflictingCapability.toolId}' with a member-owned capability`,
        )
      }
    }
    for (const capability of member.manifest.capabilities) {
      if (isExecutableCapability(capability) === true || capability._tag !== 'ToolchainRequirement')
        continue
      if (authorityKinds.has(capability.toolchain) === false) {
        throw new TypeError(
          `Member ${member.memberKey} requires unknown hub toolchain '${capability.toolchain}'`,
        )
      }
      resolved.push({
        memberKey: member.memberKey,
        memberCell: member.manifest.cell,
        toolchain: capability.toolchain,
        authorityMemberKey: hub.memberKey,
        authorityCell: hub.manifest.cell,
      })
    }
  }
  return resolved.toSorted(
    (left, right) =>
      compareCodeUnits({ left: left.memberCell, right: right.memberCell }) ||
      compareCodeUnits({ left: left.toolchain, right: right.toolchain }),
  )
}

/** Strictly decode, validate cross-member invariants, and canonicalize generator input. */
export const decodeCompositionRootInput = (input: unknown): NormalizedCompositionRootInput => {
  const decoded = Schema.decodeUnknownSync(CompositionRootInputSchema, strictParseOptions)(input)
  if (decoded.members.length === 0) throw new TypeError('Composition requires at least one member')

  const memberKeys = new Set<string>()
  const cells = new Set<string>()
  const mounts = new Set<string>()
  const members = decoded.members.map(({ memberKey, manifest: rawManifest }) => {
    const manifest = normalizeBuckMemberManifest(rawManifest)
    const expectedMount = `repos/${memberKey}`
    if (manifest.mount !== expectedMount) {
      throw new TypeError(
        `Member ${memberKey} manifest mount disagreement: expected ${expectedMount}, got ${manifest.mount}`,
      )
    }
    if (reservedCellNames[manifest.cell] === true) {
      throw new TypeError(`Member ${memberKey} collides with reserved cell ${manifest.cell}`)
    }
    if (memberKeys.has(memberKey) === true)
      throw new TypeError(`Duplicate member key: ${memberKey}`)
    if (cells.has(manifest.cell) === true)
      throw new TypeError(`Duplicate member cell: ${manifest.cell}`)
    if (mounts.has(manifest.mount) === true)
      throw new TypeError(`Duplicate member mount: ${manifest.mount}`)
    memberKeys.add(memberKey)
    cells.add(manifest.cell)
    mounts.add(manifest.mount)
    return { memberKey, manifest }
  })

  if (cells.has(decoded.platformHubCell) === false) {
    throw new TypeError(`Platform hub cell is not a composition member: ${decoded.platformHubCell}`)
  }

  const cacheSectionNames = new Set<string>()
  const cacheSections = (decoded.cacheSections ?? []).map((section) => {
    if (cacheSectionNames.has(section.section) === true) {
      throw new TypeError(`Duplicate cache section: ${section.section}`)
    }
    if (
      section.section === 'buck2' &&
      section.entries.some((entry) => entry.key === 'file_watcher') === true
    ) {
      throw new TypeError('Composition root owns buck2.file_watcher')
    }
    cacheSectionNames.add(section.section)
    return {
      section: section.section,
      entries: [...section.entries].toSorted((left, right) =>
        compareCodeUnits({ left: left.key, right: right.key }),
      ),
    }
  })

  const normalizedMembers = members.toSorted((left, right) =>
    compareCodeUnits({ left: left.manifest.cell, right: right.manifest.cell }),
  )
  resolveCompositionToolchainRequirements({
    members: normalizedMembers,
    platformHubCell: decoded.platformHubCell,
  })
  return {
    schemaVersion: COMPOSITION_ROOT_SCHEMA_VERSION,
    members: normalizedMembers,
    platformHubCell: decoded.platformHubCell,
    isolationDir: decoded.isolationDir ?? DEFAULT_BUCK_ISOLATION_DIR,
    cacheSections: cacheSections.toSorted((left, right) =>
      compareCodeUnits({ left: left.section, right: right.section }),
    ),
    additionalProjectIgnores: canonicalStringSet(decoded.additionalProjectIgnores ?? []),
    resolvedBuckExecutable: decoded.resolvedBuckExecutable,
  }
}

/** Strictly encode generator input after applying all defaults and canonical ordering. */
export const encodeCompositionRootInput = (
  input: CompositionRootInput,
): typeof CompositionRootInputSchema.Encoded => {
  const normalized = decodeCompositionRootInput(input)
  return Schema.encodeSync(CompositionRootInputSchema, strictParseOptions)(normalized)
}

/** One generated relative path with its exact publication mode and bytes. */
export const GeneratedCompositionFileSchema = Schema.Struct({
  path: Schema.String.check(
    Schema.makeFilter<string>((value) => {
      if (
        printableAscii(value) === false ||
        value.startsWith('/') === true ||
        value.includes('\\') === true ||
        PosixPath.normalize(value) !== value
      ) {
        return 'Expected a canonical generated relative POSIX file path'
      }
      return value
        .split('/')
        .some((segment) => segment === '' || segment === '.' || segment === '..') === true
        ? 'Generated paths may not contain empty, dot, or parent segments'
        : undefined
    }),
  ),
  mode: Schema.Literals([0o644, 0o755]),
  bytes: Schema.Uint8Array,
}).annotate({ identifier: 'Megarepo.GeneratedCompositionFile' })
export type GeneratedCompositionFile = typeof GeneratedCompositionFileSchema.Type

/** Complete pure composition output with `.buckconfig` ordered last. */
export const CompositionRootOutputSchema = Schema.Struct({
  files: Schema.Array(GeneratedCompositionFileSchema),
})
  .check(
    Schema.makeFilter((output) => {
      const paths = new Set<string>()
      for (const file of output.files) {
        if (paths.has(file.path) === true) return `Duplicate generated path: ${file.path}`
        paths.add(file.path)
      }
      return output.files.at(-1)?.path === '.buckconfig'
        ? undefined
        : '.buckconfig must be the final publication authority'
    }),
  )
  .annotate({ identifier: 'Megarepo.CompositionRootOutput' })
export type CompositionRootOutput = typeof CompositionRootOutputSchema.Type

const Sha256 = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/u))

/** One non-self generated-file ownership record. */
export const CompositionGenerationManifestFileSchema = Schema.Struct({
  path: GeneratedCompositionFileSchema.fields.path,
  mode: GeneratedCompositionFileSchema.fields.mode,
  sha256: Sha256,
}).annotate({ identifier: 'Megarepo.CompositionGenerationManifestFile' })
export type CompositionGenerationManifestFile = typeof CompositionGenerationManifestFileSchema.Type

/** Canonical ownership manifest excluding its own recursive hash. */
export const CompositionGenerationManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(COMPOSITION_ROOT_SCHEMA_VERSION),
  files: Schema.Array(CompositionGenerationManifestFileSchema),
})
  .check(
    Schema.makeFilter((manifest) => {
      let previous: string | undefined
      for (const file of manifest.files) {
        if (file.path === COMPOSITION_GENERATION_MANIFEST_PATH) {
          return 'Generation manifest must not recursively hash itself'
        }
        if (previous !== undefined && previous >= file.path) {
          return 'Generation manifest files must be uniquely byte-sorted by path'
        }
        previous = file.path
      }
      return undefined
    }),
  )
  .annotate({ identifier: 'Megarepo.CompositionGenerationManifest' })
export type CompositionGenerationManifest = typeof CompositionGenerationManifestSchema.Type

/** Strictly decode a generated composition output. */
export const decodeCompositionRootOutput = (input: unknown): CompositionRootOutput =>
  Schema.decodeUnknownSync(CompositionRootOutputSchema, strictParseOptions)(input)

/** Strictly encode a generated composition output. */
export const encodeCompositionRootOutput = (
  output: CompositionRootOutput,
): typeof CompositionRootOutputSchema.Encoded =>
  Schema.encodeSync(CompositionRootOutputSchema, strictParseOptions)(output)

const ROOT_PROJECT_IGNORES = [
  '.git',
  '.devenv',
  'node_modules',
  '**/node_modules',
  '**/node_modules/**',
  'target',
  '**/target',
  '**/target/**',
  'tmp',
  'buck-out',
  'repos/.staging-*',
  '.buck2/capabilities.candidate.*',
] as const

const utf8 = (value: string): Uint8Array => textEncoder.encode(value)
const sha256 = (bytes: Uint8Array): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`

const renderBuckWrapper = (input: NormalizedCompositionRootInput): string => `#!/bin/sh
set -eu

case "$0" in
  */*) wrapper_path=$0 ;;
  *) wrapper_path=$(command -v "$0") ;;
esac
case "$wrapper_path" in
  /*) ;;
  *) wrapper_path=$PWD/$wrapper_path ;;
esac
while [ -L "$wrapper_path" ]; do
  wrapper_link=$(readlink "$wrapper_path")
  case "$wrapper_link" in
    /*) wrapper_path=$wrapper_link ;;
    *) wrapper_path=$(dirname -- "$wrapper_path")/$wrapper_link ;;
  esac
done
wrapper_dir=$(CDPATH= cd -- "$(dirname -- "$wrapper_path")" && pwd -P)
workspace_root=$(CDPATH= cd -- "$wrapper_dir/../.." && pwd -P)
update_lock="$workspace_root/.megarepo/workspace-update.lock"
if [ -e "$update_lock" ] || [ -L "$update_lock" ]; then
  printf '%s\\n' "megarepo buck2 wrapper: workspace update lock exists at $update_lock; recover the workspace update through mr before running Buck" >&2
  exit 75
fi

for arg in "$@"; do
  case "$arg" in
    --isolation-dir|--isolation-dir=*)
      printf '%s\\n' 'megarepo buck2 wrapper: --isolation-dir is fixed to ${input.isolationDir}' >&2
      exit 64
      ;;
  esac
done

exec ${shellQuote(input.resolvedBuckExecutable)} --isolation-dir ${shellQuote(input.isolationDir)} "$@"
`

const detectorValue = (input: NormalizedCompositionRootInput): ReadonlyArray<string> =>
  input.members.map(
    (member) =>
      `target:${member.manifest.cell}//...->${input.platformHubCell}//buck2/platforms:host_platform`,
  )

// Bundled Prelude coerces conventional `toolchains//` defaults while loading and parses
// `fbsource//` labels in JS select keys even when their branches are not selected. Point those
// spellings at live cells so module loading succeeds without generated stubs or extra identities.
const renderBuckconfig = (input: NormalizedCompositionRootInput): string => {
  const lines = [
    '[cells]',
    '  workspace = .',
    '  prelude = prelude',
    ...input.members.map((member) => `  ${member.manifest.cell} = ${member.manifest.mount}`),
    '',
    '[cell_aliases]',
    '  config = prelude',
    '  ovr_config = prelude',
    '  fbsource = prelude',
    `  toolchains = ${input.platformHubCell}`,
    '',
    '[external_cells]',
    '  prelude = bundled',
    '',
    '[parser]',
  ]

  const detectors = detectorValue(input)
  lines.push(
    detectors.length === 1
      ? `  target_platform_detector_spec = ${detectors[0]}`
      : `  target_platform_detector_spec = ${detectors[0]} \\`,
  )
  for (let index = 1; index < detectors.length; index += 1) {
    lines.push(`    ${detectors[index]}${index === detectors.length - 1 ? '' : ' \\'}`)
  }

  lines.push(
    '',
    '[build]',
    `  execution_platforms = ${input.platformHubCell}//buck2/platforms:host_execution_platform`,
  )

  const buck2Section = input.cacheSections.find(({ section }) => section === 'buck2')
  lines.push('', '[buck2]', '  file_watcher = watchman')
  for (const entry of buck2Section?.entries ?? []) lines.push(`  ${entry.key} = ${entry.value}`)

  for (const cacheSection of input.cacheSections) {
    if (cacheSection.section === 'buck2') continue
    lines.push('', `[${cacheSection.section}]`)
    for (const entry of cacheSection.entries) lines.push(`  ${entry.key} = ${entry.value}`)
  }

  const memberIgnores = input.members.flatMap(({ manifest }) =>
    manifest.projectIgnore.map((pattern) => `${manifest.mount}/${pattern}`),
  )
  lines.push(
    '',
    '[project]',
    `  ignore = ${canonicalStringSet([
      ...ROOT_PROJECT_IGNORES,
      ...input.additionalProjectIgnores,
      ...memberIgnores,
    ]).join(',')}`,
    '',
  )
  return lines.join('\n')
}

const generatedFile = ({
  path,
  mode,
  content,
}: {
  readonly path: string
  readonly mode: 0o644 | 0o755
  readonly content: string
}): GeneratedCompositionFile => ({ path, mode, bytes: utf8(content) })

const generationManifestFor = (
  files: ReadonlyArray<GeneratedCompositionFile>,
): CompositionGenerationManifest => ({
  schemaVersion: COMPOSITION_ROOT_SCHEMA_VERSION,
  files: [...files]
    .toSorted((left, right) => compareCodeUnits({ left: left.path, right: right.path }))
    .map((file) => ({ path: file.path, mode: file.mode, sha256: sha256(file.bytes) })),
})

const encodeGenerationManifest = (manifest: CompositionGenerationManifest): string => {
  const encoded = Schema.encodeSync(
    CompositionGenerationManifestSchema,
    strictParseOptions,
  )(manifest)
  return `${JSON.stringify(encoded, undefined, 2)}\n`
}

/**
 * Generate the complete composition-root byte plan. This function reads no filesystem,
 * environment, clock, or process state; all semantic inputs are explicit.
 */
export const generateCompositionRoot = (rawInput: CompositionRootInput): CompositionRootOutput => {
  const input = decodeCompositionRootInput(rawInput)
  const authority = generatedFile({
    path: '.buckconfig',
    mode: 0o644,
    content: renderBuckconfig(input),
  })
  const ownedFiles: ReadonlyArray<GeneratedCompositionFile> = [
    generatedFile({ path: '.buckroot', mode: 0o644, content: '' }),
    generatedFile({ path: 'BUCK', mode: 0o644, content: '' }),
    generatedFile({
      path: '.megarepo/bin/buck2',
      mode: 0o755,
      content: renderBuckWrapper(input),
    }),
    authority,
  ]
  const manifest = generatedFile({
    path: COMPOSITION_GENERATION_MANIFEST_PATH,
    mode: 0o644,
    content: encodeGenerationManifest(generationManifestFor(ownedFiles)),
  })
  const beforeAuthority = [
    ...ownedFiles.filter((file) => file.path !== '.buckconfig'),
    manifest,
  ].toSorted((left, right) => compareCodeUnits({ left: left.path, right: right.path }))
  return decodeCompositionRootOutput({ files: [...beforeAuthority, authority] })
}
