import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { Effect, type FileSystem, Layer, Redacted, Schema, Stream } from 'effect'
import { FetchHttpClient, type HttpClient } from 'effect/unstable/http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  NotionBlocks,
  type NotionConfig,
  NotionConfigLive,
  NotionPages,
} from '@overeng/notion-effect-client'
import type { Block } from '@overeng/notion-effect-schema'

import { parseNmdFile, renderNmdFile } from './frontmatter.ts'
import { NotionMdGatewayLive } from './live.ts'
import type { NotionMdGateway } from './model.ts'
import { NmdStateStoreLive, objectPath, type NmdStateStore } from './state-store.ts'
import { pullPage, pushPage, statusPage, syncPage } from './sync.ts'

const token = process.env.NOTION_API_TOKEN
const testParentPageId = process.env.NOTION_TEST_PARENT_PAGE_ID
const defaultAllowedTestParentPageIds = [testParentPageId].filter(
  (id): id is string => id !== undefined && id.length > 0,
)
const allowedTestParentPageIds = new Set(
  (process.env.NOTION_MD_TEST_PARENT_PAGE_ID_ALLOWLIST ?? defaultAllowedTestParentPageIds.join(','))
    .split(',')
    .map((id) => id.trim().replaceAll('-', ''))
    .filter((id) => id.length > 0),
)
const skipLive =
  token === undefined ||
  token.length === 0 ||
  testParentPageId === undefined ||
  testParentPageId.length === 0

describe('notion-md live integration configuration', () => {
  it('fails fast in required-live mode when credentials or parent page are missing', () => {
    if (process.env.NOTION_MD_LIVE_REQUIRED !== '1') {
      expect(skipLive).toBeTypeOf('boolean')
      return
    }

    expect(
      {
        hasToken: token !== undefined && token.length > 0,
        hasParentPage: testParentPageId !== undefined && testParentPageId.length > 0,
        hasAllowedParentPage:
          testParentPageId !== undefined &&
          allowedTestParentPageIds.has(testParentPageId.replaceAll('-', '')),
      },
      'NOTION_MD_LIVE_REQUIRED=1 requires NOTION_API_TOKEN, NOTION_TEST_PARENT_PAGE_ID, and an allowed test parent',
    ).toEqual({
      hasToken: true,
      hasParentPage: true,
      hasAllowedParentPage: true,
    })
  })
})

const ConfigLayer = NotionConfigLive({
  authToken: Redacted.make(token ?? ''),
  retryEnabled: true,
  maxRetries: 5,
  retryBaseDelay: 1000,
})

const BaseLayer = Layer.mergeAll(ConfigLayer, FetchHttpClient.layer)
const StateStoreLayer = NmdStateStoreLive.pipe(Layer.provide(NodeServices.layer))
const TestLayer = Layer.mergeAll(
  BaseLayer,
  StateStoreLayer,
  NodeServices.layer,
  NotionMdGatewayLive.pipe(Layer.provide(BaseLayer)),
)

type LiveEnv =
  | FileSystem.FileSystem
  | NotionMdGateway
  | NotionConfig
  | HttpClient.HttpClient
  | NmdStateStore

const runLive = <A, E>(effect: Effect.Effect<A, E, LiveEnv>) =>
  Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(TestLayer))))

/**
 * The configured parent must be a private, dedicated notion-md test page.
 * Scratch cleanup archives only children with this exact prefix, but the ledger
 * still records CI identifiers such as GitHub SHA/run id for traceability.
 */
const scratchTitlePrefix = 'notion-md e2e: '
const ledgerTitle = 'notion-md e2e run ledger'

/** Raised when live cleanup targets a parent page outside the test allowlist. */
class DisallowedTestParentPageError extends Schema.TaggedError<DisallowedTestParentPageError>()(
  'DisallowedTestParentPageError',
  {
    message: Schema.String,
    pageId: Schema.String,
  },
) {}

const assertAllowedTestParentPage = (pageId: string) =>
  allowedTestParentPageIds.has(pageId.replaceAll('-', '')) === true
    ? Effect.void
    : Effect.fail(
        new DisallowedTestParentPageError({
          pageId,
          message: `Refusing live notion-md cleanup for unallowlisted parent page ${pageId}. Set NOTION_MD_TEST_PARENT_PAGE_ID_ALLOWLIST for a dedicated private test page.`,
        }),
      )

type LiveTestRecord =
  | {
      readonly _tag: 'passed'
      readonly label: string
      readonly durationMs: number
    }
  | {
      readonly _tag: 'failed'
      readonly label: string
      readonly durationMs: number
      readonly message: string
    }

