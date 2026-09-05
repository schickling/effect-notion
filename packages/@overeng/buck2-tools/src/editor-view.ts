#!/usr/bin/env -S bun
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import process from 'node:process'

import { canonicalizeParent } from './real-path.ts'

/** Versioned identity of the persisted scoped editor-view record. */
export const editorViewSchema = 'effect-utils/editor-view/v2' as const
/** Versioned contract proving that every required workspace package is Buck-owned. */
export const workspaceDependencyAuthoritySchema =
  'effect-utils/workspace-dependency-authority/v1' as const
const snapshotRetentionSchema = 'effect-utils/editor-view-retention/v1' as const
const treeDigestSchema = 'effect-utils/tree-digest/v1' as const
const fingerprintPattern = /^[0-9a-f]{64}$/
/** View names are embedded verbatim in snapshot names and derived patterns. */
const viewNamePattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const cellPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const targetNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const copyLabel = 'cp --dereference --reflink=auto'
const finiteCopyLabel = 'cp --no-dereference --reflink=auto'
const lockSchema = 'effect-utils/editor-view-lock/v1' as const
const authorityRecordFields = ['ownedPackages', 'requiredPackages', 'schema'] as const
const retentionRecordFields = ['schema', 'snapshots'] as const
const snapshotNamePattern = (viewName: string): RegExp => new RegExp(`^${viewName}-([0-9a-f]{64})$`)
const editorViewRecordFields = [
  'byteSnapshotDigest',
  'cell',
  'editorInputsFingerprint',
  'normalizedStoreDigest',
  'package',
  'schema',
  'selectedViewDigest',
  'snapshot',
  'target',
] as const
const lockRecordFields = ['pid', 'schema', 'token'] as const

type JsonRecord = { [key: string]: unknown }

/** Persisted identity and content evidence for one immutable editor snapshot. */
export type EditorViewRecord = {
  readonly schema: typeof editorViewSchema
  readonly package: string
  readonly cell: string
  readonly target: string
  readonly editorInputsFingerprint: string
  readonly snapshot: string
  /** Digest of the admitted finite declared-root graph (legacy: dereferenced bytes). */
  readonly normalizedStoreDigest: string
  /** Digest of the selected view exactly as admitted, links included. */
  readonly selectedViewDigest: string
  /** Digest of every byte-owned snapshot payload root and its relocated links. */
  readonly byteSnapshotDigest: string
}
/** Explicit whole-workspace dependency ownership assertion consumed by publication. */
export type WorkspaceDependencyAuthority = {
  readonly schema: typeof workspaceDependencyAuthoritySchema
  readonly requiredPackages: readonly string[]
  readonly ownedPackages: readonly string[]
}

type SnapshotRetentionRecord = {
  readonly schema: typeof snapshotRetentionSchema
  readonly snapshots: readonly string[]
}

/** Explicit paths, identity, and immutable publication tools for one scoped package view. */
export type EditorViewOptions = {
  readonly repoRoot: string
  readonly package: string
  /** Snapshot store, current-pointer, and first-hop identity segment. */
  readonly viewName: string
  readonly cell: string
  readonly target: string
  readonly editorInputs: string
  /**
   * Provider-declared artifact roots that may back normalized links in `nodeModules`.
   * Omission preserves the legacy tree-confined policy.
   */
  readonly backingRoots?: readonly string[]
  readonly nodeModules: string
  readonly cp: string
  readonly mv: string
  readonly workspaceAuthority: string
  readonly consumerCache: string
  readonly snapshotRetention: number
}

type ViewPaths = {
  readonly repoRoot: string
  readonly packageDir: string
  readonly viewName: string
  readonly editorRoot: string
  readonly storeDir: string
  readonly legacyDir: string
  readonly current: string
  readonly firstHop: string
  readonly firstHopTarget: string
  readonly consumerCache: string
  readonly retentionRecord: string
}

type CheckContext = {
  recordedFingerprint: string
  readonly currentFingerprint: string
}

const fail: (message: string) => never = (message) => {
  throw new Error(`editor view: ${message}`)
}

const failCheck = ({ message, context }: { message: string; context: CheckContext }): never => {
  return fail(
    `${message}; recorded fingerprint=${context.recordedFingerprint}; current fingerprint=${context.currentFingerprint}`,
  )
}

const compareBytes = ({ left, right }: { left: string; right: string }): number =>
  Buffer.from(left).compare(Buffer.from(right))

const u64 = (value: bigint): Buffer => {
  const framed = Buffer.allocUnsafe(8)
  framed.writeBigUInt64BE(value)
  return framed
}

const frame = (value: string): readonly [Buffer, Buffer] => {
  const encoded = Buffer.from(value)
  return [u64(BigInt(encoded.byteLength)), encoded]
}

const pathExists = (path: string): boolean => {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (isNodeErrorCode({ error, code: 'ENOENT' }) === true) return false
    throw error
  }
}

const isNodeErrorCode = ({ error, code }: { error: unknown; code: string }): boolean =>
  error instanceof Error && 'code' in error && error.code === code

const requireDirectory = ({ path, field }: { path: string; field: string }): void => {
  let status
  try {
    status = lstatSync(path)
  } catch (error) {
    return fail(
      `${field} is missing: ${path} (${error instanceof Error ? error.message : String(error)})`,
    )
  }
  if (status.isSymbolicLink() === true || status.isDirectory() === false)
    fail(`${field} must be a real directory: ${path}`)
}

const ensureRealDirectory = ({ path, field }: { path: string; field: string }): void => {
  if (existsSync(path) === false) mkdirSync(path)
  requireDirectory({ path, field })
}

const streamFileIntoHash = async ({
  path,
  hash,
}: {
  path: string
  hash: ReturnType<typeof createHash>
}) => {
  for await (const chunk of createReadStream(path)) hash.update(chunk)
}

/** Inputs of {@link canonicalTreeFingerprint}: the tree to hash and its dereferencing mode. */
export type CanonicalTreeFingerprintOptions = {
  /** Tree whose byte-sorted contents are hashed. */
  readonly tree: string
  /**
   * Resolve symbolic links into the entry they denote, exactly as a dereferencing
   * byte copy does. Links that cannot resolve, close a cycle, or resolve outside
   * both the tree and an explicitly declared backing root fail closed.
   */
  readonly dereference?: boolean
  /** Canonical provider-owned roots whose contents a dereferenced tree may reference. */
  readonly backingRoots?: readonly string[]
}

/**
 * Hash a tree with byte-sorted portable paths and length-framed entry data.
 * Directory, regular-file, and symlink kinds are distinct; special files fail closed.
 */
