import { Effect, Exit } from 'effect'
import type { HttpClient } from 'effect/unstable/http/HttpClient'
import { Fragment, type ReactNode } from 'react'
import { describe, expect, it } from 'vitest'

import type { NotionConfig } from '@overeng/notion-effect-client'

import { InMemoryCache } from '../cache/in-memory-cache.ts'
import { ColumnList, Paragraph, Toggle } from '../components/blocks.ts'
import { h } from '../components/h.ts'
import { createFakeNotion, type FakeNotion } from '../test/mock-client.ts'
import type { NotionSyncError } from './errors.ts'
import { buildCandidateTree, diff, tallyDiff } from './sync-diff.ts'
import { sync } from './sync.ts'

/**
 * Boundary-condition tests for Notion API limits that the renderer/sync
 * driver has to respect in v0.1. Where the current implementation does NOT
 * yet enforce a given boundary (e.g. the 2000-char rich_text limit, or
 * batching of >100 children per append request), we pin the observed
 * behaviour here so the gap is visible in the test suite. Each such case is
 * flagged with an `XXX` comment referencing #95.
 */
const ROOT = '00000000-0000-4000-8000-0000000000aa'

const runWith = <A,>(
  fake: FakeNotion,
  eff: Effect.Effect<A, NotionSyncError, HttpClient | NotionConfig>,
): Promise<A> => Effect.runPromise(eff.pipe(Effect.provide(fake.layer)))

const runWithExit = <A,>(
  fake: FakeNotion,
  eff: Effect.Effect<A, NotionSyncError, HttpClient | NotionConfig>,
): Promise<Exit.Exit<A, NotionSyncError>> =>
  Effect.runPromiseExit(eff.pipe(Effect.provide(fake.layer)))

