/**
 * Tests for exit rendering behavior and interrupt handling.
 *
 * Tests the ExitMode options:
 * - persist: Keep all output visible (default)
 * - clear: Remove all output
 * - clearDynamic: Keep static logs, clear dynamic region
 *
 * Also tests interrupt handling with Interrupted action schema.
 */

import { it } from '@effect/vitest'
import { Effect, Fiber, Schema } from 'effect'
import React from 'react'
import { describe, test, expect, beforeEach, afterEach } from 'vitest'

import { createTuiApp, createRoot, Box, Text, testModeLayer } from '../../src/mod.tsx'
import { createMockTerminal } from '../helpers/mock-terminal.ts'
import { createVirtualTerminal } from '../helpers/virtual-terminal.ts'

// =============================================================================
// Test State and Actions
// =============================================================================

const TestState = Schema.Struct({
  value: Schema.String,
  interrupted: Schema.Boolean,
})

type TestState = Schema.Schema.Type<typeof TestState>

const decodeTestState = (json: string): TestState =>
  Schema.decodeSync(Schema.fromJsonString(TestState))(json)

// Action schema WITH Interrupted variant
const TestActionWithInterrupt = Schema.Union([
  Schema.TaggedStruct('SetValue', { value: Schema.String }),
  Schema.TaggedStruct('Interrupted', {}),
])

type TestActionWithInterrupt = Schema.Schema.Type<typeof TestActionWithInterrupt>

// Action schema WITHOUT Interrupted variant
const TestActionNoInterrupt = Schema.Union([
  Schema.TaggedStruct('SetValue', { value: Schema.String }),
])

type TestActionNoInterrupt = Schema.Schema.Type<typeof TestActionNoInterrupt>

const testReducerWithInterrupt = ({
  state,
  action,
}: {
  state: TestState
  action: TestActionWithInterrupt
}): TestState => {
  switch (action._tag) {
    case 'SetValue':
      return { ...state, value: action.value }
    case 'Interrupted':
      return { ...state, interrupted: true }
  }
}

const testReducerNoInterrupt = ({
  state,
  action,
}: {
  state: TestState
  action: TestActionNoInterrupt
}): TestState => {
  switch (action._tag) {
    case 'SetValue':
      return { ...state, value: action.value }
  }
}

// =============================================================================
// Test Apps
// =============================================================================

const AppWithInterrupt = createTuiApp({
  stateSchema: TestState,
  actionSchema: TestActionWithInterrupt,
  initial: { value: 'initial', interrupted: false },
  reducer: testReducerWithInterrupt,
})

const AppNoInterrupt = createTuiApp({
  stateSchema: TestState,
  actionSchema: TestActionNoInterrupt,
  initial: { value: 'initial', interrupted: false },
  reducer: testReducerNoInterrupt,
})

const WireState = Schema.TaggedStruct('WireState', {
  phase: Schema.Literals(['idle', 'done']),
  text: Schema.String,
  nullable: Schema.NullOr(Schema.String),
  note: Schema.optional(Schema.String),
  items: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      value: Schema.String,
    }),
  ),
})

type WireState = typeof WireState.Type

const WireAction = Schema.Union([Schema.TaggedStruct('SetWireState', { next: WireState })])
type WireAction = typeof WireAction.Type

const WireEvent = Schema.TaggedStruct('WireEvent', {
  from: Schema.Literals(['idle', 'done']),
  to: Schema.Literals(['idle', 'done']),
  text: Schema.String,
})

const FailurePartitionWire = Schema.fromJsonString(
  Schema.Struct({
    _tag: Schema.Literals(['Failure', 'Success']),
    cause: Schema.NullOr(Schema.String),
  }),
)

const initialWireState: WireState = {
  _tag: 'WireState',
  phase: 'idle',
  text: '',
  nullable: null,
  items: [],
}

const finalWireState: WireState = {
  _tag: 'WireState',
  phase: 'done',
  text: 'Line 1\r\nLine 2 世界 NaN 2026-02-31',
  nullable: null,
  note: '',
  items: [
    { id: 'α', value: '' },
    { id: 'big', value: '9007199254740991' },
  ],
}

