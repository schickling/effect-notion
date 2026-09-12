import { generateKeyPairSync } from 'node:crypto'
import path from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { Effect, FileSystem, Layer, Stream } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/unstable/http'
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner'
import { describe, expect, it } from 'vitest'

import { GitHubAuthConfigTag, resolveConfig } from '../src/node/Config.ts'
import {
  GitHubClient,
  type GitHubClientShape,
  selectAppAuthSource,
} from '../src/node/GitHubClient.ts'

describe('selectAppAuthSource', () => {
  const auth = { installationIDs: { 'example-org': 123_456, 'another-org': 234_567 } }

  it('uses the configured installation for a known owner', () => {
    expect(selectAppAuthSource({ auth, repo: 'another-org/example-repo' })).toEqual({
      _tag: 'app-installation',
      owner: 'another-org',
      installationID: 234_567,
    })
  })

  it('falls back to the gh CLI token for an owner without an installation', () => {
    expect(selectAppAuthSource({ auth, repo: 'external-org/external-repo' })).toEqual({
      _tag: 'cli-token-fallback',
      owner: 'external-org',
    })
  })

  it('rejects slugs that are not owner/repo', () => {
    expect(() => selectAppAuthSource({ auth, repo: 'external-org' })).toThrow(/owner\/repo/)
  })
})

interface RecordedRequest {
  readonly method: string
  readonly url: string
  readonly authorization: string
  readonly body: string | null
}

const runWithSyntheticAppClient = async <TValue, TError>({
  responseFor,
  program,
}: {
  responseFor: (url: URL) => Response
  program: (client: GitHubClientShape) => Effect.Effect<TValue, TError>
}) => {
  const requests: RecordedRequest[] = []
  const forbiddenProcess = Effect.die('App-auth request must not spawn a child process')
  const spawnerLayer = Layer.succeed(ChildProcessSpawner, {
    string: () => forbiddenProcess,
    spawn: () => forbiddenProcess,
    exitCode: () => forbiddenProcess,
    lines: () => forbiddenProcess,
    streamString: () => Stream.fromEffect(forbiddenProcess),
    streamLines: () => Stream.fromEffect(forbiddenProcess),
  })
  const httpLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.sync(() => {
        requests.push({
          method: request.method,
          url: url.toString(),
          authorization: request.headers['authorization'] ?? '',
          body:
            request.body._tag === 'Uint8Array' ? new TextDecoder().decode(request.body.body) : null,
        })
        const response =
          url.pathname === '/app/installations/654321/access_tokens'
            ? new Response(
                '{"token":"installation-test-token","expires_at":"2099-01-01T00:00:00Z"}',
                { status: 201 },
              )
            : responseFor(url)
        return HttpClientResponse.fromWeb(request, response)
      }),
    ),
  )

  const result = await Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped()
    const privateKeyPath = path.join(directory, 'synthetic-app.pem')
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    yield* fs.writeFileString(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }))
    const authLayer = Layer.succeed(GitHubAuthConfigTag, {
      _tag: 'github-app' as const,
      clientID: 'synthetic-app-client',
      installationIDs: { 'example-org': 654_321 },
      privateKeyPath,
    })

    return yield* Effect.gen(function* () {
      const client = yield* GitHubClient
      return yield* program(client)
    }).pipe(
      Effect.provide(
        GitHubClient.Default.pipe(
          Layer.provide(Layer.mergeAll(httpLayer, spawnerLayer, authLayer)),
        ),
      ),
    )
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise)

  return { requests, result }
}

const syntheticRun = ({ id, path: workflowPath }: { id: number; path: string }) => ({
  id,
  name: 'Synthetic workflow',
  path: workflowPath,
  head_branch: 'feature/synthetic-dispatch',
  head_sha: `sha-${id}`,
  status: 'completed',
  conclusion: 'success',
  workflow_id: id,
  run_number: id,
  run_attempt: 1,
  event: 'workflow_dispatch',
  created_at: '2026-09-12T12:34:56Z',
  updated_at: '2026-09-12T12:35:56Z',
  run_started_at: '2026-09-12T12:34:57Z',
  html_url: `https://github.com/example-org/example-repo/actions/runs/${id}`,
  jobs_url: `https://api.github.com/repos/example-org/example-repo/actions/runs/${id}/jobs`,
  pull_requests: [],
})

