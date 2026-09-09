{ pkgs }:
# The hub's Go capability is the OFFICIAL Go release archive, not `pkgs.go`.
#
# nixpkgs patches Go's own standard-library sources with four absolute store
# paths (`mime/type_unix.go` -> mailcap, `time/zoneinfo_unix.go` -> tzdata,
# `net/{port,lookup}_unix.go` -> iana-etc, `internal/buildcfg/zbootstrap.go` ->
# glibc's loader), so every binary compiled with it inherits three of them and
# `nix/workspace-tools/lib/buck2-artifact-scan.nix`'s categorical
# store-reference prohibition rejects the product at import. The official
# archive carries none, which keeps `elf-static/v1` reachable with zero added
# inspector lines. Ratified as decision 0029.
#
# Same shape as `nix/buck2.nix`: one `fetchurl` per admitted platform, pinned by
# the `sha256` published in https://go.dev/dl/?mode=json. No `autoPatchelfHook`:
# the distribution's `bin/go` and every `pkg/tool/*` binary are statically
# linked, so they run unmodified on NixOS and nothing rewrites the tree.
let
  release = {
    version = "1.27.1";
    baseUrl = "https://go.dev/dl";
    platforms = {
      x86_64-linux = {
        goPlatform = "linux-amd64";
        hash = "sha256-Y9M58NpatTY1pW8kkKeYTf4S38/yKtdJ9j7a9ZAWhEU=";
      };
      aarch64-linux = {
        goPlatform = "linux-arm64";
        hash = "sha256-NFC0Wj+e6FaHknNqXF5wofLps2w1qPdJWMA+UdfZK+w=";
      };
      aarch64-darwin = {
        goPlatform = "darwin-arm64";
        hash = "sha256-7iFdV+DsJpxgzJzspo5r2jIbqe5a/iT0sJiHA8LYfRI=";
      };
    };
  };
  system = pkgs.stdenv.hostPlatform.system;
  platform =
    release.platforms.${system}
      or (throw "Go release ${release.version} is not admitted for ${system}");
  archive = pkgs.fetchurl {
    url = "${release.baseUrl}/go${release.version}.${platform.goPlatform}.tar.gz";
    inherit (platform) hash;
  };
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "go-official";
  version = release.version;
  src = archive;
  sourceRoot = "go";

  dontConfigure = true;
  dontBuild = true;
  # The distribution ships its own toolchain binaries and, under `src/debug`,
  # deliberately malformed ELF test fixtures. Nothing here may be rewritten:
  # a patched or stripped tree is a different toolchain than the published one,
  # and byte-identical products across the fleet are the point.
  dontStrip = true;
  dontPatchELF = true;
  dontFixup = true;

  installPhase = ''
    runHook preInstall
    mkdir -p "$out"
    cp -a . "$out/"
    runHook postInstall
  '';

  # Fail closed on the single property this derivation exists for.
  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck

    "$out/bin/go" version

    offenders="$(grep -rIl --binary-files=without-match /nix/store/ "$out/src" || true)"
    if [ -n "$offenders" ]; then
      echo "official Go distribution references the Nix store in its stdlib sources:" >&2
      echo "$offenders" >&2
      exit 1
    fi

    runHook postInstallCheck
  '';

  passthru = {
    inherit (release) version;
    inherit (platform) goPlatform;
  };

  meta = {
    description = "Official Go ${release.version} release archive for ${platform.goPlatform}";
    homepage = "https://go.dev/dl/";
    license = pkgs.lib.licenses.bsd3;
    platforms = builtins.attrNames release.platforms;
    mainProgram = "go";
  };
}
