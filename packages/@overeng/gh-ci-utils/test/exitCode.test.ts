import { describe, expect, it } from 'vitest'

import { GitHubApiError } from '../src/isomorphic/Errors.ts'
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
import { MutationApp } from '../src/isomorphic/renderers/MutationOutput/app.ts'
import {
  logsVerdictConclusion,
  missingStepSessionAuthError,
  selectedStepLogsUnavailableAction,
  shouldFinalizeWatchWithNoLogs,
  unmatchedWorkflowLogAction,
  terminalStepLogErrorAction,
} from '../src/node/commands/logs.ts'

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

describe('MutationApp exitCode', () => {
  it('returns 2 for a mutation watch timeout', () => {
    expect(
      MutationApp.config.exitCode?.({
        _tag: 'Error',
        error: 'Timeout',
        message: 'Watch timed out after 30s.',
        _meta: defaultApiMeta,
      }),
    ).toBe(2)
  })

  it('uses the shared terminal-conclusion policy while watching', () => {
    const state = {
      _tag: 'Watching' as const,
      runId: 1,
      repo: 'example-org/example-repo',
      status: 'completed',
      conclusion: 'cancelled',
      jobs: [{ name: 'cleanup', status: 'completed', conclusion: 'neutral', runner: 'runner-a' }],
      _meta: defaultApiMeta,
    }

    expect(MutationApp.config.exitCode?.(state)).toBe(1)
  })
})

