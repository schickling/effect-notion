import { withJavaScriptCandidates } from '../../../genie/buck2/javascript-candidates.ts'
import {
  buck2JavaScriptPackageProjection,
  javascriptTestPlanFor,
} from '../../../genie/buck2/javascript-package-projection.ts'
import { javaScriptProductsFor } from '../../../genie/buck2/javascript-product-registry.ts'
import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_npm_release_4d3d9fe00538',
  packageName: '@overeng/npm-release',
  packagePath: 'packages/@overeng/npm-release',
  projectionSource: 'packages/@overeng/npm-release/BUCK.genie.ts',
  sourceRoots: ['src'],
  testDataRoots: [{ root: 'src', extensions: ['.snap'] }],
  workspaceSiblings: [
    {
      packageName: '@overeng/utils-dev',
      packagePath: 'packages/@overeng/utils-dev',
      distTarget: '//packages/@overeng/utils-dev:dist',
    },
  ],
  authority: {
    declarationEntrypoint: 'src/mod.d.ts',
    projectFile: 'tsconfig.json',
  },
} as const satisfies Buck2TypeScriptAdmission

export default withJavaScriptCandidates({
  projection: buck2JavaScriptPackageProjection(
    buck2TypeScriptAdmission,
    javascriptTestPlanFor(buck2TypeScriptAdmission.packageName),
  ),
  products: javaScriptProductsFor(buck2TypeScriptAdmission.packagePath),
})
