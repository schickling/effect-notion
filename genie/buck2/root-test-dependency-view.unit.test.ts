import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { pnpmTargetName, translatePnpmLock } from '../../buck2/dependencies/pnpm-lock.ts'
import { rootTestDependencyAuthority, rootTestDependencyView } from './BUCK.genie.ts'

/**
 * The root test suite runs on a normalized store view, not a root install.
 *
 * `//genie/buck2:root_test_package_tree` materializes exactly one dependency
 * view into its `node_modules`. Pointing it at the repository root importer
 * (`.`) produced an empty tree — the root importer declares nothing since root
 * installs were removed — and Vitest itself could not be resolved. These tests
 * pin the three facts that keep the projection honest: the label is derived
 * from a declared workspace importer, that importer really declares the
 * external packages the suite loads, and the store view it names really carries
 * a dependency closure.
 */

const generatedRootBuck = readFileSync('genie/buck2/BUCK', 'utf8')
const generatedDependencyBuck = readFileSync('buck2/dependencies/BUCK', 'utf8')

const metadata = translatePnpmLock({
  lockfileText: readFileSync('pnpm-lock.yaml', 'utf8'),
  workspaceText: readFileSync('pnpm-workspace.yaml', 'utf8'),
})

/** Body of one generated `pnpm_store_view` declaration, by target name. */
const storeViewBody = (target: string): string => {
  const opening = generatedDependencyBuck.indexOf(`    name = "${target}",`)
  expect(opening, `buck2/dependencies/BUCK declares ${target}`).toBeGreaterThan(-1)
  const closing = generatedDependencyBuck.indexOf('\n)\n', opening)
  return generatedDependencyBuck.slice(opening, closing)
}

describe('root test dependency view', () => {
  it('is the normalized store view of the declared workspace importer', () => {
    expect(rootTestDependencyView).toBe(
      `//buck2/dependencies:${pnpmTargetName({
        prefix: 'view',
        identity: rootTestDependencyAuthority,
      })}`,
    )
    expect(generatedRootBuck).toContain(`    dependency_view = "${rootTestDependencyView}",`)
  })

  it('never falls back to the empty repository-root importer', () => {
    const rootImporter = metadata.importers['.']
    expect(rootImporter).toBeDefined()
    expect({
      dependencies: Object.keys(rootImporter?.dependencies ?? {}),
      devDependencies: Object.keys(rootImporter?.devDependencies ?? {}),
    }).toEqual({ dependencies: [], devDependencies: [] })
    expect(rootTestDependencyAuthority).not.toBe('.')
    expect(generatedRootBuck).not.toContain(
      `//buck2/dependencies:${pnpmTargetName({ prefix: 'view', identity: '.' })}`,
    )
  })

  it('names an importer that declares the external packages the suite loads', () => {
    const importer = metadata.importers[rootTestDependencyAuthority]
    expect(importer, `${rootTestDependencyAuthority} is a pnpm workspace importer`).toBeDefined()
    const declared = [
      ...Object.keys(importer?.dependencies ?? {}),
      ...Object.keys(importer?.devDependencies ?? {}),
    ]
    // `vitest` runs the suite; `effect` backs the `Schema` module the Buck
    // admissions load through `@overeng/megarepo`'s composition sources.
    for (const external of ['effect', 'vitest']) {
      expect(declared).toContain(external)
    }
  })

  it('resolves to a store view that supplies a non-empty dependency closure', () => {
    const body = storeViewBody(rootTestDependencyView.slice('//buck2/dependencies:'.length))
    expect(body).toContain('"vitest":')
    expect(body).toContain(':entry_vitest_')
    expect(body).not.toMatch(/direct = \{\n {4}\}/u)
  })
})
