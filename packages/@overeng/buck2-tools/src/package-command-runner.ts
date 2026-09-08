import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export type PackageCommand = {
  readonly mode: 'exec' | 'check' | 'native-check' | 'build-dir'
  readonly runtime: string
  readonly packageTree: string
  readonly entrypoint: string
  readonly readRoots: readonly string[]
  readonly output: string | undefined
  readonly args: readonly string[]
  readonly runtimeArgs: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

const fail = (message: string): never => {
  throw new Error(`package command runner: ${message}`)
}

const requireArgument = ({
  argv,
  index,
  name,
}: {
  readonly argv: readonly string[]
  readonly index: number
  readonly name: string
}): string => argv[index] ?? fail(`missing ${name}`)

const requireMode = (value: string): PackageCommand['mode'] => {
  if (
    value === 'exec' ||
    value === 'check' ||
    value === 'native-check' ||
    value === 'build-dir'
  ) {
    return value
  }
  return fail(`unknown mode: ${value}`)
}

export const RUNTIME_ARGV_DELIMITER = '--'
export const PORTABLE_PRODUCT_PLATFORM = { abi: 'any', architecture: 'any', os: 'any' } as const

export const requireNormalizedRelativePath = ({ name, value }: { readonly name: string; readonly value: string }): string => {
  if (
    value.length === 0 ||
    isAbsolute(value) === true ||
    value.includes('\\') === true ||
    value.split('/').some((part) => part === '' || part === '.' || part === '..') === true
  ) fail(`${name} must be a normalized portable relative path: ${value}`)
  return value
}

export const parsePackageCommand = (argv: readonly string[]): PackageCommand => {
  const mode = requireMode(requireArgument({ argv, index: 0, name: 'mode' }))
  const runtime = requireArgument({ argv, index: 1, name: 'runtime' })
  const packageTree = requireArgument({ argv, index: 2, name: 'package tree' })
  const entrypoint = requireNormalizedRelativePath({
    name: 'entrypoint',
    value: requireArgument({ argv, index: 3, name: 'entrypoint' }),
  })
  const rawOutput = argv[4]
  const output = rawOutput === undefined || rawOutput === '-' ? undefined : rawOutput
  const flags = argv.slice(5)
  const args: string[] = []
  const runtimeArgs: string[] = []
  const env: Record<string, string> = {}
  const readRoots: string[] = []
  for (let index = 0; index < flags.length; index += 2) {
    const flag = flags[index]
    if (flag === RUNTIME_ARGV_DELIMITER) {
      if (mode !== 'exec') fail(`runtime arguments are only available to exec, not ${mode}`)
      runtimeArgs.push(...flags.slice(index + 1))
      break
    }
    const value = flags[index + 1] ?? fail(`missing value for ${flag ?? '<missing>'}`)
    if (flag === '--arg') args.push(value)
    else if (flag === '--read-root') {
      const root = resolve(value)
      if (value.length === 0 || root === '/') fail(`invalid declared read root: ${value}`)
      readRoots.push(root)
    } else if (flag === '--env') {
      const separator = value.indexOf('=')
      if (separator <= 0) fail(`environment entry must be NAME=value: ${value}`)
      env[value.slice(0, separator)] = value.slice(separator + 1)
    } else fail(`unknown argument: ${flag ?? '<missing>'}`)
  }
  if (mode === 'build-dir' && args.filter((arg) => arg === '{OUT}').length !== 1) {
    fail('build-dir requires exactly one {OUT} argument')
  }
  if ((mode === 'check' || mode === 'native-check' || mode === 'build-dir') && output === undefined) {
    fail(`${mode} requires an output`)
  }
  return {
    mode,
    runtime,
    packageTree,
    readRoots: [...new Set(readRoots)].toSorted(),
    entrypoint,
    output,
    args,
    runtimeArgs,
    env,
  }
}

/** One deployable product's semantic, platform-invariant identity. */
export type ProductDescriptorCommand = {
  readonly descriptor: string
  readonly moduleDescriptor: string
  readonly productKind: 'cli' | 'module'
  readonly productName: string
  readonly provenance: Readonly<Record<string, string>>
  readonly targetIdentity: string
}

export const parseProductDescriptorCommand = (argv: readonly string[]): ProductDescriptorCommand => {
  let descriptor: string | undefined
  let moduleDescriptor: string | undefined
  let productKind: 'cli' | 'module' | undefined
  let productName: string | undefined
  let targetIdentity: string | undefined
  const provenance: Record<string, string> = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1] ?? fail(`missing value for ${flag ?? '<missing>'}`)
    if (flag === '--descriptor') descriptor = value
    else if (flag === '--module-descriptor') moduleDescriptor = value
    else if (flag === '--product-kind' && (value === 'cli' || value === 'module')) productKind = value
    else if (flag === '--product-name') productName = value
    else if (flag === '--target-identity') targetIdentity = value
    else if (flag === '--provenance') {
      const separator = value.indexOf('=')
      if (separator <= 0) fail(`provenance entry must be NAME=value: ${value}`)
      provenance[value.slice(0, separator)] = value.slice(separator + 1)
    } else fail(`unknown argument: ${flag ?? '<missing>'}`)
  }
  return {
    descriptor: descriptor ?? fail('product descriptor output is missing'),
    moduleDescriptor: moduleDescriptor ?? fail('module descriptor input is missing'),
    productKind: productKind ?? fail('product kind is missing'),
    productName: productName ?? fail('product name is missing'),
    provenance,
    targetIdentity: targetIdentity ?? fail('product target identity is missing'),
  }
}

