/**
 * Read-only Namespace (`nsc`) adapter for `gh-ci-utils inspect`.
 *
 * # Trust boundary
 *
 * This adapter uses the *ambient* `nsc` session and may only ever run these
 * three commands, all of them read-only:
 *
 *   - `nsc auth check-login`
 *   - `nsc github job describe <job-id> -o json`
 *   - `nsc instance report --start … --end … --out - --repository … --jobname …`
 *
 * It must never log in, open an SSH session, start/stop/destroy an instance,
 * mint a token, touch a vault, or execute anything remotely. `ALLOWED_ARGV`
 * below is the whole permitted surface, every invocation is recorded in the
 * returned facts, and a test asserts the recorded argv against that list.
 *
 * # Degradation
 *
 * A missing, unauthenticated, failing, slow or unreadable `nsc` is expected
 * data, not an error: the adapter returns a tagged `unavailable` observation
 * and the caller keeps every GitHub fact it already has.
 *
 * # Decoding
 *
 * `nsc github job describe -o json` has no stable published schema, so the
 * decoder here is deliberately tolerant: it looks for known field names
 * anywhere in the returned object graph and degrades anything it does not
 * recognise to `null`/`unknown` rather than asserting a shape.
 */
import { Duration, Effect, Option, Stream } from 'effect'
import type { PlatformError } from 'effect/PlatformError'
import * as ChildProcess from 'effect/unstable/process/ChildProcess'
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner'

import type {
  InspectGitHubFacts,
  InspectNamespaceFacts,
  NamespaceInstanceStatus,
  NamespaceJobFacts,
  NamespaceUsage,
  NamespaceUsageState,
} from '../isomorphic/lib/inspectFacts.ts'

/** The `nsc` executable. Resolved from PATH; absence is ordinary data. */
const NSC = 'nsc'

/** How long each `nsc` invocation may take before it counts as timed out. */
const CHECK_LOGIN_TIMEOUT = Duration.seconds(10)
const JOB_DESCRIBE_TIMEOUT = Duration.seconds(20)
const INSTANCE_REPORT_TIMEOUT = Duration.seconds(60)

/** Padding around the GitHub job's own timestamps when bounding a report. */
const REPORT_WINDOW_PADDING_MS = 5 * 60 * 1000

// =============================================================================
// Approved argv — the entire permitted `nsc` surface
// =============================================================================

/** `nsc auth check-login` — asks whether the ambient session is usable. */
export const authCheckLoginArgv = (): ReadonlyArray<string> => ['auth', 'check-login']

/** `nsc github job describe <job-id> -o json` — one job, machine-readable. */
export const jobDescribeArgv = (jobId: number): ReadonlyArray<string> => [
  'github',
  'job',
  'describe',
  String(jobId),
  '-o',
  'json',
]

/**
 * `nsc instance report` bounded to this job's own window and narrowed with the
 * documented repository and job-name filters, streamed to stdout.
 */
export const instanceReportArgv = ({
  window,
  repository,
  jobName,
}: {
  readonly window: ReportWindow
  readonly repository: string
  readonly jobName: string
}): ReadonlyArray<string> => [
  'instance',
  'report',
  '--start',
  window.start,
  '--end',
  window.end,
  '--out',
  '-',
  '--repository',
  repository,
  '--jobname',
  jobName,
]

/**
 * Every argv prefix this adapter is allowed to run.
 *
 * Anything not matching one of these is a bug, and the adapter's own tests
 * assert the recorded invocations against it.
 */
export const ALLOWED_ARGV: ReadonlyArray<ReadonlyArray<string>> = [
  ['auth', 'check-login'],
  ['github', 'job', 'describe'],
  ['instance', 'report'],
]

/**
 * Whether an argv is one of the approved read-only invocations.
 *
 * Exported as the single place that decides what this adapter may execute.
 */
export const isAllowedArgv = (argv: ReadonlyArray<string>): boolean =>
  ALLOWED_ARGV.some((prefix) => prefix.every((segment, index) => argv[index] === segment))

