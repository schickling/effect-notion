#!/usr/bin/env bash
# Regression tests for nix/oxlint-with-plugins.nix.
#
# The wrapper rewrites a project's oxlint config so both JavaScript plugin entry
# points owned by @overeng/oxc-config resolve from immutable Buck products. The
# tests use the real built wrapper and oxlint binary because plugin resolution is
# the observable boundary:
#
#   1. unrelated plugin entries remain untouched;
#   2. the overeng and @stylexjs entries are substituted independently;
#   3. explicit live-source overrides remain separate authoring escape hatches;
#   4. a configured namespace with a missing or malformed entry fails closed;
#   5. argument-order and persistent-cache behavior remain stable.
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"

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

assert_equals() {
  local expected="$1" actual="$2" label="$3"
  if [ "$expected" != "$actual" ]; then
    fail "$label" "expected: $expected" "actual:   $actual"
  fi
  echo "  ok: $label"
}

assert_nonzero() {
  local actual="$1" label="$2"
  if [ "$actual" -eq 0 ]; then
    fail "$label" "expected a non-zero exit status"
  fi
  echo "  ok: $label"
}

echo "Running oxlint plugin injection tests..."
echo ""

# Prefer the wrapper the developer/CI actually runs: inside the devenv shell it is
# already on PATH and realised, so the test needs no build at all. Fall back to
# building it only when running outside the shell.
resolve_wrapper() {
  if [ -n "${OXLINT_WRAPPER_BIN:-}" ]; then
    printf '%s' "$OXLINT_WRAPPER_BIN"
    return
  fi

  local on_path
  on_path="$(command -v oxlint || true)"
  if [ -n "$on_path" ] && grep -q 'OVERENG_OXC_CONFIG_PLUGIN' "$(readlink -f "$on_path")" 2>/dev/null; then
    printf '%s' "$on_path"
    return
  fi

  printf '%s' "$(nix build --no-link --print-out-paths "$ROOT#oxlint-with-plugins")/bin/oxlint"
}

wrapper="$(resolve_wrapper)"
echo "Using oxlint wrapper: $wrapper"
[ -x "$wrapper" ] || fail "wrapper resolution" "not executable: $wrapper"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
workspace="$tmpdir/workspace"
mkdir -p "$workspace/oxc-config/src" "$workspace/live/oxc-config/src"
cd "$workspace"

# An unrelated third-party JS plugin. Namespace comes from `meta.name`, so the
# assertions can name it.
cat > probe-plugin.js <<'EOF'
module.exports = {
  meta: { name: 'probe', version: '0.0.1' },
  rules: {
    'always-report': {
      meta: { messages: { hit: 'probe plugin fired' } },
      create(context) {
        return {
          DebuggerStatement(node) {
            context.report({ node, messageId: 'hit' })
          },
        }
      },
    },
  },
}
EOF

# A SIBLING plugin entry inside the oxc-config package directory — the shape the
# `@stylexjs` namespace shim has. Substituting this one would silently swap a
# third-party plugin for ours, so the wrapper must match our ENTRY POINT
# (`oxc-config/src/mod.ts`), not merely the package directory.
cat > oxc-config/src/sibling-plugin.js <<'EOF'
module.exports = {
  meta: { name: 'sibling', version: '0.0.1' },
  rules: {
    'always-report': {
      meta: { messages: { hit: 'sibling plugin fired' } },
      create(context) {
        return {
          DebuggerStatement(node) {
            context.report({ node, messageId: 'hit' })
          },
        }
      },
    },
  },
}
EOF

# Live plugin source under the `overeng` namespace, carrying a rule that does NOT
# exist in the Nix-built snapshot. That is exactly the rule-development case:
# without an opt-out the new rule is unreachable through the wrapper.
cat > live/oxc-config/src/mod.ts <<'EOF'
export default {
  meta: { name: 'overeng', version: '0.0.1' },
  rules: {
    'live-source-only': {
      meta: { messages: { hit: 'live plugin source fired' } },
      create(context: { report: (d: unknown) => void }) {
        return {
          DebuggerStatement(node: unknown) {
            context.report({ node, messageId: 'hit' })
          },
        }
      },
    },
  },
}
EOF

