/**
 * Run-selection regression for FB-276, driven by the real GitHub payloads captured
 * for schickling/dotfiles#1331 (head 5828e54f).
 *
 * The PR's head commit had exactly one workflow run — a queued `ci.yml` run — while
 * the `branch + event=pull_request` listing the resolver used contained only
 * `auto-review.yml` runs for *older* commits. Picking from the latter is what turned
 * "required CI never ran" into "passing".
 */
import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { WorkflowRunsResponse } from '../src/isomorphic/GitHubSchemas.ts'
import { selectRunForVerdict } from '../src/node/GitHubClient.ts'

const decodeRuns = (workflow_runs: readonly unknown[]) =>
  Schema.decodeUnknownSync(WorkflowRunsResponse)({
    total_count: workflow_runs.length,
    workflow_runs,
  }).workflow_runs

const run = ({
  id,
  name,
  path,
  head_sha,
  status,
  conclusion,
  event,
  created_at,
}: {
  id: number
  name: string
  path: string
  head_sha: string
  status: string
  conclusion: string | null
  event: string
  created_at: string
}) => ({
  id,
  name,
  path,
  head_branch: 'schickling-assistant/2026-07-27-otelite-devenv',
  head_sha,
  status,
  conclusion,
  workflow_id: 1,
  run_number: 1,
  run_attempt: 1,
  event,
  created_at,
  updated_at: created_at,
  run_started_at: created_at,
  html_url: `https://github.com/schickling/dotfiles/actions/runs/${id}`,
  jobs_url: `https://api.github.com/repos/schickling/dotfiles/actions/runs/${id}/jobs`,
  pull_requests: [],
})

/** GET /actions/runs?branch=<head>&event=pull_request — what the old resolver saw. */
const BRANCH_PULL_REQUEST_RUNS = decodeRuns([
  run({
    id: 30315115978,
    name: 'Auto-request review',
    path: '.github/workflows/auto-review.yml',
    head_sha: '2b442eee6d46371ef124a275983f672459a67c89',
    status: 'completed',
    conclusion: 'success',
    event: 'pull_request',
    created_at: '2026-07-27T23:44:34Z',
  }),
  run({
    id: 30257588086,
    name: 'Auto-request review',
    path: '.github/workflows/auto-review.yml',
    head_sha: '5be739ef0000000000000000000000000000dead',
    status: 'completed',
    conclusion: 'skipped',
    event: 'pull_request',
    created_at: '2026-07-27T10:19:10Z',
  }),
])

/** GET /actions/runs?head_sha=5828e54f — what the new resolver sees. */
const HEAD_SHA_RUNS = decodeRuns([
  run({
    id: 30397116975,
    name: 'CI',
    path: '.github/workflows/ci.yml',
    head_sha: '5828e54fb93bbe587c043b36c3e34fc481415f38',
    status: 'queued',
    conclusion: null,
    event: 'workflow_dispatch',
    created_at: '2026-07-28T20:37:05Z',
  }),
])

describe('selectRunForVerdict (FB-276)', () => {
  it('judges the newest run on its own jobs when no ci.yml run exists and none was demanded', () => {
    const picked = selectRunForVerdict({ runs: BRANCH_PULL_REQUEST_RUNS })

    expect(picked.run?.id).toBe(30315115978)
    expect(picked.run?.path).toBe('.github/workflows/auto-review.yml')
    // `ci.yml` is a preference, not a demand: a repo without one is not `no_checks`.
    expect(picked.expectedWorkflow).toBe(null)
    expect(picked.matchedExpectedWorkflow).toBe(true)
  })

  it('matches ci.yml among the head-commit runs, even on a non-pull_request event', () => {
    const picked = selectRunForVerdict({ runs: HEAD_SHA_RUNS })

    expect(picked.run?.id).toBe(30397116975)
    expect(picked.expectedWorkflow).toBe('ci.yml')
    expect(picked.matchedExpectedWorkflow).toBe(true)
    expect(picked.run?.head_sha).toBe('5828e54fb93bbe587c043b36c3e34fc481415f38')
  })

  it('prefers a ci.yml run over a newer run of another workflow when none was demanded', () => {
    const picked = selectRunForVerdict({
      runs: decodeRuns([
        run({
          id: 30315115978,
          name: 'Auto-request review',
          path: '.github/workflows/auto-review.yml',
          head_sha: '5828e54fb93bbe587c043b36c3e34fc481415f38',
          status: 'completed',
          conclusion: 'success',
          event: 'pull_request',
          created_at: '2026-07-27T23:44:34Z',
        }),
        run({
          id: 30257588086,
          name: 'CI',
          path: '.github/workflows/ci.yml',
          head_sha: '5828e54fb93bbe587c043b36c3e34fc481415f38',
          status: 'completed',
          conclusion: 'success',
          event: 'pull_request',
          created_at: '2026-07-27T10:19:10Z',
        }),
      ]),
    })

    expect(picked.run?.id).toBe(30257588086)
    expect(picked.expectedWorkflow).toBe('ci.yml')
    expect(picked.matchedExpectedWorkflow).toBe(true)
  })

  it('reports no run and no match for an empty candidate set', () => {
    expect(selectRunForVerdict({ runs: [] })).toEqual({
      run: null,
      expectedWorkflow: null,
      matchedExpectedWorkflow: false,
    })
  })

  it('honours an explicit --workflow preference', () => {
    expect(
      selectRunForVerdict({ runs: BRANCH_PULL_REQUEST_RUNS, preferWorkflow: 'auto-review.yml' }),
    ).toMatchObject({ expectedWorkflow: 'auto-review.yml', matchedExpectedWorkflow: true })
  })

  it('an explicit --workflow beats the ci.yml default among active runs', () => {
    const picked = selectRunForVerdict({
      runs: decodeRuns([
        run({
          id: 30397116975,
          name: 'CI',
          path: '.github/workflows/ci.yml',
          head_sha: '5828e54fb93bbe587c043b36c3e34fc481415f38',
          status: 'in_progress',
          conclusion: null,
          event: 'push',
          created_at: '2026-07-28T20:37:05Z',
        }),
        run({
          id: 30257588086,
          name: 'Deploy',
          path: '.github/workflows/deploy.yml',
          head_sha: '5828e54fb93bbe587c043b36c3e34fc481415f38',
          status: 'queued',
          conclusion: null,
          event: 'push',
          created_at: '2026-07-28T20:30:00Z',
        }),
      ]),
      preferWorkflow: 'deploy.yml',
      activeOnly: true,
    })

    expect(picked.run?.id).toBe(30257588086)
    expect(picked.expectedWorkflow).toBe('deploy.yml')
    expect(picked.matchedExpectedWorkflow).toBe(true)
  })

  it('reports an explicit --workflow that never ran, so the caller hears about it', () => {
    const picked = selectRunForVerdict({
      runs: HEAD_SHA_RUNS,
      preferWorkflow: 'release.yml',
    })

    expect(picked.run?.id).toBe(30397116975)
    expect(picked.expectedWorkflow).toBe('release.yml')
    expect(picked.matchedExpectedWorkflow).toBe(false)
  })

  it('skips completed runs when only active ones are wanted', () => {
    expect(selectRunForVerdict({ runs: BRANCH_PULL_REQUEST_RUNS, activeOnly: true })).toEqual({
      run: null,
      expectedWorkflow: null,
      matchedExpectedWorkflow: false,
    })
    expect(selectRunForVerdict({ runs: HEAD_SHA_RUNS, activeOnly: true }).run?.id).toBe(30397116975)
  })
})
