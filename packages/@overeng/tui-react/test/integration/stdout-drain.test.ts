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
 * The positive cases run the fixed `writeStdoutSync` path with the reader
 * flowing normally: no sleeps, no slow-reader pipeline, the parent drains as
 * fast as it can, and the payload must still arrive whole.
 *
 * The negative control runs the unfixed `process.stdout.write` path without
 * relying on a fixed payload being larger than a particular runtime's buffers
 * (the per-runtime table in `src/effect/stdout.node.ts` is a snapshot of
 * measurements, not a guarantee). The parent pauses `child.stdout`, while the
 * child performs a bounded series of writes until `process.stdout.write`
 * itself reports backpressure, then synchronously queues one additional
 * chunk. The total attempted byte count and the count at the first
 * backpressure signal travel over the independently drained stderr control
 * channel. The test proves the extra tail was attempted before comparing the
 * total with exactly what survived on stdout. There are no sleeps or timing
 * assumptions, and the bound prevents a non-conforming runtime from hanging.
 */

import { spawn } from 'node:child_process'
import path from 'node:path'

import { describe, expect, test } from 'vitest'

const FIXTURE = path.resolve(__dirname, 'fixtures', 'stdout-drain-cli.ts')

const PAYLOAD_BYTES = 1_000_000
const CONTROL_CHUNK_BYTES = 64 * 1024

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
  readonly controlText: string
  readonly exitCode: number | null
}

/**
 * Run the fixture and count the bytes that survive to stdout. With
 * `pauseReaderUntilExit`, stdout remains unread until the process is gone;
 * stderr remains flowing as the fixture's independent control channel.
 */
const runFixture = ({
  runtime,
  strategy,
  pauseReaderUntilExit = false,
}: {
  runtime: string
  strategy: 'sync' | 'stream'
  pauseReaderUntilExit?: boolean
}): Promise<FixtureRun> =>
  new Promise<FixtureRun>((resolve, reject) => {
    const child = spawn(runtime, [FIXTURE], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DRAIN_BYTES: String(PAYLOAD_BYTES),
        DRAIN_STRATEGY: strategy,
      },
    })

    let byteLength = 0
    let controlText = ''
    let exitCode: number | null = null
    let stdoutEnded = false
    let stderrEnded = false
    let exited = false

    const settle = (): void => {
      if (stdoutEnded === true && stderrEnded === true && exited === true)
        resolve({ byteLength, controlText, exitCode })
    }

    child.on('error', reject)

    child.stdout.on('data', (chunk: Buffer) => {
      byteLength += chunk.length
    })
    child.stdout.on('end', () => {
      stdoutEnded = true
      settle()
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      controlText += chunk
    })
    child.stderr.on('end', () => {
      stderrEnded = true
      settle()
    })

    if (pauseReaderUntilExit === true) child.stdout.pause()

    child.on('exit', (code) => {
      exitCode = code
      exited = true
      if (pauseReaderUntilExit === true) child.stdout.resume()
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
      const { byteLength, controlText, exitCode } = await runFixture({
        runtime: bin,
        strategy: 'stream',
        pauseReaderUntilExit: true,
      })

      // Decimal counts mean the stream itself reported backpressure; the
      // bounded fixture emits a diagnostic marker instead if it never did.
      expect(controlText).toMatch(/^\d+:\d+$/)
      const [attemptedText, backpressuredAtText] = controlText.split(':')
      const attemptedByteLength = Number(attemptedText)
      const backpressuredAtByteLength = Number(backpressuredAtText)

      // The attempted total must include exactly the one chunk synchronously
      // queued after the first backpressure signal.
      expect(attemptedByteLength - backpressuredAtByteLength).toBe(CONTROL_CHUNK_BYTES)

      // That proven queued tail must be lost, or the positive case would pass
      // for free under the same collector.
      expect(byteLength).toBeLessThan(attemptedByteLength)
      expect(byteLength).toBeGreaterThan(0)
      expect(exitCode).toBe(1)
    })
  }
})
