/* oxlint-disable overeng/jsdoc-require-exports, overeng/named-args -- Phase 3 exposes the Netlify deploy boundary used by generated tasks. */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

import { Effect, Result, Schema } from 'effect'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest'

import {
  DeployInputV1,
  type DeployFailure,
  type MissingAuthPolicy,
  type UnauthorizedPolicy,
  DeployProviderOperation,
  DeployResultV1,
  InvalidProviderOutput,
  MissingAuth,
  NonEmptyTrimmedString,
  ProviderOperationFailed,
  ProviderProjectLookupFailed,
  Unauthorized,
  UnsafeE2EAlias,
  VerificationFailed,
  deployFailureRecord,
  deploySkippedRecord,
  deploySuccessRecord,
  redactDeployDiagnosticText,
} from './deploy-domain.ts'
import {
  emitWorkflowReportRecord,
  writeDevenvTaskOutput,
  writeGithubDeployOutputs,
  writeGithubWorkflowReportOutput,
} from './deploy-io.ts'

const decodeInputEither = Schema.decodeUnknownResult(DeployInputV1)
const decodeResultEither = Schema.decodeUnknownResult(DeployResultV1)

export type NetlifyDeployCommandOptions = {
  readonly target: string
  readonly artifactDir: string
  readonly mode: 'prod' | 'pr' | 'draft'
  readonly displayName?: string | undefined
  readonly pr?: number | undefined
  readonly siteName?: string | undefined
  readonly siteIdEnv: string
  readonly authTokenEnv: string
  readonly accountSlugEnv?: string | undefined
  readonly workspaceFilter?: string | undefined
  readonly workflowReportOutputFile?: string | undefined
  readonly githubOutputFile?: string | undefined
  readonly githubEnvFile?: string | undefined
  readonly urlEnvKey?: string | undefined
  readonly netlifyBin: string
  readonly netlifyApiBaseUrl: string
  readonly missingAuthPolicy: MissingAuthPolicy
  readonly unauthorizedPolicy: UnauthorizedPolicy
  readonly createdAtUtc?: string | undefined
  readonly e2eAllowSharedProject: boolean
  readonly e2eReservedAliasPrefix: string
  readonly e2eVerifyPath?: string | undefined
  readonly e2eVerifyText?: string | undefined
}

const HttpsUrlString = Schema.NonEmptyString.check(
  Schema.isPattern(/^https:\/\/[^\s]+$/u),
).annotate({ identifier: 'CiTools.Netlify.HttpsUrlString' })

const NetlifyDeployJson = Schema.Struct({
  deploy_id: NonEmptyTrimmedString,
  site_name: NonEmptyTrimmedString,
  deploy_url: HttpsUrlString,
}).annotate({ identifier: 'CiTools.Netlify.DeployJson' })

const NetlifySiteJson = Schema.Struct({
  name: Schema.optional(NonEmptyTrimmedString),
  account_slug: Schema.optional(NonEmptyTrimmedString),
}).annotate({ identifier: 'CiTools.Netlify.SiteJson' })

const isoNow = () => new Date().toISOString()

const optional = (value: string | undefined) =>
  value === undefined || value.trim().length === 0 ? undefined : value

const envValue = (envName: string) => optional(process.env[envName])

const netlifyAlias = Effect.fn('ci-tools.deploy.netlify.alias')(function* (opts: {
  readonly mode: 'prod' | 'pr' | 'draft'
  readonly target: string
  readonly pr?: number | undefined
}) {
  switch (opts.mode) {
    case 'prod':
      return opts.target
    case 'pr':
      if (opts.pr === undefined) {
        return yield* new ProviderOperationFailed({
          provider: 'netlify',
          target: opts.target,
          operation: 'deploy',
          transient: false,
          message: 'Netlify PR deploy requires --pr',
        })
      }
      return `${opts.target}-pr-${opts.pr}`
    case 'draft':
      return undefined
  }
})

const decodeDeployInput = Effect.fn('ci-tools.deploy.netlify.decode-input')(function* (
  value: unknown,
) {
  const decoded = decodeInputEither(value)
  if (Result.isSuccess(decoded) === true) return decoded.success
  return yield* new InvalidProviderOutput({
    provider: 'netlify',
    target:
      typeof value === 'object' &&
      value !== null &&
      'target' in value &&
      typeof value.target === 'string'
        ? value.target
        : 'netlify',
    outputKind: 'provider-response',
    message: 'Netlify deploy input did not match the ci-tools schema',
    diagnostics: { cause: String(decoded.failure) },
  })
})

