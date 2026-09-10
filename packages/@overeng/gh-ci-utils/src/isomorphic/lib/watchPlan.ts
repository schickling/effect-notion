/**
 * Pure planning logic for watch loops.
 *
 * Watch ticks are the only place `gh-ci-utils` spends API budget in a loop, so
 * the decisions that control that spend live here as plain functions:
 *
 * - which jobs actually need their derived data (annotations, logs) re-fetched
 * - how long to sleep before the next tick
 * - what to do when the budget runs out
 *
 * Keeping them pure makes the cost model testable without network access.
 */

import { Context } from 'effect'

/** Minimal per-job identity that determines whether derived data is still valid. */
export interface JobFingerprint {
  readonly id: number
  readonly status: string
  readonly conclusion: string | null
}

/**
 * How the job set moved since the previous tick, in one pass.
 *
 * A job's annotations and logs are a function of its lifecycle state, so they
 * only change when `status`/`conclusion` change. `movedIds` collects those
 * jobs — and every unseen one, which always qualifies — while `changedCount`
 * counts only the ones that actually moved: a cold tick observes every job
 * but none of them moved, and counting them as changes would report a
 * phantom transition spike at t=0.
 */
export const diffJobs = ({
  previous,
  current,
}: {
  previous: ReadonlyMap<number, JobFingerprint>
  current: ReadonlyArray<JobFingerprint>
}): {
  /** Job ids whose derived data must be re-fetched this tick. */
  readonly movedIds: ReadonlySet<number>
  /** How many previously seen jobs changed state. */
  readonly changedCount: number
} => {
  const movedIds = new Set<number>()
  let changedCount = 0
  for (const job of current) {
    const prev = previous.get(job.id)
    if (prev === undefined) {
      movedIds.add(job.id)
    } else if (prev.status !== job.status || prev.conclusion !== job.conclusion) {
      movedIds.add(job.id)
      changedCount++
    }
  }
  return { movedIds, changedCount }
}

/**
 * Share of the remaining budget a single watch may spend over its horizon.
 * Below 1 so that concurrent watchers and follow-up commands still have room.
 */
export const BUDGET_RESERVE_FRACTION = 0.25

/** Tunables for {@link nextPollSeconds}. */
export interface PollPacing {
  readonly baseSeconds: number
  readonly maxSeconds: number
  /** Consecutive ticks in which no job changed state. */
  readonly idleTicks: number
  /** Requests the next tick is expected to bill. */
  readonly costPerTick: number
  /** Last observed remaining budget, or `undefined` when unknown. */
  readonly remaining: number | undefined
  /**
   * Seconds this watch still intends to poll for: its own remaining deadline,
   * capped by the budget reset (after which the bucket refills anyway).
   * `undefined` when the budget is unknown.
   */
  readonly horizonSeconds: number | undefined
  /** Share of the remaining budget this watch may spend over its horizon. */
  readonly reserveFraction: number
}

/**
 * Poll interval for the next tick.
 *
 * Two independent pressures, whichever is slower wins:
 *
 * 1. **Idle backoff** — nothing changed for N ticks, so double the interval
 *    (capped). Any state change resets `idleTicks` to 0 and the interval to base.
 * 2. **Budget pacing** — spread the affordable ticks across the horizon, so a
 *    long watch cannot spend the whole bucket in its first minutes. A healthy
 *    budget prices below the base interval and changes nothing.
 */
export const nextPollSeconds = ({
  baseSeconds,
  maxSeconds,
  idleTicks,
  costPerTick,
  remaining,
  horizonSeconds,
  reserveFraction,
}: PollPacing): number => {
  const backoff = Math.min(maxSeconds, baseSeconds * 2 ** idleTicks)

  if (remaining === undefined || horizonSeconds === undefined || costPerTick <= 0) {
    return backoff
  }

  const affordableTicks = Math.floor((remaining * reserveFraction) / costPerTick)
  if (affordableTicks <= 0) return Math.max(backoff, Math.max(0, horizonSeconds))

  return Math.min(maxSeconds, Math.max(backoff, horizonSeconds / affordableTicks))
}

/** What the client does about the budget before issuing the next request. */
export type BudgetOutcome =
  /** Budget is healthy (or unknown) — issue the request. */
  | { readonly _tag: 'Proceed' }
  /**
   * Budget is spent but its reset deadline has already passed, so the cached
   * numbers are stale: drop them and issue the request.
   */
  | { readonly _tag: 'ResetElapsed'; readonly remaining: number }
  /** Sleep `waitSeconds`, forget the numbers, then issue the request. */
  | {
      readonly _tag: 'Park'
      readonly waitSeconds: number
      readonly remaining: number
      readonly limit: number
      readonly reset: Date
    }
  /** Refuse: the bucket demands a longer wait than the caller allows. */
  | {
      readonly _tag: 'Fail'
      readonly waitSeconds: number
      readonly remaining: number
      readonly limit: number
      readonly reset: Date
    }

/** Seconds of slack added after a reset boundary to avoid racing GitHub's clock. */
export const RESET_SLACK_SECONDS = 2

/**
 * Decide what the client does about the budget before the next request.
 *
 * Reaching the reserve threshold is not an error: the budget refills at
 * `reset`, so the only correct responses are to park until then or — when
 * `reset` is already in the past — to treat the cached numbers as stale and
 * retry. Parking costs time and needs permission: a caller that owns a
 * deadline (the watch loop) passes what is left of it as `maxWaitSeconds`;
 * everyone else passes `null` and fails fast, because a one-shot command must
 * report a reset window (an hour for REST), not sleep through it.
 */
export const budgetOutcome = ({
  rateLimit,
  nowMs,
  threshold,
  maxWaitSeconds,
}: {
  rateLimit:
    | { readonly remaining: number; readonly limit: number; readonly reset: Date }
    | undefined
  nowMs: number
  threshold: number
  /** Seconds the caller may be parked for, or `null` to fail fast. */
  maxWaitSeconds: number | null
}): BudgetOutcome => {
  if (rateLimit === undefined) return { _tag: 'Proceed' }
  if (rateLimit.remaining >= threshold) return { _tag: 'Proceed' }

  const resetMs = rateLimit.reset.getTime()
  if (!Number.isFinite(resetMs) || resetMs <= nowMs) {
    return { _tag: 'ResetElapsed', remaining: rateLimit.remaining }
  }

  const wait = {
    waitSeconds: Math.ceil((resetMs - nowMs) / 1000) + RESET_SLACK_SECONDS,
    remaining: rateLimit.remaining,
    limit: rateLimit.limit,
    reset: rateLimit.reset,
  }
  return maxWaitSeconds !== null && wait.waitSeconds <= maxWaitSeconds
    ? { _tag: 'Park', ...wait }
    : { _tag: 'Fail', ...wait }
}

/**
 * How long the caller may be parked when its bucket is spent: the watch loop
 * provides the remainder of its `--timeout`; `null` — the default — reports a
 * spent bucket immediately instead of sleeping out a reset window.
 */
export type RateLimitWaitPolicy = number | null

/** Wait allowance in force for the current request. */
export const RateLimitWaitPolicy: Context.Reference<RateLimitWaitPolicy> =
  Context.Reference<RateLimitWaitPolicy>('gh-ci-utils/RateLimitWaitPolicy', {
    defaultValue: (): RateLimitWaitPolicy => null,
  })