describe('LogsApp exitCode', () => {
  it.each(['failure', 'cancelled'])(
    'uses the %s run verdict while retaining a successful log section conclusion',
    (runConclusion) => {
      const verdictConclusion = logsVerdictConclusion({
        runConclusion,
        jobConclusions: ['success'],
      })
      const state = logsReducer({
        state: createInitialLogsState(),
        action: {
          _tag: 'SetLogs',
          jobName: 'build',
          sectionConclusion: 'success',
          verdictConclusion,
          lines: ['build passed'],
          notice: null,
          truncation: null,
        },
      })

      expect(state).toMatchObject({
        _tag: 'Loaded',
        conclusion: 'failure',
        sections: [{ jobName: 'build', conclusion: 'success' }],
      })
      expect(LogsApp.config.exitCode?.(state)).toBe(1)
    },
  )

  it('retains successful sections across ticks and replaces repeated sections in place', () => {
    const build = logsReducer({
      state: createInitialLogsState(),
      action: {
        _tag: 'SetLogs',
        sectionId: 'job-1',
        jobName: 'build',
        sectionConclusion: 'success',
        verdictConclusion: 'success',
        lines: ['build passed'],
        notice: null,
        truncation: null,
      },
    })
    const withLint = logsReducer({
      state: build,
      action: {
        _tag: 'SetLogs',
        sectionId: 'job-2',
        jobName: 'lint',
        sectionConclusion: 'success',
        verdictConclusion: 'success',
        lines: ['lint started'],
        notice: null,
        truncation: null,
      },
    })
    const finalState = logsReducer({
      state: withLint,
      action: {
        _tag: 'SetLogs',
        sectionId: 'job-2',
        jobName: 'lint',
        sectionConclusion: 'success',
        verdictConclusion: 'success',
        lines: ['lint passed'],
        notice: null,
        truncation: null,
      },
    })

    expect(finalState).toMatchObject({
      _tag: 'Loaded',
      jobName: '2 jobs',
      sections: [
        { id: 'job-1', jobName: 'build', lines: ['build passed'] },
        { id: 'job-2', jobName: 'lint', lines: ['lint passed'] },
      ],
      lines: [
        '── build (success) ──',
        'build passed',
        '',
        '── lint (success) ──',
        'lint passed',
        '',
      ],
    })
    expect(finalState._tag === 'Loaded' ? finalState.lines : []).not.toContain('lint started')
  })

  it('does not fail while a selected live step is still in progress', () => {
    const state = logsReducer({
      state: createInitialLogsState(),
      action: {
        _tag: 'SetLogs',
        jobName: 'build > compile',
        sectionConclusion: 'in_progress',
        verdictConclusion: 'success',
        lines: ['still compiling'],
        notice: null,
        truncation: null,
      },
    })

    expect(LogsApp.config.exitCode?.(state)).toBe(0)
  })

  it('maps a logs watch timeout to exit 2', () => {
    expect(
      LogsApp.config.exitCode?.({
        _tag: 'Error',
        error: 'Timeout',
        message: 'Watch timed out after 30s.',
        _meta: defaultApiMeta,
      }),
    ).toBe(2)
  })

  it('rejects an unmatched explicit workflow as inconclusive without fallback logs', () => {
    const action = unmatchedWorkflowLogAction({
      runId: 70000000123,
      repo: 'example-org/example-repo',
      selection: {
        prNumber: null,
        expectedHeadSha: null,
        expectedWorkflow: 'release.yml',
        matchedExpectedWorkflow: false,
        runHeadSha: 'fallback-sha',
      },
    })

    expect(action).toEqual({
      _tag: 'SetNoLogs',
      message:
        "No run matching workflow 'release.yml' was found in example-org/example-repo; logs from fallback run 70000000123 were not shown.",
      conclusion: 'no_checks',
    })
    if (action === null) return

    const state = logsReducer({ state: createInitialLogsState(), action })
    expect(state).toMatchObject({ _tag: 'NoLogs', conclusion: 'no_checks' })
    expect(LogsApp.config.exitCode?.(state)).toBe(3)
  })

  it.each(['startup_failure', 'action_required', 'cancelled'])(
    'keeps terminal run conclusion %s when no job log is blocking',
    (runConclusion) => {
      const conclusion = logsVerdictConclusion({
        runConclusion,
        jobConclusions: ['success'],
      })
      const state = logsReducer({
        state: createInitialLogsState(),
        action: {
          _tag: 'SetNoLogs',
          message: 'No matching jobs produced logs.',
          conclusion,
        },
      })

      expect(state).toMatchObject({ _tag: 'NoLogs', conclusion: 'failure' })
      expect(LogsApp.config.exitCode?.(state)).toBe(1)
    },
  )

  it('returns nonzero structured error state when --step lacks session auth', () => {
    const state = logsReducer({
      state: createInitialLogsState(),
      action: missingStepSessionAuthError,
    })

    expect(state).toMatchObject({
      _tag: 'Error',
      error: 'Session auth required',
      message: `Step filtering requires session auth (run 'gh-ci-utils auth login')`,
    })
    expect(LogsApp.config.exitCode?.(state)).toBe(1)
  })

  it.each(['one-shot', 'watch'])(
    'preserves a revoked-session error for %s selected-step output',
    () => {
      const failure = new GitHubApiError({
        message: 'GitHub session was rejected while resolving job 80000000002; sign in again',
        cause: 'HTTP 403',
      })
      const state = logsReducer({
        state: createInitialLogsState(),
        action: terminalStepLogErrorAction(failure),
      })

      expect(state).toMatchObject({
        _tag: 'Error',
        error: 'GitHubApiError',
        message: failure.message,
      })
      expect(LogsApp.config.exitCode?.(state)).toBe(1)
    },
  )

  it('returns a terminal nonzero state for one-shot selected-step publication lag', () => {
    const state = logsReducer({
      state: createInitialLogsState(),
      action: selectedStepLogsUnavailableAction(['build']),
    })

    expect(state).toMatchObject({
      _tag: 'Error',
      error: 'Logs unavailable',
      message: "Selected step logs are not available yet for job 'build'.",
    })
    expect(LogsApp.config.exitCode?.(state)).toBe(1)
  })

  it('keeps rendered live step logs and the blocking first-failure verdict', () => {
    const renderedLiveStepOutput = true
    let finalState = logsReducer({
      state: createInitialLogsState(),
      action: {
        _tag: 'SetLogs',
        jobName: 'build > compile',
        sectionConclusion: 'in_progress',
        verdictConclusion: 'failure',
        lines: ['still compiling'],
        notice: null,
        truncation: null,
      },
    })

    if (
      shouldFinalizeWatchWithNoLogs({
        watch: true,
        displayedJobCount: 0,
        renderedLiveStepOutput,
      })
    ) {
      finalState = logsReducer({
        state: finalState,
        action: {
          _tag: 'SetNoLogs',
          message: 'No matching jobs produced logs.',
          conclusion: 'failure',
        },
      })
    }

    expect(finalState).toMatchObject({
      _tag: 'Loaded',
      conclusion: 'failure',
      sections: [{ jobName: 'build > compile', conclusion: 'in_progress' }],
      lines: ['still compiling'],
    })
    expect(LogsApp.config.exitCode?.(finalState)).toBe(1)
  })
})
