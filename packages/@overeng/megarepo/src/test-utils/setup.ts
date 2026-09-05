/**
 * Test Fixtures and Setup Utilities
 *
 * Provides helpers for creating test workspaces, git repos, and megarepo configs.
 */

import os from 'node:os'

import { Effect, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as Command from 'effect/unstable/process/ChildProcess'
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import { MegarepoConfig } from '../core/config.ts'
import { requireTool } from './require-tool.ts'

// =============================================================================
// Types
// =============================================================================

/** Configuration for a test git repository */
export interface RepoFixture {
  /** Repository name (used as directory name) */
  readonly name: string
  /** Initial files to create (relative path -> content) */
  readonly files?: Record<string, string>
  /** Whether to leave uncommitted changes */
  readonly dirty?: boolean
  /** Remote URL to set (optional) */
  readonly remote?: string
}

/** Configuration for a test megarepo workspace */
export interface WorkspaceFixture {
  /** Name for the workspace directory */
  readonly name?: string
  /** Members to add to megarepo.json (member name -> source string) */
  readonly members?: Record<string, string>
  /** Repos to create and symlink */
  readonly repos?: ReadonlyArray<RepoFixture>
}

/** Result of creating a workspace fixture */
export interface WorkspaceResult {
  /** Path to the workspace directory */
  readonly workspacePath: AbsoluteDirPath
  /** Path to each repo by name */
  readonly repoPaths: Record<string, AbsoluteDirPath>
}

// =============================================================================
// Git Helpers
// =============================================================================

/** Run a git command in a specific directory */
export const runGitCommand = (cwd: AbsoluteDirPath, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const result = yield* ChildProcessSpawner.use((spawner) =>
      spawner.string(Command.make(requireTool('GIT_BIN'), args, { cwd })),
    )
    return result.trim()
  })

/** Initialize a new git repository (writes user config directly to avoid extra process spawns) */
export const initGitRepo = (path: AbsoluteDirPath) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* runGitCommand(path, 'init')
    const configPath = EffectPath.ops.join(path, EffectPath.unsafe.relativeFile('.git/config'))
    const existing = yield* fs.readFileString(configPath)
    yield* fs.writeFileString(
      configPath,
      `${existing}[user]\n\temail = test@example.com\n\tname = Test User\n[commit]\n\tgpgsign = false\n`,
    )
  })

/** Add files and create a commit */
export const addCommit = ({
  repoPath,
  message,
  filename,
}: {
  repoPath: AbsoluteDirPath
  message: string
  filename?: string
}) =>
  Effect.gen(function* () {
    if (filename !== undefined) {
      yield* runGitCommand(repoPath, 'add', filename)
    } else {
      yield* runGitCommand(repoPath, 'add', '-A')
    }
    yield* runGitCommand(repoPath, 'commit', '--no-verify', '-m', message)
  })

/** Get the current HEAD commit hash */
export const getGitRev = (repoPath: AbsoluteDirPath) => runGitCommand(repoPath, 'rev-parse', 'HEAD')

/** Get the short HEAD commit hash */
export const getGitRevShort = (repoPath: AbsoluteDirPath) =>
  runGitCommand(repoPath, 'rev-parse', '--short', 'HEAD')

// =============================================================================
// Fixture Builders
// =============================================================================

/**
 * Create a bare git repository for testing clone operations.
 * The repo is created in a temp directory and automatically cleaned up.
 */
export const createBareRepo = (name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
    const repoPath = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir(`${name}.git/`))

    yield* fs.makeDirectory(repoPath, { recursive: true })
    yield* runGitCommand(repoPath, 'init', '--bare')

    return repoPath
  })

/**
 * Create a git repository with optional initial content.
 */
export const createRepo = ({
  basePath,
  fixture,
}: {
  basePath: AbsoluteDirPath
  fixture: RepoFixture
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    const repoPath = EffectPath.ops.join(
      basePath,
      EffectPath.unsafe.relativeDir(`${fixture.name}/`),
    )
    yield* fs.makeDirectory(repoPath, { recursive: true })

    // Initialize git
    yield* initGitRepo(repoPath)

    // Set remote if provided
    if (fixture.remote !== undefined) {
      yield* runGitCommand(repoPath, 'remote', 'add', 'origin', fixture.remote)
    }

    // Create initial files
    const files = fixture.files ?? { 'README.md': `# ${fixture.name}\n` }
    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = EffectPath.ops.join(repoPath, EffectPath.unsafe.relativeFile(filePath))
      const dir = EffectPath.ops.parent(fullPath)
      yield* fs.makeDirectory(dir, { recursive: true })
      yield* fs.writeFileString(fullPath, content)
    }

    // Initial commit
    yield* addCommit({ repoPath, message: 'Initial commit' })

    // Add dirty changes if requested
    if (fixture.dirty === true) {
      yield* fs.writeFileString(
        EffectPath.ops.join(repoPath, EffectPath.unsafe.relativeFile('dirty.txt')),
        'uncommitted changes\n',
      )
    }

    return repoPath
  })

/**
 * Create a test megarepo workspace with optional member repos.
 * The workspace is created in a temp directory and automatically cleaned up.
 */
