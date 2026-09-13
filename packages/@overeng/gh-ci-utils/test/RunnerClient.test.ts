import { Effect, Layer, Schema } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/unstable/http'
import { describe, expect, it } from 'vitest'

import { decodeActiveJobsResponse, fetchRunnerHostJobs } from '../src/node/RunnerClient.ts'

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

describe('decodeActiveJobsResponse', () => {
  it('treats null responses as an idle host', () => {
    expect(Effect.runSync(decodeActiveJobsResponse(null))).toEqual([])
  })

  it('preserves active job payloads', () => {
    expect(
      Effect.runSync(
        decodeActiveJobsResponse([
          {
            runner: 'linux-builder-a-1234abcd',
            scaleSet: 'sample-repo',
            host: 'linux-builder-a',
            workDir: '/var/lib/github-runner-work/sample-repo/linux-builder-a-1234abcd',
            startedAt: '2026-03-27T11:00:00Z',
            durationSec: 120,
          },
        ]),
      ),
    ).toEqual([
      {
        runner: 'linux-builder-a-1234abcd',
        scaleSet: 'sample-repo',
        host: 'linux-builder-a',
        workDir: '/var/lib/github-runner-work/sample-repo/linux-builder-a-1234abcd',
        startedAt: '2026-03-27T11:00:00Z',
        durationSec: 120,
      },
    ])
  })

  it('decodes the body before the runner HTTP request scope closes', async () => {
    const job = {
      runner: 'linux-builder-a-1234abcd',
      scaleSet: 'sample-repo',
      host: 'linux-builder-a',
      workDir: '/var/lib/github-runner-work/sample-repo/linux-builder-a-1234abcd',
      startedAt: '2026-03-27T11:00:00Z',
      durationSec: 120,
    }
    const httpLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request, _url, signal) =>
        Effect.sync(() => {
          const body = new TextEncoder().encode(encodeJson([job]))
          return HttpClientResponse.fromWeb(
            request,
            new Response(
              new ReadableStream<Uint8Array>(
                {
                  pull: (controller) => {
                    if (signal.aborted) {
                      controller.error(
                        new Error('response body consumed after request scope closed'),
                      )
                      return
                    }
                    controller.enqueue(body)
                    controller.close()
                  },
                },
                { highWaterMark: 0 },
              ),
            ),
          )
        }),
      ),
    )

    const result = await fetchRunnerHostJobs('linux-builder-a').pipe(
      Effect.provide(httpLayer),
      Effect.runPromise,
    )

    expect(result).toEqual({ host: 'linux-builder-a', status: 'reachable', jobs: [job] })
  })

  it('rejects malformed payloads', () => {
    const result = Effect.runSync(Effect.result(decodeActiveJobsResponse({ jobs: [] })))
    expect(result._tag).toBe('Failure')
  })
})
