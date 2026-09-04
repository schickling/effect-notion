/**
 * Debug utilities for diagnosing what's keeping a Node.js process alive.
 *
 * Node.js processes stay alive while there are active handles (timers, sockets, etc.)
 * or pending requests. This module provides Effect-native APIs to inspect these.
 */
import { Effect, type Duration, Schedule, Schema, Stream } from 'effect'

import {
  OtelAttr,
  OtelOperation,
  type OtelAttrEncodeError,
  type OtelOperationDefinition,
} from '@overeng/otel-contract'

/** Information about a single active handle */
export interface HandleInfo {
  readonly type: string
  readonly details: string
}

/** Summary of all active handles and requests */
export interface ActiveHandlesInfo {
  readonly handles: readonly HandleInfo[]
  readonly requests: readonly HandleInfo[]
  readonly totalHandles: number
  readonly totalRequests: number
}

const ActiveHandlesLogOperation = OtelOperation.define({
  name: 'ActiveHandlesDebugger.logActiveHandles',
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

/** Categorizes a handle by its constructor name and extracts useful details */
const categorizeHandle = (handle: unknown): HandleInfo => {
  const type = handle?.constructor?.name ?? 'Unknown'

  let details = ''
  if (type === 'Timer' || type === 'Timeout') {
    const timer = handle as { _idleTimeout?: number }
    if (timer._idleTimeout !== undefined) {
      details = `timeout: ${timer._idleTimeout}ms`
    }
  } else if (type === 'Socket' || type === 'TCP') {
    const socket = handle as {
      remoteAddress?: string
      remotePort?: number
      localPort?: number
    }
    if (socket.remoteAddress !== undefined) {
      details = `remote: ${socket.remoteAddress}:${socket.remotePort}`
    } else if (socket.localPort !== undefined) {
      details = `local port: ${socket.localPort}`
    }
  } else if (type === 'FSReqCallback' || type === 'FSReqPromise') {
    details = 'file system operation'
  } else if (type === 'ChildProcess') {
    const cp = handle as { pid?: number }
    details = cp.pid !== undefined ? `pid: ${cp.pid}` : ''
  }

  return { type, details }
}

/**
 * Returns information about all active handles and pending requests.
 *
 * Uses Node.js internals `process._getActiveHandles()` and `process._getActiveRequests()`.
 * These are undocumented but stable APIs used by debugging tools.
 *
 * @example
 * ```ts
 * const info = yield* dumpActiveHandles
 * console.log(`${info.totalHandles} handles, ${info.totalRequests} requests`)
 * for (const h of info.handles) {
 *   console.log(`  ${h.type}: ${h.details}`)
 * }
 * ```
 */
export const dumpActiveHandles = Effect.sync((): ActiveHandlesInfo => {
  const proc = process as any
  const rawHandles: unknown[] = proc._getActiveHandles?.() ?? []
  const rawRequests: unknown[] = proc._getActiveRequests?.() ?? []

  const handles = rawHandles.map(categorizeHandle)
  const requests = rawRequests.map(categorizeHandle)

  return {
    handles,
    requests,
    totalHandles: handles.length,
    totalRequests: requests.length,
  }
})

/**
 * Logs active handles and requests using Effect.log.
 *
 * Useful as a one-shot diagnostic at the end of a program or when debugging
 * why a process won't exit.
 *
 * @example
 * ```ts
 * // At end of program
 * yield* logActiveHandles
 * ```
 */
export const logActiveHandles = Effect.gen(function* () {
  const info = yield* dumpActiveHandles
  yield* Effect.log('Active handles dump', {
    totalHandles: info.totalHandles,
    totalRequests: info.totalRequests,
    handles: info.handles,
    requests: info.requests,
  })
  return info
}).pipe(trustedWith({ operation: ActiveHandlesLogOperation, attributes: { label: 'dump' } }))

/**
 * Monitors active handles periodically and logs when the count changes.
 *
 * Returns a scoped effect that runs until the scope is closed.
 * Only logs when handle/request counts change to reduce noise.
 *
 * @example
 * ```ts
 * // Monitor every 5 seconds
 * yield* monitorActiveHandles(Duration.seconds(5))
 *
 * // Or with explicit scope
 * yield* Effect.scoped(monitorActiveHandles(Duration.seconds(1)))
 * ```
 */
export const monitorActiveHandles = Effect.fn('ActiveHandlesDebugger.monitorActiveHandles')(
  function* (interval: Duration.Input) {
    let lastTotal = -1

    const _ = yield* Stream.fromSchedule(Schedule.spaced(interval)).pipe(
      Stream.runForEach(() =>
        Effect.gen(function* () {
          const info = yield* dumpActiveHandles
          const currentTotal = info.totalHandles + info.totalRequests

          if (currentTotal !== lastTotal) {
            yield* Effect.log('Active handles changed', {
              handles: info.totalHandles,
              requests: info.totalRequests,
              delta: lastTotal === -1 ? 0 : currentTotal - lastTotal,
            })
            lastTotal = currentTotal
          }
        }),
      ),
      Effect.forkScoped,
    )
  },
)

/**
 * Registers a SIGINT handler that dumps active handles before exit.
 *
 * Useful for debugging processes that don't exit cleanly on Ctrl+C.
 *
 * @example
 * ```ts
 * yield* withActiveHandlesDumpOnSigint(myProgram)
 * ```
 */
export const withActiveHandlesDumpOnSigint = Effect.fn(
  'ActiveHandlesDebugger.withActiveHandlesDumpOnSigint',
)(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
  const context = yield* Effect.context<R>()

  const handler = () => {
    try {
      Effect.runSyncWith(context)(logActiveHandles.pipe(Effect.ignore))
    } finally {
      process.off('SIGINT', handler)
      process.kill(process.pid, 'SIGINT')
    }
  }

  yield* Effect.sync(() => process.on('SIGINT', handler))

  return yield* effect.pipe(Effect.ensuring(Effect.sync(() => process.off('SIGINT', handler))))
})
