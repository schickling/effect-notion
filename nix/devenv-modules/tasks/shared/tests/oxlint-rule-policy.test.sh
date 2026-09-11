#!/usr/bin/env bash
# Behavioural tests for the repo's oxlint RULE POLICY, run against the real
# generated `.oxlintrc.json` and the real oxlint binary.
#
# oxlint 1.82 (this repo's pin) added rules and moved others into enabled
# categories, so three policy decisions in `genie/oxlint-base.ts` are now
# load-bearing and silently reversible by a config edit:
#
#   1. `no-underscore-dangle` (new in `suspicious`) stays ON with a narrow
#      `allow` list — Effect's `_tag` discriminant and the `_`-prefixed names
#      owned by Node/Notion/NDS — instead of being disabled wholesale. The
#      interesting property is the NEGATIVE one: a dangling name that is NOT on
#      the list must still be reported, or the allow list has become a mute
#      switch.
#   2. the React Compiler rule family is off, while the classic hooks rules
#      (`rules-of-hooks` error, `exhaustive-deps` warn) stay on. Those two sets
#      overlap: `react/hooks` and `react/exhaustive-effect-dependencies` report
#      the same defects as the classic pair, so a regression here shows up as
#      duplicate diagnostics rather than as missing ones.
#   3. the test-file override relaxes `no-underscore-dangle`/`no-shadow` for the
#      intentionally-unused-binding and harness-scoped-`it` idioms, and must NOT
#      leak into `src`.
#
# Every fixture below is a NEGATIVE CONTROL, and that is asserted rather than
# claimed: for the React family the same fixture is linted a second time with
# every rule force-enabled on the command line, and each rule must report there.
# An `assert_not_contains` can therefore never pass because the fixture is
# simply silent — the mute-switch failure mode this whole file exists to catch.
#
# Fixtures live in a temp dir OUTSIDE the repo on purpose: the config's
# `ignorePatterns` are repo-relative, so a fixture inside the tree can be
# silently skipped and turn every assertion green.
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"
CONFIG="$ROOT/.oxlintrc.json"

fail() {
  echo "FAIL: $1"
  shift
  for line in "$@"; do echo "  $line"; done
  exit 1
}

assert_contains() {
  local needle="$1" haystack="$2" label="$3"
  if ! printf '%s' "$haystack" | grep -qF -- "$needle"; then
    fail "$label" "expected output to contain: $needle" "actual output:" "$haystack"
  fi
  echo "  ok: $label"
}

assert_not_contains() {
  local needle="$1" haystack="$2" label="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    fail "$label" "expected output NOT to contain: $needle" "actual output:" "$haystack"
  fi
  echo "  ok: $label"
}

echo "Running oxlint rule policy tests..."
echo ""

[ -f "$CONFIG" ] || fail "config resolution" "missing generated config: $CONFIG"

# ---------------------------------------------------------------------------
# 0. the two oxlint pins move together, and the binary under test is that pin
# ---------------------------------------------------------------------------
# `nix/oxlint-npm.nix` says "keep in lockstep with the `oxlint` pin in
# genie/external.ts", and nothing enforced it: this cohort found the npm build
# on 1.39.0 while the workspace pin had already moved to 1.70.0, so the config
# schema and JS-plugin rule API in use were two majors from the declared pin.
# A comment is not a gate; this is.
OXLINT_NPM_NIX="$ROOT/nix/oxlint-npm.nix"
CATALOG_TS="$ROOT/genie/external.ts"

oxlint_npm_pin() { sed -n 's/^  version = "\(.*\)";$/\1/p' "$1" | head -1; }
oxlint_catalog_pin() { sed -n "s/^  oxlint: '\(.*\)',$/\1/p" "$1" | head -1; }

# Pure: reads two files, prints nothing when the pins agree and a diagnostic
# when they do not. Both extractions must hit, so a renamed field fails loudly
# instead of comparing two empty strings.
oxlint_pin_disagreement() {
  local nix_version catalog_version
  nix_version="$(oxlint_npm_pin "$1")"
  catalog_version="$(oxlint_catalog_pin "$2")"

  if [ -z "$nix_version" ]; then
    echo "could not read the \`version\` pin from $1"
    return
  fi
  if [ -z "$catalog_version" ]; then
    echo "could not read the \`oxlint\` catalog pin from $2"
    return
  fi
  if [ "$nix_version" != "$catalog_version" ]; then
    echo "oxlint pins disagree: nix/oxlint-npm.nix has $nix_version, genie/external.ts has $catalog_version"
  fi
}

