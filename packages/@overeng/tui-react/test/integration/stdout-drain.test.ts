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
 * The negative control runs the unfixed `process.stdout.write` path and makes
 * the loss deterministic from the *reader* side instead of depending on how a
 * given runtime version happens to queue stdout (the per-runtime table in
 * `src/effect/stdout.node.ts` is a snapshot of measurements, not a guarantee;
 * a control that relies on it can quietly stop controlling anything). The
 * parent pauses `child.stdout` immediately after spawn, so the kernel pipe
 * buffer fills, the rest of the payload sits in the child's stream queue, and
 * `process.exit(1)` discards it. Whatever the child managed to push into the
 * pipe is still buffered by the kernel and is counted after the reader
 * resumes.
 *
 * The pause is released on the child's `exit` event, not `close`: `exit` means
 * the process is gone and is independent of the reader, whereas `close` is
 * documented to also wait for the child's stdio streams to close — i.e. on the
 * very reader this test deliberately blocked. Resuming from `close` would make
 * the resume depend on the backpressure it is supposed to release. Exit and
 * stdout end are therefore tracked separately and the run settles when both
 * have happened; no timers are involved.
 *
 * Only the stream control is paused. Pausing the sync path would be a
 * different test: `writeStdoutSync` correctly blocks and retries on EAGAIN, so
 * it would spin against a reader that never reads.
 */

import { spawn } from 'node:child_process'
import path from 'node:path'

import { describe, expect, test } from 'vitest'

const FIXTURE = path.resolve(__dirname, 'fixtures', 'stdout-drain-cli.ts')

const PAYLOAD_BYTES = 1_000_000

/** Runtimes the package must stay correct on. */
const RUNTIMES = ['bun', 'node'] as const

interface FixtureRun {
  readonly byteLength: number
  readonly exitCode: number | null
}

/**
 * Run the fixture and count the bytes that actually survive to the pipe's read
 * end, resolving only once stdout has ended *and* the child has exited.
 *
 * With `pauseReaderUntilExit` the pipe is left unread until the child is gone,
 * which is the backpressure the buffered control needs.
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

    // Counting handlers are attached before any pause/resume so nothing that
    // reaches the read end can be missed.
    child.stdout.on('data', (chunk: Buffer) => {
      byteLength += chunk.length
    })
    child.stdout.on('end', () => {
      stdoutEnded = true
      settle()
    })

    // Stop reading right away: the kernel pipe buffer is the only place the
    // child's bytes can go, and once it is full the remainder is stuck in the
    // child's own stream queue where `process.exit(1)` will drop it.
    if (pauseReaderUntilExit === true) child.stdout.pause()

    child.on('exit', (code) => {
      exitCode = code
      exited = true
      // Resume on `exit`, not `close`: `close` also waits for the stdio
      // streams, which is exactly what the pause is holding up. The child is
      // already gone here, so everything read from now on is precisely what
      // survived the exit.
      if (pauseReaderUntilExit === true) child.stdout.resume()
      settle()
    })
  })

describe('stdout data channel survives a non-zero exit', () => {
  for (const runtime of RUNTIMES) {
    test(`${runtime}: the whole payload reaches the reader`, async () => {
      const { byteLength, exitCode } = await runFixture({ runtime, strategy: 'sync' })

      // The point of the fix: `process.exit(1)` drops nothing.
      expect(byteLength).toBe(PAYLOAD_BYTES)
      // And the failure exit code that triggers the truncation is intact.
      expect(exitCode).toBe(1)
    })

    test(`${runtime}: buffered control truncates, proving the test can fail`, async () => {
      const { byteLength, exitCode } = await runFixture({
        runtime,
        strategy: 'stream',
        pauseReaderUntilExit: true,
      })

      // Guards the assertion above: with the pipe backed up, the unfixed path
      // must lose the queued tail. If it ever delivered all PAYLOAD_BYTES the
      // measurement would be meaningless and the positive case would pass for
      // free, so this fails loudly instead.
      expect(byteLength).toBeLessThan(PAYLOAD_BYTES)
      // Some bytes must still make it, otherwise we are measuring a crash
      // rather than a truncation.
      expect(byteLength).toBeGreaterThan(0)
      expect(exitCode).toBe(1)
    })
  }
})
