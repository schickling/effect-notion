#!/usr/bin/env bash

compute_hash() {
  sha256sum | awk '{print $1}'
}

ensure_local_pnpm_home_default() {
  local workspace_root="$1"

  if [ -z "${PNPM_HOME:-}" ]; then
    export PNPM_HOME="${workspace_root}/.pnpm-home"
  fi
}

configure_pnpm_storage() {
  local node_bin="$1"
  local materialization_root="$2"
  local job_local_store="$3"
  local host_is_linux="$4"
  local store_dir
  local package_import_method="auto"

  if [ -n "${CI:-}" ]; then
    store_dir="$job_local_store"
  else
    if [ -n "${PNPM_SHARED_STORE_DIR:-}" ]; then
      store_dir="$PNPM_SHARED_STORE_DIR"
    else
      store_dir="$HOME/.local/share/pnpm/store-shared-v1"
    fi

    local store_version_dir="$store_dir/v11"
    local files_path="$store_version_dir/files"

    if [ -L "$store_version_dir" ]; then
      echo "[pnpm] Refusing external pnpm Store Cache version bridge at $store_version_dir; discard and recreate the disposable $store_dir cache" >&2
      return 1
    fi

    if [ -L "$files_path" ]; then
      echo "[pnpm] Refusing external pnpm Store Cache bridge at $files_path; discard and recreate the disposable $store_dir cache" >&2
      return 1
    fi

    mkdir -p "$files_path"

    if ! "$node_bin" - "$store_dir" "$files_path" <<'EOF'
const fs = require('node:fs')
const path = require('node:path')

const [storeDir, filesPath] = process.argv.slice(2)
const realStoreDir = fs.realpathSync(storeDir)
const realFilesPath = fs.realpathSync(filesPath)
const relative = path.relative(realStoreDir, realFilesPath)

if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
  console.error(
    `[pnpm] Refusing pnpm Store Cache files outside selected store: store=${realStoreDir} files=${realFilesPath}`,
  )
  process.exit(1)
}
EOF
    then
      return 1
    fi

    if [ "$host_is_linux" = true ]; then
      "$node_bin" - "$materialization_root" "$files_path" <<'EOF'
const fs = require('node:fs')

const [materializationRoot, filesPath] = process.argv.slice(2)
const rootDevice = fs.statSync(materializationRoot).dev
const filesDevice = fs.statSync(filesPath).dev

if (rootDevice !== filesDevice) {
  console.error(
    `[pnpm] Zero-copy pnpm storage requires one filesystem: root=${materializationRoot} store-files=${filesPath}`,
  )
  process.exit(1)
}
EOF
    fi

  fi

  export PNPM_STORE_DIR="$store_dir"
  export PNPM_CONFIG_STORE_DIR="$store_dir"
  export npm_config_store_dir="$store_dir"
  export PNPM_PACKAGE_IMPORT_METHOD="$package_import_method"
}

acquire_pnpm_store_cache_lease() {
  local flock_bin="$1"
  local mode="$2"
  local store_dir="$3"
  local timeout_seconds="${4:-600}"
  local lockfile="$store_dir/.effect-utils-pnpm-store-cache-maintenance.lock"
  local flock_mode

  case "$mode" in
    shared) flock_mode="--shared" ;;
    exclusive) flock_mode="--exclusive" ;;
    *)
      echo "[pnpm] Invalid Store Cache lease mode: $mode" >&2
      return 2
      ;;
  esac

  mkdir -p "$store_dir"
  exec 202>"$lockfile"
  if ! "$flock_bin" "$flock_mode" -w "$timeout_seconds" 202; then
    echo "[pnpm] Store Cache $mode lease timeout after ${timeout_seconds}s: $lockfile" >&2
    return 1
  fi
}

migrate_legacy_pnpm_store_cache() {
  local store_dir="$1"
  local expected_legacy_files="$2"
  local store_version_dir="$store_dir/v11"
  local files_path="$store_version_dir/files"

  if [ -L "$store_version_dir" ]; then
    echo "[pnpm] Refusing to migrate a linked Store Cache version directory: $store_version_dir" >&2
    return 1
  fi
  if [ ! -L "$files_path" ]; then
    if [ -d "$files_path" ]; then
      echo "[pnpm] Store Cache is already self-contained: $store_dir"
      return 0
    fi
    echo "[pnpm] No recognized legacy Store Cache bridge exists at $files_path" >&2
    return 1
  fi

  local actual_legacy_files
  local expected_legacy_real
  actual_legacy_files="$(readlink -f "$files_path")"
  expected_legacy_real="$(readlink -f "$expected_legacy_files")"
  if [ "$actual_legacy_files" != "$expected_legacy_real" ]; then
    echo "[pnpm] Refusing unknown legacy Store Cache bridge: expected=$expected_legacy_real actual=$actual_legacy_files" >&2
    return 1
  fi

  # The caller holds the exclusive Store Cache lease. Reset only pnpm's
  # disposable versioned metadata in place: the store root and maintenance-lock
  # inode stay stable, and the historical external content pool is untouched.
  find "$store_version_dir" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
  mkdir -p "$files_path"
  echo "[pnpm] Migrated legacy Store Cache bridge to a self-contained cache: $store_dir"
}

