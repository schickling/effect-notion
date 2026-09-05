/**
 * Pinned TypeScript action runner for Buck.
 *
 * The runner never copies, hashes, or chmods a dependency closure. It builds a metadata-only
 * overlay in `BUCK_SCRATCH_PATH` that symlinks the declared package view into one
 * package-relative namespace, links the configured `outDir` at the Buck-declared output, clears
 * the inherited environment down to an explicit allowlist, and executes pinned tsgo inside the
 * platform sandbox: Bubblewrap from its exact Nix closure on Linux, the fixed system
 * `sandbox-exec` with a parameterized Seatbelt profile on Darwin.
 *
 * Until a platform's sandbox gate passes, that platform runs with `--sandbox none`, and the
 * runner keeps the input-tree mutation hash as the (much more expensive) containment evidence.
 */
import { createHash, type Hash } from 'node:crypto'
import { createReadStream, lstatSync, realpathSync, type Stats } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, get, type Server } from 'node:http'
import { release } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const signalNumbers = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGTERM: 15,
} as const

type ForwardedSignal = keyof typeof signalNumbers

/** Platform containment implementation selected by the configured execution platform. */
export type SandboxKind = 'bubblewrap' | 'seatbelt' | 'none'

/** Exact launcher, read allowlist, and OS binding of one platform sandbox. */
export type SandboxOptions = {
  readonly kind: SandboxKind
  /** Exact `/nix/store` bwrap, or the fixed system `sandbox-exec`. Absent only for `none`. */
  readonly launcher: string | undefined
  /** Complete immutable tool closure exposed read-only inside the sandbox. */
  readonly toolClosure: readonly string[]
  /** Darwin kernel majors whose Seatbelt semantics the Darwin gate has proven. */
  readonly darwinKernelMajors: readonly string[]
}

type TypecheckOptions = {
  readonly packageTree: string
  readonly readRoots: readonly string[]
  readonly project: string
  readonly sandbox: SandboxOptions
  readonly tsgo: string
  readonly verdict: string
}

type EmitOptions = {
  readonly declarationEntrypoint: string
  readonly declarationSources: readonly string[]
  readonly outDir: string
  readonly output: string
  readonly packageTree: string
  readonly readRoots: readonly string[]
  readonly project: string
  readonly sandbox: SandboxOptions
  readonly tsgo: string
}

/** What a containment probe asserts about one declared or undeclared capability. */
export type ProbeExpectation = 'allowed' | 'denied'

/** One negative- or positive-probe observation made from inside the action's sandbox. */
export type ProbeOptions = {
  readonly bun: string
  readonly expect: ProbeExpectation
  readonly kind: 'read' | 'write' | 'connect' | 'env' | 'stat' | 'exec'
  readonly sandbox: SandboxOptions
  readonly target: string
  readonly verdict: string
}

let activeChild: Bun.Subprocess | undefined
let forwardedSignal: ForwardedSignal | undefined

const fail = (message: string): never => {
  throw new Error(`typescript runner: ${message}`)
}

const formatError = (error: unknown): string =>
  error instanceof Error ? (error.stack ?? error.message) : String(error)

const isErrnoException = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && 'code' in error

const requireArgument = (options: {
  readonly args: readonly string[]
  readonly index: number
  readonly name: string
}): string => options.args[options.index] ?? fail(`missing ${options.name}`)

const requireNormalizedRelativePath = (options: {
  readonly name: string
  readonly value: string
}): string => {
  const { name, value } = options
  if (
    value.length === 0 ||
    isAbsolute(value) === true ||
    value.includes('\\') === true ||
    value
      .split('/')
      .some((component) => component === '' || component === '.' || component === '..') === true
  ) {
    fail(`${name} must be a normalized portable relative path: ${value}`)
  }
  return value
}

const requireStoreExecutable = (options: {
  readonly binary: string
  readonly name: string
  readonly value: string
}): string => {
  const { binary, name, value } = options
  if (value.startsWith('/nix/store/') === false || basename(value) !== binary) {
    fail(`${name} must be an immutable /nix/store ${binary} executable: ${value}`)
  }
  return value
}

const requireStorePath = (value: string): string => {
  if (/^\/nix\/store\/[^/]+$/u.test(value) === false) {
    fail(`tool closure entries must be immutable /nix/store paths: ${value}`)
  }
  return value
}

/** The fixed system path Seatbelt is admitted at. Nothing else may launch a Darwin action. */
export const DARWIN_SANDBOX_LAUNCHER = '/usr/bin/sandbox-exec'

/**
 * Validates one platform's containment contract.
 *
 * Bubblewrap must come from an exact Nix closure; Seatbelt must be the fixed system path bound to
 * a Darwin kernel major whose gate has been re-run (its public interface is deprecated, so an OS
 * upgrade must not silently weaken containment).
 */
export const requireSandbox = (sandbox: SandboxOptions): SandboxOptions => {
  const { kind, launcher, toolClosure, darwinKernelMajors } = sandbox
  if (kind === 'none') {
    if (launcher !== undefined) fail('sandbox none must not declare a launcher')
    return sandbox
  }
  if (toolClosure.length === 0) fail(`sandbox ${kind} requires a declared tool closure`)
  if (kind === 'bubblewrap') {
    requireStoreExecutable({
      binary: 'bwrap',
      name: 'bubblewrap launcher',
      value: launcher ?? fail('sandbox bubblewrap requires a launcher'),
    })
    return sandbox
  }
  if (launcher !== DARWIN_SANDBOX_LAUNCHER) {
    fail(`Seatbelt must be the fixed system launcher ${DARWIN_SANDBOX_LAUNCHER}`)
  }
  if (darwinKernelMajors.length === 0) {
    fail('Seatbelt requires the admitted Darwin kernel majors its gate has proven')
  }
  return sandbox
}

/**
 * Fails unless the host kernel major is an admitted Seatbelt executor.
 *
 * Only the measured Darwin kernels the containment gate has passed on may launch a Seatbelt
 * action; every other platform is unaffected.
 */
