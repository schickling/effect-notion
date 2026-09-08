import { createHash } from 'node:crypto'

import { describe, it } from '@effect/vitest'
import { Schema } from 'effect'
import * as fc from 'effect/testing/FastCheck'
import { expect } from 'vitest'

import {
  BUCK_MEMBER_MANIFEST_FILENAME,
  BuckMemberRemoteCacheSchema,
  COMPOSITION_GENERATION_MANIFEST_PATH,
  CompositionGenerationManifestSchema,
  CompositionRootOutputSchema,
  buckMemberCapabilityByToolId,
  buckMemberProjectedCapabilities,
  buckMemberRemoteCacheSections,
  decodeBuckMemberManifest,
  decodeBuckMemberManifestJson,
  decodeCompositionRootInput,
  encodeBuckMemberManifestJson,
  encodeCompositionRootInput,
  encodeCompositionRootOutput,
  generateCompositionRoot,
  resolveCompositionToolchainRequirements,
  type BuckMemberCapability,
  type BuckMemberManifest,
  type BuckMemberRemoteCache,
  type CompositionRootInput,
  type GeneratedCompositionFile,
} from './composition-root.ts'

const decoder = new TextDecoder()
const text = (file: GeneratedCompositionFile): string => decoder.decode(file.bytes)
const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0
const filesByPath = (input: CompositionRootInput): ReadonlyMap<string, GeneratedCompositionFile> =>
  new Map(generateCompositionRoot(input).files.map((file) => [file.path, file]))

const capability = (toolId: string): BuckMemberCapability => ({
  toolId,
  protocol: 'native-executable/v1',
  flakePackage: `${toolId}-package`,
  executable: `bin/${toolId}`,
})

const toolchainAuthority = (
  toolchain: string,
  provides: ReadonlyArray<BuckMemberCapability> = [],
) => ({
  _tag: 'ToolchainAuthority' as const,
  toolchain,
  provides,
})

const toolchainRequirement = (toolchain: string) => ({
  _tag: 'ToolchainRequirement' as const,
  toolchain,
})

const manifest = ({
  cell,
  memberKey = cell,
  projectIgnore = [],
  distOverlays = [],
  capabilities = [],
}: {
  readonly cell: string
  readonly memberKey?: string
  readonly projectIgnore?: ReadonlyArray<string>
  readonly distOverlays?: BuckMemberManifest['distOverlays']
  readonly capabilities?: BuckMemberManifest['capabilities']
}): BuckMemberManifest => ({
  schemaVersion: 1,
  cell,
  mount: `repos/${memberKey}`,
  projectIgnore,
  distOverlays,
  capabilities,
})

const input = ({
  members,
  platformHubCell = 'alpha',
  isolationDir,
  cacheSections,
  additionalProjectIgnores,
  resolvedBuckExecutable = '/nix/store/00000000000000000000000000000000-buck2/bin/buck2',
}: Pick<CompositionRootInput, 'members'> &
  Partial<Omit<CompositionRootInput, 'schemaVersion' | 'members'>>): CompositionRootInput => ({
  schemaVersion: 1,
  members,
  platformHubCell,
  isolationDir,
  cacheSections,
  additionalProjectIgnores,
  resolvedBuckExecutable,
})

const alphaMember = {
  memberKey: 'alpha',
  manifest: manifest({ cell: 'alpha' }),
} as const

