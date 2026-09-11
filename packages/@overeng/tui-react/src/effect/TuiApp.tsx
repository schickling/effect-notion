/**
 * TuiApp - Factory pattern for TUI applications
 *
 * Creates a reusable TUI app definition that separates state configuration
 * from view rendering. Uses effect-atom for reactive state management.
 *
 * @example
 * ```typescript
 * // 1. Define the app (reusable, no View coupling)
 * const DeployApp = createTuiApp({
 *   stateSchema: DeployState,
 *   actionSchema: DeployAction,
 *   initial: { _tag: 'Idle' },
 *   reducer: deployReducer,
 * })
 *
 * // 2. View uses atoms directly (types inferred!)
 * const DeployView = () => {
 *   const state = useTuiAtomValue(DeployApp.stateAtom)
 *   return <Box><Text>{state._tag}</Text></Box>
 * }
 *
 * // 3. Run with handler callback (scope managed internally)
 * yield* run(DeployApp, (tui) =>
 *   Effect.gen(function* () {
 *     tui.dispatch({ _tag: 'Start' })
 *   }),
 *   { view: <DeployView /> }
 * )
 *
 * // Or run headless (JSON modes, testing)
 * yield* run(DeployApp, (tui) =>
 *   Effect.gen(function* () {
 *     tui.dispatch({ _tag: 'Start' })
 *   })
 * )
 * ```
 *
 * @module
 */

import type { Scope } from 'effect'
import {
  Cause,
  Console,
  Context,
  Effect,
  Function as Fn,
  Layer,
  Logger,
  PubSub,
  Schema,
  Stream,
} from 'effect'
import { Atom, AtomRegistry } from 'effect/unstable/reactivity'
import React, { type ReactElement, type ReactNode, createContext } from 'react'

import { renderToString } from '../renderToString.ts'
import { createRoot, type Root } from '../root.tsx'
import { useContext, useSyncExternalStore, useCallback } from './hooks.tsx'
import { CapturedLogsProvider, type LogCaptureHandle } from './LogCapture.ts'
import {
  OutputModeTag,
  type OutputMode,
  type RenderConfig,
  RenderConfigProvider,
  ViewOutputStreamTag,
  stripAnsi,
} from './OutputMode.tsx'

// =============================================================================
// TuiApp TypeId (for dual API dispatch)
// =============================================================================

/** Type brand for TuiApp instances, used by the dual `run` API for dispatch. */
export const TuiAppTypeId: unique symbol = Symbol.for('@overeng/tui-react/TuiApp')

/** Type brand for TuiApp instances. */
export type TuiAppTypeId = typeof TuiAppTypeId

/** Check if a value is a TuiApp instance. */
export const isTuiApp = (u: unknown): u is TuiApp<unknown, unknown> =>
  typeof u === 'object' && u !== null && TuiAppTypeId in u

/** Internal tag to skip mode-specific output when standalone run() handles output */
const SkipModeOutputTag = Context.Reference<boolean>('@overeng/tui-react/SkipModeOutput', {
  defaultValue: () => false,
})

// =============================================================================
// TUI Registry Context (avoids multiple React instance issues with @effect-atom/atom-react)
// =============================================================================

/**
 * Context for providing the TUI registry to components.
 * Uses our own React instance to avoid context sharing issues with @effect-atom/atom-react.
 */
export const TuiRegistryContext = createContext<AtomRegistry.AtomRegistry | null>(null)

/**
 * Hook to get an atom's value from the TUI registry.
 * This is a workaround for multiple React instance issues with @effect-atom/atom-react.
 *
 * Uses useSyncExternalStore for proper React 18+ integration.
 *
 * @example
 * ```tsx
 * const state = useTuiAtomValue(MyApp.stateAtom)
 * ```
 */
