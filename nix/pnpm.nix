{ pkgs }:

# Pinned pnpm version for the entire megarepo ecosystem.
# This is the SSOT for the pnpm CLI version — all downstream repos should use
# this instead of pkgs.pnpm to ensure consistent behavior across devenv shells,
# CI, and Nix builds.
#
# The version here MUST match DEFAULT_AGGREGATE_PACKAGE_MANAGER in
# packages/@overeng/genie/src/runtime/package-json/mod.ts.
#
# pnpm 12 is a native (Rust) executable. The `pnpm` npm package no longer
# contains the CLI: it carries the Corepack entrypoint (`bin/pnpm.mjs`), the
# `sh` placeholder bins, and the bundled `dist/` payload (node-gyp), while the
# executable ships in a per-host `@pnpm/exe.<target>` package declared as an
# optional dependency. `pkgs.pnpm` builds the pre-12 JavaScript layout, so this
# assembles the published layout directly instead of overriding it: the native
# binary is placed at the wrapper root exactly where the upstream `install.js`
# preinstall hard-links it, so both the binary's own `dist/` lookup and
# `bin/pnpm.mjs`'s `resolveInstalledBinary()` keep working without any
# lifecycle script or network access at build time.
let
  lib = pkgs.lib;
  version = "12.3.4";

  platform = pkgs.stdenv.hostPlatform;

  unsupportedPlatform =
    throw "nix/pnpm.nix: pnpm ${version} ships no native binary for ${platform.system}";
  target =
    if platform.system == "aarch64-darwin" then
      "darwin-arm64"
    else if platform.system == "x86_64-darwin" then
      "darwin-x64"
    else if platform.system == "aarch64-linux" then
      if platform.isMusl then "linux-arm64-musl" else "linux-arm64"
    else if platform.system == "x86_64-linux" then
      if platform.isMusl then "linux-x64-musl" else "linux-x64"
    else
      unsupportedPlatform;

  exeHashes = {
    "linux-x64" = "sha256-mxyV/EE2AMp1pR6+gzLXAZ3DVo/UGH9aXy30oVbvtlw=";
    "linux-arm64" = "sha256-q1Nm6VLbwoETQhp8fd/bBMm7ZClYuPU+pVg4VEJr1I0=";
    "linux-x64-musl" = "sha256-SsTn+4Czuk/7DkQ62rVTnedYHV2g8pUBhZsweFcxqg4=";
    "linux-arm64-musl" = "sha256-CF9jicQSEF2+GKQgmsNaKzVehXRM1bhGlwvCH6pJoiw=";
    "darwin-x64" = "sha256-3kEPwxUxsbekQMjoDeHPdmPMMp/lMKUjJIIT8bL5bK8=";
    "darwin-arm64" = "sha256-9UrTZ9ikLa+dhIMOS9akXAlX4OMoekXaCMOguNBOx/c=";
  };

  wrapperSrc = pkgs.fetchurl {
    url = "https://registry.npmjs.org/pnpm/-/pnpm-${version}.tgz";
    hash = "sha256-CKPS1Tmzd6a36iRpthJnIlXKccMKYmmFMFgsudNcJo8=";
  };

  exeSrc = pkgs.fetchurl {
    url = "https://registry.npmjs.org/@pnpm/exe.${target}/-/exe.${target}-${version}.tgz";
    hash = exeHashes.${target};
  };
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "pnpm";
  inherit version;

  dontUnpack = true;

  nativeBuildInputs = [ pkgs.makeWrapper ] ++ lib.optional platform.isLinux pkgs.autoPatchelfHook;
  buildInputs = lib.optional platform.isLinux (lib.getLib pkgs.stdenv.cc.cc);

  installPhase = ''
    runHook preInstall

    wrapper=$out/libexec/pnpm
    mkdir -p "$wrapper"
    tar -xzf ${wrapperSrc} -C "$wrapper" --strip-components=1

    # The published `pnpm` file is the shebang-less placeholder that upstream's
    # preinstall replaces with the native binary; do that replacement here.
    rm "$wrapper/pnpm"
    tar -xzf ${exeSrc} -C "$wrapper" --strip-components=1 package/pnpm
    chmod +x "$wrapper/pnpm"

    # `bin/pnpm.mjs` (Corepack's entrypoint, and the one mk-pnpm-deps invokes
    # through PNPM_MJS) only looks for the binary inside the platform package,
    # so point that location at the single copy.
    exeDir=$wrapper/node_modules/@pnpm/exe.${target}
    mkdir -p "$exeDir"
    ln -s ../../../pnpm "$exeDir/pnpm"

    chmod +x "$wrapper/bin/pnpm.mjs" "$wrapper/bin/pnpx.mjs"

    makeWrapper "$wrapper/pnpm" $out/bin/pnpm
    makeWrapper "$wrapper/pnpm" $out/bin/pn
    makeWrapper "$wrapper/pnpm" $out/bin/pnpx --add-flags dlx
    makeWrapper "$wrapper/pnpm" $out/bin/pnx --add-flags dlx

    runHook postInstall
  '';

  meta = {
    description = "Fast, disk space efficient package manager (pinned megarepo build)";
    homepage = "https://pnpm.io";
    license = lib.licenses.mit;
    mainProgram = "pnpm";
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
      "x86_64-darwin"
      "aarch64-darwin"
    ];
  };
}