describe('buck2 member manifest', () => {
  it('uses the tracked public filename and canonically decodes and encodes v1', () => {
    expect(BUCK_MEMBER_MANIFEST_FILENAME).toBe('buck2-member.json')
    const decoded = decodeBuckMemberManifest({
      schemaVersion: 1,
      cell: 'alpha',
      mount: 'repos/alpha',
      projectIgnore: ['generated', '**/dist', 'generated'],
      distOverlays: [
        { target: '//pkg:item_x', destination: 'dist/item_x' },
        { target: '//pkg:item.x', destination: 'dist/item.x' },
        { target: '//pkg:item-x', destination: 'dist/item-x' },
      ],
      capabilities: [capability('zeta'), capability('alpha')],
    })
    expect(decoded.projectIgnore).toEqual(['**/dist', 'generated'])
    expect(decoded.distOverlays).toEqual([
      { target: '//pkg:item-x', destination: 'dist/item-x' },
      { target: '//pkg:item.x', destination: 'dist/item.x' },
      { target: '//pkg:item_x', destination: 'dist/item_x' },
    ])
    expect(
      decoded.capabilities.filter((item) => 'toolId' in item).map((item) => item.toolId),
    ).toEqual(['alpha', 'zeta'])
    expect(buckMemberCapabilityByToolId({ manifest: decoded, toolId: 'alpha' })).toEqual(
      capability('alpha'),
    )
    expect(buckMemberCapabilityByToolId({ manifest: decoded, toolId: 'missing' })).toBeUndefined()

    const encoded = encodeBuckMemberManifestJson(decoded)
    expect(encoded.endsWith('\n')).toBe(true)
    expect(decodeBuckMemberManifestJson(encoded)).toEqual(decoded)
  })

  it('strictly decodes canonical credential-free remote cache coordinates', () => {
    const remoteCache: BuckMemberRemoteCache = {
      endpoint: 'grpc://dev3:41045',
      instanceName: 'effect-utils',
    }
    const decoded = decodeBuckMemberManifest({
      ...manifest({ cell: 'alpha' }),
      remoteCache,
    })

    expect(decoded.remoteCache).toEqual(remoteCache)
    expect(
      Schema.decodeUnknownSync(BuckMemberRemoteCacheSchema, {
        errors: 'all',
        onExcessProperty: 'error',
      })(remoteCache),
    ).toEqual(remoteCache)
    const encoded = encodeBuckMemberManifestJson(decoded)
    expect(encoded).not.toContain('BUCK2_REMOTE_CACHE_BASIC_AUTH')
    expect(encoded).not.toContain('authorization')
    expect(encoded).not.toContain('http_headers')
  })

  it.each([
    ['missing endpoint', { instanceName: 'effect-utils' }],
    ['missing instance', { endpoint: 'grpc://dev3:41045' }],
    ['non-string endpoint', { endpoint: 41045, instanceName: 'effect-utils' }],
    ['endpoint whitespace', { endpoint: ' grpc://dev3:41045', instanceName: 'effect-utils' }],
    ['endpoint credentials', { endpoint: 'grpc://user@dev3:41045', instanceName: 'effect-utils' }],
    ['endpoint path', { endpoint: 'grpc://dev3:41045/cache', instanceName: 'effect-utils' }],
    ['uppercase endpoint', { endpoint: 'GRPC://dev3:41045', instanceName: 'effect-utils' }],
    ['zero port', { endpoint: 'grpc://dev3:0', instanceName: 'effect-utils' }],
    ['out-of-range port', { endpoint: 'grpc://dev3:65536', instanceName: 'effect-utils' }],
    ['instance path', { endpoint: 'grpc://dev3:41045', instanceName: 'team/effect-utils' }],
    ['uppercase instance', { endpoint: 'grpc://dev3:41045', instanceName: 'Effect-Utils' }],
    [
      'unknown field',
      { endpoint: 'grpc://dev3:41045', instanceName: 'effect-utils', token: 'secret' },
    ],
  ])('rejects remote cache coordinates with %s', (_name, remoteCache) => {
    expect(() =>
      decodeBuckMemberManifest({ ...manifest({ cell: 'alpha' }), remoteCache }),
    ).toThrow()
  })

  it('lowers remote cache coordinates to the exact canonical cache sections', () => {
    expect(
      buckMemberRemoteCacheSections({
        endpoint: 'grpc://dev3:41045',
        instanceName: 'effect-utils',
      }),
    ).toEqual([
      {
        section: 'buck2',
        entries: [
          { key: 'default_allow_cache_upload', value: 'true' },
          { key: 'digest_algorithms', value: 'SHA256' },
        ],
      },
      {
        section: 'buck2_re_client',
        entries: [
          { key: 'action_cache_address', value: 'grpc://dev3:41045' },
          { key: 'cas_address', value: 'grpc://dev3:41045' },
          { key: 'engine_address', value: 'grpc://dev3:41045' },
          {
            key: 'http_headers',
            value: 'authorization: Basic $BUCK2_REMOTE_CACHE_BASIC_AUTH',
          },
          { key: 'instance_name', value: 'effect-utils' },
          { key: 'tls', value: 'false' },
        ],
      },
    ])
  })

  it.each([
    ['unknown field', { ...manifest({ cell: 'alpha' }), unknown: true }],
    ['invalid cell', { ...manifest({ cell: 'bad/cell' }), cell: 'bad/cell' }],
    ['invalid mount', { ...manifest({ cell: 'alpha' }), mount: '/repos/alpha' }],
    ['parent ignore', { ...manifest({ cell: 'alpha' }), projectIgnore: ['../escape'] }],
    ['comma ignore', { ...manifest({ cell: 'alpha' }), projectIgnore: ['a,b'] }],
    [
      'invalid capability executable',
      {
        ...manifest({ cell: 'alpha' }),
        capabilities: [{ ...capability('tsgo'), executable: '../tsgo' }],
      },
    ],
    [
      'invalid capability protocol',
      {
        ...manifest({ cell: 'alpha' }),
        capabilities: [{ ...capability('tsgo'), protocol: 'native executable/v1' }],
      },
    ],
    [
      'invalid flake package',
      {
        ...manifest({ cell: 'alpha' }),
        capabilities: [{ ...capability('tsgo'), flakePackage: 'packages/tsgo' }],
      },
    ],
    [
      'duplicate tool ids',
      { ...manifest({ cell: 'alpha' }), capabilities: [capability('tsgo'), capability('tsgo')] },
    ],
    [
      'unknown capability field',
      {
        ...manifest({ cell: 'alpha' }),
        capabilities: [{ ...capability('tsgo'), ambientPath: true }],
      },
    ],
  ])('rejects %s', (_name, value) => {
    expect(() => decodeBuckMemberManifest(value)).toThrow()
  })

  it.each([
    ['missing field', undefined],
    ['cell-qualified target', [{ target: 'alpha//pkg:item', destination: 'dist/item' }]],
    ['root-alias target', [{ target: 'root//pkg:item', destination: 'dist/item' }]],
    ['root-package target', [{ target: '//:item', destination: 'dist/item' }]],
    ['target whitespace', [{ target: '//pkg:bad item', destination: 'dist/item' }]],
    ['target backslash', [{ target: '//pkg:bad\\item', destination: 'dist/item' }]],
    ['target package traversal', [{ target: '//pkg/../other:item', destination: 'dist/item' }]],
    ['target-name dot segment', [{ target: '//pkg:../item', destination: 'dist/item' }]],
    ['absolute destination', [{ target: '//pkg:item', destination: '/dist/item' }]],
    ['destination traversal', [{ target: '//pkg:item', destination: '../dist/item' }]],
    ['destination inner traversal', [{ target: '//pkg:item', destination: 'dist/../item' }]],
    ['destination backslash', [{ target: '//pkg:item', destination: 'dist\\item' }]],
    ['destination comma', [{ target: '//pkg:item', destination: 'dist,item' }]],
    ['empty destination', [{ target: '//pkg:item', destination: '' }]],
    [
      'duplicate target',
      [
        { target: '//pkg:item', destination: 'dist/one' },
        { target: '//pkg:item', destination: 'dist/two' },
      ],
    ],
    [
      'duplicate destination',
      [
        { target: '//pkg:one', destination: 'dist/item' },
        { target: '//pkg:two', destination: 'dist/item' },
      ],
    ],
    [
      'overlapping destinations',
      [
        { target: '//pkg:one', destination: 'dist' },
        { target: '//pkg:two', destination: 'dist/item' },
      ],
    ],
    ['capability collision', [{ target: '//pkg:item', destination: '.buck2' }]],
  ])('rejects dist overlays with %s', (_name, distOverlays) => {
    const valid = manifest({ cell: 'alpha' })
    const candidate =
      distOverlays === undefined
        ? {
            schemaVersion: valid.schemaVersion,
            cell: valid.cell,
            mount: valid.mount,
            projectIgnore: valid.projectIgnore,
            capabilities: valid.capabilities,
          }
        : { ...valid, distOverlays }
    expect(() => decodeBuckMemberManifest(candidate)).toThrow()
  })
})

