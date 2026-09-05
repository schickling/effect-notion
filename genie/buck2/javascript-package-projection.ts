import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import {
  createGenieOutput,
  type GenieOutput,
} from '../../packages/@overeng/genie/src/runtime/core.ts'
import type { Buck2TypeScriptAdmission } from './typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from './typescript-package-projection.ts'

export { javascriptTestPlanFor } from './javascript-test-targets.ts'

export type Buck2JavaScriptTestBlocker = {
  readonly surface: string
  readonly reason: string
  readonly unblockedBy: string
}

/**
 * Capabilities naming a host service rather than a declared input: the outbound network, loopback,
 * the Nix daemon, and host `devpts`/controlling-terminal semantics. A lane that needs one cannot be
 * contained, so it must run on the explicit no-containment executor.
 */
export const buck2HostServiceCapabilities = ['loopback', 'network', 'nix-daemon', 'pty'] as const

export type Buck2HostServiceCapability = (typeof buck2HostServiceCapabilities)[number]

export type Buck2TestCapability = Buck2HostServiceCapability | 'subprocess'

export type Buck2JavaScriptTestTarget = {
  readonly name: string
  readonly runner: 'vitest' | 'bun'
  readonly config?: string
  readonly testFiles?: readonly string[]
  readonly excludes?: readonly string[]
  readonly timeoutMs?: number
  readonly hookTimeoutMs?: number
  readonly env?: Readonly<Record<string, string>>
  readonly externalInputs?: Readonly<Record<string, string>>
  /** Host environment names forwarded only by explicitly non-cacheable local test lanes. */
  readonly inheritedEnv?: readonly string[]
  /** Exact immutable host paths read from `[test_capabilities]` Buck config keys. */
  readonly configuredExternalInputs?: Readonly<Record<string, string>>
  /**
   * Environment name -> attested capability tool id. The rule binds the capability's exact
   * executable to that name and joins its complete Nix closure to the sandbox read roots, which
   * is what a bare `[test_capabilities]` path cannot express.
   */
  readonly tools?: Readonly<Record<string, string>>
  /** Scratch-relative writable directories exposed through environment variables. */
  readonly writableDirectories?: Readonly<Record<string, string>>
  /**
   * Declared executor boundaries. Every member of `buck2HostServiceCapabilities` names a host
   * service containment removes, so those are admissible only on the unsandboxed local lane.
   */
  readonly capabilities?: readonly Buck2TestCapability[]
  /**
   * Which executor runs the lane. `unsandboxed-local` is a deliberate, non-cacheable host-service
   * lane, never an implicit sandbox bypass: it must declare a host-service capability.
   */
  readonly executionMode?: 'sandboxed' | 'unsandboxed-local'
  /**
   * Which runtime evaluates a Vitest suite. Pinned Bun is the default; `node` is for a suite
   * whose native addon is only correct on Node's event loop, and it requires a declared
   * `NODE_BIN` tool so the exact executable stays attested.
   */
  readonly vitestRuntime?: 'bun' | 'node'
  readonly cacheable?: boolean
  readonly labels?: readonly string[]
}

export type Buck2JavaScriptTestPlan = {
  readonly targets: readonly Buck2JavaScriptTestTarget[]
  readonly blockers?: readonly Buck2JavaScriptTestBlocker[]
}

export type Buck2JavaScriptTestProjectionMetadata = {
  readonly packageName: string
  readonly targets: readonly Buck2JavaScriptTestTarget[]
  readonly blockers: readonly Buck2JavaScriptTestBlocker[]
}

const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

const starlarkString = (value: string): string => JSON.stringify(value)

const starlarkList = (values: readonly string[]): string =>
  `[${values.map(starlarkString).join(', ')}]`

const starlarkDict = (values: Readonly<Record<string, string>>): string =>
  `{${Object.entries(values)
    .toSorted(([left], [right]) => compare(left, right))
    .map(([key, value]) => `${starlarkString(key)}: ${starlarkString(value)}`)
    .join(', ')}}`

const starlarkConfiguredInputs = (values: Readonly<Record<string, string>>): string =>
  `{${Object.entries(values)
    .toSorted(([left], [right]) => compare(left, right))
    .map(
      ([name, key]) =>
        `${starlarkString(name)}: read_config("test_capabilities", ${starlarkString(key)}, "")`,
    )
    .join(', ')}}`