// =============================================================================
// Report window
// =============================================================================

/** An inclusive `--start`/`--end` pair for `nsc instance report`. */
export interface ReportWindow {
  readonly start: string
  readonly end: string
}

/**
 * Bound a report to the job's own lifetime, padded on both sides.
 *
 * Returns `null` when GitHub never gave the job a start time: an unbounded or
 * guessed window would either cost a full-workspace scan or return rows that
 * are not this job's.
 */
export const deriveReportWindow = ({
  startedAt,
  completedAt,
  now,
}: {
  readonly startedAt: string | null
  readonly completedAt: string | null
  readonly now: Date
}): ReportWindow | null => {
  if (startedAt === null) return null
  const startMs = Date.parse(startedAt)
  if (Number.isNaN(startMs)) return null

  const parsedEnd = completedAt === null ? Number.NaN : Date.parse(completedAt)
  const endMs = Number.isNaN(parsedEnd) ? now.getTime() : parsedEnd
  /** A `completed_at` before `started_at` would invert the window; clamp it. */
  const boundedEnd = Math.max(endMs, startMs)

  return {
    start: new Date(startMs - REPORT_WINDOW_PADDING_MS).toISOString(),
    end: new Date(boundedEnd + REPORT_WINDOW_PADDING_MS).toISOString(),
  }
}

// =============================================================================
// `nsc github job describe -o json` decoding
// =============================================================================

/** Outcome of reading `nsc github job describe -o json` stdout. */
export type JobDescribeParse =
  | { readonly _tag: 'parsed'; readonly job: NamespaceJobFacts }
  | { readonly _tag: 'unrecognized'; readonly detail: string }

/** Maximum object-graph depth searched for a known field name. */
const MAX_LOOKUP_DEPTH = 6

/**
 * Find the first non-empty string stored under any of `keys`, at any depth.
 *
 * `nsc` nests the runner/instance block differently across output versions, so
 * a fixed path would break on a rename that a search survives. Keys at the
 * current level are preferred over nested ones, so a top-level `status` is
 * never shadowed by a deeper one.
 */
const findString = ({
  root,
  keys,
}: {
  root: unknown
  keys: ReadonlyArray<string>
}): string | null => {
  const visit = ({ node, depth }: { node: unknown; depth: number }): string | null => {
    if (depth > MAX_LOOKUP_DEPTH || typeof node !== 'object' || node === null) return null

    if (Array.isArray(node)) {
      for (const item of node) {
        const found = visit({ node: item, depth: depth + 1 })
        if (found !== null) return found
      }
      return null
    }

    const entries = Object.entries(node)
    for (const [key, value] of entries) {
      if (keys.includes(key) === false) continue
      if (typeof value === 'string' && value.length > 0) return value
      if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    }
    for (const [, value] of entries) {
      const found = visit({ node: value, depth: depth + 1 })
      if (found !== null) return found
    }
    return null
  }
  return visit({ node: root, depth: 0 })
}

/** Find a string field directly owned by a record, without traversing nested records. */
const findOwnedString = ({
  record,
  keys,
}: {
  record: object
  keys: ReadonlyArray<string>
}): string | null => {
  for (const key of keys) {
    const value = Reflect.get(record, key)
    if (typeof value === 'string' && value.length > 0) return value
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return null
}

/** Find the object that directly owns a matching identity field. */
const findRecord = ({
  root,
  keys,
  value,
}: {
  root: unknown
  keys: ReadonlyArray<string>
  value: string
}): object | null => {
  const visit = ({ node, depth }: { node: unknown; depth: number }): object | null => {
    if (depth > MAX_LOOKUP_DEPTH || typeof node !== 'object' || node === null) return null
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = visit({ node: item, depth: depth + 1 })
        if (found !== null) return found
      }
      return null
    }

    if (
      keys.some((key) => {
        const candidate = Reflect.get(node, key)
        return candidate === value || (typeof candidate === 'number' && String(candidate) === value)
      })
    ) {
      return node
    }

    for (const nested of Object.values(node)) {
      const found = visit({ node: nested, depth: depth + 1 })
      if (found !== null) return found
    }
    return null
  }
  return visit({ node: root, depth: 0 })
}

