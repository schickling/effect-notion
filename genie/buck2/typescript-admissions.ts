import { Buffer } from 'node:buffer'

import { buck2TypeScriptAdmission as agentSessionIngestAdmission } from '../../packages/@overeng/agent-session-ingest/BUCK.genie.ts'
import { buck2TypeScriptAdmission as ciToolsAdmission } from '../../packages/@overeng/ci-tools/BUCK.genie.ts'
import { buck2TypeScriptAdmission as contentAddressAdmission } from '../../packages/@overeng/content-address/BUCK.genie.ts'
import { buck2TypeScriptAdmission as effectAiClaudeCliAdmission } from '../../packages/@overeng/effect-ai-claude-cli/BUCK.genie.ts'
import { buck2TypeScriptAdmission as effectDistributedLockAdmission } from '../../packages/@overeng/effect-distributed-lock/BUCK.genie.ts'
import { buck2TypeScriptAdmission as effectPathAdmission } from '../../packages/@overeng/effect-path/BUCK.genie.ts'
import { buck2TypeScriptAdmission as effectReactAdmission } from '../../packages/@overeng/effect-react/BUCK.genie.ts'
import { buck2TypeScriptAdmission as effectRpcTanstackAdmission } from '../../packages/@overeng/effect-rpc-tanstack/BUCK.genie.ts'
import { buck2TypeScriptAdmission as effectSchemaFormAdmission } from '../../packages/@overeng/effect-schema-form/BUCK.genie.ts'
import { buck2TypeScriptAdmission as kdlAdmission } from '../../packages/@overeng/kdl/BUCK.genie.ts'
import { buck2TypeScriptAdmission as notionCliAdmission } from '../../packages/@overeng/notion-cli/BUCK.genie.ts'
import { buck2TypeScriptAdmission as notionCoreAdmission } from '../../packages/@overeng/notion-core/BUCK.genie.ts'
import { buck2TypeScriptAdmission as notionDatasourceSyncAdmission } from '../../packages/@overeng/notion-datasource-sync/BUCK.genie.ts'
import { buck2TypeScriptAdmission as notionEffectClientAdmission } from '../../packages/@overeng/notion-effect-client/BUCK.genie.ts'
import { buck2TypeScriptAdmission as notionEffectSchemaAdmission } from '../../packages/@overeng/notion-effect-schema/BUCK.genie.ts'
import { buck2TypeScriptAdmission as notionMdAdmission } from '../../packages/@overeng/notion-md/BUCK.genie.ts'
import { buck2TypeScriptAdmission as notionPropertyWriteAdmission } from '../../packages/@overeng/notion-property-write/BUCK.genie.ts'
import { buck2TypeScriptAdmission as notionReactAdmission } from '../../packages/@overeng/notion-react/BUCK.genie.ts'
import { buck2TypeScriptAdmission as npmReleaseAdmission } from '../../packages/@overeng/npm-release/BUCK.genie.ts'
import { buck2TypeScriptAdmission as otelContractAdmission } from '../../packages/@overeng/otel-contract/BUCK.genie.ts'
import { buck2TypeScriptAdmission as oxcConfigAdmission } from '../../packages/@overeng/oxc-config/BUCK.genie.ts'
import { buck2TypeScriptAdmission as ptyEffectAdmission } from '../../packages/@overeng/pty-effect/BUCK.genie.ts'
import { buck2TypeScriptAdmission as reactInspectorAdmission } from '../../packages/@overeng/react-inspector/BUCK.genie.ts'
import { buck2TypeScriptAdmission as restateEffectAdmission } from '../../packages/@overeng/restate-effect/BUCK.genie.ts'
import { buck2TypeScriptAdmission as stylexTokensAdmission } from '../../packages/@overeng/stylex-tokens/BUCK.genie.ts'
import { buck2TypeScriptAdmission as tuiCoreAdmission } from '../../packages/@overeng/tui-core/BUCK.genie.ts'
import { buck2TypeScriptAdmission as tuiReactAdmission } from '../../packages/@overeng/tui-react/BUCK.genie.ts'
import { buck2TypeScriptAdmission as utilsAdmission } from '../../packages/@overeng/utils/BUCK.genie.ts'
import { buck2TypeScriptAdmission as utilsDevAdmission } from '../../packages/@overeng/utils-dev/BUCK.genie.ts'
import type {
  Buck2TypeScriptAuthorityMetadata,
  Buck2TypeScriptPackageProjection,
} from './typescript-package-projection.ts'

