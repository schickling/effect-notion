import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter:
    '//buck2/dependencies:importer_packages_overeng_notion_effect_client_6a05720e6f76',
  packageName: '@overeng/notion-effect-client',
  packagePath: 'packages/@overeng/notion-effect-client',
  projectionSource: 'packages/@overeng/notion-effect-client/BUCK.genie.ts',
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
      packageName: '@overeng/notion-effect-schema',
      packagePath: 'packages/@overeng/notion-effect-schema',
      distTarget: '//packages/@overeng/notion-effect-schema:dist',
    },
    {
      packageName: '@overeng/otel-contract',
      packagePath: 'packages/@overeng/otel-contract',
      distTarget: '//packages/@overeng/otel-contract:dist',
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
  authorities: [{ declarationEntrypoint: 'src/mod.d.ts', projectFile: 'tsconfig.json' }],
  tests: [
    {
      name: 'test',
      runner: 'vitest',
      // The rate-limit e2e suite and the otelite span-shape suite spawn live services and the
      // `otelite` binary, so they stay unbounded (decision 0026).
      excludes: [
        'src/internal/rate-limit-signals.e2e.test.ts',
        'src/test/integration/blocks-nested.integration.test.ts',
        'src/test/integration/blocks.integration.test.ts',
        'src/test/integration/databases.integration.test.ts',
        'src/test/integration/markdown.integration.test.ts',
        'src/test/integration/pages.integration.test.ts',
        'src/test/integration/rich-text.integration.test.ts',
        'src/test/integration/search.integration.test.ts',
        'src/test/integration/users.integration.test.ts',
        'src/test/otelite-span-shape.test.ts',
      ],
      sourceOwners: {
        'src/test/integration/blocks-nested.integration.test.ts':
          'test:notion-integration:notion-effect-client',
        'src/test/integration/blocks.integration.test.ts':
          'test:notion-integration:notion-effect-client',
        'src/test/integration/databases.integration.test.ts':
          'test:notion-integration:notion-effect-client',
        'src/test/integration/markdown.integration.test.ts':
          'test:notion-integration:notion-effect-client',
        'src/test/integration/pages.integration.test.ts':
          'test:notion-integration:notion-effect-client',
        'src/test/integration/rich-text.integration.test.ts':
          'test:notion-integration:notion-effect-client',
        'src/test/integration/search.integration.test.ts':
          'test:notion-integration:notion-effect-client',
        'src/test/integration/users.integration.test.ts':
          'test:notion-integration:notion-effect-client',
      },
    },
  ],
} as const satisfies Buck2TypeScriptAdmission

export default buck2TypeScriptPackageProjection(buck2TypeScriptAdmission)
