# Check-entry bakeoff

Date: 2026-09-12
Host: dev3 (x86_64-linux)

## Question

Should the repository keep `devenv tasks run check:quick` as the human and agent
entry point around one Buck aggregate, or delete the devenv `check:*` fan-in and
use `buck2 test //...` directly?

## Method

Two throwaway prototypes used the current TypeScript admission authority. The
nine admission slices currently expand to 12 packages: `tui-core`, `tui-react`,
`utils-dev`, `stylex-tokens`, `content-address`, `effect-distributed-lock`,
`otel-contract`, `utils`, and the four notion packages `notion-core`,
`notion-effect-schema`, `notion-property-write`, and `notion-effect-client`.
The prototypes were removed after measurement.

- Shape A added root `//:quick` over every admitted `typecheck` and `dist` target,
  added `buck2:quick`, and made `check:quick` depend on it. It retained the
  residual devenv gates.
- Shape B retained the same aggregate, removed this repository's check module
  import and local `check:all` fan-in additions, and used `buck2 test //...`
  directly.
- Both shapes excluded `mr:check`, `mr:lock-sync-check`, and
  `mr:source-policy-check`, as required by Amendment 1. The dev3 composed-root
  path was already known to be structurally unavailable. Both used the Nix
  Buck binary and the generated member `.buckconfig` shape. The configured dev3
  REAPI TCP endpoint was reachable in one probe. The executed Buck commands
  passed `--local-only` to match the existing TypeScript authority runtime, so
  they did not exercise shared cache lookup. This is a D2 measurement gap, not
  evidence for a cache-posture change.
- Root capacity was checked before the prototypes (1.1 TB available) and
  rechecked for the raw record. Each command ran in a named PTY. Elapsed values
  come from PTY creation and exit timestamps.

The required five-sample benchmark matrix could not start. Shape A failed before
analysis because Watchman could not resolve the repository root. Shape B passed
that point but failed analysis because the member worktree has no generated
`.buck2/capabilities/defs.bzl`. The shared Watchman was not restarted because it
was not owned by this experiment. Per Amendment 1, subsequent mutation and
fresh-worktree samples were recorded as gaps instead of treating failed startup
latency as performance evidence.

Raw commands, run counts, elapsed values, and exact errors:

- [environment](./2026-09-12-check-entry-bakeoff/environment.log)
- [measurement matrix](./2026-09-12-check-entry-bakeoff/measurements.tsv)
- [complexity](./2026-09-12-check-entry-bakeoff/complexity.log)
- [shape A](./2026-09-12-check-entry-bakeoff/shape-a.log)
- [shape B](./2026-09-12-check-entry-bakeoff/shape-b.log)
- [shell entry](./2026-09-12-check-entry-bakeoff/shell-entry.log)
- [observability](./2026-09-12-check-entry-bakeoff/observability.log)

## Result

### Speed

**Winner: none.** Neither shape completed one valid run, so p50/p95, warm
no-op, warm shared-cache, relevant edit, irrelevant edit, and n=5 comparisons
would be invented. The standalone shell-entry probe did not complete, and a
records-only final `check:quick` remained in devenv evaluation for 370.476 s;
both are separate from Buck execution time. Shape B's 99.256 s failure and
shape A's 119.398 s failure are startup-failure evidence, not speed evidence.

### Complexity

**Winner: B, narrowly and only for the local prototype diff.** One measured
`git diff --numstat -- BUCK devenv.nix` run per shape produced:

| Shape |   `BUCK` | `devenv.nix` | Immediate net |
| ----- | -------: | -----------: | ------------: |
| A     | +32 / -0 |     +11 / -0 |           +43 |
| B     | +32 / -0 |     +7 / -24 |           +15 |

B cannot immediately delete
`nix/devenv-modules/tasks/shared/check.nix` (110 lines) because effect-utils
exports that module to other repositories. Removing it would require a separate
consumer migration and would change B's eventual net to -95 lines. That
hypothetical deletion is not counted as prototype evidence.

### Capability

**Winner: A.** Buck is the correct authority for deterministic admitted actions,
but `buck2 test //...` is not an equivalent aggregate today. The admitted
TypeScript BUCK files expose `typecheck` and `dist`, not `TestInfo`, while
`//...` also discovers unrelated repository-wide Rust and dependency tests.

