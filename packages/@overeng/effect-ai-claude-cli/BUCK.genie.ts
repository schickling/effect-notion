import {
  buck2JavaScriptPackageProjection,
  javascriptTestPlanFor,
} from '../../../genie/buck2/javascript-package-projection.ts'
import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter:
    '//buck2/dependencies:importer_packages_overeng_effect_ai_claude_cli_12fdf58adc3f',
  packageName: '@overeng/effect-ai-claude-cli',
  packagePath: 'packages/@overeng/effect-ai-claude-cli',
  projectionSource: 'packages/@overeng/effect-ai-claude-cli/BUCK.genie.ts',
  sourceRoots: ['src'],
  workspaceSiblings: [
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
