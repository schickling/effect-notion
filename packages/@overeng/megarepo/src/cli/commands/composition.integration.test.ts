import * as NodePath from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import { EffectPath } from '@overeng/effect-path'

import { COMPOSITION_ROOT_SCHEMA_VERSION } from '../../composition/root/composition-root.ts'
import * as Git from '../../core/git.ts'
import type { MegarepoStore } from '../../store/store.ts'
import { Store } from '../../store/store.ts'
import { makeCanonicalTempDirectoryScoped } from '../../test-utils/temp-root.ts'
import { runCompositionApply } from './composition.ts'

const GIT_USER = ['-c', 'user.email=test@example.com', '-c', 'user.name=Test User'] as const

const makeLegacyWorkspace = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const tmp = yield* makeCanonicalTempDirectoryScoped()
  const source = NodePath.join(tmp, 'source')
  const bareRepo = NodePath.join(tmp, 'repo.git')
  const workspaceRoot = NodePath.join(tmp, 'workspace')
  const git = (cwd: string, ...args: ReadonlyArray<string>) =>
    Git.runCommand({ cwd, args: [...GIT_USER, ...args] })
  yield* fs.makeDirectory(EffectPath.unsafe.absoluteDir(`${source}/`), { recursive: true })
  yield* git(source, 'init', '-b', 'main')
  const configJson = yield* Schema.encodeEffect(
    Schema.fromJsonString(Schema.Unknown, { space: 2 }),
  )({ members: {}, generators: { composition: { enabled: true, platformHub: 'hub' } } })
  yield* fs.writeFileString(
    EffectPath.unsafe.absoluteFile(NodePath.join(source, 'megarepo.json')),
    `${configJson}\n`,
  )
  const memberJson = yield* Schema.encodeEffect(
    Schema.fromJsonString(Schema.Unknown, { space: 2 }),
  )({
    schemaVersion: COMPOSITION_ROOT_SCHEMA_VERSION,
    cell: 'owner',
    mount: 'repos/owner',
    projectIgnore: [],
    distOverlays: [],
    capabilities: [],
  })
  yield* fs.writeFileString(
    EffectPath.unsafe.absoluteFile(NodePath.join(source, 'buck2-member.json')),
    `${memberJson}\n`,
  )
  yield* git(source, 'add', '-A')
  yield* git(source, 'commit', '--no-gpg-sign', '--no-verify', '-m', 'base')
  yield* git(tmp, 'clone', '--bare', source, bareRepo)
  yield* git(bareRepo, 'worktree', 'add', workspaceRoot, 'main')
  const store: MegarepoStore = {
    basePath: EffectPath.unsafe.absoluteDir(`${tmp}/`),
    getRepoBasePath: () => EffectPath.unsafe.absoluteDir(`${tmp}/`),
    getBareRepoPath: () => EffectPath.unsafe.absoluteDir(`${bareRepo}/`),
    getWorktreePath: () => EffectPath.unsafe.absoluteDir(`${workspaceRoot}/`),
    hasBareRepo: () => Effect.succeed(true),
    hasWorktree: () => Effect.succeed(true),
    listRepos: Effect.succeed([]),
    listWorktrees: () => Effect.succeed([]),
  }
  return { tmp, bareRepo, workspaceRoot, store, git }
})

const fingerprint = (fixture: Effect.Success<typeof makeLegacyWorkspace>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return {
      parent: (yield* fs.readDirectory(
        EffectPath.unsafe.absoluteDir(`${fixture.tmp}/`),
      )).toSorted(),
      workspace: (yield* fs.readDirectory(
        EffectPath.unsafe.absoluteDir(`${fixture.workspaceRoot}/`),
      )).toSorted(),
      registrations: yield* fixture.git(fixture.bareRepo, 'worktree', 'list', '--porcelain'),
    }
  })

describe('routine composition apply is shape-preserving', () => {
  it.effect('returns a typed recreate instruction for a legacy flat root without mutation', () =>
    Effect.gen(function* () {
      const fixture = yield* makeLegacyWorkspace
      const before = yield* fingerprint(fixture)
      const failure = yield* runCompositionApply({
        workspaceRoot: EffectPath.unsafe.absoluteDir(`${fixture.workspaceRoot}/`),
        dryRun: false,
        env: {},
      }).pipe(Effect.provideService(Store, fixture.store), Effect.flip)
      expect(failure.reason).toBe('RecreateRequired')
      expect(failure.message).toContain('mr store worktree new')
      expect(failure.message).not.toContain('cutover')
      expect(yield* fingerprint(fixture)).toEqual(before)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  )
})
