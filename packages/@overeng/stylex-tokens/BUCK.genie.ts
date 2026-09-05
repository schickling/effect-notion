import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_stylex_tokens_61644ffb4ebc',
  packageName: '@overeng/stylex-tokens',
  packagePath: 'packages/@overeng/stylex-tokens',
  projectionSource: 'packages/@overeng/stylex-tokens/BUCK.genie.ts',
  sourceRoots: ['src'],
  authority: {
    declarationEntrypoint: 'src/tokens.stylex.d.ts',
    projectFile: 'tsconfig.json',
  },
} as const satisfies Buck2TypeScriptAdmission

export default buck2TypeScriptPackageProjection(buck2TypeScriptAdmission)
