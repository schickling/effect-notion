import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  definePackageJson,
  exportEntry,
  packageJson,
  workspaceClosureReference,
  type GenieContext,
  type PackageInfo,
} from '../mod.ts'
import { defineCatalog } from './catalog.ts'
import {
  createNodePackageJsonValidationRuntime,
  nodePackageJsonValidationRuntime,
} from './node/export-environments.ts'

/** Reads one Buck-declared immutable tool path; nothing resolves through an ambient PATH. */
const requireTool = (name: string): string => {
  const tool = process.env[name]
  if (tool === undefined || tool === '')
    throw new Error(`declared test tool is unavailable: ${name}`)
  return tool
}

/** Fixture interpreter: the declared bash, so written fixtures never need an ambient `env`. */
const bashShebang = `#!${requireTool('BASH_BIN')}`

/** Mock GenieContext for package tests (nested package location) */
const mockGenieContext: GenieContext = {
  location: 'packages/@test/package',
  cwd: '/workspace',
}

/** Mock GenieContext for workspace root tests (repo root location) */
const mockWorkspaceRootContext: GenieContext = {
  location: '.',
  cwd: '/workspace',
}

const createTempRepo = (...memberPaths: string[]) => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-package-json-'))
  fs.mkdirSync(path.join(repoRoot, '.git'))

  return {
    repoRoot,
    repoName: path.basename(repoRoot),
    memberDirs: Object.fromEntries(
      memberPaths.map((memberPath) => {
        const memberDir = path.join(repoRoot, memberPath)
        fs.mkdirSync(memberDir, { recursive: true })
        return [memberPath, memberDir]
      }),
    ) as Record<string, string>,
  }
}

const workspace = ({ repoName, memberPath }: { repoName: string; memberPath: string }) => ({
  repoName,
  memberPath,
})

const testCatalog = defineCatalog({
  effect: '3.19.14',
  react: '19.2.3',
})

