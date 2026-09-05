import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { NodeServices } from '@effect/platform-node'
import type { NodeServices as NodeServicesEnv } from '@effect/platform-node/NodeServices'
import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'

import { type NmdSyncStateV1 } from '@overeng/notion-effect-client'

import { normalizeMarkdownLineEndings, sha256Digest } from './hash.ts'
import {
  NmdStateStoreLive,
  objectPath,
  writeBaseSnapshot,
  writeSyncState,
  type NmdStateStore,
} from './state-store.ts'

/*
 * CLI boundary tests for the decided v-next surface: three verbs `track` /
 * `status` / `sync` over self-describing files. These were revised from the
 * pre-redesign surface (`plan`, `--from-remote`, `--root`, `--root-file`,
 * two-arg `sync`) which the v-next redesign explicitly DROPS — direction lives
 * in each file's frontmatter `source`, not in flags (R34). The old assertions
 * encoded the superseded engine and would contradict the decided spec.
 */

const execFileAsync = promisify(execFile)
const packageDir = fileURLToPath(new URL('..', import.meta.url))
const cliProcessTimeoutMs = 20_000
const cliTestTimeoutMs = 25_000

/** Reads one Buck-declared immutable tool path; nothing resolves through an ambient PATH. */
const requireTool = (name: string): string => {
  const tool = process.env[name]
  if (tool === undefined || tool === '')
    throw new Error(`declared test tool is unavailable: ${name}`)
  return tool
}

const bunBin = requireTool('BUN_BIN')

const runCli = (args: readonly string[]) =>
  execFileAsync(bunBin, ['src/cli.ts', ...args], {
    cwd: packageDir,
    timeout: cliProcessTimeoutMs,
    env: {
      ...process.env,
      NOTION_API_TOKEN: '',
      OTEL_EXPORTER_OTLP_ENDPOINT: '',
    },
  })

const stateStoreLayer = NmdStateStoreLive.pipe(Layer.provide(NodeServices.layer))

const runStore = <A, E>(effect: Effect.Effect<A, E, NmdStateStore | NodeServicesEnv>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(Effect.provide(Layer.mergeAll(stateStoreLayer, NodeServices.layer))),
  )

const syncStateFor = (opts: {
  readonly pageId: string
  readonly body: string
  readonly base: NmdSyncStateV1['body']['base']
}): NmdSyncStateV1 => ({
  version: 1,
  page_id: opts.pageId,
  body: {
    format: 'notion-enhanced-markdown',
    hash: sha256Digest(normalizeMarkdownLineEndings(opts.body)),
    base: opts.base,
    last_pulled_at: '2026-05-22T12:00:00.000Z',
    remote_last_edited_time: '2026-05-22T12:00:00.000Z',
    truncated: false,
    unknown_block_ids: [],
  },
  storage: { _tag: 'self_contained', unsupported_blocks: [], files: [], comments: [] },
  read_only_properties: {},
  data_source: null,
})

