import {
  createGenieOutput,
  type GenieOutput,
} from '../../packages/@overeng/genie/src/runtime/core.ts'
import { defineRepoContext } from '../../packages/@overeng/genie/src/runtime/repo-context/mod.ts'
import { resolveDevenvFnScript } from './shared.ts'

const withTrailingNewline = (content: string) =>
  content.endsWith('\n') === true ? content : `${content}\n`
const dollar = '$'

const textArtifact = (content: string): GenieOutput<string> =>
  createGenieOutput({
    data: content,
    stringify: () => withTrailingNewline(content),
  })

/**
 * Reads a script that ships as a real file in this repo and emits it verbatim.
 *
 * Anchors on this module's own location so the file resolves out of the effect-utils checkout even
 * when read from a consumer repo, where effect-utils is mirrored under `repos/effect-utils/`. A
 * cwd-relative `readFileSync` would silently resolve against the consumer's root instead.
 *
 * Resolved lazily, not at module scope: this module is reachable from the barrel during genie's cold
 * bootstrap phase, where touching the filesystem or the repo-context machinery reaches packages that
 * do not exist yet. Deferring the read until the artifact is actually generated keeps the bootstrap
 * phase free of that dependency.
 */
let repoContext: ReturnType<typeof defineRepoContext> | undefined
const sharedScriptArtifact = (repoRelativePath: string): GenieOutput<string> => {
  repoContext ??= defineRepoContext({ name: 'effect-utils', importMetaUrl: import.meta.url })
  return textArtifact(repoContext.readText(repoRelativePath))
}

export const ciWorkflowNixGcRaceRetryScriptPath = 'genie/ci-scripts/nix-gc-race-retry.sh'
/**
 * Where consumers emit the shared validator. Distinct from the `ciWorkflow*` paths below, which name
 * the source inside this repo: these are the paths in the consuming repository.
 */
export const emittedPrSnapshotValidatorPath = '.github/scripts/pr-snapshot-artifact.mjs'
export const emittedPrSnapshotValidatorTestPath = '.github/scripts/pr-snapshot-artifact.test.mjs'

export const ciWorkflowPrSnapshotArtifactScriptPath = 'genie/ci-scripts/pr-snapshot-artifact.mjs'
export const ciWorkflowPrSnapshotArtifactTestPath = 'genie/ci-scripts/pr-snapshot-artifact.test.mjs'
export const ciWorkflowNixGcRaceRetryWrapperPath = 'genie/ci-scripts/run-with-nix-gc-race-retry.sh'
export const ciWorkflowJobLocalRustStateScriptPath =
  'genie/ci-scripts/prepare-job-local-rust-state.sh'
export const ciWorkflowResolveDevenvScriptPath = 'genie/ci-scripts/resolve-devenv.sh'

