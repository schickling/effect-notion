# Package Restate's official PREBUILT release binaries (no compilation).
#
# We wrap the official prebuilt binaries from the GitHub release instead of
# nixpkgs' `restate` (which builds from source: heavy, uncached, and unfree
# BSL-1.1). This gives a Docker-free, Nix-idiomatic Restate runtime on $PATH.
#
# Exposes BOTH binaries in $out/bin:
#   - restate-server  (the durable execution server)
#   - restate         (the CLI; the `restate-cli-*` archive ships it as `restate`)
# (`restatectl` is intentionally omitted for now.)
#
# Usage:
#   restate = import ./restate.nix { inherit pkgs; };
#   # => restate-server and restate on PATH
#
# =============================================================================
# Updating to a new version
# =============================================================================
#
# 1. Bump `version` below to the new release tag (without the leading `v`).
#
# 2. For x86_64-linux, download + hash the real tarballs into the store:
#      BASE="https://github.com/restatedev/restate/releases/download/v<version>"
#      nix store prefetch-file --json "$BASE/restate-server-x86_64-unknown-linux-musl.tar.xz"
#      nix store prefetch-file --json "$BASE/restate-cli-x86_64-unknown-linux-musl.tar.xz"
#
# 3. For the other systems, fetch the tiny `.sha256` sidecars (avoid the big
#    tarballs) and convert hex -> SRI:
#      curl -sL "$BASE/<asset>.tar.xz.sha256" | awk '{print $1}'
#      nix hash convert --hash-algo sha256 --to sri <hex>
#    If a `.sha256` sidecar 404s, fall back to prefetching that tarball.
#
# 4. Update the `hashes` attrset below.
#
# =============================================================================
{ pkgs }:

let
  lib = pkgs.lib;

  # https://github.com/restatedev/restate/releases for the latest version.
  version = "1.7.9";

  baseUrl = "https://github.com/restatedev/restate/releases/download/v${version}";

  # nix system -> Rust target triple used in the release asset names.
  rustTargets = {
    x86_64-linux = "x86_64-unknown-linux-musl";
    aarch64-linux = "aarch64-unknown-linux-musl";
    x86_64-darwin = "x86_64-apple-darwin";
    aarch64-darwin = "aarch64-apple-darwin";
  };

  # Per-system SRI hashes for the `restate-server-*` and `restate-cli-*` tarballs.
  # x86_64-linux hashes are from real prefetched tarballs (this build host);
  # the rest are derived from the assets' `.sha256` sidecars.
  hashes = {
    x86_64-linux = {
      server = "sha256-w25mCaWRqqWRTdIRQySednRXBLVx1KVzXBymwgsTvc8=";
      cli = "sha256-qwW8Y9FrZGotwntTinkNm0SURW8hDHkljhxt2nQACEY=";
    };
    aarch64-linux = {
      server = "sha256-W2nHwKblW7cIApJM6CLqCUPYLZtsrBV/JOuF14jTWXY=";
      cli = "sha256-KqMeIY6yoAcmYY3PZlknuQdIq9qAi/Tqn5rd3HFogAs=";
    };
    x86_64-darwin = {
      server = "sha256-z8fNLoZwvsBivx53H2fuKDQuvxNm6e3K8MBydPCZfLo=";
      cli = "sha256-kANn4FvAbtXMchwGPvp250MWSxFGciG7g7m0hsy9i/E=";
    };
    aarch64-darwin = {
      server = "sha256-7bK3N1Jf/cXc0kSdB0IVr78EFKx7Qf/+Dwu3h4UixYw=";
      cli = "sha256-VY2ZoGLFeGLJryo5Di2yEKGZ/YNmo+BAH82maiHcRYw=";
    };
  };

  system = pkgs.stdenv.hostPlatform.system;
  rustTarget = rustTargets.${system} or (throw "restate: unsupported system ${system}");
  systemHashes = hashes.${system} or (throw "restate: no hashes for system ${system}");

  serverTarball = pkgs.fetchurl {
    url = "${baseUrl}/restate-server-${rustTarget}.tar.xz";
    hash = systemHashes.server;
  };

  cliTarball = pkgs.fetchurl {
    url = "${baseUrl}/restate-cli-${rustTarget}.tar.xz";
    hash = systemHashes.cli;
  };
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "restate";
  inherit version;

  # Each tarball is unpacked explicitly in installPhase (they have different
  # top-level dirs), so no generic unpack.
  dontUnpack = true;

  # Harmless for the static musl Linux binaries; needed only if a future
  # release ships dynamically-linked binaries. No-op on Darwin.
  nativeBuildInputs = lib.optionals pkgs.stdenv.isLinux [ pkgs.autoPatchelfHook ];

  installPhase = ''
    runHook preInstall

    tar -xJf ${serverTarball}
    tar -xJf ${cliTarball}

    install -Dm755 restate-server-${rustTarget}/restate-server $out/bin/restate-server
    install -Dm755 restate-cli-${rustTarget}/restate $out/bin/restate

    runHook postInstall
  '';

  meta = {
    description = "Restate durable execution server + CLI (official prebuilt binaries)";
    homepage = "https://restate.dev";
    mainProgram = "restate-server";
    license = lib.licenses.bsl11;
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
      "x86_64-darwin"
      "aarch64-darwin"
    ];
  };
}
