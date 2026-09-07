#!/usr/bin/env bash
# Regression tests for nix/oxlint-with-plugins.nix.
#
# The wrapper rewrites a project's oxlint config so the `@overeng/oxc-config` JS
# plugin resolves. Three defects it used to have, each reproduced here against the
# REAL built wrapper and the real oxlint binary rather than a stub, because all
# three were failures of plugin RESOLUTION — the one thing a stub cannot model:
#
#   1. it replaced `jsPlugins` wholesale, so no third-party JS plugin could load
#      beside ours ("Plugin 'x' not found");
#   2. `oxlint --config X ...` with the config flag FIRST exited 1 with no output
#      at all, which in a pipeline is indistinguishable from a lint failure;
#   3. the injected plugin is a build-time snapshot, so a newly added rule
#      reported "not found in plugin 'overeng'" and could not be exercised.
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

# A third-party JS plugin, standing in for @stylexjs/eslint-plugin. Namespace
# comes from `meta.name`, so the assertions can name it.
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
echo "Test 3: the config flag may come first (bug 2)"
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
echo "Test 4: the published cache is deterministic and gitignore-covered"
published="$(find . -maxdepth 1 -name '.oxlint-with-plugins.*' -print | sort)"
assert_equals "./.oxlint-with-plugins.json" "$published" \
  "exactly the one deterministic cache name is published"
staged_leak="$(find . -maxdepth 1 -name 'oxlint-with-plugins.*' -print)"
assert_equals "" "$staged_leak" "no randomly-suffixed staged config leaks into the tree"

echo ""
echo "Test 5: OVERENG_OXC_CONFIG_PLUGIN lints live plugin source (bug 3)"
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
# Every step between "config mentions overeng/*" and "run oxlint" — the lock, the
# jq render, the atomic publish, the arg rewrite — runs under `set -o errexit`.
# A failure in any of them aborted the wrapper with no output and a status that
# looks exactly like a lint finding, which is how a red CI oxlint task became
# unattributable. The wrapper must name the stage, line and status instead.
echo "Test 6: a wrapper setup failure names its stage, line and status"
cat > .oxlintrc.json <<'EOF'
{
  "jsPlugins": ["./oxc-config/src/mod.ts"],
  "rules": { "overeng/no-raw-nondeterminism": "error"
EOF
status_render=0
out_render="$("$wrapper" fixture.ts --config .oxlintrc.json 2>&1)" || status_render=$?
assert_contains "oxlint-with-plugins: aborted in stage=config-render" "$out_render" \
  "an unrenderable config is attributed to the render stage"
assert_contains "with status $status_render" "$out_render" \
  "the reported status matches the wrapper's exit status"
if [ "$status_render" -eq 0 ]; then
  fail "unrenderable config must fail" "wrapper exited 0"
fi
echo "  ok: unrenderable config keeps a nonzero status ($status_render)"

echo ""
echo "All oxlint plugin injection tests passed"
