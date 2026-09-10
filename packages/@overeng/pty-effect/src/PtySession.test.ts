import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, it } from '@effect/vitest'
import { Effect, Exit, Option, Schedule, Schema, Stream } from 'effect'

import { PtyError } from './PtyError.ts'
import { make } from './PtySession.ts'
import { PtyName, PtySpec_ } from './PtySpec.ts'

/**
 * Each test runs in its own `PTY_SESSION_DIR` so server-mode socket/pid/lock
 * files never collide across tests, processes, or developer machines. Spawn
 * mode doesn't touch this directory but we set it anyway for symmetry.
 */
const withIsolatedDir = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-effect-test-'))
    const prev = process.env.PTY_SESSION_DIR
    process.env.PTY_SESSION_DIR = dir
    try {
      return yield* eff
    } finally {
      if (prev === undefined) delete process.env.PTY_SESSION_DIR
      else process.env.PTY_SESSION_DIR = prev
      // @effect-diagnostics-next-line tryCatchInEffectGen:off -- synchronous best-effort `fs.rmSync` cleanup in a JS `finally` (no `yield*`); keeping it inline preserves the env save/restore + dir-removal semantics. A principled `Effect.acquireRelease` refactor is the better long-term fix but changes more than the flagged construct.
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        // best effort
      }
    }
  })

const fastSchedule = Schedule.spaced('20 millis')
// TODO: Remove this skip and simplify the reconnect test once
// https://github.com/overengineeringstudio/effect-utils/issues/557 is resolved.
const SKIP_SERVER_RECONNECT_ON_LINUX_CI =
  process.env.CI === 'true' && process.platform === 'linux' && process.arch === 'x64'

describe('PtyName schema', () => {
  it('accepts valid names', () => {
    expect(Schema.decodeSync(PtyName)('alpha-1.test_2')).toBe('alpha-1.test_2')
  })
  it('rejects invalid names', () => {
    expect(() => Schema.decodeSync(PtyName)('has space')).toThrow()
    expect(() => Schema.decodeSync(PtyName)('')).toThrow()
    expect(() => Schema.decodeSync(PtyName)('a/b')).toThrow()
  })
})

