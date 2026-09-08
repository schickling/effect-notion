# Devenv Issues

## Active Workarounds

### DEVENV-02: Detailed OTLP task phases require global CLI verbosity

**Issue:** https://github.com/cachix/devenv/issues/3037

**Resolved foundation:**

- https://github.com/cachix/devenv/issues/2415
- https://github.com/cachix/devenv/pull/2740

**Affected repos:** Repositories using shared effect-utils setup profiling

Devenv 2.1 natively exports root, evaluation, build, task, and process spans to
OTLP. It also propagates `TRACEPARENT` and `TRACESTATE` to subprocesses, so
instrumented tools can join the native trace. Native orchestration tracing is
therefore no longer a workaround owned by effect-utils.

The remaining gap is narrower. Devenv creates `check status` and
`execute command` child activities, but marks them as Debug. Normal OTLP
captures expose only aggregate task duration. `--verbose` exposes both phases
but also changes console/TUI verbosity and exports unrelated debug activity.

**Current workaround:** The shared observability module joins native devenv
OTLP/gRPC spans with Effect task-phase OTLP/HTTP spans in one isolated otelite
capture. This preserves status-versus-execution timing until devenv can select
OTLP detail independently from human-facing verbosity.

**Deletion criterion:** After #3037 ships in a tagged devenv release and the
native task → status/exec → instrumented-child hierarchy passes the shared
otelite proof, remove only the `otel-span` task-phase producer, HTTP bridge, and
Effect-parent assertion.

The rest of `nix/devenv-modules/observability.nix` is durable shared tooling:
otelite lifecycle, hermetic capture, inspection assertions, profile/verify task
generation, project conventions, backend selection, and check wiring remain
effect-utils responsibilities.

---

### DEVENV-03: Automatic port allocation (`ports.<name>.allocate`) does not pick a free port

**Issue:** https://github.com/cachix/devenv/issues/2484

**Repro:** https://github.com/schickling-repros/2026-02-devenv-port-allocation-ignored

**Affected repos:** Any repo that runs multiple concurrent dev servers across multiple devenv instances

**Symptoms:**

- `config.processes.<name>.ports.<port>.value` stays equal to the base port even when that port is already in use
- Downstream servers fail with `EADDRINUSE`, or (worse) tools like Storybook auto-select a different port and collide with other servers

**Impact on Storybook:**

- Storybook with `--ci` will silently choose another port when the requested port is taken, which can drift into other storybook ports (e.g. base `6009` drifts into `6014`) and cause cascading failures

**Workaround (recommended):**

- Force deterministic failure instead of port drifting by using Storybook `--exact-port` for all Storybook dev processes.

**Additional mitigation:**

- If base ports are contiguous (e.g. `6006..6013`), consider spacing them out to reduce the blast radius when any tool auto-selects ports.

---

### DEVENV-04: Optional task failures can make direnv activation exit non-zero

**Issue:** https://github.com/cachix/devenv/issues/2480

**Affected repos:** Repos that run devenv tasks during shell entry (via `devenv:enterShell`)

**Symptoms:**

- `direnv` activation fails (non-zero exit) when an optional setup task fails
- Shell entry becomes brittle even though failures should be best-effort (R15)

**Resolution:**

Resolved by switching to `devenv shell` (instead of direnv). Optional tasks now use
native `@complete` dependency suffix directly. The `setup:opt:*` wrapper tasks were
removed as they are no longer needed.

---

### DEVENV-05: PTY task runner drains all enterShell output before interactive session

**Issue:** https://github.com/cachix/devenv/issues/2500

**Upstream status:** Fixed by https://github.com/cachix/devenv/pull/2661.

**Repo status:** Resolved by the tagged releases that carry the fix; `devenv.yaml` pins `v2.3`.

**Affected repos:** Any repo wanting to display messages (e.g. trace URLs) on shell entry

**Symptoms:**

- `echo` / `printf` output from `enterShell` is consumed by `drain_pty_to_vt` and never visible
- `PROMPT_COMMAND` hooks fire 4 times during drain before the first visible prompt
- No mechanism to run code or display output after the PTY drain completes

**Root cause:**

devenv's PTY task runner sends two echo sentinels and reads until both are found, feeding all output to a headless VT. This intentionally hides task runner noise but also swallows any user-facing messages from `enterShell`.

