import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_otel_contract_071b3792a33c',
  packageName: '@overeng/otel-contract',
  packagePath: 'packages/@overeng/otel-contract',
  projectionSource: 'packages/@overeng/otel-contract/BUCK.genie.ts',
  sourceRoots: ['src'],
  workspaceSiblings: [
    {
      packageName: '@overeng/content-address',
      packagePath: 'packages/@overeng/content-address',
      distTarget: '//packages/@overeng/content-address:dist',
    },
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
      // The weaver live check and the profile-link suite spawn the `otelite` and `otel-scrape`
      // binaries, and the boundary and seam suites scan the whole repository, so all four stay
      // unbounded (decision 0026) under the devenv `test:otel-contract` task.
      excludes: [
        'src/otel-scrape/profile-link.unit.test.ts',
        'src/raw-otel-boundary.unit.test.ts',
        'src/registry-live-check.integration.test.ts',
        'src/registry-seam.unit.test.ts',
      ],
    },
  ],
} as const satisfies Buck2TypeScriptAdmission

export default buck2TypeScriptPackageProjection(buck2TypeScriptAdmission)