# A separate live plugin under the `@stylexjs` namespace. It deliberately has a
# rule absent from the immutable product, proving that its override changes only
# the StyleX entry while the overeng entry keeps resolving from its own product.
cat > live/oxc-config/src/stylex-upstream-plugin.ts <<'EOF'
export default {
  meta: { name: '@stylexjs', version: '0.0.1' },
  rules: {
    'live-source-only': {
      meta: { messages: { hit: 'live StyleX plugin source fired' } },
      create(context: { report: (d: unknown) => void }) {
        return {
          DebuggerStatement(node: unknown) {
            context.report({ node, messageId: 'hit' })
          },
        }
      },
    },
  },
}
EOF

cat > fixture.ts <<'EOF'
debugger
export const now = Date.now()
EOF

# `overeng/no-raw-nondeterminism` is a rule of the real built plugin, so it proves
# our own namespace still resolves after the rewrite.
write_config() {
  cat > .oxlintrc.json
}

echo "Test 1: a third-party plugin declared beside ours still resolves (bug 1)"
write_config <<'EOF'
{
  "jsPlugins": ["./probe-plugin.js", "./oxc-config/src/mod.ts"],
  "rules": {
    "overeng/no-raw-nondeterminism": "error",
    "probe/always-report": "error"
  }
}
EOF
out="$("$wrapper" fixture.ts --config .oxlintrc.json 2>&1 || true)"
assert_not_contains "Plugin 'probe' not found" "$out" "third-party plugin is not clobbered"
assert_contains "probe(always-report)" "$out" "third-party rule fires"
assert_contains "overeng(no-raw-nondeterminism)" "$out" "our own rule still fires"

echo ""
echo "Test 2: a sibling entry in our own package directory is not substituted (bug 1)"
write_config <<'EOF'
{
  "jsPlugins": ["./oxc-config/src/mod.ts", "./oxc-config/src/sibling-plugin.js"],
  "rules": {
    "overeng/no-raw-nondeterminism": "error",
    "sibling/always-report": "error"
  }
}
EOF
out="$("$wrapper" fixture.ts --config .oxlintrc.json 2>&1 || true)"
assert_contains "sibling(always-report)" "$out" "sibling plugin entry survives the rewrite"
assert_contains "overeng(no-raw-nondeterminism)" "$out" "our entry point is the one substituted"


echo ""
echo "Test 3: the two owned plugin entries are substituted independently"
write_config <<'EOF'
{
  "jsPlugins": [
    "./oxc-config/src/mod.ts",
    "./oxc-config/src/stylex-upstream-plugin.ts"
  ],
  "rules": {
    "overeng/no-raw-nondeterminism": "error",
    "@stylexjs/live-source-only": "error"
  }
}
EOF
status_stylex_live=0
out="$(OVERENG_STYLEX_UPSTREAM_PLUGIN="$workspace/live/oxc-config/src/stylex-upstream-plugin.ts" \
  "$wrapper" fixture.ts --config .oxlintrc.json 2>&1)" || status_stylex_live=$?
assert_contains "@stylexjs(live-source-only)" "$out" "StyleX live-source entry is substituted"
assert_contains "overeng(no-raw-nondeterminism)" "$out" "overeng entry keeps its own product"
assert_equals "1" "$status_stylex_live" "violations from both plugin products fail the run"
echo ""
echo "Test 4: the config flag may come first (bug 2)"
write_config <<'EOF'
{
  "jsPlugins": ["./oxc-config/src/mod.ts"],
  "rules": { "overeng/no-raw-nondeterminism": "error" }
}
EOF
status_last=0
out_last="$("$wrapper" fixture.ts --config .oxlintrc.json 2>&1)" || status_last=$?
status_first=0
out_first="$("$wrapper" --config .oxlintrc.json fixture.ts 2>&1)" || status_first=$?

