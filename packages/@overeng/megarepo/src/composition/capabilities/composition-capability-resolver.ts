import { execFile as execFileCallback } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as NodePath from 'node:path'
import { promisify } from 'node:util'

import { Schema } from 'effect'

import {
  buckMemberProjectedCapabilitiesForSystem,
  decodeBuckMemberManifest,
  type BuckMemberCapability,
  type BuckMemberManifest,
} from '@overeng/megarepo/buck2-manifest'

import {
  CompositionCapabilityResolutionError,
  CompositionCapabilitySystemSchema,
  type CompositionCapabilityCommand,
  type CompositionCapabilityPlan,
  type CompositionCapabilityResolution,
  type CompositionCapabilitySystem,
  type ResolvedCompositionCapability,
} from './composition-capability-resolver-schema.ts'

const execFile = promisify(execFileCallback)
const strictParseOptions = { errors: 'all', onExcessProperty: 'error' } as const

/** Exact Nix binary plus resolver-owned scratch seams. */
export interface CompositionCapabilityRuntime {
  readonly nixPath: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly nonce?: () => string
  readonly afterCandidateCreated?: (candidateRoot: string) => Promise<void>
  readonly beforeProjectionDigest?: (input: {
    readonly candidateRoot: string
    readonly projectionPath: string
  }) => Promise<void>
  readonly createPrivateScratch?: () => Promise<CompositionCapabilityPrivateScratch>
}

/** Resolver-owned private scratch capability. Callers may inject creation, never a mutable path. */
export interface CompositionCapabilityPrivateScratch {
  readonly path: string
  readonly cleanup: () => Promise<void>
}

/** Realized resolution handle. `release` destroys the resolver-owned private scratch tree. */
export interface CompositionCapabilityResolutionHandle extends CompositionCapabilityResolution {
  readonly release: () => Promise<void>
}

/** Strict member, platform, scratch ownership, and pinned runtime resolver input. */
export interface ResolveCompositionCapabilitiesInput {
  readonly memberRoot: string
  readonly system: CompositionCapabilitySystem
  readonly manifest: BuckMemberManifest | unknown
  readonly dryRun: boolean
  readonly runtime: CompositionCapabilityRuntime
}

/** Validated dry-run plan or completed scratch projection. */
export type ResolveCompositionCapabilitiesResult =
  | CompositionCapabilityPlan
  | CompositionCapabilityResolutionHandle

/** Runtime config injected by the Nix wrapper. Missing Nix fails closed; PATH is never consulted. */
export const compositionCapabilityRuntimeFromEnv = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): CompositionCapabilityRuntime => {
  const nixPath = env['MR_CAPABILITY_NIX_BIN']
  if (nixPath === undefined || nixPath.length === 0) {
    throw new CompositionCapabilityResolutionError({
      reason: 'InvalidRuntime',
      message: 'Missing pinned capability runtime path in MR_CAPABILITY_NIX_BIN',
    })
  }
  return { nixPath, env }
}

/** Validate a capability projection without executing member-controlled code. */
export const checkCompositionCapabilityProjection = (input: { readonly memberRoot: string }) =>
  checkCompositionCapabilityProjectionInternal(input)

/** Resolve declared capabilities using trusted mr-owned projection code. */
export const resolveCompositionCapabilities = (input: ResolveCompositionCapabilitiesInput) =>
  resolveCompositionCapabilitiesInternal(input)

/** Fail-closed resolved capability lookup used by Buck/tool consumers. */
export const resolvedCompositionCapabilityByToolId = (input: {
  readonly resolution: CompositionCapabilityResolutionHandle
  readonly toolId: string
}) => resolvedCompositionCapabilityByToolIdInternal(input)

const invalidInput = ({
  message,
  path,
  cause,
}: {
  readonly message: string
  readonly path?: string
  readonly cause?: unknown
}) =>
  new CompositionCapabilityResolutionError({
    reason: 'InvalidInput',
    message,
    ...(path === undefined ? {} : { path }),
    ...(cause === undefined ? {} : { cause }),
  })

const assertAbsoluteNormalized = ({
  value,
  name,
}: {
  readonly value: string
  readonly name: string
}): void => {
  if (NodePath.isAbsolute(value) === false || NodePath.normalize(value) !== value) {
    throw invalidInput({ message: `${name} must be a normalized absolute path`, path: value })
  }
}

const containedBy = ({ root, path }: { readonly root: string; readonly path: string }): boolean =>
  path === root || path.startsWith(`${root}${NodePath.sep}`) === true

const platformFor = (system: CompositionCapabilitySystem) => {
  switch (system) {
    case 'x86_64-linux':
      return 'x86_64-linux' as const
    case 'aarch64-linux':
      return 'aarch64-linux' as const
    case 'aarch64-darwin':
      return 'aarch64-macos' as const
  }
}

