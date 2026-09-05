import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  assemblePortableFarm,
  assertNoUnboundRequireMain,
  assertPortableModuleComments,
  bareSpecifierPackage,
  createEntryOverridePlugin,
  parsePackageCommand,
  projectProductDescriptor,
  requireNormalizedRelativePath,
  verifyExternalSurface,
} from './package-command-runner.ts'

const scratchDirectories: string[] = []

const scratch = (prefix: string): string => {
  const root = mkdtempSync(join(tmpdir(), prefix))
  scratchDirectories.push(root)
  return root
}

afterEach(() => {
  for (const directory of scratchDirectories.splice(0))
    rmSync(directory, { force: true, recursive: true })
})

/**
 * A Buck-shaped package view: the package's own sources plus a `node_modules`
 * symlink into a separate declared dependency-view artifact, whose entries are
 * themselves relative symlinks into per-package artifact roots. Nothing about
 * the resolvable tree is reachable without following a link out of it.
 */
const createViewFixture = (
  root: string,
): {
  readonly closureRoots: readonly { readonly name: string; readonly path: string }[]
  readonly packageTree: string
} => {
  const tree = join(root, 'art', 'pkg', '__package_tree__', 'package_tree')
  const view = join(root, 'art', 'deps', '__view_pkg__', 'node_modules')
  const left = join(root, 'art', 'deps', '__entry_left__', 'entry', 'node_modules')
  const right = join(root, 'art', 'deps', '__entry_right__', 'entry', 'node_modules')
  const gated = join(root, 'art', 'deps', '__entry_gated__', 'entry', 'node_modules')

  mkdirSync(join(tree, 'src'), { recursive: true })
  writeFileSync(join(tree, 'package.json'), '{"name":"fixture","type":"module"}\n')
  writeFileSync(
    join(tree, 'src', 'cli.ts'),
    [
      "import { left } from 'left'",
      "import { helper } from './helper.ts'",
      'if (import.meta.main) console.log(left, helper())',
      '',
    ].join('\n'),
  )
  writeFileSync(
    join(tree, 'src', 'helper.ts'),
    'export const helper = (): boolean => import.meta.main\n',
  )

  mkdirSync(join(left, 'left'), { recursive: true })
  writeFileSync(
    join(left, 'left', 'package.json'),
    '{"name":"left","version":"1.0.0","main":"index.js"}\n',
  )
  writeFileSync(
    join(left, 'left', 'index.js'),
    "import { right } from 'right'\nexport const left = `left:${right}`\n",
  )
  // `left` reaches `right` through a sibling link inside its OWN artifact root,
  // which is why the farm must materialize a whole root rather than only the
  // subtree a link points at.
  symlinkSync('../../../__entry_right__/entry/node_modules/right', join(left, 'right'))
  // ... and `right` links back to `left`: a real lockfile cycle the farm must
  // terminate on instead of expanding.
  mkdirSync(join(right, 'right'), { recursive: true })
  writeFileSync(
    join(right, 'right', 'package.json'),
    '{"name":"right","version":"1.0.0","main":"index.js"}\n',
  )
  writeFileSync(join(right, 'right', 'index.js'), "export const right = 'right'\n")
  symlinkSync('../../../__entry_left__/entry/node_modules/left', join(right, 'left'))

  mkdirSync(join(gated, '@scope', 'gated-linux-x64'), { recursive: true })
  writeFileSync(
    join(gated, '@scope', 'gated-linux-x64', 'package.json'),
    '{"name":"@scope/gated-linux-x64"}\n',
  )
  writeFileSync(join(gated, '@scope', 'gated-linux-x64', 'index.js'), "export default 'native'\n")

  mkdirSync(view, { recursive: true })
  symlinkSync('../../__entry_left__/entry/node_modules/left', join(view, 'left'))
  symlinkSync('../../__entry_right__/entry/node_modules/right', join(view, 'right'))
  mkdirSync(join(view, '@scope'))
  symlinkSync(
    '../../../__entry_gated__/entry/node_modules/@scope/gated-linux-x64',
    join(view, '@scope', 'gated-linux-x64'),
  )
  symlinkSync(view, join(tree, 'node_modules'))

  return {
    closureRoots: [
      { name: 'cell/deps/view_pkg/node_modules', path: view },
      { name: 'cell/deps/entry_left/entry', path: join(left, '..') },
      { name: 'cell/deps/entry_right/entry', path: join(right, '..') },
      { name: 'cell/deps/entry_gated/entry', path: join(gated, '..') },
    ],
    packageTree: tree,
  }
}

