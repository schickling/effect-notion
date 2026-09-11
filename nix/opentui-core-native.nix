{ pkgs }:

let
  lib = pkgs.lib;
  packages = {
    aarch64-darwin = {
      name = "@opentui/core-darwin-arm64";
      url = "https://registry.npmjs.org/@opentui/core-darwin-arm64/-/core-darwin-arm64-0.5.11.tgz";
      hash = "sha512-DRXY5ioq+n1ZNAMAcaFaBunr0cmi2gqucjbTW7lgFp8t9uN3fNZnLTDOqkCTQtT2XhrU4GXqySaPSQ4qFG/EAQ==";
    };
    x86_64-darwin = {
      name = "@opentui/core-darwin-x64";
      url = "https://registry.npmjs.org/@opentui/core-darwin-x64/-/core-darwin-x64-0.5.11.tgz";
      hash = "sha512-yP/8GliJDiJNm8YYJKvgWuy6xyCEd8d4GwBVOIzCFOI7ZIbGP8GOTvmwIjRW4Paw20pTttWMWyRoQiCvOXvH2g==";
    };
    aarch64-linux = {
      name = "@opentui/core-linux-arm64";
      url = "https://registry.npmjs.org/@opentui/core-linux-arm64/-/core-linux-arm64-0.5.11.tgz";
      hash = "sha512-zBIsRFHlLUYFNhapRSNt9dz4mC8gZ4Wxcfy3A+2AwqsgCipcr2FkIuAXYqN08q+IvqFX7DfqgIFGWDNedHTPUg==";
    };
    x86_64-linux = {
      name = "@opentui/core-linux-x64";
      url = "https://registry.npmjs.org/@opentui/core-linux-x64/-/core-linux-x64-0.5.11.tgz";
      hash = "sha512-pSOXqOADrv+zINOgR3FDFA9zVRaim3zl8/yhtO+X9rEJ6f34z3gDund0Gf88hNJSMpZK5xWtipEVm28RY5VF8w==";
    };
  };
  muslPackages = {
    aarch64-linux = {
      name = "@opentui/core-linux-arm64-musl";
      url = "https://registry.npmjs.org/@opentui/core-linux-arm64-musl/-/core-linux-arm64-musl-0.5.11.tgz";
      hash = "sha512-x+xeR2LYibvIi/qQetRjJR008sFRve60QuDcO8ItxUwzFeKTDzl5CEiZpBXfm5I4FhRNuyuj0TSPIFadMvrjFQ==";
    };
    x86_64-linux = {
      name = "@opentui/core-linux-x64-musl";
      url = "https://registry.npmjs.org/@opentui/core-linux-x64-musl/-/core-linux-x64-musl-0.5.11.tgz";
      hash = "sha512-MyqOnSs8pTYG2xmFr1xt6xZIuHu2Xu4pkle9my9JdE+WClmusHf0YN9Eas6jQLAq5XUi34r22wMeK0juk93zyw==";
    };
  };
  mkPackage =
    spec:
    let
      tarball = pkgs.fetchurl {
        inherit (spec) url hash;
      };
      package =
        pkgs.runCommand (lib.strings.sanitizeDerivationName spec.name)
          { nativeBuildInputs = [ pkgs.gnutar ]; }
          ''
            mkdir -p "$out"
            tar -xzf ${tarball} --strip-components=1 -C "$out"
          '';
    in
    {
      inherit (spec) name;
      inherit package;
    };
  spec =
    packages.${pkgs.stdenv.hostPlatform.system}
      or (throw "opentui-core-native: unsupported system ${pkgs.stdenv.hostPlatform.system}");
  primary = mkPackage spec;
  musl = muslPackages.${pkgs.stdenv.hostPlatform.system} or null;
in
primary
// {
  packages = [ primary ] ++ lib.optional (musl != null) (mkPackage musl);
}
