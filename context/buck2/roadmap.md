# Buck2 Adoption Roadmap

Derived, non-timeless sequencing. The VRS describes the system; this file
describes the order in which authority moves and what each move deletes.
Supersedes the lane/PR plan embedded in
[decision 0012](./.decisions/0012-vertical-slice-replay-phase.md) and the
roadmap formerly referenced from
`context/dependency-materialization/05-buck2-evidence/`.

## Sequencing principle

Whole-repo exclusivity is the endgame (BUCK-R01); admission order is by value:
expensive, high-leverage operations first, cheap operations when migrating them
provably pays. Every step lands its deletion-ledger entry in the same change.

## Phase 0 — shared cache foundation (external dependency)

- bazel-remote cache-only service on dev3: dotfiles#2009. Consumer trust and
  admission sequencing: effect-utils#1054.
- Client contract facts are recorded in
  [decision 0013](./.decisions/0013-shared-cache-foundation.md).

## Phase 1 — vertical slice with reuse (tui-core)

- Cache wiring first: the config-only diff (executor cache fields + SHA256 +
  upload defaults + devenv-generated `.buckconfig.local`), the
  `--no-remote-cache` flags deleted from the buck2 devenv tasks, and the
  validated two-worktree canary run against the deployed service.
- tui-core typecheck under Buck2 using the validated tsgo rule and
  manifest-only `pnpm deploy` materialization; its devenv check path deleted
  in the same change (first deletion-ledger entry) via the spiked partition
  mechanism
  ([02-execution/.experiments/2026-08-26-check-surface-partition.md](./02-execution/.experiments/2026-08-26-check-surface-partition.md)):
  `exports` gains a `types -> dist` condition, references drop from the five
  dependents and BOTH root solutions (check and emit), and CI materializes the
  Buck2 artifact before `ts:check:strict` — the ordering gate without which
  the transfer is fictional.
- Implementation contraction lands with or before the slice: exactly 3,915
  lines are deleted — 2,390 evidence-regime lines under `scripts/buck2-*`
  (`dcbf241fa`); 1,494 synthetic-producer and input-plan lines under
  `buck2/evidence`, `genie/buck2`, and `packages/@overeng/tui-core/buck2`, plus
  their projection wiring (`95e4e171d`); and 31 replaced TypeScript check-path
  lines in root and dependent configs (`a19b24deb`). These commits and paths are
  the measurement sources; PR #1080 closes (built on the rejected
  Nix-materialized-deps authority), #1081 parks as Phase 5 reference.
- Measured against BUCK-R07 budgets; BUCK-R06 zero-re-execution proven via the
  canary runbook.
- Product path retained: strict v1 product -> independent Nix import (existing
  bridge tests).

**Milestone completed 2026-08-26.** The integrated gate is recorded in
[2026-08-26-tui-core-authority-transfer.md](./02-execution/.experiments/2026-08-26-tui-core-authority-transfer.md):
representative failure, relevant/irrelevant causality, hostile environment,
strict task ordering, and fresh-context cache reuse all pass. Deletion-ledger
entry 1 removes tui-core from both root TypeScript solutions and deletes the
synthetic `buck2_foundation` / `typescript_input_plan` evidence producers; the
remaining `buck2:check` lane builds the real tui-core TypeScript action plus
the retained archive/product toolchain surface and is non-vacuous. The dormant
closure compiler and package-evidence pair are deleted because their evidence
regime retired before any live target admission; expiry is therefore
irrelevant. Warm unchanged execution is zero actions; a wiped second worktree
reported five cached actions and zero local actions, within BUCK-R07 budgets.

## Phase 2 — one-writable-mount workspaces

Architecture per [decision 0020](./.decisions/0020-one-writable-mount-workspaces.md)
(accepted 2026-08-27 after the e2e, adversarial, and workspace prototypes):
the store worktree path becomes the workspace root; every repo incl. the
owned one is a member cell at `repos/<name>`; the owned repo is the single
writable branch worktree; other members are read-only `cp -a` mounts with
RENAME_EXCHANGE advance.

- S0 guards FIRST: loud non-zero on non-symlink mounts; refuse to delete
  foreign real directories (18 exist).
- mr code change for the `CI=true` silent-detach trap (loud diagnostic or
  refusal).
- mr workspace materialization + composition-root generator (validated shapes
  per the 2026-08-26/27 experiments in 05-composition), incl. the six-point
  regeneration contract, capability-projection copy + `--check`, per-member
  `[project] ignore` audit, and workspace teardown command.
- Member portability in effect-utils: label rewrites, cross-cell visibility
  in genie's projection, delete the member `.buckconfig`.