describe('shared hub toolchain authority', () => {
  const hub = {
    memberKey: 'hub',
    manifest: manifest({
      cell: 'hub',
      capabilities: [
        toolchainAuthority('bun', [capability('bun')]),
        toolchainAuthority('pnpm'),
        toolchainAuthority('tsgo', [capability('effect-tsgo')]),
      ],
    }),
  } as const

  it('resolves an explicit consumer requirement to the sole hub authority', () => {
    expect(
      resolveCompositionToolchainRequirements({
        platformHubCell: 'hub',
        members: [
          {
            memberKey: 'consumer',
            manifest: manifest({
              cell: 'consumer',
              capabilities: [toolchainRequirement('tsgo'), toolchainRequirement('bun')],
            }),
          },
          hub,
        ],
      }),
    ).toEqual([
      {
        memberKey: 'consumer',
        memberCell: 'consumer',
        toolchain: 'bun',
        authorityMemberKey: 'hub',
        authorityCell: 'hub',
      },
      {
        memberKey: 'consumer',
        memberCell: 'consumer',
        toolchain: 'tsgo',
        authorityMemberKey: 'hub',
        authorityCell: 'hub',
      },
    ])
  })

  it.each([
    [
      'an unknown toolchain',
      manifest({ cell: 'consumer', capabilities: [toolchainRequirement('unknown')] }),
    ],
    [
      'consumer toolchain authority',
      manifest({ cell: 'consumer', capabilities: [toolchainAuthority('bun')] }),
    ],
    [
      'a member-owned capability overriding the required hub toolchain',
      manifest({
        cell: 'consumer',
        capabilities: [toolchainRequirement('bun'), capability('bun')],
      }),
    ],
    [
      'a member-owned capability shadowing a hub-provided tool id',
      manifest({ cell: 'consumer', capabilities: [capability('effect-tsgo')] }),
    ],
  ])('rejects %s before root generation', (_name, consumerManifest) => {
    expect(() =>
      generateCompositionRoot(
        input({
          platformHubCell: 'hub',
          members: [{ memberKey: 'consumer', manifest: consumerManifest }, hub],
        }),
      ),
    ).toThrow()
  })

  it.each([
    ['duplicate hub authority', [toolchainAuthority('bun'), toolchainAuthority('bun')]],
    ['duplicate member requirement', [toolchainRequirement('bun'), toolchainRequirement('bun')]],
    ['consumer-selected instance', [{ ...toolchainRequirement('bun'), instance: 'bun-1.3.13' }]],
    ['consumer pin override', [{ ...toolchainRequirement('bun'), flakePackage: 'bun-next' }]],
    [
      'a provided tool id colliding with a member-owned capability',
      [capability('bun'), toolchainAuthority('bun', [capability('bun')])],
    ],
    [
      'the same tool id provided by two authorities',
      [
        toolchainAuthority('bun', [capability('shared')]),
        toolchainAuthority('tsgo', [capability('shared')]),
      ],
    ],
  ])('manifest decoding rejects %s', (_name, capabilities) => {
    expect(() =>
      decodeBuckMemberManifest({
        ...manifest({ cell: 'consumer' }),
        capabilities,
      }),
    ).toThrow()
  })

  it('projects member-owned capabilities together with every hub-provided one', () => {
    const decoded = decodeBuckMemberManifest(
      manifest({
        cell: 'hub',
        capabilities: [
          capability('buck2'),
          toolchainAuthority('tsgo', [capability('effect-tsgo'), capability('bun')]),
          toolchainAuthority('pnpm'),
        ],
      }),
    )
    expect(buckMemberProjectedCapabilities(decoded).map(({ toolId }) => toolId)).toEqual([
      'buck2',
      'bun',
      'effect-tsgo',
    ])
    expect(buckMemberCapabilityByToolId({ manifest: decoded, toolId: 'bun' })).toBeUndefined()
  })
})

