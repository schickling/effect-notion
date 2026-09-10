import { createHash } from 'node:crypto'
import * as nodeFsSync from 'node:fs'
import nodeFs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { Duration, Effect, FileSystem, Option, Result, Schema, Stream } from 'effect'
import type { Path } from 'effect'
import type { PlatformError } from 'effect/PlatformError'
import * as Command from 'effect/unstable/process/ChildProcess'
import * as CommandExecutor from 'effect/unstable/process/ChildProcessSpawner'

import { DistributedSemaphore } from '@overeng/utils/lock'
import { FileSystemBacking } from '@overeng/utils/node'

import type { GenieOutput } from '../runtime/mod.ts'
import { CatalogConflictError } from '../runtime/package-json/catalog.ts'
import { ensureImportMapResolver, isCompiledBinary } from './discovery.ts'
import {
  GenieCheckError,
  GenieFileError,
  GenieImportError,
  InvalidOxfmtConfigError,
} from './errors.ts'
import { resolveImportMapsInSource } from './import-map/mod.ts'
import * as Observability from './observability.ts'
import type { GenerateSuccess, GenieContext } from './types.ts'

/** Loaded genie module plus base context reused across check and validation phases. */
export type LoadedGenieFile = {
  genieFilePath: string
  output: GenieOutput<unknown>
  ctx: GenieContext
}

type StagedCompiledBinaryImportGraph = {
  stagePath: string
  tempRoot: string
}

const IMPORT_SPECIFIER_REGEX = /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?(['"])([^'"]+)\1/g

const isRelativeImportSpecifier = (specifier: string): boolean =>
  specifier.startsWith('./') === true || specifier.startsWith('../') === true

const resolveRelativeImportPath = async ({
  importerPath,
  specifier,
}: {
  importerPath: string
  specifier: string
}): Promise<string | undefined> => {
  const resolvedBase = path.resolve(path.dirname(importerPath), specifier)
  const candidates = [
    resolvedBase,
    `${resolvedBase}.ts`,
    `${resolvedBase}.tsx`,
    `${resolvedBase}.mts`,
    `${resolvedBase}.cts`,
    `${resolvedBase}.js`,
    `${resolvedBase}.mjs`,
    path.join(resolvedBase, 'index.ts'),
    path.join(resolvedBase, 'index.tsx'),
    path.join(resolvedBase, 'mod.ts'),
    path.join(resolvedBase, 'mod.tsx'),
  ]

  const resolvedCandidates = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const stat = await nodeFs.stat(candidate)
        return stat.isFile() === true ? candidate : undefined
      } catch {
        return undefined
      }
    }),
  )

  return resolvedCandidates.find((candidate) => candidate !== undefined)
}

/**
 * Find the nearest `node_modules` directory by walking up from `fromPath`.
 *
 * Returns undefined when none exists — e.g. a cold bootstrap checkout before install. In that case
 * the staged graph gets no `node_modules` symlink and bare imports stay unresolvable, which is
 * correct: `bootstrap`-phase generators are statically guaranteed (see {@link checkBootstrapClosure})
 * never to reach a bare package, so only design-time generators (run post-install, node_modules
 * present) rely on the symlink below.
 */
const findNearestNodeModules = async (fromPath: string): Promise<string | undefined> => {
  let dir = path.dirname(fromPath)
  const { root } = path.parse(dir)
  for (;;) {
    const candidate = path.join(dir, 'node_modules')
    try {
      // Sequential walk-up: each level's check depends on the previous miss, so it cannot be parallelized.
      // oxlint-disable-next-line eslint/no-await-in-loop -- inherent to walking up the directory tree
      const stat = await nodeFs.stat(candidate)
      if (stat.isDirectory() === true) return candidate
    } catch {
      // No node_modules at this level — keep walking up.
    }
    if (dir === root) return undefined
    dir = path.dirname(dir)
  }
}