describe('the realpath-closed hardlink farm', () => {
  it('materializes the resolvable tree with hardlinks, never copies and never escapes', () => {
    const { closureRoots, packageTree } = createViewFixture(scratch('farm-'))
    const farmRoot = join(scratch('farm-out-'), 'farm')

    const farm = assemblePortableFarm({
      closureRoots,
      gatedPackages: [],
      packageTree,
      root: farmRoot,
    })

    const source = statSync(join(packageTree, 'src', 'cli.ts'))
    const linked = statSync(join(farm, 'src', 'cli.ts'))
    expect(linked.ino).toBe(source.ino)
    expect(linked.nlink).toBeGreaterThan(1)
    // A store entry keeps its dependencies as siblings in its own
    // `node_modules`, so resolution from `left` finds `right` one level up —
    // and both realpaths must land inside the farm.
    const inside = `${realpathSync(farm)}/`
    const leftImage = realpathSync(join(farm, 'node_modules', 'left', 'index.js'))
    const rightViaLeft = realpathSync(join(farm, 'node_modules', 'left', '..', 'right', 'index.js'))
    expect(leftImage.startsWith(inside)).toBe(true)
    expect(rightViaLeft.startsWith(inside)).toBe(true)
  })

  it('terminates on a dependency cycle instead of expanding it forever', () => {
    const { closureRoots, packageTree } = createViewFixture(scratch('farm-cycle-'))
    const farmRoot = join(scratch('farm-cycle-out-'), 'farm')

    const farm = assemblePortableFarm({
      closureRoots,
      gatedPackages: [],
      packageTree,
      root: farmRoot,
    })

    // left's sibling `right` links into right's image, whose own sibling
    // `left` links back: the cycle resolves to the farm's single left image
    // instead of a second, deeper copy of it.
    const rightImage = realpathSync(join(farm, 'node_modules', 'right'))
    expect(realpathSync(join(rightImage, '..', 'left'))).toBe(
      realpathSync(join(farm, 'node_modules', 'left')),
    )
  })

  it('omits a platform-gated package so a host-native binding cannot be inlined', () => {
    const { closureRoots, packageTree } = createViewFixture(scratch('farm-gated-'))
    const farmRoot = join(scratch('farm-gated-out-'), 'farm')

    const farm = assemblePortableFarm({
      closureRoots,
      gatedPackages: ['@scope/gated-linux-x64'],
      packageTree,
      root: farmRoot,
    })

    expect(() => lstatSync(join(farm, 'node_modules', '@scope', 'gated-linux-x64'))).toThrow()
    expect(lstatSync(join(farm, 'node_modules', 'left')).isSymbolicLink()).toBe(true)
  })

  it('rejects a symlink whose target belongs to no declared closure root', () => {
    const root = scratch('farm-undeclared-')
    const { packageTree } = createViewFixture(root)
    const farmRoot = join(scratch('farm-undeclared-out-'), 'farm')

    expect(() =>
      assemblePortableFarm({ closureRoots: [], gatedPackages: [], packageTree, root: farmRoot }),
    ).toThrow('escapes every declared closure root')
  })
})

/**
 * The whole bundle path, driven exactly as the Buck action drives it.
 *
 * A product is only portable if the same declared graph produces the same
 * bytes from a different checkout layout, so this runs the real runner twice
 * under different absolute roots and different scratch directories.
 */
