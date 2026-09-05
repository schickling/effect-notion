import {
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { BunPlugin } from 'bun'

/** One declared Buck artifact root a package tree's symlinks may resolve into. */
export type ClosureRoot = {
  /** Configuration-free logical name derived from the owning Buck label. */
  readonly name: string
  /** Absolute path of the declared artifact root. */
  readonly path: string
}

/** Lockfile-derived platform-gated native package families. */
export type PlatformGatedManifest = {
  readonly families: readonly {
    readonly capability: string | null
    readonly family: string
    readonly packages: readonly string[]
  }[]
  readonly packages: readonly string[]
}

/** The complete launcher configuration one `package_*` action encodes in its argv. */
export type PackageCommand = {
  readonly mode: 'exec' | 'check' | 'native-check' | 'build-dir' | 'bundle'
  readonly runtime: string
  readonly packageTree: string
  readonly entrypoint: string
  readonly output: string | undefined
  readonly args: readonly string[]
  readonly runtimeArgs: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly external: readonly string[]
  readonly descriptor: string | undefined
  readonly closureIdentity: string | undefined
  readonly closureRoots: readonly ClosureRoot[]
  readonly externalCapabilities: readonly string[]
  readonly platformGatedManifest: string | undefined
  readonly runtimeContract: string
  readonly runtimeContractVersion: string
  readonly targetIdentity: string | undefined
  readonly target: 'bun' | 'node'
  readonly kind: 'cli' | 'module'
}

const fail: (message: string) => never = (message) => {
  throw new Error(`package command runner: ${message}`)
}

/**
 * Separates the launcher's encoded configuration from the launched program's
 * own argv. `package_bin` emits it as the last element of its `RunInfo`, so
 * every argument Buck appends after `buck2 run <target> --` reaches the
 * entrypoint verbatim instead of being parsed as launcher configuration.
 */
export const RUNTIME_ARGV_DELIMITER = '--'

/** The one portable JavaScript product platform every bundle is built for. */
export const PORTABLE_PRODUCT_PLATFORM = {
  abi: 'any',
  architecture: 'any',
  os: 'any',
} as const

/**
 * Requires one path to stay inside its declared package tree.
 *
 * A launcher path must be relative, forward-slashed, and free of `.`/`..`
 * segments, so the same argv names the same file on every host.
 */
export const requireNormalizedRelativePath = ({
  name,
  value,
}: {
  readonly name: string
  readonly value: string
}): string => {
  if (
    value.length === 0 ||
    isAbsolute(value) === true ||
    value.includes('\\') === true ||
    value.split('/').some((part) => part === '' || part === '.' || part === '..') === true
  ) {
    fail(`${name} must be a normalized portable relative path: ${value}`)
  }
  return value
}

/**
 * Splits one `--closure-root` token.
 *
 * The logical name and the artifact path travel as a single argv token
 * separated by a tab, so the launcher's strict flag/value pairing stays intact
 * and neither half can be mistaken for a flag. The path is whatever Buck wrote
 * for the artifact — project-relative in a local action — and is resolved
 * against the action's working directory.
 */
const parseClosureRoot = (value: string): ClosureRoot => {
  const separator = value.indexOf('\t')
  if (separator <= 0) fail(`closure root must be <name>\\t<path>: ${value}`)
  const name = value.slice(0, separator)
  const path = value.slice(separator + 1)
  if (path.length === 0) fail(`closure root path must not be empty: ${value}`)
  requireNormalizedRelativePath({ name: 'closure root name', value: name })
  return { name, path }
}

/** Parses the fail-closed launcher command contract emitted by `buck2/package_tools.bzl`. */
export const parsePackageCommand = (argv: readonly string[]): PackageCommand => {
  const [rawMode, runtime, packageTree, rawEntrypoint, rawOutput, ...flags] = argv
  if (
    rawMode !== 'exec' &&
    rawMode !== 'check' &&
    rawMode !== 'native-check' &&
    rawMode !== 'build-dir' &&
    rawMode !== 'bundle'
  ) {
    fail(`unknown mode: ${rawMode ?? '<missing>'}`)
  }
  if (runtime === undefined || packageTree === undefined || rawEntrypoint === undefined) {
    fail('missing runtime, package tree, or entrypoint')
  }
  const entrypoint = requireNormalizedRelativePath({ name: 'entrypoint', value: rawEntrypoint })
  const output = rawOutput === undefined || rawOutput === '-' ? undefined : rawOutput
  const args: string[] = []
  const runtimeArgs: string[] = []
  const env: Record<string, string> = {}
  const external: string[] = []
  const externalCapabilities: string[] = []
  const closureRoots: ClosureRoot[] = []
  let descriptor: string | undefined
  let closureIdentity: string | undefined
  let platformGatedManifest: string | undefined
  let targetIdentity: string | undefined
  let runtimeContract = 'javascript-esm'
  let runtimeContractVersion = 'v1'
  let target: 'bun' | 'node' = 'bun'
  let kind: 'cli' | 'module' = 'module'
  for (let index = 0; index < flags.length; index += 2) {
    const flag = flags[index]
    // `RUNTIME_ARGV_DELIMITER` ends the launcher's own encoded configuration:
    // `buck2 run <target> -- ...` appends its trailing arguments verbatim to
    // this RunInfo, and those belong to the launched entrypoint. Without the
    // delimiter a flag-shaped runtime argument such as `--repo-root` would be
    // read as launcher configuration and the launch would fail before the
    // entrypoint ever started.
    if (flag === RUNTIME_ARGV_DELIMITER) {
      if (rawMode !== 'exec') fail(`runtime arguments are only available to exec, not ${rawMode}`)
      runtimeArgs.push(...flags.slice(index + 1))
      break
    }
    const value = flags[index + 1] ?? fail(`missing value for ${flag ?? '<missing>'}`)
    if (flag === '--arg') args.push(value)
    else if (flag === '--env') {
      const separator = value.indexOf('=')
      if (separator <= 0) fail(`environment entry must be NAME=value: ${value}`)
      env[value.slice(0, separator)] = value.slice(separator + 1)
    } else if (flag === '--external') external.push(value)
    else if (flag === '--external-capability') externalCapabilities.push(value)
    else if (flag === '--closure-root') closureRoots.push(parseClosureRoot(value))
    else if (flag === '--platform-gated-manifest') platformGatedManifest = value
    else if (flag === '--target-identity') targetIdentity = value
    else if (flag === '--runtime-contract') runtimeContract = value
    else if (flag === '--runtime-contract-version') runtimeContractVersion = value
    else if (flag === '--descriptor') descriptor = value
    else if (flag === '--closure-identity') closureIdentity = value
    else if (flag === '--target' && (value === 'bun' || value === 'node')) target = value
    else if (flag === '--kind' && (value === 'cli' || value === 'module')) kind = value
    else fail(`unknown argument: ${flag ?? '<missing>'}`)
  }
  if (rawMode === 'build-dir' && args.filter((arg) => arg === '{OUT}').length !== 1) {
    fail('build-dir requires exactly one {OUT} argument')
  }
  if (
    (rawMode === 'check' ||
      rawMode === 'native-check' ||
      rawMode === 'build-dir' ||
      rawMode === 'bundle') &&
    output === undefined
  ) {
    fail(`${rawMode} requires an output`)
  }
  if (rawMode === 'bundle' && (targetIdentity === undefined || targetIdentity.length === 0)) {
    fail('bundle requires the producing target identity')
  }
  return {
    mode: rawMode,
    runtime,
    packageTree,
    entrypoint,
    output,
    args,
    runtimeArgs,
    env,
    target,
    kind,
    external,
    descriptor,
    closureIdentity,
    closureRoots,
    externalCapabilities,
    platformGatedManifest,
    runtimeContract,
    runtimeContractVersion,
    targetIdentity,
  }
}

let child: Bun.Subprocess | undefined

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => child?.kill(signal))
}