export const requireAdmittedDarwinRelease = ({
  kernelRelease = release(),
  sandbox,
}: {
  readonly kernelRelease?: string | undefined
  readonly sandbox: SandboxOptions
}): void => {
  if (sandbox.kind !== 'seatbelt') return
  const major = kernelRelease.split('.')[0] ?? ''
  if (sandbox.darwinKernelMajors.includes(major) === false) {
    fail(
      `Darwin kernel ${major} is not an admitted Seatbelt executor (admitted: ${sandbox.darwinKernelMajors.join(', ')}); re-run the Darwin containment gate`,
    )
  }
}

const parseSandboxKind = (value: string): SandboxKind => {
  if (value === 'bubblewrap' || value === 'seatbelt' || value === 'none') return value
  return fail(`unknown sandbox kind: ${value}`)
}

type FlagState = {
  readonly declarationSources: string[]
  readonly readRoots: string[]
  readonly toolClosure: string[]
  readonly darwinKernelMajors: string[]
  kind: SandboxKind | undefined
  launcher: string | undefined
}

const parseFlags = (options: {
  readonly args: readonly string[]
  readonly command: string
  readonly from: number
}): FlagState => {
  const { args, command, from } = options
  const state: FlagState = {
    declarationSources: [],
    readRoots: [],
    toolClosure: [],
    darwinKernelMajors: [],
    kind: undefined,
    launcher: undefined,
  }
  for (let index = from; index < args.length; index += 2) {
    const flag = requireArgument({ args, index, name: 'flag' })
    const value = requireArgument({ args, index: index + 1, name: `value for ${flag}` })
    if (flag === '--copy-declaration') {
      if (command !== 'emit') fail(`unexpected ${command} argument: ${flag}`)
      state.declarationSources.push(
        requireNormalizedRelativePath({ name: 'declaration source', value }),
      )
      continue
    }
    if (flag === '--read-root') {
      if (command === 'probe') fail(`unexpected ${command} argument: ${flag}`)
      const root = resolve(value)
      if (value.length === 0 || root === '/') fail(`invalid declared read root: ${value}`)
      state.readRoots.push(root)
      continue
    }
    if (flag === '--sandbox') {
      if (state.kind !== undefined) fail('--sandbox must be declared once')
      state.kind = parseSandboxKind(value)
      continue
    }
    if (flag === '--sandbox-launcher') {
      if (state.launcher !== undefined) fail('--sandbox-launcher must be declared once')
      state.launcher = value
      continue
    }
    if (flag === '--tool-closure') {
      state.toolClosure.push(requireStorePath(value))
      continue
    }
    if (flag === '--darwin-kernel-major') {
      if (/^[0-9]+$/u.test(value) === false) fail(`invalid Darwin kernel major: ${value}`)
      state.darwinKernelMajors.push(value)
      continue
    }
    fail(`unexpected ${command} argument: ${flag}`)
  }
  return state
}

const sandboxFromFlags = (state: FlagState): SandboxOptions =>
  requireSandbox({
    kind: state.kind ?? fail('missing --sandbox'),
    launcher: state.launcher,
    toolClosure: [...new Set(state.toolClosure)].toSorted(),
    darwinKernelMajors: [...new Set(state.darwinKernelMajors)].toSorted(),
  })

/** Parses the fail-closed typecheck command contract for focused rule/runner tests. */
export const parseTypecheckOptions = (args: readonly string[]): TypecheckOptions => {
  const flags = parseFlags({ args, command: 'typecheck', from: 4 })
  return {
    tsgo: requireStoreExecutable({
      binary: 'tsgo',
      name: 'tsgo',
      value: requireArgument({ args, index: 0, name: 'tsgo' }),
    }),
    packageTree: requireArgument({ args, index: 1, name: 'package tree' }),
    readRoots: canonicalRoots(flags.readRoots),
    project: requireNormalizedRelativePath({
      name: 'project',
      value: requireArgument({ args, index: 2, name: 'project' }),
    }),
    verdict: requireArgument({ args, index: 3, name: 'verdict' }),
    sandbox: sandboxFromFlags(flags),
  }
}

/** Parses the fail-closed emit command contract for focused rule/runner tests. */
export const parseEmitOptions = (args: readonly string[]): EmitOptions => {
  const flags = parseFlags({ args, command: 'emit', from: 6 })
  return {
    tsgo: requireStoreExecutable({
      binary: 'tsgo',
      name: 'tsgo',
      value: requireArgument({ args, index: 0, name: 'tsgo' }),
    }),
    packageTree: requireArgument({ args, index: 1, name: 'package tree' }),
    readRoots: canonicalRoots(flags.readRoots),
    project: requireNormalizedRelativePath({
      name: 'project',
      value: requireArgument({ args, index: 2, name: 'project' }),
    }),
    outDir: requireNormalizedRelativePath({
      name: 'out dir',
      value: requireArgument({ args, index: 3, name: 'out dir' }),
    }),
    declarationEntrypoint: requireNormalizedRelativePath({
      name: 'declaration entrypoint',
      value: requireArgument({ args, index: 4, name: 'declaration entrypoint' }),
    }),
    output: requireArgument({ args, index: 5, name: 'output' }),
    declarationSources: flags.declarationSources,
    sandbox: sandboxFromFlags(flags),
  }
}

const requireProbeKind = (value: string): ProbeOptions['kind'] => {
  if (
    value === 'read' ||
    value === 'write' ||
    value === 'connect' ||
    value === 'env' ||
    value === 'stat' ||
    value === 'exec'
  ) {
    return value
  }
  return fail(`unknown probe kind: ${value}`)
}

const requireProbeExpectation = (value: string): ProbeExpectation => {
  if (value === 'allowed' || value === 'denied') return value
  return fail(`unknown probe expectation: ${value}`)
}

