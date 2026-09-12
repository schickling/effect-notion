# Proposed: Cross-Repository Reuse Through Artifacts, Not Composed Cells

Status: proposed (PR-local; not in force). Reopens the "Product bridge only"
row of [decision 0014](../0014-megarepo-cell-composition.md) with evidence
that did not exist then.

## Context

The Buck2 adoption composes megarepo members as cells so that a consuming
repository builds a producer's targets from the shared cache with
source-granular invalidation (vision criterion 6; COMP-R01/R02; decision
0020's one-writable-mount shape; decision 0027's composed-by-default
worktrees). The investigation of 2026-09-12 asked whether a Buck2-native
mechanism makes megarepo redundant. It does not (decision 0030). It did
establish what the composition machinery costs and who uses it:

- `mr` is three things. L1, the worktree fleet (store, worktree per ref, GC
  with liveness veto): ~9.8k LOC, consumed by branchy, the agent-policy git
  wrapper, st2 seats, evergreen, fleet disk hygiene. L2, pin and arrange
  (`megarepo.kdl` → `megarepo.lock`, members at `repos/<name>`): ~4.4k LOC,
  consumed by ~30 pnpm `link:`/`file:` edges into `repos/effect-utils/packages/*`
  across 5 consumers, genie `#mr/` generator-source imports, Nix
  `workspaceSources` staging, CLIs run from mounts. L3, Buck2 cell composition
  (decision-0020 shape, cp -a/RENAME_EXCHANGE/R6 mounts, root generator,
  capability projection per mount, dist overlays): up to ~13–14k LOC by
  attribution (not a measured deletion), consumed today by effect-utils' own
  composed root only. No repository authors an `effect_utils//` label; Phase 6
  (dotfiles) has not started. 37 composed vs ~218 legacy workspace records
  exist; the shape migration is mid-flight.
- The practiced cross-repository flow is commit-mediated and upstream-first
  (decision 0020: one deliberate cross-workspace branch-sharing event in
  37,061 mutations; authoring through mounts vs member worktrees 1:820).
- Zero `@overeng/*` packages are consumed from a registry. 34 of 35 top-level
  effect-utils packages are `private: true` at placeholder `0.1.0`; 12 expose
  `types → dist`, 23 expose `src`; every consumer resolves types through
  per-consumer `tsconfig` `paths` shims into sources, not through `exports`.
- Artifact channels that exist today: `nix/buck2-products/publish.sh`
  publishes content-addressed CLI products to immutable GitHub Releases
  (sha256-tagged, manifest with SRI + provenance); diffstream publishes to
  GitHub Packages (restricted); livestore runs a full changeset + per-PR
  snapshot npm program. effect-utils' `npm-release` is decision-layer only
  (no I/O; DELTA-001).
- The overeng → livestore co-development fork is a branch-pinned mount reached
  through 86+ files (link: deps, tsconfigs into the mount's built dist, nested
  livestore-contrib composition). No artifact channel covers a co-dev branch.

## Evidence and Argument

- [2026-09-12-dist-tarball-channel](../../05-composition/.experiments/2026-09-12-dist-tarball-channel.md):
  an ordinary pnpm consumer installs `@overeng/tui-core` as a
  content-addressed dist tarball from the shared CAS (URL + sha512 integrity
  in `pnpm-lock.yaml`), tsgo resolves declarations from the installed dist,
  cold install 1.75 s, warm 0.13 s, one-byte drift refused at install. Gaps it
  exposed: `pnpm pack` produces an unusable artifact today (manifests describe
  the source layout), and bazel-remote is an evictable cache, not an origin.
- [2026-09-12-external-cell-key-stability](../../05-composition/.experiments/2026-09-12-external-cell-key-stability.md)
  and decision 0030: there is no Buck2-native way to get criterion 6 without
  mr's mount pipeline. The choice is therefore between keeping L3 and its
  shape for criterion 6, or reinterpreting criterion 6.
- Decision 0014 rejected artifact-only composition because "hot-path library
  deps pay package/import cycles". The measured practice is that every
  cross-repository change already pays a commit-and-repin cycle; what an
  artifact adds is one publish step, which the buck2-products channel already
  performs for CLIs without versions, changesets, or a registry.

## Options

| Option                                                          | Tradeoff                                                                                                                         | Outcome  |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Cells for source deps (decision 0014/0020, status quo)          | Action-level reuse and source-granular invalidation across repos; pays L3 + the 0020 shape on every Buck-admitted consumer         | Reopened |
| Git external cells as mounts                                    | Rejected in decision 0030                                                                                                        | Rejected |
| Artifacts for effect-utils library edges; cells paused (this)   | Deletes the need for cross-repo cells; adds a publish layout + durable origin; keeps mounts for fork co-dev and generator sources | Proposed |
| All edges as artifacts                                          | Needs per-commit fork-branch snapshots and a registry disposition nobody consumes; ruled out                                     | Rejected |
| Thinner L3 implementation, same contract (decision-0020 projector) | Keeps criterion 6; unmeasured savings; the shape and its migration remain                                                      | Fallback |

## Proposed Decision