const command = ({
  executable,
  args,
}: {
  readonly executable: string
  readonly args: ReadonlyArray<string>
}): CompositionCapabilityCommand => ({
  executable,
  args: [...args],
})

const commandFailure = ({
  value,
  message,
  reason = 'CommandFailure',
  cause,
}: {
  readonly value: CompositionCapabilityCommand
  readonly message: string
  readonly reason?: 'CommandFailure' | 'ProjectionFailure'
  readonly cause: unknown
}) =>
  new CompositionCapabilityResolutionError({
    reason,
    message,
    command: value,
    cause,
  })

const run = async ({
  value,
  env,
  reason,
}: {
  readonly value: CompositionCapabilityCommand
  readonly env: NodeJS.ProcessEnv
  readonly reason?: 'CommandFailure' | 'ProjectionFailure'
}): Promise<{ readonly stdout: string; readonly stderr: string }> => {
  try {
    return await execFile(value.executable, [...value.args], {
      encoding: 'utf8',
      env,
      maxBuffer: 1024 * 1024,
    })
  } catch (cause) {
    throw commandFailure({
      value,
      message: `Exact command failed: ${value.executable} ${value.args.join(' ')}`,
      ...(reason === undefined ? {} : { reason }),
      cause,
    })
  }
}

const assertExecutable = async ({
  path,
  name,
}: {
  readonly path: string
  readonly name: string
}) => {
  assertAbsoluteNormalized({ value: path, name })
  try {
    const info = await stat(path)
    if (info.isFile() === false) throw new Error('not a regular file')
    await access(path, 1)
  } catch (cause) {
    throw new CompositionCapabilityResolutionError({
      reason: 'InvalidRuntime',
      message: `${name} is not a regular executable file`,
      path,
      cause,
    })
  }
}

const validateRuntime = async (runtime: CompositionCapabilityRuntime): Promise<void> =>
  assertExecutable({ path: runtime.nixPath, name: 'nixPath' })

interface RegularFileIdentity {
  readonly path: string
  readonly realpath: string
  readonly device: number
  readonly inode: number
  readonly digest: string
}

const captureContainedRegularFile = async ({
  root,
  path,
  label,
}: {
  readonly root: string
  readonly path: string
  readonly label: string
}): Promise<RegularFileIdentity> => {
  let handle
  try {
    const pathInfo = await lstat(path)
    const canonicalPath = await realpath(path)
    if (
      pathInfo.isFile() === false ||
      pathInfo.isSymbolicLink() === true ||
      containedBy({ root, path: canonicalPath }) === false
    ) {
      throw invalidInput({ message: `${label} must be a contained regular file`, path })
    }
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const before = await handle.stat()
    const bytes = await handle.readFile()
    const after = await handle.stat()
    if (
      before.isFile() === false ||
      before.dev !== pathInfo.dev ||
      before.ino !== pathInfo.ino ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    ) {
      throw invalidInput({ message: `${label} identity changed while reading`, path })
    }
    return {
      path,
      realpath: canonicalPath,
      device: before.dev,
      inode: before.ino,
      digest: createHash('sha256').update(bytes).digest('hex'),
    }
  } finally {
    await handle?.close()
  }
}

const assertRegularFileIdentity = async (identity: RegularFileIdentity): Promise<void> => {
  try {
    const current = await captureContainedRegularFile({
      root: NodePath.dirname(identity.realpath),
      path: identity.path,
      label: 'flake.lock',
    })
    if (
      current.realpath !== identity.realpath ||
      current.device !== identity.device ||
      current.inode !== identity.inode ||
      current.digest !== identity.digest
    ) {
      throw new TypeError('flake.lock identity changed')
    }
  } catch (cause) {
    throw new CompositionCapabilityResolutionError({
      reason: 'InvalidLock',
      message: 'flake.lock bytes or inode changed during capability resolution',
      path: identity.path,
      cause,
    })
  }
}

const validateMember = async ({
  memberRoot,
}: {
  readonly memberRoot: string
}): Promise<{
  readonly memberRoot: string
  readonly lock: RegularFileIdentity
}> => {
  assertAbsoluteNormalized({ value: memberRoot, name: 'memberRoot' })
  const canonicalMemberRoot = await realpath(memberRoot)
  if ((await stat(canonicalMemberRoot)).isDirectory() === false) {
    throw invalidInput({ message: 'memberRoot must be a directory', path: memberRoot })
  }
  try {
    const lock = await captureContainedRegularFile({
      root: canonicalMemberRoot,
      path: NodePath.join(canonicalMemberRoot, 'flake.lock'),
      label: 'flake.lock',
    })
    return { memberRoot: canonicalMemberRoot, lock }
  } catch (cause) {
    throw new CompositionCapabilityResolutionError({
      reason: 'InvalidLock',
      message: 'Member must contain a regular, contained, immutable flake.lock',
      path: NodePath.join(canonicalMemberRoot, 'flake.lock'),
      cause,
    })
  }
}

