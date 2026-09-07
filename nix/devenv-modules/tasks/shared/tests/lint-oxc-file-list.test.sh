#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"

assert_contains() {
  local needle="$1"
  local file="$2"
  local label="$3"

  if ! grep -Fxq "$needle" "$file"; then
    echo "FAIL: $label"
    echo "  missing: $needle"
    echo "  file contents:"
    sed -n '1,120p' "$file"
    exit 1
  fi
  echo "  ok: $label"
}

assert_not_contains() {
  local needle="$1"
  local file="$2"
  local label="$3"

  if grep -Fxq "$needle" "$file"; then
    echo "FAIL: $label"
    echo "  unexpected: $needle"
    echo "  file contents:"
    sed -n '1,120p' "$file"
    exit 1
  fi
  echo "  ok: $label"
}

extract_lint_task_script() {
  local task_name="$1"
  local output_path="$2"

  nix eval --impure --raw --expr "
    let
      flake = builtins.getFlake \"$NIX_FLAKE_REF\";
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      oxfmtPkg = builtins.getEnv \"TEST_FAKE_OXFMT_PKG\";
      # lint-oxc.nix now requires an explicit packaged Genie product; a stub
      # keeps the module hermetic (genie is never invoked by the lint file-list
      # tasks) while satisfying the absolute-path contract.
      geniePkg = pkgs.writeShellScriptBin \"genie\" \"exit 0\";
      evaluated = pkgs.lib.evalModules {
        modules = [
          ({ ... }: {
            options.tasks = pkgs.lib.mkOption { type = pkgs.lib.types.attrsOf pkgs.lib.types.anything; default = { }; };
            options.processes = pkgs.lib.mkOption { type = pkgs.lib.types.attrsOf pkgs.lib.types.anything; default = { }; };
            options.packages = pkgs.lib.mkOption { type = pkgs.lib.types.listOf pkgs.lib.types.anything; default = [ ]; };
          })
          ((import $ROOT/nix/devenv-modules/tasks/shared/lint-oxc.nix {
            lintPaths = [ \".\" ];
            geniePatterns = [ ];
            genieCoverageDirs = [ \".\" ];
            oxfmtPkg = oxfmtPkg;
            geniePkg = geniePkg;
          }) {
            pkgs = pkgs;
            lib = pkgs.lib;
            config = { };
          })
        ];
      };
    in evaluated.config.tasks.\"${task_name}\".exec
  " > "$output_path"
  chmod +x "$output_path"
}

echo "Running lint-oxc file list tests..."
echo ""

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

workspace="$tmpdir/workspace"
mkdir -p "$workspace/node_modules/pkg" "$tmpdir/bin"

cat > "$tmpdir/bin/oxlint" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
# Per-invocation record. The partition contract is about HOW MANY times the tool
# runs and with WHICH files each time, so a single overwritten arg file cannot
# express it: every invocation appends a `=== unit` header plus its argv.
if [ -n "${TEST_OXLINT_INVOCATIONS:-}" ]; then
  {
    echo "=== unit"
    printf '%s\n' "$@"
  } >> "$TEST_OXLINT_INVOCATIONS"
fi
# Fail exactly one ownership unit, with the real tsgolint crash shape (stdout,
# no trailing newline). Later units must still run and the overall task must
# still be nonzero.
if [ -n "${TEST_OXLINT_FAIL_ON:-}" ]; then
  for arg in "$@"; do
    if [ "$arg" = "$TEST_OXLINT_FAIL_ON" ]; then
      printf '%s' 'Error running tsgolint: "exit status: signal: 9 (SIGKILL)"'
      exit 1
    fi
  done
fi
# Optionally emit one ordinary newline-terminated line from a later ownership
# unit. Together with TEST_OXLINT_FAIL_ON this proves unit output boundaries:
# the line must never attach to the failing unit's newline-less SIGKILL report.
if [ -n "${TEST_OXLINT_EMIT_ON:-}" ]; then
  for arg in "$@"; do
    if [ "$arg" = "$TEST_OXLINT_EMIT_ON" ]; then
      printf '%s\n' "${TEST_OXLINT_EMIT_TEXT:?}"
      exit 0
    fi
  done
fi
# Silent nonzero exit: the exact shape that made a red CI oxlint task
# unattributable (exit 1, no stdout, no diagnostics). Under `xargs` the child
# status is additionally collapsed to 123, so the task boundary must name the
# lane, stage, status and file count itself.
if [ "${TEST_OXLINT_SILENT_FAILURE:-0}" = 1 ]; then
  exit 1
fi
# Ordinary lint findings: nonzero WITH stdout. Proves the byte accounting is a
# pass-through — findings must still reach stdout verbatim.
if [ "${TEST_OXLINT_LOUD_FAILURE:-0}" = 1 ]; then
  echo "fixture.ts:1:1: error: no-debugger"
  exit 1
fi
# The real tsgolint crash shape: oxlint prints its report to STDOUT with NO
# trailing newline and exits nonzero. devenv relays a failing task's output by
# lines and drops the chunk after the last newline at EOF, so this exact tail
# was the fatal-but-invisible CI failure. printf (not echo) keeps the byte
# stream newline-less on purpose — do not "fix" it.
if [ "${TEST_OXLINT_TSGOLINT_SIGKILL:-0}" = 1 ]; then
  printf '%s' 'Error running tsgolint: "exit status: signal: 9 (SIGKILL)"'
  exit 1
fi
# A failing tool whose stdout ends in a literal NUL byte (a truncated/holed
# write). This byte is NOT a newline, so the failure path must still complete
# the line. Text-based tail inspection cannot see it: command substitution
# drops NUL bytes, making the tail look newline-terminated.
if [ "${TEST_OXLINT_NUL_TAIL:-0}" = 1 ]; then
  printf 'partial finding\000'
  exit 1
fi
printf '%s\n' "$@" > "${TEST_OXLINT_ARGS:?}"
EOF
cat > "$tmpdir/bin/oxfmt" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
# Real oxfmt exits 2 for an all-ignored batch (empirically verified), printing the
# empty-selection diagnostic to stderr. The swallow keys on exit-code 2 AND the
# diagnostic substring, so this stub models the true exit code (was 1).
if [ "${TEST_OXFMT_EMPTY_TARGET_ERROR:-0}" = 1 ]; then
  echo "Expected at least one target file" >&2
  exit 2
fi
# Real oxfmt also exits 2 on a genuine parse error, but WITHOUT the empty-selection
# diagnostic. Modeling this at exit 2 proves the substring guard keeps such errors
# from being swallowed even though they share the empty-selection exit code.
if [ "${TEST_OXFMT_OTHER_ERROR:-0}" = 1 ]; then
  echo "parse error" >&2
  exit 2
fi
# Mixed empty-target + real error. Kept at exit 1 (a formatting-diff-style failure)
# so it is NOT the pure all-ignored (exit 2) case: the swallow must let it fail
# rather than hide the real error. Do NOT change to exit 2 or the real error would
# be swallowed alongside the diagnostic substring.
if [ "${TEST_OXFMT_MIXED_EMPTY_TARGET_ERROR:-0}" = 1 ]; then
  echo "Expected at least one target file" >&2
  echo "parse error" >&2
  exit 1
fi
printf '%s\n' "$@" > "${TEST_OXFMT_ARGS:?}"
EOF
chmod +x "$tmpdir/bin/oxfmt"
chmod +x "$tmpdir/bin/oxlint"
export TEST_FAKE_OXFMT_PKG="$tmpdir"

cat > "$workspace/keep.ts" <<'EOF'
export const keep = true
EOF
cat > "$workspace/deleted.ts" <<'EOF'
export const deleted = true
EOF
cat > "$workspace/new.ts" <<'EOF'
export const fresh = true
EOF
cat > "$workspace/.gitignore" <<'EOF'
node_modules/
EOF
cat > "$workspace/node_modules/pkg/ignored.ts" <<'EOF'
export const ignored = true
EOF
cat > "$workspace/fixture.kdl" <<'EOF'
node "unsupported"
EOF
cat > "$workspace/lib.rs" <<'EOF'
pub fn unsupported() {}
EOF
cat > "$workspace/readme.md" <<'EOF'
# Supported by oxfmt
EOF
cat > "$workspace/config.json" <<'EOF'
{"supported": true}
EOF
cat > "$workspace/module.mts" <<'EOF'
export const module = true
EOF
cat > "$workspace/common.cts" <<'EOF'
export const common = true
EOF
cat > "$workspace/view.vue" <<'EOF'
<script setup lang="ts">const view = true</script>
EOF
cat > "$workspace/card.svelte" <<'EOF'
<script lang="ts">const card = true</script>
EOF
cat > "$workspace/page.astro" <<'EOF'
---
const page = true
---
EOF
cat > "$workspace/config.json5" <<'EOF'
{supported: true}
EOF
cat > "$workspace/styles.scss" <<'EOF'
.supported { color: red; }
EOF
cat > "$workspace/notes.mdx" <<'EOF'
# Supported by oxfmt
EOF
cat > "$workspace/query.graphql" <<'EOF'
query Supported { node { id } }
EOF
cat > "$workspace/template.hbs" <<'EOF'
<p>{{supported}}</p>
EOF

(
  cd "$workspace"
  git init --quiet
  git add .gitignore keep.ts deleted.ts fixture.kdl lib.rs readme.md config.json \
    module.mts common.cts view.vue card.svelte page.astro config.json5 styles.scss \
    notes.mdx query.graphql template.hbs
  rm deleted.ts
)

extract_lint_task_script "lint:check:oxlint" "$tmpdir/lint-check-oxlint.sh"
extract_lint_task_script "lint:check:format" "$tmpdir/lint-check-format.sh"
extract_lint_task_script "lint:check:genie" "$tmpdir/lint-check-genie.sh"

# The injected geniePkg must be executed by absolute store path, never via PATH.
if ! grep -Eq '/nix/store/[^ ]*-genie/bin/genie --check' "$tmpdir/lint-check-genie.sh"; then
  echo "FAIL: lint:check:genie should exec the injected geniePkg by absolute store path"
  cat "$tmpdir/lint-check-genie.sh"
  exit 1
fi

export PATH="$tmpdir/bin:$PATH"
export TEST_OXLINT_ARGS="$tmpdir/oxlint-args.txt"
export TEST_OXFMT_ARGS="$tmpdir/oxfmt-args.txt"

echo "Test 1: lint task skips tracked paths deleted from the worktree"
(
  cd "$workspace"
  bash "$tmpdir/lint-check-oxlint.sh"
)

assert_contains "keep.ts" "$TEST_OXLINT_ARGS" "tracked existing file is linted"
assert_contains "new.ts" "$TEST_OXLINT_ARGS" "untracked non-ignored file is linted"
assert_contains "module.mts" "$TEST_OXLINT_ARGS" "MTS file is linted by oxlint"
assert_contains "common.cts" "$TEST_OXLINT_ARGS" "CTS file is linted by oxlint"
assert_contains "view.vue" "$TEST_OXLINT_ARGS" "Vue file is linted by oxlint"
assert_contains "card.svelte" "$TEST_OXLINT_ARGS" "Svelte file is linted by oxlint"
assert_contains "page.astro" "$TEST_OXLINT_ARGS" "Astro file is linted by oxlint"
assert_not_contains "deleted.ts" "$TEST_OXLINT_ARGS" "tracked deleted file is filtered"
assert_not_contains "node_modules/pkg/ignored.ts" "$TEST_OXLINT_ARGS" "ignored file is not linted"
assert_not_contains "fixture.kdl" "$TEST_OXLINT_ARGS" "unsupported KDL fixture is not linted by oxlint"
assert_not_contains "lib.rs" "$TEST_OXLINT_ARGS" "unsupported Rust file is not linted by oxlint"
assert_not_contains "readme.md" "$TEST_OXLINT_ARGS" "Markdown file is not linted by oxlint"
assert_not_contains "config.json" "$TEST_OXLINT_ARGS" "JSON file is not linted by oxlint"
assert_not_contains "config.json5" "$TEST_OXLINT_ARGS" "JSON5 file is not linted by oxlint"
assert_not_contains "styles.scss" "$TEST_OXLINT_ARGS" "SCSS file is not linted by oxlint"
assert_not_contains "notes.mdx" "$TEST_OXLINT_ARGS" "MDX file is not linted by oxlint"
assert_not_contains "query.graphql" "$TEST_OXLINT_ARGS" "GraphQL file is not linted by oxlint"
assert_not_contains "template.hbs" "$TEST_OXLINT_ARGS" "Handlebars file is not linted by oxlint"

echo ""
echo "Test 2: format task keeps oxfmt-supported files and skips unsupported paths"
(
  cd "$workspace"
  bash "$tmpdir/lint-check-format.sh"
)

assert_contains "keep.ts" "$TEST_OXFMT_ARGS" "tracked TypeScript file is formatted"
assert_contains "new.ts" "$TEST_OXFMT_ARGS" "untracked TypeScript file is formatted"
assert_contains "module.mts" "$TEST_OXFMT_ARGS" "MTS file is formatted"
assert_contains "common.cts" "$TEST_OXFMT_ARGS" "CTS file is formatted"
assert_contains "view.vue" "$TEST_OXFMT_ARGS" "Vue file is formatted"
assert_contains "readme.md" "$TEST_OXFMT_ARGS" "Markdown file is formatted"
assert_contains "config.json" "$TEST_OXFMT_ARGS" "JSON file is formatted"
assert_contains "config.json5" "$TEST_OXFMT_ARGS" "JSON5 file is formatted"
assert_contains "styles.scss" "$TEST_OXFMT_ARGS" "SCSS file is formatted"
assert_contains "notes.mdx" "$TEST_OXFMT_ARGS" "MDX file is formatted"
assert_contains "query.graphql" "$TEST_OXFMT_ARGS" "GraphQL file is formatted"
assert_contains "template.hbs" "$TEST_OXFMT_ARGS" "Handlebars file is formatted"
assert_not_contains "deleted.ts" "$TEST_OXFMT_ARGS" "tracked deleted file is filtered for oxfmt"
assert_not_contains "fixture.kdl" "$TEST_OXFMT_ARGS" "unsupported KDL fixture is not formatted"
assert_not_contains "lib.rs" "$TEST_OXFMT_ARGS" "unsupported Rust file is not formatted"
assert_not_contains "node_modules/pkg/ignored.ts" "$TEST_OXFMT_ARGS" "ignored file is not formatted"

echo ""
echo "Test 3: format task treats an oxfmt all-ignored chunk as empty work"
export TEST_OXFMT_EMPTY_TARGET_ERROR=1
(
  cd "$workspace"
  bash "$tmpdir/lint-check-format.sh"
)
unset TEST_OXFMT_EMPTY_TARGET_ERROR

echo ""
echo "Test 4: format task still fails real oxfmt errors"
export TEST_OXFMT_OTHER_ERROR=1
if (
  cd "$workspace"
  bash "$tmpdir/lint-check-format.sh"
); then
  echo "FAIL: non-empty oxfmt errors must fail"
  exit 1
fi
unset TEST_OXFMT_OTHER_ERROR

echo ""
echo "Test 5: format task does not hide mixed empty-target and real errors"
export TEST_OXFMT_MIXED_EMPTY_TARGET_ERROR=1
if (
  cd "$workspace"
  bash "$tmpdir/lint-check-format.sh"
); then
  echo "FAIL: mixed empty-target and real oxfmt errors must fail"
  exit 1
fi
unset TEST_OXFMT_MIXED_EMPTY_TARGET_ERROR

echo ""
echo "Test 6: a silent nonzero lint child is attributed at the task boundary"
export TEST_OXLINT_SILENT_FAILURE=1
oxlint_silent_status=0
oxlint_silent_stderr="$tmpdir/oxlint-silent.stderr"
oxlint_silent_stdout="$tmpdir/oxlint-silent.stdout"
# stdout is redirected to a FILE so the zero-byte assertion below inspects the
# exact stream independently of the terminal-path coverage in Test 16.
(
  cd "$workspace"
  bash "$tmpdir/lint-check-oxlint.sh"
) > "$oxlint_silent_stdout" 2> "$oxlint_silent_stderr" || oxlint_silent_status=$?
unset TEST_OXLINT_SILENT_FAILURE

if [ "$oxlint_silent_status" -eq 0 ]; then
  echo "FAIL: a silent nonzero lint child must keep the task nonzero"
  exit 1
fi
echo "  ok: task status stays nonzero ($oxlint_silent_status)"

for needle in \
  "lint-oxc: lane=lint:check:oxlint stage=run" \
  "status=$oxlint_silent_status" \
  "files=" \
  "stdout_bytes=0" \
  "command=oxlint --import-plugin"; do
  if ! grep -qF -- "$needle" "$oxlint_silent_stderr"; then
    echo "FAIL: failure diagnostic must contain: $needle"
    echo "  actual stderr:"
    sed -n '1,40p' "$oxlint_silent_stderr"
    exit 1
  fi
  echo "  ok: diagnostic names $needle"
done

if [ -s "$oxlint_silent_stdout" ]; then
  echo "FAIL: the mute-tool case must really have had empty stdout"
  exit 1
fi
echo "  ok: stdout_bytes=0 matches an actually empty stdout"

echo ""
echo "Test 7: a setup/scan failure names its stage, line and status"
scan_status=0
scan_stderr="$tmpdir/scan.stderr"
non_git="$tmpdir/not-a-repo"
mkdir -p "$non_git"
(
  cd "$non_git"
  GIT_CEILING_DIRECTORIES="$tmpdir" bash "$tmpdir/lint-check-oxlint.sh"
) 2> "$scan_stderr" || scan_status=$?

if [ "$scan_status" -eq 0 ]; then
  echo "FAIL: a failing file scan must not report success"
  exit 1
fi
for needle in \
  "lint-oxc: lane=lint:check:oxlint stage=scan aborted at line" \
  "with status"; do
  if ! grep -qF -- "$needle" "$scan_stderr"; then
    echo "FAIL: scan-stage diagnostic must contain: $needle"
    echo "  actual stderr:"
    sed -n '1,40p' "$scan_stderr"
    exit 1
  fi
  echo "  ok: diagnostic names $needle"
done

echo ""
echo "Test 8: lint findings still stream to stdout on a failing run"
export TEST_OXLINT_LOUD_FAILURE=1
loud_status=0
loud_stdout="$tmpdir/oxlint-loud.stdout"
loud_stderr="$tmpdir/oxlint-loud.stderr"
(
  cd "$workspace"
  bash "$tmpdir/lint-check-oxlint.sh"
) > "$loud_stdout" 2> "$loud_stderr" || loud_status=$?
unset TEST_OXLINT_LOUD_FAILURE

if [ "$loud_status" -eq 0 ]; then
  echo "FAIL: a failing lint run must stay nonzero"
  exit 1
fi
if ! grep -qF -- "error: no-debugger" "$loud_stdout"; then
  echo "FAIL: findings must reach stdout verbatim"
  sed -n '1,20p' "$loud_stdout"
  exit 1
fi
echo "  ok: findings stream through to stdout"
if grep -qF -- "stdout_bytes=0" "$loud_stderr"; then
  echo "FAIL: a run that printed findings must not be reported as mute"
  sed -n '1,20p' "$loud_stderr"
  exit 1
fi
echo "  ok: the diagnostic reports a nonzero stdout byte count"

echo ""
echo "Test 9: a redirected regular-file stdout is appended to, never reopened"
# The task's stdout here is a REGULAR FILE that already holds bytes and whose
# offset has advanced — a CI log. Naming the inherited descriptor as a path
# (`tee /dev/fd/3`) reopens it with O_TRUNC: the BEFORE sentinel disappears and
# the outer offset leaves a NUL hole. Only duplication (`>&3`) is safe.
export TEST_OXLINT_LOUD_FAILURE=1
log_file="$tmpdir/task.log"
log_stderr="$tmpdir/task.log.stderr"
log_status=0
{
  echo "BEFORE-SENTINEL"
  (
    cd "$workspace"
    bash "$tmpdir/lint-check-oxlint.sh"
  ) || log_status=$?
  echo "AFTER-SENTINEL"
} > "$log_file" 2> "$log_stderr"
unset TEST_OXLINT_LOUD_FAILURE

if [ "$log_status" -eq 0 ]; then
  echo "FAIL: a failing lint run must stay nonzero with a file-redirected stdout"
  exit 1
fi
echo "  ok: status stays nonzero ($log_status)"

log_lines="$(grep -n -e BEFORE-SENTINEL -e 'error: no-debugger' -e AFTER-SENTINEL "$log_file" | cut -d: -f2- | paste -sd'|' -)"
if [ "$log_lines" != "BEFORE-SENTINEL|fixture.ts:1:1: error: no-debugger|AFTER-SENTINEL" ]; then
  echo "FAIL: log must keep BEFORE, the finding and AFTER in order"
  echo "  got: $log_lines"
  echo "  raw log:"
  cat -A "$log_file" | sed -n '1,20p'
  exit 1
fi
echo "  ok: BEFORE sentinel, finding and AFTER sentinel survive in order"

log_size="$(wc -c < "$log_file")"
log_size_without_nul="$(tr -d '\0' < "$log_file" | wc -c)"
if [ "$log_size" != "$log_size_without_nul" ]; then
  echo "FAIL: log contains NUL padding — stdout was reopened/truncated"
  cat -A "$log_file" | sed -n '1,20p'
  exit 1
fi
echo "  ok: no NUL hole (stdout descriptor was duplicated, not reopened)"

finding_bytes="$(printf 'fixture.ts:1:1: error: no-debugger\n' | wc -c)"
if ! grep -qF -- "stdout_bytes=$finding_bytes" "$log_stderr"; then
  echo "FAIL: byte count must match the finding actually written"
  echo "  expected stdout_bytes=$finding_bytes"
  sed -n '1,20p' "$log_stderr"
  exit 1
fi
echo "  ok: reported stdout_bytes matches the streamed bytes"

echo ""
echo "Test 10: a newline-less failing stdout tail survives EOF and is terminated"
export TEST_OXLINT_TSGOLINT_SIGKILL=1
tsgolint_text='Error running tsgolint: "exit status: signal: 9 (SIGKILL)"'
tsgolint_stdout="$tmpdir/oxlint-tsgolint.stdout"
tsgolint_stderr="$tmpdir/oxlint-tsgolint.stderr"
tsgolint_status=0
(
  cd "$workspace"
  bash "$tmpdir/lint-check-oxlint.sh"
) > "$tsgolint_stdout" 2> "$tsgolint_stderr" || tsgolint_status=$?
unset TEST_OXLINT_TSGOLINT_SIGKILL

if [ "$tsgolint_status" -eq 0 ]; then
  echo "FAIL: a crashing lint child must keep the task nonzero"
  exit 1
fi
echo "  ok: status stays nonzero ($tsgolint_status)"

# The tail must be a COMPLETE line: identical text plus the terminating newline
# the tool never wrote, and nothing else.
if [ "$(cat "$tsgolint_stdout")" != "$tsgolint_text" ]; then
  echo "FAIL: the crash text must reach stdout verbatim"
  echo "  actual stdout:"
  cat "$tsgolint_stdout"
  exit 1
fi
echo "  ok: crash text reaches stdout verbatim"

tsgolint_bytes="$(wc -c < "$tsgolint_stdout" | tr -d ' ')"
tsgolint_text_bytes="$(printf '%s' "$tsgolint_text" | wc -c | tr -d ' ')"
if [ "$tsgolint_bytes" != "$((tsgolint_text_bytes + 1))" ]; then
  echo "FAIL: stdout must be the crash text plus exactly one added newline"
  echo "  text bytes: $tsgolint_text_bytes, stdout bytes: $tsgolint_bytes"
  exit 1
fi
if [ "$(tail -c 1 "$tsgolint_stdout" | od -An -c | tr -d ' ')" != '\n' ]; then
  echo "FAIL: the failing stdout tail must end in a newline for devenv's line relay"
  exit 1
fi
echo "  ok: tail is newline-terminated (${tsgolint_bytes} = ${tsgolint_text_bytes} + 1 bytes)"

for needle in \
  "stdout_bytes=$tsgolint_text_bytes" \
  "stdout_tail=no-newline"; do
  if ! grep -qF -- "$needle" "$tsgolint_stderr"; then
    echo "FAIL: failure diagnostic must contain: $needle"
    echo "  actual stderr:"
    sed -n '1,40p' "$tsgolint_stderr"
    exit 1
  fi
  echo "  ok: diagnostic names $needle"
done

# Memory evidence turns "probably OOM" into a fact (or an explicit
# unavailability). Either shape is acceptable — the host may not expose cgroup
# v2 — but the diagnostic must never be silent about it.
if grep -qE 'lint-oxc: lane=lint:check:oxlint stage=run cgroup=\S+ memory\.events=\[.*\] memory\.peak=\S+ memory\.max=\S+' "$tsgolint_stderr"; then
  echo "  ok: cgroup v2 memory evidence is reported"
  grep -oE 'memory\.events=\[[^]]*\] memory\.peak=\S+ memory\.max=\S+' "$tsgolint_stderr" | sed 's/^/    /'
elif grep -qF -- 'memory=unavailable (no readable cgroup v2)' "$tsgolint_stderr"; then
  echo "  ok: memory evidence is explicitly labelled unavailable on this host"
else
  echo "FAIL: failure diagnostic must report cgroup memory evidence or label it unavailable"
  sed -n '1,40p' "$tsgolint_stderr"
  exit 1
fi

# A successful run must stay byte-identical: no added newline, no diagnostics.
success_stdout="$tmpdir/oxlint-success.stdout"
success_stderr="$tmpdir/oxlint-success.stderr"
(
  cd "$workspace"
  bash "$tmpdir/lint-check-oxlint.sh"
) > "$success_stdout" 2> "$success_stderr"
if grep -qE 'stdout_tail=|memory\.events=|memory=unavailable' "$success_stderr"; then
  echo "FAIL: a passing lint run must not emit failure diagnostics"
  sed -n '1,40p' "$success_stderr"
  exit 1
fi
echo "  ok: a passing run emits no failure diagnostics"

echo ""
echo "Test 11: a NUL-terminated failing stdout tail is classified as no-newline"
# Regression: the tail byte used to be inspected as TEXT via command
# substitution, which strips trailing newlines and drops NUL bytes alike. A
# stream ending in a literal NUL therefore looked newline-terminated, the
# line-completing newline was suppressed, and devenv dropped the final chunk
# again. Classification must be byte-exact (LF = 10), not text-emptiness.
export TEST_OXLINT_NUL_TAIL=1
nul_text='partial finding'
nul_stdout="$tmpdir/oxlint-nul.stdout"
nul_stderr="$tmpdir/oxlint-nul.stderr"
nul_status=0
(
  cd "$workspace"
  bash "$tmpdir/lint-check-oxlint.sh"
) > "$nul_stdout" 2> "$nul_stderr" || nul_status=$?
unset TEST_OXLINT_NUL_TAIL

if [ "$nul_status" -eq 0 ]; then
  echo "FAIL: a failing lint child must keep the task nonzero"
  exit 1
fi
echo "  ok: status stays nonzero ($nul_status)"

# Streamed bytes = text + the NUL itself; stdout then carries one added newline.
nul_stream_bytes="$(printf '%s\000' "$nul_text" | wc -c | tr -d ' ')"
nul_stdout_bytes="$(wc -c < "$nul_stdout" | tr -d ' ')"
if [ "$nul_stdout_bytes" != "$((nul_stream_bytes + 1))" ]; then
  echo "FAIL: stdout must be the NUL-terminated payload plus exactly one added newline"
  echo "  stream bytes: $nul_stream_bytes, stdout bytes: $nul_stdout_bytes"
  od -An -c "$nul_stdout" | sed 's/^/    /'
  exit 1
fi
if [ "$(tail -c 1 "$nul_stdout" | od -An -tu1 | tr -d ' ')" != 10 ]; then
  echo "FAIL: a NUL tail must still be completed with a newline for devenv's line relay"
  od -An -c "$nul_stdout" | sed 's/^/    /'
  exit 1
fi
if [ "$(tail -c 2 "$nul_stdout" | head -c 1 | od -An -tu1 | tr -d ' ')" != 0 ]; then
  echo "FAIL: the original NUL byte must survive verbatim before the added newline"
  od -An -c "$nul_stdout" | sed 's/^/    /'
  exit 1
fi
echo "  ok: NUL byte survives and the line is completed (${nul_stdout_bytes} = ${nul_stream_bytes} + 1 bytes)"

for needle in \
  "stdout_bytes=$nul_stream_bytes" \
  "stdout_tail=no-newline"; do
  if ! grep -qF -- "$needle" "$nul_stderr"; then
    echo "FAIL: failure diagnostic must contain: $needle"
    echo "  actual stderr:"
    sed -n '1,40p' "$nul_stderr"
    exit 1
  fi
  echo "  ok: diagnostic names $needle"
done

echo ""
echo "Test 12: the lint surface is partitioned per nearest owning tsconfig.json"
# CI #5370: one oxlint call over the whole surface hands tsgolint every file at
# once and the host is OOM-killed (oom_kill=1, 14.78 GiB of 16 GiB, tsgolint
# SIGKILL). The fix is ownership partitioning: each directory holding a LITERAL
# tsconfig.json is one unit, files owned by none form one residual unit, and the
# units run sequentially. The union must be exactly the previously linted set —
# no file dropped, none linted twice — so lint semantics are unchanged.
partition="$tmpdir/partition"
mkdir -p \
  "$partition/packages/a/src" \
  "$partition/packages/b/src" \
  "$partition/packages/b/nested" \
  "$partition/scripts"

for cfg in packages/a packages/b packages/b/nested; do
  echo '{"compilerOptions":{}}' > "$partition/$cfg/tsconfig.json"
done
for src in \
  packages/a/src/one.ts \
  packages/a/two.ts \
  packages/a/untracked.ts \
  packages/b/src/three.ts \
  packages/b/nested/four.ts \
  scripts/tool.ts \
  top.ts; do
  echo "export const x = true" > "$partition/$src"
done

(
  cd "$partition"
  git init --quiet
  # `untracked.ts` stays untracked-but-not-ignored on purpose: it is part of the
  # lint surface, so it must land in its owning unit like a tracked file.
  git add packages scripts top.ts
  git rm --cached --quiet packages/a/untracked.ts
)

partition_invocations="$tmpdir/partition-invocations.txt"
: > "$partition_invocations"
(
  cd "$partition"
  TEST_OXLINT_INVOCATIONS="$partition_invocations" bash "$tmpdir/lint-check-oxlint.sh"
)

read_unit_signatures() {
  local record="$1"
  local -a cur=()
  local line
  local skip_value=0
  while IFS= read -r line; do
    if [ "$line" = "=== unit" ]; then
      if [ "${#cur[@]}" -gt 0 ]; then
        printf '%s\n' "$(printf '%s\n' "${cur[@]}" | sort | paste -sd, -)"
      fi
      cur=()
    else
      # argv carries the invariant flags (`--import-plugin`, `--deny-warnings`,
      # and `--tsconfig <path>` when type-aware linting is on) ahead of the
      # files; the partition contract is about the FILES.
      case "$line" in
        --tsconfig) skip_value=1 ;;
        -*) ;;
        *)
          if [ "$skip_value" = 1 ]; then
            skip_value=0
          else
            cur+=("$line")
          fi
          ;;
      esac
    fi
  done < "$record"
  if [ "${#cur[@]}" -gt 0 ]; then
    printf '%s\n' "$(printf '%s\n' "${cur[@]}" | sort | paste -sd, -)"
  fi
}

