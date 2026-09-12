import { generateKeyPairSync } from 'node:crypto'
import path from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { Effect, FileSystem, Layer, Stream } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/unstable/http'
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner'
import { describe, expect, it } from 'vitest'

import { GitHubAuthConfigTag, resolveConfig } from '../src/node/Config.ts'
import { GitHubClient, selectAppAuthSource } from '../src/node/GitHubClient.ts'

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

describe('GitHubClient dispatchWorkflow', () => {
  it('dispatches with the configured App installation without spawning gh', async () => {
    const requests: Array<{
      method: string
      url: string
      authorization: string
      body: string | null
    }> = []
    const forbiddenProcess = Effect.die('App-auth dispatch must not spawn a child process')
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
              request.body._tag === 'Uint8Array'
                ? new TextDecoder().decode(request.body.body)
                : null,
          })
          if (url.pathname === '/app/installations/654321/access_tokens') {
            return HttpClientResponse.fromWeb(
              request,
              new Response(
                '{"token":"installation-test-token","expires_at":"2099-01-01T00:00:00Z"}',
                { status: 201 },
              ),
            )
          }
          if (url.pathname === '/repos/example-org/example-repo/actions/workflows') {
            return HttpClientResponse.fromWeb(
              request,
              new Response(
                '{"workflows":[{"id":42,"name":"CI","path":".github/workflows/ci.yml"}]}',
                { status: 200 },
              ),
            )
          }
          return HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }))
        }),
      ),
    )

    await Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const privateKeyPath = path.join(directory, 'synthetic-app.pem')
      const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
      yield* fs.writeFileString(
        privateKeyPath,
        privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      )
      const authLayer = Layer.succeed(GitHubAuthConfigTag, {
        _tag: 'github-app' as const,
        clientID: 'synthetic-app-client',
        installationIDs: { 'example-org': 654_321 },
        privateKeyPath,
      })

      yield* Effect.gen(function* () {
        const client = yield* GitHubClient
        yield* client.dispatchWorkflow({
          repo: 'example-org/example-repo',
          workflow: 'CI',
          ref: 'feature/synthetic-dispatch',
        })
      }).pipe(
        Effect.provide(
          GitHubClient.Default.pipe(
            Layer.provide(Layer.mergeAll(httpLayer, spawnerLayer, authLayer)),
          ),
        ),
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise)

    expect(requests.map(({ method, url }) => ({ method, url }))).toEqual([
      {
        method: 'POST',
        url: 'https://api.github.com/app/installations/654321/access_tokens',
      },
      {
        method: 'GET',
        url: 'https://api.github.com/repos/example-org/example-repo/actions/workflows?per_page=100',
      },
      {
        method: 'POST',
        url: 'https://api.github.com/repos/example-org/example-repo/actions/workflows/42/dispatches',
      },
    ])
    expect(requests.slice(1).map((request) => request.authorization)).toEqual([
      'Bearer installation-test-token',
      'Bearer installation-test-token',
    ])
    expect(requests[2]?.body).toBe('{"ref":"feature/synthetic-dispatch"}')
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
