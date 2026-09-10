/* oxlint-disable overeng/jsdoc-require-exports, overeng/named-args -- Phase 2 exports the deploy wire contract as a dense schema surface. */

import { Schema } from 'effect'

import { nonEmptyTrimmedString } from '@overeng/utils'

import {
  DeployAttemptOperation as DeployAttemptOperationContract,
  DeployCleanupOperation as DeployCleanupOperationContract,
  DeployOperation as DeployOperationContract,
  DeployProviderOperation as DeployProviderOperationContract,
  DeployVerifyOperation as DeployVerifyOperationContract,
} from './deploy-domain.contract.ts'
import type { WorkflowReportRecord } from './workflow-report.ts'

/** Non-empty trimmed string (shared `@overeng/utils` definition). */
export const NonEmptyTrimmedString = nonEmptyTrimmedString

export const DeployProvider = Schema.Literals(['netlify', 'vercel']).annotate({
  identifier: 'CiTools.Deploy.Provider',
})
export type DeployProvider = typeof DeployProvider.Type

export const DeployMode = Schema.Literals(['prod', 'pr', 'draft', 'preview']).annotate({
  identifier: 'CiTools.Deploy.Mode',
})
export type DeployMode = typeof DeployMode.Type

export const DeployStatus = Schema.Literals(['success', 'failure', 'skipped']).annotate({
  identifier: 'CiTools.Deploy.Status',
})
export type DeployStatus = typeof DeployStatus.Type

export const MissingAuthPolicy = Schema.Literals(['fail', 'skip']).annotate({
  identifier: 'CiTools.Deploy.MissingAuthPolicy',
})
export type MissingAuthPolicy = typeof MissingAuthPolicy.Type

export const UnauthorizedPolicy = Schema.Literals(['fail', 'skip']).annotate({
  identifier: 'CiTools.Deploy.UnauthorizedPolicy',
})
export type UnauthorizedPolicy = typeof UnauthorizedPolicy.Type

export const PositiveInt = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThan(0)),
  Schema.annotate({ identifier: 'CiTools.Deploy.PositiveInt' }),
)
export type PositiveInt = typeof PositiveInt.Type

export const DeployTarget = NonEmptyTrimmedString.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9._/-]+$/u)),
  Schema.annotate({ identifier: 'CiTools.Deploy.Target' }),
)
export type DeployTarget = typeof DeployTarget.Type

export const DeployAlias = NonEmptyTrimmedString.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/u)),
  Schema.annotate({ identifier: 'CiTools.Deploy.Alias' }),
)
export type DeployAlias = typeof DeployAlias.Type

export const DeployHostname = NonEmptyTrimmedString.pipe(
  Schema.check(
    Schema.isPattern(
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u,
    ),
  ),
  Schema.annotate({ identifier: 'CiTools.Deploy.Hostname' }),
)
export type DeployHostname = typeof DeployHostname.Type

export const EnvVarName = NonEmptyTrimmedString.pipe(
  Schema.check(Schema.isPattern(/^[A-Z_][A-Z0-9_]*$/u)),
  Schema.annotate({ identifier: 'CiTools.Deploy.EnvVarName' }),
)
export type EnvVarName = typeof EnvVarName.Type

export const RelativeHttpPath = NonEmptyTrimmedString.pipe(
  Schema.check(Schema.isPattern(/^\/(?!\/)/u)),
  Schema.annotate({ identifier: 'CiTools.Deploy.RelativeHttpPath' }),
)
export type RelativeHttpPath = typeof RelativeHttpPath.Type

export const HttpsUrl = Schema.URLFromString.pipe(
  Schema.check(
    Schema.makeFilter((url: URL) =>
      url.protocol === 'https:' ? undefined : 'URL must use https:',
    ),
  ),
  Schema.annotate({ identifier: 'CiTools.Deploy.HttpsUrl' }),
)
export type HttpsUrl = typeof HttpsUrl.Type

export const DeployDiagnostic = Schema.Record(
  NonEmptyTrimmedString,
  NonEmptyTrimmedString,
).annotate({ identifier: 'CiTools.Deploy.Diagnostic' })
export type DeployDiagnostic = typeof DeployDiagnostic.Type

