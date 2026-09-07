# Commands Reference

All commands support `--output json` or `--output ndjson`.

## Core Commands

### `mr fetch --apply`

Fetch configured refs, reconcile the workspace to `megarepo.kdl`, and write the new lock.

```bash
mr fetch --apply [--force] [--all] [--only <members>] [--skip <members>] [--create-branches] [--dry-run]
```

Behavior:

1. Resolve members from `megarepo.kdl`
2. Fetch from remotes and update worktrees to latest commits
3. Materialize or reuse canonical source-ref worktrees in the store
4. Repair duplicate encoded/unencoded branch worktrees with `--force`
5. Repoint `repos/*` symlinks
6. Update `megarepo.lock`
7. Run generators

Pinned members are skipped unless `--force` is used.

### `mr lock`

Record the current synced workspace state into `megarepo.lock`.

```bash
mr lock [--force] [--all] [--only <members>] [--skip <members>] [--dry-run]
```

This expects the workspace to already be reconciled to `megarepo.kdl`. If a member symlink points at the wrong ref, it is skipped with a hint to run `mr fetch --apply`.

### `mr apply`

Apply the exact commits from `megarepo.lock`.

```bash
mr apply [--force] [--all] [--only <members>] [--skip <members>] [--dry-run]
```

This is the reproducible CI mode. It requires a non-stale lock file and materializes commit worktrees.

## Pin Commands

### `mr pin`

```bash
mr pin <member> [-c <ref>]
```

Switch a member to a specific branch, tag, or commit and mark the lock entry as pinned.

### `mr unpin`

```bash
mr unpin <member>
```

Remove the pin so `mr fetch --apply` can move the member again.

## Info Commands

### `mr status`

```bash
mr status [--json]
```

Reports:

- `applyNeeded`
- `lockNeeded`
- duplicate encoded/unencoded branch worktrees
- ref mismatch, symlink drift, stale lock, and commit drift

### `mr ls`

```bash
mr ls [--json]
```

### `mr root`

```bash
mr root [--json]
```

## Store Commands

### `mr store ls`

```bash
mr store ls [--json]
```

### `mr store fetch`

```bash
mr store fetch [--json]
```

### `mr store gc`

```bash
mr store gc [--dry-run] [--force] [--all] [--generated-artifacts]
mr store gc [--generated-artifacts] --expected-plan <sha256> --candidate-path <absolute-path>
```

Removes clean unrooted `refs/commits/*` worktrees. Named `refs/heads/*` and
`refs/tags/*` worktrees are kept by default. Dirty worktrees are preserved
unless `--force` is used. `--all` also considers named refs for removal.

Dry-run output includes a canonical `planSha256`. Supplying that digest with one
candidate path recomputes the complete plan and applies only the selected
worktree, archive, or generated-artifact action after an owner-locked
revalidation. Missing, ambiguous, changed, or unknown evidence refuses the
application.

Every plan-bound deletion — generated artifact, whole worktree, archive reap —
additionally holds the lease for its owner path, so an activation wrapped in
`mr store lease` can never be overtaken.

### `mr store lease`

```bash
mr store lease --owner-path <path> -- <command> [args…]
```

Runs the command while holding the deletion lease for one store worktree and
propagates its exit code. Wrap workspace activation with it: acquire before the
first worktree write, publish the agent-liveness manifest inside, and the lease
is released when the command exits. If reclamation holds the lease, the wrapper
fails instead of racing it.
