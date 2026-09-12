# Wrapper around oxlint-npm that points the two @overeng/oxc-config JavaScript
# plugin entries at independently tracked immutable Buck products.
#
# When the project's .oxlintrc.json (or an explicit -c config) contains
# overeng/* or @stylexjs/* rules, this wrapper substitutes the corresponding
# configured `jsPlugins` entries in an injected config copy. It leaves unrelated
# entries alone and refuses to invent a missing entry: the config remains the
# authority for which namespaces are enabled.
#
# Plugin source selection:
#   default                               tracked Buck product modules
#   OVERENG_OXC_CONFIG_PLUGIN=<p>         live src/mod.ts override
#   OVERENG_STYLEX_UPSTREAM_PLUGIN=<p>    live src/stylex-upstream-plugin.ts
#
# The overrides are explicit rule-authoring escape hatches. Normal development,
# CI and downstream wrappers all use the immutable products.
#
# Usage:
#   oxlintWithPlugins = import ./oxlint-with-plugins.nix { inherit pkgs oxlintNpm; };
#   # => provides `oxlint` on PATH with automatic plugin substitution
{
  pkgs,
  oxlintNpm,
}:
assert oxlintNpm.pluginPath != null && oxlintNpm.stylexUpstreamPluginPath != null;
pkgs.writeShellApplication {
  name = "oxlint";
  runtimeInputs = [
    pkgs.jq
    pkgs.flock
    pkgs.tsgolint
  ];
  text = ''
    # Rule-authoring escape hatches. Keep the two entries separate so changing
    # one live source cannot silently replace the other namespace.
    overengPluginPath="''${OVERENG_OXC_CONFIG_PLUGIN:-${oxlintNpm.pluginPath}}"
    stylexUpstreamPluginPath="''${OVERENG_STYLEX_UPSTREAM_PLUGIN:-${oxlintNpm.stylexUpstreamPluginPath}}"

    # Find the config file: explicit -c/--config arg, or default .oxlintrc.json
    config_file=""
    args=("$@")
    for ((i=0; i<''${#args[@]}; i++)); do
      case "''${args[$i]}" in
        -c|--config)
          if [ "$((i + 1))" -ge "''${#args[@]}" ]; then
            echo "oxlint-with-plugins: ''${args[$i]} requires a config path" >&2
            exit 2
          fi
          config_file="''${args[$((i + 1))]}"
          break
          ;;
      esac
    done
    if [ -z "$config_file" ] && [ -f .oxlintrc.json ]; then
      config_file=".oxlintrc.json"
    fi

    if [ -n "$config_file" ] && grep -Eq '"(overeng/|@stylexjs/)' "$config_file" 2>/dev/null; then
      # The injected copy is written into the SAME directory as the source config
      # (repo root for the default .oxlintrc.json). Under oxlint 1.39 this was
      # load-bearing for correctness: plugin rules only applied to files located
      # UNDER the injected config's directory, so a /tmp copy silently dropped
      # every configured plugin rule for the deep file paths CI passes. Oxlint
      # 1.82 applies plugin rules to targets outside the config directory, so the
      # location is now only a cache decision: a repo-root copy stays stable across
      # runs and keeps the hash-crawler-safe atomic publish below. The published
      # copy DELIBERATELY outlives the process; see below.
      config_dir=$(dirname "$config_file")

      # Publish a persistent, git-ignored root cache atomically, and serialize
      # concurrent wrappers by locking the source config itself. Keeping the
      # complete file avoids a hash-crawler stat/open race with EXIT-time
      # deletion.
      exec 9<"$config_file"
      flock --exclusive 9
      tmpconfig="$config_dir/.oxlint-with-plugins.json"
      staged_config=$(mktemp "''${TMPDIR:-/tmp}/oxlint-with-plugins.XXXXXX.json")
      trap 'rm -f "$staged_config"' EXIT

      # Every entry must be a path string or an [alias, path] pair. Each enabled
      # owned namespace must have exactly one corresponding source entry; a
      # missing or duplicate entry is configuration drift, not permission to
      # append an implicit plugin. Tuple aliases are preserved.
      jq --arg overeng "$overengPluginPath" --arg stylex "$stylexUpstreamPluginPath" '
        def is_plugin_entry:
          type == "string"
          or (type == "array" and length == 2 and all(.[]; type == "string"));
        def entry_path:
          if type == "string" then . else .[1] end;
        def is_overeng:
          entry_path as $path
          | $path == $overeng or ($path | test("oxc-config/src/mod\\.ts$"));
        def is_stylex:
          entry_path as $path
          | $path == $stylex or ($path | test("oxc-config/src/stylex-upstream-plugin\\.ts$"));
        def substituted($path):
          if type == "array" then [.[0], $path] else $path end;
        def rule_names:
          ((.rules // {}) | keys[]),
          ((.overrides // [])[]? | (.rules // {}) | keys[]);
        def uses_rule_prefix($prefix):
          any(rule_names; startswith($prefix));

        . as $config
        | ($config.jsPlugins // []) as $existing
        | if ($config.jsPlugins != null and ($config.jsPlugins | type) != "array")
          then error("jsPlugins must be an array")
          elif any($existing[]; is_plugin_entry | not)
          then error("jsPlugins entries must be path strings or [alias, path] string pairs")
          else .
          end
        | ([$existing[] | select(is_overeng)] | length) as $overeng_count
        | ([$existing[] | select(is_stylex)] | length) as $stylex_count
        | if uses_rule_prefix("overeng/") and $overeng_count != 1
          then error("expected exactly one configured overeng plugin entry")
          elif uses_rule_prefix("@stylexjs/") and $stylex_count != 1
          then error("expected exactly one configured StyleX upstream plugin entry")
          elif $overeng_count > 1
          then error("expected at most one configured overeng plugin entry")
          elif $stylex_count > 1
          then error("expected at most one configured StyleX upstream plugin entry")
          else
            .jsPlugins = (
              $existing
              | map(
                  if is_overeng then substituted($overeng)
                  elif is_stylex then substituted($stylex)
                  else .
                  end
                )
            )
          end
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
