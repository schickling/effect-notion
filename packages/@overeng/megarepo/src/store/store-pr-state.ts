/**
 * Branch -> GitHub PR-state resolver (decision 0001).
 *
 * A worktree's branch having a MERGED (or CLOSED, decision 0009) PR is the
 * primary positive staleness signal. Reliable detection requires GitHub's PR
 * state because the store's repos squash-merge — a merged branch can sit
 * thousands of commits "ahead" of `main`, so the git-only ancestor proxy is
 * useless. We therefore shell one batched `gh pr list` per repo and join PRs to
 * branches locally by `headRefName`.
 *
 * Conservative degradation (0005): absence of evidence never licenses deletion.
 * A non-GitHub remote, an unparseable repo path, `gh` failing/unauthenticated,
 * non-JSON output, or a timeout all resolve to `none` (keep). Only an
 * affirmative `merged`/`closed`/`open` from GitHub changes the decision.
 *
 * The service is a `Context.Tag` + `Layer.effect` (house convention). The live
 * layer shells `gh`; tests provide {@link makeStubPrStateResolver} backed by a
 * fixed map. The pure join/parse seams ({@link parseRepoCoordinates},
 * {@link decodePrListJson}, {@link resolvePrStateForBranch}) are unit-tested
 * directly with fake gh output so no real `gh`/network is needed.
 */

import { Context, Duration, Effect, Layer, Option, Schema } from 'effect'
import * as Command from 'effect/unstable/process/ChildProcess'
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner'

import type { RelativeDirPath } from '@overeng/effect-path'

import * as Observability from '../core/observability.ts'

/** GitHub host segment that gates PR-state resolution; any other host ⇒ all `none`. */
export const GITHUB_HOST = 'github.com'

/** Default `--limit` for the batched per-repo `gh pr list` call. */
export const DEFAULT_PR_LIST_LIMIT = 200

/** Default timeout for a single `gh` invocation; exceeding it ⇒ `none` (keep). */
export const DEFAULT_GH_TIMEOUT = Duration.seconds(30)

/**
 * Resolved PR state for a branch.
 *
 * `state` is the joined signal; timestamps are present only for the state that
 * carries them (`mergedAt` for `merged`, `closedAt` for `closed`). They are the
 * inputs the classifier's post-merge grace gate consumes, so they must round
 * trip in epoch-ms.
 */
export interface PrStateInfo {
  readonly state: 'merged' | 'closed' | 'open' | 'none'
  readonly mergedAt?: number | undefined
  readonly closedAt?: number | undefined
}

/** The conservative "no evidence" result (decision 0001): keep. */
export const PR_STATE_NONE: PrStateInfo = { state: 'none' }

/**
 * Resolves the PR state for one branch in one repo.
 *
 * `relativePath` is the store-relative repo path (`<host>/<owner>/<repo>/`);
 * `branch` is joined to `headRefName` VERBATIM (branch names contain `/`).
 */
export interface PrStateResolverService {
  readonly resolve: (args: {
    relativePath: RelativeDirPath
    branch: string
  }) => Effect.Effect<PrStateInfo>
}

/** PR-state resolver service tag. */
export class PrStateResolver extends Context.Service<PrStateResolver, PrStateResolverService>()(
  'megarepo/PrStateResolver',
) {}

// =============================================================================
// Pure seams (unit-tested directly with fake gh output)
// =============================================================================

/**
 * Parse `owner`/`repo` from a store-relative repo path.
 *
 * Store paths are `<host>/<owner>/<repo>/`. Only `github.com` resolves; any
 * other host (or a path without the three leading segments, e.g. `local/<name>/`)
 * yields `none` so the caller degrades to keep.
 */
export const parseRepoCoordinates = (
  relativePath: RelativeDirPath,
): Option.Option<{ owner: string; repo: string }> => {
  const segments = relativePath.split('/').filter((s) => s.length > 0)
  const [host, owner, repo] = segments
  if (host !== GITHUB_HOST || owner === undefined || repo === undefined) {
    return Option.none()
  }
  return Option.some({ owner, repo })
}

