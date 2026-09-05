import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_context_effect_socket_63f203470f7c',
  packageName: 'effect-socket-examples',
  packagePath: 'context/effect/socket',
  projectionSource: 'context/effect/socket/BUCK.genie.ts',
  sourceRoots: ['examples'],
  authority: {
    // The examples publish no package exports; the shared RPC schema is the
    // emit proof that the whole example program compiled.
    declarationEntrypoint: 'examples/rpc-schema.d.ts',
    projectFile: 'tsconfig.json',
  },
} as const satisfies Buck2TypeScriptAdmission

export default buck2TypeScriptPackageProjection(buck2TypeScriptAdmission)
