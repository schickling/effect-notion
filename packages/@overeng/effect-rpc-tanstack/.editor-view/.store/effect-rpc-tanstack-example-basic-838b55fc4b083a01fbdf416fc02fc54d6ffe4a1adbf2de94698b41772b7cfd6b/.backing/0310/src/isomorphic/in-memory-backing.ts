import { Duration, Effect, Layer } from 'effect'

import { DistributedSemaphoreBacking } from '@overeng/effect-distributed-lock'

/**
 * In-memory DistributedSemaphoreBacking — useful for tests where filesystem
 * or Redis backings introduce non-determinism (e.g. flaky fs.watch on CI).
 * Does not implement onPermitsReleased; the DistributedSemaphore falls back
 * to its default polling schedule.
 */
export const make = (): DistributedSemaphoreBacking => {
  /** Map of key -> Map of holderId -> { permits, expiresAt } */
  const store = new Map<string, Map<string, { permits: number; expiresAt: number }>>()

  const getKeyStore = (key: string) => {
    let keyStore = store.get(key)
    if (keyStore === undefined) {
      keyStore = new Map()
      store.set(key, keyStore)
    }
    return keyStore
  }

  const activeCount = (key: string): number => {
    const keyStore = store.get(key)
    if (keyStore === undefined) return 0
    const now = Date.now()
    let count = 0
    for (const [holderId, entry] of keyStore) {
      if (entry.expiresAt <= now) {
        keyStore.delete(holderId)
      } else {
        count += entry.permits
      }
    }
    return count
  }

  return {
    // oxlint-disable-next-line overeng/named-args -- implements DistributedSemaphoreBacking interface
    tryAcquire: (key, holderId, ttl, limit, permits) =>
      Effect.sync(() => {
        const current = activeCount(key)
        if (current + permits > limit) return false
        const keyStore = getKeyStore(key)
        const existing = keyStore.get(holderId)
        keyStore.set(holderId, {
          permits: (existing?.permits ?? 0) + permits,
          expiresAt: Date.now() + Duration.toMillis(ttl),
        })
        return true
      }),

    // oxlint-disable-next-line overeng/named-args -- implements DistributedSemaphoreBacking interface
    release: (key, holderId, permits) =>
      Effect.sync(() => {
        const keyStore = store.get(key)
        if (keyStore === undefined) return 0
        const entry = keyStore.get(holderId)
        if (entry === undefined) return 0
        const released = Math.min(permits, entry.permits)
        if (released >= entry.permits) {
          keyStore.delete(holderId)
        } else {
          keyStore.set(holderId, { ...entry, permits: entry.permits - released })
        }
        return released
      }),

    // oxlint-disable-next-line overeng/named-args -- implements DistributedSemaphoreBacking interface
    refresh: (key, holderId, ttl, _limit, _permits) =>
      Effect.sync(() => {
        const keyStore = store.get(key)
        if (keyStore === undefined) return false
        const entry = keyStore.get(holderId)
        if (entry === undefined) return false
        keyStore.set(holderId, { ...entry, expiresAt: Date.now() + Duration.toMillis(ttl) })
        return true
      }),

    // oxlint-disable-next-line overeng/named-args -- implements DistributedSemaphoreBacking interface
    getCount: (key, _ttl) => Effect.sync(() => activeCount(key)),
  }
}

/** Layer providing an in-memory DistributedSemaphoreBacking */
export const layer: Layer.Layer<DistributedSemaphoreBacking> = Layer.sync(
  DistributedSemaphoreBacking,
  make,
)
