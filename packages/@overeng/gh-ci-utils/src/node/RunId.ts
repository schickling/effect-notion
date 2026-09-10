import { Effect, Option, Schema } from 'effect'
/**
 * Target parser — unified resolution of CI targets.
 *
 * Supported patterns:
 * - (empty)               → current git branch, prefer PR runs
 * - `12345678`            → run ID (local repo)
 * - `#506`                → PR 506 (local repo)
 * - `main`                → branch (local repo, no slash)
 * - `@feat/foo`           → branch (local repo, `@` prefix for slash branches)
 * - `owner/repo`          → default branch (cross-repo)
 * - `owner/repo#506`      → PR 506 (cross-repo)
 * - `owner/repo@main`     → branch (cross-repo)
 * - GitHub run URL         → run ID + repo from URL
 * - GitHub PR URL          → PR + repo from URL
 */
import * as Cli from 'effect/unstable/cli'

import { ConfigError } from '../isomorphic/Errors.ts'
import { directRunSelection, type RunSelection } from '../isomorphic/lib/summary.ts'
import { detectCurrentBranch } from './Config.ts'
import { GitHubClient, selectRunForVerdict } from './GitHubClient.ts'

/** A resolved target: the run to inspect plus how it was chosen. */
export type ResolvedTarget = {
  readonly runId: number
  readonly repo: string
  readonly selection: RunSelection
}

// =============================================================================
// Parsed target types
// =============================================================================

/** Target specified as a numeric run id */
export const NumericTarget = Schema.TaggedStruct('Numeric', { runId: Schema.Finite })
/** Target specified as a full GitHub Actions URL */
export const UrlTarget = Schema.TaggedStruct('Url', {
  owner: Schema.String,
  repo: Schema.String,
  runId: Schema.Finite,
})
/** Target specified as a pull request URL */
export const PrUrlTarget = Schema.TaggedStruct('PrUrl', {
  owner: Schema.String,
  repo: Schema.String,
  prNumber: Schema.Finite,
})
/** Target referencing the local branch's latest PR */
export const LocalPrTarget = Schema.TaggedStruct('LocalPr', { prNumber: Schema.Finite })
/** Target referencing the local branch's latest run */
export const LocalBranchTarget = Schema.TaggedStruct('LocalBranch', { branch: Schema.String })
/** Target referencing the repo's default branch */
export const RepoDefaultTarget = Schema.TaggedStruct('RepoDefault', {
  owner: Schema.String,
  repo: Schema.String,
})
/** Target referencing a specific repo PR by number */
export const RepoPrTarget = Schema.TaggedStruct('RepoPr', {
  owner: Schema.String,
  repo: Schema.String,
  prNumber: Schema.Finite,
})
/** Target referencing a specific repo branch by name */
export const RepoBranchTarget = Schema.TaggedStruct('RepoBranch', {
  owner: Schema.String,
  repo: Schema.String,
  branch: Schema.String,
})

/** Union of all supported CI target specifiers */
export const ParsedTarget = Schema.Union([
  NumericTarget,
  UrlTarget,
  PrUrlTarget,
  LocalPrTarget,
  LocalBranchTarget,
  RepoDefaultTarget,
  RepoPrTarget,
  RepoBranchTarget,
])
export type ParsedTarget = typeof ParsedTarget.Type

// =============================================================================
// Parsing
// =============================================================================

