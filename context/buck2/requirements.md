# Buck2 Repository Build Requirements

## Context

These requirements are the cross-cutting invariants of the Buck2 repository
build system. Each subsystem owns its detailed requirements and refines the
invariants named in its own document:

- [01-semantic-graph](./01-semantic-graph/requirements.md) owns authored intent
  and its projection into the Buck graph.
- [02-execution](./02-execution/requirements.md) owns platforms, toolchains,
  and admitted action semantics per language.
- [03-materialization](./03-materialization/requirements.md) owns dependency
  materialization for actions and for the editor surface.
- [04-reuse](./04-reuse/requirements.md) owns the shared cache and reuse
  criteria.
- [05-composition](./05-composition/requirements.md) owns megarepo cell
  composition and action-identity stability.
- [06-nix-bridge](./06-nix-bridge/requirements.md) owns `BuildProduct` and
  independent Nix import.

## Assumptions

- **BUCK-A01 Buck execution truth:** Buck's configured graph, action keys,
  event log, and build report are authoritative for Buck analysis and execution.
- **BUCK-A02 Nix authority:** Nix owns immutable tool and input recipes, Nix
  store import, and system realization.
- **BUCK-A03 Consumer authority:** The system consuming an imported product owns
  deployment, activation, rollback, health, secrets, and fleet policy.
- **BUCK-A04 Ecosystem authority:** Package manifests and lockfiles remain the
  semantic dependency request authority even after ecosystem build and install
  commands cease to be producers.
- **BUCK-A05 Single-operator trust:** The fleet is operated by one principal;
  every machine and CI runner inside the Tailscale boundary is trusted with
  repository write access, and cache trust follows that boundary
  ([decision 0013](./.decisions/0013-shared-cache-foundation.md)).

## Acceptable Tradeoffs

- **BUCK-T01 Conservative input closure:** An operation may initially declare a
  measured, visible superset of inputs when it never omits a result-affecting
  input and has an explicit refinement path.
- **BUCK-T02 Version-bound evidence adapter:** Rich Buck event-log decoding may
  be pinned to the admitted Buck version while stable build-report fields remain
  tolerant of additive change.
- **BUCK-T03 Transitional producers:** A superseded producer may run in parallel
  with its Buck candidate before authority transfer. The transfer change deletes
  it; the parallel period is bounded by the roadmap, never steady state.

## Requirements

### Must preserve narrow authority

- **BUCK-R01 Sole producer endgame:** Buck is the terminal authority for every
  bounded deterministic repository-local operation. Admission proceeds slice by
  slice in value order ([roadmap](./roadmap.md)); each admitted slice has Buck
  as its only producer and gate, and no slice retains a permanent fallback
  ([decision 0001](./.decisions/0001-exclusive-buck-authority.md)).
- **BUCK-R02 Bounded operation:** Admission names an operation whose inputs,
  outputs, failure semantics, target platform, and execution platform are
  finite and deterministic. Live effects are outside Buck success.
- **BUCK-R03 Directional boundary:** Nix may provide inputs and verify, import,
  wrap, and compose a `BuildProduct`; Buck actions must not evaluate Nix or
  mutate live dependency or system state.
- **BUCK-R04 Hermetic execution:** Admitted actions use declared providers and
  inputs, avoid ambient `PATH` and package-manager state, and fail closed on
  undeclared access or incompatible identity.

### Must deliver reuse and speed

- **BUCK-R05 Exact portable identity:** An action identity contains every
  result-affecting source, dependency closure, configuration, toolchain,
  platform, and policy input, excludes irrelevant host state, and is stable
  across worktrees, machines, and composition shapes
  ([05-composition](./05-composition/requirements.md)).
- **BUCK-R06 Shared reuse:** Admitted actions read and write the shared remote
  action cache. A second same-platform context at an identical revision
  re-executes zero actions for unchanged admitted targets; a violation is a
  key-stability regression ([04-reuse](./04-reuse/requirements.md)).