const collectRelativeImportPaths = async ({
  sourceCode,
  sourcePath,
}: {
  sourceCode: string
  sourcePath: string
}): Promise<string[]> => {
  const importSpecifierRegex = new RegExp(IMPORT_SPECIFIER_REGEX)
  const relativeSpecifiers: string[] = []
  let match: RegExpExecArray | null = importSpecifierRegex.exec(sourceCode)
  while (match !== null) {
    const specifier = match[2]
    if (specifier !== undefined && isRelativeImportSpecifier(specifier) === true) {
      relativeSpecifiers.push(specifier)
    }
    match = importSpecifierRegex.exec(sourceCode)
  }

  const resolvedPaths = await Promise.all(
    relativeSpecifiers.map((specifier) =>
      resolveRelativeImportPath({ importerPath: sourcePath, specifier }),
    ),
  )

  return Array.from(
    new Set(resolvedPaths.filter((resolved): resolved is string => resolved !== undefined)),
  )
}

/**
 * Copy a genie file's relative/`#` import closure into a fresh `os.tmpdir()` staging directory and
 * return the staged entry path (used by the compiled-binary import path, which cannot register the
 * Bun import-map plugin). The importer's real `node_modules` is symlinked into the staged root so
 * bare workspace-package / runtime imports still resolve. Exported for {@link stageCompiledBinaryImportGraph} tests.
 */
export const stageCompiledBinaryImportGraph = ({
  entryPath,
}: {
  entryPath: string
}): Effect.Effect<StagedCompiledBinaryImportGraph, GenieImportError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const tempRoot = yield* Effect.tryPromise({
      try: () => nodeFs.mkdtemp(path.join(os.tmpdir(), 'genie-import-')),
      catch: (error) =>
        new GenieImportError({
          genieFilePath: entryPath,
          message: `Failed to create compiled-binary staging directory for ${entryPath}: ${safeErrorString(error)}`,
          cause: error,
        }),
    })

    // Bare specifiers (`effect`, `@overeng/otel-contract`, `@effect/platform`, …) survive staging
    // unchanged — `resolveImportMapsInSource` only rewrites `#`/`#mr`/relative specifiers. Staged
    // modules are read from `os.tmpdir()`, outside the repo, so those bare imports would have no
    // reachable `node_modules` and fail (in a compiled binary the bundled copies are not visible to
    // externally-loaded files). Symlinking the importer's real `node_modules` into the staged root
    // lets Bun resolve every bare import against the real on-disk install — exactly as a non-compiled
    // `bun` run does when it imports the genie file in place. The bare-imported package's own
    // transitive closure (its `effect`, its relative files) resolves from that package's real
    // location; only the entry and its relative/`#` closure are ever copied, so a bare-imported
    // package is loaded exactly once (avoids duplicate-singleton hazards, see mk-pnpm-cli.nix).
    const nearestNodeModules = yield* Effect.tryPromise({
      try: () => findNearestNodeModules(entryPath),
      catch: (error) =>
        new GenieImportError({
          genieFilePath: entryPath,
          message: `Failed to locate node_modules while staging compiled-binary imports for ${entryPath}: ${safeErrorString(error)}`,
          cause: error,
        }),
    })
    if (nearestNodeModules !== undefined) {
      yield* Effect.tryPromise({
        try: () => nodeFs.symlink(nearestNodeModules, path.join(tempRoot, 'node_modules'), 'dir'),
        catch: (error) =>
          new GenieImportError({
            genieFilePath: entryPath,
            message: `Failed to link node_modules into compiled-binary staging directory for ${entryPath}: ${safeErrorString(error)}`,
            cause: error,
          }),
      })
    }

    const stagedPaths = new Map<string, string>()
    const relativeEntryPath = entryPath.replace(/^(?:[A-Za-z]:)?[\\/]+/, '')

    const stageModule = (
      sourcePath: string,
    ): Effect.Effect<string, GenieImportError, FileSystem.FileSystem> =>
      Effect.gen(function* () {
        const existingStagePath = stagedPaths.get(sourcePath)
        if (existingStagePath !== undefined) {
          return existingStagePath
        }

        const relativeSourcePath =
          sourcePath === entryPath
            ? relativeEntryPath
            : path.relative(path.parse(sourcePath).root, sourcePath)
        const stagePath = path.join(tempRoot, relativeSourcePath)
        stagedPaths.set(sourcePath, stagePath)

        const sourceCode = yield* Effect.tryPromise({
          try: () => nodeFs.readFile(sourcePath, 'utf8'),
          catch: (error) =>
            new GenieImportError({
              genieFilePath: entryPath,
              message: `Failed to read ${sourcePath} while staging compiled-binary imports: ${safeErrorString(error)}`,
              cause: error,
            }),
        })

        const transformedSource = yield* resolveImportMapsInSource({
          sourceCode,
          sourcePath,
        }).pipe(
          Effect.mapError(
            (error) =>
              new GenieImportError({
                genieFilePath: entryPath,
                message: `Failed to resolve imports in ${sourcePath} for compiled-binary staging: ${safeErrorString(error)}`,
                cause: error,
              }),
          ),
        )

        const relativeImportPaths = yield* Effect.tryPromise({
          try: () => collectRelativeImportPaths({ sourceCode, sourcePath }),
          catch: (error) =>
            new GenieImportError({
              genieFilePath: entryPath,
              message: `Failed to analyze imports in ${sourcePath} for compiled-binary staging: ${safeErrorString(error)}`,
              cause: error,
            }),
        })

        yield* Effect.tryPromise({
          try: async () => {
            await nodeFs.mkdir(path.dirname(stagePath), { recursive: true })
            await nodeFs.writeFile(stagePath, transformedSource)
          },
          catch: (error) =>
            new GenieImportError({
              genieFilePath: entryPath,
              message: `Failed to write staged module ${stagePath}: ${safeErrorString(error)}`,
              cause: error,
            }),
        })

        for (const relativeImportPath of relativeImportPaths) {
          yield* stageModule(relativeImportPath)
        }

        return stagePath
      })

    const stagePath = yield* stageModule(entryPath)
    return { stagePath, tempRoot }
  })

