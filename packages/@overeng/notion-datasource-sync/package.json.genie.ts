// @genie-bootstrap
import {
  catalog,
  exportEntry,
  packageJson,
  privatePackageDefaults,
  workspaceMember,
  type PackageJsonInputData,
} from '../../../genie/internal.ts'
import contentAddressPkg from '../content-address/package.json.genie.ts'
import notionCorePkg from '../notion-core/package.json.genie.ts'
import notionEffectClientPkg from '../notion-effect-client/package.json.genie.ts'
import notionEffectSchemaPkg from '../notion-effect-schema/package.json.genie.ts'
import notionMdPkg from '../notion-md/package.json.genie.ts'
import notionPropertyWritePkg from '../notion-property-write/package.json.genie.ts'
import otelContractPkg from '../otel-contract/package.json.genie.ts'
import tuiReactPkg from '../tui-react/package.json.genie.ts'
import utilsPkg from '../utils/package.json.genie.ts'

const peerDepNames = [
  '@effect/opentelemetry',
  '@effect/platform-node',
  '@playwright/test',
  'effect',
] as const

const workspaceDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/notion-datasource-sync' }),
  dependencies: {
    workspace: [
      contentAddressPkg,
      notionCorePkg,
      notionEffectClientPkg,
      notionEffectSchemaPkg,
      notionMdPkg,
      notionPropertyWritePkg,
      otelContractPkg,
      tuiReactPkg,
      utilsPkg,
    ],
    external: catalog.pick('react'),
  },
  devDependencies: {
    external: {
      ...catalog.pick(
        ...peerDepNames,
        '@effect/atom-react',
        '@effect/vitest',
        '@opentui/core',
        '@opentui/react',
        '@storybook/react',
        '@types/node',
        '@types/react',
        '@types/react-reconciler',
        'react-dom',
        'react-reconciler',
        'typescript',
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
    name: '@overeng/notion-datasource-sync',
    ...privatePackageDefaults,
    exports: {
      '.': exportEntry(
        { types: './dist/src/mod.d.ts', default: './src/mod.ts' },
        { environment: 'node' },
      ),
      './body': exportEntry(
        { types: './dist/src/body/adapter.d.ts', default: './src/body/adapter.ts' },
        { environment: 'node' },
      ),
      './body/notion-md': exportEntry(
        { types: './dist/src/body/notion-md.d.ts', default: './src/body/notion-md.ts' },
        { environment: 'node' },
      ),
      './cli/effect-command': exportEntry(
        { types: './dist/src/cli/effect-command.d.ts', default: './src/cli/effect-command.ts' },
        { environment: 'node' },
      ),
      './daemon': exportEntry(
        { types: './dist/src/daemon/watch.d.ts', default: './src/daemon/watch.ts' },
        { environment: 'node' },
      ),
      './demo': exportEntry(
        { types: './dist/src/demo/live-demo.d.ts', default: './src/demo/live-demo.ts' },
        { environment: 'node' },
      ),
      './gateway': exportEntry(
        { types: './dist/src/gateway/gateway.d.ts', default: './src/gateway/gateway.ts' },
        { environment: 'node' },
      ),
      './gateway/fake': exportEntry(
        { types: './dist/src/gateway/fake.d.ts', default: './src/gateway/fake.ts' },
        { environment: 'node' },
      ),
      './gateway/notion': exportEntry(
        { types: './dist/src/gateway/notion.d.ts', default: './src/gateway/notion.ts' },
        { environment: 'node' },
      ),
      './local': exportEntry(
        { types: './dist/src/local/workspace.d.ts', default: './src/local/workspace.ts' },
        { environment: 'node' },
      ),
      './observability': exportEntry(
        { types: './dist/src/observability/observability.d.ts', default: './src/observability/observability.ts' },
        {
          environment: 'node',
        },
      ),
      './replica': exportEntry(
        { types: './dist/src/replica/replica.d.ts', default: './src/replica/replica.ts' },
        { environment: 'node' },
      ),
      './store': exportEntry(
        { types: './dist/src/store/store.d.ts', default: './src/store/store.ts' },
        { environment: 'node' },
      ),
      './store/projections': exportEntry(
        { types: './dist/src/store/projections.d.ts', default: './src/store/projections.ts' },
        { environment: 'node' },
      ),
      './store/schema': exportEntry(
        { types: './dist/src/store/schema.d.ts', default: './src/store/schema.ts' },
        { environment: 'node' },
      ),
      './sync': exportEntry(
        { types: './dist/src/sync/sync.d.ts', default: './src/sync/sync.ts' },
        { environment: 'node' },
      ),
      './sync/executor': exportEntry(
        { types: './dist/src/sync/executor.d.ts', default: './src/sync/executor.ts' },
        { environment: 'node' },
      ),
      './sync/observation': exportEntry(
        { types: './dist/src/sync/observation.d.ts', default: './src/sync/observation.ts' },
        { environment: 'node' },
      ),
      './testing/*': exportEntry(
        { types: './dist/src/testing/*.d.ts', default: './src/testing/*.ts' },
        { environment: 'node' },
      ),
      './webhook': exportEntry(
        { types: './dist/src/webhook/mod.d.ts', default: './src/webhook/mod.ts' },
        { environment: 'node' },
      ),
    },
    scripts: {
      'demo:verify':
        'NOTION_DATASOURCE_SYNC_LIVE=1 vitest run src/e2e/live-demo-replica.e2e.test.ts --config vitest.config.ts',
      'demo:verify:full':
        'NOTION_DATASOURCE_SYNC_LIVE=1 NOTION_DATASOURCE_SYNC_FULL_DEMO=1 vitest run src/e2e/live-demo-replica.e2e.test.ts --config vitest.config.ts',
      'demo:provision':
        'NOTION_DATASOURCE_SYNC_LIVE=1 NOTION_DATASOURCE_SYNC_REQUIRED_CAPABILITIES=data_source_retrieve,data_source_query,data_source_metadata_update,page_retrieve,page_property_paginate,page_create vitest run src/e2e/live-notion.e2e.test.ts --config vitest.config.ts -t "credentialed automated demo showcase"',
    },
    engines: {
      node: '>=24.0.0',
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': './dist/src/mod.js',
        './body': './dist/src/body/adapter.js',
        './body/notion-md': './dist/src/body/notion-md.js',
        './cli/effect-command': './dist/src/cli/effect-command.js',
        './daemon': './dist/src/daemon/watch.js',
        './demo': './dist/src/demo/live-demo.js',
        './gateway': './dist/src/gateway/gateway.js',
        './gateway/fake': './dist/src/gateway/fake.js',
        './gateway/notion': './dist/src/gateway/notion.js',
        './local': './dist/src/local/workspace.js',
        './observability': './dist/src/observability/observability.js',
        './replica': './dist/src/replica/replica.js',
        './store': './dist/src/store/store.js',
        './store/projections': './dist/src/store/projections.js',
        './store/schema': './dist/src/store/schema.js',
        './sync': './dist/src/sync/sync.js',
        './sync/executor': './dist/src/sync/executor.js',
        './sync/observation': './dist/src/sync/observation.js',
        './testing/*': './dist/src/testing/*.js',
        './webhook': './dist/src/webhook/mod.js',
      },
    },
    dependenciesMeta: {
      '@overeng/tui-react': { injected: true },
    },
  } satisfies PackageJsonInputData,
  workspaceDeps,
)
