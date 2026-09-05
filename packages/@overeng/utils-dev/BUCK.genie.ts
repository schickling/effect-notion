import {
  buck2JavaScriptPackageProjection,
  javascriptTestPlanFor,
} from '../../../genie/buck2/javascript-package-projection.ts'
import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_utils_dev_8614cc76469c',
  packageName: '@overeng/utils-dev',
  packagePath: 'packages/@overeng/utils-dev',
  projectionSource: 'packages/@overeng/utils-dev/BUCK.genie.ts',
  sourceRoots: ['src'],
  testDataRoots: [{ root: 'src', extensions: ['.ndjson'] }],
  authority: {
    declarationEntrypoint: 'src/node-vitest/mod.d.ts',
    projectFile: 'tsconfig.json',
  },
} as const satisfies Buck2TypeScriptAdmission

export default buck2JavaScriptPackageProjection(
  buck2TypeScriptAdmission,
  javascriptTestPlanFor(buck2TypeScriptAdmission.packageName),
)
