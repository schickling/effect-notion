#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../../../.." && pwd)"

PNPM_OUT="$({
  nix build --no-link --print-out-paths --impure --expr "
    let
      flake = builtins.getFlake \"$NIX_FLAKE_REF\";
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
    in flake.lib.mkPnpm { inherit pkgs; }
  "
})"
PNPM="$PNPM_OUT/bin/pnpm"
EXPECTED_PNPM_VERSION="$(node -e 'const packageManager=require(process.argv[1]).packageManager; process.stdout.write(packageManager.slice(packageManager.lastIndexOf("@") + 1))' "$ROOT/package.json")"
ACTUAL_PNPM_VERSION="$($PNPM --version)"
if [ "$ACTUAL_PNPM_VERSION" != "$EXPECTED_PNPM_VERSION" ]; then
  echo "FAIL: shared-store proof pnpm version $ACTUAL_PNPM_VERSION != workspace authority $EXPECTED_PNPM_VERSION" >&2
  exit 1
fi

assert_contains() {
  local file="$1"
  local pattern="$2"
  local label="$3"

  if ! grep -Eq "$pattern" "$file"; then
    echo "FAIL: $label" >&2
    sed -n '1,160p' "$file" >&2
    exit 1
  fi
}

run_pnpm_logged() {
  local workspace_root="$1"
  local log_file="$2"
  shift 2

  local rc
  set +e
  if [ "$(uname -s)" = Darwin ]; then
    NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=1536" "$@" > "$log_file" 2>&1
  else
    "$@" > "$log_file" 2>&1
  fi
  rc="$?"
  set -e

  if [ "$rc" -eq 0 ]; then
    return
  fi

  # Mirror the production install policy: pnpm/Node can abort during Darwin
  # teardown after completing materialization. Normalize only the exact abort
  # with both pnpm completion evidence and a complete root-local projection.
  if [ "$rc" -eq 134 ] && [ "$(uname -s)" = Darwin ] &&
    grep -qE 'Progress: .* done$' "$log_file" &&
    [ -d "$workspace_root/node_modules/.pnpm" ] &&
    [ -f "$workspace_root/node_modules/.modules.yaml" ]; then
    return
  fi

  cat "$log_file" >&2
  return "$rc"
}

inode_id() {
  node -e 'const fs=require("node:fs"); const s=fs.statSync(process.argv[1]); process.stdout.write(`${s.dev}:${s.ino}`)' "$1"
}

real_path() {
  node -e 'const fs=require("node:fs"); process.stdout.write(fs.realpathSync(process.argv[1]))' "$1"
}

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

mkdir -p \
  "$tmpdir/immutable-package/package" \
  "$tmpdir/native-package/package" \
  "$tmpdir/root-a" \
  "$tmpdir/root-b" \
  "$tmpdir/shared-store"

# Ordinary immutable package data may be cloned, copied, or hardlinked from the
# shared store. The selected mechanism is evidence, not package identity.
cat > "$tmpdir/immutable-package/package/package.json" <<'EOF'
{
  "name": "hardlink-proof",
  "version": "1.0.0",
  "files": ["index.js"]
}
EOF
printf 'module.exports = "immutable"\n' > "$tmpdir/immutable-package/package/index.js"
tar -czf "$tmpdir/hardlink-proof-1.0.0.tgz" -C "$tmpdir/immutable-package" package

# A native/source-build package would mutate its package directory if its
# lifecycle ran. The managed ignore-scripts policy must retain that hook as
# pending without running it; pnpm's selected import mechanism remains evidence,
# not a distinct-inode contract.
cat > "$tmpdir/native-package/package/package.json" <<'EOF'
{
  "name": "native-mutator",
  "version": "1.0.0",
  "files": ["index.js", "install.cjs"],
  "scripts": {"install": "node install.cjs"}
}
EOF
printf 'module.exports = "native-original"\n' > "$tmpdir/native-package/package/index.js"
cat > "$tmpdir/native-package/package/install.cjs" <<'EOF'
const fs = require("node:fs")
const path = require("node:path")
fs.writeFileSync(path.join(__dirname, "index.js"), "module.exports = \"mutated\"\n")
fs.writeFileSync(path.join(__dirname, "install-ran"), "unsafe\n")
EOF
tar -czf "$tmpdir/native-mutator-1.0.0.tgz" -C "$tmpdir/native-package" package

for root_name in root-a root-b; do
  cat > "$tmpdir/$root_name/package.json" <<EOF
{
  "name": "$root_name",
  "private": true,
  "dependencies": {
    "hardlink-proof": "file:../hardlink-proof-1.0.0.tgz",
    "native-mutator": "file:../native-mutator-1.0.0.tgz"
  }
}
EOF
done

