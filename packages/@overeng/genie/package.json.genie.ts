// @genie-bootstrap
import {
  catalog,
  workspaceMember,
  exportEntry,
  packageJson,
  privatePackageDefaults,
} from '../../../genie/internal.ts'
import otelContractPkg from '../otel-contract/package.json.genie.ts'
import tuiReactPkg from '../tui-react/package.json.genie.ts'
import utilsDevPkg from '../utils-dev/package.json.genie.ts'
import utilsPkg from '../utils/package.json.genie.ts'

const supportDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/genie' }),
  dependencies: {
    workspace: [otelContractPkg],
    external: catalog.pick('typescript'),
  },
  devDependencies: {
    workspace: [tuiReactPkg, utilsDevPkg, utilsPkg],
    external: {
      ...catalog.pick(
        '@effect/platform-node',
        '@effect/atom-react',
        '@effect/vitest',
        '@types/node',
        '@types/bun',
        'vitest',
        '@storybook/react',
        '@storybook/react-vite',
        'storybook',
        '@types/react',
        '@types/react-reconciler',
        'prettier',
      ),
    },
  },
  peerDependencies: {
    workspace: [utilsPkg, tuiReactPkg],
    external: catalog.pick('effect'),
  },
  mode: 'install',
})

export default packageJson(
  {
    name: '@overeng/genie',
    ...privatePackageDefaults,
    scripts: {
      storybook: 'storybook dev -p 6008',
      'storybook:build': 'storybook build',
    },
    exports: {
      // Isomorphic entry: pure builders + types, free of node/Bun/DOM in their import closure. A TYPECHECKING
      // consumer (e.g. a `.bzl` genie generator) can import `GenieOutput`/`Strict` and the builders without
      // dragging genie's runtime ambient globals into its program. Filesystem/spawn capabilities used during
      // validation are injected via `GenieContext` (`io`, `actionlint`) by the engine.
      '.': exportEntry(
        { types: './dist/src/runtime/mod.d.ts', default: './src/runtime/mod.ts' },
        {
          environment: 'isomorphic-es2024',
          typeProof: 'strict',
        },
      ),
      // Node-resident entry: re-exports `.` plus the node-only members (nodeGenieIO, actionlint runner,
      // github-ruleset reconcile ops, fs-discovery tsconfigJsonFromPackages, repo-context).
      './node': exportEntry(
        { types: './dist/src/runtime/node/mod.d.ts', default: './src/runtime/node/mod.ts' },
        { environment: 'node' },
      ),
      // Explicit reusable composition layer. Keep `.` focused on thin artifact builders; put cross-artifact
      // helpers that consume structured Genie metadata here.
      './composition': exportEntry(
        {
          types: './dist/src/runtime/composition/mod.d.ts',
          default: './src/runtime/composition/mod.ts',
        },
        { environment: 'isomorphic-es2024' },
      ),
      './cli': exportEntry(
        { types: './dist/src/build/mod.d.ts', default: './src/build/mod.tsx' },
        { environment: 'node' },
      ),
      './sdk': exportEntry(
        { types: './dist/src/sdk/mod.d.ts', default: './src/sdk/mod.ts' },
        { environment: 'node' },
      ),
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': './dist/src/runtime/mod.js',
        './node': './dist/src/runtime/node/mod.js',
        './composition': './dist/src/runtime/composition/mod.js',
        './cli': './dist/src/build/mod.js',
        './sdk': './dist/src/sdk/mod.js',
      },
    },
    dependenciesMeta: {
      '@overeng/tui-react': { injected: true },
    },
  },
  supportDeps,
)
