/** Pinned Bun runner for Buck JavaScript commands and tests. */
import { rmSync } from 'node:fs'
import { mkdir, mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  actionEnvironment,
  hashDeclaredInputRoots,
  requireSandbox,
  sandboxInvocation,
  type SandboxOptions,
} from './typescript-runner.ts'

type JavaScriptCommand = 'exec' | 'vitest' | 'bun-test' | 'shell-tests'

/**
 * Capabilities that name a host service rather than a declared input: the outbound network,
 * loopback, the Nix daemon socket plus the store's own root registry under `/nix/var/nix`, and the
 * host's `devpts` and controlling-terminal semantics. Containment removes exactly these, so
 * declaring one is only admissible on the explicitly unsandboxed local executor.
 */
const HOST_SERVICE_CAPABILITIES = ['loopback', 'network', 'nix-daemon', 'pty'] as const

type Capability = (typeof HOST_SERVICE_CAPABILITIES)[number] | 'subprocess'

/**
 * Which executor the rule chose. `sandboxed` is the default everywhere; `unsandboxed-local` is the
 * deliberate, non-cacheable host-service lane and is admissible only with an active host-service
 * capability and no containment.
 */
type ExecutionMode = 'sandboxed' | 'unsandboxed-local'

/**
 * Which runtime evaluates a Vitest suite.
 *
 * Pinned Bun runs every ordinary suite. `node` exists for a suite whose native addon is only
 * correct on Node's own event loop: in-process `node-pty` sessions deliver master-fd reads
 * reliably under Node, while under Bun only the first session in a process observes its output.
 */
type VitestRuntime = 'bun' | 'node'

type CommonOptions = {
  readonly command: JavaScriptCommand
  readonly bun: string
  readonly packageTree: string
  readonly readRoots: readonly string[]
  readonly environment: Readonly<Record<string, string>>
  readonly externalInputs: Readonly<Record<string, string>>
  readonly sandbox: SandboxOptions
  readonly inheritedEnv: readonly string[]
  readonly writableDirectories: Readonly<Record<string, string>>
  readonly capabilities: readonly Capability[]
  readonly executionMode: ExecutionMode
}

/** The complete fail-closed command one `javascript_*` rule encodes in its argv. */
export type JavaScriptRunOptions = CommonOptions & {
  readonly entrypoint: string | undefined
  readonly config: string | undefined
  readonly timeoutMs: number
  readonly hookTimeoutMs: number
  readonly tests: readonly string[]
  readonly excludes: readonly string[]
  readonly args: readonly string[]
  readonly vitestRuntime: VitestRuntime
}

const fail = (message: string): never => {
  throw new Error(`javascript runner: ${message}`)
}

const requireArgument = (options: {
  readonly args: readonly string[]
  readonly index: number
  readonly name: string
}): string => options.args[options.index] ?? fail(`missing ${options.name}`)

const requireRelativePath = (options: {
  readonly field: string
  readonly value: string
}): string => {
  const { field, value } = options
  if (
    value.length === 0 ||
    isAbsolute(value) === true ||
    value.includes('\\') === true ||
    value.split('/').some((part) => part === '' || part === '.' || part === '..') === true
  ) {
    fail(`${field} must be a normalized portable relative path: ${value}`)
  }
  return value
}

const requireBun = (value: string): string => {
  if (/^\/nix\/store\/[^/]+\/bin\/bun$/u.test(value) === false) {
    fail(`Bun must be an immutable /nix/store executable: ${value}`)
  }
  return value
}

const requireTimeout = (options: { readonly field: string; readonly value: string }): number => {
  const { field, value } = options
  const parsed = Number(value)
  if (Number.isSafeInteger(parsed) === false || parsed <= 0)
    fail(`${field} must be positive: ${value}`)
  return parsed
}

const requireEnvironmentName = (value: string): string => {
  if (/^[A-Z_][A-Z0-9_]*$/u.test(value) === false) fail(`invalid environment name: ${value}`)
  return value
}

const requireLiteralEnvironmentValue = (value: string): string => {
  if (value.startsWith('$') === true) fail('environment values must be literal action inputs')
  return value
}

