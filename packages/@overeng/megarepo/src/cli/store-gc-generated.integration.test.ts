import { symlink, utimes } from 'node:fs/promises'

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Clock, Duration, Effect, Exit, Layer } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as Cli from 'effect/unstable/cli'
import { expect } from 'vitest'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import * as Git from '../core/git.ts'
import { makeConsoleCapture } from '../test-utils/consoleCapture.ts'
import { decodeJson, encodeJson } from '../test-utils/json.ts'
import { createStoreFixture } from '../test-utils/store-setup.ts'
import { mrCommand } from './mod.ts'

const NOW = Date.now()
const DAY_MS = 24 * 60 * 60 * 1000
/** Live wall-clock layer so command timeouts stay on wall time. */
const liveClock = Layer.succeed(Clock.Clock, {
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
})

type JsonResult = {
  readonly artifactClass?: string
  readonly kind?: string
  readonly path: string
  readonly reason?: string
  readonly outcome?: string
  readonly status: string
  readonly message?: string
}

const generated = (results: ReadonlyArray<JsonResult>, artifactClass: string) =>
  results.find((row) => row.kind === 'generated-artifact' && row.artifactClass === artifactClass)

const runGc = ({
  cwd,
  storePath,
  args,
  generatedArtifacts = true,
}: {
  cwd: AbsoluteDirPath
  storePath: AbsoluteDirPath
  args: ReadonlyArray<string>
  generatedArtifacts?: boolean
}) =>
  Effect.gen(function* () {
    const { consoleLayer, getStdoutLines } = yield* makeConsoleCapture
    const previous = process.env['MEGAREPO_STORE']
    process.env['MEGAREPO_STORE'] = storePath
    // `mrCommand` provides its own `Cwd` layer from the `--cwd` global flag, so an
    // outer `Effect.provideService(Cwd, …)` is overridden and every command would
    // silently run against the ambient process cwd. Drive the documented flag.
    const exit = yield* Cli.Command.runWith(mrCommand, { version: 'test' })([
      '--cwd',
      cwd,
      'store',
      'gc',
      ...(generatedArtifacts === true ? ['--generated-artifacts'] : []),
      ...args,
      '--output',
      'json',
    ]).pipe(
      Effect.provide(Layer.mergeAll(consoleLayer, liveClock, NodeServices.layer)),
      Effect.exit,
    )
    if (previous === undefined) delete process.env['MEGAREPO_STORE']
    else process.env['MEGAREPO_STORE'] = previous
    const stdout = (yield* getStdoutLines).join('\n')
    const json = stdout.length === 0 ? undefined : (decodeJson(stdout) as Record<string, unknown>)
    return {
      exitCode: Exit.isSuccess(exit) === true ? 0 : 1,
      planSha256: json?.['planSha256'] as string | undefined,
      completedRepoCount: json?.['completedRepoCount'] as number | undefined,
      discoveredWorktreeCount: json?.['discoveredWorktreeCount'] as number | undefined,
      activeWorktreeCount: json?.['activeWorktreeCount'] as number | undefined,
      results: (json?.['results'] ?? []) as ReadonlyArray<JsonResult>,
    }
  }).pipe(Effect.scoped)

const fixture = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const created = yield* createStoreFixture([
      { host: 'github.com', owner: 'acme', repo: 'widget', branches: ['feature/artifacts'] },
    ])
    const worktree = created.worktreePaths['github.com/acme/widget#feature/artifacts']!
    const outside = EffectPath.ops.join(
      created.storePath,
      EffectPath.unsafe.relativeDir('../outside/'),
    )
    yield* fs.makeDirectory(outside, { recursive: true })
    const state = EffectPath.ops.join(created.storePath, EffectPath.unsafe.relativeDir('.state/'))
    yield* fs.makeDirectory(state, { recursive: true })
    const manifest = EffectPath.ops.join(state, EffectPath.unsafe.relativeFile('agents.json'))
    const config = EffectPath.ops.join(state, EffectPath.unsafe.relativeFile('gc-config.json'))
    return { ...created, worktree, outside, manifest, config }
  })

