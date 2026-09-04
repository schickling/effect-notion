import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_oxc_config_0c9db47f45b6',
  packageName: '@overeng/oxc-config',
  packagePath: 'packages/@overeng/oxc-config',
  projectionSource: 'packages/@overeng/oxc-config/BUCK.genie.ts',
  sourceRoots: ['src'],
  editorViewConsumer: false,
  authority: {
    declarationEntrypoint: 'src/mod.d.ts',
    projectFile: 'tsconfig.json',
  },
} as const satisfies Buck2TypeScriptAdmission

export default buck2TypeScriptPackageProjection(buck2TypeScriptAdmission)
