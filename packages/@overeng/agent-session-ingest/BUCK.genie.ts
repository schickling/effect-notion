import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter:
    '//buck2/dependencies:importer_packages_overeng_agent_session_ingest_6dae38a37f1d',
  packageName: '@overeng/agent-session-ingest',
  packagePath: 'packages/@overeng/agent-session-ingest',
  projectionSource: 'packages/@overeng/agent-session-ingest/BUCK.genie.ts',
  sourceRoots: ['src'],
  workspaceSiblings: [
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
  authorities: [{ declarationEntrypoint: 'src/mod.d.ts', projectFile: 'tsconfig.json' }],
  tests: [
    {
      name: 'test',
      runner: 'vitest',
      // The adapter suites drive real session stores on disk and are unbounded by policy
      // (decision 0026); the devenv `test:agent-session-ingest` task still runs them.
      excludes: [
        'src/claude.integration.test.ts',
        'src/codex.integration.test.ts',
        'src/opencode.integration.test.ts',
        'src/services.integration.test.ts',
      ],
    },
  ],
} as const satisfies Buck2TypeScriptAdmission

export default buck2TypeScriptPackageProjection(buck2TypeScriptAdmission)
