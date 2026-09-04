import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_kdl_d22c24f7367b',
  packageName: '@overeng/kdl',
  packagePath: 'packages/@overeng/kdl',
  projectionSource: 'packages/@overeng/kdl/BUCK.genie.ts',
  sourceRoots: ['src'],
  workspaceSiblings: [
    {
      packageName: '@overeng/utils-dev',
      packagePath: 'packages/@overeng/utils-dev',
      distTarget: '//packages/@overeng/utils-dev:dist',
    },
  ],
  editorViewConsumer: false,
  authority: {
    declarationEntrypoint: 'src/mod.d.ts',
    projectFile: 'tsconfig.json',
  },
} as const satisfies Buck2TypeScriptAdmission

export default buck2TypeScriptPackageProjection(buck2TypeScriptAdmission)