describe('composition root goldens', () => {
  it('generates the exact single-member root', () => {
    const output = filesByPath(
      input({
        members: [
          {
            memberKey: 'alpha',
            manifest: manifest({ cell: 'alpha', projectIgnore: ['.git', '**/dist'] }),
          },
        ],
        cacheSections: buckMemberRemoteCacheSections({
          endpoint: 'grpc://cache.example:1234',
          instanceName: 'alpha',
        }),
      }),
    )

    expect(text(output.get('.buckconfig')!)).toBe(`[cells]
  workspace = .
  prelude = prelude
  alpha = repos/alpha

[cell_aliases]
  config = prelude
  ovr_config = prelude
  fbsource = prelude
  toolchains = alpha

[external_cells]
  prelude = bundled

[parser]
  target_platform_detector_spec = target:alpha//...->alpha//buck2/platforms:host_platform

[build]
  execution_platforms = alpha//buck2/platforms:host_execution_platform

[buck2]
  file_watcher = watchman
  default_allow_cache_upload = true
  digest_algorithms = SHA256

[buck2_re_client]
  action_cache_address = grpc://cache.example:1234
  cas_address = grpc://cache.example:1234
  engine_address = grpc://cache.example:1234
  http_headers = authorization: Basic $BUCK2_REMOTE_CACHE_BASIC_AUTH
  instance_name = alpha
  tls = false

[project]
  ignore = **/node_modules,**/node_modules/**,**/target,**/target/**,.buck2/capabilities.candidate.*,.devenv,.git,buck-out,node_modules,repos/.staging-*,repos/alpha/**/dist,repos/alpha/.git,target,tmp
`)
    expect(output.get('.buckroot')?.bytes).toHaveLength(0)
    expect(output.get('BUCK')?.bytes).toHaveLength(0)
  })

  it('generates the exact two-member cell and detector shape', () => {
    const config = text(
      filesByPath(
        input({
          members: [
            {
              memberKey: 'beta-source',
              manifest: manifest({
                cell: 'beta',
                memberKey: 'beta-source',
                projectIgnore: ['generated'],
              }),
            },
            alphaMember,
          ],
        }),
      ).get('.buckconfig')!,
    )

    expect(config).toBe(`[cells]
  workspace = .
  prelude = prelude
  alpha = repos/alpha
  beta = repos/beta-source

[cell_aliases]
  config = prelude
  ovr_config = prelude
  fbsource = prelude
  toolchains = alpha

[external_cells]
  prelude = bundled

[parser]
  target_platform_detector_spec = target:alpha//...->alpha//buck2/platforms:host_platform \\
    target:beta//...->alpha//buck2/platforms:host_platform

[build]
  execution_platforms = alpha//buck2/platforms:host_execution_platform

[buck2]
  file_watcher = watchman

[project]
  ignore = **/node_modules,**/node_modules/**,**/target,**/target/**,.buck2/capabilities.candidate.*,.devenv,.git,buck-out,node_modules,repos/.staging-*,repos/beta-source/generated,target,tmp
`)
  })

  it('emits the Prelude compatibility aliases without dead stub cells, aliases, or files', () => {
    const output = filesByPath(input({ members: [alphaMember] }))
    const config = text(output.get('.buckconfig')!)
    const cellsSection = config.match(/\[cells\]\n([\s\S]*?)\n\n\[cell_aliases\]/u)?.[1]
    expect(cellsSection).not.toMatch(/^\s+(?:toolchains|none)\s*=/mu)
    expect(config).toContain('  toolchains = alpha')
    expect(config).toContain('  fbsource = prelude')
    expect(config).not.toMatch(/^\s+(?:fbcode|fbcode_macros|buck|none)\s*=/mu)
    expect(output.has('none/BUCK')).toBe(false)
    expect(output.has('toolchains/BUCK')).toBe(false)
  })
})