/** Recursively remove a staged import graph's temp root (unlinks the `node_modules` symlink without following it). */
export const removeStagedCompiledBinaryImportGraph = ({
  tempRoot,
}: StagedCompiledBinaryImportGraph): Effect.Effect<void> =>
  Effect.sync(() => nodeFsSync.rmSync(tempRoot, { recursive: true, force: true })).pipe(
    Effect.ignore,
  )

/**
 * Safely convert error to string.
 * In compiled Bun binaries, String(error) can throw for Bun's internal error types
 * due to class identity mismatches. We catch and return a fallback.
 */
const safeErrorString = (error: unknown): string => {
  try {
    return String(error)
  } catch {
    // Bun compiled binary issue - just return the constructor name
    if (error !== null && typeof error === 'object') {
      return `[${error.constructor?.name ?? 'Error'}]`
    }
    return '[Error]'
  }
}

/**
 * Check if an error is a Temporal Dead Zone (TDZ) error.
 *
 * ## Problem
 *
 * When genie files import from a shared module that throws during initialization,
 * ESM leaves the module's exports in an uninitialized state. Subsequent imports
 * from that module produce TDZ errors instead of re-throwing the original error.
 *
 * ## Example Scenario
 *
 * ```
 * // genie/internal.ts - throws during initialization
 * export const catalog = (() => { throw new Error('Missing DATABASE_URL') })()
 *
 * // apps/app/package.json.genie.ts - imports from internal.ts
 * import { catalog } from '../../genie/internal.ts'  // TDZ error!
 * ```
 *
 * During parallel generation, one file gets the original error while others get:
 * `ReferenceError: Cannot access 'catalog' before initialization`
 *
 * This function detects TDZ errors so we can re-validate and find the root cause.
 */
export const isTdzError = (error: unknown): error is ReferenceError =>
  error instanceof ReferenceError &&
  /Cannot access .* before initialization/.test((error as Error).message)

/**
 * Check if an error (or its cause chain) contains a CatalogConflictError.
 *
 * CatalogConflictErrors thrown during module initialization abort the module,
 * causing all downstream imports to produce TDZ errors. Detecting the original
 * CatalogConflictError in the cause chain lets us surface the root cause.
 */
export const findCatalogConflictError = (error: unknown): CatalogConflictError | undefined => {
  let current: unknown = error
  while (current instanceof Error) {
    if (current instanceof CatalogConflictError) return current
    current = current.cause
  }
  return undefined
}

/**
 * Check if an error originated in the given file (vs being propagated from a dependency).
 *
 * ## Purpose
 *
 * When re-validating after TDZ detection, we need to distinguish between:
 * - **Root cause errors**: The actual file that threw (appears in stack trace)
 * - **Cascaded errors**: Files that failed because they import from a failing module
 *
 * ## Error Attribution Rules
 *
 * 1. TDZ errors → Never originate in the file (always from dependencies)
 * 2. Other errors → Check if the file path appears in the stack trace
 *
 * ## Example
 *
 * If `genie/internal.ts` throws and `apps/app/package.json.genie.ts` imports from it:
 * - `errorOriginatesInFile(error, 'genie/internal.ts')` → true (root cause)
 * - `errorOriginatesInFile(error, 'apps/app/package.json.genie.ts')` → false (dependent)
 */
