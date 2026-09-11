/* eslint-disable no-await-in-loop -- composition publication order is the protocol. */

import { spawn } from 'node:child_process'
import { lstat, readFile, readdir } from 'node:fs/promises'
import * as NodePath from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { Effect, Schema } from 'effect'
import type * as FileSystem from 'effect/FileSystem'

import {
  BUCK_MEMBER_MANIFEST_FILENAME,
  buckMemberCapabilityByToolId,
  decodeBuckMemberManifestJson,
  encodeBuckMemberManifestJson,
  type BuckMemberManifest,
} from '@overeng/megarepo/buck2-manifest'

import { EffectPath } from '../../core/config.ts'
import type { CompositionCapabilitySystem } from '../capabilities/composition-capability-resolver-schema.ts'
import {
  resolveCompositionCapabilities,
  type CompositionCapabilityResolutionHandle,
  type CompositionCapabilityRuntime,
  type ResolveCompositionCapabilitiesInput,
  type ResolveCompositionCapabilitiesResult,
} from '../capabilities/composition-capability-resolver.ts'
import {
  cpAMemberMountTransactionPath,
  type CpAMemberMountRecoveryRequest,
  type CpAMemberMountRequest,
  type CpAMemberMountResult,
} from '../mounts/member-mount-cp-a-schema.ts'
import {
  materializeCpAMemberMount,
  recoverCpAMemberMount,
  teardownCpAMemberMount,
  type CpAMemberMountRecoveryRuntime,
  type CpAMemberMountRuntime,
} from '../mounts/member-mount-cp-a.ts'
import {
  assertOwnedCpAMountIdentity,
  readOwnedCpAMountMetadata,
  type OwnedCpAMountIdentity,
  type OwnedCpAMountMetadata,
} from '../mounts/member-mount-r6.ts'
import {
  distOverlayTransactionPath,
  type DistOverlayPublishRequest,
  type DistOverlayRecoveryRequest,
  type DistOverlayResult,
} from '../overlays/dist-overlay-lifecycle-schema.ts'
import {
  publishDistOverlay,
  recoverDistOverlay,
  type DistOverlayRuntime,
} from '../overlays/dist-overlay-lifecycle.ts'
import {
  planCompositionRootPublication,
  publishCompositionRoot,
  type CompositionPublisherLockOptions,
  type CompositionRootPublicationPlan,
  type CompositionRootPublicationResult,
  type CompositionRootPublicationRuntime,
  type PlanCompositionRootPublicationOptions,
  type PublishCompositionRootOptions,
} from '../root/composition-root-publisher.ts'
import {
  DEFAULT_BUCK_ISOLATION_DIR,
  resolveCompositionToolchainRequirements,
} from '../root/composition-root.ts'
import {
  CompositionApplyError,
  CompositionApplyRequestSchema,
  type CompositionApplyMemberResult,
  type CompositionMemberMountPlan,
  type CompositionOwnedCapabilityProjectionPlan,
  type CompositionOwnedCapabilityProjectionResult,
  type CompositionApplyOutput,
  type CompositionApplyPlanStep,
  type CompositionApplyRequest,
  type CompositionApplyRecoveryResult,
  type CompositionOverlayBuildPlan,
  type CompositionOverlayPublicationPlan,
} from './composition-apply-schema.ts'
import {
  acquireWorkspaceUpdateLock,
  releaseWorkspaceUpdateLock,
  type HeldWorkspaceUpdateLock,
  type WorkspaceUpdateLockRuntime,
} from './workspace-update-lock.ts'

const strictParseOptions = { errors: 'all', onExcessProperty: 'error' } as const

type RuntimePlatform = 'linux' | 'darwin'

/** Resolver-owned absent Buck output and its exact cleanup capability. */
export interface CompositionOverlayScratch {
  /** The absent output path passed verbatim to Buck `--out`. */
  readonly outputPath: string
  /** Removes only this scratch allocation. It must never remove `buck-out`. */
  readonly cleanup: () => Promise<void>
}

/** Planning and same-filesystem allocation boundary for overlay build outputs. */
export interface CompositionOverlayScratchRuntime {
  /** Stable mutation-free output identity shown by dry-run. */
  readonly planOutputPath: (input: {
    readonly workspaceRoot: string
    readonly memberKey: string
    readonly target: string
    readonly destination: string
  }) => string
  /** Same-filesystem scratch capability for one real overlay publication. */
  readonly create: (input: {
    readonly workspaceRoot: string
    readonly memberKey: string
    readonly target: string
    readonly destination: string
  }) => Promise<CompositionOverlayScratch>
}

/** Fresh no-follow identity and metadata for one source-valid cp-a mount. */
export interface CompositionMountedMemberInspection {
  readonly identity: OwnedCpAMountIdentity
  readonly metadata: OwnedCpAMountMetadata
}

/** Injectable primitive surface. Defaults integrate the decision-0020/0021 lifecycle modules. */
export interface CompositionApplyPrimitives {
  readonly readManifest: (memberRoot: string) => Promise<BuckMemberManifest>
  readonly pathExists: (path: string) => Promise<boolean>
  readonly acquireUpdateLock: (input: {
    readonly workspaceRoot: string
    readonly runtime: WorkspaceUpdateLockRuntime
  }) => Promise<HeldWorkspaceUpdateLock>
  readonly releaseUpdateLock: (input: {
    readonly held: HeldWorkspaceUpdateLock
    readonly runtime: WorkspaceUpdateLockRuntime
  }) => Promise<void>
  readonly resolveCapabilities: (
    input: ResolveCompositionCapabilitiesInput,
  ) => Promise<ResolveCompositionCapabilitiesResult>
  readonly assertLockedSourceClean: (input: {
    readonly sourcePath: string
    readonly lockedCommit: string
  }) => Promise<void>
  readonly recoverMount: (input: {
    readonly request: CpAMemberMountRecoveryRequest
    readonly runtime: CpAMemberMountRecoveryRuntime
  }) => Promise<CpAMemberMountResult>
  readonly planMount: (input: {
    readonly workspaceRoot: string
    readonly memberKey: string
    readonly sourcePath: string
    readonly capabilitiesPath: string
    readonly lockedCommit: string
    readonly distOverlays: BuckMemberManifest['distOverlays']
    readonly allowVerifiedDarwinAdvance: boolean
  }) => Promise<CompositionMemberMountPlan>
  readonly materializeMount: (input: {
    readonly request: CpAMemberMountRequest
    readonly runtime: CpAMemberMountRuntime
  }) => Promise<CpAMemberMountResult>
  readonly inspectMountedMember: (input: {
    readonly workspaceRoot: string
    readonly memberKey: string
  }) => Promise<CompositionMountedMemberInspection>
  readonly listPublishedMemberKeys: (workspaceRoot: string) => Promise<ReadonlyArray<string>>
  readonly teardownMount: (input: {
    readonly workspaceRoot: string
    readonly memberKey: string
  }) => Promise<CpAMemberMountResult>
  readonly recoverOverlay: (input: {
    readonly request: DistOverlayRecoveryRequest
    readonly runtime: DistOverlayRuntime
  }) => Promise<DistOverlayResult>
  readonly publishOverlay: (input: {
    readonly request: DistOverlayPublishRequest
    readonly runtime: DistOverlayRuntime
  }) => Promise<DistOverlayResult>
  readonly planOverlay: (input: {
    readonly memberKey: string
    readonly declaration: BuckMemberManifest['distOverlays'][number]
  }) => Promise<CompositionOverlayPublicationPlan>
  readonly planRoot: (
    input: PlanCompositionRootPublicationOptions,
  ) => Promise<CompositionRootPublicationPlan>
  readonly publishRoot: (
    input: PublishCompositionRootOptions,
  ) => Promise<CompositionRootPublicationResult>
}

