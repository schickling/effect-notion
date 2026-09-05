import { randomUUID } from 'node:crypto'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as NodePath from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  addDisposableCapabilityStorePath,
  deleteStorePath,
  resolveDeclaredNix,
  writeRootableCapabilityProjection,
} from '../../test-utils/capability-nix.ts'
import { resolvePinnedCoreutils } from '../../test-utils/coreutils.ts'
import { requireTool } from '../../test-utils/require-tool.ts'
import { assertCapabilityGcRoots, capabilityGcRootsPath } from './capability-gc-roots.ts'
import { installOwnedCapabilityProjection } from './owned-capability-projection.ts'

const PLATFORM = 'x86_64-linux'
const TOOL_ID = 'probe'

interface Fixture {
  readonly root: string
  readonly owned: string
  readonly nixPath: string
  readonly gcRootsPath: string
  readonly runtime: {
    readonly cpPath: string
    readonly mvPath: string
    readonly nonce: () => string
    readonly capabilityGcRoots: { readonly nixPath: string; readonly nixStateDir?: string }
  }
  readonly storePaths: Array<string>
}

const makeFixture = async (): Promise<Fixture> => {
  const nixPath = await resolveDeclaredNix()
  const root = await mkdtemp(NodePath.join(NodePath.resolve(tmpdir()), 'megarepo-cap-gcroots-'))
  const owned = NodePath.join(root, 'owned')
  await mkdir(owned)
  await writeFile(NodePath.join(owned, '.git'), 'gitdir: fixture\n')
  const coreutils = await resolvePinnedCoreutils()
  let nonce = 0
  return {
    root,
    owned,
    nixPath,
    gcRootsPath: capabilityGcRootsPath({ ownedMemberPath: owned }),
    runtime: {
      ...coreutils,
      nonce: () => `gcroots-${nonce++}`,
      capabilityGcRoots: { nixPath },
    },
    storePaths: [],
  }
}

/** Release every root this fixture registered, then reclaim its disposable realizations. */
const clean = async (fixture: Fixture): Promise<void> => {
  await rm(fixture.root, { recursive: true, force: true })
  for (const storePath of fixture.storePaths) {
    await deleteStorePath({ nixPath: fixture.nixPath, storePath })
  }
}

const makeGeneration = async ({
  fixture,
  generation,
  marker,
  extraClosureStorePaths,
}: {
  readonly fixture: Fixture
  readonly generation: string
  readonly marker: string
  readonly extraClosureStorePaths?: ReadonlyArray<string>
}): Promise<{ readonly projectionPath: string; readonly storePath: string }> => {
  // Realizations are content-addressed, so the marker carries a per-run identity: a leftover
  // root from an earlier run must never be the thing that keeps this run's path alive.
  const unique = `${marker}-${randomUUID()}`
  const storePath = await addDisposableCapabilityStorePath({
    nixPath: fixture.nixPath,
    name: `megarepo-capability-probe-${marker}`,
    marker: unique,
  })
  fixture.storePaths.push(storePath)
  const projectionPath = NodePath.join(fixture.root, `projection-${marker}`)
  await writeRootableCapabilityProjection({
    root: projectionPath,
    generation,
    storePath,
    platform: PLATFORM,
    toolId: TOOL_ID,
    ...(extraClosureStorePaths === undefined ? {} : { extraClosureStorePaths }),
  })
  return { projectionPath, storePath }
}

/** An `mv` that refuses every exchange, so publish and its rollback both fail for real. */
const refusingMv = async (fixture: Fixture): Promise<string> => {
  const path = NodePath.join(fixture.root, 'refusing-mv')
  await writeFile(path, `#!${requireTool('BASH_BIN')}\nexit 17\n`, { mode: 0o755 })
  return path
}

const install = ({
  fixture,
  projectionPath,
  generation,
  mvPath,
  nixStateDir,
}: {
  readonly fixture: Fixture
  readonly projectionPath: string
  readonly generation: string
  readonly mvPath?: string
  readonly nixStateDir?: string
}) =>
  installOwnedCapabilityProjection({
    memberKey: 'owned',
    ownedMemberPath: fixture.owned,
    projectionPath,
    projectionDigest: generation,
    runtime: {
      ...fixture.runtime,
      ...(mvPath === undefined ? {} : { mvPath }),
      ...(nixStateDir === undefined
        ? {}
        : { capabilityGcRoots: { nixPath: fixture.nixPath, nixStateDir } }),
    },
  })

