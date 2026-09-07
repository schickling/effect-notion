# Weaver LIVE-CHECK e2e gate (SC-R12; additive; GEN-R09 block-vs-degrade)
#
# Usage in devenv.nix:
#   imports = [ (inputs.effect-utils.devenvModules.tasks.weaver-live-check {}) ];
#
# Provides: weaver:live-check
#
# Runs the live-check e2e (a scoped Vitest integration test): a first-party telemetry site emits
# registry-conformant OTLP through the real otel-contract encoder, the otelite capture harness
# records the on-the-wire OTLP, an adapter projects it into weaver's live-check sample format, and
# `weaver registry live-check` validates it against the ACTUALLY-EMITTED registry
# (genie/weaver-registry/) — asserting exit 0 (conforms) plus a negative control (an undeclared
# attribute → nonzero). Upstream OTel semconv is resolved HERMETICALLY against the local Nix FOD
# (`nix/weaver-flake#semconv-model`), identical to weaver:check (SC-A03) — no network at gate time.
#
# The weaver binary + semconv-model path are handed to the test via WEAVER_BIN / WEAVER_SEMCONV_MODEL
# (mirroring how the otelite tests take OTELITE_BIN); the test SKIPS when they are absent, so the
# ordinary `test` lane (which does not build the heavy weaver flake) stays green and fast.
#
# Those two outputs are resolved AT TASK EXECUTION TIME, from a path flake ref, exactly as
# weaver:check and weaver:diff do. Taking them as realized derivations instead would put the
# weaver Rust build and the upstream semconv FOD in the closure of `devenv-shell-env`, so every
# shell entry — and therefore every unrelated task — would pay for them before running anything.
#
# Block-vs-degrade (GEN-R09), mirroring weaver:check: a live-check VALIDATION failure (the test
# fails) BLOCKS; weaver UNAVAILABILITY (flake build/eval failure, binary missing) DEGRADES to a
# warning (exit 0) in a separate lane.
{
  # Non-cacheable Buck test target declaring the Weaver/Nix and writable-temp
  # capabilities required by this live lane.
  target,
  # Path flake ref (relative to repo root) exposing `#weaver` and `#semconv-model`.
  weaverFlake ? "nix/weaver-flake",
  registry,
  after ? [ ],
}:
{ lib, pkgs, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
in
{
  tasks = {
    "weaver:live-check" = {
      description = "Run the explicitly capability-bearing Weaver live-check target";
      inherit after;
      exec = trace.exec "weaver:live-check" ''
        set -euo pipefail
        root="''${DEVENV_ROOT:-$PWD}"
        workspace_root="$(${pkgs.coreutils}/bin/realpath "$root/../..")"
        flake="$root/${weaverFlake}"

        # Weaver UNAVAILABILITY blocks this lane rather than degrading: unlike weaver:check,
        # this gate exists to prove the emitted OTLP conforms, and a silently skipped e2e
        # would report success without ever validating anything. `set -e` plus the explicit
        # executable test keeps a broken toolchain loud.
        weaver_pkg="$(${pkgs.nix}/bin/nix build --no-link --print-out-paths "$flake#weaver")"
        model="$(${pkgs.nix}/bin/nix build --no-link --print-out-paths "$flake#semconv-model")"
        if [ ! -x "$weaver_pkg/bin/weaver" ]; then
          echo "✗ weaver:live-check: weaver binary missing at $weaver_pkg/bin/weaver" >&2
          exit 1
        fi

        exec "$workspace_root/.megarepo/bin/buck2" test \
          --config "test_capabilities.weaver=$weaver_pkg/bin/weaver" \
          --config "test_capabilities.weaver-semconv-model=$model" \
          --config ${lib.escapeShellArg "test_capabilities.weaver-registry=${toString registry}"} \
          ${lib.escapeShellArg target}
      '';
    };
  };
}
