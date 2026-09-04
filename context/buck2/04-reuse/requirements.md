# Reuse Requirements

This subsystem owns the shared action cache, cache-only execution boundary, and
reuse/capacity criteria. It refines BUCK-R06, BUCK-R07, BUCK-R08, and BUCK-R16.
Service deployment authority remains dotfiles-owned.

## Assumptions

- **REUSE-A01 Cache facts:** The fleet cache is bazel-remote, cache-only, on
  dev3, open read+write inside the tailnet
  ([decision 0013](../.decisions/0013-shared-cache-foundation.md)).
- **REUSE-A02 Disposable state:** CAS and action-cache content is rebuildable;
  wiping the backend costs a cold period, never authoritative data.

## Acceptable Tradeoffs

- **REUSE-T01 Cache-only placement:** Actions execute locally while
  `remote_cache_enabled` and uploads are enabled. This proves remote reuse, not
  true remote execution; `remote_enabled` stays false until separately proven.

## Requirements

- **REUSE-R01 Uploading cache-only actions:** Every cacheable archive, SCC,
  verdict, dist, descriptor, and product action reads and uploads to the shared
  action cache. Graph-composed entries/views have no separate command output.
  A declared uncacheable exception names the path-dependent byte that forces it.
- **REUSE-R02 Zero re-execution:** After population, a second same-platform
  context at the same revision and a cold local `buck-out` executes zero local
  actions for unchanged targets. Relocation to a different absolute prefix must
  preserve the result.
- **REUSE-R03 Capacity envelope:** The surface holds warm no-op ≤ 5 s and fresh
  context with warm cache ≤ 3 min. Before an authority flip, the full candidate
  cache-disabled lane must satisfy an accepted numeric cold wall, peak
  `buck-out`/output/scratch disk, staging/action p95, and marginal
  time/disk/action-count envelope. Raising timeout or disk alone is
  insufficient; regression blocks widening.
- **REUSE-R04 Outage posture:** In the pinned Buck2, an unreachable configured
  cache is a hard action failure. The consumer contract provides a one-line
  disable toggle; monitoring makes an outage an operations event.
- **REUSE-R05 Digest and transport discipline:** SHA256 is explicit; client
  configuration lives in a buckconfig file; batched transfers stay below the
  pinned client's 4 MiB gRPC limit.
- **REUSE-R06 Shared action cache:** The action cache is shared across
  repositories. `instance_name` is attribution, not correctness isolation;
  revocation is a cache wipe.
- **REUSE-R07 Output and local-disk economics:** Uploads contain shared package
  artifacts, SCC outputs, slim verdicts, dists, and descriptors, never private
  staged input trees. Each normalized identity may own one package copy; the
  nine entries with platform-selected edges own one per configured variant.
  Archive bytes remain shared, dependency edges/importer/scratch views are
  metadata-only, and package views materialize only package-owned boundaries.
  Per-consumer dependency-closure duplication is rejected regardless of CoW.
- **REUSE-R08 Remote execution disabled:** `remote_enabled` remains false until
  a real remote worker proves platform identity, exact tool closures, sandbox
  enforcement, path-independent links, and byte-stable declared outputs. A
  cache hit is not evidence for this requirement.