actual_units="$(read_unit_signatures "$partition_invocations" | sort)"
expected_units="$(
  cat <<'EOF' | sort
packages/a/src/one.ts,packages/a/two.ts,packages/a/untracked.ts
packages/b/nested/four.ts
packages/b/src/three.ts
scripts/tool.ts,top.ts
EOF
)"
if [ "$actual_units" != "$expected_units" ]; then
  echo "FAIL: lint units must be one per owning tsconfig.json plus one residual"
  echo "  expected:"
  printf '    %s\n' $expected_units
  echo "  actual:"
  printf '    %s\n' $actual_units
  exit 1
fi
echo "  ok: one invocation per owning package plus one residual unit"

union="$(read_unit_signatures "$partition_invocations" | tr ',' '\n' | sort)"
union_unique="$(printf '%s\n' "$union" | sort -u)"
if [ "$union" != "$union_unique" ]; then
  echo "FAIL: a file was linted by more than one unit"
  printf '%s\n' "$union" | uniq -d
  exit 1
fi
echo "  ok: no file appears in two units"

expected_union="$(
  cat <<'EOF' | sort
packages/a/src/one.ts
packages/a/two.ts
packages/a/untracked.ts
packages/b/nested/four.ts
packages/b/src/three.ts
scripts/tool.ts
top.ts
EOF
)"
if [ "$union" != "$expected_union" ]; then
  echo "FAIL: the union of all units must equal the tracked lint surface exactly"
  diff <(printf '%s\n' "$expected_union") <(printf '%s\n' "$union") || true
  exit 1
