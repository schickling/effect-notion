import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { decodeActiveJobsResponse } from '../src/node/RunnerClient.ts'

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

  it('rejects malformed payloads', () => {
    const result = Effect.runSync(Effect.result(decodeActiveJobsResponse({ jobs: [] })))
    expect(result._tag).toBe('Failure')
  })
})
