#!/usr/bin/env bash
# Buck-native evidence collector for the opt-in shared-cache and capacity lanes
# (03-materialization DQ1/DQ4, REUSE-R02/R04).
#
# Every assertion reads Buck's own logs for the invocation that just ran:
#   * `buck2 log what-ran --format json` -> one record per command with
#     `.reproducer.executor` in {Local, Cache, Re}; this is the hit/local class.
#   * `buck2 log what-uploaded --format json` -> one record per uploaded digest, retained
#     verbatim as the run's uploaded-digest provenance file.
#   * `buck2 log summary`                -> human-readable evidence for the step summary.
# Nothing here infers cache behaviour from wall time or from Buck's exit code alone.
#
# What this lane can and cannot claim: the candidate instance name is attribution only.
# CAS bytes are digest-verified, so they cannot be forged by a shared writer, while the
# ActionCache mapping is mutable and last-writer-wins. The lane therefore proves "this
# dispatch wrote and read its own action keys", never "this lane is isolated from the
# trusted CI lane that shares the same server".
#
# Modes:
#   publish <graph-file> <nonce-carrier> <label>
#                                build the COMPLETE candidate graph (already-cached is a
#                                valid state and is NOT a failure), then create exactly
#                                one dispatch-unique probe action from BUCK2_CACHE_NONCE
#                                and require that probe to execute locally and upload
#   restore <graph-file> <nonce-carrier> <label>
#                                rebuild the same complete graph on a different runner
#                                with zero local execution, then reproduce the SAME
#                                dispatch-unique probe and require it to be a pure cache
#                                hit, which is the cross-job transfer proof
#   miss <nonce-carrier> <label>
#                                make an independent nonce from BUCK2_CACHE_MISS_NONCE
#                                (which must differ from the shared probe nonce), prove
#                                it executes locally and uploads, wipe ONLY this
#                                composition's Buck state, then prove the same tree
#                                restores from the cache
#   outage <label>               build the SAME label successfully with the cache disabled
#                                (control), wipe only this composition's Buck state, then
#                                enable the deliberately unreachable endpoint (treatment),
#                                require the build to fail with a remote-cache/RE
#                                connection signature in its captured output, and print
#                                (never run) the documented recovery command
#   capacity <graph-file>       measure the cache-disabled DQ4 envelope: reflink probe and
#                                editor authority first, then a cold full candidate graph,
#                                the direct all-package editor publication, independent
#                                cold cumulative curve points, and a warm full rebuild
#
# `<graph-file>` is the generated `genie/ci-scripts/buck2-candidate-graph.txt`, one Buck
# label per line. It is read from the COMPOSED member so the graph under proof is the graph
# of the revision being built, never the actions checkout's copy.
set -euo pipefail

mode="${1:?usage: buck2-cache-lane.sh <publish|restore|miss|outage|capacity> ...}"
shift

workspace="${EFFECT_UTILS_WORKSPACE_ROOT:?EFFECT_UTILS_WORKSPACE_ROOT not set}"
member="${EFFECT_UTILS_MEMBER_ROOT:?EFFECT_UTILS_MEMBER_ROOT not set}"
buck2="$workspace/.megarepo/bin/buck2"
recovery='export BUCK2_NO_REMOTE_CACHE=1 in the affected environment (the documented one-line pure-local toggle, REUSE-R04)'

# Uploaded-digest provenance is retained as files, not just as a summary count, so a
# disputed upload can be re-read digest by digest after the runner is gone. The default
# matches the directory the generated workflow uploads as an artifact.
provenance_dir="${BUCK2_CACHE_PROVENANCE_DIR:-${RUNNER_TEMP:-/tmp}/buck2-cache-provenance}"
provenance_artifact="buck2-cache-provenance-${GITHUB_JOB:-job}-run-${GITHUB_RUN_ID:-local}-attempt-${GITHUB_RUN_ATTEMPT:-0}"
provenance_seq=0

fail() {
  echo "::error::$*" >&2
  exit 1
}

[ -x "$buck2" ] || fail "composed Buck wrapper is missing: $buck2"
command -v jq >/dev/null 2>&1 || fail 'jq is required to read Buck native logs'

build() {
  (cd "$workspace" && "$buck2" build --console=simple "$@")
}

# Read the generated candidate-graph label list from the composed member. Only lines that
# are actually Buck labels are kept, so Genie's `// Generated file` header can never be
# mistaken for a target. An empty or missing list is a refusal, never an empty build that
# would trivially "pass" with zero actions.
read_graph_labels() {
  local graph_file="$member/$1"
  [ -f "$graph_file" ] || fail "candidate graph file is missing: $graph_file"
  mapfile -t GRAPH_LABELS < <(grep -E '^[A-Za-z_][A-Za-z0-9_]*//[^[:space:]]+$' "$graph_file" || true)
  [ "${#GRAPH_LABELS[@]}" -gt 0 ] || fail "candidate graph file declares no labels: $graph_file"
  echo "::notice::candidate graph declares ${#GRAPH_LABELS[@]} label(s) from $1"
}

# One record per command; `--format json` is the structured surface, so an additive
# field upstream cannot silently change a count.
executor_count() {
  (cd "$workspace" && "$buck2" log what-ran --format json 2>/dev/null) \
    | jq -s --arg executor "$1" '[.[] | select(.reproducer.executor == $executor)] | length'
}

# Buck sends the human `total: digests: N` line to stderr, so the JSON record stream on
# stdout is the only reliable upload evidence: one record per uploaded digest. The full
# record list is saved before it is counted, so the count and the retained provenance can
# never disagree.
save_uploaded_digests() {
  local destination="$1"
  mkdir -p "$(dirname "$destination")"
  (cd "$workspace" && "$buck2" log what-uploaded --format json 2>/dev/null) \
    | jq -s '.' > "$destination"
  jq 'length' "$destination"
}

