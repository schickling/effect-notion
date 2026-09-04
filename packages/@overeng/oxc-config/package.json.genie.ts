// @genie-bootstrap
/**
 * Shared oxlint/oxfmt configuration with custom JS plugin rules.
 *
 * Note on Nix build: The standard Nix oxlint binary (pkgs.oxlint) is compiled
 * from Rust and does NOT support JS plugins. To enable the custom `overeng/*`
 * rules defined in `./src/mod.ts`, we package the npm version of oxlint with
 * NAPI bindings via `nix/oxlint-npm.nix`. This uses Bun as the JS runtime.
 *
 * See `nix/oxlint-npm.nix` for update instructions when bumping oxlint version.
 */
import {
  catalog,
  workspaceMember,
  exportEntry,
  packageJson,
  privatePackageDefaults,
  type PackageJsonInputData,
} from '../../../genie/internal.ts'

const deps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/oxc-config' }),
  devDependencies: {
    external: {
      ...catalog.pick(
        '@stylexjs/eslint-plugin',
        '@types/eslint',
        '@typescript-eslint/parser',
        '@typescript-eslint/rule-tester',
        '@typescript-eslint/utils',
        'eslint',
        'typescript',
        'vitest',
        'oxlint-tsgolint',
      ),
    },
  },
})

export default packageJson(
  {
    name: '@overeng/oxc-config',
    ...privatePackageDefaults,
    exports: {
      './plugin': exportEntry(
        { types: './dist/src/mod.d.ts', default: './src/mod.ts' },
        { environment: 'node' },
      ),
      './stylex-upstream-plugin': exportEntry(
        {
          types: './dist/src/stylex-upstream-plugin.d.ts',
          default: './src/stylex-upstream-plugin.ts',
        },
        {
          environment: 'node',
        },
      ),
    },
  } satisfies PackageJsonInputData,
  deps,
)
