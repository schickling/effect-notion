import { Buffer } from 'node:buffer'

import { buck2TypeScriptAdmission as effectSocketExamplesAdmission } from '../../context/effect/socket/BUCK.genie.ts'
import { buck2TypeScriptAdmission as opentuiExamplesAdmission } from '../../context/opentui/BUCK.genie.ts'
import { buck2TypeScriptAdmission as buck2ToolsAdmission } from '../../packages/@overeng/buck2-tools/BUCK.genie.ts'
import { buck2TypeScriptAdmission as agentSessionIngestAdmission } from '../../packages/@overeng/agent-session-ingest/BUCK.genie.ts'
import { buck2TypeScriptAdmission as ciToolsAdmission } from '../../packages/@overeng/ci-tools/BUCK.genie.ts'
import { buck2TypeScriptAdmission as contentAddressAdmission } from '../../packages/@overeng/content-address/BUCK.genie.ts'
import { buck2TypeScriptAdmission as effectAiClaudeCliAdmission } from '../../packages/@overeng/effect-ai-claude-cli/BUCK.genie.ts'
import { buck2TypeScriptAdmission as effectDistributedLockAdmission } from '../../packages/@overeng/effect-distributed-lock/BUCK.genie.ts'
import { buck2TypeScriptAdmission as effectPathAdmission } from '../../packages/@overeng/effect-path/BUCK.genie.ts'
import { buck2TypeScriptAdmission as effectReactAdmission } from '../../packages/@overeng/effect-react/BUCK.genie.ts'
import { buck2TypeScriptAdmission as effectRpcTanstackAdmission } from '../../packages/@overeng/effect-rpc-tanstack/BUCK.genie.ts'
import { buck2TypeScriptAdmission as effectRpcTanstackExampleBasicAdmission } from '../../packages/@overeng/effect-rpc-tanstack/examples/basic/BUCK.genie.ts'
import { buck2TypeScriptAdmission as effectSchemaFormAriaAdmission } from '../../packages/@overeng/effect-schema-form-aria/BUCK.genie.ts'
import { buck2TypeScriptAdmission as effectSchemaFormAdmission } from '../../packages/@overeng/effect-schema-form/BUCK.genie.ts'
import { buck2TypeScriptAdmission as genieAdmission } from '../../packages/@overeng/genie/BUCK.genie.ts'
import { buck2TypeScriptAdmission as kdlEffectAdmission } from '../../packages/@overeng/kdl-effect/BUCK.genie.ts'
import { buck2TypeScriptAdmission as kdlAdmission } from '../../packages/@overeng/kdl/BUCK.genie.ts'
import { buck2TypeScriptAdmission as megarepoAdmission } from '../../packages/@overeng/megarepo/BUCK.genie.ts'
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
import { buck2TypeScriptAdmission as tuiStoriesAdmission } from '../../packages/@overeng/tui-stories/BUCK.genie.ts'
import { buck2TypeScriptAdmission as utilsAdmission } from '../../packages/@overeng/utils/BUCK.genie.ts'
import { buck2TypeScriptAdmission as utilsDevAdmission } from '../../packages/@overeng/utils-dev/BUCK.genie.ts'
import type {
  Buck2TypeScriptAuthorityMetadata,
  Buck2TypeScriptPackageProjection,
} from './typescript-package-projection.ts'

export type { Buck2TypeScriptAuthorityMetadata } from './typescript-package-projection.ts'

/**
 * Buck TypeScript projection input plus optional authority admission.
 *
 * Admission itself publishes the package-local editor dependency view: there is
 * no per-package opt-out, so every admitted package is an editor consumer.
 */
export type Buck2TypeScriptAdmission = Buck2TypeScriptPackageProjection & {
  readonly authority?: Buck2TypeScriptAuthorityMetadata
}

/**
 * `'complete'` exactly while admission carries no editor-publication opt-out.
 * Reintroducing such a flag collapses this to `never`, so the assignment below
 * stops type-checking instead of silently excluding packages from publication.
 */
export type Buck2TypeScriptEditorViewCoverage = Extract<
  keyof Buck2TypeScriptAdmission,
  'editorViewConsumer'
> extends never
  ? 'complete'
  : never

