/**
 * `gh-ci-utils inspect --output json` contract.
 *
 * The contract an agent relies on is that `github` and `namespace` are
 * observations and `assessment` is the only derived value, so a reader can
 * always tell what was seen from what was concluded. These tests pin that
 * separation, the preserved raw timing data, and the exit-code rule that a
 * diagnosis — including `unknown` — is a successful run.
 */
import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import type { WorkflowJob } from '../src/isomorphic/GitHubSchemas.ts'
import { defaultApiMeta } from '../src/isomorphic/lib/apiMeta.ts'
import { classifyInspection } from '../src/isomorphic/lib/inspectAssessment.ts'
import {
  type InspectDisposition,
  type InspectNamespaceFacts,
  toInspectGitHubFacts,
} from '../src/isomorphic/lib/inspectFacts.ts'
import { inspectExitCode } from '../src/isomorphic/renderers/InspectOutput/app.ts'
import {
  type InspectState,
  InspectStateSchema,
} from '../src/isomorphic/renderers/InspectOutput/schema.ts'

const INSTANCE = 'abc123example'
const REPO = 'example-org/example-repo'

const rawJob: WorkflowJob = {
  id: 1001,
  run_id: 2001,
  name: 'build',
  status: 'in_progress',
  conclusion: null,
  started_at: new Date('2026-01-15T11:00:00.000Z'),
  completed_at: null,
  runner_name: `nsc-runner-${INSTANCE}`,
  labels: ['nscloud-ubuntu-24.04-amd64-8x16'],
  steps: [
    {
      name: 'Set up job',
      status: 'completed',
      conclusion: 'success',
      number: 1,
      started_at: new Date('2026-01-15T11:00:00.000Z'),
      completed_at: new Date('2026-01-15T11:00:06.000Z'),
    },
  ],
}

const reportedNamespace: InspectNamespaceFacts = {
  _tag: 'reported',
  job: {
    instanceId: INSTANCE,
    instanceStatus: 'running',
    instanceStatusRaw: 'RUNNING',
    runnerName: `nsc-runner-${INSTANCE}`,
    containerName: 'runner',
    repository: REPO,
    workflow: 'CI',
    jobName: 'build',
    destroyedAt: null,
  },
  usage: { _tag: 'not-requested' },
  commands: [
    ['auth', 'check-login'],
    ['github', 'job', 'describe', '1001', '-o', 'json'],
  ],
}

const loadedState = (namespace: InspectNamespaceFacts): InspectState => {
  const github = toInspectGitHubFacts({ job: rawJob, repo: REPO })
  return {
    _tag: 'Loaded',
    github,
    namespace,
    assessment: classifyInspection({ github, namespace }),
    _meta: defaultApiMeta,
  }
}

const encodeJson = (state: InspectState) =>
  Schema.encodeUnknownSync(Schema.fromJsonString(InspectStateSchema))(state)

describe('inspect --output json contract', () => {
  it('keeps github facts, namespace facts and the assessment in separate top-level groups', () => {
    const encoded: unknown = JSON.parse(encodeJson(loadedState(reportedNamespace)))
    expect(encoded).toMatchObject({
      _tag: 'Loaded',
      github: { repo: REPO, jobId: 1001, runnerKind: 'namespace' },
      namespace: { _tag: 'reported', job: { instanceId: INSTANCE } },
      assessment: { disposition: 'active' },
    })
  })

  it('preserves raw runner identity and step timings rather than summarising them away', () => {
    const state = loadedState(reportedNamespace)
    if (state._tag !== 'Loaded') throw new Error('expected Loaded')
    expect(state.github.runnerName).toBe(`nsc-runner-${INSTANCE}`)
    expect(state.github.runnerInstance).toBe(INSTANCE)
    expect(state.github.startedAt).toBe('2026-01-15T11:00:00.000Z')
    expect(state.github.completedAt).toBeNull()
    expect(state.github.labels).toEqual(['nscloud-ubuntu-24.04-amd64-8x16'])
    expect(state.github.steps).toEqual([
      {
        name: 'Set up job',
        status: 'completed',
        conclusion: 'success',
        number: 1,
        startedAt: '2026-01-15T11:00:00.000Z',
        completedAt: '2026-01-15T11:00:06.000Z',
      },
    ])
  })

  it('keeps every GitHub fact when nsc is absent, and says so in the assessment', () => {
    const state = loadedState({
      _tag: 'unavailable',
      reason: 'nsc-missing',
      detail: 'NotFound: nsc',
      commands: [['auth', 'check-login']],
    })
    if (state._tag !== 'Loaded') throw new Error('expected Loaded')
    expect(state.github.jobId).toBe(1001)
    expect(state.github.steps).toHaveLength(1)
    expect(state.assessment.disposition).toBe('unknown')
    expect(state.namespace._tag).toBe('unavailable')
    /** The encoded form must round-trip, so the reason vocabulary is in the schema. */
    expect(JSON.parse(encodeJson(state))).toMatchObject({
      namespace: { _tag: 'unavailable', reason: 'nsc-missing' },
    })
  })

  it('records the read-only nsc argv it ran, so a reader can audit the observation', () => {
    const encoded: unknown = JSON.parse(encodeJson(loadedState(reportedNamespace)))
    expect(encoded).toMatchObject({
      namespace: {
        commands: [
          ['auth', 'check-login'],
          ['github', 'job', 'describe', '1001', '-o', 'json'],
        ],
      },
    })
  })

  it('round-trips a loaded state through the schema unchanged', () => {
    const state = loadedState(reportedNamespace)
    expect(
      Schema.decodeUnknownSync(Schema.fromJsonString(InspectStateSchema))(encodeJson(state)),
    ).toEqual(state)
  })

  it('rejects a disposition outside the four it is allowed to claim', () => {
    const encoded: unknown = JSON.parse(encodeJson(loadedState(reportedNamespace)))
    const tampered = JSON.stringify({
      ...(typeof encoded === 'object' && encoded !== null ? encoded : {}),
      assessment: { disposition: 'healthy', evidence: [], limitations: [] },
    })
    expect(() =>
      Schema.decodeUnknownSync(Schema.fromJsonString(InspectStateSchema))(tampered),
    ).toThrow()
  })
})

describe('inspect exit codes', () => {
  const dispositions: ReadonlyArray<InspectDisposition> = [
    'active',
    'idle',
    'resource-pressure',
    'unknown',
  ]

  it('exits 0 for every loaded diagnosis, including unknown', () => {
    for (const disposition of dispositions) {
      const state: InspectState = {
        ...loadedState(reportedNamespace),
        _tag: 'Loaded',
        assessment: { disposition, evidence: [], limitations: [] },
        github: toInspectGitHubFacts({ job: rawJob, repo: REPO }),
        namespace: reportedNamespace,
        _meta: defaultApiMeta,
      }
      expect(inspectExitCode(state)).toBe(0)
    }
  })

  it('exits 0 while still loading', () =>
    expect(
      inspectExitCode({ _tag: 'Loading', message: 'Inspecting job...', _meta: defaultApiMeta }),
    ).toBe(0))

  it('exits 1 only when the command itself failed', () =>
    expect(
      inspectExitCode({
        _tag: 'Error',
        error: 'No repo',
        message: 'Could not detect a repo from the git remote.',
        _meta: defaultApiMeta,
      }),
    ).toBe(1))
})