// ---------------------------------------------------------------------------
// Realpath-closed hardlink farm
//
// A Buck package tree is a symlink view: its `node_modules` is one declared
// hop into a separate dependency-view artifact, and every store entry inside
// that view is reached through another relative symlink. Bun resolves a module
// to its REALPATH and then writes that path — relative to the build process's
// working directory — into the bundle as a `// <path>` module comment. Built
// straight from the view, those comments therefore carry the producer's
// buck-out layout and configured-platform hash, so the same sources produce
// different bytes on a different host or platform.
//
// The farm removes the cause instead of rewriting the symptom. Every real file
// reachable through the view is hardlinked (never copied) into one root, and
// every symlink is rewritten to a relative link whose realpath stays inside
// that root, keyed by the owning Buck label rather than by any absolute path.
// Building with the farm as the working directory then makes every module
// comment a farm-relative, configuration-free path.
// ---------------------------------------------------------------------------

type FarmMapping = {
  readonly farmRoot: string
  materialized: boolean
  readonly realRoot: string
}

type Farm = {
  readonly gated: ReadonlySet<string>
  readonly mappings: FarmMapping[]
  readonly root: string
}

const hardlink = ({
  destination,
  source,
}: {
  readonly destination: string
  readonly source: string
}): void => {
  try {
    linkSync(source, destination)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EXDEV') {
      fail(
        `portable farm requires one filesystem: ${source} and ${destination} are on different devices, and a product is never assembled by copying bytes`,
      )
    }
    throw error
  }
}

