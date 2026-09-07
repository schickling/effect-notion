/**
 * Fixture for `stdout-drain.test.ts`.
 *
 * Writes `DRAIN_BYTES` bytes to stdout and then exits non-zero — the exact
 * shape that truncated real CLI output (`--output json` on a failing command
 * piped into a slower consumer).
 *
 * `DRAIN_STRATEGY=stream` selects the old, unfixed `process.stdout.write` path
 * and keeps it exercisable as a control. It writes fixed-size chunks in the
 * same turn until the stream reports backpressure, then queues one more chunk
 * behind that in-flight write before exiting. The total attempted byte count
 * and the count at the first backpressure signal are reported synchronously on
 * stderr, an independently drained control channel, so the parent can prove
 * that the extra tail was attempted and compare the total with surviving
 * stdout.
 */
import { writeSync } from 'node:fs'

import { writeStdoutSync } from '../../../src/effect/stdout.node.ts'

const bytes = Number(process.env.DRAIN_BYTES ?? '1000000')

// Touch `process.stdout` the way TTY probing and rendering do. This is what
// puts fd 1 into non-blocking mode, which is why the writer has to handle
// short writes and EAGAIN rather than trusting a single `writeSync`.
void process.stdout.isTTY

if (process.env.DRAIN_STRATEGY === 'stream') {
  const chunk = 'x'.repeat(64 * 1024)
  const maxWrites = 1024
  let attemptedByteLength = 0
  let backpressuredAtByteLength: number | undefined

  for (let write = 0; write < maxWrites; write++) {
    attemptedByteLength += chunk.length
    if (process.stdout.write(chunk) === false) {
      backpressuredAtByteLength = attemptedByteLength
      break
    }
  }

  if (backpressuredAtByteLength === undefined) {
    writeSync(2, `no-backpressure:${attemptedByteLength}`)
  } else {
    attemptedByteLength += chunk.length
    process.stdout.write(chunk)
    writeSync(2, `${attemptedByteLength}:${backpressuredAtByteLength}`)
  }
} else {
  writeStdoutSync(`${'x'.repeat(bytes - 1)}\n`)
}

process.exit(1)
