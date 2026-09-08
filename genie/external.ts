/**
 * External configuration - reusable by peer repos
 *
 * This file contains configuration that peer repos can import when they
 * include effect-utils as a submodule.
 *
 * For effect-utils internal use, import from `./internal.ts` instead.
 */

import {
  defineCatalog,
  definePatchedDependencies,
  definePackageJson,
  githubLabels,
  githubRuleset,
  githubWorkflow,
  githubWorkflowEvent,
  megarepoJson,
  oxfmtConfig,
  oxlintConfig,
  exportEntry,
  packageJson,
  workspaceClosureReference,
  pnpmWorkspaceYaml,
  pnpmSourceInputStagePath,
  projectPnpmSourceInputs,
  projectionArtifact,
  projectionValidators,
  tsconfigJson,
  type ProjectionArtifactValidator,
  type ProjectionJsonArtifactArgs,
  type ProjectionJsonObject,
  type GenieOutput,
  type GithubLabelsArgs,
  type GithubRulesetArgs,
  type GitHubWorkflowArgs,
  type LabelDef,
  type LegacyMigration,
  type MegarepoConfigArgs,
  type OxfmtConfigArgs,
  type OxlintConfigArgs,
  type AggregatePackageJsonData,
  type ExportEnvironmentContract,
  type ExportEnvironmentContractCoverage,
  type ExportEnvironmentContracts,
  type ExportEnvironmentName,
  type ExportTypeProofMode,
  type PackageJsonData,
  type PackageJsonExportEnvironmentContractValidationOptions,
  type PackageJsonInputData,
  type PackageJsonOptions,
  type PackageJsonValidationOptions,
  type PatchesRegistry,
  type PnpmSettings,
  type PnpmWorkspaceData,
  type ScriptValue,
  type TSConfigArgs,
  type TSConfigCompilerOptions,
  type WorkspaceIdentity,
  type WorkspaceMeta,
  type WorkspaceMetadata,
  type WorkspacePackage,
  type WorkspacePackageLike,
} from '../packages/@overeng/genie/src/runtime/mod.ts'
/**
 * Exceptional export: downstream repos that define `workspaceMember()` factories
 * need this type for the optional `pnpmPackageClosure` parameter in `WorkspaceIdentity`.
 * Prefer not using package closures unless your repo genuinely needs Nix-time
 * workspace subsetting (currently only livestore).
 */
import type { PnpmPackageClosureConfig } from '../packages/@overeng/genie/src/runtime/pnpm-workspace/mod.ts'
/**
 * Repo-context discovery is node-only (reads the filesystem via `import.meta.url`), but importing the broad
 * `@overeng/genie/node` entry also pulls engine validation internals into peer repo Genie files. Import the
 * repo-context surface directly so downstream authoring helpers stay free of engine-only dependencies.
 */
import {
  defineRepoContext,
  type RepoContext,
} from '../packages/@overeng/genie/src/runtime/repo-context/mod.ts'
import {
  nativeDependencyPolicy,
  type NativeDependencyPolicyEntry,
} from './native-dependency-policy.ts'

/** Re-export so TypeScript can reference it in generated declaration files */
export {
  defineCatalog,
  definePatchedDependencies,
  definePackageJson,
  defineRepoContext,
  githubLabels,
  githubRuleset,
  githubWorkflow,
  githubWorkflowEvent,
  megarepoJson,
  oxfmtConfig,
  oxlintConfig,
  exportEntry,
  packageJson,
  workspaceClosureReference,
  pnpmWorkspaceYaml,
  pnpmSourceInputStagePath,
  projectPnpmSourceInputs,
  projectionArtifact,
  projectionValidators,
  tsconfigJson,
}
export type {
  AggregatePackageJsonData,
  ExportEnvironmentContract,
  ExportEnvironmentContractCoverage,
  ExportEnvironmentContracts,
  ExportEnvironmentName,
  ExportTypeProofMode,
  GenieOutput,
  GithubLabelsArgs,
  GithubRulesetArgs,
  GitHubWorkflowArgs,
  LabelDef,
  LegacyMigration,
  MegarepoConfigArgs,
  OxfmtConfigArgs,
  OxlintConfigArgs,
  PackageJsonData,
  PackageJsonExportEnvironmentContractValidationOptions,
  PackageJsonInputData,
  PackageJsonOptions,
  PackageJsonValidationOptions,
  PatchesRegistry,
  PnpmPackageClosureConfig,
  PnpmSettings,
  PnpmWorkspaceData,
  ProjectionArtifactValidator,
  ProjectionJsonArtifactArgs,
  ProjectionJsonObject,
  RepoContext,
  ScriptValue,
  TSConfigArgs,
  TSConfigCompilerOptions,
  WorkspaceIdentity,
  WorkspaceMeta,
  WorkspaceMetadata,
  WorkspacePackage,
  WorkspacePackageLike,
}
export { nativeDependencyPolicy }
export type { NativeDependencyPolicyEntry }