fi
echo "  ok: union equals the full lint surface"

echo ""
echo "Test 13: one failing unit fails the task without hiding its output"
partition_fail_invocations="$tmpdir/partition-fail-invocations.txt"
: > "$partition_fail_invocations"
partition_fail_stdout="$tmpdir/partition-fail.stdout"
partition_fail_stderr="$tmpdir/partition-fail.stderr"
partition_fail_status=0
(
  cd "$partition"
  TEST_OXLINT_INVOCATIONS="$partition_fail_invocations" \
    TEST_OXLINT_FAIL_ON="packages/b/src/three.ts" \
    bash "$tmpdir/lint-check-oxlint.sh"
) > "$partition_fail_stdout" 2> "$partition_fail_stderr" || partition_fail_status=$?

if [ "$partition_fail_status" -eq 0 ]; then
  echo "FAIL: a failing unit must make the whole task nonzero"
  exit 1
fi
echo "  ok: task status stays nonzero ($partition_fail_status)"

partition_fail_text='Error running tsgolint: "exit status: signal: 9 (SIGKILL)"'
if [ "$(cat "$partition_fail_stdout")" != "$partition_fail_text" ]; then
  echo "FAIL: the failing unit's stdout must survive verbatim"
  echo "  actual:"
  sed -n '1,20p' "$partition_fail_stdout"
  exit 1
