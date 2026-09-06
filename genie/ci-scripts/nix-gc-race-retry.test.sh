#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$ROOT/genie/ci-scripts/nix-gc-race-retry.sh"
source "$SCRIPT"

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

assert_exit_code() {
  local expected="$1"
  local actual="$2"
  local label="$3"

  if [ "$expected" != "$actual" ]; then
    echo "FAIL: $label"
    echo "  expected exit code: $expected"
    echo "  actual exit code:   $actual"
    exit 1
  fi
}

assert_contains() {
  local needle="$1"
  local file="$2"
  local label="$3"

  if ! grep -Fq "$needle" "$file"; then
    echo "FAIL: $label"
    echo "  missing: $needle"
    echo "  file:    $file"
    exit 1
  fi
}

assert_not_contains() {
  local needle="$1"
  local file="$2"
  local label="$3"

  if grep -Fq "$needle" "$file"; then
    echo "FAIL: $label"
    echo "  unexpected: $needle"
    echo "  file:       $file"
    exit 1
  fi
}

test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT

# The helper deletes Nix caches as part of its repair path. Sandbox HOME and the XDG cache
# root for the whole suite so no test can ever touch the real developer or runner caches.
# The two roots are deliberately DIVERGENT (XDG_CACHE_HOME is not under HOME) so the
# assertions below prove the helper purges the legacy HOME-relative eval cache as well as
# the XDG root it resolves.
export HOME="$test_dir/home"
export XDG_CACHE_HOME="$test_dir/xdg-cache"
home_nix_cache="$HOME/.cache/nix"
xdg_nix_cache="$XDG_CACHE_HOME/nix"
mkdir -p "$home_nix_cache" "$xdg_nix_cache"

seed_nix_caches() {
  mkdir -p "$xdg_nix_cache/tarball-cache-v2" "$xdg_nix_cache/gitv3" \
    "$xdg_nix_cache/eval-cache-v6" "$home_nix_cache/eval-cache-v6"
  : > "$xdg_nix_cache/fetcher-cache-v4.sqlite"
  : > "$xdg_nix_cache/fetcher-cache-v4.sqlite-shm"
  : > "$xdg_nix_cache/fetcher-cache-v4.sqlite-wal"
  : > "$xdg_nix_cache/binary-cache-v7.sqlite"
}

assert_missing() {
  if [ -e "$1" ]; then
    echo "FAIL: $2"
    echo "  still present: $1"
    exit 1
  fi
}

assert_present() {
  if [ ! -e "$1" ]; then
    echo "FAIL: $2"
    echo "  missing: $1"
    exit 1
  fi
}

echo "Running nix GC race retry helper tests..."
echo ""

echo "Test 1: standalone helper stays aligned with workflow helper source"
node - "$ROOT" <<'NODE'
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const root = process.argv[2]
const standalone = readFileSync(
  join(root, 'genie/ci-scripts/nix-gc-race-retry.sh'),
  'utf8',
)
const supportFilesSource = readFileSync(join(root, 'genie/ci-workflow/support-files.ts'), 'utf8')
const match = supportFilesSource.match(
  /export const ciWorkflowNixGcRaceRetryScript = String\.raw`([\s\S]*?)`\n\nexport const ciWorkflowNixGcRaceRetryWrapperScript/,
)

if (match === null) {
  console.error('FAIL: unable to locate ciWorkflowNixGcRaceRetryScript in support-files.ts')
  process.exit(1)
}

const embedded = match[1].replaceAll('${dollar}', '$').trimEnd()
const normalizedStandalone = standalone.replace(
  /^#!\/usr\/bin\/env bash\n# Generated file - DO NOT EDIT\n# Source: nix-gc-race-retry\.sh\.genie\.ts\n\n/,
  '#!/usr/bin/env bash\n',
).trimEnd()
if (normalizedStandalone !== embedded) {
  console.error('FAIL: standalone helper drifted from workflow helper source')
  process.exit(1)
}
NODE

