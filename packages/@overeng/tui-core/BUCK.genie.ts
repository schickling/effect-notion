import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_tui_core_45029ece7ddb',
  packageName: '@overeng/tui-core',
  packagePath: 'packages/@overeng/tui-core',
  projectionSource: 'packages/@overeng/tui-core/BUCK.genie.ts',
  sourceRoots: ['src', 'test'],
  editorViewConsumer: true,
  authorities: [{ declarationEntrypoint: 'src/mod.d.ts', projectFile: 'tsconfig.json' }],
  tests: [
    {
      name: 'test',
      runner: 'vitest',
    },
  ],
} as const satisfies Buck2TypeScriptAdmission

export default buck2TypeScriptPackageProjection(buck2TypeScriptAdmission)
