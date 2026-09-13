/**
 * `gh-ci-utils status --output json` synthetic contract fixtures
 * plus the verdict state table for FB-276.
 *
 * Fixture-driven: no network, no CLI, no TUI. Imports the production mapping and
 * verdict functions directly so the assertions describe the shipped contract.
 *
 * Run from `flakes/gh-ci-utils`:
 *   CI=1 bunx vitest run test/jsonContract.test.ts
 */
import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import type { WorkflowJob } from '../src/isomorphic/GitHubSchemas.ts'
import {
  computeSummary,
  directRunSelection,
  exitCodeForSummary,
  toJobVM,
  type RunSelection,
} from '../src/isomorphic/lib/summary.ts'
import {
  SummarySchema,
  WorkflowJobViewModel,
  type PrHealth,
  type RunInfo,
  type WorkflowJobVM,
} from '../src/isomorphic/lib/viewModels.ts'
import { CiStateSchema } from '../src/isomorphic/renderers/CiOutput/schema.ts'

// =============================================================================
// Fixtures
// =============================================================================

const RUN: RunInfo = {
  id: 70000000003,
  name: 'CI',
  runNumber: 101,
  headBranch: 'feature/synthetic-observability',
  status: 'completed',
  conclusion: 'success',
  event: 'pull_request',
  workflowPath: '.github/workflows/ci.yml',
  htmlUrl: 'https://github.com/example-org/example-repo/actions/runs/70000000003',
  elapsedSeconds: 960,
}

/** A raw API job with a failing step, so `failedStepName` has something to preserve. */
const rawJob: WorkflowJob = {
  id: 80000000001,
  run_id: RUN.id,
  name: 'flake-build',
  status: 'completed',
  conclusion: 'failure',
  started_at: new Date('2026-07-27T10:00:00Z'),
  completed_at: new Date('2026-07-27T10:05:00Z'),
  runner_name: 'linuxbuildera-1234abcd',
  labels: ['sh-linux-x64', 'nix'],
  steps: [
    {
      name: 'Set up job',
      status: 'completed',
      conclusion: 'success',
      number: 1,
      started_at: null,
      completed_at: null,
    },
    {
      name: 'Build flake outputs',
      status: 'completed',
      conclusion: 'failure',
      number: 2,
      started_at: null,
      completed_at: null,
    },
  ],
}

const job = (overrides: Partial<WorkflowJobVM> = {}): WorkflowJobVM => ({
  id: 1,
  name: 'build',
  status: 'completed',
  conclusion: 'success',
  durationSeconds: 300,
  runner: 'linuxbuildera',
  runnerName: 'linuxbuildera-1234abcd',
  runnerKind: 'self-hosted',
  runnerInstance: 'linuxbuildera',
  jobUrl: `${RUN.htmlUrl}/job/1`,
  failedStepName: null,
  ...overrides,
})

/** Selection for a PR whose head commit has a run of the expected workflow. */
const matchedPrSelection: RunSelection = {
  prNumber: 314,
  expectedHeadSha: 'deadbeef',
  expectedWorkflow: 'ci.yml',
  matchedExpectedWorkflow: true,
  runHeadSha: 'deadbeef',
}

/**
 * FB-276 with an explicit `--workflow`: the caller named a workflow that has no run
 * for the PR head commit, so the verdict must say so instead of judging another one.
 */
const missingWorkflowSelection: RunSelection = {
  prNumber: 314,
  expectedHeadSha: '1111111111111111111111111111111111111111',
  expectedWorkflow: 'ci.yml',
  matchedExpectedWorkflow: false,
  runHeadSha: '2222222222222222222222222222222222222222',
}

/**
 * A repo with no `ci.yml` and no `--workflow`: nothing was expected, so the run that
 * did happen for the head commit is judged on its own jobs.
 */
const noExpectationSelection: RunSelection = {
  prNumber: 314,
  expectedHeadSha: 'deadbeef',
  expectedWorkflow: null,
  matchedExpectedWorkflow: true,
  runHeadSha: 'deadbeef',
}

const encodeJson = <T, E, RD>(schema: Schema.Codec<T, E, RD, never>, value: T) =>
  Schema.encodeUnknownSync(Schema.fromJsonString(schema))(value)

