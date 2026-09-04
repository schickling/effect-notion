/// <reference lib="dom" />

/**
 * BroadcastChannel-based logger for bridging logs from SharedWorkers to tabs.
 *
 * SharedWorkers run in a headless context without access to DevTools.
 * This module provides a way to broadcast logs from a SharedWorker to
 * connected tabs where they can be displayed in the console.
 *
 * Architecture:
 * ```
 * ┌──────────────────┐     BroadcastChannel      ┌─────────────┐
 * │  SharedWorker    │ ───────────────────────▶  │   Tab       │
 * │  (source)        │    'effect-debug-logs'    │  (viewer)   │
 * │                  │                           │             │
 * │  Effect.log(...) │                           │  console/UI │
 * └──────────────────┘                           └─────────────┘
 * ```
 *
 * @example
 * ```ts
 * // ═══════════════════════════════════════════════════════════════════════════
 * // SharedWorker side (sync-worker.ts)
 * // ═══════════════════════════════════════════════════════════════════════════
 * import { Effect } from 'effect'
 * import { BroadcastLoggerLive } from '@overeng/utils/browser'
 *
 * const workerProgram = Effect.gen(function* () {
 *   yield* Effect.log('Sync worker initialized')
 *   yield* Effect.logDebug('Connecting to database...')
 *
 *   yield* Effect.gen(function* () {
 *     yield* Effect.log('Syncing records')
 *   })
 *
 *   yield* Effect.logError('Connection failed', { retries: 3 })
 * }).pipe(
 *   // All Effect.log calls broadcast to connected tabs
 *   Effect.provide(BroadcastLoggerLive('sync-worker'))
 * )
 *
 * // ═══════════════════════════════════════════════════════════════════════════
 * // Tab side (main.ts) - Option 1: Effect-native bridge (recommended)
 * // ═══════════════════════════════════════════════════════════════════════════
 * import { Effect } from 'effect'
 * import { makeLogBridgeLive } from '@overeng/utils/browser'
 *
 * const app = Effect.gen(function* () {
 *   yield* Effect.log('App started')
 *   // Worker logs appear through Effect's logger with annotations
 * }).pipe(
 *   Effect.provide(makeLogBridgeLive()),
 *   Effect.scoped,
 * )
 *
 * // ═══════════════════════════════════════════════════════════════════════════
 * // Tab side - Option 2: Stream-based processing
 * // ═══════════════════════════════════════════════════════════════════════════
 * import { Effect, Stream } from 'effect'
 * import { logStream, formatLogEntry } from '@overeng/utils/browser'
 *
 * const logViewer = logStream.pipe(
 *   Stream.filter((entry) => entry.source === 'sync-worker'),
 *   Stream.runForEach((entry) =>
 *     Effect.sync(() => console.log(formatLogEntry(entry)))
 *   ),
 * )
 * ```
 *
 * @module
 */
import {
  Cause,
  Effect,
  Layer,
  Logger,
  type LogLevel,
  Option,
  References,
  Schema,
  type Scope,
  Stream,
} from 'effect'

import {
  OtelAttr,
  OtelOperation,
  type OtelAttrEncodeError,
  type OtelOperationDefinition,
} from '@overeng/otel-contract'

/** Channel name for broadcasting logs */
export const BROADCAST_CHANNEL_NAME = 'effect-debug-logs'

const BroadcastLoggerLogStreamSetupOperation = OtelOperation.define({
  name: 'BroadcastLogger.logStream.setup',
  schema: Schema.Struct({
    label: OtelAttr.drop(Schema.NonEmptyString),
  }),
  label: ({ label }) => label,
})

const trustOtelContract = <A, E, R>(
  effect: Effect.Effect<A, E | OtelAttrEncodeError, R>,
): Effect.Effect<A, E, R> =>
  effect.pipe(Effect.catchTag('OtelAttrEncodeError', (error) => Effect.die(error)))

const trustedWith =
  <S extends Schema.Codec<any>>({
    operation,
    attributes,
  }: {
    operation: OtelOperationDefinition<S>
    attributes: Schema.Schema.Type<S>
  }) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    trustOtelContract<A, E, R>(operation.with({ attributes, effect }))

const sanitizeForBroadcast = (value: unknown): unknown => {
  if (value === null || value === undefined) return value

  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'function')
    return `[Function${value.name !== undefined && value.name !== '' ? `: ${value.name}` : ''}]`
  if (typeof value === 'symbol') return value.toString()
  if (typeof value !== 'object') return value

  if (value instanceof Error) {
    return {
      _tag: 'Error',
      name: value.name,
      message: value.message,
      stack: value.stack,
    }
  }

  const sc = globalThis.structuredClone
  if (typeof sc === 'function') {
    try {
      return sc(value)
    } catch {
      // ignore
    }
  }

  try {
    return String(value)
  } catch {
    return '[Unserializable]'
  }
}

