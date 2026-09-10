import { createTuiApp } from '@overeng/tui-react'

import {
  type MutationState,
  MutationActionSchema,
  MutationStateSchema,
  createInitialMutationState,
  mutationReducer,
} from './schema.ts'

/** TUI app definition for mutation (rerun/cancel) output */
export const MutationApp = createTuiApp({
  stateSchema: MutationStateSchema,
  actionSchema: MutationActionSchema,
  initial: createInitialMutationState(),
  reducer: mutationReducer,
  exitCode: (state: MutationState) => {
    if (state._tag === 'Error') return 1
    if (state._tag === 'Watching') {
      const hasFailed = state.jobs.some(
        (j: { conclusion: string | null }) =>
          j.conclusion !== null && j.conclusion !== 'success' && j.conclusion !== 'skipped',
      )
      if (hasFailed) return 1
    }
    return 0
  },
})
