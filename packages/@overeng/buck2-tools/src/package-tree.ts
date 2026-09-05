#!/usr/bin/env -S bun
import {
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { canonicalizePath } from './real-path.ts'

/**
 * How one package view obtains its `node_modules` boundary.
 *
 * `copy` is the legacy per-importer closure projection: every dependency byte
 * is duplicated into the package tree. `link` is the normalized-store form: the
 * view owns only package sources and workspace dist boundaries and reaches its
 * dependencies through one relative link to a metadata-only importer view.
 */
export type PackageTreeDependencies =
  | { readonly kind: 'empty' }
  | { readonly kind: 'copy'; readonly path: string }
  | { readonly kind: 'link'; readonly path: string }

/** Explicit inputs and destination for one immutable Buck package-tree projection. */
export type PackageTreeOptions = {
  readonly output: string
  readonly dependencies: PackageTreeDependencies
  readonly files: ReadonlyMap<string, string>
  readonly workspaceFiles: ReadonlyMap<string, string>
  readonly workspaceLinks: ReadonlyMap<string, string>
}

const invalidArguments = (message: string): never => {
  throw new Error(`package tree: ${message}`)
}

const requireValue = ({
  args,
  index,
  flag,
}: {
  readonly args: readonly string[]
  readonly index: number
  readonly flag: string
}): string => args[index] ?? invalidArguments(`missing value for ${flag}`)

const requireRelativePath = ({
  value,
  field,
}: {
  readonly value: string
  readonly field: string
}): string => {
  if (
    value.length === 0 ||
    isAbsolute(value) === true ||
    value.includes('\\') === true ||
    value
      .split('/')
      .some((component) => component === '' || component === '.' || component === '..') === true
  ) {
    invalidArguments(`${field} must be a normalized portable relative path: ${value}`)
  }
  return value
}

const setUnique = ({
  values,
  key,
  value,
  field,
}: {
  readonly values: Map<string, string>
  readonly key: string
  readonly value: string
  readonly field: string
}): void => {
  if (values.has(key) === true) invalidArguments(`duplicate ${field}: ${key}`)
  values.set(key, value)
}

const parseOptions = (args: readonly string[]): PackageTreeOptions => {
  let output: string | undefined
  let dependencies: PackageTreeDependencies | undefined
  const files = new Map<string, string>()
  const workspaceFiles = new Map<string, string>()
  const workspaceLinks = new Map<string, string>()

  for (let index = 0; index < args.length; ) {
    const flag = requireValue({ args, index, flag: 'argument' })
    if (flag === '--file' || flag === '--workspace-file' || flag === '--workspace-link') {
      const destination = requireRelativePath({
        value: requireValue({ args, index: index + 1, flag }),
        field: `${flag} destination`,
      })
      const value = requireValue({ args, index: index + 2, flag })
      if (flag === '--workspace-link') requireRelativePath({ value, field: `${flag} target` })
      const values =
        flag === '--file' ? files : flag === '--workspace-file' ? workspaceFiles : workspaceLinks
      setUnique({ values, key: destination, value, field: flag })
      index += 3
      continue
    }
    const value = requireValue({ args, index: index + 1, flag })
    if (flag === '--output' && output === undefined) output = value
    else if (flag === '--empty-node-modules' && dependencies === undefined && value === 'true')
      dependencies = { kind: 'empty' }
    else if (flag === '--node-modules' && dependencies === undefined)
      dependencies = { kind: 'copy', path: value }
    else if (flag === '--dependency-view' && dependencies === undefined)
      dependencies = { kind: 'link', path: value }
    else invalidArguments(`unexpected argument: ${flag}`)
    index += 2
  }
  return {
    output: output ?? invalidArguments('missing --output'),
    dependencies:
      dependencies ??
      invalidArguments(
        'missing exactly one --empty-node-modules, --node-modules, or --dependency-view',
      ),
    files,
    workspaceFiles,
    workspaceLinks,
  }
}

const pathIsInside = ({
  root,
  candidate,
}: {
  readonly root: string
  readonly candidate: string
}): boolean => {
  const fromRoot = relative(root, candidate)
  return (
    fromRoot === '' ||
    (isAbsolute(fromRoot) === false &&
      fromRoot !== '..' &&
      fromRoot.startsWith(`..${sep}`) === false)
  )
}

const assertContainedSymlinks = ({
  allow,
  root,
}: {
  readonly allow: ReadonlySet<string>
  readonly root: string
}): void => {
  // Lexical targets are built from `root`, so they are compared against `root`;
  // `realpathSync` answers in the canonical namespace, so resolved targets are
  // compared against the canonical root. Comparing either against the other
  // root reports containment failures for paths that are plainly contained.
  const canonicalRoot = canonicalizePath(root)
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).toSorted((left, right) =>
      left.name.localeCompare(right.name, 'en'),
    )) {
      const path = join(directory, entry.name)
      if (entry.isDirectory() === true) {
        visit(path)
        continue
      }
      if (entry.isSymbolicLink() === false) continue

      const target = readlinkSync(path)
      const displayPath = relative(root, path).split(sep).join('/')
      if (isAbsolute(target) === true) {
        throw new Error(`package tree: unsafe symlink ${displayPath}: absolute target ${target}`)
      }
      if (allow.has(path) === true) {
        // A declared cross-artifact boundary: it must be relative and live, but
        // it is meant to leave this tree, so containment does not apply.
        statSync(path)
        continue
      }
      const lexicalDestination = resolve(dirname(path), target)
      if (pathIsInside({ root, candidate: lexicalDestination }) === false) {
        throw new Error(`package tree: unsafe symlink ${displayPath}: target escapes tree`)
      }

      let resolvedDestination: string
      try {
        resolvedDestination = realpathSync(path)
      } catch (error) {
        if (error instanceof Error && 'code' in error) {
          if (error.code === 'ELOOP') {
            throw new Error(`package tree: unsafe symlink ${displayPath}: target is cyclic`, {
              cause: error,
            })
          }
          if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
            throw new Error(`package tree: unsafe symlink ${displayPath}: target is dangling`, {
              cause: error,
            })
          }
        }
        throw error
      }
      if (pathIsInside({ root: canonicalRoot, candidate: resolvedDestination }) === false) {
        throw new Error(
          `package tree: unsafe symlink ${displayPath}: chained target resolves outside tree`,
        )
      }
    }
  }

  visit(root)
}

