/**
 * Tests for TuiApp factory pattern
 */

import { it } from '@effect/vitest'
import { Cause, Console, Effect, Exit, pipe, Result, Schema } from 'effect'
import React from 'react'
import { describe, expect, beforeEach, afterEach, test } from 'vitest'

import { testModeLayer } from '../../src/effect/testing.tsx'
import { createTuiApp, run, runResult, useTuiAtomValue, Box, Text } from '../../src/mod.tsx'
import { captureStdoutRaw, type RestoreStdoutCapture } from '../helpers/stdout-capture.ts'

const decodeJson = <A,>(schema: Schema.Codec<A>, json: string): A =>
  Schema.decodeSync(Schema.fromJsonString(schema))(json)

// =============================================================================
// Test State and Actions
// =============================================================================

const CounterState = Schema.Struct({
  count: Schema.Finite,
})

type CounterState = Schema.Schema.Type<typeof CounterState>

const CounterAction = Schema.Union([
  Schema.TaggedStruct('Increment', {}),
  Schema.TaggedStruct('Decrement', {}),
  Schema.TaggedStruct('Set', { value: Schema.Finite }),
])

type CounterAction = Schema.Schema.Type<typeof CounterAction>

const counterReducer = ({
  state,
  action,
}: {
  state: CounterState
  action: CounterAction
}): CounterState => {
  switch (action._tag) {
    case 'Increment':
      return { count: state.count + 1 }
    case 'Decrement':
      return { count: state.count - 1 }
    case 'Set':
      return { count: action.value }
  }
}

// =============================================================================
// Test App
// =============================================================================

const CounterApp = createTuiApp({
  stateSchema: CounterState,
  actionSchema: CounterAction,
  initial: { count: 0 },
  reducer: counterReducer,
})

// =============================================================================
// Test View (uses app-scoped hooks)
// =============================================================================

const CounterView = () => {
  const state = useTuiAtomValue(CounterApp.stateAtom)

  return (
    <Box flexDirection="column">
      <Text>Count: {state.count}</Text>
    </Box>
  )
}

// =============================================================================
// Tests
// =============================================================================