/** Schema for log entries broadcast over BroadcastChannel */
export class BroadcastLogEntry extends Schema.Class<BroadcastLogEntry>('BroadcastLogEntry')({
  _tag: Schema.Literal('BroadcastLogEntry'),
  timestamp: Schema.Finite,
  level: Schema.String,
  message: Schema.Array(Schema.Unknown),
  fiberId: Schema.String,
  spans: Schema.Array(Schema.String),
  annotations: Schema.Record(Schema.String, Schema.Unknown),
  cause: Schema.UndefinedOr(Schema.String),
  /** Identifies the source (e.g., SharedWorker name or tab ID) */
  source: Schema.UndefinedOr(Schema.String),
}) {}

const encodeBroadcastLogEntry = Schema.encodeSync(BroadcastLogEntry)
const decodeBroadcastLogEntry = Schema.decodeUnknownOption(BroadcastLogEntry)

interface MakeBroadcastLoggerFromChannelOptions {
  readonly channel: BroadcastChannel
  readonly source?: string | undefined
}

const makeBroadcastLoggerFromChannel = ({
  channel,
  source,
}: MakeBroadcastLoggerFromChannelOptions) =>
  Logger.make<unknown, void>(({ cause, date, fiber, logLevel, message }) => {
    const entry = new BroadcastLogEntry({
      _tag: 'BroadcastLogEntry',
      timestamp: date.getTime(),
      // v4 `LogLevel` is a plain string union (e.g. `'Error'`, no `.label`); normalize
      // to the established uppercase wire labels (`ERROR`, `WARN`, …) so existing
      // consumers filtering on them keep working across versions.
      level: logLevel.toUpperCase(),
      message: (Array.isArray(message) === true ? message : [message]).map(sanitizeForBroadcast),
      fiberId: String(fiber.id),
      spans: fiber
        .getRef(References.CurrentLogSpans)
        .map(([label]) => label)
        .toReversed(),
      annotations: Object.fromEntries(
        Object.entries(fiber.getRef(References.CurrentLogAnnotations)).map(([k, v]) => [
          k,
          sanitizeForBroadcast(v),
        ]),
      ),
      cause:
        Cause.hasFails(cause) === false &&
        Cause.hasDies(cause) === false &&
        Cause.hasInterrupts(cause) === false
          ? undefined
          : Cause.pretty(cause),
      source,
    })

    // BroadcastChannel.postMessage doesn't need targetOrigin (unlike window.postMessage)
    // oxlint-disable-next-line eslint-plugin-unicorn(require-post-message-target-origin)
    channel.postMessage(encodeBroadcastLogEntry(entry))
  })

/**
 * Creates a Logger that broadcasts log entries over a BroadcastChannel.
 *
 * Use this in a SharedWorker to send logs to connected tabs.
 */
export const makeBroadcastLogger = (source?: string) => {
  const channel = new BroadcastChannel(BROADCAST_CHANNEL_NAME)

  return makeBroadcastLoggerFromChannel({ channel, source })
}

/**
 * Layer that replaces the default logger with a broadcast logger.
 *
 * @param source - Optional identifier for the log source (e.g., worker name)
 */
export const BroadcastLoggerLive = (source?: string) =>
  Layer.unwrap(
    Effect.map(
      Effect.acquireRelease(
        Effect.sync(() => new BroadcastChannel(BROADCAST_CHANNEL_NAME)),
        (channel) => Effect.sync(() => channel.close()),
      ),
      (channel) =>
        Logger.layer([makeBroadcastLoggerFromChannel({ channel, source })], {
          mergeWithExisting: false,
        }),
    ),
  )

/**
 * Stream of broadcast log entries from all sources.
 *
 * Use this in a tab/window to receive logs from SharedWorkers.
 *
 * @example
 * ```ts
 * // Filter and process logs
 * yield* logStream.pipe(
 *   Stream.filter((entry) => entry.level === 'ERROR'),
 *   Stream.runForEach((entry) =>
 *     Effect.log('Worker error', { source: entry.source, message: entry.message })
 *   ),
 * )
 *
 * // Or filter by source
 * yield* logStream.pipe(
 *   Stream.filter((entry) => entry.source === 'my-worker'),
 *   Stream.runForEach((entry) => Effect.sync(() => console.log(formatLogEntry(entry)))),
 * )
 * ```
 */