export const errorOriginatesInFile = ({
  error,
  filePath,
}: {
  error: unknown
  filePath: string
}): boolean => {
  // TDZ errors never originate in the file - they're always from dependencies
  if (isTdzError(error) === true) return false
  // Check if the stack trace includes this file path
  if (error instanceof Error) {
    return error.stack?.includes(filePath) ?? false
  }
  return false
}

/** File extensions that oxfmt can format */
const oxfmtSupportedExtensions = new Set(['.json', '.jsonc', '.yml', '.yaml'])

type OxfmtConfig = Readonly<Record<string, unknown>>

/** Permissive JSON decode for an oxfmt config (shape is cast, not validated). */
const decodeOxfmtConfig = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

const loadOxfmtConfig = Effect.fn('loadOxfmtConfig')(function* ({
  configPath,
}: {
  configPath: Option.Option<string>
}) {
  yield* Observability.annotatePath({
    label: Option.isSome(configPath) === true ? 'oxfmt-config' : 'oxfmt-default',
    path: Option.isSome(configPath) === true ? configPath.value : process.cwd(),
  })
  if (Option.isNone(configPath) === true) {
    return Option.none()
  }

  const fs = yield* FileSystem.FileSystem
  const raw = yield* fs.readFileString(configPath.value)
  const config = yield* Effect.try({
    try: () => decodeOxfmtConfig(raw) as OxfmtConfig,
    catch: () =>
      new InvalidOxfmtConfigError({
        message: 'Invalid oxfmt config JSON',
      }),
  })

  return Option.some(config)
})

/**
 * Get the appropriate header comment for a generated file based on its extension.
 *
 * The source file reference uses just the basename (e.g., `package.json.genie.ts`) rather than
 * a path relative to the working directory. This design choice avoids ambiguity when genie runs
 * in a monorepo with git submodules: if the source path were relative to cwd, running genie from
 * the parent repo would produce paths like `submodules/child-repo/packages/.../file.genie.ts`,
 * while running from the child repo would produce `packages/.../file.genie.ts`. Using basename
 * ensures consistent output regardless of where genie is invoked, since the `.genie.ts` source
 * file is always a sibling of the generated file.
 */
export const getHeaderComment = ({
  targetFilePath,
  sourceFile,
}: {
  targetFilePath: string
  sourceFile: string
}): string => {
  const ext = path.extname(targetFilePath)
  const basename = path.basename(targetFilePath)

  // tsconfig*.json files support JS-style comments
  if (basename.startsWith('tsconfig') === true && ext === '.json') {
    return `// Generated file - DO NOT EDIT\n// Source: ${sourceFile}\n`
  }

  // JSONC files support JS-style comments
  if (ext === '.jsonc') {
    return `// Generated file - DO NOT EDIT\n// Source: ${sourceFile}\n`
  }

  // Regular JSON files don't support comments - rely on read-only permissions + .gitattributes
  if (ext === '.json') {
    return ''
  }

  if (ext === '.yml' || ext === '.yaml') {
    return `# Generated file - DO NOT EDIT\n# Source: ${sourceFile}\n\n`
  }

  if (basename === 'BUCK' || ext === '.bzl' || ext === '.bxl') {
    return `# Generated file - DO NOT EDIT\n# Source: ${sourceFile}\n\n`
  }

  if (ext === '.sh') {
    return `# Generated file - DO NOT EDIT\n# Source: ${sourceFile}\n\n`
  }

  // Default to JS/TS style comments
  return `// Generated file - DO NOT EDIT\n// Source: ${sourceFile}\n`
}

/**
 * Prepend the generated-file header to content, preserving a leading `#!` shebang line
 * (the banner is inserted after the shebang, not before it).
 *
 * A hashbang is only valid as the very first bytes of a file. That is a hard rule for scripts of any
 * language, not just `.sh`: putting a comment banner ahead of `#!` in a `.mjs` makes the file a
 * `SyntaxError` rather than merely mis-executing it. So this keys off the shebang itself, not the
 * extension.
 */