install_flags=(
  --store-dir "$tmpdir/shared-store"
  --config.enable-global-virtual-store=false
  --config.virtual-store-dir=node_modules/.pnpm
  --config.package-import-method=auto
  --ignore-scripts
  --reporter=append-only
)

run_pnpm_logged "$tmpdir/root-a" "$tmpdir/root-a.log" "$PNPM" --dir "$tmpdir/root-a" install "${install_flags[@]}"
cp "$tmpdir/root-a/pnpm-lock.yaml" "$tmpdir/root-b/pnpm-lock.yaml"
run_pnpm_logged "$tmpdir/root-b" "$tmpdir/root-b.log" "$PNPM" --dir "$tmpdir/root-b" install --frozen-lockfile "${install_flags[@]}"

assert_contains \
  "$tmpdir/root-b.log" \
  'Progress: resolved [0-9]+, reused [1-9][0-9]*, downloaded 0, added [1-9][0-9]*, done' \
  "second root must reuse shared-store package data with zero downloads"
if grep -Eq 'downloaded [1-9][0-9]*' "$tmpdir/root-b.log"; then
  echo "FAIL: second root downloaded package data" >&2
  cat "$tmpdir/root-b.log" >&2
  exit 1
fi

test -f "$tmpdir/shared-store/v11/index.db"
test "$(real_path "$tmpdir/root-a/node_modules/.pnpm")" = "$(real_path "$tmpdir/root-a")/node_modules/.pnpm"
test "$(real_path "$tmpdir/root-b/node_modules/.pnpm")" = "$(real_path "$tmpdir/root-b")/node_modules/.pnpm"
test "$(real_path "$tmpdir/root-a/node_modules/.pnpm")" != "$(real_path "$tmpdir/root-b/node_modules/.pnpm")"

root_a_file="$tmpdir/root-a/node_modules/hardlink-proof/index.js"
root_b_file="$tmpdir/root-b/node_modules/hardlink-proof/index.js"
ordinary_inode_shared=false
if [ "$(inode_id "$root_a_file")" = "$(inode_id "$root_b_file")" ]; then
  ordinary_inode_shared=true
fi
if [ "$(uname -s)" = Linux ] && [ "$ordinary_inode_shared" != true ]; then
  reflink_probe="$tmpdir/reflink-probe"
  if ! cp --reflink=always "$root_a_file" "$reflink_probe" 2>/dev/null; then
    echo "FAIL: Linux auto import neither shared an inode nor ran on a reflink-capable filesystem" >&2
    exit 1
  fi
fi
test "$(cat "$root_a_file")" = 'module.exports = "immutable"'

native_a_file="$tmpdir/root-a/node_modules/native-mutator/index.js"
native_b_file="$tmpdir/root-b/node_modules/native-mutator/index.js"
test "$(cat "$native_a_file")" = 'module.exports = "native-original"'
test "$(cat "$native_b_file")" = 'module.exports = "native-original"'
test ! -e "$tmpdir/root-a/node_modules/native-mutator/install-ran"
test ! -e "$tmpdir/root-b/node_modules/native-mutator/install-ran"

node - "$tmpdir/root-a/node_modules/.modules.yaml" <<'EOF'
const fs = require("node:fs")
const modules = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))
if (!modules.pendingBuilds.some((entry) => entry.startsWith("native-mutator@"))) {
  throw new Error("native/source-build mutation was not retained as an explicit pending build")
}
if (modules.virtualStoreDir !== ".pnpm") {
  throw new Error(`expected root-local virtual store, got ${modules.virtualStoreDir}`)
}
EOF

rm -rf "$tmpdir/root-b/node_modules"
run_pnpm_logged "$tmpdir/root-b" "$tmpdir/root-b-offline.log" "$PNPM" --dir "$tmpdir/root-b" install --offline --force --frozen-lockfile "${install_flags[@]}"
assert_contains \
  "$tmpdir/root-b-offline.log" \
  'Progress: resolved [0-9]+, reused [1-9][0-9]*, downloaded 0, added [1-9][0-9]*, done' \
  "offline rematerialization must reuse the shared full store"

# A full shared store has one writable package index. Prove pnpm itself can own
# that concurrency boundary: start two roots against a second empty store, then
# require both independently selected graphs to survive offline rematerialization.
mkdir -p "$tmpdir/concurrent-a" "$tmpdir/concurrent-b" "$tmpdir/concurrent-store"
for root_name in concurrent-a concurrent-b; do
  cat > "$tmpdir/$root_name/package.json" <<EOF
{
  "name": "$root_name",
  "private": true,
  "dependencies": {
    "hardlink-proof": "file:../hardlink-proof-1.0.0.tgz",
    "native-mutator": "file:../native-mutator-1.0.0.tgz"
  }
}
EOF
  cp "$tmpdir/root-a/pnpm-lock.yaml" "$tmpdir/$root_name/pnpm-lock.yaml"
