import { createGenieOutput } from '../../packages/@overeng/genie/src/runtime/core.ts'

import {
  authoritativeBuck2TypeScriptAdmissions,
  buck2TypeScriptAdmissions,
  buck2TypeScriptAuthorityProjects,
  editorViewConsumerPackagePaths,
} from './typescript-admissions.ts'

const manifest = {
  schema: 'effect-utils/typescript-authority-manifest/v1',
  watchPackages: Object.values(buck2TypeScriptAdmissions).map((admission) => ({
    packageName: admission.packageName,
    packagePath: admission.packagePath,
    sourceFiles: admission.sourceFiles ?? [],
    additionalTypecheckProjects: admission.additionalTypecheckProjects ?? [],
    sourceRoots: admission.sourceRoots,
    workspaceDependencies: (admission.workspaceSiblings ?? []).map(({ packagePath }) => packagePath),
    hasDist: admission.authority?.declarationEntrypoint !== undefined,
  })),
  authoritativeAdmissions: authoritativeBuck2TypeScriptAdmissions,
  authorityProjects: buck2TypeScriptAuthorityProjects,
  editorViewConsumerPackagePaths,
} as const

export default createGenieOutput({
  data: manifest,
  stringify: () => `${JSON.stringify(manifest, null, 2)}\n`,
})
