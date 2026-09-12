/**
 * Logs command state machine.
 *
 * State transitions: Loading -> Loaded | NoLogs | Error
 */
import { Schema } from 'effect'

import { ApiMetaSchema, defaultApiMeta } from '../../lib/apiMeta.ts'

/** Pagination info for truncated log output */
export const TruncationSchema = Schema.Struct({
  totalLines: Schema.Finite,
  offset: Schema.Finite,
  pageSize: Schema.Finite,
})
export type Truncation = typeof TruncationSchema.Type

/** Renderer state for the logs view */
export const LogsStateSchema = Schema.Union([
  Schema.TaggedStruct('Loading', { message: Schema.String, _meta: ApiMetaSchema }),
  Schema.TaggedStruct('Loaded', {
    jobName: Schema.String,
    conclusion: Schema.String,
    /** Verbatim log text — filter fallbacks are reported in `notice`, not here. */
    lines: Schema.Array(Schema.String),
    /** Why these lines were chosen when a filter did not match them directly. */
    notice: Schema.NullOr(Schema.String),
    truncation: Schema.NullOr(TruncationSchema),
    _meta: ApiMetaSchema,
  }),
  Schema.TaggedStruct('NoLogs', { message: Schema.String, _meta: ApiMetaSchema }),
  Schema.TaggedStruct('Error', {
    error: Schema.String,
    message: Schema.String,
    _meta: ApiMetaSchema,
  }),
])
export type LogsState = typeof LogsStateSchema.Type

/** Actions dispatched to update the logs state */
export const LogsActionSchema = Schema.Union([
  Schema.TaggedStruct('SetLogs', {
    jobName: Schema.String,
    conclusion: Schema.String,
    lines: Schema.Array(Schema.String),
    notice: Schema.NullOr(Schema.String),
    truncation: Schema.NullOr(TruncationSchema),
  }),
  Schema.TaggedStruct('SetError', { error: Schema.String, message: Schema.String }),
  Schema.TaggedStruct('SetNoLogs', { message: Schema.String }),
  Schema.TaggedStruct('SetMeta', { _meta: ApiMetaSchema }),
])
export type LogsAction = typeof LogsActionSchema.Type

/** State reducer for logs view transitions */
export const logsReducer = ({
  state,
  action,
}: {
  state: LogsState
  action: LogsAction
}): LogsState => {
  switch (action._tag) {
    case 'SetLogs':
      return {
        _tag: 'Loaded',
        jobName: action.jobName,
        conclusion:
          state._tag === 'Loaded' && state.conclusion === 'failure' ? 'failure' : action.conclusion,
        lines: action.lines,
        notice: action.notice,
        truncation: action.truncation,
        _meta: state._meta,
      }
    case 'SetError':
      return { _tag: 'Error', error: action.error, message: action.message, _meta: state._meta }
    case 'SetNoLogs':
      return { _tag: 'NoLogs', message: action.message, _meta: state._meta }
    case 'SetMeta':
      return { ...state, _meta: action._meta }
  }
}

/** Create the initial logs state */
export const createInitialLogsState = (): LogsState => ({
  _tag: 'Loading',
  message: 'Fetching logs...',
  _meta: defaultApiMeta,
})
