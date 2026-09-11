/**
 * Cold-observation ledger (`$STORE/.state/gc-observations.json`).
 *
 * Absence grace (decision 0008) requires knowing how long a worktree has been
 * continuously cold — absent from every workspace's reconciled live set. Git
 * itself records no such "first seen cold" timestamp, so gc maintains a small
 * ledger mapping `normalizePath(worktreePath) -> firstSeenColdAtMs`.
 *
 * Contract:
 * - A path newly cold this run gets `firstSeenColdAtMs = now`.
 * - A path still cold keeps its existing `firstSeenColdAtMs` (grace advances).
 * - A path no longer cold is DROPPED — so if it later goes cold again the grace
 *   clock restarts. This is the "no continuity laundering" rule: a worktree that
 *   reappears in a live set then disappears again must serve a fresh grace
 *   window, not inherit credit from an older absence.
 * - Paths in `uncleanReconcilePaths` (their workspace failed a clean reconcile
 *   this run, decision 0010 / B2) are treated as not-cold: their grace does NOT
 *   advance, and any existing entry is dropped (re-arming, the conservative
 *   direction that keeps the worktree).
 *
 * Reads/writes are serialized by the caller under a store lock; the file is
 * written atomically. A corrupt/unreadable ledger is treated as empty, which
 * conservatively re-arms all grace windows.
 */

import { Effect, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { type PlatformError } from 'effect/PlatformError'

import { EffectPath, type AbsoluteDirPath, type AbsoluteFilePath } from '@overeng/effect-path'

import * as Observability from '../core/observability.ts'
import { writeFileAtomic } from './store-fs-atomic.ts'

/** Ledger schema: path -> epoch-ms it was first observed continuously cold. */
const GcObservationLedger = Schema.Record(Schema.String, Schema.Finite)

/** In-memory ledger: `normalizePath(worktreePath) -> firstSeenColdAtMs`. */
export type GcObservationLedger = Schema.Schema.Type<typeof GcObservationLedger>

/** Relative path of the ledger within the store. */
export const GC_OBSERVATIONS_RELATIVE_PATH = '.state/gc-observations.json'

const normalizePath = (path: string): string => path.replace(/\/+$/, '')

const ledgerPath = (storeBasePath: AbsoluteDirPath): AbsoluteFilePath =>
  EffectPath.ops.join(storeBasePath, EffectPath.unsafe.relativeFile(GC_OBSERVATIONS_RELATIVE_PATH))

/**
 * Compute the next ledger state from the current cold set (pure).
 *
 * This is the unit-tested transition seam. `coldPaths` are the worktree paths
 * observed cold this run; `uncleanReconcilePaths` are excluded from cold and
 * have their grace re-armed (dropped).
 */
export const nextObservationLedger = ({
  current,
  coldPaths,
  uncleanReconcilePaths = [],
  now,
}: {
  current: GcObservationLedger
  coldPaths: ReadonlyArray<string>
  uncleanReconcilePaths?: ReadonlyArray<string> | undefined
  now: number
}): GcObservationLedger => {
  const unclean = new Set(uncleanReconcilePaths.map(normalizePath))
  const next: Record<string, number> = {}
  for (const rawPath of coldPaths) {
    const path = normalizePath(rawPath)
    // Unclean-reconcile paths never advance grace: skip recording them entirely.
    if (unclean.has(path) === true) continue
    // Preserve an existing firstSeen (grace advances); else start the clock now.
    next[path] = current[path] ?? now
  }
  return next
}

/** Reads the ledger; corrupt/unreadable file ⇒ empty (conservatively re-arm grace). */
export const readObservationLedger = ({
  storeBasePath,
}: {
  storeBasePath: AbsoluteDirPath
}): Effect.Effect<GcObservationLedger, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = ledgerPath(storeBasePath)
    return yield* fs.readFileString(path).pipe(
      Effect.flatMap((content) =>
        Schema.decodeEffect(Schema.fromJsonString(GcObservationLedger))(content),
      ),
      Effect.orElseSucceed(() => ({}) as GcObservationLedger),
    )
  }).pipe(
    Observability.withLabelSpan({
      name: 'megarepo/store/gc/read-observations',
      labelValue: 'gc-observations',
    }),
  )

/** Atomically writes the ledger (creating `.state/` if needed). */
const writeObservationLedger = ({
  storeBasePath,
  ledger,
}: {
  storeBasePath: AbsoluteDirPath
  ledger: GcObservationLedger
}): Effect.Effect<void, PlatformError | Schema.SchemaError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = ledgerPath(storeBasePath)
    const stateDir = EffectPath.ops.join(storeBasePath, EffectPath.unsafe.relativeDir('.state/'))
    yield* fs.makeDirectory(stateDir, { recursive: true })
    const content = yield* Schema.encodeEffect(
      Schema.fromJsonString(GcObservationLedger, { space: 2 }),
    )(ledger)
    yield* writeFileAtomic({ path, content: content + '\n' })
  }).pipe(
    Observability.withLabelSpan({
      name: 'megarepo/store/gc/write-observations',
      labelValue: 'gc-observations',
    }),
  )

/**
 * Read-modify-write the ledger for one gc run and return the new state.
 *
 * MUST be called under a store lock (the caller guards the read-modify-write so
 * concurrent gc runs don't clobber each other). Returns the persisted ledger so
 * the caller can derive `coldSinceMs` without a second read.
 */
export const recordObservations = ({
  storeBasePath,
  coldPaths,
  uncleanReconcilePaths,
  now,
}: {
  storeBasePath: AbsoluteDirPath
  coldPaths: ReadonlyArray<string>
  uncleanReconcilePaths?: ReadonlyArray<string> | undefined
  now: number
}): Effect.Effect<GcObservationLedger, PlatformError | Schema.SchemaError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const current = yield* readObservationLedger({ storeBasePath })
    const next = nextObservationLedger({ current, coldPaths, uncleanReconcilePaths, now })
    yield* writeObservationLedger({ storeBasePath, ledger: next })
    return next
  }).pipe(
    Observability.withLabelSpan({
      name: 'megarepo/store/gc/record-observations',
      labelValue: 'gc-observations',
    }),
  )

/** Returns the epoch-ms a path was first seen cold, or `undefined` if not tracked. */
export const coldSinceMs = ({
  ledger,
  path,
}: {
  ledger: GcObservationLedger
  path: string
}): number | undefined => ledger[normalizePath(path)]
