import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  normalizePortableCommonJsGlobals,
  parsePackageCommand,
  planPackageLaunch,
  projectProductDescriptor,
} from './package-command-runner.ts'

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
}
const productCommand = {
  descriptor: '/out/product.json',
  moduleDescriptor: '/out/module.json',
  productKind: 'cli' as const,
  productName: 'tool',
  provenance: {
    configuredTarget: 'cell//p:tool (cell//pl:javascript_portable#deadbeef)',
    dependencyClosureIdentity: 'runtime=node;package_tree=cell//p:package_tree',
  },
  targetIdentity: 'cell//p:tool',
}

describe('product descriptor projection', () => {
  it('carries byte identity, runtime, platform, external surface, and product identity', () => {
    expect(projectProductDescriptor({ command: productCommand, module: moduleDescriptor })).toEqual({
      schema: 'effect-utils/javascript-product/v2',
      productName: 'tool',
      productKind: 'cli',
      runtimeKind: 'node',
      runtimeContract: 'javascript-esm',
      runtimeContractVersion: 'v1',
      platform: { abi: 'any', architecture: 'any', os: 'any' },
      modulePath: 'tool.js',
      integrity: 'sha256-abc',
      sizeBytes: 12,
      target: 'cell//p:tool',
      externalCapabilities: ['git'],
      externalModules: [],
      provenance: {
        configuredTarget: productCommand.provenance.configuredTarget,
        dependencyClosureIdentity: productCommand.provenance.dependencyClosureIdentity,
        module: 'cell//p:tool-module',
      },
    })
  })

  it('rejects host-specific command provenance', () => {
    expect(() => projectProductDescriptor({
      command: { ...productCommand, provenance: { dependencyClosureIdentity: '/nix/store/producer/bin/bun;cell//p:tree' } },
      module: moduleDescriptor,
    })).toThrow('contains a host-specific Nix store path')
  })

  it('parses canonical repeatable declared roots beside launch arguments', () => {
    expect(parsePackageCommand([
      'exec',
      '/nix/store/runtime/bin/bun',
      '/project/tree',
      'scripts/dev.ts',
      '-',
      '--read-root',
      '/z-dependency',
      '--read-root',
      '/a-dependency',
      '--read-root',
      '/z-dependency',
    ]).readRoots).toEqual(['/a-dependency', '/z-dependency'])
  })

  it('rejects a wrong schema and host platform', () => {
    expect(() => projectProductDescriptor({ command: productCommand, module: { ...moduleDescriptor, schema: 'effect-utils/javascript-module/v1' } })).toThrow('unsupported module descriptor schema')
    expect(() => projectProductDescriptor({ command: productCommand, module: { ...moduleDescriptor, platform: { abi: 'glibc', architecture: 'x86_64', os: 'linux' } } })).toThrow('not built for the portable JavaScript platform')
  })
})

describe('resolved package launch plan', () => {
  const tree = 'buck-out/v2/gen/root/hash/pkg/__package_tree__/tree'
  const verdict = 'buck-out/v2/gen/root/hash/pkg/check.ok'

  it('resolves a project-relative check entrypoint before changing cwd', () => {
    const plan = planPackageLaunch({ command: parsePackageCommand(['check', '/nix/store/runtime/bin/bun', tree, 'src/mod.ts', verdict]) })
    expect(plan).toEqual({ cwd: resolve(tree), argv: ['/nix/store/runtime/bin/bun', resolve(tree, 'src/mod.ts')], output: resolve(verdict) })
  })

  it('resolves {OUT} and {TREE} placeholders', () => {
    const output = 'buck-out/v2/gen/root/hash/storybook-static'
    const plan = planPackageLaunch({ command: parsePackageCommand(['build-dir', '/nix/store/runtime/bin/bun', tree, 'node_modules/storybook/bin.js', output, '--arg', '{OUT}', '--arg', '{TREE}']) })
    expect(plan.argv).toEqual(['/nix/store/runtime/bin/bun', resolve(tree, 'node_modules/storybook/bin.js'), resolve(output), resolve(tree)])
  })

  it('launches native checks directly and preserves their arguments', () => {
    const plan = planPackageLaunch({ command: parsePackageCommand(['native-check', '/nix/store/runtime/bin/tsgo', tree, 'src/mod.ts', verdict, '--arg', '--noEmit']) })
    expect(plan.argv).toEqual(['/nix/store/runtime/bin/tsgo', '--noEmit'])
    expect(plan.output).toBe(resolve(verdict))
  })

  it('leaves absolute exec paths untouched and preserves runtime arguments', () => {
    const plan = planPackageLaunch({ command: parsePackageCommand(['exec', '/nix/store/runtime/bin/bun', '/project/tree', 'scripts/dev.ts', '-', '--arg', 'dev', '--', '--host', '0.0.0.0']) })
    expect(plan).toEqual({ cwd: '/project/tree', argv: ['/nix/store/runtime/bin/bun', '/project/tree/scripts/dev.ts', 'dev', '--host', '0.0.0.0'], output: undefined })
  })
})

describe('portable CommonJS globals', () => {
  it('rewrites build-host source paths to runtime bundle paths', () => {
    const root = '/tmp/portable-root'
    expect(normalizePortableCommonJsGlobals({ bundle: `var __dirname = "${root}/dependency", __filename = "${root}/dependency/index.cjs";`, root })).toBe('var __dirname = import.meta.dirname, __filename = import.meta.filename;')
  })

  it('rejects paths outside the build root and unclassified root occurrences', () => {
    expect(() => normalizePortableCommonJsGlobals({ bundle: 'var __dirname = "/foreign/dependency";', root: '/tmp/portable-root' })).toThrow('__dirname path escapes the build root')
    expect(() => normalizePortableCommonJsGlobals({ bundle: 'const leaked = "/tmp/portable-root/source.ts";', root: '/tmp/portable-root' })).toThrow('outside a CommonJS path declaration')
  })
})
