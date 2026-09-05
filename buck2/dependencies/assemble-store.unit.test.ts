import { mkdirSync, mkdtempSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { lstat, readdir, readlink, rename } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  assembleStoreEntry,
  assembleStoreScc,
  assembleStoreView,
  runStoreAssemblyCli,
} from './assemble-store.ts'

const scratch: string[] = []

afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const makeRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'pnpm-store-'))
  scratch.push(root)
  return root
}

const makePackage = ({
  files = { 'index.js': 'module.exports = 1\n' },
  name,
  root,
}: {
  files?: Record<string, string>
  name: string
  root: string
}): string => {
  const directory = join(root, 'archives', name.replaceAll('/', '+'))
  mkdirSync(directory, { recursive: true })
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(directory, path, '..'), { recursive: true })
    writeFileSync(join(directory, path), content)
  }
  return directory
}

type TreeCensus = { readonly files: readonly string[]; readonly links: readonly string[] }

const census = async (root: string): Promise<TreeCensus> => {
  const files: string[] = []
  const links: string[] = []
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).toSorted((left, right) =>
      left.name < right.name ? -1 : 1,
    )) {
      const path = join(directory, entry.name)
      const display = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isSymbolicLink() === true) {
        links.push(display)
        continue
      }
      if (entry.isDirectory() === true) {
        await visit(path, display)
        continue
      }
      files.push(display)
    }
  }
  await visit(root, '')
  return { files, links }
}

