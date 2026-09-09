/** Pinned Bun runner for Buck JavaScript commands and tests. */
import { rmSync } from 'node:fs'
import { mkdir, mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { hashDeclaredInputRoots } from './typescript-runner.ts'

type JavaScriptCommand = 'exec' | 'vitest' | 'vitest-collect' | 'bun-test' | 'shell-tests'
type VitestRuntime = 'bun' | 'node'

/**
 * Fully resolved action description for one Buck JavaScript command. Every path and timeout is
 * declared by the action. Ambient state is reachable only through the explicitly declared
 * `inheritedEnv` names and the executor's scratch and result variables.
 */
export type JavaScriptRunOptions = {
  readonly command: JavaScriptCommand
  readonly bun: string
  readonly packageTree: string
  readonly readRoots: readonly string[]
  readonly environment: Readonly<Record<string, string>>
  readonly externalInputs: Readonly<Record<string, string>>
  readonly inheritedEnv: readonly string[]
  readonly writableDirectories: Readonly<Record<string, string>>
  readonly entrypoint: string | undefined
  readonly config: string | undefined
  readonly timeoutMs: number
  readonly hookTimeoutMs: number
  readonly tests: readonly string[]
  readonly excludes: readonly string[]
  readonly args: readonly string[]
  readonly vitestRuntime: VitestRuntime
  readonly collectOutput: string | undefined
}

const COLLECTION_REPORT_NAME = 'vitest-collection.json'
const fail = (message: string): never => {
  throw new Error(`javascript runner: ${message}`)
}
const requireArgument = ({
  args,
  index,
  name,
}: {
  readonly args: readonly string[]
  readonly index: number
  readonly name: string
}): string => args[index] ?? fail(`missing ${name}`)

const requireRelativePath = ({
  field,
  value,
}: {
  readonly field: string
  readonly value: string
}): string => {
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
const requireBun = (value: string): string =>
  /^\/nix\/store\/[^/]+\/bin\/bun$/u.test(value) === true
    ? value
    : fail(`Bun must be an immutable /nix/store executable: ${value}`)
const requireTimeout = ({
  field,
  value,
}: {
  readonly field: string
  readonly value: string
}): number => {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) === true && parsed > 0
    ? parsed
    : fail(`${field} must be positive: ${value}`)
}
const requireEnvironmentName = (value: string): string =>
  /^[A-Z_][A-Z0-9_]*$/u.test(value) === true ? value : fail(`invalid environment name: ${value}`)
const requireLiteralEnvironmentValue = (value: string): string =>
  value.startsWith('$') === false ? value : fail('environment values must be literal action inputs')
const requireExternalPath = (value: string): string => {
  const resolved = resolve(value)
  return resolved.startsWith('/nix/store/') === true
    ? resolved
    : fail(`external path must be an immutable /nix/store input: ${value}`)
}
const requireCommand = (value: string): JavaScriptCommand => {
  if (
    value === 'exec' ||
    value === 'vitest' ||
    value === 'vitest-collect' ||
    value === 'bun-test' ||
    value === 'shell-tests'
  )
    return value
  return fail(`unknown command: ${value}`)
}
const requireVitestRuntime = (value: string): VitestRuntime =>
  value === 'bun' || value === 'node' ? value : fail(`unknown vitest runtime: ${value}`)

/**
 * Decodes the positional action argv into options, rejecting anything the sandbox cannot
 * reproduce: non-store Bun binaries, absolute or escaping relative paths, non-literal
 * environment values and unknown commands. Positional layout varies per command.
 */
export const parseJavaScriptRunOptions = (args: readonly string[]): JavaScriptRunOptions => {
  const command = requireCommand(requireArgument({ args, index: 0, name: 'command' }))
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
  } else if (command === 'vitest-collect') {
    config = requireRelativePath({
      field: 'config',
      value: requireArgument({ args, index, name: 'config' }),
    })
    index += 1
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
  const forwardedArgs: string[] = []
  let vitestRuntime: VitestRuntime = 'bun'
  let collectOutput: string | undefined
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
    else if (flag === '--read-root') {
      const root = resolve(value)
      if (value.length === 0 || root === '/') fail(`invalid declared read root: ${value}`)
      readRoots.push(root)
    } else if (flag === '--inherit-env') inheritedEnv.push(requireEnvironmentName(value))
    else if (flag === '--vitest-runtime') vitestRuntime = requireVitestRuntime(value)
    else if (flag === '--collect-output') collectOutput = resolve(value)
    else fail(`unexpected argument: ${flag}`)
    index += 2
  }
  if (command === 'vitest-collect' && collectOutput === undefined)
    fail('vitest-collect requires the declared --collect-output build output')
  if (command !== 'vitest-collect' && collectOutput !== undefined)
    fail(`--collect-output is only admissible for vitest-collect, not ${command}`)
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
    collectOutput,
    readRoots: [...new Set(readRoots)].toSorted(),
    environment,
    externalInputs,
    inheritedEnv: [...new Set(inheritedEnv)].toSorted(),
    writableDirectories,
  }
}

