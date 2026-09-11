import { withJavaScriptCandidates } from '../../../genie/buck2/javascript-candidates.ts'
import { javaScriptProductsFor } from '../../../genie/buck2/javascript-product-registry.ts'
import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_megarepo_b89b4c18f380',
  packageName: '@overeng/megarepo',
  packagePath: 'packages/@overeng/megarepo',
  projectionSource: 'packages/@overeng/megarepo/BUCK.genie.ts',
  sourceRoots: ['src', 'bin'],
  workspaceSiblings: [
    {
      packageName: '@overeng/effect-path',
      packagePath: 'packages/@overeng/effect-path',
      distTarget: '//packages/@overeng/effect-path:dist',
    },
    {
      packageName: '@overeng/kdl',
      packagePath: 'packages/@overeng/kdl',
      distTarget: '//packages/@overeng/kdl:dist',
    },
    {
      packageName: '@overeng/kdl-effect',
      packagePath: 'packages/@overeng/kdl-effect',
      distTarget: '//packages/@overeng/kdl-effect:dist',
    },
    {
      packageName: '@overeng/otel-contract',
      packagePath: 'packages/@overeng/otel-contract',
      distTarget: '//packages/@overeng/otel-contract:dist',
    },
    {
      packageName: '@overeng/tui-core',
      packagePath: 'packages/@overeng/tui-core',
      distTarget: '//packages/@overeng/tui-core:dist',
    },
    {
      packageName: '@overeng/tui-react',
      packagePath: 'packages/@overeng/tui-react',
      distTarget: '//packages/@overeng/tui-react:dist',
    },
    {
      packageName: '@overeng/utils',
      packagePath: 'packages/@overeng/utils',
      distTarget: '//packages/@overeng/utils:dist',
    },
    {
      packageName: '@overeng/utils-dev',
      packagePath: 'packages/@overeng/utils-dev',
      distTarget: '//packages/@overeng/utils-dev:dist',
    },
  ],
  editorViewConsumer: false,
  authorities: [{ declarationEntrypoint: 'src/mod.d.ts', projectFile: 'tsconfig.json' }],
  tests: [
    {
      name: 'test',
      runner: 'vitest',
      // The CLI contract suite spawns the pinned Bun. The store-hygiene unit suite,
      // every `*.integration.test.ts` suite, and the PTY prompt suite drive real git,
      // nix, coreutils, or `script`, so they stay unbounded (decision 0026) under the
      // devenv `test:megarepo` and `test:megarepo-cold-gc` tasks.
      tools: { BUN_BIN: '//buck2/toolchains:tool_bun' },
      excludes: [
        'src/cli/cli.integration.test.ts',
        'src/cli/commands/composition.integration.test.ts',
        'src/cli/commands/store/composed-worktrees.integration.test.ts',
        'src/cli/pin.integration.test.ts',
        'src/cli/prompt-select-pty.test.ts',
        'src/cli/status.integration.test.ts',
        'src/cli/store-gc-cold.integration.test.ts',
        'src/cli/store-gc-generated.integration.test.ts',
        'src/cli/store-gc-otel.integration.test.ts',
        'src/cli/store.integration.test.ts',
        'src/cli/sync.integration.test.ts',
        'src/composition/acquisition/owned-worktree-acquisition.integration.test.ts',
        'src/composition/apply/composition-apply.integration.test.ts',
        'src/composition/apply/workspace-update-lock.integration.test.ts',
        'src/composition/capabilities/composition-capability-resolver.integration.test.ts',
        'src/composition/capabilities/owned-capability-projection.integration.test.ts',
        'src/composition/mounts/member-mount-cp-a.integration.test.ts',
        'src/composition/mounts/member-mount-r6.integration.test.ts',
        'src/composition/overlays/dist-overlay-lifecycle.integration.test.ts',
        'src/composition/root/composition-root-publisher.integration.test.ts',
        'src/composition/root/composition-root.integration.test.ts',
        'src/core/git-memory.integration.test.ts',
        'src/core/git-streaming-parsers.integration.test.ts',
        'src/core/git-timeout.integration.test.ts',
        'src/store/store-archive.integration.test.ts',
        'src/store/store-deletion-lease.integration.test.ts',
        'src/store/store-hygiene.unit.test.ts',
        'src/store/store-inuse.integration.test.ts',
        'src/store/store-liveness.integration.test.ts',
        'src/store/store-lossless.integration.test.ts',
        'src/test-utils/store-setup.integration.test.ts',
      ],
      sourceOwners: {
        'src/cli/store-gc-cold.integration.test.ts': 'test:megarepo-cold-gc',
      },
    },
  ],
} as const satisfies Buck2TypeScriptAdmission

export default withJavaScriptCandidates({
  projection: buck2TypeScriptPackageProjection(buck2TypeScriptAdmission),
  products: javaScriptProductsFor(buck2TypeScriptAdmission.packagePath),
})
