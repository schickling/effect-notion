#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"

echo "Running Genie compiled import staging cleanup test..."
echo ""

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

workspace="$tmpdir/workspace"
tmp_root="$tmpdir/os-tmp"
# The subject is the *bundled* Genie entrypoint, so the packaged CLI is used instead of rebuilding
# it from source (a source build needs the workspace `node_modules`, which the declared tool set
# deliberately does not carry). The bundle is driven through the declared Bun rather than the
# package's `bin/genie` launcher: that launcher pins `GENIE_EXPORT_TYPE_PROOF_COMPILER` with
# `--set`, and Test 3 exists precisely to prove Genie honours an explicitly supplied compiler.
compiled_genie=("${BUN_BIN:?}" "$(dirname "$(dirname "${GENIE_BIN:?}")")/libexec/genie.js")

mkdir -p "$workspace/lib" "$tmp_root"

cat > "$workspace/lib/payload.ts" <<'EOF'
export const payload = { hello: 'compiled' }
EOF

cat > "$workspace/demo.json.genie.ts" <<'EOF'
import { payload } from './lib/payload.ts'

export default {
  data: payload,
  stringify: () => JSON.stringify(payload, null, 2),
}
EOF

echo "Test 1: compiled Genie generates output and exits"

for _ in 1 2 3; do
  rm -f "$workspace/demo.json"
  env -u OTEL_EXPORTER_OTLP_ENDPOINT \
    TMPDIR="$tmp_root" \
    timeout 20s "${compiled_genie[@]}" --cwd "$workspace" --output json >/dev/null
done

grep -q '"hello": "compiled"' "$workspace/demo.json"

echo "Test 2: compiled import staging dirs are removed after each run"
leaked_count="$(find "$tmp_root" -maxdepth 1 -mindepth 1 -type d -name 'genie-import-*' | wc -l | tr -d ' ')"
if [ "$leaked_count" != "0" ]; then
  find "$tmp_root" -maxdepth 1 -mindepth 1 -type d -name 'genie-import-*' -print >&2
  echo "Expected 0 leaked genie-import-* dirs, found $leaked_count" >&2
  exit 1
fi

echo "Test 3: compiled Genie strict export proof uses explicit compiler executable"
strict_workspace="$tmpdir/strict-workspace"
fake_compiler="$tmpdir/fake-tsgo"
compiler_log="$tmpdir/fake-tsgo.log"

mkdir -p "$strict_workspace/src"

cat > "$strict_workspace/src/mod.ts" <<'EOF'
export const value = 1
EOF

cat > "$strict_workspace/package.json.genie.ts" <<EOF
import { exportEntry, packageJson } from '$ROOT/packages/@overeng/genie/src/runtime/mod.ts'

export default packageJson({
  name: '@test/compiled-strict-proof',
  version: '1.0.0',
  exports: {
    '.': exportEntry('./src/mod.ts', {
      environment: 'isomorphic-es2024',
      typeProof: 'strict',
    }),
  },
})
EOF

cat > "$fake_compiler" <<EOF
#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then
  echo "Fake TypeScript 1.0.0"
  exit 0
fi
printf "%s\n" "\$@" > "$compiler_log"
EOF
chmod +x "$fake_compiler"

env -u OTEL_EXPORTER_OTLP_ENDPOINT \
  GENIE_EXPORT_TYPE_PROOF_COMPILER="$fake_compiler" \
  TMPDIR="$tmp_root" \
  timeout 20s "${compiled_genie[@]}" --cwd "$strict_workspace" --output json >/dev/null

grep -q -- '--project' "$compiler_log"

echo "Test 4: bootstrap cold-proof passes the pinned projected compiler, never an ambient one"
# The proof must never let the strict export type check fall back to a PATH `tsgo`: the
# compiler is resolved from the member's own `.buck2/capabilities` projection and exported
# as GENIE_EXPORT_TYPE_PROOF_COMPILER, or the proof fails closed. The stub Buck2 fails the
# first build, so every case below stops immediately after compiler resolution and the
# resolved (or refused) compiler is the only subject.
cold_proof="$ROOT/genie/ci-scripts/bootstrap-cold-proof.sh"
cold_root="$tmpdir/cold-member"
cold_workspace="$tmpdir/cold-workspace"
cold_stderr="$tmpdir/cold-proof.err"
stub_buck2="$tmpdir/stub-buck2"
cold_generation="$(printf '%064d' 0)"

