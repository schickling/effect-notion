# CI Measurements

This document specifies the shared CI measurement architecture used by generated workflows.

## Status

Active.

## Measurement Classes

| Class           | Examples                                               | Primary Question                                                      | Gate Model                                               |
| --------------- | ------------------------------------------------------ | --------------------------------------------------------------------- | -------------------------------------------------------- |
| `deterministic` | Nix closure size, source lines, file counts            | Did a structural quantity exceed its budget?                          | Budget/diff against a comparable baseline.               |
| `wall-clock`    | Devenv shell eval, task runtime, CLI command latency   | Did this PR make this operation slower on the same runner conditions? | Paired same-run base/head samples before merge blocking. |
| `diagnostic`    | OTEL-traced shell eval, host context, trace breakdowns | Where did time go?                                                    | Never a regression gate; may be produced by required CI. |

The class is part of the observation contract through `measurementKind`.
The comparison policy is part of the gate contract through `comparisonMode`.

`measurementKind` defines the physical meaning of the number. `comparisonMode`
defines how the number is compared. A producer may only combine them when the
semantics match:

| `measurementKind` | Gateable `comparisonMode` | Baseline Meaning                              | Uncertainty Model                         |
| ----------------- | ------------------------- | --------------------------------------------- | ----------------------------------------- |
| `deterministic`   | `budget`                  | Same target on a comparable ref               | None by default; exact value plus budget. |
| `wall-clock`      | `paired`                  | Same PR run, same runner, base/head pairs     | Per-pair delta evidence interval.         |
| `wall-clock`      | `historical`              | Previous comparable successful artifacts      | Advisory robust bands only.               |
| `diagnostic`      | none                      | Optional context artifact or trace attachment | Not gateable.                             |

