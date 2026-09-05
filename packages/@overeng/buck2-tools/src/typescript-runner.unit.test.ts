import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  actionEnvironment,
  bubblewrapArgv,
  copyDeclarationSources,
  DARWIN_SANDBOX_LAUNCHER,
  DARWIN_SEATBELT_OS_METADATA_PATHS,
  DARWIN_SEATBELT_OS_READ_PATHS,
  DARWIN_SEATBELT_OS_WRITE_PATHS,
  darwinOsMetadataLinks,
  hashDeclaredInputRoots,
  parseEmitOptions,
  parseProbeOptions,
  parseTypecheckOptions,
  planOverlay,
  probeScriptSource,
  requireAdmittedDarwinRelease,
  requireSandbox,
  sandboxInvocation,
  seatbeltArgv,
  seatbeltProfile,
  tsgoEmitArgv,
  tsgoTypecheckArgv,
  validateEmittedOutput,
  type SandboxOptions,
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

const TSGO = '/nix/store/1111111111111111111111111111111a-effect-tsgo/bin/tsgo'
const BUN = '/nix/store/2222222222222222222222222222222b-bun/bin/bun'
const BWRAP = '/nix/store/3333333333333333333333333333333c-bubblewrap/bin/bwrap'
const BUN_CLOSURE = '/nix/store/2222222222222222222222222222222b-bun'
const TSGO_CLOSURE = '/nix/store/1111111111111111111111111111111a-effect-tsgo'
const BWRAP_CLOSURE = '/nix/store/3333333333333333333333333333333c-bubblewrap'

const bubblewrap: SandboxOptions = {
  kind: 'bubblewrap',
  launcher: BWRAP,
  toolClosure: [BUN_CLOSURE, TSGO_CLOSURE, BWRAP_CLOSURE],
  darwinKernelMajors: [],
}

const seatbelt: SandboxOptions = {
  kind: 'seatbelt',
  launcher: DARWIN_SANDBOX_LAUNCHER,
  toolClosure: [BUN_CLOSURE, TSGO_CLOSURE],
  darwinKernelMajors: ['25'],
}

const sandboxFlags = (
  extra: readonly string[] = ['--sandbox-launcher', BWRAP, '--tool-closure', BUN_CLOSURE],
) => ['--sandbox', 'bubblewrap', ...extra]

afterEach(() => {
  for (const directory of scratchDirectories.splice(0)) rmSync(directory, { recursive: true })
})

