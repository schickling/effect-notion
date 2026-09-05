import { readdirSync, readFileSync } from 'node:fs'
import process from 'node:process'

import { describe, expect, it } from 'vitest'
import type { GenieContext } from '../../packages/@overeng/genie/src/runtime/core.ts'

import ciWorkflow from '../../.github/workflows/ci.yml.genie.ts'
import dependencyBuck from '../../buck2/dependencies/BUCK.genie.ts'
import {
  blockedBuck2TypeScriptProjectPaths,
  buck2TypeScriptAdmissions,
  buck2TypeScriptEditorViewCoverage,
  editorViewConsumerPackagePaths,
} from './typescript-admissions.ts'
import {
  buck2DependencyViewLabel,
  buck2TypeScriptPackageProjection,
} from './typescript-package-projection.ts'

const genieContext: GenieContext = { cwd: process.cwd(), location: '' }

/**
 * Every package file is `buck2TypeScriptPackageProjection(<its admission>)`, so
 * the registry alone enumerates the whole consumer set. Deriving the outputs
 * here keeps this suite from carrying a second, hand-maintained package list
 * that silently stops covering newly admitted packages.
 */
const projectionOutput = (key: keyof typeof buck2TypeScriptAdmissions): string =>
  buck2TypeScriptPackageProjection(buck2TypeScriptAdmissions[key]).stringify(genieContext)