export const canonicalTreeFingerprint = async ({
  tree,
  dereference = false,
  backingRoots = [],
}: CanonicalTreeFingerprintOptions): Promise<string> => {
  const absoluteTree = resolve(tree)
  requireDirectory({ path: absoluteTree, field: 'tree input' })
  const treeRoot = realpathSync(absoluteTree)
  const canonicalBackingRoots = backingRoots.map((root) => {
    const absoluteRoot = resolve(root)
    requireDirectory({ path: absoluteRoot, field: 'declared backing root' })
    return realpathSync(absoluteRoot)
  })
  const hash = createHash('sha256')
  hash.update(treeDigestSchema)
  hash.update(Buffer.from([0]))

  const visit = async ({
    relativePath,
    absolutePath,
    ancestors,
  }: {
    relativePath: string
    absolutePath: string
    ancestors: ReadonlySet<string>
  }): Promise<void> => {
    const before = lstatSync(absolutePath, { bigint: true })
    const [pathLength, pathBytes] = frame(relativePath)
    if (before.isSymbolicLink() === true && dereference === true) {
      const target = readlinkSync(absolutePath)
      let resolved: string
      try {
        resolved = realpathSync(absolutePath)
      } catch (error) {
        return fail(
          `tree contains an unresolvable symbolic link: ${absolutePath} (${error instanceof Error ? error.message : String(error)})`,
        )
      }
      if (
        isWithin({ root: treeRoot, candidate: resolved }) === false &&
        canonicalBackingRoots.some((root) => isWithin({ root, candidate: resolved })) === false
      )
        fail(
          `tree symbolic link resolves outside declared backing roots: ${absolutePath} -> ${resolved}`,
        )
      await visit({ relativePath, absolutePath: resolved, ancestors })
      const after = lstatSync(absolutePath, { bigint: true })
      if (
        after.isSymbolicLink() === false ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs ||
        readlinkSync(absolutePath) !== target
      )
        fail(`tree changed while hashing: ${absolutePath}`)
      return
    }
    if (before.isDirectory() === true) {
      const identity = `${before.dev}:${before.ino}`
      if (ancestors.has(identity) === true)
        fail(`tree contains a dereference cycle: ${absolutePath}`)
      hash.update(Buffer.from('D'))
      hash.update(pathLength)
      hash.update(pathBytes)
      const names = readdirSync(absolutePath).toSorted((left, right) =>
        compareBytes({ left, right }),
      )
      await visitNames({
        names,
        parent: relativePath,
        directory: absolutePath,
        ancestors: new Set([...ancestors, identity]),
      })
      const after = lstatSync(absolutePath, { bigint: true })
      if (
        after.isDirectory() === false ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs
      )
        fail(`tree changed while hashing: ${absolutePath}`)
      return
    }
    if (before.isSymbolicLink() === true) {
      const target = readlinkSync(absolutePath)
      const [targetLength, targetBytes] = frame(target)
      hash.update(Buffer.from('L'))
      hash.update(pathLength)
      hash.update(pathBytes)
      hash.update(targetLength)
      hash.update(targetBytes)
      const after = lstatSync(absolutePath, { bigint: true })
      if (
        after.isSymbolicLink() === false ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs ||
        readlinkSync(absolutePath) !== target
      )
        fail(`tree changed while hashing: ${absolutePath}`)
      return
    }
    if (before.isFile() === false) fail(`tree contains unsupported special file: ${absolutePath}`)
    hash.update(Buffer.from('F'))
    hash.update(pathLength)
    hash.update(pathBytes)
    hash.update(u64(before.size))
    await streamFileIntoHash({ path: absolutePath, hash })
    const after = lstatSync(absolutePath, { bigint: true })
    if (
      after.isFile() === false ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    )
      fail(`tree changed while hashing: ${absolutePath}`)
  }

  const visitNames = async ({
    names,
    parent,
    directory,
    ancestors,
    index = 0,
  }: {
    names: readonly string[]
    parent: string
    directory: string
    ancestors: ReadonlySet<string>
    index?: number
  }): Promise<void> => {
    const name = names[index]
    if (name === undefined) return
    await visit({
      relativePath: parent.length === 0 ? name : `${parent}/${name}`,
      absolutePath: join(directory, name),
      ancestors,
    })
    await visitNames({ names, parent, directory, ancestors, index: index + 1 })
  }

  const rootBefore = lstatSync(absoluteTree, { bigint: true })
  const names = readdirSync(absoluteTree).toSorted((left, right) => compareBytes({ left, right }))
  await visitNames({
    names,
    parent: '',
    directory: absoluteTree,
    ancestors: new Set([`${rootBefore.dev}:${rootBefore.ino}`]),
  })
  const rootAfter = lstatSync(absoluteTree, { bigint: true })
  if (
    rootAfter.isDirectory() === false ||
    rootAfter.dev !== rootBefore.dev ||
    rootAfter.ino !== rootBefore.ino ||
    rootAfter.mtimeNs !== rootBefore.mtimeNs ||
    rootAfter.ctimeNs !== rootBefore.ctimeNs
  )
    fail(`tree changed while hashing: ${absoluteTree}`)
  return hash.digest('hex')
}

const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && Array.isArray(value) === false && typeof value === 'object'
const isUnknownArray = (value: unknown): value is readonly unknown[] => Array.isArray(value)

