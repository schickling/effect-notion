import * as NodePath from 'node:path'

import { Schema } from 'effect'

import { CompositionGeneratorConfig } from '../../core/config.ts'
import {
  CompositionCapabilityPlanSchema,
  CompositionCapabilityResolutionSchema,
} from '../capabilities/composition-capability-resolver-schema.ts'
import { CpAMemberMountResult } from '../mounts/member-mount-cp-a-schema.ts'
import { DistOverlayResult } from '../overlays/dist-overlay-lifecycle-schema.ts'
import { DistOverlayDeclaration } from '../overlays/dist-overlay-schema.ts'
import { BuckCacheSectionSchema } from '../root/composition-root.ts'

const AbsolutePath = Schema.String.check(
  Schema.makeFilter<string>((value) =>
    NodePath.isAbsolute(value) === true && NodePath.normalize(value) === value
      ? undefined
      : 'Expected a normalized absolute path',
  ),
).annotate({ identifier: 'Megarepo.CompositionApplyAbsolutePath' })

const MemberKey = Schema.String.check(
  Schema.makeFilter<string>((value) =>
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value) === true
      ? undefined
      : 'Expected a canonical one-segment member key',
  ),
).annotate({ identifier: 'Megarepo.CompositionApplyMemberKey' })

const LockedCommit = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40,64}$/u)).annotate({
  identifier: 'Megarepo.CompositionApplyLockedCommit',
})

/** One immutable locked member source supplied by lock resolution. */
export const CompositionApplyLockedMemberSchema = Schema.Struct({
  key: MemberKey,
  sourcePath: AbsolutePath,
  lockedCommit: LockedCommit,
}).annotate({ identifier: 'Megarepo.CompositionApplyLockedMember' })
export type CompositionApplyLockedMember = typeof CompositionApplyLockedMemberSchema.Type

/** Strict application boundary. Owned acquisition and lock/source resolution have already completed. */
export const CompositionApplyRequestSchema = Schema.Struct({
  workspaceRoot: AbsolutePath,
  ownedMemberKey: MemberKey,
  ownedMemberPath: AbsolutePath,
  compositionConfig: CompositionGeneratorConfig,
  cacheSections: Schema.Array(BuckCacheSectionSchema),
  lockedMembers: Schema.Array(CompositionApplyLockedMemberSchema),
  dryRun: Schema.Boolean,
  allowVerifiedDarwinAdvance: Schema.Boolean,
}).annotate({ identifier: 'Megarepo.CompositionApplyRequest' })
export type CompositionApplyRequest = typeof CompositionApplyRequestSchema.Type

/** Exact Buck invocation for a declared directory overlay. No user flags are represented. */
export const CompositionOverlayBuildPlanSchema = Schema.Struct({
  memberKey: MemberKey,
  target: Schema.String,
  destination: Schema.String,
  canonicalLabel: Schema.String,
  executable: AbsolutePath,
  args: Schema.Array(Schema.String),
  outputPath: AbsolutePath,
  isolationDir: Schema.String,
  daemonPolicy: Schema.Literal('SharedDaemonUnchanged'),
  cleanup: Schema.Literal('RemoveScratchOnly'),
}).annotate({ identifier: 'Megarepo.CompositionOverlayBuildPlan' })
export type CompositionOverlayBuildPlan = typeof CompositionOverlayBuildPlanSchema.Type

/** Hypothetical post-mount overlay publication plan used by mutation-free dry-run. */
export const CompositionOverlayPublicationPlanSchema = Schema.Struct({
  memberKey: MemberKey,
  target: Schema.String,
  destination: Schema.String,
  operation: Schema.Literals(['FirstPublish', 'Update']),
  steps: Schema.Array(
    Schema.Literals([
      'BuildDeclaredDirectory',
      'ValidateRealDirectory',
      'PublishDistOverlay',
      'CleanupScratch',
    ]),
  ),
}).annotate({ identifier: 'Megarepo.CompositionOverlayPublicationPlan' })
export type CompositionOverlayPublicationPlan = typeof CompositionOverlayPublicationPlanSchema.Type

const RootPlannedFileSchema = Schema.Struct({
  path: Schema.String,
  old: Schema.optional(Schema.Struct({ mode: Schema.Finite, sha256: Schema.String })),
  new: Schema.optional(Schema.Struct({ mode: Schema.Finite, sha256: Schema.String })),
})

