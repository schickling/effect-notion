/**
 * Store Commands
 *
 * Commands for managing the shared git store.
 */

import { createHash } from 'node:crypto'
import type { Dir, Stats } from 'node:fs'
import { lstat, opendir } from 'node:fs/promises'
import { isAbsolute, normalize } from 'node:path'

import { Clock, Effect, Option, Schedule, Schema, Stream } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { type PlatformError } from 'effect/PlatformError'
import type * as Scope from 'effect/Scope'
import * as Cli from 'effect/unstable/cli'
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner'
import React from 'react'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'
import { OutputModeTag, run } from '@overeng/tui-react'

import {
  parseSourceString,
  isRemoteSource,
  getSourceRef,
  readMegarepoConfig,
} from '../../../core/config.ts'
import * as Git from '../../../core/git.ts'
import { LOCK_FILE_NAME, readLockFile } from '../../../core/lock.ts'
import * as LibObservability from '../../../core/observability.ts'
import { classifyRef } from '../../../core/ref.ts'
import {
  archiveRefMismatchWorktree,
  archiveWorktree,
  reapArchive,
  scanArchives,
} from '../../../store/store-archive.ts'
import {
  loadStoreGcConfig,
  type StoreGcConfig,
  type StoreGcGeneratedArtifact,
} from '../../../store/store-gc-config.ts'
import {
  coldSinceMs as coldSinceMsFor,
  nextObservationLedger,
  readObservationLedger,
  recordObservations,
} from '../../../store/store-gc-observations.ts'
import { validateStoreMembers, fixStoreIssues } from '../../../store/store-hygiene.ts'
import {
  collectStoreLiveSet,
  isPathProtected,
  type StoreLiveSet,
} from '../../../store/store-liveness.ts'
import { StoreLock } from '../../../store/store-lock.ts'
import { assessLossless } from '../../../store/store-lossless.ts'
import {
  makePrStateResolverLayer,
  PrStateResolver,
  type PrStateInfo,
  type PrStateResolverService,
} from '../../../store/store-pr-state.ts'
import {
  classifyColdWorktree,
  isNamedRefWorktree,
  type ColdWorktreeDecision,
} from '../../../store/store-worktree-policy.ts'
import { classifyStoreWorktreePolicy } from '../../../store/store-worktree-policy.ts'
import { Store, StoreLayer } from '../../../store/store.ts'
import { getCloneUrl } from '../../../sync/mod.ts'
import { Cwd, findMegarepoRoot, outputOption, outputModeLayer } from '../../context.ts'
import { StoreCommandError } from '../../errors.ts'
import * as Observability from '../../observability.ts'
import { StoreApp, StoreView } from '../../renderers/StoreOutput/mod.ts'
import type {
  StoreAction,
  StoreGcResult,
  StoreWorktreeStatus,
  StoreWorktreeIssue,
} from '../../renderers/StoreOutput/mod.ts'

/** Entry returned by collectStoreWorktrees — `broken` indicates a directory that looks like a worktree but is missing its .git file */
type CollectedWorktree = {
  ref: string
  refType: 'heads' | 'tags' | 'commits'
  path: AbsoluteDirPath
  broken: boolean
}

type GcWorktreeDecision =
  | {
      readonly worktree: CollectedWorktree
      readonly action: 'skipped_in_use'
      readonly message?: string | undefined
    }
  | {
      readonly worktree: CollectedWorktree
      readonly action: 'status_failed'
      readonly message: string
    }
  | {
      readonly worktree: CollectedWorktree
      readonly action: 'check'
      readonly status: {
        readonly isDirty: boolean
        readonly hasUnpushed: boolean
        readonly changesCount: number
      }
    }

/**
 * Per-repo gc concurrency. Default 4 — the throughput sweet spot proven by the
 * OTEL sweep (decision 0007): 1→4 is a 2.2× speedup and captures ~76% of the
 * achievable gain, while 4→8 falls to the run-to-run noise floor and memory
 * stays flat (whole process tree sub-GB even at 32×). Streaming the subprocess
 * output (constant per-operation memory) is what makes raising this safe; it is
 * env-overridable with `MEGAREPO_GC_REPO_CONCURRENCY`. Back-pressure stays
 * structural (bounded `Stream.mapEffect` concurrency); cross-megarepo safety is
 * unaffected because reconcile-all + per-worktree locks gate every destructive
 * step regardless.
 */
const GC_REPO_CONCURRENCY_DEFAULT = 4
const gcRepoConcurrency = (): number => {
  const raw = process.env['MEGAREPO_GC_REPO_CONCURRENCY']
  if (raw === undefined) return GC_REPO_CONCURRENCY_DEFAULT
  const parsed = Number.parseInt(raw, 10)
  return Number.isInteger(parsed) === true && parsed > 0 ? parsed : GC_REPO_CONCURRENCY_DEFAULT
}
const GC_WORKTREE_CONCURRENCY = 1
const GC_PROGRESS_BATCH_SIZE = 10
const STORE_REF_TYPES = ['heads', 'tags', 'commits'] as const
const GENERATED_SCAN_ENTRY_CAP = 100_000
const GENERATED_SCAN_TIMEOUT_MS = 30_000
type GeneratedArtifactScan =
  | { readonly _tag: 'complete'; readonly count: number; readonly newestMtimeMs: number }
  | {
      readonly _tag: 'incomplete'
      readonly cause:
        | 'entry-cap'
        | 'timeout'
        | 'symlink'
        | 'not-directory'
        | 'device-boundary'
        | 'concurrent-change'
        | 'io'
    }

const AgentLivenessManifest = Schema.Struct({
  version: Schema.Literal(1),
  expiresAtMs: Schema.Finite,
  activeWorkspacePaths: Schema.Array(Schema.String),
})

type GeneratedArtifactRepoWorktrees = ReadonlyArray<{
  readonly repo: { readonly relativePath: string }
  readonly worktrees: ReadonlyArray<CollectedWorktree>
}>

const encodeCanonicalPlan = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const planSha256For = (results: ReadonlyArray<StoreGcResult>): string => {
  const canonicalPlan = results
    .map((result) => ({
      repo: result.repo,
      ref: result.ref,
      refType: result.refType,
      path: result.path,
      status: result.status,
      reason: result.reason,
      kind: result.kind,
      artifactClass: result.artifactClass,
      workspacePath: result.workspacePath,
      outcome: result.outcome,
      mtimeMs: result.mtimeMs,
    }))
    .toSorted((left, right) => compareCanonicalPlanPaths({ left: left.path, right: right.path }))
  return createHash('sha256').update(encodeCanonicalPlan(canonicalPlan)).digest('hex')
}

const planGeneratedArtifacts = ({
  config,
  fs,
  liveSet,
  now,
  onArtifact,
  onRepoCompleted,
  readCurrentTimeMillis,
  repoWorktrees,
}: {
  config: StoreGcConfig
  fs: FileSystem.FileSystem
  liveSet: StoreLiveSet
  now: number
  onArtifact?: ((result: StoreGcResult) => Effect.Effect<void>) | undefined
  onRepoCompleted?: (() => Effect.Effect<void>) | undefined
  readCurrentTimeMillis: Effect.Effect<number>
  repoWorktrees: GeneratedArtifactRepoWorktrees
}): Effect.Effect<
  { readonly results: ReadonlyArray<StoreGcResult>; readonly planSha256: string },
  PlatformError,
  ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const generatedResults: StoreGcResult[] = []
    const readAgentActivePaths = (atMs: number): Effect.Effect<ReadonlySet<string> | undefined> =>
      Effect.gen(function* () {
        if (config.generatedArtifacts.agentLivenessManifest === undefined) return undefined
        const manifestContent = yield* fs
          .readFileString(config.generatedArtifacts.agentLivenessManifest)
          .pipe(Effect.orElseSucceed(() => undefined))
        if (manifestContent === undefined) return undefined
        const parsed = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(AgentLivenessManifest),
        )(manifestContent).pipe(Effect.orElseSucceed(() => undefined))
        if (
          parsed === undefined ||
          Number.isFinite(parsed.expiresAtMs) === false ||
          parsed.activeWorkspacePaths.some((path) => isNormalizedAbsolutePath(path) === false) ===
            true ||
          parsed.expiresAtMs < atMs
        ) {
          return undefined
        }
        const canonicalPaths = yield* Effect.forEach(
          parsed.activeWorkspacePaths,
          (path) => fs.realPath(path).pipe(Effect.orElseSucceed(() => undefined)),
          { concurrency: 1 },
        )
        if (canonicalPaths.some((path) => path === undefined) === true) return undefined
        return new Set(canonicalPaths.map((path) => normalizeStorePath(path!)))
      })
    for (const { repo, worktrees } of repoWorktrees) {
      for (const worktree of worktrees) {
        if (worktree.broken === true) continue
        const removalStatus = yield* Git.getWorktreeRemovalStatus(worktree.path).pipe(
          Effect.map((status) => ({ _tag: 'known' as const, status })),
          Effect.orElseSucceed(() => ({ _tag: 'unknown' as const })),
        )
        for (const artifactClass of config.generatedArtifacts.allowlist) {
          const artifactPath = EffectPath.ops.join(
            worktree.path,
            EffectPath.unsafe.relativeDir(`${artifactClass}/`),
          )
          if ((yield* fs.exists(artifactPath)) === false) {
            continue
          }
          const ignored = yield* Git.runCommand({
            args: ['check-ignore', '--quiet', '--', artifactClass],
            cwd: worktree.path,
          }).pipe(
            Effect.as('ignored' as const),
            Effect.catch((error) =>
              Effect.succeed(
                error instanceof Git.GitCommandError && error.exitCode === 1
                  ? ('not-ignored' as const)
                  : ('unknown' as const),
              ),
            ),
          )
          const megarepoLive = isPathProtected({ liveSet, path: worktree.path })
          const canonicalWorktree = yield* fs
            .realPath(worktree.path)
            .pipe(Effect.orElseSucceed(() => undefined))
          const canonicalArtifact = yield* fs
            .realPath(artifactPath)
            .pipe(Effect.orElseSucceed(() => undefined))
          const expectedCanonicalArtifact =
            canonicalWorktree === undefined
              ? undefined
              : normalizeStorePath(`${canonicalWorktree}/${artifactClass}`)
          const contained =
            canonicalArtifact !== undefined &&
            normalizeStorePath(canonicalArtifact) === expectedCanonicalArtifact
          const agentActivePaths = yield* readAgentActivePaths(yield* readCurrentTimeMillis)
          const agentLive =
            canonicalWorktree === undefined
              ? undefined
              : agentActivePaths?.has(normalizeStorePath(canonicalWorktree))
          const cheapReason =
            config.generatedArtifacts.enabled === false
              ? 'generated-artifacts-disabled'
              : agentActivePaths === undefined
                ? 'agent-liveness-unavailable'
                : canonicalWorktree === undefined || contained === false
                  ? 'artifact-scan-incomplete'
                  : removalStatus._tag === 'unknown'
                    ? 'cleanliness-unknown'
                    : removalStatus.status.isDirty === true
                      ? 'dirty-worktree'
                      : ignored === 'unknown'
                        ? 'artifact-ignore-unknown'
                        : ignored === 'not-ignored'
                          ? 'artifact-not-ignored'
                          : megarepoLive === true || agentLive === true
                            ? 'live'
                            : undefined
          const traversal =
            cheapReason === undefined
              ? yield* scanGeneratedArtifact({ path: artifactPath })
              : undefined
          const finalCanonicalWorktree =
            traversal?._tag === 'complete'
              ? yield* fs.realPath(worktree.path).pipe(Effect.orElseSucceed(() => undefined))
              : canonicalWorktree
          const finalCanonicalArtifact =
            traversal?._tag === 'complete'
              ? yield* fs.realPath(artifactPath).pipe(Effect.orElseSucceed(() => undefined))
              : canonicalArtifact
          const finalAgentActivePaths =
            traversal?._tag === 'complete'
              ? yield* readAgentActivePaths(yield* readCurrentTimeMillis)
              : agentActivePaths
          const finalRemovalStatus =
            traversal?._tag === 'complete'
              ? yield* Git.getWorktreeRemovalStatus(worktree.path).pipe(
                  Effect.map((status) => ({ _tag: 'known' as const, status })),
                  Effect.orElseSucceed(() => ({ _tag: 'unknown' as const })),
                )
              : removalStatus
          const finalIgnored =
            traversal?._tag === 'complete'
              ? yield* Git.runCommand({
                  args: ['check-ignore', '--quiet', '--', artifactClass],
                  cwd: worktree.path,
                }).pipe(
                  Effect.as('ignored' as const),
                  Effect.catch((error) =>
                    Effect.succeed(
                      error instanceof Git.GitCommandError && error.exitCode === 1
                        ? ('not-ignored' as const)
                        : ('unknown' as const),
                    ),
                  ),
                )
              : ignored
          const mtimeMs = traversal?._tag === 'complete' ? traversal.newestMtimeMs : undefined
          const reason =
            cheapReason ??
            (traversal?._tag !== 'complete'
              ? 'artifact-scan-incomplete'
              : finalCanonicalWorktree === undefined ||
                  finalCanonicalArtifact === undefined ||
                  finalCanonicalWorktree !== canonicalWorktree ||
                  finalCanonicalArtifact !== canonicalArtifact
                ? 'artifact-scan-incomplete'
                : finalAgentActivePaths === undefined
                  ? 'agent-liveness-unavailable'
                  : finalAgentActivePaths.has(normalizeStorePath(finalCanonicalWorktree)) === true
                    ? 'live'
                    : finalRemovalStatus._tag === 'unknown'
                      ? 'cleanliness-unknown'
                      : finalRemovalStatus.status.isDirty === true
                        ? 'dirty-worktree'
                        : finalIgnored === 'unknown'
                          ? 'artifact-ignore-unknown'
                          : finalIgnored === 'not-ignored'
                            ? 'artifact-not-ignored'
                            : now - traversal.newestMtimeMs < config.generatedArtifacts.retentionMs
                              ? 'retention'
                              : 'eligible')
          const outcome =
            reason === 'eligible'
              ? ('would-delete' as const)
              : reason === 'agent-liveness-unavailable' ||
                  reason === 'cleanliness-unknown' ||
                  reason === 'artifact-ignore-unknown' ||
                  reason === 'artifact-scan-incomplete'
                ? ('unknown' as const)
                : ('keep' as const)
          const result: StoreGcResult = {
            repo: repo.relativePath,
            ref: worktree.ref,
            refType: worktree.refType,
            path: artifactPath,
            status: 'kept',
            reason,
            kind: 'generated-artifact',
            artifactClass: artifactClass satisfies StoreGcGeneratedArtifact,
            workspacePath: worktree.path,
            exclusiveClosureBytes: null,
            outcome,
            ...(traversal?._tag === 'incomplete'
              ? { message: `generated artifact scan incomplete: ${traversal.cause}` }
              : {}),
            ...(mtimeMs !== undefined ? { mtimeMs } : {}),
          }
          generatedResults.push(result)
          if (onArtifact !== undefined) yield* onArtifact(result)
        }
      }
      if (onRepoCompleted !== undefined) yield* onRepoCompleted()
    }
    return {
      results: generatedResults,
      planSha256: planSha256For(generatedResults),
    }
  })

