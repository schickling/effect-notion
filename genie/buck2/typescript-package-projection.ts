import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import {
  createGenieOutput,
  type GenieOutput,
} from '../../packages/@overeng/genie/src/runtime/core.ts'
import { buck2SemanticFingerprint, renderBuck2Visibility } from './mod.ts'
import {
  javaScriptActionRuntime,
  packageTreeRuntime,
  stagedModuleName,
} from './runtime-modules.ts'

const regenerationCommand = 'devenv tasks run genie:run' as const
const sourceExtensions = ['.cts', '.js', '.mts', '.ts', '.tsx'] as const
const sourceExtensionSet: Readonly<Record<string, true>> = {
  '.cts': true,
  '.js': true,
  '.mts': true,
  '.ts': true,
  '.tsx': true,
}

/**
 * Extensions the JavaScript runners collect test modules from. Vitest and Bun both select
 * `*.{test,spec}.?(c|m)[jt]s?(x)` by default, so a declared lane can collect modules the
 * TypeScript census never admits — `.jsx` above all. The projection derives those from the
 * same lane declaration instead of asking each package to re-list its own test files.
 */
const collectableTestExtensions = [
  '.cjs',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.mts',
  '.ts',
  '.tsx',
] as const
const collectableTestExtensionSet: Readonly<Record<string, true>> = Object.fromEntries(
  collectableTestExtensions.map((extension) => [extension, true as const]),
)
/** Collectable test extensions the TypeScript source census does not already admit. */
const nonSourceCollectableTestExtensions = collectableTestExtensions.filter(
  (extension) => sourceExtensionSet[extension] !== true,
)
const collectableTestStemPattern = /\.(?:spec|test)$/
const snapshotDirectoryName = '__snapshots__'
const snapshotExtension = '.snap'

/** True for a package-relative file a declared lane can collect as a test module. */
const isCollectableTestModule = (relativePath: string): boolean => {
  const extension = path.posix.extname(relativePath)
  return (
    collectableTestExtensionSet[extension] === true &&
    collectableTestStemPattern.test(path.posix.basename(relativePath, extension))
  )
}

/**
 * Snapshot baseline Vitest resolves for one test module. The runner pins `CI=true`, so a
 * missing baseline is a failing lane rather than a file the run writes for itself.
 */
const snapshotBaselineFor = (testModule: string): string =>
  path.posix.join(
    path.posix.dirname(testModule),
    snapshotDirectoryName,
    `${path.posix.basename(testModule)}${snapshotExtension}`,
  )

const commonSemanticInputs = [
  'buck2/dependencies/BUCK.genie.ts',
  'buck2/dependencies/pnpm-lock.sha256.json.genie.ts',
  'genie/buck2/mod.ts',
  'genie/buck2/typescript-package-projection.ts',
  'package.json.genie.ts',
  // The package-tree runner and every module staged with it: a change to any of
  // them changes the action, so it must refresh the projection fingerprint.
  ...packageTreeRuntime.modules,
  // The JavaScript test runner and every module staged with it: the declared
  // test lanes execute it, so the same rule applies to its closure.
  ...javaScriptActionRuntime.modules,
] as const

const compareStrings = ({ left, right }: { left: string; right: string }): number =>
  left < right ? -1 : left > right ? 1 : 0

const safeSourceSegment = (segment: string): boolean =>
  segment !== '' &&
  segment !== '.' &&
  segment !== '..' &&
  segment.includes('/') === false &&
  segment.includes('\\') === false &&
  /^[A-Za-z0-9._@+-]+$/.test(segment)

const discoverPackageFiles = ({
  packagePath,
  repoRoot = process.cwd(),
  sourceRoots,
  admit,
  emptyCensusMessage,
}: {
  packagePath: string
  repoRoot?: string
  sourceRoots: readonly string[]
  admit: (relativePath: string) => boolean
  emptyCensusMessage?: string | undefined
}): readonly string[] => {
  const absoluteRoot = path.join(repoRoot, packagePath)
  const sources: string[] = []

  const walk = (relativeDirectory: string): void => {
    const entries = readdirSync(path.join(absoluteRoot, relativeDirectory), {
      withFileTypes: true,
    }).toSorted((left, right) => compareStrings({ left: left.name, right: right.name }))
    for (const entry of entries) {
      if (safeSourceSegment(entry.name) === false) {
        throw new Error(`Unsafe package source path segment: ${entry.name}`)
      }
      const relativePath = path.posix.join(relativeDirectory, entry.name)
      if (entry.isSymbolicLink() === true) {
        throw new Error(`Package source census refuses symlink: ${relativePath}`)
      }
      if (entry.isDirectory() === true) {
        walk(relativePath)
      } else if (entry.isFile() === true && admit(relativePath) === true) {
        sources.push(relativePath)
      }
    }
  }

  for (const sourceRoot of sourceRoots) {
    if (safeSourceSegment(sourceRoot) === false) {
      throw new Error(`Unsafe package source root: ${sourceRoot}`)
    }
    walk(sourceRoot)
  }
  if (sources.length === 0 && emptyCensusMessage !== undefined) {
    throw new Error(emptyCensusMessage)
  }
  return sources.toSorted((left, right) => compareStrings({ left, right }))
}

