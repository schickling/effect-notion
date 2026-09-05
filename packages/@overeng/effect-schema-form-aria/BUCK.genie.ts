import { withJavaScriptCandidates } from '../../../genie/buck2/javascript-candidates.ts'
import {
  buck2JavaScriptPackageProjection,
  javascriptTestPlanFor,
} from '../../../genie/buck2/javascript-package-projection.ts'
import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter:
    '//buck2/dependencies:importer_packages_overeng_effect_schema_form_aria_baba449ec9b4',
  packageName: '@overeng/effect-schema-form-aria',
  packagePath: 'packages/@overeng/effect-schema-form-aria',
  projectionSource: 'packages/@overeng/effect-schema-form-aria/BUCK.genie.ts',
  sourceRoots: ['src', '.storybook'],
  sourceFiles: ['vite.config.ts'],
  resourceFiles: ['src/styles.css'],
  workspaceSiblings: [
    {
      packageName: '@overeng/effect-schema-form',
      packagePath: 'packages/@overeng/effect-schema-form',
      distTarget: '//packages/@overeng/effect-schema-form:dist',
    },
    {
      packageName: '@overeng/stylex-tokens',
      packagePath: 'packages/@overeng/stylex-tokens',
      distTarget: '//packages/@overeng/stylex-tokens:dist',
    },
    {
      packageName: '@overeng/utils',
      packagePath: 'packages/@overeng/utils',
      distTarget: '//packages/@overeng/utils:dist',
    },
  ],
  authority: {
    // `rootDir` is `./src`, so emitted declarations sit directly under `dist`.
    declarationEntrypoint: 'mod.d.ts',
    projectFile: 'tsconfig.json',
  },
} as const satisfies Buck2TypeScriptAdmission

export default withJavaScriptCandidates({
  projection: buck2JavaScriptPackageProjection(
    buck2TypeScriptAdmission,
    javascriptTestPlanFor(buck2TypeScriptAdmission.packageName),
  ),
  storybookPort: 6010,
  declarations: `
package_bin_build(
    name = "vite_build_candidate",
    package_tree = ":package_tree",
    entrypoint = "node_modules/vite/bin/vite.js",
    args = ["build", "--outDir", "{OUT}"],
    output = "dist-vite",
)

package_bin_check(
    name = "storybook_gate_candidate",
    package_tree = ":package_tree",
    entrypoint = "node_modules/@overeng/utils/dist/node/storybook/gate/cli.js",
)
`,
})
