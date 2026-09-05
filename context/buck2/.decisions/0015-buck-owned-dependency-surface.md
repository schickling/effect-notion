# 0015 Buck-Owned Dependency Surface Including the Editor View

Status: accepted

## Context

Dependency state had two possible steady shapes: a dual surface (root
`pnpm install` for editors, Buck materializations for builds) or Buck owning
everything with no hand-run install. The dual surface permanently carries the
silent-drift class the ecosystem has failed to fix (aspect rules_js #854, open
since 2023: builds work or intellisense works, never both without a second
uncontrolled install).

## Evidence and Argument

Prototypes and a competitive benchmark (two independent agents, identical
7-scenario protocol on real packages; retained in
[../03-materialization/.experiments/](../03-materialization/.experiments/))
established:

- Per-package materialization is a 1–3 s Buck action from a manifest-only
  skeleton (`pnpm deploy --offline`): no source file is an input, so no source
  edit invalidates a dependency tree. Determinism holds after fixed-path
  staging and normalization of an enumerable impurity set.
- The editor surface works through a two-hop stable symlink flipped by
  `rename(2)` over `cp -al` snapshots (zero dangling window); a live tsserver
  survives flips without restart; vitest runs through the view.
- The two blocking caveats were resolved: workspace siblings become live source
  symlinks (the symlink-back fix — inner-loop parity with the root install:
  one action, no rebuild, no restart), and the invalidation flake was
  root-caused to the `notify` file watcher (deterministic under watchman plus a
  content settle step; 10/10 lockfile edits converged).
- The remaining honest cost concentrates at manifest-change events: dep changes
  ~2–3x slower, branch-switch reconvergence 44–79 s versus ~3 s, bootstrap
  ~20 s versus ~3 s — driven by the shared manifest skeleton invalidating every
  cell. The named fix is per-cell pruned-lockfile keying (deploy emits a
  per-package pruned lockfile; keying each cell's install on it stops
  unrelated manifest churn from fanning out).
- The status quo's structural defect is unrepairable in kind: a removed dep
  leaves local dev silently green (phantom dependency), and `tsgo --build`'s
  up-to-date check ignores node_modules content entirely, so nothing surfaces
  the drift. Guards can detect it; only Buck ownership couples detection to
  repair.
- In this repository the root install's only job is the symlink forest — root
  `node_modules` holds no top-level packages and no `.bin`; Nix owns all
  tools. The surface being replaced is small and mechanical.
- Disk is not a differentiator: deploy trees hardlink-share through the pnpm
  store (measured: six trees summing to 2.3 GB occupy 660 MB).

## Options

| Option                                      | Tradeoff                                                                                   | Outcome  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ | -------- |
| Buck owns all; cutover gated on fan-out fix | Single authority, drift impossible silently; rare events slower until the keying fix lands | Accepted |
| Commit immediately, fix in flight           | Fastest to single authority; first impressions formed on 44–79 s branch switches           | Rejected |
| Dual surface as end-state                   | Fast manifest events; permanent silent-drift class and two lockfile projections            | Rejected |

## Decision

Buck owns dependency materialization end to end, including the editor surface;
manifests and the lockfile are the only hand-authored dependency inputs
(BUCK-R11). The editor-surface cutover is an authority transfer under
BUCK-R12, gated on: (1) per-cell pruned-lockfile keying built and measured to
remove the manifest-change fan-out, and (2) a real-editor soak on one package.
Until the gate passes, the root install is transitional and carried in the
deletion ledger. Materialization actions are `local_only`: pnpm's virtual-store
keys embed absolute paths, so node_modules trees are not portable across
machines; cross-machine caching applies to the actions consuming them.

## Consequences

- The drift class exits the system at cutover; a stale surface fails loudly
  (vision criterion 8).
- Manifest-change latency is a watched budget, not an accepted regression:
  the keying fix is gate work, and BUCK-R07 applies.
- Store wiring must be explicit (`--store-dir`; `PNPM_STORE_DIR` is ignored)
  and same-filesystem so hardlinking holds (BUCK-R08).

