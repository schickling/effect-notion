/**
 * Tests for CLI entrypoint helpers.
 */

import { Cause, Effect, Exit } from 'effect'
import { describe, expect, test } from 'vitest'

import { outputModeLayer, runTuiMain, type TuiRuntime } from '../../src/effect/cli.tsx'

describe('runTuiMain', () => {
  test('reports exit code 130 for interrupt-only failures, leaving process.exitCode alone', async () => {
    // The interrupt is NOT swallowed: it stays in the error channel, so the fiber
    // Exit — the only channel the exit code is derived from — carries it into the
    // teardown, which maps interrupts-only to 130. Nothing is written to the
    // global `process.exitCode`, which would leak into later runs in-process.
    let captured: Effect.Effect<unknown, never> | undefined
    let teardown:
      | (<E, A>(exit: Exit.Exit<E, A>, onExit: (code: number) => void) => void)
      | undefined
    const runtime: TuiRuntime = {
      runMain:
        (options) =>
        <E, A>(effect: Effect.Effect<A, E>) => {
          captured = effect as Effect.Effect<unknown, never>
          teardown = options?.teardown
        },
    }
    const previousExitCode = process.exitCode
    // Assigning `undefined` is a no-op on Bun; 0 is the equivalent clean baseline.
    process.exitCode = 0

    try {
      runTuiMain(runtime, Effect.interrupt)

      expect(captured).toBeDefined()
      expect(teardown).toBeDefined()
      const exit = await Effect.runPromiseExit(captured!)

      expect(Exit.isFailure(exit) === true && Cause.hasInterruptsOnly(exit.cause) === true).toBe(
        true,
      )

      let code: number | undefined
      teardown!(exit, (value) => {
        code = value
      })
      expect(code).toBe(130)
      expect(process.exitCode).toBe(0)
    } finally {
      process.exitCode = previousExitCode ?? 0
    }
  })
})

describe('outputModeLayer json mode', () => {
  test('logs go to stderr only, with no stray undefined line', async () => {
    // `consolePretty` writes through the Effect `Console` service, which
    // defaults to the global console — so the two globals are the observation
    // point for the stdout/stderr split. Colors are off because vitest's
    // stdout is not a TTY, keeping the rendered line deterministic.
    const stdoutArgs: unknown[][] = []
    const stderrArgs: unknown[][] = []
    const originalLog = console.log
    const originalError = console.error
    console.log = (...args: unknown[]) => {
      stdoutArgs.push(args)
    }
    console.error = (...args: unknown[]) => {
      stderrArgs.push(args)
    }

    try {
      await Effect.runPromise(
        Effect.log('No active session').pipe(Effect.provide(outputModeLayer('json'))),
      )
    } finally {
      console.log = originalLog
      console.error = originalError
    }

    // stdout stays reserved for JSON data.
    expect(stdoutArgs).toEqual([])

    expect(stderrArgs).toHaveLength(1)
    const stderrLine = stderrArgs[0]!.map(String).join(' ')
    expect(stderrLine).toContain('No active session')
    // Wrapping the self-printing `consolePretty` in `Logger.withConsoleError`
    // used to pass its `void` result to `console.error`, logging `undefined`.
    expect(stderrArgs[0]).not.toContain(undefined)
    expect(stderrLine).not.toContain('undefined')
  })
})
