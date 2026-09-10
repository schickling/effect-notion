import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

import { buck2SemanticFingerprint } from '../../../genie/buck2/mod.ts'
import {
  createGenieOutput,
  type GenieOutput,
} from '../../../packages/@overeng/genie/src/runtime/core.ts'
import {
  defineRepoContext,
  modulePathFromUrl,
} from '../../../packages/@overeng/genie/src/runtime/repo-context/mod.ts'
import otelScrapeManifest from '../../../packages/@overeng/otel-scrape/Cargo.toml' with { type: 'toml' }
import oteliteManifest from '../../../packages/@overeng/otelite/Cargo.toml' with { type: 'toml' }
import cargoLock from '../../Cargo.lock' with { type: 'toml' }
import cargoWorkspace from '../../Cargo.toml' with { type: 'toml' }
import archiveToolManifest from '../archive-tool/Cargo.toml' with { type: 'toml' }
import productManifest from '../product/Cargo.toml' with { type: 'toml' }
import coreManifest from './Cargo.toml' with { type: 'toml' }

/**
 * Every path this projector reads is repository-relative, and the reader is not always the
 * repository: `bootstrap:cold-proof` runs the Buck-built Genie product, whose working
 * directory is the composed workspace root while the tree under generation is a separate
 * install-free export. The repo context anchors reads at the repository that owns this
 * module — the compiled product pins each staged module's `import.meta` to its original
 * source location, so this identity survives import staging — and the census is therefore
 * identical from any working directory.
 */
const repo = defineRepoContext({ name: 'effect-utils', importMetaUrl: import.meta.url })

/**
 * Projects one Cargo workspace member into its generated first-party Buck package.
 */
