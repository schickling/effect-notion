import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { buck2TypeScriptAdmissions } from './typescript-admissions.ts'

/**
 * Repository-root layout the root Vitest suite runs against.
 *
 * The suite under `genie/buck2` and `buck2/dependencies` imports repository
 * sources by their original relative paths (`../../packages/@overeng/genie/...`),
 * so the Buck test tree has to reproduce those paths — a Buck action sees only
 * what its rule declares, and an undeclared module fails closed with
 * `Cannot find module`.
 *
 * The layout is composed, never enumerated by hand: every module reachable from
 * the suite through relative imports is derived here, then attributed to the
 * Buck package that owns it. A package contributes its generator sources as one
 * declared tree (`:generator_sources`), individual library modules come from the
 * per-package exported inputs the TypeScript projection already emits, and
 * root-package generator directories are carried by trees the root `BUCK`
 * exports. Nothing admits a directory the suite does not load.
 */

/** Directories whose TypeScript modules are the suite's entry points. */
export const rootTestSuiteDirectories = ['buck2/dependencies', 'genie/buck2'] as const

/** Buck package that owns the suite itself; its sources are globbed locally. */
export const rootTestSuitePackage = 'genie/buck2'

/** Buck target each package exports its own projection inputs under. */
export const projectionInputsTarget = 'projection_inputs'

/**
 * Test modules owned by another package but executed by the root suite.
 *
 * Each of these asserts a repository-wide contract rather than package-local
 * behaviour: the CI-workflow suites assert that generator sources, generated
 * workflows and emitted CI scripts agree with each other, and the telemetry
 * suites walk every `*.contract.ts` seam in the repository and compare it with
 * the aggregator. Their inputs are the repository layout, which only the root
 * test tree reproduces, so target ownership lives here while the files stay
 * physically in the package that owns the code they assert on. Each is excluded
 * from its package-local test target, and no second repository-shaped data view
 * is declared for them.
 */
export const rootTestRepositoryContractModules = [
  'packages/@overeng/genie/src/runtime/github-workflow/ci-runtime-scripts.unit.test.ts',
  'packages/@overeng/genie/src/runtime/github-workflow/ci-workflow-helpers.unit.test.ts',
  'packages/@overeng/otel-contract/src/raw-otel-boundary.unit.test.ts',
  'packages/@overeng/otel-contract/src/registry-seam.unit.test.ts',
] as const

/** Directories the root Vitest target additionally collects tests from. */
export const rootTestContractDirectories = [
  ...new Set(rootTestRepositoryContractModules.map((module) => path.posix.dirname(module))),
]

/** One repository directory whose non-module bytes the suite reads by path. */
export type RootTestDataRoot = {
  /** Repository-relative directory the census walks. */
  readonly root: string
  /** File extensions admitted from that tree. */
  readonly extensions: readonly string[]
  /** Repository-relative subtrees the census skips, each owning its own Buck package. */
  readonly excludedPrefixes?: readonly string[]
}

/**
 * Directory censuses the suite reads as data rather than importing.
 *
 * `ci-runtime-scripts.unit.test.ts` walks every generator source and every
 * generated workflow to prove that each CI script a step invokes is one the
 * support-file generator emits. That assertion is only as complete as the files
 * the action can see, so the declaration is the whole directory census rather
 * than the suite's import closure. `genie/buck2` is excluded because it is the
 * suite's own Buck package, which globs its sources locally.
 */
export const rootTestDataRoots: readonly RootTestDataRoot[] = [
  { root: '.github/workflows', extensions: ['.yml'] },
  { root: 'genie', extensions: ['.mjs', '.sh', '.ts'], excludedPrefixes: ['genie/buck2'] },
  // The lockfile names these through `patchedDependencies`, and translating the
  // real lockfile checks each patch exists. Their owning package declares them
  // as resource files, which is what makes each one addressable here.
  { root: 'packages/@overeng/utils/patches', extensions: ['.patch'] },
]

/**
 * Individual repository files the suite reads by path.
 *
 * The lockfile pair is the real input of the dependency-store projection tests,
 * and the generated Starlark and `BUCK` text is what the projection assertions
 * compare against; the devenv task modules and the toolchain `BUCK` are what the
 * CI-workflow contract suites hold the generated workflow steps to.
 */
