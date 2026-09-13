import { createTuiApp } from '@overeng/tui-react'

import {
  type RunnersState,
  RunnersActionSchema,
  RunnersStateSchema,
  createInitialRunnersState,
  runnersReducer,
} from './schema.ts'

/** TUI app definition for runners output */
export const RunnersApp = createTuiApp({
  stateSchema: RunnersStateSchema,
  actionSchema: RunnersActionSchema,
  initial: createInitialRunnersState(),
  reducer: runnersReducer,
  exitCode: (state: RunnersState) => {
    if (state._tag === 'Error') return 1
    return 0
  },
})