export const cargoBuck2PackageProjection = ({
  buildProduct = false,
  sourceUrl,
}: {
  readonly buildProduct?: boolean
  readonly sourceUrl: string
}): GenieOutput<unknown> => {
  const projectionSource = path
    .relative(repo.rootPath, modulePathFromUrl(sourceUrl))
    .replaceAll('\\', '/')
  if (path.posix.basename(projectionSource) !== 'BUCK.genie.ts') {
    throw new Error(`Cargo Buck projection source must be BUCK.genie.ts: ${projectionSource}`)
  }
  const packagePath = path.posix.dirname(projectionSource)
  const member = memberByPath.get(packagePath)
  if (member === undefined)
    throw new Error(`Buck projection source is not a Cargo workspace member: ${packagePath}`)
  const manifest = member.manifest
  const packageMetadata = requireValue({
    value: manifest.package,
    field: `${member.manifestPath} package`,
  })
  if (
    path.posix.normalize(path.posix.join(packagePath, packageMetadata.workspace ?? '')) !== 'rust'
  ) {
    throw new Error(`Cargo package ${packagePath} does not resolve workspace to rust/Cargo.toml`)
  }
  if (
    packageMetadata.version === undefined ||
    typeof packageMetadata.version === 'string' ||
    packageMetadata.version.workspace !== true
  ) {
    throw new Error(`Cargo package ${packagePath} must inherit workspace.package.version`)
  }
  if (
    packageMetadata.edition === undefined ||
    typeof packageMetadata.edition === 'string' ||
    packageMetadata.edition.workspace !== true
  ) {
    throw new Error(`Cargo package ${packagePath} must inherit workspace.package.edition`)
  }
  if (
    packageMetadata.autobins !== undefined ||
    packageMetadata.autolib !== undefined ||
    packageMetadata.autotests !== undefined
  ) {
    throw new Error(`Cargo automatic target overrides are unsupported in ${member.manifestPath}`)
  }
  if (
    (packageMetadata.build !== undefined && packageMetadata.build !== false) ||
    existsSync(repo.resolve(packagePath, 'build.rs')) === true
  ) {
    throw new Error(`Cargo build scripts are unsupported in ${member.manifestPath}`)
  }
  if (manifest['build-dependencies'] !== undefined) {
    throw new Error(`Cargo build dependencies are unsupported in ${member.manifestPath}`)
  }
  if (
    (manifest.test?.length ?? 0) > 0 ||
    (manifest.bench?.length ?? 0) > 0 ||
    (manifest.example?.length ?? 0) > 0
  ) {
    throw new Error(
      `Explicit Cargo test, bench, and example targets are unsupported in ${member.manifestPath}`,
    )
  }
  if (Object.keys(manifest.features ?? {}).length > 0) {
    throw new Error(`Package-defined Cargo features are unsupported in ${member.manifestPath}`)
  }

  const packageName = requireValue({
    value: packageMetadata.name,
    field: `${member.manifestPath} package.name`,
  })
  const version = requireValue({
    value: workspace.package?.version,
    field: 'workspace.package.version',
  })
  const edition = requireValue({
    value: workspace.package?.edition,
    field: 'workspace.package.edition',
  })
  const normalDependencies = resolveDependencyTable({
    member,
    dependencies: manifest.dependencies,
    field: 'dependencies',
  })
  const devDependencies = resolveDependencyTable({
    member,
    dependencies: manifest['dev-dependencies'],
    field: 'dev-dependencies',
  })
  const conditionalNormalDependencies = resolveConditionalDependencies({
    member,
    target: manifest.target,
    kind: 'dependencies',
  })
  const conditionalDevDependencies = resolveConditionalDependencies({
    member,
    target: manifest.target,
    kind: 'dev-dependencies',
  })
  const unresolvedProductionDependencies = [
    ...normalDependencies,
    ...conditionalNormalDependencies.map((entry) => entry.dependency),
  ].filter((dependency) => dependency.targetAvailable === false)
  if (unresolvedProductionDependencies.length > 0) {
    throw new Error(
      `rust/third-party/BUCK is missing production targets: ${sorted(
        unresolvedProductionDependencies.map((dependency) => dependency.name),
      ).join(', ')}`,
    )
  }
  const sources = discoverRustSources({ packagePath })
  const sourceSet = new Set(sources)

  const library = manifest.lib
  if (library?.['proc-macro'] === true || library?.['crate-type'] !== undefined) {
    throw new Error(
      `Cargo proc-macro and crate-type library semantics are unsupported in ${member.manifestPath}`,
    )
  }
  const libraryName = library?.name
  const libraryPath = library?.path
  if ((libraryName === undefined) !== (libraryPath === undefined)) {
    throw new Error(
      `Cargo library name and path must be explicit together in ${member.manifestPath}`,
    )
  }
  if (libraryPath !== undefined && sourceSet.has(libraryPath) === false) {
    throw new Error(`Cargo library path is not a discovered Rust source: ${libraryPath}`)
  }

  const binaries = (manifest.bin ?? []).map((binary, index) => {
    if ((binary['required-features']?.length ?? 0) > 0) {
      throw new Error(`Cargo binary required-features are unsupported at bin[${index}]`)
    }
    const name = requireValue({ value: binary.name, field: `bin[${index}].name` })
    const crateRoot = requireValue({ value: binary.path, field: `bin[${index}].path` })
    if (sourceSet.has(crateRoot) === false) {
      throw new Error(`Cargo binary path is not a discovered Rust source: ${crateRoot}`)
    }
    return { crateRoot, name }
  })
  if (library === undefined && binaries.length === 0) {
    throw new Error(`Cargo package ${packagePath} has no explicit library or binary target`)
  }
  if (new Set(binaries.map((binary) => binary.name)).size !== binaries.length) {
    throw new Error(`Cargo package ${packagePath} has duplicate binary names`)
  }

  const binaryRoots = new Set(binaries.map((binary) => binary.crateRoot))
  const srcSources = sources.filter((source) => source.startsWith('src/'))
  const librarySources = srcSources.filter((source) => binaryRoots.has(source) === false)
  const integrationTestRoots = sources.filter(
    (source) =>
      source.startsWith('tests/') && source.slice('tests/'.length).includes('/') === false,
  )
  const normalLabels = normalDependencies.map((dependency) => dependency.label)
  const compileEnv = {
    CARGO_PKG_NAME: packageName,
    CARGO_PKG_VERSION: version,
  }

  const semanticInputPaths = sorted([
    'genie/buck2/mod.ts',
    'rust/buck2-tools/core/cargo-buck2-package-projection.ts',
    'rust/Cargo.toml',
    'rust/Cargo.lock',
    'rust/reindeer.toml',
    'rust/third-party/BUCK',
    ...workspaceMembers.map((workspaceMember) => workspaceMember.manifestPath),
    projectionSource,
    `${packagePath}/src/**/*.rs`,
    `${packagePath}/tests/**/*.rs`,
  ])
  const graphFingerprints = Object.fromEntries(
    semanticInputPaths
      .filter((input) => input.endsWith('/**/*.rs') === false && input.endsWith('.ts') === false)
      .map((input) => [input, sha256(repo.readText(input))]),
  )
  const semanticData = {
    binaries,
    compileEnv,
    conditionalDevDependencies,
    conditionalNormalDependencies,
    devDependencies,
    edition,
    graphFingerprints,
    integrationTestRoots,
    library: libraryName === undefined ? undefined : { name: libraryName, path: libraryPath },
    librarySources,
    normalDependencies,
    packageName,
    packagePath,
    sources,
    version,
    buildProduct,
  }
  const fingerprint = buck2SemanticFingerprint({
    generator,
    schemaVersion,
    semanticData,
  })

  const commonRuleLines = [
    `    edition = ${starlarkString(edition)},`,
    '    env = {',
    ...Object.entries(compileEnv).map(
      ([name, value]) => `        ${starlarkString(name)}: ${starlarkString(value)},`,
    ),
    '    },',
  ]
  const normalConditional = conditionalNormalDependencies
  const renderRule = ({
    rule,
    name,
    crate,
    crateRoot,
    ruleSources,
    dependencies,
    conditionalDependencies,
    visibility,
  }: {
    readonly rule: 'rust_binary' | 'rust_library'
    readonly name: string
    readonly crate: string
    readonly crateRoot: string
    readonly ruleSources: readonly string[]
    readonly dependencies: readonly string[]
    readonly conditionalDependencies: readonly ConditionalDependency[]
    readonly visibility?: readonly string[]
  }): readonly string[] => [
    `native.${rule}(`,
    `    name = ${starlarkString(name)},`,
    `    crate = ${starlarkString(crate)},`,
    `    crate_root = ${starlarkString(crateRoot)},`,
    ...renderStringList({ name: 'srcs', values: ruleSources }),
    ...renderDependencies({ unconditional: dependencies, conditional: conditionalDependencies }),
    ...commonRuleLines,
    ...(visibility === undefined
      ? []
      : renderStringList({ name: 'visibility', values: visibility })),
    ')',
    '',
  ]

  const rules: string[] = []
  if (libraryName !== undefined && libraryPath !== undefined) {
    rules.push(
      ...renderRule({
        rule: 'rust_library',
        name: 'lib',
        crate: libraryName,
        crateRoot: libraryPath,
        ruleSources: librarySources,
        dependencies: normalLabels,
        conditionalDependencies: normalConditional,
        visibility: ['PUBLIC'],
      }),
    )
  }
  for (const binary of binaries) {
    const binaryDependencies = sorted([
      ...normalLabels,
      ...(libraryName === undefined ? [] : [':lib']),
    ])
    rules.push(
      ...renderRule({
        rule: 'rust_binary',
        name: binary.name,
        crate: crateIdentifier(binary.name),
        crateRoot: binary.crateRoot,
        ruleSources: [binary.crateRoot],
        dependencies: binaryDependencies,
        conditionalDependencies: normalConditional,
        visibility: ['PUBLIC'],
      }),
    )
  }
  if (buildProduct === true) {
    if (binaries.length !== 1) {
      throw new Error(
        `BuildProduct projection requires exactly one binary in ${member.manifestPath}`,
      )
    }
    const binary = requireValue({ value: binaries[0], field: `${member.manifestPath} binary` })
    rules.push(
      `rust_product_executable(`,
      `    name = ${starlarkString(`${packageName}-product-executable`)},`,
      `    binary = ${starlarkString(`:${binary.name}`)},`,
      `    recipe = ${starlarkString(`cargo-workspace:${packageName}@${version}`)},`,
      `    target_platform = host_platform_label(),`,
      ')',
      '',
      'build_product(',
      `    name = ${starlarkString(`${packageName}-product`)},`,
      `    entrypoint = ${starlarkString(`bin/${packageName}`)},`,
      `    executable = ${starlarkString(`:${packageName}-product-executable`)},`,
      `    product_name = ${starlarkString(packageName)},`,
      `    target_platform = host_platform_label(),`,
      ')',
      '',
    )
  }

  const rendered = [
    `# Projection source: ${projectionSource}`,
    `# Projection schema version: ${schemaVersion}`,
    `# Projection generator: ${generator}`,
    `# Semantic fingerprint: ${fingerprint}`,
    `# Semantic inputs: ${semanticInputPaths.join(', ')}`,
    `# Regenerate: ${regenerationCommand}`,
    '',
    'load("@prelude//:prelude.bzl", "native")',
    ...(buildProduct === true
      ? [
          'load("//buck2/products:defs.bzl", "build_product")',
          'load("//buck2/platforms:defs.bzl", "host_platform_label")',
          'load("//buck2/rust:defs.bzl", "rust_product_executable")',
        ]
      : []),
    ...rules,
  ].join('\n')

  return createGenieOutput({ data: semanticData, stringify: () => rendered })
}