disagreement="$(oxlint_pin_disagreement "$OXLINT_NPM_NIX" "$CATALOG_TS")"
[ -z "$disagreement" ] || fail "oxlint pins are in lockstep" "$disagreement"
echo "  ok: oxlint pins are in lockstep"

# Negative control: the check is only worth its runtime if a real split trips
# it, so mutate a copy of the Nix pin and require a diagnostic.
drift_probe="$(mktemp)"
sed 's/^  version = ".*";$/  version = "1.39.0";/' "$OXLINT_NPM_NIX" > "$drift_probe"
grep -q '^  version = "1.39.0";$' "$drift_probe" ||
  fail "drift fixture" "the mutated copy did not take: $drift_probe"
drift_out="$(oxlint_pin_disagreement "$drift_probe" "$CATALOG_TS")"
rm -f "$drift_probe"
assert_contains "oxlint pins disagree" "$drift_out" \
  "a split between the npm build and the workspace pin is reported"

pinned_version="$(oxlint_npm_pin "$OXLINT_NPM_NIX")"

# The npm/NAPI build is the linter this repo actually runs (only it executes the
# @overeng/oxc-config JS plugin). Inside the devenv shell the wrapper is already
# on PATH and realised, so the common path needs no build.
#
# An on-PATH `oxlint` is only accepted when it BOTH carries the plugin wiring
# and reports the pinned version. Two ways it silently does not: devenv's task
# guard, which prints "use the devenv task(s)" and lints nothing, and a
# same-named wrapper from another profile built at a different oxlint. Either
# would make every absence assertion in this file pass vacuously — the exact
# failure mode the file exists to prevent — so both fall back to the flake.
resolve_oxlint() {
  if [ -n "${OXLINT_WRAPPER_BIN:-}" ]; then
    printf '%s' "$OXLINT_WRAPPER_BIN"
    return
  fi

  local on_path
  on_path="$(command -v oxlint || true)"
  if [ -n "$on_path" ] &&
    grep -q 'OVERENG_OXC_CONFIG_PLUGIN' "$(readlink -f "$on_path")" 2>/dev/null &&
    "$on_path" --version 2>&1 | grep -qF "$pinned_version"; then
    printf '%s' "$on_path"
    return
  fi

  printf '%s' "$(nix build --no-link --print-out-paths "$ROOT#oxlint-with-plugins")/bin/oxlint"
}

oxlint_bin="$(resolve_oxlint)"
echo "Using oxlint: $oxlint_bin"
[ -x "$oxlint_bin" ] || fail "oxlint resolution" "not executable: $oxlint_bin"

assert_contains "$pinned_version" "$("$oxlint_bin" --version 2>&1)" \
  "the oxlint under test reports the pinned version"

workspace="$(mktemp -d)"
trap 'rm -rf "$workspace"' EXIT

lint() {
  # `--format=agent` is the one-line `path:line:col: <severity> <plugin>(<rule>)`
  # shape every assertion below matches on. Without it the format depends on
  # which wrapper resolved (the devenv task wrapper passes it, a bare
  # `oxlint-with-plugins` defaults to the graphical renderer), and the rule-id
  # assertions would silently stop matching.
  #
  # oxlint exits non-zero on findings, which is the normal case here.
  "$oxlint_bin" --format=agent --config "$CONFIG" "$@" 2>&1 || true
}

# ---------------------------------------------------------------------------
# 1. no-underscore-dangle: allow list is narrow
# ---------------------------------------------------------------------------
cat > "$workspace/discriminant.ts" <<'EOF'
/** Reads an Effect-style tagged union plus a repo-invented private field. */
export const readTag = (entry: { _tag: string; _secret: string }): string =>
  entry._tag === 'ok' ? entry._secret : 'no'
EOF

out="$(lint "$workspace/discriminant.ts")"
assert_not_contains "in '\`_tag\`'" "$out" "Effect \`_tag\` discriminant is allowed"
assert_contains "in '\`_secret\`'" "$out" "a name outside the allow list is still reported"

cat > "$workspace/node-internals.ts" <<'EOF'
/** Reads Node's undocumented handle introspection, whose names we do not own. */
export const activeHandleCount = (proc: {
  _getActiveHandles?: () => unknown[]
  _getActiveRequests?: () => unknown[]
}): number => (proc._getActiveHandles?.() ?? []).length + (proc._getActiveRequests?.() ?? []).length
EOF

