/**
 * Status Command Integration Tests
 *
 * Tests for the status command JSON output fields:
 * - syncNeeded/syncReasons computation
 * - symlinkExists field
 * - commitDrift field
 */

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Exit, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as Cli from 'effect/unstable/cli'
import { expect } from 'vitest'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import { MegarepoConfig } from '../core/config.ts'
import { createLockedMember, LockFile, LOCK_FILE_NAME, writeLockFile } from '../core/lock.ts'
import { makeConsoleCapture } from '../test-utils/consoleCapture.ts'
import {
  addCommit,
  createRepo,
  getGitRev,
  initGitRepo,
  runGitCommand,
} from '../test-utils/setup.ts'
import { makeCanonicalTempDirectoryScoped } from '../test-utils/temp-root.ts'
import { mrCommand } from './mod.ts'
import { StatusState } from './renderers/StatusOutput/schema.ts'

/**
 * Run the status CLI command and capture JSON output.
 */
const runStatusCommand = ({
  cwd,
  args = [],
}: {
  cwd: AbsoluteDirPath
  args?: ReadonlyArray<string>
}) =>
  Effect.gen(function* () {
    const { consoleLayer, getStdoutLines } = yield* makeConsoleCapture

    const argv = ['--cwd', cwd, 'status', '--output', 'json', ...args]
    const effect = Cli.Command.runWith(mrCommand, { version: 'test' })(argv).pipe(
      Effect.provide(consoleLayer),
    )
    const exit = yield* Effect.exit(effect)

    const stdout = (yield* getStdoutLines).join('\n')

    // Parse JSON output
    let status: StatusState | undefined
    if (stdout.trim() !== '') {
      status = yield* Schema.decodeEffect(Schema.fromJsonString(StatusState))(stdout)
    }

    return {
      stdout,
      exitCode: Exit.isSuccess(exit) === true ? 0 : 1,
      status,
    }
  }).pipe(Effect.scoped)

/**
 * Create a workspace with optional lock file and symlinks.
 */
