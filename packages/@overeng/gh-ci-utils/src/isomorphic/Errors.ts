import { Schema } from 'effect'

/** Raised when CLI configuration is invalid or missing */
export class ConfigError extends Schema.TaggedError<ConfigError>()('ConfigError', {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

/** Raised when a GitHub REST API call fails */
export class GitHubApiError extends Schema.TaggedError<GitHubApiError>()('GitHubApiError', {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

/** Raised when GitHub authentication fails */
export class GitHubAuthError extends Schema.TaggedError<GitHubAuthError>()('GitHubAuthError', {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

/** Raised when a runner API call fails */
export class RunnerApiError extends Schema.TaggedError<RunnerApiError>()('RunnerApiError', {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

/** Azure Blob Storage returned an error instead of log content (e.g. expired URL, BlobNotFound) */
export class LogsUnavailableError extends Schema.TaggedError<LogsUnavailableError>()(
  'LogsUnavailableError',
  {
    message: Schema.String,
    jobId: Schema.Finite,
  },
) {}