const configure = ({
  config,
  manifest,
  activeWorkspacePaths = [],
  expiresAtMs = NOW + DAY_MS,
}: {
  config: string
  manifest?: string | undefined
  activeWorkspacePaths?: ReadonlyArray<string>
  expiresAtMs?: number
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    if (manifest !== undefined) {
      yield* fs.writeFileString(
        manifest,
        encodeJson({ version: 1, expiresAtMs, activeWorkspacePaths }),
      )
    }
    yield* fs.writeFileString(
      config,
      encodeJson({
        generatedArtifacts: {
          enabled: true,
          retentionMs: DAY_MS,
          allowlist: ['node_modules', 'dist'],
          ...(manifest !== undefined ? { agentLivenessManifest: manifest } : {}),
        },
      }),
    )
  })

const oldIgnoredArtifact = (worktree: AbsoluteDirPath) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFileString(`${worktree}/.gitignore`, 'node_modules/\n')
    yield* Git.runCommand({ args: ['add', '.gitignore'], cwd: worktree })
    yield* Git.runCommand({
      args: ['commit', '-m', 'ignore generated dependencies'],
      cwd: worktree,
    })
    const artifact = `${worktree}/node_modules`
    yield* fs.makeDirectory(artifact, { recursive: true })
    yield* fs.writeFileString(`${artifact}/fixture.txt`, 'generated')
    yield* Effect.promise(() =>
      utimes(`${artifact}/fixture.txt`, new Date(NOW - 2 * DAY_MS), new Date(NOW - 2 * DAY_MS)),
    )
    yield* Effect.promise(() =>
      utimes(artifact, new Date(NOW - 2 * DAY_MS), new Date(NOW - 2 * DAY_MS)),
    )
    return artifact
  })

