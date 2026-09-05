# DELTA-001: Vision criterion 9 prescribes CoW assembly

Status: open

## Divergence

Vision criterion 9 says assembled and materialized trees share storage through
copy-on-write where the filesystem permits and confines full duplication to
other filesystems. Decision 0030 and BUCK-R08 now require each normalized entry
to own one package-tree copy shared across consumers, with one configured copy
per selected platform-edge variant for the lockfile-derived platform-selected
set (ten entries in the current complete lock; decision 0030 Amendment 1);
archive/extract bytes remain shared. Dependency edges and importer/scratch
views remain metadata-only, while workspace/package views own only their small
boundary. Per-consumer dependency closure materialization is rejected even
where CoW is unavailable. The editor availability snapshot intentionally owns
copied bytes, and its retained generations are a bounded, measured cost.

## VRS

- `vision.md` criterion 9 prescribes CoW assembly with full-copy fallback.
- BUCK-R08 and decision 0030 require one package copy per normalized identity
  (per selected platform-edge variant for the platform-selected entries),
  shared archive bytes, metadata-only dependency/importer views, and no
  per-consumer closure copy, independent of filesystem CoW.
- Decision 0025 Amendment 1 preserves bounded workspace/package boundaries and
  byte snapshots where realpath or editor availability requires them.

## Implementation

No implementation claim resolves this divergence: `vision.md` is human-owned
and was not edited. Requirements and specs carry the confirmed architecture
while this delta keeps the authority-layer disagreement visible.

## Direction

update VRS

## Resolution Signal

Johannes amends vision criterion 9 to express one package copy per normalized
identity (per selected platform-edge variant for the lockfile-derived
platform-selected entries), metadata-only dependency/importer views, bounded
workspace/package boundaries, and the byte-owned editor snapshot exception with
bounded retention. Implementation progress alone does not close this delta.
