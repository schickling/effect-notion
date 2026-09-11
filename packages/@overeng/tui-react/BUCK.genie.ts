import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_tui_react_f20a858a9232',
  packageName: '@overeng/tui-react',
  packagePath: 'packages/@overeng/tui-react',
  projectionSource: 'packages/@overeng/tui-react/BUCK.genie.ts',
  sourceRoots: ['src', 'test', 'examples', 'e2e'],
  workspaceSiblings: [
    {
      packageName: '@overeng/tui-core',
      packagePath: 'packages/@overeng/tui-core',
      distTarget: '//packages/@overeng/tui-core:dist',
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
    projectFile: 'tsconfig.buck.json',
  },
  tests: [
    {
      name: 'test',
      runner: 'vitest',
      vitestRuntime: 'node',
      excludes: ['e2e/resize-truncation.pw.test.ts', 'e2e/tui-story-preview.pw.test.ts'],
      sourceOwners: {
        'e2e/resize-truncation.pw.test.ts': 'test:pw:tui-react',
        'e2e/tui-story-preview.pw.test.ts': 'test:pw:tui-react',
      },
      // The stdout-contract fixtures spawn both runtimes as separate processes.
      tools: {
        BUN_BIN: '//buck2/toolchains:tool_bun',
        NODE_BIN: '//buck2/toolchains:tool_node',
      },
    },
  ],
} as const satisfies Buck2TypeScriptAdmission

export default buck2TypeScriptPackageProjection(buck2TypeScriptAdmission)
