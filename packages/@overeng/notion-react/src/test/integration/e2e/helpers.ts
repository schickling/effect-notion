import { Duration, Effect, Layer, Redacted, Schedule } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'
import type { HttpClient } from 'effect/unstable/http/HttpClient'

import type { NotionApiError } from '@overeng/notion-effect-client'
import { NotionBlocks, NotionConfig, NotionPages } from '@overeng/notion-effect-client'

import { NotionSyncError } from '../../../renderer/errors.ts'

/**
 * E2E test harness for `@overeng/notion-react`. Each test creates its own
 * short-lived scratch subpage under `NOTION_TEST_PARENT_PAGE_ID`, drives the
 * renderer against the live Notion API, reads the result back, and archives
 * the scratch page on teardown — even on failure.
 *
 * Concurrency is intentionally conservative: the shared gate keeps the in-
 * flight test count at 1 so we stay well under Notion's ~3 req/s budget
 * even with retries.
 */

/** Skip e2e tests when either credential is missing. */
export const SKIP_E2E = !process.env.NOTION_API_TOKEN || !process.env.NOTION_TEST_PARENT_PAGE_ID

/** Parent page under which each test creates a scratch child page. */
export const TEST_PARENT_PAGE_ID = process.env.NOTION_TEST_PARENT_PAGE_ID ?? ''

/**
 * Throw a clear error when credentials are missing. Exported so edge-case
 * tests can exercise the error paths directly; `withScratchPage` calls it
 * before every test body.
 */
export const assertEnv = (env: NodeJS.ProcessEnv = process.env): void => {
  if (!env.NOTION_API_TOKEN) {
    throw new Error(
      'NOTION_API_TOKEN is not set. See packages/@overeng/notion-react/devenv.local.nix for the expected value.',
    )
  }
  if (!env.NOTION_TEST_PARENT_PAGE_ID) {
    throw new Error(
      'NOTION_TEST_PARENT_PAGE_ID is not set. Expected the id of a Notion page shared with the test integration.',
    )
  }
}

/** Live `NotionConfig` layer driven by `NOTION_API_TOKEN`. */
export const NotionConfigLive = Layer.succeed(NotionConfig, {
  authToken: Redacted.make(process.env.NOTION_API_TOKEN ?? ''),
  retryEnabled: true,
  maxRetries: 5,
  retryBaseDelay: 1000,
})

/** Full Effect layer for e2e tests: live config + fetch HTTP. */
export const E2ELayer: Layer.Layer<NotionConfig | HttpClient> = Layer.mergeAll(
  NotionConfigLive,
  FetchHttpClient.layer,
)

/** Effect env required by any helper below. */
export type E2EEnv = NotionConfig | HttpClient

/**
 * Exponential backoff on rate-limit / transient errors. The underlying
 * `NotionConfig.retryEnabled=true` already handles per-request 429 retries;
 * this schedule is an outer guard for whole-operation retries when a test
 * helper composes multiple requests.
 */
const e2eRetrySchedule = Schedule.exponential(Duration.seconds(1), 2.0).pipe(
  Schedule.upTo({ times: 4 }),
)

/**
 * Serialize all scratch-page work on a single lane. We run tests
 * sequentially anyway (vitest `fileParallelism=false`), but this makes the
 * contract explicit and lets helpers that spawn multiple concurrent Effects
 * self-throttle.
 */
const acquireLane = (() => {
  let tail: Promise<void> = Promise.resolve()
  return (): Promise<() => void> => {
    let release: () => void = () => {}
    const next = new Promise<void>((resolve) => {
      release = resolve
    })
    const prev = tail
    tail = tail.then(() => next)
    return prev.then(() => release)
  }
})()

/**
 * Create a fresh scratch child page under `TEST_PARENT_PAGE_ID`. The title
 * includes the test label + ISO timestamp so concurrent runs don't collide
 * visually in the workspace tree.
 */
export const createScratchPage = (label: string): Effect.Effect<string, NotionApiError, E2EEnv> =>
  Effect.gen(function* () {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const res = yield* NotionPages.create({
      parent: { type: 'page_id', page_id: TEST_PARENT_PAGE_ID },
      properties: {
        title: {
          title: [{ type: 'text', text: { content: `notion-react e2e: ${label} @ ${stamp}` } }],
        },
      },
    })
    const id = (res as { id?: string }).id
    if (id === undefined) throw new Error(`createScratchPage(${label}): Notion returned no id`)
    return id
  })

