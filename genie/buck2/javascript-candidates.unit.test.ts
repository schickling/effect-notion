import process from 'node:process'

import { describe, expect, it } from 'vitest'

import type { GenieContext } from '../../packages/@overeng/genie/src/runtime/core.ts'
import { withJavaScriptCandidates } from './javascript-candidates.ts'
import {
  javaScriptProductPublications,
  javaScriptProductRegistry,
  javaScriptProductsFor,
} from './javascript-product-registry.ts'
import { buck2TypeScriptAdmissions } from './typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from './typescript-package-projection.ts'

const genieContext: GenieContext = { cwd: process.cwd(), location: '' }

const expectedPublications = [
  {
    label: '//packages/@overeng/ci-tools:ci-tools-candidate',
    module: 'ci-tools.js',
    productKind: 'cli',
    productName: 'ci-tools',
    runtimeKind: 'node',
  },
  {
    label: '//packages/@overeng/genie:genie-candidate',
    module: 'genie.js',
    productKind: 'cli',
    productName: 'genie',
    runtimeKind: 'bun',
  },
  {
    label: '//packages/@overeng/genie:genie-bootstrap-closure-check-candidate',
    module: 'genie-bootstrap-closure-check.js',
    productKind: 'cli',
    productName: 'genie-bootstrap-closure-check',
    runtimeKind: 'bun',
  },
  {
    label: '//packages/@overeng/megarepo:megarepo-candidate',
    module: 'mr.js',
    productKind: 'cli',
    productName: 'megarepo',
    runtimeKind: 'node',
  },
  {
    label: '//packages/@overeng/notion-cli:notion-cli-candidate',
    module: 'notion.js',
    productKind: 'cli',
    productName: 'notion-cli',
    runtimeKind: 'node',
  },
  {
    label: '//packages/@overeng/notion-cli:notion-db-candidate',
    module: 'notion-db.js',
    productKind: 'cli',
    productName: 'notion-db-runtime',
    runtimeKind: 'node',
  },
  {
    label: '//packages/@overeng/notion-md:notion-md-candidate',
    module: 'notion-md.js',
    productKind: 'cli',
    productName: 'notion-md',
    runtimeKind: 'node',
  },
  {
    label: '//packages/@overeng/npm-release:npm-release-candidate',
    module: 'npm-release.js',
    productKind: 'cli',
    productName: 'npm-release',
    runtimeKind: 'node',
  },
  {
    label: '//packages/@overeng/oxc-config:oxc-config-candidate',
    module: 'oxc-config.js',
    productKind: 'module',
    productName: 'oxc-config',
    runtimeKind: 'node',
  },
  {
    label: '//packages/@overeng/tui-stories:tui-stories-candidate',
    module: 'tui-stories.js',
    productKind: 'cli',
    productName: 'tui-stories',
    runtimeKind: 'node',
  },
] as const

const productPackagePaths = Object.keys(javaScriptProductRegistry)

const expectUnique = (values: readonly string[]): void => {
  expect(new Set(values).size).toBe(values.length)
}

describe('JavaScript product registry', () => {
  it('declares the ten exact publication labels and product contracts', () => {
    expect(javaScriptProductPublications).toEqual(expectedPublications)
    expect(javaScriptProductPublications).toHaveLength(10)
  })

  it('keeps every publication identity and package-local target unique', () => {
    expectUnique(javaScriptProductPublications.map(({ label }) => label))
    expectUnique(javaScriptProductPublications.map(({ productName }) => productName))
    expectUnique(
      Object.values(javaScriptProductRegistry).flatMap((products) =>
        products.map(({ targetName }) => targetName),
      ),
    )
  })

  it('serves each package entrypoint from the sole registry declaration', () => {
    for (const packagePath of productPackagePaths) {
      expect(
        javaScriptProductsFor(packagePath as keyof typeof javaScriptProductRegistry),
      ).toBe(javaScriptProductRegistry[packagePath as keyof typeof javaScriptProductRegistry])
    }
  })

  it('keeps product package admissions editor non-consumers with targets clear of authority', () => {
    const admissions = Object.values(buck2TypeScriptAdmissions)
    const authorityTargetNames: Record<string, true> = { typecheck: true, dist: true }
    for (const packagePath of productPackagePaths) {
      const admission = admissions.find((candidate) => candidate.packagePath === packagePath)
      expect(admission, `missing TypeScript admission for ${packagePath}`).toBeDefined()
      expect(admission?.editorViewConsumer).toBe(false)
      for (const product of javaScriptProductsFor(
        packagePath as keyof typeof javaScriptProductRegistry,
      )) {
        expect(authorityTargetNames[product.targetName]).toBeUndefined()
        expect(authorityTargetNames[`${product.targetName}-module`]).toBeUndefined()
      }
    }
  })
})

describe('JavaScript candidate projection wrapper', () => {
  it('preserves the normalized and editor projection while appending two targets per product', () => {
    const admission = buck2TypeScriptAdmissions.notionCli
    const projection = buck2TypeScriptPackageProjection(admission)
    const base = projection.stringify(genieContext)
    const products = javaScriptProductsFor(admission.packagePath)
    const wrapped = withJavaScriptCandidates({ projection, products })
    const output = wrapped.stringify(genieContext)

    expect(wrapped.data).toBe(projection.data)
    expect(wrapped.validate).toBe(projection.validate)
    expect(output).toContain(base)
    expect(output).toContain('load("//buck2/products:defs.bzl", "javascript_product")')
    expect(output.split('    name = "editor_view_inputs",')).toHaveLength(2)
    expect(output.split('package_bin_artifact(')).toHaveLength(products.length + 1)
    expect(output.split('javascript_product(')).toHaveLength(products.length + 1)
    expect(output).toContain('    name = "notion-cli-candidate-module",')
    expect(output).toContain('    name = "notion-cli-candidate",')
    expect(output).toContain('    product_kind = "cli",')
    expect(output).toContain('    target = "node",')
  })

  it('keeps the dynamic Genie generator import closure intact', () => {
    const admission = buck2TypeScriptAdmissions.genie
    const projection = buck2TypeScriptPackageProjection(admission)
    const output = withJavaScriptCandidates({
      projection,
      products: javaScriptProductsFor(admission.packagePath),
    }).stringify(genieContext)

    expect(output).toContain('    name = "genie-candidate-module",')
    expect(output).toContain('    tree_shaking = False,')
  })
})
