#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"

eval_setup_module_attr() {
  local run_on_enter_shell="$1"
  local attr_expr="$2"

  nix eval --impure --json --expr "
    let
      flake = builtins.getFlake \"$NIX_FLAKE_REF\";
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      setupModule = import $ROOT/nix/devenv-modules/tasks/shared/setup.nix {
        requiredTasks = [ \"required\" ];
        optionalTasks = [ \"optional\" ];
        completionsCliNames = [ \"tool\" ];
        runOnEnterShell = $run_on_enter_shell;
      };
      evaluated = pkgs.lib.evalModules {
        modules = [
          ({ ... }: {
            options.tasks = pkgs.lib.mkOption {
              type = pkgs.lib.types.attrsOf pkgs.lib.types.anything;
              default = { };
            };
          })
          setupModule
        ];
        specialArgs = { inherit pkgs; lib = pkgs.lib; };
      };
    in $attr_expr
  "
}

eval_observability_module_attr() {
  local attr_expr="$1"

  nix eval --impure --json --expr "
    let
      flake = builtins.getFlake \"$NIX_FLAKE_REF\";
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      observabilityModule = import $ROOT/nix/devenv-modules/observability.nix {
        project = \"fixture\";
        profile = {
          name = \"fixture\";
          task = \"fixture:task\";
          mode = \"single\";
          smokeTask = \"fixture:task\";
          smokeMode = \"single\";
          bridgeTask = \"fixture:task\";
          prerequisiteTasks = [ \"projection\" ];
        };
        wireInto = [ \"check:all\" ];
      };
      config = observabilityModule { inherit pkgs; lib = pkgs.lib; };
    in $attr_expr
  "
}

echo "Running setup module option tests..."

disabled_after="$(eval_setup_module_attr false 'evaluated.config.tasks."devenv:enterShell".after')"
if [ "$disabled_after" != '[]' ]; then
  echo "FAIL: mutation-free shell must have no setup dependencies: $disabled_after" >&2
  exit 1
fi

disabled_tasks="$(eval_setup_module_attr false 'builtins.attrNames evaluated.config.tasks')"
if [[ "$disabled_tasks" == *'setup:gate'* || "$disabled_tasks" == *'setup:record-cache'* ]]; then
  echo "FAIL: mutation-free shell must not instantiate setup cache tasks: $disabled_tasks" >&2
  exit 1
fi
if [[ "$disabled_tasks" != *'setup:run'* || "$disabled_tasks" != *'setup:strict'* ]]; then
  echo "FAIL: explicit setup recovery tasks must remain available: $disabled_tasks" >&2
  exit 1
fi

enabled_after="$(eval_setup_module_attr true 'evaluated.config.tasks."devenv:enterShell".after')"
if [[ "$enabled_after" != *'required'* || "$enabled_after" != *'optional@completed'* ]]; then
  echo "FAIL: enabled shell setup must preserve required and optional dependencies: $enabled_after" >&2
  exit 1
fi

profile_after="$(eval_observability_module_attr 'config.tasks."otel:profile:fixture".after or [ ]')"
if [ "$profile_after" != '["projection"]' ]; then
  echo "FAIL: OTEL profile can start before its required projection: $profile_after" >&2
  exit 1
fi

verify_after="$(eval_observability_module_attr 'config.tasks."otel:verify:fixture".after or [ ]')"
if [ "$verify_after" != '["projection"]' ]; then
  echo "FAIL: OTEL verification can start before its required projection: $verify_after" >&2
  exit 1
fi

# The repository composes mutation-free setup with observability. Its verifier
# must profile a task that still exists when setup:gate is deliberately absent.
if ! grep -A 14 'import ./nix/devenv-modules/observability.nix' "$ROOT/devenv.nix" \
  | grep -q 'smokeTask = "genie:check"'; then
  echo "FAIL: mutation-free observability must use an instantiated smoke task" >&2
  exit 1
fi
if ! grep -A 14 'import ./nix/devenv-modules/observability.nix' "$ROOT/devenv.nix" \
  | grep -q 'bridgeTask = "genie:check"'; then
  echo "FAIL: mutation-free observability must use an instantiated bridge task" >&2
  exit 1
fi
observability_config="$(grep -A 40 'import ./nix/devenv-modules/observability.nix' "$ROOT/devenv.nix")"
if ! grep -q '"test:run"' <<< "$observability_config"; then
  echo "FAIL: Genie OTEL verification must run after sibling check:all work" >&2
  exit 1
fi

echo "Setup module option tests passed."