/** All process and lifecycle capabilities are explicit. PATH is never a fallback. */
export interface CompositionApplyRuntime {
  /** Atomic owned-worktree projection port; the resolver itself remains scratch-only. */
  readonly ownedCapabilityProjection: {
    readonly plan: (input: {
      readonly memberKey: string
      readonly ownedMemberPath: string
      readonly projectionPath: string
    }) => Promise<CompositionOwnedCapabilityProjectionPlan>
    readonly install: (input: {
      readonly memberKey: string
      readonly ownedMemberPath: string
      readonly projectionPath: string
      readonly projectionDigest: string
    }) => Promise<CompositionOwnedCapabilityProjectionResult>
  }
  readonly system: CompositionCapabilitySystem
  readonly platform: RuntimePlatform
  readonly buck2Path: string
  readonly buck2Protocol: string
  readonly capabilityRuntime: CompositionCapabilityRuntime
  readonly mountRuntime: CpAMemberMountRuntime
  readonly mountRecoveryRuntime: CpAMemberMountRecoveryRuntime
  readonly publisherRuntime: CompositionRootPublicationRuntime
  readonly publisherLock: CompositionPublisherLockOptions
  readonly overlayRuntime: DistOverlayRuntime
  readonly overlayScratch: CompositionOverlayScratchRuntime
  readonly updateLockRuntime: WorkspaceUpdateLockRuntime
  /** Executes exactly the supplied argv. Implementations may add environment, never arguments. */
  readonly runBuck: (argv: readonly [string, ...ReadonlyArray<string>]) => Promise<void>
  readonly primitives?: Partial<CompositionApplyPrimitives>
}

const runNode = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)))

const exists = (path: string): Promise<boolean> =>
  lstat(path).then(
    () => true,
    (cause: NodeJS.ErrnoException) => {
      if (cause.code === 'ENOENT') return false
      throw cause
    },
  )

const defaultPrimitives: CompositionApplyPrimitives = {
  readManifest: async (memberRoot) =>
    decodeBuckMemberManifestJson(
      await readFile(NodePath.join(memberRoot, BUCK_MEMBER_MANIFEST_FILENAME), 'utf8'),
    ),
  pathExists: exists,
  acquireUpdateLock: ({ workspaceRoot, runtime }) =>
    Effect.runPromise(acquireWorkspaceUpdateLock({ workspaceRoot, runtime })),
  releaseUpdateLock: ({ held, runtime }) =>
    Effect.runPromise(releaseWorkspaceUpdateLock({ held, runtime })),
  resolveCapabilities: resolveCompositionCapabilities,
  assertLockedSourceClean: async () => {},
  recoverMount: ({ request, runtime }) => runNode(recoverCpAMemberMount({ request, runtime })),
  planMount: async (input) => ({
    memberKey: input.memberKey,
    sourcePath: input.sourcePath,
    capabilitiesPath: input.capabilitiesPath,
    destinationPath: NodePath.join(input.workspaceRoot, 'repos', input.memberKey),
    lockedCommit: input.lockedCommit,
    distOverlays: input.distOverlays,
    allowVerifiedDarwinAdvance: input.allowVerifiedDarwinAdvance,
    operation: 'MaterializeOrAdvance',
    steps: [
      'ValidateImmutableSource',
      'UseResolvedCapabilityProjection',
      'MaterializeCpAMemberMount',
    ],
  }),
  materializeMount: ({ request, runtime }) =>
    runNode(materializeCpAMemberMount({ request, runtime })),
  listPublishedMemberKeys: async (workspaceRoot) =>
    readdir(NodePath.join(workspaceRoot, 'repos')).then((entries) =>
      entries.filter((entry) => entry !== '.mr' && entry.startsWith('.') === false),
    ),
  teardownMount: ({ workspaceRoot, memberKey }) =>
    runNode(
      teardownCpAMemberMount({
        request: { workspaceRoot, member: memberKey, dryRun: false },
      }),
    ),
  inspectMountedMember: async ({ workspaceRoot, memberKey }) => {
    const publishedPath = NodePath.join(workspaceRoot, 'repos', memberKey)
    const metadata = await runNode(
      readOwnedCpAMountMetadata({ workspaceRoot, member: memberKey, publishedPath }),
    )
    const info = await lstat(publishedPath)
    const identity = { dev: info.dev, ino: info.ino }
    await runNode(assertOwnedCpAMountIdentity({ path: publishedPath, expected: identity }))
    return { identity, metadata }
  },
  recoverOverlay: ({ request, runtime }) => runNode(recoverDistOverlay({ request, runtime })),
  publishOverlay: ({ request, runtime }) => runNode(publishDistOverlay({ request, runtime })),
  planOverlay: async ({ memberKey, declaration }) => ({
    memberKey,
    target: declaration.target,
    destination: declaration.destination,
    operation: 'FirstPublish',
    steps: [
      'BuildDeclaredDirectory',
      'ValidateRealDirectory',
      'PublishDistOverlay',
      'CleanupScratch',
    ],
  }),
  planRoot: (input) => Effect.runPromise(planCompositionRootPublication(input)),
  publishRoot: (input) => Effect.runPromise(publishCompositionRoot(input)),
}

