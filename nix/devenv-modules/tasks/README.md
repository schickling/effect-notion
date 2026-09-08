# Task Organization

This directory contains devenv task modules organized by reusability.

## `shared/` - Reusable Tasks

These tasks are meant to be imported by other repos via the flake input:

```nix
# In another repo's devenv.nix
imports = [
  (inputs.effect-utils.devenvModules.tasks.check {})
  (inputs.effect-utils.devenvModules.tasks.ts {})
  (inputs.effect-utils.devenvModules.tasks.lint-oxc {
    lintPaths = [ "src" "test" ];
    geniePatterns = [ "*.genie.ts" ];
    genieCoverageDirs = [ "." ];
  })
  (inputs.effect-utils.devenvModules.tasks.flake-lock-duplicates {
    lockfiles = [ "flake.lock" ];
  })
];
```

## Observability

Import the sibling observability module once to capture native devenv spans
and effect-utils task spans as one otelite trace:

```nix
imports = [
  (inputs.effect-utils.devenvModules.observability {
    project = "my-repo";
    # Optional: compose the full Collector/Tempo/Grafana stack.
    backend = "auto";
    # Optional: gate an existing aggregate task on the hermetic shape check.
    wireInto = [ "check:all" ];
  })
];
```

The default `backend = "ambient"` adds only `otel-span`, otelite, and the
`otel:profile:setup` / `otel:verify:setup` tasks. Task wrappers resolve the
module-owned bridge through `OTEL_SPAN_BIN`, so nested devenv task environments
do not depend on ambient `PATH`; capture tasks also prefer otelite's
invocation-scoped HTTP endpoint over a repository's ambient collector endpoint.
The module intentionally avoids the full local observability stack. Override
`profile` to capture a different task graph, or set `profile = null` when only
the packages and project attribution are needed. Use `profile.prerequisiteTasks`
for outer tasks that must complete before the nested devenv process can evaluate.

### Characteristics:

- **Configurable** via function parameters
- **No repo-specific assumptions** (paths, package names, etc.)
- **Exported** in `flake.nix` under `devenvModules.tasks`
- **Documented** with clear usage examples

### Available Modules:

- `check.nix` - Aggregate check tasks (check:quick, check:all, configurable strict typecheck gate)
- `clean.nix` - Clean tasks
- `genie.nix` - Genie config generation tasks
- `lint-oxc.nix` - Linting tasks (oxlint, oxfmt)
  - `lintPaths` are Git pathspecs. The lint tasks enumerate tracked and untracked
    non-ignored files through `git ls-files` before calling oxlint/oxfmt, and do
    not use devenv's `execIfModified` glob walker.
- `megarepo.nix` - Megarepo workspace tasks
- `flake-lock-duplicates.nix` - Exact duplicate flake lock-node policy
  - `(taskModules.flake-lock-duplicates { lockfiles = [ "flake.lock" ... ]; })`
    selects the lockfiles and only defines `nix:flake-lock:check-duplicates`.
    Each consumer explicitly attaches that task to its authoritative aggregate
    gate.
  - Lockfile paths are resolved relative to the task working directory.
  - Each lockfile is checked independently. Complete `.locked` identities are
    never compared across files. The task reports every within-file duplicate
    group in deterministic order and fails for missing or invalid lockfiles;
    similar but non-identical identities are allowed.
- `nix-cli.nix` - Nix CLI build/check tasks
- `pnpm.nix` - pnpm install tasks
  - Local development shares one complete pnpm Store Cache between trusted
    roots of the same OS user; CI uses a job-local Store Cache.
  - Dependency graphs, `node_modules/.pnpm`, projections, and repair remain
    Materialization-Root-owned.
  - Managed installs use pnpm's `auto` import policy and reject cross-device
    Linux storage before materialization.
  - `pnpm:store:migrate-legacy` explicitly replaces only the recognized
    historical `v11/files` bridge under the exclusive cache lease; normal
    installs and unknown bridges fail closed.
  - Frozen installs and `pnpm:update` both use the current guarded pnpm
    runtime: pnpm 12 is outside the 11.5.2-11.14.0 `hasBin` window that
    required a separate lock mutator, so the dedicated pin is retired while
    `pnpmLockMutatorPkg` remains available for a future divergence. Root
    updates generate projections with validation deferred, repair the lock,
    then require `genie --check`; retained package records are rejected
    transactionally if they lose `hasBin` metadata.