fi
if [ "$(tail -c 1 "$partition_fail_stdout" | od -An -tu1 | tr -d ' ')" != 10 ]; then
  echo "FAIL: the newline-less failing tail must still be completed"
  exit 1
fi
echo "  ok: newline-less unit output reaches stdout and is line-completed"

partition_fail_unit_count="$(grep -cxF '=== unit' "$partition_fail_invocations")"
if [ "$partition_fail_unit_count" != 4 ]; then
  echo "FAIL: every unit must run even after one fails (ran $partition_fail_unit_count of 4)"
  exit 1
fi
echo "  ok: all 4 units ran; the failure is aggregated, not short-circuiting"

for needle in \
  "lint-oxc: lane=lint:check:oxlint stage=run" \
  "units=4" \
  "failed_units=1" \
  "first_failed_unit=packages/b" \
  "stdout_tail=no-newline"; do
  if ! grep -qF -- "$needle" "$partition_fail_stderr"; then
    echo "FAIL: failure diagnostic must contain: $needle"
    echo "  actual stderr:"
    sed -n '1,40p' "$partition_fail_stderr"
    exit 1
  fi
  echo "  ok: diagnostic names $needle"
done

echo ""
echo "Test 14: a fully passing partitioned run keeps success semantics"
partition_ok_stdout="$tmpdir/partition-ok.stdout"
partition_ok_stderr="$tmpdir/partition-ok.stderr"
(
  cd "$partition"
  bash "$tmpdir/lint-check-oxlint.sh"
) > "$partition_ok_stdout" 2> "$partition_ok_stderr"
if grep -qE 'stdout_tail=|failed_units=|memory\.events=|memory=unavailable' "$partition_ok_stderr"; then
  echo "FAIL: a passing partitioned run must emit no failure diagnostics"
  sed -n '1,40p' "$partition_ok_stderr"
  exit 1
