/**
 * Fact schemas for `gh-ci-utils inspect --job <id>`.
 *
 * The command reports two independently-sourced fact groups and one derived
 * verdict, and the JSON contract keeps them structurally apart:
 *
 * - `github` — what the GitHub Actions API said about the job.
 * - `namespace` — what the local `nsc` session said about the instance that ran it.
 * - `assessment` — the only derived value, carrying its own evidence and limitations.
 *
 * Nothing here transforms dates: timings stay verbatim ISO strings so a
 * consumer can recompute anything we chose not to.
 */
import { Schema } from 'effect'

import type { WorkflowJob } from '../GitHubSchemas.ts'
import { computeDurationSeconds, parseRunnerIdentity } from './format.ts'
import { RunnerKind, StepInfoSchema } from './viewModels.ts'

// =============================================================================
// GitHub facts
// =============================================================================

/**
 * The single job GitHub reported, with its runner identity and step timings
 * preserved rather than summarised away.
 */
export const InspectGitHubFactsSchema = Schema.Struct({
  repo: Schema.String,
  jobId: Schema.Finite,
  runId: Schema.Finite,
  name: Schema.String,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  /** Verbatim `started_at` — `null` while the job is still queued. */
  startedAt: Schema.NullOr(Schema.String),
  /** Verbatim `completed_at` — `null` while the job is still running. */
  completedAt: Schema.NullOr(Schema.String),
  durationSeconds: Schema.Finite,
  /** Raw `runner_name`, exactly as GitHub reported it. */
  runnerName: Schema.NullOr(Schema.String),
  runnerKind: RunnerKind,
  runnerInstance: Schema.NullOr(Schema.String),
  labels: Schema.Array(Schema.String),
  steps: Schema.Array(StepInfoSchema),
}).annotate({ identifier: 'Inspect.GitHubFacts' })
export type InspectGitHubFacts = typeof InspectGitHubFactsSchema.Type

// =============================================================================
// Namespace facts
// =============================================================================

/**
 * Liveness of the Namespace instance that ran the job.
 *
 * `unknown` is load-bearing: `nsc`'s JSON shape is not contractually stable, so
 * a field we did not recognise must never be read as "destroyed".
 */
export const NamespaceInstanceStatus = Schema.Literals(['running', 'destroyed', 'unknown'])
export type NamespaceInstanceStatus = typeof NamespaceInstanceStatus.Type

/** What `nsc github job describe` told us about the instance behind a job. */
export const NamespaceJobFactsSchema = Schema.Struct({
  instanceId: Schema.String,
  instanceStatus: NamespaceInstanceStatus,
  /** The raw status string the CLI printed, kept even when unrecognised. */
  instanceStatusRaw: Schema.NullOr(Schema.String),
  runnerName: Schema.NullOr(Schema.String),
  containerName: Schema.NullOr(Schema.String),
  repository: Schema.NullOr(Schema.String),
  workflow: Schema.NullOr(Schema.String),
  jobName: Schema.NullOr(Schema.String),
  destroyedAt: Schema.NullOr(Schema.String),
}).annotate({ identifier: 'Inspect.NamespaceJobFacts' })
export type NamespaceJobFacts = typeof NamespaceJobFactsSchema.Type

/**
 * One instance row from `nsc instance report`.
 *
 * `cpuMaxFraction` and `ramMaxFraction` are fractions of the *allocated*
 * resources (the report's `resources_cpu_actual_max` and
 * `resources_ram_gb_actual_max_percent`), so `0.95` means 95% of the allocation.
 */
export const NamespaceUsageSchema = Schema.Struct({
  instanceId: Schema.String,
  githubJobId: Schema.String,
  allocatedCpu: Schema.Finite,
  allocatedRamGb: Schema.Finite,
  cpuMaxFraction: Schema.Finite,
  ramMaxFraction: Schema.Finite,
  createdAt: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(Schema.String),
  destroyedAt: Schema.NullOr(Schema.String),
}).annotate({ identifier: 'Inspect.NamespaceUsage' })
export type NamespaceUsage = typeof NamespaceUsageSchema.Type

/** Why a usage sample is missing. Never a reason to invent one. */
export const NamespaceUsageUnavailableReason = Schema.Literals([
  /** GitHub gave no timestamps, so no bounded report window could be derived. */
  'no-window',
  /** The report came back, but held no row for this job and instance. */
  'no-matching-row',
  'nsc-missing',
  'not-authenticated',
  'command-failed',
  'timed-out',
  'unrecognized-output',
])
export type NamespaceUsageUnavailableReason = typeof NamespaceUsageUnavailableReason.Type

