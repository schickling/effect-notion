# Buck2 Git External Cells: Source-Verified Facts at the Pinned Release

Date: 2026-09-12 — Host: dev3 — Buck2 pin 2026-09-01
(`be6971d47dcc835b7356e1698b23039ffee4f4c2`); upstream HEAD
`f2e6296850382e1f802b71bfb2422b5d67313b14` (2026-09-11) diffed against the pin
for the files below (behaviorally identical).

## Question

Could Buck2's own `external_cells` (git origin) replace mr's member mounts —
the cp -a / RENAME_EXCHANGE / R6 pipeline of decision 0020 — and if so under
what limits? Decision 0020's adversarial review surveyed submodules,
EdenFS/Sapling, josh, and jj but never external cells.

## Method

Source read of the pinned tag: `app/buck2_common/src/legacy_configs/cells.rs`
(config parsing), `app/buck2_core/src/cells/external.rs`,
`app/buck2_core/src/fs/buck_out_path.rs` (physical layout),
`app/buck2_core/src/fs/artifact_path_resolver.rs` (source resolution),
`app/buck2_external_cells/src/git.rs` (fetch), `app/buck2_file_watcher/src/notify.rs`,
`docs/users/advanced/external_cells.md`, and the upstream e2e test
`tests/core/external_cells/test_git.py`. Release history via
`git ls-remote --tags`. Issue tracker searched for `external_cells`,
`git_origin`.

## Result

- Configuration: `[cells] <name> = <path>` plus `[external_cells] <name> = git`
  plus `[external_cell_<name>] git_origin = … / commit_hash = <40-hex sha1>`
  (`object_format = sha256` optional). Origins: `bundled`, `git`, `disabled`.
  Only the project root may declare external cells; no transitive external
  cells; no nested cells; the fetched repo's own `[cells]` is ignored, its
  `[cell_aliases]` honored.
- The `[cells]` path is virtual: files are not generated there; source
  resolution bypasses it and resolves to
  `buck-out/<isolation>/external_cells/git/<commit_hash>/<cell-relative>`
  (`buck_out_path.rs:253-358`, `artifact_path_resolver.rs:64-83`). The path
  string still matters for tree-file handling and `expand-external-cell`.
- Fetch (`git.rs:121-170`): `git init [--object-format]`, `git fetch <origin>
<commit_hash>`, `git reset --hard FETCH_HEAD`, then `.git` is deleted
  (`git.rs:200-208`). Git is a PATH subprocess (`background_command("git")`),
  not libgit2 and not a Buck action. No `--depth`, `--filter`, sparse checkout,
  or submodule handling. The checkout is per project root and isolation dir;
  nothing is shared across roots or machines; `buck2 clean` deletes it.
- Offline: once materialized, a fresh daemon builds without contacting the
  origin (`git.rs:241-249`; e2e `test_git.py:142-159` deletes the origin and
  rebuilds).
- Invalidation: after checkout Buck2 fingerprints the tree and declares it a
  materialized artifact (`git.rs:210-237`). Because `ArtifactFs::resolve_source`
  inserts the physical `…/git/<commit>/…` path into the input Merkle tree,
  every action consuming a source from the cell changes `input_root_digest`
  when the commit changes, even if that file is unchanged; argv-rendered
  inputs additionally change the command digest. The upstream e2e test asserts
  exactly this over-invalidation and comments that the assertion should flip
  "once caching becomes content-based" (`test_git.py:113-140`); no tracked
  issue, PR, or schedule for that change was found.
- File watching: the notify watcher drops every path under `buck-out`
  (`notify.rs:99-108,298-300`); external checkouts are refreshed only through
  config/materializer state.
- History: functional git external cells first shipped in tag `2024-05-15`
  (commit `8484862`, 2024-05-07). No `experimental`/`unstable` marker exists;
  absence of the marker is not a stability promise.
- Physical storage keys on commit hash only (not origin URL, cell name, or
  mount path), so identical hashes from different origins alias inside one
  buck-out.
- `git_fetch` (prelude) and `http_archive` are action-output rules (shallow
  `--depth=1`, optional submodules), not analysis-time cells.

## Conclusion

External cells are an elegant primitive for one job: making an immutable git
commit visible to analysis as one cell — the prelude pattern and third-party
sources. They are not a member-mount mechanism under the composition
contract: they cannot share action keys with an on-disk cell (physical
commit-keyed path in the input tree), they over-invalidate on every commit
bump, they carry no host-global store, no editable worktree, no multi-cell
topology, and no channel for per-host projections such as
`.buck2/capabilities`.

## VRS Impact

Grounds decision 0030 (external cells are not a composition mechanism) and the
two conditions under which it is revisited: upstream content-based external
cell keys, and a root-owned capability cell. COMP-R08/R10 and decision 0020
are unaffected. See the companion fixture and hub records of the same date for
the empirical confirmation.