/** One PR row from `gh pr list --json number,state,headRefName,mergedAt,closedAt`. */
const GhPr = Schema.Struct({
  number: Schema.Finite,
  /** gh emits uppercase `MERGED`/`CLOSED`/`OPEN`. */
  state: Schema.Literals(['MERGED', 'CLOSED', 'OPEN']),
  headRefName: Schema.String,
  /** ISO 8601, or `null` when not merged. */
  mergedAt: Schema.NullOr(Schema.String),
  /** ISO 8601, or `null` when still open. */
  closedAt: Schema.NullOr(Schema.String),
})

/** Decoded `gh pr list` payload. */
export type GhPr = Schema.Schema.Type<typeof GhPr>

const GhPrList = Schema.Array(GhPr)

/**
 * Decode `gh pr list` JSON output into PR rows.
 *
 * Non-JSON or schema-invalid output (e.g. `gh` printed an error, or exited
 * non-zero leaving empty stdout) ⇒ `none`, which the caller maps to keep.
 */
export const decodePrListJson = (raw: string): Option.Option<ReadonlyArray<GhPr>> =>
  Schema.decodeOption(Schema.fromJsonString(GhPrList))(raw)

/** ISO 8601 ⇒ epoch ms; `null`/unparseable ⇒ `undefined`. */
const isoToMs = (iso: string | null): number | undefined => {
  if (iso === null) return undefined
  const ms = Date.parse(iso)
  return Number.isNaN(ms) === true ? undefined : ms
}

/**
 * Join PR rows to one branch and reduce to a single {@link PrStateInfo} (pure).
 *
 * Matches `headRefName` VERBATIM against `branch`. Resolution for the matches:
 * - no match ⇒ `none` (keep);
 * - ANY open ⇒ `open` (active work, keep regardless of other merged/closed PRs);
 * - else the most-recent merged/closed PR wins, ranked by its `mergedAt`/
 *   `closedAt` (a `merged` PR's `mergedAt`, a `closed` PR's `closedAt`). Rows
 *   missing a usable timestamp rank oldest so a dated PR is preferred.
 */
export const resolvePrStateForBranch = ({
  prs,
  branch,
}: {
  prs: ReadonlyArray<GhPr>
  branch: string
}): PrStateInfo => {
  const matches = prs.filter((pr) => pr.headRefName === branch)
  if (matches.length === 0) return PR_STATE_NONE

  if (matches.some((pr) => pr.state === 'OPEN') === true) return { state: 'open' }

  // Only MERGED/CLOSED remain; pick the most recent by its own timestamp.
  // `matches` is non-empty (the early return above guards `length === 0`) and
  // `ranked` is a 1:1 map of it, so `ranked[0]` is always defined.
  const ranked = matches
    .map((pr) => {
      const ts = pr.state === 'MERGED' ? isoToMs(pr.mergedAt) : isoToMs(pr.closedAt)
      return { pr, ts }
    })
    .toSorted((a, b) => (b.ts ?? -Infinity) - (a.ts ?? -Infinity))

  const winner = ranked[0]!

  if (winner.pr.state === 'MERGED') {
    return { state: 'merged', mergedAt: winner.ts }
  }
  return { state: 'closed', closedAt: winner.ts }
}

// =============================================================================
// Live layer (shells `gh`)
// =============================================================================

/**
 * Live `PrStateResolver` that shells one batched `gh pr list` per repo.
 *
 * Results are cached per `(relativePath, branch)` for the lifetime of the layer
 * (one gc run) so repeated branch lookups in a repo cost a single `gh` call.
 * Any failure mode — non-github host, spawn/exec error, non-JSON output, or
 * timeout — degrades to `none` (keep). The cache is built lazily and shared via
 * a synchronized map so concurrent lookups for the same repo coalesce.
 */