export const NetlifyProviderConfig = Schema.TaggedStruct('NetlifyProviderConfig', {
  siteName: Schema.optional(DeployTarget),
  siteIdEnv: EnvVarName,
  authTokenEnv: EnvVarName,
  accountSlugEnv: Schema.optional(EnvVarName),
  apiBaseUrlEnv: Schema.optional(EnvVarName),
}).annotate({ identifier: 'CiTools.Deploy.NetlifyProviderConfig' })
export type NetlifyProviderConfig = typeof NetlifyProviderConfig.Type

export const VercelProviderConfig = Schema.TaggedStruct('VercelProviderConfig', {
  projectIdEnv: EnvVarName,
  orgIdEnv: EnvVarName,
  authTokenEnv: EnvVarName,
  teamIdEnv: Schema.optional(EnvVarName),
  scopeEnv: Schema.optional(EnvVarName),
  protectionBypassEnv: Schema.optional(EnvVarName),
}).annotate({ identifier: 'CiTools.Deploy.VercelProviderConfig' })
export type VercelProviderConfig = typeof VercelProviderConfig.Type

export const DeployProviderConfig = Schema.Union([
  NetlifyProviderConfig,
  VercelProviderConfig,
]).annotate({ identifier: 'CiTools.Deploy.ProviderConfig' })
export type DeployProviderConfig = typeof DeployProviderConfig.Type

export const DeployE2EConfig = Schema.TaggedStruct('DeployE2EConfig', {
  enabled: Schema.Boolean,
  allowSharedProject: Schema.Boolean,
  reservedAliasPrefix: DeployAlias,
  verifyContent: Schema.optional(
    Schema.TaggedStruct('DeployVerifyContent', {
      path: RelativeHttpPath,
      expectedText: NonEmptyTrimmedString,
    }).annotate({ identifier: 'CiTools.Deploy.VerifyContent' }),
  ),
}).annotate({ identifier: 'CiTools.Deploy.E2EConfig' })
export type DeployE2EConfig = typeof DeployE2EConfig.Type

export const DeployInputV1 = Schema.TaggedStruct('DeployInput', {
  schemaVersion: Schema.Literal(1),
  provider: DeployProvider,
  target: DeployTarget,
  displayName: Schema.optional(NonEmptyTrimmedString),
  mode: DeployMode,
  artifactDir: NonEmptyTrimmedString,
  alias: Schema.optional(DeployAlias),
  productionDomains: Schema.optional(Schema.Array(DeployHostname)),
  pr: Schema.optional(PositiveInt),
  gitSha: Schema.optional(NonEmptyTrimmedString),
  runId: Schema.optional(NonEmptyTrimmedString),
  workflowReportOutputFile: Schema.optional(NonEmptyTrimmedString),
  e2e: Schema.optional(DeployE2EConfig),
  providerConfig: DeployProviderConfig,
}).annotate({ identifier: 'CiTools.Deploy.InputV1' })
export type DeployInputV1 = typeof DeployInputV1.Type

export const CleanupResult = Schema.TaggedStruct('CleanupResult', {
  status: Schema.Literals(['succeeded', 'failed', 'skipped']),
  message: Schema.optional(NonEmptyTrimmedString),
}).annotate({ identifier: 'CiTools.Deploy.CleanupResult' })
export type CleanupResult = typeof CleanupResult.Type

export const DeployResultV1 = Schema.TaggedStruct('DeployResult', {
  schemaVersion: Schema.Literal(1),
  provider: DeployProvider,
  target: DeployTarget,
  mode: DeployMode,
  deployId: Schema.optional(NonEmptyTrimmedString),
  rawDeployUrl: HttpsUrl,
  finalUrl: HttpsUrl,
  alias: Schema.optional(DeployAlias),
  productionDomains: Schema.optional(Schema.Array(DeployHostname)),
  startedAtUtc: Schema.DateTimeUtcFromString,
  endedAtUtc: Schema.DateTimeUtcFromString,
  attempts: PositiveInt,
  cleanup: Schema.optional(CleanupResult),
}).annotate({ identifier: 'CiTools.Deploy.ResultV1' })
export type DeployResultV1 = typeof DeployResultV1.Type

const encodeDateTimeUtc = Schema.encodeSync(Schema.DateTimeUtcFromString)

const deployEnvKeySuffix = (target: string) =>
  target
    .replaceAll(/[-/]/gu, '_')
    .replaceAll(/[^A-Za-z0-9_]/gu, '')
    .toUpperCase()

