import * as fs from 'node:fs'
import path from 'node:path'
import util from 'node:util'

import { NodeFileSystem } from '@effect/platform-node'
import {
  Cause,
  Effect,
  Inspectable,
  Layer,
  Logger,
  References,
  Redactable,
  type LogLevel,
} from 'effect'
import * as EffectArray from 'effect/Array'

/**
 * Creates a Layer that replaces the default logger with a pretty-printed file logger.
 *
 * The logger writes human-readable, optionally colorized output to the specified file.
 * It automatically creates parent directories and manages file handle lifecycle via Effect's
 * scope (closes on scope finalization).
 *
 * Output format per log entry:
 * ```
 * [HH:MM:SS.mmm threadName] LEVEL (fiber-id) span1 (123ms) span2 (45ms): Message
 *   Additional structured data indented
 *   key: value (for annotations)
 * ```
 *
 * @example
 * ```ts
 * import { Effect } from 'effect'
 * import { makeFileLogger } from '@overeng/utils/node'
 *
 * const program = Effect.gen(function* () {
 *   yield* Effect.log('Hello from file logger')
 *   yield* Effect.logDebug('Debug info', { userId: 123 })
 * }).pipe(
 *   Effect.provide(makeFileLogger({ logFilePath: '/tmp/app.log', threadName: 'main' }))
 * )
 * ```
 */
export interface MakeFileLoggerOptions {
  /** Absolute or relative path to the log file. Parent directories are created if needed. */
  readonly logFilePath: string
  /** Label shown in log output to identify the source (e.g., 'main', 'worker-1') */
  readonly threadName?: string
  /** Whether to include ANSI color codes. Defaults to false (plain text). */
  readonly colors?: boolean
}

/** Creates a Layer that replaces the default logger with a pretty-printed file logger */
export const makeFileLogger = ({ logFilePath, threadName, colors }: MakeFileLoggerOptions) =>
  Logger.layer([
    Effect.gen(function* () {
      // `Logger.toFile` opens via the platform `FileSystem` service and does not
      // create parent directories; keep the previous create-on-demand behavior.
      yield* Effect.sync(() => fs.mkdirSync(path.dirname(logFilePath), { recursive: true }))

      const pretty = prettyLoggerTty({
        colors: colors ?? false,
        stderr: false,
        formatDate: (date) => `${defaultDateFormat(date)} ${threadName ?? ''}`,
      })
      // `Logger.toFile` joins batched entries with "\n" plus a trailing "\n",
      // while `prettyLoggerTty` already terminates every entry with "\n". Trim
      // the trailing newline per entry so the on-disk bytes stay identical to
      // the previous write-per-entry sink.
      const entry = Logger.make<unknown, string>((options) => {
        const out = pretty.log(options)
        return out.endsWith('\n') === true ? out.slice(0, -1) : out
      })

      return yield* Logger.toFile(entry, logFilePath, { flag: 'a', mode: 0o666 })
    }),
  ]).pipe(Layer.provide(NodeFileSystem.layer))

const withColor = (text: string, ...colors: readonly string[]) => {
  let out = ''
  for (let i = 0; i < colors.length; i++) {
    out += `\x1b[${colors[i]}m`
  }
  return `${out}${text}\x1b[0m`
}
const withColorNoop = (text: string, ..._colors: readonly string[]) => text

const colors = {
  bold: '1',
  red: '31',
  green: '32',
  yellow: '33',
  blue: '34',
  cyan: '36',
  white: '37',
  gray: '90',
  black: '30',
  bgBrightRed: '101',
} as const

const logLevelColors: Record<LogLevel.LogLevel, readonly string[]> = {
  All: [],
  None: [],
  Trace: [colors.gray],
  Debug: [colors.blue],
  Info: [colors.green],
  Warn: [colors.yellow],
  Error: [colors.red],
  Fatal: [colors.bgBrightRed, colors.black],
}

/** v4 Cause has no isEmpty; emptiness means no fail, die, or interrupt reasons */
const isNonEmptyCause = (cause: Cause.Cause<unknown>): boolean =>
  Cause.hasFails(cause) === true ||
  Cause.hasDies(cause) === true ||
  Cause.hasInterrupts(cause) === true

/** Formats date as HH:MM:SS.mmm (24-hour local time with milliseconds) */
export const defaultDateFormat = (date: Date): string =>
  `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}:${date
    .getSeconds()
    .toString()
    .padStart(2, '0')}.${date.getMilliseconds().toString().padStart(3, '0')}`

/** Converts a value to a JSON-serializable form for logging */
export const structuredMessage = (input: unknown): unknown => {
  switch (typeof input) {
    case 'bigint':
    case 'function':
    case 'symbol': {
      return String(input)
    }
    default: {
      return Inspectable.toJson(input)
    }
  }
}

