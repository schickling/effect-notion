import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  lstatSync,
  rmSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  copyDeclarationSources,
  formatError,
  hashDeclaredInputRoots,
  linkStagedWorkspaceProjects,
  parseEmitOptions,
  parseTypecheckOptions,
  relinkStagedDependencyView,
} from './typescript-runner.ts'

const scratchDirectories: string[] = []

const createFixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'typescript-runner-'))
  scratchDirectories.push(root)
  const packageRoot = join(root, 'package')
  const output = join(root, 'output')
  mkdirSync(join(packageRoot, 'src'), { recursive: true })
  mkdirSync(output)
  return { root, packageRoot, output }
}

afterEach(() => {
  for (const directory of scratchDirectories.splice(0)) rmSync(directory, { recursive: true })
})

it('preserves an error message when the runtime stack omits it', () => {
  const error = new Error('expected declaration entrypoint was not emitted: mod.d.ts')
  error.stack = 'Error\n    at validateOutput (typescript-runner.ts:471:7)'

  expect(formatError(error)).toContain(
    'expected declaration entrypoint was not emitted: mod.d.ts\nError',
  )
})

describe('TypeScript emit declaration command', () => {
  it('parses explicit normalized declaration paths', () => {
    const options = parseEmitOptions([
      '/nix/store/toolchain/bin/tsgo',
      '/package-tree',
      'tsconfig.json',
      'dist',
      'src/mod.d.ts',
      '/output',
      '--copy-declaration',
      'src/vite-types.d.ts',
      '--read-root',
      '/dependency-view',
    ])

    expect(options.declarationSources).toEqual(['src/vite-types.d.ts'])
  })

  it('parses canonical repeatable declared read roots', () => {
    expect(
      parseTypecheckOptions([
        '/nix/store/toolchain/bin/tsgo',
        '/package-tree',
        'tsconfig.json',
        '/output',
        '--read-root',
        '/z-dependency',
        '--read-root',
        '/a-dependency',
        '--read-root',
        '/z-dependency',
      ]).readRoots,
    ).toEqual(['/a-dependency', '/z-dependency'])
  })

  it('hashes every canonical declared input root and does not follow symlink cycles', async () => {
    const { root } = createFixture()
    const first = join(root, 'first')
    const second = join(root, 'second')
    mkdirSync(first)
    mkdirSync(second)
    writeFileSync(join(first, 'source.ts'), 'export const value = 1\n')
    writeFileSync(join(second, 'dependency.d.ts'), 'export declare const dependency: 1\n')
    symlinkSync(first, join(second, 'cycle'))

    const before = await hashDeclaredInputRoots([second, first, second])
    writeFileSync(join(second, 'dependency.d.ts'), 'export declare const dependency: 2\n')
    const after = await hashDeclaredInputRoots([first, second])

    expect(after).not.toBe(before)
  })

  it.each(['../outside.d.ts', '/outside.d.ts', 'src\\outside.d.ts', 'src//outside.d.ts'])(
    'rejects unsafe declaration path %s',
    (declarationPath) => {
      expect(() =>
        parseEmitOptions([
          '/nix/store/toolchain/bin/tsgo',
          '/package-tree',
          'tsconfig.json',
          'dist',
          'src/mod.d.ts',
          '/output',
          '--copy-declaration',
          declarationPath,
        ]),
      ).toThrow('declaration source must be a normalized portable relative path')
    },
  )
})

it('rebinds a staged package to its declared dependency view after relocation', async () => {
  const { root, packageRoot } = createFixture()
  const dependencyView = join(root, 'buck-artifact', 'node_modules')
  const stagedPackageRoot = join(root, 'system-temp', 'package')
  mkdirSync(dependencyView, { recursive: true })
  mkdirSync(stagedPackageRoot, { recursive: true })
  symlinkSync('../buck-artifact/node_modules', join(packageRoot, 'node_modules'))
  symlinkSync('../buck-artifact/node_modules', join(stagedPackageRoot, 'node_modules'))

  await relinkStagedDependencyView({ packageTree: packageRoot, stagedPackageRoot })

  expect(readlinkSync(join(stagedPackageRoot, 'node_modules'))).toBe(realpathSync(dependencyView))
  expect(lstatSync(join(stagedPackageRoot, 'node_modules')).isSymbolicLink()).toBe(true)
})

