import { readFileSync } from 'node:fs'
import process from 'node:process'

import { describe, expect, it } from 'vitest'

import type { GenieContext } from '../../packages/@overeng/genie/src/runtime/core.ts'
import {
  buck2JavaScriptPackageProjection,
  type Buck2JavaScriptTestTarget,
} from './javascript-package-projection.ts'
import {
  javascriptTestTargetCensus,
  rootJavaScriptTestBlockers,
} from './javascript-test-targets.ts'
import type { Buck2TypeScriptAdmission } from './typescript-admissions.ts'

const admission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_buck2_tools_e521acf736cf',
  packageName: '@overeng/fixture',
  packagePath: 'packages/@overeng/buck2-tools',
  projectionSource: 'packages/@overeng/buck2-tools/BUCK.genie.ts',
  sourceFiles: ['src/mod.ts'],
  sourceRoots: [],
  authority: {
    declarationEntrypoint: 'src/mod.d.ts',
    projectFile: 'tsconfig.json',
  },
} as const satisfies Buck2TypeScriptAdmission

const genieContext: GenieContext = { cwd: process.cwd(), location: '' }

describe('buck2JavaScriptPackageProjection', () => {
  it('adds config inputs and deterministic Vitest targets without changing TypeScript data', () => {
    const projection = buck2JavaScriptPackageProjection(admission, {
      targets: [
        {
          name: 'test',
          runner: 'vitest',
          config: 'vitest.config.ts',
          excludes: ['src/live.integration.test.ts'],
        },
      ],
    })
    const rendered = projection.stringify(genieContext)

    expect(rendered).toContain('load("//buck2:javascript.bzl", "vitest_test")')
    expect(rendered).toContain('"vitest.config.ts": "vitest.config.ts",')
    expect(rendered).toContain('vitest_test(\n    name = "test",')
    expect(rendered).toContain('excludes = ["src/live.integration.test.ts"],')
    expect(projection.data).toBeDefined()
  })

  it('renders pinned Bun suites and exposes blockers only as metadata', () => {
    const projection = buck2JavaScriptPackageProjection(admission, {
      targets: [{ name: 'test', runner: 'bun', testFiles: ['src/a.test.ts'] }],
      blockers: [
        {
          surface: 'test:live',
          reason: 'requires an outbound-network executor and a runtime credential channel',
          unblockedBy: 'Project both capabilities into a non-cacheable executor.',
        },
      ],
    })
    const rendered = projection.stringify(genieContext)

    expect(rendered).toContain('load("//buck2:javascript.bzl", "bun_test")')
    expect(rendered).toContain('bun_test(\n    name = "test",')
    expect(rendered).not.toContain('test:live')
    expect(projection.meta.blockers).toHaveLength(1)
  })

  it('projects the deliberate host-service lane as an explicit unsandboxed local executor', () => {
    const rendered = buck2JavaScriptPackageProjection(admission, {
      targets: [
        {
          name: 'test_nix_daemon',
          runner: 'vitest',
          testFiles: ['src/gc-roots.integration.test.ts'],
          capabilities: ['nix-daemon', 'subprocess'],
          executionMode: 'unsandboxed-local',
          cacheable: false,
          labels: ['local-only', 'live', 'nix-daemon'],
        },
      ],
    }).stringify(genieContext)

    expect(rendered).toContain('capabilities = ["nix-daemon", "subprocess"],')
    expect(rendered).toContain('execution_mode = "unsandboxed-local",')
    expect(rendered).toContain('cacheable = False,')
  })

  it('keeps a deterministic lane free of any executor mode attribute', () => {
    const rendered = buck2JavaScriptPackageProjection(admission, {
      targets: [{ name: 'test', runner: 'vitest', capabilities: ['subprocess'] }],
    }).stringify(genieContext)

    expect(rendered).not.toContain('execution_mode')
  })

  it('refuses every invalid executor-mode combination before it can reach a BUCK file', () => {
    const project = (target: Buck2JavaScriptTestTarget): string =>
      buck2JavaScriptPackageProjection(admission, { targets: [target] }).stringify(genieContext)
    const lane = {
      name: 'test_host_service',
      runner: 'vitest',
      cacheable: false,
      labels: ['local-only'],
    } as const satisfies Buck2JavaScriptTestTarget

    // A host-service capability may never resolve to the sandboxed executor.
    expect(() => project({ ...lane, capabilities: ['nix-daemon'] })).toThrow(
      "which require executionMode 'unsandboxed-local'",
    )
    expect(() =>
      project({ ...lane, capabilities: ['loopback'], executionMode: 'sandboxed' }),
    ).toThrow("which require executionMode 'unsandboxed-local'")
    // The unsandboxed executor is a declared host-service lane, never a bare sandbox bypass.
    expect(() =>
      project({ ...lane, capabilities: ['subprocess'], executionMode: 'unsandboxed-local' }),
    ).toThrow('must declare the host service it needs')
    // An unsandboxed observation of host state can never be a shared cache entry.
    expect(() =>
      project({
        ...lane,
        capabilities: ['network'],
        executionMode: 'unsandboxed-local',
        cacheable: true,
      }),
    ).toThrow('must be non-cacheable')
    expect(() =>
      project({
        ...lane,
        capabilities: ['nix-daemon'],
        executionMode: 'unsandboxed-local',
        labels: [],
      }),
    ).toThrow('must carry the local-only label')
  })

  it('binds the Node Vitest runtime to a declared NODE_BIN tool and leaves Bun implicit', () => {
    const project = (target: Buck2JavaScriptTestTarget): string =>
      buck2JavaScriptPackageProjection(admission, { targets: [target] }).stringify(genieContext)

    const rendered = project({
      name: 'test',
      runner: 'vitest',
      tools: { NODE_BIN: 'node' },
      vitestRuntime: 'node',
    })
    expect(rendered).toContain('vitest_runtime = "node",')
    expect(rendered).toContain('tools = {"NODE_BIN": "//buck2/toolchains:tool_node"},')

    // Pinned Bun is the default, so it never names a runtime attribute.
    expect(project({ name: 'test', runner: 'vitest' })).not.toContain('vitest_runtime')

    // Node is attested or nothing: the runtime may not resolve through an ambient PATH.
    expect(() => project({ name: 'test', runner: 'vitest', vitestRuntime: 'node' })).toThrow(
      'must declare the NODE_BIN tool that names it',
    )
    expect(() =>
      project({
        name: 'test',
        runner: 'bun',
        tools: { NODE_BIN: 'node' },
        vitestRuntime: 'node',
      }),
    ).toThrow('does not run Vitest')
  })

  it('publishes the aggregate package target census and root-suite blockers', () => {
    expect(javascriptTestTargetCensus).toHaveLength(44)
    expect(
      javascriptTestTargetCensus.some(
        ({ label }) => label === '//packages/@overeng/megarepo:test_megarepo_capability_gc_roots',
      ),
    ).toBe(true)
    expect(javascriptTestTargetCensus[0]?.label).toBe(
      '//packages/@overeng/agent-session-ingest:test',
    )
    expect(javascriptTestTargetCensus.some(({ label }) => label.endsWith('/pty-effect:test'))).toBe(
      true,
    )
    expect(rootJavaScriptTestBlockers.map(({ surface }) => surface)).toEqual([
      'devenv-modules:test',
    ])
  })
})

