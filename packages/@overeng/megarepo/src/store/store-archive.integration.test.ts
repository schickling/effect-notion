/**
 * Integration tests for archive + reap (U6, decision 0001).
 *
 * Exercises REAL git against store-shaped fixtures (`createStoreFixture`):
 * - archiveWorktree moves the worktree under `.archive/` preserving dirty +
 *   untracked work, FREES the `refs/heads/<branch>` ref (so an `mr apply`-
 *   equivalent re-add succeeds), and records metadata.
 * - scanArchives enumerates only `.archive/` entries with a strict `--<ISO>`
 *   parse, surfacing `archivedAtMs` for retention.
 * - reapArchive removes the directory AND unregisters it from the bare's
 *   worktree list.
 *
 * The pure `parseArchiveDirName` regex contract is asserted inline (branch names
 * contain `-`/`--`/`/`; only a trailing valid ISO8601 instant is a timestamp).
 */

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as Command from 'effect/unstable/process/ChildProcess'
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner'
import { expect } from 'vitest'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import * as Git from '../core/git.ts'
import { requireTool } from '../test-utils/require-tool.ts'
import {
  createArchiveEntry,
  createStoreFixture,
  getWorktreeCommit,
  materializeNonDetachedBranchWorktree,
} from '../test-utils/store-setup.ts'
import { archiveWorktree, parseArchiveDirName, reapArchive, scanArchives } from './store-archive.ts'

const gitBin = requireTool('GIT_BIN')

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    return (yield* ChildProcessSpawner.use((spawner) =>
      spawner.string(Command.make(gitBin, args, { cwd })),
    )).trim()
  })

/** `<store>/github.com/<owner>/<repo>/` repo root for a fixture repo key. */
const repoRootFor = (storePath: AbsoluteDirPath, repoKey: string): AbsoluteDirPath =>
  EffectPath.ops.join(storePath, EffectPath.unsafe.relativeDir(`${repoKey}/`))

const REPO = { host: 'github.com', owner: 'acme', repo: 'widget' } as const
const REPO_KEY = `${REPO.host}/${REPO.owner}/${REPO.repo}`

describe('store-archive: parseArchiveDirName', () => {
  it('parses a slash/double-dash branch with a trailing ISO8601 timestamp', () => {
    const iso = '2026-06-11T10:20:30.000Z'
    const parsed = parseArchiveDirName(`schickling/2026-06-10--feature--x${`--${iso}`}`)
    expect(Option.isSome(parsed)).toBe(true)
    if (Option.isSome(parsed) === true) {
      expect(parsed.value.branch).toBe('schickling/2026-06-10--feature--x')
      expect(parsed.value.archivedAtMs).toBe(Date.parse(iso))
    }
  })

  it('rejects a name without a trailing ISO8601 instant', () => {
    expect(Option.isNone(parseArchiveDirName('feature-branch'))).toBe(true)
    expect(Option.isNone(parseArchiveDirName('feature--2026-06-11'))).toBe(true)
    // Empty branch segment (name starts with the separator) is rejected.
    expect(Option.isNone(parseArchiveDirName('--2026-06-11T10:20:30.000Z'))).toBe(true)
  })
})

