import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_utils_dev_8614cc76469c',
  packageName: '@overeng/utils-dev',
  packagePath: 'packages/@overeng/utils-dev',
  projectionSource: 'packages/@overeng/utils-dev/BUCK.genie.ts',
  sourceRoots: ['src'],
  authorities: [
    { declarationEntrypoint: 'src/node-vitest/mod.d.ts', projectFile: 'tsconfig.json' },
  ],
  tests: [
    {
      name: 'test',
      runner: 'vitest',
      // Only the CLI contract suite is bounded: every otelite helper suite spawns the real
      // `otelite` capture binary and stays unbounded (decision 0026).
      excludes: [
        'src/node-vitest/otel-vitest-flush.test.ts',
        'src/otelite/Otelite.test.ts',
        'src/otelite/signal-expect.test.ts',
        'src/otelite/test-harness.test.ts',
        'src/otelite/trace-expect.test.ts',
        'src/otelite/vitest-bridge.test.ts',
      ],
    },
  ],
} as const satisfies Buck2TypeScriptAdmission

export default buck2TypeScriptPackageProjection(buck2TypeScriptAdmission)