/** Parses the containment-probe command every platform sandbox gate drives. */
export const parseProbeOptions = (args: readonly string[]): ProbeOptions => {
  const flags = parseFlags({ args, command: 'probe', from: 5 })
  const kind = requireProbeKind(requireArgument({ args, index: 1, name: 'probe kind' }))
  const expect = requireProbeExpectation(
    requireArgument({ args, index: 3, name: 'probe expectation' }),
  )
  return {
    bun: requireStoreExecutable({
      binary: 'bun',
      name: 'bun',
      value: requireArgument({ args, index: 0, name: 'bun' }),
    }),
    kind,
    target: requireArgument({ args, index: 2, name: 'probe target' }),
    expect,
    verdict: requireArgument({ args, index: 4, name: 'verdict' }),
    sandbox: sandboxFromFlags(flags),
  }
}

// ---------------------------------------------------------------------------
// Metadata-only execution overlay
// ---------------------------------------------------------------------------

/** One overlay symlink: `linkPath` inside the overlay pointing at declared input bytes. */
export interface OverlayLink {
  readonly linkPath: string
  readonly target: string
}

/**
 * A complete metadata-only overlay: directories to create, symlinks to declared inputs, and the
 * single writable output link. It contains no copy operation by construction.
 */
export interface OverlayPlan {
  readonly directories: readonly string[]
  readonly links: readonly OverlayLink[]
  readonly outputLink: string | undefined
}

/**
 * Plans the shallowest possible overlay for one action.
 *
 * Only the directories on the `outDir` path are mirrored; every other entry is linked at its
 * shallowest level, so a dependency view costs one symlink regardless of how many files it
 * contains. `childrenByDirectory` is keyed by tree-relative directory (`''` is the tree root).
 */
export const planOverlay = ({
  childrenByDirectory,
  outDir,
}: {
  readonly childrenByDirectory: Readonly<Record<string, readonly string[]>>
  readonly outDir?: string | undefined
}): OverlayPlan => {
  const components = outDir === undefined ? [] : outDir.split('/')
  const mirrored = components.slice(0, -1)
  const directories: string[] = []
  const links: OverlayLink[] = []
  let current = ''
  for (let depth = 0; depth <= mirrored.length; depth += 1) {
    const children =
      childrenByDirectory[current] ?? fail(`package tree has no directory to mirror: ${current}`)
    const excluded = components[depth]
    for (const child of [...children].toSorted()) {
      if (child === excluded) continue
      const path = current === '' ? child : `${current}/${child}`
      links.push({ linkPath: path, target: path })
    }
    if (depth === mirrored.length) break
    current = current === '' ? mirrored[depth]! : `${current}/${mirrored[depth]!}`
    directories.push(current)
  }
  return { directories, links, outputLink: outDir }
}

const materializeOverlay = async (options: {
  readonly outDir?: string | undefined
  readonly output?: string | undefined
  readonly overlayRoot: string
  readonly packageTree: string
}): Promise<string> => {
  const { outDir, output, overlayRoot, packageTree } = options
  let current = ''
  const mirrored = outDir === undefined ? [] : outDir.split('/').slice(0, -1)
  const mirroredDirectories = [current]
  for (const segment of mirrored) {
    current = current === '' ? segment : `${current}/${segment}`
    mirroredDirectories.push(current)
  }
  const childrenByDirectory: Record<string, readonly string[]> = Object.fromEntries(
    await Promise.all(
      mirroredDirectories.map(
        async (directory) => [directory, await readdir(join(packageTree, directory))] as const,
      ),
    ),
  )
  const plan = planOverlay({ childrenByDirectory, outDir })
  await rm(overlayRoot, { force: true, recursive: true })
  await mkdir(overlayRoot, { recursive: true })
  // The planned directories are one strictly nested chain, so each is created recursively:
  // creation order stops mattering once the whole chain is materialized concurrently.
  await Promise.all(
    plan.directories.map((directory) => mkdir(join(overlayRoot, directory), { recursive: true })),
  )
  await Promise.all(
    plan.links.map(({ linkPath, target }) =>
      symlink(join(packageTree, target), join(overlayRoot, linkPath)),
    ),
  )
  if (plan.outputLink !== undefined) {
    const outputRoot = output ?? fail('an emitted overlay requires the declared output')
    await rm(outputRoot, { force: true, recursive: true })
    await mkdir(outputRoot, { recursive: true })
    await symlink(outputRoot, join(overlayRoot, plan.outputLink))
  }
  return overlayRoot
}

// ---------------------------------------------------------------------------
// Cleared environment
// ---------------------------------------------------------------------------

/**
 * The complete action environment: nothing is inherited from the launching shell, CI runner, or
 * developer session. Every value is derived from the action's own scratch boundary, so two runs
 * of the same configured action see byte-identical environments.
 */
export const actionEnvironment = ({
  scratchRoot,
}: {
  readonly scratchRoot: string
}): Readonly<Record<string, string>> => ({
  HOME: join(scratchRoot, 'home'),
  LANG: 'C',
  LC_ALL: 'C',
  PATH: '',
  TMPDIR: join(scratchRoot, 'tmp'),
  TZ: 'UTC',
})

// ---------------------------------------------------------------------------
// Platform sandboxes
// ---------------------------------------------------------------------------

const canonicalRoots = (roots: readonly string[]): readonly string[] =>
  [...new Set(roots.map((root) => resolve(root)))].toSorted()

/**
 * Bubblewrap argv for one action: fresh namespaces including network, a cleared environment
 * re-populated from the allowlist, read-only declared inputs and tool closures, and exactly the
 * declared output plus scratch writable.
 */
export const bubblewrapArgv = ({
  command,
  environment,
  launcher,
  readRoots,
  workingDirectory,
  writeRoots,
}: {
  readonly command: readonly string[]
  readonly environment: Readonly<Record<string, string>>
  readonly launcher: string
  readonly readRoots: readonly string[]
  readonly workingDirectory: string
  readonly writeRoots: readonly string[]
}): readonly string[] => [
  launcher,
  '--unshare-user',
  '--unshare-ipc',
  '--unshare-pid',
  '--unshare-net',
  '--unshare-uts',
  '--unshare-cgroup',
  '--new-session',
  '--die-with-parent',
  '--clearenv',
  '--proc',
  '/proc',
  '--dev',
  '/dev',
  ...canonicalRoots(readRoots).flatMap((root) => ['--ro-bind', root, root]),
  ...canonicalRoots(writeRoots).flatMap((root) => ['--bind', root, root]),
  ...Object.keys(environment)
    .toSorted()
    .flatMap((name) => ['--setenv', name, environment[name]!]),
  '--chdir',
  resolve(workingDirectory),
  '--',
  ...command,
]

