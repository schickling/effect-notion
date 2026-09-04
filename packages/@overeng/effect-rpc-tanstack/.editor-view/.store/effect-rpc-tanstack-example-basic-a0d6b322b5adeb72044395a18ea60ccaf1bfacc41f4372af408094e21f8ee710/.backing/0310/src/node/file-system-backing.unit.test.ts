import * as fs from 'node:fs'
import * as path from 'node:path'

import { NodeServices } from '@effect/platform-node'
import {
  Context,
  Data,
  Deferred,
  Duration,
  Effect,
  FileSystem,
  Fiber,
  Layer,
  Schema,
  Stream,
} from 'effect'
import { expect } from 'vitest'

import { DistributedSemaphoreBacking } from '@overeng/effect-distributed-lock'
import { Vitest } from '@overeng/utils-dev/node-vitest'
import { DistributedSemaphore } from '@overeng/utils/lock'
import { FileSystemBacking as ReexportedFileSystemBacking } from '@overeng/utils/node'

import * as FileSystemBacking from './file-system-backing.ts'

/** Schema for lock file content structure */
const LockFileContent = Schema.Struct({
  permits: Schema.Finite,
  expiresAt: Schema.Finite,
})

/**
 * v4 note: the hand-rolled node-fs mock layer previously avoided
 * `@effect/platform-node` for transitive-dependency reasons; that package is now
 * a first-class dependency, so use its real layers.
 */
const TestLayer = NodeServices.layer

const watchEventPath = (event: FileSystem.WatchEvent): string | undefined =>
  'path' in event && typeof event.path === 'string' ? event.path : undefined

class WatchEventTimeout extends Data.TaggedError('WatchEventTimeout')<{
  readonly fileName: string
}> {}

interface WatchWaiter {
  readonly fileName: string
  readonly resume: (effect: Effect.Effect<FileSystem.WatchEvent, WatchEventTimeout>) => void
  timeout: ReturnType<typeof setTimeout>
}