const readRecord = (path: string): EditorViewRecord => {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return fail(`invalid record ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (isRecord(value) === false) return fail(`record must be a JSON object: ${path}`)
  const record = value
  // A store published under an earlier record schema cannot be validated or
  // repaired in place: its snapshot was materialized under different ownership
  // rules, so it must be removed before republication.
  const declaredSchema = record.schema
  if (
    typeof declaredSchema === 'string' &&
    declaredSchema.startsWith('effect-utils/editor-view/') === true &&
    declaredSchema !== editorViewSchema
  )
    return fail(
      `record ${path} was published by incompatible editor view schema ${declaredSchema}; expected ${editorViewSchema}: delete the legacy .editor-view store and republish`,
    )
  if (
    JSON.stringify(Object.keys(record).toSorted((left, right) => compareBytes({ left, right }))) !==
    JSON.stringify(editorViewRecordFields)
  )
    return fail(`record has unknown or missing fields: ${path}`)
  const schema = record.schema
  const packageName = record.package
  const cell = record.cell
  const target = record.target
  const editorInputsFingerprint = record.editorInputsFingerprint
  const snapshot = record.snapshot
  const normalizedStoreDigest = record.normalizedStoreDigest
  const selectedViewDigest = record.selectedViewDigest
  const byteSnapshotDigest = record.byteSnapshotDigest
  if (
    schema !== editorViewSchema ||
    typeof packageName !== 'string' ||
    typeof cell !== 'string' ||
    typeof target !== 'string' ||
    typeof editorInputsFingerprint !== 'string' ||
    fingerprintPattern.test(editorInputsFingerprint) === false ||
    typeof snapshot !== 'string' ||
    typeof normalizedStoreDigest !== 'string' ||
    fingerprintPattern.test(normalizedStoreDigest) === false ||
    typeof selectedViewDigest !== 'string' ||
    fingerprintPattern.test(selectedViewDigest) === false ||
    typeof byteSnapshotDigest !== 'string' ||
    fingerprintPattern.test(byteSnapshotDigest) === false
  )
    return fail(`record does not conform to ${editorViewSchema}: ${path}`)
  return {
    schema,
    package: packageName,
    cell,
    target,
    editorInputsFingerprint,
    snapshot,
    normalizedStoreDigest,
    selectedViewDigest,
    byteSnapshotDigest,
  }
}

const requirePortablePackage = (value: string): string => {
  if (
    value.length === 0 ||
    isAbsolute(value) === true ||
    value.includes('\\') === true ||
    value
      .split('/')
      .some((component) => component === '' || component === '.' || component === '..') === true
  )
    fail(`package must be a normalized repository-relative path: ${value}`)
  return value
}
const requireSortedUniquePackages = ({
  value,
  field,
}: {
  value: unknown
  field: string
}): readonly string[] => {
  const entries =
    isUnknownArray(value) === true ? value : fail(`${field} must be an array of package paths`)
  const packages: string[] = []
  for (const entry of entries) {
    const packagePath =
      typeof entry === 'string' ? entry : fail(`${field} must be an array of package paths`)
    packages.push(requirePortablePackage(packagePath))
  }
  const sorted = packages.toSorted((left, right) => compareBytes({ left, right }))
  if (
    new Set(packages).size !== packages.length ||
    JSON.stringify(packages) !== JSON.stringify(sorted)
  )
    fail(`${field} must be byte-sorted with no duplicates`)
  return packages
}
const requireSnapshotNames = ({
  value,
  path,
  viewName,
}: {
  value: unknown
  path: string
  viewName: string
}): readonly string[] => {
  const pattern = snapshotNamePattern(viewName)
  const entries =
    isUnknownArray(value) === true
      ? value
      : fail(`snapshot retention record does not conform to ${snapshotRetentionSchema}: ${path}`)
  const snapshots: string[] = []
  for (const entry of entries) {
    const snapshot =
      typeof entry === 'string' && pattern.test(entry) === true
        ? entry
        : fail(`snapshot retention record does not conform to ${snapshotRetentionSchema}: ${path}`)
    snapshots.push(snapshot)
  }
  if (new Set(snapshots).size !== snapshots.length)
    fail(`snapshot retention record does not conform to ${snapshotRetentionSchema}: ${path}`)
  return snapshots
}

/** Validate exact Buck ownership of the declared whole workspace. */
export const validateWorkspaceDependencyAuthority = ({
  path,
  repoRoot,
  packageName,
}: {
  path: string
  repoRoot: string
  packageName: string
}): WorkspaceDependencyAuthority => {
  // `path` is caller-supplied and may arrive absolute in a different namespace
  // than the canonical repository root, in which case `resolve` returns it
  // unchanged and the containment check compares two namespaces. The final
  // component stays verbatim so the symlink guard below still sees a symlink.
  const authorityPath = canonicalizeParent(resolve(repoRoot, path))
  if (isWithin({ root: repoRoot, candidate: authorityPath }) === false)
    fail(`workspace authority manifest escapes repository: ${authorityPath}`)
  const status = lstatSync(authorityPath)
  if (status.isFile() === false || status.isSymbolicLink() === true)
    fail(`workspace authority manifest must be a regular file: ${authorityPath}`)
  let value: unknown
  try {
    value = JSON.parse(readFileSync(authorityPath, 'utf8'))
  } catch (error) {
    return fail(
      `invalid workspace authority manifest ${authorityPath}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const authority =
    isRecord(value) === true ? value : fail(`workspace authority manifest must be a JSON object`)
  if (
    JSON.stringify(
      Object.keys(authority).toSorted((left, right) => compareBytes({ left, right })),
    ) !== JSON.stringify(authorityRecordFields)
  )
    fail(`workspace authority manifest has unknown or missing fields: ${authorityPath}`)
  if (authority.schema !== workspaceDependencyAuthoritySchema)
    fail(`workspace authority manifest does not conform to ${workspaceDependencyAuthoritySchema}`)
  const requiredPackages = requireSortedUniquePackages({
    value: authority.requiredPackages,
    field: 'requiredPackages',
  })
  const ownedPackages = requireSortedUniquePackages({
    value: authority.ownedPackages,
    field: 'ownedPackages',
  })
  const required = new Set(requiredPackages)
  const owned = new Set(ownedPackages)
  const missing = requiredPackages.filter((entry) => owned.has(entry) === false)
  const extra = ownedPackages.filter((entry) => required.has(entry) === false)
  if (missing.length > 0 || extra.length > 0)
    fail(
      `whole-workspace dependency authority mismatch: missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`,
    )
  if (owned.has(packageName) === false)
    fail(`published package is absent from whole-workspace dependency authority: ${packageName}`)
  for (const entry of requiredPackages) {
    const packageDir = resolve(repoRoot, entry)
    requireDirectory({ path: packageDir, field: `authority package ${entry}` })
    if (realpathSync(packageDir) !== packageDir)
      fail(`authority package path must not contain symbolic links: ${packageDir}`)
    const manifest = join(packageDir, 'package.json')
    if (lstatSync(manifest).isFile() === false)
      fail(`authority package manifest is not a regular file: ${manifest}`)
  }
  return {
    schema: workspaceDependencyAuthoritySchema,
    requiredPackages,
    ownedPackages,
  }
}

const isWithin = ({ root, candidate }: { root: string; candidate: string }): boolean => {
  const pathFromRoot = relative(root, candidate)
  return (
    pathFromRoot === '' ||
    (isAbsolute(pathFromRoot) === false &&
      pathFromRoot !== '..' &&
      pathFromRoot.startsWith('../') === false)
  )
}

const requireViewName = (viewName: string): string => {
  if (viewNamePattern.test(viewName) === false || viewName.length > 64)
    fail(`view name must be a portable identifier without dots: ${viewName}`)
  return viewName
}

/** Repository-relative package path reduced to its stable view-name default. */
export const defaultEditorViewName = (packagePath: string): string => {
  const segments = requirePortablePackage(packagePath).split('/')
  return requireViewName(segments[segments.length - 1] ?? packagePath)
}

const makePaths = (options: EditorViewOptions): ViewPaths => {
  const viewName = requireViewName(options.viewName)
  if (
    Number.isSafeInteger(options.snapshotRetention) === false ||
    options.snapshotRetention < 2 ||
    options.snapshotRetention > 32
  )
    fail(`snapshot retention must be an integer from 2 through 32`)
  const repoRoot = realpathSync(options.repoRoot)
  requireDirectory({ path: repoRoot, field: 'repository root' })
  const packagePath = requirePortablePackage(options.package)
  const packageDir = resolve(repoRoot, packagePath)
  if (isWithin({ root: repoRoot, candidate: packageDir }) === false)
    fail(`package escapes repository root: ${packagePath}`)
  requireDirectory({ path: packageDir, field: 'package directory' })
  if (realpathSync(packageDir) !== packageDir)
    fail(`package path must not contain symbolic links: ${packageDir}`)
  const editorRoot = resolve(packageDir, '..', '..', '.editor-view')
  if (isWithin({ root: repoRoot, candidate: editorRoot }) === false)
    fail(`editor root escapes repository: ${editorRoot}`)
  // The consumer cache is the one path a caller supplies absolutely, so it can
  // arrive in a different namespace than the canonical repository root (macOS
  // `/tmp` vs `/private/tmp`). Canonicalize it before every containment check.
  const consumerCache = canonicalizeParent(resolve(repoRoot, options.consumerCache))
  if (
    isWithin({ root: repoRoot, candidate: consumerCache }) === false ||
    isWithin({ root: editorRoot, candidate: consumerCache }) === true ||
    isWithin({ root: packageDir, candidate: consumerCache }) === true
  )
    fail(
      `consumer cache must be inside the repository and outside package and snapshot views: ${consumerCache}`,
    )
  const current = join(editorRoot, viewName)
  return {
    repoRoot,
    packageDir,
    viewName,
    editorRoot,
    storeDir: join(editorRoot, '.store'),
    legacyDir: join(editorRoot, '.legacy'),
    current,
    firstHop: join(packageDir, 'node_modules'),
    firstHopTarget: relative(packageDir, join(current, 'node_modules')),
    consumerCache,
    retentionRecord: join(editorRoot, `.retention-${viewName}.json`),
  }
}

const requireRecordIdentity = (options: EditorViewOptions): void => {
  requireViewName(options.viewName)
  if (cellPattern.test(options.cell) === false)
    fail(`cell must be a portable identifier: ${options.cell}`)
  const packagePath = requirePortablePackage(options.package)
  const prefix = `//${packagePath}:`
  const name = options.target.startsWith(prefix) === true ? options.target.slice(prefix.length) : ''
  if (targetNamePattern.test(name) === false)
    fail(`target must be the stable label ${prefix}<name>: ${options.target}`)
}

const expectedRecord = ({
  options,
  fingerprint,
  normalizedStoreDigest,
  selectedViewDigest,
  byteSnapshotDigest = normalizedStoreDigest,
}: {
  options: EditorViewOptions
  fingerprint: string
  normalizedStoreDigest: string
  selectedViewDigest: string
  byteSnapshotDigest?: string
}): EditorViewRecord => ({
  schema: editorViewSchema,
  package: options.package,
  cell: options.cell,
  target: options.target,
  editorInputsFingerprint: fingerprint,
  snapshot: `.store/${options.viewName}-${fingerprint}`,
  normalizedStoreDigest,
  selectedViewDigest,
  byteSnapshotDigest,
})

const recordsEqual = ({
  left,
  right,
}: {
  left: EditorViewRecord
  right: EditorViewRecord
}): boolean => JSON.stringify(left) === JSON.stringify(right)

const writeRecord = ({ path, record }: { path: string; record: EditorViewRecord }): void => {
  writeFileSync(path, `${JSON.stringify(record, undefined, 2)}\n`, { flag: 'wx' })
}

const requireImmutableTool = ({ tool, label }: { tool: string; label: string }): void => {
  if (isAbsolute(tool) === false) fail(`${label} tool must be an immutable absolute path: ${tool}`)
  let immutableTool: string
  try {
    immutableTool = realpathSync(tool)
  } catch (error) {
    return fail(
      `${label} tool cannot be resolved: ${tool} (${error instanceof Error ? error.message : String(error)})`,
    )
  }
  if (immutableTool.startsWith('/nix/store/') === false)
    fail(`${label} tool must resolve into the immutable Nix store: ${immutableTool}`)
}

const runTool = ({
  tool,
  args,
  label,
}: {
  tool: string
  args: readonly string[]
  label: string
}): void => {
  requireImmutableTool({ tool, label })
  const result = spawnSync(tool, args, {
    cwd: '/',
    env: { PATH: '' },
    input: undefined,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0)
    fail(
      `${label} failed with exit ${result.status ?? 'unknown'}: ${result.stderr.toString().trim() || result.stdout.toString().trim()}`,
    )
}

const collectFileIdentities = (tree: string): ReadonlySet<string> => {
  const identities = new Set<string>()
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name)
      const status = lstatSync(path, { bigint: true })
      if (status.isDirectory() === true) {
        visit(path)
        continue
      }
      if (status.isFile() === true) {
        identities.add(`${status.dev}:${status.ino}`)
        continue
      }
      if (status.isSymbolicLink() === false)
        fail(`selected view contains unsupported special file: ${path}`)
      const resolved = statSync(path, { bigint: true })
      if (resolved.isFile() === true) identities.add(`${resolved.dev}:${resolved.ino}`)
    }
  }
  visit(tree)
  return identities
}

