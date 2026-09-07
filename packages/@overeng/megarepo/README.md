# megarepo

Megarepo (`mr`) composes multiple git repositories into a shared development workspace. It materializes member repos from `megarepo.kdl` into `repos/`, and records exact commits in `megarepo.lock` when you explicitly manage the lock.

## Why megarepo?

- Shared worktrees in `~/.megarepo` avoid duplicate clones across workspaces
- `megarepo.kdl` declares branch or tag intent (KDL v2 format, hand-written)
- `megarepo.lock` records exact commits for CI and reproducible setups
- Workspace sync and lock management are separate operations

## Quick Start

```bash
mr init
mr add effect-ts/effect
mr add effect-ts/effect#v3.0.0 --name effect-v3
mr add ./packages/local-lib --name local-lib

mr fetch --apply
mr lock
```

## Command Model

| Command            | Purpose                                                                   |
| ------------------ | ------------------------------------------------------------------------- |
| `mr fetch --apply` | Fetch configured refs, reconcile workspace, and update `megarepo.lock`    |
| `mr lock`          | Record the current synced workspace state into `megarepo.lock`            |
| `mr apply`         | Apply `megarepo.lock` exactly, using commit worktrees for reproducible CI |

## Typical Flow

```bash
mr fetch --apply

# work in repos/*

mr lock
git add megarepo.lock
git commit -m "Update megarepo lock"
```

To intentionally move dependencies forward:

```bash
mr fetch --apply
```

For CI:

```bash
mr apply --git-protocol=https
```

## Directory Layout

After `mr fetch --apply` and `mr lock`:

```text
my-megarepo/
├── megarepo.kdl
├── megarepo.lock
└── repos/
    ├── effect -> ~/.megarepo/github.com/effect-ts/effect/refs/heads/main/
    ├── effect-v3 -> ~/.megarepo/github.com/effect-ts/effect/refs/tags/v3.0.0/
    └── local-lib -> ./packages/local-lib
```

Branch worktrees use raw Git ref paths in the store, for example `feature/foo` becomes `refs/heads/feature/foo/`.

## Generated artifact cleanup

`mr store gc` can plan old generated directories in registered, clean, inactive store worktrees,
then apply exactly one candidate from that immutable plan:

```bash
mr store gc --generated-artifacts --dry-run --output json
mr store gc --generated-artifacts --expected-plan <sha256> --candidate-path <path> --output json
```

Configure the host at `$MEGAREPO_STORE/.state/gc-config.json`:

```json
{
  "generatedArtifacts": {
    "enabled": true,
    "retentionMs": 86400000,
    "allowlist": ["node_modules", ".direnv", "target"],
    "agentLivenessManifest": "/run/megarepo/agent-liveness.json"
  }
}
```

The allowlist may contain only the compiled canonical classes. The liveness manifest is a
short-lived snapshot produced by the host's agent manager:

```json
{
  "version": 1,
  "expiresAtMs": 1786572000000,
  "activeWorkspacePaths": ["/absolute/path/to/a/store/worktree"]
}
```

Missing, invalid, or expired liveness data produces `unknown`. A candidate
must also be Git-ignored, older than the retention window, absent from Megarepo's live set, and
inside a clean registered worktree. A capped, timed recursive scan uses the newest nested mtime;
symlinks or incomplete scans produce `unknown`. JSON results distinguish
`would-delete`, `deleted`, `keep`, and `unknown` and include a deterministic `planSha256`.
Application recomputes the complete plan, requires the exact digest and a unique candidate, then
revalidates and removes only that candidate under its owner-worktree lock and its deletion lease.

### Deletion lease

The liveness manifest is written by an external agent manager, so rereading it cannot exclude an
activation that starts immediately afterwards. A lease per canonical owner worktree closes that
window: reclamation holds it across final classification and deletion, and activation holds it from
before its first worktree write until after it has published the manifest. The lease is one file at
`$MEGAREPO_STORE/.state/deletion-leases/<sha256-of-owner-path>.lease`, taken by hard-linking onto
that path — atomic on POSIX, so the loser fails closed instead of proceeding on a stale snapshot.
Every plan-bound deletion takes it, whole worktrees and archive reaps included, since an activation
of the worktree being deleted is exactly what the lease has to exclude. After linking, the acquirer
re-reads the record and requires its own token: concurrent recovery of one dead holder can otherwise
let a loser's removal delete the winner's fresh lease, and a mismatch refuses without removing.

Activation needs no protocol code of its own; wrap it:

```bash
mr store lease --owner-path /path/to/store/worktree -- <activation command>
```

A lease is reclaimed only when its record is decodable, names this host, and names a pid that is
provably gone. A foreign host, a live pid, or an unreadable record keeps the lease and refuses the
caller. `mr store lease` propagates the wrapped command's own exit code.

## Documentation

- [Getting Started](docs/getting-started.md)
- [Commands Reference](docs/commands.md)
- [Workflows](docs/workflows.md)
- [Specification](docs/spec.md)