| Gate or feature                    | Shape A location                                                                                                     | Shape B direct entry                                                           |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| admitted TypeScript typecheck/dist | root `//:quick`, called by `buck2:quick`                                                                             | aggregate exists, but `buck2 test //...` does not execute its non-test targets |
| Nix quick fingerprint / full flake | `nix:check:quick` in `check:quick`; `nix:flake:check` in `check:all` via `nix/devenv-modules/tasks/shared/check.nix` | absent from the direct verb                                                    |
| `mr:*`                             | excluded from both shapes for Amendment 1                                                                            | excluded from both shapes for Amendment 1                                      |
| workspace consistency              | `workspace:check` in `devenv.nix` `extraChecks`                                                                      | absent from the direct verb                                                    |
| source and Nix lint                | `lint:check` and `lint:nix` in the task fan-in                                                                       | absent from the direct verb                                                    |
| task trace contract audit          | `devenv:trace-audit` in `extraChecks`                                                                                | absent from the direct verb                                                    |
| Weaver registry and compatibility  | `weaver:check`, `weaver:diff`, and `weaver:version-smoke` appended to `check:all` in `devenv.nix`                    | absent from the direct verb                                                    |
| live Weaver lane                   | `weaver:live-check` remains an explicit task/CI lane                                                                 | remains separately addressable, but is not called by the direct verb           |
| tests                              | `test:run` under `check:all`                                                                                         | repository-wide Buck `TestInfo` only; not the same set                         |
| dependency ordering                | devenv `after`, `guard`, `cwd`, and task `env`, plus Buck dependencies inside the aggregate                          | Buck target dependencies only; residual gates need another orchestrator        |
| caching and evidence               | devenv status caching plus Buck action cache/native event log                                                        | Buck action cache/native event log                                             |

A preserves the repository-wide `check:quick`/`check:all` interface used by
`AGENTS.md`, skills, the pre-commit hook, and generated CI task references. B
requires changing those callers and replacing the residual sequence somewhere
else. Direct Buck improves target query and action-level ergonomics, but that is
a complement to the outer check interface rather than evidence for deleting it.

### Observability

**Winner: A.** `nix/devenv-modules/tasks/lib/trace.nix` emits
`devenv.task.exec` and `devenv.task.status` under
`service.name=effect-utils-devenv`, with `task.name`, `task.phase`,
`task.cached`, and `span.label=<task>`. A Buck child also retains its native
compressed event log.

Shape B retains Buck native event logs, but repository search found no Buck
event-log-to-OTLP export path. Deleting the task boundary therefore deletes the
current check-loop span and its stable `span.label` semantics. A future exporter
would need an explicit `service.name`, target/action labels, parent propagation,
and failure-independent export behavior; native Buck evidence must remain the
source of truth.

`gcx config check && gcx datasources list --json` ran once and failed with a
connection refusal for `http://127.0.0.1:3700/api?timeout=32s`. No TraceQL result
or screenshot was reachable for either shape. This common infrastructure gap
does not change the static instrumentation result.

## Conclusion

Retain the devenv entry point and put the admitted deterministic work behind one
Buck aggregate (shape A). A wins capability and observability, while B wins only
the immediate line-count criterion and has no measured speed win. The direct
Buck verb also fails equivalence: `test //...` neither runs the admitted
TypeScript `typecheck`/`dist` surface nor stays scoped to it.

The losing shape's real cost is not only migration churn. Shape B removes the
single fan-in for Nix, lint, generated/workspace, trace-audit, Weaver, and test
contracts; changes hooks, skills, and CI callers; and loses the existing
check-loop OTLP semantics without a Buck exporter. Shape A's real cost is the
extra wrapper and shell-entry path, plus 28 more net prototype lines than B.
That cost should be revisited only after a runnable single-member projection can
produce n≥5 measurements and after Buck has an equivalent typed aggregate verb.

## VRS Impact

This experiment proposes an OQ1 answer in
[check-entry-point](../.decisions/.proposed/check-entry-point.md): devenv owns the
repository check interface and residual task graph; Buck owns admitted
deterministic actions and native evidence behind that interface. The proposal
does not change cache posture, composition requirements, or the prohibition on
a launcher between the caller and Buck for direct product evidence.