describe('TypeScript action command contract', () => {
  it('parses the typecheck contract with its sandbox selection', () => {
    expect(
      parseTypecheckOptions([
        TSGO,
        '/tree',
        'tsconfig.json',
        '/out/typecheck.ok',
        '--read-root',
        '/store-entry',
        '--read-root',
        '/dependency-view',
        '--read-root',
        '/tree',
        '--read-root',
        '/store-entry',
        ...sandboxFlags([
          '--sandbox-launcher',
          BWRAP,
          '--tool-closure',
          TSGO_CLOSURE,
          '--tool-closure',
          BUN_CLOSURE,
          '--tool-closure',
          BUN_CLOSURE,
        ]),
      ]),
    ).toEqual({
      tsgo: TSGO,
      packageTree: '/tree',
      project: 'tsconfig.json',
      readRoots: ['/dependency-view', '/store-entry', '/tree'],
      verdict: '/out/typecheck.ok',
      sandbox: {
        kind: 'bubblewrap',
        launcher: BWRAP,
        // Deduplicated and sorted: the closure enters the action key, so its spelling must not
        // depend on the order the toolchain happened to emit.
        toolClosure: [TSGO_CLOSURE, BUN_CLOSURE].toSorted(),
        darwinKernelMajors: [],
      },
    })
  })

  it('parses explicit normalized declaration paths beside the sandbox flags', () => {
    expect(
      parseEmitOptions([
        TSGO,
        '/tree',
        'tsconfig.json',
        'dist',
        'src/mod.d.ts',
        '/out/dist',
        '--copy-declaration',
        'src/legacy.d.ts',
        '--read-root',
        '/dependency-view',
        ...sandboxFlags(),
      ]),
    ).toMatchObject({
      declarationSources: ['src/legacy.d.ts'],
      outDir: 'dist',
      readRoots: ['/dependency-view'],
      sandbox: { kind: 'bubblewrap', launcher: BWRAP },
    })
  })

  it.each(['../outside.d.ts', '/outside.d.ts', 'src\\outside.d.ts', 'src//outside.d.ts'])(
    'rejects unsafe declaration path %s',
    (declarationPath) => {
      expect(() =>
        parseEmitOptions([
          TSGO,
          '/tree',
          'tsconfig.json',
          'dist',
          'src/mod.d.ts',
          '/out/dist',
          '--copy-declaration',
          declarationPath,
          ...sandboxFlags(),
        ]),
      ).toThrow(/normalized portable relative path/u)
    },
  )

  it('refuses a missing sandbox selection, unknown flags, non-store tools, and broad roots', () => {
    expect(() => parseTypecheckOptions([TSGO, '/tree', 'tsconfig.json', '/out/ok'])).toThrow(
      /missing --sandbox/u,
    )
    expect(() =>
      parseTypecheckOptions([TSGO, '/tree', 'tsconfig.json', '/out/ok', '--wat', 'x']),
    ).toThrow(/unexpected typecheck argument/u)
    expect(() =>
      parseTypecheckOptions([
        '/usr/bin/tsgo',
        '/tree',
        'tsconfig.json',
        '/out/ok',
        ...sandboxFlags(),
      ]),
    ).toThrow(/immutable \/nix\/store tsgo executable/u)
    expect(() =>
      parseTypecheckOptions([
        TSGO,
        '/tree',
        'tsconfig.json',
        '/out/ok',
        '--sandbox',
        'bubblewrap',
        '--sandbox-launcher',
        BWRAP,
        '--tool-closure',
        '/opt/tools/bun',
      ]),
    ).toThrow(/immutable \/nix\/store paths/u)
    expect(() =>
      parseTypecheckOptions([
        TSGO,
        '/tree',
        'tsconfig.json',
        '/out/ok',
        '--read-root',
        '/',
        ...sandboxFlags(),
      ]),
    ).toThrow(/invalid declared read root/u)
  })

  it('parses every probe operation and rejects unsupported operations', () => {
    expect(
      parseProbeOptions([BUN, 'stat', '/etc/hostname', 'denied', '/out/probe', ...sandboxFlags()]),
    ).toMatchObject({
      bun: BUN,
      kind: 'stat',
      target: '/etc/hostname',
      expect: 'denied',
      verdict: '/out/probe',
    })
    expect(
      parseProbeOptions([BUN, 'exec', '/bin/sh', 'denied', '/out/probe', ...sandboxFlags()]),
    ).toMatchObject({ kind: 'exec' })
    expect(() =>
      parseProbeOptions([BUN, 'unlink', '/tmp/file', 'denied', '/out/p', ...sandboxFlags()]),
    ).toThrow(/unknown probe kind/u)
    expect(() =>
      parseProbeOptions([BUN, 'read', '/etc/hostname', 'maybe', '/out/p', ...sandboxFlags()]),
    ).toThrow(/unknown probe expectation/u)
  })
})