export const addHeaderComment = ({ content, header }: { content: string; header: string }) => {
  if (content.startsWith('#!') === false) {
    return header + content
  }

  const firstNewlineIndex = content.indexOf('\n')
  if (firstNewlineIndex < 0) {
    return `${content}\n${header}`
  }

  const shebangLine = content.slice(0, firstNewlineIndex + 1)
  const rest = content.slice(firstNewlineIndex + 1)
  return shebangLine + header + rest
}

const generatedFileMode = ({
  readOnly,
  targetFilePath,
}: {
  readOnly: boolean
  targetFilePath: string
}) => {
  if (path.extname(targetFilePath) === '.sh') {
    return readOnly === true ? 0o555 : 0o755
  }

  return readOnly === true ? 0o444 : undefined
}

/** Format content using oxfmt if the file type is supported */
const formatWithOxfmt = Effect.fn('formatWithOxfmt')(function* ({
  targetFilePath,
  content,
  configPath,
}: {
  targetFilePath: string
  content: string
  configPath: Option.Option<string>
}) {
  yield* Observability.annotateOxfmt({
    targetFilePath,
    hasConfig: Option.isSome(configPath),
  })
  const ext = path.extname(targetFilePath)

  if (oxfmtSupportedExtensions.has(ext) === false) {
    return content
  }

  const optionsResult = yield* loadOxfmtConfig({ configPath }).pipe(Effect.result)
  if (Result.isFailure(optionsResult) === true) {
    return content
  }

  const args = Option.match(configPath, {
    onNone: () => ['--stdin-filepath', targetFilePath],
    onSome: (cfg) => ['-c', cfg, '--stdin-filepath', targetFilePath],
  })

  const result = yield* Effect.gen(function* () {
    const spawner = yield* CommandExecutor.ChildProcessSpawner
    return yield* spawner.string(
      Command.make('oxfmt', args, {
        stdin: { stream: Stream.make(content).pipe(Stream.encodeText) },
      }),
    )
  }).pipe(Effect.orElseSucceed(() => content))

  // If oxfmt returned empty output (e.g., failed to parse), return original content.
  // This handles YAML with GitHub Actions ${{ }} expressions in flow sequences (inline arrays)
  // which Prettier's YAML parser can't handle - it interprets ${{ as a nested flow mapping.
  // See: https://github.com/prettier/prettier/issues/6517 (Helm template syntax)
  // See: https://github.com/eemeli/yaml/issues/328 (flow sequence parsing)
  if (result.length === 0 && content.length > 0) {
    return content
  }

  return result
})

/**
 * Find the nearest repo root for a genie file.
 * Prefers a local megarepo config (megarepo.kdl or megarepo.json), falls back to .git.
 */
const repoRootCache = new Map<string, string>()

const findRepoRoot = Effect.fn('findRepoRoot')(function* ({
  startDir,
  cwd,
}: {
  startDir: string
  cwd: string
}) {
  yield* Observability.annotatePath({ label: 'repo-root', path: startDir })
  const cacheKey = `${cwd}::${startDir}`
  const cached = repoRootCache.get(cacheKey)
  if (cached !== undefined) {
    return cached
  }

  const fs = yield* FileSystem.FileSystem
  let current = startDir
  let last = ''

  while (current !== last) {
    if (
      (yield* fs.exists(path.join(current, 'megarepo.kdl'))) === true ||
      (yield* fs.exists(path.join(current, 'megarepo.json'))) === true
    ) {
      repoRootCache.set(cacheKey, current)
      return current
    }
    if ((yield* fs.exists(path.join(current, '.git'))) === true) {
      repoRootCache.set(cacheKey, current)
      return current
    }
    last = current
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }

  repoRootCache.set(cacheKey, cwd)
  return cwd
})

/**
 * Compute the package location from a genie file path.
 * Example: '/repo/packages/@overeng/utils/package.json.genie.ts' with repo root '/repo'
 *          → 'packages/@overeng/utils'
 */
const computeLocationFromPath = ({
  genieFilePath,
  repoRoot,
}: {
  genieFilePath: string
  repoRoot: string
}): string => {
  const targetFilePath = genieFilePath.replace('.genie.ts', '')
  const targetDir = path.dirname(targetFilePath)
  const relativePath = path.relative(repoRoot, targetDir)
  // Normalize to forward slashes and handle root case
  return relativePath === '' ? '.' : relativePath.split(path.sep).join('/')
}