const scanGeneratedArtifact = ({ path }: { path: string }) =>
  Effect.callback<GeneratedArtifactScan>((resume) => {
    let settled = false
    const openDirectories = new Set<Dir>()
    const finish = (result: GeneratedArtifactScan) => {
      if (settled === true) return
      settled = true
      clearTimeout(deadline)
      resume(Effect.succeed(result))
      for (const directory of openDirectories) void directory.close().catch(() => undefined)
      openDirectories.clear()
    }
    const deadline = setTimeout(
      () => finish({ _tag: 'incomplete', cause: 'timeout' }),
      GENERATED_SCAN_TIMEOUT_MS,
    )
    void (async () => {
      try {
        const artifactRootInfo = await lstat(path)
        if (
          artifactRootInfo.isDirectory() === false ||
          artifactRootInfo.isSymbolicLink() === true
        ) {
          finish({ _tag: 'incomplete', cause: 'not-directory' })
          return
        }
        const pending = [path]
        const fingerprints = new Map<string, string>()
        let count = 0
        let newestMtimeMs = 0
        while (pending.length > 0 && settled === false) {
          const current = pending.pop()!
          // Sequential traversal is intentional: it bounds filesystem pressure.
          // eslint-disable-next-line no-await-in-loop
          const info = await lstat(current)
          if (info.isDirectory() === true && info.dev !== artifactRootInfo.dev) {
            finish({ _tag: 'incomplete', cause: 'device-boundary' })
            return
          }
          count += 1
          if (count > GENERATED_SCAN_ENTRY_CAP) {
            finish({ _tag: 'incomplete', cause: 'entry-cap' })
            return
          }
          if (info.isSymbolicLink() === true) {
            finish({ _tag: 'incomplete', cause: 'symlink' })
            return
          }
          fingerprints.set(current, generatedArtifactFingerprint(info))
          newestMtimeMs = Math.max(newestMtimeMs, info.mtimeMs)
          if (info.isDirectory() === true) {
            // `opendir` consumes one entry at a time, so a huge directory cannot
            // allocate an unbounded `readdir` array before the cap is enforced.
            // eslint-disable-next-line no-await-in-loop
            const directory = await opendir(current)
            openDirectories.add(directory)
            while (settled === false) {
              // eslint-disable-next-line no-await-in-loop
              const entry = await directory.read()
              if (entry === null) break
              pending.push(`${current}/${entry.name}`)
              if (count + pending.length > GENERATED_SCAN_ENTRY_CAP) {
                finish({ _tag: 'incomplete', cause: 'entry-cap' })
                return
              }
            }
            openDirectories.delete(directory)
            // eslint-disable-next-line no-await-in-loop
            await directory.close()
          }
        }
        for (const [entryPath, fingerprint] of fingerprints) {
          // Sequential verification keeps the same bounded filesystem pressure.
          // eslint-disable-next-line no-await-in-loop
          const current = await lstat(entryPath)
          if (generatedArtifactFingerprint(current) !== fingerprint) {
            finish({ _tag: 'incomplete', cause: 'concurrent-change' })
            return
          }
        }
        if (settled === false) finish({ _tag: 'complete', count, newestMtimeMs })
      } catch {
        finish({ _tag: 'incomplete', cause: 'io' })
      }
    })()
    return Effect.sync(() => {
      if (settled === true) return
      settled = true
      clearTimeout(deadline)
      for (const directory of openDirectories) void directory.close().catch(() => undefined)
      openDirectories.clear()
    })
  })

const generatedArtifactFingerprint = (info: Stats): string =>
  `${info.dev}:${info.ino}:${info.mode}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`

const runStoreCommand = ({ output, action }: { output: string; action: StoreAction }) => {
  const visualEffect = run(
    StoreApp,
    (tui) =>
      Effect.sync(() => {
        tui.dispatch(action)
      }),
    { view: React.createElement(StoreView, { stateAtom: StoreApp.stateAtom }) },
  )

  const jsonEffect = Effect.gen(function* () {
    const mode = yield* OutputModeTag
    if (mode._tag !== 'json' || mode.timing !== 'final') {
      return yield* visualEffect
    }

    return yield* run(StoreApp, (tui) =>
      Effect.sync(() => {
        tui.dispatch(action)
      }),
    )
  })

  return jsonEffect.pipe(Effect.provide(outputModeLayer(output as never)))
}

const toStoreGcAction = ({
  basePath,
  results,
  dryRun,
  warning,
  force,
  repoCount,
  completedRepoCount,
  discoveredWorktreeCount,
  activeWorktreeCount,
  statusMessage,
  done,
  planSha256,
}: {
  basePath: string
  results: ReadonlyArray<StoreGcResult>
  dryRun: boolean
  warning: { type: 'not_in_megarepo' | 'only_current_megarepo' } | undefined
  force: boolean
  repoCount: number | undefined
  completedRepoCount: number
  discoveredWorktreeCount: number
  activeWorktreeCount: number
  statusMessage: string | undefined
  done: boolean
  planSha256?: string | undefined
}): StoreAction => ({
  _tag: 'SetGc',
  basePath,
  // Pass the accumulator by reference, not a fresh `[...results]` copy on every
  // progressive dispatch: the reducer/view treat `results` as read-only and the
  // array is only ever appended to. The final `-o json` document still carries
  // the full array (the JSON schema is unchanged); this just removes a per-batch
  // O(n) copy so progressive dispatch cost stays linear in total work.
  results,
  dryRun,
  warning,
  showForceHint: !force,
  processedCount: results.length,
  repoCount,
  completedRepoCount,
  discoveredWorktreeCount,
  activeWorktreeCount,
  statusMessage,
  done,
  censusStatus: repoCount === undefined ? 'unknown' : 'complete',
  ...(planSha256 !== undefined ? { planSha256 } : {}),
})

const classifyGcProtection = ({
  store,
  currentWorkspaceRoot,
  worktree,
  all,
}: {
  store: Effect.Success<typeof Store>
  currentWorkspaceRoot: Option.Option<AbsoluteDirPath>
  worktree: CollectedWorktree
  all: boolean
}) =>
  Effect.gen(function* () {
    const liveSet = yield* collectStoreLiveSet({
      store,
      ...(Option.isSome(currentWorkspaceRoot) === true
        ? { currentWorkspaceRoot: currentWorkspaceRoot.value }
        : {}),
      pruneStaleRegistry: true,
      refreshCurrentWorkspace: false,
    })

    return classifyStoreWorktreePolicy({
      liveSet,
      mode: all === true ? 'all' : 'default',
      worktree,
    })
  })

/**
 * True if any ref in `knownRefs` is nested under `prefix` — i.e. `prefix` is an
 * intermediate namespace directory (e.g. `schickling` for branch `schickling/foo`)
 * that must be descended into, not treated as a worktree root.
 */
const isNamespacePrefix = ({
  knownRefs,
  prefix,
}: {
  knownRefs: ReadonlySet<string>
  prefix: string
}): boolean => {
  const needle = `${prefix}/`
  for (const ref of knownRefs) {
    if (ref.startsWith(needle) === true) return true
  }
  return false
}

const collectStoreWorktrees = ({
  fs,
  refTypePath,
  currentPath,
  refType,
  knownRefs,
}: {
  fs: FileSystem.FileSystem
  refTypePath: AbsoluteDirPath
  currentPath: AbsoluteDirPath
  refType: 'heads' | 'tags' | 'commits'
  knownRefs: ReadonlySet<string>
}): Effect.Effect<Array<CollectedWorktree>, PlatformError> =>
  Effect.gen(function* () {
    const gitPath = EffectPath.ops.join(currentPath, EffectPath.unsafe.relativeFile('.git'))
    const isWorktree = yield* fs.exists(gitPath).pipe(Effect.orElseSucceed(() => false))
    if (isWorktree === true) {
      return [
        {
          ref: currentPath.slice(refTypePath.length).replace(/\/$/, ''),
          refType,
          path: currentPath,
          broken: false,
        },
      ]
    }

    // Source-of-truth descend guard. WITHOUT this, a broken worktree root (one
    // whose `.git` is missing after an interrupted `git worktree add` / prune)
    // makes the walk recurse into its ENTIRE checked-out working tree — every
    // `node_modules`/`src` leaf becomes a bogus `broken` worktree, exhausting
    // memory on a real store (OOM). The bare repo's ref set (`knownRefs`) tells
    // us which directories are worktree roots:
    //  - `rel` IS a known ref           → worktree root, `.git` missing → ONE
    //    broken entry; do NOT descend into its working tree.
    //  - `rel` is a strict prefix of a  → intermediate namespace dir (branch
    //    known ref                        names contain `/`) → recurse.
    //  - otherwise                      → orphan dir not on any ref path (deleted
    //    branch leftover / junk)        → ONE broken entry; do NOT descend.
    // The walk is thereby bounded to O(refs), never the checked-out file tree.
    const rel = currentPath.slice(refTypePath.length).replace(/\/$/, '')
    if (rel !== '') {
      const isKnownRoot = knownRefs.has(rel)
      if (isKnownRoot === true || isNamespacePrefix({ knownRefs, prefix: rel }) === false) {
        return [
          {
            ref: rel,
            refType,
            path: currentPath,
            broken: true,
          },
        ]
      }
    }

    const entries = yield* fs.readDirectory(currentPath)
    const result: Array<CollectedWorktree> = []

    for (const entry of entries) {
      if (entry.startsWith('.') === true) continue

      const entryPath = EffectPath.ops.join(currentPath, EffectPath.unsafe.relativeDir(`${entry}/`))
      const entryStat = yield* fs.stat(entryPath)
      if (entryStat.type !== 'Directory') continue

      result.push(
        ...(yield* collectStoreWorktrees({
          fs,
          refTypePath,
          currentPath: entryPath,
          refType,
          knownRefs,
        })),
      )
    }

    return result
  })