// =============================================================================
// #927 — JSON output contract
// =============================================================================

describe('status --output json job contract (#927)', () => {
  it('omits jobs[].steps by default', () => {
    const vm = toJobVM({ job: rawJob, runHtmlUrl: RUN.htmlUrl, includeSteps: false })

    expect('steps' in vm).toBe(false)
    expect(Object.keys(encodeJson(WorkflowJobViewModel, vm) as never)).not.toContain('steps')
    expect(encodeJson(WorkflowJobViewModel, vm)).not.toContain('"steps"')
  })

  it('preserves jobs[].failedStepName when steps are omitted', () => {
    const vm = toJobVM({ job: rawJob, runHtmlUrl: RUN.htmlUrl, includeSteps: false })

    expect(vm.failedStepName).toBe('Build flake outputs')
    expect(encodeJson(WorkflowJobViewModel, vm)).toContain('"failedStepName":"Build flake outputs"')
  })

  it('includes jobs[].steps with --include-steps, and still preserves failedStepName', () => {
    const vm = toJobVM({ job: rawJob, runHtmlUrl: RUN.htmlUrl, includeSteps: true })

    expect(vm.steps).toEqual([
      {
        name: 'Set up job',
        status: 'completed',
        conclusion: 'success',
        number: 1,
        startedAt: null,
        completedAt: null,
      },
      {
        name: 'Build flake outputs',
        status: 'completed',
        conclusion: 'failure',
        number: 2,
        startedAt: null,
        completedAt: null,
      },
    ])
    expect(vm.failedStepName).toBe('Build flake outputs')
  })

  it('maps runner name, job timestamps, duration and job url', () => {
    const vm = toJobVM({ job: rawJob, runHtmlUrl: RUN.htmlUrl, includeSteps: false })

    expect(vm.runner).toBe('linuxbuildera')
    expect(vm.durationSeconds).toBe(300)
    expect(vm.startedAt).toBe('2026-07-27T10:00:00.000Z')
    expect(encodeJson(WorkflowJobViewModel, vm)).toContain('"startedAt":"2026-07-27T10:00:00.000Z"')
    expect(vm.completedAt).toBe('2026-07-27T10:05:00.000Z')
    expect(vm.jobUrl).toBe(`${RUN.htmlUrl}/job/${rawJob.id}`)
  })

  it('still decodes job payloads written before completion finality was tracked', () => {
    const legacyJob = job()

    expect(Schema.decodeUnknownSync(WorkflowJobViewModel)(legacyJob)).toEqual(legacyJob)
  })

  it('exposes a top-level summary in the status state', () => {
    const jobs = [toJobVM({ job: rawJob, runHtmlUrl: RUN.htmlUrl, includeSteps: false })]
    const summary = computeSummary({
      run: RUN,
      jobs,
      prHealth: null,
      selection: matchedPrSelection,
    })
    const encoded = encodeJson(CiStateSchema, {
      _tag: 'Loaded',
      run: RUN,
      jobs,
      errors: [],
      annotations: [],
      runnerHostMap: [],
      prHealth: null,
      summary,
      _meta: {
        apiRequests: 6,
        apiRequestsCached: 2,
        rateLimitRemaining: 4993,
        rateLimitLimit: 5000,
      },
    })

    expect(JSON.parse(encoded)).toHaveProperty('summary.overallStatus', 'failing')
    expect(JSON.parse(encoded).summary.critical[0]).toMatchObject({
      jobName: 'flake-build',
      failedStepName: 'Build flake outputs',
      fixCommand: `gh-ci-utils logs ${RUN.id} --job ${rawJob.id}`,
    })
  })

  it('round-trips the summary schema', () => {
    const summary = computeSummary({
      run: RUN,
      jobs: [job()],
      prHealth: null,
      selection: matchedPrSelection,
    })
    expect(Schema.decodeUnknownSync(SummarySchema)(JSON.parse(JSON.stringify(summary)))).toEqual(
      summary,
    )
  })
})

// =============================================================================
// FB-276 — verdict state table
// =============================================================================

