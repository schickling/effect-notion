import { Effect, Layer, Logger, Stream } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/unstable/http'
import * as ChildProcess from 'effect/unstable/process/ChildProcess'
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner'
import { describe, expect, it } from 'vitest'

import { GitHubAuthConfigTag } from '../src/node/Config.ts'
import { GitHubClient } from '../src/node/GitHubClient.ts'

/**
 * `gh auth token` is the only child process this path spawns, so every other
 * spawner method reaching the fake is a bug in the test, not a case to fake.
 */
const unusedSpawnerMethod = (name: string) =>
  Effect.die(new Error(`ChildProcessSpawner.${name} is not part of the CLI-token path`))

/**
 * Drive `listWorkflowRunsByStatus` for `repos` concurrently against a client
 * whose App auth covers `example-user` only, and report what the process
 * boundaries saw: spawned commands, request credentials, warnings.
 */
const runFallbackScenario = async (repos: readonly string[]) => {
  const commands: string[] = []
  const authorizations: string[] = []
  const warnings: string[] = []

  const spawnerLayer = Layer.succeed(ChildProcessSpawner, {
    string: (command: ChildProcess.Command) =>
      Effect.gen(function* () {
        if (ChildProcess.isStandardCommand(command) === false) {
          return yield* unusedSpawnerMethod('string with a piped command')
        }
        commands.push([command.command, ...command.args].join(' '))
        // Spawning is asynchronous. Without that boundary the fake resolves
        // before a sibling fiber runs, hiding the concurrent-first-call race
        // this test exists for.
        yield* Effect.sleep('1 millis')
        // `gh auth token` ends its output with a newline the client has to trim:
        // a raw newline is not a legal header value.
        return 'ghp_test-token\n'
      }),
    spawn: () => unusedSpawnerMethod('spawn'),
    exitCode: () => unusedSpawnerMethod('exitCode'),
    lines: () => unusedSpawnerMethod('lines'),
    streamString: () => Stream.fromEffect(unusedSpawnerMethod('streamString')),
    streamLines: () => Stream.fromEffect(unusedSpawnerMethod('streamLines')),
  })

  const httpLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        authorizations.push(request.headers['authorization'] ?? '')
        return HttpClientResponse.fromWeb(
          request,
          new Response('{"total_count":0,"workflow_runs":[]}', { status: 200 }),
        )
      }),
    ),
  )

  const authLayer = Layer.succeed(GitHubAuthConfigTag, {
    _tag: 'github-app' as const,
    clientID: 'Iv1.test',
    installationIDs: { 'example-user': 654_321 },
    privateKeyPath: '/nonexistent/gh-ci-utils-test.pem',
  })

  const loggerLayer = Logger.layer(
    [
      Logger.make(({ logLevel, message }) => {
        if (logLevel === 'Warn') warnings.push(String(message))
      }),
    ],
    { mergeWithExisting: false },
  )

  await Effect.gen(function* () {
    const client = yield* GitHubClient
    yield* Effect.all(
      repos.map((repo) => client.listWorkflowRunsByStatus({ repo, status: 'completed' })),
      { concurrency: 'unbounded' },
    )
  }).pipe(
    Effect.provide(
      GitHubClient.Default.pipe(
        Layer.provide(Layer.mergeAll(spawnerLayer, httpLayer, authLayer)),
        Layer.provideMerge(loggerLayer),
      ),
    ),
    Effect.runPromise,
  )

  return { commands, authorizations, warnings }
}

describe('CLI-token fallback for owners without an App installation', () => {
  it('spawns `gh auth token` once for concurrent requests, and sends it trimmed', async () => {
    const { commands, authorizations } = await runFallbackScenario([
      'external-org/external-repo-a',
      'external-org/external-repo-b',
      'another-external-org/external-repo-c',
    ])

    expect(commands).toEqual(['gh auth token'])
    expect([...new Set(authorizations)]).toEqual(['Bearer ghp_test-token'])
  })

  it('warns once per owner, not once per request', async () => {
    const { warnings } = await runFallbackScenario([
      'external-org/external-repo-a',
      'external-org/external-repo-b',
      'another-external-org/external-repo-c',
    ])

    expect(warnings.filter((warning) => warning.includes('`external-org`'))).toHaveLength(1)
    expect(warnings.filter((warning) => warning.includes('`another-external-org`'))).toHaveLength(1)
  })
})
