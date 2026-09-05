import {
  buck2JavaScriptPackageProjection,
  javascriptTestPlanFor,
} from '../../../genie/buck2/javascript-package-projection.ts'
import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter:
    '//buck2/dependencies:importer_packages_overeng_effect_rpc_tanstack_269934211838',
  packageName: '@overeng/effect-rpc-tanstack',
  packagePath: 'packages/@overeng/effect-rpc-tanstack',
  projectionSource: 'packages/@overeng/effect-rpc-tanstack/BUCK.genie.ts',
  sourceRoots: ['src'],
  testDataRoots: [{ root: 'src', extensions: ['.snap'] }],
  workspaceSiblings: [
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
