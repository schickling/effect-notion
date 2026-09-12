import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { CiStateSchema } from '../src/isomorphic/renderers/CiOutput/schema.ts'
import {
  createSingleRunState,
  makeJob,
  makeRun,
} from '../src/isomorphic/renderers/CiOutput/stories/_fixtures.ts'
import { MutationStateSchema } from '../src/isomorphic/renderers/MutationOutput/schema.ts'
import { RunnersStateSchema } from '../src/isomorphic/renderers/RunnersOutput/schema.ts'

const encodeJson = <T, E, RD>(schema: Schema.Codec<T, E, RD, never>, value: T) =>
  Schema.encodeUnknownSync(Schema.fromJsonString(schema))(value)

const meta = {
  apiRequests: 3,
  apiRequestsCached: 1,
  rateLimitRemaining: 4_997,
  rateLimitLimit: 5_000,
}

describe('CLI JSON output contracts', () => {
  it('preserves representative status JSON', () => {
    const run = makeRun({
      id: 23601797547,
      runNumber: 1940,
      headBranch: 'example/feature',
      elapsedSeconds: 42,
    })
    const state = createSingleRunState({
      run,
      jobs: [
        makeJob({
          id: 69067527707,
          name: 'lint',
          durationSeconds: 37,
          runner: 'runner-host-a',
        }),
      ],
      runnerHostMap: [['runner-a', 'runner-host-a']],
    })

    expect(encodeJson(CiStateSchema, state)).toMatchInlineSnapshot(
      `"{"_tag":"Loaded","run":{"id":23601797547,"name":"CI","runNumber":1940,"headBranch":"example/feature","status":"completed","conclusion":"success","event":"push","workflowPath":".github/workflows/ci.yml","htmlUrl":"https://github.com/example-org/example-repo/actions/runs/23601797547","elapsedSeconds":42},"jobs":[{"id":69067527707,"name":"lint","status":"completed","conclusion":"success","durationSeconds":37,"runner":"runner-host-a","jobUrl":"https://github.com/example-org/example-repo/actions/runs/0/job/69067527707","failedStepName":null}],"errors":[],"annotations":[],"runnerHostMap":[["runner-a","runner-host-a"]],"prHealth":null,"summary":{"overallStatus":"passing","critical":[],"warnings":[]},"_meta":{"apiRequests":7,"apiRequestsCached":2,"rateLimitRemaining":4993,"rateLimitLimit":5000}}"`,
    )
  })

  it('preserves representative runners JSON', () => {
    expect(
      encodeJson(RunnersStateSchema, {
        _tag: 'Loaded',
        hosts: [
          {
            host: 'runner-host-a',
            status: 'reachable',
            jobs: [{ runner: 'runner-a', scaleSet: 'linux-x64', durationSeconds: 17 }],
          },
          { host: 'runner-host-b', status: 'unreachable', jobs: [] },
        ],
        _meta: meta,
      }),
    ).toMatchInlineSnapshot(
      `"{"_tag":"Loaded","hosts":[{"host":"runner-host-a","status":"reachable","jobs":[{"runner":"runner-a","scaleSet":"linux-x64","durationSeconds":17}]},{"host":"runner-host-b","status":"unreachable","jobs":[]}],"_meta":{"apiRequests":3,"apiRequestsCached":1,"rateLimitRemaining":4997,"rateLimitLimit":5000}}"`,
    )
  })

  it('preserves representative rerun JSON', () => {
    expect(
      encodeJson(MutationStateSchema, {
        _tag: 'Dispatched',
        runId: 23601797547,
        repo: 'example-org/example-repo',
        message: 'Re-running failed jobs',
        url: 'https://github.com/example-org/example-repo/actions/runs/23601797547',
        _meta: meta,
      }),
    ).toMatchInlineSnapshot(
      `"{"_tag":"Dispatched","runId":23601797547,"repo":"example-org/example-repo","message":"Re-running failed jobs","url":"https://github.com/example-org/example-repo/actions/runs/23601797547","_meta":{"apiRequests":3,"apiRequestsCached":1,"rateLimitRemaining":4997,"rateLimitLimit":5000}}"`,
    )
  })
})
