import {
  Cause,
  Data,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Result,
  Schema,
  Stream,
} from 'effect'

import {
  DistributedSemaphoreBacking,
  SemaphoreBackingError,
} from '@overeng/effect-distributed-lock'

import {
  SemaphoreForceRevokeOperation as SemaphoreForceRevokeContract,
  SemaphoreKeyOperation as SemaphoreKeyContract,
} from './semaphore.contract.ts'
import { watchScoped } from './watch.ts'

/** Information about a holder's lock state */
export interface HolderInfo {
  readonly holderId: string
  readonly permits: number
  readonly expiresAt: number
}

/**
 * Schema for individual holder lock files.
 * Each holder gets its own file containing permit count and expiry.
 */
const HolderLockSchema = Schema.Struct({
  /** Number of permits held */
  permits: Schema.Finite,
  /** Expiry timestamp in milliseconds since epoch */
  expiresAt: Schema.Finite,
})

type HolderLockContent = typeof HolderLockSchema.Type

// Runtime spans DERIVED from the registered seam contract (`./semaphore.contract.ts`, namespace
// `semaphore`), so the `semaphore.*` catalog + these encoders share one SSOT (SC-R13/R14).
const SemaphoreKeyOperation = SemaphoreKeyContract.operation
const SemaphoreForceRevokeOperation = SemaphoreForceRevokeContract.operation

/**
 * Options for the file-system based semaphore backing.
 */
export interface FileSystemBackingOptions {
  /**
   * Directory where lock files will be stored.
   * Each semaphore key gets its own subdirectory, with one file per holder.
   */
  readonly lockDir: string
}

/** Get the directory path for a semaphore key */
const getKeyDir = (opts: { lockDir: string; key: string }): string =>
  `${opts.lockDir}/${encodeURIComponent(opts.key)}`

/** Get the file path for a specific holder's lock */
const getHolderPath = (opts: { lockDir: string; key: string; holderId: string }): string =>
  `${getKeyDir({ lockDir: opts.lockDir, key: opts.key })}/${encodeURIComponent(opts.holderId)}.lock`

const isNotFoundError = (cause: unknown): boolean => {
  if (typeof cause !== 'object' || cause === null) return false
  const record = cause as Record<string, unknown>
  // v4: platform operations fail with a `PlatformError` wrapper; inspect its reason
  if (record._tag === 'PlatformError') {
    const reason = record.reason as Record<string, unknown> | undefined
    if (typeof reason === 'object' && reason !== null && reason._tag === 'NotFound') return true
  }
  if (record.code === 'ENOENT') return true
  return false
}

/**
 * Read a holder's lock file, returning undefined if it doesn't exist or is expired.
 */
const readHolderLock = Effect.fn('FileSystemBacking.readHolderLock')(function* (opts: {
  filePath: string
  now: number
}) {
  const { filePath, now } = opts
  const fs = yield* FileSystem.FileSystem

  const content = yield* fs.readFileString(filePath).pipe(
    Effect.catchCause((cause) => {
      // v4: platform operations fail with a `PlatformError` wrapper; inspect its reason
      const failure = Cause.findErrorOption(cause).pipe(Option.getOrUndefined)
      if (failure !== undefined && isNotFoundError(failure) === true) {
        return Effect.void
      }

      const defect = Option.map(Result.getSuccess(Cause.findDie(cause)), (die) => die.defect).pipe(
        Option.getOrUndefined,
      )
      if (defect !== undefined && isNotFoundError(defect) === true) {
        return Effect.void
      }

      if (failure !== undefined) {
        return Effect.fail(
          new SemaphoreBackingError({
            operation: 'readFile',
            cause: failure,
          }),
        )
      }
      if (defect !== undefined) {
        return Effect.fail(new SemaphoreBackingError({ operation: 'readFile', cause: defect }))
      }

      return Effect.fail(new SemaphoreBackingError({ operation: 'readFile', cause }))
    }),
  )

  if (content === undefined) {
    return undefined
  }

  const parsed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(HolderLockSchema))(
    content,
  ).pipe(Effect.mapError((cause) => new SemaphoreBackingError({ operation: 'parseJson', cause })))

  // Check if expired
  if (parsed.expiresAt <= now) {
    // Clean up expired file
    yield* fs.remove(filePath).pipe(Effect.ignore)
    return undefined
  }

  return parsed
})

