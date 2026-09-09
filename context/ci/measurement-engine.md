# CI Measurement Engine

This document specifies the reusable CI measurement engine. It builds on
[measurements.md](./measurements.md).

## Status

Draft - architecture target for replacing generated shell/jq comparison code
with a typed reusable implementation.

## Scope

This spec defines:

- the stable measurement artifact contract;
- comparison policy semantics;
- the native engine boundary;
- external-tool integration boundaries;
- the rollout path from generated shell/jq to a packaged CLI.

This spec does not define individual probes. Devenv, Nix closure, source-shape,
LOC, and complexity probes remain producer adapters that emit the shared
artifact format.

## Architecture

```text
producer adapters
  devenv wall-clock
  nix closure size
  source shape
  future LOC / complexity
        |
        v
measurements.json
        |
        v
ci-measure native engine
  schema validation
  compatibility matching
  comparison policy
  gate decision
  report projection
        |
        +--> measurement-comparison.json
        +--> GitHub Markdown comment
        +--> SVG/PNG chart payload
        +--> optional trend export
```

The engine owns comparison and rendering. Workflows own checkout, dependency
setup, artifact upload, and GitHub API calls.

## Measurement Registry

Every observation is interpreted through a registry entry:

| Field                     | Purpose                                                |
| ------------------------- | ------------------------------------------------------ |
| `id`                      | Stable public identity.                                |
| `label`                   | Human review label.                                    |
| `semanticPath`            | Hierarchical grouping for comments and charts.         |
| `measurementKind`         | `deterministic`, `wall-clock`, or `diagnostic`.        |
| `unit`                    | Canonical unit for values and deltas.                  |
| `direction`               | Whether larger values are better, worse, or neutral.   |
| `defaultComparisonMode`   | `budget`, `paired`, `historical`, or `diagnostic`.     |
| `gatePolicy`              | Absolute/relative budgets and sample requirements.     |
| `compatibilityDimensions` | Which dimensions must match for historical comparison. |
| `displayPolicy`           | Visibility, sorting, and chart inclusion behavior.     |
| `rawSampleSchema`         | Optional schema for per-sample evidence.               |

The registry is the public API for cross-repo reuse. Repos may add local entries,
but they must not fork comparison semantics.

Wall-clock registry entries should include a workload dimension when the same
logical command can be measured under different cache conditions. For example,
`task_check_quick_warm` and `task_check_quick_forced` intentionally share the
semantic path `devenv / quality gates / check:quick`, but they are separate IDs
because one measures the warm cached no-op path while the other refreshes the
devenv task cache. This avoids false product claims such as treating a cached
orchestration improvement as a full developer quick-check improvement.

## Comparison Semantics

| Kind            | Merge-gate mode | Evidence model                                     |
| --------------- | --------------- | -------------------------------------------------- |
| `deterministic` | `budget`        | Exact comparable value plus configured budget.     |
| `wall-clock`    | `paired`        | Same-run base/head pairs and paired delta samples. |
| `wall-clock`    | `historical`    | Advisory trend context only.                       |
| `diagnostic`    | `diagnostic`    | Non-gating explanatory data.                       |

Wall-clock PR gates must not depend on historical timing alone. Historical
timing is useful for drift detection, A/A calibration, and dashboards, but it
does not prove PR causality.

Paired wall-clock gates use nonparametric evidence by default:

```text
paired_delta_i = current_duration_i - baseline_duration_i
evidence_lower = quantile(paired_delta, pairedEvidenceQuantile)
evidence_upper = quantile(paired_delta, 1 - pairedEvidenceQuantile)
fail           = evidence_lower > fail_budget
warn           = evidence_lower > warn_budget
```

The engine may add bootstrap or permutation intervals for selected probes, but
it must keep the raw paired delta samples in the artifact so decisions remain
auditable.

## Native CLI Boundary

The long-term implementation should be a packaged `ci-measure` CLI.

```text
ci-measure validate --input measurements.json
ci-measure compare --current DIR --baseline DIR --output comparison.json
ci-measure render-comment --comparison comparison.json --output comment.md
ci-measure render-chart --comparison comparison.json --theme light --output chart.svg
ci-measure export-trends --comparison comparison.json --format bencher-json
```

Rust is the preferred implementation language for the engine because it gives:

- typed schemas for artifact compatibility;
- deterministic rendering without ad hoc heredocs;
- fast startup in generated CI workflows;
- property tests for policy classification;
- snapshot tests for Markdown/SVG output;
- a single packaged binary for all repos.

Shell remains appropriate for probe execution because probes invoke arbitrary
repo-local commands, Nix, devenv, and GitHub workflow primitives.

## External Tool Boundary

External tools may be exporters, not authorities.

| Tool class                 | Allowed role                              | Not allowed role                       |
| -------------------------- | ----------------------------------------- | -------------------------------------- |
| Bencher / trend stores     | Historical storage, dashboards, alerting. | Primary PR gate for paired wall-clock. |
| CodSpeed-style instruments | Language-level benchmark suites.          | Devenv/Nix shell gate replacement.     |
| OTEL backends              | Trace explanation and runner diagnostics. | Canonical numeric regression decision. |
| GitHub artifacts/comments  | Current authoritative review projection.  | Long-term statistical trend database.  |

This keeps the merge contract under our control while still allowing the best
external system to own trend visualization or specialized microbenchmarking.

The Bencher experiment in
[.experiments/0001-bencher-evaluation.md](./.experiments/0001-bencher-evaluation.md)
confirms this boundary: Bencher is useful for historical storage and scalar
threshold alerts, but it does not natively gate on same-run paired base/head
evidence.

## Rollout

1. Keep the current generated workflow behavior and comment shape stable.
2. Add schema fixtures from existing production `measurements.json` artifacts.
3. Implement `ci-measure compare` behind a workflow environment switch.
4. Run generated jq and native CLI comparisons side by side in CI.
5. Require byte-for-byte compatible `measurement-comparison.json` for existing
   fixtures, except for intentional schema-version changes.
6. Move Markdown and SVG rendering into the native CLI after comparison parity.
7. Remove generated jq/Node snippets once all megarepo consumers use the CLI.

The branch-protection surface must keep the same job names during rollout.

## Open Questions

- **DQ1 Bootstrap intervals:** Which probes are valuable enough to pay for
  bootstrap or permutation intervals instead of quantile evidence?
- **DQ2 Trend backend:** Should historical trend export target Bencher, an
  object-store-backed JSON index, Prometheus/OTEL metrics, or more than one?
- **DQ3 Registry location:** Should shared registry entries live in effect-utils
  source, generated repo config, or both?
- **DQ4 Calibration lane:** Which repos should run scheduled A/A and injected
  regression calibration first?
