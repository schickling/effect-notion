import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  decodeWorkflowReportBundleJson,
  extractWorkflowReportManagedState,
  workflowReportRecordLineMarker,
  type WorkflowReportRecord,
} from './mod.ts'

/* The CLI under test and its working directory are this package, resolved relative to this test
 * module so both hold in a checkout and in a Buck package view alike. */
const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const workflowReportBin = fileURLToPath(new URL('../bin/ci-tools.ts', import.meta.url))

/** Reads one Buck-declared immutable tool path; nothing resolves through an ambient PATH. */
const requireTool = (name: string): string => {
  const tool = process.env[name]
  if (tool === undefined || tool === '')
    throw new Error(`declared test tool is unavailable: ${name}`)
  return tool
}

const bunBin = requireTool('BUN_BIN')

const runWorkflowReport = (args: readonly string[]) => {
  const result = spawnSync(bunBin, [workflowReportBin, 'workflow-report', ...args], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      OTEL_EXPORTER_OTLP_ENDPOINT: '',
    },
  })

  if (result.status !== 0) {
    throw new Error(
      [
        `workflow-report exited with ${result.status}`,
        `stdout:\n${result.stdout}`,
        `stderr:\n${result.stderr}`,
      ].join('\n\n'),
    )
  }

  return result
}

const sampleRecord: WorkflowReportRecord = {
  _tag: 'WorkflowReportRecord',
  schemaVersion: 1,
  id: 'deploy-e2e',
  kind: 'deploy-preview',
  subject: { id: 'e2e', label: 'E2E Fixture' },
  status: 'success',
  title: 'E2E fixture deployed',
  summary: 'Preview is ready',
  createdAtUtc: '2026-06-29T08:00:00Z',
  links: [{ label: 'Preview', url: 'https://example.test.invalid/preview', primary: true }],
  data: { provider: 'fake-provider', target: 'e2e' },
}

describe('workflow-report CLI E2E', () => {
  it('treats an absent optional producer output as a missing input', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'workflow-report-missing-input-e2e-'))
    const bundlePath = join(workspace, 'bundle.json')

    runWorkflowReport([
      'collect-bundle',
      '--bundle-id',
      'deploy-preview',
      '--input-paths-json',
      JSON.stringify(['']),
      '--output-path',
      bundlePath,
      '--allow-missing-input',
    ])

    expect(decodeWorkflowReportBundleJson(readFileSync(bundlePath, 'utf8'))).toMatchObject({
      _tag: 'WorkflowReportBundle',
      bundleId: 'deploy-preview',
      records: [],
    })
  })

  it('collects marked records, renders managed comments, and locates prior comments', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'workflow-report-e2e-'))
    const inputPath = join(workspace, 'deploy.log')
    const bundlePath = join(workspace, 'bundle.json')
    const commentsPath = join(workspace, 'comments.json')
    const commentBodyPath = join(workspace, 'comment.md')
    const summaryPath = join(workspace, 'summary.md')
    const commentIdPath = join(workspace, 'comment-id.txt')

    writeFileSync(
      inputPath,
      [
        'unstructured deploy output',
        `${workflowReportRecordLineMarker}${JSON.stringify(sampleRecord)}`,
        'more provider output',
      ].join('\n'),
    )
    writeFileSync(commentsPath, '[]')

    runWorkflowReport([
      'collect-bundle',
      '--bundle-id',
      'deploy-preview',
      '--input-paths-json',
      JSON.stringify([inputPath]),
      '--output-path',
      bundlePath,
    ])

    const bundle = decodeWorkflowReportBundleJson(readFileSync(bundlePath, 'utf8'))
    expect(bundle).toMatchObject({
      _tag: 'WorkflowReportBundle',
      bundleId: 'deploy-preview',
      records: [sampleRecord],
    })

    runWorkflowReport([
      'render-comment-body',
      '--bundle-path',
      bundlePath,
      '--comments-path',
      commentsPath,
      '--comment-body-path',
      commentBodyPath,
      '--summary-path',
      summaryPath,
      '--title',
      'Deploy Preview',
      '--no-records-message',
      'No deploy records.',
      '--state-id',
      'deploy-preview',
      '--entry-id',
      'commit-1267a499',
      '--entry-label',
      'Commit 1267a499',
    ])

    const commentBody = readFileSync(commentBodyPath, 'utf8')
    expect(commentBody).toContain('Deploy Preview')
    expect(commentBody).toContain('E2E fixture deployed')

    const summary = readFileSync(summaryPath, 'utf8')
    expect(summary).toContain('E2E fixture deployed')
    expect(summary).not.toContain('workflow-report:state')

    const state = extractWorkflowReportManagedState(commentBody, { stateId: 'deploy-preview' })
    expect(state?.entries[0]?.records).toEqual([sampleRecord])

    writeFileSync(commentsPath, JSON.stringify([{ id: 42, body: commentBody }]))
    runWorkflowReport([
      'find-comment',
      '--comments-path',
      commentsPath,
      '--comment-body-path',
      commentBodyPath,
      '--comment-id-path',
      commentIdPath,
      '--state-id',
      'deploy-preview',
    ])

    expect(readFileSync(commentIdPath, 'utf8')).toBe('42')
  })
})