evidence() {
  local title="$1"
  local local_actions cached_actions remote_actions uploads slug provenance_file
  provenance_seq=$((provenance_seq + 1))
  slug="$(printf '%s' "$title" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-' | tr -s '-')"
  provenance_file="$provenance_dir/$(printf '%02d' "$provenance_seq")-${slug%-}.json"
  local_actions="$(executor_count Local)"
  cached_actions="$(executor_count Cache)"
  remote_actions="$(executor_count Re)"
  uploads="$(save_uploaded_digests "$provenance_file")"
  echo "::notice::$title local=$local_actions cache=$cached_actions remote=$remote_actions uploaded_digests=$uploads provenance=$provenance_file"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      printf '### %s\n\n' "$title"
      printf '| local | cache | remote | uploaded digests |\n| --- | --- | --- | --- |\n'
      printf '| %s | %s | %s | %s |\n\n' \
        "$local_actions" "$cached_actions" "$remote_actions" "$uploads"
      printf 'Uploaded-digest provenance: `%s` in artifact `%s`.\n\n' \
        "$(basename "$provenance_file")" "$provenance_artifact"
      printf '```\n'
      (cd "$workspace" && "$buck2" log summary 2>/dev/null) || true
      printf '```\n\n'
    } >> "$GITHUB_STEP_SUMMARY"
  fi
  LAST_LOCAL="$local_actions"
  LAST_CACHE="$cached_actions"
  LAST_REMOTE="$remote_actions"
  LAST_UPLOADS="$uploads"
}

# Remove ONLY the Buck state this composition owns: its daemon and its own isolation
# directory. The checkout, the Nix store, and the composed member tree are untouched.
wipe_owned_buck_state() {
  (cd "$workspace" && "$buck2" kill) >/dev/null 2>&1 || true
  rm -rf "$workspace/buck-out/megarepo"
  [ ! -d "$workspace/buck-out/megarepo" ] || fail 'failed to remove this composition Buck state'
}

require_no_remote_execution() {
  [ "$LAST_REMOTE" -eq 0 ] || fail "remote execution ran $LAST_REMOTE command(s); this lane is cache-only and remote_enabled must stay false"
}

# Append a nonce comment to a member-relative source file so exactly one action key in the
# graph becomes new. The caller registers `revert_nonce_carrier` before calling this, so a
# failed assertion can never leave the composed member dirty.
NONCE_CARRIER=''
apply_nonce_carrier() {
  local carrier="$1" nonce="$2" target="$member/$1"
  [ -f "$target" ] || fail "nonce carrier is missing: $target"
  NONCE_CARRIER="$carrier"
  printf '\n// dq1 cache probe nonce %s\n' "$nonce" >> "$target"
  echo "::notice::applied cache probe nonce $nonce to $carrier"
}

revert_nonce_carrier() {
  [ -n "$NONCE_CARRIER" ] || return 0
  git -C "$member" checkout -- "$NONCE_CARRIER"
  NONCE_CARRIER=''
}

# Capacity instrumentation deliberately uses the composition wrapper's fixed `megarepo`
# isolation directory. The composition is job-local, so wiping that directory creates a
# fresh owned namespace without reaching another checkout's daemon or output tree.
#
# `du` is a recursive tree walk, so it is taken ONLY at phase boundaries, where its cost is
# paid once and its answer is a LOGICAL retained-byte figure (apparent size as accounted by
# the filesystem, which double-counts nothing but also does not model reflink sharing).
capacity_logical_bytes() {
  local path="$1"
  if [ -d "$path" ]; then
    du -s -B1 "$path" | cut -f1
  else
    printf '0\n'
  fi
}

# In-phase sampling is O(1): one `statvfs` through `df` plus one `/proc/meminfo` read, so
# the sampler costs the same whether `buck-out` holds one file or a million and cannot
# perturb the wall time it is measuring.
#
# What this measures honestly: PHYSICAL filesystem drawdown (available-space delta, so
# reflinked and sparse extents count exactly as the disk accounts for them) and host memory
# pressure. It is a bounded sampler, so a spike shorter than the observed interval can be
# missed; the observed intervals are recorded rather than assumed.
capacity_sample_once() {
  local avail mem_total mem_available
  avail="$(df -B1 --output=avail "$workspace" | sed -n '2p' | tr -d ' ')"
  mem_total="$(sed -n 's/^MemTotal:[[:space:]]*\([0-9]*\).*/\1/p' /proc/meminfo)"
  mem_available="$(sed -n 's/^MemAvailable:[[:space:]]*\([0-9]*\).*/\1/p' /proc/meminfo)"
  printf '{"timestampMs":%s,"filesystemAvailableBytes":%s,"memAvailableBytes":%s,"memUsedBytes":%s}\n' \
    "$(date +%s%3N)" \
    "$avail" \
    "$((mem_available * 1024))" \
    "$(((mem_total - mem_available) * 1024))" \
    >> "$CAPACITY_SAMPLES"
}

start_capacity_sampler() {
  CAPACITY_SAMPLES="$capacity_tmp/samples-$1.jsonl"
  : > "$CAPACITY_SAMPLES"
  CAPACITY_SAMPLE_STOP="$capacity_tmp/sampler-$1.running"
  : > "$CAPACITY_SAMPLE_STOP"
  (
    while [ -e "$CAPACITY_SAMPLE_STOP" ]; do
      capacity_sample_once
      sleep "$capacity_sample_seconds"
    done
  ) &
  CAPACITY_SAMPLE_PID=$!
}