const failure = ({
  reason,
  phase,
  message,
  path,
  memberKey,
  recoveryPaths = [],
  primaryFailure,
  cleanupFailures,
  updateLockRecovery,
  cause,
}: Omit<ConstructorParameters<typeof CompositionApplyError>[0], '_tag'>): CompositionApplyError =>
  new CompositionApplyError({
    reason,
    phase,
    message,
    recoveryPaths,
    ...(path === undefined ? {} : { path }),
    ...(memberKey === undefined ? {} : { memberKey }),
    ...(primaryFailure === undefined ? {} : { primaryFailure }),
    ...(cleanupFailures === undefined ? {} : { cleanupFailures }),
    ...(updateLockRecovery === undefined ? {} : { updateLockRecovery }),
    ...(cause === undefined ? {} : { cause }),
  })

const normalizeFailure = ({
  cause,
  ...context
}: Omit<ConstructorParameters<typeof CompositionApplyError>[0], '_tag' | 'cause'> & {
  readonly cause: unknown
}): CompositionApplyError =>
  cause instanceof CompositionApplyError ? cause : failure({ ...context, cause })

const compareCodeUnits = ({
  left,
  right,
}: {
  readonly left: string
  readonly right: string
}): number => (left < right ? -1 : left > right ? 1 : 0)

interface LoadedMember {
  readonly key: string
  readonly root: string
  readonly owned: boolean
  readonly lockedCommit?: string
  readonly manifest: BuckMemberManifest
}

const validateRuntime = (runtime: CompositionApplyRuntime): void => {
  for (const [name, value] of [
    ['buck2Path', runtime.buck2Path],
    ['mountRuntime.cpPath', runtime.mountRuntime.cpPath],
    ['mountRuntime.mvPath', runtime.mountRuntime.mvPath],
    ['mountRecoveryRuntime.mvPath', runtime.mountRecoveryRuntime.mvPath],
  ] as const) {
    if (NodePath.isAbsolute(value) === false || NodePath.normalize(value) !== value) {
      throw failure({
        reason: 'InvalidRequest',
        phase: 'Input',
        message: `${name} must be an exact normalized absolute path`,
        path: value,
        recoveryPaths: [],
      })
    }
  }
  if (
    (runtime.platform !== 'linux' && runtime.platform !== 'darwin') ||
    (runtime.platform === 'darwin' && runtime.system !== 'aarch64-darwin') ||
    (runtime.platform === 'linux' && runtime.system === 'aarch64-darwin')
  ) {
    throw failure({
      reason: 'PlatformUnsupported',
      phase: 'Input',
      message: `Runtime platform '${runtime.platform}' does not support system '${runtime.system}'`,
      recoveryPaths: [],
    })
  }
}

const loadMembers = async ({
  request,
  primitives,
}: {
  readonly request: CompositionApplyRequest
  readonly primitives: CompositionApplyPrimitives
}): Promise<ReadonlyArray<LoadedMember>> => {
  const expectedOwnedPath = NodePath.join(request.workspaceRoot, 'repos', request.ownedMemberKey)
  if (request.ownedMemberPath !== expectedOwnedPath) {
    throw failure({
      reason: 'ManifestMountMismatch',
      phase: 'Manifest',
      memberKey: request.ownedMemberKey,
      path: request.ownedMemberPath,
      message: `Owned member path '${request.ownedMemberPath}' must be '${expectedOwnedPath}'`,
      recoveryPaths: [],
    })
  }
  const sourcePaths = new Set<string>()
  const loaded: Array<LoadedMember> = []
  const inputs = [
    { key: request.ownedMemberKey, root: request.ownedMemberPath, owned: true as const },
    ...request.lockedMembers.map((member) => ({
      key: member.key,
      root: member.sourcePath,
      owned: false as const,
      lockedCommit: member.lockedCommit,
    })),
  ]
  for (const input of inputs) {
    if (
      input.owned === false &&
      (input.root === NodePath.join(request.workspaceRoot, 'repos') ||
        input.root.startsWith(`${NodePath.join(request.workspaceRoot, 'repos')}${NodePath.sep}`) ===
          true)
    ) {
      throw failure({
        reason: 'InvalidRequest',
        phase: 'Manifest',
        memberKey: input.key,
        path: input.root,
        message: `Locked source '${input.root}' must remain outside the mutable workspace repos tree`,
        recoveryPaths: [],
      })
    }
    if (sourcePaths.has(input.root) === true) {
      throw failure({
        reason: 'InvalidRequest',
        phase: 'Manifest',
        memberKey: input.key,
        path: input.root,
        message: `Member source path '${input.root}' is not unique`,
        recoveryPaths: [],
      })
    }
    sourcePaths.add(input.root)
    let manifest: BuckMemberManifest
    try {
      manifest = await primitives.readManifest(input.root)
    } catch (cause) {
      throw normalizeFailure({
        cause,
        reason: 'ManifestInvalid',
        phase: 'Manifest',
        memberKey: input.key,
        path: NodePath.join(input.root, BUCK_MEMBER_MANIFEST_FILENAME),
        message: `Could not strictly read member manifest for '${input.key}'`,
        recoveryPaths: [],
      })
    }
    const expectedMount = `repos/${input.key}`
    if (manifest.mount !== expectedMount) {
      throw failure({
        reason: 'ManifestMountMismatch',
        phase: 'Manifest',
        memberKey: input.key,
        path: input.root,
        message: `Member '${input.key}' declares mount '${manifest.mount}', expected '${expectedMount}'`,
        recoveryPaths: [],
      })
    }
    loaded.push({ ...input, manifest })
  }
  return loaded.toSorted(
    (left, right) =>
      compareCodeUnits({ left: left.manifest.cell, right: right.manifest.cell }) ||
      compareCodeUnits({ left: left.key, right: right.key }),
  )
}

const validateMembers = ({
  request,
  runtime,
  members,
}: {
  readonly request: CompositionApplyRequest
  readonly runtime: CompositionApplyRuntime
  readonly members: ReadonlyArray<LoadedMember>
}): void => {
  const hub = members.find((member) => member.key === request.compositionConfig.platformHub)
  if (hub === undefined) {
    throw failure({
      reason: 'PlatformHubMissing',
      phase: 'Manifest',
      message: `Platform hub '${request.compositionConfig.platformHub}' is not a configured member`,
      recoveryPaths: [],
    })
  }
  const buckCapability = buckMemberCapabilityByToolId({ manifest: hub.manifest, toolId: 'buck2' })
  if (buckCapability === undefined) {
    throw failure({
      reason: 'BuckCapabilityMissing',
      phase: 'Manifest',
      memberKey: hub.key,
      message: `Platform hub '${hub.key}' does not declare the buck2 capability`,
      recoveryPaths: [],
    })
  }
  if (buckCapability.protocol !== runtime.buck2Protocol) {
    throw failure({
      reason: 'BuckCapabilityMismatch',
      phase: 'Manifest',
      memberKey: hub.key,
      message: `Platform hub buck2 protocol '${buckCapability.protocol}' does not match required '${runtime.buck2Protocol}'`,
      recoveryPaths: [],
    })
  }
  const destinations = new Set<string>()
  for (const member of members.filter((candidate) => candidate.owned === false)) {
    for (const overlay of member.manifest.distOverlays) {
      const identity = `${member.key}/${runtime.platform === 'darwin' ? overlay.destination.toLowerCase() : overlay.destination}`
      if (destinations.has(identity) === true) {
        throw failure({
          reason: 'OverlayDestinationConflict',
          phase: 'Manifest',
          memberKey: member.key,
          path: overlay.destination,
          message: `Overlay destination '${overlay.destination}' conflicts for member '${member.key}'`,
          recoveryPaths: [],
        })
      }
      destinations.add(identity)
    }
  }
}

