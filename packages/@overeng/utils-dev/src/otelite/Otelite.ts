import { NodeServices } from '@effect/platform-node'
import {
  Context,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Ref,
  Schedule,
  Schema,
  type Scope,
  Stream,
} from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

import {
  cliReasonForExitCode,
  OteliteChildFailed,
  OteliteCliError,
  OteliteDecodeError,
  OteliteSpawnError,
} from './errors.ts'
import {
  withOteliteExecSpan,
  withOteliteInspectSpan,
  withOteliteInspectSummarySpan,
  withOteliteLabelSpan,
} from './otel.ts'
import {
  EndpointsEvent,
  LogRow,
  LogSummary,
  MetricRow,
  MetricSummary,
  SpanRow,
  Summary,
  TraceSummary,
} from './schema.ts'

/** The three OTLP signals `inspect` understands. */
export type Signal = 'traces' | 'metrics' | 'logs'

/** Options for {@link Otelite.run}. */
export interface RunOptions {
  /** The child command to run under capture, e.g. `["node", "app.js"]`. */
  readonly command: ReadonlyArray<string>
  /** Capture out-dir; when omitted otelite mints a unique one (auto-cleaned on scope close). */
  readonly out?: string
  /** Sets `--service` (wins over the child's `OTEL_SERVICE_NAME`). */
  readonly service?: string
  /** Sets `--drain-idle <ms>` for fire-and-forget emitters. */
  readonly drainIdleMs?: number
  /** Force a fixed HTTP receiver port (`--http-port`); default ephemeral `:0`. */
  readonly httpPort?: number
  /** Force a fixed gRPC receiver port (`--grpc-port`); default ephemeral `:0`. */
  readonly grpcPort?: number
}

/** Options for {@link Otelite.capture}. */
export interface CaptureOptions {
  /** Capture out-dir; when omitted otelite mints a unique one (auto-cleaned on scope close). */
  readonly out?: string
  /** Force a fixed HTTP receiver port (`--http-port`); default ephemeral `:0`. */
  readonly httpPort?: number
  /** Force a fixed gRPC receiver port (`--grpc-port`); default ephemeral `:0`. */
  readonly grpcPort?: number
}

/** Filters/signal for {@link CaptureHandle.inspect} — `src` is pinned to the out-dir. */
interface CaptureInspectBase {
  /** Exact-match `--service` filter (rows only). */
  readonly service?: string
  /** Exact-match `--name` filter (rows only). */
  readonly name?: string
  /** Exact-match `--attr k=v` filters (rows only). */
  readonly attrs?: Readonly<Record<string, string>>
}

/**
 * A live capture handle yielded by {@link Otelite.capture} as a scoped resource.
 * The receiver is serving while the handle is open; closing the scope stops it
 * (stdin EOF), drains in-flight exports, and resolves {@link CaptureHandle.summary}.
 */
export interface CaptureHandle {
  /** The ephemeral receiver endpoints (base URLs), from the `otelite.endpoints/v1` event. */
  readonly endpoints: { readonly http: string; readonly grpc: string }
  /** The capture out-dir (otelite-minted or the caller's `out`). */
  readonly outDir: string
  /**
   * Inspect the LIVE capture, `src` pinned to {@link CaptureHandle.outDir}.
   * Same typed overloads as {@link Otelite.inspect}. Row reads short-poll-retry
   * on a transient 0-row result (see capture's bounded-retry note).
   */
  readonly inspect: {
    <S extends Signal>(
      options: CaptureInspectBase & { readonly signal: S; readonly summary: true },
    ): Effect.Effect<InspectSummary<S>, OteliteSpawnError | OteliteCliError | OteliteDecodeError>
    <S extends Signal>(
      options: CaptureInspectBase & { readonly signal: S; readonly summary?: false },
    ): Effect.Effect<
      ReadonlyArray<InspectRow<S>>,
      OteliteSpawnError | OteliteCliError | OteliteDecodeError
    >
  }
  /**
   * The drained `otelite.summary/v1`, available only after the scope closes
   * (the receiver stopped). Awaiting it before release blocks until stop.
   */
  readonly summary: Effect.Effect<Summary, OteliteDecodeError>
}