const collectRepoStoreWorktrees = ({
  fs,
  repoPath,
  bareRepoPath,
}: {
  fs: FileSystem.FileSystem
  repoPath: AbsoluteDirPath
  bareRepoPath: AbsoluteDirPath
}) =>
  Effect.gen(function* () {
    const repoPrefix = repoPath.replace(/\/+$/, '')
    const refsPrefix = `${repoPrefix}/refs/`
    const realRepoPrefix = (yield* fs.realPath(repoPath)).replace(/\/+$/, '')
    const realRefsPrefix = `${realRepoPrefix}/refs/`
    const result: Array<CollectedWorktree> = []
    const seenPaths = new Set<string>()
    // Authoritative worktree-root names per ref type (the bare's ref set ∪ the
    // registered worktree list). Used by `collectStoreWorktrees` as the descend
    // guard so the layout walk never recurses into a broken worktree's working
    // tree. Seeded from the worktree list below, then unioned with `for-each-ref`.
    const knownRefsByType: Record<'heads' | 'tags' | 'commits', Set<string>> = {
      heads: new Set(),
      tags: new Set(),
      commits: new Set(),
    }

    // Git's worktree registry can be stale or incomplete after interrupted
    // operations. Use it as a fast hint, then merge in the path layout because
    // the store layout is the durable source of truth for refs/heads|tags|commits.
    const gitWorktrees = yield* Git.listWorktrees(bareRepoPath)
    for (const worktree of gitWorktrees) {
      const normalizedPath = worktree.path.replace(/\/+$/, '')
      const relativePath =
        normalizedPath.startsWith(refsPrefix) === true
          ? normalizedPath.slice(refsPrefix.length)
          : normalizedPath.startsWith(realRefsPrefix) === true
            ? normalizedPath.slice(realRefsPrefix.length)
            : undefined
      if (relativePath === undefined) continue

      const separatorIndex = relativePath.indexOf('/')
      if (separatorIndex === -1) continue

      const refType = relativePath.slice(0, separatorIndex)
      if (refType !== 'heads' && refType !== 'tags' && refType !== 'commits') continue

      const ref = relativePath.slice(separatorIndex + 1)
      if (ref.length === 0) continue

      seenPaths.add(normalizedPath)
      seenPaths.add(`${repoPrefix}/refs/${relativePath}`)
      knownRefsByType[refType].add(ref)
      result.push({
        ref,
        refType,
        path: EffectPath.unsafe.absoluteDir(`${repoPrefix}/refs/${relativePath}/`),
        broken: false,
      })
    }

    // Union in the bare's ref set — the source of truth for worktree roots, and
    // the only signal for a broken worktree absent from the registry above.
    for (const namespace of ['heads', 'tags'] as const) {
      const refNames = yield* Git.listRefShortNames({ bareRepoPath, namespace })
      for (const refName of refNames) knownRefsByType[namespace].add(refName)
    }

    for (const refType of STORE_REF_TYPES) {
      const refTypePath = EffectPath.ops.join(
        repoPath,
        EffectPath.unsafe.relativeDir(`refs/${refType}/`),
      )
      if ((yield* fs.exists(refTypePath)) === false) continue
      const refTypeStat = yield* fs.stat(refTypePath)
      if (refTypeStat.type !== 'Directory') continue

      const layoutWorktrees = yield* collectStoreWorktrees({
        fs,
        refTypePath,
        currentPath: refTypePath,
        refType,
        knownRefs: knownRefsByType[refType],
      })

      for (const worktree of layoutWorktrees) {
        const normalizedPath = worktree.path.replace(/\/+$/, '')
        if (seenPaths.has(normalizedPath) === true) continue

        seenPaths.add(normalizedPath)
        result.push(worktree)
      }
    }

    return result
  }).pipe(
    Observability.withStoreWorktreeSpan({
      name: 'megarepo/store/gc/collect-worktrees',
      repo: repoPath,
      refType: 'repo',
      ref: Observability.shortPath(repoPath),
      bareRepoPath,
    }),
  )

const classifyGcWorktree = ({
  worktree,
  liveSet,
  all,
}: {
  worktree: CollectedWorktree
  liveSet: StoreLiveSet
  all: boolean
}) =>
  Effect.gen(function* () {
    const policy = classifyStoreWorktreePolicy({
      liveSet,
      mode: all === true ? 'all' : 'default',
      worktree,
    })
    if (policy.isProtected === true) {
      return {
        worktree,
        action: 'skipped_in_use' as const,
        ...(policy.message !== undefined ? { message: policy.message } : {}),
      }
    }

    /** Broken worktrees have no .git — skip git status, proceed directly to removal. */
    if (worktree.broken === true) {
      return {
        worktree,
        action: 'check' as const,
        status: { isDirty: false, hasUnpushed: false, changesCount: 0 },
      }
    }

    const statusResult = yield* Git.getWorktreeRemovalStatus(worktree.path).pipe(
      Effect.map((status) => ({ _tag: 'status' as const, status })),
      Effect.catch((error) =>
        Effect.succeed({
          _tag: 'status_failed' as const,
          message: error instanceof Error === true ? error.message : String(error),
        }),
      ),
    )
    if (statusResult._tag === 'status_failed') {
      return {
        worktree,
        action: 'status_failed' as const,
        message: statusResult.message,
      }
    }

    return { worktree, action: 'check' as const, status: statusResult.status }
  }).pipe(
    Observability.withStoreWorktreeSpan({
      name: 'megarepo/store/gc/classify-worktree',
      repo: 'worktree',
      refType: worktree.refType,
      ref: worktree.ref,
      worktreePath: worktree.path,
      broken: worktree.broken,
    }),
  )

const normalizeStorePath = (path: string): string => path.replace(/\/+$/, '')

const isNormalizedAbsolutePath = (path: string): boolean =>
  path.length > 0 &&
  isAbsolute(path) === true &&
  normalize(path) === path &&
  (path === '/' || normalizeStorePath(path) === path)

/** Compare plan paths by their canonical UTF-8 byte representation. */
export const compareCanonicalPlanPaths = ({
  left,
  right,
}: {
  left: string
  right: string
}): number => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))

/** A named (`refs/heads/*`) worktree paired with the repo it belongs to. */
interface NamedWorktreeTarget {
  readonly repoRelativePath: string
  readonly repoFullPath: AbsoluteDirPath
  readonly bareRepoPath: AbsoluteDirPath
  readonly worktree: CollectedWorktree
}

/**
 * Build a `StoreGcResult` for a cold-path outcome.
 *
 * `reason` is the stable classification tag (live/not-stale/merged/...);
 * `message` carries free-form detail; `recoverPath` is the `.archive/` location
 * for an archived worktree.
 */
const coldResult = ({
  target,
  status,
  reason,
  message,
  recoverPath,
  pathRef,
  actualHeadBranch,
}: {
  target: NamedWorktreeTarget
  status: StoreGcResult['status']
  reason?: string | undefined
  message?: string | undefined
  recoverPath?: string | undefined
  pathRef?: string | undefined
  actualHeadBranch?: string | undefined
}): StoreGcResult => ({
  repo: target.repoRelativePath,
  ref: target.worktree.ref,
  refType: target.worktree.refType,
  path: target.worktree.path,
  status,
  ...(reason !== undefined ? { reason } : {}),
  ...(message !== undefined ? { message } : {}),
  ...(recoverPath !== undefined ? { recoverPath } : {}),
  ...(pathRef !== undefined ? { pathRef } : {}),
  ...(actualHeadBranch !== undefined ? { actualHeadBranch } : {}),
})

/**
 * Re-derive a fresh live set under lock for the veto re-check (invariant 1).
 *
 * Reconciles every present workspace again so a worktree that became live
 * between the initial collect and this destructive step is never archived/reaped.
 * Read-only with respect to the on-disk records here? No — reconcile rewrites
 * records, so it is serialized by the caller's `withWorktreeLock`.
 */
const reReconcileLiveSet = ({
  store,
  root,
  now,
}: {
  store: Effect.Success<typeof Store>
  root: Option.Option<AbsoluteDirPath>
  now: number
}) =>
  collectStoreLiveSet({
    store,
    ...(Option.isSome(root) === true ? { currentWorkspaceRoot: root.value } : {}),
    refreshCurrentWorkspace: false,
    pruneStaleRegistry: false,
    reconcileAllWorkspaces: true,
    now,
  })

/**
 * Cold reclamation for ONE repo's named worktrees (decisions 0001–0010).
 *
 * Fetch the bare first (failure ⇒ keep ALL this repo's named worktrees — the
 * reachability signal would be stale). Then per named worktree: enforce the
 * actual-HEAD-branch gate (`ref_mismatch` ⇒ keep), resolve PR state adjacent to
 * classification, assess the lossless floor, and classify. An `archive` decision
 * runs under `withWorktreeLock` with a FRESH live-set veto re-check immediately
 * before `archiveWorktree` (archive → verify → free-branch is the helper's job);
 * any failure leaves the original intact and reports keep+error. Finally scan
 * `.archive/` and reap entries past the retention TTL, each under lock + veto.
 *
 * `now` is the explicit epoch-ms decision clock; `coldSince` is read from the
 * pre-recorded observation ledger so grace windows are consistent across repos.
 */
