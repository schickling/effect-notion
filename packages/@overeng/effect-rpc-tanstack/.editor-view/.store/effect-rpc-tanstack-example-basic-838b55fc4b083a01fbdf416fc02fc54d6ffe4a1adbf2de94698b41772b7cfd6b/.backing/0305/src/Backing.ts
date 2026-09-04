/** Vendored from effect-distributed-lock 0.0.11 (MIT, Copyright (c) 2025 Ethan Niser). See NOTICE. */
import type { Duration, Effect, Stream } from 'effect'
import { Context, Data } from 'effect'

/** Error raised when the backing store fails a semaphore operation. */
export class SemaphoreBackingError extends Data.TaggedError('SemaphoreBackingError')<{
  readonly operation: string
  readonly cause: unknown
}> {
  override get message() {
    return `Backing store error during "${this.operation}": ${this.cause}`
  }
}

/** Storage contract used by distributed semaphores to coordinate holders. */
export interface DistributedSemaphoreBacking {
  readonly tryAcquire: (
    key: string,
    holderId: string,
    ttl: Duration.Duration,
    limit: number,
    permits: number,
  ) => Effect.Effect<boolean, SemaphoreBackingError>

  readonly release: (
    key: string,
    holderId: string,
    permits: number,
  ) => Effect.Effect<number, SemaphoreBackingError>

  readonly refresh: (
    key: string,
    holderId: string,
    ttl: Duration.Duration,
    limit: number,
    permits: number,
  ) => Effect.Effect<boolean, SemaphoreBackingError>

  readonly getCount: (
    key: string,
    ttl: Duration.Duration,
  ) => Effect.Effect<number, SemaphoreBackingError>

  readonly onPermitsReleased?: (key: string) => Stream.Stream<void>
}

/** Effect service tag for the distributed semaphore backing store. */
export const DistributedSemaphoreBacking = Context.Service<
  DistributedSemaphoreBacking,
  DistributedSemaphoreBacking
>()('@effect-distributed-lock/DistributedSemaphoreBacking')
