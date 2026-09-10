/**
 * NDJSON event definitions for the CI status command.
 *
 * When in NDJSON output mode, emits granular events per job change
 * instead of full state snapshots (~200 bytes per event vs ~15KB per snapshot).
 */
import { Schema } from 'effect'

import { isBlockingConclusion } from '../../lib/summary.ts'
import { SummaryOverallStatus } from '../../lib/viewModels.ts'
import type { CiAction, CiState } from './schema.ts'

/** Event emitted per job status change */
export const CiJobUpdate = Schema.TaggedStruct('JobUpdate', {
  jobId: Schema.Finite,
  name: Schema.String,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  durationSeconds: Schema.Finite,
  runner: Schema.String,
}).annotate({ identifier: 'CiNdjson.JobUpdate' })

/** Event emitted when errors are extracted from a failed job */
export const CiErrorFound = Schema.TaggedStruct('ErrorFound', {
  jobName: Schema.String,
  stepName: Schema.String,
  errors: Schema.Array(Schema.String),
}).annotate({ identifier: 'CiNdjson.ErrorFound' })

/**
 * Event emitted when the run completes.
 *
 * `conclusion` is the run's own field and is `null` for a run that completed without
 * one, so `overallStatus` carries the verdict a consumer should branch on — the same
 * one `--output json` reports. `failed` counts every blocking conclusion
 * (`failure`, `timed_out`, `startup_failure`, …), not just `failure`, so the count
 * cannot disagree with the verdict.
 */
export const CiRunComplete = Schema.TaggedStruct('RunComplete', {
  conclusion: Schema.NullOr(Schema.String),
  overallStatus: SummaryOverallStatus,
  totalJobs: Schema.Finite,
  failed: Schema.Finite,
  passed: Schema.Finite,
}).annotate({ identifier: 'CiNdjson.RunComplete' })

/** Event emitted when PR health data is available or changes */
export const CiPrHealth = Schema.TaggedStruct('PrHealth', {
  prNumber: Schema.Finite,
  mergeable: Schema.String,
  behindBy: Schema.Finite,
  baseRefName: Schema.String,
}).annotate({ identifier: 'CiNdjson.PrHealth' })

/**
 * Per-tick liveness for long watches.
 *
 * Job-change events can be minutes apart, so without this a consumer cannot
 * tell a healthy watch from a hung one, and cannot see what the watch is
 * spending. `apiRequestsCached` are `304` responses GitHub does not bill.
 */
export const CiTick = Schema.TaggedStruct('Tick', {
  tick: Schema.Finite,
  elapsedSeconds: Schema.Finite,
  pending: Schema.Finite,
  completed: Schema.Finite,
  changed: Schema.Finite,
  nextPollSeconds: Schema.Finite,
  apiRequests: Schema.Finite,
  apiRequestsCached: Schema.Finite,
  rateLimitRemaining: Schema.Finite,
  rateLimitLimit: Schema.Finite,
}).annotate({ identifier: 'CiNdjson.Tick' })

/**
 * Event emitted when the command stops without the run completing (timeout,
 * interrupt, unresolvable target, auth failure).
 *
 * Not watch-specific: a one-shot `status --output ndjson` that cannot resolve
 * its target ends here too, so the name must not claim a watch happened.
 */
export const CiAborted = Schema.TaggedStruct('Aborted', {
  reason: Schema.String,
  message: Schema.String,
}).annotate({ identifier: 'CiNdjson.Aborted' })

/** Schema for newline-delimited JSON events streamed to the renderer */
export const CiNdjsonEvent = Schema.Union([
  CiJobUpdate,
  CiErrorFound,
  CiRunComplete,
  CiPrHealth,
  CiTick,
  CiAborted,
])
export type CiNdjsonEvent = typeof CiNdjsonEvent.Type

/** Map a dispatched action + previous state to NDJSON events. */
export const fromCiAction = ({
  action,
  prevState,
}: {
  action: CiAction
  prevState: CiState
}): ReadonlyArray<CiNdjsonEvent> => {
  if (action._tag === 'Tick') {
    return [
      {
        _tag: 'Tick',
        tick: action.tick,
        elapsedSeconds: action.elapsedSeconds,
        pending: action.pending,
        completed: action.completed,
        changed: action.changed,
        nextPollSeconds: action.nextPollSeconds,
        apiRequests: action._meta.apiRequests,
        apiRequestsCached: action._meta.apiRequestsCached,
        rateLimitRemaining: action._meta.rateLimitRemaining,
        rateLimitLimit: action._meta.rateLimitLimit,
      },
    ] as const
  }

  if (action._tag === 'SetError') {
    return [{ _tag: 'Aborted', reason: action.error, message: action.message }] as const
  }

  if (action._tag === 'Interrupted') {
    return [
      { _tag: 'Aborted', reason: 'Interrupted', message: 'Watch cancelled by user (Ctrl+C)' },
    ] as const
  }

  if (action._tag !== 'SetLoaded') return [] as const

  const events: CiNdjsonEvent[] = []
  const prevJobs = prevState._tag === 'Loaded' ? prevState.jobs : []

  for (const job of action.jobs) {
    const prev = prevJobs.find((j) => j.id === job.id)
    if (!prev || prev.status !== job.status || prev.conclusion !== job.conclusion) {
      events.push({
        _tag: 'JobUpdate',
        jobId: job.id,
        name: job.name,
        status: job.status,
        conclusion: job.conclusion,
        durationSeconds: job.durationSeconds,
        runner: job.runner,
      })
    }
  }

  const prevErrors = prevState._tag === 'Loaded' ? prevState.errors : []
  for (const err of action.errors) {
    if (!prevErrors.some((e) => e.jobName === err.jobName)) {
      events.push({
        _tag: 'ErrorFound',
        jobName: err.jobName,
        stepName: err.stepName,
        errors: [...err.errors],
      })
    }
  }

  if (action.prHealth !== null) {
    const prevPrHealth = prevState._tag === 'Loaded' ? prevState.prHealth : null
    if (
      prevPrHealth === null ||
      prevPrHealth.mergeable !== action.prHealth.mergeable ||
      prevPrHealth.behindBy !== action.prHealth.behindBy
    ) {
      events.push({
        _tag: 'PrHealth',
        prNumber: action.prHealth.prNumber,
        mergeable: action.prHealth.mergeable,
        behindBy: action.prHealth.behindBy,
        baseRefName: action.prHealth.baseRefName,
      })
    }
  }

  if (action.run.status === 'completed') {
    const wasCompleted = prevState._tag === 'Loaded' && prevState.run.status === 'completed'
    if (!wasCompleted) {
      events.push({
        _tag: 'RunComplete',
        conclusion: action.run.conclusion,
        overallStatus: action.summary.overallStatus,
        totalJobs: action.jobs.length,
        failed: action.jobs.filter((j) => isBlockingConclusion(j.conclusion)).length,
        passed: action.jobs.filter((j) => j.conclusion === 'success').length,
      })
    }
  }

  return events
}