const coldReclaimRepo = ({
  store,
  storeLock,
  prResolver,
  root,
  repoRelativePath,
  repoFullPath,
  bareRepoPath,
  namedWorktrees,
  liveSet,
  ledger,
  config,
  now,
  dryRun,
  candidatePath,
  lockAlreadyHeld = false,
}: {
  store: Effect.Success<typeof Store>
  storeLock: Effect.Success<typeof StoreLock>
  prResolver: PrStateResolverService
  root: Option.Option<AbsoluteDirPath>
  repoRelativePath: string
  repoFullPath: AbsoluteDirPath
  bareRepoPath: AbsoluteDirPath
  namedWorktrees: ReadonlyArray<NamedWorktreeTarget>
  liveSet: StoreLiveSet
  ledger: Record<string, number>
  config: StoreGcConfig
  now: number
  dryRun: boolean
  candidatePath?: string | undefined
  lockAlreadyHeld?: boolean | undefined
}) =>
  Effect.gen(function* () {
    const results: StoreGcResult[] = []

    // Fetch --prune so `refs/remotes/*` is fresh (the reachability + PR-prune
    // signal). A repo whose fetch fails keeps ALL its named worktrees — the
    // conservative direction (every commit would read as unpushed).
    //
    // `--dry-run` must not mutate `.bare`, and `git fetch --prune` rewrites
    // `refs/remotes/*`, so the fetch is SKIPPED entirely in dry-run. Classification
    // then runs against the currently-present (last-known) `refs/remotes/*` instead
    // of a freshly refreshed set; `classify === true` so the preview still proceeds.
    // The TUI's dry-run banner states that remotes were not refreshed.
    let classify: boolean
    if (dryRun === true) {
      classify = true
    } else {
      const fetchResult = yield* Git.fetchBare({ repoPath: bareRepoPath }).pipe(Effect.result)
      classify = fetchResult._tag === 'Success'
      if (fetchResult._tag === 'Failure') {
        // Classification needs fresh `refs/remotes/*`, so keep all named worktrees;
        // do NOT return — archive reaping below is time/veto-based and needs no fetch.
        const message =
          fetchResult.failure instanceof Error === true
            ? fetchResult.failure.message
            : String(fetchResult.failure)
        for (const target of namedWorktrees) {
          results.push(coldResult({ target, status: 'kept', reason: 'fetch-failed', message }))
        }
      }
    }

    // The repo's default branch (e.g. `main`) is NEVER reclaimed, regardless of
    // PR state or liveness — archiving a dependency's default branch is never
    // wanted, and common names (`main`/`master`) are prone to PR-join false
    // positives. Read locally from the bare's HEAD (offline). Only needed when
    // classifying, i.e. the fetch succeeded (live) or was skipped (dry-run).
    const defaultBranch =
      classify === true
        ? Option.getOrUndefined(yield* Git.getStoreDefaultBranch({ bareRepoPath }))
        : undefined

    for (const target of namedWorktrees) {
      if (candidatePath !== undefined && target.worktree.path !== candidatePath) continue
      if (classify === false) break
      const { worktree } = target
      // Only `refs/heads/*` carries a branch identity to reclaim; tags have no
      // PR/branch to free, so they are always kept by the cold path.
      if (worktree.refType !== 'heads') {
        results.push(coldResult({ target, status: 'kept', reason: 'named-tag-ref' }))
        continue
      }

      // Default-branch guard (hard keep, before any staleness/liveness logic).
      if (defaultBranch !== undefined && worktree.ref === defaultBranch) {
        results.push(coldResult({ target, status: 'kept', reason: 'default-branch' }))
        continue
      }

      // Ref-mismatch fork: the store path claims `<ref>` but the worktree HEAD
      // is on a different branch. The normal cold path is unsafe because it frees
      // `refs/heads/<ref>`, which is NOT the branch actually checked out. Only a
      // clean, lossless, absent mismatch takes the separate archive-only path.
      const headBranch = yield* Git.getCurrentBranch(worktree.path).pipe(
        Effect.orElseSucceed(() => Option.none<string>()),
      )
      if (Option.isSome(headBranch) === true && headBranch.value !== worktree.ref) {
        const actualHeadBranch = headBranch.value
        const actualBranchPath = EffectPath.ops.join(
          repoFullPath,
          EffectPath.unsafe.relativeDir(`refs/heads/${actualHeadBranch}/`),
        )

        const refMismatchMeta = {
          pathRef: worktree.ref,
          actualHeadBranch,
        }
        const keepRefMismatch = (message: string) =>
          coldResult({
            target,
            status: 'kept',
            reason: 'ref_mismatch',
            message,
            ...refMismatchMeta,
          })

        if (defaultBranch !== undefined && actualHeadBranch === defaultBranch) {
          results.push(keepRefMismatch(`HEAD is default branch '${actualHeadBranch}'`))
          continue
        }

        if (
          isPathProtected({ liveSet, path: worktree.path }) === true ||
          isPathProtected({ liveSet, path: actualBranchPath }) === true
        ) {
          results.push(keepRefMismatch(`HEAD is '${actualHeadBranch}' and path is live`))
          continue
        }

        const head = yield* Git.getCurrentCommit(worktree.path).pipe(
          Effect.map(Option.some),
          Effect.orElseSucceed(() => Option.none<string>()),
        )
        if (Option.isNone(head) === true) {
          results.push(keepRefMismatch(`HEAD is '${actualHeadBranch}' but commit is unreadable`))
          continue
        }
        const worktreeHead = head.value

        const lossless = yield* assessLossless({
          bareRepoPath,
          worktreePath: worktree.path,
          worktreeHead,
        }).pipe(
          Effect.map(Option.some),
          Effect.orElseSucceed(() => Option.none<never>()),
        )
        if (Option.isNone(lossless) === true) {
          results.push(keepRefMismatch(`HEAD is '${actualHeadBranch}' but lossless probe failed`))
          continue
        }
        if (lossless.value.dirty === true) {
          results.push(keepRefMismatch(`HEAD is '${actualHeadBranch}' with dirty worktree`))
          continue
        }
        if (lossless.value.unpushed > 0 || lossless.value.hasStash === true) {
          results.push(
            keepRefMismatch(`HEAD is '${actualHeadBranch}' with unrecoverable local work`),
          )
          continue
        }
        const coldSinceMs = coldSinceMsFor({ ledger, path: worktree.path })
        if (coldSinceMs === undefined || now - coldSinceMs < config.absenceGraceMs) {
          results.push(keepRefMismatch(`HEAD is '${actualHeadBranch}' within absence grace`))
          continue
        }

        if (dryRun === true) {
          results.push(
            coldResult({
              target,
              status: 'archived',
              reason: 'ref_mismatch_clean',
              ...refMismatchMeta,
            }),
          )
          continue
        }

        const archiveAction = Effect.gen(function* () {
          const freshLiveSet = yield* reReconcileLiveSet({ store, root, now })
          if (
            isPathProtected({ liveSet: freshLiveSet, path: worktree.path }) === true ||
            isPathProtected({ liveSet: freshLiveSet, path: actualBranchPath }) === true
          ) {
            return { _tag: 'kept-live' as const }
          }
          const outcome = yield* archiveRefMismatchWorktree({
            repoRoot: repoFullPath,
            bareRepoPath,
            worktreePath: worktree.path,
            pathRef: worktree.ref,
            actualHeadBranch,
            commit: worktreeHead,
            now,
          })
          return {
            _tag: 'archived' as const,
            recoverPath: outcome.destPath,
            warnings: outcome.warnings,
          }
        })
        const archiveOutcome = yield* (
          lockAlreadyHeld === true
            ? archiveAction
            : storeLock.withWorktreeLock(worktree.path)(archiveAction)
        ).pipe(
          Effect.catch((error) =>
            Effect.succeed({
              _tag: 'error' as const,
              message: error instanceof Error === true ? error.message : String(error),
            }),
          ),
        )

        if (archiveOutcome._tag === 'kept-live') {
          results.push(keepRefMismatch(`HEAD is '${actualHeadBranch}' and path is live`))
        } else if (archiveOutcome._tag === 'error') {
          results.push(
            coldResult({
              target,
              status: 'error',
              reason: 'ref_mismatch_clean',
              message: archiveOutcome.message,
              ...refMismatchMeta,
            }),
          )
        } else {
          results.push(
            coldResult({
              target,
              status: 'archived',
              reason: 'ref_mismatch_clean',
              recoverPath: archiveOutcome.recoverPath,
              ...(archiveOutcome.warnings.length > 0
                ? { message: archiveOutcome.warnings.join('; ') }
                : {}),
              ...refMismatchMeta,
            }),
          )
        }
        continue
      }

      const prState: PrStateInfo = yield* prResolver
        .resolve({
          relativePath: EffectPath.unsafe.relativeDir(target.repoRelativePath),
          branch: worktree.ref,
        })
        .pipe(Observability.withStoreGcPhaseSpan({ phase: 'resolve-pr' }))

      const head = yield* Git.getCurrentCommit(worktree.path).pipe(
        Effect.map(Option.some),
        Effect.orElseSucceed(() => Option.none<string>()),
      )
      if (Option.isNone(head) === true) {
        results.push(coldResult({ target, status: 'kept', reason: 'unreadable-head' }))
        continue
      }
      const worktreeHead = head.value

      const lossless = yield* assessLossless({
        bareRepoPath,
        worktreePath: worktree.path,
        worktreeHead,
      }).pipe(
        Effect.map(Option.some),
        // A failed lossless probe (e.g. unresolvable head) degrades to keep.
        Effect.orElseSucceed(() => Option.none<never>()),
      )
      if (Option.isNone(lossless) === true) {
        results.push(coldResult({ target, status: 'kept', reason: 'unrecoverable-local-work' }))
        continue
      }

      const decision: ColdWorktreeDecision = classifyColdWorktree({
        worktree: { refType: 'heads', path: worktree.path },
        liveSet,
        prState,
        lossless: lossless.value,
        coldSinceMs: coldSinceMsFor({ ledger, path: worktree.path }),
        config,
        now,
      })

      if (decision._tag === 'keep') {
        results.push(coldResult({ target, status: 'kept', reason: decision.reason }))
        continue
      }

      // Archive decision: serialize under the worktree lock and re-check the live
      // veto against a FRESH reconcile immediately before moving (invariant 1).
      if (dryRun === true) {
        results.push(coldResult({ target, status: 'archived', reason: decision.reason }))
        continue
      }

      const archiveAction = Effect.gen(function* () {
        const freshLiveSet = yield* reReconcileLiveSet({ store, root, now })
        if (isPathProtected({ liveSet: freshLiveSet, path: worktree.path }) === true) {
          return { _tag: 'kept-live' as const }
        }
        const outcome = yield* archiveWorktree({
          repoRoot: repoFullPath,
          bareRepoPath,
          worktreePath: worktree.path,
          branch: worktree.ref,
          commit: worktreeHead,
          reason: decision.reason,
          now,
        })
        return {
          _tag: 'archived' as const,
          recoverPath: outcome.destPath,
          warnings: outcome.warnings,
        }
      })
      const archiveOutcome = yield* (
        lockAlreadyHeld === true
          ? archiveAction
          : storeLock.withWorktreeLock(worktree.path)(archiveAction)
      ).pipe(
        Effect.catch((error) =>
          Effect.succeed({
            _tag: 'error' as const,
            message: error instanceof Error === true ? error.message : String(error),
          }),
        ),
      )

      if (archiveOutcome._tag === 'kept-live') {
        results.push(coldResult({ target, status: 'kept', reason: 'live' }))
      } else if (archiveOutcome._tag === 'error') {
        // Only a PRE-move failure reaches here (post-move steps are best-effort
        // and reported as warnings, never errors), so the original worktree is
        // genuinely left intact.
        results.push(
          coldResult({
            target,
            status: 'error',
            reason: decision.reason,
            message: archiveOutcome.message,
          }),
        )
      } else {
        // The move succeeded: report `archived` + the real `.archive/` recovery
        // path even if a best-effort post-move step (branch free / README) failed.
        results.push(
          coldResult({
            target,
            status: 'archived',
            reason: decision.reason,
            recoverPath: archiveOutcome.recoverPath,
            ...(archiveOutcome.warnings.length > 0
              ? { message: archiveOutcome.warnings.join('; ') }
              : {}),
          }),
        )
      }
    }

    // Reap archives past the retention TTL, each under lock + a fresh veto.
    const archives = yield* scanArchives({ repoRoot: repoFullPath, bareRepoPath })
    for (const entry of archives) {
      if (candidatePath !== undefined && entry.path !== candidatePath) continue
      if (now - entry.archivedAtMs < config.archiveRetentionMs) continue

      const reapTarget: NamedWorktreeTarget = {
        repoRelativePath,
        repoFullPath,
        bareRepoPath,
        worktree: {
          ref: entry.branch,
          refType: 'heads',
          path: entry.path,
          broken: false,
        },
      }

      if (dryRun === true) {
        results.push(coldResult({ target: reapTarget, status: 'reaped', reason: 'retention' }))
        continue
      }

      const reapAction = Effect.gen(function* () {
        const freshLiveSet = yield* reReconcileLiveSet({ store, root, now })
        if (isPathProtected({ liveSet: freshLiveSet, path: entry.path }) === true) {
          return { _tag: 'kept-live' as const }
        }
        yield* reapArchive({ bareRepoPath, path: entry.path })
        return { _tag: 'reaped' as const }
      })
      const reapOutcome = yield* (
        lockAlreadyHeld === true ? reapAction : storeLock.withWorktreeLock(entry.path)(reapAction)
      ).pipe(
        Effect.catch((error) =>
          Effect.succeed({
            _tag: 'error' as const,
            message: error instanceof Error === true ? error.message : String(error),
          }),
        ),
      )

      if (reapOutcome._tag === 'kept-live') {
        results.push(coldResult({ target: reapTarget, status: 'kept', reason: 'live' }))
      } else if (reapOutcome._tag === 'error') {
        results.push(
          coldResult({
            target: reapTarget,
            status: 'error',
            reason: 'retention',
            message: reapOutcome.message,
          }),
        )
      } else {
        results.push(coldResult({ target: reapTarget, status: 'reaped', reason: 'retention' }))
      }
    }

    return results
  }).pipe(LibObservability.withColdReclaimRepoSpan({ repoRelativePath, bareRepoPath }))

/** List repos in the store */
const storeLsCommand = Cli.Command.make('ls', { output: outputOption }, ({ output }) =>
  Effect.gen(function* () {
    const store = yield* Store
    const repos = yield* store.listRepos

    yield* runStoreCommand({
      output,
      action: {
        _tag: 'SetLs',
        basePath: store.basePath,
        repos: repos.map((r) => ({ relativePath: r.relativePath })),
      },
    })
  }).pipe(
    Effect.provide(StoreLayer),
    Observability.withCommandSpan({
      name: 'megarepo/store/ls',
      command: 'store ls',
      label: 'ls',
      output,
    }),
  ),
).pipe(Cli.Command.withDescription('List repositories in the store'))

/** Show store status and detect issues */
const storeStatusCommand = Cli.Command.make('status', { output: outputOption }, ({ output }) =>
  Effect.gen(function* () {
    const cwd = yield* Cwd
    const store = yield* Store
    const fs = yield* FileSystem.FileSystem

    const root = yield* findMegarepoRoot(cwd)
    const now = yield* Clock.currentTimeMillis
    const liveSet = yield* collectStoreLiveSet({
      store,
      ...(Option.isSome(root) === true ? { currentWorkspaceRoot: root.value } : {}),
      pruneStaleRegistry: true,
      refreshCurrentWorkspace: true,
      now,
    })

    // List all repos and analyze worktrees in parallel
    const repos = yield* store.listRepos

    const repoResults = yield* Effect.all(
      repos.map((repo) =>
        Effect.gen(function* () {
          const bareRepoPath = EffectPath.ops.join(
            repo.fullPath,
            EffectPath.unsafe.relativeDir('.bare/'),
          )
          const bareExists = yield* fs.exists(bareRepoPath)

          const refsDir = EffectPath.ops.join(repo.fullPath, EffectPath.unsafe.relativeDir('refs/'))
          const refsExists = yield* fs.exists(refsDir)
          if (refsExists === false) return []

          // Reuse the bounded, source-of-truth-guarded collector (same path gc
          // uses) so a broken worktree never makes the walk enumerate its entire
          // checked-out working tree (the store-status OOM, same root cause).
          const allWorktrees = yield* collectRepoStoreWorktrees({
            fs,
            repoPath: repo.fullPath,
            bareRepoPath,
          })

          // Analyze all worktrees for this repo in parallel
          return yield* Effect.all(
            allWorktrees.map(
              ({ path: worktreePath, ref: expectedRef, refType: refTypeDir, broken }) =>
                Effect.gen(function* () {
                  const issues: StoreWorktreeIssue[] = []

                  if (bareExists === false) {
                    issues.push({
                      type: 'missing_bare',
                      severity: 'error',
                      message: '.bare/ directory not found',
                    })
                  }

                  if (broken === true) {
                    issues.push({
                      type: 'broken_worktree',
                      severity: 'error',
                      message: '.git not found in worktree',
                    })
                  } else {
                    if (refTypeDir === 'heads') {
                      const actualBranch = yield* Git.getCurrentBranch(worktreePath).pipe(
                        Effect.orElseSucceed(() => Option.none<string>()),
                      )
                      if (
                        Option.isSome(actualBranch) === true &&
                        actualBranch.value !== expectedRef
                      ) {
                        issues.push({
                          type: 'ref_mismatch',
                          severity: 'error',
                          message: `path says '${expectedRef}' but HEAD is '${actualBranch.value}'`,
                        })
                      }
                    }

                    const worktreeStatus = yield* Git.getWorktreeStatus(worktreePath).pipe(
                      Effect.orElseSucceed(() => ({
                        isDirty: false,
                        hasUnpushed: false,
                        changesCount: 0,
                      })),
                    )
                    if (worktreeStatus.isDirty === true) {
                      issues.push({
                        type: 'dirty',
                        severity: 'warning',
                        message: `${worktreeStatus.changesCount} uncommitted change${worktreeStatus.changesCount !== 1 ? 's' : ''}`,
                      })
                    }
                    if (worktreeStatus.hasUnpushed === true) {
                      issues.push({
                        type: 'unpushed',
                        severity: 'warning',
                        message: 'has unpushed commits',
                      })
                    }
                  }

                  if (
                    classifyStoreWorktreePolicy({
                      liveSet,
                      mode: 'default',
                      worktree: {
                        refType: refTypeDir,
                        path: worktreePath,
                      },
                    }).isProtected === false
                  ) {
                    issues.push({
                      type: 'orphaned',
                      severity: 'info',
                      message: 'unrooted commit worktree; eligible for store gc when clean',
                    })
                  }

                  return {
                    repo: repo.relativePath,
                    ref: expectedRef,
                    refType: refTypeDir,
                    path: worktreePath,
                    issues,
                  } satisfies StoreWorktreeStatus
                }),
            ),
            { concurrency: 8 },
          )
        }),
      ),
      { concurrency: 8 },
    )

    const worktreeStatuses = repoResults.flat()
    const totalWorktreeCount = worktreeStatuses.length

    // Use TuiApp for output
    yield* runStoreCommand({
      output,
      action: {
        _tag: 'SetStatus',
        basePath: store.basePath,
        repoCount: repos.length,
        worktreeCount: totalWorktreeCount,
        worktrees: worktreeStatuses,
      },
    })
  }).pipe(
    Effect.provide(StoreLayer),
    Observability.withCommandSpan({
      name: 'megarepo/store/status',
      command: 'store status',
      label: 'status',
      output,
    }),
  ),
).pipe(Cli.Command.withDescription('Show store status and detect issues'))

