import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Effect, FileSystem, Option, Path } from 'effect'
import type { PlatformError } from 'effect/PlatformError'

import { resolveImportMapSpecifierForImporterSync } from './import-map/mod.ts'
import * as Observability from './observability.ts'
import type { StatResult } from './types.ts'

let importMapResolverRegistered = false

/** Detect if we're running as a compiled Bun binary (bunfs paths indicate compiled binary) */
export const isCompiledBinary = (): boolean => {
  try {
    return process.argv[1]?.includes('/$bunfs/') ?? false
  } catch {
    return false
  }
}

/** Normalize Bun importer paths to absolute filesystem paths when possible. */
const normalizeImporterPath = (importer: string): string | undefined => {
  if (importer.startsWith('file://') === true) {
    return fileURLToPath(importer)
  }

  if (importer.startsWith('data:') === true) {
    return undefined
  }

  if (path.isAbsolute(importer) === false) {
    return undefined
  }

  return importer
}

type BunResolveArgs = {
  importer: string
  path: string
}

type BunResolveResult = { path: string } | undefined

type BunPluginBuilder = {
  onResolve: (
    options: { filter: RegExp },
    handler: (args: BunResolveArgs) => BunResolveResult,
  ) => void
}

/**
 * Register a Bun import resolver so `#...` specifiers use the import map closest
 * to the importing file. This avoids temp file generation and fixes transitive imports.
 *
 * Note: In compiled Bun binaries, the Bun.plugin API causes class identity mismatches
 * with Bun internals (ResolveMessage instanceof checks fail). We skip plugin registration
 * entirely in compiled binaries - files using `#...` imports need to be run with `bun run`.
 */
export const ensureImportMapResolver = Effect.gen(function* () {
  yield* Observability.annotatePath({ label: 'import-map', path: process.cwd() })
  if (importMapResolverRegistered === true) return
  importMapResolverRegistered = true

  // Skip Bun.plugin in compiled binaries to avoid ResolveMessage class identity issues
  if (isCompiledBinary() === true) return

  Bun.plugin({
    name: 'genie-import-map',
    // Bun type definitions are not guaranteed inside Nix builds, so we keep a local shape.
    setup: (builder: BunPluginBuilder) => {
      builder.onResolve({ filter: /^#/ }, (args: BunResolveArgs) => {
        // Bun resolver hooks can't await promises, so import map resolution is sync.
        const importerPath = normalizeImporterPath(args.importer)
        if (importerPath === undefined) {
          return undefined
        }

        const resolved = resolveImportMapSpecifierForImporterSync({
          specifier: args.path,
          importerPath,
        })

        if (resolved === undefined) return undefined

        return { path: resolved }
      })
    },
  })
}).pipe(Observability.withImportMapResolverSpan)

const editorViewDirectoryName = '.editor-view'

/** Directories to skip when searching for .genie.ts files */
const shouldSkipDirectory = (name: string): boolean => {
  if (name === 'node_modules' || name === 'dist' || name === 'tmp') return true
  if (name === editorViewDirectoryName) return true
  if (name === '.pnpm' || name === '.pnpm-store' || name === '.pnpm-home') return true
  if (name === '.git' || name === '.devenv') return true
  // Megarepo member root (symlinked peer repos).
  if (name === 'repos') return true
  // Nix build output symlink (points to /nix/store/...)
  if (name === 'result') return true
  return false
}

/** Check if a filename is a genie template file (*.genie.ts) */
export const isGenieFile = (file: string): boolean => file.endsWith('.genie.ts')

const gitGeniePathspecs = [
  '*.genie.ts',
  ':(glob)**/*.genie.ts',
  `:(exclude,glob)**/${editorViewDirectoryName}/**`,
] as const

const gitListGenieFiles = ({
  args,
  cwd,
}: {
  args: ReadonlyArray<string>
  cwd: string
}): Array<string> => {
  const output = execFileSync('git', ['-C', cwd, ...args, '--', ...gitGeniePathspecs], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })

  return output.split('\0').filter((file) => file.length > 0)
}