describe('composition determinism and detector coverage', () => {
  it('is byte-for-byte deterministic under every unordered input permutation', () => {
    const first = generateCompositionRoot(
      input({
        members: [
          {
            memberKey: 'beta',
            manifest: manifest({
              cell: 'beta',
              projectIgnore: ['generated', '**/dist'],
              distOverlays: [
                { target: '//pkg:item_x', destination: 'dist/item_x' },
                { target: '//pkg:item-x', destination: 'dist/item-x' },
              ],
              capabilities: [capability('zeta'), capability('alpha')],
            }),
          },
          alphaMember,
        ],
        cacheSections: [
          {
            section: 'z_cache',
            entries: [
              { key: 'z', value: '2' },
              { key: 'a', value: '1' },
            ],
          },
          { section: 'a_cache', entries: [{ key: 'enabled', value: 'true' }] },
        ],
      }),
    )
    const permuted = generateCompositionRoot(
      input({
        members: [
          alphaMember,
          {
            memberKey: 'beta',
            manifest: manifest({
              cell: 'beta',
              projectIgnore: ['**/dist', 'generated'],
              distOverlays: [
                { target: '//pkg:item-x', destination: 'dist/item-x' },
                { target: '//pkg:item_x', destination: 'dist/item_x' },
              ],
              capabilities: [capability('alpha'), capability('zeta')],
            }),
          },
        ],
        cacheSections: [
          { section: 'a_cache', entries: [{ key: 'enabled', value: 'true' }] },
          {
            section: 'z_cache',
            entries: [
              { key: 'a', value: '1' },
              { key: 'z', value: '2' },
            ],
          },
        ],
      }),
    )
    expect(permuted).toEqual(first)
  })

  it('uses locale-independent code-unit order for every canonical collection', () => {
    const normalized = decodeCompositionRootInput(
      input({
        members: [
          {
            memberKey: 'member-underscore',
            manifest: manifest({ cell: 'a_b', memberKey: 'member-underscore' }),
          },
          {
            memberKey: 'member-hyphen',
            manifest: manifest({
              cell: 'a-b',
              memberKey: 'member-hyphen',
              projectIgnore: ['item_x', 'item.x', 'item-x'],
              capabilities: [capability('tool_x'), capability('tool.x'), capability('tool-x')],
            }),
          },
        ],
        platformHubCell: 'a-b',
        cacheSections: [
          { section: 'cache_x', entries: [] },
          {
            section: 'cache-x',
            entries: [
              { key: 'key_x', value: '3' },
              { key: 'key.x', value: '2' },
              { key: 'key-x', value: '1' },
            ],
          },
          { section: 'cache.x', entries: [] },
        ],
      }),
    )

    expect(normalized.members.map((member) => member.manifest.cell)).toEqual(['a-b', 'a_b'])
    expect(normalized.members[0]?.manifest.projectIgnore).toEqual(['item-x', 'item.x', 'item_x'])
    expect(
      normalized.members[0]?.manifest.capabilities
        .filter((item) => 'toolId' in item)
        .map((item) => item.toolId),
    ).toEqual(['tool-x', 'tool.x', 'tool_x'])
    expect(normalized.cacheSections.map((section) => section.section)).toEqual([
      'cache-x',
      'cache.x',
      'cache_x',
    ])
    expect(normalized.cacheSections[0]?.entries.map((entry) => entry.key)).toEqual([
      'key-x',
      'key.x',
      'key_x',
    ])

    const digest = `sha256:${'0'.repeat(64)}`
    const canonicalManifest = {
      schemaVersion: 1,
      files: [
        { path: 'a-b', mode: 0o644, sha256: digest },
        { path: 'a.b', mode: 0o644, sha256: digest },
        { path: 'a_b', mode: 0o644, sha256: digest },
      ],
    }
    expect(
      Schema.decodeUnknownSync(CompositionGenerationManifestSchema, {
        onExcessProperty: 'error',
      })(canonicalManifest).files.map((file) => file.path),
    ).toEqual(['a-b', 'a.b', 'a_b'])
    expect(() =>
      Schema.decodeUnknownSync(CompositionGenerationManifestSchema, {
        onExcessProperty: 'error',
      })({ ...canonicalManifest, files: canonicalManifest.files.toReversed() }),
    ).toThrow(/byte-sorted/u)
  })

  it.prop(
    'emits exactly one detector clause for every member cell',
    [
      fc.uniqueArray(
        fc
          .stringMatching(/^[a-z][a-z0-9_]{0,7}$/u)
          .filter((cell) => !['workspace', 'prelude', 'toolchains'].includes(cell)),
        { minLength: 1, maxLength: 12 },
      ),
    ],
    ([cells]) => {
      const hub = cells[0]!
      const config = text(
        filesByPath(
          input({
            members: cells.map((cell) => ({ memberKey: cell, manifest: manifest({ cell }) })),
            platformHubCell: hub,
          }),
        ).get('.buckconfig')!,
      )
      const detectorCells = [...config.matchAll(/target:([A-Za-z][A-Za-z0-9_-]*)\/\/\.\.\.-/gu)]
        .map((match) => match[1])
        .filter((cell): cell is string => cell !== undefined)
        .sort(compareCodeUnits)
      expect(detectorCells).toEqual([...cells].sort(compareCodeUnits))
      expect(detectorCells).toHaveLength(new Set(cells).size)
    },
    { fastCheck: { numRuns: 100 } },
  )
})

