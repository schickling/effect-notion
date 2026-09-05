/* oxlint-disable overeng/exports-first -- Exported project registries are derived only after the private path map and coverage assertion are initialized. */
import effectSocketTsconfig from '../context/effect/socket/tsconfig.json.genie.ts'
import opentuiTsconfig from '../context/opentui/tsconfig.json.genie.ts'
import { rootWorkspacePackages } from '../package.json.genie.ts'
import agentSessionIngestTsconfig from '../packages/@overeng/agent-session-ingest/tsconfig.json.genie.ts'
import buck2ToolsTsconfig from '../packages/@overeng/buck2-tools/tsconfig.json.genie.ts'
import ciToolsTsconfig from '../packages/@overeng/ci-tools/tsconfig.json.genie.ts'
import contentAddressTsconfig from '../packages/@overeng/content-address/tsconfig.json.genie.ts'
import effectAiClaudeCliTsconfig from '../packages/@overeng/effect-ai-claude-cli/tsconfig.json.genie.ts'
import effectDistributedLockTsconfig from '../packages/@overeng/effect-distributed-lock/tsconfig.json.genie.ts'
import effectPathTsconfig from '../packages/@overeng/effect-path/tsconfig.json.genie.ts'
import effectReactTsconfig from '../packages/@overeng/effect-react/tsconfig.json.genie.ts'
import effectRpcTanstackBasicTsconfig from '../packages/@overeng/effect-rpc-tanstack/examples/basic/tsconfig.json.genie.ts'
import effectRpcTanstackTsconfig from '../packages/@overeng/effect-rpc-tanstack/tsconfig.json.genie.ts'
import effectSchemaFormAriaTsconfig from '../packages/@overeng/effect-schema-form-aria/tsconfig.json.genie.ts'
import effectSchemaFormTsconfig from '../packages/@overeng/effect-schema-form/tsconfig.json.genie.ts'
import type { GenieOutput, TSConfigArgs } from '../packages/@overeng/genie/src/runtime/mod.ts'
import genieTsconfig from '../packages/@overeng/genie/tsconfig.json.genie.ts'
import kdlEffectTsconfig from '../packages/@overeng/kdl-effect/tsconfig.json.genie.ts'
import kdlTsconfig from '../packages/@overeng/kdl/tsconfig.json.genie.ts'
import megarepoTsconfig from '../packages/@overeng/megarepo/tsconfig.json.genie.ts'
import notionCliTsconfig from '../packages/@overeng/notion-cli/tsconfig.json.genie.ts'
import notionCoreTsconfig from '../packages/@overeng/notion-core/tsconfig.json.genie.ts'
import notionDatasourceSyncTsconfig from '../packages/@overeng/notion-datasource-sync/tsconfig.json.genie.ts'
import notionEffectClientTsconfig from '../packages/@overeng/notion-effect-client/tsconfig.json.genie.ts'
import notionEffectSchemaTsconfig from '../packages/@overeng/notion-effect-schema/tsconfig.json.genie.ts'
import notionMdTsconfig from '../packages/@overeng/notion-md/tsconfig.json.genie.ts'
import notionPropertyWriteTsconfig from '../packages/@overeng/notion-property-write/tsconfig.json.genie.ts'
import notionReactTsconfig from '../packages/@overeng/notion-react/tsconfig.json.genie.ts'
import npmReleaseTsconfig from '../packages/@overeng/npm-release/tsconfig.json.genie.ts'
import otelContractTsconfig from '../packages/@overeng/otel-contract/tsconfig.json.genie.ts'
import oxcConfigTsconfig from '../packages/@overeng/oxc-config/tsconfig.json.genie.ts'
import ptyEffectTsconfig from '../packages/@overeng/pty-effect/tsconfig.json.genie.ts'
import reactInspectorTsconfig from '../packages/@overeng/react-inspector/tsconfig.json.genie.ts'
import reactInspectorStrictConsumerTsconfig from '../packages/@overeng/react-inspector/tsconfig.strict-consumer.json.genie.ts'
import restateEffectTsconfig from '../packages/@overeng/restate-effect/tsconfig.json.genie.ts'
import tuiCoreTsconfig from '../packages/@overeng/tui-core/tsconfig.json.genie.ts'
import tuiReactTsconfig from '../packages/@overeng/tui-react/tsconfig.json.genie.ts'
import tuiStoriesTsconfig from '../packages/@overeng/tui-stories/tsconfig.json.genie.ts'
import utilsDevTsconfig from '../packages/@overeng/utils-dev/tsconfig.json.genie.ts'
import utilsTsconfig from '../packages/@overeng/utils/tsconfig.json.genie.ts'
import { buck2TypeScriptAuthorityProjects } from './buck2/typescript-admissions.ts'

