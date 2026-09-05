/**
 * Subprocess regression test for the stdout data-channel flush contract.
 *
 * A CLI that writes a large result and then exits non-zero must not lose
 * bytes. This only reproduces across a real process boundary: it needs a real
 * pipe with a real ~64 KiB kernel buffer and a real `process.exit(1)`, which
 * abandons whatever is still queued behind `process.stdout`.
 *
 * Observed before the fix: a 949834-byte JSON payload piped into `cat > file`
 * arrived as 393216 bytes and `jq` failed with `unterminated string`.
 *
 * No sleeps or slow-reader tricks are needed — the parent drains as fast as it
 * can and the buffered path still truncates, because the child's `process.exit`
 * runs in the same tick as the write. Both runtimes are covered since they
 * truncate under different strategies (see the table in
 * `src/effect/stdout.node.ts`).
 */

import { spawn } from 'node:child_process'
import path from 'node:path'

import { describe, expect, test } from 'vitest'

const FIXTURE = path.resolve(__dirname, 'fixtures', 'stdout-drain-cli.ts')

const PAYLOAD_BYTES = 1_000_000

/** Reads one Buck-declared immutable tool path; nothing resolves through an ambient PATH. */
const requireTool = (name: string): string => {
  const tool = process.env[name]
  if (tool === undefined || tool === '')
    throw new Error(`declared test tool is unavailable: ${name}`)
  return tool
}

/** Runtimes the package must stay correct on, resolved from declared tools. */
const RUNTIMES = [
  { label: 'bun', bin: requireTool('BUN_BIN') },
  { label: 'node', bin: requireTool('NODE_BIN') },
] as const

interface FixtureRun {
  readonly byteLength: number
  readonly exitCode: number | null
}

/**
 * Run the fixture and count the bytes that actually survive to the pipe's read
 * end, resolving only once stdout has ended *and* the child has exited.
 */
const runFixture = ({
  runtime,
  strategy,
}: {
  runtime: string
  strategy: 'sync' | 'stream'
}): Promise<FixtureRun> =>
  new Promise<FixtureRun>((resolve, reject) => {
    const child = spawn(runtime, [FIXTURE], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: {
        ...process.env,
        DRAIN_BYTES: String(PAYLOAD_BYTES),
        DRAIN_STRATEGY: strategy,
      },
    })

    let byteLength = 0
    let exitCode: number | null = null
    let stdoutEnded = false
    let exited = false

    const settle = (): void => {
      if (stdoutEnded === true && exited === true) resolve({ byteLength, exitCode })
    }

    child.on('error', reject)
    child.stdout.on('data', (chunk: Buffer) => {
      byteLength += chunk.length
    })
    child.stdout.on('end', () => {
      stdoutEnded = true
      settle()
    })
    child.on('close', (code) => {
      exitCode = code
      exited = true
      settle()
    })
  })

describe('stdout data channel survives a non-zero exit', () => {
  for (const { label, bin } of RUNTIMES) {
    test(`${label}: the whole payload reaches the reader`, async () => {
      const { byteLength, exitCode } = await runFixture({ runtime: bin, strategy: 'sync' })

      // The point of the fix: `process.exit(1)` drops nothing.
      expect(byteLength).toBe(PAYLOAD_BYTES)
      // And the failure exit code that triggers the truncation is intact.
      expect(exitCode).toBe(1)
    })

    test(`${label}: buffered control truncates, proving the test can fail`, async () => {
      const { byteLength } = await runFixture({ runtime: bin, strategy: 'stream' })

      // Guards the assertions above: if `process.stdout.write` + `process.exit`
      // ever delivered everything, they would pass for free and protect nothing.
      expect(byteLength).toBeLessThan(PAYLOAD_BYTES)
    })
  }
})