const cloneTree = ({
  source,
  destination,
}: {
  readonly source: string
  readonly destination: string
}): void => {
  const metadata = lstatSync(source)
  if (metadata.isDirectory() === true) {
    mkdirSync(destination, { recursive: true })
    for (const entry of readdirSync(source).toSorted()) {
      cloneTree({ source: join(source, entry), destination: join(destination, entry) })
    }
    return
  }
  mkdirSync(dirname(destination), { recursive: true })
  if (metadata.isSymbolicLink() === true) {
    symlinkSync(readlinkSync(source), destination)
  } else if (metadata.isFile() === true) {
    copyFileSync(source, destination, constants.COPYFILE_FICLONE)
  } else {
    throw new Error(`package tree: unsupported filesystem entry: ${source}`)
  }
}

const destinationInside = ({
  root,
  relativePath,
}: {
  readonly root: string
  readonly relativePath: string
}): string => {
  const destination = resolve(
    root,
    requireRelativePath({ value: relativePath, field: 'destination' }),
  )
  const fromRoot = relative(root, destination)
  if (fromRoot === '' || fromRoot.startsWith(`..${sep}`) === true || fromRoot === '..') {
    invalidArguments(`destination escapes package tree: ${relativePath}`)
  }
  return destination
}

/** Assembles one complete package tree from declared package and dependency artifacts. */
export const assemblePackageTree = (options: PackageTreeOptions): void => {
  const output = resolve(options.output)
  rmSync(output, { recursive: true, force: true })
  mkdirSync(output, { recursive: true })
  try {
    if (options.dependencies.kind === 'empty') {
      mkdirSync(join(output, 'node_modules'))
    } else if (options.dependencies.kind === 'copy') {
      cloneTree({ source: options.dependencies.path, destination: join(output, 'node_modules') })
    } else {
      // The dependency view is a separate declared artifact, so this first hop
      // deliberately leaves the package tree. It is the only outward link the
      // containment check accepts, and it is relative so the pair relocates
      // together.
      const link = join(output, 'node_modules')
      const relativeTarget = relative(output, resolve(options.dependencies.path))
      if (isAbsolute(relativeTarget) === true || relativeTarget.length === 0) {
        invalidArguments(
          `dependency view cannot be represented as a relative path: ${options.dependencies.path}`,
        )
      }
      symlinkSync(relativeTarget, link)
      statSync(link)
    }
    for (const [destination, source] of [...options.files, ...options.workspaceFiles]) {
      cloneTree({
        source,
        destination: destinationInside({ root: output, relativePath: destination }),
      })
    }
    for (const [linkPath, targetPath] of options.workspaceLinks) {
      const link = destinationInside({ root: output, relativePath: linkPath })
      const target = destinationInside({ root: output, relativePath: targetPath })
      rmSync(link, { recursive: true, force: true })
      mkdirSync(dirname(link), { recursive: true })
      const relativeTarget = relative(dirname(link), target)
      if (isAbsolute(relativeTarget) === true) {
        invalidArguments(
          `workspace link target cannot be represented as a relative path: ${targetPath}`,
        )
      }
      symlinkSync(relativeTarget, link)
      statSync(link)
    }
    assertContainedSymlinks({
      allow:
        options.dependencies.kind === 'link'
          ? new Set([join(output, 'node_modules')])
          : new Set<string>(),
      root: output,
    })
  } catch (error) {
    rmSync(output, { recursive: true, force: true })
    throw error
  }
}

/** Runs the package-tree command-line interface used by the Buck action. */
export const runPackageTreeCli = (args: readonly string[]): void => {
  assemblePackageTree(parseOptions(args))
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runPackageTreeCli(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