/**
 * Prove the candidate owns its bytes: every entry is a real directory or regular file,
 * and no file shares an inode with the selected view. A reflink copy is therefore
 * admitted only when it produced a distinct inode, and a hardlink copy is rejected.
 */
const assertByteOwnedSnapshot = ({
  source,
  snapshot,
}: {
  source: string
  snapshot: string
}): void => {
  const sourceIdentities = collectFileIdentities(source)
  const visit = (relativePath: string): void => {
    const path = join(snapshot, relativePath)
    const status = lstatSync(path, { bigint: true })
    if (status.isSymbolicLink() === true)
      fail(`byte-owned snapshot retains a symbolic link: ${relativePath}`)
    if (status.isDirectory() === true) {
      for (const name of readdirSync(path).toSorted((left, right) => compareBytes({ left, right })))
        visit(relativePath.length === 0 ? name : `${relativePath}/${name}`)
      return
    }
    if (status.isFile() === false)
      fail(`byte-owned snapshot contains unsupported special file: ${relativePath}`)
    if (status.nlink !== 1n)
      fail(`byte-owned snapshot file is linked elsewhere: ${relativePath} (nlink=${status.nlink})`)
    if (sourceIdentities.has(`${status.dev}:${status.ino}`) === true)
      fail(`byte-owned snapshot file shares an inode with the selected view: ${relativePath}`)
  }
  visit('')
}

type DeclaredSnapshotRoot = {
  readonly source: string
  readonly destination: string
  readonly identity: string
}

const declaredSnapshotRoots = ({
  nodeModules,
  backingRoots,
}: {
  nodeModules: string
  backingRoots: readonly string[]
}): readonly DeclaredSnapshotRoot[] => {
  const selected = realpathSync(resolve(nodeModules))
  requireDirectory({ path: selected, field: 'admitted node_modules' })
  const extras = new Set<string>()
  for (const root of backingRoots) {
    const canonical = realpathSync(resolve(root))
    requireDirectory({ path: canonical, field: 'declared backing root' })
    if (canonical !== selected) extras.add(canonical)
  }
  const orderedExtras = [...extras].toSorted((left, right) => compareBytes({ left, right }))
  const sources = [selected, ...orderedExtras]
  for (const [index, source] of sources.entries())
    for (const other of sources.slice(index + 1))
      if (
        isWithin({ root: source, candidate: other }) === true ||
        isWithin({ root: other, candidate: source }) === true
      )
        fail(`declared backing roots overlap ambiguously: ${source} and ${other}`)
  return [
    { source: selected, destination: 'node_modules', identity: 'node_modules' },
    ...orderedExtras.map((source, index) => {
      const identity = `.backing/${index.toString().padStart(4, '0')}`
      return { source, destination: identity, identity }
    }),
  ]
}

const fingerprintDeclaredRoots = async (
  roots: readonly DeclaredSnapshotRoot[],
): Promise<string> => {
  // Declared roots are proven disjoint read-only trees, so their fingerprints are
  // computed concurrently. Settling first and rethrowing in declared order keeps both
  // the reported failure and the hashed sequence deterministic.
  const settled = await Promise.allSettled(
    roots.map(async (root) => ({
      identity: root.identity,
      digest: await canonicalTreeFingerprint({ tree: root.source }),
    })),
  )
  const entries = settled.map((result) => {
    if (result.status === 'rejected') throw result.reason
    return result.value
  })
  const hash = createHash('sha256')
  hash.update('effect-utils/editor-view-declared-roots/v1')
  for (const entry of entries)
    for (const value of [entry.identity, entry.digest]) {
      const [length, bytes] = frame(value)
      hash.update(length)
      hash.update(bytes)
    }
  return hash.digest('hex')
}

const fingerprintSnapshotPayload = async (snapshotDir: string): Promise<string> => {
  const backing = join(snapshotDir, '.backing')
  const nodeModules = join(snapshotDir, 'node_modules')
  if (pathExists(backing) === false) return canonicalTreeFingerprint({ tree: nodeModules })
  // Both payload roots are fixed and ordered, so the two digests are awaited in place:
  // `.backing` is still fingerprinted strictly before `node_modules`.
  const entries = [
    ['.backing', await canonicalTreeFingerprint({ tree: backing })],
    ['node_modules', await canonicalTreeFingerprint({ tree: nodeModules })],
  ] as const
  const hash = createHash('sha256')
  hash.update('effect-utils/editor-view-snapshot-payload/v1')
  for (const [name, digest] of entries)
    for (const value of [name, digest]) {
      const [length, bytes] = frame(value)
      hash.update(length)
      hash.update(bytes)
    }
  return hash.digest('hex')
}

const rewriteSnapshotLinks = ({
  candidate,
  roots,
}: {
  candidate: string
  roots: readonly DeclaredSnapshotRoot[]
}): void => {
  const owners = roots.toSorted((left, right) => right.source.length - left.source.length)
  const visit = ({ source, destination }: { source: string; destination: string }): void => {
    for (const name of readdirSync(source)) {
      const sourcePath = join(source, name)
      const destinationPath = join(destination, name)
      const before = lstatSync(sourcePath, { bigint: true })
      if (before.isDirectory() === true) {
        visit({ source: sourcePath, destination: destinationPath })
        continue
      }
      if (before.isSymbolicLink() === false) continue
      const target = readlinkSync(sourcePath)
      let liveTarget: string
      try {
        liveTarget = realpathSync(sourcePath)
      } catch (error) {
        return fail(
          `declared backing link is unresolvable: ${sourcePath} (${error instanceof Error ? error.message : String(error)})`,
        )
      }
      const lexicalTarget = resolve(dirname(sourcePath), target)
      const owner = owners.find((root) => isWithin({ root: root.source, candidate: lexicalTarget }))
      if (owners.some((root) => isWithin({ root: root.source, candidate: liveTarget })) === false)
        fail(
          `declared backing link resolves outside declared roots: ${sourcePath} -> ${liveTarget}`,
        )
      if (owner === undefined)
        fail(`declared backing link escapes all declared roots: ${sourcePath} -> ${liveTarget}`)
      const relocatedTarget = join(
        candidate,
        owner.destination,
        relative(owner.source, lexicalTarget),
      )
      const relativeTarget = relative(dirname(destinationPath), relocatedTarget)
      if (relativeTarget.length === 0 || isAbsolute(relativeTarget) === true)
        fail(`declared backing link cannot be relocated: ${sourcePath}`)
      rmSync(destinationPath)
      symlinkSync(relativeTarget, destinationPath)
      const after = lstatSync(sourcePath, { bigint: true })
      if (
        after.isSymbolicLink() === false ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs ||
        readlinkSync(sourcePath) !== target
      )
        fail(`declared backing root changed while materializing: ${sourcePath}`)
    }
  }
  for (const root of roots)
    visit({ source: root.source, destination: join(candidate, root.destination) })
}

const materializeDeclaredRoots = ({
  candidate,
  roots,
  cp,
}: {
  candidate: string
  roots: readonly DeclaredSnapshotRoot[]
  cp: string
}): void => {
  mkdirSync(join(candidate, '.backing'))
  for (const root of roots) {
    const destination = join(candidate, root.destination)
    mkdirSync(destination, { recursive: true })
    runTool({
      tool: cp,
      args: [
        '--recursive',
        '--no-dereference',
        '--reflink=auto',
        '--',
        `${root.source}/.`,
        destination,
      ],
      label: finiteCopyLabel,
    })
  }
  rewriteSnapshotLinks({ candidate, roots })
}

const assertByteOwnedFiniteSnapshot = ({
  sources,
  snapshot,
}: {
  sources: readonly string[]
  snapshot: string
}): void => {
  const sourceIdentities = new Set(sources.flatMap((source) => [...collectFileIdentities(source)]))
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name)
      const status = lstatSync(path, { bigint: true })
      if (status.isSymbolicLink() === true) {
        const resolved = realpathSync(path)
        if (isWithin({ root: snapshot, candidate: resolved }) === false)
          fail(`byte-owned snapshot link escapes owned roots: ${path} -> ${resolved}`)
        continue
      }
      if (status.isDirectory() === true) {
        visit(path)
        continue
      }
      if (status.isFile() === false)
        fail(`byte-owned snapshot contains unsupported special file: ${path}`)
      if (status.nlink !== 1n)
        fail(`byte-owned snapshot file is linked elsewhere: ${path} (nlink=${status.nlink})`)
      if (sourceIdentities.has(`${status.dev}:${status.ino}`) === true)
        fail(`byte-owned snapshot file shares an inode with a declared root: ${path}`)
    }
  }
  visit(snapshot)
}

