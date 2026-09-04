# 0030 Normalized Store, SCC Isolation, And Atomic Cutover

Status: accepted

## Context

Ratified by Johannes on 2026-09-04 while resolving issue #1212. The existing
pipeline copied a dependency closure into an importer tree, copied it again
into each package tree, and staged it again for emit. A dev3 run of PR #1209
was stopped after exceeding 30 minutes while still running and after reaching
at least 24 GB. Filesystem CoW could improve some hosts but could not make
per-consumer dependency-closure duplication correct or portable.

Three interview choices remained after the probes: whether to normalize the
whole admitted store now or migrate importer by importer; how to represent real
lockfile cycles; and whether to make staged prerequisites visible through mixed
production modes or preserve one authority boundary.

## Evidence and Argument

The 2026-09-04 probes established:

- a closure-free tui-react consumer layer reduced 2.14 GB to 2.4 MB;
  typecheck fell from 70.76 s to 0.76 s and emit from 62.18 s to 0.84 s; all 12
  then-green packages completed typecheck and emit in 16.46 s;
- a 17-package normalized graph restored 416/416 cacheable commands with zero
  local execution, occupied 736 MiB, and reduced its consumer layer from
  5.72 GiB/410,714 entries to 7.38 MB/1,243 entries;
- only nine direct-dependency entries vary by platform; tarballs and views do
  not. Five real multi-member SCCs exist repo-wide; the 17-package closure
  exercised four and the fifth was lock-analyzed only;
- a byte-materialized editor snapshot remained complete after deletion of all
  backing artifacts;
- direct Darwin probes proved filesystem, network, environment, and write
  controls. Nested pinned-Buck actions proved byte-identical outputs on Linux
  and mbp2021 plus denial of a required undeclared import;
- no repository consumer uses `.tsbuildinfo`; JavaScript, declarations, and
  maps are the durable TypeScript output boundary.

## Options

| Interview choice     | Selected                                                                                       | Alternatives rejected                                                                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Migration unit       | Normalize the complete admitted per-package pnpm store now                                     | Per-importer migration retains duplicate mechanisms and delays the economic invariant                                                                              |
| Cycles               | One sandboxed assembly action per each of the five real SCCs, with distinct member namespaces  | Flatten members (path collisions and lost identity); source-level cycle breaking (changes package semantics); full importer assembly (restores per-consumer bytes) |
| Authority transition | Staged dependent PRs followed by one atomic final flip after all 17 packages are dist-servable | Mixed production source/dist fallback (two authorities); one monolithic prerequisite PR (unreviewable and hard to bisect)                                          |

## Decision

The admitted JavaScript dependency graph moves to one normalized per-package
pnpm store. Registry tarball extraction is shared across platforms. Each
acyclic peer-resolved store entry copies its own package tree under
`node_modules/<name>` so realpath preserves sibling dependency links; its
dependency edges and importer views are metadata symlinks. Exactly nine entries
with platform-selected edges have one distinct configured entry artifact and
own-package materialization per selected variant. All other entries are
platform-invariant, archive/extract bytes remain shared, and workspace/dist
entries and package execution views own only their small package boundary.

Each of the five real SCCs is assembled once in its platform sandbox. Members
retain distinct pnpm virtual-store namespaces, and consumers reference member
providers backed by the group rather than copying the group.

TypeScript actions build a metadata-only scratch overlay and execute with exact
tool closures: Bubblewrap on Linux, parameterized Seatbelt on Darwin, read-only
inputs, writable declared outputs and scratch, no undeclared filesystem or
network capability, and an environment allowlist. Seatbelt is deprecated, so a
supported macOS upgrade must pass an in-Buck smoke gate before admission. The
sandbox proves denial with explicit probes; an incidental undeclared read is
not assumed to make an arbitrary tool exit nonzero.

TypeScript writes JavaScript, declarations, and maps directly to the declared
output. Incremental build-info is disabled or scratch-only and never published.
The editor additionally receives a byte-owned atomic snapshot so it survives
backing-artifact deletion.

Prerequisites land as dependent PRs without changing production authority. The
single final authority change requires all 17 #1209 packages to be dist-servable
with no source fallback; both platform sandbox gates; editor deletion survival;
deterministic output bytes; cache-only upload/restore; a built fifth SCC; and an
accepted numeric cold wall/disk/staging/admission-slope envelope proven by the
full candidate namespace E2E. Raising timeout or disk alone cannot satisfy the
gate. The change then flips every consumer and deletes the old producer
atomically.

Cache uploads are enabled for cacheable outputs. True remote execution remains
disabled until a real remote backend separately proves tool-closure delivery,
sandboxing, path independence, and output identity.

## Consequences

- Decision 0025's reflink-first importer/package assembly is superseded; its
  mutable-hardlink warning remains valid. The normalized-store cutover delta
  remains open until implementation matches this decision.
- Cache-only restore is necessary but does not settle CI runner connectivity or
  true remote execution.
- The cold lane, peak disk/scratch, staging/action p95, and marginal admission
  slope become numeric admission gates alongside warm-cache latency.
- Vision criterion 9 still prescribes CoW assembly. Because `vision.md` is
  human-owned, the mismatch is recorded as an open root delta rather than
  silently editing the vision.
