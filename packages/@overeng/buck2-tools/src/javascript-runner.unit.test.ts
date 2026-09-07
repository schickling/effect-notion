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
  type JavaScriptRunOptions,
  parseJavaScriptRunOptions,
  planScratch,
  vitestArgv,
  vitestCollectArgv,
} from './javascript-runner.ts'
import { DARWIN_SANDBOX_LAUNCHER, type SandboxOptions } from './typescript-runner.ts'
import { collectionArtifactBytes } from './vitest-collect-entry.ts'

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

  it('parses the collection action positionals and its declared build output', () => {
    const options = parseJavaScriptRunOptions([
      'vitest-collect',
      bun,
      '/buck/package-tree',
      'vitest.config.ts',
      '--exclude',
      'src/live.integration.test.ts',
      '--collect-output',
      '/buck/buck-out/gen/pkg/test_collect.json',
      ...sandboxFlags,
    ])

    expect(options).toMatchObject({
      command: 'vitest-collect',
      config: 'vitest.config.ts',
      excludes: ['src/live.integration.test.ts'],
      collectOutput: '/buck/buck-out/gen/pkg/test_collect.json',
    })

    // The declared output is the whole point of the lane, and it belongs to no other command.
    expect(() =>
      parseJavaScriptRunOptions([
        'vitest-collect',
        bun,
        '/buck/package-tree',
        'vitest.config.ts',
        ...sandboxFlags,
      ]),
    ).toThrow('vitest-collect requires the declared --collect-output build output')
    expect(() =>
      parseJavaScriptRunOptions([
        'vitest',
        bun,
        '/buck/package-tree',
        'vitest.config.ts',
        '30000',
        '30000',
        '--collect-output',
        '/buck/buck-out/gen/pkg/test_collect.json',
        ...sandboxFlags,
      ]),
    ).toThrow('--collect-output is only admissible for vitest-collect, not vitest')
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

describe('vitestCollectArgv', () => {
  it('drives the exit-owning collector entry with the same view, config, and selection', () => {
    expect(
      vitestCollectArgv({
        runtime: bun,
        entry: '/buck/runner/vitest-collect-entry.ts',
        packageTree: '/buck/package-tree',
        config: 'vitest.config.ts',
        report: '/buck/scratch/results/vitest-collection.json',
        tests: ['src/a.unit.test.ts'],
        excludes: ['src/live.integration.test.ts'],
      }),
    ).toEqual([
      bun,
      '/buck/runner/vitest-collect-entry.ts',
      '/buck/package-tree',
      'vitest.config.ts',
      '/buck/scratch/results/vitest-collection.json',
      '--test',
      'src/a.unit.test.ts',
      '--exclude',
      'src/live.integration.test.ts',
    ])
  })

  it('publishes byte-identical package-relative artifacts from different executor roots', () => {
    const entry = {
      file: 'src/a.unit.test.ts',
      name: 'suite > case',
    }
    const firstRoot = '/buck/executor-a/package-tree'
    const secondRoot = '/private/checkout-b/package-tree'
    const first = collectionArtifactBytes({
      packageTree: firstRoot,
      entries: [{ ...entry, file: join(firstRoot, entry.file) }],
    })
    const second = collectionArtifactBytes({
      packageTree: secondRoot,
      entries: [{ ...entry, file: join(secondRoot, entry.file) }],
    })
    expect(first).toBe(second)
    expect(JSON.parse(first)).toEqual([{ file: entry.file, name: entry.name }])
    expect(first).not.toContain(firstRoot)
    expect(second).not.toContain(secondRoot)
  })

  it('fails closed when Vitest reports a module outside the declared package tree', () => {
    expect(() =>
      collectionArtifactBytes({
        packageTree: '/buck/package-tree',
        entries: [{ file: '/buck/sibling/a.unit.test.ts', name: 'suite > case' }],
      }),
    ).toThrow(
      'vitest collect: test module is outside the package tree: /buck/sibling/a.unit.test.ts',
    )
  })

  // `vitest list` writes its artifact and then never exits, so the lane must never launch it.
  it('never launches the vitest list CLI', () => {
    const argv = vitestCollectArgv({
      runtime: bun,
      entry: '/buck/runner/vitest-collect-entry.ts',
      packageTree: '/buck/package-tree',
      config: 'vitest.config.ts',
      report: '/buck/scratch/results/vitest-collection.json',
      tests: [],
      excludes: [],
    })

    expect(argv).not.toContain('list')
    expect(argv).not.toContain('/buck/package-tree/node_modules/vitest/vitest.mjs')
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

  // A collection lane is a Buck *action* with a declared output, so it must never fall back to a
  // private scratch it would then have to publish from.
  it('refuses a collection action with no executor scratch', () => {
    expect(() => planScratch({ command: 'vitest-collect', env: {} })).toThrow(
      'BUCK_SCRATCH_PATH must be declared by the executor for the vitest-collect action',
    )
    expect(
      planScratch({ command: 'vitest-collect', env: { BUCK_SCRATCH_PATH: '/buck/scratch/c' } }),
    ).toEqual({ root: '/buck/scratch/c', declaredResults: undefined })
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

const NODE_BIN = '/nix/store/4444444444444444444444444444444d-node/bin/node'

const seatbeltFlags = [
  '--sandbox',
  'seatbelt',
  '--sandbox-launcher',
  DARWIN_SANDBOX_LAUNCHER,
  '--tool-closure',
  BUN_CLOSURE,
  '--darwin-kernel-major',
  '25',
] as const

/** The declared roots one lane hands to its Seatbelt launch, exactly as `runSandboxed` builds them. */
const declaredInputRoots = (options: JavaScriptRunOptions): readonly string[] => [
  options.packageTree,
  ...options.readRoots,
  ...Object.values(options.externalInputs),
]

/**
 * Runs one parsed lane through a Seatbelt launch over a Darwin-shaped metadata fixture, and hands
 * the assertion the profile bytes plus the read roots the launch predicates by `-D` parameter.
 */
const withSeatbeltLaunch = (
  options: JavaScriptRunOptions,
  assert: (launch: { readonly profile: string; readonly readRoots: readonly string[] }) => void,
): void => {
  const fixture = createMetadataFixture()
  try {
    const invocation = javaScriptSandboxInvocation({
      command: [options.bun, 'run'],
      inputRoots: declaredInputRoots(options),
      kernelRelease: '25.5.0',
      metadataPaths: [fixture.logicalLocaltime],
      outputRoots: [],
      sandbox: options.sandbox,
      scratchRoot: join(fixture.root, 'scratch'),
      workingDirectory: options.packageTree,
    })
    assert({
      profile: invocation.profile?.bytes ?? '',
      readRoots: invocation.argv
        .filter((argument) => argument.startsWith('READ_ROOT_') === true)
        .map((argument) => argument.slice(argument.indexOf('=') + 1)),
    })
  } finally {
    rmSync(fixture.root, { recursive: true })
  }
}

describe('the Seatbelt grant a nested JavaScript spawn depends on', () => {
  // Every lane spawns its inner child with `stdin: 'ignore'`, and that child opens `/dev/null`
  // read-only from inside `posix_spawn`. The device is readable through the shared OS contract,
  // so no lane declares it — a device is not a hashable action input.
  it('reads the ignored-stdin device through the shared OS contract, never a declared root', () => {
    const options = parseJavaScriptRunOptions([
      'bun-test',
      bun,
      '/buck/package-tree',
      '30000',
      '--test',
      'src/a.test.ts',
      ...seatbeltFlags,
    ])

    withSeatbeltLaunch(options, ({ profile, readRoots }) => {
      expect(profile).toContain(
        '(allow file-read* (literal "/") (literal "/dev/null") (literal "/dev/random")',
      )
      // The device stays write-data only, and metadata stays granted for every declared path.
      expect(profile).toContain('(allow file-write-data (literal "/dev/null"))')
      expect(profile).toContain('(allow file-read-metadata ')
      expect(profile).toContain('(literal "/System/Library/CoreServices/SystemVersion.plist")')
      expect(readRoots).toEqual(['/buck/package-tree', BUN_CLOSURE])
    })
  })

  // The pinned Bun that execs the inner child, and the declared NODE_BIN that evaluates the Node
  // Vitest lane, are already inside declared read roots: Bun under its tool closure, NODE_BIN as
  // a declared external input. Neither needs a root of its own.
  it('execs the pinned Bun and the declared NODE_BIN from roots the lane already declares', () => {
    const options = parseJavaScriptRunOptions([
      'vitest',
      bun,
      '/buck/package-tree',
      'vitest.config.ts',
      '30000',
      '45000',
      '--vitest-runtime',
      'node',
      '--external-path',
      'NODE_BIN',
      NODE_BIN,
      ...seatbeltFlags,
    ])

    withSeatbeltLaunch(options, ({ profile, readRoots }) => {
      expect(readRoots).toEqual(['/buck/package-tree', BUN_CLOSURE, NODE_BIN].toSorted())
      expect(readRoots).not.toContain('/dev/null')
      expect(readRoots).not.toContain(bun)
      expect(bun.startsWith(`${BUN_CLOSURE}/`)).toBe(true)
      const execLine = profile
        .split('\n')
        .find((line) => line.startsWith('(allow process-exec ') === true)
      for (const [index] of readRoots.entries()) {
        expect(execLine).toContain(`(subpath (param "READ_ROOT_${index}"))`)
      }
    })
  })

  it('keeps a Bubblewrap or unsandboxed lane at exactly its declared inputs', () => {
    const bubblewrapLane = parseJavaScriptRunOptions([
      'bun-test',
      bun,
      '/buck/package-tree',
      '30000',
      '--sandbox',
      'bubblewrap',
      '--sandbox-launcher',
      BWRAP,
      '--tool-closure',
      BUN_CLOSURE,
    ])

    expect(declaredInputRoots(bubblewrapLane)).toEqual(['/buck/package-tree'])
    expect(
      declaredInputRoots(
        parseJavaScriptRunOptions([
          'bun-test',
          bun,
          '/buck/package-tree',
          '30000',
          ...sandboxFlags,
        ]),
      ),
    ).toEqual(['/buck/package-tree'])
  })
})