export const projectProductDescriptor = ({ command, module }: { readonly command: ProductDescriptorCommand; readonly module: Readonly<Record<string, unknown>> }): Readonly<Record<string, unknown>> => {
  if (module['schema'] !== 'effect-utils/javascript-module/v2') {
    fail(`unsupported module descriptor schema: ${String(module['schema'])}`)
  }
  if (module['productKind'] !== command.productKind) {
    fail(`module descriptor declares product kind ${String(module['productKind'])}, product declares ${command.productKind}`)
  }
  const platform = module['platform'] as Readonly<Record<string, unknown>> | undefined
  if (platform?.['os'] !== 'any' || platform['architecture'] !== 'any' || platform['abi'] !== 'any') {
    fail('module descriptor is not built for the portable JavaScript platform')
  }
  for (const [name, value] of Object.entries(command.provenance)) {
    if (value.includes('/nix/store/') === true) fail(`product provenance ${name} contains a host-specific Nix store path`)
  }
  return {
    schema: 'effect-utils/javascript-product/v2',
    productName: command.productName,
    productKind: command.productKind,
    runtimeKind: module['runtimeKind'],
    runtimeContract: module['runtimeContract'],
    runtimeContractVersion: module['runtimeContractVersion'],
    platform: PORTABLE_PRODUCT_PLATFORM,
    modulePath: module['modulePath'],
    integrity: module['integrity'],
    sizeBytes: module['sizeBytes'],
    target: command.targetIdentity,
    externalCapabilities: module['externalCapabilities'],
    externalModules: module['externalModules'],
    provenance: { ...command.provenance, module: module['target'] },
  }
}

/** Rewrites build-host CommonJS source paths to their portable ESM runtime equivalents. */
export const normalizePortableCommonJsGlobals = ({ bundle, root }: { readonly bundle: string; readonly root: string }): string => {
  const buildRoot = resolve(root)
  const validate = (name: string, serialized: string): void => {
    const sourcePath: unknown = JSON.parse(serialized)
    if (typeof sourcePath !== 'string' || (sourcePath !== buildRoot && sourcePath.startsWith(`${buildRoot}/`) === false)) {
      fail(`bundle ${name} path escapes the build root: ${String(sourcePath)}`)
    }
  }
  const combined = bundle.replace(
    /\bvar __dirname = ("(?:\\.|[^"\\])*")[,] __filename = ("(?:\\.|[^"\\])*");/g,
    (_declaration, directory: string, file: string) => {
      validate('__dirname', directory)
      validate('__filename', file)
      return 'var __dirname = import.meta.dirname, __filename = import.meta.filename;'
    },
  )
  const normalized = combined
    .replace(/\bvar __dirname = ("(?:\\.|[^"\\])*");/g, (_declaration, value: string) => {
      validate('__dirname', value)
      return 'var __dirname = import.meta.dirname;'
    })
    .replace(/\bvar __filename = ("(?:\\.|[^"\\])*");/g, (_declaration, value: string) => {
      validate('__filename', value)
      return 'var __filename = import.meta.filename;'
    })
  if (normalized.includes(buildRoot) === true) fail(`bundle records its absolute build root outside a CommonJS path declaration: ${buildRoot}`)
  return normalized
}

export type PackageLaunchPlan = {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly output: string | undefined
}

export const planPackageLaunch = ({ command }: { readonly command: PackageCommand }): PackageLaunchPlan => {
  const packageTree = resolve(command.packageTree)
  const output = command.output === undefined ? undefined : resolve(command.output)
  const args = [
    ...command.args.map((arg) => arg === '{OUT}' ? (output ?? fail('output is missing')) : arg === '{TREE}' ? packageTree : arg),
    ...command.runtimeArgs,
  ]
  return {
    argv: command.mode === 'native-check' ? [command.runtime, ...args] : [command.runtime, join(packageTree, command.entrypoint), ...args],
    cwd: packageTree,
    output,
  }
}

let child: Bun.Subprocess | undefined
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => child?.kill(signal))

const run = async (command: PackageCommand): Promise<void> => {
  const plan = planPackageLaunch({ command })
  if (command.mode === 'build-dir') await mkdir(plan.output ?? fail('build output is missing'), { recursive: true })
  child = Bun.spawn([...plan.argv], {
    cwd: plan.cwd,
    env: command.mode === 'exec' ? { ...process.env, ...command.env } : { ...command.env },
    stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
  })
  const exitCode = await child.exited
  child = undefined
  if (exitCode !== 0) fail(`${command.entrypoint} exited ${exitCode}`)
  if (command.mode === 'check' || command.mode === 'native-check') {
    await writeFile(plan.output ?? fail('verdict output is missing'), 'ok\n')
  }
}

const runProductDescriptor = async (command: ProductDescriptorCommand): Promise<void> => {
  const module = JSON.parse(readFileSync(resolve(command.moduleDescriptor), 'utf8')) as Readonly<Record<string, unknown>>
  await mkdir(dirname(resolve(command.descriptor)), { recursive: true })
  await writeFile(resolve(command.descriptor), `${JSON.stringify(projectProductDescriptor({ command, module }), undefined, 2)}\n`)
}

if (import.meta.main) {
  const argv = Bun.argv.slice(2)
  const main = argv[0] === 'product-descriptor'
    ? runProductDescriptor(parseProductDescriptorCommand(argv.slice(1)))
    : run(parsePackageCommand(argv))
  main.catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
    process.exitCode = 1
  })
}
