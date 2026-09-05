/**
 * Shared CI configuration for genie files.
 * Single source of truth for CI job names used in both:
 * - .github/workflows/ci.yml.genie.ts (job definitions)
 * - .github/repo-settings.json.genie.ts (required status checks)
 */

/** Runner profiles for multi-platform CI jobs */
export const RUNNER_PROFILES = [
  'namespace-profile-linux-x86-64',
  'namespace-profile-macos-arm64',
] as const

/** Union of supported GitHub Actions runner profile labels. */
export type RunnerProfile = (typeof RUNNER_PROFILES)[number]

/** Core CI job keys used for the typed product-job block in the workflow generator. */
export const CORE_CI_JOB_NAMES = [
  'typecheck',
  'lint',
  'test',
  'test-megarepo-cold-gc',
  'pnpm-regression',
  'bundle-smoke',
  // Local-only Buck graph, receipt, bridge, and benchmark-contract evidence.
  'buck2',
  // Rust lane: delegates build/test/clippy/fmt semantics to devenv task cargo:check.
  'cargo',
  // Additive Weaver semantic-conventions gate (separate lane; degrades if weaver unavailable).
  'weaver',
] as const

/** Union of core CI job keys used by the shared product-job generator. */
export type CoreCIJobName = (typeof CORE_CI_JOB_NAMES)[number]

/** Required source-policy job key generated before the core product-job block. */
export const DEFAULT_REF_POLICY_CI_JOB_NAME = 'default-ref-policy' as const

/** Additional CI job keys generated outside the core product-job block. */
export const EXTRA_CI_JOB_NAMES = [
  // Empirical install-free authority (R32, issue #884): builds the declared Buck Genie product,
  // runs its bootstrap phase cold (no node_modules), then checks lock-derived projections
  // install-free. Merge-blocking.
  'bootstrap-cold-proof',
  'nix-closure-sizes',
  'source-shape',
  'test-integration-notion',
  'test-integration-restate',
  'test-live-deploy-ci-tools',
] as const

/**
 * Lanes that deliberately do not run on every pull request.
 *
 * These cannot be required status checks: a lane that is skipped reports no check run at
 * all, so branch protection would wait for a status that never arrives.
 *
 * `devenv-perf` is the paired wall-clock lane. It is trend telemetry on a nightly cadence
 * against `main` plus an opt-in `ci:perf` label for a pull request that needs the numbers
 * before merge, because a 35-minute advisory measurement is not worth paying on every push.
 *
 * The three `buck2-cache-*` lanes are the 03-materialization DQ1 connectivity probe: they
 * need an ephemeral tailnet node and repository cache configuration that a fork pull
 * request never receives, and the outage leg is REQUIRED to fail its Buck build. The
 * `buck2-capacity` lane is the manually dispatched cache-disabled DQ4 measurement. These
 * facts make them operator-dispatched evidence lanes rather than merge gates.
 */
export const OPT_IN_CI_JOB_NAMES = [
  'devenv-perf',
  'buck2-cache-publish',
  'buck2-cache-restore',
  'buck2-cache-outage',
  'buck2-capacity',
] as const

/**
 * Pull-request label that opts one pull request into the `devenv-perf` lane.
 *
 * A maintainer-managed, revocable CI capability grant in the `ci:*` axis, repo-local
 * because only this repository has the lane. The workflow trigger and the label catalog
 * must agree on the exact string, so both read it from here.
 */
export const perfLaneLabel = 'ci:perf'

/** Required deploy/reporting job keys that block merge when they fail. */
export const REQUIRED_DEPLOY_CI_JOB_NAMES = ['deploy-storybooks'] as const

/** Workflow jobs that intentionally do not block merging. */
export const advisoryCIJobNames = ['ci-measurements-report', 'notify-alignment'] as const

/** CI job keys emitted by the generated workflow. */
export const CI_JOB_NAMES = [
  DEFAULT_REF_POLICY_CI_JOB_NAME,
  ...CORE_CI_JOB_NAMES,
  ...EXTRA_CI_JOB_NAMES,
  ...OPT_IN_CI_JOB_NAMES,
  ...REQUIRED_DEPLOY_CI_JOB_NAMES,
  ...advisoryCIJobNames,
] as const

/** Union of canonical CI job keys used across workflow generation and repo settings. */
export type CIJobName = (typeof CI_JOB_NAMES)[number]

/**
 * Merge-blocking CI job keys for branch protection.
 *
 * Every lane that runs on every pull request and is not advisory is required. Measurement
 * jobs can still run warn-mode comparisons internally, but the lane must produce its
 * artifact and complete successfully so branch protection covers CI evidence production.
 * Lanes in `OPT_IN_CI_JOB_NAMES` are excluded because they do not run on every pull
 * request.
 */
export const REQUIRED_CI_JOB_NAMES = [
  DEFAULT_REF_POLICY_CI_JOB_NAME,
  ...CORE_CI_JOB_NAMES,
  ...EXTRA_CI_JOB_NAMES,
  ...REQUIRED_DEPLOY_CI_JOB_NAMES,
] as const satisfies readonly CIJobName[]

const matrixCIJobNames = ['test'] as const

/** GitHub status-check context names emitted by a workflow job key. */
export const ciJobCheckContexts = (jobName: CIJobName) => {
  if (jobName === 'ci-measurements-report') return ['ci/measurements-report']

  return matrixCIJobNames.includes(jobName as (typeof matrixCIJobNames)[number]) === true
    ? RUNNER_PROFILES.map((runner) => `${jobName} (${runner})`)
    : [jobName]
}

/**
 * Required status checks for branch protection.
 * Matrix jobs are reported as "job-name (matrix-value)" by GitHub Actions.
 */
export const requiredCIJobs = REQUIRED_CI_JOB_NAMES.flatMap(ciJobCheckContexts)
