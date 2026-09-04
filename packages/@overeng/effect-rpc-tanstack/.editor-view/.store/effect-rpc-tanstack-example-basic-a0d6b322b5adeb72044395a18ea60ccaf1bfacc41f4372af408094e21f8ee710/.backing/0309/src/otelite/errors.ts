import { Schema } from 'effect'

/**
 * Tagged errors on the `@overeng/utils-dev/otelite` error channel. The CLI's
 * `sysexits.h` taxonomy (see otelite spec "Exit codes") maps onto these — a
 * non-zero otelite exit becomes a tagged failure, never a defect.
 */

/** Failed to spawn the `otelite` binary at all (e.g. not on `PATH`). */
export class OteliteSpawnError extends Schema.TaggedError<OteliteSpawnError>(
  '@overeng/utils-dev/otelite/OteliteSpawnError',
)('OteliteSpawnError', {
  /** The full argv otelite was invoked with. */
  argv: Schema.Array(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `failed to spawn otelite (${this.argv.join(' ')})`
  }
}

/**
 * The child process otelite ran (under `run`) exited non-zero. This is the
 * happy-path exit code passthrough — otelite's own failures surface as
 * {@link OteliteCliError} instead, disambiguated by otelite's empty stdout.
 */
export class OteliteChildFailed extends Schema.TaggedError<OteliteChildFailed>(
  '@overeng/utils-dev/otelite/OteliteChildFailed',
)('OteliteChildFailed', {
  /** The child's exit code (a signal-killed child is reported as `128 + signo`). */
  exitCode: Schema.Int,
  argv: Schema.Array(Schema.String),
  stderr: Schema.optional(Schema.String),
}) {
  override get message(): string {
    return `otelite child exited with code ${this.exitCode} (${this.argv.join(' ')})`
  }
}

/**
 * otelite itself failed with a `sysexits.h` code (bad flags, decode error,
 * missing source, bind/write failure, drain timeout, internal bug). Mapped
 * from the otelite exit-code table.
 */
export class OteliteCliError extends Schema.TaggedError<OteliteCliError>(
  '@overeng/utils-dev/otelite/OteliteCliError',
)('OteliteCliError', {
  /** The raw otelite exit code (one of the `sysexits.h` values). */
  exitCode: Schema.Int,
  /** Symbolic reason mapped from the exit code, or `unknown`. */
  reason: Schema.Literals([
    'usage', // 64
    'data-err', // 65 — decode error
    'no-input', // 66 — inspect source missing
    'cant-create', // 73 — cannot create/write out-dir
    'io-err', // 74 — receiver bind / write failure
    'drain-timeout', // 75
    'software', // 70 — internal otelite bug
    'unimplemented', // 69
    'unknown',
  ]),
  argv: Schema.Array(Schema.String),
  stderr: Schema.optional(Schema.String),
}) {
  override get message(): string {
    return `otelite failed: ${this.reason} (exit ${this.exitCode}) (${this.argv.join(' ')})`
  }
}

/** otelite stdout did not decode against the expected `Schema`. */
export class OteliteDecodeError extends Schema.TaggedError<OteliteDecodeError>(
  '@overeng/utils-dev/otelite/OteliteDecodeError',
)('OteliteDecodeError', {
  /** Which CLI output we tried to decode. */
  kind: Schema.Literals([
    'summary',
    'span',
    'metric',
    'log',
    'trace-summary',
    'metric-summary',
    'log-summary',
  ]),
  /** The raw line/stdout that failed to decode. */
  raw: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `failed to decode otelite ${this.kind} output`
  }
}

/** Maps an otelite `sysexits.h` exit code to a {@link OteliteCliError} reason. */
export const cliReasonForExitCode = (
  exitCode: number,
): typeof OteliteCliError.fields.reason.Type => {
  switch (exitCode) {
    case 64:
      return 'usage'
    case 65:
      return 'data-err'
    case 66:
      return 'no-input'
    case 69:
      return 'unimplemented'
    case 70:
      return 'software'
    case 73:
      return 'cant-create'
    case 74:
      return 'io-err'
    case 75:
      return 'drain-timeout'
    default:
      return 'unknown'
  }
}