- `setup.nix` - Setup tasks
  - `skipNonInteractive = true` keeps automatic shell entry cheap for
    non-interactive callers; `DEVENV_FORCE_SETUP=1` explicitly overrides it.
- `test.nix` - Test tasks
- `test-playwright.nix` - Playwright e2e tasks
- `ts.nix` - TypeScript tasks (`ts:check`, `ts:check:strict`, build/watch/clean helpers)
  - `ts:check`, `ts:check:strict`, `ts:build`, `ts:build-watch`, `ts:emit`, and `ts:clean` default to the Nix-managed `tsgo` binary; `ts:emit` uses a dedicated emit graph for no-check emit.
  - `ts:check:strict` inherits repo-local `ts:check.after` hooks so strict CI stays aligned with consumer generators
- `vercel.nix` - Vercel deploy tasks
  - Static and build-mode deploys delegate provider behavior to `ci-tools deploy vercel`.
  - Build-mode tasks pass root-directory/build-env config to `ci-tools`; `ci-tools`
    owns `vercel pull`, `vercel build`, prebuilt output validation, deploy,
    aliasing, workflow-report records, and GitHub outputs.
- `workflow-report.nix` - Workflow-report tasks
  - Provides `workflow-report:collect-bundle`,
    `workflow-report:render-comment-body`, and `workflow-report:publish`.
  - CI should pass event context and paths through environment variables while
    these tasks own `ci-tools workflow-report ...` invocation and PR comment
    lookup/publication behavior.
- `bun.nix` - Bun tasks (legacy)
- `context.nix` - Context directory tasks
- `lint-genie.nix` - Genie lint tasks
- `worktree-guard.nix` - Git hook: prevent commits on default branch (optionally enforce linked worktrees)

## `local/` - Effect-Utils Specific

These tasks are **local to the effect-utils repo** and NOT meant for reuse.
They assume the effect-utils repo structure and are not exported in flake.nix.

### Characteristics:

- **Hardcoded paths** (e.g., `packages/@overeng/*`, `devenv.nix` location)
- **No parameters** - simple inline definitions
- **Not exported** in flake.nix
- **Repo-specific logic** that wouldn't make sense elsewhere

### Available Modules:

- `asset-import-type-reference.nix` - effect-utils package export policy check for asset side-effect imports
- `devenv-module-tests.nix` - CI task that runs shell tests for reusable task modules
- `workspace-check.nix` - Validates `allPackages` in devenv.nix matches filesystem

## `lib/` - Shared Utilities

Helper functions used by task modules:

- `cache.nix` - Task caching utilities
- `cli-guard.nix` - Guarded task-owned CLI wrappers
- `trace.nix` - Task tracing wrappers

## Task Output

devenv renders a task's **stderr** by default. Its **stdout** is rendered only
when the run opts in — `showOutput = true` on the task, `--show-output`, or
`--verbose`.

That is about what devenv prints to a console, not about what escapes the
process. **Both streams reach a GitHub runner.** Measured on `ubuntu-latest`
with devenv 2.1.2: a `::warning::` emitted from a task became an annotation from
stdout with no opt-in, from stdout with `showOutput = true`, and from stderr —
all three indistinguishable from one emitted by the step itself. So workflow
commands work from either stream, and log grouping does too.

One caveat worth knowing when debugging locally: devenv selects quiet verbosity
when it detects `CLAUDECODE` / `OPENCODE_CLIENT` / `AI_AGENT`, and in 2.1.2 that
also suppresses `showOutput`
([cachix/devenv#3038](https://github.com/cachix/devenv/issues/3038)). A task's
stdout can therefore look missing inside a coding agent while being perfectly
visible in CI. Use `DEVENV_NO_AI_AGENT=1` or `--verbose` when measuring.

## Adding New Tasks

### For Shared Tasks:

1. Create file in `shared/<name>.nix`
2. Make it a function that accepts configuration parameters
3. Document usage in this README
4. Export in `flake.nix` under `devenvModules.tasks.<name>`
5. Keep it generic - no hardcoded paths

### For Local Tasks:

1. Create file in `local/<name>.nix`
2. Define tasks directly (no parameterization needed)
3. Import directly in `devenv.nix` via relative path:
   ```nix
   imports = [ ./nix/devenv-modules/tasks/local/my-task.nix ];
   ```
4. Do NOT export in flake.nix
