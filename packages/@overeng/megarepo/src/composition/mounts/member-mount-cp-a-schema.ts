import { Buffer } from 'node:buffer'
import * as NodePath from 'node:path'

import { Schema } from 'effect'

import { DistOverlayDeclaration } from '../overlays/dist-overlay-schema.ts'
import { OwnedCpAMountMetadata, R6ManifestValidationError } from './member-mount-r6.ts'

/** Canonical transaction wire version. */
export const CP_A_MEMBER_MOUNT_TRANSACTION_VERSION = 1 as const

const AbsolutePath = Schema.String.check(
  Schema.makeFilter<string>((value) =>
    NodePath.isAbsolute(value) === true && NodePath.normalize(value) === value
      ? undefined
      : 'Expected a normalized absolute path',
  ),
)
const MemberName = Schema.String.check(
  Schema.makeFilter<string>((value) =>
    value.length > 0 && value !== '.' && value !== '..' && /[/\\]/u.test(value) === false
      ? undefined
      : 'Expected one non-empty member path segment',
  ),
)
const LockedCommit = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40,64}$/u))

/** Serializable materialize-or-advance request. */
export const CpAMemberMountRequest = Schema.Struct({
  workspaceRoot: AbsolutePath,
  member: MemberName,
  sourcePath: AbsolutePath,
  capabilitiesPath: AbsolutePath,
  distOverlays: Schema.Array(DistOverlayDeclaration),
  lockedCommit: LockedCommit,
  dryRun: Schema.Boolean,
  allowVerifiedDarwinAdvance: Schema.Boolean,
}).annotate({ identifier: 'Megarepo.CpAMemberMountRequest' })
export type CpAMemberMountRequest = typeof CpAMemberMountRequest.Type

/** Request for identity-driven transaction reconciliation. */
export const CpAMemberMountRecoveryRequest = Schema.Struct({
  workspaceRoot: AbsolutePath,
  member: MemberName,
  allowVerifiedDarwinAdvance: Schema.Boolean,
}).annotate({ identifier: 'Megarepo.CpAMemberMountRecoveryRequest' })
export type CpAMemberMountRecoveryRequest = typeof CpAMemberMountRecoveryRequest.Type

/** Request for explicit verified mount teardown. */
export const CpAMemberMountTeardownRequest = Schema.Struct({
  workspaceRoot: AbsolutePath,
  member: MemberName,
  dryRun: Schema.Boolean,
}).annotate({ identifier: 'Megarepo.CpAMemberMountTeardownRequest' })
export type CpAMemberMountTeardownRequest = typeof CpAMemberMountTeardownRequest.Type

/** No-follow directory or symlink inode identity. */
export const CpAMountInodeIdentity = Schema.Struct({
  dev: Schema.Natural,
  ino: Schema.Natural,
}).annotate({ identifier: 'Megarepo.CpAMountInodeIdentity' })
export type CpAMountInodeIdentity = typeof CpAMountInodeIdentity.Type

/** Authorized pre-publication identity. */
export const CpAMountOldIdentity = Schema.Union([
  Schema.TaggedStruct('Missing', {}),
  Schema.TaggedStruct('LegacySymlink', {
    target: Schema.String,
    identity: CpAMountInodeIdentity,
  }),
  Schema.TaggedStruct('Owned', {
    metadata: OwnedCpAMountMetadata,
    identity: CpAMountInodeIdentity,
  }),
]).annotate({ identifier: 'Megarepo.CpAMountOldIdentity' })
export type CpAMountOldIdentity = typeof CpAMountOldIdentity.Type

/** Planned metadata and optional created candidate inode. */
export const CpAMountNewIdentity = Schema.Struct({
  metadata: OwnedCpAMountMetadata,
  candidateIdentity: Schema.NullOr(CpAMountInodeIdentity),
}).annotate({ identifier: 'Megarepo.CpAMountNewIdentity' })
export type CpAMountNewIdentity = typeof CpAMountNewIdentity.Type

/** Closed lifecycle operation set. */
export const CpAMemberMountOperation = Schema.Literals([
  'FirstPublish',
  'LegacyConversion',
  'Advance',
  'AlreadyCurrent',
])
export type CpAMemberMountOperation = typeof CpAMemberMountOperation.Type

/** Durable phase state; `CapabilitiesRetained` is the publication commit marker. */
export const CpAMemberMountPhaseHint = Schema.Literals([
  'Intent',
  'CandidateCreated',
  'Staged',
  'Exchanged',
  'CapabilitiesRetained',
  'MetadataPublished',
  'Cleanup',
])
export type CpAMemberMountPhaseHint = typeof CpAMemberMountPhaseHint.Type

/** Atomic transaction record binding both paths and both identities. */
export const CpAMemberMountTransaction = Schema.Struct({
  version: Schema.Literal(CP_A_MEMBER_MOUNT_TRANSACTION_VERSION),
  member: MemberName,
  sourcePath: AbsolutePath,
  destinationPath: AbsolutePath,
  stagePath: AbsolutePath,
  operation: Schema.Literals(['FirstPublish', 'LegacyConversion', 'Advance']),
  phaseHint: CpAMemberMountPhaseHint,
  oldIdentity: CpAMountOldIdentity,
  newIdentity: CpAMountNewIdentity,
}).annotate({ identifier: 'Megarepo.CpAMemberMountTransaction' })
export type CpAMemberMountTransaction = typeof CpAMemberMountTransaction.Type

