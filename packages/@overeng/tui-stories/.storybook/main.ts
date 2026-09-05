import { resolve } from 'node:path'

import { createTuiStorybookConfig } from '@overeng/utils/node/storybook/config'

const config = createTuiStorybookConfig({
  stories: ['../src/**/*.stories.@(ts|tsx)'],
})

/* Resolve megarepo internal imports used by _megarepo-renders.ts.
   Vite alias ensures the imports work in both dev and production builds. */
const megarepoSrc = resolve(import.meta.dirname, '../node_modules/@overeng/megarepo/src')

export default {
  ...config,
  viteFinal: async (viteConfig: Record<string, unknown>) => {
    const existingViteFinal = (config as { viteFinal?: (c: unknown) => Promise<unknown> }).viteFinal
    const base = (
      existingViteFinal !== undefined ? await existingViteFinal(viteConfig) : viteConfig
    ) as Record<string, unknown>
    const baseResolve = (base.resolve ?? {}) as Record<string, unknown>
    const baseAlias = (baseResolve.alias ?? {}) as Record<string, unknown>
    return {
      ...base,
      resolve: {
        ...baseResolve,
        alias: { ...baseAlias, '@megarepo-internal': megarepoSrc },
      },
    }
  },
}
