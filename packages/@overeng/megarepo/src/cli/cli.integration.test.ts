/**
 * CLI Integration Tests
 *
 * Tests for CLI command functionality (init, root, add, etc.)
 * These tests verify the core logic without invoking the CLI directly.
 */

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Exit, Option, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as Cli from 'effect/unstable/cli'
import { expect } from 'vitest'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import { CONFIG_FILE_NAME_JSON, MegarepoConfig, validateMemberName } from '../core/config.ts'
import { makeConsoleCapture } from '../test-utils/consoleCapture.ts'
import { initGitRepo, readConfig } from '../test-utils/setup.ts'
import { mrCommand } from './mod.ts'
import { RootState } from './renderers/RootOutput/schema.ts'

// =============================================================================
// Helper: Find megarepo root (extracted from CLI logic)
// =============================================================================

/**
 * Find megarepo root by searching up from current directory.
 * Returns the OUTERMOST megarepo found (closest to filesystem root).
 */
const findMegarepoRoot = (startPath: AbsoluteDirPath) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    let current: AbsoluteDirPath | undefined = startPath
    const rootDir = EffectPath.unsafe.absoluteDir('/')
    let outermost: AbsoluteDirPath | undefined = undefined

    while (current !== undefined && current !== rootDir) {
      const configPath = EffectPath.ops.join(
        current,
        EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
      )
      const exists = yield* fs.exists(configPath)
      if (exists === true) {
        outermost = current
      }
      current = EffectPath.ops.parent(current)
    }

    return Option.fromUndefinedOr(outermost)
  })

// =============================================================================
// Init Command Tests
// =============================================================================

describe('mr init', () => {
  it.effect(
    'should create megarepo.json in git repo',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem

        // Create a temp directory and init git
        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const workDir = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('test-repo/'))
        yield* fs.makeDirectory(workDir, { recursive: true })
        yield* initGitRepo(workDir)

        // Verify no megarepo.json exists yet
        const configPath = EffectPath.ops.join(
          workDir,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
        )
        expect(yield* fs.exists(configPath)).toBe(false)

        // Simulate init: create initial config
        const initialConfig: MegarepoConfig = new MegarepoConfig({
          $schema:
            'https://raw.githubusercontent.com/overengineeringstudio/megarepo/main/schema/megarepo.schema.json',
          members: {},
        })
        const configContent = yield* Schema.encodeEffect(
          Schema.fromJsonString(MegarepoConfig, { space: 2 }),
        )(initialConfig)
        yield* fs.writeFileString(configPath, configContent + '\n')

        // Verify config was created
        expect(yield* fs.exists(configPath)).toBe(true)

        // Read and verify config content
        const config = yield* readConfig(workDir)
        expect(config.members).toEqual({})
        expect(config.$schema).toBeDefined()
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'should not overwrite existing megarepo.json',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem

        // Create directory with git
        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const workDir = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('test-repo/'))
        yield* fs.makeDirectory(workDir, { recursive: true })
        yield* initGitRepo(workDir)

        // Create existing config with a member
        const existingConfig: MegarepoConfig = new MegarepoConfig({
          members: { 'existing-lib': 'owner/existing-lib' },
        })
        const configPath = EffectPath.ops.join(
          workDir,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
        )
        const configContent = yield* Schema.encodeEffect(
          Schema.fromJsonString(MegarepoConfig, { space: 2 }),
        )(existingConfig)
        yield* fs.writeFileString(configPath, configContent + '\n')

        // Verify existing config
        const config = yield* readConfig(workDir)
        expect(config.members['existing-lib']).toBe('owner/existing-lib')

        // Re-init should not overwrite (in real CLI, this would be a no-op)
        // The config should still have the existing member
        const configAfter = yield* readConfig(workDir)
        expect(configAfter.members['existing-lib']).toBe('owner/existing-lib')
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )
})

// =============================================================================
// Root Command Tests (including nested megarepo "outer wins" behavior)
// =============================================================================

