import { projectionArtifact } from './packages/@overeng/genie/src/runtime/mod.ts'
import { buck2TypeScriptDistOverlays } from './genie/buck2/typescript-admissions.ts'
import {
  COMPOSITION_ROOT_SCHEMA_VERSION,
  decodeBuckMemberManifest,
  decodeBuckMemberManifestJson,
  encodeBuckMemberManifestJson,
  type BuckMemberManifest,
} from './packages/@overeng/megarepo/src/buck2-manifest.ts'

const buckMemberSchemaVersion = COMPOSITION_ROOT_SCHEMA_VERSION

const manifestProjection = {
  cell: 'effect_utils',
  mount: 'repos/effect-utils',
  projectIgnore: [
    '**/__pycache__',
    '**/dist',
    '**/node_modules',
    '**/node_modules/**',
    '**/target',
    '**/target/**',
    '.buck2/capability-gcroots',
    '.devenv',
    '.git',
    'buck-out',
    'node_modules',
    '.editor-view',
    'context/.editor-view',
    'packages/.editor-view',
    'packages/@overeng/effect-rpc-tanstack/.editor-view',
    'target',
    'tmp',
  ],
  distOverlays: buck2TypeScriptDistOverlays,
  capabilities: [
    {
      _tag: 'ToolchainAuthority',
      toolchain: 'bun',
      provides: [
        {
          toolId: 'bun',
          protocol: 'effect-utils/buck2-bun/v1',
          flakePackage: 'bun',
          executable: 'bin/bun',
        },
      ],
    },
    {
      _tag: 'ToolchainAuthority',
      toolchain: 'go',
      provides: [
        {
          toolId: 'go',
          protocol: 'effect-utils/buck2-go/v1',
          flakePackage: 'buck2-go',
          executable: 'bin/go',
        },
      ],
    },
    {
      _tag: 'ToolchainAuthority',
      toolchain: 'pnpm',
      provides: [],
    },
    {
      _tag: 'ToolchainAuthority',
      toolchain: 'python-bootstrap',
      provides: [
        {
          toolId: 'python-bootstrap',
          protocol: 'effect-utils/buck2-python-bootstrap/v1',
          flakePackage: 'buck2-python-bootstrap',
          executable: 'bin/python3',
        },
      ],
    },
    {
      _tag: 'ToolchainAuthority',
      toolchain: 'tsgo',
      provides: [
        {
          toolId: 'effect-tsgo',
          protocol: 'effect-utils/buck2-effect-tsgo/v1',
          flakePackage: 'effect-tsgo',
          executable: 'bin/tsgo',
        },
      ],
    },
    {
      toolId: 'archive-tool',
      protocol: 'effect-utils/buck2-archive-tool/v2',
      flakePackage: 'buck2-archive-tool',
      executable: 'bin/buck2-archive-tool',
    },
    {
      toolId: 'node',
      protocol: 'nodejs/24',
      flakePackage: 'buck2-node',
      executable: 'bin/node',
    },
    // Linux containment launcher. `systems` scopes it away from Darwin, where containment is
    // the fixed system `sandbox-exec` bound to the admitted macOS release rather than a Nix
    // realization, so a Darwin projection must not try to realize a Linux-only package.
    {
      toolId: 'sandbox-bubblewrap',
      protocol: 'containers/bubblewrap/v1',
      flakePackage: 'buck2-bubblewrap',
      executable: 'bin/bwrap',
      systems: ['x86_64-linux', 'aarch64-linux'],
    },
    {
      toolId: 'buck2',
      protocol: 'facebook/buck2-cli/2026-08-22',
      flakePackage: 'buck2',
      executable: 'bin/buck2',
    },
    {
      toolId: 'product',
      protocol: 'effect-utils/buck2-product/v1',
      flakePackage: 'buck2-product',
      executable: 'bin/buck2-product',
    },
    {
      toolId: 'rust-archiver',
      protocol: 'effect-utils/buck2-rust-tool/v1',
      flakePackage: 'buck2-rust-archiver',
      executable: 'bin/ar',
    },
    {
      toolId: 'rust-dwp',
      protocol: 'effect-utils/buck2-rust-tool/v1',
      flakePackage: 'buck2-rust-dwp',
      executable: 'bin/dwp',
    },
    {
      toolId: 'rust-nm',
      protocol: 'effect-utils/buck2-rust-tool/v1',
      flakePackage: 'buck2-rust-nm',
      executable: 'bin/nm',
    },
    {
      toolId: 'rust-objcopy',
      protocol: 'effect-utils/buck2-rust-tool/v1',
      flakePackage: 'buck2-rust-objcopy',
      executable: 'bin/objcopy',
    },
    {
      toolId: 'rust-objdump',
      protocol: 'effect-utils/buck2-rust-tool/v1',
      flakePackage: 'buck2-rust-objdump',
      executable: 'bin/objdump',
    },
    {
      toolId: 'rust-ranlib',
      protocol: 'effect-utils/buck2-rust-tool/v1',
      flakePackage: 'buck2-rust-ranlib',
      executable: 'bin/ranlib',
    },
    {
      toolId: 'rust-strip',
      protocol: 'effect-utils/buck2-rust-tool/v1',
      flakePackage: 'buck2-rust-strip',
      executable: 'bin/strip',
    },
    {
      toolId: 'rust-c-compiler',
      protocol: 'effect-utils/buck2-rust-tool/v1',
      flakePackage: 'buck2-rust-c-compiler',
      executable: 'bin/cc',
    },
    {
      toolId: 'rust-clippy-driver',
      protocol: 'effect-utils/buck2-rust-tool/v1',
      flakePackage: 'buck2-rust-clippy-driver',
      executable: 'bin/clippy-driver',
    },
    {
      toolId: 'rust-compiler',
      protocol: 'effect-utils/buck2-rust-tool/v1',
      flakePackage: 'buck2-rust-compiler',
      executable: 'bin/rustc',
    },
    {
      toolId: 'rust-cxx-compiler',
      protocol: 'effect-utils/buck2-rust-tool/v1',
      flakePackage: 'buck2-rust-cxx-compiler',
      executable: 'bin/c++',
    },
    {
      toolId: 'rust-linker',
      protocol: 'effect-utils/buck2-rust-tool/v1',
      flakePackage: 'buck2-rust-linker',
      executable: 'bin/c++',
    },
    {
      toolId: 'rust-rustdoc',
      protocol: 'effect-utils/buck2-rust-tool/v1',
      flakePackage: 'buck2-rust-rustdoc',
      executable: 'bin/rustdoc',
    },
    {
      toolId: 'rust-shell',
      protocol: 'effect-utils/buck2-rust-tool/v1',
      flakePackage: 'buck2-rust-shell',
      executable: 'bin/bash',
    },
    // Deterministic test-tool capabilities. A declared executable alone is not runnable inside
    // containment: the sandbox binds exactly the projected `closureStorePaths`, so every host
    // executable a hermetic test drives must be an attested capability rather than a bare path.
    {
      toolId: 'coreutils-cp',
      protocol: 'gnu/coreutils/v9',
      flakePackage: 'buck2-coreutils',
      executable: 'bin/cp',
    },
    {
      toolId: 'coreutils-false',
      protocol: 'gnu/coreutils/v9',
      flakePackage: 'buck2-coreutils',
      executable: 'bin/false',
    },
    {
      toolId: 'coreutils-mv',
      protocol: 'gnu/coreutils/v9',
      flakePackage: 'buck2-coreutils',
      executable: 'bin/mv',
    },
    {
      toolId: 'coreutils-env',
      protocol: 'gnu/coreutils/v9',
      flakePackage: 'buck2-coreutils',
      executable: 'bin/env',
    },
    {
      toolId: 'coreutils-wc',
      protocol: 'gnu/coreutils/v9',
      flakePackage: 'buck2-coreutils',
      executable: 'bin/wc',
    },
    {
      toolId: 'coreutils-stty',
      protocol: 'gnu/coreutils/v9',
      flakePackage: 'buck2-coreutils',
      executable: 'bin/stty',
    },
    {
      toolId: 'coreutils-echo',
      protocol: 'gnu/coreutils/v9',
      flakePackage: 'buck2-coreutils',
      executable: 'bin/echo',
    },
    {
      toolId: 'coreutils-printf',
      protocol: 'gnu/coreutils/v9',
      flakePackage: 'buck2-coreutils',
      executable: 'bin/printf',
    },
    {
      toolId: 'coreutils-cat',
      protocol: 'gnu/coreutils/v9',
      flakePackage: 'buck2-coreutils',
      executable: 'bin/cat',
    },
    {
      toolId: 'test-sh',
      protocol: 'gnu/bash/v5',
      flakePackage: 'buck2-bash',
      executable: 'bin/sh',
    },
    {
      toolId: 'coreutils-true',
      protocol: 'gnu/coreutils/v9',
      flakePackage: 'buck2-coreutils',
      executable: 'bin/true',
    },
    {
      toolId: 'test-procps',
      protocol: 'procps/ps/v4',
      flakePackage: 'buck2-procps',
      executable: 'bin/ps',
    },
    {
      toolId: 'test-rustfmt',
      protocol: 'rust-lang/rustfmt/v1',
      flakePackage: 'buck2-rustfmt',
      executable: 'bin/rustfmt',
    },
    {
      toolId: 'test-bash',
      protocol: 'gnu/bash/v5',
      flakePackage: 'buck2-bash',
      executable: 'bin/bash',
    },
    {
      toolId: 'test-git',
      protocol: 'git/cli/v2',
      flakePackage: 'buck2-git',
      executable: 'bin/git',
    },
    {
      toolId: 'test-grep',
      protocol: 'gnu/grep/v3',
      flakePackage: 'buck2-gnugrep',
      executable: 'bin/grep',
    },
    {
      toolId: 'test-nix',
      protocol: 'nixos/nix-cli/v2',
      flakePackage: 'buck2-nix',
      executable: 'bin/nix',
    },
    // Whole-bundle capability for the devenv-module shell suite: one attested realization whose
    // closure carries every GNU tool the suite drives, and whose sentinel executable puts the
    // bundle's `bin` on the lane's PATH.
    {
      toolId: 'test-devenv-module-tools',
      protocol: 'effect-utils/devenv-module-tools/v1',
      flakePackage: 'buck2-devenv-module-tools',
      executable: 'bin/devenv-module-tools',
    },
    // The devenv-module deploy/report suites drive the real `ci-tools` CLI. The packaged
    // realization is what makes that possible without a root `node_modules`: the flake package
    // carries its own bundled entrypoint and Node.
    {
      toolId: 'test-ci-tools',
      protocol: 'effect-utils/ci-tools/v1',
      flakePackage: 'ci-tools',
      executable: 'bin/ci-tools',
    },
    // The compiled-Genie staging suite drives the packaged CLI bundle rather than rebuilding it
    // from source, which is what removes its root `node_modules` dependency.
    {
      toolId: 'test-genie',
      protocol: 'effect-utils/genie/v1',
      flakePackage: 'genie',
      executable: 'bin/genie',
    },
    {
      toolId: 'test-script',
      protocol: 'util-linux/script/v2',
      flakePackage: 'buck2-util-linux',
      executable: 'bin/script',
    },
    {
      toolId: 'test-otelite',
      protocol: 'effect-utils/otelite/v1',
      flakePackage: 'otelite',
      executable: 'bin/otelite',
    },
    {
      toolId: 'test-otel-scrape',
      protocol: 'effect-utils/otel-scrape/v1',
      flakePackage: 'otel-scrape',
      executable: 'bin/otel-scrape',
    },
  ],
} as const satisfies Omit<BuckMemberManifest, 'schemaVersion'>

const manifestArtifact = projectionArtifact.json({
  schemaVersion: buckMemberSchemaVersion,
  data: manifestProjection,
  project: (projection) =>
    decodeBuckMemberManifest({ schemaVersion: buckMemberSchemaVersion, ...projection }),
  validators: [
    ({ projection: schemaVersionedProjection, ctx }) => {
      const { schemaVersion, ...projection } = schemaVersionedProjection

      try {
        decodeBuckMemberManifest({ schemaVersion, ...projection })
        return []
      } catch (error) {
        return [
          {
            severity: 'error' as const,
            packageName: ctx.location,
            dependency: 'buck2-member.json',
            message: error instanceof Error ? error.message : String(error),
            rule: 'buck-member-manifest-schema',
          },
        ]
      }
    },
  ],
})

export default {
  ...manifestArtifact,
  stringify: (ctx) =>
    encodeBuckMemberManifestJson(decodeBuckMemberManifestJson(manifestArtifact.stringify(ctx))),
} satisfies typeof manifestArtifact