const generator = 'effect-utils/rust/cargo-buck2-package-projection' as const
const schemaVersion = 1 as const
const regenerationCommand = 'devenv tasks run genie:run' as const
const thirdPartyPackage = '//rust/third-party' as const

const compareStrings = ({
  left,
  right,
}: {
  readonly left: string
  readonly right: string
}): number => (left < right ? -1 : left > right ? 1 : 0)
const sorted = (values: readonly string[]): readonly string[] =>
  [...new Set(values)].toSorted((left, right) => compareStrings({ left, right }))
const starlarkString = (value: string): string => JSON.stringify(value)
const sha256 = (value: string): `sha256:${string}` =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`

const requireValue = <TValue>({
  value,
  field,
}: {
  readonly value: TValue | undefined
  readonly field: string
}): TValue => {
  if (value === undefined) throw new Error(`Cargo metadata is missing ${field}`)
  return value
}

const assertKnownKeys = ({
  value,
  allowed,
  field,
}: {
  readonly value: Readonly<Record<string, unknown>>
  readonly allowed: readonly string[]
  readonly field: string
}): void => {
  const unexpected = Object.keys(value).filter((key) => allowed.includes(key) === false)
  if (unexpected.length > 0) {
    throw new Error(
      `Unsupported Cargo keys at ${field}: ${unexpected.toSorted((left, right) => compareStrings({ left, right })).join(', ')}`,
    )
  }
}

type CargoDependencyRequest =
  | string
  | {
      readonly 'default-features'?: boolean
      readonly features?: readonly string[]
      readonly optional?: boolean
      readonly package?: string
      readonly path?: string
      readonly version?: string
      readonly workspace?: boolean
    }

type CargoTargetDependencies = {
  readonly dependencies?: Readonly<Record<string, CargoDependencyRequest>>
  readonly 'dev-dependencies'?: Readonly<Record<string, CargoDependencyRequest>>
  readonly 'build-dependencies'?: Readonly<Record<string, CargoDependencyRequest>>
}

type CargoManifest = {
  readonly package?: {
    readonly name?: string
    readonly workspace?: string
    readonly version?: string | { readonly workspace?: boolean }
    readonly edition?: string | { readonly workspace?: boolean }
    readonly build?: boolean | string
    readonly autobins?: boolean
    readonly autolib?: boolean
    readonly autotests?: boolean
  }
  readonly lib?: {
    readonly name?: string
    readonly path?: string
    readonly 'crate-type'?: readonly string[]
    readonly 'proc-macro'?: boolean
  }
  readonly bin?: readonly {
    readonly name?: string
    readonly path?: string
    readonly 'required-features'?: readonly string[]
  }[]
  readonly test?: readonly unknown[]
  readonly bench?: readonly unknown[]
  readonly example?: readonly unknown[]
  readonly dependencies?: Readonly<Record<string, CargoDependencyRequest>>
  readonly 'dev-dependencies'?: Readonly<Record<string, CargoDependencyRequest>>
  readonly 'build-dependencies'?: Readonly<Record<string, CargoDependencyRequest>>
  readonly features?: Readonly<Record<string, readonly string[]>>
  readonly target?: Readonly<Record<string, CargoTargetDependencies>>
}

type CargoWorkspace = {
  readonly workspace?: {
    readonly resolver?: string
    readonly members?: readonly string[]
    readonly package?: {
      readonly version?: string
      readonly edition?: string
    }
    readonly dependencies?: Readonly<Record<string, CargoDependencyRequest>>
  }
}

type CargoLock = {
  readonly package?: readonly {
    readonly name?: string
    readonly version?: string
    readonly source?: string
  }[]
}

type WorkspaceMember = {
  readonly packagePath: string
  readonly manifestPath: string
  readonly manifest: CargoManifest
}

const workspaceManifest = cargoWorkspace as CargoWorkspace
const lock = cargoLock as CargoLock
const workspaceMembers = [
  {
    packagePath: 'packages/@overeng/otel-scrape',
    manifestPath: 'packages/@overeng/otel-scrape/Cargo.toml',
    manifest: otelScrapeManifest as CargoManifest,
  },
  {
    packagePath: 'packages/@overeng/otelite',
    manifestPath: 'packages/@overeng/otelite/Cargo.toml',
    manifest: oteliteManifest as CargoManifest,
  },
  {
    packagePath: 'rust/buck2-tools/archive-tool',
    manifestPath: 'rust/buck2-tools/archive-tool/Cargo.toml',
    manifest: archiveToolManifest as CargoManifest,
  },
  {
    packagePath: 'rust/buck2-tools/core',
    manifestPath: 'rust/buck2-tools/core/Cargo.toml',
    manifest: coreManifest as CargoManifest,
  },
  {
    packagePath: 'rust/buck2-tools/product',
    manifestPath: 'rust/buck2-tools/product/Cargo.toml',
    manifest: productManifest as CargoManifest,
  },
] as const satisfies readonly WorkspaceMember[]

const workspace = requireValue({ value: workspaceManifest.workspace, field: 'workspace' })
if (workspace.resolver !== '2')
  throw new Error('The Buck projection supports only Cargo resolver = "2"')
const declaredMemberPaths = sorted(
  requireValue({ value: workspace.members, field: 'workspace.members' }).map((member) =>
    path.posix.normalize(path.posix.join('rust', member)),
  ),
)
const importedMemberPaths = sorted(workspaceMembers.map((member) => member.packagePath))
if (JSON.stringify(declaredMemberPaths) !== JSON.stringify(importedMemberPaths)) {
  throw new Error(
    `Cargo workspace members and imported Buck projection manifests disagree: ${declaredMemberPaths.join(', ')}`,
  )
}

const memberByPath = new Map(workspaceMembers.map((member) => [member.packagePath, member]))
const lockPackageNames = new Set(
  (lock.package ?? []).map((entry) =>
    requireValue({ value: entry.name, field: 'Cargo.lock package.name' }),
  ),
)
const thirdPartyBuck = repo.readText('rust/third-party/BUCK')
const thirdPartyTargets = new Set(
  [...thirdPartyBuck.matchAll(/^    name = "([^"]+)",$/gm)].map((match) =>
    requireValue({ value: match[1], field: 'rust/third-party/BUCK target name' }),
  ),
)

const normalizeDependencyRequest = ({
  dependencyName,
  request,
  field,
}: {
  readonly dependencyName: string
  readonly request: CargoDependencyRequest
  readonly field: string
}): {
  readonly defaultFeatures: boolean
  readonly features: readonly string[]
  readonly path?: string
  readonly version?: string
  readonly workspace: boolean
} => {
  if (typeof request === 'string') {
    if (request.length === 0) throw new Error(`Empty Cargo version request at ${field}`)
    return { defaultFeatures: true, features: [], version: request, workspace: false }
  }
  assertKnownKeys({
    value: request,
    allowed: [
      'default-features',
      'features',
      'optional',
      'package',
      'path',
      'version',
      'workspace',
    ],
    field,
  })
  if (request.package !== undefined) {
    throw new Error(
      `Unsupported renamed Cargo dependency at ${field}: ${dependencyName} -> ${request.package}`,
    )
  }
  if (request.optional === true)
    throw new Error(`Unsupported optional Cargo dependency at ${field}`)
  if (request.workspace === true && request.path !== undefined) {
    throw new Error(`Cargo dependency at ${field} cannot combine workspace and path`)
  }
  if (request.workspace !== true && request.path === undefined && request.version === undefined) {
    throw new Error(`Cargo dependency at ${field} has no version, path, or workspace inheritance`)
  }
  return {
    defaultFeatures: request['default-features'] ?? true,
    features: sorted(request.features ?? []),
    ...(request.path === undefined ? {} : { path: request.path }),
    ...(request.version === undefined ? {} : { version: request.version }),
    workspace: request.workspace === true,
  }
}

type ResolvedDependency = {
  readonly defaultFeatures: boolean
  readonly features: readonly string[]
  readonly label: string
  readonly name: string
  readonly requestSource: 'member' | 'workspace'
  readonly targetAvailable: boolean
  readonly version?: string
}

const resolveDependency = ({
  member,
  dependencyName,
  request,
  field,
}: {
  readonly member: WorkspaceMember
  readonly dependencyName: string
  readonly request: CargoDependencyRequest
  readonly field: string
}): ResolvedDependency => {
  const memberRequest = normalizeDependencyRequest({ dependencyName, request, field })
  if (memberRequest.path !== undefined) {
    const dependencyPath = path.posix.normalize(
      path.posix.join(member.packagePath, memberRequest.path),
    )
    const dependencyMember = memberByPath.get(dependencyPath)
    if (dependencyMember === undefined) {
      throw new Error(
        `Cargo path dependency at ${field} is not a workspace member: ${dependencyPath}`,
      )
    }
    const dependencyPackage = requireValue({
      value: dependencyMember.manifest.package,
      field: `${dependencyMember.manifestPath} package`,
    })
    if (dependencyPackage.name !== dependencyName) {
      throw new Error(
        `Cargo path dependency rename is unsupported at ${field}: ${dependencyName} -> ${String(dependencyPackage.name)}`,
      )
    }
    if (dependencyMember.manifest.lib === undefined) {
      throw new Error(
        `Cargo path dependency at ${field} does not expose the contracted :lib target`,
      )
    }
    return {
      defaultFeatures: memberRequest.defaultFeatures,
      features: memberRequest.features,
      label: `//${dependencyPath}:lib`,
      name: dependencyName,
      requestSource: 'member',
      targetAvailable: true,
      ...(memberRequest.version === undefined ? {} : { version: memberRequest.version }),
    }
  }

  let effectiveRequest = memberRequest
  let requestSource: ResolvedDependency['requestSource'] = 'member'
  if (memberRequest.workspace === true) {
    const inheritedRequest = requireValue({
      value: workspace.dependencies?.[dependencyName],
      field: `workspace.dependencies.${dependencyName}`,
    })
    const normalizedInherited = normalizeDependencyRequest({
      dependencyName,
      request: inheritedRequest,
      field: `workspace.dependencies.${dependencyName}`,
    })
    if (normalizedInherited.workspace === true || normalizedInherited.path !== undefined) {
      throw new Error(`Unsupported nested workspace/path dependency for ${dependencyName}`)
    }
    effectiveRequest = {
      defaultFeatures: normalizedInherited.defaultFeatures && memberRequest.defaultFeatures,
      features: sorted([...normalizedInherited.features, ...memberRequest.features]),
      version: normalizedInherited.version,
      workspace: false,
    }
    requestSource = 'workspace'
  }

  if (lockPackageNames.has(dependencyName) === false) {
    throw new Error(`Cargo.lock has no package for dependency ${dependencyName} at ${field}`)
  }
  return {
    defaultFeatures: effectiveRequest.defaultFeatures,
    features: effectiveRequest.features,
    label: `${thirdPartyPackage}:${dependencyName}`,
    name: dependencyName,
    requestSource,
    targetAvailable: thirdPartyTargets.has(dependencyName),
    ...(effectiveRequest.version === undefined ? {} : { version: effectiveRequest.version }),
  }
}

