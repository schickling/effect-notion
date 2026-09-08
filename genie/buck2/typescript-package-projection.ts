import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import {
  createGenieOutput,
  type GenieOutput,
} from '../../packages/@overeng/genie/src/runtime/core.ts'
import { buck2SemanticFingerprint, renderBuck2Visibility } from './mod.ts'
import { packageTreeRuntime, stagedModuleName } from './runtime-modules.ts'

const regenerationCommand = 'devenv tasks run genie:run' as const
const sourceExtensions = ['.cts', '.js', '.mts', '.ts', '.tsx'] as const
const sourceExtensionSet: Readonly<Record<string, true>> = {
  '.cts': true,
  '.js': true,
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
  /^[A-Za-z0-9._@+-]+$/.test(segment)

const discoverPackageSources = ({
  packagePath,
  sourceRoots,
}: {
  packagePath: string
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
  if (sources.length === 0) throw new Error('Package source census found no TypeScript inputs')
  return sources.toSorted((left, right) => compareStrings({ left, right }))
}

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
}

export const buck2TypeScriptPackageProjection = ({
  dependencyImporter,
  packageName,
  packagePath,
  projectionSource,
  sourceRoots,
  workspaceSiblings = [],
  authority,
}: Buck2TypeScriptPackageProjection): GenieOutput<unknown> => {
  const projectFile = authority?.projectFile ?? 'tsconfig.json'
  if (safeSourceSegment(projectFile) === false) {
    throw new Error(`Unsafe package project file: ${projectFile}`)
  }
  const packageSources = discoverPackageSources({ packagePath, sourceRoots })
  const declarationSources = packageSources.filter((source) => source.endsWith('.d.ts'))
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
  const projectFileEntries: readonly (readonly [string, string])[] =
    projectFile === 'tsconfig.json' ? [] : [[projectFile, projectFile]]
  const packageFileEntries = [
    ...packageSources.map((source): readonly [string, string] => [source, source]),
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
    projectFile,
    sourceRoots,
    visibility,
    workspaceSiblingProjections,
  }
  const fingerprint = buck2SemanticFingerprint({
    generator: 'effect-utils/genie/buck2-typescript-package-projection',
    schemaVersion: 2,
    semanticData: data,
  })

  const stringify = (): string => {
    const lines = [
      `# Projection source: ${projectionSource}`,
      '# Projection schema version: 2',
      '# Projection generator: effect-utils/genie/buck2-typescript-package-projection',
      `# Semantic fingerprint: ${fingerprint}`,
      `# Semantic inputs: ${semanticInputs.join(', ')}`,
      `# Regenerate: ${regenerationCommand}`,
      '',
      'load("//buck2:materialization.bzl", "export_materialization_inputs", "package_view")',
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
    ]
    return lines.join('\n')
  }

  return createGenieOutput({ data, stringify })
}
