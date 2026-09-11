import { withJavaScriptCandidates } from '../../../genie/buck2/javascript-candidates.ts'
import { javaScriptProductsFor } from '../../../genie/buck2/javascript-product-registry.ts'
import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_npm_release_4d3d9fe00538',
  packageName: '@overeng/npm-release',
  packagePath: 'packages/@overeng/npm-release',
  projectionSource: 'packages/@overeng/npm-release/BUCK.genie.ts',
  sourceRoots: ['src'],
  workspaceSiblings: [
    {
      packageName: '@overeng/utils-dev',
      packagePath: 'packages/@overeng/utils-dev',
      distTarget: '//packages/@overeng/utils-dev:dist',
    },
  ],
  authorities: [{ declarationEntrypoint: 'src/mod.d.ts', projectFile: 'tsconfig.json' }],
  tests: [
    {
      name: 'test',
      runner: 'vitest',
      // The CLI contract suite runs the CLI as a child process under the pinned Bun.
      tools: { BUN_BIN: '//buck2/toolchains:tool_bun' },
    },
  ],
} as const satisfies Buck2TypeScriptAdmission

export default withJavaScriptCandidates({
  projection: buck2TypeScriptPackageProjection(buck2TypeScriptAdmission),
  products: javaScriptProductsFor(buck2TypeScriptAdmission.packagePath),
})
