import { Effect, Schema } from 'effect'

import { OtelAttr, OtelOperation, type OtelAttrEncodeError } from '@overeng/otel-contract'

const GitHubSpanAttributes = Schema.Struct({
  label: OtelAttr.drop(Schema.NonEmptyString),
  repo: OtelAttr.optional(OtelAttr.string({ key: 'repo' })),
  owner: OtelAttr.optional(OtelAttr.string({ key: 'owner' })),
  status: OtelAttr.optional(OtelAttr.string({ key: 'status' })),
  branch: OtelAttr.optional(OtelAttr.string({ key: 'branch' })),
  workflow: OtelAttr.optional(OtelAttr.string({ key: 'workflow' })),
  ref: OtelAttr.optional(OtelAttr.string({ key: 'ref' })),
  headSha: OtelAttr.optional(OtelAttr.string({ key: 'headSha' })),
  stepUuid: OtelAttr.optional(OtelAttr.string({ key: 'stepUuid' })),
  runId: OtelAttr.optional(OtelAttr.number({ key: 'runId' })),
  jobId: OtelAttr.optional(OtelAttr.number({ key: 'jobId' })),
  restJobId: OtelAttr.optional(OtelAttr.number({ key: 'restJobId' })),
  internalJobId: OtelAttr.optional(OtelAttr.number({ key: 'internalJobId' })),
  stepNumber: OtelAttr.optional(OtelAttr.number({ key: 'stepNumber' })),
  checkRunId: OtelAttr.optional(OtelAttr.number({ key: 'checkRunId' })),
  prNumber: OtelAttr.optional(OtelAttr.number({ key: 'prNumber' })),
})

type GitHubSpanInput = Omit<typeof GitHubSpanAttributes.Type, 'label'>

const trustOtelContract = <A, E, R>(
  effect: Effect.Effect<A, E | OtelAttrEncodeError, R>,
): Effect.Effect<A, E, R> =>
  effect.pipe(Effect.catchTag('OtelAttrEncodeError', (error) => Effect.die(error)))

/** Applies a schema-backed span while preserving the existing GitHub attribute keys. */
export const withGitHubSpan = ({
  name,
  attributes,
}: {
  readonly name: string
  readonly attributes: GitHubSpanInput
}) => {
  const operation = OtelOperation.define({
    name,
    schema: GitHubSpanAttributes,
    label: ({ label }) => label,
  })

  return <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    trustOtelContract(operation.with({ attributes: { label: name, ...attributes }, effect }))
}