export const rootTestDataFiles = [
  '.github/repo-settings.json',
  'BUCK',
  'buck2/dependencies/BUCK',
  'buck2/dependencies/pnpm-lock.sha256.json',
  'buck2/materialization.bzl',
  'buck2/platforms/defs.bzl',
  'buck2/products/defs.bzl',
  'buck2/root_test_layout.bzl',
  'buck2/toolchains/BUCK',
  'buck2/toolchains/configured.bzl',
  'buck2/typescript.bzl',
  'devenv.nix',
  'genie/buck2/BUCK',
  'genie/ci-scripts/buck2-candidate-graph.txt',
  'nix/buck2-products/products.json',
  'nix/devenv-modules/tasks/shared/megarepo.nix',
  'nix/devenv-modules/tasks/shared/netlify.nix',
  'nix/devenv-modules/tasks/shared/vercel.nix',
  'nix/devenv-modules/tasks/shared/workflow-report-module.nix',
  'packages/@overeng/buck2-tools/BUCK',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
] as const

/** One staged destination and the Buck label that supplies it. */
export type RootTestLayoutEntry = {
  /** Path inside the test tree, identical to the repository-relative path. */
  readonly destination: string
  /** Buck label providing the file or directory staged at `destination`. */
  readonly label: string
}

/** One root-package generator directory exported as a single tree. */
export type RootTestRootTree = {
  /** Repository-relative directory the tree reproduces. */
  readonly prefix: string
  /** Tree-relative destination to repository-relative source. */
  readonly files: readonly (readonly [string, string])[]
}

/** Complete, derived staging plan for the root test package tree. */
export type RootTestLayout = {
  /** Every module the suite loads through relative imports, sorted. */
  readonly modules: readonly string[]
  /** Directory trees mounted at their repository paths. */
  readonly sourceTrees: readonly RootTestLayoutEntry[]
  /** Individual modules staged from per-package exported inputs. */
  readonly sourceFiles: readonly RootTestLayoutEntry[]
  /** Root-package generator directories the root `BUCK` exports as trees. */
  readonly rootTrees: readonly RootTestRootTree[]
  /** Root-package modules exported individually because they sit at the root. */
  readonly rootFiles: readonly string[]
  /** Repository files the suite reads as data, staged at their repository paths. */
  readonly dataFiles: readonly RootTestLayoutEntry[]
}

const compare = ({ left, right }: { left: string; right: string }): number =>
  left < right ? -1 : left > right ? 1 : 0

const fail = (message: string): never => {
  throw new Error(`Invalid root test layout: ${message}`)
}

const repositoryPath = (repoRelativePath: string): string =>
  path.join(process.cwd(), repoRelativePath)

/** Root `BUCK` target name carrying one root-package generator directory. */
export const rootTestSourcesTarget = (prefix: string): string => `root_test_sources/${prefix}`

/**
 * Buck packages outside the admission registry that export data the suite reads.
 *
 * Ownership decides where a staged data file comes from, because Buck refuses a
 * source that lives inside a subpackage. It is declared rather than probed from
 * disk so the plan is identical whether it is derived in the repository or
 * re-derived inside the test tree, which stages data files but no `BUCK` files
 * of the packages that own them.
 */
const dataOwnerPackages = [
  'buck2/dependencies',
  'buck2/platforms',
  'buck2/products',
  'buck2/toolchains',
  'genie/buck2',
  'nix/devenv-modules',
  ...Object.values(buck2TypeScriptAdmissions).map(({ packagePath }) => packagePath),
].toSorted((left, right) => right.length - left.length || compare({ left, right }))

/** Buck package that owns one repository file, or `undefined` for the root package. */
const owningBuckPackage = (repoRelativePath: string): string | undefined =>
  dataOwnerPackages.find((candidate) => repoRelativePath.startsWith(`${candidate}/`) === true)