export const useTuiAtomValue = <T,>(atom: Atom.Atom<T>): T => {
  const registry = useContext(TuiRegistryContext)
  if (registry === null) {
    throw new Error(
      'useTuiAtomValue must be used within a TUI component. ' +
        'Make sure your component is rendered by TuiApp.run().',
    )
  }

  // Use useSyncExternalStore for proper React integration
  const subscribe = useCallback(
    (callback: () => void) => {
      // Registry.subscribe returns an unsubscribe function
      const unsubscribe = registry.subscribe(atom, callback)
      return unsubscribe
    },
    [atom, registry],
  )

  const getSnapshot = useCallback(() => registry.get(atom), [atom, registry])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

// =============================================================================
// Types
// =============================================================================

/**
 * Exit mode for TUI unmount behavior.
 */
export type ExitMode = 'persist' | 'clear' | 'clearDynamic'

/**
 * Options for TuiAppApi.unmount()
 */
export interface UnmountOptions {
  /**
   * Exit mode controlling what happens to rendered output.
   * - `persist` (default for inline): Keep all output visible
   * - `clear`: Remove all output
   * - `clearDynamic`: Keep static logs, clear dynamic region
   */
  readonly mode?: ExitMode
}

/**
 * Configuration for creating a TUI app.
 * Does not include View - that's passed at run time.
 */
export interface TuiAppConfig<S, A> {
  /**
   * Effect Schema for state serialization (used in JSON modes).
   */
  readonly stateSchema: Schema.Codec<S>

  /**
   * Effect Schema for action serialization (for debugging/logging).
   * If includes Schema.TaggedStruct('Interrupted', {}), system auto-dispatches on Ctrl+C.
   */
  readonly actionSchema: Schema.Schema<A>

  /**
   * Initial state value.
   */
  readonly initial: S

  /**
   * Pure reducer function: ({ state, action }) => newState
   */
  readonly reducer: (args: { state: S; action: A }) => S

  /**
   * Optional function to determine process exit code based on final state.
   * Called on unmount - if returns a number, sets process.exitCode.
   * If returns undefined, exit code is not modified.
   *
   * @example
   * ```typescript
   * exitCode: (state) => {
   *   if (state._tag === 'Error') return 1
   *   if (state._tag === 'Interrupted') return 130  // Standard SIGINT
   *   return 0
   * }
   * ```
   */
  readonly exitCode?: (state: S) => number | undefined

  /**
   * Optional NDJSON event configuration.
   * When provided and in progressive JSON (NDJSON) mode, emits mapped events
   * per action instead of full state snapshots on every change.
   */
  readonly ndjson?: NdjsonConfig<S, A, any>
}

/**
 * Configuration for event-based NDJSON output.
 * Maps each dispatched action to zero or more typed events for the NDJSON stream.
 *
 * The event type `E` is inferred from `eventSchema` at the call site —
 * `fromAction`'s return type is checked against it by TypeScript.
 */
export interface NdjsonConfig<in S, in A, E> {
  /** Schema for encoding output events */
  readonly eventSchema: Schema.Codec<E>
  /** Map an action + previous state to zero or more output events */
  readonly fromAction: (args: { action: A; prevState: S }) => ReadonlyArray<E>
}

// =============================================================================
// TuiApp API Types
// =============================================================================

/**
 * API returned by TuiApp.run() for interacting with state.
 */
export interface TuiAppApi<S, A> {
  /**
   * Dispatch an action synchronously.
   */
  readonly dispatch: (action: A) => void

  /**
   * Get current state synchronously.
   */
  readonly getState: () => S

  /**
   * The state atom for advanced use.
   */
  readonly stateAtom: Atom.Writable<S>

  /**
   * Stream of dispatched actions (for logging/debugging).
   */
  readonly actions: Stream.Stream<A>

  /**
   * Explicitly unmount the TUI with optional exit mode.
   * If not called, unmount happens when scope closes with default mode.
   */
  readonly unmount: (options?: UnmountOptions) => Effect.Effect<void>
}

/**
 * A TUI application definition with atoms for state management.
 */
export interface TuiApp<S, A> {
  readonly [TuiAppTypeId]: TuiAppTypeId

  /**
   * Atom containing the current state. Use with `useTuiAtomValue(App.stateAtom)`.
   */
  readonly stateAtom: Atom.Writable<S>

  /**
   * Run the app, optionally rendering a view.
   *
   * @param view - Optional React element to render (for visual modes)
   * @returns Effect yielding the state API
   *
   * @example
   * ```typescript
   * // With view (progressive-visual mode)
   * const tui = yield* MyApp.run(<MyView />)
   *
   * // Headless (JSON modes or testing)
   * const tui = yield* MyApp.run()
   * ```
   */
  readonly run: (
    view?: ReactElement,
  ) => Effect.Effect<TuiAppApi<S, A>, never, Scope.Scope | OutputModeTag>

  /**
   * The app configuration (useful for testing).
   */
  readonly config: TuiAppConfig<S, A>
}

// =============================================================================
// Helpers for Interrupted detection
// =============================================================================

/**
 * Check if an Effect Schema has an 'Interrupted' variant (TaggedStruct with _tag: 'Interrupted').
 */
const hasInterruptedVariant = <A,>(schema: Schema.Schema<A>): boolean => {
  const ast = schema.ast

  // Check if it's a Union
  if (ast._tag !== 'Union') {
    return false
  }

  // Check each variant in the union
  return ast.types.some((type) => {
    // We're looking for an Objects node with a _tag property set to 'Interrupted'
    if (type._tag !== 'Objects') {
      return false
    }

    // Find the _tag property
    const tagProperty = type.propertySignatures.find((prop) => prop.name === '_tag')
    if (tagProperty === undefined) {
      return false
    }

    // Check if it's a Literal with value 'Interrupted'
    const tagType = tagProperty.type
    if (tagType._tag !== 'Literal') {
      return false
    }

    return tagType.literal === 'Interrupted'
  })
}

/**
 * Create an Interrupted action value if the schema supports it.
 */
const createInterruptedAction = <A,>(schema: Schema.Schema<A>): A | null => {
  if (hasInterruptedVariant(schema) === false) {
    return null
  }
  // Create the Interrupted action
  return { _tag: 'Interrupted' } as A
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a TUI application with effect-atom state management.
 *
 * @param config - App configuration (state schema, reducer, initial state)
 * @returns TuiApp instance with atoms and run() method
 *
 * @example
 * ```typescript
 * const CounterApp = createTuiApp({
 *   stateSchema: Schema.Struct({ count: Schema.Number }),
 *   actionSchema: Schema.Union([
 *     Schema.TaggedStruct('Inc', {}),
 *     Schema.TaggedStruct('Dec', {}),
 *   ]),
 *   initial: { count: 0 },
 *   reducer: ({ state, action }) => {
 *     switch (action._tag) {
 *       case 'Inc': return { count: state.count + 1 }
 *       case 'Dec': return { count: state.count - 1 }
 *     }
 *   },
 * })
 *
 * // View uses atoms directly
 * const CounterView = () => {
 *   const state = useTuiAtomValue(CounterApp.stateAtom)
 *   return (
 *     <Box>
 *       <Text>Count: {state.count}</Text>
 *     </Box>
 *   )
 * }
 *
 * // Run the app
 * const tui = yield* CounterApp.run(<CounterView />)
 * tui.dispatch({ _tag: 'Inc' })
 * ```
 */
export const createTuiApp = <S, A>(config: TuiAppConfig<S, A>): TuiApp<S, A> => {
  const { initial, reducer } = config

  // Create atoms at app definition time (shared across all runs)
  const stateAtom = Atom.make(initial)
  const dispatchAtom = Atom.fnSync((action: A, get) => {
    const currentState = get(stateAtom)
    const newState = reducer({ state: currentState, action })
    get.set(stateAtom, newState)
  })

  // Create a registry for this app
  const registry = AtomRegistry.make()

  // Check once if schema has Interrupted variant
  const interruptedAction = createInterruptedAction(config.actionSchema)
  const runApp = (
    view?: ReactElement,
  ): Effect.Effect<TuiAppApi<S, A>, never, Scope.Scope | OutputModeTag> =>
    Effect.gen(function* () {
      const mode = yield* OutputModeTag
      const { stateSchema } = config

      // Each run starts from the configured initial state: the module-level atom
      // may still carry mutations from a previous run's session.
      registry.set(stateAtom, initial)

      // Mount stateAtom to prevent registry GC between async operations.
      // Without this, the atom node can be removed via microtask when nothing
      // subscribes (e.g. json mode), causing registry.get() to return stale initial values.
      const unmountAtom = registry.mount(stateAtom)
      yield* Effect.addFinalizer(() => Effect.sync(unmountAtom))

      // Create action PubSub for streaming
      const actionPubSub = yield* PubSub.unbounded<A>()
      const runtime = yield* Effect.context<never>()

      // Mutable ref for NDJSON event emitter (set after setupMode when ndjson config is active)
      let eventEmitterRef: ((args: { action: A; prevState: S }) => void) | undefined

      // Sync dispatch function that updates the atom and publishes to PubSub
      const dispatch = (action: A): void => {
        const prevState = eventEmitterRef !== undefined ? registry.get(stateAtom) : undefined
        // Update atom synchronously via registry
        registry.set(dispatchAtom, action)
        // Emit NDJSON events if configured
        if (eventEmitterRef !== undefined) eventEmitterRef({ action, prevState: prevState! })
        // Also publish to PubSub for action stream
        void Effect.runForkWith(runtime)(PubSub.publish(actionPubSub, action))
      }

      // Track root for manual unmount
      let rootRef: Root | null = null
      let exitMode: ExitMode = 'persist' // default for inline

      /**
       * Apply exit code based on final state if exitCode mapper is configured.
       */
      const applyExitCode = (): void => {
        if (config.exitCode !== undefined) {
          const finalState = registry.get(stateAtom)
          const code = config.exitCode(finalState)
          if (code !== undefined) {
            process.exitCode = code
          }
        }
      }

      /**
       * Unmount the TUI and render final output.
       *
       * State updates are synchronous via effect-atom.
       */
      const unmount = (options?: UnmountOptions): Effect.Effect<void> =>
        Effect.sync(() => {
          if (options?.mode !== undefined) {
            exitMode = options.mode
          }
          if (rootRef !== null) {
            rootRef.unmount({ mode: exitMode })
            rootRef = null
          }
          // Apply exit code based on final state
          applyExitCode()
        })

      // Create API
      const api: TuiAppApi<S, A> = {
        dispatch,
        getState: () => registry.get(stateAtom),
        stateAtom,
        actions: Stream.fromPubSub(actionPubSub),
        unmount,
      }

      // Check if mode output should be skipped (set by standalone run() with output schema)
      const skipModeOutput = yield* SkipModeOutputTag

      // Setup mode-specific behavior (only when not using explicit output schema on run())
      if (skipModeOutput === false) {
        const setupResult = yield* setupMode({
          mode,
          stateAtom,
          stateSchema,
          registry,
          view,
          ndjsonConfig: config.ndjson,
        })
        rootRef = setupResult.root
        eventEmitterRef = setupResult.eventEmitter
      }

      // Add finalizer for cleanup
      yield* Effect.addFinalizer((exit) =>
        Effect.sync(() => {
          // Only dispatch Interrupted when the fiber was actually interrupted (e.g. Ctrl+C),
          // not on normal scope close. Without this check, normal exits get exitCode 130.
          if (
            interruptedAction != null &&
            exit._tag === 'Failure' &&
            Cause.hasInterruptsOnly(exit.cause) === true
          ) {
            dispatch(interruptedAction)
          }
          // Unmount with current exit mode
          if (rootRef !== null) {
            rootRef.unmount({ mode: exitMode })
            rootRef = null
          }
          // Apply exit code based on final state
          applyExitCode()
        }),
      )

      return api
    })

  return {
    [TuiAppTypeId]: TuiAppTypeId,
    stateAtom,
    run: runApp,
    config,
  }
}

// =============================================================================
// Mode Setup
// =============================================================================

interface SetupModeResult {
  readonly root: Root | null
  /** When set, called from dispatch() to emit NDJSON events instead of full state snapshots */
  readonly eventEmitter: ((args: { action: any; prevState: any }) => void) | undefined
}

const setupMode = <S,>({
  mode,
  stateAtom,
  stateSchema,
  registry,
  view,
  ndjsonConfig,
}: {
  mode: OutputMode
  stateAtom: Atom.Writable<S>
  stateSchema: Schema.Codec<S>
  registry: AtomRegistry.AtomRegistry
  view?: ReactElement | undefined
  ndjsonConfig?: NdjsonConfig<S, any, any> | undefined
}): Effect.Effect<SetupModeResult, never, Scope.Scope> => {
  // Handle based on output format
  if (mode._tag === 'react') {
    if (mode.timing === 'progressive') {
      // Progressive React rendering (inline or fullscreen)
      if (view !== undefined) {
        return setupProgressiveVisualWithView({
          registry,
          view,
          renderConfig: mode.render,
          ...(mode.capturedLogs !== undefined ? { capturedLogs: mode.capturedLogs } : {}),
        }).pipe(Effect.map((root) => ({ root, eventEmitter: undefined })))
      }
      return Effect.succeed({ root: null, eventEmitter: undefined })
    } else {
      // Final React rendering (single output at end)
      return setupFinalVisualWithAtom({
        view,
        registry,
        renderConfig: mode.render,
      }).pipe(Effect.as({ root: null, eventEmitter: undefined }))
    }
  } else {
    // JSON modes
    if (mode.timing === 'progressive') {
      if (ndjsonConfig !== undefined) {
        return setupProgressiveJsonWithEvents({
          stateAtom,
          stateSchema,
          registry,
          ndjsonConfig,
        }).pipe(Effect.map((emitter) => ({ root: null, eventEmitter: emitter })))
      }
      return setupProgressiveJsonWithAtom({
        stateAtom,
        stateSchema,
        registry,
      }).pipe(Effect.as({ root: null, eventEmitter: undefined }))
    } else {
      return setupFinalJsonWithAtom({ stateAtom, stateSchema, registry }).pipe(
        Effect.as({ root: null, eventEmitter: undefined }),
      )
    }
  }
}

const setupProgressiveVisualWithView = ({
  registry,
  view,
  renderConfig,
  capturedLogs,
}: {
  registry: AtomRegistry.AtomRegistry
  view: ReactElement
  renderConfig: RenderConfig
  capturedLogs?: LogCaptureHandle
}): Effect.Effect<Root, never, Scope.Scope> =>
  Effect.gen(function* () {
    // Default to stdout when no explicit view stream is provided (e.g. interactive
    // `run`). `runResult` overrides this to stderr to keep stdout clean for the
    // result payload.
    const viewStream = yield* ViewOutputStreamTag
    const root = createRoot({ terminalOrStream: viewStream })

    // Wrapper that provides Registry via our own context (avoids multiple React instance issues)
    const TuiAppWrapper = (): ReactNode => {
      let content: ReactNode = (
        <RenderConfigProvider config={renderConfig}>{view}</RenderConfigProvider>
      )

      // Wrap with captured logs provider if log capture is active
      if (capturedLogs !== undefined) {
        content = <CapturedLogsProvider handle={capturedLogs}>{content}</CapturedLogsProvider>
      }

      return <TuiRegistryContext.Provider value={registry}>{content}</TuiRegistryContext.Provider>
    }

    root.render(<TuiAppWrapper />)

    // Clean up root when scope closes
    yield* Effect.addFinalizer(() => Effect.sync(() => root.unmount()))

    return root
  })

// =============================================================================
// Atom-based mode setup functions
// =============================================================================

/**
 * Final visual mode with atoms: Render to string on scope close.
 */
const setupFinalVisualWithAtom = ({
  view,
  registry,
  renderConfig,
}: {
  view: ReactElement | undefined
  registry: AtomRegistry.AtomRegistry
  renderConfig: RenderConfig
}): Effect.Effect<void, never, Scope.Scope> => {
  if (view === undefined) return Effect.void

  return Effect.gen(function* () {
    // Resolve the view output stream up-front so the finalizer writes to the
    // correct channel. `runResult` binds this to stderr; other callers default
    // to stdout.
    const viewStream = yield* ViewOutputStreamTag

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        // Wrapper component that provides registry context (using our own context)
        const RegistryWrapper = ({ children }: { children: ReactNode }): ReactElement => (
          <TuiRegistryContext.Provider value={registry}>
            <RenderConfigProvider config={renderConfig}>{children}</RenderConfigProvider>
          </TuiRegistryContext.Provider>
        )

        const element = <RegistryWrapper>{view}</RegistryWrapper>

        // Render to string
        const output = yield* Effect.promise(() => renderToString({ element }))

        // Strip ANSI codes if colors are disabled
        const finalOutput = renderConfig.colors === true ? output : stripAnsi(output)

        // Write to the resolved view stream (stdout by default, stderr for `runResult`).
        viewStream.write(finalOutput + '\n')
      }).pipe(Effect.orDie),
    )
  })
}

