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

echo ""
echo "Genie compiled import staging cleanup tests passed."
