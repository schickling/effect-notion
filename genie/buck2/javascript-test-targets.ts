import type {
  Buck2JavaScriptTestBlocker,
  Buck2JavaScriptTestPlan,
} from './javascript-package-projection.ts'

const ordinaryVitest = (): Buck2JavaScriptTestPlan => ({
  targets: [{ name: 'test', runner: 'vitest' }],
})

const packagePlans: Readonly<Record<string, Buck2JavaScriptTestPlan>> = {
  '@overeng/agent-session-ingest': {
    targets: [
      {
        name: 'test',
        runner: 'vitest',
        // The OpenCode adapter and its integration suite read session state through
        // `node:sqlite`, which pinned Bun does not implement. Node evaluates the suite through
        // the declared `NODE_BIN` so the exact executable stays attested.
        tools: { NODE_BIN: 'node' },
        vitestRuntime: 'node',
      },
    ],
  },
  '@overeng/buck2-tools': {
    targets: [
      {
        name: 'test',
        runner: 'bun',
        // The editor-view suite publishes real snapshots, so it drives real `cp` and `mv`, and
        // `FALSE_BIN` is the deterministic non-zero exit that proves the copy-failure path. These
        // are attested capabilities rather than `[test_capabilities]` paths because containment
        // binds a capability's whole Nix closure, not just the executable file.
        tools: { CP_BIN: 'coreutils-cp', FALSE_BIN: 'coreutils-false', MV_BIN: 'coreutils-mv' },
        capabilities: ['subprocess'],
        labels: ['local-only', 'native-tool'],
      },
    ],
  },
  '@overeng/ci-tools': {
    targets: [
      {
        name: 'test',
        runner: 'vitest',
        // The CLI contract and deploy e2e suites spawn the pinned Bun, and the fake
        // `netlify`/`vercel` binaries they write carry a `#!/usr/bin/env bash` shebang, so `env`
        // and `bash` are both driven. The live lanes are their own targets and are excluded here
        // rather than collected and self-skipped.
        tools: { BASH_BIN: 'test-bash', BUN_BIN: 'bun', ENV_BIN: 'coreutils-env' },
        capabilities: ['subprocess'],
        excludes: ['src/deploy-netlify.live.e2e.test.ts', 'src/deploy-vercel.live.e2e.test.ts'],
      },
      {
        name: 'test_netlify_live',
        runner: 'vitest',
        testFiles: ['src/deploy-netlify.live.e2e.test.ts'],
        env: { CI_TOOLS_NETLIFY_LIVE: '1' },
        inheritedEnv: ['NETLIFY_AUTH_TOKEN', 'NETLIFY_SITE_ID'],
        configuredExternalInputs: { CI_TOOLS_LIVE_NETLIFY_BIN: 'netlify' },
        tools: { BUN_BIN: 'bun' },
        capabilities: ['network', 'subprocess'],
        executionMode: 'unsandboxed-local',
        writableDirectories: { CI_TOOLS_LIVE_WORKSPACE: 'netlify' },
        cacheable: false,
        labels: ['local-only', 'live', 'network', 'secret'],
        timeoutMs: 300_000,
      },
      {
        name: 'test_vercel_live',
        runner: 'vitest',
        testFiles: ['src/deploy-vercel.live.e2e.test.ts'],
        env: { CI_TOOLS_VERCEL_LIVE: '1' },
        inheritedEnv: ['VERCEL_TOKEN', 'VERCEL_PROJECT_ID', 'VERCEL_ORG_ID', 'VERCEL_SCOPE'],
        configuredExternalInputs: { CI_TOOLS_LIVE_VERCEL_BIN: 'vercel' },
        tools: { BUN_BIN: 'bun' },
        capabilities: ['network', 'subprocess'],
        executionMode: 'unsandboxed-local',
        writableDirectories: { CI_TOOLS_LIVE_WORKSPACE: 'vercel' },
        cacheable: false,
        labels: ['local-only', 'live', 'network', 'secret'],
        timeoutMs: 300_000,
      },
    ],
  },
  '@overeng/content-address': ordinaryVitest(),
  '@overeng/effect-ai-claude-cli': ordinaryVitest(),
  '@overeng/effect-distributed-lock': ordinaryVitest(),
  '@overeng/effect-path': ordinaryVitest(),
  '@overeng/effect-react': ordinaryVitest(),
  '@overeng/effect-rpc-tanstack': ordinaryVitest(),
  'effect-rpc-tanstack-example-basic': {
    targets: [],
    blockers: [
      {
        surface: 'test:e2e',
        reason: 'This package test script is a Playwright browser suite, not a Vitest or Bun unit suite.',
        unblockedBy: 'Consume the dedicated Playwright Buck rule and its pinned browser capability.',
      },
    ],
  },
  '@overeng/effect-schema-form': ordinaryVitest(),
  '@overeng/effect-schema-form-aria': ordinaryVitest(),
  '@overeng/genie': {
    targets: [
      {
        name: 'test',
        runner: 'vitest',
        // `git` for repository discovery, the pinned Bun for the CLI/build probes, and
        // `env` + `bash` for the fake `tsc` the package-json suite writes and executes.
        // `rustfmt` and `rustc` make the emitted-Rust assertions run instead of self-skipping.
        // `tsgo` is the real compiler behind the package-json strict export proof, which
        // type-checks this package's own runtime entry.
        tools: {
          BASH_BIN: 'test-bash',
          BUN_BIN: 'bun',
          ENV_BIN: 'coreutils-env',
          GIT_BIN: 'test-git',
          RUSTC_BIN: 'rust-compiler',
          RUSTFMT_BIN: 'test-rustfmt',
          TSGO_BIN: 'effect-tsgo',
        },
        capabilities: ['subprocess'],
        // These two suites assert over repository-root generator sources, generated
        // workflows, emitted CI scripts and devenv task modules, and they load some of
        // them by their repository paths. Their inputs are the repository layout, not this
        // package, so they run in the root-layout suite (`rootTestRepositoryContractModules`
        // in genie/buck2/root-test-layout.ts) and are excluded here rather than reaching
        // out of the package view at runtime.
        excludes: [
          'src/runtime/github-workflow/ci-runtime-scripts.unit.test.ts',
          'src/runtime/github-workflow/ci-workflow-helpers.unit.test.ts',
        ],
      },
    ],
  },
  '@overeng/kdl': ordinaryVitest(),
  '@overeng/kdl-effect': ordinaryVitest(),
  '@overeng/megarepo': {
    targets: [
      {
        name: 'test',
        runner: 'vitest',
        excludes: [
          'src/cli/store-gc-cold.integration.test.ts',
          // Capability GC roots can only be proven against the live local store: registration
          // goes through the Nix daemon and the proof reads the store's own root registry under
          // `/nix/var/nix`, which the sandbox deliberately does not bind (an absent
          // `/nix/var/nix` makes Nix fall back to a chroot store where no real store path is
          // valid). It runs in the host-store lane below.
          'src/composition/capabilities/capability-gc-roots.integration.test.ts',
        ],
        // Composition drives real `cp`/`mv` reflink and exchange semantics, `git` object
        // memory, `nix` and `grep` for capability resolution, `script` + `stty` for the PTY
        // prompt suite, `otelite` for the store-GC trace assertions, and the pinned Bun for
        // the CLI contract. `bash` is also the shell the composition fixtures are written
        // against, so no fixture may name `/bin/sh`.
        tools: {
          BASH_BIN: 'test-bash',
          BUN_BIN: 'bun',
          CP_BIN: 'coreutils-cp',
          GIT_BIN: 'test-git',
          GREP_BIN: 'test-grep',
          MV_BIN: 'coreutils-mv',
          NIX_BIN: 'test-nix',
          OTELITE_BIN: 'test-otelite',
          SCRIPT_BIN: 'test-script',
          STTY_BIN: 'coreutils-stty',
        },
        capabilities: ['subprocess'],
      },
      {
        name: 'test_megarepo_cold_gc',
        runner: 'vitest',
        testFiles: ['src/cli/store-gc-cold.integration.test.ts'],
        tools: { GIT_BIN: 'test-git' },
        capabilities: ['subprocess'],
        writableDirectories: { MEGAREPO_STORE: 'megarepo-store' },
        timeoutMs: 300_000,
        hookTimeoutMs: 300_000,
        labels: ['local-only', 'native-tool'],
      },
      {
        // Nix-daemon lane. GC-root registration goes through the daemon socket and the proof
        // reads the store's own root registry under `/nix/var/nix`; both are host services that
        // containment removes rather than inputs a sandbox could bind, so this lane declares
        // `nix-daemon` and runs on the explicit no-containment executor.
        name: 'test_megarepo_capability_gc_roots',
        runner: 'vitest',
        testFiles: ['src/composition/capabilities/capability-gc-roots.integration.test.ts'],
        tools: {
          BASH_BIN: 'test-bash',
          CP_BIN: 'coreutils-cp',
          MV_BIN: 'coreutils-mv',
          NIX_BIN: 'test-nix',
        },
        capabilities: ['nix-daemon', 'subprocess'],
        executionMode: 'unsandboxed-local',
        cacheable: false,
        timeoutMs: 600_000,
        hookTimeoutMs: 600_000,
        labels: ['local-only', 'live', 'nix-daemon'],
      },
    ],
  },
  '@overeng/notion-cli': {
    targets: [
      {
        name: 'test',
        runner: 'vitest',
        tools: { BUN_BIN: 'bun' },
        capabilities: ['subprocess'],
      },
    ],
  },
  '@overeng/notion-core': ordinaryVitest(),
  '@overeng/notion-datasource-sync': {
    targets: [
      {
        name: 'test',
        runner: 'vitest',
        // The store, replica, and export layers are built on `node:sqlite`, which pinned Bun does
        // not implement. Node evaluates the suite through the declared `NODE_BIN` so the exact
        // executable stays attested.
        tools: { NODE_BIN: 'node' },
        vitestRuntime: 'node',
        excludes: ['src/e2e/live-notion.e2e.test.ts'],
      },
      {
        name: 'test_notion_live',
        runner: 'vitest',
        testFiles: ['src/e2e/live-notion.e2e.test.ts'],
        env: { NOTION_DATASOURCE_SYNC_LIVE: '1' },
        inheritedEnv: ['NOTION_API_TOKEN', 'NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID'],
        writableDirectories: { NOTION_DATASOURCE_SYNC_LEDGER_PATH: 'notion-ledger/ledger.json' },
        capabilities: ['network'],
        executionMode: 'unsandboxed-local',
        cacheable: false,
        labels: ['local-only', 'live', 'network', 'secret'],
        timeoutMs: 300_000,
        hookTimeoutMs: 300_000,
      },
    ],
  },
  '@overeng/notion-effect-client': {
    targets: [
      {
        name: 'test',
        runner: 'vitest',
        // `otelite-span-shape` captures a trace with the real `otelite` binary.
        tools: { OTELITE_BIN: 'test-otelite' },
        capabilities: ['subprocess'],
      },
      {
        name: 'test_notion_live',
        runner: 'vitest',
        config: 'vitest.integration.config.ts',
        inheritedEnv: ['NOTION_API_TOKEN', 'NOTION_TEST_PARENT_PAGE_ID'],
        capabilities: ['network'],
        executionMode: 'unsandboxed-local',
        cacheable: false,
        labels: ['local-only', 'live', 'network', 'secret'],
        timeoutMs: 120_000,
        hookTimeoutMs: 120_000,
      },
    ],
  },
  '@overeng/notion-effect-schema': ordinaryVitest(),
  '@overeng/notion-md': {
    targets: [
      {
        name: 'test',
        runner: 'vitest',
        // The sync and editor-observability suites capture traces with the real `otelite`,
        // and the CLI boundary suite runs the CLI under the pinned Bun.
        tools: { BUN_BIN: 'bun', OTELITE_BIN: 'test-otelite' },
        capabilities: ['subprocess'],
      },
      {
        name: 'test_notion_live',
        runner: 'vitest',
        config: 'vitest.integration.config.ts',
        inheritedEnv: ['NOTION_API_TOKEN', 'NOTION_TEST_PARENT_PAGE_ID'],
        capabilities: ['network'],
        executionMode: 'unsandboxed-local',
        cacheable: false,
        labels: ['local-only', 'live', 'network', 'secret'],
        timeoutMs: 120_000,
        hookTimeoutMs: 120_000,
      },
    ],
  },
  '@overeng/notion-property-write': ordinaryVitest(),
  '@overeng/notion-react': {
    targets: [
      { name: 'test', runner: 'vitest' },
      {
        name: 'test_notion_live',
        runner: 'vitest',
        config: 'vitest.integration.config.ts',
        inheritedEnv: ['NOTION_API_TOKEN', 'NOTION_TEST_PARENT_PAGE_ID'],
        capabilities: ['network'],
        executionMode: 'unsandboxed-local',
        cacheable: false,
        labels: ['local-only', 'live', 'network', 'secret'],
        timeoutMs: 120_000,
        hookTimeoutMs: 120_000,
      },
    ],
  },
  '@overeng/npm-release': {
    targets: [
      {
        name: 'test',
        runner: 'vitest',
        tools: { BUN_BIN: 'bun' },
        capabilities: ['subprocess'],
      },
    ],
  },
  '@overeng/otel-contract': {
    targets: [
      {
        name: 'test',
        runner: 'vitest',
        // The profile-link suite runs the real `otelite` and `otel-scrape` binaries, and
        // `otel-scrape` launches a Node child under capture, so the pinned Node is declared
        // too. `registry-seam` and `raw-otel-boundary` assert over the whole repository and
        // run in the root-layout suite; the weaver check is its own live lane.
        tools: {
          NODE_BIN: 'node',
          OTELITE_BIN: 'test-otelite',
          OTEL_SCRAPE_BIN: 'test-otel-scrape',
        },
        capabilities: ['subprocess'],
        excludes: [
          'src/raw-otel-boundary.unit.test.ts',
          'src/registry-live-check.integration.test.ts',
          'src/registry-seam.unit.test.ts',
        ],
      },
      {
        name: 'weaver_live_check',
        runner: 'vitest',
        testFiles: ['src/registry-live-check.integration.test.ts'],
        configuredExternalInputs: {
          WEAVER_BIN: 'weaver',
          WEAVER_REGISTRY_DIR: 'weaver-registry',
          WEAVER_SEMCONV_MODEL: 'weaver-semconv-model',
        },
        // The live check also captures its own trace through the real `otelite`.
        tools: { OTELITE_BIN: 'test-otelite' },
        capabilities: ['loopback', 'subprocess'],
        executionMode: 'unsandboxed-local',
        cacheable: false,
        labels: ['local-only', 'live', 'native-tool'],
        timeoutMs: 120_000,
      },
    ],
  },
  '@overeng/oxc-config': ordinaryVitest(),
  '@overeng/pty-effect': {
    targets: [
      {
        name: 'test',
        runner: 'vitest',
        // The Nix-built `node-pty` addon arrives through the normalized pnpm store: the shared
        // `node-pty@1.1.0` entry is grafted from `[test_capabilities] node-pty`, so every
        // importer and alias (here `@myobie/pty`) resolves the built addon from one copy. The
        // lane must therefore be run with that capability declared. Every executable the suite
        // launches is an attested capability: `[test_capabilities]` binds only the file, never
        // its closure.
        tools: {
          BUN_BIN: 'bun',
          CAT_BIN: 'coreutils-cat',
          NODE_BIN: 'node',
          SHELL_BIN: 'test-sh',
        },
        // In-process `node-pty` sessions are only reliable on Node's own event loop: under Bun
        // just the first session in a process observes its master-fd reads, so every later
        // spawn-mode screenshot comes back empty and `waitForText` hangs. Node evaluates the
        // suite; the daemon lane already routes itself through the same declared `NODE_BIN`.
        vitestRuntime: 'node',
        // The suite drives real PTYs: `forkpty` needs the host's `devpts` and a controlling
        // terminal, and the daemon lane binds a unix socket it later reopens. Containment removes
        // exactly those, which surfaces as `execvp` failures, `ENXIO` on the socket, and hanging
        // `waitForText` reads rather than as a missing input, so this is a declared host-service
        // lane on the explicit no-containment executor.
        capabilities: ['pty', 'subprocess'],
        executionMode: 'unsandboxed-local',
        cacheable: false,
        labels: ['local-only', 'live', 'native-addon'],
      },
    ],
  },
  '@overeng/react-inspector': ordinaryVitest(),
  '@overeng/restate-effect': {
    targets: [
      {
        name: 'test',
        runner: 'vitest',
        excludes: ['src/scheduling/scheduled-durability.integration.test.ts'],
      },
      {
        name: 'test_restate_integration',
        runner: 'vitest',
        testFiles: ['src'],
        configuredExternalInputs: { RESTATE_SERVER_BIN: 'restate-server' },
        capabilities: ['loopback', 'subprocess'],
        executionMode: 'unsandboxed-local',
        cacheable: false,
        labels: ['local-only', 'live', 'native-tool'],
        timeoutMs: 300_000,
        hookTimeoutMs: 300_000,
      },
    ],
  },
  '@overeng/tui-core': ordinaryVitest(),
  '@overeng/tui-react': {
    targets: [
      {
        name: 'test',
        runner: 'vitest',
        // The stdout-contract suites spawn both runtimes as separate processes.
        tools: { BUN_BIN: 'bun', NODE_BIN: 'node' },
        capabilities: ['subprocess'],
      },
    ],
  },
  '@overeng/tui-stories': {
    targets: [
      {
        name: 'test',
        runner: 'vitest',
        tools: { BUN_BIN: 'bun' },
        capabilities: ['subprocess'],
      },
    ],
  },
  '@overeng/utils': {
    targets: [
      {
        name: 'test',
        runner: 'vitest',
        // The otel identity/telemetry suites capture traces with the real `otelite`, and the
        // `cmd`/`cmdCollect` suites run real children: the pinned Bun plus `echo`/`printf`.
        tools: {
          BUN_BIN: 'bun',
          ECHO_BIN: 'coreutils-echo',
          OTELITE_BIN: 'test-otelite',
          PRINTF_BIN: 'coreutils-printf',
        },
        capabilities: ['subprocess'],
      },
    ],
  },
  '@overeng/utils-dev': {
    targets: [
      {
        name: 'test',
        runner: 'vitest',
        // The trace-assertion helpers run the real `otelite` capture binary, and the suite
        // launches child processes under capture (`true`, `false`, a Bun emitter) plus `ps`
        // for the orphan-process assertion.
        tools: {
          BUN_BIN: 'bun',
          FALSE_BIN: 'coreutils-false',
          OTELITE_BIN: 'test-otelite',
          PS_BIN: 'test-procps',
          TRUE_BIN: 'coreutils-true',
        },
        capabilities: ['subprocess'],
      },
    ],
  },
}

/** Returns the exhaustive package-local candidate or fails when a test package was not classified. */
export const javascriptTestPlanFor = (packageName: string): Buck2JavaScriptTestPlan =>
  packagePlans[packageName] ??
  (() => {
    throw new Error(`No Buck JavaScript test plan for ${packageName}`)
  })()

export const rootJavaScriptTestBlockers: readonly Buck2JavaScriptTestBlocker[] = [
  {
    surface: 'devenv-modules:test',
    reason:
      'The install-free Buck target needs immutable Nix, bash, module-source, and module-tool closures supplied by its caller.',
    unblockedBy:
      'Supply those four paths through [test_capabilities]; no node_modules input is required.',
  },
]

export const javascriptTestTargetCensus = Object.entries(packagePlans)
  .flatMap(([packageName, plan]) =>
    plan.targets.map((target) => ({
      label: `//packages/@overeng/${packageName.slice('@overeng/'.length)}:${target.name}`,
      packageName,
      runner: target.runner,
    })),
  )
  .toSorted((left, right) => Buffer.from(left.label).compare(Buffer.from(right.label)))