/**
 * Final JSON mode: emit the final state as a single raw JSON line on scope close.
 *
 * No envelope — exit code signals success/failure; the state itself carries
 * any per-item/per-field error details via its schema. This matches how
 * `curl -w`, `jq`, `gh ... --json`, and `kubectl ... -o json` behave: data on
 * stdout, exit code is the truth source, error messaging on stderr.
 *
 * We emit on every exit (success or failure) so consumers always have a final
 * observable state; `formatError` handles stderr for failure details.
 */
const setupFinalJsonWithAtom = <S,>({
  stateAtom,
  stateSchema,
  registry,
}: {
  stateAtom: Atom.Writable<S>
  stateSchema: Schema.Codec<S>
  registry: AtomRegistry.AtomRegistry
}): Effect.Effect<void, never, Scope.Scope> =>
  Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const finalState = registry.get(stateAtom)
      const jsonString = yield* Schema.encodeEffect(Schema.fromJsonString(stateSchema))(finalState)
      yield* Console.log(jsonString)
    }).pipe(Effect.orDie),
  )

/**
 * Progressive JSON mode: stream every state change as an NDJSON line.
 *
 * Contract: initial snapshot + each state change. No trailing envelope line —
 * EOF + exit code signal completion. Consumers read the final line as the
 * authoritative end state.
 */