export const deployTaskOutput = (opts: { readonly result: DeployResultV1 }) => {
  const suffix = deployEnvKeySuffix(opts.result.target)
  const provider = opts.result.provider.toUpperCase()
  const rawDeployUrl = opts.result.rawDeployUrl.toString()
  const finalDeployUrl = opts.result.finalUrl.toString()
  const deployedAtUtc = encodeDateTimeUtc(opts.result.endedAtUtc)

  return {
    devenv: {
      env: {
        DEPLOY_FINAL_URL: finalDeployUrl,
        [`DEPLOY_FINAL_URL_${suffix}`]: finalDeployUrl,
        DEPLOY_RAW_DEPLOY_URL: rawDeployUrl,
        [`DEPLOY_RAW_DEPLOY_URL_${suffix}`]: rawDeployUrl,
        DEPLOYED_AT_UTC: deployedAtUtc,
        [`DEPLOYED_AT_UTC_${suffix}`]: deployedAtUtc,
        [`${provider}_DEPLOY_URL`]: finalDeployUrl,
        [`${provider}_DEPLOY_URL_${suffix}`]: finalDeployUrl,
        [`${provider}_RAW_DEPLOY_URL`]: rawDeployUrl,
        [`${provider}_RAW_DEPLOY_URL_${suffix}`]: rawDeployUrl,
        [`${provider}_DEPLOYED_AT_UTC`]: deployedAtUtc,
        [`${provider}_DEPLOYED_AT_UTC_${suffix}`]: deployedAtUtc,
      },
    },
  }
}

export const deployTaskOutputLine = (opts: { readonly result: DeployResultV1 }) =>
  Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(deployTaskOutput(opts))

const DeployFailureFields = {
  provider: DeployProvider,
  target: DeployTarget,
  message: NonEmptyTrimmedString,
  diagnostics: Schema.optional(DeployDiagnostic),
} as const

export class MissingAuth extends Schema.TaggedError<MissingAuth>(
  '@overeng/ci-tools/deploy/MissingAuth',
)('MissingAuth', {
  ...DeployFailureFields,
  envVar: EnvVarName,
}) {
  override get message(): string {
    return `missing ${this.provider} auth env var ${this.envVar} for ${this.target}`
  }
}

export class Unauthorized extends Schema.TaggedError<Unauthorized>(
  '@overeng/ci-tools/deploy/Unauthorized',
)('Unauthorized', {
  ...DeployFailureFields,
}) {
  override get message(): string {
    return `${this.provider} rejected deploy credentials for ${this.target}`
  }
}

export class MissingBuildOutput extends Schema.TaggedError<MissingBuildOutput>(
  '@overeng/ci-tools/deploy/MissingBuildOutput',
)('MissingBuildOutput', {
  ...DeployFailureFields,
  artifactDir: NonEmptyTrimmedString,
}) {
  override get message(): string {
    return `missing build output for ${this.target}: ${this.artifactDir}`
  }
}

export class ProviderProjectLookupFailed extends Schema.TaggedError<ProviderProjectLookupFailed>(
  '@overeng/ci-tools/deploy/ProviderProjectLookupFailed',
)('ProviderProjectLookupFailed', {
  ...DeployFailureFields,
  transient: Schema.Boolean,
}) {
  override get message(): string {
    return `${this.provider} project lookup failed for ${this.target}`
  }
}

export class InvalidProviderOutput extends Schema.TaggedError<InvalidProviderOutput>(
  '@overeng/ci-tools/deploy/InvalidProviderOutput',
)('InvalidProviderOutput', {
  ...DeployFailureFields,
  outputKind: Schema.Literals(['json', 'url', 'workflow-report-record', 'provider-response']),
}) {
  override get message(): string {
    return `${this.provider} returned invalid ${this.outputKind} output for ${this.target}`
  }
}

export class ProviderOperationFailed extends Schema.TaggedError<ProviderOperationFailed>(
  '@overeng/ci-tools/deploy/ProviderOperationFailed',
)('ProviderOperationFailed', {
  ...DeployFailureFields,
  operation: Schema.Literals([
    'resolve-project',
    'prepare',
    'deploy',
    'alias',
    'verify',
    'cleanup',
  ]),
  transient: Schema.Boolean,
}) {
  override get message(): string {
    return `${this.provider} ${this.operation} failed for ${this.target}`
  }
}

export class UnsafeE2EAlias extends Schema.TaggedError<UnsafeE2EAlias>(
  '@overeng/ci-tools/deploy/UnsafeE2EAlias',
)('UnsafeE2EAlias', {
  ...DeployFailureFields,
  alias: DeployAlias,
  reservedAliasPrefix: DeployAlias,
}) {
  override get message(): string {
    return `unsafe live E2E alias ${this.alias} for ${this.target}`
  }
}