const verdict = ({
  conclusions,
  selection = matchedPrSelection,
  statuses,
  runStatus = 'completed',
  runConclusion = 'success',
  prHealth = null,
}: {
  conclusions: readonly (string | null)[]
  selection?: RunSelection
  statuses?: readonly string[]
  runStatus?: string
  runConclusion?: string | null
  prHealth?: PrHealth | null
}) => {
  const jobs = conclusions.map((conclusion, i) =>
    job({ id: i + 1, conclusion, status: statuses?.[i] ?? 'completed' }),
  )
  const run = { ...RUN, status: runStatus, conclusion: runConclusion }
  const summary = computeSummary({ run, jobs, prHealth, selection })
  return {
    status: summary.overallStatus,
    exitCode: exitCodeForSummary({ summary, prHealth }),
  }
}

describe('status verdict state table (FB-276)', () => {
  it('all success -> passing / 0', () => {
    expect(verdict({ conclusions: ['success', 'success'] })).toEqual({
      status: 'passing',
      exitCode: 0,
    })
  })

  it('one skipped only -> skipped / 3', () => {
    expect(verdict({ conclusions: ['skipped'] })).toEqual({ status: 'skipped', exitCode: 3 })
  })

  it('skipped + success -> passing / 0', () => {
    expect(verdict({ conclusions: ['skipped', 'success'] })).toEqual({
      status: 'passing',
      exitCode: 0,
    })
  })

  it('completed run with no jobs at all -> no_checks / 3', () => {
    expect(verdict({ conclusions: [] })).toEqual({ status: 'no_checks', exitCode: 3 })
  })

  it('queued run whose jobs have not appeared yet -> in_progress / 0', () => {
    expect(verdict({ conclusions: [], runStatus: 'queued' })).toEqual({
      status: 'in_progress',
      exitCode: 0,
    })
  })

  it('expected workflow never ran for the head commit -> no_checks / 3 even when the inspected run is green', () => {
    expect(verdict({ conclusions: ['success'], selection: missingWorkflowSelection })).toEqual({
      status: 'no_checks',
      exitCode: 3,
    })
  })

  it('one failure -> failing / 1', () => {
    expect(verdict({ conclusions: ['success', 'failure'] })).toEqual({
      status: 'failing',
      exitCode: 1,
    })
  })

  it('timed_out is blocking, not green', () => {
    expect(verdict({ conclusions: ['timed_out'] })).toEqual({ status: 'failing', exitCode: 1 })
  })

  it('cancelled -> cancelled / 1', () => {
    expect(verdict({ conclusions: ['cancelled'] })).toEqual({ status: 'cancelled', exitCode: 1 })
  })

  it.each([[[]], [['success']]] as const)(
    'run-level cancellation is terminal with job conclusions %j',
    (conclusions) => {
      expect(verdict({ conclusions, runConclusion: 'cancelled' })).toEqual({
        status: 'cancelled',
        exitCode: 1,
      })
    },
  )

  it.each([[[]], [['success']]] as const)(
    'a blocking run-level conclusion fails with job conclusions %j',
    (conclusions) => {
      expect(verdict({ conclusions, runConclusion: 'startup_failure' })).toEqual({
        status: 'failing',
        exitCode: 1,
      })
    },
  )

  it('queued job -> in_progress / 0', () => {
    expect(verdict({ conclusions: [null], statuses: ['queued'] })).toEqual({
      status: 'in_progress',
      exitCode: 0,
    })
  })

  it('a job GitHub has only requested -> in_progress / 0', () => {
    expect(verdict({ conclusions: [null], statuses: ['requested'] })).toEqual({
      status: 'in_progress',
      exitCode: 0,
    })
  })

  it('neutral is non-blocking, so neutral + success -> passing / 0', () => {
    expect(verdict({ conclusions: ['neutral', 'success'] })).toEqual({
      status: 'passing',
      exitCode: 0,
    })
  })

  it('rejects a blocking conclusion from the wrong workflow before judging it', () => {
    expect(verdict({ conclusions: ['failure'], selection: missingWorkflowSelection })).toEqual({
      status: 'no_checks',
      exitCode: 3,
    })
  })

  it('rejects a blocking conclusion from a stale run before judging it', () => {
    expect(
      verdict({
        conclusions: ['failure'],
        selection: { ...matchedPrSelection, runHeadSha: 'cafebabe' },
      }),
    ).toEqual({ status: 'no_checks', exitCode: 3 })
  })

  it('a stale run (verdict describes another commit) -> no_checks / 3', () => {
    expect(
      verdict({
        conclusions: ['success'],
        selection: { ...matchedPrSelection, runHeadSha: 'cafebabe' },
      }),
    ).toEqual({ status: 'no_checks', exitCode: 3 })
  })

  it('run-id targets carry no expectation, so their own jobs decide', () => {
    expect(verdict({ conclusions: ['success'], selection: directRunSelection })).toEqual({
      status: 'passing',
      exitCode: 0,
    })
  })

  it('no expectation at all (repo without ci.yml) -> the run that did happen decides', () => {
    expect(verdict({ conclusions: ['success'], selection: noExpectationSelection })).toEqual({
      status: 'passing',
      exitCode: 0,
    })
    expect(verdict({ conclusions: ['failure'], selection: noExpectationSelection })).toEqual({
      status: 'failing',
      exitCode: 1,
    })
  })

  it('merge conflicts block even when nothing authoritative ran -> no_checks / 1', () => {
    expect(
      verdict({
        conclusions: [],
        prHealth: { prNumber: 314, mergeable: 'CONFLICTING', behindBy: 0, baseRefName: 'main' },
      }),
    ).toEqual({ status: 'no_checks', exitCode: 1 })
  })

  it('a branch behind base blocks even when nothing authoritative ran -> no_checks / 1', () => {
    expect(
      verdict({
        conclusions: [],
        prHealth: { prNumber: 314, mergeable: 'MERGEABLE', behindBy: 4, baseRefName: 'main' },
      }),
    ).toEqual({ status: 'no_checks', exitCode: 1 })
  })

  it('a branch behind base blocks even with all-passing jobs -> passing / 1', () => {
    expect(
      verdict({
        conclusions: ['success', 'success'],
        prHealth: { prNumber: 314, mergeable: 'MERGEABLE', behindBy: 5, baseRefName: 'main' },
      }),
    ).toEqual({ status: 'passing', exitCode: 1 })
  })

  it('clean PR health with all-passing jobs -> passing / 0', () => {
    expect(
      verdict({
        conclusions: ['success', 'success'],
        prHealth: { prNumber: 314, mergeable: 'MERGEABLE', behindBy: 0, baseRefName: 'main' },
      }),
    ).toEqual({ status: 'passing', exitCode: 0 })
  })

  it('UNKNOWN mergeable state is not a blocker -> passing / 0', () => {
    expect(
      verdict({
        conclusions: ['success'],
        prHealth: { prNumber: 314, mergeable: 'UNKNOWN', behindBy: 0, baseRefName: 'main' },
      }),
    ).toEqual({ status: 'passing', exitCode: 0 })
  })
})