const resolveDependencyTable = ({
  member,
  dependencies,
  field,
}: {
  readonly member: WorkspaceMember
  readonly dependencies: Readonly<Record<string, CargoDependencyRequest>> | undefined
  readonly field: string
}): readonly ResolvedDependency[] =>
  Object.entries(dependencies ?? {})
    .map(([dependencyName, request]) =>
      resolveDependency({ member, dependencyName, request, field: `${field}.${dependencyName}` }),
    )
    .toSorted((left, right) => compareStrings({ left: left.name, right: right.name }))

const discoverRustSources = ({
  packagePath,
}: {
  readonly packagePath: string
}): readonly string[] => {
  const packageRoot = repo.resolve(packagePath)
  const sources: string[] = []
  const walk = (relativeDirectory: string): void => {
    for (const entry of readdirSync(path.join(packageRoot, relativeDirectory), {
      withFileTypes: true,
    }).toSorted((left, right) => compareStrings({ left: left.name, right: right.name }))) {
      const relativePath = path.posix.join(relativeDirectory, entry.name)
      if (entry.isSymbolicLink() === true) {
        throw new Error(`Rust source census refuses symlink: ${packagePath}/${relativePath}`)
      }
      if (entry.isDirectory() === true) walk(relativePath)
      else if (entry.isFile() === true && path.extname(entry.name) === '.rs')
        sources.push(relativePath)
    }
  }
  walk('src')
  if (existsSync(path.join(packageRoot, 'tests')) === true) walk('tests')
  if (sources.length === 0) throw new Error(`Rust source census found no inputs in ${packagePath}`)
  return sources.toSorted((left, right) => compareStrings({ left, right }))
}