const generationA = 'a'.repeat(64)
const generationB = 'b'.repeat(64)

// Every case drives the real local Nix store: realize, register roots, then ask Nix to collect.
// Root scanning alone can take seconds on a busy host, so the default 15s budget cannot apply.
describe('capability GC roots', { timeout: 300_000 }, () => {
  it('keeps the installed capability closure alive across a real Nix collection', async () => {
    const fixture = await makeFixture()
    try {
      const { projectionPath, storePath } = await makeGeneration({
        fixture,
        generation: generationA,
        marker: 'live',
      })
      const published = await install({ fixture, projectionPath, generation: generationA })
      expect(published.changed).toBe(true)

      const linkPath = NodePath.join(fixture.gcRootsPath, generationA, PLATFORM, TOOL_ID)
      expect(await readlink(linkPath)).toBe(storePath)

      // Real Nix collection: it refuses to delete a path retained by a registered GC root.
      const collected = await deleteStorePath({ nixPath: fixture.nixPath, storePath })
      expect(collected.deleted).toBe(false)
      expect(collected.output).toContain(linkPath)

      // The executable Buck actually spawns is still there.
      const executable = NodePath.join(storePath, 'bin', 'tool')
      expect((await stat(executable)).isFile()).toBe(true)
      await access(executable, 1)
      await assertCapabilityGcRoots({
        projectionPath: NodePath.join(fixture.owned, '.buck2', 'capabilities'),
        generation: generationA,
        gcRootsPath: fixture.gcRootsPath,
        runtime: fixture.runtime.capabilityGcRoots,
      })

      // A store path nobody rooted is genuinely collectable, so the proof above is not vacuous.
      const unrooted = await addDisposableCapabilityStorePath({
        nixPath: fixture.nixPath,
        name: 'megarepo-capability-probe-unrooted',
        marker: 'unrooted',
      })
      expect(
        (await deleteStorePath({ nixPath: fixture.nixPath, storePath: unrooted })).deleted,
      ).toBe(true)
      await expect(stat(unrooted)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await clean(fixture)
    }
  })

  it('preserves the installed rooted generation when replacement fails', async () => {
    const fixture = await makeFixture()
    try {
      const first = await makeGeneration({ fixture, generation: generationA, marker: 'first' })
      await install({ fixture, projectionPath: first.projectionPath, generation: generationA })
      const second = await makeGeneration({ fixture, generation: generationB, marker: 'second' })

      await expect(
        install({
          fixture,
          projectionPath: second.projectionPath,
          generation: generationB,
          mvPath: await refusingMv(fixture),
        }),
      ).rejects.toMatchObject({
        _tag: 'OwnedCapabilityProjectionError',
        reason: 'PublishFailed',
      })

      // The generation that stayed installed is still rooted, and the candidate did not displace it.
      expect(await readFile(NodePath.join(fixture.owned, '.buck2/capabilities/defs.bzl'), 'utf8'))
        .toBe(`GENERATION = "${generationA}"
`)
      expect(await readdir(fixture.gcRootsPath)).toEqual([generationA])
      expect(
        await readlink(NodePath.join(fixture.gcRootsPath, generationA, PLATFORM, TOOL_ID)),
      ).toBe(first.storePath)
      expect(
        (await deleteStorePath({ nixPath: fixture.nixPath, storePath: first.storePath })).deleted,
      ).toBe(false)
      // The candidate that never published holds no root of its own.
      expect(
        (await deleteStorePath({ nixPath: fixture.nixPath, storePath: second.storePath })).deleted,
      ).toBe(true)
    } finally {
      await clean(fixture)
    }
  })

  it('bounds roots to the installed generation and releases the replaced one', async () => {
    const fixture = await makeFixture()
    try {
      const first = await makeGeneration({ fixture, generation: generationA, marker: 'old' })
      await install({ fixture, projectionPath: first.projectionPath, generation: generationA })
      const second = await makeGeneration({ fixture, generation: generationB, marker: 'new' })
      const advanced = await install({
        fixture,
        projectionPath: second.projectionPath,
        generation: generationB,
      })
      expect(advanced.changed).toBe(true)

      expect(await readdir(fixture.gcRootsPath)).toEqual([generationB])
      expect(
        (await deleteStorePath({ nixPath: fixture.nixPath, storePath: second.storePath })).deleted,
      ).toBe(false)
      // The superseded generation is no longer retained: stale roots stay bounded.
      expect(
        (await deleteStorePath({ nixPath: fixture.nixPath, storePath: first.storePath })).deleted,
      ).toBe(true)
    } finally {
      await clean(fixture)
    }
  })

  it('re-registers a missing root on an unchanged apply and refuses an unrooted projection', async () => {
    const fixture = await makeFixture()
    try {
      const { projectionPath, storePath } = await makeGeneration({
        fixture,
        generation: generationA,
        marker: 'heal',
      })
      await install({ fixture, projectionPath, generation: generationA })
      const installedProjection = NodePath.join(fixture.owned, '.buck2', 'capabilities')
      const linkPath = NodePath.join(fixture.gcRootsPath, generationA, PLATFORM, TOOL_ID)

      await rm(linkPath)
      await expect(
        assertCapabilityGcRoots({
          projectionPath: installedProjection,
          generation: generationA,
          gcRootsPath: fixture.gcRootsPath,
          runtime: fixture.runtime.capabilityGcRoots,
        }),
      ).rejects.toMatchObject({ _tag: 'CapabilityGcRootError', reason: 'Unrooted' })

      const repeated = await install({ fixture, projectionPath, generation: generationA })
      expect(repeated.changed).toBe(false)
      expect(await readlink(linkPath)).toBe(storePath)
      expect(await readdir(fixture.gcRootsPath)).toEqual([generationA])
      expect((await deleteStorePath({ nixPath: fixture.nixPath, storePath })).deleted).toBe(false)
    } finally {
      await clean(fixture)
    }
  })

  it('refuses to install a projection whose declared closure a root cannot retain', async () => {
    const fixture = await makeFixture()
    try {
      const installed = await makeGeneration({
        fixture,
        generation: generationA,
        marker: 'sound',
      })
      await install({ fixture, projectionPath: installed.projectionPath, generation: generationA })
      const tampered = await makeGeneration({
        fixture,
        generation: generationB,
        marker: 'tampered',
        extraClosureStorePaths: ['/nix/store/00000000000000000000000000000000-absent'],
      })

      await expect(
        install({ fixture, projectionPath: tampered.projectionPath, generation: generationB }),
      ).rejects.toMatchObject({
        _tag: 'OwnedCapabilityProjectionError',
        reason: 'GcRootFailed',
      })
      expect(await readFile(NodePath.join(fixture.owned, '.buck2/capabilities/defs.bzl'), 'utf8'))
        .toBe(`GENERATION = "${generationA}"
`)
      expect(await readdir(fixture.gcRootsPath)).toEqual([generationA])
      expect(
        (await deleteStorePath({ nixPath: fixture.nixPath, storePath: installed.storePath }))
          .deleted,
      ).toBe(false)
    } finally {
      await clean(fixture)
    }
  })

  it('refuses to install when Nix root registration cannot be proven', async () => {
    const fixture = await makeFixture()
    try {
      const installed = await makeGeneration({
        fixture,
        generation: generationA,
        marker: 'provable',
      })
      await install({ fixture, projectionPath: installed.projectionPath, generation: generationA })
      const candidate = await makeGeneration({
        fixture,
        generation: generationB,
        marker: 'unprovable',
      })

      // A store state directory with no `gcroots/auto` models a store whose roots cannot be read.
      const opaqueStateDir = NodePath.join(fixture.root, 'opaque-nix-state')
      await mkdir(opaqueStateDir)
      await expect(
        install({
          fixture,
          projectionPath: candidate.projectionPath,
          generation: generationB,
          nixStateDir: opaqueStateDir,
        }),
      ).rejects.toMatchObject({
        _tag: 'OwnedCapabilityProjectionError',
        reason: 'GcRootFailed',
      })
      expect(await readFile(NodePath.join(fixture.owned, '.buck2/capabilities/defs.bzl'), 'utf8'))
        .toBe(`GENERATION = "${generationA}"
`)
      expect(await readdir(fixture.gcRootsPath)).toEqual([generationA])
      expect(
        (await deleteStorePath({ nixPath: fixture.nixPath, storePath: installed.storePath }))
          .deleted,
      ).toBe(false)
    } finally {
      await clean(fixture)
    }
  })
})
