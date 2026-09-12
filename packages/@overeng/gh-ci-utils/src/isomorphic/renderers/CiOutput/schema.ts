/**
 * CI output state machine.
 *
 * State transitions: Loading -> Loaded | Error
 */
import { Schema } from 'effect'

import { ApiMetaSchema, defaultApiMeta, type ApiMeta } from '../../lib/apiMeta.ts'
import { abbreviateRunner } from '../../lib/format.ts'
import {
  AnnotationInfoSchema,
  JobErrorSchema,
  PrHealthViewModel,
  RunInfoSchema,
  SummarySchema,
  WorkflowJobViewModel,
  type AnnotationInfo,
  type JobError,
  type PrHealth,
  type RunInfo,
  type Summary,
  type WorkflowJobVM,
} from '../../lib/viewModels.ts'

export type { AnnotationInfo, ApiMeta, JobError, PrHealth, RunInfo, Summary, WorkflowJobVM }

/** Runner name -> host entries (plain array for schema compatibility) */
const RunnerHostEntrySchema = Schema.Tuple([Schema.String, Schema.String])
const RunnerHostMapSchema = Schema.Array(RunnerHostEntrySchema)

export type RunnerHostMap = typeof RunnerHostMapSchema.Type

/** Build runner-host entries using the same identity shown for workflow jobs. */
export const makeRunnerHostMap = (
  jobs: readonly { readonly runner: string; readonly host: string }[],
): RunnerHostMap => jobs.map(({ runner, host }) => [abbreviateRunner(runner), host])

/** Look up a runner host using the same normalized identity on both sides. */
export const lookupRunnerHost = ({
  entries,
  runnerName,
}: {
  entries: RunnerHostMap
  runnerName: string
}): string | undefined => {
  const normalizedRunnerName = abbreviateRunner(runnerName)
  const entry = entries.find(([key]) => abbreviateRunner(key) === normalizedRunnerName)
  return entry?.[1]
}

/**
 * Runner label to show for a job: the runner-scaler host when the job's raw
 * runner name is one we polled, else the abbreviated runner label.
 *
 * The join must use the raw name (`runnera-1234abcd`), since that is what the
 * runner-scaler `/jobs` endpoint reports; the abbreviated label never matches.
 */
export const resolveRunnerDisplay = ({
  job,
  entries,
}: {
  job: WorkflowJobVM
  entries: RunnerHostMap
}): string =>
  job.runnerName === null
    ? job.runner
    : (lookupRunnerHost({ entries, runnerName: job.runnerName }) ?? job.runner)

/** Renderer state for the CI status view */
export const CiStateSchema = Schema.Union([
  Schema.TaggedStruct('Loading', {
    message: Schema.String,
    _meta: ApiMetaSchema,
  }).annotate({ identifier: 'CiOutput.Loading' }),
  Schema.TaggedStruct('Loaded', {
    run: RunInfoSchema,
    jobs: Schema.Array(WorkflowJobViewModel),
    errors: Schema.Array(JobErrorSchema),
    annotations: Schema.Array(AnnotationInfoSchema),
    runnerHostMap: RunnerHostMapSchema,
    prHealth: Schema.NullOr(PrHealthViewModel),
    summary: SummarySchema,
    _meta: ApiMetaSchema,
  }).annotate({ identifier: 'CiOutput.Loaded' }),
  Schema.TaggedStruct('Error', {
    error: Schema.String,
    message: Schema.String,
    _meta: ApiMetaSchema,
  }).annotate({ identifier: 'CiOutput.Error' }),
])
export type CiState = typeof CiStateSchema.Type

/** Actions dispatched to update the CI state */
export const CiActionSchema = Schema.Union([
  Schema.TaggedStruct('SetLoaded', {
    run: RunInfoSchema,
    jobs: Schema.Array(WorkflowJobViewModel),
    errors: Schema.Array(JobErrorSchema),
    annotations: Schema.Array(AnnotationInfoSchema),
    runnerHostMap: RunnerHostMapSchema,
    prHealth: Schema.NullOr(PrHealthViewModel),
    summary: SummarySchema,
  }).annotate({ identifier: 'CiOutput.SetLoaded' }),
  Schema.TaggedStruct('SetError', {
    error: Schema.String,
    message: Schema.String,
  }).annotate({ identifier: 'CiOutput.SetError' }),
  Schema.TaggedStruct('Interrupted', {}).annotate({
    identifier: 'CiOutput.Interrupted',
  }),
  /**
   * Intentional watch termination while the workflow itself remains active.
   * This does not change the loaded verdict state or its process exit code.
   */
  Schema.TaggedStruct('WatchTerminated', {
    reason: Schema.Literal('FirstFailure'),
    message: Schema.String,
  }).annotate({ identifier: 'CiOutput.WatchTerminated' }),
  Schema.TaggedStruct('SetMeta', { _meta: ApiMetaSchema }).annotate({
    identifier: 'CiOutput.SetMeta',
  }),
  /**
   * One completed watch poll. Carries no run data — it exists so long watches
   * emit liveness, cost, and pacing on every tick instead of going silent
   * between job state changes.
   */
  Schema.TaggedStruct('Tick', {
    tick: Schema.Finite,
    elapsedSeconds: Schema.Finite,
    pending: Schema.Finite,
    completed: Schema.Finite,
    changed: Schema.Finite,
    nextPollSeconds: Schema.Finite,
    _meta: ApiMetaSchema,
  }).annotate({ identifier: 'CiOutput.Tick' }),
])
export type CiAction = typeof CiActionSchema.Type

/** State reducer for CI status transitions */
export const ciReducer = (_input: { state: CiState; action: CiAction }): CiState => {
  const { state, action } = _input
  switch (action._tag) {
    case 'SetLoaded':
      return {
        _tag: 'Loaded',
        run: action.run,
        jobs: action.jobs,
        errors: action.errors,
        annotations: action.annotations,
        runnerHostMap: action.runnerHostMap,
        prHealth: action.prHealth,
        summary: action.summary,
        _meta: state._meta,
      }
    case 'SetError':
      return { _tag: 'Error', error: action.error, message: action.message, _meta: state._meta }
    case 'Interrupted':
      return {
        _tag: 'Error',
        error: 'Interrupted',
        message: 'Watch cancelled by user (Ctrl+C)',
        _meta: state._meta,
      }
    case 'WatchTerminated':
      return state
    case 'SetMeta':
      return { ...state, _meta: action._meta }
    case 'Tick':
      return { ...state, _meta: action._meta }
  }
}

/** Create the initial CI state from command options */
export const createInitialCiState = (): CiState => ({
  _tag: 'Loading',
  message: 'Fetching CI status...',
  _meta: defaultApiMeta,
})