/** Storage portion of effect-utils/pnpm-install-contract schema v2. */
export interface PnpmInstallStorageContractV2 {
  readonly storeContract: {
    readonly owner: 'pnpm'
    readonly layoutVersion: 'v11'
    readonly localDevelopment: {
      readonly scope: 'host-user'
      readonly trustBoundary: 'same-os-user'
      readonly defaultPath: '~/.local/share/pnpm/store-shared-v1'
      readonly pathOverrideEnvironmentVariable: 'PNPM_SHARED_STORE_DIR'
      readonly contentAddressedFiles: 'shared'
      readonly derivedIndex: 'shared-pnpm-owned'
    }
    readonly ci: {
      readonly scope: 'job'
    }
    readonly virtualStore: {
      readonly scope: 'materialization-root'
      readonly path: 'node_modules/.pnpm'
      readonly global: false
    }
  }
  readonly packageImportMethod: {
    readonly live: {
      readonly method: 'auto'
      readonly owner: 'pnpm'
      readonly linuxSameDeviceRequired: true
    }
    readonly nixPreparedDependencies: {
      readonly scope: 'independent-builder-policy'
    }
  }
}

/** Shared live/Nix storage authority for every megarepo install contract. */
export const pnpmInstallStorageContractV2 = {
  storeContract: {
    owner: 'pnpm',
    layoutVersion: 'v11',
    localDevelopment: {
      scope: 'host-user',
      trustBoundary: 'same-os-user',
      defaultPath: '~/.local/share/pnpm/store-shared-v1',
      pathOverrideEnvironmentVariable: 'PNPM_SHARED_STORE_DIR',
      contentAddressedFiles: 'shared',
      derivedIndex: 'shared-pnpm-owned',
    },
    ci: {
      scope: 'job',
    },
    virtualStore: {
      scope: 'materialization-root',
      path: 'node_modules/.pnpm',
      global: false,
    },
  },
  packageImportMethod: {
    live: {
      method: 'auto',
      owner: 'pnpm',
      linuxSameDeviceRequired: true,
    },
    nixPreparedDependencies: {
      scope: 'independent-builder-policy',
    },
  },
} satisfies PnpmInstallStorageContractV2

// =============================================================================
// Shared label catalog (consumed by per-repo `.github/labels.json.genie.ts`)
// =============================================================================

export {
  andonLabels,
  commonLabels,
  deprecatedDefaults,
  legacyMigrations,
  mqDeprecated,
  /** @deprecated kept for consumer backward-compat; empty — migrate to `mqDeprecated`. */
  mqLabels,
} from './labels.ts'

export {
  deriveSystemLabels,
  systemLabelColor,
  type DeriveSystemLabelsArgs,
} from './system-labels.ts'

/**
 * Catalog versions - single source of truth for dependency versions
 *
 * This catalog contains only external npm package versions.
 * Internal @overeng/* packages are added in internal.ts for effect-utils use.
 *
 * Note: packages/@overeng/react-inspector is a git submodule with its own tooling (tsup, ESLint)
 * We include it in the workspace but keep its build system separate
 */
/**
 * OpenTelemetry SDK packages - peer deps of @effect/opentelemetry.
 * Consumers of packages that depend on @effect/opentelemetry need these.
 */
export const otelSdkDeps = [
  '@opentelemetry/resources',
  '@opentelemetry/sdk-logs',
  '@opentelemetry/sdk-metrics',
  '@opentelemetry/sdk-trace-base',
  '@opentelemetry/sdk-trace-node',
  '@opentelemetry/sdk-trace-web',
  '@opentelemetry/semantic-conventions',
] as const

/** Effect 4 packages pinned together as one cohort (must flip in lockstep). */
export const effectV4Cohort = [
  'effect',
  '@effect/platform-node',
  '@effect/vitest',
  '@effect/opentelemetry',
  '@effect/atom-react',
] as const

