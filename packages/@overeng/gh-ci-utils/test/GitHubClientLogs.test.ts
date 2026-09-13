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
const httpLayer = (respond: (url: string) => Response, scopeResponseBodies = false) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url, signal) =>
      Effect.gen(function* () {
        const response = respond(url.toString())
        if (!scopeResponseBodies || response.body === null) {
          return HttpClientResponse.fromWeb(request, response)
        }

        const body = new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()))
        return HttpClientResponse.fromWeb(
          request,
          new Response(
            new ReadableStream<Uint8Array>(
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
            ),
            { status: response.status, headers: response.headers },
          ),
        )
      }),
    ),
  )

const JOB_ID = 80000000002
const LOGS_URL = `https://api.github.com/repos/owner/repo/actions/jobs/${JOB_ID}/logs`

const getJobLogs = (respond: (url: string) => Response, scopeResponseBodies = false) =>
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
              httpLayer(respond, scopeResponseBodies),
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

  it.each([
    ['404 response', () => new Response('not ready', { status: 404 })],
    ['empty response', () => new Response('')],
  ])('leaves a transient %s retryable', async (_label, unavailableResponse) => {
    let attempts = 0
    const respond = () => {
      attempts++
      return attempts === 1 ? unavailableResponse() : new Response('real logs\n')
    }

    const unavailable = await getJobLogs(respond)
    const retrieved = await getJobLogs(respond)

    expect(unavailable._tag).toBe('Failure')
    expect(retrieved._tag === 'Success' ? retrieved.success : retrieved).toBe('real logs\n')
    expect(attempts).toBe(2)
  })

  it('consumes a scoped text body before the HTTP request scope closes', async () => {
    const result = await getJobLogs(() => new Response('scoped log body\n'), true)

    expect(result._tag === 'Success' ? result.success : result).toBe('scoped log body\n')
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
    expect(result.failure._tag).toBe('GitHubApiError')
    expect(result.failure.message).toBe(
      `Log storage chained another redirect (302 -> https://elsewhere.example/log): GET /repos/owner/repo/actions/jobs/${JOB_ID}/logs`,
    )
  })

  it('reports authorization failures as terminal API errors', async () => {
    const result = await getJobLogs(() => new Response('forbidden', { status: 403 }))

    expect(result._tag).toBe('Failure')
    if (result._tag !== 'Failure') return
    expect(result.failure).toMatchObject({
      _tag: 'GitHubApiError',
      message: `GitHub API returned 403: GET /repos/owner/repo/actions/jobs/${JOB_ID}/logs — forbidden`,
    })
  })

  it('stamps the real job id on errors raised before the job is known', async () => {
    const result = await getJobLogs(() => new Response('nope', { status: 404 }))

    expect(result._tag).toBe('Failure')
    if (result._tag !== 'Failure' || result.failure._tag !== 'LogsUnavailableError') return
    expect(result.failure.jobId).toBe(JOB_ID)
  })
})
