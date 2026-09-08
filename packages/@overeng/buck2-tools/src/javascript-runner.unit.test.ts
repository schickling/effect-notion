import { existsSync, realpathSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  acquireScratch,
  parseJavaScriptRunOptions,
  planScratch,
  vitestArgv,
  vitestCollectArgv,
} from './javascript-runner.ts'

const bun = '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bun/bin/bun'

describe('parseJavaScriptRunOptions', () => {
  it('preserves deterministic Vitest selection, timeouts, environment, and declared inputs', () => {
    expect(
      parseJavaScriptRunOptions([
        'vitest',
        bun,
        '/buck/package-tree',
        'vitest.config.ts',
        '30000',
        '45000',
        '--test',
        'src/a.unit.test.ts',
        '--exclude',
        'src/live.integration.test.ts',
        '--env',
        'CI',
        'true',
        '--input',
        'OTELITE_BIN',
        '/nix/store/otelite/bin/otelite',
        '--read-root',
        '/buck/importer-view',
        '--read-root',
        '/buck/importer-view',
      ]),
    ).toMatchObject({
      command: 'vitest',
      bun,
      packageTree: '/buck/package-tree',
      config: 'vitest.config.ts',
      timeoutMs: 30_000,
      hookTimeoutMs: 45_000,
      tests: ['src/a.unit.test.ts'],
      excludes: ['src/live.integration.test.ts'],
      environment: { CI: 'true' },
      externalInputs: { OTELITE_BIN: '/nix/store/otelite/bin/otelite' },
      readRoots: ['/buck/importer-view'],
    })
  })

  it('parses declared tools, inherited names, writable roots, and a Node Vitest runtime', () => {
    expect(
      parseJavaScriptRunOptions([
        'vitest',
        bun,
        '/buck/package-tree',
        'vitest.config.ts',
        '30000',
        '30000',
        '--external-path',
        'NODE_BIN',
        '/nix/store/node/bin/node',
        '--inherit-env',
        'NOTION_API_TOKEN',
        '--writable-directory',
        'LEDGER_PATH',
        'notion/ledger',
        '--vitest-runtime',
        'node',
      ]),
    ).toMatchObject({
      externalInputs: { NODE_BIN: '/nix/store/node/bin/node' },
      inheritedEnv: ['NOTION_API_TOKEN'],
      writableDirectories: { LEDGER_PATH: 'notion/ledger' },
      vitestRuntime: 'node',
    })
  })

  it('rejects path traversal, ambient environment placeholders, broad roots, and unknown flags', () => {
    expect(() =>
      parseJavaScriptRunOptions(['vitest', bun, '/tree', '../vitest.config.ts', '30000', '30000']),
    ).toThrow('normalized portable relative path')
    expect(() =>
      parseJavaScriptRunOptions(['exec', bun, '/tree', 'src/mod.ts', '--env', 'TOKEN', '$TOKEN']),
    ).toThrow('environment values must be literal')
    expect(() =>
      parseJavaScriptRunOptions(['exec', bun, '/tree', 'src/mod.ts', '--read-root', '/']),
    ).toThrow('invalid declared read root')
    expect(() =>
      parseJavaScriptRunOptions(['exec', bun, '/tree', 'src/mod.ts', '--wat', 'none']),
    ).toThrow('unexpected argument: --wat')
  })

  it('parses collection output only for collection actions', () => {
    expect(
      parseJavaScriptRunOptions([
        'vitest-collect',
        bun,
        '/tree',
        'vitest.config.ts',
        '--collect-output',
        '/buck/out/collection.json',
      ]),
    ).toMatchObject({ command: 'vitest-collect', collectOutput: '/buck/out/collection.json' })
    expect(() =>
      parseJavaScriptRunOptions(['vitest-collect', bun, '/tree', 'vitest.config.ts']),
    ).toThrow('requires the declared --collect-output')
    expect(() =>
      parseJavaScriptRunOptions([
        'vitest',
        bun,
        '/tree',
        'vitest.config.ts',
        '30000',
        '30000',
        '--collect-output',
        '/buck/out/collection.json',
      ]),
    ).toThrow('only admissible for vitest-collect')
  })
})

describe('Vitest argv', () => {
  it('runs once with deterministic config, timeouts, reports, tests, and excludes', () => {
    expect(
      vitestArgv({
        runtime: bun,
        packageTree: '/tree',
        config: 'vitest.config.ts',
        timeoutMs: 30_000,
        hookTimeoutMs: 45_000,
        report: '/results/vitest.json',
        tests: ['src/a.unit.test.ts'],
        excludes: ['src/live.integration.test.ts'],
      }),
    ).toEqual([
      bun,
      '/tree/node_modules/vitest/vitest.mjs',
      'run',
      '--config',
      '/tree/vitest.config.ts',
      '--configLoader=runner',
      '--testTimeout',
      '30000',
      '--hookTimeout',
      '45000',
      '--reporter=default',
      '--reporter=json',
      '--outputFile.json=/results/vitest.json',
      'src/a.unit.test.ts',
      '--exclude',
      'src/live.integration.test.ts',
    ])
  })

  it('drives the exit-owning collector with the same declared selection', () => {
    expect(
      vitestCollectArgv({
        runtime: bun,
        entry: '/runner/vitest-collect-entry.ts',
        packageTree: '/tree',
        config: 'vitest.config.ts',
        report: '/results/collection.json',
        tests: ['src/a.unit.test.ts'],
        excludes: ['src/live.integration.test.ts'],
      }),
    ).toEqual([
      bun,
      '/runner/vitest-collect-entry.ts',
      '/tree',
      'vitest.config.ts',
      '/results/collection.json',
      '--test',
      'src/a.unit.test.ts',
      '--exclude',
      'src/live.integration.test.ts',
    ])
  })
})

describe('scratch ownership', () => {
  it('uses declared scratch and results boundaries', () => {
    expect(
      planScratch({
        command: 'vitest',
        env: { BUCK_SCRATCH_PATH: '/buck/scratch', TEST_RESULT_ARTIFACTS_DIR: '/buck/results' },
      }),
    ).toEqual({ root: '/buck/scratch', declaredResults: '/buck/results' })
    expect(
      planScratch({ command: 'bun-test', env: { TEST_RESULT_ARTIFACTS_DIR: '/buck/results' } }),
    ).toEqual({ root: '/buck/results', declaredResults: '/buck/results' })
  })

  it('owns and removes private external-test scratch', async () => {
    const lease = await acquireScratch(planScratch({ command: 'vitest', env: {} }))
    expect(relative(realpathSync(tmpdir()), lease.root).startsWith('..')).toBe(false)
    expect(statSync(lease.root).mode & 0o777).toBe(0o700)
    lease.release()
    expect(existsSync(lease.root)).toBe(false)
  })

  it('never removes executor-owned scratch', async () => {
    const declared = join(tmpdir(), `javascript-runner-declared-${process.pid}`)
    try {
      const lease = await acquireScratch({ root: declared, declaredResults: undefined })
      lease.release()
      expect(existsSync(declared)).toBe(true)
    } finally {
      await rm(declared, { recursive: true, force: true })
    }
  })
})
