/**
 * Discover .stories.tsx files and dynamically import them.
 *
 * Uses glob patterns to find story files in package directories,
 * then loads them via dynamic import() to extract CSF exports.
 */

import { globSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

import { Context, Effect, Layer, Array as Arr } from 'effect'

import {
  parseStoryModule,
  type ParsedStoryModule,
  type RawStoryModuleExports,
} from './StoryModule.ts'

// =============================================================================
// Service
// =============================================================================

/** Error raised when story file discovery or import fails */
export class StoryDiscoveryError extends Error {
  readonly _tag = 'StoryDiscoveryError'
}

/** Default glob patterns for story files */
const DEFAULT_PATTERNS = ['src/**/*.stories.tsx'] as const

/** Resolve glob patterns to absolute file paths within a directory */
const globFiles = ({
  dir,
  patterns,
}: {
  readonly dir: string
  readonly patterns: readonly string[]
}): string[] => {
  const results: string[] = []
  const absDir = resolve(dir)
  /* A package directory that does not exist contributes no story files. Node's `globSync`
     returns an empty match set for a missing `cwd` while Bun's throws `ENOENT`, so the
     absent-directory case is decided here instead of by the host runtime. */
  if (statSync(absDir, { throwIfNoEntry: false })?.isDirectory() !== true) return results
  for (const pattern of patterns) {
    const matches = globSync(pattern, { cwd: absDir })
    for (const match of matches) {
      results.push(resolve(absDir, match))
    }
  }
  return Arr.dedupe(results).toSorted()
}

/** Dynamically import a single story file and parse it (skips on import failure) */
const importStoryFile = (filePath: string): Effect.Effect<ParsedStoryModule | undefined, never> =>
  Effect.tryPromise({
    try: async () => {
      // oxlint-disable-next-line eslint-plugin-import(no-dynamic-require)
      const moduleExports = (await import(filePath)) as RawStoryModuleExports
      return parseStoryModule({ exports: moduleExports, filePath })
    },
    catch: (error) =>
      new StoryDiscoveryError(
        `Failed to import ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      ),
  }).pipe(
    Effect.tapError((error) => Effect.logWarning(`Skipping ${filePath}: ${error.message}`)),
    Effect.orElseSucceed(() => undefined),
  )

/** Result of story discovery including skip statistics */
export interface DiscoverStoriesResult {
  readonly modules: readonly ParsedStoryModule[]
  readonly skippedCount: number
}

/** Discover and parse all story files in the given package directories */
export const discoverStories = (options: {
  readonly packageDirs: readonly string[]
  readonly patterns?: readonly string[]
}): Effect.Effect<DiscoverStoriesResult> =>
  Effect.gen(function* () {
    const patterns = options.patterns ?? DEFAULT_PATTERNS

    const filePaths = options.packageDirs.flatMap((dir) => globFiles({ dir, patterns }))

    if (filePaths.length === 0) {
      return { modules: [], skippedCount: 0 }
    }

    /* Sequential imports to avoid Bun's ESM TDZ bug: when concurrent import() calls
       share a dependency and one chain fails (e.g. missing module), Bun leaves the shared
       module's bindings uninitialized for other importers. With the shared
       @overeng/tui-react/storybook dependency this caused ~100% TDZ failure rate.
       Performance is unaffected — shared modules are cached after first evaluation.
       See: https://github.com/oven-sh/bun/issues/20489 */
    const results = yield* Effect.all(
      filePaths.map((fp) => importStoryFile(fp)),
      { concurrency: 1 },
    )

    const modules = results.filter((m): m is ParsedStoryModule => m !== undefined)
    const skippedCount = results.length - modules.length

    return { modules, skippedCount }
  })

// =============================================================================
// Effect Service (for dependency injection in tests)
// =============================================================================

/** Effect service for story discovery (enables dependency injection in tests) */
export class StoryDiscovery extends Context.Service<
  StoryDiscovery,
  {
    readonly discover: (options: {
      readonly packageDirs: readonly string[]
      readonly patterns?: readonly string[]
    }) => Effect.Effect<DiscoverStoriesResult>
  }
>()('StoryDiscovery') {
  static readonly live = Layer.succeed(StoryDiscovery, {
    discover: discoverStories,
  })
}