export const ciWorkflowResolveDevenvScript = String.raw`#!/usr/bin/env bash
set -euo pipefail

${resolveDevenvFnScript}

main() {
  local lock_file="${dollar}{1:-devenv.lock}"
  if [ ! -f "${dollar}lock_file" ]; then
    echo "::error::${dollar}lock_file is missing" >&2
    exit 1
  fi
  DEVENV_REV="${dollar}(jq -r .nodes.devenv.locked.rev "${dollar}lock_file")"
  if [ -z "${dollar}DEVENV_REV" ] || [ "${dollar}DEVENV_REV" = null ]; then
    echo "::error::${dollar}lock_file missing .nodes.devenv.locked.rev" >&2
    exit 1
  fi

  local state_root="${dollar}{RUNNER_TEMP:?RUNNER_TEMP not set}/composition-state"
  DIAG_ROOT="${dollar}state_root/nix-store-diagnostics/${dollar}{GITHUB_JOB:-job}-${dollar}{RUNNER_OS:-unknown}-${dollar}{GITHUB_RUN_ATTEMPT:-0}"
  mkdir -p "${dollar}DIAG_ROOT"
  printf 'NIX_STORE_DIAGNOSTICS_DIR=%s\n' "${dollar}DIAG_ROOT" >> "${dollar}GITHUB_ENV"

  {
    echo "timestamp_utc=${dollar}(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "runner_name=${dollar}{RUNNER_NAME:-unknown}"
    echo "runner_os=${dollar}{RUNNER_OS:-unknown}"
    echo "runner_arch=${dollar}{RUNNER_ARCH:-unknown}"
    echo "github_job=${dollar}{GITHUB_JOB:-unknown}"
    echo "github_run_id=${dollar}{GITHUB_RUN_ID:-unknown}"
    echo "nix_user_conf_files=${dollar}{NIX_USER_CONF_FILES:-}"
    nix --version || true
  } > "${dollar}DIAG_ROOT/environment.txt" 2>&1

  if ! DEVENV_OUT="${dollar}(resolve_devenv 2> >(tee "${dollar}DIAG_ROOT/resolve-devenv.log" >&2))"; then
    echo "::error::resolve_devenv failed. Last 30 lines of log:" >&2
    tail -30 "${dollar}DIAG_ROOT/resolve-devenv.log" >&2 || true
    exit 1
  fi
  DEVENV_BIN="${dollar}DEVENV_OUT/bin/devenv"

  if ! nix-store --check-validity "${dollar}DEVENV_OUT" 2>/dev/null; then
    echo "::warning::devenv store path invalid, repairing targeted path..." >&2
    nix-store --repair-path "${dollar}DEVENV_OUT" > "${dollar}DIAG_ROOT/nix-store-verify-repair.log" 2>&1 || true
    rm -rf "${dollar}{XDG_CACHE_HOME:-${dollar}HOME/.cache}"/nix/eval-cache-* ~/.cache/nix/eval-cache-*
    if ! DEVENV_OUT="${dollar}(resolve_devenv 2> >(tee "${dollar}DIAG_ROOT/resolve-devenv-post-repair.log" >&2))"; then
      echo "::error::resolve_devenv failed after repair. Last 30 lines of log:" >&2
      tail -30 "${dollar}DIAG_ROOT/resolve-devenv-post-repair.log" >&2 || true
      exit 1
    fi
    DEVENV_BIN="${dollar}DEVENV_OUT/bin/devenv"
  fi

  if [ ! -L "${dollar}DEVENV_GC_ROOT" ] || [ ! "${dollar}DEVENV_GC_ROOT" -ef "${dollar}DEVENV_OUT" ]; then
    echo "::error::devenv resolution did not publish the expected job-scoped GC root: ${dollar}DEVENV_GC_ROOT" >&2
    exit 1
  fi

  printf 'DEVENV_REV=%s\nDEVENV_GC_ROOT=%s\nDEVENV_BIN=%s\n' \
    "${dollar}DEVENV_REV" "${dollar}DEVENV_GC_ROOT" "${dollar}DEVENV_BIN" >> "${dollar}GITHUB_ENV"
  "${dollar}DEVENV_BIN" version | tee "${dollar}DIAG_ROOT/devenv-version.txt"
}

if [[ "${dollar}{BASH_SOURCE[0]}" == "${dollar}0" ]]; then
  main "${dollar}@"
fi`