const RootPublicationPlanSchema = Schema.Union([
  Schema.TaggedStruct('Create', {
    files: Schema.Array(RootPlannedFileSchema),
    configLast: Schema.Literal(true),
  }),
  Schema.TaggedStruct('Update', {
    files: Schema.Array(RootPlannedFileSchema),
    configLast: Schema.Literal(true),
  }),
  Schema.TaggedStruct('NoChange', {
    files: Schema.Array(Schema.Never),
    configLast: Schema.Literal(true),
  }),
  Schema.TaggedStruct('Refused', {
    reason: Schema.String,
    path: Schema.String,
    message: Schema.String,
    files: Schema.Array(Schema.Never),
    configLast: Schema.Literal(false),
  }),
]).annotate({ identifier: 'Megarepo.CompositionApplyRootPublicationPlan' })

/** Mutation-free plan for atomically replacing the acquired owned member's capability subtree. */
export const CompositionOwnedCapabilityProjectionPlanSchema = Schema.Struct({
  memberKey: MemberKey,
  ownedMemberPath: AbsolutePath,
  projectionPath: AbsolutePath,
  operation: Schema.Literal('InstallOwnedCapabilityProjection'),
  steps: Schema.Array(
    Schema.Literals(['ValidateOwnedMember', 'InstallProjectionAtomically', 'CheckProjection']),
  ),
}).annotate({ identifier: 'Megarepo.CompositionOwnedCapabilityProjectionPlan' })
export type CompositionOwnedCapabilityProjectionPlan =
  typeof CompositionOwnedCapabilityProjectionPlanSchema.Type

/** Installed owned-member capability identity returned by the injected atomic installer. */
export const CompositionOwnedCapabilityProjectionResultSchema = Schema.Struct({
  memberKey: MemberKey,
  projectionPath: AbsolutePath,
  projectionDigest: Schema.String,
  changed: Schema.Boolean,
}).annotate({ identifier: 'Megarepo.CompositionOwnedCapabilityProjectionResult' })
export type CompositionOwnedCapabilityProjectionResult =
  typeof CompositionOwnedCapabilityProjectionResultSchema.Type

/** Hypothetical cp-a plan whose capability projection does not exist until apply. */
export const CompositionMemberMountPlanSchema = Schema.Struct({
  memberKey: MemberKey,
  sourcePath: AbsolutePath,
  capabilitiesPath: AbsolutePath,
  destinationPath: AbsolutePath,
  lockedCommit: LockedCommit,
  distOverlays: Schema.Array(DistOverlayDeclaration),
  allowVerifiedDarwinAdvance: Schema.Boolean,
  operation: Schema.Literal('MaterializeOrAdvance'),
  steps: Schema.Array(
    Schema.Literals([
      'ValidateImmutableSource',
      'UseResolvedCapabilityProjection',
      'MaterializeCpAMemberMount',
    ]),
  ),
}).annotate({ identifier: 'Megarepo.CompositionMemberMountPlan' })
export type CompositionMemberMountPlan = typeof CompositionMemberMountPlanSchema.Type

/** One ordered dry-run phase. Array order is application order. */
export const CompositionApplyPlanStepSchema = Schema.Union([
  Schema.TaggedStruct('Capability', {
    memberKey: MemberKey,
    owned: Schema.Boolean,
    plan: CompositionCapabilityPlanSchema,
  }),
  Schema.TaggedStruct('OwnedCapabilityProjection', {
    memberKey: MemberKey,
    plan: CompositionOwnedCapabilityProjectionPlanSchema,
  }),
  Schema.TaggedStruct('Mount', {
    memberKey: MemberKey,
    plan: CompositionMemberMountPlanSchema,
  }),
  Schema.TaggedStruct('Root', { plan: RootPublicationPlanSchema }),
  Schema.TaggedStruct('Overlay', {
    memberKey: MemberKey,
    declaration: DistOverlayDeclaration,
    build: CompositionOverlayBuildPlanSchema,
    publication: CompositionOverlayPublicationPlanSchema,
  }),
]).annotate({ identifier: 'Megarepo.CompositionApplyPlanStep' })
export type CompositionApplyPlanStep = typeof CompositionApplyPlanStepSchema.Type

/** Complete exact non-mutating composition plan. */
export const CompositionApplyPlanSchema = Schema.TaggedStruct('DryRun', {
  steps: Schema.Array(CompositionApplyPlanStepSchema),
  defaultCwd: AbsolutePath,
}).annotate({ identifier: 'Megarepo.CompositionApplyPlan' })
export type CompositionApplyPlan = typeof CompositionApplyPlanSchema.Type

const OverlayResultSchema = Schema.Struct({
  target: Schema.String,
  destination: Schema.String,
  destinationPath: AbsolutePath,
  operation: Schema.Literals(['FirstPublish', 'Update']),
})