fi
if [ -s "$partition_ok_stdout" ]; then
  echo "FAIL: a passing partitioned run must not add stdout of its own"
  sed -n '1,20p' "$partition_ok_stdout"
  exit 1
fi
echo "  ok: exit 0, no added stdout, no diagnostics"

echo ""
echo "Test 15: a newline-less middle unit owns its output boundary"
partition_boundary_invocations="$tmpdir/partition-boundary-invocations.txt"
: > "$partition_boundary_invocations"
partition_boundary_stdout="$tmpdir/partition-boundary.stdout"
partition_boundary_stderr="$tmpdir/partition-boundary.stderr"
partition_boundary_expected="$tmpdir/partition-boundary.expected"
partition_boundary_status=0
partition_boundary_crash='Error running tsgolint: "exit status: signal: 9 (SIGKILL)"'
partition_boundary_later='later unit output'
partition_boundary_crash_bytes="$(printf '%s' "$partition_boundary_crash" | wc -c | tr -d ' ')"
if [ "$partition_boundary_crash_bytes" != 58 ]; then
  echo "FAIL: regression fixture must retain the exact 58-byte tsgolint crash text"
  exit 1
fi
(
  cd "$partition"
  TEST_OXLINT_INVOCATIONS="$partition_boundary_invocations" \
    TEST_OXLINT_FAIL_ON="packages/b/nested/four.ts" \
    TEST_OXLINT_EMIT_ON="scripts/tool.ts" \
    TEST_OXLINT_EMIT_TEXT="$partition_boundary_later" \
    bash "$tmpdir/lint-check-oxlint.sh"
) > "$partition_boundary_stdout" 2> "$partition_boundary_stderr" || partition_boundary_status=$?