Vitest.describe('FileSystemBacking', () => {
  Vitest.describe('DistributedSemaphore finalizers', () => {
    Vitest.it.effect('interrupts keepAlive before releasing the holder lock', () =>
      Effect.gen(function* () {
        const fsService = yield* FileSystem.FileSystem
        const tempDir = yield* fsService.makeTempDirectory()
        const lockDir = `${tempDir}/locks`
        const key = 'finalizer-order'
        const holderId = 'holder-a'
        const holderPath = `${lockDir}/${encodeURIComponent(key)}/${encodeURIComponent(holderId)}.lock`
        const events: Array<string> = []
        const refreshStarted = yield* Deferred.make<void>()
        const resumeRefresh = yield* Deferred.make<void>()

        const baseContext = yield* Layer.build(ReexportedFileSystemBacking.layer({ lockDir })).pipe(
          Effect.scoped,
        )
        // NOTE: annotated explicitly because the upstream service key is
        // mid-migration in @overeng/effect-distributed-lock.
        const baseBacking: DistributedSemaphoreBacking = Context.get(
          baseContext,
          DistributedSemaphoreBacking,
        ) as DistributedSemaphoreBacking
        const observedBacking = {
          ...baseBacking,
          release: (releaseKey: string, releaseHolderId: string, permits: number) =>
            Effect.sync(() => {
              events.push('release')
            }).pipe(Effect.andThen(baseBacking.release(releaseKey, releaseHolderId, permits))),
          refresh: (
            refreshKey: string,
            refreshHolderId: string,
            ttl: Duration.Duration,
            limit: number,
            permits: number,
          ) =>
            Effect.gen(function* () {
              events.push('refresh-started')
              yield* Deferred.succeed(refreshStarted, undefined)
              yield* Deferred.await(resumeRefresh)
              events.push('refresh-resumed')
              return yield* baseBacking.refresh(refreshKey, refreshHolderId, ttl, limit, permits)
            }).pipe(
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  events.push('refresh-interrupted')
                }),
              ),
            ),
        } satisfies DistributedSemaphoreBacking

        const observedBackingLayer = Layer.succeed(DistributedSemaphoreBacking, observedBacking)

        yield* Effect.gen(function* () {
          const semaphore = yield* DistributedSemaphore.make(key, {
            limit: 1,
            ttl: Duration.minutes(5),
            refreshInterval: Duration.millis(1),
          })

          yield* semaphore.withPermits(1, { identifier: holderId })(Deferred.await(refreshStarted))
        }).pipe(Effect.provide(observedBackingLayer), Effect.timeout(Duration.seconds(5)))

        expect(events).toEqual(['refresh-started', 'refresh-interrupted', 'release'])
        expect(fs.existsSync(holderPath)).toBe(false)

        yield* Effect.gen(function* () {
          const semaphore = yield* DistributedSemaphore.make(key, {
            limit: 1,
            ttl: Duration.minutes(5),
          })
          const acquired = yield* semaphore.withPermitsIfAvailable(1, { identifier: 'holder-b' })(
            Effect.succeed('acquired'),
          )
          expect(acquired._tag).toBe('Some')
          expect(
            acquired.pipe((option) => (option._tag === 'Some' ? option.value : undefined)),
          ).toBe('acquired')
        }).pipe(Effect.provide(ReexportedFileSystemBacking.layer({ lockDir })))
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )
  })

  Vitest.describe('tryAcquire', () => {
    Vitest.it.effect('acquires permits when available', () =>
      Effect.gen(function* () {
        const fsService = yield* FileSystem.FileSystem
        const tempDir = yield* fsService.makeTempDirectory()
        const lockDir = `${tempDir}/locks`

        const backingLayer = FileSystemBacking.layer({ lockDir })

        yield* Effect.gen(function* () {
          const backing = yield* DistributedSemaphoreBacking

          const acquired = yield* backing.tryAcquire(
            'test-key',
            'holder-1',
            Duration.seconds(30),
            3,
            1,
          )

          expect(acquired).toBe(true)
        }).pipe(Effect.provide(backingLayer))
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    Vitest.it.effect('respects permit limit', () =>
      Effect.gen(function* () {
        const fsService = yield* FileSystem.FileSystem
        const tempDir = yield* fsService.makeTempDirectory()
        const lockDir = `${tempDir}/locks`

        const backingLayer = FileSystemBacking.layer({ lockDir })

        yield* Effect.gen(function* () {
          const backing = yield* DistributedSemaphoreBacking

          const acquired1 = yield* backing.tryAcquire(
            'test-key',
            'holder-1',
            Duration.seconds(30),
            2,
            2,
          )
          expect(acquired1).toBe(true)

          const acquired2 = yield* backing.tryAcquire(
            'test-key',
            'holder-2',
            Duration.seconds(30),
            2,
            1,
          )
          expect(acquired2).toBe(false)
        }).pipe(Effect.provide(backingLayer))
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    Vitest.it.effect('multiple holders can acquire permits up to limit', () =>
      Effect.gen(function* () {
        const fsService = yield* FileSystem.FileSystem
        const tempDir = yield* fsService.makeTempDirectory()
        const lockDir = `${tempDir}/locks`

        const backingLayer = FileSystemBacking.layer({ lockDir })

        yield* Effect.gen(function* () {
          const backing = yield* DistributedSemaphoreBacking

          // Limit is 3, acquire 1 permit each from 3 holders
          const acquired1 = yield* backing.tryAcquire(
            'test-key',
            'holder-1',
            Duration.seconds(30),
            3,
            1,
          )
          const acquired2 = yield* backing.tryAcquire(
            'test-key',
            'holder-2',
            Duration.seconds(30),
            3,
            1,
          )
          const acquired3 = yield* backing.tryAcquire(
            'test-key',
            'holder-3',
            Duration.seconds(30),
            3,
            1,
          )
          // 4th holder should fail
          const acquired4 = yield* backing.tryAcquire(
            'test-key',
            'holder-4',
            Duration.seconds(30),
            3,
            1,
          )

          expect(acquired1).toBe(true)
          expect(acquired2).toBe(true)
          expect(acquired3).toBe(true)
          expect(acquired4).toBe(false)
        }).pipe(Effect.provide(backingLayer))
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    Vitest.it.effect('same holder can re-acquire (update permits)', () =>
      Effect.gen(function* () {
        const fsService = yield* FileSystem.FileSystem
        const tempDir = yield* fsService.makeTempDirectory()
        const lockDir = `${tempDir}/locks`

        const backingLayer = FileSystemBacking.layer({ lockDir })

        yield* Effect.gen(function* () {
          const backing = yield* DistributedSemaphoreBacking

          // Acquire 1 permit
          yield* backing.tryAcquire('test-key', 'holder-1', Duration.seconds(30), 2, 1)

          // Re-acquire with 2 permits (should succeed, updates existing)
          const acquired = yield* backing.tryAcquire(
            'test-key',
            'holder-1',
            Duration.seconds(30),
            2,
            2,
          )
          expect(acquired).toBe(true)

          // Verify count is 2, not 3
          const count = yield* backing.getCount('test-key', Duration.seconds(30))
          expect(count).toBe(2)
        }).pipe(Effect.provide(backingLayer))
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    Vitest.it.effect('different keys are independent', () =>
      Effect.gen(function* () {
        const fsService = yield* FileSystem.FileSystem
        const tempDir = yield* fsService.makeTempDirectory()
        const lockDir = `${tempDir}/locks`

        const backingLayer = FileSystemBacking.layer({ lockDir })

        yield* Effect.gen(function* () {
          const backing = yield* DistributedSemaphoreBacking

          // Acquire all permits on key-1
          yield* backing.tryAcquire('key-1', 'holder-1', Duration.seconds(30), 1, 1)

          // Should still be able to acquire on key-2
          const acquired = yield* backing.tryAcquire(
            'key-2',
            'holder-1',
            Duration.seconds(30),
            1,
            1,
          )
          expect(acquired).toBe(true)
        }).pipe(Effect.provide(backingLayer))
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )
  })

  Vitest.describe('release', () => {
    Vitest.it.effect('releases held permits', () =>
      Effect.gen(function* () {
        const fsService = yield* FileSystem.FileSystem
        const tempDir = yield* fsService.makeTempDirectory()
        const lockDir = `${tempDir}/locks`

        const backingLayer = FileSystemBacking.layer({ lockDir })

        yield* Effect.gen(function* () {
          const backing = yield* DistributedSemaphoreBacking

          yield* backing.tryAcquire('test-key', 'holder-1', Duration.seconds(30), 2, 2)

          const released = yield* backing.release('test-key', 'holder-1', 2)
          expect(released).toBe(2)

          const acquired = yield* backing.tryAcquire(
            'test-key',
            'holder-2',
            Duration.seconds(30),
            2,
            2,
          )
          expect(acquired).toBe(true)
        }).pipe(Effect.provide(backingLayer))
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    Vitest.it.effect('partial release keeps remaining permits', () =>
      Effect.gen(function* () {
        const fsService = yield* FileSystem.FileSystem
        const tempDir = yield* fsService.makeTempDirectory()
        const lockDir = `${tempDir}/locks`

        const backingLayer = FileSystemBacking.layer({ lockDir })

        yield* Effect.gen(function* () {
          const backing = yield* DistributedSemaphoreBacking

          yield* backing.tryAcquire('test-key', 'holder-1', Duration.seconds(30), 3, 3)

          // Release only 1 permit
          const released = yield* backing.release('test-key', 'holder-1', 1)
          expect(released).toBe(1)

          // Should have 2 permits remaining
          const count = yield* backing.getCount('test-key', Duration.seconds(30))
          expect(count).toBe(2)

          // Another holder can acquire 1 permit
          const acquired = yield* backing.tryAcquire(
            'test-key',
            'holder-2',
            Duration.seconds(30),
            3,
            1,
          )
          expect(acquired).toBe(true)

          // But not 2 permits
          const acquired2 = yield* backing.tryAcquire(
            'test-key',
            'holder-3',
            Duration.seconds(30),
            3,
            2,
          )
          expect(acquired2).toBe(false)
        }).pipe(Effect.provide(backingLayer))
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    Vitest.it.effect('releasing more than held returns actual released count', () =>
      Effect.gen(function* () {
        const fsService = yield* FileSystem.FileSystem
        const tempDir = yield* fsService.makeTempDirectory()
        const lockDir = `${tempDir}/locks`

        const backingLayer = FileSystemBacking.layer({ lockDir })

        yield* Effect.gen(function* () {
          const backing = yield* DistributedSemaphoreBacking

          yield* backing.tryAcquire('test-key', 'holder-1', Duration.seconds(30), 5, 2)

          // Try to release 5 but only have 2
          const released = yield* backing.release('test-key', 'holder-1', 5)
          expect(released).toBe(2)
        }).pipe(Effect.provide(backingLayer))
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    Vitest.it.effect('releasing from nonexistent holder returns 0', () =>
      Effect.gen(function* () {
        const fsService = yield* FileSystem.FileSystem
        const tempDir = yield* fsService.makeTempDirectory()
        const lockDir = `${tempDir}/locks`

        const backingLayer = FileSystemBacking.layer({ lockDir })

        yield* Effect.gen(function* () {
          const backing = yield* DistributedSemaphoreBacking

          const released = yield* backing.release('test-key', 'nonexistent', 1)
          expect(released).toBe(0)
        }).pipe(Effect.provide(backingLayer))
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )
  })

  Vitest.describe('refresh', () => {
    Vitest.it.effect('refreshes TTL for held permits', () =>
      Effect.gen(function* () {
        const fsService = yield* FileSystem.FileSystem
        const tempDir = yield* fsService.makeTempDirectory()
        const lockDir = `${tempDir}/locks`

        const backingLayer = FileSystemBacking.layer({ lockDir })

        yield* Effect.gen(function* () {
          const backing = yield* DistributedSemaphoreBacking

          yield* backing.tryAcquire('test-key', 'holder-1', Duration.seconds(30), 2, 1)

          const refreshed = yield* backing.refresh(
            'test-key',
            'holder-1',
            Duration.seconds(30),
            2,
            1,
          )
          expect(refreshed).toBe(true)
        }).pipe(Effect.provide(backingLayer))
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    Vitest.it.effect('returns false when permits expired', () =>
      Effect.gen(function* () {
        const fsService = yield* FileSystem.FileSystem
        const tempDir = yield* fsService.makeTempDirectory()
        const lockDir = `${tempDir}/locks`

        const backingLayer = FileSystemBacking.layer({ lockDir })

        yield* Effect.gen(function* () {
          const backing = yield* DistributedSemaphoreBacking

          const refreshed = yield* backing.refresh(
            'test-key',
            'nonexistent-holder',
            Duration.seconds(30),
            2,
            1,
          )
          expect(refreshed).toBe(false)
        }).pipe(Effect.provide(backingLayer))
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )
  })

  Vitest.describe('getCount', () => {
    Vitest.it.effect('returns count of held permits', () =>
      Effect.gen(function* () {
        const fsService = yield* FileSystem.FileSystem
        const tempDir = yield* fsService.makeTempDirectory()
        const lockDir = `${tempDir}/locks`

        const backingLayer = FileSystemBacking.layer({ lockDir })

        yield* Effect.gen(function* () {
          const backing = yield* DistributedSemaphoreBacking

          yield* backing.tryAcquire('test-key', 'holder-1', Duration.seconds(30), 5, 3)

          const count = yield* backing.getCount('test-key', Duration.seconds(30))
          expect(count).toBe(3)
        }).pipe(Effect.provide(backingLayer))
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    Vitest.it.effect('excludes expired permits from count', () =>
      Effect.gen(function* () {
        const fsService = yield* FileSystem.FileSystem
        const tempDir = yield* fsService.makeTempDirectory()
        const lockDir = `${tempDir}/locks`

        const backingLayer = FileSystemBacking.layer({ lockDir })

        yield* Effect.gen(function* () {
          const backing = yield* DistributedSemaphoreBacking

          yield* backing.tryAcquire('test-key', 'holder-1', Duration.millis(50), 5, 3)

          yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 100)))

          const count = yield* backing.getCount('test-key', Duration.millis(50))
          expect(count).toBe(0)
        }).pipe(Effect.provide(backingLayer))
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    Vitest.it.effect('counts permits from multiple holders', () =>
      Effect.gen(function* () {
        const fsService = yield* FileSystem.FileSystem
        const tempDir = yield* fsService.makeTempDirectory()
        const lockDir = `${tempDir}/locks`

        const backingLayer = FileSystemBacking.layer({ lockDir })

        yield* Effect.gen(function* () {
          const backing = yield* DistributedSemaphoreBacking

          yield* backing.tryAcquire('test-key', 'holder-1', Duration.seconds(30), 10, 2)
          yield* backing.tryAcquire('test-key', 'holder-2', Duration.seconds(30), 10, 3)
          yield* backing.tryAcquire('test-key', 'holder-3', Duration.seconds(30), 10, 1)

          const count = yield* backing.getCount('test-key', Duration.seconds(30))
          expect(count).toBe(6) // 2 + 3 + 1
        }).pipe(Effect.provide(backingLayer))
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )
  })

  Vitest.describe('file structure', () => {
    Vitest.it.effect('creates separate lock files per holder', () =>
      Effect.gen(function* () {
        const fsService = yield* FileSystem.FileSystem
        const tempDir = yield* fsService.makeTempDirectory()
        const lockDir = `${tempDir}/locks`

        const backingLayer = FileSystemBacking.layer({ lockDir })

        yield* Effect.gen(function* () {
          const backing = yield* DistributedSemaphoreBacking

          yield* backing.tryAcquire('my-key', 'holder-a', Duration.seconds(30), 5, 2)
          yield* backing.tryAcquire('my-key', 'holder-b', Duration.seconds(30), 5, 1)

          // Verify directory structure
          const keyDir = `${lockDir}/my-key`
          const entries = fs.readdirSync(keyDir).sort()

          expect(entries).toEqual(['holder-a.lock', 'holder-b.lock'])

          // Verify lock file content
          const holderAContent = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(LockFileContent),
          )(fs.readFileSync(`${keyDir}/holder-a.lock`, 'utf-8'))
          expect(holderAContent.permits).toBe(2)
          expect(typeof holderAContent.expiresAt).toBe('number')

          const holderBContent = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(LockFileContent),
          )(fs.readFileSync(`${keyDir}/holder-b.lock`, 'utf-8'))
          expect(holderBContent.permits).toBe(1)
        }).pipe(Effect.provide(backingLayer))
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    Vitest.it.effect('removes lock file on full release', () =>
      Effect.gen(function* () {
        const fsService = yield* FileSystem.FileSystem
        const tempDir = yield* fsService.makeTempDirectory()
        const lockDir = `${tempDir}/locks`

        const backingLayer = FileSystemBacking.layer({ lockDir })

        yield* Effect.gen(function* () {
          const backing = yield* DistributedSemaphoreBacking

          yield* backing.tryAcquire('my-key', 'holder-a', Duration.seconds(30), 5, 2)

          // Verify file exists
          const keyDir = `${lockDir}/my-key`
          expect(fs.existsSync(`${keyDir}/holder-a.lock`)).toBe(true)

          // Release all permits
          yield* backing.release('my-key', 'holder-a', 2)

          // Verify file is removed
          expect(fs.existsSync(`${keyDir}/holder-a.lock`)).toBe(false)
        }).pipe(Effect.provide(backingLayer))
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )
  })

  Vitest.describe('forceRevoke', () => {
    Vitest.it.effect('revokes permits from a holder and returns permit count', () =>
      Effect.gen(function* () {
        const fsService = yield* FileSystem.FileSystem
        const tempDir = yield* fsService.makeTempDirectory()
        const lockDir = `${tempDir}/locks`
        const options = { lockDir }

        const backingLayer = FileSystemBacking.layer(options)

        yield* Effect.gen(function* () {
          const backing = yield* DistributedSemaphoreBacking

          yield* backing.tryAcquire('test-key', 'holder-1', Duration.seconds(30), 5, 3)

          const revoked = yield* FileSystemBacking.forceRevoke({
            options,
            key: 'test-key',
            targetHolderId: 'holder-1',
          })
          expect(revoked).toBe(3)

          // Holder's lock file should be removed
          const keyDir = `${lockDir}/test-key`
          expect(fs.existsSync(`${keyDir}/holder-1.lock`)).toBe(false)

          // Permits should now be available for others
          const count = yield* backing.getCount('test-key', Duration.seconds(30))
          expect(count).toBe(0)
        }).pipe(Effect.provide(backingLayer))
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    Vitest.it.effect('fails with HolderNotFoundError for non-existent holder', () =>
      Effect.gen(function* () {
        const fsService = yield* FileSystem.FileSystem
        const tempDir = yield* fsService.makeTempDirectory()
        const lockDir = `${tempDir}/locks`
        const options = { lockDir }

        const result = yield* FileSystemBacking.forceRevoke({
          options,
          key: 'test-key',
          targetHolderId: 'nonexistent',
        }).pipe(Effect.result)

        expect(result._tag).toBe('Failure')
        if (result._tag === 'Failure') {
          expect(result.failure._tag).toBe('HolderNotFoundError')
        }
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    Vitest.it.effect('allows another holder to acquire after force revoke', () =>
      Effect.gen(function* () {
        const fsService = yield* FileSystem.FileSystem
        const tempDir = yield* fsService.makeTempDirectory()
        const lockDir = `${tempDir}/locks`
        const options = { lockDir }

        const backingLayer = FileSystemBacking.layer(options)

        yield* Effect.gen(function* () {
          const backing = yield* DistributedSemaphoreBacking

          // Holder 1 acquires all permits
          yield* backing.tryAcquire('test-key', 'holder-1', Duration.seconds(30), 1, 1)

          // Holder 2 cannot acquire
          const acquired1 = yield* backing.tryAcquire(
            'test-key',
            'holder-2',
            Duration.seconds(30),
            1,
            1,
          )
          expect(acquired1).toBe(false)

          // Force revoke holder 1
          yield* FileSystemBacking.forceRevoke({
            options,
            key: 'test-key',
            targetHolderId: 'holder-1',
          })

          // Now holder 2 can acquire
          const acquired2 = yield* backing.tryAcquire(
            'test-key',
            'holder-2',
            Duration.seconds(30),
            1,
            1,
          )
          expect(acquired2).toBe(true)
        }).pipe(Effect.provide(backingLayer))
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    Vitest.it.effect('causes victim holder refresh to fail', () =>
      Effect.gen(function* () {
        const fsService = yield* FileSystem.FileSystem
        const tempDir = yield* fsService.makeTempDirectory()
        const lockDir = `${tempDir}/locks`
        const options = { lockDir }

        const backingLayer = FileSystemBacking.layer(options)

        yield* Effect.gen(function* () {
          const backing = yield* DistributedSemaphoreBacking

          yield* backing.tryAcquire('test-key', 'holder-1', Duration.seconds(30), 5, 2)

          // Force revoke
          yield* FileSystemBacking.forceRevoke({
            options,
            key: 'test-key',
            targetHolderId: 'holder-1',
          })

          // Victim's refresh should now fail
          const refreshed = yield* backing.refresh(
            'test-key',
            'holder-1',
            Duration.seconds(30),
            5,
            2,
          )
          expect(refreshed).toBe(false)
        }).pipe(Effect.provide(backingLayer))
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )
  })

  Vitest.describe('listHolders', () => {
    Vitest.it.effect('returns empty array when no holders', () =>
      Effect.gen(function* () {
        const fsService = yield* FileSystem.FileSystem
        const tempDir = yield* fsService.makeTempDirectory()
        const lockDir = `${tempDir}/locks`
        const options = { lockDir }

        const holders = yield* FileSystemBacking.listHolders({
          options,
          key: 'test-key',
        })
        expect(holders).toEqual([])
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    Vitest.it.effect('returns all active holders with their info', () =>
      Effect.gen(function* () {
        const fsService = yield* FileSystem.FileSystem
        const tempDir = yield* fsService.makeTempDirectory()
        const lockDir = `${tempDir}/locks`
        const options = { lockDir }

        const backingLayer = FileSystemBacking.layer(options)

        yield* Effect.gen(function* () {
          const backing = yield* DistributedSemaphoreBacking

          yield* backing.tryAcquire('test-key', 'holder-a', Duration.seconds(30), 10, 2)
          yield* backing.tryAcquire('test-key', 'holder-b', Duration.seconds(30), 10, 3)

          const holders = yield* FileSystemBacking.listHolders({
            options,
            key: 'test-key',
          })

          expect(holders).toHaveLength(2)

          const holderA = holders.find((h) => h.holderId === 'holder-a')
          const holderB = holders.find((h) => h.holderId === 'holder-b')

          expect(holderA).toBeDefined()
          expect(holderA?.permits).toBe(2)
          expect(typeof holderA?.expiresAt).toBe('number')

          expect(holderB).toBeDefined()
          expect(holderB?.permits).toBe(3)
        }).pipe(Effect.provide(backingLayer))
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    Vitest.it.effect('excludes expired holders', () =>
      Effect.gen(function* () {
        const fsService = yield* FileSystem.FileSystem
        const tempDir = yield* fsService.makeTempDirectory()
        const lockDir = `${tempDir}/locks`
        const options = { lockDir }
        const keyDir = `${lockDir}/${encodeURIComponent('test-key')}`
        const now = Date.now()

        yield* fsService.makeDirectory(keyDir, { recursive: true })
        const expiredLockContent = yield* Schema.encodeEffect(
          Schema.fromJsonString(LockFileContent),
        )({
          permits: 2,
          expiresAt: now - 60_000,
        }).pipe(Effect.orDie)
        yield* fsService.writeFileString(
          `${keyDir}/${encodeURIComponent('holder-expired')}.lock`,
          expiredLockContent,
        )
        const activeLockContent = yield* Schema.encodeEffect(
          Schema.fromJsonString(LockFileContent),
        )({
          permits: 3,
          expiresAt: now + 60_000,
        }).pipe(Effect.orDie)
        yield* fsService.writeFileString(
          `${keyDir}/${encodeURIComponent('holder-active')}.lock`,
          activeLockContent,
        )

        const holders = yield* FileSystemBacking.listHolders({
          options,
          key: 'test-key',
        })

        expect(holders).toHaveLength(1)
        expect(holders[0]?.holderId).toBe('holder-active')
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )
  })

  Vitest.describe('forceRevokeAll', () => {
    Vitest.it.effect('revokes all holders and returns their info', () =>
      Effect.gen(function* () {
        const fsService = yield* FileSystem.FileSystem
        const tempDir = yield* fsService.makeTempDirectory()
        const lockDir = `${tempDir}/locks`
        const options = { lockDir }

        const backingLayer = FileSystemBacking.layer(options)

        yield* Effect.gen(function* () {
          const backing = yield* DistributedSemaphoreBacking

          yield* backing.tryAcquire('test-key', 'holder-1', Duration.seconds(30), 10, 2)
          yield* backing.tryAcquire('test-key', 'holder-2', Duration.seconds(30), 10, 3)
          yield* backing.tryAcquire('test-key', 'holder-3', Duration.seconds(30), 10, 1)

          const revoked = yield* FileSystemBacking.forceRevokeAll({
            options,
            key: 'test-key',
          })

          expect(revoked).toHaveLength(3)
          expect(revoked.map((r) => r.holderId).sort()).toEqual([
            'holder-1',
            'holder-2',
            'holder-3',
          ])
          expect(revoked.reduce((sum, r) => sum + r.permits, 0)).toBe(6)

          // All permits should now be available
          const count = yield* backing.getCount('test-key', Duration.seconds(30))
          expect(count).toBe(0)
        }).pipe(Effect.provide(backingLayer))
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )

    Vitest.it.effect('returns empty array when no holders', () =>
      Effect.gen(function* () {
        const fsService = yield* FileSystem.FileSystem
        const tempDir = yield* fsService.makeTempDirectory()
        const lockDir = `${tempDir}/locks`
        const options = { lockDir }

        const revoked = yield* FileSystemBacking.forceRevokeAll({
          options,
          key: 'nonexistent-key',
        })
        expect(revoked).toEqual([])
      }).pipe(Effect.provide(TestLayer), Effect.scoped),
    )
  })

  Vitest.describe('FileSystem.watch membership', () => {
    Vitest.it.effect('watches direct children but not nested children without recursion', () =>
      Effect.gen(function* () {
        const fsService = yield* FileSystem.FileSystem
        const watchDir = yield* fsService.makeTempDirectory()
        const nestedDir = path.join(watchDir, 'sub')
        const directBefore = 'direct-before.lock'
        const directAfter = 'direct-after.lock'
        const nestedChild = 'nested-child.lock'
        const observed: Array<FileSystem.WatchEvent> = []
        const waiters: Array<WatchWaiter> = []

        const awaitObservedPath = (
          fileName: string,
        ): Effect.Effect<FileSystem.WatchEvent, WatchEventTimeout> =>
          Effect.callback<FileSystem.WatchEvent, WatchEventTimeout>((resume) => {
            const waiter: WatchWaiter = {
              fileName,
              resume,
              timeout: setTimeout(
                () => {
                  const index = waiters.indexOf(waiter)
                  if (index >= 0) {
                    waiters.splice(index, 1)
                  }
                  resume(Effect.fail(new WatchEventTimeout({ fileName })))
                },
                Duration.toMillis(Duration.seconds(5)),
              ),
            }

            waiters.push(waiter)

            return Effect.sync(() => {
              clearTimeout(waiter.timeout)
              const index = waiters.indexOf(waiter)
              if (index >= 0) {
                waiters.splice(index, 1)
              }
            })
          })

        const recordEvent = (event: FileSystem.WatchEvent): Effect.Effect<void> =>
          Effect.sync(() => {
            observed.push(event)

            const eventName = path.basename(watchEventPath(event) ?? '')
            const matchingWaiters = waiters.filter((waiter) => waiter.fileName === eventName)
            for (const waiter of matchingWaiters) {
              clearTimeout(waiter.timeout)
              const index = waiters.indexOf(waiter)
              if (index >= 0) {
                waiters.splice(index, 1)
              }
              waiter.resume(Effect.succeed(event))
            }
          })

        const watchFiber = yield* fsService
          .watch(watchDir)
          .pipe(Stream.runForEach(recordEvent), Effect.forkChild)
        yield* Effect.yieldNow

        const writeDirectFileUntilObserved = (fileName: string, content: string) =>
          Effect.gen(function* () {
            const eventFiber = yield* awaitObservedPath(fileName).pipe(Effect.forkChild)

            for (const attempt of [1, 2, 3, 4, 5]) {
              yield* fsService.writeFileString(
                path.join(watchDir, fileName),
                `${content}-${attempt}`,
              )
              yield* Effect.yieldNow
            }

            return yield* Fiber.join(eventFiber)
          })

        yield* writeDirectFileUntilObserved(directBefore, 'direct')

        yield* fsService.makeDirectory(nestedDir)
        yield* fsService.writeFileString(path.join(nestedDir, nestedChild), 'nested')
        yield* writeDirectFileUntilObserved(directAfter, 'settled')
        yield* Fiber.interrupt(watchFiber)

        const observedPathNames = observed
          .map(watchEventPath)
          .filter((eventPath): eventPath is string => eventPath !== undefined)
          .map((eventPath) => path.basename(eventPath))

        expect(observedPathNames).toContain(directBefore)
        expect(observedPathNames).toContain(directAfter)
        expect(observedPathNames).not.toContain(nestedChild)
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    )
  })

  Vitest.describe('onPermitsReleased', () => {
    Vitest.it.effect('completes when watched directory is deleted (no hang)', () =>
      Effect.gen(function* () {
        const fsService = yield* FileSystem.FileSystem
        const tempDir = yield* fsService.makeTempDirectory()
        const lockDir = `${tempDir}/locks`

        const backingLayer = FileSystemBacking.layer({ lockDir })

        yield* Effect.gen(function* () {
          const backing = yield* DistributedSemaphoreBacking

          yield* backing.tryAcquire('test-key', 'holder-1', Duration.seconds(30), 2, 1)

          const stream = backing.onPermitsReleased!('test-key')

          // Delete the lock directory to trigger fs.watch error
          yield* fsService.remove(`${lockDir}/${encodeURIComponent('test-key')}`, {
            recursive: true,
          })

          // Stream should complete (not hang) — the 5s timeout is a safety net
          yield* stream.pipe(Stream.runDrain, Effect.timeout(Duration.seconds(5)))
        }).pipe(Effect.provide(backingLayer))
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    )
  })
})
