import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as NodePath from 'node:path'

import { describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { expect } from 'vitest'

import type { BuckMemberCapability, BuckMemberManifest } from '@overeng/megarepo/buck2-manifest'

import { CompositionGeneratorConfig, EffectPath } from '../../core/config.ts'
import type { OwnedCpAMountMetadata } from '../mounts/member-mount-r6.ts'
import { type CompositionApplyRequest } from './composition-apply-schema.ts'
import {
  buildCompositionDistOverlay,
  compositionApply,
  type CompositionApplyPrimitives,
  type CompositionMountedMemberInspection,
  type CompositionApplyRuntime,
} from './composition-apply.ts'

const digest = `sha256:${'b'.repeat(64)}`
const commit = 'b'.repeat(40)
const protocol = 'facebook/buck2-cli/2026-08-22'

const memberManifest = ({
  key,
  cell = key,
  buck = false,
  overlays = 0,
}: {
  readonly key: string
  readonly cell?: string
  readonly buck?: boolean
  readonly overlays?: number
}): BuckMemberManifest => ({
  schemaVersion: 1,
  cell,
  mount: `repos/${key}`,
  projectIgnore: [],
  capabilities:
    buck === true
      ? [{ toolId: 'buck2', protocol, flakePackage: 'buck2', executable: 'bin/buck2' }]
      : [],
  distOverlays: Array.from({ length: overlays }, (_, index) => ({
    target: `//pkg:dist${index}`,
    destination: `pkg/dist${index}`,
  })),
})

const mountMetadata = ({
  workspaceRoot,
  key,
  manifest,
}: {
  readonly workspaceRoot: string
  readonly key: string
  readonly manifest: BuckMemberManifest
}): OwnedCpAMountMetadata => ({
  version: 2,
  member: key,
  lockedCommit: commit,
  sourcePathIdentity: digest,
  repository: { digest, count: 1 },
  capabilities: { present: true, digest, count: 1 },
  declaredOverlays: manifest.distOverlays,
  overlays: [],
  publishedPath: NodePath.join(workspaceRoot, 'repos', key),
})

interface FixtureOptions {
  readonly members?: ReadonlyArray<{ readonly key: string; readonly overlays: number }>
  readonly rootMode?: 'first' | 'update' | 'nochange' | 'overlay-failure'
  readonly capabilityFailure?: string
  readonly mountFailure?: string
  readonly lockFailure?: boolean
  readonly allowDarwin?: boolean
  readonly recovery?: boolean
  readonly releaseFailures?: ReadonlyArray<string>
}

const fixture = async (options: FixtureOptions = {}) => {
  const root = await mkdtemp(NodePath.join(tmpdir(), 'composition-apply-'))
  const workspaceRoot = NodePath.join(root, 'workspace')
  const ownedPath = NodePath.join(workspaceRoot, 'repos', 'owned')
  const locked = options.members ?? [{ key: 'dep', overlays: 1 }]
  const manifests = new Map<string, BuckMemberManifest>([
    [ownedPath, memberManifest({ key: 'owned', cell: 'z_owned', buck: true })],
    ...locked.map(
      ({ key, overlays }, index) =>
        [
          NodePath.join(root, 'store', key),
          memberManifest({ key, cell: `${String.fromCharCode(97 + index)}_${key}`, overlays }),
        ] as const,
    ),
  ])
  const request: CompositionApplyRequest = {
    workspaceRoot,
    ownedMemberKey: 'owned',
    ownedMemberPath: ownedPath,
    compositionConfig: new CompositionGeneratorConfig({
      platformHub: 'owned',
      isolationDir: 'fixed',
    }),
    cacheSections: [],
    lockedMembers: locked.map(({ key }) => ({
      key,
      sourcePath: NodePath.join(root, 'store', key),
      lockedCommit: commit,
    })),
    dryRun: false,
    allowVerifiedDarwinAdvance: options.allowDarwin ?? false,
  }
  const calls: Array<string> = []
  const inspections = new Map<string, CompositionMountedMemberInspection>(
    locked.map(({ key }) => {
      const manifest = manifests.get(NodePath.join(root, 'store', key))!
      return [
        key,
        {
          identity: { dev: 1, ino: key.length + 10 },
          metadata: mountMetadata({ workspaceRoot, key, manifest }),
        },
      ] as const
    }),
  )
  let scratchIndex = 0

  const primitives: CompositionApplyPrimitives = {
    assertLockedSourceClean: async () => {},
    readManifest: async (path) => manifests.get(path)!,
    pathExists: async (path) =>
      options.recovery === true &&
      (path.includes('/transactions/') || path.includes('/overlay-transactions/')),
    acquireUpdateLock: async () => {
      calls.push('lock:acquire')
      if (options.lockFailure === true) throw new Error('contended')
      return {
        workspaceRoot,
        lockPath: NodePath.join(workspaceRoot, '.megarepo/workspace-update.lock'),
        ownerPath: NodePath.join(workspaceRoot, '.megarepo/.owner'),
        owner: { schema: 1, token: 'd'.repeat(32), pid: 1 },
        bytes: '{}\n',
        dev: 1,
        ino: 1,
      }
    },
    releaseUpdateLock: async () => {
      calls.push('lock:release')
      if (options.releaseFailures?.includes('lock') === true) throw new Error('lock release failed')
    },
    resolveCapabilities: async (input) => {
      const resolvedManifest = manifests.get(input.memberRoot)!
      const key = resolvedManifest.mount.slice('repos/'.length)
      calls.push(`cap:${key}`)
      if (options.capabilityFailure === key) throw new Error('capability failed')
      const executablePath =
        key === 'owned' ? '/nix/store/buck/bin/buck2' : `/nix/store/${key}/bin/tool`
      const executableCapability =
        key === 'owned'
          ? resolvedManifest.capabilities.find(
              (capability): capability is BuckMemberCapability =>
                'toolId' in capability && capability.toolId === 'buck2',
            )
          : undefined
      if (key === 'owned' && executableCapability === undefined) {
        throw new Error('owned member fixture must declare the buck2 executable capability')
      }
      const resolvedCapability =
        executableCapability === undefined
          ? undefined
          : {
              capability: executableCapability,
              nixOutputPath: '/nix/store/buck',
              executablePath,
              executableDigest: digest,
              closureStorePaths: ['/nix/store/buck'],
            }
      return {
        _tag: 'Resolved',
        system: input.system,
        projectorPlatform: 'x86_64-linux',
        candidateRoot: NodePath.join(root, 'capabilities', key, 'candidate'),
        projectionPath: NodePath.join(root, 'capabilities', key, 'candidate/.buck2/capabilities'),
        projectionDigest: 'c'.repeat(64),
        capabilities: resolvedCapability === undefined ? [] : [resolvedCapability],
        capabilitiesByToolId: resolvedCapability === undefined ? {} : { buck2: resolvedCapability },
        nixCommands: [],
        release: async () => {
          calls.push(`cap:${key}:release`)
          if (options.releaseFailures?.includes(key) === true) {
            throw new Error(`${key} capability release failed`)
          }
        },
      }
    },
    recoverMount: async ({ request: recovery }) => {
      calls.push(`recover:mount:${recovery.member}`)
      return {
        _tag: 'Recovered',
        action: 'RolledForward',
        destinationPath: NodePath.join(workspaceRoot, 'repos', recovery.member),
      }
    },
    planMount: async (mount) => ({
      memberKey: mount.memberKey,
      sourcePath: mount.sourcePath,
      capabilitiesPath: mount.capabilitiesPath,
      destinationPath: NodePath.join(workspaceRoot, 'repos', mount.memberKey),
      lockedCommit: mount.lockedCommit,
      distOverlays: mount.distOverlays,
      allowVerifiedDarwinAdvance: mount.allowVerifiedDarwinAdvance,
      operation: 'MaterializeOrAdvance',
      steps: [
        'ValidateImmutableSource',
        'UseResolvedCapabilityProjection',
        'MaterializeCpAMemberMount',
      ],
    }),
    materializeMount: async ({ request: mount }) => {
      calls.push(`mount:${mount.member}:${mount.allowVerifiedDarwinAdvance}`)
      if (options.mountFailure === mount.member) throw new Error('mount failed')
      const manifest = manifests.get(mount.sourcePath)!
      return {
        _tag: 'Published',
        operation: 'FirstPublish',
        destinationPath: NodePath.join(workspaceRoot, 'repos', mount.member),
        metadata: mountMetadata({ workspaceRoot, key: mount.member, manifest }),
      }
    },
    listPublishedMemberKeys: async () => [],
    teardownMount: async () => {
      throw new Error('unexpected teardown')
    },
    inspectMountedMember: async ({ memberKey }) => inspections.get(memberKey)!,
    recoverOverlay: async ({ request: recovery }) => {
      calls.push(`recover:overlay:${recovery.member}:${recovery.target}`)
      return {
        _tag: 'Recovered',
        action: 'RolledForward',
        destinationPath: NodePath.join(
          workspaceRoot,
          'repos',
          recovery.member,
          recovery.destination,
        ),
      }
    },
    publishOverlay: async ({ request: overlay }) => {
      calls.push(`overlay:${overlay.member}:${overlay.target}`)
      if (options.rootMode === 'overlay-failure') throw new Error('overlay failed')
      const next = {
        ...overlay.expectedMetadata,
        overlays: [
          ...overlay.expectedMetadata.overlays,
          { target: overlay.target, destination: overlay.destination, digest, count: 1 },
        ],
      }
      inspections.set(overlay.member, { identity: overlay.expectedMountIdentity, metadata: next })
      return {
        _tag: 'Published',
        operation: 'FirstPublish',
        destinationPath: NodePath.join(workspaceRoot, 'repos', overlay.member, overlay.destination),
        metadata: next,
      }
    },
    planOverlay: async ({ memberKey, declaration }) => ({
      memberKey,
      target: declaration.target,
      destination: declaration.destination,
      operation: 'FirstPublish',
      steps: [
        'BuildDeclaredDirectory',
        'ValidateRealDirectory',
        'PublishDistOverlay',
        'CleanupScratch',
      ],
    }),
    planRoot: async () =>
      options.rootMode === 'first'
        ? { _tag: 'Create', files: [], configLast: true }
        : options.rootMode === 'update'
          ? { _tag: 'Update', files: [], configLast: true }
          : { _tag: 'NoChange', files: [], configLast: true },
    publishRoot: async (input) => {
      calls.push(`root:start:${input.configMemberKeys.join(',')}`)
      for (const [path, manifest] of manifests) {
        const key = manifest.mount.slice('repos/'.length)
        if (key === 'owned' || input.configMemberKeys.includes(key) === true) {
          await input.runtime.assertCapabilityProjection({
            workspaceRoot: EffectPath.unsafe.absoluteDir(`${workspaceRoot}/`),
            memberKey: key,
            memberRoot: key === 'owned' ? path : NodePath.join(workspaceRoot, 'repos', key),
            manifest,
            owned: key === 'owned',
          })
        }
      }
      if (options.rootMode === 'nochange') {
        calls.push('root:nochange')
        return { changedPaths: [], memberManifests: [] }
      }
      try {
        calls.push('root:authority')
        await input.afterAuthorityPublished?.()
        calls.push('root:commit')
        return { changedPaths: ['.buckconfig'], memberManifests: [] }
      } catch (cause) {
        calls.push('root:rollback')
        throw cause
      }
    },
  }

  const runtime: CompositionApplyRuntime = {
    ownedCapabilityProjection: {
      plan: async (input) => ({
        ...input,
        operation: 'InstallOwnedCapabilityProjection',
        steps: ['ValidateOwnedMember', 'InstallProjectionAtomically', 'CheckProjection'],
      }),
      install: async (input) => {
        calls.push(`owned:${input.memberKey}:install`)
        return {
          memberKey: input.memberKey,
          projectionPath: input.projectionPath,
          projectionDigest: input.projectionDigest,
          changed: true,
        }
      },
    },
    system: options.allowDarwin === true ? 'aarch64-darwin' : 'x86_64-linux',
    platform: options.allowDarwin === true ? 'darwin' : 'linux',
    buck2Path: '/nix/store/buck/bin/buck2',
    buck2Protocol: protocol,
    capabilityRuntime: {
      nixPath: '/bin/nix',
    },
    mountRuntime: { cpPath: '/bin/cp', mvPath: '/bin/mv', capabilityCheck: async () => {} },
    mountRecoveryRuntime: { mvPath: '/bin/mv' },
    publisherRuntime: {
      assertCapabilityProjection: async ({ memberKey }) => {
        calls.push(`publisher:cap:${memberKey}`)
      },
    },
    publisherLock: { owner: 'test', token: 'publisher-token' },
    overlayRuntime: {
      assertUpdateLockOwned: async () => {
        calls.push('overlay:lock-check')
      },
    },
    overlayScratch: {
      planOutputPath: ({ memberKey, target }) =>
        NodePath.join(root, `plan-${memberKey}-${target.length}`),
      create: async ({ memberKey }) => {
        const outputPath = NodePath.join(root, `overlay-${scratchIndex++}-${memberKey}`)
        calls.push(`scratch:${memberKey}:create`)
        return {
          outputPath,
          cleanup: async () => {
            calls.push(`scratch:${memberKey}:cleanup`)
            await rm(outputPath, { recursive: true, force: true })
          },
        }
      },
    },
    updateLockRuntime: {},
    runBuck: async (argv) => {
      calls.push(`buck:${argv.join('|')}`)
      await mkdir(argv.at(-1)!, { recursive: true })
    },
    primitives,
  }

  return {
    root,
    request,
    runtime,
    calls,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

describe('composition apply integration', () => {
  it('rejects a symlink Buck output and preserves the fixed daemon policy', async () => {
    const root = await mkdtemp(NodePath.join(tmpdir(), 'composition-build-'))
    const outputPath = NodePath.join(root, 'output')
    const real = NodePath.join(root, 'real')
    await mkdir(real)
    try {
      const result = await buildCompositionDistOverlay({
        plan: {
          memberKey: 'dep',
          target: '//pkg:dist',
          destination: 'pkg/dist',
          canonicalLabel: 'dep//pkg:dist',
          executable: '/nix/store/buck/bin/buck2',
          args: ['--isolation-dir', 'fixed', 'build', 'dep//pkg:dist', '--out', outputPath],
          outputPath,
          isolationDir: 'fixed',
          daemonPolicy: 'SharedDaemonUnchanged',
          cleanup: 'RemoveScratchOnly',
        },
        runBuck: async (argv) => {
          expect(argv).toEqual([
            '/nix/store/buck/bin/buck2',
            '--isolation-dir',
            'fixed',
            'build',
            'dep//pkg:dist',
            '--out',
            outputPath,
          ])
          await symlink(real, outputPath)
        },
      }).then(
        () => undefined,
        (cause: unknown) => cause,
      )
      expect(result).toMatchObject({ reason: 'OverlayBuildFailure', phase: 'OverlayBuild' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(['first', 'update', 'nochange'] as const)(
    'bootstraps first root authority before overlays and preserves final cutover for %s',
    async (rootMode) => {
      const value = await fixture({ rootMode })
      try {
        const result = await Effect.runPromise(
          compositionApply({ request: value.request, runtime: value.runtime }),
        )
        expect(result._tag).toBe('Applied')
        expect(result.defaultCwd).toBe(value.request.ownedMemberPath)
        const overlayIndex = value.calls.findIndex((call) => call.startsWith('overlay:dep:'))
        const releaseIndex = value.calls.indexOf('lock:release')
        const rootIndex = value.calls.indexOf(
          rootMode === 'nochange' ? 'root:nochange' : 'root:authority',
        )
        if (rootMode === 'first') {
          expect(rootIndex).toBeLessThan(overlayIndex)
        } else {
          expect(rootIndex).toBeGreaterThan(overlayIndex)
        }
        expect(value.calls.indexOf('cap:owned:release')).toBeGreaterThan(overlayIndex)
        if (rootMode !== 'first') {
          expect(rootIndex).toBeGreaterThan(value.calls.indexOf('cap:owned:release'))
        }
        expect(releaseIndex).toBeGreaterThan(rootIndex)
      } finally {
        await value.cleanup()
      }
    },
  )

  it('orders multiple members and overlays and uses exact Buck argv', async () => {
    const value = await fixture({
      members: [
        { key: 'beta', overlays: 1 },
        { key: 'alpha', overlays: 2 },
      ],
    })
    try {
      await Effect.runPromise(compositionApply({ request: value.request, runtime: value.runtime }))
      expect(value.calls.filter((call) => call.startsWith('mount:'))).toEqual([
        'mount:beta:false',
        'mount:alpha:false',
      ])
      expect(value.calls.filter((call) => call.startsWith('overlay:'))).toEqual([
        'overlay:beta://pkg:dist0',
        'overlay:alpha://pkg:dist0',
        'overlay:alpha://pkg:dist1',
      ])
      for (const command of value.calls.filter((call) => call.startsWith('buck:'))) {
        expect(command).toContain('|--isolation-dir|fixed|build|')
        expect(command).toContain('|--out|')
      }
      expect(value.calls.at(-1)).toBe('lock:release')
    } finally {
      await value.cleanup()
    }
  })

  it('fails all capabilities before any mount or root mutation and releases prior scratch', async () => {
    const value = await fixture({
      members: [
        { key: 'alpha', overlays: 0 },
        { key: 'beta', overlays: 0 },
      ],
      capabilityFailure: 'beta',
    })
    try {
      const result = await Effect.runPromise(
        compositionApply({ request: value.request, runtime: value.runtime }).pipe(Effect.result),
      )
      expect(result._tag).toBe('Failure')
      expect(value.calls.some((call) => call.startsWith('mount:'))).toBe(false)
      expect(value.calls.some((call) => call.startsWith('root:'))).toBe(false)
      expect(value.calls).toContain('cap:alpha:release')
      expect(value.calls.at(-1)).toBe('lock:release')
    } finally {
      await value.cleanup()
    }
  })

  it('keeps already-published mounts and old root authority on a later mount failure', async () => {
    const value = await fixture({
      members: [
        { key: 'alpha', overlays: 0 },
        { key: 'beta', overlays: 0 },
      ],
      mountFailure: 'beta',
    })
    try {
      const result = await Effect.runPromise(
        compositionApply({ request: value.request, runtime: value.runtime }).pipe(Effect.result),
      )
      expect(result._tag).toBe('Failure')
      expect(value.calls.filter((call) => call.startsWith('mount:'))).toEqual([
        'mount:alpha:false',
        'mount:beta:false',
      ])
      expect(value.calls.some((call) => call.startsWith('root:'))).toBe(false)
      expect(value.calls.some((call) => call.includes('rollback-mount'))).toBe(false)
    } finally {
      await value.cleanup()
    }
  })

  it('does not expose root authority after overlay failure and retains source-valid mounts', async () => {
    const value = await fixture({ rootMode: 'overlay-failure' })
    try {
      const result = await Effect.runPromise(
        compositionApply({ request: value.request, runtime: value.runtime }).pipe(Effect.result),
      )
      expect(result._tag).toBe('Failure')
      expect(value.calls).toContain('mount:dep:false')
      expect(value.calls.some((call) => call.startsWith('root:'))).toBe(false)
      expect(value.calls).toContain('scratch:dep:cleanup')
      expect(value.calls.some((call) => call.includes('rollback-mount'))).toBe(false)
      expect(value.calls.at(-1)).toBe('lock:release')
    } finally {
      await value.cleanup()
    }
  })

  it('recovers mount and overlay transactions before capability or new mount work', async () => {
    const value = await fixture({ recovery: true })
    try {
      const result = await Effect.runPromise(
        compositionApply({ request: value.request, runtime: value.runtime }),
      )
      expect(result._tag).toBe('Applied')
      if (result._tag !== 'Applied') return
      expect(result.recoveries.map((recovery) => recovery._tag)).toEqual([
        'MountRecovery',
        'OverlayRecovery',
      ])
      expect(value.calls.indexOf('recover:mount:dep')).toBeLessThan(value.calls.indexOf('cap:dep'))
      expect(value.calls.indexOf('recover:overlay:dep://pkg:dist0')).toBeLessThan(
        value.calls.indexOf('cap:dep'),
      )
    } finally {
      await value.cleanup()
    }
  })

  it('preserves a primary phase failure with one capability cleanup failure', async () => {
    const value = await fixture({ mountFailure: 'dep', releaseFailures: ['owned'] })
    try {
      const result = await Effect.runPromise(
        compositionApply({ request: value.request, runtime: value.runtime }).pipe(Effect.result),
      )
      expect(result._tag).toBe('Failure')
      if (result._tag !== 'Failure') return
      expect(result.failure).toMatchObject({
        reason: 'CleanupFailure',
        primaryFailure: { reason: 'MountFailure', phase: 'Mount' },
        cleanupFailures: [{ resource: 'CapabilityScratch' }],
      })
      expect(result.failure.recoveryPaths).toContain(
        NodePath.join(value.root, 'capabilities', 'owned', 'candidate'),
      )
    } finally {
      await value.cleanup()
    }
  })

  it('aggregates primary, multiple capability cleanups, and lock recovery identity', async () => {
    const value = await fixture({
      mountFailure: 'dep',
      releaseFailures: ['owned', 'dep', 'lock'],
    })
    try {
      const result = await Effect.runPromise(
        compositionApply({ request: value.request, runtime: value.runtime }).pipe(Effect.result),
      )
      expect(result._tag).toBe('Failure')
      if (result._tag !== 'Failure') return
      expect(result.failure.reason).toBe('CleanupFailure')
      expect(result.failure.primaryFailure).toMatchObject({
        reason: 'MountFailure',
        phase: 'Mount',
      })
      expect(result.failure.cleanupFailures).toHaveLength(3)
      expect(result.failure.updateLockRecovery).toEqual({
        path: NodePath.join(value.request.workspaceRoot, '.megarepo/workspace-update.lock'),
        token: 'd'.repeat(32),
      })
      expect(result.failure.recoveryPaths).toContain(
        NodePath.join(value.request.workspaceRoot, '.megarepo/workspace-update.lock'),
      )
      expect(result.failure.cause).toBeInstanceOf(AggregateError)
    } finally {
      await value.cleanup()
    }
  })

  it('fails a successful application when update-lock cleanup fails', async () => {
    const value = await fixture({
      members: [{ key: 'dep', overlays: 0 }],
      releaseFailures: ['lock'],
    })
    try {
      const result = await Effect.runPromise(
        compositionApply({ request: value.request, runtime: value.runtime }).pipe(Effect.result),
      )
      expect(result._tag).toBe('Failure')
      if (result._tag !== 'Failure') return
      expect(result.failure.reason).toBe('CleanupFailure')
      expect(result.failure.primaryFailure).toBeUndefined()
      expect(result.failure.cleanupFailures).toEqual([
        {
          resource: 'WorkspaceUpdateLock',
          path: NodePath.join(value.request.workspaceRoot, '.megarepo/workspace-update.lock'),
          message: 'Could not release the workspace update lock',
        },
      ])
      expect(result.failure.updateLockRecovery?.token).toBe('d'.repeat(32))
    } finally {
      await value.cleanup()
    }
  })

  it('reports update-lock contention before manifests or lifecycle mutation', async () => {
    const value = await fixture({ lockFailure: true })
    try {
      const result = await Effect.runPromise(
        compositionApply({ request: value.request, runtime: value.runtime }).pipe(Effect.result),
      )
      expect(result._tag).toBe('Failure')
      if (result._tag === 'Failure') expect(result.failure.reason).toBe('UpdateLockFailure')
      expect(value.calls).toEqual(['lock:acquire'])
    } finally {
      await value.cleanup()
    }
  })

  it('propagates verified Darwin advance authorization to every mount', async () => {
    const value = await fixture({
      allowDarwin: true,
      members: [
        { key: 'alpha', overlays: 0 },
        { key: 'beta', overlays: 0 },
      ],
    })
    try {
      await Effect.runPromise(compositionApply({ request: value.request, runtime: value.runtime }))
      expect(value.calls.filter((call) => call.startsWith('mount:'))).toEqual([
        'mount:alpha:true',
        'mount:beta:true',
      ])
    } finally {
      await value.cleanup()
    }
  })
})
