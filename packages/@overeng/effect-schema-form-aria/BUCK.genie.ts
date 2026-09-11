import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter:
    '//buck2/dependencies:importer_packages_overeng_effect_schema_form_aria_baba449ec9b4',
  packageName: '@overeng/effect-schema-form-aria',
  packagePath: 'packages/@overeng/effect-schema-form-aria',
  projectionSource: 'packages/@overeng/effect-schema-form-aria/BUCK.genie.ts',
  sourceRoots: ['src'],
  workspaceSiblings: [
    {
      packageName: '@overeng/effect-schema-form',
      packagePath: 'packages/@overeng/effect-schema-form',
      distTarget: '//packages/@overeng/effect-schema-form:dist',
    },
    {
      packageName: '@overeng/stylex-tokens',
      packagePath: 'packages/@overeng/stylex-tokens',
      distTarget: '//packages/@overeng/stylex-tokens:dist',
    },
  ],
  authorities: [{ declarationEntrypoint: 'mod.d.ts', projectFile: 'tsconfig.json' }],
} as const satisfies Buck2TypeScriptAdmission

export default buck2TypeScriptPackageProjection(buck2TypeScriptAdmission)