## Amendment 1

The de-risk investigation
([../03-materialization/.experiments/2026-08-26-pruned-lockfile-keying.md](../03-materialization/.experiments/2026-08-26-pruned-lockfile-keying.md))
found the measured fan-out's root cause was an output-normalization bug (an
unstripped JSON `prunedAt` timestamp plus the self-referential in-tree pruned
lockfile), not keying: fixing normalization alone stops the consumer cascade
with no graph change. It also corrected the mechanism: the pruned lockfile is
the deploy's install byproduct, its raw bytes are key-unusable under pnpm's
peer-range re-serialization, and only a canonicalized form keys soundly. The
cutover gate is accordingly restated (q10, 2026-08-26): (1) the normalization
fixes land first and independently; (2) the two-stage prune->install split
keyed on the canonicalized pruned lockfile is the end-state mechanism
(DEPS-R07 keeps the literal reading: bounded action count and no per-touch
rewrite of every tree); (3) the real-editor soak stands unchanged.

## Amendment 2

The two-path portability proof
([../03-materialization/.experiments/2026-08-26-two-path-materializer-portability.md](../03-materialization/.experiments/2026-08-26-two-path-materializer-portability.md))
falsified the decision's categorical premise that pnpm virtual-store paths make
the admitted tree non-portable. After removing non-runtime `storeDir` metadata,
normalizing stage paths, and rejecting non-contained links, forced
materializations in two checkout paths of different lengths produced
byte-identical trees (digest `88625db383ba0277b805cd4332bd9b4a478a838bfb7e0f57ce47f10143494759`)
with zero differing entries or absolute worktree/store residues.

The corrected cache policy (q5, 2026-08-26) keeps pnpm execution
`local_only`, but permits upload and reuse of both the path-canonical prune
descriptor and the normalized tree action results.
Execution-platform configuration separates incompatible platforms; the
evidence currently admits same-platform Linux x86-64 reuse for the tui-core
tuple, not cross-platform equivalence. Other platform tuples require their own
portability proof before making the same claim. This correction lets BUCK-R06
apply literally to the admitted tuple instead of exempting materialization.

Workspace live-source links remain an editor-realization concern outside the
cacheable contained tree. This amendment does not weaken DEPS-R02 link
containment or accelerate the Phase-4 editor-surface cutover.

## Amendment 3

Superseded in mechanism by
[decision 0022](./0022-lockfile-derived-declared-closure.md) on 2026-08-30. The
authority claim stands — Buck owns dependency materialization end to end and
manifests plus the lockfile are the only hand-authored inputs — but the
pnpm-in-action mechanism (deploy prune, frozen install against an ambient
store, deploy normalizer, install descriptor) is retired in favor of a
lockfile-derived declared closure. Amendment 1's cutover gate items (1) and (2)
are moot under the new mechanism; item (3), the real-editor soak, stands. The
Consequences line requiring an explicit same-filesystem `--store-dir` no longer
applies: there is no ambient store.

## Amendment 4

Date: 2026-09-04. The editor-surface cutover is absorbed into the single
whole-repository authority flip of
[decision 0030](./0030-normalized-store-scc-and-atomic-cutover.md) Amendment 1.
Amendment 1's item (3), the real-editor soak, has passed; the remaining
condition is no longer "whole-required-consumer coverage of the dependency
surface" as a separate Phase-4 event but whole-repository consumer, editor, and
tool coverage flipped at once, with the root install and its task edges deleted
in that change. The authority claim of the Decision is unchanged.

The inner-loop parity argument that motivated the symlink forest is now
discharged by a mechanism rather than by the root install: a Buck watch loop
rebuilds the affected admitted closure and republishes the affected byte-owned
editor snapshots atomically (decision 0030 Amendment 1 item 5). The Decision's
reason for local placement is retired — decision 0022 removed the ambient store
and Amendment 2 falsified the non-portability premise — but placement stays
local because true remote execution is unproven: `remote_enabled` remains false
pending 03-materialization DQ3, which decision 0030 Amendment 1 puts out of
scope for this cutover.