describe('packageJson', () => {
  it('returns GenieOutput with data and stringify', () => {
    const result = packageJson({
      name: '@test/package',
      version: '1.0.0',
    })

    expect(result.data).toEqual({
      name: '@test/package',
      version: '1.0.0',
    })
    expect(typeof result.stringify).toBe('function')
  })

  it('stringify produces valid JSON with $genie marker', () => {
    const result = packageJson({
      name: '@test/package',
      version: '1.0.0',
    })

    const json = result.stringify(mockGenieContext)
    const parsed = JSON.parse(json)

    expect(parsed.$genie).toEqual({
      source: 'package.json.genie.ts',
      warning: 'DO NOT EDIT - changes will be overwritten',
    })
    expect(parsed.name).toBe('@test/package')
    expect(parsed.version).toBe('1.0.0')
  })

  it('includes workspaceClosureDirs in $genie when workspace composition is used', () => {
    const repo = createTempRepo('packages/app', 'packages/lib')
    const libComposition = testCatalog.compose({
      workspace: workspace({ repoName: repo.repoName, memberPath: 'packages/lib' }),
    })
    const libPkg = packageJson({ name: '@test/lib', version: '1.0.0' }, libComposition)
    const appComposition = testCatalog.compose({
      workspace: workspace({ repoName: repo.repoName, memberPath: 'packages/app' }),
      dependencies: { workspace: [libPkg] },
    })
    const result = packageJson({ name: '@test/app', version: '1.0.0' }, appComposition)

    const parsed = JSON.parse(result.stringify(mockGenieContext))

    expect(parsed.$genie.workspaceClosureDirs).toEqual(['packages/app', 'packages/lib'])
  })

  it('projects recursive closure references without inheriting package behavior', () => {
    const nestedComposition = testCatalog.compose({
      workspace: workspace({ repoName: 'source', memberPath: 'packages/nested' }),
      peerDependencies: { external: testCatalog.peers('react') },
    })
    const nestedPkg = packageJson(
      {
        name: '@test/nested',
        pnpm: { patchedDependencies: { react: 'patches/react.patch' } },
      },
      nestedComposition,
    )
    const sourceComposition = testCatalog.compose({
      workspace: workspace({ repoName: 'source', memberPath: 'packages/source' }),
      dependencies: { workspace: [nestedPkg] },
      peerDependencies: { external: testCatalog.peers('effect') },
    })
    const sourcePkg = packageJson({ name: '@test/source' }, sourceComposition)

    const reference = workspaceClosureReference(sourcePkg)

    expect(reference.data).toEqual({ name: '@test/source' })
    expect(reference.meta.workspace.deps[0]?.data).toEqual({ name: '@test/nested' })
    expect(reference.meta.workspace.deps[0]?.meta.workspace.deps).toEqual([])
  })

  it('rejects an unnamed package anywhere in a closure reference', () => {
    const unnamedNested = packageJson(
      {},
      testCatalog.compose({
        workspace: workspace({ repoName: 'source', memberPath: 'packages/unnamed' }),
      }),
    )
    const namedPkg = packageJson(
      { name: '@test/source' },
      testCatalog.compose({
        workspace: workspace({ repoName: 'source', memberPath: 'packages/source' }),
        dependencies: { workspace: [unnamedNested] },
      }),
    )

    expect(() => workspaceClosureReference(namedPkg)).toThrow(
      'workspaceClosureReference requires every package in the closure to have a name',
    )
  })

  it('sorts dependencies alphabetically', () => {
    const result = packageJson({
      name: '@test/package',
      version: '1.0.0',
      dependencies: {
        zlib: '1.0.0',
        axios: '2.0.0',
        effect: '3.0.0',
      },
    })

    const json = result.stringify(mockGenieContext)
    const keys = Object.keys(JSON.parse(json).dependencies)
    expect(keys).toEqual(['axios', 'effect', 'zlib'])
  })

  it('sorts fields in conventional order', () => {
    const result = packageJson({
      dependencies: { effect: '3.0.0' },
      name: '@test/package',
      exports: { '.': './src/mod.ts' },
      version: '1.0.0',
      type: 'module',
    })

    const json = result.stringify(mockGenieContext)
    const keys = Object.keys(JSON.parse(json))

    const genieIdx = keys.indexOf('$genie')
    const nameIdx = keys.indexOf('name')
    const versionIdx = keys.indexOf('version')
    const typeIdx = keys.indexOf('type')
    const exportsIdx = keys.indexOf('exports')
    const depsIdx = keys.indexOf('dependencies')

    // Verify order: $genie < name < version < type < exports < dependencies
    expect(genieIdx).toBeLessThan(nameIdx)
    expect(nameIdx).toBeLessThan(versionIdx)
    expect(versionIdx).toBeLessThan(typeIdx)
    expect(typeIdx).toBeLessThan(exportsIdx)
    expect(exportsIdx).toBeLessThan(depsIdx)
  })

  it('sorts export conditions (types first, default last)', () => {
    const result = packageJson({
      name: '@test/package',
      version: '1.0.0',
      exports: {
        '.': {
          default: './dist/mod.js',
          types: './dist/mod.d.ts',
          import: './dist/mod.mjs',
        },
      },
    })

    const json = result.stringify(mockGenieContext)
    const parsed = JSON.parse(json)
    const conditions = Object.keys(parsed.exports['.'])
    expect(conditions).toEqual(['types', 'import', 'default'])
  })

  it('sorts export paths with "." first', () => {
    const result = packageJson({
      name: '@test/package',
      version: '1.0.0',
      exports: {
        './utils': './src/utils.ts',
        '.': './src/mod.ts',
        './types': './src/types.ts',
      },
    })

    const json = result.stringify(mockGenieContext)
    const parsed = JSON.parse(json)
    const paths = Object.keys(parsed.exports)
    expect(paths[0]).toBe('.')
  })

  it('normalizes exportEntry contracts into non-emitted package-json metadata', () => {
    const result = packageJson({
      name: '@test/package',
      version: '1.0.0',
      exports: {
        '.': exportEntry('./src/mod.ts', {
          environment: 'isomorphic-es2024',
          typeProof: 'strict',
        }),
      },
    })

    expect(result.data.exports).toEqual({
      '.': './src/mod.ts',
    })
    expect((result as any).meta.exportContracts).toEqual({
      '.': [
        {
          environment: 'isomorphic-es2024',
          typeProof: 'strict',
        },
      ],
    })
    expect(JSON.parse(result.stringify(mockGenieContext)).exports).toEqual({
      '.': './src/mod.ts',
    })
    expect(JSON.parse(result.stringify(mockGenieContext))).not.toHaveProperty('meta')
  })

  it('normalizes multiple exportEntry contracts for conditional exports', () => {
    const result = packageJson({
      name: '@test/package',
      version: '1.0.0',
      exports: {
        './cuid': exportEntry(
          {
            browser: './src/cuid.browser.ts',
            node: './src/cuid.node.ts',
            default: './src/cuid.ts',
          },
          [{ environment: 'browser' }, { environment: 'node' }],
        ),
      },
    })

    expect(result.data.exports).toEqual({
      './cuid': {
        browser: './src/cuid.browser.ts',
        node: './src/cuid.node.ts',
        default: './src/cuid.ts',
      },
    })
    expect((result as any).meta.exportContracts).toEqual({
      './cuid': [{ environment: 'browser' }, { environment: 'node' }],
    })
  })

  it('validates that contracted exports are mirrored in publishConfig.exports', () => {
    const result = packageJson({
      name: '@test/package',
      version: '1.0.0',
      exports: {
        '.': exportEntry('./src/mod.ts', {
          environment: 'isomorphic-es2024',
        }),
      },
      publishConfig: {
        exports: {},
      },
    })

    expect(result.validate?.(mockGenieContext)).toContainEqual({
      severity: 'error',
      packageName: '@test/package',
      dependency: '.',
      message:
        'Export environment contract is declared for ".", but publishConfig.exports does not contain the corresponding published subpath.',
      rule: 'package-json-export-environment-publish-target',
    })
  })

  it('does not require export environment contracts by default', () => {
    const result = packageJson({
      name: '@test/package',
      version: '1.0.0',
      exports: {
        '.': './src/mod.ts',
      },
    })

    expect(result.validate?.(mockGenieContext)).not.toContainEqual(
      expect.objectContaining({
        rule: 'package-json-export-environment-contract-coverage',
      }),
    )
  })

  it('allows export environment contract coverage to be baked into a configured generator', () => {
    const configuredPackageJson = definePackageJson({
      validation: {
        exportEnvironmentContracts: {
          coverage: 'warn',
        },
      },
    })

    const result = configuredPackageJson({
      name: '@test/package',
      version: '1.0.0',
      exports: {
        '.': './src/mod.ts',
      },
    })

    expect(result.validate?.(mockGenieContext)).toContainEqual({
      severity: 'warning',
      packageName: '@test/package',
      dependency: '.',
      message:
        'Package export "." has no export environment contract. Wrap the target with exportEntry(...), or add an explicit validation ignore while migrating.',
      rule: 'package-json-export-environment-contract-coverage',
    })
  })

  it('allows per-call export environment contract coverage overrides on a configured generator', () => {
    const configuredPackageJson = definePackageJson({
      validation: {
        exportEnvironmentContracts: {
          coverage: 'warn',
        },
      },
    })

    const result = configuredPackageJson(
      {
        name: '@test/package',
        version: '1.0.0',
        exports: {
          '.': './src/mod.ts',
        },
      },
      undefined,
      {
        validation: {
          exportEnvironmentContracts: {
            coverage: 'off',
          },
        },
      },
    )

    expect(result.validate?.(mockGenieContext)).not.toContainEqual(
      expect.objectContaining({
        rule: 'package-json-export-environment-contract-coverage',
      }),
    )
  })

  it('warns for uncontracted exports when export environment contract coverage is warn', () => {
    const result = packageJson(
      {
        name: '@test/package',
        version: '1.0.0',
        exports: {
          '.': './src/mod.ts',
        },
      },
      undefined,
      {
        validation: {
          exportEnvironmentContracts: {
            coverage: 'warn',
          },
        },
      },
    )

    expect(result.validate?.(mockGenieContext)).toContainEqual({
      severity: 'warning',
      packageName: '@test/package',
      dependency: '.',
      message:
        'Package export "." has no export environment contract. Wrap the target with exportEntry(...), or add an explicit validation ignore while migrating.',
      rule: 'package-json-export-environment-contract-coverage',
    })
  })

  it('errors for uncontracted exports when export environment contract coverage is error', () => {
    const result = packageJson(
      {
        name: '@test/package',
        version: '1.0.0',
        exports: {
          '.': './src/mod.ts',
        },
      },
      undefined,
      {
        validation: {
          exportEnvironmentContracts: {
            coverage: 'error',
          },
        },
      },
    )

    expect(result.validate?.(mockGenieContext)).toContainEqual({
      severity: 'error',
      packageName: '@test/package',
      dependency: '.',
      message:
        'Package export "." has no export environment contract. Wrap the target with exportEntry(...), or add an explicit validation ignore while migrating.',
      rule: 'package-json-export-environment-contract-coverage',
    })
  })

  it('ignores covered and explicitly ignored exports in contract coverage validation', () => {
    const result = packageJson(
      {
        name: '@test/package',
        version: '1.0.0',
        exports: {
          '.': './src/mod.ts',
          './legacy': './src/legacy.ts',
          './testing/foo': './src/testing/foo.ts',
          './testing/e2e/foo': './src/testing/e2e/foo.ts',
          './covered': exportEntry('./src/covered.ts', {
            environment: 'isomorphic-es2024',
          }),
        },
      },
      undefined,
      {
        validation: {
          exportEnvironmentContracts: {
            coverage: 'warn',
            ignore: ['.', './legacy', './testing/**'],
          },
        },
      },
    )

    expect(
      result
        .validate?.(mockGenieContext)
        .filter((issue) => issue.rule === 'package-json-export-environment-contract-coverage'),
    ).toEqual([])
  })

  it('allows source-only contracted exports to be absent from publishConfig.exports', () => {
    const result = packageJson({
      name: '@test/package',
      version: '1.0.0',
      exports: {
        '.': exportEntry('./src/mod.ts', {
          environment: 'isomorphic-es2024',
        }),
        './test': exportEntry('./src/test.ts', {
          environment: 'node',
          published: false,
        }),
      },
      publishConfig: {
        exports: {
          '.': './dist/mod.js',
        },
      },
    })

    expect(result.validate?.(mockGenieContext)).not.toContainEqual({
      severity: 'error',
      packageName: '@test/package',
      dependency: './test',
      message:
        'Export environment contract is declared for "./test", but publishConfig.exports does not contain the corresponding published subpath.',
      rule: 'package-json-export-environment-publish-target',
    })
  })

  it('uses the package-json node validation runtime to catch forbidden imports', () => {
    const repo = createTempRepo('packages/pkg')
    const packageDir = repo.memberDirs['packages/pkg']!
    fs.mkdirSync(path.join(packageDir, 'src'))
    fs.writeFileSync(
      path.join(packageDir, 'src/mod.ts'),
      "import fs from 'node:fs'\nexport const read = fs.readFileSync\n",
    )
    const result = packageJson({
      name: '@test/package',
      version: '1.0.0',
      exports: {
        '.': exportEntry('./src/mod.ts', {
          environment: 'isomorphic-es2024',
        }),
      },
    })

    const issues = result.validate?.({
      cwd: repo.repoRoot,
      location: 'packages/pkg',
      validation: { packageJson: nodePackageJsonValidationRuntime },
    })

    expect(issues).toContainEqual({
      severity: 'error',
      packageName: '@test/package',
      dependency: '.',
      message: expect.stringContaining('imports "node:fs"'),
      rule: 'package-json-export-environment-import',
    })
  })

  it('forbids bare Node builtin imports in constrained export environments', () => {
    const repo = createTempRepo('packages/pkg')
    const packageDir = repo.memberDirs['packages/pkg']!
    fs.mkdirSync(path.join(packageDir, 'src'))
    fs.writeFileSync(
      path.join(packageDir, 'src/mod.ts'),
      "import { readFile } from 'fs/promises'\nexport const read = readFile\n",
    )
    const result = packageJson({
      name: '@test/package',
      version: '1.0.0',
      exports: {
        '.': exportEntry('./src/mod.ts', {
          environment: 'isomorphic-es2024',
        }),
      },
    })

    const issues = result.validate?.({
      cwd: repo.repoRoot,
      location: 'packages/pkg',
      validation: { packageJson: nodePackageJsonValidationRuntime },
    })

    expect(issues).toContainEqual({
      severity: 'error',
      packageName: '@test/package',
      dependency: '.',
      message: expect.stringContaining('imports "fs/promises"'),
      rule: 'package-json-export-environment-import',
    })
  })

  it('follows NodeNext .js source imports when scanning export environments', () => {
    const repo = createTempRepo('packages/pkg')
    const packageDir = repo.memberDirs['packages/pkg']!
    fs.mkdirSync(path.join(packageDir, 'src'))
    fs.writeFileSync(path.join(packageDir, 'src/mod.ts'), "import './util.js'\n")
    fs.writeFileSync(path.join(packageDir, 'src/util.ts'), "import fs from 'node:fs'\nvoid fs\n")
    const result = packageJson({
      name: '@test/package',
      version: '1.0.0',
      exports: {
        '.': exportEntry('./src/mod.ts', {
          environment: 'isomorphic-es2024',
        }),
      },
    })

    const issues = result.validate?.({
      cwd: repo.repoRoot,
      location: 'packages/pkg',
      validation: { packageJson: nodePackageJsonValidationRuntime },
    })

    expect(issues).toContainEqual({
      severity: 'error',
      packageName: '@test/package',
      dependency: '.',
      message: expect.stringContaining('src/util.ts imports "node:fs"'),
      rule: 'package-json-export-environment-import',
    })
  })

  it('follows directory entrypoints when scanning extensionless source imports', () => {
    const repo = createTempRepo('packages/pkg')
    const packageDir = repo.memberDirs['packages/pkg']!
    fs.mkdirSync(path.join(packageDir, 'src/feature'), { recursive: true })
    fs.writeFileSync(path.join(packageDir, 'src/mod.ts'), "import './feature'\n")
    fs.writeFileSync(
      path.join(packageDir, 'src/feature/index.ts'),
      "import fs from 'node:fs'\nvoid fs\n",
    )
    const result = packageJson({
      name: '@test/package',
      version: '1.0.0',
      exports: {
        '.': exportEntry('./src/mod.ts', {
          environment: 'isomorphic-es2024',
        }),
      },
    })

    const issues = result.validate?.({
      cwd: repo.repoRoot,
      location: 'packages/pkg',
      validation: { packageJson: nodePackageJsonValidationRuntime },
    })

    expect(issues).toContainEqual({
      severity: 'error',
      packageName: '@test/package',
      dependency: '.',
      message: expect.stringContaining('src/feature/index.ts imports "node:fs"'),
      rule: 'package-json-export-environment-import',
    })
  })

  it('forbids direct process global usage in cheap isomorphic validation', () => {
    const repo = createTempRepo('packages/pkg')
    const packageDir = repo.memberDirs['packages/pkg']!
    fs.mkdirSync(path.join(packageDir, 'src'))
    fs.writeFileSync(path.join(packageDir, 'src/mod.ts'), 'export const env = process.env\n')
    const result = packageJson({
      name: '@test/package',
      version: '1.0.0',
      exports: {
        '.': exportEntry('./src/mod.ts', {
          environment: 'isomorphic-es2024',
        }),
      },
    })

    const issues = result.validate?.({
      cwd: repo.repoRoot,
      location: 'packages/pkg',
      validation: { packageJson: nodePackageJsonValidationRuntime },
    })

    expect(issues).toContainEqual({
      severity: 'error',
      packageName: '@test/package',
      dependency: '.',
      message: expect.stringContaining('references forbidden global "process"'),
      rule: 'package-json-export-environment-global',
    })
  })

  it('does not let scoped forbidden-global declarations mask outer usage', () => {
    const repo = createTempRepo('packages/pkg')
    const packageDir = repo.memberDirs['packages/pkg']!
    fs.mkdirSync(path.join(packageDir, 'src'))
    fs.writeFileSync(
      path.join(packageDir, 'src/mod.ts'),
      [
        'export const local = (process: { env: Record<string, string> }) => process.env.LOCAL',
        'export const outer = process.env.OUTER',
      ].join('\n'),
    )
    const result = packageJson({
      name: '@test/package',
      version: '1.0.0',
      exports: {
        '.': exportEntry('./src/mod.ts', {
          environment: 'isomorphic-es2024',
        }),
      },
    })

    const issues = result.validate?.({
      cwd: repo.repoRoot,
      location: 'packages/pkg',
      validation: { packageJson: nodePackageJsonValidationRuntime },
    })

    expect(
      issues?.filter(
        (issue) =>
          issue.rule === 'package-json-export-environment-global' &&
          issue.message.includes('references forbidden global "process"'),
      ),
    ).toHaveLength(1)
  })

  it('validates package export patterns against matching source files', () => {
    const repo = createTempRepo('packages/pkg')
    const packageDir = repo.memberDirs['packages/pkg']!
    fs.mkdirSync(path.join(packageDir, 'src/testing/e2e'), { recursive: true })
    fs.writeFileSync(path.join(packageDir, 'src/testing/ok.ts'), 'export const value = 1\n')
    fs.writeFileSync(
      path.join(packageDir, 'src/testing/not-ok.ts'),
      "import fs from 'node:fs'\nexport const value = fs.readFileSync\n",
    )
    fs.writeFileSync(
      path.join(packageDir, 'src/testing/e2e/not-ok.ts'),
      "import crypto from 'node:crypto'\nexport const value = crypto.randomUUID\n",
    )
    const result = packageJson({
      name: '@test/package',
      version: '1.0.0',
      exports: {
        './testing/*': exportEntry('./src/testing/*.ts', {
          environment: 'isomorphic-es2024',
        }),
      },
    })

    const issues = result.validate?.({
      cwd: repo.repoRoot,
      location: 'packages/pkg',
      validation: { packageJson: nodePackageJsonValidationRuntime },
    })

    expect(issues).toContainEqual({
      severity: 'error',
      packageName: '@test/package',
      dependency: './testing/*',
      message: expect.stringContaining('src/testing/not-ok.ts imports "node:fs"'),
      rule: 'package-json-export-environment-import',
    })
    expect(issues).toContainEqual({
      severity: 'error',
      packageName: '@test/package',
      dependency: './testing/*',
      message: expect.stringContaining('src/testing/e2e/not-ok.ts imports "node:crypto"'),
      rule: 'package-json-export-environment-import',
    })
  })

  it('resolves conditional export targets in emitted condition order', () => {
    const repo = createTempRepo('packages/pkg')
    const packageDir = repo.memberDirs['packages/pkg']!
    fs.mkdirSync(path.join(packageDir, 'src'))
    fs.writeFileSync(
      path.join(packageDir, 'src/browser.ts'),
      "import fs from 'node:fs'\nexport const read = fs.readFileSync\n",
    )
    fs.writeFileSync(path.join(packageDir, 'src/worker.ts'), 'export const value = 1\n')
    const result = packageJson({
      name: '@test/package',
      version: '1.0.0',
      exports: {
        '.': exportEntry(
          {
            browser: './src/browser.ts',
            worker: './src/worker.ts',
          },
          {
            environment: 'webworker',
          },
        ),
      },
    })

    const issues = result.validate?.({
      cwd: repo.repoRoot,
      location: 'packages/pkg',
      validation: { packageJson: nodePackageJsonValidationRuntime },
    })

    expect(issues).toContainEqual({
      severity: 'error',
      packageName: '@test/package',
      dependency: '.',
      message: expect.stringContaining('src/browser.ts imports "node:fs"'),
      rule: 'package-json-export-environment-import',
    })
  })

  it('invalidates strict proof cache entries when dependency metadata changes', () => {
    const repo = createTempRepo('packages/pkg')
    const packageDir = repo.memberDirs['packages/pkg']!
    fs.mkdirSync(path.join(packageDir, 'src'))
    fs.writeFileSync(path.join(repo.repoRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 11.0\n')
    fs.writeFileSync(path.join(repo.repoRoot, 'package.json'), '{"name":"repo"}\n')
    fs.writeFileSync(path.join(packageDir, 'package.json'), '{"name":"@test/package"}\n')
    fs.writeFileSync(path.join(packageDir, 'src/mod.ts'), 'export const value = 1\n')

    // The cache contract is what this test proves, so the proof itself runs through a
    // fixture compiler with a fixed `--version`: the key then varies only with the
    // dependency metadata the test rewrites.
    const compilerBin = path.join(repo.repoRoot, 'fake-tsgo')
    fs.writeFileSync(
      compilerBin,
      [
        bashShebang,
        'if [ "$1" = "--version" ]; then',
        '  echo "Fake TypeScript 1.0.0"',
        'fi',
        'exit 0',
      ].join('\n'),
    )
    fs.chmodSync(compilerBin, 0o755)
    const runtime = createNodePackageJsonValidationRuntime({
      typeProofCompiler: { path: compilerBin, kind: 'tsgo' },
    })

    const validate = () =>
      runtime.validateExportEnvironments({
        cwd: repo.repoRoot,
        location: 'packages/pkg',
        packageName: '@test/package',
        exports: { '.': './src/mod.ts' },
        contracts: {
          '.': [
            {
              environment: 'isomorphic-es2024',
              typeProof: 'strict',
            },
          ],
        },
      })

    expect(validate().cache).toEqual({ hits: 0, misses: 1 })
    expect(validate().cache).toEqual({ hits: 1, misses: 0 })

    fs.writeFileSync(
      path.join(repo.repoRoot, 'pnpm-lock.yaml'),
      'lockfileVersion: 11.0\nchanged: true\n',
    )

    expect(validate().cache).toEqual({ hits: 0, misses: 1 })
  }, 30_000)

  it('runs strict type proof through an explicit compiler executable', () => {
    const repo = createTempRepo('packages/pkg')
    const packageDir = repo.memberDirs['packages/pkg']!
    const compilerLog = path.join(repo.repoRoot, 'compiler-args.log')
    const compilerBin = path.join(repo.repoRoot, 'fake-tsgo')
    fs.mkdirSync(path.join(packageDir, 'src'))
    fs.writeFileSync(path.join(packageDir, 'src/mod.ts'), 'export const value = 1\n')
    fs.writeFileSync(
      compilerBin,
      [
        bashShebang,
        'if [ "$1" = "--version" ]; then',
        '  echo "Fake TypeScript 1.0.0"',
        '  exit 0',
        'fi',
        `printf "%s\\n" "$@" > ${JSON.stringify(compilerLog)}`,
      ].join('\n'),
    )
    fs.chmodSync(compilerBin, 0o755)

    const runtime = createNodePackageJsonValidationRuntime({
      typeProofCompiler: { path: compilerBin, kind: 'tsgo' },
    })
    const result = runtime.validateExportEnvironments({
      cwd: repo.repoRoot,
      location: 'packages/pkg',
      packageName: '@test/package',
      exports: { '.': './src/mod.ts' },
      contracts: {
        '.': [
          {
            environment: 'isomorphic-es2024',
            typeProof: 'strict',
          },
        ],
      },
    })

    expect(result.issues).toEqual([])
    expect(result.cache).toEqual({ hits: 0, misses: 1 })
    expect(fs.readFileSync(compilerLog, 'utf8')).toContain('--project')
  })

  it('reports strict type proof compiler failures as validation issues', () => {
    const repo = createTempRepo('packages/pkg')
    const packageDir = repo.memberDirs['packages/pkg']!
    const compilerBin = path.join(repo.repoRoot, 'fake-tsgo')
    fs.mkdirSync(path.join(packageDir, 'src'))
    fs.writeFileSync(path.join(packageDir, 'src/mod.ts'), 'export const value = 1\n')
    fs.writeFileSync(
      compilerBin,
      [
        bashShebang,
        'if [ "$1" = "--version" ]; then',
        '  echo "Fake TypeScript 1.0.0"',
        '  exit 0',
        'fi',
        'echo "src/mod.ts(1,1): error TS9999: fake compiler failure"',
        'exit 2',
      ].join('\n'),
    )
    fs.chmodSync(compilerBin, 0o755)

    const runtime = createNodePackageJsonValidationRuntime({
      typeProofCompiler: { path: compilerBin, kind: 'tsgo' },
    })
    const result = runtime.validateExportEnvironments({
      cwd: repo.repoRoot,
      location: 'packages/pkg',
      packageName: '@test/package',
      exports: { '.': './src/mod.ts' },
      contracts: {
        '.': [
          {
            environment: 'isomorphic-es2024',
            typeProof: 'strict',
          },
        ],
      },
    })

    expect(result.issues).toContainEqual({
      severity: 'error',
      packageName: '@test/package',
      dependency: '.',
      message: expect.stringContaining('fake compiler failure'),
      rule: 'package-json-export-environment-type-proof',
    })
  })

  it('reports missing strict type proof compilers as validation issues', () => {
    const repo = createTempRepo('packages/pkg')
    const packageDir = repo.memberDirs['packages/pkg']!
    const compilerBin = path.join(repo.repoRoot, 'missing-tsgo')
    fs.mkdirSync(path.join(packageDir, 'src'))
    fs.writeFileSync(path.join(packageDir, 'src/mod.ts'), 'export const value = 1\n')

    const runtime = createNodePackageJsonValidationRuntime({
      typeProofCompiler: { path: compilerBin, kind: 'tsgo' },
    })
    const result = runtime.validateExportEnvironments({
      cwd: repo.repoRoot,
      location: 'packages/pkg',
      packageName: '@test/package',
      exports: { '.': './src/mod.ts' },
      contracts: {
        '.': [
          {
            environment: 'isomorphic-es2024',
            typeProof: 'strict',
          },
        ],
      },
    })

    expect(result.issues).toContainEqual({
      severity: 'error',
      packageName: '@test/package',
      dependency: '.',
      message: expect.stringContaining('ENOENT'),
      rule: 'package-json-export-environment-type-proof',
    })
  })

  it('does not silently fall back to tsc from PATH for strict type proof', () => {
    const repo = createTempRepo('packages/pkg')
    const packageDir = repo.memberDirs['packages/pkg']!
    const binDir = path.join(repo.repoRoot, 'bin')
    fs.mkdirSync(path.join(packageDir, 'src'))
    fs.mkdirSync(binDir)
    fs.writeFileSync(path.join(packageDir, 'src/mod.ts'), 'export const value = 1\n')
    fs.writeFileSync(path.join(binDir, 'tsc'), `${bashShebang}\nexit 0\n`)
    fs.chmodSync(path.join(binDir, 'tsc'), 0o755)

    const originalPath = process.env.PATH
    const originalCompiler = process.env.GENIE_EXPORT_TYPE_PROOF_COMPILER
    process.env.PATH = binDir
    delete process.env.GENIE_EXPORT_TYPE_PROOF_COMPILER
    try {
      const result = createNodePackageJsonValidationRuntime().validateExportEnvironments({
        cwd: repo.repoRoot,
        location: 'packages/pkg',
        packageName: '@test/package',
        exports: { '.': './src/mod.ts' },
        contracts: {
          '.': [
            {
              environment: 'isomorphic-es2024',
              typeProof: 'strict',
            },
          ],
        },
      })

      expect(result.issues).toContainEqual({
        severity: 'error',
        packageName: '@test/package',
        dependency: '.',
        message: expect.stringContaining('install tsgo on PATH'),
        rule: 'package-json-export-environment-type-compiler',
      })
    } finally {
      process.env.PATH = originalPath
      if (originalCompiler === undefined) {
        delete process.env.GENIE_EXPORT_TYPE_PROOF_COMPILER
      } else {
        process.env.GENIE_EXPORT_TYPE_PROOF_COMPILER = originalCompiler
      }
    }
  })

  it('accepts a strict isomorphic TypeScript proof for the pure genie runtime entry', () => {
    // This suite runs against the package's own declared input tree: the package root is the
    // top of it, there is no repository above it, and it is read-only. The proof therefore runs
    // at the package root and stages its cache in a writable scratch directory. The compiler is
    // the declared immutable tool, never a PATH lookup.
    const packageRoot = path.resolve(import.meta.dirname, '../../..')
    const runtime = createNodePackageJsonValidationRuntime({
      typeProofCompiler: { path: requireTool('TSGO_BIN'), kind: 'tsgo' },
      proofCacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'genie-export-proof-')),
    })
    const result = packageJson({
      name: '@overeng/genie',
      version: '0.0.0',
      exports: {
        '.': exportEntry('./src/runtime/mod.ts', {
          environment: 'isomorphic-es2024',
          typeProof: 'strict',
        }),
      },
    })

    const issues = result.validate?.({
      cwd: packageRoot,
      location: '.',
      validation: { packageJson: runtime },
    })

    expect(issues).toEqual([])
  }, 30_000)

  it('preserves non-emitted metadata when provided as the second argument', () => {
    const result = packageJson(
      {
        name: '@test/package',
        version: '1.0.0',
        exports: {
          '.': './src/mod.ts',
        },
      },
      {
        someMeta: {
          enabled: true,
        },
      },
      {
        validation: {
          exportEnvironmentContracts: {
            coverage: 'warn',
          },
        },
      },
    )

    expect(result.meta.someMeta).toEqual({
      enabled: true,
    })
    expect(result.meta.validation).toEqual({
      exportEnvironmentContracts: {
        coverage: 'warn',
      },
    })
    expect(result.validate?.(mockGenieContext)).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        dependency: '.',
        rule: 'package-json-export-environment-contract-coverage',
      }),
    )
    expect(JSON.parse(result.stringify(mockGenieContext))).not.toHaveProperty('meta')
  })

  it('requires workspace metadata when local workspace deps are emitted', () => {
    const result = packageJson({
      name: '@test/package',
      version: '1.0.0',
      dependencies: {
        '@test/utils': 'workspace:^',
      },
    })

    expect(result.validate?.(mockGenieContext)).toContainEqual({
      severity: 'error',
      packageName: '@test/package',
      dependency: '@test/utils',
      message:
        'Package emits local workspace dependency specs but has no workspace metadata. Use packageJson(data, composition) so emitted dependencies and workspace closure stay coupled.',
      rule: 'workspace-metadata-required',
    })
  })

  it('rejects manual dependency buckets when composition is provided', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-composition-'))
    const packageDir = path.join(repo, 'packages', '@test', 'package')
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
    fs.mkdirSync(packageDir, { recursive: true })

    const composition = testCatalog.compose({
      workspace: {
        repoName: path.basename(repo),
        memberPath: 'packages/@test/package',
      },
      dependencies: {
        external: testCatalog.pick('react'),
      },
    })

    const result = packageJson(
      {
        name: '@test/package',
        version: '1.0.0',
        dependencies: {
          effect: '^3.18.4',
        },
      } as any,
      composition,
    )

    expect(result.validate?.(mockGenieContext)).toContainEqual({
      severity: 'error',
      packageName: '@test/package',
      dependency: '(composition)',
      message:
        'Do not define dependencies/devDependencies/peerDependencies in packageJson(data, composition). Put them into the composition so emitted deps and workspace metadata stay coupled.',
      rule: 'package-json-composition-coupling',
    })
  })

  it('rejects raw workspace metadata', () => {
    const result = packageJson(
      {
        name: '@test/package',
        version: '1.0.0',
        dependencies: {
          '@test/utils': 'workspace:^',
        },
      },
      {
        workspace: {
          repoName: 'workspace',
          memberPath: 'packages/@test/package',
          deps: [],
        },
      } as any,
    )

    expect(result.validate?.(mockGenieContext)).toContainEqual({
      severity: 'error',
      packageName: '@test/package',
      dependency: '(workspace metadata)',
      message:
        'Do not pass workspace metadata directly to packageJson(...). Use packageJson(data, composition) so emitted dependencies and workspace closure come from one coupled source.',
      rule: 'package-json-workspace-composition-required',
    })
  })

  it('rejects raw workspace metadata even without local workspace specs', () => {
    const result = packageJson(
      {
        name: '@test/package',
        version: '1.0.0',
        dependencies: {
          effect: '^3.18.4',
        },
      },
      {
        workspace: {
          repoName: 'workspace',
          memberPath: 'packages/@test/package',
          deps: [],
        },
      } as any,
    )

    expect(result.validate?.(mockGenieContext)).toContainEqual({
      severity: 'error',
      packageName: '@test/package',
      dependency: '(workspace metadata)',
      message:
        'Do not pass workspace metadata directly to packageJson(...). Use packageJson(data, composition) so emitted dependencies and workspace closure come from one coupled source.',
      rule: 'package-json-workspace-composition-required',
    })
  })
})