interface DirectoryIdentity {
  readonly path: string
  readonly realpath: string
  readonly device: number
  readonly inode: number
  readonly owner: number
}

type CandidateRootIdentity = DirectoryIdentity

type PrivateScratchIdentity = DirectoryIdentity

const candidateReplaced = ({ path, cause }: { readonly path: string; readonly cause?: unknown }) =>
  new CompositionCapabilityResolutionError({
    reason: 'CandidateReplaced',
    message: `Capability projection candidate ownership changed at '${path}'`,
    path,
    ...(cause === undefined ? {} : { cause }),
  })

const currentUid = (): number => {
  const uid = process.getuid?.()
  if (uid === undefined) {
    throw new CompositionCapabilityResolutionError({
      reason: 'InvalidRuntime',
      message: 'Capability resolution requires a POSIX process uid',
    })
  }
  return uid
}

const assertSecureParent = async ({
  path,
  uid,
}: {
  readonly path: string
  readonly uid: number
}) => {
  const parent = NodePath.dirname(path)
  const info = await lstat(parent)
  const sticky = (info.mode & 0o1000) !== 0
  const ownerPrivate = info.uid === uid && (info.mode & 0o022) === 0
  if (
    info.isDirectory() === false ||
    info.isSymbolicLink() === true ||
    (sticky === false && ownerPrivate === false)
  ) {
    throw new Error(`private scratch parent is neither sticky nor owner-private: ${parent}`)
  }
}

const defaultCreatePrivateScratch = async (): Promise<CompositionCapabilityPrivateScratch> => {
  const uid = currentUid()
  const tempRoot = await realpath(tmpdir())
  await assertSecureParent({ path: NodePath.join(tempRoot, 'entry'), uid })
  const path = await mkdtemp(NodePath.join(tempRoot, 'megarepo-capabilities-'))
  await chmod(path, 0o700)
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) }
}

const capturePrivateScratchIdentity = async (
  scratch: CompositionCapabilityPrivateScratch,
): Promise<PrivateScratchIdentity> => {
  assertAbsoluteNormalized({ value: scratch.path, name: 'private scratch path' })
  try {
    const uid = currentUid()
    const info = await lstat(scratch.path)
    const canonicalPath = await realpath(scratch.path)
    await assertSecureParent({ path: scratch.path, uid })
    if (
      info.isDirectory() === false ||
      info.isSymbolicLink() === true ||
      (info.mode & 0o777) !== 0o700 ||
      info.uid !== uid ||
      canonicalPath !== scratch.path
    ) {
      throw new Error('private scratch is not a canonical mode-0700 directory owned by this uid')
    }
    return {
      path: scratch.path,
      realpath: canonicalPath,
      device: info.dev,
      inode: info.ino,
      owner: info.uid,
    }
  } catch (cause) {
    throw candidateReplaced({ path: scratch.path, cause })
  }
}

const captureCandidateRootIdentity = async ({
  path,
  scratch,
}: {
  readonly path: string
  readonly scratch: PrivateScratchIdentity
}): Promise<CandidateRootIdentity> => {
  try {
    const info = await lstat(path)
    const canonicalPath = await realpath(path)
    if (
      info.isDirectory() === false ||
      info.isSymbolicLink() === true ||
      (info.mode & 0o777) !== 0o700 ||
      info.uid !== scratch.owner ||
      containedBy({ root: scratch.realpath, path: canonicalPath }) === false
    ) {
      throw new Error('candidate is not a private contained directory')
    }
    return {
      path,
      realpath: canonicalPath,
      device: info.dev,
      inode: info.ino,
      owner: info.uid,
    }
  } catch (cause) {
    throw candidateReplaced({ path, cause })
  }
}

const assertDirectoryIdentity = async (identity: DirectoryIdentity): Promise<void> => {
  try {
    const info = await lstat(identity.path)
    const canonicalPath = await realpath(identity.path)
    if (
      info.isDirectory() === false ||
      info.isSymbolicLink() === true ||
      (info.mode & 0o777) !== 0o700 ||
      info.dev !== identity.device ||
      info.ino !== identity.inode ||
      info.uid !== identity.owner ||
      canonicalPath !== identity.realpath
    ) {
      throw new Error('directory identity no longer matches its captured inode')
    }
  } catch (cause) {
    throw candidateReplaced({ path: identity.path, cause })
  }
}

const makeDirectoriesOwnerWritable = async (path: string): Promise<void> => {
  const info = await lstat(path)
  if (info.isDirectory() === false || info.isSymbolicLink() === true) return
  await chmod(path, 0o700)
  await Promise.all(
    (await readdir(path)).map((child) => makeDirectoriesOwnerWritable(NodePath.join(path, child))),
  )
}

const normalizeR6SourceModes = async (path: string): Promise<void> => {
  const info = await lstat(path)
  if (info.isDirectory() === true) {
    await Promise.all(
      (await readdir(path)).map((child) => normalizeR6SourceModes(NodePath.join(path, child))),
    )
    await chmod(path, 0o755)
  } else if (info.isFile() === true) {
    await chmod(path, (info.mode & 0o111) === 0 ? 0o444 : 0o555)
  }
}

