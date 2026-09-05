import { existsSync, lstatSync, readdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import {
  createGenieOutput,
  type GenieOutput,
} from '../../packages/@overeng/genie/src/runtime/core.ts'
import { pnpmTargetName } from '../../buck2/dependencies/pnpm-lock.ts'
import { buck2SemanticFingerprint, renderBuck2Visibility } from './mod.ts'
import { packageTreeRuntime, stagedModuleName } from './runtime-modules.ts'

const regenerationCommand = 'devenv tasks run genie:run' as const
const sourceExtensions = ['.cts', '.js', '.jsx', '.mts', '.ts', '.tsx'] as const
const sourceExtensionSet: Readonly<Record<string, true>> = {
  '.cts': true,
  '.js': true,
  '.jsx': true,
  '.mts': true,
  '.ts': true,
  '.tsx': true,
}
const commonSemanticInputs = [
  'buck2/dependencies/BUCK.genie.ts',
  'buck2/dependencies/pnpm-lock.sha256.json.genie.ts',
  'genie/buck2/mod.ts',
  'genie/buck2/typescript-package-projection.ts',
  'package.json.genie.ts',
  // The package-tree runner and every module staged with it: a change to any of
  // them changes the action, so it must refresh the projection fingerprint.
  ...packageTreeRuntime.modules,
] as const

const compareStrings = ({ left, right }: { left: string; right: string }): number =>
  left < right ? -1 : left > right ? 1 : 0

const safeSourceSegment = (segment: string): boolean =>
  segment !== '' &&
  segment !== '.' &&
  segment !== '..' &&
  segment.includes('/') === false &&
  segment.includes('\\') === false &&
  /^[A-Za-z0-9._@+$-]+$/.test(segment)

const safeRelativePath = (value: string): boolean =>
  value.length > 0 &&
  path.isAbsolute(value) === false &&
  value.includes('\\') === false &&
  value.split('/').every((segment) => safeSourceSegment(segment))

const discoverPackageSources = ({
  packagePath,
  sourceFiles,
  sourceRoots,
}: {
  packagePath: string
  sourceFiles: readonly string[]
  sourceRoots: readonly string[]
}): readonly string[] => {
  const absoluteRoot = path.join(process.cwd(), packagePath)
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
      } else if (entry.isFile() === true && sourceExtensionSet[path.extname(entry.name)] === true) {
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
  for (const sourceFile of sourceFiles) {
    if (
      safeRelativePath(sourceFile) === false ||
      sourceExtensionSet[path.extname(sourceFile)] !== true
    ) {
      throw new Error(`Unsafe package source file: ${sourceFile}`)
    }
    const sourceStat = lstatSync(path.join(absoluteRoot, sourceFile))
    if (sourceStat.isSymbolicLink() === true || sourceStat.isFile() === false) {
      throw new Error(`Package source census refuses non-file: ${sourceFile}`)
    }
    sources.push(sourceFile)
  }
  if (sources.length === 0) throw new Error('Package source census found no TypeScript inputs')
  return [...new Set(sources)].toSorted((left, right) => compareStrings({ left, right }))
}

/**
 * One package-relative directory tree of non-source bytes a test reads at runtime.
 *
 * Fixtures are declared as a root plus the extensions admitted from it, never as the
 * whole package directory: a package view stays a bounded census of exactly the bytes
 * an action needs. The declaration is expanded by Buck's own `glob`, so a new fixture
 * under an already-declared root is an input without a projection rewrite.
 */
export type Buck2TestDataRoot = {
  readonly root: string
  readonly extensions: readonly string[]
}

/**
 * Validates declared test-data roots and returns their Buck glob patterns.
 *
 * Fails closed on a root that does not exist, an extension that names TypeScript
 * source (which the source census already owns), and a declaration that currently
 * matches nothing — a stale fixture declaration is a silently untested action input.
 */
const discoverTestDataPatterns = ({
  packagePath,
  testDataRoots,
}: {
  packagePath: string
  testDataRoots: readonly Buck2TestDataRoot[]
}): readonly string[] => {
  const absoluteRoot = path.join(process.cwd(), packagePath)
  const patterns: string[] = []

  const matches = (relativeDirectory: string, extension: string): boolean =>
    readdirSync(path.join(absoluteRoot, relativeDirectory), { withFileTypes: true }).some(
      (entry) => {
        if (safeSourceSegment(entry.name) === false) {
          throw new Error(`Unsafe test data path segment: ${entry.name}`)
        }
        if (entry.isSymbolicLink() === true) {
          throw new Error(
            `Test data census refuses symlink: ${path.posix.join(relativeDirectory, entry.name)}`,
          )
        }
        if (entry.isDirectory() === true) {
          return matches(path.posix.join(relativeDirectory, entry.name), extension)
        }
        return entry.isFile() === true && path.extname(entry.name) === extension
      },
    )

  for (const { root, extensions } of testDataRoots) {
    if (safeRelativePath(root) === false) throw new Error(`Unsafe test data root: ${root}`)
    const rootStat = lstatSync(path.join(absoluteRoot, root))
    if (rootStat.isSymbolicLink() === true || rootStat.isDirectory() === false) {
      throw new Error(`Test data root must be a directory: ${root}`)
    }
    if (extensions.length === 0) throw new Error(`Test data root declares no extensions: ${root}`)
    for (const extension of extensions) {
      if (/^\.[A-Za-z0-9]+$/.test(extension) === false) {
        throw new Error(`Unsafe test data extension: ${extension}`)
      }
      if (sourceExtensionSet[extension] === true) {
        throw new Error(`Test data extension is owned by the source census: ${extension}`)
      }
      if (matches(root, extension) === false) {
        throw new Error(`Declared test data matches no file: ${root}/**/*${extension}`)
      }
      patterns.push(`${root}/**/*${extension}`)
    }
  }
  return [...new Set(patterns)].toSorted((left, right) => compareStrings({ left, right }))
}

/**
 * The package's own genie generator sources, package-relative and sorted.
 *
 * These are the `*.genie.ts` declarations that produce the package's generated
 * artifacts. They are not TypeScript library sources — the source census owns
 * those — but the repository-root Vitest suite loads them as the authority it
 * asserts on, so each package exports them as one declared tree instead of
 * every consumer naming individual files across package boundaries.
 */
const discoverGeneratorSources = (packagePath: string): readonly string[] =>
  readdirSync(path.join(process.cwd(), packagePath), { withFileTypes: true })
    .filter((entry) => {
      if (entry.name.endsWith('.genie.ts') === false) return false
      if (safeSourceSegment(entry.name) === false) {
        throw new Error(`Unsafe generator source path segment: ${entry.name}`)
      }
      if (entry.isSymbolicLink() === true) {
        throw new Error(`Generator source census refuses symlink: ${entry.name}`)
      }
      return entry.isFile()
    })
    .map((entry) => entry.name)
    .toSorted((left, right) => compareStrings({ left, right }))

const starlarkString = (value: string): string => JSON.stringify(value)

const renderMap = ({
  name,
  entries,
  merge,
}: {
  name: string
  entries: readonly (readonly [string, string])[]
  /** Starlark expression unioned onto the literal mapping, for glob-expanded inputs. */
  merge?: string
}): readonly string[] => [
  `    ${name} = {`,
  ...entries.map(
    ([destination, source]) => `        ${starlarkString(destination)}: ${starlarkString(source)},`,
  ),
  merge === undefined ? '    },' : `    } | ${merge},`,
]

export type Buck2WorkspaceSibling = {
  readonly packageName: string
  readonly packagePath: string
  readonly distTarget?: `${string}//${string}:dist`
  readonly sourceRoots?: readonly string[]
}

export type Buck2TypeScriptAuthorityMetadata = {
  readonly declarationEntrypoint?: string
  readonly projectFile: string
}

export type Buck2TypeScriptAdditionalProject = {
  readonly projectFile: string
  readonly sourceFiles?: readonly string[]
  readonly sourceRoots?: readonly string[]
  readonly targetName: `typecheck_${string}`
}

export type Buck2TypeScriptPackageProjection = {
  readonly dependencyImporter: `//buck2/dependencies:importer_${string}`
  readonly packageName: string
  readonly packagePath: string
  readonly projectionSource: string
  readonly sourceFiles?: readonly string[]
  readonly sourceRoots: readonly string[]
  readonly resourceFiles?: readonly string[]
  readonly testDataRoots?: readonly Buck2TestDataRoot[]
  readonly additionalTypecheckProjects?: readonly Buck2TypeScriptAdditionalProject[]
  readonly workspaceSiblings?: readonly Buck2WorkspaceSibling[]
  readonly authority?: Buck2TypeScriptAuthorityMetadata
}
/** Canonical normalized dependency-view label for one pnpm workspace importer. */
export const buck2DependencyViewLabel = (
  packagePath: string,
): `//buck2/dependencies:view_${string}` =>
  `//buck2/dependencies:${pnpmTargetName({
    prefix: 'view',
    identity: packagePath,
  })}` as `//buck2/dependencies:view_${string}`


export const buck2TypeScriptPackageProjection = ({
  packageName,
  packagePath,
  projectionSource,
  sourceFiles = [],
  sourceRoots,
  resourceFiles = [],
  testDataRoots = [],
  additionalTypecheckProjects = [],
  workspaceSiblings = [],
  authority,
}: Buck2TypeScriptPackageProjection): GenieOutput<unknown> => {
  const projectFile = authority?.projectFile ?? 'tsconfig.json'
  const typecheckProjects = [
    { projectFile, targetName: 'typecheck' as const },
    ...additionalTypecheckProjects,
  ]
  for (const project of typecheckProjects) {
    if (safeSourceSegment(project.projectFile) === false) {
      throw new Error(`Unsafe package project file: ${project.projectFile}`)
    }
  }
  const allSourceRoots = [
    ...new Set([
      ...sourceRoots,
      ...additionalTypecheckProjects.flatMap((project) => project.sourceRoots ?? []),
    ]),
  ]
  const allSourceFiles = [
    ...new Set([
      ...sourceFiles,
      ...additionalTypecheckProjects.flatMap((project) => project.sourceFiles ?? []),
    ]),
  ]
  const packageSources = discoverPackageSources({
    packagePath,
    sourceFiles: allSourceFiles,
    sourceRoots: allSourceRoots,
  })
  for (const resourceFile of resourceFiles) {
    if (safeRelativePath(resourceFile) === false) {
      throw new Error(`Unsafe package resource file: ${resourceFile}`)
    }
    const resourceStat = lstatSync(path.join(process.cwd(), packagePath, resourceFile))
    if (resourceStat.isSymbolicLink() === true || resourceStat.isFile() === false) {
      throw new Error(`Package resource census refuses non-file: ${resourceFile}`)
    }
  }
  const testDataPatterns = discoverTestDataPatterns({ packagePath, testDataRoots })
  const generatorSources = discoverGeneratorSources(packagePath)
  const declarationSources = packageSources.filter((source) => source.endsWith('.d.ts'))
  const buckPackagePaths = new Set(
    [packagePath, ...workspaceSiblings.map((sibling) => sibling.packagePath)].filter((candidate) =>
      existsSync(path.join(process.cwd(), candidate, 'BUCK.genie.ts')),
    ),
  )
  const dependencyView = buck2DependencyViewLabel(packagePath)
  const visibility = ['PUBLIC'] as const
  const runtimeEntry = stagedModuleName(packageTreeRuntime.entry)
  const exportedInputTarget = (source: string): string => source.replaceAll('$', '__dollar__')
  const sourceLabel = (repoRelativePath: string): string => {
    if (repoRelativePath.startsWith(`${packagePath}/`) === true) {
      return exportedInputTarget(repoRelativePath.slice(packagePath.length + 1))
    }
    const sourcePackage = [...buckPackagePaths]
      .filter((candidate) => repoRelativePath.startsWith(`${candidate}/`) === true)
      .toSorted((left, right) => right.length - left.length || compareStrings({ left, right }))[0]
    if (sourcePackage !== undefined) {
      return `//${sourcePackage}:${exportedInputTarget(repoRelativePath.slice(sourcePackage.length + 1))}`
    }
    return `//:${exportedInputTarget(repoRelativePath)}`
  }
  const projectFileEntries = typecheckProjects
    .filter((project) => project.projectFile !== 'tsconfig.json')
    .map(({ projectFile }): readonly [string, string] => [projectFile, projectFile])
  const packageFileEntries = [
    ...packageSources.map((source): readonly [string, string] => [source, source]),
    ...resourceFiles.map((resource): readonly [string, string] => [resource, resource]),
    ['package.json', 'package.json'] as const,
    ['tsconfig.json', 'tsconfig.json'] as const,
    ...projectFileEntries,
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
            sourceFiles: [],
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
    `${packagePath}/*.genie.ts`,
    ...typecheckProjects
      .filter(({ projectFile }) => projectFile !== 'tsconfig.json')
      .map(({ projectFile }) => `${packagePath}/${projectFile}.genie.ts`),
    ...allSourceRoots.flatMap((sourceRoot) =>
      sourceExtensions.map((extension) => `${packagePath}/${sourceRoot}/**/*${extension}`),
    ),
    ...allSourceFiles.map((sourceFile) => `${packagePath}/${sourceFile}`),
    ...resourceFiles.map((resource) => `${packagePath}/${resource}`),
    ...testDataPatterns.map((pattern) => `${packagePath}/${pattern}`),
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
    declarationSources,
    packageTreeRuntime: packageTreeRuntime.label,
    packageTreeRuntimeEntry: runtimeEntry,
    sourceFiles,
    sourceRoots,
    resourceFiles,
    generatorSources,
    testDataPatterns,
    typecheckProjects,
    visibility,
    workspaceSiblingProjections,
  }
  const fingerprint = buck2SemanticFingerprint({
    generator: 'effect-utils/genie/buck2-typescript-package-projection',
    schemaVersion: 5,
    semanticData: data,
  })


  const stringify = (): string => {
    const lines = [
      `# Projection source: ${projectionSource}`,
      '# Projection schema version: 5',
      '# Projection generator: effect-utils/genie/buck2-typescript-package-projection',
      `# Semantic fingerprint: ${fingerprint}`,
      `# Semantic inputs: ${semanticInputs.join(', ')}`,
      `# Regenerate: ${regenerationCommand}`,
      '',
      'load("//buck2:materialization.bzl", "export_materialization_inputs", "package_view")',
      'load("//buck2:editor_view.bzl", "editor_view_inputs")',
      'load("//buck2:typescript.bzl", "tsgo_emit", "tsgo_typecheck")',
      '',
      'export_file(',
      '    name = "package.json",',
      '    src = "package.json",',
      renderBuck2Visibility({ visibility }),
      ')',
      '',
      // The repository-root suite asserts over generated Buck declarations (which
      // inputs a package owns, which cell labels it names), so this file is a
      // declared input of that action rather than only this projection's output.
      'export_file(',
      '    name = "BUCK",',
      '    src = "BUCK",',
      renderBuck2Visibility({ visibility }),
      ')',
      '',
      'export_materialization_inputs([',
      ...[...packageSources, ...resourceFiles].map((source) => `    ${starlarkString(source)},`),
      '])',
      '',
      ...(testDataPatterns.length === 0
        ? []
        : [
            '# Declared test data: fixture bytes a test reads at runtime, admitted by glob so a',
            '# new fixture under a declared root is an action input without a projection rewrite.',
            '# An empty match fails the package instead of silently dropping a declared input.',
            'package_test_data = {',
            '    source: source',
            `    for source in glob([${testDataPatterns.map(starlarkString).join(', ')}])`,
            `} or fail("declared test data matched no file: ${packagePath}")`,
            '',
          ]),
      // The repository-root suite re-derives this projection from the real
      // source tree, so the projection's own declared inputs — this package's
      // generator sources plus its source census — are that suite's inputs.
      // One tree per package keeps the composition at package granularity
      // instead of naming individual files across package boundaries.
      '# Projection inputs this package owns, exported as one tree.',
      'filegroup(',
      '    name = "projection_inputs",',
      ...renderMap({
        name: 'srcs',
        entries: [
          ...generatorSources.map((source): readonly [string, string] => [source, source]),
          ...packageFileEntries,
        ].toSorted(([left], [right]) => compareStrings({ left, right })),
        ...(testDataPatterns.length === 0 ? {} : { merge: 'package_test_data' }),
      }),
      renderBuck2Visibility({ visibility }),
      ')',
      '',
      'alias(',
      '    name = "editor_inputs",',
      `    actual = ${starlarkString(dependencyView)},`,
      renderBuck2Visibility({ visibility }),
      ')',
      '',
      'package_view(',
      '    name = "package_tree",',
      `    dependency_view = ${starlarkString(dependencyView)},`,
      ...renderMap({
        name: 'files',
        entries: packageFileEntries,
        ...(testDataPatterns.length === 0 ? {} : { merge: 'package_test_data' }),
      }),
      `    runtime = ${starlarkString(packageTreeRuntime.label)},`,
      `    runtime_entry = ${starlarkString(runtimeEntry)},`,
      renderBuck2Visibility({ visibility }),
      ')',
      'editor_view_inputs(',
      '    name = "editor_view_inputs",',
      '    editor_inputs = ":editor_inputs",',
      '    package_tree = ":package_tree",',
      renderBuck2Visibility({ visibility }),
      ')',
      '',
      ...typecheckProjects.flatMap(({ projectFile: typecheckProjectFile, targetName }) => [
        'tsgo_typecheck(',
        `    name = ${starlarkString(targetName)},`,
        '    package_tree = ":package_tree",',
        ...(typecheckProjectFile === 'tsconfig.json'
          ? []
          : [`    project = ${starlarkString(typecheckProjectFile)},`]),
        renderBuck2Visibility({ visibility }),
        ')',
        '',
      ]),
      '',
      'tsgo_emit(',
      '    name = "dist",',
      '    package_tree = ":package_tree",',
      ...renderMap({
        name: 'declaration_sources',
        entries: declarationSources.map((source) => [source, source]),
      }),
      ...(projectFile === 'tsconfig.json' ? [] : [`    project = ${starlarkString(projectFile)},`]),
      ...(authority?.declarationEntrypoint === undefined
        ? []
        : [
            `    declaration_entrypoint = ${starlarkString(authority.declarationEntrypoint)},`,
          ]),
      renderBuck2Visibility({ visibility }),
      ')',
      '',
    ]
    return lines.join('\n')
  }

  return createGenieOutput({ data, stringify })
}