describe('packageJson with function scripts', () => {
  it('resolves function script values at stringify time', () => {
    const result = packageJson({
      name: '@test/package',
      version: '1.0.0',
      scripts: {
        postinstall: (location) => `echo "location: ${location}"`,
      },
    })

    const json = result.stringify(mockGenieContext)
    const parsed = JSON.parse(json)

    expect(parsed.scripts).toBeDefined()
    expect(parsed.scripts.postinstall).toBe('echo "location: packages/@test/package"')
  })

  it('handles mixed string and function scripts', () => {
    const result = packageJson({
      name: '@test/package',
      version: '1.0.0',
      scripts: {
        build: 'tsc',
        postinstall: (location) => `patch -p1 < ../${location}/patches/foo.patch`,
      },
    })

    const json = result.stringify(mockGenieContext)
    const parsed = JSON.parse(json)

    expect(parsed.scripts.build).toBe('tsc')
    expect(parsed.scripts.postinstall).toContain('patch -p1')
  })

  it('passes correct location to function scripts in nested packages', () => {
    const contextInNested: GenieContext = {
      location: 'packages/nested/deep',
      cwd: '/workspace',
    }

    const result = packageJson({
      name: '@test/package',
      version: '1.0.0',
      scripts: {
        setup: (location) => `echo "${location}"`,
      },
    })

    const json = result.stringify(contextInNested)
    const parsed = JSON.parse(json)

    expect(parsed.scripts.setup).toBe('echo "packages/nested/deep"')
  })
})

