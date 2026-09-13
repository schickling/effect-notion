/**
 * Mutation command state machine (rerun, run, cancel).
 *
 * State transitions: Loading → Dispatched → Watching → Done | Error
 */
import { Schema } from 'effect'

import { ApiMetaSchema, defaultApiMeta } from '../../lib/apiMeta.ts'

/** Renderer state for a mutation operation */
export const MutationStateSchema = Schema.Union([
  Schema.TaggedStruct('Loading', { message: Schema.String, _meta: ApiMetaSchema }),
  Schema.TaggedStruct('Dispatched', {
    runId: Schema.Finite,
    repo: Schema.String,
    message: Schema.String,
    url: Schema.NullOr(Schema.String),
    _meta: ApiMetaSchema,
  }),
  Schema.TaggedStruct('Watching', {
    runId: Schema.Finite,
    repo: Schema.String,
    status: Schema.String,
    conclusion: Schema.NullOr(Schema.String),
    jobs: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        status: Schema.String,
        conclusion: Schema.NullOr(Schema.String),
        runner: Schema.String,
      }),
    ),
    _meta: ApiMetaSchema,
  }),
  Schema.TaggedStruct('Done', {
    message: Schema.String,
    _meta: ApiMetaSchema,
  }),
  Schema.TaggedStruct('Error', {
    error: Schema.String,
    message: Schema.String,
    _meta: ApiMetaSchema,
  }),
])
export type MutationState = typeof MutationStateSchema.Type

/** Actions dispatched to update the mutation state */
export const MutationActionSchema = Schema.Union([
  Schema.TaggedStruct('SetDispatched', {
    runId: Schema.Finite,
    repo: Schema.String,
    message: Schema.String,
    url: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct('SetWatching', {
    runId: Schema.Finite,
    repo: Schema.String,
    status: Schema.String,
    conclusion: Schema.NullOr(Schema.String),
    jobs: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        status: Schema.String,
        conclusion: Schema.NullOr(Schema.String),
        runner: Schema.String,
      }),
    ),
  }),
  Schema.TaggedStruct('SetDone', { message: Schema.String }),
  Schema.TaggedStruct('SetError', { error: Schema.String, message: Schema.String }),
  Schema.TaggedStruct('SetMeta', { _meta: ApiMetaSchema }),
])
export type MutationAction = typeof MutationActionSchema.Type

/** State reducer for mutation operation transitions */
export const mutationReducer = (_input: {
  state: MutationState
  action: MutationAction
}): MutationState => {
  const { state, action } = _input
  switch (action._tag) {
    case 'SetDispatched':
      return {
        _tag: 'Dispatched',
        runId: action.runId,
        repo: action.repo,
        message: action.message,
        url: action.url,
        _meta: state._meta,
      }
    case 'SetWatching':
      return {
        _tag: 'Watching',
        runId: action.runId,
        repo: action.repo,
        status: action.status,
        conclusion: action.conclusion,
        jobs: action.jobs,
        _meta: state._meta,
      }
    case 'SetDone':
      return { _tag: 'Done', message: action.message, _meta: state._meta }
    case 'SetError':
      return { _tag: 'Error', error: action.error, message: action.message, _meta: state._meta }
    case 'SetMeta':
      return { ...state, _meta: action._meta }
  }
}

/** Create the initial mutation state from operation context */
export const createInitialMutationState = (): MutationState => ({
  _tag: 'Loading',
  message: 'Resolving target...',
  _meta: defaultApiMeta,
})
