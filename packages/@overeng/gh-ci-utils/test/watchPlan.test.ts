import { describe, expect, it } from 'vitest'

import {
  type JobFingerprint,
  RESET_SLACK_SECONDS,
  budgetOutcome,
  diffJobs,
  nextPollSeconds,
  statusPollState,
} from '../src/isomorphic/lib/watchPlan.ts'

const job = (id: number, status: string, conclusion: string | null = null): JobFingerprint => ({
  id,
  status,
  conclusion,
})

const index = (jobs: ReadonlyArray<JobFingerprint>) => new Map(jobs.map((j) => [j.id, j] as const))

describe('diffJobs', () => {
  it('marks every job on a cold tick as needing refresh but counts none as changed', () => {
    const current = [job(1, 'queued'), job(2, 'in_progress')]
    const { movedIds, changedCount } = diffJobs({ previous: new Map(), current })
    expect([...movedIds]).toEqual([1, 2])
    expect(changedCount).toBe(0)
  })

  it('marks nothing when no job moved', () => {
    const jobs = [job(1, 'in_progress'), job(2, 'completed', 'success')]
    expect(diffJobs({ previous: index(jobs), current: jobs }).movedIds.size).toBe(0)
  })

  it('marks new and changed jobs, counting only the changes', () => {
    const previous = index([job(1, 'queued'), job(2, 'in_progress'), job(3, 'in_progress')])
    const current = [
      job(1, 'in_progress'),
      job(2, 'completed', 'failure'),
      job(3, 'in_progress'),
      job(4, 'queued'),
    ]
    const { movedIds, changedCount } = diffJobs({ previous, current })
    expect([...movedIds]).toEqual([1, 2, 4])
    expect(changedCount).toBe(2)
  })
})

describe('statusPollState', () => {
  it('waits for completed job timestamps before finalizing a completed run', () => {
    const jobs = [{ status: 'completed', completedAt: null }]

    expect(statusPollState({ runStatus: 'in_progress', jobs })).toBe('active')
    expect(statusPollState({ runStatus: 'completed', jobs })).toBe('awaiting-job-finalization')
    expect(
      statusPollState({
        runStatus: 'completed',
        jobs: [{ status: 'completed', completedAt: '2026-09-13T10:00:05.000Z' }],
      }),
    ).toBe('complete')
  })

  it.each(['queued', 'in_progress'])(
    'waits when a completed run still has a stale %s job',
    (status) => {
      expect(
        statusPollState({
          runStatus: 'completed',
          jobs: [{ status, completedAt: null }],
        }),
      ).toBe('awaiting-job-finalization')
    },
  )
})

describe('nextPollSeconds', () => {
  const healthy = {
    baseSeconds: 5,
    maxSeconds: 40,
    costPerTick: 2,
    remaining: 4000,
    horizonSeconds: 1800,
    reserveFraction: 0.25,
  }

  it('polls at the base interval while jobs are moving and budget is healthy', () => {
    expect(nextPollSeconds({ ...healthy, idleTicks: 0 })).toBe(5)
  })

  it('doubles while idle and stops at the ceiling', () => {
    expect(nextPollSeconds({ ...healthy, idleTicks: 1 })).toBe(10)
    expect(nextPollSeconds({ ...healthy, idleTicks: 2 })).toBe(20)
    expect(nextPollSeconds({ ...healthy, idleTicks: 3 })).toBe(40)
    expect(nextPollSeconds({ ...healthy, idleTicks: 9 })).toBe(40)
  })

  it('lets idle backoff reach maxSeconds, the single ceiling', () => {
    expect(nextPollSeconds({ ...healthy, idleTicks: 6, maxSeconds: 300 })).toBe(300)
  })

  it('stretches the interval so the affordable ticks cover the watch horizon', () => {
    /** 1000 remaining * 0.25 / 26 per tick = 9 ticks across a 30-minute watch. */
    expect(nextPollSeconds({ ...healthy, idleTicks: 0, costPerTick: 26, remaining: 1000 })).toBe(40)
    expect(
      nextPollSeconds({
        ...healthy,
        idleTicks: 0,
        costPerTick: 26,
        remaining: 1000,
        maxSeconds: 600,
      }),
    ).toBe(200)
  })

  it('falls back to plain backoff when the budget is unknown', () => {
    expect(
      nextPollSeconds({
        ...healthy,
        idleTicks: 1,
        remaining: undefined,
        horizonSeconds: undefined,
      }),
    ).toBe(10)
  })
})

