import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { buck2SemanticFingerprint } from '../../genie/buck2/mod.ts'

/** Schema identifier for the normalized pnpm lock metadata projection. */
export const pnpmLockMetadataSchema = 'effect-utils/buck2-pnpm-lock/v1' as const
/** Schema identifier for the derived archive sha256 sidecar. */
export const pnpmSha256SidecarSchema = 'effect-utils/buck2-pnpm-sha256/v1' as const

const lockGenerator = 'effect-utils/buck2/dependencies/pnpm-lock' as const
const sidecarGenerator = 'effect-utils/buck2/dependencies/pnpm-lock-sha256' as const
const sha256Pattern = /^[a-f0-9]{64}$/
const integrityPattern = /^sha512-([A-Za-z0-9+/]+={0,2})$/
const safePatchPathPattern = /^[A-Za-z0-9@_+./-]+$/

const virtualStoreComponentLimit = 120

const virtualStoreName = (key: string): string => {
  const expanded = key.replaceAll('/', '+').replaceAll('(', '_').replaceAll(')', '')
  if (Buffer.byteLength(expanded) <= virtualStoreComponentLimit) return expanded
  const suffix = `_${createHash('sha256').update(expanded).digest('hex').slice(0, 16)}`
  const prefixByteLimit = virtualStoreComponentLimit - suffix.length
  let prefixBytes = 0
  let prefixEnd = 0
  for (const character of expanded) {
    const characterBytes = Buffer.byteLength(character)
    if (prefixBytes + characterBytes > prefixByteLimit) break
    prefixBytes += characterBytes
    prefixEnd += character.length
  }
  return `${expanded.slice(0, prefixEnd)}${suffix}`
}

const compareStrings = ({ left, right }: { left: string; right: string }): number =>
  left < right ? -1 : left > right ? 1 : 0

const sortedEntries = <TValue>(record: Readonly<Record<string, TValue>>) =>
  Object.entries(record).toSorted(([left], [right]) => compareStrings({ left, right }))

const fail = (message: string): never => {
  throw new Error(`Invalid pnpm lock translation input: ${message}`)
}

type UnknownRecord = Record<string, unknown>

const recordAt = ({ value, location }: { value: unknown; location: string }): UnknownRecord => {
  if (value === null || Array.isArray(value) === true || typeof value !== 'object') {
    return fail(`${location} must be an object`)
  }
  return value as UnknownRecord
}

const recordField = ({
  record,
  field,
  location,
  required = false,
}: {
  record: UnknownRecord
  field: string
  location: string
  required?: boolean
}): UnknownRecord => {
  const value = record[field]
  if (value === undefined && required === false) return {}
  return recordAt({ value: value, location: `${location}.${field}` })
}

const stringField = ({
  record,
  field,
  location,
}: {
  record: UnknownRecord
  field: string
  location: string
}): string => {
  const value = record[field]
  if (typeof value !== 'string' || value.length === 0) {
    return fail(`${location}.${field} must be a non-empty string`)
  }
  return value
}

const optionalBooleanField = ({
  record,
  field,
  location,
}: {
  record: UnknownRecord
  field: string
  location: string
}): boolean | undefined => {
  const value = record[field]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') return fail(`${location}.${field} must be a boolean`)
  return value
}

const rejectUnknownFields = ({
  record,
  allowed,
  location,
}: {
  record: UnknownRecord
  allowed: readonly string[]
  location: string
}): void => {
  const allowedSet = new Set(allowed)
  const unknown = Object.keys(record).filter((field) => allowedSet.has(field) === false)
  if (unknown.length > 0) return fail(`${location} has unsupported fields: ${unknown.join(', ')}`)
}

const stringArrayField = ({
  record,
  field,
  location,
}: {
  record: UnknownRecord
  field: string
  location: string
}): readonly string[] => {
  const value = record[field]
  if (value === undefined) return []
  if (
    Array.isArray(value) === false ||
    value.some((entry) => typeof entry !== 'string' || entry.length === 0) === true
  ) {
    return fail(`${location}.${field} must be an array of non-empty strings`)
  }
  return [...value].toSorted((left, right) => compareStrings({ left, right }))
}

const parseStringRecord = ({
  value,
  location,
}: {
  value: unknown
  location: string
}): Readonly<Record<string, string>> => {
  const record = recordAt({ value: value, location: location })
  return Object.fromEntries(
    sortedEntries(record).map(([name, entry]) => {
      if (typeof entry !== 'string' || entry.length === 0) {
        return fail(`${location}.${name} must be a non-empty string`)
      }
      return [name, entry]
    }),
  )
}

const sha256 = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex')

