# OpenTelemetry observability stack for local development
#
# Provides OTEL Collector + Grafana Tempo + Grafana as devenv processes
# for collecting traces from native devenv tasks and application code.
#
# Usage in devenv.nix:
#   imports = [
#     (inputs.effect-utils.devenvModules.otel {})
#     # or with custom base port:
#     # (inputs.effect-utils.devenvModules.otel { basePort = 14000; })
#   ];
#
# Port allocation:
#   By default, ports are derived deterministically from a hash of $DEVENV_ROOT
#   so parallel devenvs (worktrees) get non-conflicting ports automatically.
#   You can override with a fixed basePort if preferred.
#
# Components:
#   - OTEL Collector (receives OTLP/HTTP on port basePort+0, exports to Tempo)
#   - Grafana Tempo (receives traces from collector on port basePort+1, query on basePort+2)
#   - Grafana (dashboard UI on port basePort+3)
#
# Environment variables set:
#   - OTEL_EXPORTER_OTLP_ENDPOINT - points to the OTEL Collector HTTP endpoint
#   - OTEL_GRAFANA_URL - points to the Grafana UI
#
# OTEL compat layer:
#   This module anticipates devenv's future native OTEL support (cachix/devenv#2415).
#   The same OTEL_EXPORTER_OTLP_ENDPOINT env var will work with both this module
#   and devenv's native OTEL when it lands.
#
# Shell helpers:
#   - otel-span: emit OTLP trace spans from shell scripts (see otel-span --help)
#   - otel-trace: print the current Grafana/Tempo trace link
#
{
  # Fixed base port (null = derive from $DEVENV_ROOT hash)
  basePort ? null,
  # Port range for hash-based allocation (only used when basePort is null)
  portRangeStart ? 10000,
  portRangeEnd ? 60000,
  # Mode: "auto" detects system stack, "local" always uses local, "system" always uses system
  mode ? "auto",
  # Native devenv tracing owns shell activation when false. Task and process
  # observability remain available without adding work to every shell entry.
  traceShellEntry ? true,
  # Pre-compiled project-specific dashboards to provision alongside built-in ones.
  # Only used for local Grafana provisioning. OTEL_MODE=system uses the shared
  # stack and refreshes dashboards only when a compatible legacy otel CLI exists.
  # Each entry: { name = "my-project"; path = <nix-store-path-with-json-files>; }
  # Use lib.buildOtelDashboards to compile Jsonnet sources into the expected format.
  extraDashboards ? [ ],
}:
{
  pkgs,
  config,
  lib,
  ...
}:
let
  # Data directory for Tempo and Grafana state
  dataDir = "${config.devenv.root}/.devenv/otel";
  # Spool directory for otel-span file-based span delivery
  spoolDir = "${dataDir}/spool";

  # otel-span shell helper (standalone package with run + emit subcommands)
  otelSpan = import ./otel/otel-span.nix { inherit pkgs; };

  # otel-run: mint a fresh root trace around a command and print its Grafana
  # link (a thin, endpoint-resolving wrapper over `otel-span run`).
  otelRun = import ./otel/otel-run.nix { inherit pkgs; };

  # =========================================================================
  # Grafonnet: build dashboards from Jsonnet source at Nix eval time
  # =========================================================================

  # Built-in dashboards compiled via the shared build helper
  allDashboards = import ./otel/build-dashboards.nix {
    inherit pkgs;
    src = ./otel/dashboards;
    dashboardNames = [
      "overview"
      "devenv-tasks"
      "devenv-task-duration-trends"
      "shell-entry"
      "ts-app-traces"
    ];
  };

  # Grafana dashboard provisioning config
  grafanaDashboardProvision = pkgs.writeText "grafana-dashboards.yaml" (
    ''
      apiVersion: 1
      providers:
        - name: otel
          type: file
          disableDeletion: true
          updateIntervalSeconds: 0
          options:
            path: ${allDashboards}
    ''
    + builtins.concatStringsSep "" (
      map (group: ''
        - name: ${group.name}
          type: file
          disableDeletion: true
          updateIntervalSeconds: 0
          options:
            path: ${group.path}
      '') extraDashboards
    )
  );

  # =========================================================================
  # Port allocation: deterministic hash-based ports from DEVENV_ROOT
  # =========================================================================
  #
  # We need 6 consecutive ports:
  #   +0: OTEL Collector OTLP HTTP receiver (4318-equivalent)
  #   +1: Tempo OTLP gRPC ingest (for collector -> tempo)
  #   +2: Tempo HTTP query API (for Grafana -> tempo)
  #   +3: Grafana HTTP UI
  #   +4: OTEL Collector internal metrics (replaces default 8888)
  #   +5: Tempo internal gRPC (replaces default 9095)
  #
  # When basePort is null, we hash the devenv root path to get a deterministic
  # base in [portRangeStart, portRangeEnd-6]. Same worktree = same ports always.
  portRange = portRangeEnd - portRangeStart - 6;
  pathHash = builtins.hashString "sha256" config.devenv.root;
  # Convert hex char to int (0-15)
  hexCharToInt =
    c:
    let
      chars = [
        "0"
        "1"
        "2"
        "3"
        "4"
        "5"
        "6"
        "7"
        "8"
        "9"
        "a"
        "b"
        "c"
        "d"
        "e"
        "f"
      ];
      findIdx =
        i:
        if i >= 16 then
          0
        else if builtins.elemAt chars i == c then
          i
        else
          findIdx (i + 1);
    in
    findIdx 0;
  # Take first 7 hex chars -> convert to int -> mod into port range
  # (7 hex chars = max 268M, fits in Nix int; 8 might overflow on 32-bit)
  hexChars = lib.stringToCharacters (builtins.substring 0 7 pathHash);
  hashInt = lib.mod (builtins.foldl' (acc: c: acc * 16 + hexCharToInt c) 0 hexChars) portRange;
  derivedBasePort = portRangeStart + hashInt;
  effectiveBasePort = if basePort != null then basePort else derivedBasePort;

  otelCollectorPort = effectiveBasePort;
  tempoOtlpPort = effectiveBasePort + 1;
  tempoQueryPort = effectiveBasePort + 2;
  grafanaPort = effectiveBasePort + 3;
  otelMetricsPort = effectiveBasePort + 4;
  tempoInternalGrpcPort = effectiveBasePort + 5;

  # =========================================================================
  # Config files (generated at Nix eval time, written to /nix/store)
  # =========================================================================

  # OTEL Collector config: receives OTLP/HTTP, exports to Tempo via OTLP/gRPC
  otelCollectorConfig = pkgs.writeText "otel-collector-config.yaml" ''
    receivers:
      otlp:
        protocols:
          http:
            endpoint: "127.0.0.1:${toString otelCollectorPort}"
      otlpjsonfile:
        include:
          - "${spoolDir}/*.jsonl"
        start_at: beginning
        poll_interval: 500ms
        delete_after_read: true
        storage: file_storage/spool

    processors:
      batch:
        timeout: 1s
        send_batch_size: 128

    exporters:
      otlp:
        endpoint: "127.0.0.1:${toString tempoOtlpPort}"
        tls:
          insecure: true

    extensions:
      file_storage/spool:
        directory: ${dataDir}/spool-offsets

    service:
      extensions: [file_storage/spool]
      telemetry:
        metrics:
          readers:
            - pull:
                exporter:
                  prometheus:
                    host: "127.0.0.1"
                    port: ${toString otelMetricsPort}
      pipelines:
        traces:
          receivers: [otlp, otlpjsonfile]
          processors: [batch]
          exporters: [otlp]
  '';

  # Tempo config: receives from collector, stores to local filesystem
  tempoConfig = pkgs.writeText "tempo-config.yaml" ''
    server:
      http_listen_address: "127.0.0.1"
      http_listen_port: ${toString tempoQueryPort}
      grpc_listen_address: "127.0.0.1"
      grpc_listen_port: ${toString tempoInternalGrpcPort}

    distributor:
      receivers:
        otlp:
          protocols:
            grpc:
              endpoint: "127.0.0.1:${toString tempoOtlpPort}"

    # Optimized for low-scale local dev: prioritize search latency over throughput.
    # Traces become searchable in ~2-4s instead of the default 6-11s.
    ingester:
      # How often the ingester sweeps traces through the pipeline (default: 10s).
      # Primary bottleneck for search latency — reduced to match trace_idle_period.
      flush_check_period: 2s
      # Time after last span before a trace is flushed to WAL (default: 5s).
      # Lower means completed traces appear in WAL-based search sooner.
      trace_idle_period: 2s
      # Max time a trace stays in the head block before forced WAL flush (default: 30m).
      # Head block is searched synchronously, so this mainly affects WAL visibility.
      max_block_duration: 5m
      # Max head block size before cutting a new one (default: 500MB).
      # Keeps blocks small for faster search at low throughput.
      max_block_bytes: 10000000
      # How long completed blocks stay in the ingester before backend flush (default: 15m).
      # Shorter for dev since we don't need long ingester retention.
      complete_block_timeout: 5m

    memberlist:
      bind_addr:
        - "127.0.0.1"

    query_frontend:
      search:
        # Don't search the slow backend storage for traces newer than 30m (default: 15m).
        # Forces recent searches to use the fast ingester path only.
        query_backend_after: 30m

    storage:
      trace:
        backend: local
        local:
          path: ${dataDir}/tempo-data
        wal:
          path: ${dataDir}/tempo-wal
        # How often to poll backend for new blocks (default: 5m).
        # Faster discovery of flushed blocks for search.
        blocklist_poll: 30s

    compactor:
      compaction:
        block_retention: 72h

    metrics_generator:
      processor:
        local_blocks:
          # flush_to_storage: true is required for TraceQL metrics queries on historical data.
          # Without this, metrics queries only work on very recent in-memory data.
          flush_to_storage: true
          # Include all spans, not just server spans (default filters to server only)
          filter_server_spans: false
      storage:
        path: ${dataDir}/tempo-metrics
      traces_storage:
        path: ${dataDir}/tempo-data

    overrides:
      defaults:
        metrics_generator:
          processors:
            - local-blocks
  '';

  # Grafana provisioning: auto-configure Tempo as a datasource
  # Grafana datasource provisioning with stable UID.
  # The deleteDatasources + datasources pattern ensures the UID is always "tempo",
  # even if Grafana previously auto-generated a different one. On each startup,
  # Grafana deletes the old datasource by name+orgId, then re-creates it with our UID.
  grafanaDatasources = pkgs.writeText "grafana-datasources.yaml" ''
    apiVersion: 1
    deleteDatasources:
      - name: Tempo
        orgId: 1
    datasources:
      - name: Tempo
        uid: tempo
        type: tempo
        access: proxy
        url: http://127.0.0.1:${toString tempoQueryPort}
        isDefault: true
        editable: false
        jsonData:
          traceqlMetrics: true
  '';

  grafanaIni = pkgs.writeText "grafana.ini" ''
    [server]
    http_addr = 0.0.0.0
    http_port = ${toString grafanaPort}
    root_url = http://127.0.0.1:${toString grafanaPort}

    [paths]
    data = ${dataDir}/grafana-data
    logs = ${dataDir}/grafana-logs
    plugins = ${dataDir}/grafana-plugins
    provisioning = ${dataDir}/grafana-provisioning

    [auth.anonymous]
    enabled = true
    org_role = Admin

    [security]
    admin_user = admin
    admin_password = admin

    [analytics]
    reporting_enabled = false
    check_for_updates = false
    check_for_plugin_updates = false

    [log]
    mode = console
    level = warn

    [unified_alerting]
    enabled = false

    [alerting]
    enabled = false
  '';

  # otel-span is imported from ./otel/otel-span.nix above

  # Whether to include local OTEL infrastructure (collector, tempo, grafana processes)
  needsLocalInfra = mode != "system";

  otelResolveShellState = ''
    resolve_otel_shell_state() {
      if [ "$OTEL_MODE" = "auto" ]; then
        if [ -n "''${OTEL_STATE_DIR:-}" ]; then
          OTEL_MODE="system"
        else
          OTEL_MODE="local"
        fi
      fi

      if [ "$OTEL_MODE" = "system" ]; then
        if [ -z "''${OTEL_STATE_DIR:-}" ]; then
          echo "[otel] ERROR: OTEL_MODE=system requires OTEL_STATE_DIR" >&2
          return 1
        fi
        if [ -z "''${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ]; then
          echo "[otel] ERROR: OTEL_MODE=system requires OTEL_EXPORTER_OTLP_ENDPOINT" >&2
          return 1
        fi
        if [ -z "''${OTEL_GRAFANA_URL:-}" ]; then
          echo "[otel] ERROR: OTEL_MODE=system requires OTEL_GRAFANA_URL" >&2
          return 1
        fi
        if [ "${toString (builtins.length extraDashboards)}" -gt 0 ]; then
          echo "[otel] ERROR: extraDashboards is not supported in OTEL_MODE=system" >&2
          return 1
        fi
        _otel_project_name="$(${pkgs.coreutils}/bin/basename "''${DEVENV_ROOT:-devenv}")"
        if ! command -v otel >/dev/null 2>&1; then
          echo "[otel] WARN: legacy otel CLI unavailable; skipping system dashboard refresh" >&2
        elif otel dash sync --help >/dev/null 2>&1; then
          if ! otel dash sync \
            --source "${allDashboards}" \
            --target "$OTEL_STATE_DIR/dashboards" >/dev/null 2>&1; then
            echo "[otel] WARN: otel dash sync failed; continuing without refreshing dashboards" >&2
          fi
        elif otel dash restore --help >/dev/null 2>&1; then
          if ! otel dash restore \
            --project "$_otel_project_name" \
            --from "${allDashboards}" >/dev/null 2>&1; then
            echo "[otel] WARN: otel dash restore failed; continuing without refreshing dashboards" >&2
          fi
        else
          echo "[otel] WARN: otel CLI does not support dashboard restore/sync; continuing without refreshing dashboards" >&2
        fi
        _otel_mode_msg="[otel] Using system-level OTEL stack (mode=$OTEL_MODE)"
      else
        export OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:${toString otelCollectorPort}"
        export OTEL_GRAFANA_URL="http://127.0.0.1:${toString grafanaPort}"
        export OTEL_SPAN_SPOOL_DIR="${spoolDir}"
        _otel_mode_msg="[otel] Using local devenv OTEL stack (mode=$OTEL_MODE)"
      fi

      _otel_grafana="$OTEL_GRAFANA_URL"
      if [ -n "''${TS_HOSTNAME:-}" ]; then
        _otel_grafana="''${_otel_grafana//127.0.0.1/$TS_HOSTNAME}"
      fi
      if [ -n "''${TRACEPARENT:-}" ]; then
        IFS='-' read -r _ _otel_trace_id _ _ <<< "$TRACEPARENT"
        _panes='{"a":{"datasource":{"type":"tempo","uid":"tempo"},"queries":[{"refId":"A","datasource":{"type":"tempo","uid":"tempo"},"queryType":"traceql","query":"'"$_otel_trace_id"'"}],"range":{"from":"now-1h","to":"now"}}}'
        _encoded=$(printf '%s' "$_panes" | ${pkgs.gnused}/bin/sed 's/{/%7B/g;s/}/%7D/g;s/\[/%5B/g;s/\]/%5D/g;s/"/%22/g;s/:/%3A/g;s/,/%2C/g;s/ /%20/g')
        _otel_grafana_link_url="$_otel_grafana/explore?schemaVersion=1&panes=$_encoded&orgId=1"
      else
        unset _otel_trace_id
        _otel_grafana_link_url="$_otel_grafana"
      fi
      if [ -n "''${_otel_trace_id:-}" ]; then
        _otel_trace_label="trace:$_otel_trace_id"
      else
        _otel_trace_label="grafana"
      fi
      _otel_grafana_display="$(printf '\e]8;;%s\x07\e[4m%s\e[24m\e]8;;\x07' "$_otel_grafana_link_url" "$_otel_trace_label")"
      _otel_start_msg="[otel] Start with: devenv up | $_otel_grafana_display"
    }
  '';

  otelDetectShellEntryState = ''
    detect_otel_shell_entry_state() {
      # Detect cold vs warm start (setup-git-hash written by setup.nix)
      _cold_start="false"
      if [ ! -f .devenv/task-cache/setup-git-hash ]; then
        _cold_start="true"
      elif [ "$(git rev-parse HEAD 2>/dev/null || echo no-git)" != "$(cat .devenv/task-cache/setup-git-hash 2>/dev/null || echo "")" ]; then
        _cold_start="true"
      fi

      # Detect what triggered this shell reload by comparing watched file mtimes.
      # Uses devenv's input-paths.txt (nix inputs that affect the shell derivation),
      # excluding .devenv/bootstrap/ files which are regenerated on every eval.
      # Missing paths are tolerated here because input files can legitimately
      # disappear between eval and shell startup while the user is editing.
      _reload_trigger="unknown"
      _otel_mtime_snapshot=".devenv/otel-watch-mtimes"
      if [ -f ".devenv/input-paths.txt" ]; then
        _otel_current=$(
          while IFS= read -r _otel_path; do
            [ -n "$_otel_path" ] || continue
            [ -e "$_otel_path" ] || continue
            ${pkgs.coreutils}/bin/stat -c '%Y %n' "$_otel_path"
          done < <(${pkgs.gnugrep}/bin/grep -v '\.devenv/bootstrap/' .devenv/input-paths.txt) \
            | ${pkgs.coreutils}/bin/sort -k2
        )
        if [ ! -f "$_otel_mtime_snapshot" ]; then
          _reload_trigger="initial"
        elif [ "$_otel_current" = "$(${pkgs.coreutils}/bin/cat "$_otel_mtime_snapshot" 2>/dev/null)" ]; then
          _reload_trigger="env-change"
        else
          _otel_changed=$(
            (${pkgs.diffutils}/bin/diff <(${pkgs.coreutils}/bin/cat "$_otel_mtime_snapshot") <(echo "$_otel_current") 2>/dev/null || true) \
              | ${pkgs.gnugrep}/bin/grep '^[<>]' | ${pkgs.gawk}/bin/awk '{print $NF}' | ${pkgs.coreutils}/bin/sort -u \
              | ${pkgs.gnused}/bin/sed "s|^''${DEVENV_ROOT:-.}/||" \
              | ${pkgs.coreutils}/bin/head -5 | ${pkgs.coreutils}/bin/paste -sd ',' -
          )
          _reload_trigger="''${_otel_changed:-unknown}"
        fi
        ${pkgs.coreutils}/bin/mkdir -p .devenv
        echo "$_otel_current" > "$_otel_mtime_snapshot"
      fi
    }
  '';

  otelEmitShellEntry = ''
    emit_otel_shell_entry_span() {
      if { [ -z "''${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ] && { [ -z "''${OTEL_SPAN_SPOOL_DIR:-}" ] || [ ! -d "''${OTEL_SPAN_SPOOL_DIR:-}" ]; }; } \
        || [ -z "''${TRACEPARENT:-}" ] \
        || [ -z "''${OTEL_SHELL_ENTRY_NS:-}" ]; then
        return 0
      fi

      IFS='-' read -r _ _otel_shell_trace_id _otel_shell_root_span_id _ <<< "$TRACEPARENT"

      # Shell-root tracing must use the store path directly instead of relying
      # on PATH, because both shell hooks and early shell-entry tasks can run
      # before package PATH mutations are fully visible.
      _otel_span_bin="${otelSpan}/bin/otel-span"
      [ -x "$_otel_span_bin" ] || return 0

      # enterShell can run after traced setup tasks. If we let otel-span infer a
      # parent from the ambient TRACEPARENT/OTEL_TASK_TRACEPARENT here, the
      # shell root span can become self-parented or collide with later root
      # spans. Emit it from explicit shell IDs instead.
      (
        unset TRACEPARENT OTEL_TASK_TRACEPARENT
        "$_otel_span_bin" run "effect-utils-devenv" "devenv.shell.entry" \
          --trace-id "$_otel_shell_trace_id" \
          --span-id "$_otel_shell_root_span_id" \
          --start-time-ns "$OTEL_SHELL_ENTRY_NS" \
          --end-time-ns "$(${pkgs.coreutils}/bin/date +%s%N)" \
          --attr "tool.name=devenv" \
          --attr "cold_start=$_cold_start" \
          --attr "reload.trigger=$_reload_trigger" \
          --attr "span.label=shell" \
          -- true
      ) || true

      export TRACEPARENT="00-$_otel_shell_trace_id-$_otel_shell_root_span_id-01"
      unset OTEL_TASK_TRACEPARENT OTEL_SHELL_ENTRY_NS
    }
  '';

in
{
  packages = [
    otelSpan
    otelRun
  ]
  ++ lib.optionals needsLocalInfra [
    pkgs.opentelemetry-collector-contrib
    pkgs.tempo
    pkgs.grafana
  ];

  env.OTEL_MODE = mode;

  # OTEL shell state is resolved in a task so the same source of truth can
  # export env vars and emit the post-init shell message via devenv.messages.
  # The shell root span is emitted in a dedicated task after setup work, so
  # enterShell only consumes exported state and marks the interactive handoff.
  enterShell = lib.mkIf traceShellEntry (
    lib.mkAfter ''
      # `otel-trace` remains as a cheap on-demand way to reopen the current link,
      # but the user-visible shell-entry message now comes from `otel:shell-env`.
      otel_trace() {
        local _url="''${OTEL_GRAFANA_LINK_URL:-''${OTEL_GRAFANA_URL:-}}"
        if [ -z "$_url" ]; then
          echo "[otel] No OTEL grafana link available"
          return 1
        fi
        if [ -n "''${TRACEPARENT:-}" ]; then
          IFS='-' read -r _ _tid _ _ <<< "$TRACEPARENT"
          local _label="trace:$_tid"
          if [ -t 1 ]; then
            printf '\e]8;;%s\x07\e[4m%s\e[24m\e]8;;\x07\n' "$_url" "$_label"
          else
            echo "$_label $_url"
          fi
        else
          if [ -t 1 ]; then
            printf '\e]8;;%s\x07\e[4m%s\e[24m\e]8;;\x07\n' "$_url" "grafana"
          else
            echo "grafana $_url"
          fi
        fi
      }
      alias otel-trace=otel_trace

      # setup:gate seeds shell-root trace IDs for setup tasks. Clear the
      # task-scoped context markers before handing control to the interactive
      # shell so later task runs do not accidentally reuse shell bootstrap state.
      unset OTEL_TASK_TRACEPARENT OTEL_SHELL_ENTRY_NS

          # Mark the moment the shell becomes interactive (after all setup + OTEL work).
          # Consumed by shell-entry diagnostics.
          export SHELL_ENTRY_TIME_NS=$(date +%s%N)
    ''
  );

  # =========================================================================
  # Processes (started via `devenv up`)
  # =========================================================================

  # Process names include port for visibility in process-compose TUI
  # Processes are only defined when running in local mode (auto also needs them as fallback)
  processes = lib.mkIf needsLocalInfra {
    "otel-collector-${toString otelCollectorPort}" = {
      exec = ''
        mkdir -p ${spoolDir} ${dataDir}/spool-offsets
        exec ${pkgs.opentelemetry-collector-contrib}/bin/otelcol-contrib \
          --config ${otelCollectorConfig} \
          --feature-gates=filelog.allowFileDeletion
      '';
    };

    "tempo-${toString tempoQueryPort}" = {
      exec = ''
        mkdir -p ${dataDir}/tempo-data ${dataDir}/tempo-wal ${dataDir}/tempo-metrics
        exec ${pkgs.tempo}/bin/tempo \
          -config.file ${tempoConfig}
      '';
      # Auto-restart on WAL corruption: Tempo's /ready stays healthy even when
      # WAL files are missing, so we probe the search API which exercises the
      # storage path and returns 500 when the WAL is corrupt.
      # Auto-restart on WAL corruption: Tempo's /ready stays healthy even when
      # WAL files are missing, so we probe the search API which exercises the
      # storage path and returns 500 when the WAL is corrupt.
      # Readiness probe failures trigger restart via availability policy.
      process-compose = {
        readiness_probe = {
          exec.command = "${pkgs.curl}/bin/curl -sf http://127.0.0.1:${toString tempoQueryPort}/api/search/tag/service.name/values -o /dev/null";
          initial_delay_seconds = 15;
          period_seconds = 30;
          timeout_seconds = 5;
          success_threshold = 1;
          failure_threshold = 3;
        };
        availability = {
          restart = "always";
          backoff_seconds = 3;
          max_restarts = 10;
        };
      };
    };

    "grafana-${toString grafanaPort}" = {
      exec = ''
        mkdir -p ${dataDir}/grafana-data ${dataDir}/grafana-logs ${dataDir}/grafana-plugins
        mkdir -p ${dataDir}/grafana-provisioning/datasources ${dataDir}/grafana-provisioning/dashboards
        install -m 644 ${grafanaDatasources} ${dataDir}/grafana-provisioning/datasources/tempo.yaml
        install -m 644 ${grafanaDashboardProvision} ${dataDir}/grafana-provisioning/dashboards/otel.yaml
        exec ${pkgs.grafana}/bin/grafana server \
          --config ${grafanaIni} \
          --homepath ${pkgs.grafana}/share/grafana
      '';
    };
  };

  # =========================================================================
  # Tasks
  # =========================================================================

  tasks."otel:shell-env" = lib.mkIf traceShellEntry {
    description = "Resolve OTEL shell env and shell-entry message";
    exports = [
      "OTEL_MODE"
      "OTEL_EXPORTER_OTLP_ENDPOINT"
      "OTEL_GRAFANA_URL"
      "OTEL_SPAN_SPOOL_DIR"
      "OTEL_GRAFANA_LINK_URL"
    ];
    exec = ''
      set -euo pipefail
      ${otelResolveShellState}
      resolve_otel_shell_state

      ${pkgs.jq}/bin/jq -n \
        --arg mode "$OTEL_MODE" \
        --arg endpoint "''${OTEL_EXPORTER_OTLP_ENDPOINT:-}" \
        --arg grafanaUrl "''${OTEL_GRAFANA_URL:-}" \
        --arg spoolDir "''${OTEL_SPAN_SPOOL_DIR:-}" \
        --arg linkUrl "$_otel_grafana_link_url" \
        --arg modeMessage "$_otel_mode_msg" \
        --arg startMessage "$_otel_start_msg" \
        '{
          devenv: {
            env: (
              {
                OTEL_MODE: $mode,
                OTEL_GRAFANA_LINK_URL: $linkUrl
              }
              + (if $endpoint != "" then { OTEL_EXPORTER_OTLP_ENDPOINT: $endpoint } else {} end)
              + (if $grafanaUrl != "" then { OTEL_GRAFANA_URL: $grafanaUrl } else {} end)
              + (if $spoolDir != "" then { OTEL_SPAN_SPOOL_DIR: $spoolDir } else {} end)
            ),
            messages: [$modeMessage, $startMessage]
          }
        }' > "$DEVENV_TASK_OUTPUT_FILE"
    '';
    before = [ "devenv:enterShell" ];
    after = lib.optionals (builtins.hasAttr "setup:gate" config.tasks) [ "setup:gate" ];
  };

  tasks."otel:shell-entry" = lib.mkIf traceShellEntry {
    description = "Emit the shell-entry root trace span after setup completes";
    exec = ''
      set -euo pipefail
      ${otelDetectShellEntryState}
      ${otelEmitShellEntry}
      detect_otel_shell_entry_state || true
      emit_otel_shell_entry_span
    '';
    before = [ "devenv:enterShell" ];
    after =
      lib.optionals (builtins.hasAttr "devenv:files:cleanup" config.tasks) [ "devenv:files:cleanup" ]
      ++ lib.optionals (builtins.hasAttr "devenv:files" config.tasks) [ "devenv:files" ]
      ++ [ "otel:shell-env" ]
      ++ lib.optionals (builtins.hasAttr "setup:record-cache" config.tasks) [
        "setup:record-cache@completed"
      ]
      ++ lib.optionals (
        !(builtins.hasAttr "setup:record-cache" config.tasks) && builtins.hasAttr "setup:gate" config.tasks
      ) [ "setup:gate" ];
  };

  tasks."otel:test" = {
    description = "Run otel-span shell-level unit tests (offline, no devenv up needed)";
    exec = ''
      set -euo pipefail
      _pass=0
      _fail=0
      _tmp=$(mktemp -d)
      trap 'rm -rf "$_tmp"' EXIT

      # Force single-file spool mode for deterministic assertions in this test harness.
      # OTEL_SPOOL_MULTI_WRITER can be enabled globally in some environments, which
      # would write one file per span and break span file name assumptions.
      export OTEL_SPOOL_MULTI_WRITER=0

      # Keep a default endpoint for tests that intentionally exercise HTTP
      # fallback behavior; spool-only behavior is covered separately below.
      export OTEL_EXPORTER_OTLP_ENDPOINT="''${OTEL_EXPORTER_OTLP_ENDPOINT:-http://127.0.0.1:4318}"

      ${otelResolveShellState}
      ${otelDetectShellEntryState}
      ${otelEmitShellEntry}

      _check() {
        local name="$1"
        shift
        if "$@"; then
          echo "PASS: $name"
          _pass=$((_pass + 1))
        else
          echo "FAIL: $name"
          _fail=$((_fail + 1))
        fi
      }

      # Test 1: JSON format validation
      _test_json_format() {
        local spool="$_tmp/json-test"
        mkdir -p "$spool"
        OTEL_SPAN_SPOOL_DIR="$spool" otel-span run "test" "json-check" -- true >/dev/null 2>&1
        [ -f "$spool/spans.jsonl" ] || return 1
        local line
        line=$(head -1 "$spool/spans.jsonl")
        # Validate required OTLP fields
        echo "$line" | ${pkgs.jq}/bin/jq -e '.resourceSpans[0].scopeSpans[0].spans[0] | .traceId and .spanId and .name and .startTimeUnixNano and .endTimeUnixNano' >/dev/null 2>&1
      }
      _check "JSON format" _test_json_format

      # Test 2: attribute types (bools stay bools)
      _test_attr_types() {
        local spool="$_tmp/attr-type"
        mkdir -p "$spool"
        OTEL_SPAN_SPOOL_DIR="$spool" OTEL_SPOOL_MULTI_WRITER=0 otel-span run "test" "attr-type" \
          --attr "task.cached=false" --attr "cache.mode=fast" -- true >/dev/null 2>&1
        local line
        line=$(head -1 "$spool/spans.jsonl")
        local bool_val string_val
        bool_val=$(echo "$line" | ${pkgs.jq}/bin/jq -r '.resourceSpans[0].scopeSpans[0].spans[0].attributes[] | select(.key=="task.cached").value.boolValue')
        string_val=$(echo "$line" | ${pkgs.jq}/bin/jq -r '.resourceSpans[0].scopeSpans[0].spans[0].attributes[] | select(.key=="cache.mode").value.stringValue')
        [ "$bool_val" = "false" ] && [ "$string_val" = "fast" ]
      }
      _check "Attribute type handling" _test_attr_types

      # Test 3: emit-span supports typed measurement spans without a command.
      _test_emit_span_typed_attrs() {
        local spool="$_tmp/emit-span-typed"
        mkdir -p "$spool"
        OTEL_SPAN_SPOOL_DIR="$spool" OTEL_SPOOL_MULTI_WRITER=0 otel-span emit-span "effect-utils-devenv" "typescript.project.check" \
          --trace-id "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
          --span-id "bbbbbbbbbbbbbbbb" \
          --parent-span-id "cccccccccccccccc" \
          --start-time-ns "1000000000" \
          --end-time-ns "1339000000" \
          --scope-name "typescript-diagnostics" \
          --attr-string "span.label=demo" \
          --attr-string "tool.name=typescript" \
          --attr-string "compiler.name=tsgo" \
          --attr-double "typescript.total_time_s=0.339" \
          --attr-int "typescript.files=42" \
          --attr-bool "typescript.aggregate=false" >/dev/null 2>&1
        [ -f "$spool/spans.jsonl" ] || return 1
        local line
        line=$(head -1 "$spool/spans.jsonl")
        echo "$line" | ${pkgs.jq}/bin/jq -e '
          .resourceSpans[0].resource.attributes[] | select(.key == "service.name").value.stringValue == "effect-utils-devenv"
        ' >/dev/null || return 1
        echo "$line" | ${pkgs.jq}/bin/jq -e '
          .resourceSpans[0].scopeSpans[0].scope.name == "typescript-diagnostics"
          and .resourceSpans[0].scopeSpans[0].spans[0].name == "typescript.project.check"
          and .resourceSpans[0].scopeSpans[0].spans[0].parentSpanId == "cccccccccccccccc"
          and (.resourceSpans[0].scopeSpans[0].spans[0].attributes[] | select(.key == "span.label").value.stringValue) == "demo"
          and (.resourceSpans[0].scopeSpans[0].spans[0].attributes[] | select(.key == "tool.name").value.stringValue) == "typescript"
          and (.resourceSpans[0].scopeSpans[0].spans[0].attributes[] | select(.key == "compiler.name").value.stringValue) == "tsgo"
          and (.resourceSpans[0].scopeSpans[0].spans[0].attributes[] | select(.key == "typescript.total_time_s").value.doubleValue) == 0.339
          and (.resourceSpans[0].scopeSpans[0].spans[0].attributes[] | select(.key == "typescript.files").value.intValue) == "42"
          and (.resourceSpans[0].scopeSpans[0].spans[0].attributes[] | select(.key == "typescript.aggregate").value.boolValue) == false
          and ([.resourceSpans[0].scopeSpans[0].spans[0].attributes[] | select(.key == "service.name")] | length) == 0
        ' >/dev/null
      }
      _check "emit-span typed attrs" _test_emit_span_typed_attrs

      # Test 3: local shell state resolution exports the local stack and a trace link
      _test_shell_state_local() {
        (
          export OTEL_MODE="local"
          export TRACEPARENT="00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01"
          export TS_HOSTNAME="ts.example.test"
          unset OTEL_GRAFANA_URL OTEL_EXPORTER_OTLP_ENDPOINT OTEL_SPAN_SPOOL_DIR
          resolve_otel_shell_state
          [ "$OTEL_EXPORTER_OTLP_ENDPOINT" = "http://127.0.0.1:${toString otelCollectorPort}" ] || return 1
          [ "$OTEL_GRAFANA_URL" = "http://127.0.0.1:${toString grafanaPort}" ] || return 1
          [ "$OTEL_SPAN_SPOOL_DIR" = "${spoolDir}" ] || return 1
          echo "$_otel_grafana_link_url" | grep -q 'ts.example.test' || return 1
          echo "$_otel_start_msg" | grep -q 'trace:' || return 1
        )
      }
      _check "Shell state resolution (local)" _test_shell_state_local

      # Test 4: system shell state requires an explicit Grafana URL
      _test_shell_state_system_requires_grafana() {
        (
          export OTEL_MODE="system"
          export OTEL_STATE_DIR="$_tmp/system-state"
          export OTEL_EXPORTER_OTLP_ENDPOINT="http://collector.example:4318"
          unset OTEL_GRAFANA_URL OTEL_SPAN_SPOOL_DIR
          otel() { return 0; }
          ! resolve_otel_shell_state >/dev/null 2>&1
        )
      }
      _check "Shell state resolution (system requires Grafana URL)" _test_shell_state_system_requires_grafana

      # Test 5: system shell state does not require the retired legacy otel CLI.
      _test_shell_state_system_without_legacy_otel_cli() {
        (
          export OTEL_MODE="system"
          export OTEL_STATE_DIR="$_tmp/system-state"
          export OTEL_EXPORTER_OTLP_ENDPOINT="http://collector.example:4318"
          export OTEL_GRAFANA_URL="http://grafana.example"
          unset OTEL_SPAN_SPOOL_DIR
          export PATH="/nonexistent"
          resolve_otel_shell_state
          [ "$OTEL_MODE" = "system" ] || return 1
          [ "$OTEL_GRAFANA_URL" = "http://grafana.example" ] || return 1
          [ -z "''${OTEL_SPAN_SPOOL_DIR:-}" ] || return 1
        )
      }
      _check "Shell state resolution (system without legacy otel CLI)" _test_shell_state_system_without_legacy_otel_cli

      # Test 6: shell entry emission uses explicit shell IDs and ignores ambient parents
      _test_shell_entry_root_span() {
        local spool="$_tmp/shell-entry-root"
        mkdir -p "$spool"
        (
          export OTEL_SPAN_SPOOL_DIR="$spool"
          export TRACEPARENT="00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01"
          export OTEL_SHELL_ENTRY_NS="1234567890000000000"
          export OTEL_TASK_TRACEPARENT="00-feedfacefeedfacefeedfacefeedface-2222222222222222-01"
          _cold_start="false"
          _reload_trigger="initial"

          emit_otel_shell_entry_span

          [ "$TRACEPARENT" = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01" ] || return 1
          [ -z "''${OTEL_TASK_TRACEPARENT:-}" ] || return 1
          [ -z "''${OTEL_SHELL_ENTRY_NS:-}" ] || return 1
        )

        [ -f "$spool/spans.jsonl" ] || return 1

        local line actual_trace actual_span has_parent
        line=$(head -1 "$spool/spans.jsonl")
        actual_trace=$(echo "$line" | ${pkgs.jq}/bin/jq -r '.resourceSpans[0].scopeSpans[0].spans[0].traceId')
        actual_span=$(echo "$line" | ${pkgs.jq}/bin/jq -r '.resourceSpans[0].scopeSpans[0].spans[0].spanId')
        has_parent=$(echo "$line" | ${pkgs.jq}/bin/jq -r '.resourceSpans[0].scopeSpans[0].spans[0] | has("parentSpanId")')

        [ "$actual_trace" = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" ] \
          && [ "$actual_span" = "bbbbbbbbbbbbbbbb" ] \
          && [ "$has_parent" = "false" ]
      }
      _check "devenv.shell.entry root span emission" _test_shell_entry_root_span

      # Test 7: shell entry emission works with spool-only delivery.
      _test_shell_entry_root_span_spool_only() {
        local spool="$_tmp/shell-entry-spool-only"
        mkdir -p "$spool"
        (
          export OTEL_SPAN_SPOOL_DIR="$spool"
          unset OTEL_EXPORTER_OTLP_ENDPOINT
          export TRACEPARENT="00-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-ffffffffffffffff-01"
          export OTEL_SHELL_ENTRY_NS="1234567890000000002"
          _cold_start="false"
          _reload_trigger="spool-only"

          emit_otel_shell_entry_span

          [ "$TRACEPARENT" = "00-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-ffffffffffffffff-01" ] || return 1
          [ -z "''${OTEL_SHELL_ENTRY_NS:-}" ] || return 1
        )

        [ -f "$spool/spans.jsonl" ] || return 1

        local line actual_trace actual_span service
        line=$(head -1 "$spool/spans.jsonl")
        actual_trace=$(echo "$line" | ${pkgs.jq}/bin/jq -r '.resourceSpans[0].scopeSpans[0].spans[0].traceId')
        actual_span=$(echo "$line" | ${pkgs.jq}/bin/jq -r '.resourceSpans[0].scopeSpans[0].spans[0].spanId')
        service=$(echo "$line" | ${pkgs.jq}/bin/jq -r '.resourceSpans[0].resource.attributes[] | select(.key == "service.name").value.stringValue')

        [ "$actual_trace" = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" ] \
          && [ "$actual_span" = "ffffffffffffffff" ] \
          && [ "$service" = "effect-utils-devenv" ]
      }
      _check "devenv.shell.entry spool-only emission" _test_shell_entry_root_span_spool_only

      # Test 8: shell entry emission must not depend on PATH already containing
      # otel-span because enterShell can run before package PATH setup settles.
      _test_shell_entry_root_span_without_path() {
        local spool="$_tmp/shell-entry-no-path"
        mkdir -p "$spool"
        (
          export OTEL_SPAN_SPOOL_DIR="$spool"
          export OTEL_EXPORTER_OTLP_ENDPOINT="http://collector.example:4318"
          export TRACEPARENT="00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01"
          export OTEL_SHELL_ENTRY_NS="1234567890000000001"
          export PATH="/nonexistent"
          _cold_start="false"
          _reload_trigger="env-change"

          emit_otel_shell_entry_span

          [ "$TRACEPARENT" = "00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01" ] || return 1
          [ -z "''${OTEL_SHELL_ENTRY_NS:-}" ] || return 1
        )

        [ -f "$spool/spans.jsonl" ] || return 1

        local line actual_trace actual_span has_parent
        line=$(head -1 "$spool/spans.jsonl")
        actual_trace=$(echo "$line" | ${pkgs.jq}/bin/jq -r '.resourceSpans[0].scopeSpans[0].spans[0].traceId')
        actual_span=$(echo "$line" | ${pkgs.jq}/bin/jq -r '.resourceSpans[0].scopeSpans[0].spans[0].spanId')
        has_parent=$(echo "$line" | ${pkgs.jq}/bin/jq -r '.resourceSpans[0].scopeSpans[0].spans[0] | has("parentSpanId")')

        [ "$actual_trace" = "cccccccccccccccccccccccccccccccc" ] \
          && [ "$actual_span" = "dddddddddddddddd" ] \
          && [ "$has_parent" = "false" ]
      }
      _check "devenv.shell.entry root span emission without PATH" _test_shell_entry_root_span_without_path

      # Test 9: reload-trigger detection uses pinned binaries instead of
      # ambient PATH, so the shell-entry task works before GNU tools are added.
      _test_shell_entry_state_without_path() {
        local workdir="$_tmp/shell-entry-state-no-path"
        mkdir -p "$workdir/.devenv"
        echo "$workdir/foo.nix" > "$workdir/.devenv/input-paths.txt"
        echo "x = 1;" > "$workdir/foo.nix"

        (
          cd "$workdir"
          export PATH="/nonexistent"
          detect_otel_shell_entry_state
          [ "$_cold_start" = "true" ] || return 1
          [ "$_reload_trigger" = "initial" ] || return 1
          [ -f ".devenv/otel-watch-mtimes" ] || return 1
        )
      }
      _check "shell-entry state detection without PATH" _test_shell_entry_state_without_path

      # Test 10: reload-trigger detection tolerates input paths that disappear
      # between eval and shell startup instead of failing the shell-entry task.
      _test_shell_entry_state_missing_paths() {
        local workdir="$_tmp/shell-entry-state-missing-paths"
        mkdir -p "$workdir/.devenv"
        echo "$workdir/foo.nix" > "$workdir/.devenv/input-paths.txt"
        echo "$workdir/missing.nix" >> "$workdir/.devenv/input-paths.txt"
        echo "x = 1;" > "$workdir/foo.nix"

        (
          cd "$workdir"
          export PATH="/nonexistent"
          detect_otel_shell_entry_state
          [ "$_reload_trigger" = "initial" ] || return 1
          [ -f ".devenv/otel-watch-mtimes" ] || return 1
        )
      }
      _check "shell-entry state detection with missing paths" _test_shell_entry_state_missing_paths

      # Test 11: TRACEPARENT propagation
      _test_traceparent() {
        local spool="$_tmp/tp-test"
        mkdir -p "$spool"
        local child_tp
        child_tp=$(OTEL_SPAN_SPOOL_DIR="$spool" otel-span run "test" "parent" -- bash -c 'echo $TRACEPARENT' 2>/dev/null)
        # Must match W3C format: 00-{32hex}-{16hex}-01
        [[ "$child_tp" =~ ^00-[0-9a-f]{32}-[0-9a-f]{16}-01$ ]] || return 1
        # Trace ID in child must match the span's trace ID in the spool file
        local span_trace
        span_trace=$(head -1 "$spool/spans.jsonl" | ${pkgs.jq}/bin/jq -r '.resourceSpans[0].scopeSpans[0].spans[0].traceId')
        local child_trace
        child_trace=$(echo "$child_tp" | cut -d- -f2)
        [ "$span_trace" = "$child_trace" ]
      }
      _check "TRACEPARENT propagation" _test_traceparent

      # Test 10: Spool fallback (nonexistent dir)
      _test_spool_fallback() {
        # With nonexistent spool dir, should still succeed (falls back to curl which may fail silently)
        OTEL_SPAN_SPOOL_DIR="/nonexistent" OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:1" otel-span run "test" "fallback" -- true >/dev/null 2>&1
      }
      _check "Spool fallback" _test_spool_fallback

      # Test 11: Spool file write
      _test_spool_write() {
        local spool="$_tmp/write-test"
        mkdir -p "$spool"
        OTEL_SPAN_SPOOL_DIR="$spool" otel-span run "test" "write-check" -- true >/dev/null 2>&1
        [ -f "$spool/spans.jsonl" ] || return 1
        local lines
        lines=$(wc -l < "$spool/spans.jsonl")
        [ "$lines" -eq 1 ]
      }
      _check "Spool write" _test_spool_write

      # Test 9: --span-id override
      _test_span_id_override() {
        local spool="$_tmp/spanid-test"
        mkdir -p "$spool"
        OTEL_SPAN_SPOOL_DIR="$spool" otel-span run "test" "spanid-check" --span-id "abcdef0123456789" -- true >/dev/null 2>&1
        [ -f "$spool/spans.jsonl" ] || return 1
        local actual
        actual=$(head -1 "$spool/spans.jsonl" | ${pkgs.jq}/bin/jq -r '.resourceSpans[0].scopeSpans[0].spans[0].spanId')
        [ "$actual" = "abcdef0123456789" ]
      }
      _check "--span-id override" _test_span_id_override

      # Test 10: --start-time-ns override
      _test_start_time_override() {
        local spool="$_tmp/startns-test"
        mkdir -p "$spool"
        OTEL_SPAN_SPOOL_DIR="$spool" otel-span run "test" "startns-check" --start-time-ns "1234567890000000000" -- true >/dev/null 2>&1
        [ -f "$spool/spans.jsonl" ] || return 1
        local actual
        actual=$(head -1 "$spool/spans.jsonl" | ${pkgs.jq}/bin/jq -r '.resourceSpans[0].scopeSpans[0].spans[0].startTimeUnixNano')
        [ "$actual" = "1234567890000000000" ]
      }
      _check "--start-time-ns override" _test_start_time_override

      # Test 11: --end-time-ns override
      _test_end_time_override() {
        local spool="$_tmp/endns-test"
        mkdir -p "$spool"
        OTEL_SPAN_SPOOL_DIR="$spool" otel-span run "test" "endns-check" --end-time-ns "9999999999999999999" -- true >/dev/null 2>&1
        [ -f "$spool/spans.jsonl" ] || return 1
        local actual
        actual=$(head -1 "$spool/spans.jsonl" | ${pkgs.jq}/bin/jq -r '.resourceSpans[0].scopeSpans[0].spans[0].endTimeUnixNano')
        [ "$actual" = "9999999999999999999" ]
      }
      _check "--end-time-ns override" _test_end_time_override

      # Test 12: --log-url outputs Grafana trace URL to stderr
      _test_log_url() {
        local spool="$_tmp/logurl-test"
        mkdir -p "$spool"
        local stderr_output
        stderr_output=$(OTEL_SPAN_SPOOL_DIR="$spool" OTEL_GRAFANA_URL="http://localhost:3000" otel-span run "test" "url-check" --log-url -- true 2>&1 1>/dev/null)
        # Must contain [otel] Trace: prefix
        echo "$stderr_output" | grep -Eq '\[otel\] trace:|\[otel\] Trace:' || return 1
        # Must contain the Grafana explore URL
        echo "$stderr_output" | grep -q 'localhost:3000/explore' || return 1
        # Must contain the trace ID from the span
        local trace_id
        trace_id=$(head -1 "$spool/spans.jsonl" | ${pkgs.jq}/bin/jq -r '.resourceSpans[0].scopeSpans[0].spans[0].traceId')
        echo "$stderr_output" | grep -q "$trace_id" || return 1
      }
      _check "--log-url output" _test_log_url

      # Test 13: No trace context produces root span (no parentSpanId)
      _test_no_traceparent_root() {
        local spool="$_tmp/root-test"
        mkdir -p "$spool"
        (
          unset TRACEPARENT OTEL_TASK_TRACEPARENT
          OTEL_SPAN_SPOOL_DIR="$spool" otel-span run "test" "root-check" -- true >/dev/null 2>&1
        )
        [ -f "$spool/spans.jsonl" ] || return 1
        # parentSpanId must be absent (not an orphaned reference)
        local has_parent
        has_parent=$(head -1 "$spool/spans.jsonl" | ${pkgs.jq}/bin/jq '.resourceSpans[0].scopeSpans[0].spans[0] | has("parentSpanId")')
        [ "$has_parent" = "false" ]
      }
      _check "No trace context = root span" _test_no_traceparent_root

      # Test 14: OTEL_TASK_TRACEPARENT takes precedence over TRACEPARENT
      _test_task_traceparent_precedence() {
        local spool="$_tmp/task-tp-test"
        mkdir -p "$spool"
        local task_trace="aaaaaaaabbbbbbbbccccccccdddddddd"
        local task_parent="1111111122222222"
        local stale_trace="eeeeeeeeffffffff0000000011111111"
        local stale_parent="3333333344444444"
        (
          export OTEL_TASK_TRACEPARENT="00-$task_trace-$task_parent-01"
          export TRACEPARENT="00-$stale_trace-$stale_parent-01"
          OTEL_SPAN_SPOOL_DIR="$spool" otel-span run "test" "tp-pref" -- true >/dev/null 2>&1
        )
        [ -f "$spool/spans.jsonl" ] || return 1
        local actual_trace actual_parent
        actual_trace=$(head -1 "$spool/spans.jsonl" | ${pkgs.jq}/bin/jq -r '.resourceSpans[0].scopeSpans[0].spans[0].traceId')
        actual_parent=$(head -1 "$spool/spans.jsonl" | ${pkgs.jq}/bin/jq -r '.resourceSpans[0].scopeSpans[0].spans[0].parentSpanId')
        [ "$actual_trace" = "$task_trace" ] && [ "$actual_parent" = "$task_parent" ]
      }
      _check "OTEL_TASK_TRACEPARENT precedence" _test_task_traceparent_precedence

      # Test 15: --status-attr derives bool from exit code (cached case, exit 0)
      _test_status_attr_cached() {
        local spool="$_tmp/status-cached"
        mkdir -p "$spool"
        OTEL_SPAN_SPOOL_DIR="$spool" otel-span run "test" "status-cached" \
          --status-attr "task.cached" -- true >/dev/null 2>&1
        [ -f "$spool/spans.jsonl" ] || return 1
        local line
        line=$(head -1 "$spool/spans.jsonl")
        # task.cached should be true (exit 0)
        local cached_val
        cached_val=$(echo "$line" | ${pkgs.jq}/bin/jq -r '.resourceSpans[0].scopeSpans[0].spans[0].attributes[] | select(.key=="task.cached").value.boolValue')
        [ "$cached_val" = "true" ] || return 1
        # Span status should be OK (code 1) despite any exit code
        local status_code
        status_code=$(echo "$line" | ${pkgs.jq}/bin/jq -r '.resourceSpans[0].scopeSpans[0].spans[0].status.code')
        [ "$status_code" = "1" ]
      }
      _check "--status-attr cached (exit 0)" _test_status_attr_cached

      # Test 16: --status-attr derives bool from exit code (uncached case, exit 1)
      _test_status_attr_uncached() {
        local spool="$_tmp/status-uncached"
        mkdir -p "$spool"
        OTEL_SPAN_SPOOL_DIR="$spool" otel-span run "test" "status-uncached" \
          --status-attr "task.cached" -- bash -c 'exit 1' >/dev/null 2>&1 || true
        [ -f "$spool/spans.jsonl" ] || return 1
        local line
        line=$(head -1 "$spool/spans.jsonl")
        # task.cached should be false (exit 1)
        local cached_val
        cached_val=$(echo "$line" | ${pkgs.jq}/bin/jq -r '.resourceSpans[0].scopeSpans[0].spans[0].attributes[] | select(.key=="task.cached").value.boolValue')
        [ "$cached_val" = "false" ] || return 1
        # Span status should still be OK (code 1) — status checks aren't errors
        local status_code
        status_code=$(echo "$line" | ${pkgs.jq}/bin/jq -r '.resourceSpans[0].scopeSpans[0].spans[0].status.code')
        [ "$status_code" = "1" ]
      }
      _check "--status-attr uncached (exit 1)" _test_status_attr_uncached

      # Test 17: --status-attr propagates TRACEPARENT to child (sub-traces)
      _test_status_attr_subtrace() {
        local spool="$_tmp/status-subtrace"
        mkdir -p "$spool"
        local child_tp
        child_tp=$(OTEL_SPAN_SPOOL_DIR="$spool" otel-span run "test" "status-parent" \
          --status-attr "task.cached" -- bash -c 'echo $TRACEPARENT' 2>/dev/null)
        # Child must have TRACEPARENT (enabling sub-traces)
        [[ "$child_tp" =~ ^00-[0-9a-f]{32}-[0-9a-f]{16}-01$ ]] || return 1
        # Trace ID in child must match the span
        local span_trace
        span_trace=$(head -1 "$spool/spans.jsonl" | ${pkgs.jq}/bin/jq -r '.resourceSpans[0].scopeSpans[0].spans[0].traceId')
        local child_trace
        child_trace=$(echo "$child_tp" | cut -d- -f2)
        [ "$span_trace" = "$child_trace" ]
      }
      _check "--status-attr sub-trace propagation" _test_status_attr_subtrace

      # Test 18: otel-span exports OTEL_TASK_TRACEPARENT to child processes
      _test_task_traceparent_export() {
        local spool="$_tmp/task-tp-export"
        mkdir -p "$spool"
        local child_task_tp
        child_task_tp=$(
          unset TRACEPARENT OTEL_TASK_TRACEPARENT
          OTEL_SPAN_SPOOL_DIR="$spool" otel-span run "test" "tp-export" -- bash -c 'echo $OTEL_TASK_TRACEPARENT' 2>/dev/null
        )
        [[ "$child_task_tp" =~ ^00-[0-9a-f]{32}-[0-9a-f]{16}-01$ ]] || return 1
        # Must match the span's own trace ID
        local span_trace
        span_trace=$(head -1 "$spool/spans.jsonl" | ${pkgs.jq}/bin/jq -r '.resourceSpans[0].scopeSpans[0].spans[0].traceId')
        local child_trace
        child_trace=$(echo "$child_task_tp" | cut -d- -f2)
        [ "$span_trace" = "$child_trace" ]
      }
      _check "OTEL_TASK_TRACEPARENT export" _test_task_traceparent_export

      echo ""
      echo "$_pass passed, $_fail failed"
      [ "$_fail" -eq 0 ]
    '';
  };

  tasks."otel:test:trace-structure" = {
    description = "Validate trace structure invariants from spool file data (offline)";
    exec = ''
      set -euo pipefail
      _pass=0
      _fail=0
      _tmp=$(mktemp -d)
      trap 'rm -rf "$_tmp"' EXIT

      # otel-span disables file-spooling when OTEL_EXPORTER_OTLP_ENDPOINT is unset,
      # so always provide a local default for these offline assertions.
      export OTEL_EXPORTER_OTLP_ENDPOINT="''${OTEL_EXPORTER_OTLP_ENDPOINT:-http://127.0.0.1:4318}"

      # Force single-file spool mode for deterministic assertions in this task.
      # OTEL_SPOOL_MULTI_WRITER can be enabled globally in some environments.
      export OTEL_SPOOL_MULTI_WRITER=0

      _check() {
        local name="$1"
        shift
        if "$@"; then
          echo "PASS: $name"
          _pass=$((_pass + 1))
        else
          echo "FAIL: $name"
          _fail=$((_fail + 1))
        fi
      }

      # Helper functions for span field extraction, count, IDs
      _span_field() {
        local file="$1" line_num="$2" field="$3"
        ${pkgs.gawk}/bin/awk "NR==$line_num" "$file" | ${pkgs.jq}/bin/jq -r ".resourceSpans[0].scopeSpans[0].spans[0].$field"
      }
      _span_count() {
        local file="$1"
        wc -l < "$file" | tr -d ' '
      }
      _all_span_ids() {
        local file="$1"
        ${pkgs.jq}/bin/jq -r '.resourceSpans[0].scopeSpans[0].spans[0].spanId' "$file"
      }
      _all_parent_ids() {
        local file="$1"
        ${pkgs.jq}/bin/jq -r '.resourceSpans[0].scopeSpans[0].spans[0].parentSpanId // ""' "$file"
      }

      # Generate 5-span trace tree with explicit IDs
      _spool="$_tmp/trace-struct"
      mkdir -p "$_spool"
      _trace_id="aabbccdd11223344aabbccdd11223344"

      # Root span (no parent)
      (unset TRACEPARENT OTEL_TASK_TRACEPARENT; OTEL_SPAN_SPOOL_DIR="$_spool" otel-span run "effect-utils-devenv" "devenv.shell.entry" --trace-id "$_trace_id" --span-id "0000000000000001" --start-time-ns "1000000000000000" --end-time-ns "11000000000000000" --attr "tool.name=devenv" --attr "span.label=shell" -- true >/dev/null 2>&1)

      # Child 1 of root
      OTEL_SPAN_SPOOL_DIR="$_spool" otel-span run "effect-utils-devenv" "devenv.task.exec" --trace-id "$_trace_id" --span-id "0000000000000002" --parent-span-id "0000000000000001" --start-time-ns "1100000000000000" --end-time-ns "6000000000000000" --attr "tool.name=devenv" --attr "task.name=ts:check" --attr "task.phase=exec" --attr "task.cached=false" --attr "span.label=ts:check" -- true >/dev/null 2>&1

      # Grandchild 1 of child 1
      OTEL_SPAN_SPOOL_DIR="$_spool" otel-span emit-span "effect-utils-devenv" "typescript.project.check" --trace-id "$_trace_id" --span-id "0000000000000003" --parent-span-id "0000000000000002" --start-time-ns "1200000000000000" --end-time-ns "4000000000000000" --attr-string "tool.name=typescript" --attr-string "ts.project.name=utils" --attr-string "span.label=utils" >/dev/null 2>&1

      # Grandchild 2 of child 1
      OTEL_SPAN_SPOOL_DIR="$_spool" otel-span emit-span "effect-utils-devenv" "typescript.project.check" --trace-id "$_trace_id" --span-id "0000000000000004" --parent-span-id "0000000000000002" --start-time-ns "4100000000000000" --end-time-ns "5800000000000000" --attr-string "tool.name=typescript" --attr-string "ts.project.name=core" --attr-string "span.label=core" >/dev/null 2>&1

      # Child 2 of root
      OTEL_SPAN_SPOOL_DIR="$_spool" otel-span run "effect-utils-devenv" "devenv.task.exec" --trace-id "$_trace_id" --span-id "0000000000000005" --parent-span-id "0000000000000001" --start-time-ns "1200000000000000" --end-time-ns "4000000000000000" --attr "tool.name=devenv" --attr "task.name=lint:check" --attr "task.phase=exec" --attr "task.cached=false" --attr "span.label=lint:check" -- true >/dev/null 2>&1

      _sf="$_spool/spans.jsonl"

      # Test 1: correct span count
      _test_span_count() {
        [ "$(_span_count "$_sf")" -eq 5 ]
      }
      _check "5 spans emitted" _test_span_count

      # Test 2: all spans share the same traceId
      _test_same_trace_id() {
        local unique
        unique=$(_all_span_ids "$_sf" | wc -l)
        local trace_ids
        trace_ids=$(${pkgs.jq}/bin/jq -r '.resourceSpans[0].scopeSpans[0].spans[0].traceId' "$_sf" | sort -u | wc -l)
        [ "$trace_ids" -eq 1 ]
      }
      _check "all spans share traceId" _test_same_trace_id

      # Test 3: exactly one root span (no parentSpanId)
      _test_single_root() {
        local roots
        roots=$(${pkgs.jq}/bin/jq -r 'if .resourceSpans[0].scopeSpans[0].spans[0] | has("parentSpanId") then "child" else "root" end' "$_sf" | grep -c "root")
        [ "$roots" -eq 1 ]
      }
      _check "single root span" _test_single_root

      # Test 4: no orphan spans (every parentSpanId references an existing spanId)
      _test_no_orphans() {
        local span_ids parent_ids
        span_ids=$(_all_span_ids "$_sf")
        parent_ids=$(_all_parent_ids "$_sf" | grep -v '^$' || true)
        while IFS= read -r pid; do
          echo "$span_ids" | grep -qF "$pid" || return 1
        done <<< "$parent_ids"
        return 0
      }
      _check "no orphan spans" _test_no_orphans

      # Test 5: root span encloses all children (timing)
      _test_root_timing() {
        local root_start root_end
        root_start=$(_span_field "$_sf" 1 "startTimeUnixNano")
        root_end=$(_span_field "$_sf" 1 "endTimeUnixNano")
        for i in 2 3 4 5; do
          local s e
          s=$(_span_field "$_sf" "$i" "startTimeUnixNano")
          e=$(_span_field "$_sf" "$i" "endTimeUnixNano")
          [ "$s" -ge "$root_start" ] || return 1
          [ "$e" -le "$root_end" ] || return 1
        done
        return 0
      }
      _check "root encloses all children" _test_root_timing

      # Test 6: parent-child timing (child within parent)
      _test_parent_child_timing() {
        # child 1 (line 2, parent=line 1)
        local p_start p_end c_start c_end
        p_start=$(_span_field "$_sf" 1 "startTimeUnixNano")
        p_end=$(_span_field "$_sf" 1 "endTimeUnixNano")
        c_start=$(_span_field "$_sf" 2 "startTimeUnixNano")
        c_end=$(_span_field "$_sf" 2 "endTimeUnixNano")
        [ "$c_start" -ge "$p_start" ] && [ "$c_end" -le "$p_end" ] || return 1
        # grandchild 1 (line 3, parent=line 2)
        p_start=$(_span_field "$_sf" 2 "startTimeUnixNano")
        p_end=$(_span_field "$_sf" 2 "endTimeUnixNano")
        c_start=$(_span_field "$_sf" 3 "startTimeUnixNano")
        c_end=$(_span_field "$_sf" 3 "endTimeUnixNano")
        [ "$c_start" -ge "$p_start" ] && [ "$c_end" -le "$p_end" ] || return 1
        return 0
      }
      _check "parent-child timing valid" _test_parent_child_timing

      # Test 7: no duplicate span IDs
      _test_no_duplicate_ids() {
        local total unique
        total=$(_all_span_ids "$_sf" | wc -l)
        unique=$(_all_span_ids "$_sf" | sort -u | wc -l)
        [ "$total" -eq "$unique" ]
      }
      _check "no duplicate spanIds" _test_no_duplicate_ids

      # Test 8: detect orphan (negative test — inject an orphan and verify detection)
      _test_detect_orphan() {
        local orphan_spool="$_tmp/orphan-test"
        mkdir -p "$orphan_spool"
        # Emit a span with a valid parentSpanId that doesn't exist in the trace.
        # Invalid IDs are rejected before emission; this negative case is about
        # graph structure, not input validation.
        OTEL_SPAN_SPOOL_DIR="$orphan_spool" otel-span run "test" "orphan" --trace-id "$_trace_id" --span-id "0000000000000099" --parent-span-id "0000000000000088" --start-time-ns "2000000000000000" --end-time-ns "3000000000000000" -- true >/dev/null 2>&1
        local of="$orphan_spool/spans.jsonl"
        local span_ids parent_ids
        span_ids=$(_all_span_ids "$of")
        parent_ids=$(_all_parent_ids "$of" | grep -v '^$' || true)
        # The orphan's parent should NOT be in span_ids — so this check should fail
        while IFS= read -r pid; do
          if ! echo "$span_ids" | grep -qF "$pid"; then
            return 0  # correctly detected orphan
          fi
        done <<< "$parent_ids"
        return 1  # failed to detect orphan
      }
      _check "detect orphan (negative test)" _test_detect_orphan

      echo ""
      echo "$_pass passed, $_fail failed"
      [ "$_fail" -eq 0 ]
    '';
  };

  tasks."otel:test:devenv-e2e" = {
    description = "Validate clean devenv OTEL task semantics through real otelite capture";
    exec = ''
      set -euo pipefail
      bash nix/devenv-modules/tasks/shared/tests/ts-otelite-e2e.test.sh
    '';
  };
}
