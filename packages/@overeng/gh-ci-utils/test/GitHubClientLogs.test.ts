import { Effect, Layer, Stream } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/unstable/http'
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner'
import { describe, expect, it } from 'vitest'

import { GitHubAuthConfigTag, defaultGitHubAuthConfig } from '../src/node/Config.ts'
import { GitHubClient } from '../src/node/GitHubClient.ts'

/**
 * `gh auth token` stand-in. Only `string` is reachable from the log path, so the
 * remaining members fail loudly if the client ever grows a dependency on them.
 */
const notSpawned = Effect.die('the log path must not spawn a child process')
const spawnerLayer = Layer.succeed(ChildProcessSpawner, {
  spawn: () => notSpawned,
  exitCode: () => notSpawned,
  streamString: () => Stream.fromEffect(notSpawned),
  streamLines: () => Stream.fromEffect(notSpawned),
  lines: () => notSpawned,
  string: () => Effect.succeed('gho_test_token'),
})

/** Serve a canned `Response` per request URL, so redirect chains stay explicit. */
const httpLayer = (respond: (url: string) => Response) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, respond(url.toString()))),
    ),
  )

const JOB_ID = 99638634809
const LOGS_URL = `https://api.github.com/repos/owner/repo/actions/jobs/${JOB_ID}/logs`

const getJobLogs = (respond: (url: string) => Response) =>
  Effect.runPromise(
    Effect.result(
      Effect.gen(function* () {
        const client = yield* GitHubClient
        return yield* client.getJobLogs({ repo: 'owner/repo', jobId: JOB_ID })
      }),
    ).pipe(
      Effect.provide(
        GitHubClient.Default.pipe(
          Layer.provide(
            Layer.mergeAll(
              httpLayer(respond),
              spawnerLayer,
              Layer.succeed(GitHubAuthConfigTag, defaultGitHubAuthConfig),
            ),
          ),
        ),
      ),
    ),
  )

describe('getJobLogs redirect handling', () => {
  it('resolves a relative Location against the API request URL', async () => {
    const seen: string[] = []
    const result = await getJobLogs((url) => {
      seen.push(url)
      return url === LOGS_URL
        ? new Response(null, { status: 302, headers: { location: '../../../../blob/log.txt' } })
        : new Response('##[error]boom\n')
    })

    expect(seen).toEqual([LOGS_URL, 'https://api.github.com/repos/owner/blob/log.txt'])
    expect(result._tag === 'Success' ? result.success : result).toBe('##[error]boom\n')
  })

  it('reports a chained redirect instead of following it', async () => {
    const result = await getJobLogs((url) =>
      url === LOGS_URL
        ? new Response(null, { status: 302, headers: { location: 'https://blob.example/log' } })
        : new Response(null, {
            status: 302,
            headers: { location: 'https://elsewhere.example/log' },
          }),
    )

    expect(result._tag).toBe('Failure')
    if (result._tag !== 'Failure') return
    expect(result.failure._tag).toBe('LogsUnavailableError')
    expect(result.failure.message).toBe(
      `Log storage chained another redirect (302 -> https://elsewhere.example/log): GET /repos/owner/repo/actions/jobs/${JOB_ID}/logs`,
    )
  })

  it('stamps the real job id on errors raised before the job is known', async () => {
    const result = await getJobLogs(() => new Response('nope', { status: 404 }))

    expect(result._tag).toBe('Failure')
    if (result._tag !== 'Failure' || result.failure._tag !== 'LogsUnavailableError') return
    expect(result.failure.jobId).toBe(JOB_ID)
  })
})
