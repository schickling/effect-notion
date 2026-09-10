#!/usr/bin/env bash
#
# bootstrap:cold-proof (R32) — EMPIRICAL bootstrap-safety proof.
#
# Demonstrates (not merely asserts) that the bootstrap-phase generators run BEFORE install in a
# fresh, no-`node_modules` environment and produce a state `pnpm install` accepts. This is the
# authority for the bootstrap contract; `bootstrap-closure:check` (static) is fast local feedback.
#
# Mechanism:
#   1. Realize the packaged Genie CLI (`.#genie`) — a wrapper over the reviewed,
#      content-addressed Buck JavaScript product and its pinned Bun runtime, so
#      it needs no `node_modules` to run. (Override with
#      GENIE_COLD_PROOF_BIN=/path/to/genie to reuse an already-built product and
#      skip the Nix build.)
#   2. Materialize a `node_modules`-free tree of the COMMITTED repo source via `git archive HEAD`
#      into a temp dir OUTSIDE the repo (so bun/pnpm cannot walk up into the repo's node_modules).
#   3. Run `genie --phase bootstrap` COLD in that tree. Success proves every bootstrap generator's
#      transitive runtime closure is importable pre-install (a reach into `effect`/`@effect/*`/
#      `@overeng/otel-contract` would throw on import and fail this step). Non-vacuity: assert it
#      selected exactly the `// @genie-bootstrap`-marked set (independently counted from the tree).
#   4. Run `pnpm install --frozen-lockfile` in that tree. Success proves the cold-regenerated install
#      inputs match the committed lockfile exactly.
#
# Usage:
#   genie/ci-scripts/bootstrap-cold-proof.sh
#   GENIE_COLD_PROOF_BIN=./result/bin/genie genie/ci-scripts/bootstrap-cold-proof.sh
#
# Exit 0 iff BOTH the cold `genie --phase bootstrap` and the cold `pnpm install` succeed.

set -euo pipefail

log() { printf '[cold-proof] %s\n' "$*" >&2; }
fail() {
  printf '[cold-proof] FAIL: %s\n' "$*" >&2
  exit 1
}

repo="${DEVENV_ROOT:-$(git rev-parse --show-toplevel)}"
cd "$repo"

# --- 1. Self-contained packaged Genie CLI ----------------------------------------------------------
genie_bin="${GENIE_COLD_PROOF_BIN:-}"
if [ -z "$genie_bin" ]; then
  log "building the self-contained packaged Genie CLI (.#genie) ..."
  genie_out="$(nix build --no-link --print-out-paths "${repo}#genie")"
  genie_bin="${genie_out}/bin/genie"
fi
[ -x "$genie_bin" ] || fail "genie binary is not executable: ${genie_bin}"
log "using nix genie CLI: ${genie_bin}"

# --- 2. node_modules-free tree of the committed source (outside the repo) ---------------------------
work="$(mktemp -d "${TMPDIR:-/tmp}/genie-cold-proof.XXXXXX")"
trap 'rm -rf "$work"' EXIT
tree="${work}/repo"
mkdir -p "$tree"
log "materializing committed tree ($(git -C "$repo" rev-parse --short HEAD)) into ${tree} ..."
git -C "$repo" archive --format=tar HEAD | tar -x -C "$tree"

