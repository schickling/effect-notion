/**
 * Test fixtures for Runners stories.
 *
 * Provides runner state factories with realistic runner-scaler host data.
 */

import { defaultApiMeta } from '../../../lib/apiMeta.ts'
import type { ActiveJobInfo, HostResult, RunnersAction, RunnersState } from '../schema.ts'

// =============================================================================
// Helpers
// =============================================================================

const makeJob = (overrides: Partial<ActiveJobInfo> = {}): ActiveJobInfo => ({
  runner: 'linux-host-a-1a2b3c4d',
  scaleSet: 'example-workspace',
  durationSeconds: 120,
  ...overrides,
})

const makeHost = (overrides: Partial<HostResult> = {}): HostResult => ({
  host: 'linux-host-a',
  status: 'reachable',
  jobs: [],
  ...overrides,
})

// =============================================================================
// State Factories
// =============================================================================

/** Loading state. */
export const loadingState = (): RunnersState => ({
  _tag: 'Loading',
  _meta: defaultApiMeta,
  message: 'Fetching runner status...',
})

/** Error state. */
export const errorState = (): RunnersState => ({
  _tag: 'Error',
  _meta: defaultApiMeta,
  error: 'SSHError',
  message: 'Failed to connect to runner hosts. Check SSH configuration.',
})

/** All 3 hosts reachable with multiple active jobs. */
export const allActiveState = (): RunnersState => ({
  _tag: 'Loaded',
  _meta: defaultApiMeta,
  hosts: [
    makeHost({
      host: 'linux-host-a',
      jobs: [
        makeJob({
          runner: 'linux-host-a-1a2b3c4d',
          scaleSet: 'example-workspace',
          durationSeconds: 245,
        }),
        makeJob({
          runner: 'linux-host-a-2b3c4d5e',
          scaleSet: 'example-infra',
          durationSeconds: 87,
        }),
        makeJob({
          runner: 'linux-host-a-3c4d5e6f',
          scaleSet: 'example-data',
          durationSeconds: 512,
        }),
      ],
    }),
    makeHost({
      host: 'linux-host-b',
      jobs: [
        makeJob({
          runner: 'linux-host-b-4d5e6f7a',
          scaleSet: 'example-workspace',
          durationSeconds: 178,
        }),
        makeJob({
          runner: 'linux-host-b-5e6f7a8b',
          scaleSet: 'example-service',
          durationSeconds: 63,
        }),
      ],
    }),
    makeHost({
      host: 'macos-host-a',
      jobs: [
        makeJob({
          runner: 'macos-host-a-6f7a8b9c',
          scaleSet: 'example-infra',
          durationSeconds: 934,
        }),
      ],
    }),
  ],
})

/** 2 hosts active, 1 unreachable. */
export const mixedStatusState = (): RunnersState => ({
  _tag: 'Loaded',
  _meta: defaultApiMeta,
  hosts: [
    makeHost({
      host: 'linux-host-a',
      jobs: [
        makeJob({
          runner: 'linux-host-a-1a2b3c4d',
          scaleSet: 'example-workspace',
          durationSeconds: 312,
        }),
        makeJob({ runner: 'linux-host-a-2b3c4d5e', scaleSet: 'example-data', durationSeconds: 45 }),
      ],
    }),
    makeHost({
      host: 'linux-host-b',
      status: 'unreachable',
      jobs: [],
    }),
    makeHost({
      host: 'macos-host-a',
      jobs: [
        makeJob({
          runner: 'macos-host-a-6f7a8b9c',
          scaleSet: 'example-infra',
          durationSeconds: 1823,
        }),
      ],
    }),
  ],
})

/** All hosts reachable but no active jobs. */
export const allIdleState = (): RunnersState => ({
  _tag: 'Loaded',
  _meta: defaultApiMeta,
  hosts: [
    makeHost({ host: 'linux-host-a', jobs: [] }),
    makeHost({ host: 'linux-host-b', jobs: [] }),
    makeHost({ host: 'macos-host-a', jobs: [] }),
  ],
})

/** All hosts unreachable. */
export const allUnreachableState = (): RunnersState => ({
  _tag: 'Loaded',
  _meta: defaultApiMeta,
  hosts: [
    makeHost({ host: 'linux-host-a', status: 'unreachable', jobs: [] }),
    makeHost({ host: 'linux-host-b', status: 'unreachable', jobs: [] }),
    makeHost({ host: 'macos-host-a', status: 'unreachable', jobs: [] }),
  ],
})

// =============================================================================
// Timeline Factory
// =============================================================================

const STEP_DURATION = 600

const createTimeline = (
  state: Extract<RunnersState, { _tag: 'Loaded' }>,
): Array<{ at: number; action: RunnersAction }> => [
  {
    at: STEP_DURATION,
    action: { _tag: 'SetRunners', hosts: state.hosts },
  },
]

export const createAllActiveTimeline = () =>
  createTimeline(allActiveState() as Extract<RunnersState, { _tag: 'Loaded' }>)

export const createMixedStatusTimeline = () =>
  createTimeline(mixedStatusState() as Extract<RunnersState, { _tag: 'Loaded' }>)

export const createAllIdleTimeline = () =>
  createTimeline(allIdleState() as Extract<RunnersState, { _tag: 'Loaded' }>)

export const createAllUnreachableTimeline = () =>
  createTimeline(allUnreachableState() as Extract<RunnersState, { _tag: 'Loaded' }>)

export const createErrorTimeline = (): Array<{ at: number; action: RunnersAction }> => {
  const s = errorState() as Extract<RunnersState, { _tag: 'Error' }>
  return [
    {
      at: STEP_DURATION,
      action: { _tag: 'SetError', error: s.error, message: s.message },
    },
  ]
}
