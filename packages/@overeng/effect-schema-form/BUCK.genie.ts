import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter:
    '//buck2/dependencies:importer_packages_overeng_effect_schema_form_9234ab1a7f4a',
  packageName: '@overeng/effect-schema-form',
  packagePath: 'packages/@overeng/effect-schema-form',
  projectionSource: 'packages/@overeng/effect-schema-form/BUCK.genie.ts',
  sourceRoots: ['src'],
  editorViewConsumer: false,
  authority: {
    declarationEntrypoint: 'src/mod.d.ts',
    projectFile: 'tsconfig.json',
  },
} as const satisfies Buck2TypeScriptAdmission

export default buck2TypeScriptPackageProjection(buck2TypeScriptAdmission)
