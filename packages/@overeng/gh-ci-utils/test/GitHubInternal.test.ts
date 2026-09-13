import { Effect, Layer } from 'effect'
import { HttpClient, type HttpClientRequest, HttpClientResponse } from 'effect/unstable/http'
import { describe, expect, it } from 'vitest'

import { GitHubInternal } from '../src/node/GitHubInternal.ts'
import type { SessionData } from '../src/node/GitHubSession.ts'

const session: SessionData = {
  userSession: 'test-session',
  expiresAt: 2_000_000_000,
  savedAt: '2026-09-12T00:00:00.000Z',
  user: 'example-user',
}

const scopedResponse = (
  request: HttpClientRequest.HttpClientRequest,
  body: string,
  signal: AbortSignal,
) =>
  Effect.sync(() => {
    const bytes = new TextEncoder().encode(body)
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
              controller.enqueue(bytes)
              controller.close()
            },
          },
          { highWaterMark: 0 },
        ),
      ),
    )
  })

describe('GitHubInternal.getCompletedStepLog', () => {
  it('fetches only the requested completed step and does not forward cookies to storage', async () => {
    const seen: { url: string; cookie: string | undefined }[] = []
    const endpoint =
      'https://github.com/example-org/example-repo/commit/abcdef123456/checks/987/logs/4'
    const storageUrl = 'https://logs.example.invalid/completed-step.txt'
    const httpLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request, url, signal) => {
        seen.push({ url: url.toString(), cookie: request.headers['cookie'] })
        return url.toString() === endpoint
          ? Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(null, { status: 302, headers: { location: storageUrl } }),
              ),
            )
          : scopedResponse(request, 'requested step only\n', signal)
      }),
    )

    const log = await Effect.gen(function* () {
      const internal = yield* GitHubInternal
      return yield* internal.getCompletedStepLog({
        owner: 'example-org',
        repo: 'example-repo',
        headSha: 'abcdef123456',
        restJobId: 987,
        stepNumber: 4,
        session,
      })
    }).pipe(
      Effect.provide(GitHubInternal.Default.pipe(Layer.provide(httpLayer))),
      Effect.runPromise,
    )

    expect(log).toBe('requested step only\n')
    expect(seen).toEqual([
      { url: endpoint, cookie: 'user_session=test-session' },
      { url: storageUrl, cookie: undefined },
    ])
  })

  it('reports a completed-step login redirect as a terminal session failure', async () => {
    const httpLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(null, {
              status: 302,
              headers: { location: 'https://github.com/login?return_to=%2Fcompleted-step' },
            }),
          ),
        ),
      ),
    )

    const result = await Effect.gen(function* () {
      const internal = yield* GitHubInternal
      return yield* Effect.result(
        internal.getCompletedStepLog({
          owner: 'example-org',
          repo: 'example-repo',
          headSha: 'abcdef123456',
          restJobId: 987,
          stepNumber: 4,
          session,
        }),
      )
    }).pipe(
      Effect.provide(GitHubInternal.Default.pipe(Layer.provide(httpLayer))),
      Effect.runPromise,
    )

    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') {
      expect(result.failure.message).toContain(
        'GitHub session was rejected while fetching completed step log',
      )
    }
  })

  it('consumes internal HTML and JSON bodies inside their acquisition scopes', async () => {
    const httpLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request, url, signal) =>
        scopedResponse(
          request,
          url.pathname.endsWith('/job/987')
            ? '<div data-job-steps-url="/jobs/456/steps"></div>'
            : JSON.stringify([
                {
                  id: 'step-1',
                  name: 'Build',
                  status: 'completed',
                  conclusion: 'success',
                  number: 1,
                  started_at: '2026-09-13T10:00:00Z',
                  completed_at: '2026-09-13T10:01:00Z',
                  change_id: 1,
                },
              ]),
          signal,
        ),
      ),
    )

    const result = await Effect.gen(function* () {
      const internal = yield* GitHubInternal
      const internalJobId = yield* internal.resolveInternalJobId({
        owner: 'example-org',
        repo: 'example-repo',
        runId: 123,
        restJobId: 987,
        session,
      })
      const steps = yield* internal.getSteps({
        owner: 'example-org',
        repo: 'example-repo',
        runId: 123,
        internalJobId,
        session,
      })
      return { internalJobId, steps }
    }).pipe(
      Effect.provide(GitHubInternal.Default.pipe(Layer.provide(httpLayer))),
      Effect.runPromise,
    )

    expect(result.internalJobId).toBe(456)
    expect(result.steps).toMatchObject([{ id: 'step-1', name: 'Build' }])
  })
})

describe('GitHubInternal.resolveInternalJobId authentication', () => {
  it.each([
    ['forbidden response', 403, 'forbidden', 'GitHub returned 403 while resolving internal job'],
    [
      'login page',
      200,
      '<form action="/session"><h1>Sign in to GitHub</h1></form>',
      'GitHub session was rejected while resolving job 987; sign in again',
    ],
  ])('reports a %s as a terminal API failure', async (_label, status, body, expectedMessage) => {
    const httpLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request, _url, signal) =>
        status === 200
          ? scopedResponse(request, body, signal)
          : Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status }))),
      ),
    )

    const result = await Effect.gen(function* () {
      const internal = yield* GitHubInternal
      return yield* Effect.result(
        internal.resolveInternalJobId({
          owner: 'example-org',
          repo: 'example-repo',
          runId: 123,
          restJobId: 987,
          session,
        }),
      )
    }).pipe(
      Effect.provide(GitHubInternal.Default.pipe(Layer.provide(httpLayer))),
      Effect.runPromise,
    )

    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') expect(result.failure.message).toContain(expectedMessage)
  })
})