out="$(lint "$workspace/node-internals.ts")"
assert_not_contains "no-underscore-dangle" "$out" "Node-internal handle names are allowed"

# ---------------------------------------------------------------------------
# 2. test-file override does not leak into src
# ---------------------------------------------------------------------------
# The outer binding is declared FIRST: `no-shadow` defaults to `hoist: functions`,
# so shadowing a variable declared later in the module is not reported and would
# make the src assertion vacuous.
shadow_fixture='const channel = "outer"

/** Shadows the outer binding and keeps an unused underscore marker. */
export const run = (channel: string): string => {
  const _unusedMarker = channel
  return channel
}

/** Reads the outer binding. */
export const outer = (): string => channel
'

printf '%s' "$shadow_fixture" > "$workspace/shadow.ts"
printf '%s' "$shadow_fixture" > "$workspace/shadow.test.ts"

out="$(lint "$workspace/shadow.ts")"
assert_contains "no-shadow" "$out" "no-shadow is enforced in src"
assert_contains "in '\`_unusedMarker\`'" "$out" "no-underscore-dangle is enforced in src"

out="$(lint "$workspace/shadow.test.ts")"
assert_not_contains "no-shadow" "$out" "no-shadow is relaxed in test files"
assert_not_contains "no-underscore-dangle" "$out" "no-underscore-dangle is relaxed in test files"

# ---------------------------------------------------------------------------
# 3. React: classic hooks rules on, React Compiler family off
# ---------------------------------------------------------------------------
cat > "$workspace/Component.tsx" <<'EOF'
import { useEffect, useMemo, useRef, useState } from 'react'

const mutableGlobal: { count: number } = { count: 0 }

const Text = (props: { value: string }): string => props.value

/** Violates the React Compiler rule family and the classic hooks rules at once. */
export const Fixture = (props: { flag: boolean; label: string }): unknown => {
  const [value, setValue] = useState(0)

  // react/set-state-in-effect (Compiler family)
  useEffect(() => {
    setValue(1)
  }, [])

  // react-hooks/exhaustive-deps (classic) + react/exhaustive-effect-dependencies
  useEffect(() => {
    console.log(props.label)
  }, [])

  // react/memo-dependencies (Compiler family): `props.flag` is not read here
  const memoized = useMemo(() => value + 1, [value, props.flag])

  // react/immutability (Compiler family): mutating module state during render
  mutableGlobal.count += 1

  // react/purity (Compiler family): impure call during render
  const seed = Math.random()

  // react/refs (Compiler family): reading `current` during render
  const refValue = useRef(0).current

  // react/capitalized-calls (Compiler family)
  const rendered = Text({ value: props.label })

  // react-hooks/rules-of-hooks (classic) + react/hooks (Compiler family)
  if (props.flag) {
    const [extra] = useState(2)
    return extra + memoized
  }

  return `${rendered}${value + mutableGlobal.count + seed + refValue}`
}
EOF

out="$(lint "$workspace/Component.tsx")"

assert_contains "error react-hooks(rules-of-hooks)" "$out" \
  "classic rules-of-hooks still fails the build"
assert_contains "warning react-hooks(exhaustive-deps)" "$out" \
  "classic exhaustive-deps still reports"

compiler_family_rules=(
  set-state-in-effect
  purity
  immutability
  refs
  hooks
  exhaustive-effect-dependencies
  memo-dependencies
  capitalized-calls
)

for rule in "${compiler_family_rules[@]}"; do
  assert_not_contains "react($rule)" "$out" "React Compiler rule react/$rule is off"
done

# `react/globals` is configured off with the rest of the family but is NOT
# asserted here: no fixture construct reproduces it under 1.82 (module-state
# mutation, global array pushes, and `window`/`globalThis` writes during render
# all land on `react/immutability` instead), so an absence assertion for it
# would be exactly the vacuous check this file rejects.

# The controls: same fixture, same config, every family rule force-enabled on
# the command line. Each must report, or the absences asserted above prove
# nothing about the policy.
enabled_args=()
for rule in "${compiler_family_rules[@]}"; do
  enabled_args+=(-W "react/$rule")
done

control="$(lint "${enabled_args[@]}" "$workspace/Component.tsx")"

for rule in "${compiler_family_rules[@]}"; do
  assert_contains "react($rule)" "$control" \
    "fixture really violates react/$rule when the rule is enabled"
done

echo ""
echo "All oxlint rule policy tests passed."
