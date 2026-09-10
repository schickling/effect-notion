import { createTuiApp } from '@overeng/tui-react'

import {
  type LogsState,
  LogsActionSchema,
  LogsStateSchema,
  createInitialLogsState,
  logsReducer,
} from './schema.ts'

/** TUI app definition for log output display */
export const LogsApp = createTuiApp({
  stateSchema: LogsStateSchema,
  actionSchema: LogsActionSchema,
  initial: createInitialLogsState(),
  reducer: logsReducer,
  exitCode: (state: LogsState) => {
    if (state._tag === 'Error') return 1
    if (state._tag === 'Loaded' && state.conclusion === 'failure') return 1
    return 0
  },
})