const discoverGitGenieFiles = ({ cwd }: { cwd: string }): Array<string> | undefined => {
  try {
    execFileSync('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })

    return [
      ...gitListGenieFiles({ cwd, args: ['ls-files', '-z', '--recurse-submodules'] }),
      ...gitListGenieFiles({ cwd, args: ['ls-files', '-z', '--others', '--exclude-standard'] }),
    ]
  } catch {
    return undefined
  }
}

/**
 * Find all .genie.ts files under a root directory and return repo-relative
 * paths using `/` separators.
 *
 * Implementation notes:
 * - We resolve the root path once and use it as a boundary so that
 *   symlinked submodule duplicates pointing back into the root are skipped.
 * - Returned paths are relative to that canonical root. Callers that need to
 *   read or write files should resolve them against their working directory.
 * - This keeps output stable when symlinks are used to dedupe submodules,
 *   avoiding double generation and racey writes/chmod.
 */
export const findGenieFiles = Effect.fn('discovery/findGenieFiles')(function* (dir: string) {
  yield* Observability.annotatePath({ label: 'find-files', path: dir })
  const fs = yield* FileSystem.FileSystem
  const pathService = yield* Path.Path
  const warnings: string[] = []
  // Prefer the canonical root when available; fall back to input on failure.
  const rootDir = yield* fs.realPath(dir).pipe(Effect.orElseSucceed(() => dir))
  const rootPrefix = rootDir.endsWith(path.sep) === true ? rootDir : `${rootDir}${path.sep}`
  const seenDirectories = new Set<string>()
  const gitFiles = discoverGitGenieFiles({ cwd: rootDir })

  const resolveSymlinkTarget = (
    fullPath: string,
  ): Effect.Effect<string | undefined, never, never> =>
    fs.readLink(fullPath).pipe(
      Effect.map((target) =>
        pathService.isAbsolute(target) === true
          ? target
          : pathService.resolve(pathService.dirname(fullPath), target),
      ),
      Effect.option,
      Effect.map(Option.getOrUndefined),
    )

  const isWithinRoot = (target: string): boolean =>
    target === rootDir || target.startsWith(rootPrefix)

  const safeStat = (fullPath: string): Effect.Effect<StatResult, never, never> =>
    fs.stat(fullPath).pipe(
      Effect.map(
        (stat): StatResult => ({
          type: stat.type === 'Directory' ? 'directory' : 'file',
        }),
      ),
      Effect.catchTag('PlatformError', (e) => {
        // Handle broken symlinks and other stat failures gracefully
        if (e.reason._tag === 'NotFound') {
          warnings.push(`Skipping broken symlink: ${fullPath}`)
          return Effect.succeed({
            type: 'skip',
            reason: 'broken symlink',
          } as StatResult)
        }
        warnings.push(`Skipping ${fullPath}: ${e.message}`)
        return Effect.succeed({
          type: 'skip',
          reason: e.message,
        } as StatResult)
      }),
    )

  const walk: (currentDir: string) => Effect.Effect<string[], PlatformError> = Effect.fnUntraced(
    function* (currentDir: string) {
      const entries = yield* fs.readDirectory(currentDir)
      const results: string[] = []

      for (const entry of entries) {
        if (shouldSkipDirectory(entry) === true) {
          continue
        }

        const fullPath = pathService.join(currentDir, entry)
        const stat = yield* safeStat(fullPath)

        if (stat.type === 'directory') {
          const symlinkTarget = yield* resolveSymlinkTarget(fullPath)

          if (symlinkTarget !== undefined) {
            /**
             * Skip symlinked directories that point back inside the root.
             * This avoids duplicate traversal when submodules are symlinked
             * to a canonical working tree.
             */
            if (isWithinRoot(symlinkTarget) === true) {
              continue
            }

            if (seenDirectories.has(symlinkTarget) === true) {
              continue
            }
            seenDirectories.add(symlinkTarget)
          } else {
            if (seenDirectories.has(fullPath) === true) {
              continue
            }
            seenDirectories.add(fullPath)
          }

          const nested = yield* walk(fullPath)
          results.push(...nested)
        } else if (stat.type === 'file' && isGenieFile(entry) === true) {
          results.push(fullPath)
        }
        // skip broken symlinks silently (already logged warning)
      }

      return results
    },
  )

  const files = gitFiles ?? (yield* walk(rootDir))
  const seen = new Set<string>()
  const uniqueFiles: string[] = []

  for (const file of files) {
    const fullPath = pathService.isAbsolute(file) === true ? file : pathService.join(rootDir, file)
    const resolvedPath = yield* fs.realPath(fullPath).pipe(
      Effect.catchTag('PlatformError', (e) => {
        warnings.push(`Skipping ${file}: ${e.message}`)
        return Effect.succeed(null)
      }),
    )

    if (resolvedPath === null) continue
    if (seen.has(resolvedPath) === true) continue
    seen.add(resolvedPath)
    uniqueFiles.push(path.relative(rootDir, fullPath).replace(/\\/g, '/'))
  }

  // Log warnings about skipped files
  for (const warning of warnings) {
    yield* Effect.logWarning(warning)
  }

  return uniqueFiles
})
