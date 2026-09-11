import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, parse } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repo-local file access anchored at the repository that owns a generator module. */
export interface RepoContext {
  readonly name: string
  readonly rootPath: string
  readonly resolve: (...segments: ReadonlyArray<string>) => string
  readonly readText: (...segments: ReadonlyArray<string>) => string
  readonly readJson: <A = unknown>(...segments: ReadonlyArray<string>) => A
}

/** Inputs for deriving a repository context from a module's `import.meta.url`. */
export interface DefineRepoContextOptions {
  readonly name: string
  readonly importMetaUrl: string
}

/**
 * Repository markers, in the same order Genie's own generation core resolves a repo root:
 * a local megarepo config first, then `.git`. A generated tree can legitimately carry no
 * `.git` at all — `bootstrap:cold-proof` generates a `git archive` export of the committed
 * source — so anchoring on `.git` alone would refuse exactly the install-free tree the
 * proof exists to exercise.
 */
const repoRootMarkers = ['megarepo.kdl', 'megarepo.json', '.git'] as const

const findRepoRoot = (startPath: string): string | undefined => {
  let current = dirname(startPath)
  const root = parse(current).root

  while (true) {
    if (repoRootMarkers.some((marker) => existsSync(join(current, marker)) === true) === true) {
      return current
    }
    if (current === root) return undefined
    current = dirname(current)
  }
}

/** Find the closest repository root above the module identified by `importMetaUrl`. */
export const repoRootFromModuleUrl = (importMetaUrl: string): string => {
  const root = findRepoRoot(fileURLToPath(importMetaUrl))
  if (root === undefined) {
    throw new Error(`Could not find repository root for module ${importMetaUrl}`)
  }
  return root
}

/**
 * Absolute repository path of the module identified by `importMetaUrl`. Generator code that
 * needs its own repo-relative identity must use this rather than a `process.cwd()` relative
 * path: the Buck-built product runs with its own working directory, which is not the tree
 * being generated. The compiled product stages and bundles generator sources before import,
 * and pins each staged module's `import.meta` back to its original location, so the URL
 * reaching this function is always a real source path.
 */
export const modulePathFromUrl = (importMetaUrl: string): string => {
  const modulePath = fileURLToPath(importMetaUrl)
  if (findRepoRoot(modulePath) === undefined) {
    throw new Error(`Could not find repository root for module ${importMetaUrl}`)
  }
  return modulePath
}

/** Create a repo context for generator code that may run from aggregate megarepos. */
export const defineRepoContext = ({
  name,
  importMetaUrl,
}: DefineRepoContextOptions): RepoContext => {
  const rootPath = repoRootFromModuleUrl(importMetaUrl)
  const resolve = (...segments: ReadonlyArray<string>) => join(rootPath, ...segments)

  return {
    name,
    rootPath,
    resolve,
    readText: (...segments) => readFileSync(resolve(...segments), 'utf8'),
    readJson: <A = unknown>(...segments: ReadonlyArray<string>) =>
      JSON.parse(readFileSync(resolve(...segments), 'utf8')) as A,
  }
}