/** Fetch all repos in the store */
const storeFetchCommand = Cli.Command.make('fetch', { output: outputOption }, ({ output }) =>
  Effect.gen(function* () {
    const store = yield* Store
    const repos = yield* store.listRepos
    const startTime = Date.now()

    // Fetch repos with limited concurrency
    const results = yield* Effect.all(
      repos.map((repo) =>
        Effect.gen(function* () {
          const bareRepoPath = EffectPath.ops.join(
            repo.fullPath,
            EffectPath.unsafe.relativeDir('.bare/'),
          )

          return yield* Git.fetchBare({
            repoPath: bareRepoPath,
          }).pipe(
            Effect.map(() => ({ path: repo.relativePath, status: 'fetched' as const })),
            Effect.catch((error) => {
              const message = error instanceof Error === true ? error.message : String(error)
              return Effect.succeed({
                path: repo.relativePath,
                status: 'error' as const,
                message,
              })
            }),
          )
        }),
      ),
      { concurrency: 4 },
    )

    const elapsed = Date.now() - startTime

    // Use StoreApp for all output modes
    yield* runStoreCommand({
      output,
      action: {
        _tag: 'SetFetch',
        basePath: store.basePath,
        results: results,
        elapsedMs: elapsed,
      },
    })
  }).pipe(
    Effect.provide(StoreLayer),
    Observability.withCommandSpan({
      name: 'megarepo/store/fetch',
      command: 'store fetch',
      label: 'fetch',
      output,
    }),
  ),
).pipe(Cli.Command.withDescription('Fetch all repositories in the store'))

/**
 * Garbage collect unused worktrees from the store.
 * Removes worktrees that are not referenced by any megarepo's lock file.
 */
