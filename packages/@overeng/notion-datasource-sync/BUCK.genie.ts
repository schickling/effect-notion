import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter:
    '//buck2/dependencies:importer_packages_overeng_notion_datasource_sync_60c433be3a75',
  packageName: '@overeng/notion-datasource-sync',
  packagePath: 'packages/@overeng/notion-datasource-sync',
  projectionSource: 'packages/@overeng/notion-datasource-sync/BUCK.genie.ts',
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
      packageName: '@overeng/notion-md',
      packagePath: 'packages/@overeng/notion-md',
      distTarget: '//packages/@overeng/notion-md:dist',
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
  ],
  editorViewConsumer: false,
  authority: {
    declarationEntrypoint: 'src/mod.d.ts',
    projectFile: 'tsconfig.json',
  },
  tests: [
    {
      name: 'test',
      runner: 'vitest',
      // The store, replica, and planner suites are built on `node:sqlite`, which pinned Bun
      // does not implement, so Node evaluates the lane through the attested NODE_BIN. The
      // e2e suites reach live services and stay with the devenv task (decision 0026).
      tools: { NODE_BIN: '//buck2/toolchains:tool_node' },
      vitestRuntime: 'node',
      excludes: [
        'src/e2e/body-adapter.e2e.test.ts',
        'src/e2e/cli.e2e.test.ts',
        'src/e2e/conflict-resolution.e2e.test.ts',
        'src/e2e/daemon.e2e.test.ts',
        'src/e2e/dry-run-suppression.e2e.test.ts',
        'src/e2e/fake-service.e2e.test.ts',
        'src/e2e/live-demo-replica.e2e.test.ts',
        'src/e2e/live-notion.e2e.test.ts',
        'src/e2e/local-convergence-production.e2e.test.ts',
        'src/e2e/local-workspace-fs.e2e.test.ts',
        'src/e2e/nmd-canonical-comparability.e2e.test.ts',
        'src/e2e/one-shot-sync.e2e.test.ts',
        'src/e2e/otel.e2e.test.ts',
        'src/e2e/property-materialization-production.e2e.test.ts',
        'src/e2e/realistic-workflows.e2e.test.ts',
        'src/e2e/sqlite-storage-contract.e2e.test.ts',
        'src/e2e/watch-authority-mode.e2e.test.ts',
        'src/e2e/watch-dry-run.e2e.test.ts',
      ],
    },
  ],
} as const satisfies Buck2TypeScriptAdmission

export default buck2TypeScriptPackageProjection(buck2TypeScriptAdmission)
