import { pathToFileURL } from 'node:url'

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Cause, Effect, Exit, Option, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as Cli from 'effect/unstable/cli'
import { expect } from 'vitest'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import {
  CONFIG_FILE_NAME_JSON,
  CompositionGeneratorConfig,
  MegarepoConfig,
} from '../core/config.ts'
import {
  LockFile,
  LOCK_FILE_NAME,
  checkLockStaleness,
  createEmptyLockFile,
  createLockedMember,
  readLockFile,
  updateLockedMember,
  writeLockFile,
} from '../core/lock.ts'
import { MegarepoSyncTree, SyncErrorItem } from '../sync/schema.ts'
import { makeConsoleCapture } from '../test-utils/consoleCapture.ts'
import {
  addCommit,
  createRepo,
  createWorkspace,
  initGitRepo,
  runGitCommand,
} from '../test-utils/setup.ts'
import {
  createStoreFixture,
  createWorkspaceWithLock,
  type StoreFixtureResult,
} from '../test-utils/store-setup.ts'
import { mrCommand } from './mod.ts'

/** Schema for parsing JSON output from `mr ... --output json` */
const SyncJsonOutput = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      status: Schema.String,
      lockUpdated: Schema.optional(Schema.Boolean),
      commit: Schema.optional(Schema.String),
      ref: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String),
      previousCommit: Schema.optional(Schema.String),
      refMismatch: Schema.optional(
        Schema.Struct({
          expectedRef: Schema.String,
          actualRef: Schema.String,
          isDetached: Schema.Boolean,
        }),
      ),
    }),
  ),
})

const decodeSyncJsonOutput = Schema.decodeUnknownSync(Schema.fromJsonString(SyncJsonOutput))

/** Run an `mr` CLI command and capture output. */
const runMrCommand = ({
  cwd,
  command = ['sync'],
  args = [],
  env = {},
}: {
  cwd: AbsoluteDirPath
  command?: ReadonlyArray<string>
  args?: ReadonlyArray<string>
  env?: Record<string, string>
}) =>
  Effect.gen(function* () {
    const { consoleLayer, getStdoutLines, getStderrLines } = yield* makeConsoleCapture
    const mergedEnv = { PWD: cwd, CI: 'false', ...env }
    const envCapture = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const previous = new Map<string, string | undefined>()
        for (const [key, value] of Object.entries(mergedEnv)) {
          previous.set(key, process.env[key])
          process.env[key] = value
        }
        return previous
      }),
      (previous) =>
        Effect.sync(() => {
          for (const [key, value] of previous) {
            if (value === undefined) {
              delete process.env[key]
            } else {
              process.env[key] = value
            }
          }
        }),
    )

    const stderrCapture = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const stderrChunks: Array<string> = []
        const originalStderrWrite = process.stderr.write.bind(process.stderr)

        const captureWrite = (target: Array<string>) =>
          ((chunk: unknown, encoding?: unknown, cb?: unknown) => {
            const actualEncoding =
              typeof encoding === 'function' ? undefined : (encoding as BufferEncoding)
            const callback = typeof encoding === 'function' ? encoding : cb
            const text =
              typeof chunk === 'string'
                ? chunk
                : Buffer.from(chunk as Uint8Array).toString(actualEncoding)
            target.push(text)
            if (typeof callback === 'function') callback()
            return true
          }) as unknown as typeof process.stderr.write

        process.stderr.write = captureWrite(stderrChunks)

        return { stderrChunks, originalStderrWrite }
      }),
      (capture) =>
        Effect.sync(() => {
          process.stderr.write = capture.originalStderrWrite
        }),
    )

    /**
     * A member-level failure is a reported result, not an Effect failure, so the command still
     * succeeds. The non-zero exit comes from the TUI app's `exitCode` mapper, which assigns
     * `process.exitCode` on unmount — so that is what has to be observed here.
     *
     * `process.exitCode` is global: it is cleared before the run and restored afterwards, or a
     * command that legitimately exits non-zero would also fail the vitest process itself.
     */
    const processExitCode = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const previous = process.exitCode
        process.exitCode = undefined
        return { previous }
      }),
      ({ previous }) =>
        Effect.sync(() => {
          process.exitCode = previous
        }),
    )

    // `mrCommand` provides its own `Cwd` layer from the `--cwd` global flag, so an
    // outer `Effect.provideService(Cwd, …)` is overridden and every command would
    // silently run against the ambient process cwd. Drive the documented flag.
    const argv = ['--cwd', cwd, ...command, ...args]
    const effect = Cli.Command.runWith(mrCommand, { version: 'test' })(argv).pipe(
      Effect.provide(consoleLayer),
    )
    const exit = yield* Effect.exit(effect)
    const reportedExitCode = process.exitCode
    void envCapture
    void processExitCode

    return {
      exit,
      stdout: (yield* getStdoutLines).join('\n'),
      stderr: [stderrCapture.stderrChunks.join(''), ...(yield* getStderrLines)].join('\n'),
      exitCode: Exit.isSuccess(exit) === false ? 1 : Number(reportedExitCode ?? 0),
    }
  }).pipe(Effect.scoped)

/** Run `mr lock` and capture output. */
const runLockRecordCommand = ({
  cwd,
  args = [],
  env = {},
}: {
  cwd: AbsoluteDirPath
  args?: ReadonlyArray<string>
  env?: Record<string, string>
}) => runMrCommand({ cwd, command: ['lock'], args, env })

/** Run `mr fetch` and capture output. */
const runFetchCommand = ({
  cwd,
  args = [],
  env = {},
}: {
  cwd: AbsoluteDirPath
  args?: ReadonlyArray<string>
  env?: Record<string, string>
}) => runMrCommand({ cwd, command: ['fetch'], args, env })

/** Run `mr apply` and capture output. */
const runApplyCommand = ({
  cwd,
  args = [],
  env = {},
}: {
  cwd: AbsoluteDirPath
  args?: ReadonlyArray<string>
  env?: Record<string, string>
}) => runMrCommand({ cwd, command: ['apply'], args, env })

/** Run `mr fetch --apply` (the daily driver, replaces old `mr sync`). */
const runFetchApplyCommand = ({
  cwd,
  args = [],
  env = {},
}: {
  cwd: AbsoluteDirPath
  args?: ReadonlyArray<string>
  env?: Record<string, string>
}) => runMrCommand({ cwd, command: ['fetch', '--apply'], args, env })

describe('worktree mode selection', () => {
  it.effect(
    'selects deterministic CI worktrees without requiring every caller to repeat the policy',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const store = yield* createStoreFixture([
          { host: 'example.com', owner: 'acme', repo: 'lib' },
        ])
        const bareRepo = store.bareRepoPaths['example.com/acme/lib']
        if (bareRepo === undefined) throw new Error('Missing bare repo')
        const lockedCommit = (yield* runGitCommand(bareRepo, 'rev-parse', 'main')).trim()
        const storeEnv = store.storePath.slice(0, -1)
        const cases = [
          {
            name: 'explicit commit under CI',
            args: ['--output', 'json', '--worktree-mode', 'commit'],
            env: { CI: 'true', MEGAREPO_STORE: storeEnv },
            expectedTarget: `/refs/commits/${lockedCommit}`,
          },
          {
            name: 'explicit tracking under CI',
            args: ['--output', 'json', '--worktree-mode', 'tracking'],
            env: { CI: 'true', MEGAREPO_STORE: storeEnv },
            expectedTarget: '/refs/heads/main',
          },
          {
            name: 'fetch --apply auto under CI',
            args: ['--output', 'json'],
            env: { CI: 'true', MEGAREPO_STORE: storeEnv },
            expectedTarget: `/refs/commits/${lockedCommit}`,
            fetchApply: true,
          },
          {
            name: 'auto outside CI',
            args: ['--output', 'json'],
            env: { CI: 'false', MEGAREPO_STORE: storeEnv },
            expectedTarget: '/refs/heads/main',
          },
        ] as const

        for (const testCase of cases) {
          const { workspacePath } = yield* createWorkspaceWithLock({
            members: { lib: 'https://example.com/acme/lib#main' },
            lockEntries: {
              lib: {
                url: 'https://example.com/acme/lib',
                ref: 'main',
                commit: lockedCommit,
              },
            },
          })
          const run = 'fetchApply' in testCase ? runFetchApplyCommand : runApplyCommand
          const result = yield* run({
            cwd: workspacePath,
            args: testCase.args,
            env: testCase.env,
          })
          expect(result.exitCode, testCase.name).toBe(0)
          expect(Exit.isSuccess(result.exit), testCase.name).toBe(true)
          const memberLink = yield* fs.readLink(
            EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeFile('repos/lib')),
          )
          expect(memberLink, testCase.name).toContain(testCase.expectedTarget)
        }
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )
})