**Current repo approach:**

- Emit OTEL shell-entry notices through `devenv.messages` task output.
- Reuse the exported Grafana link env in `otel-trace` for on-demand reopening.
- Use the upstream `v2.1` tag, which includes the task message support this flow needs.

---

## Platform Compatibility Issues

### COMPAT-01: Web coding agents have limited Nix/devenv support

**Note:** Not a devenv issue per se, but a platform limitation affecting devenv usage.

**Upstream issues:**

- https://github.com/openai/codex/issues/7636 (toolchains disappearing after setup)
- https://github.com/openai/codex/issues/4843 (direnv/devenv env dropped with `bash --login`)

**Affected platforms:**

| Platform           | Status     | Primary Blocker                                      |
| ------------------ | ---------- | ---------------------------------------------------- |
| Codex Web (OpenAI) | ⚠️ Partial | PATH/env not persisted across command invocations    |
| Claude Code Web    | ⚠️ Partial | Network allowlist excludes Nix caches by default     |
| Codex CLI (local)  | ⚠️ Partial | `bash --login` drops `.devenv/profile/bin` from PATH |

**Codex Web issues:**

- Commands may run in fresh shells, losing PATH/env set during setup
- Secrets are short-lived (injected during setup, then wiped)
- Toolchains (e.g., node/npm) present during setup can be missing in later agent commands

**Claude Code Web issues:**

- "Limited" network mode allowlist does not include `cache.nixos.org` or other Nix domains
- Nix installations fail unless using "Full internet" mode or org-level allowlist customization
- SessionStart hooks can install devenv, but network policy blocks cache fetches

**Workarounds:**

- **Codex Web:** Wrap all commands to run through devenv shell; don't rely on ambient PATH
- **Claude Code Web:** Use "Full internet" mode if available, or request Nix domains be allowlisted
- **Both:** Prefer binary caches (Cachix) to avoid compiling in sandboxes
- **Both:** Make setup scripts defensively re-assert prerequisites

**Research needed:**

- Monitor upstream for network allowlist updates (Claude Code Web)
- Track Codex container environment improvements
- Evaluate alternative approaches (pre-built containers, devcontainers)

---

### COMPAT-02: Devenv git hooks fail in Claude Code (conductor) — retired `dt` path

**Affected platforms:** Claude Code (local, via conductor)

**Symptoms:**

The `check-quick` pre-commit hook used to fail with `No such file or directory (os error 2)` when
Claude Code ran `git commit`. The hook entry was `devenv tasks run check:quick`, but `dt` was a
devenv-shell-only binary. Claude Code's bash environment did not have direnv loaded when git invoked the pre-commit hook subprocess.

```
error: Failed to run hook `check-quick`
  caused by: Run command `run system command` failed
  caused by: No such file or directory (os error 2)
```

**Root cause:**

The `.pre-commit-config.yaml` (generated by `git-hooks.nix`) used a bare `dt` command:

```yaml
entry: 'devenv tasks run check:quick'
```

The `check-quick` hook relied on `dt` being in PATH. Git hooks run in a
subprocess that does not reliably inherit the direnv environment.

**Investigation:**

- `${pkgs.bash}/bin/bash -c 'devenv tasks run check:quick'` fixed only the bash lookup; `dt` was still not in PATH inside that invocation
- Works when committing from a direnv-activated terminal
- The hook needed a command available outside the devenv shell

**Fix:**

- Use `DEVENV_TUI=false devenv tasks run check:quick` in the hook entry.

**Current workaround:** none; the hook should use native devenv task execution.

---

## Cleanup checklist when issues are fixed

- **DEVENV-02 fixed (native OTLP support added via #2415):**
  - When #2415 is fixed: can use native OTLP export to observability platforms
  - Remove manual JSON trace post-processing from CI pipelines
  - Update R10 status in this document to reflect full compliance

- **COMPAT-01 improved (web coding agent support):**
  - When Claude Code Web adds Nix domains to allowlist: update status, remove "Full internet" workaround
  - When Codex fixes PATH persistence: update status, simplify setup scripts
  - When either platform has first-class devenv support: document recommended setup

- **COMPAT-02 fixed (devenv git hooks work in Claude Code):**
  - When hook entry uses absolute path or direnv wrapper: remove `--no-verify` workaround
  - Update this document to mark COMPAT-02 as resolved
