/**
 * Runners command state machine.
 *
 * State transitions: Loading -> Loaded | Error
 */
import { Schema } from 'effect'

import { ApiMetaSchema, defaultApiMeta } from '../../lib/apiMeta.ts'
import { HostResultSchema, type ActiveJobInfo, type HostResult } from '../../lib/viewModels.ts'

export type { ActiveJobInfo, HostResult }

/** Renderer state for the runners view */
export const RunnersStateSchema = Schema.Union([
  Schema.TaggedStruct('Loading', { message: Schema.String, _meta: ApiMetaSchema }),
  Schema.TaggedStruct('Loaded', {
    hosts: Schema.Array(HostResultSchema),
    _meta: ApiMetaSchema,
  }),
  Schema.TaggedStruct('Error', {
    error: Schema.String,
    message: Schema.String,
    _meta: ApiMetaSchema,
  }),
])
export type RunnersState = typeof RunnersStateSchema.Type

/** Actions dispatched to update the runners state */
export const RunnersActionSchema = Schema.Union([
  Schema.TaggedStruct('SetRunners', { hosts: Schema.Array(HostResultSchema) }),
  Schema.TaggedStruct('SetError', { error: Schema.String, message: Schema.String }),
  Schema.TaggedStruct('SetMeta', { _meta: ApiMetaSchema }),
])
export type RunnersAction = typeof RunnersActionSchema.Type

/** State reducer for runners view transitions */
export const runnersReducer = (_input: {
  state: RunnersState
  action: RunnersAction
}): RunnersState => {
  const { state, action } = _input
  switch (action._tag) {
    case 'SetRunners':
      return { _tag: 'Loaded', hosts: action.hosts, _meta: state._meta }
    case 'SetError':
      return { _tag: 'Error', error: action.error, message: action.message, _meta: state._meta }
    case 'SetMeta':
      return { ...state, _meta: action._meta }
  }
}

/** Create the initial runners state */
export const createInitialRunnersState = (): RunnersState => ({
  _tag: 'Loading',
  message: 'Fetching runner status...',
  _meta: defaultApiMeta,
})
