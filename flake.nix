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
    # Track release-26.05: the crates.io importCargoLock UA fix (nixpkgs#524985)
    # was backported there as nixpkgs#524989 and the branch is Hydra-cached.
    # nixos-unstable has NOT advanced past the 2026-05-27 fix yet (still pinned
    # at the pre-fix 2026-05-23 rev), so a lock bump on unstable is a no-op for
    # the 403. Revisit a return to nixos-unstable once it advances. See #703.
    nixpkgs.url = "github:NixOS/nixpkgs/release-26.05";
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
        # Buck is the sole repository-product producer. Nix imports only reviewed,
        # content-addressed artifacts committed by the product publication gate.
        trackedBuck2Products = import ./nix/buck2-products { inherit (pkgs) lib; };
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
            # Test-tool capability realization: the exact GNU coreutils whose `cp`, `mv`, and
            # `false` the editor-view suite drives. Declaring each as a capability is what gives a
            # sandboxed test its complete `closureStorePaths`, not just the executable file.
            # `singleBinary = false` is load-bearing: the capability resolver realpaths a declared
            # executable, and the default multi-call build makes every `bin/<tool>` a symlink onto
            # one `bin/coreutils`, which would collapse all three declarations onto one dispatcher.
            buck2-coreutils = pkgs.coreutils.override { singleBinary = false; };
            # One flake package per test-tool family. Each is the realization a `support_tool`
            # capability attests, so a sandboxed test reads the tool's whole closure rather than
            # one executable file, and its `bin` directory is the only PATH entry it gets.
            buck2-bash = pkgs.bash;
            buck2-git = pkgs.git;
            buck2-gnugrep = pkgs.gnugrep;
            # `pkgs.nix` publishes `bin/nix` as a symlink into a *different* store path, which the
            # capability resolver rejects as uncontained. Wrap it like `buck2-node` so the declared
            # executable is a real file inside this realization and the closure carries the CLI.
            buck2-nix = pkgs.writeShellScriptBin "nix" ''
              exec ${pkgs.nix}/bin/nix "$@"
            '';
            # `util-linux` is multi-output and the capability resolver realizes the default
            # output, which carries no `bin/script`. Wrap the `bin` output like `buck2-nix` so
            # the declared executable is a real file in a single-output realization.
            buck2-util-linux = pkgs.writeShellScriptBin "script" ''
              exec ${pkgs.util-linux.bin}/bin/script "$@"
            '';
            # `ps` for the otelite orphan-process assertion. Wrapped for the same reason as
            # `buck2-nix`: `procps` publishes `bin/ps` outside a single-output realization.
            buck2-procps = pkgs.writeShellScriptBin "ps" ''
              exec ${pkgs.procps}/bin/ps "$@"
            '';
            # `rustfmt` is the one Rust tool the generator suites drive that the Buck Rust
            # toolchain capability does not already realize. Wrapped like `buck2-nix` so the
            # declared executable is a real file in this realization.
            buck2-rustfmt = pkgs.writeShellScriptBin "rustfmt" ''
              exec ${pkgs.rustfmt}/bin/rustfmt "$@"
            '';
            # The devenv-module shell suite drives a whole tool set, not one binary. One
            # capability per tool would attest a dozen realizations and still leave the suite
            # resolving them by name, so the bundle itself is the capability: a single
            # `symlinkJoin` whose `bin` is the lane's PATH entry, and whose attested
            # `closureStorePaths` carry every joined package. `bin/devenv-module-tools` is a real
            # file installed into the join (not a symlink into another realization), which is what
            # lets the resolver realpath the declared executable inside this realization.
            #
            # `nix` is joined for the CLI *aliases* the suite calls by name — `nix-instantiate`,
            # `nix-build` — which the single-executable `buck2-nix` capability cannot publish.
            # `pnpm` is the repo-pinned realization, so the suite's version assertion compares the
            # same bytes the workspace itself installs. `gnutar`, `gzip`, and `perl` (which is what
            # publishes `shasum`) are the remaining archivers and interpreters the suite shells out
            # to by name. No interpreted-language runtime beyond that is joined: decision 0028
            # admits exactly one hermetic bootstrap realization for that surface.
            buck2-devenv-module-tools = pkgs.symlinkJoin {
              name = "buck2-devenv-module-tools";
              paths = [
                pkgs.coreutils
                pkgs.diffutils
                pkgs.findutils
                pkgs.gawk
                pkgs.git
                pkgs.gnugrep
                pkgs.gnused
                pkgs.gnutar
                pkgs.gzip
                pkgs.jq
                pkgs.nix
                pkgs.perl
                # `bin` output: the default output publishes no `bin/flock`, which the pnpm
                # store-lease case drives by name.
                pkgs.util-linux.bin
                (import ./nix/pnpm.nix { inherit pkgs; })
              ];
              postBuild = ''
                install -m 0755 ${pkgs.writeShellScript "devenv-module-tools" ''
                  # Sentinel executable of the devenv-module tool bundle: prints the bundle
                  # `bin` directory the capability binds onto the sandbox PATH.
                  cd -- "''${0%/*}" || exit 1
                  pwd
                ''} "$out/bin/devenv-module-tools"
              '';
            };
            buck2-product = buck2-stage0-tools.product;
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
            # npm oxlint with NAPI bindings + pre-bundled @overeng/oxc-config plugin
            oxlint-npm = oxlintNpm;
            # oxlint-npm wrapped with automatic @overeng/oxc-config plugin injection
            oxlint-with-plugins = import ./nix/oxlint-with-plugins.nix {
              inherit pkgs oxlintNpm;
            };
            node-pty-native = nodePtyNative;
          }
          // pkgs.lib.mapAttrs' (name: package: {
            name = "${name}-candidate";
            value = package;
          }) buck2ProductCandidates
          // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
            # Hub containment capability: the exact Bubblewrap every Linux TypeScript action is
            # launched through. Darwin containment is not a Nix capability — it is the fixed
            # system `sandbox-exec` bound to the admitted macOS release — so this attribute is
            # deliberately Linux-only and the manifest capability is system-scoped to match.
            buck2-bubblewrap = pkgs.bubblewrap;
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
          buck-editor = import ./nix/devenv-modules/tasks/shared/buck-editor.nix;
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

      # Import the typed Node CLI/module products emitted by package-local Buck
      # targets, preserving each product's declared runtime capability boundary.
      lib.mkBuck2JavaScriptProductImport =
        { pkgs }: import ./nix/workspace-tools/lib/javascript-product-import.nix { inherit pkgs; };
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
      # Use this for releases/CI where hermetic Nix builds are needed.
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

      # Tracked, content-addressed Buck product artifacts (pure: reads only
      # committed bytes). Feed `.products` into lib.mkBuck2ProductCandidates.
      lib.trackedBuck2Products = { lib }: import ./nix/buck2-products { inherit lib; };

      # Note: mkSourceCli is internal-only (not exported).
      # For consuming CLIs from other repos, use:
      #   effectUtils.packages.${system}.genie
      #   effectUtils.packages.${system}.ci-tools
      #   effectUtils.packages.${system}.megarepo
      # See the stack-level Nix/devenv CLI distribution policy docs.
    };
}
