import {
  createGenieOutput,
  type GenieOutput,
} from '../../packages/@overeng/genie/src/runtime/core.ts'

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
  /** Multi-file closures use a filegroup; standalone modules use export_file. */
  readonly staging: 'export_file' | 'filegroup'
}

const buck2ToolsPackagePath = 'packages/@overeng/buck2-tools'
const buck2ToolsLabel = (name: string): string => `//${buck2ToolsPackagePath}:${name}`
const runnerSource = (name: string): string => `${buck2ToolsPackagePath}/src/${name}`

/** Every TypeScript runner Buck executes, owned by the package containing its source. */
export const buck2StagedRuntimes = [
  {
    label: buck2ToolsLabel('package_tree_runtime'),
    entry: runnerSource('package-tree.ts'),
    modules: [runnerSource('package-tree.ts'), runnerSource('real-path.ts')],
    staging: 'filegroup',
  },
  {
    label: buck2ToolsLabel('package_command_runtime'),
    entry: runnerSource('package-command-runner.ts'),
    modules: [
      runnerSource('package-command-runner.ts'),
      runnerSource('real-path.ts'),
      runnerSource('typescript-runner.ts'),
    ],
    staging: 'filegroup',
  },
  {
    label: buck2ToolsLabel('javascript_action_runtime'),
    entry: runnerSource('javascript-runner.ts'),
    modules: [runnerSource('javascript-runner.ts'), runnerSource('typescript-runner.ts')],
    staging: 'filegroup',
  },
  {
    label: buck2ToolsLabel('typescript-runner.ts'),
    entry: runnerSource('typescript-runner.ts'),
    modules: [runnerSource('typescript-runner.ts')],
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

const packageRelativeSource = (module: string): string => {
  const prefix = `${buck2ToolsPackagePath}/`
  if (module.startsWith(prefix) === false) {
    throw new Error(`Buck2 tools runtime source is outside its package: ${module}`)
  }
  return module.slice(prefix.length)
}

const renderRuntime = (runtime: Buck2StagedRuntime): string => {
  const name = runtime.label.slice(runtime.label.lastIndexOf(':') + 1)
  if (runtime.staging === 'export_file') {
    return `export_file(
    name = ${JSON.stringify(name)},
    src = ${JSON.stringify(packageRelativeSource(runtime.entry))},
    visibility = ["PUBLIC"],
)`
  }
  const sources = runtime.modules
    .map(
      (module) =>
        `        ${JSON.stringify(stagedModuleName(module))}: ${JSON.stringify(packageRelativeSource(module))},`,
    )
    .join('\n')
  return `filegroup(
    name = ${JSON.stringify(name)},
    srcs = {
${sources}
    },
    visibility = ["PUBLIC"],
)`
}

/** Appends the package-owned staged runner targets to its TypeScript projection. */
export const withBuck2ToolsRuntimes = <TData>(projection: GenieOutput<TData>): GenieOutput<TData> =>
  createGenieOutput({
    ...projection,
    stringify: (context) =>
      `${projection.stringify(context)}\n${buck2StagedRuntimes.map(renderRuntime).join('\n\n')}\n`,
  })
