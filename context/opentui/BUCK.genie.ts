import type { Buck2TypeScriptAdmission } from '../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_context_opentui_be69c4c22aa3',
  packageName: 'opentui-examples',
  packagePath: 'context/opentui',
  projectionSource: 'context/opentui/BUCK.genie.ts',
  sourceRoots: ['examples'],
  authority: {
    // The examples publish no package exports; the counter example is the emit
    // proof that the whole example program compiled.
    declarationEntrypoint: 'examples/simple-counter.d.ts',
    projectFile: 'tsconfig.json',
  },
} as const satisfies Buck2TypeScriptAdmission

export default buck2TypeScriptPackageProjection(buck2TypeScriptAdmission)
