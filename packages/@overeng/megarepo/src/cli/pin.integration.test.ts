/**
 * Pin Command Integration Tests
 *
 * Tests for the `mr config pin` command logic, including the -c flag for switching refs.
 * Pure update tests exercise helpers directly; mount-guard tests run the real CLI command.
 */

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Cause, Effect, Exit, Option, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as Cli from 'effect/unstable/cli'
import { expect } from 'vitest'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import { composedWorkspacePathsFromRegistration } from '../composition/acquisition/owned-worktree-acquisition.ts'
import {
  buildSourceStringWithRef,
  CompositionGeneratorConfig,
  CONFIG_FILE_NAME_JSON,
  MegarepoConfig,
  parseSourceString,
} from '../core/config.ts'
import {
  createLockedMember,
  LOCK_FILE_NAME,
  readLockFile,
  updateLockedMember,
  writeLockFile,
  LockFile,
} from '../core/lock.ts'
import { classifyRef } from '../core/ref.ts'
import { makeConsoleCapture } from '../test-utils/consoleCapture.ts'
import { addCommit, initGitRepo, readConfig } from '../test-utils/setup.ts'
import { makeCanonicalTempDirectoryScoped } from '../test-utils/temp-root.ts'
import { mrCommand } from './mod.ts'

/**
 * Create a minimal test setup for pin command testing.
 */
