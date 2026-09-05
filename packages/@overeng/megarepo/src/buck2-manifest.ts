/**
 * Stable public API for the tracked `buck2-member.json` contract.
 *
 * Consumers should import this module through
 * `@overeng/megarepo/buck2-manifest`; the composition-root generator module is
 * an implementation detail and may evolve independently.
 */
export {
  BUCK_MEMBER_MANIFEST_FILENAME,
  BuckMemberCapabilitySchema,
  BuckMemberDistOverlaySchema,
  BuckMemberManifestCapabilitySchema,
  BuckMemberManifestSchema,
  BuckMemberToolchainAuthoritySchema,
  BuckMemberToolchainRequirementSchema,
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
  type BuckMemberCapabilitySystem,
  type BuckMemberDistOverlay,
  type BuckMemberManifest,
  type BuckMemberManifestCapability,
  type BuckMemberToolchainAuthority,
  type BuckMemberToolchainRequirement,
} from './composition/root/composition-root.ts'
