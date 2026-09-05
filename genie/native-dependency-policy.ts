/**
 * Native npm dependency policy.
 *
 * Kept separate from `genie/external.ts` so install-free CI checks can audit
 * the lockfile without importing the full Genie runtime graph.
 */

/**
 * Tagged classification of a native dependency family.
 */
export type NativeDependencyPolicyEntry =
  | { readonly _tag: 'nix-grafted'; readonly graft: 'link' | 'fetch-only'; readonly via: string }
  | { readonly _tag: 'denied-lifecycle-build'; readonly defensive?: boolean }
  | { readonly _tag: 'pure-package-artifact' }

/**
 * Native package policy.
 *
 * - `nix-grafted`: native dependency artifacts are provided by Nix instead
 *   of pnpm. `graft: 'link'` builds the addon from source (`node-pty`),
 *   `graft: 'fetch-only'` grafts prebuilt platform tarballs (`@opentui/core`).
 *   `via` names the owning Nix file, which the audit verifies exists.
 * - `denied-lifecycle-build`: a package that ships an install lifecycle build
 *   script we explicitly refuse to run (pnpm `allowBuilds: false`). `defensive`
 *   marks entries kept as guard rails even though the family is not currently
 *   in the lockfile (e.g. `sharp`, `unix-dgram`); their absence is tolerated.
 * - `pure-package-artifact`: an optional, CPU/OS/libc-gated prebuilt native
 *   binary family (Rollup/Rolldown/esbuild/oxc/etc.) that carries no lifecycle
 *   build and is locked as a fixed-output set. Listed separately from
 *   lifecycle-built native addons per issue #807.
 *
 * Audit gap (documented, not silently dropped): pnpm lockfile v9 no longer
 * emits `requiresBuild`. The build-script ledger (`.modules.yaml`
 * `pendingBuilds`/`ignoredBuilds`) IS populated by a local install even under
 * `ignoreScripts: true` (it lists packages blocked from building), but it is
 * unavailable in CI: the builder-contract job runs install-free, and the
 * Nix pnpm-deps FOD strips `.modules.yaml` from its output for determinism, so
 * no CI job sees the ledger. A brand-new package that carries a lifecycle
 * build but is neither CPU/OS/libc-gated nor already in this policy therefore
 * cannot be auto-detected here. This policy is the source of truth; the audit
 * enforces lockfile-vs-policy drift (new gated families, disappeared/
 * shape-changed entries) against it.
 */
export const nativeDependencyPolicy = {
  // Lifecycle-built native addons denied a pnpm build. Order mirrors the
  // historical `allowBuilds` literal so the derived denylist stays byte-stable.
  '@myobie/pty': { _tag: 'denied-lifecycle-build' },
  esbuild: { _tag: 'denied-lifecycle-build' },
  fsevents: { _tag: 'denied-lifecycle-build' },
  'msgpackr-extract': { _tag: 'denied-lifecycle-build' },
  'node-pty': { _tag: 'nix-grafted', graft: 'link', via: 'nix/node-pty-native.nix' },
  sharp: { _tag: 'denied-lifecycle-build', defensive: true },
  'unix-dgram': { _tag: 'denied-lifecycle-build', defensive: true },

  // Nix-grafted prebuilt native package (not lifecycle-built, so not denied).
  '@opentui/core': { _tag: 'nix-grafted', graft: 'fetch-only', via: 'nix/opentui-core-native.nix' },

  // Pure package-artifact native families (CPU/OS/libc-gated, no
  // lifecycle build). Keys are the family prefix shared by every platform
  // package (e.g. `@rollup/rollup` covers `@rollup/rollup-linux-x64-gnu`).
  '@rollup/rollup': { _tag: 'pure-package-artifact' },
  '@rolldown/binding': { _tag: 'pure-package-artifact' },
  '@esbuild': { _tag: 'pure-package-artifact' },
  '@msgpackr-extract': { _tag: 'pure-package-artifact' },
  lightningcss: { _tag: 'pure-package-artifact' },
  '@oxc-parser/binding': { _tag: 'pure-package-artifact' },
  '@oxc-resolver/binding': { _tag: 'pure-package-artifact' },
  '@tailwindcss/oxide': { _tag: 'pure-package-artifact' },
  '@oxlint-tsgolint': { _tag: 'pure-package-artifact' },
} as const satisfies Record<string, NativeDependencyPolicyEntry>

/**
 * Package names whose npm bytes are replaced wholesale by a Nix-built tree.
 *
 * `graft: 'link'` families ship no usable prebuilt binary, so the registry
 * archive alone cannot be loaded at runtime. The normalized pnpm store entry
 * for such a package takes its bytes from an immutable declared directory
 * instead; each name doubles as the `[test_capabilities]` key that names it.
 * `graft: 'fetch-only'` families are excluded: their prebuilt platform
 * tarballs are ordinary locked packages that need no grafted store entry.
 */
export const nixGraftedStoreOverridePackages: Readonly<Record<string, true>> =
  Object.fromEntries(
    Object.entries(nativeDependencyPolicy as Record<string, NativeDependencyPolicyEntry>).flatMap(
      ([name, entry]) =>
        entry._tag === 'nix-grafted' && entry.graft === 'link' ? [[name, true] as const] : [],
    ),
  )
