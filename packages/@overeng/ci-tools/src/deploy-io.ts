/* oxlint-disable overeng/jsdoc-require-exports -- Provider commands share the GitHub Actions/devenv IO boundary here. */

import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'

import { Effect, Schema } from 'effect'

import { type DeployResultV1, deployTaskOutputLine } from './deploy-domain.ts'
import { workflowReportRecordLineMarker, type WorkflowReportRecord } from './workflow-report.ts'

const appendLine = (opts: { readonly path: string; readonly line: string }) =>
  appendFileSync(opts.path, `${opts.line}\n`)

const appendGithubOutput = (opts: {
  readonly path: string
  readonly name: string
  readonly value: string
}) => {
  if (opts.value.includes('\n') === false && opts.value.includes('\r') === false) {
    appendLine({ path: opts.path, line: `${opts.name}=${opts.value}` })
    return
  }

  const delimiter = `ci_tools_${randomUUID().replaceAll('-', '_')}`
  appendFileSync(opts.path, `${opts.name}<<${delimiter}\n${opts.value}\n${delimiter}\n`)
}

export const encodeWorkflowReportRecord = Effect.fn('ci-tools.deploy.io.encode-record')(
  (record: WorkflowReportRecord) =>
    Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(record),
)

export const emitWorkflowReportRecord = Effect.fn('ci-tools.deploy.io.emit-record')(
  function* (opts: {
    readonly record: WorkflowReportRecord
    readonly workflowReportOutputFile: string | undefined
  }) {
    const encodedRecord = yield* encodeWorkflowReportRecord(opts.record)
    yield* Effect.sync(() => {
      const line = `${workflowReportRecordLineMarker}${encodedRecord}`
      process.stdout.write(`${line}\n`)
      if (opts.workflowReportOutputFile !== undefined) {
        appendLine({ path: opts.workflowReportOutputFile, line })
      }
    })
    return encodedRecord
  },
)

export const writeDevenvTaskOutput = Effect.fn('ci-tools.deploy.io.write-devenv-output')(
  (opts: { readonly result: DeployResultV1; readonly taskOutputFile: string | undefined }) =>
    Effect.sync(() => {
      if (opts.taskOutputFile !== undefined) {
        appendLine({
          path: opts.taskOutputFile,
          line: deployTaskOutputLine({ result: opts.result }),
        })
      }
    }),
)

export const writeGithubDeployOutputs = Effect.fn('ci-tools.deploy.io.write-github-outputs')(
  function* (opts: {
    readonly result: DeployResultV1
    readonly recordJson: string
    readonly workflowReportOutputFile: string | undefined
    readonly githubOutputFile: string | undefined
    readonly githubEnvFile: string | undefined
    readonly urlEnvKey: string | undefined
  }) {
    const finalUrl = opts.result.finalUrl.toString()
    const rawDeployUrl = opts.result.rawDeployUrl.toString()
    const deployedAtUtc = yield* Schema.encodeEffect(Schema.DateTimeUtcFromString)(
      opts.result.endedAtUtc,
    )

    yield* Effect.sync(() => {
      if (opts.githubOutputFile !== undefined) {
        appendGithubOutput({ path: opts.githubOutputFile, name: 'final_url', value: finalUrl })
        appendGithubOutput({ path: opts.githubOutputFile, name: 'deploy_url', value: finalUrl })
        appendGithubOutput({
          path: opts.githubOutputFile,
          name: 'raw_deploy_url',
          value: rawDeployUrl,
        })
        appendGithubOutput({
          path: opts.githubOutputFile,
          name: 'deployed_at_utc',
          value: deployedAtUtc,
        })
        appendGithubOutput({
          path: opts.githubOutputFile,
          name: 'workflow_report',
          value: opts.recordJson,
        })
        if (opts.workflowReportOutputFile !== undefined) {
          appendGithubOutput({
            path: opts.githubOutputFile,
            name: 'workflow_report_path',
            value: opts.workflowReportOutputFile,
          })
        }
      }

      if (opts.githubEnvFile !== undefined && opts.urlEnvKey !== undefined) {
        appendLine({ path: opts.githubEnvFile, line: `${opts.urlEnvKey}=${finalUrl}` })
      }
    })
  },
)

export const writeGithubWorkflowReportOutput = Effect.fn(
  'ci-tools.deploy.io.write-github-report-output',
)(
  (opts: {
    readonly recordJson: string
    readonly workflowReportOutputFile: string | undefined
    readonly githubOutputFile: string | undefined
  }) =>
    Effect.sync(() => {
      if (opts.githubOutputFile !== undefined) {
        appendGithubOutput({
          path: opts.githubOutputFile,
          name: 'workflow_report',
          value: opts.recordJson,
        })
        if (opts.workflowReportOutputFile !== undefined) {
          appendGithubOutput({
            path: opts.githubOutputFile,
            name: 'workflow_report_path',
            value: opts.workflowReportOutputFile,
          })
        }
      }
    }),
)
