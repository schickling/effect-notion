// @genie-bootstrap
import {
  catalog,
  workspaceMember,
  exportEntry,
  packageJson,
  privatePackageDefaults,
  type PackageJsonInputData,
} from '../../../genie/internal.ts'
import contentAddressPkg from '../content-address/package.json.genie.ts'
import notionCorePkg from '../notion-core/package.json.genie.ts'
import notionEffectClientPkg from '../notion-effect-client/package.json.genie.ts'
import notionEffectSchemaPkg from '../notion-effect-schema/package.json.genie.ts'
import notionPropertyWritePkg from '../notion-property-write/package.json.genie.ts'
import otelContractPkg from '../otel-contract/package.json.genie.ts'
import tuiReactPkg from '../tui-react/package.json.genie.ts'
import utilsDevPkg from '../utils-dev/package.json.genie.ts'
import utilsPkg from '../utils/package.json.genie.ts'

const peerDepNames = [
  '@effect/opentelemetry',
  '@effect/platform-node',
  '@playwright/test',
  'effect',
] as const

const workspaceDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/notion-md' }),
  dependencies: {
    workspace: [
      contentAddressPkg,
      notionCorePkg,
      notionEffectClientPkg,
      notionEffectSchemaPkg,
      notionPropertyWritePkg,
      otelContractPkg,
      utilsPkg,
    ],
  },
  devDependencies: {
    workspace: [tuiReactPkg, utilsDevPkg],
    external: {
      ...catalog.pick(
        ...peerDepNames,
        '@effect/atom-react',
        '@effect/vitest',
        '@storybook/react',
        '@storybook/react-vite',
        '@types/node',
        '@types/react',
        '@types/react-reconciler',
        '@vitejs/plugin-react',
        'react',
        'react-dom',
        'react-reconciler',
        'storybook',
        'typescript',
        'vite',
        'vitest',
      ),
    },
  },
  peerDependencies: {
    external: catalog.pick(...peerDepNames),
  },
})

export default packageJson(
  {
    name: '@overeng/notion-md',
    ...privatePackageDefaults,
    exports: {
      '.': exportEntry(
        { types: './dist/src/mod.d.ts', default: './src/mod.ts' },
        { environment: 'node' },
      ),
      './cli': exportEntry(
        { types: './dist/src/cli.d.ts', default: './src/cli.ts' },
        { environment: 'node' },
      ),
      './cli-program': exportEntry(
        { types: './dist/src/cli-program.d.ts', default: './src/cli-program.ts' },
        { environment: 'node' },
      ),
    },
    scripts: {
      storybook: 'storybook dev -p 6015',
      'storybook:build': 'storybook build',
      'test:integration': 'vitest run --config vitest.integration.config.ts',
    },
    publishConfig: {
      access: 'public',
      bin: {
        'notion-md': './dist/src/cli.js',
      },
      exports: {
        '.': './dist/src/mod.js',
        './cli': './dist/src/cli.js',
        './cli-program': './dist/src/cli-program.js',
      },
    },
  } satisfies PackageJsonInputData,
  workspaceDeps,
)
