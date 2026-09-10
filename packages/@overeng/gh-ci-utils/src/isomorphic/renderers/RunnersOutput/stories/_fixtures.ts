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
  runner: 'dev3-1be1cc5e',
  scaleSet: 'mr-all',
  durationSeconds: 120,
  ...overrides,
})

const makeHost = (overrides: Partial<HostResult> = {}): HostResult => ({
  host: 'dev3',
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
      host: 'dev3',
      jobs: [
        makeJob({ runner: 'dev3-1be1cc5e', scaleSet: 'mr-all', durationSeconds: 245 }),
        makeJob({ runner: 'dev3-a7f3e012', scaleSet: 'dotfiles', durationSeconds: 87 }),
        makeJob({ runner: 'dev3-c4d92b8f', scaleSet: 'livestore', durationSeconds: 512 }),
      ],
    }),
    makeHost({
      host: 'dev4',
      jobs: [
        makeJob({ runner: 'dev4-0a339ba2', scaleSet: 'mr-all', durationSeconds: 178 }),
        makeJob({ runner: 'dev4-e5b14d67', scaleSet: 'stiftung', durationSeconds: 63 }),
      ],
    }),
    makeHost({
      host: 'mbp2021',
      jobs: [makeJob({ runner: 'mbp2021-f8c21a3e', scaleSet: 'dotfiles', durationSeconds: 934 })],
    }),
  ],
})

/** 2 hosts active, 1 unreachable. */
export const mixedStatusState = (): RunnersState => ({
  _tag: 'Loaded',
  _meta: defaultApiMeta,
  hosts: [
    makeHost({
      host: 'dev3',
      jobs: [
        makeJob({ runner: 'dev3-1be1cc5e', scaleSet: 'mr-all', durationSeconds: 312 }),
        makeJob({ runner: 'dev3-a7f3e012', scaleSet: 'livestore', durationSeconds: 45 }),
      ],
    }),
    makeHost({
      host: 'dev4',
      status: 'unreachable',
      jobs: [],
    }),
    makeHost({
      host: 'mbp2021',
      jobs: [makeJob({ runner: 'mbp2021-f8c21a3e', scaleSet: 'dotfiles', durationSeconds: 1823 })],
    }),
  ],
})

/** All hosts reachable but no active jobs. */
export const allIdleState = (): RunnersState => ({
  _tag: 'Loaded',
  _meta: defaultApiMeta,
  hosts: [
    makeHost({ host: 'dev3', jobs: [] }),
    makeHost({ host: 'dev4', jobs: [] }),
    makeHost({ host: 'mbp2021', jobs: [] }),
  ],
})

/** All hosts unreachable. */
export const allUnreachableState = (): RunnersState => ({
  _tag: 'Loaded',
  _meta: defaultApiMeta,
  hosts: [
    makeHost({ host: 'dev3', status: 'unreachable', jobs: [] }),
    makeHost({ host: 'dev4', status: 'unreachable', jobs: [] }),
    makeHost({ host: 'mbp2021', status: 'unreachable', jobs: [] }),
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