export const logStream: Stream.Stream<BroadcastLogEntry, never, Scope.Scope> = Stream.scoped(
  Stream.unwrap(
    trustedWith({
      operation: BroadcastLoggerLogStreamSetupOperation,
      attributes: { label: 'setup' },
    })(
      Effect.gen(function* () {
        const channel = yield* Effect.acquireRelease(
          Effect.sync(() => new BroadcastChannel(BROADCAST_CHANNEL_NAME)),
          (channel) => Effect.sync(() => channel.close()),
        )

        return Stream.fromEventListener<MessageEvent<unknown>>(channel, 'message').pipe(
          Stream.map((event) => decodeBroadcastLogEntry(event.data)),
          Stream.filter(Option.isSome),
          Stream.map((option) => option.value),
        )
      }),
    ),
  ),
)

/** Options for creating a log bridge layer. */
export interface LogBridgeOptions {
  /** Only bridge logs from these sources. If empty/undefined, bridges all sources. */
  readonly sources?: readonly string[]
}

/**
 * Creates a Layer that bridges broadcast logs to Effect's logger.
 *
 * Listens for broadcast log entries and re-emits them through Effect.log
 * with appropriate log level, preserving source information as annotations.
 *
 * @example
 * ```ts
 * // Bridge all worker logs
 * const program = myApp.pipe(
 *   Effect.provide(makeLogBridgeLive()),
 *   Effect.scoped,
 * )
 *
 * // Bridge only specific workers
 * const program = myApp.pipe(
 *   Effect.provide(makeLogBridgeLive({ sources: ['sync-worker', 'db-worker'] })),
 *   Effect.scoped,
 * )
 * ```
 *
 * Example log output (with default Effect logger):
 * ```
 * timestamp=2024-01-15T10:30:45.123Z level=INFO fiber=#0 message="Sync worker initialized" broadcastSource=sync-worker broadcastFiberId=#5
 * timestamp=2024-01-15T10:30:45.456Z level=DEBUG fiber=#0 message="Connecting to database..." broadcastSource=sync-worker broadcastFiberId=#5
 * timestamp=2024-01-15T10:30:45.789Z level=INFO fiber=#0 message="Syncing records" broadcastSource=sync-worker broadcastFiberId=#5 broadcastSpans="sync-operation"
 * ```
 */
export const makeLogBridgeLive = (options?: LogBridgeOptions): Layer.Layer<never> =>
  Layer.effectDiscard(
    logStream.pipe(
      Stream.filter((entry) => {
        if (options?.sources !== undefined && options.sources.length > 0) {
          return entry.source !== undefined && options.sources.includes(entry.source) === true
        }
        return true
      }),
      Stream.runForEach((entry) => {
        const msg = entry.message.join(' ')

        // Wire levels are uppercase labels (see `BroadcastLogEntry`); narrow them to
        // a `Severity` for `logWithLevel`.
        const severity =
          LogLevelSeverity[entry.level.toUpperCase() as keyof typeof LogLevelSeverity] ?? 'Info'

        return Effect.logWithLevel(severity)(msg).pipe(
          Effect.annotateLogs({
            broadcastSource: entry.source ?? 'unknown',
            broadcastFiberId: entry.fiberId,
            ...(entry.spans.length > 0 ? { broadcastSpans: entry.spans.join(' > ') } : {}),
            ...entry.annotations,
            ...(entry.cause !== undefined ? { broadcastCause: entry.cause } : {}),
          }),
        )
      }),
      Effect.scoped,
    ),
  )

/**
 * Broadcast levels are uppercase wire labels (see `BroadcastLogEntry`); map them onto
 * the `Severity` subset accepted by `logWithLevel`.
 */
const LogLevelSeverity = {
  FATAL: 'Fatal',
  ERROR: 'Error',
  WARN: 'Warn',
  INFO: 'Info',
  DEBUG: 'Debug',
  TRACE: 'Trace',
} as const satisfies Record<string, LogLevel.Severity>

/**
 * Formats a log entry for display.
 *
 * @example
 * ```ts
 * const formatted = formatLogEntry(entry)
 * // "[my-worker] 14:23:45.123 INFO (fiber-0) my-span: Hello world"
 * ```
 */
export const formatLogEntry = (entry: BroadcastLogEntry): string => {
  const date = new Date(entry.timestamp)
  const time = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}.${date.getMilliseconds().toString().padStart(3, '0')}`

  const source = entry.source !== undefined ? `[${entry.source}] ` : ''
  const spans = entry.spans.length > 0 ? ` ${entry.spans.join(' > ')}:` : ''
  const msg = entry.message.join(' ')

  return `${source}${time} ${entry.level} (${entry.fiberId})${spans} ${msg}`
}
