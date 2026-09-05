// @genie-bootstrap
import {
  catalog,
  workspaceMember,
  exportEntry,
  packageJson,
  privatePackageDefaults,
} from '../../../genie/internal.ts'
import schemaFormPkg from '../effect-schema-form/package.json.genie.ts'
import stylexTokensPkg from '../stylex-tokens/package.json.genie.ts'
import utilsPkg from '../utils/package.json.genie.ts'

const peerDepNames = ['react-aria-components', 'react-dom'] as const
const runtimeDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/effect-schema-form-aria' }),
  dependencies: {
    workspace: [schemaFormPkg, stylexTokensPkg],
    external: catalog.pick('@stylexjs/stylex'),
  },
  devDependencies: {
    workspace: [utilsPkg],
    external: catalog.pick(
      'effect',
      '@storybook/react',
      // Story-gate stack; see @overeng/utils/node/storybook/gate.
      '@storybook/addon-a11y',
      '@storybook/addon-vitest',
      '@vitest/browser',
      '@vitest/browser-playwright',
      'playwright',
      '@storybook/react-vite',
      '@types/react',
      '@types/react-dom',
      '@vitejs/plugin-react',
      'storybook',
      'typescript',
      'vite',
      'vitest',
    ),
  },
  peerDependencies: {
    workspace: [schemaFormPkg],
    external: catalog.pick(...peerDepNames),
  },
})

export default packageJson(
  {
    name: '@overeng/effect-schema-form-aria',
    ...privatePackageDefaults,
    exports: {
      // `rootDir` is `./src`, so Buck emits declarations directly under `dist`.
      '.': exportEntry(
        { types: './dist/mod.d.ts', default: './src/mod.ts' },
        { environment: 'browser' },
      ),
      './styles.css': exportEntry('./src/styles.css', { environment: 'browser' }),
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': './dist/mod.js',
        './styles.css': './dist/styles.css',
      },
    },
    scripts: {
      build: 'tsc --build tsconfig.json && vite build',
      storybook: 'storybook dev -p 6010',
      'storybook:build': 'storybook build',
      // Reaches past `exports` on purpose: this runs the workspace source, and
      // the published `dist` entry is for consumers rather than for this script.
      gate: 'bun node_modules/@overeng/utils/src/node/storybook/gate/cli.ts',
    },
  },
  runtimeDeps,
)
