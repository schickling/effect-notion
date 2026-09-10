import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { CatalogConflictError, defineCatalog } from './catalog.ts'
import { packageJson } from './mod.ts'

const createTempRepo = (...memberPaths: string[]) => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-workspace-'))
  fs.mkdirSync(path.join(repoRoot, '.git'))

  return {
    repoRoot,
    repoName: path.basename(repoRoot),
    memberDirs: Object.fromEntries(
      memberPaths.map((memberPath) => {
        const memberDir = path.join(repoRoot, memberPath)
        fs.mkdirSync(memberDir, { recursive: true })
        return [memberPath, memberDir]
      }),
    ) as Record<string, string>,
  }
}

const workspace = ({ repoName, memberPath }: { repoName: string; memberPath: string }) => ({
  repoName,
  memberPath,
})

describe('defineCatalog', () => {
  describe('standalone catalog', () => {
    it('returns frozen catalog object', () => {
      const catalog = defineCatalog({
        effect: '3.19.14',
        '@effect/platform': '0.94.1',
      })

      expect(catalog.effect).toBe('3.19.14')
      expect(catalog['@effect/platform']).toBe('0.94.1')
      expect(Object.isFrozen(catalog)).toBe(true)
    })

    it('preserves all entries', () => {
      const catalog = defineCatalog({
        a: '1.0.0',
        b: '2.0.0',
        c: '3.0.0',
      })

      expect(Object.keys(catalog)).toHaveLength(3)
    })
  })

  describe('extended catalog', () => {
    const baseCatalog = defineCatalog({
      effect: '3.19.14',
      '@effect/platform': '0.94.1',
      react: '19.2.3',
    })

    it('merges base catalog with new packages', () => {
      const extended = defineCatalog({
        extends: baseCatalog,
        packages: {
          '@effect/ai-openai': '0.37.2',
          typescript: '6.0.3',
        },
      })

      expect(extended.effect).toBe('3.19.14')
      expect(extended['@effect/platform']).toBe('0.94.1')
      expect(extended.react).toBe('19.2.3')
      expect(extended['@effect/ai-openai']).toBe('0.37.2')
      expect(extended.typescript).toBe('6.0.3')
    })

    it('returns frozen object', () => {
      const extended = defineCatalog({
        extends: baseCatalog,
        packages: { newPkg: '1.0.0' },
      })

      expect(Object.isFrozen(extended)).toBe(true)
    })
  })

  describe('duplicate detection (same version)', () => {
    const baseCatalog = defineCatalog({
      effect: '3.19.14',
      react: '19.2.3',
    })

    it('warns on duplicate and includes the package', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const extended = defineCatalog({
        extends: baseCatalog,
        packages: {
          effect: '3.19.14', // same version as base
          newPkg: '1.0.0',
        },
      })

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Duplicate: "effect@3.19.14" already defined'),
      )
      expect(extended.effect).toBe('3.19.14')
      expect(extended.newPkg).toBe('1.0.0')

      warnSpy.mockRestore()
    })

    it('warns for each duplicate', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      defineCatalog({
        extends: baseCatalog,
        packages: {
          effect: '3.19.14',
          react: '19.2.3',
        },
      })

      expect(warnSpy).toHaveBeenCalledTimes(2)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('effect@3.19.14'))
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('react@19.2.3'))

      warnSpy.mockRestore()
    })
  })

  describe('conflict detection (different version)', () => {
    const baseCatalog = defineCatalog({
      effect: '3.19.14',
      react: '19.2.3',
    })

    it('throws CatalogConflictError on version mismatch', () => {
      expect(() =>
        defineCatalog({
          extends: baseCatalog,
          packages: {
            effect: '3.20.0', // different version
          },
        }),
      ).toThrow(CatalogConflictError)
    })

    it('includes both versions in error message', () => {
      try {
        defineCatalog({
          extends: baseCatalog,
          packages: {
            effect: '3.20.0',
          },
        })
        expect.fail('Should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(CatalogConflictError)
        const error = err as CatalogConflictError
        expect(error.packageName).toBe('effect')
        expect(error.baseVersion).toBe('3.19.14')
        expect(error.newVersion).toBe('3.20.0')
        expect(error.message).toContain('3.19.14')
        expect(error.message).toContain('3.20.0')
      }
    })

    it('throws on first conflict encountered', () => {
      expect(() =>
        defineCatalog({
          extends: baseCatalog,
          packages: {
            effect: '3.20.0',
            react: '18.0.0', // also conflicting
          },
        }),
      ).toThrow('effect')
    })

    it('includes remediation guidance in error message', () => {
      try {
        defineCatalog({
          extends: baseCatalog,
          packages: {
            effect: '3.20.0',
          },
        })
        expect.fail('Should have thrown')
      } catch (err) {
        const error = err as CatalogConflictError
        expect(error.message).toContain('Remove "effect" from the extending catalog')
        expect(error.message).toContain('TDZ errors')
      }
    })

    it('includes TDZ cascade warning in error message', () => {
      try {
        defineCatalog({
          extends: baseCatalog,
          packages: {
            effect: '3.20.0',
          },
        })
        expect.fail('Should have thrown')
      } catch (err) {
        const error = err as CatalogConflictError
        expect(error.message).toContain('Cannot access')
        expect(error.message).toContain('masking the root cause')
      }
    })
  })

  describe('multiple extends', () => {
    const catalogA = defineCatalog({
      effect: '3.19.14',
      '@effect/platform': '0.94.1',
    })

    const catalogB = defineCatalog({
      react: '19.2.3',
      typescript: '6.0.3',
    })

    it('merges multiple base catalogs', () => {
      const merged = defineCatalog({
        extends: [catalogA, catalogB],
        packages: {
          vitest: '4.0.16',
        },
      })

      expect(merged.effect).toBe('3.19.14')
      expect(merged['@effect/platform']).toBe('0.94.1')
      expect(merged.react).toBe('19.2.3')
      expect(merged.typescript).toBe('6.0.3')
      expect(merged.vitest).toBe('4.0.16')
    })

    it('throws on conflict between base catalogs', () => {
      const catalogConflicting = defineCatalog({
        effect: '3.20.0', // conflicts with catalogA
      })

      expect(() =>
        defineCatalog({
          extends: [catalogA, catalogConflicting],
          packages: {},
        }),
      ).toThrow(CatalogConflictError)
    })

    it('includes remediation guidance for base-base conflicts', () => {
      const catalogConflicting = defineCatalog({
        effect: '3.20.0',
      })

      try {
        defineCatalog({
          extends: [catalogA, catalogConflicting],
          packages: {},
        })
        expect.fail('Should have thrown')
      } catch (err) {
        const error = err as CatalogConflictError
        expect(error.packageName).toBe('effect')
        expect(error.baseVersion).toBe('3.19.14')
        expect(error.newVersion).toBe('3.20.0')
        expect(error.message).toContain('Remove "effect" from the extending catalog')
      }
    })

    it('allows same version across multiple bases', () => {
      const catalogDuplicate = defineCatalog({
        effect: '3.19.14', // same as catalogA
      })

      const merged = defineCatalog({
        extends: [catalogA, catalogDuplicate],
        packages: {},
      })

      expect(merged.effect).toBe('3.19.14')
    })
  })

  describe('type safety', () => {
    it('preserves literal types in standalone catalog', () => {
      const catalog = defineCatalog({
        effect: '3.19.14',
        react: '19.2.3',
      } as const)

      // Type assertion - this should compile
      const _effect: '3.19.14' = catalog.effect
      const _react: '19.2.3' = catalog.react
      expect(_effect).toBe('3.19.14')
      expect(_react).toBe('19.2.3')
    })

    it('merged catalog has union of keys', () => {
      const base = defineCatalog({ a: '1.0.0' })
      const extended = defineCatalog({
        extends: base,
        packages: { b: '2.0.0' },
      })

      // Both keys should be accessible
      expect(extended.a).toBe('1.0.0')
      expect(extended.b).toBe('2.0.0')
    })
  })

  describe('edge cases', () => {
    it('handles empty packages in extended catalog', () => {
      const base = defineCatalog({ effect: '3.19.14' })
      const extended = defineCatalog({
        extends: base,
        packages: {},
      })

      expect(extended.effect).toBe('3.19.14')
      expect(Object.keys(extended)).toHaveLength(1)
    })

    it('handles empty base catalog', () => {
      const base = defineCatalog({})
      const extended = defineCatalog({
        extends: base,
        packages: { effect: '3.19.14' },
      })

      expect(extended.effect).toBe('3.19.14')
    })

    it('handles scoped package names correctly', () => {
      const catalog = defineCatalog({
        '@effect/platform': '0.94.1',
        '@types/node': '25.0.3',
      })

      expect(catalog['@effect/platform']).toBe('0.94.1')
      expect(catalog['@types/node']).toBe('25.0.3')
    })
  })

  describe('compose', () => {
    const catalog = defineCatalog({
      '@effect/platform': '0.94.1',
      effect: '3.19.14',
      react: '19.2.3',
    })
    const repo = createTempRepo('packages/utils', 'packages/core', 'packages/app')

    it('derives emitted dependencies and workspace metadata from imported packages', () => {
      const utilsComposition = catalog.compose({
        workspace: workspace({
          repoName: repo.repoName,
          memberPath: 'packages/utils',
        }),
      })
      const utils = packageJson(
        {
          name: '@test/utils',
          version: '1.0.0',
        },
        utilsComposition,
      )
      const coreComposition = catalog.compose({
        workspace: workspace({
          repoName: repo.repoName,
          memberPath: 'packages/core',
        }),
        dependencies: {
          workspace: [utils],
        },
      })
      const core = packageJson(
        {
          name: '@test/core',
          version: '1.0.0',
        },
        coreComposition,
      )

      const composed = catalog.compose({
        workspace: workspace({
          repoName: repo.repoName,
          memberPath: 'packages/app',
        }),
        dependencies: {
          workspace: [core],
          external: catalog.pick('effect', 'react'),
        },
      })

      expect(composed.dependencies).toEqual({
        '@test/core': 'workspace:^',
        effect: '3.19.14',
        react: '19.2.3',
      })
      expect(composed.workspace).toEqual({
        repoName: repo.repoName,
        memberPath: 'packages/app',
        deps: [core],
      })
    })

    it('materializes selected cross-repo dependencies for consumer peer resolution', () => {
      const foreignRepo = createTempRepo('packages/shared')
      const shared = packageJson(
        {
          name: '@foreign/shared',
          version: '1.0.0',
        },
        catalog.compose({
          workspace: workspace({
            repoName: foreignRepo.repoName,
            memberPath: 'packages/shared',
          }),
          peerDependencies: {
            external: catalog.pick('effect'),
          },
        }),
      )

      const composed = catalog.compose({
        workspace: workspace({
          repoName: repo.repoName,
          memberPath: 'packages/app',
        }),
        dependencies: {
          workspace: [shared],
          crossRepoProtocols: {
            '@foreign/shared': 'file',
          },
        },
        mode: 'install',
      })

      expect(composed.dependencies).toEqual({
        '@foreign/shared': `file:repos/${foreignRepo.repoName}/packages/shared`,
        effect: '3.19.14',
      })
    })

    it('emits a path-based workspace specifier for a live same-repo link', () => {
      // `injectWorkspacePackages: true` makes pnpm inject a same-repo dependency
      // as a `file:` copy once the consumer's peer graph differs, and pnpm 12
      // ignores `dependenciesMeta.<dep>.injected`. A path-based specifier keeps
      // the workspace protocol while forcing pnpm's local link resolution.
      const nested = createTempRepo(
        'packages/utils',
        'packages/app',
        'packages/app/nested/lib',
        'packages/examples/basic',
      )
      const utils = packageJson(
        { name: '@test/utils', version: '1.0.0' },
        catalog.compose({
          workspace: workspace({ repoName: nested.repoName, memberPath: 'packages/utils' }),
        }),
      )

      const sibling = catalog.compose({
        workspace: workspace({ repoName: nested.repoName, memberPath: 'packages/app' }),
        devDependencies: {
          workspace: [utils],
          liveWorkspaceLinks: ['@test/utils'],
        },
      })
      const deeper = catalog.compose({
        workspace: workspace({
          repoName: nested.repoName,
          memberPath: 'packages/examples/basic',
        }),
        devDependencies: {
          workspace: [utils],
          liveWorkspaceLinks: ['@test/utils'],
        },
      })
      const unlisted = catalog.compose({
        workspace: workspace({ repoName: nested.repoName, memberPath: 'packages/app' }),
        devDependencies: {
          workspace: [utils],
        },
      })
      const nestedLib = packageJson(
        { name: '@test/nested-lib', version: '1.0.0' },
        catalog.compose({
          workspace: workspace({
            repoName: nested.repoName,
            memberPath: 'packages/app/nested/lib',
          }),
        }),
      )
      // pnpm rejects a bare relative body ("Invalid workspace: spec"), so a
      // descendant target must carry an explicit `./`.
      const descendant = catalog.compose({
        workspace: workspace({ repoName: nested.repoName, memberPath: 'packages/app' }),
        devDependencies: {
          workspace: [nestedLib],
          liveWorkspaceLinks: ['@test/nested-lib'],
        },
      })

      expect(sibling.devDependencies).toEqual({ '@test/utils': 'workspace:../utils' })
      expect(deeper.devDependencies).toEqual({ '@test/utils': 'workspace:../../utils' })
      expect(unlisted.devDependencies).toEqual({ '@test/utils': 'workspace:^' })
      expect(descendant.devDependencies).toEqual({
        '@test/nested-lib': 'workspace:./nested/lib',
      })
    })

    it('rejects a live workspace link that points a member at itself', () => {
      const selfRepo = createTempRepo('packages/utils')
      const utils = packageJson(
        { name: '@test/utils', version: '1.0.0' },
        catalog.compose({
          workspace: workspace({ repoName: selfRepo.repoName, memberPath: 'packages/utils' }),
        }),
      )

      expect(() =>
        catalog.compose({
          workspace: workspace({ repoName: selfRepo.repoName, memberPath: 'packages/utils' }),
          devDependencies: {
            workspace: [utils],
            liveWorkspaceLinks: ['@test/utils'],
          },
        }),
      ).toThrow(/cannot point a workspace member at itself/)
    })

    it('installs inherited peers explicitly in install mode', () => {
      const utilsComposition = catalog.compose({
        workspace: workspace({
          repoName: repo.repoName,
          memberPath: 'packages/utils',
        }),
        peerDependencies: {
          external: catalog.pick('effect', '@effect/platform'),
        },
      })
      const utils = packageJson(
        {
          name: '@test/utils',
          version: '1.0.0',
        },
        utilsComposition,
      )

      const composed = catalog.compose({
        workspace: workspace({
          repoName: repo.repoName,
          memberPath: 'packages/app',
        }),
        dependencies: {
          workspace: [utils],
          external: catalog.pick('react'),
        },
        mode: 'install',
      })

      expect(composed.dependencies).toEqual({
        '@effect/platform': '0.94.1',
        '@test/utils': 'workspace:^',
        effect: '3.19.14',
        react: '19.2.3',
      })
    })

    it('collects inherited peers transitively in install mode', () => {
      const utilsComposition = catalog.compose({
        workspace: workspace({
          repoName: repo.repoName,
          memberPath: 'packages/utils',
        }),
        peerDependencies: {
          external: catalog.pick('effect'),
        },
      })
      const utils = packageJson(
        {
          name: '@test/utils',
          version: '1.0.0',
        },
        utilsComposition,
      )
      const coreComposition = catalog.compose({
        workspace: workspace({
          repoName: repo.repoName,
          memberPath: 'packages/core',
        }),
        dependencies: {
          workspace: [utils],
        },
      })
      const core = packageJson(
        {
          name: '@test/core',
          version: '1.0.0',
        },
        coreComposition,
      )
      const composed = catalog.compose({
        workspace: workspace({
          repoName: repo.repoName,
          memberPath: 'packages/app',
        }),
        dependencies: {
          workspace: [core],
        },
        mode: 'install',
      })

      expect(composed.dependencies).toEqual({
        '@test/core': 'workspace:^',
        effect: '3.19.14',
      })
    })

    it('throws when install mode cannot resolve an inherited peer version', () => {
      const appComposition = catalog.compose({
        workspace: workspace({
          repoName: repo.repoName,
          memberPath: 'packages/app',
        }),
        peerDependencies: {
          external: {
            missing: '1.0.0',
          },
        },
      })
      const app = packageJson(
        {
          name: '@test/app',
          version: '1.0.0',
        },
        appComposition,
      )

      expect(() =>
        catalog.compose({
          workspace: workspace({
            repoName: repo.repoName,
            memberPath: 'packages/app',
          }),
          dependencies: {
            workspace: [app],
          },
          mode: 'install',
        }),
      ).toThrow('Catalog is missing explicit install version for inherited peer "missing"')
    })

    it('prefers workspace:^ over registry version for workspace packages in install mode', () => {
      const utilsComposition = catalog.compose({
        workspace: workspace({
          repoName: repo.repoName,
          memberPath: 'packages/utils',
        }),
        peerDependencies: {
          external: catalog.pick('effect'),
        },
      })
      const utils = packageJson(
        {
          name: '@test/utils',
          version: '1.0.0',
        },
        utilsComposition,
      )

      const coreComposition = catalog.compose({
        workspace: workspace({
          repoName: repo.repoName,
          memberPath: 'packages/core',
        }),
        peerDependencies: {
          external: catalog.pick('effect', '@effect/platform'),
        },
      })
      const core = packageJson(
        {
          name: '@test/core',
          version: '1.0.0',
        },
        coreComposition,
      )

      /** @test/core has peer deps on effect and @effect/platform.
       * When @test/utils is also a devDependency workspace package with peer dep on effect,
       * the inherited peer "effect" should NOT appear as a registry version in dependencies
       * — only the workspace:^ entry should remain. */
      const composed = catalog.compose({
        workspace: workspace({
          repoName: repo.repoName,
          memberPath: 'packages/app',
        }),
        dependencies: {
          workspace: [core],
          external: catalog.pick('react'),
        },
        devDependencies: {
          workspace: [utils],
        },
        mode: 'install',
      })

      expect(composed.dependencies).toEqual({
        '@effect/platform': '0.94.1',
        '@test/core': 'workspace:^',
        effect: '3.19.14',
        react: '19.2.3',
      })
      expect(composed.devDependencies).toEqual({
        '@test/utils': 'workspace:^',
      })
    })

    it('skips inherited peer when same package is a workspace dep in dependencies', () => {
      const libComposition = catalog.compose({
        workspace: workspace({
          repoName: repo.repoName,
          memberPath: 'packages/utils',
        }),
        peerDependencies: {
          external: catalog.pick('effect'),
        },
      })
      const lib = packageJson({ name: '@test/utils', version: '1.0.0' }, libComposition)

      const coreComposition = catalog.compose({
        workspace: workspace({
          repoName: repo.repoName,
          memberPath: 'packages/core',
        }),
        peerDependencies: {
          external: { '@test/utils': '1.0.0' },
        },
      })
      const core = packageJson({ name: '@test/core', version: '1.0.0' }, coreComposition)

      /** @test/core declares @test/utils as a peer dep.
       * The consumer lists @test/utils as a workspace dep in dependencies.
       * In install mode, the inherited peer should NOT generate a registry entry
       * for @test/utils — the workspace:^ entry in dependencies takes precedence. */
      const composed = catalog.compose({
        workspace: workspace({
          repoName: repo.repoName,
          memberPath: 'packages/app',
        }),
        dependencies: {
          workspace: [core, lib],
        },
        mode: 'install',
      })

      expect(composed.dependencies).toEqual({
        '@test/core': 'workspace:^',
        '@test/utils': 'workspace:^',
        effect: '3.19.14',
      })
    })

    it('returns empty workspace metadata when no workspace packages are provided', () => {
      const composed = catalog.compose({
        workspace: workspace({
          repoName: repo.repoName,
          memberPath: 'packages/app',
        }),
        dependencies: {
          external: catalog.pick('effect'),
        },
      })

      expect(composed.dependencies).toEqual({
        effect: '3.19.14',
      })
      expect(composed.workspace).toEqual({
        repoName: repo.repoName,
        memberPath: 'packages/app',
        deps: [],
      })
    })
  })
})
