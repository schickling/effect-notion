import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as NodePath from 'node:path'

import { describe, it } from '@effect/vitest'
import { expect } from 'vitest'

import { resolvePinnedCoreutils } from '../../test-utils/coreutils.ts'
import { compositionApplyRuntimeFromEnv } from '../apply/composition-runtime.ts'
import { installOwnedCapabilityProjection } from './owned-capability-projection.ts'

const writeProjection = async ({
  root,
  generation,
}: {
  readonly root: string
  readonly generation: string
}) => {
  await mkdir(NodePath.join(root, 'generations', generation), { recursive: true })
  await writeFile(
    NodePath.join(root, 'defs.bzl'),
    `GENERATION = "${generation}"
`,
  )
}

describe('owned capability projection', () => {
  it('publishes atomically, advances, and is idempotent', async () => {
    const fixture = await mkdtemp(NodePath.join(tmpdir(), 'owned-capability-'))
    try {
      const owned = NodePath.join(fixture, 'owned')
      const first = NodePath.join(fixture, 'first')
      const second = NodePath.join(fixture, 'second')
      await mkdir(owned)
      await writeFile(NodePath.join(owned, '.git'), 'gitdir: fixture\n')
      const firstGeneration = 'a'.repeat(64)
      const secondGeneration = 'b'.repeat(64)
      await writeProjection({ root: first, generation: firstGeneration })
      await writeProjection({ root: second, generation: secondGeneration })
      const runtime = {
        ...(await resolvePinnedCoreutils()),
        nonce: (() => {
          let value = 0
          return () => `fixture-${value++}`
        })(),
      }

      const published = await installOwnedCapabilityProjection({
        memberKey: 'owned',
        ownedMemberPath: owned,
        workspaceRoot: fixture,
        projectionPath: first,
        projectionDigest: firstGeneration,
        runtime,
      })
      expect(published.changed).toBe(true)
      const repeated = await installOwnedCapabilityProjection({
        memberKey: 'owned',
        ownedMemberPath: owned,
        workspaceRoot: fixture,
        projectionPath: first,
        projectionDigest: firstGeneration,
        runtime,
      })
      expect(repeated.changed).toBe(false)
      const advanced = await installOwnedCapabilityProjection({
        memberKey: 'owned',
        ownedMemberPath: owned,
        workspaceRoot: fixture,
        projectionPath: second,
        projectionDigest: secondGeneration,
        runtime,
      })
      expect(advanced.changed).toBe(true)
      expect(await readFile(NodePath.join(fixture, '.buck2/capabilities/defs.bzl'), 'utf8')).toBe(
        `GENERATION = "${secondGeneration}"
`,
      )
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })

  it.each(['symlink', 'file'] as const)(
    'rejects a %s root .buck2 parent without writing outside',
    async (kind) => {
      const fixture = await mkdtemp(NodePath.join(tmpdir(), 'owned-capability-parent-'))
      try {
        const owned = NodePath.join(fixture, 'owned')
        const projection = NodePath.join(fixture, 'projection')
        const outside = NodePath.join(fixture, 'outside')
        const generation = 'c'.repeat(64)
        await Promise.all([mkdir(owned), mkdir(outside)])
        await writeFile(NodePath.join(owned, '.git'), 'gitdir: fixture\n')
        await writeProjection({ root: projection, generation })
        if (kind === 'symlink') await symlink(outside, NodePath.join(fixture, '.buck2'))
        else await writeFile(NodePath.join(fixture, '.buck2'), 'not a directory\n')
        const coreutils = await resolvePinnedCoreutils()

        await expect(
          installOwnedCapabilityProjection({
            memberKey: 'owned',
            ownedMemberPath: owned,
            workspaceRoot: fixture,
            projectionPath: projection,
            projectionDigest: generation,
            runtime: {
              ...coreutils,
              nonce: () => 'parent-kind',
            },
          }),
        ).rejects.toMatchObject({
          _tag: 'OwnedCapabilityProjectionError',
          reason: 'VerificationFailed',
        })
        expect(await readdir(outside)).toEqual([])
      } finally {
        await rm(fixture, { recursive: true, force: true })
      }
    },
  )

  it.each(['copy', 'publish'] as const)(
    'detects deterministic root .buck2 replacement before %s without following the replacement',
    async (phase) => {
      const fixture = await mkdtemp(NodePath.join(tmpdir(), 'owned-capability-race-'))
      try {
        const owned = NodePath.join(fixture, 'owned')
        const projection = NodePath.join(fixture, 'projection')
        const outside = NodePath.join(fixture, 'outside')
        const generation = 'd'.repeat(64)
        await Promise.all([mkdir(owned), mkdir(outside)])
        await writeFile(NodePath.join(owned, '.git'), 'gitdir: fixture\n')
        await writeProjection({ root: projection, generation })
        const replaceParent = async (parent: string) => {
          await rename(parent, `${parent}.captured`)
          await symlink(outside, parent)
        }
        const coreutils = await resolvePinnedCoreutils()

        await expect(
          installOwnedCapabilityProjection({
            memberKey: 'owned',
            ownedMemberPath: owned,
            workspaceRoot: fixture,
            projectionPath: projection,
            projectionDigest: generation,
            runtime: {
              ...coreutils,
              nonce: () => `race-${phase}`,
              ...(phase === 'copy'
                ? { beforeCopy: replaceParent }
                : { beforePublish: replaceParent }),
            },
          }),
        ).rejects.toMatchObject({
          _tag: 'OwnedCapabilityProjectionError',
          reason: phase === 'copy' ? 'CopyFailed' : 'PublishFailed',
        })
        expect(await readdir(outside)).toEqual([])
      } finally {
        await rm(fixture, { recursive: true, force: true })
      }
    },
  )

  it('fails closed when the Nix wrapper environment is incomplete', () => {
    expect(() =>
      compositionApplyRuntimeFromEnv({
        workspaceRoot: '/workspace',
        env: {},
      }),
    ).toThrow(/MR_CAPABILITY_NIX_BIN/u)
  })
})
