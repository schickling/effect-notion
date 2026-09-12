import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { ciExitCode } from '../src/isomorphic/renderers/CiOutput/app.ts'
import { CiNdjsonEvent, fromCiAction } from '../src/isomorphic/renderers/CiOutput/ndjson.ts'
import {
  type CiState,
  ciReducer,
  createInitialCiState,
} from '../src/isomorphic/renderers/CiOutput/schema.ts'

const meta = {
  apiRequests: 79,
  apiRequestsCached: 6,
  rateLimitRemaining: 4108,
  rateLimitLimit: 5000,
}

/**
 * Narrowed to `Loaded` so tests can read `run`/`jobs`/`summary` off it without
 * re-proving what the factory already guarantees.
 */
const loadedState = (status: string): Extract<CiState, { _tag: 'Loaded' }> => ({
  _tag: 'Loaded',
  run: {
    id: 70000000005,
    name: 'CI',
    runNumber: 1,
    headBranch: 'main',
    status,
    conclusion: null,
    event: 'pull_request',
    workflowPath: '.github/workflows/ci.yml',
    htmlUrl: 'https://github.com/o/r/actions/runs/1',
    elapsedSeconds: 120,
  },
  jobs: [
    {
      id: 1,
      name: 'lint',
      status: 'in_progress',
      conclusion: null,
      durationSeconds: 100,
      runner: 'nsc:x',
      runnerName: 'nsc-runner-x1y2z3w4v5',
      runnerKind: 'namespace',
      runnerInstance: 'x1y2z3w4v5',
      jobUrl: 'https://github.com/o/r/actions/runs/1/job/1',
      failedStepName: null,
    },
  ],
  errors: [],
  annotations: [],
  runnerHostMap: [],
  prHealth: null,
  summary: { overallStatus: 'in_progress', critical: [], warnings: [] },
  _meta: meta,
})

