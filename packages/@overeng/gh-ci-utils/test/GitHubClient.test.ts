import { generateKeyPairSync } from 'node:crypto'
import path from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { Effect, FileSystem, Layer, Sink, Stream } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/unstable/http'
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner'
import * as ProcessSpawner from 'effect/unstable/process/ChildProcessSpawner'
import { describe, expect, it } from 'vitest'

import { GitHubAuthConfigTag, detectCurrentBranch, resolveConfig } from '../src/node/Config.ts'
import {
  GitHubClient,
  type GitHubClientShape,
  selectAppAuthSource,
  selectRunForVerdict,
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
  scopeResponseBodies = false,
}: {
  responseFor: (url: URL) => Response
  program: (client: GitHubClientShape) => Effect.Effect<TValue, TError>
  scopeResponseBodies?: boolean
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
    HttpClient.make((request, url, signal) =>
      Effect.gen(function* () {
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
        if (!scopeResponseBodies || response.body === null) {
          return HttpClientResponse.fromWeb(request, response)
        }

        const body = new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()))
        const scopedBody = new ReadableStream<Uint8Array>(
          {
            pull: (controller) => {
              if (signal.aborted) {
                controller.error(new Error('response body consumed after request scope closed'))
                return
              }
              controller.enqueue(body)
              controller.close()
            },
          },
          { highWaterMark: 0 },
        )
        return HttpClientResponse.fromWeb(
          request,
          new Response(scopedBody, { status: response.status, headers: response.headers }),
        )
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

  it('consumes GET and POST JSON bodies before their HTTP request scopes close', async () => {
    const workflow = { id: 42, name: 'CI', path: '.github/workflows/ci.yml' }
    const { result } = await runWithSyntheticAppClient({
      scopeResponseBodies: true,
      responseFor: (url) => {
        if (url.pathname === '/repos/example-org/example-repo/actions/workflows') {
          return new Response(JSON.stringify({ total_count: 1, workflows: [workflow] }))
        }
        if (url.pathname === '/graphql') {
          return new Response(
            JSON.stringify({
              data: {
                repository: {
                  pullRequest: {
                    mergeable: 'MERGEABLE',
                    baseRefName: 'main',
                    baseRef: { compare: { behindBy: 0 } },
                  },
                },
              },
            }),
          )
        }
        return new Response(
          JSON.stringify({
            workflow_run_id: 70000000042,
            run_url:
              'https://api.github.com/repos/example-org/example-repo/actions/runs/70000000042',
            html_url: 'https://github.com/example-org/example-repo/actions/runs/70000000042',
          }),
        )
      },
      program: (client) =>
        Effect.gen(function* () {
          const dispatch = yield* client.dispatchWorkflow({
            repo: 'example-org/example-repo',
            workflow: 'ci.yml',
            ref: 'feature/scoped-response',
          })
          const health = yield* client.getPrHealth({
            repo: 'example-org/example-repo',
            prNumber: 42,
            headRef: 'feature/scoped-response',
          })
          return { dispatch, health }
        }),
    })

    expect(result.dispatch.workflow_run_id).toBe(70000000042)
    expect(result.health).toEqual({
      prNumber: 42,
      mergeable: 'MERGEABLE',
      baseRefName: 'main',
      behindBy: 0,
    })
  })

  it('finds an older active branch run beyond a page of completed runs', async () => {
    const completedPage = Array.from({ length: 100 }, (_, index) =>
      syntheticRun({ id: index + 1, path: '.github/workflows/ci.yml' }),
    )
    const activeRun = {
      ...syntheticRun({ id: 101, path: '.github/workflows/ci.yml' }),
      status: 'in_progress',
      conclusion: null,
    }
    const { requests, result } = await runWithSyntheticAppClient({
      responseFor: (url) =>
        new Response(
          JSON.stringify({
            total_count: 101,
            workflow_runs: url.searchParams.get('page') === '1' ? completedPage : [activeRun],
          }),
        ),
      program: (client) =>
        client.getLatestActiveRunForBranch({
          repo: 'example-org/example-repo',
          branch: 'feature/synthetic-dispatch',
        }),
    })

    expect(result?.id).toBe(activeRun.id)
    expect(requests.slice(1).map((request) => request.url)).toEqual([
      'https://api.github.com/repos/example-org/example-repo/actions/runs?branch=feature%2Fsynthetic-dispatch&per_page=100&page=1',
      'https://api.github.com/repos/example-org/example-repo/actions/runs?branch=feature%2Fsynthetic-dispatch&per_page=100&page=2',
    ])
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

  it('finds an exact explicit workflow match beyond the first PR-head run page', async () => {
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
        client
          .listRunsForHeadSha({
            repo: 'example-org/example-repo',
            headSha: 'pr-head-sha',
            preferWorkflow: 'ci.yml',
          })
          .pipe(Effect.map((runs) => selectRunForVerdict({ runs, preferWorkflow: 'ci.yml' }).run)),
    })

    expect(result?.id).toBe(expected.id)
    expect(requests.slice(1).map((request) => request.url)).toEqual([
      'https://api.github.com/repos/example-org/example-repo/actions/runs?head_sha=pr-head-sha&per_page=100&page=1',
      'https://api.github.com/repos/example-org/example-repo/actions/runs?head_sha=pr-head-sha&per_page=100&page=2',
    ])
  })
})