export type Buck2TypeScriptAuthority = {
  readonly _tag: 'Buck2TypeScriptAuthority'
  readonly typecheckTarget?: `//${string}`
  readonly emitTarget?: `//${string}`
}

export type RootTsconfigProject = {
  readonly path: string
  readonly tsconfig: GenieOutput<TSConfigArgs>
  readonly buck2Authority?: Buck2TypeScriptAuthority
}

type RootTsconfigProjectDefinition = Omit<RootTsconfigProject, 'path'>

export const isRootTsconfigCheckProject = (project: RootTsconfigProject): boolean =>
  project.buck2Authority === undefined

export const isRootTsconfigEmitProject = (project: RootTsconfigProject): boolean =>
  project.buck2Authority === undefined

const buck2AuthoritiesByProjectPath: Readonly<Record<string, Buck2TypeScriptAuthority>> =
  Object.fromEntries(
    buck2TypeScriptAuthorityProjects.map(
      ({ emitTarget, projectPath, typecheckTarget }): readonly [
        string,
        Buck2TypeScriptAuthority,
      ] => [
        projectPath,
        {
          _tag: 'Buck2TypeScriptAuthority',
          ...(emitTarget === undefined ? {} : { emitTarget }),
          typecheckTarget,
        },
      ],
    ),
  )

const attachBuck2Authority = ({
  path,
  ...definition
}: RootTsconfigProject): RootTsconfigProject => {
  const buck2Authority = buck2AuthoritiesByProjectPath[path]
  return buck2Authority === undefined
    ? { path, ...definition }
    : { path, ...definition, buck2Authority }
}