mkdir -p "$cold_root" "$cold_workspace"
: > "$cold_workspace/.buckroot"
printf '#!/usr/bin/env bash\nexit 1\n' > "$stub_buck2"
chmod +x "$stub_buck2"

project_cold_compiler() {
  rm -rf "$cold_root/.buck2"
  mkdir -p "$cold_root/.buck2/capabilities/generations/$cold_generation/x86_64-linux/effect-tsgo"
  printf 'GENERATION = "%s"\n' "$cold_generation" > "$cold_root/.buck2/capabilities/defs.bzl"
  ln -s "$1" \
    "$cold_root/.buck2/capabilities/generations/$cold_generation/x86_64-linux/effect-tsgo/executable"
}

refuse_cold_proof() {
  if DEVENV_ROOT="$cold_root" EFFECT_UTILS_WORKSPACE_ROOT="$cold_workspace" \
    BUCK2="$stub_buck2" BUN="${BUN_BIN:?}" \
    "${BASH_BIN:?}" "$cold_proof" >/dev/null 2>"$cold_stderr"; then
    echo "FAIL: cold proof succeeded where it must refuse ($1)" >&2
    exit 1
  fi
  if ! grep -q -- "$2" "$cold_stderr"; then
    echo "FAIL: cold proof did not report '$2' ($1)" >&2
    cat "$cold_stderr" >&2
    exit 1
  fi
  if grep -q 'pinned type-proof compiler' "$cold_stderr"; then
    echo "FAIL: cold proof exported a compiler it should have refused ($1)" >&2
    cat "$cold_stderr" >&2
    exit 1
  fi
}

# Absent: no capability projection at all, so there is nothing pinned to export.
refuse_cold_proof "absent projection" 'capability projection is absent'

# Ambient: an executable that is not an immutable Nix realization.
printf '#!/usr/bin/env bash\nexit 0\n' > "$tmpdir/ambient-tsgo"
chmod +x "$tmpdir/ambient-tsgo"
project_cold_compiler "$tmpdir/ambient-tsgo"
refuse_cold_proof "ambient compiler" 'is not an immutable Nix executable'

# Not executable: store-shaped, but no executable behind the projected path.
project_cold_compiler '/nix/store/0000000000000000000000000000000z-effect-tsgo/bin/tsgo'
refuse_cold_proof "unrealized compiler" 'is not executable'

# Pinned: an immutable store executable is exported verbatim, and the proof only then
# proceeds to Buck (which the stub fails). `BUN_BIN` stands in as an attested capability
# realization; the shape under proof is the projection-to-env seam, not tsgo itself.
project_cold_compiler "${BUN_BIN:?}"
if DEVENV_ROOT="$cold_root" EFFECT_UTILS_WORKSPACE_ROOT="$cold_workspace" \
  BUCK2="$stub_buck2" BUN="${BUN_BIN:?}" \
  "${BASH_BIN:?}" "$cold_proof" >/dev/null 2>"$cold_stderr"; then
  echo "FAIL: cold proof ignored the failing stub Buck2 build" >&2
  exit 1
fi
grep -q -- "pinned type-proof compiler: ${BUN_BIN}" "$cold_stderr" || {
  echo "FAIL: cold proof did not export the pinned projected compiler" >&2
  cat "$cold_stderr" >&2
  exit 1
}
grep -q 'Buck failed to build' "$cold_stderr" || {
  echo "FAIL: cold proof did not reach the Buck product build after resolving the compiler" >&2
  cat "$cold_stderr" >&2
  exit 1
}

echo ""
echo "Genie compiled import staging cleanup tests passed."