const integrityBytes = ({
  integrity,
  location,
}: {
  integrity: string
  location: string
}): Uint8Array => {
  const match = integrityPattern.exec(integrity)
  if (match === null) return fail(`${location} must be a canonical sha512 integrity`)
  const encoded = match[1]
  if (encoded === undefined) return fail(`${location} must be a canonical sha512 integrity`)
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.byteLength !== 64 || bytes.toString('base64') !== encoded) {
    return fail(`${location} must encode exactly 64 sha512 bytes`)
  }
  return bytes
}

const verifyIntegrity = ({
  bytes,
  integrity,
  location,
}: {
  bytes: Uint8Array
  integrity: string
  location: string
}): void => {
  const expected = integrityBytes({ integrity: integrity, location: location })
  const actual = createHash('sha512').update(bytes).digest()
  if (actual.equals(expected) === false)
    return fail(`${location} does not match downloaded archive`)
}

const packageKeyParts = (key: string): { readonly name: string; readonly version: string } => {
  const delimiter =
    key.startsWith('@') === true ? key.indexOf('@', key.indexOf('/') + 1) : key.indexOf('@')
  if (delimiter <= 0 || delimiter === key.length - 1) return fail(`malformed package key ${key}`)
  return { name: key.slice(0, delimiter), version: key.slice(delimiter + 1) }
}

const suffixStart = (key: string): number => key.indexOf('(')

const baseSnapshotKey = (key: string): string => {
  const start = suffixStart(key)
  return start === -1 ? key : key.slice(0, start)
}

const snapshotSuffixes = (key: string): readonly string[] => {
  const start = suffixStart(key)
  if (start === -1) return []
  const suffixes: string[] = []
  let depth = 0
  let groupStart = -1
  for (let index = start; index < key.length; index += 1) {
    const character = key[index]
    if (character === '(') {
      if (depth === 0) groupStart = index + 1
      depth += 1
    } else if (character === ')') {
      depth -= 1
      if (depth < 0) return fail(`snapshot key ${key} has an unmatched closing parenthesis`)
      if (depth === 0) {
        const suffix = key.slice(groupStart, index)
        if (suffix.length === 0) return fail(`snapshot key ${key} has an empty identity suffix`)
        suffixes.push(suffix)
        if (index + 1 < key.length && key[index + 1] !== '(') {
          return fail(`snapshot key ${key} has trailing data outside identity suffixes`)
        }
      }
    }
  }
  if (depth !== 0) return fail(`snapshot key ${key} has an unmatched opening parenthesis`)
  return suffixes
}

const archiveUrl = ({ name, version }: { name: string; version: string }): string => {
  if (/^[A-Za-z0-9._+~-]+$/.test(version) === false) {
    return fail(`unsupported registry version ${name}@${version}`)
  }
  const tarballName = name.startsWith('@') === true ? name.slice(name.indexOf('/') + 1) : name
  return `https://registry.npmjs.org/${name}/-/${tarballName}-${version}.tgz`
}

/** Deterministic, collision-resistant Buck target name for one generated identity. */
export const pnpmTargetName = ({
  prefix,
  identity,
}: {
  prefix: string
  identity: string
}): string => {
  const readable = identity
    .replaceAll(/[^A-Za-z0-9_]+/g, '_')
    .replaceAll(/^_+|_+$/g, '')
    .slice(0, 72)
  return `${prefix}_${readable}_${sha256(identity).slice(0, 12)}`
}

/** Verified workspace patch metadata attached to a resolved archive package. */
export type PnpmPatchMetadata = {
  readonly hash: string
  readonly path: string
}

/** Normalized package-version metadata used by generated Buck targets. */
export type PnpmPackageMetadata = {
  readonly cpu: readonly string[]
  readonly hasBin: boolean
  readonly integrity?: string
  readonly libc: readonly string[]
  readonly name: string
  readonly os: readonly string[]
  readonly patch?: PnpmPatchMetadata
  readonly resolution: 'registry' | 'workspace'
  readonly target: string
  readonly url?: string
  readonly version: string
  readonly workspacePath?: string
}

/** A resolved dependency edge to either a peer-qualified snapshot or workspace importer. */
export type PnpmDependencyReference =
  | { readonly kind: 'package'; readonly snapshot: string }
  | { readonly kind: 'workspace'; readonly path: string }

/** Peer-qualified package snapshot and its resolved dependency edges. */
export type PnpmSnapshotMetadata = {
  readonly dependencies: Readonly<Record<string, PnpmDependencyReference>>
  readonly optional: boolean
  readonly optionalDependencies: Readonly<Record<string, PnpmDependencyReference>>
  readonly package: string
  readonly peerIdentities: readonly string[]
  readonly virtualStoreName: string
}