describe('GitHubClient paginated workflow selection', () => {
  it('discovers and dispatches a workflow beyond the first 100 definitions', async () => {
    const pageOne = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      name: `Synthetic ${index + 1}`,
      path: `.github/workflows/synthetic-${index + 1}.yml`,
    }))
    const { requests, result } = await runWithSyntheticAppClient({
      responseFor: (url) => {
        if (url.pathname === '/repos/example-org/example-repo/actions/workflows') {
          const workflows =
            url.searchParams.get('page') === '1'
              ? pageOne
              : [{ id: 142, name: 'CI', path: '.github/workflows/ci.yml' }]
          return new Response(JSON.stringify({ total_count: 101, workflows }), { status: 200 })
        }
        if (url.pathname.endsWith('/dispatches')) {
          return new Response(
            JSON.stringify({
              workflow_run_id: 70000000142,
              run_url:
                'https://api.github.com/repos/example-org/example-repo/actions/runs/70000000142',
              html_url: 'https://github.com/example-org/example-repo/actions/runs/70000000142',
            }),
            { status: 200 },
          )
        }
        return new Response(null, { status: 404 })
      },
      program: (client) =>
        client.dispatchWorkflow({
          repo: 'example-org/example-repo',
          workflow: 'CI',
          ref: 'feature/synthetic-dispatch',
        }),
    })

    expect(requests.map(({ method, url }) => ({ method, url }))).toEqual([
      {
        method: 'POST',
        url: 'https://api.github.com/app/installations/654321/access_tokens',
      },
      {
        method: 'GET',
        url: 'https://api.github.com/repos/example-org/example-repo/actions/workflows?per_page=100&page=1',
      },
      {
        method: 'GET',
        url: 'https://api.github.com/repos/example-org/example-repo/actions/workflows?per_page=100&page=2',
      },
      {
        method: 'POST',
        url: 'https://api.github.com/repos/example-org/example-repo/actions/workflows/142/dispatches',
      },
    ])
    expect(requests.slice(1).map((request) => request.authorization)).toEqual([
      'Bearer installation-test-token',
      'Bearer installation-test-token',
      'Bearer installation-test-token',
    ])
    expect(requests[3]?.body).toBe('{"ref":"feature/synthetic-dispatch","return_run_details":true}')
    expect(result).toEqual({
      workflow_run_id: 70000000142,
      run_url: 'https://api.github.com/repos/example-org/example-repo/actions/runs/70000000142',
      html_url: 'https://github.com/example-org/example-repo/actions/runs/70000000142',
    })
  })

  it('finds an exact explicit workflow match beyond the first branch-run page', async () => {
    const pageOne = Array.from({ length: 100 }, (_, index) =>
      syntheticRun({
        id: index + 1,
        path: index === 0 ? '.github/workflows/foo-ci.yml' : `.github/workflows/job-${index}.yml`,
      }),
    )
    const expected = syntheticRun({ id: 142, path: '.github/workflows/ci.yml' })
    const { requests, result } = await runWithSyntheticAppClient({
      responseFor: (url) => {
        const workflow_runs = url.searchParams.get('page') === '1' ? pageOne : [expected]
        return new Response(JSON.stringify({ total_count: 101, workflow_runs }), { status: 200 })
      },
      program: (client) =>
        client.getLatestRunForBranch({
          repo: 'example-org/example-repo',
          branch: 'feature/synthetic-dispatch',
          preferWorkflow: 'ci.yml',
        }),
    })

    expect(result?.id).toBe(expected.id)
    expect(requests.slice(1).map((request) => request.url)).toEqual([
      'https://api.github.com/repos/example-org/example-repo/actions/runs?branch=feature%2Fsynthetic-dispatch&per_page=100&page=1',
      'https://api.github.com/repos/example-org/example-repo/actions/runs?branch=feature%2Fsynthetic-dispatch&per_page=100&page=2',
    ])
  })
})

describe('resolveConfig', () => {
  it('loads repositories and runner hosts from the user config', async () => {
    const config = await Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const configPath = path.join(directory, 'config.json')
      yield* fs.writeFileString(
        configPath,
        '{"auth":{"_tag":"gh-cli"},"repos":["example-org/example-repo"],"runnerHosts":["runner-host-a"]}',
      )
      return yield* resolveConfig({ configPath })
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise)

    expect(config).toEqual({
      repos: ['example-org/example-repo'],
      runnerHosts: ['runner-host-a'],
    })
  })

  it('uses no organization-specific runner hosts when none are configured', async () => {
    const config = await Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      return yield* resolveConfig({
        configPath: path.join(directory, 'missing.json'),
        partial: { repos: ['example-org/example-repo'] },
      })
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise)

    expect(config.runnerHosts).toEqual([])
  })
})
