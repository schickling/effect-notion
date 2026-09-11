import { withJavaScriptCandidates } from '../../../genie/buck2/javascript-candidates.ts'
import { javaScriptProductsFor } from '../../../genie/buck2/javascript-product-registry.ts'
import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_genie_b7534483be10',
  packageName: '@overeng/genie',
  packagePath: 'packages/@overeng/genie',
  projectionSource: 'packages/@overeng/genie/BUCK.genie.ts',
  sourceRoots: ['src', 'bin'],
  workspaceSiblings: [
    {
      packageName: '@overeng/otel-contract',
      packagePath: 'packages/@overeng/otel-contract',
      distTarget: '//packages/@overeng/otel-contract:dist',
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
  tests: [
    {
      name: 'test',
      runner: 'vitest',
      // The build probes and the CLI contract suite spawn the pinned Bun. The excluded suites
      // reach real `git`, `bash`, `rustc`/`rustfmt`, or repository-root files that no package
      // tree carries, so they stay unbounded (decision 0026) under the devenv `test:genie` task.
      tools: {
        BUN_BIN: '//buck2/toolchains:tool_bun',
        NODE_BIN: '//buck2/toolchains:tool_node',
      },
      vitestRuntime: 'node',
      excludes: [
        'src/build/mod.integration.test.ts',
        'src/core/discovery.unit.test.ts',
        'src/runtime/github-workflow/ci-runtime-scripts.unit.test.ts',
        'src/runtime/github-workflow/ci-workflow-helpers.unit.test.ts',
        'src/runtime/package-json/package-json.unit.test.ts',
        'src/runtime/weaver/rust-constants.unit.test.ts',
      ],
    },
  ],
} as const satisfies Buck2TypeScriptAdmission

export default withJavaScriptCandidates({
  projection: buck2TypeScriptPackageProjection(buck2TypeScriptAdmission),
  products: javaScriptProductsFor(buck2TypeScriptAdmission.packagePath),
})