describe('ignore projection', () => {
  it('prefixes member ignores, sorts them, and deduplicates repeated contributions', () => {
    const config = text(
      filesByPath(
        input({
          members: [
            {
              memberKey: 'alpha',
              manifest: manifest({
                cell: 'alpha',
                projectIgnore: ['generated', 'generated', '**/dist'],
              }),
            },
          ],
        }),
      ).get('.buckconfig')!,
    )
    const ignore = config.match(/^  ignore = (.*)$/mu)?.[1]?.split(',') ?? []
    expect(ignore.filter((entry) => entry === 'repos/alpha/generated')).toHaveLength(1)
    expect(ignore).toContain('repos/alpha/**/dist')
    expect(ignore).toContain('repos/.staging-*')
    expect(ignore).toContain('.buck2/capabilities.candidate.*')
    expect(ignore).toEqual([...ignore].sort(compareCodeUnits))
  })
})

describe('generation manifest and output schema', () => {
  it('hashes every generated non-manifest file and excludes self recursion', () => {
    const output = generateCompositionRoot(input({ members: [alphaMember] }))
    expect(output.files.at(-1)?.path).toBe('.buckconfig')
    expect(output.files.map((file) => file.path)).toEqual([
      '.buckroot',
      '.megarepo/bin/buck2',
      '.megarepo/composition-generation.json',
      'BUCK',
      '.buckconfig',
    ])
    const manifestFile = output.files.find(
      (file) => file.path === COMPOSITION_GENERATION_MANIFEST_PATH,
    )!
    const generationManifest = Schema.decodeUnknownSync(CompositionGenerationManifestSchema, {
      onExcessProperty: 'error',
    })(JSON.parse(text(manifestFile)))
    expect(generationManifest.files).toHaveLength(output.files.length - 1)
    expect(generationManifest.files.map((file) => file.path)).not.toContain(
      COMPOSITION_GENERATION_MANIFEST_PATH,
    )
    for (const entry of generationManifest.files) {
      const generated = output.files.find((file) => file.path === entry.path)!
      expect(entry.mode).toBe(generated.mode)
      expect(entry.sha256).toBe(
        `sha256:${createHash('sha256').update(generated.bytes).digest('hex')}`,
      )
    }
  })

  it.each([
    ['', 'empty'],
    ['/absolute', 'absolute'],
    ['.', 'dot'],
    ['..', 'parent'],
    ['../outside', 'leading parent'],
    ['nested/../outside', 'inner parent'],
    ['nested/./file', 'inner dot'],
    ['nested//file', 'empty segment'],
    ['nested\\file', 'backslash'],
  ])('rejects %s as a generated and ownership %s path', (path) => {
    const generatedFile = { path, mode: 0o644, bytes: new Uint8Array() }
    expect(() =>
      Schema.decodeUnknownSync(CompositionRootOutputSchema, {
        onExcessProperty: 'error',
      })({
        files: [generatedFile, { path: '.buckconfig', mode: 0o644, bytes: new Uint8Array() }],
      }),
    ).toThrow()

    expect(() =>
      Schema.decodeUnknownSync(CompositionGenerationManifestSchema, {
        onExcessProperty: 'error',
      })({
        schemaVersion: 1,
        files: [{ path, mode: 0o644, sha256: `sha256:${'0'.repeat(64)}` }],
      }),
    ).toThrow()
  })

  it('canonically encodes input defaults and round-trips output bytes', () => {
    const rawInput = input({
      members: [{ memberKey: 'beta', manifest: manifest({ cell: 'beta' }) }, alphaMember],
    })
    const encodedInput = encodeCompositionRootInput(rawInput)
    expect(encodedInput.members.map((member) => member.manifest.cell)).toEqual(['alpha', 'beta'])
    expect(encodedInput.isolationDir).toBe('megarepo')
    expect(encodedInput.cacheSections).toEqual([])

    const output = generateCompositionRoot(rawInput)
    expect(encodeCompositionRootOutput(output)).toEqual(output)
  })

  it('strictly decodes output bytes and rejects unknown output fields', () => {
    const output = generateCompositionRoot(input({ members: [alphaMember] }))
    expect(Schema.decodeUnknownSync(CompositionRootOutputSchema)(output)).toEqual(output)
    expect(() =>
      Schema.decodeUnknownSync(CompositionRootOutputSchema, { onExcessProperty: 'error' })({
        ...output,
        generatedAt: 'ambient-time',
      }),
    ).toThrow()
  })
})