const admitSourceExtension = (relativePath: string): boolean =>
  sourceExtensionSet[path.posix.extname(relativePath)] === true

const discoverPackageSources = ({
  packagePath,
  repoRoot,
  sourceRoots,
}: {
  packagePath: string
  repoRoot?: string
  sourceRoots: readonly string[]
}): readonly string[] =>
  discoverPackageFiles({
    packagePath,
    ...(repoRoot === undefined ? {} : { repoRoot }),
    sourceRoots,
    admit: admitSourceExtension,
    emptyCensusMessage: 'Package source census found no TypeScript inputs',
  })

/** The one rule for which declarations are published verbatim instead of compiled. */
const isHandwrittenDeclaration = (relativePath: string): boolean => relativePath.endsWith('.d.ts')

/**
 * Handwritten declarations a package publishes verbatim into its `dist`.
 *
 * The emit action copies these instead of compiling them, so the detached
 * materializer has to stage the identical set before it compares a published
 * `dist`. Both the projection and that materializer derive the set here;
 * restating the rule is how every copied declaration used to read as staleness.
 */
export const buck2TypeScriptDeclarationSources = ({
  packagePath,
  repoRoot,
  sourceRoots,
}: {
  readonly packagePath: string
  readonly repoRoot?: string
  readonly sourceRoots: readonly string[]
}): readonly string[] =>
  discoverPackageSources({
    packagePath,
    ...(repoRoot === undefined ? {} : { repoRoot }),
    sourceRoots,
  }).filter(isHandwrittenDeclaration)

const starlarkString = (value: string): string => JSON.stringify(value)

const renderMap = ({
  name,
  entries,
}: {
  name: string
  entries: readonly (readonly [string, string])[]
}): readonly string[] => [
  `    ${name} = {`,
  ...entries.map(
    ([destination, source]) => `        ${starlarkString(destination)}: ${starlarkString(source)},`,
  ),
  '    },',
]

const renderList = ({
  name,
  values,
}: {
  name: string
  values: readonly string[]
}): readonly string[] => [
  `    ${name} = [`,
  ...values.map((value) => `        ${starlarkString(value)},`),
  '    ],',
]

/** Renders a Starlark dict whose values are expressions rather than literals. */
const renderExpressionMap = ({
  name,
  entries,
}: {
  name: string
  entries: readonly (readonly [string, string])[]
}): readonly string[] => [
  `    ${name} = {`,
  ...entries.map(([key, expression]) => `        ${starlarkString(key)}: ${expression},`),
  '    },',
]

/**
 * Buck config section every task-supplied test input is read from. These are host paths
 * (native addons, live-service binaries) that only the caller knows, so the projection
 * declares the key and the invoking task passes `--config <section>.<key>=<path>`.
 */
const configuredTestInputSection = 'javascript_test_inputs'
const defaultVitestConfig = 'vitest.config.ts'
const defaultTestTargetName = 'test'
const testTargetNamePattern = /^[a-z][a-z0-9_]*$/
const environmentNamePattern = /^[A-Z_][A-Z0-9_]*$/
const testRuleNames = {
  bun: 'bun_test',
  shell: 'shell_tests',
  vitest: 'vitest_test',
} as const satisfies Readonly<Record<string, string>>

/** Attested support tool in the hub toolchains package; the runner never resolves from PATH. */
export type Buck2TestToolLabel = `//buck2/toolchains:${string}`

