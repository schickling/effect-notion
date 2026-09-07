/**
 * Megarepo Store Service
 *
 * Manages the global repository cache at ~/.megarepo (or $MEGAREPO_STORE).
 * The store uses bare repos with worktrees per ref:
 *
 * ```
 * ~/.megarepo/
 * └── github.com/
 *     └── owner/
 *         └── repo/
 *             ├── .bare/                    # bare repository
 *             └── refs/
 *                 ├── heads/
 *                 │   └── main/             # worktree for 'main' branch
 *                 ├── tags/
 *                 │   └── v1.0.0/           # worktree for tag
 *                 └── commits/
 *                     └── abc123.../        # worktree for commit
 * ```
 */

import { Context, Effect, Layer, Option } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { type PlatformError } from 'effect/PlatformError'

import { EffectPath, type AbsoluteDirPath, type RelativeDirPath } from '@overeng/effect-path'

import { DEFAULT_STORE_PATH, ENV_VARS, getStorePath, type MemberSource } from '../core/config.ts'
import * as Observability from '../core/observability.ts'
import { classifyRef, refTypeToPathSegment, type RefType } from '../core/ref.ts'
import { makeStoreLockLayer, StoreLock } from './store-lock.ts'

// =============================================================================
// Store Service
// =============================================================================

/** Store configuration */
export interface StoreConfig {
  readonly basePath: AbsoluteDirPath
}

/** Store service interface */
export interface MegarepoStore {
  /** Get the store base path */
  readonly basePath: AbsoluteDirPath

  /** Get the base path for a repo in the store (without .bare or refs) */
  readonly getRepoBasePath: (source: MemberSource) => AbsoluteDirPath

  /** Get the path to the bare repo (.bare directory) */
  readonly getBareRepoPath: (source: MemberSource) => AbsoluteDirPath

  /** Get the path to a specific worktree for a ref.
   * If refType is not provided, uses heuristic-based classification.
   * For accurate classification, provide the refType from remote/local query.
   */
  readonly getWorktreePath: (args: {
    source: MemberSource
    ref: string
    refType?: RefType
  }) => AbsoluteDirPath

  /** Check if a bare repo exists in the store */
  readonly hasBareRepo: (source: MemberSource) => Effect.Effect<boolean, PlatformError>

  /** Check if a worktree exists for a specific ref.
   * If refType is not provided, uses heuristic-based classification.
   */
  readonly hasWorktree: (args: {
    source: MemberSource
    ref: string
    refType?: RefType
  }) => Effect.Effect<boolean, PlatformError>

  /** List all repos in the store */
  readonly listRepos: Effect.Effect<
    ReadonlyArray<{
      readonly relativePath: RelativeDirPath
      readonly fullPath: AbsoluteDirPath
    }>,
    PlatformError
  >

  /** List all worktrees for a repo (includes broken worktrees with missing .git) */
  readonly listWorktrees: (source: MemberSource) => Effect.Effect<
    ReadonlyArray<{
      readonly ref: string
      readonly refType: RefType
      readonly path: AbsoluteDirPath
      readonly broken: boolean
    }>,
    PlatformError
  >
}

/** Store service tag */
export class Store extends Context.Service<Store, MegarepoStore>()('megarepo/Store') {}

// =============================================================================
// Store Implementation
// =============================================================================

const shouldSkipStoreRootEntry = (entry: string): boolean =>
  // The store root holds member namespaces (`<host>/<owner>/<repo>/`) AND
  // non-member co-tenant dirs. This is the PRIMARY membership boundary that
  // separates them, not a temporary backstop:
  //   - Dot-dirs are store-internal (`.state`, `.locks`, …).
  //   - `_`-prefixed dirs are co-tenant scratch namespaces — e.g. `_iso/`, where
  //     external tooling continuously checks out isolated worktrees that share
  //     the store root. They are NOT members of this store, so the walk must
  //     never enumerate them (and never descend into their working trees). No
  //     real host or owner segment starts with `_`, so this never excludes a
  //     legitimate member.
  //   - `tmp` is a conventional scratch dir.
  // The `_`-prefix convention is a stable contract for co-tenants, owned here; a
  // co-tenant writer that emits `_`-prefixed roots is well-behaved by design.
  entry.startsWith('.') === true || entry.startsWith('_') === true || entry === 'tmp'