/** Usage evidence, or the reason there is none. */
export const NamespaceUsageStateSchema = Schema.Union([
  Schema.TaggedStruct('sampled', { sample: NamespaceUsageSchema }),
  /** The caller did not pass `--with-usage`, so no report was requested. */
  Schema.TaggedStruct('not-requested', {}),
  Schema.TaggedStruct('unavailable', {
    reason: NamespaceUsageUnavailableReason,
    detail: Schema.NullOr(Schema.String),
  }),
]).annotate({ identifier: 'Inspect.NamespaceUsageState' })
export type NamespaceUsageState = typeof NamespaceUsageStateSchema.Type

/** Why the Namespace side holds no observation. All of these are ordinary data. */
export const NamespaceUnavailableReason = Schema.Literals([
  /** No `nsc` on PATH — expected on machines that never talk to Namespace. */
  'nsc-missing',
  /** `nsc auth check-login` refused: there is no usable ambient session. */
  'not-authenticated',
  'command-failed',
  'timed-out',
  /** `nsc` answered, but not in a shape we can read without guessing. */
  'unrecognized-output',
  /** `nsc` does not know this job id. */
  'job-not-found',
])
export type NamespaceUnavailableReason = typeof NamespaceUnavailableReason.Type

/**
 * The Namespace observation, kept structurally separate from the assessment so
 * a consumer can always tell an absent observation from a negative one.
 */
export const InspectNamespaceFactsSchema = Schema.Union([
  Schema.TaggedStruct('reported', {
    job: NamespaceJobFactsSchema,
    usage: NamespaceUsageStateSchema,
    /** Exactly the read-only argv this run executed, in order. */
    commands: Schema.Array(Schema.Array(Schema.String)),
  }),
  /**
   * GitHub says the job did not run on a Namespace runner, so no `nsc` command
   * was executed at all.
   */
  Schema.TaggedStruct('not-namespace-job', { runnerKind: RunnerKind }),
  Schema.TaggedStruct('unavailable', {
    reason: NamespaceUnavailableReason,
    detail: Schema.NullOr(Schema.String),
    commands: Schema.Array(Schema.Array(Schema.String)),
  }),
]).annotate({ identifier: 'Inspect.NamespaceFacts' })
export type InspectNamespaceFacts = typeof InspectNamespaceFactsSchema.Type

// =============================================================================
// Assessment
// =============================================================================

/**
 * The only four things this command is willing to claim about a runner.
 *
 * There is deliberately no "healthy" or "stuck": both would need evidence
 * neither GitHub nor `nsc` provides.
 */
export const InspectDisposition = Schema.Literals([
  'active',
  'idle',
  'resource-pressure',
  'unknown',
])
export type InspectDisposition = typeof InspectDisposition.Type

/** A disposition plus what it rests on and what it could not see. */
export const InspectAssessmentSchema = Schema.Struct({
  disposition: InspectDisposition,
  /** Observations that support the disposition. */
  evidence: Schema.Array(Schema.String),
  /** What was not observable, and therefore not claimed. */
  limitations: Schema.Array(Schema.String),
}).annotate({ identifier: 'Inspect.Assessment' })
export type InspectAssessment = typeof InspectAssessmentSchema.Type

/**
 * Fraction of allocated CPU or RAM at or above which a runner is reported as
 * under resource pressure.
 */
export const RESOURCE_PRESSURE_FRACTION = 0.95

/**
 * Map the raw GitHub job onto inspect's GitHub facts.
 *
 * The API's decoded `Date`s go back out as verbatim ISO strings, and every
 * step is carried through with its own timings: this command exists to explain
 * a runner, so throwing away the timing data it would be explained from
 * defeats the point.
 */
export const toInspectGitHubFacts = ({
  job,
  repo,
}: {
  readonly job: WorkflowJob
  readonly repo: string
}): InspectGitHubFacts => {
  const identity = parseRunnerIdentity({ name: job.runner_name, labels: job.labels })
  return {
    repo,
    jobId: job.id,
    runId: job.run_id,
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    startedAt: job.started_at?.toISOString() ?? null,
    completedAt: job.completed_at?.toISOString() ?? null,
    durationSeconds: computeDurationSeconds({
      startedAt: job.started_at,
      completedAt: job.completed_at,
    }),
    runnerName: job.runner_name,
    runnerKind: identity._tag,
    runnerInstance: identity.instance,
    labels: job.labels,
    steps: job.steps.map((step) => ({
      name: step.name,
      status: step.status,
      conclusion: step.conclusion,
      number: step.number,
      startedAt: step.started_at?.toISOString() ?? null,
      completedAt: step.completed_at?.toISOString() ?? null,
    })),
  }
}