- **BUCK-R07 Wall-clock budgets:** The admitted surface holds a warm no-op
  check at ≤ 5 s and a fresh-context green with warm shared cache at ≤ 3 min.
  Admission widening that breaks a budget is a regression to fix before
  widening further.
- **BUCK-R08 Disk anti-duplication:** Dependency and output materialization
  must not duplicate bytes per worktree where a shared content-addressed store
  or hardlink mechanism exists. Buck-owned state (`buck-out`, isolation dirs)
  carries the same anti-duplication obligation as the pnpm store contract.

### Must dissolve superseded systems

- **BUCK-R09 Deletion ledger:** Every admission names the devenv task, script,
  CI job, Nix builder, or install step it supersedes, and the transfer change
  deletes it. The ledger is machine-readable: one row per operation per
  repository, held in the composition root (the megarepo that composes every
  consumer) and rendered — never hand-typed — into any progress view
  ([decision 0030](./.decisions/0030-complexity-gate-and-authority-ledger.md)).
  A subsystem with no dissolution condition is a design defect, not an
  exemption.
- **BUCK-R10 FOD dissolution:** Admitted repository-local tools reach Nix
  consumers only through product import; their dependency closures cause zero
  fixed-output hash maintenance.
- **BUCK-R11 Dependency authority:** Buck owns dependency materialization end
  to end, including the editor surface. Manifest and lockfile state is the only
  hand-authored dependency input; a stale materialized surface fails loudly
  before it can produce a wrong result
  ([decision 0015](./.decisions/0015-buck-owned-dependency-surface.md) for
  authority; [decision 0022](./.decisions/0022-lockfile-derived-declared-closure.md)
  for mechanism).

### Must be observable and provable at the right moments

- **BUCK-R12 Evidence at transfer:** Authority transfer — the change that
  deletes a superseded producer — requires fail-closed proof of hermeticity,
  invalidation causality, and (where products cross the bridge) independent
  import for the exact tuple. Outside transfer moments, gates are ordinary CI
  green plus the budget criteria; richer evidence (OTel correlation, admission
  envelopes, conformance fixtures) is advisory
  ([decision 0016](./.decisions/0016-evidence-rigor-at-transfer.md)).
- **BUCK-R13 Native evidence and telemetry independence:** Buck-native evidence
  remains execution truth. Telemetry links to it without replacing it; export
  failure never changes Buck's result; metrics carry only bounded attributes.
- **BUCK-R14 Portability hygiene:** Shared rules, schemas, and fixtures contain
  no repository-private paths, labels, fleet names, endpoints, or secrets, so a
  second consumer can extract them without rework. Extraction mechanics are
  decided when that consumer adopts, not before.

### Must reduce global complexity measurably

- **BUCK-R15 Net complexity gate:** The adoption reduces global build
  complexity; growth in one place is justified only by larger deletion
  elsewhere. The ledger (BUCK-R09) carries, per row, build-machinery lines added
  versus legacy lines deleted (excluding VRS documents, tests, and lockfiles).
  The gate is hard and folds per repository: when a repository's residual
  non-Buck gate list reaches zero (its adoption close), the sum of its rows must
  be negative, and at every such close the cumulative sum across all repositories
  must be negative; a violation blocks widening to the next repository. A single
  change may be net positive when its row records the amortization rationale
  (which later deletion pays for it); the per-change signal is advisory, the
  per-close gate is not
  ([decision 0030](./.decisions/0030-complexity-gate-and-authority-ledger.md)).
  When BUCK-R15 conflicts with coverage (BUCK-R01) or the wall-clock budgets
  (BUCK-R07), BUCK-R15 wins: the others are constraints with tolerances.
- **BUCK-R16 Benchmark evidence:** Efficiency claims are measured, never
  asserted. Each admission's ledger row records warm no-op time, fresh-context
  time with a warm shared cache, cache hit rate for unchanged targets, and CI
  wall-clock delta against the pre-admission baseline. A regression against the
  BUCK-R07 budgets or the recorded baseline blocks further widening until it is
  fixed or explicitly accepted in a decision record.