/** Options shared by all {@link Otelite.inspect} overloads. */
interface InspectBase {
  /** Capture source: a dir, a single `*.ndjson` file, or `-` for stdin. */
  readonly src: string
  /** Exact-match `--service` filter (rows only). */
  readonly service?: string
  /** Exact-match `--name` filter (rows only). */
  readonly name?: string
  /** Exact-match `--attr k=v` filters (rows only). */
  readonly attrs?: Readonly<Record<string, string>>
}

/** The decoded result of `inspect <src> --summary`, keyed by signal. */
type InspectSummary<S extends Signal> = S extends 'traces'
  ? TraceSummary
  : S extends 'metrics'
    ? MetricSummary
    : LogSummary

/** The decoded flat-row result of `inspect <src>`, keyed by signal. */
type InspectRow<S extends Signal> = S extends 'traces'
  ? SpanRow
  : S extends 'metrics'
    ? MetricRow
    : LogRow

const decodeSummary = Schema.decodeUnknownEffect(Schema.fromJsonString(Summary))
const decodeEndpointsEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(EndpointsEvent))

const rowSchema = { traces: SpanRow, metrics: MetricRow, logs: LogRow } as const
const rowKind = { traces: 'span', metrics: 'metric', logs: 'log' } as const
const summarySchema = { traces: TraceSummary, metrics: MetricSummary, logs: LogSummary } as const
const summaryKind = {
  traces: 'trace-summary',
  metrics: 'metric-summary',
  logs: 'log-summary',
} as const

type AnySummary = TraceSummary | MetricSummary | LogSummary
type AnyRow = SpanRow | MetricRow | LogRow

/**
 * The otelite wrapper service shape exposed by {@link Otelite}.
 */
export interface OteliteService {
  /**
   * Run a child command under capture (`otelite run [flags] -- <command>`),
   * returning the decoded `otelite.summary/v1`. Requires a `Scope`: when
   * otelite mints the out-dir, it is removed when that scope closes.
   */
  readonly run: (
    options: RunOptions,
  ) => Effect.Effect<
    Summary,
    OteliteSpawnError | OteliteCliError | OteliteDecodeError | OteliteChildFailed,
    Scope.Scope
  >
  /**
   * A scoped, receiver-only capture (`otelite capture`). Yields a
   * {@link CaptureHandle}; the handle's scope IS the capture's lifetime.
   */
  readonly capture: (
    options?: CaptureOptions,
  ) => Effect.Effect<
    CaptureHandle,
    OteliteSpawnError | OteliteCliError | OteliteDecodeError,
    Scope.Scope
  >
  /**
   * Inspect a capture. Without `summary`, decodes the NDJSON flat rows into
   * typed arrays; with `summary: true`, decodes the single report object.
   */
  readonly inspect: {
    <S extends Signal>(
      options: InspectBase & { readonly signal: S; readonly summary: true },
    ): Effect.Effect<InspectSummary<S>, OteliteSpawnError | OteliteCliError | OteliteDecodeError>
    <S extends Signal>(
      options: InspectBase & { readonly signal: S; readonly summary?: false },
    ): Effect.Effect<
      ReadonlyArray<InspectRow<S>>,
      OteliteSpawnError | OteliteCliError | OteliteDecodeError
    >
  }
  /** otelite's own version string (`otelite --version`). */
  readonly version: Effect.Effect<string, OteliteSpawnError | OteliteCliError>
}