- macOS verification: DONE 2026-08-27 (decision 0020 Amendment 1) — Darwin
  admission proceeds; cp -a clones on APFS (~0 disk); R6 post-condition
  mandatory on Darwin. Still gating the Darwin ADVANCE path only: FSEvents
  invalidation confirmation in a real login session, and the darwin digest
  probe on a profiled Mac worktree.
- tierA-scale build validation (fixture-scale digest claims are exact but
  small); root-cause the genrule lookup/upload key-mismatch anomaly.
- Production composition cutover: DONE 2026-08-28 on Linux x86_64. A fresh
  decision-0020 workspace built the real five-action tui-core tuple with 100%
  shared-cache hits and no local execution
  ([evidence](./05-composition/.experiments/2026-08-28-production-composition-cutover.md)).
- Legacy in-mount write consumers retire per consuming repository during its
  Phase-6 workspace adoption. Until then, that repository remains on
  symlink mounts with shared-cache writes disabled.

  | Consumer class                                  | Retirement change                                                                                                   | Admission proof                                                                          |
  | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
  | CLI executed from another member's source mount | Execute the already-packaged Nix CLI; dotfiles' bun-from-mount path is the first standalone cutover                 | Command succeeds with the source mount protected and unchanged                           |
  | Dependency task that writes another member      | Move the producer into that member's owned workspace; consume only committed source plus declared artifact overlays | Mutation sentinel remains clean across apply, task execution, and teardown               |
  | Live cross-workspace branch sharing             | Commit upstream in its owned workspace, advance the consumer lock, then re-apply                                    | No non-owned mount is branch-attached; the lock advance alone changes the consumer input |

  Each consumer owns its deletion-ledger entry and removes the symlink/no-cache
  exception in the same change that passes its admission proof.

- Cross-member TypeScript consumption: SETTLED as
  [decision 0021](./.decisions/0021-cross-member-types-dist-overlay.md) —
  dist overlay in mounts (cache-pulled, ignore-covered, manifest-declared);
  source aliasing across members retires when the overlay lands.
- Decision-0021 deletion ledger: the overlay landing retired cross-member
  source aliasing as an admitted consumption mechanism. It deleted no
  effect-utils producer because the surviving aliases are consumer-owned;
  each consumer deletes its alias configuration with its Phase-6 admission,
  as required by the ledger at lines 94–101.
- Agent workflow contract rev 3 (authoring surface = the owned member;
  `repos/<other>` is a read-only build input); skill updates in dotfiles.
- Standalone-vs-composed and writable-vs-mount key stability hold per
  decisions 0014/0020; CI moves to the workspace shape.

## Phase 2b — declared dependency closure

- End-state per [decision 0022](./.decisions/0022-lockfile-derived-declared-closure.md):
  genie translates `pnpm-lock.yaml` into per-package fetch/extract targets and
  per-importer assembly targets; no ambient store, no install step, no deploy
  normalizer, no install descriptor.
- Built behind the two admitted packages (tui-core, tui-react) and landed with
  the Phase-2 cutover PR so the superseded provider never reaches `main`
  (q3, 2026-08-30). Deletion-ledger entry: `pnpm-deploy-normalizer.ts`,
  `pnpm-install-descriptor.ts`, `buck2-materializer.ts`, most of
  `materialization.bzl`, the ambient store warm lane, and the CI store cache
  lane.
- Closes the Phase-2 locked-member gate: there is no store to be read-only.
- Gates: sha256 sidecar generated and freshness-gated; cpu/os `select()`
  filtering; fresh-context budget (BUCK-R07) re-measured against the slower
  cold bootstrap; benchmark record per BUCK-R16.
- CI starts with registry downloads per run; caching is refined later (q4).

## Phase 3 — TypeScript surface widening

- The coverage-asserted registry in `genie/tsconfig-projects.ts` has exactly 38
  root projects. The whole-repository cutover candidate admits all 38 and
  leaves no staged blocker. It deletes both root TypeScript solutions, the root
  install task and its task edges, and every legacy package-scoped TypeScript
  check/build edge in the same atomic change.
- **Sequencing superseded 2026-09-04** (decision 0030 Amendment 1). The seven
  completed layer admissions below remain as recorded history. Issue #1212
  showed that per-consumer closure cost made incremental widening economically
  unusable, so the remaining 31 projects moved together through Phase 4 instead
  of landing one dependency layer at a time.

- Admission 2 transfers `@overeng/tui-react` typecheck and declaration emit to
  `//packages/@overeng/tui-react:typecheck` and
  `//packages/@overeng/tui-react:dist`. Its package tree consumes tui-core only
  through `effect_utils//packages/@overeng/tui-core:dist`; utils and utils-dev
  enter as explicit content-tracked source siblings, with their required
  external modules provided by the package-local Buck `node_modules`
  materialization. Export type conditions and the member dist overlay point at
  Buck declarations, while runtime export defaults remain at source.