echo "Test 2: retries invalid-store-path failures and succeeds on the next attempt"
retry_fixture="$test_dir/retry-fixture.sh"
cat > "$retry_fixture" <<EOF
#!/usr/bin/env bash
set -euo pipefail
attempt_file="$test_dir/retry-attempt"
attempt=1
if [ -f "\$attempt_file" ]; then
  attempt=\$(cat "\$attempt_file")
fi
if [ "\$attempt" -eq 1 ]; then
  echo 2 > "\$attempt_file"
  echo "error: path '/nix/store/retry-fixture-path' is not valid" >&2
  exit 1
fi
echo "retry recovered"
EOF
chmod +x "$retry_fixture"
CI_PROGRESS_HEARTBEAT_SECONDS=1 NIX_GC_RACE_MAX_RETRIES=2 run_nix_gc_race_retry "retry-fixture" "$retry_fixture" >/dev/null
assert_eq "2" "$(cat "$test_dir/retry-attempt")" "invalid-store-path retry count"

echo "Test 3: retries cachix wrapper failures without an extracted store path"
cachix_fixture="$test_dir/cachix-fixture.sh"
cat > "$cachix_fixture" <<EOF
#!/usr/bin/env bash
set -euo pipefail
attempt_file="$test_dir/cachix-attempt"
attempt=1
if [ -f "\$attempt_file" ]; then
  attempt=\$(cat "\$attempt_file")
fi
if [ "\$attempt" -eq 1 ]; then
  echo 2 > "\$attempt_file"
  echo "error: Failed to convert config.cachix to JSON" >&2
  echo "error: while evaluating the option cachix.package" >&2
  exit 1
fi
echo "cachix recovered"
EOF
chmod +x "$cachix_fixture"
CI_PROGRESS_HEARTBEAT_SECONDS=1 NIX_GC_RACE_MAX_RETRIES=2 run_nix_gc_race_retry "cachix-fixture" "$cachix_fixture" >/dev/null
assert_eq "2" "$(cat "$test_dir/cachix-attempt")" "cachix wrapper retry count"

echo "Test 4: retries truncated Nix input tarball failures"
fetch_fixture="$test_dir/fetch-fixture.sh"
cat > "$fetch_fixture" <<EOF
#!/usr/bin/env bash
set -euo pipefail
attempt_file="$test_dir/fetch-attempt"
attempt=1
if [ -f "\$attempt_file" ]; then
  attempt=\$(cat "\$attempt_file")
fi
if [ "\$attempt" -eq 1 ]; then
  echo 2 > "\$attempt_file"
  echo "error: cannot read file from tarball: Truncated tar archive detected while reading data" >&2
  exit 1
fi
echo "fetch recovered"
EOF
chmod +x "$fetch_fixture"
CI_PROGRESS_HEARTBEAT_SECONDS=1 NIX_GC_RACE_MAX_RETRIES=2 run_nix_gc_race_retry "fetch-fixture" "$fetch_fixture" >/dev/null
assert_eq "2" "$(cat "$test_dir/fetch-attempt")" "truncated tarball retry count"

echo "Test 5: retries missing Nix daemon socket failures without host mutation"
daemon_fixture="$test_dir/daemon-fixture.sh"
cat > "$daemon_fixture" <<EOF
#!/usr/bin/env bash
set -euo pipefail
attempt_file="$test_dir/daemon-attempt"
attempt=1
if [ -f "\$attempt_file" ]; then
  attempt=\$(cat "\$attempt_file")
fi
if [ "\$attempt" -eq 1 ]; then
  echo 2 > "\$attempt_file"
  echo "error: cannot connect to socket at '/nix/var/nix/daemon-socket/socket': No such file or directory" >&2
  exit 1
