# Storybook tasks and processes
#
# Usage in devenv.nix:
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.storybook {
#       packages = [
#         { path = "packages/@overeng/tui-react"; name = "tui-react"; port = 6006; }
#         { path = "packages/@overeng/megarepo"; name = "megarepo"; port = 6007; }
#       ];
#       # Optional: install task name (default: "pnpm:install")
#       installTask = "pnpm:install";
#     })
#   ];
#
# Provides:
#   Tasks:
#     - storybook:build:<name> - Build storybook for specific package
#     - storybook:build - Aggregate task to build all storybooks
#   Processes (for dev servers):
#     - storybook-<name>-<port> - Run with: devenv up storybook-<name>-<port>
#
# Port allocation:
#   Uses devenv's automatic port allocation (processes.<name>.ports.<port>.allocate)
#   to avoid conflicts when running multiple storybooks or multiple devenv instances.
#   The port specified in the package config is the base port; if unavailable,
#   devenv will automatically find the next available port.
{
  targets ? [ ],
  packages ? [ ],
  legacy ? false,
  installTask ? "pnpm:install",
  extraInstallTasks ? [ ],
}:
{
  lib,
  config,
  pkgs,
  ...
}:
let
  trace = import ../lib/trace.nix { inherit lib; };
  cliGuard = import ../lib/cli-guard.nix { inherit pkgs; };
  pnpmTaskHelpersScript = pkgs.writeText "pnpm-task-helpers.sh" (
    builtins.readFile ./pnpm-task-helpers.sh
  );
  hasPackages = packages != [ ];
  buckCommand = label: ''
    root="''${DEVENV_ROOT:-$PWD}"
    workspace_root="$(${pkgs.coreutils}/bin/realpath "$root/../..")"
    "$workspace_root/.megarepo/bin/buck2" ${label}
  '';

  mkBuildTask = pkg: {
    "storybook:build:${pkg.name}" = {
      description = "Build storybook for ${pkg.name}";
      exec = trace.exec "storybook:build:${pkg.name}" ''
        set -euo pipefail
        export PNPM_LEGACY_NODE_MODULES=1
        source ${lib.escapeShellArg pnpmTaskHelpersScript}
        run_package_bin storybook storybook build
      '';
      cwd = pkg.path;
      after = [ installTask ] ++ extraInstallTasks;
    };
  };

  # Dev servers as processes (long-running, with TUI via process-compose)
  # Uses automatic port allocation to avoid conflicts
  # --host 0.0.0.0 allows access from other machines (useful for remote dev environments)
  # --no-open prevents auto-opening browser tabs
  # --ci disables interactive prompts (defense-in-depth: if the devenv-allocated port is
  #   unexpectedly taken, storybook auto-selects a free port instead of hanging on a prompt)
  # Process name includes port for visibility in process-compose TUI
  processName = pkg: "storybook-${pkg.name}-${toString pkg.port}";

  # Get the allocated port from config at Nix evaluation time
  # This follows the same pattern as postgres.nix in devenv
  getAllocatedPort = pkg: config.processes.${processName pkg}.ports.http.value;

  mkProcess = pkg: {
    "${processName pkg}" = {
      ports.http.allocate = pkg.port;
      exec = trace.exec "process:${processName pkg}" ''
        export DEVENV_TASK_PASSTHROUGH=1
        export PNPM_LEGACY_NODE_MODULES=1
        _host="''${TS_HOSTNAME:-localhost}"
        echo "[storybook] ${pkg.name}: http://$_host:${toString (getAllocatedPort pkg)}"
        source ${lib.escapeShellArg pnpmTaskHelpersScript}
        run_package_bin storybook storybook dev -p ${toString (getAllocatedPort pkg)} --host 0.0.0.0 --no-open --ci --exact-port
      '';
      cwd = pkg.path;
    };
  };

  mkBuckBuildTask = target: {
    "storybook:build:${target.name}" = {
      description = "Build storybook for ${target.name} through Buck";
      after = target.after or [ ];
      exec = trace.exec "storybook:build:${target.name}" ''
        set -euo pipefail
        ${buckCommand "build ${lib.escapeShellArg target.buildLabel}"}
      '';
    };
  };
  mkBuckProcess = target: {
    "${processName target}" = {
      ports.http.allocate = target.port;
      exec = trace.exec "process:${processName target}" ''
        set -euo pipefail
        _host="''${TS_HOSTNAME:-localhost}"
        _port=${toString (getAllocatedPort target)}
        echo "[storybook] ${target.name}: http://$_host:$_port"
        ${buckCommand "run ${lib.escapeShellArg target.devLabel} -- --port \"$_port\" --host 0.0.0.0 --no-open --ci --exact-port"}
      '';
    };
  };
in
assert lib.assertMsg (
  legacy || targets != [ ]
) "storybook.nix Buck mode requires at least one explicit target";
{
  tasks =
    if legacy then
      lib.mkMerge (
        (if hasPackages then map (pkg: cliGuard.stripGuards (mkBuildTask pkg)) packages else [ ])
        ++ [
          (cliGuard.stripGuards {
            "storybook:build" = {
              description = "Build all storybooks";
              exec = null;
              after = if hasPackages then map (pkg: "storybook:build:${pkg.name}") packages else [ ];
            };
          })
        ]
      )
    else
      lib.mkMerge (
        (map mkBuckBuildTask targets)
        ++ [
          {
            "storybook:build" = {
              description = "Build all Buck-owned storybooks";
              after = map (target: "storybook:build:${target.name}") targets;
            };
          }
        ]
      );

  processes = lib.mkMerge (
    if legacy then (if hasPackages then map mkProcess packages else [ ]) else map mkBuckProcess targets
  );
}
