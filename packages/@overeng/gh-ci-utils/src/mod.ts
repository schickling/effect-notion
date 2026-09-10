/**
 * @overeng/gh-ci-utils
 *
 * CLI for real-time CI debugging — per-job status, log fetching, and structured annotations.
 */

export { ghCiUtilsCommand } from './cli.ts'

export { GitHubClient } from './node/GitHubClient.ts'
export { GitHubInternal, type InternalStep, type BackscrollLine } from './node/GitHubInternal.ts'
export {
  loadSession,
  saveSession,
  isSessionNearExpiry,
  type SessionData,
} from './node/GitHubSession.ts'
export {
  GitHubApiError,
  GitHubAuthError,
  ConfigError,
  RunnerApiError,
} from './isomorphic/Errors.ts'
export {
  parseTarget,
  resolveActiveTarget,
  resolveActiveTargetOrCurrentBranch,
  resolveTarget,
  resolveTargetOrCurrentBranch,
  type ParsedTarget,
} from './node/RunId.ts'
export { resolveConfig, type CiUtilsConfig } from './node/Config.ts'
export { fetchAllRunnerJobs, type ActiveJob } from './node/RunnerClient.ts'

export type {
  WorkflowRun,
  WorkflowJob,
  WorkflowStep,
  CheckAnnotation,
} from './isomorphic/GitHubSchemas.ts'