const makeScratchRelease = ({
  scratch,
  identity,
}: {
  readonly scratch: CompositionCapabilityPrivateScratch
  readonly identity: PrivateScratchIdentity
}): (() => Promise<void>) => {
  let released = false
  return async () => {
    if (released === true) return
    await assertDirectoryIdentity(identity)
    await makeDirectoriesOwnerWritable(identity.path)
    await scratch.cleanup()
    released = true
  }
}

const executableDigest = async (path: string): Promise<`sha256:${string}`> => {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', resolve)
  })
  return `sha256:${hash.digest('hex')}`
}

const singleNixOutput = ({
  stdout,
  capability,
  value,
}: {
  readonly stdout: string
  readonly capability: BuckMemberCapability
  readonly value: CompositionCapabilityCommand
}): string => {
  const lines = stdout.split(/\r?\n/u).filter((line) => line.length > 0)
  if (lines.length !== 1 || /^\/nix\/store\/[^/\s]+$/u.test(lines[0] ?? '') === false) {
    throw new CompositionCapabilityResolutionError({
      reason: 'InvalidNixOutput',
      message: `Nix must return exactly one /nix/store output for capability '${capability.toolId}'`,
      command: value,
    })
  }
  return lines[0]!
}

/** Exactly the Nix invocations one capability needs: realize it, then read its runtime closure. */
interface CapabilityNixCommands {
  readonly build: CompositionCapabilityCommand
  readonly closure: CompositionCapabilityCommand
}

