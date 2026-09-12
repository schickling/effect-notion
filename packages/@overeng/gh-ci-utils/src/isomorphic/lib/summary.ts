/**
 * CI verdict computation — the single source of truth for the `status --output json`
 * `summary` object and for the process exit code.
 *
 * Deliberately dependency-free (schemas + pure helpers only) so it can be unit-tested
 * without pulling in the CLI, React, or the TUI renderer.
 */
import type { WorkflowJob } from '../GitHubSchemas.ts'
import { computeDurationSeconds, formatRunnerIdentity, parseRunnerIdentity } from './format.ts'
import type {
  PrHealth,
  RunInfo,
  Summary,
  SummaryOverallStatus,
  WarningItem,
  WorkflowJobVM,
} from './viewModels.ts'

/**
 * How the inspected run was chosen.
 *
 * Without this, a verdict can only describe the run it was handed — it cannot say
 * "the check you care about never ran for this commit", which is the difference
 * between `passing` and `no_checks`.
 */
export type RunSelection = {
  /** PR the verdict is about, when the target was a PR. */
  readonly prNumber: number | null
  /** Commit the verdict is supposed to describe (PR head SHA), when known. */
  readonly expectedHeadSha: string | null
  /**
   * Workflow file the verdict is supposed to describe (e.g. `ci.yml`), or `null` when
   * nothing was expected — no `--workflow` was given and the commit has no `ci.yml`
   * run, so whatever did run is judged on its own jobs.
   */
  readonly expectedWorkflow: string | null
  /**
   * Whether a run of `expectedWorkflow` was found for `expectedHeadSha`. Meaningless
   * (and always `true`) when `expectedWorkflow` is `null`.
   */
  readonly matchedExpectedWorkflow: boolean
  /** Head SHA of the run actually inspected. */
  readonly runHeadSha: string | null
}

/**
 * Selection for targets that name a run directly (run id / run URL). Nothing is
 * "expected" there, so the verdict is derived purely from the run's own jobs.
 */
export const directRunSelection: RunSelection = {
  prNumber: null,
  expectedHeadSha: null,
  expectedWorkflow: null,
  matchedExpectedWorkflow: true,
  runHeadSha: null,
}

/**
 * A workflow run or job conclusion that must block a green verdict.
 *
 * Excluded, each for its own reason:
 * - `success` — the pass itself.
 * - `skipped` — not a failure, but not a pass either; {@link computeSummary} encodes that.
 * - `cancelled` — gets its own verdict.
 * - `neutral` — GitHub treats it as non-blocking (it does not fail a required check),
 *   so a verdict must not either.
 */
export const isBlockingConclusion = (conclusion: string | null): boolean =>
  conclusion !== null &&
  conclusion !== 'success' &&
  conclusion !== 'skipped' &&
  conclusion !== 'cancelled' &&
  conclusion !== 'neutral'

/** A terminal conclusion that did not complete successfully. */
export const isUnsuccessfulConclusion = (conclusion: string | null): boolean =>
  conclusion === 'cancelled' || isBlockingConclusion(conclusion)

/** Map a GitHub Actions job onto its display/JSON view model. */
export const toJobVM = ({
  job,
  runHtmlUrl,
  includeSteps,
}: {
  job: WorkflowJob
  runHtmlUrl: string
  includeSteps: boolean
}): WorkflowJobVM => {
  const runnerIdentity = parseRunnerIdentity({ name: job.runner_name, labels: job.labels })
  return {
    id: job.id,
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    durationSeconds: computeDurationSeconds({
      startedAt: job.started_at,
      completedAt: job.completed_at,
    }),
    runner: formatRunnerIdentity(runnerIdentity),
    runnerName: job.runner_name,
    runnerKind: runnerIdentity._tag,
    runnerInstance: runnerIdentity.instance,
    jobUrl: `${runHtmlUrl}/job/${job.id}`,
    ...(includeSteps
      ? {
          steps: job.steps.map((s) => ({
            name: s.name,
            status: s.status,
            conclusion: s.conclusion,
            number: s.number,
            startedAt: s.started_at?.toISOString() ?? null,
            completedAt: s.completed_at?.toISOString() ?? null,
          })),
        }
      : {}),
    failedStepName: job.steps.find((s) => s.conclusion === 'failure')?.name ?? null,
  }
}

/** True when the inspected run describes a different commit than the one under review. */
export const isStaleRunSelection = (selection: RunSelection): boolean =>
  selection.expectedHeadSha !== null &&
  selection.runHeadSha !== null &&
  selection.expectedHeadSha !== selection.runHeadSha

