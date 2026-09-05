import * as NodePath from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import * as Git from '../../core/git.ts'
import { createLockedMember, LockFile } from '../../core/lock.ts'
import type { MegarepoStore } from '../../store/store.ts'
import { addCommit, initGitRepo } from '../../test-utils/setup.ts'
import { makeCanonicalTempDirectoryScoped } from '../../test-utils/temp-root.ts'
import {
  CompositionCutoverError,
  compositionCacheSections,
  readCompositionLockFile,
  resolveLockedCompositionMembers,
} from './composition.ts'

interface Fixture {
  readonly sourcePath: AbsoluteDirPath
  readonly store: MegarepoStore
  readonly lockFile: LockFile
}

const makeFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const root = EffectPath.unsafe.absoluteDir(`${yield* makeCanonicalTempDirectoryScoped()}/`)
  const seed = EffectPath.ops.join(root, EffectPath.unsafe.relativeDir('seed/'))
  const repoBase = EffectPath.ops.join(
    root,
    EffectPath.unsafe.relativeDir('github.com/public/member/'),
  )
  const bareRepo = EffectPath.ops.join(repoBase, EffectPath.unsafe.relativeDir('.bare/'))
  yield* fs.makeDirectory(seed, { recursive: true })
  yield* initGitRepo(seed)
  yield* fs.makeDirectory(EffectPath.unsafe.absoluteDir(`${NodePath.join(seed, 'scripts')}/`), {
    recursive: true,
  })
  yield* fs.writeFileString(
    EffectPath.unsafe.absoluteFile(NodePath.join(seed, '.gitignore')),
    'ignored.cache\n',
  )
  yield* fs.writeFileString(
    EffectPath.unsafe.absoluteFile(NodePath.join(seed, 'flake.lock')),
    '{"nodes":{},"root":"root","version":7}\n',
  )
  yield* addCommit({ repoPath: seed, message: 'Create locked source' })
  const commit = yield* Git.getCurrentCommit(seed)
  yield* fs.makeDirectory(repoBase, { recursive: true })
  yield* Git.runCommand({ cwd: root, args: ['clone', '--bare', seed, bareRepo] })
  const sourcePath = EffectPath.ops.join(
    repoBase,
    EffectPath.unsafe.relativeDir(`refs/commits/${commit}/`),
  )
  yield* fs.makeDirectory(
    EffectPath.unsafe.absoluteDir(`${NodePath.dirname(sourcePath.replace(/\/$/u, ''))}/`),
    { recursive: true },
  )
  yield* Git.createWorktreeDetached({ repoPath: bareRepo, worktreePath: sourcePath, commit })

  const store: MegarepoStore = {
    basePath: root,
    getRepoBasePath: () => repoBase,
    getBareRepoPath: () => bareRepo,
    getWorktreePath: () => sourcePath,
    hasBareRepo: () => Effect.succeed(true),
    hasWorktree: () => Effect.succeed(true),
    listRepos: Effect.succeed([]),
    listWorktrees: () => Effect.succeed([]),
    getRepoPath: () => repoBase,
    hasRepo: () => Effect.succeed(true),
  }
  const lockFile = new LockFile({
    version: 1,
    members: {
      member: createLockedMember({
        url: 'https://github.com/public/member',
        ref: 'main',
        commit,
      }),
    },
  })
  return { sourcePath, store, lockFile } satisfies Fixture
})

describe('compositionCacheSections', () => {
  it('disables remote cache execution before the first overlay when requested', () => {
    expect(compositionCacheSections({ BUCK2_NO_REMOTE_CACHE: '1' })).toEqual([
      {
        section: 'buck2',
        entries: [
          { key: 'remote_cache_enabled', value: 'false' },
          { key: 'allow_cache_uploads', value: 'false' },
        ],
      },
    ])
  })

  it('preserves the hard-fail shared-cache default', () => {
    expect(compositionCacheSections({})).toEqual([])
    expect(compositionCacheSections({ BUCK2_NO_REMOTE_CACHE: '0' })).toEqual([])
  })

  it('renders the cache-only client contract for an explicitly named instance', () => {
    expect(
      compositionCacheSections({
        BUCK2_CACHE_ENDPOINT: 'grpc://cache.example:41045',
        BUCK2_CACHE_INSTANCE_NAME: 'effect-utils-dq1-candidate',
      }),
    ).toEqual([
      {
        section: 'buck2',
        entries: [
          { key: 'digest_algorithms', value: 'SHA256' },
          { key: 'default_allow_cache_upload', value: 'true' },
        ],
      },
      {
        section: 'buck2_re_client',
        entries: [
          { key: 'engine_address', value: 'grpc://cache.example:41045' },
          { key: 'action_cache_address', value: 'grpc://cache.example:41045' },
          { key: 'cas_address', value: 'grpc://cache.example:41045' },
          { key: 'instance_name', value: 'effect-utils-dq1-candidate' },
          { key: 'tls', value: 'false' },
          // Bounded and explicit: a batch above the 4 MiB gRPC message limit would fail
          // the upload at the transport rather than at a boundary this generator owns.
          { key: 'max_total_batch_size', value: '4194304' },
        ],
      },
    ])
  })

  it('lets BUCK2_NO_REMOTE_CACHE=1 win over a fully configured endpoint', () => {
    expect(
      compositionCacheSections({
        BUCK2_NO_REMOTE_CACHE: '1',
        BUCK2_CACHE_ENDPOINT: 'grpc://cache.example:41045',
        BUCK2_CACHE_INSTANCE_NAME: 'effect-utils-dq1-candidate',
      }),
    ).toEqual([
      {
        section: 'buck2',
        entries: [
          { key: 'remote_cache_enabled', value: 'false' },
          { key: 'allow_cache_uploads', value: 'false' },
        ],
      },
    ])
  })

  it('refuses half a pair instead of defaulting the other half', () => {
    expect(() =>
      compositionCacheSections({ BUCK2_CACHE_ENDPOINT: 'grpc://cache.example:41045' }),
    ).toThrow(CompositionCutoverError)
    expect(() =>
      compositionCacheSections({ BUCK2_CACHE_INSTANCE_NAME: 'effect-utils-dq1-candidate' }),
    ).toThrow(CompositionCutoverError)
    expect(() =>
      compositionCacheSections({
        BUCK2_CACHE_ENDPOINT: '   ',
        BUCK2_CACHE_INSTANCE_NAME: 'effect-utils-dq1-candidate',
      }),
    ).toThrow(CompositionCutoverError)
  })
})

