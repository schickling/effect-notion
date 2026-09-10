/**
 * Declared module sets for the TypeScript sources Buck stages into actions.
 *
 * A Buck action sees only what its rule declares. A runner staged as one file
 * whose source imports a sibling module resolves that import against a
 * directory that does not contain it, and the action fails at run time with
 * `Cannot find module`. These declarations are the complete relative-import
 * closure of each runner; `buck2-runtime-closure.unit.test.ts` re-derives the
 * closure from the sources and fails when the two disagree.
 */

/** One runner and the exact set of repository sources staged alongside it. */
export type Buck2StagedRuntime = {
  /** Buck label the package rules point their `runtime` attribute at. */
  readonly label: string
  /** Entry module, repository-relative. */
  readonly entry: string
  /** Complete relative-import closure of `entry`, repository-relative. */
  readonly modules: readonly string[]
  /**
   * How the label stages the modules. `filegroup` co-locates a closure of more
   * than one module; `export_file` stages exactly one file on its own and can
   * therefore only carry a runner with no relative imports.
   */
  readonly staging: 'export_file' | 'filegroup'
}

const runnerSource = (name: string): string => `packages/@overeng/buck2-tools/src/${name}`

/** Every TypeScript runner Buck executes, and the sources staged with it. */
export const buck2StagedRuntimes = [
  {
    label: '//:package_tree_runtime',
    entry: runnerSource('package-tree.ts'),
    modules: [runnerSource('package-tree.ts'), runnerSource('real-path.ts')],
    staging: 'filegroup',
  },
  {
    label: '//:package_command_runtime',
    entry: runnerSource('package-command-runner.ts'),
    modules: [
      runnerSource('package-command-runner.ts'),
      runnerSource('real-path.ts'),
      runnerSource('typescript-runner.ts'),
    ],
    staging: 'filegroup',
  },
  {
    label: '//:javascript_action_runtime',
    entry: runnerSource('javascript-runner.ts'),
    modules: [runnerSource('javascript-runner.ts'), runnerSource('typescript-runner.ts')],
    staging: 'filegroup',
  },
  {
    label: '//:packages/@overeng/buck2-tools/src/typescript-runner.ts',
    entry: runnerSource('typescript-runner.ts'),
    modules: [runnerSource('typescript-runner.ts')],
    staging: 'export_file',
  },
  {
    label: '//:packages/@overeng/buck2-tools/src/owned-files.ts',
    entry: runnerSource('owned-files.ts'),
    modules: [runnerSource('owned-files.ts')],
    staging: 'export_file',
  },
] as const satisfies readonly Buck2StagedRuntime[]

/** The package-tree runner, which the generated package projections point at. */
export const packageTreeRuntime = buck2StagedRuntimes[0]

/** The JavaScript command and test runner, which the generated test targets point at. */
export const javaScriptActionRuntime = buck2StagedRuntimes[2]

/** Staged name of a module inside its runtime tree, which is flat by construction. */
export const stagedModuleName = (module: string): string => {
  const name = module.slice(module.lastIndexOf('/') + 1)
  if (name === '') throw new Error(`Runtime module has no file name: ${module}`)
  return name
}