const publicResolution = (
  handle: CompositionCapabilityResolutionHandle,
): CompositionApplyMemberResult['capability'] => ({
  _tag: 'Resolved',
  system: handle.system,
  projectorPlatform: handle.projectorPlatform,
  candidateRoot: handle.candidateRoot,
  projectionPath: handle.projectionPath,
  projectionDigest: handle.projectionDigest,
  capabilities: handle.capabilities,
  capabilitiesByToolId: handle.capabilitiesByToolId,
  nixCommands: handle.nixCommands,
})

/** Derive the only permitted Buck overlay build command. */
export const makeCompositionOverlayBuildPlan = ({
  runtime,
  member,
  target,
  destination,
  outputPath,
  isolationDir,
}: {
  readonly runtime: Pick<CompositionApplyRuntime, 'buck2Path'>
  readonly member: Pick<LoadedMember, 'key' | 'manifest'>
  readonly target: string
  readonly destination: string
  readonly outputPath: string
  readonly isolationDir: string
}): CompositionOverlayBuildPlan => {
  const canonicalLabel = `${member.manifest.cell}${target}`
  return {
    memberKey: member.key,
    target,
    destination,
    canonicalLabel,
    executable: runtime.buck2Path,
    args: ['--isolation-dir', isolationDir, 'build', canonicalLabel, '--out', outputPath],
    outputPath,
    isolationDir,
    daemonPolicy: 'SharedDaemonUnchanged',
    cleanup: 'RemoveScratchOnly',
  }
}

/** Build one declared generic directory using the exact fixed Buck argv and validate no-follow output. */
export const buildCompositionDistOverlay = async ({
  plan,
  runBuck,
}: {
  readonly plan: CompositionOverlayBuildPlan
  readonly runBuck: CompositionApplyRuntime['runBuck']
}): Promise<void> => {
  const argv = [plan.executable, ...plan.args] as readonly [string, ...Array<string>]
  try {
    await runBuck(argv)
  } catch (cause) {
    throw failure({
      reason: 'OverlayBuildFailure',
      phase: 'OverlayBuild',
      memberKey: plan.memberKey,
      path: plan.outputPath,
      message: `Buck failed to build '${plan.canonicalLabel}'`,
      recoveryPaths: [plan.outputPath],
      cause,
    })
  }
  let info
  try {
    info = await lstat(plan.outputPath)
  } catch (cause) {
    throw failure({
      reason: 'OverlayBuildFailure',
      phase: 'OverlayBuild',
      memberKey: plan.memberKey,
      path: plan.outputPath,
      message: `Buck did not produce declared directory output for '${plan.canonicalLabel}'`,
      recoveryPaths: [plan.outputPath],
      cause,
    })
  }
  if (info.isSymbolicLink() === true || info.isDirectory() === false) {
    throw failure({
      reason: 'OverlayBuildFailure',
      phase: 'OverlayBuild',
      memberKey: plan.memberKey,
      path: plan.outputPath,
      message: `Buck output for '${plan.canonicalLabel}' must be a real directory, never a symlink`,
      recoveryPaths: [plan.outputPath],
    })
  }
}

/** Default exact command executor. It never invokes a shell or changes daemon state. */
export const runCompositionBuckCommand = (
  argv: readonly [string, ...ReadonlyArray<string>],
): Promise<void> =>
  new Promise((resolve, reject) => {
    const [executable, ...args] = argv
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const stderr: Array<Buffer> = []
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else
        reject(
          new Error(
            `Buck exited with ${code ?? signal}: ${Buffer.concat(stderr).toString('utf8')}`,
          ),
        )
    })
  })