export class VerificationFailed extends Schema.TaggedError<VerificationFailed>(
  '@overeng/ci-tools/deploy/VerificationFailed',
)('VerificationFailed', {
  ...DeployFailureFields,
  finalUrl: HttpsUrl,
  transient: Schema.Boolean,
}) {
  override get message(): string {
    return `${this.provider} verification failed for ${this.target}`
  }
}

export const DeployFailure = Schema.Union([
  MissingAuth,
  Unauthorized,
  MissingBuildOutput,
  ProviderProjectLookupFailed,
  InvalidProviderOutput,
  ProviderOperationFailed,
  UnsafeE2EAlias,
  VerificationFailed,
]).annotate({ identifier: 'CiTools.Deploy.Failure' })
export type DeployFailure = typeof DeployFailure.Type

/** Raised when a Vercel alias could not be assigned after collision handling. */
export class AliasAssignmentFailed extends Schema.TaggedError<AliasAssignmentFailed>(
  '@overeng/ci-tools/deploy/AliasAssignmentFailed',
)('AliasAssignmentFailed', {
  failure: DeployFailure,
  attempts: PositiveInt,
}) {}

export const deployFailureRetryability = (failure: DeployFailure): boolean => {
  switch (failure._tag) {
    case 'ProviderProjectLookupFailed':
    case 'VerificationFailed':
    case 'ProviderOperationFailed':
      return failure.transient
    case 'MissingAuth':
    case 'Unauthorized':
    case 'MissingBuildOutput':
    case 'InvalidProviderOutput':
    case 'UnsafeE2EAlias':
      return false
  }
}

export type DeployRecordContext = {
  readonly input: DeployInputV1
  readonly createdAtUtc: string
}

const DeployWorkflowReportSubject = Schema.Struct({
  id: NonEmptyTrimmedString,
  label: Schema.optional(NonEmptyTrimmedString),
}).annotate({ identifier: 'CiTools.Deploy.WorkflowReportSubject' })

const DeployWorkflowReportHttpsUrlString = NonEmptyTrimmedString.pipe(
  Schema.check(Schema.isPattern(/^https:\/\/[^\s]+$/u)),
  Schema.annotate({ identifier: 'CiTools.Deploy.WorkflowReportHttpsUrlString' }),
)

const DeployWorkflowReportLink = Schema.Struct({
  label: NonEmptyTrimmedString,
  url: DeployWorkflowReportHttpsUrlString,
  primary: Schema.optional(Schema.Boolean),
}).annotate({ identifier: 'CiTools.Deploy.WorkflowReportLink' })

const DeployWorkflowReportRecordData = Schema.Record(
  NonEmptyTrimmedString,
  Schema.Unknown,
).annotate({ identifier: 'CiTools.Deploy.WorkflowReportRecordData' })

const DeployWorkflowReportRecord = Schema.TaggedStruct('WorkflowReportRecord', {
  schemaVersion: Schema.Literal(1),
  id: NonEmptyTrimmedString,
  kind: NonEmptyTrimmedString,
  subject: DeployWorkflowReportSubject,
  status: Schema.Literals(['success', 'failure', 'skipped', 'neutral']),
  title: NonEmptyTrimmedString,
  summary: Schema.optional(Schema.String),
  createdAtUtc: NonEmptyTrimmedString.pipe(
    Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u)),
  ),
  links: Schema.optional(Schema.Array(DeployWorkflowReportLink)),
  data: Schema.optional(DeployWorkflowReportRecordData),
}).annotate({ identifier: 'CiTools.Deploy.WorkflowReportRecord' })

const validateWorkflowReportRecord = (record: WorkflowReportRecord): WorkflowReportRecord =>
  Schema.decodeSync(DeployWorkflowReportRecord)(record) as WorkflowReportRecord

const deployRecordId = (provider: DeployProvider, target: string) => `deploy-${provider}-${target}`

const deployRecordSubject = (input: DeployInputV1) => ({
  id: input.target,
  label: input.displayName ?? input.target,
})

const deployRecordTitle = (input: DeployInputV1, suffix: string) =>
  `${input.displayName ?? input.target} preview ${suffix}`