/**
 * Write a holder's lock file atomically using write-to-temp-then-rename pattern.
 */
const writeHolderLock = Effect.fn('FileSystemBacking.writeHolderLock')(function* (opts: {
  filePath: string
  content: HolderLockContent
}) {
  const { filePath, content } = opts
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const dirPath = path.dirname(filePath)

  yield* fs
    .makeDirectory(dirPath, { recursive: true })
    .pipe(
      Effect.mapError((cause) => new SemaphoreBackingError({ operation: 'makeDirectory', cause })),
    )

  const json = yield* Schema.encodeEffect(Schema.fromJsonString(HolderLockSchema))(content).pipe(
    Effect.mapError((cause) => new SemaphoreBackingError({ operation: 'encodeJson', cause })),
  )

  // Write to temp file first, then rename for atomicity
  const tempPath = `${filePath}.${Date.now()}.tmp`

  yield* fs
    .writeFileString(tempPath, json)
    .pipe(Effect.mapError((cause) => new SemaphoreBackingError({ operation: 'writeFile', cause })))

  yield* fs
    .rename(tempPath, filePath)
    .pipe(Effect.mapError((cause) => new SemaphoreBackingError({ operation: 'rename', cause })))
})

/**
 * Remove a holder's lock file.
 */
const removeHolderLock = Effect.fn('FileSystemBacking.removeHolderLock')(function* (
  filePath: string,
) {
  const fs = yield* FileSystem.FileSystem

  yield* fs
    .remove(filePath)
    .pipe(Effect.mapError((cause) => new SemaphoreBackingError({ operation: 'remove', cause })))
})

/** Error thrown when attempting to revoke permits from a non-existent holder */
export class HolderNotFoundError extends Data.TaggedError('HolderNotFoundError')<{
  readonly key: string
  readonly holderId: string
}> {
  override get message(): string {
    return `Holder "${this.holderId}" not found for key "${this.key}"`
  }
}

/**
 * Count active (non-expired) permits in a key's directory.
 */
const countActivePermits = Effect.fn('FileSystemBacking.countActivePermits')(function* (opts: {
  keyDir: string
  now: number
}) {
  const { keyDir, now } = opts
  const fs = yield* FileSystem.FileSystem

  const exists = yield* fs
    .exists(keyDir)
    .pipe(Effect.mapError((cause) => new SemaphoreBackingError({ operation: 'exists', cause })))

  if (exists === false) {
    return 0
  }

  const entries = yield* fs
    .readDirectory(keyDir)
    .pipe(
      Effect.mapError((cause) => new SemaphoreBackingError({ operation: 'readDirectory', cause })),
    )

  let totalPermits = 0

  for (const entry of entries) {
    if (entry.endsWith('.lock') === false) continue

    const filePath = `${keyDir}/${entry}`
    const lock = yield* readHolderLock({ filePath, now })

    if (lock !== undefined) {
      totalPermits += lock.permits
    }
  }

  return totalPermits
})

/**
 * Create a file-system based distributed semaphore backing layer.
 *
 * This implementation stores lock state using one file per holder in a directory
 * structure. Each holder's lock file is written atomically using write-to-temp-
 * then-rename pattern, providing better consistency than read-modify-write on
 * a single shared file.
 *
 * Directory structure:
 * ```
 * {lockDir}/
 *   {key}/
 *     {holderId-1}.lock   # Contains { permits: N, expiresAt: timestamp }
 *     {holderId-2}.lock
 * ```
 *
 * The implementation uses:
 * - Atomic file creation via write-to-temp-then-rename
 * - One file per holder for better isolation
 * - TTL-based expiration with automatic cleanup
 * - File system watching for push-based notifications
 *
 * **Note:** While this provides much better atomicity for individual holder
 * operations, the permit counting across holders is still eventually consistent.
 * For strict distributed locking guarantees, use a proper distributed backend
 * like Redis.
 */
