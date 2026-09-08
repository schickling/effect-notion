import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { nixGraftedStoreOverridePackages } from '../../genie/native-dependency-policy.ts'

import {
  decodePnpmSha256Sidecar,
  generatePnpmSha256Sidecar,
  translatePnpmLock,
} from './pnpm-lock.ts'
import { renderPnpmPlatformGatedPackages, renderPnpmStoreBuck } from './pnpm-store-buck.ts'
import {
  computeStoreSccs,
  makePnpmStoreProjection,
  packageAllowed,
  platformGatedPackageNames,
  platformVaryingEntries,
  pnpmPlatforms,
  portablePnpmPlatform,
} from './pnpm-store.ts'

const archive = new TextEncoder().encode('archive bytes')
const archiveIntegrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`

const workspaceText = `packages:
  - packages/*
patchedDependencies:
  {}
allowBuilds:
  esbuild: false
ignoreScripts: true
`

const lock = ({
  importers,
  packages,
  snapshots,
}: {
  importers: string
  packages: string
  snapshots: string
}) => `lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false
  injectWorkspacePackages: true
importers:
${importers}
packages:
${packages}
snapshots:
${snapshots}
`


const platformVaryingLock = lock({
  importers: `  packages/app:
    dependencies:
      host:
        specifier: 1.0.0
        version: 1.0.0`,
  packages: `  host@1.0.0:
    resolution: {integrity: ${archiveIntegrity}}
  native-darwin@1.0.0:
    resolution: {integrity: ${archiveIntegrity}}
    cpu: [arm64]
    os: [darwin]
  native-linux@1.0.0:
    resolution: {integrity: ${archiveIntegrity}}
    cpu: [x64, arm64]
    os: [linux]`,
  snapshots: `  host@1.0.0:
    optionalDependencies:
      native-darwin: 1.0.0
      native-linux: 1.0.0
  native-darwin@1.0.0: {}
  native-linux@1.0.0: {}`,
})

const cyclicLock = lock({
  importers: `  packages/app:
    dependencies:
      left:
        specifier: 1.0.0
        version: 1.0.0`,
  packages: `  left@1.0.0:
    resolution: {integrity: ${archiveIntegrity}}
  outside@1.0.0:
    resolution: {integrity: ${archiveIntegrity}}
  right@1.0.0:
    resolution: {integrity: ${archiveIntegrity}}`,
  snapshots: `  left@1.0.0:
    dependencies:
      right: 1.0.0
  outside@1.0.0: {}
  right@1.0.0:
    dependencies:
      left: 1.0.0
      outside: 1.0.0`,
})

const peerTypesLock = lock({
  importers: `  packages/app:
    dependencies:
      widget:
        specifier: 1.0.0
        version: 1.0.0(react@19.0.0)
    devDependencies:
      '@types/react':
        specifier: 19.0.0
        version: 19.0.0`,
  packages: `  '@types/react@19.0.0':
    resolution: {integrity: ${archiveIntegrity}}
  react@19.0.0:
    resolution: {integrity: ${archiveIntegrity}}
  widget@1.0.0:
    resolution: {integrity: ${archiveIntegrity}}
    peerDependencies:
      react: ^19.0.0`,
  snapshots: `  '@types/react@19.0.0': {}
  react@19.0.0: {}
  widget@1.0.0(react@19.0.0):
    dependencies:
      react: 19.0.0`,
})

const duplicateTypesLock = lock({
  importers: `  packages/app:
    dependencies:
      widget:
        specifier: 1.0.0
        version: 1.0.0(react@19.0.0)
      legacy:
        specifier: 1.0.0
        version: 1.0.0`,
  packages: `  '@types/react@18.3.0':
    resolution: {integrity: ${archiveIntegrity}}
  '@types/react@19.0.0':
    resolution: {integrity: ${archiveIntegrity}}
  legacy@1.0.0:
    resolution: {integrity: ${archiveIntegrity}}
  react@19.0.0:
    resolution: {integrity: ${archiveIntegrity}}
  widget@1.0.0:
    resolution: {integrity: ${archiveIntegrity}}
    peerDependencies:
      react: ^19.0.0`,
  snapshots: `  '@types/react@18.3.0': {}
  '@types/react@19.0.0': {}
  legacy@1.0.0:
    dependencies:
      '@types/react': 18.3.0
  react@19.0.0: {}
  widget@1.0.0(react@19.0.0):
    dependencies:
      react: 19.0.0`,
})

const projectionOf = async (lockfileText: string) => {
  const metadata = translatePnpmLock({ lockfileText, workspaceText })
  const sidecar = await generatePnpmSha256Sidecar({
    metadata,
    fetchArchive: async () => archive,
  })
  return makePnpmStoreProjection({ metadata, sidecar })
}

describe('normalized store projection', () => {
  it('derives one platform-selected variant set per differing lockfile edge set', async () => {
    const projection = await projectionOf(platformVaryingLock)
    const host = projection.entries.find((entry) => entry.storeKey === 'host@1.0.0')!

    // Two Linux platforms resolve the same edge, macOS resolves another, and
    // the portable platform resolves neither native sibling: the variant count
    // follows the lockfile instead of a declared constant.
    expect(host.variants).toHaveLength(3)
    expect(host.variants.map((variant) => variant.platforms)).toEqual(
      expect.arrayContaining([
        ['javascript_portable'],
        ['linux_aarch64', 'linux_x86_64'],
        ['macos_aarch64'],
      ]),
    )
    const portable = host.variants.find((variant) =>
      variant.platforms.includes('javascript_portable'),
    )!
    expect(Object.keys(portable.edges)).toEqual([])
    const darwin = host.variants.find((variant) => variant.platforms.includes('macos_aarch64'))!
    expect(Object.keys(darwin.edges)).toEqual(['native-darwin'])
    expect(platformVaryingEntries(projection).map((entry) => entry.storeKey)).toEqual([
      'host@1.0.0',
    ])
  })

  it('keeps a platform-restricted package invariant instead of selecting it', async () => {
    const projection = await projectionOf(platformVaryingLock)
    const native = projection.entries.find((entry) => entry.storeKey === 'native-darwin@1.0.0')!

    expect(native.platforms).toEqual(['macos_aarch64'])
    expect(native.variants).toHaveLength(1)
    expect(platformVaryingEntries(projection)).not.toContain(native)
  })

  it('groups a real cycle into one component and leaves its acyclic neighbour alone', async () => {
    const projection = await projectionOf(cyclicLock)

    expect(projection.sccs).toHaveLength(1)
    expect(projection.sccs[0]!.members).toEqual(['left@1.0.0', 'right@1.0.0'])
    const members = projection.entries.filter((entry) => entry.sccIndex !== undefined)
    expect(members.map((entry) => entry.storeKey)).toEqual(['left@1.0.0', 'right@1.0.0'])
    const outside = projection.entries.find((entry) => entry.storeKey === 'outside@1.0.0')!
    expect(outside.sccIndex).toBeUndefined()
  })

  it('gives every component member a distinct pnpm namespace and one shared group target', async () => {
    const projection = await projectionOf(cyclicLock)
    const members = projection.entries.filter((entry) => entry.sccIndex !== undefined)

    expect(new Set(members.map((entry) => entry.storeKey)).size).toBe(members.length)
    expect(new Set(members.map((entry) => entry.sccIndex)).size).toBe(1)
    const rendered = renderPnpmStoreBuck(projection)
    expect(rendered).toContain('pnpm_store_scc(')
    // Members carry their edges on the group, never as their own entry edges.
    expect(rendered).toContain(`scc = ":${projection.sccs[0]!.target}"`)
    expect(rendered).toContain('"left@1.0.0\\tright": "right@1.0.0"')
    expect(rendered).toContain('"right@1.0.0\\tleft": "left@1.0.0"')
  })

  it('selects absent and same-name differing SCC internal edges per platform', async () => {
    const projection = await projectionOf(cyclicLock)
    const left = projection.entries.find((entry) => entry.storeKey === 'left@1.0.0')!
    const rightEdge = left.variants[0]!.edges.right!
    const varyingProjection = {
      ...projection,
      entries: projection.entries.map((entry) =>
        entry === left
          ? {
              ...entry,
              variants: [
                {
                  edges: { right: { kind: 'entry', storeKey: 'left@1.0.0' } },
                  platforms: pnpmPlatforms.filter((platform) => platform !== 'macos_aarch64'),
                },
                {
                  edges: { optionalRight: rightEdge, right: rightEdge },
                  platforms: pnpmPlatforms.filter((platform) => platform === 'macos_aarch64'),
                },
              ],
            }
          : entry,
      ),
    }

    const rendered = renderPnpmStoreBuck(varyingProjection)
    const component = rendered.slice(
      rendered.indexOf('pnpm_store_scc('),
      rendered.indexOf('pnpm_store_entry('),
    )
    expect(component).toContain('internal_edges_by_platform = {')
    expect(component.match(/"left@1.0.0\\toptionalRight": "right@1.0.0"/g)).toHaveLength(1)
    expect(component.match(/"left@1.0.0\\tright": "left@1.0.0"/g)).toHaveLength(3)
    expect(component.match(/"left@1.0.0\\tright": "right@1.0.0"/g)).toHaveLength(1)
    expect(component.match(/"right@1.0.0\\tleft": "left@1.0.0"/g)).toHaveLength(4)
    // The select covers the portable platform explicitly; nothing falls
    // through to a default branch.
    expect(component).toContain('"javascript_portable":')
  })

  it('projects an importer as direct links plus a closure, never as copied dependencies', async () => {
    const projection = await projectionOf(cyclicLock)
    const view = projection.views.find((candidate) => candidate.importer === 'packages/app')!
    const variant = view.variants[0]!

    expect(Object.keys(variant.direct)).toEqual(['left'])
    expect(variant.closure).toEqual(['left@1.0.0', 'outside@1.0.0', 'right@1.0.0'])
    // A view names entries; it never restates their dependency edges, which is
    // what previously duplicated the closure into every consumer.
    const rendered = renderPnpmStoreBuck(projection)
    const viewBlock = rendered.slice(rendered.indexOf(`name = "${view.target}"`))
    expect(viewBlock).not.toContain('package_dependencies')
    expect(viewBlock).not.toContain('dependencies_by_platform')
    expect(viewBlock).toContain('closure = {')
    expect(viewBlock).toContain('direct = {')
  })

  it('declares one entry per snapshot no matter how many importers consume it', async () => {
    const projection = await projectionOf(
      lock({
        importers: `  packages/a:
    dependencies:
      shared:
        specifier: 1.0.0
        version: 1.0.0
  packages/b:
    dependencies:
      shared:
        specifier: 1.0.0
        version: 1.0.0`,
        packages: `  shared@1.0.0:
    resolution: {integrity: ${archiveIntegrity}}`,
        snapshots: '  shared@1.0.0: {}',
      }),
    )

    expect(projection.entries.map((entry) => entry.storeKey)).toEqual(['shared@1.0.0'])
    expect(projection.views).toHaveLength(2)
    for (const view of projection.views) {
      expect(view.variants[0]!.closure).toEqual(['shared@1.0.0'])
    }
  })

  it("links a peer's type companion into the entry that declares the peer", async () => {
    const projection = await projectionOf(peerTypesLock)
    const widget = projection.entries.find((entry) => entry.storeKey === 'widget@1.0.0_react@19.0.0')!

    // `widget` never declares `@types/react`; it declares `react` as a peer,
    // and its own declaration files resolve `react` types through the
    // companion. pnpm supplies that through its hoisted layer, which an
    // isolated entry does not have, so the edge is declared here instead.
    expect(Object.keys(widget.variants[0]!.edges).toSorted()).toEqual(['@types/react', 'react'])
    expect(widget.variants[0]!.edges['@types/react']).toEqual({
      kind: 'entry',
      storeKey: '@types+react@19.0.0',
    })
    // Every platform resolves the same companion, so no select() appears.
    expect(widget.variants).toHaveLength(1)

    // A package without peers gains nothing, and the companion entry is part
    // of the consuming view's closure because the entry graph reaches it.
    const react = projection.entries.find((entry) => entry.storeKey === 'react@19.0.0')!
    expect(react.variants[0]!.edges).toEqual({})
    const view = projection.views.find((candidate) => candidate.importer === 'packages/app')!
    expect(view.variants[0]!.closure).toEqual([
      '@types+react@19.0.0',
      'react@19.0.0',
      'widget@1.0.0_react@19.0.0',
    ])
    expect(renderPnpmStoreBuck(projection)).toContain('"@types/react": ":entry_types_react_19_0_0')
  })

  it('rejects a type companion the repository resolves to two versions', async () => {
    await expect(projectionOf(duplicateTypesLock)).rejects.toThrow(
      '@types/react resolves to 18.3.0, 19.0.0; a type companion must have one repository-wide version',
    )
  })
})

describe('normalized store projection of the real lockfile', () => {
  const metadata = translatePnpmLock({
    lockfileText: readFileSync('pnpm-lock.yaml', 'utf8'),
    workspaceText: readFileSync('pnpm-workspace.yaml', 'utf8'),
  })
  const sidecar = decodePnpmSha256Sidecar(
    JSON.parse(readFileSync('buck2/dependencies/pnpm-lock.sha256.json', 'utf8')),
  )
  const projection = makePnpmStoreProjection({ metadata, sidecar })

  it('finds exactly the five real multi-member components', () => {
    expect(projection.sccs.map((scc) => scc.members)).toEqual([
      ['@babel+core@7.29.7', '@babel+helper-module-transforms@7.29.7_@babel+core@7.29.7'],
      [
        '@eslint-community+eslint-utils@4.10.1_eslint@10.5.0_jiti@2.7.0',
        'eslint@10.5.0_jiti@2.7.0',
      ],
      [
        '@storybook+builder-vite@10.5.10_esbuild@0.28.2_storybook@10.5.10_@types+react-dom@19.2.3_@types+react@1_be259843c9e6e986',
        '@storybook+csf-plugin@10.5.10_esbuild@0.28.2_storybook@10.5.10_@types+react-dom@19.2.3_@types+react@19._a10ea3ebbc5052fa',
        '@storybook+react-dom-shim@10.5.10_@types+react-dom@19.2.3_@types+react@19.2.17_@types+react@19.2.17_rea_1bfba32abb8ba7c0',
        '@storybook+react-vite@10.5.10_@types+react-dom@19.2.3_@types+react@19.2.17_@types+react@19.2.17_esbuild_b9b22ca8b11f579c',
        '@storybook+react@10.5.10_@types+react-dom@19.2.3_@types+react@19.2.17_@types+react@19.2.17_react-dom@19_438c9d31d7c851a7',
        'storybook@10.5.10_@types+react-dom@19.2.3_@types+react@19.2.17_@types+react@19.2.17_prettier@3.8.4_reac_b427aecd21e7a036',
      ],
      [
        '@vitest+browser-playwright@4.1.9_playwright@1.61.0_vite@8.0.16_@types+node@26.0.0_esbuild@0.28.2_jiti@2.7.0_vitest@4.1.9',
        '@vitest+browser@4.1.9_vite@8.0.16_@types+node@26.0.0_esbuild@0.28.2_jiti@2.7.0_vitest@4.1.9',
        'vitest@4.1.9_@opentelemetry+api@1.9.1_@types+node@26.0.0_@vitest+browser-playwright@4.1.9_happy-dom@20._d770e4cf2367778e',
      ],
      ['browserslist@4.28.8', 'update-browserslist-db@1.3.2_browserslist@4.28.8'],
    ])
    expect(new Set(projection.sccs.flatMap((scc) => scc.members)).size).toBe(
      projection.sccs.reduce((total, scc) => total + scc.members.length, 0),
    )
  })

  it('resolves the React type companions every peer-typed entry needs', () => {
    const typesReact = projection.entries.find(
      (entry) => entry.packageName === '@types/react',
    )!
    const ariaComponents = projection.entries.find(
      (entry) => entry.packageName === 'react-aria-components',
    )!

    // `react` ships no declarations, so `react-aria-components`' own `.d.ts`
    // files only typecheck when the companion is reachable from the entry that
    // declares `react` as a peer.
    expect(ariaComponents.variants[0]!.edges['@types/react']).toEqual({
      kind: 'entry',
      storeKey: typesReact.storeKey,
    })

    // Derived, not declared: whichever entries peer a package with a companion
    // in this lockfile are exactly the entries that gain the edge.
    const peerTyped = projection.entries.filter((entry) => {
      const snapshot = metadata.snapshots[entry.snapshot]!
      const declared = new Set([
        ...Object.keys(snapshot.dependencies),
        ...Object.keys(snapshot.optionalDependencies),
      ])
      return entry.variants.some((variant) =>
        Object.keys(variant.edges).some(
          (name) => name.startsWith('@types/') === true && declared.has(name) === false,
        ),
      )
    })
    expect(peerTyped.map((entry) => entry.packageName)).toContain('react-aria-components')
    for (const entry of peerTyped) {
      const peers = metadata.snapshots[entry.snapshot]!.peerIdentities
      expect(peers.length).toBeGreaterThan(0)
    }
  })

  it('derives the platform-varying entries the current lockfile actually has', () => {
    const varying = platformVaryingEntries(projection).map((entry) => entry.storeKey)

    // Decision 0030 recorded nine such packages; `oxlint-tsgolint` became the
    // tenth. The count is derived here so a new platform-selected dependency
    // needs no edit to admit it.
    expect(varying).toEqual([
      '@opentui+core@0.4.1_typescript@6.0.3_web-tree-sitter@0.25.10',
      'esbuild@0.28.2',
      'lightningcss@1.33.0',
      'msgpackr-extract@3.0.4',
      'oxc-parser@0.127.0',
      'oxc-resolver@11.21.2',
      'oxlint-tsgolint@0.23.0',
      'playwright@1.61.0',
      'rolldown@1.0.3',
      'vite@8.0.16_@types+node@26.0.0_esbuild@0.28.2_jiti@2.7.0',
    ])
  })

  it('declares one entry per snapshot and one view per importer', () => {
    expect(projection.entries).toHaveLength(650)
    expect(new Set(projection.entries.map((entry) => entry.storeKey)).size).toBe(650)
    expect(projection.views).toHaveLength(Object.keys(metadata.importers).length)
    expect(computeStoreSccs({ metadata })).toEqual(projection.sccs.map((scc) => scc.members))
  })

  it('renders a deterministic declaration whose selects appear only where edges vary', () => {
    const rendered = renderPnpmStoreBuck(projection)

    expect(rendered).toBe(renderPnpmStoreBuck(projection))
    expect([...rendered.matchAll(/^    dependencies_by_platform = \{$/gm)]).toHaveLength(
      platformVaryingEntries(projection).length,
    )
    for (const platform of pnpmPlatforms) {
      expect(rendered).toContain(`"${platform}": {`)
    }
  })

  it('grafts each Nix-built native addon onto exactly one shared store entry', () => {
    const rendered = renderPnpmStoreBuck(projection)
    const grafted = projection.entries.filter(
      (entry) => nixGraftedStoreOverridePackages[entry.packageName] !== undefined,
    )

    // The policy names the families; the lockfile decides how many snapshots
    // each has. `node-pty` resolves to one snapshot, so one entry carries the
    // addon for the whole repository.
    expect(grafted.map((entry) => entry.storeKey)).toEqual(['node-pty@1.1.0'])
    expect(
      [
        ...rendered.matchAll(
          /^ {4}package_override = read_config\("test_capabilities", "(?<name>[^"]+)", ""\),$/gm,
        ),
      ].map((match) => match.groups!['name']),
    ).toEqual(grafted.map((entry) => entry.packageName))

    // Anti-duplication: the addon is declared once and named by many
    // consumers, never copied into an importer view or a second entry.
    const [entry] = grafted
    expect(entry!.sccIndex).toBeUndefined()
    expect(rendered.match(new RegExp(`^ {4}name = "${entry!.target}",$`, 'gm'))).toHaveLength(1)
    expect(
      rendered.match(new RegExp(`": ":${entry!.target}",$`, 'gm'))!.length,
    ).toBeGreaterThan(1)
  })
})

describe('platform-gated package derivation', () => {
  const metadata = translatePnpmLock({ lockfileText: platformVaryingLock, workspaceText })

  it('names exactly the packages the lockfile gates on cpu, os, or libc', () => {
    // `host` resolves everywhere, so it belongs in a portable product; the two
    // native siblings resolve only somewhere, so they never can.
    expect(platformGatedPackageNames(metadata)).toEqual(['native-darwin', 'native-linux'])
  })

  it('renders the gated set as one Buck target with no capability for an ungrafted family', () => {
    const rendered = renderPnpmPlatformGatedPackages({ metadata })

    expect(rendered).toContain('name = "platform_gated_packages",')
    expect(rendered).toContain('"native-darwin": ["native-darwin"],')
    expect(rendered).toContain('"native-linux": ["native-linux"],')
    // Neither family is Nix-grafted, so no product owes a host capability.
    expect(rendered).not.toContain('-native')
  })

  it('is one of the admitted platforms a store select must cover', () => {
    expect(pnpmPlatforms).toContain(portablePnpmPlatform)
  })

  it('admits a package only when the lockfile puts no gate on it at all', () => {
    const allowed = (packageKey: string) =>
      packageAllowed({ metadata, packageKey, platform: portablePnpmPlatform })

    expect(allowed('host@1.0.0')).toBe(true)
    expect(allowed('native-linux@1.0.0')).toBe(false)
    expect(allowed('native-darwin@1.0.0')).toBe(false)
  })

  it('rejects a libc-only gate, which a machine-shaped platform consults only on Linux', () => {
    const libcOnly = translatePnpmLock({
      lockfileText: lock({
        importers: `  packages/app:
    dependencies:
      musl-only:
        specifier: 1.0.0
        version: 1.0.0`,
        packages: `  musl-only@1.0.0:
    resolution: {integrity: ${archiveIntegrity}}
    libc: [musl]`,
        snapshots: `  musl-only@1.0.0: {}`,
      }),
      workspaceText,
    })

    expect(
      packageAllowed({
        metadata: libcOnly,
        packageKey: 'musl-only@1.0.0',
        platform: portablePnpmPlatform,
      }),
    ).toBe(false)
    expect(platformGatedPackageNames(libcOnly)).toEqual(['musl-only'])
  })
})
