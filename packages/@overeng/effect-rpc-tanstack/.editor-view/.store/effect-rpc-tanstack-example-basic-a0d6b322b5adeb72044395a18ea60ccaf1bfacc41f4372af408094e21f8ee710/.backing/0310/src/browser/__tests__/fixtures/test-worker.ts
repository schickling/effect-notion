/**
 * Test SharedWorker that uses BroadcastLoggerLive.
 *
 * This worker emits Effect logs which are broadcast to connected tabs.
 */
/// <reference lib="webworker" />
import { Effect } from 'effect'

import { BroadcastLoggerLive } from '../../BroadcastLogger.ts'

declare const self: SharedWorkerGlobalScope

/** Message types the worker handles */
type WorkerMessage =
  | { type: 'emit-logs'; count: number }
  | { type: 'emit-error' }
  | { type: 'emit-with-span' }

self.addEventListener('connect', (event: MessageEvent) => {
  const port = event.ports[0]!

  port.addEventListener('message', (e: MessageEvent<WorkerMessage>) => {
    const msg = e.data

    if (msg.type === 'emit-logs') {
      const program = Effect.gen(function* () {
        for (let i = 0; i < msg.count; i++) {
          yield* Effect.log(`Test message ${i + 1}`)
        }
      }).pipe(Effect.provide(BroadcastLoggerLive('test-worker')))

      Effect.runPromise(program).then(() => {
        port.postMessage({ type: 'done' })
      })
    }

    if (msg.type === 'emit-error') {
      const program = Effect.logError('Something went wrong', {
        errorCode: 'E001',
      }).pipe(Effect.provide(BroadcastLoggerLive('test-worker')))

      Effect.runPromise(program).then(() => {
        port.postMessage({ type: 'done' })
      })
    }

    if (msg.type === 'emit-with-span') {
      const program = Effect.log('Inside span').pipe(
        Effect.withLogSpan('test-span'),
        Effect.provide(BroadcastLoggerLive('test-worker')),
      )

      Effect.runPromise(program).then(() => {
        port.postMessage({ type: 'done' })
      })
    }
  })

  port.start()
})
