# CI Store Cache Spec

This document specifies the CI store cache. It builds on
[requirements.md](./requirements.md).

Status: **Draft**

## Scope

This spec defines:

- the workspace-relative store/home/state layout for CI jobs;
- the cache key composition and versioning;
- the restore-after-checkout ordering invariant;
- the single-publisher write-coordination primitives.

It does not define the CI measurement architecture (see
[../../ci/measurements.md](../../ci/measurements.md)) or non-CI store traits
(see [../04-store-authority/spec.md](../04-store-authority/spec.md)).

## Requirement Trace

| Section          | Requirements                                      |
| ---------------- | ------------------------------------------------- |
| Store Layout     | DMP.CICACHE-R01, DMP.CICACHE-R02                  |
| Cache Key        | DMP.CICACHE-R06, DMP.CICACHE-R07                  |
| Single Publisher | DMP.CICACHE-R03, DMP.CICACHE-R04, DMP.CICACHE-R05 |

## Store Layout

The store, home, and state paths are workspace-relative constants (for example,
`${{ github.workspace }}/.devenv/pnpm-store-pure-v1` and sibling home/state
paths), shared by setup, restore, and save steps so every job addresses the same
location.

Ordering invariant (`DMP.CICACHE-R02`): because a gitignored workspace path is
wiped by the pre-checkout clean, restore must run **after** checkout.

```text
checkout (wipes gitignored .devenv/pnpm-store-pure-v1)
  -> restore store  (exact composed key)
     -> install / build / test steps
        -> save store  (single publisher only)
```

## Cache Key

```text
key = ${keyPrefix}-${cacheVersion}-${os}-${arch}-${lockfileHash}
```

| Component      | Source                                         | Purpose                            |
| -------------- | ---------------------------------------------- | ---------------------------------- |
| `keyPrefix`    | per-repo namespace (atom default, overridable) | isolate repo namespaces            |
| `cacheVersion` | centralized constant                           | one bump invalidates all consumers |
| `os` / `arch`  | runner identity                                | platform-correct store             |
| `lockfileHash` | resolved lockfile                              | content identity                   |

Restore uses the exact key with no loosening restore-keys
(`DMP.CICACHE-R07`). Consumers that need a private namespace pass their own
`keyPrefix`; the centralized `cacheVersion` still flips all of them together.

Half of this contract auto-converges: consumers call the setup/restore/save
steps argument-free, so changing the atom defaults (workspace-relative paths,
`cacheVersion`, default `keyPrefix`) lands everywhere on repin with no per-repo
edit.

## Single Publisher

Exactly one job per key saves the cache (`DMP.CICACHE-R03`). This cannot be a
default that consumers inherit, because consumers hand-roll their own job
factories and would each save; it is expressed as callable primitives the
factories adopt (`DMP.CICACHE-R04`, see `0001`):

| Primitive                        | Shape                                                                                                 | Use                                                              |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| per-job publisher gate           | append the save step iff `publish === true`                                                           | a hand-rolled factory spreads it into the designated job's steps |
| workflow-level publisher stamper | append the save to exactly the named job; **throw** if that job is absent or if any job already saves | centralizes never-zero / never-many at the workflow map          |

The workflow-level stamper is the fail-closed enforcement of
`DMP.CICACHE-R03`/`R04`. Jobs expressed through a reusable-workflow `uses:` shape
cannot be stamped in place and must use the per-job gate instead.

The designated publisher must be a job on the normal push/PR flow that warms a
cold key and installs the fullest closure (`DMP.CICACHE-R05`); a
schedule/admitted-only job would leave non-admitted runs unable to warm the
cache.

## Evolution

The workspace-relative store specified here is the CI profile's **ephemeral
lane**: each run restores and saves the store through the actions cache, and the
workspace copy is transient. A persistent host-shared content-addressed store
(one append-only store per self-hosted runner, reused across runs) is a deferred
evolution of this lane, not part of this contract — it is tracked upstream in
#773 and a downstream disk-reclamation epic. The ephemeral lane here is the
transitional state; a future runner-type-aware policy would select the
persistent lane where available while keeping this ephemeral lane as the
fallback.

## Open Design Questions

- **DQ1 Convergence of hand-rolled factories:** The residual divergence is the
  hand-rolled job factories themselves. Converging them onto one shared
  self-hosted job composer would let this and future CI-step changes propagate on
  repin with zero per-repo edits. Resolution: a per-repo refactor of custom
  admission/matrix/cache wiring onto the shared composer, sequenced after the
  disk-safety rollout.
