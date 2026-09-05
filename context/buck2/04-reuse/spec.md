# Reuse Spec

This document specifies cache-only client wiring and verification of reuse and
capacity claims. It builds on [requirements.md](./requirements.md).

## Status

Draft.

## Scope

**Defines:** cache-only client/executor configuration, upload boundaries,
round-trip proof, and admission metrics.

**Does not define:** service deployment, consumer admission sequencing, or true
remote execution.

## Client Contract

```ini
[buck2]
digest_algorithms = SHA256
default_allow_cache_upload = true

[buck2_re_client]
engine_address = grpc://<tailnet-cache>:<port>
action_cache_address = grpc://<tailnet-cache>:<port>
cas_address = grpc://<tailnet-cache>:<port>
instance_name = <repo-name>
tls = false
```

Execution platforms set `remote_enabled = False`,
`remote_cache_enabled = True`, and `allow_cache_uploads = True`. The execution
platform is required: configuring only a plain target platform may leave the RE
client inactive. Removing the RE client section is the explicit pure-local
outage escape hatch.

Archive extraction, SCC assembly outputs, TypeScript verdicts and dists,
descriptors, and products are uploadable. Graph-composed normalized entries,
importer views, workspace entries, and package views add no separate command
upload; their artifact projections may still materialize bounded owned bytes.

## Reuse Verification

Reuse claims come from Buck-native command and cache-hit classes:

1. populate all admitted targets in context A and assert uploads are nonzero;
2. kill Buck and remove local Buck output in context B;
3. rebuild the same platform/revision and assert every cacheable command is a
   hit and zero commands execute locally;
4. repeat from a different absolute prefix and directory depth;
5. validate every relative link and compare declared output digests.

The 2026-09-04 probe used isolated instance
`storegraph-spike-throwaway`. Its subset population ran 163 local commands and
uploaded 28 MiB including an SCC group; after clean, both the same path and a
different prefix/depth restored 163/163 hits and 0 local commands. Separately,
the full 17-package graph restored 416/416 hits, 0 local commands, and 736 MiB:
378 archive extracts, four cached artifacts for the four SCCs present,
17 typechecks, and 17 emits. The fifth repo-wide SCC was lock-analyzed only and
must build before the final flip. These are closure-scoped probe facts, not
repository-wide proof: the whole-repository candidate namespace E2E required by
03-materialization DQ4 has not run, and the flip covers every consumer, editor,
and tool surface rather than the 17 measured packages. The probe admits cache
uploads but leaves DQ1 open until a CI runner proves connectivity and fallback.
It does not admit true remote execution.

Staged prerequisite work runs in an explicitly named candidate cache namespace
and isolation dir. A candidate-namespace measurement is never reported as a
production-namespace reuse claim, and the flip is the first change that writes
production keys for the new actions.

## Capacity Verification

Every admission records the same lane matrix:

| Lane                          | Required observations                                                            |
| ----------------------------- | -------------------------------------------------------------------------------- |
| warm no-op                    | wall time and local action count                                                 |
| cold local, warm shared cache | wall time, hit/local counts, download bytes, peak disk                           |
| cache-disabled cold lane      | wall time, peak `buck-out`, declared-output and scratch disk, local action count |
| changed package               | p50/p95 action time split into staging and tool execution                        |
| admission series              | marginal wall-time, peak-disk, and action-count slope per package                |
| watch loop                    | edit-to-rebuilt-closure wall time and republished snapshot count                 |
| editor snapshots              | per-package and repository-total snapshot bytes and retained generation count    |

Peak disk sampling includes scratch and `/tmp`, not only retained `buck-out`.
The record names runner capacity, timeout, and the cache namespace it ran in so
headroom and key space are explicit. Averages must not hide the largest closure
or p95 staging cost. A dev3 PR #1209 run was stopped after exceeding 30 minutes
while still running and after reaching at least 24 GB. The full candidate
namespace E2E must produce an accepted numeric envelope before the final flip;
raising timeout or disk alone is insufficient.

## Remote-Execution Gate

`remote_enabled` stays false. Enabling it requires a real remote worker, a cold
CAS, and proof that exact tool closures arrive, Linux/Darwin platform selection
is correct, store/SCC links remain valid at a new path, the sandbox denies the
same undeclared capabilities, and declared outputs are byte-identical. Cache
upload and cache-only restore are necessary but insufficient evidence.

This gate is out of scope for the whole-repository TypeScript cutover
([decision 0030](../.decisions/0030-normalized-store-scc-and-atomic-cutover.md)
Amendment 1): the flip proceeds cache-only and does not wait on
03-materialization DQ3, and no staged PR enables `remote_enabled`.
