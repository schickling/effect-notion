#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"
GATE="$ROOT/scripts/buck2-rust-deps.sh"
TEMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEMP_ROOT"' EXIT
FIXTURE="$TEMP_ROOT/repository"
FAKE_REINDEER="$TEMP_ROOT/reindeer"
# Declared interpreter: the sandbox binds attested tool closures at their store paths and has no
# `/usr/bin/env`, so every script this test launches is started through it explicitly.
test_bash="${BASH_BIN:-$BASH}"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

mkdir -p "$FIXTURE/rust/third-party/fixups/example"
printf 'vendor = false\n' >"$FIXTURE/rust/reindeer.toml"
printf 'authoritative lock bytes\n' >"$FIXTURE/rust/Cargo.lock"
printf '# old graph\n' >"$FIXTURE/rust/third-party/BUCK"
printf 'buildscript.run = true\n' >"$FIXTURE/rust/third-party/fixups/example/fixups.toml"

{
  printf '#!%s\n' "$test_bash"
  cat <<'FAKE'
set -euo pipefail
printf '%s\n' "$CARGO_HOME" >"$FAKE_REINDEER_HOME_LOG"
printf 'invoked\n' >>"$FAKE_REINDEER_CALL_LOG"
if [ "${FAKE_REINDEER_BEHAVIOR:-generate}" = mutate-lock ]; then
  printf 'rewritten lock bytes\n' >rust/Cargo.lock
fi
if [ "${FAKE_REINDEER_BEHAVIOR:-generate}" = unpinned ]; then
  cat <<'UNPINNED'
http_archive(
    name = "example-1.0.0",
    urls = ["https://static.crates.io/crates/example/example-1.0.0.crate"],
)
UNPINNED
  exit 0
fi
cat <<'GRAPH'
# generated graph
http_archive(
    name = "example-1.0.0",
    sha256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    urls = ["https://static.crates.io/crates/example/example-1.0.0.crate"],
)
GRAPH
FAKE
} >"$FAKE_REINDEER"
chmod +x "$FAKE_REINDEER"

export FAKE_REINDEER_HOME_LOG="$TEMP_ROOT/cargo-home"
export FAKE_REINDEER_CALL_LOG="$TEMP_ROOT/calls"
export FAKE_REINDEER_BEHAVIOR=generate
cp "$FIXTURE/rust/Cargo.lock" "$TEMP_ROOT/original-lock"
"$test_bash" "$GATE" generate "$FIXTURE" "$FAKE_REINDEER" /fake/cargo /fake/rustc
cmp -s "$TEMP_ROOT/original-lock" "$FIXTURE/rust/Cargo.lock" || fail "generate changed Cargo.lock"
grep -Fq 'http_archive(' "$FIXTURE/rust/third-party/BUCK" || fail "generate did not install the candidate graph"
expected_cargo_home="$FIXTURE/.devenv/reindeer-cargo-home"
[ "$(cat "$FAKE_REINDEER_HOME_LOG")" = "$expected_cargo_home" ] || fail "buckify did not use the repository-pinned Cargo home"
"$test_bash" "$GATE" check "$FIXTURE" "$FAKE_REINDEER" /fake/cargo /fake/rustc

printf '# graph that must survive a failed gate\n' >"$FIXTURE/rust/third-party/BUCK"
cp "$FIXTURE/rust/third-party/BUCK" "$TEMP_ROOT/graph-before-lock-rewrite"
export FAKE_REINDEER_BEHAVIOR=mutate-lock
if "$test_bash" "$GATE" generate "$FIXTURE" "$FAKE_REINDEER" /fake/cargo /fake/rustc 2>"$TEMP_ROOT/lock-error"; then
  fail "gate accepted a buckify run that rewrote Cargo.lock"
fi
grep -Fq 'changed authoritative rust/Cargo.lock' "$TEMP_ROOT/lock-error" || fail "lock rewrite failure was not diagnosed"
cmp -s "$TEMP_ROOT/graph-before-lock-rewrite" "$FIXTURE/rust/third-party/BUCK" || fail "failed lock gate replaced the tracked graph"

printf 'authoritative lock bytes\n' >"$FIXTURE/rust/Cargo.lock"
export FAKE_REINDEER_BEHAVIOR=unpinned
if "$test_bash" "$GATE" generate "$FIXTURE" "$FAKE_REINDEER" /fake/cargo /fake/rustc 2>"$TEMP_ROOT/hash-error"; then
  fail "gate accepted an unpinned http_archive"
fi
grep -Fq 'every generated http_archive must carry one sha256 pin' "$TEMP_ROOT/hash-error" || fail "unpinned archive failure was not diagnosed"
cmp -s "$TEMP_ROOT/graph-before-lock-rewrite" "$FIXTURE/rust/third-party/BUCK" || fail "unpinned graph replaced the tracked graph"

export FAKE_REINDEER_BEHAVIOR=generate
printf 'authoritative lock bytes\n' >"$FIXTURE/rust/Cargo.lock"
for key in extra_srcs omit_srcs; do
  printf '%s = ["src/**/*.rs"]\n' "$key" >"$FIXTURE/rust/third-party/fixups/example/fixups.toml"
  : >"$FAKE_REINDEER_CALL_LOG"
  if "$test_bash" "$GATE" check "$FIXTURE" "$FAKE_REINDEER" /fake/cargo /fake/rustc >"$TEMP_ROOT/$key.stdout" 2>"$TEMP_ROOT/$key.stderr"; then
    fail "gate accepted non-vendored $key"
  fi
  grep -Fq 'non-vendored fixup uses a discarded source key' "$TEMP_ROOT/$key.stderr" || fail "$key failure was not diagnosed"
  [ ! -s "$FAKE_REINDEER_CALL_LOG" ] || fail "$key lint ran Reindeer before rejecting the fixup"
done

echo "Buck2 Rust dependency gate tests passed."