const storeGcCommand = Cli.Command.make(
  'gc',
  {
    output: outputOption,
    dryRun: Cli.Flag.boolean('dry-run').pipe(
      Cli.Flag.withDescription('Show what would be removed without removing'),
      Cli.Flag.withDefault(false),
    ),
    force: Cli.Flag.boolean('force').pipe(
      Cli.Flag.withAlias('f'),
      Cli.Flag.withDescription('Remove dirty worktrees (with uncommitted changes)'),
      Cli.Flag.withDefault(false),
    ),
    all: Cli.Flag.boolean('all').pipe(
      Cli.Flag.withDescription('Remove all worktrees (not just unused ones)'),
      Cli.Flag.withDefault(false),
    ),
    generatedArtifacts: Cli.Flag.boolean('generated-artifacts').pipe(
      Cli.Flag.withDescription('Plan configured generated-artifact cleanup'),
      Cli.Flag.withDefault(false),
    ),
    expectedPlan: Cli.Flag.string('expected-plan').pipe(
      Cli.Flag.withDescription('Apply only the exact generated-artifact dry-run plan'),
      Cli.Flag.optional,
    ),
    candidatePath: Cli.Flag.string('candidate-path').pipe(
      Cli.Flag.withDescription('Apply exactly one candidate from the expected dry-run plan'),
      Cli.Flag.optional,
    ),
  },
  ({ output, dryRun, force, all, generatedArtifacts, expectedPlan, candidatePath }) =>
    Effect.gen(function* () {
      const cwd = yield* Cwd
      const store = yield* Store
      const storeLock = yield* StoreLock
      const fs = yield* FileSystem.FileSystem

      let root = Option.none<AbsoluteDirPath>()
      let liveSetForMetrics: StoreLiveSet | undefined
      let gcWarning: { type: 'not_in_megarepo' | 'only_current_megarepo' } | undefined
      let repoCount: number | undefined
      let repoConcurrencyForMetrics = 1
      let planSha256: string | undefined
      const targetedApply =
        Option.isSome(expectedPlan) === true || Option.isSome(candidatePath) === true
      const planningOnly = dryRun === true || targetedApply === true

      if (generatedArtifacts === true && (all === true || force === true)) {
        return yield* new StoreCommandError({
          message: '--generated-artifacts is incompatible with --all and --force',
        })
      }
      if (targetedApply === true) {
        if (
          dryRun === true ||
          Option.isNone(expectedPlan) === true ||
          Option.isNone(candidatePath) === true
        ) {
          return yield* new StoreCommandError({
            message:
              '--expected-plan and --candidate-path must be provided together for a non-dry-run application',
          })
        }
        if (/^[0-9a-f]{64}$/u.test(expectedPlan.value) === false) {
          return yield* new StoreCommandError({
            message: '--expected-plan must be a lowercase SHA-256 digest',
          })
        }
        if (isNormalizedAbsolutePath(normalizeStorePath(candidatePath.value)) === false) {
          return yield* new StoreCommandError({
            message: '--candidate-path must be a normalized absolute path',
          })
        }
      }
      if (generatedArtifacts === true && dryRun === false && targetedApply === false) {
        return yield* new StoreCommandError({
          message: '--generated-artifacts mutation requires --expected-plan and --candidate-path',
        })
      }

      const processGcDecision = ({
        decision,
        repoRelativePath,
        bareRepoPath,
      }: {
        decision: GcWorktreeDecision
        repoRelativePath: string
        bareRepoPath: AbsoluteDirPath
      }) =>
        Effect.gen(function* () {
          const { worktree } = decision

          if (decision.action === 'skipped_in_use') {
            return {
              repo: repoRelativePath,
              ref: worktree.ref,
              refType: worktree.refType,
              path: worktree.path,
              status: 'skipped_in_use',
              ...(decision.message !== undefined ? { message: decision.message } : {}),
            } satisfies StoreGcResult
          }

          if (decision.action === 'status_failed' && force === false) {
            return {
              repo: repoRelativePath,
              ref: worktree.ref,
              refType: worktree.refType,
              path: worktree.path,
              status: 'skipped_dirty',
              message: `unable to inspect worktree status: ${decision.message}`,
            } satisfies StoreGcResult
          }

          if (
            decision.action === 'check' &&
            (decision.status.isDirty === true || decision.status.hasUnpushed === true) &&
            force === false
          ) {
            return {
              repo: repoRelativePath,
              ref: worktree.ref,
              refType: worktree.refType,
              path: worktree.path,
              status: 'skipped_dirty',
              message:
                decision.status.isDirty === true
                  ? `${decision.status.changesCount} uncommitted change(s)`
                  : 'has unpushed commits',
            } satisfies StoreGcResult
          }

          if (planningOnly === false) {
            const removeResult = yield* storeLock
              .withWorktreeLock(worktree.path)(
                Effect.gen(function* () {
                  const removalPolicy = yield* classifyGcProtection({
                    store,
                    currentWorkspaceRoot: root,
                    worktree,
                    all,
                  })
                  if (removalPolicy.isProtected === true) {
                    return { _tag: 'skipped_live' as const, message: removalPolicy.message }
                  }

                  yield* fs.remove(worktree.path, { recursive: true })
                  return { _tag: 'removed' as const }
                }),
              )
              .pipe(
                Effect.catch((error) =>
                  Effect.succeed({
                    _tag: 'error' as const,
                    message: error instanceof Error === true ? error.message : String(error),
                  }),
                ),
              )

            if (removeResult._tag === 'skipped_live') {
              return {
                repo: repoRelativePath,
                ref: worktree.ref,
                refType: worktree.refType,
                path: worktree.path,
                status: 'skipped_in_use',
                ...(removeResult.message !== undefined ? { message: removeResult.message } : {}),
              } satisfies StoreGcResult
            }

            if (removeResult._tag === 'error') {
              return {
                repo: repoRelativePath,
                ref: worktree.ref,
                refType: worktree.refType,
                path: worktree.path,
                status: 'error',
                message: removeResult.message,
              } satisfies StoreGcResult
            }
          }

          return {
            repo: repoRelativePath,
            ref: worktree.ref,
            refType: worktree.refType,
            path: worktree.path,
            status: 'removed',
          } satisfies StoreGcResult
        }).pipe(
          Observability.withStoreWorktreeSpan({
            name: 'megarepo/store/gc/process-worktree',
            repo: repoRelativePath,
            refType: decision.worktree.refType,
            ref: decision.worktree.ref,
            worktreePath: decision.worktree.path,
            bareRepoPath,
          }),
        )

      const results: StoreGcResult[] = []
      let lastProgressResultCount = 0
      let completedRepoCount = 0
      let discoveredWorktreeCount = 0
      let activeWorktreeCount = 0
      let statusMessage: string | undefined = 'preparing store gc'

      const dispatchGc = ({
        done,
        forceDispatch = false,
      }: {
        done: boolean
        forceDispatch?: boolean
      }) =>
        Effect.sync(() => {
          if (
            forceDispatch === false &&
            done === false &&
            results.length - lastProgressResultCount < GC_PROGRESS_BATCH_SIZE
          ) {
            return
          }
          lastProgressResultCount = results.length
          const dispatch = tuiDispatch
          if (dispatch === undefined) return
          dispatch(
            toStoreGcAction({
              basePath: store.basePath,
              results,
              dryRun,
              warning: gcWarning,
              force,
              repoCount,
              completedRepoCount,
              discoveredWorktreeCount,
              activeWorktreeCount,
              statusMessage,
              done,
              planSha256,
            }),
          )
        })

      let tuiDispatch: ((action: StoreAction) => void) | undefined

      const executeGc = ({
        progressive,
        ownerLockHeld = false,
      }: {
        progressive: boolean
        ownerLockHeld?: boolean | undefined
      }): Effect.Effect<void, unknown, FileSystem.FileSystem | Scope.Scope | ChildProcessSpawner> =>
        Effect.gen(function* () {
          if (progressive === true) {
            yield* dispatchGc({ done: false, forceDispatch: true })
            yield* Stream.fromSchedule(Schedule.spaced('1 second')).pipe(
              Stream.runForEach(() => dispatchGc({ done: false, forceDispatch: true })),
              Effect.forkScoped,
            )
          }

          // Single decision clock for the whole run — every grace/retention/
          // persistence path reads THIS value, never the ambient wall clock again.
          const now = yield* Clock.currentTimeMillis

          // Resolve the tunable per-repo concurrency ONCE per run so the whole
          // run uses one consistent operating point (and one span attribute).
          const repoConcurrency = gcRepoConcurrency()
          repoConcurrencyForMetrics = repoConcurrency

          // Sample RSS into the `megarepo_store_gc_rss_bytes` gauge across the run
          // so the OTEL sweep can plot memory vs concurrency. The foundation
          // `sampleResource` primitive (wrapped by `sampleStoreGcRss`) owns the
          // gate: it no-ops with zero overhead (no periodic fiber) when telemetry
          // is off, so no double-gate is needed here.
          yield* Observability.sampleStoreGcRss({ repoConcurrency })

          statusMessage = 'collecting liveness registry'
          if (progressive === true) {
            yield* dispatchGc({ done: false, forceDispatch: true })
          }
          root = yield* findMegarepoRoot(cwd)
          // Default cold path reconciles EVERY present workspace once (decision
          // 0010) so a repin that ran no refreshing command is still caught; the
          // result is threaded everywhere. `--all` keeps its lighter collect.
          const liveSet = yield* collectStoreLiveSet({
            store,
            ...(Option.isSome(root) === true ? { currentWorkspaceRoot: root.value } : {}),
            // Generated-artifact mode is a read-only planner. Do not refresh,
            // reconcile, or prune the shared liveness registry while planning.
            pruneStaleRegistry: generatedArtifacts === false && planningOnly === false,
            refreshCurrentWorkspace: generatedArtifacts === false && planningOnly === false,
            ...(all === false && generatedArtifacts === false
              ? { reconcileAllWorkspaces: true }
              : {}),
            now,
          }).pipe(Observability.withStoreGcPhaseSpan({ phase: 'collect-liveness' }))
          liveSetForMetrics = liveSet

          gcWarning =
            all === false && Option.isNone(root) === true
              ? { type: 'not_in_megarepo' }
              : all === false && Option.isSome(root) === true
                ? { type: 'only_current_megarepo' }
                : undefined

          statusMessage = 'listing store repositories'
          if (progressive === true) {
            yield* dispatchGc({ done: false, forceDispatch: true })
          }
          const repos = yield* store.listRepos.pipe(
            Observability.withStoreGcPhaseSpan({ phase: 'list-repos' }),
          )
          repoCount = repos.length
          statusMessage = 'checking worktrees'
          if (progressive === true) {
            yield* dispatchGc({ done: false, forceDispatch: true })
          }

          // Per-repo collected worktrees, computed once so the default cold path
          // can record observations globally (ledger replaces, not merges) before
          // any per-repo classification.
          const repoWorktrees = yield* Effect.all(
            repos.map((repo) =>
              Effect.gen(function* () {
                const bareRepoPath = EffectPath.ops.join(
                  repo.fullPath,
                  EffectPath.unsafe.relativeDir('.bare/'),
                )
                const worktrees = yield* collectRepoStoreWorktrees({
                  fs,
                  repoPath: repo.fullPath,
                  bareRepoPath,
                })
                return { repo, bareRepoPath, worktrees }
              }),
            ),
            { concurrency: repoConcurrency },
          ).pipe(
            Observability.withStoreGcPhaseSpan({
              phase: 'collect-worktrees',
              repoCount: repos.length,
              repoConcurrency,
            }),
          )

          if (generatedArtifacts === true) {
            const config = yield* loadStoreGcConfig({ storeBasePath: store.basePath })
            discoveredWorktreeCount += repoWorktrees.reduce(
              (count, repo) => count + repo.worktrees.length,
              0,
            )
            const generatedPlan = yield* planGeneratedArtifacts({
              config,
              fs,
              liveSet,
              now,
              ...(progressive === true && targetedApply === false
                ? {
                    onArtifact: (result: StoreGcResult) =>
                      Effect.gen(function* () {
                        results.push(result)
                        yield* dispatchGc({ done: false })
                      }),
                    onRepoCompleted: () =>
                      Effect.gen(function* () {
                        completedRepoCount += 1
                        yield* dispatchGc({ done: false })
                      }),
                  }
                : {}),
              readCurrentTimeMillis: Clock.currentTimeMillis,
              repoWorktrees,
            })
            planSha256 = generatedPlan.planSha256
            if (progressive === false || targetedApply === true) {
              results.push(...generatedPlan.results)
              completedRepoCount += repoWorktrees.length
            }

            if (
              targetedApply === true &&
              Option.isSome(expectedPlan) === true &&
              Option.isSome(candidatePath) === true
            ) {
              if (generatedPlan.planSha256 !== expectedPlan.value) {
                return yield* new StoreCommandError({
                  message: 'store gc plan changed; refusing candidate application',
                })
              }
              const selected = generatedPlan.results.filter(
                (result) =>
                  normalizeStorePath(result.path) === normalizeStorePath(candidatePath.value) &&
                  result.outcome === 'would-delete',
              )
              if (selected.length !== 1 || selected[0]!.workspacePath === undefined) {
                return yield* new StoreCommandError({
                  message: 'candidate is missing, ambiguous, or no longer eligible',
                })
              }
              const ownerPath = selected[0]!.workspacePath
              const applied = yield* storeLock.withWorktreeLock(ownerPath)(
                Effect.gen(function* () {
                  const freshLiveSet = yield* reReconcileLiveSet({ store, root, now })
                  const freshConfig = yield* loadStoreGcConfig({
                    storeBasePath: store.basePath,
                  })
                  const freshRepos = yield* store.listRepos
                  const freshRepoWorktrees = yield* Effect.all(
                    freshRepos.map((repo) =>
                      Effect.gen(function* () {
                        const bareRepoPath = EffectPath.ops.join(
                          repo.fullPath,
                          EffectPath.unsafe.relativeDir('.bare/'),
                        )
                        const worktrees = yield* collectRepoStoreWorktrees({
                          fs,
                          repoPath: repo.fullPath,
                          bareRepoPath,
                        })
                        return { repo, worktrees }
                      }),
                    ),
                    { concurrency: repoConcurrency },
                  )
                  const freshPlan = yield* planGeneratedArtifacts({
                    config: freshConfig,
                    fs,
                    liveSet: freshLiveSet,
                    now,
                    readCurrentTimeMillis: Clock.currentTimeMillis,
                    repoWorktrees: freshRepoWorktrees,
                  })
                  if (freshPlan.planSha256 !== expectedPlan.value) {
                    return yield* new StoreCommandError({
                      message: 'store gc plan changed under owner lock; refusing deletion',
                    })
                  }
                  const freshCandidates = freshPlan.results.filter(
                    (result) =>
                      normalizeStorePath(result.path) === normalizeStorePath(candidatePath.value) &&
                      result.outcome === 'would-delete',
                  )
                  if (freshCandidates.length !== 1) {
                    return yield* new StoreCommandError({
                      message: 'candidate is missing, ambiguous, or no longer eligible',
                    })
                  }
                  const freshCandidate = freshCandidates[0]!
                  const canonicalOwner = yield* fs.realPath(ownerPath)
                  const canonicalCandidate = yield* fs.realPath(freshCandidate.path)
                  if (
                    freshCandidate.artifactClass === undefined ||
                    freshCandidate.workspacePath === undefined ||
                    normalizeStorePath(canonicalCandidate) !==
                      normalizeStorePath(`${canonicalOwner}/${freshCandidate.artifactClass}`)
                  ) {
                    return yield* new StoreCommandError({
                      message: 'candidate containment changed under owner lock',
                    })
                  }
                  const removalLiveSet = yield* reReconcileLiveSet({ store, root, now })
                  if (
                    isPathProtected({
                      liveSet: removalLiveSet,
                      path: freshCandidate.workspacePath,
                    }) === true
                  ) {
                    return yield* new StoreCommandError({
                      message: 'candidate owner became live before deletion',
                    })
                  }
                  const manifestPath = freshConfig.generatedArtifacts.agentLivenessManifest
                  if (manifestPath === undefined) {
                    return yield* new StoreCommandError({
                      message: 'agent liveness became unavailable before deletion',
                    })
                  }
                  const manifestContent = yield* fs
                    .readFileString(manifestPath)
                    .pipe(Effect.orElseSucceed(() => undefined))
                  const manifest =
                    manifestContent === undefined
                      ? undefined
                      : yield* Schema.decodeUnknownEffect(
                          Schema.fromJsonString(AgentLivenessManifest),
                        )(manifestContent).pipe(Effect.orElseSucceed(() => undefined))
                  const removalTime = yield* Clock.currentTimeMillis
                  if (
                    manifest === undefined ||
                    manifest.expiresAtMs < removalTime ||
                    manifest.activeWorkspacePaths.some(
                      (path) => isNormalizedAbsolutePath(path) === false,
                    ) === true
                  ) {
                    return yield* new StoreCommandError({
                      message: 'agent liveness became unknown before deletion',
                    })
                  }
                  const activeAgentPaths = yield* Effect.forEach(
                    manifest.activeWorkspacePaths,
                    (path) => fs.realPath(path).pipe(Effect.orElseSucceed(() => undefined)),
                    { concurrency: 1 },
                  )
                  if (
                    activeAgentPaths.some((path) => path === undefined) === true ||
                    activeAgentPaths.some(
                      (path) =>
                        path !== undefined &&
                        normalizeStorePath(path) === normalizeStorePath(canonicalOwner),
                    ) === true
                  ) {
                    return yield* new StoreCommandError({
                      message: 'candidate owner is live or liveness is unknown before deletion',
                    })
                  }
                  yield* fs.remove(freshCandidate.path, { recursive: true })
                  return { ...freshCandidate, outcome: 'deleted' as const }
                }),
              )
              results.splice(0, results.length, applied)
            }
          }

          // Default cold reclamation path (decisions 0001–0010): additive third
          // path. Named (`refs/heads/*`/`refs/tags/*`) worktrees are owned here;
          // `--all` removes everything via the legacy stream and skips this.
          if (all === false && generatedArtifacts === false) {
            const namedTargets: Array<NamedWorktreeTarget> = []
            for (const { repo, bareRepoPath, worktrees } of repoWorktrees) {
              for (const worktree of worktrees) {
                if (worktree.broken === true) continue
                if (isNamedRefWorktree(worktree) === false) continue
                namedTargets.push({
                  repoRelativePath: repo.relativePath,
                  repoFullPath: repo.fullPath,
                  bareRepoPath,
                  worktree,
                })
              }
            }

            // Cold = a named worktree absent from the reconciled live set. Record
            // the FULL cold set ONCE (the ledger is store-global; a per-repo write
            // would launder other repos' grace). Unclean-reconcile paths re-arm.
            const coldPaths = namedTargets
              .filter(
                (target) => isPathProtected({ liveSet, path: target.worktree.path }) === false,
              )
              .map((target) => normalizeStorePath(target.worktree.path))
            // The ledger read-modify-write is store-global; serialize it under a
            // stable store-keyed lock so concurrent gc runs don't clobber it. In
            // `--dry-run` we compute the would-be ledger WITHOUT persisting (and
            // without the lock) — a planning run must not advance the absence-grace
            // clock and so cause a later real run to archive.
            const ledger =
              planningOnly === true
                ? nextObservationLedger({
                    current: yield* readObservationLedger({ storeBasePath: store.basePath }),
                    coldPaths,
                    uncleanReconcilePaths: [...liveSet.uncleanReconcilePaths],
                    now,
                  })
                : yield* storeLock.withWorktreeLock(`${store.basePath}.state/gc-observations`)(
                    recordObservations({
                      storeBasePath: store.basePath,
                      coldPaths,
                      uncleanReconcilePaths: [...liveSet.uncleanReconcilePaths],
                      now,
                    }),
                  )

            const config = yield* loadStoreGcConfig({ storeBasePath: store.basePath })

            // Use an injected `PrStateResolver` when present (tests provide a stub
            // layer); otherwise build the live `gh`-shelling resolver here so the
            // default `mr store gc` path needs no extra wiring at the CLI edge.
            const injectedResolver = yield* Effect.serviceOption(PrStateResolver)
            const prResolver =
              Option.isSome(injectedResolver) === true
                ? injectedResolver.value
                : yield* PrStateResolver.pipe(Effect.provide(makePrStateResolverLayer()))

            statusMessage = 'reclaiming cold worktrees'
            if (progressive === true) {
              yield* dispatchGc({ done: false, forceDispatch: true })
            }

            // Group named targets by repo, then reclaim per repo (concurrency 1 so
            // a global PR snapshot can never go stale — resolve adjacent instead).
            yield* Stream.fromIterable(repoWorktrees).pipe(
              Stream.mapEffect(
                ({ repo, bareRepoPath }) =>
                  Effect.gen(function* () {
                    const repoNamed = namedTargets.filter(
                      (target) => target.repoRelativePath === repo.relativePath,
                    )
                    // Run for EVERY repo even with no current named refs: a repo
                    // whose branches were all archived still owns past-retention
                    // archives that `coldReclaimRepo` must scan + reap.
                    discoveredWorktreeCount += repoNamed.length
                    activeWorktreeCount += repoNamed.length
                    if (progressive === true) {
                      yield* dispatchGc({ done: false, forceDispatch: true })
                    }
                    const repoResults = yield* coldReclaimRepo({
                      store,
                      storeLock,
                      prResolver,
                      root,
                      repoRelativePath: repo.relativePath,
                      repoFullPath: repo.fullPath,
                      bareRepoPath,
                      namedWorktrees: repoNamed,
                      liveSet,
                      ledger,
                      config,
                      now,
                      dryRun: planningOnly,
                    }).pipe(
                      Effect.ensuring(
                        Effect.sync(() => {
                          activeWorktreeCount -= repoNamed.length
                        }),
                      ),
                    )
                    for (const result of repoResults) results.push(result)
                    if (progressive === true) {
                      yield* dispatchGc({ done: false, forceDispatch: true })
                    }
                  }),
                { concurrency: repoConcurrency, unordered: true },
              ),
              Stream.runDrain,
              Observability.withStoreGcPhaseSpan({
                phase: 'cold-reclaim',
                repoCount: repoWorktrees.length,
                worktreeCount: namedTargets.length,
                repoConcurrency,
              }),
            )
          }

          if (generatedArtifacts === false) {
            yield* Stream.fromIterable(repoWorktrees).pipe(
              Stream.mapEffect(
                ({ repo, bareRepoPath, worktrees: allWorktrees }) =>
                  Effect.gen(function* () {
                    let removedForRepo = 0
                    // Default mode owns named worktrees in the cold path above; the
                    // legacy stream only handles commit worktrees (and everything in
                    // `--all` mode).
                    const worktrees =
                      all === false
                        ? allWorktrees.filter(
                            (worktree) =>
                              worktree.broken === true || isNamedRefWorktree(worktree) === false,
                          )
                        : allWorktrees

                    yield* Stream.fromIterable(worktrees).pipe(
                      Stream.mapEffect(
                        (worktree) =>
                          Effect.gen(function* () {
                            discoveredWorktreeCount += 1
                            activeWorktreeCount += 1
                            if (progressive === true) {
                              yield* dispatchGc({ done: false, forceDispatch: true })
                            }
                            yield* Effect.gen(function* () {
                              const decision = yield* classifyGcWorktree({
                                worktree,
                                liveSet,
                                all,
                              })
                              const result = yield* processGcDecision({
                                decision,
                                repoRelativePath: repo.relativePath,
                                bareRepoPath,
                              })
                              if (result.status === 'removed' && planningOnly === false) {
                                removedForRepo += 1
                              }
                              results.push(result)
                            }).pipe(
                              Effect.ensuring(
                                Effect.sync(() => {
                                  activeWorktreeCount -= 1
                                }).pipe(
                                  Effect.andThen(
                                    progressive === true
                                      ? dispatchGc({ done: false, forceDispatch: true })
                                      : Effect.void,
                                  ),
                                ),
                              ),
                            )
                          }),
                        { concurrency: GC_WORKTREE_CONCURRENCY, unordered: true },
                      ),
                      Stream.runDrain,
                    )

                    if (removedForRepo > 0) {
                      yield* Git.pruneWorktrees(bareRepoPath).pipe(
                        Effect.catch((error) =>
                          Effect.sync(() => {
                            results.push({
                              repo: repo.relativePath,
                              ref: '.bare',
                              refType: 'commits',
                              path: bareRepoPath,
                              status: 'error',
                              message:
                                error instanceof Error === true ? error.message : String(error),
                            })
                          }),
                        ),
                      )
                    }

                    completedRepoCount += 1
                    if (progressive === true) {
                      yield* dispatchGc({ done: false, forceDispatch: true })
                    }
                  }).pipe(
                    Observability.withStoreWorktreeSpan({
                      name: 'megarepo/store/gc/repo',
                      repo: repo.relativePath,
                      refType: 'repo',
                      ref: Observability.shortPath(repo.relativePath),
                    }),
                  ),
                { concurrency: repoConcurrency, unordered: true },
              ),
              Stream.runDrain,
              Observability.withStoreGcPhaseSpan({
                phase: 'legacy-sweep',
                repoCount: repoWorktrees.length,
                repoConcurrency,
              }),
            )
          }

          if (generatedArtifacts === false && planningOnly === true) {
            planSha256 = planSha256For(results)
          }

          if (
            generatedArtifacts === false &&
            targetedApply === true &&
            Option.isSome(expectedPlan) === true &&
            Option.isSome(candidatePath) === true
          ) {
            if (planSha256 !== expectedPlan.value) {
              return yield* new StoreCommandError({
                message: 'store gc plan changed; refusing candidate application',
              })
            }
            const candidates = results.filter(
              (result) =>
                normalizeStorePath(result.path) === normalizeStorePath(candidatePath.value) &&
                (result.status === 'removed' ||
                  result.status === 'archived' ||
                  result.status === 'reaped'),
            )
            if (candidates.length !== 1) {
              return yield* new StoreCommandError({
                message: 'candidate is missing, ambiguous, or no longer eligible',
              })
            }
            const candidate = candidates[0]!
            const owner = repoWorktrees.find(({ repo }) => repo.relativePath === candidate.repo)
            if (owner === undefined) {
              return yield* new StoreCommandError({
                message: 'candidate owner repository is missing',
              })
            }

            if (ownerLockHeld === false) {
              results.splice(0, results.length)
              completedRepoCount = 0
              discoveredWorktreeCount = 0
              repoCount = undefined
              planSha256 = undefined
              return yield* storeLock.withWorktreeLock(candidate.path)(
                executeGc({ progressive: false, ownerLockHeld: true }),
              )
            }

            let applied: StoreGcResult
            if (candidate.status === 'removed') {
              const worktree = owner.worktrees.filter((entry) => entry.path === candidate.path)
              if (worktree.length !== 1) {
                return yield* new StoreCommandError({
                  message: 'candidate worktree is missing or ambiguous',
                })
              }
              applied = yield* Effect.gen(function* () {
                const freshLiveSet = yield* reReconcileLiveSet({ store, root, now })
                const decision = yield* classifyGcWorktree({
                  worktree: worktree[0]!,
                  liveSet: freshLiveSet,
                  all,
                })
                if (
                  decision.action !== 'check' ||
                  (force === false &&
                    (decision.status.isDirty === true || decision.status.hasUnpushed === true))
                ) {
                  return yield* new StoreCommandError({
                    message: 'candidate is live, dirty, or no longer inspectable',
                  })
                }
                yield* fs.remove(candidate.path, { recursive: true })
                const pruneWarning = yield* Git.pruneWorktrees(owner.bareRepoPath).pipe(
                  Effect.as(undefined),
                  Effect.catch((error) =>
                    Effect.succeed(
                      `worktree removed, but git worktree prune failed: ${
                        error instanceof Error === true ? error.message : String(error)
                      }`,
                    ),
                  ),
                )
                return pruneWarning === undefined
                  ? candidate
                  : { ...candidate, message: pruneWarning }
              })
            } else {
              const config = yield* loadStoreGcConfig({ storeBasePath: store.basePath })
              const injectedResolver = yield* Effect.serviceOption(PrStateResolver)
              const prResolver =
                Option.isSome(injectedResolver) === true
                  ? injectedResolver.value
                  : yield* PrStateResolver.pipe(Effect.provide(makePrStateResolverLayer()))
              const ledger = yield* readObservationLedger({ storeBasePath: store.basePath })
              const namedWorktrees = owner.worktrees
                .filter(
                  (worktree) =>
                    worktree.broken === false &&
                    isNamedRefWorktree(worktree) === true &&
                    worktree.path === candidate.path,
                )
                .map((worktree) => ({
                  repoRelativePath: owner.repo.relativePath,
                  repoFullPath: owner.repo.fullPath,
                  bareRepoPath: owner.bareRepoPath,
                  worktree,
                }))
              const appliedResults = yield* coldReclaimRepo({
                store,
                storeLock,
                prResolver,
                root,
                repoRelativePath: owner.repo.relativePath,
                repoFullPath: owner.repo.fullPath,
                bareRepoPath: owner.bareRepoPath,
                namedWorktrees,
                liveSet,
                ledger,
                config,
                now,
                dryRun: false,
                candidatePath: candidate.path,
                lockAlreadyHeld: ownerLockHeld,
              })
              const matching = appliedResults.filter(
                (result) =>
                  result.path === candidate.path &&
                  (result.status === 'archived' || result.status === 'reaped'),
              )
              if (matching.length !== 1) {
                return yield* new StoreCommandError({
                  message: 'candidate changed during owner-locked revalidation',
                })
              }
              applied = matching[0]!
            }
            results.splice(0, results.length, applied)
          }

          statusMessage = undefined
          if (progressive === true || ownerLockHeld === true) {
            yield* dispatchGc({ done: true, forceDispatch: true })
          }
        })

      // Final JSON callers want one stable document, not progress states. Run the
      // GC first and serialize only the final StoreApp state.
      const mode = yield* OutputModeTag.pipe(Effect.provide(outputModeLayer(output as never)))

      if (mode._tag === 'json' && mode.timing === 'final') {
        yield* executeGc({ progressive: false })
        yield* runStoreCommand({
          output,
          action: toStoreGcAction({
            basePath: store.basePath,
            results,
            dryRun,
            warning: gcWarning,
            force,
            repoCount,
            completedRepoCount,
            discoveredWorktreeCount,
            activeWorktreeCount,
            statusMessage,
            done: true,
            planSha256,
          }),
        })
      } else {
        yield* run(
          StoreApp,
          (tui) =>
            Effect.gen(function* () {
              tuiDispatch = tui.dispatch
              yield* executeGc({ progressive: true })
            }),
          { view: React.createElement(StoreView, { stateAtom: StoreApp.stateAtom }) },
        ).pipe(Effect.provide(outputModeLayer(output as never)))
      }

      yield* Observability.annotateStoreGcResult({
        rootSetWorkspaceCount: liveSetForMetrics?.workspaceCount ?? 0,
        repoTotal: repoCount ?? 0,
        worktreeDiscovered: discoveredWorktreeCount,
        resultTotal: results.length,
        resultRemoved: results.filter(
          (result) =>
            result.status === 'removed' ||
            result.outcome === 'would-delete' ||
            result.outcome === 'deleted',
        ).length,
        resultSkippedInUse: results.filter((result) => result.status === 'skipped_in_use').length,
        resultSkippedDirty: results.filter((result) => result.status === 'skipped_dirty').length,
        resultArchived: results.filter((result) => result.status === 'archived').length,
        resultReaped: results.filter((result) => result.status === 'reaped').length,
        resultKept: results.filter(
          (result) =>
            result.status === 'kept' &&
            result.outcome !== 'would-delete' &&
            result.outcome !== 'deleted' &&
            result.outcome !== 'unknown',
        ).length,
        candidateCommits: results.filter((result) => result.refType === 'commits').length,
        candidateNamedRefs: results.filter(
          (result) => result.refType === 'heads' || result.refType === 'tags',
        ).length,
        repoConcurrency: repoConcurrencyForMetrics,
      })
    }).pipe(
      Effect.provide(StoreLayer),
      Observability.withStoreGcSpan({
        policy: all === true ? 'all' : 'root-set',
        dryRun,
        force,
        all,
      }),
    ),
).pipe(Cli.Command.withDescription('Garbage collect unused worktrees'))

