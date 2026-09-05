import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, readlink, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as NodePath from 'node:path'
import { promisify } from 'node:util'

import { Schema } from 'effect'

import {
  CapabilityProjectionManifestJsonSchema,
  type CapabilityProjectionManifest,
} from './composition-capability-resolver.ts'

const execFile = promisify(execFileCallback)
const strictParseOptions = { errors: 'all', onExcessProperty: 'error' } as const
const generationPattern = /^[0-9a-f]{64}$/u
const storePathPattern = /^\/nix\/store\/[^/\s]+$/u

/**
 * Structured refusal from capability GC-root registration, reconciliation, or verification.
 *
 * `Unrooted` is the load-bearing one: it means the installed projection points at store paths the
 * garbage collector is free to delete, which is exactly the failure this module exists to prevent.
 */
export class CapabilityGcRootError extends Schema.TaggedError<CapabilityGcRootError>()(
  'CapabilityGcRootError',
  {
    reason: Schema.Literals([
      'InvalidInput',
      'InvalidProjection',
      'RegistrationFailed',
      'Unrooted',
      'ReconcileFailed',
    ]),
    path: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * Pinned Nix identity used to register indirect GC roots. `nixPath` must be the same exact binary
 * the resolver realized the capability with; PATH is never consulted.
 */
export interface CapabilityGcRootRuntime {
  readonly nixPath: string
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Nix state directory holding `gcroots/auto`. Defaults to `NIX_STATE_DIR` or `/nix/var/nix`. */
  readonly nixStateDir?: string
}

/** One registered indirect GC root: a Nix-owned link retaining exactly one capability output. */
export interface CapabilityGcRoot {
  readonly toolId: string
  readonly linkPath: string
  readonly storePath: string
}

/** Registered roots of one projection generation, plus its single execution platform. */
export interface CapabilityGcRootGeneration {
  readonly generation: string
  readonly platform: string
  readonly roots: ReadonlyArray<CapabilityGcRoot>
}

const failure = ({
  reason,
  path,
  message,
  cause,
}: {
  readonly reason: CapabilityGcRootError['reason']
  readonly path: string
  readonly message: string
  readonly cause?: unknown
}) =>
  new CapabilityGcRootError({
    reason,
    path,
    message,
    ...(cause === undefined ? {} : { cause }),
  })

/**
 * GC-root directory of an owned member. It is deliberately a sibling of `.buck2/capabilities`:
 * the projection is published by exchanging that directory, and an exchanged root link would
 * leave every indirect root registered against a path that no longer exists.
 */
export const capabilityGcRootsPath = ({
  ownedMemberPath,
}: {
  readonly ownedMemberPath: string
}): string => NodePath.join(ownedMemberPath, '.buck2', 'capability-gcroots')

const assertGeneration = ({
  generation,
  path,
}: {
  readonly generation: string
  readonly path: string
}) => {
  if (generationPattern.test(generation) === false) {
    throw failure({
      reason: 'InvalidInput',
      path,
      message: 'Capability generation must be a 64-character lowercase hex digest',
    })
  }
}

/** One capability generation as projected on disk: exactly one platform, one manifest per tool. */
interface ProjectedGeneration {
  readonly platform: string
  readonly manifests: ReadonlyArray<CapabilityProjectionManifest>
}

const readProjectedGeneration = async ({
  projectionPath,
  generation,
}: {
  readonly projectionPath: string
  readonly generation: string
}): Promise<ProjectedGeneration> => {
  const generationRoot = NodePath.join(projectionPath, 'generations', generation)
  try {
    const platforms = (await readdir(generationRoot)).toSorted()
    if (platforms.length !== 1) {
      throw new TypeError('a capability generation must contain exactly one platform')
    }
    const platform = platforms[0]!
    const platformRoot = NodePath.join(generationRoot, platform)
    const toolIds = (await readdir(platformRoot)).toSorted()
    if (toolIds.length === 0) throw new TypeError('a capability generation must project one tool')
    const manifests = await Promise.all(
      toolIds.map(async (toolId) => {
        const encoded = await readFile(NodePath.join(platformRoot, toolId, 'manifest.json'), 'utf8')
        const manifest = Schema.decodeUnknownSync(
          CapabilityProjectionManifestJsonSchema,
          strictParseOptions,
        )(encoded.trimEnd())
        if (manifest.toolId !== toolId || manifest.executionPlatform !== platform) {
          throw new TypeError(`manifest identity mismatch for '${toolId}'`)
        }
        if (
          storePathPattern.test(manifest.closureIdentity) === false ||
          manifest.executableStorePath.startsWith(`${manifest.closureIdentity}${NodePath.sep}`) ===
            false
        ) {
          throw new TypeError(`manifest realization identity is not canonical for '${toolId}'`)
        }
        return manifest
      }),
    )
    return { platform, manifests }
  } catch (cause) {
    throw failure({
      reason: 'InvalidProjection',
      path: generationRoot,
      message: 'Capability generation could not be read as a projected generation',
      cause,
    })
  }
}

const NIX_STATE_DIRECTORY_DEFAULT = '/nix/var/nix'

/**
 * Nix stores indirect roots as links in `gcroots/auto` pointing back at the caller-owned link.
 * Reading them is how we prove Nix accepted the registration instead of trusting a bare symlink,
 * so an unreadable directory is a refusal: an unprovable root is treated as no root at all. The
 * directory is addressed through `nixStateDir`/`NIX_STATE_DIR`, which is also the only seam a
 * test uses to model a store whose roots cannot be proven.
 */
const readRegisteredIndirectRoots = async (
  runtime: CapabilityGcRootRuntime,
): Promise<ReadonlySet<string>> => {
  const autoDirectory = NodePath.join(
    runtime.nixStateDir ?? runtime.env?.['NIX_STATE_DIR'] ?? NIX_STATE_DIRECTORY_DEFAULT,
    'gcroots',
    'auto',
  )
  let entries: ReadonlyArray<string>
  try {
    entries = await readdir(autoDirectory)
  } catch (cause) {
    throw failure({
      reason: 'Unrooted',
      path: autoDirectory,
      message: 'Nix indirect GC roots cannot be proven: the store root directory is unreadable',
      cause,
    })
  }
  const targets = await Promise.all(
    entries.map((entry) => readlink(NodePath.join(autoDirectory, entry)).catch(() => undefined)),
  )
  return new Set(targets.filter((target): target is string => target !== undefined))
}

const nixEnvironment = async (
  runtime: CapabilityGcRootRuntime,
): Promise<{
  readonly env: NodeJS.ProcessEnv
  readonly release: () => Promise<void>
}> => {
  const source = runtime.env ?? {}
  const scratch = await mkdtemp(NodePath.join(NodePath.resolve(tmpdir()), 'megarepo-gcroots-'))
  return {
    env: {
      HOME: scratch,
      TMPDIR: scratch,
      ...(source['NIX_REMOTE'] === undefined ? {} : { NIX_REMOTE: source['NIX_REMOTE'] }),
      ...(source['NIX_STATE_DIR'] === undefined ? {} : { NIX_STATE_DIR: source['NIX_STATE_DIR'] }),
      ...(source['NIX_SSL_CERT_FILE'] === undefined
        ? {}
        : { NIX_SSL_CERT_FILE: source['NIX_SSL_CERT_FILE'] }),
      ...(source['SSL_CERT_FILE'] === undefined ? {} : { SSL_CERT_FILE: source['SSL_CERT_FILE'] }),
    },
    release: () => rm(scratch, { recursive: true, force: true }),
  }
}

/**
 * The new-CLI commands this module needs are still gated behind an experimental feature, and the
 * pinned Nix runs with a scrubbed environment that reaches no user or sandbox `nix.conf`. Naming
 * the feature in argv keeps each invocation self-sufficient instead of host-config dependent.
 */
const NIX_COMMAND_FEATURE = ['--extra-experimental-features', 'nix-command'] as const

/**
 * Register one indirect GC root with `nix build --out-link`. The realization already exists, so
 * the call stays offline: a missing store path must fail loudly instead of being substituted.
 */
const registerIndirectRoot = async ({
  runtime,
  env,
  storePath,
  linkPath,
}: {
  readonly runtime: CapabilityGcRootRuntime
  readonly env: NodeJS.ProcessEnv
  readonly storePath: string
  readonly linkPath: string
}): Promise<void> => {
  const args = [
    'build',
    ...NIX_COMMAND_FEATURE,
    '--offline',
    '--no-write-lock-file',
    '--no-update-lock-file',
    '--out-link',
    linkPath,
    storePath,
  ]
  try {
    await execFile(runtime.nixPath, args, { encoding: 'utf8', env, maxBuffer: 1024 * 1024 })
  } catch (cause) {
    throw failure({
      reason: 'RegistrationFailed',
      path: linkPath,
      message: `Nix could not register a GC root for '${storePath}'`,
      cause,
    })
  }
}

const capabilityClosure = async ({
  runtime,
  env,
  storePath,
}: {
  readonly runtime: CapabilityGcRootRuntime
  readonly env: NodeJS.ProcessEnv
  readonly storePath: string
}): Promise<ReadonlySet<string>> => {
  const args = [
    'path-info',
    ...NIX_COMMAND_FEATURE,
    '--recursive',
    '--offline',
    '--no-write-lock-file',
    '--no-update-lock-file',
    storePath,
  ]
  try {
    const { stdout } = await execFile(runtime.nixPath, args, {
      encoding: 'utf8',
      env,
      maxBuffer: 1024 * 1024,
    })
    const paths = stdout.split(/\r?\n/u).filter((line) => storePathPattern.test(line) === true)
    if (paths.includes(storePath) === false) {
      throw new TypeError('closure query omitted the realization itself')
    }
    return new Set(paths)
  } catch (cause) {
    throw failure({
      reason: 'RegistrationFailed',
      path: storePath,
      message: `Nix could not read the runtime closure of '${storePath}'`,
      cause,
    })
  }
}

/**
 * Register a durable indirect GC root for every capability output of one projected generation.
 *
 * Roots are created under their final per-generation path, never staged and renamed: an indirect
 * root is registered against the link path, so moving the link would strand it. Rooting a
 * realization retains its whole runtime closure, so this is also checked to cover exactly the
 * declared `closureStorePaths` Buck hands sandboxed actions as read roots.
 *
 * Registration is idempotent, so calling it again for the generation already installed repairs a
 * root somebody removed.
 */
export const installCapabilityGcRoots = async ({
  projectionPath,
  generation,
  gcRootsPath,
  runtime,
}: {
  readonly projectionPath: string
  readonly generation: string
  readonly gcRootsPath: string
  readonly runtime: CapabilityGcRootRuntime
}): Promise<CapabilityGcRootGeneration> => {
  assertGeneration({ generation, path: projectionPath })
  if (NodePath.isAbsolute(runtime.nixPath) === false) {
    throw failure({
      reason: 'InvalidInput',
      path: runtime.nixPath,
      message: 'Capability GC roots require an absolute pinned Nix path',
    })
  }
  const { platform, manifests } = await readProjectedGeneration({ projectionPath, generation })
  const generationRoot = NodePath.join(gcRootsPath, generation, platform)
  await mkdir(generationRoot, { recursive: true, mode: 0o700 })
  const { env, release } = await nixEnvironment(runtime)
  try {
    const roots = [] as Array<CapabilityGcRoot>
    // Registration mutates the store's root set, so capabilities are rooted strictly in manifest
    // order and the first refusal stops the walk: no later `nix build --out-link` runs once one
    // capability has failed. Tail recursion expresses that sequencing without awaiting in a loop.
    const registerFrom = async (index: number): Promise<void> => {
      const manifest = manifests[index]
      if (manifest === undefined) return
      const storePath = manifest.closureIdentity
      const closure = await capabilityClosure({ runtime, env, storePath })
      const missing = manifest.closureStorePaths.filter((path) => closure.has(path) === false)
      if (missing.length !== 0) {
        throw failure({
          reason: 'Unrooted',
          path: storePath,
          message: `Capability '${manifest.toolId}' declares ${String(missing.length)} closure path(s) outside the realization a GC root would retain: ${missing.join(', ')}`,
        })
      }
      const linkPath = NodePath.join(generationRoot, manifest.toolId)
      await registerIndirectRoot({ runtime, env, storePath, linkPath })
      const target = await readlink(linkPath).catch(() => undefined)
      if (target !== storePath) {
        throw failure({
          reason: 'RegistrationFailed',
          path: linkPath,
          message: `GC root for capability '${manifest.toolId}' does not point at '${storePath}'`,
        })
      }
      roots.push({ toolId: manifest.toolId, linkPath, storePath })
      return registerFrom(index + 1)
    }
    await registerFrom(0)
    const registered = await readRegisteredIndirectRoots(runtime)
    const unregistered = roots.filter((root) => registered.has(root.linkPath) === false)
    if (unregistered.length !== 0) {
      throw failure({
        reason: 'Unrooted',
        path: generationRoot,
        message: `Nix did not register indirect GC roots for: ${unregistered.map((root) => root.toolId).join(', ')}`,
      })
    }
    return { generation, platform, roots }
  } finally {
    await release()
  }
}

/**
 * Verify that the installed generation is rooted: every projected capability has a root link
 * pointing at its exact realization, that realization is still present in the store, and Nix
 * itself lists the link as an indirect root. A store whose roots cannot be read is a refusal.
 */
export const assertCapabilityGcRoots = async ({
  projectionPath,
  generation,
  gcRootsPath,
  runtime,
}: {
  readonly projectionPath: string
  readonly generation: string
  readonly gcRootsPath: string
  readonly runtime: CapabilityGcRootRuntime
}): Promise<CapabilityGcRootGeneration> => {
  assertGeneration({ generation, path: projectionPath })
  const { platform, manifests } = await readProjectedGeneration({ projectionPath, generation })
  const generationRoot = NodePath.join(gcRootsPath, generation, platform)
  const registered = await readRegisteredIndirectRoots(runtime)
  const roots = [] as Array<CapabilityGcRoot>
  const problems = [] as Array<string>
  // Both probes are read-only, so every capability is inspected up front and judged below in
  // manifest order; the reported problems stay exactly the ones a sequential walk would report.
  const inspected = await Promise.all(
    manifests.map(async (manifest) => {
      const linkPath = NodePath.join(generationRoot, manifest.toolId)
      const [target, executable] = await Promise.all([
        readlink(linkPath).catch(() => undefined),
        stat(manifest.executableStorePath).catch(() => undefined),
      ])
      return { manifest, linkPath, target, executable }
    }),
  )
  for (const { manifest, linkPath, target, executable } of inspected) {
    if (target === undefined) {
      problems.push(`${manifest.toolId}: no GC root link at '${linkPath}'`)
      continue
    }
    if (target !== manifest.closureIdentity) {
      problems.push(`${manifest.toolId}: GC root points at '${target}'`)
      continue
    }
    if (executable === undefined) {
      problems.push(
        `${manifest.toolId}: '${manifest.executableStorePath}' is absent from the store`,
      )
      continue
    }
    if (registered.has(linkPath) === false) {
      problems.push(`${manifest.toolId}: '${linkPath}' is not a registered indirect GC root`)
      continue
    }
    roots.push({ toolId: manifest.toolId, linkPath, storePath: manifest.closureIdentity })
  }
  if (problems.length !== 0) {
    throw failure({
      reason: 'Unrooted',
      path: generationRoot,
      message: `Installed capability generation ${generation} is not rooted: ${problems.join('; ')}`,
    })
  }
  return { generation, platform, roots }
}

/**
 * Keep exactly the roots of the generation that is installed right now and drop every other
 * generation, including abandoned candidates.
 *
 * Composition serializes installs per workspace behind the workspace update lock, so the normal
 * case has one writer. Reconciling against the freshly re-read installed generation also degrades
 * safely if that assumption is ever broken: a concurrent writer's roots are only dropped once its
 * generation is no longer the installed one, and an install whose own roots a racing reconcile
 * removed fails loudly in `assertCapabilityGcRoots`, which runs before this call.
 */
export const reconcileCapabilityGcRoots = async ({
  gcRootsPath,
  keepGeneration,
}: {
  readonly gcRootsPath: string
  readonly keepGeneration: string
}): Promise<ReadonlyArray<string>> => {
  assertGeneration({ generation: keepGeneration, path: gcRootsPath })
  let entries: ReadonlyArray<string>
  try {
    entries = await readdir(gcRootsPath)
  } catch {
    return []
  }
  const stale = entries.filter((entry) => entry !== keepGeneration)
  try {
    await Promise.all(
      stale.map((entry) =>
        rm(NodePath.join(gcRootsPath, entry), { recursive: true, force: true, maxRetries: 3 }),
      ),
    )
  } catch (cause) {
    throw failure({
      reason: 'ReconcileFailed',
      path: gcRootsPath,
      message: 'Stale capability GC roots could not be removed',
      cause,
    })
  }
  return stale.toSorted()
}

/** Drop the roots of one specific generation, used to undo a candidate that never published. */
export const removeCapabilityGcRootGeneration = async ({
  gcRootsPath,
  generation,
}: {
  readonly gcRootsPath: string
  readonly generation: string
}): Promise<void> => {
  assertGeneration({ generation, path: gcRootsPath })
  await rm(NodePath.join(gcRootsPath, generation), {
    recursive: true,
    force: true,
    maxRetries: 3,
  })
}