const admittedPackages = () =>
  Object.values(buck2TypeScriptAdmissions).map((admission) => ({
    output: buck2TypeScriptPackageProjection(admission).stringify(genieContext),
    dependencyView: buck2DependencyViewLabel(admission.packagePath),
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

const compare = ({ left, right }: { left: string; right: string }): number =>
  left < right ? -1 : left > right ? 1 : 0

/** Repository roots that may host a package-local Buck projection source. */
const projectionRoots = ['context', 'packages'] as const
const skippedDirectoryNames: Readonly<Record<string, true>> = {
  '.git': true,
  '.storybook': true,
  dist: true,
  node_modules: true,
}

/**
 * Finds every package-local admission declaration on disk, independent of
 * whether its generated BUCK composes the TypeScript-only, JavaScript, or
 * candidate wrapper entrypoint.
 */
const discoverTypeScriptProjectionSources = (): readonly string[] => {
  const sources: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = `${directory}/${entry.name}`
      if (entry.isDirectory() === true) {
        if (skippedDirectoryNames[entry.name] !== true) walk(entryPath)
        continue
      }
      if (entry.name !== 'BUCK.genie.ts') continue
      if (
        readFileSync(entryPath, 'utf8').includes('export const buck2TypeScriptAdmission') === true
      ) {
        sources.push(entryPath)
      }
    }
  }
  for (const root of projectionRoots) walk(root)
  return sources
}

describe('declared-closure package projection', () => {
  it('publishes every admitted package as an editor view consumer', () => {
    expect(buck2TypeScriptEditorViewCoverage).toBe('complete')
    expect(editorViewConsumerPackagePaths).toEqual(
      Object.values(buck2TypeScriptAdmissions)
        .map(({ packagePath }) => packagePath)
        .toSorted((left, right) => compare({ left, right })),
    )
    expect(editorViewConsumerPackagePaths).toHaveLength(38)
    expect(editorViewConsumerPackagePaths).toContain('packages/@overeng/tui-react')
  })

  it('wires each admitted package only to its normalized dependency view', () => {
    for (const admitted of admittedPackages()) {
      expect(admitted.output).toContain(`    actual = "${admitted.dependencyView}",`)
      expect(admitted.output).toContain(`    dependency_view = "${admitted.dependencyView}",`)
      expect(
        dependencyBuck.data.store.views.find(
          ({ importer }) => importer === admitted.packagePath,
        )?.target,
      ).toBe(admitted.dependencyView.slice('//buck2/dependencies:'.length))
      expect(admitted.output).not.toContain('//buck2/dependencies:importer_')
      expect(admitted.output).not.toContain('    name = "node_modules",')
      expect(admitted.output).toContain('package_view(')
      expect(admitted.output).toContain('    runtime = "//:package_tree_runtime",')
      expect(admitted.output).toContain('    runtime_entry = "package-tree.ts",')
      expect(admitted.output).toContain('load("//buck2:editor_view.bzl", "editor_view_inputs")')
      expect(admitted.output).toContain('    name = "editor_view_inputs",')
      expect(admitted.output).toContain('    editor_inputs = ":editor_inputs",')
      expect(admitted.output).toContain('    package_tree = ":package_tree",')
      for (const retiredTerm of retiredProviderTerms) {
        expect(admitted.output).not.toContain(retiredTerm)
      }
    }
  })

  it('admits the complete recursive normalized workspace closure for tui-react', () => {
    const tuiReactView = dependencyBuck.data.store.views.find(
      (view) => view.importer === 'packages/@overeng/tui-react',
    )
    expect(tuiReactView).toBeDefined()
    const admittedPackagePaths = new Set(admittedPackages().map(({ packagePath }) => packagePath))
    for (const label of Object.values(tuiReactView?.workspaceTrees ?? {})) {
      const packagePath = label.slice('//'.length, -':package_tree'.length)
      expect(admittedPackagePaths.has(packagePath), `missing projection for ${label}`).toBe(true)
    }
  })

  it('keeps admitted subpackage inputs out of the root Buck package', () => {
    const rootBuck = readFileSync('BUCK', 'utf8')
    for (const { packagePath } of admittedPackages()) {
      expect(rootBuck, `root BUCK still owns files below //${packagePath}`).not.toContain(
        `src = "${packagePath}/`,
      )
      expect(rootBuck, `root BUCK still maps files below //${packagePath}`).not.toContain(
        `: "${packagePath}/`,
      )
    }
    expect(rootBuck).toContain('name = "package_tree_runtime",')
    expect(rootBuck).toContain(
      'actual = "//packages/@overeng/buck2-tools:package_tree_runtime"',
    )
    expect(rootBuck).not.toContain('packages/@overeng/buck2-tools/src/package-tree.ts')
    expect(blockedBuck2TypeScriptProjectPaths).not.toContain('packages/@overeng/buck2-tools')
    for (const admitted of admittedPackages()) {
      for (const packagePath of admittedPackages().map(({ packagePath }) => packagePath)) {
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

  it('projects explicit package-root source files', () => {
    const output = projectionOutput('effectRpcTanstackExampleBasic')

    expect(output).toContain('        "vite.config.ts": "vite.config.ts",')
    expect(output).toContain('    "vite.config.ts",')
  })

  it('projects additional TypeScript projects with distinct targets and source roots', () => {
    const output = projectionOutput('reactInspector')

    expect(output).toContain(
      '        "tsconfig.strict-consumer.json": "tsconfig.strict-consumer.json",',
    )
    expect(output).toContain(
      '        "test-d/exact-optional-consumer.ts": "test-d/exact-optional-consumer.ts",',
    )
    expect(output).toContain('    name = "typecheck_strict_consumer",')
    expect(output).toContain('    project = "tsconfig.strict-consumer.json",')
  })

  it('projects only package-local handwritten declarations into emit inputs', () => {
    expect(projectionOutput('tuiReact')).toContain(
      '        "src/storybook/asset-modules.d.ts": "src/storybook/asset-modules.d.ts",',
    )
    expect(projectionOutput('utils')).toContain(
      '        "src/node/storybook/gate/virtual-modules.d.ts": "src/node/storybook/gate/virtual-modules.d.ts",',
    )
    expect(projectionOutput('utils')).toContain(
      '        "src/node/stylex/mod-types.d.ts": "src/node/stylex/mod-types.d.ts",',
    )
    expect(projectionOutput('utils')).toContain(
      '        "src/node/stylex/mod.js": "src/node/stylex/mod.js",',
    )
  })

  it('admits declared test data as globbed package-view inputs', () => {
    const output = projectionOutput('kdl')

    expect(output).toContain('    for source in glob(["test-fixtures/**/*.kdl"])')
    expect(output).toContain(
      '} or fail("declared test data matched no file: packages/@overeng/kdl")',
    )
    expect(output).toContain('    } | package_test_data,')
    // The census stays bounded: the fixture tree is admitted by extension, never as the
    // whole package directory, and it never becomes a TypeScript input.
    expect(output).not.toContain('glob(["**/*"])')
    expect(output).toContain(
      '# Semantic inputs: buck2/dependencies/BUCK.genie.ts',
    )
    expect(output).toContain('packages/@overeng/kdl/test-fixtures/**/*.kdl')

    const withoutTestData = projectionOutput('effectPath')
    expect(withoutTestData).not.toContain('package_test_data')
    expect(withoutTestData).toContain('    },\n    runtime = "//:package_tree_runtime",')
  })

  it('refuses test-data declarations that are stale or owned by the source census', () => {
    expect(() =>
      buck2TypeScriptPackageProjection({
        ...buck2TypeScriptAdmissions.kdl,
        testDataRoots: [{ root: 'test-fixtures', extensions: ['.json'] }],
      }).stringify(genieContext),
    ).toThrow('Declared test data matches no file: test-fixtures/**/*.json')

    expect(() =>
      buck2TypeScriptPackageProjection({
        ...buck2TypeScriptAdmissions.kdl,
        testDataRoots: [{ root: 'src', extensions: ['.ts'] }],
      }).stringify(genieContext),
    ).toThrow('Test data extension is owned by the source census: .ts')

    expect(() =>
      buck2TypeScriptPackageProjection({
        ...buck2TypeScriptAdmissions.kdl,
        testDataRoots: [{ root: 'src/mod.ts', extensions: ['.kdl'] }],
      }).stringify(genieContext),
    ).toThrow('Test data root must be a directory: src/mod.ts')
  })

  it('registers every package-local TypeScript projection source', () => {
    const projectionSources = discoverTypeScriptProjectionSources()
    expect(projectionSources.length).toBeGreaterThan(0)
    expect(projectionSources.toSorted((left, right) => compare({ left, right }))).toEqual(
      admittedPackages()
        .map(({ packagePath }) => `${packagePath}/BUCK.genie.ts`)
        .toSorted((left, right) => compare({ left, right })),
    )
  })
})

describe('same-cell label projection', () => {
  it('does not name the hub cell in generated packages or hub Starlark', () => {
    for (const admitted of admittedPackages()) {
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
