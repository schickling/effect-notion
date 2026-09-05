#!/usr/bin/env bash
#
# bootstrap:cold-proof (R32) — install-free Buck product and projection proof.
#
# The proof deliberately runs outside every source-workspace node_modules tree:
#   1. Buck builds the declared Genie candidate product.
#   2. A committed-source archive is materialized under a fresh temporary root.
#   3. The Buck-built product runs the bootstrap phase in that cold tree.
#   4. The same product checks every committed projection, including the pnpm-lock
#      metadata and sha256 sidecars, without installing the workspace.
#
# BUCK2 names the composed workspace launcher. BUN names an explicit Bun
# product used only for the proof's small JSON/non-vacuity assertions.

set -euo pipefail

log() { printf '[cold-proof] %s\n' "$*" >&2; }
fail() {
  printf '[cold-proof] FAIL: %s\n' "$*" >&2
  exit 1
}

repo="${DEVENV_ROOT:-${EFFECT_UTILS_MEMBER_ROOT:-$(git rev-parse --show-toplevel)}}"
repo="$(cd "$repo" && pwd -P)"
cd "$repo"

workspace="${EFFECT_UTILS_WORKSPACE_ROOT:-}"
if [ -z "$workspace" ]; then
  candidate="$repo"
  while [ "$candidate" != "/" ]; do
    if [ -f "$candidate/.buckroot" ]; then
      workspace="$candidate"
      break
    fi
    candidate="$(dirname "$candidate")"
  done
fi
[ -n "$workspace" ] || fail "cannot locate the composed Buck workspace containing $repo"
workspace="$(cd "$workspace" && pwd -P)"

buck2_bin="${BUCK2:-$workspace/.megarepo/bin/buck2}"
[ -x "$buck2_bin" ] || fail "Buck2 is unavailable; provide BUCK2 or prepare the composed workspace"

bun_bin="${BUN:?BUN must name the explicit Bun product used to execute the candidate}"
[ -x "$bun_bin" ] || fail "BUN is not executable: $bun_bin"

work="$(mktemp -d "${TMPDIR:-/tmp}/genie-cold-proof.XXXXXX")"
trap 'rm -rf "$work"' EXIT
tree="$work/repo"
mkdir -p "$tree"

# Build the declared product up front. Execution uses its RunInfo alias, whose
# runtime is the pinned Buck Bun toolchain rather than a source-shell binary.
product_target='effect_utils//packages/@overeng/genie:genie-candidate'
launch_target='effect_utils//packages/@overeng/genie:genie-candidate-launch'
log "building Buck Genie candidate product ($product_target) ..."
if ! (cd "$workspace" && "$buck2_bin" build "$product_target"); then
  fail "Buck failed to build the Genie candidate product"
fi

log "materializing committed tree ($(git -C "$repo" rev-parse --short HEAD)) into $tree ..."
git -C "$repo" archive --format=tar HEAD | tar -x -C "$tree"

[ ! -e "$tree/node_modules" ] || fail "fresh tree unexpectedly contains node_modules"
case "$(cd "$tree" && pwd -P)" in
  "$repo"/*) fail "temp tree is inside the repo; runtime resolution would not be cold" ;;
esac
ancestor="$tree"
while [ "$ancestor" != "/" ]; do
  ancestor="$(dirname "$ancestor")"
  [ ! -e "$ancestor/node_modules" ] || fail "temp tree ancestor contains node_modules: $ancestor/node_modules"
done

expected="$("$bun_bin" - "$tree" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const [root] = process.argv.slice(2)
const bootstrapPragmaRe = /^[ \t]*\/\/[ \t]*@genie-bootstrap(?![\w-])/m
let count = 0
const visit = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '.git') visit(entryPath)
    } else if (entry.isFile() && entry.name.endsWith('.genie.ts')) {
      if (bootstrapPragmaRe.test(fs.readFileSync(entryPath, 'utf8'))) count += 1
    }
  }
}
visit(root)
console.log(count)
NODE
)"
[ "$expected" -ge 1 ] || fail "no @genie-bootstrap generators found in the tree"

bootstrap_json="$work/genie-bootstrap.json"
log "running Buck product --phase bootstrap cold ($expected generators expected) ..."
if ! (cd "$workspace" && "$buck2_bin" run "$launch_target" -- \
  --phase bootstrap --output json --cwd "$tree") >"$bootstrap_json" 2>"$work/genie-bootstrap.stderr"; then
  cat "$work/genie-bootstrap.stderr" >&2 || true
  fail "Buck Genie product failed the cold bootstrap phase"
fi

"$bun_bin" - "$bootstrap_json" "$expected" <<'NODE'
const fs = require('node:fs')
const [jsonPath, expectedRaw] = process.argv.slice(2)
const expected = Number(expectedRaw)
const events = fs.readFileSync(jsonPath, 'utf8').trim().split(/\n/).filter(Boolean).map(JSON.parse)
const files = events.filter((event) => Array.isArray(event.files)).flatMap((event) => event.files)
const errored = files.filter((file) => file.status === 'error')
if (errored.length > 0 || files.length !== expected) {
  console.error(`[cold-proof] FAIL: bootstrap product ran ${files.length}/${expected} generators with ${errored.length} errors`)
  for (const file of errored) console.error(`  - ${file.relativePath}: ${file.message ?? 'error'}`)
  process.exit(1)
}
NODE

# The full check includes buck2/dependencies/pnpm-lock.json and
# pnpm-lock.sha256.json. It reads the committed lockfile and generated outputs
# only: no pnpm invocation, registry access, or dependency installation.
log "checking install-free generated projections from the Buck product ..."
if ! (cd "$workspace" && "$buck2_bin" run "$launch_target" -- \
  --check --output json --cwd "$tree") >"$work/genie-check.json" 2>"$work/genie-check.stderr"; then
  cat "$work/genie-check.stderr" >&2 || true
  fail "Buck Genie product found stale generated projections"
fi
[ ! -e "$tree/node_modules" ] || fail "install-free projection check created node_modules"

log "PASS — Buck Genie product ran cold bootstrap and verified install-free lock projections"
