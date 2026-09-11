import type { Buck2TypeScriptAdmission } from '../../../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter:
    '//buck2/dependencies:importer_packages_overeng_effect_rpc_tanstack_examples_basic_cdf25b205fd8',
  packageName: 'effect-rpc-tanstack-example-basic',
  packagePath: 'packages/@overeng/effect-rpc-tanstack/examples/basic',
  projectionSource: 'packages/@overeng/effect-rpc-tanstack/examples/basic/BUCK.genie.ts',
  sourceRoots: ['src'],
  workspaceSiblings: [
    {
      packageName: '@overeng/effect-rpc-tanstack',
      packagePath: 'packages/@overeng/effect-rpc-tanstack',
      distTarget: '//packages/@overeng/effect-rpc-tanstack:dist',
    },
    {
      packageName: '@overeng/utils',
      packagePath: 'packages/@overeng/utils',
      distTarget: '//packages/@overeng/utils:dist',
    },
  ],
  editorViewConsumer: false,
  authorities: [{ projectFile: 'tsconfig.json', projectInputs: ['vite.config.ts'] }],
} as const satisfies Buck2TypeScriptAdmission

export default buck2TypeScriptPackageProjection(buck2TypeScriptAdmission)
