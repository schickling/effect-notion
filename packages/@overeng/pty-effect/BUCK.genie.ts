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
      // Only the pure client suite is bounded: the session and compiled-binary suites need a
      // real PTY, the Nix-built `node-pty` addon, and `bun build --compile`, so they stay
      // unbounded (decision 0026) under the devenv `test:pty-effect` task.
      excludes: ['src/PtySession.test.ts', 'src/client.test.ts'],
      unboundedAfter: ['pnpm:link-native-node-packages'],
    },
  ],
} as const satisfies Buck2TypeScriptAdmission

export default buck2TypeScriptPackageProjection(buck2TypeScriptAdmission)