# The whole point is "cold": there must be no installed dependency graph anywhere on the path bun or
# pnpm would resolve against.
[ ! -e "${tree}/node_modules" ] || fail "fresh tree unexpectedly contains node_modules"
# Both sides resolved: $repo can come from DEVENV_ROOT unresolved while $tree
# comes from mktemp, and on a filesystem with a symlinked temp root a mismatched
# pair makes this guard silently stop matching instead of failing loudly.
case "$(cd "$tree" && pwd -P)" in
  "$(cd "$repo" && pwd -P)"/*) fail "temp tree is inside the repo (${tree}); bun/pnpm would resolve the repo node_modules" ;;
esac
ancestor="$tree"
while [ "$ancestor" != "/" ]; do
  ancestor="$(dirname "$ancestor")"
  [ ! -e "${ancestor}/node_modules" ] || fail "temp tree ancestor contains node_modules: ${ancestor}/node_modules"
done

# Independent ground truth: the bootstrap set is exactly the `// @genie-bootstrap`-marked sources.
# Keep this detector byte-for-byte aligned with parseGeneratorPhase in
# packages/@overeng/genie/src/core/phase.ts: only a real line-comment pragma counts.
expected="$(node - "$tree" <<'NODE'
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
      continue
    }
    if (entry.isFile() && entry.name.endsWith('.genie.ts')) {
      const sourceText = fs.readFileSync(entryPath, 'utf8')
      if (bootstrapPragmaRe.test(sourceText)) count += 1
    }
  }
}
visit(root)
console.log(count)
NODE
)"
[ "$expected" -ge 1 ] || fail "no @genie-bootstrap generators found in the tree (marker rename broken?)"
log "expected bootstrap-phase generators: ${expected}"

# --- 3. Cold `genie --phase bootstrap` -------------------------------------------------------------
genie_json="${work}/genie-bootstrap.json"
log "running nix genie --phase bootstrap COLD (no node_modules) ..."
if ! "$genie_bin" --phase bootstrap --output json --cwd "$tree" >"$genie_json" 2>"${work}/genie.stderr"; then
  log "cold genie run stderr:"
  cat "${work}/genie.stderr" >&2 || true
  fail "cold 'genie --phase bootstrap' exited non-zero (a bootstrap generator likely reached a runtime-only package)"
fi

# Non-vacuity + no-error assertion over the JSON summary. A binary that did not understand
# @genie-bootstrap would select zero generators and still exit 0 — this catches that.
node - "$genie_json" "$expected" <<'NODE'
const fs = require('node:fs')
const [jsonPath, expectedRaw] = process.argv.slice(2)
const expected = Number(expectedRaw)
const text = fs.readFileSync(jsonPath, 'utf8').trim()
if (text === '') {
  console.error('[cold-proof] FAIL: cold genie produced no JSON output')
  process.exit(1)
}
const events = text
  .split(/\n/)
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line))
const withFiles = events.filter((event) => Array.isArray(event.files))
if (withFiles.length === 0) {
  console.error('[cold-proof] FAIL: cold genie JSON had no file list')
  process.exit(1)
}
const files = withFiles.flatMap((event) => event.files)
const errored = files.filter((file) => file.status === 'error')
if (errored.length > 0) {
  console.error(`[cold-proof] FAIL: ${errored.length} generator(s) errored cold:`)
  for (const file of errored) console.error(`  - ${file.relativePath}: ${file.message ?? 'error'}`)
  process.exit(1)
}
if (files.length !== expected) {
  console.error(
    `[cold-proof] FAIL: cold genie ran ${files.length} generators, expected ${expected} (@genie-bootstrap set). ` +
      'A mismatch means the built binary and the source markers disagree.',
  )
  process.exit(1)
}
console.error(`[cold-proof] cold genie --phase bootstrap OK — ${files.length} generators ran, none errored`)
NODE

# --- 4. Cold `pnpm install --frozen-lockfile` ------------------------------------------------------
# Mirror the repo's canonical install (see nix/devenv-modules/tasks/lib/effect-utils-install.nix):
# frozen (asserts the cold-regenerated inputs match the committed lockfile), scripts ignored, and
# resolving against the shared/warm pnpm store so the proof is offline-ish and CI-cache-friendly.
store_dir="${PNPM_STORE_DIR:-${PNPM_CONFIG_STORE_DIR:-${repo}/.devenv/pnpm-store-pure-v1}}"
command -v pnpm >/dev/null 2>&1 || fail "pnpm not on PATH (run inside the devenv shell / task)"
log "running pnpm install --frozen-lockfile COLD (store: ${store_dir}) ..."
if ! DEVENV_TASK_PASSTHROUGH=1 pnpm install \
  --force \
  --frozen-lockfile \
  --ignore-scripts \
  --config.store-dir="$store_dir" \
  --dir "$tree" >"${work}/pnpm.log" 2>&1; then
  log "cold pnpm install log (tail):"
  tail -40 "${work}/pnpm.log" >&2 || true
  fail "cold 'pnpm install --frozen-lockfile' failed against the cold-regenerated inputs"
fi
[ -d "${tree}/node_modules" ] || fail "pnpm install reported success but produced no node_modules"

log "PASS — cold 'genie --phase bootstrap' (${expected} generators) + cold 'pnpm install' both succeeded"
