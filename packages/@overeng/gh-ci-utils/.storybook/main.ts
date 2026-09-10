import { createRequire } from 'node:module'
import { resolve } from 'node:path'

import { createTuiStorybookConfig } from '@overeng/utils/node/storybook/config'

const effectUtilsRoot = resolve(import.meta.dirname, '..', '..', '..', 'repos', 'effect-utils')

/** Resolve a package entry point from effect-utils node_modules (needed in CI where linked packages are in megarepo-store) */
const resolveFromEffectUtils = (pkg: string) => {
  try {
    return createRequire(resolve(effectUtilsRoot, 'package.json')).resolve(pkg)
  } catch {
    return pkg
  }
}

export default createTuiStorybookConfig({
  viteFinal: (config) => {
    config.resolve = {
      ...config.resolve,
      alias: {
        ...config.resolve?.alias,
        '@overeng/tui-core': resolve(effectUtilsRoot, 'packages/@overeng/tui-core/src/mod.ts'),
        'react-reconciler': resolveFromEffectUtils('react-reconciler'),
        'cli-truncate': resolveFromEffectUtils('cli-truncate'),
        'string-width': resolveFromEffectUtils('string-width'),
        'yoga-layout': resolveFromEffectUtils('yoga-layout'),
      },
    }
    return config
  },
})