/**
 * Add a repository to the store without adding it to a megarepo.
 * Useful for pre-populating the cache or CI warm-up.
 */
const storeAddCommand = Cli.Command.make(
  'add',
  {
    source: Cli.Argument.string('source').pipe(
      Cli.Argument.withDescription('Repository source (owner/repo, URL, or owner/repo#ref)'),
    ),
    output: outputOption,
  },
  ({ source: sourceString, output }) =>
    Effect.gen(function* () {
      const store = yield* Store
      const fs = yield* FileSystem.FileSystem

      // Parse the source string
      const source = parseSourceString(sourceString)
      if (source === undefined) {
        yield* run(
          StoreApp,
          (tui) =>
            Effect.sync(() => {
              tui.dispatch({
                _tag: 'SetError',
                error: 'invalid_source',
                message: `Invalid source string: ${sourceString}`,
                source: sourceString,
              })
            }),
          { view: React.createElement(StoreView, { stateAtom: StoreApp.stateAtom }) },
        ).pipe(Effect.provide(outputModeLayer(output)))
        return yield* new StoreCommandError({ message: 'Invalid source' })
      }

      if (isRemoteSource(source) === false) {
        yield* run(
          StoreApp,
          (tui) =>
            Effect.sync(() => {
              tui.dispatch({
                _tag: 'SetError',
                error: 'local_path',
                message: 'Cannot add local path to store',
              })
            }),
          { view: React.createElement(StoreView, { stateAtom: StoreApp.stateAtom }) },
        ).pipe(Effect.provide(outputModeLayer(output)))
        return yield* new StoreCommandError({ message: 'Cannot add local path' })
      }

      const cloneUrl = getCloneUrl(source)
      if (cloneUrl === undefined) {
        yield* run(
          StoreApp,
          (tui) =>
            Effect.sync(() => {
              tui.dispatch({
                _tag: 'SetError',
                error: 'no_url',
                message: 'Cannot determine clone URL',
              })
            }),
          { view: React.createElement(StoreView, { stateAtom: StoreApp.stateAtom }) },
        ).pipe(Effect.provide(outputModeLayer(output)))
        return yield* new StoreCommandError({ message: 'Cannot get clone URL' })
      }

      const bareRepoPath = store.getBareRepoPath(source)
      const bareExists = yield* store.hasBareRepo(source)

      // Clone if needed (show progress for non-JSON modes)
      if (bareExists === false) {
        const repoBasePath = store.getRepoBasePath(source)
        yield* fs.makeDirectory(repoBasePath, { recursive: true })
        yield* Git.cloneBare({ url: cloneUrl, targetPath: bareRepoPath })
      }

      // Determine ref to use
      const sourceRef = getSourceRef(source)
      let targetRef: string
      if (Option.isSome(sourceRef) === true) {
        targetRef = sourceRef.value
      } else {
        // Get default branch
        const defaultBranch = yield* Git.getDefaultBranch({ repoPath: bareRepoPath })
        targetRef = Option.getOrElse(defaultBranch, () => 'main')
      }

      // Create worktree if needed
      const refType = classifyRef(targetRef)
      const worktreePath = store.getWorktreePath({ source, ref: targetRef, refType })
      const worktreeExists = yield* store.hasWorktree({ source, ref: targetRef, refType })

      if (worktreeExists === false) {
        const worktreeParent = EffectPath.ops.parent(worktreePath)
        if (worktreeParent !== undefined) {
          yield* fs.makeDirectory(worktreeParent, { recursive: true })
        }

        if (refType === 'commit' || refType === 'tag') {
          yield* Git.createWorktreeDetached({
            repoPath: bareRepoPath,
            worktreePath,
            commit: targetRef,
          })
        } else {
          yield* Git.createWorktree({
            repoPath: bareRepoPath,
            worktreePath,
            branch: targetRef,
            createBranch: false,
          }).pipe(
            Effect.catch(() =>
              Git.createWorktree({
                repoPath: bareRepoPath,
                worktreePath,
                branch: `origin/${targetRef}`,
                createBranch: false,
              }),
            ),
            Effect.catch(() =>
              Git.createWorktreeDetached({
                repoPath: bareRepoPath,
                worktreePath,
                commit: targetRef,
              }),
            ),
          )
        }
      }
      // Get the current commit
      const commitOpt = yield* Git.getCurrentCommit(worktreePath).pipe(Effect.option)
      const commit = Option.getOrUndefined(commitOpt)

      // Use TuiApp for output
      const alreadyExists = bareExists && worktreeExists
      yield* run(
        StoreApp,
        (tui) =>
          Effect.sync(() => {
            tui.dispatch({
              _tag: 'SetAdd',
              status: alreadyExists === true ? 'already_exists' : 'added',
              source: sourceString,
              ref: targetRef,
              commit,
              path: worktreePath,
            })
          }),
        { view: React.createElement(StoreView, { stateAtom: StoreApp.stateAtom }) },
      ).pipe(Effect.provide(outputModeLayer(output)))
    }).pipe(
      Effect.provide(StoreLayer),
      Observability.withStoreSourceSpan({
        name: 'megarepo/store/add',
        source: sourceString,
      }),
    ),
).pipe(Cli.Command.withDescription('Add a repository to the store (without adding to megarepo)'))