const createTestWorkspace = (args: {
  members: Record<string, string>
  lockEntries?: Record<string, { url: string; ref: string; commit: string; pinned?: boolean }>
  createSymlinks?: ReadonlyArray<{ name: string; targetPath: string }>
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    // Create temp directory for workspace
    const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* makeCanonicalTempDirectoryScoped()}/`)
    const workspacePath = EffectPath.ops.join(
      tmpDir,
      EffectPath.unsafe.relativeDir('test-workspace/'),
    )
    yield* fs.makeDirectory(workspacePath, { recursive: true })

    // Initialize as git repo
    yield* initGitRepo(workspacePath)

    // Create megarepo.json
    const config: MegarepoConfig = new MegarepoConfig({ members: args.members })
    const configContent = yield* Schema.encodeEffect(
      Schema.fromJsonString(MegarepoConfig, { space: 2 }),
    )(config)
    yield* fs.writeFileString(
      EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeFile('megarepo.json')),
      configContent + '\n',
    )

    // Create lock file if entries provided
    if (args.lockEntries !== undefined && Object.keys(args.lockEntries).length > 0) {
      const members: Record<string, ReturnType<typeof createLockedMember>> = {}

      for (const [name, entry] of Object.entries(args.lockEntries)) {
        members[name] = createLockedMember({
          url: entry.url,
          ref: entry.ref,
          commit: entry.commit,
          ...(entry.pinned !== undefined ? { pinned: entry.pinned } : {}),
        })
      }

      const lockFile: LockFile = new LockFile({ version: 1, members })

      const lockPath = EffectPath.ops.join(
        workspacePath,
        EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
      )
      yield* writeLockFile({ lockPath, lockFile })
    }

    // Create repos directory
    const reposDir = EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeDir('repos/'))
    yield* fs.makeDirectory(reposDir, { recursive: true })

    // Create symlinks if specified
    if (args.createSymlinks !== undefined) {
      for (const { name, targetPath } of args.createSymlinks) {
        const symlinkPath = EffectPath.ops.join(reposDir, EffectPath.unsafe.relativeFile(name))
        yield* fs.symlink(targetPath, symlinkPath)
      }
    }

    // Commit config
    yield* runGitCommand(workspacePath, 'add', '-A')
    yield* runGitCommand(workspacePath, 'commit', '--no-verify', '-m', 'Initialize megarepo')

    return { workspacePath, tmpDir, reposDir }
  })

// =============================================================================
// syncNeeded and syncReasons Tests
// =============================================================================

describe('mr status --output json', () => {
  describe('syncNeeded and syncReasons', () => {
    it.effect(
      'should report syncNeeded=false when workspace is fully synced',
      Effect.fnUntraced(
        function* () {
          // Create a local repo to symlink to
          const tmpDir = EffectPath.unsafe.absoluteDir(
            `${yield* makeCanonicalTempDirectoryScoped()}/`,
          )
          const repoPath = yield* createRepo({
            basePath: tmpDir,
            fixture: { name: 'local-lib' },
          })

          // Create workspace with local member (no lock needed for local members)
          const { workspacePath } = yield* createTestWorkspace({
            members: { 'local-lib': repoPath },
            createSymlinks: [{ name: 'local-lib', targetPath: repoPath.slice(0, -1) }],
          })

          const { status, exitCode } = yield* runStatusCommand({ cwd: workspacePath })

          expect(exitCode).toBe(0)
          expect(status).toBeDefined()
          expect(status!.syncNeeded).toBe(false)
          expect(status!.syncReasons).toEqual([])
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )

    it.effect(
      'should report syncNeeded=true when symlink is missing',
      Effect.fnUntraced(
        function* () {
          // Create workspace with remote member but no symlink
          const { workspacePath } = yield* createTestWorkspace({
            members: { effect: 'effect-ts/effect' },
            lockEntries: {
              effect: {
                url: 'https://github.com/effect-ts/effect',
                ref: 'main',
                commit: 'a'.repeat(40),
              },
            },
            // No symlinks created - this simulates missing sync
          })

          const { status, exitCode } = yield* runStatusCommand({ cwd: workspacePath })

          expect(exitCode).toBe(0)
          expect(status).toBeDefined()
          expect(status!.syncNeeded).toBe(true)
          expect(status!.syncReasons).toContain("Member 'effect' symlink missing")
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )

    it.effect(
      'should report syncNeeded=true when lock file is missing for remote members',
      Effect.fnUntraced(
        function* () {
          // Create workspace with remote member but no lock file
          const { workspacePath } = yield* createTestWorkspace({
            members: { effect: 'effect-ts/effect' },
            // No lock entries - this simulates missing lock
          })

          const { status, exitCode } = yield* runStatusCommand({ cwd: workspacePath })

          expect(exitCode).toBe(0)
          expect(status).toBeDefined()
          expect(status!.syncNeeded).toBe(true)
          expect(status!.syncReasons).toContain('Lock file missing')
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
      { timeout: 20000 },
    )

    it.effect(
      'should report syncNeeded=true when member is not in lock file',
      Effect.fnUntraced(
        function* () {
          // Create workspace with one member in config but lock has different member
          const { workspacePath } = yield* createTestWorkspace({
            members: {
              effect: 'effect-ts/effect',
              'another-lib': 'owner/another-lib',
            },
            lockEntries: {
              // Only 'effect' is in lock, 'another-lib' is missing
              effect: {
                url: 'https://github.com/effect-ts/effect',
                ref: 'main',
                commit: 'a'.repeat(40),
              },
            },
          })

          const { status, exitCode } = yield* runStatusCommand({ cwd: workspacePath })

          expect(exitCode).toBe(0)
          expect(status).toBeDefined()
          expect(status!.syncNeeded).toBe(true)
          expect(status!.syncReasons).toContain("Member 'another-lib' not in lock file")
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )
  })

  // =============================================================================
  // symlinkExists Tests
  // =============================================================================

  describe('symlinkExists field', () => {
    it.effect(
      'should report symlinkExists=true when symlink is present',
      Effect.fnUntraced(
        function* () {
          // Create a local repo
          const tmpDir = EffectPath.unsafe.absoluteDir(
            `${yield* makeCanonicalTempDirectoryScoped()}/`,
          )
          const repoPath = yield* createRepo({
            basePath: tmpDir,
            fixture: { name: 'my-lib' },
          })

          // Create workspace with symlink
          const { workspacePath } = yield* createTestWorkspace({
            members: { 'my-lib': repoPath },
            createSymlinks: [{ name: 'my-lib', targetPath: repoPath.slice(0, -1) }],
          })

          const { status } = yield* runStatusCommand({ cwd: workspacePath })

          expect(status).toBeDefined()
          const member = status!.members.find((m) => m.name === 'my-lib')
          expect(member).toBeDefined()
          expect(member!.symlinkExists).toBe(true)
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )

    it.effect(
      'should report symlinkExists=false when symlink is missing',
      Effect.fnUntraced(
        function* () {
          // Create workspace without symlinks
          const { workspacePath } = yield* createTestWorkspace({
            members: { effect: 'effect-ts/effect' },
            lockEntries: {
              effect: {
                url: 'https://github.com/effect-ts/effect',
                ref: 'main',
                commit: 'a'.repeat(40),
              },
            },
            // No symlinks
          })

          const { status } = yield* runStatusCommand({ cwd: workspacePath })

          expect(status).toBeDefined()
          const member = status!.members.find((m) => m.name === 'effect')
          expect(member).toBeDefined()
          expect(member!.symlinkExists).toBe(false)
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )
  })

  // =============================================================================
  // commitDrift Tests
  // =============================================================================

  describe('commitDrift field', () => {
    it.effect(
      'should report commitDrift when local commit differs from locked commit',
      Effect.fnUntraced(
        function* () {
          // Create a repo that will have a different commit than the lock
          const tmpDir = EffectPath.unsafe.absoluteDir(
            `${yield* makeCanonicalTempDirectoryScoped()}/`,
          )
          const repoPath = yield* createRepo({
            basePath: tmpDir,
            fixture: { name: 'drifted-lib' },
          })

          // Get the actual commit SHA
          const actualCommit = yield* getGitRev(repoPath)

          // Create workspace with lock pointing to a different (fake) commit
          const lockedCommit = 'b'.repeat(40) // Different from actual commit
          const { workspacePath } = yield* createTestWorkspace({
            members: { 'drifted-lib': 'owner/drifted-lib' },
            lockEntries: {
              'drifted-lib': {
                url: 'https://github.com/owner/drifted-lib',
                ref: 'main',
                commit: lockedCommit,
              },
            },
            createSymlinks: [{ name: 'drifted-lib', targetPath: repoPath.slice(0, -1) }],
          })

          const { status } = yield* runStatusCommand({ cwd: workspacePath })

          expect(status).toBeDefined()
          const member = status!.members.find((m) => m.name === 'drifted-lib')
          expect(member).toBeDefined()
          expect(member!.commitDrift).toBeDefined()
          expect(member!.commitDrift!.localCommit).toBe(actualCommit)
          expect(member!.commitDrift!.lockedCommit).toBe(lockedCommit)
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )

    it.effect(
      'should not report commitDrift when commits match',
      Effect.fnUntraced(
        function* () {
          // Create a repo
          const tmpDir = EffectPath.unsafe.absoluteDir(
            `${yield* makeCanonicalTempDirectoryScoped()}/`,
          )
          const repoPath = yield* createRepo({
            basePath: tmpDir,
            fixture: { name: 'synced-lib' },
          })

          // Get the actual commit SHA
          const actualCommit = yield* getGitRev(repoPath)

          // Create workspace with lock pointing to the same commit
          const { workspacePath } = yield* createTestWorkspace({
            members: { 'synced-lib': 'owner/synced-lib' },
            lockEntries: {
              'synced-lib': {
                url: 'https://github.com/owner/synced-lib',
                ref: 'main',
                commit: actualCommit, // Same as actual
              },
            },
            createSymlinks: [{ name: 'synced-lib', targetPath: repoPath.slice(0, -1) }],
          })

          const { status } = yield* runStatusCommand({ cwd: workspacePath })

          expect(status).toBeDefined()
          const member = status!.members.find((m) => m.name === 'synced-lib')
          expect(member).toBeDefined()
          expect(member!.commitDrift).toBeUndefined()
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )

    it.effect(
      'should not report commitDrift for local path members',
      Effect.fnUntraced(
        function* () {
          // Create a local repo
          const tmpDir = EffectPath.unsafe.absoluteDir(
            `${yield* makeCanonicalTempDirectoryScoped()}/`,
          )
          const repoPath = yield* createRepo({
            basePath: tmpDir,
            fixture: { name: 'local-lib' },
          })

          // Create workspace with local path member (uses path, not github shorthand)
          const { workspacePath } = yield* createTestWorkspace({
            members: { 'local-lib': repoPath }, // Path source = local
            // No lock entries for local members
            createSymlinks: [{ name: 'local-lib', targetPath: repoPath.slice(0, -1) }],
          })

          const { status } = yield* runStatusCommand({ cwd: workspacePath })

          expect(status).toBeDefined()
          const member = status!.members.find((m) => m.name === 'local-lib')
          expect(member).toBeDefined()
          expect(member!.isLocal).toBe(true)
          expect(member!.commitDrift).toBeUndefined()
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )
  })

  // =============================================================================
  // Combined scenarios
  // =============================================================================

  describe('combined scenarios', () => {
    it.effect(
      'should correctly report status for mixed local and remote members',
      Effect.fnUntraced(
        function* () {
          // Create a local repo
          const tmpDir = EffectPath.unsafe.absoluteDir(
            `${yield* makeCanonicalTempDirectoryScoped()}/`,
          )
          const localRepoPath = yield* createRepo({
            basePath: tmpDir,
            fixture: { name: 'local-lib' },
          })

          // Create workspace with both local and remote members
          const { workspacePath } = yield* createTestWorkspace({
            members: {
              'local-lib': localRepoPath,
              'remote-lib': 'owner/remote-lib',
            },
            lockEntries: {
              'remote-lib': {
                url: 'https://github.com/owner/remote-lib',
                ref: 'main',
                commit: 'a'.repeat(40),
              },
            },
            // Only local member has symlink - remote is missing
            createSymlinks: [{ name: 'local-lib', targetPath: localRepoPath.slice(0, -1) }],
          })

          const { status } = yield* runStatusCommand({ cwd: workspacePath })

          expect(status).toBeDefined()

          // Local member should be fully synced
          const localMember = status!.members.find((m) => m.name === 'local-lib')
          expect(localMember).toBeDefined()
          expect(localMember!.isLocal).toBe(true)
          expect(localMember!.symlinkExists).toBe(true)
          expect(localMember!.exists).toBe(true)

          // Remote member should be missing symlink
          const remoteMember = status!.members.find((m) => m.name === 'remote-lib')
          expect(remoteMember).toBeDefined()
          expect(remoteMember!.isLocal).toBe(false)
          expect(remoteMember!.symlinkExists).toBe(false)
          expect(remoteMember!.exists).toBe(false)

          // Overall sync needed due to missing remote member
          expect(status!.syncNeeded).toBe(true)
          expect(status!.syncReasons).toContain("Member 'remote-lib' symlink missing")
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )
  })

  describe('--all traversal cycles', () => {
    it.effect(
      'should stop recursive status at repeated real worktree paths',
      Effect.fnUntraced(
        function* () {
          const fs = yield* FileSystem.FileSystem
          const tmpDir = EffectPath.unsafe.absoluteDir(
            `${yield* makeCanonicalTempDirectoryScoped()}/`,
          )
          const workspaceA = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('a/'))
          const workspaceB = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('b/'))

          yield* fs.makeDirectory(workspaceA, { recursive: true })
          yield* fs.makeDirectory(workspaceB, { recursive: true })
          yield* initGitRepo(workspaceA)
          yield* initGitRepo(workspaceB)

          const writeConfig = (workspacePath: AbsoluteDirPath, members: Record<string, string>) =>
            Effect.gen(function* () {
              const configContent = yield* Schema.encodeEffect(
                Schema.fromJsonString(MegarepoConfig, { space: 2 }),
              )(new MegarepoConfig({ members }))
              yield* fs.writeFileString(
                EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeFile('megarepo.json')),
                `${configContent}\n`,
              )
              yield* fs.makeDirectory(
                EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeDir('repos/')),
                { recursive: true },
              )
            })

          yield* writeConfig(workspaceA, { b: workspaceB })
          yield* writeConfig(workspaceB, { a: workspaceA })

          yield* fs.symlink(
            workspaceB.slice(0, -1),
            EffectPath.ops.join(workspaceA, EffectPath.unsafe.relativeFile('repos/b')),
          )
          yield* fs.symlink(
            workspaceA.slice(0, -1),
            EffectPath.ops.join(workspaceB, EffectPath.unsafe.relativeFile('repos/a')),
          )

          yield* addCommit({ repoPath: workspaceA, message: 'Initialize megarepo A' })
          yield* addCommit({ repoPath: workspaceB, message: 'Initialize megarepo B' })

          const { status, exitCode } = yield* runStatusCommand({
            cwd: workspaceA,
            args: ['--all'],
          })

          expect(exitCode).toBe(0)
          expect(status).toBeDefined()
          const memberB = status!.members.find((member) => member.name === 'b')
          expect(memberB?.isMegarepo).toBe(true)
          expect(memberB?.nestedMembers).toHaveLength(1)
          const cycleClosingMember = memberB?.nestedMembers?.[0]
          expect(cycleClosingMember?.name).toBe('a')
          expect(cycleClosingMember?.isMegarepo).toBe(true)
          expect(cycleClosingMember?.nestedMembers).toEqual([])
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )
  })
})
