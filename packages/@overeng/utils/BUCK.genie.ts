import {
  buck2JavaScriptPackageProjection,
  javascriptTestPlanFor,
} from '../../../genie/buck2/javascript-package-projection.ts'
import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_utils_07fe64e7b8ad',
  packageName: '@overeng/utils',
  packagePath: 'packages/@overeng/utils',
  projectionSource: 'packages/@overeng/utils/BUCK.genie.ts',
  sourceRoots: ['src'],
  // The pnpm lockfile names this patch through `patchedDependencies`, so the
  // dependency-store projection and the suites that translate the real lockfile
  // read it. Declaring it here exports it as one addressable input.
  resourceFiles: ['patches/@myobie__pty@0.10.0.patch'],
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
  authority: {
    declarationEntrypoint: 'src/isomorphic/mod.d.ts',
    projectFile: 'tsconfig.json',
  },
} as const satisfies Buck2TypeScriptAdmission

export default buck2JavaScriptPackageProjection(
  buck2TypeScriptAdmission,
  javascriptTestPlanFor(buck2TypeScriptAdmission.packageName),
)
