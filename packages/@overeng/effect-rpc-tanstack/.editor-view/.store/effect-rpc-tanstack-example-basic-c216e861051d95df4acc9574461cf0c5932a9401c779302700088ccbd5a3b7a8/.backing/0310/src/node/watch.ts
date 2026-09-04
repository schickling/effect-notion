import { resolve } from 'node:path'

import {
  Cause,
  Data,
  Deferred,
  Duration,
  Effect,
  FileSystem,
  Option,
  Queue,
  Ref,
  Stream,
} from 'effect'
import type { PlatformError } from 'effect/PlatformError'

/**
 * One watched path grouped with every event observed for it inside the same
 * coalescing window.
 */
export interface WatchGroup {
  /** Absolute path of the changed entry, resolved against the watched root. */
  readonly path: string
  /**
   * Raw events observed for this path within the window. Event `_tag`s are
   * deliberately kept opaque to consumers: on Linux, writes frequently surface
   * as `Create` (via rename→stat) instead of `Update`.
   */
  readonly events: ReadonlyArray<FileSystem.WatchEvent>
}

/**
 * Policy for a scoped recursive watch: which roots, which paths count, and
 * how events are coalesced into batches.
 */
export interface WatchScopedOptions {
  /**
   * Directories to watch. Every root is watched with an explicit
   * `{ recursive: true }` (rc.111 made recursion opt-in again), so one root
   * covers its entire subtree.
   */
  readonly roots: ReadonlyArray<string>
  /**
   * Absolute paths to keep, as a set or predicate. Watch events arrive with
   * paths relative to the watched root; they are resolved before this scope
   * check, matching the resolve-and-compare idiom every consumer needs.
   */
  readonly scope: ReadonlySet<string> | ((absolutePath: string) => boolean)
  /**
   * Coalescing window: once the first scoped event arrives, further events are
   * accumulated for this long before one deduped batch is emitted. Defaults to
   * 250 milliseconds (the window already used by notion-md's watchers).
   * Pass `0` for immediate, uncoalesced delivery.
   */
  readonly debounce?: Duration.Input | undefined
}

/** Internal marker: all watchers ended without a platform error. */
class WatchSourceEnded extends Data.TaggedError('WatchSourceEnded') {}

const DEFAULT_WATCH_DEBOUNCE = Duration.millis(250)
const WATCH_QUEUE_CAPACITY = 4096

interface PendingEntry {
  readonly absolutePath: string
  readonly event: FileSystem.WatchEvent
}

/**
 * Collect scoped events from a sliding queue into one deduped batch after a
 * debounce window: the first event opens the window (blocking), then
 * everything that accumulated while it was open joins the same batch. Drains
 * with `Queue.poll` — `Queue.takeAll` would block until a further event
 * arrives and stall single-change flushes.
 */
const takeWindow = ({
  pending,
  debounce,
}: {
  readonly pending: Queue.Queue<PendingEntry>
  readonly debounce: Duration.Duration
}): Effect.Effect<ReadonlyArray<WatchGroup>> =>
  Effect.gen(function* () {
    const first = yield* Queue.take(pending)
    yield* Effect.sleep(debounce)

    const entries: Array<PendingEntry> = [first]
    let next = yield* Queue.poll(pending)
    while (Option.isSome(next) === true) {
      entries.push(next.value)
      next = yield* Queue.poll(pending)
    }

    const groups = new Map<string, { path: string; events: Array<FileSystem.WatchEvent> }>()
    for (const entry of entries) {
      const group = groups.get(entry.absolutePath)
      if (group === undefined) {
        groups.set(entry.absolutePath, { path: entry.absolutePath, events: [entry.event] })
      } else {
        group.events.push(entry.event)
      }
    }
    return [...groups.values()]
  })

