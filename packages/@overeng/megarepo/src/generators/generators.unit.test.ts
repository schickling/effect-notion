/**
 * Generator Unit Tests
 *
 * Tests the pure content-generating functions for vscode and schema generators.
 */

import { describe, expect, it } from 'vitest'

import { EffectPath, type MegarepoConfig } from '../core/config.ts'
import { getEnabledGenerators } from './mod.ts'
import { generateSchemaContent } from './schema.ts'
import { generateVscodeContent } from './vscode.ts'

// =============================================================================
// Test Fixtures
// =============================================================================

const createTestConfig = (members: Record<string, string>): MegarepoConfig => ({
  members,
})

const testMegarepoRoot = EffectPath.unsafe.absoluteDir('/test/megarepo/')

// =============================================================================
// VSCode Generator Tests
// =============================================================================

describe('vscode generator', () => {
  describe('generateVscodeContent', () => {
    it('should generate vscode workspace with all members', () => {
      const content = generateVscodeContent({
        megarepoRoot: testMegarepoRoot,
        config: createTestConfig({
          lib1: 'owner/lib1',
          lib2: 'owner/lib2',
        }),
      })

      const workspace = JSON.parse(content)

      expect(workspace.folders).toHaveLength(3) // root + 2 members
      expect(workspace.folders[0]).toEqual({ path: '..', name: '(megarepo root)' })
      expect(workspace.folders).toContainEqual({ path: '../repos/lib1', name: 'lib1' })
      expect(workspace.folders).toContainEqual({ path: '../repos/lib2', name: 'lib2' })
    })

    it('should exclude members from options.exclude', () => {
      const content = generateVscodeContent({
        megarepoRoot: testMegarepoRoot,
        config: createTestConfig({
          lib1: 'owner/lib1',
          lib2: 'owner/lib2',
          'large-repo': 'owner/large-repo',
        }),
        exclude: ['large-repo'],
      })

      const workspace = JSON.parse(content)

      expect(workspace.folders).toHaveLength(3) // root + 2 (excluding large-repo)
      expect(workspace.folders).not.toContainEqual(
        expect.objectContaining({ path: '../repos/large-repo' }),
      )
    })

    it('should exclude members from config.generators.vscode.exclude', () => {
      const content = generateVscodeContent({
        megarepoRoot: testMegarepoRoot,
        config: {
          members: {
            lib1: 'owner/lib1',
            lib2: 'owner/lib2',
            excluded: 'owner/excluded',
          },
          generators: {
            vscode: {
              enabled: true,
              exclude: ['excluded'],
            },
          },
        },
      })

      const workspace = JSON.parse(content)

      expect(workspace.folders).toHaveLength(3) // root + 2 (excluding 'excluded')
      expect(workspace.folders).not.toContainEqual(
        expect.objectContaining({ path: '../repos/excluded' }),
      )
    })

    it('should prefer options.exclude over config.generators.vscode.exclude', () => {
      const content = generateVscodeContent({
        megarepoRoot: testMegarepoRoot,
        config: {
          members: {
            lib1: 'owner/lib1',
            lib2: 'owner/lib2',
            lib3: 'owner/lib3',
          },
          generators: {
            vscode: {
              exclude: ['lib1'], // from config
            },
          },
        },
        exclude: ['lib2'], // from options - should take precedence
      })

      const workspace = JSON.parse(content)

      // lib2 should be excluded (from options), lib1 should be included
      expect(workspace.folders).toContainEqual({ path: '../repos/lib1', name: 'lib1' })
      expect(workspace.folders).not.toContainEqual(
        expect.objectContaining({ path: '../repos/lib2' }),
      )
    })

    it('should include default file exclusions in settings', () => {
      const content = generateVscodeContent({
        megarepoRoot: testMegarepoRoot,
        config: createTestConfig({}),
      })

      const workspace = JSON.parse(content)

      expect(workspace.settings['files.exclude']).toEqual({
        '**/.git': true,
        '**/node_modules': true,
        '**/dist': true,
      })
    })

    it('should handle empty members', () => {
      const content = generateVscodeContent({
        megarepoRoot: testMegarepoRoot,
        config: createTestConfig({}),
      })

      const workspace = JSON.parse(content)

      expect(workspace.folders).toHaveLength(1) // only root
      expect(workspace.folders[0]).toEqual({
        path: '..',
        name: '(megarepo root)',
      })
    })

    it('should produce valid JSON with trailing newline', () => {
      const content = generateVscodeContent({
        megarepoRoot: testMegarepoRoot,
        config: createTestConfig({ lib: 'owner/lib' }),
      })

      expect(content.endsWith('\n')).toBe(true)
      expect(() => JSON.parse(content)).not.toThrow()
    })
  })
})

