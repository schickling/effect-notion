#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"

eval_genie_module_attr() {
  local module_config="$1"
  local attr_expr="$2"

  nix eval --impure --raw --expr "
    let
      flake = builtins.getFlake \"$NIX_FLAKE_REF\";
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      evaluated = pkgs.lib.evalModules {
        modules = [
          ({ ... }: {
            options.tasks = pkgs.lib.mkOption { type = pkgs.lib.types.attrsOf pkgs.lib.types.anything; default = { }; };
            options.packages = pkgs.lib.mkOption { type = pkgs.lib.types.listOf pkgs.lib.types.anything; default = [ ]; };
          })
          $ROOT/nix/devenv-modules/tasks/shared/genie.nix
          ({ ... }: $module_config)
        ];
        specialArgs = { inherit pkgs; lib = pkgs.lib; };
      };
    in $attr_expr
  "
}

echo "Running Genie module option smoke test..."

default_globs="$(eval_genie_module_attr "{ }" 'builtins.toJSON evaluated.config.effectUtils.genie.extraInputGlobs')"
if [ "$default_globs" != "[]" ]; then
  echo "FAIL: default extraInputGlobs should be empty"
  echo "  actual: $default_globs"
  exit 1
fi

package_count="$(eval_genie_module_attr "{ effectUtils.genie.package = pkgs.hello; }" 'builtins.toString (builtins.length evaluated.config.packages)')"
if [ "$package_count" != "1" ]; then
  echo "FAIL: setting effectUtils.genie.package should add one guarded package"
  echo "  actual package count: $package_count"
  exit 1
fi

configured_globs="$(eval_genie_module_attr "{ effectUtils.genie.extraInputGlobs = [ \"registry.json\" ]; }" 'builtins.toJSON evaluated.config.effectUtils.genie.extraInputGlobs')"
if [ "$configured_globs" != '["registry.json"]' ]; then
  echo "FAIL: extraInputGlobs option should accept repo-specific generator inputs"
  echo "  actual: $configured_globs"
  exit 1
fi

echo "Checking commentless generated JSON ownership and warm-state drift..."
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT
mkdir -p "$test_dir/bin"
mkdir -p "$test_dir/semantic/nested"

cat > "$test_dir/bin/genie" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "--version" ]; then
  echo "genie-test 1"
fi
EOF
chmod +x "$test_dir/bin/genie"

git -C "$test_dir" init -q
printf 'export default {}\n' > "$test_dir/contract.json.genie.ts"
printf '{"value":1}\n' > "$test_dir/contract.json"
mkdir -p "$test_dir/nested"
printf 'export default {}\n' > "$test_dir/nested/contract.json.genie.ts"
printf '{"nested":true}\n' > "$test_dir/nested/contract.json"
mkdir -p "$test_dir/packages/widget/.editor-view/.store/snapshot"
printf 'export default {}\n' \
  > "$test_dir/packages/widget/.editor-view/.store/snapshot/contract.json.genie.ts"
printf '{"snapshot":true}\n' \
  > "$test_dir/packages/widget/.editor-view/.store/snapshot/contract.json"
printf 'direct one\n' > "$test_dir/semantic/direct.ts"
printf 'nested one\n' > "$test_dir/semantic/nested/input.ts"
git -C "$test_dir" add \
  contract.json.genie.ts contract.json \
  nested/contract.json.genie.ts nested/contract.json \
  packages/widget/.editor-view/.store/snapshot/contract.json.genie.ts \
  packages/widget/.editor-view/.store/snapshot/contract.json \
  semantic/direct.ts semantic/nested/input.ts