const setupProgressiveJsonWithAtom = <S,>({
  stateAtom,
  stateSchema,
  registry,
}: {
  stateAtom: Atom.Writable<S>
  stateSchema: Schema.Codec<S>
  registry: AtomRegistry.AtomRegistry
}): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const runtime = yield* Effect.context<never>()

    // Initial snapshot for bootstrapping.
    const initialState = registry.get(stateAtom)
    const initialJson = yield* Schema.encodeEffect(Schema.fromJsonString(stateSchema))(
      initialState,
    ).pipe(Effect.orDie)
    yield* Console.log(initialJson)

    // Subscribe to subsequent state changes.
    const unsubscribe = registry.subscribe(stateAtom, (state) => {
      Effect.runSyncWith(runtime)(
        Schema.encodeEffect(Schema.fromJsonString(stateSchema))(state).pipe(
          Effect.flatMap((jsonString) => Console.log(jsonString)),
          Effect.orDie,
        ),
      )
    })

    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))
  })

/**
 * Progressive JSON mode with event mapping: emit mapped events per action.
 *
 * Contract:
 *   - Line 1: initial full state snapshot (bootstrapping).
 *   - Intermediate lines: events from `ndjsonConfig.fromAction(...)`.
 *   - No trailing envelope — EOF + exit code signal completion.
 *
 * Returns the emitter callback invoked from `dispatch()`.
 */