/**
 * Import a genie file and return its typed output plus the base context.
 *
 * A Bun import resolver is registered once so `#...` specifiers are resolved
 * using the import map closest to the importing file (including transitive imports).
 */
export const loadGenieFile = Effect.fn('loadGenieFile')(function* ({
  genieFilePath,
  cwd,
}: {
  genieFilePath: string
  cwd: string
}) {
  yield* Observability.annotateFile({
    label: Observability.relativePath({ cwd, filePath: genieFilePath }),
    cwd,
    genieFilePath,
    targetFilePath: genieFilePath.replace('.genie.ts', ''),
  })
  yield* ensureImportMapResolver

  const importModule = (
    importPath: string,
  ): Effect.Effect<Record<string, unknown>, GenieImportError> =>
    Effect.tryPromise({
      // oxlint-disable-next-line eslint-plugin-import/no-dynamic-require -- dynamic import path required for genie
      try: () => import(importPath),
      catch: (error) =>
        new GenieImportError({
          genieFilePath,
          message: `Failed to import ${genieFilePath}: ${safeErrorString(error)}`,
          cause: error,
        }),
    })

  const module =
    isCompiledBinary() === true
      ? yield* Effect.gen(function* () {
          const staged = yield* stageCompiledBinaryImportGraph({ entryPath: genieFilePath })
          const importPath = `${pathToFileURL(staged.stagePath).href}?import=${Date.now()}`
          return yield* importModule(importPath).pipe(
            Effect.ensuring(removeStagedCompiledBinaryImportGraph(staged)),
          )
        })
      : yield* importModule(`${genieFilePath}?import=${Date.now()}`)

  const exported = module.default

  // Genie files must export a GenieOutput object with { data, stringify }
  if (
    typeof exported !== 'object' ||
    exported === null ||
    !('stringify' in exported) ||
    typeof exported.stringify !== 'function'
  ) {
    return yield* new GenieImportError({
      genieFilePath,
      message: `Genie file must export a GenieOutput object with { data, stringify }, got ${typeof exported}`,
      cause: new Error(`Invalid export type: ${typeof exported}`),
    })
  }

  // Create context and call the stringify function
  const repoRoot = yield* findRepoRoot({
    startDir: path.dirname(genieFilePath),
    cwd,
  })
  const location = computeLocationFromPath({ genieFilePath, repoRoot })
  const ctx: GenieContext = { location, cwd }

  return { genieFilePath, output: exported as GenieOutput<unknown>, ctx }
})

/** Generate expected content for a genie file (shared between generate and dry-run) */
export const getExpectedContent = Effect.fn('getExpectedContent')(function* ({
  genieFilePath,
  cwd,
  oxfmtConfigPath,
  loadedGenieFile,
}: {
  genieFilePath: string
  cwd: string
  oxfmtConfigPath: Option.Option<string>
  loadedGenieFile?: LoadedGenieFile
}) {
  yield* Observability.annotateFile({
    label: Observability.relativePath({
      cwd,
      filePath: genieFilePath.replace('.genie.ts', ''),
    }),
    cwd,
    genieFilePath,
    targetFilePath: genieFilePath.replace('.genie.ts', ''),
  })
  const targetFilePath = genieFilePath.replace('.genie.ts', '')
  const sourceFile = path.basename(genieFilePath)
  const loaded =
    loadedGenieFile === undefined ? yield* loadGenieFile({ genieFilePath, cwd }) : loadedGenieFile
  const rawContent = loaded.output.stringify(loaded.ctx)

  const header = getHeaderComment({ targetFilePath, sourceFile })
  const formattedContent = yield* formatWithOxfmt({
    targetFilePath,
    content: rawContent,
    configPath: oxfmtConfigPath,
  })

  return {
    targetFilePath,
    content: addHeaderComment({
      content: formattedContent,
      header,
    }),
  }
})

/** Generate a brief diff summary showing line count changes */
const generateDiffSummary = ({
  oldContent,
  newContent,
}: {
  oldContent: string
  newContent: string
}): string | undefined => {
  if (oldContent === newContent) return undefined

  const oldLines = oldContent.split('\n').length
  const newLines = newContent.split('\n').length
  const diff = newLines - oldLines

  if (diff > 0) {
    return `(+${diff} lines)`
  } else if (diff < 0) {
    return `(${diff} lines)`
  }
  return '(content changed)'
}