describe('createTuiApp', () => {
  let originalLog: typeof console.log
  let capturedOutput: string[]

  beforeEach(() => {
    originalLog = console.log
    capturedOutput = []
    console.log = (msg: string) => {
      capturedOutput.push(msg)
    }
  })

  afterEach(() => {
    console.log = originalLog
  })

  describe('headless (no view)', () => {
    it.effect('initializes with initial state', () =>
      Effect.gen(function* () {
        const tui = yield* CounterApp.run()
        const result = tui.getState()
        expect(result).toEqual({ count: 0 })
      }).pipe(Effect.scoped, Effect.provide(testModeLayer('log'))),
    )

    it.effect('dispatch updates state', () =>
      Effect.gen(function* () {
        const tui = yield* CounterApp.run()
        tui.dispatch({ _tag: 'Increment' })
        tui.dispatch({ _tag: 'Increment' })
        tui.dispatch({ _tag: 'Increment' })
        const result = tui.getState()
        expect(result).toEqual({ count: 3 })
      }).pipe(Effect.scoped, Effect.provide(testModeLayer('log'))),
    )

    it.effect('dispatch with payload', () =>
      Effect.gen(function* () {
        const tui = yield* CounterApp.run()
        tui.dispatch({ _tag: 'Set', value: 42 })
        const result = tui.getState()
        expect(result).toEqual({ count: 42 })
      }).pipe(Effect.scoped, Effect.provide(testModeLayer('log'))),
    )
  })

  describe('json mode', () => {
    it.effect('outputs final state as JSON with Success wrapper', () =>
      Effect.gen(function* () {
        const tui = yield* CounterApp.run()
        tui.dispatch({ _tag: 'Increment' })
        tui.dispatch({ _tag: 'Increment' })
      }).pipe(
        Effect.scoped,
        Effect.provide(testModeLayer('json')),
        Effect.andThen(
          Effect.sync(() => {
            expect(capturedOutput).toHaveLength(1)
            const state = decodeJson(CounterState, capturedOutput[0]!)
            expect(state).toEqual({ count: 2 })
          }),
        ),
      ),
    )

    it.effect('works with view (view is ignored in json mode)', () =>
      Effect.gen(function* () {
        const tui = yield* CounterApp.run(<CounterView />)
        tui.dispatch({ _tag: 'Set', value: 100 })
      }).pipe(
        Effect.scoped,
        Effect.provide(testModeLayer('json')),
        Effect.andThen(
          Effect.sync(() => {
            expect(capturedOutput).toHaveLength(1)
            const state = decodeJson(CounterState, capturedOutput[0]!)
            expect(state).toEqual({ count: 100 })
          }),
        ),
      ),
    )
  })

  describe('ndjson mode', () => {
    it.live('streams each state change as a raw JSON line', () =>
      Effect.gen(function* () {
        const tui = yield* CounterApp.run()
        yield* Effect.sleep('10 millis')
        tui.dispatch({ _tag: 'Increment' })
        yield* Effect.sleep('10 millis')
        tui.dispatch({ _tag: 'Increment' })
        yield* Effect.sleep('10 millis')
      }).pipe(
        Effect.scoped,
        Effect.provide(testModeLayer('ndjson')),
        Effect.andThen(
          Effect.sync(() => {
            // Initial snapshot + one line per state change. No trailing envelope.
            expect(capturedOutput.length).toBeGreaterThanOrEqual(2)

            const initialState = decodeJson(CounterState, capturedOutput[0]!)
            expect(initialState).toEqual({ count: 0 })

            // Last emitted line is the authoritative end state.
            const finalState = decodeJson(CounterState, capturedOutput[capturedOutput.length - 1]!)
            expect(finalState).toEqual({ count: 2 })
          }),
        ),
      ),
    )
  })

  describe('ndjson mode with event mapping', () => {
    const CounterEvent = Schema.Union([
      Schema.TaggedStruct('Incremented', { newCount: Schema.Finite }),
      Schema.TaggedStruct('Decremented', { newCount: Schema.Finite }),
      Schema.TaggedStruct('Reset', { from: Schema.Finite, to: Schema.Finite }),
    ])

    const EventCounterApp = createTuiApp({
      stateSchema: CounterState,
      actionSchema: CounterAction,
      initial: { count: 0 },
      reducer: counterReducer,
      ndjson: {
        eventSchema: CounterEvent,
        fromAction: ({ action, prevState }) => {
          const newCount = counterReducer({ state: prevState, action }).count
          switch (action._tag) {
            case 'Increment':
              return [{ _tag: 'Incremented' as const, newCount }]
            case 'Decrement':
              return [{ _tag: 'Decremented' as const, newCount }]
            case 'Set':
              return [{ _tag: 'Reset' as const, from: prevState.count, to: newCount }]
          }
        },
      },
    })

    it.live('emits events instead of full state snapshots', () =>
      Effect.gen(function* () {
        const tui = yield* EventCounterApp.run()
        yield* Effect.sleep('10 millis')
        tui.dispatch({ _tag: 'Increment' })
        yield* Effect.sleep('10 millis')
        tui.dispatch({ _tag: 'Increment' })
        yield* Effect.sleep('10 millis')
      }).pipe(
        Effect.scoped,
        Effect.provide(testModeLayer('ndjson')),
        Effect.andThen(
          Effect.sync(() => {
            // Line 1: initial full state snapshot
            const initialState = decodeJson(CounterState, capturedOutput[0]!)
            expect(initialState).toEqual({ count: 0 })

            // Subsequent lines: events (not full state). No trailing envelope.
            const event1 = decodeJson(CounterEvent, capturedOutput[1]!)
            expect(event1).toEqual({ _tag: 'Incremented', newCount: 1 })

            const event2 = decodeJson(CounterEvent, capturedOutput[2]!)
            expect(event2).toEqual({ _tag: 'Incremented', newCount: 2 })

            expect(capturedOutput).toHaveLength(3)
          }),
        ),
      ),
    )

    it.live('suppresses output when fromAction returns empty array', () => {
      const SilentApp = createTuiApp({
        stateSchema: CounterState,
        actionSchema: CounterAction,
        initial: { count: 0 },
        reducer: counterReducer,
        ndjson: {
          eventSchema: CounterEvent,
          fromAction: () => [],
        },
      })

      return Effect.gen(function* () {
        const tui = yield* SilentApp.run()
        yield* Effect.sleep('10 millis')
        tui.dispatch({ _tag: 'Increment' })
        tui.dispatch({ _tag: 'Increment' })
        yield* Effect.sleep('10 millis')
      }).pipe(
        Effect.scoped,
        Effect.provide(testModeLayer('ndjson')),
        Effect.andThen(
          Effect.sync(() => {
            // Only initial state snapshot — no intermediate events, no envelope.
            expect(capturedOutput).toHaveLength(1)
            expect(decodeJson(CounterState, capturedOutput[0]!)).toEqual({ count: 0 })
          }),
        ),
      )
    })

    it.live('emits multiple events per action', () => {
      const MultiEventApp = createTuiApp({
        stateSchema: CounterState,
        actionSchema: CounterAction,
        initial: { count: 0 },
        reducer: counterReducer,
        ndjson: {
          eventSchema: CounterEvent,
          fromAction: ({ action, prevState }) => {
            const newCount = counterReducer({ state: prevState, action }).count
            return [
              { _tag: 'Decremented' as const, newCount: prevState.count },
              { _tag: 'Incremented' as const, newCount },
            ]
          },
        },
      })

      return Effect.gen(function* () {
        const tui = yield* MultiEventApp.run()
        yield* Effect.sleep('10 millis')
        tui.dispatch({ _tag: 'Increment' })
        yield* Effect.sleep('10 millis')
      }).pipe(
        Effect.scoped,
        Effect.provide(testModeLayer('ndjson')),
        Effect.andThen(
          Effect.sync(() => {
            // Initial + 2 events from 1 action. No trailing envelope.
            expect(capturedOutput).toHaveLength(3)
            expect(decodeJson(CounterEvent, capturedOutput[1]!)).toEqual({
              _tag: 'Decremented',
              newCount: 0,
            })
            expect(decodeJson(CounterEvent, capturedOutput[2]!)).toEqual({
              _tag: 'Incremented',
              newCount: 1,
            })
          }),
        ),
      )
    })
  })

  describe('config access', () => {
    test('exposes config for testing', () => {
      expect(CounterApp.config.initial).toEqual({ count: 0 })
      expect(
        CounterApp.config.reducer({ state: { count: 5 }, action: { _tag: 'Increment' } }),
      ).toEqual({ count: 6 })
    })
  })

  describe('progressive mode rendering', () => {
    // Note: Progressive modes (tty, ci) render to process.stdout, not console.log.
    // We verify state is correctly set before unmount, and unmount waits for React
    // to process pending updates before flushing and cleaning up.

    it.effect('dispatch followed by immediate unmount captures final state', () =>
      Effect.gen(function* () {
        const tui = yield* CounterApp.run(<CounterView />)
        tui.dispatch({ _tag: 'Set', value: 42 })
        // Unmount now waits for React to process updates before flushing
        yield* tui.unmount({ mode: 'persist' })
        const finalState = tui.getState()
        expect(finalState).toEqual({ count: 42 })
      }).pipe(Effect.scoped, Effect.provide(testModeLayer('tty'))),
    )

    it.effect('multiple dispatches before unmount shows final state', () =>
      Effect.gen(function* () {
        const tui = yield* CounterApp.run(<CounterView />)
        tui.dispatch({ _tag: 'Set', value: 10 })
        tui.dispatch({ _tag: 'Increment' })
        tui.dispatch({ _tag: 'Increment' })
        tui.dispatch({ _tag: 'Increment' })
        yield* tui.unmount({ mode: 'persist' })
        const finalState = tui.getState()
        // Final state should be 13 (10 + 3 increments)
        expect(finalState).toEqual({ count: 13 })
      }).pipe(Effect.scoped, Effect.provide(testModeLayer('tty'))),
    )

    it.effect('unmount flushes React work synchronously via flushSyncWork', () =>
      // This test verifies that unmount uses React's flushSyncWork() to
      // synchronously flush pending work before unmounting
      Effect.gen(function* () {
        const tui = yield* CounterApp.run(<CounterView />)
        tui.dispatch({ _tag: 'Set', value: 100 })
        yield* tui.unmount({ mode: 'persist' })
        // If we reach here, unmount completed successfully
        expect(true).toBe(true)
      }).pipe(Effect.scoped, Effect.provide(testModeLayer('ci'))),
    )
  })

  describe('Ctrl+C interruption', () => {
    test('dispatches Interrupted when the run fiber is interrupted', async () => {
      const InterruptState = Schema.TaggedStruct('InterruptState', {
        status: Schema.Literals(['idle', 'running', 'interrupted']),
      })
      type InterruptState = typeof InterruptState.Type

      const InterruptAction = Schema.Union([
        Schema.TaggedStruct('Start', {}),
        Schema.TaggedStruct('Interrupted', {}),
      ])
      type InterruptAction = typeof InterruptAction.Type

      const previousExitCode = process.exitCode
      // Assigning `undefined` is a no-op on Bun (which runs these workers under
      // Buck); 0 is the equivalent "nothing to report" baseline, and restoring it
      // keeps this app-level exit code from leaking into later tests in-process.
      process.exitCode = 0
      const reducedStatuses: Array<InterruptState['status']> = []

      const InterruptApp = createTuiApp<InterruptState, InterruptAction>({
        stateSchema: InterruptState,
        actionSchema: InterruptAction,
        initial: { _tag: 'InterruptState', status: 'idle' },
        reducer: ({ action }): InterruptState => {
          const next: InterruptState = (() => {
            switch (action._tag) {
              case 'Start':
                return { _tag: 'InterruptState', status: 'running' }
              case 'Interrupted':
                return { _tag: 'InterruptState', status: 'interrupted' }
            }
          })()
          reducedStatuses.push(next.status)
          return next
        },
        exitCode: (state) => (state.status === 'interrupted' ? 130 : undefined),
      })

      try {
        const exit = await run(InterruptApp, (tui) =>
          Effect.gen(function* () {
            tui.dispatch({ _tag: 'Start' })
            return yield* Effect.interrupt
          }),
        ).pipe(Effect.provide(testModeLayer('tty')), Effect.runPromiseExit)

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit) === true) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
        expect(reducedStatuses).toContain('running')
        expect(reducedStatuses).toContain('interrupted')
        expect(process.exitCode).toBe(130)
      } finally {
        process.exitCode = previousExitCode ?? 0
      }
    })
  })

  describe('multiple apps', () => {
    it.effect('can create multiple independent apps', () => {
      const App1 = createTuiApp({
        stateSchema: CounterState,
        actionSchema: CounterAction,
        initial: { count: 10 },
        reducer: counterReducer,
      })

      const App2 = createTuiApp({
        stateSchema: CounterState,
        actionSchema: CounterAction,
        initial: { count: 20 },
        reducer: counterReducer,
      })

      return Effect.gen(function* () {
        const tui1 = yield* App1.run()
        const tui2 = yield* App2.run()

        tui1.dispatch({ _tag: 'Increment' })
        tui2.dispatch({ _tag: 'Decrement' })

        expect(tui1.getState()).toEqual({ count: 11 })
        expect(tui2.getState()).toEqual({ count: 19 })
      }).pipe(Effect.scoped, Effect.provide(testModeLayer('log')))
    })
  })
})