fi
echo "daemon recovered"
EOF
chmod +x "$daemon_fixture"
daemon_stdout="$test_dir/daemon-stdout"
daemon_started_at="$(date +%s)"
CI_PROGRESS_HEARTBEAT_SECONDS=60 NIX_DAEMON_SOCKET_RETRY_DELAY_SECONDS=1 NIX_GC_RACE_MAX_RETRIES=2 run_nix_gc_race_retry "daemon-fixture" "$daemon_fixture" >"$daemon_stdout"
daemon_elapsed=$(( $(date +%s) - daemon_started_at ))
assert_eq "2" "$(cat "$test_dir/daemon-attempt")" "Nix daemon socket retry count"
assert_contains "waiting 1 s for host supervision" "$daemon_stdout" "daemon recovery ownership"
if [ "$daemon_elapsed" -lt 1 ]; then
  echo "FAIL: daemon socket retry did not wait for host supervision"
  echo "  elapsed: $daemon_elapsed s"
  exit 1
fi

echo "Test 6: helper contains no host daemon mutation commands"
assert_not_contains "sudo systemctl" "$SCRIPT" "systemd daemon mutation removed"
assert_not_contains "sudo launchctl" "$SCRIPT" "launchd daemon mutation removed"
assert_not_contains "nix-daemon --daemon" "$SCRIPT" "manual daemon mutation removed"

echo "Test 7: does not retry when literal signature strings appear outside Nix error context"
false_positive_fixture="$test_dir/false-positive-fixture.sh"
cat > "$false_positive_fixture" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "AssertionError: expected source to contain Failed to convert config.cachix to JSON" >&2
echo "source snippet: while evaluating the option cachix.package" >&2
echo "source snippet: cannot connect to socket at '/nix/var/nix/daemon-socket/socket'" >&2
exit 9
EOF
chmod +x "$false_positive_fixture"
set +e
CI_PROGRESS_HEARTBEAT_SECONDS=1 NIX_GC_RACE_MAX_RETRIES=2 run_nix_gc_race_retry "false-positive-fixture" "$false_positive_fixture" >/dev/null 2>&1
exit_code=$?
set -e
assert_exit_code 9 "$exit_code" "non-error-context strings do not trigger retries"

echo "Test 8: preserves the original exit code when no retry signature is present"
non_retry_fixture="$test_dir/non-retry-fixture.sh"
cat > "$non_retry_fixture" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "ordinary failure" >&2
exit 7
EOF
chmod +x "$non_retry_fixture"
set +e
CI_PROGRESS_HEARTBEAT_SECONDS=1 NIX_GC_RACE_MAX_RETRIES=2 run_nix_gc_race_retry "non-retry-fixture" "$non_retry_fixture" >/dev/null 2>&1
exit_code=$?
set -e
assert_exit_code 7 "$exit_code" "non-signature failures keep their exit code"

echo "Test 9: executes argv without shell eval"
argv_fixture="$test_dir/argv-fixture.sh"
argv_output="$test_dir/argv-output"
cat > "$argv_fixture" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$1" > "$2"
EOF
chmod +x "$argv_fixture"
CI_PROGRESS_HEARTBEAT_SECONDS=1 NIX_GC_RACE_MAX_RETRIES=1 run_nix_gc_race_retry "argv-fixture" "$argv_fixture" 'literal $HOME value' "$argv_output" >/dev/null
assert_eq 'literal $HOME value' "$(cat "$argv_output")" "argv command arguments are not shell-expanded"