describe('reference-only project ignores', () => {
  it('excludes references without adding a cell or detector clause', () => {
    const config = text(
      filesByPath(
        input({ members: [alphaMember], additionalProjectIgnores: ['repos/effect'] }),
      ).get('.buckconfig')!,
    )
    expect(config).toContain('repos/effect')
    expect(config).not.toContain('effect = repos/effect')
    expect(config).not.toContain('target:effect//')
  })
})

describe('composition input failures', () => {
  it.each([
    [
      'mount disagreement',
      input({
        members: [{ memberKey: 'beta', manifest: manifest({ cell: 'alpha' }) }],
      }),
    ],
    [
      'duplicate member keys',
      input({
        members: [alphaMember, alphaMember],
      }),
    ],
    [
      'duplicate cells',
      input({
        members: [
          alphaMember,
          { memberKey: 'beta', manifest: manifest({ cell: 'alpha', memberKey: 'beta' }) },
        ],
      }),
    ],
    [
      'reserved cell collision',
      input({
        members: [
          {
            memberKey: 'workspace-member',
            manifest: manifest({ cell: 'workspace', memberKey: 'workspace-member' }),
          },
        ],
        platformHubCell: 'workspace',
      }),
    ],
    ['missing platform hub', input({ members: [alphaMember], platformHubCell: 'beta' })],
    [
      'non-hub remote cache authority',
      input({
        members: [
          alphaMember,
          {
            memberKey: 'beta',
            manifest: {
              ...manifest({ cell: 'beta' }),
              remoteCache: {
                endpoint: 'grpc://dev3:41045',
                instanceName: 'effect-utils',
              },
            },
          },
        ],
      }),
    ],
    [
      'duplicate cache sections',
      input({
        members: [alphaMember],
        cacheSections: [
          { section: 'buck2', entries: [] },
          { section: 'buck2', entries: [] },
        ],
      }),
    ],
    [
      'duplicate cache keys',
      input({
        members: [alphaMember],
        cacheSections: [
          {
            section: 'buck2',
            entries: [
              { key: 'digest_algorithms', value: 'SHA256' },
              { key: 'digest_algorithms', value: 'SHA1' },
            ],
          },
        ],
      }),
    ],
    [
      'generator-owned Buck watcher',
      input({
        members: [alphaMember],
        cacheSections: [
          {
            section: 'buck2',
            entries: [{ key: 'file_watcher', value: 'notify' }],
          },
        ],
      }),
    ],
    [
      'generator-owned cache section',
      input({
        members: [alphaMember],
        cacheSections: [{ section: 'cells', entries: [{ key: 'evil', value: 'path' }] }],
      }),
    ],
    ['unknown input field', { ...input({ members: [alphaMember] }), currentTime: 123 }],
  ])('rejects %s', (_name, value) => {
    expect(() => decodeCompositionRootInput(value)).toThrow()
  })

  it('defaults isolation to megarepo and accepts an explicit fixed value', () => {
    expect(decodeCompositionRootInput(input({ members: [alphaMember] })).isolationDir).toBe(
      'megarepo',
    )
    expect(
      decodeCompositionRootInput(input({ members: [alphaMember], isolationDir: 'fleet-buck' }))
        .isolationDir,
    ).toBe('fleet-buck')
  })
})
