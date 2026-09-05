import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

type ApiMode = 'ok' | 'unauthorized' | 'missing' | 'blank-site'

/* The CLI under test is a file of this package, resolved relative to this test module so the
 * path holds in a checkout and in a Buck package view alike. */
const cliPath = fileURLToPath(new URL('../bin/ci-tools.ts', import.meta.url))

/** Reads one Buck-declared immutable tool path; nothing resolves through an ambient PATH. */
const requireTool = (name: string): string => {
  const tool = process.env[name]
  if (tool === undefined || tool === '')
    throw new Error(`declared test tool is unavailable: ${name}`)
  return tool
}

const bunBin = requireTool('BUN_BIN')
const bashBin = requireTool('BASH_BIN')
let apiMode: ApiMode = 'ok'
let server: Server
let apiBaseUrl = ''

const testProcessEnv = () => {
  const { DEVENV_TASK_OUTPUT_FILE: _taskOutputFile, ...env } = process.env
  return env
}

const readRecord = (path: string) => {
  const line = readFileSync(path, 'utf8')
    .split('\n')
    .find((entry) => entry.startsWith('WORKFLOW_REPORT_V1: '))
  if (line === undefined) throw new Error(`No workflow report record in ${path}`)
  return JSON.parse(line.slice('WORKFLOW_REPORT_V1: '.length)) as {
    readonly status: string
    readonly links?: readonly { readonly url: string }[]
    readonly data?: Record<string, unknown>
  }
}

const readStreamText = (stream: NodeJS.ReadableStream) =>
  new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on('data', (chunk: Buffer | string) =>
      chunks.push(Buffer.isBuffer(chunk) === true ? chunk : Buffer.from(chunk)),
    )
    stream.on('error', reject)
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })

const runCiTools = async (opts: {
  readonly workdir: string
  readonly fakeNetlifyBin: string
  readonly reportFile: string
  readonly args: readonly string[]
  readonly env?: Readonly<Record<string, string | undefined>>
}) => {
  const child = spawn(
    bunBin,
    [
      cliPath,
      'deploy',
      'netlify',
      '--netlify-bin',
      opts.fakeNetlifyBin,
      '--netlify-api-base-url',
      apiBaseUrl,
      '--created-at-utc',
      '2026-06-29T08:00:00Z',
      '--workflow-report-output-file',
      opts.reportFile,
      ...opts.args,
    ],
    {
      cwd: opts.workdir,
      env: {
        ...testProcessEnv(),
        FORCE_COLOR: '0',
        OTEL_EXPORTER_OTLP_ENDPOINT: '',
        NETLIFY_AUTH_TOKEN: 'fake-token',
        NETLIFY_SITE_ID: 'fake-site-id',
        ...opts.env,
      },
    },
  )
  const [stdout, stderr, status] = await Promise.all([
    readStreamText(child.stdout),
    readStreamText(child.stderr),
    new Promise<number | null>((resolve, reject) => {
      child.on('error', reject)
      child.on('close', (code) => resolve(code))
    }),
  ])
  return { status, stdout, stderr }
}

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url !== '/api/v1/sites/fake-site-id') {
      response.writeHead(404, { connection: 'close' }).end('not found')
      return
    }
    if (apiMode === 'unauthorized') {
      response.writeHead(401, { connection: 'close' }).end('unauthorized')
      return
    }
    if (apiMode === 'missing') {
      response.writeHead(404, { connection: 'close' }).end('missing')
      return
    }
    if (apiMode === 'blank-site') {
      response
        .writeHead(200, { 'content-type': 'application/json', connection: 'close' })
        .end(JSON.stringify({ name: 'fake-site', account_slug: '   ' }))
      return
    }
    response
      .writeHead(200, { 'content-type': 'application/json', connection: 'close' })
      .end(JSON.stringify({ name: 'fake-site', account_slug: 'fake-account' }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected TCP server')
  apiBaseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  )
})

