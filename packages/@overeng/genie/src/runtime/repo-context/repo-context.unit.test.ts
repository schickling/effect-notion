import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import { defineRepoContext, modulePathFromUrl, repoRootFromModuleUrl } from './mod.ts'

const createRepoFixture = ({ marker = '.git' }: { readonly marker?: string } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'genie-repo-context-'))
  if (marker === '.git') mkdirSync(join(root, marker))
  else writeFileSync(join(root, marker), '')
  mkdirSync(join(root, 'genie'), { recursive: true })
  mkdirSync(join(root, 'release'), { recursive: true })
  writeFileSync(join(root, 'genie', 'repo.ts'), '')
  writeFileSync(join(root, 'release', 'version.json'), JSON.stringify({ version: '1.2.3' }))
  return { root, moduleUrl: pathToFileURL(join(root, 'genie', 'repo.ts')).href }
}

/** Mirrors a fixture module the way the compiled Genie product stages its import graph. */
const mirrorModule = (fixture: { readonly root: string }): string => {
  const mirroredModulePath = join(
    mkdtempSync(join(tmpdir(), 'genie-import-')),
    fixture.root.slice(1),
    'genie',
    'repo.ts',
  )
  mkdirSync(join(mirroredModulePath, '..'), { recursive: true })
  writeFileSync(mirroredModulePath, '')
  return mirroredModulePath
}

describe('repo context', () => {
  it('finds the repository root from a generator module URL', () => {
    const fixture = createRepoFixture()

    expect(repoRootFromModuleUrl(fixture.moduleUrl)).toBe(fixture.root)
  })

  it('reads repo-local files independent of process cwd', () => {
    const fixture = createRepoFixture()
    const previousCwd = process.cwd()
    process.chdir(tmpdir())
    try {
      const repo = defineRepoContext({
        name: 'example',
        importMetaUrl: fixture.moduleUrl,
      })

      expect(repo.name).toBe('example')
      expect(repo.rootPath).toBe(fixture.root)
      expect(repo.readJson<{ readonly version: string }>('release/version.json')).toEqual({
        version: '1.2.3',
      })
    } finally {
      process.chdir(previousCwd)
    }
  })

  it('recovers the repo root from Genie temp import mirror paths', () => {
    const fixture = createRepoFixture()
    const mirroredModulePath = mirrorModule(fixture)

    expect(repoRootFromModuleUrl(pathToFileURL(mirroredModulePath).href)).toBe(fixture.root)
  })

  /**
   * `bootstrap:cold-proof` generates a `git archive` export of the committed source, which
   * carries no `.git` at all. Genie's own generation core resolves a repo root from a local
   * megarepo config before `.git`, so this helper must accept the same markers or generator
   * code cannot read its own repository in the install-free tree.
   */
  it('finds the repository root from a megarepo config without .git', () => {
    const fixture = createRepoFixture({ marker: 'megarepo.kdl' })

    expect(repoRootFromModuleUrl(fixture.moduleUrl)).toBe(fixture.root)
    expect(
      defineRepoContext({ name: 'example', importMetaUrl: fixture.moduleUrl }).readJson<{
        readonly version: string
      }>('release/version.json'),
    ).toEqual({ version: '1.2.3' })
  })

  it('recovers a mirrored module in a repository that has only a megarepo config', () => {
    const fixture = createRepoFixture({ marker: 'megarepo.json' })
    const mirroredModulePath = mirrorModule(fixture)

    expect(repoRootFromModuleUrl(pathToFileURL(mirroredModulePath).href)).toBe(fixture.root)
  })

  it('recovers the original module path behind a temp import mirror', () => {
    const fixture = createRepoFixture({ marker: 'megarepo.kdl' })
    const mirroredModulePath = mirrorModule(fixture)

    expect(modulePathFromUrl(pathToFileURL(mirroredModulePath).href)).toBe(
      join(fixture.root, 'genie', 'repo.ts'),
    )
    expect(modulePathFromUrl(fixture.moduleUrl)).toBe(join(fixture.root, 'genie', 'repo.ts'))
  })

  it('refuses a module that belongs to no repository', () => {
    const orphan = join(mkdtempSync(join(tmpdir(), 'genie-orphan-')), 'repo.ts')
    writeFileSync(orphan, '')

    expect(() => modulePathFromUrl(pathToFileURL(orphan).href)).toThrow(
      'Could not find repository root',
    )
  })
})
