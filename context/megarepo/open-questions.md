# Megarepo Open Questions

## Open 2026-09-12: which of mr's three layers survive the Buck2 adoption?

The 2026-09-12 investigation split `mr` into a worktree fleet (store,
worktree per ref, GC — consumed by branchy, the agent-policy git wrapper, st2
seats, evergreen, fleet hygiene), pin-and-arrange (`megarepo.kdl` →
`megarepo.lock`, members at `repos/<name>` — consumed by ~30 pnpm
`link:`/`file:` edges, genie `#mr/` imports, Nix `workspaceSources`), and
Buck2 cell composition (decision-0020 shape, cp -a mounts, root generator,
capability projection, dist overlays — consumed by effect-utils' own composed
root only). Buck2 replaces none of the first two; git external cells cannot
replace the third
([buck2 decision 0030](../buck2/.decisions/0030-external-cells-are-not-a-composition-mechanism.md)).
[buck2 .proposed/artifact-composition.md](../buck2/.decisions/.proposed/artifact-composition.md)
proposes to pause the third (composed-by-default reverted, MR-R11) and to
move the effect-utils library edges from mounts to dist tarballs, leaving
mounts for fork co-development and generator sources. Blocked on: that
proposal's acceptance. If accepted, MR-R11 reverts, MR-R12/R13 stay for the
supported composed shape, and no `mr` code is deleted until the revisit
trigger in the proposal is settled.