describe('buck2/javascript.bzl test cache participation', () => {
  const javascriptRule = readFileSync('buck2/javascript.bzl', 'utf8')
  const platformDefs = readFileSync('buck2/platforms/defs.bzl', 'utf8')

  it('gates every test-executor cache switch on the root policy, not on the target attr alone', () => {
    // `mr apply` materializes `[buck2] remote_cache_enabled = false` into the synthesized
    // root before the first overlay action, and CI runs that way with NO RE engine
    // configured. Execution platforms already consult that switch, but
    // `ExternalRunnerTestInfo` carries its own executor: a rule that reads only `cacheable`
    // asks for action-cache lookup and test-execution caching against an engine that does
    // not exist, and the test dies with `No engine address`.
    expect(platformDefs).toContain('def root_remote_cache_enabled():')
    expect(platformDefs).toContain('def root_allow_cache_uploads():')
    expect(javascriptRule).toContain(
      'load("//buck2/platforms:defs.bzl", "root_allow_cache_uploads", "root_remote_cache_enabled")',
    )
    expect(javascriptRule).toContain(
      'cache_enabled = ctx.attrs.cacheable and root_remote_cache_enabled()',
    )
    expect(javascriptRule).toContain(
      'cache_uploads = ctx.attrs.cacheable and root_allow_cache_uploads()',
    )
    for (const gated of [
      'remote_cache_enabled = cache_enabled,',
      'allow_cache_uploads = cache_uploads,',
      'supports_test_execution_caching = cache_enabled,',
    ]) {
      expect(javascriptRule).toContain(gated)
    }
    // No cache switch may be wired back to the target attribute, spelled either way: the
    // whole point is that participation is the AND of determinism and root policy, so
    // `= cacheable` and `= ctx.attrs.cacheable` are both the bug.
    expect(javascriptRule).not.toMatch(
      /(?:remote_cache_enabled|allow_cache_uploads|supports_test_execution_caching) = (?:ctx\.attrs\.)?cacheable\b/u,
    )
  })

  it('keeps determinism a target-only refusal that the root switch cannot soften', () => {
    // Root policy decides PARTICIPATION; it must never turn a non-reproducible lane into a
    // cacheable one, so both refusals stay on the raw attribute.
    expect(javascriptRule).toContain(
      'if (ctx.attrs.inherited_env or "network" in ctx.attrs.capabilities) and ctx.attrs.cacheable:',
    )
    expect(javascriptRule).toContain(
      'if ctx.attrs.execution_mode == "unsandboxed-local" and ctx.attrs.cacheable:',
    )
  })
})
