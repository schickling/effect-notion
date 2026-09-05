import { withJavaScriptCandidates } from '../../../genie/buck2/javascript-candidates.ts'
import {
  buck2JavaScriptPackageProjection,
  javascriptTestPlanFor,
} from '../../../genie/buck2/javascript-package-projection.ts'
import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_tui_react_f20a858a9232',
  packageName: '@overeng/tui-react',
  packagePath: 'packages/@overeng/tui-react',
  projectionSource: 'packages/@overeng/tui-react/BUCK.genie.ts',
  sourceRoots: ['src', 'test', 'examples', '.storybook'],
  sourceFiles: ['playwright.config.ts', 'playwright.config.buck.ts'],
  workspaceSiblings: [
    {
      packageName: '@overeng/tui-core',
      packagePath: 'packages/@overeng/tui-core',
      distTarget: '//packages/@overeng/tui-core:dist',
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
    projectFile: 'tsconfig.buck.json',
  },
} as const satisfies Buck2TypeScriptAdmission

export default withJavaScriptCandidates({
  projection: buck2JavaScriptPackageProjection(
    buck2TypeScriptAdmission,
    javascriptTestPlanFor(buck2TypeScriptAdmission.packageName),
  ),
  storybookPort: 6006,
  declarations: `
package_bin_check(
    name = "playwright_candidate",
    package_tree = ":package_tree",
    entrypoint = "node_modules/@playwright/test/cli.js",
    args = ["test", "--config", "playwright.config.buck.ts"],
    external_capabilities = ["playwright-browsers"],
)

package_bin(
    name = "playwright_ui_candidate",
    package_tree = ":package_tree",
    entrypoint = "node_modules/@playwright/test/cli.js",
    args = ["test", "--ui", "--config", "playwright.config.buck.ts"],
    external_capabilities = ["playwright-browsers"],
    process_kind = "long-lived",
)
`,
})