/** Per-member capability, mount, and overlay phases returned by a completed apply. */
export const CompositionApplyMemberResultSchema = Schema.Struct({
  memberKey: MemberKey,
  owned: Schema.Boolean,
  capability: CompositionCapabilityResolutionSchema,
  ownedProjection: Schema.optional(CompositionOwnedCapabilityProjectionResultSchema),
  mount: Schema.optional(CpAMemberMountResult),
  overlays: Schema.Array(OverlayResultSchema),
}).annotate({ identifier: 'Megarepo.CompositionApplyMemberResult' })
export type CompositionApplyMemberResult = typeof CompositionApplyMemberResultSchema.Type

/** Recovered durable transactions, in the exact order reconciled before new work. */
export const CompositionApplyRecoveryResultSchema = Schema.Union([
  Schema.TaggedStruct('MountRecovery', {
    memberKey: MemberKey,
    transactionPath: AbsolutePath,
    result: CpAMemberMountResult,
  }),
  Schema.TaggedStruct('OverlayRecovery', {
    memberKey: MemberKey,
    target: Schema.String,
    destination: Schema.String,
    transactionPath: AbsolutePath,
    result: DistOverlayResult,
  }),
]).annotate({ identifier: 'Megarepo.CompositionApplyRecoveryResult' })
export type CompositionApplyRecoveryResult = typeof CompositionApplyRecoveryResultSchema.Type

/** Completed application result. Root authority commits only after all overlays succeed. */
export const CompositionApplyResultSchema = Schema.TaggedStruct('Applied', {
  recoveries: Schema.Array(CompositionApplyRecoveryResultSchema),
  members: Schema.Array(CompositionApplyMemberResultSchema),
  root: Schema.Struct({ changedPaths: Schema.Array(Schema.String) }),
  defaultCwd: AbsolutePath,
}).annotate({ identifier: 'Megarepo.CompositionApplyResult' })
export type CompositionApplyResult = typeof CompositionApplyResultSchema.Type

/** Every successful plan or application response. */
export const CompositionApplyOutputSchema = Schema.Union([
  CompositionApplyPlanSchema,
  CompositionApplyResultSchema,
]).annotate({ identifier: 'Megarepo.CompositionApplyOutput' })
export type CompositionApplyOutput = typeof CompositionApplyOutputSchema.Type

/** CLI-level routine composition result with the owned checkout as default cwd. */
export interface CompositionCommandOutput {
  readonly _tag: 'CompositionDryRun' | 'CompositionApplied'
  readonly composition: CompositionApplyOutput
  readonly workspaceRoot: string
  readonly defaultCwd: string
}

/** Typed orchestration boundary retaining the failing phase, member, and recovery paths. */
export class CompositionApplyError extends Schema.TaggedError<CompositionApplyError>()(
  'CompositionApplyError',
  {
    reason: Schema.Literals([
      'InvalidRequest',
      'OwnedMemberCollision',
      'MemberKeyCollision',
      'PlatformUnsupported',
      'ManifestInvalid',
      'ManifestMountMismatch',
      'PlatformHubMissing',
      'BuckCapabilityMissing',
      'BuckCapabilityMismatch',
      'OverlayDestinationConflict',
      'UpdateLockFailure',
      'RecoveryFailure',
      'CapabilityFailure',
      'MountFailure',
      'RootPublicationFailure',
      'OverlayBuildFailure',
      'OverlayPublicationFailure',
      'CleanupFailure',
    ]),
    phase: Schema.Literals([
      'Input',
      'UpdateLock',
      'Recovery',
      'Manifest',
      'Capability',
      'Mount',
      'Root',
      'OverlayBuild',
      'OverlayPublication',
      'Cleanup',
    ]),
    message: Schema.String,
    path: Schema.optional(Schema.String),
    memberKey: Schema.optional(MemberKey),
    recoveryPaths: Schema.Array(Schema.String),
    primaryFailure: Schema.optional(
      Schema.Struct({
        reason: Schema.String,
        phase: Schema.String,
        message: Schema.String,
      }),
    ),
    cleanupFailures: Schema.optional(
      Schema.Array(
        Schema.Struct({
          resource: Schema.Literals(['CapabilityScratch', 'OverlayScratch', 'WorkspaceUpdateLock']),
          path: Schema.String,
          message: Schema.String,
        }),
      ),
    ),
    updateLockRecovery: Schema.optional(
      Schema.Struct({ path: Schema.String, token: Schema.String }),
    ),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