/** Catalog versions - single source of truth for dependency versions */
export const catalog = defineCatalog({
  // Observability
  // Keep the OpenTelemetry SDK cohort aligned so every package resolves the
  // same @opentelemetry/core generation. The Effect and Restate peer ranges
  // accept these versions.
  '@opentelemetry/api': '1.9.1',
  '@opentelemetry/resources': '2.11.0',
  '@opentelemetry/sdk-logs': '0.222.0',
  '@opentelemetry/sdk-metrics': '2.11.0',
  '@opentelemetry/sdk-trace-base': '2.11.0',
  '@opentelemetry/sdk-trace-node': '2.11.0',
  '@opentelemetry/sdk-trace-web': '2.11.0',
  '@opentelemetry/semantic-conventions': '1.43.0',

  // Schema
  '@standard-schema/spec': '1.1.0',

  // Effect ecosystem
  // Effect 4 RC cohort (see `effectV4Cohort`): platform/cli/rpc/schema/http/
  // socket/process/ai/cluster/workflow/sql and Atom reactivity are merged into
  // the `effect` core package (mostly under `effect/unstable/*`); only these
  // packages remain separate.
  effect: '4.0.0-rc.111',
  '@effect/platform-node': '4.0.0-rc.111',
  '@effect/vitest': '4.0.0-rc.111',
  '@effect/opentelemetry': '4.0.0-rc.111',
  '@effect/atom-react': '4.0.0-rc.111',

  // React ecosystem
  react: '19.2.8',
  'react-dom': '19.2.8',
  'react-aria-components': '1.21.1',

  // Notion rendering (optional peer deps)
  katex: '0.17.0',
  shiki: '4.4.3',

  // Markdown (notion-md canonical markdown pipeline)
  'mdast-util-gfm-strikethrough': '2.0.0',
  'mdast-util-gfm-table': '2.0.0',
  'mdast-util-gfm-task-list-item': '2.0.0',
  'micromark-extension-gfm-strikethrough': '2.1.0',
  'micromark-extension-gfm-table': '2.1.1',
  'micromark-extension-gfm-task-list-item': '2.1.0',
  'remark-parse': '11.0.0',
  'remark-stringify': '11.0.0',
  unified: '11.0.5',
  'unist-util-visit': '5.1.0',

  // PTY
  '@myobie/pty': '0.10.0',

  // Restate (durable execution) — see packages/@overeng/restate-effect
  '@restatedev/restate-sdk': '1.14.5',
  '@restatedev/restate-sdk-clients': '1.14.5',
  '@restatedev/restate-sdk-opentelemetry': '1.14.5',

  // Type definitions
  '@types/react': '19.2.18',
  '@types/react-dom': '19.2.7',
  '@types/node': '26.5.0',
  '@types/bun': '1.4.1',
  '@types/eslint': '9.6.1',
  '@types/is-dom': '1.1.2',
  '@types/katex': '0.16.8',

  // Build tools
  // TypeScript 7's npm package provides the native compiler plus its process-backed unstable API.
  typescript: '7.0.2',
  // TypeScript 7 removed its classic in-process JSONC helper; this is VS Code's zero-dependency parser.
  'jsonc-parser': '3.3.1',
  '@playwright/test': '1.61.0',
  vite: '8.2.2',
  vitest: '4.1.9',
  '@vitejs/plugin-react': '6.1.1',
  unplugin: '3.3.0',

  // TanStack
  '@tanstack/react-router': '1.170.33',
  '@tanstack/react-start': '1.168.50',
  '@tanstack/router-plugin': '1.168.36',

  // Styling
  tailwindcss: '4.3.3',
  '@tailwindcss/vite': '4.3.3',
  '@stylexjs/stylex': '0.19.0',
  '@stylexjs/unplugin': '0.19.0',
  /** Adopted via oxlint `jsPlugins`; its deps pin `@stylexjs/shared` 0.19.0, so it stays in lockstep with the compiler pins above. */
  '@stylexjs/eslint-plugin': '0.19.0',

  /**
   * Transitional Tailwind -> StyleX converter, used only as a first pass on
   * **application** files. Never point it at a shared component package: it
   * drops React Aria `data-[*]` state and the variant library's slots, and its
   * output uses raw values where the token rules require semantic tokens, so a
   * hand-pass is required regardless.
   *
   * Only `tw-to-stylex/sync` (or the default export used as a Babel plugin with
   * options) can be told to report what it dropped. Always pass
   * `{ logUnsupported: true }`: it defaults to false, and a silent drop is the
   * dangerous failure mode. The `tw-to-stylex` CLI takes the default and cannot
   * be made to log, so do not use it. Even with logging on, `data-[*]` classes
   * are dropped without a warning — audit those by hand.
   *
   * The three `@babel/*` pins are undeclared resolution requirements, not
   * conveniences. Babel resolves plugin names relative to the *calling*
   * package, not the plugin's own tree, so the consumer must declare them even
   * though `tw-to-stylex` lists `@babel/plugin-syntax-typescript` as a
   * dependency; without them every invocation dies with ERR_MODULE_NOT_FOUND.
   * Held on Babel 7 because `@babel/plugin-syntax-typescript@7` peers
   * `@babel/core@^7`, and Babel 8 therefore trips `strictPeerDependencies`.
   */
  'tw-to-stylex': '0.1.0-alpha.1',
  '@babel/core': '7.29.7',
  '@babel/plugin-syntax-jsx': '7.29.7',
  '@babel/plugin-syntax-typescript': '7.29.7',

  // Storybook
  // 10.5.x is the floor for the visual gate: `storybookTest({ initialGlobals })`
  // defines one Vitest project per theme, which is how light and dark are both
  // covered. Verified absent from 10.4.6's plugin options.
  storybook: '10.5.10',
  '@storybook/react': '10.5.10',
  '@storybook/react-vite': '10.5.10',
  /** Per-story render/interaction/a11y coverage. Peers `storybook@^10.5.10`, so the cohort moves together. */
  '@storybook/addon-vitest': '10.5.10',
  /**
   * Required, not optional: `parameters.a11y.test` has no effect unless this
   * addon is registered, and it defaults to `'todo'` (warn-only), so the gate
   * must override it to `'error'`.
   */
  '@storybook/addon-a11y': '10.5.10',
  /**
   * Browser-mode runner for the story tests.
   *
   * WELDED TO THE `vitest` PIN. `@vitest/browser` and `@vitest/browser-playwright`
   * peer `vitest` at the *exact* version, not a range, so bumping `vitest` is a
   * four-package move — these two and `playwright` must move with it or the
   * install fails under `strictPeerDependencies`.
   *
   * `playwright` is pinned because `@vitest/browser-playwright` declares it as a
   * non-optional peer. It is the same version as `@playwright/test` and is
   * already resolved transitively today, so naming it changes no resolution.
   * Browsers still come from the Nix closure: the published `playwright` and
   * `playwright-core` tarballs declare no scripts at all, and `ignoreScripts`
   * is on fleet-wide regardless.
   *
   * The versions matter, not just the names: `@vitest/browser@4.1.9` ships
   * pixelmatch defaults of `threshold: 0.1` and `includeAA: false`, which pass
   * real regressions silently. The gate must override both.
   */
  '@vitest/browser': '4.1.9',
  '@vitest/browser-playwright': '4.1.9',
  playwright: '1.61.0',

  // xterm (terminal emulator for browser/testing)
  '@xterm/xterm': '6.0.0',
  '@xterm/headless': '6.0.0',
  '@xterm/addon-fit': '0.11.0',
  '@xterm/addon-webgl': '0.19.0',

  // Testing
  '@testing-library/react': '16.3.3',
  '@testing-library/user-event': '14.6.7',
  'happy-dom': '20.14.0',

  // Linting
  /** Kept for rule-tester/types used by our custom lint rules even though runtime linting is oxlint. */
  eslint: '10.5.0',
  '@typescript-eslint/parser': '8.61.1',
  '@typescript-eslint/rule-tester': '8.61.1',
  '@typescript-eslint/utils': '8.61.1',
  'typescript-eslint': '8.61.1',
  prettier: '3.9.6',
  oxlint: '1.70.0',
  'oxlint-tsgolint': '0.23.0',

  // Crypto
  '@noble/hashes': '2.4.0',

  // DOM utilities
  'is-dom': '1.1.0',

  // OpenTUI / Effect Atom (experimental)
  // Effect 4 moved Atom reactivity into core (`effect/unstable/reactivity`);
  // only the React bindings remain a separate package, under the @effect scope.
  '@opentui/core': '0.4.1',
  '@opentui/react': '0.4.1',

  // Pi-tui (terminal UI framework)
  '@mariozechner/pi-tui': '0.73.1',

  // TUI React renderer dependencies
  'react-reconciler': '0.33.0',
  '@types/react-reconciler': '0.33.0',
  'yoga-layout': '3.2.1',
  'string-width': '8.2.2',
  'cli-truncate': '6.1.1',

  // AI agent tooling
  agentation: '3.0.2',
})

