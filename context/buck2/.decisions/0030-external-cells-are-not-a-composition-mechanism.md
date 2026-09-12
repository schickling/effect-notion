# 0030 Buck2 Git External Cells Are Not a Member-Mount Mechanism

Status: accepted

## Context

The question "do we still need megarepo now that Buck2 is landing" has one
Buck2-native candidate that decision 0020's adversarial review never
evaluated: `[external_cells] <member> = git`, Buck2 fetching a member at a
pinned `commit_hash` into `buck-out` instead of mr materializing a `cp -a`
mount. If it worked under the composition contract it would delete mr's mount
pipeline (cp -a, RENAME_EXCHANGE, R6, protection, teardown), the lock's
mount-source role, and the per-mount capability and dist-overlay projections.

## Evidence and Argument

Four records of 2026-09-12 in
[05-composition/.experiments](../05-composition/.experiments/):

- [external-cells-source-facts](../05-composition/.experiments/2026-09-12-external-cells-source-facts.md):
  at the pinned release, external-cell sources resolve to the physical
  `buck-out/<iso>/external_cells/git/<commit>/…` path, which enters the input
  Merkle tree; fetch is a PATH `git` subprocess per project root, whole tree,
  no sharing, no submodules, no nested cells; upstream's own e2e test asserts
  the resulting over-invalidation and defers a content-based fix with no
  tracked plan.
- [external-cells-fixture](../05-composition/.experiments/2026-09-12-external-cells-fixture.md):
  cross-cell load and deps work; an unrelated commit bump reruns a member
  action with identical output; a second project root refetches; no
  accepted-and-content-real live override exists.
- [external-cell-key-stability](../05-composition/.experiments/2026-09-12-external-cell-key-stability.md):
  with cell name, path, label, platform, and isolation dir byte-identical, the
  external cell's action digest differs from the on-disk cell's; the hidden
  (non-argv) input case reruns on an unrelated bump while the on-disk cell runs
  zero commands. This is the direct negation of COMP-R02 (one cache namespace
  per repo) and vision criterion 6 for every source-consuming action.
- [hub-as-external-cell](../05-composition/.experiments/2026-09-12-hub-as-external-cell.md):
  the real hub's platforms package is consumable externally; its toolchains
  package is not, because `buck2/toolchains/BUCK:1` and
  `configured.bzl:5,59` load the per-host `//.buck2/capabilities` projection
  from inside the member — a fetched cell has no channel for it.

Two operational facts stand independently: the agent-policy git wrapper
refuses Buck2's internal `git reset --hard FETCH_HEAD`, and a first cold fetch
of effect-utils from the local bare store exceeded 120 s.

## Options

| Option                                                    | Tradeoff                                                                                      | Outcome  |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------- |
| Keep cp -a mounts (decision 0020) for any cross-repo cell | Content-real, key-stable, shared store; mr owns the mount pipeline                            | Accepted |
| Git external cells as member mounts                       | Commit-keyed physical paths split the cache namespace; no store; no projection channel        | Rejected |
| External cells for the hub's rules/platforms only         | Viable only after the capability projection moves to a root-owned cell; no action inputs read | Deferred |

## Decision

Git external cells are not admitted as a member-mount mechanism under
05-composition. Where a composition needs another repository's _sources_ as
action inputs, the mount is an on-disk content-real directory (COMP-R08/R10)
and mr materializes it. External cells remain admissible in Buck2's designed
role — the bundled prelude and immutable third-party inputs that no action
reads as `srcs` at member-mount scale — and become a candidate for
rules-only hub distribution once the capability projection is root-owned.

Revisit when either holds: upstream keys external-cell sources by content
(the e2e assertion in `tests/core/external_cells/test_git.py` flips), or the
hub's `//.buck2/capabilities` references move to a root-provided
`capabilities//` cell. The first would reopen mounts; the second only the
rules-distribution role.

## Consequences

- No change to COMP-R08/R10, decision 0020, or mr's mount pipeline from this
  decision alone. What changes the mount pipeline's _scope_ is the separate
  proposal [.proposed/artifact-composition.md](./.proposed/artifact-composition.md),
  which asks whether Buck2 should compose cells across repositories at all.
- The root-owned capability cell is recorded as an open question in
  05-composition; it is the right ownership boundary in every option and
  should not wait for the rules-distribution use case.
- The git-wrapper refusal of Buck2-spawned git is filed as agent-policy
  friction; any future external-cell use needs that exemption first.