export const ciWorkflowNixGcRaceRetryScript = String.raw`#!/usr/bin/env bash

run_nix_gc_race_retry() {
  local task="$1"
  local max="${dollar}{NIX_GC_RACE_MAX_RETRIES:-10}"
  local heartbeat="${dollar}{CI_PROGRESS_HEARTBEAT_SECONDS:-60}"
  local daemon_socket_retry_delay="${dollar}{NIX_DAEMON_SOCKET_RETRY_DELAY_SECONDS:-2}"
  local attempt=1
  local missing_subpath_repairs=0
  # The guillemets Nix wraps a flake reference in, built from their UTF-8 bytes so this
  # generator template stays ASCII: a non-ASCII literal here can be re-encoded by the
  # transpiler into an escape sequence that String.raw would emit verbatim.
  local flake_ref_open flake_ref_close nix_cache_root
  flake_ref_open=$'\302\253'
  flake_ref_close=$'\302\273'
  nix_cache_root="${dollar}{XDG_CACHE_HOME:-${dollar}HOME/.cache}/nix"
  local log log_dir stdout_pipe stderr_pipe rc path missing_subpath start now elapsed hb_pid stdout_tee_pid stderr_tee_pid flattened saw_invalid_path saw_cachix_signature saw_fetch_signature saw_daemon_socket_failure saw_missing_flake_subpath had_errexit

  shift
  start="$(date +%s)"

  write_summary() {
    [ -n "${dollar}{GITHUB_STEP_SUMMARY:-}" ] || return 0
    {
      echo "### CI Task"
      echo "- Task: $task"
      echo "- Status: $1"
      echo "- Duration: $elapsed s"
      echo "- Attempts: $attempt/$max"
      [ -z "${dollar}{2:-}" ] || echo "- Note: $2"
    } >> "$GITHUB_STEP_SUMMARY"
  }

  while [ "$attempt" -le "$max" ]; do
    echo "::notice::[ci] starting $task (attempt $attempt/$max)"
    (
      while sleep "$heartbeat"; do
        now=$(date +%s)
        elapsed=$((now - start))
        echo "::notice::[ci] $task still running after $elapsed s (attempt $attempt/$max)"
      done
    ) &
    hb_pid=$!

    log=$(mktemp)
    log_dir=$(mktemp -d)
    stdout_pipe="$log_dir/stdout"
    stderr_pipe="$log_dir/stderr"
    mkfifo "$stdout_pipe" "$stderr_pipe"
    tee -a "$log" < "$stdout_pipe" &
    stdout_tee_pid=$!
    tee -a "$log" < "$stderr_pipe" >&2 &
    stderr_tee_pid=$!
    had_errexit=false
    case $- in
      *e*) had_errexit=true ;;
    esac
    set +e
    "$@" > "$stdout_pipe" 2> "$stderr_pipe"
    rc=$?
    if [ "$had_errexit" = true ]; then
      set -e
    fi
    wait "$stdout_tee_pid" 2>/dev/null || true
    wait "$stderr_tee_pid" 2>/dev/null || true
    rm -rf "$log_dir"

    kill "$hb_pid" 2>/dev/null || true
    wait "$hb_pid" 2>/dev/null || true

    now=$(date +%s)
    elapsed=$((now - start))

    if [ "$rc" -eq 0 ]; then
      echo "::notice::[ci] completed $task in $elapsed s"
      if [ "$attempt" -gt 1 ]; then
        write_summary success "Recovered from transient Nix failure after retry"
      else
        write_summary success
      fi
      rm -f "$log"
      return 0
    fi

    flattened=$(tr '\r\n' '  ' < "$log" | sed -E $'s/\x1B\\[[0-9;]*m//g')
    path=$(printf '%s' "$flattened" |
      grep -o "error:[[:space:]]*path '/nix/store/[^']*'[[:space:]]*is not valid" |
      head -1 |
      grep -o "/nix/store/[^']*" |
      tr -d '[:space:]' || true)
    # A flake input whose source landed in the local fetcher/Git/tarball caches
    # incompletely renders as an error naming a path INSIDE a flake reference:
    #   error: path 'FLAKE_REF/<subpath>' does not exist
    # where Nix wraps FLAKE_REF in guillemets. A genuinely absent store path is reported
    # with the same wording, so the match is anchored on the guillemet-wrapped form
    # (built above from its UTF-8 bytes) and on 'path' directly following 'error:'.
    missing_subpath=$(printf '%s' "$flattened" |
      grep -o "error:[[:space:]]*path '${dollar}{flake_ref_open}[^']*${dollar}{flake_ref_close}[^']*' does not exist" |
      head -1 |
      sed -E "s/^error:[[:space:]]*path '//; s/' does not exist${dollar}//" || true)
    saw_invalid_path=false
    saw_cachix_signature=false
    saw_fetch_signature=false
    saw_daemon_socket_failure=false
    saw_missing_flake_subpath=false
    [ -n "$path" ] && saw_invalid_path=true
    [ -n "$missing_subpath" ] && saw_missing_flake_subpath=true
    printf '%s' "$flattened" | grep -Eq 'error:[[:space:]]*.*Failed to convert config\.cachix to JSON' && saw_cachix_signature=true || true
    printf '%s' "$flattened" | grep -Eq 'error:[[:space:]]*.*while evaluating the option.*cachix\.package' && saw_cachix_signature=true || true
    printf '%s' "$flattened" | grep -Eq 'error:[[:space:]]*cannot read file from tarball:[[:space:]]*Truncated tar archive detected while reading data' && saw_fetch_signature=true || true
    printf '%s' "$flattened" | grep -Eq "error:[[:space:]]*cannot connect to socket at '/nix/var/nix/daemon-socket/socket'" && saw_daemon_socket_failure=true || true
    rm -f "$log"

    # The guillemet form can also describe a path that upstream removed permanently, which
    # no amount of cache purging fixes. Repair it once; a second identical failure is
    # reported as the permanent path error it is, with its own summary note, rather than
    # falling through to the generic "no transient signature" message or burning $max
    # attempts.
    if [ "$saw_missing_flake_subpath" = true ] && [ "$missing_subpath_repairs" -ge 1 ]; then
      echo "::error::Nix flake input subpath still missing for $task after one cache repair: $missing_subpath; treating it as a permanent missing path"
      write_summary failure "Nix flake input subpath still missing after one cache repair: $missing_subpath"
      return "$rc"
    fi

    if [ "$saw_invalid_path" != true ] && [ "$saw_cachix_signature" != true ] && [ "$saw_fetch_signature" != true ] && [ "$saw_daemon_socket_failure" != true ] && [ "$saw_missing_flake_subpath" != true ]; then
      echo "::warning::[ci] $task failed after $elapsed s without a detected transient Nix failure"
      write_summary failure "No transient Nix failure signature detected"
      return "$rc"
    fi

    if [ "$saw_daemon_socket_failure" = true ]; then
      echo "::warning::Nix daemon socket failure detected for $task (attempt $attempt/$max); waiting $daemon_socket_retry_delay s for host supervision before retrying without mutating the host daemon"
    elif [ "$saw_missing_flake_subpath" = true ]; then
      echo "::warning::Incomplete Nix flake input cache detected for $task (attempt $attempt/$max): $missing_subpath; retrying with a refreshed input cache"
    elif [ "$saw_fetch_signature" = true ]; then
      echo "::warning::Nix source fetch corruption detected for $task (attempt $attempt/$max); retrying with a refreshed eval cache"
    elif [ "$saw_cachix_signature" = true ] && [ -n "$path" ]; then
      echo "::warning::Nix store validity race detected for $task via cachix eval wrapper (attempt $attempt/$max): $path"
    elif [ "$saw_cachix_signature" = true ]; then
      echo "::warning::Nix store validity race detected for $task via cachix eval wrapper without extracted store path (attempt $attempt/$max)"
    else
      echo "::warning::Nix store validity race detected for $task (attempt $attempt/$max): $path"
    fi

    [ -z "$path" ] || nix-store --realise "$path" 2>/dev/null || true
    # Both cache roots: the legacy HOME-relative path and the XDG root this helper resolves,
    # which diverge whenever XDG_CACHE_HOME is set away from $HOME/.cache.
    rm -rf ~/.cache/nix/eval-cache-* "${dollar}nix_cache_root"/eval-cache-*
    if [ "$saw_missing_flake_subpath" = true ]; then
      # Determinate Nix versions these caches, so the bare legacy names match nothing.
      # The sqlite globs intentionally cover the -shm/-wal sidecars: leaving those behind
      # next to a deleted database is what turns a repair into a corrupt-cache failure.
      rm -rf "${dollar}nix_cache_root"/tarball-cache-v* "${dollar}nix_cache_root"/tarball-cache
      rm -rf "${dollar}nix_cache_root"/gitv*
      rm -f "${dollar}nix_cache_root"/fetcher-cache-v*.sqlite*
      missing_subpath_repairs=$((missing_subpath_repairs + 1))
    fi
    if [ "$saw_daemon_socket_failure" = true ] && [ "$attempt" -lt "$max" ]; then
      sleep "$daemon_socket_retry_delay"
    fi
    attempt=$((attempt + 1))
  done

  now=$(date +%s)
  elapsed=$((now - start))
  echo "::error::Transient Nix retry exhausted for $task ($max attempts)"
  write_summary failure "Transient Nix retry exhausted"
  return 1
}`

