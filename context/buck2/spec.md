# Buck2 Repository Build Spec

This document specifies the system architecture and its boundaries. It builds
on [requirements.md](./requirements.md). Subsystem specs own their mechanisms.

## Status

Draft.

## Scope

**Defines:** authority, component ownership, dependency direction, composition
shape, subsystem responsibilities, and atomic authority-cutover sequencing.

**Does not define:** deployment, activation, rollback, health, CI topology, or
post-authority rollout sequencing ([roadmap.md](./roadmap.md)).

## Architecture

```text
authored intent (genie models, manifests, lockfiles)
        |
        v
01 semantic graph ──projects──> BUCK files + closure descriptors
        |
        v
05 composition root (.buckconfig cells: members at repos/<name>)
        |
        v
configured Buck graph
   |         |          |
   v         v          v
02 execution  03 materialization  ──> actions (typecheck, build, test, package)
(toolchains,  (normalized store,        |
 platforms,    closure-link views,     |
 sandboxes)    byte editor snapshots)  v
                              04 reuse (shared AC/CAS on tailnet cache)
                                         |
                                         v
                              native evidence + BuildProduct
                                         |
                                         v
                              06 nix-bridge (independent import)
                                         |
                                         v
                              Nix store / system closures (consumer-owned)
```

## Authority Matrix

| Concern                                    | Authority             | Boundary                                                      |
| ------------------------------------------ | --------------------- | ------------------------------------------------------------- |
| Semantic intent, package and target facts  | Genie-composed models | Projected BUCK files, freshness-gated                         |
| Dependency requests                        | Manifests + lockfile  | Only hand-authored dependency input                           |
| Dependency materialization (build, editor) | Buck actions          | Normalized entries, closure-link views, atomic byte snapshots |
| Repository-local deterministic work        | Buck                  | Providers, configured platforms, action keys                  |
| Tools and system inputs                    | Nix                   | Immutable `/nix/store` providers                              |
| Cross-member source dependencies           | Buck cells            | Canonical composition root (megarepo/genie)                   |
| Shared reuse                               | Remote AC/CAS         | Cache-only service inside tailnet trust                       |
| Portable artifact                          | Buck                  | `buck-build-product/v1` descriptor and payload                |
| Product validation and store import        | Nix                   | Exact descriptor and payload checks                           |
| Deployment and all live effects            | Consumer              | Outside the Buck contract                                     |

## Composition Shape

Every build — single-repo and composed alike — runs from a synthesized
composition root: a project root whose `.buckconfig` declares each member as a
cell at its canonical mount path. Megarepo materializes member sources; genie
projects the root configuration. There is no bare-checkout build shape in the
shared cache namespace; an external consumer building a public repository
standalone uses the same synthesized single-member root and simply inhabits its
own cache namespace. Mechanism and the key-stability discipline:
[05-composition](./05-composition/spec.md).

## Invocation Flow

```text
1. genie freshness gate: projections match authored intent
2. composition root selects admitted targets and platforms
3. normalized entries materialize package identities once; views link closures
4. sandboxed Buck actions execute; unchanged work resolves from shared cache
5. dependency snapshots flip atomically for the editor surface when requested
6. products cross to Nix through independent import when requested
7. the caller records native evidence; telemetry links to it without replacing it
```

Buck's result is determined at step 4. Export, retention, or import failures
are separate outcomes and never rewrite it.

## TypeScript Authority Cutover

The normalized store and sandbox mechanics land through staged dependent PRs
while the existing producer remains authoritative. Before the final authority
change, every one of the 17 packages in the #1209 graph must be servable from
its declared `dist` boundary; all five SCCs must build; production actions must
not fall back to sibling source; and DQ1's CI cache path and DQ4's accepted
numeric cold-capacity envelope must be closed. One atomic final change proves
Linux Bubblewrap, Darwin Seatbelt, editor snapshot survival, deterministic
JS/declaration/map bytes, and cache-only upload/restore, then flips all
consumers and deletes the old producer. Raising timeout or disk alone does not
satisfy the capacity gate. True remote execution remains disabled until it has
separate end-to-end evidence.

## Forbidden Edges

- Buck actions must not evaluate Nix, run a package-manager install against
  live state, or mutate consumer live state.
- Nix import must not invoke Buck or fall back to a repository source build.
- Telemetry must not supersede native Buck evidence or change Buck's result.
- A `BuildProduct` must not encode transport, activation, rollback, or health
  state.
- Shared rules and fixtures must not depend on a consumer repository or carry
  private facts (BUCK-R14).
- No component interposes a launcher between the caller and Buck
  ([decision 0011](./.decisions/0011-direct-native-evidence-observation.md)).

## Requirement Trace

| Requirements                 | Refinement            |
| ---------------------------- | --------------------- |
| BUCK-R01, BUCK-R05           | 01 Semantic Graph     |
| BUCK-R02, BUCK-R04           | 02 Execution          |
| BUCK-R08, BUCK-R11           | 03 Materialization    |
| BUCK-R06, BUCK-R07           | 04 Reuse              |
| BUCK-R05, BUCK-R14           | 05 Composition        |
| BUCK-R03, BUCK-R10           | 06 Nix Bridge         |
| BUCK-R09, BUCK-R12, BUCK-R13 | Root + all subsystems |