describe('store-archive: archiveWorktree', () => {
  it.effect(
    'archives a clean worktree, frees the branch, and an mr-apply-equivalent re-add succeeds',
    Effect.fnUntraced(
      function* () {
        const fixture = yield* createStoreFixture([{ ...REPO, branches: ['feature/x'] }])
        const repoRoot = repoRootFor(fixture.storePath, REPO_KEY)
        const bareRepoPath = fixture.bareRepoPaths[REPO_KEY]!
        const worktreePath = fixture.worktreePaths[`${REPO_KEY}#feature/x`]!
        const commit = yield* getWorktreeCommit(worktreePath)

        // The fixture creates DETACHED worktrees; materialize the real branch ref
        // so we can prove archive FREES it (the cold-named-worktree shape).
        yield* git(bareRepoPath, 'branch', 'feature/x', commit)
        const fs = yield* FileSystem.FileSystem
        const before = yield* Git.refExists({
          repoPath: bareRepoPath,
          ref: 'refs/heads/feature/x',
        })
        expect(before).toBe(true)

        const now = Date.parse('2026-06-11T08:00:00.000Z')
        const { destPath: dest, warnings } = yield* archiveWorktree({
          repoRoot,
          bareRepoPath,
          worktreePath,
          branch: 'feature/x',
          commit,
          reason: 'merged',
          now,
        })
        expect(warnings).toEqual([])

        // Original gone, archive present.
        expect(yield* fs.exists(worktreePath)).toBe(false)
        expect(yield* fs.exists(dest)).toBe(true)
        expect(dest.includes('.archive/feature/x--2026-06-11T08:00:00.000Z')).toBe(true)

        // Branch FREED — mr apply can re-materialize it.
        expect(yield* Git.refExists({ repoPath: bareRepoPath, ref: 'refs/heads/feature/x' })).toBe(
          false,
        )

        // README metadata line recorded.
        const readme = yield* fs.readFileString(
          EffectPath.ops.join(repoRoot, EffectPath.unsafe.relativeFile('.archive/README.md')),
        )
        expect(readme).toContain(`feature/x\t2026-06-11T08:00:00.000Z\t${commit}\tmerged`)

        // mr-apply-equivalent re-add: recreate the branch + worktree at refs/heads/.
        const reAddPath = EffectPath.ops.join(
          repoRoot,
          EffectPath.unsafe.relativeDir('refs/heads/feature/x/'),
        )
        yield* git(bareRepoPath, 'branch', 'feature/x', commit)
        yield* git(bareRepoPath, 'worktree', 'add', reAddPath, 'feature/x')
        expect(yield* fs.exists(reAddPath)).toBe(true)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'archives a NON-DETACHED refs/heads worktree (production shape): frees the branch so re-add succeeds',
    Effect.fnUntraced(
      function* () {
        const fixture = yield* createStoreFixture([{ ...REPO, branches: ['feature/prod'] }])
        const repoRoot = repoRootFor(fixture.storePath, REPO_KEY)
        const bareRepoPath = fixture.bareRepoPaths[REPO_KEY]!
        const worktreePath = fixture.worktreePaths[`${REPO_KEY}#feature/prod`]!
        const commit = yield* getWorktreeCommit(worktreePath)
        const fs = yield* FileSystem.FileSystem

        // Re-materialize as the production shape: a NON-DETACHED worktree with
        // the branch checked out (the default fixtures use `--detach`, which
        // masks the `git branch -D` refusal this test guards against).
        yield* materializeNonDetachedBranchWorktree({
          bareRepoPath,
          worktreePath,
          branch: 'feature/prod',
          commit,
        })
        expect(
          yield* Git.refExists({ repoPath: bareRepoPath, ref: 'refs/heads/feature/prod' }),
        ).toBe(true)

        const { destPath: dest, warnings } = yield* archiveWorktree({
          repoRoot,
          bareRepoPath,
          worktreePath,
          branch: 'feature/prod',
          commit,
          reason: 'merged',
          now: Date.parse('2026-06-11T08:00:00.000Z'),
        })
        // The branch is freed cleanly, so no best-effort warning is surfaced.
        expect(warnings).toEqual([])

        // Original gone, archive present.
        expect(yield* fs.exists(worktreePath)).toBe(false)
        expect(yield* fs.exists(dest)).toBe(true)

        // Branch FREED despite having been checked out in the moved worktree.
        expect(
          yield* Git.refExists({ repoPath: bareRepoPath, ref: 'refs/heads/feature/prod' }),
        ).toBe(false)

        // mr-apply-equivalent re-add of the SAME branch succeeds.
        const reAddPath = EffectPath.ops.join(
          repoRoot,
          EffectPath.unsafe.relativeDir('refs/heads/feature/prod/'),
        )
        yield* git(bareRepoPath, 'branch', 'feature/prod', commit)
        yield* git(bareRepoPath, 'worktree', 'add', reAddPath, 'feature/prod')
        expect(yield* fs.exists(reAddPath)).toBe(true)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'archive preserves uncommitted + untracked work intact with the dir move',
    Effect.fnUntraced(
      function* () {
        const fixture = yield* createStoreFixture([
          { ...REPO, branches: ['feature/dirty'], dirtyWorktrees: ['feature/dirty'] },
        ])
        const repoRoot = repoRootFor(fixture.storePath, REPO_KEY)
        const bareRepoPath = fixture.bareRepoPaths[REPO_KEY]!
        const worktreePath = fixture.worktreePaths[`${REPO_KEY}#feature/dirty`]!
        const commit = yield* getWorktreeCommit(worktreePath)
        const fs = yield* FileSystem.FileSystem

        // Add an extra untracked file beyond the fixture's tracked-ish dirt.
        yield* fs.writeFileString(
          EffectPath.ops.join(worktreePath, EffectPath.unsafe.relativeFile('untracked.txt')),
          'precious\n',
        )

        const { destPath: dest } = yield* archiveWorktree({
          repoRoot,
          bareRepoPath,
          worktreePath,
          branch: 'feature/dirty',
          commit,
          reason: 'closed',
          now: Date.parse('2026-06-11T09:00:00.000Z'),
        })

        // Both the fixture dirt file and the untracked file traveled intact.
        expect(
          yield* fs.readFileString(
            EffectPath.ops.join(dest, EffectPath.unsafe.relativeFile('dirty.txt')),
          ),
        ).toBe('uncommitted changes\n')
        expect(
          yield* fs.readFileString(
            EffectPath.ops.join(dest, EffectPath.unsafe.relativeFile('untracked.txt')),
          ),
        ).toBe('precious\n')

        // The moved worktree still reports its dirt (status preserved).
        const status = yield* Git.getWorktreeStatus(dest)
        expect(status.isDirty).toBe(true)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )
})

describe('store-archive: scanArchives + reapArchive', () => {
  it.effect(
    'scanArchives lists only .archive/ entries with parsed timestamps; siblings ignored',
    Effect.fnUntraced(
      function* () {
        const fixture = yield* createStoreFixture([{ ...REPO, branches: ['live/keep'] }])
        const repoRoot = repoRootFor(fixture.storePath, REPO_KEY)
        const bareRepoPath = fixture.bareRepoPaths[REPO_KEY]!
        const liveWorktree = fixture.worktreePaths[`${REPO_KEY}#live/keep`]!
        const commit = yield* getWorktreeCommit(liveWorktree)

        const oldAt = new Date('2026-05-01T00:00:00.000Z')
        const newAt = new Date('2026-06-10T00:00:00.000Z')
        yield* createArchiveEntry({
          bareRepoPath,
          repoRoot,
          branch: 'feature/old',
          commit,
          archivedAt: oldAt,
        })
        yield* createArchiveEntry({
          bareRepoPath,
          repoRoot,
          branch: 'team/feature--double',
          commit,
          archivedAt: newAt,
        })

        const entries = yield* scanArchives({ repoRoot, bareRepoPath })

        // The live (refs/heads) worktree is NOT in the archive set.
        const branches = entries.map((entry) => entry.branch).sort()
        expect(branches).toEqual(['feature/old', 'team/feature--double'])

        const byBranch = new Map(entries.map((entry) => [entry.branch, entry]))
        expect(byBranch.get('feature/old')?.archivedAtMs).toBe(oldAt.getTime())
        expect(byBranch.get('team/feature--double')?.archivedAtMs).toBe(newAt.getTime())
        // Every reported path is under .archive/.
        for (const entry of entries) {
          expect(entry.path.includes('/.archive/')).toBe(true)
        }
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'reapArchive removes the directory AND unregisters it from the bare worktree list',
    Effect.fnUntraced(
      function* () {
        const fixture = yield* createStoreFixture([{ ...REPO, branches: ['live/keep'] }])
        const repoRoot = repoRootFor(fixture.storePath, REPO_KEY)
        const bareRepoPath = fixture.bareRepoPaths[REPO_KEY]!
        const commit = yield* getWorktreeCommit(fixture.worktreePaths[`${REPO_KEY}#live/keep`]!)
        const fs = yield* FileSystem.FileSystem

        const { archivePath } = yield* createArchiveEntry({
          bareRepoPath,
          repoRoot,
          branch: 'feature/reapme',
          commit,
          archivedAt: new Date('2026-04-01T00:00:00.000Z'),
        })

        // Present before reap.
        expect((yield* scanArchives({ repoRoot, bareRepoPath })).length).toBe(1)
        expect(yield* fs.exists(archivePath)).toBe(true)

        yield* reapArchive({ bareRepoPath, path: archivePath })

        // Directory gone AND no longer in git's worktree registry.
        expect(yield* fs.exists(archivePath)).toBe(false)
        expect((yield* scanArchives({ repoRoot, bareRepoPath })).length).toBe(0)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'scan + retention: split archives into reap-eligible vs within-retention by archivedAtMs',
    Effect.fnUntraced(
      function* () {
        const fixture = yield* createStoreFixture([{ ...REPO, branches: ['live/keep'] }])
        const repoRoot = repoRootFor(fixture.storePath, REPO_KEY)
        const bareRepoPath = fixture.bareRepoPaths[REPO_KEY]!
        const commit = yield* getWorktreeCommit(fixture.worktreePaths[`${REPO_KEY}#live/keep`]!)

        const now = Date.parse('2026-06-11T00:00:00.000Z')
        const retentionMs = 30 * 24 * 60 * 60 * 1000

        // One archived 40d ago (past retention) and one 5d ago (within retention).
        yield* createArchiveEntry({
          bareRepoPath,
          repoRoot,
          branch: 'feature/stale',
          commit,
          archivedAt: new Date(now - 40 * 24 * 60 * 60 * 1000),
        })
        yield* createArchiveEntry({
          bareRepoPath,
          repoRoot,
          branch: 'feature/fresh',
          commit,
          archivedAt: new Date(now - 5 * 24 * 60 * 60 * 1000),
        })

        const entries = yield* scanArchives({ repoRoot, bareRepoPath })
        const eligible = entries
          .filter((entry) => now - entry.archivedAtMs >= retentionMs)
          .map((entry) => entry.branch)
        expect(eligible).toEqual(['feature/stale'])
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )
})
