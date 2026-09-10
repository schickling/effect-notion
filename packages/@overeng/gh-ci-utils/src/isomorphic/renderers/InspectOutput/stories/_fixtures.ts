/**
 * Test fixtures for Inspect stories.
 *
 * One factory per disposition, each built from facts that actually justify it,
 * so a story cannot show a verdict the classifier would not produce.
 */

import { defaultApiMeta } from '../../../lib/apiMeta.ts'
import { classifyInspection } from '../../../lib/inspectAssessment.ts'
import type {
  InspectGitHubFacts,
  InspectNamespaceFacts,
  NamespaceJobFacts,
  NamespaceUsage,
} from '../../../lib/inspectFacts.ts'
import type { InspectAction, InspectState } from '../schema.ts'

// =============================================================================
// Helpers
// =============================================================================

const REPO = 'schickling/dotfiles'
const INSTANCE = 'psmnb4mkjm3mq'

const githubFacts = (overrides: Partial<InspectGitHubFacts> = {}): InspectGitHubFacts => ({
  repo: REPO,
  jobId: 69067527707,
  runId: 23601797547,
  name: 'build',
  status: 'in_progress',
  conclusion: null,
  startedAt: '2026-09-10T11:00:00.000Z',
  completedAt: null,
  durationSeconds: 214,
  runnerName: `nsc-runner-${INSTANCE}`,
  runnerKind: 'namespace',
  runnerInstance: INSTANCE,
  labels: ['nscloud-ubuntu-24.04-amd64-8x16'],
  steps: [
    {
      name: 'Set up job',
      status: 'completed',
      conclusion: 'success',
      number: 1,
      startedAt: '2026-09-10T11:00:00.000Z',
      completedAt: '2026-09-10T11:00:06.000Z',
    },
    {
      name: 'nix build',
      status: 'in_progress',
      conclusion: null,
      number: 2,
      startedAt: '2026-09-10T11:00:06.000Z',
      completedAt: null,
    },
  ],
  ...overrides,
})

const namespaceJob = (overrides: Partial<NamespaceJobFacts> = {}): NamespaceJobFacts => ({
  instanceId: INSTANCE,
  instanceStatus: 'running',
  instanceStatusRaw: 'RUNNING',
  runnerName: `nsc-runner-${INSTANCE}`,
  containerName: 'runner',
  repository: REPO,
  workflow: 'CI',
  jobName: 'build',
  destroyedAt: null,
  ...overrides,
})

const usageSample = (overrides: Partial<NamespaceUsage> = {}): NamespaceUsage => ({
  instanceId: INSTANCE,
  githubJobId: '69067527707',
  allocatedCpu: 8,
  allocatedRamGb: 16,
  cpuMaxFraction: 0.61,
  ramMaxFraction: 0.34,
  createdAt: '2026-09-10 10:59:55 +0000 UTC',
  startedAt: '2026-09-10 11:00:00 +0000 UTC',
  destroyedAt: null,
  ...overrides,
})

/** Build a `Loaded` state whose assessment comes from the real classifier. */
const loaded = ({
  github,
  namespace,
}: {
  github: InspectGitHubFacts
  namespace: InspectNamespaceFacts
}): InspectState => ({
  _tag: 'Loaded',
  github,
  namespace,
  assessment: classifyInspection({ github, namespace }),
  _meta: defaultApiMeta,
})

// =============================================================================
// State Factories
// =============================================================================

/** Loading state. */
export const loadingState = (): InspectState => ({
  _tag: 'Loading',
  message: 'Inspecting job...',
  _meta: defaultApiMeta,
})

/** Error state — the command itself could not run. */
export const errorState = (): InspectState => ({
  _tag: 'Error',
  error: 'No repo',
  message: 'Could not detect a repo from the git remote. Pass --repo owner/name.',
  _meta: defaultApiMeta,
})

/** A running job on a live instance: both sources agree. */
export const activeState = (): InspectState =>
  loaded({
    github: githubFacts(),
    namespace: {
      _tag: 'reported',
      job: namespaceJob(),
      usage: { _tag: 'sampled', sample: usageSample() },
      commands: [],
    },
  })

/** A live instance with no running job. */
export const idleState = (): InspectState =>
  loaded({
    github: githubFacts({
      status: 'completed',
      conclusion: 'success',
      completedAt: '2026-09-10T11:03:34.000Z',
    }),
    namespace: {
      _tag: 'reported',
      job: namespaceJob(),
      usage: { _tag: 'not-requested' },
      commands: [],
    },
  })

/** A runner pinned at its RAM allocation. */
export const resourcePressureState = (): InspectState =>
  loaded({
    github: githubFacts(),
    namespace: {
      _tag: 'reported',
      job: namespaceJob(),
      usage: {
        _tag: 'sampled',
        sample: usageSample({ cpuMaxFraction: 0.72, ramMaxFraction: 0.987 }),
      },
      commands: [],
    },
  })

/** No `nsc` on the machine: GitHub facts survive, the verdict does not. */
export const nscMissingState = (): InspectState =>
  loaded({
    github: githubFacts(),
    namespace: {
      _tag: 'unavailable',
      reason: 'nsc-missing',
      detail: 'NotFound: nsc',
      commands: [['auth', 'check-login']],
    },
  })

/** A self-hosted runner, which Namespace was never asked about. */
export const notNamespaceState = (): InspectState =>
  loaded({
    github: githubFacts({
      runnerName: 'dev3-6038ddf9',
      runnerKind: 'self-hosted',
      runnerInstance: 'dev3',
      labels: ['self-hosted', 'dev3'],
    }),
    namespace: { _tag: 'not-namespace-job', runnerKind: 'self-hosted' },
  })

// =============================================================================
// Timeline Factory
// =============================================================================

const STEP_DURATION = 600

const createTimeline = (
  state: Extract<InspectState, { _tag: 'Loaded' }>,
): Array<{ at: number; action: InspectAction }> => [
  {
    at: STEP_DURATION,
    action: {
      _tag: 'SetInspection',
      github: state.github,
      namespace: state.namespace,
      assessment: state.assessment,
    },
  },
]

const loadedOrThrow = (state: InspectState): Extract<InspectState, { _tag: 'Loaded' }> => {
  if (state._tag !== 'Loaded') throw new Error(`expected a Loaded fixture, got ${state._tag}`)
  return state
}

export const createActiveTimeline = () => createTimeline(loadedOrThrow(activeState()))

export const createIdleTimeline = () => createTimeline(loadedOrThrow(idleState()))

export const createResourcePressureTimeline = () =>
  createTimeline(loadedOrThrow(resourcePressureState()))

export const createNscMissingTimeline = () => createTimeline(loadedOrThrow(nscMissingState()))

export const createNotNamespaceTimeline = () => createTimeline(loadedOrThrow(notNamespaceState()))

export const createErrorTimeline = (): Array<{ at: number; action: InspectAction }> => [
  {
    at: STEP_DURATION,
    action: {
      _tag: 'SetError',
      error: 'No repo',
      message: 'Could not detect a repo from the git remote. Pass --repo owner/name.',
    },
  },
]