type Buck2TypeScriptPackageTestTargetBase = {
  /** Target name inside the package; the first declared lane must be `test`. */
  readonly name: string
  /** Package-relative test paths the lane runs; empty means the config's own selection. */
  readonly testFiles?: readonly string[]
  /** Package-relative paths removed from the lane's selection. */
  readonly excludes?: readonly string[]
  /** Literal environment the action declares; the runner rejects non-literal values. */
  readonly env?: Readonly<Record<string, string>>
  /** Repository-relative sources exposed to the lane under an environment name. */
  readonly externalInputs?: Readonly<Record<string, string>>
  /** Environment names whose immutable store path the invoking task supplies by config. */
  readonly configuredExternalInputs?: readonly string[]
  /** Environment name to attested support tool; the tool's store path lands on PATH. */
  readonly tools?: Readonly<Record<string, Buck2TestToolLabel>>
  /**
   * Ambient environment names the lane reads. Their values are outside the action identity,
   * so a lane that inherits any of them must also declare itself uncacheable.
   */
  readonly inheritedEnv?: readonly string[]
  /** Environment name to scratch-relative directory the runner creates and exports. */
  readonly writableDirectories?: Readonly<Record<string, string>>
  /** Whether the lane's result may be served from cache; defaults to true. */
  readonly cacheable?: boolean
  /** Test-runner labels, e.g. `local-only` for lanes that need host services. */
  readonly labels?: readonly string[]
  /** Per-test timeout in milliseconds. */
  readonly timeoutMs?: number
  /**
   * Package-root files the declared config loads (setup files, fixtures). They live outside
   * every source root, so the projection stages them explicitly.
   */
  readonly configInputs?: readonly string[]
}

/** One declared test lane, discriminated by the rule that runs it. */
export type Buck2TypeScriptPackageTestTarget = Buck2TypeScriptPackageTestTargetBase &
  (
    | {
        readonly runner: 'vitest'
        /** Package-root Vitest config; defaults to `vitest.config.ts`. */
        readonly config?: string
        /** Runtime that evaluates the suite; `node` requires a declared `NODE_BIN` tool. */
        readonly vitestRuntime?: 'bun' | 'node'
        /** Per-hook timeout in milliseconds. */
        readonly hookTimeoutMs?: number
      }
    | { readonly runner: 'bun' }
    | { readonly runner: 'shell' }
  )

/** Declared test lanes of one package, in emit order; the first one is the default lane. */
export type Buck2TypeScriptPackageTests = readonly [
  Buck2TypeScriptPackageTestTarget,
  ...Buck2TypeScriptPackageTestTarget[],
]

/**
 * Non-TypeScript test inputs of one package. The source census only knows TypeScript
 * extensions, so a suite reading committed fixtures needs its data directory declared or the
 * fixture is simply absent from the package tree the lane runs in.
 */
export type Buck2TypeScriptPackageTestDataRoot = {
  /** Package-root directory holding the fixtures. */
  readonly root: string
  /** Extensions staged from that directory, each with its leading dot. */
  readonly extensions: readonly string[]
}

type ProjectedTestTarget = {
  readonly name: string
  readonly rule: (typeof testRuleNames)[keyof typeof testRuleNames]
  readonly configuredInputKeys: readonly (readonly [string, string])[]
  readonly lines: readonly string[]
  readonly semanticData: unknown
}

const requireRelativeTestPath = ({
  field,
  value,
}: {
  field: string
  value: string
}): string => {
  if (value === '' || value.startsWith('/') === true) {
    throw new Error(`${field} must be relative to the package tree: ${value}`)
  }
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new Error(`${field} must be normalized: ${value}`)
    }
  }
  return value
}

const requireEnvironmentName = ({ field, value }: { field: string; value: string }): string => {
  if (environmentNamePattern.test(value) === false) {
    throw new Error(`${field} must be an upper-case environment name: ${value}`)
  }
  return value
}

const requireTimeout = ({ field, value }: { field: string; value: number }): number => {
  if (Number.isSafeInteger(value) === false || value <= 0) {
    throw new Error(`${field} must be a positive whole number of milliseconds: ${value}`)
  }
  return value
}

const sortedEntries = (
  entries: Readonly<Record<string, string>>,
): readonly (readonly [string, string])[] =>
  Object.entries(entries).toSorted(([left], [right]) => compareStrings({ left, right }))

/**
 * Validates one declared lane against everything the rule checks at analysis time and renders
 * it. Generation-time failure is the point: a stale or contradictory declaration must never
 * reach a generated `BUCK` file where the same mistake costs a Buck analysis round trip.
 */
