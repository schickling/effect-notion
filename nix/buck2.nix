# Repo-local Buck2 package authority: keep nixpkgs' native-binary derivation
# (unpackCmd/autoPatchelf/installPhase/completions) and replace only the pinned
# release assets plus the compatible Prelude passthru.
#
# CONTRACT: nixpkgs' inherited `installPhase` installs one binary per entry of
# its own `binaries` list and fails hard (`install` with no source operand) if a
# corresponding release asset is missing from `srcs`. So `srcs` must stay a
# SUPERSET of that list. nixpkgs added `starlark_fmt` as a third binary, so the
# asset list below carries it too; when bumping the pin, check upstream's
# `pkgs/by-name/bu/buck2/package.nix` `binaries` list for new entries.
{ pkgs }:
let
  release = rec {
    version = "2026-09-01";
    releaseBaseUrl = "https://github.com/facebook/buck2/releases/download/${version}";
    prelude = rec {
      revision = "1f8c24e0b1f85e645011f93a4073b0c6c762d7b1";
      url = "https://github.com/facebook/buck2-prelude/archive/${revision}.tar.gz";
      hash = "sha256-iwXAuHXXfw/FsR0N2CMR0GXHg1I2BHlhZ2orM7z9qas=";
    };
    platforms = {
      x86_64-linux = {
        executionPlatform = "x86_64-linux";
        suffix = "x86_64-unknown-linux-gnu";
        buck2Hash = "sha256-3JRHvS4Thg/BVwAaGAPFGMCFRE3MbGVGDZ0fVRVLMqM=";
        rustProjectHash = "sha256-jNF1qQNhFmy6o0RAXODgjrCwxV8IX3LERUAzFdtuELM=";
        starlarkFmtHash = "sha256-jUQXVSDoS44JDAjcSBXwwwVQfoOIzFwWWoTZuEtKen8=";
      };
      aarch64-linux = {
        executionPlatform = "aarch64-linux";
        suffix = "aarch64-unknown-linux-gnu";
        buck2Hash = "sha256-287nXbAMVX3y27OCxrW+FkPAhrh9kkqrcGCZinptWAE=";
        rustProjectHash = "sha256-Mk5hgW6OhODKHI/urBnXUZSjR2lrIlDDzrZBUgUUsmw=";
        starlarkFmtHash = "sha256-gkqGiT8Qr+jRN3uEtNxZWvdBQw9I/gjs3FMtB2GrFxI=";
      };
      aarch64-darwin = {
        executionPlatform = "aarch64-macos";
        suffix = "aarch64-apple-darwin";
        buck2Hash = "sha256-CWLKffGnawcHxro/8SFtMUMdSTrjfvAB6ptC9KdBCck=";
        rustProjectHash = "sha256-t0D+YOjlFSQR+eKaQ97Zb4jbor0IkthqZgPtpLymG4E=";
        starlarkFmtHash = "sha256-CIJ6XFRuW2AKZJYjSNOu5fGzJfkRnkTsUaWfCrmbBBY=";
      };
    };
  };
  system = pkgs.stdenv.hostPlatform.system;
  platform =
    release.platforms.${system}
      or (throw "Buck2 release ${release.version} does not support ${system}");
in
pkgs.buck2.overrideAttrs (oldAttrs: {
  version = "unstable-${release.version}";
  srcs = [
    (pkgs.fetchurl {
      url = "${release.releaseBaseUrl}/buck2-${platform.suffix}.zst";
      hash = platform.buck2Hash;
    })
    (pkgs.fetchurl {
      url = "${release.releaseBaseUrl}/rust-project-${platform.suffix}.zst";
      hash = platform.rustProjectHash;
    })
    (pkgs.fetchurl {
      url = "${release.releaseBaseUrl}/starlark_fmt-${platform.suffix}.zst";
      hash = platform.starlarkFmtHash;
    })
  ];
  passthru = oldAttrs.passthru // {
    inherit (platform) executionPlatform;
    prelude = pkgs.fetchurl {
      inherit (release.prelude) url hash;
    };
  };
})
