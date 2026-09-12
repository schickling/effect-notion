import { createTuiApp } from '@overeng/tui-react'

import { isUnsuccessfulConclusion } from '../../lib/summary.ts'
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
    if (state._tag === 'Error') return state.error === 'Timeout' ? 2 : 1
    if (
      (state._tag === 'Loaded' || state._tag === 'NoLogs') &&
      state.conclusion !== 'queued' &&
      state.conclusion !== 'in_progress' &&
      state.conclusion !== 'completed' &&
      state.conclusion !== 'waiting' &&
      state.conclusion !== 'requested' &&
      state.conclusion !== 'pending' &&
      isUnsuccessfulConclusion(state.conclusion)
    )
      return 1
    return 0
  },
})
