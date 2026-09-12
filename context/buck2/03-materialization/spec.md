# Materialization Spec

This document specifies the materialization action and the editor surface. It
builds on [requirements.md](./requirements.md). Mechanisms are
prototype-validated; see [.experiments/](./.experiments/).

## Status

Draft.

## Scope

**Defines:** the per-package materialization action, normalization, the editor
view, and the staleness gate.

**Does not define:** semantic dependency declaration (01), tool provisioning
(02), or cache transport (04).

## Materialization Action

```text
translate (genie, freshness-gated)
  pnpm-lock.yaml (+ pnpm-workspace.yaml, patches)
  -> per package version: fetch target (url, sha256 from generated sidecar)
                          extract target (tarball -> package tree artifact)
  -> per importer:        node_modules assembly target
  -> platform constraints on optional/platform packages (select())

fetch     download_file, remote-cacheable, network only here (DEPS-R08)
extract   tar -> package tree, remote-cacheable
assemble  importer virtual store: .pnpm/<name>@<ver>[_peer-suffix]/node_modules/<name>
          hardlinks from extract artifacts, relative symlinks for edges,
          workspace: edges as relative links, .bin entries as symlinks
          local_only (DEPS-T01); public node_modules output
```

No package manager executes inside Buck actions. pnpm is the developer-time
resolver that writes `pnpm-lock.yaml`; the generated sha256 sidecar is derived
from the lockfile's sha512 integrity values and verified against them at
generation, so it cannot disagree with the lockfile except by staleness, which
the freshness gate rejects. The lockfile's peer-suffixed snapshot keys map
directly to virtual-store entries; peer resolution is not re-derived.

Invalidation is structural (DEPS-R07): a changed package version re-runs its
fetch and extract and the assemblies of importers whose closure contains it;
unrelated importers are untouched. A change that leaves an importer's closure
byte-identical re-runs nothing for it.

Lifecycle scripts are not executed (ratified policy: builds disallowed;
`requiresBuild` is empty in the lockfile). A package that would require a
build fails admission until a declared mechanism exists. `patchedDependencies`
apply during extraction as declared inputs. Optional platform packages are
filtered by cpu/os constraints so foreign-platform entries are neither fetched
nor linked.

The assembled tree is relocatable (no absolute paths) but hardlinks share inodes
with extract artifacts; Buck resets output modes, so read-only protection is
applied on the published editor view, not inside `buck-out`. The retired
deploy-based two-stage action and its normalizer are recorded in
[the retained experiment](./.experiments/2026-08-26-two-stage-prune-install.md)
and superseded by
[the closure prototype](./.experiments/2026-08-30-declared-closure-prototype.md).

The package-tree API projects declared workspace files into the output for
cacheable consumers; the editor-surface realization provides DEPS-R03
live-source links outside the cacheable package tree without weakening
DEPS-R02.

## Editor Surface

The repository-root source-generator consumer and each admitted workspace
package `<package>` expose `:<editor_inputs>` as their canonical Buck dependency
view and `:editor_view_inputs` as the manifest joining that view, the package
tree, and every provider-declared backing root. The stable filesystem shapes are:

```text
<package>/node_modules
  -> ../../.editor-view/<view>/node_modules
<package>/../../.editor-view/<view>
  -> .store/<view>-<snapshot-identity>
<package>/../../.editor-view/.store/<view>-<snapshot-identity>/
  editor-view.json
  node_modules/
  .backing/
```

```text
node_modules
  -> .editor-view/root/node_modules
.editor-view/root
  -> .store/root-<snapshot-identity>
```

Package consumers share a two-level state root; the root source-generator
consumer uses the repository-local `.editor-view/root` state. Every published
link remains inside the repository while context packages,
`packages/@overeng/*`, nested workspace packages, and root generators use the
same publisher.

Each schema-v2 record binds the package, Buck cell and target, selected
`editor_inputs` fingerprint, normalized declared-root digest, exact selected
view digest, exact byte-owned snapshot digest, and deterministic snapshot name.
Tree digests use the `effect-utils/tree-digest/v1` domain separator, unsigned
UTF-8 byte ordering, length framing, and fail-closed checks for special or
concurrently changing files.

Before publication, `buck2:editor:authority` compares the canonical admission
registry with tracked package manifests and a Buck `owner(...)` census. The
resulting authority file must name identical required and owned package sets;
every package publication validates it.

Publication holds the exclusive state-root `.publish.lock`, created atomically.
An existing lock fails immediately and prints the explicit token-gated recovery
operation. There is no age heuristic, timeout, or automatic lock theft. Under
the lock, the publisher:

1. fingerprints the selected dependency view and finite declared roots;
2. recursively copies the selected view and disjoint backing roots into a
   same-filesystem candidate with dereferenced, byte-owned regular files;
3. relocates internal links into `.backing/`, rejects links outside the declared
   roots, and proves no snapshot file shares an inode with a disposable source;
4. verifies the complete payload digest and writes `editor-view.json`;
5. hardens the candidate read-only and renames it to the deterministic snapshot;
6. atomically renames the current pointer, installs or validates the package
   first hop, and emits the package-manifest settle signal required by live
   language servers;
7. checks the published view, updates its retention record, and garbage-collects
   snapshots outside the configured finite retention set.

If a legacy root install occupies the first hop, immutable GNU
`mv --exchange --no-copy` installs the symlink without an absent-path window and
retains the exchanged entry under `.legacy/`. A failure before the pointer flip
leaves the prior current view intact. Snapshot payloads never retain links into
`buck-out`, whose action directories Buck may delete before rebuilding.

## Staleness Gate

`buck2:editor:bootstrap` first derives a dependency-only consumer set from the
committed generated root manifest. It may publish those committed-graph views
only to make `genie:check` runnable; it reports no governed evidence. After
freshness and workspace reconciliation, `buck2:editor:publish` and
`buck2:editor:check` derive the complete root-plus-package set from the canonical
source registry, regenerate whole-workspace ownership authority, build every
`:editor_view_inputs` manifest in one Buck invocation, then publish or validate
each consumer in deterministic order. The checker validates record schema and
identity, both symlink hops, state-root containment, pointer liveness, snapshot
completeness, immutable payloads, retention state, and admitted versus recorded
digests. It does not use tsgo as an oracle.

The mutating `buck2:editor:materialize` entrypoint serializes `mr:setup`,
bootstrap publication, `genie:run`, `genie:check`, `mr:apply`, and authoritative
editor publication. TypeScript declaration publication waits for that barrier.
This does not change the standalone freshness contract: `genie:check` still
runs after bootstrap without invoking `genie:run`, so it cannot repair the
projection it proves.

Missing, malformed, escaping, dangling, incomplete, or stale state fails with
the recorded and current identities. `buck2:editor:recover-lock` is the only
recovery surface; it requires both `EDITOR_VIEW_PACKAGE` and the exact printed
`EDITOR_VIEW_LOCK_TOKEN`, and neither builds nor mutates snapshots.

## Relationship to Exact Closure Materialization

The declared closure above is the per-package fetch-and-verify tier that the
retired package-evidence regime anticipated. It is introduced with live
consumers (the admitted packages) under the Buck admission contract; no
evidence infrastructure from the retired regime is revived.
