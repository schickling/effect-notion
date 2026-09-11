# Getting Started

Render a Notion page from JSX in about five minutes. The library is
Effect-native; this page shows the smallest program that produces a
Notion page from a React tree.

## Prerequisites

- Node 20+ or Bun 1.1+.
- A Notion integration token (`secret_*`) with access to a parent page.
  Create one at https://www.notion.so/my-integrations and add it to the
  target page via _Share → Invite → your integration_.
- The parent page's UUID (the 32-hex segment of the page URL).

## Install

`@overeng/notion-react` is not yet published to npm — depend on it as a
workspace package or via a git ref. React 19 and `react-reconciler` are
peer dependencies.

```sh
pnpm add @overeng/notion-react effect @effect/platform \
         @overeng/notion-effect-client react react-reconciler
```

`katex` and `shiki` are optional peer dependencies — install them only
if you render math equations or syntax-highlighted code in the web
preview. KaTeX 0.18 depends on `commander` 15, whose `engines` field
advertises Node >= 22.12. That is an install-time advisory, not a
runtime requirement: npm-family installers may warn about it (and will
fail only under `engine-strict`), Bun ignores `engines` entirely, and
the renderer never loads it — `commander` is imported solely by KaTeX's
`cli.js`, which equation previews do not touch. Rendering keeps the
Node 20+ / Bun 1.1+ baseline above.

## First render (cold append)

`renderToNotion` runs in append-only mode: it assumes the target page
has no children the renderer needs to reconcile. Use this for
first-time creation or one-off scripts.

```tsx
import { Effect, Layer } from 'effect'
import { NodeHttpClient } from '@effect/platform-node'
import { NotionConfig } from '@overeng/notion-effect-client'
import { Heading1, Paragraph, renderToNotion } from '@overeng/notion-react'

const Page = () => (
  <>
    <Heading1>Q2 Launch Plan</Heading1>
    <Paragraph>Draft — rewriting this on every run is fine for a cold start.</Paragraph>
  </>
)

const program = renderToNotion(<Page />, {
  pageId: process.env.NOTION_PAGE_ID!,
})

const runtime = Layer.mergeAll(
  NodeHttpClient.layer,
  NotionConfig.layerFromEnv, // reads NOTION_API_TOKEN
)

await Effect.runPromise(Effect.provide(program, runtime))
```

Run it (`NOTION_API_TOKEN=secret_... NOTION_PAGE_ID=... bun run ./script.tsx`)
and the page should now contain the heading and paragraph.

## Incremental sync (warm path)

Once a page has content the renderer owns, switch to `sync`. It loads a
prior tree snapshot from a `NotionCache`, diffs the new render against
it, and issues only the necessary ops. The shipped
[`FsCache`](../src/cache/fs-cache.ts) persists the tree to a JSON file
with atomic-rename writes.

```tsx
import { FsCache, sync } from '@overeng/notion-react'

const cache = FsCache.make('.notion-cache.json')

const program = sync(<Page />, {
  pageId: process.env.NOTION_PAGE_ID!,
  cache,
})

await Effect.runPromise(Effect.provide(program, runtime))
```

Run it twice in a row: the second run performs zero Notion mutations.
Change one `<Paragraph>`'s text and rerun: one `update` op.

`sync` returns a `SyncResult`:

```ts
type SyncResult = {
  readonly appends: number
  readonly updates: number
  readonly removes: number
  readonly inserts: number
  readonly fallbackReason?: string
}
```

`fallbackReason` is set when the warm-path diff was bypassed:

- `"cold-cache"` — no prior snapshot (first run).
- `"schema-mismatch"` — on-disk schema version predates the current
  `CACHE_SCHEMA_VERSION`.
- `"cache-drift"` — another client archived or added top-level blocks
  out of band; detected by a pre-flight `blocks.children` fetch.
- `"page-id-drift"` — the cache was written for a different `pageId`
  (e.g. shared cache file between scripts); renderer cold-starts.

Unset means the warm path ran cleanly.

## Rendering a list

Stable identity across renders requires `blockKey`:

```tsx
const Tasks = ({ tasks }: { tasks: { id: string; title: string }[] }) => (
  <>
    {tasks.map((t) => (
      <Paragraph key={t.id} blockKey={t.id}>
        {t.title}
      </Paragraph>
    ))}
  </>
)
```

Without `blockKey`, siblings fall back to positional keys and a
mid-list insert degrades to a tail remove + re-insert. See
[Keys and identity](./concepts/keys-and-identity.md) for the full model.

## Next steps

- Learn the identity model in
  [Concepts → Keys and identity](./concepts/keys-and-identity.md).
- See how a render becomes Notion ops in
  [Concepts → Reconciler](./concepts/reconciler.md).
- Browse the exported surface in the [API overview](./api.md).
