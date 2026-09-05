# Buck2 Repository Build Spec

This document specifies the system architecture and its boundaries. It builds
on [requirements.md](./requirements.md). Subsystem specs own their mechanisms.

## Status

Draft.

## Scope

**Defines:** authority, component ownership, dependency direction, composition
shape, subsystem responsibilities, atomic authority-cutover sequencing, and the
shape of the development loop that replaces deleted inner-loop producers.

**Does not define:** deployment, activation, rollback, health, CI topology,
post-authority rollout sequencing ([roadmap.md](./roadmap.md)), or the task and
shell wiring that invokes the development loop.

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
5. editor snapshots flip atomically on request or when the watch loop observes
   a changed view fingerprint
6. products cross to Nix through independent import when requested
7. the caller records native evidence; telemetry links to it without replacing it
```

Buck's result is determined at step 4. Export, retention, or import failures
are separate outcomes and never rewrite it.

## TypeScript And Dependency Authority Cutover

The normalized store, platform sandboxes, editor snapshots, and consumer
adoption land through staged dependent PRs while the existing producer remains
authoritative. Staged work builds in an explicitly named candidate cache
namespace and isolation dir, so no production key or consumer changes until the
flip; every staged measurement names that namespace
([decision 0030](./.decisions/0030-normalized-store-scc-and-atomic-cutover.md)
Amendment 1).

Gates required before the single final change:

| Gate             | Content                                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| dist-servability | Every admitted workspace package serves its declared `dist`; no production source fallback                                                                         |
| SCCs             | All five repo-wide SCCs build with distinct member namespaces                                                                                                      |
| sandboxes        | `exec_linux_x86_64`, `exec_linux_aarch64`, and `exec_macos_aarch64` each pass positive, negative, and byte-identity gates                                          |
| editor           | Snapshots survive deletion of every backing artifact; the watch loop refreshes them atomically                                                                     |
| reuse            | Cache-only upload/restore from a CI runner (DQ1)                                                                                                                   |
| capacity         | Accepted numeric cold wall, peak disk/scratch, editor-snapshot disk/retention, staging/action p95, and admission slope from the full candidate namespace E2E (DQ4) |

Until a platform's sandbox gate passes, that platform keeps the runner's
before/after input-tree mutation hashing; the control is deleted per platform
with its gate, never globally in advance.

The final change is atomic and repository-wide: it flips every consumer, editor,
and tool surface — root TypeScript solutions, package tasks, test and Storybook
runners, Genie, lint and package-bin consumers, editor configuration — and
deletes the old producer, the root install and its task edges, and every source
fallback together. The 17 packages of #1209 are a prerequisite subset, not the
scope. Raising timeout or disk alone does not satisfy the capacity gate. True
remote execution is out of scope for this cutover and remains disabled.

## Development Loop

```text
source edit -> Buck daemon file watcher -> affected admitted closure rebuilds
            -> changed view fingerprints -> atomic editor snapshot republication
```

Deleting the root install deletes the pnpm inner loop, so the watch loop is
part of the cutover, not a follow-up (BUCK-R17). It is an ordinary Buck caller:
no launcher interposition, no authority of its own, and no partial surface. A
build failure or a refused publication lock leaves the previous snapshot
pointer intact and reports loudly. Snapshot mechanics and retention:
[03-materialization](./03-materialization/spec.md). Shell and task wiring is
consumer-owned and outside this spec.

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
| BUCK-R08, BUCK-R11, BUCK-R17 | 03 Materialization    |
| BUCK-R06, BUCK-R07           | 04 Reuse              |
| BUCK-R05, BUCK-R14           | 05 Composition        |
| BUCK-R03, BUCK-R10           | 06 Nix Bridge         |
| BUCK-R09, BUCK-R12, BUCK-R13 | Root + all subsystems |