const consoleLogToString = (...inputs: any[]) => {
  if (inputs.length === 0) return ''
  const [first, ...rest] = inputs
  if (typeof first === 'string') {
    return rest.length > 0 ? util.format(first, ...rest.map(structuredMessage)) : first
  }
  return inputs
    .map((value) => {
      if (typeof value === 'string') return value
      return util.inspect(structuredMessage(value), {
        depth: 3,
        colors: false,
        compact: false,
        breakLength: 120,
      })
    })
    .join(' ')
}

/**
 * Explicit log fields used by the pretty formatter.
 *
 * v4 loggers only receive `{ message, logLevel, cause, fiber, date }`; spans and
 * annotations live on fiber references. This shape lets non-Effect callers (e.g.
 * `cmd.ts` subprocess mirroring) format entries without fabricating a Fiber.
 */
export interface PrettyLogEntry {
  readonly date: Date
  readonly logLevel: LogLevel.LogLevel
  readonly message: ReadonlyArray<unknown>
  readonly cause: Cause.Cause<unknown>
  readonly fiberId?: number | undefined
  readonly spans?: ReadonlyArray<readonly [label: string, timestamp: number]> | undefined
  readonly annotations?: Readonly<Record<string, unknown>> | undefined
}

/**
 * Creates a pretty-printing logger suitable for TTY or file output.
 *
 * This is a lower-level building block used by `makeFileLogger`. Use this directly
 * when you need custom output handling (e.g., sending to a remote endpoint).
 *
 * @param options.colors - Include ANSI color codes in output
 * @param options.stderr - Unused (legacy parameter)
 * @param options.formatDate - Custom date formatter, receives Date and returns string prefix
 * @param options.onLog - Callback invoked with each formatted log string
 */
export const prettyLoggerTty = (options: {
  readonly colors: boolean
  readonly stderr: boolean
  readonly formatDate: (date: Date) => string
  readonly onLog?: (str: string) => void
}) => {
  return Logger.make<unknown, string>(({ cause, date, fiber, logLevel, message }) =>
    formatPrettyEntry(options)({
      cause,
      date,
      fiberId: fiber.id,
      logLevel,
      message: EffectArray.ensure(message),
      spans: fiber.getRef(References.CurrentLogSpans),
      annotations: fiber.getRef(References.CurrentLogAnnotations),
    }),
  )
}

/**
 * Formats a single log entry with explicit fields, without requiring an Effect Logger.
 *
 * Use this when you need the pretty format for entries that did not originate from
 * `Effect.log` (e.g. mirrored subprocess output).
 */
export const formatPrettyEntry =
  (options: {
    readonly colors: boolean
    readonly formatDate: (date: Date) => string
    readonly onLog?: (str: string) => void
  }) =>
  (entry: PrettyLogEntry): string => {
    const color = options.colors === true ? withColor : withColorNoop
    const { annotations, cause, date, fiberId, logLevel, message, spans } = entry

    let str = ''

    const log = (...inputs: any[]) => {
      str += `${consoleLogToString(...inputs)}\n`
      options.onLog?.(str)
    }

    const logIndented = (...inputs: any[]) => {
      str += `${consoleLogToString(...inputs).replace(/^/gm, '  ')}\n`
      options.onLog?.(str)
    }

    let firstLine =
      color(`[${options.formatDate(date)}]`, colors.white) +
      ` ${color(logLevel, ...logLevelColors[logLevel])}` +
      ` (#${fiberId ?? 0})`

    if (spans !== undefined && spans.length > 0) {
      const now = date.getTime()
      for (const [label, timestamp] of spans) {
        firstLine += ` ${label} (${now - timestamp}ms)`
      }
    }

    firstLine += ':'
    let messageIndex = 0
    if (message.length > 0) {
      const firstMaybeString = structuredMessage(message[0])
      if (typeof firstMaybeString === 'string') {
        firstLine += ` ${color(firstMaybeString, colors.bold, colors.cyan)}`
        messageIndex++
      }
    }

    log(firstLine)

    if (isNonEmptyCause(cause) === true) {
      logIndented(Cause.pretty(cause))
    }

    if (messageIndex < message.length) {
      for (; messageIndex < message.length; messageIndex++) {
        const msg = message[messageIndex]
        if (typeof msg === 'object' && msg !== null) {
          logIndented(
            util.inspect(structuredMessage(msg), {
              depth: 3,
              colors: false,
              compact: false,
              breakLength: 120,
            }),
          )
        } else {
          logIndented(Redactable.redact(msg))
        }
      }
    }

    if (annotations !== undefined && Object.keys(annotations).length > 0) {
      for (const [key, value] of Object.entries(annotations)) {
        const formattedValue =
          typeof value === 'object' && value !== null
            ? util.inspect(structuredMessage(value), {
                depth: 3,
                colors: false,
                compact: false,
                breakLength: 120,
              })
            : Redactable.redact(value)
        logIndented(color(`${key}:`, colors.bold, colors.white), formattedValue)
      }
    }

    return str
  }