if [ "$partition_boundary_status" -eq 0 ]; then
  echo "FAIL: the middle unit failure must make the task nonzero"
  exit 1
fi
echo "  ok: task status stays nonzero ($partition_boundary_status)"

# Exact bytes: the tool's 58-byte crash text, exactly ONE inserted LF at that
# unit boundary, then the later unit's ordinary newline-terminated line.
printf '%s\n%s\n' "$partition_boundary_crash" "$partition_boundary_later" \
  > "$partition_boundary_expected"
if ! cmp -s "$partition_boundary_expected" "$partition_boundary_stdout"; then
  echo "FAIL: adjacent unit outputs must be two separate complete lines"
  echo "  expected bytes:"
  od -An -tu1 "$partition_boundary_expected"
  echo "  actual bytes:"
  od -An -tu1 "$partition_boundary_stdout"
  exit 1
fi
partition_boundary_lines="$(wc -l < "$partition_boundary_stdout" | tr -d ' ')"
if [ "$partition_boundary_lines" != 2 ]; then
  echo "FAIL: expected exactly two output lines, got $partition_boundary_lines"
  exit 1
fi
echo "  ok: exactly one LF separates the 58-byte crash from later output"

partition_boundary_unit_count="$(grep -cxF '=== unit' "$partition_boundary_invocations")"
if [ "$partition_boundary_unit_count" != 4 ]; then
  echo "FAIL: every unit must run after the middle failure (ran $partition_boundary_unit_count of 4)"
  exit 1
