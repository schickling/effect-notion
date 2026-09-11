import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { describe, expect, it } from 'vitest'

import ciWorkflow from '../../.github/workflows/ci.yml.genie.ts'
import dependencyBuck from '../../buck2/dependencies/BUCK.genie.ts'
import type { GenieContext } from '../../packages/@overeng/genie/src/runtime/core.ts'
import {
  buck2TestLanes,
  buck2TypeScriptAdmissions,
  editorViewConsumerPackagePaths,
} from './typescript-admissions.ts'
import {
  buck2TypeScriptPackageProjection,
  type Buck2TypeScriptPackageProjection,
} from './typescript-package-projection.ts'

const genieContext: GenieContext = { cwd: process.cwd(), location: '' }
const buck2ToolsBuck = readFileSync('packages/@overeng/buck2-tools/BUCK', 'utf8')

const outputsByAdmission = Object.fromEntries(
  Object.entries(buck2TypeScriptAdmissions).map(([name, admission]) => [
    name,
    readFileSync(path.join(admission.packagePath, 'BUCK'), 'utf8'),
  ]),
) as Record<keyof typeof buck2TypeScriptAdmissions, string>

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
        .map((entry) => path.relative(packageRoot, path.join(entry.parentPath, entry.name))),
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

const admittedTestLanes = Object.entries(buck2TypeScriptAdmissions).flatMap(([key, admission]) =>
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
      expect(admitted.output).toContain(
        '    runtime = "//packages/@overeng/buck2-tools:package_tree_runtime",',
      )
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
    expect(rootBuck).not.toContain('name = "package_tree_runtime",')
    expect(buck2ToolsBuck).toContain('name = "package_tree_runtime",')
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
      authorities: [
        {
          declarationEntrypoint: 'src/tokens.stylex.d.ts',
          projectFile: 'tsconfig.json',
        },
      ],
    }).stringify(genieContext)

    expect(output).toContain('    declaration_entrypoint = "src/tokens.stylex.d.ts",')
  })

  it('projects an additional no-emit project under its own typecheck target', () => {
    const output = outputsByAdmission.reactInspector

    expect(output).toContain('    name = "strict_consumer_typecheck",')
    expect(output).toContain('    project = "tsconfig.strict-consumer.json",')
    expect(output.split('    name = "dist",')).toHaveLength(2)
  })

  it('refuses an unnamed additional authority project', () => {
    expect(() =>
      buck2TypeScriptPackageProjection({
        ...buck2TypeScriptAdmissions.reactInspector,
        authorities: [
          {
            declarationEntrypoint: 'src/index.d.ts',
            projectFile: 'tsconfig.json',
          },
          {
            projectFile: 'tsconfig.strict-consumer.json',
            projectPath: 'packages/@overeng/react-inspector/tsconfig.strict-consumer.json',
          },
        ],
      }).stringify(genieContext),
    ).toThrow('must name its typecheck target')
  })

  it.each(['dist', 'package_tree', 'test', 'test_collect'])(
    'refuses a typecheck target that collides with generated target %s',
    (typecheckTargetName) => {
      expect(() =>
        buck2TypeScriptPackageProjection({
          ...buck2TypeScriptAdmissions.kdl,
          authorities: [
            {
              declarationEntrypoint: 'src/mod.d.ts',
              projectFile: 'tsconfig.json',
              typecheckTargetName,
            },
          ],
        }).stringify(genieContext),
      ).toThrow('collides with generated Buck target')
    },
  )

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
      expect(admitted.output).toContain('//packages/@overeng/buck2-tools:package_tree_runtime')
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
    authorities: buck2TypeScriptAdmissions.kdl.authorities,
    dependencyImporter: buck2TypeScriptAdmissions.kdl.dependencyImporter,
    packageName: buck2TypeScriptAdmissions.kdl.packageName,
    packagePath: buck2TypeScriptAdmissions.kdl.packagePath,
    projectionSource: buck2TypeScriptAdmissions.kdl.projectionSource,
    sourceRoots: buck2TypeScriptAdmissions.kdl.sourceRoots,
  }

  it('emits no test target, test rule load or test tree for a package without lanes', () => {
    const output =
      buck2TypeScriptPackageProjection(kdlAdmissionWithoutTests).stringify(genieContext)

    expect(output).not.toContain('load("//buck2:javascript.bzl"')
    expect(output).not.toContain('vitest_test(')
    expect(output).not.toContain('vitest_collect(')
    expect(output).not.toContain('    name = "test",')
    expect(output).not.toContain('test_package_tree')
    expect(stagedFilesOf({ output, tree: 'test_package_tree' })).toEqual([])
  })

  it('emits the default lane against the test tree that carries the config it loads', () => {
    expect(outputsByAdmission.kdl).toContain(
      'load("//buck2:javascript.bzl", "vitest_collect", "vitest_test")',
    )
    expect(outputsByAdmission.kdl).toContain(
      ['vitest_test(', '    name = "test",', '    package_tree = ":test_package_tree",'].join('\n'),
    )
    expect(stagedFilesOf({ output: outputsByAdmission.kdl, tree: 'test_package_tree' })).toContain(
      'vitest.config.ts',
    )
    expect(outputsByAdmission.kdl).toContain('    strip_project_references = True,')
    // The compile tree is what typecheck, emit and the editor read; a runner-only config in
    // there would rebuild every compile action for a file no compiler opens.
    expect(stagedFilesOf({ output: outputsByAdmission.kdl, tree: 'package_tree' })).not.toContain(
      'vitest.config.ts',
    )
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
        .filter((baseline) => existsSync(path.join(process.cwd(), lane.packagePath, baseline)))
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
    expect(outputsByAdmission.reactInspector).not.toContain('    "src/object/ObjectName.spec.jsx",')
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

  it('refuses a Vitest lane that reads the ambient environment', () => {
    expect(() =>
      buck2TypeScriptPackageProjection({
        ...kdlAdmissionWithoutTests,
        tests: [{ name: 'test', runner: 'vitest', inheritedEnv: ['NOTION_API_TOKEN'] }],
      }).stringify(genieContext),
    ).toThrow('derived collection action requires every input in the action identity')
  })

  it('refuses an uncacheable Vitest lane because its collection stays cacheable', () => {
    expect(() =>
      buck2TypeScriptPackageProjection({
        ...kdlAdmissionWithoutTests,
        tests: [{ name: 'test', runner: 'vitest', cacheable: false }],
      }).stringify(genieContext),
    ).toThrow('derived collection action has no per-action remote-cache read switch')
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
    const withoutTests =
      buck2TypeScriptPackageProjection(kdlAdmissionWithoutTests).stringify(genieContext)
    const withLongerTimeout = buck2TypeScriptPackageProjection({
      ...buck2TypeScriptAdmissions.kdl,
      tests: [{ name: 'test', runner: 'vitest', timeoutMs: 60_000 }],
    }).stringify(genieContext)

    expect(outputsByAdmission.kdl).toContain('# Projection schema version: 9')
    expect(fingerprintOf(outputsByAdmission.kdl)).not.toBe(fingerprintOf(withoutTests))
    expect(fingerprintOf(outputsByAdmission.kdl)).not.toBe(fingerprintOf(withLongerTimeout))
  })

  it('names the JavaScript action runtime as the runner every lane executes', () => {
    const rules = readFileSync('buck2/javascript.bzl', 'utf8')
    expect(
      rules.split('default = "//packages/@overeng/buck2-tools:javascript_action_runtime",'),
    ).toHaveLength(3)
    expect(buck2ToolsBuck).toContain('    name = "javascript_action_runtime",')
  })
})