export const makePrStateResolverLayer = ({
  limit = DEFAULT_PR_LIST_LIMIT,
  timeout = DEFAULT_GH_TIMEOUT,
}: {
  limit?: number
  timeout?: Duration.Input
} = {}): Layer.Layer<PrStateResolver, never, ChildProcessSpawner> =>
  Layer.effect(
    PrStateResolver,
    Effect.gen(function* () {
      // Capture the executor once at layer build so the service's `resolve`
      // effects discharge their `CommandExecutor` requirement here (the live
      // shelling is an implementation detail, not part of the service R-channel).
      const spawner = yield* ChildProcessSpawner

      /** repo `owner/repo` -> decoded PR rows (Option.none ⇒ resolved to no evidence). */
      const repoCache = new Map<string, Option.Option<ReadonlyArray<GhPr>>>()

      const fetchRepoPrs = ({
        owner,
        repo,
      }: {
        owner: string
        repo: string
      }): Effect.Effect<Option.Option<ReadonlyArray<GhPr>>> =>
        Effect.gen(function* () {
          const raw = yield* spawner
            .string(
              Command.make('gh', [
                'pr',
                'list',
                '--repo',
                `${owner}/${repo}`,
                '--state',
                'all',
                '--limit',
                String(limit),
                '--json',
                'number,state,headRefName,mergedAt,closedAt',
              ]),
            )
            .pipe(
              Effect.timeout(timeout),
              // Any spawn/exec/timeout failure ⇒ no evidence (keep).
              Effect.option,
            )
          return Option.flatMap(raw, decodePrListJson)
        })

      const resolve = ({
        relativePath,
        branch,
      }: {
        relativePath: RelativeDirPath
        branch: string
      }): Effect.Effect<PrStateInfo> =>
        Effect.gen(function* () {
          const coords = parseRepoCoordinates(relativePath)
          if (Option.isNone(coords) === true) return PR_STATE_NONE
          const { owner, repo } = coords.value
          const key = `${owner}/${repo}`

          const cached = repoCache.get(key)
          const prs =
            cached ??
            (yield* fetchRepoPrs({ owner, repo }).pipe(
              Effect.tap((result) => Effect.sync(() => repoCache.set(key, result))),
            ))

          if (Option.isNone(prs) === true) return PR_STATE_NONE
          return resolvePrStateForBranch({ prs: prs.value, branch })
        }).pipe(Observability.withResolvePrStateSpan(branch))

      return { resolve }
    }),
  )

// =============================================================================
// Stub layer (tests)
// =============================================================================

/** A single stubbed PR-list response keyed by store-relative repo path. */
export interface StubPrRepo {
  readonly relativePath: RelativeDirPath
  readonly prs: ReadonlyArray<GhPr>
}

/**
 * Build a deterministic stub `PrStateResolver` from fixed per-repo PR rows.
 *
 * Mirrors the live join semantics ({@link resolvePrStateForBranch}) but reads
 * from the supplied map instead of shelling `gh`, so classification tests stay
 * pure and fast. A repo not present in `repos` resolves to `none`, matching the
 * live "no evidence ⇒ keep" degradation.
 */
export const makeStubPrStateResolver = (
  repos: ReadonlyArray<StubPrRepo>,
): PrStateResolverService => {
  const byPath = new Map<string, ReadonlyArray<GhPr>>(repos.map((r) => [r.relativePath, r.prs]))
  return {
    resolve: ({ relativePath, branch }) => {
      const prs = byPath.get(relativePath)
      if (prs === undefined) return Effect.succeed(PR_STATE_NONE)
      return Effect.succeed(resolvePrStateForBranch({ prs, branch }))
    },
  }
}

/** Layer wrapper around {@link makeStubPrStateResolver}. */
export const makeStubPrStateResolverLayer = (
  repos: ReadonlyArray<StubPrRepo>,
): Layer.Layer<PrStateResolver> => Layer.succeed(PrStateResolver, makeStubPrStateResolver(repos))
