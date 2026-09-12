import { Effect, Layer } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/unstable/http'
import { describe, expect, it } from 'vitest'

import { GitHubInternal } from '../src/node/GitHubInternal.ts'
import type { SessionData } from '../src/node/GitHubSession.ts'

const session: SessionData = {
  userSession: 'test-session',
  expiresAt: 2_000_000_000,
  savedAt: '2026-09-12T00:00:00.000Z',
  user: 'example-user',
}

describe('GitHubInternal.getCompletedStepLog', () => {
  it('fetches only the requested completed step and does not forward cookies to storage', async () => {
    const seen: { url: string; cookie: string | undefined }[] = []
    const endpoint =
      'https://github.com/example-org/example-repo/commit/abcdef123456/checks/987/logs/4'
    const storageUrl = 'https://logs.example.invalid/completed-step.txt'
    const httpLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request, url) => {
        seen.push({ url: url.toString(), cookie: request.headers['cookie'] })
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            url.toString() === endpoint
              ? new Response(null, { status: 302, headers: { location: storageUrl } })
              : new Response('requested step only\n'),
          ),
        )
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
})