/** Declared data files, expanded from the directory censuses and the explicit list. */
const declaredDataPaths = (): readonly string[] => {
  const paths = new Set<string>(rootTestDataFiles)
  for (const { root, extensions, excludedPrefixes = [] } of rootTestDataRoots) {
    const before = paths.size
    const walk = (directory: string): void => {
      if (excludedPrefixes.some((prefix) => directory === prefix) === true) return
      for (const entry of readdirSync(repositoryPath(directory), { withFileTypes: true })) {
        const entryPath = `${directory}/${entry.name}`
        if (entry.isDirectory() === true) {
          walk(entryPath)
        } else if (
          entry.isFile() === true &&
          extensions.includes(path.posix.extname(entry.name)) === true
        ) {
          paths.add(entryPath)
        }
      }
    }
    walk(root)
    if (paths.size === before) fail(`data root ${root} contributed no file`)
  }
  for (const dataPath of paths) {
    if (existsSync(repositoryPath(dataPath)) === false) {
      fail(`declared data file ${dataPath} does not exist`)
    }
  }
  return [...paths].toSorted((left, right) => compare({ left, right }))
}

/**
 * Every repository module reachable from the suite through relative imports.
 *
 * Comments are removed first: this repository documents module usage with
 * `import` examples inside doc comments, and those examples name paths that do
 * not exist relative to the documenting file. An unresolvable specifier inside
 * a test module is fixture text — those tests write throwaway modules into
 * temporary directories and assert on a closure walker — so it is skipped. In
 * any other module an unresolvable specifier is a broken import and fails the
 * projection instead of silently dropping an input.
 */
const relativeImportClosure = (entries: readonly string[]): readonly string[] => {
  const seen = new Set<string>()
  const pending = [...entries]
  while (pending.length > 0) {
    const module = pending.pop() ?? fail('empty module queue')
    if (seen.has(module) === true) continue
    seen.add(module)
    const isTestModule = module.includes('.test.') === true
    const source = readFileSync(repositoryPath(module), 'utf8')
      .replaceAll(/\/\*[\s\S]*?\*\//gu, '')
      .replaceAll(/^[\t ]*\/\/[^\n]*$/gmu, '')
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]*)['"]/gu)) {
      const specifier = match[1] ?? ''
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(module), specifier))
      if (existsSync(repositoryPath(resolved)) === false) {
        if (isTestModule === true) continue
        return fail(`${module} imports ${specifier}, which does not resolve to ${resolved}`)
      }
      pending.push(resolved)
    }
  }
  return [...seen].toSorted((left, right) => compare({ left, right }))
}

/** Admitted packages that own repository sources, longest path first. */
const admissionsByPathLength = Object.values(buck2TypeScriptAdmissions).toSorted(
  (left, right) =>
    right.packagePath.length - left.packagePath.length ||
    compare({ left: left.packagePath, right: right.packagePath }),
)