const setupProgressiveJsonWithEvents = <S, E>({
  stateAtom,
  stateSchema,
  registry,
  ndjsonConfig,
}: {
  stateAtom: Atom.Writable<S>
  stateSchema: Schema.Codec<S>
  registry: AtomRegistry.AtomRegistry
  ndjsonConfig: NdjsonConfig<S, any, E>
}): Effect.Effect<(args: { action: any; prevState: S }) => void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const runtime = yield* Effect.context<never>()
    const { eventSchema, fromAction } = ndjsonConfig

    const initialState = registry.get(stateAtom)
    const initialJson = yield* Schema.encodeEffect(Schema.fromJsonString(stateSchema))(
      initialState,
    ).pipe(Effect.orDie)
    yield* Console.log(initialJson)

    const emitter = ({ action, prevState }: { action: any; prevState: S }): void => {
      const events = fromAction({ action, prevState })
      for (const event of events) {
        Effect.runSyncWith(runtime)(
          Schema.encodeEffect(Schema.fromJsonString(eventSchema))(event).pipe(
            Effect.flatMap((jsonString) => Console.log(jsonString)),
            Effect.orDie,
          ),
        )
      }
    }

    return emitter
  })

// =============================================================================
// Helper
// =============================================================================

/**
 * Create a typed app config. Useful for type inference at definition site.
 */