1. Cross-repository reuse is artifact-granular. A consumer depends on a
   producer's Buck-built dist as a content-addressed tarball pinned in its
   `pnpm-lock.yaml` (URL + integrity) and fetched by the declared closure of
   decision 0022, or on a `BuildProduct` through the Nix bridge (BUCK-R10).
   The producer's action graph is not part of the consumer's graph.
2. Scope: the effect-utils library edges (~30 `link:`/`file:` edges, 5
   consumers) move to dist tarballs, package by package, each with a tested
   dist layout (`exports` → `dist`) and a deletion-ledger entry for the
   consumer's `link:` and `tsconfig` `paths` shim. Fork co-development
   (overeng ↔ livestore, livestore-contrib) and genie generator-source imports
   stay on L2 source mounts; they are outside Buck2 and outside this decision.
3. Durable origin: extend the buck2-products publisher (immutable
   content-addressed GitHub Release assets with manifest + provenance) to
   library dist modules; the shared CAS remains a fast transport, never the
   only home of a pinned artifact. A versioned npm registry is not required by
   this decision and not precluded by it.
4. Cross-repository Buck2 cell composition is paused, not retired: no new
   composed worktrees by default (decision 0027's composed-by-default reverts
   to standalone-by-default), the decision-0020 shape and its mr code stay
   supported and on `main`, the shape migration stops where it is, and no
   deletion-ledger entry is written for L3. Revisit trigger: a consumer that
   needs action-level cross-repository reuse, or upstream content-based
   external-cell keys (decision 0030).
5. The capability projection moves to a root-owned `capabilities//` cell in
   every root shape; the hub's three `//.buck2/capabilities` references become
   cross-cell labels. This is independent of 1–4 and should land first.

## What This Gives Up (explicitly)

- Vision criterion 6 as ratified: a consumer no longer builds producer targets
  from cache; it downloads a producer artifact. Reuse is whole-artifact, not
  per-action; invalidation across the edge is per-artifact, not per-source.
- Atomic cross-repository refactors within one composed graph. The flow is
  producer commit → publish → consumer repin, which is the practiced flow
  plus one publish step.
- COMP-R01/R02 as fleet-wide rules ("synthesized root everywhere", "one cell
  identity per repo across compositions") lose their reason; they would be
  narrowed to the paused composed shape.

## VRS Edits If Accepted

- `vision.md` (human-only): criterion 6 rewritten as artifact reuse; problem
  statement 4 ("composition does not compound") re-scoped.
- `requirements.md`: BUCK-R05 "across composition shapes" and BUCK-R06 scoped
  to one repository; BUCK-R08 gains the artifact-store obligation.
- `05-composition/requirements.md`: COMP-R01/R02 narrowed to the paused
  composed shape; a new requirement for the root-owned capability cell.
- `context/megarepo/requirements.md`: MR-R11 (composed default) reverted to
  standalone default; MR-R13 stays for the supported composed shape.
- Amendments: decision 0014 (row outcome), 0020 (shape paused), 0027
  (default reverted). Roadmap Phase 6 rewritten as "dotfiles consumes
  effect-utils dist artifacts under its own Buck2 root".

## Cost Ledger (BUCK-R15 inputs; document-grounded unless marked measured)

| Item | Exists today | Missing |
| --- | --- | --- |
| Tarball transport + pin + drift refusal | pnpm URL deps + integrity; CAS HTTP (measured) | — |
| Dist layout per package | 12/35 packages `types → dist`; `publishConfig` names shapes nothing builds | tested pack contract for 35 packages; 23 src-only packages need a dist |
| Durable origin | buck2-products publisher for CLIs (GitHub Releases) | library-module extension; retention policy |
| Consumer fetch under Buck2 | decision-0022 closure for registry entries | custom tarball URL entries (spike) |
| Consumer type shims | per-consumer `tsconfig` `paths` into sources | deleted per migrated package |
| Repin step | `mr` lock-sync ↔ `flake.lock` (proven in dotfiles) | source commit ↔ artifact hash mapping in the consumer lockfile |
| L3 deletion | — | none now (paused, not retired) |

## Falsification Spikes (before acceptance)

1. Decision-0022 closure fetching a pnpm-lock tarball-URL entry into a Buck
   `node_modules` assembly (the census notes 0022 covers registry entries).
2. One src-only package (`@overeng/utils`) given a tested dist layout,
   packed by a Buck target, published through buck2-products, consumed by
   dotfiles with its `tsconfig` `paths` shim deleted, typechecked under
   dotfiles' own Buck2 root. Measure fresh-context time against BUCK-R07.
3. The root-owned `capabilities//` cell in effect-utils' own root (item 5).
4. BUCK-R15 ledger for spike 2: lines added (pack target, publisher extension,
   consumer lock change) vs lines deleted (shim, link:, overlay manifest entry).

## Open Questions

- Does any consumer need per-action reuse of effect-utils targets (tests,
  rust products) rather than dist artifacts? None is known; this is the
  revisit trigger of item 4.
- Do `@overeng/*` packages ever leave the fleet (public registry) — if so the
  content-addressed origin needs a versioned front, and livestore's program is
  the template.
