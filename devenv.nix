{
  pkgs,
  inputs,
  config,
  lib,
  ...
}:
let
  # `git+file://` and not a bare path: `builtins.getFlake (toString ./.)`
  # parses as a `path:` flakeref, which copies the entire working directory —
  # gitignored `.devenv/` included, 546 MB / 25,142 files against 18 MB / 2,746
  # for the git-tracked view — into the store on every eval, and re-copies it
  # whenever devenv writes its own state. Measured 82.4 s -> 14.6 s median on a
  # forced eval-cache miss.
  #
  # The assertion is the other half. `git+file://` needs `./.` to be a real
  # worktree, and #1190 is what happens when it is not: config evaluated from a
  # store-backed source has no `.git`, and this expression dies where a bare
  # path would have limped on.
  repoFlake =
    assert lib.assertMsg (builtins.pathExists (./. + "/.git")) ''
      devenv.nix: `repoFlake` needs `./.` to be a real git worktree, and
      ${toString ./.} has no `.git`.

      This is the #1190 regression: `builtins.getFlake "git+file://…"` is fine
      while `./.` is a checkout and fails the moment this file is evaluated
      from a store path. If you moved config evaluation onto a store-backed
      source, pass that source in explicitly rather than re-deriving it here.
    '';
    builtins.getFlake "git+file://${toString ./.}";
  currentSystem = pkgs.stdenv.hostPlatform.system;
  flakePkgs = import repoFlake.inputs.nixpkgs { system = currentSystem; };
  # `restate` ships under BSL-1.1; scope allowUnfree to just that package so the
  # rest of the closure stays free-only.
  restatePkgs = import repoFlake.inputs.nixpkgs {
    system = currentSystem;
    config.allowUnfreePredicate = pkg: builtins.elem (pkgs.lib.getName pkg) [ "restate" ];
  };
  restate = import ./nix/restate.nix { pkgs = restatePkgs; };
  cliBuildStamp = import ./nix/workspace-tools/lib/cli-build-stamp.nix { inherit pkgs; };
  # Use npm oxlint with NAPI bindings to enable JavaScript plugin support
  oxlintNpm = import ./nix/oxlint-npm.nix {
    pkgs = flakePkgs;
    bun = flakePkgs.bun;
    src = repoFlake;
  };
  oxlintWithPlugins = import ./nix/oxlint-with-plugins.nix {
    inherit pkgs oxlintNpm;
  };
  nodePtyNative = import ./nix/node-pty-native.nix { inherit pkgs; };
  # Nested weaver flake realizations, needed as explicit capabilities by the
  # non-cacheable Weaver live-check Buck lane.
  weaverFlake = builtins.getFlake "path:${toString ./nix/weaver-flake}";
  weaverPackages = weaverFlake.packages.${currentSystem};
  # The activated Devenv CLI, handed to the devenv-module Buck lane as data: its task-graph case
  # asserts the graph of *this* activation, which only the real CLI can enumerate.
  devenvCli = "${inputs.devenv.packages.${currentSystem}.devenv}/bin/devenv";
  pnpmTaskHelpersScript = pkgs.writeText "pnpm-task-helpers.sh" (
    builtins.readFile ./nix/devenv-modules/tasks/shared/pnpm-task-helpers.sh
  );
  rustCrates = [
    {
      name = "otelite";
      path = "packages/@overeng/otelite";
    }
    {
      name = "otel-scrape";
      path = "packages/@overeng/otel-scrape";
    }
  ];
  grep = "${pkgs.gnugrep}/bin/grep";
  head = "${pkgs.coreutils}/bin/head";
  rg = "${pkgs.ripgrep}/bin/rg";
  tail = "${pkgs.coreutils}/bin/tail";
  trace = import ./nix/devenv-modules/tasks/lib/trace.nix { inherit lib; };

  # Shared task modules (from shared/ directory)
  taskModules = {
    genie = ./nix/devenv-modules/tasks/shared/genie.nix;
    buck-editor = import ./nix/devenv-modules/tasks/shared/buck-editor.nix;
    worktree-guard = import ./nix/devenv-modules/tasks/shared/worktree-guard.nix;
    setup = import ./nix/devenv-modules/tasks/shared/setup.nix;
    check = import ./nix/devenv-modules/tasks/shared/check.nix;
    clean = import ./nix/devenv-modules/tasks/shared/clean.nix;
    test = import ./nix/devenv-modules/tasks/shared/test.nix;
    test-playwright = import ./nix/devenv-modules/tasks/shared/test-playwright.nix;
    storybook = import ./nix/devenv-modules/tasks/shared/storybook.nix;
    netlify = import ./nix/devenv-modules/tasks/shared/netlify.nix;
    workflow-report = import ./nix/devenv-modules/tasks/shared/workflow-report.nix;
    lint-genie = ./nix/devenv-modules/tasks/shared/lint-genie.nix;
    lint-nix = import ./nix/devenv-modules/tasks/shared/lint-nix.nix;
    lint-oxc = import ./nix/devenv-modules/tasks/shared/lint-oxc.nix;
    bun = import ./nix/devenv-modules/tasks/shared/bun.nix;
    pnpm = import ./nix/devenv-modules/tasks/shared/pnpm.nix;
    megarepo = import ./nix/devenv-modules/tasks/shared/megarepo.nix;
    nix-cli = import ./nix/devenv-modules/tasks/shared/nix-cli.nix;
    secretspec = import ./nix/devenv-modules/tasks/shared/secretspec.nix;
    bootstrap-closure = import ./nix/devenv-modules/tasks/shared/bootstrap-closure.nix;
    weaver = import ./nix/devenv-modules/tasks/shared/weaver.nix;
    weaver-diff = import ./nix/devenv-modules/tasks/shared/weaver-diff.nix;
    weaver-live-check = import ./nix/devenv-modules/tasks/shared/weaver-live-check.nix;
    weaver-version-smoke = import ./nix/devenv-modules/tasks/shared/weaver-version-smoke.nix;
    context = ./nix/devenv-modules/tasks/shared/context.nix;
    devenv-module-tests = ./nix/devenv-modules/tasks/local/devenv-module-tests.nix;
    asset-import-type-reference = ./nix/devenv-modules/tasks/local/asset-import-type-reference.nix;
  };
  # Repository CLIs are imported from the tracked Buck product boundary.

  # Real packages backing guarded command names. The cli-guards own bin/<name>
  # and exec these via absolute store path under passthrough, so they are passed
  # as `*Pkg` reals to the task modules instead of also being top-level profile
  # providers (which would collide with the guards in buildEnv). See cli-guard.nix.
  # Constructor, not a built derivation: building it here would force this
  # module's `pkgs` argument while devenv is still collecting `imports`
  # (infinite recursion through `_module.args`). See pnpm.nix `mkPnpmPkg`.
  mkPnpmPkg = import ./nix/pnpm.nix;
  genieCli = repoFlake.packages.${currentSystem}.genie;
  mrCli = repoFlake.packages.${currentSystem}.megarepo;
  ciToolsCli = repoFlake.packages.${currentSystem}.ci-tools;
  tuiStoriesCli = repoFlake.packages.${currentSystem}.tui-stories;
  buck2Machine = import ./nix/buck2.nix { pkgs = flakePkgs; };
  buck2Stage0Definition = import ./nix/buck2-stage0-tools.nix { inherit pkgs; };
  # Remaining Nix-managed external npm plugin hash.
  nixCliPackages = [
    {
      name = "oxlint-npm";
      flakeRef = ".#oxlint-npm";
      hashSource = "packages/@overeng/oxc-config/nix/build.nix";
      lockfile = "pnpm-lock.yaml";
      packageJson = "packages/@overeng/oxc-config/package.json";
    }
  ];

  # Explicit workspace members for the repo-root pnpm workspace.
  # NOTE: Using pnpm temporarily due to bun bugs. Plan to switch back once fixed.
  # See: context/workarounds/bun-issues.md
  allPackages = [
    "packages/@overeng/agent-session-ingest"
    "packages/@overeng/buck2-tools"
    "packages/@overeng/content-address"
    "packages/@overeng/utils"
    "packages/@overeng/utils-dev"
    "packages/@overeng/effect-ai-claude-cli"
    "packages/@overeng/effect-distributed-lock"
    "packages/@overeng/effect-path"
    "packages/@overeng/effect-react"
    "packages/@overeng/effect-rpc-tanstack"
    "packages/@overeng/effect-rpc-tanstack/examples/basic"
    "packages/@overeng/effect-schema-form"
    "packages/@overeng/effect-schema-form-aria"
    "packages/@overeng/genie"
    "packages/@overeng/kdl"
    "packages/@overeng/kdl-effect"
    "packages/@overeng/megarepo"
    "packages/@overeng/notion-cli"
    "packages/@overeng/notion-core"
    "packages/@overeng/notion-datasource-sync"
    "packages/@overeng/notion-effect-client"
    "packages/@overeng/notion-effect-schema"
    "packages/@overeng/notion-md"
    "packages/@overeng/notion-property-write"
    "packages/@overeng/notion-react"
    "packages/@overeng/npm-release"
    "packages/@overeng/otel-contract"
    "packages/@overeng/oxc-config"
    "packages/@overeng/pty-effect"
    "packages/@overeng/react-inspector"
    "packages/@overeng/restate-effect"
    "packages/@overeng/stylex-tokens"
    "packages/@overeng/tui-core"
    "packages/@overeng/tui-react"
    "packages/@overeng/tui-stories"
    "packages/@overeng/ci-tools"
    "context/opentui"
    "context/effect/socket"
  ];

  packageTestQuarantine = { };
  validatedPackageTestQuarantine = lib.mapAttrs (
    name: quarantine:
    if quarantine ? reason && quarantine ? issue then
      quarantine
    else
      throw "packageTestQuarantine.${name} must include reason and issue"
  ) packageTestQuarantine;
  # Buck targets own vitest selection and native inputs, so no per-package
  # legacy vitest argument or install-order override remains.
  packageTestOverrides = { };
  packagesRoot = ./. + "/packages/@overeng";
  hasTestFiles =
    root:
    let
      scan =
        dir:
        if builtins.pathExists dir then
          let
            entries = builtins.readDir dir;
            names = builtins.attrNames entries;
          in
          builtins.any (
            name:
            let
              entryType = entries.${name};
              child = dir + "/${name}";
            in
            if entryType == "regular" then
              builtins.match ".*\\.test\\.tsx?" name != null
            else if entryType == "directory" then
              scan child
            else
              false
          ) names
        else
          false;
    in
    scan (root + "/src") || scan (root + "/test");
  # Packages that have Vitest tests are discovered from the filesystem. If a
  # package with tests is excluded, it must be visible debt in packageTestQuarantine.
  packagesWithTests =
    let
      packageNames = builtins.filter (
        name:
        let
          root = packagesRoot + "/${name}";
        in
        (builtins.readDir packagesRoot).${name} == "directory"
        && builtins.pathExists (root + "/package.json")
        && hasTestFiles root
        && !(builtins.hasAttr name validatedPackageTestQuarantine)
      ) (builtins.attrNames (builtins.readDir packagesRoot));
    in
    map (
      name:
      {
        path = "packages/@overeng/${name}";
        inherit name;
      }
      // (packageTestOverrides.${name} or { })
    ) packageNames;
  baselineTestTaskRegistry = pkgs.writeText "effect4-baseline-test-task-registry.json" (
    builtins.toJSON (
      map (pkg: {
        packagePath = pkg.path;
        taskName = "test:${pkg.name}";
      }) packagesWithTests
    )
  );

  # Packages that have storybook (subset of allPackages)
  packagesWithStorybook = [
    {
      path = "packages/@overeng/tui-react";
      name = "tui-react";
      port = 6006;
    }
    {
      path = "packages/@overeng/megarepo";
      name = "megarepo";
      port = 6007;
    }
    {
      path = "packages/@overeng/genie";
      name = "genie";
      port = 6008;
    }
    {
      path = "packages/@overeng/effect-react";
      name = "effect-react";
      port = 6009;
    }
    {
      path = "packages/@overeng/effect-schema-form-aria";
      name = "effect-schema-form-aria";
      port = 6010;
    }
    {
      path = "packages/@overeng/react-inspector";
      name = "react-inspector";
      port = 6011;
    }
    {
      path = "packages/@overeng/notion-cli";
      name = "notion-cli";
      port = 6012;
    }
    {
      path = "packages/@overeng/tui-stories";
      name = "tui-stories";
      port = 6013;
    }
    {
      path = "packages/@overeng/notion-react";
      name = "notion-react";
      port = 6014;
    }
    {
      path = "packages/@overeng/notion-md";
      name = "notion-md";
      port = 6015;
    }
  ];
  packagesWithNetlifyPreview = lib.filter (pkg: pkg.name != "tui-stories") packagesWithStorybook;

  # Buck owns test execution. Ordinary package suites derive mechanically from
  # the discovered package set; a lane that needs an executable capability
  # declares it explicitly, and nothing resolves through a root node_modules.
  # `@overeng/buck2-tools:test` needs `cp`, `mv`, and `false`, but declares them as attested
  # capabilities in the Buck rule instead of here: containment binds a capability's whole Nix
  # closure, which a bare `[test_capabilities]` executable path cannot carry.
  packageTestCapabilities = {
    pty-effect = {
      "node-pty" = "${nodePtyNative}/node_modules/node-pty";
    };
  };
  buckTestTargets =
    map (pkg: {
      inherit (pkg) name;
      label = "effect_utils//${pkg.path}:test";
      capabilities = packageTestCapabilities.${pkg.name} or { };
    }) packagesWithTests
    ++ [
      {
        name = "devenv-modules";
        label = "effect_utils//nix/devenv-modules:test";
        # `bash`, `nix`, and the GNU tool bundle are attested capabilities declared by the Buck
        # rule, not bare paths: a capability binds its whole Nix closure, which a
        # `[test_capabilities]` executable path cannot carry. What remains here is the
        # activated-Devenv boundary, which is data rather than tooling: the checkout under test,
        # plus the activated CLI and worktree the task-graph case asserts against (a task graph
        # only exists in an activated worktree, and `devenv.nix` refuses to evaluate from an
        # immutable snapshot). These are configured values and not `inherited_env` because Buck
        # actions do not inherit daemon or client environment.
        capabilities = {
          "devenv-bin" = devenvCli;
          "devenv-module-source" = "${repoFlake}";
          "devenv-root" = config.devenv.root;
        };
      }
      {
        name = "genie-buck2";
        label = "effect_utils//genie/buck2:test";
        capabilities = { };
      }
      {
        name = "megarepo-cold-gc";
        label = "effect_utils//packages/@overeng/megarepo:test_megarepo_cold_gc";
        capabilities.git = "${pkgs.git}/bin/git";
      }
      {
        # Nix-daemon lane: the rule runs it on the explicit no-containment executor because
        # GC-root registration needs the daemon socket and the store's own root registry. Every
        # executable it launches is still an attested capability, so it declares no ambient path.
        name = "megarepo-capability-gc-roots";
        label = "effect_utils//packages/@overeng/megarepo:test_megarepo_capability_gc_roots";
        capabilities = { };
      }
    ];
  # Single source of truth for the Buck storybook publication target: the build
  # task and the Netlify deploy both address this label, so the deploy resolves
  # Buck's declared output instead of guessing a source-tree directory.
  storybookBuildLabel = pkg: "effect_utils//${pkg.path}:storybook_build_candidate";
  buckStorybookTargets = map (pkg: {
    inherit (pkg) name port;
    buildLabel = storybookBuildLabel pkg;
    devLabel = "effect_utils//${pkg.path}:storybook_dev_candidate";
  }) packagesWithStorybook;
  # Repository-specific semantic inputs read by Genie sources. The shared
  # Genie module already owns the direct and nested `.genie.ts` census; this
  # single list is composed into both its warm fingerprint and lint freshness.
  genieExtraInputGlobs = [
    "context/otel-scrape/telemetry-registry.json"
    "genie/buck2/*.ts"
    "packages/@overeng/buck2-tools/src/**/*.ts"
    "packages/@overeng/tui-core/src/**/*.ts"
    "packages/@overeng/tui-core/src/**/*.tsx"
    "packages/@overeng/tui-core/src/**/*.cts"
    "packages/@overeng/tui-core/src/**/*.mts"
    "packages/@overeng/tui-core/test/**/*.ts"
    "packages/@overeng/tui-core/test/**/*.tsx"
    "packages/@overeng/tui-core/test/**/*.cts"
    "packages/@overeng/tui-core/test/**/*.mts"
    "packages/@overeng/tui-react/src/**/*.ts"
    "packages/@overeng/tui-react/src/**/*.tsx"
    "packages/@overeng/tui-react/src/**/*.cts"
    "packages/@overeng/tui-react/src/**/*.mts"
    "packages/@overeng/tui-react/test/**/*.ts"
    "packages/@overeng/tui-react/test/**/*.tsx"
    "packages/@overeng/tui-react/test/**/*.cts"
    "packages/@overeng/tui-react/test/**/*.mts"
    "packages/@overeng/tui-react/examples/**/*.ts"
    "packages/@overeng/tui-react/examples/**/*.tsx"
    "packages/@overeng/tui-react/examples/**/*.cts"
    "packages/@overeng/tui-react/examples/**/*.mts"
    "packages/@overeng/utils/src/**/*.ts"
    "packages/@overeng/utils/src/**/*.tsx"
    "packages/@overeng/utils/src/**/*.cts"
    "packages/@overeng/utils/src/**/*.mts"
    "packages/@overeng/utils-dev/src/**/*.ts"
    "packages/@overeng/utils-dev/src/**/*.tsx"
    "packages/@overeng/utils-dev/src/**/*.cts"
    "packages/@overeng/utils-dev/src/**/*.mts"
    "pnpm-lock.yaml"
    "pnpm-workspace.yaml"
  ];
  # Shared-cache client contract (decision 0013, REUSE-R01..R05). The fleet
  # default endpoint lives HERE on purpose — it must match the dotfiles
  # build-cache trait (dotfiles#2048); changing the service means changing
  # both. It is materialized into a gitignored `.buckconfig.local` at shell
  # entry so machine-local hand edits stay untracked and win until removed:
  # an existing file with different content is preserved. An unreachable
  # cache hard-fails buck2 builds, so off-tailnet checkouts export
  # BUCK2_NO_REMOTE_CACHE=1 before shell entry (checked at entry only).
  # digest_algorithms pins what this Buck2 already produces by default —
  # explicitness only, no key migration. max_total_batch_size states the
  # 4 MiB upload batch ceiling explicitly (same value as the composition
  # config path): both gRPC peers default to a 4 MiB message limit, so an
  # implicit batch that grows past it would fail at the transport instead of
  # at a boundary we control.
  buck2CacheEndpoint = "grpc://dev3:41045";
  buck2LocalConfig = pkgs.writeText "buck2-buckconfig-local" ''
    [buck2]
    digest_algorithms = SHA256
    default_allow_cache_upload = true

    [buck2_re_client]
    engine_address = ${buck2CacheEndpoint}
    action_cache_address = ${buck2CacheEndpoint}
    cas_address = ${buck2CacheEndpoint}
    instance_name = effect-utils
    tls = false
    max_total_batch_size = 4194304
  '';
  buck2LocalConfigHook =
    let
      script = pkgs.writeShellScript "buck2-local-config-hook" ''
        set -euo pipefail
        member_root="''${DEVENV_ROOT:-$PWD}"
        workspace_root="$member_root"
        if [ -f "$member_root/../../.megarepo-owned-worktree.json" ]; then
          workspace_root="$(cd "$member_root/../.." && pwd -P)"
        fi
        target="$workspace_root/.buckconfig.local"
        if [ "''${BUCK2_NO_REMOTE_CACHE:-}" = "1" ]; then
          ${pkgs.coreutils}/bin/rm -f "$target"
        elif ! ${pkgs.diffutils}/bin/cmp -s "$target" ${buck2LocalConfig}; then
          ${pkgs.coreutils}/bin/install -m 644 ${buck2LocalConfig} "$target"
        fi
      '';
    in
    "${script}";
