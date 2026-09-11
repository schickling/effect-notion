import { withJavaScriptCandidates } from '../../../genie/buck2/javascript-candidates.ts'
import { javaScriptProductsFor } from '../../../genie/buck2/javascript-product-registry.ts'
import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_tui_stories_e7d895529eb9',
  packageName: '@overeng/tui-stories',
  packagePath: 'packages/@overeng/tui-stories',
  projectionSource: 'packages/@overeng/tui-stories/BUCK.genie.ts',
  sourceRoots: ['src', 'test', 'bin', '.storybook'],
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
  editorViewConsumer: false,
  authorities: [{ declarationEntrypoint: 'src/mod.d.ts', projectFile: 'tsconfig.json' }],
  tests: [
    {
      name: 'test',
      runner: 'vitest',
      // Only the story-module and wire-baseline suites are bounded: story discovery, capture,
      // rendering, and the CLI contract all reach outside the package tree for the repository
      // checkout, so they stay unbounded (decision 0026).
      excludes: [
        'test/StoryCapture.test.ts',
        'test/StoryDiscovery.test.ts',
        'test/StoryRenderer.test.ts',
        'test/cli.contract.test.ts',
      ],
    },
  ],
} as const satisfies Buck2TypeScriptAdmission

export default withJavaScriptCandidates({
  projection: buck2TypeScriptPackageProjection(buck2TypeScriptAdmission),
  products: javaScriptProductsFor(buck2TypeScriptAdmission.packagePath),
})
