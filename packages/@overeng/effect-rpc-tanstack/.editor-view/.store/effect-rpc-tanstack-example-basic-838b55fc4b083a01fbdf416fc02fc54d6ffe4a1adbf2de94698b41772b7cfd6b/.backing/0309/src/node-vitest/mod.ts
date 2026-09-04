// oxlint-disable-next-line eslint-plugin-import(no-unassigned-import) -- side-effect import for TTY setup
import './global.ts'
import * as EffectVitest from '@effect/vitest'

import * as EnhancedVitest from './Vitest.ts'

/** @module Composes base @effect/vitest APIs with local testing helpers. */
export const Vitest: typeof EffectVitest & typeof EnhancedVitest = {
  ...EffectVitest,
  ...EnhancedVitest,
}
