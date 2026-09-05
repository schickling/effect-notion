# Materialization Requirements

This subsystem owns the normalized pnpm store, package views for actions, and
byte-materialized editor snapshots with their refresh loop. It refines
BUCK-R08, BUCK-R11, and BUCK-R17.

## Assumptions

- **DEPS-A01 Request authority:** Manifests, the lockfile, and declared patches
  are the only hand-authored dependency inputs (BUCK-A04).
- **DEPS-A02 Package supply:** Hash-pinned registry tarballs fetched by Buck
  supply package bytes. Their extracted artifacts are shared across every
  platform and consumer; no ambient package store is authoritative.

## Acceptable Tradeoffs

- **DEPS-T01 Bounded identity assembly:** An acyclic peer-resolved store entry
  may materialize its package tree once so realpath preserves visibility of
  sibling dependency links. The five real dependency SCCs may instead use one
  sandboxed assembly action per SCC; each member keeps a distinct namespace.
- **DEPS-T02 Transitional root install:** Until the single whole-repository
  authority flip, the root install remains on the deletion ledger. That flip
  deletes it together with its task edges, and the watch loop (BUCK-R17)
  replaces the inner loop it provided.

## Requirements

- **DEPS-R01 Manifest-only dependency inputs:** Store construction reads the
  workspace manifests, lockfile, generated integrity sidecar, and declared
  patches. Source edits do not invalidate registry package entries.
- **DEPS-R02 Normalized deterministic store:** Each peer-resolved package
  identity has one normalized entry, except the entries with platform-selected
  dependency edges, which have one entry artifact per distinct configured
  variant. Each entry owns one package-tree materialization; dependency edges
  are metadata symlinks. Layout, links, modes, peer identity, platform-edge
  variant, and bin shims are lockfile-derived, byte/link-stable, relocatable,
  and contain no absolute links or package-manager metadata.
- **DEPS-R03 Shared extracts and narrow platform keys:** Tarball fetch/extract
  artifacts are platform-invariant and shared. Only entries whose selected
  optional dependencies differ by platform have distinct configured entry
  artifacts and own-package materialization per variant; archive targets, all
  other store entries, and consumer views are invariant. That set is computed
  from the lockfile — ten entries in the current complete lock
  ([decision 0030](../.decisions/0030-normalized-store-scc-and-atomic-cutover.md)
  Amendment 1 enumerates them) — and admission fails closed on a
  platform-varying entry with no configured variant instead of trusting a
  recorded count.
- **DEPS-R04 No per-consumer closures:** The normalized store may materialize
  package bytes once per identity, or once per distinct configured platform-edge
  variant for the platform-selected entries, shared by every consumer.
  Workspace/dist entries may own their small package boundary where realpath
  requires it. Importer views are metadata-only; package execution views copy
  only package-owned sources/workspace dist boundaries and never a dependency
  closure. This invariant holds on filesystems without CoW (BUCK-R08).
- **DEPS-R05 Safe SCC namespaces:** Each of the five real SCCs is assembled once
  in a sandbox from read-only member inputs. Every member occupies its own
  pnpm-compatible namespace; cycle links resolve within the group without
  merging colliding paths. Only the group output and scratch are writable.
- **DEPS-R06 Atomic byte editor snapshots:** An editor snapshot dereferences the
  selected package view into new byte-owned state, validates its digest, then
  atomically renames the complete snapshot and current pointer. It remains
  valid after every backing Buck artifact is deleted and never exposes a
  partial or absent `node_modules`.
- **DEPS-R07 Loud staleness:** The editor record binds manifest, store, view,
  and snapshot digests. Missing, escaping, incomplete, or stale state fails
  loudly before use; a live language server survives a valid flip.
- **DEPS-R08 Bounded fan-out:** A changed package snapshot invalidates its
  normalized entry, its containing SCC when applicable, and only views whose
  closure contains it. Unrelated entries and views remain unchanged
  ([decision 0022](../.decisions/0022-lockfile-derived-declared-closure.md)).
- **DEPS-R09 Fail-closed fetch:** Network access exists only in hash-pinned
  fetch actions. Extraction, entry/SCC assembly, views, snapshots, and consumer
  actions run offline; a missing or mismatched package never falls back.
- **DEPS-R10 Dist-only workspace boundary:** Production workspace entries expose
  manifest-declared built `dist` artifacts and package metadata, never live
  sibling source. Before the single atomic authority flip, every workspace
  package the repository consumes must be dist-servable and every consumer,
  editor, and tool surface must be ready to move in that one change; the 17
  packages of the #1209 graph are a prerequisite subset, not the scope. Staged
  prerequisite PRs build in a named candidate namespace and do not create a
  mixed production boundary.
- **DEPS-R11 No lifecycle scripts:** Package lifecycle/build scripts do not run
  during fetch, extraction, entry/SCC assembly, or view construction.
  `requiresBuild` fails admission until a declared, sandboxed mechanism is
  specified; it never falls back to package-manager execution.
- **DEPS-R12 Bounded snapshot refresh and retention:** Snapshot republication is
  incremental and watch-driven: only packages whose view fingerprint changed are
  republished, and each republication is the atomic sequence of DEPS-R06. The
  snapshot store retains a bounded number of generations per package with the
  current pointer never collected; retained snapshot bytes and generation count
  are measured capacity inputs (BUCK-R07, BUCK-R16, DQ4), not unbounded state.
