import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

type ApiMode = 'ok' | 'unauthorized' | 'missing' | 'blank-project'
type AliasApiMode = 'ok' | 'transient-error' | 'transport-error'

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
let aliasApiMode: AliasApiMode = 'ok'
let server: Server
let apiBaseUrl = ''
let deploymentCommitShas: Record<string, string> = {}
let aliasHolder: { readonly deploymentId: string; readonly projectId?: string } | undefined

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
    readonly summary?: string
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
  readonly fakeVercelBin: string
  readonly reportFile: string
  readonly args: readonly string[]
  readonly env?: Readonly<Record<string, string | undefined>>
}) => {
  const child = spawn(
    bunBin,
    [
      cliPath,
      'deploy',
      'vercel',
      '--vercel-bin',
      opts.fakeVercelBin,
      '--vercel-api-base-url',
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
        VERCEL_TOKEN: 'fake-token',
        VERCEL_ORG_ID: 'fake-org',
        VERCEL_PROJECT_ID: 'fake-project',
        VERCEL_SCOPE: 'fake-scope',
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
    if (request.url?.startsWith('/v13/deployments/') === true) {
      const url = new URL(request.url, 'http://localhost')
      if (url.searchParams.get('teamId') !== 'fake-org') {
        response.writeHead(400, { connection: 'close' }).end('missing team scope')
        return
      }
      const ref = decodeURIComponent(url.pathname.slice('/v13/deployments/'.length))
      const commitSha = deploymentCommitShas[ref]
      if (commitSha === 'transport-error') {
        request.socket.destroy()
        return
      }
      if (commitSha === undefined) {
        response.writeHead(404, { connection: 'close' }).end('not found')
        return
      }
      response
        .writeHead(200, { 'content-type': 'application/json', connection: 'close' })
        .end(JSON.stringify({ meta: { githubCommitSha: commitSha } }))
      return
    }
    if (request.url?.startsWith('/v4/aliases/') === true) {
      const url = new URL(request.url, 'http://localhost')
      if (url.searchParams.get('teamId') !== 'fake-org') {
        response.writeHead(400, { connection: 'close' }).end('missing team scope')
        return
      }
      if (aliasApiMode === 'transient-error') {
        response.writeHead(503, { connection: 'close' }).end('temporarily unavailable')
        return
      }
      if (aliasApiMode === 'transport-error') {
        request.socket.destroy()
        return
      }
      if (aliasHolder === undefined) {
        response.writeHead(404, { connection: 'close' }).end('not found')
        return
      }
      response
        .writeHead(200, { 'content-type': 'application/json', connection: 'close' })
        .end(JSON.stringify(aliasHolder))
      return
    }
    if (request.url !== '/v9/projects/fake-project?teamId=fake-org') {
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
    if (apiMode === 'blank-project') {
      response
        .writeHead(200, { 'content-type': 'application/json', connection: 'close' })
        .end(JSON.stringify({ id: '   ', name: '   ' }))
      return
    }
    response
      .writeHead(200, { 'content-type': 'application/json', connection: 'close' })
      .end(JSON.stringify({ id: 'fake-project', name: 'fake-vercel-project' }))
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

describe('ci-tools deploy vercel', () => {
  const makeWorkspace = () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-tools-vercel-'))
    const artifactDir = join(root, 'static')
    const binDir = join(root, 'bin')
    mkdirSync(artifactDir)
    mkdirSync(binDir)
    mkdirSync(join(root, 'app'))
    writeFileSync(join(artifactDir, 'index.html'), 'vercel static marker')
    writeFileSync(join(artifactDir, '.well-known'), 'dotfile marker')
    writeFileSync(join(root, 'app', 'package.json'), '{"name":"fixture-app"}\n')
    const logPath = join(root, 'vercel.log')
    const fakeVercelBin = join(binDir, 'vercel')
    writeFileSync(
      fakeVercelBin,
      `#!${bashBin}
set -euo pipefail
printf 'cwd=%s VERCEL_PROJECT_ID=%s VERCEL_ORG_ID=%s args=%s\\n' "$PWD" "\${VERCEL_PROJECT_ID:-}" "\${VERCEL_ORG_ID:-}" "$*" >> "${logPath}"
if [ "\${1:-}" = "pull" ]; then
  mkdir -p .vercel
  printf '{"settings":{}}\\n' > .vercel/project.json
  exit 0
fi
if [ "\${1:-}" = "build" ]; then
  test -f app/vercel.json
  case "$(<app/vercel.json)" in *'"installCommand":"true"'*) ;; *) exit 1 ;; esac
  case "$(<.vercel/project.json)" in *'"rootDirectory":"app"'*) ;; *) exit 1 ;; esac
  test "\${BUILD_MARKER:-}" = "ci-tools"
  if [ "\${FAKE_VERCEL_LARGE_BUILD_OUTPUT:-0}" = "1" ]; then
    printf '%1200000s\\n' '' | tr ' ' x
  fi
  mkdir -p .vercel/output/static
  printf '{"version":3}\\n' > .vercel/output/config.json
  printf 'built marker\\n' > .vercel/output/static/index.html
  exit 0
fi
if [ "\${1:-}" = "deploy" ]; then
  test -f .vercel/output/static/index.html
  if [ -n "\${FAKE_VERCEL_REQUIRE_WORKSPACE_FILE:-}" ]; then
    test -f "\${FAKE_VERCEL_REQUIRE_WORKSPACE_FILE}"
  fi
  if [ "\${FAKE_VERCEL_REQUIRE_DOTFILE:-1}" = "1" ]; then
    test -f .vercel/output/static/.well-known
  fi
  if [ "\${FAKE_VERCEL_MODE:-success}" = "no-url" ]; then
    printf 'Deployment completed without URL\\n'
    exit 0
  fi
  if [ "\${FAKE_VERCEL_MODE:-success}" = "unauthorized" ]; then
    echo 'Error: invalid token fake-token' >&2
    exit 1
  fi
  printf 'https://deploy-web.vercel.app\\n'
  exit 0
fi
if [ "\${1:-}" = "alias" ] && [ "\${2:-}" = "rm" ]; then
  printf 'Removed alias %s\\n' "\${3:-}"
  exit 0
fi
if [ "\${1:-}" = "alias" ]; then
  printf 'Aliased %s to %s\\n' "\${2:-}" "\${3:-}"
  exit 0
fi
echo "unexpected fake vercel invocation: $*" >&2
exit 1
`,
      { mode: 0o755 },
    )
    return { root, artifactDir, fakeVercelBin, logPath }
  }

  it('deploys PR previews with Vercel prebuilt packaging, alias semantics, and records', async () => {
    apiMode = 'ok'
    const workspace = makeWorkspace()
    const reportFile = join(workspace.root, 'report.jsonl')
    const githubOutputFile = join(workspace.root, 'github-output')
    const githubEnvFile = join(workspace.root, 'github-env')
    try {
      const result = await runCiTools({
        workdir: workspace.root,
        fakeVercelBin: workspace.fakeVercelBin,
        reportFile,
        args: [
          '--target',
          'web',
          '--display-name',
          'Web',
          '--artifact-dir',
          workspace.artifactDir,
          '--mode',
          'pr',
          '--pr',
          '123',
          '--alias-suffix',
          'team',
          '--scope-env',
          'VERCEL_SCOPE',
          '--github-output-file',
          githubOutputFile,
          '--github-env-file',
          githubEnvFile,
          '--url-env-key',
          'WEB_URL',
        ],
      })
      if (result.status !== 0) {
        console.error({ stdout: result.stdout, stderr: result.stderr })
      }
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('Vercel deploy URL: https://web-pr-123-team.vercel.app')
      const log = readFileSync(workspace.logPath, 'utf8')
      expect(log).toContain('args=deploy --prebuilt --yes --scope fake-scope --token fake-token')
      expect(log).toContain(
        'args=alias https://deploy-web.vercel.app web-pr-123-team.vercel.app --scope fake-scope',
      )
      expect(log).toContain('VERCEL_PROJECT_ID=fake-project')

      const record = readRecord(reportFile)
      expect(record.status).toBe('success')
      expect(record.links?.[0]?.url).toBe('https://web-pr-123-team.vercel.app/')
      expect(record.data).toMatchObject({
        provider: 'vercel',
        target: 'web',
        mode: 'pr',
        alias: 'web-pr-123-team',
        finalUrl: 'https://web-pr-123-team.vercel.app/',
        rawDeployUrl: 'https://deploy-web.vercel.app/',
      })
      expect(readFileSync(githubOutputFile, 'utf8')).toContain(
        'final_url=https://web-pr-123-team.vercel.app/',
      )
      expect(readFileSync(githubOutputFile, 'utf8')).toContain('workflow_report=')
      expect(readFileSync(githubEnvFile, 'utf8')).toContain(
        'WEB_URL=https://web-pr-123-team.vercel.app/',
      )
    } finally {
      rmSync(workspace.root, { recursive: true, force: true })
    }
  })

  it('runs Vercel pull/build for build-mode prebuilt output before deploy', async () => {
    apiMode = 'ok'
    const workspace = makeWorkspace()
    const reportFile = join(workspace.root, 'report.jsonl')
    try {
      const result = await runCiTools({
        workdir: workspace.root,
        fakeVercelBin: workspace.fakeVercelBin,
        reportFile,
        args: [
          '--target',
          'app',
          '--artifact-dir',
          join(workspace.root, '.vercel', 'output'),
          '--artifact-kind',
          'prebuilt-output',
          '--mode',
          'prod',
          '--production-domain',
          'app.example.com',
          '--build-prebuilt-output',
          '--vercel-root-directory',
          'app',
          '--build-env',
          'BUILD_MARKER=ci-tools',
          '--scope-env',
          'VERCEL_SCOPE',
        ],
        env: { FAKE_VERCEL_REQUIRE_DOTFILE: '0' },
      })
      if (result.status !== 0) {
        console.error({ stdout: result.stdout, stderr: result.stderr })
      }
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('Pulling Vercel project settings and env for app')
      expect(result.stdout).toContain('Building app locally with vercel build')
      const log = readFileSync(workspace.logPath, 'utf8')
      expect(log).toContain(
        'args=pull --yes --environment production --scope fake-scope --token fake-token',
      )
      expect(log).toContain('args=build --yes --prod --scope fake-scope --token fake-token')
      expect(log).toContain(
        'args=deploy --prebuilt --yes --prod --scope fake-scope --token fake-token',
      )
      expect(log).toContain(
        'args=alias https://deploy-web.vercel.app app.example.com --scope fake-scope',
      )
      expect(log).toContain(`cwd=${realpathSync(workspace.root)} VERCEL_PROJECT_ID=fake-project`)
      expect(existsSync(join(workspace.root, 'app', 'vercel.json'))).toBe(false)
      expect(existsSync(join(workspace.root, '.vercel'))).toBe(false)
      expect(readRecord(reportFile).data).toMatchObject({
        provider: 'vercel',
        target: 'app',
        mode: 'prod',
        finalUrl: 'https://app.example.com/',
        productionDomains: ['app.example.com'],
      })
    } finally {
      rmSync(workspace.root, { recursive: true, force: true })
    }
  })

  it('keeps workspace-relative files available for locally built prebuilt deploys', async () => {
    apiMode = 'ok'
    const workspace = makeWorkspace()
    const reportFile = join(workspace.root, 'report.jsonl')
    const workspaceFile = join(
      workspace.root,
      'app',
      '.next',
      'server',
      'edge-chunks',
      'chunk.wasm',
    )
    try {
      mkdirSync(join(workspace.root, 'app', '.next', 'server', 'edge-chunks'), { recursive: true })
      writeFileSync(workspaceFile, 'wasm marker')
      const result = await runCiTools({
        workdir: workspace.root,
        fakeVercelBin: workspace.fakeVercelBin,
        reportFile,
        args: [
          '--target',
          'app',
          '--artifact-dir',
          join(workspace.root, '.vercel', 'output'),
          '--artifact-kind',
          'prebuilt-output',
          '--mode',
          'prod',
          '--build-prebuilt-output',
          '--vercel-root-directory',
          'app',
          '--build-env',
          'BUILD_MARKER=ci-tools',
          '--scope-env',
          'VERCEL_SCOPE',
        ],
        env: {
          FAKE_VERCEL_REQUIRE_DOTFILE: '0',
          FAKE_VERCEL_REQUIRE_WORKSPACE_FILE: 'app/.next/server/edge-chunks/chunk.wasm',
        },
      })
      if (result.status !== 0) {
        console.error({ stdout: result.stdout, stderr: result.stderr })
      }
      expect(result.status).toBe(0)
      const log = readFileSync(workspace.logPath, 'utf8')
      expect(log).toContain(`cwd=${realpathSync(workspace.root)} VERCEL_PROJECT_ID=fake-project`)
      expect(existsSync(join(workspace.root, '.vercel'))).toBe(false)
    } finally {
      rmSync(workspace.root, { recursive: true, force: true })
    }
  })

  it('captures verbose Vercel build output without hitting Node spawnSync defaults', async () => {
    apiMode = 'ok'
    const workspace = makeWorkspace()
    const reportFile = join(workspace.root, 'report.jsonl')
    try {
      const result = await runCiTools({
        workdir: workspace.root,
        fakeVercelBin: workspace.fakeVercelBin,
        reportFile,
        args: [
          '--target',
          'app',
          '--artifact-dir',
          join(workspace.root, '.vercel', 'output'),
          '--artifact-kind',
          'prebuilt-output',
          '--mode',
          'prod',
          '--build-prebuilt-output',
          '--vercel-root-directory',
          'app',
          '--build-env',
          'BUILD_MARKER=ci-tools',
          '--scope-env',
          'VERCEL_SCOPE',
        ],
        env: { FAKE_VERCEL_LARGE_BUILD_OUTPUT: '1', FAKE_VERCEL_REQUIRE_DOTFILE: '0' },
      })
      if (result.status !== 0) {
        console.error({ stdout: result.stdout, stderr: result.stderr })
      }
      expect(result.status).toBe(0)
      expect(readRecord(reportFile).status).toBe('success')
    } finally {
      rmSync(workspace.root, { recursive: true, force: true })
    }
  })

  it('rejects build-mode orchestration for static artifacts', async () => {
    apiMode = 'ok'
    const workspace = makeWorkspace()
    const reportFile = join(workspace.root, 'report.jsonl')
    try {
      const result = await runCiTools({
        workdir: workspace.root,
        fakeVercelBin: workspace.fakeVercelBin,
        reportFile,
        args: [
          '--target',
          'web',
          '--artifact-dir',
          workspace.artifactDir,
          '--artifact-kind',
          'static',
          '--mode',
          'preview',
          '--build-prebuilt-output',
        ],
      })
      expect(result.status).not.toBe(0)
      expect(existsSync(workspace.logPath)).toBe(false)
      expect(readRecord(reportFile).data).toMatchObject({
        errorKind: 'ProviderOperationFailed',
        retryable: false,
      })
    } finally {
      rmSync(workspace.root, { recursive: true, force: true })
    }
  })

  it('emits failure records when Vercel output does not contain a deploy URL', async () => {
    apiMode = 'ok'
    const workspace = makeWorkspace()
    const reportFile = join(workspace.root, 'report.jsonl')
    try {
      const result = await runCiTools({
        workdir: workspace.root,
        fakeVercelBin: workspace.fakeVercelBin,
        reportFile,
        args: ['--target', 'web', '--artifact-dir', workspace.artifactDir, '--mode', 'preview'],
        env: { FAKE_VERCEL_MODE: 'no-url' },
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

  it('emits failure records for missing local static output before upload', async () => {
    apiMode = 'ok'
    const workspace = makeWorkspace()
    const reportFile = join(workspace.root, 'report.jsonl')
    try {
      const result = await runCiTools({
        workdir: workspace.root,
        fakeVercelBin: workspace.fakeVercelBin,
        reportFile,
        args: [
          '--target',
          'web',
          '--artifact-dir',
          join(workspace.root, 'missing'),
          '--mode',
          'preview',
        ],
      })
      expect(result.status).not.toBe(0)
      expect(existsSync(workspace.logPath)).toBe(false)
      expect(readRecord(reportFile).data).toMatchObject({ errorKind: 'MissingBuildOutput' })
    } finally {
      rmSync(workspace.root, { recursive: true, force: true })
    }
  })

  it('emits missing-auth records before local output checks', async () => {
    apiMode = 'ok'
    const workspace = makeWorkspace()
    const reportFile = join(workspace.root, 'report.jsonl')
    try {
      const result = await runCiTools({
        workdir: workspace.root,
        fakeVercelBin: workspace.fakeVercelBin,
        reportFile,
        args: [
          '--target',
          'web',
          '--artifact-dir',
          join(workspace.root, 'missing'),
          '--mode',
          'preview',
        ],
        env: { VERCEL_TOKEN: undefined },
      })
      expect(result.status).not.toBe(0)
      expect(existsSync(workspace.logPath)).toBe(false)
      expect(readRecord(reportFile).data).toMatchObject({ errorKind: 'MissingAuth' })
    } finally {
      rmSync(workspace.root, { recursive: true, force: true })
    }
  })

  it('fails before upload when API-first project lookup rejects credentials', async () => {
    apiMode = 'unauthorized'
    const workspace = makeWorkspace()
    const reportFile = join(workspace.root, 'report.jsonl')
    try {
      const result = await runCiTools({
        workdir: workspace.root,
        fakeVercelBin: workspace.fakeVercelBin,
        reportFile,
        args: ['--target', 'web', '--artifact-dir', workspace.artifactDir, '--mode', 'preview'],
      })
      expect(result.status).not.toBe(0)
      expect(readRecord(reportFile).data).toMatchObject({ errorKind: 'Unauthorized' })
      expect(existsSync(workspace.logPath)).toBe(false)
    } finally {
      apiMode = 'ok'
      rmSync(workspace.root, { recursive: true, force: true })
    }
  })

  it('fails before upload when API-first project lookup returns whitespace-only identity', async () => {
    apiMode = 'blank-project'
    const workspace = makeWorkspace()
    const reportFile = join(workspace.root, 'report.jsonl')
    try {
      const result = await runCiTools({
        workdir: workspace.root,
        fakeVercelBin: workspace.fakeVercelBin,
        reportFile,
        args: ['--target', 'web', '--artifact-dir', workspace.artifactDir, '--mode', 'preview'],
      })
      expect(result.status).not.toBe(0)
      expect(readRecord(reportFile).data).toMatchObject({
        errorKind: 'ProviderProjectLookupFailed',
      })
      expect(existsSync(workspace.logPath)).toBe(false)
    } finally {
      apiMode = 'ok'
      rmSync(workspace.root, { recursive: true, force: true })
    }
  })

  it('redacts Vercel tokens from provider command failures', async () => {
    apiMode = 'ok'
    const workspace = makeWorkspace()
    const reportFile = join(workspace.root, 'report.jsonl')
    try {
      const result = await runCiTools({
        workdir: workspace.root,
        fakeVercelBin: workspace.fakeVercelBin,
        reportFile,
        args: ['--target', 'web', '--artifact-dir', workspace.artifactDir, '--mode', 'preview'],
        env: { FAKE_VERCEL_MODE: 'unauthorized' },
      })
      expect(result.status).not.toBe(0)
      expect(`${result.stdout}\n${result.stderr}`).not.toContain('fake-token')
      expect(JSON.stringify(readRecord(reportFile))).not.toContain('fake-token')
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
        fakeVercelBin: workspace.fakeVercelBin,
        reportFile,
        args: [
          '--target',
          'web',
          '--artifact-dir',
          workspace.artifactDir,
          '--mode',
          'pr',
          '--pr',
          '123',
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
})

describe('ci-tools deploy vercel alias collisions', () => {
  type CollisionWorkspace = {
    readonly root: string
    readonly artifactDir: string
    readonly fakeVercelBin: string
    readonly logPath: string
  }

  const makeCollisionWorkspace = () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-tools-vercel-alias-'))
    const artifactDir = join(root, 'static')
    const binDir = join(root, 'bin')
    mkdirSync(artifactDir)
    mkdirSync(binDir)
    writeFileSync(join(artifactDir, 'index.html'), 'vercel static marker')
    const logPath = join(root, 'vercel.log')
    const fakeVercelBin = join(binDir, 'vercel')
    writeFileSync(
      fakeVercelBin,
      `#!${bashBin}
set -euo pipefail
printf 'cwd=%s args=%s\\n' "$PWD" "$*" >> "${logPath}"
if [ "\${1:-}" = "deploy" ]; then
  printf 'https://deploy-web.vercel.app\\n'
  exit 0
fi
if [ "\${1:-}" = "alias" ]; then
  case "\${FAKE_VERCEL_ALIAS_MODE:-permanent}" in
    same-commit)
      echo 'Error: The chosen alias "ptg.vercel.app" is already in use.' >&2
      exit 1
      ;;
    release-after-retry)
      attempts=$(( $(cat "\${FAKE_VERCEL_ATTEMPTS_FILE}" 2>/dev/null || echo 0) + 1 ))
      printf '%s\\n' "$attempts" > "\${FAKE_VERCEL_ATTEMPTS_FILE}"
      if [ "$attempts" -ge 2 ]; then
        printf 'Aliased %s to %s\\n' "\${2:-}" "\${3:-}"
        exit 0
      fi
      echo 'Error: The chosen alias "ptg.vercel.app" is already in use.' >&2
      exit 1
      ;;
    *)
      echo 'Error: The chosen alias "ptg.vercel.app" is already in use.' >&2
      exit 1
      ;;
  esac
fi
echo "unexpected fake vercel invocation: $*" >&2
exit 1
`,
      { mode: 0o755 },
    )
    return { root, artifactDir, fakeVercelBin, logPath }
  }

  const countAliasAttempts = (logPath: string) =>
    (readFileSync(logPath, 'utf8').match(/args=alias /gu) ?? []).length

  const prodDeployArgs = (workspace: CollisionWorkspace) => [
    '--target',
    'ptg',
    '--artifact-dir',
    workspace.artifactDir,
    '--mode',
    'prod',
    '--scope-env',
    'VERCEL_SCOPE',
  ]

  it('succeeds when an already-in-use alias is held by a deployment of the same commit', async () => {
    apiMode = 'ok'
    deploymentCommitShas = { 'deploy-web.vercel.app': 'sha-main', 'dpl-holder': 'sha-main' }
    aliasHolder = { deploymentId: 'dpl-holder', projectId: 'fake-project' }
    const workspace = makeCollisionWorkspace()
    const reportFile = join(workspace.root, 'report.jsonl')
    try {
      const result = await runCiTools({
        workdir: workspace.root,
        fakeVercelBin: workspace.fakeVercelBin,
        reportFile,
        args: prodDeployArgs(workspace),
        env: { FAKE_VERCEL_ALIAS_MODE: 'same-commit' },
      })
      if (result.status !== 0) {
        console.error({ stdout: result.stdout, stderr: result.stderr })
      }
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('Vercel deploy URL: https://ptg.vercel.app')
      expect(countAliasAttempts(workspace.logPath)).toBe(1)
      const record = readRecord(reportFile)
      expect(record.status).toBe('success')
      expect(record.data).toMatchObject({
        provider: 'vercel',
        target: 'ptg',
        mode: 'prod',
        alias: 'ptg',
        finalUrl: 'https://ptg.vercel.app/',
        rawDeployUrl: 'https://deploy-web.vercel.app/',
        attempts: 1,
      })
    } finally {
      rmSync(workspace.root, { recursive: true, force: true })
    }
  })
  it('rechecks once and succeeds when our project releases the alias', async () => {
    apiMode = 'ok'
    deploymentCommitShas = { 'deploy-web.vercel.app': 'sha-main', 'dpl-holder': 'sha-cron' }
    aliasHolder = { deploymentId: 'dpl-holder', projectId: 'fake-project' }
    const workspace = makeCollisionWorkspace()
    const reportFile = join(workspace.root, 'report.jsonl')
    try {
      const result = await runCiTools({
        workdir: workspace.root,
        fakeVercelBin: workspace.fakeVercelBin,
        reportFile,
        args: prodDeployArgs(workspace),
        env: {
          FAKE_VERCEL_ALIAS_MODE: 'release-after-retry',
          FAKE_VERCEL_ATTEMPTS_FILE: join(workspace.root, 'alias-attempts'),
        },
      })
      if (result.status !== 0) {
        console.error({ stdout: result.stdout, stderr: result.stderr })
      }
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('Vercel deploy URL: https://ptg.vercel.app')
      expect(countAliasAttempts(workspace.logPath)).toBe(2)
      const record = readRecord(reportFile)
      expect(record.status).toBe('success')
      expect(record.data).toMatchObject({
        alias: 'ptg',
        finalUrl: 'https://ptg.vercel.app/',
        attempts: 2,
      })
    } finally {
      rmSync(workspace.root, { recursive: true, force: true })
    }
  })

  it('fails after one immediate recheck when our project keeps holding the alias', async () => {
    apiMode = 'ok'
    deploymentCommitShas = { 'deploy-web.vercel.app': 'sha-main', 'dpl-holder': 'sha-cron' }
    aliasHolder = { deploymentId: 'dpl-holder', projectId: 'fake-project' }
    const workspace = makeCollisionWorkspace()
    const reportFile = join(workspace.root, 'report.jsonl')
    try {
      const result = await runCiTools({
        workdir: workspace.root,
        fakeVercelBin: workspace.fakeVercelBin,
        reportFile,
        args: prodDeployArgs(workspace),
        env: { FAKE_VERCEL_ALIAS_MODE: 'permanent' },
      })
      expect(result.status).not.toBe(0)
      expect(countAliasAttempts(workspace.logPath)).toBe(2)
      const record = readRecord(reportFile)
      expect(record.data).toMatchObject({
        errorKind: 'ProviderOperationFailed',
        retryable: false,
        attempts: 2,
      })
      expect(record.summary).toMatch(/alias/iu)
      expect(JSON.stringify(record)).toContain('already in use')
    } finally {
      rmSync(workspace.root, { recursive: true, force: true })
    }
  })

  it('records the collision failure when deployment metadata is unavailable', async () => {
    apiMode = 'ok'
    deploymentCommitShas = { 'dpl-holder': 'transport-error' }
    aliasHolder = { deploymentId: 'dpl-holder', projectId: 'fake-project' }
    const workspace = makeCollisionWorkspace()
    const reportFile = join(workspace.root, 'report.jsonl')
    try {
      const result = await runCiTools({
        workdir: workspace.root,
        fakeVercelBin: workspace.fakeVercelBin,
        reportFile,
        args: prodDeployArgs(workspace),
        env: { FAKE_VERCEL_ALIAS_MODE: 'permanent' },
      })
      expect(result.status).not.toBe(0)
      expect(countAliasAttempts(workspace.logPath)).toBe(2)
      const record = readRecord(reportFile)
      expect(record.data).toMatchObject({
        errorKind: 'ProviderOperationFailed',
        retryable: false,
        attempts: 2,
      })
      expect(record.summary).toMatch(/alias/iu)
    } finally {
      rmSync(workspace.root, { recursive: true, force: true })
    }
  })

  it('fails fast with an actionable error when the alias is held outside the project', async () => {
    apiMode = 'ok'
    deploymentCommitShas = { 'deploy-web.vercel.app': 'sha-main' }
    aliasHolder = undefined
    const workspace = makeCollisionWorkspace()
    const reportFile = join(workspace.root, 'report.jsonl')
    try {
      const result = await runCiTools({
        workdir: workspace.root,
        fakeVercelBin: workspace.fakeVercelBin,
        reportFile,
        args: prodDeployArgs(workspace),
        env: { FAKE_VERCEL_ALIAS_MODE: 'same-commit' },
      })
      expect(result.status).not.toBe(0)
      expect(countAliasAttempts(workspace.logPath)).toBe(1)
      const record = readRecord(reportFile)
      expect(record.summary).toMatch(/--alias-prefix/iu)
      expect(record.summary).toContain('ptg.vercel.app')
      expect(record.data).toMatchObject({
        errorKind: 'ProviderOperationFailed',
        retryable: false,
        attempts: 1,
      })
    } finally {
      rmSync(workspace.root, { recursive: true, force: true })
    }
  })

  it.each([
    ['transient-error', 'ProviderOperationFailed'],
    ['transport-error', 'ProviderProjectLookupFailed'],
  ] as const)('preserves %s alias lookup failures as retryable', async (mode, errorKind) => {
    apiMode = 'ok'
    aliasApiMode = mode
    deploymentCommitShas = {}
    aliasHolder = undefined
    const workspace = makeCollisionWorkspace()
    const reportFile = join(workspace.root, 'report.jsonl')
    try {
      const result = await runCiTools({
        workdir: workspace.root,
        fakeVercelBin: workspace.fakeVercelBin,
        reportFile,
        args: prodDeployArgs(workspace),
        env: { FAKE_VERCEL_ALIAS_MODE: 'permanent' },
      })
      expect(result.status).not.toBe(0)
      expect(countAliasAttempts(workspace.logPath)).toBe(1)
      expect(readRecord(reportFile).data).toMatchObject({
        errorKind,
        retryable: true,
        attempts: 1,
      })
    } finally {
      aliasApiMode = 'ok'
      rmSync(workspace.root, { recursive: true, force: true })
    }
  })
})