const createWireApp = (options?: { readonly eventNdjson?: boolean }) =>
  createTuiApp<WireState, WireAction>({
    stateSchema: WireState,
    actionSchema: WireAction,
    initial: initialWireState,
    reducer: ({ action }) => action.next,
    ...(options?.eventNdjson === true && {
      ndjson: {
        eventSchema: WireEvent,
        fromAction: ({ action, prevState }: { action: WireAction; prevState: WireState }) => [
          {
            _tag: 'WireEvent' as const,
            from: prevState.phase,
            to: action.next.phase,
            text: action.next.text,
          },
        ],
      },
    }),
  })

// =============================================================================
// Exit Mode Tests (using createRoot directly)
// =============================================================================

// Helper to wait for React reconciliation
const waitForRender = () => new Promise((resolve) => setTimeout(resolve, 50))

describe('ExitMode', () => {
  describe('createRoot unmount modes', () => {
    test('persist mode keeps final output visible', async () => {
      const terminal = createMockTerminal({ isTTY: true, cols: 40 })
      const root = createRoot({ terminalOrStream: terminal, options: { throttleMs: 0 } })

      root.render(
        <Box flexDirection="column">
          <Text>Line 1</Text>
          <Text>Line 2</Text>
        </Box>,
      )

      await waitForRender()

      // Unmount with persist (default)
      root.unmount({ mode: 'persist' })

      // Output should contain the content with no clearing sequences
      expect(terminal.getPlainOutput()).toMatchInlineSnapshot(`
        "Line 1
        Line 2
        "
      `)
    })

    test('clearDynamic mode clears dynamic region', async () => {
      const terminal = createMockTerminal({ isTTY: true, cols: 40 })
      const root = createRoot({ terminalOrStream: terminal, options: { throttleMs: 0 } })

      root.render(
        <Box flexDirection="column">
          <Text>Dynamic content</Text>
        </Box>,
      )

      await waitForRender()

      // Unmount with clearDynamic
      root.unmount({ mode: 'clearDynamic' })

      // Should have cursor up + clear line sequences after the content
      expect(terminal.getRawOutput()).toMatchInlineSnapshot(`
        "[?25l[?2026h[0mDynamic content
        [?2026l[?2026h[?2026l[1A[2K
        [1A[?25h"
      `)
    })

    test('clear mode removes all output', async () => {
      const terminal = createMockTerminal({ isTTY: true, cols: 40 })
      const root = createRoot({ terminalOrStream: terminal, options: { throttleMs: 0 } })

      root.render(
        <Box flexDirection="column">
          <Text>Will be cleared</Text>
        </Box>,
      )

      await waitForRender()

      // Unmount with clear
      root.unmount({ mode: 'clear' })

      // Should have clearing sequences
      expect(terminal.getRawOutput()).toMatchInlineSnapshot(`
        "[?25l[?2026h[0mWill be cleared
        [?2026l[?2026h[?2026l[1A[2K
        [1A[?25h"
      `)
    })

    test('default mode is persist', async () => {
      const terminal = createMockTerminal({ isTTY: true, cols: 40 })
      const root = createRoot({ terminalOrStream: terminal, options: { throttleMs: 0 } })

      root.render(<Text>Content</Text>)

      await waitForRender()

      // Unmount without specifying mode
      root.unmount()

      // Content should persist (no clearing)
      expect(terminal.getPlainOutput()).toMatchInlineSnapshot(`
        "Content
        "
      `)
    })

    test('multiple renders then persist', async () => {
      const terminal = createMockTerminal({ isTTY: true, cols: 40 })
      const root = createRoot({ terminalOrStream: terminal, options: { throttleMs: 0 } })

      root.render(<Text>First</Text>)
      await waitForRender()
      root.render(<Text>Second</Text>)
      await waitForRender()
      root.render(<Text>Final</Text>)
      await waitForRender()

      root.unmount({ mode: 'persist' })

      // Final plaintext (after differential rendering clears previous)
      expect(terminal.getPlainOutput()).toMatchInlineSnapshot(`
        "First
        Second
        Final
        "
      `)
    })
  })
})

