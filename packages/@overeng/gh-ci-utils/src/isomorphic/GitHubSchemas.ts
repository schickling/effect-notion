/**
 * Effect schemas for GitHub Actions REST API responses.
 *
 * Based on gh-ci-exporter schemas, extended with fields needed for CI debugging
 * (check annotations, log streaming support).
 *
 * @see https://docs.github.com/en/rest/actions/workflow-runs
 * @see https://docs.github.com/en/rest/actions/workflow-jobs
 * @see https://docs.github.com/en/rest/checks/runs#list-check-run-annotations
 */
import { Effect, Schema } from 'effect'

const DateFromISO = Schema.DateFromString

/** Lifecycle status of a workflow run */
export const RunStatus = Schema.Literals([
  'queued',
  'in_progress',
  'completed',
  'waiting',
  'requested',
  'pending',
])
export type RunStatus = typeof RunStatus.Type

/** Final conclusion GitHub may report for a completed workflow run, job, or step. */
export const WorkflowConclusion = Schema.Literals([
  'success',
  'failure',
  'cancelled',
  'skipped',
  'timed_out',
  'action_required',
  'stale',
  'neutral',
  'startup_failure',
])
export type WorkflowConclusion = typeof WorkflowConclusion.Type

/** Nullable conclusion reported while a workflow run has not completed. */
export const RunConclusion = Schema.NullOr(WorkflowConclusion)
export type RunConclusion = typeof RunConclusion.Type

/** Schema for a GitHub Actions workflow run */
export const WorkflowRun = Schema.Struct({
  id: Schema.Finite,
  name: Schema.NullOr(Schema.String),
  path: Schema.String,
  head_branch: Schema.NullOr(Schema.String),
  head_sha: Schema.String,
  status: RunStatus,
  conclusion: RunConclusion,
  workflow_id: Schema.Finite,
  run_number: Schema.Finite,
  run_attempt: Schema.Finite,
  event: Schema.String,
  created_at: DateFromISO,
  updated_at: DateFromISO,
  run_started_at: DateFromISO,
  html_url: Schema.String,
  jobs_url: Schema.String,
  pull_requests: Schema.Array(Schema.Struct({ number: Schema.Finite })).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
})
export type WorkflowRun = typeof WorkflowRun.Type

/** Paginated response of workflow runs */
export const WorkflowRunsResponse = Schema.Struct({
  total_count: Schema.Finite,
  workflow_runs: Schema.Array(WorkflowRun),
})
export type WorkflowRunsResponse = typeof WorkflowRunsResponse.Type

/** Schema for an individual workflow step */
export const WorkflowStep = Schema.Struct({
  name: Schema.String,
  status: Schema.Literals([
    'queued',
    'in_progress',
    'completed',
    'pending',
    'waiting',
    'requested',
  ]),
  conclusion: Schema.NullOr(WorkflowConclusion),
  number: Schema.Finite,
  started_at: Schema.NullOr(DateFromISO),
  completed_at: Schema.NullOr(DateFromISO),
})
export type WorkflowStep = typeof WorkflowStep.Type

/** Schema for a GitHub Actions workflow job */
export const WorkflowJob = Schema.Struct({
  id: Schema.Finite,
  run_id: Schema.Finite,
  name: Schema.String,
  status: Schema.Literals([
    'queued',
    'in_progress',
    'completed',
    'waiting',
    'requested',
    'pending',
  ]),
  conclusion: Schema.NullOr(WorkflowConclusion),
  started_at: Schema.NullOr(DateFromISO),
  completed_at: Schema.NullOr(DateFromISO),
  runner_name: Schema.NullOr(Schema.String),
  labels: Schema.Array(Schema.String),
  steps: Schema.Array(WorkflowStep).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
})
export type WorkflowJob = typeof WorkflowJob.Type

/** Paginated response of workflow jobs */
export const WorkflowJobsResponse = Schema.Struct({
  total_count: Schema.Finite,
  jobs: Schema.Array(WorkflowJob),
})
export type WorkflowJobsResponse = typeof WorkflowJobsResponse.Type

/** Minimal PR response — the fields we need to resolve the head commit under review. */
export const PullRequest = Schema.Struct({
  number: Schema.Finite,
  head: Schema.Struct({
    ref: Schema.String,
    sha: Schema.String,
  }),
})
export type PullRequest = typeof PullRequest.Type

/** @see https://docs.github.com/en/rest/checks/runs#list-check-run-annotations */
export const CheckAnnotation = Schema.Struct({
  path: Schema.String,
  start_line: Schema.Finite,
  end_line: Schema.Finite,
  annotation_level: Schema.Literals(['notice', 'warning', 'failure']),
  message: Schema.String,
  title: Schema.NullOr(Schema.String),
  raw_details: Schema.NullOr(Schema.String),
})
export type CheckAnnotation = typeof CheckAnnotation.Type

/** Minimal repo response — only fields we need. */
export const RepoResponse = Schema.Struct({
  default_branch: Schema.String,
})
