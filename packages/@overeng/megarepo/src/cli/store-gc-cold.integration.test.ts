/**
 * Integration tests for the cold named-branch reclamation path of `mr store gc`
 * (U7 / decisions 0001–0010).
 *
 * Runs the REAL `mr store gc` command (through `mrCommand`) against store-shaped
 * fixtures with a deterministic decision clock (fixed `Clock`) and a stub
 * `PrStateResolver` layer (no real `gh`/network). Exercises the full matrix from
 * the plan's Test section:
 *
 *  - cross-megarepo registered ⇒ kept (live) vs unregistered+merged ⇒ archived
 *  - repin-without-reregister ⇒ new target kept (reconcile-all, B2 + 0010 bug)
 *  - present-but-unreadable workspace ⇒ its live worktree kept (B2)
 *  - merged + clean + reachable ⇒ archived + branch freed (mr-apply re-add works)
 *  - merged + dirty ⇒ archived with dirt intact
 *  - merged + stash ⇒ kept (B3)
 *  - merged + unpushed ⇒ kept (B1)
 *  - open ⇒ kept
 *  - squash-merged + remote-branch-deleted ⇒ kept (no reachable proof)
 *  - absence/post-merge grace unmet ⇒ kept
 *  - archived past retention ⇒ reaped; within retention ⇒ kept
 *  - veto re-checked at archive AND reap (a worktree made live mid-run is kept)
 *  - archive ⇒ mr-apply-equivalent re-materializes the branch (B4)
 *
 * The lossless floor, archive mechanics, and classifier gates have their own unit
 * + library integration tests; here we assert the END-TO-END command outcome
 * (`status`/`reason` in the JSON document and the on-disk effect).
 */

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Cause, Clock, Duration, Effect, Exit, Layer, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as Cli from 'effect/unstable/cli'
import * as Command from 'effect/unstable/process/ChildProcess'
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner'
import { expect, vi } from 'vitest'

import { EffectPath, type AbsoluteDirPath, type RelativeDirPath } from '@overeng/effect-path'

import * as Git from '../core/git.ts'
import { refreshWorkspaceRegistry } from '../store/store-liveness.ts'
import {
  makeStubPrStateResolverLayer,
  type GhPr,
  type StubPrRepo,
} from '../store/store-pr-state.ts'
import { makeStoreLayer, Store } from '../store/store.ts'
import { makeConsoleCapture } from '../test-utils/consoleCapture.ts'
import { requireTool } from '../test-utils/require-tool.ts'
import {
  createArchiveEntry,
  createStoreFixture,
  createWorkspaceWithLock,
  getWorktreeCommit,
  repinWorkspace,
} from '../test-utils/store-setup.ts'
import { mrCommand } from './mod.ts'

const DAY_MS = 24 * 60 * 60 * 1000
/** A fixed decision clock: well past every default grace window. */
const NOW = Date.parse('2026-06-11T12:00:00.000Z')
/** This file exercises the real command against full git/store fixtures on shared CI runners. */
const COLD_GC_E2E_TIMEOUT_MS = 240_000

vi.setConfig({
  hookTimeout: COLD_GC_E2E_TIMEOUT_MS,
  testTimeout: COLD_GC_E2E_TIMEOUT_MS,
})

const gitBin = requireTool('GIT_BIN')

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    return (yield* ChildProcessSpawner.use((spawner) =>
      spawner.string(Command.make(gitBin, args, { cwd })),
    )).trim()
  })

/** Live wall-clock for infra timers; decision time is overridden per test. */
const liveClock: Clock.Clock = {
  currentTimeMillisUnsafe: () => Date.now(),
  currentTimeMillis: Effect.sync(() => Date.now()),
  currentTimeNanosUnsafe: () => BigInt(Date.now()) * 1_000_000n,
  currentTimeNanos: Effect.sync(() => BigInt(Date.now()) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => process.hrtime.bigint(),
  monotonicTimeNanos: Effect.sync(() => process.hrtime.bigint()),
  sleep: (duration) =>
    Effect.callback((resume) => {
      const timer = setTimeout(() => resume(Effect.void), Duration.toMillis(duration))
      timer.unref?.()
    }),
}

/**
 * Deterministic decision clock so grace/retention decisions are reproducible.
 * Sleep delegates to the live clock so command-level timeouts remain real
 * deadlines instead of firing immediately under the fixed decision time.
 */
const fixedClockLayer = (nowMs: number) =>
  Layer.succeed(Clock.Clock, {
    currentTimeMillisUnsafe: () => nowMs,
    currentTimeMillis: Effect.succeed(nowMs),
    currentTimeNanosUnsafe: () => BigInt(nowMs) * 1_000_000n,
    currentTimeNanos: Effect.succeed(BigInt(nowMs) * 1_000_000n),
    monotonicTimeNanosUnsafe: liveClock.monotonicTimeNanosUnsafe,
    monotonicTimeNanos: liveClock.monotonicTimeNanos,
    sleep: (duration) => liveClock.sleep(duration),
  })

const StoreGcJsonOutput = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      repo: Schema.String,
      ref: Schema.String,
      path: Schema.String,
      status: Schema.String,
      message: Schema.optional(Schema.String),
      reason: Schema.optional(Schema.String),
      recoverPath: Schema.optional(Schema.String),
      pathRef: Schema.optional(Schema.String),
      actualHeadBranch: Schema.optional(Schema.String),
    }),
  ),
})
const decodeGc = Schema.decodeUnknownSync(Schema.fromJsonString(StoreGcJsonOutput))
type GcResult = Schema.Schema.Type<typeof StoreGcJsonOutput>['results'][number]

const findByRef = (results: ReadonlyArray<GcResult>, ref: string) =>
  results.find((result) => result.ref === ref)

/**
 * Run `mr store gc` end-to-end with a fixed clock, an injected stub
 * `PrStateResolver`, and `MEGAREPO_STORE` pointed at the fixture store.
 */
