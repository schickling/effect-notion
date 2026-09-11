import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises'
import * as NodePath from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Schema, type Scope } from 'effect'
import type * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import { resolvePinnedCoreutils } from '../../test-utils/coreutils.ts'
import { makeCanonicalTempDirectoryScoped } from '../../test-utils/temp-root.ts'
import {
  makeOwnedCpAMountMetadata,
  scanR6ProtectedMount,
  writeOwnedCpAMountMetadata,
  type OwnedCpAMountMetadata,
} from '../mounts/member-mount-r6.ts'
import {
  DistOverlayTransaction,
  distOverlayTransactionPath,
  type DistOverlayPublishRequest,
} from './dist-overlay-lifecycle-schema.ts'
import {
  publishDistOverlay,
  recoverDistOverlay,
  type DistOverlayDirectorySyncReason,
  type DistOverlayRuntime,
} from './dist-overlay-lifecycle.ts'

const withNode = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Scope.Scope>,
): Effect.Effect<A, E> => effect.pipe(Effect.provide(NodeServices.layer), Effect.scoped)

const makeWritable = async (root: string): Promise<void> => {
  const visit = async (path: string): Promise<void> => {
    const info = await lstat(path)
    if (info.isSymbolicLink() === true) return
    if (info.isDirectory() === true) {
      await chmod(path, 0o755)
      for (const child of await readdir(path)) await visit(NodePath.join(path, child))
    } else {
      await chmod(path, 0o644)
    }
  }
  await visit(root).catch(() => undefined)
}

interface Fixture {
  readonly workspaceRoot: string
  readonly member: string
  readonly mountPath: string
  readonly mountIdentity: { readonly dev: number; readonly ino: number }
  readonly metadata: OwnedCpAMountMetadata
  readonly artifactA: string
  readonly artifactB: string
  readonly artifactC: string
  readonly cpPath: string
  readonly mvPath: string
}

const makeArtifact = async (path: string, content: string): Promise<void> => {
  await mkdir(NodePath.join(path, 'nested'), { recursive: true })
  await writeFile(
    NodePath.join(path, 'bundle.js'),
    `${content}
`,
  )
  await writeFile(
    NodePath.join(path, 'nested', 'chunk.js'),
    `chunk-${content}
`,
  )
  await chmod(NodePath.join(path, 'bundle.js'), 0o444)
  await chmod(NodePath.join(path, 'nested', 'chunk.js'), 0o444)
  await chmod(NodePath.join(path, 'nested'), 0o755)
  await chmod(path, 0o755)
}

const makeFixture = ({ withSymlinkParent = false }: { withSymlinkParent?: boolean } = {}) =>
  Effect.gen(function* () {
    const workspaceRoot = yield* makeCanonicalTempDirectoryScoped()
    const member = 'dep'
    const mountPath = NodePath.join(workspaceRoot, 'repos', member)
    const artifactA = NodePath.join(workspaceRoot, 'artifacts', 'a')
    const artifactB = NodePath.join(workspaceRoot, 'artifacts', 'b')
    const artifactC = NodePath.join(workspaceRoot, 'artifacts', 'c')
    yield* Effect.promise(async () => {
      await mkdir(NodePath.join(mountPath, 'dir'), { recursive: true })
      await writeFile(NodePath.join(mountPath, 'base.txt'), 'base\n')
      await chmod(NodePath.join(mountPath, 'base.txt'), 0o444)
      if (withSymlinkParent === true) await symlink('dir', NodePath.join(mountPath, 'link'))
      await chmod(NodePath.join(mountPath, 'dir'), 0o555)
      await chmod(mountPath, 0o555)
      await makeArtifact(artifactA, 'A')
      await makeArtifact(artifactB, 'B')
      await makeArtifact(artifactC, 'C')
    })
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => makeWritable(workspaceRoot)).pipe(Effect.ignore),
    )
    const declaredOverlays =
      withSymlinkParent === true
        ? [{ target: '//pkg:dist', destination: 'link/dist' }]
        : [
            { target: '//pkg:dist', destination: 'dir/dist' },
            { target: '//pkg:docs', destination: 'dir/docs' },
          ]
    const scan = yield* scanR6ProtectedMount({ root: mountPath, declaredOverlays })
    const metadata = makeOwnedCpAMountMetadata({
      member,
      lockedCommit: 'a'.repeat(40),
      sourcePathIdentity: `sha256:${'b'.repeat(64)}`,
      publishedPath: mountPath,
      declaredOverlays,
      scan,
    })
    yield* writeOwnedCpAMountMetadata({ workspaceRoot, metadata })
    const mountInfo = yield* Effect.promise(() => lstat(mountPath))
    const { cpPath, mvPath } = yield* Effect.promise(() => resolvePinnedCoreutils())
    return {
      workspaceRoot,
      member,
      mountPath,
      mountIdentity: { dev: mountInfo.dev, ino: mountInfo.ino },
      metadata,
      artifactA,
      artifactB,
      artifactC,
      cpPath,
      mvPath,
    } satisfies Fixture
  })