done

concurrent_flags=(
  --store-dir "$tmpdir/concurrent-store"
  --config.enable-global-virtual-store=false
  --config.virtual-store-dir=node_modules/.pnpm
  --config.package-import-method=auto
  --ignore-scripts
  --frozen-lockfile
  --reporter=append-only
)

run_pnpm_logged "$tmpdir/concurrent-a" "$tmpdir/concurrent-a.log" "$PNPM" --dir "$tmpdir/concurrent-a" install "${concurrent_flags[@]}" &
concurrent_a_pid=$!
run_pnpm_logged "$tmpdir/concurrent-b" "$tmpdir/concurrent-b.log" "$PNPM" --dir "$tmpdir/concurrent-b" install "${concurrent_flags[@]}" &
concurrent_b_pid=$!
if ! wait "$concurrent_a_pid"; then
  echo "FAIL: concurrent root A cold install" >&2
  cat "$tmpdir/concurrent-a.log" >&2
  exit 1
fi
if ! wait "$concurrent_b_pid"; then
  echo "FAIL: concurrent root B cold install" >&2
  cat "$tmpdir/concurrent-b.log" >&2
  exit 1
fi

test -f "$tmpdir/concurrent-store/v11/index.db"
test "$(real_path "$tmpdir/concurrent-a/node_modules/.pnpm")" != "$(real_path "$tmpdir/concurrent-b/node_modules/.pnpm")"
for root_name in concurrent-a concurrent-b; do
  test "$(cat "$tmpdir/$root_name/node_modules/hardlink-proof/index.js")" = 'module.exports = "immutable"'
  test "$(cat "$tmpdir/$root_name/node_modules/native-mutator/index.js")" = 'module.exports = "native-original"'
  test ! -e "$tmpdir/$root_name/node_modules/native-mutator/install-ran"
  node -e 'if (require(process.argv[1]) !== "immutable") process.exit(1)' \
    "$tmpdir/$root_name/node_modules/hardlink-proof"
done

rm -rf "$tmpdir/concurrent-a/node_modules" "$tmpdir/concurrent-b/node_modules"
run_pnpm_logged "$tmpdir/concurrent-a" "$tmpdir/concurrent-a-offline.log" "$PNPM" --dir "$tmpdir/concurrent-a" install --offline --force "${concurrent_flags[@]}" &
concurrent_a_pid=$!
run_pnpm_logged "$tmpdir/concurrent-b" "$tmpdir/concurrent-b-offline.log" "$PNPM" --dir "$tmpdir/concurrent-b" install --offline --force "${concurrent_flags[@]}" &
concurrent_b_pid=$!
if ! wait "$concurrent_a_pid"; then
  echo "FAIL: concurrent root A offline rematerialization" >&2
  cat "$tmpdir/concurrent-a-offline.log" >&2
  exit 1
fi
if ! wait "$concurrent_b_pid"; then
  echo "FAIL: concurrent root B offline rematerialization" >&2
  cat "$tmpdir/concurrent-b-offline.log" >&2
  exit 1
fi
for root_name in concurrent-a concurrent-b; do
  test "$(cat "$tmpdir/$root_name/node_modules/hardlink-proof/index.js")" = 'module.exports = "immutable"'
  test "$(cat "$tmpdir/$root_name/node_modules/native-mutator/index.js")" = 'module.exports = "native-original"'
  test ! -e "$tmpdir/$root_name/node_modules/native-mutator/install-ran"
done

# Direct package-file mutation is outside the managed materialization contract,
# but an inode alias would make its blast radius cross-root. Measure that risk
# explicitly without making hardlinking itself a required outcome.
chmod u+w "$root_a_file"
printf 'module.exports = "mutation-probe"\n' > "$root_a_file"
mutation_aliased=false
if grep -q 'mutation-probe' "$root_b_file"; then
  mutation_aliased=true
fi
if [ "$ordinary_inode_shared" != "$mutation_aliased" ]; then
  echo "FAIL: inode-sharing and mutation-alias evidence disagree" >&2
  exit 1
fi
test "$(cat "$native_b_file")" = 'module.exports = "native-original"'

printf '{"phase":"shared-store-reuse","status":"ok","secondRootDownloads":0,"ordinaryInodeShared":%s,"mutationAliased":%s,"virtualStoresDistinct":true,"concurrentColdRoots":2,"concurrentOfflineRoots":2,"sharedIndexHealthy":true,"lifecycleHooksRan":0}\n' \
  "$ordinary_inode_shared" \
  "$mutation_aliased"
