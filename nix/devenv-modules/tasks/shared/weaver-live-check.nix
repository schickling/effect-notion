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
# Block-vs-degrade (GEN-R09), mirroring weaver:check: a live-check VALIDATION failure (the test
# fails) BLOCKS; weaver UNAVAILABILITY (flake build/eval failure, binary missing) DEGRADES to a
# warning (exit 0) in a separate lane.
{
  # Non-cacheable Buck test target declaring the Weaver/Nix and writable-temp
  # capabilities required by this live lane.
  target,
  weaverBin,
  semconvModel,
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
        exec "$workspace_root/.megarepo/bin/buck2" test \
          --config ${lib.escapeShellArg "test_capabilities.weaver=${toString weaverBin}"} \
          --config ${lib.escapeShellArg "test_capabilities.weaver-semconv-model=${toString semconvModel}"} \
          --config ${lib.escapeShellArg "test_capabilities.weaver-registry=${toString registry}"} \
          ${lib.escapeShellArg target}
      '';
    };
  };
}
