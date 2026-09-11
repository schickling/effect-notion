import { theme as chromeDark } from './chromeDark.tsx'
import { theme as chromeLight } from './chromeLight.tsx'

export { chromeDark, chromeLight }

/**
 * Explicit record of the built-in themes, keyed by theme name. Prefer this over
 * indexing the module namespace so that lookups by name are statically checkable.
 */
export const themes = { chromeDark, chromeLight }