const seatbeltParameter = (options: { readonly index: number; readonly mode: 'READ' | 'WRITE' }) =>
  `${options.mode}_ROOT_${options.index}`

const seatbeltRootPredicates = ({
  count,
  mode,
}: {
  readonly count: number
  readonly mode: 'READ' | 'WRITE'
}): string =>
  Array.from(
    { length: count },
    (_, index) => `(subpath (param "${seatbeltParameter({ index, mode })}"))`,
  ).join(' ')

/**
 * Exact system metadata files/devices the Darwin runtime itself requires, named by their stable
 * logical paths. The Darwin gate must prove this list for every admitted kernel major before
 * Seatbelt becomes active.
 *
 * `/etc/localtime` is the stable spelling of the timezone binding. On the admitted release the
 * physical file lives under `/var/db/timezone/zoneinfo/<zone>`, and the older
 * `/private/var/db/timezone/localtime` alias does not exist, so naming it would grant nothing
 * and hide the omission.
 */
export const DARWIN_SEATBELT_OS_METADATA_PATHS = [
  '/System/Library/CoreServices/SystemVersion.plist',
  '/dev/null',
  '/dev/random',
  '/dev/urandom',
  '/etc/localtime',
] as const

/**
 * The declared OS paths whose CONTENT the Darwin runtime reads, not merely whose existence it
 * checks. `file-read-metadata` answers `stat`; a runtime that seeds its RNG or resolves the local
 * timezone must actually open the file, so those three — and every canonical spelling they resolve
 * to — need `file-read*`. `SystemVersion.plist` is deliberately not here: it is probed, not read.
 */
export const DARWIN_SEATBELT_OS_READ_PATHS = [
  '/dev/random',
  '/dev/urandom',
  '/etc/localtime',
] as const

/**
 * The only declared OS path the runtime writes to. `file-write-data` alone, so the grant cannot
 * create, unlink, or change the mode of anything — including this path.
 */
export const DARWIN_SEATBELT_OS_WRITE_PATHS = ['/dev/null'] as const

/**
 * The additional canonical spellings the kernel checks for the declared metadata paths.
 *
 * Seatbelt evaluates a path filter against the resolved path, so a logical path that traverses
 * or is a symlink (`/etc` → `/private/etc`, `/etc/localtime` → the configured zoneinfo file)
 * also needs its canonical location and its final target admitted. Those targets are host-local
 * — the configured zone is not a property of the action — so they are granted as `-D` parameters
 * resolved at action time instead of hardcoded literals, which keeps the profile bytes fixed.
 *
 * A declared path that is absent fails the action closed: the metadata contract is part of what
 * the Darwin gate proves per kernel major, so a stale path must not degrade into a missing grant.
 */
export const darwinOsMetadataLinks = (
  paths: readonly string[] = DARWIN_SEATBELT_OS_METADATA_PATHS,
): readonly string[] => {
  const canonical = new Set<string>()
  for (const path of paths) {
    const link: Stats =
      lstatSync(path, { throwIfNoEntry: false }) ??
      fail(`declared Darwin OS metadata path is absent: ${path}`)
    const self = join(realpathSync(dirname(path)), basename(path))
    if (self !== path) canonical.add(self)
    // A dangling declared metadata link throws here, which is the intended closed failure.
    if (link.isSymbolicLink() === true) {
      const target = realpathSync(path)
      if (target !== path) canonical.add(target)
    }
  }
  return [...canonical].toSorted()
}

const seatbeltMetadataParameter = (index: number): string => `META_LINK_${index}`

const seatbeltMetadataLinkPredicates = (count: number): string =>
  Array.from(
    { length: count },
    (_, index) => `(literal (param "${seatbeltMetadataParameter(index)}"))`,
  ).join(' ')

const seatbeltLiteralPredicates = (paths: readonly string[]): string =>
  paths.map((path) => `(literal ${JSON.stringify(path)})`).join(' ')

/**
 * A parameterized Seatbelt profile: default deny, network denied, reads allowed only for
 * declared input and tool roots, writes allowed only for the declared output and scratch. Roots
 * arrive as `-D` parameters so the profile bytes stay identical across actions.
 */
export const seatbeltProfile = ({
  metadataLinks,
  readRoots,
  writeRoots,
}: {
  readonly metadataLinks: readonly string[]
  readonly readRoots: readonly string[]
  readonly writeRoots: readonly string[]
}): string =>
  [
    '(version 1)',
    '(deny default)',
    '(deny network*)',
    '(allow process-fork)',
    `(allow process-exec ${seatbeltRootPredicates({ count: readRoots.length, mode: 'READ' })} ${seatbeltRootPredicates({ count: writeRoots.length, mode: 'WRITE' })})`,
    `(allow file-read-metadata ${seatbeltRootPredicates({ count: readRoots.length, mode: 'READ' })} ${seatbeltRootPredicates({ count: writeRoots.length, mode: 'WRITE' })} ${seatbeltLiteralPredicates(DARWIN_SEATBELT_OS_METADATA_PATHS)} ${seatbeltMetadataLinkPredicates(metadataLinks.length)})`,
    `(allow file-read* ${seatbeltLiteralPredicates(DARWIN_SEATBELT_OS_READ_PATHS)} ${seatbeltMetadataLinkPredicates(metadataLinks.length)})`,
    `(allow file-write-data ${seatbeltLiteralPredicates(DARWIN_SEATBELT_OS_WRITE_PATHS)})`,
    ...(readRoots.length === 0
      ? []
      : [
          `(allow file-read* ${seatbeltRootPredicates({ count: readRoots.length, mode: 'READ' })})`,
        ]),
    ...(writeRoots.length === 0
      ? []
      : [
          `(allow file-read* file-write* ${seatbeltRootPredicates({ count: writeRoots.length, mode: 'WRITE' })})`,
        ]),
    '',
  ].join('\n')