const targetConditionLabels = (condition: string): readonly string[] => {
  switch (condition) {
    case 'cfg(unix)':
      return ['prelude//os/constraints:linux', 'prelude//os/constraints:macos']
    case 'cfg(target_os = "linux")':
      return ['prelude//os/constraints:linux']
    case 'cfg(target_os = "macos")':
      return ['prelude//os/constraints:macos']
    default:
      throw new Error(`Unsupported Cargo target dependency condition: ${condition}`)
  }
}

type ConditionalDependency = {
  readonly condition: string
  readonly dependency: ResolvedDependency
  readonly selectLabels: readonly string[]
}

const resolveConditionalDependencies = ({
  member,
  target,
  kind,
}: {
  readonly member: WorkspaceMember
  readonly target: CargoManifest['target']
  readonly kind: 'dependencies' | 'dev-dependencies'
}): readonly ConditionalDependency[] =>
  Object.entries(target ?? {})
    .flatMap(([condition, tables]) => {
      assertKnownKeys({
        value: tables,
        allowed: ['dependencies', 'dev-dependencies', 'build-dependencies'],
        field: `target.${condition}`,
      })
      if (tables['build-dependencies'] !== undefined) {
        throw new Error(`Cargo target build dependencies are unsupported at target.${condition}`)
      }
      const selectLabels = targetConditionLabels(condition)
      return resolveDependencyTable({
        member,
        dependencies: tables[kind],
        field: `target.${condition}.${kind}`,
      }).map((dependency) => ({ condition, dependency, selectLabels }))
    })
    .toSorted((left, right) =>
      compareStrings({
        left: `${left.condition}:${left.dependency.name}`,
        right: `${right.condition}:${right.dependency.name}`,
      }),
    )