const GITHUB_RUN_URL_PATTERN = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)/
const GITHUB_PR_URL_PATTERN = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/
const LOCAL_PR_PATTERN = /^#(\d+)$/
/** `@branch` — local branch (supports slashes in branch name) */
const LOCAL_BRANCH_PREFIX_PATTERN = /^@(.+)$/
/** `owner/repo#N` — cross-repo PR */
const REPO_PR_PATTERN = /^([^/]+)\/([^/#@]+)#(\d+)$/
/** `owner/repo@branch` — cross-repo branch */
const REPO_BRANCH_PATTERN = /^([^/]+)\/([^/#@]+)@(.+)$/
/** `owner/repo` — cross-repo default branch (exactly two path segments, no qualifier) */
const REPO_DEFAULT_PATTERN = /^([^/]+)\/([^/#@]+)$/

/** Parse a CLI argument string into a typed CI target */
export const parseTarget = (input: string): ParsedTarget => {
  const runUrlMatch = GITHUB_RUN_URL_PATTERN.exec(input)
  if (runUrlMatch) {
    return {
      _tag: 'Url',
      owner: runUrlMatch[1]!,
      repo: runUrlMatch[2]!,
      runId: Number(runUrlMatch[3]),
    }
  }

  const prUrlMatch = GITHUB_PR_URL_PATTERN.exec(input)
  if (prUrlMatch) {
    return {
      _tag: 'PrUrl',
      owner: prUrlMatch[1]!,
      repo: prUrlMatch[2]!,
      prNumber: Number(prUrlMatch[3]),
    }
  }

  const localPrMatch = LOCAL_PR_PATTERN.exec(input)
  if (localPrMatch) {
    return { _tag: 'LocalPr', prNumber: Number(localPrMatch[1]) }
  }

  const localBranchPrefixMatch = LOCAL_BRANCH_PREFIX_PATTERN.exec(input)
  if (localBranchPrefixMatch) {
    return { _tag: 'LocalBranch', branch: localBranchPrefixMatch[1]! }
  }

  const repoPrMatch = REPO_PR_PATTERN.exec(input)
  if (repoPrMatch) {
    return {
      _tag: 'RepoPr',
      owner: repoPrMatch[1]!,
      repo: repoPrMatch[2]!,
      prNumber: Number(repoPrMatch[3]),
    }
  }

  const repoBranchMatch = REPO_BRANCH_PATTERN.exec(input)
  if (repoBranchMatch) {
    return {
      _tag: 'RepoBranch',
      owner: repoBranchMatch[1]!,
      repo: repoBranchMatch[2]!,
      branch: repoBranchMatch[3]!,
    }
  }

  const asNumber = Number(input)
  if (Number.isFinite(asNumber) && asNumber > 0 && Number.isInteger(asNumber)) {
    return { _tag: 'Numeric', runId: asNumber }
  }

  const repoDefaultMatch = REPO_DEFAULT_PATTERN.exec(input)
  if (repoDefaultMatch) {
    return { _tag: 'RepoDefault', owner: repoDefaultMatch[1]!, repo: repoDefaultMatch[2]! }
  }

  return { _tag: 'LocalBranch', branch: input }
}

// =============================================================================
// Resolution
// =============================================================================

/**
 * Resolve a PR number to the run whose verdict describes the PR's head commit.
 *
 * Considers every run for the head SHA (any trigger event), so CI that runs on
 * `push`/`workflow_dispatch` is not invisible. Only if the head commit has no
 * runs at all does this fall back to the branch's `pull_request` listing — and
 * then the returned selection records that the verdict is about another commit
 * and/or another workflow.
 */
const resolvePrRun = Effect.fn('resolve-pr-run')(
  (repo: string, prNumber: number, preferWorkflow?: string) =>
    Effect.gen(function* () {
      const github = yield* GitHubClient
      const pr = yield* github.getPullRequest({ repo, prNumber })
      const branch = pr.head_branch
      if (!branch) {
        return yield* new ConfigError({
          message: `PR #${prNumber} has no head branch`,
          cause: 'no head branch',
        })
      }
      const headShaRuns = yield* github.listRunsForHeadSha({ repo, headSha: pr.head_sha })
      const headShaPick = selectRunForVerdict({
        runs: headShaRuns,
        ...(preferWorkflow !== undefined ? { preferWorkflow } : {}),
      })
      if (headShaPick.run) {
        return {
          runId: headShaPick.run.id,
          repo,
          selection: {
            ...headShaPick,
            prNumber,
            expectedHeadSha: pr.head_sha,
            runHeadSha: headShaPick.run.head_sha,
          },
        } satisfies ResolvedTarget
      }

      const fallback = yield* github.getLatestPRRun({
        repo,
        branch,
        ...(preferWorkflow !== undefined ? { preferWorkflow } : {}),
      })
      if (!fallback) {
        return yield* new ConfigError({
          message: `No CI runs found for PR #${prNumber} (branch: ${branch}) in ${repo}`,
          cause: 'not found',
        })
      }
      /**
       * The head commit has no runs at all, so `StaleRun` already carries the verdict.
       * Whether the *workflow* is the right one is still knowable from the fallback
       * run's own path — claiming otherwise adds a second, false warning about a run
       * of exactly the workflow the caller asked for.
       */
      return {
        runId: fallback.id,
        repo,
        selection: selectionForRun({
          run: fallback,
          preferWorkflow,
          prNumber,
          expectedHeadSha: pr.head_sha,
        }),
      } satisfies ResolvedTarget
    }),
)

/**
 * Selection for a run picked from a listing rather than matched against the PR's
 * head-commit runs: the workflow match is knowable from the run's own path, and
 * `expectedHeadSha` only when the caller knows which commit the verdict describes.
 * Nothing is claimed unless the caller named a workflow, since `ci.yml` is a
 * preference, not a demand.
 */
const selectionForRun = ({
  run,
  preferWorkflow,
  prNumber = null,
  expectedHeadSha = null,
}: {
  run: { readonly path: string; readonly head_sha: string }
  preferWorkflow: string | undefined
  prNumber?: number | null
  expectedHeadSha?: string | null
}): RunSelection => ({
  prNumber,
  expectedHeadSha,
  expectedWorkflow: preferWorkflow ?? null,
  matchedExpectedWorkflow: preferWorkflow === undefined || run.path.includes(preferWorkflow),
  runHeadSha: run.head_sha,
})

/** Resolve a PR number to the latest active CI run on its head branch. */
const resolveActivePrRun = Effect.fn('resolve-active-pr-run')(
  (repo: string, prNumber: number, preferWorkflow?: string) =>
    Effect.gen(function* () {
      const github = yield* GitHubClient
      const pr = yield* github.getPullRequest({ repo, prNumber })
      const branch = pr.head_branch
      if (!branch) {
        return yield* new ConfigError({
          message: `PR #${prNumber} has no head branch`,
          cause: 'no head branch',
        })
      }
      const run = yield* github.getLatestActivePRRun({
        repo,
        branch,
        ...(preferWorkflow !== undefined ? { preferWorkflow } : {}),
      })
      if (!run) {
        return yield* new ConfigError({
          message: `No active CI runs found for PR #${prNumber} (branch: ${branch}) in ${repo}`,
          cause: 'not found',
        })
      }
      return {
        runId: run.id,
        repo,
        selection: selectionForRun({
          run,
          preferWorkflow,
          prNumber,
        }),
      } satisfies ResolvedTarget
    }),
)

/** Resolve a branch to the latest run (tries PR runs first for workflow preference). */
const resolveBranchRun = Effect.fn('resolve-branch-run')(
  (repo: string, branch: string, preferWorkflow?: string) =>
    Effect.gen(function* () {
      const github = yield* GitHubClient
      const prRun = yield* github.getLatestPRRun({
        repo,
        branch,
        ...(preferWorkflow !== undefined ? { preferWorkflow } : {}),
      })
      if (prRun)
        return {
          runId: prRun.id,
          repo,
          selection: selectionForRun({
            run: prRun,
            preferWorkflow,
          }),
        } satisfies ResolvedTarget

      const run = yield* github.getLatestRunForBranch({ repo, branch })
      if (!run) {
        return yield* new ConfigError({
          message: `No runs found for branch '${branch}' in ${repo}`,
          cause: 'not found',
        })
      }
      return {
        runId: run.id,
        repo,
        selection: selectionForRun({
          run,
          preferWorkflow,
        }),
      } satisfies ResolvedTarget
    }),
)

/** Resolve a branch to the latest active run, preferring PR runs first for workflow preference. */
const resolveActiveBranchRun = Effect.fn('resolve-active-branch-run')(
  (repo: string, branch: string, preferWorkflow?: string) =>
    Effect.gen(function* () {
      const github = yield* GitHubClient
      const prRun = yield* github.getLatestActivePRRun({
        repo,
        branch,
        ...(preferWorkflow !== undefined ? { preferWorkflow } : {}),
      })
      if (prRun)
        return {
          runId: prRun.id,
          repo,
          selection: selectionForRun({
            run: prRun,
            preferWorkflow,
          }),
        } satisfies ResolvedTarget

      const run = yield* github.getLatestActiveRunForBranch({
        repo,
        branch,
        ...(preferWorkflow !== undefined ? { preferWorkflow } : {}),
      })
      if (!run) {
        return yield* new ConfigError({
          message: `No active runs found for branch '${branch}' in ${repo}`,
          cause: 'not found',
        })
      }
      return {
        runId: run.id,
        repo,
        selection: selectionForRun({
          run,
          preferWorkflow,
        }),
      } satisfies ResolvedTarget
    }),
)

const requireLocalRepo = (localRepo: Option.Option<string>) =>
  Option.match(localRepo, {
    onNone: () =>
      Effect.fail(
        new ConfigError({
          message: 'No local repo available. Use owner/repo as target to specify.',
          cause: 'no local repo',
        }),
      ),
    onSome: Effect.succeed,
  })

/** Resolve an explicit target string to a concrete run ID + repo + how it was chosen. */
export const resolveTarget = Effect.fn('resolve-target')(
  (input: string, localRepo: Option.Option<string>, preferWorkflow?: string) =>
    Effect.gen(function* () {
      const parsed = parseTarget(input)

      switch (parsed._tag) {
        case 'Numeric':
          return {
            runId: parsed.runId,
            repo: yield* requireLocalRepo(localRepo),
            selection: directRunSelection,
          }
        case 'Url':
          return {
            runId: parsed.runId,
            repo: `${parsed.owner}/${parsed.repo}`,
            selection: directRunSelection,
          }
        case 'PrUrl':
          return yield* resolvePrRun(
            `${parsed.owner}/${parsed.repo}`,
            parsed.prNumber,
            preferWorkflow,
          )
        case 'LocalPr':
          return yield* resolvePrRun(
            yield* requireLocalRepo(localRepo),
            parsed.prNumber,
            preferWorkflow,
          )
        case 'LocalBranch':
          return yield* resolveBranchRun(
            yield* requireLocalRepo(localRepo),
            parsed.branch,
            preferWorkflow,
          )
        case 'RepoDefault': {
          const github = yield* GitHubClient
          const repo = `${parsed.owner}/${parsed.repo}`
          const defaultBranch = yield* github.getDefaultBranch(repo)
          return yield* resolveBranchRun(repo, defaultBranch, preferWorkflow)
        }
        case 'RepoPr':
          return yield* resolvePrRun(
            `${parsed.owner}/${parsed.repo}`,
            parsed.prNumber,
            preferWorkflow,
          )
        case 'RepoBranch':
          return yield* resolveBranchRun(
            `${parsed.owner}/${parsed.repo}`,
            parsed.branch,
            preferWorkflow,
          )
      }
    }),
)

/** Resolve an explicit target string to an active run ID + repo. */
export const resolveActiveTarget = Effect.fn('resolve-active-target')(
  (input: string, localRepo: Option.Option<string>, preferWorkflow?: string) =>
    Effect.gen(function* () {
      const parsed = parseTarget(input)

      switch (parsed._tag) {
        case 'Numeric':
          return {
            runId: parsed.runId,
            repo: yield* requireLocalRepo(localRepo),
            selection: directRunSelection,
          }
        case 'Url':
          return {
            runId: parsed.runId,
            repo: `${parsed.owner}/${parsed.repo}`,
            selection: directRunSelection,
          }
        case 'PrUrl':
          return yield* resolveActivePrRun(
            `${parsed.owner}/${parsed.repo}`,
            parsed.prNumber,
            preferWorkflow,
          )
        case 'LocalPr':
          return yield* resolveActivePrRun(
            yield* requireLocalRepo(localRepo),
            parsed.prNumber,
            preferWorkflow,
          )
        case 'LocalBranch':
          return yield* resolveActiveBranchRun(
            yield* requireLocalRepo(localRepo),
            parsed.branch,
            preferWorkflow,
          )
        case 'RepoDefault': {
          const github = yield* GitHubClient
          const repo = `${parsed.owner}/${parsed.repo}`
          const defaultBranch = yield* github.getDefaultBranch(repo)
          return yield* resolveActiveBranchRun(repo, defaultBranch, preferWorkflow)
        }
        case 'RepoPr':
          return yield* resolveActivePrRun(
            `${parsed.owner}/${parsed.repo}`,
            parsed.prNumber,
            preferWorkflow,
          )
        case 'RepoBranch':
          return yield* resolveActiveBranchRun(
            `${parsed.owner}/${parsed.repo}`,
            parsed.branch,
            preferWorkflow,
          )
      }
    }),
)

/** Resolve target from explicit input or auto-detect from current git branch. */
export const resolveTargetOrCurrentBranch = Effect.fn('resolve-target-or-current-branch')(
  (input: Option.Option<string>, localRepo: string, preferWorkflow?: string) =>
    Effect.gen(function* () {
      if (Option.isSome(input)) {
        return yield* resolveTarget(input.value, Option.some(localRepo), preferWorkflow)
      }

      const branch = yield* detectCurrentBranch
      return yield* resolveBranchRun(localRepo, branch, preferWorkflow)
    }),
)

/** Resolve target from explicit input or auto-detect from current git branch, requiring an active run. */
export const resolveActiveTargetOrCurrentBranch = Effect.fn(
  'resolve-active-target-or-current-branch',
)((input: Option.Option<string>, localRepo: string, preferWorkflow?: string) =>
  Effect.gen(function* () {
    if (Option.isSome(input)) {
      return yield* resolveActiveTarget(input.value, Option.some(localRepo), preferWorkflow)
    }

    const branch = yield* detectCurrentBranch
    return yield* resolveActiveBranchRun(localRepo, branch, preferWorkflow)
  }),
)

// =============================================================================
// Shared CLI definitions
// =============================================================================

/** CLI positional argument for the CI run target */
export const targetArg = Cli.Argument.string('target').pipe(
  Cli.Argument.withDescription(
    'Run ID, #PR, branch, @branch, owner/repo, owner/repo#N, owner/repo@branch, or URL',
  ),
  Cli.Argument.optional,
)

/** CLI option to filter by workflow name */
export const workflowOption = Cli.Flag.string('workflow').pipe(
  Cli.Flag.optional,
  Cli.Flag.withDescription('Prefer this workflow file (default: ci.yml)'),
)

/** CLI option to enable watch/poll mode */
export const watchOption = Cli.Flag.boolean('watch').pipe(
  Cli.Flag.withAlias('w'),
  Cli.Flag.withDefault(false),
  Cli.Flag.withDescription(
    'Poll for updates; exits on first job failure unless --watch-mode is set',
  ),
)

/** Controls when `--watch` exits: on first job failure or only after all jobs complete */
export type WatchMode = 'first-failure' | 'until-done'

/**
 * Watch exit strategy. Only meaningful with `--watch`.
 *
 * TODO: Ideally this would be an optional value on `--watch` itself (e.g. `--watch=until-done`)
 * but Effect CLI does not support optional flag values yet.
 * See: https://github.com/Effect-TS/effect/issues/6182
 * See: https://github.com/Effect-TS/effect-smol/issues/2041
 */
export const watchModeOption = Cli.Flag.choice('watch-mode', [
  'first-failure',
  'until-done',
] as const).pipe(
  Cli.Flag.withDefault('first-failure' as WatchMode),
  Cli.Flag.withDescription(
    'Watch exit strategy: first-failure (default, exit on first job failure) or until-done (wait for all jobs)',
  ),
)

/** CLI option for watch-mode timeout in seconds */
export const timeoutOption = Cli.Flag.integer('timeout').pipe(
  Cli.Flag.withDefault(1800),
  Cli.Flag.withDescription('Max seconds to watch (default: 1800)'),
)