module_config='{ effectUtils.genie.extraInputGlobs = [ "semantic/**/*.ts" ]; }'
run_exec="$(eval_genie_module_attr "$module_config" 'evaluated.config.tasks."genie:run".exec')"
run_status="$(eval_genie_module_attr "$module_config" 'evaluated.config.tasks."genie:run".status')"
check_exec="$(eval_genie_module_attr "$module_config" 'evaluated.config.tasks."genie:check".exec')"
(
  cd "$test_dir"
  PATH="$test_dir/bin:$PATH" OTEL_EXPORTER_OTLP_ENDPOINT= OTELITE_HTTP_ENDPOINT= OTEL_SPAN_SPOOL_DIR= \
    bash -c "$run_exec"
)

if ! grep -qxF 'contract.json' "$test_dir/.devenv/task-cache/genie-run/generated-files.txt"; then
  echo "FAIL: direct commentless JSON paired with a .genie.ts source was not collected"
  exit 1
fi
if ! grep -qxF 'nested/contract.json' "$test_dir/.devenv/task-cache/genie-run/generated-files.txt"; then
  echo "FAIL: nested commentless JSON paired with a .genie.ts source was not collected"
  exit 1
fi
if grep -qxF 'packages/widget/.editor-view/.store/snapshot/contract.json' \
  "$test_dir/.devenv/task-cache/genie-run/generated-files.txt"; then
  echo "FAIL: tracked editor-view projection was collected as a Genie-owned output"
  exit 1
fi

printf '{"value":2}\n' > "$test_dir/contract.json"
if (
  cd "$test_dir"
  PATH="$test_dir/bin:$PATH" DEVENV_SETUP_OUTER_CACHE_HIT=0 \
    OTEL_EXPORTER_OTLP_ENDPOINT= OTELITE_HTTP_ENDPOINT= OTEL_SPAN_SPOOL_DIR= \
    bash -c "$run_status"
); then
  echo "FAIL: mutating commentless generated JSON should invalidate Genie warm state"
  exit 1
fi

printf '{"value":1}\n' > "$test_dir/contract.json"
(
  cd "$test_dir"
  PATH="$test_dir/bin:$PATH" OTEL_EXPORTER_OTLP_ENDPOINT= OTELITE_HTTP_ENDPOINT= OTEL_SPAN_SPOOL_DIR= \
    bash -c "$run_exec"
)
printf 'direct two\n' > "$test_dir/semantic/direct.ts"
if (
  cd "$test_dir"
  PATH="$test_dir/bin:$PATH" DEVENV_SETUP_OUTER_CACHE_HIT=0 \
    OTEL_EXPORTER_OTLP_ENDPOINT= OTELITE_HTTP_ENDPOINT= OTEL_SPAN_SPOOL_DIR= \
    bash -c "$run_status"
); then
  echo "FAIL: changing a direct extraInputGlobs match should invalidate Genie warm state"
  exit 1
fi

printf 'direct one\n' > "$test_dir/semantic/direct.ts"
(
  cd "$test_dir"
  PATH="$test_dir/bin:$PATH" OTEL_EXPORTER_OTLP_ENDPOINT= OTELITE_HTTP_ENDPOINT= OTEL_SPAN_SPOOL_DIR= \
    bash -c "$run_exec"
)
printf 'nested two\n' > "$test_dir/semantic/nested/input.ts"
if (
  cd "$test_dir"
  PATH="$test_dir/bin:$PATH" DEVENV_SETUP_OUTER_CACHE_HIT=0 \
    OTEL_EXPORTER_OTLP_ENDPOINT= OTELITE_HTTP_ENDPOINT= OTEL_SPAN_SPOOL_DIR= \
    bash -c "$run_status"
); then
  echo "FAIL: changing a nested extraInputGlobs match should invalidate Genie warm state"
  exit 1
fi

printf 'nested one\n' > "$test_dir/semantic/nested/input.ts"
sed -i 's/genie-test 1/genie-test 2/' "$test_dir/bin/genie"
if (
  cd "$test_dir"
  PATH="$test_dir/bin:$PATH" DEVENV_SETUP_OUTER_CACHE_HIT=0 \
    OTEL_EXPORTER_OTLP_ENDPOINT= OTELITE_HTTP_ENDPOINT= OTEL_SPAN_SPOOL_DIR= \
    bash -c "$run_status"
); then
  echo "FAIL: changing Genie binary identity should invalidate Genie warm state"
  exit 1