export const createWorkspace = (fixture?: WorkspaceFixture) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    // Create temp directory
    const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
    const workspaceName = fixture?.name ?? 'test-workspace'
    const workspacePath = EffectPath.ops.join(
      tmpDir,
      EffectPath.unsafe.relativeDir(`${workspaceName}/`),
    )

    yield* fs.makeDirectory(workspacePath, { recursive: true })

    // Initialize as git repo
    yield* initGitRepo(workspacePath)

    // Create megarepo.json
    // Effect v4 class schemas require a real instance on the encode side — a
    // plain literal fails `SchemaError: Expected MegarepoConfig`.
    const config = new MegarepoConfig({ members: fixture?.members ?? {} })
    const configContent = yield* Schema.encodeEffect(
      Schema.fromJsonString(MegarepoConfig, { space: 2 }),
    )(config)
    yield* fs.writeFileString(
      EffectPath.ops.join(workspacePath, EffectPath.unsafe.relativeFile('megarepo.json')),
      configContent + '\n',
    )

    // Commit config
    yield* addCommit({
      repoPath: workspacePath,
      message: 'Initialize megarepo',
    })

    // Create repos and symlinks
    const repoPaths: Record<string, AbsoluteDirPath> = {}
    if (fixture?.repos !== undefined) {
      // Create a store directory for repos
      const storePath = EffectPath.ops.join(
        tmpDir,
        EffectPath.unsafe.relativeDir('.megarepo-store/'),
      )
      yield* fs.makeDirectory(storePath, { recursive: true })

      const membersRoot = EffectPath.ops.join(
        workspacePath,
        EffectPath.unsafe.relativeDir('repos/'),
      )
      yield* fs.makeDirectory(membersRoot, { recursive: true })

      for (const repoFixture of fixture.repos) {
        const repoPath = yield* createRepo({
          basePath: storePath,
          fixture: repoFixture,
        })
        repoPaths[repoFixture.name] = repoPath

        // Create symlink in workspace
        // Note: fs.symlink doesn't handle trailing slashes well, so strip them
        const symlinkPath = EffectPath.ops.join(
          membersRoot,
          EffectPath.unsafe.relativeFile(repoFixture.name),
        )
        yield* fs.symlink(repoPath.slice(0, -1), symlinkPath)
      }
    }

    return { workspacePath, repoPaths } satisfies WorkspaceResult
  })

/**
 * Create a megarepo store directory with repos.
 */
export const createStore = (repos: ReadonlyArray<RepoFixture>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
    const storePath = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('.megarepo/'))

    yield* fs.makeDirectory(storePath, { recursive: true })

    const repoPaths: Record<string, AbsoluteDirPath> = {}
    for (const repoFixture of repos) {
      // Create in github.com/test-owner structure
      const repoDir = EffectPath.ops.join(
        storePath,
        EffectPath.unsafe.relativeDir(`github.com/test-owner/${repoFixture.name}/`),
      )
      const parentDir = EffectPath.ops.parent(repoDir)
      if (parentDir === undefined) {
        throw new Error(`Cannot get parent directory of ${repoDir}`)
      }
      yield* fs.makeDirectory(parentDir, { recursive: true })

      const repoPath = yield* createRepo({
        basePath: parentDir,
        fixture: repoFixture,
      })
      repoPaths[repoFixture.name] = repoPath
    }

    return { storePath, repoPaths }
  })

// =============================================================================
// Output Normalization
// =============================================================================

/** Strip ANSI escape codes from output */
export const stripAnsi = (str: string): string =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI codes requires matching control characters
  // eslint-disable-next-line no-control-regex -- stripping ANSI codes requires matching control characters
  str.replace(/\x1B\[[0-9;]*[a-zA-Z]|\x1B\[\?[0-9;]*[a-zA-Z]/g, '')

/** Normalize output for snapshot testing */
export const normalizeOutput = ({
  output,
  workspaceName,
}: {
  output: string
  workspaceName?: string
}): string => {
  let normalized = stripAnsi(output)

  // Replace full git hashes (40 chars)
  normalized = normalized.replace(/[a-f0-9]{40}/g, '<FULL_HASH>')

  // Replace short git hashes (7-8 chars, word boundary)
  normalized = normalized.replace(/\b[a-f0-9]{7,8}\b/g, '<SHORT_HASH>')

  // Replace workspace name if provided
  if (workspaceName !== undefined) {
    normalized = normalized.replace(new RegExp(workspaceName, 'g'), '<WORKSPACE>')
  }

  // Replace temp directory paths
  normalized = normalized.replace(new RegExp(os.tmpdir(), 'g'), '<TMPDIR>')
  normalized = normalized.replace(/\/var\/folders\/[^\s]+/g, '<TMPDIR>')

  return normalized
}

// =============================================================================
// Config Helpers
// =============================================================================

/** Read the megarepo.json config from a workspace */
export const readConfig = (workspacePath: AbsoluteDirPath) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    const configPath = EffectPath.ops.join(
      workspacePath,
      EffectPath.unsafe.relativeFile('megarepo.json'),
    )
    const content = yield* fs.readFileString(configPath)
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(MegarepoConfig))(content)
  })

/** Generate a megarepo.json config object */
export const generateConfig = (members: Record<string, string>): MegarepoConfig => ({
  members,
})