stop_capacity_sampler() {
  rm -f "$CAPACITY_SAMPLE_STOP"
  wait "$CAPACITY_SAMPLE_PID"
  capacity_sample_once
  CAPACITY_HOST="$(
    jq -s --argjson requested_ms "$capacity_sample_ms" '
      . as $s
      | ([range(1; ($s | length))] | map($s[.].timestampMs - $s[. - 1].timestampMs)) as $intervals
      | ($s[0].filesystemAvailableBytes) as $baseline
      | {
          sampleCount: ($s | length),
          sampling: {
            requestedIntervalMs: $requested_ms,
            observedIntervalMsMin: ($intervals | min // 0),
            observedIntervalMsMax: ($intervals | max // 0),
            observedIntervalMsMean:
              (if ($intervals | length) == 0 then 0 else (($intervals | add) / ($intervals | length)) end)
          },
          filesystem: {
            availableBytesAtPhaseStart: $baseline,
            availableBytesAtPhaseEnd: ($s[-1].filesystemAvailableBytes),
            physicalConsumedPeakBytes: ($baseline - ([$s[].filesystemAvailableBytes] | min)),
            physicalConsumedDeltaBytes: ($baseline - ($s[-1].filesystemAvailableBytes))
          },
          memory: {
            minAvailableBytes: ([$s[].memAvailableBytes] | min),
            peakHostUsedBytes: ([$s[].memUsedBytes] | max)
          }
        }
    ' "$CAPACITY_SAMPLES"
  )"
}

# `what-ran --format json` exposes Buck's completed action duration directly as
# `.duration` (observed schema: reason, identity, reproducer.executor/details, duration).
# Buck renders a single scaled unit; parse that field rather than reconstructing duration
# from console timestamps. Staging is the subset whose identity names dependency/tree
# assembly, while actionDurationP95Ms covers every command in the invocation.
capacity_action_metrics() {
  local log_file="$1"
  jq '
    def duration_ms:
      capture("^(?<value>[0-9]+(?:[.][0-9]+)?)(?<unit>ns|us|µs|ms|s)$") as $d
      | ($d.value | tonumber) *
        (if $d.unit == "ns" then 0.000001
         elif ($d.unit == "us" or $d.unit == "µs") then 0.001
         elif $d.unit == "ms" then 1
         else 1000 end);
    def p95:
      sort | if length == 0 then 0 else .[((length * 0.95 | ceil) - 1)] end;
    {
      actionCount: length,
      localActionCount: ([.[] | select(.reproducer.executor == "Local")] | length),
      cacheActionCount: ([.[] | select(.reproducer.executor == "Cache")] | length),
      remoteExecutionActionCount: ([.[] | select(.reproducer.executor == "Re")] | length),
      actionDurationP95Ms: ([.[] | .duration | duration_ms] | p95),
      stagingActionCount: ([
        .[] | select(.identity | test("package_view|package_tree|node_modules|pnpm_|assemble"; "i"))
      ] | length),
      stagingActionDurationP95Ms: ([
        .[]
        | select(.identity | test("package_view|package_tree|node_modules|pnpm_|assemble"; "i"))
        | .duration
        | duration_ms
      ] | p95)
    }
  ' "$log_file"
}

run_capacity_build() {
  local id="$1"
  shift
  local start_ns end_ns log_file uploads retained
  start_capacity_sampler "$id"
  start_ns="$(date +%s%N)"
  if ! (cd "$workspace" && "$buck2" build --console=simple --local-only --no-remote-cache "$@"); then
    stop_capacity_sampler
    fail "capacity build failed: $id"
  fi
  end_ns="$(date +%s%N)"
  stop_capacity_sampler
  log_file="$capacity_tmp/what-ran-$id.json"
  (cd "$workspace" && "$buck2" log what-ran --format json 2>/dev/null) | jq -s '.' > "$log_file"
  uploads="$(
    (cd "$workspace" && "$buck2" log what-uploaded --format json 2>/dev/null) | jq -s 'length'
  )"
  retained="$(
    jq -n \
      --argjson buck_out "$(capacity_logical_bytes "$workspace/buck-out/megarepo")" \
      --argjson output "$(capacity_logical_bytes "$workspace/buck-out/megarepo/art")" \
      --argjson scratch "$(capacity_logical_bytes "$workspace/buck-out/megarepo/tmp")" \
      '{ buckOutBytes: $buck_out, outputBytes: $output, scratchBytes: $scratch }'
  )"
  CAPACITY_BUILD="$(
    jq -n \
      --arg id "$id" \
      --argjson wall_time_ms "$(((end_ns - start_ns) / 1000000))" \
      --argjson host "$CAPACITY_HOST" \
      --argjson actions "$(capacity_action_metrics "$log_file")" \
      --argjson retained "$retained" \
      --argjson uploaded_digest_count "$uploads" \
      '{
        id: $id,
        wallTimeMs: $wall_time_ms,
        host: $host,
        retainedLogicalBytes: $retained,
        actions: ($actions + { uploadedDigestCount: $uploaded_digest_count })
      }'
  )"
  [ "$(jq '.actions.remoteExecutionActionCount' <<<"$CAPACITY_BUILD")" -eq 0 ] ||
    fail "capacity build $id used remote execution"
  [ "$(jq '.actions.uploadedDigestCount' <<<"$CAPACITY_BUILD")" -eq 0 ] ||
    fail "capacity build $id uploaded remote evidence"
}

# One `cp --reflink=always` on the composed workspace's own filesystem. This is why the
# physical and logical byte figures are reported side by side: where reflink is supported,
# logical retained bytes overstate what the disk actually gave up.
capacity_reflink_probe() {
  local probe="$workspace/buck-out/capacity-reflink-probe"
  rm -rf "$probe"
  mkdir -p "$probe"
  printf 'capacity reflink probe\n' > "$probe/source"
  if "$capacity_cp" --reflink=always "$probe/source" "$probe/clone" 2>"$probe/error"; then
    CAPACITY_REFLINK="$(
      jq -n '{
        probe: "cp --reflink=always on the composed workspace filesystem",
        supported: true,
        detail: ""
      }'
    )"
  else
    CAPACITY_REFLINK="$(
      jq -n --arg detail "$(tr '\n' ' ' < "$probe/error" | cut -c1-200)" '{
        probe: "cp --reflink=always on the composed workspace filesystem",
        supported: false,
        detail: $detail
      }'
    )"
  fi
  rm -rf "$probe"
}

# Editor authority is prepared BEFORE the first cold observation, so no publication
# prerequisite is ever measured as publication and no Devenv dependency closure runs after
# a cold build. Its own Buck work is discarded by the wipe that precedes the cold build.
prepare_editor_publication() {
  capacity_editor_view_runner="$capacity_tmp/editor-view-runner.sh"
  {
    printf '#!/usr/bin/env bash\n'
    printf 'set -euo pipefail\n'
    printf 'cd %q\n' "$workspace"
    printf 'exec %q run effect_utils//scripts:editor-view -- "$@"\n' "$buck2"
  } > "$capacity_editor_view_runner"
  chmod +x "$capacity_editor_view_runner"
  (cd "$workspace" && "$buck2" run effect_utils//scripts:editor-view-authority -- \
    --repo-root "$member" \
    --workspace-root "$workspace" \
    --cell effect_utils \
    --buck2 "$buck2" \
    --git "$capacity_git" \
    --output "$capacity_editor_authority") ||
    fail 'editor authority preparation failed before the first cold observation'
  [ -f "$capacity_editor_authority" ] ||
    fail "editor authority was not written: $capacity_editor_authority"
}