export const layer = (
  options: FileSystemBackingOptions,
): Layer.Layer<DistributedSemaphoreBacking, never, FileSystem.FileSystem | Path.Path> => {
  const { lockDir } = options

  // oxlint-disable-next-line overeng/named-args -- implements DistributedSemaphoreBacking interface
  const tryAcquire = Effect.fn('FileSystemBacking.tryAcquire')(function* (
    key: string,
    holderId: string,
    ttl: Duration.Duration,
    limit: number,
    permits: number,
  ) {
    const keyDir = getKeyDir({ lockDir, key })
    const holderPath = getHolderPath({ lockDir, key, holderId })
    const now = Date.now()
    const ttlMs = Duration.toMillis(ttl)

    // First check our own existing lock
    const existingLock = yield* readHolderLock({ filePath: holderPath, now })
    const existingPermits = existingLock?.permits ?? 0

    // Count total active permits (excluding our own)
    const totalActive = yield* countActivePermits({ keyDir, now })
    const othersPermits = totalActive - existingPermits

    // Check if we can acquire the requested permits
    if (othersPermits + permits > limit) {
      return false
    }

    // Write our lock file
    yield* writeHolderLock({
      filePath: holderPath,
      content: {
        permits,
        expiresAt: now + ttlMs,
      },
    })

    return true
  })

  // oxlint-disable-next-line overeng/named-args -- implements DistributedSemaphoreBacking interface
  const release = Effect.fn('FileSystemBacking.release')(function* (
    key: string,
    holderId: string,
    permits: number,
  ) {
    const holderPath = getHolderPath({ lockDir, key, holderId })
    const now = Date.now()

    const existingLock = yield* readHolderLock({ filePath: holderPath, now })

    if (existingLock === undefined) {
      return 0
    }

    const toRelease = Math.min(permits, existingLock.permits)
    const remaining = existingLock.permits - toRelease

    if (remaining <= 0) {
      // Remove the file entirely
      yield* removeHolderLock(holderPath)
    } else {
      // Update with reduced permits
      yield* writeHolderLock({
        filePath: holderPath,
        content: {
          permits: remaining,
          expiresAt: existingLock.expiresAt,
        },
      })
    }

    return toRelease
  })

  // oxlint-disable-next-line overeng/named-args -- implements DistributedSemaphoreBacking interface
  const refresh = Effect.fn('FileSystemBacking.refresh')(function* (
    key: string,
    holderId: string,
    ttl: Duration.Duration,
    _limit: number,
    permits: number,
  ) {
    const holderPath = getHolderPath({ lockDir, key, holderId })
    const now = Date.now()
    const ttlMs = Duration.toMillis(ttl)

    const existingLock = yield* readHolderLock({ filePath: holderPath, now })

    if (existingLock === undefined) {
      return false
    }

    // Refresh with new expiry
    yield* writeHolderLock({
      filePath: holderPath,
      content: {
        permits: Math.min(permits, existingLock.permits),
        expiresAt: now + ttlMs,
      },
    })

    return true
  })

  // oxlint-disable-next-line overeng/named-args -- implements DistributedSemaphoreBacking interface
  const getCount = Effect.fn('FileSystemBacking.getCount')(function* (
    key: string,
    ttl: Duration.Duration,
  ) {
    const keyDir = getKeyDir({ lockDir, key })
    const now = Date.now()

    // ttl is passed but we use the actual expiry from each lock file
    void ttl

    return yield* countActivePermits({ keyDir, now })
  })

  const onPermitsReleased = (key: string): Stream.Stream<void, never, FileSystem.FileSystem> => {
    const keyDir = getKeyDir({ lockDir, key })

    // Recursive scoped watch via the shared helper (rc.111 recursion is
    // opt-in): holder locks live flat inside the key directory, so the
    // recursive scope observes exactly the same files as before.
    return watchScoped({
      roots: [keyDir],
      scope: (absolutePath) => absolutePath.endsWith('.lock'),
      debounce: Duration.millis(0),
    }).pipe(
      Stream.filter((groups) =>
        groups.some((group) =>
          group.events.some((event) => event._tag === 'Update' || event._tag === 'Remove'),
        ),
      ),
      Stream.map((): void => undefined),
      // Preserve the previous failure semantics: a dead watcher (e.g. a deleted
      // lock directory) must not fail consumers — they fall back to polling.
      Stream.catchCause(() => Stream.empty),
    )
  }

  return Layer.succeed(DistributedSemaphoreBacking, {
    tryAcquire,
    release,
    refresh,
    getCount,
    onPermitsReleased,
  } as DistributedSemaphoreBacking)
}

