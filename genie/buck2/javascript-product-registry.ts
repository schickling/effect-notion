import type { JavaScriptProduct } from './javascript-candidates.ts'

/**
 * Single source of truth for the deployable JavaScript products Buck owns.
 *
 * Package projections read their own entry, and publication reads the flat
 * projection below, so emitted candidate targets and published products cannot
 * drift into separate inventories.
 */
export const javaScriptProductRegistry = {
  'packages/@overeng/ci-tools': [
    {
      entrypoint: 'bin/ci-tools.ts',
      kind: 'cli',
      output: 'ci-tools.js',
      productName: 'ci-tools',
      smokeArgs: ['--help'],
      targetName: 'ci-tools-candidate',
    },
  ],
  'packages/@overeng/genie': [
    {
      entrypoint: 'bin/genie.tsx',
      externalCapabilities: ['actionlint', 'effect-tsgo', 'oxfmt'],
      kind: 'cli',
      output: 'genie.js',
      productName: 'genie',
      runtime: 'bun',
      smokeArgs: ['--dry-run'],
      targetName: 'genie-candidate',
      treeShaking: false,
    },
    {
      entrypoint: 'bin/bootstrap-closure-check.ts',
      kind: 'cli',
      output: 'genie-bootstrap-closure-check.js',
      productName: 'genie-bootstrap-closure-check',
      runtime: 'bun',
      smokeArgs: ['--help'],
      targetName: 'genie-bootstrap-closure-check-candidate',
    },
  ],
  'packages/@overeng/megarepo': [
    {
      entrypoint: 'bin/mr.ts',
      externalCapabilities: ['buck2', 'coreutils', 'git', 'nix', 'watchman'],
      kind: 'cli',
      output: 'mr.js',
      productName: 'megarepo',
      smokeArgs: ['--help'],
      targetName: 'megarepo-candidate',
    },
  ],
  'packages/@overeng/notion-cli': [
    {
      entrypoint: 'src/cli.ts',
      kind: 'cli',
      output: 'notion.js',
      productName: 'notion-cli',
      smokeArgs: ['md', '--help'],
      targetName: 'notion-cli-candidate',
    },
    {
      entrypoint: 'src/cli/main.ts',
      externalCapabilities: ['opentui-core-native'],
      kind: 'cli',
      output: 'notion-db.js',
      packageTree: '//packages/@overeng/notion-datasource-sync:package_tree',
      productName: 'notion-db-runtime',
      smokeArgs: ['--help'],
      smokeRuntime: 'node',
      targetName: 'notion-db-candidate',
    },
  ],
  'packages/@overeng/notion-md': [
    {
      entrypoint: 'src/cli.ts',
      kind: 'cli',
      output: 'notion-md.js',
      productName: 'notion-md',
      smokeArgs: ['--help'],
      targetName: 'notion-md-candidate',
    },
  ],
  'packages/@overeng/npm-release': [
    {
      entrypoint: 'src/cli.ts',
      externalCapabilities: ['npm'],
      kind: 'cli',
      output: 'npm-release.js',
      productName: 'npm-release',
      smokeArgs: ['--help'],
      targetName: 'npm-release-candidate',
    },
  ],
  'packages/@overeng/oxc-config': [
    {
      entrypoint: 'src/mod.ts',
      kind: 'module',
      output: 'oxc-config.js',
      productName: 'oxc-config',
      targetName: 'oxc-config-candidate',
    },
  ],
  'packages/@overeng/tui-stories': [
    {
      entrypoint: 'bin/tui-stories.tsx',
      kind: 'cli',
      output: 'tui-stories.js',
      productName: 'tui-stories',
      smokeArgs: ['--help'],
      targetName: 'tui-stories-candidate',
    },
  ],
} as const satisfies Record<string, readonly JavaScriptProduct[]>

export type JavaScriptProductPackagePath = keyof typeof javaScriptProductRegistry

/** Products a package projection must emit, keyed by its repository-relative path. */
export const javaScriptProductsFor = (
  packagePath: JavaScriptProductPackagePath,
): readonly JavaScriptProduct[] => javaScriptProductRegistry[packagePath]

/** One flat, deterministic publication entry per declared product. */
export const javaScriptProductPublications = Object.entries(javaScriptProductRegistry)
  .flatMap(([packagePath, products]) =>
    products.map((product) => ({
      label: `//${packagePath}:${product.targetName}` as const,
      module: product.output,
      productKind: product.kind,
      productName: product.productName,
      runtimeKind: product.runtime ?? 'node',
    })),
  )
  .toSorted((left, right) =>
    left.productName < right.productName ? -1 : left.productName > right.productName ? 1 : 0,
  )
