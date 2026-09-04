# DELTA-001: Normalized-store cutover pending decision 0030

Status: open

## Divergence

Decision 0030 requires one package-tree materialization per normalized store
identity, with one configured artifact per selected platform-edge variant for
exactly nine entries; metadata-only dependency edges/importer views; bounded
package/workspace-owned views; isolated SCC assembly; and no per-consumer
dependency-closure copy. The live path still assembles importer closure trees
and copies full closures into package and TypeScript staging trees.

## VRS

- [DEPS-R02–R11](../requirements.md) own normalized entries, platform variants,
  SCCs, views, editor publication, lifecycle policy, and the dist-only boundary.
- [Decision 0025 Amendment 1](../../.decisions/0025-cow-reflink-local-disk-economics.md)
  supersedes reflink-first importer/package closure assembly.

## Implementation

The current importer assembler uses hardlinks with copy fallback; package-tree
copies a full closure with `COPYFILE_FICLONE`; emit stages another full tree.
There is no normalized per-identity store, sandboxed SCC group output,
closure-link importer view, bounded execution view, or byte-independent editor
snapshot matching decision 0030.

## Direction

update implementation

## Resolution Signal

Close only when the staged implementation lands and the atomic authority gate
passes: all 17 packages are dist-servable without production source fallback;
all five repo-wide SCCs build with distinct namespaces; Linux and Darwin
sandbox gates pass; editor snapshots survive deletion of backing artifacts;
cache-only upload/restore works from a CI runner; and the full candidate
namespace E2E satisfies an accepted numeric cold wall, peak disk/scratch,
staging/action p95, and marginal admission-slope envelope. Raising timeout or
disk alone does not satisfy the signal.