/** Seatbelt argv for one action: the fixed system launcher, the profile, and its root parameters. */
export const seatbeltArgv = ({
  command,
  launcher,
  metadataLinks,
  profilePath,
  readRoots,
  writeRoots,
}: {
  readonly command: readonly string[]
  readonly launcher: string
  readonly metadataLinks: readonly string[]
  readonly profilePath: string
  readonly readRoots: readonly string[]
  readonly writeRoots: readonly string[]
}): readonly string[] => [
  launcher,
  '-f',
  profilePath,
  ...readRoots.flatMap((root, index) => [
    '-D',
    `${seatbeltParameter({ index, mode: 'READ' })}=${root}`,
  ]),
  ...writeRoots.flatMap((root, index) => [
    '-D',
    `${seatbeltParameter({ index, mode: 'WRITE' })}=${root}`,
  ]),
  ...metadataLinks.flatMap((path, index) => ['-D', `${seatbeltMetadataParameter(index)}=${path}`]),
  ...command,
]

interface SandboxInvocation {
  readonly argv: readonly string[]
  readonly environment: Readonly<Record<string, string>>
  readonly profile: { readonly path: string; readonly bytes: string } | undefined
  readonly workingDirectory: string
}

/** Builds the exact launcher argv, cleared environment, and profile bytes for one action. */
export const sandboxInvocation = ({
  command,
  darwinMetadataLinks = [],
  inputRoots,
  outputRoots,
  sandbox,
  scratchRoot,
  workingDirectory,
}: {
  readonly command: readonly string[]
  readonly darwinMetadataLinks?: readonly string[]
  /** Declared input roots exposed read-only; a probe with no declared view passes none. */
  readonly inputRoots: readonly string[]
  readonly outputRoots: readonly string[]
  readonly sandbox: SandboxOptions
  readonly scratchRoot: string
  readonly workingDirectory: string
}): SandboxInvocation => {
  const environment = actionEnvironment({ scratchRoot })
  const readRoots = canonicalRoots([...inputRoots, ...sandbox.toolClosure])
  const writeRoots = canonicalRoots([scratchRoot, ...outputRoots])
  if (sandbox.kind === 'none') {
    return { argv: command, environment, profile: undefined, workingDirectory }
  }
  if (sandbox.kind === 'bubblewrap') {
    return {
      argv: bubblewrapArgv({
        command,
        environment,
        launcher: sandbox.launcher ?? fail('sandbox bubblewrap requires a launcher'),
        readRoots,
        workingDirectory,
        writeRoots,
      }),
      environment,
      profile: undefined,
      workingDirectory,
    }
  }
  if (darwinMetadataLinks.length === 0) {
    fail('Seatbelt requires canonical Darwin OS metadata link targets')
  }
  const profilePath = join(scratchRoot, 'seatbelt.sb')
  return {
    argv: seatbeltArgv({
      command,
      launcher: sandbox.launcher ?? fail('Seatbelt requires a launcher'),
      metadataLinks: darwinMetadataLinks,
      profilePath,
      readRoots,
      writeRoots,
    }),
    environment,
    profile: {
      path: profilePath,
      bytes: seatbeltProfile({ metadataLinks: darwinMetadataLinks, readRoots, writeRoots }),
    },
    workingDirectory,
  }
}

// ---------------------------------------------------------------------------
// Containment probes
// ---------------------------------------------------------------------------

/**
 * The probe program a platform gate runs *inside* the action sandbox.
 *
 * A denied read does not have to make a compiler exit nonzero, so containment is asserted by an
 * explicit probe: the program exits 0 only when the observed access matches the expectation.
 */
