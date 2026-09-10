{
  # Nix flake for sharing helper libraries across repos.
  #
  # We already have a devenv-based setup for local development, but repos that
  # consume effect-utils as a flake input still need a flake entry point so they
  # can import Nix helpers (for example lib.mkCliPackages) with a stable API.
  # This keeps the build logic reusable without requiring devenv in the parent.
  #
  # Prepared pnpm trees are content-addressed against the effect-utils build
  # graph, so downstream repos should make their root nixpkgs follow
  # `effect-utils/nixpkgs` instead of overriding the input the other way around.
  inputs = {
    # Track nixos-unstable: it has now advanced past the crates.io
    # importCargoLock UA fix (nixpkgs#524985), so the release-26.05 detour from
    # #703 is no longer needed and this is again the shared root authority every
    # downstream repo follows.
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    tsgo.url = "github:Effect-TS/tsgo";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
      tsgo,
      ...
    }:
    let
      gitRev =
        self.sourceInfo.dirtyShortRev or self.sourceInfo.shortRev or self.sourceInfo.rev or "unknown";
      # lastModified is the git commit timestamp (Unix seconds)
      commitTs = self.sourceInfo.lastModified or 0;
      dirty = self.sourceInfo ? dirtyShortRev;
    in
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
        mkBunCli = import ./nix/workspace-tools/lib/mk-bun-cli.nix { inherit pkgs; };
        cliBuildStamp = import ./nix/workspace-tools/lib/cli-build-stamp.nix { inherit pkgs; };
        rootPath = self.outPath;
        oxlintNpm = import ./nix/oxlint-npm.nix {
          inherit pkgs;
          bun = pkgs.bun;
          src = self;
        };
        nodePtyNative = import ./nix/node-pty-native.nix { inherit pkgs; };
        providerCliPackages = {
          vercel-cli = import ./nix/provider-clis/vercel-cli { inherit pkgs; };
          netlify-cli = import ./nix/provider-clis/netlify-cli { inherit pkgs; };
        };
        # Rust packages (otelite, otel-scrape) built via
        # rustPlatform.buildRustPackage, separate from the Bun CLIs. otelite (a
        # local OTLP capture tool) was effect-utils' first Rust package.
        otelite = import (rootPath + "/packages/@overeng/otelite/nix/build.nix") {
          inherit pkgs;
        };
        otel-scrape = import (rootPath + "/packages/@overeng/otel-scrape/nix/build.nix") {
          inherit
            pkgs
            gitRev
            commitTs
            dirty
            ;
        };
        buck2 = import ./nix/buck2.nix { inherit pkgs; };
        buck2-go = import ./nix/go.nix { inherit pkgs; };
        buck2-stage0-tools = import ./nix/buck2-stage0-tools.nix { inherit pkgs; };
        buck2-rust-toolchain-capability =
          import ./nix/workspace-tools/lib/buck2-rust-toolchain-capability.nix
            {
              inherit pkgs;
              nixpkgsRevision = nixpkgs.rev;
            };
        # Buck is the sole repository-product producer. Nix imports only the
        # reviewed, content-addressed release assets the product publication
        # gate committed; there is no source CLI build left in this flake.
        trackedBuck2Products = import ./nix/buck2-products { inherit pkgs; };
        buck2ProductCandidates = import ./nix/workspace-tools/lib/buck2-product-candidates.nix {
          inherit
            pkgs
            gitRev
            commitTs
            dirty
            ;
          products = trackedBuck2Products.products;
          typeProofCompilerBin = "${tsgo.packages.${system}.tsgo}/bin/tsgo";
        };
        cliPackages = buck2ProductCandidates;
      in
      {
        packages =
          cliPackages
          // providerCliPackages
          // {
            inherit
              buck2
              otelite
              otel-scrape
              ;
            # Hub toolchain authority realization: the exact Bun every Buck JS/TS action uses.
            bun = pkgs.bun;
            # Hub toolchain authority realization: the exact Node every Buck Vitest lane
            # that exercises Node built-ins runs on.
            buck2-node = pkgs.writeShellScriptBin "node" ''
              exec ${pkgs.nodejs_24 or pkgs.nodejs}/bin/node "$@"
            '';
            # Hub toolchain authority realization: the exact Go distribution every
            # Buck Go action compiles with — the OFFICIAL release archive, not
            # `pkgs.go`, whose patched stdlib puts three absolute store paths into
            # every product it compiles (decision 0029, `nix/go.nix`). `bin/go` is a
            # real file in that archive, so the resolver's realpath lands on
            # /nix/store/<realization>/bin/go and no wrapper is needed.
            inherit buck2-go;
            # Hub toolchain authority realization: prelude's bootstrap interpreter.
            buck2-python-bootstrap = pkgs.writeShellScriptBin "python3" ''
              exec ${pkgs.python3}/bin/python3 "$@"
            '';
            buck2-archive-tool = buck2-stage0-tools.archive-tool;
            buck2-product = buck2-stage0-tools.product;
            # Composition-wrapper capability realization for the
            # `gnu/coreutils/v9` readlink executable. Keep a real executable
            # file at this path so capability resolution can attest it.
            buck2-coreutils = pkgs.writeShellScriptBin "readlink" ''
              exec ${pkgs.coreutils}/bin/readlink "$@"
            '';
            buck2-rust-compiler = buck2-rust-toolchain-capability.packages.rust-compiler;
            buck2-rust-rustdoc = buck2-rust-toolchain-capability.packages.rust-rustdoc;
            buck2-rust-clippy-driver = buck2-rust-toolchain-capability.packages.rust-clippy-driver;
            buck2-rust-c-compiler = buck2-rust-toolchain-capability.packages.rust-c-compiler;
            buck2-rust-cxx-compiler = buck2-rust-toolchain-capability.packages.rust-cxx-compiler;
            buck2-rust-linker = buck2-rust-toolchain-capability.packages.rust-linker;
            buck2-rust-archiver = buck2-rust-toolchain-capability.packages.rust-archiver;
            buck2-rust-dwp = buck2-rust-toolchain-capability.packages.rust-dwp;
            buck2-rust-nm = buck2-rust-toolchain-capability.packages.rust-nm;
            buck2-rust-objcopy = buck2-rust-toolchain-capability.packages.rust-objcopy;
            buck2-rust-objdump = buck2-rust-toolchain-capability.packages.rust-objdump;
            buck2-rust-ranlib = buck2-rust-toolchain-capability.packages.rust-ranlib;
            buck2-rust-strip = buck2-rust-toolchain-capability.packages.rust-strip;
            buck2-rust-shell = buck2-rust-toolchain-capability.packages.rust-shell;
            cli-build-stamp = cliBuildStamp.package;
            effect-tsgo = tsgo.packages.${system}.effect-tsgo;
            # The oxlint plugin bundle keeps its pnpm FOD as a first-class
            # output: `nix/oxlint-npm.nix` needs the pnpm-built plugin bundle,
            # which the `oxc-config` JavaScript product does not replace. The
            # `oxc-config` package attribute itself is the wrapped Buck product
            # merged in from `cliPackages`.
            "oxc-config-plugin-pnpm-deps" = oxlintNpm.pluginBundle.passthru.depsBuildsByInstallRoot.root;
            # npm oxlint with NAPI bindings + pre-bundled @overeng/oxc-config plugin
            oxlint-npm = oxlintNpm;
            # oxlint-npm wrapped with automatic @overeng/oxc-config plugin injection
            oxlint-with-plugins = import ./nix/oxlint-with-plugins.nix {
              inherit pkgs oxlintNpm;
            };
            node-pty-native = nodePtyNative;
          }
          // pkgs.lib.optionalAttrs (system == "x86_64-linux") {
          };
        # Direnv helper for comparing expected CLI outputs to PATH entries.
        cliOutPaths = {
          genie = cliPackages.genie.outPath;
          ci-tools = cliPackages.ci-tools.outPath;
          megarepo = cliPackages.megarepo.outPath;
          tui-stories = cliPackages.tui-stories.outPath;
          notion-cli = cliPackages.notion-cli.outPath;
          notion-md = cliPackages.notion-md.outPath;
        };

        apps.update-bun-hashes = flake-utils.lib.mkApp {
          drv = import ./nix/workspace-tools/lib/update-bun-hashes.nix { inherit pkgs; };
        };
        apps.otelite = flake-utils.lib.mkApp { drv = otelite; };
        apps.otel-scrape = flake-utils.lib.mkApp { drv = otel-scrape; };
      }
    )
    // {
      # Devenv modules for importing into other repos
      devenvModules = {
        # Lightweight native-devenv + effect-utils capture, optionally composed
        # with the full Collector/Tempo/Grafana stack.
        observability = import ./nix/devenv-modules/observability.nix;
        # OpenTelemetry observability stack (Collector + Tempo + Grafana)
        otel = import ./nix/devenv-modules/otel.nix;
        # Shared task modules (parameterized) - meant for reuse in other repos
        tasks = {
          # Simple tasks (no config needed)
          # Configure Genie through the `effectUtils.genie.*` option namespace.
          genie = ./nix/devenv-modules/tasks/shared/genie.nix;
          lint-genie = ./nix/devenv-modules/tasks/shared/lint-genie.nix;
          # Parameterized tasks (pass config)
          megarepo = import ./nix/devenv-modules/tasks/shared/megarepo.nix;
          ts = import ./nix/devenv-modules/tasks/shared/ts.nix;
          setup = import ./nix/devenv-modules/tasks/shared/setup.nix;
          check = import ./nix/devenv-modules/tasks/shared/check.nix;
          clean = import ./nix/devenv-modules/tasks/shared/clean.nix;
          test = import ./nix/devenv-modules/tasks/shared/test.nix;
          test-playwright = import ./nix/devenv-modules/tasks/shared/test-playwright.nix;
          storybook = import ./nix/devenv-modules/tasks/shared/storybook.nix;
          netlify = import ./nix/devenv-modules/tasks/shared/netlify.nix;
          vercel = import ./nix/devenv-modules/tasks/shared/vercel.nix;
          workflow-report = import ./nix/devenv-modules/tasks/shared/workflow-report.nix;
          lint-nix = import ./nix/devenv-modules/tasks/shared/lint-nix.nix;
          lint-oxc = import ./nix/devenv-modules/tasks/shared/lint-oxc.nix;
          bun = import ./nix/devenv-modules/tasks/shared/bun.nix;
          changesets = import ./nix/devenv-modules/tasks/shared/changesets.nix;
          github-ruleset = import ./nix/devenv-modules/tasks/shared/github-ruleset.nix;
          # gh:apply-labels / gh:check-labels — reconcile .github/labels.json with live labels.
          # Parameterized by `{ repo = "owner/name"; }`; consumed like the other task modules.
          gh-labels = import ./nix/devenv-modules/gh-labels.nix;
          pnpm = import ./nix/devenv-modules/tasks/shared/pnpm.nix;
          nix-cli = import ./nix/devenv-modules/tasks/shared/nix-cli.nix;
          flake-lock-duplicates = import ./nix/devenv-modules/tasks/shared/flake-lock-duplicates.nix;
          secretspec = import ./nix/devenv-modules/tasks/shared/secretspec.nix;
          # Prevent commits on default branch and optionally enforce worktree-only workflow
          worktree-guard = import ./nix/devenv-modules/tasks/shared/worktree-guard.nix;
          # Bootstrap-safe import-closure gate; shared packaged checker runs against the importing repo root.
          bootstrap-closure = import ./nix/devenv-modules/tasks/shared/bootstrap-closure.nix;
          # Note: local/ directory contains effect-utils specific tasks (not exported)
        };
      };

      # CLI guard helpers: .mkCliGuard for single guards, .fromTasks/.stripGuards for task-driven guards
      lib.cliGuard = { pkgs }: import ./nix/devenv-modules/tasks/lib/cli-guard.nix { inherit pkgs; };

      # Builder function for external repos to create their own Bun CLIs
      lib.mkBunCli = { pkgs }: import ./nix/workspace-tools/lib/mk-bun-cli.nix { inherit pkgs; };

      # Verify and import a published Buck artifact into a normal Nix output for
      # wrapping and later Home Manager/system activation.
      lib.mkBuck2ArtifactImport =
        { pkgs }: import ./nix/workspace-tools/lib/buck2-artifact-import.nix { inherit pkgs; };

      # Verify and import one tracked Buck JavaScript product (descriptor plus
      # content-addressed module bytes) into a wrappable Nix output.
      lib.mkBuck2JavaScriptProductImport =
        { pkgs }: import ./nix/workspace-tools/lib/javascript-product-import.nix { inherit pkgs; };

      # Wrap the tracked Buck JavaScript products into the public CLI packages.
      # Usage: effectUtils.lib.mkBuck2ProductCandidates { inherit pkgs; products = ...; }
      lib.mkBuck2ProductCandidates =
        args:
        import ./nix/workspace-tools/lib/buck2-product-candidates.nix (
          {
            typeProofCompilerBin = "${tsgo.packages.${args.pkgs.stdenv.hostPlatform.system}.tsgo}/bin/tsgo";
          }
          // args
        );

      # Shell helper for runtime CLI build stamps.
      lib.cliBuildStamp =
        { pkgs }: import ./nix/workspace-tools/lib/cli-build-stamp.nix { inherit pkgs; };

      # Build Grafonnet dashboards against the shared OTEL dashboard library.
      # Returns a linkFarm (Nix store path) containing compiled JSON files.
      lib.buildOtelDashboards =
        {
          pkgs,
          src,
          dashboardNames,
        }:
        import ./nix/devenv-modules/otel/build-dashboards.nix { inherit pkgs src dashboardNames; };

      # Standalone otel-span CLI (run + emit subcommands).
      # Can be added to devenv packages without importing the full OTEL module.
      lib.mkOtelSpan = { pkgs }: import ./nix/devenv-modules/otel/otel-span.nix { inherit pkgs; };

      # Convenience helper for bundling the common genie/megarepo CLIs.
      # The CLIs are wrapped Buck products, so `products` (the `products`
      # attribute of effect-utils' `nix/buck2-products` loader) is required.
      lib.mkCliPackages =
        args:
        import ./nix/workspace-tools/lib/mk-cli-packages.nix (
          {
            typeProofCompilerBin = "${tsgo.packages.${args.pkgs.stdenv.hostPlatform.system}.tsgo}/bin/tsgo";
          }
          // args
        );

      # npm oxlint with NAPI bindings for JavaScript plugin support.
      # When `src` is provided (the effect-utils source), the @overeng/oxc-config
      # plugin is bundled alongside and exposed via passthru.pluginPath.
      # Usage: effectUtils.lib.mkOxlintNpm { inherit pkgs; bun = pkgs.bun; src = inputs.effect-utils; }
      lib.mkOxlintNpm =
        {
          pkgs,
          bun,
          src ? null,
        }:
        import ./nix/oxlint-npm.nix { inherit pkgs bun src; };

      # oxlint wrapper that auto-injects the @overeng/oxc-config plugin when
      # the project config contains overeng/* rules. Falls through to plain
      # oxlint-npm otherwise.
      # Usage: effectUtils.lib.mkOxlintWithPlugins { inherit pkgs; oxlintNpm = effectUtils.packages.\${system}.oxlint-npm; }
      lib.mkOxlintWithPlugins =
        {
          pkgs,
          oxlintNpm,
        }:
        import ./nix/oxlint-with-plugins.nix { inherit pkgs oxlintNpm; };

      # Pinned pnpm for the entire megarepo ecosystem.
      # Usage: effectUtils.lib.mkPnpm { inherit pkgs; }
      lib.mkPnpm = { pkgs }: import ./nix/pnpm.nix { inherit pkgs; };

      # For consuming CLIs from other repos, use:
      #   effectUtils.packages.${system}.genie
      #   effectUtils.packages.${system}.ci-tools
      #   effectUtils.packages.${system}.megarepo
      # See the stack-level Nix/devenv CLI distribution policy docs.
    };
}