const requireExternalPath = (value: string): string => {
  const resolved = resolve(value)
  if (resolved.startsWith('/nix/store/') === false) {
    fail(`external path must be an immutable /nix/store input: ${value}`)
  }
  return resolved
}

const requireCapability = (value: string): Capability => {
  if (value === 'subprocess') return value
  const hostService = HOST_SERVICE_CAPABILITIES.find((capability) => capability === value)
  return hostService ?? fail(`unknown capability: ${value}`)
}

const requireExecutionMode = (value: string): ExecutionMode => {
  if (value === 'sandboxed' || value === 'unsandboxed-local') return value
  return fail(`unknown execution mode: ${value}`)
}

const requireVitestRuntime = (value: string): VitestRuntime => {
  if (value === 'bun' || value === 'node') return value
  return fail(`unknown vitest runtime: ${value}`)
}

const requireJavaScriptCommand = (value: string): JavaScriptCommand => {
  if (value === 'exec' || value === 'vitest' || value === 'bun-test' || value === 'shell-tests') {
    return value
  }
  return fail(`unknown command: ${value}`)
}

const parseSandboxKind = (value: string): SandboxOptions['kind'] => {
  if (value === 'bubblewrap' || value === 'seatbelt' || value === 'none') return value
  return fail(`unknown sandbox kind: ${value}`)
}