fi
echo "  ok: all 4 units ran"

partition_boundary_later_bytes="$(printf '%s\n' "$partition_boundary_later" | wc -c | tr -d ' ')"
partition_boundary_tool_bytes="$((partition_boundary_crash_bytes + partition_boundary_later_bytes))"
for needle in \
  "units=4" \
  "failed_units=1" \
  "first_failed_unit=packages/b/nested" \
  "stdout_bytes=$partition_boundary_tool_bytes" \
  "stdout_tail=newline"; do
  if ! grep -qF -- "$needle" "$partition_boundary_stderr"; then
    echo "FAIL: aggregate failure diagnostic must contain: $needle"
    echo "  actual stderr:"
    sed -n '1,40p' "$partition_boundary_stderr"
    exit 1
  fi
  echo "  ok: aggregate diagnostic names $needle"
done

echo ""
echo "Test 16: a pseudo-TTY stdout enforces the same middle-unit boundary"
partition_boundary_tty_invocations="$tmpdir/partition-boundary-tty-invocations.txt"
: > "$partition_boundary_tty_invocations"
partition_boundary_tty_stdout="$tmpdir/partition-boundary-tty.stdout"
partition_boundary_tty_stderr="$tmpdir/partition-boundary-tty.stderr"
partition_boundary_tty_status=0
printf -v partition_boundary_tty_command \
  'stty -onlcr; cd %q; exec bash %q 2>%q' \
  "$partition" "$tmpdir/lint-check-oxlint.sh" "$partition_boundary_tty_stderr"