/**
 * Forcibly revoke all permits held by a specific holder.
 *
 * This immediately removes the holder's lock file, causing their next refresh
 * to fail with `LockLostError`. Use this for:
 * - Recovering from dead/unresponsive processes
 * - Administrative intervention
 * - Testing and debugging
 *
 * @returns The number of permits that were revoked
 */
export const forceRevoke = Effect.fn('FileSystemBacking.forceRevoke')(function* (opts: {
  options: FileSystemBackingOptions
  key: string
  targetHolderId: string
}) {
  yield* SemaphoreForceRevokeOperation.annotate({
    label: opts.key,
    key: opts.key,
    targetHolderId: opts.targetHolderId,
  }).pipe(Effect.orDie)

  const { options, key, targetHolderId } = opts
  const { lockDir } = options
  const holderPath = getHolderPath({
    lockDir,
    key,
    holderId: targetHolderId,
  })
  const now = Date.now()

  const existingLock = yield* readHolderLock({ filePath: holderPath, now })

  if (existingLock === undefined) {
    return yield* new HolderNotFoundError({ key, holderId: targetHolderId })
  }

  yield* removeHolderLock(holderPath)

  return existingLock.permits
})

/**
 * List all active (non-expired) holders for a semaphore key.
 *
 * Useful for inspecting lock state before force-revoking, or for
 * administrative visibility into who holds permits.
 */
export const listHolders = Effect.fn('FileSystemBacking.listHolders')(function* (opts: {
  options: FileSystemBackingOptions
  key: string
}) {
  yield* SemaphoreKeyOperation.annotate({ label: opts.key, key: opts.key }).pipe(Effect.orDie)

  const { options, key } = opts
  const { lockDir } = options
  const keyDir = getKeyDir({ lockDir, key })
  const now = Date.now()
  const fs = yield* FileSystem.FileSystem

  const exists = yield* fs
    .exists(keyDir)
    .pipe(Effect.mapError((cause) => new SemaphoreBackingError({ operation: 'exists', cause })))

  if (exists === false) {
    return []
  }

  const entries = yield* fs
    .readDirectory(keyDir)
    .pipe(
      Effect.mapError((cause) => new SemaphoreBackingError({ operation: 'readDirectory', cause })),
    )

  const holders: HolderInfo[] = []

  for (const entry of entries) {
    if (entry.endsWith('.lock') === false) continue

    const filePath = `${keyDir}/${entry}`
    const lock = yield* readHolderLock({ filePath, now })

    if (lock !== undefined) {
      const holderId = yield* Effect.try({
        try: () => decodeURIComponent(entry.slice(0, -5)), // Remove .lock suffix
        catch: (cause) =>
          new SemaphoreBackingError({
            operation: 'decodeURIComponent',
            cause,
          }),
      })
      holders.push({
        holderId,
        permits: lock.permits,
        expiresAt: lock.expiresAt,
      })
    }
  }

  return holders
})

/**
 * Forcibly revoke permits from all holders for a semaphore key.
 *
 * This is a nuclear option that clears all locks for a key.
 * Use with caution.
 *
 * @returns Array of revoked holders with their permit counts
 */
export const forceRevokeAll = Effect.fn('FileSystemBacking.forceRevokeAll')(function* (opts: {
  options: FileSystemBackingOptions
  key: string
}) {
  yield* SemaphoreKeyOperation.annotate({ label: opts.key, key: opts.key }).pipe(Effect.orDie)

  const { options, key } = opts
  const holders = yield* listHolders({ options, key })
  const revoked: Array<{ holderId: string; permits: number }> = []

  for (const holder of holders) {
    const permits = yield* forceRevoke({
      options,
      key,
      targetHolderId: holder.holderId,
    })
    if (permits > 0) {
      revoked.push({ holderId: holder.holderId, permits })
    }
  }

  return revoked
})
