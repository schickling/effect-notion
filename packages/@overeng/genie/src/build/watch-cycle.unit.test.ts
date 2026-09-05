import { spawnSync } from 'node:child_process'
import * as fsSync from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const probePath = new URL('./watch-cycle.probe.ts', import.meta.url).pathname

/** Reads one Buck-declared immutable tool path; nothing resolves through an ambient PATH. */
const requireTool = (name: string): string => {
  const tool = process.env[name]
  if (tool === undefined || tool === '')
    throw new Error(`declared test tool is unavailable: ${name}`)
  return tool
}

const bunBin = requireTool('BUN_BIN')

interface ParsedAction {
  readonly _tag: string
  readonly path?: string
  readonly status?: string
}

const parseProbeOutput = (stdout: string) => {
  const lines = stdout
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
  const summaryLine = lines.find((line) => line.startsWith('SUMMARY '))
  expect(summaryLine).toBeDefined()
  const [created, updated, unchanged, skipped, failed] = (summaryLine ?? '')
    .slice('SUMMARY '.length)
    .split(' ')
    .map((value) => Number(value))
  const summary = { created, updated, unchanged, skipped, failed }

  const actions: Array<ParsedAction> = []
  for (const line of lines.filter((line) => line.startsWith('ACTION '))) {
    const rest = line.slice('ACTION '.length)
    const tag = rest.split(' ')[0] ?? ''
    const pathMatch = / path=(\S+)/.exec(rest)
    const statusMatch = / status=(\S+)/.exec(rest)
    actions.push({
      _tag: tag,
      ...(pathMatch === null ? {} : { path: pathMatch[1] }),
      ...(statusMatch === null ? {} : { status: statusMatch[1] }),
    })
  }
  return { summary, actions }
}

describe('genie watch cycle', () => {
  it('regenerates a coalesced batch in one pass and marks untouched files unchanged', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-watch-cycle-'))
    try {
      // Only the nested file changes — the previous non-recursive watcher never
      // fired for nested *.genie.ts edits; recursive scope + coalescing delivers
      // them as one batched pass.
      fsSync.mkdirSync(join(root, 'members'), { recursive: true })

      const probe = spawnSync(bunBin, [probePath, root], { encoding: 'utf8' })
      expect(probe.status).toBe(0)

      const changed = join(root, 'members', 'package.json.genie.ts')
      const { summary, actions } = parseProbeOutput(probe.stdout)

      console.log('PARSED', JSON.stringify({ summary, actions }))
      // One burst → one TUI cycle over both discovered files.
      expect(summary).toEqual({
        created: 1,
        updated: 0,
        unchanged: 1,
        skipped: 0,
        failed: 0,
      })
      expect(actions.filter((action) => action._tag === 'WatchReset')).toHaveLength(1)
      expect(actions.filter((action) => action._tag === 'FilesDiscovered')).toHaveLength(1)
      expect(actions.filter((action) => action._tag === 'Complete')).toHaveLength(1)
      expect(
        actions.some((action) => action._tag === 'FileStarted' && action.path === changed),
      ).toBe(true)

      // The nested file was actually regenerated.
      expect(fsSync.existsSync(join(root, 'members', 'package.json'))).toBe(true)

      // The untouched discovered file is reported unchanged exactly once.
      const unchangedActions = actions.filter(
        (action) => action._tag === 'FileCompleted' && action.status === 'unchanged',
      )
      expect(unchangedActions.map((action) => action.path)).toEqual([
        join(root, 'package.json.genie.ts'),
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
