import { readFileSync } from 'node:fs'
import process from 'node:process'

import { describe, expect, it } from 'vitest'
import type { GenieContext } from '../../packages/@overeng/genie/src/runtime/core.ts'

import ciWorkflow from '../../.github/workflows/ci.yml.genie.ts'
import dependencyBuck from '../../buck2/dependencies/BUCK.genie.ts'
import agentSessionIngestBuck from '../../packages/@overeng/agent-session-ingest/BUCK.genie.ts'
import ciToolsBuck from '../../packages/@overeng/ci-tools/BUCK.genie.ts'
import contentAddressBuck from '../../packages/@overeng/content-address/BUCK.genie.ts'
import effectAiClaudeCliBuck from '../../packages/@overeng/effect-ai-claude-cli/BUCK.genie.ts'
import effectDistributedLockBuck from '../../packages/@overeng/effect-distributed-lock/BUCK.genie.ts'
import effectPathBuck from '../../packages/@overeng/effect-path/BUCK.genie.ts'
import effectReactBuck from '../../packages/@overeng/effect-react/BUCK.genie.ts'
import effectRpcTanstackBuck from '../../packages/@overeng/effect-rpc-tanstack/BUCK.genie.ts'
import effectSchemaFormBuck from '../../packages/@overeng/effect-schema-form/BUCK.genie.ts'
import kdlBuck from '../../packages/@overeng/kdl/BUCK.genie.ts'
import notionCliBuck from '../../packages/@overeng/notion-cli/BUCK.genie.ts'
import notionCoreBuck from '../../packages/@overeng/notion-core/BUCK.genie.ts'
import notionDatasourceSyncBuck from '../../packages/@overeng/notion-datasource-sync/BUCK.genie.ts'
import notionEffectClientBuck from '../../packages/@overeng/notion-effect-client/BUCK.genie.ts'
import notionEffectSchemaBuck from '../../packages/@overeng/notion-effect-schema/BUCK.genie.ts'
import notionMdBuck from '../../packages/@overeng/notion-md/BUCK.genie.ts'
import notionPropertyWriteBuck from '../../packages/@overeng/notion-property-write/BUCK.genie.ts'
import notionReactBuck from '../../packages/@overeng/notion-react/BUCK.genie.ts'
import npmReleaseBuck from '../../packages/@overeng/npm-release/BUCK.genie.ts'
import otelContractBuck from '../../packages/@overeng/otel-contract/BUCK.genie.ts'
import oxcConfigBuck from '../../packages/@overeng/oxc-config/BUCK.genie.ts'
import ptyEffectBuck from '../../packages/@overeng/pty-effect/BUCK.genie.ts'
import reactInspectorBuck from '../../packages/@overeng/react-inspector/BUCK.genie.ts'
import restateEffectBuck from '../../packages/@overeng/restate-effect/BUCK.genie.ts'
import stylexTokensBuck from '../../packages/@overeng/stylex-tokens/BUCK.genie.ts'
import tuiCoreBuck from '../../packages/@overeng/tui-core/BUCK.genie.ts'
import tuiReactBuck from '../../packages/@overeng/tui-react/BUCK.genie.ts'
import utilsDevBuck from '../../packages/@overeng/utils-dev/BUCK.genie.ts'
import utilsBuck from '../../packages/@overeng/utils/BUCK.genie.ts'
import {
  buck2TypeScriptAdmissions,
  editorViewConsumerPackagePaths,
} from './typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from './typescript-package-projection.ts'

const genieContext: GenieContext = { cwd: process.cwd(), location: '' }

const outputsByAdmission = {
  agentSessionIngest: agentSessionIngestBuck.stringify(genieContext),
  ciTools: ciToolsBuck.stringify(genieContext),
  contentAddress: contentAddressBuck.stringify(genieContext),
  effectAiClaudeCli: effectAiClaudeCliBuck.stringify(genieContext),
  effectDistributedLock: effectDistributedLockBuck.stringify(genieContext),
  effectPath: effectPathBuck.stringify(genieContext),
  effectReact: effectReactBuck.stringify(genieContext),
  effectRpcTanstack: effectRpcTanstackBuck.stringify(genieContext),
  effectSchemaForm: effectSchemaFormBuck.stringify(genieContext),
  kdl: kdlBuck.stringify(genieContext),
  notionCli: notionCliBuck.stringify(genieContext),
  notionCore: notionCoreBuck.stringify(genieContext),
  notionDatasourceSync: notionDatasourceSyncBuck.stringify(genieContext),
  notionEffectClient: notionEffectClientBuck.stringify(genieContext),
  notionEffectSchema: notionEffectSchemaBuck.stringify(genieContext),
  notionMd: notionMdBuck.stringify(genieContext),
  notionPropertyWrite: notionPropertyWriteBuck.stringify(genieContext),
  notionReact: notionReactBuck.stringify(genieContext),
  npmRelease: npmReleaseBuck.stringify(genieContext),
  otelContract: otelContractBuck.stringify(genieContext),
  oxcConfig: oxcConfigBuck.stringify(genieContext),
  ptyEffect: ptyEffectBuck.stringify(genieContext),
  reactInspector: reactInspectorBuck.stringify(genieContext),
  restateEffect: restateEffectBuck.stringify(genieContext),
  stylexTokens: stylexTokensBuck.stringify(genieContext),
  tuiCore: tuiCoreBuck.stringify(genieContext),
  tuiReact: tuiReactBuck.stringify(genieContext),
  utils: utilsBuck.stringify(genieContext),
  utilsDev: utilsDevBuck.stringify(genieContext),
} as const satisfies Record<keyof typeof buck2TypeScriptAdmissions, string>