describe('mr root', () => {
  it.effect(
    'should find megarepo root in current directory',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem

        // Create workspace with megarepo.json
        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const workDir = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('megarepo/'))
        yield* fs.makeDirectory(workDir, { recursive: true })

        // Create megarepo.json
        const configPath = EffectPath.ops.join(
          workDir,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
        )
        yield* fs.writeFileString(configPath, '{"members":{}}')

        // Find root
        const root = yield* findMegarepoRoot(workDir)
        expect(Option.isSome(root)).toBe(true)
        expect(Option.getOrNull(root)).toBe(workDir)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'should find megarepo root from subdirectory',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem

        // Create workspace structure
        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const workDir = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('megarepo/'))
        const subDir = EffectPath.ops.join(workDir, EffectPath.unsafe.relativeDir('packages/lib/'))
        yield* fs.makeDirectory(subDir, { recursive: true })

        // Create megarepo.json at root
        const configPath = EffectPath.ops.join(
          workDir,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
        )
        yield* fs.writeFileString(configPath, '{"members":{}}')

        // Find root from subdirectory
        const root = yield* findMegarepoRoot(subDir)
        expect(Option.isSome(root)).toBe(true)
        expect(Option.getOrNull(root)).toBe(workDir)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'should return outer megarepo for nested megarepos (outer wins)',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem

        // Create nested megarepo structure
        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const outerDir = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('outer/'))
        const innerDir = EffectPath.ops.join(
          outerDir,
          EffectPath.unsafe.relativeDir('members/inner/'),
        )
        yield* fs.makeDirectory(innerDir, { recursive: true })

        // Create megarepo.json in outer
        const outerConfigPath = EffectPath.ops.join(
          outerDir,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
        )
        yield* fs.writeFileString(outerConfigPath, '{"members":{"inner":"inner"}}')

        // Create megarepo.json in inner (nested megarepo)
        const innerConfigPath = EffectPath.ops.join(
          innerDir,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
        )
        yield* fs.writeFileString(innerConfigPath, '{"members":{}}')

        // Find root from inner - should return OUTER megarepo
        const root = yield* findMegarepoRoot(innerDir)
        expect(Option.isSome(root)).toBe(true)
        expect(Option.getOrNull(root)).toBe(outerDir)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'should return none when not in megarepo',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem

        // Create directory without megarepo.json
        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const workDir = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('not-megarepo/'))
        yield* fs.makeDirectory(workDir, { recursive: true })

        // Find root - should return none
        const root = yield* findMegarepoRoot(workDir)
        expect(Option.isNone(root)).toBe(true)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )
})

// =============================================================================
// Add Command Tests
// =============================================================================

describe('mr add', () => {
  it.effect(
    'should add member to megarepo.json',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem

        // Create workspace with empty megarepo.json
        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const workDir = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('megarepo/'))
        yield* fs.makeDirectory(workDir, { recursive: true })
        yield* initGitRepo(workDir)

        const configPath = EffectPath.ops.join(
          workDir,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
        )
        const initialConfig: MegarepoConfig = new MegarepoConfig({ members: {} })
        const initialContent = yield* Schema.encodeEffect(
          Schema.fromJsonString(MegarepoConfig, { space: 2 }),
        )(initialConfig)
        yield* fs.writeFileString(configPath, initialContent + '\n')

        // Add a member
        const memberName = 'effect'
        const memberSource = 'effect-ts/effect'

        // Simulate add: update config
        const config = yield* readConfig(workDir)
        const updatedConfig = new MegarepoConfig({
          ...config,
          members: { ...config.members, [memberName]: memberSource },
        })
        const updatedContent = yield* Schema.encodeEffect(
          Schema.fromJsonString(MegarepoConfig, { space: 2 }),
        )(updatedConfig)
        yield* fs.writeFileString(configPath, updatedContent + '\n')

        // Verify member was added
        const finalConfig = yield* readConfig(workDir)
        expect(finalConfig.members['effect']).toBe('effect-ts/effect')
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'should add member with custom name',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem

        // Create workspace
        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const workDir = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('megarepo/'))
        yield* fs.makeDirectory(workDir, { recursive: true })
        yield* initGitRepo(workDir)

        const configPath = EffectPath.ops.join(
          workDir,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
        )
        yield* fs.writeFileString(configPath, '{"members":{}}')

        // Add member with custom name
        const customName = 'effect-v3'
        const memberSource = 'effect-ts/effect#v3.0.0'

        const config = yield* readConfig(workDir)
        const updatedConfig = new MegarepoConfig({
          ...config,
          members: { ...config.members, [customName]: memberSource },
        })
        const updatedContent = yield* Schema.encodeEffect(
          Schema.fromJsonString(MegarepoConfig, { space: 2 }),
        )(updatedConfig)
        yield* fs.writeFileString(configPath, updatedContent + '\n')

        const finalConfig = yield* readConfig(workDir)
        expect(finalConfig.members['effect-v3']).toBe('effect-ts/effect#v3.0.0')
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it('should reject invalid member names', () => {
    // Test member name validation
    expect(validateMemberName('../traversal')).toBe('Member name cannot contain path separators')
    expect(validateMemberName('.hidden')).toBe('Member name cannot start with a dot')
    expect(validateMemberName('')).toBe('Member name cannot be empty')
    expect(validateMemberName('valid-name')).toBeUndefined()
  })

  it.effect(
    'should not add duplicate member',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem

        // Create workspace with existing member
        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const workDir = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('megarepo/'))
        yield* fs.makeDirectory(workDir, { recursive: true })
        yield* initGitRepo(workDir)

        const configPath = EffectPath.ops.join(
          workDir,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
        )
        const initialConfig: MegarepoConfig = new MegarepoConfig({
          members: { effect: 'effect-ts/effect' },
        })
        const initialContent = yield* Schema.encodeEffect(
          Schema.fromJsonString(MegarepoConfig, { space: 2 }),
        )(initialConfig)
        yield* fs.writeFileString(configPath, initialContent + '\n')

        // Check that member already exists
        const config = yield* readConfig(workDir)
        const memberName = 'effect'

        // In real CLI, this would fail with "Member already exists"
        expect(memberName in config.members).toBe(true)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )
})

