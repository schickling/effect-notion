import { withJavaScriptCandidates } from '../../../genie/buck2/javascript-candidates.ts'
import { javaScriptProductsFor } from '../../../genie/buck2/javascript-product-registry.ts'
import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_notion_md_42a8cb2f2027',
  packageName: '@overeng/notion-md',
  packagePath: 'packages/@overeng/notion-md',
  projectionSource: 'packages/@overeng/notion-md/BUCK.genie.ts',
  sourceRoots: ['src'],
  workspaceSiblings: [
    {
      packageName: '@overeng/content-address',
      packagePath: 'packages/@overeng/content-address',
      distTarget: '//packages/@overeng/content-address:dist',
    },
    {
      packageName: '@overeng/notion-core',
      packagePath: 'packages/@overeng/notion-core',
      distTarget: '//packages/@overeng/notion-core:dist',
    },
    {
      packageName: '@overeng/notion-effect-client',
      packagePath: 'packages/@overeng/notion-effect-client',
      distTarget: '//packages/@overeng/notion-effect-client:dist',
    },
    {
      packageName: '@overeng/notion-effect-schema',
      packagePath: 'packages/@overeng/notion-effect-schema',
      distTarget: '//packages/@overeng/notion-effect-schema:dist',
    },
    {
      packageName: '@overeng/notion-property-write',
      packagePath: 'packages/@overeng/notion-property-write',
      distTarget: '//packages/@overeng/notion-property-write:dist',
    },
    {
      packageName: '@overeng/otel-contract',
      packagePath: 'packages/@overeng/otel-contract',
      distTarget: '//packages/@overeng/otel-contract:dist',
    },
    {
      packageName: '@overeng/tui-react',
      packagePath: 'packages/@overeng/tui-react',
      distTarget: '//packages/@overeng/tui-react:dist',
    },
    {
      packageName: '@overeng/utils',
      packagePath: 'packages/@overeng/utils',
      distTarget: '//packages/@overeng/utils:dist',
    },
    {
      packageName: '@overeng/utils-dev',
      packagePath: 'packages/@overeng/utils-dev',
      distTarget: '//packages/@overeng/utils-dev:dist',
    },
  ],
  editorViewConsumer: false,
  authority: {
    declarationEntrypoint: 'src/mod.d.ts',
    projectFile: 'tsconfig.json',
  },
  // The golden-file fixpoint reads the committed `demo/showcase.nmd`, which no source
  // root carries.
  testDataRoots: [{ root: 'demo', extensions: ['.nmd'] }],
  tests: [
    {
      name: 'test',
      runner: 'vitest',
      // The e2e suites and the editor-observability suite reach the live gateway and the
      // `otelite` binary, so they stay unbounded (decision 0026). The golden-file fixpoint
      // reads the committed demo, declared as test data below.
      excludes: [
        'src/cli.e2e.test.ts',
        'src/corpus-live.integration.test.ts',
        'src/editor-edit.e2e.test.ts',
        'src/editor-observability.unit.test.ts',
        'src/live.integration.test.ts',
        'src/reconcile-live.integration.test.ts',
        'src/reconcile.e2e.test.ts',
        'src/sync.e2e.test.ts',
      ],
      sourceOwners: {
        'src/corpus-live.integration.test.ts': 'test:notion-integration:notion-md',
        'src/live.integration.test.ts': 'test:notion-integration:notion-md',
        'src/reconcile-live.integration.test.ts': 'test:notion-integration:notion-md',
      },
    },
  ],
} as const satisfies Buck2TypeScriptAdmission

export default withJavaScriptCandidates({
  projection: buck2TypeScriptPackageProjection(buck2TypeScriptAdmission),
  products: javaScriptProductsFor(buck2TypeScriptAdmission.packagePath),
})