/**
 * Packages whose pnpm lifecycle build is denied. Derived from
 * `nativeDependencyPolicy` (every `denied-lifecycle-build` entry plus
 * `nix-grafted` addons built from source via `graft: 'link'`) so the denylist
 * and the audit share one source of truth. Insertion order is preserved to
 * keep the generated `pnpm-workspace.yaml` byte-stable.
 */
const deniedLifecycleBuilds = Object.fromEntries(
  Object.entries(nativeDependencyPolicy)
    .filter(
      ([, entry]) =>
        entry._tag === 'denied-lifecycle-build' ||
        (entry._tag === 'nix-grafted' && entry.graft === 'link'),
    )
    .map(([name]) => [name, false as const]),
)

/**
 * Shared pnpm policy settings for all megarepos.
 *
 * This is the SSOT for pnpm strictness/layout policy. Every megarepo
 * root workspace should spread this so policy stays consistent.
 *
 * The virtual dependency graph is always root-local. Cross-root reuse is
 * limited to pnpm's Store Cache inside one same-user trust boundary; composed
 * runtime identity is established by the composed workspace topology, never by
 * shared writable graph state.
 */
export const commonPnpmPolicySettings = {
  dedupePeerDependents: true as const,
  strictPeerDependencies: true as const,
  peerDependencyRules: {
    allowedVersions: {
      // bun-ffi-structs@0.2.3 (via @myobie/pty) declares typescript ^5 but the
      // repo compiles with TS 7; resolution is proven fine.
      typescript: '>=7.0.0',
      eslint: '>=10.0.0',
      vitest: '>=4.0.0',
      // @stylexjs/unplugin@0.19 declares unplugin ^2 but works with v3;
      // proven by the effect-schema-form-aria StyleX pilot (build + storybook).
      unplugin: '>=3.0.0',
    },
  },
  packageImportMethod: 'auto' as const,
  sideEffectsCache: false as const,
  verifyStoreIntegrity: true as const,
  strictStorePkgContentCheck: true as const,
  ignoreScripts: true as const,
  // The Effect 4 RC cohort moves fast; keep minimum-release-age strict
  // globally but let these advance immediately during the coordinated
  // migration window.
  minimumReleaseAgeExclude: ['@types/node', ...effectV4Cohort],
  pmOnFail: 'ignore' as const,
  /** Disable until pnpm#10393 is resolved (install no-ops for workspace changes) */
  optimisticRepeatInstall: false as const,
  verifyDepsBeforeRun: false as const,
  supportedArchitectures: {
    os: ['linux', 'darwin'],
    cpu: ['x64', 'arm64'],
    libc: ['glibc', 'musl'],
  },
  // Native binaries are provided by Nix/custom flakes instead of pnpm lifecycle
  // scripts. pnpm 11 removed ignoreDepScripts in favor of allowBuilds; keep
  // known native packages explicit so approval drift is reviewed, but do not
  // allow any dependency build during install. Derived from
  // `nativeDependencyPolicy` so the denylist and CI audit cannot drift.
  allowBuilds: deniedLifecycleBuilds,
}

