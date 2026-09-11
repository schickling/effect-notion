import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_react_inspector_57d1a5b765ed',
  packageName: '@overeng/react-inspector',
  packagePath: 'packages/@overeng/react-inspector',
  projectionSource: 'packages/@overeng/react-inspector/BUCK.genie.ts',
  sourceRoots: ['src', 'test-d'],
  authorities: [
    { declarationEntrypoint: 'src/index.d.ts', projectFile: 'tsconfig.json' },
    {
      projectFile: 'tsconfig.strict-consumer.json',
      projectPath: 'packages/@overeng/react-inspector/tsconfig.strict-consumer.json',
      typecheckTargetName: 'strict_consumer_typecheck',
    },
  ],
  tests: [
    {
      name: 'test',
      runner: 'vitest',
      // The config's `setupFiles` entry is a package-root file, outside every source root,
      // so it is staged with the config itself.
      configInputs: ['vitest.setup.ts'],
    },
  ],
} as const satisfies Buck2TypeScriptAdmission

export default buck2TypeScriptPackageProjection(buck2TypeScriptAdmission)