// =============================================================================
// Schema Generator Tests
// =============================================================================

describe('schema generator', () => {
  describe('generateSchemaContent', () => {
    it('should generate valid JSON Schema', () => {
      const content = generateSchemaContent()
      const schema = JSON.parse(content)

      expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
      expect(schema.$ref).toBe('#/$defs/MegarepoConfigEncoded')
      expect(schema.$defs).toBeDefined()
      expect(schema.$defs.MegarepoConfigEncoded).toBeDefined()
    })

    it('should include members property in schema', () => {
      const content = generateSchemaContent()
      const schema = JSON.parse(content)

      const megarepoConfigDef = schema.$defs.MegarepoConfigEncoded
      expect(megarepoConfigDef.type).toBe('object')
      expect(megarepoConfigDef.properties.members).toBeDefined()
    })

    it('should include generators property in schema', () => {
      const content = generateSchemaContent()
      const schema = JSON.parse(content)

      const megarepoConfigDef = schema.$defs.MegarepoConfigEncoded
      expect(megarepoConfigDef.properties.generators).toBeDefined()
    })

    it('should include $schema property for editor support', () => {
      const content = generateSchemaContent()
      const schema = JSON.parse(content)

      const megarepoConfigDef = schema.$defs.MegarepoConfigEncoded
      expect(megarepoConfigDef.properties.$schema).toBeDefined()
    })

    it('should produce valid JSON with trailing newline', () => {
      const content = generateSchemaContent()

      expect(content.endsWith('\n')).toBe(true)
      expect(() => JSON.parse(content)).not.toThrow()
    })

    it('should be deterministic (same output on multiple calls)', () => {
      const content1 = generateSchemaContent()
      const content2 = generateSchemaContent()

      expect(content1).toBe(content2)
    })
  })
})

// =============================================================================
// getEnabledGenerators Tests
// =============================================================================

describe('getEnabledGenerators', () => {
  it('should return empty array when no generators enabled', () => {
    const files = getEnabledGenerators({ members: { lib: 'owner/lib' } })

    expect(files).toEqual([])
  })

  it('should include vscode file when vscode generator enabled', () => {
    const files = getEnabledGenerators({
      members: { lib: 'owner/lib' },
      generators: { vscode: { enabled: true } },
    })

    expect(files).toContain('.vscode/megarepo.code-workspace')
    expect(files).not.toContain('schema/megarepo.schema.json')
  })
  it('should include every composition root file when composition generation is enabled', () => {
    const files = getEnabledGenerators({
      members: {},
      generators: { composition: { enabled: true, platformHub: 'effect-utils' } },
    })

    expect(files).toEqual([
      '.buckroot',
      '.buckconfig',
      '.watchmanconfig',
      'BUCK',
      '.megarepo/bin/buck2',
    ])
  })

  it('should return empty array when generators explicitly disabled', () => {
    const files = getEnabledGenerators({
      members: { lib: 'owner/lib' },
      generators: { vscode: { enabled: false } },
    })

    expect(files).toEqual([])
  })
})
