# Nix derivation that builds notion CLI binary.
# Uses bun build --compile for native platform.
{
  pkgs,
  src,
  gitRev ? "unknown",
  commitTs ? 0,
  dirty ? false,
}:

let
  mkSharedHash = hash: { inherit hash; };
  pnpm = import ../../../../nix/pnpm.nix { inherit pkgs; };
  mkPnpmCli = import ../../../../nix/workspace-tools/lib/mk-pnpm-cli.nix { inherit pkgs pnpm; };
  opentuiCoreNative = import ../../../../nix/opentui-core-native.nix { inherit pkgs; };
  nodejs = pkgs.nodejs_24 or pkgs.nodejs;
  datasourceSyncBuildStamp = builtins.toJSON {
    type = "nix";
    version = "0.1.0";
    rev = gitRev;
    inherit commitTs dirty;
  };
  unwrapped = mkPnpmCli {
    name = "notion-cli-unwrapped";
    entry = "packages/@overeng/notion-cli/src/cli.ts";
    binaryName = "notion";
    packageDir = "packages/@overeng/notion-cli";
    workspaceRoot = src;
    smokeTestArgs = [
      "md"
      "--help"
    ];
    installRuntimeWorkspace = true;
    # Managed by the repo FOD refresh workflow — do not edit manually.
    depsBuilds = {
      "." = mkSharedHash "sha256-Sa/ZqMvTcfu87c1NCiAQT0QgX71pNnKTpmqiQbD4WCs=";
    };
    nativeNodePackages = opentuiCoreNative.packages;
    inherit gitRev commitTs dirty;
  };
  notionDbRuntime = pkgs.writeShellScriptBin "notion-db-runtime" ''
    export CLI_BUILD_STAMP=${pkgs.lib.escapeShellArg datasourceSyncBuildStamp}
    exec ${nodejs}/bin/node ${unwrapped}/libexec/workspace/packages/@overeng/notion-datasource-sync/src/cli/main.ts "$@"
  '';
in
pkgs.runCommand "notion-cli"
  {
    nativeBuildInputs = [ pkgs.makeWrapper ];
    meta.mainProgram = "notion";
    passthru = {
      inherit (unwrapped.passthru)
        depsBuildEntries
        depsBuildsByInstallRoot
        fodHashRepairTargets
        installRoots
        ;
    };
  }
  ''
    mkdir -p $out/bin
    makeWrapper ${unwrapped}/bin/notion $out/bin/notion \
      --run 'if [ "$#" -gt 1 ] && [ "$1" = db ]; then case "$2" in init|pull|push|sync|export|status|conflicts|forget|restore|doctor) shift; exec ${notionDbRuntime}/bin/notion-db-runtime "$@";; esac; fi'

    db_output="$($out/bin/notion db sync --help 2>&1 || true)"
    if ! printf '%s\n' "$db_output" | grep -q 'Reconcile an established workspace'; then
      printf '%s\n' "$db_output" >&2
      echo "notion db sync smoke test failed" >&2
      exit 1
    fi
  ''
