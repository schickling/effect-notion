import { describe, it } from '@effect/vitest'
import { expect } from 'vitest'

import {
  BUCK_MEMBER_MANIFEST_FILENAME,
  BuckMemberManifestSchema,
  COMPOSITION_ROOT_SCHEMA_VERSION,
  buckMemberCapabilityByToolId,
  buckMemberProjectedCapabilities,
  buckMemberProjectedCapabilitiesForSystem,
  decodeBuckMemberManifest,
  decodeBuckMemberManifestJson,
  encodeBuckMemberManifest,
  encodeBuckMemberManifestJson,
  normalizeBuckMemberManifest,
  type BuckMemberCapability,
  type BuckMemberDistOverlay,
  type BuckMemberManifest,
  type BuckMemberToolchainAuthority,
  type BuckMemberToolchainRequirement,
} from '@overeng/megarepo/buck2-manifest'

const capability: BuckMemberCapability = {
  toolId: 'buck2',
  protocol: 'facebook/buck2-cli/2026-08-22',
  flakePackage: 'buck2',
  executable: 'bin/buck2',
}

const tsgoCapability: BuckMemberCapability = {
  toolId: 'effect-tsgo',
  protocol: 'effect-utils/buck2-effect-tsgo/v1',
  flakePackage: 'effect-tsgo',
  executable: 'bin/tsgo',
}

const linuxOnlyCapability: BuckMemberCapability = {
  toolId: 'sandbox-bubblewrap',
  protocol: 'containers/bubblewrap/v1',
  flakePackage: 'buck2-bubblewrap',
  executable: 'bin/bwrap',
  systems: ['x86_64-linux', 'aarch64-linux'],
}

const toolchainAuthority: BuckMemberToolchainAuthority = {
  _tag: 'ToolchainAuthority',
  toolchain: 'tsgo',
  provides: [tsgoCapability],
}

const toolchainRequirement: BuckMemberToolchainRequirement = {
  _tag: 'ToolchainRequirement',
  toolchain: 'tsgo',
}

const overlay: BuckMemberDistOverlay = {
  target: '//packages/app:dist',
  destination: 'packages/app/dist',
}

const manifest: BuckMemberManifest = {
  schemaVersion: COMPOSITION_ROOT_SCHEMA_VERSION,
  cell: 'effect_utils',
  mount: 'repos/effect-utils',
  projectIgnore: ['target', '**/dist', 'target'],
  distOverlays: [overlay],
  capabilities: [capability, toolchainAuthority, toolchainRequirement],
}

describe('@overeng/megarepo/buck2-manifest', () => {
  it('resolves the stable member-manifest schema and codec surface', () => {
    expect(BUCK_MEMBER_MANIFEST_FILENAME).toBe('buck2-member.json')
    expect(BuckMemberManifestSchema).toBeDefined()

    const decoded = decodeBuckMemberManifest(manifest)
    expect(decoded).toEqual({
      ...manifest,
      projectIgnore: ['**/dist', 'target'],
    })
    expect(normalizeBuckMemberManifest(manifest)).toEqual(decoded)
    expect(encodeBuckMemberManifest(decoded)).toEqual(decoded)
    expect(decodeBuckMemberManifestJson(encodeBuckMemberManifestJson(decoded))).toEqual(decoded)
    expect(buckMemberCapabilityByToolId({ manifest: decoded, toolId: 'buck2' })).toEqual(capability)
    expect(buckMemberCapabilityByToolId({ manifest: decoded, toolId: 'tsgo' })).toBeUndefined()
    expect(buckMemberProjectedCapabilities(decoded)).toEqual([capability, tsgoCapability])
  })

  it('projects a system-scoped capability only on the systems it declares', () => {
    const decoded = decodeBuckMemberManifest({
      ...manifest,
      capabilities: [capability, linuxOnlyCapability, toolchainAuthority, toolchainRequirement],
    })
    // Normalization sorts the declared systems so the tracked manifest bytes stay canonical.
    expect(
      buckMemberProjectedCapabilitiesForSystem({ manifest: decoded, system: 'x86_64-linux' }),
    ).toEqual([
      capability,
      { ...linuxOnlyCapability, systems: ['aarch64-linux', 'x86_64-linux'] },
      tsgoCapability,
    ])
    expect(
      buckMemberProjectedCapabilitiesForSystem({ manifest: decoded, system: 'aarch64-darwin' }),
    ).toEqual([capability, tsgoCapability])
    expect(() =>
      decodeBuckMemberManifest({
        ...manifest,
        capabilities: [{ ...linuxOnlyCapability, systems: [] }],
      }),
    ).toThrow()
  })
})