const admit = (fixture: Fixture) =>
  resolveLockedCompositionMembers({
    configMembers: { member: 'public/member' },
    lockFile: fixture.lockFile,
    store: fixture.store,
  })

describe('composition locked source admission', () => {
  it.effect(
    'admits only the canonical registered detached commit worktree',
    Effect.fnUntraced(
      function* () {
        const fixture = yield* makeFixture
        expect(yield* admit(fixture)).toEqual([
          {
            key: 'member',
            sourcePath: fixture.sourcePath.replace(/\/+$/u, ''),
            lockedCommit: fixture.lockFile.members.member!.commit,
          },
        ])
        expect(yield* Git.getCurrentBranch(fixture.sourcePath)).toEqual(Option.none())
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  for (const [kind, path] of [
    ['tracked', 'flake.lock'],
    ['untracked', 'untracked.txt'],
    ['ignored', 'ignored.cache'],
    ['branch-attached', 'branch'],
  ] as const) {
    it.effect(
      `refuses ${kind} source state before composition effects`,
      Effect.fnUntraced(
        function* () {
          const fixture = yield* makeFixture
          if (kind === 'branch-attached') {
            yield* Git.runCommand({ cwd: fixture.sourcePath, args: ['checkout', '-b', path] })
          } else {
            yield* (yield* FileSystem.FileSystem).writeFileString(
              EffectPath.unsafe.absoluteFile(NodePath.join(fixture.sourcePath, path)),
              `${kind}\n`,
            )
          }
          const exit = yield* Effect.flip(admit(fixture))
          expect(exit).toBeInstanceOf(CompositionCutoverError)
          expect(exit.reason).toBe('LockedSourceRefused')
          if (kind === 'ignored') expect(exit.message).toContain('ignored bytes cannot enter R6')
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )
  }
})

describe('reference-only member lock lookup', () => {
  const lockBytes = (name: string, commit: string): string =>
    `${JSON.stringify({
      version: 1,
      members: {
        [name]: {
          url: `https://github.com/public/${name}`,
          ref: 'main',
          commit,
          pinned: false,
          lockedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    })}\n`

  it.effect(
    'prefers the acquired owned-member lock and falls back to the legacy root during dry-run',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const workspaceRoot = yield* makeCanonicalTempDirectoryScoped()
        const ownedMemberPath = NodePath.join(workspaceRoot, 'repos', 'owned')
        yield* fs.makeDirectory(ownedMemberPath, { recursive: true })
        yield* fs.writeFileString(
          EffectPath.unsafe.absoluteFile(NodePath.join(workspaceRoot, 'megarepo.lock')),
          lockBytes('legacy', 'a'.repeat(40)),
        )
        const legacy = yield* readCompositionLockFile({ workspaceRoot, ownedMemberPath })
        expect(Option.getOrThrow(legacy).members.legacy?.commit).toBe('a'.repeat(40))

        yield* fs.writeFileString(
          EffectPath.unsafe.absoluteFile(NodePath.join(ownedMemberPath, 'megarepo.lock')),
          lockBytes('owned', 'b'.repeat(40)),
        )
        const acquired = yield* readCompositionLockFile({ workspaceRoot, ownedMemberPath })
        expect(Option.getOrThrow(acquired).members.owned?.commit).toBe('b'.repeat(40))
        expect(Option.getOrThrow(acquired).members.legacy).toBeUndefined()
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )
})