in
{
  imports = [
    # Git hook: prevent commits on default branch + enforce linked worktrees
    (taskModules.worktree-guard { })
    # OpenTelemetry observability stack (Collector + Tempo + Grafana)
    (import ./nix/devenv-modules/otel.nix { traceShellEntry = false; })
    # Hermetic native-devenv + effect-utils task-tree capture. Ambient mode
    # composes with the full stack above without importing it a second time.
    (import ./nix/devenv-modules/observability.nix {
      project = "effect-utils";
      # Shell-entry setup is intentionally absent. Profile an instantiated,
      # non-mutating task so check:all retains its trace integrity gate.
      profile = {
        name = "genie-check";
        task = "genie:check";
        mode = "single";
        smokeTask = "genie:check";
        smokeMode = "single";
        bridgeTask = "genie:check";
        # The verifier launches a nested, cache-refreshed task run. Keep it last
        # so its task-cache refresh cannot race sibling check:all work.
        prerequisiteTasks = [
          "bootstrap-closure:check"
          "buck2:check"
          "cargo:check"
          "dependency-materialization:evidence:check"
          "devenv:trace-audit"
          "lint:check"
          "lint:nix"
          "mr:check"
          "mr:lock-sync-check"
          "mr:source-policy-check"
          "nix:flake:check"
          "test:run"
          "weaver:check"
          "weaver:diff"
          "weaver:version-smoke"
          "workspace:check"
        ];
      };
      wireInto = [ "check:all" ];
    })
    # gh:apply-labels / gh:check-labels — reconcile .github/labels.json with live labels
    (import ./nix/devenv-modules/gh-labels.nix { repo = "overengineeringstudio/effect-utils"; })
    # Playwright browser drivers and environment setup
    inputs.playwright.devenvModules.default
    # Shared task modules
    taskModules.genie
    (taskModules.megarepo { mrPkg = mrCli; })
    (taskModules.lint-nix { })
    (taskModules.check {
      extraChecks = [
        "devenv:trace-audit"
        "workspace:check"
        "lint:nix"
      ];
      checkQuickTypecheckTask = "buck2:check";
      checkAllTypecheckTask = "buck2:check";
    })
    (taskModules.weaver { })
    # Wire the additive weaver gate into `check:all` only (not `check:quick`, which stays fast):
    # `after` list options merge across modules, so this appends without redefining check:all.
    { tasks."check:all".after = [ "weaver:check" ]; }
    # Bootstrap-safe import-closure gate (issue #884): fast local feedback for the bootstrap contract.
    # Fails (zero-tolerance, no baseline) on ANY `// @genie-bootstrap` generator whose transitive
    # runtime closure reaches a runtime-only package (which would break `genie --phase bootstrap` on a
    # fresh pre-install clone). Wired into `check:all` only (kept out of `check:quick`). The empirical
    # authority is `bootstrap:cold-proof` (R32); this static gate is its cheap pre-check.
    (taskModules.bootstrap-closure { })
    { tasks."check:all".after = [ "bootstrap-closure:check" ]; }
    # Compat-diff gate (SC-R11): blocks a PR that REMOVES a shipped registry attribute/signal.
    # PR-scoped (needs a merge-base baseline) — degrades to a warning locally on a fresh clone with
    # no `origin/main` merge-base; its load-bearing home is the CI `weaver` lane.
    (taskModules.weaver-diff { })
    { tasks."check:all".after = [ "weaver:diff" ]; }
    # Live-check e2e (SC-R12): emits registry-conformant OTLP from a first-party site, captures it,
    # and asserts `weaver registry live-check` accepts it (exit 0). Runs the scoped vitest e2e with
    # the hermetic weaver + semconv-model on env; degrades to a warning if weaver is unavailable.
    # Defined here so the CI `weaver` lane can invoke it, but deliberately NOT wired into `check:all`:
    # unlike the deterministic check/diff runs, this is a subprocess e2e (spawns otelite, binds an
    # ephemeral port, depends on export-flush timing), so it lives in CI rather than gating every
    # local `check:all` on capture reliability.
    (taskModules.weaver-live-check {
      target = "effect_utils//packages/@overeng/otel-contract:weaver_live_check";
      weaverBin = "${weaverPackages.weaver}/bin/weaver";
      semconvModel = weaverPackages.semconv-model;
      registry = "${repoFlake}/genie/weaver-registry";
    })
    # Version-pin consistency smoke (SC-DQ4): catches weaver/semconv pin drift the content
    # gate (weaver:check) silently degrades past (a bumped version with a stale FOD hash).
    (taskModules.weaver-version-smoke { })
    { tasks."check:all".after = [ "weaver:version-smoke" ]; }
    (taskModules.clean { packages = allPackages; })
    # Lock maintenance only: dependency realization belongs to Buck, so no live
    # root node_modules is created, repaired, or depended on here.
    (taskModules.pnpm {
      packages = allPackages;
      inherit mkPnpmPkg;
      geniePkg = genieCli;
    })
    # Buck-owned test execution over explicit generated targets.
    (taskModules.test {
      targets = buckTestTargets;
      buckAfter = [ "genie:run" ];
    })
    (taskModules.storybook {
      targets = buckStorybookTargets;
    })
    (taskModules.netlify {
      siteName = "overeng-utils";
      siteId = "462d2440-fb38-4e69-8023-9c425d1e2132";
      ciToolsBin = "${ciToolsCli}/bin/ci-tools";
      deployments = map (pkg: {
        name = pkg.name;
        artifactLabel = storybookBuildLabel pkg;
        packageJsonPath = "${pkg.path}/package.json";
        afterTask = "storybook:build:${pkg.name}";
        workspaceFilter = true;
      }) packagesWithNetlifyPreview;
    })
    # Workflow reports run as standalone CI control-plane steps, including when
    # a deploy is skipped. Use the hermetic package instead of relying on an
    # ambient source-workspace node_modules projection.
    (taskModules.workflow-report {
      ciToolsBin = "${ciToolsCli}/bin/ci-tools";
    })
    (taskModules.lint-oxc {
      oxlintPkg = oxlintWithPlugins;
      geniePkg = genieCli;
      lintPaths = [
        "packages"
        "scripts"
        "context"
      ];
      # Match both repo-root and nested Genie sources explicitly, then compose
      # the same repository-specific semantic inputs used by the warm-state
      # fingerprint. This is freshness scheduling, not output admission.
      geniePatterns = [
        "*.genie.ts"
        "**/*.genie.ts"
      ]
      ++ genieExtraInputGlobs;
      genieCoverageDirs = [ "packages" ];
      # Type-aware linting for typescript/no-deprecated rule
      tsconfig = "tsconfig.check.json";
      # Warning cleanup is complete: every oxlint rule is at zero repo-wide
      # (swept + key rules promoted to error; non-API surfaces exempted by
      # override). Lint is now fatal on ANY warning so the gate can never
      # silently regress — enforced identically in CI and the local pre-commit
      # gate (both run `lint:check`).
      denyWarnings = true;
    })
    # Setup task (auto-runs in enterShell)
    # Context example tasks
    taskModules.context
    (taskModules.setup {
      # Repository mutation is explicit. Shell entry activates only the Nix
      # environment, so its latency and availability are independent of Buck,
      # pnpm, Genie, megarepo state, and the repository revision.
      runOnEnterShell = false;
      requiredTasks = [ ];
      # Reuse the Genie semantic-input SSOT in the cheap Git-index outer
      # fingerprint so a warm shell cannot bypass projection invalidation.
      extraFingerprintGlobs = genieExtraInputGlobs;
      # Keep shell entry resilient (R12): optional tasks run via @complete.
      # Ordering ensures source CLIs have deps before use.
      optionalTasks = [
        "genie:run"
        "mr:apply"
      ];
      completionsCliNames = [
        "genie"
        "mr"
      ];
    })
    # Nix CLI build and hash management
    (taskModules.nix-cli { cliPackages = nixCliPackages; })
    (taskModules.buck-editor { })
    (taskModules.secretspec { })
    # Local task: Validate allPackages matches filesystem packages (effect-utils specific)
    ./nix/devenv-modules/tasks/local/workspace-check.nix
    taskModules.devenv-module-tests
    taskModules.asset-import-type-reference
    # Live Notion lanes: secrets are inherited by the target; no capability
    # configs are required because the runtime closure is fully declared.
    (import ./nix/devenv-modules/tasks/local/notion-integration-test.nix {
      targets = [
        {
          name = "notion-datasource-sync";
          label = "effect_utils//packages/@overeng/notion-datasource-sync:test_notion_live";
        }
        {
          name = "notion-effect-client";
          label = "effect_utils//packages/@overeng/notion-effect-client:test_notion_live";
        }
        {
          name = "notion-md";
          label = "effect_utils//packages/@overeng/notion-md:test_notion_live";
        }
        {
          name = "notion-react";
          label = "effect_utils//packages/@overeng/notion-react:test_notion_live";
        }
      ];
    })
    # Live Restate lane: the native server is an explicit Nix capability.
    (import ./nix/devenv-modules/tasks/local/restate-integration-test.nix {
      target = "effect_utils//packages/@overeng/restate-effect:test_restate_integration";
      restateServerBin = "${restate}/bin/restate-server";
    })
  ];

  # The guarded `genie` command dispatches to the tracked Buck product.
  effectUtils.genie.package = genieCli;

  # Non-`.genie.ts` sources share one list with the lint freshness scheduler.
  effectUtils.genie.extraInputGlobs = genieExtraInputGlobs;

  packages = [
    buck2Stage0Definition.archive-tool
    pkgs.nodejs_24
    pkgs.bun
    pkgs.typescript
    pkgs.flock # Cross-process locking for setup tasks (see setup.nix)
    # Buck's admitted event backend; avoids pnpm alias staleness and whole-tree
    # crawler races under concurrent repository tools.
    pkgs.watchman
    # restate-server (+ restate CLI) on $PATH for restate-effect integration tests.
    restate
    # Use the packaged wrapper so `notion db ...` runs on Node 24 with node:sqlite.
    repoFlake.packages.${currentSystem}.notion-cli
    # Rust binaries on PATH for local smoke tests and downstream wrappers.
    repoFlake.packages.${currentSystem}.otelite
    repoFlake.packages.${currentSystem}.otel-scrape
    # Nix-distributed Buck binary used by direct repository tasks.
    buck2Machine
    buck2Stage0Definition.product
    cliBuildStamp.package
    ciToolsCli
    tuiStoriesCli
    # Rust toolchain for the standalone Rust crates.
    # Nix builds use pkgs.rustPlatform; these give local dev + the cargo CI lane
    # cargo/clippy/rustfmt/rust-analyzer matching nixpkgs' stable rust.
    pkgs.cargo
    pkgs.rustc
    pkgs.clippy
    pkgs.reindeer
    pkgs.rustfmt
    pkgs.rust-analyzer
  ];

  # actionlint binary path for genie's workflow validation (also used by tests)
  env.GENIE_ACTIONLINT_BIN = "${pkgs.actionlint}/bin/actionlint";
  env.BUCK2_BIN = "${buck2Machine}/bin/buck2";
  env.BUCK2_MACHINE_VERSION = buck2Machine.version;
  # Source-mode mr must receive the same pinned composition runtime as the
  # packaged wrapper; refreshed tasks can invoke composition from owned members.
  env.MR_COMPOSITION_CP_BIN = "${pkgs.coreutils}/bin/cp";
  env.MR_COMPOSITION_BUCK2_BIN = "${buck2Machine}/bin/buck2";
  env.MR_COMPOSITION_BUCK2_PROTOCOL = "facebook/buck2-cli/2026-08-22";
  env.MR_COMPOSITION_SYSTEM = currentSystem;
  env.MR_COMPOSITION_PLATFORM = if pkgs.stdenv.hostPlatform.isDarwin then "darwin" else "linux";
  env.MR_COMPOSITION_GIT_BIN = "${pkgs.git}/bin/git";
  env.MR_CAPABILITY_NIX_BIN = "${pkgs.nix}/bin/nix";
  env.MR_CAPABILITY_MV_BIN = "${pkgs.coreutils}/bin/mv";

  # restate-server binary path for restate-effect integration tests (test/test-utils.ts
  # reads RESTATE_SERVER_BIN to locate the native server, else falls back to $PATH).
  env.RESTATE_SERVER_BIN = "${restate}/bin/restate-server";

  # NOTE (decision 0004): there is deliberately NO `genie:bootstrap`-before-`pnpm:install` edge.
  # An earlier form wired `pnpm:install.after = [ "genie:bootstrap" ]` so install would run
  # `genie --phase bootstrap` first. Verified during implementation that this does NOT arbitrate
  # bootstrap-safety: the source-mode `genie` on PATH needs `node_modules` (it cold-guarded to a
  # no-op on a fresh clone), and committed outputs (T01) mean install succeeds with the on-disk
  # `package.json` regardless — so the edge enforced nothing while adding cost to every warm install
  # and a new failure mode. Bootstrap-safety is instead demonstrated empirically by
  # `bootstrap:cold-proof` (R32, below), with `bootstrap-closure:check` as fast local feedback.

  # bootstrap:cold-proof (R32) — the EMPIRICAL bootstrap-safety authority. In a fresh,
  # no-node_modules tree of the committed source it builds the Buck Genie candidate, runs its
  # bootstrap phase, and checks every committed projection without installing the workspace.
  # This exercises the exact pre-install path and turns bootstrap-safety from asserted into
  # demonstrated. The dedicated task/CI lane stays outside `check:all` because it materializes a
  # separate committed-source tree and rebuilds the product from the composed Buck graph.
  tasks."bootstrap:cold-proof" = {
    description = "Prove the Buck Genie product handles bootstrap and projection checks without an install";
    exec = trace.exec "bootstrap:cold-proof" ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      BUN=${pkgs.bun}/bin/bun exec ${pkgs.bash}/bin/bash "$root/genie/ci-scripts/bootstrap-cold-proof.sh"
    '';
  };

  tasks."gh:apply-settings" = {
    after = [ "genie:run" ];
    exec = trace.exec "gh:apply-settings" ''
      set -euo pipefail
      ruleset_id=$(gh api repos/overengineeringstudio/effect-utils/rulesets --jq '.[0].id')
      gh api "repos/overengineeringstudio/effect-utils/rulesets/$ruleset_id" --method PUT --input .github/repo-settings.json
      echo "Applied repo-settings.json to ruleset $ruleset_id"
    '';
    description = "Apply .github/repo-settings.json to GitHub ruleset";
  };

  tasks."devenv:trace-audit" = {
    description = "Check active devenv task modules route every exec/status through trace.* (otel-span task span; concrete commands opt into otel-scrape via trace.instr)";
    exec = trace.exec "devenv:trace-audit" ''
      set -euo pipefail
      # Every active devenv task exec/status must route through the trace.nix
      # helpers (trace.exec / trace.status / trace.withStatus) so the otel-span
      # task span owns task identity. This audit greps for raw `exec =`/`status =`
      # attributes that do NOT go through trace.*.
      #
      # Every pattern uses POSIX bracket classes ([[:space:]], [.]) and NEVER a
      # backslash escape. A literal backslash-s / backslash-dot inside this Nix
      # indented string becomes a double-backslash that matches nothing, which
      # silently turns the whole audit vacuous (it always exits 0) — the exact
      # failure this rewrite fixes.
      #
      # A few raw exec/status lines are legitimately allowed and are annotated
      # with a `trace-audit-allow` marker comment IMMEDIATELY ABOVE the line:
      #   - the raw string is an argument passed INTO trace.* a few lines below
      #     (restate integration test, ts:emit).
      # A deliberately-untraced task would also qualify, but there are currently
      # none: every thin `ci-tools` delegation task (netlify/vercel deploys,
      # workflow-report) routes through trace.exec for a task span.
      # The marker is matched in a 2-line window (the line plus the one above),
      # so this stays robust to line shifts — no fragile file:line pins.
      marker='trace-audit-allow'
      violations=0
      while IFS= read -r hit; do
        file="''${hit%%:*}"
        rest="''${hit#*:}"
        lineno="''${rest%%:*}"
        if ${head} -n "$lineno" "$file" | ${tail} -n 2 | ${grep} -q "$marker"; then
          continue
        fi
        violations=1
        echo "BYPASS: $hit" >&2
      done < <(
        ${rg} -n '^[[:space:]]*(exec|status) = ' \
          devenv.nix \
          nix/devenv-modules/tasks/shared \
          nix/devenv-modules/tasks/local \
          -g '*.nix' \
          | ${rg} -v 'trace[.](exec|status)|exec = null|exec = if hasPackages then null else trace[.]exec|trace[.]withStatus'
      )
      if [ "$violations" -ne 0 ]; then
        echo "Found task exec/status scripts that bypass the trace.nix task span (trace.exec/status/withStatus)." >&2
        echo "Route them through trace.* or, if intentionally raw, add a 'trace-audit-allow' marker comment above the line with justification." >&2
        exit 1
      fi
    '';
  };

  tasks."cargo:test:buck2-foundation" = {
    description = "Run the Rust tests for the Buck2 foundation tools";
    exec = trace.exec "cargo:test:buck2-foundation" ''
      set -euo pipefail
      (
        cd rust
        cargo test --locked --package 'buck2-*'
      )
    '';
  };

  tasks."cargo:check" = {
    description = "Validate the shared Cargo workspace, then build, test, lint, and format-check each member";
    after = [ "cargo:test:buck2-foundation" ];
    exec = trace.exec "cargo:check" ''
      set -euo pipefail
      ${pkgs.bash}/bin/bash rust/workspace-contract.test.sh "$PWD"
      (
        cd rust
        cargo build --release --locked --workspace
        cargo test --locked --workspace --exclude 'buck2-*'
        cargo clippy --locked --workspace --all-targets -- -D warnings
        cargo fmt --all --check
      )
    '';
  };

  tasks."buck2:rust-deps:generate" = {
    description = "Regenerate the non-vendored Reindeer graph from the Cargo workspace";
    exec = trace.exec "buck2:rust-deps:generate" ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      exec ${pkgs.bash}/bin/bash "$root/scripts/buck2-rust-deps.sh" generate \
        "$root" \
        ${pkgs.reindeer}/bin/reindeer \
        ${pkgs.cargo}/bin/cargo \
        ${pkgs.rustc}/bin/rustc
    '';
  };

  tasks."buck2:rust-deps:check" = {
    description = "Verify the non-vendored Reindeer graph matches Cargo inputs";
    exec = trace.exec "buck2:rust-deps:check" ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      exec ${pkgs.bash}/bin/bash "$root/scripts/buck2-rust-deps.sh" check \
        "$root" \
        ${pkgs.reindeer}/bin/reindeer \
        ${pkgs.cargo}/bin/cargo \
        ${pkgs.rustc}/bin/rustc
    '';
  };

  tasks."dependency-materialization:evidence:check" = {
    description = "Validate committed dependency-materialization benchmark and host-capability evidence";
    exec = trace.exec "dependency-materialization:evidence:check" ''
      ${pkgs.nodejs}/bin/node \
        context/dependency-materialization/07-verification/evidence/validate-storage-sharing-default.mjs
    '';
  };

  # Tracked Buck product artifacts. `publish` rebuilds and rewrites the tracked
  # tree; `check` is the freshness gate that fails when the tracked bytes no
  # longer match what Buck produces.
  tasks."buck2:products:publish" = {
    description = "Rebuild and republish the tracked Buck product artifacts";
    after = [ "mr:apply" ];
    exec = trace.exec "buck2:products:publish" ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      BUCK2_BIN=${buck2Machine}/bin/buck2 \
        JQ_BIN=${pkgs.jq}/bin/jq \
        PRODUCTS_DIR="$root/nix/buck2-products" \
        WORKSPACE_ROOT="$(${pkgs.coreutils}/bin/realpath "$root/../..")" \
        exec ${pkgs.bash}/bin/bash "$root/nix/buck2-products/reconcile.sh" publish
    '';
  };

  tasks."buck2:products:check" = {
    description = "Check the tracked Buck product artifacts against current Buck output";
    after = [ "mr:apply" ];
    exec = trace.exec "buck2:products:check" ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      BUCK2_BIN=${buck2Machine}/bin/buck2 \
        JQ_BIN=${pkgs.jq}/bin/jq \
        PRODUCTS_DIR="$root/nix/buck2-products" \
        WORKSPACE_ROOT="$(${pkgs.coreutils}/bin/realpath "$root/../..")" \
        exec ${pkgs.bash}/bin/bash "$root/nix/buck2-products/reconcile.sh" check
    '';
  };

  tasks."bundle:smoke" = {
    description = "Bundle representative public entries through the Buck bundle smoke target";
    after = [ "mr:apply" ];
    exec = trace.exec "bundle:smoke" ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      workspace_root="$(${pkgs.coreutils}/bin/realpath "$root/../..")"
      exec "$workspace_root/.megarepo/bin/buck2" build \
        effect_utils//packages/@overeng/pty-effect:bundle_smoke_candidate
    '';
  };

  tasks."buck2:nix-bridge:check" = {
    description = "Check the strict build-product contract and fail-closed artifact importer";
    after = [ "mr:apply" ];
    exec = trace.exec "buck2:nix-bridge:check" ''
      set -euo pipefail
      ${pkgs.bash}/bin/bash nix/workspace-tools/lib/tests/buck2-build-product-contract.sh "$PWD"
      ${pkgs.bash}/bin/bash nix/workspace-tools/lib/tests/javascript-product-import.sh "$PWD"
      JQ_BIN=${pkgs.jq}/bin/jq \
        ${pkgs.bash}/bin/bash nix/workspace-tools/lib/tests/tracked-buck-products.sh "$PWD"
      exec ${pkgs.bash}/bin/bash nix/workspace-tools/lib/tests/buck2-bridge.sh "$PWD"
    '';
  };

  # Executor admission must observe the current host policy. A fresh isolation directory prevents
  # Buck's local action cache from satisfying the gate, while --no-remote-cache prevents importing
  # another executor's verdict. The raw pinned binary is intentional: the composition wrapper
  # fixes the steady-state isolation directory and therefore cannot provide a fresh namespace.
  tasks."buck2:sandbox-gate:fresh" = {
    description = "Run TypeScript sandbox admission in a fresh executor-local cache namespace";
    after = [ "mr:apply" ];
    exec = trace.exec "buck2:sandbox-gate:fresh" ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      workspace_root="$(${pkgs.coreutils}/bin/realpath "$root/../..")"
      isolation="sandbox-gate-$$-''${RANDOM}"
      cleanup_sandbox_gate() {
        status=$?
        ${buck2Machine}/bin/buck2 --isolation-dir "$isolation" kill >/dev/null 2>&1 || true
        ${pkgs.coreutils}/bin/rm -rf -- "$workspace_root/buck-out/$isolation"
        trap - EXIT
        exit "$status"
      }
      trap cleanup_sandbox_gate EXIT
      cd "$workspace_root"
      ${buck2Machine}/bin/buck2 \
        --isolation-dir "$isolation" \
        build \
        --local-only \
        --no-remote-cache \
        effect_utils//buck2/sandbox-gate:denies_undeclared_host_read \
        effect_utils//buck2/sandbox-gate:denies_undeclared_store_metadata \
        effect_utils//buck2/sandbox-gate:denies_network \
        effect_utils//buck2/sandbox-gate:denies_ambient_environment \
        effect_utils//buck2/sandbox-gate:denies_undeclared_host_write \
        effect_utils//buck2/sandbox-gate:denies_undeclared_process_exec
    '';
  };

  tasks."buck2:editor-authority" = {
    description = "Derive exact whole-workspace editor dependency authority from semantic and Buck ownership";
    # Buck analysis of //buck2/toolchains reads the `.buck2/capabilities`
    # projection, so every task that invokes Buck must be ordered after it.
    after = [ "mr:apply" ];
    exec = trace.exec "buck2:editor-authority" ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      workspace_root="$(${pkgs.coreutils}/bin/realpath "$root/../..")"
      buck="$workspace_root/.megarepo/bin/buck2"
      "$buck" run effect_utils//scripts:editor-view-authority -- \
        --repo-root "$root" \
        --workspace-root "$workspace_root" \
        --cell effect_utils \
        --buck2 "$buck" \
        --git ${pkgs.git}/bin/git \
        --output "$root/.devenv/editor-workspace-authority.json"
    '';
  };

  tasks."buck2:tui-core:publish-editor" = {
    description = "Publish the admitted Buck tui-core node_modules tree to the scoped editor view";
    after = [ "buck2:editor-authority" ];
    exec = trace.exec "buck2:tui-core:publish-editor" ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      authority="$root/.devenv/editor-workspace-authority.json"
      scratch="$(${pkgs.coreutils}/bin/mktemp -d "$root/.devenv/editor-publish-inputs.XXXXXX")"
      cleanup_editor_publish() {
        status=$?
        ${pkgs.coreutils}/bin/rm -rf -- "$scratch" || status=$?
        trap - EXIT
        exit "$status"
      }
      trap cleanup_editor_publish EXIT
      workspace_root="$(${pkgs.coreutils}/bin/realpath "$root/../..")"
      buck="$workspace_root/.megarepo/bin/buck2"
      (
        cd "$workspace_root"
        "$buck" build effect_utils//packages/@overeng/tui-core:editor_inputs --out "$scratch/editor_inputs"
        "$buck" build effect_utils//packages/@overeng/tui-core:node_modules --out "$scratch/node_modules"
      )
      ${pkgs.bun}/bin/bun "$root/packages/@overeng/buck2-tools/src/editor-view.ts" publish \
        --repo-root "$root" \
        --package packages/@overeng/tui-core \
        --cell tui-core \
        --target //packages/@overeng/tui-core:editor_inputs \
        --editor-inputs "$scratch/editor_inputs" \
        --node-modules "$scratch/node_modules" \
        --cp ${pkgs.coreutils}/bin/cp \
        --workspace-authority "$authority" \
        --consumer-cache "$root/.devenv/vite-cache/tui-core" \
        --snapshot-retention 3 \
        --mv ${pkgs.coreutils}/bin/mv
    '';
  };

  tasks."buck2:tui-core:check-editor" = {
    description = "Check the scoped tui-core editor view against current admitted Buck outputs";
    after = [ "buck2:editor-authority" ];
    exec = trace.exec "buck2:tui-core:check-editor" ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      authority="$root/.devenv/editor-workspace-authority.json"
      scratch="$(${pkgs.coreutils}/bin/mktemp -d "$root/.devenv/editor-check-inputs.XXXXXX")"
      cleanup_editor_check() {
        status=$?
        ${pkgs.coreutils}/bin/rm -rf -- "$scratch" || status=$?
        trap - EXIT
        exit "$status"
      }
      trap cleanup_editor_check EXIT
      workspace_root="$(${pkgs.coreutils}/bin/realpath "$root/../..")"
      buck="$workspace_root/.megarepo/bin/buck2"
      (
        cd "$workspace_root"
        "$buck" build effect_utils//packages/@overeng/tui-core:editor_inputs --out "$scratch/editor_inputs"
        "$buck" build effect_utils//packages/@overeng/tui-core:node_modules --out "$scratch/node_modules"
      )
      ${pkgs.bun}/bin/bun "$root/packages/@overeng/buck2-tools/src/editor-view.ts" check \
        --repo-root "$root" \
        --package packages/@overeng/tui-core \
        --cell tui-core \
        --target //packages/@overeng/tui-core:editor_inputs \
        --editor-inputs "$scratch/editor_inputs" \
        --node-modules "$scratch/node_modules" \
        --cp ${pkgs.coreutils}/bin/cp \
        --workspace-authority "$authority" \
        --consumer-cache "$root/.devenv/vite-cache/tui-core" \
        --snapshot-retention 3 \
        --mv ${pkgs.coreutils}/bin/mv
    '';
  };

  tasks."buck2:tui-core:recover-editor-lock" = {
    description = "Recover the scoped tui-core editor publication lock with its exact owner token";
    exec = trace.exec "buck2:tui-core:recover-editor-lock" ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      token="''${EDITOR_VIEW_LOCK_TOKEN:?set EDITOR_VIEW_LOCK_TOKEN to the owner token printed by publish}"
      ${pkgs.bun}/bin/bun "$root/packages/@overeng/buck2-tools/src/editor-view.ts" recover-lock \
        --repo-root "$root" \
        --package packages/@overeng/tui-core \
        --token "$token"
    '';
  };

  tasks."buck2:typescript:materialize-dist" = {
    description = "Atomically materialize all Buck-owned TypeScript declarations";
    after = [
      "mr:apply"
      "genie:run"
      # Product freshness runs before declaration publication. Running both
      # Buck commands in parallel makes Watchman rescan every published dist
      # while the product graph is still synchronizing.
      "buck2:products:check"
    ];
    exec = trace.exec "buck2:typescript:materialize-dist" ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      workspace_root="$(${pkgs.coreutils}/bin/realpath "$root/../..")"
      buck="$workspace_root/.megarepo/bin/buck2"
      export PATH=${
        lib.makeBinPath [
          pkgs.coreutils
          pkgs.watchman
        ]
      }
      export WORKSPACE_ROOT="$workspace_root"
      export BUCK2_BIN="$buck"
      exec "$buck" run effect_utils//genie/buck2:typescript-authority-runtime -- \
        materialize-dist "$root" ${pkgs.bash}/bin/bash
    '';
  };

  tasks."buck2:task-guards:check" = {
    description = "Check TypeScript publication failure paths and evaluated task ordering";
    exec = trace.exec "buck2:task-guards:check" ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      ${pkgs.bash}/bin/bash "$root/nix/devenv-modules/tasks/shared/tests/typescript-materialize-dist.test.sh"
      DEVENV_TASKS_JSON="$root/.devenv/gc/task-config-devenv-config-task-config" \
        NODE_BIN=${pkgs.nodejs}/bin/node exec ${pkgs.bash}/bin/bash \
        "$root/nix/devenv-modules/tasks/shared/tests/devenv-task-graph.test.sh"
    '';
  };

  tasks."buck2:check" = {
    description = "Build admitted TypeScript checks and surviving archive/product Buck2 surface";
    after = [
      "mr:apply"
      "buck2:sandbox-gate:fresh"
      "buck2:nix-bridge:check"
      "buck2:task-guards:check"
      "buck2:rust-deps:check"
      "buck2:products:check"
      # Declaration publication is Buck-owned and no longer has a root
      # TypeScript consumer, so the aggregate carries it into check:quick/all.
      "buck2:typescript:materialize-dist"
    ];
    exec = trace.exec "buck2:check" ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      export PATH=${
        lib.makeBinPath [
          pkgs.coreutils
          pkgs.watchman
        ]
      }
      workspace_root="$(${pkgs.coreutils}/bin/realpath "$root/../..")"
      buck="$workspace_root/.megarepo/bin/buck2"
      "$buck" audit providers \
        --target-platforms effect_utils//buck2/platforms:host_platform \
        effect_utils//buck2/toolchains:cross_cell_provider_identity \
        effect_utils//buck2/toolchains:cross_cell_product_identity
      exec "$buck" run effect_utils//genie/buck2:typescript-authority-runtime -- \
        build "$buck"
    '';
  };

  # `buck2:check` is the typecheck authority for both aggregate gates
  # (`checkQuickTypecheckTask`/`checkAllTypecheckTask`), so it is no longer
  # listed here.
  tasks."check:all".after = [
    "cargo:check"
    "dependency-materialization:evidence:check"
  ];

  # `test:run` executes after its package-task dependencies, so the
  # baseline-collection gate sees the complete managed-test summary directory in CI.
  tasks."test:run".exec = lib.mkForce (
    trace.exec "test:run" ''
      set -euo pipefail
      ${pkgs.bun}/bin/bun packages/@overeng/utils-dev/check-baseline-test-collection.ts \
        --task-registry ${baselineTestTaskRegistry}
    ''
  );

  # Keep git-hook installation out of the shell-entry path.
  # If needed, install with `devenv tasks run devenv:git-hooks:install`.
  # TODO(cachix/git-hooks.nix#688): remove this once the upstream git-hooks.nix issue
  # is fixed; currently this workaround prevents shell-entry failures with core.hooksPath.
  tasks."devenv:git-hooks:install".before = lib.mkForce [ ];

  # Repo-local pnpm store for consistent local installs (not used by Nix builds).
  env.PNPM_STORE_DIR = "${config.devenv.root}/.devenv/pnpm-store-pure-v1";

  enterShell = ''
    export WORKSPACE_ROOT="$PWD"
    ${buck2LocalConfigHook}
    ${cliBuildStamp.shellHook}
  '';

  git-hooks.enable = true;
  git-hooks.hooks.check-quick = {
    enable = true;
    entry = "DEVENV_TUI=false devenv tasks run check:quick";
    stages = [ "pre-commit" ];
    always_run = true;
    pass_filenames = false;
  };
}