/**
 * True when the caller named a workflow (`--workflow`, or a PR head commit that has a
 * `ci.yml` run) and the inspected run is not it.
 *
 * `expectedWorkflow === null` means nothing was expected, so nothing is missing: the
 * run is judged on its own jobs. Guarding both the verdict and the warning on this one
 * predicate keeps `no_checks` from ever appearing without a warning naming why.
 */
export const isWrongWorkflowSelection = (selection: RunSelection): boolean =>
  selection.expectedWorkflow !== null && !selection.matchedExpectedWorkflow

const computeOverallStatus = ({
  run,
  jobs,
  selection,
}: {
  run: RunInfo
  jobs: readonly WorkflowJobVM[]
  selection: RunSelection
}): SummaryOverallStatus => {
  // A verdict about the wrong workflow or the wrong commit is not a verdict.
  // Validate the selection before considering conclusions from an unrelated fallback.
  if (isWrongWorkflowSelection(selection) || isStaleRunSelection(selection)) return 'no_checks'

  if (
    isBlockingConclusion(run.conclusion) ||
    jobs.some((job) => isBlockingConclusion(job.conclusion))
  )
    return 'failing'

  if (run.conclusion === 'cancelled' || jobs.some((job) => job.conclusion === 'cancelled'))
    return 'cancelled'

  // Anything short of `completed` — queued, waiting, requested, pending, in_progress —
  // means the answer is still coming. The run's own status matters on its own: a freshly
  // queued run has no jobs yet, and calling that `no_checks` tells a caller to give up
  // on CI that is about to start.
  if (run.status !== 'completed' || jobs.some((job) => job.status !== 'completed'))
    return 'in_progress'

  if (jobs.length === 0) return 'no_checks'
  if (jobs.every((job) => job.conclusion === 'skipped')) return 'skipped'
  return 'passing'
}

/** Compute the problems-first summary for a single run. */
export const computeSummary = ({
  run,
  jobs,
  prHealth,
  selection,
}: {
  run: RunInfo
  jobs: readonly WorkflowJobVM[]
  prHealth: PrHealth | null
  selection: RunSelection
}): Summary => {
  const overallStatus = computeOverallStatus({ run, jobs, selection })

  const critical = jobs
    .filter((j) => isBlockingConclusion(j.conclusion))
    .map((job) => ({
      jobName: job.name,
      jobId: job.id,
      failedStepName: job.failedStepName,
      durationSeconds: job.durationSeconds,
      runner: job.runner,
      fixCommand: `gh-ci-utils logs ${run.id} --job ${job.id}`,
    }))

  const warnings: WarningItem[] = []
  if (isWrongWorkflowSelection(selection)) {
    warnings.push({
      _tag: 'ExpectedWorkflowMissing',
      workflow: selection.expectedWorkflow!,
      headSha: selection.expectedHeadSha,
      inspectedWorkflowPath: run.workflowPath,
    })
  }
  if (isStaleRunSelection(selection)) {
    warnings.push({
      _tag: 'StaleRun',
      expectedHeadSha: selection.expectedHeadSha!,
      runHeadSha: selection.runHeadSha!,
    })
  }
  if (prHealth?.mergeable === 'CONFLICTING') {
    warnings.push({ _tag: 'MergeConflicts', prNumber: prHealth.prNumber })
  }
  if (prHealth !== null && prHealth.behindBy > 0) {
    warnings.push({
      _tag: 'BranchBehind',
      behindBy: prHealth.behindBy,
      baseRefName: prHealth.baseRefName,
    })
  }

  return { overallStatus, critical, warnings }
}

/**
 * Process exit code for a computed verdict.
 *
 * 0 pass / 1 blocked by CI or PR health / 3 inconclusive (nothing authoritative ran).
 * Exit 2 (watch timeout) and 130 (interrupt) are owned by the renderer's error states.
 *
 * PR-health blockers outrank "inconclusive": a conflicting or behind branch cannot be
 * merged whatever CI did or did not run, so it must report blocked, not unknown.
 */
export const exitCodeForSummary = ({
  summary,
  prHealth,
}: {
  summary: Summary
  prHealth: PrHealth | null
}): number => {
  if (summary.overallStatus === 'failing' || summary.overallStatus === 'cancelled') return 1
  if (prHealth?.mergeable === 'CONFLICTING') return 1
  if (prHealth !== null && prHealth.behindBy > 0) return 1
  if (summary.overallStatus === 'no_checks' || summary.overallStatus === 'skipped') return 3
  return 0
}