// =============================================================================
// Issue #129: typed errors must not mask real state on failure
// https://github.com/overengineeringstudio/effect-utils/issues/129
// =============================================================================

describe('Issue #129: typed errors do not mask final state', () => {
  let originalLog: typeof console.log
  let capturedOutput: string[]

  beforeEach(() => {
    originalLog = console.log
    capturedOutput = []
    console.log = (msg: string) => {
      capturedOutput.push(msg)
    }
  })

  afterEach(() => {
    console.log = originalLog
  })

  class GenerationFailed extends Schema.TaggedError<GenerationFailed>()('GenerationFailed', {
    message: Schema.String,
    failedCount: Schema.Finite,
  }) {}

  it.effect('json mode: typed error still emits final state on stdout', () =>
    run(CounterApp, (tui) =>
      Effect.gen(function* () {
        tui.dispatch({ _tag: 'Set', value: 42 })
        return yield* new GenerationFailed({
          message: '3 file(s) failed to generate',
          failedCount: 3,
        })
      }),
    ).pipe(
      Effect.provide(testModeLayer('json')),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          // Flat contract: stdout gets the final raw state, no envelope.
          // Exit code signals failure; the error details live in `cause` and
          // are surfaced via `formatError` → stderr.
          expect(capturedOutput).toHaveLength(1)
          const state = decodeJson(Schema.Record(Schema.String, Schema.Unknown), capturedOutput[0]!)
          expect(state.count).toBe(42)
          expect(state._tag).toBeUndefined()

          // Typed error still propagates via the Effect channel.
          const error = Cause.findError(cause)
          expect(
            Result.isSuccess(error) === true && error.success instanceof GenerationFailed,
          ).toBe(true)
        }),
      ),
    ),
  )

  it.live('ndjson mode: typed error preserves emitted intermediate state lines', () =>
    run(CounterApp, (tui) =>
      Effect.gen(function* () {
        yield* Effect.sleep('10 millis')
        tui.dispatch({ _tag: 'Set', value: 42 })
        yield* Effect.sleep('10 millis')
        return yield* new GenerationFailed({
          message: '3 file(s) failed to generate',
          failedCount: 3,
        })
      }),
    ).pipe(
      Effect.provide(testModeLayer('ndjson')),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          // Every state change before the error is on stdout as raw JSON.
          // No trailing Failure envelope — exit code + stderr carry error info.
          const states = capturedOutput.map((line) => JSON.parse(line))
          expect(states.some((s) => s.count === 42)).toBe(true)
          expect(states.every((s) => s._tag !== 'Failure')).toBe(true)

          // Typed error still propagates via the Effect channel.
          const error = Cause.findError(cause)
          expect(
            Result.isSuccess(error) === true && error.success instanceof GenerationFailed,
          ).toBe(true)
        }),
      ),
    ),
  )
})