describe('normalized store entry assembly', () => {
  it('resolves a dependency from inside its package through a literal node_modules ancestor', async () => {
    const root = makeRoot()
    const leftPackage = makePackage({ name: 'left', root })
    const rightPackage = makePackage({ name: 'right', root })
    const rightEntry = join(root, 'entries', 'right')
    const leftEntry = join(root, 'entries', 'left')
    mkdirSync(join(root, 'entries'), { recursive: true })

    await assembleStoreEntry({
      bins: [],
      dependencies: [],
      output: rightEntry,
      packageName: 'right',
      packageTree: rightPackage,
    })
    await assembleStoreEntry({
      bins: [],
      dependencies: [
        { entryDir: join(rightEntry, 'node_modules'), name: 'right', packageName: 'right' },
      ],
      output: leftEntry,
      packageName: 'left',
      packageTree: leftPackage,
    })

    const { files, links } = await census(leftEntry)
    expect(files).toEqual(['node_modules/left/index.js'])
    expect(links).toEqual(['node_modules/right'])
    const target = await readlink(join(leftEntry, 'node_modules', 'right'))
    expect(isAbsolute(target)).toBe(false)
    expect(target).toBe('../../right/node_modules/right')
    const requireFromLeft = createRequire(join(leftEntry, 'node_modules', 'left', 'index.js'))
    expect(requireFromLeft.resolve('right')).toBe(
      join(rightEntry, 'node_modules', 'right', 'index.js'),
    )
  })

  it('keeps its links working after the whole store root is relocated', async () => {
    const root = makeRoot()
    const rightEntry = join(root, 'entries', 'right')
    const leftEntry = join(root, 'entries', 'left')
    mkdirSync(join(root, 'entries'), { recursive: true })
    await assembleStoreEntry({
      bins: [],
      dependencies: [],
      output: rightEntry,
      packageName: 'right',
      packageTree: makePackage({ name: 'right', root }),
    })
    await assembleStoreEntry({
      bins: [],
      dependencies: [
        { entryDir: join(rightEntry, 'node_modules'), name: 'right', packageName: 'right' },
      ],
      output: leftEntry,
      packageName: 'left',
      packageTree: makePackage({ name: 'left', root }),
    })

    const moved = join(makeRoot(), 'relocated')
    await rename(join(root, 'entries'), moved).catch(() => {
      throw new Error('relocation must be possible on one filesystem')
    })

    expect(statSync(join(moved, 'left', 'node_modules', 'right', 'index.js')).isFile()).toBe(true)
  })

  it('rejects a dependency name that traverses out of the entry', async () => {
    const root = makeRoot()
    await expect(
      assembleStoreEntry({
        bins: [],
        dependencies: [
          { entryDir: join(root, 'archives'), name: '../escape', packageName: 'right' },
        ],
        output: join(root, 'entry'),
        packageName: 'left',
        packageTree: makePackage({ name: 'left', root }),
      }),
    ).rejects.toThrow(/dependency name must be normalized/)
  })

  it('rejects an undeclared dependency tree instead of materializing a dangling link', async () => {
    const root = makeRoot()
    await expect(
      assembleStoreEntry({
        bins: [],
        dependencies: [{ entryDir: join(root, 'missing'), name: 'right', packageName: 'right' }],
        output: join(root, 'entry'),
        packageName: 'left',
        packageTree: makePackage({ name: 'left', root }),
      }),
    ).rejects.toThrow(/names undeclared tree/)
  })

  it('rejects dangling and cyclic links in package bytes before publishing an entry', async () => {
    const root = makeRoot()
    const dangling = makePackage({ name: 'dangling', root })
    symlinkSync('missing', join(dangling, 'link'))
    await expect(
      assembleStoreEntry({
        bins: [],
        dependencies: [],
        output: join(root, 'dangling-entry'),
        packageName: 'dangling',
        packageTree: dangling,
      }),
    ).rejects.toThrow(/source symlink target is dangling/)

    const cyclic = makePackage({ name: 'cyclic', root })
    symlinkSync('cycle-b', join(cyclic, 'cycle-a'))
    symlinkSync('cycle-a', join(cyclic, 'cycle-b'))
    await expect(
      assembleStoreEntry({
        bins: [],
        dependencies: [],
        output: join(root, 'cyclic-entry'),
        packageName: 'cyclic',
        packageTree: cyclic,
      }),
    ).rejects.toThrow(/source symlink target is cyclic/)
  })

  it('rejects a declared entry whose requested package target is dangling', async () => {
    const root = makeRoot()
    const declaredEntry = join(root, 'declared-entry')
    mkdirSync(declaredEntry, { recursive: true })
    await expect(
      assembleStoreEntry({
        bins: [],
        dependencies: [
          { entryDir: declaredEntry, name: 'missing', packageName: 'missing' },
        ],
        output: join(root, 'entry'),
        packageName: 'left',
        packageTree: makePackage({ name: 'left', root }),
      }),
    ).rejects.toThrow(/link target is dangling/)
  })

  it('rejects a declared package target that canonically escapes its backing tree', async () => {
    const root = makeRoot()
    const declaredEntry = join(root, 'declared-entry')
    const outside = join(root, 'outside')
    mkdirSync(declaredEntry, { recursive: true })
    mkdirSync(outside, { recursive: true })
    symlinkSync(outside, join(declaredEntry, 'escaped'))

    await expect(
      assembleStoreEntry({
        bins: [],
        dependencies: [
          { entryDir: declaredEntry, name: 'escaped', packageName: 'escaped' },
        ],
        output: join(root, 'entry'),
        packageName: 'left',
        packageTree: makePackage({ name: 'left', root }),
      }),
    ).rejects.toThrow(/canonically escapes its declared tree/)
  })

  it('rejects a package link whose contained chain canonically escapes its source tree', async () => {
    const root = makeRoot()
    const packageTree = makePackage({ name: 'escaping', root })
    writeFileSync(join(root, 'outside.txt'), 'outside\n')
    symlinkSync('z-redirect', join(packageTree, 'a-chain'))
    symlinkSync('../../outside.txt', join(packageTree, 'z-redirect'))

    await expect(
      assembleStoreEntry({
        bins: [],
        dependencies: [],
        output: join(root, 'escaping-entry'),
        packageName: 'escaping',
        packageTree,
      }),
    ).rejects.toThrow(/chained target escapes its declared tree/)
  })
})

