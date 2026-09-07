/**
 * Fixture for `stdout-drain.test.ts`.
 *
 * Writes `DRAIN_BYTES` bytes to stdout and then exits non-zero — the exact
 * shape that truncated real CLI output (`--output json` on a failing command
 * piped into a slower consumer).
 *
 * `DRAIN_STRATEGY=stream` selects the old, unfixed `process.stdout.write` path
 * and keeps it exercisable as a control: the write is queued behind the stream
 * and `process.exit(1)` runs in the same tick, so whatever the kernel pipe
 * could not take is thrown away. Whether that loses bytes depends on the
 * reader — the parent supplies the backpressure (see `pauseReaderUntilExit` in
 * the test), so this fixture only has to pick the path, never fake a loss.
 */

import { writeStdoutSync } from '../../../src/effect/stdout.node.ts'

const bytes = Number(process.env.DRAIN_BYTES ?? '1000000')

// Touch `process.stdout` the way TTY probing and rendering do. This is what
// puts fd 1 into non-blocking mode, which is why the writer has to handle
// short writes and EAGAIN rather than trusting a single `writeSync`.
void process.stdout.isTTY

const payload = `${'x'.repeat(bytes - 1)}\n`

if (process.env.DRAIN_STRATEGY === 'stream') {
  process.stdout.write(payload)
} else {
  writeStdoutSync(payload)
}

process.exit(1)