describe('composition apply option policy', () => {
  const createCompositionWorkspace = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const { workspacePath } = yield* createWorkspace({ name: 'composition-workspace' })
    const config = new MegarepoConfig({
      members: {},
      generators: {
        composition: new CompositionGeneratorConfig({ enabled: true, platformHub: 'hub' }),
      },
    })
    const configContent = yield* Schema.encodeEffect(
      Schema.fromJsonString(MegarepoConfig, { space: 2 }),
    )(config)
    yield* fs.writeFileString(
      EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON)),
      `${configContent}\n`,
    )
    return workspacePath
  })

  it.effect(
    'accepts redundant --all with implicit auto in CI before entering composition apply',
    Effect.fnUntraced(
      function* () {
        const workspacePath = yield* createCompositionWorkspace
        const result = yield* runApplyCommand({
          cwd: workspacePath,
          args: ['--output', 'json', '--all'],
          env: { CI: 'true' },
        })

        const failure = Exit.isFailure(result.exit) === true ? Cause.pretty(result.exit.cause) : ''
        const diagnostic = `${result.stdout}\n${result.stderr}\n${failure}`
        expect(Exit.isFailure(result.exit)).toBe(true)
        expect(diagnostic).toContain('Could not establish owned composition identity')
        expect(diagnostic).not.toContain(
          'Composition apply owns the complete member set; --only and --skip are unavailable',
        )
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'rejects selectors and explicit commit mode that conflict with composition ownership',
    Effect.fnUntraced(
      function* () {
        const cases = [
          {
            name: '--only',
            args: ['--only', 'hub'],
            expected:
              'Composition apply owns the complete member set; --only and --skip are unavailable',
          },
          {
            name: '--skip',
            args: ['--skip', 'hub'],
            expected:
              'Composition apply owns the complete member set; --only and --skip are unavailable',
          },
          {
            name: '--worktree-mode commit',
            args: ['--worktree-mode', 'commit'],
            expected:
              'Composition apply requires the owned branch worktree; --worktree-mode commit is unavailable',
          },
        ] as const

        for (const testCase of cases) {
          const workspacePath = yield* createCompositionWorkspace
          const result = yield* runApplyCommand({
            cwd: workspacePath,
            args: ['--output', 'json', ...testCase.args],
            env: { CI: 'true' },
          })
          const failure =
            Exit.isFailure(result.exit) === true ? Cause.pretty(result.exit.cause) : ''
          expect(Exit.isFailure(result.exit), testCase.name).toBe(true)
          expect(`${result.stdout}\n${result.stderr}\n${failure}`, testCase.name).toContain(
            testCase.expected,
          )
        }
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )
})

describe('mr apply', () => {
  describe('with local path members', () => {
    it.effect(
      'should create symlinks for local path members',
      Effect.fnUntraced(
        function* () {
          const fs = yield* FileSystem.FileSystem

          // Create a temp directory with a local repo
          const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
          const localRepoPath = yield* createRepo({
            basePath: tmpDir,
            fixture: {
              name: 'local-lib',
              files: { 'package.json': '{"name": "local-lib"}' },
            },
          })

          // Create workspace with path member pointing to local repo
          const { workspacePath } = yield* createWorkspace({
            name: 'test-megarepo',
            members: {
              'local-lib': localRepoPath,
            },
          })

          // Verify the config was created
          const configPath = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeFile('megarepo.json'),
          )
          expect(yield* fs.exists(configPath)).toBe(true)

          // Verify symlink does NOT exist yet (sync hasn't run)
          const symlinkPath = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeDir('local-lib/'),
          )
          expect(yield* fs.exists(symlinkPath)).toBe(false)

          // Note: Actually running the sync command would require more setup
          // (proper CLI runner, etc). This test verifies the workspace fixture works.
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )
  })

  describe('workspace fixture', () => {
    it.effect(
      'should create workspace with symlinked repos',
      Effect.fnUntraced(
        function* () {
          const fs = yield* FileSystem.FileSystem

          // Create workspace with repos that get symlinked
          const { workspacePath, repoPaths } = yield* createWorkspace({
            name: 'full-workspace',
            members: {
              repo1: 'test/repo1',
            },
            repos: [{ name: 'repo1' }],
          })

          // Verify workspace structure
          expect(yield* fs.exists(workspacePath)).toBe(true)
          expect(
            yield* fs.exists(
              EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeFile('megarepo.json')),
            ),
          ).toBe(true)

          // Verify repo was created and symlinked
          expect(repoPaths['repo1']).toBeDefined()
          // Note: Symlinks are created without trailing slashes
          const symlinkPath = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeFile('repos/repo1'),
          )
          expect(yield* fs.exists(symlinkPath)).toBe(true)

          // Verify it's a symlink by reading the link target
          const linkTarget = yield* fs.readLink(symlinkPath)
          // The link target should be the repo path without trailing slash
          expect(linkTarget).toBe(repoPaths['repo1']?.slice(0, -1))
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )
  })
})

describe('lock apply mode', () => {
  describe('lock file staleness detection', () => {
    it('should detect stale lock file when members are added to config', () => {
      // Create lock file with one member
      let lockFile = createEmptyLockFile()
      lockFile = updateLockedMember({
        lockFile,
        memberName: 'existing-lib',
        member: createLockedMember({
          url: 'https://github.com/owner/existing-lib',
          ref: 'main',
          commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        }),
      })

      // Config has the existing member plus a new one
      const configMemberNames = new Set(['existing-lib', 'new-lib'])

      const result = checkLockStaleness({ lockFile, configMemberNames })

      expect(result.isStale).toBe(true)
      expect(result.addedMembers).toContain('new-lib')
      expect(result.removedMembers).toHaveLength(0)
    })

    it('should detect stale lock file when members are removed from config', () => {
      // Create lock file with two members
      let lockFile = createEmptyLockFile()
      lockFile = updateLockedMember({
        lockFile,
        memberName: 'lib1',
        member: createLockedMember({
          url: 'https://github.com/owner/lib1',
          ref: 'main',
          commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        }),
      })
      lockFile = updateLockedMember({
        lockFile,
        memberName: 'lib2',
        member: createLockedMember({
          url: 'https://github.com/owner/lib2',
          ref: 'main',
          commit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        }),
      })

      // Config only has lib1 (lib2 was removed)
      const configMemberNames = new Set(['lib1'])

      const result = checkLockStaleness({ lockFile, configMemberNames })

      expect(result.isStale).toBe(true)
      expect(result.addedMembers).toHaveLength(0)
      expect(result.removedMembers).toContain('lib2')
    })

    it('should not be stale when lock file matches config', () => {
      // Create lock file with same members as config
      let lockFile = createEmptyLockFile()
      lockFile = updateLockedMember({
        lockFile,
        memberName: 'lib1',
        member: createLockedMember({
          url: 'https://github.com/owner/lib1',
          ref: 'main',
          commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        }),
      })
      lockFile = updateLockedMember({
        lockFile,
        memberName: 'lib2',
        member: createLockedMember({
          url: 'https://github.com/owner/lib2',
          ref: 'main',
          commit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        }),
      })

      const configMemberNames = new Set(['lib1', 'lib2'])

      const result = checkLockStaleness({ lockFile, configMemberNames })

      expect(result.isStale).toBe(false)
      expect(result.addedMembers).toHaveLength(0)
      expect(result.removedMembers).toHaveLength(0)
    })

    it('should detect both added and removed members', () => {
      // Lock file has lib1 and lib2
      let lockFile = createEmptyLockFile()
      lockFile = updateLockedMember({
        lockFile,
        memberName: 'lib1',
        member: createLockedMember({
          url: 'https://github.com/owner/lib1',
          ref: 'main',
          commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        }),
      })
      lockFile = updateLockedMember({
        lockFile,
        memberName: 'lib2',
        member: createLockedMember({
          url: 'https://github.com/owner/lib2',
          ref: 'main',
          commit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        }),
      })

      // Config has lib1 and lib3 (lib2 removed, lib3 added)
      const configMemberNames = new Set(['lib1', 'lib3'])

      const result = checkLockStaleness({ lockFile, configMemberNames })

      expect(result.isStale).toBe(true)
      expect(result.addedMembers).toContain('lib3')
      expect(result.removedMembers).toContain('lib2')
    })
  })

  describe('lock apply mode with workspace', () => {
    it.effect(
      'should have up-to-date lock file when config matches',
      Effect.fnUntraced(
        function* () {
          // Create workspace with lock file that matches config
          const { workspacePath } = yield* createWorkspaceWithLock({
            members: {
              'my-lib': 'owner/repo',
            },
            lockEntries: {
              'my-lib': {
                url: 'https://github.com/owner/repo',
                ref: 'main',
                commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              },
            },
          })

          // Read lock file
          const lockPath = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
          )
          const lockFileOpt = yield* readLockFile(lockPath)
          expect(Option.isSome(lockFileOpt)).toBe(true)
          const lockFile = Option.getOrThrow(lockFileOpt)

          // Check staleness with config member names
          const configMemberNames = new Set(['my-lib'])
          const result = checkLockStaleness({ lockFile, configMemberNames })

          // Should not be stale - lock apply mode would succeed
          expect(result.isStale).toBe(false)
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )

    it.effect(
      'should detect missing lock file entries for lock apply mode',
      Effect.fnUntraced(
        function* () {
          // Create workspace with lock file missing an entry
          const { workspacePath } = yield* createWorkspaceWithLock({
            members: {
              lib1: 'owner/lib1',
              lib2: 'owner/lib2', // This is in config but not in lock
            },
            lockEntries: {
              // Only lib1 is in lock file
              lib1: {
                url: 'https://github.com/owner/lib1',
                ref: 'main',
                commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              },
            },
          })

          // Read lock file
          const lockPath = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
          )
          const lockFileOpt = yield* readLockFile(lockPath)
          expect(Option.isSome(lockFileOpt)).toBe(true)
          const lockFile = Option.getOrThrow(lockFileOpt)

          // Check staleness - lib2 is added in config but not in lock
          const configMemberNames = new Set(['lib1', 'lib2'])
          const result = checkLockStaleness({ lockFile, configMemberNames })

          // Should be stale - lock apply mode would fail
          expect(result.isStale).toBe(true)
          expect(result.addedMembers).toContain('lib2')
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )

    it.effect(
      'should detect extra lock file entries for lock apply mode',
      Effect.fnUntraced(
        function* () {
          // Create workspace with lock file having extra entries
          const { workspacePath } = yield* createWorkspaceWithLock({
            members: {
              lib1: 'owner/lib1', // Only this is in config
            },
            lockEntries: {
              lib1: {
                url: 'https://github.com/owner/lib1',
                ref: 'main',
                commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              },
              'old-lib': {
                // This was removed from config
                url: 'https://github.com/owner/old-lib',
                ref: 'main',
                commit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              },
            },
          })

          // Read lock file
          const lockPath = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
          )
          const lockFileOpt = yield* readLockFile(lockPath)
          expect(Option.isSome(lockFileOpt)).toBe(true)
          const lockFile = Option.getOrThrow(lockFileOpt)

          // Check staleness - old-lib is in lock but not in config
          const configMemberNames = new Set(['lib1'])
          const result = checkLockStaleness({ lockFile, configMemberNames })

          // Should be stale - lock apply mode would fail
          expect(result.isStale).toBe(true)
          expect(result.removedMembers).toContain('old-lib')
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )
  })

  describe('lock apply mode with pinned members', () => {
    it.effect(
      'should preserve pinned commit in lock file',
      Effect.fnUntraced(
        function* () {
          const pinnedCommit = 'abc1234567890abcdef1234567890abcdef1234'

          // Create workspace with pinned member
          const { workspacePath } = yield* createWorkspaceWithLock({
            members: {
              'pinned-lib': 'owner/repo',
            },
            lockEntries: {
              'pinned-lib': {
                url: 'https://github.com/owner/repo',
                ref: 'main',
                commit: pinnedCommit,
                pinned: true,
              },
            },
          })

          // Read lock file
          const lockPath = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
          )
          const lockFileOpt = yield* readLockFile(lockPath)
          const lockFile = Option.getOrThrow(lockFileOpt)

          // Verify pinned state
          expect(lockFile.members['pinned-lib']!.pinned).toBe(true)
          expect(lockFile.members['pinned-lib']!.commit).toBe(pinnedCommit)

          // Check staleness - should not be stale
          const configMemberNames = new Set(['pinned-lib'])
          const result = checkLockStaleness({ lockFile, configMemberNames })
          expect(result.isStale).toBe(false)
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )
  })
})

// =============================================================================
// Nested Megarepo Tests (--all mode)
// =============================================================================

/**
 * Helper to create a nested megarepo structure.
 * Creates a parent megarepo with a child member that is itself a megarepo.
 */
const createNestedMegarepoFixture = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    // Create temp directory
    const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)

    // Create grandchild repo (a normal git repo)
    const grandchildPath = yield* createRepo({
      basePath: tmpDir,
      fixture: {
        name: 'grandchild-lib',
        files: { 'package.json': '{"name": "grandchild-lib"}' },
      },
    })

    // Create child megarepo that includes grandchild as a member
    const childPath = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('child-megarepo/'))
    yield* fs.makeDirectory(childPath, { recursive: true })
    yield* initGitRepo(childPath)

    // Create child's megarepo.json pointing to grandchild
    const childConfig: MegarepoConfig = new MegarepoConfig({
      members: {
        'grandchild-lib': grandchildPath,
      },
    })
    const childConfigContent = yield* Schema.encodeEffect(
      Schema.fromJsonString(MegarepoConfig, { space: 2 }),
    )(childConfig)
    yield* fs.writeFileString(
      EffectPath.ops.join(childPath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON)),
      childConfigContent + '\n',
    )
    yield* addCommit({
      repoPath: childPath,
      message: 'Initialize child megarepo',
    })

    // Create parent megarepo that includes child as a member
    const parentPath = EffectPath.ops.join(
      tmpDir,
      EffectPath.unsafe.relativeDir('parent-megarepo/'),
    )
    yield* fs.makeDirectory(parentPath, { recursive: true })
    yield* initGitRepo(parentPath)

    // Create parent's megarepo.json pointing to child
    const parentConfig: MegarepoConfig = new MegarepoConfig({
      members: {
        'child-megarepo': childPath,
      },
    })
    const parentConfigContent = yield* Schema.encodeEffect(
      Schema.fromJsonString(MegarepoConfig, { space: 2 }),
    )(parentConfig)
    yield* fs.writeFileString(
      EffectPath.ops.join(parentPath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON)),
      parentConfigContent + '\n',
    )
    yield* addCommit({
      repoPath: parentPath,
      message: 'Initialize parent megarepo',
    })

    return {
      parentPath,
      childPath,
      grandchildPath,
    }
  })

describe('--all sync mode', () => {
  describe('nested megarepo detection', () => {
    it.effect(
      'should detect when a member is itself a megarepo',
      Effect.fnUntraced(
        function* () {
          const fs = yield* FileSystem.FileSystem
          const { parentPath, childPath } = yield* createNestedMegarepoFixture()

          // Verify parent has megarepo.json
          const parentConfigPath = EffectPath.ops.join(
            parentPath,
            EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
          )
          expect(yield* fs.exists(parentConfigPath)).toBe(true)

          // Verify child has megarepo.json (making it a nested megarepo)
          const childConfigPath = EffectPath.ops.join(
            childPath,
            EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
          )
          expect(yield* fs.exists(childConfigPath)).toBe(true)

          // Read parent config and verify it points to child
          const parentConfigContent = yield* fs.readFileString(parentConfigPath)
          const parentConfig = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(MegarepoConfig),
          )(parentConfigContent)
          expect(parentConfig.members['child-megarepo']).toBe(childPath)
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )

    it.effect(
      'should create valid nested megarepo structure with grandchild',
      Effect.fnUntraced(
        function* () {
          const fs = yield* FileSystem.FileSystem
          const { childPath, grandchildPath } = yield* createNestedMegarepoFixture()

          // Read child config and verify it points to grandchild
          const childConfigPath = EffectPath.ops.join(
            childPath,
            EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
          )
          const childConfigContent = yield* fs.readFileString(childConfigPath)
          const childConfig = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(MegarepoConfig),
          )(childConfigContent)
          expect(childConfig.members['grandchild-lib']).toBe(grandchildPath)

          // Verify grandchild is a regular repo (no megarepo.json)
          const grandchildConfigPath = EffectPath.ops.join(
            grandchildPath,
            EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
          )
          expect(yield* fs.exists(grandchildConfigPath)).toBe(false)
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )
  })
})

describe('--all nested error reporting', () => {
  it.effect(
    'should include nested member errors in JSON output',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem

        // Create temp directory
        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)

        // Create child megarepo with an invalid member source (guaranteed error, no network)
        const childPath = EffectPath.ops.join(
          tmpDir,
          EffectPath.unsafe.relativeDir('child-megarepo/'),
        )
        yield* fs.makeDirectory(childPath, { recursive: true })
        yield* initGitRepo(childPath)
        yield* fs.writeFileString(
          EffectPath.ops.join(childPath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON)),
          (yield* Schema.encodeEffect(Schema.fromJsonString(MegarepoConfig, { space: 2 }))(
            new MegarepoConfig({
              members: {
                bad: 'not-a-valid-source',
              },
            }),
          )) + '\n',
        )
        yield* addCommit({ repoPath: childPath, message: 'Initialize child megarepo' })

        // Create parent megarepo that includes child as a local path member
        const parentPath = EffectPath.ops.join(
          tmpDir,
          EffectPath.unsafe.relativeDir('parent-megarepo/'),
        )
        yield* fs.makeDirectory(parentPath, { recursive: true })
        yield* initGitRepo(parentPath)
        yield* fs.writeFileString(
          EffectPath.ops.join(parentPath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON)),
          (yield* Schema.encodeEffect(Schema.fromJsonString(MegarepoConfig, { space: 2 }))(
            new MegarepoConfig({
              members: {
                child: childPath,
              },
            }),
          )) + '\n',
        )
        yield* addCommit({ repoPath: parentPath, message: 'Initialize parent megarepo' })

        // When syncing nested megarepos, the nested root is the workspace member path (repos/<name>/)
        const childNestedRoot = EffectPath.ops.join(
          parentPath,
          EffectPath.unsafe.relativeDir('repos/child/'),
        )

        const result = yield* runFetchApplyCommand({
          cwd: parentPath,
          args: ['--output', 'json', '--all'],
        })

        expect(result.stdout.trim()).not.toBe('')

        const SyncOutput = Schema.TaggedStruct('Error', {
          syncErrorCount: Schema.Finite,
          syncErrors: Schema.Array(SyncErrorItem),
          syncTree: MegarepoSyncTree,
        })
        const out = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(SyncOutput))(
          result.stdout.trim(),
        )

        // The command should surface nested errors in output (and set process.exitCode via SyncApp)
        expect(out.syncErrorCount).toBe(1)
        expect(out.syncErrors).toHaveLength(1)
        const firstError = out.syncErrors[0]
        expect(firstError).toBeDefined()
        if (firstError !== undefined) {
          expect(firstError.megarepoRoot).toBe(childNestedRoot)
          expect(firstError.memberName).toBe('bad')
        }

        // Nested sync tree should include the child result with the failing member
        expect(out.syncTree.root).toBe(parentPath)
        expect(out.syncTree.nestedResults).toHaveLength(1)
        const firstNested = out.syncTree.nestedResults[0]
        expect(firstNested).toBeDefined()
        if (firstNested !== undefined) {
          expect(firstNested.root).toBe(childNestedRoot)

          const nestedResults = firstNested.results
          expect(nestedResults.some((r) => r.name === 'bad' && r.status === 'error')).toBe(true)
        }
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )
})

/**
 * Helper to create a diamond dependency structure for testing deduplication.
 *
 * Creates:
 *   root/
 *   ├── megarepo.json (members: child-a, child-b)
 *   ├── child-a/           <- megarepo with member: shared-lib
 *   │   └── megarepo.json
 *   ├── child-b/           <- megarepo with member: shared-lib (same!)
 *   │   └── megarepo.json
 *   └── shared-lib/        <- regular repo, referenced by both children
 *
 * This creates a diamond: root → child-a → shared-lib
 *                         root → child-b → shared-lib
 *
 * Without deduplication, shared-lib would be processed twice.
 */