describe('strongly connected component assembly', () => {
  const cyclicGroup = ({ root }: { root: string }) => ({
    bins: [],
    external: [],
    externalBins: [],
    internal: [
      { name: 'right', sourceStoreKey: 'left@1.0.0', targetStoreKey: 'right@1.0.0' },
      { name: 'left', sourceStoreKey: 'right@1.0.0', targetStoreKey: 'left@1.0.0' },
    ],
    members: [
      { packageName: 'left', packageTree: makePackage({ name: 'left', root }), storeKey: 'left@1.0.0' },
      {
        packageName: 'right',
        packageTree: makePackage({ name: 'right', root }),
        storeKey: 'right@1.0.0',
      },
    ],
    output: join(root, 'group'),
  })

  it('gives each member a distinct namespace and resolves the cycle both ways', async () => {
    const root = makeRoot()
    const options = cyclicGroup({ root })
    await assembleStoreScc(options)

    const { files, links } = await census(options.output)
    expect(files).toEqual([
      'left@1.0.0/node_modules/left/index.js',
      'right@1.0.0/node_modules/right/index.js',
    ])
    expect(links).toEqual([
      'left@1.0.0/node_modules/right',
      'right@1.0.0/node_modules/left',
    ])
    expect(await readlink(join(options.output, 'left@1.0.0', 'node_modules', 'right'))).toBe(
      '../../right@1.0.0/node_modules/right',
    )
    expect(
      statSync(join(options.output, 'left@1.0.0', 'node_modules', 'right', 'index.js')).isFile(),
    ).toBe(true)
    expect(
      statSync(join(options.output, 'right@1.0.0', 'node_modules', 'left', 'index.js')).isFile(),
    ).toBe(true)
  })

  it('rejects a duplicate member namespace', async () => {
    const root = makeRoot()
    const options = cyclicGroup({ root })
    await expect(
      assembleStoreScc({
        ...options,
        members: [...options.members, options.members[0]!],
      }),
    ).rejects.toThrow(/duplicate member namespace/)
  })

  it('rejects an edge to a package outside the declared component', async () => {
    const root = makeRoot()
    const options = cyclicGroup({ root })
    await expect(
      assembleStoreScc({
        ...options,
        internal: [
          ...options.internal,
          { name: 'outside', sourceStoreKey: 'left@1.0.0', targetStoreKey: 'outside@1.0.0' },
        ],
      }),
    ).rejects.toThrow(/outside the declared component/)
  })

  it('rejects a member namespace that traverses out of the group', async () => {
    const root = makeRoot()
    const options = cyclicGroup({ root })
    await expect(
      assembleStoreScc({
        ...options,
        members: [{ ...options.members[0]!, storeKey: '../escape' }, options.members[1]!],
      }),
    ).rejects.toThrow(/member key must be normalized/)
  })
})

describe('importer dependency view assembly', () => {
  it('materializes links only, so a consumer receives no dependency bytes', async () => {
    const root = makeRoot()
    const entry = join(root, 'entries', 'left')
    mkdirSync(join(root, 'entries'), { recursive: true })
    await assembleStoreEntry({
      bins: [],
      dependencies: [],
      output: entry,
      packageName: 'left',
      packageTree: makePackage({
        files: { 'bin/cli.js': '#!/usr/bin/env node\n', 'index.js': 'x\n' },
        name: 'left',
        root,
      }),
    })
    const workspace = join(root, 'workspace')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'package.json'), '{"name":"@overeng/lib"}\n')

    const view = join(root, 'view')
    await assembleStoreView({
      bins: [
        {
          entryDir: join(entry, 'node_modules'),
          executable: 'bin/cli.js',
          name: 'left',
          packageName: 'left',
        },
      ],
      links: [
        {
          entryDir: join(entry, 'node_modules'),
          name: 'left',
          packageName: 'left',
        },
      ],
      output: view,
      workspaceLinks: [{ name: '@overeng/lib', workspaceDir: workspace }],
    })

    const { files, links } = await census(view)
    expect(files).toEqual([])
    expect(links).toEqual(['.bin/left', '@overeng/lib', 'left'])
    for (const linkPath of links) {
      expect(isAbsolute(readlinkSync(join(view, linkPath)))).toBe(false)
    }
    expect(statSync(join(view, 'left', 'index.js')).isFile()).toBe(true)
    expect(statSync(join(view, '.bin', 'left')).isFile()).toBe(true)
    expect(statSync(join(view, '@overeng/lib', 'package.json')).isFile()).toBe(true)
  })

  it('rejects two dependencies claiming the same first hop', async () => {
    const root = makeRoot()
    const entry = join(root, 'entry')
    await assembleStoreEntry({
      bins: [],
      dependencies: [],
      output: entry,
      packageName: 'left',
      packageTree: makePackage({ name: 'left', root }),
    })
    await expect(
      assembleStoreView({
        bins: [],
        links: [
          {
            entryDir: join(entry, 'node_modules'),
            name: 'left',
            packageName: 'left',
          },
          {
            entryDir: join(entry, 'node_modules'),
            name: 'left',
            packageName: 'left',
          },
        ],
        output: join(root, 'view'),
        workspaceLinks: [],
      }),
    ).rejects.toThrow(/duplicate view link/)
  })

  it('leaves no partial output when assembly fails', async () => {
    const root = makeRoot()
    const view = join(root, 'view')
    await expect(
      assembleStoreView({
        bins: [],
        links: [{ entryDir: join(root, 'missing'), name: 'left', packageName: 'left' }],
        output: view,
        workspaceLinks: [],
      }),
    ).rejects.toThrow(/names undeclared tree/)
    expect(() => statSync(view)).toThrow()
  })
})

