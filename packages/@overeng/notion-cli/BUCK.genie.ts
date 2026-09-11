import { withJavaScriptCandidates } from '../../../genie/buck2/javascript-candidates.ts'
import { javaScriptProductsFor } from '../../../genie/buck2/javascript-product-registry.ts'
import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_notion_cli_b91b1e6ae4c6',
  packageName: '@overeng/notion-cli',
  packagePath: 'packages/@overeng/notion-cli',
  projectionSource: 'packages/@overeng/notion-cli/BUCK.genie.ts',
  sourceRoots: ['src'],
  workspaceSiblings: [
    {
      packageName: '@overeng/effect-path',
      packagePath: 'packages/@overeng/effect-path',
      distTarget: '//packages/@overeng/effect-path:dist',
    },
    {
      packageName: '@overeng/notion-datasource-sync',
      packagePath: 'packages/@overeng/notion-datasource-sync',
      distTarget: '//packages/@overeng/notion-datasource-sync:dist',
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
      packageName: '@overeng/otel-contract',
      packagePath: 'packages/@overeng/otel-contract',
      distTarget: '//packages/@overeng/otel-contract:dist',
    },
    {
      packageName: '@overeng/tui-core',
      packagePath: 'packages/@overeng/tui-core',
      distTarget: '//packages/@overeng/tui-core:dist',
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
  tests: [
    {
      name: 'test',
      runner: 'vitest',
      // The CLI contract normalizes paths against the live checkout's `.git` root, so it
      // remains in the exact source-side complement. The concurrent-import suite still runs
      // bounded and receives the pinned Bun through the declared toolchain.
      excludes: ['src/cli.contract.test.ts', 'src/integration.integration.test.ts'],
      sourceOwners: {
        'src/integration.integration.test.ts': 'test:notion-integration:notion-cli',
      },
      tools: { BUN_BIN: '//buck2/toolchains:tool_bun' },
    },
  ],
} as const satisfies Buck2TypeScriptAdmission

export default withJavaScriptCandidates({
  projection: buck2TypeScriptPackageProjection(buck2TypeScriptAdmission),
  products: javaScriptProductsFor(buck2TypeScriptAdmission.packagePath),
})