/**
 * Atomically write a file by writing to a temp file first, then renaming.
 * This prevents file corruption if an error occurs during write.
 */
const atomicWriteFile = ({
  targetFilePath,
  content,
  mode,
}: {
  targetFilePath: string
  content: string
  mode?: number
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const tempPath = `${targetFilePath}.genie.tmp`

    // Make target writable if it exists (for read-only files)
    const targetExists = yield* fs.exists(targetFilePath)
    if (targetExists === true) {
      yield* fs.chmod(targetFilePath, 0o644).pipe(Effect.catch(() => Effect.void))
    }

    // Write to temp file first
    yield* fs.writeFileString(tempPath, content)

    // Set permissions on temp file before rename
    if (mode !== undefined) {
      yield* fs.chmod(tempPath, mode)
    }

    // Atomic rename - either fully succeeds or original file remains untouched
    yield* fs.rename(tempPath, targetFilePath)
  }).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        // Clean up temp file on failure
        const fs = yield* FileSystem.FileSystem
        const tempPath = `${targetFilePath}.genie.tmp`
        yield* fs.remove(tempPath, { force: true }).pipe(Effect.catch(() => Effect.void))
        return yield* error
      }),
    ),
    Observability.withAtomicWriteSpan({
      targetFilePath,
      ...(mode === undefined ? {} : { mode }),
    }),
  )

const withTargetLock = Effect.fn('genie/withTargetLock')(function* <E>({
  cwd,
  targetFilePath,
  effect,
}: {
  cwd: string
  targetFilePath: string
  effect: Effect.Effect<void, E, FileSystem.FileSystem>
}) {
  yield* Observability.annotateTargetLock({ cwd, targetFilePath })
  /** Use cwd-relative dir instead of shared /tmp to avoid EACCES when multiple CI jobs with different UIDs share the same tmpdir */
  const lockDir = path.join(cwd, 'tmp', 'genie-locks')
  const lockLayer = FileSystemBacking.layer({ lockDir })
  const lockKey = `genie:file:${createHash('sha256').update(path.resolve(targetFilePath)).digest('hex')}`

  const semaphore = yield* DistributedSemaphore.make(lockKey, {
    limit: 1,
    ttl: Duration.seconds(120),
  }).pipe(Effect.provide(lockLayer))

  return yield* semaphore.withPermits(1)(effect).pipe(Effect.provide(lockLayer))
})