/** Common fields for private packages */
export const privatePackageDefaults = {
  version: '0.1.0',
  private: true,
  type: 'module',
} as const

/** Standard package tsconfig compiler options (composite mode with src/dist structure) */
export const packageTsconfigCompilerOptions = {
  composite: true,
  rootDir: '.',
  outDir: './dist',
  tsBuildInfoFile: './dist/tsconfig.tsbuildinfo',
} as const

/** DOM library set for browser-compatible packages */
export const domLib = ['ES2024', 'DOM', 'DOM.Iterable'] as const

/** Ambient Node types for packages that explicitly depend on @types/node */
export const nodeTypes = { types: ['node'] } as const

/** React JSX configuration for React packages */
export const reactJsx = { jsx: 'react-jsx' as const }

const relativeRepoPath = ({ from, to }: { from: string; to: string }) => {
  const normalizedFrom = from === '.' ? '' : from
  const fromParts = normalizedFrom.split('/').filter(Boolean)
  const toParts = to.split('/').filter(Boolean)

  let common = 0
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common] === toParts[common]
  ) {
    common++
  }

  const upCount = fromParts.length - common
  const downPath = toParts.slice(common).join('/')
  const relativePath = '../'.repeat(upCount) + downPath

  return relativePath === '' ? '.' : relativePath
}

// =============================================================================
// TypeScript Reference Helpers
// =============================================================================

/**
 * effect-utils package paths for tsconfig references.
 * Paths are relative to the packages directory (e.g. '@overeng/react-inspector').
 * Parent repos can use createRefs() to build refs with the appropriate base path.
 */
export const effectUtilsPackages = {
  reactInspector: '@overeng/react-inspector',
  schemaForm: '@overeng/effect-schema-form',
} as const

/**
 * Creates tsconfig reference objects for effect-utils packages.
 * @param basePath Path from consuming package to effect-utils' packages dir (e.g. '../../../submodules/effect-utils/packages')
 */
