import { withJavaScriptCandidates } from '../../../genie/buck2/javascript-candidates.ts'
import {
  buck2JavaScriptPackageProjection,
  javascriptTestPlanFor,
} from '../../../genie/buck2/javascript-package-projection.ts'
import { javaScriptProductsFor } from '../../../genie/buck2/javascript-product-registry.ts'
import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_tui_stories_e7d895529eb9',
  packageName: '@overeng/tui-stories',
  packagePath: 'packages/@overeng/tui-stories',
  projectionSource: 'packages/@overeng/tui-stories/BUCK.genie.ts',
  sourceRoots: ['src', 'test', 'bin', '.storybook'],
  testDataRoots: [{ root: 'test', extensions: ['.snap'] }],
  workspaceSiblings: [
    {
      packageName: '@overeng/megarepo',
      packagePath: 'packages/@overeng/megarepo',
      sourceRoots: ['src'],
    },
    {
      packageName: '@overeng/tui-react',
      packagePath: 'packages/@overeng/tui-react',
      distTarget: '//packages/@overeng/tui-react:dist',
    },
    {
      packageName: '@overeng/utils',
      packagePath: 'packages/@overeng/utils',
      distTarget: '//packages/@overeng/utils:dist',
    },
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
  storybookPort: 6013,
})