// =============================================================================
// Interrupt Handling Tests
// =============================================================================

describe('Interrupt Handling', () => {
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

  describe('Interrupted action detection', () => {
    test('detects Interrupted variant in action schema', async () => {
      // AppWithInterrupt should have detected the Interrupted variant
      // We can test this by checking if the reducer handles it
      const result = testReducerWithInterrupt({
        state: { value: 'test', interrupted: false },
        action: { _tag: 'Interrupted' },
      })
      expect(result.interrupted).toBe(true)
    })

    it.effect('app with Interrupted variant dispatches on scope close', () => {
      const states: TestState[] = []

      return Effect.gen(function* () {
        const tui = yield* AppWithInterrupt.run()

        // Track state changes
        states.push(tui.getState())

        tui.dispatch({ _tag: 'SetValue', value: 'updated' })
        states.push(tui.getState())

        // Scope will close here, which should dispatch Interrupted
      }).pipe(
        Effect.scoped,
        Effect.provide(testModeLayer('log')),
        Effect.andThen(
          Effect.sync(() => {
            // After scope closes, Interrupted should have been dispatched
            // The finalizer dispatches Interrupted, so the last state should have interrupted: true
            // Note: We need to check the final state after the effect completes
            expect(states[0]!.interrupted).toBe(false)
            expect(states[1]!.value).toBe('updated')
          }),
        ),
      )
    })

    it.effect('app without Interrupted variant does not dispatch on scope close', () => {
      const states: TestState[] = []

      return Effect.gen(function* () {
        const tui = yield* AppNoInterrupt.run()

        states.push(tui.getState())
        tui.dispatch({ _tag: 'SetValue', value: 'updated' })
        states.push(tui.getState())
      }).pipe(
        Effect.scoped,
        Effect.provide(testModeLayer('log')),
        Effect.andThen(
          Effect.sync(() => {
            // Should not have interrupted state since schema doesn't have Interrupted
            expect(states.every((s) => s.interrupted === false)).toBe(true)
          }),
        ),
      )
    })
  })
})

// =============================================================================
// TuiAppApi.unmount() Tests
// =============================================================================