/**
 * Effect-native wrapper around the `otelite` CLI. Shells out via the Effect
 * `ChildProcessSpawner` (never `node:child_process`), decodes the CLI's JSON
 * contract with `Schema`, and surfaces otelite's `sysexits.h` taxonomy as
 * tagged errors. The CLI's JSON output is the single source of truth — this
 * service never reimplements capture/inspect logic.
 *
 * The `otelite` binary is named ONLY by `OTELITE_BIN` — there is no ambient
 * `PATH` fallback, so a test target that forgot to declare the tool fails
 * loudly instead of silently resolving some other binary. Under Buck the test
 * target declares `tools = { OTELITE_BIN: ... }`; raw-shell runs set
 * `OTELITE_BIN="$(nix build --no-link --print-out-paths .#otelite)/bin/otelite"`.
 */
export class Otelite extends Context.Service<Otelite, OteliteService>()(
  '@overeng/utils-dev/otelite/Otelite',
  {
    make: Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const fs = yield* FileSystem.FileSystem

      const binary = process.env['OTELITE_BIN']
      if (binary === undefined || binary === '') {
        return yield* Effect.die(new Error('declared test tool is unavailable: OTELITE_BIN'))
      }

      /**
       * Run otelite and collect its stdout + exit code. Spawn failures become
       * {@link OteliteSpawnError}; the caller decides how to interpret the exit.
       */
      const exec = (args: ReadonlyArray<string>) =>
        Effect.scoped(
          Effect.gen(function* () {
            const process = yield* spawner.spawn(
              ChildProcess.make(binary, [...args], { stdout: 'pipe', stderr: 'pipe' }),
            )
            const collect = (stream: typeof process.stdout) =>
              Stream.runCollect(Stream.decodeText(stream)).pipe(
                Effect.map((chunks) => Array.from(chunks).join('')),
              )
            const [exitCode, stdout, stderr] = yield* Effect.all(
              [process.exitCode, collect(process.stdout), collect(process.stderr)],
              { concurrency: 'unbounded' },
            )
            return { exitCode, stdout, stderr }
          }),
        ).pipe(
          Effect.mapError((cause) => new OteliteSpawnError({ argv: [binary, ...args], cause })),
          withOteliteExecSpan(args),
        )

      /**
       * Run a child command under capture (`otelite run [flags] -- <command>`),
       * returning the decoded `otelite.summary/v1`.
       *
       * Scoped: when otelite mints the out-dir (no `out` given), it is removed on
       * scope close so concurrent test runs leave no residue.
       *
       * A non-zero child surfaces as {@link OteliteChildFailed} (the summary is
       * still available on the error's capture path); otelite's own `sysexits.h`
       * failures (empty stdout) surface as {@link OteliteCliError}.
       */
      const run = (options: RunOptions) =>
        Effect.gen(function* () {
          const flags: Array<string> = ['run']
          if (options.out !== undefined) flags.push('--out', options.out)
          if (options.service !== undefined) flags.push('--service', options.service)
          if (options.drainIdleMs !== undefined)
            flags.push('--drain-idle', String(options.drainIdleMs))
          if (options.httpPort !== undefined) flags.push('--http-port', String(options.httpPort))
          if (options.grpcPort !== undefined) flags.push('--grpc-port', String(options.grpcPort))
          const args = [...flags, '--', ...options.command]

          const { exitCode, stdout, stderr } = yield* exec(args)

          // Empty stdout + non-zero exit ⇒ otelite's own sysexits failure.
          if (stdout.trim() === '' && exitCode !== 0) {
            return yield* new OteliteCliError({
              exitCode,
              reason: cliReasonForExitCode(exitCode),
              argv: [binary, ...args],
              stderr,
            })
          }

          const summary = yield* decodeSummary(stdout).pipe(
            Effect.mapError(
              (cause) => new OteliteDecodeError({ kind: 'summary', raw: stdout, cause }),
            ),
          )

          // Clean up an otelite-minted out-dir when the caller's scope closes.
          if (options.out === undefined) {
            yield* Effect.addFinalizer(() =>
              fs.remove(summary.out, { recursive: true }).pipe(Effect.ignore),
            )
          }

          // Non-zero child: summary was emitted, but the child failed.
          if (exitCode !== 0) {
            return yield* new OteliteChildFailed({
              exitCode,
              argv: options.command,
              stderr,
            })
          }

          return summary
        }).pipe(withOteliteLabelSpan('otelite.run'))

      const runCli = <A, E>(
        args: ReadonlyArray<string>,
        decode: (stdout: string) => Effect.Effect<A, E>,
      ): Effect.Effect<A, OteliteSpawnError | OteliteCliError | E> =>
        Effect.gen(function* () {
          const { exitCode, stdout, stderr } = yield* exec(args)
          if (exitCode !== 0) {
            return yield* new OteliteCliError({
              exitCode,
              reason: cliReasonForExitCode(exitCode),
              argv: [binary, ...args],
              stderr,
            })
          }
          return yield* decode(stdout)
        })

      // oxlint-disable-next-line unicorn/consistent-function-scoping -- co-located with the inspect methods + runCli/exec it serves in the service factory
      const inspectArgs = (signal: Signal, base: InspectBase, summary: boolean) => {
        const args: Array<string> = ['inspect', base.src, '--signal', signal]
        if (base.service !== undefined) args.push('--service', base.service)
        if (base.name !== undefined) args.push('--name', base.name)
        for (const [k, v] of Object.entries(base.attrs ?? {})) args.push('--attr', `${k}=${v}`)
        if (summary === true) args.push('--summary')
        return args
      }

      /**
       * Inspect a capture. Without `summary`, decodes the NDJSON flat rows
       * (`otelite.span/v1` / `otelite.metric/v1` / `otelite.log/v1`) into typed
       * arrays. With `summary: true`, decodes the single report object for the
       * signal. Filters (`service`/`name`/`attrs`) narrow flat rows only.
       */
      function inspect<S extends Signal>(
        options: InspectBase & { readonly signal: S; readonly summary: true },
      ): Effect.Effect<InspectSummary<S>, OteliteSpawnError | OteliteCliError | OteliteDecodeError>
      function inspect<S extends Signal>(
        options: InspectBase & { readonly signal: S; readonly summary?: false },
      ): Effect.Effect<
        ReadonlyArray<InspectRow<S>>,
        OteliteSpawnError | OteliteCliError | OteliteDecodeError
      >
      function inspect(
        options: InspectBase & { readonly signal: Signal; readonly summary?: boolean },
      ): Effect.Effect<unknown, OteliteSpawnError | OteliteCliError | OteliteDecodeError> {
        const { signal, summary = false, ...base } = options
        const args = inspectArgs(signal, base, summary)
        if (summary === true) {
          const schema: Schema.ConstraintDecoder<AnySummary> = summarySchema[signal]
          const kind = summaryKind[signal]
          return runCli(args, (stdout) =>
            Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(stdout).pipe(
              Effect.mapError((cause) => new OteliteDecodeError({ kind, raw: stdout, cause })),
            ),
          ).pipe(withOteliteInspectSummarySpan(signal))
        }
        const schema: Schema.ConstraintDecoder<AnyRow> = rowSchema[signal]
        const kind = rowKind[signal]
        const decodeRow = Schema.decodeUnknownEffect(Schema.fromJsonString(schema))
        return runCli(args, (stdout) =>
          Effect.forEach(
            stdout.split('\n').filter((line) => line.trim() !== ''),
            (line) =>
              decodeRow(line).pipe(
                Effect.mapError((cause) => new OteliteDecodeError({ kind, raw: line, cause })),
              ),
          ),
        ).pipe(withOteliteInspectSpan(signal))
      }

      /**
       * Bounded short-poll retry for a LIVE row read that returns 0 rows.
       *
       * Why: the handle's `inspect` reads a capture the receiver is still serving.
       * The sink writes each export with a raw `write_all` to the file *before*
       * acking (no `BufWriter`), so a captured span is durable in the file the
       * instant the POST returns. But an independent reader process started right
       * after can still transiently observe 0 rows. Under host contention that
       * window includes exporter scheduling and the OTLP POST round-trip, not only
       * filesystem visibility after `write_all`. Poll the observable condition for
       * a bounded 500 ms instead of assuming the producer finishes within a fixed
       * sleep. A non-empty capture returns on its first visible row; a genuinely
       * empty live capture pays the bounded budget exactly once.
       */
      const liveRowRetry = Schedule.recurs(20).pipe(
        Schedule.addDelay(() => Effect.succeed('25 millis' as const)),
      )

      /**
       * A scoped, receiver-only capture (`otelite capture`). Yields a
       * {@link CaptureHandle} for a harness that owns the system-under-test
       * lifecycle itself (vs {@link run}, which spawns the SUT). The handle's scope
       * IS the capture's lifetime: on scope close we stop the receiver by closing
       * the child's stdin (EOF — no signal/PID plumbing), await its exit, and
       * decode the final `otelite.summary/v1` line.
       *
       * stdout is a tagged event stream (`otelite.endpoints/v1` first,
       * `otelite.summary/v1` last). We dispatch by `schema` via `Schema` decode —
       * never string-scrape. A background fiber drains the WHOLE stdout stream
       * (otelite panics on a broken stdout pipe, so we must never close it early);
       * the first line resolves the readiness `Deferred`, the last line is the
       * summary.
       */
      const capture = (
        options: CaptureOptions = {},
      ): Effect.Effect<
        CaptureHandle,
        OteliteSpawnError | OteliteCliError | OteliteDecodeError,
        Scope.Scope
      > =>
        Effect.gen(function* () {
          const flags: Array<string> = ['capture']
          if (options.out !== undefined) flags.push('--out', options.out)
          if (options.httpPort !== undefined) flags.push('--http-port', String(options.httpPort))
          if (options.grpcPort !== undefined) flags.push('--grpc-port', String(options.grpcPort))

          // Stop signal: a stdin Stream that emits nothing and completes when this
          // resolves. The Node executor pumps the stream into the child's stdin and
          // calls `writable.end()` on completion → the child sees EOF and stops.
          const stop = yield* Deferred.make<void>()
          const stdinStream = Stream.fromEffect(Deferred.await(stop)).pipe(Stream.drain)

          const command = ChildProcess.make(binary, [...flags], {
            stdin: stdinStream,
            stdout: 'pipe',
          })

          const process = yield* spawner
            .spawn(command)
            .pipe(
              Effect.mapError(
                (cause) => new OteliteSpawnError({ argv: [binary, ...flags], cause }),
              ),
            )

          const ready = yield* Deferred.make<EndpointsEvent, OteliteDecodeError>()
          const lastLine = yield* Ref.make<string | undefined>(undefined)
          const seenFirst = yield* Ref.make(false)

          // Drain the entire tagged event stream; resolve `ready` on the first line
          // (decoded as `otelite.endpoints/v1`), keep the latest line for the summary.
          const drain = yield* process.stdout.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.filter((line) => line.trim() !== ''),
            Stream.tap((line) =>
              Effect.gen(function* () {
                yield* Ref.set(lastLine, line)
                const wasFirst = yield* Ref.getAndSet(seenFirst, true)
                if (wasFirst === false) {
                  yield* decodeEndpointsEvent(line).pipe(
                    Effect.matchEffect({
                      onSuccess: (event) => Deferred.succeed(ready, event),
                      onFailure: (cause) =>
                        Deferred.fail(
                          ready,
                          new OteliteDecodeError({ kind: 'summary', raw: line, cause }),
                        ),
                    }),
                  )
                }
              }),
            ),
            Stream.runDrain,
            Effect.forkScoped,
          )

          // Bounded readiness wait: a healthy `capture` emits the endpoints line the
          // instant both listeners bind. If the process dies before that, await the
          // drain failure / exit instead of hanging on the Deferred.
          const endpoints = yield* Deferred.await(ready).pipe(
            Effect.race(
              Fiber.join(drain).pipe(
                Effect.matchEffect({
                  onFailure: () => process.exitCode.pipe(Effect.orElseSucceed(() => 74)),
                  onSuccess: () => process.exitCode.pipe(Effect.orElseSucceed(() => 0)),
                }),
                Effect.flatMap(
                  (exitCode) =>
                    new OteliteCliError({
                      exitCode,
                      reason: cliReasonForExitCode(exitCode),
                      argv: [binary, ...flags],
                    }),
                ),
              ),
            ),
            Effect.timeout('10 seconds'),
            Effect.catchTag('TimeoutError', () =>
              Effect.fail(
                new OteliteCliError({
                  exitCode: 74,
                  reason: 'io-err',
                  argv: [binary, ...flags],
                  stderr: 'otelite capture did not emit endpoints within the readiness bound',
                }),
              ),
            ),
          )

          // Stop + drain on scope close: close stdin (EOF), await the stdout drain
          // and the process exit, then decode the final line as the summary. Made
          // idempotent + interrupt-safe so an interrupted scope still tears the
          // child down (no leaked `otelite capture`).
          const summaryDeferred = yield* Deferred.make<Summary, OteliteDecodeError>()
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              yield* Deferred.succeed(stop, undefined)
              // Await the drained stdout, but never hang teardown: if the child is
              // wedged, fall back to a kill so the scope always closes.
              yield* Fiber.join(drain).pipe(
                Effect.andThen(process.exitCode),
                Effect.timeout('10 seconds'),
                Effect.catch(() => process.kill().pipe(Effect.ignore)),
              )
              const line = yield* Ref.get(lastLine)
              yield* decodeSummary(line ?? '').pipe(
                Effect.matchEffect({
                  onSuccess: (summary) => Deferred.succeed(summaryDeferred, summary),
                  onFailure: (cause) =>
                    Deferred.fail(
                      summaryDeferred,
                      new OteliteDecodeError({ kind: 'summary', raw: line ?? '', cause }),
                    ),
                }),
              )
              // Clean up an otelite-minted out-dir on scope close.
              if (options.out === undefined) {
                yield* fs.remove(endpoints.out, { recursive: true }).pipe(Effect.ignore)
              }
            }).pipe(Effect.uninterruptible),
          )

          const handleInspect = ((
            inspectOptions: CaptureInspectBase & {
              readonly signal: Signal
              readonly summary?: boolean
            },
          ) => {
            const pinned = { ...inspectOptions, src: endpoints.out }
            if (inspectOptions.summary === true) {
              return inspect(pinned as never)
            }
            // Live row read: bounded short-poll retry on a transient 0-row result.
            const readRows = inspect(pinned as never) as unknown as Effect.Effect<
              ReadonlyArray<unknown>,
              OteliteSpawnError | OteliteCliError | OteliteDecodeError
            >
            return readRows.pipe(
              Effect.flatMap((rows) =>
                rows.length === 0 ? Effect.fail('empty' as const) : Effect.succeed(rows),
              ),
              Effect.retry({ schedule: liveRowRetry, while: (e) => e === 'empty' }),
              Effect.catchIf(
                (e): e is 'empty' => e === 'empty',
                () => readRows,
              ),
            )
          }) as CaptureHandle['inspect']

          return {
            endpoints: { http: endpoints.http, grpc: endpoints.grpc },
            outDir: endpoints.out,
            inspect: handleInspect,
            summary: Deferred.await(summaryDeferred),
          } satisfies CaptureHandle
        }).pipe(withOteliteLabelSpan('otelite.capture'))

      /** otelite's own version string (`otelite --version`). */
      const version = Effect.suspend(() =>
        runCli(['--version'], (stdout) => Effect.succeed(stdout.trim())),
      ).pipe(withOteliteLabelSpan('otelite.version'))

      return { run, capture, inspect, version } satisfies OteliteService
    }),
  },
) {
  /** Provides {@link Otelite}, wiring its platform dependencies (spawner, filesystem). */
  static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(NodeServices.layer))
}
