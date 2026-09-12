# 0031 Complexity Gate and Authority Ledger

Status: accepted

## Context

By 2026-09-12 the migration had changed shape without a decision: instead of
the roadmap's one-admission-per-change sequencing, a six-PR draft stack
(#1260–#1265, ~500 changed files, every PR net positive, chain non-linear,
all DIRTY against a `main` moving ~130 commits per four days) plus seven
consumer PRs pinned to a draft SHA carried the remaining surface. Its own ledger
read net +16,428 build-machinery lines (dotfiles' audit of upstream: +32,290 /
−973). BUCK-R15 required a recorded net ledger per phase reconciliation; none
existed in the repository, and the epic body (#1147) had become the de-facto
source of truth with nine contradictions against PR reality. The wall-clock
budgets held on `main` but PR CI ran force-cold, and no consumer had a single
Buck target on its default branch.

## Evidence and Argument

- Stack ledger measured with `gh pr view --json additions,deletions`
  (2026-09-12): #1260 +8772/−1962, #1261 +5904/−898, #1262 +1861/−1658,
  #1263 +9763/−3163, #1264 +985/−670, #1265 +1432/−383.
- dotfiles decision 0018 (`context/buck2-adoption/.decisions/0018`) already
  established that the ledger must be computed by a check and that a hard
  per-change budget punishes legitimately additive foundation changes.
- The Deletion Ledger was already an ontology term and BUCK-R09/R15/R16
  already required its rows; only the machine-readable contract and instance
  were missing. A migration-specific VRS node was rejected: VRS is timeless and
  plans derive from it.
- Structured questions q1, q2, q3, q9, q10, q12 answered by Johannes on
  2026-09-12 (decision tree `dev3.direct.omp.t3mkm4sd`).

## Options

| Decision    | Selected                                                           | Alternatives rejected                                                                                                                                                                    |
| ----------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hard gate   | Net complexity (BUCK-R15)                                          | Efficiency budgets first (accepts +16k with a rationale); coverage first (status quo: coverage did not predict complexity or CI time); consumer PR wall-clock as north star (unmeasured) |
| Gate unit   | Per repository at adoption close, plus cumulative at every close   | Per roadmap phase (hub-heavy phases are structurally additive; consumer deletions can mask hub growth)                                                                                   |
| Stack       | Land #1260 rebased with a recorded amortization; slice #1261–#1265 | Slice everything incl. #1260 (re-review cost, delays FOD deletion); land all with one exception; freeze until contraction                                                                |
| Ledger home | Instance in the composition root (megarepo-all); contract here     | Instance in effect-utils (private consumer facts would leak into a public repo); one file per repo with cross-repo aggregation                                                           |
| VRS shape   | Extend this node; no migration node anywhere                       | New timeless `build-authority` node in dotfiles (one consumer, splits contract from emitter)                                                                                             |

## Decision

1. Net complexity reduction is the hard gate of the adoption. Coverage
   (BUCK-R01) and the wall-clock budgets (BUCK-R07) are constraints with
   tolerances; when they conflict with BUCK-R15, BUCK-R15 wins.
2. The Deletion Ledger is machine-readable. Its contract lives in this node
   ([spec.md](../spec.md), "Authority Ledger"); its instance lives in the
   composition root that composes every consumer, next to the composition
   lock, because rows name private repositories. Progress views (the master
   epic) are rendered from the instance and hold no facts of their own.
3. The gate folds per repository at that repository's adoption close and
   cumulatively across repositories at every close. Per-change rows are
   advisory and may be net positive with a recorded amortization rationale.
4. The #1260–#1265 stack is not a unit. #1260 lands rebased on `main` with its
   own ledger row carrying the amortization rationale; #1261–#1265 are source
   material for value-ordered slices, each one admission with its ledger row,
   landed in the roadmap's shape. Consumer PRs are re-cut only against merged
   `main`.

## Consequences

- BUCK-R09, R15, R16 are amended in the same change.
- The roadmap loses its status prose: sequencing stays, state moves to the
  ledger instance.
- The check that computes rows and enforces the per-close fold is new
  machinery and appears in the ledger it computes.
- The migration has no VRS artifact of its own; when the last non-Buck row
  closes, nothing is deleted from the VRS.
- Consumers with one slice add a row and a deletion entry in their PR and
  author no VRS node; dotfiles keeps its delta node.
