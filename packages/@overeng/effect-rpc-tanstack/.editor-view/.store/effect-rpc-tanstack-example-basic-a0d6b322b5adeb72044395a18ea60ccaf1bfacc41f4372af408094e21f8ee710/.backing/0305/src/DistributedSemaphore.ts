/** Vendored from effect-distributed-lock 0.0.11 (MIT, Copyright (c) 2025 Ethan Niser). See NOTICE. */
/* oxlint-disable overeng/named-args -- Preserve the upstream positional semaphore API. */
import type { Scope } from 'effect'
import { Duration, Effect, Fiber, Function, Option, Schedule, Semaphore, Stream } from 'effect'

import type { SemaphoreBackingError } from './Backing.ts'
import { DistributedSemaphoreBacking } from './Backing.ts'
import { LockLostError, LockNotAcquiredError } from './Errors.ts'

/** Runtime tuning for distributed semaphore acquisition and refresh. */
export interface DistributedSemaphoreConfig {
  readonly limit?: number
  readonly ttl?: Duration.Input
  readonly refreshInterval?: Duration.Input
  readonly acquireRetryPolicy?: Schedule.Schedule<unknown>
  readonly backingFailureRetryPolicy?: Schedule.Schedule<unknown>
}

const DEFAULT_LIMIT = 1
const DEFAULT_TTL = Duration.seconds(30)
const DEFAULT_ACQUIRE_RETRY_POLICY = Schedule.spaced(Duration.millis(100))
const DEFAULT_FAILURE_RETRY_POLICY = Schedule.recurs(3)

/** Options for acquiring permits from the distributed semaphore. */
export interface AcquireOptions {
  readonly identifier?: string
  readonly acquiredExternally?: boolean
}

/** Distributed semaphore API for scoped permit acquisition and refresh. */
export interface DistributedSemaphore {
  readonly key: string
  readonly limit: number
  readonly withPermits: (
    permits: number,
    options?: AcquireOptions,
  ) => <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | LockLostError | SemaphoreBackingError | LockNotAcquiredError, R>
  readonly withPermitsIfAvailable: (
    permits: number,
    options?: AcquireOptions,
  ) => <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<Option.Option<A>, E | LockLostError | SemaphoreBackingError, R>
  readonly take: (
    permits: number,
    options?: AcquireOptions,
  ) => Effect.Effect<
    Fiber.Fiber<never, LockLostError | SemaphoreBackingError>,
    LockLostError | SemaphoreBackingError | LockNotAcquiredError,
    Scope.Scope
  >
  readonly tryTake: (
    permits: number,
    options?: AcquireOptions,
  ) => Effect.Effect<
    Option.Option<Fiber.Fiber<never, LockLostError | SemaphoreBackingError>>,
    LockLostError | SemaphoreBackingError,
    Scope.Scope
  >
  readonly currentCount: Effect.Effect<number, SemaphoreBackingError>
}

type FullyResolvedConfig = {
  limit: number
  ttl: Duration.Duration
  refreshInterval: Duration.Duration
  acquireRetryPolicy: Schedule.Schedule<unknown>
  backingFailureRetryPolicy: Schedule.Schedule<unknown>
}

const fullyResolveConfig = (config: DistributedSemaphoreConfig): FullyResolvedConfig => {
  const limit = config.limit ?? DEFAULT_LIMIT
  const ttl = config.ttl !== undefined ? Duration.fromInputUnsafe(config.ttl) : DEFAULT_TTL
  const refreshInterval =
    config.refreshInterval !== undefined
      ? Duration.fromInputUnsafe(config.refreshInterval)
      : Duration.millis(Duration.toMillis(ttl) / 3)
  const acquireRetryPolicy = config.acquireRetryPolicy ?? DEFAULT_ACQUIRE_RETRY_POLICY
  const backingFailureRetryPolicy = config.backingFailureRetryPolicy ?? DEFAULT_FAILURE_RETRY_POLICY

  return {
    limit,
    ttl,
    refreshInterval,
    acquireRetryPolicy,
    backingFailureRetryPolicy,
  }
}