describe('PtySession (spawn mode)', () => {
  it.live('captures echoed output via waitForText', () =>
    withIsolatedDir(
      Effect.gen(function* () {
        const session = yield* make(
          PtySpec_.spawn({ command: 'sh', args: ['-c', 'echo hello-world; sleep 1'] }),
        )
        const ss = yield* session.waitForText({ needle: 'hello-world', schedule: fastSchedule })
        expect(ss.text).toContain('hello-world')
      }),
    ),
  )

  it.live('waitForText composes with Effect.timeout', () =>
    withIsolatedDir(
      Effect.gen(function* () {
        const session = yield* make(PtySpec_.spawn({ command: 'sh', args: ['-c', 'sleep 5'] }))
        const exit = yield* session
          .waitForText({ needle: 'NEVER_APPEARS', schedule: fastSchedule })
          .pipe(Effect.timeout('200 millis'), Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    ),
  )

  it.live('waitForText accepts an exponential Schedule', () =>
    withIsolatedDir(
      Effect.gen(function* () {
        const session = yield* make(
          PtySpec_.spawn({ command: 'sh', args: ['-c', 'sleep 0.05; echo READY; sleep 1'] }),
        )
        const exponential = Schedule.min([
          Schedule.exponential('5 millis'),
          Schedule.spaced('100 millis'),
        ])
        const ss = yield* session.waitForText({ needle: 'READY', schedule: exponential })
        expect(ss.text).toContain('READY')
      }),
    ),
  )

  it.live('write + press are observable in subsequent screenshots', () =>
    withIsolatedDir(
      Effect.gen(function* () {
        // `cat` echoes its stdin to stdout — perfect for verifying write/press.
        const session = yield* make(PtySpec_.spawn({ command: 'cat' }))
        yield* session.write({ data: 'ping-' })
        yield* session.type({ text: 'pong' })
        yield* session.press({ key: 'return' as never })
        const ss = yield* session.waitForText({ needle: 'ping-pong', schedule: fastSchedule })
        expect(ss.text).toContain('ping-pong')
      }),
    ),
  )

  it.live('screenshots Stream emits on schedule and stops on scope close', () =>
    withIsolatedDir(
      Effect.gen(function* () {
        const session = yield* make(
          PtySpec_.spawn({ command: 'sh', args: ['-c', 'echo tick; sleep 5'] }),
        )
        // Wait until the child has actually written before slicing the
        // screenshot stream. xterm-headless processes node-pty's onData
        // callbacks asynchronously, so a screenshot taken in the same
        // microtask as spawn() may legitimately be empty.
        yield* session.waitForText({ needle: 'tick', schedule: fastSchedule })
        const chunk = yield* session
          .screenshots({ schedule: fastSchedule })
          .pipe(Stream.take(3), Stream.runCollect)
        expect(chunk.length).toBe(3)
        for (const ss of chunk) {
          expect(ss.text).toContain('tick')
        }
      }),
    ),
  )

  // Note: upstream's `Session.resize` is server-mode only. We document this
  // by failing fast in spawn mode (test below) and exercising the happy path
  // in the server-mode block.
  it.live('resize fails with ResizeFailed in spawn mode', () =>
    withIsolatedDir(
      Effect.gen(function* () {
        const session = yield* make(PtySpec_.spawn({ command: 'cat' }))
        const exit = yield* session.resize({ rows: 40, cols: 120 }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    ),
  )

  it.live('waitForAbsent succeeds when text disappears (clear screen)', () =>
    withIsolatedDir(
      Effect.gen(function* () {
        // Print marker, then clear screen with `clear`. The xterm-headless
        // buffer reflects the cleared state once `clear` runs.
        const session = yield* make(
          PtySpec_.spawn({
            command: 'sh',
            args: ['-c', 'echo MARKER; sleep 0.1; clear; sleep 1'],
          }),
        )
        yield* session.waitForText({ needle: 'MARKER', schedule: fastSchedule })
        const ss = yield* session.waitForAbsent({ needle: 'MARKER', schedule: fastSchedule })
        expect(ss.text).not.toContain('MARKER')
      }),
    ),
  )

  it.live('custom waitFor predicate returns the projected value', () =>
    withIsolatedDir(
      Effect.gen(function* () {
        const session = yield* make(
          PtySpec_.spawn({ command: 'sh', args: ['-c', 'echo answer=42; sleep 1'] }),
        )
        const value = yield* session.waitFor({
          predicate: (ss) => {
            const m = /answer=(\d+)/.exec(ss.text)
            return m !== null ? Option.some(Number.parseInt(m[1]!, 10)) : Option.none()
          },
          schedule: fastSchedule,
          label: 'extract answer',
        })
        expect(value).toBe(42)
      }),
    ),
  )
})

describe('PtySession scope finalization', () => {
  it.live('finalizes cleanly on normal exit', () =>
    withIsolatedDir(
      Effect.gen(function* () {
        // Just verifies acquire/release runs without throwing across many specs.
        const session = yield* make(
          PtySpec_.spawn({ command: 'sh', args: ['-c', 'echo done; sleep 5'] }),
        )
        yield* session.waitForText({ needle: 'done', schedule: fastSchedule })
      }),
    ),
  )

  it('finalizes when interrupted mid-waitForText', () =>
    Effect.runPromise(
      withIsolatedDir(
        Effect.gen(function* () {
          // The whole scoped workload is wrapped in `Effect.scoped` here so we
          // can observe the finalizer running on interrupt instead of test
          // teardown.
          const exit = yield* Effect.scoped(
            Effect.gen(function* () {
              const session = yield* make(
                PtySpec_.spawn({ command: 'sh', args: ['-c', 'sleep 30'] }),
              )
              return yield* session
                .waitForText({ needle: 'NEVER', schedule: fastSchedule })
                .pipe(Effect.timeout('150 millis'))
            }),
          ).pipe(Effect.exit)
          // Timeout surfaces as a failure; the important assertion is that
          // we got back here (finalizer didn't hang) and the underlying
          // process was closed.
          expect(Exit.isFailure(exit)).toBe(true)
        }),
      ),
    ))
})

describe('PtySession (server mode)', () => {
  it.live('spawns a server, attaches, reads text', () =>
    withIsolatedDir(
      Effect.gen(function* () {
        const session = yield* make(
          PtySpec_.server({ command: 'sh', args: ['-c', 'sleep 0.1; echo server-ok; sleep 5'] }),
        )
        yield* session.attach
        const ss = yield* session.waitForText({ needle: 'server-ok', schedule: fastSchedule })
        expect(ss.text).toContain('server-ok')
      }),
    ),
  )

  it.live('resize works in server mode', () =>
    withIsolatedDir(
      Effect.gen(function* () {
        const session = yield* make(PtySpec_.server({ command: 'sh', args: ['-c', 'sleep 5'] }))
        yield* session.attach
        yield* session.resize({ rows: 40, cols: 120 })
      }),
    ),
  )

  if (SKIP_SERVER_RECONNECT_ON_LINUX_CI === true) {
    it.skip('reconnect cycles the socket without losing scrollback', () => {})
  } else {
    it.live(
      'reconnect cycles the socket without losing scrollback',
      () =>
        withIsolatedDir(
          Effect.gen(function* () {
            const session = yield* make(
              PtySpec_.server({
                command: 'sh',
                args: [
                  '-c',
                  'echo before-reconnect; i=0; while [ "$i" -lt 100 ]; do i=$((i + 1)); echo tick-$i; sleep 0.2; done; sleep 5',
                ],
              }),
            )
            yield* session.attach
            yield* session.waitForText({ needle: 'before-reconnect', schedule: fastSchedule })
            yield* session.waitForText({ needle: 'tick-1', schedule: fastSchedule })
            yield* session.reconnect
            // Wait for naturally emitted post-reconnect output rather than
            // racing a write into an attach sequence that can lag on CI.
            const ss = yield* session.waitForText({ needle: 'tick-10', schedule: fastSchedule })
            expect(ss.text).toContain('before-reconnect')
          }),
        ),
      /** Bumped from default 15s — slow CI runners need more headroom for the
       *  spawn → attach → reconnect cycle. */
      30_000,
    )
  }
})

describe('PtyError', () => {
  it('is a Schema.TaggedError instance', () => {
    const err = new PtyError({ reason: 'Timeout', method: 'unit-test' })
    expect(err._tag).toBe('PtyError')
    expect(err.reason).toBe('Timeout')
    expect(err instanceof PtyError).toBe(true)
  })
})