/** Parses the complete fail-closed command passed by `buck2/javascript.bzl`. */
export const parseJavaScriptRunOptions = (args: readonly string[]): JavaScriptRunOptions => {
  const command = requireJavaScriptCommand(requireArgument({ args, index: 0, name: 'command' }))
  const bun = requireBun(requireArgument({ args, index: 1, name: 'Bun' }))
  const packageTree = resolve(requireArgument({ args, index: 2, name: 'package tree' }))
  let index = 3
  let entrypoint: string | undefined
  let config: string | undefined
  let timeoutMs = 30_000
  let hookTimeoutMs = 30_000
  if (command === 'exec') {
    entrypoint = requireRelativePath({
      field: 'entrypoint',
      value: requireArgument({ args, index, name: 'entrypoint' }),
    })
    index += 1
  } else if (command === 'vitest') {
    config = requireRelativePath({
      field: 'config',
      value: requireArgument({ args, index, name: 'config' }),
    })
    timeoutMs = requireTimeout({
      field: 'test timeout',
      value: requireArgument({ args, index: index + 1, name: 'test timeout' }),
    })
    hookTimeoutMs = requireTimeout({
      field: 'hook timeout',
      value: requireArgument({ args, index: index + 2, name: 'hook timeout' }),
    })
    index += 3
  } else {
    timeoutMs = requireTimeout({
      field: 'test timeout',
      value: requireArgument({ args, index, name: 'test timeout' }),
    })
    index += 1
  }

  const tests: string[] = []
  const excludes: string[] = []
  const readRoots: string[] = []
  const environment: Record<string, string> = {}
  const externalInputs: Record<string, string> = {}
  const inheritedEnv: string[] = []
  const writableDirectories: Record<string, string> = {}
  const capabilities: Capability[] = []
  const toolClosure: string[] = []
  const darwinKernelMajors: string[] = []
  const forwardedArgs: string[] = []
  let kind: SandboxOptions['kind'] | undefined
  let launcher: string | undefined
  // Containment is the default; only an explicit flag can name the host-service executor.
  let executionMode: ExecutionMode = 'sandboxed'
  // Pinned Bun runs a suite unless the rule names the Node runtime explicitly.
  let vitestRuntime: VitestRuntime = 'bun'

  while (index < args.length) {
    const flag = requireArgument({ args, index, name: 'flag' })
    if (flag === '--') {
      forwardedArgs.push(...args.slice(index + 1))
      break
    }
    if (flag === '--env' || flag === '--input') {
      const name = requireEnvironmentName(
        requireArgument({ args, index: index + 1, name: `${flag} name` }),
      )
      const value = requireArgument({ args, index: index + 2, name: `${flag} value` })
      if (flag === '--env') environment[name] = requireLiteralEnvironmentValue(value)
      else externalInputs[name] = resolve(value)
      index += 3
      continue
    }
    if (flag === '--external-path') {
      const name = requireEnvironmentName(
        requireArgument({ args, index: index + 1, name: `${flag} name` }),
      )
      externalInputs[name] = requireExternalPath(
        requireArgument({ args, index: index + 2, name: `${flag} value` }),
      )
      index += 3
      continue
    }
    if (flag === '--inherit-env' || flag === '--capability') {
      const value = requireArgument({ args, index: index + 1, name: `value for ${flag}` })
      if (flag === '--inherit-env') inheritedEnv.push(requireEnvironmentName(value))
      else capabilities.push(requireCapability(value))
      index += 2
      continue
    }
    if (flag === '--writable-directory') {
      const name = requireEnvironmentName(
        requireArgument({ args, index: index + 1, name: `${flag} name` }),
      )
      writableDirectories[name] = requireRelativePath({
        field: 'writable directory',
        value: requireArgument({ args, index: index + 2, name: `${flag} value` }),
      })
      index += 3
      continue
    }
    const value = requireArgument({ args, index: index + 1, name: `value for ${flag}` })
    if (flag === '--test') tests.push(requireRelativePath({ field: 'test', value }))
    else if (flag === '--exclude') excludes.push(requireRelativePath({ field: 'exclude', value }))
    else if (flag === '--read-root') readRoots.push(resolve(value))
    else if (flag === '--sandbox') kind = parseSandboxKind(value)
    else if (flag === '--sandbox-launcher') launcher = value
    else if (flag === '--tool-closure') toolClosure.push(value)
    else if (flag === '--darwin-kernel-major') darwinKernelMajors.push(value)
    else if (flag === '--execution-mode') executionMode = requireExecutionMode(value)
    else if (flag === '--vitest-runtime') vitestRuntime = requireVitestRuntime(value)
    else fail(`unexpected argument: ${flag}`)
    index += 2
  }

  const sandbox = requireSandbox({
    kind: kind ?? fail('missing --sandbox'),
    launcher,
    toolClosure: [...new Set(toolClosure)].toSorted(),
    darwinKernelMajors: [...new Set(darwinKernelMajors)].toSorted(),
  })
  return {
    command,
    bun,
    packageTree,
    entrypoint,
    config,
    timeoutMs,
    hookTimeoutMs,
    tests,
    excludes,
    args: forwardedArgs,
    vitestRuntime,
    readRoots: [...new Set(readRoots)].toSorted(),
    environment,
    externalInputs,
    inheritedEnv: [...new Set(inheritedEnv)].toSorted(),
    writableDirectories,
    capabilities: [...new Set(capabilities)].toSorted(),
    executionMode,
    sandbox,
  }
}

/**
 * Exact one-shot Vitest command, with both human and retained JSON reporters.
 *
 * `runtime` is the exact declared executable that evaluates the suite: pinned Bun by default,
 * or the lane's declared Node when its native addon requires Node's own event loop.
 *
 * Vite's default `bundle` config loader has to materialize the bundled config as a real module
 * before importing it, and it picks `<nearest node_modules>/.vite-temp` for that file — inside the
 * read-only package view. The `runner` loader evaluates the config through Vite's module runner
 * instead, so config loading stays in memory and the package tree needs no write access.
 */
export const vitestArgv = (options: {
  readonly runtime: string
  readonly packageTree: string
  readonly config: string
  readonly timeoutMs: number
  readonly hookTimeoutMs: number
  readonly report: string
  readonly tests: readonly string[]
  readonly excludes: readonly string[]
}): readonly string[] => [
  options.runtime,
  join(options.packageTree, 'node_modules/vitest/vitest.mjs'),
  'run',
  '--config',
  join(options.packageTree, options.config),
  '--configLoader=runner',
  '--testTimeout',
  String(options.timeoutMs),
  '--hookTimeout',
  String(options.hookTimeoutMs),
  '--reporter=default',
  '--reporter=json',
  `--outputFile.json=${options.report}`,
  ...options.tests,
  ...options.excludes.flatMap((path) => ['--exclude', path]),
]

