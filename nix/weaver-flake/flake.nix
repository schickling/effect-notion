{
  # Standalone flake packaging OpenTelemetry Weaver
  # (https://github.com/open-telemetry/weaver).
  #
  # Built from source (not re-exported from nixpkgs) so we can track the LATEST
  # upstream release. nixpkgs currently pins 0.23.0; building ourselves lets us
  # stay ahead of that. This flake targets v0.24.2.
  #
  # nixpkgs (nixos-unstable — same authority as the repo root) is used only for the
  # build toolchain (rustPlatform, pnpm, node, openssl, python) - the Weaver sources
  # come from `src` below.
  #
  # Weaver bundles a Vite/pnpm web UI whose built output (`ui/dist`) is embedded
  # into the binary at compile time via `include_dir!("ui/dist")`, so the UI
  # MUST be built before the Rust compile (mirrors the nixpkgs derivation:
  # fetchPnpmDeps + `pnpm build` in preBuild). protoc is NOT required - upstream
  # vendors the generated gRPC stubs to avoid a protoc build dependency.
  #
  # The nixpkgs derivation carries meta.mainProgram = "weaver", which we keep so
  # `nix run` resolves the binary.
  #
  # Bumping the version:
  #   1. Find the newest tag: `gh release list --repo open-telemetry/weaver`.
  #   2. Set `version` below to the new tag (without the leading `v`).
  #   3. Refresh the source hash without compiling:
  #        nix run nixpkgs#nurl -- https://github.com/open-telemetry/weaver v<version>
  #      and paste the printed `hash` into `src.hash`.
  #   4. Refresh the pnpm deps hash. Easiest: set `pnpmDeps.hash` to
  #      lib.fakeHash, run `nix build .#weaver`, and copy the `got:` hash from
  #      the fixed-output-derivation mismatch (this FOD fails fast, before the
  #      Rust compile). Or use the evergreen FOD workflow.
  #   5. Cargo deps use `cargoLock.lockFile` (the committed Cargo.lock), so no
  #      cargoHash refresh is needed - as long as upstream Cargo.lock has no git
  #      dependencies (`grep 'source = "git' Cargo.lock`). If it grows git deps,
  #      switch to `cargoHash`/`outputHashes`.
  #
  # Mirrors the nix/playwright-flake/ standalone-flake convention.
  description = "OpenTelemetry Weaver, built from source (latest upstream)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { nixpkgs, ... }:
    let
      lib = nixpkgs.lib;
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: lib.genAttrs systems (system: f system);

      version = "0.24.2";

      # Pinned upstream OTel semantic-conventions registry — materialized as a Nix
      # fixed-output derivation so the weaver gate resolves `http.*` (and other upstream)
      # refs against a LOCAL, deterministic, offline copy (SC-A03; confirmed: weaver 0.24.2
      # accepts a local-filesystem `registry_path` pointing directly at the `model/` dir).
      # v1.37.0 is verified clean under `--future` with weaver 0.24.2 (≤v1.36 fail on their
      # own unstructured `deprecated:`). Refresh on bump with:
      #   nix run nixpkgs#nurl -- https://github.com/open-telemetry/semantic-conventions v<ver>
      semconvVersion = "1.37.0";
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          pnpm = pkgs.pnpm_10;

          src = pkgs.fetchFromGitHub {
            owner = "open-telemetry";
            repo = "weaver";
            tag = "v${version}";
            hash = "sha256-Yyw7YTwndmNdNu4/5J7v9RJFKAYaO0RS06B4BWwXteE=";
          };

          semconvSrc = pkgs.fetchFromGitHub {
            owner = "open-telemetry";
            repo = "semantic-conventions";
            tag = "v${semconvVersion}";
            hash = "sha256-anSQASvg8SlLR3d3ArKZk5iCx+37F+NidK6jT3gFmpA=";
          };

          # Just the `model/` subtree — the directory weaver's `registry_path` points at.
          semconv-model = pkgs.runCommand "semconv-model-${semconvVersion}" { } ''
            cp -r ${semconvSrc}/model $out
          '';

          weaver = pkgs.rustPlatform.buildRustPackage {
            pname = "weaver";
            inherit version src;

            # Cargo.lock is committed upstream and has no git dependencies, so
            # the lockfile fully determines the vendored deps - no cargoHash FOD.
            cargoLock.lockFile = "${src}/Cargo.lock";

            # The web UI (Vite/pnpm) is embedded into the binary at compile time,
            # so its dependencies are fetched as a fixed-output derivation and
            # built (`pnpm build`) before the Rust compile in preBuild below.
            pnpmDeps = pkgs.fetchPnpmDeps {
              pname = "weaver-ui";
              inherit version src pnpm;
              sourceRoot = "${src.name}/ui";
              fetcherVersion = 3;
              hash = "sha256-Wy3PsnQVfn7R80WmPFEinMDApzkyiXnca3sfUYYYH10=";
            };
            pnpmRoot = "ui";

            buildInputs = [ pkgs.openssl ];

            nativeBuildInputs = [
              pkgs.installShellFiles
              pkgs.pkg-config
              pkgs.nodejs
              pkgs.pnpmConfigHook
              pnpm
              pkgs.python3
            ];

            env = {
              CXXFLAGS = "-std=c++20";
              # Use system openssl (buildInputs) rather than the vendored copy.
              OPENSSL_NO_VENDOR = true;
            };

            preBuild = ''
              pushd ui
              pnpm build
              popd
            '';

            # Verification here is `weaver --version` / `weaver registry --help`,
            # not the upstream test suite (which includes network-dependent
            # cases). Skipping checks avoids a large, flaky test phase.
            doCheck = false;

            postInstall = lib.optionalString (pkgs.stdenv.buildPlatform.canExecute pkgs.stdenv.hostPlatform) ''
              installShellCompletion --cmd weaver \
                --bash <($out/bin/weaver completion bash) \
                --zsh <($out/bin/weaver completion zsh) \
                --fish <($out/bin/weaver completion fish)
            '';

            meta = {
              description = "OpenTelemetry tool for semantic conventions and application telemetry schemas";
              homepage = "https://github.com/open-telemetry/weaver";
              changelog = "https://github.com/open-telemetry/weaver/releases/tag/v${version}";
              license = lib.licenses.asl20;
              mainProgram = "weaver";
            };
          };
        in
        {
          inherit weaver semconv-model;
          default = weaver;
        }
      );
    };
}
