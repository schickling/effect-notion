import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as NodePath from 'node:path'

import { describe, expect, it } from 'vitest'

import { compositionRuntimeEnvironmentNames } from '../composition/apply/composition-runtime.ts'
import { resolvePinnedCoreutils } from './coreutils.ts'

const withFixture = async <A>(run: (root: string) => Promise<A>): Promise<A> => {
  const root = await mkdtemp(NodePath.join(tmpdir(), 'megarepo-coreutils-test-'))
  try {
    return await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const writeExecutable = async (path: string): Promise<void> => {
  await writeFile(path, '#!/bin/sh\nexit 0\n')
  await chmod(path, 0o755)
}

describe('resolvePinnedCoreutils', () => {
  it('uses a complete exact cp/mv injection without consulting declared tools', () =>
    withFixture(async (root) => {
      const cpPath = NodePath.join(root, 'cp')
      const mvPath = NodePath.join(root, 'mv')
      await writeExecutable(cpPath)
      await writeExecutable(mvPath)

      await expect(
        resolvePinnedCoreutils({
          env: {
            [compositionRuntimeEnvironmentNames.cpPath]: cpPath,
            [compositionRuntimeEnvironmentNames.mvPath]: mvPath,
          },
        }),
      ).resolves.toEqual({ cpPath, mvPath })
    }))

  it('fails closed on partial injection', () =>
    withFixture(async (root) => {
      const cpPath = NodePath.join(root, 'cp')
      await writeExecutable(cpPath)

      await expect(
        resolvePinnedCoreutils({
          env: { [compositionRuntimeEnvironmentNames.cpPath]: cpPath },
        }),
      ).rejects.toThrow('must provide both cp and mv')
    }))

  it('falls back to the Buck-declared cp/mv tool paths', () =>
    withFixture(async (root) => {
      const cpPath = NodePath.join(root, 'cp')
      const mvPath = NodePath.join(root, 'mv')
      await writeExecutable(cpPath)
      await writeExecutable(mvPath)

      await expect(
        resolvePinnedCoreutils({ env: { CP_BIN: cpPath, MV_BIN: mvPath } }),
      ).resolves.toEqual({ cpPath, mvPath })
    }))

  it('fails loudly when a declared cp/mv tool is unavailable', async () => {
    await expect(resolvePinnedCoreutils({ env: {} })).rejects.toThrow(
      'declared test tool is unavailable: CP_BIN',
    )
  })
})
