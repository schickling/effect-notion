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
      packageName: '@overeng/notion-datasource-sync',
      packagePath: 'packages/@overeng/notion-datasource-sync',
      sourceRoots: ['src'],
    },
    {
      packageName: '@overeng/notion-effect-client',
      packagePath: 'packages/@overeng/notion-effect-client',
      sourceRoots: ['src'],
    },
    {
      packageName: '@overeng/notion-effect-schema',
      packagePath: 'packages/@overeng/notion-effect-schema',
      sourceRoots: ['src'],
    },
    {
      packageName: '@overeng/notion-md',
      packagePath: 'packages/@overeng/notion-md',
      sourceRoots: ['src'],
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
} as const satisfies Buck2TypeScriptAdmission

export default withJavaScriptCandidates({
  projection: buck2TypeScriptPackageProjection(buck2TypeScriptAdmission),
  products: javaScriptProductsFor(buck2TypeScriptAdmission.packagePath),
})
