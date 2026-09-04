import * as path from 'node:path'

import { NodeServices } from '@effect/platform-node'
import type { Cause } from 'effect'
import { Duration, Effect, FileSystem, Fiber, Option, Queue, Stream } from 'effect'
import type { PlatformError } from 'effect/PlatformError'
import { systemError } from 'effect/PlatformError'
import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import { watchCauseMessage, watchScoped, type WatchGroup } from './watch.ts'

const drainBatches = (batches: Queue.Queue<ReadonlyArray<WatchGroup>>) =>
  Effect.gen(function* () {
    const first = yield* Queue.take(batches)
    // Grace period so stragglers from the same burst land in the assertion set.
    yield* Effect.sleep(Duration.millis(200))
    const rest: Array<ReadonlyArray<WatchGroup>> = []
    let next = yield* Queue.poll(batches)
    while (Option.isSome(next) === true) {
      rest.push(next.value)
      next = yield* Queue.poll(batches)
    }
    yield* Queue.shutdown(batches)
    return [first, ...rest].flat()
  })

Vitest.describe('watchScoped', () => {
  Vitest.it.live(
    'watches nested paths recursively, filters scope, and dedupes bursts',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectory()
        yield* fs.makeDirectory(path.join(root, 'sub'))

        const batches = yield* Queue.unbounded<ReadonlyArray<WatchGroup>>()
        const watcher = yield* watchScoped({
          roots: [root],
          scope: (absolutePath) => absolutePath.endsWith('.txt'),
          debounce: Duration.millis(100),
        }).pipe(
          Stream.runForEach((batch) => Queue.offer(batches, batch)),
          Effect.forkChild,
        )

        // Let the watcher settle before writing (fs.watch registration is
        // asynchronous; events fired before it lands are not delivered).
        yield* Effect.sleep(Duration.millis(200))

        const nestedFile = path.join(root, 'sub', 'deep.txt')
        const ignoredFile = path.join(root, 'notes.log')
        yield* fs.writeFileString(nestedFile, 'one')
        yield* fs.writeFileString(nestedFile, 'two')
        yield* fs.writeFileString(ignoredFile, 'ignored')

        const groups = yield* drainBatches(batches).pipe(Effect.timeout(Duration.seconds(10)))
        yield* Fiber.interrupt(watcher)
        yield* fs.remove(root, { recursive: true })

        const paths = groups.map((group) => group.path)
        // Recursive: a change two levels deep is observed (the rc.111 default
        // non-recursive watch would never fire for it).
        expect(paths).toContain(nestedFile)
        // Scope predicate rejects out-of-scope paths.
        expect(paths).not.toContain(ignoredFile)
        // Bursts collapse to one group per path within a window.
        expect(paths.filter((entry) => entry === nestedFile)).toHaveLength(1)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  Vitest.it.live(
    'supports set-based scopes across multiple roots',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const rootA = yield* fs.makeTempDirectory()
        const rootB = yield* fs.makeTempDirectory()

        const watchedFile = path.join(rootB, 'target.txt')
        const batches = yield* Queue.unbounded<ReadonlyArray<WatchGroup>>()
        const watcher = yield* watchScoped({
          roots: [rootA, rootB],
          scope: new Set([watchedFile]),
          debounce: Duration.millis(100),
        }).pipe(
          Stream.runForEach((batch) => Queue.offer(batches, batch)),
          Effect.forkChild,
        )

        yield* Effect.sleep(Duration.millis(200))

        yield* fs.writeFileString(path.join(rootA, 'other.txt'), 'noise')
        yield* fs.writeFileString(watchedFile, 'change')

        const groups = yield* drainBatches(batches).pipe(Effect.timeout(Duration.seconds(10)))
        yield* Fiber.interrupt(watcher)
        yield* fs.remove(rootA, { recursive: true })
        yield* fs.remove(rootB, { recursive: true })

        expect(groups.map((group) => group.path)).toEqual([watchedFile])
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  Vitest.it.live(
    'propagates watcher failures through the stream',
    Effect.fnUntraced(
      function* () {
        const real = yield* FileSystem.FileSystem
        const root = yield* real.makeTempDirectory()

        // Named override (repo cast rule): swap `watch` for a permanently
        // failing stream to exercise error propagation deterministically — on
        // Linux, deleting a watched directory just silences the watcher.
        const watchError = systemError({
          _tag: 'NotFound',
          module: 'node',
          method: 'watch',
          description: 'synthetic watch failure',
        })
        const fsWithFailingWatch: FileSystem.FileSystem = {
          ...real,
          watch: () => Stream.fail(watchError),
        }

        const outcome = yield* watchScoped({
          roots: [root],
          scope: () => true,
          debounce: Duration.millis(50),
        }).pipe(
          Stream.runDrain,
          Effect.exit,
          Effect.provideService(FileSystem.FileSystem, fsWithFailingWatch),
        )

        expect(outcome._tag).toBe('Failure')
        if (outcome._tag === 'Failure') {
          expect(watchCauseMessage(outcome.cause as Cause.Cause<PlatformError>)).toContain(
            'synthetic watch failure',
          )
        }
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )
})
