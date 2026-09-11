import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_notion_react_7158c0aeaa96',
  packageName: '@overeng/notion-react',
  packagePath: 'packages/@overeng/notion-react',
  projectionSource: 'packages/@overeng/notion-react/BUCK.genie.ts',
  sourceRoots: ['src'],
  workspaceSiblings: [
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
      packageName: '@overeng/otel-contract',
      packagePath: 'packages/@overeng/otel-contract',
      distTarget: '//packages/@overeng/otel-contract:dist',
    },
  ],
  authorities: [{ declarationEntrypoint: 'src/mod.d.ts', projectFile: 'tsconfig.json' }],
  tests: [
    {
      name: 'test',
      runner: 'vitest',
      // The regression lane emits a timestamped dashboard artifact under `tmp/`. The live
      // integration suites stay on the credentialed Notion task.
      excludes: [
        'src/test/integration/e2e/adopt.e2e.test.tsx',
        'src/test/integration/e2e/blocks.e2e.test.tsx',
        'src/test/integration/e2e/edge-cases.e2e.test.tsx',
        'src/test/integration/e2e/mutations.e2e.test.tsx',
        'src/test/integration/e2e/prop-projection.e2e.test.tsx',
        'src/test/integration/e2e/readback.e2e.test.tsx',
        'src/test/integration/e2e/sub-pages.e2e.test.tsx',
        'src/test/regression/sync-perf.regression.unit.test.tsx',
      ],
      sourceOwners: {
        'src/test/integration/e2e/adopt.e2e.test.tsx': 'test:notion-integration:notion-react',
        'src/test/integration/e2e/blocks.e2e.test.tsx': 'test:notion-integration:notion-react',
        'src/test/integration/e2e/edge-cases.e2e.test.tsx': 'test:notion-integration:notion-react',
        'src/test/integration/e2e/mutations.e2e.test.tsx': 'test:notion-integration:notion-react',
        'src/test/integration/e2e/prop-projection.e2e.test.tsx':
          'test:notion-integration:notion-react',
        'src/test/integration/e2e/readback.e2e.test.tsx': 'test:notion-integration:notion-react',
        'src/test/integration/e2e/sub-pages.e2e.test.tsx': 'test:notion-integration:notion-react',
      },
    },
  ],
} as const satisfies Buck2TypeScriptAdmission

export default buck2TypeScriptPackageProjection(buck2TypeScriptAdmission)
