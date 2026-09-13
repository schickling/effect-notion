import { createTuiApp } from '@overeng/tui-react'

import {
  type InspectState,
  InspectActionSchema,
  InspectStateSchema,
  createInitialInspectState,
  inspectReducer,
} from './schema.ts'

/**
 * Exit code for an inspect run.
 *
 * Every loaded diagnosis exits 0 — including `unknown` and
 * `resource-pressure`. A nonzero code would tell a caller its *command*
 * failed, which is a different claim from what it observed about a runner.
 */
export const inspectExitCode = (state: InspectState): number => (state._tag === 'Error' ? 1 : 0)

/** TUI app definition for inspect output */
export const InspectApp = createTuiApp({
  stateSchema: InspectStateSchema,
  actionSchema: InspectActionSchema,
  initial: createInitialInspectState(),
  reducer: inspectReducer,
  exitCode: inspectExitCode,
})
