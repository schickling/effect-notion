/**
 * Test utilities for tui-react Effect CLI integration.
 *
 * Provides helpers for testing commands that use createTuiApp.
 *
 * @example
 * ```typescript
 * import { runTestCommand, createTestTuiState } from '@overeng/tui-react'
 *
 * test('deploy command outputs JSON', async () => {
 *   const { exit, finalState } = await runTestCommand({
 *     commandFn: (args) => runDeploy(args),
 *     options: { args: ['api-server'], mode: 'json', schema: DeployOutputSchema },
 *   })
 *
 *   expect(Exit.isSuccess(exit)).toBe(true)
 *   expect(finalState?._tag).toBe('Complete')
 * })
 * ```
 */

import type { Scope } from 'effect'
import { Console, Effect, Exit, Layer, PubSub, Schema, Stream } from 'effect'
import { Atom, AtomRegistry } from 'effect/unstable/reactivity'

import {
  type OutputMode,
  OutputModeTag,
  tty,
  ci,
  log,
  altScreen,
  json,
  ndjson,
} from './OutputMode.tsx'
import type { TuiAppConfig, TuiAppApi } from './TuiApp.tsx'

// =============================================================================
// Types
// =============================================================================

/**
 * Mode preset name for testing.
 */
export type TestModePreset = 'tty' | 'ci' | 'log' | 'fullscreen' | 'json' | 'ndjson'

/**
 * Options for running a test command.
 */
export interface RunTestCommandOptions<S, Args> {
  /** Command arguments */
  args: Args
  /** Output mode preset to use */
  mode: TestModePreset
  /** Schema for parsing and validating JSON output */
  schema: Schema.Codec<S>
}

/**
 * Result of running a test command.
 */
export interface TestCommandResult<S, E> {
  /** All state values emitted during execution (from JSON output) */
  states: S[]
  /** Final state value (undefined when no states were emitted) */
  finalState: S | undefined
  /** Captured JSON output lines */
  jsonOutput: string[]
  /** The exit value — inspect to check for success or failure */
  exit: Exit.Exit<unknown, E>
}

/**
 * Options for capturing output.
 */
export interface CaptureOptions {
  /** Capture console.log calls */
  captureLog?: boolean
  /** Capture console.error calls */
  captureError?: boolean
}

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Convert mode preset name to OutputMode value.
 */
export const modeFromTag = (preset: TestModePreset): OutputMode => {
  switch (preset) {
    case 'tty':
      return tty
    case 'ci':
      return ci
    case 'log':
      return log
    case 'fullscreen':
      return altScreen
    case 'json':
      return json
    case 'ndjson':
      return ndjson
  }
}

/**
 * Create a layer for a specific output mode.
 *
 * Binds the Effect Console service to the caller's global console so tests that
 * capture output by patching `console.log` see `Console.log` emissions
 * (@effect/vitest otherwise scopes tests to its own recording TestConsole).
 */
export const testModeLayer = (preset: TestModePreset): Layer.Layer<OutputModeTag> =>
  Layer.merge(
    Layer.succeed(OutputModeTag, modeFromTag(preset)),
    Layer.succeed(Console.Console, globalThis.console),
  )

/**
 * Run a command function with test utilities.
 *
 * Captures state changes and output, returning them for assertions.
 *
 * @example
 * ```typescript
 * const result = await runTestCommand({
 *   commandFn: (args) => runDeploy(args),
 *   options: { args: ['api-server'], mode: 'json', schema: DeployOutputSchema }
 * })
 *
 * expect(Exit.isSuccess(result.exit)).toBe(true)
 * expect(result.finalState?._tag).toBe('Complete')
 * ```
 */
export const runTestCommand = async <S, Args, E>({
  commandFn,
  options,
}: {
  commandFn: (args: Args) => Effect.Effect<unknown, E, OutputModeTag>
  options: RunTestCommandOptions<S, Args>
}): Promise<TestCommandResult<S, E>> => {
  const jsonOutput: string[] = []

  // Capture console.log for JSON output
  const originalLog = console.log
  console.log = (msg: string) => {
    jsonOutput.push(msg)
  }

  let exit: Exit.Exit<unknown, E>
  try {
    exit = await commandFn(options.args).pipe(
      Effect.provide(testModeLayer(options.mode)),
      Effect.runPromiseExit,
    )
  } finally {
    console.log = originalLog
  }

  // Parse and validate JSON output using schema
  const parsedStates = jsonOutput
    .map((line) => {
      const result = Schema.decodeExit(Schema.fromJsonString(options.schema))(line)
      return Exit.isSuccess(result) === true ? result.value : null
    })
    .filter((s): s is S => s !== null)

  return {
    states: parsedStates,
    finalState: parsedStates[parsedStates.length - 1],
    jsonOutput,
    exit,
  }
}