// Backstop depth for the store filesystem walks. For the `listRepos` layout walk
// the documented layout is `<host>/<owner>/<repo>/.bare` (repos at depth ~2–3
// from the store root); this generous bound lets nested namespaces (e.g. GitLab
// subgroups) resolve while guaranteeing the walk can never descend into a
// checked-out working tree (node_modules, build output) and exhaust memory.
// `collectNestedWorktrees` reuses it as a ref-NAME-nesting bound under
// `refs/heads/<a>/<b>/…`; real branch names nest only a few segments, so the same
// value (8) comfortably clears any legitimate worktree while still capping a
// pathological worktree-less subtree. Hitting it is logged, never silent.
const STORE_REPO_WALK_MAX_DEPTH = 8

const make = ({
  config,
  fs,
}: {
  config: StoreConfig
  fs: FileSystem.FileSystem
}): MegarepoStore => {
  const basePath = config.basePath

  const getRepoBasePath = (source: MemberSource): AbsoluteDirPath => {
    const relativePath = getStorePath(source)
    return EffectPath.ops.join(basePath, relativePath)
  }

  const getBareRepoPath = (source: MemberSource): AbsoluteDirPath => {
    const repoBase = getRepoBasePath(source)
    return EffectPath.ops.join(repoBase, EffectPath.unsafe.relativeDir('.bare/'))
  }

  const getWorktreePath = ({
    source,
    ref,
    refType,
  }: {
    source: MemberSource
    ref: string
    refType?: RefType
  }): AbsoluteDirPath => {
    const repoBase = getRepoBasePath(source)
    // Use provided refType or fall back to heuristic classification
    const effectiveRefType = refType ?? classifyRef(ref)
    const pathSegment = refTypeToPathSegment(effectiveRefType)
    return EffectPath.ops.join(
      repoBase,
      EffectPath.unsafe.relativeDir(`refs/${pathSegment}/${ref}/`),
    )
  }

  const collectNestedWorktrees = ({
    refTypePath,
    currentPath,
    refType,
    depth,
  }: {
    refTypePath: AbsoluteDirPath
    currentPath: AbsoluteDirPath
    refType: RefType
    depth: number
  }): Effect.Effect<
    Array<{
      ref: string
      refType: RefType
      path: AbsoluteDirPath
      broken: boolean
    }>,
    PlatformError
  > =>
    Effect.gen(function* () {
      const gitPath = EffectPath.ops.join(currentPath, EffectPath.unsafe.relativeFile('.git'))
      const isWorktree = yield* fs.exists(gitPath)
      if (isWorktree === true) {
        const ref = currentPath.slice(refTypePath.length).replace(/\/$/, '')
        return [{ ref, refType, path: currentPath, broken: false }]
      }

      // Backstop: a worktree-less subtree (a stray dir, or a broken worktree whose
      // working tree — `node_modules`, build output — survived a dropped `.git`)
      // would otherwise recurse to the filesystem's depth. The `.git` check above
      // runs first, so a real worktree sitting exactly at the cap is still found;
      // we only refuse to descend PAST it. `depth` is measured in ref-name
      // segments under `refTypePath` (`refs/heads/<a>/<b>/…`), and real branch
      // names nest only a handful of levels, so reusing the layout walk's bound (8)
      // can never truncate a legitimate worktree.
      if (depth >= STORE_REPO_WALK_MAX_DEPTH) {
        yield* Effect.logWarning(
          'store listWorktrees: nested-worktree walk depth limit reached; not descending',
        ).pipe(Effect.annotateLogs({ currentPath, depth }))
        return []
      }

      const entries = yield* fs.readDirectory(currentPath)
      const nestedResults: Array<{
        ref: string
        refType: RefType
        path: AbsoluteDirPath
        broken: boolean
      }> = []

      for (const entry of entries) {
        if (entry.startsWith('.') === true) continue

        const entryPath = EffectPath.ops.join(
          currentPath,
          EffectPath.unsafe.relativeDir(`${entry}/`),
        )
        const entryStat = yield* fs.stat(entryPath).pipe(Effect.orElseSucceed(() => null))
        if (entryStat?.type !== 'Directory') continue

        nestedResults.push(
          ...(yield* collectNestedWorktrees({
            refTypePath,
            currentPath: entryPath,
            refType,
            depth: depth + 1,
          })),
        )
      }

      /** If no worktrees found and this isn't the refType root, it's a broken worktree */
      if (nestedResults.length === 0 && currentPath !== refTypePath) {
        const ref = currentPath.slice(refTypePath.length).replace(/\/$/, '')
        return [{ ref, refType, path: currentPath, broken: true }]
      }

      return nestedResults
    })

  return {
    basePath,
    getRepoBasePath,
    getBareRepoPath,
    getWorktreePath,

    hasBareRepo: (source) => fs.exists(getBareRepoPath(source)),

    hasWorktree: (args) => {
      const worktreePath = getWorktreePath(args)
      const gitFilePath = `${worktreePath}.git`.replace(/\/\.git$/, '/.git')
      return fs.exists(gitFilePath)
    },

    listRepos: Effect.gen(function* () {
      const exists = yield* fs.exists(basePath)
      if (exists === false) {
        return []
      }

      const result: Array<{
        relativePath: RelativeDirPath
        fullPath: AbsoluteDirPath
      }> = []

      const walk = ({
        dir,
        depth,
      }: {
        dir: AbsoluteDirPath
        depth: number
      }): Effect.Effect<void, PlatformError> =>
        Effect.gen(function* () {
          yield* Effect.yieldNow
          const barePath = EffectPath.ops.join(dir, EffectPath.unsafe.relativeDir('.bare/'))
          const hasBare = yield* fs.exists(barePath)
          if (hasBare === true) {
            const relativePath = `${dir.slice(basePath.length).replace(/^\/+/, '').replace(/\/?$/, '/')}`
            result.push({
              relativePath: EffectPath.unsafe.relativeDir(relativePath),
              fullPath: dir,
            })
            return
          }

          // Membership-contract stops (a member is `<host>/<owner>/<repo>/.bare`).
          // Without these the walk descends into directories that are NOT part of
          // this store and enumerates their entire contents — exhausting memory on
          // a real store and mis-claiming non-members:
          //  - `.git` present  → a checked-out worktree, never a namespace dir;
          //    its working tree (node_modules, …) must never be walked.
          //  - `.state`/`.locks` below the host namespace → a NESTED megarepo
          //    store, whose repos belong to it, not here. Host namespaces may
          //    carry `.state` metadata of their own.
          const hasGit = yield* fs.exists(
            EffectPath.ops.join(dir, EffectPath.unsafe.relativeFile('.git')),
          )
          if (hasGit === true) return
          const [hasNestedState, hasNestedLocks] = yield* Effect.all([
            fs.exists(EffectPath.ops.join(dir, EffectPath.unsafe.relativeDir('.state/'))),
            fs.exists(EffectPath.ops.join(dir, EffectPath.unsafe.relativeDir('.locks/'))),
          ])
          const isHostNamespace = depth === 1 && dir.slice(basePath.length).includes('.')
          const isNestedStore =
            isHostNamespace === false && (hasNestedState === true || hasNestedLocks === true)
          if (isNestedStore === true) return

          // Backstop: never descend past the layout's plausible repo depth, so a
          // pathological non-git directory tree can't drive an unbounded walk.
          if (depth >= STORE_REPO_WALK_MAX_DEPTH) {
            return yield* Effect.die(
              new Error(`store listRepos census exceeded the supported depth at ${dir}`),
            )
          }

          const entries = yield* fs.readDirectory(dir)
          yield* Effect.all(
            entries.map((entry) =>
              Effect.gen(function* () {
                if (entry.startsWith('.') === true) {
                  return
                }

                const entryPath = EffectPath.ops.join(
                  dir,
                  EffectPath.unsafe.relativeDir(`${entry}/`),
                )
                const entryStat = yield* fs.stat(entryPath)
                if (entryStat.type !== 'Directory') return

                yield* walk({ dir: entryPath, depth: depth + 1 })
              }),
            ),
            { concurrency: 32 },
          )
        })

      const namespaces = yield* fs.readDirectory(basePath)
      yield* Effect.all(
        namespaces.map((entry) =>
          Effect.gen(function* () {
            if (shouldSkipStoreRootEntry(entry) === true) {
              return
            }

            const entryPath = EffectPath.ops.join(
              basePath,
              EffectPath.unsafe.relativeDir(`${entry}/`),
            )
            const entryStat = yield* fs.stat(entryPath)
            if (entryStat.type !== 'Directory') return

            yield* walk({ dir: entryPath, depth: 1 })
          }),
        ),
        { concurrency: 32 },
      ).pipe(
        Observability.withLabelSpan({ name: 'megarepo/store/list-repos', labelValue: 'repos' }),
      )

      return result.toSorted((a, b) => a.relativePath.localeCompare(b.relativePath))
    }),

    listWorktrees: (source) =>
      Effect.gen(function* () {
        const repoBase = getRepoBasePath(source)
        const refsDir = EffectPath.ops.join(repoBase, EffectPath.unsafe.relativeDir('refs/'))

        const exists = yield* fs.exists(refsDir)
        if (exists === false) {
          return []
        }

        const result: Array<{
          ref: string
          refType: RefType
          path: AbsoluteDirPath
          broken: boolean
        }> = []

        // Walk refs/{heads,tags,commits}/** and treat any directory with a .git file as a worktree.
        const refTypes = yield* fs.readDirectory(refsDir)
        for (const refTypeDir of refTypes) {
          const refType = pathSegmentToRefType(refTypeDir)
          if (refType === undefined) continue

          const refTypePath = EffectPath.ops.join(
            refsDir,
            EffectPath.unsafe.relativeDir(`${refTypeDir}/`),
          )
          const refTypeStat = yield* fs.stat(refTypePath)
          if (refTypeStat.type !== 'Directory') continue

          result.push(
            ...(yield* collectNestedWorktrees({
              refTypePath,
              currentPath: refTypePath,
              refType,
              depth: 0,
            })),
          )
        }

        return result
      }),
  }
}

