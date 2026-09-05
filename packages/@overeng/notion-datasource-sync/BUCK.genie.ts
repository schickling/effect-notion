import {
  buck2JavaScriptPackageProjection,
  javascriptTestPlanFor,
} from '../../../genie/buck2/javascript-package-projection.ts'
import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter:
    '//buck2/dependencies:importer_packages_overeng_notion_datasource_sync_60c433be3a75',
  packageName: '@overeng/notion-datasource-sync',
  packagePath: 'packages/@overeng/notion-datasource-sync',
  projectionSource: 'packages/@overeng/notion-datasource-sync/BUCK.genie.ts',
  sourceRoots: ['src'],
  testDataRoots: [{ root: 'src', extensions: ['.snap'] }],
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
  authority: {
    declarationEntrypoint: 'src/mod.d.ts',
    projectFile: 'tsconfig.json',
  },
} as const satisfies Buck2TypeScriptAdmission

export default buck2JavaScriptPackageProjection(
  buck2TypeScriptAdmission,
  javascriptTestPlanFor(buck2TypeScriptAdmission.packageName),
)