# The publication measurement is the exact direct `scripts:buck-watch publish` invocation
# the committed `buck2:typescript:publish-editor-views` task runs, with every argument
# stated here. No Devenv task graph, so no dependency closure and no source mutation can
# land inside the measured window or after the cold observation.
run_editor_publication() {
  local start_ns end_ns member_status_before member_status_after
  member_status_before="$(git -C "$member" status --porcelain=v1 --untracked-files=no)"
  start_capacity_sampler editor-publication
  start_ns="$(date +%s%N)"
  if ! (cd "$workspace" && "$buck2" run effect_utils//scripts:buck-watch -- publish \
    --repo-root "$member" \
    --workspace-root "$workspace" \
    --buck-cell effect_utils \
    --buck2 "$buck2" \
    --editor-view "$capacity_editor_view_runner" \
    --workspace-authority "$capacity_editor_authority" \
    --cp "$capacity_cp" \
    --mv "$capacity_mv" \
    --snapshot-retention "$capacity_snapshot_retention"); then
    stop_capacity_sampler
    fail 'repository-wide editor snapshot publication failed'
  fi
  end_ns="$(date +%s%N)"
  stop_capacity_sampler
  member_status_after="$(git -C "$member" status --porcelain=v1 --untracked-files=no)"
  [ "$member_status_before" = "$member_status_after" ] ||
    fail 'editor publication mutated tracked member sources'
  CAPACITY_PUBLICATION="$(
    jq -n \
      --argjson wall_time_ms "$(((end_ns - start_ns) / 1000000))" \
      --argjson host "$CAPACITY_HOST" \
      --argjson retention "$capacity_snapshot_retention" \
      '{
        wallTimeMs: $wall_time_ms,
        host: $host,
        invocation: "buck2 run effect_utils//scripts:buck-watch -- publish (direct, fully argument-stated)",
        snapshotRetention: $retention
      }'
  )"
}

measure_editor_snapshots() {
  local label package record snapshot bytes
  local -A expected=() package_bytes=() package_generations=()
  for label in "${GRAPH_LABELS[@]}"; do
    case "$label" in
      *:editor_view_inputs)
        package="${label#*//}"
        package="${package%:editor_view_inputs}"
        expected["$package"]=1
        ;;
    esac
  done
  [ "${#expected[@]}" -gt 0 ] || fail 'candidate graph has no admitted editor packages'

  while IFS= read -r -d '' record; do
    package="$(jq -er '.package' "$record")"
    [ -n "${expected[$package]:-}" ] || continue
    snapshot="$(dirname "$record")"
    bytes="$(capacity_logical_bytes "$snapshot")"
    package_bytes["$package"]=$((${package_bytes[$package]:-0} + bytes))
    package_generations["$package"]=$((${package_generations[$package]:-0} + 1))
  done < <(find "$member" -type f -path '*/.editor-view/.store/*/editor-view.json' -print0)

  : > "$capacity_tmp/editor-packages.jsonl"
  for package in "${!expected[@]}"; do
    [ "${package_generations[$package]:-0}" -ge 1 ] ||
      fail "editor package published no retained snapshot generation: $package"
    jq -cn \
      --arg package "$package" \
      --argjson bytes "${package_bytes[$package]}" \
      --argjson generations "${package_generations[$package]}" \
      '{ package: $package, bytes: $bytes, retainedGenerationCount: $generations }' \
      >> "$capacity_tmp/editor-packages.jsonl"
  done
  CAPACITY_EDITOR_SNAPSHOTS="$(
    jq -s 'sort_by(.package) | {
      packages: .,
      repositoryTotalBytes: (map(.bytes) | add // 0),
      retainedGenerationCount: (map(.retainedGenerationCount) | add // 0)
    }' "$capacity_tmp/editor-packages.jsonl"
  )"
}

capacity_cleanup() {
  local status=$?
  rm -f "${CAPACITY_SAMPLE_STOP:-}"
  if [ -n "${CAPACITY_SAMPLE_PID:-}" ]; then
    wait "$CAPACITY_SAMPLE_PID" 2>/dev/null || true
  fi
  wipe_owned_buck_state
  rm -rf "${capacity_tmp:-}"
  trap - EXIT
  exit "$status"
}

