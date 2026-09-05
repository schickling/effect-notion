import * as crypto from 'node:crypto'
import * as os from 'node:os'
import nodePath from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { Effect, FileSystem, Path, Schema, Stream } from 'effect'
import * as Command from 'effect/unstable/process/ChildProcess'
import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import { GenieApp } from './app.ts'

/** Schema for parsing generated package.json in tests */
const GeneratedPackageJson = Schema.Struct({
  _genieLocation: Schema.optional(Schema.String),
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

const decodeGeneratedPackageJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(GeneratedPackageJson),
)

type TestEnv = {
  root: string
  writeFile: (args: { path: string; content: string }) => Effect.Effect<void, never>
  symlink: (args: { target: string; path: string }) => Effect.Effect<void, never>
  cleanup: () => Effect.Effect<void, never>
}

const TestLayer = NodeServices.layer

const createTestEnv = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = path.join(os.tmpdir(), `genie-cli-test-${crypto.randomBytes(4).toString('hex')}`)

  yield* fs.makeDirectory(root, { recursive: true })

  const writeFile = Effect.fnUntraced(function* ({
    path: relativePath,
    content,
  }: {
    path: string
    content: string
  }) {
    const fullPath = path.join(root, relativePath)
    const dir = path.dirname(fullPath)
    yield* fs.makeDirectory(dir, { recursive: true })
    yield* fs.writeFileString(fullPath, content)
  }, Effect.orDie)

  const symlink = Effect.fnUntraced(function* ({
    target,
    path: relativePath,
  }: {
    target: string
    path: string
  }) {
    const targetPath = path.isAbsolute(target) ? target : path.join(root, target)
    const linkPath = path.isAbsolute(relativePath) ? relativePath : path.join(root, relativePath)
    yield* fs.makeDirectory(path.dirname(linkPath), { recursive: true })
    yield* fs.symlink(targetPath, linkPath)
  }, Effect.orDie)

  const cleanup = () => fs.remove(root, { recursive: true }).pipe(Effect.ignore)

  return { root, writeFile, symlink, cleanup } satisfies TestEnv
})

const decodeChunks = (chunks: ReadonlyArray<Uint8Array>): string => {
  const merged = chunks.reduce((acc, chunk) => {
    const result = new Uint8Array(acc.length + chunk.length)
    result.set(acc)
    result.set(chunk, acc.length)
    return result
  }, new Uint8Array())

  return new TextDecoder().decode(merged)
}

/** Reads one Buck-declared immutable tool path; nothing resolves through an ambient PATH. */
const requireTool = (name: string): string => {
  const tool = process.env[name]
  if (tool === undefined || tool === '')
    throw new Error(`declared test tool is unavailable: ${name}`)
  return tool
}

const bunBin = requireTool('BUN_BIN')
const gitBin = requireTool('GIT_BIN')