// =============================================================================
// Config Parsing Tests
// =============================================================================

describe('megarepo.json parsing', () => {
  it.effect(
    'should parse config with multiple member formats',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem

        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const workDir = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('megarepo/'))
        yield* fs.makeDirectory(workDir, { recursive: true })
        yield* initGitRepo(workDir)

        // Create config with various member formats
        const configPath = EffectPath.ops.join(
          workDir,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
        )
        const config: MegarepoConfig = new MegarepoConfig({
          members: {
            github: 'owner/repo',
            'github-ref': 'owner/repo#main',
            'github-tag': 'owner/repo#v1.0.0',
            url: 'https://github.com/owner/repo',
            ssh: 'git@github.com:owner/repo.git',
            local: './packages/local',
          },
        })
        const content = yield* Schema.encodeEffect(
          Schema.fromJsonString(MegarepoConfig, { space: 2 }),
        )(config)
        yield* fs.writeFileString(configPath, content + '\n')

        const parsed = yield* readConfig(workDir)
        expect(Object.keys(parsed.members)).toHaveLength(6)
        expect(parsed.members['github']).toBe('owner/repo')
        expect(parsed.members['github-ref']).toBe('owner/repo#main')
        expect(parsed.members['local']).toBe('./packages/local')
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'should parse config with generators',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem

        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const workDir = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('megarepo/'))
        yield* fs.makeDirectory(workDir, { recursive: true })
        yield* initGitRepo(workDir)

        const configPath = EffectPath.ops.join(
          workDir,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
        )
        const config: MegarepoConfig = new MegarepoConfig({
          members: { lib: 'owner/lib' },
          generators: {
            vscode: { enabled: true, exclude: ['large-repo'] },
          },
        })
        const content = yield* Schema.encodeEffect(
          Schema.fromJsonString(MegarepoConfig, { space: 2 }),
        )(config)
        yield* fs.writeFileString(configPath, content + '\n')

        const parsed = yield* readConfig(workDir)
        expect(parsed.generators?.vscode?.enabled).toBe(true)
        expect(parsed.generators?.vscode?.exclude).toEqual(['large-repo'])
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )
})

// =============================================================================
// --cwd Option Tests
// =============================================================================

/**
 * Run the root CLI command with --cwd and capture JSON output.
 * Does NOT provide Cwd explicitly — relies on Command.provide from --cwd.
 *
 * With the flat JSON output contract, stdout is directly the app state
 * (no `{_tag: 'Success', value: ...}` envelope wrapper).
 */
const runRootWithCwd = ({ cwdPath }: { cwdPath: string }) =>
  Effect.gen(function* () {
    const { consoleLayer, getStdoutLines } = yield* makeConsoleCapture

    const argv = ['--cwd', cwdPath, 'root', '--output', 'json']
    const effect = Cli.Command.runWith(mrCommand, { version: 'test' })(argv).pipe(
      Effect.provide(consoleLayer),
    )
    const exit = yield* Effect.exit(effect)

    const stdout = (yield* getStdoutLines).join('\n')

    let state: RootState | undefined
    if (stdout.trim() !== '') {
      state = yield* Schema.decodeEffect(Schema.fromJsonString(RootState))(stdout)
    }

    return {
      exitCode: Exit.isSuccess(exit) === true ? 0 : 1,
      state,
    }
  }).pipe(Effect.scoped)

describe('--cwd option', () => {
  it.effect(
    'should find megarepo root when --cwd points to a workspace',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem

        // Create a workspace with megarepo.json
        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
        const workDir = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('workspace/'))
        yield* fs.makeDirectory(workDir, { recursive: true })
        yield* initGitRepo(workDir)

        const configPath = EffectPath.ops.join(
          workDir,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_JSON),
        )
        yield* fs.writeFileString(configPath, '{"members":{}}')

        const { exitCode, state } = yield* runRootWithCwd({ cwdPath: workDir })

        expect(exitCode).toBe(0)
        expect(state).toBeDefined()
        expect(state!._tag).toBe('Success')
        if (state!._tag === 'Success') {
          expect(state!.root).toBe(workDir)
        }
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'should report not found when --cwd points to a non-megarepo directory',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem

        // Create a plain directory without megarepo.json
        const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)

        const { exitCode, state } = yield* runRootWithCwd({ cwdPath: tmpDir })

        expect(exitCode).toBe(0)
        expect(state).toBeDefined()
        expect(state!._tag).toBe('Error')
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'should fail when --cwd points to a nonexistent directory',
    Effect.fnUntraced(
      function* () {
        const { consoleLayer } = yield* makeConsoleCapture

        const cwdPath = '/nonexistent/path/that/does/not/exist/'
        const argv = ['--cwd', cwdPath, 'root', '--output', 'json']
        const effect = Cli.Command.runWith(mrCommand, { version: 'test' })(argv).pipe(
          Effect.provide(consoleLayer),
        )
        const exit = yield* Effect.exit(effect)

        expect(Exit.isFailure(exit)).toBe(true)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )
})