/** Ordered externally visible lifecycle plan step. */
export const CpAMemberMountPlanStep = Schema.Literals([
  'CreateTransaction',
  'CopySource',
  'ReplaceCapabilities',
  'CheckCapabilities',
  'ProtectCandidate',
  'ValidatePostcondition',
  'PublishRename',
  'Exchange',
  'PublishMetadata',
  'ValidateOldIdentity',
  'DeleteOld',
  'RemoveTransaction',
])
export type CpAMemberMountPlanStep = typeof CpAMemberMountPlanStep.Type

/** Nonmutating materialize-or-advance plan. */
export const CpAMemberMountPlan = Schema.TaggedStruct('MountPlan', {
  operation: CpAMemberMountOperation,
  member: MemberName,
  sourcePath: AbsolutePath,
  destinationPath: AbsolutePath,
  stagePath: AbsolutePath,
  transactionPath: AbsolutePath,
  oldIdentity: CpAMountOldIdentity,
  newMetadata: OwnedCpAMountMetadata,
  steps: Schema.Array(CpAMemberMountPlanStep),
}).annotate({ identifier: 'Megarepo.CpAMemberMountPlan' })
export type CpAMemberMountPlan = typeof CpAMemberMountPlan.Type

/** Nonmutating explicit teardown plan. */
export const CpAMemberMountTeardownPlan = Schema.TaggedStruct('TeardownPlan', {
  member: MemberName,
  destinationPath: AbsolutePath,
  metadata: OwnedCpAMountMetadata,
  steps: Schema.Array(
    Schema.Literals(['ValidateOwnership', 'UnprotectDirectories', 'DeleteMount', 'DeleteMetadata']),
  ),
}).annotate({ identifier: 'Megarepo.CpAMemberMountTeardownPlan' })
export type CpAMemberMountTeardownPlan = typeof CpAMemberMountTeardownPlan.Type

/** Every lifecycle dry-run plan. */
export const CpAMemberMountAnyPlan = Schema.Union([CpAMemberMountPlan, CpAMemberMountTeardownPlan])
export type CpAMemberMountAnyPlan = typeof CpAMemberMountAnyPlan.Type

/** Lifecycle result union shared by materialize, recovery, and teardown. */
export const CpAMemberMountResult = Schema.Union([
  Schema.TaggedStruct('DryRun', { plan: CpAMemberMountAnyPlan }),
  Schema.TaggedStruct('AlreadyCurrent', {
    destinationPath: AbsolutePath,
    metadata: OwnedCpAMountMetadata,
  }),
  Schema.TaggedStruct('Published', {
    operation: Schema.Literals(['FirstPublish', 'LegacyConversion', 'Advance']),
    destinationPath: AbsolutePath,
    metadata: OwnedCpAMountMetadata,
  }),
  Schema.TaggedStruct('Recovered', {
    action: Schema.Literals(['RolledBack', 'RolledForward']),
    destinationPath: AbsolutePath,
  }),
  Schema.TaggedStruct('TornDown', { destinationPath: AbsolutePath }),
]).annotate({ identifier: 'Megarepo.CpAMemberMountResult' })
export type CpAMemberMountResult = typeof CpAMemberMountResult.Type

/** Typed refusal or recoverable lifecycle failure. */
export class CpAMemberMountError extends Schema.TaggedError<CpAMemberMountError>()(
  'CpAMemberMountError',
  {
    reason: Schema.Literals([
      'InvalidRequest',
      'SourceInvalid',
      'DestinationRefused',
      'TransactionCollision',
      'PlatformAdvanceRefused',
      'CommandFailure',
      'CapabilityCheckFailed',
      'CapabilityRetentionFailed',
      'SourceChanged',
      'StageInvalid',
      'ExchangeValidationFailed',
      'AmbiguousRecovery',
      'IoFailure',
    ]),
    path: Schema.String,
    message: Schema.String,
    recoveryPaths: Schema.Array(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** Bijective member filename used for lifecycle transactions on case-insensitive filesystems. */
export const encodeCpAMountMemberFilename = (member: string): string => {
  if (member.length === 0 || member === '.' || member === '..' || /[/\\]/u.test(member) === true) {
    throw new R6ManifestValidationError({
      reason: 'InvalidPath',
      message: `Invalid member name '${member}'`,
    })
  }
  return `v1-${Buffer.from(member, 'utf8').toString('hex')}.json`
}

/** Derive the workspace-owned transaction path outside the mount. */
export const cpAMemberMountTransactionPath = ({
  workspaceRoot,
  member,
}: {
  workspaceRoot: string
  member: string
}): string =>
  NodePath.join(
    NodePath.resolve(workspaceRoot),
    'repos',
    '.mr',
    'transactions',
    encodeCpAMountMemberFilename(member),
  )

/** Derive the member destination under the workspace repos directory. */
export const cpAMemberMountDestinationPath = ({
  workspaceRoot,
  member,
}: {
  workspaceRoot: string
  member: string
}): string => {
  encodeCpAMountMemberFilename(member)
  return NodePath.join(NodePath.resolve(workspaceRoot), 'repos', member)
}