export const tuiAppConfig = <S, A>(config: TuiAppConfig<S, A>): TuiAppConfig<S, A> => config

// =============================================================================
// Standalone run (dual API)
// =============================================================================

/**
 * Options for `run`.
 */
export interface TuiAppRunOptions {
  /**
   * Optional React element to render in visual modes.
   * Omit for headless mode (JSON modes, testing).
   */
  readonly view?: ReactElement
}

// oxlint-disable-next-line overeng/named-args -- dual API pattern requires positional args
const runImpl = <S, A, B, E, R>(
  app: TuiApp<S, A>,
  handler: (api: TuiAppApi<S, A>) => Effect.Effect<B, E, R>,
  options?: TuiAppRunOptions,
): Effect.Effect<B, E, R | OutputModeTag> =>
  Effect.scoped(app.run(options?.view).pipe(Effect.flatMap(handler)))

/**
 * Run a TuiApp with a handler callback. State/view is the contract.
 *
 * Use this for state-driven commands where the TUI state machine IS the output
 * (e.g., dashboards, interactive TUIs). In JSON modes, the final state is
 * serialized via `stateSchema` on scope close; NDJSON mode streams every state
 * change. Exit code signals overall success/failure; error details go to
 * stderr via `formatError`.
 *
 * For result-oriented commands (where the handler returns a value and the state
 * machine is just visual scaffolding), use `runResult` instead.
 *
 * @example
 * ```typescript
 * yield* run(DeployApp, (tui) =>
 *   Effect.gen(function* () {
 *     tui.dispatch({ _tag: 'Start' })
 *   }),
 *   { view: <DeployView stateAtom={DeployApp.stateAtom} /> }
 * )
 * ```
 */
