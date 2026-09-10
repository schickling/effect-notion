import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import {
  decodePnpmSha256Sidecar,
  generatePnpmSha256Sidecar,
  translatePnpmLock,
  validatePnpmSha256Sidecar,
} from './pnpm-lock.ts'
import { renderPnpmPackageTargets } from './pnpm-store-buck.ts'

const archive = new TextEncoder().encode('archive bytes')
const archiveIntegrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`
const otherArchive = new TextEncoder().encode('other archive bytes')
const otherIntegrity = `sha512-${createHash('sha512').update(otherArchive).digest('base64')}`

const npmArchive = (manifest: unknown): Uint8Array => {
  const content = Buffer.from(JSON.stringify(manifest))
  const header = Buffer.alloc(512)
  header.write('package/package.json', 0, 'utf8')
  header.write(`${content.byteLength.toString(8).padStart(11, '0')}\0`, 124, 'ascii')
  return gzipSync(
    Buffer.concat([
      header,
      content,
      Buffer.alloc(Math.ceil(content.byteLength / 512) * 512 - content.byteLength),
      Buffer.alloc(1024),
    ]),
  )
}

const workspace = ({
  allowBuilds = '  esbuild: false',
  patches = '',
}: {
  allowBuilds?: string
  patches?: string
} = {}) => `packages:
  - packages/*
patchedDependencies:
${patches === '' ? '  {}' : patches}
allowBuilds:
${allowBuilds}
ignoreScripts: true
`

const lock = ({
  importers = `  packages/app:
    dependencies:
      alias:
        specifier: npm:bar@2
        version: bar@2.0.0
      foo:
        specifier: 1.0.0
        version: 1.0.0(peer@3.0.0)
      workspace-lib:
        specifier: workspace:*
        version: link:../lib`,
  packages = `  bar@2.0.0:
    resolution: {integrity: ${archiveIntegrity}}
  foo@1.0.0:
    resolution: {integrity: ${otherIntegrity}}
    cpu: [x64, arm64]
    os: [linux, darwin]
    libc: [glibc]
  peer@3.0.0:
    resolution: {integrity: ${archiveIntegrity}}`,
  patchedDependencies = '',
  snapshots = `  bar@2.0.0: {}
  foo@1.0.0(peer@3.0.0):
    dependencies:
      alias: bar@2.0.0
      peer: 3.0.0
  peer@3.0.0: {}`,
}: {
  importers?: string
  packages?: string
  patchedDependencies?: string
  snapshots?: string
} = {}) => `lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false
  injectWorkspacePackages: true
${patchedDependencies === '' ? '' : `patchedDependencies:\n${patchedDependencies}\n`}importers:
${importers}
packages:
${packages}
snapshots:
${snapshots}
`

describe('translatePnpmLock', () => {
  it('resolves aliases, peer identities, and workspace links without losing install names', () => {
    const metadata = translatePnpmLock({ lockfileText: lock(), workspaceText: workspace() })

    expect(metadata.importers['packages/app']!.dependencies.alias).toEqual({
      kind: 'package',
      snapshot: 'bar@2.0.0',
    })
    expect(metadata.importers['packages/app']!.dependencies.foo).toEqual({
      kind: 'package',
      snapshot: 'foo@1.0.0(peer@3.0.0)',
    })
    expect(metadata.importers['packages/app']!.dependencies['workspace-lib']).toEqual({
      kind: 'workspace',
      path: 'packages/lib',
    })
    expect(metadata.snapshots['foo@1.0.0(peer@3.0.0)']).toMatchObject({
      package: 'foo@1.0.0',
      peerIdentities: ['peer@3.0.0'],
      virtualStoreName: 'foo@1.0.0_peer@3.0.0',
      dependencies: {
        alias: { kind: 'package', snapshot: 'bar@2.0.0' },
        peer: { kind: 'package', snapshot: 'peer@3.0.0' },
      },
    })
  })

  it('emits sorted platform metadata and stable targets', () => {
    const first = translatePnpmLock({ lockfileText: lock(), workspaceText: workspace() })
    const second = translatePnpmLock({ lockfileText: lock(), workspaceText: workspace() })

    expect(first).toEqual(second)
    expect(first.packages['foo@1.0.0']).toMatchObject({
      cpu: ['arm64', 'x64'],
      os: ['darwin', 'linux'],
      libc: ['glibc'],
      resolution: 'registry',
      url: 'https://registry.npmjs.org/foo/-/foo-1.0.0.tgz',
    })
    expect(first.packages['foo@1.0.0']!.target).toMatch(/^package_foo_1_0_0_[a-f0-9]{12}$/)
  })

  it('supports a patch only when source bytes, lock hash, and snapshot identity agree', () => {
    const patchBytes = new TextEncoder().encode('patch bytes')
    const patchHash = createHash('sha256').update(patchBytes).digest('hex')
    const metadata = translatePnpmLock({
      lockfileText: lock({
        importers: `  .:
    dependencies:
      foo:
        specifier: 1.0.0
        version: 1.0.0(patch_hash=${patchHash})`,
        packages: `  foo@1.0.0:
    resolution: {integrity: ${archiveIntegrity}}`,
        patchedDependencies: `  foo@1.0.0: ${patchHash}`,
        snapshots: `  foo@1.0.0(patch_hash=${patchHash}): {}`,
      }),
      workspaceText: workspace({ patches: '  foo@1.0.0: patches/foo.patch' }),
      readPatch: (patchPath) => {
        expect(patchPath).toBe('patches/foo.patch')
        return patchBytes
      },
    })

    expect(metadata.packages['foo@1.0.0']!.patch).toEqual({
      hash: patchHash,
      path: 'patches/foo.patch',
    })
  })

  it('translates the real lock deterministically', () => {
    const options = {
      lockfileText: readFileSync('pnpm-lock.yaml', 'utf8'),
      workspaceText: readFileSync('pnpm-workspace.yaml', 'utf8'),
    }
    const first = translatePnpmLock(options)
    const second = translatePnpmLock(options)

    expect(second).toEqual(first)
    expect(Object.keys(first.packages)).toHaveLength(648)
    expect(Object.keys(first.snapshots)).toHaveLength(650)
    expect(Object.keys(first.importers)).toHaveLength(39)
    expect(first.packages['@myobie/pty@0.10.0']!.patch?.path).toBe(
      'packages/@overeng/utils/patches/@myobie__pty@0.10.0.patch',
    )
  })

  it('rejects malformed integrity and unsupported lifecycle builds', () => {
    expect(() =>
      translatePnpmLock({
        lockfileText: lock({
          packages: `  foo@1.0.0:
    resolution: {integrity: sha512-not-base64}`,
          snapshots: '  foo@1.0.0: {}',
          importers: '  .: {}',
        }),
        workspaceText: workspace(),
      }),
    ).toThrow(/canonical sha512 integrity/)

    expect(() =>
      translatePnpmLock({
        lockfileText: lock(),
        workspaceText: workspace({ allowBuilds: '  esbuild: true' }),
      }),
    ).toThrow(/lifecycle builds are unsupported/)

    expect(() =>
      translatePnpmLock({
        lockfileText: lock({
          packages: `  foo@1.0.0:
    resolution: {integrity: ${archiveIntegrity}}
    requiresBuild: true`,
          snapshots: '  foo@1.0.0: {}',
          importers: '  .: {}',
        }),
        workspaceText: workspace(),
      }),
    ).toThrow(/requiresBuild is unsupported/)
  })

  it('rejects stale patches and ambiguous peer identities', () => {
    expect(() =>
      translatePnpmLock({
        lockfileText: lock({
          patchedDependencies: `  foo@1.0.0: ${'a'.repeat(64)}`,
        }),
        workspaceText: workspace({ patches: '  foo@1.0.0: patches/foo.patch' }),
        readPatch: () => new TextEncoder().encode('wrong patch'),
      }),
    ).toThrow(/hash mismatch/)

    expect(() =>
      translatePnpmLock({
        lockfileText: lock({
          packages: `  foo@1.0.0:
    resolution: {integrity: ${archiveIntegrity}}`,
          snapshots: `  foo@1.0.0(peer-a@1.0.0): {}
  foo@1.0.0(peer-b@1.0.0): {}`,
          importers: `  .:
    dependencies:
      foo:
        specifier: 1.0.0
        version: 1.0.0`,
        }),
        workspaceText: workspace(),
      }),
    ).toThrow(/ambiguous peer identity/)
  })
})

describe('pnpm sha256 sidecar', () => {
  it('verifies sha512 before deriving sha256 and reuses integrity-matched entries', async () => {
    const metadata = translatePnpmLock({
      lockfileText: lock({
        packages: `  bar@2.0.0:
    resolution: {integrity: ${archiveIntegrity}}`,
        snapshots: '  bar@2.0.0: {}',
        importers: '  .: {}',
      }),
      workspaceText: workspace(),
    })
    const fetched: string[] = []
    const sidecar = await generatePnpmSha256Sidecar({
      metadata,
      fetchArchive: async (url) => {
        fetched.push(url)
        return archive
      },
    })
    validatePnpmSha256Sidecar({ metadata, sidecar })
    expect(fetched).toEqual(['https://registry.npmjs.org/bar/-/bar-2.0.0.tgz'])
    expect(sidecar.packages['bar@2.0.0']).toEqual({
      bins: {},
      integrity: archiveIntegrity,
      sha256: createHash('sha256').update(archive).digest('hex'),
    })

    const cached = await generatePnpmSha256Sidecar({
      metadata,
      previous: sidecar,
      fetchArchive: async () => {
        throw new Error('matched cache entry must not fetch')
      },
    })
    expect(cached).toEqual(sidecar)
    expect(decodePnpmSha256Sidecar(JSON.parse(JSON.stringify(sidecar)))).toEqual(sidecar)
  })

  it('derives normalized bin metadata from an integrity-verified npm archive', async () => {
    const bytes = npmArchive({ bin: { tool: './bin/tool.js' } })
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
    const metadata = translatePnpmLock({
      lockfileText: lock({
        packages: `  tool@1.0.0:
    resolution: {integrity: ${integrity}}
    hasBin: true`,
        snapshots: '  tool@1.0.0: {}',
        importers: '  .: {}',
      }),
      workspaceText: workspace(),
    })
    const sidecar = await generatePnpmSha256Sidecar({
      metadata,
      fetchArchive: async () => bytes,
    })

    expect(sidecar.packages['tool@1.0.0']!.bins).toEqual({ tool: 'bin/tool.js' })
  })
  it('fails closed on downloaded integrity mismatch and stale freshness metadata', async () => {
    const metadata = translatePnpmLock({
      lockfileText: lock({
        packages: `  bar@2.0.0:
    resolution: {integrity: ${archiveIntegrity}}`,
        snapshots: '  bar@2.0.0: {}',
        importers: '  .: {}',
      }),
      workspaceText: workspace(),
    })
    await expect(
      generatePnpmSha256Sidecar({ metadata, fetchArchive: async () => otherArchive }),
    ).rejects.toThrow(/does not match downloaded archive/)

    const sidecar = await generatePnpmSha256Sidecar({
      metadata,
      fetchArchive: async () => archive,
    })
    expect(() =>
      validatePnpmSha256Sidecar({
        metadata,
        sidecar: { ...sidecar, lockfileFingerprint: `sha256:${'0'.repeat(64)}` },
      }),
    ).toThrow(/stale sha256 sidecar lock fingerprint/)
    expect(() =>
      validatePnpmSha256Sidecar({
        metadata,
        sidecar: { ...sidecar, packages: {} },
      }),
    ).toThrow(/stale sha256 sidecar package identity set/)
  })
})

describe('Buck package targets', () => {
  it('renders one deterministic hash-pinned archive target per registry package', async () => {
    const metadata = translatePnpmLock({
      lockfileText: lock({
        importers: `  .:
    optionalDependencies:
      native:
        specifier: 1.0.0
        version: 1.0.0`,
        packages: `  native@1.0.0:
    resolution: {integrity: ${archiveIntegrity}}
    cpu: [x64]
    os: [linux]`,
        snapshots: `  native@1.0.0:
    optional: true`,
      }),
      workspaceText: workspace(),
    })
    const sidecar = await generatePnpmSha256Sidecar({
      metadata,
      fetchArchive: async () => archive,
    })
    const rendered = renderPnpmPackageTargets({ metadata, sidecar })

    expect(renderPnpmPackageTargets({ metadata, sidecar })).toBe(rendered)
    expect([...rendered.matchAll(/^pnpm_package\($/gm)]).toHaveLength(1)
    expect(rendered).toContain(
      `    package_name = "native",\n    url = ${JSON.stringify(metadata.packages['native@1.0.0']!.url)},`,
    )
  })

  it('renders same-cell patch labels without a cell name', async () => {
    const patchBytes = new TextEncoder().encode('patch bytes')
    const patchHash = createHash('sha256').update(patchBytes).digest('hex')
    const metadata = translatePnpmLock({
      lockfileText: lock({
        importers: `  .:
    dependencies:
      foo:
        specifier: 1.0.0
        version: 1.0.0(patch_hash=${patchHash})`,
        packages: `  foo@1.0.0:
    resolution: {integrity: ${archiveIntegrity}}`,
        patchedDependencies: `  foo@1.0.0: ${patchHash}`,
        snapshots: `  foo@1.0.0(patch_hash=${patchHash}): {}`,
      }),
      workspaceText: workspace({ patches: '  foo@1.0.0: patches/foo.patch' }),
      readPatch: () => patchBytes,
    })
    const sidecar = await generatePnpmSha256Sidecar({
      metadata,
      fetchArchive: async () => archive,
    })
    const rendered = renderPnpmPackageTargets({ metadata, sidecar })

    expect(rendered).toContain('patches = ["//:patches/foo.patch"]')
    expect(rendered).not.toContain('effect_utils//')
  })
})