/**
 * Watch directories recursively and emit deduped batches of scoped changes.
 *
 * Wraps Effect `FileSystem.watch` with an explicit `{ recursive: true }` option
 * (the rc.111 default is non-recursive), resolves event paths against each
 * watch root before applying the scope filter, coalesces bursts into per-window
 * batches, and ties watcher cleanup to the consuming stream's scope.
 *
 * Failure semantics: a watcher error fails the returned stream (consumers can
 * degrade to polling or swallow it); when all watchers end cleanly — e.g. the
 * watched directory disappears — the stream ends instead of hanging.
 */
export const watchScoped = (
  options: WatchScopedOptions,
): Stream.Stream<ReadonlyArray<WatchGroup>, PlatformError, FileSystem.FileSystem> =>
  Stream.scoped(
    Stream.unwrap(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem

        if (options.roots.length === 0) return Stream.empty

        const debounce =
          options.debounce === undefined
            ? DEFAULT_WATCH_DEBOUNCE
            : Duration.fromInputUnsafe(options.debounce)
        const scope = options.scope
        const inScope: (absolutePath: string) => boolean =
          typeof scope === 'function' ? scope : (absolutePath) => scope.has(absolutePath)

        const pending = yield* Queue.sliding<PendingEntry>(WATCH_QUEUE_CAPACITY)
        // Completed by the watcher fiber: failed with the sentinel when the
        // watchers ended cleanly, with their PlatformError when they errored,
        // died with the original cause on unexpected defects.
        const halted = yield* Deferred.make<never, PlatformError | WatchSourceEnded>()

        // One filler fiber per root. Each fiber signals `halted` the moment IT
        // exits — with its watcher error on failure (so one dead root fails the
        // stream immediately instead of waiting for the others), and with the
        // sentinel once every root has ended cleanly (e.g. a watched directory
        // vanished).
        yield* Effect.gen(function* () {
          const remaining = yield* Ref.make(options.roots.length)

          const watchRoot = (root: string) =>
            fs.watch(root, { recursive: true }).pipe(
              Stream.map((event) => ({ absolutePath: resolve(root, event.path), event })),
              Stream.filter((entry) => inScope(entry.absolutePath)),
              Stream.runForEach((entry) => Queue.offer(pending, entry)),
              Effect.result,
              Effect.tap((result) => {
                if (result._tag === 'Failure') {
                  return Deferred.fail(halted, result.failure).pipe(Effect.asVoid)
                }
                return Ref.modify(remaining, (count) => {
                  const next = count - 1
                  return [next, next]
                }).pipe(
                  Effect.flatMap((left) =>
                    left === 0
                      ? Deferred.fail(halted, new WatchSourceEnded()).pipe(Effect.asVoid)
                      : Effect.void,
                  ),
                )
              }),
            )

          yield* Effect.forEach(options.roots, watchRoot, {
            concurrency: 'unbounded',
            discard: true,
          })
        }).pipe(Effect.forkScoped)

        // Windowed batch loop: each iteration blocks until a first scoped event
        // opens a window, sleeps out the debounce, drains the queue, and emits
        // one deduped batch. Ends cleanly on the sentinel, fails with the
        // watchers' PlatformError otherwise.
        return Stream.unfold(
          undefined,
          (): Effect.Effect<
            readonly [ReadonlyArray<WatchGroup>, undefined] | undefined,
            PlatformError
          > =>
            Effect.raceFirst(takeWindow({ pending, debounce }), Deferred.await(halted)).pipe(
              Effect.map((batch) => [batch, undefined] as const),
              Effect.catch((error) =>
                error._tag === 'WatchSourceEnded'
                  ? Effect.void.pipe(Effect.as(undefined))
                  : Effect.fail(error),
              ),
            ),
        )
      }),
    ),
  )

/**
 * Extract the platform error from a failing watch-stream cause and render it
 * as a single-line message, falling back to a generic note for defects.
 */
export const watchCauseMessage = (cause: Cause.Cause<PlatformError>): string => {
  const fail = Cause.findFail(cause)
  if (fail._tag !== 'Success') return 'unknown watch failure'
  return fail.success.error.message
}