/**
 * Map path segment back to ref type
 */
const pathSegmentToRefType = (segment: string): RefType | undefined => {
  switch (segment) {
    case 'heads':
      return 'branch'
    case 'tags':
      return 'tag'
    case 'commits':
      return 'commit'
    default:
      return undefined
  }
}

// =============================================================================
// Store Layer
// =============================================================================

/**
 * Expand ~ to home directory and ensure trailing slash for directory path
 */
const expandStorePath = (path: string): AbsoluteDirPath => {
  const expanded = path.replace(/^~/, process.env.HOME ?? '~')
  const withTrailingSlash = expanded.endsWith('/') === true ? expanded : `${expanded}/`
  return EffectPath.unsafe.absoluteDir(withTrailingSlash)
}

/**
 * Create a Store + StoreLock layer with explicit configuration.
 * StoreLock uses file-system backing at {basePath}.locks/.
 */
export const makeStoreLayer = (config: StoreConfig) =>
  Layer.merge(
    Layer.effect(
      Store,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        return make({ config, fs })
      }),
    ),
    makeStoreLockLayer(config.basePath),
  )

/**
 * Store + StoreLock layer from environment (MEGAREPO_STORE) or default path.
 * Reads the env var lazily at provision time so tests can override it.
 */
export const StoreLayer = Layer.effect(
  Store,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const storePathRaw = Option.fromUndefinedOr(process.env[ENV_VARS.STORE]).pipe(
      Option.getOrElse(() => DEFAULT_STORE_PATH),
    )
    const basePath = expandStorePath(storePathRaw)
    return make({ config: { basePath }, fs })
  }),
).pipe((storeOnly) => {
  /* Derive basePath at provision time for the lock layer.
   * We read the env var again (same as storeOnly) so both use the same path. */
  const lockLayer = Layer.effect(
    StoreLock,
    Effect.gen(function* () {
      const store = yield* Store
      return yield* Layer.build(makeStoreLockLayer(store.basePath)).pipe(
        Effect.map((ctx) => ctx.pipe(Context.get(StoreLock))),
      )
    }),
  )
  return Layer.provideMerge(lockLayer, storeOnly)
})