const sanitizedDiagnostics = (diagnostics: DeployDiagnostic | undefined) =>
  diagnostics === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(diagnostics).toSorted(([left], [right]) => left.localeCompare(right)),
      )

export const redactDeployDiagnosticText = (
  text: string,
  opts: { readonly secretValues?: readonly string[] } = {},
) => {
  let redacted = text
  for (const secret of opts.secretValues ?? []) {
    if (secret.trim().length > 0) {
      redacted = redacted.split(secret).join('[REDACTED]')
    }
  }
  return redacted
    .replace(/(authorization:\s*bearer\s+)[^\s]+/giu, '$1[REDACTED]')
    .replace(/((?:token|secret|password|api[_-]?key)=)[^\s&]+/giu, '$1[REDACTED]')
}

export const redactDeployDiagnostics = (
  diagnostics: DeployDiagnostic,
  opts: { readonly secretValues?: readonly string[] } = {},
): DeployDiagnostic =>
  Object.fromEntries(
    Object.entries(diagnostics).map(([key, value]) => [
      key,
      redactDeployDiagnosticText(value, opts),
    ]),
  )

export const deploySuccessRecord = (
  opts: DeployRecordContext & { readonly result: DeployResultV1 },
) =>
  validateWorkflowReportRecord({
    _tag: 'WorkflowReportRecord',
    schemaVersion: 1,
    id: deployRecordId(opts.input.provider, opts.input.target),
    kind: 'deploy-preview',
    subject: deployRecordSubject(opts.input),
    status: 'success',
    title: deployRecordTitle(opts.input, 'deployed'),
    summary: 'Preview is ready',
    createdAtUtc: opts.createdAtUtc,
    links: [
      {
        label: 'Preview',
        url: opts.result.finalUrl.toString(),
        primary: true,
      },
    ],
    data: {
      provider: opts.input.provider,
      target: opts.input.target,
      mode: opts.input.mode,
      attempts: opts.result.attempts,
      ...(opts.result.alias === undefined ? {} : { alias: opts.result.alias }),
      ...(opts.result.productionDomains === undefined || opts.result.productionDomains.length === 0
        ? {}
        : { productionDomains: opts.result.productionDomains }),
      rawDeployUrl: opts.result.rawDeployUrl.toString(),
      finalUrl: opts.result.finalUrl.toString(),
      deployedAtUtc: encodeDateTimeUtc(opts.result.endedAtUtc),
      ...(opts.result.cleanup === undefined ? {} : { cleanup: opts.result.cleanup.status }),
    },
  })

export const deployFailureRecord = (opts: {
  readonly input: DeployInputV1
  readonly failure: DeployFailure
  readonly attempts: number
  readonly createdAtUtc: string
  readonly secretValues?: readonly string[]
}): WorkflowReportRecord => {
  const diagnostics = sanitizedDiagnostics(
    opts.failure.diagnostics === undefined
      ? undefined
      : redactDeployDiagnostics(
          opts.failure.diagnostics,
          opts.secretValues === undefined ? {} : { secretValues: opts.secretValues },
        ),
  )

  return validateWorkflowReportRecord({
    _tag: 'WorkflowReportRecord',
    schemaVersion: 1,
    id: deployRecordId(opts.input.provider, opts.input.target),
    kind: 'deploy-preview',
    subject: deployRecordSubject(opts.input),
    status: 'failure',
    title: deployRecordTitle(opts.input, 'failed'),
    summary: opts.failure.message,
    createdAtUtc: opts.createdAtUtc,
    data: {
      provider: opts.input.provider,
      target: opts.input.target,
      mode: opts.input.mode,
      errorKind: opts.failure._tag,
      retryable: deployFailureRetryability(opts.failure),
      attempts: opts.attempts,
      ...(diagnostics === undefined ? {} : { diagnostics }),
    },
  })
}

export const deploySkippedRecord = (opts: DeployRecordContext & { readonly reason: string }) =>
  validateWorkflowReportRecord({
    _tag: 'WorkflowReportRecord',
    schemaVersion: 1,
    id: deployRecordId(opts.input.provider, opts.input.target),
    kind: 'deploy-preview',
    subject: deployRecordSubject(opts.input),
    status: 'skipped',
    title: deployRecordTitle(opts.input, 'skipped'),
    summary: opts.reason,
    createdAtUtc: opts.createdAtUtc,
    data: {
      provider: opts.input.provider,
      target: opts.input.target,
      mode: opts.input.mode,
    },
  })

