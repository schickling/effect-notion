// @genie-bootstrap
import {
  catalog,
  workspaceMember,
  exportEntry,
  packageJson,
  privatePackageDefaults,
} from '../../../genie/internal.ts'
import effectPathPkg from '../effect-path/package.json.genie.ts'
import notionDatasourceSyncPkg from '../notion-datasource-sync/package.json.genie.ts'
import notionEffectClientPkg from '../notion-effect-client/package.json.genie.ts'
import notionEffectSchemaPkg from '../notion-effect-schema/package.json.genie.ts'
import notionMdPkg from '../notion-md/package.json.genie.ts'
import otelContractPkg from '../otel-contract/package.json.genie.ts'
import tuiCorePkg from '../tui-core/package.json.genie.ts'
import tuiReactPkg from '../tui-react/package.json.genie.ts'
import utilsDevPkg from '../utils-dev/package.json.genie.ts'
import utilsPkg from '../utils/package.json.genie.ts'

const runtimeDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/notion-cli' }),
  dependencies: {
    workspace: [
      effectPathPkg,
      notionDatasourceSyncPkg,
      notionMdPkg,
      notionEffectClientPkg,
      notionEffectSchemaPkg,
      tuiCorePkg,
      otelContractPkg,
      tuiReactPkg,
      utilsPkg,
    ],
  },
  devDependencies: {
    workspace: [utilsDevPkg],
    external: {
      ...catalog.pick(
        '@effect/atom-react',
        '@effect/vitest',
        '@storybook/react',
        '@storybook/react-vite',
        '@types/node',
        '@types/react',
        '@vitejs/plugin-react',
        'storybook',
        'typescript',
        'vite',
        'vitest',
      ),
    },
  },
  peerDependencies: {
    workspace: [utilsPkg, tuiReactPkg],
  },
  mode: 'install',
})

export default packageJson(
  {
    name: '@overeng/notion-cli',
    ...privatePackageDefaults,
    scripts: {
      storybook: 'storybook dev -p 6012',
      'storybook:build': 'storybook build',
    },
    exports: {
      '.': exportEntry(
        { types: './dist/src/mod.d.ts', default: './src/mod.ts' },
        { environment: 'node' },
      ),
      './config': exportEntry(
        { types: './dist/src/config-def.d.ts', default: './src/config-def.ts' },
        { environment: 'node' },
      ),
    },
    publishConfig: {
      access: 'public',
      bin: {
        notion: './dist/cli.js',
      },
      exports: {
        '.': './dist/mod.js',
        './config': './dist/config-def.js',
      },
    },
    dependenciesMeta: {
      '@overeng/tui-react': { injected: true },
    },
  },
  runtimeDeps,
)
