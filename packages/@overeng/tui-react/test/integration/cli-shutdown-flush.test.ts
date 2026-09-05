/**
 * Regression test for the `runTuiMain` shutdown contract:
 *
 *  - natural exit AWAITS the scope flush finalizer (no fixed wait) and is fast
 *    against a healthy collector,
 *  - a signal-interrupted CLI (Ctrl-C) exits with code 130 (shell convention),
 *    not 0, and bails fast,
 *  - a clean success exits 0.
 *
 * Scope: this exercises the EFFECT-LEVEL lifecycle — the interrupt is raised via
 * `Effect.interrupt` (the same pure-interrupt cause platform-node's
 * `process.on('SIGINT')` handler produces), NOT the real OS signal wiring. The
 * "flush" is a stand-in scope finalizer with a similar shape to the real OTLP
 * exporter finalizer, so tui-react stays free of an `@effect/opentelemetry`
 * dependency; the exporter's own flush + interruptibility is covered in
 * `@overeng/utils` / `@overeng/megarepo`.
 */
import { createServer, type Server } from 'node:http'

import { Duration, Effect, type Exit } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runTuiMain, type TuiRuntime } from '../../src/effect/cli.tsx'

/** Controllable fake OTLP collector: injectable per-request latency / black-hole. */
const makeCollector = (opts: { latencyMs?: number; blackhole?: boolean }) =>
  new Promise<{ baseUrl: string; sawPost: () => boolean; stop: () => void }>((resolve) => {
    let posted = false
    const server: Server = createServer((req, res) => {
      req.on('data', () => {})
      req.on('end', () => {
        posted = true
        if (opts.blackhole === true) return // never respond
        const done = (): void => void res.writeHead(200).end('{}')
        if (opts.latencyMs !== undefined) setTimeout(done, opts.latencyMs)
        else done()
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        sawPost: () => posted,
        stop: () => server.close(),
      })
    })
  })

/**
 * A fake `TuiRuntime` whose `runMain` forks the effect and invokes the provided
 * `teardown` with a CAPTURING `onExit` (instead of `process.exit`), so the test
 * can assert the resulting exit code.
 */
const makeFakeRuntime = () => {
  let exitCode: number | undefined
  let resolveExit!: () => void
  const exited = new Promise<void>((r) => (resolveExit = r))

  const runtime: TuiRuntime = {
    runMain: (options) => (effect) => {
      const fiber = Effect.runFork(effect)
      fiber.addObserver((exit: Exit.Exit<unknown, unknown>) => {
        options?.teardown?.(exit, (code) => {
          exitCode = code
        })
        resolveExit()
      })
    },
  }

  return { runtime, exited, getExitCode: () => exitCode }
}

/**
 * Program with a stand-in flush finalizer (async POST, capped) — a similar
 * lifecycle shape to the real OTLP exporter's scope finalizer, so we can assert
 * the finalizer is awaited on natural exit.
 */
const program = (args: { baseUrl: string; capMs: number; onWorkDone: () => void }) =>
  Effect.gen(function* () {
    yield* Effect.addFinalizer(() =>
      Effect.promise(() =>
        fetch(`${args.baseUrl}/v1/traces`, { method: 'POST', body: '{}' })
          .then(() => {})
          .catch(() => {}),
      ).pipe(Effect.timeoutOption(Duration.millis(args.capMs))),
    )
    yield* Effect.sync(args.onWorkDone)
  }).pipe(Effect.scoped)

// `runTuiMain` forwards an app-level `process.exitCode` (the channel
// `createTuiApp`'s `exitCode` mapper writes) on the success path, so pin a clean
// baseline. Assigning `undefined` is a no-op on Bun — which runs these workers
// under Buck — so use 0, the equivalent "nothing to report" value.
let savedExitCode: typeof process.exitCode
beforeEach(() => {
  savedExitCode = process.exitCode
  process.exitCode = 0
})
afterEach(() => {
  process.exitCode = savedExitCode ?? 0
})

describe('runTuiMain shutdown-flush + exit-code contract', () => {
  it('healthy collector: natural exit awaits the flush, lands it, and is fast', async () => {
    const col = await makeCollector({ latencyMs: 5 })
    const { runtime, exited } = makeFakeRuntime()
    let workDoneAt = 0
    runTuiMain(
      runtime,
      program({
        baseUrl: col.baseUrl,
        capMs: 30_000,
        onWorkDone: () => (workDoneAt = performance.now()),
      }),
    )
    await exited
    const elapsed = performance.now() - workDoneAt
    col.stop()
    expect(col.sawPost()).toBe(true) // finalizer was awaited → flush landed
    expect(elapsed).toBeLessThan(1000) // ≈ one round-trip, not the 30s cap
  })

  it('a signal-interrupted CLI exits 130, not 0 (and bails fast)', async () => {
    // `Effect.interrupt` produces a pure interrupt cause deterministically — the
    // same shape platform-node raises on SIGINT — so the wrapper leaves it in the
    // fiber Exit and the teardown maps interrupts-only to 130. Interruptibility of
    // the flush itself is the exporter's concern, covered by the @overeng/utils /
    // @overeng/megarepo otel tests against the real OTLP exporter.
    const { runtime, exited, getExitCode } = makeFakeRuntime()
    const start = performance.now()
    runTuiMain(runtime, Effect.interrupt)
    await exited
    expect(getExitCode()).toBe(130)
    // The 130 comes from the Exit, not from a global side effect — a mutated
    // `process.exitCode` would leak into every later run in this process.
    expect(process.exitCode).toBe(0)
    expect(performance.now() - start).toBeLessThan(1000)
  })

  it('clean success exits 0', async () => {
    const col = await makeCollector({ latencyMs: 5 })
    const { runtime, exited, getExitCode } = makeFakeRuntime()
    runTuiMain(runtime, program({ baseUrl: col.baseUrl, capMs: 30_000, onWorkDone: () => {} }))
    await exited
    col.stop()
    expect(getExitCode()).toBe(0)
  })
})