/**
 * Whether one `node_modules` child names a platform-gated package.
 *
 * The gate is positional: only a direct child of a `node_modules` directory
 * (or of a scope directory inside one) can be a package, so an ordinary source
 * file that happens to share a package's name is never dropped.
 */
const gatedPackageName = ({
  directory,
  entry,
}: {
  readonly directory: string
  readonly entry: string
}): string | undefined => {
  const parent = basename(directory)
  if (parent === 'node_modules') return entry.startsWith('@') === true ? undefined : entry
  if (parent.startsWith('@') === true && basename(dirname(directory)) === 'node_modules') {
    return `${parent}/${entry}`
  }
  return undefined
}

const farmPathFor = ({ farm, real }: { readonly farm: Farm; readonly real: string }): string => {
  let best: FarmMapping | undefined
  for (const mapping of farm.mappings) {
    if (real !== mapping.realRoot && real.startsWith(`${mapping.realRoot}${sep}`) === false)
      continue
    if (best === undefined || mapping.realRoot.length > best.realRoot.length) best = mapping
  }
  // Fail closed, always. A target outside every declared closure root is a
  // host fact — a Nix store realization included, since its path is chosen by
  // the producing platform — and a portable product's bytes may not depend on
  // one. A genuinely needed native runtime dependency is either externalized
  // behind an exact declared capability or declared as a closure root whose
  // cross-host equality is proven.
  if (best === undefined) {
    fail(
      `symlink target escapes every declared closure root: ${real}; declare the artifact that owns it, or externalize it behind a declared capability`,
    )
  }
  materializeMapping({ farm, mapping: best })
  const suffix = relative(best.realRoot, real)
  return suffix.length === 0 ? best.farmRoot : join(best.farmRoot, suffix)
}

const imageSymlink = ({
  destination,
  farm,
  source,
}: {
  readonly destination: string
  readonly farm: Farm
  readonly source: string
}): void => {
  let real: string
  try {
    real = realpathSync(source)
  } catch (error) {
    fail(`package tree symlink is dangling: ${source} (${String(error)})`)
  }
  const target = farmPathFor({ farm, real })
  symlinkSync(relative(dirname(destination), target), destination)
}

