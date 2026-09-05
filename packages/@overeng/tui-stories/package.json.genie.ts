// @genie-bootstrap
import {
  catalog,
  workspaceMember,
  exportEntry,
  packageJson,
  privatePackageDefaults,
} from '../../../genie/internal.ts'
import megarepoPkg from '../megarepo/package.json.genie.ts'
import tuiReactPkg from '../tui-react/package.json.genie.ts'
import utilsDevPkg from '../utils-dev/package.json.genie.ts'
import utilsPkg from '../utils/package.json.genie.ts'

const ownPeerDepNames = ['effect'] as const

const runtimeDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/tui-stories' }),
  dependencies: {
    workspace: [tuiReactPkg, utilsPkg],
  },
  devDependencies: {
    workspace: [megarepoPkg, utilsDevPkg],
    external: {
      ...catalog.pick(
        ...ownPeerDepNames,
        '@effect/atom-react',
        '@effect/vitest',
        '@storybook/react',
        '@storybook/react-vite',
        '@types/node',
        '@types/react',
        'storybook',
        'typescript',
        'vitest',
      ),
    },
  },
  peerDependencies: {
    workspace: [utilsPkg, tuiReactPkg],
    external: catalog.pick(...ownPeerDepNames),
  },
  mode: 'install',
})

export default packageJson(
  {
    name: '@overeng/tui-stories',
    ...privatePackageDefaults,
    scripts: {
      storybook: 'storybook dev -p 6013',
      'storybook:build': 'storybook build',
    },
    exports: {
      '.': exportEntry(
        { types: './dist/src/mod.d.ts', default: './src/mod.ts' },
        { environment: 'node' },
      ),
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': './dist/mod.js',
      },
    },
    dependenciesMeta: {
      '@overeng/tui-react': { injected: true },
    },
  },
  runtimeDeps,
)
