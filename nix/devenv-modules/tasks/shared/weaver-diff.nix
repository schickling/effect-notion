# Weaver semantic-conventions COMPAT-DIFF gate (SC-R11; additive; GEN-R09 block-vs-degrade)
#
# Usage in devenv.nix:
#   imports = [ (inputs.effect-utils.devenvModules.tasks.weaver-diff {}) ];
#
# Provides: weaver:diff
#
# Treats the emitted registry (genie/weaver-registry/) as a VERSIONED PUBLIC API and blocks a
# change that BREAKS a previously-shipped attribute/signal. It diffs the current emitted registry
# against the PR's BASELINE (the merge-base with `origin/main`, so a PR that is merely behind main
# does not false-positive on attributes main added after the fork point) via
# `weaver registry diff`, resolving the upstream OTel semconv HERMETICALLY against the local Nix
# FOD (`nix/weaver-flake#semconv-model`) — the same offline rewrite `weaver:check` uses (SC-A03).
#
# Breaking-change gate (empirically grounded against weaver 0.24.2; the diff semantics below are
# not yet re-verified against the current 0.26.1 pin — see spec §"Weaver gate wiring", SC-R11):
#   1. diff EXITS NONZERO — removing a still-REFERENCED attribute leaves a dangling ref that fails
#      resolution (weaver surfaces `unresolved-ref`). BLOCK.
#   2. diff.json reports a change of `type: "removed"` — a clean removal of a whole capability
#      (attribute + its refs) still RESOLVES (exit 0) but is a compat break. BLOCK.
# Non-breaking evolution is explicitly allowed: `type: "added"` (new attribute) and
# `type: "renamed"` (a `deprecated: { reason: renamed }` deprecation, which weaver reports as a
# rename, NOT a removal) both pass. Richer schema-evolution policy (the shipped Rego evolution
# templates — e.g. stability regressions, requirement-level tightening) is a documented follow-up;
# `removed` + resolution-failure is the verified minimum that catches the common break.
#
# Block-vs-degrade (GEN-R09), mirroring weaver:check:
#   - a weaver VALIDATION result (breaking change) BLOCKS;
#   - weaver UNAVAILABILITY (flake build/eval failure, binary missing) DEGRADES to a warning
#     (exit 0) in a separate lane, so a broken toolchain never wedges unrelated work.
#   - a MISSING BASELINE (no git, ref/merge-base not present locally — e.g. a shallow CI checkout,
#     or the registry did not yet exist on the baseline) DEGRADES to a warning (exit 0): with no
#     prior public API there is nothing to break. This task performs ONLY read-only, local git
#     (`merge-base` / `cat-file` / `ls-tree` / `show`) and NEVER fetches — it stays offline.
#     NOTE for CI: GitHub Actions' default `fetch-depth: 1` has neither `origin/main` nor the
#     merge-base commit, so the gate silently degrades there — the diff lane needs
#     `fetch-depth: 0` (or an explicit base fetch) to be load-bearing.
{
  # Repo-relative path to the emitted registry directory.
  registryDir ? "genie/weaver-registry",
  # Path flake ref (relative to repo root) exposing `#weaver` and `#semconv-model`.
  weaverFlake ? "nix/weaver-flake",
  # Baseline ref the PR is compared against; the effective baseline is its merge-base with HEAD.
  baselineRef ? "origin/main",
}:
{ lib, pkgs, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
in
{
  tasks = {
    "weaver:diff" = {
      description = "Compat-diff the emitted Weaver registry against its merge-base baseline (additive gate; degrades if weaver/baseline unavailable)";
      exec = trace.exec "weaver:diff" ''
        set -uo pipefail
        root="''${DEVENV_ROOT:-$PWD}"
        reg="$root/${registryDir}"
        flake="$root/${weaverFlake}"

        git="${pkgs.git}/bin/git"
        jq="${pkgs.jq}/bin/jq"
        sed="${pkgs.gnused}/bin/sed"
        cp="${pkgs.coreutils}/bin/cp"
        chmod="${pkgs.coreutils}/bin/chmod"
        mktemp="${pkgs.coreutils}/bin/mktemp"
        rm="${pkgs.coreutils}/bin/rm"

        if [ ! -f "$reg/manifest.yaml" ]; then
          echo "✗ weaver:diff: $reg/manifest.yaml not found — run 'genie:run' first" >&2
          exit 1
        fi

        # --- LANE 1: weaver availability (degrade to a warning; must NOT wedge the gate) ---
        weaver_err="$($mktemp)"
        if ! weaver_pkg="$(${pkgs.nix}/bin/nix build --no-link --print-out-paths "$flake#weaver" 2>"$weaver_err")"; then
          echo "⚠ weaver:diff DEGRADED: could not build the weaver flake ($flake#weaver) — skipping (exit 0)." >&2
          ${pkgs.coreutils}/bin/cat "$weaver_err" >&2 || true
          exit 0
        fi
        if ! model="$(${pkgs.nix}/bin/nix build --no-link --print-out-paths "$flake#semconv-model" 2>"$weaver_err")"; then
          echo "⚠ weaver:diff DEGRADED: could not materialize the upstream semconv FOD ($flake#semconv-model) — skipping (exit 0)." >&2
          ${pkgs.coreutils}/bin/cat "$weaver_err" >&2 || true
          exit 0
        fi
        if [ ! -x "$weaver_pkg/bin/weaver" ]; then
          echo "⚠ weaver:diff DEGRADED: weaver binary missing at $weaver_pkg/bin/weaver — skipping (exit 0)." >&2
          exit 0
        fi

        # --- LANE 2: baseline availability (degrade — nothing to break without a prior API) ---
        if ! command -v "$git" >/dev/null 2>&1; then
          echo "⚠ weaver:diff DEGRADED: git unavailable — cannot materialize a baseline (exit 0)." >&2
          exit 0
        fi
        if ! base_commit="$("$git" -C "$root" merge-base ${baselineRef} HEAD 2>/dev/null)"; then
          echo "⚠ weaver:diff DEGRADED: no merge-base for '${baselineRef}'..HEAD (shallow checkout or ref absent) — skipping (exit 0). CI needs fetch-depth: 0." >&2
          exit 0
        fi
        if ! "$git" -C "$root" cat-file -e "$base_commit:${registryDir}/manifest.yaml" 2>/dev/null; then
          echo "✓ weaver:diff: no baseline registry at $base_commit — the registry is new, nothing to break (exit 0)." >&2
          exit 0
        fi

        # --- Materialize BOTH registries hermetically (upstream rewritten to the local FOD) ---
        # Holding upstream constant on both sides makes the diff reflect ONLY first-party changes.
        base="$($mktemp -d)"; cur="$($mktemp -d)"; out="$($mktemp -d)"
        trap "$rm -rf \"$base\" \"$cur\" \"$out\"" EXIT

        # Baseline: every tracked *.yaml under the registry dir at the merge-base commit.
        "$git" -C "$root" ls-tree --name-only "$base_commit" "${registryDir}/" \
          | ${pkgs.gnugrep}/bin/grep '\.yaml$' \
          | while IFS= read -r f; do
              "$git" -C "$root" show "$base_commit:$f" > "$base/$(${pkgs.coreutils}/bin/basename "$f")"
            done
        $chmod -R u+w "$base"
        $sed -i "s|registry_path: .*|registry_path: $model|" "$base/manifest.yaml"

        # Current: the actually-emitted registry.
        $cp "$reg"/*.yaml "$cur/"
        $chmod -R u+w "$cur"
        $sed -i "s|registry_path: .*|registry_path: $model|" "$cur/manifest.yaml"

        echo "weaver:diff: comparing emitted registry against baseline $base_commit (merge-base of ${baselineRef}..HEAD)"

        # --- Run the diff (structured JSON report) ---
        set +e
        "$weaver_pkg/bin/weaver" registry diff \
          --baseline-registry "$base" -r "$cur" --future \
          --format json -o "$out" --diagnostic-stdout
        diff_exit=$?
        set -e

        # Gate 1: a nonzero diff means the CURRENT registry failed to resolve — the common cause is
        # removing a still-referenced attribute (dangling ref). BLOCK.
        if [ "$diff_exit" -ne 0 ]; then
          echo "✗ weaver:diff: BREAKING — the registry failed to diff/resolve against its baseline (exit $diff_exit)." >&2
          echo "  A removed-but-still-referenced attribute (unresolved ref) is the usual cause; restore it or drop its refs." >&2
          exit 1
        fi

        # Gate 2: any change of type 'removed' across all signal/attribute categories is a compat break.
        report="$out/diff.json"
        if [ ! -f "$report" ]; then
          echo "⚠ weaver:diff DEGRADED: diff succeeded but no report at $report — skipping the removal gate (exit 0)." >&2
          exit 0
        fi
        removed="$("$jq" -r '[.changes | to_entries[] | .value[] | select(.type=="removed") | (.name // .old_name // "?")] | .[]' "$report")"
        if [ -n "$removed" ]; then
          echo "✗ weaver:diff: BREAKING compat change — the following registry item(s) were REMOVED:" >&2
          echo "$removed" | $sed 's/^/    - /' >&2
          echo "  The registry is a versioned public API; deprecate (deprecated: { reason: renamed, ... }) instead of removing." >&2
          exit 1
        fi

        echo "✓ weaver:diff: no breaking (removed) changes vs baseline $base_commit"
      '';
    };
  };
}
