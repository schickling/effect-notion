/**
 * Single source of truth for all @overeng/* packages in effect-utils.
 *
 * This list is used to generate catalog entries in internal.ts.
 * When adding a new package, add it here.
 */

/**
 * All internal @overeng/* package short names.
 */
export const internalPackages = [
  'agent-session-ingest',
  'buck2-tools',
  'content-address',
  'effect-ai-claude-cli',
  'effect-distributed-lock',
  'effect-path',
  'effect-react',
  'effect-rpc-tanstack',
  'effect-schema-form',
  'effect-schema-form-aria',
  'genie',
  'kdl',
  'kdl-effect',
  'megarepo',
  'notion-cli',
  'notion-core',
  'notion-datasource-sync',
  'notion-effect-client',
  'notion-effect-schema',
  'notion-md',
  'notion-property-write',
  'notion-react',
  'otel-contract',
  'oxc-config',
  'pty-effect',
  'react-inspector',
  'restate-effect',
  'tui-core',
  'tui-react',
  'tui-stories',
  'utils',
  'utils-dev',
  'ci-tools',
] as const

/**
 * Every pnpm workspace member path, including private packages and non-`@overeng`
 * context packages. Keep package-set consumers on this pure registry rather than
 * importing package generators, whose values are needed only to render manifests.
 */
export const pnpmWorkspaceMemberPaths = [
  'context/effect/socket',
  'packages/@overeng/effect-rpc-tanstack/examples/basic',
  'context/opentui',
  ...internalPackages.map((name) => `packages/@overeng/${name}` as const),
  'packages/@overeng/npm-release',
  'packages/@overeng/stylex-tokens',
].toSorted()

/** Short name of an internal @overeng/* package. */
export type InternalPackageName = (typeof internalPackages)[number]

/**
 * Generate catalog entries for all internal packages.
 * Using `workspace:^` (not `workspace:*`) so pnpm resolves and records the
 * actual version from package.json in every standalone and composed topology.
 */
export const internalPackageCatalogEntries = Object.fromEntries(
  internalPackages.map((name) => [`@overeng/${name}`, 'workspace:^'] as const),
) as Record<`@overeng/${InternalPackageName}`, 'workspace:^'>

/**
 * Nix-only @overeng/* packages that participate in the Nix/flake topology but
 * are NOT part of the pnpm workspace.
 *
 * These intentionally live outside `internalPackages` because they have no
 * `package.json`: adding them to the pnpm catalog (`@overeng/<name>` ->
 * `workspace:^`) would invent a phantom workspace member and break pnpm
 * resolution. They are registered here so genie-generated config and CI can be
 * aware of them through a single source of truth.
 *
 * `flakeRef` is the attribute exposed by `flake.nix` (`packages.<flakeRef>` /
 * `apps.<flakeRef>`); `cratePath` is the repo-relative crate root.
 */
export const nixOnlyPackages = [
  {
    name: 'otelite',
    /** Rust crate: local OTLP capture tool for E2E and instrumentation tests. */
    kind: 'rust-crate',
    flakeRef: 'otelite',
    cratePath: 'packages/@overeng/otelite',
  },
  {
    name: 'otel-scrape',
    /** Rust crate: process-wrapper telemetry substrate for build/dev tools. */
    kind: 'rust-crate',
    flakeRef: 'otel-scrape',
    cratePath: 'packages/@overeng/otel-scrape',
  },
] as const

/** Short name of a nix-only (non-pnpm) @overeng/* package. */
export type NixOnlyPackageName = (typeof nixOnlyPackages)[number]['name']