const imageDirectory = ({
  destination,
  farm,
  source,
}: {
  readonly destination: string
  readonly farm: Farm
  readonly source: string
}): void => {
  mkdirSync(destination, { recursive: true })
  for (const entry of readdirSync(source).toSorted()) {
    const gated = gatedPackageName({ directory: source, entry })
    // A platform-gated optional package is reachable only through runtime
    // platform dispatch, so leaving it out of the farm is what keeps a
    // host-native binding from being inlined into a portable product.
    if (gated !== undefined && farm.gated.has(gated) === true) continue
    const child = join(source, entry)
    const target = join(destination, entry)
    // Link identity comes from `lstat` alone. Comparing a path against its
    // realpath would misread an already-canonical path on a host whose
    // temporary directory is itself a symlink (Darwin's `/tmp`).
    const metadata = lstatSync(child)
    if (metadata.isSymbolicLink() === true) {
      imageSymlink({ destination: target, farm, source: child })
      continue
    }
    if (metadata.isDirectory() === true) {
      imageDirectory({ destination: target, farm, source: child })
      continue
    }
    if (metadata.isFile() === false) {
      fail(`portable farm does not support filesystem entry: ${child}`)
    }
    hardlink({ destination: target, source: child })
  }
}

const materializeMapping = ({
  farm,
  mapping,
}: {
  readonly farm: Farm
  readonly mapping: FarmMapping
}): void => {
  if (mapping.materialized === true) return
  // Marked before recursing: a dependency cycle between two store entries
  // links back into a root that is still being imaged, and the farm answers
  // with the in-progress location instead of expanding forever.
  mapping.materialized = true
  imageDirectory({ destination: mapping.farmRoot, farm, source: mapping.realRoot })
}

/**
 * Assembles one realpath-closed hardlink farm for a package tree.
 *
 * Declared closure roots are materialized on demand and keyed by their
 * configuration-free logical name, so the farm layout — and therefore the
 * module paths a bundle records — depends only on the declared graph.
 */
