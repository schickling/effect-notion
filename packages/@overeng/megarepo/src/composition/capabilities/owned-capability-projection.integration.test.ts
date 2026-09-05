import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as NodePath from 'node:path'

import { describe, it } from '@effect/vitest'
import { expect } from 'vitest'

import { writeRootableCapabilityProjection } from '../../test-utils/capability-nix.ts'
import { resolvePinnedCoreutils } from '../../test-utils/coreutils.ts'
import { requireTool } from '../../test-utils/require-tool.ts'
import { compositionApplyRuntimeFromEnv } from '../apply/composition-runtime.ts'
import { installOwnedCapabilityProjection } from './owned-capability-projection.ts'

/**
 * This suite proves publish/rollback semantics, so it must run where the Buck sandbox runs: with
 * no Nix daemon and no `/nix/var/nix`. The stand-in `nix` performs exactly the two operations
 * GC-root registration depends on — create the out-link and register it as an indirect root in
 * the store state directory — against fixture-local state. The real store, real registration and
 * real collection are proven by capability-gc-roots.integration.test.ts.
 */
const fakeNixRuntime = async (fixture: string) => {
  const nixPath = NodePath.join(fixture, 'fake-nix')
  const nixStateDir = NodePath.join(fixture, 'nix-state')
  await writeFile(
    nixPath,
    [
      `#!${requireTool('BUN_BIN')}`,
      `import { mkdirSync, rmSync, symlinkSync } from 'node:fs'`,
      `import { join } from 'node:path'`,
      `const argv = process.argv.slice(2)`,
      `const storePath = argv.at(-1)`,
      `if (argv[0] === 'path-info') { process.stdout.write(storePath + '\\n'); process.exit(0) }`,
      `if (argv[0] !== 'build') process.exit(64)`,
      `const outLink = argv[argv.indexOf('--out-link') + 1]`,
      `rmSync(outLink, { force: true })`,
      `symlinkSync(storePath, outLink)`,
      `const auto = join(process.env.NIX_STATE_DIR, 'gcroots', 'auto')`,
      `mkdirSync(auto, { recursive: true })`,
      `const entry = join(auto, Buffer.from(outLink).toString('hex').slice(-32))`,
      `rmSync(entry, { force: true })`,
      `symlinkSync(outLink, entry)`,
      `process.stdout.write(storePath + '\\n')`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  return { nixPath, nixStateDir, env: { NIX_STATE_DIR: nixStateDir } }
}

const projectionRuntime = async (fixture: string) => {
  const coreutils = await resolvePinnedCoreutils()
  return {
    coreutils,
    // A real, already-valid store item, so executable identity checks see the real thing.
    storePath: NodePath.dirname(NodePath.dirname(coreutils.cpPath)),
    capabilityGcRoots: await fakeNixRuntime(fixture),
  }
}

const writeProjection = async ({
  root,
  generation,
  storePath,
}: {
  readonly root: string
  readonly generation: string
  readonly storePath: string
}) => {
  await writeRootableCapabilityProjection({
    root,
    generation,
    storePath,
    toolId: 'coreutils-cp',
    executable: 'bin/cp',
  })
}

// Installing a projection now registers Nix GC roots, so each case waits on the local Nix store.
describe('owned capability projection', { timeout: 120_000 }, () => {
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
      const { coreutils, storePath, capabilityGcRoots } = await projectionRuntime(fixture)
      await writeProjection({ root: first, generation: firstGeneration, storePath })
      await writeProjection({ root: second, generation: secondGeneration, storePath })
      const runtime = {
        ...coreutils,
        capabilityGcRoots,
        nonce: (() => {
          let value = 0
          return () => `fixture-${value++}`
        })(),
      }

      const published = await installOwnedCapabilityProjection({
        memberKey: 'owned',
        ownedMemberPath: owned,
        projectionPath: first,
        projectionDigest: firstGeneration,
        runtime,
      })
      expect(published.changed).toBe(true)
      const repeated = await installOwnedCapabilityProjection({
        memberKey: 'owned',
        ownedMemberPath: owned,
        projectionPath: first,
        projectionDigest: firstGeneration,
        runtime,
      })
      expect(repeated.changed).toBe(false)
      const advanced = await installOwnedCapabilityProjection({
        memberKey: 'owned',
        ownedMemberPath: owned,
        projectionPath: second,
        projectionDigest: secondGeneration,
        runtime,
      })
      expect(advanced.changed).toBe(true)
      expect(await readFile(NodePath.join(owned, '.buck2/capabilities/defs.bzl'), 'utf8')).toBe(
        `GENERATION = "${secondGeneration}"
`,
      )
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })

  it.each(['symlink', 'file'] as const)(
    'rejects a %s .buck2 parent without writing outside',
    async (kind) => {
      const fixture = await mkdtemp(NodePath.join(tmpdir(), 'owned-capability-parent-'))
      try {
        const owned = NodePath.join(fixture, 'owned')
        const projection = NodePath.join(fixture, 'projection')
        const outside = NodePath.join(fixture, 'outside')
        const generation = 'c'.repeat(64)
        await Promise.all([mkdir(owned), mkdir(outside)])
        await writeFile(NodePath.join(owned, '.git'), 'gitdir: fixture\n')
        const { coreutils, storePath, capabilityGcRoots } = await projectionRuntime(fixture)
        await writeProjection({ root: projection, generation, storePath })
        if (kind === 'symlink') await symlink(outside, NodePath.join(owned, '.buck2'))
        else await writeFile(NodePath.join(owned, '.buck2'), 'not a directory\n')

        await expect(
          installOwnedCapabilityProjection({
            memberKey: 'owned',
            ownedMemberPath: owned,
            projectionPath: projection,
            projectionDigest: generation,
            runtime: {
              ...coreutils,
              capabilityGcRoots,
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
    'detects deterministic .buck2 replacement before %s without following the replacement',
    async (phase) => {
      const fixture = await mkdtemp(NodePath.join(tmpdir(), 'owned-capability-race-'))
      try {
        const owned = NodePath.join(fixture, 'owned')
        const projection = NodePath.join(fixture, 'projection')
        const outside = NodePath.join(fixture, 'outside')
        const generation = 'd'.repeat(64)
        await Promise.all([mkdir(owned), mkdir(outside)])
        await writeFile(NodePath.join(owned, '.git'), 'gitdir: fixture\n')
        const { coreutils, storePath, capabilityGcRoots } = await projectionRuntime(fixture)
        await writeProjection({ root: projection, generation, storePath })
        const replaceParent = async (parent: string) => {
          await rename(parent, `${parent}.captured`)
          await symlink(outside, parent)
        }

        await expect(
          installOwnedCapabilityProjection({
            memberKey: 'owned',
            ownedMemberPath: owned,
            projectionPath: projection,
            projectionDigest: generation,
            runtime: {
              ...coreutils,
              capabilityGcRoots,
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
