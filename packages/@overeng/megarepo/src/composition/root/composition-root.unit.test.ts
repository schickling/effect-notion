import { createHash } from 'node:crypto'

import { describe, it } from '@effect/vitest'
import { Schema } from 'effect'
import * as fc from 'effect/testing/FastCheck'
import { expect } from 'vitest'

import {
  BUCK_MEMBER_MANIFEST_FILENAME,
  COMPOSITION_GENERATION_MANIFEST_PATH,
  COMPOSITION_OWNED_PATHS,
  CompositionGenerationManifestSchema,
  CompositionRootOutputSchema,
  buckMemberCapabilityByToolId,
  buckMemberProjectedCapabilities,
  decodeBuckMemberManifest,
  decodeBuckMemberManifestJson,
  decodeCompositionRootInput,
  encodeBuckMemberManifestJson,
  encodeCompositionRootInput,
  encodeCompositionRootOutput,
  generateCompositionRoot,
  generatedWatchmanIgnoreDirs,
  resolveCompositionToolchainRequirements,
  WatchmanConfigSchema,
  type BuckMemberCapability,
  type BuckMemberManifest,
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
  resolvedWatchmanExecutable = '/nix/store/11111111111111111111111111111111-watchman/bin/watchman',
}: Pick<CompositionRootInput, 'members'> &
  Partial<Omit<CompositionRootInput, 'schemaVersion' | 'members'>>): CompositionRootInput => ({
  schemaVersion: 1,
  members,
  platformHubCell,
  isolationDir,
  cacheSections,
  additionalProjectIgnores,
  resolvedBuckExecutable,
  resolvedWatchmanExecutable,
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
        cacheSections: [
          {
            section: 'buck2_re_client',
            entries: [
              { key: 'tls', value: 'false' },
              { key: 'action_cache_address', value: 'grpc://cache.example:1234' },
            ],
          },
          {
            section: 'buck2',
            entries: [
              { key: 'digest_algorithms', value: 'SHA256' },
              { key: 'default_allow_cache_upload', value: 'true' },
            ],
          },
        ],
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

const effectLikeMember = {
  memberKey: 'effect-utils',
  manifest: manifest({
    cell: 'effect_utils',
    memberKey: 'effect-utils',
    projectIgnore: [
      '**/dist',
      '**/node_modules',
      '**/node_modules/**',
      '.buck2/capability-gcroots',
      '.devenv',
      '.editor-view',
      '.git',
      'buck-out',
      'context/.editor-view',
      'node_modules',
      'packages/.editor-view',
      'packages/@overeng/effect-rpc-tanstack/.editor-view',
      'target',
      'tmp',
    ],
  }),
} as const

const watchmanIgnoreDirs = (rawInput: CompositionRootInput): ReadonlyArray<string> =>
  Schema.decodeUnknownSync(WatchmanConfigSchema, { onExcessProperty: 'error' })(
    JSON.parse(text(filesByPath(rawInput).get('.watchmanconfig')!)),
  ).ignore_dirs

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

describe('watchman ignore projection', () => {
  it('generates the exact single-member watchman config', () => {
    const alphaWithIgnores = {
      memberKey: 'alpha',
      manifest: manifest({
        cell: 'alpha',
        projectIgnore: ['.git', '**/dist', 'buck-out', 'node_modules', '.devenv', 'target', 'tmp'],
      }),
    }
    expect(text(filesByPath(input({ members: [alphaWithIgnores] })).get('.watchmanconfig')!))
      .toBe(`{
  "ignore_dirs": [
    "buck-out",
    "repos/alpha/buck-out",
    "node_modules",
    "repos/alpha/node_modules",
    ".devenv",
    "repos/alpha/.devenv",
    "repos/alpha/target",
    "target",
    "repos/alpha/tmp",
    "tmp",
    "repos/alpha/.git"
  ]
}
`)
  })

  it('excludes every literal high-churn root, mount-prefixed for members', () => {
    const dirs = watchmanIgnoreDirs(
      input({ members: [effectLikeMember], platformHubCell: 'effect_utils' }),
    )
    expect(dirs).toEqual(
      expect.arrayContaining([
        'buck-out',
        '.devenv',
        'node_modules',
        'target',
        'tmp',
        'repos/effect-utils/buck-out',
        'repos/effect-utils/.devenv',
        'repos/effect-utils/node_modules',
        'repos/effect-utils/target',
        'repos/effect-utils/tmp',
        'repos/effect-utils/.buck2/capability-gcroots',
        'repos/effect-utils/.editor-view',
        'repos/effect-utils/context/.editor-view',
        'repos/effect-utils/packages/.editor-view',
        'repos/effect-utils/packages/@overeng/effect-rpc-tanstack/.editor-view',
      ]),
    )
    expect(new Set(dirs).size).toBe(dirs.length)
  })

  // `ignore_vcs` shallow-watches only the VCS directories of the watch root itself, so a member
  // mount's VCS directory is still fully crawled unless it stays a literal `ignore_dirs` entry.
  it('carries only literal directories and drops only watch-root version-control dirs', () => {
    const dirs = watchmanIgnoreDirs(
      input({
        members: [effectLikeMember],
        platformHubCell: 'effect_utils',
        additionalProjectIgnores: ['repos/effect', 'repos/.staging-*'],
      }),
    )
    expect(dirs.filter((dir) => /[*?[\]{}]/u.test(dir))).toEqual([])
    expect(dirs).toContain('repos/effect')
    expect(dirs).not.toContain('.git')
    expect(dirs).toContain('repos/effect-utils/.git')
  })

  // macOS grants kernel-level exclusion to only the first eight entries, so the trees that
  // actually dominate the crawl must lead the list.
  it('orders the hottest generated trees first', () => {
    const dirs = watchmanIgnoreDirs(
      input({ members: [effectLikeMember], platformHubCell: 'effect_utils' }),
    )
    expect(dirs.slice(0, 8).map(basename)).toEqual([
      '.editor-view',
      '.editor-view',
      '.editor-view',
      '.editor-view',
      'buck-out',
      'buck-out',
      'node_modules',
      'node_modules',
    ])
    expect(dirs.at(-1)).toBe('repos/effect-utils/.git')
  })

  it('is byte-identical under permuted member and ignore ordering', () => {
    const permuted = {
      memberKey: 'effect-utils',
      manifest: manifest({
        cell: 'effect_utils',
        memberKey: 'effect-utils',
        projectIgnore: [...effectLikeMember.manifest.projectIgnore].toReversed(),
      }),
    }
    expect(
      filesByPath(input({ members: [permuted, alphaMember] })).get('.watchmanconfig')!.bytes,
    ).toEqual(
      filesByPath(input({ members: [alphaMember, effectLikeMember] })).get('.watchmanconfig')!
        .bytes,
    )
  })

  it('publishes the watchman config before the buckconfig authority', () => {
    const paths = generateCompositionRoot(input({ members: [alphaMember] })).files.map(
      (file) => file.path,
    )
    expect(paths).toContain('.watchmanconfig')
    expect(paths.indexOf('.watchmanconfig')).toBeLessThan(paths.indexOf('.buckconfig'))
    expect(paths.at(-1)).toBe('.buckconfig')
  })

  // Publication compares this against the config a live watched root actually loaded, so it must
  // read the published bytes rather than recompute the projection.
  it('reports the exclusion it published, in published order', () => {
    const rawInput = input({ members: [effectLikeMember], platformHubCell: 'effect_utils' })
    const output = generateCompositionRoot(rawInput)
    expect(generatedWatchmanIgnoreDirs(output)).toEqual(watchmanIgnoreDirs(rawInput))
    expect(generatedWatchmanIgnoreDirs(output).slice(0, 4).map(basename)).toEqual([
      '.editor-view',
      '.editor-view',
      '.editor-view',
      '.editor-view',
    ])
    expect(() => generatedWatchmanIgnoreDirs({ files: [] })).toThrow(/\.watchmanconfig/u)
  })
})

describe('watchman provisioning', () => {
  it('provisions the configured Watchman bin directory wherever file_watcher is emitted', () => {
    const files = filesByPath(
      input({
        members: [alphaMember],
        resolvedBuckExecutable: '/tools/buck dir/buck2',
        resolvedWatchmanExecutable: "/tools/watchman's dir/watchman",
      }),
    )
    expect(text(files.get('.buckconfig')!)).toContain('  file_watcher = watchman')
    const wrapper = text(files.get('.megarepo/bin/buck2')!)
    const pathLine = `PATH='/tools/watchman'"'"'s dir'\${PATH:+:$PATH}`
    expect(wrapper).toContain(`${pathLine}\nexport PATH\n\nexec '/tools/buck dir/buck2' `)
    // The wrapper must provision Watchman only on the path that actually reaches Buck.
    expect(wrapper.indexOf(pathLine)).toBeGreaterThan(wrapper.indexOf('--isolation-dir is fixed'))
  })

  it.each([
    ['relative', 'watchman/bin/watchman'],
    ['bare root', '/'],
    ['non-canonical', '/tools/../watchman/bin/watchman'],
  ])('refuses a %s Watchman executable', (_name, resolvedWatchmanExecutable) => {
    expect(() =>
      decodeCompositionRootInput(input({ members: [alphaMember], resolvedWatchmanExecutable })),
    ).toThrow()
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
      '.watchmanconfig',
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

  it('declares exactly the generated paths publication and teardown revalidate', () => {
    const output = generateCompositionRoot(input({ members: [alphaMember] }))
    expect(
      output.files
        .map((file) => file.path)
        .filter((path) => path !== COMPOSITION_GENERATION_MANIFEST_PATH)
        .toSorted(compareCodeUnits),
    ).toEqual([...COMPOSITION_OWNED_PATHS])
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
