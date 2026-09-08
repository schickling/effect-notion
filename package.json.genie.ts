// @genie-bootstrap
import effectSocketPkg from './context/effect/socket/package.json.genie.ts'
import opentuiPkg from './context/opentui/package.json.genie.ts'
import { packageJson } from './genie/internal.ts'
import agentSessionIngestPkg from './packages/@overeng/agent-session-ingest/package.json.genie.ts'
import buck2ToolsPkg from './packages/@overeng/buck2-tools/package.json.genie.ts'
import ciToolsPkg from './packages/@overeng/ci-tools/package.json.genie.ts'
import contentAddressPkg from './packages/@overeng/content-address/package.json.genie.ts'
import effectAiClaudeCliPkg from './packages/@overeng/effect-ai-claude-cli/package.json.genie.ts'
import effectDistributedLockPkg from './packages/@overeng/effect-distributed-lock/package.json.genie.ts'
import effectPathPkg from './packages/@overeng/effect-path/package.json.genie.ts'
import effectReactPkg from './packages/@overeng/effect-react/package.json.genie.ts'
import effectRpcTanstackBasicPkg from './packages/@overeng/effect-rpc-tanstack/examples/basic/package.json.genie.ts'
import effectRpcTanstackPkg from './packages/@overeng/effect-rpc-tanstack/package.json.genie.ts'
import effectSchemaFormAriaPkg from './packages/@overeng/effect-schema-form-aria/package.json.genie.ts'
import effectSchemaFormPkg from './packages/@overeng/effect-schema-form/package.json.genie.ts'
import geniePkg from './packages/@overeng/genie/package.json.genie.ts'
import kdlEffectPkg from './packages/@overeng/kdl-effect/package.json.genie.ts'
import kdlPkg from './packages/@overeng/kdl/package.json.genie.ts'
import megarepoPkg from './packages/@overeng/megarepo/package.json.genie.ts'
import notionCliPkg from './packages/@overeng/notion-cli/package.json.genie.ts'
import notionCorePkg from './packages/@overeng/notion-core/package.json.genie.ts'
import notionDatasourceSyncPkg from './packages/@overeng/notion-datasource-sync/package.json.genie.ts'
import notionEffectClientPkg from './packages/@overeng/notion-effect-client/package.json.genie.ts'
import notionEffectSchemaPkg from './packages/@overeng/notion-effect-schema/package.json.genie.ts'
import notionMdPkg from './packages/@overeng/notion-md/package.json.genie.ts'
import notionPropertyWritePkg from './packages/@overeng/notion-property-write/package.json.genie.ts'
import notionReactPkg from './packages/@overeng/notion-react/package.json.genie.ts'
import npmReleasePkg from './packages/@overeng/npm-release/package.json.genie.ts'
import otelContractPkg from './packages/@overeng/otel-contract/package.json.genie.ts'
import oxcConfigPkg from './packages/@overeng/oxc-config/package.json.genie.ts'
import ptyEffectPkg from './packages/@overeng/pty-effect/package.json.genie.ts'
import reactInspectorPkg from './packages/@overeng/react-inspector/package.json.genie.ts'
import restateEffectPkg from './packages/@overeng/restate-effect/package.json.genie.ts'
import stylexTokensPkg from './packages/@overeng/stylex-tokens/package.json.genie.ts'
import tuiCorePkg from './packages/@overeng/tui-core/package.json.genie.ts'
import tuiReactPkg from './packages/@overeng/tui-react/package.json.genie.ts'
import tuiStoriesPkg from './packages/@overeng/tui-stories/package.json.genie.ts'
import utilsDevPkg from './packages/@overeng/utils-dev/package.json.genie.ts'
import utilsPkg from './packages/@overeng/utils/package.json.genie.ts'

/** All package.json genie definitions that belong to the root pnpm workspace */
export const rootWorkspacePackages = [
  agentSessionIngestPkg,
  buck2ToolsPkg,
  contentAddressPkg,
  effectSocketPkg,
  effectAiClaudeCliPkg,
  effectDistributedLockPkg,
  effectPathPkg,
  effectReactPkg,
  effectRpcTanstackBasicPkg,
  effectRpcTanstackPkg,
  effectSchemaFormAriaPkg,
  effectSchemaFormPkg,
  geniePkg,
  kdlPkg,
  kdlEffectPkg,
  megarepoPkg,
  notionCliPkg,
  npmReleasePkg,
  notionCorePkg,
  notionDatasourceSyncPkg,
  notionEffectClientPkg,
  notionEffectSchemaPkg,
  notionMdPkg,
  notionPropertyWritePkg,
  notionReactPkg,
  otelContractPkg,
  oxcConfigPkg,
  ptyEffectPkg,
  opentuiPkg,
  reactInspectorPkg,
  restateEffectPkg,
  stylexTokensPkg,
  tuiCorePkg,
  tuiReactPkg,
  tuiStoriesPkg,
  utilsPkg,
  utilsDevPkg,
  ciToolsPkg,
] as const

const rootWorkspace = packageJson.aggregateFromPackages({
  packages: rootWorkspacePackages,
  name: 'effect-utils-workspace',
  repoName: 'effect-utils',
})

/** Workspace member glob paths derived from the aggregated root package.json */
export const rootWorkspaceMemberPaths = rootWorkspace.data.workspaces

export default rootWorkspace