/**
 * Buck declares `BUCK_SCRATCH_PATH` for build and run *actions*, but `ExternalRunnerTestInfo`
 * commands are launched by the test executor, which declares neither a scratch path nor a result
 * artifact directory. Test invocations therefore own their scratch: the runner allocates one
 * private directory, exposes only it writable to the sandbox, and removes it afterwards.
 */
export type ScratchPlan = {
  /** `undefined` means the runner must allocate and own a private scratch directory. */
  readonly root: string | undefined
  /** Result artifact directory when the executor declared one; otherwise scratch-relative. */
  readonly declaredResults: string | undefined
}

/** Commands that reach the runner through `ExternalRunnerTestInfo` rather than a Buck action. */
const externalTestCommand: Record<JavaScriptCommand, boolean> = {
  exec: false,
  vitest: true,
  'bun-test': true,
  'shell-tests': true,
}

/** Signals Buck uses to stop a test process; each one must still release owned scratch. */
const interruptSignals = [
  'SIGINT',
  'SIGTERM',
  'SIGHUP',
] as const satisfies readonly NodeJS.Signals[]

const declaredDirectory = (value: string | undefined): string | undefined =>
  value === undefined || value.length === 0 ? undefined : resolve(value)

/** Decides whether this invocation inherits an executor scratch or must own a private one. */
export const planScratch = ({
  command,
  env,
}: {
  readonly command: JavaScriptCommand
  readonly env: Readonly<Record<string, string | undefined>>
}): ScratchPlan => {
  const declaredScratch = declaredDirectory(env['BUCK_SCRATCH_PATH'])
  const declaredResults = declaredDirectory(env['TEST_RESULT_ARTIFACTS_DIR'])
  if (declaredScratch !== undefined) return { root: declaredScratch, declaredResults }
  if (declaredResults !== undefined) return { root: declaredResults, declaredResults }
  if (externalTestCommand[command] === true) return { root: undefined, declaredResults }
  return fail(`BUCK_SCRATCH_PATH must be declared by the executor for the ${command} action`)
}

/** The scratch boundary one invocation runs inside, plus its teardown. */
export interface ScratchLease {
  readonly root: string
  readonly results: string
  readonly release: () => void
}

/**
 * Acquires the action scratch boundary. An owned directory is created private under the host
 * temporary root and torn down on return, on throw, and on the signals Buck uses to stop a test.
 */
export const acquireScratch = async (plan: ScratchPlan): Promise<ScratchLease> => {
  const declared = plan.root
  if (declared !== undefined) {
    const results = plan.declaredResults ?? join(declared, 'results')
    await mkdir(declared, { recursive: true })
    await mkdir(results, { recursive: true })
    return { root: declared, results, release: () => {} }
  }
  const root = await mkdtemp(join(await realpath(tmpdir()), 'buck2-javascript-test-'))
  const results = plan.declaredResults ?? join(root, 'results')
  await mkdir(results, { recursive: true })
  let released = false
  const remove = (): void => {
    if (released === true) return
    released = true
    process.off('exit', remove)
    for (const signal of interruptSignals) process.off(signal, onSignal)
    rmSync(root, { recursive: true, force: true })
  }
  const onSignal = (signal: NodeJS.Signals): void => {
    remove()
    process.kill(process.pid, signal)
  }
  process.once('exit', remove)
  for (const signal of interruptSignals) process.once(signal, onSignal)
  return { root, results, release: remove }
}