const liveTestRecords: Array<LiveTestRecord> = []

const childPageTitle = (block: Block): string | undefined => {
  if (block.type !== 'child_page') return undefined
  const childPage = block.child_page
  if (typeof childPage !== 'object' || childPage === null || Array.isArray(childPage) === true) {
    return undefined
  }
  const title = (childPage as { readonly title?: unknown }).title
  return typeof title === 'string' ? title : undefined
}

const retrieveTopLevelChildren = (pageId: string) =>
  NotionBlocks.retrieveChildrenStream({ blockId: pageId, pageSize: 100 }).pipe(
    Stream.runCollect,
    Effect.map((chunks) => [...chunks]),
  )

const archiveLeakedScratchPages = (pageId: string) =>
  Effect.gen(function* () {
    yield* assertAllowedTestParentPage(pageId)
    const children = yield* retrieveTopLevelChildren(pageId)
    const leakedScratchPages = children.filter(
      (block) => childPageTitle(block)?.startsWith(scratchTitlePrefix) === true,
    )

    yield* Effect.forEach(
      leakedScratchPages,
      (block) => NotionPages.archive({ pageId: block.id }).pipe(Effect.ignore),
      { concurrency: 1 },
    )

    return leakedScratchPages.length
  })

const findLedgerPage = (pageId: string) =>
  Effect.gen(function* () {
    const children = yield* retrieveTopLevelChildren(pageId)
    return children.find((block) => childPageTitle(block) === ledgerTitle)
  })

const ensureLedgerPage = (pageId: string) =>
  Effect.gen(function* () {
    const existing = yield* findLedgerPage(pageId)
    if (existing !== undefined) return existing.id

    const page = yield* NotionPages.create({
      parent: { type: 'page_id', page_id: pageId },
      properties: {
        title: {
          title: [
            {
              type: 'text',
              text: { content: ledgerTitle },
            },
          ],
        },
      },
      markdown: '# notion-md e2e run ledger\n\nNo runs recorded yet.',
    })

    return page.id
  })

const formatLedgerMarkdown = (opts: {
  readonly startedAt: string
  readonly finishedAt: string
  readonly leakedScratchPagesArchived: number
  readonly records: readonly LiveTestRecord[]
}): string => {
  const failedCount = opts.records.filter((record) => record._tag === 'failed').length
  const status = failedCount === 0 ? 'passed' : 'failed'
  const sha = process.env.GITHUB_SHA ?? process.env.GIT_COMMIT ?? 'local'
  const runId = process.env.GITHUB_RUN_ID ?? 'local'

  const rows = opts.records.map((record) =>
    record._tag === 'failed'
      ? `- failed: ${record.label} (${record.durationMs} ms) - ${record.message.replaceAll('\n', ' ')}`
      : `- passed: ${record.label} (${record.durationMs} ms)`,
  )

  return [
    '# notion-md e2e run ledger',
    '',
    `Latest status: **${status}**`,
    '',
    `- Started: ${opts.startedAt}`,
    `- Finished: ${opts.finishedAt}`,
    `- Git SHA: ${sha}`,
    `- GitHub run: ${runId}`,
    `- Stale scratch pages archived before run: ${opts.leakedScratchPagesArchived}`,
    '',
    '## Tests',
    '',
    ...rows,
  ].join('\n')
}

const publishLedger = (opts: {
  readonly pageId: string
  readonly startedAt: string
  readonly leakedScratchPagesArchived: number
}) =>
  Effect.gen(function* () {
    yield* assertAllowedTestParentPage(opts.pageId)
    const ledgerPageId = yield* ensureLedgerPage(opts.pageId)
    yield* NotionPages.updateMarkdown({
      pageId: ledgerPageId,
      type: 'replace_content',
      new_str: formatLedgerMarkdown({
        startedAt: opts.startedAt,
        finishedAt: new Date().toISOString(),
        leakedScratchPagesArchived: opts.leakedScratchPagesArchived,
        records: liveTestRecords,
      }),
      allow_deleting_content: true,
    })
  })