const hardenSnapshot = (snapshotDir: string): void => {
  const finite = pathExists(join(snapshotDir, '.backing'))
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name)
      const status = lstatSync(path)
      if (status.isSymbolicLink() === true) {
        if (finite === false) fail(`byte-owned snapshot retains a symbolic link: ${path}`)
        const resolved = realpathSync(path)
        if (isWithin({ root: snapshotDir, candidate: resolved }) === false)
          fail(`byte-owned snapshot link escapes owned roots: ${path} -> ${resolved}`)
        continue
      }
      if (status.isDirectory() === true) {
        visit(path)
        continue
      }
      chmodSync(path, status.mode & ~0o222)
    }
    const mode = statSync(directory).mode
    chmodSync(directory, mode & ~0o222)
  }
  chmodSync(join(snapshotDir, 'editor-view.json'), 0o444)
  visit(snapshotDir)
}
const requireReadOnlySnapshot = (snapshotDir: string): void => {
  const finite = pathExists(join(snapshotDir, '.backing'))
  const visit = (directory: string): void => {
    const status = lstatSync(directory)
    if (status.isDirectory() === false || status.isSymbolicLink() === true)
      fail(`snapshot directory must be a real directory: ${directory}`)
    if ((status.mode & 0o222) !== 0) fail(`snapshot directory is writable: ${directory}`)
    for (const name of readdirSync(directory)) {
      const path = join(directory, name)
      const entry = lstatSync(path)
      if (entry.isSymbolicLink() === true) {
        if (finite === false) fail(`snapshot contains a symbolic link: ${path}`)
        const resolved = realpathSync(path)
        if (isWithin({ root: snapshotDir, candidate: resolved }) === false)
          fail(`snapshot symbolic link escapes owned roots: ${path} -> ${resolved}`)
        continue
      }
      if (entry.isDirectory() === true) {
        visit(path)
        continue
      }
      if (entry.isFile() === false) fail(`snapshot contains unsupported special file: ${path}`)
      if ((entry.mode & 0o222) !== 0) fail(`snapshot file is writable: ${path}`)
    }
  }
  const recordPath = join(snapshotDir, 'editor-view.json')
  const recordStatus = lstatSync(recordPath)
  if (recordStatus.isFile() === false || (recordStatus.mode & 0o222) !== 0)
    fail(`snapshot record must be a read-only regular file: ${recordPath}`)
  visit(snapshotDir)
}

const ensureConsumerCache = (paths: ViewPaths): void => {
  mkdirSync(paths.consumerCache, { recursive: true })
  requireDirectory({ path: paths.consumerCache, field: 'consumer cache' })
  if (realpathSync(paths.consumerCache) !== paths.consumerCache)
    fail(`consumer cache path must not contain symbolic links: ${paths.consumerCache}`)
  if ((statSync(paths.consumerCache).mode & 0o222) === 0)
    fail(`consumer cache must remain writable outside immutable views: ${paths.consumerCache}`)
}

