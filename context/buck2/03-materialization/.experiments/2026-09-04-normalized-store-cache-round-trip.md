# Normalized Store And Cache Round Trip

Status: accepted
Date: 2026-09-04

## Question

Can one normalized pnpm store replace per-consumer closure copies while
preserving platform selection, real dependency cycles, cache reuse, relocation,
and editor availability for the complete #1209 package set?

## Method

An isolated `storegraph-spike-throwaway` cache instance exercised shared
archive extracts; normalized entries that copy their own package once per
identity or per selected platform-edge variant for the nine keyed entries;
metadata-only dependency/importer links; bounded package views; and SCC group
outputs. A subset was populated, cleaned, rebuilt at the same path, then copied
to a different absolute prefix and directory depth. The full 17-package graph
was separately restored. Three configured platforms were analyzed. Four of the
five repo-wide SCCs occurred in the 17-package closure; the fifth was
lock-analyzed only. An editor view was dereferenced into an atomic byte snapshot
before all backing artifact directories were deleted.

## Result

- The subset population executed 163 local commands and uploaded 28 MiB,
  including an SCC group. After clean, both the same path and a different
  prefix/depth restored 163/163 hits with 0 local commands.
- Separately, all 17 packages typechecked and emitted (17/17 each; 1,268 files).
  Its cold local rebuild restored 416/416 commands, 100% hits and 0 local:
  378 archive extracts, four cached artifacts for the four SCCs present,
  17 typechecks, and 17 emits.
- The normalized graph occupied 736 MiB/56,211 entries, including 0.30 GiB of
  own-package entry copies shared across consumers (with distinct configured
  variants for the nine platform-selected entries). Its consumer layer was
  7,380,252 bytes (7.38 MB)/1,243 entries, versus 5.72 GiB/410,714 entries.
- The three platform closures had 378, 378, and 380 entries over 394 identities.
  371 were shared by all three; 362 store entries were platform-invariant. Only
  nine direct entries required platform-keyed dependency edges: playwright,
  vite, esbuild, rolldown, lightningcss, msgpackr-extract, oxc-resolver,
  oxc-parser, and `@opentui/core`. Archives and consumer views required no
  platform key.
- Cached and relocated outputs contained no absolute or dangling links; SCC
  back-edges and version-distinct transitive packages resolved correctly.
- The notion-core editor snapshot contained 75,490,477 bytes/2,848 entries and
  no symlinks. After deleting 657 backing artifact directories, the snapshot
  remained complete and standalone tsgo typecheck stayed green. An injected
  copy failure exposed no declared snapshot.

## Conclusion

Cache upload, cold cache-only restore, relocation, the nine-entry platform
boundary, four exercised SCCs, and byte-owned editor publication are proven.
The fifth repo-wide SCC must be built before the final flip. DQ1 remains open:
local cache evidence does not prove CI runner connectivity or fallback. True
remote execution was not exercised.

## VRS Impact

DEPS-R02–R06 specify one package copy per normalized identity (per selected
platform-edge variant for nine entries), metadata-only dependency/importer
views, shared archives, the nine-entry platform boundary, five-SCC isolation,
bounded package views, and the byte-owned editor snapshot. REUSE-R01–R02 admit
cache uploads and require cold relocated restores. DQ1 remains blocked on the
ephemeral-tailnet namespace-runner probe; true remote execution remains blocked
on an available remote worker.