/** Generate output file from a genie template */
export const generateFile = ({
  genieFilePath,
  cwd,
  readOnly,
  dryRun = false,
  oxfmtConfigPath,
}: {
  genieFilePath: string
  cwd: string
  readOnly: boolean
  dryRun?: boolean
  oxfmtConfigPath: Option.Option<string>
}): Effect.Effect<
  GenerateSuccess,
  GenieFileError,
  FileSystem.FileSystem | CommandExecutor.ChildProcessSpawner | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const targetFilePath = genieFilePath.replace('.genie.ts', '')
    const targetDir = path.dirname(targetFilePath)

    const { content: fileContentString } = yield* getExpectedContent({
      genieFilePath,
      cwd,
      oxfmtConfigPath,
    })

    const targetDirExists = yield* fs.exists(targetDir)
    if (targetDirExists === false) {
      const reason = `Parent directory missing: ${targetDir}`
      return { _tag: 'skipped' as const, targetFilePath, reason }
    }

    // Check if file exists and get current content
    const fileExists = yield* fs.exists(targetFilePath)
    const currentContent =
      fileExists === true
        ? yield* fs.readFileString(targetFilePath).pipe(Effect.orElseSucceed(() => ''))
        : ''

    const isUnchanged = fileExists === true && currentContent === fileContentString

    // Compute diff summary for updated files
    const diffSummary =
      fileExists === true && isUnchanged === false
        ? generateDiffSummary({ oldContent: currentContent, newContent: fileContentString })
        : undefined

    if (dryRun === true) {
      if (fileExists === false) {
        return { _tag: 'created', targetFilePath } as const
      }
      if (isUnchanged === true) {
        return { _tag: 'unchanged', targetFilePath } as const
      }
      return { _tag: 'updated', targetFilePath, diffSummary } as const
    }

    if (isUnchanged === true) {
      // Restore read-only permissions if needed (e.g. after a --writeable run or manual chmod)
      const mode = generatedFileMode({ readOnly, targetFilePath })
      if (mode !== undefined) {
        yield* fs.chmod(targetFilePath, mode).pipe(Effect.catch(() => Effect.void))
      }
      return { _tag: 'unchanged', targetFilePath } as const
    }

    // Atomically write the file (write to temp, then rename)
    const mode = generatedFileMode({ readOnly, targetFilePath })
    yield* withTargetLock({
      cwd,
      targetFilePath,
      effect: atomicWriteFile({
        targetFilePath,
        content: fileContentString,
        ...(mode === undefined ? {} : { mode }),
      }),
    })

    if (fileExists === false) {
      return { _tag: 'created', targetFilePath } as const
    }

    return { _tag: 'updated', targetFilePath, diffSummary } as const
  }).pipe(
    Effect.map((_) => _ as GenerateSuccess),
    Effect.mapError((cause) => {
      const targetFilePath = genieFilePath.replace('.genie.ts', '')
      // Extract the underlying error for TDZ detection
      // Only unwrap GenieImportError (check _tag to avoid unwrapping native Error.cause)
      const underlyingError = cause instanceof GenieImportError ? cause.cause : cause
      return new GenieFileError({
        targetFilePath,
        message: `Failed to generate ${targetFilePath}: ${safeErrorString(cause)}`,
        cause:
          underlyingError instanceof Error ? underlyingError : new Error(safeErrorString(cause)),
      })
    }),
    Effect.catchDefect((defect) => {
      const targetFilePath = genieFilePath.replace('.genie.ts', '')
      return Effect.fail(
        new GenieFileError({
          targetFilePath,
          message: `Failed to generate ${targetFilePath}: ${safeErrorString(defect)}`,
          cause: defect instanceof Error ? defect : new Error(safeErrorString(defect)),
        }),
      )
    }),
    Observability.withFileSpan({
      cwd,
      genieFilePath,
      targetFilePath: genieFilePath.replace('.genie.ts', ''),
      readOnly,
      dryRun,
    }),
  )

/** Check if a generated file matches its expected content */
export const checkFile = ({
  genieFilePath,
  cwd,
  oxfmtConfigPath,
}: {
  genieFilePath: string
  cwd: string
  oxfmtConfigPath: Option.Option<string>
}): Effect.Effect<
  void,
  GenieCheckError | GenieImportError | PlatformError,
  FileSystem.FileSystem | CommandExecutor.ChildProcessSpawner
> => checkFileDetailed({ genieFilePath, cwd, oxfmtConfigPath }).pipe(Effect.asVoid)

/** Check a generated file and return the loaded genie module for downstream validation reuse. */
export const checkFileDetailed = ({
  genieFilePath,
  cwd,
  oxfmtConfigPath,
}: {
  genieFilePath: string
  cwd: string
  oxfmtConfigPath: Option.Option<string>
}): Effect.Effect<
  { targetFilePath: string; loadedGenieFile: LoadedGenieFile },
  GenieCheckError | GenieImportError | PlatformError,
  FileSystem.FileSystem | CommandExecutor.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const loadedGenieFile = yield* loadGenieFile({ genieFilePath, cwd })
    const { targetFilePath, content: expectedContent } = yield* getExpectedContent({
      genieFilePath,
      cwd,
      oxfmtConfigPath,
      loadedGenieFile,
    })

    const fileExists = yield* fs.exists(targetFilePath)
    if (fileExists === false) {
      return yield* new GenieCheckError({
        targetFilePath,
        message: `File does not exist. Run 'genie' to generate it.`,
      })
    }

    const actualContent = yield* fs.readFileString(targetFilePath)

    if (actualContent !== expectedContent) {
      return yield* new GenieCheckError({
        targetFilePath,
        message: `File content is out of date. Run 'genie' to regenerate it.`,
      })
    }

    return { targetFilePath, loadedGenieFile }
  }).pipe(
    Observability.withFileSpan({
      label: Observability.relativePath({ cwd, filePath: genieFilePath.replace('.genie.ts', '') }),
      cwd,
      genieFilePath,
      targetFilePath: genieFilePath.replace('.genie.ts', ''),
    }),
  )