export const assemblePortableFarm = ({
  closureRoots,
  gatedPackages,
  packageTree,
  root,
}: {
  readonly closureRoots: readonly ClosureRoot[]
  readonly gatedPackages: readonly string[]
  readonly packageTree: string
  readonly root: string
}): string => {
  const farmRoot = resolve(root)
  rmSync(farmRoot, { force: true, recursive: true })
  const treeRoot: FarmMapping = {
    farmRoot,
    materialized: false,
    realRoot: realpathSync(packageTree),
  }
  const seen = new Set<string>()
  const farm: Farm = {
    gated: new Set(gatedPackages),
    mappings: [treeRoot],
    root: farmRoot,
  }
  for (const closureRoot of closureRoots.toSorted((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    if (seen.has(closureRoot.name) === true) {
      fail(`duplicate closure root name: ${closureRoot.name}`)
    }
    seen.add(closureRoot.name)
    farm.mappings.push({
      farmRoot: join(farmRoot, '.closure', closureRoot.name),
      materialized: false,
      realRoot: realpathSync(closureRoot.path),
    })
  }
  materializeMapping({ farm, mapping: treeRoot })
  return farmRoot
}

/** Reads the lockfile-derived platform-gated package manifest. */
export const readPlatformGatedManifest = (path: string): PlatformGatedManifest => {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
    readonly schema?: unknown
    readonly families?: unknown
    readonly packages?: unknown
  }
  if (parsed.schema !== 'effect-utils/pnpm-platform-gated-packages/v1') {
    fail(`unsupported platform-gated manifest schema: ${String(parsed.schema)}`)
  }
  if (Array.isArray(parsed.families) === false || Array.isArray(parsed.packages) === false) {
    fail('platform-gated manifest must declare families and packages')
  }
  return parsed as unknown as PlatformGatedManifest
}

const BARE_SPECIFIER_PACKAGE = /^(@[^/]+\/[^/]+|[^@/][^/]*)/

/** Bun exposes its own bare builtin through `node:module`. */
const NODE_BUILTINS: ReadonlySet<string> = new Set(builtinModules.filter((name) => name !== 'bun'))

/**
 * The npm package a bare import specifier names, for one runtime target.
 *
 * Returns `undefined` for anything the host is not asked to install: a
 * relative or absolute path, a prefixed specifier such as `node:fs`, and a
 * builtin OF THAT TARGET. The target matters: `bun` is a builtin to Bun and an
 * unresolvable npm package to node, so recognizing it unconditionally would
 * let a node product ship an import that fails only when a user runs it.
 */
export const bareSpecifierPackage = ({
  specifier,
  target,
}: {
  readonly specifier: string
  readonly target: 'bun' | 'node'
}): string | undefined => {
  if (
    specifier.length === 0 ||
    specifier.startsWith('.') === true ||
    specifier.startsWith('/') === true ||
    specifier.includes(':') === true ||
    NODE_BUILTINS.has(specifier) === true ||
    (target === 'bun' && specifier === 'bun')
  ) {
    return undefined
  }
  return BARE_SPECIFIER_PACKAGE.exec(specifier)?.[1]
}

const REQUIRE_CALL = /\b__?require\(\s*["']([^"']+)["']\s*\)/g

/**
 * Every module specifier a built bundle still asks its host to provide.
 *
 * `scanImports` sees the static `import`/`export ... from` forms; a bundle
 * targeting node also reaches an external through Bun's `__require` shim, and
 * an import the scanner cannot see is exactly the one that would fail only at
 * runtime, so both forms are collected.
 */
export const bundleImportSpecifiers = (bundle: string): readonly string[] => {
  const specifiers = new Set(
    new Bun.Transpiler({ loader: 'js' }).scanImports(bundle).map((entry) => entry.path),
  )
  for (const match of bundle.matchAll(REQUIRE_CALL)) {
    const specifier = match[1]
    if (specifier !== undefined) specifiers.add(specifier)
  }
  return [...specifiers]
}

/**
 * Verifies that the bundle's surviving bare imports are exactly what the
 * product declared, and reports the capabilities they require.
 *
 * A product's external surface is the one part of a bundle that is not proven
 * by its own bytes: an unresolved import fails at runtime, on the user's
 * machine, in whichever code path first reaches it. Deriving the set from the
 * emitted bundle and gating it against the declared set turns that class of
 * silent failure into a build failure.
 */
export const verifyExternalSurface = ({
  allowed,
  declaredCapabilities,
  gatedManifest,
  specifiers,
  target,
}: {
  readonly allowed: readonly string[]
  readonly declaredCapabilities: readonly string[]
  readonly gatedManifest: PlatformGatedManifest
  readonly specifiers: readonly string[]
  readonly target: 'bun' | 'node'
}): { readonly capabilities: readonly string[]; readonly modules: readonly string[] } => {
  const allowedSet = new Set(allowed)
  const modules = [
    ...new Set(
      specifiers.flatMap((specifier) => {
        const name = bareSpecifierPackage({ specifier, target })
        return name === undefined ? [] : [name]
      }),
    ),
  ].toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0))
  const undeclared = modules.filter((name) => allowedSet.has(name) === false)
  if (undeclared.length > 0) {
    fail(
      `bundle leaves undeclared bare imports external: ${undeclared.join(', ')}; declare them or keep them resolvable`,
    )
  }
  // The capability set for the gated families is EXACT, in both directions.
  // A missing declaration breaks the product on the user's machine; a surplus
  // one silently grants a native closure the product never reaches, and the
  // next reader cannot tell which of the two a declaration is.
  const derived = new Set<string>()
  const required = new Set<string>()
  for (const family of gatedManifest.families) {
    if (family.capability === null) continue
    derived.add(family.capability)
    if (modules.some((name) => family.packages.includes(name)) === false) continue
    required.add(family.capability)
  }
  const declared = new Set(declaredCapabilities)
  for (const capability of [...required].toSorted()) {
    if (declared.has(capability) === false) {
      fail(
        `bundle depends on host-provided ${capability} but the product does not declare that external capability`,
      )
    }
  }
  // Only capabilities this manifest derives are audited here. A capability of
  // any other kind — a host tool such as `git` or `oxfmt` — names something no
  // import can witness, so it is carried through untouched.
  for (const capability of [...declared].toSorted()) {
    if (derived.has(capability) === true && required.has(capability) === false) {
      fail(
        `product declares the native external capability ${capability}, but no bare import in the bundle requires it; remove the declaration`,
      )
    }
  }
  return {
    capabilities: [...declaredCapabilities].toSorted((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
    modules,
  }
}

const LOADERS: Readonly<Record<string, 'js' | 'jsx' | 'ts' | 'tsx'>> = {
  '.cjs': 'js',
  '.cts': 'ts',
  '.js': 'js',
  '.jsx': 'jsx',
  '.mjs': 'js',
  '.mts': 'ts',
  '.ts': 'ts',
  '.tsx': 'tsx',
}

/**
 * Replaces the CLI entry's `import.meta.main` guard during the build itself.
 *
 * Bun lowers `import.meta.main` to `__require.main == __require.module`, which
 * is unbound in an ESM bundle, so a node CLI bundle crashes with `__require is
 * not defined`. `Bun.build`'s `define` is global and would flip the guard in
 * every bundled module, and a scratch copy of the entry would move the entry
 * off the farm and put a foreign path back into the bundle. An `onLoad` hook
 * substitutes exactly one module in place, and — unlike a virtual file — it can
 * be counted, so a predicate that silently stops matching becomes a build
 * failure instead of a broken CLI.
 */
export const createEntryOverridePlugin = ({
  entry,
  onOverride,
}: {
  readonly entry: string
  readonly onOverride: () => void
}): BunPlugin => {
  // Canonicalized once, unconditionally, on every host: `realpathSync` is the
  // only comparison that survives a host whose build root is reached through a
  // symlink (Darwin resolves `/tmp` to `/private/tmp`), and Bun reports the
  // canonical path in `args.path`.
  const expected = realpathSync(entry)
  const loader =
    LOADERS[expected.slice(expected.lastIndexOf('.'))] ??
    fail(`unsupported entry extension: ${expected}`)
  return {
    name: 'portable-cli-entry',
    setup(build) {
      build.onLoad({ filter: /\.(?:c|m)?[jt]sx?$/ }, (args) => {
        let candidate: string
        try {
          candidate = realpathSync(args.path)
        } catch {
          return undefined
        }
        if (candidate !== expected) return undefined
        onOverride()
        // A hook's contents bypass Bun's own entry-file shebang handling, so
        // the interpreter line is blanked here (not deleted) to keep every
        // later line at its original number in a diagnostic.
        return {
          contents: readFileSync(expected, 'utf8')
            .replace(/^#![^\n]*/, '')
            .replaceAll('import.meta.main', 'true'),
          loader,
        }
      })
    },
  }
}

/**
 * Fails when a bundle's recorded module paths are not portable.
 *
 * Bun writes one `// <path>` comment per bundled module. A path that leaves the
 * build root is a host path, and a product carrying one is not the same
 * artifact on another machine, so the closure claim is checked against the
 * emitted bytes rather than assumed from how the farm was built.
 */
export const assertPortableModuleComments = (bundle: string): void => {
  const absolute: string[] = []
  const escaping: string[] = []
  for (const line of bundle.split('\n')) {
    if (line.startsWith('// /') === true) absolute.push(line)
    else if (line.startsWith('// ../') === true) escaping.push(line)
  }
  if (absolute.length > 0) {
    fail(`bundle records absolute module paths: ${absolute.slice(0, 5).join(' ')}`)
  }
  if (escaping.length > 0) {
    fail(`bundle records module paths outside the build root: ${escaping.slice(0, 5).join(' ')}`)
  }
}

/** Fails when a CLI bundle kept Bun's unbound `import.meta.main` lowering. */
export const assertNoUnboundRequireMain = (bundle: string): void => {
  if (bundle.includes('__require.main') === true) {
    fail('CLI bundle retains `__require.main`, which is unbound in an ESM bundle')
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

/** Parses the product-descriptor projection command emitted by `buck2/products.bzl`. */
export const parseProductDescriptorCommand = (
  argv: readonly string[],
): ProductDescriptorCommand => {
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
    else if (flag === '--product-kind' && (value === 'cli' || value === 'module')) {
      productKind = value
    } else if (flag === '--product-name') productName = value
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

/**
 * Projects one module descriptor into its product descriptor.
 *
 * The projection runs as an action rather than in analysis because a product's
 * identity includes its integrity and size, which exist only once the bytes
 * do.
 */
export const projectProductDescriptor = ({
  command,
  module,
}: {
  readonly command: ProductDescriptorCommand
  readonly module: Readonly<Record<string, unknown>>
}): Readonly<Record<string, unknown>> => {
  if (module['schema'] !== 'effect-utils/javascript-module/v2') {
    fail(`unsupported module descriptor schema: ${String(module['schema'])}`)
  }
  if (module['productKind'] !== command.productKind) {
    fail(
      `module descriptor declares product kind ${String(module['productKind'])}, product declares ${command.productKind}`,
    )
  }
  const platform = module['platform'] as Readonly<Record<string, unknown>> | undefined
  if (
    platform?.['os'] !== PORTABLE_PRODUCT_PLATFORM.os ||
    platform['architecture'] !== PORTABLE_PRODUCT_PLATFORM.architecture ||
    platform['abi'] !== PORTABLE_PRODUCT_PLATFORM.abi
  ) {
    fail('module descriptor is not built for the portable JavaScript platform')
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

const runBundle = async (command: PackageCommand): Promise<void> => {
  const output = resolve(command.output ?? fail('bundle output is missing'))
  const descriptorPath = resolve(command.descriptor ?? fail('bundle descriptor is missing'))
  const packageTree = resolve(command.packageTree)
  await mkdir(dirname(output), { recursive: true })
  const scratch = resolve(process.env['BUCK_SCRATCH_PATH'] ?? tmpdir())
  mkdirSync(scratch, { recursive: true })
  const gatedManifest =
    command.platformGatedManifest === undefined
      ? { families: [], packages: [] }
      : readPlatformGatedManifest(resolve(command.platformGatedManifest))
  const farm = assemblePortableFarm({
    closureRoots: command.closureRoots.map((root) => ({
      name: root.name,
      path: resolve(root.path),
    })),
    gatedPackages: gatedManifest.packages,
    packageTree,
    root: join(scratch, 'portable-farm'),
  })
  const entry = realpathSync(join(farm, command.entrypoint))
  const external = [...new Set([...command.external, ...gatedManifest.packages])].toSorted(
    (left, right) => (left < right ? -1 : left > right ? 1 : 0),
  )
  let overrides = 0
  const plugins =
    command.kind === 'cli'
      ? [createEntryOverridePlugin({ entry, onOverride: () => (overrides += 1) })]
      : []
  // Bun writes module comments relative to the process working directory, so
  // the farm becomes that directory. One build per process: the working
  // directory is process-global state, and a second build would race it.
  process.chdir(farm)
  const result = await Bun.build({
    throw: false,
    entrypoints: [entry],
    external,
    minify: false,
    naming: basename(output),
    outdir: dirname(output),
    plugins,
    root: farm,
    sourcemap: 'none',
    target: command.target,
  })
  if (result.success === false) fail(result.logs.map(String).join('\n'))
  if (command.kind === 'cli' && overrides !== 1) {
    fail(
      `CLI entry override fired ${overrides} time(s) instead of exactly once for ${command.entrypoint}`,
    )
  }
  const built = result.outputs[0]?.path ?? fail('bundle produced no output')
  if (resolve(built) !== output) await copyFile(built, output)
  const bytes = await Bun.file(output).arrayBuffer()
  const text = new TextDecoder().decode(bytes)
  assertPortableModuleComments(text)
  if (command.kind === 'cli') assertNoUnboundRequireMain(text)
  const surface = verifyExternalSurface({
    allowed: external,
    declaredCapabilities: command.externalCapabilities,
    gatedManifest,
    specifiers: bundleImportSpecifiers(text),
    target: command.target,
  })
  const digest = new Bun.CryptoHasher('sha256').update(bytes).digest('base64')
  rmSync(farm, { force: true, recursive: true })
  await writeFile(
    descriptorPath,
    `${JSON.stringify(
      {
        schema: 'effect-utils/javascript-module/v2',
        productKind: command.kind,
        runtimeKind: command.target,
        runtimeContract: command.runtimeContract,
        runtimeContractVersion: command.runtimeContractVersion,
        platform: PORTABLE_PRODUCT_PLATFORM,
        modulePath: basename(output),
        integrity: `sha256-${digest}`,
        sizeBytes: bytes.byteLength,
        target: command.targetIdentity ?? fail('bundle target identity is missing'),
        externalCapabilities: surface.capabilities,
        externalModules: surface.modules,
        // Provenance only: never compared by a consumer, because the producer's
        // store paths and configured target are host facts, not product identity.
        provenance: {
          dependencyClosureIdentity:
            command.closureIdentity ?? fail('bundle closure identity is missing'),
        },
      },
      undefined,
      2,
    )}\n`,
  )
}

const run = async (command: PackageCommand): Promise<void> => {
  if (command.mode === 'bundle') return runBundle(command)

  const output = command.output
  if (command.mode === 'build-dir')
    await mkdir(output ?? fail('build output is missing'), { recursive: true })
  // Declared arguments carry the build placeholders; runtime arguments come
  // from the caller's own command line and reach the entrypoint unchanged.
  const args = [
    ...command.args.map((arg) =>
      arg === '{OUT}'
        ? (output ?? fail('output is missing'))
        : arg === '{TREE}'
          ? command.packageTree
          : arg,
    ),
    ...command.runtimeArgs,
  ]
  child = Bun.spawn(
    command.mode === 'native-check'
      ? [command.runtime, ...args]
      : [command.runtime, join(command.packageTree, command.entrypoint), ...args],
    {
      cwd: command.packageTree,
      env: command.mode === 'exec' ? { ...process.env, ...command.env } : { ...command.env },
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    },
  )
  const exitCode = await child.exited
  child = undefined
  if (exitCode !== 0) fail(`${command.entrypoint} exited ${exitCode}`)
  if (command.mode === 'check' || command.mode === 'native-check') {
    await writeFile(output ?? fail('verdict output is missing'), 'ok\n')
  }
}

const runProductDescriptor = async (command: ProductDescriptorCommand): Promise<void> => {
  const module = JSON.parse(readFileSync(resolve(command.moduleDescriptor), 'utf8')) as Readonly<
    Record<string, unknown>
  >
  await mkdir(dirname(resolve(command.descriptor)), { recursive: true })
  await writeFile(
    resolve(command.descriptor),
    `${JSON.stringify(projectProductDescriptor({ command, module }), undefined, 2)}\n`,
  )
}

if (import.meta.main) {
  const argv = Bun.argv.slice(2)
  const main =
    argv[0] === 'product-descriptor'
      ? runProductDescriptor(parseProductDescriptorCommand(argv.slice(1)))
      : run(parsePackageCommand(argv))
  main.catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
    process.exitCode = 1
  })
}
