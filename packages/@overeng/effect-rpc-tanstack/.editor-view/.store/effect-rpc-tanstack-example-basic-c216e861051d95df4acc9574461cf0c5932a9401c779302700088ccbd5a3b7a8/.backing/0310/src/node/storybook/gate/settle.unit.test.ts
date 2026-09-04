import { describe, expect, it } from 'vitest'

import { storySettleConfig } from './constants.ts'
import { type SettleEnvironment, type SettleRoot, settle } from './settle.ts'

/**
 * A fake clock, so a 20-second bound and a +1873ms arrival can be exercised in
 * microseconds. `sleep` advances time instead of waiting, which is what makes
 * the loop's timing decisions observable at all.
 */
const fakeEnvironment = ({
  msSinceLastResource = () => Number.POSITIVE_INFINITY,
  incompleteImages = () => 0,
}: {
  msSinceLastResource?: (nowMs: number) => number
  incompleteImages?: (nowMs: number) => number
} = {}): SettleEnvironment & { elapsed: () => number } => {
  let clock = 0
  return {
    now: () => clock,
    sleep: (ms) => {
      clock += ms
      return Promise.resolve()
    },
    msSinceLastResource: () => msSinceLastResource(clock),
    incompleteImages: () => incompleteImages(clock),
    elapsed: () => clock,
  }
}

/**
 * A root whose content arrives at `arrivesAtMs` and is quiet on either side of
 * it — the measured shape of the defect that motivated the settle signal. A map
 * attribution control mounts hidden and EMPTY, then populates from network
 * metadata at +1873ms, +8573ms, or not within 3300ms across three runs.
 */
const lateArrivingRoot = (environment: { now: () => number }, arrivesAtMs: number): SettleRoot => ({
  get innerHTML() {
    return environment.now() >= arrivesAtMs ? 'x'.repeat(2400) : 'x'.repeat(120)
  },
  querySelectorAll: () => ({ length: environment.now() >= arrivesAtMs ? 42 : 3 }),
})

describe('settle', () => {
  it('settles at the quiet floor on a genuinely static story', () => {
    // The cost case. Three quiet polls at 200ms is 600ms, and an ordinary story
    // should pay exactly that and no more.
    const environment = fakeEnvironment()
    const root: SettleRoot = { innerHTML: 'stable', querySelectorAll: () => ({ length: 7 }) }
    return settle({ root, environment }).then((outcome) => {
      expect({ settled: outcome.settled, elapsedMs: environment.elapsed() }).toEqual({
        settled: true,
        elapsedMs: 600,
      })
    })
  })

  it('does NOT settle on the empty state while the network is still working', async () => {
    // THE HOLE, and the reason `outstandingWork` exists. Between mount and
    // population the DOM is perfectly quiet, so a shape-only predicate is
    // satisfied at its 600ms floor and captures the EMPTY tree.
    //
    // That failure is worse than the flake it replaces: every capture reports as
    // settled AND self-consistent, because a reliably-empty capture is genuinely
    // deterministic. The nondeterminism vanishes by never capturing the content,
    // and a real change to that content becomes invisible.
    //
    // Here the resource timeline stays hot until the content lands, which is the
    // maplibre shape — the DOM mutates in response to a network arrival.
    const environment = fakeEnvironment({
      msSinceLastResource: (nowMs) => (nowMs < 1873 ? 0 : nowMs - 1873),
    })
    const root = lateArrivingRoot(environment, 1873)

    const outcome = await settle({ root, environment })

    expect({
      settled: outcome.settled,
      // Proves it waited PAST the arrival rather than stopping at the floor.
      capturedAfterArrival: environment.elapsed() >= 1873,
      // Both states are on the record, so the report can show what it waited for.
      sawEmptyThenPopulated: outcome.shapes,
    }).toEqual({
      settled: true,
      capturedAfterArrival: true,
      sawEmptyThenPopulated: ['3:120', '42:2400'],
    })
  })

  it('would have stopped at the floor without the outstanding-work gate', async () => {
    // The counterfactual, stated as a measurement rather than an argument: with
    // the network reported idle, the same root settles at 600ms on the EMPTY
    // shape and never sees the content. This is what the predicate did before.
    const environment = fakeEnvironment({ msSinceLastResource: () => Number.POSITIVE_INFINITY })
    const root = lateArrivingRoot(environment, 1873)

    const outcome = await settle({ root, environment })

    expect({ elapsedMs: environment.elapsed(), shapes: outcome.shapes }).toEqual({
      elapsedMs: 600,
      shapes: ['3:120'],
    })
  })

  it('waits for an image that has not finished loading', async () => {
    // An image completing changes pixels while leaving element count and markup
    // length untouched, so the shape predicate is blind to it in exactly the way
    // it is blind to a font swap.
    const environment = fakeEnvironment({ incompleteImages: (nowMs) => (nowMs < 1000 ? 1 : 0) })
    const root: SettleRoot = { innerHTML: 'stable', querySelectorAll: () => ({ length: 7 }) }

    const outcome = await settle({ root, environment })

    expect({ settled: outcome.settled, waitedPastImage: environment.elapsed() >= 1000 }).toEqual({
      settled: true,
      waitedPastImage: true,
    })
  })

  it('gives up at the bound and says the DOM never stopped moving', async () => {
    // A story that never settles must still be reportable. The reason has to
    // distinguish which wait failed, because "the DOM kept moving" and "the
    // network never drained" send whoever reads it to different fixes.
    const environment = fakeEnvironment()
    let tick = 0
    const root: SettleRoot = {
      get innerHTML() {
        tick += 1
        return 'x'.repeat(tick)
      },
      querySelectorAll: () => ({ length: 3 }),
    }

    const outcome = await settle({ root, environment })

    expect({
      settled: outcome.settled,
      reason: outcome.reason,
      boundedAt: environment.elapsed() >= storySettleConfig.boundMs,
    }).toEqual({ settled: false, reason: 'shape-never-quiet', boundedAt: true })
  })

  it('gives up at the bound and says the network never drained', async () => {
    // Distinct reason for a distinct cause: the DOM is perfectly still, and the
    // only thing stopping a verdict is work that never finishes.
    const environment = fakeEnvironment({ msSinceLastResource: () => 0 })
    const root: SettleRoot = { innerHTML: 'stable', querySelectorAll: () => ({ length: 7 }) }

    const outcome = await settle({ root, environment })

    expect({ settled: outcome.settled, reason: outcome.reason }).toEqual({
      settled: false,
      reason: 'work-never-drained',
    })
  })

  it('reports the shape history that explains why it never settled', async () => {
    // The history IS the diagnosis: a length oscillating between two values is
    // an alternating render, a monotonically growing one is content still
    // arriving. An exclusion whose cause is not in the channel is
    // indistinguishable from a story that vanished.
    const environment = fakeEnvironment()
    let tick = 0
    const root: SettleRoot = {
      get innerHTML() {
        tick += 1
        return 'x'.repeat(tick % 2 === 0 ? 10 : 20)
      },
      querySelectorAll: () => ({ length: 5 }),
    }

    const outcome = await settle({ root, environment })

    expect({
      settled: outcome.settled,
      alternating: [...new Set(outcome.shapes)].sort(),
    }).toEqual({ settled: false, alternating: ['5:10', '5:20'] })
  })
})