const bundleProduct = (prefix: string): { readonly bytes: string; readonly descriptor: string } => {
  const root = scratch(prefix)
  const { closureRoots, packageTree } = createViewFixture(join(root, 'deep', 'nested'))
  const output = join(root, 'out', 'cli.js')
  const descriptor = join(root, 'out', 'module.json')
  const manifest = join(root, 'gated.json')
  writeFileSync(
    manifest,
    `${JSON.stringify({
      schema: 'effect-utils/pnpm-platform-gated-packages/v1',
      families: [
        {
          capability: null,
          family: '@scope/gated',
          packages: ['@scope/gated-linux-x64'],
        },
      ],
      packages: ['@scope/gated-linux-x64'],
    })}\n`,
  )
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      join(import.meta.dir, 'package-command-runner.ts'),
      'bundle',
      process.execPath,
      packageTree,
      'src/cli.ts',
      output,
      '--target',
      'node',
      '--kind',
      'cli',
      '--descriptor',
      descriptor,
      '--closure-identity',
      `${root};fixture//p:package_tree`,
      '--target-identity',
      'fixture//p:cli-module',
      '--platform-gated-manifest',
      manifest,
      ...closureRoots.flatMap((closureRoot) => [
        '--closure-root',
        `${closureRoot.name}\t${closureRoot.path}`,
      ]),
    ],
    env: { ...process.env, BUCK_SCRATCH_PATH: join(root, 'scratch') },
    stderr: 'pipe',
    stdout: 'pipe',
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return { bytes: readFileSync(output, 'utf8'), descriptor: readFileSync(descriptor, 'utf8') }
}

describe('a bundled portable product', () => {
  it('is byte-identical from two unrelated checkout roots and scratch paths', () => {
    const first = bundleProduct('bundle-a-')
    const second = bundleProduct('bundle-b-')

    expect(second.bytes).toBe(first.bytes)
    expect(JSON.parse(second.descriptor)['integrity']).toBe(
      JSON.parse(first.descriptor)['integrity'],
    )
  })

  it('records only build-root-relative module paths and no unbound require.main', () => {
    const { bytes } = bundleProduct('bundle-paths-')

    expect(() => assertPortableModuleComments(bytes)).not.toThrow()
    expect(bytes).not.toContain('__require.main')
    expect(bytes).toContain('.closure/cell/deps/entry_left/entry/node_modules/left/index.js')
  })

  it('leaves the gated package external instead of inlining a host-native binding', () => {
    const { descriptor } = bundleProduct('bundle-gated-')

    expect(JSON.parse(descriptor)).toMatchObject({
      schema: 'effect-utils/javascript-module/v2',
      platform: { abi: 'any', architecture: 'any', os: 'any' },
      productKind: 'cli',
      externalModules: [],
    })
  })
})

describe('the CLI entry override', () => {
  const loadOnce = (
    entry: string,
    candidate: string,
  ): { readonly overrides: number; readonly contents: string | undefined } => {
    let overrides = 0
    const plugin = createEntryOverridePlugin({ entry, onOverride: () => (overrides += 1) })
    let handler: ((args: { readonly path: string }) => unknown) | undefined
    plugin.setup({
      onLoad: (_filter: unknown, callback: (args: { readonly path: string }) => unknown) => {
        handler = callback
      },
    } as never)
    const result = handler?.({ path: candidate }) as { readonly contents?: string } | undefined
    return { contents: result?.contents, overrides }
  }

  it('fires exactly once and replaces only the entry guard', () => {
    const { packageTree } = createViewFixture(scratch('entry-'))
    const entry = join(packageTree, 'src', 'cli.ts')

    const { contents, overrides } = loadOnce(entry, entry)

    expect(overrides).toBe(1)
    expect(contents).toContain('if (true) console.log')
    expect(readFileSync(join(packageTree, 'src', 'helper.ts'), 'utf8')).toContain(
      'import.meta.main',
    )
  })

  it('matches through a symlinked build root, which is how Darwin reports /tmp', () => {
    const { packageTree } = createViewFixture(scratch('entry-symlink-'))
    const alias = join(scratch('entry-alias-'), 'private')
    symlinkSync(packageTree, alias)

    expect(
      loadOnce(join(alias, 'src', 'cli.ts'), join(packageTree, 'src', 'cli.ts')).overrides,
    ).toBe(1)
  })

  it('does not fire for a module which is not the entry', () => {
    const { packageTree } = createViewFixture(scratch('entry-other-'))

    expect(
      loadOnce(join(packageTree, 'src', 'cli.ts'), join(packageTree, 'src', 'helper.ts')).overrides,
    ).toBe(0)
  })
})