describe('ndjson watch liveness', () => {
  it('emits a Tick event carrying progress, pacing, and cost', () => {
    const events = fromCiAction({
      action: {
        _tag: 'Tick',
        tick: 7,
        elapsedSeconds: 63,
        pending: 19,
        completed: 5,
        changed: 0,
        nextPollSeconds: 20,
        _meta: meta,
      },
      prevState: loadedState('in_progress'),
    })

    expect(events).toEqual([
      {
        _tag: 'Tick',
        tick: 7,
        elapsedSeconds: 63,
        pending: 19,
        completed: 5,
        changed: 0,
        nextPollSeconds: 20,
        apiRequests: 79,
        apiRequestsCached: 6,
        rateLimitRemaining: 4108,
        rateLimitLimit: 5000,
      },
    ])
  })

  it('reports why the command stopped instead of exiting silently', () => {
    expect(
      fromCiAction({
        action: {
          _tag: 'SetError',
          error: 'Timeout',
          message: 'Watch timed out after 20s. Run is still in progress.',
        },
        prevState: loadedState('in_progress'),
      }),
    ).toEqual([
      {
        _tag: 'Aborted',
        reason: 'Timeout',
        message: 'Watch timed out after 20s. Run is still in progress.',
      },
    ])

    expect(
      fromCiAction({ action: { _tag: 'Interrupted' }, prevState: createInitialCiState() }),
    ).toEqual([
      { _tag: 'Aborted', reason: 'Interrupted', message: 'Watch cancelled by user (Ctrl+C)' },
    ])
  })

  it('ends an intentional first-failure watch with a terminal record', () => {
    const previous = loadedState('in_progress')
    const state = {
      ...previous,
      jobs: [
        {
          ...previous.jobs[0]!,
          status: 'completed',
          conclusion: 'failure',
        },
      ],
      summary: { overallStatus: 'failing' as const, critical: [], warnings: [] },
    }
    const action = {
      _tag: 'WatchTerminated' as const,
      reason: 'FirstFailure' as const,
      message:
        'Watch stopped after the first job failure. Workflow run 70000000005 is still in_progress.',
    }

    const events = fromCiAction({ action, prevState: state })

    expect(events).toEqual([
      {
        _tag: 'WatchTerminated',
        reason: 'FirstFailure',
        message: action.message,
      },
    ])
    expect(Schema.decodeUnknownSync(CiNdjsonEvent)(events[0])).toEqual(events[0])

    const nextState = ciReducer({ state, action })
    expect(nextState).toBe(state)
    expect(ciExitCode(nextState)).toBe(1)
  })

  it('does not claim a watch happened when a one-shot command fails', () => {
    expect(
      fromCiAction({
        action: {
          _tag: 'SetError',
          error: 'No repos configured',
          message: 'Could not detect repo from git remote. Use owner/repo as target to specify.',
        },
        prevState: createInitialCiState(),
      }),
    ).toEqual([
      {
        _tag: 'Aborted',
        reason: 'No repos configured',
        message: 'Could not detect repo from git remote. Use owner/repo as target to specify.',
      },
    ])
  })

  it('still suppresses unchanged job data so ticks stay small', () => {
    const prev = loadedState('in_progress')
    const events = fromCiAction({
      action: {
        _tag: 'SetLoaded',
        run: prev.run,
        jobs: prev.jobs,
        errors: [],
        annotations: [],
        runnerHostMap: [],
        prHealth: null,
        summary: prev.summary,
      },
      prevState: prev,
    })
    expect(events).toEqual([])
  })

  it('ignores elapsed duration drift but still reports preserved job fact changes', () => {
    const prev = loadedState('in_progress')
    const lint = prev.jobs[0]!
    const action = {
      _tag: 'SetLoaded' as const,
      run: prev.run,
      errors: [],
      annotations: [],
      runnerHostMap: [],
      prHealth: null,
      summary: prev.summary,
    }

    expect(
      fromCiAction({
        action: { ...action, jobs: [{ ...lint, durationSeconds: lint.durationSeconds + 1 }] },
        prevState: prev,
      }),
    ).toEqual([])

    expect(
      fromCiAction({
        action: {
          ...action,
          jobs: [{ ...lint, status: 'completed', conclusion: 'success', durationSeconds: 101 }],
        },
        prevState: prev,
      }),
    ).toContainEqual(
      expect.objectContaining({
        _tag: 'JobUpdate',
        jobId: lint.id,
        status: 'completed',
        conclusion: 'success',
        durationSeconds: 101,
      }),
    )
  })

  it('reports the verdict and every blocking failure when the run completes', () => {
    const prev = loadedState('in_progress')
    const lint = prev.jobs[0]!
    const events = fromCiAction({
      action: {
        _tag: 'SetLoaded',
        run: { ...prev.run, status: 'completed', conclusion: 'failure' },
        jobs: [
          { ...lint, status: 'completed', conclusion: 'timed_out' },
          { ...lint, id: 2, name: 'test', status: 'completed', conclusion: 'success' },
        ],
        errors: [],
        annotations: [],
        runnerHostMap: [],
        prHealth: null,
        summary: { overallStatus: 'failing', critical: [], warnings: [] },
      },
      prevState: prev,
    })

    const complete = events.find((e) => e._tag === 'RunComplete')
    // `timed_out` is blocking, so `failed` must count it — and `overallStatus` must
    // carry the same verdict `--output json` reports, since `conclusion` alone can be null.
    expect(complete).toEqual({
      _tag: 'RunComplete',
      conclusion: 'failure',
      overallStatus: 'failing',
      totalJobs: 2,
      failed: 1,
      passed: 1,
    })
    expect(Schema.decodeUnknownSync(CiNdjsonEvent)(complete)).toEqual(complete)
  })

  it('carries structured runner identity and requested step facts on JobUpdate', () => {
    const prev = loadedState('in_progress')
    const lint = prev.jobs[0]!
    const steps = [
      {
        name: 'Set up job',
        status: 'completed',
        conclusion: 'success',
        number: 1,
        startedAt: '2026-09-10T11:00:00.000Z',
        completedAt: '2026-09-10T11:00:06.000Z',
      },
    ]
    const events = fromCiAction({
      action: {
        _tag: 'SetLoaded',
        run: prev.run,
        jobs: [{ ...lint, status: 'completed', conclusion: 'success', steps }],
        errors: [],
        annotations: [],
        runnerHostMap: [],
        prHealth: null,
        summary: prev.summary,
      },
      prevState: prev,
    })

    const update = events.find((e) => e._tag === 'JobUpdate')
    expect(update).toEqual({
      _tag: 'JobUpdate',
      jobId: 1,
      name: 'lint',
      status: 'completed',
      conclusion: 'success',
      durationSeconds: 100,
      runner: 'nsc:x',
      runnerName: 'nsc-runner-x1y2z3w4v5',
      runnerKind: 'namespace',
      runnerInstance: 'x1y2z3w4v5',
      steps,
    })
    expect(Schema.decodeUnknownSync(CiNdjsonEvent)(update)).toEqual(update)
  })

  it('emits a JobUpdate when preserved runner or step facts change', () => {
    const prev = loadedState('in_progress')
    const lint = prev.jobs[0]!
    const steps = [
      {
        name: 'Set up job',
        status: 'in_progress',
        conclusion: null,
        number: 1,
        startedAt: '2026-09-10T11:00:00.000Z',
        completedAt: null,
      },
    ]
    const events = fromCiAction({
      action: {
        _tag: 'SetLoaded',
        run: prev.run,
        jobs: [
          {
            ...lint,
            runner: 'self:runner-1',
            runnerName: 'runner-1',
            runnerKind: 'self-hosted',
            runnerInstance: 'runner-1',
            steps,
          },
        ],
        errors: [],
        annotations: [],
        runnerHostMap: [],
        prHealth: null,
        summary: prev.summary,
      },
      prevState: prev,
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      _tag: 'JobUpdate',
      runnerKind: 'self-hosted',
      runnerInstance: 'runner-1',
      steps,
    })
  })
})