Historical comparison is not a substitute for paired wall-clock evidence.
Budget comparison is not a substitute for owner-approved semantic budgets.
Branch protection may require the measurement-producing job to complete
successfully; that requires evidence production, not a red/yellow measurement
verdict. It may only require a lane that runs on every pull request — see
[Lane Cadence](#lane-cadence).

## Observation Contract

Every observation has a stable `id`, human `label`, semantic `group`/`path`,
numeric `value`, `unit`, `measurementKind`, and a gate `policy`.

```json
{
  "id": "devenv.shell_eval_warm.duration",
  "label": "Warm shell eval",
  "measurementKind": "wall-clock",
  "unit": "seconds",
  "value": 6.067,
  "policy": {
    "enabled": true,
    "comparisonMode": "paired",
    "minPairedSamples": 5,
    "minCurrentSamples": 5,
    "pairedEvidenceQuantile": 0.25
  }
}
```

Observation IDs are public API. They should be stable, dotted names whose
prefix names the domain and whose suffix names the measured quantity, for
example `devenv.shell_eval_warm.duration`, `nix.closure.nar_size`, or
`source.lines`. Labels are review UI, not identity. Paths and groups may change
to improve hierarchy, but IDs should only change when the measurement protocol
or semantic target changes.

New measurement producers should emit the shared artifact format directly:

```text
producer adapter
  -> typed observation(s)
  -> shared comparison policy
  -> shared report/comment/SVG projection
```

This keeps probe-specific collection code separate from the reusable regression
system. A new probe should not fork comparison, markdown rendering, or asset
publication logic.

The reusable engine boundary is specified in
[measurement-engine.md](./measurement-engine.md). The long-term direction is
to keep this artifact and comment contract as the source of truth while moving
comparison and rendering out of generated shell/jq snippets into a typed native
CLI.

## Gate Semantics

Deterministic observations use `comparisonMode: "budget"`.
They require a comparable baseline and then evaluate configured absolute and
relative budgets. Historical variance is context only; it does not neutralize
a budget-exceeding deterministic movement. This keeps Nix closure sizes,
source-shape counts, lines of code, complexity scores, and similar structural
measurements separate from wall-clock noise handling.

Wall-clock observations use `comparisonMode: "paired"` for enforced gates.
They need same-run base/head evidence before they can block a merge. Historical
baselines remain useful for trend context, but they do not prove PR causality.
For PR runs, the wall-clock producer checks out the PR base commit in a sibling
worktree and alternates measured pair order (`head -> base`, then
`base -> head`) from a recorded seed to reduce cache and time drift bias
without making order a hidden variable. The current artifact stores the paired
baseline median and paired sample count, and the comparison engine uses that
embedded paired baseline for the gate.

The gate evaluates per-pair deltas, not only the difference between medians. New
artifacts carry the raw paired delta samples in the observation statistics. The
comparison engine derives a nonparametric evidence interval from those samples
using `pairedEvidenceQuantile` (default `0.25`, so the displayed interval is the
25th-75th percentile by default). A paired wall-clock row blocks only when the
lower evidence quantile clears the configured failure budget. If the point
estimate moved but the paired delta evidence still crosses the budget, the row
renders as `paired_uncertain` and does not block. Older artifacts that only have
summary statistics use a conservative robust-band fallback and are labeled with
that evidence protocol. This follows the same principle used by continuous
benchmark tools: a point estimate without uncertainty is not enough evidence
for a regression.

Paired wall-clock gates do not require a historical baseline source count. The
same-run paired baseline is the comparable evidence. Historical runs may still
appear in the report as trend context, but they do not decide whether paired PR
evidence is gateable.

Historical wall-clock comparison may be used as an advisory transition mode.
It can warn, visualize trends, and guide investigation, but it must not be the
required merge gate for noisy runner-dependent timings. Robust baseline/current
bands may suppress historical wall-clock noise; they are not applied as a
semantic escape hatch for deterministic budget rows.

Diagnostic observations set `enabled: false` or `measurementKind: "diagnostic"`.
They appear in reports, but their impact is rendered as `diagnostic` and they
are excluded from actionable impact charts.

## Data Flow

```text
probe execution
  -> measurements.json artifact
  -> comparison engine
  -> PR summary/comment + SVG asset
  -> optional branch-protection gate
```

The artifact is the source of truth. OTEL traces and host context are evidence
attachments, not the canonical numeric store. PR comments are projections of
the artifact and can be regenerated. New measurement families should add
producer adapters that emit this artifact contract; comparison, policy
evaluation, charting, and comment rendering stay shared.

## Wall-Clock Soundness

Wall-clock timings on CI runners are noisy, often non-normal, and affected by
load, caches, CPU frequency, storage, network fetches, and process scheduling.
For merge-blocking use, same-run paired measurement is required:

```text
base warmup
head warmup
sample pair 1: seeded order chooses base/head or head/base
sample pair 2: opposite order
...
```

The comparison operates on per-pair deltas. A wall-clock row becomes gateable
only when the configured minimum paired sample count is present. Until then,
the row is partial/advisory even if the historical raw delta is large.

Wall-clock probe IDs must name the workload they actually measure. Repeated
warm probes are useful for shell and task-orchestration overhead, but they are
not a proxy for an uncached developer workflow. For example:

| Probe                     | Workload                 | Interprets As                                      |
| ------------------------- | ------------------------ | -------------------------------------------------- |
| `task_check_quick_warm`   | Warm cached no-op path   | Devenv task/status orchestration overhead.         |
| `task_check_quick_forced` | `--refresh-task-cache`   | Developer-facing quick-check work with cache miss. |
| `shell_eval_warm`         | Setup-free warm shell    | Environment activation only; Buck is not invoked.  |
| `shell_eval_traced`       | Trace capture diagnostic | Explanation input, not a gate.                     |

The label and `dimensions.workload` must make this distinction visible in the
PR comment so reviewers do not read a cached-path movement as an end-to-end
developer speedup.

For PR gates, the preferred evidence protocol is `paired-delta-quantile-v1`:

```text
paired deltas = current_duration(pair_i) - baseline_duration(pair_i)
evidence lower = quantile(paired deltas, pairedEvidenceQuantile)
evidence upper = quantile(paired deltas, 1 - pairedEvidenceQuantile)
gate fail      = evidence lower > semantic fail budget
gate warn      = evidence lower > semantic warn budget
```

This is intentionally nonparametric because CI timings are often skewed,
heavy-tailed, and not normally distributed. A future scheduled calibration lane
can increase sample counts or move to bootstrap intervals for selected
high-value probes, but the PR gate should remain understandable from the raw
pair deltas in the artifact.

## Deterministic Measurements

Nix closure size, source shape, code complexity, lines of code, and file counts
are deterministic or near-deterministic structural measurements. They are not
wall-clock performance probes and must not use paired timing statistics or
historical timing-style robust-band suppression. They should use explicit
budgets and semantic buckets. A closure-size regression is actionable because
the same installable and lock graph should produce a stable closure.
Source-shape or complexity growth is an architecture signal and should remain
advisory unless a repo defines an explicit owner-approved budget.

Deterministic budgets should prefer absolute units when the user impact is
absolute, such as bytes or path counts, and relative thresholds when scale is
the meaningful signal. A deterministic row may show historical values for
review context, but the pass/fail decision is the budget decision.

## Policy Lifecycle

Each observation should move through explicit policy stages:

| Stage        | Use Case                                      | Merge Behavior                                          |
| ------------ | --------------------------------------------- | ------------------------------------------------------- |
| `diagnostic` | New metric, trace attachment, host context    | Render only.                                            |
| `advisory`   | Historical trend before calibration is mature | Comment and warn, but do not fail the job.              |
| `gateable`   | Calibrated wall-clock or deterministic budget | Fail the job only when the measurement class proves it. |
| `required`   | Stable semantic invariant                     | Repo branch protection may depend on the gate name.     |

Wall-clock probes should start advisory until paired evidence and a noise
profile exist for that repo/runner. Deterministic probes can become gateable
earlier when their target identity and budget are explicit.

Required measurement jobs and required measurement verdicts are separate
decisions. A repo may require the measurement lane so artifact production and
comparison code stay healthy while the observations inside that lane remain
advisory.

## Lane Cadence

A lane's cost is paid on every event it fires on, so cadence is part of its
design rather than a deployment detail. Three cadences are in use:

| Cadence             | Fits                                                                          | Merge-blocking |
| ------------------- | ----------------------------------------------------------------------------- | -------------- |
| every pull request  | Cheap measurement whose value is attributable to the diff under review        | Yes.           |
| `schedule`          | Deterministic measurement whose durable trend artifact is the event's outcome | No.            |
| `workflow_dispatch` | Expensive or diagnostic measurement requested explicitly by an operator       | No.            |

Two rules follow.

**A lane that does not run on every pull request cannot be a required status
check.** A skipped job reports no check run at all, so branch protection would
wait for a status that never arrives. Cadence and required-check membership are
therefore one decision, not two.

**Per-admission evidence is a targeted probe, not a lane.** When a requirement
asks for a measurement per change — warm no-op time, fresh-context time,
cache-hit rate, CI wall-clock delta — that evidence is produced by a probe
scoped to the change and recorded with the change. A standing lane on every
pull request measures the whole surface repeatedly to answer a question about
one part of it, and pays full wall-clock cost each time to do so.

In this repo: `nix-closure-sizes` and `source-shape` are per-pull-request
deterministic lanes and are required. They also run on the nightly `schedule`
to supply deterministic trend artifacts. `devenv-perf` is the paired
wall-clock lane and runs only on explicit `workflow_dispatch`; it is not a
required check. `ci/measurements-report` aggregates whichever lanes ran in the
event that produced it and is advisory in every case.

## Baseline Model

Baselines are comparable evidence, not arbitrary previous numbers.

| Measurement Class | Baseline Source                                      | Backfill Rule                                         |
| ----------------- | ---------------------------------------------------- | ----------------------------------------------------- |
| `deterministic`   | Current main artifacts or manually seeded exact runs | Backfill past merged PRs when introducing the metric. |
| `wall-clock`      | Same-run paired base checkout for PR gates           | Historical backfill is trend context only.            |
| `diagnostic`      | Trace or host artifact for the same run              | No baseline required.                                 |

Manual baseline seeds must record the source run, ref, SHA, and reason. Seeded
data is acceptable when it was produced by the same probe protocol and target
identity; it is not acceptable to copy a chart value into the baseline store.

## State-of-the-Art Alignment

The design follows current continuous benchmarking practice:

- Wall-clock gates need repeated measurements, warmup, and uncertainty, not
  single raw timing deltas.
- Paired base/head runs reduce runner-load, cache, and time-drift bias.
- Outliers and wide variance reduce confidence instead of being silently
  averaged away.
- Diagnostic traces explain regressions; they do not define the canonical
  numeric result.
- Human review should show raw values, nominal deltas, percent deltas, and an
  actionable impact scale so large noisy movements are not mistaken for proven
  PR regressions.

## Visualization

Reports must distinguish raw movement from actionable evidence.

- Raw delta and percentage are always shown.
- Actionable impact is only shown for gateable rows.
- Diagnostic rows render as `diagnostic`, not `0.00x`.
- Non-gateable paired wall-clock rows render as needing paired evidence.
- Noisy paired wall-clock rows render as uncertain, with neutral actionable
  impact, even when the raw percentage delta is large.

This prevents a large historical wall-clock delta from looking like a proven
PR regression when the measurement lacks causal evidence.

## External Tools

External benchmarking tools may complement this system, but they do not replace
the merge-gate contract.

- Bencher-like systems may store historical trends, apply threshold models, and
  provide dashboards.
- CodSpeed-like instrumentation may be useful for language-level benchmark
  suites whose execution model matches the tool.
- OTEL backends remain diagnostic evidence for explaining where time went.
- GitHub comments remain the human review surface for PR decisions.

For wall-clock PR gates, the authoritative evidence is still same-run paired
base/head samples emitted in `measurements.json`. For deterministic quantities,
the authoritative evidence is the comparable value and its configured budget.