export const run: {
  // Data-last (pipeable): run(handler, options?) returns (app) => Effect
  <S, A, B, E, R>(
    handler: (api: TuiAppApi<S, A>) => Effect.Effect<B, E, R>,
    options?: TuiAppRunOptions,
  ): (app: TuiApp<S, A>) => Effect.Effect<B, E, R | OutputModeTag>

  // Data-first: run(app, handler, options?) returns Effect
  <S, A, B, E, R>(
    app: TuiApp<S, A>,
    handler: (api: TuiAppApi<S, A>) => Effect.Effect<B, E, R>,
    options?: TuiAppRunOptions,
  ): Effect.Effect<B, E, R | OutputModeTag>
} = Fn.dual((args) => isTuiApp(args[0]), runImpl)

// =============================================================================
// runResult — Result-oriented command execution
// =============================================================================

/**
 * Options for `runResult`.
 */
export interface RunResultOptions<O> {
  /** Schema for the command's result type (the handler's return value). */
  readonly result: Schema.Codec<O>
  /** Optional React element to render in visual modes. */
  readonly view?: ReactElement
}

/** Check if schema resolves to a plain string type */
const isStringSchema = (schema: Schema.Schema<unknown>): boolean => schema.ast._tag === 'String'

/**
 * Build an Effect `Console` service bound to a single Node `WriteStream`.
 *
 * Used by `runResult` to route handler-emitted `Console.log`/`.info`/
 * `.warn`/… to stderr so they don't contaminate the stdout result channel.
 * Wraps Node's built-in `console.Console` (which already understands the full
 * Console surface).
 */
const consoleOnStream = (stream: NodeJS.WriteStream): Effect.Effect<Console.Console> =>
  Effect.promise(async () => {
    // Platform boundary: browser stories import TuiApp but never execute its Node CLI path.
    const { Console: NodeConsole } = await import('node:console')
    return new NodeConsole({ stdout: stream, stderr: stream })
  })

/** Write a value to stdout using the appropriate format for its schema type.
 *  Strings are written raw (no JSON encoding). Structured types are JSON-encoded.
 *
 *  Writes straight to fd 1 via {@link writeStdoutSync} rather than going through
 *  the Effect `Console` service, since `runResult` rebinds that service to
 *  stderr for handler-emitted logs — we need the result itself to land on stdout
 *  regardless. The synchronous write also keeps the result intact when the CLI
 *  exits non-zero; see {@link writeStdoutSync} for why buffered writes truncate.
 */
const writeStdout = ({
  text,
  trailingNewline,
}: {
  readonly text: string
  readonly trailingNewline: boolean
}): Effect.Effect<void> =>
  Effect.promise(async () => {
    // Platform boundary: keep node:fs and SharedArrayBuffer out of browser module evaluation.
    const stdout = await import('./stdout.node.ts')
    if (trailingNewline === true) stdout.writeStdoutLineSync(text)
    else stdout.writeStdoutSync(text)
  })

const writeResult = <O,>({
  value,
  schema,
}: {
  value: O
  schema: Schema.Codec<O>
}): Effect.Effect<void> =>
  isStringSchema(schema as Schema.Schema<unknown>) === true
    ? Effect.suspend(() => {
        const text = String(value)
        return writeStdout({
          text: text.length > 0 && text.endsWith('\n') === false ? `${text}\n` : text,
          trailingNewline: false,
        })
      })
    : Schema.encodeEffect(Schema.fromJsonString(schema))(value).pipe(
        Effect.flatMap((json) => writeStdout({ text: json, trailingNewline: true })),
        Effect.orDie,
      )