echo "Test 10: preserves stdout and stderr while capturing retry signatures"
stdio_fixture="$test_dir/stdio-fixture.sh"
stdio_stdout="$test_dir/stdio-stdout"
stdio_stderr="$test_dir/stdio-stderr"
cat > "$stdio_fixture" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "stdout-marker"
echo "stderr-marker" >&2
exit 3
EOF
chmod +x "$stdio_fixture"
set +e
CI_PROGRESS_HEARTBEAT_SECONDS=1 NIX_GC_RACE_MAX_RETRIES=1 run_nix_gc_race_retry "stdio-fixture" "$stdio_fixture" >"$stdio_stdout" 2>"$stdio_stderr"
exit_code=$?
set -e
assert_exit_code 3 "$exit_code" "stdio fixture keeps original exit code"
assert_contains "stdout-marker" "$stdio_stdout" "stdout marker remains on stdout"
assert_contains "stderr-marker" "$stdio_stderr" "stderr marker remains on stderr"
assert_not_contains "stderr-marker" "$stdio_stdout" "stderr marker does not move to stdout"

echo "Test 11: wrapper script delegates shell commands to the retry helper"
wrapper_attempt_file="$test_dir/wrapper-attempt"
wrapper_command=$(cat <<EOF
attempt=1
if [ -f "$wrapper_attempt_file" ]; then
  attempt=\$(cat "$wrapper_attempt_file")
fi
if [ "\$attempt" -eq 1 ]; then
  echo 2 > "$wrapper_attempt_file"
  echo "error: path '/nix/store/wrapper-fixture-path' is not valid" >&2
  exit 1
fi
echo "wrapper recovered"
EOF
)
CI_PROGRESS_HEARTBEAT_SECONDS=1 NIX_GC_RACE_MAX_RETRIES=2 "$ROOT/genie/ci-scripts/run-with-nix-gc-race-retry.sh" "wrapper-fixture" "$wrapper_command" >/dev/null
assert_eq "2" "$(cat "$wrapper_attempt_file")" "wrapper retry count"

echo "Test 12: retries missing flake input subpaths rendered with guillemets"
subpath_fixture="$test_dir/subpath-fixture.sh"
cat > "$subpath_fixture" <<EOF
#!/usr/bin/env bash
set -euo pipefail
attempt_file="$test_dir/subpath-attempt"
attempt=1
if [ -f "\$attempt_file" ]; then
  attempt=\$(cat "\$attempt_file")
fi
if [ "\$attempt" -eq 1 ]; then
  echo 2 > "\$attempt_file"
  echo "error: path '«github:NixOS/nixpkgs/80bdc1e»/pkgs/build-support/fetchpypi' does not exist" >&2
  exit 1
fi
echo "subpath recovered"
EOF
chmod +x "$subpath_fixture"
subpath_stdout="$test_dir/subpath-stdout"
seed_nix_caches
CI_PROGRESS_HEARTBEAT_SECONDS=1 NIX_GC_RACE_MAX_RETRIES=2 run_nix_gc_race_retry "subpath-fixture" "$subpath_fixture" >"$subpath_stdout"
assert_eq "2" "$(cat "$test_dir/subpath-attempt")" "missing flake subpath retry count"
assert_contains "«github:NixOS/nixpkgs/80bdc1e»/pkgs/build-support/fetchpypi" "$subpath_stdout" "missing subpath is named in the retry warning"
# The repair must clear the caches Determinate Nix actually uses, including the sqlite
# sidecars: a database removed without its -shm/-wal leaves a corrupt cache behind.
assert_missing "$xdg_nix_cache/tarball-cache-v2" "versioned tarball cache purged"
assert_missing "$xdg_nix_cache/gitv3" "versioned git cache purged"
assert_missing "$xdg_nix_cache/fetcher-cache-v4.sqlite" "fetcher cache purged"
assert_missing "$xdg_nix_cache/fetcher-cache-v4.sqlite-shm" "fetcher cache shm sidecar purged"
assert_missing "$xdg_nix_cache/fetcher-cache-v4.sqlite-wal" "fetcher cache wal sidecar purged"
# Both eval-cache roots: the XDG root the helper resolves and the legacy HOME-relative one.
assert_missing "$xdg_nix_cache/eval-cache-v6" "versioned eval cache purged from the XDG root"
assert_missing "$home_nix_cache/eval-cache-v6" "versioned eval cache purged from the legacy HOME root"
# Unrelated caches are not collateral damage.
assert_present "$xdg_nix_cache/binary-cache-v7.sqlite" "binary cache left intact"