assert_equals "$status_last" "$status_first" "exit code does not depend on argument order"
assert_contains "overeng(no-raw-nondeterminism)" "$out_first" "config-flag-first run still reports diagnostics"
assert_contains "overeng(no-raw-nondeterminism)" "$out_last" "config-flag-last run reports diagnostics"

echo ""
# The injected config is a PERSISTENT, git-ignored root cache, not a temp file:
# `.gitignore` carries `.oxlint-with-plugins.*` specifically for it, and the
# wrapper keeps the complete file on purpose because deleting it on EXIT raced
# a hash crawler mid-read. So the contract is not "nothing is left behind" —
# it is "what is left behind has the one deterministic name the gitignore
# covers", and the randomly-suffixed STAGED file never lands in the tree.
echo "Test 5: the published cache is deterministic and gitignore-covered"
published="$(find . -maxdepth 1 -name '.oxlint-with-plugins.*' -print | sort)"
assert_equals "./.oxlint-with-plugins.json" "$published" \
  "exactly the one deterministic cache name is published"
staged_leak="$(find . -maxdepth 1 -name 'oxlint-with-plugins.*' -print)"
assert_equals "" "$staged_leak" "no randomly-suffixed staged config leaks into the tree"

echo ""
echo "Test 6: OVERENG_OXC_CONFIG_PLUGIN lints live plugin source (bug 3)"
write_config <<'EOF'
{
  "jsPlugins": ["./oxc-config/src/mod.ts"],
  "rules": { "overeng/live-source-only": "error" }
}
EOF
status_snapshot=0
out_snapshot="$("$wrapper" fixture.ts --config .oxlintrc.json 2>&1)" || status_snapshot=$?
assert_contains "not found in plugin 'overeng'" "$out_snapshot" \
  "the built snapshot does not know a rule that only exists in source"

status_live=0
out_live="$(OVERENG_OXC_CONFIG_PLUGIN="$workspace/live/oxc-config/src/mod.ts" \
  "$wrapper" fixture.ts --config .oxlintrc.json 2>&1)" || status_live=$?
assert_contains "overeng(live-source-only)" "$out_live" "live plugin source is linted without a Nix rebuild"
assert_equals "1" "$status_live" "a violation from live source still fails the run"

echo ""
echo "Test 7: a namespace with no matching configured entry fails closed"
write_config <<'EOF'
{
  "jsPlugins": ["./probe-plugin.js"],
  "rules": { "overeng/no-raw-nondeterminism": "error" }
}
EOF
status_missing=0
out="$("$wrapper" fixture.ts --config .oxlintrc.json 2>&1)" || status_missing=$?
assert_nonzero "$status_missing" "missing overeng entry is rejected"
assert_contains "expected exactly one configured overeng plugin entry" "$out" \
  "missing overeng entry has a focused diagnostic"

write_config <<'EOF'
{
  "jsPlugins": ["./oxc-config/src/mod.ts"],
  "rules": { "@stylexjs/valid-styles": "error" }
}
EOF
status_missing=0
out="$("$wrapper" fixture.ts --config .oxlintrc.json 2>&1)" || status_missing=$?
assert_nonzero "$status_missing" "missing StyleX entry is rejected"
assert_contains "expected exactly one configured StyleX upstream plugin entry" "$out" \
  "missing StyleX entry has a focused diagnostic"

echo ""
echo "Test 8: malformed jsPlugins entries fail closed before oxlint runs"
write_config <<'EOF'
{
  "jsPlugins": [["overeng"]],
  "rules": { "overeng/no-raw-nondeterminism": "error" }
}
EOF
status_malformed=0
out="$("$wrapper" fixture.ts --config .oxlintrc.json 2>&1)" || status_malformed=$?
assert_nonzero "$status_malformed" "malformed plugin entry is rejected"
assert_contains "jsPlugins entries must be path strings or [alias, path] string pairs" "$out" \
  "malformed plugin entry has a focused diagnostic"

echo ""
echo "All oxlint plugin injection tests passed"
