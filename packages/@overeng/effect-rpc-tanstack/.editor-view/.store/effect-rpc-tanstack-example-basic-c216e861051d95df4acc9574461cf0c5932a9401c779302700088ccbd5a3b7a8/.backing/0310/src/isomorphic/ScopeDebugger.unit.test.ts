import { Chunk, Effect, Exit, Layer, Logger, References, Ref } from 'effect'
import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import { addTracedFinalizer, withScopeDebug, withTracedScope } from './ScopeDebugger.ts'

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

  return { logger, getLogs, loggerLayer } as const
})

Vitest.describe('ScopeDebugger', () => {
  Vitest.describe('addTracedFinalizer', () => {
    Vitest.it.effect(
      'logs finalizer registration and execution when debugging enabled',
      Effect.fnUntraced(function* () {
        const { getLogs, loggerLayer } = yield* makeTestLogger()

        yield* withScopeDebug(
          Effect.gen(function* () {
            yield* addTracedFinalizer({
              name: 'test-cleanup',
              finalizer: Effect.log('Cleaning up'),
            })
            yield* Effect.log('Doing work')
          }).pipe(Effect.scoped),
        ).pipe(Effect.provide(loggerLayer))

        const logs = yield* getLogs

        expect(logs.some((l) => l.includes('Finalizer registered: test-cleanup'))).toBe(true)
        expect(logs.some((l) => l.includes('Finalizer starting: test-cleanup'))).toBe(true)
        expect(logs.some((l) => l.includes('Finalizer completed: test-cleanup'))).toBe(true)
      }),
    )

    Vitest.it.effect(
      'does not log when debugging disabled',
      Effect.fnUntraced(function* () {
        const { getLogs, loggerLayer } = yield* makeTestLogger()

        yield* Effect.gen(function* () {
          yield* addTracedFinalizer({
            name: 'test-cleanup',
            finalizer: Effect.log('Cleaning up'),
          })
          yield* Effect.log('Doing work')
        }).pipe(Effect.scoped, Effect.provide(loggerLayer))

        const logs = yield* getLogs

        expect(logs.some((l) => l.includes('Finalizer registered'))).toBe(false)
        expect(logs.some((l) => l.includes('Finalizer starting'))).toBe(false)
        // But the actual finalizer still runs
        expect(logs.some((l) => l.includes('Cleaning up'))).toBe(true)
      }),
    )

    Vitest.it.effect(
      'executes finalizers in reverse registration order',
      Effect.fnUntraced(function* () {
        const order = yield* Ref.make<string[]>([])

        yield* withScopeDebug(
          Effect.gen(function* () {
            yield* addTracedFinalizer({
              name: 'first',
              finalizer: Ref.update(order, (arr) => [...arr, 'first']),
            })
            yield* addTracedFinalizer({
              name: 'second',
              finalizer: Ref.update(order, (arr) => [...arr, 'second']),
            })
            yield* addTracedFinalizer({
              name: 'third',
              finalizer: Ref.update(order, (arr) => [...arr, 'third']),
            })
          }).pipe(Effect.scoped),
        )

        const result = yield* Ref.get(order)
        expect(result).toEqual(['third', 'second', 'first'])
      }),
    )

    Vitest.it.effect(
      'does not swallow finalizer failures when debugging enabled',
      Effect.fnUntraced(function* () {
        const exit = yield* withScopeDebug(
          addTracedFinalizer({
            name: 'fails',
            finalizer: Effect.die('boom'),
          }).pipe(Effect.scoped),
        ).pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
      }),
    )
  })

  Vitest.describe('withTracedScope', () => {
    Vitest.it.effect(
      'logs scope lifecycle',
      Effect.fnUntraced(function* () {
        const { getLogs, loggerLayer } = yield* makeTestLogger()

        yield* withTracedScope('my-scope')(Effect.log('Inside scope')).pipe(
          Effect.provide(loggerLayer),
        )

        const logs = yield* getLogs

        expect(logs.some((l) => l.includes('Traced scope starting: my-scope'))).toBe(true)
        expect(logs.some((l) => l.includes('Inside scope'))).toBe(true)
        expect(logs.some((l) => l.includes('Traced scope closing: my-scope'))).toBe(true)
      }),
    )
  })
})