it('projects declared workspace package trees beside the relocated package', async () => {
  const { root } = createFixture()
  const artifactRoot = join(root, 'buck-out', 'packages', '@overeng')
  const packageTree = join(artifactRoot, 'notion-cli', '__package_tree__', 'package_tree')
  const siblingTree = join(artifactRoot, 'effect-path', '__package_tree__', 'package_tree')
  const stagingRoot = join(root, 'system-temp')
  const stagedPackageRoot = join(stagingRoot, 'package')
  mkdirSync(packageTree, { recursive: true })
  mkdirSync(join(siblingTree, 'node_modules'), { recursive: true })
  writeFileSync(
    join(siblingTree, 'tsconfig.json'),
    `${JSON.stringify({ compilerOptions: { composite: true, noEmit: true } }, undefined, 2)}\n`,
  )
  mkdirSync(stagedPackageRoot, { recursive: true })

  await linkStagedWorkspaceProjects({
    packageTree,
    readRoots: [packageTree, siblingTree],
    stagedPackageRoot,
    stagingRoot,
  })

  const stagedSibling = join(stagingRoot, 'effect-path')
  expect(lstatSync(stagedSibling).isDirectory()).toBe(true)
  expect(JSON.parse(readFileSync(join(stagedSibling, 'tsconfig.json'), 'utf8'))).toEqual({
    compilerOptions: { composite: true, noEmit: false },
  })
})

describe('TypeScript handwritten declaration copy', () => {
  it('copies only explicit files while preserving their package-relative paths', async () => {
    const fixture = createFixture()
    writeFileSync(join(fixture.packageRoot, 'src', 'vite-types.d.ts'), 'export type Vite = true\n')
    writeFileSync(join(fixture.packageRoot, 'src', 'ambient.d.ts'), 'declare const ambient: true\n')

    await copyDeclarationSources({
      declarationSources: ['src/vite-types.d.ts'],
      output: fixture.output,
      packageRoot: fixture.packageRoot,
    })

    expect(readFileSync(join(fixture.output, 'src', 'vite-types.d.ts'), 'utf8')).toBe(
      'export type Vite = true\n',
    )
    expect(existsSync(join(fixture.output, 'src', 'ambient.d.ts'))).toBe(false)
  })

  it('rejects missing, directory, and symlink inputs', async () => {
    const fixture = createFixture()
    mkdirSync(join(fixture.packageRoot, 'src', 'directory.d.ts'))
    writeFileSync(join(fixture.root, 'outside.d.ts'), 'export type Outside = true\n')
    symlinkSync(join(fixture.root, 'outside.d.ts'), join(fixture.packageRoot, 'src', 'link.d.ts'))

    await expect(
      copyDeclarationSources({
        declarationSources: ['src/missing.d.ts'],
        output: fixture.output,
        packageRoot: fixture.packageRoot,
      }),
    ).rejects.toThrow('declaration source does not exist: src/missing.d.ts')
    await expect(
      copyDeclarationSources({
        declarationSources: ['src/directory.d.ts'],
        output: fixture.output,
        packageRoot: fixture.packageRoot,
      }),
    ).rejects.toThrow('declaration source is not a regular file: src/directory.d.ts')
    await expect(
      copyDeclarationSources({
        declarationSources: ['src/link.d.ts'],
        output: fixture.output,
        packageRoot: fixture.packageRoot,
      }),
    ).rejects.toThrow('declaration source is not a regular file: src/link.d.ts')
  })
})