/** Archive (soft-delete) a scratch page. Swallows errors so teardown never masks the real failure. */
export const archiveScratchPage = (pageId: string): Effect.Effect<void, never, E2EEnv> =>
  NotionPages.archive({ pageId }).pipe(
    Effect.asVoid,
    Effect.catch((cause) => {
      // eslint-disable-next-line no-console
      console.warn(`archiveScratchPage(${pageId}) failed (ignored):`, cause)
      return Effect.void
    }),
  )

/**
 * Lightweight view of a Notion block tree — `type` + raw per-type payload +
 * recursively fetched `children`. Assertion-friendly shape that hides API
 * wire details (e.g. pagination, `object: 'block'`).
 */
export interface ReadBlockNode {
  readonly id: string
  readonly type: string
  readonly payload: Record<string, unknown>
  readonly children: readonly ReadBlockNode[]
}

/**
 * Recursively read a page's block tree. Bounded depth keeps runaway
 * recursion contained if the fixture is unexpectedly deep.
 */
/**
 * Retry schedule for the `has_children: true && results.length === 0` paradox
 * that occasionally surfaces under API load — Notion briefly serves an empty
 * page for children that are indexed but not yet visible to a reader. Bounded
 * so a genuine empty tree never hangs the suite.
 */
const childrenSettleSchedule = Schedule.exponential(Duration.millis(500), 1.5).pipe(
  Schedule.upTo({ times: 4 }),
)

const retrieveChildrenSettled = (
  blockId: string,
  expectChildren: boolean,
): Effect.Effect<{ results: ReadonlyArray<unknown> }, NotionApiError, E2EEnv> =>
  NotionBlocks.retrieveChildren({ blockId }).pipe(
    Effect.filterOrFail(
      (res) => !(expectChildren && res.results.length === 0),
      () => new NotionSyncError({ reason: 'children-not-yet-visible', cause: blockId }),
    ),
    Effect.retry(childrenSettleSchedule),
    // If the paradox never resolves within the budget, fall through with an
    // empty list rather than erroring — callers can still assert a readable
    // tree and see the mismatch as a test failure instead of a flake.
    Effect.catch(() => NotionBlocks.retrieveChildren({ blockId })),
  )

export const readPageTree = (
  pageId: string,
  maxDepth = 8,
  expectChildren = false,
): Effect.Effect<readonly ReadBlockNode[], NotionApiError, E2EEnv> =>
  Effect.gen(function* () {
    if (maxDepth < 0) return [] as readonly ReadBlockNode[]
    const res = yield* retrieveChildrenSettled(pageId, expectChildren)
    const out: ReadBlockNode[] = []
    for (const raw of res.results) {
      const block = raw as {
        id: string
        type: string
        has_children?: boolean
        [k: string]: unknown
      }
      const payload = (block[block.type] as Record<string, unknown>) ?? {}
      const children = block.has_children ? yield* readPageTree(block.id, maxDepth - 1, true) : []
      out.push({ id: block.id, type: block.type, payload, children })
    }
    return out
  }).pipe(Effect.retry(e2eRetrySchedule))

/**
 * Run a test body against a fresh scratch page. Lane-serialized so at most
 * one scratch page is live at a time; always archives on exit, even on
 * failure. The return type is a `Promise` so tests can `await` it directly.
 */
export const withScratchPage = async <A, E>(
  label: string,
  body: (pageId: string) => Effect.Effect<A, E, E2EEnv>,
): Promise<A> => {
  assertEnv()
  const release = await acquireLane()
  try {
    return await Effect.runPromise(
      Effect.gen(function* () {
        const pageId = yield* createScratchPage(label)
        try {
          return yield* body(pageId)
        } finally {
          yield* archiveScratchPage(pageId)
        }
      }).pipe(Effect.provide(E2ELayer)),
    )
  } finally {
    release()
  }
}

/** Rich-text item shape used across block-type assertions. */
export interface RichTextItem {
  readonly plain_text?: string
  readonly href?: string | null
  readonly annotations?: {
    readonly bold?: boolean
    readonly italic?: boolean
    readonly underline?: boolean
    readonly strikethrough?: boolean
    readonly code?: boolean
    readonly color?: string
  }
}

/** Pluck the first `rich_text[].plain_text` entry of a block payload. */
export const firstPlainText = (node: ReadBlockNode): string => {
  const rt = (node.payload.rich_text ?? []) as readonly RichTextItem[]
  return rt[0]?.plain_text ?? ''
}

/** Concatenate all `plain_text` fragments of a block into a single string. */
export const concatPlainText = (node: ReadBlockNode): string => {
  const rt = (node.payload.rich_text ?? []) as readonly RichTextItem[]
  return rt.map((r) => r.plain_text ?? '').join('')
}