export const ciWorkflowNixGcRaceRetryWrapperScript = String.raw`#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <label> <shell-command>" >&2
  exit 2
fi

label="$1"
command="$2"
script_dir="$(cd -- "$(dirname -- "${dollar}{BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=genie/ci-scripts/nix-gc-race-retry.sh
. "$script_dir/nix-gc-race-retry.sh"

run_nix_gc_race_retry "$label" bash -euo pipefail -c "$command"`

export const ciWorkflowJobLocalRustStateScript = String.raw`#!/usr/bin/env bash

# Source this helper at the task boundary. Ambient job-level Cargo state can be
# materialized during environment bootstrap by a different process identity.
: "${dollar}{RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${dollar}{GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"
: "${dollar}{GITHUB_RUN_ATTEMPT:?GITHUB_RUN_ATTEMPT is required}"
: "${dollar}{GITHUB_JOB:?GITHUB_JOB is required}"
: "${dollar}{RUNNER_NAME:?RUNNER_NAME is required}"

export CARGO_TARGET_DIR="${dollar}RUNNER_TEMP/cargo-target-${dollar}GITHUB_RUN_ID-${dollar}GITHUB_RUN_ATTEMPT-${dollar}GITHUB_JOB"
mkdir -p "$CARGO_TARGET_DIR"

# sccache's default TCP server is host-wide. A short per-runner UDS prevents a
# server owned by one self-hosted runner identity from creating another job's
# Cargo artifacts while retaining reuse through the shared cache directory.
sccache_server_key="$(printf '%s' "${dollar}GITHUB_RUN_ID-${dollar}GITHUB_RUN_ATTEMPT-${dollar}GITHUB_JOB-${dollar}RUNNER_NAME" | git hash-object --stdin | cut -c1-16)"
export SCCACHE_SERVER_UDS="${dollar}RUNNER_TEMP/sc-${dollar}sccache_server_key.sock"
unset sccache_server_key`

