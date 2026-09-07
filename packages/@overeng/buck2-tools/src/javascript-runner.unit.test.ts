import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  acquireScratch,
  javaScriptSandboxInvocation,
  parseJavaScriptRunOptions,
  planScratch,
  vitestArgv,
} from './javascript-runner.ts'
import { DARWIN_SANDBOX_LAUNCHER, type SandboxOptions } from './typescript-runner.ts'

const bun = '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bun/bin/bun'

const sandboxFlags = ['--sandbox', 'none'] as const

describe('parseJavaScriptRunOptions', () => {
  it('preserves deterministic Vitest selection, timeouts, environment, and declared inputs', () => {
    const options = parseJavaScriptRunOptions([
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
      '/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-otelite/bin/otelite',
      '--read-root',
      '/buck/importer-view',
      ...sandboxFlags,
    ])

    expect(options).toMatchObject({
      command: 'vitest',
      bun,
      packageTree: '/buck/package-tree',
      config: 'vitest.config.ts',
      timeoutMs: 30_000,
      hookTimeoutMs: 45_000,
      tests: ['src/a.unit.test.ts'],
      excludes: ['src/live.integration.test.ts'],
      environment: { CI: 'true' },
      externalInputs: {
        OTELITE_BIN: '/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-otelite/bin/otelite',
      },
      readRoots: ['/buck/importer-view'],
      sandbox: { kind: 'none' },
    })
  })

  it('parses explicit local capabilities, secret names, and writable roots', () => {
    const options = parseJavaScriptRunOptions([
      'vitest',
      bun,
      '/buck/package-tree',
      'vitest.config.ts',
      '30000',
      '30000',
      '--external-path',
      'RESTATE_SERVER_BIN',
      '/nix/store/cccccccccccccccccccccccccccccccc-restate/bin/restate-server',
      '--inherit-env',
      'NOTION_API_TOKEN',
      '--writable-directory',
      'LEDGER_PATH',
      'notion/ledger',
      '--capability',
      'network',
      '--capability',
      'subprocess',
      ...sandboxFlags,
    ])

    expect(options).toMatchObject({
      externalInputs: {
        RESTATE_SERVER_BIN:
          '/nix/store/cccccccccccccccccccccccccccccccc-restate/bin/restate-server',
      },
      inheritedEnv: ['NOTION_API_TOKEN'],
      writableDirectories: { LEDGER_PATH: 'notion/ledger' },
      capabilities: ['network', 'subprocess'],
    })
  })

  it('parses the nix-daemon host service, its executor mode, and rejects unknown values', () => {
    const options = parseJavaScriptRunOptions([
      'vitest',
      bun,
      '/buck/package-tree',
      'vitest.config.ts',
      '30000',
      '30000',
      '--capability',
      'nix-daemon',
      '--capability',
      'subprocess',
      '--execution-mode',
      'unsandboxed-local',
      ...sandboxFlags,
    ])

    expect(options.capabilities).toEqual(['nix-daemon', 'subprocess'])
    expect(options.executionMode).toBe('unsandboxed-local')
    expect(() =>
      parseJavaScriptRunOptions([
        'vitest',
        bun,
        '/buck/package-tree',
        'vitest.config.ts',
        '30000',
        '30000',
        '--capability',
        'nix-store',
        ...sandboxFlags,
      ]),
    ).toThrow('unknown capability: nix-store')
    expect(() =>
      parseJavaScriptRunOptions([
        'vitest',
        bun,
        '/buck/package-tree',
        'vitest.config.ts',
        '30000',
        '30000',
        '--execution-mode',
        'unsandboxed',
        ...sandboxFlags,
      ]),
    ).toThrow('unknown execution mode: unsandboxed')
  })

  // Containment is never inferred: an unflagged command is a sandboxed lane even on a platform
  // whose sandbox resolved to `none`.
  it('defaults an unflagged command to the sandboxed executor mode', () => {
    expect(
      parseJavaScriptRunOptions(['bun-test', bun, '/buck/package-tree', '30000', ...sandboxFlags])
        .executionMode,
    ).toBe('sandboxed')
  })

  it('accepts the bounded external shell-test command', () => {
    const options = parseJavaScriptRunOptions([
      'shell-tests',
      bun,
      '/buck/package-tree',
      '300000',
      '--external-path',
      'BASH_BIN',
      '/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-bash/bin/bash',
      ...sandboxFlags,
    ])

    expect(options.command).toBe('shell-tests')
    expect(options.timeoutMs).toBe(300_000)
  })

  it('rejects inherited-environment placeholders and path traversal', () => {
    expect(() =>
      parseJavaScriptRunOptions([
        'vitest',
        bun,
        '/buck/package-tree',
        '../vitest.config.ts',
        '30000',
        '30000',
        ...sandboxFlags,
      ]),
    ).toThrow('config must be a normalized portable relative path')

    expect(() =>
      parseJavaScriptRunOptions([
        'exec',
        bun,
        '/buck/package-tree',
        'src/mod.ts',
        '--env',
        'TOKEN',
        '$TOKEN',
        ...sandboxFlags,
      ]),
    ).toThrow('environment values must be literal action inputs')
  })
})