export const probeScriptSource = ({
  expect,
  kind,
  target,
}: {
  readonly expect: ProbeExpectation
  readonly kind: ProbeOptions['kind']
  readonly target: string
}): string => {
  const imports =
    kind === 'read'
      ? [`import { readFile } from 'node:fs/promises'`, '']
      : kind === 'write'
        ? [`import { writeFile } from 'node:fs/promises'`, '']
        : kind === 'stat'
          ? [`import { stat } from 'node:fs/promises'`, '']
          : kind === 'exec'
            ? [
                `import { execFile as execFileCallback } from 'node:child_process'`,
                `import { promisify } from 'node:util'`,
                'const execFile = promisify(execFileCallback)',
                '',
              ]
            : []
  const attempt =
    kind === 'read'
      ? `await readFile(${JSON.stringify(target)})`
      : kind === 'write'
        ? `await writeFile(${JSON.stringify(target)}, 'probe')`
        : kind === 'stat'
          ? `await stat(${JSON.stringify(target)})`
          : kind === 'exec'
            ? `await execFile(${JSON.stringify(target)}, [])`
            : kind === 'connect'
              ? `await fetch(${JSON.stringify(target)})`
              : `observed = process.env[${JSON.stringify(target)}] === undefined ? "denied" : "allowed"`
  return [
    ...imports,
    'const policyDenialCodes = {',
    '  EACCES: true, EPERM: true, EROFS: true, ENOENT: true,',
    '  ENETUNREACH: true, EHOSTUNREACH: true, ECONNREFUSED: true, ConnectionRefused: true,',
    '}',
    'let observed = "allowed"',
    'try {',
    `  ${attempt}`,
    '} catch (error) {',
    '  const directCode = error instanceof Error && "code" in error ? error.code : undefined',
    '  const cause = error instanceof Error ? error.cause : undefined',
    '  const causeCode = cause instanceof Error && "code" in cause ? cause.code : undefined',
    '  const code = typeof directCode === "string" ? directCode : causeCode',
    '  if (typeof code !== "string" || policyDenialCodes[code] !== true) {',
    '    console.error(`unrelated probe error (${String(code)}): ${error}`)',
    '    process.exit(2)',
    '  }',
    '  observed = "denied"',
    '  console.error(`probe policy denial (${code}): ${error}`)',
    '}',
    `const expected = ${JSON.stringify(expect)}`,
    'if (observed !== expected) {',
    `  console.error(\`probe ${kind} ${target}: expected \${expected}, observed \${observed}\`)`,
    '  process.exit(1)',
    '}',
    'process.exit(0)',
    '',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Mutation evidence (pre-sandbox platforms only)
// ---------------------------------------------------------------------------

const updateFramedText = (options: { readonly hash: Hash; readonly value: string }): void => {
  const { hash, value } = options
  const bytes = Buffer.from(value)
  const length = Buffer.allocUnsafe(4)
  length.writeUInt32BE(bytes.byteLength)
  hash.update(length)
  hash.update(bytes)
}

const forEachSequential = async <T>(options: {
  readonly iterator: Iterator<T> | AsyncIterator<T>
  readonly visit: (value: T) => void | Promise<void>
}): Promise<void> => {
  const next = await options.iterator.next()
  if (next.done === true) return
  await options.visit(next.value)
  await forEachSequential(options)
}

const hashTree = async (root: string): Promise<string> => {
  const hash = createHash('sha256')

  const visit = async (path: string): Promise<void> => {
    const metadata = await lstat(path)
    const entry = relative(root, path).split(sep).join('/') || '.'
    updateFramedText({ hash, value: entry })
    updateFramedText({ hash, value: String(metadata.mode & 0o7777) })

    if (metadata.isDirectory() === true) {
      updateFramedText({ hash, value: 'directory' })
      const children = (await readdir(path)).toSorted()
      await forEachSequential({
        iterator: children.values(),
        visit: async (child) => visit(join(path, child)),
      })
      return
    }
    if (metadata.isSymbolicLink() === true) {
      updateFramedText({ hash, value: 'symlink' })
      updateFramedText({ hash, value: await readlink(path) })
      return
    }
    if (metadata.isFile() === true) {
      updateFramedText({ hash, value: 'file' })
      await forEachSequential({
        iterator: createReadStream(path)[Symbol.asyncIterator](),
        visit: (chunk) => {
          hash.update(chunk)
        },
      })
      return
    }
    fail(`unsupported filesystem entry while hashing: ${path}`)
  }

  await visit(root)
  return hash.digest('hex')
}

/**
 * Deterministic immutability evidence for the complete declared input boundary. Roots are
 * canonicalized and deduplicated before hashing, and symlinks are hashed as links rather than
 * followed, so cyclic package/SCC views cannot recurse forever.
 */
export const hashDeclaredInputRoots = async (roots: readonly string[]): Promise<string> => {
  const hash = createHash('sha256')
  await forEachSequential({
    iterator: canonicalRoots(roots).values(),
    visit: async (root) => {
      updateFramedText({ hash, value: root })
      updateFramedText({ hash, value: await hashTree(root) })
    },
  })
  return hash.digest('hex')
}

/**
 * Input immutability evidence for a platform whose sandbox gate has not passed yet.
 *
 * Where a sandbox is active it enforces read-only inputs directly, and hashing the input tree is
 * pure cost, so it is skipped.
 */
const inputMutationHash = async (options: {
  readonly readRoots: readonly string[]
  readonly sandbox: SandboxOptions
}): Promise<string | undefined> =>
  options.sandbox.kind === 'none' ? hashDeclaredInputRoots(options.readRoots) : undefined

// ---------------------------------------------------------------------------
// Declared outputs
// ---------------------------------------------------------------------------

/** Copies only the explicitly action-keyed declaration sources into an emitted dist. */
export const copyDeclarationSources = async (options: {
  readonly declarationSources: readonly string[]
  readonly output: string
  readonly packageRoot: string
}): Promise<void> => {
  await forEachSequential({
    iterator: options.declarationSources.values(),
    visit: async (candidate) => {
      const relativePath = requireNormalizedRelativePath({
        name: 'declaration source',
        value: candidate,
      })
      const source = join(options.packageRoot, relativePath)
      let metadata: Stats
      try {
        metadata = await lstat(source)
      } catch (error) {
        if (isErrnoException(error) === true && error.code === 'ENOENT') {
          fail(`declaration source does not exist: ${relativePath}`)
        }
        throw error
      }
      if (metadata.isFile() === false) {
        fail(`declaration source is not a regular file: ${relativePath}`)
      }
      const destination = join(options.output, relativePath)
      await mkdir(dirname(destination), { recursive: true })
      await copyFile(source, destination)
    },
  })
}

/**
 * The durable output contract: JavaScript, declarations, and maps.
 *
 * TypeScript build-info is redirected to scratch, so its presence in a declared output means the
 * redirect regressed and an uncacheable, non-reproducible byte would enter a dist or cache
 * upload.
 */
export const validateEmittedOutput = async (options: {
  readonly declarationEntrypoint: string
  readonly output: string
}): Promise<void> => {
  const { declarationEntrypoint, output } = options
  const expected = join(output, declarationEntrypoint)
  let expectedMetadata: Stats
  try {
    expectedMetadata = await lstat(expected)
  } catch (error) {
    if (isErrnoException(error) === true && error.code === 'ENOENT') {
      fail(`expected declaration entrypoint was not emitted: ${declarationEntrypoint}`)
    }
    throw error
  }
  if (expectedMetadata.isFile() === false) {
    fail(`expected declaration entrypoint is not a regular file: ${declarationEntrypoint}`)
  }

  const visit = async (path: string): Promise<void> => {
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink() === true)
      fail(`emitted output must not contain symlinks: ${path}`)
    if (metadata.isDirectory() === true) {
      await forEachSequential({
        iterator: (await readdir(path)).values(),
        visit: async (child) => visit(join(path, child)),
      })
      return
    }
    if (metadata.isFile() === false) fail(`unsupported emitted filesystem entry: ${path}`)
    if (path.endsWith('.tsbuildinfo') === true) {
      fail(`emitted output must not contain TypeScript build info: ${path}`)
    }
  }
  await visit(output)
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

const requireScratchRoot = (): string => {
  const declared = process.env['BUCK_SCRATCH_PATH']
  if (declared === undefined || declared.length === 0) {
    return fail('BUCK_SCRATCH_PATH must be declared by the executor')
  }
  return resolve(declared)
}

const runSandboxed = async (options: {
  readonly command: readonly string[]
  readonly inputRoots: readonly string[]
  readonly outputRoots: readonly string[]
  readonly sandbox: SandboxOptions
  readonly scratchRoot: string
  readonly workingDirectory: string
}): Promise<number> => {
  if (forwardedSignal !== undefined) return 128 + signalNumbers[forwardedSignal]
  requireAdmittedDarwinRelease({ sandbox: options.sandbox })
  const invocation = sandboxInvocation({
    ...options,
    darwinMetadataLinks: options.sandbox.kind === 'seatbelt' ? darwinOsMetadataLinks() : [],
  })
  if (invocation.profile !== undefined) {
    await writeFile(invocation.profile.path, invocation.profile.bytes)
  }
  await Promise.all([
    mkdir(invocation.environment['HOME']!, { recursive: true }),
    mkdir(invocation.environment['TMPDIR']!, { recursive: true }),
  ])
  const child = Bun.spawn([...invocation.argv], {
    cwd: invocation.workingDirectory,
    env: { ...invocation.environment },
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  activeChild = child
  try {
    return await child.exited
  } finally {
    activeChild = undefined
  }
}

/**
 * tsgo argv for a verdict-only action.
 *
 * Composite and incremental mode are both disabled, so `--noEmit` writes nothing at all and the
 * verdict depends on the compiler, not on retained build state.
 */
export const tsgoTypecheckArgv = ({
  overlayRoot,
  project,
  tsgo,
}: {
  readonly overlayRoot: string
  readonly project: string
  readonly tsgo: string
}): readonly string[] => [
  tsgo,
  '--project',
  join(overlayRoot, project),
  '--noEmit',
  '--composite',
  'false',
  '--incremental',
  'false',
  '--pretty',
  'false',
]

/**
 * tsgo argv for an emitting action.
 *
 * `outDir` is the overlay's link to the Buck-declared output, and any build-info the project's
 * configuration still requests is redirected into scratch so `.tsbuildinfo` can never reach a
 * dist or a cache upload.
 */
export const tsgoEmitArgv = ({
  outDir,
  overlayRoot,
  project,
  scratchRoot,
  tsgo,
}: {
  readonly outDir: string
  readonly overlayRoot: string
  readonly project: string
  readonly scratchRoot: string
  readonly tsgo: string
}): readonly string[] => [
  tsgo,
  '--project',
  join(overlayRoot, project),
  '--outDir',
  join(overlayRoot, outDir),
  '--tsBuildInfoFile',
  join(scratchRoot, 'build-info', 'tsconfig.tsbuildinfo'),
  '--noEmit',
  'false',
  '--pretty',
  'false',
]

const finish = async (options: {
  readonly compilerError?: unknown
  readonly readRoots: readonly string[]
  readonly status: number
  readonly before: string | undefined
}): Promise<number> => {
  const { compilerError, readRoots, status, before } = options
  let invariantError: unknown
  if (before !== undefined) {
    try {
      const after = await hashDeclaredInputRoots(readRoots)
      if (after !== before) {
        invariantError = new Error(
          `typescript runner: declared input roots changed during the action (before ${before}, after ${after})`,
        )
      }
    } catch (error) {
      invariantError = error
    }
  }
  if (compilerError !== undefined) console.error(formatError(compilerError))
  if (invariantError !== undefined) console.error(formatError(invariantError))
  if (compilerError !== undefined || invariantError !== undefined) {
    return status === 0 ? 1 : status
  }
  return status
}

const runTypecheck = async (options: TypecheckOptions): Promise<number> => {
  const packageTree = resolve(options.packageTree)
  const readRoots = canonicalRoots([packageTree, ...options.readRoots])
  const scratchRoot = requireScratchRoot()
  const before = await inputMutationHash({ readRoots, sandbox: options.sandbox })
  const overlayRoot = await materializeOverlay({
    overlayRoot: join(scratchRoot, 'overlay'),
    packageTree,
  })
  let status = 1
  let compilerError: unknown
  try {
    status = await runSandboxed({
      command: tsgoTypecheckArgv({ overlayRoot, project: options.project, tsgo: options.tsgo }),
      inputRoots: readRoots,
      outputRoots: [],
      sandbox: options.sandbox,
      scratchRoot,
      workingDirectory: overlayRoot,
    })
  } catch (error) {
    compilerError = error
  }
  const result = await finish({ before, compilerError, readRoots, status })
  if (result !== 0) return result
  await writeFile(options.verdict, `${options.tsgo}\n`)
  return 0
}

const runEmit = async (options: EmitOptions): Promise<number> => {
  const packageTree = resolve(options.packageTree)
  const readRoots = canonicalRoots([packageTree, ...options.readRoots])
  const output = resolve(options.output)
  const scratchRoot = requireScratchRoot()
  const before = await inputMutationHash({ readRoots, sandbox: options.sandbox })
  const overlayRoot = await materializeOverlay({
    outDir: options.outDir,
    output,
    overlayRoot: join(scratchRoot, 'overlay'),
    packageTree,
  })
  let status = 1
  let primaryError: unknown
  try {
    status = await runSandboxed({
      command: tsgoEmitArgv({
        outDir: options.outDir,
        overlayRoot,
        project: options.project,
        scratchRoot,
        tsgo: options.tsgo,
      }),
      inputRoots: readRoots,
      outputRoots: [output],
      sandbox: options.sandbox,
      scratchRoot,
      workingDirectory: overlayRoot,
    })
    if (status === 0) {
      await copyDeclarationSources({
        declarationSources: options.declarationSources,
        output,
        packageRoot: packageTree,
      })
      await validateEmittedOutput({ declarationEntrypoint: options.declarationEntrypoint, output })
    }
  } catch (error) {
    primaryError = error
  }
  return finish({ before, compilerError: primaryError, readRoots, status })
}

interface PreparedProbe {
  readonly target: string
  readonly cleanup: () => Promise<void>
}

const closeServer = async (server: Server): Promise<void> =>
  new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error === undefined) resolveClose()
      else rejectClose(error)
    })
  })

