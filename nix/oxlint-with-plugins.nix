# Wrapper around oxlint-npm that points the @overeng/oxc-config JS plugin entry at
# a resolvable implementation.
#
# When the project's .oxlintrc.json (or an explicit -c config) contains overeng/*
# rules, this wrapper rewrites that config's `jsPlugins` entry for our plugin to a
# concrete path, via an injected config copy. Projects without overeng rules get
# plain pass-through.
#
# The rewrite SUBSTITUTES our entry and leaves every other `jsPlugins` entry
# alone, so third-party JS plugins (e.g. `@stylexjs/eslint-plugin`) declared next
# to ours still resolve.
#
# Plugin source selection:
#   default                        the Nix-built plugin snapshot (hermetic)
#   OVERENG_OXC_CONFIG_PLUGIN=<p>  use <p> instead — point it at
#                                  packages/@overeng/oxc-config/src/mod.ts to lint
#                                  against live plugin source (rule development;
#                                  no Nix rebuild between edits)
#
# Usage:
#   oxlintWithPlugins = import ./oxlint-with-plugins.nix { inherit pkgs; oxlintNpm = ...; };
#   # => provides `oxlint` on PATH with automatic plugin injection
{
  pkgs,
  oxlintNpm,
}:
assert oxlintNpm.pluginPath != null;
pkgs.writeShellApplication {
  name = "oxlint";
  runtimeInputs = [
    pkgs.jq
    pkgs.flock
  ];
  text = ''
    # Rule development escape hatch: the default plugin is a Nix build-time
    # snapshot, so edits to packages/@overeng/oxc-config/src/*.ts are invisible and
    # a newly added rule reports "not found in plugin 'overeng'". Overriding this
    # with the plugin's TypeScript entry point makes the wrapper lint against live
    # source (the host runtime is Bun, which imports .ts directly).
    pluginPath="''${OVERENG_OXC_CONFIG_PLUGIN:-${oxlintNpm.pluginPath}}"

    # Find the config file: explicit -c/--config arg, or default .oxlintrc.json
    config_file=""
    args=("$@")
    for ((i=0; i<''${#args[@]}; i++)); do
      case "''${args[$i]}" in
        -c|--config)
          config_file="''${args[$((i+1))]}"
          break
          ;;
      esac
    done
    if [ -z "$config_file" ] && [ -f .oxlintrc.json ]; then
      config_file=".oxlintrc.json"
    fi

    # If config has overeng rules, inject the Nix-built plugin path (replaces any existing jsPlugins)
    if [ -n "$config_file" ] && grep -q '"overeng/' "$config_file" 2>/dev/null; then
      # The injected copy is written into the SAME directory as the source config
      # (repo root for the default .oxlintrc.json). Under oxlint 1.39 this was
      # load-bearing for correctness: plugin rules only applied to files located
      # UNDER the injected config's directory, so a /tmp copy silently dropped
      # every overeng/* rule for the deep file paths CI passes. oxlint 1.82 applies
      # plugin rules to targets outside the config directory (verified against
      # 1.82.0 with a config in one directory and the target in another), so the
      # location is now only a cache decision: a repo-root copy stays stable across
      # runs and keeps the hash-crawler-safe atomic publish below. The published
      # copy DELIBERATELY outlives the process; see below.
      config_dir=$(dirname "$config_file")

      # Publish a persistent, git-ignored root cache atomically, and serialize
      # concurrent wrappers by locking the source config itself (without
      # creating another repository-local lock file). Keeping the complete file
      # avoids a hash-crawler stat/open race with an EXIT-time deletion.
      exec 9<"$config_file"
      flock --exclusive 9
      tmpconfig="$config_dir/.oxlint-with-plugins.json"
      staged_config=$(mktemp "''${TMPDIR:-/tmp}/oxlint-with-plugins.XXXXXX.json")
      trap 'rm -f "$staged_config"' EXIT
      # Substitute OUR entry in place rather than replacing the whole list.
      # Replacing it wholesale made every third-party plugin declared beside ours
      # unresolvable ("Plugin 'x' not found"), which is why consumers grew local
      # workarounds. Entries are either a path string or an ["alias", path] tuple;
      # a tuple keeps its alias. When no entry of ours is present (consumer configs
      # that rely purely on injection) ours is appended.
      #
      # The match is the plugin's ENTRY POINT, not merely the package directory:
      # `@overeng/oxc-config` also ships sibling plugin entries (the `@stylexjs`
      # namespace shim), and substituting one of those would silently replace a
      # third-party plugin with ours -- the very failure this fix removes.
      jq --arg p "$pluginPath" '
        def is_ours:
          if type == "string" then test("oxc-config/src/mod\\.ts$") or test("oxc-config-plugin[^/]*/plugin\\.js$")
          elif type == "array" then (.[1] | type == "string" and (test("oxc-config/src/mod\\.ts$") or test("oxc-config-plugin[^/]*/plugin\\.js$")))
          else false
          end;
        def substituted:
          if type == "array" then [.[0], $p] else $p end;
        .jsPlugins = (
          (.jsPlugins // []) as $existing
          | if any($existing[]; is_ours)
            then $existing | map(if is_ours then substituted else . end)
            else $existing + [$p]
            end
        )
      ' "$config_file" > "$staged_config"
      mv "$staged_config" "$tmpconfig"

      # Replace the config arg, or prepend -c if using default
      new_args=()
      replaced=false
      for ((i=0; i<''${#args[@]}; i++)); do
        case "''${args[$i]}" in
          -c|--config)
            new_args+=("''${args[$i]}" "$tmpconfig")
            # NOTE: `i=$((i+1))`, never `((i++))`. Post-increment evaluates to the
            # OLD value of i, so `((i++))` exits 1 when i is 0 — and under
            # `set -o errexit` that aborted the wrapper with no output and exit 1,
            # indistinguishable from a lint failure. Reproduced by passing
            # `--config` as the first argument.
            i=$((i + 1))
            replaced=true
            ;;
          *)
            new_args+=("''${args[$i]}")
            ;;
        esac
      done
      if [ "$replaced" = false ]; then
        new_args=("-c" "$tmpconfig" "''${new_args[@]}")
      fi

      # Run as a child so the staged-file cleanup trap remains effective.
      status=0
      ${oxlintNpm}/bin/oxlint "''${new_args[@]}" || status=$?
      exit "$status"
    else
      exec ${oxlintNpm}/bin/oxlint "$@"
    fi
  '';
}
