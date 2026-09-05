# DELTA-001: Normalized-store cutover acceptance pending

Status: open

## Divergence

Decision 0030 requires one package-tree materialization per normalized store
identity, one configured artifact per selected platform-edge variant,
metadata-only importer views, bounded package/workspace views, isolated SCC
assembly, and no per-consumer dependency-closure copy. The cutover candidate
implements this data plane and deletes the legacy importer-closure copies. The
remaining divergence is operational acceptance: CI runner cache reachability,
the numeric capacity envelope, and cross-platform proof must pass before the
candidate can land.

## VRS

- [DEPS-R02–R11](../requirements.md) own normalized entries, platform variants,
  SCCs, views, editor publication, lifecycle policy, and the dist-only boundary.
- [Decision 0025 Amendment 1](../../.decisions/0025-cow-reflink-local-disk-economics.md)
  supersedes reflink-first importer/package closure assembly.

## Implementation

The candidate has one normalized target per lockfile identity, ten
platform-selected entries, five SCC assembly actions with distinct namespaces,
metadata-only importer views, hardlink package farms closed over declared
artifact roots, and byte-owned editor snapshots with bounded retention.
All 38 TypeScript projects consume these declared views under Buck authority;
the root install and both root TypeScript solutions are deleted. Linux uses an
exact Bubblewrap closure and Darwin uses an exact Seatbelt profile. No
production source fallback or per-consumer dependency-closure copy remains.

## Direction

update implementation

## Resolution Signal

Close only when the staged implementation lands and the single whole-repository
authority gate passes: every consumed workspace package is dist-servable
without production source fallback (the 17 #1209 packages are the prerequisite
subset); all five repo-wide SCCs build with distinct namespaces; the
`exec_linux_x86_64`, `exec_linux_aarch64`, and `exec_macos_aarch64` sandbox
gates pass and each platform's mutation-hashing control is deleted with its own
gate; editor snapshots survive deletion of backing artifacts and refresh
incrementally under the watch loop; cache-only upload/restore works from a CI
runner; and the full candidate namespace E2E satisfies an accepted numeric cold
wall, peak disk/scratch, editor-snapshot disk/retention, staging/action p95, and
marginal admission-slope envelope. Raising timeout or disk alone does not
satisfy the signal.
