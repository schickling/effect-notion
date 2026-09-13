/**
 * Runner identity + step timing carried through the job view model.
 *
 * The TUI shows an abbreviated runner label (`runnera`), but consumers — and the
 * runner-scaler host join — need the raw name GitHub reported (`runnera-1234abcd`).
 */
import { describe, expect, it } from 'vitest'

import type { WorkflowJob } from '../src/isomorphic/GitHubSchemas.ts'
import { toJobVM } from '../src/isomorphic/lib/summary.ts'
import { resolveRunnerDisplay } from '../src/isomorphic/renderers/CiOutput/schema.ts'

const RUN_HTML_URL = 'https://github.com/example-org/example-repo/actions/runs/2001'

const rawJob = (overrides: Partial<WorkflowJob> = {}): WorkflowJob => ({
  id: 1001,
  run_id: 2001,
  name: 'flake-build',
  status: 'completed',
  conclusion: 'success',
  started_at: new Date('2026-07-27T10:00:00Z'),
  completed_at: new Date('2026-07-27T10:05:00Z'),
  runner_name: 'runnera-1234abcd',
  labels: ['linux-x64'],
  steps: [],
  ...overrides,
})

describe('job view model runner identity', () => {
  it('keeps the raw runner name alongside the abbreviated display label', () => {
    const vm = toJobVM({ job: rawJob(), runHtmlUrl: RUN_HTML_URL, includeSteps: false })

    expect(vm.runner).toBe('runnera')
    expect(vm.runnerName).toBe('runnera-1234abcd')
    expect(vm.runnerKind).toBe('self-hosted')
    expect(vm.runnerInstance).toBe('runnera')
  })

  it('uses GitHub self-hosted labels when the runner name is not a scaler worker', () => {
    const vm = toJobVM({
      job: rawJob({ runner_name: 'runnera', labels: ['self-hosted', 'Linux', 'X64'] }),
      runHtmlUrl: RUN_HTML_URL,
      includeSteps: false,
    })

    expect(vm.runner).toBe('runnera')
    expect(vm.runnerKind).toBe('self-hosted')
    expect(vm.runnerInstance).toBe('runnera')
  })

  it('keeps the full Namespace runner id behind the truncated label', () => {
    const vm = toJobVM({
      job: rawJob({ runner_name: 'nsc-runner-abc123example' }),
      runHtmlUrl: RUN_HTML_URL,
      includeSteps: false,
    })

    expect(vm.runner).toBe('nsc:abc123')
    expect(vm.runnerName).toBe('nsc-runner-abc123example')
    expect(vm.runnerKind).toBe('namespace')
    expect(vm.runnerInstance).toBe('abc123example')
  })

  it('reports a job with no assigned runner as unknown, with no invented instance', () => {
    const vm = toJobVM({
      job: rawJob({ runner_name: null, status: 'queued', conclusion: null }),
      runHtmlUrl: RUN_HTML_URL,
      includeSteps: false,
    })

    expect(vm.runner).toBe('—')
    expect(vm.runnerName).toBeNull()
    expect(vm.runnerKind).toBe('unknown')
    expect(vm.runnerInstance).toBeNull()
  })

  it('leaves unrecognized runner names untouched', () => {
    const vm = toJobVM({
      job: rawJob({ runner_name: 'GitHub Actions 2' }),
      runHtmlUrl: RUN_HTML_URL,
      includeSteps: false,
    })

    expect(vm.runner).toBe('GitHub Actions 2')
    expect(vm.runnerKind).toBe('other')
    expect(vm.runnerInstance).toBe('GitHub Actions 2')
  })
})

describe('job view model step timing', () => {
  it('preserves GitHub step numbers and timestamps as ISO strings', () => {
    const vm = toJobVM({
      job: rawJob({
        steps: [
          {
            name: 'Set up job',
            status: 'completed',
            conclusion: 'success',
            number: 1,
            started_at: new Date('2026-07-27T10:00:00Z'),
            completed_at: new Date('2026-07-27T10:00:12Z'),
          },
          {
            name: 'Build flake outputs',
            status: 'in_progress',
            conclusion: null,
            number: 2,
            started_at: new Date('2026-07-27T10:00:12Z'),
            completed_at: null,
          },
        ],
      }),
      runHtmlUrl: RUN_HTML_URL,
      includeSteps: true,
    })

    expect(vm.steps).toEqual([
      {
        name: 'Set up job',
        status: 'completed',
        conclusion: 'success',
        number: 1,
        startedAt: '2026-07-27T10:00:00.000Z',
        completedAt: '2026-07-27T10:00:12.000Z',
      },
      {
        name: 'Build flake outputs',
        status: 'in_progress',
        conclusion: null,
        number: 2,
        startedAt: '2026-07-27T10:00:12.000Z',
        completedAt: null,
      },
    ])
  })
})

describe('runner host join', () => {
  const job = toJobVM({ job: rawJob(), runHtmlUrl: RUN_HTML_URL, includeSteps: false })

  it('joins on the raw runner name reported by runner-scaler', () => {
    expect(resolveRunnerDisplay({ job, entries: [['runnera-1234abcd', 'runner-a.example']] })).toBe(
      'runner-a.example',
    )
  })

  it('joins on a normalized runner name', () => {
    expect(resolveRunnerDisplay({ job, entries: [['runnera', 'runner-a.example']] })).toBe(
      'runner-a.example',
    )
  })

  it('falls back to the display label when the runner is unknown', () => {
    const queued = toJobVM({
      job: rawJob({ runner_name: null }),
      runHtmlUrl: RUN_HTML_URL,
      includeSteps: false,
    })

    expect(resolveRunnerDisplay({ job: queued, entries: [['runnera-1234abcd', 'runner-a']] })).toBe(
      '—',
    )
  })
})