const applyComposition = async ({
  untrustedRequest,
  runtime,
}: {
  readonly untrustedRequest: CompositionApplyRequest
  readonly runtime: CompositionApplyRuntime
}): Promise<CompositionApplyOutput> => {
  let request: CompositionApplyRequest
  try {
    request = Schema.decodeUnknownSync(
      CompositionApplyRequestSchema,
      strictParseOptions,
    )(untrustedRequest)
    validateRuntime(runtime)
  } catch (cause) {
    throw normalizeFailure({
      cause,
      reason: 'InvalidRequest',
      phase: 'Input',
      message: 'Invalid composition apply request or runtime',
      recoveryPaths: [],
    })
  }
  if (request.lockedMembers.some((member) => member.key === request.ownedMemberKey) === true) {
    throw failure({
      reason: 'OwnedMemberCollision',
      phase: 'Input',
      memberKey: request.ownedMemberKey,
      message: `Owned member '${request.ownedMemberKey}' must not appear in locked members`,
      recoveryPaths: [],
    })
  }
  if (runtime.platform === 'darwin') {
    const foldedKeys = new Map<string, string>([
      [request.ownedMemberKey.toLowerCase(), request.ownedMemberKey],
    ])
    for (const member of request.lockedMembers) {
      const folded = member.key.toLowerCase()
      const existing = foldedKeys.get(folded)
      if (existing !== undefined) {
        throw failure({
          reason: 'MemberKeyCollision',
          phase: 'Input',
          memberKey: member.key,
          message: `Member keys '${existing}' and '${member.key}' collide on Darwin`,
          recoveryPaths: [],
        })
      }
      foldedKeys.set(folded, member.key)
    }
    for (const member of request.compositionConfig.ignoredMembers ?? []) {
      const folded = member.toLowerCase()
      const existing = foldedKeys.get(folded)
      if (existing !== undefined) {
        throw failure({
          reason: 'MemberKeyCollision',
          phase: 'Input',
          memberKey: member,
          message: `Member keys '${existing}' and '${member}' collide on Darwin`,
          recoveryPaths: [],
        })
      }
      foldedKeys.set(folded, member)
    }
  }
  const keys = new Set<string>()
  for (const member of request.lockedMembers) {
    if (keys.has(member.key) === true) {
      throw failure({
        reason: 'InvalidRequest',
        phase: 'Input',
        memberKey: member.key,
        message: `Locked member '${member.key}' is duplicated`,
        recoveryPaths: [],
      })
    }
    keys.add(member.key)
  }

  const primitives: CompositionApplyPrimitives = { ...defaultPrimitives, ...runtime.primitives }
  let held: HeldWorkspaceUpdateLock | undefined
  let primaryFailure: unknown
  const handles: Array<{
    readonly member: LoadedMember
    readonly handle: CompositionCapabilityResolutionHandle
  }> = []
  let handlesReleased = false

  interface CleanupIssue {
    readonly resource: 'CapabilityScratch' | 'OverlayScratch' | 'WorkspaceUpdateLock'
    readonly path: string
    readonly message: string
    readonly cause: unknown
    readonly updateLockToken?: string
  }

  const makeCleanupFailure = ({
    primary,
    issues,
  }: {
    readonly primary?: unknown
    readonly issues: ReadonlyArray<CleanupIssue>
  }): CompositionApplyError => {
    const inherited =
      primary instanceof CompositionApplyError && primary.reason === 'CleanupFailure'
        ? primary
        : undefined
    const primaryDetail =
      inherited?.primaryFailure ??
      (primary instanceof CompositionApplyError
        ? { reason: primary.reason, phase: primary.phase, message: primary.message }
        : primary === undefined
          ? undefined
          : { reason: 'Unknown', phase: 'Input', message: String(primary) })
    const cleanupFailures = [
      ...(inherited?.cleanupFailures ?? []),
      ...issues.map(({ resource, path, message }) => ({ resource, path, message })),
    ]
    const updateLockIssue = issues.find((issue) => issue.resource === 'WorkspaceUpdateLock')
    const causes = [
      ...(primary === undefined ? [] : [primary]),
      ...issues.map((issue) => issue.cause),
    ]
    return failure({
      reason: 'CleanupFailure',
      phase: 'Cleanup',
      message: `Could not release ${cleanupFailures.length} composition resource${cleanupFailures.length === 1 ? '' : 's'}${primary === undefined ? '' : ' after a primary phase failure'}`,
      recoveryPaths: [
        ...new Set([
          ...(inherited?.recoveryPaths ?? []),
          ...cleanupFailures.map(({ path }) => path),
        ]),
      ],
      ...(primaryDetail === undefined ? {} : { primaryFailure: primaryDetail }),
      cleanupFailures,
      ...(updateLockIssue?.updateLockToken === undefined
        ? inherited?.updateLockRecovery === undefined
          ? {}
          : { updateLockRecovery: inherited.updateLockRecovery }
        : {
            updateLockRecovery: {
              path: updateLockIssue.path,
              token: updateLockIssue.updateLockToken,
            },
          }),
      cause: causes.length === 1 ? causes[0] : new AggregateError(causes),
    })
  }

  const releaseHandles = async (): Promise<ReadonlyArray<CleanupIssue>> => {
    if (handlesReleased === true) return []
    handlesReleased = true
    const issues: Array<CleanupIssue> = []
    for (const entry of handles.toReversed()) {
      try {
        await entry.handle.release()
      } catch (cause) {
        issues.push({
          resource: 'CapabilityScratch',
          path: entry.handle.candidateRoot,
          message: `Could not release capability scratch for '${entry.member.key}'`,
          cause,
        })
      }
    }
    return issues
  }

  const execute = async (): Promise<CompositionApplyOutput> => {
    if (request.dryRun === false) {
      try {
        held = await primitives.acquireUpdateLock({
          workspaceRoot: request.workspaceRoot,
          runtime: runtime.updateLockRuntime,
        })
      } catch (cause) {
        throw normalizeFailure({
          cause,
          reason: 'UpdateLockFailure',
          phase: 'UpdateLock',
          path: request.workspaceRoot,
          message: 'Could not acquire the workspace update lock',
          recoveryPaths: [],
        })
      }
    }

    const members = await loadMembers({ request, primitives })
    validateMembers({ request, runtime, members })
    const platformHub = members.find(
      (member) => member.key === request.compositionConfig.platformHub,
    )
    if (platformHub === undefined) {
      throw failure({
        reason: 'InvalidRequest',
        phase: 'Manifest',
        memberKey: request.compositionConfig.platformHub,
        message: 'Platform hub is not a composition member',
        recoveryPaths: [],
      })
    }
    try {
      resolveCompositionToolchainRequirements({
        members: members.map((member) => ({
          memberKey: member.key,
          manifest: member.manifest,
        })),
        platformHubCell: platformHub.manifest.cell,
      })
    } catch (cause) {
      throw normalizeFailure({
        cause,
        reason: 'InvalidRequest',
        phase: 'Manifest',
        memberKey: request.compositionConfig.platformHub,
        message: 'Member toolchain requirements conflict with the platform hub authority',
        recoveryPaths: [],
      })
    }
    const lockedMembers = members.filter((member) => member.owned === false)
    const recoveryResults: Array<CompositionApplyRecoveryResult> = []

    if (request.dryRun === false) {
      for (const member of lockedMembers) {
        const mountTransaction = cpAMemberMountTransactionPath({
          workspaceRoot: request.workspaceRoot,
          member: member.key,
        })
        if ((await primitives.pathExists(mountTransaction)) === true) {
          try {
            const recovered = await primitives.recoverMount({
              request: {
                workspaceRoot: request.workspaceRoot,
                member: member.key,
                allowVerifiedDarwinAdvance: request.allowVerifiedDarwinAdvance,
              },
              runtime: runtime.mountRecoveryRuntime,
            })
            recoveryResults.push({
              _tag: 'MountRecovery',
              memberKey: member.key,
              transactionPath: mountTransaction,
              result: recovered,
            })
          } catch (cause) {
            throw normalizeFailure({
              cause,
              reason: 'RecoveryFailure',
              phase: 'Recovery',
              memberKey: member.key,
              path: mountTransaction,
              message: `Could not recover member mount '${member.key}'`,
              recoveryPaths: [mountTransaction],
            })
          }
        }
        for (const declaration of member.manifest.distOverlays) {
          const transactionPath = distOverlayTransactionPath({
            workspaceRoot: request.workspaceRoot,
            member: member.key,
            destination: declaration.destination,
          })
          if ((await primitives.pathExists(transactionPath)) === false) continue
          try {
            const inspection = await primitives.inspectMountedMember({
              workspaceRoot: request.workspaceRoot,
              memberKey: member.key,
            })
            const recovered = await primitives.recoverOverlay({
              request: {
                workspaceRoot: request.workspaceRoot,
                member: member.key,
                target: declaration.target,
                destination: declaration.destination,
                expectedMountIdentity: inspection.identity,
                mvPath: runtime.mountRecoveryRuntime.mvPath,
              },
              runtime: runtime.overlayRuntime,
            })
            recoveryResults.push({
              _tag: 'OverlayRecovery',
              memberKey: member.key,
              target: declaration.target,
              destination: declaration.destination,
              transactionPath,
              result: recovered,
            })
          } catch (cause) {
            throw normalizeFailure({
              cause,
              reason: 'RecoveryFailure',
              phase: 'Recovery',
              memberKey: member.key,
              path: transactionPath,
              message: `Could not recover overlay '${declaration.destination}'`,
              recoveryPaths: [transactionPath],
            })
          }
        }
      }
    }

    if (request.dryRun === false) {
      const expectedKeys = new Set([
        request.ownedMemberKey,
        ...lockedMembers.map((member) => member.key),
        ...(request.compositionConfig.ignoredMembers ?? []),
      ])
      const publishedKeys = await primitives.listPublishedMemberKeys(request.workspaceRoot)
      for (const memberKey of publishedKeys) {
        if (expectedKeys.has(memberKey) === true) continue
        try {
          await primitives.teardownMount({ workspaceRoot: request.workspaceRoot, memberKey })
        } catch (cause) {
          throw normalizeFailure({
            cause,
            reason: 'MountFailure',
            phase: 'Mount',
            memberKey,
            path: NodePath.join(request.workspaceRoot, 'repos', memberKey),
            message: `Refusing to remove unverified orphan member '${memberKey}'`,
            recoveryPaths: [NodePath.join(request.workspaceRoot, 'repos', memberKey)],
          })
        }
      }
    }

    const capabilityResults = new Map<string, ResolveCompositionCapabilitiesResult>()
    for (const member of members) {
      let capabilityResult: ResolveCompositionCapabilitiesResult
      try {
        capabilityResult = await primitives.resolveCapabilities({
          memberRoot: member.root,
          system: runtime.system,
          manifest: member.manifest,
          dryRun: request.dryRun,
          runtime: runtime.capabilityRuntime,
        })
      } catch (cause) {
        throw normalizeFailure({
          cause,
          reason: 'CapabilityFailure',
          phase: 'Capability',
          memberKey: member.key,
          path: member.root,
          message: `Could not resolve capabilities for '${member.key}'`,
          recoveryPaths: [],
        })
      }
      capabilityResults.set(member.key, capabilityResult)
      if (capabilityResult._tag === 'Resolved') handles.push({ member, handle: capabilityResult })
    }

    for (const member of lockedMembers) {
      await primitives.assertLockedSourceClean({
        sourcePath: member.root,
        lockedCommit: member.lockedCommit!,
      })
    }

    const hubResolution = capabilityResults.get(request.compositionConfig.platformHub)
    if (request.dryRun === false) {
      if (hubResolution?._tag !== 'Resolved') {
        throw failure({
          reason: 'BuckCapabilityMissing',
          phase: 'Capability',
          memberKey: request.compositionConfig.platformHub,
          message: 'Platform hub did not produce a resolved buck2 capability',
          recoveryPaths: [],
        })
      }
      const resolvedBuck = hubResolution.capabilitiesByToolId['buck2']
      if (
        resolvedBuck === undefined ||
        resolvedBuck.capability.protocol !== runtime.buck2Protocol ||
        resolvedBuck.executablePath !== runtime.buck2Path
      ) {
        throw failure({
          reason: 'BuckCapabilityMismatch',
          phase: 'Capability',
          memberKey: request.compositionConfig.platformHub,
          path: runtime.buck2Path,
          message:
            'Resolved platform-hub buck2 capability does not match the exact injected binary and protocol',
          recoveryPaths: [],
        })
      }
    }

    const rootInput = {
      workspaceRoot: EffectPath.unsafe.absoluteDir(`${request.workspaceRoot}/`),
      configMemberKeys: members.map((member) => member.key),
      ownedMemberKey: request.ownedMemberKey,
      compositionConfig: request.compositionConfig,
      resolvedBuckExecutable: runtime.buck2Path,
      ...(request.cacheSections === undefined ? {} : { cacheSections: request.cacheSections }),
      assertCapabilityProjection: async () => {},
    } satisfies PlanCompositionRootPublicationOptions

    if (request.dryRun === true) {
      const steps: Array<CompositionApplyPlanStep> = []
      for (const member of members) {
        const result = capabilityResults.get(member.key)
        if (result?._tag !== 'Planned') {
          throw failure({
            reason: 'CapabilityFailure',
            phase: 'Capability',
            memberKey: member.key,
            message: `Dry-run resolver mutated or returned a non-plan for '${member.key}'`,
            recoveryPaths: [],
          })
        }
        steps.push({ _tag: 'Capability', memberKey: member.key, owned: member.owned, plan: result })
      }
      const ownedCapability = capabilityResults.get(request.ownedMemberKey)!
      const ownedPlan = await runtime.ownedCapabilityProjection.plan({
        memberKey: request.ownedMemberKey,
        ownedMemberPath: request.ownedMemberPath,
        projectionPath: ownedCapability.candidateRoot,
      })
      steps.push({
        _tag: 'OwnedCapabilityProjection',
        memberKey: request.ownedMemberKey,
        plan: ownedPlan,
      })
      for (const member of lockedMembers) {
        const capability = capabilityResults.get(member.key)!
        let plan: CompositionMemberMountPlan
        try {
          plan = await primitives.planMount({
            workspaceRoot: request.workspaceRoot,
            memberKey: member.key,
            sourcePath: member.root,
            capabilitiesPath: capability.candidateRoot,
            lockedCommit: member.lockedCommit!,
            distOverlays: member.manifest.distOverlays,
            allowVerifiedDarwinAdvance: request.allowVerifiedDarwinAdvance,
          })
        } catch (cause) {
          throw normalizeFailure({
            cause,
            reason: 'MountFailure',
            phase: 'Mount',
            memberKey: member.key,
            path: member.root,
            message: `Could not plan member mount '${member.key}'`,
            recoveryPaths: [],
          })
        }
        steps.push({ _tag: 'Mount', memberKey: member.key, plan })
      }
      let rootPlan: CompositionRootPublicationPlan
      try {
        rootPlan = await primitives.planRoot(rootInput)
      } catch (cause) {
        throw normalizeFailure({
          cause,
          reason: 'RootPublicationFailure',
          phase: 'Root',
          path: request.workspaceRoot,
          message: 'Could not plan composition-root publication',
          recoveryPaths: [],
        })
      }
      steps.push({ _tag: 'Root', plan: rootPlan })
      const isolationDir = request.compositionConfig.isolationDir ?? DEFAULT_BUCK_ISOLATION_DIR
      for (const member of lockedMembers) {
        for (const declaration of member.manifest.distOverlays) {
          const outputPath = runtime.overlayScratch.planOutputPath({
            workspaceRoot: request.workspaceRoot,
            memberKey: member.key,
            target: declaration.target,
            destination: declaration.destination,
          })
          const build = makeCompositionOverlayBuildPlan({
            runtime,
            member,
            target: declaration.target,
            destination: declaration.destination,
            outputPath,
            isolationDir,
          })
          const publication = await primitives.planOverlay({ memberKey: member.key, declaration })
          steps.push({
            _tag: 'Overlay',
            memberKey: member.key,
            declaration,
            build,
            publication,
          })
        }
      }
      return { _tag: 'DryRun', steps, defaultCwd: request.ownedMemberPath }
    }

    const ownedHandle = handles.find(({ member }) => member.owned === true)?.handle
    if (ownedHandle === undefined) {
      throw failure({
        reason: 'CapabilityFailure',
        phase: 'Capability',
        memberKey: request.ownedMemberKey,
        message: `Owned member '${request.ownedMemberKey}' has no realized capability projection`,
        recoveryPaths: [],
      })
    }
    let ownedProjection: CompositionOwnedCapabilityProjectionResult
    try {
      ownedProjection = await runtime.ownedCapabilityProjection.install({
        memberKey: request.ownedMemberKey,
        ownedMemberPath: request.ownedMemberPath,
        projectionPath: ownedHandle.projectionPath,
        projectionDigest: ownedHandle.projectionDigest,
      })
    } catch (cause) {
      throw normalizeFailure({
        cause,
        reason: 'CapabilityFailure',
        phase: 'Capability',
        memberKey: request.ownedMemberKey,
        path: request.ownedMemberPath,
        message: `Could not install owned capability projection for '${request.ownedMemberKey}'`,
        recoveryPaths: [],
      })
    }

    const mountResults = new Map<string, CpAMemberMountResult>()
    const mountInspections = new Map<string, CompositionMountedMemberInspection>()
    for (const member of lockedMembers) {
      const capability = capabilityResults.get(member.key)
      if (capability?._tag !== 'Resolved') {
        throw failure({
          reason: 'CapabilityFailure',
          phase: 'Capability',
          memberKey: member.key,
          message: `Member '${member.key}' has no realized capability projection`,
          recoveryPaths: [],
        })
      }
      let mount: CpAMemberMountResult
      try {
        await primitives.assertLockedSourceClean({
          sourcePath: member.root,
          lockedCommit: member.lockedCommit!,
        })
        mount = await primitives.materializeMount({
          request: {
            workspaceRoot: request.workspaceRoot,
            member: member.key,
            sourcePath: member.root,
            capabilitiesPath: capability.projectionPath,
            distOverlays: member.manifest.distOverlays,
            lockedCommit: member.lockedCommit!,
            dryRun: false,
            allowVerifiedDarwinAdvance: request.allowVerifiedDarwinAdvance,
          },
          runtime: runtime.mountRuntime,
        })
        if (mount._tag !== 'Published' && mount._tag !== 'AlreadyCurrent') {
          throw new TypeError(`Unexpected mount result '${mount._tag}'`)
        }
        mountResults.set(member.key, mount)
        mountInspections.set(
          member.key,
          await primitives.inspectMountedMember({
            workspaceRoot: request.workspaceRoot,
            memberKey: member.key,
          }),
        )
      } catch (cause) {
        throw normalizeFailure({
          cause,
          reason: 'MountFailure',
          phase: 'Mount',
          memberKey: member.key,
          path: member.root,
          message: `Could not materialize member mount '${member.key}'`,
          recoveryPaths: [
            cpAMemberMountTransactionPath({
              workspaceRoot: request.workspaceRoot,
              member: member.key,
            }),
          ],
        })
      }
    }

    const overlayResults = new Map<
      string,
      Array<CompositionApplyMemberResult['overlays'][number]>
    >()
    let overlayFailure: CompositionApplyError | undefined
    const publishOverlays = async (): Promise<void> => {
      try {
        const isolationDir = request.compositionConfig.isolationDir ?? DEFAULT_BUCK_ISOLATION_DIR
        for (const member of lockedMembers) {
          let inspection = mountInspections.get(member.key)!
          const results: Array<CompositionApplyMemberResult['overlays'][number]> = []
          const declarations =
            mountResults.get(member.key)?._tag === 'AlreadyCurrent'
              ? member.manifest.distOverlays.filter(
                  (declaration) =>
                    inspection.metadata.overlays.some(
                      (overlay) =>
                        overlay.target === declaration.target &&
                        overlay.destination === declaration.destination,
                    ) === false,
                )
              : member.manifest.distOverlays
          for (const declaration of declarations) {
            const scratch = await runtime.overlayScratch.create({
              workspaceRoot: request.workspaceRoot,
              memberKey: member.key,
              target: declaration.target,
              destination: declaration.destination,
            })
            const build = makeCompositionOverlayBuildPlan({
              runtime,
              member,
              target: declaration.target,
              destination: declaration.destination,
              outputPath: scratch.outputPath,
              isolationDir,
            })
            let operationFailure: unknown
            try {
              await buildCompositionDistOverlay({ plan: build, runBuck: runtime.runBuck })
              const published = await primitives.publishOverlay({
                request: {
                  workspaceRoot: request.workspaceRoot,
                  member: member.key,
                  expectedMountIdentity: inspection.identity,
                  expectedMetadata: inspection.metadata,
                  target: declaration.target,
                  destination: declaration.destination,
                  artifactPath: scratch.outputPath,
                  cpPath: runtime.mountRuntime.cpPath,
                  mvPath: runtime.mountRuntime.mvPath,
                  dryRun: false,
                },
                runtime: runtime.overlayRuntime,
              })
              if (published._tag !== 'Published' || published.operation === 'Remove') {
                throw new TypeError(`Unexpected overlay result '${published._tag}'`)
              }
              inspection = { identity: inspection.identity, metadata: published.metadata }
              results.push({
                target: declaration.target,
                destination: declaration.destination,
                destinationPath: published.destinationPath,
                operation: published.operation,
              })
            } catch (cause) {
              operationFailure = cause
            }
            try {
              await scratch.cleanup()
            } catch (cause) {
              operationFailure = makeCleanupFailure({
                ...(operationFailure === undefined ? {} : { primary: operationFailure }),
                issues: [
                  {
                    resource: 'OverlayScratch',
                    path: scratch.outputPath,
                    message: `Could not clean overlay scratch for '${declaration.target}'`,
                    cause,
                  },
                ],
              })
            }
            if (operationFailure !== undefined) {
              throw normalizeFailure({
                cause: operationFailure,
                reason:
                  operationFailure instanceof CompositionApplyError &&
                  operationFailure.reason === 'OverlayBuildFailure'
                    ? 'OverlayBuildFailure'
                    : 'OverlayPublicationFailure',
                phase:
                  operationFailure instanceof CompositionApplyError &&
                  operationFailure.phase === 'OverlayBuild'
                    ? 'OverlayBuild'
                    : 'OverlayPublication',
                memberKey: member.key,
                path: declaration.destination,
                message: `Could not publish overlay '${declaration.target}' for '${member.key}'`,
                recoveryPaths: [
                  distOverlayTransactionPath({
                    workspaceRoot: request.workspaceRoot,
                    member: member.key,
                    destination: declaration.destination,
                  }),
                ],
              })
            }
          }
          overlayResults.set(member.key, results)
        }
      } catch (cause) {
        overlayFailure = normalizeFailure({
          cause,
          reason: 'OverlayPublicationFailure',
          phase: 'OverlayPublication',
          message: 'Could not complete composition overlays',
          recoveryPaths: [],
        })
      }
      const cleanupIssues = await releaseHandles()
      if (cleanupIssues.length > 0) {
        throw makeCleanupFailure({
          ...(overlayFailure === undefined ? {} : { primary: overlayFailure }),
          issues: cleanupIssues,
        })
      }
      if (overlayFailure !== undefined) throw overlayFailure
    }

    const resolutions = new Map(handles.map(({ member, handle }) => [member.key, handle]))
    const rootPublicationOptions = {
      workspaceRoot: EffectPath.unsafe.absoluteDir(`${request.workspaceRoot}/`),
      configMemberKeys: members.map((member) => member.key),
      ownedMemberKey: request.ownedMemberKey,
      compositionConfig: request.compositionConfig,
      resolvedBuckExecutable: runtime.buck2Path,
      ...(request.cacheSections === undefined ? {} : { cacheSections: request.cacheSections }),
      lock: runtime.publisherLock,
      runtime: {
        ...runtime.publisherRuntime,
        assertCapabilityProjection: async (input) => {
          const resolution = resolutions.get(input.memberKey)
          const loaded = members.find((member) => member.key === input.memberKey)
          const expectedRoot = NodePath.join(request.workspaceRoot, 'repos', input.memberKey)
          if (
            resolution === undefined ||
            loaded === undefined ||
            input.memberRoot !== expectedRoot ||
            input.owned !== loaded.owned ||
            encodeBuckMemberManifestJson(input.manifest) !==
              encodeBuckMemberManifestJson(loaded.manifest)
          ) {
            throw failure({
              reason: 'CapabilityFailure',
              phase: 'Capability',
              memberKey: input.memberKey,
              path: input.memberRoot,
              message: `Publisher requested a mismatched capability projection for '${input.memberKey}'`,
              recoveryPaths: [],
            })
          }
          await runtime.publisherRuntime.assertCapabilityProjection(input)
        },
      },
    } satisfies PublishCompositionRootOptions

    let root: CompositionRootPublicationResult
    try {
      const rootPlan = await primitives.planRoot(rootInput)
      if (rootPlan._tag === 'Create') {
        root = await primitives.publishRoot(rootPublicationOptions)
        await publishOverlays()
      } else {
        await publishOverlays()
        root = await primitives.publishRoot(rootPublicationOptions)
      }
    } catch (cause) {
      if (cause instanceof CompositionApplyError && cause.reason === 'CleanupFailure') throw cause
      if (overlayFailure !== undefined) throw overlayFailure
      throw normalizeFailure({
        cause,
        reason: 'RootPublicationFailure',
        phase: 'Root',
        path: request.workspaceRoot,
        message: 'Could not publish composition root',
        recoveryPaths: [],
      })
    }

    return {
      _tag: 'Applied',
      recoveries: recoveryResults,
      members: members.map((member): CompositionApplyMemberResult => {
        const handle = resolutions.get(member.key)!
        if (member.owned === true) {
          return {
            memberKey: member.key,
            owned: true,
            capability: publicResolution(handle),
            ownedProjection,
            overlays: overlayResults.get(member.key) ?? [],
          }
        }
        return {
          memberKey: member.key,
          owned: false,
          capability: publicResolution(handle),
          mount: mountResults.get(member.key)!,
          overlays: overlayResults.get(member.key) ?? [],
        }
      }),
      root: { changedPaths: root.changedPaths },
      defaultCwd: request.ownedMemberPath,
    }
  }

  let output: CompositionApplyOutput | undefined
  try {
    output = await execute()
  } catch (cause) {
    primaryFailure = cause
  }
  const cleanupIssues: Array<CleanupIssue> = [...(await releaseHandles())]
  if (held !== undefined) {
    try {
      await primitives.releaseUpdateLock({ held, runtime: runtime.updateLockRuntime })
    } catch (cause) {
      cleanupIssues.push({
        resource: 'WorkspaceUpdateLock',
        path: held.lockPath,
        message: 'Could not release the workspace update lock',
        cause,
        updateLockToken: held.owner.token,
      })
    }
  }
  if (cleanupIssues.length > 0) {
    throw makeCleanupFailure({
      ...(primaryFailure === undefined ? {} : { primary: primaryFailure }),
      issues: cleanupIssues,
    })
  }
  if (primaryFailure !== undefined) throw primaryFailure
  if (output === undefined) {
    throw failure({
      reason: 'InvalidRequest',
      phase: 'Input',
      message: 'Composition apply completed without an output',
      recoveryPaths: [],
    })
  }
  return output
}

/** Strict request and explicit runtime capabilities for one composition application. */
export interface CompositionApplyOptions {
  readonly request: CompositionApplyRequest
  readonly runtime: CompositionApplyRuntime
}

/** Apply or plan a complete typed composition against already-resolved locked sources. */
export const compositionApply = Effect.fn('megarepo/composition/apply')(
  ({ request, runtime }: CompositionApplyOptions) =>
    Effect.tryPromise({
      try: () => applyComposition({ untrustedRequest: request, runtime }),
      catch: (cause) =>
        normalizeFailure({
          cause,
          reason: 'InvalidRequest',
          phase: 'Input',
          message: 'Composition apply failed',
          recoveryPaths: [],
        }),
    }),
)