/**
 * Create a test version of TUI state that captures state changes and actions.
 *
 * @example
 * ```typescript
 * const { api, getStates, getActions } = await Effect.runPromise(
 *   createTestTuiState({
 *     stateSchema: CounterState,
 *     actionSchema: CounterAction,
 *     initial: { count: 0 },
 *     reducer: counterReducer,
 *   }).pipe(Effect.scoped)
 * )
 *
 * api.dispatch({ _tag: 'Increment' })
 * api.dispatch({ _tag: 'Increment' })
 *
 * expect(getStates()).toEqual([{ count: 0 }, { count: 1 }, { count: 2 }])
 * expect(getActions()).toHaveLength(2)
 * ```
 */
export const createTestTuiState = <S, A>(
  config: TuiAppConfig<S, A>,
): Effect.Effect<
  {
    api: TuiAppApi<S, A>
    getStates: () => S[]
    getActions: () => A[]
    getFinalState: () => S
  },
  never,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const { initial, reducer } = config
    // States array captures all state changes synchronously
    const states: S[] = [initial]
    const actions: A[] = []

    // Create atoms for state management
    const stateAtom = Atom.make(initial)
    const dispatchAtom = Atom.fnSync((action: A, get) => {
      const currentState = get(stateAtom)
      const newState = reducer({ state: currentState, action })
      get.set(stateAtom, newState)
    })
    const registry = AtomRegistry.make()

    const actionPubSub = yield* PubSub.unbounded<A>()
    const runtime = yield* Effect.context<never>()

    // Create sync dispatch function that captures states and actions directly
    const dispatch = (action: A): void => {
      // Update atom via registry
      registry.set(dispatchAtom, action)
      // Capture the new state synchronously
      const newState = registry.get(stateAtom)
      states.push(newState)
      // Capture the action
      actions.push(action)
      // Also publish to PubSub for the actions stream
      void Effect.runForkWith(runtime)(PubSub.publish(actionPubSub, action))
    }

    const api: TuiAppApi<S, A> = {
      dispatch,
      getState: () => registry.get(stateAtom),
      stateAtom,
      actions: Stream.fromPubSub(actionPubSub),
      unmount: () => Effect.void,
    }

    return {
      api,
      getStates: () => [...states],
      getActions: () => [...actions],
      getFinalState: () => states[states.length - 1]!,
    }
  })

/**
 * Capture console output during an effect.
 *
 * @example
 * ```typescript
 * const { output, errors } = await captureConsole({
 *   effect: Effect.gen(function* () {
 *     yield* Console.log('hello')
 *     yield* Console.error('oops')
 *   })
 * })
 *
 * expect(output).toContain('hello')
 * expect(errors).toContain('oops')
 * ```
 */
export const captureConsole = async <A, E, R>({
  effect,
  options = { captureLog: true, captureError: true },
}: {
  effect: Effect.Effect<A, E, R>
  options?: CaptureOptions
}): Promise<{ output: string[]; errors: string[]; result: A }> => {
  const output: string[] = []
  const errors: string[] = []

  const originalLog = console.log
  const originalError = console.error

  if (options.captureLog === true) {
    console.log = (...args: unknown[]) => {
      output.push(args.map(String).join(' '))
    }
  }

  if (options.captureError === true) {
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '))
    }
  }

  try {
    const result = await Effect.runPromise(effect as Effect.Effect<A, E, never>)
    return { output, errors, result }
  } finally {
    console.log = originalLog
    console.error = originalError
  }
}

/**
 * Assert that JSON output matches a schema.
 *
 * @example
 * ```typescript
 * const output = '{"_tag":"Complete","duration":1000}'
 * assertJsonMatchesSchema({ jsonString: output, schema: DeployState })
 * ```
 */
export const assertJsonMatchesSchema = <S,>({
  jsonString,
  schema,
}: {
  jsonString: string
  schema: Schema.Codec<S>
}): S => {
  return Schema.decodeSync(Schema.fromJsonString(schema))(jsonString)
}

/**
 * Create a mock view component that tracks renders.
 * The view uses hooks to access state.
 */
export const createMockView = <_S, _A>(): {
  View: () => null
  getRenderCount: () => number
} => {
  let renderCount = 0

  const View = (): null => {
    renderCount++
    return null
  }

  return {
    View,
    getRenderCount: () => renderCount,
  }
}