const runShellTest = async (options: {
  readonly bash: string
  readonly environment: Readonly<Record<string, string>>
  readonly source: string
  readonly test: string
  readonly timeoutMs: number
}): Promise<number> => {
  const { bash, environment, source, test, timeoutMs } = options
  console.log(`Running ${test}`)
  const child = Bun.spawn([bash, join(source, test)], {
    cwd: source,
    env: {
      ...environment,
      BASH_BIN: bash,
      // The declared source is an immutable store realization, not a worktree: `git+file://`
      // would demand a `.git` the store copy does not have, so it is addressed as a path.
      NIX_FLAKE_REF: `path:${source}`,
      PATH: environment['PATH'] ?? fail('missing declared tool PATH'),
    },
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const timer = setTimeout(() => child.kill(), timeoutMs)
  const status = await child.exited
  clearTimeout(timer)
  return status
}

/**
 * Runs the declared shell suites strictly in order and stops at the first non-zero exit. The
 * suites share one Nix daemon and one devenv source, so the order is part of the contract; the
 * recursion keeps it without an awaiting loop.
 */
const runShellTestsSequential = async (options: {
  readonly bash: string
  readonly environment: Readonly<Record<string, string>>
  readonly source: string
  readonly tests: readonly string[]
  readonly timeoutMs: number
}): Promise<number> => {
  const { bash, environment, source, tests, timeoutMs } = options
  const [test, ...rest] = tests
  if (test === undefined) return 0
  const status = await runShellTest({ bash, environment, source, test, timeoutMs })
  return status === 0
    ? runShellTestsSequential({ bash, environment, source, tests: rest, timeoutMs })
    : status
}

const runShellTests = async (parameters: {
  readonly environment: Readonly<Record<string, string>>
  readonly options: JavaScriptRunOptions
}): Promise<number> => {
  const { environment, options } = parameters
  const source =
    options.externalInputs['DEVENV_MODULE_SOURCE'] ?? fail('missing DEVENV_MODULE_SOURCE')
  const bash = options.externalInputs['BASH_BIN'] ?? fail('missing BASH_BIN')
  if (options.externalInputs['NIX_BIN'] === undefined) fail('missing NIX_BIN')
  const tests = [
    ...new Bun.Glob('nix/devenv-modules/**/*.test.sh').scanSync({ cwd: source }),
  ].toSorted()
  if (tests.length === 0) fail('devenv module source contains no test scripts')
  return runShellTestsSequential({ bash, environment, source, tests, timeoutMs: options.timeoutMs })
}

const runInner = async (parameters: {
  readonly options: JavaScriptRunOptions
  readonly results: string
  readonly scratch: string
}): Promise<number> => {
  const { options, results, scratch } = parameters
  const writableEnvironment = Object.fromEntries(
    await Promise.all(
      Object.entries(options.writableDirectories).map(async ([name, directory]) => {
        const target = join(scratch, 'writable', directory)
        await mkdir(dirname(target), { recursive: true })
        return [name, target] as const
      }),
    ),
  )
  await Promise.all([
    mkdir(join(scratch, 'home'), { recursive: true }),
    mkdir(join(scratch, 'tmp'), { recursive: true }),
    mkdir(results, { recursive: true }),
  ])
  const environment = {
    ...actionEnvironment({ scratchRoot: scratch }),
    ...options.environment,
    ...options.externalInputs,
    PATH: [
      ...new Set(
        Object.values(options.externalInputs).map((path) =>
          path.endsWith('/bin') === true ? path : dirname(path),
        ),
      ),
    ]
      .toSorted()
      .join(':'),
    ...writableEnvironment,
    ...Object.fromEntries(
      options.inheritedEnv.map((name) => [
        name,
        process.env[name] ?? fail(`required inherited environment variable is missing: ${name}`),
      ]),
    ),
    CI: options.environment['CI'] ?? 'true',
  }
  if (options.command === 'shell-tests') return runShellTests({ environment, options })
  const command =
    options.command === 'vitest'
      ? vitestArgv({
          runtime:
            options.vitestRuntime === 'bun'
              ? options.bun
              : (options.externalInputs['NODE_BIN'] ??
                fail('vitest runtime "node" requires the declared NODE_BIN tool')),
          packageTree: options.packageTree,
          config: options.config ?? fail('missing config'),
          timeoutMs: options.timeoutMs,
          hookTimeoutMs: options.hookTimeoutMs,
          report: join(results, 'vitest.json'),
          tests: options.tests,
          excludes: options.excludes,
        })
      : options.command === 'bun-test'
        ? [options.bun, 'test', '--timeout', String(options.timeoutMs), ...options.tests]
        : [
            options.bun,
            join(options.packageTree, options.entrypoint ?? fail('missing entrypoint')),
            ...options.args,
          ]
  const child = Bun.spawn([...command], {
    cwd: options.packageTree,
    env: environment,
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  return child.exited
}

const runSandboxed = async (parameters: {
  readonly args: readonly string[]
  readonly options: JavaScriptRunOptions
  readonly results: string
  readonly scratch: string
}): Promise<number> => {
  const { args, options, results, scratch } = parameters
  const innerCommand = [
    options.bun,
    fileURLToPath(import.meta.url),
    '__inner',
    scratch,
    results,
    ...args,
  ]
  const inputRoots = [
    dirname(fileURLToPath(import.meta.url)),
    options.packageTree,
    ...options.readRoots,
    ...Object.values(options.externalInputs),
  ]
  const hostServices = HOST_SERVICE_CAPABILITIES.filter((capability) =>
    options.capabilities.includes(capability),
  )
  if (options.executionMode === 'unsandboxed-local') {
    if (options.sandbox.kind !== 'none') {
      fail(`the unsandboxed local executor must not carry a ${options.sandbox.kind} sandbox`)
    }
    if (hostServices.length === 0) {
      fail('the unsandboxed local executor requires a declared host-service capability')
    }
  } else if (hostServices.length > 0) {
    fail(`${hostServices.join(', ')} capabilities require an explicitly unsandboxed local executor`)
  }
  // Input-mutation hashing is the substitute evidence for a platform whose containment gate has
  // not passed: it proves a *sandboxed-intent* action did not observe changing inputs. The
  // host-service lane has no such intent and no cache entry to defend, so hashing there would
  // only fail the lane whenever a concurrent Buck invocation rematerializes its inputs.
  const before =
    options.sandbox.kind === 'none' && options.executionMode === 'sandboxed'
      ? await hashDeclaredInputRoots(inputRoots)
      : undefined
  const invocation = sandboxInvocation({
    command: innerCommand,
    inputRoots,
    // Scratch is already writable, so a result directory inside it needs no second bind.
    outputRoots: relative(scratch, results).startsWith('..') === true ? [results] : [],
    sandbox: options.sandbox,
    scratchRoot: scratch,
    workingDirectory: options.packageTree,
  })
  if (invocation.profile !== undefined)
    await Bun.write(invocation.profile.path, invocation.profile.bytes)
  const child = Bun.spawn([...invocation.argv], {
    cwd: invocation.workingDirectory,
    env: {
      ...invocation.environment,
      ...Object.fromEntries(
        options.inheritedEnv.map((name) => [
          name,
          process.env[name] ?? fail(`required inherited environment variable is missing: ${name}`),
        ]),
      ),
    },
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const status = await child.exited
  if (before !== undefined && (await hashDeclaredInputRoots(inputRoots)) !== before) {
    fail('declared inputs changed while the JavaScript command was running')
  }
  return status
}

/**
 * Runs one command inside its scratch boundary. Build and run actions reuse the executor-declared
 * scratch; external test invocations own a private one that is released once the child exits.
 */
const runOuter = async (parameters: {
  readonly args: readonly string[]
  readonly options: JavaScriptRunOptions
}): Promise<number> => {
  const { args, options } = parameters
  const lease = await acquireScratch(planScratch({ command: options.command, env: process.env }))
  try {
    return await runSandboxed({ args, options, results: lease.results, scratch: lease.root })
  } finally {
    lease.release()
  }
}

/** Runs one Buck JavaScript command without inheriting ambient tools or environment. */
export const runJavaScriptCli = async (args: readonly string[]): Promise<number> => {
  if (args[0] === '__inner') {
    const scratch = resolve(requireArgument({ args, index: 1, name: 'inner scratch root' }))
    const results = resolve(requireArgument({ args, index: 2, name: 'inner result directory' }))
    return runInner({ options: parseJavaScriptRunOptions(args.slice(3)), results, scratch })
  }
  return runOuter({ args, options: parseJavaScriptRunOptions(args) })
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(await runJavaScriptCli(process.argv.slice(2)))
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
    process.exit(1)
  }
}