const liveIt = (label: string, run: () => Promise<void>) =>
  it(label, async () => {
    const startedAtMs = Date.now()
    try {
      await run()
      liveTestRecords.push({
        _tag: 'passed',
        label,
        durationMs: Date.now() - startedAtMs,
      })
    } catch (error) {
      liveTestRecords.push({
        _tag: 'failed',
        label,
        durationMs: Date.now() - startedAtMs,
        message: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  })

const createScratchPage = (label: string) =>
  Effect.gen(function* () {
    const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
    const page = yield* NotionPages.create({
      parent: { type: 'page_id', page_id: testParentPageId ?? '' },
      properties: {
        title: {
          title: [
            {
              type: 'text',
              text: { content: `notion-md e2e: ${label} @ ${stamp}` },
            },
          ],
        },
      },
      markdown: '# Notion MD Live E2E\n\nInitial body',
    })

    return page.id
  })

const archiveScratchPage = (pageId: string) =>
  Effect.andThen(
    NotionPages.update({ pageId, is_locked: false }).pipe(Effect.ignore),
    NotionPages.archive({ pageId }),
  ).pipe(Effect.asVoid, Effect.ignore)

const withScratchPage = async <A>(label: string, body: (pageId: string) => Promise<A>) => {
  const pageId = await runLive(createScratchPage(label))
  try {
    return await body(pageId)
  } finally {
    await runLive(archiveScratchPage(pageId))
  }
}

const withTempDir = async <A>(body: (dir: string) => Promise<A>) => {
  const dir = await mkdtemp(join(tmpdir(), 'notion-md-live-'))
  try {
    return await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe.skipIf(skipLive)('notion-md live integration', () => {
  const ledgerStartedAt = new Date().toISOString()
  let leakedScratchPagesArchived = 0

  beforeAll(async () => {
    leakedScratchPagesArchived = await runLive(archiveLeakedScratchPages(testParentPageId ?? ''))
  })

  afterAll(async () => {
    await runLive(
      publishLedger({
        pageId: testParentPageId ?? '',
        startedAt: ledgerStartedAt,
        leakedScratchPagesArchived,
      }),
    )
  })

  liveIt('pulls, statuses, pushes, and rejects stale overwrites against Notion', async () => {
    await withScratchPage('roundtrip-conflict', async (pageId) => {
      await withTempDir(async (dir) => {
        const path = join(dir, 'page.nmd')

        const pulled = await runLive(pullPage({ pageId, outPath: path }))
        const parsed = await runLive(
          Effect.promise(() => readFile(path, 'utf8')).pipe(
            Effect.flatMap((content) => parseNmdFile({ path, content })),
          ),
        )
        const cleanStatus = await runLive(statusPage({ path }))

        expect(pulled.pageId).toBe(pageId)
        expect(pulled.storage).toBe('self_contained')
        expect(parsed.frontmatter.notion_md.page_id).toBe(pageId)
        expect(parsed.body).toContain('Initial body')
        const sidecarPath = join(dir, '.notion-md', 'sync', `${pageId}.json`)
        const syncState = JSON.parse(await readFile(sidecarPath, 'utf8')) as {
          body: { base: { hash: string } }
        }
        await expect(
          readFile(objectPath({ path, hash: syncState.body.base.hash }), 'utf8'),
        ).resolves.toContain('Initial body')
        expect(cleanStatus.localChanged).toBe(false)
        expect(cleanStatus.remoteChanged).toBe(false)

        const firstContent = await readFile(path, 'utf8')
        await writeFile(path, firstContent.replace('Initial body', 'Local body'))

        const pushed = await runLive(pushPage({ path }))
        const afterPushStatus = await runLive(statusPage({ path }))
        const remoteAfterPush = await runLive(NotionPages.getMarkdown({ pageId }))

        expect(pushed.pushed).toBe(true)
        expect(afterPushStatus.localChanged).toBe(false)
        expect(afterPushStatus.remoteChanged).toBe(false)
        expect(remoteAfterPush.markdown).toContain('Local body')

        const secondContent = await readFile(path, 'utf8')
        await writeFile(path, secondContent.replace('Local body', 'Second local body'))
        await runLive(
          NotionPages.updateMarkdown({
            pageId,
            type: 'replace_content',
            new_str: '# Notion MD Live E2E\n\nRemote body',
            allow_deleting_content: true,
          }),
        )

        await expect(runLive(pushPage({ path }))).rejects.toThrow(
          'Remote page changed since the last clean pull',
        )
        const conflict = await readFile(`${path}.conflict.roughdraft.md`, 'utf8')
        expect(conflict).toContain('## Base body')
        expect(conflict).toContain('Local body')
        expect(conflict).toContain('Remote body')
      })
    })
  })

  liveIt('materializes divider bodies completely or fails closed against Notion', async () => {
    await withScratchPage('divider-completeness', async (pageId) => {
      await runLive(
        NotionPages.updateMarkdown({
          pageId,
          type: 'replace_content',
          new_str: [
            '# Divider completeness',
            '',
            'Before divider',
            '',
            '---',
            '',
            'After divider must not disappear',
            '',
            'Tail marker after divider',
          ].join('\n'),
          allow_deleting_content: true,
        }),
      )

      await withTempDir(async (dir) => {
        const path = join(dir, 'divider.nmd')
        try {
          await runLive(pullPage({ pageId, outPath: path }))
        } catch (error) {
          expect(error).toBeInstanceOf(Error)
          expect((error as Error).message).toContain('Remote Markdown body')
          return
        }

        const parsed = await runLive(
          Effect.promise(() => readFile(path, 'utf8')).pipe(
            Effect.flatMap((content) => parseNmdFile({ path, content })),
          ),
        )
        expect(parsed.body).toContain('After divider must not disappear')
        expect(parsed.body).toContain('Tail marker after divider')
      })
    })
  })

  liveIt(
    'pulls heading paragraph divider pages without promoting paragraphs to headings',
    async () => {
      await withScratchPage('heading-paragraph-divider', async (pageId) => {
        await runLive(
          NotionPages.updateMarkdown({
            pageId,
            type: 'replace_content',
            new_str: [
              '## First section',
              '',
              'This prose paragraph must stay a paragraph.',
              '',
              '---',
              '',
              '## Second section',
              '',
              'Another prose paragraph must stay a paragraph.',
            ].join('\n'),
            allow_deleting_content: true,
          }),
        )

        await withTempDir(async (dir) => {
          const path = join(dir, 'heading-paragraph-divider.nmd')
          await runLive(pullPage({ pageId, outPath: path }))

          const parsed = await runLive(
            Effect.promise(() => readFile(path, 'utf8')).pipe(
              Effect.flatMap((content) => parseNmdFile({ path, content })),
            ),
          )
          const headingLines = parsed.body.split('\n').filter((line) => line.startsWith('## '))

          expect(headingLines).toEqual(['## First section', '## Second section'])
          expect(parsed.body).toContain('\n\nThis prose paragraph must stay a paragraph.\n\n---')
          expect(parsed.body).toContain('\n\nAnother prose paragraph must stay a paragraph.')

          const status = await runLive(statusPage({ path }))
          expect(status.localChanged).toBe(false)
          expect(status.remoteChanged).toBe(false)
        })
      })
    },
  )

  // R38 / #785 (decisions 0016/0017): a not-round-trip-safe body block such as a
  // bookmark renders to Markdown that Notion re-parses as a paragraph on push, so
  // it is refused at the PULL (not preserved and guarded at push, which live
  // testing proved silently corrupts). Refusal names the block class.
  liveIt('refuses a page with a not-round-trip-safe block at pull (R38)', async () => {
    await withScratchPage('not-round-trip-safe-block', async (pageId) => {
      await runLive(
        NotionBlocks.append({
          blockId: pageId,
          children: [
            {
              type: 'bookmark',
              bookmark: { url: 'https://developers.notion.com/' },
            },
          ],
        }),
      )

      await withTempDir(async (dir) => {
        const path = join(dir, 'lossy.nmd')
        await expect(runLive(pullPage({ pageId, outPath: path }))).rejects.toThrow('bookmark')
        // No local base is written, so no later edit can silently destroy the block.
        await expect(readFile(path, 'utf8')).rejects.toThrow()
      })
    })
  })

  liveIt('auto-merges non-overlapping local and remote body edits against Notion', async () => {
    await withScratchPage('auto-merge', async (pageId) => {
      await withTempDir(async (dir) => {
        const path = join(dir, 'merge.nmd')
        await runLive(
          NotionPages.updateMarkdown({
            pageId,
            type: 'replace_content',
            new_str: '- Line A\n- Line B',
            allow_deleting_content: true,
          }),
        )
        await runLive(pullPage({ pageId, outPath: path }))

        const content = await readFile(path, 'utf8')
        await writeFile(path, content.replace('Line A', 'Local line A'))
        await runLive(
          NotionPages.updateMarkdown({
            pageId,
            type: 'replace_content',
            new_str: '- Line A\n- Remote line B',
            allow_deleting_content: true,
          }),
        )

        const pushed = await runLive(pushPage({ path }))
        const remote = await runLive(NotionPages.getMarkdown({ pageId }))
        const refreshed = await runLive(statusPage({ path }))

        expect(pushed.pushed).toBe(true)
        expect(remote.markdown).toContain('Local line A')
        expect(remote.markdown).toContain('Remote line B')
        expect(refreshed.localChanged).toBe(false)
        expect(refreshed.remoteChanged).toBe(false)
      })
    })
  })

  liveIt('sync pulls remote-only edits against Notion', async () => {
    await withScratchPage('sync-remote-only', async (pageId) => {
      await withTempDir(async (dir) => {
        const path = join(dir, 'sync.nmd')
        await runLive(pullPage({ pageId, outPath: path }))
        await runLive(
          NotionPages.updateMarkdown({
            pageId,
            type: 'replace_content',
            new_str: '# Notion MD Live E2E\n\nRemote sync body',
            allow_deleting_content: true,
          }),
        )

        const synced = await runLive(syncPage({ path }))
        const parsed = await runLive(
          Effect.promise(() => readFile(path, 'utf8')).pipe(
            Effect.flatMap((content) => parseNmdFile({ path, content })),
          ),
        )
        const refreshed = await runLive(statusPage({ path }))

        expect(synced._tag).toBe('pulled')
        expect(parsed.body).toContain('Remote sync body')
        expect(refreshed.localChanged).toBe(false)
        expect(refreshed.remoteChanged).toBe(false)
      })
    })
  })

  liveIt(
    'auto-merges non-overlapping local insertions and remote deletions against Notion',
    async () => {
      await withScratchPage('auto-merge-insert-delete', async (pageId) => {
        await withTempDir(async (dir) => {
          const path = join(dir, 'merge-insert-delete.nmd')
          await runLive(
            NotionPages.updateMarkdown({
              pageId,
              type: 'replace_content',
              new_str: 'Keep\nDelete remotely\nTail',
              allow_deleting_content: true,
            }),
          )
          await runLive(pullPage({ pageId, outPath: path }))

          const content = await readFile(path, 'utf8')
          await writeFile(path, content.replace('Keep', 'Local intro\nKeep'))
          await runLive(
            NotionPages.updateMarkdown({
              pageId,
              type: 'replace_content',
              new_str: 'Keep\nTail',
              allow_deleting_content: true,
            }),
          )

          const pushed = await runLive(pushPage({ path }))
          const remote = await runLive(NotionPages.getMarkdown({ pageId }))

          expect(pushed.pushed).toBe(true)
          expect(remote.markdown).toContain('Local intro')
          expect(remote.markdown).toContain('Keep')
          expect(remote.markdown).toContain('Tail')
          expect(remote.markdown).not.toContain('Delete remotely')
        })
      })
    },
  )

  liveIt('pushes explicit title property edits against Notion', async () => {
    await withScratchPage('property-write', async (pageId) => {
      await withTempDir(async (dir) => {
        const path = join(dir, 'property.nmd')
        await runLive(pullPage({ pageId, outPath: path }))
        const parsed = await runLive(
          Effect.promise(() => readFile(path, 'utf8')).pipe(
            Effect.flatMap((content) => parseNmdFile({ path, content })),
          ),
        )
        const nextTitle = `notion-md property updated ${new Date().toISOString()}`
        await writeFile(
          path,
          renderNmdFile({
            frontmatter: {
              notion_md: {
                ...parsed.frontmatter.notion_md,
                properties: {
                  ...parsed.frontmatter.notion_md.properties,
                  title: { _tag: 'title', value: nextTitle },
                },
              },
            },
            body: parsed.body,
          }),
        )

        const pushed = await runLive(pushPage({ path }))
        const refreshed = await runLive(
          Effect.promise(() => readFile(path, 'utf8')).pipe(
            Effect.flatMap((content) => parseNmdFile({ path, content })),
          ),
        )

        expect(pushed.pushed).toBe(true)
        expect(refreshed.frontmatter.notion_md.page.title).toBe(nextTitle)
      })
    })
  })

  liveIt('pushes explicit page lock metadata edits against Notion', async () => {
    await withScratchPage('page-lock', async (pageId) => {
      await withTempDir(async (dir) => {
        const path = join(dir, 'lock.nmd')
        await runLive(pullPage({ pageId, outPath: path }))
        const parsed = await runLive(
          Effect.promise(() => readFile(path, 'utf8')).pipe(
            Effect.flatMap((content) => parseNmdFile({ path, content })),
          ),
        )
        await writeFile(
          path,
          renderNmdFile({
            frontmatter: {
              notion_md: {
                ...parsed.frontmatter.notion_md,
                page: {
                  ...parsed.frontmatter.notion_md.page,
                  is_locked: true,
                },
              },
            },
            body: parsed.body,
          }),
        )

        const pushed = await runLive(pushPage({ path }))
        const refreshed = await runLive(
          Effect.promise(() => readFile(path, 'utf8')).pipe(
            Effect.flatMap((content) => parseNmdFile({ path, content })),
          ),
        )

        expect(pushed.pushed).toBe(true)
        expect(refreshed.frontmatter.notion_md.page.is_locked).toBe(true)
      })
    })
  })
})