describe('vitestArgv', () => {
  it('always runs once and emits a machine report without replacing human output', () => {
    expect(
      vitestArgv({
        runtime: bun,
        packageTree: '/buck/package-tree',
        config: 'vitest.config.ts',
        timeoutMs: 30_000,
        hookTimeoutMs: 30_000,
        report: '/buck/results/vitest.json',
        tests: ['src/a.unit.test.ts'],
        excludes: ['src/live.integration.test.ts'],
      }),
    ).toEqual([
      bun,
      '/buck/package-tree/node_modules/vitest/vitest.mjs',
      'run',
      '--config',
      '/buck/package-tree/vitest.config.ts',
      '--configLoader=runner',
      '--testTimeout',
      '30000',
      '--hookTimeout',
      '30000',
      '--reporter=default',
      '--reporter=json',
      '--outputFile.json=/buck/results/vitest.json',
      'src/a.unit.test.ts',
      '--exclude',
      'src/live.integration.test.ts',
    ])
  })

  it('loads the config through the module runner so the read-only package view is never written', () => {
    // Vite's default `bundle` loader writes the bundled config to
    // `<nearest node_modules>/.vite-temp`, which is EROFS inside the sandboxed package view.
    expect(
      vitestArgv({
        runtime: bun,
        packageTree: '/buck/package-tree',
        config: 'vitest.config.ts',
        timeoutMs: 30_000,
        hookTimeoutMs: 30_000,
        report: '/buck/results/vitest.json',
        tests: [],
        excludes: [],
      }),
    ).toContain('--configLoader=runner')
  })
})

describe('planScratch', () => {
  it('keeps the executor-declared scratch for build and run actions', () => {
    expect(
      planScratch({ command: 'exec', env: { BUCK_SCRATCH_PATH: '/buck/scratch/exec' } }),
    ).toEqual({ root: '/buck/scratch/exec', declaredResults: undefined })
  })

  it('keeps the executor-declared scratch for tests that do get one', () => {
    expect(
      planScratch({
        command: 'vitest',
        env: {
          BUCK_SCRATCH_PATH: '/buck/scratch/test',
          TEST_RESULT_ARTIFACTS_DIR: '/buck/results',
        },
      }),
    ).toEqual({ root: '/buck/scratch/test', declaredResults: '/buck/results' })
  })

  it('uses a declared result artifact directory when that is the only declared boundary', () => {
    expect(
      planScratch({ command: 'bun-test', env: { TEST_RESULT_ARTIFACTS_DIR: '/buck/results' } }),
    ).toEqual({ root: '/buck/results', declaredResults: '/buck/results' })
  })

  it('owns the scratch for every external test command Buck launches without one', () => {
    for (const command of ['vitest', 'bun-test', 'shell-tests'] as const) {
      expect(planScratch({ command, env: { BUCK_SCRATCH_PATH: '' } })).toEqual({
        root: undefined,
        declaredResults: undefined,
      })
    }
  })

  it('still refuses an action with no executor scratch', () => {
    expect(() => planScratch({ command: 'exec', env: {} })).toThrow(
      'BUCK_SCRATCH_PATH must be declared by the executor for the exec action',
    )
  })
})

describe('acquireScratch', () => {
  it('creates one private owned directory holding the results and removes it on release', async () => {
    const lease = await acquireScratch({ root: undefined, declaredResults: undefined })

    expect(relative(realpathSync(tmpdir()), lease.root).startsWith('..')).toBe(false)
    expect(statSync(lease.root).mode & 0o777).toBe(0o700)
    expect(lease.results).toBe(join(lease.root, 'results'))
    expect(statSync(lease.results).isDirectory()).toBe(true)

    lease.release()

    expect(existsSync(lease.root)).toBe(false)
    lease.release()
  })

  it('never removes a scratch directory the executor owns', async () => {
    const declared = join(tmpdir(), `javascript-runner-declared-${process.pid}`)
    try {
      const lease = await acquireScratch({ root: declared, declaredResults: undefined })

      expect(lease.root).toBe(declared)
      expect(lease.results).toBe(join(declared, 'results'))

      lease.release()

      expect(existsSync(declared)).toBe(true)
    } finally {
      await rm(declared, { recursive: true, force: true })
    }
  })
})

