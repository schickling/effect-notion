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
- **BUCK-R07 Capacity budgets:** The admitted surface holds a warm no-op check
  at ≤ 5 s and a fresh-context green with warm shared cache at ≤ 3 min. The
  watch-driven development loop holds an equivalent incremental budget: a single
  source edit rebuilds only its affected closure and republishes only the
  affected editor snapshots. Before an authority flip, its cache-disabled cold
  lane must also satisfy an accepted numeric wall-clock, peak disk/scratch,
  editor-snapshot disk and retention, staging/action p95, and marginal
  admission-slope envelope measured on the full candidate runner profile.
  Raising timeout or disk without changing and measuring that curve does not
  satisfy the gate; regression blocks further widening.
- **BUCK-R08 Disk anti-duplication:** Each normalized store identity may
  materialize its own package bytes once, shared by every consumer; only the
  entries whose selected dependency edges vary by platform own one such entry
  artifact per distinct configured variant. That set is derived from the
  lockfile at admission — ten entries in the current complete lock
  ([decision 0030](./.decisions/0030-normalized-store-scc-and-atomic-cutover.md)
  Amendment 1) — and is never a hard-coded constant. Archive/extract bytes
  remain shared. Importer and scratch overlays must not materialize dependency
  closure bytes per consumer, independent of filesystem CoW support.

### Must dissolve superseded systems

- **BUCK-R09 Deletion ledger:** Every admission names the devenv task, script,
  CI job, Nix builder, or install step it supersedes, and the transfer change
  deletes it. A subsystem with no dissolution condition is a design defect, not
  an exemption. Where an admission's superseded producer is repository-wide
  rather than package-scoped — the root install and the root TypeScript
  solutions — its staged prerequisites build in an explicitly named candidate
  namespace and one atomic change flips every consumer, editor, and tool
  surface and deletes the producer
  ([decision 0030](./.decisions/0030-normalized-store-scc-and-atomic-cutover.md)
  Amendment 1).
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

- **BUCK-R15 Net complexity accounting:** The adoption reduces global build
  complexity; growth in one place is justified only by larger deletion
  elsewhere. Every phase reconciliation records a net ledger of build-machinery
  lines added versus legacy lines deleted (excluding VRS documents, tests, and
  lockfiles) together with the amortization rationale across consuming
  repositories. A phase that increases the net ledger without a recorded
  rationale is a regression, not progress.
- **BUCK-R16 Benchmark evidence:** Efficiency claims are measured, never
  asserted. Each admission records warm no-op time; fresh-context time with a
  warm shared cache; cache-disabled cold-lane wall time; cache hits and local
  executions; peak `buck-out`, output, and scratch disk; retained
  editor-snapshot disk and generation count; staging/action p95; CI wall-clock
  delta; and the marginal time, disk, and action-count slope per admitted
  package. A staged measurement names the candidate namespace and isolation dir
  it ran in. A regression against BUCK-R07 or the recorded baseline blocks
  further widening until fixed or explicitly accepted in a decision.

### Must keep the development loop live

- **BUCK-R17 Watch-driven development loop:** Deleting an inner-loop producer
  requires its replacement in the same change. The admitted loop is a watch
  loop over the Buck daemon's file watcher plus atomic republication of the
  affected editor snapshots: a source edit rebuilds exactly the affected
  admitted closure and refreshes only the snapshots whose view fingerprint
  changed. The loop is an ordinary Buck caller — it holds no authority,
  interposes no launcher (BUCK-R01,
  [decision 0011](./.decisions/0011-direct-native-evidence-observation.md)),
  and a failed build or refused publication lock leaves the previous editor
  state intact and fails loudly rather than degrading to a partial surface.
