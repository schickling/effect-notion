import { withJavaScriptCandidates } from '../../../../../genie/buck2/javascript-candidates.ts'
import {
  buck2JavaScriptPackageProjection,
  javascriptTestPlanFor,
} from '../../../../../genie/buck2/javascript-package-projection.ts'
import type { Buck2TypeScriptAdmission } from '../../../../../genie/buck2/typescript-admissions.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter:
    '//buck2/dependencies:importer_packages_overeng_effect_rpc_tanstack_examples_basic_cdf25b205fd8',
  packageName: 'effect-rpc-tanstack-example-basic',
  packagePath: 'packages/@overeng/effect-rpc-tanstack/examples/basic',
  projectionSource: 'packages/@overeng/effect-rpc-tanstack/examples/basic/BUCK.genie.ts',
  sourceFiles: ['vite.config.ts', 'playwright.config.buck.ts'],
  sourceRoots: ['src', 'tests'],
  workspaceSiblings: [
    {
      packageName: '@overeng/utils',
      packagePath: 'packages/@overeng/utils',
      distTarget: '//packages/@overeng/utils:dist',
    },
  ],
  authority: {
    // The example publishes no package exports; `src/ssr.tsx` is the TanStack Start server
    // entrypoint, so its declaration is the emit proof that the whole app graph (router,
    // generated route tree, routes, rpc client/server) compiled.
    declarationEntrypoint: 'src/ssr.d.ts',
    projectFile: 'tsconfig.json',
  },
} as const satisfies Buck2TypeScriptAdmission

export default withJavaScriptCandidates({
  projection: buck2JavaScriptPackageProjection(
    buck2TypeScriptAdmission,
    javascriptTestPlanFor(buck2TypeScriptAdmission.packageName),
  ),
  declarations: `
package_bin_build(
    name = "vite_build_candidate",
    package_tree = ":package_tree",
    entrypoint = "node_modules/vite/bin/vite.js",
    args = ["build", "--outDir", "{OUT}"],
    output = "vite-output",
)

package_bin(
    name = "vite_dev_candidate",
    package_tree = ":package_tree",
    entrypoint = "node_modules/vite/bin/vite.js",
    process_kind = "long-lived",
)

package_bin_check(
    name = "playwright_candidate",
    package_tree = ":package_tree",
    entrypoint = "node_modules/@playwright/test/cli.js",
    args = ["test", "--config", "playwright.config.buck.ts"],
    external_capabilities = ["playwright-browsers"],
)
`,
})