export const DeploySpanName = Schema.Literals([
  'ci-tools.deploy',
  'ci-tools.deploy.provider',
  'ci-tools.deploy.attempt',
  'ci-tools.deploy.verify',
  'ci-tools.deploy.cleanup',
]).annotate({ identifier: 'CiTools.Deploy.SpanName' })
export type DeploySpanName = typeof DeploySpanName.Type

export const DeploySpanAttributes = Schema.Struct({
  'span.label': NonEmptyTrimmedString.pipe(
    Schema.check(Schema.isMaxLength(40)),
    Schema.annotate({ identifier: 'CiTools.Deploy.SpanLabel' }),
  ),
  'ci_tools.deploy.provider': DeployProvider,
  'ci_tools.deploy.target': DeployTarget,
  'ci_tools.deploy.mode': Schema.optional(DeployMode),
  'ci_tools.deploy.operation': Schema.optional(
    Schema.Literals(['core', 'provider', 'attempt', 'verify', 'cleanup']),
  ),
  'ci_tools.deploy.attempt': Schema.optional(PositiveInt),
  'ci_tools.deploy.status': Schema.optional(DeployStatus),
  'ci_tools.deploy.error_kind': Schema.optional(NonEmptyTrimmedString),
  'ci_tools.deploy.cleanup_status': Schema.optional(
    Schema.Literals(['succeeded', 'failed', 'skipped']),
  ),
  'ci_tools.deploy.url_host': Schema.optional(NonEmptyTrimmedString),
}).annotate({ identifier: 'CiTools.Deploy.SpanAttributes' })
export type DeploySpanAttributes = typeof DeploySpanAttributes.Type

const shortSpanLabel = (value: string) => value.slice(0, 40)

// Runtime spans DERIVED from the registered seam contract (`./deploy-domain.contract.ts`, namespace
// `ci_tools`), so the `ci_tools.deploy.*` catalog + these encoders share one SSOT (SC-R13/R14). The
// derived `.operation`s are re-exported under their historical names for the runtime call sites
// (`deploy-vercel.ts` / `deploy-netlify.ts`) and the unit test.
export const DeployOperation = DeployOperationContract.operation
export const DeployProviderOperation = DeployProviderOperationContract.operation
export const DeployAttemptOperation = DeployAttemptOperationContract.operation
export const DeployVerifyOperation = DeployVerifyOperationContract.operation
export const DeployCleanupOperation = DeployCleanupOperationContract.operation

export const deploySpanAttributes = (opts: {
  readonly name: DeploySpanName
  readonly input: DeployInputV1
  readonly attempt?: number
  readonly status?: DeployStatus
  readonly failure?: DeployFailure
  readonly finalUrl?: URL
  readonly cleanup?: CleanupResult
}): DeploySpanAttributes => {
  const operation =
    opts.name === 'ci-tools.deploy'
      ? 'core'
      : opts.name === 'ci-tools.deploy.provider'
        ? 'provider'
        : opts.name === 'ci-tools.deploy.attempt'
          ? 'attempt'
          : opts.name === 'ci-tools.deploy.verify'
            ? 'verify'
            : 'cleanup'
  const label =
    operation === 'attempt'
      ? `attempt-${opts.attempt ?? 1}`
      : operation === 'verify' && opts.finalUrl !== undefined
        ? opts.finalUrl.host
        : operation === 'cleanup'
          ? (opts.input.alias ?? opts.input.target)
          : operation === 'provider'
            ? opts.input.provider
            : opts.input.target

  return Schema.decodeSync(DeploySpanAttributes)({
    'span.label': shortSpanLabel(label),
    'ci_tools.deploy.provider': opts.input.provider,
    'ci_tools.deploy.target': opts.input.target,
    'ci_tools.deploy.mode': opts.input.mode,
    'ci_tools.deploy.operation': operation,
    ...(opts.attempt === undefined ? {} : { 'ci_tools.deploy.attempt': opts.attempt }),
    ...(opts.status === undefined ? {} : { 'ci_tools.deploy.status': opts.status }),
    ...(opts.failure === undefined ? {} : { 'ci_tools.deploy.error_kind': opts.failure._tag }),
    ...(opts.cleanup === undefined
      ? {}
      : { 'ci_tools.deploy.cleanup_status': opts.cleanup.status }),
    ...(opts.finalUrl === undefined ? {} : { 'ci_tools.deploy.url_host': opts.finalUrl.host }),
  })
}
