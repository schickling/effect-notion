import * as NodePath from 'node:path'

import { Schema } from 'effect'

const AbsolutePath = Schema.String.check(
  Schema.makeFilter<string>((value) =>
    NodePath.isAbsolute(value) === true && NodePath.normalize(value) === value
      ? undefined
      : 'Expected a normalized absolute path',
  ),
).annotate({ identifier: 'Megarepo.OwnedWorktreeAbsolutePath' })

/** Canonical one-segment owned member name. */
export const OwnedWorktreeName = Schema.String.check(
  Schema.makeFilter<string>((value) =>
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value) === true && value !== '.' && value !== '..'
      ? undefined
      : 'Expected one canonical member path segment',
  ),
).annotate({ identifier: 'Megarepo.OwnedWorktreeName' })
export type OwnedWorktreeName = typeof OwnedWorktreeName.Type

/** Supported authority config filename discovered from the owned checkout. */
export const OwnedWorktreeConfigName = Schema.Literals(['megarepo.kdl', 'megarepo.json'])
export type OwnedWorktreeConfigName = typeof OwnedWorktreeConfigName.Type

/** Canonical composed root and its Git-owned checkout. */
export const ComposedOwnedWorkspace = Schema.Struct({
  workspaceRoot: AbsolutePath,
  ownedWorktree: AbsolutePath,
  defaultCwd: AbsolutePath,
  configPath: AbsolutePath,
  configName: OwnedWorktreeConfigName,
  ownedMember: OwnedWorktreeName,
  bareRepo: AbsolutePath,
  branch: Schema.String,
}).annotate({ identifier: 'Megarepo.ComposedOwnedWorkspace' })
export type ComposedOwnedWorkspace = typeof ComposedOwnedWorkspace.Type

/** Typed refusal for direct creation or composed-shape validation. */
export class OwnedWorktreeAcquisitionError extends Schema.TaggedError<OwnedWorktreeAcquisitionError>()(
  'OwnedWorktreeAcquisitionError',
  {
    reason: Schema.Literals([
      'InvalidRequest',
      'ForeignRoot',
      'GitIdentityConflict',
      'ConfigMissing',
      'ConfigSymlinkInvalid',
      'GenerationFailed',
      'CommandFailure',
      'IoFailure',
    ]),
    path: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
