/**
 * Shared CI workflow building blocks for GitHub Actions.
 *
 * Provides composable step atoms and job configuration helpers
 * that peer repos import to avoid CI template duplication.
 *
 * @example
 * ```ts
 * import {
 *   checkoutStep, installNixStep, cachixStep,
 *   preparePinnedDevenvStep, validateNixStoreStep, nixDiagnosticsArtifactStep,
 *   runDevenvTasksBefore, standardCIEnv,
 * } from '../../repos/effect-utils/genie/ci-workflow.ts'
 *
 * const baseSteps = [
 *   checkoutStep(),
 *   installNixStep(),
 *   cachixStep({ name: 'my-cache' }),
 *   preparePinnedDevenvStep,
 *   validateNixStoreStep,
 *   nixDiagnosticsArtifactStep(),
 * ]
 * ```
 */

import type { GitHubWorkflowArgs } from '../packages/@overeng/genie/src/runtime/mod.ts'
import {
  defaultRefPolicyCheckStep,
  type DefaultRefPolicyCheckStepOptions,
} from './ci-workflow/megarepo.ts'
import { checkoutStep, installNixStep } from './ci-workflow/setup.ts'
import { bashShellDefaults, linuxX64Runner, standardCIEnv } from './ci-workflow/shared.ts'

type GitHubWorkflowJob = GitHubWorkflowArgs['jobs'][string]
type GitHubWorkflowStep = GitHubWorkflowJob['steps'][number]

/** Options for wrapping the default-ref policy check in a dedicated CI job. */
export type DefaultRefPolicyCheckJobOptions = DefaultRefPolicyCheckStepOptions & {
  readonly name?: string
  readonly runsOn?: GitHubWorkflowJob['runs-on']
  readonly env?: Record<string, string>
  readonly permissions?: GitHubWorkflowJob['permissions']
  readonly defaults?: GitHubWorkflowJob['defaults']
  readonly preSteps?: readonly GitHubWorkflowStep[]
  readonly postSteps?: readonly GitHubWorkflowStep[]
}

/**
 * Dedicated CI job for first-party default-ref policy.
 *
 * We intentionally keep this out of lint/typecheck/test jobs. Downstream PRs
 * often validate against temporary first-party branches while an upstream PR is
 * still open, and that should fail in one authority/policy job without hiding
 * whether the actual product jobs are green. Before merge, repos must retarget
 * those first-party inputs back to their default refs and refresh locks.
 */
export const defaultRefPolicyCheckJob = (opts: DefaultRefPolicyCheckJobOptions = {}) => {
  const { name, runsOn, env, permissions, defaults, preSteps, postSteps, ...stepOpts } = opts

  return {
    ...(name === undefined ? {} : { name }),
    'runs-on': runsOn ?? linuxX64Runner,
    permissions: permissions ?? { contents: 'read' },
    defaults: defaults ?? bashShellDefaults,
    env: { ...standardCIEnv, ...env },
    steps: [
      checkoutStep(),
      installNixStep(),
      ...(preSteps ?? []),
      defaultRefPolicyCheckStep(stepOpts),
      ...(postSteps ?? []),
    ],
  } satisfies GitHubWorkflowJob
}