// oxlint-disable-next-line overeng/named-args -- dual API pattern requires positional args
const runResultImpl = <S, A, O, E, R>(
  app: TuiApp<S, A>,
  handler: (api: TuiAppApi<S, A>) => Effect.Effect<O, E, R>,
  options: RunResultOptions<O>,
): Effect.Effect<O, E, R | OutputModeTag> =>
  Effect.gen(function* () {
    const mode = yield* OutputModeTag

    // Result-oriented commands do not support state streaming.
    // ndjson streams intermediate state changes, which contradicts the result-first contract.
    if (mode._tag === 'json' && mode.timing === 'progressive') {
      return yield* Effect.die(
        new Error(
          'runResult does not support ndjson (state streaming). ' +
            'Result-oriented commands produce a single output value. ' +
            'Use run() with App.run() for streamed state output.',
        ),
      )
    }

    // Unified contract (Unix stdout/stderr split):
    // - stdout always receives the handler's return value, via `writeResult`.
    // - The TUI view, if any, renders to stderr. This keeps the result stream
    //   safe for `$(...)`, redirects, and pipelines regardless of TTY state.
    // - Handler-emitted logs (`Effect.log`, `Effect.logInfo`, …) and console
    //   output (`Effect.Console.log`, …) likewise route to stderr. In visual
    //   `log` mode (final React, no log capture) this used to leak onto stdout
    //   and contaminate the byte-clean result.
    //
    // The stderr bindings are provided locally so callers don't need extra
    // plumbing at the main site — `runResult`'s contract is self-contained.
    // `Logger.LogToStderr` is what actually moves `consolePretty` output off
    // stdout; it prints itself and returns `void`, so wrapping it in
    // `Logger.withConsoleError` would leave the pretty line on stdout and add a
    // stray `undefined` line on stderr.
    const stderrConsole = yield* consoleOnStream(process.stderr)

    const stderrSideChannelLayer = Layer.mergeAll(
      Layer.succeed(ViewOutputStreamTag, process.stderr),
      Logger.layer([Logger.consolePretty()], { mergeWithExisting: false }),
      Layer.succeed(Logger.LogToStderr, true),
      Layer.succeed(Console.Console, stderrConsole),
    )

    const innerEffect =
      mode._tag === 'react'
        ? Effect.scoped(app.run(options.view).pipe(Effect.flatMap(handler)))
        : Effect.scoped(
            app.run().pipe(Effect.provideService(SkipModeOutputTag, true), Effect.flatMap(handler)),
          )

    const result = yield* innerEffect.pipe(Effect.provide(stderrSideChannelLayer))

    yield* writeResult({ value: result, schema: options.result })

    return result
  })

/**
 * Run a TuiApp where the handler's return value is the contract.
 *
 * Use this for result-oriented commands where the TUI state machine is visual
 * scaffolding and the handler produces the actual output (e.g., `op-proxy read`
 * returns a secret string, `op-proxy list` returns an items array).
 *
 * Stdout/stderr contract (all non-ndjson modes):
 *   - **stdout**: the handler's return value, serialized via `options.result`.
 *     `Schema.String` → raw string (no JSON quotes).
 *     Structured schemas → JSON-encoded.
 *   - **stderr**: the optional `view`, if provided and the mode is visual.
 *     Routed via `ViewOutputStreamTag` so redirects of stdout never capture
 *     the rendered view.
 *
 * This makes `cmd > file`, `cmd | ...`, and `TOKEN="$(cmd)"` safe and
 * composable regardless of TTY state.
 *
 * In ndjson mode: fails loudly (result-oriented commands don't support state streaming).
 *
 * @example
 * ```typescript
 * // Value command — raw string in machine mode
 * yield* runResult(RequestApp, (tui) =>
 *   Effect.gen(function* () {
 *     tui.dispatch({ _tag: 'SetWaiting' })
 *     const secret = yield* fetchSecret()
 *     tui.dispatch({ _tag: 'SetApproved', output: secret })
 *     return secret
 *   }),
 *   { result: Schema.String, view: <RequestView /> },
 * )
 *
 * // Collection command — JSON array in machine mode
 * yield* runResult(ListApp, (tui) =>
 *   Effect.gen(function* () {
 *     const items = yield* fetchItems()
 *     tui.dispatch({ _tag: 'SetItems', items })
 *     return items
 *   }),
 *   { result: Schema.Array(ItemSchema), view: <ListView /> },
 * )
 * ```
 */
export const runResult: {
  // Data-last (pipeable)
  <S, A, O, E, R>(
    handler: (api: TuiAppApi<S, A>) => Effect.Effect<O, E, R>,
    options: RunResultOptions<O>,
  ): (app: TuiApp<S, A>) => Effect.Effect<O, E, R | OutputModeTag>

  // Data-first
  <S, A, O, E, R>(
    app: TuiApp<S, A>,
    handler: (api: TuiAppApi<S, A>) => Effect.Effect<O, E, R>,
    options: RunResultOptions<O>,
  ): Effect.Effect<O, E, R | OutputModeTag>
} = Fn.dual((args) => isTuiApp(args[0]), runResultImpl)
