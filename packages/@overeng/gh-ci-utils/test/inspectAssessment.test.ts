/**
 * `gh-ci-utils inspect` classification precedence.
 *
 * The classifier is the only place that turns two independent observations
 * into a claim, so every row here is a claim it is allowed — or forbidden — to
 * make. The forbidden ones matter most: a runner nobody could observe must
 * never be reported as idle, and pressure must never be inferred without a
 * usage sample.
 */
import { describe, expect, it } from 'vitest'

import { classifyInspection } from '../src/isomorphic/lib/inspectAssessment.ts'
import type {
  InspectGitHubFacts,
  InspectNamespaceFacts,
  NamespaceJobFacts,
  NamespaceUsage,
  NamespaceUsageState,
} from '../src/isomorphic/lib/inspectFacts.ts'

const INSTANCE = 'abc123example'

const github = (overrides: Partial<InspectGitHubFacts> = {}): InspectGitHubFacts => ({
  repo: 'example-org/example-repo',
  jobId: 1001,
  runId: 2001,
  name: 'build',
  status: 'in_progress',
  conclusion: null,
  startedAt: '2026-01-15T11:00:00.000Z',
  completedAt: null,
  durationSeconds: 120,
  runnerName: `nsc-runner-${INSTANCE}`,
  runnerKind: 'namespace',
  runnerInstance: INSTANCE,
  labels: [],
  steps: [],
  ...overrides,
})

const usage = (overrides: Partial<NamespaceUsage> = {}): NamespaceUsageState => ({
  _tag: 'sampled',
  sample: {
    instanceId: INSTANCE,
    githubJobId: '1001',
    allocatedCpu: 8,
    allocatedRamGb: 16,
    cpuMaxFraction: 0.5,
    ramMaxFraction: 0.5,
    createdAt: null,
    startedAt: null,
    destroyedAt: null,
    ...overrides,
  },
})

const reported = ({
  job = {},
  usageState = { _tag: 'not-requested' },
}: {
  job?: Partial<NamespaceJobFacts>
  usageState?: NamespaceUsageState
} = {}): InspectNamespaceFacts => ({
  _tag: 'reported',
  job: {
    instanceId: INSTANCE,
    instanceStatus: 'running',
    instanceStatusRaw: 'RUNNING',
    runnerName: `nsc-runner-${INSTANCE}`,
    containerName: 'runner',
    repository: 'example-org/example-repo',
    workflow: 'CI',
    jobName: 'build',
    destroyedAt: null,
    ...job,
  },
  usage: usageState,
  commands: [],
})

describe('classifyInspection precedence', () => {
  it('reports resource-pressure over active when CPU is at the threshold', () => {
    const assessment = classifyInspection({
      github: github(),
      namespace: reported({ usageState: usage({ cpuMaxFraction: 0.95 }) }),
    })
    expect(assessment.disposition).toBe('resource-pressure')
    expect(assessment.limitations).toEqual([])
  })

  it('reports resource-pressure when RAM is at the threshold and the job already finished', () => {
    expect(
      classifyInspection({
        github: github({ status: 'completed', conclusion: 'success' }),
        namespace: reported({
          job: { instanceStatus: 'destroyed', destroyedAt: '2026-01-15T11:05:00Z' },
          usageState: usage({ ramMaxFraction: 0.96 }),
        }),
      }).disposition,
    ).toBe('resource-pressure')
  })

  it('does not report resource-pressure just below the threshold', () =>
    expect(
      classifyInspection({
        github: github(),
        namespace: reported({
          usageState: usage({ cpuMaxFraction: 0.9499, ramMaxFraction: 0.9499 }),
        }),
      }).disposition,
    ).toBe('active'))

  it('never claims resource-pressure without a usage sample, however loaded the runner looks', () => {
    const assessment = classifyInspection({
      github: github(),
      namespace: reported({ usageState: { _tag: 'not-requested' } }),
    })
    expect(assessment.disposition).toBe('active')
    expect(assessment.limitations.join(' ')).toContain('--with-usage')
  })

  it('reports active only when GitHub and Namespace agree the job is running', () =>
    expect(classifyInspection({ github: github(), namespace: reported() }).disposition).toBe(
      'active',
    ))

  it('reports idle from a live instance with no running GitHub job', () =>
    expect(
      classifyInspection({
        github: github({ status: 'completed', conclusion: 'success' }),
        namespace: reported(),
      }).disposition,
    ).toBe('idle'))

  it('refuses idle without positive live-instance evidence', () => {
    const assessment = classifyInspection({
      github: github({ status: 'completed', conclusion: 'success' }),
      namespace: reported({ job: { instanceStatus: 'unknown', instanceStatusRaw: 'Provisioned' } }),
    })
    expect(assessment.disposition).toBe('unknown')
    expect(assessment.limitations.join(' ')).toContain('idle')
  })

  it('reports unknown for a completed job whose instance is gone', () =>
    expect(
      classifyInspection({
        github: github({
          status: 'completed',
          conclusion: 'success',
          completedAt: '2026-01-15T11:04:00.000Z',
        }),
        namespace: reported({
          job: { instanceStatus: 'destroyed', destroyedAt: '2026-01-15T11:05:00Z' },
        }),
      }).disposition,
    ).toBe('unknown'))

  it('reports unknown when GitHub and Namespace identify different instances', () => {
    const assessment = classifyInspection({
      github: github(),
      namespace: reported({ job: { instanceId: 'different-instance' } }),
    })
    expect(assessment.disposition).toBe('unknown')
    expect(assessment.limitations.join(' ')).toContain(INSTANCE)
    expect(assessment.limitations.join(' ')).toContain('different-instance')
  })

  it('reports unknown, not active, when the two sources conflict', () => {
    const assessment = classifyInspection({
      github: github(),
      namespace: reported({
        job: { instanceStatus: 'destroyed', destroyedAt: '2026-01-15T11:05:00Z' },
      }),
    })
    expect(assessment.disposition).toBe('unknown')
    expect(assessment.limitations.join(' ')).toContain('disagree')
  })

  it('reports unknown for a non-Namespace runner and says why', () => {
    const assessment = classifyInspection({
      github: github({
        runnerName: 'runnera-1234abcd',
        runnerKind: 'self-hosted',
        runnerInstance: 'runnera',
      }),
      namespace: { _tag: 'not-namespace-job', runnerKind: 'self-hosted' },
    })
    expect(assessment.disposition).toBe('unknown')
    expect(assessment.limitations.join(' ')).toContain('self-hosted')
  })

  it('reports unknown when nsc is missing, while keeping the GitHub observation as evidence', () => {
    const assessment = classifyInspection({
      github: github(),
      namespace: {
        _tag: 'unavailable',
        reason: 'nsc-missing',
        detail: 'NotFound: nsc',
        commands: [],
      },
    })
    expect(assessment.disposition).toBe('unknown')
    expect(assessment.evidence.join(' ')).toContain('1001')
    expect(assessment.limitations.join(' ')).toContain('nsc-missing')
  })

  it('reports unknown for an unauthenticated session rather than guessing liveness', () =>
    expect(
      classifyInspection({
        github: github(),
        namespace: {
          _tag: 'unavailable',
          reason: 'not-authenticated',
          detail: null,
          commands: [],
        },
      }).disposition,
    ).toBe('unknown'))
})