export {
  RUNNER_PROFILES,
  bashShellDefaults,
  cachixBinaryCache,
  ciWorkflow,
  ciWorkflowConcurrency,
  createRunDevenvTasksBefore,
  darwinArm64Runner,
  defaultCiRuntimeScriptsDir,
  defaultActionlintConfig,
  devenvBinaryCache,
  ciCompositionStateRoot,
  ciNixCachePath,
  ciNixCacheRoot,
  ciPnpmHome,
  ciPnpmStatePaths,
  ciPnpmStore,
  ciSourceRoot,
  jobLocalCiDiagnosticsDir,
  linuxArm64Runner,
  linuxX64Runner,
  namespaceLinuxX64PairedPerfRunner,
  nixBinaryCachesExtraConf,
  nixExtraConf,
  preparedCiRuntimeScriptsDir,
  prepareJobLocalRustState,
  runDevenvTasksBefore,
  standardCIEnv,
  withCiSourceRoot,
  withGcRaceRetry,
  type GcRaceRetryOptions,
  type NixBinaryCache,
  type RunnerProfile,
} from './ci-workflow/shared.ts'
export {
  ciMeasurementMetrics,
  ciMeasurementBaselineBackfillPredicate,
  ciMeasurementBaselineCheckoutStep,
  ciMeasurementBaselineWorkflowDispatchInputs,
  ciMeasurementNotBaselineBackfillPredicate,
  ciMeasurementSubjectEnv,
  ciMeasurementsArtifactStep,
  ciMeasurementsCommentPermissions,
  compareCiMeasurementsStep,
  defaultNixClosureMeasurementBuckets,
  downloadPreviousGitHubArtifactStep,
  devenvPerfArtifactStep,
  devenvPerfBenchmarkStep,
  devenvPerfJob,
  nixClosureMeasurementSteps,
  nixClosureMeasurementsJob,
  nixClosureMeasurementStep,
  sourceShapeMeasurementStep,
  type CiMeasurementDescriptor,
  type CiMeasurementObservation,
  type CiMeasurementsArtifactStepOptions,
  type CiMeasurementsComparisonStepOptions,
  type DevenvPerfJobOptions,
  type DevenvPerfProbe,
  type DevenvPerfTaskProbe,
  type GitHubPreviousArtifactStepOptions,
  type NixClosureMeasurementBucket,
  type NixClosureMeasurementStepOptions,
  type NixClosureMeasurementTarget,
  type NixClosureMeasurementsJobOptions,
  type NixClosureMeasurementsStepsOptions,
  type SourceShapeMeasurementScope,
  type SourceShapeMeasurementStepOptions,
} from './ci-workflow/measurements.ts'
export {
  workflowReportCommentBodyStep,
  workflowReportCollectorStep,
  workflowReportProducerStep,
  workflowReportPublisherStep,
  type WorkflowReportCommentBodyStepOptions,
  type WorkflowReportCollectorStepOptions,
  type WorkflowReportProducerStepOptions,
  type WorkflowReportPublisherStepOptions,
} from './ci-workflow/reporting.ts'
export {
  prSnapshotForeignEventGuard,
  prSnapshotPackJob,
  prSnapshotPackJobId,
  prSnapshotReleaseJobs,
  prSnapshotTrustLabel,
  type PrSnapshotPackJobOptions,
  type PrSnapshotReleaseJobsOptions,
  type PrSnapshotSharedOptions,
} from './ci-workflow/pr-snapshot.ts'
export {
  ciWorkflowJobLocalRustStateScript,
  ciWorkflowJobLocalRustStateScriptPath,
  ciWorkflowNixGcRaceRetryScriptPath,
  ciWorkflowNixGcRaceRetryWrapperPath,
  ciWorkflowPrSnapshotArtifactScriptPath,
  ciWorkflowPrSnapshotArtifactTestPath,
  emittedPrSnapshotValidatorPath,
  emittedPrSnapshotValidatorTestPath,
  ciWorkflowSupportFiles,
  type CiWorkflowSupportFiles,
} from './ci-workflow/support-files.ts'
export {
  appendGitHubAccessTokenToNixConfigStep,
  buck2CapacityEvidenceArtifactStep,
  buck2CapacityEvidenceDir,
  buck2SharedCacheLaneStep,
  buck2SharedCachePreflightStep,
  buck2SharedCacheProvenanceArtifactStep,
  buck2SharedCacheProvenanceDir,
  cachixCliBuildStep,
  cachixStep,
  checkoutStep,
  cleanupEffectUtilsCompositionStep,
  ciDiagnosticsArtifactStep,
  ciDiagnosticsSetupStep,
  captureRunnerPressureStep,
  coldFreshNixBuildStep,
  evictCachedPnpmDepsStep,
  githubAccessTokenEnv,
  githubAppInstallationTokenStep,
  installNixStep,
  namespaceRunner,
  nixCacheSetupStep,
  nixDiagnosticsArtifactStep,
  pnpmBuilderContractStep,
  defaultPnpmStateKeyPrefix,
  pnpmInstallWithDiagnosticsStep,
  pnpmStateCacheVersion,
  pnpmStatePublisherPostSteps,
  pnpmStateSetupStep,
  prepareCiScriptsStep,
  prepareEffectUtilsCompositionStep,
  preparePinnedDevenvStep,
  preparePinnedDevenvStepFor,
  restoreNixCacheStep,
  restorePnpmStateStep,
  saveNixCacheStep,
  savePnpmStateStep,
  devenvTaskStep,
  standardSelfHostedDevenvTaskJob,
  standardSelfHostedPnpmCiPostSteps,
  standardSelfHostedPnpmCiPrepSteps,
  tailnetEphemeralConnectStep,
  tailnetEphemeralDisconnectStep,
  validateColdPnpmDepsStep,
  validateNixStoreStep,
  validateNixStoreStepFor,
  withSinglePnpmStatePublisher,
  withGitHubAccessTokenEnv,
  withPrivateCachixReadAuth,
  type StandardSelfHostedDevenvTaskJobOptions,
} from './ci-workflow/setup.ts'
export {
  applyMegarepoLockStep,
  defaultRefPolicyCheckStep,
  cacheableMegarepoStore,
  installMegarepoStep,
  jobLocalMegarepoStore,
  restoreMegarepoStoreStep,
  saveMegarepoStoreStep,
  syncMegarepoWorkspaceStep,
  type DefaultRefPolicyCheckStepOptions,
} from './ci-workflow/megarepo.ts'
export {
  fullPullRequestCiEvent,
  githubApiGetFunctionLines,
  mergeQueueAdmissionCheckLines,
  mergeQueueAdmissionDeferredLines,
  mergeQueueAdmissionEvidence,
  mergeQueueAdmissionGateJob,
  mergeQueueAdmissionLabel,
  mergeQueueAdmissionLabelEvent,
  mergeQueueAdmissionStep,
  mergeQueueAdmittedJob,
  mergeQueuePullRequestTrigger,
  mergeQueueRequiredCIJobs,
  mergeQueueSemanticGateJob,
  mergeQueueSemanticGateJobs,
  mergeQueueWorkflowOn,
  mergeQueueWorkflowConcurrency,
  nonScheduleRequiredGateIf,
  requiredCiMaterializingEvent,
  requiredGateCheckName,
  skipNonMaterializingPrControlEventLines,
  type MergeQueueAdmissionCheckOptions,
  type MergeQueueAdmissionGateJobOptions,
  type MergeQueueAdmissionStepOptions,
  type MergeQueueAdmittedJobOptions,
  type MergeQueueSemanticGateJobOptions,
  type MergeQueueSemanticGateSpec,
} from './ci-workflow/merge-queue.ts'
export {
  deployCommentPermissions,
  dispatchAlignmentStep,
  deployPreviewWorkflowReportOutputName,
  deployPreviewWorkflowReportPathOutputName,
  netlifyDeployStep,
  notifyAlignmentJob,
  vercelDeployJobs,
  vercelDeployStep,
  vercelGitAuthorStep,
} from './ci-workflow/deploy.ts'
export {
  releaseWorkflow,
  type ReleaseChannel,
  type ReleaseWorkflowOptions,
} from './ci-workflow/release.ts'