const assertSafeE2EAlias = Effect.fn('ci-tools.deploy.netlify.e2e-alias')(function* (opts: {
  readonly target: string
  readonly alias: string | undefined
  readonly allowSharedProject: boolean
  readonly reservedAliasPrefix: string
}) {
  if (opts.allowSharedProject === false || opts.alias === undefined) return
  if (opts.alias.startsWith(opts.reservedAliasPrefix) === true) return
  return yield* new UnsafeE2EAlias({
    provider: 'netlify',
    target: opts.target,
    alias: opts.alias,
    reservedAliasPrefix: opts.reservedAliasPrefix,
    message: `Netlify live E2E alias must start with ${opts.reservedAliasPrefix}`,
  })
})

const runNetlifyCommand = Effect.fn('ci-tools.deploy.netlify.command')(
  (opts: {
    readonly netlifyBin: string
    readonly args: readonly string[]
    readonly env?: Readonly<Record<string, string>> | undefined
  }) =>
    Effect.sync(() => {
      const result = spawnSync(opts.netlifyBin, opts.args, {
        encoding: 'utf8',
        env: { ...process.env, ...opts.env },
      })
      return {
        status: typeof result.status === 'number' ? result.status : 1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? String(result.error?.message ?? ''),
      }
    }),
)

const fetchNetlifyJson = Effect.fn('ci-tools.deploy.netlify.fetch-json')(function* (opts: {
  readonly target: string
  readonly apiBaseUrl: string
  readonly authToken: string
  readonly path: string
}) {
  const client = yield* HttpClient.HttpClient
  return yield* client
    .execute(
      HttpClientRequest.get(`${opts.apiBaseUrl.replace(/\/+$/u, '')}${opts.path}`).pipe(
        HttpClientRequest.setHeader('Authorization', `Bearer ${opts.authToken}`),
        HttpClientRequest.setHeader('Connection', 'close'),
      ),
    )
    .pipe(
      Effect.flatMap((response) =>
        response.text.pipe(Effect.map((text) => ({ status: response.status, text }))),
      ),
      Effect.catchTag(
        'HttpClientError',
        (cause) =>
          new ProviderProjectLookupFailed({
            provider: 'netlify',
            target: opts.target,
            transient: true,
            message: cause.message,
          }),
      ),
    )
})

const resolveNetlifySite = Effect.fn('ci-tools.deploy.netlify.resolve-site')(function* (opts: {
  readonly target: string
  readonly siteId: string | undefined
  readonly authToken: string
  readonly apiBaseUrl: string
}) {
  if (opts.siteId === undefined) return {}
  const response = yield* fetchNetlifyJson({
    target: opts.target,
    apiBaseUrl: opts.apiBaseUrl,
    authToken: opts.authToken,
    path: `/api/v1/sites/${encodeURIComponent(opts.siteId)}`,
  })

  if (response.status === 401 || response.status === 403) {
    return yield* new Unauthorized({
      provider: 'netlify',
      target: opts.target,
      message: 'Netlify API rejected deploy credentials',
      diagnostics: { apiStatus: String(response.status) },
    })
  }
  if (response.status === 404) {
    return yield* new ProviderProjectLookupFailed({
      provider: 'netlify',
      target: opts.target,
      transient: false,
      message: 'Netlify site was not found',
      diagnostics: { apiStatus: String(response.status) },
    })
  }
  if (response.status >= 500) {
    return yield* new ProviderProjectLookupFailed({
      provider: 'netlify',
      target: opts.target,
      transient: true,
      message: 'Netlify site lookup returned a transient provider error',
      diagnostics: { apiStatus: String(response.status) },
    })
  }
  if (response.status < 200 || response.status >= 300) {
    return yield* new ProviderProjectLookupFailed({
      provider: 'netlify',
      target: opts.target,
      transient: false,
      message: 'Netlify site lookup failed',
      diagnostics: { apiStatus: String(response.status) },
    })
  }

  const decoded = Schema.decodeResult(Schema.fromJsonString(NetlifySiteJson))(response.text)
  if (Result.isFailure(decoded) === true) {
    return yield* new ProviderProjectLookupFailed({
      provider: 'netlify',
      target: opts.target,
      transient: false,
      message: 'Netlify site lookup returned invalid JSON',
      diagnostics: { apiStatus: String(response.status) },
    })
  }
  return {
    siteName: decoded.success.name,
    accountSlug: decoded.success.account_slug,
  }
})