describe('status verdict warnings (FB-276)', () => {
  it('names the missing workflow and the commit it is missing for', () => {
    const summary = computeSummary({
      run: { ...RUN, workflowPath: '.github/workflows/auto-review.yml' },
      jobs: [job({ conclusion: 'skipped' })],
      prHealth: null,
      selection: missingWorkflowSelection,
    })

    expect(summary.overallStatus).toBe('no_checks')
    expect(summary.warnings).toEqual([
      {
        _tag: 'ExpectedWorkflowMissing',
        workflow: 'ci.yml',
        headSha: '1111111111111111111111111111111111111111',
        inspectedWorkflowPath: '.github/workflows/auto-review.yml',
      },
      {
        _tag: 'StaleRun',
        expectedHeadSha: '1111111111111111111111111111111111111111',
        runHeadSha: '2222222222222222222222222222222222222222',
      },
    ])
  })

  it('keeps PR health warnings and their exit code', () => {
    const summary = computeSummary({
      run: RUN,
      jobs: [job()],
      prHealth: { prNumber: 314, mergeable: 'CONFLICTING', behindBy: 3, baseRefName: 'main' },
      selection: matchedPrSelection,
    })

    expect(summary.overallStatus).toBe('passing')
    expect(summary.warnings.map((w) => w._tag)).toEqual(['MergeConflicts', 'BranchBehind'])
    expect(
      exitCodeForSummary({
        summary,
        prHealth: { prNumber: 314, mergeable: 'CONFLICTING', behindBy: 3, baseRefName: 'main' },
      }),
    ).toBe(1)
  })
})