describe('budgetOutcome', () => {
  const nowMs = Date.parse('2026-09-03T10:00:00Z')
  const reset = new Date(nowMs + 90_000)
  const spent = { remaining: 3, limit: 5000, reset }

  it('proceeds while the bucket is above the reserve, or nothing is known about it yet', () => {
    expect(
      budgetOutcome({
        rateLimit: { remaining: 500, limit: 5000, reset },
        nowMs,
        threshold: 25,
        maxWaitSeconds: null,
      }),
    ).toEqual({ _tag: 'Proceed' })
    expect(
      budgetOutcome({ rateLimit: undefined, nowMs, threshold: 25, maxWaitSeconds: 300 }),
    ).toEqual({ _tag: 'Proceed' })
  })

  it('treats an already-elapsed reset as stale numbers and proceeds (FB-649)', () => {
    expect(
      budgetOutcome({
        rateLimit: { remaining: 0, limit: 11450, reset: new Date(nowMs - 1_000) },
        nowMs,
        threshold: 25,
        maxWaitSeconds: null,
      }),
    ).toEqual({ _tag: 'ResetElapsed', remaining: 0 })
  })

  it('fails fast on a spent bucket when the caller has no wait to spare — the default policy', () => {
    expect(budgetOutcome({ rateLimit: spent, nowMs, threshold: 25, maxWaitSeconds: null })).toEqual(
      {
        _tag: 'Fail',
        waitSeconds: 90 + RESET_SLACK_SECONDS,
        remaining: 3,
        limit: 5000,
        reset,
      },
    )
  })

  it('parks when the wait fits inside the deadline the caller owns', () => {
    expect(budgetOutcome({ rateLimit: spent, nowMs, threshold: 25, maxWaitSeconds: 92 })).toEqual({
      _tag: 'Park',
      waitSeconds: 90 + RESET_SLACK_SECONDS,
      remaining: 3,
      limit: 5000,
      reset,
    })
  })

  it('fails when the wait would outlive the deadline the caller owns', () => {
    expect(budgetOutcome({ rateLimit: spent, nowMs, threshold: 25, maxWaitSeconds: 91 })).toEqual({
      _tag: 'Fail',
      waitSeconds: 90 + RESET_SLACK_SECONDS,
      remaining: 3,
      limit: 5000,
      reset,
    })
  })
})

/**
 * Cost model for one watch tick, exercised against the fan-out rule rather
 * than the network: `2` fixed requests (run + job list) plus one *billed*
 * request per job whose derived data changed. Annotations are requested for
 * every job on every tick, but an unchanged set answers `304`, which GitHub
 * does not bill.
 */
const billedRequestsPerTick = ({
  previous,
  current,
  gated,
}: {
  previous: ReadonlyMap<number, JobFingerprint>
  current: ReadonlyArray<JobFingerprint>
  gated: boolean
}) => 2 + (gated ? diffJobs({ previous, current }).movedIds.size : current.length)

describe('watch tick cost', () => {
  const jobs = Array.from({ length: 24 }, (_, i) => job(i + 1, 'in_progress'))

  it('bills one request per job per tick without change gating', () => {
    expect(billedRequestsPerTick({ previous: index(jobs), current: jobs, gated: false })).toBe(26)
  })

  it('bills only the fixed pair on a tick where nothing moved', () => {
    expect(billedRequestsPerTick({ previous: index(jobs), current: jobs, gated: true })).toBe(2)
  })

  it('bills the fixed pair plus the jobs that actually moved', () => {
    const current = [
      job(1, 'completed', 'success'),
      job(2, 'completed', 'failure'),
      ...jobs.slice(2),
    ]
    expect(billedRequestsPerTick({ previous: index(jobs), current, gated: true })).toBe(4)
  })
})