describe('post-build portability assertions', () => {
  it('rejects an absolute module comment', () => {
    expect(() => assertPortableModuleComments('// /nix/store/x/index.js\nvar a = 1\n')).toThrow(
      'records absolute module paths',
    )
  })

  it('rejects a module comment which leaves the build root', () => {
    expect(() => assertPortableModuleComments('// ../outside/index.js\nvar a = 1\n')).toThrow(
      'outside the build root',
    )
  })

  it('accepts build-root-relative module comments', () => {
    expect(() =>
      assertPortableModuleComments('// src/cli.ts\n// node_modules/left/index.js\n'),
    ).not.toThrow()
  })

  it('rejects a CLI payload carrying Bun unbound import.meta.main lowering', () => {
    expect(() => assertNoUnboundRequireMain('if (__require.main == __require.module) {}')).toThrow(
      '__require.main',
    )
  })
})

describe('the verified external surface', () => {
  const gatedManifest = {
    families: [
      {
        capability: 'opentui-core-native',
        family: '@opentui/core',
        packages: ['@opentui/core-linux-x64'],
      },
      { capability: null, family: 'fsevents', packages: ['fsevents'] },
    ],
    packages: ['@opentui/core-linux-x64', 'fsevents'],
  }

  it('ignores prefixed, relative, and Node builtin specifiers on both targets', () => {
    for (const target of ['bun', 'node'] as const) {
      expect(bareSpecifierPackage({ specifier: 'node:fs', target })).toBeUndefined()
      expect(bareSpecifierPackage({ specifier: 'bun:sqlite', target })).toBeUndefined()
      expect(bareSpecifierPackage({ specifier: 'fs', target })).toBeUndefined()
      expect(bareSpecifierPackage({ specifier: './local.js', target })).toBeUndefined()
      expect(bareSpecifierPackage({ specifier: '@opentui/core-linux-x64/index.js', target })).toBe(
        '@opentui/core-linux-x64',
      )
    }
  })

  it('recognizes a bare `bun` import as a builtin only when the target is bun', () => {
    expect(bareSpecifierPackage({ specifier: 'bun', target: 'bun' })).toBeUndefined()
    // On node it is an ordinary unresolvable package, and treating it as a
    // builtin would let the product ship an import that fails at run time.
    expect(bareSpecifierPackage({ specifier: 'bun', target: 'node' })).toBe('bun')
  })

  it('fails a node bundle that leaves a bare `bun` import external', () => {
    expect(() =>
      verifyExternalSurface({
        allowed: [],
        declaredCapabilities: [],
        gatedManifest,
        specifiers: ['bun'],
        target: 'node',
      }),
    ).toThrow('bundle leaves undeclared bare imports external: bun')
  })

  it('accepts the same bundle when it targets bun', () => {
    expect(
      verifyExternalSurface({
        allowed: [],
        declaredCapabilities: [],
        gatedManifest,
        specifiers: ['bun'],
        target: 'bun',
      }),
    ).toStrictEqual({ capabilities: [], modules: [] })
  })

  it('rejects a bare import the product never declared external', () => {
    expect(() =>
      verifyExternalSurface({
        allowed: ['@opentui/core-linux-x64', 'fsevents'],
        declaredCapabilities: ['opentui-core-native'],
        gatedManifest,
        specifiers: ['left'],
        target: 'node',
      }),
    ).toThrow('bundle leaves undeclared bare imports external: left')
  })

  it('requires the capability a surviving Nix-grafted external needs', () => {
    expect(() =>
      verifyExternalSurface({
        allowed: ['@opentui/core-linux-x64'],
        declaredCapabilities: [],
        gatedManifest,
        specifiers: ['@opentui/core-linux-x64'],
        target: 'node',
      }),
    ).toThrow('does not declare that external capability')
  })

  it('rejects a declared native capability no bare import in the bundle requires', () => {
    expect(() =>
      verifyExternalSurface({
        allowed: ['@opentui/core-linux-x64', 'fsevents'],
        declaredCapabilities: ['opentui-core-native'],
        gatedManifest,
        specifiers: ['./local.js'],
        target: 'node',
      }),
    ).toThrow('remove the declaration')
  })

  it('carries a capability of an unrelated kind through untouched', () => {
    expect(
      verifyExternalSurface({
        allowed: [],
        declaredCapabilities: ['git', 'oxfmt'],
        gatedManifest,
        specifiers: ['node:path'],
        target: 'node',
      }),
    ).toStrictEqual({ capabilities: ['git', 'oxfmt'], modules: [] })
  })

  it('records the verified external module set', () => {
    expect(
      verifyExternalSurface({
        allowed: ['@opentui/core-linux-x64', 'fsevents'],
        declaredCapabilities: ['opentui-core-native'],
        gatedManifest,
        specifiers: ['fsevents', '@opentui/core-linux-x64', 'node:path', './x.js'],
        target: 'node',
      }),
    ).toStrictEqual({
      capabilities: ['opentui-core-native'],
      modules: ['@opentui/core-linux-x64', 'fsevents'],
    })
  })
})