assert_pnpm_storage_capacity() {
  local node_bin="$1"
  local store_dir="$2"
  local materialization_root="$3"

  if [ -n "${CI:-}" ]; then
    return 0
  fi

  local min_free_kib="${PNPM_MIN_FREE_KIB:-2097152}"
  local boundary
  local available_kib

  # pnpm `auto` may place cache files and a Materialization Root on distinct
  # devices (notably Darwin clone/copy fallbacks). Check both physical write
  # boundaries, but check a shared device only once.
  while IFS= read -r boundary; do
    available_kib="$(df -Pk "$boundary" | awk 'NR == 2 { print $4 }')"
    if [ -z "$available_kib" ] || [ "$available_kib" -lt "$min_free_kib" ]; then
      echo "[pnpm] Refusing materialization at $boundary with ${available_kib:-unknown} KiB free; require at least $min_free_kib KiB" >&2
      return 1
    fi
  done < <("$node_bin" - "$store_dir" "$materialization_root" <<'EOF'
const fs = require('node:fs')

const paths = process.argv.slice(2)
const seenDevices = new Set()
for (const path of paths) {
  const device = fs.statSync(path).dev.toString()
  if (!seenDevices.has(device)) {
    seenDevices.add(device)
    process.stdout.write(`${path}\n`)
  }
}
EOF
  )
}

emit_dir_state() {
  local dir="$1"

  if [ ! -d "$dir" ]; then
    return
  fi

  find "$dir" \
    \( \
      -name .git -o \
      -name .devenv -o \
      -name .turbo -o \
      -name .cache -o \
      -name node_modules -o \
      -name dist -o \
      -name coverage -o \
      -name result -o \
      -name tmp \
    \) -prune -o -type f -print \
    | LC_ALL=C sort \
    | while IFS= read -r file; do
      printf '%s ' "${file#"$dir"/}"
      sha256sum "$file" | awk '{print $1}'
    done
}

pnpm_contract_section_json() {
  local node_bin="$1"
  local contract_file="$2"
  local section="$3"

  "$node_bin" - "$contract_file" "$section" <<'EOF'
const fs = require('node:fs')

const [contractFile, section] = process.argv.slice(2)
const contract = JSON.parse(fs.readFileSync(contractFile, 'utf8'))

const stableJson = (value) => {
  if (Array.isArray(value)) {
    return value.map(stableJson)
  }

  if (value === null || typeof value !== 'object') {
    return value
  }

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableJson(nested)]),
  )
}

if (!Object.prototype.hasOwnProperty.call(contract, section)) {
  console.error(`[pnpm] pnpm install contract ${contractFile} has no section '${section}'`)
  process.exit(1)
}

process.stdout.write(`${JSON.stringify(stableJson(contract[section]))}\n`)
EOF
}

compute_pnpm_contract_section_hash() {
  local node_bin="$1"
  local contract_file="$2"
  local section="$3"

  pnpm_contract_section_json "$node_bin" "$contract_file" "$section" | compute_hash
}

classify_pnpm_contract_change() {
  local node_bin="$1"
  local previous_contract="$2"
  local current_contract="$3"

  "$node_bin" - "$previous_contract" "$current_contract" <<'EOF'
const fs = require('node:fs')
const crypto = require('node:crypto')

const [previousContractFile, currentContractFile] = process.argv.slice(2)

const stableJson = (value) => {
  if (Array.isArray(value)) {
    return value.map(stableJson)
  }

  if (value === null || typeof value !== 'object') {
    return value
  }

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableJson(nested)]),
  )
}

const sectionHash = (contract, section, contractFile) => {
  if (!Object.prototype.hasOwnProperty.call(contract, section)) {
    console.error(`[pnpm] pnpm install contract ${contractFile} has no section '${section}'`)
    process.exit(1)
  }

  return crypto
    .createHash('sha256')
    .update(`${JSON.stringify(stableJson(contract[section]))}\n`)
    .digest('hex')
}

const previousContract = JSON.parse(fs.readFileSync(previousContractFile, 'utf8'))
const currentContract = JSON.parse(fs.readFileSync(currentContractFile, 'utf8'))