const closureStorePaths = ({
  stdout,
  capability,
  nixOutputPath,
  value,
}: {
  readonly stdout: string
  readonly capability: BuckMemberCapability
  readonly nixOutputPath: string
  readonly value: CompositionCapabilityCommand
}): ReadonlyArray<string> => {
  const lines = stdout.split(/\r?\n/u).filter((line) => line.length > 0)
  const invalid =
    lines.length === 0 ||
    lines.some((line) => /^\/nix\/store\/[^/\s]+$/u.test(line) === false) ||
    lines.includes(nixOutputPath) === false
  if (invalid === true) {
    throw new CompositionCapabilityResolutionError({
      reason: 'InvalidNixOutput',
      message: `Nix must return the complete /nix/store closure of '${nixOutputPath}' for capability '${capability.toolId}'`,
      command: value,
    })
  }
  return [...new Set(lines)].toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

const resolveCapability = async ({
  capability,
  nixCommands,
  env,
  lock,
}: {
  readonly capability: BuckMemberCapability
  readonly nixCommands: CapabilityNixCommands
  readonly env: NodeJS.ProcessEnv
  readonly lock: RegularFileIdentity
}): Promise<ResolvedCompositionCapability> => {
  const { stdout } = await run({ value: nixCommands.build, env }).finally(() =>
    assertRegularFileIdentity(lock),
  )
  const nixOutputPath = singleNixOutput({ stdout, capability, value: nixCommands.build })
  const closure = await run({ value: nixCommands.closure, env }).finally(() =>
    assertRegularFileIdentity(lock),
  )
  const closurePaths = closureStorePaths({
    stdout: closure.stdout,
    capability,
    nixOutputPath,
    value: nixCommands.closure,
  })
  const declaredExecutable = NodePath.join(nixOutputPath, capability.executable)
  try {
    const [canonicalOutput, outputInfo, executableInfo] = await Promise.all([
      realpath(nixOutputPath),
      stat(nixOutputPath),
      stat(declaredExecutable),
    ])
    if (outputInfo.isDirectory() === false || executableInfo.isFile() === false) {
      throw new Error('output must be a directory and executable must be a regular file')
    }
    await access(declaredExecutable, 1)
    const executablePath = await realpath(declaredExecutable)
    if (containedBy({ root: canonicalOutput, path: executablePath }) === false) {
      throw new Error('executable realpath escapes its exact Nix output')
    }
    return {
      capability,
      nixOutputPath,
      executablePath,
      executableDigest: await executableDigest(executablePath),
      closureStorePaths: closurePaths,
    }
  } catch (cause) {
    throw new CompositionCapabilityResolutionError({
      reason: 'InvalidExecutable',
      message: `Capability '${capability.toolId}' does not provide a contained regular executable '${capability.executable}'`,
      path: declaredExecutable,
      cause,
    })
  }
}

const resolveCapabilitiesInOrder = ({
  capabilities,
  nixCommands,
  env,
  lock,
}: {
  readonly capabilities: ReadonlyArray<BuckMemberCapability>
  readonly nixCommands: ReadonlyArray<CapabilityNixCommands>
  readonly env: NodeJS.ProcessEnv
  readonly lock: RegularFileIdentity
}): Promise<Array<ResolvedCompositionCapability>> => {
  const resolved = [] as Array<ResolvedCompositionCapability>
  const next = (index: number): Promise<Array<ResolvedCompositionCapability>> => {
    const capability = capabilities[index]
    if (capability === undefined) return Promise.resolve(resolved)
    return resolveCapability({ capability, nixCommands: nixCommands[index]!, env, lock }).then(
      (value) => {
        resolved.push(value)
        return next(index + 1)
      },
    )
  }
  return next(0)
}

const safeNixEnvironment = ({
  runtime,
  privateRoot,
}: {
  readonly runtime: CompositionCapabilityRuntime
  readonly privateRoot: string
}): NodeJS.ProcessEnv => {
  const source = runtime.env ?? {}
  return {
    HOME: privateRoot,
    TMPDIR: privateRoot,
    ...(source['NIX_SSL_CERT_FILE'] === undefined
      ? {}
      : { NIX_SSL_CERT_FILE: source['NIX_SSL_CERT_FILE'] }),
    ...(source['SSL_CERT_FILE'] === undefined ? {} : { SSL_CERT_FILE: source['SSL_CERT_FILE'] }),
  }
}

const ToolProjectionManifest = Schema.Struct({
  closureIdentity: Schema.String,
  closureStorePaths: Schema.Array(Schema.String),
  contentDigest: Schema.String,
  executableStorePath: Schema.String,
  executionPlatform: Schema.Literals(['x86_64-linux', 'aarch64-linux', 'aarch64-macos']),
  protocol: Schema.String,
  runtimeContract: Schema.Literal('native-executable/v1'),
  schema: Schema.Literal('effect-utils/buck2-support-tools/v1'),
  toolId: Schema.String,
})
const ToolProjectionManifestJson = Schema.fromJsonString(ToolProjectionManifest)
type ToolProjectionManifest = typeof ToolProjectionManifest.Type

/**
 * Per-tool projected manifest identity as written into `.buck2/capabilities`. GC-root
 * registration reads the installed projection through this exact schema, so the paths it roots
 * are the paths Buck actions execute and read.
 */
export const CapabilityProjectionManifestJsonSchema = ToolProjectionManifestJson
/** Decoded per-tool projected manifest: the tool's pinned realization, closure, and protocol. */
export type CapabilityProjectionManifest = ToolProjectionManifest

const toolBuckBytes =
  'export_file(name = "executable", src = "executable", visibility = ["PUBLIC"])\n' +
  'export_file(name = "manifest", src = "manifest.json", visibility = ["PUBLIC"])\n'
const rootBuckBytes = '# Generated from exact Nix realizations.\n'

const atomicWrite = async ({ path, bytes }: { readonly path: string; readonly bytes: string }) => {
  const temporary = `${path}.tmp-${randomUUID()}`
  await writeFile(temporary, bytes, { flag: 'wx' })
  await rename(temporary, path)
}

const manifestBytes = (manifest: ToolProjectionManifest): string =>
  `${Schema.encodeSync(ToolProjectionManifestJson)(manifest)}\n`

const computeGeneration = (
  files: ReadonlyArray<{ readonly path: string; readonly bytes: string }>,
) => {
  const framed = files
    .toSorted((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    .map(({ path, bytes }) => `${createHash('sha256').update(bytes).digest('hex')}  ./${path}\n`)
    .join('')
  const payloadDigest = createHash('sha256').update(framed).digest('hex')
  return createHash('sha256').update(`${payloadDigest}  -\n`).digest('hex')
}

const renderDefs = ({
  generation,
  platform,
  manifests,
}: {
  readonly generation: string
  readonly platform: string
  readonly manifests: ReadonlyArray<ToolProjectionManifest>
}) =>
  [
    `GENERATION = "${generation}"`,
    'CAPABILITIES = {',
    `  "${platform}": {`,
    ...manifests.map(
      (manifest) =>
        `    "${manifest.toolId}": {"generation": "${generation}", "contentDigest": "${manifest.contentDigest}", "closureIdentity": "${manifest.closureIdentity}", "executableStorePath": "${manifest.executableStorePath}", "closureStorePaths": [${manifest.closureStorePaths.map((path) => `"${path}"`).join(', ')}]},`,
    ),
    '  },',
    '}',
    '',
  ].join('\n')

const projectResolvedCapabilities = async ({
  candidateRoot,
  platform,
  resolved,
}: {
  readonly candidateRoot: string
  readonly platform: 'x86_64-linux' | 'aarch64-linux' | 'aarch64-macos'
  readonly resolved: ReadonlyArray<ResolvedCompositionCapability>
}) => {
  const manifests = resolved.map(
    ({ capability, executablePath, executableDigest, closureStorePaths: closure }) => ({
      closureIdentity: NodePath.dirname(NodePath.dirname(executablePath)),
      closureStorePaths: closure,
      contentDigest: executableDigest.slice('sha256:'.length),
      executableStorePath: executablePath,
      executionPlatform: platform,
      protocol: capability.protocol,
      runtimeContract: 'native-executable/v1' as const,
      schema: 'effect-utils/buck2-support-tools/v1' as const,
      toolId: capability.toolId,
    }),
  )
  const files = manifests.flatMap((manifest) => [
    { path: `${platform}/${manifest.toolId}/BUCK`, bytes: toolBuckBytes },
    { path: `${platform}/${manifest.toolId}/manifest.json`, bytes: manifestBytes(manifest) },
  ])
  const generation = computeGeneration(files)
  const projectionPath = NodePath.join(candidateRoot, '.buck2', 'capabilities')
  const generationRoot = NodePath.join(projectionPath, 'generations', generation, platform)
  await mkdir(generationRoot, { recursive: true })
  await Promise.all(
    manifests.map(async (manifest) => {
      const directory = NodePath.join(generationRoot, manifest.toolId)
      await mkdir(directory)
      await symlink(manifest.executableStorePath, NodePath.join(directory, 'executable'))
      await atomicWrite({
        path: NodePath.join(directory, 'manifest.json'),
        bytes: manifestBytes(manifest),
      })
      await atomicWrite({ path: NodePath.join(directory, 'BUCK'), bytes: toolBuckBytes })
    }),
  )
  await atomicWrite({ path: NodePath.join(projectionPath, 'BUCK'), bytes: rootBuckBytes })
  await atomicWrite({
    path: NodePath.join(projectionPath, 'defs.bzl'),
    bytes: renderDefs({ generation, platform, manifests }),
  })
  return { projectionPath, generation }
}

/**
 * A projected closure is the sandbox read allowlist, so it must be complete, canonical, and
 * present: strictly sorted unique store paths, containing the tool's own realization, each still
 * valid in the local store.
 */
const assertProjectedClosure = async ({
  manifest,
  path,
}: {
  readonly manifest: ToolProjectionManifest
  readonly path: string
}): Promise<void> => {
  const paths = manifest.closureStorePaths
  const canonical = paths.every(
    (value, index) =>
      /^\/nix\/store\/[^/]+$/u.test(value) === true && (index === 0 || value > paths[index - 1]!),
  )
  if (paths.length === 0 || canonical === false) {
    throw invalidInput({ message: 'Capability closure paths are not canonical', path })
  }
  if (paths.includes(manifest.closureIdentity) === false) {
    throw invalidInput({ message: 'Capability closure omits its own realization', path })
  }
  await Promise.all(
    paths.map(async (storePath) => {
      try {
        await lstat(storePath)
      } catch (cause) {
        throw invalidInput({ message: 'Capability closure path is absent', path: storePath, cause })
      }
    }),
  )
}

/** Validate a capability projection without executing member-controlled code. */
const checkCompositionCapabilityProjectionInternal = async ({
  memberRoot,
}: {
  readonly memberRoot: string
}): Promise<void> => {
  const projectionPath = NodePath.join(memberRoot, '.buck2', 'capabilities')
  const defs = await readFile(NodePath.join(projectionPath, 'defs.bzl'), 'utf8')
  const match = /^GENERATION = "([0-9a-f]{64})"$/mu.exec(defs)
  if (match === null)
    throw invalidInput({ message: 'Capability defs generation is invalid', path: projectionPath })
  const generation = match[1]!
  if ((await readFile(NodePath.join(projectionPath, 'BUCK'), 'utf8')) !== rootBuckBytes) {
    throw invalidInput({ message: 'Capability root BUCK is invalid', path: projectionPath })
  }
  const generationRoot = NodePath.join(projectionPath, 'generations', generation)
  const platforms = await readdir(generationRoot)
  if (platforms.length !== 1)
    throw invalidInput({
      message: 'Capability generation must contain one platform',
      path: generationRoot,
    })
  const platform = platforms[0]!
  const toolRoot = NodePath.join(generationRoot, platform)
  const tools = (await readdir(toolRoot)).toSorted()
  const checked = await Promise.all(
    tools.map(async (toolId) => {
      const directory = NodePath.join(toolRoot, toolId)
      const manifestFile = NodePath.join(directory, 'manifest.json')
      const encoded = await readFile(manifestFile, 'utf8')
      const manifest = Schema.decodeUnknownSync(
        ToolProjectionManifestJson,
        strictParseOptions,
      )(encoded.trimEnd())
      if (manifest.toolId !== toolId || manifest.executionPlatform !== platform) {
        throw invalidInput({ message: 'Capability manifest identity mismatch', path: manifestFile })
      }
      const executable = await realpath(NodePath.join(directory, 'executable'))
      if (
        executable !== manifest.executableStorePath ||
        (await executableDigest(executable)).slice(7) !== manifest.contentDigest
      ) {
        throw invalidInput({ message: 'Capability executable identity mismatch', path: executable })
      }
      await assertProjectedClosure({ manifest, path: manifestFile })
      if ((await readFile(NodePath.join(directory, 'BUCK'), 'utf8')) !== toolBuckBytes) {
        throw invalidInput({ message: 'Capability tool BUCK is invalid', path: directory })
      }
      return {
        manifest,
        files: [
          { path: `${platform}/${toolId}/BUCK`, bytes: toolBuckBytes },
          { path: `${platform}/${toolId}/manifest.json`, bytes: encoded },
        ],
      }
    }),
  )
  const manifests = checked.map(({ manifest }) => manifest)
  const files = checked.flatMap(({ files }) => files)
  if (
    computeGeneration(files) !== generation ||
    defs !== renderDefs({ generation, platform, manifests })
  ) {
    throw invalidInput({
      message: 'Capability projection generation or defs mismatch',
      path: projectionPath,
    })
  }
}

interface ProjectionIdentity {
  readonly path: string
  readonly realpath: string
  readonly device: number
  readonly inode: number
}

const captureProjectionIdentity = async ({
  projectionPath,
  candidate,
}: {
  readonly projectionPath: string
  readonly candidate: CandidateRootIdentity
}): Promise<ProjectionIdentity> => {
  try {
    const info = await lstat(projectionPath)
    const canonicalPath = await realpath(projectionPath)
    if (
      info.isDirectory() === false ||
      info.isSymbolicLink() === true ||
      containedBy({ root: candidate.realpath, path: canonicalPath }) === false
    ) {
      throw new Error('projection is not a real directory contained by the candidate')
    }
    return {
      path: projectionPath,
      realpath: canonicalPath,
      device: info.dev,
      inode: info.ino,
    }
  } catch (cause) {
    throw new CompositionCapabilityResolutionError({
      reason: 'ProjectionFailure',
      message: 'Checked projection directory identity is invalid',
      path: projectionPath,
      cause,
    })
  }
}

const assertProjectionIdentity = async (identity: ProjectionIdentity): Promise<void> => {
  try {
    const info = await lstat(identity.path)
    const canonicalPath = await realpath(identity.path)
    if (
      info.isDirectory() === false ||
      info.isSymbolicLink() === true ||
      info.dev !== identity.device ||
      info.ino !== identity.inode ||
      canonicalPath !== identity.realpath
    ) {
      throw new Error('projection identity changed')
    }
  } catch (cause) {
    throw new CompositionCapabilityResolutionError({
      reason: 'ProjectionFailure',
      message: 'Checked projection directory was replaced while digesting',
      path: identity.path,
      cause,
    })
  }
}

const projectionDigest = async ({
  projection,
  candidate,
}: {
  readonly projection: ProjectionIdentity
  readonly candidate: CandidateRootIdentity
}): Promise<string> => {
  await assertDirectoryIdentity(candidate)
  await assertProjectionIdentity(projection)
  const defsPath = NodePath.join(projection.path, 'defs.bzl')
  let handle
  try {
    const pathInfo = await lstat(defsPath)
    const canonicalPath = await realpath(defsPath)
    if (
      pathInfo.isFile() === false ||
      pathInfo.isSymbolicLink() === true ||
      containedBy({ root: projection.realpath, path: canonicalPath }) === false
    ) {
      throw new Error('defs.bzl is not a contained regular file')
    }
    handle = await open(defsPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    const before = await handle.stat()
    const defs = await handle.readFile({ encoding: 'utf8' })
    const after = await handle.stat()
    if (
      before.isFile() === false ||
      before.dev !== pathInfo.dev ||
      before.ino !== pathInfo.ino ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    ) {
      throw new Error('defs.bzl inode changed while reading')
    }
    const matches = [...defs.matchAll(/^GENERATION = "([0-9a-f]{64})"$/gmu)]
    if (matches.length !== 1) {
      throw new Error('defs.bzl does not declare exactly one valid GENERATION')
    }
    await assertProjectionIdentity(projection)
    await assertDirectoryIdentity(candidate)
    return matches[0]![1]!
  } catch (cause) {
    throw new CompositionCapabilityResolutionError({
      reason: 'ProjectionFailure',
      message: 'Checked projection could not be digested without following links',
      path: defsPath,
      cause,
    })
  } finally {
    await handle?.close()
  }
}

/**
 * Resolve and project one strict tracked member manifest without writing into the member.
 *
 * The resolver creates and owns a private scratch parent. Other processes running as the same uid
 * are inside the trust boundary; arbitrary caller-controlled workspace paths are not. A successful
 * handle retains the projection until `release` is called. Failures release only the captured
 * private scratch inode.
 */
const resolveCompositionCapabilitiesInternal = async (
  input: ResolveCompositionCapabilitiesInput,
): Promise<ResolveCompositionCapabilitiesResult> => {
  let release: (() => Promise<void>) | undefined
  try {
    const manifest = decodeBuckMemberManifest(input.manifest)
    const system = Schema.decodeUnknownSync(
      CompositionCapabilitySystemSchema,
      strictParseOptions,
    )(input.system)
    await validateRuntime(input.runtime)
    const roots = await validateMember(input)
    const capabilities = buckMemberProjectedCapabilitiesForSystem({ manifest, system }).toSorted(
      (left, right) => (left.toolId < right.toolId ? -1 : left.toolId > right.toolId ? 1 : 0),
    )
    const nonce = (input.runtime.nonce ?? randomUUID)()
    if (/^[A-Za-z0-9._-]+$/u.test(nonce) === false) {
      throw invalidInput({
        message: 'runtime nonce must contain only portable filename characters',
      })
    }
    const plannedPrivateRoot = NodePath.join(
      NodePath.resolve(tmpdir()),
      `.megarepo-capabilities-planned-${nonce}`,
    )
    const plannedCandidateRoot = NodePath.join(plannedPrivateRoot, 'candidate')
    const projectorPlatform = platformFor(system)
    const capabilityCommands = capabilities.map((capability) => {
      const installable = `${roots.memberRoot}#${capability.flakePackage}^out`
      return {
        build: command({
          executable: input.runtime.nixPath,
          args: [
            'build',
            '--no-link',
            '--print-out-paths',
            '--no-write-lock-file',
            '--no-update-lock-file',
            installable,
          ],
        }),
        // The realization already exists, so the closure query stays offline: the exact set of
        // store paths a sandboxed action may read comes from the store, never from a substituter.
        closure: command({
          executable: input.runtime.nixPath,
          args: [
            'path-info',
            '--recursive',
            '--offline',
            '--no-write-lock-file',
            '--no-update-lock-file',
            installable,
          ],
        }),
      }
    })
    const nixCommands = capabilityCommands.flatMap(({ build, closure }) => [build, closure])
    if (input.dryRun === true) {
      return {
        _tag: 'Planned',
        system,
        projectorPlatform,
        candidateRoot: plannedCandidateRoot,
        nixCommands,
      }
    }

    const scratch = await (input.runtime.createPrivateScratch ?? defaultCreatePrivateScratch)()
    const scratchIdentity = await capturePrivateScratchIdentity(scratch)
    release = makeScratchRelease({ scratch, identity: scratchIdentity })
    const env = safeNixEnvironment({ runtime: input.runtime, privateRoot: scratchIdentity.path })
    const resolved = await resolveCapabilitiesInOrder({
      capabilities,
      nixCommands: capabilityCommands,
      env,
      lock: roots.lock,
    })
    await assertRegularFileIdentity(roots.lock)
    const candidateRoot = NodePath.join(scratchIdentity.path, 'candidate')
    await mkdir(candidateRoot, { mode: 0o700 })
    const candidateIdentity = await captureCandidateRootIdentity({
      path: candidateRoot,
      scratch: scratchIdentity,
    })
    await input.runtime.afterCandidateCreated?.(candidateRoot)
    await assertDirectoryIdentity(scratchIdentity)
    await assertDirectoryIdentity(candidateIdentity)

    const projected = await projectResolvedCapabilities({
      candidateRoot,
      platform: projectorPlatform,
      resolved,
    })
    await checkCompositionCapabilityProjection({ memberRoot: candidateRoot })
    const projectionPath = projected.projectionPath
    await input.runtime.beforeProjectionDigest?.({ candidateRoot, projectionPath })
    await assertDirectoryIdentity(candidateIdentity)
    const projection = await captureProjectionIdentity({
      projectionPath,
      candidate: candidateIdentity,
    })
    const digest = await projectionDigest({ projection, candidate: candidateIdentity })
    await normalizeR6SourceModes(projectionPath)
    await assertRegularFileIdentity(roots.lock)
    return {
      _tag: 'Resolved',
      system,
      projectorPlatform,
      candidateRoot,
      projectionPath,
      projectionDigest: digest,
      capabilities: resolved,
      capabilitiesByToolId: Object.fromEntries(
        resolved.map((capability) => [capability.capability.toolId, capability]),
      ),
      nixCommands,
      release,
    }
  } catch (cause) {
    if (release !== undefined) {
      try {
        await release()
      } catch {
        // Refuse to invoke an injected cleanup after the captured private root was replaced.
      }
    }
    if (cause instanceof CompositionCapabilityResolutionError) throw cause
    throw invalidInput({ message: 'Invalid composition capability resolver input', cause })
  }
}

/** Fail-closed resolved capability lookup used by Buck/tool consumers. */
const resolvedCompositionCapabilityByToolIdInternal = ({
  resolution,
  toolId,
}: {
  readonly resolution: CompositionCapabilityResolutionHandle
  readonly toolId: string
}): ResolvedCompositionCapability => {
  const capability = resolution.capabilitiesByToolId[toolId]
  if (capability === undefined) {
    throw invalidInput({ message: `Resolved capability '${toolId}' is absent` })
  }
  return capability
}
