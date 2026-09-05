import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { runPackageTreeCli } from './package-tree.ts'

const scratchDirectories: string[] = []
type AssemblyFixture = {
  readonly root: string
  readonly nodeModules: string
  readonly packageDirectory: string
  readonly output: string
}

const createAssemblyFixture = (): AssemblyFixture => {
  const root = mkdtempSync(join(tmpdir(), 'package-tree-'))
  scratchDirectories.push(root)
  const nodeModules = join(root, 'source', 'node_modules')
  const packageDirectory = join(nodeModules, '.pnpm', 'safe', 'node_modules', 'safe')
  const output = join(root, 'output')
  mkdirSync(packageDirectory, { recursive: true })
  writeFileSync(join(packageDirectory, 'package.json'), '{"name":"safe"}\n')
  return { root, nodeModules, packageDirectory, output }
}

const assemble = ({ nodeModules, output }: AssemblyFixture): void =>
  runPackageTreeCli(['--output', output, '--node-modules', nodeModules])

afterEach(() => {
  for (const directory of scratchDirectories.splice(0)) rmSync(directory, { recursive: true })
})

describe('Buck package-tree dependency boundaries', () => {
  it('materializes an explicit empty node_modules boundary', () => {
    const fixture = createAssemblyFixture()

    runPackageTreeCli(['--output', fixture.output, '--empty-node-modules', 'true'])

    expect(statSync(join(fixture.output, 'node_modules')).isDirectory()).toBe(true)
  })
})

describe('Buck package-tree symlink containment', () => {
  it('retains a safe relative symlink whose destination is inside the assembled tree', () => {
    const fixture = createAssemblyFixture()
    symlinkSync('.pnpm/safe/node_modules/safe', join(fixture.nodeModules, 'safe'))

    assemble(fixture)

    expect(readlinkSync(join(fixture.output, 'node_modules', 'safe'))).toBe(
      '.pnpm/safe/node_modules/safe',
    )
  })

  it('does not alias regular source files into the mutable Buck output tree', () => {
    const fixture = createAssemblyFixture()
    const source = join(fixture.packageDirectory, 'package.json')
    chmodSync(source, 0o444)

    assemble(fixture)

    const output = join(
      fixture.output,
      'node_modules',
      '.pnpm',
      'safe',
      'node_modules',
      'safe',
      'package.json',
    )
    expect(statSync(output).ino).not.toBe(statSync(source).ino)
    chmodSync(output, 0o644)
    expect(statSync(source).mode & 0o777).toBe(0o444)
  })

  it('rejects an existing absolute target and removes the incomplete package tree', () => {
    const fixture = createAssemblyFixture()
    symlinkSync(fixture.packageDirectory, join(fixture.nodeModules, 'absolute-target'))

    expect(() => assemble(fixture)).toThrow('absolute target')
    expect(existsSync(fixture.output)).toBe(false)
  })

  it('rejects a relative target that escapes the assembled tree', () => {
    const fixture = createAssemblyFixture()
    writeFileSync(join(fixture.root, 'outside.txt'), 'outside\n')
    symlinkSync('../../outside.txt', join(fixture.nodeModules, 'relative-escape'))

    expect(() => assemble(fixture)).toThrow('target escapes tree')
    expect(existsSync(fixture.output)).toBe(false)
  })

  it('rejects a dangling relative target', () => {
    const fixture = createAssemblyFixture()
    symlinkSync('missing', join(fixture.nodeModules, 'dangling'))

    expect(() => assemble(fixture)).toThrow('target is dangling')
    expect(existsSync(fixture.output)).toBe(false)
  })

  it('rejects a cyclic relative target', () => {
    const fixture = createAssemblyFixture()
    symlinkSync('cycle-b', join(fixture.nodeModules, 'cycle-a'))
    symlinkSync('cycle-a', join(fixture.nodeModules, 'cycle-b'))

    expect(() => assemble(fixture)).toThrow('target is cyclic')
    expect(existsSync(fixture.output)).toBe(false)
  })

  it('rejects a contained relative link whose chained target escapes the assembled tree', () => {
    const fixture = createAssemblyFixture()
    writeFileSync(join(fixture.root, 'outside.txt'), 'outside\n')
    symlinkSync('../../outside.txt', join(fixture.nodeModules, 'redirect'))
    symlinkSync('redirect', join(fixture.nodeModules, 'chained-escape'))

    expect(() => assemble(fixture)).toThrow('chained target resolves outside tree')
    expect(existsSync(fixture.output)).toBe(false)
  })
})

describe('Buck package view over a normalized dependency view', () => {
  it('links the dependency view instead of copying a dependency closure', () => {
    const fixture = createAssemblyFixture()
    symlinkSync('.pnpm/safe/node_modules/safe', join(fixture.nodeModules, 'safe'))
    const source = join(fixture.root, 'src', 'mod.ts')
    mkdirSync(join(fixture.root, 'src'), { recursive: true })
    writeFileSync(source, 'export const value = 1\n')

    runPackageTreeCli([
      '--output',
      fixture.output,
      '--dependency-view',
      fixture.nodeModules,
      '--file',
      'src/mod.ts',
      source,
    ])

    // The package view owns its own sources and one relative first hop; not a
    // single dependency byte is duplicated into it.
    const link = join(fixture.output, 'node_modules')
    const target = readlinkSync(link)
    expect(isAbsolute(target)).toBe(false)
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(statSync(join(link, 'safe', 'package.json')).isFile()).toBe(true)
    expect(statSync(join(fixture.output, 'src', 'mod.ts')).isFile()).toBe(true)
  })

  it('rejects declaring both a copied closure and a linked dependency view', () => {
    const fixture = createAssemblyFixture()

    expect(() =>
      runPackageTreeCli([
        '--output',
        fixture.output,
        '--node-modules',
        fixture.nodeModules,
        '--dependency-view',
        fixture.nodeModules,
      ]),
    ).toThrow('unexpected argument: --dependency-view')
  })

  it('still rejects an unsafe symlink among package-owned sources', () => {
    const fixture = createAssemblyFixture()
    const owned = join(fixture.root, 'owned')
    mkdirSync(owned, { recursive: true })
    writeFileSync(join(fixture.root, 'outside.txt'), 'outside\n')
    symlinkSync('../../outside.txt', join(owned, 'escape'))

    expect(() =>
      runPackageTreeCli([
        '--output',
        fixture.output,
        '--dependency-view',
        fixture.nodeModules,
        '--file',
        'owned',
        owned,
      ]),
    ).toThrow('target escapes tree')
    expect(existsSync(fixture.output)).toBe(false)
  })
})