fi

retained_state="$(cat "$test_dir/.devenv/task-cache/genie-run/state.hash")"
rm "$test_dir/contract.json.genie.ts"
if (
  cd "$test_dir"
  PATH="$test_dir/bin:$PATH" OTEL_EXPORTER_OTLP_ENDPOINT= OTELITE_HTTP_ENDPOINT= OTEL_SPAN_SPOOL_DIR= \
    bash -c "$run_exec"
); then
  echo "FAIL: deleting a Genie owner while retaining its generated output should fail closed"
  exit 1
fi
if ! grep -qxF 'contract.json' "$test_dir/.devenv/task-cache/genie-run/generated-files.txt"; then
  echo "FAIL: rejected owner deletion should retain the previous ownership manifest"
  exit 1
fi
if [ "$(cat "$test_dir/.devenv/task-cache/genie-run/state.hash")" != "$retained_state" ]; then
  echo "FAIL: rejected owner deletion should retain the previous warm-state hash"
  exit 1
fi

rm "$test_dir/contract.json"
(
  cd "$test_dir"
  PATH="$test_dir/bin:$PATH" OTEL_EXPORTER_OTLP_ENDPOINT= OTELITE_HTTP_ENDPOINT= OTEL_SPAN_SPOOL_DIR= \
    bash -c "$run_exec"
)
if grep -qxF 'contract.json' "$test_dir/.devenv/task-cache/genie-run/generated-files.txt"; then
  echo "FAIL: deleting an owner and its output together should retire retained ownership"
  exit 1
fi

echo "Checking stateless output-side ownership..."
printf 'export default {}\n' > "$test_dir/marked.txt.genie.ts"
printf '%s\n' '// Generated file - DO NOT EDIT' '// Source: marked.txt.genie.ts' 'value' \
  > "$test_dir/marked.txt"
printf 'export default {}\n' > "$test_dir/projection.json.genie.ts"
printf '%s\n' '{' '  "provenance": {' \
  '    "source": "projection.json.genie.ts",' \
  '    "warning": "GENERATED FILE - DO NOT EDIT"' '  }' '}' \
  > "$test_dir/projection.json"
git -C "$test_dir" add \
  marked.txt.genie.ts marked.txt projection.json.genie.ts projection.json
(
  cd "$test_dir"
  PATH="$test_dir/bin:$PATH" OTEL_EXPORTER_OTLP_ENDPOINT= OTELITE_HTTP_ENDPOINT= OTEL_SPAN_SPOOL_DIR= \
    bash -c "$run_exec"
)

rm "$test_dir/marked.txt.genie.ts"
if (
  cd "$test_dir"
  PATH="$test_dir/bin:$PATH" OTEL_EXPORTER_OTLP_ENDPOINT= OTELITE_HTTP_ENDPOINT= OTEL_SPAN_SPOOL_DIR= \
    bash -c "$run_exec"
); then
  echo "FAIL: a marked output whose declared owner is missing should fail closed"
  exit 1
fi
rm "$test_dir/marked.txt"

# A fresh CI checkout has no retained local ownership manifest. The embedded
# source in commentless JSON is therefore the stateless ownership authority.
rm "$test_dir/projection.json.genie.ts"
rm -rf "$test_dir/.devenv"
if (
  cd "$test_dir"
  PATH="$test_dir/bin:$PATH" OTEL_EXPORTER_OTLP_ENDPOINT= OTELITE_HTTP_ENDPOINT= OTEL_SPAN_SPOOL_DIR= \
    bash -c "$check_exec"
); then
  echo "FAIL: fresh Genie check should reject commentless JSON whose declared owner is missing"
  exit 1
fi

echo "Genie module option smoke test passed."
