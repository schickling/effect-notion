import { describe, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import { expect } from 'vitest'

import type { BuckMemberManifest } from '@overeng/megarepo/buck2-manifest'

import { CompositionGeneratorConfig } from '../../core/config.ts'
import type { OwnedCpAMountMetadata } from '../mounts/member-mount-r6.ts'
import {
  CompositionApplyRequestSchema,
  type CompositionApplyError,
  type CompositionApplyRequest,
} from './composition-apply-schema.ts'
import {
  compositionApply,
  makeCompositionOverlayBuildPlan,
  type CompositionApplyPrimitives,
  type CompositionApplyRuntime,
} from './composition-apply.ts'

const digest = `sha256:${'a'.repeat(64)}`
const commit = 'a'.repeat(40)
const buckProtocol = 'facebook/buck2-cli/2026-08-22'

const manifest = ({
  cell,
  key,
  buck = false,
  overlay = false,
}: {
  readonly cell: string
  readonly key: string
  readonly buck?: boolean
  readonly overlay?: boolean
}): BuckMemberManifest => ({
  schemaVersion: 1,
  cell,
  mount: `repos/${key}`,
  projectIgnore: [],
  distOverlays: overlay === true ? [{ target: '//pkg:dist', destination: 'pkg/dist' }] : [],
  capabilities:
    buck === true
      ? [
          {
            toolId: 'buck2',
            protocol: buckProtocol,
            flakePackage: 'buck2',
            executable: 'bin/buck2',
          },
        ]
      : [],
})

const request = (overrides: Partial<CompositionApplyRequest> = {}): CompositionApplyRequest => ({
  workspaceRoot: '/workspace',
  ownedMemberKey: 'owned',
  ownedMemberPath: '/workspace/repos/owned',
  compositionConfig: new CompositionGeneratorConfig({ platformHub: 'owned' }),
  cacheSections: [],
  lockedMembers: [{ key: 'dep', sourcePath: '/store/dep', lockedCommit: commit }],
  dryRun: true,
  allowVerifiedDarwinAdvance: false,
  ...overrides,
})

const metadata = (): OwnedCpAMountMetadata => ({
  version: 2,
  member: 'dep',
  lockedCommit: commit,
  sourcePathIdentity: digest,
  repository: { digest, count: 1 },
  capabilities: { present: true, digest, count: 1 },
  declaredOverlays: [{ target: '//pkg:dist', destination: 'pkg/dist' }],
  overlays: [],
  publishedPath: '/workspace/repos/dep',
})

const fake = ({
  calls,
  manifests = new Map([
    ['/workspace/repos/owned', manifest({ cell: 'z_owned', key: 'owned', buck: true })],
    ['/store/dep', manifest({ cell: 'a_dep', key: 'dep', overlay: true })],
  ]),
}: {
  readonly calls: Array<string>
  readonly manifests?: ReadonlyMap<string, BuckMemberManifest>
}): {
  readonly primitives: CompositionApplyPrimitives
  readonly runtime: CompositionApplyRuntime
} => {
  const primitives: CompositionApplyPrimitives = {
    assertLockedSourceClean: async () => {},
    readManifest: async (root) => {
      calls.push(`manifest:${root}`)
      const value = manifests.get(root)
      if (value === undefined) throw new Error(`missing ${root}`)
      return value
    },
    pathExists: async () => false,
    acquireUpdateLock: async () => {
      calls.push('lock:acquire')
      return {
        workspaceRoot: '/workspace',
        lockPath: '/workspace/.megarepo/workspace-update.lock',
        ownerPath: '/workspace/.megarepo/.workspace-update.owner',
        owner: { schema: 1, token: 'token', pid: 1 },
        bytes: '{}\n',
        dev: 1,
        ino: 1,
      }
    },
    releaseUpdateLock: async () => {
      calls.push('lock:release')
    },
    resolveCapabilities: async (input) => {
      const resolvedManifest = manifests.get(input.memberRoot)!
      const memberKey = resolvedManifest.mount.slice('repos/'.length)
      calls.push(`capability:${memberKey}`)
      return {
        _tag: 'Planned',
        system: input.system,
        projectorPlatform: 'x86_64-linux',
        candidateRoot: `/scratch/${memberKey}/candidate`,
        nixCommands: [],
      }
    },
    recoverMount: async () => {
      throw new Error('unexpected recovery')
    },
    planMount: async (mount) => {
      calls.push(`mount:${mount.memberKey}:plan`)
      return {
        memberKey: mount.memberKey,
        sourcePath: mount.sourcePath,
        capabilitiesPath: mount.capabilitiesPath,
        destinationPath: `/workspace/repos/${mount.memberKey}`,
        lockedCommit: mount.lockedCommit,
        distOverlays: mount.distOverlays,
        allowVerifiedDarwinAdvance: mount.allowVerifiedDarwinAdvance,
        operation: 'MaterializeOrAdvance',
        steps: [
          'ValidateImmutableSource',
          'UseResolvedCapabilityProjection',
          'MaterializeCpAMemberMount',
        ],
      }
    },
    materializeMount: async () => {
      throw new Error('unexpected materialization')
    },
    listPublishedMemberKeys: async () => [],
    teardownMount: async () => {
      throw new Error('unexpected teardown')
    },
    inspectMountedMember: async () => ({ identity: { dev: 1, ino: 2 }, metadata: metadata() }),
    recoverOverlay: async () => {
      throw new Error('unexpected recovery')
    },
    publishOverlay: async () => {
      throw new Error('unexpected publication')
    },
    planOverlay: async ({ memberKey, declaration }) => {
      calls.push(`overlay:${memberKey}:${declaration.target}:plan`)
      return {
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
      }
    },
    planRoot: async (input) => {
      calls.push(`root:plan:${input.configMemberKeys.join(',')}`)
      return { _tag: 'NoChange', files: [], configLast: true }
    },
    publishRoot: async () => {
      throw new Error('unexpected root publication')
    },
  }
  const runtime: CompositionApplyRuntime = {
    ownedCapabilityProjection: {
      plan: async (input) => {
        calls.push(`owned:${input.memberKey}:plan`)
        return {
          ...input,
          operation: 'InstallOwnedCapabilityProjection',
          steps: ['ValidateOwnedMember', 'InstallProjectionAtomically', 'CheckProjection'],
        }
      },
      install: async () => {
        throw new Error('dry-run installed owned projection')
      },
    },
    system: 'x86_64-linux',
    platform: 'linux',
    buck2Path: '/nix/store/buck/bin/buck2',
    watchmanPath: '/nix/store/watchman/bin/watchman',
    buck2Protocol: buckProtocol,
    capabilityRuntime: {
      nixPath: '/bin/nix',
    },
    mountRuntime: {
      cpPath: '/bin/cp',
      mvPath: '/bin/mv',
      capabilityCheck: async () => {},
    },
    mountRecoveryRuntime: { mvPath: '/bin/mv' },
    publisherRuntime: { assertCapabilityProjection: async () => {} },
    publisherLock: { owner: 'test', token: 'publisher-token' },
    overlayRuntime: { assertUpdateLockOwned: async () => {} },
    overlayScratch: {
      planOutputPath: ({ memberKey }) => `/scratch/plan/${memberKey}`,
      create: async () => {
        throw new Error('dry-run created scratch')
      },
    },
    updateLockRuntime: {},
    runBuck: async () => {
      throw new Error('dry-run ran Buck')
    },
    primitives,
  }
  return { primitives, runtime }
}

const failed = async (
  value: CompositionApplyRequest,
  runtime: CompositionApplyRuntime,
): Promise<CompositionApplyError> => {
  const result = await Effect.runPromise(
    compositionApply({ request: value, runtime: runtime }).pipe(Effect.result),
  )
  if (result._tag === 'Success') throw new Error('expected failure')
  return result.failure
}

describe('composition apply plan', () => {
  it('strictly rejects unknown request fields', () => {
    expect(() =>
      Schema.decodeUnknownSync(CompositionApplyRequestSchema, {
        errors: 'all',
        onExcessProperty: 'error',
      })({ ...request(), ambientPath: true }),
    ).toThrow(/ambientPath/u)
  })

  it('orders members by cell/key and returns the exact mutation-free plan', async () => {
    const calls: Array<string> = []
    const { runtime } = fake({ calls })
    const result = await Effect.runPromise(
      compositionApply({ request: request(), runtime: runtime }),
    )
    expect(result._tag).toBe('DryRun')
    if (result._tag !== 'DryRun') return
    expect(
      result.steps.map((step) => `${step._tag}:${'memberKey' in step ? step.memberKey : ''}`),
    ).toEqual([
      'Capability:dep',
      'Capability:owned',
      'OwnedCapabilityProjection:owned',
      'Mount:dep',
      'Root:',
      'Overlay:dep',
    ])
    expect(calls).toEqual([
      'manifest:/workspace/repos/owned',
      'manifest:/store/dep',
      'capability:dep',
      'capability:owned',
      'owned:owned:plan',
      'mount:dep:plan',
      'root:plan:dep,owned',
      'overlay:dep://pkg:dist:plan',
    ])
    expect(result.defaultCwd).toBe('/workspace/repos/owned')
    const overlay = result.steps.at(-1)
    expect(overlay?._tag).toBe('Overlay')
    if (overlay?._tag === 'Overlay') {
      expect([overlay.build.executable, ...overlay.build.args]).toEqual([
        '/nix/store/buck/bin/buck2',
        '--isolation-dir',
        'megarepo',
        'build',
        'a_dep//pkg:dist',
        '--out',
        '/scratch/plan/dep',
      ])
    }
  })

  it('constructs only the fixed Buck argv', () => {
    const calls: Array<string> = []
    const { runtime } = fake({ calls })
    const plan = makeCompositionOverlayBuildPlan({
      runtime,
      member: { key: 'dep', manifest: manifest({ cell: 'dep_cell', key: 'dep' }) },
      target: '//pkg:dist',
      destination: 'pkg/dist',
      outputPath: '/scratch/output',
      isolationDir: 'fixed',
    })
    expect([plan.executable, ...plan.args]).toEqual([
      '/nix/store/buck/bin/buck2',
      '--isolation-dir',
      'fixed',
      'build',
      'dep_cell//pkg:dist',
      '--out',
      '/scratch/output',
    ])
    expect(plan.daemonPolicy).toBe('SharedDaemonUnchanged')
    expect(plan.cleanup).toBe('RemoveScratchOnly')
  })

  it('rejects Darwin case-fold collisions before any effects', async () => {
    const ownedCalls: Array<string> = []
    const owned = fake({ calls: ownedCalls })
    const ownedRuntime = {
      ...owned.runtime,
      platform: 'darwin' as const,
      system: 'aarch64-darwin' as const,
    }
    const ownedError = await failed(
      request({
        ownedMemberKey: 'Foo',
        ownedMemberPath: '/workspace/repos/Foo',
        lockedMembers: [{ key: 'foo', sourcePath: '/store/foo', lockedCommit: commit }],
      }),
      ownedRuntime,
    )
    expect(ownedError.reason).toBe('MemberKeyCollision')
    expect(ownedCalls).toEqual([])

    const lockedCalls: Array<string> = []
    const locked = fake({ calls: lockedCalls })
    const lockedRuntime = {
      ...locked.runtime,
      platform: 'darwin' as const,
      system: 'aarch64-darwin' as const,
    }
    const lockedError = await failed(
      request({
        lockedMembers: [
          { key: 'Alpha', sourcePath: '/store/Alpha', lockedCommit: commit },
          { key: 'alpha', sourcePath: '/store/alpha', lockedCommit: commit },
        ],
      }),
      lockedRuntime,
    )
    expect(lockedError.reason).toBe('MemberKeyCollision')
    expect(lockedCalls).toEqual([])

    for (const [ignoredMembers, lockedMembers] of [
      [['Effect'], [{ key: 'effect', sourcePath: '/store/effect', lockedCommit: commit }]],
      [['OWNED'], []],
      [['Effect', 'effect'], []],
    ] as const) {
      const collisionCalls: Array<string> = []
      const collision = fake({ calls: collisionCalls })
      const collisionError = await failed(
        request({
          compositionConfig: new CompositionGeneratorConfig({
            platformHub: 'owned',
            ignoredMembers: [...ignoredMembers],
          }),
          lockedMembers: [...lockedMembers],
        }),
        { ...collision.runtime, platform: 'darwin', system: 'aarch64-darwin' },
      )
      expect(collisionError.reason).toBe('MemberKeyCollision')
      expect(collisionCalls).toEqual([])
    }
  })

  it('keeps Linux member keys byte-sensitive', async () => {
    const calls: Array<string> = []
    const manifests = new Map([
      ['/workspace/repos/owned', manifest({ cell: 'owned', key: 'owned', buck: true })],
      ['/store/Alpha', manifest({ cell: 'upper', key: 'Alpha' })],
      ['/store/alpha', manifest({ cell: 'lower', key: 'alpha' })],
    ])
    const { runtime } = fake({ calls, manifests })
    const result = await Effect.runPromise(
      compositionApply({
        request: request({
          compositionConfig: new CompositionGeneratorConfig({
            platformHub: 'owned',
            ignoredMembers: ['ALPHA'],
          }),
          lockedMembers: [
            { key: 'Alpha', sourcePath: '/store/Alpha', lockedCommit: commit },
            { key: 'alpha', sourcePath: '/store/alpha', lockedCommit: commit },
          ],
        }),
        runtime,
      }),
    )
    expect(result._tag).toBe('DryRun')
    expect(calls).toContain('mount:Alpha:plan')
    expect(calls).toContain('mount:alpha:plan')
  })

  it('rejects the owned member in locked members before I/O', async () => {
    const calls: Array<string> = []
    const { runtime } = fake({ calls })
    const error = await failed(
      request({
        lockedMembers: [{ key: 'owned', sourcePath: '/store/owned', lockedCommit: commit }],
      }),
      runtime,
    )
    expect(error.reason).toBe('OwnedMemberCollision')
    expect(calls).toEqual([])
  })

  it('rejects missing platform hub and buck2 capability', async () => {
    const calls: Array<string> = []
    const missingHub = fake({ calls })
    expect(
      (
        await failed(
          request({ compositionConfig: new CompositionGeneratorConfig({ platformHub: 'absent' }) }),
          missingHub.runtime,
        )
      ).reason,
    ).toBe('PlatformHubMissing')

    const noBuckCalls: Array<string> = []
    const noBuck = fake({
      calls: noBuckCalls,
      manifests: new Map([
        ['/workspace/repos/owned', manifest({ cell: 'owned', key: 'owned' })],
        ['/store/dep', manifest({ cell: 'dep', key: 'dep' })],
      ]),
    })
    expect((await failed(request(), noBuck.runtime)).reason).toBe('BuckCapabilityMissing')
  })

  it('rejects hub protocol and manifest mount mismatches', async () => {
    const calls: Array<string> = []
    const mismatch = fake({ calls })
    const mismatchRuntime = { ...mismatch.runtime, buck2Protocol: 'facebook/buck2-cli/other' }
    expect((await failed(request(), mismatchRuntime)).reason).toBe('BuckCapabilityMismatch')

    const mountCalls: Array<string> = []
    const badMount = fake({
      calls: mountCalls,
      manifests: new Map([
        ['/workspace/repos/owned', manifest({ cell: 'owned', key: 'owned', buck: true })],
        ['/store/dep', { ...manifest({ cell: 'dep', key: 'dep' }), mount: 'repos/other' }],
      ]),
    })
    expect((await failed(request(), badMount.runtime)).reason).toBe('ManifestMountMismatch')
  })

  it('rejects a platform/system mismatch', async () => {
    const calls: Array<string> = []
    const { runtime } = fake({ calls })
    const mismatchedRuntime = { ...runtime, platform: 'darwin' as const }
    expect((await failed(request(), mismatchedRuntime)).reason).toBe('PlatformUnsupported')
    expect(calls).toEqual([])
  })
})