export const createEffectUtilsRefs = (basePath: string) =>
  Object.fromEntries(
    Object.entries(effectUtilsPackages).map(([key, pkgPath]) => [
      key,
      { path: `${basePath}/${pkgPath}` },
    ]),
  ) as { [K in keyof typeof effectUtilsPackages]: { path: string } }

// =============================================================================
// Patch Postinstall Helpers
// =============================================================================

/** Repo-local patches that should not be projected into downstream consumers. */
export const effectUtilsWorkspacePatches = definePatchedDependencies({
  location: 'packages/@overeng/utils',
  patches: {
    /* @myobie/pty@0.10.0 (via @overeng/pty-effect) does a default import
       `import xtermSerialize from "@xterm/addon-serialize"`, but
       @xterm/addon-serialize@0.14.0 shipped a proper ESM build whose only
       exports are named (`SerializeAddon`, `HTMLSerializeHandler`) — the
       CJS-interop default that 0.13.x provided is gone. Rewrite the import to
       a namespace import so `xtermSerialize.SerializeAddon` resolves. */
    '@myobie/pty@0.10.0': './patches/@myobie__pty@0.10.0.patch',
  },
})

/**
 * Repo-root-relative registry used by downstream projection helpers
 * (patchPostinstall / pnpmPatchedDependencies / createPnpmPatchedDependencies).
 * Empty since the Effect 4 cohort flip: projected patches would be listed here.
 */
const patches: PatchesRegistry = {}

/**
 * Parse a patch specifier into package name and version.
 */
const parsePatchSpecifier = (specifier: string): [string, string] | undefined => {
  const lastAtIndex = specifier.lastIndexOf('@')
  if (lastAtIndex <= 0) return undefined

  if (specifier.startsWith('@') === true) {
    const afterScope = specifier.indexOf('/', 1)
    if (afterScope === -1) return undefined
    const versionAtIndex = specifier.indexOf('@', afterScope)
    if (versionAtIndex === -1) return undefined
    return [specifier.slice(0, versionAtIndex), specifier.slice(versionAtIndex + 1)]
  }

  return [specifier.slice(0, lastAtIndex), specifier.slice(lastAtIndex + 1)]
}

/**
 * Generate postinstall script commands for applying patches.
 */
const generatePatchCommands = ({
  patchEntries,
  location,
}: {
  patchEntries: Array<[string, string]>
  location: string
}): string => {
  return patchEntries
    .map(([specifier, patchPath]) => {
      const parsed = parsePatchSpecifier(specifier)
      if (parsed === undefined) return undefined
      const [pkgName] = parsed
      const relativePath =
        patchPath.startsWith('./') === true || patchPath.startsWith('../') === true
          ? patchPath
          : relativeRepoPath({ from: location, to: patchPath })
      return `patch --forward -p1 -d node_modules/${pkgName} < ${relativePath} || true`
    })
    .filter((x): x is string => x !== undefined)
    .join(' && ')
}

/**
 * Creates a postinstall script function for applying patches.
 * Returns a function that resolves at stringify time using ctx.location.
 *
 * Uses the effect-utils patches registry by default.
 *
 * @example
 * ```ts
 * import { patchPostinstall } from '../genie/repo.ts'
 *
 * export default packageJson({
 *   scripts: {
 *     postinstall: patchPostinstall(),
 *   },
 * })
 * ```
 */
export const patchPostinstall = (customPatches: PatchesRegistry = patches): ScriptValue => {
  const entries = Object.entries(customPatches).toSorted(([a], [b]) => a.localeCompare(b))
  return (location: string) => generatePatchCommands({ patchEntries: entries, location })
}

/**
 * Returns pnpm.patchedDependencies config using the effect-utils patches registry.
 *
 * Uses pnpm's native patching which works with `--ignore-scripts` (patches are applied
 * during package resolution, not as lifecycle scripts).
 *
 * Paths are repo-relative and will be resolved to package-relative paths at stringify time.
 *
 * @example
 * ```ts
 * import { pnpmPatchedDependencies } from '../genie/repo.ts'
 *
 * export default packageJson({
 *   pnpm: {
 *     patchedDependencies: pnpmPatchedDependencies(),
 *   },
 * })
 * ```
 */
export const pnpmPatchedDependencies = (
  customPatches: PatchesRegistry = patches,
): PatchesRegistry => ({ ...customPatches })

