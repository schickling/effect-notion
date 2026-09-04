import { Deferred, Duration, Effect, Layer, Option } from 'effect'
import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import { DistributedSemaphoreBacking } from './Backing.ts'
import * as DistributedSemaphore from './DistributedSemaphore.ts'

Vitest.describe('DistributedSemaphore', () => {
  Vitest.it.effect('interrupts and joins keepAlive before releasing permits', () =>
    Effect.gen(function* () {
      const key = 'finalizer-order'
      const holderId = 'holder-a'
      const events: Array<string> = []
      const holders = new Set<string>()
      const refreshStarted = yield* Deferred.make<void>()
      const resumeRefresh = yield* Deferred.make<void>()

      const backing: DistributedSemaphoreBacking = {
        tryAcquire: (_key, acquireHolderId) =>
          Effect.sync(() => {
            if (holders.size > 0) return false
            holders.add(acquireHolderId)
            return true
          }),
        release: (_key, releaseHolderId) =>
          Effect.sync(() => {
            events.push('release')
            holders.delete(releaseHolderId)
            return 1
          }),
        refresh: (_key, refreshHolderId) =>
          Effect.gen(function* () {
            events.push('refresh-started')
            yield* Deferred.succeed(refreshStarted, undefined)
            yield* Deferred.await(resumeRefresh)
            events.push('refresh-resumed')
            holders.add(refreshHolderId)
            return true
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                events.push('refresh-interrupted')
              }),
            ),
          ),
        getCount: () => Effect.sync(() => holders.size),
      }

      const backingLayer = Layer.succeed(DistributedSemaphoreBacking, backing)

      yield* Effect.gen(function* () {
        const semaphore = yield* DistributedSemaphore.make(key, {
          limit: 1,
          ttl: Duration.minutes(5),
          refreshInterval: Duration.millis(1),
        })

        yield* semaphore.withPermits(1, { identifier: holderId })(Deferred.await(refreshStarted))
      }).pipe(Effect.provide(backingLayer), Effect.timeout(Duration.seconds(5)))

      expect(events).toEqual(['refresh-started', 'refresh-interrupted', 'release'])
      expect(holders.has(holderId)).toBe(false)

      yield* Effect.gen(function* () {
        const semaphore = yield* DistributedSemaphore.make(key, {
          limit: 1,
          ttl: Duration.minutes(5),
        })
        const acquired = yield* semaphore.withPermitsIfAvailable(1, { identifier: 'holder-b' })(
          Effect.succeed('acquired'),
        )

        expect(Option.getOrUndefined(acquired)).toBe('acquired')
      }).pipe(Effect.provide(backingLayer), Effect.timeout(Duration.seconds(5)))
    }),
  )
})
