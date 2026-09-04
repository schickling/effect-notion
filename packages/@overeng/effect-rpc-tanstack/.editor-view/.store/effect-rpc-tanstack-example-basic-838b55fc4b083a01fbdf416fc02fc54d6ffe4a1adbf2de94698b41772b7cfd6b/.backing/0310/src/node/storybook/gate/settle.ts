/**
 * The gate's readiness predicate, kept free of `vitest/browser` so the loop can
 * be tested without a browser.
 *
 * Split out of `./annotations.ts` for exactly that reason. This predicate
 * decides when every capture in the gate is taken, so "does it wait long
 * enough" is the most consequential question in the whole mechanism — and while
 * it lived inside the browser-only annotations it was answerable only by running
 * a full suite and inferring backwards from flake counts. A premature-settle
 * hole was found by reading, not by measurement, which is the wrong way round.
 *
 * @module
 */

import { storySettleConfig, type StorySettleFailure } from './constants.ts'

/** The part of an element the predicate reads. Narrowed so tests can fake it. */
export interface SettleRoot {
  readonly innerHTML: string
  querySelectorAll(selectors: string): { readonly length: number }
}

/**
 * Everything time- and platform-dependent the loop needs, injected so the loop
 * itself is exercisable directly.
 *
 * The loop is the part with the subtle failure mode, so it is the part that must
 * not require a browser to test.
 */
export interface SettleEnvironment {
  /** Milliseconds since a fixed origin. */
  now: () => number
  sleep: (ms: number) => Promise<void>
  /**
   * Milliseconds since the most recent network resource finished, or
   * `Number.POSITIVE_INFINITY` when none ever has.
   */
  msSinceLastResource: () => number
  /** Images inside the captured root that have not finished loading. */
  incompleteImages: () => number
}

/** Outcome of one story's wait. */
export interface SettleOutcome {
  readonly settled: boolean
  /** Distinct consecutive shapes observed, oldest first. */
  readonly shapes: readonly string[]
  /** Absent when the story settled. */
  readonly reason?: StorySettleFailure
}

/**
 * Structural signature of the subtree that is about to be captured.
 *
 * Element count catches additions and removals; markup length catches attribute
 * and text churn that leaves the count constant.
 *
 * Deliberately NOT computed-style or pixel based, and this is load-bearing
 * rather than an implementation detail. The predicate decides *when* to read, so
 * if it depended on *what* is read, the readiness check and the measurement
 * could agree with each other while both were wrong. Reusing the screenshot or a
 * style reader here is the trap.
 */
export const shapeOf = (root: SettleRoot): string =>
  `${root.querySelectorAll('*').length}:${root.innerHTML.length}`

/**
 * Keep a shape history readable without lying about its length.
 *
 * Both ends are kept because they answer different questions — the first shapes
 * say what the story started as, the last say what it was still doing when the
 * bound expired — and the elision states its own size rather than trailing off.
 */
export const summariseShapes = (shapes: readonly string[]): readonly string[] => {
  const keep = 6
  if (shapes.length <= keep * 2) return shapes
  return [
    ...shapes.slice(0, keep),
    `… ${shapes.length - keep * 2} more transitions elided …`,
    ...shapes.slice(-keep),
  ]
}

/**
 * Work outstanding that is known to change what gets captured.
 *
 * THE REASON THIS EXISTS, because without it the predicate has a hole that
 * looks like a fix. A quiet DOM is not evidence of a finished one. The defect
 * that motivated the settle signal was a map attribution control that mounts
 * hidden and EMPTY, then populates from network metadata at a measured +1873ms,
 * +8573ms, or not within 3300ms. Between mount and population the DOM is
 * perfectly quiet — so a shape-only predicate is satisfied at its ~600ms floor
 * and captures the empty state.
 *
 * That failure is worse than the flake it replaces. Every capture would report
 * as settled AND self-consistent, because a reliably-empty capture is genuinely
 * deterministic: the original nondeterminism vanishes by never capturing the
 * content at all, a real change to that content becomes invisible, and any story
 * whose population happened to land inside 600ms would flip-flop as before.
 *
 * So quiet is accepted only once nothing known-pending remains:
 *
 * - Recent network activity, read off the resource timeline rather than by
 *   patching `fetch`/`XMLHttpRequest`. The gate runs inside Vitest's own browser
 *   client, and monkey-patching the transport it communicates over risks
 *   breaking every run in order to fix a subset of them.
 * - Images not yet complete. An image finishing changes pixels while leaving
 *   element count and markup length untouched, so the shape predicate is blind
 *   to it in precisely the way it is blind to a font swap.
 *
 * NOT covered, stated rather than implied: a mutation driven by a pure timer
 * with no network or image activity behind it. Nothing short of waiting the full
 * bound can catch that, and the bound is the backstop.
 */
export const outstandingWork = ({
  environment,
  workQuietMs,
}: {
  environment: SettleEnvironment
  workQuietMs: number
}): number =>
  environment.incompleteImages() + (environment.msSinceLastResource() < workQuietMs ? 1 : 0)

/**
 * Poll the captured subtree until its shape repeats `quietPolls` times running
 * with no outstanding work, or the bound expires.
 *
 * Returns the outcome instead of throwing, because the caller has to RECORD
 * whether the story settled. That is the point of the mechanism and it matters
 * more than the waiting: a story that never settles is still named, counted and
 * attributable, which makes it an exclusion rather than a disappearance.
 */
export const settle = async ({
  root,
  environment,
  config = storySettleConfig,
}: {
  root: SettleRoot
  environment: SettleEnvironment
  config?: typeof storySettleConfig
}): Promise<SettleOutcome> => {
  const deadline = environment.now() + config.boundMs
  const shapes: string[] = []
  let previous: string | undefined
  let repeats = 0

  for (;;) {
    const current = shapeOf(root)
    const pending = outstandingWork({ environment, workQuietMs: config.workQuietMs })

    if (current !== previous) {
      previous = current
      shapes.push(current)
      repeats = 0
    } else if (pending > 0) {
      // The shape held still, but something in flight is known to change it.
      // Quiet under outstanding work is exactly the state that fooled the
      // frame-equality check this replaces, so the count restarts rather than
      // accruing towards a premature verdict.
      repeats = 0
    } else {
      repeats += 1
      if (repeats >= config.quietPolls) return { settled: true, shapes }
    }

    if (environment.now() >= deadline) {
      return {
        settled: false,
        shapes,
        // Distinguished so the report can say WHICH wait failed. "The DOM kept
        // moving" and "the network never went quiet" have different fixes, and
        // one reason covering both sends whoever reads it to the wrong one.
        reason: pending > 0 ? 'work-never-drained' : 'shape-never-quiet',
      }
    }
    // Sequential BY DESIGN. This is a poll: each iteration must observe the DOM
    // only after the previous wait elapsed, so the awaits cannot be gathered.
    // Concurrency here would sample the same frame repeatedly and satisfy
    // `quietPolls` without any time passing, which is precisely the
    // false-settled reading the shape count exists to prevent.
    //
    // The directive has to sit immediately above the statement: it is
    // `disable-next-line`, and with the explanation below it the "next line"
    // was another comment, so the suppression silently did nothing.
    // oxlint-disable-next-line eslint/no-await-in-loop
    await environment.sleep(config.pollIntervalMs)
  }
}