/** Direct dependency groups for one pnpm lock importer. */
export type PnpmImporterMetadata = {
  readonly dependencies: Readonly<Record<string, PnpmDependencyReference>>
  readonly devDependencies: Readonly<Record<string, PnpmDependencyReference>>
  readonly optionalDependencies: Readonly<Record<string, PnpmDependencyReference>>
  readonly target: string
}

/** Deterministic normalized projection of the supported pnpm v9 lockfile. */
export type PnpmLockMetadata = {
  readonly schema: typeof pnpmLockMetadataSchema
  readonly lockfileFingerprint: `sha256:${string}`
  readonly lockfileVersion: '9.0'
  readonly importers: Readonly<Record<string, PnpmImporterMetadata>>
  readonly packages: Readonly<Record<string, PnpmPackageMetadata>>
  readonly snapshots: Readonly<Record<string, PnpmSnapshotMetadata>>
}

/** Derived archive digest and executable metadata for one registry package. */
export type PnpmSha256Entry = {
  readonly bins: Readonly<Record<string, string>>
  readonly integrity: string
  readonly sha256: string
}

/** Freshness-gated, generated sha256 metadata consumed by Buck package declarations. */
export type PnpmSha256Sidecar = {
  readonly source: 'pnpm-lock.yaml'
  readonly generator: 'buck2/dependencies/pnpm-lock.sha256.json.genie.ts'
  readonly regenerate: 'devenv tasks run genie:run'
  readonly schema: typeof pnpmSha256SidecarSchema
  readonly lockfileFingerprint: `sha256:${string}`
  readonly packages: Readonly<Record<string, PnpmSha256Entry>>
  readonly fingerprint: `sha256:${string}`
}

/** Authored inputs and patch reader used by the strict lock translator. */
export type TranslatePnpmLockOptions = {
  readonly lockfileText: string
  readonly workspaceText: string
  readonly readPatch?: (patchPath: string) => Uint8Array
}

