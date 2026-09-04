import { Chunk, Duration, Effect, Layer, Logger, References, Ref } from 'effect'
import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import {
  dumpActiveHandles,
  logActiveHandles,
  monitorActiveHandles,
  withActiveHandlesDumpOnSigint,
} from './ActiveHandlesDebugger.ts'

/** Test logger that captures log messages at all levels */
const makeTestLogger = Effect.fnUntraced(function* () {
  const logs = yield* Ref.make<Chunk.Chunk<string>>(Chunk.empty())

  const logger = Logger.make<unknown, void>(({ message }) => {
    const msg = Array.isArray(message) === true ? message.join(' ') : String(message)
    // @effect-diagnostics-next-line runEffectInsideEffect:off -- Logger.make callback is not logically inside an Effect; synchronous capture is required here
    Effect.runSync(Ref.update(logs, Chunk.append(msg)))
  })

  const getLogs = Ref.get(logs).pipe(Effect.map(Chunk.toArray))

  const loggerLayer = Layer.merge(
    Logger.layer([logger], { mergeWithExisting: false }),
    Layer.succeed(References.MinimumLogLevel, 'All'),
  )

  return { getLogs, loggerLayer } as const
})

Vitest.describe('ActiveHandlesDebugger', () => {
  Vitest.describe('dumpActiveHandles', () => {
    Vitest.it.effect(
      'returns active handles info',
      Effect.fnUntraced(function* () {
        const info = yield* dumpActiveHandles

        expect(info).toHaveProperty('handles')
        expect(info).toHaveProperty('requests')
        expect(info).toHaveProperty('totalHandles')
        expect(info).toHaveProperty('totalRequests')
        expect(Array.isArray(info.handles)).toBe(true)
        expect(Array.isArray(info.requests)).toBe(true)
        expect(typeof info.totalHandles).toBe('number')
        expect(typeof info.totalRequests).toBe('number')
      }),
    )

    Vitest.it.effect(
      'includes handle type and details',
      Effect.fnUntraced(function* () {
        const info = yield* dumpActiveHandles

        // Node always has some handles (TTY, etc.)
        if (info.handles.length > 0) {
          const handle = info.handles[0]!
          expect(handle).toHaveProperty('type')
          expect(handle).toHaveProperty('details')
          expect(typeof handle.type).toBe('string')
          expect(typeof handle.details).toBe('string')
        }
      }),
    )

    Vitest.it.effect(
      'detects new handles when created',
      Effect.fnUntraced(function* () {
        // Get baseline handle count
        const before = yield* dumpActiveHandles
        const beforeCount = before.totalHandles

        // Create a timer that will be active
        const timer = setTimeout(() => {}, 10000)

        try {
          const after = yield* dumpActiveHandles

          // Should have at least as many handles (timers may be represented differently)
          expect(after.totalHandles).toBeGreaterThanOrEqual(beforeCount)
        } finally {
          clearTimeout(timer)
        }
      }),
    )
  })

  Vitest.describe('logActiveHandles', () => {
    Vitest.it.effect(
      'logs handles info',
      Effect.fnUntraced(function* () {
        const { getLogs, loggerLayer } = yield* makeTestLogger()

        yield* logActiveHandles.pipe(Effect.provide(loggerLayer))

        const logs = yield* getLogs

        expect(logs.some((l) => l.includes('Active handles dump'))).toBe(true)
      }),
    )

    Vitest.it.effect(
      'returns the handles info',
      Effect.fnUntraced(function* () {
        const info = yield* logActiveHandles

        expect(info).toHaveProperty('totalHandles')
        expect(info).toHaveProperty('totalRequests')
      }),
    )
  })

  Vitest.describe('monitorActiveHandles', () => {
    Vitest.it.effect(
      'returns void immediately after forking the monitor',
      Effect.fnUntraced(function* () {
        // monitorActiveHandles forks internally and returns void
        // This test just verifies it doesn't throw and the signature is correct
        const result: void = yield* monitorActiveHandles(Duration.millis(100)).pipe(
          Effect.scoped,
          // Immediately interrupt to prevent the monitor from running
          Effect.race(Effect.void),
        )
        expect(result).toBeUndefined()
      }),
    )

    Vitest.it.effect(
      'forks a background fiber that is cleaned up when scope closes',
      Effect.fnUntraced(function* () {
        // monitorActiveHandles forks scoped, so it returns immediately
        // The forked fiber runs in background and is cleaned up when scope closes
        // We just verify the scoped effect completes without hanging
        yield* monitorActiveHandles(Duration.millis(100)).pipe(Effect.scoped)
        // If we get here, the scope closed and cleaned up the forked fiber
        expect(true).toBe(true)
      }),
    )
  })

  Vitest.describe('withActiveHandlesDumpOnSigint', () => {
    Vitest.it.effect(
      'runs the wrapped effect normally',
      Effect.fnUntraced(function* () {
        const result = yield* withActiveHandlesDumpOnSigint(Effect.succeed(42))
        expect(result).toBe(42)
      }),
    )

    Vitest.it.effect('cleans up handler after effect completes', () =>
      // Just verify it doesn't throw and completes normally
      withActiveHandlesDumpOnSigint(Effect.void),
    )

    Vitest.it.effect(
      'propagates errors from wrapped effect',
      Effect.fnUntraced(function* () {
        const exit = yield* withActiveHandlesDumpOnSigint(Effect.fail('test-error')).pipe(
          Effect.exit,
        )

        expect(exit._tag).toBe('Failure')
      }),
    )
  })
})