describe('derived test collection targets', () => {
  const kdlAdmission = buck2TypeScriptAdmissions.kdl

  it('projects one collection sibling per Vitest lane from the same validated inputs', () => {
    for (const lane of admittedTestLanes) {
      const executions = lane.output.split('\nvitest_test(\n').length - 1
      const collections = lane.output.split('\nvitest_collect(\n').length - 1
      expect(collections, `//${lane.packagePath} projects ${executions} lanes`).toBe(executions)
    }

    // Same package tree, same visibility, same derived name: one declaration, two targets.
    expect(outputsByAdmission.kdl).toContain(
      [
        'vitest_collect(',
        '    name = "test_collect",',
        '    package_tree = ":test_package_tree",',
        '    visibility = ["PUBLIC"],',
        ')',
      ].join('\n'),
    )
  })

  it('carries every collect-supported attribute and drops the two the rule rejects', () => {
    const output = buck2TypeScriptPackageProjection({
      ...kdlAdmission,
      tests: [
        {
          name: 'test',
          runner: 'vitest',
          excludes: ['src/mod.test.ts'],
          env: { KDL_MODE: 'strict' },
          hookTimeoutMs: 45_000,
          labels: ['local-only'],
          timeoutMs: 120_000,
          vitestRuntime: 'node',
          tools: { NODE_BIN: '//buck2/toolchains:tool_node' },
          writableDirectories: { KDL_WORKSPACE: 'kdl' },
        },
      ],
    }).stringify(genieContext)
    const collectBlock = output.split('\nvitest_collect(\n')[1]?.split('\n)\n')[0] ?? ''

    expect(collectBlock).toContain('    name = "test_collect",')
    expect(collectBlock).toContain('        "KDL_MODE": "strict",')
    expect(collectBlock).toContain('        "src/mod.test.ts",')
    expect(collectBlock).toContain('        "local-only",')
    expect(collectBlock).toContain('        "NODE_BIN": "//buck2/toolchains:tool_node",')
    expect(collectBlock).toContain('    vitest_runtime = "node",')
    expect(collectBlock).toContain('        "KDL_WORKSPACE": "kdl",')
    // Both bound a running test; the collect rule has no attribute for either.
    expect(collectBlock).not.toContain('timeout_ms')
    expect(collectBlock).not.toContain('hook_timeout_ms')
    // The execution lane keeps them, so the two targets differ in exactly those attributes.
    const executionBlock = output.split('\nvitest_test(\n')[1]?.split('\n)\n')[0] ?? ''
    expect(executionBlock).toContain('    timeout_ms = 120000,')
    expect(executionBlock).toContain('    hook_timeout_ms = 45000,')
  })

  it('reuses the execution lane config keys instead of deriving a second set', () => {
    const output = buck2TypeScriptPackageProjection({
      ...kdlAdmission,
      tests: [{ name: 'test', runner: 'vitest', configuredExternalInputs: ['NODE_PTY_PACKAGE'] }],
    }).stringify(genieContext)

    expect(
      output.split(
        '        "NODE_PTY_PACKAGE": read_config("javascript_test_inputs", "kdl_test_node_pty_package", ""),',
      ),
    ).toHaveLength(3)
    expect(output).not.toContain('kdl_test_collect_node_pty_package')
  })

  it('refuses a declared lane that collides with a derived collection target', () => {
    expect(() =>
      buck2TypeScriptPackageProjection({
        ...kdlAdmission,
        tests: [
          { name: 'test', runner: 'vitest' },
          { name: 'test_collect', runner: 'vitest' },
        ],
      }).stringify(genieContext),
    ).toThrow('Duplicate test target names')
  })

  it('records every declared lane census exactly once as bounded or source-owned', () => {
    for (const admitted of admittedTestLanes) {
      const lane = buck2TestLanes.find(
        (candidate) =>
          candidate.packagePath === admitted.packagePath &&
          candidate.target.endsWith(':test') === true,
      )
      expect(lane, `no default registry lane for //${admitted.packagePath}`).toBeDefined()
      const census = collectableTestModulesOf(admitted)
      expect(lane?.testFiles).toEqual(census)

      const selected = new Set(lane?.selectedTestFiles ?? [])
      const excluded = new Set(lane?.excludes ?? [])
      const bounded = census.filter(
        (module) => selected.has(module) === true && excluded.has(module) === false,
      )
      const source = census.filter((module) => bounded.includes(module) === false)
      const recordedSource = [
        ...(lane?.unboundedFiles ?? []),
        ...Object.keys(lane?.sourceOwners ?? {}),
      ].toSorted()

      expect(new Set(recordedSource).size).toBe(recordedSource.length)
      expect(recordedSource).toEqual(source)
      expect([...bounded, ...recordedSource].toSorted()).toEqual(census)
    }
  })

  it('keeps the JSX census inside the partition it stages', () => {
    const reactInspector = admittedTestLanes.find(
      (lane) => lane.packagePath === 'packages/@overeng/react-inspector',
    )
    expect(reactInspector).toBeDefined()
    const census = reactInspector === undefined ? [] : collectableTestModulesOf(reactInspector)
    const lane = buck2TestLanes.find(
      (candidate) => candidate.packagePath === 'packages/@overeng/react-inspector',
    )

    expect(census).toContain('src/object/ObjectName.spec.jsx')
    // The JSX specs are staged and bounded, never quietly excluded into an unbounded task.
    expect(lane?.excludes).toEqual([])
    expect(lane?.unboundedTaskName).toBeUndefined()
  })
})
