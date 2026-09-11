# Devenv OTEL Integration

Per-project OpenTelemetry tracing for native devenv tasks and TS app code. Provides a local Collector + Tempo + Grafana stack via `devenv up`, with auto-detection of an existing system-level stack.

## System Stack Assumptions

The devenv module auto-detects a system-level OTEL stack by checking for the `OTEL_STATE_DIR` session variable. When set, the devenv module trusts the system-provided env vars (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_GRAFANA_URL`, etc.) instead of starting its own services.

To run a **local** per-project stack instead (e.g. when no system stack is available), the module starts Collector + Tempo + Grafana on hash-derived ports via `devenv up`.

## Quick Start

```bash
# 1. Enter devenv
devenv shell
# [otel] Collector: http://127.0.0.1:XXXXX
# [otel] Grafana:   http://127.0.0.1:XXXXX

# 2. Start the stack (Collector + Tempo + Grafana)
devenv up

# 3. Run tasks -- automatically traced when stack is running
devenv tasks run pnpm:install
devenv tasks run check:quick

# 4. View traces
otel-trace                      # re-open the current shell session's trace URL
open $OTEL_GRAFANA_URL          # Grafana UI -> Explore -> Tempo
```

## Import

```nix
# devenv.nix
imports = [
  (inputs.effect-utils.devenvModules.otel {})
  # or with fixed base port:
  (inputs.effect-utils.devenvModules.otel { basePort = 14000; })
];
```

## Auto-Detection (System vs Local)

```
mode = "auto" (default)
  ├── OTEL_STATE_DIR set? → "system": uses session env vars, skips local services
  └── not set?            → "local": starts per-project Collector/Tempo/Grafana
```

When in system mode, this module requires `OTEL_STATE_DIR`, `OTEL_EXPORTER_OTLP_ENDPOINT`, and `OTEL_GRAFANA_URL`. Shell entry fails immediately if those required environment variables are missing. Dashboard sync is best-effort: when a compatible legacy `otel` CLI is available, shell entry invokes `otel dash sync` against `$OTEL_STATE_DIR/dashboards`; otherwise it warns and continues.

## Environment Variables

| Variable                      | Set by       | Purpose                                                               |
| ----------------------------- | ------------ | --------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `otel.nix`   | Collector HTTP endpoint (hash-based port)                             |
| `OTEL_GRAFANA_URL`            | `otel.nix`   | Grafana UI URL                                                        |
| `OTEL_STATE_DIR`              | system stack | System-level state directory; presence triggers system-mode detection |
| `TRACEPARENT`                 | `otel-span`  | W3C Trace Context, propagated for parent-child trace links            |
| `OTEL_GRAFANA_LINK_URL`       | `otel.nix`   | Grafana Explore URL template for trace links                          |

## Port Allocation

Ports are derived from `sha256(DEVENV_ROOT)` at Nix evaluation time so parallel worktrees don't conflict:

```
base = portRangeStart + (parseInt(sha256(root)[0:7], 16) % (portRangeEnd - portRangeStart - 6))
```

6 consecutive ports from `base`:

| Offset | Service                               |
| ------ | ------------------------------------- |
| +0     | OTEL Collector OTLP HTTP receiver     |
| +1     | Tempo OTLP gRPC ingest                |
| +2     | Tempo HTTP query API                  |
| +3     | Grafana HTTP UI                       |
| +4     | Collector internal Prometheus metrics |
| +5     | Tempo internal gRPC                   |

Range: 10000-60000 (~0.012% collision probability for 2 worktrees).

## Shell Helpers

### `otel-trace` -- Trace URL display

Prints the current shell session's trace URL as a clickable OSC 8 hyperlink (when stdout is a terminal) or plain text (when piped). Available in any `devenv shell` session with OTEL enabled.

```bash
otel-trace                  # clickable hyperlink: trace:<trace-id>
otel-trace | cat            # plain text: trace:<trace-id> <url>
```

The function parses `TRACEPARENT` (W3C format: `version-traceId-spanId-traceFlags`) and constructs a Grafana Explore URL from `OTEL_GRAFANA_LINK_URL`.

**Note:** This repo now uses `devenv.messages` to auto-display the OTEL shell-entry notice. `otel-trace` remains as an on-demand way to reopen the same link later in the session. The repo is temporarily pinned to the upstream post-[cachix/devenv#2661](https://github.com/cachix/devenv/pull/2661) commit while waiting for the next tagged release.

### `otel-span` -- Trace span CLI

Delivers spans via spool file (`$OTEL_SPAN_SPOOL_DIR`) when available, falls back to HTTP POST to the collector. No-op when neither is configured.

Subcommands:

- `otel-span run` — wrap a command in an OTLP trace span
- `otel-span emit-span` — emit one typed OTLP span without wrapping a command
- `otel-span emit` — deliver a raw OTLP JSON payload from stdin

```bash
otel-span run <service-name> <span-name> -- <command> [args...]
otel-span run effect-utils-devenv devenv.task.exec --attr task.name=pnpm:install -- pnpm install
otel-span emit-span effect-utils-devenv devenv.task.status --attr-string span.label=buck2:check
printf '%s' "$otlp_json" | otel-span emit
```

Task modules call `otel-span run` automatically -- no manual wrapping needed for task runs.

## Devenv Trace Model

All local tooling spans use the real local process boundary:
`service.name="effect-utils-devenv"`. Tooling categories are represented by
stable span names and low-cardinality attributes instead of synthetic services.

**Task spans**: each task `exec` and cache/status check is wrapped via
`trace.nix`:

```nix
# In task modules:
trace = import ../lib/trace.nix { inherit lib; };
exec = trace.exec "buck2:check" "buck2 build <authoritative-targets>";
```

`TRACEPARENT`/`OTEL_TASK_TRACEPARENT` chains nested task wrappers under the
calling `devenv.task.*` span. Buck owns TypeScript compiler execution; the
retired root compiler wrapper no longer emits a parallel TypeScript span tree.

## Span Conventions

### Resource Attributes

| Attribute      | Required | Values                            | Set by                    |
| -------------- | -------- | --------------------------------- | ------------------------- |
| `service.name` | Yes      | `"effect-utils-devenv"`, app name | `otel-span`, Effect layer |
| `devenv.root`  | Yes      | Absolute path                     | `otel-span`, Effect layer |

### Span Attributes (devenv tasks)

| Attribute       | Type      | Description                     | Example                                  |
| --------------- | --------- | ------------------------------- | ---------------------------------------- |
| `name`          | span name | Stable operation name           | `devenv.task.exec`, `devenv.task.status` |
| `span.label`    | string    | Human-readable short label      | `buck2:check`                            |
| `tool.name`     | string    | Tool namespace                  | `devenv`                                 |
| `task.name`     | string    | Devenv task name                | `pnpm:install`, `buck2:check`            |
| `task.phase`    | string    | Task wrapper phase              | `exec`, `status`                         |
| `task.cached`   | bool      | Whether task was cached/skipped | `true`, `false`                          |
| `status.method` | string    | Cache/status check strategy     | `binary`, `hash`, `path`                 |
| `exit.code`     | int       | Process exit code               | `0`, `1`                                 |

`trace.exec` adds `task.cached=false` for executed tasks. `trace.status` derives
`task.cached` from the status command exit code. Raw command arguments and
compiler output are not recorded as span attributes.

## Dashboards

Nix-managed dashboards authored in [Grafonnet](https://github.com/grafana/grafonnet) (Jsonnet DSL), built at Nix eval time and provisioned into Grafana via file-based provisioning.

Source: `nix/devenv-modules/otel/dashboards/*.jsonnet`

### Build Pipeline

```
nix/devenv-modules/otel/dashboards/*.jsonnet   # Source (Grafonnet DSL)
        │
        ▼  go-jsonnet + grafonnet lib
/nix/store/.../dashboards/*.json               # Built (in Nix store)
        │
        ▼  Grafana file provisioning
Grafana UI                                      # Live dashboards
```

### Iteration Workflow

```bash
# Preview JSON output locally
jsonnet -J path/to/grafonnet devenv-tasks.jsonnet | jq .

# Or paste into Grafana's Dashboard Settings > JSON Model for live preview
```

### Dashboard List

| Dashboard                     | Purpose                                        |
| ----------------------------- | ---------------------------------------------- |
| `overview`                    | Landing page: recent traces, service breakdown |
| `devenv-tasks`                | Task duration, cache hit rate, failure rate    |
| `shell-entry`                 | `devenv shell` / enterShell duration breakdown |
| `pnpm-install`                | Per-package install analysis, waterfall view   |
| `ts-app-traces`               | General-purpose trace exploration for Effect   |
| `devenv-task-duration-trends` | p50/p95/p99 percentiles over time by category  |

### Project Dashboards (`.otel/dashboards.json`)

Projects define their own dashboards in `.otel/dashboards.json`. In system mode, dashboard syncing is best-effort on shell entry when a compatible legacy `otel` CLI is available; missing dashboard sync tooling must not block the shell because the standalone `otel` binary is retired. `extraDashboards` is local-mode only and is rejected in system mode.

## Data Storage

All state in `$DEVENV_ROOT/.devenv/otel/` (gitignored):

| Directory               | Contents                | Retention            |
| ----------------------- | ----------------------- | -------------------- |
| `tempo-data/`           | Compacted trace blocks  | 72h (configurable)   |
| `tempo-wal/`            | Write-ahead log         | Flushed on compact   |
| `grafana-data/`         | Grafana database/prefs  | Persistent           |
| `grafana-provisioning/` | Auto-provisioned config | Regenerated on start |

Clean with `rm -rf .devenv/otel/`.

## Forward Compatibility (cachix/devenv#2415)

When devenv adds native OTEL support, it will read `OTEL_EXPORTER_OTLP_ENDPOINT` (same env var this module sets) and export build/eval/fetch spans to the same collector. No configuration changes needed.

## Module Structure

```
nix/devenv-modules/
  otel.nix                    — devenv module: processes, env vars, auto-detection, dashboards
  otel/otel-span.nix          — standalone otel-span CLI (run + emit subcommands)
  otel/build-dashboards.nix   — Grafonnet build helper for compiling dashboards
  otel/dashboards/            — Grafonnet source files
  tasks/lib/trace.nix         — otel-span wrapper for task exec tracing
  tasks/lib/cache.nix         — cache status tracking (sets task.cached attribute)
```

## Related

- **`nix/devenv-modules/tasks/`** -- shared task modules
- **[cachix/devenv#2415](https://github.com/cachix/devenv/issues/2415)** -- Upstream native OTEL support
- **[cachix/devenv#2500](https://github.com/cachix/devenv/issues/2500)** -- Post-drain hook (for auto-displaying trace URL on shell entry)