/** Creates a distributed semaphore for a backing-store key. */
export const make = (
  key: string,
  config: DistributedSemaphoreConfig = {},
): Effect.Effect<DistributedSemaphore, never, DistributedSemaphoreBacking> =>
  Effect.gen(function* () {
    const backing = yield* DistributedSemaphoreBacking

    const { limit, ttl, refreshInterval, acquireRetryPolicy, backingFailureRetryPolicy } =
      fullyResolveConfig(config)

    const withBackingErrorRetry = <A, E extends { _tag: string }, R>(
      effect: Effect.Effect<A, E | SemaphoreBackingError, R>,
    ) =>
      effect.pipe(
        Effect.retry({
          while: (error) => error._tag === 'SemaphoreBackingError',
          schedule: backingFailureRetryPolicy,
        }),
      )

    const keepAlive = (
      identifier: string,
      permits: number,
    ): Effect.Effect<never, SemaphoreBackingError | LockLostError> =>
      Effect.repeat(
        Effect.gen(function* () {
          const refreshed = yield* backing
            .refresh(key, identifier, ttl, limit, permits)
            .pipe(withBackingErrorRetry)

          if (refreshed === false) {
            return yield* new LockLostError({ key })
          }
        }),
        Schedule.spaced(refreshInterval),
      ).pipe(
        Effect.andThen(Effect.die('Invariant violated: `keepAlive` should never return a value')),
      )

    const tryTake = (
      permits: number,
      options?: AcquireOptions,
    ): Effect.Effect<
      Option.Option<Fiber.Fiber<never, LockLostError | SemaphoreBackingError>>,
      SemaphoreBackingError,
      Scope.Scope
    > =>
      Effect.gen(function* () {
        const identifier = options?.identifier ?? crypto.randomUUID()
        const acquiredExternally = options?.acquiredExternally ?? false

        const acquired =
          acquiredExternally === true
            ? yield* backing
                .refresh(key, identifier, ttl, limit, permits)
                .pipe(withBackingErrorRetry)
            : yield* backing
                .tryAcquire(key, identifier, ttl, limit, permits)
                .pipe(withBackingErrorRetry)

        if (acquired === false) {
          return Option.none()
        }

        yield* Effect.addFinalizer(() =>
          backing.release(key, identifier, permits).pipe(withBackingErrorRetry, Effect.ignore),
        )
        const keepAliveFiber = yield* Effect.forkScoped(keepAlive(identifier, permits))

        return Option.some(keepAliveFiber)
      })

    const take = (
      permits: number,
      options?: AcquireOptions,
    ): Effect.Effect<
      Fiber.Fiber<never, LockLostError | SemaphoreBackingError>,
      SemaphoreBackingError | LockNotAcquiredError,
      Scope.Scope
    > =>
      Effect.gen(function* () {
        const identifier = options?.identifier ?? crypto.randomUUID()
        const resolvedOptions: AcquireOptions =
          options?.acquiredExternally === undefined
            ? { identifier }
            : { identifier, acquiredExternally: options.acquiredExternally }

        const acquireSemaphore = yield* Semaphore.make(1)
        const pushBasedAcquireEnabled = backing.onPermitsReleased !== undefined

        const pollBasedAcquire = Effect.gen(function* () {
          const maybeAcquired = yield* tryTake(permits, resolvedOptions).pipe(
            pushBasedAcquireEnabled === true
              ? Function.compose(
                  acquireSemaphore.withPermitsIfAvailable(1),
                  Effect.map(Option.flatten),
                )
              : Function.identity,
          )
          if (Option.isNone(maybeAcquired) === true) {
            return yield* new LockNotAcquiredError({ key })
          }
          return maybeAcquired.value
        }).pipe(
          Effect.retry({
            while: (error) =>
              error._tag === 'LockNotAcquiredError' && resolvedOptions.acquiredExternally !== true,
            schedule: acquireRetryPolicy,
          }),
        )

        if (pushBasedAcquireEnabled === false) {
          return yield* pollBasedAcquire
        }

        const pushBasedAcquire = Effect.gen(function* () {
          if (backing.onPermitsReleased === undefined) {
            return yield* Effect.die(
              'Invariant violated: `onPermitsReleased` is not provided when it was expected',
            )
          }
          return yield* backing.onPermitsReleased(key).pipe(
            Stream.mapEffect(() =>
              tryTake(permits, resolvedOptions).pipe(
                acquireSemaphore.withPermitsIfAvailable(1),
                Effect.map(Option.flatten),
              ),
            ),
            // Stop consuming release events as soon as a permit is acquired; the
            // backing stream can be long-lived (e.g. a filesystem watch) and the
            // acquired permit must not stay pinned inside an unfinished fold.
            Stream.takeUntil(Option.isSome),
            Stream.runLast,
            Effect.map(Option.flatten),
            Effect.flatMap(
              Option.match({
                onSome: Effect.succeed,
                onNone: () =>
                  Effect.die('Invariant violated: the stream should never return `None`'),
              }),
            ),
          )
        })

        return yield* Effect.race(pollBasedAcquire, pushBasedAcquire)
      })

    const withPermits =
      (permits: number, options?: AcquireOptions) =>
      <A, E, R>(
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E | LockLostError | SemaphoreBackingError | LockNotAcquiredError, R> =>
        Effect.scoped(
          Effect.gen(function* () {
            const keepAliveFiber = yield* take(permits, options)

            return yield* Effect.raceFirst(effect, Fiber.join(keepAliveFiber))
          }),
        )

    const withPermitsIfAvailable =
      (permits: number, options?: AcquireOptions) =>
      <A, E, R>(
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<Option.Option<A>, E | LockLostError | SemaphoreBackingError, R> =>
        Effect.scoped(
          Effect.gen(function* () {
            const maybeAcquired = yield* tryTake(permits, options)
            if (Option.isNone(maybeAcquired) === true) {
              return Option.none()
            }
            const keepAliveFiber = maybeAcquired.value
            return yield* Effect.raceFirst(effect.pipe(Effect.asSome), Fiber.join(keepAliveFiber))
          }),
        )

    const currentCount: Effect.Effect<number, SemaphoreBackingError> = backing
      .getCount(key, ttl)
      .pipe(withBackingErrorRetry)

    return {
      key,
      limit,
      withPermits,
      withPermitsIfAvailable,
      take,
      tryTake,
      currentCount,
    } satisfies DistributedSemaphore
  })