const requestFor = ({
  fixture,
  metadata = fixture.metadata,
  artifactPath = fixture.artifactA,
  target = '//pkg:dist',
  destination = 'dir/dist',
  dryRun = false,
}: {
  fixture: Fixture
  metadata?: OwnedCpAMountMetadata
  artifactPath?: string | null
  target?: string
  destination?: string
  dryRun?: boolean
}): DistOverlayPublishRequest => ({
  workspaceRoot: fixture.workspaceRoot,
  member: fixture.member,
  expectedMountIdentity: fixture.mountIdentity,
  expectedMetadata: metadata,
  target,
  destination,
  artifactPath,
  cpPath: fixture.cpPath,
  mvPath: fixture.mvPath,
  dryRun,
})

const runtime = (options: Partial<DistOverlayRuntime> = {}): DistOverlayRuntime => ({
  assertUpdateLockOwned: async () => undefined,
  nonce: () => 'test',
  ...options,
})

const TransactionJson = Schema.fromJsonString(DistOverlayTransaction, { space: 2 })

const fsyncRecorder = (
  reasons: Array<DistOverlayDirectorySyncReason>,
): Partial<DistOverlayRuntime> => ({
  directoryFsync: async ({ reason, sync }) => {
    reasons.push(reason)
    await sync()
  },
})

const recover = (fixture: Fixture, options: Partial<DistOverlayRuntime> = {}) =>
  recoverDistOverlay({
    request: {
      workspaceRoot: fixture.workspaceRoot,
      member: fixture.member,
      target: '//pkg:dist',
      destination: 'dir/dist',
      expectedMountIdentity: fixture.mountIdentity,
      mvPath: fixture.mvPath,
    },
    runtime: runtime(options),
  })

