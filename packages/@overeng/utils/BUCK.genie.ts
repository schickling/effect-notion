import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'
import { createGenieOutput } from '../genie/src/runtime/core.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_utils_07fe64e7b8ad',
  packageName: '@overeng/utils',
  packagePath: 'packages/@overeng/utils',
  projectionSource: 'packages/@overeng/utils/BUCK.genie.ts',
  sourceRoots: ['src'],
  workspaceSiblings: [
    {
      packageName: '@overeng/effect-distributed-lock',
      packagePath: 'packages/@overeng/effect-distributed-lock',
      distTarget: '//packages/@overeng/effect-distributed-lock:dist',
    },
    {
      packageName: '@overeng/otel-contract',
      packagePath: 'packages/@overeng/otel-contract',
      distTarget: '//packages/@overeng/otel-contract:dist',
    },
    {
      packageName: '@overeng/utils-dev',
      packagePath: 'packages/@overeng/utils-dev',
      distTarget: '//packages/@overeng/utils-dev:dist',
    },
  ],
  editorViewConsumer: false,
  authority: {
    declarationEntrypoint: 'src/isomorphic/mod.d.ts',
    projectFile: 'tsconfig.json',
  },
} as const satisfies Buck2TypeScriptAdmission

const projection = buck2TypeScriptPackageProjection(buck2TypeScriptAdmission)

export default createGenieOutput({
  ...projection,
  stringify: (context) => `load("//buck2/products:defs.bzl", "npm_package_product")

${projection.stringify(context)}

npm_package_product(
    name = "dist-package",
    archive_name = "overeng-utils.tgz",
    dist = ":dist",
    package_json = "package.json",
    product_name = "overeng-utils",
    visibility = ["PUBLIC"],
)
`,
})
