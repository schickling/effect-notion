/**
 * Vitest setup file that installs the gate's project annotations.
 *
 * Referenced by `createStoryGateProject` as `test.setupFiles`; never imported
 * from Node.
 *
 * @module
 */

import { setProjectAnnotations } from 'storybook/internal/preview-api'
// oxlint-disable-next-line import/no-unresolved -- emitted by the Storybook Vite builder that `storybookTest` installs.
import { getProjectAnnotations } from 'virtual:/@storybook/builder-vite/project-annotations.js'
import { beforeAll } from 'vitest'

import { storyGateAnnotations } from './annotations.ts'

/**
 * Freeze motion before anything renders.
 *
 * The matcher waits for two consecutive identical frames, and a transition
 * firing once on mount straddles exactly that window. This is the measured
 * cause: on a component library, every `Button` variant failed while `Avatar`,
 * `Badge` and `Browser` passed, and Button at rest has no keyframe animation —
 * only `transition-colors duration-150`. So disabling transitions is the
 * load-bearing half; pausing animations alone would have looked like a fix
 * while leaving most stories failing.
 *
 * Injected at module scope, not from a hook: a style applied after a transition
 * has started freezes it at whatever point it reached, which is the
 * non-determinism being removed. Setup modules evaluate before any story
 * renders.
 *
 * Animations are made to FINISH rather than pause. Pausing freezes each one at
 * whatever frame it had reached when the style applied, which depends on when
 * the element mounted relative to injection — measured as 1-3 stories flapping
 * between otherwise identical runs on a package that was previously stable at
 * 0. Zero duration with a forwards fill lands every animation on its end state,
 * which is the same state on every run.
 *
 * Deliberately limited to motion. Caret blink is already handled by the
 * matcher's own `caret: 'hide'` screenshot option, and scroll behaviour was a
 * speculative addition on my part with no evidence behind it — an unevidenced
 * `!important` rule against every element is a liability, not insurance.
 *
 * This cannot reach canvas or JS-driven animation. Those stories should declare
 * `parameters.storyGate.unstable`, which excludes them visibly rather than
 * letting them rot in the pre-existing set.
 */
const freezeMotion = (): void => {
  const style = document.createElement('style')
  style.setAttribute('data-overeng-story-gate', 'freeze-motion')
  style.textContent = `*, *::before, *::after {
  transition: none !important;
  transition-duration: 0s !important;
  transition-delay: 0s !important;
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  animation-iteration-count: 1 !important;
  animation-fill-mode: forwards !important;
}`
  document.head.append(style)
}

freezeMotion()

/**
 * `setProjectAnnotations` replaces rather than merges, and the Storybook Vitest
 * addon calls it at module scope from its own setup file. Setup-file ordering
 * between the addon's injected entries and ours is decided by Vite's config
 * merge and is not ours to control — but every setup module is evaluated before
 * any hook runs, so re-composing from `beforeAll` puts the gate's layer last
 * regardless of that order.
 */
beforeAll(() => {
  const base = getProjectAnnotations()
  setProjectAnnotations([...(Array.isArray(base) === true ? base : [base]), storyGateAnnotations])
})
