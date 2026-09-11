import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_restate_effect_1d9088e92885',
  packageName: '@overeng/restate-effect',
  packagePath: 'packages/@overeng/restate-effect',
  projectionSource: 'packages/@overeng/restate-effect/BUCK.genie.ts',
  sourceRoots: ['src', 'examples'],
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
  editorViewConsumer: false,
  authority: {
    declarationEntrypoint: 'src/mod.d.ts',
    projectFile: 'tsconfig.json',
  },
  tests: [
    {
      name: 'test',
      runner: 'vitest',
      // The integration suites boot a real `restate-server` child, so they stay unbounded
      // (decision 0026) under the devenv `test:restate-effect` task.
      excludes: [
        'src/admin/admin.integration.test.ts',
        'src/authoring/awakeable.integration.test.ts',
        'src/authoring/concurrency.integration.test.ts',
        'src/authoring/object.integration.test.ts',
        'src/authoring/peek.integration.test.ts',
        'src/authoring/workflow.integration.test.ts',
        'src/clients/contract-policy.integration.test.ts',
        'src/clients/in-handler-call.integration.test.ts',
        'src/endpoint/examples.integration.test.ts',
        'src/endpoint/multi-deployment.integration.test.ts',
        'src/endpoint/restate-effect.integration.test.ts',
        'src/error/http-error-classification.integration.test.ts',
        'src/error/retry-policy.integration.test.ts',
        'src/error/saga.integration.test.ts',
        'src/error/suspension.integration.test.ts',
        'src/observability/otel-replay.integration.test.ts',
        'src/runtime/cancellation.integration.test.ts',
        'src/scheduling/scheduled-compose.integration.test.ts',
        'src/scheduling/scheduled-durability.integration.test.ts',
        'src/scheduling/scheduled.integration.test.ts',
        'src/schema/redaction.integration.test.ts',
        'src/testing/harness.integration.test.ts',
        'src/testing/test-env.integration.test.ts',
      ],
    },
  ],
} as const satisfies Buck2TypeScriptAdmission

export default buck2TypeScriptPackageProjection(buck2TypeScriptAdmission)
