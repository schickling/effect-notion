/**
 * Inspect command state machine.
 *
 * State transitions: Loading -> Loaded | Error
 *
 * `Loaded` is the diagnostic outcome and always exits 0, whatever the
 * assessment says: "this runner could not be observed" is a successful
 * diagnosis, not a command failure. Only a failure to run the command at all
 * (no repo, GitHub unreachable, unknown job) reaches `Error`.
 */
import { Schema } from 'effect'

import { ApiMetaSchema, defaultApiMeta } from '../../lib/apiMeta.ts'
import {
  InspectAssessmentSchema,
  InspectGitHubFactsSchema,
  InspectNamespaceFactsSchema,
} from '../../lib/inspectFacts.ts'

/**
 * The three fact groups a consumer sees, kept apart on purpose: `github` and
 * `namespace` are observations, `assessment` is the only derived value.
 */
export const InspectionSchema = Schema.Struct({
  github: InspectGitHubFactsSchema,
  namespace: InspectNamespaceFactsSchema,
  assessment: InspectAssessmentSchema,
}).annotate({ identifier: 'Inspect.Inspection' })
export type Inspection = typeof InspectionSchema.Type

/** Renderer state for the inspect view */
export const InspectStateSchema = Schema.Union([
  Schema.TaggedStruct('Loading', { message: Schema.String, _meta: ApiMetaSchema }),
  Schema.TaggedStruct('Loaded', {
    github: InspectGitHubFactsSchema,
    namespace: InspectNamespaceFactsSchema,
    assessment: InspectAssessmentSchema,
    _meta: ApiMetaSchema,
  }),
  Schema.TaggedStruct('Error', {
    error: Schema.String,
    message: Schema.String,
    _meta: ApiMetaSchema,
  }),
])
export type InspectState = typeof InspectStateSchema.Type

/** Actions dispatched to update the inspect state */
export const InspectActionSchema = Schema.Union([
  Schema.TaggedStruct('SetInspection', {
    github: InspectGitHubFactsSchema,
    namespace: InspectNamespaceFactsSchema,
    assessment: InspectAssessmentSchema,
  }),
  Schema.TaggedStruct('SetError', { error: Schema.String, message: Schema.String }),
  Schema.TaggedStruct('SetMeta', { _meta: ApiMetaSchema }),
])
export type InspectAction = typeof InspectActionSchema.Type

/** State reducer for inspect view transitions */
export const inspectReducer = ({
  state,
  action,
}: {
  state: InspectState
  action: InspectAction
}): InspectState => {
  switch (action._tag) {
    case 'SetInspection':
      return {
        _tag: 'Loaded',
        github: action.github,
        namespace: action.namespace,
        assessment: action.assessment,
        _meta: state._meta,
      }
    case 'SetError':
      return { _tag: 'Error', error: action.error, message: action.message, _meta: state._meta }
    case 'SetMeta':
      return { ...state, _meta: action._meta }
  }
}

/** Create the initial inspect state */
export const createInitialInspectState = (): InspectState => ({
  _tag: 'Loading',
  message: 'Inspecting job...',
  _meta: defaultApiMeta,
})
