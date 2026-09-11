// @genie-bootstrap
import {
  catalog,
  workspaceMember,
  exportEntry,
  packageJson,
  privatePackageDefaults,
} from '../../../genie/internal.ts'
import effectPathPkg from '../effect-path/package.json.genie.ts'
import kdlEffectPkg from '../kdl-effect/package.json.genie.ts'
import kdlPkg from '../kdl/package.json.genie.ts'
import otelContractPkg from '../otel-contract/package.json.genie.ts'
import tuiCorePkg from '../tui-core/package.json.genie.ts'
import tuiReactPkg from '../tui-react/package.json.genie.ts'
import utilsDevPkg from '../utils-dev/package.json.genie.ts'
import utilsPkg from '../utils/package.json.genie.ts'

const peerDepNames = ['@effect/platform-node', 'effect'] as const

const runtimeDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/megarepo' }),
  dependencies: {
    workspace: [effectPathPkg, kdlPkg, kdlEffectPkg, otelContractPkg, tuiReactPkg, utilsPkg],
    external: catalog.pick('react'),
  },
  devDependencies: {
    workspace: [tuiCorePkg, utilsDevPkg],
    external: {
      ...catalog.pick(
        ...peerDepNames,
        '@effect/atom-react',
        '@effect/vitest',
        '@types/bun',
        '@types/node',
        '@types/react',
        'vitest',
        'storybook',
        '@storybook/react',
        '@storybook/react-vite',
        '@xterm/xterm',
        '@xterm/addon-fit',
        'react-dom',
        'react-reconciler',
        'typescript',
        'vite',
        '@vitejs/plugin-react',
      ),
    },
  },
  peerDependencies: {
    workspace: [utilsPkg, tuiReactPkg],
    external: catalog.pick(...peerDepNames),
  },
  mode: 'install',
})

export default packageJson(
  {
    name: '@overeng/megarepo',
    ...privatePackageDefaults,
    scripts: {
      storybook: 'storybook dev -p 6007',
      'storybook:build': 'storybook build',
    },
    exports: {
      '.': exportEntry(
        { types: './dist/src/mod.d.ts', default: './src/mod.ts' },
        { environment: 'node' },
      ),
      './buck2-manifest': exportEntry(
        { types: './dist/src/buck2-manifest.d.ts', default: './src/buck2-manifest.ts' },
        { environment: 'node' },
      ),
      './cli': exportEntry(
        { types: './dist/src/cli/mod.d.ts', default: './src/cli/mod.ts' },
        { environment: 'node' },
      ),
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': './dist/mod.js',
        './buck2-manifest': './dist/buck2-manifest.js',
        './cli': './dist/cli.js',
      },
    },
    dependenciesMeta: {
      '@overeng/tui-react': { injected: true },
    },
  },
  runtimeDeps,
)