/** Status strings that positively establish a live instance. */
const LIVE_STATUS = /^(running|live|ready|started|starting|active|in_use)$/i
/** Status strings that positively establish a gone instance. */
const GONE_STATUS = /^(destroyed|terminated|stopped|deleted|failed|expired)$/i

/**
 * Derive liveness conservatively.
 *
 * A recorded destruction time wins over any status string, and an unrecognised
 * status stays `unknown` so it can never be read as either live or gone.
 */
export const deriveInstanceStatus = ({
  statusRaw,
  destroyedAt,
}: {
  readonly statusRaw: string | null
  readonly destroyedAt: string | null
}): NamespaceInstanceStatus => {
  if (destroyedAt !== null) return 'destroyed'
  if (statusRaw === null) return 'unknown'
  if (LIVE_STATUS.test(statusRaw)) return 'running'
  if (GONE_STATUS.test(statusRaw)) return 'destroyed'
  return 'unknown'
}

/** Decode `nsc github job describe -o json` stdout into Namespace job facts. */
export const parseJobDescribe = (stdout: string): JobDescribeParse => {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) return { _tag: 'unrecognized', detail: 'empty stdout' }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (cause) {
    return {
      _tag: 'unrecognized',
      detail: `stdout is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    }
  }

  const instanceId = findString({ root: parsed, keys: ['instance_id', 'instanceId'] })
  if (instanceId === null) {
    return { _tag: 'unrecognized', detail: 'no instance id in job description' }
  }

  const instanceRecord = findRecord({
    root: parsed,
    keys: ['instance_id', 'instanceId'],
    value: instanceId,
  })
  const destroyedAt =
    instanceRecord === null
      ? null
      : findOwnedString({ record: instanceRecord, keys: ['destroyed_at', 'destroyedAt'] })
  const statusRaw =
    instanceRecord === null
      ? null
      : findOwnedString({
          record: instanceRecord,
          keys: ['instance_status', 'instanceStatus', 'status', 'phase', 'state'],
        })

  return {
    _tag: 'parsed',
    job: {
      instanceId,
      instanceStatus: deriveInstanceStatus({ statusRaw, destroyedAt }),
      instanceStatusRaw: statusRaw,
      runnerName: findString({ root: parsed, keys: ['runner_name', 'runnerName'] }),
      containerName: findString({ root: parsed, keys: ['container_name', 'containerName'] }),
      repository: findString({
        root: parsed,
        keys: ['repository', 'github_repository', 'githubRepository'],
      }),
      workflow: findString({
        root: parsed,
        keys: ['workflow', 'workflow_name', 'workflowName', 'github_job_workflow_name'],
      }),
      jobName: findString({ root: parsed, keys: ['job_name', 'jobName'] }),
      destroyedAt,
    },
  }
}

// =============================================================================
// `nsc instance report` CSV decoding
// =============================================================================

/** The column that identifies a report's header line. */
const REPORT_HEADER_COLUMN = 'instance_id'

/**
 * Split one CSV line, honouring double-quoted fields and `""` escapes.
 *
 * Job names routinely contain commas (`build (linux, arm64)`), so a
 * `split(',')` would silently shift every later column.
 */
export const splitCsvLine = (line: string): ReadonlyArray<string> => {
  const fields: string[] = []
  let field = ''
  let quoted = false

  for (let index = 0; index < line.length; index++) {
    const char = line[index]
    if (quoted) {
      if (char !== '"') {
        field += char
      } else if (line[index + 1] === '"') {
        field += '"'
        index++
      } else {
        quoted = false
      }
      continue
    }
    if (char === '"') {
      quoted = true
    } else if (char === ',') {
      fields.push(field)
      field = ''
    } else {
      field += char
    }
  }
  fields.push(field)
  return fields
}

/** One report row, keyed by the report's own column names. */
export type InstanceReportRow = Readonly<Record<string, string>>

/** Outcome of reading `nsc instance report --out -` stdout. */
export type InstanceReportParse =
  | { readonly _tag: 'parsed'; readonly rows: ReadonlyArray<InstanceReportRow> }
  | { readonly _tag: 'unrecognized'; readonly detail: string }

/**
 * Decode a report body into column-keyed rows.
 *
 * `--out -` prefixes the CSV with a `Writing output to path: stdout` line, so
 * the header is located by its first column rather than by position.
 */
export const parseInstanceReport = (stdout: string): InstanceReportParse => {
  const lines = stdout.split('\n').map((line) => line.replace(/\r$/, ''))
  const headerIndex = lines.findIndex((line) => line.startsWith(`${REPORT_HEADER_COLUMN},`))
  if (headerIndex === -1) {
    return { _tag: 'unrecognized', detail: 'no CSV header in report output' }
  }

  const header = splitCsvLine(lines[headerIndex]!)
  const rows: Array<InstanceReportRow> = []

  for (const line of lines.slice(headerIndex + 1)) {
    if (line.trim().length === 0) continue
    const fields = splitCsvLine(line)
    const row: Record<string, string> = {}
    header.forEach((column, index) => {
      row[column] = fields[index] ?? ''
    })
    rows.push(row)
  }

  return { _tag: 'parsed', rows }
}

/** Report numbers are optional and may be blank; a blank is not a zero. */
const finiteOrNull = (raw: string | undefined): number | null => {
  if (raw === undefined || raw.trim().length === 0) return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

/**
 * Pick the row that is exactly this job on exactly this instance.
 *
 * Both ids must match: a report window is time-bounded, not job-bounded, and a
 * retried job reuses its id across instances.
 */
export const selectUsageRow = ({
  rows,
  jobId,
  instanceId,
}: {
  readonly rows: ReadonlyArray<InstanceReportRow>
  readonly jobId: number
  readonly instanceId: string
}): NamespaceUsage | null => {
  const wantedJobId = String(jobId)
  for (const row of rows) {
    if (row['github_job_id'] !== wantedJobId) continue
    if (row['instance_id'] !== instanceId) continue

    const allocatedCpu = finiteOrNull(row['resources_cpu'])
    const allocatedRamGb = finiteOrNull(row['resources_ram_gb'])
    const cpuMaxFraction = finiteOrNull(row['resources_cpu_actual_max'])
    const ramMaxFraction = finiteOrNull(row['resources_ram_gb_actual_max_percent'])
    if (
      allocatedCpu === null ||
      allocatedRamGb === null ||
      cpuMaxFraction === null ||
      ramMaxFraction === null
    ) {
      /** A row missing the numbers we would reason about is not usage evidence. */
      continue
    }

    const created = row['created_at']
    const started = row['started_at']
    const destroyed = row['destroyed_at']
    return {
      instanceId,
      githubJobId: wantedJobId,
      allocatedCpu,
      allocatedRamGb,
      cpuMaxFraction,
      ramMaxFraction,
      createdAt: created === undefined || created.length === 0 ? null : created,
      startedAt: started === undefined || started.length === 0 ? null : started,
      destroyedAt: destroyed === undefined || destroyed.length === 0 ? null : destroyed,
    }
  }
  return null
}

// =============================================================================
// Process execution
// =============================================================================

/** What a single `nsc` invocation produced. */
interface NscRun {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

/** Why an invocation produced no output at all. */
type NscFailure =
  | { readonly _tag: 'nsc-missing'; readonly detail: string }
  | { readonly _tag: 'timed-out'; readonly detail: string }
  | { readonly _tag: 'spawn-failed'; readonly detail: string }

type NscOutcome =
  | { readonly _tag: 'ran'; readonly run: NscRun }
  | { readonly _tag: 'failed'; readonly failure: NscFailure }

/**
 * Run one approved `nsc` invocation, collecting stdout, stderr and the exit
 * code concurrently.
 *
 * `spawner.string` would drop stderr and the exit code, turning a dead child
 * into an empty success that then surfaces as a bogus decode failure. stderr is
 * kept in its own field so diagnostics can never contaminate the JSON or CSV
 * that gets parsed.
 */
const runNsc = ({
  argv,
  timeout,
}: {
  readonly argv: ReadonlyArray<string>
  readonly timeout: Duration.Duration
}): Effect.Effect<NscOutcome, never, ChildProcessSpawner> =>
  Effect.gen(function* () {
    const attempt: Effect.Effect<NscRun, PlatformError, ChildProcessSpawner> = Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* ChildProcessSpawner.use((spawner) =>
          spawner.spawn(ChildProcess.make(NSC, [...argv])),
        )
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            Stream.mkString(Stream.decodeText(handle.stdout)),
            Stream.mkString(Stream.decodeText(handle.stderr)),
            handle.exitCode,
          ],
          { concurrency: 3 },
        )
        return { stdout, stderr: stderr.trim(), exitCode }
      }),
    )

    const outcome = yield* Effect.result(attempt.pipe(Effect.timeoutOption(timeout)))

    if (outcome._tag === 'Failure') {
      const { reason } = outcome.failure
      return {
        _tag: 'failed',
        failure:
          /** `NotFound` from a spawn is `nsc` not being on PATH — expected data. */
          reason._tag === 'NotFound'
            ? { _tag: 'nsc-missing', detail: outcome.failure.message }
            : { _tag: 'spawn-failed', detail: outcome.failure.message },
      }
    }

    return Option.isNone(outcome.success)
      ? {
          _tag: 'failed',
          failure: {
            _tag: 'timed-out',
            detail: `nsc ${argv.join(' ')} exceeded ${Duration.toSeconds(timeout)}s`,
          },
        }
      : { _tag: 'ran', run: outcome.success.value }
  })

/** Map a process failure onto the reason vocabulary the facts expose. */
const unavailableFromFailure = (
  failure: NscFailure,
): { readonly reason: 'nsc-missing' | 'timed-out' | 'command-failed'; readonly detail: string } => {
  switch (failure._tag) {
    case 'nsc-missing':
      return { reason: 'nsc-missing', detail: failure.detail }
    case 'timed-out':
      return { reason: 'timed-out', detail: failure.detail }
    case 'spawn-failed':
      return { reason: 'command-failed', detail: failure.detail }
  }
}

/** stderr that specifically says "`nsc` does not know this job". */
const isJobNotFoundStderr = ({ stderr, jobId }: { stderr: string; jobId: number }): boolean =>
  new RegExp(
    `(?:\\bjob\\s+#?${jobId}\\s+(?:not found|does not exist)\\b|\\b(?:no such|unknown)\\s+(?:github\\s+)?job\\s+#?${jobId}\\b)`,
    'i',
  ).test(stderr)

// =============================================================================
// The observation
// =============================================================================

/**
 * Observe the Namespace side of a GitHub job.
 *
 * Runs no subprocess at all unless GitHub already identified the runner as a
 * Namespace runner, and never fails: every problem is reported as a tagged
 * `unavailable` observation so the caller's GitHub facts survive intact.
 */
export const observeNamespaceJob = ({
  github,
  withUsage,
}: {
  readonly github: InspectGitHubFacts
  readonly withUsage: boolean
}): Effect.Effect<InspectNamespaceFacts, never, ChildProcessSpawner> =>
  Effect.gen(function* () {
    if (github.runnerKind !== 'namespace') {
      /** No Namespace runner, no `nsc` call: there is nothing for it to answer. */
      return { _tag: 'not-namespace-job', runnerKind: github.runnerKind }
    }

    const commands: Array<ReadonlyArray<string>> = []

    const checkLoginArgv = authCheckLoginArgv()
    commands.push(checkLoginArgv)
    const checkLogin = yield* runNsc({ argv: checkLoginArgv, timeout: CHECK_LOGIN_TIMEOUT })
    if (checkLogin._tag === 'failed') {
      const { reason, detail } = unavailableFromFailure(checkLogin.failure)
      return { _tag: 'unavailable', reason, detail, commands }
    }
    if (checkLogin.run.exitCode !== 0) {
      return {
        _tag: 'unavailable',
        reason: 'not-authenticated',
        detail:
          checkLogin.run.stderr.length > 0
            ? checkLogin.run.stderr
            : `nsc auth check-login exited with ${checkLogin.run.exitCode}`,
        commands,
      }
    }

    const describeArgv = jobDescribeArgv(github.jobId)
    commands.push(describeArgv)
    const describe = yield* runNsc({ argv: describeArgv, timeout: JOB_DESCRIBE_TIMEOUT })
    if (describe._tag === 'failed') {
      const { reason, detail } = unavailableFromFailure(describe.failure)
      return { _tag: 'unavailable', reason, detail, commands }
    }
    if (describe.run.exitCode !== 0) {
      return {
        _tag: 'unavailable',
        reason: isJobNotFoundStderr({ stderr: describe.run.stderr, jobId: github.jobId })
          ? 'job-not-found'
          : 'command-failed',
        detail:
          describe.run.stderr.length > 0
            ? describe.run.stderr
            : `nsc github job describe exited with ${describe.run.exitCode}`,
        commands,
      }
    }

    const parsed = parseJobDescribe(describe.run.stdout)
    if (parsed._tag === 'unrecognized') {
      return { _tag: 'unavailable', reason: 'unrecognized-output', detail: parsed.detail, commands }
    }

    const usage = yield* observeUsage({ github, job: parsed.job, withUsage, commands })
    return { _tag: 'reported', job: parsed.job, usage, commands }
  })

/** Sample the instance report for this job, or report why there is no sample. */
const observeUsage = ({
  github,
  job,
  withUsage,
  commands,
}: {
  readonly github: InspectGitHubFacts
  readonly job: NamespaceJobFacts
  readonly withUsage: boolean
  readonly commands: Array<ReadonlyArray<string>>
}): Effect.Effect<NamespaceUsageState, never, ChildProcessSpawner> =>
  Effect.gen(function* () {
    if (withUsage === false) return { _tag: 'not-requested' }

    const window = deriveReportWindow({
      startedAt: github.startedAt,
      completedAt: github.completedAt,
      now: new Date(),
    })
    if (window === null) {
      return {
        _tag: 'unavailable',
        reason: 'no-window',
        detail: 'GitHub reported no start time for this job, so no bounded report window exists.',
      }
    }

    const argv = instanceReportArgv({
      window,
      repository: github.repo,
      /** Namespace records the GitHub job name, which is this job's own name. */
      jobName: job.jobName ?? github.name,
    })
    commands.push(argv)
    const report = yield* runNsc({ argv, timeout: INSTANCE_REPORT_TIMEOUT })
    if (report._tag === 'failed') {
      const { reason, detail } = unavailableFromFailure(report.failure)
      return { _tag: 'unavailable', reason, detail }
    }
    if (report.run.exitCode !== 0) {
      return {
        _tag: 'unavailable',
        reason: 'command-failed',
        detail:
          report.run.stderr.length > 0
            ? report.run.stderr
            : `nsc instance report exited with ${report.run.exitCode}`,
      }
    }

    const parsed = parseInstanceReport(report.run.stdout)
    if (parsed._tag === 'unrecognized') {
      return { _tag: 'unavailable', reason: 'unrecognized-output', detail: parsed.detail }
    }

    const sample = selectUsageRow({
      rows: parsed.rows,
      jobId: github.jobId,
      instanceId: job.instanceId,
    })
    return sample === null
      ? {
          _tag: 'unavailable',
          reason: 'no-matching-row',
          detail: `No report row for job ${github.jobId} on instance ${job.instanceId}.`,
        }
      : { _tag: 'sampled', sample }
  })