case "$mode" in
  publish)
    read_graph_labels "${1:?publish requires the generated candidate-graph file}"
    carrier="${2:?publish requires a member-relative source file to carry the probe nonce}"
    label="${3:?publish requires exactly one candidate label}"
    nonce="${BUCK2_CACHE_NONCE:?BUCK2_CACHE_NONCE not set}"

    build "${GRAPH_LABELS[@]}"
    evidence 'Candidate graph population'
    require_no_remote_execution
    # Deliberately NO local-execution or upload assertion over the graph: a complete
    # graph that is ALREADY in the shared cache is a correct, expected state, and
    # demanding fresh local work here would make the lane fail on every dispatch after
    # the first. The publish claim is carried entirely by the dispatch-unique probe below.

    trap revert_nonce_carrier EXIT
    apply_nonce_carrier "$carrier" "$nonce"
    build "$label"
    evidence 'Dispatch-unique probe publish'
    require_no_remote_execution
    [ "$LAST_LOCAL" -gt 0 ] || fail 'the dispatch-unique probe executed no local command, so this dispatch published no action of its own'
    [ "$LAST_UPLOADS" -gt 0 ] || fail 'the dispatch-unique probe uploaded zero digests, so CI cannot write to the shared cache'
    revert_nonce_carrier
    ;;

  restore)
    read_graph_labels "${1:?restore requires the generated candidate-graph file}"
    carrier="${2:?restore requires the same member-relative nonce carrier the publish leg used}"
    label="${3:?restore requires exactly one candidate label}"
    nonce="${BUCK2_CACHE_NONCE:?BUCK2_CACHE_NONCE not set}"

    build "${GRAPH_LABELS[@]}"
    evidence 'Candidate graph restore'
    require_no_remote_execution
    [ "$LAST_CACHE" -gt 0 ] || fail 'restore produced zero cache hits, so nothing was restored'
    [ "$LAST_LOCAL" -eq 0 ] || fail "restore executed $LAST_LOCAL command(s) locally; a complete candidate graph must be a pure cache restore"

    # The transfer proof: the same dispatch-stable nonce reproduces the exact action the
    # publish job created on a different runner, in a different absolute composition
    # prefix, with an empty buck-out. A hit here can only have come over the cache.
    trap revert_nonce_carrier EXIT
    apply_nonce_carrier "$carrier" "$nonce"
    build "$label"
    evidence 'Dispatch-unique probe restore'
    require_no_remote_execution
    [ "$LAST_CACHE" -gt 0 ] || fail 'the dispatch-unique probe published by the publish job produced zero cache hits here, so no action crossed the job boundary'
    [ "$LAST_LOCAL" -eq 0 ] || fail "the dispatch-unique probe re-executed $LAST_LOCAL command(s) locally instead of hitting the action the publish job uploaded"
    revert_nonce_carrier
    ;;

  miss)
    carrier="${1:?miss requires a member-relative source file to carry the nonce}"
    label="${2:?miss requires exactly one candidate label}"
    nonce="${BUCK2_CACHE_MISS_NONCE:?BUCK2_CACHE_MISS_NONCE not set}"
    # The miss leg proves a NEW miss, so its nonce must be independent of the shared
    # publish/restore probe nonce; reusing that value would make this leg a cache hit
    # wearing a miss label.
    [ "$nonce" != "${BUCK2_CACHE_NONCE:-}" ] || fail 'BUCK2_CACHE_MISS_NONCE must differ from BUCK2_CACHE_NONCE, otherwise the deliberate miss is just the shared probe hit'

    trap revert_nonce_carrier EXIT
    apply_nonce_carrier "$carrier" "$nonce"

    build "$label"
    evidence 'Deliberate miss upload'
    require_no_remote_execution
    [ "$LAST_LOCAL" -gt 0 ] || fail 'the nonce did not force any local execution, so it is not a deliberate miss'
    [ "$LAST_UPLOADS" -gt 0 ] || fail 'the deliberate miss uploaded zero digests, so CI cannot write to the cache'

    wipe_owned_buck_state
    build "$label"
    evidence 'Deliberate miss restore'
    require_no_remote_execution
    [ "$LAST_CACHE" -gt 0 ] || fail 'the deliberate miss did not restore from the cache after the wipe'
    [ "$LAST_LOCAL" -eq 0 ] || fail "the deliberate miss re-executed $LAST_LOCAL command(s) locally instead of restoring"
    revert_nonce_carrier
    ;;

  capacity)
    read_graph_labels "${1:?capacity requires the generated candidate-graph file}"
    [ "${BUCK2_NO_REMOTE_CACHE:-}" = 1 ] ||
      fail 'capacity requires composition-owned BUCK2_NO_REMOTE_CACHE=1'
    capacity_runner_profile="${BUCK2_CAPACITY_RUNNER_PROFILE:?BUCK2_CAPACITY_RUNNER_PROFILE not set}"
    capacity_timeout_minutes="${BUCK2_CAPACITY_TIMEOUT_MINUTES:?BUCK2_CAPACITY_TIMEOUT_MINUTES not set}"
    capacity_job_concurrency="${BUCK2_CAPACITY_JOB_CONCURRENCY:?BUCK2_CAPACITY_JOB_CONCURRENCY not set}"
    for numeric in "$capacity_timeout_minutes" "$capacity_job_concurrency"; do
      case "$numeric" in
        ''|*[!0-9]*) fail "capacity workflow bounds must be positive integers: $numeric" ;;
      esac
      [ "$numeric" -gt 0 ] || fail "capacity workflow bounds must be positive: $numeric"
    done
    [ "$capacity_job_concurrency" -eq 1 ] ||
      fail "capacity workflow must bind job concurrency to one: $capacity_job_concurrency"
    capacity_result_dir="${BUCK2_CAPACITY_RESULT_DIR:-${RUNNER_TEMP:-/tmp}/buck2-capacity-evidence}"
    capacity_result="$capacity_result_dir/capacity.json"
    capacity_tmp="$(mktemp -d "${RUNNER_TEMP:-/tmp}/buck2-capacity.XXXXXX")"
    capacity_sample_ms="${BUCK2_CAPACITY_SAMPLE_MS:-250}"
    case "$capacity_sample_ms" in
      ''|*[!0-9]*) fail "capacity sample interval must be integer milliseconds: $capacity_sample_ms" ;;
    esac
    [ "$capacity_sample_ms" -gt 0 ] || fail 'capacity sample interval must be greater than zero'
    capacity_sample_seconds="$(jq -nr --argjson ms "$capacity_sample_ms" '$ms / 1000')"
    capacity_snapshot_retention="${BUCK2_CAPACITY_SNAPSHOT_RETENTION:-3}"
    capacity_editor_authority="$member/.devenv/editor-workspace-authority.json"
    capacity_cp="$(command -v cp)" || fail 'cp is required for capacity measurement'
    capacity_mv="$(command -v mv)" || fail 'mv is required for capacity measurement'
    capacity_git="$(command -v git)" || fail 'git is required for capacity measurement'
    mkdir -p "$capacity_result_dir" "$member/.devenv"
    rm -f "$capacity_result"
    capacity_started_ns="$(date +%s%N)"
    trap capacity_cleanup EXIT

    # Class membership is explicit and total: an unmatched label is a refusal, never a
    # silent "product". Products are exactly the declared `*:<name>-candidate` closures.
    declare -a capacity_support=() capacity_editor=() capacity_typecheck=()
    declare -a capacity_dist=() capacity_products=()
    for label in "${GRAPH_LABELS[@]}"; do
      case "$label" in
        effect_utils//buck2/toolchains:*) capacity_support+=("$label") ;;
        *:editor_view_inputs) capacity_editor+=("$label") ;;
        *:typecheck|*:typecheck_*) capacity_typecheck+=("$label") ;;
        *:dist) capacity_dist+=("$label") ;;
        *:*-candidate) capacity_products+=("$label") ;;
        *) fail "candidate graph label belongs to no capacity class: $label" ;;
      esac
    done

    # Publication prerequisites are paid BEFORE the first cold observation, and their Buck
    # work is then discarded by the wipe below, so nothing measured as cold or as
    # publication includes a prerequisite.
    capacity_reflink_probe
    prepare_editor_publication

    wipe_owned_buck_state
    run_capacity_build cold-full "${GRAPH_LABELS[@]}"
    capacity_cold="$CAPACITY_BUILD"
    run_editor_publication
    capacity_publication="$CAPACITY_PUBLICATION"
    publication_remote="$(executor_count Re)"
    publication_uploads="$(
      (cd "$workspace" && "$buck2" log what-uploaded --format json 2>/dev/null) | jq -s 'length'
    )"
    [ "$publication_remote" -eq 0 ] || fail 'editor publication used remote execution'
    [ "$publication_uploads" -eq 0 ] || fail 'editor publication uploaded remote evidence'
    capacity_publication="$(
      jq \
        --argjson remote "$publication_remote" \
        --argjson uploads "$publication_uploads" \
        '. + {remoteExecutionActionCount: $remote, uploadedDigestCount: $uploads}' \
        <<<"$capacity_publication"
    )"
    measure_editor_snapshots
    capacity_editor_snapshots="$CAPACITY_EDITOR_SNAPSHOTS"
    capacity_combined="$(
      jq -n \
        --argjson cold "$capacity_cold" \
        --argjson publication "$capacity_publication" \
        '{
          wallTimeMs: ($cold.wallTimeMs + $publication.wallTimeMs),
          filesystemPhysicalConsumedPeakBytes: ([
            $cold.host.filesystem.physicalConsumedPeakBytes,
            $publication.host.filesystem.physicalConsumedPeakBytes
          ] | max),
          minMemAvailableBytes: ([
            $cold.host.memory.minAvailableBytes,
            $publication.host.memory.minAvailableBytes
          ] | min),
          peakHostUsedRamBytes: ([
            $cold.host.memory.peakHostUsedBytes,
            $publication.host.memory.peakHostUsedBytes
          ] | max)
        }'
    )"

    # Every curve point is an INDEPENDENT cold cumulative build: the owned Buck state is
    # wiped before each one, so a point's raw wall/action/byte figures describe building
    # that whole cumulative set from nothing. The marginal slope is therefore a difference
    # between two raw cold cumulative points, never a single warm-ish increment, and both
    # raw points are preserved.
    capacity_curve='[]'
    declare -a capacity_cumulative=()
    capacity_previous_wall=0
    capacity_previous_actions=0
    capacity_previous_buck_out=0
    capacity_previous_output=0
    for class in supportTools editorViewInputs typecheck dist products; do
      case "$class" in
        supportTools)
          class_label_count="${#capacity_support[@]}"
          capacity_cumulative+=("${capacity_support[@]}")
          ;;
        editorViewInputs)
          class_label_count="${#capacity_editor[@]}"
          capacity_cumulative+=("${capacity_editor[@]}")
          ;;
        typecheck)
          class_label_count="${#capacity_typecheck[@]}"
          capacity_cumulative+=("${capacity_typecheck[@]}")
          ;;
        dist)
          class_label_count="${#capacity_dist[@]}"
          capacity_cumulative+=("${capacity_dist[@]}")
          ;;
        products)
          class_label_count="${#capacity_products[@]}"
          capacity_cumulative+=("${capacity_products[@]}")
          ;;
      esac
      [ "$class_label_count" -gt 0 ] || fail "capacity curve class is empty: $class"
      wipe_owned_buck_state
      run_capacity_build "curve-$class" "${capacity_cumulative[@]}"
      capacity_curve="$(
        jq \
          --arg class "$class" \
          --argjson class_label_count "$class_label_count" \
          --argjson cumulative_label_count "${#capacity_cumulative[@]}" \
          --argjson previous_wall "$capacity_previous_wall" \
          --argjson previous_actions "$capacity_previous_actions" \
          --argjson previous_buck_out "$capacity_previous_buck_out" \
          --argjson previous_output "$capacity_previous_output" \
          --argjson measurement "$CAPACITY_BUILD" \
          '. + [($measurement + {
            addedClass: $class,
            addedLabelCount: $class_label_count,
            cumulativeLabelCount: $cumulative_label_count,
            coldCumulative: true,
            previousRawCumulative: {
              wallTimeMs: $previous_wall,
              localActionCount: $previous_actions,
              retainedBuckOutBytes: $previous_buck_out,
              retainedOutputBytes: $previous_output
            },
            marginalSlope: {
              wallTimeMsPerAddedLabel:
                (($measurement.wallTimeMs - $previous_wall) / $class_label_count),
              localActionCountPerAddedLabel:
                (($measurement.actions.localActionCount - $previous_actions) / $class_label_count),
              retainedBuckOutBytesPerAddedLabel:
                (($measurement.retainedLogicalBytes.buckOutBytes - $previous_buck_out) / $class_label_count),
              retainedOutputBytesPerAddedLabel:
                (($measurement.retainedLogicalBytes.outputBytes - $previous_output) / $class_label_count)
            }
          })]' \
          <<<"$capacity_curve"
      )"
      capacity_previous_wall="$(jq '.wallTimeMs' <<<"$CAPACITY_BUILD")"
      capacity_previous_actions="$(jq '.actions.localActionCount' <<<"$CAPACITY_BUILD")"
      capacity_previous_buck_out="$(jq '.retainedLogicalBytes.buckOutBytes' <<<"$CAPACITY_BUILD")"
      capacity_previous_output="$(jq '.retainedLogicalBytes.outputBytes' <<<"$CAPACITY_BUILD")"
    done
    # Exact set equality against the generated list, in canonical order, so no class split
    # can drop or duplicate a label.
    [ "$(printf '%s\n' "${capacity_cumulative[@]}" | sort)" = "$(printf '%s\n' "${GRAPH_LABELS[@]}" | sort)" ] ||
      fail 'capacity curve did not cover the exact generated candidate graph'
    # No wipe here: the final cumulative point IS the full graph, so this is the warm
    # rebuild of exactly that state.
    run_capacity_build warm-full "${GRAPH_LABELS[@]}"
    capacity_warm="$CAPACITY_BUILD"

    commit="$(git -C "$member" rev-parse --verify HEAD)"
    cpu_model="$(lscpu | sed -n 's/^Model name:[[:space:]]*//p' | sed -n '1p')"
    ram_bytes="$(($(sed -n 's/^MemTotal:[[:space:]]*\([0-9]*\).*/\1/p' /proc/meminfo) * 1024))"
    filesystem_type="$(stat -f -c '%T' "$workspace")"
    filesystem_size_bytes="$(df -B1 --output=size "$workspace" | sed -n '2p' | tr -d ' ')"
    filesystem_available_bytes="$(df -B1 --output=avail "$workspace" | sed -n '2p' | tr -d ' ')"
    elapsed_ms="$((($(date +%s%N) - capacity_started_ns) / 1000000))"
    remote_total="$(
      jq -n \
        --argjson cold "$capacity_cold" \
        --argjson publication "$capacity_publication" \
        --argjson curve "$capacity_curve" \
        --argjson warm "$capacity_warm" \
        '$cold.actions.remoteExecutionActionCount +
         $publication.remoteExecutionActionCount +
         ($curve | map(.actions.remoteExecutionActionCount) | add) +
         $warm.actions.remoteExecutionActionCount'
    )"
    uploads_total="$(
      jq -n \
        --argjson cold "$capacity_cold" \
        --argjson publication "$capacity_publication" \
        --argjson curve "$capacity_curve" \
        --argjson warm "$capacity_warm" \
        '$cold.actions.uploadedDigestCount +
         $publication.uploadedDigestCount +
         ($curve | map(.actions.uploadedDigestCount) | add) +
         $warm.actions.uploadedDigestCount'
    )"

    jq -n \
      --arg schema 'effect-utils/buck2-capacity/v1' \
      --arg commit "$commit" \
      --arg graph_file "$1" \
      --argjson label_count "${#GRAPH_LABELS[@]}" \
      --argjson support_count "${#capacity_support[@]}" \
      --argjson editor_count "${#capacity_editor[@]}" \
      --argjson typecheck_count "${#capacity_typecheck[@]}" \
      --argjson dist_count "${#capacity_dist[@]}" \
      --argjson product_count "${#capacity_products[@]}" \
      --arg runner_profile "$capacity_runner_profile" \
      --argjson timeout_minutes "$capacity_timeout_minutes" \
      --argjson job_concurrency "$capacity_job_concurrency" \
      --arg cpu_model "$cpu_model" \
      --argjson logical_cpu_count "$(nproc)" \
      --argjson ram_bytes "$ram_bytes" \
      --arg filesystem_type "$filesystem_type" \
      --argjson filesystem_size_bytes "$filesystem_size_bytes" \
      --argjson filesystem_available_bytes "$filesystem_available_bytes" \
      --argjson reflink "$CAPACITY_REFLINK" \
      --argjson sample_ms "$capacity_sample_ms" \
      --argjson elapsed_ms "$elapsed_ms" \
      --argjson cold "$capacity_cold" \
      --argjson publication "$capacity_publication" \
      --argjson combined "$capacity_combined" \
      --argjson snapshots "$capacity_editor_snapshots" \
      --argjson curve "$capacity_curve" \
      --argjson warm "$capacity_warm" \
      --argjson remote_total "$remote_total" \
      --argjson uploads_total "$uploads_total" \
      '{
        schema: $schema,
        commit: $commit,
        graph: {
          file: $graph_file,
          labelCount: $label_count,
          classLabelCounts: {
            supportTools: $support_count,
            editorViewInputs: $editor_count,
            typecheck: $typecheck_count,
            dist: $dist_count,
            products: $product_count
          }
        },
        runner: {
          runnerProfile: $runner_profile,
          jobTimeoutMinutes: $timeout_minutes,
          jobConcurrency: $job_concurrency,
          cpu: { model: $cpu_model, logicalCount: $logical_cpu_count },
          ramBytes: $ram_bytes,
          filesystem: {
            type: $filesystem_type,
            sizeBytes: $filesystem_size_bytes,
            availableBytesAtReport: $filesystem_available_bytes,
            reflink: $reflink
          }
        },
        measurement: {
          cacheMode: "disabled (--local-only --no-remote-cache; composition-owned BUCK2_NO_REMOTE_CACHE=1)",
          isolationDirectory: "buck-out/megarepo (owned state wiped before every cold observation)",
          inPhaseSampling: "O(1) per sample: df statvfs available bytes plus /proc/meminfo MemTotal/MemAvailable. Physical figures are available-space drawdown, so reflinked and sparse extents count as the filesystem accounts for them. A spike shorter than the observed interval can be missed.",
          phaseBoundaryDisk: "GNU du -s -B1 at phase boundaries only; reported as LOGICAL retained bytes, which do not model reflink sharing.",
          outputPath: "buck-out/megarepo/art",
          scratchPath: "buck-out/megarepo/tmp",
          requestedSampleIntervalMs: $sample_ms,
          actionLogSchema: "buck2 log what-ran --format json: reason, identity, reproducer.executor/details, duration",
          actionDurationField: ".duration",
          stagingIdentityPattern: "package_view|package_tree|node_modules|pnpm_|assemble",
          editorPublicationInvocation: "direct buck2 run effect_utils//scripts:buck-watch -- publish with every argument stated; authority prepared before the first cold observation; no Devenv dependency closure and no source mutation inside or after the cold window",
          curveSemantics: "Every curve point is an independent COLD cumulative build (owned Buck state wiped before each). Raw points are preserved; marginalSlope is the current raw cold cumulative minus the previous raw cold cumulative, divided by the labels that class added.",
          labelClassification: "supportTools=//buck2/toolchains:*, editorViewInputs=*:editor_view_inputs, typecheck=*:typecheck(_*), dist=*:dist, products=*:*-candidate; an unmatched label fails the lane."
        },
        coldFullCandidateGraph: $cold,
        editorPublication: $publication,
        combinedCold: $combined,
        editorSnapshots: $snapshots,
        marginalCurve: $curve,
        warmFullCandidateGraph: $warm,
        budget: {
          jobTimeoutMs: ($timeout_minutes * 60000),
          measuredElapsedMs: $elapsed_ms,
          timeoutHeadroomMs: (($timeout_minutes * 60000) - $elapsed_ms),
          timeoutHeadroomRatio: (1 - ($elapsed_ms / ($timeout_minutes * 60000)))
        },
        remoteEvidence: {
          importedActionCount: 0,
          remoteExecutionActionCount: $remote_total,
          uploadedDigestCount: $uploads_total
        },
        thresholds: null
      }' > "$capacity_result"

    if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
      {
        printf '### Buck2 capacity evidence (DQ4)\n\n'
        printf 'Commit `%s`; %s generated candidate labels; cache disabled; no thresholds applied.\n\n' \
          "$commit" "${#GRAPH_LABELS[@]}"
        printf '| observation | wall ms | fs physical peak bytes | logical buck-out bytes | min RAM available bytes |\n'
        printf '| --- | ---: | ---: | ---: | ---: |\n'
        jq -r '[
          ["cold candidate graph", .coldFullCandidateGraph],
          ["editor publication", .editorPublication],
          ["warm full rebuild", .warmFullCandidateGraph]
        ][] | "| \(.[0]) | \(.[1].wallTimeMs) | \(.[1].host.filesystem.physicalConsumedPeakBytes) | \(.[1].retainedLogicalBytes.buckOutBytes // 0) | \(.[1].host.memory.minAvailableBytes) |"' \
          "$capacity_result"
        printf '\nCombined cold wall: %s ms; timeout headroom: %s ms of %s ms.\n\n' \
          "$(jq '.combinedCold.wallTimeMs' "$capacity_result")" \
          "$(jq '.budget.timeoutHeadroomMs' "$capacity_result")" \
          "$(jq '.budget.jobTimeoutMs' "$capacity_result")"
        printf 'Editor snapshots: %s logical bytes across %s retained generation(s) and %s package(s).\n\n' \
          "$(jq '.editorSnapshots.repositoryTotalBytes' "$capacity_result")" \
          "$(jq '.editorSnapshots.retainedGenerationCount' "$capacity_result")" \
          "$(jq '.editorSnapshots.packages | length' "$capacity_result")"
        printf 'Action duration p95: %s ms; staging duration p95: %s ms.\n\n' \
          "$(jq '.coldFullCandidateGraph.actions.actionDurationP95Ms' "$capacity_result")" \
          "$(jq '.coldFullCandidateGraph.actions.stagingActionDurationP95Ms' "$capacity_result")"
        printf 'Sampling: %s ms requested, %s ms observed mean (O(1) df + /proc/meminfo); `du` only at phase boundaries. Reflink supported: %s.\n\n' \
          "$capacity_sample_ms" \
          "$(jq '.coldFullCandidateGraph.host.sampling.observedIntervalMsMean' "$capacity_result")" \
          "$(jq '.runner.filesystem.reflink.supported' "$capacity_result")"
        printf 'Machine-readable evidence: `%s`.\n' "$capacity_result"
      } >> "$GITHUB_STEP_SUMMARY"
    fi
    echo "::notice::capacity evidence written to $capacity_result"
    ;;

  outage)
    label="${1:?outage requires exactly one candidate label}"
    # Control, then treatment. The control leg proves this exact label BUILDS on this
    # runner with the cache disabled, so the treatment leg's failure cannot be a broken
    # target, a missing toolchain, or a bad composition wearing an "outage" label. The
    # owned Buck state is then wiped so the treatment build has to reach the cache.
    echo "::notice::control: building the label with the remote cache disabled"
    (cd "$workspace" && "$buck2" build --console=simple --local-only --no-remote-cache "$label") ||
      fail 'the control build failed with the cache disabled, so this runner cannot prove anything about an outage'
    echo "::notice::control build succeeded; wiping owned Buck state before the outage treatment"
    wipe_owned_buck_state

    endpoint="${BUCK2_CACHE_ENDPOINT:?BUCK2_CACHE_ENDPOINT not set; the outage leg needs the deliberately unreachable endpoint}"
    instance="${BUCK2_CACHE_INSTANCE_NAME:?BUCK2_CACHE_INSTANCE_NAME not set}"
    override="$workspace/.buckconfig.local"
    # Root-cell buckconfig FILE, the same sanctioned injection point the composition root
    # and the developer shell use. Never a `-c` override: CLI overrides never reach the
    # RE client at all, so they cannot express an outage.
    [ ! -e "$override" ] || fail "refusing to clobber an existing root cache override: $override"
    drop_override() { rm -f "$override"; }
    trap drop_override EXIT
    {
      printf '[buck2]\n'
      printf 'remote_cache_enabled = true\n'
      printf 'allow_cache_uploads = true\n'
      printf 'digest_algorithms = SHA256\n'
      printf 'default_allow_cache_upload = true\n\n'
      printf '[buck2_re_client]\n'
      printf 'engine_address = %s\n' "$endpoint"
      printf 'action_cache_address = %s\n' "$endpoint"
      printf 'cas_address = %s\n' "$endpoint"
      printf 'instance_name = %s\n' "$instance"
      printf 'tls = false\n'
      # Bounded upload batch, identical to the developer and composition config paths:
      # 4 MiB, below the default 4 MiB gRPC message limit both peers enforce.
      printf 'max_total_batch_size = 4194304\n'
    } > "$override"
    echo "::notice::asserting a hard failure against a deliberately unreachable cache endpoint"
    outage_log="${RUNNER_TEMP:-/tmp}/buck2-cache-outage.log"
    if (cd "$workspace" && "$buck2" build --console=simple "$label") >"$outage_log" 2>&1; then
      cat "$outage_log" >&2
      fail 'the build SUCCEEDED against an unreachable cache; a cache outage must never degrade into a silent local build'
    fi
    # A bare nonzero exit is not the claim: the failure has to name the remote cache / RE
    # client connection. Anything else (an analysis error, an OOM, a killed daemon) would
    # be a different failure wearing the outage result.
    outage_signature='re_client|buck2_re_client|remote execution client|RE client|action cache|action_cache|cas_address|engine_address|grpc|transport error|dns error|failed to lookup address|name resolution|Connection refused|connect error|Unavailable|unreachable'
    if ! grep -Eiq -- "$outage_signature" "$outage_log"; then
      cat "$outage_log" >&2
      fail 'the build failed WITHOUT a remote-cache/RE connection signature, so this is an unrelated failure rather than the cache outage under proof'
    fi
    echo "::notice::build failed closed with a remote-cache connection signature, as required"
    grep -Eio -- "$outage_signature" "$outage_log" | sort -u | head -5 | sed 's/^/::notice::outage signature: /'
    echo "::notice::documented recovery (printed, deliberately NOT run here): $recovery"
    drop_override
    ;;

  *)
    fail "unknown mode: $mode"
    ;;
esac