describe('pagination + batch boundaries', () => {
  it('rich_text >2000 chars is chunked into ≤2000-char segments (#100)', () => {
    // Notion's API limits each rich_text `text` segment to 2000 chars per
    // entry. The renderer splits longer content into multiple segments that
    // share the annotation/link envelope. See `flattenRichText` tests for
    // annotation preservation across chunks.
    const long = 'a'.repeat(2500)
    const candidate = buildCandidateTree(<Paragraph>{long}</Paragraph>, ROOT)
    expect(candidate.children).toHaveLength(1)
    const rt = candidate.children[0]!.props.rich_text as {
      text: { content: string }
    }[]
    expect(rt).toHaveLength(2)
    expect(rt[0]!.text.content).toHaveLength(2000)
    expect(rt[1]!.text.content).toHaveLength(500)
    expect(rt.map((r) => r.text.content).join('')).toBe(long)
  })

  it('>100 siblings → 2 batched append API calls (100 + 50) (#101)', async () => {
    // Notion caps `append children` at 100 per request. The sync driver
    // coalesces consecutive sibling appends/inserts into ≤100-child
    // batches, so 150 candidate siblings materialize as 2 PATCH calls.
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    const paragraphs: ReactNode[] = []
    for (let i = 0; i < 150; i++) {
      paragraphs.push(
        <Fragment key={i}>{h('paragraph', { blockKey: `p${i}` }, `line ${i}`)}</Fragment>,
      )
    }
    const res = await runWith(fake, sync(<>{paragraphs}</>, { pageId: ROOT, cache }))
    expect(res).toMatchObject({ appends: 150, updates: 0, inserts: 0, removes: 0 })
    const appendReqs = fake.requests.filter(
      (r) => r.method === 'PATCH' && r.path === `/v1/blocks/${ROOT}/children`,
    )
    expect(appendReqs.length).toBe(2)
    const childCounts = appendReqs.map((r) => (r.body as { children: unknown[] }).children.length)
    expect(childCounts).toEqual([100, 50])
    expect(fake.childrenOf(ROOT)).toHaveLength(150)
  })

  it('append-run broken by an update emits 3 API calls (50 append + 1 update + 50 append) (#101)', async () => {
    // Seed the cache with a single retained block sandwiched between
    // new siblings: candidate = [p0..p49, retained, p50..p99]. The
    // retained middle block forces the sync driver to flush the first
    // append run, issue an `update` (as a no-op since hash matches, this
    // is constructed so hashes differ), then flush the second run.
    const fake = createFakeNotion()
    // Pre-populate server state + cache so the middle block is retained
    // but its props change (forcing an update op).
    const seedParent = ROOT
    // Simulate the retained middle block being present server-side and
    // captured in the cache via an initial sync.
    const seedTree = h('paragraph', { blockKey: 'mid' }, 'old')
    await runWith(fake, sync(seedTree, { pageId: seedParent, cache: InMemoryCache.make() }))
    // Build a cache that mirrors the server state after the seed sync.
    const midId = fake.childrenOf(ROOT)[0]!.id
    const seedCache = InMemoryCache.make({
      schemaVersion: 2,
      rootId: ROOT,
      children: [
        {
          key: 'k:mid',
          blockId: midId,
          type: 'paragraph',
          // Intentionally bogus hash to force an update op on re-sync.
          hash: 'stale',
          children: [],
          nodeKind: 'block',
        },
      ],
    })
    // Clear the request log before the measured sync.
    const before = fake.requests.length
    const pre: ReactNode[] = []
    const post: ReactNode[] = []
    for (let i = 0; i < 50; i++) {
      pre.push(<Fragment key={`a${i}`}>{h('paragraph', { blockKey: `a${i}` }, `a${i}`)}</Fragment>)
      post.push(<Fragment key={`b${i}`}>{h('paragraph', { blockKey: `b${i}` }, `b${i}`)}</Fragment>)
    }
    await runWith(
      fake,
      sync(
        <>
          {pre}
          {h('paragraph', { blockKey: 'mid' }, 'new')}
          {post}
        </>,
        { pageId: ROOT, cache: seedCache },
      ),
    )
    const newReqs = fake.requests.slice(before)
    const appendReqs = newReqs.filter(
      (r) => r.method === 'PATCH' && r.path === `/v1/blocks/${ROOT}/children`,
    )
    const updateReqs = newReqs.filter(
      (r) => r.method === 'PATCH' && r.path === `/v1/blocks/${midId}`,
    )
    // The first 50 (a*) are inserts (retained 'mid' follows), the last 50
    // (b*) are appends — two separate runs split by the update of 'mid'.
    expect(appendReqs.length).toBe(2)
    expect(updateReqs.length).toBe(1)
    const childCounts = appendReqs.map((r) => (r.body as { children: unknown[] }).children.length)
    expect(childCounts).toEqual([50, 50])
  })

  it('150 siblings across 3 parents → 3 API calls (50 each) (#101)', () => {
    // Three Toggle parents each containing 50 new paragraph children.
    // Batching must not cross parent boundaries — each Toggle gets its
    // own single append call (50 ≤ 100).
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    const toggles: ReactNode[] = []
    for (let t = 0; t < 3; t++) {
      const kids: ReactNode[] = []
      for (let i = 0; i < 50; i++) {
        kids.push(
          <Fragment key={`t${t}-p${i}`}>
            {h('paragraph', { blockKey: `t${t}-p${i}` }, `x`)}
          </Fragment>,
        )
      }
      toggles.push(
        <Toggle key={`t${t}`} blockKey={`t${t}`} title={`t${t}`}>
          {kids}
        </Toggle>,
      )
    }
    return runWith(fake, sync(<>{toggles}</>, { pageId: ROOT, cache })).then(() => {
      // 1 call appending the 3 Toggle parents to ROOT (batch of 3) +
      // 1 call per Toggle appending its 50 children.
      const rootAppends = fake.requests.filter(
        (r) => r.method === 'PATCH' && r.path === `/v1/blocks/${ROOT}/children`,
      )
      expect(rootAppends.length).toBe(1)
      expect((rootAppends[0]!.body as { children: unknown[] }).children.length).toBe(3)
      // Collect all child-append calls (to the 3 freshly-minted Toggle ids).
      const toggleIds = fake.childrenOf(ROOT).map((b) => b.id)
      expect(toggleIds).toHaveLength(3)
      for (const tid of toggleIds) {
        const reqs = fake.requests.filter(
          (r) => r.method === 'PATCH' && r.path === `/v1/blocks/${tid}/children`,
        )
        expect(reqs.length).toBe(1)
        expect((reqs[0]!.body as { children: unknown[] }).children.length).toBe(50)
      }
    })
  })

  describe('empty containers render cleanly', () => {
    it('empty Toggle projects as a single append with no nested children', () => {
      const candidate = buildCandidateTree(<Toggle title="t" />, ROOT)
      const ops = diff({ schemaVersion: 1, rootId: ROOT, children: [] }, candidate)
      expect(tallyDiff(ops)).toEqual({ appends: 1, updates: 0, inserts: 0, removes: 0 })
      expect(candidate.children[0]!.children).toHaveLength(0)
    })

    it('empty Column inside ColumnList → 2 appends (column_list + column)', () => {
      const candidate = buildCandidateTree(<ColumnList>{h('column', null)}</ColumnList>, ROOT)
      const ops = diff({ schemaVersion: 1, rootId: ROOT, children: [] }, candidate)
      expect(tallyDiff(ops)).toEqual({ appends: 2, updates: 0, inserts: 0, removes: 0 })
    })

    it('empty ColumnList (no columns) → 1 append, no children', () => {
      const candidate = buildCandidateTree(<ColumnList>{null}</ColumnList>, ROOT)
      const ops = diff({ schemaVersion: 1, rootId: ROOT, children: [] }, candidate)
      expect(tallyDiff(ops)).toEqual({ appends: 1, updates: 0, inserts: 0, removes: 0 })
      expect(candidate.children[0]!.children).toHaveLength(0)
    })
  })

  it('mid-batch failure: cache checkpoints successful batches (#102)', async () => {
    // With batched appends (#101), 150 paragraphs emit 2 API calls
    // (100 + 50). When the 2nd batch fails, the 1st batch already landed
    // server-side and the sync driver must have flushed a cache
    // checkpoint after it. A subsequent retry therefore diffs against a
    // cache that already carries the first 100 blocks (by key) and only
    // re-appends the remaining 50.
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    const paragraphs: ReactNode[] = []
    for (let i = 0; i < 150; i++) {
      paragraphs.push(
        <Fragment key={i}>{h('paragraph', { blockKey: `p${i}` }, `line ${i}`)}</Fragment>,
      )
    }
    let batchCount = 0
    fake.failOn((req) => {
      if (req.method === 'PATCH' && req.path === `/v1/blocks/${ROOT}/children`) {
        batchCount += 1
        if (batchCount === 2) return new Error('fake-notion: simulated failure on 2nd batch')
      }
      return undefined
    })

    const exit = await runWithExit(fake, sync(<>{paragraphs}</>, { pageId: ROOT, cache }))
    expect(Exit.isFailure(exit)).toBe(true)
    // Server state: first batch of 100 landed.
    expect(fake.childrenOf(ROOT)).toHaveLength(100)
    // Cache state: reflects the 100 committed blocks.
    const cached = await Effect.runPromise(cache.load)
    expect(cached).toBeDefined()
    expect(cached!.children).toHaveLength(100)
    for (let i = 0; i < 100; i++) {
      expect(cached!.children[i]!.key).toBe(`k:p${i}`)
      expect(cached!.children[i]!.blockId).not.toMatch(/^tmp-/)
    }
  })

  it('idempotent resync: repeating a successful sync is a no-op (#102)', async () => {
    // Sanity check that the checkpointing machinery does not introduce
    // drift on the happy path — two consecutive successful syncs should
    // leave the server with a single copy of every block.
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    const tree = (
      <>
        {h('paragraph', { blockKey: 'a' }, 'A')}
        {h('paragraph', { blockKey: 'b' }, 'B')}
        {h('paragraph', { blockKey: 'c' }, 'C')}
      </>
    )
    const first = await runWith(fake, sync(tree, { pageId: ROOT, cache }))
    expect(first).toMatchObject({ appends: 3 })
    const before = fake.requests.length
    const second = await runWith(fake, sync(tree, { pageId: ROOT, cache }))
    expect(second).toMatchObject({ appends: 0, updates: 0, inserts: 0, removes: 0 })
    const afterReqs = fake.requests.slice(before)
    expect(afterReqs.filter((r) => r.path.includes('/children') && r.method === 'PATCH')).toEqual(
      [],
    )
    expect(fake.childrenOf(ROOT)).toHaveLength(3)
  })

  it('checkpointed retry: second sync only appends the missing tail (#102)', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    const paragraphs: ReactNode[] = []
    for (let i = 0; i < 150; i++) {
      paragraphs.push(
        <Fragment key={i}>{h('paragraph', { blockKey: `p${i}` }, `line ${i}`)}</Fragment>,
      )
    }
    let batchCount = 0
    fake.failOn((req) => {
      if (req.method === 'PATCH' && req.path === `/v1/blocks/${ROOT}/children`) {
        batchCount += 1
        if (batchCount === 2) return new Error('fake-notion: simulated failure on 2nd batch')
      }
      return undefined
    })
    await runWithExit(fake, sync(<>{paragraphs}</>, { pageId: ROOT, cache }))
    expect(fake.childrenOf(ROOT)).toHaveLength(100)

    // Clear the failure hook and retry from the checkpointed cache.
    fake.failOn(() => undefined)
    const before = fake.requests.length
    const res = await runWith(fake, sync(<>{paragraphs}</>, { pageId: ROOT, cache }))
    // Only the remaining 50 should be appended — the first 100 are
    // retained from the checkpointed cache.
    expect(res).toMatchObject({ appends: 50 })
    const retryAppends = fake.requests
      .slice(before)
      .filter((r) => r.method === 'PATCH' && r.path === `/v1/blocks/${ROOT}/children`)
    expect(retryAppends.length).toBe(1)
    expect((retryAppends[0]!.body as { children: unknown[] }).children.length).toBe(50)
    expect(fake.childrenOf(ROOT)).toHaveLength(150)
  })

  // Performance benchmarks need a different harness (timing reliability in
  // CI, warmup, budget thresholds). Deferred per #95; skip for now.
  it.skip('large-page cold sync perf target 2x flush time (#95)', () => {})
})