/** Cleanup for a probe whose preparation allocated nothing to release. */
const noop = async (): Promise<void> => {}

/**
 * Proves that a negative probe's target works without policy enforcement before interpreting an
 * in-sandbox failure as containment. Network uses a runner-owned loopback server, write uses a
 * unique writable host file, and environment uses an explicitly seeded non-secret marker.
 */
const prepareProbe = async (options: ProbeOptions): Promise<PreparedProbe> => {
  if (options.kind === 'read') {
    await Bun.file(options.target).arrayBuffer()
    return { target: options.target, cleanup: noop }
  }
  if (options.kind === 'stat') {
    const target =
      options.target === 'controlled-store-entry'
        ? ((await readdir('/nix/store'))
            .map((entry) => join('/nix/store', entry))
            .find((entry) => options.sandbox.toolClosure.includes(entry) === false) ??
          fail('store metadata probe found no undeclared store entry'))
        : options.target
    await lstat(target)
    return { target, cleanup: noop }
  }
  if (options.kind === 'exec') {
    const child = Bun.spawn([options.target], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    })
    const status = await child.exited
    if (status !== 0) fail(`exec probe precondition exited ${status}: ${options.target}`)
    return { target: options.target, cleanup: noop }
  }
  if (options.kind === 'write') {
    const target = `${options.target}-${process.pid}`
    await writeFile(target, 'precondition')
    await rm(target)
    return { target, cleanup: async () => rm(target, { force: true }) }
  }
  if (options.kind === 'env') {
    if (process.env[options.target] !== 'seeded-probe-value') {
      fail(`environment probe precondition was not seeded: ${options.target}`)
    }
    return { target: options.target, cleanup: noop }
  }

  if (options.target !== 'controlled-loopback') {
    return fail(`network probe target must be controlled-loopback: ${options.target}`)
  }
  const server = createServer((_request, response) => {
    response.writeHead(204)
    response.end()
  })
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    await closeServer(server)
    return fail('network probe precondition did not acquire a loopback port')
  }
  const target = `http://127.0.0.1:${address.port}/`
  try {
    const status = await new Promise<number | undefined>((resolveStatus, rejectStatus) => {
      get(target, (response) => {
        response.resume()
        resolveStatus(response.statusCode)
      }).once('error', rejectStatus)
    })
    if (status !== 204) fail(`network probe precondition returned ${status}`)
    return { target, cleanup: async () => closeServer(server) }
  } catch (error) {
    await closeServer(server)
    throw error
  }
}

