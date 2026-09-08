# Experiment: Bencher evaluation

This experiment informs
[../measurement-engine.md](../measurement-engine.md).

## Question

Date: 2026-05-19.

Purpose: evaluate whether Bencher should replace or complement the
GitHub-native CI measurement gate.

### Setup

The experiment used a local self-hosted Bencher instance and synthetic metrics
that mimic our current measurement families:

- wall-clock duration;
- deterministic Nix closure size;
- deterministic store path count;
- diagnostic counters.

Commands exercised:

```bash
docker run --rm ghcr.io/bencherdev/bencher --version

bencher up --detach --pull missing \
  --console-port 33080 \
  --api-port 61018 \
  --console-env BENCHER_API_URL=http://localhost:61018

bencher run --host http://localhost:61018 \
  --project effect-utils-ci-measurements \
  --branch main \
  --testbed github-ubuntu-latest \
  --adapter json \
  --file measurements-base.json \
  --format json

bencher run --host http://localhost:61018 \
  --project effect-utils-ci-measurements \
  --branch pr-658 \
  --start-point main \
  --start-point-clone-thresholds \
  --start-point-reset \
  --testbed github-ubuntu-latest \
  --error-on-alert \
  --adapter json \
  --file measurements-head.json \
  --format json
```

### Findings

Bencher worked well for:

- storing historical benchmark rows by project, branch, testbed, benchmark,
  and measure;
- cloning thresholds from a main start point into a PR branch;
- failing CI through `--error-on-alert`;
- percentage thresholds for coarse performance trend alerts;
- static thresholds for simple absolute deterministic budgets;
- multi-measure reports through Bencher Metric Format JSON;
- local self-hosting through Docker.

Bencher did not model our primary wall-clock gate:

- same-run base/head paired samples are not first-class;
- multiple files in one report become iterations, not paired comparisons;
- alerting compares scalar metric values against thresholds;
- stored lower/upper metric fields are not treated as paired evidence
  intervals for gating;
- comments and checks would be Bencher-shaped alerts, not our semantic PR
  report with paired `n` and delta evidence intervals.

### Decision

Bencher is not the authority for PR merge gates.

Allowed use:

- optional trend backend;
- historical dashboards;
- coarse scheduled alerts;
- export target for already-computed metrics, including paired summary metrics
  and deterministic budget ratios.

Disallowed use:

- replacing the GitHub-native PR comment;
- replacing paired wall-clock gate decisions;
- replacing deterministic budget evaluation when budgets are metric-specific.

The native `ci-measure` engine should own gate semantics. A future Bencher
exporter can publish selected observations after `ci-measure compare` has
produced the authoritative decision.
