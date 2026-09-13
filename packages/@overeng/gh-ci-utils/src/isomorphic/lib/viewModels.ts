/** View model schemas for TUI renderers — plain types only (no transforms like DateFromString). */
import { Schema } from 'effect'

/** Job info for display */
export const JobInfoSchema = Schema.Struct({
  name: Schema.String,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  durationSeconds: Schema.Finite,
  runner: Schema.String,
  jobUrl: Schema.String,
}).annotate({ identifier: 'ViewModel.JobInfo' })
export type JobInfo = typeof JobInfoSchema.Type

/** Error extracted from a failed job */
export const JobErrorSchema = Schema.Struct({
  jobName: Schema.String,
  stepName: Schema.String,
  errors: Schema.Array(Schema.String),
}).annotate({ identifier: 'ViewModel.JobError' })
export type JobError = typeof JobErrorSchema.Type

/** Annotation from check-runs API */
export const AnnotationInfoSchema = Schema.Struct({
  jobName: Schema.String,
  path: Schema.String,
  line: Schema.Finite,
  message: Schema.String,
  title: Schema.NullOr(Schema.String),
}).annotate({ identifier: 'ViewModel.AnnotationInfo' })
export type AnnotationInfo = typeof AnnotationInfoSchema.Type

/** Host result for runners display */
export const ActiveJobInfoSchema = Schema.Struct({
  runner: Schema.String,
  scaleSet: Schema.String,
  durationSeconds: Schema.Finite,
}).annotate({ identifier: 'ViewModel.ActiveJobInfo' })
export type ActiveJobInfo = typeof ActiveJobInfoSchema.Type

/** Schema for runner host results including active jobs */
export const HostResultSchema = Schema.Struct({
  host: Schema.String,
  status: Schema.Literals(['reachable', 'unreachable']),
  jobs: Schema.Array(ActiveJobInfoSchema),
}).annotate({ identifier: 'ViewModel.HostResult' })
export type HostResult = typeof HostResultSchema.Type

/**
 * Coarse provider kind parsed from a raw runner name.
 *
 * `other` means the name parsed but matched no known naming scheme; `unknown`
 * means GitHub reported no runner at all.
 */
export const RunnerKind = Schema.Literals(['namespace', 'self-hosted', 'other', 'unknown'])
export type RunnerKind = typeof RunnerKind.Type

/** Step info for display (timestamps kept as ISO strings — no Date transforms) */
export const StepInfoSchema = Schema.Struct({
  name: Schema.String,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  /** GitHub's 1-based step number within the job. */
  number: Schema.Finite,
  startedAt: Schema.NullOr(Schema.String),
  completedAt: Schema.NullOr(Schema.String),
}).annotate({ identifier: 'ViewModel.StepInfo' })
export type StepInfo = typeof StepInfoSchema.Type

/** Workflow job for display (pre-computed durations, no Date fields) */
export const WorkflowJobViewModel = Schema.Struct({
  id: Schema.Finite,
  name: Schema.String,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  durationSeconds: Schema.Finite,
  /** ISO completion timestamp; absent in older snapshots and null until GitHub finalizes it. */
  completedAt: Schema.optional(Schema.NullOr(Schema.String)),
  /** Abbreviated runner label for compact display. */
  runner: Schema.String,
  /** Raw `runner_name` as GitHub reported it — `null` when no runner was assigned. */
  runnerName: Schema.NullOr(Schema.String),
  runnerKind: RunnerKind,
  /** Stable identity within the kind — `null` only for `unknown`. */
  runnerInstance: Schema.NullOr(Schema.String),
  jobUrl: Schema.String,
  steps: Schema.optional(Schema.Array(StepInfoSchema)),
  failedStepName: Schema.NullOr(Schema.String),
}).annotate({ identifier: 'ViewModel.WorkflowJob' })
export type WorkflowJobVM = typeof WorkflowJobViewModel.Type

/** PR health for display */
export const MergeableState = Schema.Literals(['CONFLICTING', 'MERGEABLE', 'UNKNOWN'])
export type MergeableState = typeof MergeableState.Type

/** PR health view model for display in status output */
export const PrHealthViewModel = Schema.Struct({
  prNumber: Schema.Finite,
  mergeable: MergeableState,
  behindBy: Schema.Finite,
  baseRefName: Schema.String,
}).annotate({ identifier: 'ViewModel.PrHealth' })
export type PrHealth = typeof PrHealthViewModel.Type

/** Run info for display (no Date transforms) */
export const RunInfoSchema = Schema.Struct({
  id: Schema.Finite,
  name: Schema.NullOr(Schema.String),
  runNumber: Schema.Finite,
  headBranch: Schema.NullOr(Schema.String),
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  event: Schema.String,
  workflowPath: Schema.String,
  htmlUrl: Schema.String,
  elapsedSeconds: Schema.Finite,
}).annotate({ identifier: 'ViewModel.RunInfo' })
export type RunInfo = typeof RunInfoSchema.Type

/**
 * Pre-computed problems-first verdict for JSON consumers.
 *
 * `skipped` and `no_checks` are inconclusive, not green: nothing authoritative
 * ran for the commit under review.
 */
export const SummaryOverallStatus = Schema.Literals([
  'passing',
  'failing',
  'in_progress',
  'cancelled',
  'skipped',
  'no_checks',
])
export type SummaryOverallStatus = typeof SummaryOverallStatus.Type

/** A failed job with fix command for the summary's critical section */
export const CriticalItemSchema = Schema.Struct({
  jobName: Schema.String,
  jobId: Schema.Finite,
  failedStepName: Schema.NullOr(Schema.String),
  durationSeconds: Schema.Finite,
  runner: Schema.String,
  fixCommand: Schema.String,
}).annotate({ identifier: 'ViewModel.CriticalItem' })

/** Warnings that qualify the verdict (missing/stale run, PR merge state) */
export const WarningItemSchema = Schema.Union([
  Schema.TaggedStruct('MergeConflicts', { prNumber: Schema.Finite }),
  Schema.TaggedStruct('BranchBehind', {
    behindBy: Schema.Finite,
    baseRefName: Schema.String,
  }),
  /** No run of the expected workflow exists for the commit under review. */
  Schema.TaggedStruct('ExpectedWorkflowMissing', {
    workflow: Schema.String,
    headSha: Schema.NullOr(Schema.String),
    inspectedWorkflowPath: Schema.String,
  }),
  /** The inspected run describes a different commit than the one under review. */
  Schema.TaggedStruct('StaleRun', {
    expectedHeadSha: Schema.String,
    runHeadSha: Schema.String,
  }),
]).annotate({ identifier: 'ViewModel.WarningItem' })
export type WarningItem = typeof WarningItemSchema.Type

/** Problems-first summary with overall status, critical failures, and warnings */
export const SummarySchema = Schema.Struct({
  overallStatus: SummaryOverallStatus,
  critical: Schema.Array(CriticalItemSchema),
  warnings: Schema.Array(WarningItemSchema),
}).annotate({ identifier: 'ViewModel.Summary' })
export type Summary = typeof SummarySchema.Type