/**
 * Runs one containment observation in a real action sandbox.
 *
 * A probe declares no package view: it exists to observe what the sandbox denies, so its only
 * declared roots are the tool closure (to run Bun at all) and its own scratch.
 */
const runProbe = async (options: ProbeOptions): Promise<number> => {
  const scratchRoot = requireScratchRoot()
  const scriptPath = join(scratchRoot, 'probe.ts')
  await mkdir(scratchRoot, { recursive: true })
  const prepared = await prepareProbe(options)
  try {
    await writeFile(
      scriptPath,
      probeScriptSource({ expect: options.expect, kind: options.kind, target: prepared.target }),
    )
    const status = await runSandboxed({
      command: [options.bun, 'run', scriptPath],
      inputRoots: [],
      outputRoots: [],
      sandbox: options.sandbox,
      scratchRoot,
      workingDirectory: scratchRoot,
    })
    if (status !== 0) return status
    await writeFile(
      options.verdict,
      `${options.sandbox.kind} ${options.kind} ${options.target} ${options.expect}\n`,
    )
    return 0
  } finally {
    await prepared.cleanup()
  }
}

/** Runs the hermetic TypeScript action selected by the Buck rule command. */
export const runTypeScriptCli = async (args: readonly string[]): Promise<number> => {
  const [command, ...commandArgs] = args
  if (command === 'typecheck') return runTypecheck(parseTypecheckOptions(commandArgs))
  if (command === 'emit') return runEmit(parseEmitOptions(commandArgs))
  if (command === 'probe') return runProbe(parseProbeOptions(commandArgs))
  return fail(
    `expected command "typecheck", "emit", or "probe", received ${command ?? '<missing>'}`,
  )
}

const forwardSignal = (signal: ForwardedSignal): void => {
  forwardedSignal ??= signal
  activeChild?.kill(signalNumbers[signal])
}

const signalHandlers = {
  SIGHUP: (): void => forwardSignal('SIGHUP'),
  SIGINT: (): void => forwardSignal('SIGINT'),
  SIGTERM: (): void => forwardSignal('SIGTERM'),
} satisfies Record<ForwardedSignal, () => void>

const installSignalForwarding = (): void => {
  process.on('SIGHUP', signalHandlers.SIGHUP)
  process.on('SIGINT', signalHandlers.SIGINT)
  process.on('SIGTERM', signalHandlers.SIGTERM)
}

const removeSignalForwarding = (): void => {
  process.removeListener('SIGHUP', signalHandlers.SIGHUP)
  process.removeListener('SIGINT', signalHandlers.SIGINT)
  process.removeListener('SIGTERM', signalHandlers.SIGTERM)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installSignalForwarding()
  let status = 1
  try {
    status = await runTypeScriptCli(process.argv.slice(2))
  } catch (error) {
    console.error(formatError(error))
  }
  removeSignalForwarding()
  if (forwardedSignal !== undefined) {
    const signal = forwardedSignal
    process.kill(process.pid, signal)
    process.exit(128 + signalNumbers[signal])
  }
  process.exit(status)
}