describe('the product descriptor projection', () => {
  const moduleDescriptor = {
    schema: 'effect-utils/javascript-module/v2',
    productKind: 'cli',
    runtimeKind: 'node',
    runtimeContract: 'javascript-esm',
    runtimeContractVersion: 'v1',
    platform: { abi: 'any', architecture: 'any', os: 'any' },
    modulePath: 'tool.js',
    integrity: 'sha256-abc',
    sizeBytes: 12,
    target: 'cell//p:tool-module',
    externalCapabilities: ['git'],
    externalModules: [],
    provenance: { dependencyClosureIdentity: '/nix/store/producer/bin/bun;cell//p:package_tree' },
  }
  const command = {
    descriptor: '/out/product.json',
    moduleDescriptor: '/out/module.json',
    productKind: 'cli' as const,
    productName: 'tool',
    provenance: { configuredTarget: 'cell//p:tool (cell//pl:linux_x86_64#deadbeef)' },
    targetIdentity: 'cell//p:tool',
  }

  it('carries the module bytes identity and the product name into the descriptor', () => {
    expect(projectProductDescriptor({ command, module: moduleDescriptor })).toMatchObject({
      schema: 'effect-utils/javascript-product/v2',
      productName: 'tool',
      productKind: 'cli',
      integrity: 'sha256-abc',
      sizeBytes: 12,
      platform: { abi: 'any', architecture: 'any', os: 'any' },
      target: 'cell//p:tool',
    })
  })

  it('keeps the producer identity as provenance only', () => {
    const descriptor = projectProductDescriptor({ command, module: moduleDescriptor })

    expect(descriptor['provenance']).toStrictEqual({
      configuredTarget: 'cell//p:tool (cell//pl:linux_x86_64#deadbeef)',
      module: 'cell//p:tool-module',
    })
  })

  it('rejects a module descriptor of an unsupported schema', () => {
    expect(() =>
      projectProductDescriptor({
        command,
        module: { ...moduleDescriptor, schema: 'effect-utils/javascript-module/v1' },
      }),
    ).toThrow('unsupported module descriptor schema')
  })

  it('rejects a module built for a host platform', () => {
    expect(() =>
      projectProductDescriptor({
        command,
        module: {
          ...moduleDescriptor,
          platform: { abi: 'glibc', architecture: 'x86_64', os: 'linux' },
        },
      }),
    ).toThrow('not built for the portable JavaScript platform')
  })

  it('rejects a product kind which disagrees with the module', () => {
    expect(() =>
      projectProductDescriptor({ command, module: { ...moduleDescriptor, productKind: 'module' } }),
    ).toThrow('module descriptor declares product kind module')
  })
})

