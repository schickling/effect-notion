import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { checkRepositoryPolicy } from './repository-policy-runner.ts'

const roots: string[] = []

const fixture = (files: Readonly<Record<string, string>>): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'repository-policy-'))
  roots.push(root)
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath)
    mkdirSync(path.dirname(absolutePath), { recursive: true })
    writeFileSync(absolutePath, content)
  }
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('repository policy', () => {
  it('accepts a declared generated package and travelling asset reference', async () => {
    const files = {
      'packages/@overeng/example/package.json': '{}\n',
      'packages/@overeng/example/package.json.genie.ts': 'export default {}\n',
      'packages/@overeng/example/src/mod.ts':
        '/// <reference path="./style.css.d.ts" />\nimport "./style.css"\n',
      'packages/@overeng/example/tsconfig.json': '{}\n',
      'packages/@overeng/example/tsconfig.json.genie.ts': 'export default {}\n',
    }
    await expect(
      checkRepositoryPolicy({
        manifest: {
          declaredPackages: ['packages/@overeng/example'],
          sourcePaths: Object.keys(files),
        },
        sourceRoot: fixture(files),
      }),
    ).resolves.toEqual({ checkedAssetSources: 1, declaredPackages: 1 })
  })

  it('rejects an asset side-effect import without a travelling reference', async () => {
    const files = {
      'packages/@overeng/example/package.json': '{}\n',
      'packages/@overeng/example/package.json.genie.ts': 'export default {}\n',
      'packages/@overeng/example/src/mod.ts': 'import "./style.css"\n',
    }
    await expect(
      checkRepositoryPolicy({
        manifest: {
          declaredPackages: ['packages/@overeng/example'],
          sourcePaths: Object.keys(files),
        },
        sourceRoot: fixture(files),
      }),
    ).rejects.toThrow('Asset side-effect imports lack travelling type references')
  })

  it('rejects unmanaged configuration and package inventory drift together', async () => {
    const files = {
      'packages/@overeng/unmanaged/package.json': '{}\n',
      'packages/@overeng/unmanaged/tsconfig.json': '{}\n',
    }
    await expect(
      checkRepositoryPolicy({
        manifest: { declaredPackages: [], sourcePaths: Object.keys(files) },
        sourceRoot: fixture(files),
      }),
    ).rejects.toThrow(
      /Generated configuration sources are missing[\s\S]*Workspace packages are absent/u,
    )
  })
})