const requireRelativePath = (value: string, field: string): string => {
  if (
    value.length === 0 ||
    value.startsWith('/') === true ||
    value.includes('\\') === true ||
    value.split('/').some((part) => part === '' || part === '.' || part === '..') === true
  ) {
    throw new Error(`${field} must be a normalized portable relative path: ${value}`)
  }
  return value
}

const renderTarget = (target: Buck2JavaScriptTestTarget): string => {
  if (/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u.test(target.name) === false) {
    throw new Error(`Unsafe Buck JavaScript test target name: ${target.name}`)
  }
  const testFiles = (target.testFiles ?? []).map((path) => requireRelativePath(path, 'test'))
  const excludes = (target.excludes ?? []).map((path) => requireRelativePath(path, 'exclude'))
  const configuredExternalInputs = target.configuredExternalInputs ?? {}
  for (const [name, key] of Object.entries(configuredExternalInputs)) {
    if (/^[A-Z_][A-Z0-9_]*$/u.test(name) === false) {
      throw new Error(`Unsafe configured external input environment name: ${name}`)
    }
    if (/^[a-z][a-z0-9_-]*$/u.test(key) === false) {
      throw new Error(`Unsafe test capability config key: ${key}`)
    }
  }
  const tools = target.tools ?? {}
  for (const [name, toolId] of Object.entries(tools)) {
    if (/^[A-Z_][A-Z0-9_]*$/u.test(name) === false) {
      throw new Error(`Unsafe tool environment name: ${name}`)
    }
    if (/^[a-z][a-z0-9-]*$/u.test(toolId) === false) {
      throw new Error(`Unsafe capability tool id: ${toolId}`)
    }
  }
  const writableDirectories = target.writableDirectories ?? {}
  for (const [name, directory] of Object.entries(writableDirectories)) {
    if (/^[A-Z_][A-Z0-9_]*$/u.test(name) === false) {
      throw new Error(`Unsafe writable directory environment name: ${name}`)
    }
    requireRelativePath(directory, 'writable directory')
  }
  const hostServices = buck2HostServiceCapabilities.filter((capability) =>
    (target.capabilities ?? []).includes(capability),
  )
  const executionMode = target.executionMode ?? 'sandboxed'
  if (hostServices.length > 0 && executionMode !== 'unsandboxed-local') {
    throw new Error(
      `Target ${target.name} declares host-service capabilities ${hostServices.join(', ')}, which require executionMode 'unsandboxed-local'`,
    )
  }
  if (executionMode === 'unsandboxed-local') {
    if (hostServices.length === 0) {
      throw new Error(
        `Unsandboxed local target ${target.name} must declare the host service it needs, not bypass containment`,
      )
    }
    if (target.cacheable !== false) {
      throw new Error(`Unsandboxed local target ${target.name} must be non-cacheable`)
    }
    if ((target.labels ?? []).includes('local-only') === false) {
      throw new Error(`Unsandboxed local target ${target.name} must carry the local-only label`)
    }
  }
  if ((target.inheritedEnv?.length ?? 0) > 0 && target.cacheable !== false) {
    throw new Error(`Inherited-environment target ${target.name} must be non-cacheable`)
  }
  const vitestRuntime = target.vitestRuntime ?? 'bun'
  if (vitestRuntime === 'node') {
    if (target.runner !== 'vitest') {
      throw new Error(`Target ${target.name} declares vitestRuntime but does not run Vitest`)
    }
    if (tools['NODE_BIN'] === undefined) {
      throw new Error(
        `Target ${target.name} runs Vitest on Node and must declare the NODE_BIN tool that names it`,
      )
    }
  }
  const lines = [
    `${target.runner === 'vitest' ? 'vitest_test' : 'bun_test'}(`,
    `    name = ${starlarkString(target.name)},`,
    '    package_tree = ":package_tree",',
  ]
  if (target.runner === 'vitest') {
    lines.push(`    config = ${starlarkString(target.config ?? 'vitest.config.ts')},`)
    lines.push(`    hook_timeout_ms = ${target.hookTimeoutMs ?? 30_000},`)
  }
  lines.push(`    timeout_ms = ${target.timeoutMs ?? 30_000},`)
  if (testFiles.length > 0) lines.push(`    test_files = ${starlarkList(testFiles)},`)
  if (excludes.length > 0) lines.push(`    excludes = ${starlarkList(excludes)},`)
  if (target.env !== undefined) lines.push(`    env = ${starlarkDict(target.env)},`)
  if (target.externalInputs !== undefined) {
    lines.push(`    external_inputs = ${starlarkDict(target.externalInputs)},`)
  }
  if (Object.keys(configuredExternalInputs).length > 0) {
    lines.push(
      `    configured_external_inputs = ${starlarkConfiguredInputs(configuredExternalInputs)},`,
    )
  }
  if (Object.keys(tools).length > 0) {
    lines.push(
      `    tools = ${starlarkDict(
        Object.fromEntries(
          Object.entries(tools).map(([name, toolId]) => [
            name,
            `//buck2/toolchains:tool_${toolId.replaceAll('-', '_')}`,
          ]),
        ),
      )},`,
    )
  }
  if (target.inheritedEnv !== undefined) {
    lines.push(`    inherited_env = ${starlarkList(target.inheritedEnv)},`)
  }
  if (Object.keys(writableDirectories).length > 0) {
    lines.push(`    writable_directories = ${starlarkDict(writableDirectories)},`)
  }
  if (target.capabilities !== undefined) {
    lines.push(`    capabilities = ${starlarkList(target.capabilities)},`)
  }
  if (executionMode !== 'sandboxed') {
    lines.push(`    execution_mode = ${starlarkString(executionMode)},`)
  }
  if (vitestRuntime !== 'bun') {
    lines.push(`    vitest_runtime = ${starlarkString(vitestRuntime)},`)
  }
  if (target.cacheable === false) lines.push('    cacheable = False,')
  if (target.labels !== undefined) lines.push(`    labels = ${starlarkList(target.labels)},`)
  lines.push('    visibility = ["PUBLIC"],', ')')
  return lines.join('\n')
}

const stageConfigs = (output: string, targets: readonly Buck2JavaScriptTestTarget[]): string => {
  const configs = [
    ...new Set(
      targets
        .filter((target) => target.runner === 'vitest')
        .map((target) => requireRelativePath(target.config ?? 'vitest.config.ts', 'config')),
    ),
  ].toSorted(compare)
  if (configs.length === 0) return output
  const marker = '    files = {\n'
  const offset = output.indexOf(marker)
  if (offset < 0) throw new Error('TypeScript package projection has no package_tree files mapping')
  const entries = configs.map((config) => `        ${starlarkString(config)}: ${starlarkString(config)},\n`).join('')
  return `${output.slice(0, offset + marker.length)}${entries}${output.slice(offset + marker.length)}`
}

/** Adds package-local Bun/Vitest targets without changing TypeScript projection authority. */
export const buck2JavaScriptPackageProjection = (
  admission: Buck2TypeScriptAdmission,
  plan: Buck2JavaScriptTestPlan,
): GenieOutput<unknown, Buck2JavaScriptTestProjectionMetadata> => {
  // A package-local suite is only runnable if its test sources are inside the declared package
  // view. Packages that keep suites in `test/` never listed that root for typecheck, so the
  // JavaScript targets adopt it here instead of duplicating source census in every admission.
  const testRoot = path.join(process.cwd(), admission.packagePath, 'test')
  const adoptTestRoot =
    plan.targets.length > 0 &&
    admission.sourceRoots.includes('test') === false &&
    existsSync(testRoot) === true &&
    statSync(testRoot).isDirectory() === true
  const projection = buck2TypeScriptPackageProjection(
    adoptTestRoot === true
      ? { ...admission, sourceRoots: [...admission.sourceRoots, 'test'] }
      : admission,
  )
  const runners = [...new Set(plan.targets.map(({ runner }) => `${runner}_test`))].toSorted(compare)
  return createGenieOutput({
    data: projection.data,
    meta: {
      packageName: admission.packageName,
      targets: plan.targets,
      blockers: plan.blockers ?? [],
    },
    ...(projection.validate === undefined ? {} : { validate: projection.validate }),
    stringify: (context) => {
      const projected = stageConfigs(projection.stringify(context), plan.targets)
      if (runners.length === 0) return projected
      const load = `load("//buck2:javascript.bzl", ${runners.map(starlarkString).join(', ')})`
      return `${load}\n${projected}\n${plan.targets.map(renderTarget).join('\n\n')}\n`
    },
  })
}