const admittedPackages = Object.entries(buck2TypeScriptAdmissions).map(([key, admission]) => ({
  output: outputsByAdmission[key as keyof typeof outputsByAdmission],
  importer: admission.dependencyImporter,
  packagePath: admission.packagePath,
}))

const retiredProviderTerms = [
  'pnpm_node_modules',
  'pnpm_editor_inputs',
  'buck2-materializer',
  'pnpm-deploy-normalizer',
  'pnpm-install-descriptor',
  'store_dir',
] as const

describe('declared-closure package projection', () => {
  it('admits only explicitly marked packages to editor publication', () => {
    expect(editorViewConsumerPackagePaths).toEqual(['packages/@overeng/tui-core'])
    expect(buck2TypeScriptAdmissions.tuiReact.editorViewConsumer).toBe(false)
  })

  it('wires each admitted package only to its generated importer', () => {
    for (const admitted of admittedPackages) {
      expect(admitted.output).toContain(`    actual = "${admitted.importer}",`)
      expect(admitted.output).toContain('    actual = ":node_modules",')
      expect(admitted.output).toContain('    runtime = "//:package_tree_runtime",')
      expect(admitted.output).toContain('    runtime_entry = "package-tree.ts",')
      for (const retiredTerm of retiredProviderTerms) {
        expect(admitted.output).not.toContain(retiredTerm)
      }
    }
  })

  it('admits the complete recursive workspace closure for tui-react', () => {
    const tuiReactImporter = dependencyBuck.data.importers.find(
      (importer) => importer.importer === 'packages/@overeng/tui-react',
    )
    expect(tuiReactImporter).toBeDefined()
    const admittedPackagePaths = new Set(admittedPackages.map(({ packagePath }) => packagePath))
    for (const label of Object.values(tuiReactImporter?.workspaceTrees ?? {})) {
      const packagePath = label.slice('//'.length, -':package_tree'.length)
      expect(admittedPackagePaths.has(packagePath), `missing projection for ${label}`).toBe(true)
    }
  })

  it('keeps admitted subpackage inputs out of the root Buck package', () => {
    const rootBuck = readFileSync('BUCK', 'utf8')
    for (const { packagePath } of admittedPackages) {
      expect(rootBuck, `root BUCK still owns files below //${packagePath}`).not.toContain(
        `${packagePath}/`,
      )
    }
    expect(rootBuck).toContain('name = "package_tree_runtime",')
    expect(rootBuck).toContain('packages/@overeng/buck2-tools/src/package-tree.ts')
    for (const admitted of admittedPackages) {
      for (const packagePath of admittedPackages.map(({ packagePath }) => packagePath)) {
        expect(
          admitted.output,
          `//${admitted.packagePath} still references root-owned //:${packagePath} inputs`,
        ).not.toContain(`//:${packagePath}/`)
      }
    }
  })

  it('leaves registry-backed CI dependency downloads uncached', () => {
    const workflow = ciWorkflow.stringify(genieContext)
    expect(workflow).not.toContain('Restore pnpm state')
    expect(workflow).not.toContain('Save pnpm state')
    expect(workflow).not.toContain('pnpm-state-v3-')
    expect(workflow).not.toContain('composition-state/pnpm-store-pure-v1')
  })

  it('projects package-specific declaration entrypoints for authoritative emits', () => {
    const output = buck2TypeScriptPackageProjection({
      ...buck2TypeScriptAdmissions.stylexTokens,
      authority: {
        declarationEntrypoint: 'src/tokens.stylex.d.ts',
        projectFile: 'tsconfig.json',
      },
    }).stringify(genieContext)

    expect(output).toContain('    declaration_entrypoint = "src/tokens.stylex.d.ts",')
  })

  it('projects only package-local handwritten declarations into emit inputs', () => {
    expect(outputsByAdmission.tuiReact).toContain(
      '        "src/storybook/asset-modules.d.ts": "src/storybook/asset-modules.d.ts",',
    )
    expect(outputsByAdmission.utils).toContain(
      '        "src/node/storybook/gate/virtual-modules.d.ts": "src/node/storybook/gate/virtual-modules.d.ts",',
    )
    expect(outputsByAdmission.utils).toContain(
      '        "src/node/stylex/mod-types.d.ts": "src/node/stylex/mod-types.d.ts",',
    )
    expect(outputsByAdmission.utils).toContain(
      '        "src/node/stylex/mod.js": "src/node/stylex/mod.js",',
    )
  })
})

describe('same-cell label projection', () => {
  it('does not name the hub cell in generated packages or hub Starlark', () => {
    for (const admitted of admittedPackages) {
      expect(admitted.output).not.toMatch(/@?effect_utils\/\//u)
      expect(admitted.output).toContain('load("//buck2:materialization.bzl"')
      expect(admitted.output).toContain('//buck2/dependencies:importer_')
      expect(admitted.output).toContain('//:package_tree_runtime')
    }

    const hubSources = [
      'buck2/materialization.bzl',
      'buck2/platforms/defs.bzl',
      'buck2/products/defs.bzl',
      'buck2/toolchains/configured.bzl',
      'buck2/typescript.bzl',
    ].map((path) => readFileSync(path, 'utf8'))
    expect(hubSources.join('\n')).not.toMatch(/@?effect_utils\/\//u)
  })
})
