import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/** Reads one Buck-declared immutable tool path; nothing resolves through an ambient PATH. */
const requireTool = (name: string): string => {
  const tool = process.env[name]
  if (tool === undefined || tool === '')
    throw new Error(`declared test tool is unavailable: ${name}`)
  return tool
}

const bunBin = requireTool('BUN_BIN')

/**
 * Regression test for #787.
 *
 * The umbrella `notion` binary runs on Bun and imports its three command trees
 * concurrently. A renderer `app.ts` calling `createTuiApp(...)` as a module-load
 * side-effect crashed with a TDZ error under Bun's concurrent module evaluation.
 *
 * This test spawns the fixture with Bun — the binary's real runtime — because the
 * crash is specific to Bun's async-evaluation interleaving and does not reproduce
 * under vitest's Node runner.
 */
describe('concurrent command-tree import (#787)', () => {
  it('loads all three trees concurrently under Bun without a TDZ crash', () => {
    const fixture = fileURLToPath(new URL('./concurrent-import.fixture.ts', import.meta.url))

    const proc = spawnSync(bunBin, ['run', fixture], {
      encoding: 'utf8',
      timeout: 25_000,
    })

    const stdout = proc.stdout ?? ''
    const stderr = proc.stderr ?? ''

    expect(proc.error, `${stderr}\n${String(proc.error)}`).toBeUndefined()
    expect(stderr, stderr).not.toContain('before initialization')
    expect(stdout).toContain('CONCURRENT_IMPORT_OK')
    expect(proc.status).toBe(0)
  }, 30_000)
})
