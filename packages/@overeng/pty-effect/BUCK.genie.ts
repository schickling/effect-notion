import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_pty_effect_ec6c01cbf1c8',
  packageName: '@overeng/pty-effect',
  packagePath: 'packages/@overeng/pty-effect',
  projectionSource: 'packages/@overeng/pty-effect/BUCK.genie.ts',
  sourceRoots: ['src'],
  workspaceSiblings: [
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
  authorities: [{ declarationEntrypoint: 'src/mod.d.ts', projectFile: 'tsconfig.json' }],
  tests: [
    {
      name: 'test',
      runner: 'vitest',
      // The native session and compiled-binary suites remain source-owned (decision 0026).
      // The Vite contract gets a separate Buck lane so CI retains its bundle-specific signal.
      excludes: ['src/PtySession.test.ts', 'src/bundle-smoke.unit.test.ts', 'src/client.test.ts'],
      sourceOwners: { 'src/bundle-smoke.unit.test.ts': 'bundle:smoke' },
      unboundedAfter: ['pnpm:link-native-node-packages'],
    },
    {
      name: 'bundle_smoke',
      runner: 'vitest',
      testFiles: ['src/bundle-smoke.unit.test.ts'],
      sourceOwners: {
        'src/PtySession.test.ts': 'test:pty-effect:unbounded',
        'src/client.test.ts': 'test:pty-effect:unbounded',
        'src/client.unit.test.ts': 'test:pty-effect',
      },
      timeoutMs: 120_000,
    },
  ],
} as const satisfies Buck2TypeScriptAdmission

export default buck2TypeScriptPackageProjection(buck2TypeScriptAdmission)