const runGenie = Effect.fnUntraced(function* (env: TestEnv, args: ReadonlyArray<string>) {
  const cliPath = new URL('../../bin/genie.tsx', import.meta.url).pathname
  const command = Command.make(bunBin, [cliPath, '--cwd', env.root, ...args], {
    cwd: env.root,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const process = yield* command
  const [stdoutChunks, stderrChunks, exitCode] = yield* Effect.all([
    Stream.runCollect(process.stdout),
    Stream.runCollect(process.stderr),
    process.exitCode,
  ])

  return {
    stdout: decodeChunks(stdoutChunks),
    stderr: decodeChunks(stderrChunks),
    exitCode,
  }
}, Effect.scoped)

Vitest.describe('genie cli', () => {
  const withTestEnv = Effect.fnUntraced(function* <A, E, R>(
    fn: (env: TestEnv) => Effect.Effect<A, E, R>,
  ) {
    const env = yield* createTestEnv()
    try {
      return yield* fn(env)
    } finally {
      yield* env.cleanup()
    }
  })

  Vitest.it.effect(
    'reports import errors with clear error message',
    Effect.fnUntraced(
      function* () {
        yield* withTestEnv((env) =>
          Effect.gen(function* () {
            const packageJsonContent = yield* Schema.encodeEffect(
              Schema.fromJsonString(Schema.Unknown, { space: 2 }),
            )({
              name: 'genie-cli-test',
              private: true,
            })

            yield* env.writeFile({
              path: 'package.json',
              content: packageJsonContent,
            })

            yield* env.writeFile({
              path: 'genie/repo.ts',
              content: `export const pkg = {
  root: (config: unknown) => JSON.stringify(config),
}
`,
            })

            /** Simulate a TDZ-style error (ReferenceError) in the genie file */
            yield* env.writeFile({
              path: 'package.json.genie.ts',
              content: `import { pkg } from './genie/repo.ts'

throw new ReferenceError('Cannot access \\'pkg\\' before initialization')

export default pkg.root({ name: 'genie-cli-test' })
`,
            })

            const { stdout, stderr, exitCode } = yield* runGenie(env, ['--check'])
            const output = `${stdout}\n${stderr}`

            expect(exitCode).not.toBe(0)
            expect(output).toContain('GenieImportError')
            expect(output).toContain('package.json.genie.ts')
            expect(output).toContain('Cannot access')
          }),
        )
      },
      Effect.provide(TestLayer),
      Effect.scoped,
    ),
  )

  Vitest.it.effect(
    'skips symlinked directories that resolve inside the root',
    Effect.fnUntraced(
      function* () {
        yield* withTestEnv((env) =>
          Effect.gen(function* () {
            /**
             * The symlink points back into the same root; we should only process the
             * canonical target once to avoid duplicate generation via the symlinked path.
             */
            yield* env.writeFile({
              path: 'canonical/package.json.genie.ts',
              content: `export default {
  data: { name: 'genie-cli-test', private: true },
  stringify: () => JSON.stringify({ name: 'genie-cli-test', private: true }),
}`,
            })

            yield* env.symlink({ target: 'canonical', path: 'link' })

            const { stdout, stderr, exitCode } = yield* runGenie(env, ['--dry-run'])
            const output = `${stdout}\n${stderr}`
            const canonicalOutput = nodePath.join(env.root, 'canonical', 'package.json')
            const linkOutput = nodePath.join(env.root, 'link', 'package.json')

            expect(exitCode).toBe(0)
            expect(output).toContain('Summary: 1 files processed')
            expect(output).toContain(canonicalOutput)
            expect(output).not.toContain(linkOutput)
          }),
        )
      },
      Effect.provide(TestLayer),
      Effect.scoped,
    ),
  )

  Vitest.it.effect(
    're-validates on TDZ errors to identify root causes',
    Effect.fnUntraced(
      function* () {
        yield* withTestEnv((env) =>
          Effect.gen(function* () {
            /**
             * When a shared module throws during initialization, dependent genie files
             * may see TDZ errors. The CLI should detect this and re-validate sequentially
             * to identify the actual root cause.
             */

            // Root cause: shared module that throws during initialization
            yield* env.writeFile({
              path: 'genie/internal.ts',
              content: `export const catalog = (() => {
  throw new Error('Missing required env var DATABASE_URL')
})()
`,
            })

            // Dependent: imports from the failing module
            yield* env.writeFile({
              path: 'apps/app/package.json.genie.ts',
              content: `import { catalog } from '../../genie/internal.ts'
export default {
  data: { dependencies: catalog },
  stringify: () => JSON.stringify({ dependencies: catalog }),
}
`,
            })

            // Another dependent
            yield* env.writeFile({
              path: 'packages/lib/package.json.genie.ts',
              content: `import { catalog } from '../../genie/internal.ts'
export default {
  data: { devDependencies: catalog },
  stringify: () => JSON.stringify({ devDependencies: catalog }),
}
`,
            })

            // Independent success case
            yield* env.writeFile({
              path: 'standalone/package.json.genie.ts',
              content: `export default {
  data: { name: 'standalone' },
  stringify: () => JSON.stringify({ name: 'standalone' }),
}
`,
            })

            // Create parent directories for generated files
            yield* env.writeFile({ path: 'apps/app/.gitkeep', content: '' })
            yield* env.writeFile({
              path: 'packages/lib/.gitkeep',
              content: '',
            })
            yield* env.writeFile({ path: 'standalone/.gitkeep', content: '' })

            const { stdout, stderr, exitCode } = yield* runGenie(env, ['--dry-run'])
            const output = `${stdout}\n${stderr}`

            // Should fail
            expect(exitCode).not.toBe(0)

            // Should show re-validation message
            expect(output).toContain('Re-validating to identify root causes')

            // Should identify root cause (not TDZ errors)
            expect(output).toContain('root cause error')
            expect(output).toContain('Missing required env var DATABASE_URL')

            // Should indicate dependent failures
            expect(output).toContain('failed due to dependency errors')
          }),
        )
      },
      Effect.provide(TestLayer),
      Effect.scoped,
    ),
  )

  Vitest.it.effect(
    'handles multiple independent root causes',
    Effect.fnUntraced(
      function* () {
        yield* withTestEnv((env) =>
          Effect.gen(function* () {
            /**
             * When there are multiple independent failures (not dependencies of each other),
             * all should be reported as root causes.
             */

            // First root cause
            yield* env.writeFile({
              path: 'a/package.json.genie.ts',
              content: `throw new Error('Error in module A')
export default { data: {}, stringify: () => '{}' }
`,
            })

            // Second root cause (independent)
            yield* env.writeFile({
              path: 'b/package.json.genie.ts',
              content: `throw new Error('Error in module B')
export default { data: {}, stringify: () => '{}' }
`,
            })

            // Create parent directories
            yield* env.writeFile({ path: 'a/.gitkeep', content: '' })
            yield* env.writeFile({ path: 'b/.gitkeep', content: '' })

            const { stdout, stderr, exitCode } = yield* runGenie(env, ['--dry-run'])
            const output = `${stdout}\n${stderr}`

            // Should fail
            expect(exitCode).not.toBe(0)

            // Should show both root causes
            expect(output).toContain('Error in module A')
            expect(output).toContain('Error in module B')
          }),
        )
      },
      Effect.provide(TestLayer),
      Effect.scoped,
    ),
  )

  Vitest.it.effect(
    'normalizes symlink cwd to realpath for correct relative path computation',
    Effect.fnUntraced(
      function* () {
        yield* withTestEnv((env) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem
            const pathSvc = yield* Path.Path

            /**
             * REGRESSION TEST: Symlink cwd normalization
             *
             * This test reproduces a bug where genie invoked with a symlink path as --cwd
             * would generate corrupted relative paths in package.json files.
             *
             * The bug occurred in megarepo setups where:
             *   workspace/repo → ~/.megarepo/.../refs/heads/main  (symlink)
             *
             * When genie ran:
             *   1. --cwd received the symlink path: /workspace/repo
             *   2. File discovery used fs.realPath(), returning: ~/.megarepo/.../file.genie.ts
             *   3. path.relative(symlinkCwd, realFilePath) produced a path like:
             *      "../../../../.megarepo/.../packages/foo" instead of "packages/foo"
             *
             * This caused link: dependencies in generated package.json to have excessive
             * "../" segments (13+ levels), making them non-portable across machines.
             *
             * The fix: genie now normalizes --cwd to its realpath before computing locations,
             * ensuring both cwd and file paths are in the same form.
             *
             * See: context/workarounds/pnpm-issues.md for the full investigation.
             */

            // Create the "real" directory structure (simulating ~/.megarepo/.../repo/)
            const realRepoPath = pathSvc.join(env.root, 'real-repo')
            yield* fs.makeDirectory(realRepoPath, { recursive: true })

            // Create a genie file that uses link: protocol (the catalog pattern)
            // This simulates internal.ts defining link:packages/@overeng/utils
            yield* env.writeFile({
              path: 'real-repo/packages/pkg-a/package.json.genie.ts',
              content: `
/**
 * Simulates the catalog pattern where internal packages use link:packages/... paths
 * that get resolved to relative paths at stringify time.
 */
const INTERNAL_LINK_PREFIX = 'link:packages/'

const computeRelativePath = ({ from, to }) => {
  const fromParts = from.split('/').filter(Boolean)
  const toParts = to.split('/').filter(Boolean)
  let common = 0
  while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) {
    common++
  }
  const upCount = fromParts.length - common
  const downPath = toParts.slice(common).join('/')
  return '../'.repeat(upCount) + downPath || '.'
}

const resolveDeps = ({ deps, currentLocation }) => {
  const resolved = {}
  for (const [name, version] of Object.entries(deps)) {
    if (version.startsWith(INTERNAL_LINK_PREFIX)) {
      const targetLocation = version.slice('link:'.length)
      const relativePath = computeRelativePath({ from: currentLocation, to: targetLocation })
      resolved[name] = 'link:' + relativePath
    } else {
      resolved[name] = version
    }
  }
  return resolved
}

export default {
  data: {
    name: '@test/pkg-a',
    dependencies: {
      '@test/pkg-b': 'link:packages/pkg-b',
    },
  },
  stringify: (ctx) => {
    const data = {
      name: '@test/pkg-a',
      dependencies: resolveDeps({
        deps: { '@test/pkg-b': 'link:packages/pkg-b' },
        currentLocation: ctx.location,
      }),
    }
    // Include location in output for assertion
    data._genieLocation = ctx.location
    return JSON.stringify(data, null, 2)
  },
}
`,
            })

            // Create the target package directory (so link: is valid)
            yield* env.writeFile({
              path: 'real-repo/packages/pkg-b/package.json',
              content: '{"name": "@test/pkg-b"}',
            })

            // Create a symlink to the real repo (simulating workspace/repo → ~/.megarepo/...)
            const symlinkPath = pathSvc.join(env.root, 'symlink-repo')
            yield* fs.symlink(realRepoPath, symlinkPath)

            // Run genie with --cwd pointing to the SYMLINK path
            // This is the scenario that previously caused the bug
            const cliPath = new URL('./mod.ts', import.meta.url).pathname
            const command = Command.make(bunBin, [cliPath, '--cwd', symlinkPath], {
              cwd: symlinkPath,
              stdout: 'pipe',
              stderr: 'pipe',
            })

            const process = yield* command
            const [stdoutChunks, stderrChunks, exitCode] = yield* Effect.all([
              Stream.runCollect(process.stdout),
              Stream.runCollect(process.stderr),
              process.exitCode,
            ])

            const _stdout = decodeChunks(stdoutChunks)
            const _stderr = decodeChunks(stderrChunks)

            // Generation should succeed
            expect(exitCode).toBe(0)

            // Read the generated package.json
            const generatedPath = pathSvc.join(realRepoPath, 'packages/pkg-a/package.json')
            const generatedContent = yield* fs.readFileString(generatedPath)
            const generated = decodeGeneratedPackageJson(generatedContent)

            // THE KEY ASSERTION: The location should be a simple repo-relative path
            // NOT a path containing ".." that escapes the repo structure
            expect(generated._genieLocation).toBe('packages/pkg-a')

            // The link: dependency should be a simple relative path
            // NOT something like "link:../../../../../.../packages/pkg-b"
            const linkPath = generated.dependencies?.['@test/pkg-b']
            expect(linkPath).toBe('link:../pkg-b')

            // Verify no excessive "../" in the path (the bug symptom)
            const parentRefCount = (String(linkPath).match(/\.\.\//g) || []).length
            expect(parentRefCount).toBeLessThanOrEqual(2) // "../pkg-b" has 1, which is correct
          }),
        )
      },
      Effect.provide(TestLayer),
      Effect.scoped,
    ),
  )

  Vitest.it.effect(
    'ignores git-ignored genie files during discovery',
    Effect.fnUntraced(
      function* () {
        yield* withTestEnv((env) =>
          Effect.gen(function* () {
            yield* env.writeFile({
              path: '.gitignore',
              content: '.claude/\n',
            })
            yield* env.writeFile({
              path: 'package.json.genie.ts',
              content: `export default {
  data: { name: 'genie-cli-test', private: true },
  stringify: () => JSON.stringify({ name: 'genie-cli-test', private: true }),
}`,
            })
            yield* env.writeFile({
              path: '.claude/worktrees/local-scratch/package.json.genie.ts',
              content: `throw new Error('ignored local worktree should not be discovered')
export default { data: {}, stringify: () => '{}' }`,
            })

            const init = Command.make(gitBin, ['init', '-q'], {
              cwd: env.root,
              stdout: 'pipe',
              stderr: 'pipe',
            })
            const initProcess = yield* init
            expect(yield* initProcess.exitCode).toBe(0)

            const { stdout, stderr, exitCode } = yield* runGenie(env, ['--dry-run'])
            const output = `${stdout}\n${stderr}`

            expect(exitCode).toBe(0)
            expect(output).toContain('Summary: 1 files processed')
            expect(output).not.toContain('ignored local worktree')
            expect(output).not.toContain('.claude/worktrees')
          }),
        )
      },
      Effect.provide(TestLayer),
      Effect.scoped,
    ),
  )

  Vitest.it.effect(
    'computes locations relative to the nearest repo root (not parent cwd)',
    Effect.fnUntraced(
      function* () {
        yield* withTestEnv((env) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem
            const pathSvc = yield* Path.Path

            /**
             * REGRESSION TEST: Parent cwd path normalization
             *
             * If genie runs from a parent directory (e.g. a megarepo root),
             * we still want repo-relative locations like "packages/pkg-a",
             * not "repo/packages/pkg-a" which would cause excessive "../".
             */
            yield* env.writeFile({
              path: 'outer/megarepo.json',
              content: '{}',
            })
            yield* env.writeFile({
              path: 'outer/repo/megarepo.json',
              content: '{}',
            })

            yield* env.writeFile({
              path: 'outer/repo/packages/pkg-a/package.json.genie.ts',
              content: `
const INTERNAL_LINK_PREFIX = 'link:packages/'

const computeRelativePath = ({ from, to }) => {
  const fromParts = from.split('/').filter(Boolean)
  const toParts = to.split('/').filter(Boolean)
  let common = 0
  while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) {
    common++
  }
  const upCount = fromParts.length - common
  const downPath = toParts.slice(common).join('/')
  return '../'.repeat(upCount) + downPath || '.'
}

const resolveDeps = ({ deps, currentLocation }) => {
  const resolved = {}
  for (const [name, version] of Object.entries(deps)) {
    if (version.startsWith(INTERNAL_LINK_PREFIX)) {
      const targetLocation = version.slice('link:'.length)
      const relativePath = computeRelativePath({ from: currentLocation, to: targetLocation })
      resolved[name] = 'link:' + relativePath
    } else {
      resolved[name] = version
    }
  }
  return resolved
}

export default {
  data: {
    name: '@test/pkg-a',
    dependencies: {
      '@test/pkg-b': 'link:packages/pkg-b',
    },
  },
  stringify: (ctx) => {
    const data = {
      name: '@test/pkg-a',
      dependencies: resolveDeps({
        deps: { '@test/pkg-b': 'link:packages/pkg-b' },
        currentLocation: ctx.location,
      }),
    }
    data._genieLocation = ctx.location
    return JSON.stringify(data, null, 2)
  },
}
`,
            })

            yield* env.writeFile({
              path: 'outer/repo/packages/pkg-b/package.json',
              content: '{"name": "@test/pkg-b"}',
            })

            const outerRoot = pathSvc.join(env.root, 'outer')
            const cliPath = new URL('./mod.ts', import.meta.url).pathname
            const command = Command.make(bunBin, [cliPath, '--cwd', outerRoot], {
              cwd: outerRoot,
              stdout: 'pipe',
              stderr: 'pipe',
            })

            const process = yield* command
            const [stdoutChunks, stderrChunks, exitCode] = yield* Effect.all([
              Stream.runCollect(process.stdout),
              Stream.runCollect(process.stderr),
              process.exitCode,
            ])

            const _stdout = decodeChunks(stdoutChunks)
            const _stderr = decodeChunks(stderrChunks)

            expect(exitCode).toBe(0)

            const generatedPath = pathSvc.join(outerRoot, 'repo/packages/pkg-a/package.json')
            const generatedContent = yield* fs.readFileString(generatedPath)
            const generated = decodeGeneratedPackageJson(generatedContent)

            expect(generated._genieLocation).toBe('packages/pkg-a')
            const linkPath = generated.dependencies?.['@test/pkg-b']
            expect(linkPath).toBe('link:../pkg-b')
          }),
        )
      },
      Effect.provide(TestLayer),
      Effect.scoped,
    ),
  )

  Vitest.it.effect(
    'Issue #135: --output json includes files array and cwd on failure',
    Effect.fnUntraced(
      function* () {
        yield* withTestEnv((env) =>
          Effect.gen(function* () {
            // Working file
            yield* env.writeFile({
              path: 'working.json.genie.ts',
              content: `export default {
  data: { hello: 'world' },
  stringify: () => JSON.stringify({ hello: 'world' }),
}`,
            })

            // Broken file (throws at import time)
            yield* env.writeFile({
              path: 'broken.json.genie.ts',
              content: `throw new Error('intentional failure for repro')
export default { data: {}, stringify: () => '{}' }`,
            })

            const { stdout, exitCode } = yield* runGenie(env, ['--output', 'json'])

            expect(exitCode).not.toBe(0)

            // Flat JSON contract: final stdout line is the raw state (no envelope).
            // Exit code signals failure; per-file error details are carried in state.
            const state = yield* Schema.decodeEffect(
              Schema.fromJsonString(GenieApp.config.stateSchema),
            )(stdout.trim())

            // Bug #135: files array must NOT be empty
            expect(state.files.length).toBe(2)
            // Bug #135: cwd must NOT be empty
            expect(state.cwd).not.toBe('')
            // Summary should be correct
            expect(state.summary?.failed).toBe(1)
            expect(state.summary?.unchanged).toBe(1)
            // Per-file error details should be present
            const errorFile = state.files.find((f) => f.status === 'error')
            expect(errorFile).toBeDefined()
            expect(errorFile!.message).toContain('intentional failure')
          }),
        )
      },
      Effect.provide(TestLayer),
      Effect.scoped,
    ),
  )

  Vitest.it.effect(
    'Issue #153: validate hooks run during generation and fail the command',
    Effect.fnUntraced(
      function* () {
        yield* withTestEnv((env) =>
          Effect.gen(function* () {
            /**
             * Validate hooks should run after successful generation.
             * If a validate hook returns errors, the command should fail
             * even though the file was generated successfully.
             */

            yield* env.writeFile({
              path: 'config.json.genie.ts',
              content: `export default {
  data: { key: 'value' },
  stringify: () => JSON.stringify({ key: 'value' }),
  validate: () => [{ severity: 'error', message: 'config key must not be "value"' }],
}`,
            })

            // Generate mode (no --check flag)
            const { stdout, stderr, exitCode } = yield* runGenie(env, [])
            const output = `${stdout}\n${stderr}`

            expect(exitCode).not.toBe(0)
            expect(output).toContain('Genie validation failed')
            expect(output).toContain('config key must not be "value"')
          }),
        )
      },
      Effect.provide(TestLayer),
      Effect.scoped,
    ),
  )

  Vitest.it.effect(
    'Issue #135: --output ndjson final line includes files and cwd on failure',
    Effect.fnUntraced(
      function* () {
        yield* withTestEnv((env) =>
          Effect.gen(function* () {
            yield* env.writeFile({
              path: 'working.json.genie.ts',
              content: `export default {
  data: { hello: 'world' },
  stringify: () => JSON.stringify({ hello: 'world' }),
}`,
            })

            yield* env.writeFile({
              path: 'broken.json.genie.ts',
              content: `throw new Error('intentional failure for repro')
export default { data: {}, stringify: () => '{}' }`,
            })

            const { stdout, exitCode } = yield* runGenie(env, ['--output', 'ndjson'])

            expect(exitCode).not.toBe(0)

            // NDJSON flat contract: each line is raw state; last line is the
            // authoritative end state (no trailing Failure envelope).
            const lines = stdout.trim().split('\n')
            const finalState = yield* Schema.decodeEffect(
              Schema.fromJsonString(GenieApp.config.stateSchema),
            )(lines[lines.length - 1]!)

            expect(finalState.files.length).toBe(2)
            expect(finalState.cwd).not.toBe('')
            expect(finalState.summary?.failed).toBe(1)
          }),
        )
      },
      Effect.provide(TestLayer),
      Effect.scoped,
    ),
  )
})
