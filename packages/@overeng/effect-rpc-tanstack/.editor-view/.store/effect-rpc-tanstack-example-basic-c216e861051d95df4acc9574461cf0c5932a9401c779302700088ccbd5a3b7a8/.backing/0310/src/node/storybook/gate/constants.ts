/**
 * Values shared between the browser-side annotations and the Node-side runner.
 *
 * Its own module because it has no imports: the annotations pull in
 * `vitest/browser`, which throws outside Browser Mode, and the runner pulls in
 * `node:child_process`. Neither can import the other.
 *
 * @module
 */

/**
 * Marker the runner greps out of a run's output to report stories that opted
 * out of visual comparison by DECLARATION, via `parameters.storyGate.unstable`.
 *
 * Kept distinct from {@link unsettledStoryMarker} because the two exclusions
 * mean opposite things about who decided. This one is a reviewed choice
 * recorded in source; that one is an observation the harness made about a story
 * nobody declared. Collapsing them would let an unreviewed exclusion hide
 * inside a list of reviewed ones.
 */
export const excludedStoryMarker = '[story-gate] excluded '

/**
 * Marker for a story that reached a quiet DOM, carrying what the wait cost.
 *
 * Emitted on the success path on purpose. The liveness rule this gate keeps
 * relearning is that a pass signal defined as the absence of a failure marker
 * cannot tell "everything settled" from "nothing ran" — a harness that never
 * launched a browser produces zero unsettled markers and looks perfect. A
 * positive per-story record makes the settled count a measurement rather than
 * an inference from silence, and it carries the cost distribution the bound
 * would otherwise hide.
 */
export const settledStoryMarker = '[story-gate] settled '

/**
 * Marker for a story that never reached a quiet DOM within the bound.
 *
 * Carries the reason and the observed shape history, because an exclusion whose
 * cause is not in the channel is indistinguishable from a story that vanished.
 * The history is the diagnosis: a length oscillating between two values is an
 * alternating render, while a monotonically growing one is content still
 * arriving.
 */
export const unsettledStoryMarker = '[story-gate] unsettled '

/**
 * The settle signal's parameters.
 *
 * Lifted from a harness where they were measured rather than chosen, so the
 * numbers carry evidence:
 *
 * - `quietPolls: 3`. One repeat is satisfied by any gap between two async
 *   arrivals, which is exactly the failure of the frame-equality check this
 *   replaces. Three readings at `pollIntervalMs` spacing is 400ms of *measured*
 *   quiet, the same budget the fixed delay it replaces spent hoping.
 * - `pollIntervalMs: 200`. Below ~100ms the round-trip into the page dominates;
 *   above ~300ms cheap stories pay for nothing.
 * - `boundMs: 20_000`. Sized to clear a measured +8573ms worst case with
 *   headroom. This is a BOUND, NOT A TARGET: an ordinary story satisfies the
 *   predicate on its first three polls at ~600ms, so the ceiling is only ever
 *   spent where something is genuinely outstanding. Do not read it as per-story
 *   cost.
 * - `fontsBoundMs: 5_000`. Fonts are served by the local dev server, so this is
 *   generous. Bounded rather than awaited outright because an unbounded wait on
 *   a font that never loads surfaces as an opaque test timeout, and a verdict
 *   channel that cannot state its own cause is the defect this gate exists to
 *   remove.
 * - `workQuietMs: 600`. How long the network must have been idle before a quiet
 *   DOM is believed. Exists because quiet is NOT evidence of finished: the
 *   motivating control mounts empty and populates at +1873ms, and a shape-only
 *   predicate is satisfied at its 600ms floor and captures the empty state.
 *   Matched to the DOM quiet budget so the two conditions demand the same
 *   evidence.
 */
export const storySettleConfig = {
  quietPolls: 3,
  pollIntervalMs: 200,
  boundMs: 20_000,
  fontsBoundMs: 5_000,
  workQuietMs: 600,
} as const

/** Why a story was excluded from visual comparison by observation. */
export type StorySettleFailure =
  | 'shape-never-quiet'
  | 'fonts-never-ready'
  /** The DOM held still, but the network never stopped delivering. */
  | 'work-never-drained'

/** One story's settle outcome, as carried across the console channel. */
export interface StorySettleRecord {
  /** Storybook story id — the screenshot name, so it keys the baseline files. */
  readonly id: string
  /** `<title> > <name>`, which is how a human refers to the story. */
  readonly name: string
  readonly elapsedMs: number
  /** Distinct consecutive shapes observed, oldest first. */
  readonly shapes: readonly string[]
  /** Absent when the story settled. */
  readonly reason?: StorySettleFailure
}