describe('platform sandbox contract', () => {
  it('requires an exact Nix Bubblewrap and the fixed system Seatbelt bound to a proven OS', () => {
    expect(requireSandbox(bubblewrap)).toBe(bubblewrap)
    expect(requireSandbox(seatbelt)).toBe(seatbelt)
    expect(() => requireSandbox({ ...bubblewrap, launcher: '/usr/bin/bwrap' })).toThrow(
      /immutable \/nix\/store bwrap executable/u,
    )
    expect(() => requireSandbox({ ...seatbelt, launcher: '/opt/sandbox-exec' })).toThrow(
      /fixed system launcher/u,
    )
    expect(() => requireSandbox({ ...seatbelt, darwinKernelMajors: [] })).toThrow(
      /admitted Darwin kernel majors/u,
    )
    expect(() => requireSandbox({ ...bubblewrap, toolClosure: [] })).toThrow(
      /requires a declared tool closure/u,
    )
    expect(() =>
      requireSandbox({ kind: 'none', launcher: BWRAP, toolClosure: [], darwinKernelMajors: [] }),
    ).toThrow(/must not declare a launcher/u)
  })

  it('admits only the measured Darwin kernel major', () => {
    expect(() =>
      requireAdmittedDarwinRelease({ kernelRelease: '25.5.0', sandbox: seatbelt }),
    ).not.toThrow()
    expect(() =>
      requireAdmittedDarwinRelease({ kernelRelease: '24.6.0', sandbox: seatbelt }),
    ).toThrow(/Darwin kernel 24 is not an admitted Seatbelt executor.*25/u)
    expect(() =>
      requireAdmittedDarwinRelease({ kernelRelease: '24.6.0', sandbox: bubblewrap }),
    ).not.toThrow()
  })

  it('resolves logical Darwin metadata paths to prefix and final symlink targets', () => {
    const { root } = createFixture()
    const canonicalDirectory = join(root, 'private/etc')
    const zoneinfo = join(root, 'private/var/db/timezone/zoneinfo/Europe')
    const logicalDirectory = join(root, 'etc')
    const logicalLocaltime = join(logicalDirectory, 'localtime')
    const canonicalLocaltime = join(canonicalDirectory, 'localtime')
    const target = join(zoneinfo, 'Berlin')
    mkdirSync(canonicalDirectory, { recursive: true })
    mkdirSync(zoneinfo, { recursive: true })
    writeFileSync(target, 'TZif')
    symlinkSync(canonicalDirectory, logicalDirectory)
    symlinkSync('../var/db/timezone/zoneinfo/Europe/Berlin', canonicalLocaltime)

    expect(darwinOsMetadataLinks([logicalLocaltime])).toEqual(
      [canonicalLocaltime, realpathSync(logicalLocaltime)].toSorted(),
    )
    expect(() => darwinOsMetadataLinks([join(root, 'missing')])).toThrow(
      /declared Darwin OS metadata path is absent/u,
    )
  })

  it('clears the environment down to a scratch-derived allowlist', () => {
    const environment = actionEnvironment({ scratchRoot: '/scratch' })
    expect(Object.keys(environment).toSorted()).toEqual([
      'HOME',
      'LANG',
      'LC_ALL',
      'PATH',
      'TMPDIR',
      'TZ',
    ])
    expect(environment).toMatchObject({
      HOME: '/scratch/home',
      PATH: '',
      TMPDIR: '/scratch/tmp',
      TZ: 'UTC',
    })
  })

  it('binds inputs and tool closures read-only, output and scratch writable, and nothing else', () => {
    const argv = bubblewrapArgv({
      command: [TSGO, '--noEmit'],
      environment: actionEnvironment({ scratchRoot: '/scratch' }),
      launcher: BWRAP,
      readRoots: ['/tree', BUN_CLOSURE, TSGO_CLOSURE],
      workingDirectory: '/scratch/overlay',
      writeRoots: ['/scratch', '/out/dist'],
    })
    for (const flag of [
      '--unshare-user',
      '--unshare-net',
      '--unshare-pid',
      '--unshare-ipc',
      '--unshare-uts',
      '--unshare-cgroup',
      '--clearenv',
      '--die-with-parent',
    ]) {
      expect(argv).toContain(flag)
    }
    const readBinds = argv.flatMap((value, index) =>
      value === '--ro-bind' ? [argv[index + 1]!] : [],
    )
    expect(argv).not.toContain('--tmpfs')
    const writeBinds = argv.flatMap((value, index) =>
      value === '--bind' ? [argv[index + 1]!] : [],
    )
    expect(readBinds).toEqual([TSGO_CLOSURE, BUN_CLOSURE, '/tree'].toSorted())
    expect(writeBinds).toEqual(['/out/dist', '/scratch'].toSorted())
    expect(readBinds).not.toContain('/nix/store')
    expect(argv.slice(argv.indexOf('--') + 1)).toEqual([TSGO, '--noEmit'])
    expect(argv[argv.indexOf('--chdir') + 1]).toBe('/scratch/overlay')
    expect(
      argv.flatMap((value, index) => (value === '--setenv' ? [argv[index + 1]!] : [])),
    ).toEqual(['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR', 'TZ'])
  })

  it('denies everything by default in a parameterized Seatbelt profile', () => {
    const metadataLinks = [
      '/private/etc/localtime',
      '/private/var/db/timezone/zoneinfo/Europe/Berlin',
    ]
    const profile = seatbeltProfile({
      metadataLinks,
      readRoots: ['/tree', TSGO_CLOSURE],
      writeRoots: ['/scratch', '/out/dist'],
    })
    expect(profile.startsWith('(version 1)\n(deny default)\n(deny network*)')).toBe(true)
    expect(profile).toContain(
      '(allow file-read* (subpath (param "READ_ROOT_0")) (subpath (param "READ_ROOT_1")))',
    )
    expect(profile).toContain(
      '(allow file-read* file-write* (subpath (param "WRITE_ROOT_0")) (subpath (param "WRITE_ROOT_1")))',
    )
    expect(profile).not.toContain('/tree')
    expect(profile).not.toContain('(allow process-exec*)')
    expect(profile).not.toContain('(allow file-read-metadata)')
    expect(profile).not.toContain('(allow sysctl-read)')
    for (const path of DARWIN_SEATBELT_OS_METADATA_PATHS) {
      expect(profile).toContain(`(literal ${JSON.stringify(path)})`)
    }
    expect(DARWIN_SEATBELT_OS_METADATA_PATHS).toEqual([
      '/System/Library/CoreServices/SystemVersion.plist',
      '/dev/null',
      '/dev/random',
      '/dev/urandom',
      '/etc/localtime',
    ])
    expect(profile).not.toContain('/private/var/db/timezone/localtime')
    for (const [index, path] of metadataLinks.entries()) {
      expect(profile).toContain(`(literal (param "META_LINK_${index}"))`)
      expect(profile).not.toContain(path)
    }
    expect(profile).toContain('(allow process-exec ')
    expect(profile).toContain('(allow file-read-metadata ')

    // The runtime opens these, so metadata alone is not enough; every canonical
    // spelling of a declared metadata path is admitted the same way.
    expect(profile).toContain(
      '(allow file-read* (literal "/dev/random") (literal "/dev/urandom") (literal "/etc/localtime") (literal (param "META_LINK_0")) (literal (param "META_LINK_1")))',
    )
    // Exactly one writable OS path, and only its data: no create, unlink, or chmod.
    expect(profile).toContain('(allow file-write-data (literal "/dev/null"))')
    expect(DARWIN_SEATBELT_OS_READ_PATHS).toEqual(['/dev/random', '/dev/urandom', '/etc/localtime'])
    expect(DARWIN_SEATBELT_OS_WRITE_PATHS).toEqual(['/dev/null'])
    // The probed-only path never becomes readable, and no OS path becomes
    // writable beyond its data.
    expect(profile).not.toContain(
      '(allow file-read* (literal "/System/Library/CoreServices/SystemVersion.plist")',
    )
    // `file-write*` stays scoped to the declared write roots; the OS grant is
    // data-only and names no root.
    expect(profile).not.toContain('(allow file-write-data (subpath')
    expect(profile.split('\n').filter((line) => line.includes('file-write*') === true)).toEqual([
      '(allow file-read* file-write* (subpath (param "WRITE_ROOT_0")) (subpath (param "WRITE_ROOT_1")))',
    ])

    const argv = seatbeltArgv({
      command: [TSGO],
      launcher: DARWIN_SANDBOX_LAUNCHER,
      metadataLinks,
      profilePath: '/scratch/seatbelt.sb',
      readRoots: ['/tree', TSGO_CLOSURE],
      writeRoots: ['/scratch', '/out/dist'],
    })
    expect(argv).toEqual([
      DARWIN_SANDBOX_LAUNCHER,
      '-f',
      '/scratch/seatbelt.sb',
      '-D',
      'READ_ROOT_0=/tree',
      '-D',
      `READ_ROOT_1=${TSGO_CLOSURE}`,
      '-D',
      'WRITE_ROOT_0=/scratch',
      '-D',
      'WRITE_ROOT_1=/out/dist',
      '-D',
      'META_LINK_0=/private/etc/localtime',
      '-D',
      'META_LINK_1=/private/var/db/timezone/zoneinfo/Europe/Berlin',
      TSGO,
    ])
  })

  it('builds the same declared boundary on both platform families and none', () => {
    const request = {
      command: [TSGO, '--noEmit'],
      outputRoots: ['/out/dist'],
      inputRoots: ['/tree'],
      scratchRoot: '/scratch',
      workingDirectory: '/scratch/overlay',
    }
    const linux = sandboxInvocation({ ...request, sandbox: bubblewrap })
    expect(linux.argv[0]).toBe(BWRAP)
    expect(linux.profile).toBeUndefined()

    expect(() => sandboxInvocation({ ...request, sandbox: seatbelt })).toThrow(
      /canonical Darwin OS metadata link targets/u,
    )
    const darwin = sandboxInvocation({
      ...request,
      darwinMetadataLinks: ['/private/etc/localtime', '/zoneinfo/Europe/Berlin'],
      sandbox: seatbelt,
    })
    expect(darwin.argv[0]).toBe(DARWIN_SANDBOX_LAUNCHER)
    expect(darwin.profile?.path).toBe('/scratch/seatbelt.sb')
    expect(darwin.profile?.bytes).toContain('(deny network*)')
    expect(darwin.argv).toContain('WRITE_ROOT_0=/out/dist')
    expect(darwin.argv).toContain('WRITE_ROOT_1=/scratch')
    expect(darwin.argv).toContain('META_LINK_0=/private/etc/localtime')
    expect(darwin.argv).toContain('META_LINK_1=/zoneinfo/Europe/Berlin')

    const inactive = sandboxInvocation({
      ...request,
      sandbox: { kind: 'none', launcher: undefined, toolClosure: [], darwinKernelMajors: [] },
    })
    expect(inactive.argv).toEqual([TSGO, '--noEmit'])
    expect(inactive.environment).toEqual(actionEnvironment({ scratchRoot: '/scratch' }))
  })

  it('distinguishes policy denial from unrelated probe failures', () => {
    const denied = probeScriptSource({ expect: 'denied', kind: 'read', target: '/etc/hostname' })
    expect(denied).toContain("import { readFile } from 'node:fs/promises'")
    expect(denied).toContain('await readFile("/etc/hostname")')
    expect(denied).not.toContain('EISDIR')
    expect(denied).toContain('policyDenialCodes')
    expect(denied).toContain('unrelated probe error')
    expect(denied).toContain('ConnectionRefused: true')
    expect(
      probeScriptSource({ expect: 'denied', kind: 'stat', target: '/etc/hostname' }),
    ).toContain('await stat("/etc/hostname")')
    expect(probeScriptSource({ expect: 'denied', kind: 'exec', target: '/bin/sh' })).toContain(
      'await execFile("/bin/sh"',
    )
    expect(
      probeScriptSource({ expect: 'allowed', kind: 'connect', target: 'http://host' }),
    ).toContain('await fetch("http://host"')
    expect(probeScriptSource({ expect: 'denied', kind: 'env', target: 'PROBE_SECRET' })).toContain(
      'process.env["PROBE_SECRET"]',
    )
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
})

describe('metadata-only execution overlay', () => {
  const childrenByDirectory = {
    '': ['node_modules', 'package.json', 'src', 'tsconfig.json'],
    build: ['keep.txt'],
  }

  it('links every declared entry at its shallowest level and copies nothing', () => {
    const plan = planOverlay({ childrenByDirectory, outDir: 'dist' })
    expect(plan.directories).toEqual([])
    expect(plan.links).toEqual([
      { linkPath: 'node_modules', target: 'node_modules' },
      { linkPath: 'package.json', target: 'package.json' },
      { linkPath: 'src', target: 'src' },
      { linkPath: 'tsconfig.json', target: 'tsconfig.json' },
    ])
    expect(plan.outputLink).toBe('dist')
    // One link per declared entry: a dependency view of any size costs exactly one symlink, so
    // the overlay never walks or duplicates a closure.
    expect(plan.links).toHaveLength(childrenByDirectory[''].length)
  })

  it('mirrors only the directories on the output path', () => {
    const plan = planOverlay({ childrenByDirectory, outDir: 'build/dist' })
    expect(plan.directories).toEqual(['build'])
    expect(plan.links).toEqual([
      { linkPath: 'node_modules', target: 'node_modules' },
      { linkPath: 'package.json', target: 'package.json' },
      { linkPath: 'src', target: 'src' },
      { linkPath: 'tsconfig.json', target: 'tsconfig.json' },
      { linkPath: 'build/keep.txt', target: 'build/keep.txt' },
    ])
    expect(plan.outputLink).toBe('build/dist')
  })

  it('links a stale output directory nowhere and needs no output link for a verdict', () => {
    expect(
      planOverlay({ childrenByDirectory: { '': ['dist', 'src'] }, outDir: 'dist' }).links,
    ).toEqual([{ linkPath: 'src', target: 'src' }])
    const verdict = planOverlay({ childrenByDirectory: { '': ['dist', 'src'] } })
    expect(verdict.outputLink).toBeUndefined()
    expect(verdict.links).toEqual([
      { linkPath: 'dist', target: 'dist' },
      { linkPath: 'src', target: 'src' },
    ])
  })

  it('fails closed when a mirrored directory is not part of the declared view', () => {
    expect(() =>
      planOverlay({ childrenByDirectory: { '': ['src'] }, outDir: 'build/dist' }),
    ).toThrow(/no directory to mirror: build/u)
  })
})

describe('TypeScript compiler invocation', () => {
  it('disables incremental state for a verdict-only action', () => {
    expect(
      tsgoTypecheckArgv({ overlayRoot: '/scratch/overlay', project: 'tsconfig.json', tsgo: TSGO }),
    ).toEqual([
      TSGO,
      '--project',
      '/scratch/overlay/tsconfig.json',
      '--noEmit',
      '--composite',
      'false',
      '--incremental',
      'false',
      '--pretty',
      'false',
    ])
  })

  it('redirects build info into scratch and emits through the overlay output link', () => {
    const argv = tsgoEmitArgv({
      outDir: 'dist',
      overlayRoot: '/scratch/overlay',
      project: 'tsconfig.json',
      scratchRoot: '/scratch',
      tsgo: TSGO,
    })
    expect(argv[argv.indexOf('--outDir') + 1]).toBe('/scratch/overlay/dist')
    expect(argv[argv.indexOf('--tsBuildInfoFile') + 1]).toBe(
      '/scratch/build-info/tsconfig.tsbuildinfo',
    )
  })
})

describe('emitted output contract', () => {
  it('accepts JavaScript, declarations, and maps', async () => {
    const { output } = createFixture()
    mkdirSync(join(output, 'src'), { recursive: true })
    writeFileSync(join(output, 'src', 'mod.js'), 'export {}\n')
    writeFileSync(join(output, 'src', 'mod.js.map'), '{}\n')
    writeFileSync(join(output, 'src', 'mod.d.ts'), 'export {}\n')
    await expect(
      validateEmittedOutput({ declarationEntrypoint: 'src/mod.d.ts', output }),
    ).resolves.toBeUndefined()
  })

  it('rejects a build-info byte that escaped the scratch redirect', async () => {
    const { output } = createFixture()
    mkdirSync(join(output, 'src'), { recursive: true })
    writeFileSync(join(output, 'src', 'mod.d.ts'), 'export {}\n')
    writeFileSync(join(output, 'tsconfig.tsbuildinfo'), '{}\n')
    await expect(
      validateEmittedOutput({ declarationEntrypoint: 'src/mod.d.ts', output }),
    ).rejects.toThrow(/must not contain TypeScript build info/u)
  })

  it('rejects a missing declaration entrypoint and symlinked results', async () => {
    const { output, packageRoot } = createFixture()
    await expect(
      validateEmittedOutput({ declarationEntrypoint: 'src/mod.d.ts', output }),
    ).rejects.toThrow(/declaration entrypoint was not emitted/u)
    mkdirSync(join(output, 'src'), { recursive: true })
    writeFileSync(join(packageRoot, 'src', 'real.d.ts'), 'export {}\n')
    writeFileSync(join(output, 'src', 'mod.d.ts'), 'export {}\n')
    symlinkSync(join(packageRoot, 'src', 'real.d.ts'), join(output, 'src', 'linked.d.ts'))
    await expect(
      validateEmittedOutput({ declarationEntrypoint: 'src/mod.d.ts', output }),
    ).rejects.toThrow(/must not contain symlinks/u)
  })
})

describe('TypeScript handwritten declaration copy', () => {
  it('copies only explicit files while preserving their package-relative paths', async () => {
    const { packageRoot, output } = createFixture()
    writeFileSync(join(packageRoot, 'src', 'legacy.d.ts'), 'export {}\n')
    writeFileSync(join(packageRoot, 'src', 'other.d.ts'), 'export {}\n')
    await copyDeclarationSources({
      declarationSources: ['src/legacy.d.ts'],
      output,
      packageRoot,
    })
    expect(readFileSync(join(output, 'src', 'legacy.d.ts'), 'utf8')).toBe('export {}\n')
    expect(existsSync(join(output, 'src', 'other.d.ts'))).toBe(false)
  })

  it('rejects missing, directory, and symlink inputs', async () => {
    const { packageRoot, output } = createFixture()
    await expect(
      copyDeclarationSources({
        declarationSources: ['src/missing.d.ts'],
        output,
        packageRoot,
      }),
    ).rejects.toThrow(/does not exist/u)

    mkdirSync(join(packageRoot, 'src', 'directory.d.ts'))
    await expect(
      copyDeclarationSources({
        declarationSources: ['src/directory.d.ts'],
        output,
        packageRoot,
      }),
    ).rejects.toThrow(/not a regular file/u)

    writeFileSync(join(packageRoot, 'src', 'target.d.ts'), 'export {}\n')
    symlinkSync(join(packageRoot, 'src', 'target.d.ts'), join(packageRoot, 'src', 'linked.d.ts'))
    await expect(
      copyDeclarationSources({
        declarationSources: ['src/linked.d.ts'],
        output,
        packageRoot,
      }),
    ).rejects.toThrow(/not a regular file/u)
  })
})
