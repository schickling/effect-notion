import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { describe, expect, it } from 'vitest'

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
import genieBuck from '../../packages/@overeng/genie/BUCK.genie.ts'
import kdlEffectBuck from '../../packages/@overeng/kdl-effect/BUCK.genie.ts'
import kdlBuck from '../../packages/@overeng/kdl/BUCK.genie.ts'
import megarepoBuck from '../../packages/@overeng/megarepo/BUCK.genie.ts'
import type { GenieContext } from '../../packages/@overeng/genie/src/runtime/core.ts'
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
import tuiStoriesBuck from '../../packages/@overeng/tui-stories/BUCK.genie.ts'
import utilsDevBuck from '../../packages/@overeng/utils-dev/BUCK.genie.ts'
import utilsBuck from '../../packages/@overeng/utils/BUCK.genie.ts'
import {
  buck2TypeScriptAdmissions,
  editorViewConsumerPackagePaths,
} from './typescript-admissions.ts'
import {
  buck2TypeScriptPackageProjection,
  type Buck2TypeScriptPackageProjection,
} from './typescript-package-projection.ts'

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
  genie: genieBuck.stringify(genieContext),
  kdl: kdlBuck.stringify(genieContext),
  kdlEffect: kdlEffectBuck.stringify(genieContext),
  megarepo: megarepoBuck.stringify(genieContext),
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
  tuiStories: tuiStoriesBuck.stringify(genieContext),
  utils: utilsBuck.stringify(genieContext),
  utilsDev: utilsDevBuck.stringify(genieContext),
} as const satisfies Record<keyof typeof buck2TypeScriptAdmissions, string>

const admittedPackages = Object.entries(buck2TypeScriptAdmissions).map(([key, admission]) => ({
  output: outputsByAdmission[key as keyof typeof outputsByAdmission],
  dependencyView: admission.dependencyImporter.replace(':importer_', ':view_'),
  packagePath: admission.packagePath,
}))

// Deliberately re-derived from the working tree with the runners' own default selection
// (`*.{test,spec}.?(c|m)[jt]s?(x)`) instead of any projection helper: the point is to fail
// when the projection and the collectable set disagree, which a shared helper would hide.
const collectableTestSelection = /\.(?:spec|test)\.[cm]?[jt]sx?$/