// =============================================================================
// Standalone run() dual API tests
// =============================================================================

describe('run (standalone dual API)', () => {
  let originalLog: typeof console.log
  let capturedOutput: string[]

  beforeEach(() => {
    originalLog = console.log
    capturedOutput = []
    console.log = (msg: string) => {
      capturedOutput.push(msg)
    }
  })

  afterEach(() => {
    console.log = originalLog
  })

  class TestError extends Schema.TaggedError<TestError>()('TestError', {
    message: Schema.String,
  }) {}

  it.effect('data-first: dispatch updates state', () =>
    run(CounterApp, (tui) =>
      Effect.gen(function* () {
        tui.dispatch({ _tag: 'Increment' })
        tui.dispatch({ _tag: 'Increment' })
        expect(tui.getState()).toEqual({ count: 2 })
      }),
    ).pipe(Effect.provide(testModeLayer('log'))),
  )

  it.effect('data-last (pipeable): dispatch updates state', () =>
    pipe(
      CounterApp,
      run((tui) =>
        Effect.sync(() => {
          tui.dispatch({ _tag: 'Set', value: 42 })
          expect(tui.getState()).toEqual({ count: 42 })
        }),
      ),
      Effect.provide(testModeLayer('log')),
    ),
  )

  it.effect('handler return value is propagated', () =>
    run(CounterApp, (tui) =>
      Effect.gen(function* () {
        tui.dispatch({ _tag: 'Set', value: 99 })
        return tui.getState().count
      }),
    ).pipe(
      Effect.provide(testModeLayer('log')),
      Effect.map((count) => {
        expect(count).toBe(99)
      }),
    ),
  )

  it.effect('typed errors are propagated via Effect channel', () =>
    run(CounterApp, () => new TestError({ message: 'test error' })).pipe(
      Effect.provide(testModeLayer('log')),
      Effect.catch((error) =>
        Effect.sync(() => {
          expect(error).toBeInstanceOf(TestError)
          expect(error.message).toBe('test error')
        }),
      ),
    ),
  )

  it.effect('no Scope.Scope in requirements (scope managed internally)', () =>
    // This compiles without Effect.scoped — verifying the return type
    run(CounterApp, (tui) =>
      Effect.gen(function* () {
        tui.dispatch({ _tag: 'Increment' })
      }),
    ).pipe(Effect.provide(testModeLayer('log'))),
  )

  it.effect('json mode outputs final raw state for successful handler', () =>
    run(CounterApp, (tui) =>
      Effect.gen(function* () {
        tui.dispatch({ _tag: 'Set', value: 77 })
      }),
    ).pipe(
      Effect.provide(testModeLayer('json')),
      Effect.andThen(
        Effect.sync(() => {
          expect(capturedOutput).toHaveLength(1)
          const state = decodeJson(CounterState, capturedOutput[0]!)
          expect(state).toEqual({ count: 77 })
        }),
      ),
    ),
  )

  it.effect('view option is passed through', () =>
    run(
      CounterApp,
      (tui) =>
        Effect.gen(function* () {
          tui.dispatch({ _tag: 'Set', value: 100 })
          expect(tui.getState()).toEqual({ count: 100 })
        }),
      { view: <CounterView /> },
    ).pipe(Effect.provide(testModeLayer('tty'))),
  )
})