const projectTestTarget = ({
  packagePath,
  sourceRoots,
  sourceLabel,
  target,
  visibility,
}: {
  packagePath: string
  sourceRoots: readonly string[]
  sourceLabel: (repoRelativePath: string) => string
  target: Buck2TypeScriptPackageTestTarget
  visibility: readonly string[]
}): ProjectedTestTarget => {
  if (testTargetNamePattern.test(target.name) === false) {
    throw new Error(`Unsafe test target name: ${target.name}`)
  }
  const sourceRootSet = new Set(sourceRoots)
  const requireDeclaredRoot = ({ field, value }: { field: string; value: string }): string => {
    requireRelativeTestPath({ field, value })
    const root = value.split('/')[0] ?? ''
    if (sourceRootSet.has(root) === false) {
      throw new Error(
        `${field} ${value} is outside the declared source roots (${sourceRoots.join(', ')}): declare ${root} in sourceRoots so the package tree carries it`,
      )
    }
    return value
  }
  const testFiles = (target.testFiles ?? []).map((value) =>
    requireDeclaredRoot({ field: 'test file', value }),
  )
  const excludes = (target.excludes ?? []).map((value) =>
    requireDeclaredRoot({ field: 'test exclude', value }),
  )
  const tools = sortedEntries(target.tools ?? {}).map(([name, label]) => {
    requireEnvironmentName({ field: 'test tool name', value: name })
    if (label.startsWith('//buck2/toolchains:') === false) {
      throw new Error(`Test tool ${name} must be an attested support tool: ${label}`)
    }
    return [name, label] as const
  })
  const env = sortedEntries(target.env ?? {}).map(([name, value]) => {
    requireEnvironmentName({ field: 'test env name', value: name })
    if (value.startsWith('$') === true) {
      throw new Error(`Test env ${name} must be a literal action input: ${value}`)
    }
    return [name, value] as const
  })
  const externalInputs = sortedEntries(target.externalInputs ?? {}).map(([name, source]) => {
    requireEnvironmentName({ field: 'test external input name', value: name })
    if (existsSync(path.join(process.cwd(), source)) === false) {
      throw new Error(`Test external input ${name} does not exist: ${source}`)
    }
    return [name, sourceLabel(source)] as const
  })
  const writableDirectories = sortedEntries(target.writableDirectories ?? {}).map(
    ([name, directory]) => {
      requireEnvironmentName({ field: 'test writable directory name', value: name })
      requireRelativeTestPath({ field: 'test writable directory', value: directory })
      return [name, directory] as const
    },
  )
  // Derived, never declared per package: one convention keeps every `--config` key predictable.
  const packageSlug = packagePath.slice(packagePath.lastIndexOf('/') + 1).replaceAll('-', '_')
  const configuredInputKeys = [...(target.configuredExternalInputs ?? [])]
    .toSorted((left, right) => compareStrings({ left, right }))
    .map((inputName) => {
      requireEnvironmentName({ field: 'configured test input name', value: inputName })
      return [
        inputName,
        `${packageSlug}_${target.name}_${inputName.toLowerCase()}`,
      ] as const
    })
  const inheritedEnv = [...(target.inheritedEnv ?? [])]
    .toSorted((left, right) => compareStrings({ left, right }))
    .map((value) => requireEnvironmentName({ field: 'test inherited env name', value }))
  const cacheable = target.cacheable ?? true
  if (inheritedEnv.length > 0 && cacheable === true) {
    throw new Error(
      `Test target ${target.name} inherits ${inheritedEnv.join(', ')} from the ambient environment, whose values are outside the action identity, so it must declare cacheable: false`,
    )
  }
  const labels = [...(target.labels ?? [])].toSorted((left, right) =>
    compareStrings({ left, right }),
  )
  const timeoutMs =
    target.timeoutMs === undefined
      ? undefined
      : requireTimeout({ field: 'test timeout', value: target.timeoutMs })
  const vitest =
    target.runner === 'vitest'
      ? {
          config: target.config ?? defaultVitestConfig,
          hookTimeoutMs:
            target.hookTimeoutMs === undefined
              ? undefined
              : requireTimeout({ field: 'test hook timeout', value: target.hookTimeoutMs }),
          vitestRuntime: target.vitestRuntime ?? 'bun',
        }
      : undefined
  if (vitest !== undefined) {
    if (safeSourceSegment(vitest.config) === false) {
      throw new Error(`Vitest config must be a package-root file: ${vitest.config}`)
    }
    if (existsSync(path.join(process.cwd(), packagePath, vitest.config)) === false) {
      throw new Error(`Vitest config does not exist: ${packagePath}/${vitest.config}`)
    }
    if (
      vitest.vitestRuntime === 'node' &&
      tools.some(([name]) => name === 'NODE_BIN') === false
    ) {
      throw new Error(
        `Test target ${target.name} declares the node Vitest runtime, which requires a declared NODE_BIN tool`,
      )
    }
  }
  const configInputs = [...(target.configInputs ?? [])].toSorted((left, right) =>
    compareStrings({ left, right }),
  )
  for (const configInput of configInputs) {
    if (safeSourceSegment(configInput) === false) {
      throw new Error(`Test config input must be a package-root file: ${configInput}`)
    }
    if (existsSync(path.join(process.cwd(), packagePath, configInput)) === false) {
      throw new Error(`Test config input does not exist: ${packagePath}/${configInput}`)
    }
  }
  const optionalAttributes: readonly (readonly [string, readonly string[] | undefined])[] = [
    ['cacheable', cacheable === true ? undefined : ['    cacheable = False,']],
    [
      'config',
      vitest === undefined || vitest.config === defaultVitestConfig
        ? undefined
        : [`    config = ${starlarkString(vitest.config)},`],
    ],
    [
      'configured_external_inputs',
      configuredInputKeys.length === 0
        ? undefined
        : renderExpressionMap({
            name: 'configured_external_inputs',
            entries: configuredInputKeys.map(
              ([inputName, key]) =>
                [
                  inputName,
                  `read_config(${starlarkString(configuredTestInputSection)}, ${starlarkString(key)}, "")`,
                ] as const,
            ),
          }),
    ],
    ['env', env.length === 0 ? undefined : renderMap({ name: 'env', entries: env })],
    [
      'excludes',
      excludes.length === 0 ? undefined : renderList({ name: 'excludes', values: excludes }),
    ],
    [
      'external_inputs',
      externalInputs.length === 0
        ? undefined
        : renderMap({ name: 'external_inputs', entries: externalInputs }),
    ],
    [
      'hook_timeout_ms',
      vitest?.hookTimeoutMs === undefined
        ? undefined
        : [`    hook_timeout_ms = ${vitest.hookTimeoutMs},`],
    ],
    [
      'inherited_env',
      inheritedEnv.length === 0
        ? undefined
        : renderList({ name: 'inherited_env', values: inheritedEnv }),
    ],
    ['labels', labels.length === 0 ? undefined : renderList({ name: 'labels', values: labels })],
    [
      'test_files',
      testFiles.length === 0 ? undefined : renderList({ name: 'test_files', values: testFiles }),
    ],
    ['timeout_ms', timeoutMs === undefined ? undefined : [`    timeout_ms = ${timeoutMs},`]],
    ['tools', tools.length === 0 ? undefined : renderMap({ name: 'tools', entries: tools })],
    [
      'vitest_runtime',
      vitest === undefined || vitest.vitestRuntime === 'bun'
        ? undefined
        : [`    vitest_runtime = ${starlarkString(vitest.vitestRuntime)},`],
    ],
    [
      'writable_directories',
      writableDirectories.length === 0
        ? undefined
        : renderMap({ name: 'writable_directories', entries: writableDirectories }),
    ],
  ]
  const rule = testRuleNames[target.runner]
  return {
    name: target.name,
    rule,
    configuredInputKeys,
    lines: [
      `${rule}(`,
      `    name = ${starlarkString(target.name)},`,
      '    package_tree = ":test_package_tree",',
      ...optionalAttributes
        .toSorted(([left], [right]) => compareStrings({ left, right }))
        .flatMap(([, lines]) => lines ?? []),
      renderBuck2Visibility({ visibility }),
      ')',
      '',
    ],
    semanticData: {
      cacheable,
      configInputs,
      configuredInputKeys,
      env,
      excludes,
      externalInputs,
      inheritedEnv,
      labels,
      name: target.name,
      rule,
      testFiles,
      timeoutMs,
      tools,
      vitest,
      writableDirectories,
    },
  }
}