export const ciWorkflowSupportFiles = {
  jobLocalRustState: {
    path: ciWorkflowJobLocalRustStateScriptPath,
    output: textArtifact(ciWorkflowJobLocalRustStateScript),
  },
  resolveDevenv: {
    path: ciWorkflowResolveDevenvScriptPath,
    output: textArtifact(ciWorkflowResolveDevenvScript),
  },
  nixGcRaceRetry: {
    path: ciWorkflowNixGcRaceRetryScriptPath,
    output: textArtifact(ciWorkflowNixGcRaceRetryScript),
  },
  nixGcRaceRetryWrapper: {
    path: ciWorkflowNixGcRaceRetryWrapperPath,
    output: textArtifact(ciWorkflowNixGcRaceRetryWrapperScript),
  },
  /**
   * The PR snapshot artifact validator, and its adversarial boundary suite.
   *
   * Read from disk rather than embedded as a template literal: the validator is ~456 lines of real
   * JavaScript containing 66 `${...}` template expressions, which a `String.raw` literal would require
   * escaping one by one — unreviewable, and it would stop the shared source being the exact file that
   * runs. Consumers emit it verbatim, so every repo validates candidates with identical code.
   */
  prSnapshotArtifact: {
    path: ciWorkflowPrSnapshotArtifactScriptPath,
    get output() {
      return sharedScriptArtifact(ciWorkflowPrSnapshotArtifactScriptPath)
    },
  },
  prSnapshotArtifactTest: {
    path: ciWorkflowPrSnapshotArtifactTestPath,
    get output() {
      return sharedScriptArtifact(ciWorkflowPrSnapshotArtifactTestPath)
    },
  },
} as const

export type CiWorkflowSupportFiles = typeof ciWorkflowSupportFiles
