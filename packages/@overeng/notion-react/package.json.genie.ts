// @genie-bootstrap
import {
  catalog,
  workspaceMember,
  exportEntry,
  packageJson,
  privatePackageDefaults,
  type PackageJsonInputData,
} from '../../../genie/internal.ts'
import notionEffectClientPkg from '../notion-effect-client/package.json.genie.ts'
import notionEffectSchemaPkg from '../notion-effect-schema/package.json.genie.ts'
import notionMdPkg from '../notion-md/package.json.genie.ts'
import otelContractPkg from '../otel-contract/package.json.genie.ts'
import utilsDevPkg from '../utils-dev/package.json.genie.ts'
import utilsPkg from '../utils/package.json.genie.ts'

const peerDepNames = ['effect', 'react', 'react-reconciler'] as const
const optionalPeerDepNames = ['@opentelemetry/api', 'katex', 'shiki'] as const

const workspaceDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/notion-react' }),
  dependencies: {
    workspace: [notionEffectClientPkg, notionEffectSchemaPkg, otelContractPkg],
  },
  devDependencies: {
    workspace: [notionMdPkg, utilsDevPkg, utilsPkg],
    external: {
      ...catalog.pick(
        ...peerDepNames,
        ...optionalPeerDepNames,
        '@effect/vitest',
        '@storybook/react',
        '@storybook/react-vite',
        '@types/katex',
        '@types/node',
        '@types/react',
        '@types/react-dom',
        '@types/react-reconciler',
        'react-dom',
        'storybook',
        'typescript',
        'vite',
        'vitest',
      ),
    },
  },
  peerDependencies: {
    external: catalog.pick(...peerDepNames, ...optionalPeerDepNames),
  },
  mode: 'install',
})

export default packageJson(
  {
    name: '@overeng/notion-react',
    ...privatePackageDefaults,
    exports: {
      '.': exportEntry(
        { types: './dist/src/mod.d.ts', default: './src/mod.ts' },
        { environment: 'node' },
      ),
      './markdown': exportEntry(
        { types: './dist/src/markdown/mod.d.ts', default: './src/markdown/mod.ts' },
        { environment: 'node' },
      ),
      './renderer': exportEntry(
        { types: './dist/src/renderer/mod.d.ts', default: './src/renderer/mod.ts' },
        { environment: 'browser' },
      ),
      './o11y': exportEntry(
        { types: './dist/src/o11y/mod.d.ts', default: './src/o11y/mod.ts' },
        { environment: 'browser' },
      ),
      './o11y/effect': exportEntry(
        { types: './dist/src/o11y/effect-adapter.d.ts', default: './src/o11y/effect-adapter.ts' },
        { environment: 'browser' },
      ),
      './o11y/otel': exportEntry(
        { types: './dist/src/o11y/otel-adapter.d.ts', default: './src/o11y/otel-adapter.ts' },
        { environment: 'browser' },
      ),
      './test': exportEntry('./src/test/integration/e2e/helpers.ts', {
        environment: 'node',
        published: false,
      }),
      './web': exportEntry(
        { types: './dist/src/web/mod.d.ts', default: './src/web/mod.ts' },
        { environment: 'browser' },
      ),
      './web/styles.css': exportEntry('./src/web/styles.css', { environment: 'browser' }),
      './web/katex.css': exportEntry('./src/web/katex.css', { environment: 'browser' }),
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': './dist/mod.js',
        './markdown': './dist/markdown/mod.js',
        './renderer': './dist/renderer/mod.js',
        './o11y': './dist/o11y/mod.js',
        './o11y/effect': './dist/o11y/effect-adapter.js',
        './o11y/otel': './dist/o11y/otel-adapter.js',
        './web': './dist/web/mod.js',
        './web/styles.css': './dist/web/styles.css',
        './web/katex.css': './dist/web/katex.css',
      },
    },
    peerDependenciesMeta: {
      '@opentelemetry/api': { optional: true },
      katex: { optional: true },
      shiki: { optional: true },
    },
    scripts: {
      storybook: 'storybook dev -p 6014',
      'storybook:build': 'storybook build',
      // Integration + e2e tests hit the live Notion API. Both require
      // `NOTION_API_TOKEN` and `NOTION_TEST_PARENT_PAGE_ID` (tests skip silently
      // when either is missing). Load the package-local `devenv.local.nix` through devenv or run `op-proxy` inline. See helpers.ts for details.
      'test:integration': 'vitest run --config vitest.integration.config.ts',
      'test:integration:e2e': 'vitest run --config vitest.integration.config.ts e2e',
    },
  } satisfies PackageJsonInputData,
  workspaceDeps,
)