describe('package command runner', () => {
  it('rejects paths which can escape the declared package tree', () => {
    expect(() =>
      requireNormalizedRelativePath({ name: 'entrypoint', value: '../outside.ts' }),
    ).toThrow('entrypoint must be a normalized portable relative path')
  })

  it('preserves repeated arguments and explicit environment entries', () => {
    expect(
      parsePackageCommand([
        'exec',
        '/nix/store/runtime/bin/bun',
        '/buck/package-tree',
        'node_modules/storybook/dist/bin/dispatcher.js',
        '-',
        '--arg',
        'dev',
        '--arg',
        '-p',
        '--arg',
        '6009',
        '--env',
        'CI=1',
      ]),
    ).toMatchObject({ args: ['dev', '-p', '6009'], env: { CI: '1' } })
  })

  it('requires exactly one output placeholder for finite directory builds', () => {
    expect(() =>
      parsePackageCommand([
        'build-dir',
        '/nix/store/runtime/bin/bun',
        '/buck/package-tree',
        'node_modules/storybook/dist/bin/dispatcher.js',
        '/buck/storybook-static',
        '--arg',
        'build',
      ]),
    ).toThrow('build-dir requires exactly one {OUT} argument')
  })

  const bundle = [
    'bundle',
    '/nix/store/runtime/bin/node',
    '/buck/package-tree',
    'src/cli.ts',
    '/buck/out/cli.js',
    '--target-identity',
    'cell//p:cli-module',
  ]

  it('defaults a bundle to a library module and accepts a declared CLI entry', () => {
    expect(parsePackageCommand(bundle)).toMatchObject({ kind: 'module' })
    expect(parsePackageCommand([...bundle, '--kind', 'cli'])).toMatchObject({ kind: 'cli' })
  })

  it('requires a bundle to name the target it is produced by', () => {
    expect(() => parsePackageCommand(bundle.slice(0, 5))).toThrow(
      'bundle requires the producing target identity',
    )
  })

  it('reads one closure root per declared artifact', () => {
    expect(
      parsePackageCommand([
        ...bundle,
        '--closure-root',
        'cell/deps/entry_left/entry\tbuck-out/v2/art/x/entry',
      ]),
    ).toMatchObject({
      closureRoots: [{ name: 'cell/deps/entry_left/entry', path: 'buck-out/v2/art/x/entry' }],
    })
  })

  it('rejects a closure root which is not a name and a path', () => {
    expect(() => parsePackageCommand([...bundle, '--closure-root', 'no-tab'])).toThrow(
      'closure root must be <name>\\t<path>',
    )
  })

  it('rejects an unknown bundle kind', () => {
    expect(() => parsePackageCommand([...bundle, '--kind', 'library'])).toThrow(
      'unknown argument: --kind',
    )
  })

  describe('runtime arguments after the launcher delimiter', () => {
    const launch = [
      'exec',
      '/nix/store/runtime/bin/bun',
      '/buck/package-tree',
      'scripts/editor-view-authority.ts',
      '-',
    ]

    it('passes flag-shaped runtime arguments and their values through untouched', () => {
      expect(
        parsePackageCommand([
          ...launch,
          '--',
          '--repo-root',
          '/repo',
          '--output',
          '/repo/.devenv/authority.json',
          '--help',
        ]),
      ).toMatchObject({
        args: [],
        runtimeArgs: ['--repo-root', '/repo', '--output', '/repo/.devenv/authority.json', '--help'],
      })
    })

    it('keeps declared arguments ahead of runtime arguments in order', () => {
      expect(
        parsePackageCommand([
          ...launch,
          '--arg',
          'dev',
          '--arg',
          '-p',
          '--arg',
          '6009',
          '--env',
          'CI=1',
          '--',
          '--host',
          '0.0.0.0',
        ]),
      ).toMatchObject({
        args: ['dev', '-p', '6009'],
        runtimeArgs: ['--host', '0.0.0.0'],
        env: { CI: '1' },
      })
    })

    it('treats every later token as a runtime argument, including a second delimiter', () => {
      expect(
        parsePackageCommand([...launch, '--', '--arg', 'not-a-launcher-flag', '--', 'trailing']),
      ).toMatchObject({
        args: [],
        runtimeArgs: ['--arg', 'not-a-launcher-flag', '--', 'trailing'],
      })
    })

    it('accepts a delimiter with no runtime arguments behind it', () => {
      expect(parsePackageCommand([...launch, '--'])).toMatchObject({ args: [], runtimeArgs: [] })
    })

    it('rejects runtime arguments for modes which produce a declared output', () => {
      expect(() =>
        parsePackageCommand([
          'build-dir',
          '/nix/store/runtime/bin/bun',
          '/buck/package-tree',
          'node_modules/storybook/dist/bin/dispatcher.js',
          '/buck/storybook-static',
          '--arg',
          'build',
          '--arg',
          '{OUT}',
          '--',
          '--extra',
        ]),
      ).toThrow('runtime arguments are only available to exec')
    })

    it('leaves non-exec parsing unchanged when no delimiter is present', () => {
      expect(
        parsePackageCommand([
          'check',
          '/nix/store/runtime/bin/bun',
          '/buck/package-tree',
          'src/cli.ts',
          '/buck/check.ok',
          '--arg',
          'verify',
          '--external-capability',
          'git',
        ]),
      ).toMatchObject({
        mode: 'check',
        args: ['verify'],
        runtimeArgs: [],
        externalCapabilities: ['git'],
      })
    })
  })
})