const classifyNetlifyDeployFailure = (opts: {
  readonly target: string
  readonly status: number
  readonly stdout: string
  readonly stderr: string
  readonly authToken: string
}) => {
  const sanitizedStderr = redactDeployDiagnosticText(opts.stderr, {
    secretValues: [opts.authToken],
  }).trim()
  const sanitizedStdout = redactDeployDiagnosticText(opts.stdout, {
    secretValues: [opts.authToken],
  }).trim()
  const diagnostics = {
    exitCode: String(opts.status),
    ...(sanitizedStderr.trim().length === 0 ? {} : { stderr: sanitizedStderr }),
    ...(sanitizedStdout.trim().length === 0 ? {} : { stdout: sanitizedStdout }),
  }
  if (
    opts.stderr.includes('Project not found. Please rerun "netlify link"') === true ||
    opts.stderr.includes('Project not found. Please rerun netlify link') === true
  ) {
    return new ProviderProjectLookupFailed({
      provider: 'netlify',
      target: opts.target,
      transient: false,
      message: 'Netlify project lookup failed',
      diagnostics,
    })
  }
  if (opts.stderr.includes('Unauthorized: could not retrieve project') === true) {
    return new Unauthorized({
      provider: 'netlify',
      target: opts.target,
      message: 'Netlify credentials could not retrieve the configured project',
      diagnostics,
    })
  }
  if (/unauthorized|forbidden|invalid token/iu.test(opts.stderr) === true) {
    return new Unauthorized({
      provider: 'netlify',
      target: opts.target,
      message: 'Netlify rejected deploy credentials',
      diagnostics,
    })
  }
  return new ProviderOperationFailed({
    provider: 'netlify',
    target: opts.target,
    operation: 'deploy',
    transient: opts.status >= 500,
    message: 'Netlify deploy command failed',
    diagnostics,
  })
}

const parseDeployJson = Effect.fn('ci-tools.deploy.netlify.parse-json')(function* (opts: {
  readonly target: string
  readonly stdout: string
  readonly authToken: string
}) {
  const decoded = Schema.decodeResult(Schema.fromJsonString(NetlifyDeployJson))(opts.stdout)
  if (Result.isSuccess(decoded) === true) {
    return decoded.success
  }
  const sanitizedStdout = redactDeployDiagnosticText(opts.stdout, {
    secretValues: [opts.authToken],
  }).trim()
  return yield* new InvalidProviderOutput({
    provider: 'netlify',
    target: opts.target,
    outputKind: 'json',
    message: 'Netlify CLI did not return deploy_id, site_name, and deploy_url',
    diagnostics: sanitizedStdout.length === 0 ? undefined : { stdout: sanitizedStdout },
  })
})

const verifyFinalUrlOnce = Effect.fn('ci-tools.deploy.netlify.verify-once')(function* (opts: {
  readonly target: string
  readonly finalUrl: URL
  readonly path: string
  readonly expectedText: string
  readonly attempt: number
}) {
  const verifyUrl = new URL(opts.path, opts.finalUrl)
  const client = yield* HttpClient.HttpClient
  const response = yield* client
    .execute(
      HttpClientRequest.get(verifyUrl.toString()).pipe(
        HttpClientRequest.setHeader('Connection', 'close'),
      ),
    )
    .pipe(
      Effect.flatMap((result) =>
        result.text.pipe(Effect.map((text) => ({ status: result.status, text }))),
      ),
      Effect.catchTag(
        'HttpClientError',
        (cause) =>
          new VerificationFailed({
            provider: 'netlify',
            target: opts.target,
            finalUrl: opts.finalUrl,
            transient: true,
            message: cause.message,
            diagnostics: { attempt: String(opts.attempt), verifyPath: opts.path },
          }),
      ),
    )

  if (response.status < 200 || response.status >= 300) {
    return yield* new VerificationFailed({
      provider: 'netlify',
      target: opts.target,
      finalUrl: opts.finalUrl,
      transient: response.status >= 500,
      message: `Netlify live E2E verification returned HTTP ${response.status}`,
      diagnostics: { attempt: String(opts.attempt), httpStatus: String(response.status) },
    })
  }

  if (response.text.includes(opts.expectedText) === false) {
    return yield* new VerificationFailed({
      provider: 'netlify',
      target: opts.target,
      finalUrl: opts.finalUrl,
      transient: false,
      message: 'Netlify live E2E marker text was not served',
      diagnostics: { attempt: String(opts.attempt), verifyPath: opts.path },
    })
  }
})

