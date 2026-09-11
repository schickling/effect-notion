import { Option, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  buildSourceStringWithRef,
  CONFIG_FILE_NAME_JSON,
  DEFAULT_STORE_PATH,
  ENV_VARS,
  generateJsonSchema,
  getBaseSourceString,
  getSourceRef,
  getSourceUrl,
  getStorePath,
  isRemoteSource,
  isValidMemberName,
  MegarepoConfig,
  parseSourceString,
  validateMemberName,
} from './config.ts'

describe('config', () => {
  describe('constants', () => {
    it('should have correct config file name', () => {
      expect(CONFIG_FILE_NAME_JSON).toBe('megarepo.json')
    })

    it('should have correct default store path', () => {
      expect(DEFAULT_STORE_PATH).toBe('~/.megarepo')
    })

    it('should have correct environment variable names', () => {
      expect(ENV_VARS.STORE).toBe('MEGAREPO_STORE')
    })
  })

  describe('isValidMemberName', () => {
    describe('valid names', () => {
      it('should accept simple alphanumeric names', () => {
        expect(isValidMemberName('effect')).toBe(true)
        expect(isValidMemberName('my-repo')).toBe(true)
        expect(isValidMemberName('my_repo')).toBe(true)
        expect(isValidMemberName('repo123')).toBe(true)
        expect(isValidMemberName('MyRepo')).toBe(true)
      })

      it('should accept names with special characters', () => {
        expect(isValidMemberName('repo@v2')).toBe(true)
        expect(isValidMemberName('repo+plus')).toBe(true)
        expect(isValidMemberName('repo=equal')).toBe(true)
      })
    })

    describe('invalid names - path traversal', () => {
      it('should reject empty name', () => {
        expect(isValidMemberName('')).toBe(false)
      })

      it('should reject path separators', () => {
        expect(isValidMemberName('path/to/repo')).toBe(false)
        expect(isValidMemberName('path\\to\\repo')).toBe(false)
        expect(isValidMemberName('../parent')).toBe(false)
        expect(isValidMemberName('./current')).toBe(false)
      })

      it('should reject directory traversal sequences', () => {
        expect(isValidMemberName('..')).toBe(false)
        expect(isValidMemberName('.')).toBe(false)
        expect(isValidMemberName('foo..bar')).toBe(false)
      })
    })

    describe('invalid names - hidden files and flags', () => {
      it('should reject names starting with dot', () => {
        expect(isValidMemberName('.hidden')).toBe(false)
        expect(isValidMemberName('.git')).toBe(false)
        expect(isValidMemberName('.env')).toBe(false)
      })

      it('should reject names starting with hyphen', () => {
        expect(isValidMemberName('-flag')).toBe(false)
        expect(isValidMemberName('--option')).toBe(false)
      })
    })

    describe('invalid names - control characters', () => {
      it('should reject null bytes', () => {
        expect(isValidMemberName('name\x00evil')).toBe(false)
      })

      it('should reject other control characters', () => {
        expect(isValidMemberName('name\x01evil')).toBe(false)
        expect(isValidMemberName('name\x1fend')).toBe(false)
        expect(isValidMemberName('\ttab')).toBe(false)
        expect(isValidMemberName('new\nline')).toBe(false)
        expect(isValidMemberName('carriage\rreturn')).toBe(false)
      })
    })
  })

  describe('validateMemberName', () => {
    it('should return undefined for valid names', () => {
      expect(validateMemberName('effect')).toBeUndefined()
      expect(validateMemberName('my-repo')).toBeUndefined()
      expect(validateMemberName('repo123')).toBeUndefined()
    })

    it('should return error message for empty name', () => {
      expect(validateMemberName('')).toBe('Member name cannot be empty')
    })

    it('should return error message for path separators', () => {
      expect(validateMemberName('path/repo')).toBe('Member name cannot contain path separators')
      expect(validateMemberName('path\\repo')).toBe('Member name cannot contain path separators')
    })

    it('should return error message for . or ..', () => {
      expect(validateMemberName('.')).toBe('Member name cannot be . or ..')
      expect(validateMemberName('..')).toBe('Member name cannot be . or ..')
    })

    it('should return error message for names containing ..', () => {
      expect(validateMemberName('foo..bar')).toBe('Member name cannot contain ..')
    })

    it('should return error message for names starting with dot', () => {
      expect(validateMemberName('.hidden')).toBe('Member name cannot start with a dot')
    })

    it('should return error message for names starting with hyphen', () => {
      expect(validateMemberName('-flag')).toBe('Member name cannot start with a hyphen')
    })

    it('should return error message for control characters', () => {
      expect(validateMemberName('name\x00evil')).toBe(
        'Member name cannot contain control characters',
      )
      expect(validateMemberName('new\nline')).toBe('Member name cannot contain control characters')
    })
  })

  describe('parseSourceString', () => {
    describe('GitHub shorthand', () => {
      it('should parse owner/repo', () => {
        const source = parseSourceString('owner/repo')
        expect(source).toEqual({
          type: 'github',
          owner: 'owner',
          repo: 'repo',
          ref: Option.none(),
        })
      })

      it('should parse owner/repo#ref', () => {
        const source = parseSourceString('owner/repo#main')
        expect(source).toEqual({
          type: 'github',
          owner: 'owner',
          repo: 'repo',
          ref: Option.some('main'),
        })
      })

      it('should parse owner/repo#tag', () => {
        const source = parseSourceString('effect-ts/effect#v3.0.0')
        expect(source).toEqual({
          type: 'github',
          owner: 'effect-ts',
          repo: 'effect',
          ref: Option.some('v3.0.0'),
        })
      })

      it('should return undefined for invalid shorthand', () => {
        expect(parseSourceString('invalid')).toBeUndefined()
        expect(parseSourceString('')).toBeUndefined()
        // '/' is a valid path, not invalid
        // '/repo' is also a valid path
        expect(parseSourceString('owner/')).toBeUndefined()
      })
    })

    describe('HTTPS URLs', () => {
      it('should parse https URL', () => {
        const source = parseSourceString('https://github.com/owner/repo')
        expect(source).toEqual({
          type: 'url',
          url: 'https://github.com/owner/repo',
          ref: Option.none(),
        })
      })

      it('should parse https URL with ref', () => {
        const source = parseSourceString('https://github.com/owner/repo#main')
        expect(source).toEqual({
          type: 'url',
          url: 'https://github.com/owner/repo',
          ref: Option.some('main'),
        })
      })

      it('should parse https URL with .git suffix', () => {
        const source = parseSourceString('https://github.com/owner/repo.git#v1.0.0')
        expect(source).toEqual({
          type: 'url',
          url: 'https://github.com/owner/repo.git',
          ref: Option.some('v1.0.0'),
        })
      })

      it('should parse non-GitHub URLs', () => {
        const source = parseSourceString('https://gitlab.com/org/repo')
        expect(source).toEqual({
          type: 'url',
          url: 'https://gitlab.com/org/repo',
          ref: Option.none(),
        })
      })
    })

    describe('SSH URLs', () => {
      it('should parse ssh URL', () => {
        const source = parseSourceString('git@github.com:owner/repo.git')
        expect(source).toEqual({
          type: 'url',
          url: 'git@github.com:owner/repo.git',
          ref: Option.none(),
        })
      })

      it('should parse ssh URL with ref', () => {
        const source = parseSourceString('git@github.com:owner/repo#main')
        expect(source).toEqual({
          type: 'url',
          url: 'git@github.com:owner/repo',
          ref: Option.some('main'),
        })
      })

      it('should parse non-GitHub ssh URLs', () => {
        const source = parseSourceString('git@gitlab.com:org/repo.git#develop')
        expect(source).toEqual({
          type: 'url',
          url: 'git@gitlab.com:org/repo.git',
          ref: Option.some('develop'),
        })
      })
    })

    describe('Local paths', () => {
      it('should parse relative path with ./', () => {
        const source = parseSourceString('./packages/local')
        expect(source).toEqual({
          type: 'path',
          path: './packages/local',
        })
      })

      it('should parse relative path with ../', () => {
        const source = parseSourceString('../other-repo')
        expect(source).toEqual({
          type: 'path',
          path: '../other-repo',
        })
      })

      it('should parse absolute path', () => {
        const source = parseSourceString('/home/user/repos/my-repo')
        expect(source).toEqual({
          type: 'path',
          path: '/home/user/repos/my-repo',
        })
      })

      it('should parse home-relative path', () => {
        const source = parseSourceString('~/repos/my-repo')
        expect(source).toEqual({
          type: 'path',
          path: '~/repos/my-repo',
        })
      })

      it('should keep entire string for local paths including hash', () => {
        // Local paths don't support #ref syntax - the entire string is the path
        const source = parseSourceString('./packages/local#main')
        // The #main is kept as part of the path (unusual but valid filesystem path)
        expect(source).toEqual({
          type: 'path',
          path: './packages/local#main',
        })
      })
    })
  })

  describe('getSourceUrl', () => {
    it('should expand GitHub shorthand', () => {
      const url = getSourceUrl({
        type: 'github',
        owner: 'owner',
        repo: 'repo',
        ref: Option.none(),
      })
      expect(url).toBe('https://github.com/owner/repo')
    })

    it('should return URL as-is', () => {
      const url = getSourceUrl({
        type: 'url',
        url: 'git@github.com:owner/repo.git',
        ref: Option.none(),
      })
      expect(url).toBe('git@github.com:owner/repo.git')
    })

    it('should return undefined for local paths', () => {
      const url = getSourceUrl({ type: 'path', path: './local' })
      expect(url).toBeUndefined()
    })
  })

  describe('getSourceRef', () => {
    it('should return ref for GitHub source', () => {
      const ref = getSourceRef({
        type: 'github',
        owner: 'owner',
        repo: 'repo',
        ref: Option.some('main'),
      })
      expect(Option.getOrNull(ref)).toBe('main')
    })

    it('should return none for path source', () => {
      const ref = getSourceRef({ type: 'path', path: './local' })
      expect(Option.isNone(ref)).toBe(true)
    })
  })

  describe('isRemoteSource', () => {
    it('should return true for GitHub source', () => {
      expect(
        isRemoteSource({
          type: 'github',
          owner: 'o',
          repo: 'r',
          ref: Option.none(),
        }),
      ).toBe(true)
    })

    it('should return true for URL source', () => {
      expect(isRemoteSource({ type: 'url', url: 'https://...', ref: Option.none() })).toBe(true)
    })

    it('should return false for path source', () => {
      expect(isRemoteSource({ type: 'path', path: './local' })).toBe(false)
    })
  })

  describe('getStorePath', () => {
    it('should generate path for github source', () => {
      const path = getStorePath({
        type: 'github',
        owner: 'owner',
        repo: 'repo',
        ref: Option.none(),
      })
      expect(path).toBe('github.com/owner/repo/')
    })

    it('should generate path for ssh url', () => {
      const path = getStorePath({
        type: 'url',
        url: 'git@github.com:owner/repo.git',
        ref: Option.none(),
      })
      expect(path).toBe('github.com/owner/repo/')
    })

    it('should generate path for https url', () => {
      const path = getStorePath({
        type: 'url',
        url: 'https://github.com/owner/repo.git',
        ref: Option.none(),
      })
      expect(path).toBe('github.com/owner/repo/')
    })

    it('should generate path for https url without .git suffix', () => {
      const path = getStorePath({
        type: 'url',
        url: 'https://github.com/owner/repo',
        ref: Option.none(),
      })
      expect(path).toBe('github.com/owner/repo/')
    })

    it('should generate path for gitlab ssh url', () => {
      const path = getStorePath({
        type: 'url',
        url: 'git@gitlab.com:owner/repo.git',
        ref: Option.none(),
      })
      expect(path).toBe('gitlab.com/owner/repo/')
    })

    it('should handle unknown url formats with fallback', () => {
      const path = getStorePath({
        type: 'url',
        url: 'some-weird-url/repo.git',
        ref: Option.none(),
      })
      expect(path).toBe('other/repo/')
    })

    it('should generate path for local path', () => {
      const path = getStorePath({ type: 'path', path: '/some/local/my-repo' })
      expect(path).toBe('local/my-repo/')
    })

    it('should handle path with trailing slash', () => {
      const path = getStorePath({ type: 'path', path: '/some/local/my-repo/' })
      expect(path).toBe('local/my-repo/')
    })
  })

  describe('MegarepoConfig schema', () => {
    it('should decode config with string members', () => {
      const input = {
        members: {
          effect: 'effect-ts/effect',
          'effect-v3': 'effect-ts/effect#v3.0.0',
          'local-lib': './packages/local',
        },
      }
      const result = Schema.decodeSync(MegarepoConfig)(input)
      expect(result.members['effect']).toBe('effect-ts/effect')
      expect(result.members['effect-v3']).toBe('effect-ts/effect#v3.0.0')
      expect(result.members['local-lib']).toBe('./packages/local')
    })

    it('should decode config with generators', () => {
      const input = {
        members: {},
        generators: {
          vscode: { enabled: true, exclude: ['docs'] },
          composition: {
            enabled: true,
            platformHub: 'effect-utils',
            ignoredMembers: ['effect'],
            isolationDir: 'fleet-buck',
          },
        },
      }
      const result = Schema.decodeSync(MegarepoConfig)(input)
      expect(result.generators?.vscode?.enabled).toBe(true)
      expect(result.generators?.vscode?.exclude).toEqual(['docs'])
      expect(result.generators?.composition?.enabled).toBe(true)
      expect(result.generators?.composition?.platformHub).toBe('effect-utils')
      expect(result.generators?.composition?.ignoredMembers).toEqual(['effect'])
      expect(result.generators?.composition?.isolationDir).toBe('fleet-buck')
    })

    it.each([
      ['missing platform hub', { enabled: true }],
      ['invalid platform hub', { platformHub: '../effect-utils' }],
      ['invalid isolation directory', { platformHub: 'effect-utils', isolationDir: 'nested/path' }],
    ])('should reject composition config with %s', (_name, composition) => {
      expect(() =>
        Schema.decodeUnknownSync(MegarepoConfig)({ members: {}, generators: { composition } }),
      ).toThrow()
    })

    it('should decode config with $schema field', () => {
      const input = {
        $schema: './schema/megarepo.schema.json',
        members: {},
      }
      const result = Schema.decodeSync(MegarepoConfig)(input)
      expect(result.$schema).toBe('./schema/megarepo.schema.json')
    })

    it('should reject config without members', () => {
      const input = {}
      expect(() => Schema.decodeUnknownSync(MegarepoConfig)(input)).toThrow()
    })

    it('should reject config with non-string members', () => {
      const input = {
        members: {
          effect: { github: 'effect-ts/effect' }, // object format not supported
        },
      }
      expect(() => Schema.decodeUnknownSync(MegarepoConfig)(input)).toThrow()
    })
  })

  describe('generateJsonSchema', () => {
    it('should generate valid JSON schema', () => {
      const schema = generateJsonSchema() as unknown as Record<string, unknown>
      expect(schema).toBeDefined()
      expect(schema['$schema']).toBe('https://json-schema.org/draft/2020-12/schema')
      expect(schema['$ref']).toBe('#/$defs/MegarepoConfigEncoded')
      expect(schema['$defs']).toBeDefined()
      const defs = schema['$defs'] as Record<string, Record<string, unknown>>
      expect(defs['MegarepoConfigEncoded']).toBeDefined()
      expect(defs['MegarepoConfigEncoded']?.['type']).toBe('object')
      const composition = defs['CompositionGeneratorConfigEncoded']!
      expect(composition).toMatchObject({
        type: 'object',
        required: ['platformHub'],
        additionalProperties: false,
      })
      expect((composition['properties'] as Record<string, unknown>)['platformHub']).toMatchObject({
        type: 'string',
        pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$',
      })
    })
  })

  describe('buildSourceStringWithRef', () => {
    it('should add ref to source without existing ref', () => {
      expect(buildSourceStringWithRef({ sourceString: 'owner/repo', newRef: 'main' })).toBe(
        'owner/repo#main',
      )
    })

    it('should replace existing ref', () => {
      expect(
        buildSourceStringWithRef({ sourceString: 'owner/repo#old-branch', newRef: 'new-branch' }),
      ).toBe('owner/repo#new-branch')
    })

    it('should work with URL sources', () => {
      expect(
        buildSourceStringWithRef({
          sourceString: 'https://github.com/owner/repo',
          newRef: 'v1.0.0',
        }),
      ).toBe('https://github.com/owner/repo#v1.0.0')
    })

    it('should work with SSH URL sources', () => {
      expect(
        buildSourceStringWithRef({
          sourceString: 'git@github.com:owner/repo.git',
          newRef: 'feature/foo',
        }),
      ).toBe('git@github.com:owner/repo.git#feature/foo')
    })

    it('should replace ref in URL sources', () => {
      expect(
        buildSourceStringWithRef({
          sourceString: 'https://github.com/owner/repo#old',
          newRef: 'new',
        }),
      ).toBe('https://github.com/owner/repo#new')
    })

    it('should handle refs with slashes', () => {
      expect(
        buildSourceStringWithRef({ sourceString: 'owner/repo', newRef: 'feature/my-feature' }),
      ).toBe('owner/repo#feature/my-feature')
    })

    it('should handle commit SHA refs', () => {
      const sha = 'abc123def456789012345678901234567890abcd'
      expect(buildSourceStringWithRef({ sourceString: 'owner/repo', newRef: sha })).toBe(
        `owner/repo#${sha}`,
      )
    })
  })

  describe('getBaseSourceString', () => {
    it('should return source without ref when no ref present', () => {
      expect(getBaseSourceString('owner/repo')).toBe('owner/repo')
    })

    it('should strip ref from source', () => {
      expect(getBaseSourceString('owner/repo#main')).toBe('owner/repo')
    })

    it('should strip ref from URL sources', () => {
      expect(getBaseSourceString('https://github.com/o/r#v1.0.0')).toBe('https://github.com/o/r')
    })

    it('should strip ref from SSH URL sources', () => {
      expect(getBaseSourceString('git@github.com:o/r.git#develop')).toBe('git@github.com:o/r.git')
    })

    it('should handle refs with slashes', () => {
      expect(getBaseSourceString('owner/repo#feature/foo/bar')).toBe('owner/repo')
    })
  })
})
