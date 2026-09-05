import process from 'node:process'

import { describe, expect, it } from 'vitest'
import type { GenieContext } from '../../packages/@overeng/genie/src/runtime/core.ts'

import type { Buck2TypeScriptAdmission } from './typescript-admissions.ts'
import {
  buck2JavaScriptPackageProjection,
  type Buck2JavaScriptTestTarget,
} from './javascript-package-projection.ts'
import {
  javascriptTestTargetCensus,
  rootJavaScriptTestBlockers,
} from './javascript-test-targets.ts'

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