export type { Buck2TypeScriptAuthorityMetadata } from './typescript-package-projection.ts'

/** Buck TypeScript projection input plus editor publication and optional authority admission. */
export type Buck2TypeScriptAdmission = Buck2TypeScriptPackageProjection & {
  readonly editorViewConsumer: boolean
  readonly authority?: Buck2TypeScriptAuthorityMetadata
}

/** Derived command and manifest data for a Buck-authoritative TypeScript package. */
export type AuthoritativeBuck2TypeScriptAdmission = Buck2TypeScriptAuthorityMetadata & {
  readonly packagePath: string
  readonly typecheckTarget: `//${string}:typecheck`
  readonly distTarget: `//${string}:dist`
}

/** Semantic registry for every package admitted to the Buck TypeScript projection. */
export const buck2TypeScriptAdmissions = {
  agentSessionIngest: agentSessionIngestAdmission,
  ciTools: ciToolsAdmission,
  contentAddress: contentAddressAdmission,
  effectAiClaudeCli: effectAiClaudeCliAdmission,
  effectDistributedLock: effectDistributedLockAdmission,
  effectPath: effectPathAdmission,
  effectReact: effectReactAdmission,
  effectRpcTanstack: effectRpcTanstackAdmission,
  effectSchemaForm: effectSchemaFormAdmission,
  kdl: kdlAdmission,
  notionCli: notionCliAdmission,
  notionCore: notionCoreAdmission,
  notionDatasourceSync: notionDatasourceSyncAdmission,
  notionEffectClient: notionEffectClientAdmission,
  notionEffectSchema: notionEffectSchemaAdmission,
  notionMd: notionMdAdmission,
  notionPropertyWrite: notionPropertyWriteAdmission,
  notionReact: notionReactAdmission,
  npmRelease: npmReleaseAdmission,
  otelContract: otelContractAdmission,
  oxcConfig: oxcConfigAdmission,
  ptyEffect: ptyEffectAdmission,
  reactInspector: reactInspectorAdmission,
  restateEffect: restateEffectAdmission,
  tuiCore: tuiCoreAdmission,
  tuiReact: tuiReactAdmission,
  stylexTokens: stylexTokensAdmission,
  utils: utilsAdmission,
  utilsDev: utilsDevAdmission,
} as const satisfies Record<string, Buck2TypeScriptAdmission>

/** Derives labels rather than duplicating them in package-local authority metadata. */
export const deriveBuck2TypeScriptAuthority = ({
  authority,
  packagePath,
}: Buck2TypeScriptAdmission & {
  readonly authority: Buck2TypeScriptAuthorityMetadata
}): AuthoritativeBuck2TypeScriptAdmission => ({
  declarationEntrypoint: authority.declarationEntrypoint,
  distTarget: `//${packagePath}:dist`,
  packagePath,
  projectFile: authority.projectFile,
  typecheckTarget: `//${packagePath}:typecheck`,
})

/** Registry-ordered packages whose TypeScript checking and declarations are Buck-owned. */
export const authoritativeBuck2TypeScriptAdmissions = Object.values(
  buck2TypeScriptAdmissions,
).flatMap(
  (admission: Buck2TypeScriptAdmission): readonly AuthoritativeBuck2TypeScriptAdmission[] =>
    admission.authority === undefined
      ? []
      : [
          deriveBuck2TypeScriptAuthority({
            ...admission,
            authority: admission.authority,
          }),
        ],
)

/** Dist overlays derived from the same package-local authority declarations. */
export const buck2TypeScriptDistOverlays = authoritativeBuck2TypeScriptAdmissions
  .map(({ distTarget, packagePath }) => ({
    target: distTarget,
    destination: `${packagePath}/dist`,
  }))
  .toSorted((left, right) =>
    Buffer.from(left.destination).compare(Buffer.from(right.destination)),
  )

/** Byte-sorted package paths whose editor dependency surface is currently admitted. */
export const editorViewConsumerPackagePaths = Object.values(buck2TypeScriptAdmissions)
  .filter((admission) => admission.editorViewConsumer === true)
  .map((admission) => admission.packagePath)
  .toSorted((left, right) => Buffer.from(left).compare(Buffer.from(right)))