const readSnapshotRetention = ({
  path,
  viewName,
}: {
  path: string
  viewName: string
}): SnapshotRetentionRecord => {
  if (pathExists(path) === false) return { schema: snapshotRetentionSchema, snapshots: [] }
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return fail(
      `invalid snapshot retention record ${path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const record =
    isRecord(value) === true
      ? value
      : fail(`snapshot retention record does not conform to ${snapshotRetentionSchema}: ${path}`)
  if (
    JSON.stringify(Object.keys(record).toSorted((left, right) => compareBytes({ left, right }))) !==
      JSON.stringify(retentionRecordFields) ||
    record.schema !== snapshotRetentionSchema
  )
    fail(`snapshot retention record does not conform to ${snapshotRetentionSchema}: ${path}`)
  const snapshots = requireSnapshotNames({ value: record.snapshots, path, viewName })
  return { schema: snapshotRetentionSchema, snapshots }
}

const writeSnapshotRetention = ({
  paths,
  snapshots,
  token,
}: {
  paths: ViewPaths
  snapshots: readonly string[]
  token: string
}): void => {
  const candidate = join(paths.editorRoot, `.retention.candidate-${token}`)
  try {
    writeFileSync(
      candidate,
      `${JSON.stringify({ schema: snapshotRetentionSchema, snapshots }, undefined, 2)}\n`,
      { flag: 'wx' },
    )
    renameSync(candidate, paths.retentionRecord)
  } finally {
    if (pathExists(candidate) === true) rmSync(candidate)
  }
}

const listOwnedSnapshots = ({
  paths,
  options,
}: {
  paths: ViewPaths
  options: EditorViewOptions
}): readonly string[] => {
  const pattern = snapshotNamePattern(paths.viewName)
  const snapshots: string[] = []
  for (const name of readdirSync(paths.storeDir).toSorted((left, right) =>
    compareBytes({ left, right }),
  )) {
    if (name.startsWith('.candidate-') === true) continue
    const fingerprint = pattern.exec(name)?.[1]
    const snapshotDir = join(paths.storeDir, name)
    if (fingerprint === undefined) {
      const foreign = /^([A-Za-z0-9][A-Za-z0-9_-]*)-([0-9a-f]{64})$/.exec(name)
      if (foreign === null)
        fail(`snapshot store contains an ambiguously owned entry: ${snapshotDir}`)
      requireDirectory({ path: snapshotDir, field: 'retained snapshot' })
      const record = readRecord(join(snapshotDir, 'editor-view.json'))
      if (record.snapshot !== `.store/${name}`)
        fail(`snapshot store contains an ambiguously owned entry: ${snapshotDir}`)
      requireReadOnlySnapshot(snapshotDir)
      continue
    }
    requireDirectory({ path: snapshotDir, field: 'retained snapshot' })
    const record = readRecord(join(snapshotDir, 'editor-view.json'))
    const expected = expectedRecord({
      options,
      fingerprint,
      normalizedStoreDigest: record.normalizedStoreDigest,
      selectedViewDigest: record.selectedViewDigest,
      byteSnapshotDigest: record.byteSnapshotDigest,
    })
    if (recordsEqual({ left: record, right: expected }) === false)
      fail(`retained snapshot ownership mismatch: ${snapshotDir}`)
    requireReadOnlySnapshot(snapshotDir)
    snapshots.push(name)
  }
  return snapshots
}

const prepareSnapshotRetention = ({
  paths,
  options,
  current,
  token,
}: {
  paths: ViewPaths
  options: EditorViewOptions
  current: string
  token: string
}): readonly string[] => {
  const discovered = listOwnedSnapshots({ paths, options })
  const discoveredSet = new Set(discovered)
  const recorded = readSnapshotRetention({
    path: paths.retentionRecord,
    viewName: paths.viewName,
  }).snapshots
  const ordered = [
    current,
    ...recorded.filter((name) => name !== current && discoveredSet.has(name)),
    ...discovered.filter((name) => name !== current && recorded.includes(name) === false),
  ]
  writeSnapshotRetention({ paths, snapshots: ordered, token })
  return ordered
}

const makeDirectoriesWritable = (root: string): void => {
  const visit = (directory: string): void => {
    chmodSync(directory, (statSync(directory).mode & 0o777) | 0o700)
    for (const name of readdirSync(directory)) {
      const path = join(directory, name)
      if (lstatSync(path).isDirectory() === true) visit(path)
    }
  }
  visit(root)
}

const renameReadOnlySnapshot = ({
  source,
  destination,
}: {
  source: string
  destination: string
}): void => {
  const sourceMode = statSync(source).mode & 0o777
  chmodSync(source, sourceMode | 0o200)
  try {
    renameSync(source, destination)
  } catch (error) {
    chmodSync(source, sourceMode)
    throw error
  }
}

const garbageCollectSnapshots = ({
  paths,
  options,
  ordered,
  current,
  token,
}: {
  paths: ViewPaths
  options: EditorViewOptions
  ordered: readonly string[]
  current: string
  token: string
}): void => {
  const keep = ordered.slice(0, options.snapshotRetention)
  if (keep.includes(current) === false) fail(`snapshot retention would delete current: ${current}`)
  const pointer = readlinkSync(paths.current)
  if (pointer !== `.store/${current}`)
    fail(`current pointer changed during snapshot retention: ${pointer}`)
  const keepSet = new Set(keep)
  for (const name of ordered.filter((entry) => keepSet.has(entry) === false)) {
    if (name === current || name.startsWith('.candidate-') === true)
      fail(`snapshot retention refused protected entry: ${name}`)
    const snapshotDir = join(paths.storeDir, name)
    if (pathExists(snapshotDir) === false) continue
    const garbage = join(paths.editorRoot, `.gc-${token}-${name}`)
    renameReadOnlySnapshot({ source: snapshotDir, destination: garbage })
    try {
      chmodSync(join(garbage, 'editor-view.json'), 0o600)
      makeDirectoriesWritable(garbage)
      rmSync(garbage, { recursive: true })
    } catch (error) {
      if (pathExists(garbage) === true) {
        hardenSnapshot(garbage)
        renameReadOnlySnapshot({ source: garbage, destination: snapshotDir })
        hardenSnapshot(snapshotDir)
      }
      throw error
    }
  }
  writeSnapshotRetention({ paths, snapshots: keep, token })
}

type LockOwner = {
  readonly schema: typeof lockSchema
  readonly token: string
  readonly pid: number
}

const readLockOwner = (path: string): LockOwner => {
  let owner: unknown
  try {
    owner = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return fail(
      `cannot read publication lock owner: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (
    isRecord(owner) === false ||
    JSON.stringify(Object.keys(owner).toSorted((left, right) => compareBytes({ left, right }))) !==
      JSON.stringify(lockRecordFields) ||
    owner.schema !== lockSchema ||
    typeof owner.token !== 'string' ||
    owner.token.length === 0 ||
    typeof owner.pid !== 'number' ||
    Number.isSafeInteger(owner.pid) === false ||
    owner.pid <= 0
  )
    return fail(`publication lock owner does not conform to ${lockSchema}: ${path}`)
  return { schema: lockSchema, token: owner.token, pid: owner.pid }
}

const acquireLock = ({
  editorRoot,
  recoveryCommand,
}: {
  editorRoot: string
  recoveryCommand: string
}): { readonly path: string; readonly token: string } => {
  const lockPath = join(editorRoot, '.publish.lock')
  const token = randomUUID()
  try {
    mkdirSync(lockPath)
  } catch (error) {
    if (isNodeErrorCode({ error, code: 'EEXIST' }) === false) throw error
    let owner = '<unreadable>'
    try {
      owner = readFileSync(join(lockPath, 'owner.json'), 'utf8').trim()
    } catch {}
    fail(
      `publication lock exists at ${lockPath}; owner=${owner}; recovery requires explicit: ${recoveryCommand} --token <owner-token>`,
    )
  }
  try {
    writeFileSync(
      join(lockPath, 'owner.json'),
      `${JSON.stringify({ schema: lockSchema, token, pid: process.pid })}\n`,
      { flag: 'wx' },
    )
  } catch (error) {
    rmSync(lockPath, { recursive: true, force: true })
    throw error
  }
  return { path: lockPath, token }
}

const releaseLock = ({ path, token }: { path: string; token: string }): void => {
  const owner = readLockOwner(join(path, 'owner.json'))
  if (owner.token !== token) fail(`publication lock ownership changed: ${path}`)
  rmSync(path, { recursive: true })
}

/** Remove the publication lock only when the caller presents its exact owner token. */
export const recoverEditorViewLock = ({
  options,
  token,
}: {
  options: EditorViewOptions
  token: string
}): void => {
  const paths = makePaths(options)
  ensureRealDirectory({ path: paths.editorRoot, field: 'editor root' })
  const lockPath = join(paths.editorRoot, '.publish.lock')
  const owner = readLockOwner(join(lockPath, 'owner.json'))
  if (owner.token !== token)
    fail(`publication lock token mismatch at ${lockPath}; lock was not removed`)
  const tokenDigest = createHash('sha256').update(token).digest('hex')
  const recoveredPath = join(paths.editorRoot, `.publish.lock.recovered-${tokenDigest}`)
  renameSync(lockPath, recoveredPath)
  rmSync(recoveredPath, { recursive: true })
}

const validateSnapshot = async ({
  snapshotDir,
  expected,
}: {
  snapshotDir: string
  expected: EditorViewRecord
}): Promise<void> => {
  requireDirectory({ path: snapshotDir, field: 'snapshot' })
  const record = readRecord(join(snapshotDir, 'editor-view.json'))
  if (recordsEqual({ left: record, right: expected }) === false)
    fail(`existing snapshot record mismatch: ${snapshotDir}`)
  const snapshotNodeModules = join(snapshotDir, 'node_modules')
  requireDirectory({ path: snapshotNodeModules, field: 'snapshot node_modules' })
  requireReadOnlySnapshot(snapshotDir)
  const digest = await fingerprintSnapshotPayload(snapshotDir)
  if (digest !== record.byteSnapshotDigest)
    fail(
      `existing snapshot byte digest mismatch: recorded=${record.byteSnapshotDigest} actual=${digest}`,
    )
}

const publishCurrentPointer = ({
  paths,
  fingerprint,
  token,
}: {
  paths: ViewPaths
  fingerprint: string
  token: string
}): void => {
  const linkTarget = `.store/${paths.viewName}-${fingerprint}`
  if (pathExists(paths.current) === true && lstatSync(paths.current).isSymbolicLink() === false)
    fail(`current view path is not a symlink: ${paths.current}`)
  const candidate = join(paths.editorRoot, `.${paths.viewName}.candidate-${token}`)
  try {
    symlinkSync(linkTarget, candidate)
    renameSync(candidate, paths.current)
  } finally {
    if (pathExists(candidate) === true) rmSync(candidate)
  }
}

const describeIdentity = (path: string): string => {
  const status = lstatSync(path, { bigint: true })
  return `${status.dev}:${status.ino}:${status.mode}`
}

const adoptFirstHop = ({
  paths,
  mv,
  token,
}: {
  paths: ViewPaths
  mv: string
  token: string
}): void => {
  if (pathExists(paths.firstHop) === true) {
    const status = lstatSync(paths.firstHop)
    if (status.isSymbolicLink() === true && readlinkSync(paths.firstHop) === paths.firstHopTarget) {
      let resolved: string
      try {
        resolved = realpathSync(paths.firstHop)
      } catch (error) {
        return fail(
          `existing first-hop symlink is dangling: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      const expected = realpathSync(join(paths.current, 'node_modules'))
      if (resolved !== expected)
        fail(`existing first-hop symlink resolves to unexpected tree: ${resolved}`)
      return
    }
    ensureRealDirectory({ path: paths.legacyDir, field: 'legacy directory' })
    const legacyCandidate = join(paths.legacyDir, `.candidate-${token}`)
    const retained = join(paths.legacyDir, `node_modules-${token}`)
    let exchanged = false
    try {
      symlinkSync(paths.firstHopTarget, legacyCandidate)
      const oldIdentity = describeIdentity(paths.firstHop)
      runTool({
        tool: mv,
        args: ['--exchange', '--no-copy', '-T', legacyCandidate, paths.firstHop],
        label: 'mv --exchange',
      })
      exchanged = true
      if (
        lstatSync(paths.firstHop).isSymbolicLink() === false ||
        readlinkSync(paths.firstHop) !== paths.firstHopTarget
      )
        fail(`first-hop exchange did not install the expected symlink: ${paths.firstHop}`)
      if (describeIdentity(legacyCandidate) !== oldIdentity)
        fail(`first-hop exchange did not retain the legacy entry: ${legacyCandidate}`)
    } finally {
      if (pathExists(legacyCandidate) === true) {
        if (exchanged === true) renameSync(legacyCandidate, retained)
        else rmSync(legacyCandidate)
      }
    }
    return
  }
  const candidate = join(paths.packageDir, `.node_modules.candidate-${token}`)
  try {
    symlinkSync(paths.firstHopTarget, candidate)
    renameSync(candidate, paths.firstHop)
  } finally {
    if (pathExists(candidate) === true) rmSync(candidate)
  }
}

const signalEditorResolution = ({ paths, token }: { paths: ViewPaths; token: string }): void => {
  const packageManifest = join(paths.packageDir, 'package.json')
  const status = lstatSync(packageManifest)
  if (status.isFile() === false || status.isSymbolicLink() === true)
    fail(`editor resolution signal is not a regular package manifest: ${packageManifest}`)
  const content = readFileSync(packageManifest)
  const candidate = join(paths.packageDir, `.package.json.editor-settle-${token}`)
  try {
    writeFileSync(candidate, content, { flag: 'wx', mode: status.mode & 0o777 })
    if (readFileSync(candidate).equals(content) === false)
      fail(`editor resolution settle candidate content mismatch: ${candidate}`)
    renameSync(candidate, packageManifest)
    if (readFileSync(packageManifest).equals(content) === false)
      fail(`editor resolution settle changed package manifest content: ${packageManifest}`)
  } finally {
    if (pathExists(candidate) === true) rmSync(candidate)
  }
}

/** Publish or validate the immutable snapshot selected by the admitted editor inputs. */
export const publishEditorView = async (options: EditorViewOptions): Promise<EditorViewRecord> => {
  requireRecordIdentity(options)
  const paths = makePaths(options)
  validateWorkspaceDependencyAuthority({
    path: options.workspaceAuthority,
    repoRoot: paths.repoRoot,
    packageName: options.package,
  })
  requireDirectory({ path: options.editorInputs, field: 'editor_inputs' })
  requireDirectory({ path: options.nodeModules, field: 'admitted node_modules' })
  requireImmutableTool({ tool: options.cp, label: copyLabel })
  requireImmutableTool({ tool: options.mv, label: 'mv --exchange' })
  ensureConsumerCache(paths)
  ensureRealDirectory({ path: paths.editorRoot, field: 'editor root' })
  ensureRealDirectory({ path: paths.storeDir, field: 'editor snapshot store' })
  const lock = acquireLock({
    editorRoot: paths.editorRoot,
    recoveryCommand: `recover-lock --repo-root ${paths.repoRoot} --package ${options.package}`,
  })
  const token = tokenSafe(lock.token)
  let candidate: string | undefined
  try {
    const fingerprint = await canonicalTreeFingerprint({ tree: options.editorInputs })
    const selectedViewDigest = await canonicalTreeFingerprint({ tree: options.nodeModules })
    const finite = (options.backingRoots?.length ?? 0) > 0
    const roots =
      finite === true
        ? declaredSnapshotRoots({
            nodeModules: options.nodeModules,
            backingRoots: options.backingRoots ?? [],
          })
        : []
    const normalizedStoreDigest =
      finite === true
        ? await fingerprintDeclaredRoots(roots)
        : await canonicalTreeFingerprint({ tree: options.nodeModules, dereference: true })
    const snapshotDir = join(paths.storeDir, `${paths.viewName}-${fingerprint}`)
    let record: EditorViewRecord
    if (existsSync(snapshotDir) === true) {
      const existing = readRecord(join(snapshotDir, 'editor-view.json'))
      record = expectedRecord({
        options,
        fingerprint,
        normalizedStoreDigest,
        selectedViewDigest,
        byteSnapshotDigest: existing.byteSnapshotDigest,
      })
      await validateSnapshot({ snapshotDir, expected: record })
    } else {
      candidate = join(paths.storeDir, `.candidate-${token}`)
      mkdirSync(candidate)
      if (finite === true) {
        materializeDeclaredRoots({ candidate, roots, cp: options.cp })
        assertByteOwnedFiniteSnapshot({
          sources: roots.map((root) => root.source),
          snapshot: candidate,
        })
        const after = await fingerprintDeclaredRoots(roots)
        if (after !== normalizedStoreDigest)
          fail(
            `declared backing roots changed while materializing: before=${normalizedStoreDigest} after=${after}`,
          )
      } else {
        const candidateNodeModules = join(candidate, 'node_modules')
        mkdirSync(candidateNodeModules)
        runTool({
          tool: options.cp,
          args: [
            '--recursive',
            '--dereference',
            '--reflink=auto',
            '--',
            `${resolve(options.nodeModules)}/.`,
            candidateNodeModules,
          ],
          label: copyLabel,
        })
        assertByteOwnedSnapshot({
          source: resolve(options.nodeModules),
          snapshot: candidateNodeModules,
        })
      }
      const candidateDigest = await fingerprintSnapshotPayload(candidate)
      record = expectedRecord({
        options,
        fingerprint,
        normalizedStoreDigest,
        selectedViewDigest,
        byteSnapshotDigest: candidateDigest,
      })
      writeRecord({ path: join(candidate, 'editor-view.json'), record })
      renameSync(candidate, snapshotDir)
      candidate = undefined
    }
    hardenSnapshot(snapshotDir)
    requireReadOnlySnapshot(snapshotDir)
    const snapshotName = `${paths.viewName}-${fingerprint}`
    const retention = prepareSnapshotRetention({
      paths,
      options,
      current: snapshotName,
      token,
    })
    publishCurrentPointer({ paths, fingerprint, token })
    adoptFirstHop({ paths, mv: options.mv, token })
    signalEditorResolution({ paths, token })
    await checkEditorView(options)
    garbageCollectSnapshots({
      paths,
      options,
      ordered: retention,
      current: snapshotName,
      token,
    })
    return record
  } finally {
    if (candidate !== undefined && pathExists(candidate) === true) {
      // A dereferencing copy reproduces read-only source directories, so the
      // abandoned candidate must be unlocked before removal.
      makeDirectoriesWritable(candidate)
      rmSync(candidate, { recursive: true, force: true })
    }
    releaseLock(lock)
  }
}

const tokenSafe = (token: string): string => token.replaceAll('-', '')

const inferRecordedFingerprint = ({
  current,
  viewName,
}: {
  current: string
  viewName: string
}): string => {
  try {
    if (lstatSync(current).isSymbolicLink() === false) return '<invalid-pointer>'
    const match = new RegExp(`^\\.store/${viewName}-([0-9a-f]{64})$`).exec(readlinkSync(current))
    return match?.[1] ?? '<invalid-pointer>'
  } catch {
    return '<missing>'
  }
}

const validatePublishedView = async ({
  options,
  paths,
  context,
}: {
  options: EditorViewOptions
  paths: ViewPaths
  context: CheckContext
}): Promise<EditorViewRecord> => {
  try {
    requireDirectory({ path: paths.editorRoot, field: 'editor root' })
    requireDirectory({ path: paths.storeDir, field: 'editor snapshot store' })
    requireDirectory({ path: paths.consumerCache, field: 'consumer cache' })
    if (
      realpathSync(paths.consumerCache) !== paths.consumerCache ||
      (statSync(paths.consumerCache).mode & 0o222) === 0
    )
      fail(`consumer cache must be a writable real directory: ${paths.consumerCache}`)
  } catch (error) {
    return failCheck({ message: error instanceof Error ? error.message : String(error), context })
  }
  context.recordedFingerprint = inferRecordedFingerprint({
    current: paths.current,
    viewName: paths.viewName,
  })
  let currentStatus
  try {
    currentStatus = lstatSync(paths.current)
  } catch {
    return failCheck({ message: `current pointer is missing: ${paths.current}`, context })
  }
  if (currentStatus.isSymbolicLink() === false)
    return failCheck({ message: `current pointer is not a symlink: ${paths.current}`, context })
  const pointer = readlinkSync(paths.current)
  const expectedPointer = `.store/${paths.viewName}-${context.recordedFingerprint}`
  if (pointer !== expectedPointer)
    return failCheck({ message: `current pointer is escaping or malformed: ${pointer}`, context })
  const snapshotDir = resolve(paths.editorRoot, pointer)
  if (isWithin({ root: paths.storeDir, candidate: snapshotDir }) === false)
    return failCheck({ message: `current pointer escapes snapshot store: ${pointer}`, context })
  try {
    requireDirectory({ path: snapshotDir, field: 'current snapshot' })
  } catch (error) {
    return failCheck({
      message: `current pointer is dangling: ${error instanceof Error ? error.message : String(error)}`,
      context,
    })
  }
  let record: EditorViewRecord
  try {
    record = readRecord(join(snapshotDir, 'editor-view.json'))
  } catch (error) {
    return failCheck({ message: error instanceof Error ? error.message : String(error), context })
  }
  context.recordedFingerprint = record.editorInputsFingerprint
  const expected = expectedRecord({
    options,
    fingerprint: record.editorInputsFingerprint,
    normalizedStoreDigest: record.normalizedStoreDigest,
    selectedViewDigest: record.selectedViewDigest,
    byteSnapshotDigest: record.byteSnapshotDigest,
  })
  if (recordsEqual({ left: record, right: expected }) === false)
    return failCheck({ message: 'record package/cell/target/snapshot fields are invalid', context })
  try {
    requireReadOnlySnapshot(snapshotDir)
  } catch (error) {
    return failCheck({
      message: `snapshot immutability violation: ${error instanceof Error ? error.message : String(error)}`,
      context,
    })
  }
  const snapshotNodeModules = join(snapshotDir, 'node_modules')
  let snapshotDigest: string
  try {
    snapshotDigest = await fingerprintSnapshotPayload(snapshotDir)
  } catch (error) {
    return failCheck({
      message: `snapshot is incomplete: ${error instanceof Error ? error.message : String(error)}`,
      context,
    })
  }
  if (snapshotDigest !== record.byteSnapshotDigest)
    return failCheck({
      message: `snapshot byte digest mismatch: recorded=${record.byteSnapshotDigest} snapshot=${snapshotDigest}`,
      context,
    })
  let firstHopStatus
  try {
    firstHopStatus = lstatSync(paths.firstHop)
  } catch {
    return failCheck({
      message: `first-hop node_modules pointer is missing: ${paths.firstHop}`,
      context,
    })
  }
  if (
    firstHopStatus.isSymbolicLink() === false ||
    readlinkSync(paths.firstHop) !== paths.firstHopTarget
  )
    return failCheck({
      message: `first-hop node_modules pointer is escaping or malformed: ${paths.firstHop}`,
      context,
    })
  let firstHopResolved: string
  try {
    firstHopResolved = realpathSync(paths.firstHop)
  } catch (error) {
    return failCheck({
      message: `first-hop node_modules pointer is dangling: ${error instanceof Error ? error.message : String(error)}`,
      context,
    })
  }
  if (firstHopResolved !== realpathSync(snapshotNodeModules))
    return failCheck({
      message: `first-hop node_modules pointer resolves outside current snapshot: ${firstHopResolved}`,
      context,
    })
  return record
}

/**
 * Validate the published two-hop view and its byte-owned snapshot without any Buck
 * artifact: the snapshot outlives every backing store, view, and `buck-out` entry.
 */
export const verifyEditorViewSnapshot = async (
  options: EditorViewOptions,
): Promise<EditorViewRecord> => {
  requireRecordIdentity(options)
  const paths = makePaths(options)
  const context: CheckContext = {
    recordedFingerprint: '<missing>',
    currentFingerprint: '<not-admitted>',
  }
  return validatePublishedView({ options, paths, context })
}

/** Validate the live two-hop view against freshly admitted Buck artifacts. */
export const checkEditorView = async (options: EditorViewOptions): Promise<EditorViewRecord> => {
  requireRecordIdentity(options)
  const paths = makePaths(options)
  validateWorkspaceDependencyAuthority({
    path: options.workspaceAuthority,
    repoRoot: paths.repoRoot,
    packageName: options.package,
  })
  requireDirectory({ path: options.editorInputs, field: 'editor_inputs' })
  requireDirectory({ path: options.nodeModules, field: 'admitted node_modules' })
  const currentFingerprint = await canonicalTreeFingerprint({ tree: options.editorInputs })
  const context: CheckContext = { recordedFingerprint: '<missing>', currentFingerprint }
  const record = await validatePublishedView({ options, paths, context })
  if (record.editorInputsFingerprint !== currentFingerprint)
    return failCheck({ message: 'editor_inputs fingerprint mismatch', context })
  const selectedViewDigest = await canonicalTreeFingerprint({ tree: options.nodeModules })
  if (selectedViewDigest !== record.selectedViewDigest)
    return failCheck({
      message: `admitted node_modules view digest mismatch: recorded=${record.selectedViewDigest} admitted=${selectedViewDigest}`,
      context,
    })
  const normalizedStoreDigest =
    (options.backingRoots?.length ?? 0) > 0
      ? await fingerprintDeclaredRoots(
          declaredSnapshotRoots({
            nodeModules: options.nodeModules,
            backingRoots: options.backingRoots ?? [],
          }),
        )
      : await canonicalTreeFingerprint({ tree: options.nodeModules, dereference: true })
  if (normalizedStoreDigest !== record.normalizedStoreDigest)
    return failCheck({
      message: `admitted normalized store digest mismatch: recorded=${record.normalizedStoreDigest} admitted=${normalizedStoreDigest}`,
      context,
    })
  return record
}

type ParsedCli = {
  readonly command: 'publish' | 'check' | 'verify' | 'recover-lock'
  readonly options: EditorViewOptions
  readonly token: string | undefined
}

const commands = ['publish', 'check', 'verify', 'recover-lock'] as const

const isCommand = (value: string | undefined): value is ParsedCli['command'] =>
  commands.includes(value as ParsedCli['command'])

const parseCli = (args: readonly string[]): ParsedCli => {
  const command = args[0]
  if (isCommand(command) === false)
    return fail('expected command: publish, check, verify, or recover-lock')
  const values = new Map<string, string>()
  const backingRoots: string[] = []
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index] ?? fail('missing option')
    const value = args[index + 1] ?? fail(`missing value for ${flag}`)
    if (flag.startsWith('--') === false) fail(`unexpected option: ${flag}`)
    if (flag === '--backing-root') {
      backingRoots.push(value)
    } else {
      if (values.has(flag) === true) fail(`unexpected or duplicate option: ${flag}`)
      values.set(flag, value)
    }
  }
  const recover = command === 'recover-lock'
  const admitting = command === 'publish' || command === 'check'
  if (admitting === false && backingRoots.length > 0)
    fail(`unexpected option for ${command}: --backing-root`)
  const allowed = new Set(
    recover === true
      ? ['--repo-root', '--package', '--view-name', '--token']
      : admitting === true
        ? [
            '--repo-root',
            '--package',
            '--view-name',
            '--cell',
            '--target',
            '--editor-inputs',
            '--node-modules',
            '--backing-root',
            '--cp',
            '--mv',
            '--workspace-authority',
            '--consumer-cache',
            '--snapshot-retention',
          ]
        : [
            '--repo-root',
            '--package',
            '--view-name',
            '--cell',
            '--target',
            '--consumer-cache',
            '--snapshot-retention',
          ],
  )
  for (const flag of values.keys())
    if (allowed.has(flag) === false) fail(`unexpected option for ${command}: ${flag}`)
  const get = (flag: string): string => values.get(flag) ?? fail(`missing required option ${flag}`)
  const getUnlessRecovering = (flag: string): string => (recover === true ? '' : get(flag))
  const getWhenAdmitting = (flag: string): string => (admitting === true ? get(flag) : '')
  const packagePath = get('--package')
  // The view name defaults to the package directory name, so existing task
  // wiring keeps publishing the same `tui-core` identity without the new flag.
  const viewName = values.get('--view-name') ?? defaultEditorViewName(packagePath)
  const snapshotRetention =
    admitting === true
      ? Number(get('--snapshot-retention'))
      : Number(values.get('--snapshot-retention') ?? '2')
  if (Number.isSafeInteger(snapshotRetention) === false)
    fail(`snapshot retention must be an integer`)
  const options: EditorViewOptions = {
    repoRoot: get('--repo-root'),
    package: packagePath,
    viewName,
    cell: getUnlessRecovering('--cell'),
    target: getUnlessRecovering('--target'),
    editorInputs: getWhenAdmitting('--editor-inputs'),
    backingRoots: admitting === true ? backingRoots : [],
    nodeModules: getWhenAdmitting('--node-modules'),
    cp: getWhenAdmitting('--cp'),
    mv: getWhenAdmitting('--mv'),
    workspaceAuthority: getWhenAdmitting('--workspace-authority'),
    consumerCache: recover === true ? `.devenv/vite-cache/${viewName}` : get('--consumer-cache'),
    snapshotRetention,
  }
  return { command, options, token: recover === true ? get('--token') : undefined }
}

const main = async (): Promise<void> => {
  const parsed = parseCli(process.argv.slice(2))
  if (parsed.command === 'publish') {
    const record = await publishEditorView(parsed.options)
    process.stdout.write(
      `published ${record.package} editor view ${record.editorInputsFingerprint}\n`,
    )
  } else if (parsed.command === 'check') {
    const record = await checkEditorView(parsed.options)
    process.stdout.write(
      `checked ${record.package} editor view ${record.editorInputsFingerprint}\n`,
    )
  } else if (parsed.command === 'verify') {
    const record = await verifyEditorViewSnapshot(parsed.options)
    process.stdout.write(
      `verified ${record.package} editor snapshot ${record.byteSnapshotDigest}\n`,
    )
  } else {
    recoverEditorViewLock({
      options: parsed.options,
      token: parsed.token ?? fail('missing required option --token'),
    })
    process.stdout.write('recovered editor view publication lock\n')
  }
}

if (import.meta.main === true) await main()
