// @genie-bootstrap
import {
  catalog,
  exportEntry,
  packageJson,
  privatePackageDefaults,
  workspaceMember,
} from '../../../genie/internal.ts'
import tuiReactPkg from '../tui-react/package.json.genie.ts'
import utilsPkg from '../utils/package.json.genie.ts'

const peerDepNames = [
  '@effect/platform-node',
  '@opentui/core',
  '@opentui/react',
  'effect',
  'react',
  'react-dom',
  'react-reconciler',
] as const

const composition = catalog.compose({
  mode: 'install',
  workspace: workspaceMember({ memberPath: 'packages/@overeng/gh-ci-utils' }),
  dependencies: {
    workspace: [tuiReactPkg, utilsPkg],
  },
  devDependencies: {
    external: catalog.pick(
      ...peerDepNames,
      '@effect/vitest',
      '@storybook/react',
      '@storybook/react-vite',
      '@types/bun',
      '@types/node',
      '@types/react',
      '@types/react-reconciler',
      '@vitejs/plugin-react',
      'storybook',
      'typescript',
      'vite',
      'vitest',
    ),
  },
  peerDependencies: {
    external: catalog.pick(...peerDepNames),
  },
})

export default packageJson(
  {
    name: '@overeng/gh-ci-utils',
    ...privatePackageDefaults,
    exports: {
      '.': exportEntry('./src/mod.ts', { environment: 'node' }),
    },
    publishConfig: {
      access: 'public',
      bin: { 'gh-ci-utils': './dist/bin/gh-ci-utils.js' },
      exports: { '.': './dist/src/mod.js' },
    },
    dependenciesMeta: {
      '@overeng/tui-react': { injected: true },
    },
  },
  composition,
)
