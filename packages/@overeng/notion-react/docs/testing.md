# Testing

How `@overeng/notion-react` is tested and which tests to run when. The
strategy is intentionally layered — pick the cheapest layer that can
falsify your change, and escalate only when it cannot.

## Three layers

| Layer             | Location                          | Network  | Cost  | When to run                                                 |
| ----------------- | --------------------------------- | -------- | ----- | ----------------------------------------------------------- |
| Unit              | `src/**/*.unit.test.tsx`          | none     | <1s   | every change; default `pnpm test` target                    |
| Mock-client       | `src/test/integration/*.test.tsx` | none     | ~s    | renderer or diff changes that do not touch wire projection  |
| Live E2E (Notion) | `src/test/integration/e2e/*.tsx`  | real API | 5-7 m | wire-projection, new block types, mutation ordering, caches |

### Unit (`vitest`)

Covers `flattenRichText`, `buildCandidateTree` / `diff` / `tallyDiff`, the
reconciler host-config, each block component's prop wiring, and the
`FsCache` schema / round-trip. No network, no Notion types at runtime —
pure reducer-style assertions.

Current coverage: ~105 tests across 6 files (`src/**/*.unit.test.ts{,x}`,
excluding the mock-client driver test below).

```sh
CI=1 pnpm vitest run             # from packages/@overeng/notion-react/
# or
pnpm --filter @overeng/notion-react test
```

### Mock-client integration

Runs the full reconciler ↔ diff ↔ client loop with a Notion client that
records calls but does not hit the network. Asserts the ordered sequence
of `append`/`update`/`delete` ops and the `FsCache` round-trip without
paying for latency.

Key fixtures:

- `src/test/mock-client.ts` — in-memory `NotionBlocks` that records ops
  and mirrors server state
- `src/renderer/sync-mock.unit.test.tsx` — driver for the full `sync()`
  loop (7 tests: cold append, no-op resync, update, mid-insert, delete,
  cache drift, nested children)

```sh
pnpm --filter @overeng/notion-react test:integration
```

### Live E2E

Drives the renderer round-trip against a real Notion workspace
(`src/test/integration/e2e/*.e2e.test.tsx` — blocks, mutations,
edge-cases, prop-projection). Each test creates
its own short-lived scratch subpage under `NOTION_TEST_PARENT_PAGE_ID`,
performs the operation, reads the server back, and archives the scratch
page on teardown — even on failure. The harness serializes tests onto
a single lane (`acquireLane` + `vitest` `fileParallelism=false`) to stay
well under Notion's ~3 req/s budget.

```sh
pnpm --filter @overeng/notion-react test:integration:e2e
```

Required environment variables:

- `NOTION_API_TOKEN` — an integration token with access to the test page
- `NOTION_TEST_PARENT_PAGE_ID` — the page id each scratch page is
  nested under

Missing either env var silently skips the whole E2E suite via
`describe.skipIf(SKIP_E2E)`. Both are typically sourced from
`secretspec.toml` / `secrets-run` from the repo shell.

#### E2E sub-suites

- `blocks.e2e.test.tsx` — one round-trip per v0.1 block type
  (paragraph, headings, lists, to_do, toggle, code, quote, callout,
  divider, image, bookmark, embed, equation, column_list, link_to_page,
  table_of_contents, breadcrumb, plus mixed-content page). Four
  media-upload tests (`video`, `audio`, `file`, `pdf`) are skipped
  pending the `file_upload` API.
- `mutations.e2e.test.tsx` — `sync()` semantics: cold, no-op resync,
  update, append, keyed mid-insert, delete, mixed mutations, cache
  drift (flat + nested), archive mid-lifecycle, page title change,
  100-keyed-paragraphs scale, manual-edit overwrite, cold sync against
  pre-seeded blocks.
- `edge-cases.e2e.test.tsx` — empty page, single block, unicode +
  emoji + RTL + ZWJ, 2000-char rich_text limit, concurrent syncs,
  missing-env error paths, bad-URL image failure.
- `prop-projection.e2e.test.tsx` — prop matrices that hit the wire
  shape: callout icon/color, code language, heading toggleable, to_do
  checked, link href, image external URL envelope, toggle title,
  inline annotations composition.

## Decision table: "I changed X → run layer Y"

| Change surface                                       | Unit | Mock | E2E |
| ---------------------------------------------------- | :--: | :--: | :-: |
| Component prop wiring or JSX shape                   |  Y   |      |     |
| `flattenRichText` / inline annotation logic          |  Y   |  Y   |  Y  |
| `buildCandidateTree` / `diff` / key matching         |  Y   |  Y   |     |
| Host-config projection (block payload shape)         |  Y   |      |  Y  |
| `sync()` ordering, idMap, or cache interaction       |  Y   |  Y   |  Y  |
| Notion API adapter (`@overeng/notion-effect-client`) |      |      |  Y  |
| New block type                                       |  Y   |  Y   |  Y  |
| Error type / failure channel                         |  Y   |  Y   |     |

## Pointing at a different Notion workspace

Export `NOTION_API_TOKEN` and `NOTION_TEST_PARENT_PAGE_ID` in the local shell, or declare them in `secretspec.toml` with a provider-backed `ref` so the configured SecretSpec provider resolves them.

Notes:

- The token must be an integration token (`secret_*`), not a user
  session token. The integration must be explicitly added to the test
  parent page via "Add connections" in Notion.
- The parent page must be reachable by the integration; scratch pages
  inherit its permissions.
- Run live tests through `secrets-run --reason "run notion-react live tests" -- <command>`.

## What the E2E harness proves (and does not)

Proves:

- Every v0.1 block type can be appended, read back, and matches the
  projected payload shape on the wire.
- The cache-backed incremental `sync()` issues the minimum number of
  `append`/`insert`/`update`/`delete` ops for each mutation class.
- Keyed reorders materialize as `{inserts, removes}` pairs (Notion has
  no block-move API).
- Concurrent syncs with independent caches interleave without losing
  blocks.
- Unicode, RTL, ZWJ emoji, and 2000-char rich_text round-trip verbatim.

Does not prove:

- 429 / 5xx retry behaviour (covered by the client package's own
  tests).
- Cache-file corruption, partial writes, or interruption mid-sync.
- Same-key type-change scenarios (e.g. paragraph → heading with the
  same `blockKey`) — Notion's API does not support type changes and
  the diff currently emits an `update` that the API will reject.
- Sibling `blockKey` collisions within one parent (silently overwritten
  by the diff).
- File / video / audio / PDF uploads via the `file_upload` API.

These gaps are tracked as GitHub issues; see `context/testing/` for
latest review notes.