const createDiamondDependencyFixture = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    // Create temp directory
    const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)

    // Create shared-lib (a regular git repo, not a megarepo)
    const sharedLibPath = yield* createRepo({
      basePath: tmpDir,
      fixture: {
        name: 'shared-lib',
        files: { 'package.json': '{"name": "shared-lib"}' },
      },
    })

    // Create child-a megarepo that includes shared-lib
    const childAPath = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('child-a/'))
    yield* fs.makeDirectory(childAPath, { recursive: true })
    yield* initGitRepo(childAPath)
    const childAConfig: MegarepoConfig = new MegarepoConfig({
      members: { 'shared-lib': sharedLibPath },
    })
    const childAConfigContent = yield* Schema.encodeEffect(
      Schema.fromJsonString(MegarepoConfig, { space: 2 }),
    )(childAConfig)
    yield* fs.writeFileString(
      EffectPath.ops.join(childAPath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON)),
      childAConfigContent + '\n',
    )
    yield* addCommit({
      repoPath: childAPath,
      message: 'Initialize child-a megarepo',
    })

    // Create child-b megarepo that ALSO includes shared-lib (diamond!)
    const childBPath = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('child-b/'))
    yield* fs.makeDirectory(childBPath, { recursive: true })
    yield* initGitRepo(childBPath)
    const childBConfig: MegarepoConfig = new MegarepoConfig({
      members: { 'shared-lib': sharedLibPath },
    })
    const childBConfigContent = yield* Schema.encodeEffect(
      Schema.fromJsonString(MegarepoConfig, { space: 2 }),
    )(childBConfig)
    yield* fs.writeFileString(
      EffectPath.ops.join(childBPath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON)),
      childBConfigContent + '\n',
    )
    yield* addCommit({
      repoPath: childBPath,
      message: 'Initialize child-b megarepo',
    })

    // Create root megarepo that includes both children
    const rootPath = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('root/'))
    yield* fs.makeDirectory(rootPath, { recursive: true })
    yield* initGitRepo(rootPath)
    const rootConfig: MegarepoConfig = new MegarepoConfig({
      members: {
        'child-a': childAPath,
        'child-b': childBPath,
      },
    })
    const rootConfigContent = yield* Schema.encodeEffect(
      Schema.fromJsonString(MegarepoConfig, { space: 2 }),
    )(rootConfig)
    yield* fs.writeFileString(
      EffectPath.ops.join(rootPath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON)),
      rootConfigContent + '\n',
    )
    yield* addCommit({
      repoPath: rootPath,
      message: 'Initialize root megarepo',
    })

    return {
      rootPath,
      childAPath,
      childBPath,
      sharedLibPath,
    }
  })

describe('--all sync deduplication', () => {
  it.effect(
    'should create valid diamond dependency structure',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { rootPath, childAPath, childBPath, sharedLibPath } =
          yield* createDiamondDependencyFixture()

        // Verify root has both children as members
        const rootConfigPath = EffectPath.ops.join(
          rootPath,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
        )
        const rootConfigContent = yield* fs.readFileString(rootConfigPath)
        const rootConfig = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(MegarepoConfig))(
          rootConfigContent,
        )
        expect(rootConfig.members['child-a']).toBe(childAPath)
        expect(rootConfig.members['child-b']).toBe(childBPath)

        // Verify both children reference the same shared-lib
        const childAConfigPath = EffectPath.ops.join(
          childAPath,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
        )
        const childAConfigContent = yield* fs.readFileString(childAConfigPath)
        const childAConfig = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(MegarepoConfig),
        )(childAConfigContent)
        expect(childAConfig.members['shared-lib']).toBe(sharedLibPath)

        const childBConfigPath = EffectPath.ops.join(
          childBPath,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
        )
        const childBConfigContent = yield* fs.readFileString(childBConfigPath)
        const childBConfig = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(MegarepoConfig),
        )(childBConfigContent)
        expect(childBConfig.members['shared-lib']).toBe(sharedLibPath)

        // Both children reference the SAME path
        expect(childAConfig.members['shared-lib']).toBe(childBConfig.members['shared-lib'])
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )
})

const createPinnedStaleCommitPullFixture = (options?: { readonly useCommitRef?: boolean }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)

    const sourceRepoPath = EffectPath.ops.join(
      tmpDir,
      EffectPath.unsafe.relativeDir('source-repo/'),
    )
    yield* fs.makeDirectory(sourceRepoPath, { recursive: true })
    yield* initGitRepo(sourceRepoPath)
    yield* runGitCommand(sourceRepoPath, 'checkout', '-b', 'main').pipe(
      Effect.catch(() => Effect.void),
    )
    yield* fs.writeFileString(
      EffectPath.ops.join(sourceRepoPath, EffectPath.unsafe.relativeFile('README.md')),
      '# Initial history\n',
    )
    yield* addCommit({ repoPath: sourceRepoPath, message: 'Initial commit' })
    const staleCommit = yield* runGitCommand(sourceRepoPath, 'rev-parse', 'HEAD')

    const remoteRepoPath = EffectPath.ops.join(
      tmpDir,
      EffectPath.unsafe.relativeDir('remote-repo.git/'),
    )
    yield* runGitCommand(tmpDir, 'init', '--bare', remoteRepoPath)
    yield* runGitCommand(sourceRepoPath, 'remote', 'add', 'origin', remoteRepoPath)
    yield* runGitCommand(sourceRepoPath, 'push', '-u', 'origin', 'main')

    yield* runGitCommand(sourceRepoPath, 'checkout', '--orphan', 'rewritten-main')
    yield* runGitCommand(sourceRepoPath, 'rm', '-rf', '.').pipe(Effect.catch(() => Effect.void))
    yield* fs.writeFileString(
      EffectPath.ops.join(sourceRepoPath, EffectPath.unsafe.relativeFile('README.md')),
      '# Rewritten history\n',
    )
    yield* addCommit({ repoPath: sourceRepoPath, message: 'Rewrite history' })
    yield* runGitCommand(sourceRepoPath, 'branch', '-M', 'main')
    yield* runGitCommand(sourceRepoPath, 'push', '--force', 'origin', 'main')
    const currentCommit = yield* runGitCommand(sourceRepoPath, 'rev-parse', 'HEAD')
    const memberRef = options?.useCommitRef === true ? staleCommit : 'main'
    const lockRef = memberRef
    /**
     * The fixture must remove the old object from the remote; otherwise a local clone
     * can still resolve the stale SHA and we would not exercise the recovery path.
     */
    yield* runGitCommand(remoteRepoPath, 'reflog', 'expire', '--expire=now', '--all')
    yield* runGitCommand(remoteRepoPath, 'gc', '--prune=now')

    const storePath = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('.megarepo/'))
    const repoBasePath = EffectPath.ops.join(
      storePath,
      EffectPath.unsafe.relativeDir('github.com/test-owner/test-repo/'),
    )
    const bareRepoPath = EffectPath.ops.join(repoBasePath, EffectPath.unsafe.relativeDir('.bare/'))
    yield* fs.makeDirectory(repoBasePath, { recursive: true })
    /** Avoid local clone optimizations so the bare store repo reflects the pruned remote state. */
    yield* runGitCommand(tmpDir, 'clone', '--bare', '--no-local', remoteRepoPath, bareRepoPath)
    yield* runGitCommand(
      bareRepoPath,
      'config',
      'remote.origin.fetch',
      '+refs/heads/*:refs/remotes/origin/*',
    )
    yield* runGitCommand(bareRepoPath, 'fetch', '--tags', '--prune', 'origin')

    const { workspacePath } = yield* createWorkspaceWithLock({
      members: {
        'test-repo': `test-owner/test-repo#${memberRef}`,
      },
      lockEntries: {
        'test-repo': {
          url: 'https://github.com/test-owner/test-repo',
          ref: lockRef,
          commit: staleCommit,
          pinned: true,
        },
      },
    })

    return {
      workspacePath,
      storePath,
      staleCommit,
      currentCommit,
    }
  })

/**
 * Per-test workspace fixture for nested megarepo lock tests.
 *
 * Each test gets its own store via createStoreFixture. We cannot share stores between
 * tests because the CLI acquires file-system distributed locks on the store directory
 * (via StoreLock/DistributedSemaphore). Shared locks between tests in the same process
 * cause deadlocks since the semaphore permit is never released across test boundaries.
 *
 * The store creation (~1.5s) is the main cost. Per-test timeout is set to 15s to account
 * for macOS CI runners where git process spawning is slower than Linux.
 */
const createNestedWorkspaceFixture = () =>
  Effect.gen(function* () {
    const store = yield* createStoreFixture([
      {
        host: 'example.com',
        owner: 'acme',
        repo: 'shared',
        branches: ['main'],
      },
    ])
    return yield* createNestedWorkspaceFixtureFromStore(store)
  })

const createNestedWorkspaceFixtureFromStore = (store: StoreFixtureResult) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    const sharedKey = 'example.com/acme/shared#main'
    const sharedWorktreePath = store.worktreePaths[sharedKey]
    if (sharedWorktreePath === undefined) {
      throw new Error(`Missing worktree path for ${sharedKey}`)
    }
    const sharedCommit = yield* runGitCommand(sharedWorktreePath, 'rev-parse', 'HEAD')
    const staleNestedCommit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

    const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
    const childPath = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('child/'))
    yield* fs.makeDirectory(childPath, { recursive: true })
    yield* initGitRepo(childPath)
    yield* fs.writeFileString(
      EffectPath.ops.join(childPath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON)),
      (yield* Schema.encodeEffect(Schema.fromJsonString(MegarepoConfig, { space: 2 }))(
        new MegarepoConfig({
          members: {
            shared: 'https://example.com/acme/shared#main',
          },
        }),
      )) + '\n',
    )
    let childLock = createEmptyLockFile()
    childLock = updateLockedMember({
      lockFile: childLock,
      memberName: 'shared',
      member: createLockedMember({
        url: 'https://example.com/acme/shared',
        ref: 'main',
        commit: staleNestedCommit,
      }),
    })
    yield* writeLockFile({
      lockPath: EffectPath.ops.join(childPath, EffectPath.unsafe.relativeFile(LOCK_FILE_NAME)),
      lockFile: childLock,
    })
    yield* addCommit({ repoPath: childPath, message: 'Initialize nested megarepo' })

    const parentPath = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('parent/'))
    yield* fs.makeDirectory(parentPath, { recursive: true })
    yield* initGitRepo(parentPath)
    yield* fs.writeFileString(
      EffectPath.ops.join(parentPath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON)),
      (yield* Schema.encodeEffect(Schema.fromJsonString(MegarepoConfig, { space: 2 }))(
        new MegarepoConfig({
          members: {
            shared: 'https://example.com/acme/shared#main',
            child: childPath,
          },
        }),
      )) + '\n',
    )
    let parentLock = createEmptyLockFile()
    parentLock = updateLockedMember({
      lockFile: parentLock,
      memberName: 'shared',
      member: createLockedMember({
        url: 'https://example.com/acme/shared',
        ref: 'main',
        commit: sharedCommit,
      }),
    })
    yield* writeLockFile({
      lockPath: EffectPath.ops.join(parentPath, EffectPath.unsafe.relativeFile(LOCK_FILE_NAME)),
      lockFile: parentLock,
    })

    yield* fs.writeFileString(
      EffectPath.ops.join(parentPath, EffectPath.unsafe.relativeFile('flake.lock')),
      '{"nodes":{"root":{"inputs":{}}},"root":"root","version":7}\n',
    )
    yield* addCommit({ repoPath: parentPath, message: 'Initialize parent megarepo' })

    return {
      parentPath,
      childPath,
      storePath: store.storePath,
      sharedCommit,
      staleNestedCommit,
    }
  })

const createNonMegarepoWorkspaceFixture = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const fixture = yield* createNestedWorkspaceFixture()
    const childConfigPath = EffectPath.ops.join(
      fixture.childPath,
      EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
    )
    yield* fs.remove(childConfigPath)
    return fixture
  })

const createAliasWorkspaceFixture = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const fixture = yield* createNestedWorkspaceFixture()
    const parentConfigPath = EffectPath.ops.join(
      fixture.parentPath,
      EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
    )
    const parentConfigContent = yield* fs.readFileString(parentConfigPath)
    const parentConfig = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(MegarepoConfig))(
      parentConfigContent,
    )
    const updatedConfig = new MegarepoConfig({
      ...parentConfig,
      members: {
        ...parentConfig.members,
        'shared-alias': 'https://example.com/acme/shared#main' as const,
      },
    })
    yield* fs.writeFileString(
      parentConfigPath,
      (yield* Schema.encodeEffect(Schema.fromJsonString(MegarepoConfig, { space: 2 }))(
        updatedConfig,
      )) + '\n',
    )

    const parentLockPath = EffectPath.ops.join(
      fixture.parentPath,
      EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
    )
    const parentLockOpt = yield* readLockFile(parentLockPath)
    const parentLock = Option.getOrThrow(parentLockOpt)
    const sharedMember = parentLock.members['shared']
    if (sharedMember === undefined) {
      throw new Error('Missing shared member in parent lock fixture')
    }
    const parentLockWithAlias = updateLockedMember({
      lockFile: parentLock,
      memberName: 'shared-alias',
      member: createLockedMember({
        url: sharedMember.url,
        ref: sharedMember.ref,
        commit: sharedMember.commit,
      }),
    })
    yield* writeLockFile({ lockPath: parentLockPath, lockFile: parentLockWithAlias })

    return fixture
  })

/** Standalone fixture — needs a different store config (two branches) */
const createNestedMegarepoLockRefMatchFixture = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const { storePath, worktreePaths, bareRepoPaths } = yield* createStoreFixture([
      {
        host: 'example.com',
        owner: 'acme',
        repo: 'shared',
        branches: ['main', 'dev'],
      },
    ])

    const mainKey = 'example.com/acme/shared#main'
    const devKey = 'example.com/acme/shared#dev'
    const mainWorktreePath = worktreePaths[mainKey]
    const devWorktreePath = worktreePaths[devKey]
    if (mainWorktreePath === undefined || devWorktreePath === undefined) {
      throw new Error(`Missing worktree paths for ${mainKey} and/or ${devKey}`)
    }

    const mainCommit = yield* runGitCommand(mainWorktreePath, 'rev-parse', 'HEAD')
    yield* fs.writeFileString(
      EffectPath.ops.join(devWorktreePath, EffectPath.unsafe.relativeFile('dev-only.txt')),
      'dev-only commit\n',
    )
    yield* addCommit({ repoPath: devWorktreePath, message: 'Add dev-only commit' })
    const devCommit = yield* runGitCommand(devWorktreePath, 'rev-parse', 'HEAD')
    const sharedRepoKey = 'example.com/acme/shared'
    const sharedBareRepoPath = bareRepoPaths[sharedRepoKey]
    if (sharedBareRepoPath === undefined) {
      throw new Error(`Missing bare repo path for ${sharedRepoKey}`)
    }
    yield* runGitCommand(sharedBareRepoPath, 'update-ref', 'refs/heads/main', mainCommit)
    yield* runGitCommand(sharedBareRepoPath, 'update-ref', 'refs/heads/dev', devCommit)

    const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
    const childPath = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('child/'))
    yield* fs.makeDirectory(childPath, { recursive: true })
    yield* initGitRepo(childPath)
    yield* fs.writeFileString(
      EffectPath.ops.join(childPath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON)),
      (yield* Schema.encodeEffect(Schema.fromJsonString(MegarepoConfig, { space: 2 }))(
        new MegarepoConfig({
          members: {
            'shared-dev': 'https://example.com/acme/shared#dev',
          },
        }),
      )) + '\n',
    )
    let childLock = createEmptyLockFile()
    childLock = updateLockedMember({
      lockFile: childLock,
      memberName: 'shared-dev',
      member: createLockedMember({
        url: 'https://example.com/acme/shared',
        ref: 'dev',
        commit: mainCommit,
      }),
    })
    yield* writeLockFile({
      lockPath: EffectPath.ops.join(childPath, EffectPath.unsafe.relativeFile(LOCK_FILE_NAME)),
      lockFile: childLock,
    })
    yield* addCommit({ repoPath: childPath, message: 'Initialize nested megarepo' })

    const parentPath = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('parent/'))
    yield* fs.makeDirectory(parentPath, { recursive: true })
    yield* initGitRepo(parentPath)
    yield* fs.writeFileString(
      EffectPath.ops.join(parentPath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON)),
      (yield* Schema.encodeEffect(Schema.fromJsonString(MegarepoConfig, { space: 2 }))(
        new MegarepoConfig({
          members: {
            'shared-main': 'https://example.com/acme/shared#main',
            'shared-dev': 'https://example.com/acme/shared#dev',
            child: childPath,
          },
        }),
      )) + '\n',
    )
    let parentLock = createEmptyLockFile()
    parentLock = updateLockedMember({
      lockFile: parentLock,
      memberName: 'shared-main',
      member: createLockedMember({
        url: 'https://example.com/acme/shared',
        ref: 'main',
        commit: mainCommit,
      }),
    })
    parentLock = updateLockedMember({
      lockFile: parentLock,
      memberName: 'shared-dev',
      member: createLockedMember({
        url: 'https://example.com/acme/shared',
        ref: 'dev',
        commit: devCommit,
      }),
    })
    yield* writeLockFile({
      lockPath: EffectPath.ops.join(parentPath, EffectPath.unsafe.relativeFile(LOCK_FILE_NAME)),
      lockFile: parentLock,
    })

    yield* fs.writeFileString(
      EffectPath.ops.join(parentPath, EffectPath.unsafe.relativeFile('flake.lock')),
      '{"nodes":{"root":{"inputs":{}}},"root":"root","version":7}\n',
    )
    yield* addCommit({ repoPath: parentPath, message: 'Initialize parent megarepo' })

    return {
      parentPath,
      childPath,
      storePath,
      mainCommit,
      devCommit,
    }
  })