/** Fix store issues */
const storeFixCommand = Cli.Command.make(
  'fix',
  {
    output: outputOption,
    member: Cli.Argument.string('member').pipe(
      Cli.Argument.withDescription('Member to fix (optional, fixes all if omitted)'),
      Cli.Argument.optional,
    ),
    dryRun: Cli.Flag.boolean('dry-run').pipe(
      Cli.Flag.withDescription('Show what would be fixed without making changes'),
      Cli.Flag.withDefault(false),
    ),
  },
  ({ output, member, dryRun }) =>
    Effect.gen(function* () {
      const cwd = yield* Cwd
      const store = yield* Store

      const root = yield* findMegarepoRoot(cwd)
      if (Option.isNone(root) === true) {
        yield* run(
          StoreApp,
          (tui) =>
            Effect.sync(() => {
              tui.dispatch({
                _tag: 'SetError',
                error: 'not_in_megarepo',
                message: 'Not in a megarepo directory. Run this command from within a megarepo.',
              })
            }),
          { view: React.createElement(StoreView, { stateAtom: StoreApp.stateAtom }) },
        ).pipe(Effect.provide(outputModeLayer(output)))
        return yield* new StoreCommandError({ message: 'Not in a megarepo' })
      }

      const { config } = yield* readMegarepoConfig(root.value)

      const lockPath = EffectPath.ops.join(
        root.value,
        EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
      )
      const lockFileOpt = yield* readLockFile(lockPath)
      if (Option.isNone(lockFileOpt) === true) {
        yield* run(
          StoreApp,
          (tui) =>
            Effect.sync(() => {
              tui.dispatch({
                _tag: 'SetError',
                error: 'no_lock',
                message: 'No megarepo.lock found. Run `mr fetch` first.',
              })
            }),
          { view: React.createElement(StoreView, { stateAtom: StoreApp.stateAtom }) },
        ).pipe(Effect.provide(outputModeLayer(output)))
        return yield* new StoreCommandError({ message: 'No lock file' })
      }

      const lockFile = lockFileOpt.value

      // Determine which members to check
      const memberNames =
        Option.isSome(member) === true ? [member.value] : Object.keys(config.members)

      // Validate
      const issues = yield* validateStoreMembers({
        memberNames,
        config,
        lockFile,
        store,
      })

      if (issues.length === 0) {
        yield* run(
          StoreApp,
          (tui) =>
            Effect.sync(() => {
              tui.dispatch({
                _tag: 'SetFix',
                basePath: store.basePath,
                results: [],
                dryRun,
                noIssues: true,
              })
            }),
          { view: React.createElement(StoreView, { stateAtom: StoreApp.stateAtom }) },
        ).pipe(Effect.provide(outputModeLayer(output)))
        return
      }

      // Fix issues
      const results = yield* fixStoreIssues({ issues, store, dryRun })

      yield* run(
        StoreApp,
        (tui) =>
          Effect.sync(() => {
            tui.dispatch({
              _tag: 'SetFix',
              basePath: store.basePath,
              results,
              dryRun,
              noIssues: false,
            })
          }),
        { view: React.createElement(StoreView, { stateAtom: StoreApp.stateAtom }) },
      ).pipe(Effect.provide(outputModeLayer(output)))
    }).pipe(
      Effect.provide(StoreLayer),
      Observability.withCommandSpan({
        name: 'megarepo/store/fix',
        command: 'store fix',
        label: Option.isSome(member) === true ? member.value : 'fix',
        output,
        dryRun,
        ...(Option.isSome(member) === true ? { member: member.value } : {}),
      }),
    ),
).pipe(Cli.Command.withDescription('Fix store issues'))

/**
 * Create a new worktree in the store.
 * Auto-bootstraps bare repo if not present, fetches, then creates the worktree.
 */
const storeWorktreeNewCommand = Cli.Command.make(
  'new',
  {
    repo: Cli.Argument.string('repo').pipe(
      Cli.Argument.withDescription('Repository (owner/repo, URL, or store-relative path)'),
    ),
    ref: Cli.Flag.string('ref').pipe(
      Cli.Flag.withDescription('Branch or tag name to check out'),
      Cli.Flag.optional,
    ),
    base: Cli.Flag.string('base').pipe(
      Cli.Flag.withDescription('Base ref for creating a new branch (used with --ref)'),
      Cli.Flag.optional,
    ),
    commit: Cli.Flag.string('commit').pipe(
      Cli.Flag.withDescription('Commit SHA to check out (detached HEAD)'),
      Cli.Flag.optional,
    ),
    porcelain: Cli.Flag.boolean('porcelain').pipe(
      Cli.Flag.withDescription(
        'Output only the worktree path for scripting (e.g. cd $(mr store worktree new ... --porcelain))',
      ),
      Cli.Flag.withDefault(false),
    ),
    output: outputOption,
  },
  ({ repo: repoString, ref: refOpt, base: baseOpt, commit: commitOpt, porcelain, output }) =>
    Effect.gen(function* () {
      const store = yield* Store
      const fs = yield* FileSystem.FileSystem

      const ref = Option.getOrUndefined(refOpt)
      const base = Option.getOrUndefined(baseOpt)
      const commit = Option.getOrUndefined(commitOpt)

      // Validate: must specify --ref or --commit, not both
      if (ref === undefined && commit === undefined) {
        yield* run(
          StoreApp,
          (tui) =>
            Effect.sync(() => {
              tui.dispatch({
                _tag: 'SetError',
                error: 'missing_ref',
                message: 'Must specify --ref <branch|tag> or --commit <sha>',
              })
            }),
          { view: React.createElement(StoreView, { stateAtom: StoreApp.stateAtom }) },
        ).pipe(Effect.provide(outputModeLayer(output)))
        return yield* new StoreCommandError({ message: 'Must specify --ref or --commit' })
      }

      if (ref !== undefined && commit !== undefined) {
        yield* run(
          StoreApp,
          (tui) =>
            Effect.sync(() => {
              tui.dispatch({
                _tag: 'SetError',
                error: 'conflicting_options',
                message: 'Cannot specify both --ref and --commit',
              })
            }),
          { view: React.createElement(StoreView, { stateAtom: StoreApp.stateAtom }) },
        ).pipe(Effect.provide(outputModeLayer(output)))
        return yield* new StoreCommandError({ message: 'Cannot specify both --ref and --commit' })
      }

      if (base !== undefined && ref === undefined) {
        yield* run(
          StoreApp,
          (tui) =>
            Effect.sync(() => {
              tui.dispatch({
                _tag: 'SetError',
                error: 'base_without_ref',
                message: '--base requires --ref to specify the new branch name',
              })
            }),
          { view: React.createElement(StoreView, { stateAtom: StoreApp.stateAtom }) },
        ).pipe(Effect.provide(outputModeLayer(output)))
        return yield* new StoreCommandError({
          message: '--base requires --ref',
        })
      }

      // Parse repo source
      const source = parseSourceString(repoString)
      if (source === undefined) {
        yield* run(
          StoreApp,
          (tui) =>
            Effect.sync(() => {
              tui.dispatch({
                _tag: 'SetError',
                error: 'invalid_source',
                message: `Invalid repository: ${repoString}`,
                source: repoString,
              })
            }),
          { view: React.createElement(StoreView, { stateAtom: StoreApp.stateAtom }) },
        ).pipe(Effect.provide(outputModeLayer(output)))
        return yield* new StoreCommandError({ message: 'Invalid repository' })
      }

      if (isRemoteSource(source) === false) {
        yield* run(
          StoreApp,
          (tui) =>
            Effect.sync(() => {
              tui.dispatch({
                _tag: 'SetError',
                error: 'local_path',
                message: 'Cannot create worktree for local path',
              })
            }),
          { view: React.createElement(StoreView, { stateAtom: StoreApp.stateAtom }) },
        ).pipe(Effect.provide(outputModeLayer(output)))
        return yield* new StoreCommandError({ message: 'Cannot use local path' })
      }

      const cloneUrl = getCloneUrl(source)
      if (cloneUrl === undefined) {
        yield* run(
          StoreApp,
          (tui) =>
            Effect.sync(() => {
              tui.dispatch({
                _tag: 'SetError',
                error: 'no_url',
                message: 'Cannot determine clone URL',
              })
            }),
          { view: React.createElement(StoreView, { stateAtom: StoreApp.stateAtom }) },
        ).pipe(Effect.provide(outputModeLayer(output)))
        return yield* new StoreCommandError({ message: 'Cannot get clone URL' })
      }

      // Auto-bootstrap: clone bare repo if not in store
      const bareRepoPath = store.getBareRepoPath(source)
      const bareExists = yield* store.hasBareRepo(source)
      const autoBootstrap = bareExists === false

      if (autoBootstrap === true) {
        const repoBasePath = store.getRepoBasePath(source)
        yield* fs.makeDirectory(repoBasePath, { recursive: true })
        yield* Git.cloneBare({ url: cloneUrl, targetPath: bareRepoPath })
      }

      // Fetch to ensure refs are up to date
      yield* Git.fetchBare({ repoPath: bareRepoPath })

      // Determine target ref and worktree creation mode
      const targetRef = commit ?? ref!
      const isNewBranch = base !== undefined
      const refType = commit !== undefined ? ('commit' as const) : classifyRef(targetRef)

      // Compute worktree path
      const worktreePath = store.getWorktreePath({ source, ref: targetRef, refType })

      // Fail if worktree already exists
      const worktreeExists = yield* store.hasWorktree({ source, ref: targetRef, refType })
      if (worktreeExists === true) {
        yield* run(
          StoreApp,
          (tui) =>
            Effect.sync(() => {
              tui.dispatch({
                _tag: 'SetError',
                error: 'worktree_exists',
                message: `Worktree already exists at ${worktreePath}`,
              })
            }),
          { view: React.createElement(StoreView, { stateAtom: StoreApp.stateAtom }) },
        ).pipe(Effect.provide(outputModeLayer(output)))
        return yield* new StoreCommandError({
          message: `Worktree already exists at ${worktreePath}`,
        })
      }

      // Create parent directory
      const worktreeParent = EffectPath.ops.parent(worktreePath)
      if (worktreeParent !== undefined) {
        yield* fs.makeDirectory(worktreeParent, { recursive: true })
      }

      // Create the worktree
      if (commit !== undefined) {
        // Detached HEAD at specific commit
        yield* Git.createWorktreeDetached({
          repoPath: bareRepoPath,
          worktreePath,
          commit,
        })
      } else if (isNewBranch === true) {
        // New branch from base
        yield* Git.createWorktree({
          repoPath: bareRepoPath,
          worktreePath,
          branch: ref!,
          createBranch: true,
          startPoint: base,
        })
      } else {
        // Existing branch or tag
        if (refType === 'tag') {
          yield* Git.createWorktreeDetached({
            repoPath: bareRepoPath,
            worktreePath,
            commit: targetRef,
          })
        } else {
          yield* Git.createWorktree({
            repoPath: bareRepoPath,
            worktreePath,
            branch: targetRef,
            createBranch: false,
          }).pipe(
            Effect.catch(() =>
              Git.createWorktree({
                repoPath: bareRepoPath,
                worktreePath,
                branch: `origin/${targetRef}`,
                createBranch: false,
              }),
            ),
            Effect.catch(() =>
              Git.createWorktreeDetached({
                repoPath: bareRepoPath,
                worktreePath,
                commit: targetRef,
              }),
            ),
          )
        }
      }
      // Get the current commit in the new worktree
      const commitSha = yield* Git.getCurrentCommit(worktreePath).pipe(Effect.option)
      const resolvedCommit = Option.getOrUndefined(commitSha)

      // Porcelain: raw path output for scripting (e.g. cd $(mr store worktree new ... --porcelain))
      if (porcelain === true) {
        yield* Effect.sync(() => process.stdout.write(worktreePath.replace(/\/$/, '') + '\n'))
        return
      }

      // Output
      yield* run(
        StoreApp,
        (tui) =>
          Effect.sync(() => {
            tui.dispatch({
              _tag: 'SetWorktreeNew',
              source: repoString,
              ref: targetRef,
              path: worktreePath,
              commit: resolvedCommit,
              autoBootstrap,
              branchCreated: isNewBranch,
            })
          }),
        { view: React.createElement(StoreView, { stateAtom: StoreApp.stateAtom }) },
      ).pipe(Effect.provide(outputModeLayer(output)))
    }).pipe(
      Effect.provide(StoreLayer),
      Observability.withStoreSourceSpan({
        name: 'megarepo/store/worktree/new',
        source: repoString,
        ...(Option.isSome(refOpt) === true ? { ref: refOpt.value } : {}),
        ...(Option.isSome(baseOpt) === true ? { base: baseOpt.value } : {}),
        ...(Option.isSome(commitOpt) === true ? { commit: commitOpt.value } : {}),
        porcelain,
      }),
    ),
).pipe(Cli.Command.withDescription('Create a new worktree in the store'))

/** Worktree subcommand group */
const storeWorktreeCommand = Cli.Command.make('worktree', {}).pipe(
  Cli.Command.withSubcommands([storeWorktreeNewCommand]),
  Cli.Command.withDescription('Manage worktrees in the store'),
)

/** Store subcommand group */
export const storeCommand = Cli.Command.make('store', {}).pipe(
  Cli.Command.withSubcommands([
    storeAddCommand,
    storeLsCommand,
    storeStatusCommand,
    storeFetchCommand,
    storeGcCommand,
    storeFixCommand,
    storeWorktreeCommand,
  ]),
  Cli.Command.withDescription('Manage the shared git store'),
)