/** Static proof that every admission is an editor view consumer. */
export const buck2TypeScriptEditorViewCoverage: Buck2TypeScriptEditorViewCoverage = 'complete'

/** Derived command and manifest data for a Buck-authoritative TypeScript emit. */
export type AuthoritativeBuck2TypeScriptAdmission = {
  readonly declarationEntrypoint: string
  readonly distTarget: `//${string}:dist`
  readonly packagePath: string
  readonly projectFile: string
  readonly typecheckTarget: `//${string}:typecheck`
}

/** One root TypeScript project whose typecheck is owned by a concrete Buck target. */
export type Buck2TypeScriptAuthorityProject = {
  readonly emitTarget?: `//${string}:dist`
  readonly packagePath: string
  readonly projectFile: string
  readonly projectPath: string
  readonly typecheckTarget: `//${string}:typecheck${string}`
}

/** Semantic registry for every package admitted to the Buck TypeScript projection. */
export const buck2TypeScriptAdmissions = {
  agentSessionIngest: agentSessionIngestAdmission,
  buck2Tools: buck2ToolsAdmission,
  ciTools: ciToolsAdmission,
  contentAddress: contentAddressAdmission,
  effectAiClaudeCli: effectAiClaudeCliAdmission,
  effectDistributedLock: effectDistributedLockAdmission,
  effectPath: effectPathAdmission,
  effectReact: effectReactAdmission,
  effectRpcTanstack: effectRpcTanstackAdmission,
  effectRpcTanstackExampleBasic: effectRpcTanstackExampleBasicAdmission,
  effectSchemaForm: effectSchemaFormAdmission,
  effectSchemaFormAria: effectSchemaFormAriaAdmission,
  effectSocketExamples: effectSocketExamplesAdmission,
  genie: genieAdmission,
  kdl: kdlAdmission,
  kdlEffect: kdlEffectAdmission,
  megarepo: megarepoAdmission,
  notionCli: notionCliAdmission,
  notionCore: notionCoreAdmission,
  notionDatasourceSync: notionDatasourceSyncAdmission,
  notionEffectClient: notionEffectClientAdmission,
  notionEffectSchema: notionEffectSchemaAdmission,
  notionMd: notionMdAdmission,
  notionPropertyWrite: notionPropertyWriteAdmission,
  notionReact: notionReactAdmission,
  npmRelease: npmReleaseAdmission,
  opentuiExamples: opentuiExamplesAdmission,
  otelContract: otelContractAdmission,
  oxcConfig: oxcConfigAdmission,
  ptyEffect: ptyEffectAdmission,
  reactInspector: reactInspectorAdmission,
  restateEffect: restateEffectAdmission,
  tuiCore: tuiCoreAdmission,
  tuiReact: tuiReactAdmission,
  tuiStories: tuiStoriesAdmission,
  stylexTokens: stylexTokensAdmission,
  utils: utilsAdmission,
  utilsDev: utilsDevAdmission,
} as const satisfies Record<string, Buck2TypeScriptAdmission>

/** Derives emission metadata rather than duplicating labels in package-local declarations. */
export const deriveBuck2TypeScriptAuthority = ({
  authority,
  packagePath,
}: Buck2TypeScriptAdmission & {
  readonly authority: Buck2TypeScriptAuthorityMetadata & {
    readonly declarationEntrypoint: string
  }
}): AuthoritativeBuck2TypeScriptAdmission => ({
  declarationEntrypoint: authority.declarationEntrypoint,
  distTarget: `//${packagePath}:dist`,
  packagePath,
  projectFile: authority.projectFile,
  typecheckTarget: `//${packagePath}:typecheck`,
})

/** Registry-ordered package emits whose declarations and dist overlays are Buck-owned. */
export const authoritativeBuck2TypeScriptAdmissions = Object.values(
  buck2TypeScriptAdmissions,
).flatMap(
  (admission: Buck2TypeScriptAdmission): readonly AuthoritativeBuck2TypeScriptAdmission[] =>
    admission.authority?.declarationEntrypoint === undefined
      ? []
      : [
          deriveBuck2TypeScriptAuthority({
            ...admission,
            authority: {
              ...admission.authority,
              declarationEntrypoint: admission.authority.declarationEntrypoint,
            },
          }),
        ],
)