const BUN_CLOSURE = '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bun'
const BWRAP = '/nix/store/3333333333333333333333333333333c-bubblewrap/bin/bwrap'

const seatbelt: SandboxOptions = {
  kind: 'seatbelt',
  launcher: DARWIN_SANDBOX_LAUNCHER,
  toolClosure: [BUN_CLOSURE],
  darwinKernelMajors: ['25'],
}

const bubblewrap: SandboxOptions = {
  kind: 'bubblewrap',
  launcher: BWRAP,
  toolClosure: [BUN_CLOSURE],
  darwinKernelMajors: [],
}

/** A logical Darwin-shaped metadata path: `etc` is a directory symlink, `localtime` a file one. */
const createMetadataFixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'javascript-runner-metadata-')))
  const canonicalDirectory = join(root, 'private/etc')
  const logicalDirectory = join(root, 'etc')
  const zoneinfo = join(root, 'private/var/db/timezone/zoneinfo/Europe')
  mkdirSync(canonicalDirectory, { recursive: true })
  mkdirSync(zoneinfo, { recursive: true })
  writeFileSync(join(zoneinfo, 'Berlin'), 'TZif')
  symlinkSync(canonicalDirectory, logicalDirectory)
  symlinkSync('../var/db/timezone/zoneinfo/Europe/Berlin', join(canonicalDirectory, 'localtime'))
  const logicalLocaltime = join(logicalDirectory, 'localtime')
  return {
    root,
    logicalLocaltime,
    expectedLinks: [
      join(realpathSync(logicalDirectory), 'localtime'),
      realpathSync(logicalLocaltime),
    ].toSorted(),
  }
}

describe('javaScriptSandboxInvocation', () => {
  it('parameterizes a Seatbelt launch with the canonical Darwin OS metadata spellings', () => {
    const fixture = createMetadataFixture()
    try {
      const scratch = join(fixture.root, 'scratch')
      const packageTree = join(fixture.root, 'package')

      const invocation = javaScriptSandboxInvocation({
        command: [bun, 'run', 'vitest'],
        inputRoots: [packageTree],
        kernelRelease: '25.5.0',
        metadataPaths: [fixture.logicalLocaltime],
        outputRoots: [],
        sandbox: seatbelt,
        scratchRoot: scratch,
        workingDirectory: packageTree,
      })

      expect(invocation.argv.slice(0, 3)).toEqual([
        DARWIN_SANDBOX_LAUNCHER,
        '-f',
        join(scratch, 'seatbelt.sb'),
      ])
      expect(invocation.argv.slice(-3)).toEqual([bun, 'run', 'vitest'])
      for (const [index, link] of fixture.expectedLinks.entries()) {
        expect(invocation.argv).toContain(`META_LINK_${index}=${link}`)
        expect(invocation.profile?.bytes).toContain(`(literal (param "META_LINK_${index}"))`)
      }
    } finally {
      rmSync(fixture.root, { recursive: true })
    }
  })

  it('refuses a Seatbelt launch on a host the Darwin containment gate has not admitted', () => {
    expect(() =>
      javaScriptSandboxInvocation({
        command: [bun, 'run'],
        inputRoots: ['/tree'],
        kernelRelease: '24.6.0',
        outputRoots: [],
        sandbox: seatbelt,
        scratchRoot: '/scratch',
        workingDirectory: '/tree',
      }),
    ).toThrow(/Darwin kernel 24 is not an admitted Seatbelt executor.*25/u)
  })

  it('leaves a Bubblewrap launch without Darwin metadata parameters or a profile', () => {
    const invocation = javaScriptSandboxInvocation({
      command: [bun, 'run'],
      inputRoots: ['/tree'],
      kernelRelease: '6.18.0',
      outputRoots: [],
      sandbox: bubblewrap,
      scratchRoot: '/scratch',
      workingDirectory: '/tree',
    })

    expect(invocation.argv[0]).toBe(BWRAP)
    expect(invocation.argv.some((argument) => argument.includes('META_LINK_'))).toBe(false)
    expect(invocation.profile).toBeUndefined()
  })
})