describe('dist overlay lifecycle', () => {
  it.effect(
    'first-publishes, updates, removes, and preserves repository R6 identity',
    Effect.fnUntraced(function* () {
      const fixture = yield* makeFixture()
      const first = yield* publishDistOverlay({
        request: requestFor({ fixture }),
        runtime: runtime(),
      })
      expect(first._tag).toBe('Published')
      if (first._tag !== 'Published') return
      expect(first.operation).toBe('FirstPublish')
      expect(
        yield* Effect.promise(() =>
          readFile(NodePath.join(fixture.mountPath, 'dir/dist/bundle.js'), 'utf8'),
        ),
      ).toBe('A\n')
      expect(first.metadata.overlays).toHaveLength(1)
      expect(first.metadata.repository).toEqual(fixture.metadata.repository)

      const update = yield* publishDistOverlay({
        request: requestFor({ fixture, metadata: first.metadata, artifactPath: fixture.artifactB }),
        runtime: runtime(),
      })
      expect(update._tag).toBe('Published')
      if (update._tag !== 'Published') return
      expect(update.operation).toBe('Update')
      expect(
        yield* Effect.promise(() =>
          readFile(NodePath.join(fixture.mountPath, 'dir/dist/bundle.js'), 'utf8'),
        ),
      ).toBe('B\n')
      expect(update.metadata.repository).toEqual(fixture.metadata.repository)

      const remove = yield* publishDistOverlay({
        request: requestFor({ fixture, metadata: update.metadata, artifactPath: null }),
        runtime: runtime(),
      })
      expect(remove._tag).toBe('Published')
      if (remove._tag !== 'Published') return
      expect(remove.operation).toBe('Remove')
      expect(remove.metadata.overlays).toEqual([])
      expect(
        yield* Effect.promise(() =>
          lstat(NodePath.join(fixture.mountPath, 'dir/dist')).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false)
      const finalScan = yield* scanR6ProtectedMount({
        root: fixture.mountPath,
        declaredOverlays: remove.metadata.declaredOverlays,
      })
      expect(finalScan.repository.digest).toBe(fixture.metadata.repository.digest)
    }, withNode),
  )

  it.effect(
    'publishes multiple declared overlays independently and dry-run mutates nothing',
    Effect.fnUntraced(function* () {
      const fixture = yield* makeFixture()
      const dryRun = yield* publishDistOverlay({
        request: requestFor({ fixture, dryRun: true }),
        runtime: runtime(),
      })
      expect(dryRun._tag).toBe('DryRun')
      expect(
        yield* Effect.promise(() =>
          lstat(NodePath.join(fixture.mountPath, 'dir/dist')).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false)
      expect(
        yield* Effect.promise(() =>
          lstat(
            distOverlayTransactionPath({
              workspaceRoot: fixture.workspaceRoot,
              member: fixture.member,
              destination: 'dir/dist',
            }),
          ).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false)

      const first = yield* publishDistOverlay({
        request: requestFor({ fixture }),
        runtime: runtime(),
      })
      if (first._tag !== 'Published') return
      const second = yield* publishDistOverlay({
        request: requestFor({
          fixture,
          metadata: first.metadata,
          artifactPath: fixture.artifactC,
          target: '//pkg:docs',
          destination: 'dir/docs',
        }),
        runtime: runtime({ nonce: () => 'docs' }),
      })
      expect(second._tag).toBe('Published')
      if (second._tag !== 'Published') return
      expect(second.metadata.overlays.map((item) => item.destination)).toEqual([
        'dir/dist',
        'dir/docs',
      ])
      expect(second.metadata.repository).toEqual(fixture.metadata.repository)
    }, withNode),
  )

  it.effect(
    'rolls publication back when atomic metadata publication fails',
    Effect.fnUntraced(function* () {
      const fixture = yield* makeFixture()
      const result = yield* publishDistOverlay({
        request: requestFor({ fixture }),
        runtime: runtime({
          beforeMetadataWrite: async () => {
            throw new Error('fault')
          },
        }),
      }).pipe(Effect.result)
      expect(result._tag).toBe('Failure')
      if (result._tag === 'Failure') expect(result.failure.reason).toBe('MetadataPublishFailed')
      expect(
        yield* Effect.promise(() =>
          lstat(NodePath.join(fixture.mountPath, 'dir/dist')).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false)
      expect(
        yield* Effect.promise(() =>
          lstat(
            distOverlayTransactionPath({
              workspaceRoot: fixture.workspaceRoot,
              member: fixture.member,
              destination: 'dir/dist',
            }),
          ).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false)
    }, withNode),
  )

  it.effect(
    'recovers faults at every first-publish transaction boundary from observed state',
    Effect.fnUntraced(function* () {
      const phases = [
        'Intent',
        'CandidateCreated',
        'CandidateValidated',
        'Published',
        'MetadataPublished',
      ] as const
      for (const phase of phases) {
        const fixture = yield* makeFixture()
        const publish = yield* publishDistOverlay({
          request: requestFor({ fixture }),
          runtime: runtime({
            afterPhase: async (actual) => {
              if (actual === phase) throw new Error(`fault-${phase}`)
            },
          }),
        }).pipe(Effect.result)
        expect(publish._tag).toBe('Failure')
        const recovered = yield* recover(fixture)
        expect(recovered._tag).toBe('Recovered')
        if (recovered._tag !== 'Recovered') continue
        expect(recovered.action).toBe(
          phase === 'MetadataPublished' ? 'RolledForward' : 'RolledBack',
        )
      }
    }, withNode),
  )

  it.effect(
    'rolls forward an update interrupted at Cleanup',
    Effect.fnUntraced(function* () {
      const fixture = yield* makeFixture()
      const first = yield* publishDistOverlay({
        request: requestFor({ fixture }),
        runtime: runtime(),
      })
      if (first._tag !== 'Published') return
      const interrupted = yield* publishDistOverlay({
        request: requestFor({ fixture, metadata: first.metadata, artifactPath: fixture.artifactB }),
        runtime: runtime({
          afterPhase: async (phase) => {
            if (phase === 'Cleanup') throw new Error('fault')
          },
        }),
      }).pipe(Effect.result)
      expect(interrupted._tag).toBe('Failure')
      const recovered = yield* recover(fixture)
      expect(recovered).toMatchObject({ _tag: 'Recovered', action: 'RolledForward' })
      expect(
        yield* Effect.promise(() =>
          readFile(NodePath.join(fixture.mountPath, 'dir/dist/bundle.js'), 'utf8'),
        ),
      ).toBe('B\n')
    }, withNode),
  )

  it.effect(
    'refuses undeclared destinations, symlink parents, and foreign overlay replacement',
    Effect.fnUntraced(function* () {
      const fixture = yield* makeFixture()
      const undeclared = yield* publishDistOverlay({
        request: requestFor({ fixture, target: '//other:dist', destination: 'dir/other' }),
        runtime: runtime(),
      }).pipe(Effect.result)
      expect(undeclared._tag).toBe('Failure')
      if (undeclared._tag === 'Failure')
        expect(undeclared.failure.reason).toBe('UndeclaredDestination')

      const symlinkFixture = yield* makeFixture({ withSymlinkParent: true })
      const symlinkResult = yield* publishDistOverlay({
        request: requestFor({ fixture: symlinkFixture, destination: 'link/dist' }),
        runtime: runtime(),
      }).pipe(Effect.result)
      expect(symlinkResult._tag).toBe('Failure')
      if (symlinkResult._tag === 'Failure')
        expect(symlinkResult.failure.reason).toBe('DestinationRefused')

      const first = yield* publishDistOverlay({
        request: requestFor({ fixture }),
        runtime: runtime(),
      })
      if (first._tag !== 'Published') return
      const destination = NodePath.join(fixture.mountPath, 'dir/dist')
      yield* Effect.promise(async () => {
        const parent = NodePath.dirname(destination)
        const oldDestination = `${destination}.owned-old`
        await chmod(parent, 0o755)
        await chmod(destination, 0o755)
        await rename(destination, oldDestination)
        await chmod(oldDestination, 0o555)
        await mkdir(destination)
        await writeFile(NodePath.join(destination, 'foreign.txt'), 'foreign\n')
        await chmod(NodePath.join(destination, 'foreign.txt'), 0o444)
        await chmod(destination, 0o555)
        await chmod(parent, 0o555)
      })
      const foreign = yield* publishDistOverlay({
        request: requestFor({ fixture, metadata: first.metadata, artifactPath: fixture.artifactB }),
        runtime: runtime(),
      }).pipe(Effect.result)
      expect(foreign._tag).toBe('Failure')
    }, withNode),
  )

  it.effect(
    'refuses recovery after a foreign destination replacement and enforces the caller lock',
    Effect.fnUntraced(function* () {
      const fixture = yield* makeFixture()
      const lockFailure = yield* publishDistOverlay({
        request: requestFor({ fixture }),
        runtime: runtime({
          assertUpdateLockOwned: async () => {
            throw new Error('not-held')
          },
        }),
      }).pipe(Effect.result)
      expect(lockFailure._tag).toBe('Failure')
      if (lockFailure._tag === 'Failure')
        expect(lockFailure.failure.reason).toBe('UpdateLockNotOwned')

      const interrupted = yield* publishDistOverlay({
        request: requestFor({ fixture }),
        runtime: runtime({
          afterPhase: async (phase) => {
            if (phase === 'Published') throw new Error('fault')
          },
        }),
      }).pipe(Effect.result)
      expect(interrupted._tag).toBe('Failure')
      const destination = NodePath.join(fixture.mountPath, 'dir/dist')
      yield* Effect.promise(async () => {
        const parent = NodePath.dirname(destination)
        await chmod(parent, 0o755)
        await chmod(destination, 0o755)
        await rename(destination, `${destination}.interrupted-owned`)
        await mkdir(destination)
        await writeFile(NodePath.join(destination, 'foreign.txt'), 'foreign\n')
        await chmod(NodePath.join(destination, 'foreign.txt'), 0o444)
        await chmod(destination, 0o555)
        await chmod(parent, 0o555)
      })
      const recovery = yield* recover(fixture).pipe(Effect.result)
      expect(recovery._tag).toBe('Failure')
      if (recovery._tag === 'Failure') expect(recovery.failure.reason).toBe('AmbiguousRecovery')
    }, withNode),
  )

  it.effect(
    'rejects a forged outside recovery destination before observing or mutating it',
    Effect.fnUntraced(function* () {
      const fixture = yield* makeFixture()
      const interrupted = yield* publishDistOverlay({
        request: requestFor({ fixture }),
        runtime: runtime({
          afterPhase: async (phase) => {
            if (phase === 'CandidateValidated') throw new Error('fault')
          },
        }),
      }).pipe(Effect.result)
      expect(interrupted._tag).toBe('Failure')
      const transactionPath = distOverlayTransactionPath({
        workspaceRoot: fixture.workspaceRoot,
        member: fixture.member,
        destination: 'dir/dist',
      })
      const transaction = yield* Schema.decodeEffect(TransactionJson)(
        yield* Effect.promise(() => readFile(transactionPath, 'utf8')),
      )
      const outsidePath = NodePath.join(fixture.workspaceRoot, 'forged-outside')
      const forgedTransaction = yield* Schema.encodeEffect(TransactionJson)({
        ...transaction,
        destinationPath: outsidePath,
      })
      yield* Effect.promise(async () => {
        await chmod(transaction.stagePath, 0o755)
        await rename(transaction.stagePath, outsidePath)
        await chmod(outsidePath, 0o555)
        await writeFile(
          transactionPath,
          `${forgedTransaction}
`,
        )
      })
      const before = yield* Effect.promise(() => lstat(outsidePath))
      const recovery = yield* recover(fixture).pipe(Effect.result)
      expect(recovery._tag).toBe('Failure')
      if (recovery._tag === 'Failure') expect(recovery.failure.reason).toBe('AmbiguousRecovery')
      const after = yield* Effect.promise(() => lstat(outsidePath))
      expect({ dev: after.dev, ino: after.ino, mode: after.mode & 0o777 }).toEqual({
        dev: before.dev,
        ino: before.ino,
        mode: 0o555,
      })
      expect(
        yield* Effect.promise(() => readFile(NodePath.join(outsidePath, 'bundle.js'), 'utf8')),
      ).toBe('A\n')
    }, withNode),
  )

  it.effect(
    'fsyncs both move parents before phase advance and the stage parent after cleanup',
    Effect.fnUntraced(function* () {
      const fixture = yield* makeFixture()
      const publishReasons: Array<DistOverlayDirectorySyncReason> = []
      const first = yield* publishDistOverlay({
        request: requestFor({ fixture }),
        runtime: runtime(fsyncRecorder(publishReasons)),
      })
      expect(publishReasons).toEqual(['PublishDestinationParent', 'PublishStageParent'])
      if (first._tag !== 'Published') return

      const updateReasons: Array<DistOverlayDirectorySyncReason> = []
      const update = yield* publishDistOverlay({
        request: requestFor({ fixture, metadata: first.metadata, artifactPath: fixture.artifactB }),
        runtime: runtime(fsyncRecorder(updateReasons)),
      })
      expect(updateReasons).toEqual([
        'PublishDestinationParent',
        'PublishStageParent',
        'CleanupStageParent',
      ])
      if (update._tag !== 'Published') return

      const rollbackFixture = yield* makeFixture()
      const rollbackReasons: Array<DistOverlayDirectorySyncReason> = []
      yield* publishDistOverlay({
        request: requestFor({ fixture: rollbackFixture }),
        runtime: runtime({
          ...fsyncRecorder(rollbackReasons),
          beforeMetadataWrite: async () => {
            throw new Error('metadata-fault')
          },
        }),
      }).pipe(Effect.result)
      expect(rollbackReasons).toEqual([
        'PublishDestinationParent',
        'PublishStageParent',
        'RollbackDestinationParent',
        'RollbackStageParent',
        'CleanupStageParent',
      ])

      const recoveryFixture = yield* makeFixture()
      yield* publishDistOverlay({
        request: requestFor({ fixture: recoveryFixture }),
        runtime: runtime({
          afterPhase: async (phase) => {
            if (phase === 'Published') throw new Error('publish-fault')
          },
        }),
      }).pipe(Effect.result)
      const recoveryReasons: Array<DistOverlayDirectorySyncReason> = []
      const recovered = yield* recover(recoveryFixture, fsyncRecorder(recoveryReasons))
      expect(recovered).toMatchObject({ _tag: 'Recovered', action: 'RolledBack' })
      expect(recoveryReasons).toEqual([
        'RecoveryDestinationParent',
        'RecoveryStageParent',
        'CleanupStageParent',
      ])
    }, withNode),
  )

  it.effect(
    'retains recoverable transactions when publish, rollback, recovery, or cleanup fsync fails',
    Effect.fnUntraced(function* () {
      const publishFixture = yield* makeFixture()
      const publishFailure = yield* publishDistOverlay({
        request: requestFor({ fixture: publishFixture }),
        runtime: runtime({
          directoryFsync: async ({ reason, sync }) => {
            if (reason === 'PublishStageParent') throw new Error('fsync-fault')
            await sync()
          },
        }),
      }).pipe(Effect.result)
      expect(publishFailure._tag).toBe('Failure')
      expect(yield* recover(publishFixture)).toMatchObject({
        _tag: 'Recovered',
        action: 'RolledBack',
      })

      const rollbackFixture = yield* makeFixture()
      const rollbackFailure = yield* publishDistOverlay({
        request: requestFor({ fixture: rollbackFixture }),
        runtime: runtime({
          beforeMetadataWrite: async () => {
            throw new Error('metadata-fault')
          },
          directoryFsync: async ({ reason, sync }) => {
            if (reason === 'RollbackStageParent') throw new Error('fsync-fault')
            await sync()
          },
        }),
      }).pipe(Effect.result)
      expect(rollbackFailure._tag).toBe('Failure')
      expect(yield* recover(rollbackFixture)).toMatchObject({
        _tag: 'Recovered',
        action: 'RolledBack',
      })

      const recoveryFixture = yield* makeFixture()
      yield* publishDistOverlay({
        request: requestFor({ fixture: recoveryFixture }),
        runtime: runtime({
          afterPhase: async (phase) => {
            if (phase === 'Published') throw new Error('publish-fault')
          },
        }),
      }).pipe(Effect.result)
      const recoveryFailure = yield* recover(recoveryFixture, {
        directoryFsync: async ({ reason, sync }) => {
          if (reason === 'RecoveryStageParent') throw new Error('fsync-fault')
          await sync()
        },
      }).pipe(Effect.result)
      expect(recoveryFailure._tag).toBe('Failure')
      expect(yield* recover(recoveryFixture)).toMatchObject({
        _tag: 'Recovered',
        action: 'RolledBack',
      })

      const cleanupFixture = yield* makeFixture()
      const cleanupFirst = yield* publishDistOverlay({
        request: requestFor({ fixture: cleanupFixture }),
        runtime: runtime(),
      })
      if (cleanupFirst._tag !== 'Published') return
      const cleanupFailure = yield* publishDistOverlay({
        request: requestFor({
          fixture: cleanupFixture,
          metadata: cleanupFirst.metadata,
          artifactPath: cleanupFixture.artifactB,
        }),
        runtime: runtime({
          directoryFsync: async ({ reason, sync }) => {
            if (reason === 'CleanupStageParent') throw new Error('fsync-fault')
            await sync()
          },
        }),
      }).pipe(Effect.result)
      expect(cleanupFailure._tag).toBe('Failure')
      expect(yield* recover(cleanupFixture)).toMatchObject({
        _tag: 'Recovered',
        action: 'RolledForward',
      })
    }, withNode),
  )

  it.effect(
    'refuses a mount exchange at the immediate publication boundary',
    Effect.fnUntraced(function* () {
      const fixture = yield* makeFixture()
      const replacement = `${fixture.mountPath}.replacement`
      const result = yield* publishDistOverlay({
        request: requestFor({ fixture }),
        runtime: runtime({
          beforePublish: async () => {
            const exchanged = `${fixture.mountPath}.exchanged`
            await mkdir(NodePath.join(replacement, 'dir'), { recursive: true })
            await chmod(NodePath.join(replacement, 'dir'), 0o555)
            await chmod(replacement, 0o755)
            await chmod(fixture.mountPath, 0o755)
            await rename(fixture.mountPath, exchanged)
            await rename(replacement, fixture.mountPath)
            await chmod(exchanged, 0o555)
            await chmod(fixture.mountPath, 0o555)
          },
        }),
      }).pipe(Effect.result)
      expect(result._tag).toBe('Failure')
      if (result._tag === 'Failure') expect(result.failure.reason).toBe('MountIdentityMismatch')
    }, withNode),
  )
})
