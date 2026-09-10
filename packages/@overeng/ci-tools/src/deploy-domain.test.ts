import { Result, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  DeployAttemptOperation,
  DeployOperation,
  DeployInputV1,
  DeployResultV1,
  InvalidProviderOutput,
  MissingAuth,
  ProviderOperationFailed,
  ProviderProjectLookupFailed,
  UnsafeE2EAlias,
  VerificationFailed,
  deployFailureRecord,
  deployFailureRetryability,
  deploySkippedRecord,
  deploySpanAttributes,
  deploySuccessRecord,
  redactDeployDiagnosticText,
} from './deploy-domain.ts'
import { decodeWorkflowReportRecord } from './mod.ts'

const decodeInput = Schema.decodeUnknownSync(DeployInputV1)
const decodeResult = Schema.decodeUnknownSync(DeployResultV1)

const sampleInput = decodeInput({
  _tag: 'DeployInput',
  schemaVersion: 1,
  provider: 'netlify',
  target: 'effect-react',
  displayName: 'effect-react',
  mode: 'pr',
  artifactDir: 'storybook-static',
  alias: 'ci-tools-e2e-effect-react',
  pr: 868,
  gitSha: 'abc1234',
  runId: 'run-123',
  workflowReportOutputFile: '/tmp/report.jsonl',
  e2e: {
    _tag: 'DeployE2EConfig',
    enabled: true,
    allowSharedProject: true,
    reservedAliasPrefix: 'ci-tools-e2e',
    verifyContent: {
      _tag: 'DeployVerifyContent',
      path: '/index.html',
      expectedText: 'ci-tools deploy fixture',
    },
  },
  providerConfig: {
    _tag: 'NetlifyProviderConfig',
    siteIdEnv: 'NETLIFY_SITE_ID',
    authTokenEnv: 'NETLIFY_AUTH_TOKEN',
  },
})

const sampleResult = decodeResult({
  _tag: 'DeployResult',
  schemaVersion: 1,
  provider: 'netlify',
  target: 'effect-react',
  mode: 'pr',
  deployId: 'deploy-123',
  rawDeployUrl: 'https://raw.example.netlify.app',
  finalUrl: 'https://preview.example.netlify.app',
  alias: 'ci-tools-e2e-effect-react',
  startedAtUtc: '2026-06-29T08:00:00Z',
  endedAtUtc: '2026-06-29T08:00:10Z',
  attempts: 2,
  cleanup: {
    _tag: 'CleanupResult',
    status: 'skipped',
    message: 'Provider has no temporary alias cleanup',
  },
})

describe('deploy domain schemas', () => {
  it('decodes versioned deploy input and result with rich types', () => {
    expect(sampleInput.providerConfig._tag).toBe('NetlifyProviderConfig')
    expect(sampleResult.finalUrl).toBeInstanceOf(URL)
    expect(sampleResult.finalUrl.host).toBe('preview.example.netlify.app')
  })

  it('rejects invalid provider, URL, and unsafe alias shapes', () => {
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(DeployInputV1)({
          ...sampleInput,
          provider: 'github-pages',
        }),
      ),
    ).toBe(true)

    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(DeployResultV1)({
          ...sampleResult,
          finalUrl: 'http://preview.example.netlify.app',
        }),
      ),
    ).toBe(true)

    expect(
      Result.isFailure(
        Schema.decodeResult(DeployInputV1)({
          ...sampleInput,
          alias: 'Unsafe_Alias',
        }),
      ),
    ).toBe(true)
  })
})

describe('deploy failure taxonomy', () => {
  it('derives retryability from typed failures', () => {
    expect(
      deployFailureRetryability(
        new ProviderProjectLookupFailed({
          provider: 'netlify',
          target: 'effect-react',
          transient: true,
          message: 'Netlify project lookup failed',
        }),
      ),
    ).toBe(true)

    expect(
      deployFailureRetryability(
        new ProviderProjectLookupFailed({
          provider: 'netlify',
          target: 'effect-react',
          transient: false,
          message: 'Netlify project is not configured',
        }),
      ),
    ).toBe(false)

    expect(
      deployFailureRetryability(
        new ProviderOperationFailed({
          provider: 'vercel',
          target: 'docs',
          operation: 'deploy',
          transient: true,
          message: 'Provider returned a retryable 503',
        }),
      ),
    ).toBe(true)

    expect(
      deployFailureRetryability(
        new MissingAuth({
          provider: 'vercel',
          target: 'docs',
          envVar: 'VERCEL_TOKEN',
          message: 'Missing Vercel token',
        }),
      ),
    ).toBe(false)

    expect(
      deployFailureRetryability(
        new UnsafeE2EAlias({
          provider: 'netlify',
          target: 'docs',
          alias: 'production',
          reservedAliasPrefix: 'ci-tools-e2e',
          message: 'Alias is outside the reserved E2E namespace',
        }),
      ),
    ).toBe(false)
  })
})

