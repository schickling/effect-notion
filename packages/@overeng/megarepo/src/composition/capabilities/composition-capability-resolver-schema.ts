import * as PosixPath from 'node:path/posix'

import { Schema } from 'effect'

import { BuckMemberCapabilitySchema } from '@overeng/megarepo/buck2-manifest'

const AbsolutePath = Schema.String.check(
  Schema.makeFilter<string>((value) =>
    value.startsWith('/') === true && PosixPath.normalize(value) === value
      ? undefined
      : 'Expected a normalized absolute POSIX path',
  ),
).annotate({ identifier: 'Megarepo.CompositionCapabilityAbsolutePath' })

const Sha256Digest = Schema.String.check(
  Schema.makeFilter<string>((value) =>
    /^sha256:[0-9a-f]{64}$/u.test(value) === true
      ? undefined
      : 'Expected a sha256:<64 lowercase hex> digest',
  ),
).annotate({ identifier: 'Megarepo.CompositionCapabilitySha256' })

const ProjectionDigest = Schema.String.check(
  Schema.makeFilter<string>((value) =>
    /^[0-9a-f]{64}$/u.test(value) === true
      ? undefined
      : 'Expected a 64-character lowercase hexadecimal projection digest',
  ),
).annotate({ identifier: 'Megarepo.CompositionCapabilityProjectionDigest' })

/** Nix systems supported by the tracked Buck capability projector. */
export const CompositionCapabilitySystemSchema = Schema.Literals([
  'x86_64-linux',
  'aarch64-linux',
  'aarch64-darwin',
]).annotate({ identifier: 'Megarepo.CompositionCapabilitySystem' })
export type CompositionCapabilitySystem = typeof CompositionCapabilitySystemSchema.Type

/** One exact process invocation, suitable for plan output and audit. */
export const CompositionCapabilityCommandSchema = Schema.Struct({
  executable: AbsolutePath,
  args: Schema.Array(Schema.String),
}).annotate({ identifier: 'Megarepo.CompositionCapabilityCommand' })
export type CompositionCapabilityCommand = typeof CompositionCapabilityCommandSchema.Type

/**
 * Manifest capability plus its exact Nix realization, executable identity, and complete
 * immutable runtime closure.
 *
 * `closureStorePaths` is the transitive `/nix/store` requisite set of the realization: exactly
 * the paths a sandboxed action may read, sorted and including `nixOutputPath` itself.
 */
export const ResolvedCompositionCapabilitySchema = Schema.Struct({
  capability: BuckMemberCapabilitySchema,
  nixOutputPath: AbsolutePath,
  executablePath: AbsolutePath,
  executableDigest: Sha256Digest,
  closureStorePaths: Schema.Array(AbsolutePath).check(
    Schema.makeFilter<ReadonlyArray<string>>((value) =>
      value.length === 0
        ? 'Expected at least one closure store path'
        : value.every((path) => /^\/nix\/store\/[^/]+(?:\/.*)?$/u.test(path)) === false
          ? 'Expected every closure path below /nix/store'
          : value.every((path, index) => index === 0 || path > value[index - 1]!) === false
            ? 'Expected strictly sorted unique closure store paths'
            : undefined,
    ),
  ),
}).annotate({ identifier: 'Megarepo.ResolvedCompositionCapability' })
export type ResolvedCompositionCapability = typeof ResolvedCompositionCapabilitySchema.Type

/** Successful non-mutating plan. External commands have not run. */
export const CompositionCapabilityPlanSchema = Schema.TaggedStruct('Planned', {
  system: CompositionCapabilitySystemSchema,
  projectorPlatform: Schema.Literals(['x86_64-linux', 'aarch64-linux', 'aarch64-macos']),
  candidateRoot: AbsolutePath,
  nixCommands: Schema.Array(CompositionCapabilityCommandSchema),
}).annotate({ identifier: 'Megarepo.CompositionCapabilityPlan' })
export type CompositionCapabilityPlan = typeof CompositionCapabilityPlanSchema.Type

/** Successful realized projection retained below the caller-owned scratch directory. */
export const CompositionCapabilityResolutionSchema = Schema.TaggedStruct('Resolved', {
  system: CompositionCapabilitySystemSchema,
  projectorPlatform: Schema.Literals(['x86_64-linux', 'aarch64-linux', 'aarch64-macos']),
  candidateRoot: AbsolutePath,
  projectionPath: AbsolutePath,
  projectionDigest: ProjectionDigest,
  capabilities: Schema.Array(ResolvedCompositionCapabilitySchema),
  capabilitiesByToolId: Schema.Record(Schema.String, ResolvedCompositionCapabilitySchema),
  nixCommands: Schema.Array(CompositionCapabilityCommandSchema),
}).annotate({ identifier: 'Megarepo.CompositionCapabilityResolution' })
export type CompositionCapabilityResolution = typeof CompositionCapabilityResolutionSchema.Type

/** Structured fail-closed resolver error. */
export class CompositionCapabilityResolutionError extends Schema.TaggedError<CompositionCapabilityResolutionError>()(
  'CompositionCapabilityResolutionError',
  {
    reason: Schema.Literals([
      'InvalidInput',
      'InvalidRuntime',
      'InvalidLock',
      'CommandFailure',
      'InvalidNixOutput',
      'InvalidExecutable',
      'CandidateReplaced',
      'ProjectionFailure',
    ]),
    message: Schema.String,
    path: Schema.optional(AbsolutePath),
    command: Schema.optional(CompositionCapabilityCommandSchema),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