- Deletion-ledger entry 2 removes tui-react from both root TypeScript producers:
  the `tsconfig.check.json` solution used by `ts:check` and the
  `tsconfig.emit.json` solution used by `ts:build`. The six surviving dependent
  project-reference edges are deleted, and tui-react's ordinary editor config
  is write-free; dependents resolve its declarations through package exports.
  The Buck-only project config resolves its declared workspace inputs from the
  assembled package tree. The editor root install remains transitional until
  Phase 4 and is deliberately not deleted by this admission.

- The first dependency-layer admission transfers `@overeng/utils-dev` and
  `@overeng/stylex-preset` to their package-local Buck `typecheck` and `dist`
  targets. Each package keeps source runtime defaults while its TypeScript
  exports consume Buck declarations.
- The utils-dev deletion-ledger entry removes it from both root solutions,
  deletes 25 dependent project-reference edges, and changes tui-react's Buck
  package tree from a utils-dev source sibling to its `dist`. The stylex-preset
  entry deletes its two dependent project-reference edges; it had no prior root
  solution entry or standalone package check/build task. Both ordinary
  tsconfigs are write-free. The integrated gate and package-specific evidence
  are retained in
  [`2026-09-02-foundation-layer-authority-transfer.md`](./02-execution/.experiments/2026-09-02-foundation-layer-authority-transfer.md).

- The middle dependency-layer admission transfers `@overeng/content-address`,
  `@overeng/effect-distributed-lock`, and `@overeng/otel-contract` to Buck. All
  three leave both root solutions, their 17 dependent project-reference edges
  are deleted, and their public type conditions consume Buck declarations while
  runtime defaults remain at source.
- The package trees replace authoritative workspace source siblings with
  same-cell `dist` edges: content-address and effect-distributed-lock consume
  utils-dev, while otel-contract consumes content-address and utils-dev. Each
  package's ordinary tsconfig is write-free. The integrated gate,
  package-specific mutation controls, budgets, and individual deletion ledgers
  are retained in
  [`2026-09-02-middle-layer-authority-transfer.md`](./02-execution/.experiments/2026-09-02-middle-layer-authority-transfer.md).

- The utils dependency-layer admission transfers `@overeng/utils` to Buck. It
  leaves both root solutions, all 16 dependent project-reference edges are
  deleted, and all 13 public type conditions consume Buck declarations while
  runtime defaults remain at source.
- tui-react replaces its content-tracked utils source sibling with the utils
  `dist` edge. The ordinary utils tsconfig is write-free. The mutation control,
  cache budgets, hostile-environment proof, and deletion ledger are retained in
  [`2026-09-02-utils-authority-transfer.md`](./02-execution/.experiments/2026-09-02-utils-authority-transfer.md).

## Phase 4 — normalized store, sandboxes, and one whole-repository flip

End-state per [decision 0030](./.decisions/0030-normalized-store-scc-and-atomic-cutover.md)
and its Amendment 1 (issue #1212, Johannes q4: whole-repository migration with
root-install deletion, and a Buck-watch development loop), with authority per
[decision 0015](./.decisions/0015-buck-owned-dependency-surface.md) Amendment 4
and mechanism per [decision 0022](./.decisions/0022-lockfile-derived-declared-closure.md).
Phase 3's remaining per-package flips are absorbed here: the repository moves in
one change rather than package layer by package layer, because the superseded
producers (root install, both root TypeScript solutions) are repository-wide.

The cutover candidate implements the four staged prerequisites in one reviewable
change while preserving their separate gates:

1. normalized store entries, platform-selected variants (a lockfile-derived set,
   ten in the current complete lock), and all five SCC assemblies;
2. platform sandboxes and exact tool closures — Bubblewrap on
   `exec_linux_x86_64` and `exec_linux_aarch64`, Seatbelt on
   `exec_macos_aarch64` — each with its own positive/negative/byte-identity
   gate;
3. byte-owned editor snapshots with bounded retention, plus the watch loop that
   rebuilds the affected closure and republishes only changed snapshots
   (BUCK-R17, DEPS-R12);
4. package/consumer adoption: dist boundaries, admissions, and generators for
   every consumed workspace package, with runtime exports still at source.

The same candidate performs the atomic authority flip. Every consumer, editor,
and tool surface — both root TypeScript solutions, package tasks,
unit/integration and Storybook runners, Genie, lint and package-bin consumers,
and editor configuration — moves to Buck. The root install, its task edges, the
old TypeScript producers, remaining project references, legacy check/build
edges, and source fallbacks are deleted together.

