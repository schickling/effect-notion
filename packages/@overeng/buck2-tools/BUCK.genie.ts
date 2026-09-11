import { withBuck2ToolsRuntimes } from '../../../genie/buck2/runtime-modules.ts'
import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_buck2_tools_e521acf736cf',
  packageName: '@overeng/buck2-tools',
  packagePath: 'packages/@overeng/buck2-tools',
  projectionSource: 'packages/@overeng/buck2-tools/BUCK.genie.ts',
  sourceRoots: ['src'],
  authorities: [{ declarationEntrypoint: 'src/mod.d.ts', projectFile: 'tsconfig.json' }],
} as const satisfies Buck2TypeScriptAdmission

export default withBuck2ToolsRuntimes(buck2TypeScriptPackageProjection(buck2TypeScriptAdmission))