const runGc = ({
  cwd,
  storePath,
  prRepos,
  now = NOW,
  args = [],
}: {
  cwd: AbsoluteDirPath
  storePath: AbsoluteDirPath
  prRepos: ReadonlyArray<StubPrRepo>
  now?: number
  args?: ReadonlyArray<string>
}) =>
  Effect.gen(function* () {
    const { consoleLayer, getStdoutLines } = yield* makeConsoleCapture
    const previous = process.env['MEGAREPO_STORE']
    process.env['MEGAREPO_STORE'] = storePath

    // `mrCommand` provides its own `Cwd` layer from the `--cwd` global flag, so an
    // outer `Effect.provideService(Cwd, …)` is overridden and every command would
    // silently run against the ambient process cwd. Drive the documented flag.
    const argv = ['--cwd', cwd, 'store', 'gc', ...args, '--output', 'json']
    const exit = yield* Cli.Command.runWith(mrCommand, { version: 'test' })(argv).pipe(
      Effect.provide(
        Layer.mergeAll(
          consoleLayer,
          makeStubPrStateResolverLayer(prRepos),
          fixedClockLayer(now),
          NodeServices.layer,
        ),
      ),
      Effect.exit,
    )

    if (previous === undefined) delete process.env['MEGAREPO_STORE']
    else process.env['MEGAREPO_STORE'] = previous

    const stdout = (yield* getStdoutLines).join('\n')
    if (Exit.isSuccess(exit) === false) {
      return yield* Effect.die(
        new Error(`mr store gc failed:\n${Cause.pretty(exit.cause)}\nstdout:\n${stdout}`),
      )
    }
    return { exitCode: 0, results: decodeGc(stdout).results }
  }).pipe(Effect.scoped)

const REPO = { host: 'github.com', owner: 'acme', repo: 'widget' } as const
const REPO_KEY = `${REPO.host}/${REPO.owner}/${REPO.repo}`
const REPO_RELATIVE = `${REPO_KEY}/` as RelativeDirPath

const mergedPr = (branch: string, mergedAt: number): GhPr => ({
  number: 1,
  state: 'MERGED',
  headRefName: branch,
  mergedAt: new Date(mergedAt).toISOString(),
  closedAt: new Date(mergedAt).toISOString(),
})

const openPr = (branch: string): GhPr => ({
  number: 2,
  state: 'OPEN',
  headRefName: branch,
  mergedAt: null,
  closedAt: null,
})

const closedPr = (branch: string, closedAt: number): GhPr => ({
  number: 3,
  state: 'CLOSED',
  headRefName: branch,
  mergedAt: null,
  closedAt: new Date(closedAt).toISOString(),
})

/** Materialize a real `refs/heads/<branch>` ref for a fixture (detached) worktree. */
const materializeBranchRef = ({
  bareRepoPath,
  branch,
  commit,
}: {
  bareRepoPath: AbsoluteDirPath
  branch: string
  commit: string
}) => git(bareRepoPath, 'branch', branch, commit)

/**
 * Pre-seed the observation ledger so absence grace (default 14d) is already
 * satisfied at NOW: run gc once `sinceDays` in the past with no PR evidence, which
 * records `firstSeenColdAtMs` for every then-cold named worktree.
 */
const seedColdObservation = ({
  cwd,
  storePath,
  sinceDays = 20,
}: {
  cwd: AbsoluteDirPath
  storePath: AbsoluteDirPath
  sinceDays?: number
}) =>
  runGc({
    cwd,
    storePath,
    prRepos: [{ relativePath: REPO_RELATIVE, prs: [] }],
    now: NOW - sinceDays * DAY_MS,
  })

/** An outside cwd (not in any megarepo) so gc uses the registry-only liveness. */
const outsideCwd = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
    const cwd = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('outside/'))
    yield* fs.makeDirectory(cwd, { recursive: true })
    return cwd
  })