export const rootWorkspaceTsconfigProjects = (() => {
  const workspaceTsconfigsByPath: Record<string, RootTsconfigProjectDefinition> = {
    'context/effect/socket': { tsconfig: effectSocketTsconfig },
    'context/opentui': { tsconfig: opentuiTsconfig },
    'packages/@overeng/agent-session-ingest': { tsconfig: agentSessionIngestTsconfig },
    'packages/@overeng/buck2-tools': { tsconfig: buck2ToolsTsconfig },
    'packages/@overeng/ci-tools': { tsconfig: ciToolsTsconfig },
    'packages/@overeng/content-address': { tsconfig: contentAddressTsconfig },
    'packages/@overeng/effect-ai-claude-cli': { tsconfig: effectAiClaudeCliTsconfig },
    'packages/@overeng/effect-distributed-lock': { tsconfig: effectDistributedLockTsconfig },
    'packages/@overeng/effect-path': { tsconfig: effectPathTsconfig },
    'packages/@overeng/effect-react': { tsconfig: effectReactTsconfig },
    'packages/@overeng/effect-rpc-tanstack': { tsconfig: effectRpcTanstackTsconfig },
    'packages/@overeng/effect-rpc-tanstack/examples/basic': {
      tsconfig: effectRpcTanstackBasicTsconfig,
    },
    'packages/@overeng/effect-schema-form': { tsconfig: effectSchemaFormTsconfig },
    'packages/@overeng/effect-schema-form-aria': { tsconfig: effectSchemaFormAriaTsconfig },
    'packages/@overeng/genie': { tsconfig: genieTsconfig },
    'packages/@overeng/kdl': { tsconfig: kdlTsconfig },
    'packages/@overeng/kdl-effect': { tsconfig: kdlEffectTsconfig },
    'packages/@overeng/megarepo': { tsconfig: megarepoTsconfig },
    'packages/@overeng/notion-cli': { tsconfig: notionCliTsconfig },
    'packages/@overeng/npm-release': { tsconfig: npmReleaseTsconfig },
    'packages/@overeng/notion-core': { tsconfig: notionCoreTsconfig },
    'packages/@overeng/notion-datasource-sync': { tsconfig: notionDatasourceSyncTsconfig },
    'packages/@overeng/notion-effect-client': { tsconfig: notionEffectClientTsconfig },
    'packages/@overeng/notion-effect-schema': { tsconfig: notionEffectSchemaTsconfig },
    'packages/@overeng/notion-md': { tsconfig: notionMdTsconfig },
    'packages/@overeng/notion-property-write': { tsconfig: notionPropertyWriteTsconfig },
    'packages/@overeng/notion-react': { tsconfig: notionReactTsconfig },
    'packages/@overeng/otel-contract': { tsconfig: otelContractTsconfig },
    'packages/@overeng/oxc-config': { tsconfig: oxcConfigTsconfig },
    'packages/@overeng/pty-effect': { tsconfig: ptyEffectTsconfig },
    'packages/@overeng/react-inspector': { tsconfig: reactInspectorTsconfig },
    'packages/@overeng/restate-effect': { tsconfig: restateEffectTsconfig },
    'packages/@overeng/tui-core': { tsconfig: tuiCoreTsconfig },
    'packages/@overeng/tui-react': { tsconfig: tuiReactTsconfig },
    'packages/@overeng/tui-stories': { tsconfig: tuiStoriesTsconfig },
    'packages/@overeng/utils': { tsconfig: utilsTsconfig },
    'packages/@overeng/utils-dev': { tsconfig: utilsDevTsconfig },
  }
  const rootWorkspacePackagePaths = rootWorkspacePackages.map(
    (pkg) => pkg.meta.workspace.memberPath,
  )
  const missingTsconfigPaths = rootWorkspacePackagePaths.filter(
    (path) => workspaceTsconfigsByPath[path] === undefined,
  )
  const extraTsconfigPaths = Object.keys(workspaceTsconfigsByPath).filter(
    (path) => rootWorkspacePackagePaths.includes(path) === false,
  )
  if (missingTsconfigPaths.length > 0 || extraTsconfigPaths.length > 0) {
    throw new Error(
      [
        'root tsconfig project registry drifted from rootWorkspacePackages',
        missingTsconfigPaths.length > 0
          ? `missing tsconfig data for workspace packages: ${missingTsconfigPaths.join(', ')}`
          : undefined,
        extraTsconfigPaths.length > 0
          ? `tsconfig data without workspace package: ${extraTsconfigPaths.join(', ')}`
          : undefined,
      ]
        .filter((line) => line !== undefined)
        .join('\n'),
    )
  }

  return rootWorkspacePackagePaths.map((path): RootTsconfigProject => {
    const definition = workspaceTsconfigsByPath[path]
    if (definition === undefined) {
      throw new Error(`missing tsconfig data for workspace package: ${path}`)
    }
    return attachBuck2Authority({ path, ...definition })
  })
})()

export const extraRootTsconfigProjects = [
  attachBuck2Authority({
    path: 'packages/@overeng/react-inspector/tsconfig.strict-consumer.json',
    tsconfig: reactInspectorStrictConsumerTsconfig,
  }),
] satisfies readonly RootTsconfigProject[]

export const rootTsconfigProjects = [
  ...rootWorkspaceTsconfigProjects,
  ...extraRootTsconfigProjects,
] as const
