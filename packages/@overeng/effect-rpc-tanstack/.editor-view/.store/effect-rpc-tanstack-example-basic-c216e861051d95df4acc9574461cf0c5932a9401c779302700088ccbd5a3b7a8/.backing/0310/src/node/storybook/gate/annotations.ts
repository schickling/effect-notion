/**
 * Browser-side project annotations that turn every story into a gate case.
 *
 * Applied by `./setup.ts`, which only ever runs under Vitest — the Storybook UI
 * never loads this module, so the `vitest/browser` import stays out of the
 * preview bundle.
 *
 * The readiness predicate itself lives in `./settle.ts`, which imports nothing
 * browser-only so its loop can be tested directly. This module supplies the real
 * browser environment for it and owns the reporting.
 *
 * @module
 */

import { expect } from 'vitest'
import { page } from 'vitest/browser'

import {
  excludedStoryMarker,
  settledStoryMarker,
  storySettleConfig,
  type StorySettleRecord,
  unsettledStoryMarker,
} from './constants.ts'
import { type SettleEnvironment, settle, shapeOf, summariseShapes } from './settle.ts'

/** Minimal shape of the story context the gate reads. */
interface GateStoryContext {
  readonly id: string
  readonly canvasElement: HTMLElement
  /** Component title, e.g. `Components/Select`. */
  readonly title?: string
  /** Story name, e.g. `With Error`. */
  readonly name?: string
  readonly parameters?: { readonly storyGate?: { readonly unstable?: boolean } }
}

/**
 * The only channel from the browser back to the runner.
 *
 * `console.info` rather than a return value because the story's outcome has to
 * reach a Node process that only sees this run's stdout and its JSON report, and
 * the JSON report has no field for "why this story was not compared".
 */
const emit = (line: string): void => {
  // eslint-disable-next-line no-console -- the only channel from the browser back to the runner.
  console.info(line)
}

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

/**
 * Wait for webfonts, bounded.
 *
 * Not redundant with the shape predicate: a font swap resizes exactly the
 * content-sized elements while leaving element count and markup length
 * untouched, so a pure reflow is invisible to the signature. This is a cheap
 * belt for packages that ship a webfont, not a claim that fonts are the cause
 * anywhere in particular.
 */
const fontsReady = async (): Promise<boolean> => {
  const fonts: FontFaceSet | undefined = document.fonts
  if (fonts === undefined) return true
  return await Promise.race([
    fonts.ready.then(() => true),
    sleep(storySettleConfig.fontsBoundMs).then(() => false),
  ])
}

/**
 * The real browser's answers to the predicate's questions.
 *
 * Network activity is read off the resource timeline rather than by patching
 * `fetch`/`XMLHttpRequest`: the gate runs inside Vitest's own browser client, and
 * monkey-patching the transport it communicates over would risk breaking every
 * run in order to fix a subset of them. The timeline is passive.
 */
const browserEnvironment = (root: HTMLElement): SettleEnvironment => ({
  now: () => Date.now(),
  sleep,
  msSinceLastResource: () => {
    // Structural rather than `PerformanceResourceTiming`: only these two fields
    // are read, and the full interface does not overlap `PerformanceEntryList`
    // closely enough for a direct assertion.
    const resources = performance.getEntriesByType('resource') as readonly {
      readonly startTime: number
      readonly responseEnd?: number
    }[]
    if (resources.length === 0) return Number.POSITIVE_INFINITY
    let latest = 0
    for (const entry of resources) {
      // A still-in-flight entry reports `responseEnd: 0`; its start time is the
      // honest lower bound on when it might finish, and treating it as recent
      // activity is the conservative reading.
      const end =
        entry.responseEnd === undefined || entry.responseEnd === 0
          ? entry.startTime
          : entry.responseEnd
      if (end > latest) latest = end
    }
    return performance.now() - latest
  },
  incompleteImages: () => {
    let incomplete = 0
    for (const image of root.querySelectorAll('img')) {
      if (image.complete === false) incomplete += 1
    }
    return incomplete
  },
})

/**
 * The two per-story gate behaviours whose ecosystem defaults fail silently.
 *
 * `parameters.a11y.test` defaults to `'todo'`, which downgrades every violation
 * to a warning — measured: an icon-only button with no accessible name passed.
 * `'error'` is the only value that fails the run.
 *
 * The screenshot assertion is ours because the Storybook Vitest addon has no
 * visual capability at all; its "visual tests" panel is a cloud service. The
 * story id is used as the screenshot name so the baseline filename set is a
 * faithful projection of the story index — which is what makes an added or
 * removed story detectable without a second source of truth.
 */
export const storyGateAnnotations = {
  parameters: { a11y: { test: 'error' } },
  afterEach: async (context: GateStoryContext): Promise<void> => {
    const name =
      context.title === undefined || context.name === undefined
        ? context.id
        : `${context.title} > ${context.name}`

    // Escape hatch for surfaces no wait can settle — a live WebGL canvas never
    // reaches a quiet DOM and never will. Without an explicit opt-out those
    // stories fail at the baseline, land in `preExisting`, and silently suppress
    // their own compare-side failures: the defect this gate was just fixed for,
    // reintroduced through a different door. Opting out takes the story out of
    // the visual comparison entirely and says so; render, play and accessibility
    // still run.
    //
    // Checked BEFORE the settle signal: a story declared unstable should not
    // spend the 20s bound proving what its author already stated.
    if (context.parameters?.storyGate?.unstable === true) {
      emit(`${excludedStoryMarker}${context.id}`)
      return
    }

    const started = Date.now()
    const environment = browserEnvironment(context.canvasElement)

    if ((await fontsReady()) === false) {
      const record: StorySettleRecord = {
        id: context.id,
        name,
        elapsedMs: Date.now() - started,
        shapes: [shapeOf(context.canvasElement)],
        reason: 'fonts-never-ready',
      }
      emit(`${unsettledStoryMarker}${JSON.stringify(record)}`)
      return
    }

    const outcome = await settle({ root: context.canvasElement, environment })
    const elapsedMs = Date.now() - started

    // Returning WITHOUT asserting is what keeps an unsettled story out of the
    // comparison cleanly. `toMatchScreenshot` is the only thing that resolves a
    // baseline path, and resolving a path is what enters a story in the run
    // manifest — so a story that never settles is absent from both sides rather
    // than half-present on one, and it cannot arrive in `preExisting` to
    // subtract a real failure later.
    if (outcome.settled === false) {
      const record: StorySettleRecord = {
        id: context.id,
        name,
        elapsedMs,
        shapes: summariseShapes(outcome.shapes),
        reason: outcome.reason ?? 'shape-never-quiet',
      }
      emit(`${unsettledStoryMarker}${JSON.stringify(record)}`)
      return
    }

    const record: StorySettleRecord = {
      id: context.id,
      name,
      elapsedMs,
      shapes: summariseShapes(outcome.shapes),
    }
    emit(`${settledStoryMarker}${JSON.stringify(record)}`)

    await expect(page.elementLocator(context.canvasElement)).toMatchScreenshot(context.id)
  },
}