const createMinimalTestSetup = ({ composition = false }: { composition?: boolean } = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    // Create temp directory structure
    const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* makeCanonicalTempDirectoryScoped()}/`)
    const workspacePath = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('workspace/'))

    yield* fs.makeDirectory(workspacePath, { recursive: true })

    // Initialize workspace as git repo
    yield* initGitRepo(workspacePath)

    // Create megarepo.json
    const config: MegarepoConfig = new MegarepoConfig({
      members: {
        'test-repo': 'test-owner/test-repo',
      },
      ...(composition === true
        ? {
            generators: {
              composition: new CompositionGeneratorConfig({
                enabled: true,
                platformHub: 'hub',
              }),
            },
          }
        : {}),
    })
    const configContent = yield* Schema.encodeEffect(
      Schema.fromJsonString(MegarepoConfig, { space: 2 }),
    )(config)
    yield* fs.writeFileString(
      EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeFile('megarepo.json')),
      configContent + '\n',
    )
    yield* addCommit({ repoPath: workspacePath, message: 'Initialize megarepo' })

    return {
      tmpDir,
      workspacePath,
    }
  })

const runConfigCommand = ({ cwd, args }: { cwd: AbsoluteDirPath; args: ReadonlyArray<string> }) =>
  Effect.gen(function* () {
    const { consoleLayer, getStdoutLines, getStderrLines } = yield* makeConsoleCapture
    const exit = yield* Cli.Command.runWith(mrCommand, { version: 'test' })([
      '--cwd',
      cwd,
      'config',
      ...args,
    ]).pipe(Effect.provide(consoleLayer), Effect.exit)
    return {
      exit,
      stdout: (yield* getStdoutLines).join('\n'),
      stderr: (yield* getStderrLines).join('\n'),
    }
  }).pipe(Effect.scoped)

const verifyForeignMountGuard = ({
  args,
  pinned,
  mountKind,
}: {
  args: ReadonlyArray<string>
  pinned: boolean
  mountKind: 'directory' | 'file'
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const { workspacePath } = yield* createMinimalTestSetup()
    const configPath = EffectPath.ops.join(
      workspacePath,
      EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
    )
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
            url: 'https://github.com/test-owner/test-repo',
            ref: 'main',
            commit: 'abc123def456789012345678901234567890abcd',
            pinned,
          }),
        },
      }),
    })

    const memberPath = EffectPath.ops.join(
      workspacePath,
      EffectPath.unsafe.relativeFile('repos/test-repo'),
    )
    const sentinelPath =
      mountKind === 'directory'
        ? EffectPath.ops.join(
            EffectPath.unsafe.absoluteDir(`${memberPath}/`),
            EffectPath.unsafe.relativeFile('sentinel.bin'),
          )
        : memberPath
    const sentinel = new Uint8Array([0, 255, 34, 128, 10, 0])
    if (mountKind === 'directory') {
      yield* fs.makeDirectory(memberPath, { recursive: true })
    } else {
      const membersRoot = EffectPath.ops.parent(memberPath)
      if (membersRoot !== undefined) yield* fs.makeDirectory(membersRoot, { recursive: true })
    }
    yield* fs.writeFile(sentinelPath, sentinel)
    const configBefore = yield* fs.readFile(configPath)
    const lockBefore = yield* fs.readFile(lockPath)

    const result = yield* runConfigCommand({ cwd: workspacePath, args })
    const operation = args[0] === 'unpin' ? 'unpin' : 'pin'
    const expectedMessage = `Refusing to ${operation} member 'test-repo' at '${memberPath}': it is a foreign non-symlink mount`
    const failure = Exit.isFailure(result.exit) === true ? Cause.pretty(result.exit.cause) : ''

    expect(Exit.isFailure(result.exit)).toBe(true)
    expect(`${result.stdout}\n${result.stderr}\n${failure}`).toContain(expectedMessage)
    expect(Array.from(yield* fs.readFile(sentinelPath))).toEqual(Array.from(sentinel))
    if (mountKind === 'directory') {
      expect(yield* fs.readDirectory(memberPath)).toEqual(['sentinel.bin'])
    }
    expect(yield* fs.readFile(configPath)).toEqual(configBefore)
    expect(yield* fs.readFile(lockPath)).toEqual(lockBefore)
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

describe('mr config pin', () => {
  describe('foreign member mount guard', () => {
    it.effect(
      'refuses pin before changing the lock or a foreign directory mount',
      () =>
        verifyForeignMountGuard({
          args: ['pin', 'test-repo', '--output', 'json'],
          pinned: false,
          mountKind: 'directory',
        }),
      { timeout: 15_000 },
    )

    it.effect(
      'refuses dry-run pin -c before changing config, lock, or a foreign file mount',
      () =>
        verifyForeignMountGuard({
          args: ['pin', 'test-repo', '-c', 'feature', '--dry-run', '--output', 'json'],
          pinned: false,
          mountKind: 'file',
        }),
      { timeout: 15_000 },
    )

    it.effect(
      'refuses unpin before changing the lock or a foreign directory mount',
      () =>
        verifyForeignMountGuard({
          args: ['unpin', 'test-repo', '--output', 'json'],
          pinned: true,
          mountKind: 'directory',
        }),
      { timeout: 15_000 },
    )
  })

  it.effect(
    'refuses a legacy composed root before changing config or lock for pin -c',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const { workspacePath } = yield* createMinimalTestSetup({ composition: true })
        const configPath = EffectPath.ops.join(
          workspacePath,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
        )
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
                url: 'https://github.com/test-owner/test-repo',
                ref: 'main',
                commit: 'abc123def456789012345678901234567890abcd',
                pinned: false,
              }),
            },
          }),
        })
        const configBefore = yield* fs.readFile(configPath)
        const lockBefore = yield* fs.readFile(lockPath)

        const result = yield* runConfigCommand({
          cwd: workspacePath,
          args: ['pin', 'test-repo', '-c', 'feature', '--output', 'json'],
        })
        const failure = Exit.isFailure(result.exit) === true ? Cause.pretty(result.exit.cause) : ''

        expect(Exit.isFailure(result.exit)).toBe(true)
        expect(`${result.stdout}\n${result.stderr}\n${failure}`).toContain(
          "Recreate it with 'mr store worktree new'",
        )
        expect(yield* fs.readFile(configPath)).toEqual(configBefore)
        expect(yield* fs.readFile(lockPath)).toEqual(lockBefore)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
    { timeout: 15_000 },
  )

  describe('config update logic', () => {
    it.effect(
      'should update megarepo.json when switching refs',
      Effect.fnUntraced(
        function* () {
          const fs = yield* FileSystem.FileSystem
          const { workspacePath } = yield* createMinimalTestSetup()

          // Read initial config
          const initialConfig = yield* readConfig(workspacePath)
          expect(initialConfig.members['test-repo']).toBe('test-owner/test-repo')

          // Simulate what pin -c does: update the config
          const newRef = 'feature-branch'
          const oldSourceString = initialConfig.members['test-repo']!
          const newSourceString = buildSourceStringWithRef({
            sourceString: oldSourceString,
            newRef,
          })

          const updatedConfig = new MegarepoConfig({
            ...initialConfig,
            members: {
              ...initialConfig.members,
              'test-repo': newSourceString,
            },
          })

          // Write updated config
          const configPath = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
          )
          const newConfigContent = yield* Schema.encodeEffect(
            Schema.fromJsonString(MegarepoConfig, { space: 2 }),
          )(updatedConfig)
          yield* fs.writeFileString(configPath, newConfigContent + '\n')

          // Verify the update
          const finalConfig = yield* readConfig(workspacePath)
          expect(finalConfig.members['test-repo']).toBe('test-owner/test-repo#feature-branch')
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )

    it.effect(
      'should replace existing ref when switching',
      Effect.fnUntraced(
        function* () {
          const fs = yield* FileSystem.FileSystem
          const { workspacePath } = yield* createMinimalTestSetup()

          // First update to feature-branch
          const configPath = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
          )

          const config1: MegarepoConfig = new MegarepoConfig({
            members: {
              'test-repo': 'test-owner/test-repo#feature-branch',
            },
          })
          yield* fs.writeFileString(
            configPath,
            (yield* Schema.encodeEffect(Schema.fromJsonString(MegarepoConfig, { space: 2 }))(
              config1,
            )) + '\n',
          )

          // Now switch to main
          const newSourceString = buildSourceStringWithRef({
            sourceString: config1.members['test-repo']!,
            newRef: 'main',
          })
          expect(newSourceString).toBe('test-owner/test-repo#main')

          // Verify the source was updated correctly (replaced, not appended)
          const source = parseSourceString(newSourceString)
          expect(source?.type).toBe('github')
          if (source?.type === 'github') {
            expect(Option.getOrNull(source.ref)).toBe('main')
          }
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )
  })

  describe('lock file update logic', () => {
    it.effect(
      'should create lock entry with pinned=true when using -c',
      Effect.fnUntraced(
        function* () {
          const { workspacePath } = yield* createMinimalTestSetup()

          const lockPath = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
          )

          // Simulate what pin -c does: create/update lock file
          const newRef = 'feature-branch'
          const commit = 'abc123def456789012345678901234567890abcd'

          const lockFile: LockFile = new LockFile({ version: 1, members: {} })

          const updatedLockFile = updateLockedMember({
            lockFile,
            memberName: 'test-repo',
            member: createLockedMember({
              url: 'https://github.com/test-owner/test-repo',
              ref: newRef,
              commit,
              pinned: true,
            }),
          })

          yield* writeLockFile({ lockPath, lockFile: updatedLockFile })

          // Read and verify
          const savedLockFile = yield* readLockFile(lockPath)
          expect(Option.isSome(savedLockFile)).toBe(true)
          if (Option.isSome(savedLockFile) === true) {
            const member = savedLockFile.value.members['test-repo']
            expect(member?.ref).toBe('feature-branch')
            expect(member?.commit).toBe(commit)
            expect(member?.pinned).toBe(true)
          }
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )

    it.effect(
      'should update existing lock entry when switching refs',
      Effect.fnUntraced(
        function* () {
          const { workspacePath } = yield* createMinimalTestSetup()

          const lockPath = EffectPath.ops.join(
            workspacePath,
            EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
          )

          // Create initial lock file
          const initialCommit = 'abc123def456789012345678901234567890abcd'
          const initialLockFile: LockFile = new LockFile({
            version: 1,
            members: {
              'test-repo': createLockedMember({
                url: 'https://github.com/test-owner/test-repo',
                ref: 'main',
                commit: initialCommit,
                pinned: false,
              }),
            },
          })
          yield* writeLockFile({ lockPath, lockFile: initialLockFile })

          // Switch to feature branch
          const newCommit = 'def456abc789012345678901234567890abcdef12'
          const updatedLockFile = updateLockedMember({
            lockFile: initialLockFile,
            memberName: 'test-repo',
            member: createLockedMember({
              url: 'https://github.com/test-owner/test-repo',
              ref: 'feature-branch',
              commit: newCommit,
              pinned: true,
            }),
          })
          yield* writeLockFile({ lockPath, lockFile: updatedLockFile })

          // Verify update
          const savedLockFile = yield* readLockFile(lockPath)
          expect(Option.isSome(savedLockFile)).toBe(true)
          if (Option.isSome(savedLockFile) === true) {
            const member = savedLockFile.value.members['test-repo']
            expect(member?.ref).toBe('feature-branch')
            expect(member?.commit).toBe(newCommit)
            expect(member?.pinned).toBe(true)
          }
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )
  })

  describe('ref classification for worktree paths', () => {
    it('should classify branches correctly', () => {
      expect(classifyRef('main')).toBe('branch')
      expect(classifyRef('feature/foo')).toBe('branch')
      expect(classifyRef('develop')).toBe('branch')
      expect(classifyRef('release-candidate')).toBe('branch')
    })

    it('should classify tags correctly', () => {
      expect(classifyRef('v1.0.0')).toBe('tag')
      expect(classifyRef('v2.0')).toBe('tag')
      expect(classifyRef('1.0.0')).toBe('tag')
      expect(classifyRef('release-v1.0.0')).toBe('tag')
    })

    it('should classify commits correctly', () => {
      expect(classifyRef('abc123def456789012345678901234567890abcd')).toBe('commit')
    })

    it('resolves a composed branch registration to P and W', () => {
      expect(
        composedWorkspacePathsFromRegistration({
          registeredWorktree: '/store/repo/refs/heads/feature/repos/repo',
          expectedWorkspaceRoot: '/store/repo/refs/heads/feature',
        }),
      ).toEqual({
        workspaceRoot: '/store/repo/refs/heads/feature',
        reposPath: '/store/repo/refs/heads/feature/repos',
        ownedWorktree: '/store/repo/refs/heads/feature/repos/repo',
        ownedMember: 'repo',
      })
    })
  })

  describe('source string manipulation', () => {
    it('should build correct source strings for different refs', () => {
      const base = 'test-owner/test-repo'

      expect(buildSourceStringWithRef({ sourceString: base, newRef: 'main' })).toBe(
        'test-owner/test-repo#main',
      )
      expect(buildSourceStringWithRef({ sourceString: base, newRef: 'v1.0.0' })).toBe(
        'test-owner/test-repo#v1.0.0',
      )
      expect(buildSourceStringWithRef({ sourceString: base, newRef: 'feature/foo' })).toBe(
        'test-owner/test-repo#feature/foo',
      )
      expect(
        buildSourceStringWithRef({
          sourceString: base,
          newRef: 'abc123def456789012345678901234567890abcd',
        }),
      ).toBe('test-owner/test-repo#abc123def456789012345678901234567890abcd')
    })

    it('should handle switching from one ref to another', () => {
      const withRef = 'test-owner/test-repo#old-branch'

      expect(buildSourceStringWithRef({ sourceString: withRef, newRef: 'new-branch' })).toBe(
        'test-owner/test-repo#new-branch',
      )
      expect(buildSourceStringWithRef({ sourceString: withRef, newRef: 'v2.0.0' })).toBe(
        'test-owner/test-repo#v2.0.0',
      )
    })
  })
})
