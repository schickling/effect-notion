/**
 * Runner identity + step timing carried through the job view model.
 *
 * The TUI shows an abbreviated runner label (`dev3`), but consumers — and the
 * runner-scaler host join — need the raw name GitHub reported (`dev3-6038ddf9`).
 */
import { describe, expect, it } from 'vitest'

import type { WorkflowJob } from '../src/isomorphic/GitHubSchemas.ts'
import { toJobVM } from '../src/isomorphic/lib/summary.ts'
import { resolveRunnerDisplay } from '../src/isomorphic/renderers/CiOutput/schema.ts'

const RUN_HTML_URL = 'https://github.com/schickling/dotfiles/actions/runs/30397116975'

const rawJob = (overrides: Partial<WorkflowJob> = {}): WorkflowJob => ({
  id: 69067527707,
  run_id: 30397116975,
  name: 'flake-build',
  status: 'completed',
  conclusion: 'success',
  started_at: new Date('2026-07-27T10:00:00Z'),
  completed_at: new Date('2026-07-27T10:05:00Z'),
  runner_name: 'dev3-6038ddf9',
  labels: ['sh-linux-x64'],
  steps: [],
  ...overrides,
})

describe('job view model runner identity', () => {
  it('keeps the raw runner name alongside the abbreviated display label', () => {
    const vm = toJobVM({ job: rawJob(), runHtmlUrl: RUN_HTML_URL, includeSteps: false })

    expect(vm.runner).toBe('dev3')
    expect(vm.runnerName).toBe('dev3-6038ddf9')
    expect(vm.runnerKind).toBe('self-hosted')
    expect(vm.runnerInstance).toBe('dev3')
  })

  it('uses GitHub self-hosted labels when the runner name is not a scaler worker', () => {
    const vm = toJobVM({
      job: rawJob({ runner_name: 'dev3', labels: ['self-hosted', 'Linux', 'X64'] }),
      runHtmlUrl: RUN_HTML_URL,
      includeSteps: false,
    })

    expect(vm.runner).toBe('dev3')
    expect(vm.runnerKind).toBe('self-hosted')
    expect(vm.runnerInstance).toBe('dev3')
  })

  it('keeps the full Namespace runner id behind the truncated label', () => {
    const vm = toJobVM({
      job: rawJob({ runner_name: 'nsc-runner-psmnb4mkjm3mq' }),
      runHtmlUrl: RUN_HTML_URL,
      includeSteps: false,
    })

    expect(vm.runner).toBe('nsc:psmnb4')
    expect(vm.runnerName).toBe('nsc-runner-psmnb4mkjm3mq')
    expect(vm.runnerKind).toBe('namespace')
    expect(vm.runnerInstance).toBe('psmnb4mkjm3mq')
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
    expect(
      resolveRunnerDisplay({ job, entries: [['dev3-6038ddf9', 'dev3.tail-scale.ts.net']] }),
    ).toBe('dev3.tail-scale.ts.net')
  })

  it('does not join on the abbreviated label', () => {
    expect(resolveRunnerDisplay({ job, entries: [['dev3', 'wrong-host']] })).toBe('dev3')
  })

  it('falls back to the display label when the runner is unknown', () => {
    const queued = toJobVM({
      job: rawJob({ runner_name: null }),
      runHtmlUrl: RUN_HTML_URL,
      includeSteps: false,
    })

    expect(resolveRunnerDisplay({ job: queued, entries: [['dev3-6038ddf9', 'dev3']] })).toBe('—')
  })
})