Acceptance gates: all five repo-wide SCCs build; the three sandbox gates pass;
editor snapshots survive backing-artifact deletion and refresh incrementally;
strict JavaScript products are byte-identical across Linux x86_64, Linux ARM64,
and Darwin ARM64; cache-only upload/restore succeeds from a CI runner (DQ1); and
the full candidate namespace E2E fits an explicit numeric envelope for cold
wall time, physical and logical disk, scratch, editor-snapshot retention,
staging/action p95, memory headroom, and marginal admission slope (DQ4).
Raising timeout or disk alone satisfies nothing.
True remote execution (DQ3) is out of scope; `remote_enabled` stays false.

- Retired from this phase: the prune/install keying gate of decision 0015
  Amendment 1 (bounded fan-out is structural under the declared closure) and the
  separate "editor cutover after per-package flips" sequencing.

## Phase 5 — Rust and products

- The Rust workspace has five members: otelite, otel-scrape, and the three Buck
  support crates. Admit deterministic Cargo operations first, then emit and
  independently import real otelite/otel-scrape BuildProducts before deleting
  Cargo/Nix source producers.
- Third-party sources are Buck-fetched per
  [decision 0023](./.decisions/0023-buck-fetched-rust-crates.md): Reindeer
  `vendor = false`, hash-pinned `http_archive` from the authoritative lock;
  `buck2-rust-vendor`, the vendor symlink task, and
  `rust/third-party/.cargo/config.toml` are deleted in the same change; the
  buckify gate pins a cargo home and asserts a byte-unchanged lock; the eight
  vendored-mode fixups are re-verified by building their crates.
- The eight repository pnpm-deps FOD producers are replaced by ten tracked
  strict JavaScript products. Each product has independently tracked descriptor
  and module digests, exact external modules and capabilities, and a
  fail-closed Nix import; no importer invokes Buck or repository source.

## Phase 6 — second consumer (dotfiles)

- dotfiles consumes effect-utils targets through composition (success criterion
  6), compares producer/consumer action digests in CI, and proves zero local
  execution from the shared cache. The same admission deletes its source-mount
  CLI path, dependency writers, and live cross-workspace mutation paths; until
  then symlink compositions remain no-upload.

## Cross-phase commitments (ratified 2026-09-01)

- Composed-by-default worktrees after the #1056 stack lands, at full
  normative depth (decision
  [0027](./.decisions/0027-composed-default-worktrees.md), MR-R11, agent
  workflow contract rev 4); stale experimental composition roots are GC'd.
- Reflink-first assembly is superseded by decision 0030 (see decision
  [0025](./.decisions/0025-cow-reflink-local-disk-economics.md) Amendment 1):
  the assembler change and its pre-flip spike are dropped, and the fleet
  CoW-filesystem obligation is no longer a Buck-side gate. What survives is the
  hygiene pass owed regardless of filesystem — stale buck-out GC, contaminated
  store-commit purge plus guard, and orphaned editor-snapshot GC, which Phase 4
  turns into the bounded snapshot retention of DEPS-R12.
- Unit-test admission per decision
  [0026](./.decisions/0026-buck-owned-unit-tests.md): hermeticity spike, then
  per-package test admissions; test runners are part of the Phase-4
  whole-repository consumer coverage, so any still-legacy runner must either
  move in that flip or keep an explicit non-Buck lane recorded there.
  Integration/live lanes remain explicitly legacy.
- CI Buck cache: tailnet read-only lane — bazel-remote alerting first, then
  an ephemeral-tailscale spike on a CI runner, then the lane with fail-open
  fallback (03-materialization DQ1 records the lane and its fallback).

## Deferred / parked

- Remote execution workers (NativeLink is the designated candidate if RE enters
  scope; cache swap is cheap because CAS state is disposable).
- OCI product distribution durability machinery: parked per
  [decision 0013](./.decisions/0013-shared-cache-foundation.md) partial
  supersession of decision 0008.
- pnpm store consolidation on dev3 is closed by the Phase-4 root-install
  deletion. The developer-time store no longer participates in Buck authority;
  host-level cleanup belongs to normal workspace garbage collection.
- pnpm 12: revisit when it is the `latest` dist-tag and packaged in nixpkgs;
  under decision 0022 pnpm runs only at developer resolution time.
- Bun as installer: revisit only if a released Bun emits per-package
  self-contained trees and nixpkgs carries it; disqualified today on a silent
  `patchedDependencies` drop. Under decision 0022 the fetcher is irrelevant.