/**
 * Builds the exact `vitest run` argv for a declared config, always emitting both the default
 * and JSON reporters so the run stays deterministic and machine readable regardless of caller.
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
 * Builds the argv for the collection entrypoint, which enumerates tests without executing them
 * and writes the discovered set to the report path.
 */
export const vitestCollectArgv = (options: {
  readonly runtime: string
  readonly entry: string
  readonly packageTree: string
  readonly config: string
  readonly report: string
  readonly tests: readonly string[]
  readonly excludes: readonly string[]
}): readonly string[] => [
  options.runtime,
  options.entry,
  options.packageTree,
  options.config,
  options.report,
  ...options.tests.flatMap((path) => ['--test', path]),
  ...options.excludes.flatMap((path) => ['--exclude', path]),
]

/**
 * Decision about where an action may write: `root` is undefined when no executor scratch was
 * declared and a temporary directory has to be created instead.
 */
export type ScratchPlan = {
  readonly root: string | undefined
  readonly declaredResults: string | undefined
}
/**
 * An acquired scratch area; `release` is idempotent and only deletes storage this process
 * created, never a directory owned by the executor.
 */
export interface ScratchLease {
  readonly root: string
  readonly results: string
  readonly release: () => void
}
const externalTestCommand: Record<JavaScriptCommand, boolean> = {
  exec: false,
  vitest: true,
  'vitest-collect': false,
  'bun-test': true,
  'shell-tests': true,
}
const interruptSignals = [
  'SIGINT',
  'SIGTERM',
  'SIGHUP',
] as const satisfies readonly NodeJS.Signals[]
const declaredDirectory = (value: string | undefined): string | undefined =>
  value === undefined || value.length === 0 ? undefined : resolve(value)

/**
 * Resolves the scratch strategy from the declared executor environment. Commands that Buck runs
 * as external tests may fall back to a temporary directory; every other command fails rather
 * than writing outside a declared location.
 */
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

/**
 * Materialises the planned scratch and results directories. A temporary root is additionally
 * wired to exit and interrupt handlers so an aborted action leaves nothing behind; the signal
 * is re-raised after cleanup to preserve the original termination status.
 */
