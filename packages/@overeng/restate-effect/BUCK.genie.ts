import {
  buck2JavaScriptPackageProjection,
  javascriptTestPlanFor,
} from '../../../genie/buck2/javascript-package-projection.ts'
import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_restate_effect_1d9088e92885',
  packageName: '@overeng/restate-effect',
  packagePath: 'packages/@overeng/restate-effect',
  projectionSource: 'packages/@overeng/restate-effect/BUCK.genie.ts',
  sourceRoots: ['src'],
  /* `examples/*.ts` live outside `src` but package tests import them directly
   * (the examples ARE the contract the tests verify). Declared explicitly —
   * transitively closed over intra-example imports — so the sandboxed package
   * tree carries them instead of the tests resolving a repository checkout. */
  sourceFiles: [
    'examples/01-service.ts',
    'examples/02-virtual-object.ts',
    'examples/03-workflow.ts',
    'examples/07-clients-idempotency-awakeables.ts',
    'examples/11-testing.ts',
    'examples/12-self-reschedule.ts',
    'examples/13-admin-operations.ts',
    'examples/14-http-error-classification.ts',
  ],
  workspaceSiblings: [
    {
      packageName: '@overeng/otel-contract',
      packagePath: 'packages/@overeng/otel-contract',
      distTarget: '//packages/@overeng/otel-contract:dist',
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
    projectFile: 'tsconfig.json',
  },
} as const satisfies Buck2TypeScriptAdmission

export default buck2JavaScriptPackageProjection(
  buck2TypeScriptAdmission,
  javascriptTestPlanFor(buck2TypeScriptAdmission.packageName),
)
