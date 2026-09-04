# Materialization Spec

This document specifies the normalized store, closure-link importer views,
bounded package execution views, cyclic assembly, and editor snapshots. It
builds on [requirements.md](./requirements.md).

## Status

Draft.

## Scope

**Defines:** package archive and entry providers, platform selection, SCC
assembly, package views, workspace dist entries, and editor publication.

**Does not define:** dependency intent (01), execution sandboxes and tools (02),
or cache transport (04).

## Materialization Action

```text
pnpm-lock.yaml + integrity sidecar + patches
  -> npm_archive(package snapshot)       fetch + extract once, all platforms
  -> pnpm_store_entry(snapshot)          copy own package per entry variant
       |-- symlink dependency edges: invariant entries
       `-- distinct configured artifacts: nine platform-selected entries
  -> pnpm_store_scc(members)             one sandboxed action per real SCC
  -> pnpm_store_view(importer closure)   metadata-only dependency links
  -> package_view(package + view + dist workspace entries), bounded owned bytes
```

`npm_archive` verifies the lockfile-derived digest, applies declared patches,
normalizes modes and links, and publishes one extracted package artifact. It is
unconditional: a platform selection never causes the same tarball to be
fetched or extracted again.

Package lifecycle scripts do not execute. An admitted snapshot marked
`requiresBuild` fails until it has an explicit sandboxed build mechanism;
package-manager execution is never an implicit fallback.

A store-entry provider records the lockfile snapshot identity, package name and
version, peer identity, selected platform-edge variant, package artifact,
dependency-entry providers, bin metadata, and optional platform condition. For
an acyclic entry, `assembled_dir.copy` materializes its package tree under
`node_modules/<name>`; dependency edges use `assembled_dir.symlink`. There is
one entry artifact per peer identity except for the nine platform-selected
entries, which own one per distinct configured edge variant. The own-package
copy is required so realpath keeps sibling dependency links visible. An
importer view records direct links, complete closure, and bin precedence
without copying dependency bytes.

Exactly these nine direct-dependency entries select different dependency edges
by configured platform. Each selected variant has its own configured entry and
own-package materialization; the shared archive/extract bytes are unchanged:

- `playwright@1.61.0`
- `vite@8.0.16`
- `esbuild@0.28.2`
- `rolldown@1.0.3`
- `lightningcss@1.33.0`
- `msgpackr-extract@3.0.4`
- `oxc-resolver@11.21.2`
- `oxc-parser@0.127.0`
- `@opentui/core@0.4.1`

The platform `select()` belongs only on those entries' dependency-provider
attributes. Archive providers, all other store entries, and consumer views
remain platform-invariant. Foreign optional packages are absent from the
selected entry rather than filtered by every importer.

## Dependency Cycles

Lockfile translation computes strongly connected components. Singleton acyclic
components use the normalized copy-own-package/link-dependencies entry shape.
The five real multi-member SCCs each produce one cacheable group artifact in
the execution sandbox. Read-only member artifacts and exact assembly tools are
inputs; the group output and scratch are the only writable roots; network is
denied.

Within a group, each member retains a distinct pnpm virtual-store namespace:
`.pnpm/<snapshot-identity>/node_modules/<package>`. Back-edges are relative
links between these namespaces. The assembler rejects duplicate namespaces,
escaping or absolute links, and an edge to a member outside the declared SCC.
Consumers address individual member providers backed by the group; they do not
receive a merged directory or another byte copy.

## Workspace and Package Views

A production workspace entry owns its small package metadata and declared Buck
`dist` boundary where realpath requires it. Manifest export conditions select
that provider; there is no production source-backed alternative. A package
execution view copies only package-owned sources and workspace dist boundaries,
then links one metadata-only importer dependency view. TypeScript projects that
view into its metadata-only scratch overlay inside the sandbox (02).

The migration lands store primitives, SCCs, package manifests, and dependent
consumer changes in staged PRs while the old producer remains authoritative.
The final authority PR is atomic: all 17 packages from #1209 must expose and
consume valid dist boundaries; all five repo-wide SCCs must build; DQ1's CI
cache path and DQ4's accepted numeric cold-capacity envelope must close; and
both platform sandboxes must pass. It then flips every production consumer and
deletes the old producer, root install, and source fallback together.

## Editor Snapshot

The editor must outlive Buck's backing artifacts, so its publication boundary
is intentionally byte-materialized rather than metadata-only:

```text
packages/@overeng/<package>/node_modules
  -> ../../.editor-view/<package>/node_modules       stable package first hop
packages/.editor-view/<package>
  -> .store/<package>-<view-fingerprint>             atomic current pointer
packages/.editor-view/.store/<package>-<view-fingerprint>/
  editor-view.json
  node_modules/                                      byte-owned snapshot
```

The publisher installs the package-level first hop once. If a legacy install
left a directory or other entry there, a same-filesystem atomic exchange adopts
the symlink without an absent-path window and retains the old entry under
`.legacy/`. An already-correct first hop is validated and not rewritten.

Publication atomically creates the exclusive state-root lock; contention rejects
immediately. There is no wait, age heuristic, timeout, or automatic lock theft.
The rejection prints the owner identity and recovery token. Explicit recovery
requires that exact token and fail-closed proof that the recorded owner is no
longer live; ambiguity rejects recovery. Under the held lock the publisher:

1. builds the selected metadata view and fingerprints its complete graph;
2. creates a same-filesystem candidate under the state root;
3. dereferences the view into the candidate, copying each regular file once;
4. rejects symlinks, special files, escaping paths, or mutation during copy;
5. validates the byte-tree digest and writes `editor-view.json`;
6. atomically renames the candidate to its deterministic snapshot name;
7. atomically renames a candidate symlink over the current pointer.

A failure before either rename leaves the previous pointer intact. A completed
snapshot contains no links to store entries, SCC outputs, views, or `buck-out`;
deleting every backing artifact therefore cannot break the editor. Published
snapshots are read-only. Garbage collection never removes the current snapshot
and is outside publication.

## Staleness Gate

The record binds schema, package/cell/target identity, manifest fingerprint,
normalized-store digest, selected-view digest, and byte snapshot digest. The
checker independently rebuilds current identities and validates both symlink
hops, state-root containment, pointer liveness, record completeness, and the
snapshot byte digest. It does not use the language server or tsgo as an oracle.
Missing, malformed, escaping, dangling, incomplete, or stale state reports the
recorded and current fingerprints and fails closed.

## Cache Boundary

Archive, SCC, TypeScript verdict, and dist actions may upload to the shared
action cache. Graph-composed normalized entries and importer/package views add
no separate command output to upload, even where their artifact projections
materialize bounded owned bytes. Cache-only execution keeps actions local while
allowing reads and uploads; local round trips prove this transport boundary but
do not settle CI runner connectivity. True remote execution is a separate
contract and remains disabled until a real remote executor proves sandbox,
tool-closure, path, and output semantics.