const renderStringList = ({
  name,
  values,
}: {
  readonly name: string
  readonly values: readonly string[]
}): readonly string[] => [
  `    ${name} = [`,
  ...values.map((value) => `        ${starlarkString(value)},`),
  '    ],',
]

const renderDependencies = ({
  unconditional,
  conditional,
}: {
  readonly unconditional: readonly string[]
  readonly conditional: readonly ConditionalDependency[]
}): readonly string[] => {
  const base = sorted(unconditional)
  const selected = new Map<string, string[]>()
  for (const entry of conditional) {
    if (base.includes(entry.dependency.label) === true) continue
    for (const selectLabel of entry.selectLabels) {
      const labels = selected.get(selectLabel) ?? []
      labels.push(entry.dependency.label)
      selected.set(selectLabel, labels)
    }
  }
  const baseLines = renderStringList({ name: 'deps', values: base })
  if (selected.size === 0) return baseLines
  return [
    ...baseLines.slice(0, -1),
    '    ] + select({',
    ...[...selected.entries()]
      .toSorted(([left], [right]) => compareStrings({ left, right }))
      .flatMap(([selectLabel, labels]) =>
        [`        ${starlarkString(selectLabel)}: [`].concat(
          sorted(labels).map((label) => `            ${starlarkString(label)},`),
          '        ],',
        ),
      ),
    '        "DEFAULT": [],',
    '    }),',
  ]
}

const crateIdentifier = (value: string): string => value.replaceAll(/[^A-Za-z0-9_]/g, '_')
