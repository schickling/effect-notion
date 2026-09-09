import * as NodePath from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { afterAll, beforeAll, expect } from 'vitest'

import { EffectPath } from '@overeng/effect-path'

import * as Git from '../../core/git.ts'
import { makeCanonicalTempDirectoryScoped } from '../../test-utils/temp-root.ts'
import {
  assertComposedOwnedWorkspace,
  createComposedOwnedWorkspace,
  type OwnedWorkspaceGenerationContext,
} from './owned-worktree-acquisition.ts'

const GIT_USER = ['-c', 'user.email=test@example.com', '-c', 'user.name=Test User'] as const
const previousAgentPolicyBypass = process.env['AGENT_POLICY_BYPASS']
beforeAll(() => {
  process.env['AGENT_POLICY_BYPASS'] = '1'
})
afterAll(() => {
  if (previousAgentPolicyBypass === undefined) delete process.env['AGENT_POLICY_BYPASS']
  else process.env['AGENT_POLICY_BYPASS'] = previousAgentPolicyBypass
})

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  Git.runCommand({ cwd, args: [...GIT_USER, ...args] })

const makeFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const tmp = yield* makeCanonicalTempDirectoryScoped()
  const source = NodePath.join(tmp, 'source')
  const bareRepo = NodePath.join(tmp, 'repo.git')
  const workspaceRoot = NodePath.join(tmp, 'workspace')
  yield* fs.makeDirectory(EffectPath.unsafe.absoluteDir(`${source}/`), { recursive: true })
  yield* git(source, 'init', '-b', 'main')
  yield* fs.writeFileString(
    EffectPath.unsafe.absoluteFile(NodePath.join(source, 'megarepo.kdl')),
    'members {}\n',
  )
  yield* git(source, 'add', '-A')
  yield* git(source, 'commit', '--no-gpg-sign', '--no-verify', '-m', 'base')
  yield* git(tmp, 'clone', '--bare', source, bareRepo)
  return {
    tmp,
    bareRepo,
    workspaceRoot,
    ownedWorktree: NodePath.join(workspaceRoot, 'repos', 'owner'),
  }
})

const create = <E, R>(
  fixture: Effect.Success<typeof makeFixture>,
  generate: (context: OwnedWorkspaceGenerationContext) => Effect.Effect<void, E, R>,
) =>
  createComposedOwnedWorkspace({
    bareRepo: fixture.bareRepo,
    workspaceRoot: fixture.workspaceRoot,
    ownedMember: 'owner',
    branch: 'feature',
    startPoint: 'main',
    generate,
  })

describe('direct composed worktree creation', () => {
  it.effect('creates Git directly at the stable final W path and links the root config', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const fixture = yield* makeFixture
      const result = yield* create(fixture, () => Effect.void)
      expect(result.ownedWorktree).toBe(fixture.ownedWorktree)
      expect(yield* fs.readLink(NodePath.join(fixture.workspaceRoot, 'megarepo.kdl'))).toBe(
        'repos/owner/megarepo.kdl',
      )
      const registrations = yield* Git.listWorktrees(fixture.bareRepo)
      expect(registrations.some((entry) => entry.path === fixture.ownedWorktree)).toBe(true)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('retries an exact generation failure without moving or replacing W', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const fixture = yield* makeFixture
      yield* create(fixture, () => Effect.fail('interrupted')).pipe(Effect.flip)
      const before = yield* fs.stat(EffectPath.unsafe.absoluteDir(`${fixture.ownedWorktree}/`))
      const result = yield* create(fixture, () => Effect.void)
      const after = yield* fs.stat(EffectPath.unsafe.absoluteDir(`${fixture.ownedWorktree}/`))
      expect(result.ownedWorktree).toBe(fixture.ownedWorktree)
      expect(after.ino).toStrictEqual(before.ino)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('refuses foreign root bytes before Git creation and leaves them untouched', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const fixture = yield* makeFixture
      yield* fs.makeDirectory(EffectPath.unsafe.absoluteDir(`${fixture.workspaceRoot}/`), {
        recursive: true,
      })
      const foreign = NodePath.join(fixture.workspaceRoot, 'foreign.txt')
      yield* fs.writeFileString(EffectPath.unsafe.absoluteFile(foreign), 'keep\n')
      const failure = yield* create(fixture, () => Effect.void).pipe(Effect.flip)
      expect(failure.reason).toBe('ForeignRoot')
      expect(yield* fs.readFileString(EffectPath.unsafe.absoluteFile(foreign))).toBe('keep\n')
      expect(yield* Git.listWorktrees(fixture.bareRepo)).toHaveLength(0)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('refuses a branch registered at any path other than W', () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture
      const elsewhere = NodePath.join(fixture.tmp, 'elsewhere')
      yield* git(fixture.bareRepo, 'worktree', 'add', '-b', 'feature', elsewhere, 'main')
      const failure = yield* create(fixture, () => Effect.void).pipe(Effect.flip)
      expect(failure.reason).toBe('GitIdentityConflict')
      expect(failure.message).toContain(elsewhere)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )

  it.effect('rejects a mismatched root config symlink after Git authority exists', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const fixture = yield* makeFixture
      yield* create(fixture, () => Effect.void)
      const rootConfig = NodePath.join(fixture.workspaceRoot, 'megarepo.kdl')
      yield* fs.remove(rootConfig)
      yield* fs.symlink('foreign', rootConfig)
      const failure = yield* assertComposedOwnedWorkspace({
        bareRepo: fixture.bareRepo,
        workspaceRoot: fixture.workspaceRoot,
        ownedMember: 'owner',
        branch: 'feature',
      }).pipe(Effect.flip)
      expect(failure.reason).toBe('ConfigSymlinkInvalid')
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )
})