const parseYamlDocument = ({
  text,
  location,
}: {
  text: string
  location: string
}): UnknownRecord => {
  let value: unknown
  try {
    value = Bun.YAML.parse(text)
  } catch (error) {
    return fail(
      `${location} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (Array.isArray(value) === true)
    return fail(`${location} must contain exactly one YAML document`)
  return recordAt({ value: value, location: location })
}

const parseWorkspacePolicy = ({
  workspaceText,
  readPatch,
}: {
  workspaceText: string
  readPatch: (patchPath: string) => Uint8Array
}): Readonly<Record<string, PnpmPatchMetadata>> => {
  const workspace = parseYamlDocument({ text: workspaceText, location: 'pnpm-workspace.yaml' })
  if (workspace.ignoreScripts !== true)
    return fail('pnpm-workspace.yaml.ignoreScripts must be true')
  const allowBuilds = recordField({
    record: workspace,
    field: 'allowBuilds',
    location: 'pnpm-workspace.yaml',
  })
  const enabledBuilds = sortedEntries(allowBuilds).filter(([, enabled]) => enabled !== false)
  if (enabledBuilds.length > 0) {
    return fail(
      `lifecycle builds are unsupported; allowBuilds must contain only false values (${enabledBuilds.map(([name]) => name).join(', ')})`,
    )
  }
  const patches = parseStringRecord({
    value: workspace.patchedDependencies ?? {},
    location: 'pnpm-workspace.yaml.patchedDependencies',
  })
  return Object.fromEntries(
    sortedEntries(patches).map(([identity, patchPath]) => {
      if (
        safePatchPathPattern.test(patchPath) === false ||
        path.posix.isAbsolute(patchPath) === true ||
        path.posix.normalize(patchPath).startsWith('../') === true
      ) {
        return fail(`unsafe patched dependency path ${patchPath}`)
      }
      const bytes = readPatch(patchPath)
      return [identity, { hash: sha256(bytes), path: patchPath }]
    }),
  )
}

const parsePackageDependencyRecord = ({
  value,
  location,
}: {
  value: unknown
  location: string
}): Readonly<Record<string, string>> =>
  parseStringRecord({ value: value ?? {}, location: location })

/** Strictly parses pnpm v9 plus workspace patch policy into deterministic Buck metadata. */
export const translatePnpmLock = ({
  lockfileText,
  workspaceText,
  readPatch = (patchPath) => {
    if (existsSync(patchPath) === false)
      return fail(`patched dependency file does not exist: ${patchPath}`)
    return readFileSync(patchPath)
  },
}: TranslatePnpmLockOptions): PnpmLockMetadata => {
  const lock = parseYamlDocument({ text: lockfileText, location: 'pnpm-lock.yaml' })
  rejectUnknownFields({
    record: lock,
    allowed: [
      'lockfileVersion',
      'settings',
      'packageExtensionsChecksum',
      'patchedDependencies',
      'importers',
      'packages',
      'snapshots',
    ],
    location: 'pnpm-lock.yaml',
  })
  if (String(lock.lockfileVersion) !== '9.0') {
    return fail(
      `pnpm-lock.yaml.lockfileVersion must be exactly 9.0, got ${String(lock.lockfileVersion)}`,
    )
  }
  const settings = recordField({
    record: lock,
    field: 'settings',
    location: 'pnpm-lock.yaml',
    required: true,
  })
  rejectUnknownFields({
    record: settings,
    allowed: ['autoInstallPeers', 'excludeLinksFromLockfile', 'injectWorkspacePackages'],
    location: 'pnpm-lock.yaml.settings',
  })
  for (const field of ['autoInstallPeers', 'excludeLinksFromLockfile', 'injectWorkspacePackages']) {
    if (typeof settings[field] !== 'boolean')
      return fail(`pnpm-lock.yaml.settings.${field} must be a boolean`)
  }

  const workspacePatches = parseWorkspacePolicy({ workspaceText, readPatch })
  const lockedPatches = parseStringRecord({
    value: lock.patchedDependencies ?? {},
    location: 'pnpm-lock.yaml.patchedDependencies',
  })
  for (const [identity, lockedHash] of sortedEntries(lockedPatches)) {
    if (sha256Pattern.test(lockedHash) === false) {
      return fail(`pnpm-lock.yaml.patchedDependencies.${identity} must be a lowercase sha256`)
    }
    const patch = workspacePatches[identity]
    if (patch === undefined)
      return fail(`patched dependency ${identity} has no workspace patch source`)
    if (patch.hash !== lockedHash) {
      return fail(
        `patched dependency ${identity} hash mismatch: lock=${lockedHash} actual=${patch.hash}`,
      )
    }
  }
  const unmatchedWorkspacePatches = Object.keys(workspacePatches).filter(
    (identity) => lockedPatches[identity] === undefined,
  )
  if (unmatchedWorkspacePatches.length > 0) {
    return fail(`workspace patches missing from lockfile: ${unmatchedWorkspacePatches.join(', ')}`)
  }

  const packageRecords = recordField({
    record: lock,
    field: 'packages',
    location: 'pnpm-lock.yaml',
    required: true,
  })
  const packages: Record<string, PnpmPackageMetadata> = {}
  for (const [key, value] of sortedEntries(packageRecords)) {
    const location = `pnpm-lock.yaml.packages.${key}`
    const entry = recordAt({ value: value, location: location })
    rejectUnknownFields({
      record: entry,
      allowed: [
        'resolution',
        'engines',
        'peerDependencies',
        'hasBin',
        'peerDependenciesMeta',
        'cpu',
        'os',
        'libc',
        'bundledDependencies',
        'deprecated',
        'requiresBuild',
      ],
      location,
    })
    if (entry.requiresBuild === true) return fail(`${location}.requiresBuild is unsupported`)
    const resolution = recordField({
      record: entry,
      field: 'resolution',
      location: location,
      required: true,
    })
    const { name, version } = packageKeyParts(key)
    const hasBin =
      optionalBooleanField({ record: entry, field: 'hasBin', location: location }) ?? false
    const cpu = stringArrayField({ record: entry, field: 'cpu', location: location })
    const os = stringArrayField({ record: entry, field: 'os', location: location })
    const libc = stringArrayField({ record: entry, field: 'libc', location: location })
    if (resolution.type === 'directory') {
      rejectUnknownFields({
        record: resolution,
        allowed: ['directory', 'type'],
        location: `${location}.resolution`,
      })
      const directory = stringField({ record: resolution, field: 'directory', location: location })
      if (version.startsWith('file:') === false)
        return fail(`${location} directory resolution must use file:`)
      packages[key] = {
        cpu,
        hasBin,
        libc,
        name,
        os,
        resolution: 'workspace',
        target: pnpmTargetName({ prefix: 'workspace', identity: key }),
        version,
        workspacePath: directory,
      }
      continue
    }
    rejectUnknownFields({
      record: resolution,
      allowed: ['integrity'],
      location: `${location}.resolution`,
    })
    const integrity = stringField({ record: resolution, field: 'integrity', location: location })
    integrityBytes({ integrity: integrity, location: `${location}.resolution.integrity` })
    const patch = workspacePatches[`${name}@${version}`]
    packages[key] = {
      cpu,
      hasBin,
      integrity,
      libc,
      name,
      os,
      ...(patch === undefined ? {} : { patch }),
      resolution: 'registry',
      target: pnpmTargetName({ prefix: 'package', identity: key }),
      url: archiveUrl({ name, version }),
      version,
    }
  }

  const snapshotRecords = recordField({
    record: lock,
    field: 'snapshots',
    location: 'pnpm-lock.yaml',
    required: true,
  })
  const snapshotsByBase = new Map<string, string[]>()
  for (const key of Object.keys(snapshotRecords)) {
    const base = baseSnapshotKey(key)
    const candidates = snapshotsByBase.get(base) ?? []
    candidates.push(key)
    snapshotsByBase.set(base, candidates)
  }

  const resolveReference = ({
    dependencyName,
    importer,
    version,
    location,
  }: {
    dependencyName: string
    importer?: string
    version: string
    location: string
  }): PnpmDependencyReference => {
    if (version.startsWith('link:') === true) {
      if (importer === undefined)
        return fail(`${location} workspace link is only supported in an importer`)
      const linked = version.slice('link:'.length)
      if (linked.length === 0 || path.posix.isAbsolute(linked) === true)
        return fail(`${location} has unsafe workspace link`)
      const resolved = path.posix.normalize(
        path.posix.join(importer === '.' ? '' : importer, linked),
      )
      if (resolved === '..' || resolved.startsWith('../') === true)
        return fail(`${location} workspace link escapes the repository`)
      return { kind: 'workspace', path: resolved }
    }
    const aliasVersion =
      version.startsWith('npm:') === true ? version.slice('npm:'.length) : version
    const candidates = [`${dependencyName}@${aliasVersion}`, aliasVersion].filter(
      (candidate, index, all) => all.indexOf(candidate) === index,
    )
    for (const candidate of candidates) {
      if (snapshotRecords[candidate] !== undefined) return { kind: 'package', snapshot: candidate }
    }
    const baseCandidates = candidates.flatMap(
      (candidate) => snapshotsByBase.get(baseSnapshotKey(candidate)) ?? [],
    )
    const unique = [...new Set(baseCandidates)]
    if (unique.length === 1) return { kind: 'package', snapshot: unique[0]! }
    if (unique.length > 1) {
      return fail(`${location} has ambiguous peer identity; candidates: ${unique.join(', ')}`)
    }
    return fail(`${location} does not resolve to a snapshot (${dependencyName}@${version})`)
  }

  const snapshots: Record<string, PnpmSnapshotMetadata> = {}
  for (const [key, value] of sortedEntries(snapshotRecords)) {
    const location = `pnpm-lock.yaml.snapshots.${key}`
    const entry = recordAt({ value: value, location: location })
    if (entry.requiresBuild === true) return fail(`${location}.requiresBuild is unsupported`)
    rejectUnknownFields({
      record: entry,
      allowed: [
        'dependencies',
        'optionalDependencies',
        'transitivePeerDependencies',
        'optional',
        'requiresBuild',
      ],
      location,
    })
    const packageKey = baseSnapshotKey(key)
    const packageMetadata = packages[packageKey]
    if (packageMetadata === undefined)
      return fail(`${location} has no packages entry for ${packageKey}`)
    const suffixes = snapshotSuffixes(key)
    const patchSuffixes = suffixes.filter((suffix) => suffix.startsWith('patch_hash='))
    if (patchSuffixes.length > 1) return fail(`${location} has multiple patch identities`)
    if (packageMetadata.patch === undefined && patchSuffixes.length > 0) {
      return fail(`${location} names a patch but ${packageKey} has no patchedDependencies entry`)
    }
    if (packageMetadata.patch !== undefined) {
      const expected = `patch_hash=${packageMetadata.patch.hash}`
      if (patchSuffixes.length !== 1 || patchSuffixes[0] !== expected) {
        return fail(`${location} must carry exact patch identity ${expected}`)
      }
    }
    const parseDependencies = (field: 'dependencies' | 'optionalDependencies') =>
      Object.fromEntries(
        sortedEntries(
          parsePackageDependencyRecord({ value: entry[field], location: `${location}.${field}` }),
        ).map(([dependencyName, version]) => [
          dependencyName,
          resolveReference({
            dependencyName,
            version,
            location: `${location}.${field}.${dependencyName}`,
          }),
        ]),
      )
    snapshots[key] = {
      dependencies: parseDependencies('dependencies'),
      optional:
        optionalBooleanField({ record: entry, field: 'optional', location: location }) ?? false,
      optionalDependencies: parseDependencies('optionalDependencies'),
      package: packageKey,
      peerIdentities: suffixes.filter((suffix) => suffix.startsWith('patch_hash=') === false),
      virtualStoreName: virtualStoreName(key),
    }
  }

  const importerRecords = recordField({
    record: lock,
    field: 'importers',
    location: 'pnpm-lock.yaml',
    required: true,
  })
  const importers: Record<string, PnpmImporterMetadata> = {}
  for (const [importer, value] of sortedEntries(importerRecords)) {
    const location = `pnpm-lock.yaml.importers.${importer}`
    const entry = recordAt({ value: value, location: location })
    rejectUnknownFields({
      record: entry,
      allowed: ['dependencies', 'devDependencies', 'optionalDependencies', 'dependenciesMeta'],
      location,
    })
    const parseImporterDependencies = (
      field: 'dependencies' | 'devDependencies' | 'optionalDependencies',
    ): Readonly<Record<string, PnpmDependencyReference>> =>
      Object.fromEntries(
        sortedEntries(recordField({ record: entry, field: field, location: location })).map(
          ([dependencyName, dependencyValue]) => {
            const dependency = recordAt({
              value: dependencyValue,
              location: `${location}.${field}.${dependencyName}`,
            })
            rejectUnknownFields({
              record: dependency,
              allowed: ['specifier', 'version'],
              location: `${location}.${field}.${dependencyName}`,
            })
            const version = stringField({
              record: dependency,
              field: 'version',
              location: `${location}.${field}.${dependencyName}`,
            })
            return [
              dependencyName,
              resolveReference({
                dependencyName,
                importer,
                version,
                location: `${location}.${field}.${dependencyName}.version`,
              }),
            ]
          },
        ),
      )
    importers[importer] = {
      dependencies: parseImporterDependencies('dependencies'),
      devDependencies: parseImporterDependencies('devDependencies'),
      optionalDependencies: parseImporterDependencies('optionalDependencies'),
      target: pnpmTargetName({ prefix: 'importer', identity: importer }),
    }
  }

  const semanticLock = {
    lockfileVersion: '9.0',
    settings,
    packageExtensionsChecksum: lock.packageExtensionsChecksum,
    patchedDependencies: lockedPatches,
    importers: importerRecords,
    packages: packageRecords,
    snapshots: snapshotRecords,
  }
  return {
    schema: pnpmLockMetadataSchema,
    lockfileFingerprint: buck2SemanticFingerprint({
      generator: lockGenerator,
      schemaVersion: 1,
      semanticData: semanticLock,
    }),
    lockfileVersion: '9.0',
    importers,
    packages,
    snapshots,
  }
}

const decodeSidecarEntry = ({
  value,
  location,
}: {
  value: unknown
  location: string
}): PnpmSha256Entry => {
  const entry = recordAt({ value: value, location: location })
  rejectUnknownFields({ record: entry, allowed: ['bins', 'integrity', 'sha256'], location })
  const bins = parseStringRecord({ value: entry.bins, location: `${location}.bins` })
  const integrity = stringField({ record: entry, field: 'integrity', location: location })
  integrityBytes({ integrity: integrity, location: `${location}.integrity` })
  const digest = stringField({ record: entry, field: 'sha256', location: location })
  if (sha256Pattern.test(digest) === false)
    return fail(`${location}.sha256 must be lowercase sha256`)
  return { bins, integrity, sha256: digest }
}

/** Decodes and validates the committed sha256 sidecar schema. */
export const decodePnpmSha256Sidecar = (value: unknown): PnpmSha256Sidecar => {
  const sidecar = recordAt({ value: value, location: 'pnpm sha256 sidecar' })
  rejectUnknownFields({
    record: sidecar,
    allowed: [
      'schema',
      'source',
      'generator',
      'regenerate',
      'lockfileFingerprint',
      'packages',
      'fingerprint',
    ],
    location: 'pnpm sha256 sidecar',
  })
  if (sidecar.schema !== pnpmSha256SidecarSchema)
    return fail('pnpm sha256 sidecar has unsupported schema')
  if (sidecar.source !== 'pnpm-lock.yaml') return fail('pnpm sha256 sidecar has wrong source')
  if (sidecar.generator !== 'buck2/dependencies/pnpm-lock.sha256.json.genie.ts') {
    return fail('pnpm sha256 sidecar has wrong generator')
  }
  if (sidecar.regenerate !== 'devenv tasks run genie:run') {
    return fail('pnpm sha256 sidecar has wrong regeneration command')
  }
  const lockfileFingerprint = stringField({
    record: sidecar,
    field: 'lockfileFingerprint',
    location: 'pnpm sha256 sidecar',
  })
  const fingerprint = stringField({
    record: sidecar,
    field: 'fingerprint',
    location: 'pnpm sha256 sidecar',
  })
  if (/^sha256:[a-f0-9]{64}$/.test(lockfileFingerprint) === false) {
    return fail('pnpm sha256 sidecar lockfileFingerprint is malformed')
  }
  if (/^sha256:[a-f0-9]{64}$/.test(fingerprint) === false) {
    return fail('pnpm sha256 sidecar fingerprint is malformed')
  }
  const packages = Object.fromEntries(
    sortedEntries(
      recordField({
        record: sidecar,
        field: 'packages',
        location: 'pnpm sha256 sidecar',
        required: true,
      }),
    ).map(([key, entry]) => [
      key,
      decodeSidecarEntry({ value: entry, location: `pnpm sha256 sidecar.packages.${key}` }),
    ]),
  )
  return {
    schema: pnpmSha256SidecarSchema,
    lockfileFingerprint: lockfileFingerprint as `sha256:${string}`,
    source: 'pnpm-lock.yaml',
    generator: 'buck2/dependencies/pnpm-lock.sha256.json.genie.ts',
    regenerate: 'devenv tasks run genie:run',
    packages,
    fingerprint: fingerprint as `sha256:${string}`,
  }
}

const sidecarFingerprint = ({
  lockfileFingerprint,
  packages,
}: Pick<PnpmSha256Sidecar, 'lockfileFingerprint' | 'packages'>): `sha256:${string}` =>
  buck2SemanticFingerprint({
    generator: sidecarGenerator,
    schemaVersion: 1,
    semanticData: { lockfileFingerprint, packages },
  })

/** Fails when sidecar provenance, package identities, or derived data are stale. */
export const validatePnpmSha256Sidecar = ({
  metadata,
  sidecar,
}: {
  metadata: PnpmLockMetadata
  sidecar: PnpmSha256Sidecar
}): void => {
  if (sidecar.lockfileFingerprint !== metadata.lockfileFingerprint) {
    return fail(
      `stale sha256 sidecar lock fingerprint: expected ${metadata.lockfileFingerprint}, got ${sidecar.lockfileFingerprint}`,
    )
  }
  const expectedPackages = sortedEntries(metadata.packages)
    .filter(([, packageMetadata]) => packageMetadata.resolution === 'registry')
    .map(([key]) => key)
  const actualPackages = Object.keys(sidecar.packages).toSorted((left, right) =>
    compareStrings({ left, right }),
  )
  if (JSON.stringify(actualPackages) !== JSON.stringify(expectedPackages)) {
    return fail('stale sha256 sidecar package identity set')
  }
  for (const key of expectedPackages) {
    const packageMetadata = metadata.packages[key]
    const entry = sidecar.packages[key]
    if (packageMetadata === undefined || entry === undefined) {
      return fail(`stale sha256 sidecar package entry for ${key}`)
    }
    if (packageMetadata.integrity !== entry.integrity) {
      return fail(`stale sha256 sidecar integrity for ${key}`)
    }
    if (packageMetadata.hasBin !== Object.keys(entry.bins).length > 0) {
      return fail(`stale sha256 sidecar bin metadata for ${key}`)
    }
  }
  const expectedFingerprint = sidecarFingerprint(sidecar)
  if (sidecar.fingerprint !== expectedFingerprint) {
    return fail(
      `sha256 sidecar fingerprint mismatch: expected ${expectedFingerprint}, got ${sidecar.fingerprint}`,
    )
  }
}

const npmArchiveBins = async ({
  bytes,
  packageName,
}: {
  bytes: Uint8Array
  packageName: string
}): Promise<Readonly<Record<string, string>>> => {
  const body = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
  const stream = new Response(body).body
  if (stream === null) return fail(`archive for ${packageName} has no readable body`)
  let tar: Uint8Array
  try {
    tar = new Uint8Array(
      await new Response(stream.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer(),
    )
  } catch (error) {
    return fail(
      `archive for ${packageName} is not a readable gzip stream: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const decoder = new TextDecoder()
  let packageJson: unknown
  for (let offset = 0; offset + 512 <= tar.byteLength; ) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0) === true) break
    const textField = ({ start, length }: { start: number; length: number }): string => {
      const value = decoder.decode(header.subarray(start, start + length))
      const nul = value.indexOf('\0')
      return nul === -1 ? value : value.slice(0, nul)
    }
    const name = textField({ start: 0, length: 100 })
    const prefix = textField({ start: 345, length: 155 })
    const archivePath = prefix === '' ? name : `${prefix}/${name}`
    const sizeText = textField({ start: 124, length: 12 }).trim()
    if (/^[0-7]+$/.test(sizeText) === false)
      return fail(`archive for ${packageName} has malformed tar size`)
    const size = Number.parseInt(sizeText, 8)
    const contentStart = offset + 512
    const contentEnd = contentStart + size
    if (contentEnd > tar.byteLength)
      return fail(`archive for ${packageName} has truncated tar content`)
    if (archivePath === 'package/package.json') {
      try {
        packageJson = JSON.parse(decoder.decode(tar.subarray(contentStart, contentEnd)))
      } catch (error) {
        return fail(
          `archive for ${packageName} has malformed package.json: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      break
    }
    offset = contentStart + Math.ceil(size / 512) * 512
  }
  if (packageJson === undefined)
    return fail(`archive for ${packageName} has no package/package.json`)
  const manifest = recordAt({ value: packageJson, location: `archive ${packageName} package.json` })
  const binValue = manifest.bin
  const rawBins =
    typeof binValue === 'string'
      ? {
          [packageName.startsWith('@') === true
            ? packageName.slice(packageName.indexOf('/') + 1)
            : packageName]: binValue,
        }
      : parseStringRecord({ value: binValue, location: `archive ${packageName} package.json.bin` })
  return Object.fromEntries(
    sortedEntries(rawBins).map(([binName, executable]) => {
      const normalized = executable.startsWith('./') === true ? executable.slice(2) : executable
      if (
        binName.length === 0 ||
        binName.includes('/') === true ||
        path.posix.isAbsolute(normalized) === true ||
        normalized === '' ||
        path.posix.normalize(normalized) !== normalized ||
        normalized.startsWith('../') === true
      ) {
        return fail(`archive ${packageName} has unsafe bin entry ${binName} -> ${executable}`)
      }
      return [binName, normalized]
    }),
  )
}

/** Fetch seam used to retrieve integrity-pinned npm archives during generation. */
export type ArchiveFetcher = (url: string) => Promise<Uint8Array>

/** Downloads missing archives with bounded concurrency and derives a fresh sha256 sidecar. */
export const generatePnpmSha256Sidecar = async ({
  metadata,
  previous,
  fetchArchive = async (url) => {
    const response = await fetch(url)
    if (response.ok === false)
      return fail(`archive download failed (${response.status}) for ${url}`)
    return new Uint8Array(await response.arrayBuffer())
  },
  concurrency = 16,
}: {
  metadata: PnpmLockMetadata
  previous?: PnpmSha256Sidecar
  fetchArchive?: ArchiveFetcher
  concurrency?: number
}): Promise<PnpmSha256Sidecar> => {
  if (Number.isInteger(concurrency) === false || concurrency < 1)
    return fail('archive concurrency must be positive')
  const registryPackages = sortedEntries(metadata.packages).filter(
    (entry): entry is [string, PnpmPackageMetadata & { integrity: string; url: string }] =>
      entry[1].resolution === 'registry' &&
      entry[1].integrity !== undefined &&
      entry[1].url !== undefined,
  )
  const entries: (readonly [string, PnpmSha256Entry] | undefined)[] = Array.from({
    length: registryPackages.length,
  })
  let cursor = 0
  const worker = async (): Promise<void> => {
    const index = cursor
    cursor += 1
    if (index >= registryPackages.length) return
    const current = registryPackages[index]
    if (current === undefined) return fail(`missing registry package at index ${index}`)
    const [key, packageMetadata] = current
    const cached = previous?.packages[key]
    if (
      cached !== undefined &&
      cached.integrity === packageMetadata.integrity &&
      sha256Pattern.test(cached.sha256) === true &&
      (packageMetadata.hasBin === false || Object.keys(cached.bins).length > 0)
    ) {
      entries[index] = [key, cached]
      return worker()
    }
    const bytes = await fetchArchive(packageMetadata.url)
    verifyIntegrity({
      bytes,
      integrity: packageMetadata.integrity,
      location: `pnpm-lock.yaml.packages.${key}.resolution.integrity`,
    })
    const bins =
      packageMetadata.hasBin === true
        ? await npmArchiveBins({ bytes, packageName: packageMetadata.name })
        : {}
    if (packageMetadata.hasBin === true && Object.keys(bins).length === 0) {
      return fail(`pnpm-lock marks ${key} hasBin but its archive declares no bins`)
    }
    entries[index] = [key, { bins, integrity: packageMetadata.integrity, sha256: sha256(bytes) }]
    return worker()
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, registryPackages.length) }, async () => worker()),
  )
  const packages = Object.fromEntries(
    entries.map((entry, index) => entry ?? fail(`missing generated package at index ${index}`)),
  )
  const base = {
    schema: pnpmSha256SidecarSchema,
    lockfileFingerprint: metadata.lockfileFingerprint,
    packages,
    source: 'pnpm-lock.yaml',
    generator: 'buck2/dependencies/pnpm-lock.sha256.json.genie.ts',
    regenerate: 'devenv tasks run genie:run',
  } as const
  const sidecar: PnpmSha256Sidecar = { ...base, fingerprint: sidecarFingerprint(base) }
  validatePnpmSha256Sidecar({ metadata, sidecar })
  return sidecar
}
