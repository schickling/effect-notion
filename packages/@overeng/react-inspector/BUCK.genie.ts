import { withJavaScriptCandidates } from '../../../genie/buck2/javascript-candidates.ts'
import {
  buck2JavaScriptPackageProjection,
  javascriptTestPlanFor,
} from '../../../genie/buck2/javascript-package-projection.ts'
import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_react_inspector_57d1a5b765ed',
  packageName: '@overeng/react-inspector',
  packagePath: 'packages/@overeng/react-inspector',
  projectionSource: 'packages/@overeng/react-inspector/BUCK.genie.ts',
  sourceRoots: ['src', '.storybook'],
  // `vitest.config.ts` loads this setup module, so the test action reads it.
  sourceFiles: ['vitest.setup.ts'],
  testDataRoots: [{ root: 'src', extensions: ['.snap'] }],
  additionalTypecheckProjects: [
    {
      projectFile: 'tsconfig.strict-consumer.json',
      sourceRoots: ['test-d'],
      targetName: 'typecheck_strict_consumer',
    },
  ],
  authority: {
    // `rootDir` is `src`, so the emit lands at `dist/index.d.ts`.
    declarationEntrypoint: 'index.d.ts',
    projectFile: 'tsconfig.json',
  },
} as const satisfies Buck2TypeScriptAdmission

export default withJavaScriptCandidates({
  projection: buck2JavaScriptPackageProjection(
    buck2TypeScriptAdmission,
    javascriptTestPlanFor(buck2TypeScriptAdmission.packageName),
  ),
  storybookPort: 6011,
})