describe('GitHubClient mutations and annotations', () => {
  it('requests only graceful cancellation after GitHub accepts a normal cancel', async () => {
    const { requests } = await runWithSyntheticAppClient({
      responseFor: (url) =>
        url.pathname.endsWith('/cancel')
          ? new Response(null, { status: 202 })
          : new Response(null, { status: 404 }),
      program: (client) =>
        client.cancelRun({ repo: 'example-org/example-repo', runId: 70000000123 }),
    })

    expect(requests.slice(1).map(({ method, url }) => ({ method, url }))).toEqual([
      {
        method: 'POST',
        url: 'https://api.github.com/repos/example-org/example-repo/actions/runs/70000000123/cancel',
      },
    ])
  })

  it('collects check-run annotations from every page', async () => {
    const annotation = (line: number) => ({
      path: 'src/synthetic.ts',
      start_line: line,
      end_line: line,
      annotation_level: 'failure',
      message: `Synthetic failure ${line}`,
      title: null,
      raw_details: null,
    })
    const firstPage = Array.from({ length: 100 }, (_, index) => annotation(index + 1))
    const finalAnnotation = annotation(101)
    const { requests, result } = await runWithSyntheticAppClient({
      responseFor: (url) =>
        new Response(
          JSON.stringify(url.searchParams.get('page') === '1' ? firstPage : [finalAnnotation]),
          { status: 200 },
        ),
      program: (client) =>
        client.getCheckAnnotations({
          repo: 'example-org/example-repo',
          checkRunId: 80000000123,
        }),
    })

    expect(result).toHaveLength(101)
    expect(result[100]).toEqual(finalAnnotation)
    expect(requests.slice(1).map((request) => request.url)).toEqual([
      'https://api.github.com/repos/example-org/example-repo/check-runs/80000000123/annotations?per_page=100&page=1',
      'https://api.github.com/repos/example-org/example-repo/check-runs/80000000123/annotations?per_page=100&page=2',
    ])
  })
})

const branchSpawnerLayer = ({
  stdout,
  stderr,
  exitCode,
}: {
  stdout: string
  stderr: string
  exitCode: number
}) =>
  Layer.succeed(
    ChildProcessSpawner,
    ProcessSpawner.make(() =>
      Effect.succeed(
        ProcessSpawner.makeHandle({
          pid: ProcessSpawner.ProcessId(123),
          exitCode: Effect.succeed(ProcessSpawner.ExitCode(exitCode)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.make(new TextEncoder().encode(stdout)),
          stderr: Stream.make(new TextEncoder().encode(stderr)),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        }),
      ),
    ),
  )

describe('detectCurrentBranch', () => {
  it('rejects stdout from a failed git process', async () => {
    const result = await detectCurrentBranch.pipe(
      Effect.provide(
        branchSpawnerLayer({
          stdout: 'main\n',
          stderr: 'fatal: not a git repository\n',
          exitCode: 128,
        }),
      ),
      Effect.result,
      Effect.runPromise,
    )

    expect(result._tag).toBe('Failure')
    if (result._tag !== 'Failure') return
    expect(result.failure).toMatchObject({
      _tag: 'ConfigError',
      message: 'Failed to detect current git branch',
    })
  })

  it('rejects empty branch output from a successful git process', async () => {
    const result = await detectCurrentBranch.pipe(
      Effect.provide(branchSpawnerLayer({ stdout: '\n', stderr: '', exitCode: 0 })),
      Effect.result,
      Effect.runPromise,
    )

    expect(result._tag).toBe('Failure')
    if (result._tag !== 'Failure') return
    expect(result.failure).toMatchObject({
      _tag: 'ConfigError',
      message: 'Failed to detect current git branch',
      cause: 'git returned empty branch output',
    })
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