const buildRootTestLayout = (): RootTestLayout => {
  const modules = relativeImportClosure([
    ...rootTestSuiteDirectories.flatMap((directory) =>
      readdirSync(repositoryPath(directory))
        .filter((entry) => entry.endsWith('.ts') === true)
        .map((entry) => `${directory}/${entry}`),
    ),
    ...rootTestRepositoryContractModules,
  ])
  const sourceTrees = new Map<string, string>()
  const sourceFiles: RootTestLayoutEntry[] = []
  const rootTreeFiles = new Map<string, Map<string, string>>()
  const rootFiles: string[] = []

  for (const module of modules) {
    if (module.startsWith(`${rootTestSuitePackage}/`) === true) {
      // The suite's own Buck package globs its `*.ts`; anything else it loads
      // (a JSON manifest, for instance) is staged from the same package.
      if (module.endsWith('.ts') !== true) {
        sourceFiles.push({
          destination: module,
          label: module.slice(rootTestSuitePackage.length + 1),
        })
      }
      continue
    }

    const dependencySibling = rootTestSuiteDirectories.find(
      (directory) =>
        directory !== rootTestSuitePackage && module.startsWith(`${directory}/`) === true,
    )
    if (dependencySibling !== undefined) {
      sourceFiles.push({
        destination: module,
        label: `//${dependencySibling}:${module.slice(dependencySibling.length + 1)}`,
      })
      continue
    }

    const admission = admissionsByPathLength.find(
      ({ packagePath }) => module.startsWith(`${packagePath}/`) === true,
    )
    if (admission !== undefined) {
      const { packagePath, sourceRoots } = admission
      const packageRelativePath = module.slice(packagePath.length + 1)
      const isGeneratorSource =
        path.posix.dirname(module) === packagePath && module.endsWith('.genie.ts') === true
      const isDeclaredSource = sourceRoots.some(
        (root) => packageRelativePath.startsWith(`${root}/`) === true,
      )
      if (isGeneratorSource !== true && isDeclaredSource !== true) {
        return fail(
          `${module} is neither a generator source nor inside ${packagePath}'s declared source roots (${sourceRoots.join(', ')})`,
        )
      }
      // The whole package contributes one tree: the suite re-derives each
      // package's projection from its census, so a single module of a package
      // is never enough — the projection reads the declared roots themselves.
      sourceTrees.set(packagePath, `//${packagePath}:${projectionInputsTarget}`)
      continue
    }

    // Root Buck package: a generator directory becomes one exported tree, and a
    // module sitting directly at the repository root is exported by itself.
    if (module.includes('/') !== true) {
      rootFiles.push(module)
      sourceFiles.push({ destination: module, label: `//:${module}` })
      continue
    }
    const prefix = module.slice(0, module.indexOf('/'))
    const files = rootTreeFiles.get(prefix) ?? new Map<string, string>()
    files.set(module.slice(prefix.length + 1), module)
    rootTreeFiles.set(prefix, files)
    sourceTrees.set(prefix, `//:${rootTestSourcesTarget(prefix)}`)
  }

  // Declared data: repository bytes the suite reads by path instead of importing.
  // Ownership decides where they come from, because Buck refuses a source that
  // lives inside a subpackage. A root-owned file joins the export census its
  // prefix already uses, which keeps the staged paths identical to the
  // repository-relative ones the suite opens.
  const dataFiles: RootTestLayoutEntry[] = []
  const dataTrees: string[] = []
  for (const dataPath of declaredDataPaths()) {
    const owner = owningBuckPackage(dataPath)
    if (owner !== undefined) {
      dataFiles.push({
        destination: dataPath,
        label: `//${owner}:${dataPath.slice(owner.length + 1)}`,
      })
      continue
    }
    if (dataPath.includes('/') !== true) {
      rootFiles.push(dataPath)
      dataFiles.push({ destination: dataPath, label: `//:${dataPath}` })
      continue
    }
    const prefix = dataPath.slice(0, dataPath.indexOf('/'))
    const files = rootTreeFiles.get(prefix) ?? new Map<string, string>()
    files.set(dataPath.slice(prefix.length + 1), dataPath)
    rootTreeFiles.set(prefix, files)
    // A prefix the import closure already mounts is staged exactly once.
    if (sourceTrees.has(prefix) !== true && dataTrees.includes(prefix) !== true) {
      dataTrees.push(prefix)
      dataFiles.push({ destination: prefix, label: `//:${rootTestSourcesTarget(prefix)}` })
    }
  }

  return {
    modules,
    dataFiles: dataFiles.toSorted((left, right) =>
      compare({ left: left.destination, right: right.destination }),
    ),
    rootFiles: rootFiles.toSorted((left, right) => compare({ left, right })),
    rootTrees: [...rootTreeFiles]
      .map(([prefix, files]) => ({
        prefix,
        files: [...files].toSorted(([left], [right]) => compare({ left, right })),
      }))
      .toSorted((left, right) => compare({ left: left.prefix, right: right.prefix })),
    sourceFiles: sourceFiles.toSorted((left, right) =>
      compare({ left: left.destination, right: right.destination }),
    ),
    sourceTrees: [...sourceTrees]
      .map(([destination, label]) => ({ destination, label }))
      .toSorted((left, right) => compare({ left: left.destination, right: right.destination })),
  }
}

/** Derived staging plan shared by the generated Buck artifacts and their tests. */
export const rootTestLayout: RootTestLayout = buildRootTestLayout()