/**
 * Creates a pnpmPatchedDependencies function with prefixed paths for use from a peer repo.
 *
 * @param basePath Path from consuming repo to effect-utils root (e.g. 'effect-utils')
 * @returns A pnpmPatchedDependencies function that uses prefixed patch paths
 *
 * @example
 * ```ts
 * // In schickling.dev/genie/repo.ts
 * import { createPnpmPatchedDependencies } from './effect-utils/genie/external.ts'
 *
 * export const pnpmPatchedDependencies = createPnpmPatchedDependencies({ basePath: 'effect-utils' })
 * ```
 */
export const createPnpmPatchedDependencies = (args: { basePath: string }) => {
  const prefixedPatches = Object.fromEntries(
    Object.entries(patches).map(([pkg, path]) => [pkg, `${args.basePath}/${path}`]),
  ) as PatchesRegistry
  return (customPatches: PatchesRegistry = prefixedPatches): PatchesRegistry => ({
    ...customPatches,
  })
}

/**
 * Creates a patchPostinstall function with prefixed paths for use from a peer repo.
 *
 * @param basePath Path from consuming repo to effect-utils root (e.g. 'effect-utils')
 * @returns A patchPostinstall function that uses prefixed patch paths
 *
 * @example
 * ```ts
 * // In schickling.dev/genie/repo.ts
 * import { createPatchPostinstall } from './effect-utils/genie/external.ts'
 *
 * export const patchPostinstall = createPatchPostinstall({ basePath: 'effect-utils' })
 * ```
 */
export const createPatchPostinstall = (args: { basePath: string }) => {
  const prefixedPatches = Object.fromEntries(
    Object.entries(patches).map(([pkg, path]) => [pkg, `${args.basePath}/${path}`]),
  ) as PatchesRegistry
  return (customPatches: PatchesRegistry = prefixedPatches): ScriptValue => {
    const entries = Object.entries(customPatches).toSorted(([a], [b]) => a.localeCompare(b))
    return (location: string) => generatePatchCommands({ patchEntries: entries, location })
  }
}

/**
 * #811 Effect-LSP strict-gate policy.
 *
 * The `@effect/language-service` plugin classifies every Effect diagnostic into
 * a TS category (error / warning / suggestion) and only lets a category affect
 * the `tsgo --build` exit code when the matching `ignore…InTscExitCode` flag is
 * `false`. This switch is the gate: both fields are `true`, so Effect warnings
 * AND suggestions fail the build exit code (errors always gate regardless).
 *
 * The gate runs through the existing `tsgo --build` over the project graph — no
 * extra compiler pass — so it is enforced by `ts:check` / `ts:check:strict`
 * (hence `devenv tasks run check:quick` / `devenv tasks run check:all` and the CI `typecheck` lane).
 *
 * This is the SHARED base consumed by peer repos: enabling it gates Effect
 * diagnostics fleet-wide. A repo that is not yet clean can locally override its
 * own tsconfig plugin options (set `ignoreEffect{Warnings,Suggestions}InTscExitCode`
 * back to `true`) until it converges, rather than carrying diagnostics in source.
 */
const effectDiagnosticsGate = { warnings: true, suggestions: true } as const

/** Base tsconfig compiler options shared across all packages */
export const baseTsconfigCompilerOptions = {
  target: 'ES2024',
  lib: ['ES2024'],
  module: 'NodeNext',
  moduleResolution: 'NodeNext',
  allowImportingTsExtensions: true,
  rewriteRelativeImportExtensions: true,
  resolveJsonModule: true,
  esModuleInterop: true,
  allowJs: false,
  declaration: true,
  declarationMap: true,
  sourceMap: true,
  outDir: 'dist',
  strict: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  noImplicitReturns: true,
  noFallthroughCasesInSwitch: true,
  noImplicitOverride: true,
  isolatedModules: true,
  verbatimModuleSyntax: true,
  skipLibCheck: true,
  forceConsistentCasingInFileNames: true,
  plugins: [
    {
      // Upstream tsgo currently reads Effect-specific diagnostics/options from
      // this plugin entry, while plain tsc ignores it when the npm package is absent.
      name: '@effect/language-service',
      // #811 Effect-LSP gate policy. Each `ignore…InTscExitCode` flag is the
      // INVERSE of "this severity gates": `false` => the severity contributes to
      // the `tsgo --build` exit code. Derived from `effectDiagnosticsGate` so the
      // intent is a single one-line flip (see that constant for the burndown plan).
      ignoreEffectWarningsInTscExitCode: !effectDiagnosticsGate.warnings,
      ignoreEffectSuggestionsInTscExitCode: !effectDiagnosticsGate.suggestions,
      // Errors always gate.
      ignoreEffectErrorsInTscExitCode: false,
      // Keep suggestions visible in build output (advisory steering). Visibility
      // is independent of gating: this stays `true` regardless of the toggle.
      includeSuggestionsInTsc: true,
      pipeableMinArgCount: 2,
      diagnosticSeverity: {
        // Off-by-default rules the team opts into (now gating as warnings).
        missedPipeableOpportunity: 'warning',
        schemaUnionOfLiterals: 'warning',
        anyUnknownInErrorContext: 'warning',
        preferSchemaOverJson: 'warning',
        // `missingEffectContext` / `missingEffectError` keep their upstream
        // default `error` severity (no override) — real lifecycle bugs, gated
        // hard. Genuine type-level assertion sites are waived in source with a
        // narrow `@effect-diagnostics … :skip-file` directive instead.
      },
    },
  ],
} as const satisfies TSConfigCompilerOptions