const makePackage = (
  overrides: Partial<PackageInfo> & { name: string; path: string },
): PackageInfo => ({
  ...overrides,
})

const makeValidationContext = (packages: PackageInfo[]): GenieContext => ({
  location: '.',
  cwd: '/workspace',
  workspace: {
    packages,
    byName: new Map(packages.map((p) => [p.name, p])),
  },
})

describe('packageJson validate hook', () => {
  const validationCatalog = defineCatalog({
    effect: '3.19.14',
  })

  it('returns a validate function', () => {
    const result = packageJson({ name: '@test/pkg', version: '1.0.0' })
    expect(typeof result.validate).toBe('function')
  })

  it('returns no issues when recomposition is correct', () => {
    const repo = createTempRepo('packages/utils', 'packages/app')
    const utilsComposition = validationCatalog.compose({
      workspace: workspace({
        repoName: repo.repoName,
        memberPath: 'packages/utils',
      }),
      peerDependencies: {
        external: validationCatalog.pick('effect'),
      },
    })
    const appComposition = validationCatalog.compose({
      workspace: workspace({
        repoName: repo.repoName,
        memberPath: 'packages/app',
      }),
      dependencies: {
        workspace: [
          packageJson(
            {
              name: '@test/utils',
              version: '1.0.0',
            },
            utilsComposition,
          ),
        ],
      },
      peerDependencies: {
        external: validationCatalog.pick('effect'),
      },
    })
    const upstream = makePackage({
      name: '@test/utils',
      path: 'packages/utils',
      peerDependencies: { effect: '^3.0.0' },
    })
    const downstream = makePackage({
      name: '@test/app',
      path: 'packages/app',
      dependencies: { '@test/utils': 'workspace:^' },
      peerDependencies: { effect: '^3.0.0' },
    })
    const ctx = makeValidationContext([upstream, downstream])

    const result = packageJson(
      {
        name: '@test/app',
        version: '1.0.0',
      },
      appComposition,
    )

    expect(result.validate!(ctx)).toEqual([])
  })

  it('reports issues when peer deps are missing', () => {
    const repo = createTempRepo('packages/utils', 'packages/app')
    const utilsComposition = validationCatalog.compose({
      workspace: workspace({
        repoName: repo.repoName,
        memberPath: 'packages/utils',
      }),
      peerDependencies: {
        external: validationCatalog.pick('effect'),
      },
    })
    const appComposition = validationCatalog.compose({
      workspace: workspace({
        repoName: repo.repoName,
        memberPath: 'packages/app',
      }),
      dependencies: {
        workspace: [
          packageJson(
            {
              name: '@test/utils',
              version: '1.0.0',
            },
            utilsComposition,
          ),
        ],
      },
      peerDependencies: {
        external: validationCatalog.pick('effect'),
      },
    })
    const upstream = makePackage({
      name: '@test/utils',
      path: 'packages/utils',
      peerDependencies: { effect: '^3.0.0' },
    })
    const downstream = makePackage({
      name: '@test/app',
      path: 'packages/app',
      dependencies: { '@test/utils': 'workspace:^' },
    })
    const ctx = makeValidationContext([upstream, downstream])

    const result = packageJson(
      {
        name: '@test/app',
        version: '1.0.0',
      },
      appComposition,
    )

    const issues = result.validate!(ctx)
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ rule: 'recompose-peer-deps' })
  })

  it('returns empty array when name is missing', () => {
    const result = packageJson({ version: '1.0.0' })
    const ctx = makeValidationContext([])
    expect(result.validate!(ctx)).toEqual([])
  })
})

