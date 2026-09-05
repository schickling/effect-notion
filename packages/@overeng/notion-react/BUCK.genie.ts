import { withJavaScriptCandidates } from '../../../genie/buck2/javascript-candidates.ts'
import {
  buck2JavaScriptPackageProjection,
  javascriptTestPlanFor,
} from '../../../genie/buck2/javascript-package-projection.ts'
import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_notion_react_7158c0aeaa96',
  packageName: '@overeng/notion-react',
  packagePath: 'packages/@overeng/notion-react',
  projectionSource: 'packages/@overeng/notion-react/BUCK.genie.ts',
  sourceRoots: ['src', '.storybook'],
  resourceFiles: ['src/web/styles.css', 'src/web/vendored-notion.css', 'src/web/katex.css'],
  workspaceSiblings: [
    {
      packageName: '@overeng/notion-effect-client',
      packagePath: 'packages/@overeng/notion-effect-client',
      distTarget: '//packages/@overeng/notion-effect-client:dist',
    },
    {
      packageName: '@overeng/notion-effect-schema',
      packagePath: 'packages/@overeng/notion-effect-schema',
      distTarget: '//packages/@overeng/notion-effect-schema:dist',
    },
    {
      packageName: '@overeng/notion-md',
      packagePath: 'packages/@overeng/notion-md',
      distTarget: '//packages/@overeng/notion-md:dist',
    },
    {
      packageName: '@overeng/otel-contract',
      packagePath: 'packages/@overeng/otel-contract',
      distTarget: '//packages/@overeng/otel-contract:dist',
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
  storybookPort: 6014,
})