echo "Test 13: does not treat a missing plain store path as a missing-subpath transient"
missing_store_path_fixture="$test_dir/missing-store-path-fixture.sh"
cat > "$missing_store_path_fixture" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "error: path '/nix/store/does-not-exist-foo' does not exist" >&2
exit 11
EOF
chmod +x "$missing_store_path_fixture"
set +e
CI_PROGRESS_HEARTBEAT_SECONDS=1 NIX_GC_RACE_MAX_RETRIES=2 run_nix_gc_race_retry "missing-store-path-fixture" "$missing_store_path_fixture" >/dev/null 2>&1
exit_code=$?
set -e
assert_exit_code 11 "$exit_code" "a missing plain path is not a transient flake-subpath failure"

echo "Test 14: does not retry missing-subpath text that is not anchored to a Nix error"
subpath_false_positive_fixture="$test_dir/subpath-false-positive-fixture.sh"
cat > "$subpath_false_positive_fixture" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
# Lowercase `error:` IS present, but 'path' does not directly follow it, so the
# anchored classifier must not treat this as the transient signature.
echo "error: assertion failed while checking that path '«github:NixOS/nixpkgs/80bdc1e»/pkgs/build-support/fetchpypi' does not exist" >&2
exit 12
EOF
chmod +x "$subpath_false_positive_fixture"
set +e
CI_PROGRESS_HEARTBEAT_SECONDS=1 NIX_GC_RACE_MAX_RETRIES=2 run_nix_gc_race_retry "subpath-false-positive-fixture" "$subpath_false_positive_fixture" >/dev/null 2>&1
exit_code=$?
set -e
assert_exit_code 12 "$exit_code" "unanchored missing-subpath text does not trigger retries"

echo "Test 15: repairs a missing flake subpath once, then reports it as permanent"
permanent_fixture="$test_dir/permanent-subpath-fixture.sh"
cat > "$permanent_fixture" <<EOF
#!/usr/bin/env bash
set -euo pipefail
echo \$((\$(cat "$test_dir/permanent-attempts" 2>/dev/null || echo 0) + 1)) > "$test_dir/permanent-attempts"
echo "error: path '«github:NixOS/nixpkgs/80bdc1e»/pkgs/build-support/removed-forever' does not exist" >&2
exit 13
EOF
chmod +x "$permanent_fixture"
permanent_stdout="$test_dir/permanent-stdout"
permanent_summary="$test_dir/permanent-summary"
: > "$permanent_summary"
seed_nix_caches
set +e
CI_PROGRESS_HEARTBEAT_SECONDS=1 NIX_GC_RACE_MAX_RETRIES=10 GITHUB_STEP_SUMMARY="$permanent_summary" run_nix_gc_race_retry "permanent-fixture" "$permanent_fixture" >"$permanent_stdout" 2>&1
exit_code=$?
set -e
assert_exit_code 13 "$exit_code" "a permanently missing subpath keeps its exit code"
assert_eq "2" "$(cat "$test_dir/permanent-attempts")" "a permanently missing subpath is repaired exactly once, not 10 times"
# It is reported as an error naming the path, not as the generic no-signature warning.
assert_contains "::error::Nix flake input subpath still missing" "$permanent_stdout" "the permanent case is reported as an error"
assert_contains "removed-forever" "$permanent_stdout" "the permanent case names the missing path"
assert_not_contains "without a detected transient Nix failure" "$permanent_stdout" "the permanent case does not fall through to the generic no-signature message"
assert_contains "Nix flake input subpath still missing after one cache repair" "$permanent_summary" "the step summary carries the specific permanent-path note"
assert_not_contains "No transient Nix failure signature detected" "$permanent_summary" "the step summary does not carry the generic note"

echo ""
echo "All nix GC race retry helper tests passed"