// =============================================================================
// runResult — Result-oriented command execution
// =============================================================================

describe('runResult', () => {
  let restoreStdout: RestoreStdoutCapture
  let originalLog: typeof console.log
  let originalStdoutWrite: typeof process.stdout.write
  let originalStderrWrite: typeof process.stderr.write
  let capturedConsole: string[]
  let capturedStdout: string[]
  let capturedStderr: string[]

  beforeEach(() => {
    originalLog = console.log
    originalStdoutWrite = process.stdout.write
    originalStderrWrite = process.stderr.write
    capturedConsole = []
    capturedStdout = []
    capturedStderr = []
    restoreStdout = captureStdoutRaw(capturedStdout)
    console.log = (msg: string) => {
      capturedConsole.push(msg)
    }
    process.stdout.write = ((chunk: unknown) => {
      capturedStdout.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    process.stderr.write = ((chunk: unknown) => {
      capturedStderr.push(String(chunk))
      return true
    }) as typeof process.stderr.write
  })

  afterEach(() => {
    restoreStdout()
    console.log = originalLog
    process.stdout.write = originalStdoutWrite
    process.stderr.write = originalStderrWrite
  })

  describe('string result (Schema.String)', () => {
    it.effect('json mode: writes raw string to stdout (no JSON encoding)', () =>
      runResult(
        CounterApp,
        (tui) =>
          Effect.gen(function* () {
            tui.dispatch({ _tag: 'Set', value: 42 })
            return 'my-secret-value'
          }),
        { result: Schema.String },
      ).pipe(
        Effect.provide(testModeLayer('json')),
        Effect.andThen((result) =>
          Effect.sync(() => {
            expect(result).toBe('my-secret-value')
            const stdout = capturedStdout.join('')
            expect(stdout).toBe('my-secret-value\n')
            expect(capturedConsole).toHaveLength(0)
          }),
        ),
      ),
    )

    it.effect('json mode: no Success/Failure envelope in output', () =>
      runResult(
        CounterApp,
        (tui) =>
          Effect.gen(function* () {
            tui.dispatch({ _tag: 'Increment' })
            return 'the-output'
          }),
        { result: Schema.String },
      ).pipe(
        Effect.provide(testModeLayer('json')),
        Effect.andThen(
          Effect.sync(() => {
            const allOutput = capturedStdout.join('') + capturedConsole.join('')
            expect(allOutput).not.toContain('Success')
            expect(allOutput).not.toContain('Failure')
            expect(allOutput).toContain('the-output')
          }),
        ),
      ),
    )

    it.effect('pipe mode (react/final): stdout has raw result only; view goes to stderr', () =>
      runResult(
        CounterApp,
        (tui) =>
          Effect.gen(function* () {
            tui.dispatch({ _tag: 'Set', value: 55 })
            return 'the-secret'
          }),
        { result: Schema.String, view: <CounterView /> },
      ).pipe(
        Effect.provide(testModeLayer('log')),
        Effect.andThen((result) =>
          Effect.sync(() => {
            expect(result).toBe('the-secret')
            // stdout is byte-for-byte the result (plus a trailing newline).
            const stdout = capturedStdout.join('')
            expect(stdout).toBe('the-secret\n')
            // stderr carries the rendered view so the channel is not lost.
            const stderr = capturedStderr.join('')
            expect(stderr).toContain('55')
            // The result never leaks into the view channel.
            expect(stderr).not.toContain('the-secret')
          }),
        ),
      ),
    )

    it.effect('tty mode: stdout has raw result only; view goes to stderr', () =>
      runResult(
        CounterApp,
        (tui) =>
          Effect.gen(function* () {
            tui.dispatch({ _tag: 'Set', value: 7 })
            return 'tty-secret'
          }),
        { result: Schema.String, view: <CounterView /> },
      ).pipe(
        Effect.provide(testModeLayer('tty')),
        Effect.andThen((result) =>
          Effect.sync(() => {
            expect(result).toBe('tty-secret')
            const stdout = capturedStdout.join('')
            expect(stdout).toBe('tty-secret\n')
            expect(stdout).not.toContain('\u001b[') // no ANSI on stdout
          }),
        ),
      ),
    )
  })

  describe('structured result (Schema.Struct)', () => {
    const ResultSchema = Schema.Struct({
      items: Schema.Array(Schema.String),
      total: Schema.Finite,
    })

    it.effect('json mode: writes JSON-encoded result directly to stdout', () =>
      runResult(
        CounterApp,
        (tui) =>
          Effect.gen(function* () {
            tui.dispatch({ _tag: 'Set', value: 3 })
            return { items: ['a', 'b', 'c'], total: 3 }
          }),
        { result: ResultSchema },
      ).pipe(
        Effect.provide(testModeLayer('json')),
        Effect.andThen((result) =>
          Effect.sync(() => {
            expect(result).toEqual({ items: ['a', 'b', 'c'], total: 3 })
            // `runResult` writes structured results directly via process.stdout
            // (not Effect.Console) so handler-emitted logs can be routed to
            // stderr without interfering with the result channel.
            const stdout = capturedStdout.join('')
            // @effect-diagnostics-next-line preferSchemaOverJson:off -- asserting the byte-exact JSON serialization written to stdout; re-encoding via Schema would use the implementation's own serializer (tautology)
            expect(stdout).toBe(JSON.stringify({ items: ['a', 'b', 'c'], total: 3 }) + '\n')
          }),
        ),
      ),
    )
  })

  describe('handler-emitted logs do not pollute stdout', () => {
    it.effect('Effect.log and Effect.Console.log in log mode go to stderr', () =>
      runResult(
        CounterApp,
        (tui) =>
          Effect.gen(function* () {
            yield* Effect.log('progress: starting')
            yield* Effect.log('progress: halfway')
            yield* Effect.logInfo('progress: done')
            yield* Console.log('console: chatty')
            tui.dispatch({ _tag: 'Set', value: 1 })
            return 'the-clean-payload'
          }),
        { result: Schema.String, view: <CounterView /> },
      ).pipe(
        Effect.provide(testModeLayer('log')),
        Effect.andThen((result) =>
          Effect.sync(() => {
            expect(result).toBe('the-clean-payload')
            // stdout must be byte-clean: only the result + trailing newline.
            const stdout = capturedStdout.join('')
            expect(stdout).toBe('the-clean-payload\n')
            // Any Effect.log / Console.log lines should not appear on stdout.
            expect(stdout).not.toContain('progress')
            expect(stdout).not.toContain('console:')
          }),
        ),
      ),
    )
  })

  describe('ndjson assertion', () => {
    it.effect(
      'ndjson mode: fails with clear error (result commands do not support streaming)',
      () =>
        runResult(CounterApp, () => Effect.succeed('value'), { result: Schema.String }).pipe(
          Effect.provide(testModeLayer('ndjson')),
          Effect.catchDefect((defect) =>
            Effect.sync(() => {
              expect(defect).toBeInstanceOf(Error)
              expect((defect as Error).message).toContain('runResult does not support ndjson')
            }),
          ),
        ),
    )
  })

  describe('error handling', () => {
    class ReadError extends Schema.TaggedError<ReadError>()('ReadError', {
      message: Schema.String,
    }) {}

    it.effect('handler error: no stdout, error propagated', () =>
      runResult(CounterApp, () => new ReadError({ message: 'access denied' }), {
        result: Schema.String,
      }).pipe(
        Effect.provide(testModeLayer('json')),
        Effect.catch((error) =>
          Effect.sync(() => {
            expect(error).toBeInstanceOf(ReadError)
            expect(error.message).toBe('access denied')
            const stdout = capturedStdout.join('')
            expect(stdout).toBe('')
            expect(capturedConsole).toHaveLength(0)
          }),
        ),
      ),
    )
  })
})