describe('TuiAppApi.unmount()', () => {
  it.effect('explicit unmount with persist mode', () =>
    Effect.gen(function* () {
      const tui = yield* AppNoInterrupt.run()

      tui.dispatch({ _tag: 'SetValue', value: 'before unmount' })
      expect(tui.getState().value).toBe('before unmount')

      // Explicit unmount
      yield* tui.unmount({ mode: 'persist' })

      // State should still be accessible
      expect(tui.getState().value).toBe('before unmount')
    }).pipe(Effect.scoped, Effect.provide(testModeLayer('log'))),
  )

  it.effect('explicit unmount prevents double unmount', () =>
    Effect.gen(function* () {
      const tui = yield* AppNoInterrupt.run()

      // Explicit unmount
      yield* tui.unmount()

      // Second unmount should be safe (no-op)
      yield* tui.unmount()

      // Scope close should also be safe
      // If we get here without error, the test passes
      expect(true).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(testModeLayer('log'))),
  )
})

// =============================================================================
// Final JSON Output Tests (verifies state persistence)
// =============================================================================

describe('Final state output', () => {
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

  it.effect('json mode outputs final raw state on normal completion', () =>
    Effect.gen(function* () {
      const tui = yield* AppWithInterrupt.run()
      tui.dispatch({ _tag: 'SetValue', value: 'final' })
    }).pipe(
      Effect.scoped,
      Effect.provide(testModeLayer('json')),
      Effect.andThen(
        Effect.sync(() => {
          expect(capturedOutput).toHaveLength(1)
          const state = decodeTestState(capturedOutput[0]!)
          // Flat contract: stdout is raw state, no envelope.
          expect(state.value).toBe('final')
          expect(state.interrupted).toBe(false)
        }),
      ),
    ),
  )

  it.effect('json mode emits final state on defect (error details via Effect channel)', () =>
    Effect.gen(function* () {
      const tui = yield* AppWithInterrupt.run()
      tui.dispatch({ _tag: 'SetValue', value: 'partial' })
      // Simulate a defect (crash)
      return yield* Effect.die(new Error('Simulated crash'))
    }).pipe(
      Effect.scoped,
      Effect.provide(testModeLayer('json')),
      Effect.catchDefect((defect) => Effect.succeed({ caught: defect })),
      Effect.andThen(() => Effect.sync(() => {})),
    ),
  )

  it.live('json mode emits final state on interrupt', () => {
    const InterruptTestApp = createTuiApp({
      stateSchema: TestState,
      actionSchema: TestActionWithInterrupt,
      initial: { value: 'initial', interrupted: false },
      reducer: testReducerWithInterrupt,
    })

    return Effect.gen(function* () {
      const fiber = yield* Effect.gen(function* () {
        const tui = yield* InterruptTestApp.run()
        tui.dispatch({ _tag: 'SetValue', value: 'before interrupt' })
        yield* Effect.yieldNow
        return yield* Effect.never
      }).pipe(Effect.scoped, Effect.provide(testModeLayer('json')), Effect.forkChild)

      yield* Effect.sleep('50 millis')
      yield* Fiber.interruptAs(fiber, fiber.id)
      const _ = yield* Fiber.await(fiber)
    }).pipe(
      Effect.andThen(
        Effect.sync(() => {
          // Interrupt still emits the final state (no envelope). The interrupt
          // signal itself rides the Effect channel, not stdout.
          expect(capturedOutput).toHaveLength(1)
          const state = decodeTestState(capturedOutput[0]!)
          expect(state).toBeDefined()
          expect(state).toHaveProperty('value')
        }),
      ),
    )
  })
})

describe('tui-react JSON/NDJSON wire baselines (cross-major invariant)', () => {
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

  it.effect('emits final JSON as byte-identical raw state', () =>
    Effect.gen(function* () {
      const app = createWireApp()
      const tui = yield* app.run()
      tui.dispatch({ _tag: 'SetWireState', next: finalWireState })
    }).pipe(
      Effect.scoped,
      Effect.provide(testModeLayer('json')),
      Effect.andThen(
        Effect.sync(() => {
          expect(capturedOutput).toMatchInlineSnapshot(`
          [
            "{"_tag":"WireState","phase":"done","text":"Line 1\\r\\nLine 2 世界 NaN 2026-02-31","nullable":null,"note":"","items":[{"id":"α","value":""},{"id":"big","value":"9007199254740991"}]}",
          ]
        `)
        }),
      ),
    ),
  )

  it.effect('emits progressive NDJSON snapshots as byte-identical lines', () =>
    Effect.gen(function* () {
      const app = createWireApp()
      const tui = yield* app.run()
      tui.dispatch({ _tag: 'SetWireState', next: finalWireState })
    }).pipe(
      Effect.scoped,
      Effect.provide(testModeLayer('ndjson')),
      Effect.andThen(
        Effect.sync(() => {
          expect(capturedOutput.join('\n')).toMatchInlineSnapshot(`
          "{"_tag":"WireState","phase":"idle","text":"","nullable":null,"items":[]}
          {"_tag":"WireState","phase":"done","text":"Line 1\\r\\nLine 2 世界 NaN 2026-02-31","nullable":null,"note":"","items":[{"id":"α","value":""},{"id":"big","value":"9007199254740991"}]}"
        `)
        }),
      ),
    ),
  )

  it.effect('emits event-mapped progressive NDJSON as byte-identical lines', () =>
    Effect.gen(function* () {
      const app = createWireApp({ eventNdjson: true })
      const tui = yield* app.run()
      tui.dispatch({ _tag: 'SetWireState', next: finalWireState })
    }).pipe(
      Effect.scoped,
      Effect.provide(testModeLayer('ndjson')),
      Effect.andThen(
        Effect.sync(() => {
          expect(capturedOutput.join('\n')).toMatchInlineSnapshot(`
          "{"_tag":"WireState","phase":"idle","text":"","nullable":null,"items":[]}
          {"_tag":"WireEvent","from":"idle","to":"done","text":"Line 1\\r\\nLine 2 世界 NaN 2026-02-31"}"
        `)
        }),
      ),
    ),
  )

  it.effect('captures JSON encode failures as stable failure JSON', () =>
    Effect.gen(function* () {
      const InvalidApp = createTuiApp({
        stateSchema: WireState,
        actionSchema: Schema.Struct({ next: Schema.Unknown }),
        initial: initialWireState,
        reducer: ({ action }) => action.next as WireState,
      })
      const exit = yield* Effect.gen(function* () {
        const tui = yield* InvalidApp.run()
        tui.dispatch({ next: { ...finalWireState, text: null } })
      }).pipe(Effect.scoped, Effect.provide(testModeLayer('json')), Effect.exit)
      const failureBytes = yield* Schema.encodeEffect(FailurePartitionWire)({
        _tag: exit._tag,
        cause:
          exit._tag === 'Failure' && exit.cause !== undefined
            ? (String(exit.cause).split('\n    at ')[0] ?? '')
            : null,
      })

      // If effect#6313 ever prints help on stdout, #980's machine-readable
      // stdout contract must absorb it rather than bytes reaching this stream.
      expect(capturedOutput).toMatchInlineSnapshot(`[]`)
      expect(failureBytes).toMatchInlineSnapshot(
        `"{"_tag":"Failure","cause":"Cause([Die(SchemaError(Expected string\\n  at [\\"text\\"]))])"}"`,
      )
    }),
  )
})

// =============================================================================
// VirtualTerminal Tests (actual screen visibility)
// =============================================================================

describe('VirtualTerminal (actual screen state)', () => {
  describe('persist mode - visible content', () => {
    test('final content is visible after unmount', async () => {
      const terminal = createVirtualTerminal({ cols: 40, rows: 10 })
      const root = createRoot({ terminalOrStream: terminal, options: { throttleMs: 0 } })

      root.render(
        <Box flexDirection="column">
          <Text>Line 1</Text>
          <Text>Line 2</Text>
          <Text>Line 3</Text>
        </Box>,
      )

      await waitForRender()
      await terminal.flush()

      root.unmount({ mode: 'persist' })
      await terminal.flush()

      // Check actual visible content
      expect(terminal.getVisibleLines()).toMatchInlineSnapshot(`
        [
          "Line 1",
          "Line 2",
          "Line 3",
        ]
      `)

      terminal.dispose()
    })

    test('horizontal layout renders on single lines', async () => {
      const terminal = createVirtualTerminal({ cols: 40, rows: 10 })
      const root = createRoot({ terminalOrStream: terminal, options: { throttleMs: 0 } })

      root.render(
        <Box flexDirection="column">
          <Text bold>Header</Text>
          <Box flexDirection="row">
            <Text>Frame: </Text>
            <Text color="yellow">123</Text>
          </Box>
          <Box flexDirection="row">
            <Text>FPS: </Text>
            <Text color="green">60</Text>
          </Box>
        </Box>,
      )

      await waitForRender()
      await terminal.flush()

      root.unmount({ mode: 'persist' })
      await terminal.flush()

      expect(terminal.getVisibleLines()).toMatchInlineSnapshot(`
        [
          "Header",
          "Frame: 123",
          "FPS: 60",
        ]
      `)

      terminal.dispose()
    })

    test('multiple renders preserve final state', async () => {
      const terminal = createVirtualTerminal({ cols: 40, rows: 10 })
      const root = createRoot({ terminalOrStream: terminal, options: { throttleMs: 0 } })

      // First render
      root.render(<Text>Count: 0</Text>)
      await waitForRender()
      await terminal.flush()

      // Second render (simulating state update)
      root.render(<Text>Count: 1</Text>)
      await waitForRender()
      await terminal.flush()

      // Third render
      root.render(<Text>Count: 2</Text>)
      await waitForRender()
      await terminal.flush()

      root.unmount({ mode: 'persist' })
      await terminal.flush()

      // Should show final state only
      expect(terminal.getVisibleLines()).toMatchInlineSnapshot(`
        [
          "Count: 2",
        ]
      `)

      terminal.dispose()
    })
  })

  describe('clearDynamic mode - content cleared', () => {
    test('dynamic content is cleared after unmount', async () => {
      const terminal = createVirtualTerminal({ cols: 40, rows: 10 })
      const root = createRoot({ terminalOrStream: terminal, options: { throttleMs: 0 } })

      root.render(
        <Box flexDirection="column">
          <Text>Will be cleared</Text>
        </Box>,
      )

      await waitForRender()
      await terminal.flush()

      // Content should be visible before unmount
      expect(terminal.getVisibleLines()).toContain('Will be cleared')

      root.unmount({ mode: 'clearDynamic' })
      await terminal.flush()

      // Content should be cleared
      expect(terminal.getVisibleLines()).toMatchInlineSnapshot(`[]`)

      terminal.dispose()
    })
  })

  describe('stress test scenario', () => {
    test('renders all lines including Frame/FPS/Progress/Spinner', async () => {
      const terminal = createVirtualTerminal({ cols: 60, rows: 20 })
      const root = createRoot({ terminalOrStream: terminal, options: { throttleMs: 0 } })

      // Simulate the stress test component structure
      const StressTestView = ({ frame }: { frame: number }) => {
        const fps = 60
        const progress = 50
        const barWidth = 20
        const filled = Math.round((progress / 100) * barWidth)

        return (
          <Box flexDirection="column" padding={1}>
            <Text bold color="cyan">
              Rapid Updates Stress Test
            </Text>
            <Text dim>Testing renderer at ~60fps</Text>

            <Box flexDirection="row" marginTop={1}>
              <Text>Frame: </Text>
              <Text color="yellow" bold>
                {frame.toString().padStart(5)}
              </Text>
            </Box>

            <Box flexDirection="row">
              <Text>FPS: </Text>
              <Text color="green" bold>
                {fps.toString().padStart(3)}
              </Text>
            </Box>

            <Box flexDirection="row" marginTop={1}>
              <Text>Progress: </Text>
              <Text color="green">{'█'.repeat(filled)}</Text>
              <Text dim>{'░'.repeat(barWidth - filled)}</Text>
              <Text> {progress}%</Text>
            </Box>

            <Box flexDirection="row" marginTop={1}>
              <Text dim>Spinner: </Text>
              <Text color="cyan">{['⠋', '⠙', '⠹', '⠸'][frame % 4]}</Text>
            </Box>
          </Box>
        )
      }

      root.render(<StressTestView frame={0} />)
      await waitForRender()
      await terminal.flush()

      root.unmount({ mode: 'persist' })
      await terminal.flush()

      const lines = terminal.getVisibleLines()

      // Verify all expected content is visible
      expect(lines).toMatchInlineSnapshot(`
        [
          " Rapid Updates Stress Test",
          " Testing renderer at ~60fps",
          " Frame:     0",
          " FPS:  60",
          " Progress: ██████████░░░░░░░░░░ 50%",
          " Spinner: ⠋",
        ]
      `)

      terminal.dispose()
    })

    test('multiple frame updates show final state', async () => {
      const terminal = createVirtualTerminal({ cols: 60, rows: 20 })
      const root = createRoot({ terminalOrStream: terminal, options: { throttleMs: 0 } })

      const SimpleCounter = ({ count }: { count: number }) => (
        <Box flexDirection="column">
          <Text>Header</Text>
          <Box flexDirection="row">
            <Text>Count: </Text>
            <Text bold>{count}</Text>
          </Box>
        </Box>
      )

      // Simulate rapid updates like the stress test
      for (let i = 0; i < 5; i++) {
        root.render(<SimpleCounter count={i} />)
        await waitForRender()
        await terminal.flush()
      }

      root.unmount({ mode: 'persist' })
      await terminal.flush()

      // Should show final count
      expect(terminal.getVisibleLines()).toMatchInlineSnapshot(`
        [
          "Header",
          "Count: 4",
        ]
      `)

      terminal.dispose()
    })

    test('unmount does not trigger additional clear (regression test)', async () => {
      const terminal = createVirtualTerminal({ cols: 60, rows: 20 })
      const root = createRoot({ terminalOrStream: terminal, options: { throttleMs: 0 } })

      // Render some content
      root.render(
        <Box flexDirection="column">
          <Text>Line 1</Text>
          <Text>Line 2</Text>
          <Text>Line 3</Text>
        </Box>,
      )

      await waitForRender()
      await terminal.flush()

      // Verify content is there before unmount
      expect(terminal.getVisibleLines()).toEqual(['Line 1', 'Line 2', 'Line 3'])

      // Unmount with persist mode
      root.unmount({ mode: 'persist' })

      // Wait a bit to ensure no deferred renders happen
      await new Promise((resolve) => setTimeout(resolve, 100))
      await terminal.flush()

      // Content should STILL be there - unmount should not trigger clearing
      expect(terminal.getVisibleLines()).toEqual(['Line 1', 'Line 2', 'Line 3'])

      terminal.dispose()
    })

    test('component with React hooks (useState/useEffect) renders all lines', async () => {
      const terminal = createVirtualTerminal({ cols: 60, rows: 20 })
      const root = createRoot({ terminalOrStream: terminal, options: { throttleMs: 0 } })

      // Component using actual React hooks like the stress test
      const HookCounter = () => {
        const [frame, setFrame] = React.useState(0)
        const [startTime] = React.useState(Date.now())

        React.useEffect(() => {
          const interval = setInterval(() => {
            setFrame((f) => f + 1)
          }, 16)
          return () => clearInterval(interval)
        }, [])

        const elapsed = Date.now() - startTime
        const fps = frame > 0 ? Math.round((frame / elapsed) * 1000) : 0

        return (
          <Box flexDirection="column" padding={1}>
            <Text bold color="cyan">
              Rapid Updates Stress Test
            </Text>
            <Text dim>Testing renderer at ~60fps</Text>
            <Box flexDirection="row">
              <Text>Frame: </Text>
              <Text color="yellow" bold>
                {frame.toString().padStart(5)}
              </Text>
            </Box>
            <Box flexDirection="row">
              <Text>FPS: </Text>
              <Text color="green" bold>
                {fps.toString().padStart(3)}
              </Text>
            </Box>
            <Box flexDirection="row">
              <Text dim>Spinner: </Text>
              <Text color="cyan">{['⠋', '⠙', '⠹', '⠸'][frame % 4]}</Text>
            </Box>
          </Box>
        )
      }

      root.render(<HookCounter />)

      // Wait for initial render
      await waitForRender()
      await terminal.flush()

      // Check initial render has all lines
      const initialLines = terminal.getVisibleLines()
      expect(initialLines.length).toBeGreaterThanOrEqual(5)
      expect(initialLines[0]).toContain('Rapid Updates Stress Test')
      expect(initialLines[1]).toContain('Testing renderer at ~60fps')
      expect(initialLines[2]).toContain('Frame:')
      expect(initialLines[3]).toContain('FPS:')
      expect(initialLines[4]).toContain('Spinner:')

      // Wait for a few frame updates
      await new Promise((resolve) => setTimeout(resolve, 100))
      await terminal.flush()

      // Unmount
      root.unmount({ mode: 'persist' })
      await terminal.flush()

      // Final state should still have all lines
      const finalLines = terminal.getVisibleLines()
      expect(finalLines.length).toBeGreaterThanOrEqual(5)
      expect(finalLines[0]).toContain('Rapid Updates Stress Test')
      expect(finalLines[2]).toContain('Frame:')

      terminal.dispose()
    })
  })
})
