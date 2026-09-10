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
# Every fixture below is a NEGATIVE CONTROL: it genuinely violates the rules
# under test, and was verified to report them with the rules enabled. So an
# assertion that a diagnostic is absent proves the policy, not the fixture.
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

# The npm/NAPI build is the linter this repo actually runs (only it executes the
# @overeng/oxc-config JS plugin). Inside the devenv shell the wrapper is already
# on PATH and realised, so the common path needs no build.
resolve_oxlint() {
  if [ -n "${OXLINT_WRAPPER_BIN:-}" ]; then
    printf '%s' "$OXLINT_WRAPPER_BIN"
    return
  fi

  local on_path
  on_path="$(command -v oxlint || true)"
  if [ -n "$on_path" ]; then
    printf '%s' "$on_path"
    return
  fi

  printf '%s' "$(nix build --no-link --print-out-paths "$ROOT#oxlint-with-plugins")/bin/oxlint"
}

oxlint_bin="$(resolve_oxlint)"
echo "Using oxlint: $oxlint_bin"
[ -x "$oxlint_bin" ] || fail "oxlint resolution" "not executable: $oxlint_bin"

workspace="$(mktemp -d)"
trap 'rm -rf "$workspace"' EXIT

lint() {
  # oxlint exits non-zero on findings, which is the normal case here.
  "$oxlint_bin" --config "$CONFIG" "$@" 2>&1 || true
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
import { useEffect, useMemo, useState } from 'react'

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

  // react/purity + react/immutability + react/globals (Compiler family)
  mutableGlobal.count += 1

  // react/capitalized-calls (Compiler family)
  const rendered = Text({ value: props.label })

  // react-hooks/rules-of-hooks (classic) + react/hooks (Compiler family)
  if (props.flag) {
    const [extra] = useState(2)
    return extra + memoized
  }

  return `${rendered}${value + mutableGlobal.count}`
}
EOF

out="$(lint "$workspace/Component.tsx")"

assert_contains "error react-hooks(rules-of-hooks)" "$out" \
  "classic rules-of-hooks still fails the build"
assert_contains "warning react-hooks(exhaustive-deps)" "$out" \
  "classic exhaustive-deps still reports"

for rule in set-state-in-effect purity immutability globals refs hooks \
  exhaustive-effect-dependencies memo-dependencies capitalized-calls; do
  assert_not_contains "react($rule)" "$out" "React Compiler rule react/$rule is off"
done

echo ""
echo "All oxlint rule policy tests passed."