describe('ci-tools deploy netlify', () => {
  const makeWorkspace = () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-tools-netlify-'))
    const artifactDir = join(root, 'storybook-static')
    const binDir = join(root, 'bin')
    mkdirSync(artifactDir)
    mkdirSync(binDir)
    writeFileSync(join(artifactDir, 'index.html'), 'storybook marker')
    const logPath = join(root, 'netlify.log')
    const fakeNetlifyBin = join(binDir, 'netlify')
    writeFileSync(
      fakeNetlifyBin,
      `#!${bashBin}
set -euo pipefail
printf 'NETLIFY_SITE_ID=%s args=%s\\n' "\${NETLIFY_SITE_ID:-}" "$*" >> "${logPath}"
if [ "\${FAKE_NETLIFY_MODE:-success}" = "project-not-found" ]; then
  echo 'Project not found. Please rerun "netlify link"' >&2
  exit 9
fi
if [ "\${FAKE_NETLIFY_MODE:-success}" = "invalid-json" ]; then
  printf '{"deploy_id":null}\\n'
  exit 0
fi
printf '{"deploy_id":"deploy123","site_name":"fake-site","deploy_url":"https://deploy123--fake-site.netlify.app"}\\n'
`,
      { mode: 0o755 },
    )
    return { root, artifactDir, fakeNetlifyBin, logPath }
  }

  it('deploys PR previews with Netlify alias semantics and workflow-report output', async () => {
    apiMode = 'ok'
    const workspace = makeWorkspace()
    const reportFile = join(workspace.root, 'report.jsonl')
    const githubOutputFile = join(workspace.root, 'github-output')
    const githubEnvFile = join(workspace.root, 'github-env')
    try {
      const result = await runCiTools({
        workdir: workspace.root,
        fakeNetlifyBin: workspace.fakeNetlifyBin,
        reportFile,
        args: [
          '--target',
          'storybook',
          '--display-name',
          'Storybook',
          '--artifact-dir',
          workspace.artifactDir,
          '--mode',
          'pr',
          '--pr',
          '42',
          '--site-name',
          'fake-site',
          '--github-output-file',
          githubOutputFile,
          '--github-env-file',
          githubEnvFile,
          '--url-env-key',
          'STORYBOOK_URL',
        ],
      })
      expect(result.status).toBe(0)
      expect(result.stdout).toContain(
        'Netlify deploy URL: https://storybook-pr-42--fake-site.netlify.app',
      )
      expect(readFileSync(workspace.logPath, 'utf8')).toContain('--alias=storybook-pr-42')
      expect(readFileSync(workspace.logPath, 'utf8')).toContain('NETLIFY_SITE_ID=fake-site-id')

      const record = readRecord(reportFile)
      expect(record.status).toBe('success')
      expect(record.links?.[0]?.url).toBe('https://storybook-pr-42--fake-site.netlify.app/')
      expect(record.data).toMatchObject({
        provider: 'netlify',
        target: 'storybook',
        mode: 'pr',
        alias: 'storybook-pr-42',
        finalUrl: 'https://storybook-pr-42--fake-site.netlify.app/',
        rawDeployUrl: 'https://deploy123--fake-site.netlify.app/',
      })
      expect(readFileSync(githubOutputFile, 'utf8')).toContain(
        'final_url=https://storybook-pr-42--fake-site.netlify.app/',
      )
      expect(readFileSync(githubOutputFile, 'utf8')).toContain('workflow_report=')
      expect(readFileSync(githubEnvFile, 'utf8')).toContain(
        'STORYBOOK_URL=https://storybook-pr-42--fake-site.netlify.app/',
      )
    } finally {
      rmSync(workspace.root, { recursive: true, force: true })
    }
  })

  it('can treat missing Netlify auth as a typed skipped deploy record', async () => {
    apiMode = 'ok'
    const workspace = makeWorkspace()
    const reportFile = join(workspace.root, 'report.jsonl')
    const githubOutputFile = join(workspace.root, 'github-output')
    try {
      const result = await runCiTools({
        workdir: workspace.root,
        fakeNetlifyBin: workspace.fakeNetlifyBin,
        reportFile,
        args: [
          '--target',
          'storybook',
          '--artifact-dir',
          workspace.artifactDir,
          '--mode',
          'pr',
          '--pr',
          '42',
          '--missing-auth-policy',
          'skip',
          '--github-output-file',
          githubOutputFile,
        ],
        env: { NETLIFY_AUTH_TOKEN: undefined },
      })
      expect(result.status).toBe(0)
      const record = readRecord(reportFile)
      expect(record.status).toBe('skipped')
      expect(record.data).toMatchObject({ provider: 'netlify', target: 'storybook', mode: 'pr' })
      expect(readFileSync(githubOutputFile, 'utf8')).toContain('workflow_report=')
      expect(existsSync(workspace.logPath)).toBe(false)
    } finally {
      rmSync(workspace.root, { recursive: true, force: true })
    }
  })

  it('classifies known Netlify project lookup failures without leaking tokens', async () => {
    apiMode = 'ok'
    const workspace = makeWorkspace()
    const reportFile = join(workspace.root, 'report.jsonl')
    try {
      const result = await runCiTools({
        workdir: workspace.root,
        fakeNetlifyBin: workspace.fakeNetlifyBin,
        reportFile,
        args: [
          '--target',
          'storybook',
          '--artifact-dir',
          workspace.artifactDir,
          '--mode',
          'prod',
          '--site-name',
          'fake-site',
        ],
        env: { FAKE_NETLIFY_MODE: 'project-not-found' },
      })
      expect(result.status).not.toBe(0)
      expect(`${result.stdout}\n${result.stderr}`).not.toContain('fake-token')

      const record = readRecord(reportFile)
      expect(record.status).toBe('failure')
      expect(record.data).toMatchObject({
        errorKind: 'ProviderProjectLookupFailed',
        retryable: false,
      })
      expect(JSON.stringify(record)).not.toContain('fake-token')
    } finally {
      rmSync(workspace.root, { recursive: true, force: true })
    }
  })

  it('emits failure records for malformed Netlify deploy JSON', async () => {
    apiMode = 'ok'
    const workspace = makeWorkspace()
    const reportFile = join(workspace.root, 'report.jsonl')
    try {
      const result = await runCiTools({
        workdir: workspace.root,
        fakeNetlifyBin: workspace.fakeNetlifyBin,
        reportFile,
        args: [
          '--target',
          'storybook',
          '--artifact-dir',
          workspace.artifactDir,
          '--mode',
          'prod',
          '--site-name',
          'fake-site',
        ],
        env: { FAKE_NETLIFY_MODE: 'invalid-json' },
      })
      expect(result.status).not.toBe(0)

      const record = readRecord(reportFile)
      expect(record.status).toBe('failure')
      expect(record.data).toMatchObject({
        errorKind: 'InvalidProviderOutput',
        retryable: false,
      })
    } finally {
      rmSync(workspace.root, { recursive: true, force: true })
    }
  })

  it('fails when Netlify site lookup returns a whitespace-only account slug', async () => {
    apiMode = 'blank-site'
    const workspace = makeWorkspace()
    const reportFile = join(workspace.root, 'report.jsonl')
    try {
      const result = await runCiTools({
        workdir: workspace.root,
        fakeNetlifyBin: workspace.fakeNetlifyBin,
        reportFile,
        args: [
          '--target',
          'storybook',
          '--artifact-dir',
          workspace.artifactDir,
          '--mode',
          'prod',
          '--site-name',
          'fake-site',
        ],
      })
      expect(result.status).not.toBe(0)

      const record = readRecord(reportFile)
      expect(record.status).toBe('failure')
      expect(record.data).toMatchObject({
        errorKind: 'ProviderProjectLookupFailed',
        retryable: false,
      })
    } finally {
      apiMode = 'ok'
      rmSync(workspace.root, { recursive: true, force: true })
    }
  })

  it('emits skipped records for missing local static output', async () => {
    apiMode = 'ok'
    const workspace = makeWorkspace()
    const reportFile = join(workspace.root, 'report.jsonl')
    const missingDir = join(workspace.root, 'missing')
    try {
      const result = await runCiTools({
        workdir: workspace.root,
        fakeNetlifyBin: workspace.fakeNetlifyBin,
        reportFile,
        args: ['--target', 'storybook', '--artifact-dir', missingDir, '--mode', 'draft'],
      })
      expect(result.status).toBe(0)
      expect(readRecord(reportFile).status).toBe('skipped')
    } finally {
      rmSync(workspace.root, { recursive: true, force: true })
    }
  })

  it('emits failure records when the Netlify CLI cannot start', async () => {
    apiMode = 'ok'
    const workspace = makeWorkspace()
    const reportFile = join(workspace.root, 'report.jsonl')
    try {
      const result = await runCiTools({
        workdir: workspace.root,
        fakeNetlifyBin: join(workspace.root, 'bin', 'missing-netlify'),
        reportFile,
        args: [
          '--target',
          'storybook',
          '--artifact-dir',
          workspace.artifactDir,
          '--mode',
          'prod',
          '--site-name',
          'fake-site',
        ],
      })
      expect(result.status).not.toBe(0)
      expect(readRecord(reportFile).data).toMatchObject({
        errorKind: 'ProviderOperationFailed',
        retryable: false,
      })
    } finally {
      rmSync(workspace.root, { recursive: true, force: true })
    }
  })

  it('refuses shared-project live E2E aliases outside the reserved prefix', async () => {
    apiMode = 'ok'
    const workspace = makeWorkspace()
    const reportFile = join(workspace.root, 'report.jsonl')
    try {
      const result = await runCiTools({
        workdir: workspace.root,
        fakeNetlifyBin: workspace.fakeNetlifyBin,
        reportFile,
        args: [
          '--target',
          'storybook',
          '--artifact-dir',
          workspace.artifactDir,
          '--mode',
          'pr',
          '--pr',
          '42',
          '--e2e-allow-shared-project',
          '--e2e-reserved-alias-prefix',
          'ci-tools-e2e',
        ],
      })
      expect(result.status).not.toBe(0)
      expect(readRecord(reportFile).data).toMatchObject({ errorKind: 'UnsafeE2EAlias' })
    } finally {
      rmSync(workspace.root, { recursive: true, force: true })
    }
  })

  it('fails before upload when API-first site lookup rejects credentials', async () => {
    apiMode = 'unauthorized'
    const workspace = makeWorkspace()
    const reportFile = join(workspace.root, 'report.jsonl')
    try {
      const result = await runCiTools({
        workdir: workspace.root,
        fakeNetlifyBin: workspace.fakeNetlifyBin,
        reportFile,
        args: ['--target', 'storybook', '--artifact-dir', workspace.artifactDir, '--mode', 'draft'],
      })
      expect(result.status).not.toBe(0)
      expect(readRecord(reportFile).data).toMatchObject({ errorKind: 'Unauthorized' })
      expect(existsSync(workspace.logPath)).toBe(false)
    } finally {
      apiMode = 'ok'
      rmSync(workspace.root, { recursive: true, force: true })
    }
  })

  it('emits a skipped record when preview credentials cannot retrieve the project', async () => {
    apiMode = 'unauthorized'
    const workspace = makeWorkspace()
    const reportFile = join(workspace.root, 'report.jsonl')
    try {
      const result = await runCiTools({
        workdir: workspace.root,
        fakeNetlifyBin: workspace.fakeNetlifyBin,
        reportFile,
        args: [
          '--target',
          'storybook',
          '--artifact-dir',
          workspace.artifactDir,
          '--mode',
          'pr',
          '--pr',
          '42',
          '--unauthorized-policy',
          'skip',
        ],
      })
      expect(result.status).toBe(0)
      expect(readRecord(reportFile)).toMatchObject({
        status: 'skipped',
        summary: expect.stringContaining('cannot retrieve the project'),
      })
      expect(existsSync(workspace.logPath)).toBe(false)
    } finally {
      apiMode = 'ok'
      rmSync(workspace.root, { recursive: true, force: true })
    }
  })
})