// =============================================================================
// Oxlint Configuration Helpers
// =============================================================================

import type { OxlintOverride } from '../packages/@overeng/genie/src/runtime/oxlint-config/mod.ts'

export {
  baseOxlintCategories,
  baseOxlintIgnorePatterns,
  baseOxlintPlugins,
  baseOxlintRules,
} from './oxlint-base.ts'

/** Standard overrides for mod.ts entry point files */
export const modEntryOxlintOverride = {
  files: ['**/mod.ts'],
  rules: { 'oxc/no-barrel-file': 'off' },
} as const satisfies OxlintOverride

/** Standard overrides for storybook story files (*.stories.*) */
export const storybookOxlintOverride = {
  files: ['**/*.stories.tsx', '**/*.stories.ts'],
  rules: {
    // Relaxed rules for story files
    'func-style': 'off',
    'overeng/exports-first': 'off',
    'overeng/jsdoc-require-exports': 'off',
  },
} as const satisfies OxlintOverride

/** Standard overrides for storybook config files (.storybook/*) */
export const storybookConfigOxlintOverride = {
  files: ['**/.storybook/**'],
  rules: {
    'func-style': 'off',
    'overeng/exports-first': 'off',
    'overeng/jsdoc-require-exports': 'off',
    'import/no-unassigned-import': 'off',
  },
} as const satisfies OxlintOverride

/** Standard overrides for config files */
export const configFilesOxlintOverride = {
  files: ['**/vitest.config.ts', '**/vite.config.ts', '**/playwright.config.ts'],
  rules: {
    'func-style': 'off',
    'overeng/jsdoc-require-exports': 'off',
  },
} as const satisfies OxlintOverride

/** Standard overrides for test files */
export const testFilesOxlintOverride = {
  files: ['**/*.test.ts', '**/*.test.tsx', '**/__tests__/**'],
  rules: {
    'overeng/named-args': 'off',
    'unicorn/no-array-sort': 'off',
    'unicorn/consistent-function-scoping': 'off',
    'require-yield': 'off',
  },
} as const satisfies OxlintOverride

// =============================================================================
// CI Workflow Helpers
// =============================================================================

export {
  bashShellDefaults,
  checkoutStep,
  cachixCliBuildStep,
  cachixStep,
  cachixBinaryCache,
  devenvBinaryCache,
  devenvPerfArtifactStep,
  devenvPerfBenchmarkStep,
  devenvPerfJob,
  defaultNixClosureMeasurementBuckets,
  nixClosureMeasurementSteps,
  nixClosureMeasurementsJob,
  pnpmStateSetupStep,
  restorePnpmStateStep,
  savePnpmStateStep,
  preparePinnedDevenvStep,
  preparePinnedDevenvStepFor,
  installMegarepoStep,
  installNixStep,
  namespaceRunner,
  nixBinaryCachesExtraConf,
  nixDiagnosticsArtifactStep,
  runDevenvTasksBefore,
  validateNixStoreStep,
  validateNixStoreStepFor,
  standardCIEnv,
  syncMegarepoWorkspaceStep,
  applyMegarepoLockStep,
  cacheableMegarepoStore,
  restoreMegarepoStoreStep,
  saveMegarepoStoreStep,
  RUNNER_PROFILES,
  type CiMeasurementDescriptor,
  type DevenvPerfJobOptions,
  type DevenvPerfProbe,
  type DevenvPerfTaskProbe,
  type NixClosureMeasurementBucket,
  type NixClosureMeasurementTarget,
  type NixClosureMeasurementsJobOptions,
  type NixClosureMeasurementsStepsOptions,
  type NixBinaryCache,
  type RunnerProfile,
} from './ci-workflow.ts'