describe('deploy workflow report records', () => {
  it('builds success, failure, and skipped records through the report decoder', () => {
    const success = decodeWorkflowReportRecord(
      deploySuccessRecord({
        input: sampleInput,
        result: sampleResult,
        createdAtUtc: '2026-06-29T08:00:11Z',
      }),
    )
    expect(success).toMatchObject({
      _tag: 'WorkflowReportRecord',
      id: 'deploy-netlify-effect-react',
      status: 'success',
      links: [{ url: 'https://preview.example.netlify.app/', primary: true }],
      data: { provider: 'netlify', target: 'effect-react', mode: 'pr', attempts: 2 },
    })

    const failure = decodeWorkflowReportRecord(
      deployFailureRecord({
        input: sampleInput,
        failure: new InvalidProviderOutput({
          provider: 'netlify',
          target: 'effect-react',
          outputKind: 'provider-response',
          message: 'Provider output did not decode',
          diagnostics: {
            stderr: 'authorization: Bearer fake-secret-value token=fake-secret-value',
            lookup: 'Project not found',
          },
        }),
        attempts: 1,
        createdAtUtc: '2026-06-29T08:00:12Z',
        secretValues: ['fake-secret-value'],
      }),
    )
    expect(failure.status).toBe('failure')
    expect(failure.data).toMatchObject({
      errorKind: 'InvalidProviderOutput',
      retryable: false,
      diagnostics: {
        stderr: 'authorization: Bearer [REDACTED] token=[REDACTED]',
      },
    })
    expect(JSON.stringify(failure)).not.toContain('fake-secret-value')

    const failureWithoutDiagnostics = deployFailureRecord({
      input: sampleInput,
      failure: new ProviderOperationFailed({
        provider: 'netlify',
        target: 'effect-react',
        operation: 'deploy',
        transient: true,
        message: 'Provider returned a retryable 503',
      }),
      attempts: 2,
      createdAtUtc: '2026-06-29T08:00:13Z',
    })
    expect(failureWithoutDiagnostics.data).not.toHaveProperty('diagnostics')

    const skipped = decodeWorkflowReportRecord(
      deploySkippedRecord({
        input: sampleInput,
        reason: 'No local artifact was produced for this target',
        createdAtUtc: '2026-06-29T08:00:13Z',
      }),
    )
    expect(skipped.status).toBe('skipped')
  })

  it('redacts diagnostic text before telemetry or records consume it', () => {
    expect(
      redactDeployDiagnosticText(
        'Authorization: Bearer abc123 password=abc123 token=abc123 api_key=abc123',
        { secretValues: ['abc123'] },
      ),
    ).toBe(
      'Authorization: Bearer [REDACTED] password=[REDACTED] token=[REDACTED] api_key=[REDACTED]',
    )
  })
})

describe('deploy OTEL span attributes', () => {
  it('uses low-cardinality attributes and short span labels', () => {
    expect(
      DeployOperation.encodeSync({
        provider: 'netlify',
        target: 'effect-react',
        mode: 'pr',
        runId: 'run-123',
      }),
    ).toEqual({
      'span.label': 'effect-react',
      'ci_tools.deploy.provider': 'netlify',
      'ci_tools.deploy.target': 'effect-react',
      'ci_tools.deploy.mode': 'pr',
      'ci_tools.deploy.run_id': 'run-123',
    })

    expect(
      DeployAttemptOperation.encodeSync({
        provider: 'vercel',
        target: 'docs',
        mode: 'preview',
        attempt: 2,
        status: 'failure',
        errorKind: 'ProviderOperationFailed',
      }),
    ).toMatchObject({
      'span.label': '2',
      'ci_tools.deploy.error_kind': 'ProviderOperationFailed',
    })

    const attrs = deploySpanAttributes({
      name: 'ci-tools.deploy.verify',
      input: sampleInput,
      status: 'failure',
      finalUrl: sampleResult.finalUrl,
      failure: new VerificationFailed({
        provider: 'netlify',
        target: 'effect-react',
        finalUrl: sampleResult.finalUrl,
        transient: false,
        message: 'Fixture marker was not served',
      }),
    })

    expect(attrs).toEqual({
      'span.label': 'preview.example.netlify.app',
      'ci_tools.deploy.provider': 'netlify',
      'ci_tools.deploy.target': 'effect-react',
      'ci_tools.deploy.mode': 'pr',
      'ci_tools.deploy.operation': 'verify',
      'ci_tools.deploy.status': 'failure',
      'ci_tools.deploy.error_kind': 'VerificationFailed',
      'ci_tools.deploy.url_host': 'preview.example.netlify.app',
    })
    expect(attrs['span.label'].length).toBeLessThanOrEqual(40)
    expect(JSON.stringify(attrs)).not.toContain('https://preview.example.netlify.app')
  })
})
