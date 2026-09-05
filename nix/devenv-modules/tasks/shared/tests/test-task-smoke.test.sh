#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"

assert_eq() {
  local expected="$1"
  local actual="$2"
  local label="$3"

  if [ "$expected" != "$actual" ]; then
    echo "FAIL: $label"
    echo "  expected: $expected"
    echo "  actual:   $actual"
    exit 1
  fi
}

# test.nix has two modes. Buck mode (the default) owns test execution through
# explicit `targets` and asserts at least one is declared; the `packages`
# fan-out with its concurrency batching is now reachable only under
# `legacy = true`. This helper drives the legacy batching graph.
eval_legacy_test_module_attr() {
  local concurrency="$1"
  local attr_expr="$2"

  nix eval --impure --raw --expr "
    let
      flake = builtins.getFlake \"$NIX_FLAKE_REF\";
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      evaluated = pkgs.lib.evalModules {
        modules = [
          ({ ... }: {
            options.tasks = pkgs.lib.mkOption { type = pkgs.lib.types.attrsOf pkgs.lib.types.anything; default = { }; };
            options.processes = pkgs.lib.mkOption { type = pkgs.lib.types.attrsOf pkgs.lib.types.anything; default = { }; };
            options.packages = pkgs.lib.mkOption { type = pkgs.lib.types.listOf pkgs.lib.types.anything; default = [ ]; };
          })
          ((import $ROOT/nix/devenv-modules/tasks/shared/test.nix {
            packages = [
              { path = \"packages/ok-a\"; name = \"ok-a\"; }
              { path = \"packages/native-b\"; name = \"native-b\"; after = [ \"native:link\" ]; }
              { path = \"packages/ok-c\"; name = \"ok-c\"; }
            ];
            legacy = true;
            extraTests = [ \"test:extra\" ];
            packageConcurrency = $concurrency;
          }) {
            inherit pkgs;
            lib = pkgs.lib;
            config = { };
          })
        ];
      };
      tasks = evaluated.config.tasks;
    in $attr_expr
  "
}

# Buck mode: explicit `targets` (label + optional capabilities/after) become
# per-target tasks that shell out to buck2, and `test:run` is their barrier.
eval_buck_test_module_attr() {
  local attr_expr="$1"

  nix eval --impure --raw --expr "
    let
      flake = builtins.getFlake \"$NIX_FLAKE_REF\";
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      evaluated = pkgs.lib.evalModules {
        modules = [
          ({ ... }: {
            options.tasks = pkgs.lib.mkOption { type = pkgs.lib.types.attrsOf pkgs.lib.types.anything; default = { }; };
            options.processes = pkgs.lib.mkOption { type = pkgs.lib.types.attrsOf pkgs.lib.types.anything; default = { }; };
            options.packages = pkgs.lib.mkOption { type = pkgs.lib.types.listOf pkgs.lib.types.anything; default = [ ]; };
          })
          ((import $ROOT/nix/devenv-modules/tasks/shared/test.nix {
            targets = [
              { name = \"ok-a\"; label = \"root//packages/ok-a:test\"; }
              {
                name = \"native-b\";
                label = \"root//packages/native-b:test\";
                after = [ \"native:link\" ];
                capabilities = { node = \"/nix/store/fake-node\"; };
              }
            ];
            buckAfter = [ \"genie:run\" ];
            extraTests = [ \"test:extra\" ];
          }) {
            inherit pkgs;
            lib = pkgs.lib;
            config = { };
          })
        ];
      };
      tasks = evaluated.config.tasks;
    in $attr_expr
  "
}

eval_buck_test_module_without_targets() {
  nix eval --impure --raw --expr "
    let
      flake = builtins.getFlake \"$NIX_FLAKE_REF\";
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      module = (import $ROOT/nix/devenv-modules/tasks/shared/test.nix { }) {
        inherit pkgs;
        lib = pkgs.lib;
        config = { };
      };
    in builtins.toJSON (builtins.attrNames module)
  "
}

echo "Running test task smoke test..."
echo ""

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

echo "Buck mode: explicit targets own test execution"

assert_eq \
  '["genie:run"]' \
  "$(eval_buck_test_module_attr 'builtins.toJSON tasks."test:ok-a".after')" \
  "buck target task waits for the shared buckAfter prerequisites"

assert_eq \
  '["genie:run","native:link"]' \
  "$(eval_buck_test_module_attr 'builtins.toJSON tasks."test:native-b".after')" \
  "buck target task keeps target-specific prerequisites"

assert_eq \
  '["test:ok-a","test:native-b","test:extra"]' \
  "$(eval_buck_test_module_attr 'builtins.toJSON tasks."test:run".after')" \
  "buck test:run waits for every target task and extra tests"

buck_exec="$(eval_buck_test_module_attr 'tasks."test:native-b".exec')"
if ! grep -Fq 'buck2" test root//packages/native-b:test' <<<"$buck_exec"; then
  echo "FAIL: buck target task should run buck2 test against the declared label"
  echo "$buck_exec"
  exit 1
fi
if ! grep -Fq -- "--config 'test_capabilities.node=/nix/store/fake-node'" <<<"$buck_exec"; then
  echo "FAIL: buck target task should declare its capabilities as --config args"
  echo "$buck_exec"
  exit 1
fi

set +e
eval_buck_test_module_without_targets >/dev/null 2>"$tmpdir/no-targets.stderr"
exit_code=$?
set -e

if [ "$exit_code" -eq 0 ]; then
  echo "FAIL: Buck mode without targets should fail at Nix evaluation"
  exit 1
fi

if ! grep -Fq "test.nix Buck mode requires at least one explicit target" "$tmpdir/no-targets.stderr"; then
  echo "FAIL: Buck mode without targets prints a useful error"
  cat "$tmpdir/no-targets.stderr"
  exit 1
fi

echo "Legacy mode: bounded package fan-out"

assert_eq \
  '["pnpm:install"]' \
  "$(eval_legacy_test_module_attr 2 'builtins.toJSON tasks."test:ok-a".after')" \
  "first-batch package keeps only its direct prerequisites"

assert_eq \
  '["pnpm:install","native:link"]' \
  "$(eval_legacy_test_module_attr 2 'builtins.toJSON tasks."test:native-b".after')" \
  "first-batch package keeps package-specific prerequisites"

assert_eq \
  '["pnpm:install","test:run:batch:0"]' \
  "$(eval_legacy_test_module_attr 2 'builtins.toJSON tasks."test:ok-c".after')" \
  "later-batch package waits for previous batch barrier"

assert_eq \
  '["test:ok-a","test:native-b"]' \
  "$(eval_legacy_test_module_attr 2 'builtins.toJSON tasks."test:run:batch:0".after')" \
  "first batch barrier waits for first package group"

assert_eq \
  '["test:ok-c"]' \
  "$(eval_legacy_test_module_attr 2 'builtins.toJSON tasks."test:run:batch:1".after')" \
  "second batch barrier waits for second package group"

assert_eq \
  '["test:run:batch:1","test:extra"]' \
  "$(eval_legacy_test_module_attr 2 'builtins.toJSON tasks."test:run".after')" \
  "bounded test:run waits for final package batch and extra tests"

assert_eq \
  'null' \
  "$(eval_legacy_test_module_attr 2 'builtins.toJSON tasks."test:run".exec')" \
  "bounded test:run stays a graph-only task"

set +e
eval_legacy_test_module_attr 0 'tasks."test:run".exec' >/dev/null 2>"$tmpdir/invalid.stderr"
exit_code=$?
set -e

if [ "$exit_code" -eq 0 ]; then
  echo "FAIL: invalid packageConcurrency should fail at Nix evaluation"
  exit 1
fi

if ! grep -Fq "packageConcurrency must be at least 1" "$tmpdir/invalid.stderr"; then
  echo "FAIL: invalid packageConcurrency prints a useful error"
  exit 1
fi

echo "test task smoke test passed"