/** Every root TypeScript project transferred to a package-local Buck typecheck target. */
export const buck2TypeScriptAuthorityProjects = Object.values(buck2TypeScriptAdmissions).flatMap(
  (admission: Buck2TypeScriptAdmission): readonly Buck2TypeScriptAuthorityProject[] =>
    admission.authority === undefined
      ? []
      : [
          {
            ...(admission.authority.declarationEntrypoint === undefined
              ? {}
              : { emitTarget: `//${admission.packagePath}:dist` as const }),
            packagePath: admission.packagePath,
            projectFile: admission.authority.projectFile,
            projectPath: admission.packagePath,
            typecheckTarget: `//${admission.packagePath}:typecheck`,
          },
          ...(admission.additionalTypecheckProjects ?? []).map((project) => ({
            packagePath: admission.packagePath,
            projectFile: project.projectFile,
            projectPath: `${admission.packagePath}/${project.projectFile}`,
            typecheckTarget: `//${admission.packagePath}:${project.targetName}` as const,
          })),
        ],
)

/**
 * Dist overlays derived from package-local declarations that actually emit.
 *
 * Ordered on the same key as `normalizeBuckMemberManifest` — target first, destination as the
 * tiebreak — because `buck2-member.json` is emitted through that normalization and the two lists
 * are asserted equal. Sorting on destination alone agrees only while no admitted package path is
 * a prefix of another, which stops holding as soon as a package nests an example (`:` sorts after
 * `/`, so the nested target precedes its parent).
 */
export const buck2TypeScriptDistOverlays = authoritativeBuck2TypeScriptAdmissions
  .map(({ distTarget, packagePath }) => ({
    target: distTarget,
    destination: `${packagePath}/dist`,
  }))
  .toSorted(
    (left, right) =>
      Buffer.from(left.target).compare(Buffer.from(right.target)) ||
      Buffer.from(left.destination).compare(Buffer.from(right.destination)),
  )

/** Byte-sorted package paths of every admission, each an editor view consumer. */
export const editorViewConsumerPackagePaths = Object.values(buck2TypeScriptAdmissions)
  .map((admission) => admission.packagePath)
  .toSorted((left, right) => Buffer.from(left).compare(Buffer.from(right)))

/** Byte-sorted project paths whose TypeScript authority the Buck registry holds. */
export const buck2TypeScriptAuthorityProjectPaths = buck2TypeScriptAuthorityProjects
  .map(({ projectPath }) => projectPath)
  .toSorted((left, right) => Buffer.from(left).compare(Buffer.from(right)))

/** A root TypeScript project the Buck projection cannot own yet, and why. */
export type Buck2TypeScriptAdmissionBlocker = {
  /** Repository-relative project path as `genie/tsconfig-projects.ts` names it. */
  readonly projectPath: string
  /** The mechanism that makes an admission wrong today, not a preference. */
  readonly cause: string
  /** The single change that retires this entry. */
  readonly unblockedBy: string
}

/**
 * Root TypeScript projects deliberately left to root `tsc`.
 *
 * This registry is intentionally empty: all known projects are admitted. It is
 * not the root-install deletion gate; non-TypeScript consumers live below.
 */
export const buck2TypeScriptAdmissionBlockers: Readonly<
  Record<string, Buck2TypeScriptAdmissionBlocker>
> = {}

/** Byte-sorted project paths that root TypeScript still owns. */
export const blockedBuck2TypeScriptProjectPaths = Object.values(buck2TypeScriptAdmissionBlockers)
  .map(({ projectPath }) => projectPath)
  .toSorted((left, right) => Buffer.from(left).compare(Buffer.from(right)))

export type RootInstallConsumerKind = 'lint' | 'genie-megarepo' | 'package-bin' | 'ci'

export type RootInstallConsumerBlocker = {
  readonly kind: RootInstallConsumerKind
  readonly consumers: readonly [string, ...string[]]
  readonly unblockedBy: string
}

/** Non-TypeScript consumers still requiring the repository-root pnpm projection. */
export const rootInstallConsumerBlockers: readonly RootInstallConsumerBlocker[] = []
