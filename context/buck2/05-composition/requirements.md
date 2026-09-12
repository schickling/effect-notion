# Composition Requirements

This subsystem owns megarepo cell composition: how members form one Buck graph
and how action identity stays stable across composition shapes. It refines
BUCK-R05 and BUCK-R14. Architecture:
[decision 0014](../.decisions/0014-megarepo-cell-composition.md); evidence:
[.experiments/2026-08-25-cell-composition-key-stability.md](./.experiments/2026-08-25-cell-composition-key-stability.md).

## Assumptions

- **COMP-A01 Megarepo ownership:** Megarepo owns member materialization and
  the store-liveness accounting derived from it.
- **COMP-A02 Identity mechanics:** Source paths render project-relative in
  action command lines, and outputs render under
  `buck-out/<isolation>/…/<cell>/<config-hash>/…`; mount path, cell name,
  platform label, and isolation dir therefore enter action identity.

## Acceptable Tradeoffs

- **COMP-T01 External namespaces:** An external consumer building a public
  member standalone uses the same synthesized root shape but inhabits its own
  cache namespace; no attempt is made to share keys outside the fleet.

## Requirements

- **COMP-R01 Synthesized root everywhere:** Every build — composed, single-repo
  CI, and standalone — runs from a synthesized composition root. A bare
  checkout as its own project root is a cache island and is not a supported
  build shape. The workspace root is located at the store worktree path and is
  not itself a git repository; the owned member is
  ([decision 0027](../.decisions/0027-composed-default-worktrees.md)).
  Git external cells are not a composition mechanism
  ([decision 0030](../.decisions/0030-external-cells-are-not-a-composition-mechanism.md)).
- **COMP-R02 Canonical mounts including the hub:** Every repository — including
  the one under development — has one canonical mount path (`repos/<name>`),
  identical in every composition and at every nesting level. No repo builds
  from its own root as a cell: one cell identity per repo, one cache namespace
  ([decision 0020](../.decisions/0020-one-writable-mount-workspaces.md)).
- **COMP-R03 Canonical cell names:** Each member has one canonical cell name,
  identical everywhere; a member's checked-in `[cell_aliases]` must agree with
  it (nested `[cells]` is ignored, nested `[cell_aliases]` is honored).
- **COMP-R04 Root-only declarations:** Cells, the prelude
  (`external_cells: bundled`), execution platforms, and
  `target_platform_detector_spec` are declared in the composition root's
  `.buckconfig` only, and the detector spec covers every cell — a cell reached
  only through a dependency edge must not resolve to a different configuration
  than the same target built directly.
- **COMP-R05 Shared platform labels:** Platform targets live in one canonical
  hub cell present in every composition; the same labels resolve everywhere
  (the label, not its content, enters the configuration hash).
- **COMP-R06 No member `.buckroot`:** Members ship no `.buckroot`; the
  composition root owns it. A cwd inside a member must not silently become its
  own project root with a second `buck-out`.
- **COMP-R07 Fixed isolation dir:** One isolation dir across all shapes; it is
  part of output paths and therefore of action identity. Per-invocation
  isolation dirs are forbidden.
- **COMP-R08 Content-reachable mounts and admissible links:** Member bytes
  must be reachable at the mount path without traversing an absolute symlink,
  and any relative symlink must normalize to a path inside the project root.
  This is a correctness requirement, not a key-hygiene rule: Buck2 collapses
  an absolute-symlink component into an opaque leaf whose only hashed payload
  is the target path string — the content behind it is NOT an input, edits do
  not invalidate, and one key serves stale artifacts (cache poisoning; see
  [.experiments/2026-08-27-symlink-content-blindness.md](./.experiments/2026-08-27-symlink-content-blindness.md)).
  Real directories, hardlink farms, and in-root relative symlinks all qualify;
  hardlink farms only where the mount is a read-only build input (in-place
  writers mutate the source through shared inodes). The one admissible
  absolute-symlink class is `/nix/store` targets (content-addressed,
  host-identical, carried in the digest via the capability closure identity);
  dereferencing them is not a substitute — the capability contract requires
  store-resolved executables. No Buck2-side lever exists or is coming:
  upstream's stated direction is banning symlinks, and the pin-bump changes
  nothing.
- **COMP-R09 Projection ownership:** The composition-root generator lives in
  megarepo (mr) and consumes per-member facts (canonical cell name, mount,
  ignore contributions) from a genie-projected member manifest; the discipline
  above is enforced by generation, not by developer memory (GRAPH-R07).
  Projected member targets declare cross-cell visibility — a member target
  without it is unreachable from consumers.
- **COMP-R10 Content-real materialization:** mr materializes member mounts in
  a COMP-R08-satisfying shape through a `cp -a` copy from the immutable store,
  advanced by stage + RENAME_EXCHANGE under the six-point regeneration
  contract. Hardlink farms and in-place git-worktree regeneration are
  disqualified with demonstrated failures. Legacy consumers that still use
  absolute-symlink mounts must never write to the shared cache because Buck2
  is blind to member content behind the symlink; store-liveness accounting
  moves with the mount shape
  ([.experiments/2026-08-27-readonly-mount-e2e.md](./.experiments/2026-08-27-readonly-mount-e2e.md)).
- **COMP-R11 One writable mount per workspace:** A workspace has exactly one
  writable member — the branch-attached git worktree of the repo it exists to
  develop, on a branch the workspace owns (git's one-worktree-per-branch rule
  is the enforcement). All other members are read-only locked-rev mounts. A
  workspace's default working directory is its owned member. Legacy consumers
  that write into other members' mounts keep symlink mounts and stay outside
  the shared cache namespace until retired
  ([decision 0020](../.decisions/0020-one-writable-mount-workspaces.md)).