describe('store assembly command line', () => {
  it('drives entry mode from Buck action arguments', async () => {
    const root = makeRoot()
    const entry = join(root, 'entry')
    await runStoreAssemblyCli([
      '--mode',
      'entry',
      '--output',
      entry,
      '--package-name',
      'left',
      '--package-tree',
      makePackage({ name: 'left', root }),
    ])

    expect(statSync(join(entry, 'node_modules', 'left', 'index.js')).isFile()).toBe(true)
  })

  it('materializes a grafted override in place of the registry archive', async () => {
    const root = makeRoot()
    const entry = join(root, 'entry')
    // A Nix-built native addon looks exactly like this: the package tree plus
    // a compiled artifact the registry archive cannot carry.
    const override = makePackage({
      files: { 'build/Release/pty.node': 'native bytes\n', 'index.js': 'module.exports = 1\n' },
      name: 'grafted',
      root,
    })
    await runStoreAssemblyCli([
      '--mode',
      'entry',
      '--output',
      entry,
      '--package-name',
      'left',
      '--package-override',
      override,
    ])

    expect(
      statSync(join(entry, 'node_modules', 'left', 'build', 'Release', 'pty.node')).isFile(),
    ).toBe(true)
  })

  it('refuses two declared sources of one entry, and refuses none', async () => {
    const root = makeRoot()
    await expect(
      runStoreAssemblyCli([
        '--mode',
        'entry',
        '--output',
        join(root, 'both'),
        '--package-name',
        'left',
        '--package-tree',
        makePackage({ name: 'left', root }),
        '--package-override',
        makePackage({ name: 'right', root }),
      ]),
    ).rejects.toThrow(/--package-tree and --package-override are mutually exclusive/)
    await expect(
      runStoreAssemblyCli(['--mode', 'entry', '--output', join(root, 'none'), '--package-name', 'left']),
    ).rejects.toThrow(/missing --package-tree/)
  })

  it('refuses a relative override, which no immutable declared directory is', async () => {
    const root = makeRoot()
    await expect(
      runStoreAssemblyCli([
        '--mode',
        'entry',
        '--output',
        join(root, 'relative'),
        '--package-name',
        'left',
        '--package-override',
        'node_modules/node-pty',
      ]),
    ).rejects.toThrow(/--package-override must be an absolute directory/)
  })

  it('rejects an unknown mode rather than assembling something else', async () => {
    const root = makeRoot()
    await expect(
      runStoreAssemblyCli(['--mode', 'closure', '--output', join(root, 'out')]),
    ).rejects.toThrow(/--mode must be one of entry, scc, view/)
  })
})
