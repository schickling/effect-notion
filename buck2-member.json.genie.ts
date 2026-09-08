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
  remoteCache: {
    endpoint: 'grpc://dev3:41045',
    instanceName: 'effect-utils',
  },
  projectIgnore: [
    '**/__pycache__',
    '**/dist',
    '**/node_modules',
    '**/node_modules/**',
    '**/target',
    '**/target/**',
    '.devenv',
    '.git',
    'buck-out',
    'node_modules',
    'packages/.editor-view',
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
      toolId: 'buck2',
      protocol: 'facebook/buck2-cli/2026-08-22',
      flakePackage: 'buck2',
      executable: 'bin/buck2',
    },
    {
      toolId: 'coreutils-readlink',
      protocol: 'gnu/coreutils/v9',
      flakePackage: 'buck2-coreutils',
      executable: 'bin/readlink',
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
