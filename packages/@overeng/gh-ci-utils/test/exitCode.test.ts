import { describe, expect, it } from 'vitest'

import { defaultApiMeta } from '../src/isomorphic/lib/apiMeta.ts'
import { computeSummary, directRunSelection } from '../src/isomorphic/lib/summary.ts'
import type { WorkflowJobVM } from '../src/isomorphic/lib/viewModels.ts'
import { ciExitCode } from '../src/isomorphic/renderers/CiOutput/app.ts'
import type { CiState } from '../src/isomorphic/renderers/CiOutput/schema.ts'
import { LogsApp } from '../src/isomorphic/renderers/LogsOutput/app.ts'
import {
  createInitialLogsState,
  logsReducer,
} from '../src/isomorphic/renderers/LogsOutput/schema.ts'

const testRun = {
  id: 1,
  name: 'CI',
  runNumber: 1,
  headBranch: 'main',
  status: 'completed',
  conclusion: null,
  event: 'push',
  workflowPath: '.github/workflows/ci.yml',
  htmlUrl: 'https://github.com/test/test/actions/runs/1',
  elapsedSeconds: 60,
} as const

const loadedState = (conclusions: Array<string | null>): CiState => {
  const jobs: WorkflowJobVM[] = conclusions.map((c, i) => ({
    id: i,
    name: `job-${i}`,
    status: 'completed',
    conclusion: c,
    durationSeconds: 30,
    runner: 'runner-1',
    jobUrl: `https://github.com/test/test/actions/runs/1/job/${i}`,
    failedStepName: null,
  }))
  return {
    _tag: 'Loaded',
    run: testRun,
    jobs,
    errors: [],
    annotations: [],
    runnerHostMap: [],
    prHealth: null,
    summary: computeSummary({ run: testRun, jobs, prHealth: null, selection: directRunSelection }),
    _meta: defaultApiMeta,
  }
}

describe('CiApp exitCode', () => {
  it('returns 1 for generic error state', () => {
    expect(
      ciExitCode({
        _tag: 'Error',
        error: 'ApiError',
        message: 'something went wrong',
        _meta: defaultApiMeta,
      }),
    ).toBe(1)
  })

  it('returns 130 for interrupted', () => {
    expect(
      ciExitCode({
        _tag: 'Error',
        error: 'Interrupted',
        message: 'Watch cancelled by user (Ctrl+C)',
        _meta: defaultApiMeta,
      }),
    ).toBe(130)
  })

  it('returns 2 for timeout', () => {
    expect(
      ciExitCode({
        _tag: 'Error',
        error: 'Timeout',
        message: 'Watch timed out after 30s.',
        _meta: defaultApiMeta,
      }),
    ).toBe(2)
  })

  it('delegates a Loaded verdict to exitCodeForSummary', () => {
    // 3 is a summary verdict code (skipped -> inconclusive), not app wiring.
    expect(ciExitCode(loadedState(['skipped']))).toBe(3)
  })
})

describe('LogsApp exitCode', () => {
  it('preserves a failed watch verdict when a later tick displays successful logs', () => {
    const failed = logsReducer({
      state: createInitialLogsState(),
      action: {
        _tag: 'SetLogs',
        jobName: 'build',
        conclusion: 'failure',
        lines: ['build failed'],
        notice: null,
        truncation: null,
      },
    })
    const afterLaterSuccess = logsReducer({
      state: failed,
      action: {
        _tag: 'SetLogs',
        jobName: 'lint',
        conclusion: 'success',
        lines: ['lint passed'],
        notice: null,
        truncation: null,
      },
    })

    expect(afterLaterSuccess).toMatchObject({ _tag: 'Loaded', conclusion: 'failure' })
    expect(LogsApp.config.exitCode?.(afterLaterSuccess)).toBe(1)
  })
})