describe('notion-md CLI boundary', () => {
  const withTempDir = async <T>(callback: (dir: string) => Promise<T>): Promise<T> => {
    const dir = mkdtempSync(join(tmpdir(), 'notion-md-cli-'))
    try {
      return await callback(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it(
    'renders top-level help with the three decided verbs',
    async () => {
      const { stdout } = await runCli(['--help'])

      expect(stdout).toContain('track')
      expect(stdout).toContain('status')
      expect(stdout).toContain('sync')
    },
    cliTestTimeoutMs,
  )

  it(
    'no longer exposes the dropped tree/direction flags or the plan verb',
    async () => {
      const { stdout } = await runCli(['--help'])

      expect(stdout).not.toContain('--from-remote')
      expect(stdout).not.toContain('--root')
      expect(stdout).not.toContain('--root-file')
      expect(stdout).not.toContain('clone')
      expect(stdout).not.toContain('plan')
    },
    cliTestTimeoutMs,
  )

  it(
    'renders sync help without requiring a Notion token',
    async () => {
      const { stdout } = await runCli(['sync', '--help'])

      expect(stdout).toContain('--watch')
      expect(stdout).toContain('--poll-interval-ms')
      expect(stdout).toContain('--recursive')
      expect(stdout).toContain('--concurrency')
      expect(stdout).toContain('--force')
      expect(stdout).toContain('--dry-run')
    },
    cliTestTimeoutMs,
  )

  it(
    'renders track help with --as direction option',
    async () => {
      const { stdout } = await runCli(['track', '--help'])

      expect(stdout).toContain('--as')
      expect(stdout).toContain('--dry-run')
      expect(stdout).toContain('page-id-or-url')
    },
    cliTestTimeoutMs,
  )

  it(
    'validates missing sync targets before resolving Notion credentials',
    async () => {
      await expect(runCli(['sync'])).rejects.toThrow('Expected: at least 1 value')
    },
    cliTestTimeoutMs,
  )

  it(
    'validates watch polling interval before resolving Notion credentials',
    async () => {
      await expect(
        runCli(['sync', 'page.nmd', '--watch', '--poll-interval-ms', '0']),
      ).rejects.toThrow('Expected a value greater than 0')
    },
    cliTestTimeoutMs,
  )

  it(
    'rejects directory tree watch instead of entering one-file watch mode',
    async () => {
      await withTempDir(async (dir) => {
        await expect(runCli(['sync', dir, '--watch'])).rejects.toMatchObject({
          stdout: expect.stringContaining('Directory tree watch is not supported'),
        })
      })
    },
    cliTestTimeoutMs,
  )

  it(
    'rejects a non-page-id track argument before resolving Notion credentials',
    async () => {
      await withTempDir(async (dir) => {
        const filePath = join(dir, 'page.nmd')
        writeFileSync(filePath, '')

        await expect(runCli(['track', filePath])).rejects.toMatchObject({
          stdout: expect.stringContaining('Invalid Notion page id/url'),
        })
      })
    },
    cliTestTimeoutMs,
  )

  it(
    'surfaces missing Notion credentials as a typed CLI failure after argument validation',
    async () => {
      await expect(runCli(['status', 'page.nmd'])).rejects.toMatchObject({
        stdout: expect.stringContaining('NmdTokenMissingError'),
      })
      await expect(runCli(['status', 'page.nmd'])).rejects.toMatchObject({
        stdout: expect.stringContaining('NOTION_API_TOKEN is required'),
      })
    },
    cliTestTimeoutMs,
  )

  it(
    'renders gc help with --prune option (no Notion token required)',
    async () => {
      const { stdout } = await runCli(['gc', '--help'])

      expect(stdout).toContain('--prune')
      expect(stdout).toContain('--recursive')
      expect(stdout).toContain('path')
    },
    cliTestTimeoutMs,
  )

  it(
    'gc is registered in top-level help',
    async () => {
      const { stdout } = await runCli(['--help'])

      expect(stdout).toContain('gc')
    },
    cliTestTimeoutMs,
  )

  it(
    'gc validates missing targets without requiring a Notion token',
    async () => {
      await expect(runCli(['gc'])).rejects.toThrow('Expected: at least 1 value')
    },
    cliTestTimeoutMs,
  )

  it(
    'gc (no --prune) reports the removal plan and deletes nothing',
    async () => {
      await withTempDir(async (dir) => {
        const nmdPath = join(dir, 'doc.nmd')
        writeFileSync(nmdPath, '')
        const pageId = '00000000-0000-4000-8000-000000000010'

        // Set up fixtures: base snapshot + sync state + orphan object
        const base = await runStore(writeBaseSnapshot({ path: nmdPath, pageId, body: '# Hello' }))
        const syncState = syncStateFor({ pageId, body: '# Hello', base })
        await runStore(writeSyncState({ path: nmdPath, syncState }))

        // Add an orphan object that has no sync-state reference
        const orphanContent = '{"orphan":true}\n'
        const orphanHash = sha256Digest(orphanContent)
        const orphanPath = objectPath({ path: nmdPath, hash: orphanHash })
        mkdirSync(dirname(orphanPath), { recursive: true })
        writeFileSync(orphanPath, orphanContent)

        // gc without --prune: plan-only
        const { stdout } = await runCli(['gc', nmdPath])

        // Orphan reported in plan output
        expect(stdout).toContain(orphanPath)
        // Plan-only marker in output
        expect(stdout).toContain('plan only')

        // Orphan must still exist on disk — nothing deleted
        expect(existsSync(orphanPath)).toBe(true)
        // Base snapshot must still exist too
        expect(existsSync(objectPath({ path: nmdPath, hash: base.hash }))).toBe(true)
      })
    },
    cliTestTimeoutMs,
  )

  it(
    'gc --prune removes unreachable objects and keeps reachable base snapshots',
    async () => {
      await withTempDir(async (dir) => {
        const nmdPath = join(dir, 'doc.nmd')
        writeFileSync(nmdPath, '')
        const pageId = '00000000-0000-4000-8000-000000000011'

        // Set up fixtures: base snapshot + sync state + orphan object
        const base = await runStore(writeBaseSnapshot({ path: nmdPath, pageId, body: '# World' }))
        const syncState = syncStateFor({ pageId, body: '# World', base })
        await runStore(writeSyncState({ path: nmdPath, syncState }))

        // Add an orphan object
        const orphanContent = '{"orphan":true}\n'
        const orphanHash = sha256Digest(orphanContent)
        const orphanPath = objectPath({ path: nmdPath, hash: orphanHash })
        mkdirSync(dirname(orphanPath), { recursive: true })
        writeFileSync(orphanPath, orphanContent)

        // gc with --prune: actually deletes orphans
        const { stdout } = await runCli(['gc', nmdPath, '--prune'])

        // Output confirms pruning occurred (not plan-only)
        expect(stdout).toContain('objects pruned')
        // The removed path must be listed so a prune-without-reporting regression is caught
        expect(stdout).toContain(orphanPath)

        // Orphan must be gone
        expect(existsSync(orphanPath)).toBe(false)
        // Base snapshot must still exist
        expect(existsSync(objectPath({ path: nmdPath, hash: base.hash }))).toBe(true)
      })
    },
    cliTestTimeoutMs,
  )

  it(
    'gc --prune across two pages in one dir keeps both base snapshots and deletes only the orphan',
    async () => {
      await withTempDir(async (dir) => {
        // Two .nmd files sharing one .notion-md object store (same dir → same root)
        const nmdPathA = join(dir, 'alpha.nmd')
        const nmdPathB = join(dir, 'beta.nmd')
        writeFileSync(nmdPathA, '')
        writeFileSync(nmdPathB, '')
        const pageIdA = '00000000-0000-4000-8000-000000000020'
        const pageIdB = '00000000-0000-4000-8000-000000000021'

        // Distinct bodies → distinct base object files, so both must survive independently
        const baseA = await runStore(
          writeBaseSnapshot({ path: nmdPathA, pageId: pageIdA, body: '# Alpha body' }),
        )
        const baseB = await runStore(
          writeBaseSnapshot({ path: nmdPathB, pageId: pageIdB, body: '# Beta body' }),
        )
        expect(baseA.hash).not.toBe(baseB.hash)

        await runStore(
          writeSyncState({
            path: nmdPathA,
            syncState: syncStateFor({ pageId: pageIdA, body: '# Alpha body', base: baseA }),
          }),
        )
        await runStore(
          writeSyncState({
            path: nmdPathB,
            syncState: syncStateFor({ pageId: pageIdB, body: '# Beta body', base: baseB }),
          }),
        )

        // One orphan object reachable from neither sync state
        const orphanContent = '{"orphan":true}\n'
        const orphanHash = sha256Digest(orphanContent)
        const orphanPath = objectPath({ path: nmdPathA, hash: orphanHash })
        mkdirSync(dirname(orphanPath), { recursive: true })
        writeFileSync(orphanPath, orphanContent)

        // Pass both files; gc must group them under one root and read both sync
        // states for reachability, so neither sibling base is misclassified.
        const { stdout } = await runCli(['gc', nmdPathA, nmdPathB, '--prune'])

        expect(stdout).toContain('objects pruned')
        expect(stdout).toContain(orphanPath)

        // Only the orphan is gone; both base snapshots survive
        expect(existsSync(orphanPath)).toBe(false)
        expect(existsSync(objectPath({ path: nmdPathA, hash: baseA.hash }))).toBe(true)
        expect(existsSync(objectPath({ path: nmdPathB, hash: baseB.hash }))).toBe(true)
      })
    },
    cliTestTimeoutMs,
  )

  it(
    'gc fails fast and names the bad path when every target resolves to an error',
    async () => {
      await withTempDir(async (dir) => {
        // A non-.nmd file resolves to a target-resolution error, not a .nmd path
        const badPath = join(dir, 'not-a-nmd-file.txt')
        writeFileSync(badPath, 'plain text')

        // Plant an orphan object next to it; a silent no-op would be especially
        // dangerous, so prove gc neither deletes nor silently succeeds.
        const orphanContent = '{"orphan":true}\n'
        const orphanHash = sha256Digest(orphanContent)
        const orphanPath = objectPath({ path: join(dir, 'doc.nmd'), hash: orphanHash })
        mkdirSync(dirname(orphanPath), { recursive: true })
        writeFileSync(orphanPath, orphanContent)

        // gc must reject (non-zero exit) and name the offending path in stdout
        await expect(runCli(['gc', badPath, '--prune'])).rejects.toMatchObject({
          stdout: expect.stringContaining(badPath),
        })

        // Nothing was deleted on the silent-no-op path
        expect(existsSync(orphanPath)).toBe(true)
      })
    },
    cliTestTimeoutMs,
  )

  it(
    'gc --prune proceeds on a valid target while logging a sibling bad path',
    async () => {
      await withTempDir(async (dir) => {
        // One valid .nmd with its own sync state + orphan, plus one bad target.
        const nmdPath = join(dir, 'doc.nmd')
        writeFileSync(nmdPath, '')
        const pageId = '00000000-0000-4000-8000-000000000030'
        const base = await runStore(writeBaseSnapshot({ path: nmdPath, pageId, body: '# Partial' }))
        await runStore(
          writeSyncState({
            path: nmdPath,
            syncState: syncStateFor({ pageId, body: '# Partial', base }),
          }),
        )

        const orphanContent = '{"orphan":true}\n'
        const orphanHash = sha256Digest(orphanContent)
        const orphanPath = objectPath({ path: nmdPath, hash: orphanHash })
        mkdirSync(dirname(orphanPath), { recursive: true })
        writeFileSync(orphanPath, orphanContent)

        const badPath = join(dir, 'not-a-nmd-file.txt')
        writeFileSync(badPath, 'plain text')

        // Partial resolution: the bad path is logged (stderr) but gc proceeds on
        // the valid target and prunes its orphan. This must NOT fail fast.
        const { stdout, stderr } = await runCli(['gc', nmdPath, badPath, '--prune'])

        // The bad path is surfaced, not silently dropped
        expect(stderr).toContain(badPath)
        // The valid target was processed and its orphan pruned
        expect(stdout).toContain('objects pruned')
        expect(stdout).toContain(orphanPath)
        expect(existsSync(orphanPath)).toBe(false)
        // The valid target's base snapshot survives
        expect(existsSync(objectPath({ path: nmdPath, hash: base.hash }))).toBe(true)
      })
    },
    cliTestTimeoutMs,
  )
})
