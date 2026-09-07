# SecretSpec tasks — a thin composition over SecretSpec 0.20.
#
# Repos commit a `secretspec.toml` with standard SecretSpec declarations. Native
# SecretSpec owns everything about them: manifest loading and `extends`, profile
# compilation, requiredness, deterministic planning, provider selection,
# resolved-over-ambient environment semantics, and reason/caller policy. This
# module only names three task-shaped compositions on top of it:
#
#   secrets:check    -> secretspec check --explain   (value-free resolution report)
#   secrets:prefetch -> secretspec run -- true       (one resolution of the selected profile)
#   secrets-run CMD  -> secretspec run -- CMD        (direct run through the provider)
#
# Nothing here parses the manifest, discovers it by walking up from the cwd,
# reads individual references, skips or filters environment variables, exports
# values, or re-implements provider/profile/reason precedence. Provider-backed
# values (e.g. the op-proxy provider) are resolved by the provider in one call
# per selected profile and cached by the provider, not here.
{
  file ? "secretspec.toml",
}:
{ lib, pkgs, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
  secretspec = "${pkgs.secretspec}/bin/secretspec";
  escapedFile = lib.escapeShellArg file;

  # `secrets-run` is a passthrough into `secretspec run`: every native flag
  # (-P/--profile, -p/--provider, -S/--scope, --reason, --caller*, -f/--file)
  # and every SECRETSPEC_* environment channel keeps its own precedence. The one
  # thing this wrapper owns is defaulting the manifest to the repo's, and only
  # when the caller did not select one and the repo actually has it.
  secretsRun = pkgs.writeShellApplication {
    name = "secrets-run";
    text = ''
      set -euo pipefail

      if [ "$#" -eq 0 ]; then
        printf '%s\n' \
          'Usage: secrets-run [secretspec flags] [--] command [args...]' \
          "" \
          'Runs a command through "secretspec run", resolving the selected profile' \
          'once through the configured provider. Flags are forwarded verbatim to' \
          'SecretSpec, for example:' \
          '  -P, --profile NAME    -p, --provider NAME    -S, --scope NAME' \
          '      --reason TEXT         --caller NAME      -f, --file PATH' >&2
        exit 2
      fi

      if [ -z "''${SECRETSPEC_FILE:-}" ] && [ -f ${escapedFile} ]; then
        export SECRETSPEC_FILE=${escapedFile}
      fi

      exec ${secretspec} run "$@"
    '';
  };
in
{
  packages = [
    pkgs.secretspec
    secretsRun
  ];

  tasks = {
    "secrets:check" = {
      description = "Value-free SecretSpec resolution report for the selected profile";
      exec = trace.exec "secrets:check" ''
        set -euo pipefail
        if [ ! -f ${escapedFile} ]; then
          echo "No ${file}; nothing to check."
          exit 0
        fi
        export SECRETSPEC_REASON="''${SECRETSPEC_REASON:-devenv secrets:check}"
        ${secretspec} --file ${escapedFile} check --explain
      '';
    };

    "secrets:prefetch" = {
      description = "Resolve the selected profile once so later commands reuse the approval";
      exec = trace.exec "secrets:prefetch" ''
        set -euo pipefail
        if [ ! -f ${escapedFile} ]; then
          echo "No ${file}; nothing to prefetch."
          exit 0
        fi
        export SECRETSPEC_REASON="''${SECRETSPEC_REASON:-devenv secrets:prefetch}"
        ${secretspec} --file ${escapedFile} run -- true
      '';
    };
  };
}