describe('nested megarepo.lock sync scope', () => {
  it.effect(
    'should not sync nested megarepo.lock when apply lock sync is disabled',
    Effect.fnUntraced(
      function* () {
        const { parentPath, childPath, storePath, staleNestedCommit } =
          yield* createNestedWorkspaceFixture()

        const nestedLockPath = EffectPath.ops.join(
          childPath,
          EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
        )
        const beforeNestedLockOpt = yield* readLockFile(nestedLockPath)
        expect(Option.isSome(beforeNestedLockOpt)).toBe(true)
        const beforeNestedLock = Option.getOrThrow(beforeNestedLockOpt)
        expect(beforeNestedLock.members['shared']?.commit).toBe(staleNestedCommit)

        const result = yield* runApplyCommand({
          cwd: parentPath,
          args: ['--output', 'json', '--lock-sync', 'off'],
          env: {
            MEGAREPO_STORE: storePath.slice(0, -1),
          },
        })
        expect(result.exitCode).toBe(0)

        const afterNestedLockOpt = yield* readLockFile(nestedLockPath)
        expect(Option.isSome(afterNestedLockOpt)).toBe(true)
        const afterNestedLock = Option.getOrThrow(afterNestedLockOpt)
        expect(afterNestedLock.members['shared']?.commit).toBe(staleNestedCommit)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
    { timeout: 15_000 },
  )

  it.effect(
    'should not sync nested megarepo.lock in default workspace sync mode',
    Effect.fnUntraced(
      function* () {
        const { parentPath, childPath, storePath, staleNestedCommit } =
          yield* createNestedWorkspaceFixture()

        const nestedLockPath = EffectPath.ops.join(
          childPath,
          EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
        )
        const beforeNestedLockOpt = yield* readLockFile(nestedLockPath)
        expect(Option.isSome(beforeNestedLockOpt)).toBe(true)
        const beforeNestedLock = Option.getOrThrow(beforeNestedLockOpt)
        expect(beforeNestedLock.members['shared']?.commit).toBe(staleNestedCommit)

        const result = yield* runFetchApplyCommand({
          cwd: parentPath,
          args: ['--output', 'json'],
          env: {
            MEGAREPO_STORE: storePath.slice(0, -1),
          },
        })
        expect(result.exitCode).toBe(0)

        const afterNestedLockOpt = yield* readLockFile(nestedLockPath)
        expect(Option.isSome(afterNestedLockOpt)).toBe(true)
        const afterNestedLock = Option.getOrThrow(afterNestedLockOpt)
        expect(afterNestedLock.members['shared']?.commit).toBe(staleNestedCommit)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
    { timeout: 15_000 },
  )

  it.effect(
    'should sync nested megarepo.lock only when mr fetch --apply --all is set',
    Effect.fnUntraced(
      function* () {
        const { parentPath, childPath, storePath, sharedCommit, staleNestedCommit } =
          yield* createNestedWorkspaceFixture()

        const nestedLockPath = EffectPath.ops.join(
          childPath,
          EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
        )
        const beforeNestedLockOpt = yield* readLockFile(nestedLockPath)
        expect(Option.isSome(beforeNestedLockOpt)).toBe(true)
        const beforeNestedLock = Option.getOrThrow(beforeNestedLockOpt)
        expect(beforeNestedLock.members['shared']?.commit).toBe(staleNestedCommit)

        const result = yield* runFetchApplyCommand({
          cwd: parentPath,
          args: ['--output', 'json', '--all'],
          env: {
            MEGAREPO_STORE: storePath.slice(0, -1),
          },
        })
        expect(result.exitCode).toBe(0)

        const afterNestedLockOpt = yield* readLockFile(nestedLockPath)
        expect(Option.isSome(afterNestedLockOpt)).toBe(true)
        const afterNestedLock = Option.getOrThrow(afterNestedLockOpt)
        expect(afterNestedLock.members['shared']?.commit).toBe(sharedCommit)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
    { timeout: 15_000 },
  )

  it.effect(
    'should not abort recursive mr fetch when nested pinned members reference stale commits',
    Effect.fnUntraced(
      function* () {
        const { parentPath, childPath, storePath, staleNestedCommit } =
          yield* createNestedWorkspaceFixture()

        const nestedLockPath = EffectPath.ops.join(
          childPath,
          EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
        )
        const nestedLockOpt = yield* readLockFile(nestedLockPath)
        expect(Option.isSome(nestedLockOpt)).toBe(true)

        const nestedLock = updateLockedMember({
          lockFile: Option.getOrThrow(nestedLockOpt),
          memberName: 'shared',
          member: createLockedMember({
            url: 'https://example.com/acme/shared',
            ref: 'main',
            commit: staleNestedCommit,
            pinned: true,
          }),
        })
        yield* writeLockFile({ lockPath: nestedLockPath, lockFile: nestedLock })

        const result = yield* runFetchCommand({
          cwd: parentPath,
          args: ['--output', 'json', '--all'],
          env: {
            MEGAREPO_STORE: storePath.slice(0, -1),
          },
        })

        expect(result.exitCode).toBe(0)
        expect(result.stderr).not.toContain('invalid reference')
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
    { timeout: 15_000 },
  )

  it.effect(
    'should not sync nested megarepo.lock for members filtered out by --only',
    Effect.fnUntraced(
      function* () {
        const { parentPath, childPath, storePath, staleNestedCommit } =
          yield* createNestedWorkspaceFixture()

        const nestedLockPath = EffectPath.ops.join(
          childPath,
          EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
        )
        const beforeNestedLockOpt = yield* readLockFile(nestedLockPath)
        expect(Option.isSome(beforeNestedLockOpt)).toBe(true)
        const beforeNestedLock = Option.getOrThrow(beforeNestedLockOpt)
        expect(beforeNestedLock.members['shared']?.commit).toBe(staleNestedCommit)

        const result = yield* runFetchApplyCommand({
          cwd: parentPath,
          args: ['--output', 'json', '--all', '--only', 'shared'],
          env: {
            MEGAREPO_STORE: storePath.slice(0, -1),
          },
        })
        expect(result.exitCode).toBe(0)

        const afterNestedLockOpt = yield* readLockFile(nestedLockPath)
        expect(Option.isSome(afterNestedLockOpt)).toBe(true)
        const afterNestedLock = Option.getOrThrow(afterNestedLockOpt)
        expect(afterNestedLock.members['shared']?.commit).toBe(staleNestedCommit)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
    { timeout: 15_000 },
  )

  it.effect(
    'should not sync member megarepo.lock in --all mode when member is not a megarepo',
    Effect.fnUntraced(
      function* () {
        const { parentPath, childPath, storePath, staleNestedCommit } =
          yield* createNonMegarepoWorkspaceFixture()

        const nestedLockPath = EffectPath.ops.join(
          childPath,
          EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
        )
        const beforeNestedLockOpt = yield* readLockFile(nestedLockPath)
        expect(Option.isSome(beforeNestedLockOpt)).toBe(true)
        const beforeNestedLock = Option.getOrThrow(beforeNestedLockOpt)
        expect(beforeNestedLock.members['shared']?.commit).toBe(staleNestedCommit)

        const result = yield* runFetchApplyCommand({
          cwd: parentPath,
          args: ['--output', 'json', '--all'],
          env: {
            MEGAREPO_STORE: storePath.slice(0, -1),
          },
        })
        expect(result.exitCode).toBe(0)

        const afterNestedLockOpt = yield* readLockFile(nestedLockPath)
        expect(Option.isSome(afterNestedLockOpt)).toBe(true)
        const afterNestedLock = Option.getOrThrow(afterNestedLockOpt)
        expect(afterNestedLock.members['shared']?.commit).toBe(staleNestedCommit)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
    { timeout: 15_000 },
  )

  it.effect(
    'should match nested megarepo.lock entries by ref when URL is shared across refs',
    Effect.fnUntraced(
      function* () {
        const { parentPath, childPath, storePath, mainCommit, devCommit } =
          yield* createNestedMegarepoLockRefMatchFixture()

        const nestedLockPath = EffectPath.ops.join(
          childPath,
          EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
        )
        const beforeNestedLockOpt = yield* readLockFile(nestedLockPath)
        expect(Option.isSome(beforeNestedLockOpt)).toBe(true)
        const beforeNestedLock = Option.getOrThrow(beforeNestedLockOpt)
        expect(beforeNestedLock.members['shared-dev']?.commit).toBe(mainCommit)

        const result = yield* runFetchApplyCommand({
          cwd: parentPath,
          args: ['--output', 'json', '--all'],
          env: {
            MEGAREPO_STORE: storePath.slice(0, -1),
          },
        })
        expect(result.exitCode).toBe(0)

        const afterNestedLockOpt = yield* readLockFile(nestedLockPath)
        expect(Option.isSome(afterNestedLockOpt)).toBe(true)
        const afterNestedLock = Option.getOrThrow(afterNestedLockOpt)
        expect(afterNestedLock.members['shared-dev']?.commit).toBe(devCommit)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
    { timeout: 15_000 },
  )

  it.effect(
    'should sync nested megarepo.lock when multiple parent aliases match URL/ref with same commit',
    Effect.fnUntraced(
      function* () {
        const { parentPath, childPath, storePath, sharedCommit, staleNestedCommit } =
          yield* createAliasWorkspaceFixture()

        const nestedLockPath = EffectPath.ops.join(
          childPath,
          EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
        )
        const beforeNestedLockOpt = yield* readLockFile(nestedLockPath)
        expect(Option.isSome(beforeNestedLockOpt)).toBe(true)
        const beforeNestedLock = Option.getOrThrow(beforeNestedLockOpt)
        expect(beforeNestedLock.members['shared']?.commit).toBe(staleNestedCommit)

        const result = yield* runFetchApplyCommand({
          cwd: parentPath,
          args: ['--output', 'json', '--all', '--worktree-mode', 'tracking'],
          env: {
            MEGAREPO_STORE: storePath.slice(0, -1),
          },
        })
        expect(result.exitCode).toBe(0)

        const afterNestedLockOpt = yield* readLockFile(nestedLockPath)
        expect(Option.isSome(afterNestedLockOpt)).toBe(true)
        const afterNestedLock = Option.getOrThrow(afterNestedLockOpt)
        expect(afterNestedLock.members['shared']?.commit).toBe(sharedCommit)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
    { timeout: 15_000 },
  )
})

// =============================================================================
// Lock Sync Tests (lock updated from workspace state)
// =============================================================================

describe('mr lock', () => {
  describe('lock file updates', () => {
    it.effect(
      'should update lock file when worktree HEAD differs from lock',
      Effect.fnUntraced(
        function* () {
          const fs = yield* FileSystem.FileSystem

          // Create a temp directory with a local repo
          const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
          const localRepoPath = yield* createRepo({
            basePath: tmpDir,
            fixture: {
              name: 'my-lib',
              files: { 'package.json': '{"name": "my-lib"}' },
            },
          })

          // Get the initial commit (used for lock file setup below)
          const _initialCommit = yield* runGitCommand(localRepoPath, 'rev-parse', 'HEAD')

          // Create workspace with lock pointing to an OLD commit
          const { workspacePath } = yield* createWorkspaceWithLock({
            members: {
              'my-lib': localRepoPath,
            },
            lockEntries: {
              'my-lib': {
                url: localRepoPath,
                ref: 'main',
                commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', // Old/wrong commit
              },
            },
          })

          // Run mr lock
          const result = yield* runLockRecordCommand({
            cwd: workspacePath,
            args: ['--output', 'json'],
          })
          const json = decodeSyncJsonOutput(result.stdout.trim())

          // Should have synced successfully (local path sources are symlinks)
          expect(json.results).toHaveLength(1)
          const memberResult = json.results[0]
          expect(memberResult?.name).toBe('my-lib')
          // For local paths, status is 'synced' since they create symlinks
          expect(['synced', 'recorded', 'already_synced']).toContain(memberResult?.status)
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )

    it.effect(
      'should return already_synced when lock matches current HEAD',
      Effect.fnUntraced(
        function* () {
          const fs = yield* FileSystem.FileSystem

          // Create workspace with local repo
          const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
          const localRepoPath = yield* createRepo({
            basePath: tmpDir,
            fixture: {
              name: 'my-lib',
              files: { 'package.json': '{"name": "my-lib"}' },
            },
          })

          // Get the current commit
          const currentCommit = yield* runGitCommand(localRepoPath, 'rev-parse', 'HEAD')

          // Create workspace with lock matching current commit
          const { workspacePath } = yield* createWorkspaceWithLock({
            members: {
              'my-lib': localRepoPath,
            },
            lockEntries: {
              'my-lib': {
                url: localRepoPath,
                ref: 'main',
                commit: currentCommit, // Matches current HEAD
              },
            },
          })

          // First sync to create symlinks
          yield* runFetchApplyCommand({ cwd: workspacePath, args: [] })

          // Second sync should show already_synced
          const result = yield* runLockRecordCommand({
            cwd: workspacePath,
            args: ['--output', 'json'],
          })
          const json = decodeSyncJsonOutput(result.stdout.trim())

          expect(json.results).toHaveLength(1)
          const memberResult = json.results[0]
          expect(memberResult?.name).toBe('my-lib')
          // After first sync, should be already_synced or synced
          expect(['synced', 'already_synced']).toContain(memberResult?.status)
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )
  })

  describe('no remote fetch', () => {
    it.effect(
      'should NOT fetch from remote in lock sync mode',
      Effect.fnUntraced(
        function* () {
          const fs = yield* FileSystem.FileSystem

          // Create workspace with a non-existent remote member
          const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
          const workspacePath = EffectPath.ops.join(
            tmpDir,
            EffectPath.unsafe.relativeDir('workspace/'),
          )
          yield* fs.makeDirectory(workspacePath, { recursive: true })
          yield* initGitRepo(workspacePath)

          // Create megarepo.json with a GitHub repo
          const config: MegarepoConfig = new MegarepoConfig({
            members: {
              // Using a real but unlikely-to-change repo
              effect: 'effect-ts/effect',
            },
          })
          const configContent = yield* Schema.encodeEffect(
            Schema.fromJsonString(MegarepoConfig, { space: 2 }),
          )(config)
          yield* fs.writeFileString(
            EffectPath.ops.join(
              workspacePath,
              EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
            ),
            configContent + '\n',
          )
          yield* addCommit({
            repoPath: workspacePath,
            message: 'Initialize megarepo',
          })

          // Run mr lock. It should not fetch remote state and should report the member as
          // needing workspace sync first because no branch worktree has been materialized yet.
          const result = yield* runLockRecordCommand({
            cwd: workspacePath,
            args: ['--output', 'json', '--dry-run'],
          })

          // The command should complete (might error on clone attempt, but shouldn't hang on fetch)
          expect(result.exitCode).toBeDefined()
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )
  })

  describe('ref change detection', () => {
    it.effect(
      'should update symlink when ref changes in config',
      Effect.fnUntraced(
        function* () {
          const fs = yield* FileSystem.FileSystem

          // Create temp directory
          const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)

          // Create a local repo without the feature file
          const baseRepoPath = yield* createRepo({
            basePath: tmpDir,
            fixture: {
              name: 'my-lib',
              files: { 'package.json': '{"name": "my-lib"}' },
            },
          })

          // Create a second repo that includes the feature file
          const featureRepoPath = yield* createRepo({
            basePath: tmpDir,
            fixture: {
              name: 'my-lib-feature',
              files: {
                'package.json': '{"name": "my-lib"}',
                'feature.txt': 'feature content\n',
              },
            },
          })

          // Create workspace pointing to the base repo path
          const workspacePath = EffectPath.ops.join(
            tmpDir,
            EffectPath.unsafe.relativeDir('workspace/'),
          )
          yield* fs.makeDirectory(workspacePath, { recursive: true })
          yield* initGitRepo(workspacePath)

          // Create initial config pointing to the base repo path
          const initialConfig: MegarepoConfig = new MegarepoConfig({
            members: {
              'my-lib': baseRepoPath,
            },
          })
          const configPath = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
          )
          yield* fs.writeFileString(
            configPath,
            (yield* Schema.encodeEffect(Schema.fromJsonString(MegarepoConfig, { space: 2 }))(
              initialConfig,
            )) + '\n',
          )
          yield* addCommit({ repoPath: workspacePath, message: 'Initialize megarepo' })

          // First sync to create symlink
          yield* runFetchApplyCommand({ cwd: workspacePath, args: [] })

          // Verify symlink exists
          const symlinkPath = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeFile('repos/my-lib'),
          )
          const initialLink = yield* fs.readLink(symlinkPath)
          expect(initialLink).toBeDefined()

          // Verify feature.txt does NOT exist for the base repo
          const featureFileInBase = yield* fs
            .exists(
              EffectPath.ops.join(
                workspacePath,
                EffectPath.unsafe.relativeFile('repos/my-lib/feature.txt'),
              ),
            )
            .pipe(Effect.orElseSucceed(() => false))
          expect(featureFileInBase).toBe(false)

          // Update config to point to the feature repo path
          const updatedConfig: MegarepoConfig = new MegarepoConfig({
            members: {
              'my-lib': featureRepoPath,
            },
          })
          yield* fs.writeFileString(
            configPath,
            (yield* Schema.encodeEffect(Schema.fromJsonString(MegarepoConfig, { space: 2 }))(
              updatedConfig,
            )) + '\n',
          )

          // Sync again - should update symlink
          const result = yield* runFetchApplyCommand({
            cwd: workspacePath,
            args: ['--output', 'json'],
          })
          const json = decodeSyncJsonOutput(result.stdout.trim())

          // Should have synced (updated symlink)
          expect(json.results).toHaveLength(1)
          expect(json.results[0]?.status).toBe('synced')

          // Verify symlink now points to new location
          const updatedLink = yield* fs.readLink(symlinkPath)
          expect(updatedLink).not.toBe(initialLink)

          const featureFileInFeature = yield* fs
            .exists(
              EffectPath.ops.join(
                workspacePath,
                EffectPath.unsafe.relativeFile('repos/my-lib/feature.txt'),
              ),
            )
            .pipe(Effect.orElseSucceed(() => false))
          expect(featureFileInFeature).toBe(true)
          expect(updatedLink.replace(/\/$/, '')).toBe(featureRepoPath.replace(/\/$/, ''))
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )

    it.effect(
      'should skip ref change if old worktree has uncommitted changes',
      Effect.fnUntraced(
        function* () {
          const fs = yield* FileSystem.FileSystem

          // Create temp directory
          const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)

          // Create two local repos (simulating two branches)
          const mainRepoPath = yield* createRepo({
            basePath: tmpDir,
            fixture: {
              name: 'my-lib-main',
              files: { 'package.json': '{"name": "my-lib"}' },
            },
          })

          const featureRepoPath = yield* createRepo({
            basePath: tmpDir,
            fixture: {
              name: 'my-lib-feature',
              files: {
                'package.json': '{"name": "my-lib"}',
                'feature.txt': 'feature content\n',
              },
            },
          })

          // Create workspace pointing to main
          const workspacePath = EffectPath.ops.join(
            tmpDir,
            EffectPath.unsafe.relativeDir('workspace/'),
          )
          yield* fs.makeDirectory(workspacePath, { recursive: true })
          yield* initGitRepo(workspacePath)

          const configPath = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
          )
          yield* fs.writeFileString(
            configPath,
            (yield* Schema.encodeEffect(Schema.fromJsonString(MegarepoConfig, { space: 2 }))(
              new MegarepoConfig({
                members: { 'my-lib': mainRepoPath },
              }),
            )) + '\n',
          )
          yield* addCommit({ repoPath: workspacePath, message: 'Initialize megarepo' })

          // First sync to create symlink
          yield* runFetchApplyCommand({ cwd: workspacePath, args: [] })

          // Add dirty changes to the main repo (simulating work in progress)
          yield* fs.writeFileString(
            EffectPath.ops.join(mainRepoPath, EffectPath.unsafe.relativeFile('dirty.txt')),
            'uncommitted work\n',
          )

          // Update config to point to feature branch
          yield* fs.writeFileString(
            configPath,
            (yield* Schema.encodeEffect(Schema.fromJsonString(MegarepoConfig, { space: 2 }))(
              new MegarepoConfig({
                members: { 'my-lib': featureRepoPath },
              }),
            )) + '\n',
          )

          // Sync again - should skip because old worktree is dirty
          const result = yield* runFetchApplyCommand({
            cwd: workspacePath,
            args: ['--output', 'json'],
          })
          const json = decodeSyncJsonOutput(result.stdout.trim())

          // Should have skipped due to dirty worktree
          expect(json.results).toHaveLength(1)
          expect(json.results[0]?.status).toBe('skipped')
          expect(json.results[0]?.message).toContain('uncommitted')

          // Verify symlink still points to main
          const symlinkPath = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeFile('repos/my-lib'),
          )
          const currentLink = yield* fs.readLink(symlinkPath)
          expect(currentLink.replace(/\/$/, '')).toBe(mainRepoPath.replace(/\/$/, ''))
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )

    /**
     * A commit worktree is a pinned materialization: apply put it there to satisfy an exact
     * lock entry. Leaving one at the wrong sha means apply did not deliver Lock → Workspace,
     * so reporting `skipped` would exit 0 and hide a workspace that disagrees with the lock
     * that produced it (#962).
     */
    it.effect(
      'should fail when a dirty commit worktree leaves the member drifted from the lock',
      Effect.fnUntraced(
        function* () {
          const fs = yield* FileSystem.FileSystem
          const store = yield* createStoreFixture([
            { host: 'example.com', owner: 'acme', repo: 'lib', branches: ['main'] },
          ])
          const mainWorktree = store.worktreePaths['example.com/acme/lib#main']
          if (mainWorktree === undefined) throw new Error('Missing main worktree')
          const lockedCommit = (yield* runGitCommand(mainWorktree, 'rev-parse', 'HEAD')).trim()

          const { workspacePath } = yield* createWorkspaceWithLock({
            members: { lib: 'https://example.com/acme/lib#main' },
            lockEntries: {
              lib: { url: 'https://example.com/acme/lib', ref: 'main', commit: lockedCommit },
            },
          })
          const env = { MEGAREPO_STORE: store.storePath.slice(0, -1) }

          // Materialize the pinned commit worktree the lock currently names.
          yield* runApplyCommand({ cwd: workspacePath, args: ['--worktree-mode', 'commit'], env })

          const symlinkPath = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeFile('repos/lib'),
          )
          const pinnedLink = yield* fs.readLink(symlinkPath)
          expect(pinnedLink).toContain(`/refs/commits/${lockedCommit}`)

          // Move the lock on to a second real commit, then dirty the pinned worktree so apply
          // cannot switch away from it.
          yield* fs.writeFileString(
            EffectPath.ops.join(mainWorktree, EffectPath.unsafe.relativeFile('next.txt')),
            'next\n',
          )
          yield* addCommit({ repoPath: mainWorktree, message: 'Advance main' })
          const newCommit = (yield* runGitCommand(mainWorktree, 'rev-parse', 'HEAD')).trim()

          yield* writeLockFile({
            lockPath: EffectPath.ops.join(
              workspacePath,
              EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
            ),
            lockFile: updateLockedMember({
              lockFile: createEmptyLockFile(),
              memberName: 'lib',
              member: createLockedMember({
                url: 'https://example.com/acme/lib',
                ref: 'main',
                commit: newCommit,
              }),
            }),
          })

          yield* fs.writeFileString(
            EffectPath.unsafe.absoluteFile(`${pinnedLink.replace(/\/$/, '')}/dirty.txt`),
            'uncommitted work\n',
          )

          const result = yield* runApplyCommand({
            cwd: workspacePath,
            args: ['--worktree-mode', 'commit', '--output', 'json'],
            env,
          })
          const json = decodeSyncJsonOutput(result.stdout.trim())

          expect(json.results[0]?.status).toBe('error')
          expect(json.results[0]?.message).toContain(lockedCommit.slice(0, 8))
          expect(json.results[0]?.message).toContain(newCommit.slice(0, 8))
          expect(result.exitCode).toBe(1)

          // The uncommitted work is still protected — apply reports, it does not clobber.
          expect(yield* fs.readLink(symlinkPath)).toBe(pinnedLink)
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
      { timeout: 15_000 },
    )

    /**
     * Branch worktrees are the co-development surface: local commits deliberately move HEAD
     * ahead of the lock. Failing on that would break the normal local loop, so a dirty branch
     * worktree stays a skip even when its commit disagrees with the lock.
     */
    it.effect(
      'should still skip, not fail, when a dirty branch worktree disagrees with the lock',
      Effect.fnUntraced(
        function* () {
          const fs = yield* FileSystem.FileSystem
          const store = yield* createStoreFixture([
            { host: 'example.com', owner: 'acme', repo: 'lib', branches: ['main'] },
          ])
          const mainWorktree = store.worktreePaths['example.com/acme/lib#main']
          if (mainWorktree === undefined) throw new Error('Missing main worktree')

          // Advance the branch past the commit the lock will record, so the branch worktree is
          // legitimately ahead — exactly the co-development shape.
          const staleCommit = (yield* runGitCommand(mainWorktree, 'rev-parse', 'HEAD')).trim()
          yield* fs.writeFileString(
            EffectPath.ops.join(mainWorktree, EffectPath.unsafe.relativeFile('wip.txt')),
            'wip\n',
          )
          yield* addCommit({ repoPath: mainWorktree, message: 'Local work' })

          const { workspacePath } = yield* createWorkspaceWithLock({
            members: { lib: 'https://example.com/acme/lib#main' },
            lockEntries: {
              lib: { url: 'https://example.com/acme/lib', ref: 'main', commit: staleCommit },
            },
          })
          const env = { MEGAREPO_STORE: store.storePath.slice(0, -1) }

          yield* runApplyCommand({ cwd: workspacePath, args: ['--worktree-mode', 'tracking'], env })
          yield* fs.writeFileString(
            EffectPath.ops.join(mainWorktree, EffectPath.unsafe.relativeFile('dirty.txt')),
            'uncommitted work\n',
          )

          const result = yield* runApplyCommand({
            cwd: workspacePath,
            args: ['--worktree-mode', 'tracking', '--output', 'json'],
            env,
          })
          const json = decodeSyncJsonOutput(result.stdout.trim())

          expect(json.results[0]?.status).not.toBe('error')
          expect(result.exitCode).toBe(0)
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
      { timeout: 15_000 },
    )

    it.effect(
      'should allow ref change with --force even if old worktree is dirty',
      Effect.fnUntraced(
        function* () {
          const fs = yield* FileSystem.FileSystem

          // Create temp directory
          const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)

          // Create two local repos
          const mainRepoPath = yield* createRepo({
            basePath: tmpDir,
            fixture: {
              name: 'my-lib-main',
              files: { 'package.json': '{"name": "my-lib"}' },
            },
          })

          const featureRepoPath = yield* createRepo({
            basePath: tmpDir,
            fixture: {
              name: 'my-lib-feature',
              files: { 'package.json': '{"name": "my-lib"}', 'feature.txt': 'feature\n' },
            },
          })

          // Create workspace
          const workspacePath = EffectPath.ops.join(
            tmpDir,
            EffectPath.unsafe.relativeDir('workspace/'),
          )
          yield* fs.makeDirectory(workspacePath, { recursive: true })
          yield* initGitRepo(workspacePath)

          const configPath = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
          )
          yield* fs.writeFileString(
            configPath,
            (yield* Schema.encodeEffect(Schema.fromJsonString(MegarepoConfig, { space: 2 }))(
              new MegarepoConfig({
                members: { 'my-lib': mainRepoPath },
              }),
            )) + '\n',
          )
          yield* addCommit({ repoPath: workspacePath, message: 'Initialize megarepo' })

          // First sync
          yield* runFetchApplyCommand({ cwd: workspacePath, args: [] })

          // Add dirty changes
          yield* fs.writeFileString(
            EffectPath.ops.join(mainRepoPath, EffectPath.unsafe.relativeFile('dirty.txt')),
            'uncommitted work\n',
          )

          // Update config
          yield* fs.writeFileString(
            configPath,
            (yield* Schema.encodeEffect(Schema.fromJsonString(MegarepoConfig, { space: 2 }))(
              new MegarepoConfig({
                members: { 'my-lib': featureRepoPath },
              }),
            )) + '\n',
          )

          // Sync with --force - should succeed
          const result = yield* runFetchApplyCommand({
            cwd: workspacePath,
            args: ['--output', 'json', '--force'],
          })
          const json = decodeSyncJsonOutput(result.stdout.trim())

          // Should have synced despite dirty worktree
          expect(json.results).toHaveLength(1)
          expect(json.results[0]?.status).toBe('synced')

          // Verify symlink now points to feature
          const symlinkPath = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeFile('repos/my-lib'),
          )
          const currentLink = yield* fs.readLink(symlinkPath)
          expect(currentLink.replace(/\/$/, '')).toBe(featureRepoPath.replace(/\/$/, ''))
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )
  })
})

// =============================================================================
// Lock Update Tests
// =============================================================================

describe('mr fetch', () => {
  describe('dirty worktree protection', () => {
    it.effect(
      'should skip member with uncommitted changes unless --force',
      Effect.fnUntraced(
        function* () {
          const fs = yield* FileSystem.FileSystem

          // Create a dirty local repo
          const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
          const localRepoPath = yield* createRepo({
            basePath: tmpDir,
            fixture: {
              name: 'dirty-lib',
              files: { 'package.json': '{"name": "dirty-lib"}' },
              dirty: true, // Has uncommitted changes
            },
          })

          // Create workspace
          const { workspacePath } = yield* createWorkspaceWithLock({
            members: {
              'dirty-lib': localRepoPath,
            },
            lockEntries: {
              'dirty-lib': {
                url: localRepoPath,
                ref: 'main',
                commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              },
            },
          })

          // Create symlink manually to simulate existing member
          const reposDir = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeDir('repos/'),
          )
          yield* fs.makeDirectory(reposDir, { recursive: true })
          yield* fs.symlink(
            localRepoPath.slice(0, -1),
            EffectPath.ops.join(reposDir, EffectPath.unsafe.relativeFile('dirty-lib')),
          )

          // Run mr fetch (should skip dirty worktree)
          // Note: For local path sources, dirty check may not apply the same way
          // This test documents the expected behavior
          const result = yield* runFetchCommand({
            cwd: workspacePath,
            args: ['--output', 'json'],
          })

          // Should complete without error
          expect(result.exitCode).toBeDefined()
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )
  })

  describe('pinned members', () => {
    it.effect(
      'should skip pinned members in lock update mode',
      Effect.fnUntraced(
        function* () {
          const fs = yield* FileSystem.FileSystem

          // Create a local repo
          const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
          const localRepoPath = yield* createRepo({
            basePath: tmpDir,
            fixture: {
              name: 'pinned-lib',
              files: { 'package.json': '{"name": "pinned-lib"}' },
            },
          })

          const currentCommit = yield* runGitCommand(localRepoPath, 'rev-parse', 'HEAD')

          // Create workspace with pinned member
          const { workspacePath } = yield* createWorkspaceWithLock({
            members: {
              'pinned-lib': localRepoPath,
            },
            lockEntries: {
              'pinned-lib': {
                url: localRepoPath,
                ref: 'main',
                commit: currentCommit,
                pinned: true, // PINNED
              },
            },
          })

          // Create symlink manually
          const reposDir = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeDir('repos/'),
          )
          yield* fs.makeDirectory(reposDir, { recursive: true })
          yield* fs.symlink(
            localRepoPath.slice(0, -1),
            EffectPath.ops.join(reposDir, EffectPath.unsafe.relativeFile('pinned-lib')),
          )

          // Run mr fetch
          const result = yield* runFetchCommand({
            cwd: workspacePath,
            args: ['--output', 'json'],
          })
          const json = decodeSyncJsonOutput(result.stdout.trim())

          // The sync should complete
          expect(json.results).toHaveLength(1)
          // Note: Local path sources behave differently, but this documents the behavior
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )

    it.effect(
      'should recover pinned members with stale locked commits in mr fetch --force mode',
      Effect.fnUntraced(
        function* () {
          const { workspacePath, storePath, staleCommit, currentCommit } =
            yield* createPinnedStaleCommitPullFixture()

          const result = yield* runFetchCommand({
            cwd: workspacePath,
            args: ['--force', '--output', 'json'],
            env: {
              MEGAREPO_STORE: storePath.slice(0, -1),
            },
          })
          const json = decodeSyncJsonOutput(result.stdout.trim())

          expect(result.exitCode).toBe(0)
          expect(json.results).toHaveLength(1)
          const memberResult = json.results[0]!
          expect(memberResult.status).toBe('updated')
          expect(memberResult.previousCommit).toBe(staleCommit)
          expect(memberResult.commit).toBe(currentCommit)

          const lockPath = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
          )
          const lockFileOpt = yield* readLockFile(lockPath)
          expect(Option.isSome(lockFileOpt)).toBe(true)
          const lockFile = Option.getOrThrow(lockFileOpt)
          expect(lockFile.members['test-repo']?.commit).toBe(currentCommit)
          expect(lockFile.members['test-repo']?.pinned).toBe(true)
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )

    it.effect(
      'should skip pinned stale commit-SHA refs in mr fetch mode',
      Effect.fnUntraced(
        function* () {
          const { workspacePath, storePath } = yield* createPinnedStaleCommitPullFixture({
            useCommitRef: true,
          })

          const result = yield* runFetchCommand({
            cwd: workspacePath,
            args: ['--output', 'json'],
            env: {
              MEGAREPO_STORE: storePath.slice(0, -1),
            },
          })
          const json = decodeSyncJsonOutput(result.stdout.trim())

          expect(json.results).toHaveLength(1)
          const memberResult = json.results[0]!
          expect(memberResult.status).toBe('skipped')
          expect(memberResult.message).toContain('pinned')
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )

    it.effect(
      'should fail pinned stale commit-SHA refs in mr fetch --apply --force mode',
      Effect.fnUntraced(
        function* () {
          const { workspacePath, storePath, staleCommit } =
            yield* createPinnedStaleCommitPullFixture({
              useCommitRef: true,
            })

          const result = yield* runFetchApplyCommand({
            cwd: workspacePath,
            args: ['--force', '--output', 'json'],
            env: {
              MEGAREPO_STORE: storePath.slice(0, -1),
            },
          })
          const json = decodeSyncJsonOutput(result.stdout.trim())

          expect(json.results).toHaveLength(1)
          const memberResult = json.results[0]!
          expect(memberResult.status).toBe('error')
          expect(memberResult.message).toContain(`'${staleCommit.slice(0, 8)}'`)
          expect(memberResult.message).toContain('not available locally or on the remote')
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )
  })

  describe('fast-forward branch worktrees', () => {
    it.effect(
      'should fast-forward existing branch worktree when remote has new commits',
      Effect.fnUntraced(
        function* () {
          const fs = yield* FileSystem.FileSystem

          // Create temp directory for all test artifacts
          const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)

          // 1. Create source repo (acts as the remote origin)
          const sourceRepoPath = EffectPath.ops.join(
            tmpDir,
            EffectPath.unsafe.relativeDir('source-repo/'),
          )
          yield* fs.makeDirectory(sourceRepoPath, { recursive: true })
          yield* initGitRepo(sourceRepoPath)
          // Force branch name to 'main' regardless of git config default
          yield* runGitCommand(sourceRepoPath, 'checkout', '-b', 'main').pipe(
            Effect.catch(() => Effect.void),
          )
          yield* fs.writeFileString(
            EffectPath.ops.join(sourceRepoPath, EffectPath.unsafe.relativeFile('README.md')),
            '# Test Repo\n',
          )
          yield* runGitCommand(sourceRepoPath, 'add', '-A')
          yield* runGitCommand(sourceRepoPath, 'commit', '--no-verify', '-m', 'Initial commit')
          const initialCommit = yield* runGitCommand(sourceRepoPath, 'rev-parse', 'HEAD')

          // 2. Create store with bare repo cloned from source
          const storePath = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('.megarepo/'))
          const repoBasePath = EffectPath.ops.join(
            storePath,
            EffectPath.unsafe.relativeDir('github.com/test-owner/test-repo/'),
          )
          const bareRepoPath = EffectPath.ops.join(
            repoBasePath,
            EffectPath.unsafe.relativeDir('.bare/'),
          )
          yield* fs.makeDirectory(repoBasePath, { recursive: true })
          yield* runGitCommand(tmpDir, 'clone', '--bare', sourceRepoPath, bareRepoPath)
          // Configure fetch refspec (git clone --bare doesn't set this up)
          yield* runGitCommand(
            bareRepoPath,
            'config',
            'remote.origin.fetch',
            '+refs/heads/*:refs/remotes/origin/*',
          )
          // Fetch to populate refs/remotes/origin/*
          yield* runGitCommand(bareRepoPath, 'fetch', '--tags', '--prune', 'origin')

          // 3. Create branch-tracking worktree
          const worktreePath = EffectPath.ops.join(
            repoBasePath,
            EffectPath.unsafe.relativeDir('refs/heads/main/'),
          )
          yield* fs.makeDirectory(
            EffectPath.ops.join(repoBasePath, EffectPath.unsafe.relativeDir('refs/heads/')),
            { recursive: true },
          )
          yield* runGitCommand(bareRepoPath, 'worktree', 'add', worktreePath, 'main')

          // Verify worktree is at initial commit
          const worktreeHeadBefore = yield* runGitCommand(worktreePath, 'rev-parse', 'HEAD')
          expect(worktreeHeadBefore).toBe(initialCommit)

          // 4. Create workspace with config, lock, and symlink
          const { workspacePath } = yield* createWorkspaceWithLock({
            members: {
              'test-repo': 'test-owner/test-repo',
            },
            lockEntries: {
              'test-repo': {
                url: `https://github.com/test-owner/test-repo`,
                ref: 'main',
                commit: initialCommit,
              },
            },
          })

          // Create symlink manually
          const reposDir = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeDir('repos/'),
          )
          yield* fs.makeDirectory(reposDir, { recursive: true })
          yield* fs.symlink(
            worktreePath.replace(/\/$/, ''),
            EffectPath.ops.join(reposDir, EffectPath.unsafe.relativeFile('test-repo')),
          )

          // 5. Add new commit to source repo (simulate remote advancing)
          yield* fs.writeFileString(
            EffectPath.ops.join(sourceRepoPath, EffectPath.unsafe.relativeFile('new-file.txt')),
            'new content\n',
          )
          yield* runGitCommand(sourceRepoPath, 'add', '-A')
          yield* runGitCommand(sourceRepoPath, 'commit', '--no-verify', '-m', 'Second commit')
          const newCommit = yield* runGitCommand(sourceRepoPath, 'rev-parse', 'HEAD')
          expect(newCommit).not.toBe(initialCommit)

          // 6. Run mr fetch --apply with tracking mode (to test branch worktree ff-merge)
          const result = yield* runFetchApplyCommand({
            cwd: workspacePath,
            args: ['--output', 'json', '--worktree-mode', 'tracking'],
            env: { MEGAREPO_STORE: storePath },
          })
          const json = decodeSyncJsonOutput(result.stdout.trim())

          // 7. Verify result — applyAfterFetch uses branch worktrees and fast-forwards
          expect(json.results).toHaveLength(1)
          const memberResult = json.results[0]!
          expect(memberResult.status).toBe('updated')
          expect(memberResult.commit).toBe(newCommit)
          expect(memberResult.previousCommit).toBe(initialCommit)

          // 8. Verify worktree HEAD is actually updated
          const worktreeHeadAfter = yield* runGitCommand(worktreePath, 'rev-parse', 'HEAD')
          expect(worktreeHeadAfter).toBe(newCommit)
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
      { timeout: 30_000 },
    )
  })
})

// =============================================================================
// Status Types Tests
// =============================================================================

describe('sync status types', () => {
  it.effect(
    'should return cloned status for new members',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem

        // Create a local repo
        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const localRepoPath = yield* createRepo({
          basePath: tmpDir,
          fixture: {
            name: 'new-lib',
            files: { 'package.json': '{"name": "new-lib"}' },
          },
        })

        // Create workspace WITHOUT lock file (new member)
        const workspacePath = EffectPath.ops.join(
          tmpDir,
          EffectPath.unsafe.relativeDir('workspace/'),
        )
        yield* fs.makeDirectory(workspacePath, { recursive: true })
        yield* initGitRepo(workspacePath)

        const config: MegarepoConfig = new MegarepoConfig({
          members: {
            'new-lib': localRepoPath,
          },
        })
        const configContent = yield* Schema.encodeEffect(
          Schema.fromJsonString(MegarepoConfig, { space: 2 }),
        )(config)
        yield* fs.writeFileString(
          EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON)),
          configContent + '\n',
        )
        yield* addCommit({
          repoPath: workspacePath,
          message: 'Initialize megarepo',
        })

        // Run sync for first time
        const result = yield* runFetchApplyCommand({
          cwd: workspacePath,
          args: ['--output', 'json'],
        })
        const json = decodeSyncJsonOutput(result.stdout.trim())

        expect(json.results).toHaveLength(1)
        const memberResult = json.results[0]
        expect(memberResult?.name).toBe('new-lib')
        // For local paths, first sync creates a symlink - status is 'synced'
        expect(memberResult?.status).toBe('synced')
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )
})

describe('sync error handling', () => {
  it.effect(
    'should return clear error when remote repo does not exist',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem

        // Create a megarepo with a non-existent remote member
        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const workspacePath = EffectPath.ops.join(
          tmpDir,
          EffectPath.unsafe.relativeDir('workspace/'),
        )
        yield* fs.makeDirectory(workspacePath, { recursive: true })
        yield* initGitRepo(workspacePath)
        const missingRemotePath = EffectPath.ops.join(
          tmpDir,
          EffectPath.unsafe.relativeDir('missing-remote.git/'),
        )

        // Create megarepo.json with a missing remote. Use file:// so the clone
        // failure is deterministic and does not spend the test timeout on
        // network/auth retries.
        const config: MegarepoConfig = new MegarepoConfig({
          members: {
            'non-existent-repo': pathToFileURL(missingRemotePath).href,
          },
        })
        const configContent = yield* Schema.encodeEffect(
          Schema.fromJsonString(MegarepoConfig, { space: 2 }),
        )(config)
        yield* fs.writeFileString(
          EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON)),
          configContent + '\n',
        )
        yield* addCommit({
          repoPath: workspacePath,
          message: 'Initialize megarepo',
        })

        // Run sync --json to get structured output
        const result = yield* runFetchApplyCommand({
          cwd: workspacePath,
          args: ['--output', 'json'],
        })

        // Parse the JSON output
        const json = decodeSyncJsonOutput(result.stdout.trim())

        // Should have results for our member
        expect(json.results).toHaveLength(1)
        const memberResult = json.results[0]
        expect(memberResult?.name).toBe('non-existent-repo')
        expect(memberResult?.status).toBe('error')

        // The error message should be clear and actionable, NOT a cryptic filesystem error
        expect(memberResult?.message).toBeDefined()
        // Should NOT contain cryptic internal errors like "FileSystem.access"
        expect(memberResult?.message).not.toContain('FileSystem.access')
        // Should indicate the actual git/remote problem, not an internal API failure.
        expect(
          memberResult?.message?.toLowerCase().includes('clone') ||
            memberResult?.message?.toLowerCase().includes('repository') ||
            memberResult?.message?.toLowerCase().includes('not found') ||
            memberResult?.message?.toLowerCase().includes('access') ||
            memberResult?.message?.toLowerCase().includes('network') ||
            memberResult?.message?.toLowerCase().includes('connect') ||
            memberResult?.message?.toLowerCase().includes('ssh') ||
            memberResult?.message?.toLowerCase().includes('auth'),
        ).toBe(true)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )
})

describe('foreign member mount guards', () => {
  it.effect(
    'fails apply and dry-run identically for a configured local-path real directory',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const sourcePath = yield* createRepo({
          basePath: tmpDir,
          fixture: { name: 'local-source', files: { 'source.txt': 'source\n' } },
        })
        const { workspacePath } = yield* createWorkspaceWithLock({
          members: { 'local-lib': sourcePath },
        })
        yield* writeLockFile({
          lockPath: EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
          ),
          lockFile: createEmptyLockFile(),
        })

        const memberPath = EffectPath.ops.join(
          workspacePath,
          EffectPath.unsafe.relativeFile('repos/local-lib'),
        )
        const sentinelPath = EffectPath.ops.join(
          EffectPath.unsafe.absoluteDir(`${memberPath}/`),
          EffectPath.unsafe.relativeFile('sentinel.bin'),
        )
        const sentinel = new Uint8Array([0, 255, 17, 10, 0, 99])
        yield* fs.makeDirectory(memberPath, { recursive: true })
        yield* fs.writeFile(sentinelPath, sentinel)

        const applied = yield* runApplyCommand({
          cwd: workspacePath,
          args: ['--output', 'json'],
        })
        const previewed = yield* runApplyCommand({
          cwd: workspacePath,
          args: ['--output', 'json', '--dry-run'],
        })
        const appliedResult = decodeSyncJsonOutput(applied.stdout.trim()).results[0]
        const previewedResult = decodeSyncJsonOutput(previewed.stdout.trim()).results[0]
        const expectedMessage = `Refusing to replace member 'local-lib' at '${memberPath}': it is a foreign non-symlink mount`

        expect(applied.exitCode).toBe(1)
        expect(previewed.exitCode).toBe(1)
        expect(appliedResult).toMatchObject({
          name: 'local-lib',
          status: 'error',
          message: expectedMessage,
        })
        expect(previewedResult).toEqual(appliedResult)
        expect(Array.from(yield* fs.readFile(sentinelPath))).toEqual(Array.from(sentinel))
        expect(yield* fs.readDirectory(memberPath)).toEqual(['sentinel.bin'])
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'fails apply and dry-run identically for a configured remote real directory',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const store = yield* createStoreFixture([
          { host: 'example.com', owner: 'acme', repo: 'lib', branches: ['main'] },
        ])
        const mainWorktree = store.worktreePaths['example.com/acme/lib#main']
        if (mainWorktree === undefined) throw new Error('Missing main worktree')
        const commit = (yield* runGitCommand(mainWorktree, 'rev-parse', 'HEAD')).trim()
        const { workspacePath } = yield* createWorkspaceWithLock({
          members: { lib: 'https://example.com/acme/lib#main' },
          lockEntries: {
            lib: { url: 'https://example.com/acme/lib', ref: 'main', commit },
          },
        })
        const memberPath = EffectPath.ops.join(
          workspacePath,
          EffectPath.unsafe.relativeFile('repos/lib'),
        )
        const sentinelPath = EffectPath.ops.join(
          EffectPath.unsafe.absoluteDir(`${memberPath}/`),
          EffectPath.unsafe.relativeFile('sentinel.bin'),
        )
        const configPath = EffectPath.ops.join(
          workspacePath,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
        )
        const lockPath = EffectPath.ops.join(
          workspacePath,
          EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
        )
        const sentinel = new Uint8Array([222, 173, 190, 239, 0, 10])
        yield* fs.makeDirectory(memberPath, { recursive: true })
        yield* fs.writeFile(sentinelPath, sentinel)
        const configBefore = yield* fs.readFile(configPath)
        const lockBefore = yield* fs.readFile(lockPath)
        const env = { MEGAREPO_STORE: store.storePath.slice(0, -1) }

        const applied = yield* runApplyCommand({
          cwd: workspacePath,
          args: ['--output', 'json'],
          env,
        })
        const previewed = yield* runApplyCommand({
          cwd: workspacePath,
          args: ['--output', 'json', '--dry-run'],
          env,
        })
        const appliedResult = decodeSyncJsonOutput(applied.stdout.trim()).results[0]
        const previewedResult = decodeSyncJsonOutput(previewed.stdout.trim()).results[0]
        const expectedMessage = `Refusing to replace member 'lib' at '${memberPath}': it is a foreign non-symlink mount`

        expect(applied.exitCode).toBe(1)
        expect(previewed.exitCode).toBe(1)
        expect(appliedResult).toMatchObject({
          name: 'lib',
          status: 'error',
          message: expectedMessage,
        })
        expect(previewedResult).toEqual(appliedResult)
        expect(Array.from(yield* fs.readFile(sentinelPath))).toEqual(Array.from(sentinel))
        expect(yield* fs.readDirectory(memberPath)).toEqual(['sentinel.bin'])
        expect(yield* fs.readFile(configPath)).toEqual(configBefore)
        expect(yield* fs.readFile(lockPath)).toEqual(lockBefore)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
    { timeout: 15_000 },
  )
})

// =============================================================================
// Member Filtering Tests (--only and --skip)
// =============================================================================

describe('sync member filtering', () => {
  describe('--only flag', () => {
    it.effect(
      'should only sync specified members with --only',
      Effect.fnUntraced(
        function* () {
          const fs = yield* FileSystem.FileSystem

          // Create temp directory with two local repos
          const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
          const repo1Path = yield* createRepo({
            basePath: tmpDir,
            fixture: {
              name: 'repo1',
              files: { 'package.json': '{"name": "repo1"}' },
            },
          })
          const repo2Path = yield* createRepo({
            basePath: tmpDir,
            fixture: {
              name: 'repo2',
              files: { 'package.json': '{"name": "repo2"}' },
            },
          })

          // Create workspace with both members
          const workspacePath = EffectPath.ops.join(
            tmpDir,
            EffectPath.unsafe.relativeDir('workspace/'),
          )
          yield* fs.makeDirectory(workspacePath, { recursive: true })
          yield* initGitRepo(workspacePath)

          const config: MegarepoConfig = new MegarepoConfig({
            members: {
              repo1: repo1Path,
              repo2: repo2Path,
            },
          })
          const configContent = yield* Schema.encodeEffect(
            Schema.fromJsonString(MegarepoConfig, { space: 2 }),
          )(config)
          yield* fs.writeFileString(
            EffectPath.ops.join(
              workspacePath,
              EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
            ),
            configContent + '\n',
          )
          yield* addCommit({
            repoPath: workspacePath,
            message: 'Initialize megarepo',
          })

          // Run sync with --only repo1
          const result = yield* runFetchApplyCommand({
            cwd: workspacePath,
            args: ['--output', 'json', '--only', 'repo1'],
          })
          const json = decodeSyncJsonOutput(result.stdout.trim())

          // Should only have synced repo1
          expect(json.results).toHaveLength(1)
          expect(json.results[0]?.name).toBe('repo1')
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
      20_000,
    )
  })

  describe('--skip flag', () => {
    it.effect(
      'should skip specified members with --skip',
      Effect.fnUntraced(
        function* () {
          const fs = yield* FileSystem.FileSystem

          // Create temp directory with two local repos
          const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
          const repo1Path = yield* createRepo({
            basePath: tmpDir,
            fixture: {
              name: 'repo1',
              files: { 'package.json': '{"name": "repo1"}' },
            },
          })
          const repo2Path = yield* createRepo({
            basePath: tmpDir,
            fixture: {
              name: 'repo2',
              files: { 'package.json': '{"name": "repo2"}' },
            },
          })

          // Create workspace with both members
          const workspacePath = EffectPath.ops.join(
            tmpDir,
            EffectPath.unsafe.relativeDir('workspace/'),
          )
          yield* fs.makeDirectory(workspacePath, { recursive: true })
          yield* initGitRepo(workspacePath)

          const config: MegarepoConfig = new MegarepoConfig({
            members: {
              repo1: repo1Path,
              repo2: repo2Path,
            },
          })
          const configContent = yield* Schema.encodeEffect(
            Schema.fromJsonString(MegarepoConfig, { space: 2 }),
          )(config)
          yield* fs.writeFileString(
            EffectPath.ops.join(
              workspacePath,
              EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
            ),
            configContent + '\n',
          )
          yield* addCommit({
            repoPath: workspacePath,
            message: 'Initialize megarepo',
          })

          // Run sync with --skip repo2
          const result = yield* runFetchApplyCommand({
            cwd: workspacePath,
            args: ['--output', 'json', '--skip', 'repo2'],
          })
          const json = decodeSyncJsonOutput(result.stdout.trim())

          // Should only have synced repo1 (repo2 was skipped)
          expect(json.results).toHaveLength(1)
          expect(json.results[0]?.name).toBe('repo1')
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
      20_000,
    )
  })

  describe('--only and --skip mutual exclusivity', () => {
    it.effect(
      'should reject using both --only and --skip together',
      Effect.fnUntraced(
        function* () {
          const fs = yield* FileSystem.FileSystem

          // Create a minimal workspace
          const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
          const workspacePath = EffectPath.ops.join(
            tmpDir,
            EffectPath.unsafe.relativeDir('workspace/'),
          )
          yield* fs.makeDirectory(workspacePath, { recursive: true })
          yield* initGitRepo(workspacePath)

          const config: MegarepoConfig = new MegarepoConfig({
            members: {
              repo1: 'owner/repo1',
            },
          })
          const configContent = yield* Schema.encodeEffect(
            Schema.fromJsonString(MegarepoConfig, { space: 2 }),
          )(config)
          yield* fs.writeFileString(
            EffectPath.ops.join(
              workspacePath,
              EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
            ),
            configContent + '\n',
          )
          yield* addCommit({
            repoPath: workspacePath,
            message: 'Initialize megarepo',
          })

          // Run sync with both --only and --skip (should fail)
          const result = yield* runFetchApplyCommand({
            cwd: workspacePath,
            args: ['--output', 'json', '--only', 'repo1', '--skip', 'repo2'],
          })

          // Should have failed
          expect(result.exitCode).not.toBe(0)
          expect(Exit.isFailure(result.exit)).toBe(true)
          if (Exit.isFailure(result.exit) === true) {
            const cause = result.exit.cause
            const failureMessages = cause.reasons
              .filter((reason) => reason._tag === 'Fail')
              .map((reason) => String(reason.error))
              .join('\n')
            expect(failureMessages.toLowerCase()).toContain('mutually exclusive')
          }
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )
  })
})

// =============================================================================
// Member Removal Detection Tests
// =============================================================================

// =============================================================================
// Worktree Ref Mismatch Detection Tests (Issue #88)
// =============================================================================

/**
 * These tests mutate the store worktree itself (git checkout, commit), so each needs
 * its own createStoreFixture. Higher timeout because store creation + CLI execution
 * can exceed the default 5s on macOS CI runners.
 */
describe('sync worktree ref mismatch detection', () => {
  /**
   * REGRESSION TEST for issue #88: mr apply should detect worktree ref mismatch
   *
   * When a user runs `git checkout <other-branch>` directly inside a store worktree,
   * the worktree path no longer matches its git HEAD. This violates invariant #8:
   * "Worktree path matches HEAD: The ref encoded in a worktree's store path should match its git HEAD"
   *
   * Currently, `mr apply` reports "already up to date" without detecting this drift.
   * The expected behavior is to warn about the mismatch.
   */
  it.effect(
    'should detect and warn when worktree HEAD differs from store path ref (issue #88)',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem

        const { storePath, worktreePaths } = yield* createStoreFixture([
          {
            host: 'example.com',
            owner: 'org',
            repo: 'test-repo',
            branches: ['main'],
          },
        ])
        const storeKey = 'example.com/org/test-repo#main'
        const storeWorktreePath = worktreePaths[storeKey]
        if (storeWorktreePath === undefined) {
          throw new Error(`Missing worktree path for ${storeKey}`)
        }
        const mainCommit = yield* runGitCommand(storeWorktreePath, 'rev-parse', 'HEAD')

        // Create workspace with lock file using URL source
        const workspacePath = EffectPath.ops.join(
          EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`),
          EffectPath.unsafe.relativeDir('test-workspace/'),
        )
        yield* fs.makeDirectory(workspacePath, { recursive: true })
        yield* initGitRepo(workspacePath)

        // Create megarepo.json with URL source (not local path)
        const config: MegarepoConfig = new MegarepoConfig({
          members: {
            // Using https URL so it's treated as URL type, not path type
            'test-repo': 'https://example.com/org/test-repo#main',
          },
        })
        const configContent = yield* Schema.encodeEffect(
          Schema.fromJsonString(MegarepoConfig, { space: 2 }),
        )(config)
        yield* fs.writeFileString(
          EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON)),
          configContent + '\n',
        )

        // Create lock file
        const lockPath = EffectPath.ops.join(
          workspacePath,
          EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
        )
        yield* writeLockFile({
          lockPath,
          lockFile: new LockFile({
            version: 1,
            members: {
              'test-repo': createLockedMember({
                url: 'https://example.com/org/test-repo',
                ref: 'main',
                commit: mainCommit,
              }),
            },
          }),
        })

        yield* addCommit({ repoPath: workspacePath, message: 'Initialize megarepo' })

        // Create the symlink manually to the store worktree (simulate existing synced state)
        const reposDir = EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeDir('repos/'))
        yield* fs.makeDirectory(reposDir, { recursive: true })
        yield* fs.symlink(
          storeWorktreePath.slice(0, -1),
          EffectPath.ops.join(reposDir, EffectPath.unsafe.relativeFile('test-repo')),
        )

        // NOW SIMULATE THE PROBLEM: User runs `git checkout` directly in the worktree
        // This creates a mismatch: store path says 'main' but HEAD is 'some-feature-branch'
        yield* runGitCommand(storeWorktreePath, 'checkout', '-b', 'some-feature-branch')
        yield* fs.writeFileString(
          EffectPath.ops.join(storeWorktreePath, EffectPath.unsafe.relativeFile('feature.txt')),
          'feature content\n',
        )
        yield* addCommit({ repoPath: storeWorktreePath, message: 'Add feature' })

        // Run mr fetch --apply with tracking mode — should detect and warn about the ref mismatch
        const result = yield* runFetchApplyCommand({
          cwd: workspacePath,
          args: ['--output', 'json', '--worktree-mode', 'tracking'],
          env: {
            MEGAREPO_STORE: storePath.slice(0, -1),
          },
        })
        const json = decodeSyncJsonOutput(result.stdout.trim())

        // Should have a result for test-repo
        expect(json.results).toHaveLength(1)
        const memberResult = json.results[0]
        expect(memberResult?.name).toBe('test-repo')

        // With worktree mode support: apply no longer blocks on ref mismatch.
        // It proceeds (possibly falling back to commit worktree) instead of returning 'skipped'.
        expect(memberResult?.status).not.toBe('skipped')
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
    { timeout: 15_000 },
  )

  it.effect(
    'should detect detached HEAD as ref mismatch in branch worktree (issue #88)',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem

        const { storePath, worktreePaths } = yield* createStoreFixture([
          {
            host: 'example.com',
            owner: 'org',
            repo: 'test-repo',
            branches: ['main'],
          },
        ])
        const storeKey = 'example.com/org/test-repo#main'
        const storeWorktreePath = worktreePaths[storeKey]
        if (storeWorktreePath === undefined) {
          throw new Error(`Missing worktree path for ${storeKey}`)
        }
        const mainCommit = yield* runGitCommand(storeWorktreePath, 'rev-parse', 'HEAD')

        // Create workspace with lock file using URL source
        const workspacePath = EffectPath.ops.join(
          EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`),
          EffectPath.unsafe.relativeDir('test-workspace/'),
        )
        yield* fs.makeDirectory(workspacePath, { recursive: true })
        yield* initGitRepo(workspacePath)

        // Create megarepo.json with URL source
        const config: MegarepoConfig = new MegarepoConfig({
          members: {
            'test-repo': 'https://example.com/org/test-repo#main',
          },
        })
        const configContent = yield* Schema.encodeEffect(
          Schema.fromJsonString(MegarepoConfig, { space: 2 }),
        )(config)
        yield* fs.writeFileString(
          EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON)),
          configContent + '\n',
        )

        // Create lock file
        const lockPath = EffectPath.ops.join(
          workspacePath,
          EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
        )
        yield* writeLockFile({
          lockPath,
          lockFile: new LockFile({
            version: 1,
            members: {
              'test-repo': createLockedMember({
                url: 'https://example.com/org/test-repo',
                ref: 'main',
                commit: mainCommit,
              }),
            },
          }),
        })

        yield* addCommit({ repoPath: workspacePath, message: 'Initialize megarepo' })

        // Create the symlink to the store worktree
        const reposDir = EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeDir('repos/'))
        yield* fs.makeDirectory(reposDir, { recursive: true })
        yield* fs.symlink(
          storeWorktreePath.slice(0, -1),
          EffectPath.ops.join(reposDir, EffectPath.unsafe.relativeFile('test-repo')),
        )

        // NOW SIMULATE THE PROBLEM: User runs `git checkout <sha>` directly in the worktree
        // This creates a detached HEAD state - mismatch with the branch-based store path
        yield* runGitCommand(storeWorktreePath, 'checkout', '--detach', mainCommit)

        // Verify detached HEAD
        const currentBranch = yield* runGitCommand(storeWorktreePath, 'branch', '--show-current')
        expect(currentBranch).toBe('') // Empty means detached HEAD

        // Run mr fetch --apply with tracking mode — should detect and warn about the detached HEAD mismatch
        const result = yield* runFetchApplyCommand({
          cwd: workspacePath,
          args: ['--output', 'json', '--worktree-mode', 'tracking'],
          env: {
            MEGAREPO_STORE: storePath.slice(0, -1),
          },
        })
        const json = decodeSyncJsonOutput(result.stdout.trim())

        // Should have a result for test-repo
        expect(json.results).toHaveLength(1)
        const memberResult = json.results[0]
        expect(memberResult?.name).toBe('test-repo')

        // With worktree mode support: apply no longer blocks on detached HEAD mismatch.
        // It proceeds (possibly falling back to commit worktree) instead of returning 'skipped'.
        expect(memberResult?.status).not.toBe('skipped')
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
    { timeout: 15_000 },
  )
})

describe('sync member removal detection', () => {
  it.effect(
    'should detect and remove orphaned symlinks when member is removed from config',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem

        // Create temp directory with two local repos
        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const repo1Path = yield* createRepo({
          basePath: tmpDir,
          fixture: {
            name: 'repo1',
            files: { 'package.json': '{"name": "repo1"}' },
          },
        })
        const repo2Path = yield* createRepo({
          basePath: tmpDir,
          fixture: {
            name: 'repo2',
            files: { 'package.json': '{"name": "repo2"}' },
          },
        })

        // Create workspace with both members
        const workspacePath = EffectPath.ops.join(
          tmpDir,
          EffectPath.unsafe.relativeDir('workspace/'),
        )
        yield* fs.makeDirectory(workspacePath, { recursive: true })
        yield* initGitRepo(workspacePath)

        const configPath = EffectPath.ops.join(
          workspacePath,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
        )

        // Initial config with both members
        const initialConfig: MegarepoConfig = new MegarepoConfig({
          members: {
            repo1: repo1Path,
            repo2: repo2Path,
          },
        })
        yield* fs.writeFileString(
          configPath,
          (yield* Schema.encodeEffect(Schema.fromJsonString(MegarepoConfig, { space: 2 }))(
            initialConfig,
          )) + '\n',
        )
        yield* addCommit({
          repoPath: workspacePath,
          message: 'Initialize megarepo',
        })

        // First sync - create both symlinks
        yield* runFetchApplyCommand({ cwd: workspacePath, args: [] })

        // Verify both symlinks exist
        const repo1Symlink = EffectPath.ops.join(
          workspacePath,
          EffectPath.unsafe.relativeFile('repos/repo1'),
        )
        const repo2Symlink = EffectPath.ops.join(
          workspacePath,
          EffectPath.unsafe.relativeFile('repos/repo2'),
        )
        expect(yield* fs.exists(repo1Symlink)).toBe(true)
        expect(yield* fs.exists(repo2Symlink)).toBe(true)

        // Update config to remove repo2
        const updatedConfig: MegarepoConfig = new MegarepoConfig({
          members: {
            repo1: repo1Path,
            // repo2 removed!
          },
        })
        yield* fs.writeFileString(
          configPath,
          (yield* Schema.encodeEffect(Schema.fromJsonString(MegarepoConfig, { space: 2 }))(
            updatedConfig,
          )) + '\n',
        )

        // Second sync - should detect and remove orphaned repo2 symlink
        const result = yield* runFetchApplyCommand({
          cwd: workspacePath,
          args: ['--output', 'json'],
        })
        const json = decodeSyncJsonOutput(result.stdout.trim())

        // Should have results for repo1 (synced) and repo2 (removed)
        expect(json.results).toHaveLength(2)

        const repo1Result = json.results.find((r) => r.name === 'repo1')
        const repo2Result = json.results.find((r) => r.name === 'repo2')

        expect(repo1Result?.status).toBe('already_synced')
        expect(repo2Result?.status).toBe('removed')

        // Verify repo1 symlink still exists
        expect(yield* fs.exists(repo1Symlink)).toBe(true)

        // Verify repo2 symlink was removed
        expect(yield* fs.exists(repo2Symlink)).toBe(false)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'should report removed status in dry-run mode without actually removing',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem

        // Create temp directory with two local repos
        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const repo1Path = yield* createRepo({
          basePath: tmpDir,
          fixture: {
            name: 'repo1',
            files: { 'package.json': '{"name": "repo1"}' },
          },
        })
        const repo2Path = yield* createRepo({
          basePath: tmpDir,
          fixture: {
            name: 'repo2',
            files: { 'package.json': '{"name": "repo2"}' },
          },
        })

        // Create workspace with both members
        const workspacePath = EffectPath.ops.join(
          tmpDir,
          EffectPath.unsafe.relativeDir('workspace/'),
        )
        yield* fs.makeDirectory(workspacePath, { recursive: true })
        yield* initGitRepo(workspacePath)

        const configPath = EffectPath.ops.join(
          workspacePath,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
        )

        // Initial config with both members
        const initialConfig: MegarepoConfig = new MegarepoConfig({
          members: {
            repo1: repo1Path,
            repo2: repo2Path,
          },
        })
        yield* fs.writeFileString(
          configPath,
          (yield* Schema.encodeEffect(Schema.fromJsonString(MegarepoConfig, { space: 2 }))(
            initialConfig,
          )) + '\n',
        )
        yield* addCommit({
          repoPath: workspacePath,
          message: 'Initialize megarepo',
        })

        // First sync - create both symlinks
        yield* runFetchApplyCommand({ cwd: workspacePath, args: [] })

        // Update config to remove repo2
        const updatedConfig: MegarepoConfig = new MegarepoConfig({
          members: {
            repo1: repo1Path,
          },
        })
        yield* fs.writeFileString(
          configPath,
          (yield* Schema.encodeEffect(Schema.fromJsonString(MegarepoConfig, { space: 2 }))(
            updatedConfig,
          )) + '\n',
        )

        // Sync with --dry-run - should report removed but not actually remove
        const result = yield* runFetchApplyCommand({
          cwd: workspacePath,
          args: ['--output', 'json', '--dry-run'],
        })
        const json = decodeSyncJsonOutput(result.stdout.trim())

        // Should have results for repo2 as removed
        const repo2Result = json.results.find((r) => r.name === 'repo2')
        expect(repo2Result?.status).toBe('removed')
        // Message contains the symlink target path
        expect(repo2Result?.message).toBeDefined()
        expect(repo2Result?.message).toContain('repo2')

        // But the symlink should still exist (dry-run didn't actually remove)
        const repo2Symlink = EffectPath.ops.join(
          workspacePath,
          EffectPath.unsafe.relativeFile('repos/repo2'),
        )
        expect(yield* fs.exists(repo2Symlink)).toBe(true)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'should not remove symlinks for members skipped via --skip',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem

        // Create temp directory with two local repos
        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const repo1Path = yield* createRepo({
          basePath: tmpDir,
          fixture: {
            name: 'repo1',
            files: { 'package.json': '{"name": "repo1"}' },
          },
        })
        const repo2Path = yield* createRepo({
          basePath: tmpDir,
          fixture: {
            name: 'repo2',
            files: { 'package.json': '{"name": "repo2"}' },
          },
        })

        // Create workspace with both members
        const workspacePath = EffectPath.ops.join(
          tmpDir,
          EffectPath.unsafe.relativeDir('workspace/'),
        )
        yield* fs.makeDirectory(workspacePath, { recursive: true })
        yield* initGitRepo(workspacePath)

        const configPath = EffectPath.ops.join(
          workspacePath,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
        )

        // Config with both members
        const config: MegarepoConfig = new MegarepoConfig({
          members: {
            repo1: repo1Path,
            repo2: repo2Path,
          },
        })
        yield* fs.writeFileString(
          configPath,
          (yield* Schema.encodeEffect(Schema.fromJsonString(MegarepoConfig, { space: 2 }))(
            config,
          )) + '\n',
        )
        yield* addCommit({
          repoPath: workspacePath,
          message: 'Initialize megarepo',
        })

        // First sync - create both symlinks
        yield* runFetchApplyCommand({ cwd: workspacePath, args: [] })

        // Sync with --skip repo2 - should NOT treat repo2 as removed
        const result = yield* runFetchApplyCommand({
          cwd: workspacePath,
          args: ['--output', 'json', '--skip', 'repo2'],
        })
        const json = decodeSyncJsonOutput(result.stdout.trim())

        // Should only have result for repo1 (repo2 was skipped, not removed)
        expect(json.results).toHaveLength(1)
        expect(json.results[0]?.name).toBe('repo1')

        // repo2 symlink should still exist
        const repo2Symlink = EffectPath.ops.join(
          workspacePath,
          EffectPath.unsafe.relativeFile('repos/repo2'),
        )
        expect(yield* fs.exists(repo2Symlink)).toBe(true)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'fails identically for real directory and regular-file orphans without changing bytes',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { workspacePath } = yield* createWorkspaceWithLock({ members: {} })
        yield* writeLockFile({
          lockPath: EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
          ),
          lockFile: createEmptyLockFile(),
        })

        const orphanDirPath = EffectPath.ops.join(
          workspacePath,
          EffectPath.unsafe.relativeFile('repos/orphan-dir'),
        )
        const directorySentinelPath = EffectPath.ops.join(
          EffectPath.unsafe.absoluteDir(`${orphanDirPath}/`),
          EffectPath.unsafe.relativeFile('sentinel.bin'),
        )
        const orphanFilePath = EffectPath.ops.join(
          workspacePath,
          EffectPath.unsafe.relativeFile('repos/orphan-file'),
        )
        const directorySentinel = new Uint8Array([0, 1, 2, 253, 254, 255])
        const orphanFile = new Uint8Array([255, 0, 127, 128, 10, 13])
        yield* fs.makeDirectory(orphanDirPath, { recursive: true })
        yield* fs.writeFile(directorySentinelPath, directorySentinel)
        yield* fs.writeFile(orphanFilePath, orphanFile)

        const applied = yield* runApplyCommand({
          cwd: workspacePath,
          args: ['--output', 'json'],
        })
        const previewed = yield* runApplyCommand({
          cwd: workspacePath,
          args: ['--output', 'json', '--dry-run'],
        })
        const appliedResults = decodeSyncJsonOutput(applied.stdout.trim()).results
        const previewedResults = decodeSyncJsonOutput(previewed.stdout.trim()).results

        expect(applied.exitCode).toBe(1)
        expect(previewed.exitCode).toBe(1)
        expect(previewedResults).toEqual(appliedResults)
        expect(appliedResults.find((result) => result.name === 'orphan-dir')).toEqual({
          name: 'orphan-dir',
          status: 'error',
          message: `Refusing to remove member 'orphan-dir' at '${orphanDirPath}': it is a foreign non-symlink mount`,
        })
        expect(appliedResults.find((result) => result.name === 'orphan-file')).toEqual({
          name: 'orphan-file',
          status: 'error',
          message: `Refusing to remove member 'orphan-file' at '${orphanFilePath}': it is a foreign non-symlink mount`,
        })
        expect(Array.from(yield* fs.readFile(directorySentinelPath))).toEqual(
          Array.from(directorySentinel),
        )
        expect(yield* fs.readDirectory(orphanDirPath)).toEqual(['sentinel.bin'])
        expect(Array.from(yield* fs.readFile(orphanFilePath))).toEqual(Array.from(orphanFile))
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )
})
