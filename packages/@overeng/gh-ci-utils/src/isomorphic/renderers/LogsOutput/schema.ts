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

/** One independently collected job/step log batch retained across watch ticks. */
export const LogSectionSchema = Schema.Struct({
  id: Schema.String,
  jobName: Schema.String,
  conclusion: Schema.String,
  lines: Schema.Array(Schema.String),
  notice: Schema.NullOr(Schema.String),
  truncation: Schema.NullOr(TruncationSchema),
})
export type LogSection = typeof LogSectionSchema.Type

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
    /** Successful batches retained across watch ticks, keyed by job or step identity. */
    sections: Schema.optional(Schema.Array(LogSectionSchema)),
  }),
  Schema.TaggedStruct('NoLogs', {
    message: Schema.String,
    conclusion: Schema.String,
    _meta: ApiMetaSchema,
  }),
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
    /** Stable job/step identity. Falls back to `jobName` for existing callers. */
    sectionId: Schema.optional(Schema.String),
    conclusion: Schema.String,
    lines: Schema.Array(Schema.String),
    notice: Schema.NullOr(Schema.String),
    truncation: Schema.NullOr(TruncationSchema),
  }),
  Schema.TaggedStruct('SetError', { error: Schema.String, message: Schema.String }),
  Schema.TaggedStruct('SetNoLogs', { message: Schema.String, conclusion: Schema.String }),
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
    case 'SetLogs': {
      const section: LogSection = {
        id: action.sectionId ?? action.jobName,
        jobName: action.jobName,
        conclusion: action.conclusion,
        lines: action.lines,
        notice: action.notice,
        truncation: action.truncation,
      }
      const previousSections =
        state._tag === 'Loaded'
          ? (state.sections ?? [
              {
                id: state.jobName,
                jobName: state.jobName,
                conclusion: state.conclusion,
                lines: state.lines,
                notice: state.notice,
                truncation: state.truncation,
              },
            ])
          : []
      const existingIndex = previousSections.findIndex(({ id }) => id === section.id)
      const sections =
        existingIndex === -1
          ? [...previousSections, section]
          : previousSections.map((existing, index) =>
              index === existingIndex ? section : existing,
            )
      const notices = new Set(sections.flatMap(({ notice }) => (notice === null ? [] : [notice])))
      const onlySection = sections.length === 1 ? sections[0]! : undefined

      return {
        _tag: 'Loaded',
        jobName: onlySection?.jobName ?? `${sections.length} jobs`,
        conclusion:
          state._tag === 'Loaded' && state.conclusion === 'failure' ? 'failure' : action.conclusion,
        lines:
          onlySection?.lines ??
          sections.flatMap(({ jobName, conclusion, lines }) => [
            `── ${jobName} (${conclusion}) ──`,
            ...lines,
            '',
          ]),
        notice: notices.size === 0 ? null : [...notices].join(' · '),
        truncation: onlySection?.truncation ?? null,
        sections,
        _meta: state._meta,
      }
    }
    case 'SetError':
      return { _tag: 'Error', error: action.error, message: action.message, _meta: state._meta }
    case 'SetNoLogs':
      return {
        _tag: 'NoLogs',
        message: action.message,
        conclusion: action.conclusion,
        _meta: state._meta,
      }
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
