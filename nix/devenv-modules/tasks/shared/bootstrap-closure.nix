# Bootstrap-safe import-closure gate (issue #884; SCOPED TO BOOTSTRAP-PHASE, ZERO-TOLERANCE)
#
# Usage in devenv.nix:
#   imports = [ (inputs.effect-utils.devenvModules.tasks.bootstrap-closure {}) ];
#
# Older consumers may still pass `entry = ...`; the packaged checker now ignores
# it and always checks the importing repo root via `--root`.
#
# Provides: bootstrap-closure:check
#
# Runs effect-utils' shared checker over the importing repo's source-tree
# `.genie.ts` files (skipping dependency/build directories) declared
# `bootstrap`-phase (static `// @genie-bootstrap` pragma). A bootstrap-phase
# generator (and everything it transitively imports at RUNTIME) must be
# importable from a fresh checkout BEFORE install: one that reaches a
# runtime-only package — e.g. through a wide barrel that `export *`s a module
# importing `effect` — pulls that package into the bootstrap import closure and
# breaks the pre-install `genie --phase bootstrap` run on a fresh clone.
#
# Zero-tolerance: it fails on ANY bootstrap-phase violation. There is no baseline and no allowlist;
# `design-time` generators (the default) are out of scope by declaration. This gate is fast local
# feedback (R30); the empirical authority is `bootstrap:cold-proof` (R32), which runs the
# bootstrap-phase generators in a no-`node_modules` checkout before install (decision 0004).
#
# The gate is a checker, not a bootstrap-phase generator. The task runs a Nix
# checker package so `typescript` and the walker implementation are explicit
# package inputs, not ambient Bun auto-install or downstream `node_modules`
# state.
{
  # Deprecated compatibility parameter. Older downstream repos passed a repo-local
  # Bun entry; this module now runs effect-utils' packaged checker instead.
  entry ? null,
  # Optional task prerequisites for repos that want local ordering. The checker itself is packaged
  # and does not require package-manager install state.
  after ? [ ],
}:
{ lib, pkgs, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
  trackedProducts = import ../../../buck2-products { inherit lib; };
  product = trackedProducts.products.genie-bootstrap-closure-check;
  checkerPkg = (import ../../../workspace-tools/lib/javascript-product-import.nix { inherit pkgs; }) {
    inherit (product)
      artifact
      descriptor
      expectedDescriptorSha256
      expectedModuleSha256
      ;
    expectedProductName = "genie-bootstrap-closure-check";
    expectedProductKind = "cli";
    binaryName = "genie-bootstrap-closure-check";
    smokeTestArgs = [ "--help" ];
  };
  legacyEntryDescriptionSuffix =
    if entry == null then "" else " (legacy entry argument ignored; packaged checker is used)";
in
{
  tasks = {
    "bootstrap-closure:check" = {
      inherit after;
      description =
        "Fail on any bootstrap-safe import-closure violation in bootstrap-phase .genie.ts sources (zero-tolerance)"
        + legacyEntryDescriptionSuffix;
      exec = trace.exec "bootstrap-closure:check" ''
        set -uo pipefail
        root="''${DEVENV_ROOT:-$PWD}"
        ${checkerPkg}/bin/genie-bootstrap-closure-check --root "$root"
      '';
    };
  };
}
