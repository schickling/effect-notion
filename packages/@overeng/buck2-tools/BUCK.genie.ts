import {
  buck2JavaScriptPackageProjection,
  javascriptTestPlanFor,
} from '../../../genie/buck2/javascript-package-projection.ts'
import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { createGenieOutput } from '../genie/src/runtime/core.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_buck2_tools_e521acf736cf',
  packageName: '@overeng/buck2-tools',
  packagePath: 'packages/@overeng/buck2-tools',
  projectionSource: 'packages/@overeng/buck2-tools/BUCK.genie.ts',
  sourceRoots: ['src'],
  workspaceSiblings: [
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

const projection = buck2JavaScriptPackageProjection(
  buck2TypeScriptAdmission,
  javascriptTestPlanFor(buck2TypeScriptAdmission.packageName),
)

export default createGenieOutput({
  data: projection.data,
  meta: projection.meta,
  ...(projection.validate === undefined ? {} : { validate: projection.validate }),
  stringify: (context) =>
    `${projection.stringify(context)}\n# Runtime targets stay package-local; root aliases preserve the established public labels.\nfilegroup(\n    name = "package_tree_runtime",\n    srcs = {\n        "package-tree.ts": "src/package-tree.ts",\n        "real-path.ts": "src/real-path.ts",\n    },\n    visibility = ["PUBLIC"],\n)\n\nfilegroup(\n    name = "javascript_action_runtime",\n    srcs = {\n        "javascript-runner.ts": "src/javascript-runner.ts",\n        "typescript-runner.ts": "src/typescript-runner.ts",\n    },\n    visibility = ["PUBLIC"],\n)\n`,
})
