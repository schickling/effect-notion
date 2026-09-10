// oxlint-disable-next-line import/no-unassigned-import -- side-effect-only module: forces `process.stdout.isTTY` for consistent test output
import './global.ts'
import * as EffectVitest from '@effect/vitest'

import * as EnhancedVitest from './Vitest.ts'

/** @module Composes base @effect/vitest APIs with local testing helpers. */
export const Vitest: typeof EffectVitest & typeof EnhancedVitest = {
  ...EffectVitest,
  ...EnhancedVitest,
}
