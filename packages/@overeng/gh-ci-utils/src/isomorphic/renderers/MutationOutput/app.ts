import { createTuiApp } from '@overeng/tui-react'

import { isUnsuccessfulConclusion } from '../../lib/summary.ts'
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
    if (state._tag === 'Error') return state.error === 'Timeout' ? 2 : 1
    if (
      state._tag === 'Watching' &&
      (isUnsuccessfulConclusion(state.conclusion) ||
        state.jobs.some((job) => isUnsuccessfulConclusion(job.conclusion)))
    )
      return 1
    return 0
  },
})