export const acquireScratch = async (plan: ScratchPlan): Promise<ScratchLease> => {
  if (plan.root !== undefined) {
    const results = plan.declaredResults ?? join(plan.root, 'results')
    await Promise.all([mkdir(plan.root, { recursive: true }), mkdir(results, { recursive: true })])
    return { root: plan.root, results, release: () => {} }
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

const actionEnvironment = (scratch: string): Record<string, string> => ({
  HOME: join(scratch, 'home'),
  LANG: 'C',
  LC_ALL: 'C',
  PATH: '',
  TMPDIR: join(scratch, 'tmp'),
  TZ: 'UTC',
})

const runShellTest = async (options: {
  readonly bash: string
  readonly environment: Readonly<Record<string, string>>
  readonly source: string
  readonly test: string
  readonly timeoutMs: number
}): Promise<number> => {
  console.log(`Running ${options.test}`)
  const child = Bun.spawn([options.bash, join(options.source, options.test)], {
    cwd: options.source,
    env: {
      ...options.environment,
      BASH_BIN: options.bash,
      NIX_FLAKE_REF: `path:${options.source}`,
      PATH: options.environment['PATH'] ?? fail('missing declared tool PATH'),
    },
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const timer = setTimeout(() => child.kill(), options.timeoutMs)
  const status = await child.exited
  clearTimeout(timer)
  return status
}

const runShellTestsSequential = async (options: {
  readonly bash: string
  readonly environment: Readonly<Record<string, string>>
  readonly source: string
  readonly tests: readonly string[]
  readonly timeoutMs: number
}): Promise<number> => {
  const [test, ...rest] = options.tests
  if (test === undefined) return 0
  const status = await runShellTest({ ...options, test })
  return status === 0 ? runShellTestsSequential({ ...options, tests: rest }) : status
}

const runShellTests = async (options: {
  readonly environment: Readonly<Record<string, string>>
  readonly run: JavaScriptRunOptions
}): Promise<number> => {
  const source =
    options.run.externalInputs['DEVENV_MODULE_SOURCE'] ?? fail('missing DEVENV_MODULE_SOURCE')
  const bash = options.run.externalInputs['BASH_BIN'] ?? fail('missing BASH_BIN')
  if (options.run.externalInputs['NIX_BIN'] === undefined) fail('missing NIX_BIN')
  const tests = [
    ...new Bun.Glob('nix/devenv-modules/**/*.test.sh').scanSync({ cwd: source }),
  ].toSorted()
  if (tests.length === 0) fail('devenv module source contains no test scripts')
  return runShellTestsSequential({
    bash,
    environment: options.environment,
    source,
    tests,
    timeoutMs: options.run.timeoutMs,
  })
}

const runCommand = async ({
  options,
  results,
  scratch,
}: {
  readonly options: JavaScriptRunOptions
  readonly results: string
  readonly scratch: string
}): Promise<number> => {
  const writableEnvironment = Object.fromEntries(
    await Promise.all(
      Object.entries(options.writableDirectories).map(async ([name, directory]) => {
        const target = join(scratch, 'writable', directory)
        await mkdir(target, { recursive: true })
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
    ...actionEnvironment(scratch),
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
  if (options.command === 'shell-tests') return runShellTests({ environment, run: options })
  const runtime =
    options.vitestRuntime === 'bun'
      ? options.bun
      : (options.externalInputs['NODE_BIN'] ??
        fail('vitest runtime "node" requires the declared NODE_BIN tool'))
  const command =
    options.command === 'vitest'
      ? vitestArgv({
          runtime,
          packageTree: options.packageTree,
          config: options.config ?? fail('missing config'),
          timeoutMs: options.timeoutMs,
          hookTimeoutMs: options.hookTimeoutMs,
          report: join(results, 'vitest.json'),
          tests: options.tests,
          excludes: options.excludes,
        })
      : options.command === 'vitest-collect'
        ? vitestCollectArgv({
            runtime,
            entry: join(dirname(fileURLToPath(import.meta.url)), 'vitest-collect-entry.ts'),
            packageTree: options.packageTree,
            config: options.config ?? fail('missing config'),
            report: join(results, COLLECTION_REPORT_NAME),
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

const publishCollection = async ({
  output,
  results,
}: {
  readonly output: string
  readonly results: string
}): Promise<void> => {
  const collected = Bun.file(join(results, COLLECTION_REPORT_NAME))
  if ((await collected.exists()) === false)
    fail(`vitest list wrote no ${COLLECTION_REPORT_NAME} collection artifact`)
  await mkdir(dirname(output), { recursive: true })
  await Bun.write(output, collected)
}

const runOuter = async (options: JavaScriptRunOptions): Promise<number> => {
  const inputRoots = [
    dirname(fileURLToPath(import.meta.url)),
    options.packageTree,
    ...options.readRoots,
    ...Object.values(options.externalInputs),
  ]
  const before = await hashDeclaredInputRoots(inputRoots)
  const lease = await acquireScratch(planScratch({ command: options.command, env: process.env }))
  let status = 1
  let primaryError: unknown
  try {
    status = await runCommand({ options, results: lease.results, scratch: lease.root })
    if (status === 0 && options.collectOutput !== undefined)
      await publishCollection({ output: options.collectOutput, results: lease.results })
  } catch (error) {
    primaryError = error
  }
  let invariantError: unknown
  try {
    const after = await hashDeclaredInputRoots(inputRoots)
    if (after !== before)
      invariantError = new Error(
        `javascript runner: declared inputs changed while the command was running (before ${before}, after ${after})`,
      )
  } catch (error) {
    invariantError = error
  }
  lease.release()
  if (primaryError !== undefined) console.error(primaryError)
  if (invariantError !== undefined) console.error(invariantError)
  return primaryError !== undefined || invariantError !== undefined
    ? status === 0
      ? 1
      : status
    : status
}

/**
 * Entrypoint for the runner: returns the process exit code instead of exiting, so callers and
 * tests own the exit decision. Command failures surface as a non-zero code. Argument validation
 * and scratch acquisition reject, so callers must handle both outcomes.
 */
export const runJavaScriptCli = async (args: readonly string[]): Promise<number> =>
  runOuter(parseJavaScriptRunOptions(args))

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(await runJavaScriptCli(process.argv.slice(2)))
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
    process.exit(1)
  }
}