TEST_OXLINT_INVOCATIONS="$partition_boundary_tty_invocations" \
  TEST_OXLINT_FAIL_ON="packages/b/nested/four.ts" \
  TEST_OXLINT_EMIT_ON="scripts/tool.ts" \
  TEST_OXLINT_EMIT_TEXT="$partition_boundary_later" \
  script -qefc "$partition_boundary_tty_command" /dev/null \
  > "$partition_boundary_tty_stdout" || partition_boundary_tty_status=$?

if [ "$partition_boundary_tty_status" -eq 0 ]; then
  echo "FAIL: the pseudo-TTY middle unit failure must make the task nonzero"
  exit 1
fi
if ! cmp -s "$partition_boundary_expected" "$partition_boundary_tty_stdout"; then
  echo "FAIL: pseudo-TTY adjacent unit outputs must be two separate complete lines"
  echo "  expected bytes:"
  od -An -tu1 "$partition_boundary_expected"
  echo "  actual bytes:"
  od -An -tu1 "$partition_boundary_tty_stdout"
  exit 1
fi
partition_boundary_tty_unit_count="$(grep -cxF '=== unit' "$partition_boundary_tty_invocations")"
if [ "$partition_boundary_tty_unit_count" != 4 ]; then
  echo "FAIL: every pseudo-TTY unit must run after the middle failure (ran $partition_boundary_tty_unit_count of 4)"
  exit 1
fi
for needle in \
  "units=4" \
  "failed_units=1" \
  "first_failed_unit=packages/b/nested" \
  "stdout_bytes=$partition_boundary_tool_bytes" \
  "stdout_tail=newline"; do
  if ! grep -qF -- "$needle" "$partition_boundary_tty_stderr"; then
    echo "FAIL: pseudo-TTY aggregate failure diagnostic must contain: $needle"
    echo "  actual stderr:"
    sed -n '1,40p' "$partition_boundary_tty_stderr"
    exit 1
  fi
done
echo "  ok: pseudo-TTY output has exactly one LF boundary, all units, and aggregate diagnostics"

echo ""
echo "All lint-oxc file list tests passed"