const collectableTestModulesOf = ({
  packagePath,
  sourceRoots,
}: {
  readonly packagePath: string
  readonly sourceRoots: readonly string[]
}): readonly string[] => {
  const packageRoot = path.join(process.cwd(), packagePath)
  return sourceRoots
    .flatMap((sourceRoot) =>
      readdirSync(path.join(packageRoot, sourceRoot), { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() === true)
        .map((entry) =>
          path.relative(packageRoot, path.join(entry.parentPath, entry.name)),
        ),
    )
    .filter((file) => collectableTestSelection.test(file) === true)
    .toSorted()
}

const snapshotBaselineOf = (testModule: string): string =>
  path.posix.join(
    path.posix.dirname(testModule),
    '__snapshots__',
    `${path.posix.basename(testModule)}.snap`,
  )

/** Extensions the TypeScript source census admits; everything else is runner-only. */
const typeScriptSourceSelection = /\.(?:cts|js|mts|ts|tsx)$/

/**
 * Destinations one rendered `package_view` stages. Parsed out of the emitted Starlark rather
 * than read off the projection's semantic data: the file a lane actually runs in is the one
 * Buck reads, so the assertions have to be made against that text.
 */
const stagedFilesOf = ({
  output,
  tree,
}: {
  readonly output: string
  readonly tree: string
}): readonly string[] => {
  const target = output.split(`package_view(\n    name = "${tree}",\n`)[1]
  if (target === undefined) return []
  const files = target.split('    files = {\n')[1]?.split('\n    },')[0]
  if (files === undefined) throw new Error(`package_view ${tree} renders no files map`)
  return [...files.matchAll(/^ {8}"([^"]+)": /gmu)].map(([, destination]) => destination ?? '')
}

const admittedTestLanes = Object.entries(buck2TypeScriptAdmissions).flatMap(
  ([key, admission]) =>
    admission.tests === undefined
      ? []
      : [
          {
            output: outputsByAdmission[key as keyof typeof outputsByAdmission],
            packagePath: admission.packagePath,
            sourceRoots: admission.sourceRoots,
          },
        ],
)

const editorViewTarget = `editor_view_inputs(
    name = "editor_view_inputs",
    editor_inputs = ":editor_inputs",
    package_tree = ":package_tree",`

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

  it('wires each admitted package only to its normalized dependency view', () => {
    for (const admitted of admittedPackages) {
      expect(admitted.output).toContain(`    actual = "${admitted.dependencyView}",`)
      expect(admitted.output).toContain(`    dependency_view = "${admitted.dependencyView}",`)
      expect(admitted.output).toContain('    actual = ":node_modules",')
      expect(admitted.output).not.toContain('//buck2/dependencies:importer_')
      expect(admitted.output).toContain('    runtime = "//:package_tree_runtime",')
      expect(admitted.output).toContain('    runtime_entry = "package-tree.ts",')
      expect(admitted.output).toContain('load("//buck2:editor_view.bzl", "editor_view_inputs")')
      expect(admitted.output).toContain(editorViewTarget)
      expect(admitted.output.split('    name = "editor_view_inputs",')).toHaveLength(2)
      for (const retiredTerm of retiredProviderTerms) {
        expect(admitted.output).not.toContain(retiredTerm)
      }
    }
  })

  it('admits the complete recursive workspace closure for tui-react', () => {
    const tuiReactView = dependencyBuck.data.store.views.find(
      (view) => view.importer === 'packages/@overeng/tui-react',
    )
    expect(tuiReactView).toBeDefined()
    const admittedPackagePaths = new Set(admittedPackages.map(({ packagePath }) => packagePath))
    for (const label of Object.values(tuiReactView?.workspaceTrees ?? {})) {
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
      expect(admitted.output).toContain('//buck2/dependencies:view_')
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

describe('declared test lanes', () => {
  // Spelled out rather than spread-with-undefined: `exactOptionalPropertyTypes` makes an
  // explicit `tests: undefined` a different type from an absent lane declaration.
  const kdlAdmissionWithoutTests: Buck2TypeScriptPackageProjection = {
    dependencyImporter: buck2TypeScriptAdmissions.kdl.dependencyImporter,
    packageName: buck2TypeScriptAdmissions.kdl.packageName,
    packagePath: buck2TypeScriptAdmissions.kdl.packagePath,
    projectionSource: buck2TypeScriptAdmissions.kdl.projectionSource,
    sourceRoots: buck2TypeScriptAdmissions.kdl.sourceRoots,
  }

  it('emits no test target, test rule load or test tree for a package without lanes', () => {
    const output = buck2TypeScriptPackageProjection(kdlAdmissionWithoutTests).stringify(
      genieContext,
    )

    expect(output).not.toContain('load("//buck2:javascript.bzl"')
    expect(output).not.toContain('vitest_test(')
    expect(output).not.toContain('    name = "test",')
    expect(output).not.toContain('test_package_tree')
    expect(stagedFilesOf({ output, tree: 'test_package_tree' })).toEqual([])
  })

  it('emits the default lane against the test tree that carries the config it loads', () => {
    expect(outputsByAdmission.kdl).toContain('load("//buck2:javascript.bzl", "vitest_test")')
    expect(outputsByAdmission.kdl).toContain(
      ['vitest_test(', '    name = "test",', '    package_tree = ":test_package_tree",'].join('\n'),
    )
    expect(stagedFilesOf({ output: outputsByAdmission.kdl, tree: 'test_package_tree' })).toContain(
      'vitest.config.ts',
    )
    // The compile tree is what typecheck, emit and the editor read; a runner-only config in
    // there would rebuild every compile action for a file no compiler opens.
    expect(
      stagedFilesOf({ output: outputsByAdmission.kdl, tree: 'package_tree' }),
    ).not.toContain('vitest.config.ts')
    // The default config and timeouts are the rule's own defaults and stay unstated.
    expect(outputsByAdmission.kdl).not.toContain('    config = "vitest.config.ts",')
    expect(outputsByAdmission.kdl).not.toContain('    timeout_ms =')
  })

  it('stages the package-root files the declared config loads into the test tree only', () => {
    expect(
      stagedFilesOf({ output: outputsByAdmission.reactInspector, tree: 'test_package_tree' }),
    ).toContain('vitest.setup.ts')
    expect(
      stagedFilesOf({ output: outputsByAdmission.reactInspector, tree: 'package_tree' }),
    ).not.toContain('vitest.setup.ts')
  })

  it('stages the declared non-TypeScript test data the census cannot see', () => {
    expect(stagedFilesOf({ output: outputsByAdmission.kdl, tree: 'test_package_tree' })).toContain(
      'test-fixtures/expected_kdl/all_escapes.kdl',
    )
    expect(
      stagedFilesOf({ output: outputsByAdmission.notionMd, tree: 'test_package_tree' }),
    ).toContain('demo/showcase.nmd')
    // Fixture data is runner-only input; the compile tree never carries it.
    expect(stagedFilesOf({ output: outputsByAdmission.kdl, tree: 'package_tree' })).not.toContain(
      'test-fixtures/expected_kdl/all_escapes.kdl',
    )

    expect(() =>
      buck2TypeScriptPackageProjection({
        ...kdlAdmissionWithoutTests,
        testDataRoots: [{ root: 'test-fixtures', extensions: ['.nmd'] }],
      }).stringify(genieContext),
    ).toThrow('Test data census found no .nmd inputs')
  })

  it('stages every collectable test module of every admitted lane in its test tree', () => {
    expect(admittedTestLanes.length).toBeGreaterThan(1)

    for (const lane of admittedTestLanes) {
      const modules = collectableTestModulesOf(lane)
      expect(
        modules.length,
        `//${lane.packagePath} declares a test lane but no source root holds a collectable module`,
      ).toBeGreaterThan(0)
      const testTree = stagedFilesOf({ output: lane.output, tree: 'test_package_tree' })
      const compileTree = stagedFilesOf({ output: lane.output, tree: 'package_tree' })
      for (const testModule of modules) {
        expect(
          testTree,
          `//${lane.packagePath}:test cannot collect ${testModule}: the test package tree omits it`,
        ).toContain(testModule)
        // A module the TypeScript census rejects is runner-only and stays out of compile.
        if (typeScriptSourceSelection.test(testModule) === false) {
          expect(
            compileTree,
            `//${lane.packagePath} compile tree carries the runner-only module ${testModule}`,
          ).not.toContain(testModule)
        }
      }
    }
  })

  it('stages the snapshot baseline of every staged test module in its test tree', () => {
    const stagedBaselines = admittedTestLanes.flatMap((lane) => {
      const testTree = stagedFilesOf({ output: lane.output, tree: 'test_package_tree' })
      const compileTree = stagedFilesOf({ output: lane.output, tree: 'package_tree' })
      return collectableTestModulesOf(lane)
        .map(snapshotBaselineOf)
        .filter((baseline) =>
          existsSync(path.join(process.cwd(), lane.packagePath, baseline)),
        )
        .map((baseline) => {
          expect(
            testTree,
            `//${lane.packagePath}:test runs under CI=true and cannot write ${baseline}: the test package tree omits it`,
          ).toContain(baseline)
          expect(
            compileTree,
            `//${lane.packagePath} compile tree carries the baseline ${baseline}`,
          ).not.toContain(baseline)
          return `${lane.packagePath}/${baseline}`
        })
    })

    // The registry-wide sweep only proves an inclusion; these name the baselines the two
    // reported lanes lost, so a narrowing of the census cannot pass unnoticed.
    expect(stagedBaselines).toContain(
      'packages/@overeng/ci-tools/src/__snapshots__/cli.contract.test.ts.snap',
    )
    expect(stagedBaselines).toContain(
      'packages/@overeng/react-inspector/src/object/__snapshots__/ObjectName.spec.jsx.snap',
    )
  })

  it('splits the React Inspector JSX specs and live baselines out of its compile tree', () => {
    const testTree = stagedFilesOf({
      output: outputsByAdmission.reactInspector,
      tree: 'test_package_tree',
    })
    const compileTree = stagedFilesOf({
      output: outputsByAdmission.reactInspector,
      tree: 'package_tree',
    })
    const jsxSpecs = [
      'src/object-inspector/ObjectInspector.spec.jsx',
      'src/object/ObjectName.spec.jsx',
      'src/object/ObjectValue.spec.jsx',
      'src/table-inspector/getHeaders.spec.jsx',
      'src/tree-view/pathUtils.spec.jsx',
    ]

    expect(testTree.filter((file) => file.endsWith('.spec.jsx'))).toEqual(jsxSpecs)
    for (const specModule of jsxSpecs) {
      expect(compileTree).not.toContain(specModule)
    }
    // Exactly the baselines whose `.spec.jsx` module still exists; the three retired
    // `.spec.js` baselines were collected by nothing and are deleted, not staged.
    expect(testTree.filter((file) => file.endsWith('.snap'))).toEqual([
      'src/object-inspector/__snapshots__/ObjectInspector.spec.jsx.snap',
      'src/object/__snapshots__/ObjectName.spec.jsx.snap',
      'src/object/__snapshots__/ObjectValue.spec.jsx.snap',
    ])
    expect(outputsByAdmission.reactInspector).not.toContain('.spec.js.snap')
    for (const orphan of [
      'src/object-inspector/__snapshots__/ObjectInspector.spec.js.snap',
      'src/object/__snapshots__/ObjectName.spec.js.snap',
      'src/object/__snapshots__/ObjectValue.spec.js.snap',
    ]) {
      expect(
        existsSync(path.join(process.cwd(), 'packages/@overeng/react-inspector', orphan)),
        `${orphan} has no collecting module and must not be committed`,
      ).toBe(false)
    }
    // A `.jsx` spec is a test module, not a TypeScript source: it must not reach emit inputs.
    expect(outputsByAdmission.reactInspector).not.toContain(
      '    "src/object/ObjectName.spec.jsx",',
    )
  })

  it('reads a task-supplied host path from a derived config key', () => {
    const output = buck2TypeScriptPackageProjection({
      ...kdlAdmissionWithoutTests,
      tests: [{ name: 'test', runner: 'vitest', configuredExternalInputs: ['NODE_PTY_PACKAGE'] }],
    }).stringify(genieContext)

    expect(output).toContain(
      '        "NODE_PTY_PACKAGE": read_config("javascript_test_inputs", "kdl_test_node_pty_package", ""),',
    )
  })

  it('projects the node Vitest runtime only with its attested executable', () => {
    expect(outputsByAdmission.notionDatasourceSync).toContain('    vitest_runtime = "node",')
    expect(outputsByAdmission.notionDatasourceSync).toContain(
      '        "NODE_BIN": "//buck2/toolchains:tool_node",',
    )

    expect(() =>
      buck2TypeScriptPackageProjection({
        ...kdlAdmissionWithoutTests,
        tests: [{ name: 'test', runner: 'vitest', vitestRuntime: 'node' }],
      }).stringify(genieContext),
    ).toThrow('requires a declared NODE_BIN tool')
  })

  it('refuses a cacheable lane that reads the ambient environment', () => {
    expect(() =>
      buck2TypeScriptPackageProjection({
        ...kdlAdmissionWithoutTests,
        tests: [{ name: 'test', runner: 'vitest', inheritedEnv: ['NOTION_API_TOKEN'] }],
      }).stringify(genieContext),
    ).toThrow('must declare cacheable: false')
  })

  it('refuses test selections the package tree does not carry', () => {
    expect(() =>
      buck2TypeScriptPackageProjection({
        ...kdlAdmissionWithoutTests,
        tests: [{ name: 'test', runner: 'vitest', testFiles: ['e2e/live.test.ts'] }],
      }).stringify(genieContext),
    ).toThrow('declare e2e in sourceRoots')
  })

  it('renders a second named lane deterministically after the default one', () => {
    const projection = buck2TypeScriptPackageProjection({
      ...kdlAdmissionWithoutTests,
      tests: [
        { name: 'test', runner: 'vitest', excludes: ['src/upstream.test.ts'] },
        {
          name: 'test_upstream',
          runner: 'vitest',
          testFiles: ['src/upstream.test.ts'],
          timeoutMs: 120_000,
          writableDirectories: { KDL_WORKSPACE: 'kdl' },
        },
      ],
    })
    const output = projection.stringify(genieContext)

    expect(output).toBe(projection.stringify(genieContext))
    expect(output.indexOf('    name = "test",')).toBeLessThan(
      output.indexOf('    name = "test_upstream",'),
    )
    expect(output).toContain(
      [
        'vitest_test(',
        '    name = "test_upstream",',
        '    package_tree = ":test_package_tree",',
        '    test_files = [',
        '        "src/upstream.test.ts",',
        '    ],',
        '    timeout_ms = 120000,',
        '    writable_directories = {',
        '        "KDL_WORKSPACE": "kdl",',
        '    },',
        '    visibility = ["PUBLIC"],',
        ')',
      ].join('\n'),
    )

    expect(() =>
      buck2TypeScriptPackageProjection({
        ...kdlAdmissionWithoutTests,
        tests: [{ name: 'test_upstream', runner: 'vitest' }],
      }).stringify(genieContext),
    ).toThrow('must be named test')
  })

  it('carries the declared lane into the schema version and semantic fingerprint', () => {
    const fingerprintOf = (output: string): string =>
      output.split('# Semantic fingerprint: ')[1]?.split('\n')[0] ?? ''
    const withoutTests = buck2TypeScriptPackageProjection(kdlAdmissionWithoutTests).stringify(
      genieContext,
    )
    const withLongerTimeout = buck2TypeScriptPackageProjection({
      ...buck2TypeScriptAdmissions.kdl,
      tests: [{ name: 'test', runner: 'vitest', timeoutMs: 60_000 }],
    }).stringify(genieContext)

    expect(outputsByAdmission.kdl).toContain('# Projection schema version: 6')
    expect(fingerprintOf(outputsByAdmission.kdl)).not.toBe(fingerprintOf(withoutTests))
    expect(fingerprintOf(outputsByAdmission.kdl)).not.toBe(fingerprintOf(withLongerTimeout))
  })

  it('names the JavaScript action runtime as the runner every lane executes', () => {
    const rules = readFileSync('buck2/javascript.bzl', 'utf8')
    expect(rules).not.toContain('//packages/@overeng/buck2-tools:javascript_action_runtime')
    expect(rules.split('default = "//:javascript_action_runtime",')).toHaveLength(3)
    expect(readFileSync('BUCK', 'utf8')).toContain('    name = "javascript_action_runtime",')
  })
})