describe('mr store gc — cold named-branch reclamation', () => {
  it.effect(
    'merged + clean + reachable ⇒ archived, branch freed, mr-apply re-add works',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { storePath, bareRepoPaths, worktreePaths } = yield* createStoreFixture([
          { ...REPO, branches: ['feature/merged'], withRemote: true },
        ])
        const bareRepoPath = bareRepoPaths[REPO_KEY]!
        const worktreePath = worktreePaths[`${REPO_KEY}#feature/merged`]!
        const commit = yield* getWorktreeCommit(worktreePath)
        yield* materializeBranchRef({ bareRepoPath, branch: 'feature/merged', commit })

        const cwd = yield* outsideCwd()
        yield* seedColdObservation({ cwd, storePath })
        const { results } = yield* runGc({
          cwd,
          storePath,
          prRepos: [
            { relativePath: REPO_RELATIVE, prs: [mergedPr('feature/merged', NOW - 30 * DAY_MS)] },
          ],
        })

        const result = findByRef(results, 'feature/merged')
        expect(result?.status).toBe('archived')
        expect(result?.reason).toBe('merged')
        expect(result?.recoverPath).toContain('/.archive/feature/merged--')
        // Original gone, branch freed.
        expect(yield* fs.exists(worktreePath)).toBe(false)
        expect(
          yield* Git.refExists({ repoPath: bareRepoPath, ref: 'refs/heads/feature/merged' }),
        ).toBe(false)
        // mr-apply-equivalent re-materialization succeeds (B4).
        const reAddPath = EffectPath.ops.join(
          storePath,
          EffectPath.unsafe.relativeDir(`${REPO_KEY}/refs/heads/feature/merged/`),
        )
        yield* git(bareRepoPath, 'branch', 'feature/merged', commit)
        yield* git(bareRepoPath, 'worktree', 'add', reAddPath, 'feature/merged')
        expect(yield* fs.exists(reAddPath)).toBe(true)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'default branch ⇒ kept (never archived) even when merged + clean + grace-met',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { storePath, bareRepoPaths, worktreePaths } = yield* createStoreFixture([
          { ...REPO, branches: ['trunk'], withRemote: true },
        ])
        const bareRepoPath = bareRepoPaths[REPO_KEY]!
        const worktreePath = worktreePaths[`${REPO_KEY}#trunk`]!
        const commit = yield* getWorktreeCommit(worktreePath)
        yield* materializeBranchRef({ bareRepoPath, branch: 'trunk', commit })
        // Make `trunk` the repo's default branch (the bare's HEAD).
        yield* git(bareRepoPath, 'symbolic-ref', 'HEAD', 'refs/heads/trunk')

        const cwd = yield* outsideCwd()
        // Seed cold so absence grace is satisfied — proving the keep reason is the
        // default-branch guard, not `absence-grace`. A merged PR would otherwise archive.
        yield* seedColdObservation({ cwd, storePath })
        const { results } = yield* runGc({
          cwd,
          storePath,
          prRepos: [{ relativePath: REPO_RELATIVE, prs: [mergedPr('trunk', NOW - 30 * DAY_MS)] }],
        })

        const result = findByRef(results, 'trunk')
        expect(result?.status).toBe('kept')
        expect(result?.reason).toBe('default-branch')
        // Untouched on disk; branch ref intact.
        expect(yield* fs.exists(worktreePath)).toBe(true)
        expect(yield* Git.refExists({ repoPath: bareRepoPath, ref: 'refs/heads/trunk' })).toBe(true)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'merged + dirty ⇒ archived with dirt intact',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { storePath, bareRepoPaths, worktreePaths } = yield* createStoreFixture([
          {
            ...REPO,
            branches: ['feature/dirty'],
            dirtyWorktrees: ['feature/dirty'],
            withRemote: true,
          },
        ])
        const bareRepoPath = bareRepoPaths[REPO_KEY]!
        const worktreePath = worktreePaths[`${REPO_KEY}#feature/dirty`]!
        const commit = yield* getWorktreeCommit(worktreePath)
        yield* materializeBranchRef({ bareRepoPath, branch: 'feature/dirty', commit })

        const cwd = yield* outsideCwd()
        yield* seedColdObservation({ cwd, storePath })
        const { results } = yield* runGc({
          cwd,
          storePath,
          prRepos: [
            { relativePath: REPO_RELATIVE, prs: [mergedPr('feature/dirty', NOW - 30 * DAY_MS)] },
          ],
        })

        const result = findByRef(results, 'feature/dirty')
        expect(result?.status).toBe('archived')
        // The dirt traveled with the move.
        const dest = EffectPath.unsafe.absoluteDir(`${result!.recoverPath!.replace(/\/+$/, '')}/`)
        expect(
          yield* fs.readFileString(
            EffectPath.ops.join(dest, EffectPath.unsafe.relativeFile('dirty.txt')),
          ),
        ).toBe('uncommitted changes\n')
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'merged + unpushed ⇒ kept (B1: unrecoverable local history)',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { storePath, bareRepoPaths, worktreePaths } = yield* createStoreFixture([
          { ...REPO, branches: ['feature/unpushed'], withRemote: true },
        ])
        const bareRepoPath = bareRepoPaths[REPO_KEY]!
        const worktreePath = worktreePaths[`${REPO_KEY}#feature/unpushed`]!

        // Create a local commit on the worktree that is on NO remote.
        yield* fs.writeFileString(
          EffectPath.ops.join(worktreePath, EffectPath.unsafe.relativeFile('local.txt')),
          'local-only\n',
        )
        yield* git(worktreePath, 'add', '-A')
        yield* git(worktreePath, 'commit', '--no-gpg-sign', '--no-verify', '-m', 'local only')
        const commit = yield* getWorktreeCommit(worktreePath)
        yield* materializeBranchRef({ bareRepoPath, branch: 'feature/unpushed', commit })

        const cwd = yield* outsideCwd()
        const { results } = yield* runGc({
          cwd,
          storePath,
          prRepos: [
            { relativePath: REPO_RELATIVE, prs: [mergedPr('feature/unpushed', NOW - 30 * DAY_MS)] },
          ],
        })

        const result = findByRef(results, 'feature/unpushed')
        expect(result?.status).toBe('kept')
        expect(result?.reason).toBe('unrecoverable-local-work')
        expect(yield* fs.exists(worktreePath)).toBe(true)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'merged + stash ⇒ kept (B3: stash does not travel with a dir move)',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { storePath, bareRepoPaths, worktreePaths } = yield* createStoreFixture([
          { ...REPO, branches: ['feature/stash'], withRemote: true },
        ])
        const bareRepoPath = bareRepoPaths[REPO_KEY]!
        const worktreePath = worktreePaths[`${REPO_KEY}#feature/stash`]!
        const commit = yield* getWorktreeCommit(worktreePath)
        yield* materializeBranchRef({ bareRepoPath, branch: 'feature/stash', commit })
        // Put a real stash (modify a tracked file then stash).
        yield* git(worktreePath, 'checkout', 'feature/stash')
        yield* fs.writeFileString(
          EffectPath.ops.join(worktreePath, EffectPath.unsafe.relativeFile('README.md')),
          '# modified for stash\n',
        )
        yield* git(worktreePath, 'stash')

        const cwd = yield* outsideCwd()
        const { results } = yield* runGc({
          cwd,
          storePath,
          prRepos: [
            { relativePath: REPO_RELATIVE, prs: [mergedPr('feature/stash', NOW - 30 * DAY_MS)] },
          ],
        })

        const result = findByRef(results, 'feature/stash')
        expect(result?.status).toBe('kept')
        expect(result?.reason).toBe('unrecoverable-local-work')
        expect(yield* fs.exists(worktreePath)).toBe(true)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'open PR ⇒ kept (not-stale)',
    Effect.fnUntraced(
      function* () {
        const { storePath, bareRepoPaths, worktreePaths } = yield* createStoreFixture([
          { ...REPO, branches: ['feature/open'], withRemote: true },
        ])
        const bareRepoPath = bareRepoPaths[REPO_KEY]!
        const worktreePath = worktreePaths[`${REPO_KEY}#feature/open`]!
        const commit = yield* getWorktreeCommit(worktreePath)
        yield* materializeBranchRef({ bareRepoPath, branch: 'feature/open', commit })

        const cwd = yield* outsideCwd()
        const { results } = yield* runGc({
          cwd,
          storePath,
          prRepos: [{ relativePath: REPO_RELATIVE, prs: [openPr('feature/open')] }],
        })

        const result = findByRef(results, 'feature/open')
        expect(result?.status).toBe('kept')
        expect(result?.reason).toBe('not-stale')
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'squash-merged + remote branch deleted (no PR evidence) ⇒ kept',
    Effect.fnUntraced(
      function* () {
        const { storePath, bareRepoPaths, worktreePaths } = yield* createStoreFixture([
          { ...REPO, branches: ['feature/squash'], withRemote: true },
        ])
        const bareRepoPath = bareRepoPaths[REPO_KEY]!
        const worktreePath = worktreePaths[`${REPO_KEY}#feature/squash`]!
        const commit = yield* getWorktreeCommit(worktreePath)
        yield* materializeBranchRef({ bareRepoPath, branch: 'feature/squash', commit })

        const cwd = yield* outsideCwd()
        // No PR rows for this branch ⇒ resolver returns `none` ⇒ keep (not-stale).
        const { results } = yield* runGc({
          cwd,
          storePath,
          prRepos: [{ relativePath: REPO_RELATIVE, prs: [] }],
        })

        const result = findByRef(results, 'feature/squash')
        expect(result?.status).toBe('kept')
        expect(result?.reason).toBe('not-stale')
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'merged but within post-merge grace ⇒ kept (grace)',
    Effect.fnUntraced(
      function* () {
        const { storePath, bareRepoPaths, worktreePaths } = yield* createStoreFixture([
          { ...REPO, branches: ['feature/grace'], withRemote: true },
        ])
        const bareRepoPath = bareRepoPaths[REPO_KEY]!
        const worktreePath = worktreePaths[`${REPO_KEY}#feature/grace`]!
        const commit = yield* getWorktreeCommit(worktreePath)
        yield* materializeBranchRef({ bareRepoPath, branch: 'feature/grace', commit })

        const cwd = yield* outsideCwd()
        // Pre-seed the observation ledger (absence grace already elapsed) by running
        // gc once at an earlier time, then run again within the post-merge window.
        yield* runGc({
          cwd,
          storePath,
          prRepos: [{ relativePath: REPO_RELATIVE, prs: [] }],
          now: NOW - 20 * DAY_MS,
        })
        // Merged 1 day ago (< 7d post-merge grace) at the real NOW.
        const { results } = yield* runGc({
          cwd,
          storePath,
          prRepos: [
            { relativePath: REPO_RELATIVE, prs: [mergedPr('feature/grace', NOW - 1 * DAY_MS)] },
          ],
        })

        const result = findByRef(results, 'feature/grace')
        expect(result?.status).toBe('kept')
        expect(result?.reason).toBe('post-merge-grace')
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'absence grace unmet (first observation this run) ⇒ kept',
    Effect.fnUntraced(
      function* () {
        const { storePath, bareRepoPaths, worktreePaths } = yield* createStoreFixture([
          { ...REPO, branches: ['feature/fresh'], withRemote: true },
        ])
        const bareRepoPath = bareRepoPaths[REPO_KEY]!
        const worktreePath = worktreePaths[`${REPO_KEY}#feature/fresh`]!
        const commit = yield* getWorktreeCommit(worktreePath)
        yield* materializeBranchRef({ bareRepoPath, branch: 'feature/fresh', commit })

        const cwd = yield* outsideCwd()
        // First-ever observation: coldSince === now ⇒ absence grace not yet elapsed.
        const { results } = yield* runGc({
          cwd,
          storePath,
          prRepos: [
            { relativePath: REPO_RELATIVE, prs: [mergedPr('feature/fresh', NOW - 30 * DAY_MS)] },
          ],
        })

        const result = findByRef(results, 'feature/fresh')
        expect(result?.status).toBe('kept')
        expect(result?.reason).toBe('absence-grace')
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'registered by another workspace ⇒ kept (live); unregistered+merged ⇒ archived',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { storePath, bareRepoPaths, worktreePaths } = yield* createStoreFixture([
          { ...REPO, branches: ['feature/live', 'feature/dead'], withRemote: true },
        ])
        const bareRepoPath = bareRepoPaths[REPO_KEY]!
        const livePath = worktreePaths[`${REPO_KEY}#feature/live`]!
        const deadPath = worktreePaths[`${REPO_KEY}#feature/dead`]!
        const liveCommit = yield* getWorktreeCommit(livePath)
        const deadCommit = yield* getWorktreeCommit(deadPath)
        yield* materializeBranchRef({ bareRepoPath, branch: 'feature/live', commit: liveCommit })
        yield* materializeBranchRef({ bareRepoPath, branch: 'feature/dead', commit: deadCommit })

        // Observe both branches cold in the past so absence grace is satisfied.
        yield* seedColdObservation({ cwd: yield* outsideCwd(), storePath })

        // Register a workspace that consumes feature/live via a repos/ symlink.
        const { workspacePath } = yield* createWorkspaceWithLock({
          members: { widget: 'acme/widget#feature/live' },
        })
        yield* fs.makeDirectory(
          EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeDir('repos/')),
          { recursive: true },
        )
        yield* fs.symlink(
          livePath.replace(/\/+$/, ''),
          EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeFile('repos/widget')),
        )
        const store = yield* Effect.provide(Store, makeStoreLayer({ basePath: storePath }))
        yield* refreshWorkspaceRegistry({ workspaceRoot: workspacePath, store, now: NOW })

        const cwd = yield* outsideCwd()
        const { results } = yield* runGc({
          cwd,
          storePath,
          prRepos: [
            {
              relativePath: REPO_RELATIVE,
              prs: [
                mergedPr('feature/live', NOW - 30 * DAY_MS),
                mergedPr('feature/dead', NOW - 30 * DAY_MS),
              ],
            },
          ],
        })

        expect(findByRef(results, 'feature/live')?.status).toBe('kept')
        expect(findByRef(results, 'feature/live')?.reason).toBe('live')
        expect(findByRef(results, 'feature/dead')?.status).toBe('archived')
        expect(yield* fs.exists(livePath)).toBe(true)
        expect(yield* fs.exists(deadPath)).toBe(false)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'repin-without-reregister ⇒ reconcile-all keeps the new target (B2 / 0010)',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { storePath, bareRepoPaths, worktreePaths } = yield* createStoreFixture([
          { ...REPO, branches: ['feature/old', 'feature/new'], withRemote: true },
        ])
        const bareRepoPath = bareRepoPaths[REPO_KEY]!
        const oldPath = worktreePaths[`${REPO_KEY}#feature/old`]!
        const newPath = worktreePaths[`${REPO_KEY}#feature/new`]!
        const oldCommit = yield* getWorktreeCommit(oldPath)
        const newCommit = yield* getWorktreeCommit(newPath)
        yield* materializeBranchRef({ bareRepoPath, branch: 'feature/old', commit: oldCommit })
        yield* materializeBranchRef({ bareRepoPath, branch: 'feature/new', commit: newCommit })

        // Register a workspace pointing at feature/old, then repin to feature/new
        // WITHOUT re-registering (stale liveness record still names old).
        const { workspacePath } = yield* createWorkspaceWithLock({
          members: { widget: 'acme/widget#feature/old' },
        })
        yield* fs.makeDirectory(
          EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeDir('repos/')),
          { recursive: true },
        )
        yield* fs.symlink(
          oldPath.replace(/\/+$/, ''),
          EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeFile('repos/widget')),
        )
        const store = yield* Effect.provide(Store, makeStoreLayer({ basePath: storePath }))
        yield* refreshWorkspaceRegistry({ workspaceRoot: workspacePath, store, now: NOW })
        yield* repinWorkspace({ workspacePath, memberName: 'widget', newTarget: newPath })

        const cwd = yield* outsideCwd()
        const { results } = yield* runGc({
          cwd,
          storePath,
          prRepos: [
            {
              relativePath: REPO_RELATIVE,
              prs: [
                mergedPr('feature/old', NOW - 30 * DAY_MS),
                mergedPr('feature/new', NOW - 30 * DAY_MS),
              ],
            },
          ],
        })

        // reconcile-all re-derives feature/new from the repinned symlink ⇒ kept.
        expect(findByRef(results, 'feature/new')?.status).toBe('kept')
        expect(findByRef(results, 'feature/new')?.reason).toBe('live')
        expect(yield* fs.exists(newPath)).toBe(true)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'present-but-unreadable workspace ⇒ its live worktree kept (fail safe, B2)',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { storePath, bareRepoPaths, worktreePaths } = yield* createStoreFixture([
          { ...REPO, branches: ['feature/protected'], withRemote: true },
        ])
        const bareRepoPath = bareRepoPaths[REPO_KEY]!
        const protectedPath = worktreePaths[`${REPO_KEY}#feature/protected`]!
        const commit = yield* getWorktreeCommit(protectedPath)
        yield* materializeBranchRef({ bareRepoPath, branch: 'feature/protected', commit })

        const { workspacePath } = yield* createWorkspaceWithLock({
          members: { widget: 'acme/widget#feature/protected' },
        })
        yield* fs.makeDirectory(
          EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeDir('repos/')),
          { recursive: true },
        )
        yield* fs.symlink(
          protectedPath.replace(/\/+$/, ''),
          EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeFile('repos/widget')),
        )
        const store = yield* Effect.provide(Store, makeStoreLayer({ basePath: storePath }))
        yield* refreshWorkspaceRegistry({ workspaceRoot: workspacePath, store, now: NOW })

        // Make the workspace's members dir unreadable so a strict reconcile errors;
        // the last-known live path must be preserved (never overwritten with empty).
        const reposDir = EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeDir('repos/'))
        yield* fs.chmod(reposDir, 0o000)

        const cwd = yield* outsideCwd()
        const { results } = yield* runGc({
          cwd,
          storePath,
          prRepos: [
            {
              relativePath: REPO_RELATIVE,
              prs: [mergedPr('feature/protected', NOW - 30 * DAY_MS)],
            },
          ],
        }).pipe(Effect.ensuring(fs.chmod(reposDir, 0o755).pipe(Effect.ignore)))

        const result = findByRef(results, 'feature/protected')
        expect(result?.status).toBe('kept')
        // live (last-known path retained) — NOT archived.
        expect(yield* fs.exists(protectedPath)).toBe(true)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'ref_mismatch within absence grace ⇒ kept',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { storePath, bareRepoPaths, worktreePaths } = yield* createStoreFixture([
          { ...REPO, branches: ['feature/claimed'], withRemote: true },
        ])
        const bareRepoPath = bareRepoPaths[REPO_KEY]!
        const worktreePath = worktreePaths[`${REPO_KEY}#feature/claimed`]!
        const commit = yield* getWorktreeCommit(worktreePath)
        // Check out a DIFFERENT branch in the worktree than the path claims.
        yield* git(bareRepoPath, 'branch', 'feature/other', commit)
        yield* git(worktreePath, 'checkout', 'feature/other')

        const cwd = yield* outsideCwd()
        const { results } = yield* runGc({
          cwd,
          storePath,
          prRepos: [
            {
              relativePath: REPO_RELATIVE,
              prs: [mergedPr('feature/claimed', NOW - 30 * DAY_MS)],
            },
          ],
        })

        const result = findByRef(results, 'feature/claimed')
        expect(result?.status).toBe('kept')
        expect(result?.reason).toBe('ref_mismatch')
        expect(result?.pathRef).toBe('feature/claimed')
        expect(result?.actualHeadBranch).toBe('feature/other')
        expect(yield* fs.exists(worktreePath)).toBe(true)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'clean ref_mismatch + grace-met ⇒ archived without deleting either branch ref',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { storePath, bareRepoPaths, worktreePaths } = yield* createStoreFixture([
          { ...REPO, branches: ['feature/claimed'], withRemote: true },
        ])
        const bareRepoPath = bareRepoPaths[REPO_KEY]!
        const worktreePath = worktreePaths[`${REPO_KEY}#feature/claimed`]!
        const commit = yield* getWorktreeCommit(worktreePath)

        yield* materializeBranchRef({ bareRepoPath, branch: 'feature/claimed', commit })
        yield* git(bareRepoPath, 'branch', 'feature/other', commit)
        yield* git(worktreePath, 'checkout', 'feature/other')

        const cwd = yield* outsideCwd()
        yield* seedColdObservation({ cwd, storePath })
        const { results } = yield* runGc({
          cwd,
          storePath,
          prRepos: [{ relativePath: REPO_RELATIVE, prs: [] }],
        })

        const result = findByRef(results, 'feature/claimed')
        expect(result?.status).toBe('archived')
        expect(result?.reason).toBe('ref_mismatch_clean')
        expect(result?.pathRef).toBe('feature/claimed')
        expect(result?.actualHeadBranch).toBe('feature/other')
        expect(result?.recoverPath).toContain('/.archive/feature/claimed--')
        expect(yield* fs.exists(worktreePath)).toBe(false)

        const archivePath = EffectPath.unsafe.absoluteDir(
          `${result!.recoverPath!.replace(/\/+$/, '')}/`,
        )
        expect(yield* fs.exists(archivePath)).toBe(true)
        expect(yield* git(archivePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD')
        expect(yield* git(bareRepoPath, 'rev-parse', 'refs/heads/feature/claimed')).toBe(commit)
        expect(yield* git(bareRepoPath, 'rev-parse', 'refs/heads/feature/other')).toBe(commit)

        const repoRoot = EffectPath.ops.join(
          storePath,
          EffectPath.unsafe.relativeDir(REPO_RELATIVE),
        )
        const readme = yield* fs.readFileString(
          EffectPath.ops.join(
            EffectPath.ops.join(repoRoot, EffectPath.unsafe.relativeDir('.archive/')),
            EffectPath.unsafe.relativeFile('README.md'),
          ),
        )
        expect(readme).toContain('feature/claimed')
        expect(readme).toContain('ref_mismatch_clean')
        expect(readme).toContain('actualHeadBranch=feature/other')
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'dry-run clean ref_mismatch + grace-met ⇒ reports archive intent without moving',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { storePath, bareRepoPaths, worktreePaths } = yield* createStoreFixture([
          { ...REPO, branches: ['feature/claimed'], withRemote: true },
        ])
        const bareRepoPath = bareRepoPaths[REPO_KEY]!
        const worktreePath = worktreePaths[`${REPO_KEY}#feature/claimed`]!
        const commit = yield* getWorktreeCommit(worktreePath)

        yield* materializeBranchRef({ bareRepoPath, branch: 'feature/claimed', commit })
        yield* git(bareRepoPath, 'branch', 'feature/other', commit)
        yield* git(worktreePath, 'checkout', 'feature/other')

        const cwd = yield* outsideCwd()
        yield* seedColdObservation({ cwd, storePath })
        const { results } = yield* runGc({
          cwd,
          storePath,
          prRepos: [{ relativePath: REPO_RELATIVE, prs: [] }],
          args: ['--dry-run'],
        })

        const result = findByRef(results, 'feature/claimed')
        expect(result?.status).toBe('archived')
        expect(result?.reason).toBe('ref_mismatch_clean')
        expect(result?.pathRef).toBe('feature/claimed')
        expect(result?.actualHeadBranch).toBe('feature/other')
        expect(result?.recoverPath).toBeUndefined()
        expect(yield* fs.exists(worktreePath)).toBe(true)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'fetch failure (no remote configured) ⇒ all named worktrees kept',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        // No `withRemote`: the bare has no `origin`, so `fetch --prune origin` fails.
        const { storePath, bareRepoPaths, worktreePaths } = yield* createStoreFixture([
          { ...REPO, branches: ['feature/no-remote'] },
        ])
        const bareRepoPath = bareRepoPaths[REPO_KEY]!
        const worktreePath = worktreePaths[`${REPO_KEY}#feature/no-remote`]!
        const commit = yield* getWorktreeCommit(worktreePath)
        yield* materializeBranchRef({ bareRepoPath, branch: 'feature/no-remote', commit })

        const cwd = yield* outsideCwd()
        const { results } = yield* runGc({
          cwd,
          storePath,
          prRepos: [
            {
              relativePath: REPO_RELATIVE,
              prs: [mergedPr('feature/no-remote', NOW - 30 * DAY_MS)],
            },
          ],
        })

        const result = findByRef(results, 'feature/no-remote')
        expect(result?.status).toBe('kept')
        expect(result?.reason).toBe('fetch-failed')
        expect(yield* fs.exists(worktreePath)).toBe(true)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    '--dry-run does NOT fetch/prune the bare (refs/remotes left intact); live run does',
    Effect.fnUntraced(
      function* () {
        const { storePath, bareRepoPaths, upstreamRepoPaths, worktreePaths } =
          yield* createStoreFixture([
            { ...REPO, branches: ['feature/pruneable'], withRemote: true },
          ])
        const bareRepoPath = bareRepoPaths[REPO_KEY]!
        const upstreamPath = upstreamRepoPaths[REPO_KEY]!
        const commit = yield* getWorktreeCommit(worktreePaths[`${REPO_KEY}#feature/pruneable`]!)
        yield* materializeBranchRef({ bareRepoPath, branch: 'feature/pruneable', commit })

        // Precondition: the store bare tracks the branch on the remote.
        expect(
          yield* Git.refExists({
            repoPath: bareRepoPath,
            ref: 'refs/remotes/origin/feature/pruneable',
          }),
        ).toBe(true)

        // Delete the branch on the UPSTREAM, so the next `fetch --prune` in the
        // store bare would remove `refs/remotes/origin/feature/pruneable`. This is
        // the discriminator: only a real fetch mutates the bare.
        yield* git(upstreamPath, 'branch', '-D', 'feature/pruneable')

        const cwd = yield* outsideCwd()

        // Dry-run must SKIP the fetch — the (now-stale) remote-tracking ref survives.
        yield* runGc({
          cwd,
          storePath,
          prRepos: [{ relativePath: REPO_RELATIVE, prs: [] }],
          args: ['--dry-run'],
        })
        expect(
          yield* Git.refExists({
            repoPath: bareRepoPath,
            ref: 'refs/remotes/origin/feature/pruneable',
          }),
        ).toBe(true)

        // The paired live run DOES fetch --prune, proving the assertion above
        // discriminates rather than passing vacuously: the ref is now gone.
        yield* runGc({
          cwd,
          storePath,
          prRepos: [{ relativePath: REPO_RELATIVE, prs: [] }],
        })
        expect(
          yield* Git.refExists({
            repoPath: bareRepoPath,
            ref: 'refs/remotes/origin/feature/pruneable',
          }),
        ).toBe(false)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'archive past retention ⇒ reaped; within retention ⇒ kept',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { storePath, bareRepoPaths, worktreePaths } = yield* createStoreFixture([
          { ...REPO, branches: ['live/keep'], withRemote: true },
        ])
        const bareRepoPath = bareRepoPaths[REPO_KEY]!
        const repoRoot = EffectPath.ops.join(
          storePath,
          EffectPath.unsafe.relativeDir(`${REPO_KEY}/`),
        )
        const commit = yield* getWorktreeCommit(worktreePaths[`${REPO_KEY}#live/keep`]!)

        // One archived 40d ago (> 30d retention) and one 5d ago (within).
        const { archivePath: stalePath } = yield* createArchiveEntry({
          bareRepoPath,
          repoRoot,
          branch: 'feature/stale',
          commit,
          archivedAt: new Date(NOW - 40 * DAY_MS),
        })
        const { archivePath: freshPath } = yield* createArchiveEntry({
          bareRepoPath,
          repoRoot,
          branch: 'feature/fresh-archive',
          commit,
          archivedAt: new Date(NOW - 5 * DAY_MS),
        })

        const cwd = yield* outsideCwd()
        const { results } = yield* runGc({
          cwd,
          storePath,
          prRepos: [{ relativePath: REPO_RELATIVE, prs: [] }],
        })

        const reaped = results.find((r) => r.status === 'reaped')
        expect(reaped?.ref).toBe('feature/stale')
        expect(yield* fs.exists(stalePath)).toBe(false)
        // The within-retention archive is untouched and not reported as reaped.
        expect(yield* fs.exists(freshPath)).toBe(true)
        expect(
          results.some((r) => r.status === 'reaped' && r.ref === 'feature/fresh-archive'),
        ).toBe(false)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'veto re-check at reap: an archive that became live ⇒ kept, not reaped',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { storePath, bareRepoPaths, worktreePaths } = yield* createStoreFixture([
          { ...REPO, branches: ['live/keep'], withRemote: true },
        ])
        const bareRepoPath = bareRepoPaths[REPO_KEY]!
        const repoRoot = EffectPath.ops.join(
          storePath,
          EffectPath.unsafe.relativeDir(`${REPO_KEY}/`),
        )
        const commit = yield* getWorktreeCommit(worktreePaths[`${REPO_KEY}#live/keep`]!)

        const { archivePath } = yield* createArchiveEntry({
          bareRepoPath,
          repoRoot,
          branch: 'feature/contested',
          commit,
          archivedAt: new Date(NOW - 40 * DAY_MS),
        })

        // Register a workspace whose symlink points AT the archived path, so the
        // under-lock veto re-check finds it live and refuses to reap (invariant 1).
        const { workspacePath } = yield* createWorkspaceWithLock({
          members: { widget: 'acme/widget#feature/contested' },
        })
        yield* fs.makeDirectory(
          EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeDir('repos/')),
          { recursive: true },
        )
        yield* fs.symlink(
          archivePath.replace(/\/+$/, ''),
          EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeFile('repos/widget')),
        )
        const store = yield* Effect.provide(Store, makeStoreLayer({ basePath: storePath }))
        yield* refreshWorkspaceRegistry({ workspaceRoot: workspacePath, store, now: NOW })

        const cwd = yield* outsideCwd()
        const { results } = yield* runGc({
          cwd,
          storePath,
          prRepos: [{ relativePath: REPO_RELATIVE, prs: [] }],
        })

        const result = findByRef(results, 'feature/contested')
        expect(result?.status).toBe('kept')
        expect(result?.reason).toBe('live')
        expect(yield* fs.exists(archivePath)).toBe(true)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'veto re-check at archive: a merged+clean+grace-met worktree that is live ⇒ kept, not archived',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { storePath, bareRepoPaths, worktreePaths } = yield* createStoreFixture([
          { ...REPO, branches: ['feature/contested-archive'], withRemote: true },
        ])
        const bareRepoPath = bareRepoPaths[REPO_KEY]!
        const worktreePath = worktreePaths[`${REPO_KEY}#feature/contested-archive`]!
        const commit = yield* getWorktreeCommit(worktreePath)
        yield* materializeBranchRef({
          bareRepoPath,
          branch: 'feature/contested-archive',
          commit,
        })

        // Make the worktree archive-eligible: cold long enough that absence grace
        // is satisfied, with a long-merged PR (past post-merge grace).
        yield* seedColdObservation({ cwd: yield* outsideCwd(), storePath })

        // Register a workspace whose symlink points AT the would-be-archived
        // worktree. The fresh under-lock reconcile (invariant 1) must find it live
        // and refuse to archive — mirrors the reap-veto test for the archive path.
        const { workspacePath } = yield* createWorkspaceWithLock({
          members: { widget: 'acme/widget#feature/contested-archive' },
        })
        yield* fs.makeDirectory(
          EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeDir('repos/')),
          { recursive: true },
        )
        yield* fs.symlink(
          worktreePath.replace(/\/+$/, ''),
          EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeFile('repos/widget')),
        )
        const store = yield* Effect.provide(Store, makeStoreLayer({ basePath: storePath }))
        yield* refreshWorkspaceRegistry({ workspaceRoot: workspacePath, store, now: NOW })

        const cwd = yield* outsideCwd()
        const { results } = yield* runGc({
          cwd,
          storePath,
          prRepos: [
            {
              relativePath: REPO_RELATIVE,
              prs: [mergedPr('feature/contested-archive', NOW - 30 * DAY_MS)],
            },
          ],
        })

        const result = findByRef(results, 'feature/contested-archive')
        expect(result?.status).toBe('kept')
        expect(result?.reason).toBe('live')
        // The worktree and its branch are untouched.
        expect(yield* fs.exists(worktreePath)).toBe(true)
        expect(
          yield* Git.refExists({
            repoPath: bareRepoPath,
            ref: 'refs/heads/feature/contested-archive',
          }),
        ).toBe(true)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'closed (unmerged) PR + clean + reachable + grace-met ⇒ archived, reason closed (no post-close grace)',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { storePath, bareRepoPaths, worktreePaths } = yield* createStoreFixture([
          { ...REPO, branches: ['feature/closed'], withRemote: true },
        ])
        const bareRepoPath = bareRepoPaths[REPO_KEY]!
        const worktreePath = worktreePaths[`${REPO_KEY}#feature/closed`]!
        const commit = yield* getWorktreeCommit(worktreePath)
        yield* materializeBranchRef({ bareRepoPath, branch: 'feature/closed', commit })

        const cwd = yield* outsideCwd()
        yield* seedColdObservation({ cwd, storePath })
        // Closed only ONE day ago: decision 0009 has NO post-close grace, so a
        // recently-closed PR still archives once absence grace is met.
        const { results } = yield* runGc({
          cwd,
          storePath,
          prRepos: [
            { relativePath: REPO_RELATIVE, prs: [closedPr('feature/closed', NOW - 1 * DAY_MS)] },
          ],
        })

        const result = findByRef(results, 'feature/closed')
        expect(result?.status).toBe('archived')
        expect(result?.reason).toBe('closed')
        expect(yield* fs.exists(worktreePath)).toBe(false)
        expect(
          yield* Git.refExists({ repoPath: bareRepoPath, ref: 'refs/heads/feature/closed' }),
        ).toBe(false)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'dry-run ⇒ reports archive/reap intent without mutating disk',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { storePath, bareRepoPaths, worktreePaths } = yield* createStoreFixture([
          { ...REPO, branches: ['feature/merged'], withRemote: true },
        ])
        const bareRepoPath = bareRepoPaths[REPO_KEY]!
        const worktreePath = worktreePaths[`${REPO_KEY}#feature/merged`]!
        const commit = yield* getWorktreeCommit(worktreePath)
        yield* materializeBranchRef({ bareRepoPath, branch: 'feature/merged', commit })
        // Seed an old observation so absence grace is satisfied on the dry run.
        yield* runGc({
          cwd: yield* outsideCwd(),
          storePath,
          prRepos: [{ relativePath: REPO_RELATIVE, prs: [] }],
          now: NOW - 20 * DAY_MS,
        })

        const cwd = yield* outsideCwd()
        const { results } = yield* runGc({
          cwd,
          storePath,
          prRepos: [
            { relativePath: REPO_RELATIVE, prs: [mergedPr('feature/merged', NOW - 30 * DAY_MS)] },
          ],
          args: ['--dry-run'],
        })

        expect(findByRef(results, 'feature/merged')?.status).toBe('archived')
        // Dry run leaves the worktree and branch intact.
        expect(yield* fs.exists(worktreePath)).toBe(true)
        expect(
          yield* Git.refExists({ repoPath: bareRepoPath, ref: 'refs/heads/feature/merged' }),
        ).toBe(true)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'dry-run ⇒ reports reap intent for a past-retention archive WITHOUT removing it',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { storePath, bareRepoPaths, worktreePaths } = yield* createStoreFixture([
          { ...REPO, branches: ['live/keep'], withRemote: true },
        ])
        const bareRepoPath = bareRepoPaths[REPO_KEY]!
        const repoRoot = EffectPath.ops.join(
          storePath,
          EffectPath.unsafe.relativeDir(`${REPO_KEY}/`),
        )
        const commit = yield* getWorktreeCommit(worktreePaths[`${REPO_KEY}#live/keep`]!)

        // Past-retention archive (40d > 30d): reap-eligible.
        const { archivePath } = yield* createArchiveEntry({
          bareRepoPath,
          repoRoot,
          branch: 'feature/stale-dry',
          commit,
          archivedAt: new Date(NOW - 40 * DAY_MS),
        })

        const cwd = yield* outsideCwd()
        const { results } = yield* runGc({
          cwd,
          storePath,
          prRepos: [{ relativePath: REPO_RELATIVE, prs: [] }],
          args: ['--dry-run'],
        })

        // Reap intent reported but the archive dir is left on disk.
        expect(results.some((r) => r.status === 'reaped' && r.ref === 'feature/stale-dry')).toBe(
          true,
        )
        expect(yield* fs.exists(archivePath)).toBe(true)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'unclean reconcile withholds absence grace: a later clean run restarts the clock (kept absence-grace)',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { storePath, bareRepoPaths, worktreePaths } = yield* createStoreFixture([
          { ...REPO, branches: ['feature/unclean'], withRemote: true },
        ])
        const bareRepoPath = bareRepoPaths[REPO_KEY]!
        const worktreePath = worktreePaths[`${REPO_KEY}#feature/unclean`]!
        const commit = yield* getWorktreeCommit(worktreePath)
        yield* materializeBranchRef({ bareRepoPath, branch: 'feature/unclean', commit })

        // A workspace that DOES NOT consume this worktree (its symlink points
        // elsewhere) but whose strict reconcile fails this run — flagging a path
        // unclean so absence grace must NOT advance for it (decision 0010 / B2).
        const { workspacePath } = yield* createWorkspaceWithLock({
          members: { other: 'acme/widget#feature/other' },
        })
        const reposDir = EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeDir('repos/'))
        yield* fs.makeDirectory(reposDir, { recursive: true })
        yield* fs.symlink(
          worktreePath.replace(/\/+$/, ''),
          EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeFile('repos/other')),
        )
        const store = yield* Effect.provide(Store, makeStoreLayer({ basePath: storePath }))
        yield* refreshWorkspaceRegistry({ workspaceRoot: workspacePath, store, now: NOW })

        // First run, 20d in the past, but with the workspace UNREADABLE so the
        // reconcile is unclean: its live path stays protected, but absence grace
        // is withheld (firstSeenColdAtMs is NOT recorded for the protected path).
        yield* fs.chmod(reposDir, 0o000)
        const firstRun = yield* runGc({
          cwd: yield* outsideCwd(),
          storePath,
          prRepos: [{ relativePath: REPO_RELATIVE, prs: [] }],
          now: NOW - 20 * DAY_MS,
        }).pipe(Effect.ensuring(fs.chmod(reposDir, 0o755).pipe(Effect.ignore)))
        // While unclean it is protected as live, never advanced toward archive.
        expect(findByRef(firstRun.results, 'feature/unclean')?.status).toBe('kept')

        // Second run now CLEAN: the worktree is no longer live (symlink readable
        // again, points at it — so still live). Make it NOT live by repointing the
        // symlink away, so this run is its FIRST clean cold observation ⇒ absence
        // grace clock starts here, not 20d ago.
        yield* fs.remove(
          EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeFile('repos/other')),
          { force: true },
        )
        const cwd = yield* outsideCwd()
        const { results } = yield* runGc({
          cwd,
          storePath,
          prRepos: [
            { relativePath: REPO_RELATIVE, prs: [mergedPr('feature/unclean', NOW - 30 * DAY_MS)] },
          ],
        })

        const result = findByRef(results, 'feature/unclean')
        expect(result?.status).toBe('kept')
        // Grace restarted: kept on absence-grace, NOT archived.
        expect(result?.reason).toBe('absence-grace')
        expect(yield* fs.exists(worktreePath)).toBe(true)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    '--all is unchanged: removes named worktrees (no cold path)',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { storePath, bareRepoPaths, worktreePaths } = yield* createStoreFixture([
          { ...REPO, branches: ['feature/x'], withRemote: true },
        ])
        const bareRepoPath = bareRepoPaths[REPO_KEY]!
        const worktreePath = worktreePaths[`${REPO_KEY}#feature/x`]!
        const commit = yield* getWorktreeCommit(worktreePath)
        yield* materializeBranchRef({ bareRepoPath, branch: 'feature/x', commit })

        const cwd = yield* outsideCwd()
        const { results } = yield* runGc({
          cwd,
          storePath,
          // No PR rows — under --all this is irrelevant (everything is removed).
          prRepos: [{ relativePath: REPO_RELATIVE, prs: [] }],
          args: ['--all'],
        })

        const result = findByRef(results, 'feature/x')
        expect(result?.status).toBe('removed')
        // Not archived/kept — the legacy --all path owns it.
        expect(result?.reason).toBeUndefined()
        expect(yield* fs.exists(worktreePath)).toBe(false)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'dry-run does NOT persist the observation ledger (no absence-grace advance)',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { storePath, bareRepoPaths, worktreePaths } = yield* createStoreFixture([
          { ...REPO, branches: ['feature/cold'], withRemote: true },
        ])
        const bareRepoPath = bareRepoPaths[REPO_KEY]!
        const commit = yield* getWorktreeCommit(worktreePaths[`${REPO_KEY}#feature/cold`]!)
        yield* materializeBranchRef({ bareRepoPath, branch: 'feature/cold', commit })

        const ledgerPath = EffectPath.ops.join(
          storePath,
          EffectPath.unsafe.relativeFile('.state/gc-observations.json'),
        )
        const cwd = yield* outsideCwd()
        yield* runGc({
          cwd,
          storePath,
          prRepos: [
            { relativePath: REPO_RELATIVE, prs: [mergedPr('feature/cold', NOW - 30 * DAY_MS)] },
          ],
          args: ['--dry-run'],
        })

        // A planning run must not write the ledger, or a later real run could
        // archive based on a clock the dry-run started.
        expect(yield* fs.exists(ledgerPath)).toBe(false)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'repo with NO current named refs still reaps a past-retention archive',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { storePath, bareRepoPaths } = yield* createStoreFixture([
          { ...REPO, branches: [], withRemote: true },
        ])
        const bareRepoPath = bareRepoPaths[REPO_KEY]!
        const repoRoot = EffectPath.ops.join(
          storePath,
          EffectPath.unsafe.relativeDir(`${REPO_KEY}/`),
        )
        // No local refs/heads with `branches: []`; the remote-tracking ref exists.
        const commit = yield* git(bareRepoPath, 'rev-parse', 'origin/main')

        // All branches already archived (no live refs/heads worktrees), one
        // archive past the 30d retention.
        const { archivePath } = yield* createArchiveEntry({
          bareRepoPath,
          repoRoot,
          branch: 'feature/all-archived',
          commit,
          archivedAt: new Date(NOW - 40 * DAY_MS),
        })

        const cwd = yield* outsideCwd()
        const { results } = yield* runGc({
          cwd,
          storePath,
          prRepos: [{ relativePath: REPO_RELATIVE, prs: [] }],
        })

        const reaped = results.find((r) => r.ref === 'feature/all-archived')
        expect(reaped?.status).toBe('reaped')
        expect(yield* fs.exists(archivePath)).toBe(false)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )
})