for (const [section, reason] of [
  ['packageManager', 'toolchain'],
  ['dependencyGraphContract', 'dependency_graph'],
  ['installPolicy', 'policy'],
  ['storeContract', 'store'],
  ['workspaceManifestContract', 'manifest_config'],
]) {
  if (
    sectionHash(previousContract, section, previousContractFile) !==
    sectionHash(currentContract, section, currentContractFile)
  ) {
    process.stdout.write(`${reason}\n`)
    process.exit(0)
  }
}

process.stdout.write('unknown\n')
EOF
}

emit_pnpm_install_miss_span() {
  local task_name="$1"
  local reason="$2"

  if command -v otel-span >/dev/null 2>&1 && { [ -n "${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ] || { [ -n "${OTEL_SPAN_SPOOL_DIR:-}" ] && [ -d "${OTEL_SPAN_SPOOL_DIR:-}" ]; }; }; then
    otel-span emit-span "effect-utils-devenv" "devenv.task.status" \
      --attr "tool.name=devenv" \
      --attr "task.name=${task_name}" \
      --attr "task.phase=status" \
      --attr "task.cached=false" \
      --attr "status.method=hash" \
      --attr-string "span.label=${reason}" \
      --attr-string "install.miss_reason=${reason}" >/dev/null 2>&1 || true
  fi
}

check_node_modules_links_healthy() {
  local node_bin="$1"
  local projection_script="$2"
  shift 2

  for node_modules_dir in "$@"; do
    if [ ! -d "$node_modules_dir" ]; then
      continue
    fi

    broken_link="$(
      find "$node_modules_dir" -mindepth 1 -maxdepth 2 -type l ! -exec test -e {} \; -print -quit
    )"
    if [ -n "$broken_link" ]; then
      echo "[pnpm] Broken node_modules symlink detected: $broken_link" >&2
      return 1
    fi
  done

  # Feed the projection checker the exact node_modules directories we validated
  # for broken symlinks so the fast path and the authoritative task share the
  # same notion of a healthy pnpm projection.
  NODE_MODULES_DIRS="$(printf '%s\n' "$@")" "$node_bin" "$projection_script"
}

purge_node_modules() {
  for node_modules_dir in "$@"; do
    rm -rf "$node_modules_dir"
  done
}

resolve_package_bin() {
  if [ "${PNPM_LEGACY_NODE_MODULES:-0}" != "1" ]; then
    echo "[pnpm] package-bin lookup through node_modules is legacy-only; use an explicit Buck/Nix product" >&2
    return 64
  fi

  local package_name="$1"
  local bin_name="${2:-$1}"
  local cwd="${3:-$PWD}"
  local node_bin="${NODE_BIN:-node}"
  local shim_path="$cwd/node_modules/.bin/$bin_name"

  if [ -x "$shim_path" ]; then
    printf '%s\n' "$shim_path"
    return 0
  fi

  "$node_bin" - "$package_name" "$bin_name" "$cwd" <<'EOF'
const fs = require('node:fs')
const path = require('node:path')

const [packageName, binName, cwd] = process.argv.slice(2)

const manifestPath = require.resolve(`${packageName}/package.json`, { paths: [cwd] })
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const packageDir = path.dirname(manifestPath)

const candidates = []
if (typeof manifest.bin === 'string') {
  candidates.push(manifest.bin)
} else if (manifest.bin && typeof manifest.bin === 'object') {
  if (typeof manifest.bin[binName] === 'string') {
    candidates.push(manifest.bin[binName])
  }
  if (typeof manifest.bin[packageName] === 'string' && manifest.bin[packageName] !== manifest.bin[binName]) {
    candidates.push(manifest.bin[packageName])
  }
  for (const value of Object.values(manifest.bin)) {
    if (typeof value === 'string' && !candidates.includes(value)) {
      candidates.push(value)
    }
  }
}

if (candidates.length === 0) {
  console.error(`[pnpm] Package '${packageName}' does not declare a usable bin entry for '${binName}'`)
  process.exit(1)
}

for (const candidate of candidates) {
  const resolved = path.resolve(packageDir, candidate)
  if (fs.existsSync(resolved)) {
    process.stdout.write(`${resolved}\n`)
    process.exit(0)
  }
}

console.error(`[pnpm] Could not resolve an existing bin path for '${packageName}' from ${manifestPath}`)
process.exit(1)
EOF
}

run_package_bin() {
  local package_name="$1"
  local bin_name="${2:-$1}"
  shift 2

  local bin_path
  bin_path="$(resolve_package_bin "$package_name" "$bin_name")"
  "$bin_path" "$@"
}