export type Buck2WorkspaceSibling = {
  readonly packageName: string
  readonly packagePath: string
  readonly distTarget?: `${string}//${string}:dist`
  readonly sourceRoots?: readonly string[]
}

export type Buck2TypeScriptAuthorityMetadata = {
  readonly declarationEntrypoint: string
  readonly projectFile: string
}

export type Buck2TypeScriptPackageProjection = {
  readonly dependencyImporter: `//buck2/dependencies:importer_${string}`
  readonly packageName: string
  readonly packagePath: string
  readonly projectionSource: string
  readonly sourceRoots: readonly string[]
  readonly workspaceSiblings?: readonly Buck2WorkspaceSibling[]
  readonly authority?: Buck2TypeScriptAuthorityMetadata
  readonly tests?: Buck2TypeScriptPackageTests
  readonly testDataRoots?: readonly Buck2TypeScriptPackageTestDataRoot[]
}

export const buck2TypeScriptPackageProjection = ({
  dependencyImporter,
  packageName,
  packagePath,
  projectionSource,
  sourceRoots,
  workspaceSiblings = [],
  authority,
  tests,
  testDataRoots = [],
}: Buck2TypeScriptPackageProjection): GenieOutput<unknown> => {
  const projectFile = authority?.projectFile ?? 'tsconfig.json'
  if (safeSourceSegment(projectFile) === false) {
    throw new Error(`Unsafe package project file: ${projectFile}`)
  }
  // One walk, two trees: the compile tree takes the TypeScript sources that emit,
  // typecheck and materialization own, while the test tree also takes the modules the
  // runners collect (`.jsx` specs) and the snapshot baselines those modules read back.
  const censusFiles = discoverPackageFiles({
    packagePath,
    sourceRoots,
    admit: (relativePath) =>
      admitSourceExtension(relativePath) === true || isCollectableTestModule(relativePath) === true,
  })
  const packageSources = censusFiles.filter(admitSourceExtension)
  if (packageSources.length === 0) {
    throw new Error('Package source census found no TypeScript inputs')
  }
  const collectableTestModules = censusFiles.filter(isCollectableTestModule)
  const snapshotBaselines = collectableTestModules
    .map(snapshotBaselineFor)
    .filter((baseline) => existsSync(path.join(process.cwd(), packagePath, baseline)))
  const declarationSources = packageSources.filter(isHandwrittenDeclaration)
  const buckPackagePaths = new Set(
    [packagePath, ...workspaceSiblings.map((sibling) => sibling.packagePath)].filter((candidate) =>
      existsSync(path.join(process.cwd(), candidate, 'BUCK.genie.ts')),
    ),
  )
  const dependencyView = dependencyImporter.replace(
    '//buck2/dependencies:importer_',
    '//buck2/dependencies:view_',
  )
  const visibility = ['PUBLIC'] as const
  const runtimeEntry = stagedModuleName(packageTreeRuntime.entry)
  const sourceLabel = (repoRelativePath: string): string => {
    if (repoRelativePath.startsWith(`${packagePath}/`) === true) {
      return repoRelativePath.slice(packagePath.length + 1)
    }
    const sourcePackage = [...buckPackagePaths]
      .filter((candidate) => repoRelativePath.startsWith(`${candidate}/`) === true)
      .toSorted((left, right) => right.length - left.length || compareStrings({ left, right }))[0]
    if (sourcePackage !== undefined) {
      return `//${sourcePackage}:${repoRelativePath.slice(sourcePackage.length + 1)}`
    }
    return `//:${repoRelativePath}`
  }
  const testTargets = (tests ?? []).map((target) =>
    projectTestTarget({ packagePath, sourceRoots, sourceLabel, target, visibility }),
  )
  if (tests !== undefined) {
    if (tests[0].name !== defaultTestTargetName) {
      throw new Error(
        `The first declared test target of ${packageName} must be named ${defaultTestTargetName}, not ${tests[0].name}`,
      )
    }
    const names = testTargets.map((target) => target.name)
    if (new Set(names).size !== names.length) {
      throw new Error(`Duplicate test target names for ${packageName}: ${names.join(', ')}`)
    }
  }
  // Every lane runs inside the test package tree, so the config it loads and the files that
  // config loads have to be staged: they live beside `package.json`, outside every source root.
  const testConfigEntries = [
    ...new Set(
      (tests ?? []).flatMap((target) => [
        ...(target.runner === 'vitest' ? [target.config ?? defaultVitestConfig] : []),
        ...(target.configInputs ?? []),
      ]),
    ),
  ]
    .toSorted((left, right) => compareStrings({ left, right }))
    .map((file): readonly [string, string] => [file, file])
  const testDataFiles = testDataRoots.flatMap((dataRoot) => {
    for (const extension of dataRoot.extensions) {
      if (extension.startsWith('.') === false || safeSourceSegment(extension) === false) {
        throw new Error(`Unsafe test data extension in ${dataRoot.root}: ${extension}`)
      }
    }
    if (dataRoot.extensions.length === 0) {
      throw new Error(`Test data root ${dataRoot.root} declares no extensions`)
    }
    const dataExtensionSet: Readonly<Record<string, true>> = Object.fromEntries(
      dataRoot.extensions.map((extension) => [extension, true as const]),
    )
    return discoverPackageFiles({
      packagePath,
      sourceRoots: [dataRoot.root],
      admit: (relativePath) => dataExtensionSet[path.posix.extname(relativePath)] === true,
      emptyCensusMessage: `Test data census found no ${dataRoot.extensions.join(', ')} inputs under ${packagePath}/${dataRoot.root}`,
    })
  })
  const projectFileEntries: readonly (readonly [string, string])[] =
    projectFile === 'tsconfig.json' ? [] : [[projectFile, projectFile]]
  const identityEntries = (files: readonly string[]): readonly (readonly [string, string])[] =>
    files.map((file) => [file, file] as const)
  // The compile tree: typecheck, emit and the editor read it, so it carries the TypeScript
  // census and nothing a runner alone collects. A `.jsx` spec, a snapshot baseline, a Vitest
  // config or a committed fixture in here would widen every compile action's identity for
  // inputs no compiler ever opens.
  const packageFileEntries = [
    ...identityEntries(packageSources),
    ['package.json', 'package.json'] as const,
    ['tsconfig.json', 'tsconfig.json'] as const,
    ...projectFileEntries,
  ].toSorted(([left], [right]) => compareStrings({ left, right }))
  // The test tree: the compile tree plus everything only a runner reads — the collectable
  // modules the TypeScript census rejects, the baselines those modules compare against under
  // `CI=true`, the declared config with its own inputs, and the committed fixture data. The
  // deduplicating map is load-bearing: a `.test.ts` module is both a source and collectable.
  const testPackageFileEntries: readonly (readonly [string, string])[] =
    testTargets.length === 0
      ? []
      : [
          ...new Map<string, string>([
            ...packageFileEntries,
            ...identityEntries(collectableTestModules),
            ...identityEntries(snapshotBaselines),
            ...testConfigEntries,
            ...identityEntries(testDataFiles),
          ]),
        ].toSorted(([left], [right]) => compareStrings({ left, right }))
  const workspaceSiblingProjections = workspaceSiblings.map((sibling) => {
    const hasDist = sibling.distTarget !== undefined
    const hasSources = sibling.sourceRoots !== undefined
    if (hasDist === hasSources) {
      throw new Error(
        `Workspace sibling ${sibling.packageName} must declare exactly one of distTarget or sourceRoots`,
      )
    }
    const siblingSources =
      sibling.sourceRoots === undefined
        ? []
        : discoverPackageSources({
            packagePath: sibling.packagePath,
            sourceRoots: sibling.sourceRoots,
          })
    const files = [
      ['package.json', sourceLabel(`${sibling.packagePath}/package.json`)] as const,
      ...(sibling.distTarget === undefined ? [] : ([['dist', sibling.distTarget]] as const)),
      ...siblingSources.map((source): readonly [string, string] => [
        source,
        sourceLabel(`${sibling.packagePath}/${source}`),
      ]),
    ].toSorted(([left], [right]) => compareStrings({ left, right }))
    return {
      packageName: sibling.packageName,
      packagePath: sibling.packagePath,
      sourceRoots: sibling.sourceRoots ?? [],
      files,
    }
  })
  const semanticInputs = [
    ...commonSemanticInputs,
    projectionSource,
    `${packagePath}/package.json.genie.ts`,
    `${packagePath}/tsconfig.json.genie.ts`,
    ...(projectFile === 'tsconfig.json' ? [] : [`${packagePath}/${projectFile}.genie.ts`]),
    ...sourceRoots.flatMap((sourceRoot) =>
      sourceExtensions.map((extension) => `${packagePath}/${sourceRoot}/**/*${extension}`),
    ),
    // The same source roots also carry the collectable modules and snapshot baselines the
    // package tree stages, so their globs belong in the projection's input set.
    ...sourceRoots.flatMap((sourceRoot) => [
      `${packagePath}/${sourceRoot}/**/${snapshotDirectoryName}/*${snapshotExtension}`,
      ...nonSourceCollectableTestExtensions.flatMap((extension) => [
        `${packagePath}/${sourceRoot}/**/*.spec${extension}`,
        `${packagePath}/${sourceRoot}/**/*.test${extension}`,
      ]),
    ]),
    ...testDataRoots.flatMap((dataRoot) =>
      dataRoot.extensions.map(
        (extension) => `${packagePath}/${dataRoot.root}/**/*${extension}`,
      ),
    ),
    ...workspaceSiblingProjections.flatMap((sibling) => [
      `${sibling.packagePath}/package.json.genie.ts`,
      ...sibling.sourceRoots.flatMap((sourceRoot) =>
        sourceExtensions.map(
          (extension) => `${sibling.packagePath}/${sourceRoot}/**/*${extension}`,
        ),
      ),
    ]),
    ...[...buckPackagePaths].map((buckPackagePath) => `${buckPackagePath}/BUCK.genie.ts`),
  ].toSorted((left, right) => compareStrings({ left, right }))

  const data = {
    buckPackagePaths: [...buckPackagePaths].toSorted((left, right) =>
      compareStrings({ left, right }),
    ),
    dependencyView,
    packageName,
    packagePath,
    packageSources,
    collectableTestModules,
    snapshotBaselines,
    declarationSources,
    packageTreeRuntime: packageTreeRuntime.label,
    packageTreeRuntimeEntry: runtimeEntry,
    projectFile,
    sourceRoots,
    testDataFiles,
    testDataRoots,
    testPackageFiles: testPackageFileEntries.map(([destination]) => destination),
    testTargets: testTargets.map((target) => target.semanticData),
    visibility,
    workspaceSiblingProjections,
  }
  const fingerprint = buck2SemanticFingerprint({
    generator: 'effect-utils/genie/buck2-typescript-package-projection',
    schemaVersion: 6,
    semanticData: data,
  })

  const stringify = (): string => {
    const lines = [
      `# Projection source: ${projectionSource}`,
      '# Projection schema version: 6',
      '# Projection generator: effect-utils/genie/buck2-typescript-package-projection',
      `# Semantic fingerprint: ${fingerprint}`,
      `# Semantic inputs: ${semanticInputs.join(', ')}`,
      `# Regenerate: ${regenerationCommand}`,
      '',
      'load("//buck2:materialization.bzl", "export_materialization_inputs", "package_view")',
      'load("//buck2:editor_view.bzl", "editor_view_inputs")',
      ...(testTargets.length === 0
        ? []
        : [
            `load("//buck2:javascript.bzl", ${[...new Set(testTargets.map((target) => target.rule))]
              .toSorted((left, right) => compareStrings({ left, right }))
              .map((rule) => starlarkString(rule))
              .join(', ')})`,
          ]),
      'load("//buck2:typescript.bzl", "tsgo_emit", "tsgo_typecheck")',
      '',
      'export_file(',
      '    name = "package.json",',
      '    src = "package.json",',
      renderBuck2Visibility({ visibility }),
      ')',
      '',
      'export_materialization_inputs([',
      ...packageSources.map((source) => `    ${starlarkString(source)},`),
      '])',
      '',
      'alias(',
      '    name = "node_modules",',
      `    actual = ${starlarkString(dependencyView)},`,
      renderBuck2Visibility({ visibility }),
      ')',
      '',
      'alias(',
      '    name = "editor_inputs",',
      '    actual = ":node_modules",',
      renderBuck2Visibility({ visibility }),
      ')',
      '',
      'package_view(',
      '    name = "package_tree",',
      `    dependency_view = ${starlarkString(dependencyView)},`,
      ...renderMap({ name: 'files', entries: packageFileEntries }),
      `    runtime = ${starlarkString(packageTreeRuntime.label)},`,
      `    runtime_entry = ${starlarkString(runtimeEntry)},`,
      renderBuck2Visibility({ visibility }),
      ')',
      '',
      ...(testPackageFileEntries.length === 0
        ? []
        : [
            'package_view(',
            '    name = "test_package_tree",',
            `    dependency_view = ${starlarkString(dependencyView)},`,
            ...renderMap({ name: 'files', entries: testPackageFileEntries }),
            `    runtime = ${starlarkString(packageTreeRuntime.label)},`,
            `    runtime_entry = ${starlarkString(runtimeEntry)},`,
            renderBuck2Visibility({ visibility }),
            ')',
            '',
          ]),
      'editor_view_inputs(',
      '    name = "editor_view_inputs",',
      '    editor_inputs = ":editor_inputs",',
      '    package_tree = ":package_tree",',
      renderBuck2Visibility({ visibility }),
      ')',
      '',
      'tsgo_typecheck(',
      '    name = "typecheck",',
      '    package_tree = ":package_tree",',
      ...(projectFile === 'tsconfig.json' ? [] : [`    project = ${starlarkString(projectFile)},`]),
      renderBuck2Visibility({ visibility }),
      ')',
      '',
      'tsgo_emit(',
      '    name = "dist",',
      '    package_tree = ":package_tree",',
      ...renderMap({
        name: 'declaration_sources',
        entries: declarationSources.map((source) => [source, source]),
      }),
      ...(projectFile === 'tsconfig.json' ? [] : [`    project = ${starlarkString(projectFile)},`]),
      ...(authority === undefined
        ? []
        : [
            `    declaration_entrypoint = ${starlarkString(authority.declarationEntrypoint)},`,
          ]),
      renderBuck2Visibility({ visibility }),
      ')',
      '',
      ...testTargets.flatMap((target) => target.lines),
    ]
    return lines.join('\n')
  }

  return createGenieOutput({ data, stringify })
}
