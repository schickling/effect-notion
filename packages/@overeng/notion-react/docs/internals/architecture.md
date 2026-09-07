# Internals — Architecture

Map of the package for someone navigating the source for the first
time. Projection of the normative spec
([`../vrs/spec.md`](../vrs/spec.md)) — when the
two diverge, the spec wins and this page needs updating.

## Module boundaries

```
packages/@overeng/notion-react/
  src/
    components/   Authoring surface — JSX components
      mod.ts
      blocks.tsx      Notion-host components (Page, Heading1, Toggle, …)
      inline.tsx      Inline components (Bold, Link, Mention, …)
      props.ts        Shared prop shapes — host + web
      h.ts            JSX helper that bypasses `IntrinsicElements`
    renderer/     Reconciler + diff + sync driver
      mod.ts
      host-config.ts        react-reconciler host-config (R01, R07, R19, R23)
      op-buffer.ts          In-memory container holding the reconciler's ops
      flatten-rich-text.ts  JSX children -> Notion rich_text[] (R02)
      keys.ts               `blockKey(businessId)` helper
      sync-diff.ts          CandidateTree, LCS diff, tallyDiff (R04-R07, R16)
      sync.ts               Cache-backed incremental sync (R08, R10, R16, R18)
      render-to-notion.ts   Cold-start append-only driver
      upload-registry.ts    v0.1 pre-resolve upload path (R14); v0.2 Suspense (R15)
      errors.ts             NotionSyncError, CacheError (tagged errors)
    cache/        Pluggable cache layer (R10-R13)
      mod.ts
      types.ts          NotionCache interface, CacheTree, CacheNode, CACHE_SCHEMA_VERSION
      fs-cache.ts       JSON file, atomic rename on save
      in-memory-cache.ts  In-process cache for tests
    web/          DOM mirrors + CSS (T05, R21; preview only, not API-stable)
      mod.ts
      blocks.tsx, inline.tsx
      styles.css, vendored-notion.css, katex.css
      *.stories.tsx     Storybook — visual source of truth
    test/         Integration harness + live Notion e2e
    mod.ts        Package entry: re-exports components + renderer + cache
  docs/vrs/   Design source of truth
  docs/         This directory — reader-facing projection
```

## Data flow — one `sync` call

```
  [1] opts.cache.load   ->   [2] buildCandidateTree   ->   [3] diff(prior, candidate)
       CacheTree?              Instance tree                  DiffOp[]
       (prior)                 -> CandidateTree
                                                               |
                                                               v
  [6] opts.cache.save   <-  [5] resolveTreeIds  <-  [4] applyDiff(ops, idMap, checkpoint)
       CacheTree               candidate                    NotionBlocks.{append, update, delete}
       (fresh)                 (tmp-ids resolved)            (checkpoint fires after each call)
```

1. **Load** the prior `CacheTree` from the configured `NotionCache`.
   `undefined` triggers `fallbackReason = "cold-cache"`. A schema
   version mismatch triggers `"schema-mismatch"` — the stale tree is
   still used for matching, so keys that didn't move still line up.
2. **Render** the JSX through `react-reconciler` using the host-config
   in `renderer/host-config.ts`. The reconciler builds an in-memory
   `Instance` tree; `buildCandidateTree` walks it to produce a
   `CandidateTree` of projected props + djb2 hashes + keys.
3. **Diff** the prior `CacheTree` against the new `CandidateTree`.
   LCS over `(key, type)` pairs per parent. Emits a flat `DiffOp[]`
   plan of `append` / `insert` / `update` / `remove`.
4. **Apply** the plan. Consecutive append/insert ops sharing a parent
   are coalesced into batched `NotionBlocks.append` calls capped at
   100 children per request. Server-assigned ids fill a tmp-id → real-id
   map so chained ops resolve. After each API call, a working-cache
   checkpoint is flushed so a mid-sync failure leaves the cache
   reflecting exactly what landed on the server.
5. **Resolve** the candidate tree's tmp-ids to real server ids via
   `resolveTreeIds`.
6. **Save** the resolved candidate tree as the authoritative
   `CacheTree` snapshot.

Return: `SyncResult { appends, updates, removes, inserts, fallbackReason? }`.

## Where each requirement lives

| Requirement | Implementation |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| R01 1:1 block fidelity | `components/blocks.tsx`, `renderer/host-config.ts` (`blockProps`) |
| R02 Rich text via composition | `components/inline.tsx`, `renderer/flatten-rich-text.ts` |
| R03 Component reuse | Plain React — no library machinery |
| R04-R06 Op-minimal sync | `renderer/sync-diff.ts` (LCS + hash), `renderer/sync.ts` (coalescing) |
| R07 Keyed identity | `renderer/host-config.ts` (reads `blockKey` prop), `renderer/keys.ts`, `renderer/sync-diff.ts` (LCS over `(key, type)`) |
| R08 Effect return type | `renderer/render-to-notion.ts`, `renderer/sync.ts` |
| R09 No ambient state | All dependencies flow through `NotionConfig                                                                             | HttpClient` in the Effect env |
| R10-R13 Pluggable cache | `cache/types.ts`, `cache/fs-cache.ts`, `cache/in-memory-cache.ts` |
| R14-R15 Uploads | `renderer/upload-registry.ts` (pre-resolve; Suspense stubs in place) |
| R16-R18 Fallbacks | `renderer/sync.ts` (schema + cold-cache + page-id drift), `SyncResult.fallbackReason` |
| R19-R20 Testing | `src/test/integration/` (mock-client + e2e) |
| R21 Web renderer | `src/web/` (DOM + CSS + stories) |
| R22-R23 Bounded upstream churn | Pinned versions in `package.json`; host-config hidden behind `renderer/mod.ts` |

## External dependencies

```
  @overeng/notion-react
        |
        +--> @overeng/notion-effect-client   NotionBlocks + NotionConfig
        |
        +--> @overeng/notion-effect-schema   BlockType literal enum
        |
        +--> effect + @effect/platform       Effect runtime, HttpClient
        |
        +--> react + react-reconciler        Rendering
        |
        +--> shiki (optional peer)           Code highlighting in web preview
        |
        +--> katex (optional peer)           Math rendering in web preview
```

All four packages in the first three rows are **required** peer
dependencies; the library refuses to run without them. `shiki` and
`katex` are **optional** — only the web preview needs them, and only
for code blocks / equations respectively.

## See also

- [Internals → Reconciler internals](./reconciler-internals.md) — deep
  dive on the host-config surface, LCS algorithm, and cache schema.
- [`../vrs/spec.md`](../vrs/spec.md) — normative
  spec.