describe('packageJson.aggregateFromPackages', () => {
  const repo = createTempRepo('packages/app', 'packages/utils')
  const appComposition = testCatalog.compose({
    workspace: workspace({
      repoName: repo.repoName,
      memberPath: 'packages/app',
    }),
    dependencies: {
      workspace: [
        packageJson(
          {
            name: '@test/utils',
            version: '1.0.0',
          },
          testCatalog.compose({
            workspace: workspace({
              repoName: repo.repoName,
              memberPath: 'packages/utils',
            }),
          }),
        ),
      ],
    },
  })
  const utilsPkg = appComposition.workspace.deps[0]!
  const appPkg = packageJson(
    {
      name: '@test/app',
      version: '1.0.0',
    },
    appComposition,
  )

  it('returns GenieOutput with projected workspaces and stringify', () => {
    const result = packageJson.aggregateFromPackages({
      packages: [appPkg],
      name: 'my-monorepo',
      repoName: repo.repoName,
    })

    expect(result.data).toEqual({
      name: 'my-monorepo',
      private: true,
      packageManager: 'pnpm@11.8.0',
      workspaces: ['packages/app', 'packages/utils'],
    })
    expect(typeof result.stringify).toBe('function')
  })

  it('stringify produces valid JSON with $genie marker', () => {
    const result = packageJson.aggregateFromPackages({
      packages: [appPkg],
      name: 'my-monorepo',
      repoName: repo.repoName,
    })

    const json = result.stringify(mockWorkspaceRootContext)
    const parsed = JSON.parse(json)

    expect(parsed.$genie).toEqual({
      source: 'package.json.genie.ts',
      warning: 'DO NOT EDIT - changes will be overwritten',
    })
    expect(parsed.name).toBe('my-monorepo')
    expect(parsed.private).toBe(true)
    expect(parsed.packageManager).toBe('pnpm@11.8.0')
    expect(parsed.workspaces).toEqual(['packages/app', 'packages/utils'])
  })

  it('stops aggregate projection at foreign repo boundaries', () => {
    const foreignRepo = createTempRepo('packages/shared')
    const foreignPkg = packageJson(
      {
        name: '@foreign/shared',
        version: '1.0.0',
      },
      testCatalog.compose({
        workspace: workspace({
          repoName: foreignRepo.repoName,
          memberPath: 'packages/shared',
        }),
      }),
    )
    const crossRepoApp = packageJson(
      {
        name: '@test/cross-repo-app',
        version: '1.0.0',
      },
      testCatalog.compose({
        workspace: workspace({
          repoName: repo.repoName,
          memberPath: 'packages/app',
        }),
        dependencies: {
          workspace: [utilsPkg, foreignPkg],
        },
      }),
    )

    const result = packageJson.aggregateFromPackages({
      packages: [crossRepoApp, utilsPkg, foreignPkg],
      name: 'my-monorepo',
      repoName: repo.repoName,
    })

    expect(result.data.workspaces).toEqual(['packages/app', 'packages/utils'])
  })

  it('includes extraMembers in the projected aggregate', () => {
    const result = packageJson.aggregateFromPackages({
      packages: [appPkg],
      name: 'my-monorepo',
      repoName: repo.repoName,
      extraMembers: ['examples/*'],
    })

    expect(result.data.workspaces).toEqual(['examples/*', 'packages/app', 'packages/utils'])
  })

  it('deduplicates extraMembers with projected members', () => {
    const result = packageJson.aggregateFromPackages({
      packages: [appPkg],
      name: 'my-monorepo',
      repoName: repo.repoName,
      extraMembers: ['packages/app', 'examples/*'],
    })

    expect(result.data.workspaces).toEqual(['examples/*', 'packages/app', 'packages/utils'])
  })
})