const verifyFinalUrl = Effect.fn('ci-tools.deploy.netlify.verify')(function* (opts: {
  readonly target: string
  readonly finalUrl: URL
  readonly path: string
  readonly expectedText: string
}) {
  let lastFailure: VerificationFailed | undefined
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const result = yield* verifyFinalUrlOnce({ ...opts, attempt }).pipe(Effect.result)
    if (Result.isSuccess(result) === true) return
    lastFailure = result.failure
    if (attempt < 10) {
      yield* Effect.sleep('2 seconds')
    }
  }
  return yield* (
    lastFailure ??
      new VerificationFailed({
        provider: 'netlify',
        target: opts.target,
        finalUrl: opts.finalUrl,
        transient: true,
        message: 'Netlify live E2E verification did not complete',
      })
  )
})

export const runNetlifyDeploy = Effect.fn('ci-tools.deploy.netlify')(function* (
  options: NetlifyDeployCommandOptions,
) {
  const createdAtUtc = options.createdAtUtc ?? isoNow()
  const alias = yield* netlifyAlias({ mode: options.mode, target: options.target, pr: options.pr })

  const input = yield* decodeDeployInput({
    _tag: 'DeployInput',
    schemaVersion: 1,
    provider: 'netlify',
    target: options.target,
    displayName: options.displayName,
    mode: options.mode,
    artifactDir: options.artifactDir,
    alias,
    pr: options.pr,
    workflowReportOutputFile: options.workflowReportOutputFile,
    e2e: {
      _tag: 'DeployE2EConfig',
      enabled: options.e2eAllowSharedProject,
      allowSharedProject: options.e2eAllowSharedProject,
      reservedAliasPrefix: options.e2eReservedAliasPrefix,
      ...(options.e2eVerifyPath === undefined || options.e2eVerifyText === undefined
        ? {}
        : {
            verifyContent: {
              _tag: 'DeployVerifyContent',
              path: options.e2eVerifyPath,
              expectedText: options.e2eVerifyText,
            },
          }),
    },
    providerConfig: {
      _tag: 'NetlifyProviderConfig',
      siteName: options.siteName,
      siteIdEnv: options.siteIdEnv,
      authTokenEnv: options.authTokenEnv,
      accountSlugEnv: options.accountSlugEnv,
    },
  })

  const authTokenValue = envValue(options.authTokenEnv)
  const failWithRecord = (failure: DeployFailure) =>
    emitWorkflowReportRecord({
      workflowReportOutputFile: options.workflowReportOutputFile,
      record: deployFailureRecord({
        input,
        failure,
        attempts: 1,
        createdAtUtc,
        secretValues: authTokenValue === undefined ? [] : [authTokenValue],
      }),
    }).pipe(Effect.andThen(Effect.fail(failure)))
  const skipWithRecord = (reason: string) =>
    emitWorkflowReportRecord({
      workflowReportOutputFile: options.workflowReportOutputFile,
      record: deploySkippedRecord({ input, reason, createdAtUtc }),
    }).pipe(
      Effect.flatMap((recordJson) =>
        writeGithubWorkflowReportOutput({
          recordJson,
          workflowReportOutputFile: options.workflowReportOutputFile,
          githubOutputFile: options.githubOutputFile,
        }),
      ),
    )

  if ((options.e2eVerifyPath === undefined) !== (options.e2eVerifyText === undefined)) {
    return yield* failWithRecord(
      new ProviderOperationFailed({
        provider: 'netlify',
        target: options.target,
        operation: 'verify',
        transient: false,
        message: 'Netlify live E2E verification requires both path and expected text',
      }),
    )
  }

  yield* assertSafeE2EAlias({
    target: options.target,
    alias,
    allowSharedProject: options.e2eAllowSharedProject,
    reservedAliasPrefix: options.e2eReservedAliasPrefix,
  }).pipe(Effect.catch(failWithRecord))

  if (existsSync(options.artifactDir) === false) {
    const recordJson = yield* emitWorkflowReportRecord({
      workflowReportOutputFile: options.workflowReportOutputFile,
      record: deploySkippedRecord({
        input,
        reason: `No local artifact was produced for ${options.target}`,
        createdAtUtc,
      }),
    })
    yield* writeGithubWorkflowReportOutput({
      recordJson,
      workflowReportOutputFile: options.workflowReportOutputFile,
      githubOutputFile: options.githubOutputFile,
    })
    return
  }

  if (authTokenValue === undefined) {
    if (options.missingAuthPolicy === 'skip') {
      yield* skipWithRecord(
        `Skipping ${options.target} deploy because ${options.authTokenEnv} is not available.`,
      )
      return
    }
    return yield* failWithRecord(
      new MissingAuth({
        provider: 'netlify',
        target: options.target,
        envVar: options.authTokenEnv,
        message: `Missing ${options.authTokenEnv}`,
      }),
    )
  }

  const siteId = envValue(options.siteIdEnv)
  const resolvedSiteResult = yield* resolveNetlifySite({
    target: options.target,
    siteId,
    authToken: authTokenValue,
    apiBaseUrl: options.netlifyApiBaseUrl,
  }).pipe(Effect.result)
  if (Result.isFailure(resolvedSiteResult) === true) {
    if (
      resolvedSiteResult.failure._tag === 'Unauthorized' &&
      options.unauthorizedPolicy === 'skip'
    ) {
      yield* skipWithRecord(
        `Skipping ${options.target} deploy because the configured Netlify credentials cannot retrieve the project.`,
      )
      return
    }
    return yield* failWithRecord(resolvedSiteResult.failure)
  }
  const resolvedSite = resolvedSiteResult.success

  const siteName = options.siteName ?? resolvedSite.siteName
  const args = [
    'deploy',
    `--dir=${options.artifactDir}`,
    `--auth=${authTokenValue}`,
    '--no-build',
    ...(siteId === undefined && siteName !== undefined ? [`--site=${siteName}`] : []),
    ...(options.workspaceFilter === undefined ? [] : [`--filter=${options.workspaceFilter}`]),
    ...(alias === undefined ? [] : [`--alias=${alias}`]),
    `--message=${options.target} (${options.mode})`,
    '--json',
  ]
  const result = yield* DeployProviderOperation.with({
    attributes: {
      provider: 'netlify',
      target: input.target,
    },
    effect: runNetlifyCommand({
      netlifyBin: options.netlifyBin,
      args,
      env: siteId === undefined ? undefined : { NETLIFY_SITE_ID: siteId },
    }),
  })

  if (result.status !== 0) {
    const failure = classifyNetlifyDeployFailure({
      target: options.target,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      authToken: authTokenValue,
    })
    if (failure._tag === 'Unauthorized' && options.unauthorizedPolicy === 'skip') {
      yield* skipWithRecord(
        `Skipping ${options.target} deploy because the configured Netlify credentials cannot retrieve the project.`,
      )
      return
    }
    return yield* failWithRecord(failure)
  }

  const deployJson = yield* parseDeployJson({
    target: options.target,
    stdout: result.stdout,
    authToken: authTokenValue,
  }).pipe(Effect.catch(failWithRecord))
  const finalSiteName = siteName ?? deployJson.site_name
  const finalUrl =
    alias === undefined ? deployJson.deploy_url : `https://${alias}--${finalSiteName}.netlify.app`
  const decoded = decodeResultEither({
    _tag: 'DeployResult',
    schemaVersion: 1,
    provider: 'netlify',
    target: options.target,
    mode: options.mode,
    deployId: deployJson.deploy_id,
    rawDeployUrl: `https://${deployJson.deploy_id}--${deployJson.site_name}.netlify.app`,
    finalUrl,
    alias,
    startedAtUtc: createdAtUtc,
    endedAtUtc: isoNow(),
    attempts: 1,
    ...(input.e2e?.allowSharedProject === true
      ? {
          cleanup: {
            _tag: 'CleanupResult',
            status: 'skipped',
            message: 'Netlify alias cleanup is not implemented for shared-project live E2E',
          },
        }
      : {}),
  })

  if (Result.isFailure(decoded) === true) {
    return yield* failWithRecord(
      new InvalidProviderOutput({
        provider: 'netlify',
        target: options.target,
        outputKind: 'provider-response',
        message: 'Netlify deploy result did not match the ci-tools schema',
        diagnostics: { finalUrl },
      }),
    )
  }

  if (input.e2e?.verifyContent !== undefined) {
    yield* verifyFinalUrl({
      target: input.target,
      finalUrl: decoded.success.finalUrl,
      path: input.e2e.verifyContent.path,
      expectedText: input.e2e.verifyContent.expectedText,
    }).pipe(Effect.catch(failWithRecord))
  }

  process.stdout.write(`Netlify deploy URL: ${finalUrl}\n`)
  yield* writeDevenvTaskOutput({
    result: decoded.success,
    taskOutputFile: process.env.DEVENV_TASK_OUTPUT_FILE,
  })
  const recordJson = yield* emitWorkflowReportRecord({
    workflowReportOutputFile: options.workflowReportOutputFile,
    record: deploySuccessRecord({
      input,
      result: decoded.success,
      createdAtUtc,
    }),
  })
  yield* writeGithubDeployOutputs({
    result: decoded.success,
    recordJson,
    workflowReportOutputFile: options.workflowReportOutputFile,
    githubOutputFile: options.githubOutputFile,
    githubEnvFile: options.githubEnvFile,
    urlEnvKey: options.urlEnvKey,
  })
})
