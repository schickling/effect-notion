import { createTuiApp } from '@overeng/tui-react'

import { exitCodeForSummary } from '../../lib/summary.ts'
import { CiNdjsonEvent, fromCiAction } from './ndjson.ts'
import {
  type CiState,
  CiActionSchema,
  CiStateSchema,
  ciReducer,
  createInitialCiState,
} from './schema.ts'

/**
 * Process exit code for a rendered CI state. Error states own 1/2/130; every
 * verdict exit code is {@link exitCodeForSummary}'s.
 */
export const ciExitCode = (state: CiState): number => {
  if (state._tag === 'Error') {
    if (state.error === 'Interrupted') return 130
    if (state.error === 'Timeout') return 2
    return 1
  }
  if (state._tag === 'Loaded')
    return exitCodeForSummary({ summary: state.summary, prHealth: state.prHealth })
  return 0
}

/** TUI app definition for CI status output */
export const CiApp = createTuiApp({
  stateSchema: CiStateSchema,
  actionSchema: CiActionSchema,
  initial: createInitialCiState(),
  reducer: ciReducer,
  exitCode: ciExitCode,
  ndjson: {
    eventSchema: CiNdjsonEvent,
    fromAction: fromCiAction,
  },
})
