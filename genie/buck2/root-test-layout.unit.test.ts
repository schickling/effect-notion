import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  projectionInputsTarget,
  rootTestContractDirectories,
  rootTestLayout,
  rootTestRepositoryContractModules,
  rootTestSourcesTarget,
  rootTestSuitePackage,
} from './root-test-layout.ts'

/**
 * The root test tree must reproduce the repository layout the suite imports.
 *
 * A Buck action sees only declared inputs, so every module the suite reaches
 * through relative imports has to be staged by the generated `BUCK` — either by
 * the suite package's own glob, by a mounted tree, or by an explicit label. A
 * gap here is a `Cannot find module` inside the test action, which is exactly
 * the failure this projection exists to prevent.
 */

const generatedBuck = readFileSync('genie/buck2/BUCK', 'utf8')
const generatedLayoutBzl = readFileSync('buck2/root_test_layout.bzl', 'utf8')
const vitestConfig = readFileSync('genie/buck2/vitest.config.ts', 'utf8')

/** Staged destination that carries `module`, either directly or as a prefix. */
const stagedBy = (module: string): string | undefined =>
  [
    ...rootTestLayout.sourceFiles.map(({ destination }) => destination),
    ...rootTestLayout.sourceTrees.map(({ destination }) => destination),
  ]
    .filter(
      (destination) => destination === module || module.startsWith(`${destination}/`) === true,
    )
    .toSorted((left, right) => right.length - left.length)[0]

describe('root test layout', () => {
  it('stages every module the suite loads', () => {
    const unstaged = rootTestLayout.modules.filter((module) => {
      if (module.startsWith(`${rootTestSuitePackage}/`) === true) {
        return module.endsWith('.ts') !== true && stagedBy(module) === undefined
      }
      return stagedBy(module) === undefined
    })
    expect(unstaged).toEqual([])
    expect(rootTestLayout.modules.length).toBeGreaterThan(150)
  })

  it('reaches other packages through their declared projection-input trees', () => {
    const packageTrees = rootTestLayout.sourceTrees.filter(({ label }) =>
      label.endsWith(`:${projectionInputsTarget}`),
    )
    expect(packageTrees.length).toBeGreaterThan(30)
    for (const { destination, label } of packageTrees) {
      // The mount destination is the package path itself, which is what keeps
      // the staged paths identical to the repository-relative ones.
      expect(label).toBe(`//${destination}:${projectionInputsTarget}`)
      expect(generatedBuck).toContain(`    "${destination}": "${label}",`)
    }
  })

  it('carries root-package generator sources through generated declarations', () => {
    for (const { prefix, files } of rootTestLayout.rootTrees) {
      expect(generatedBuck).toContain(`    "${prefix}": "//:${rootTestSourcesTarget(prefix)}",`)
      expect(generatedLayoutBzl).toContain(`    "${prefix}": {`)
      for (const [destination, source] of files) {
        expect(generatedLayoutBzl).toContain(`        "${destination}": "${source}",`)
      }
    }
    for (const rootFile of rootTestLayout.rootFiles) {
      expect(generatedLayoutBzl).toContain(`    "${rootFile}",`)
      expect(generatedBuck).toContain(`    "${rootFile}": "//:${rootFile}",`)
    }
  })

  it('admits nothing beyond the modules the suite loads', () => {
    for (const { destination } of rootTestLayout.sourceFiles) {
      expect(rootTestLayout.modules).toContain(destination)
    }
    for (const { destination } of rootTestLayout.sourceTrees) {
      expect(
        rootTestLayout.modules.some((module) => module.startsWith(`${destination}/`) === true),
      ).toBe(true)
    }
  })

  it('runs the declared repository-contract suites', () => {
    for (const module of rootTestRepositoryContractModules) {
      expect(rootTestLayout.modules).toContain(module)
      expect(stagedBy(module)).not.toBeUndefined()
      expect(vitestConfig).toContain(`'${module}',`)
      expect(generatedBuck).toContain(`"${module.slice(0, module.lastIndexOf('/'))}"`)
    }
    expect(rootTestContractDirectories).toEqual([
      'packages/@overeng/genie/src/runtime/github-workflow',
      'packages/@overeng/otel-contract/src',
    ])
  })
})