describe('mr store gc --generated-artifacts', () => {
  it.effect(
    'dry-run plans an old ignored artifact without deleting it',
    Effect.fnUntraced(
      function* () {
        const f = yield* fixture()
        yield* configure({ config: f.config, manifest: f.manifest })
        const artifact = yield* oldIgnoredArtifact(f.worktree)
        const result = yield* runGc({ cwd: f.outside, storePath: f.storePath, args: ['--dry-run'] })
        const row = generated(result.results, 'node_modules')
        expect(row?.outcome, row?.message).toBe('would-delete')
        expect(result.planSha256).toMatch(/^[0-9a-f]{64}$/)
        const repeated = yield* runGc({
          cwd: f.outside,
          storePath: f.storePath,
          args: ['--dry-run'],
        })
        expect(repeated.planSha256).toBe(result.planSha256)
        expect(yield* FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.exists(artifact)))).toBe(
          true,
        )
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'rejects relative and non-normalized agent workspace paths',
    Effect.fnUntraced(
      function* () {
        const f = yield* fixture()
        yield* oldIgnoredArtifact(f.worktree)
        for (const invalidPath of [
          'relative/worktree',
          `${f.worktree}/../worktree`,
          `${f.worktree}/`,
        ]) {
          yield* configure({
            config: f.config,
            manifest: f.manifest,
            activeWorkspacePaths: [invalidPath],
          })
          const result = yield* runGc({
            cwd: f.outside,
            storePath: f.storePath,
            args: ['--dry-run'],
          })
          expect(generated(result.results, 'node_modules')).toMatchObject({
            outcome: 'unknown',
            reason: 'agent-liveness-unavailable',
          })
          expect(result.completedRepoCount).toBe(1)
          expect(result.discoveredWorktreeCount).toBe(1)
          expect(result.activeWorktreeCount).toBe(0)
        }
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'recent nested activity keeps an old artifact root',
    Effect.fnUntraced(
      function* () {
        const f = yield* fixture()
        yield* configure({ config: f.config, manifest: f.manifest })
        const artifact = yield* oldIgnoredArtifact(f.worktree)
        yield* Effect.promise(() =>
          utimes(`${artifact}/fixture.txt`, new Date(NOW - 1_000), new Date(NOW - 1_000)),
        )
        const result = yield* runGc({ cwd: f.outside, storePath: f.storePath, args: ['--dry-run'] })
        const row = generated(result.results, 'node_modules')
        expect(row?.reason, row?.message).toBe('retention')
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'missing or expired agent manifest fails closed',
    Effect.fnUntraced(
      function* () {
        const f = yield* fixture()
        yield* oldIgnoredArtifact(f.worktree)
        yield* configure({ config: f.config })
        const missing = yield* runGc({
          cwd: f.outside,
          storePath: f.storePath,
          args: ['--dry-run'],
        })
        expect(generated(missing.results, 'node_modules')?.outcome).toBe('unknown')
        yield* configure({ config: f.config, manifest: f.manifest, expiresAtMs: NOW - 1 })
        const expired = yield* runGc({
          cwd: f.outside,
          storePath: f.storePath,
          args: ['--dry-run'],
        })
        expect(generated(expired.results, 'node_modules')?.outcome).toBe('unknown')
        expect(generated(expired.results, 'node_modules')?.reason).toBe(
          'agent-liveness-unavailable',
        )
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'dirty worktree and non-ignored artifact are kept',
    Effect.fnUntraced(
      function* () {
        const f = yield* fixture()
        yield* configure({ config: f.config, manifest: f.manifest })
        yield* oldIgnoredArtifact(f.worktree)
        const fs = yield* FileSystem.FileSystem
        yield* fs.writeFileString(`${f.worktree}/README.md`, 'dirty')
        const dirty = yield* runGc({ cwd: f.outside, storePath: f.storePath, args: ['--dry-run'] })
        expect(generated(dirty.results, 'node_modules')?.reason).toBe('dirty-worktree')
        yield* Git.runCommand({ args: ['add', 'README.md'], cwd: f.worktree })
        yield* Git.runCommand({ args: ['commit', '-m', 'restore clean fixture'], cwd: f.worktree })
        const dist = `${f.worktree}/dist`
        yield* fs.makeDirectory(dist, { recursive: true })
        yield* fs.writeFileString(`${dist}/tracked.txt`, 'tracked')
        yield* Git.runCommand({ args: ['add', 'dist/tracked.txt'], cwd: f.worktree })
        yield* Git.runCommand({ args: ['commit', '-m', 'track dist fixture'], cwd: f.worktree })
        yield* Effect.promise(() =>
          utimes(dist, new Date(NOW - 2 * DAY_MS), new Date(NOW - 2 * DAY_MS)),
        )
        const nonIgnored = yield* runGc({
          cwd: f.outside,
          storePath: f.storePath,
          args: ['--dry-run'],
        })
        expect(generated(nonIgnored.results, 'dist')?.reason).toBe('artifact-not-ignored')
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'rejects mutation and expected-plan until a deletion transaction exists',
    Effect.fnUntraced(
      function* () {
        const f = yield* fixture()
        expect((yield* runGc({ cwd: f.outside, storePath: f.storePath, args: [] })).exitCode).toBe(
          1,
        )
        expect(
          (yield* runGc({
            cwd: f.outside,
            storePath: f.storePath,
            args: ['--dry-run', '--expected-plan', '0'.repeat(64)],
          })).exitCode,
        ).toBe(1)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'nested symlink fails the bounded scan closed',
    Effect.fnUntraced(
      function* () {
        const f = yield* fixture()
        yield* configure({ config: f.config, manifest: f.manifest })
        const artifact = yield* oldIgnoredArtifact(f.worktree)
        yield* Effect.promise(() => symlink(f.outside, `${artifact}/outside`))
        const result = yield* runGc({ cwd: f.outside, storePath: f.storePath, args: ['--dry-run'] })
        expect(generated(result.results, 'node_modules')).toMatchObject({
          outcome: 'unknown',
          reason: 'artifact-scan-incomplete',
        })
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'legacy store gc does not include generated-artifact planning',
    Effect.fnUntraced(
      function* () {
        const f = yield* fixture()
        yield* configure({ config: f.config, manifest: f.manifest })
        const artifact = yield* oldIgnoredArtifact(f.worktree)
        const result = yield* runGc({
          cwd: f.outside,
          storePath: f.storePath,
          args: ['--dry-run'],
          generatedArtifacts: false,
        })
        expect(result.planSha256).toBeUndefined()
        expect(result.results.some((row) => row.kind === 'generated-artifact')).toBe(false)
        expect(yield* FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.exists(artifact)))).toBe(
          true,
        )
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'planning does not create or reconcile the shared workspace registry',
    Effect.fnUntraced(
      function* () {
        const f = yield* fixture()
        yield* configure({ config: f.config, manifest: f.manifest })
        yield* oldIgnoredArtifact(f.worktree)
        const registry = `${f.storePath}/.state/workspaces`
        const fs = yield* FileSystem.FileSystem
        expect(yield* fs.exists(registry)).toBe(false)
        yield* runGc({ cwd: f.outside, storePath: f.storePath, args: ['--dry-run'] })
        expect(yield* fs.exists(registry)).toBe(false)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )
})
