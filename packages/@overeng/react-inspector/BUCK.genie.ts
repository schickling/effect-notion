import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_react_inspector_57d1a5b765ed',
  packageName: '@overeng/react-inspector',
  packagePath: 'packages/@overeng/react-inspector',
  projectionSource: 'packages/@overeng/react-inspector/BUCK.genie.ts',
  sourceRoots: ['src'],
  editorViewConsumer: false,
  authority: {
    declarationEntrypoint: 'src/index.d.ts',
    projectFile: 'tsconfig.json',
  },
} as const satisfies Buck2TypeScriptAdmission

export default buck2TypeScriptPackageProjection(buck2TypeScriptAdmission)
