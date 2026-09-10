/**
 * TuiRenderer Effect Service.
 *
 * Provides an Effect-based API for rendering React components to the terminal.
 * Handles resource management (cursor visibility, cleanup) automatically.
 *
 * @example
 * ```typescript
 * const program = Effect.gen(function* () {
 *   const tui = yield* TuiRenderer
 *
 *   yield* tui.render(<App />)
 *
 *   // Do work...
 *   yield* Effect.sleep('5 seconds')
 *
 *   yield* tui.unmount
 * })
 *
 * // Run with the live layer
 * program.pipe(
 *   Effect.provide(TuiRenderer.live),
 *   Effect.runPromise
 * )
 * ```
 */

import type { Scope } from 'effect'
import { Context, Effect, Layer } from 'effect'
import type { ReactElement } from 'react'

import type { Terminal, TerminalLike } from '@overeng/tui-core'

import { createRoot, type Root } from '../root.tsx'

// oxlint-disable react/rules-of-hooks -- Context.Service `.use` accessors are Effect v4 service requests, not React hooks

// =============================================================================
// Service Interface
// =============================================================================

/**
 * TuiRenderer service interface.
 */
export interface TuiRendererService {
  /**
   * Render a React element to the terminal.
   * Can be called multiple times to update the UI.
   */
  readonly render: (element: ReactElement) => Effect.Effect<void>

  /**
   * Append content to the static region (above dynamic content).
   * Useful for logging that should persist above progress indicators.
   */
  readonly appendStatic: (lines: readonly string[]) => Effect.Effect<void>

  /**
   * Unmount the React tree and cleanup resources.
   * Shows cursor, clears dynamic region.
   */
  readonly unmount: Effect.Effect<void>

  /**
   * The underlying React root instance.
   */
  readonly root: Root
}

// =============================================================================
// Service Tag
// =============================================================================

/**
 * TuiRenderer service tag for Effect dependency injection.
 *
 * @example
 * ```typescript
 * const program = Effect.gen(function* () {
 *   const tui = yield* TuiRenderer
 *   yield* tui.render(<MyApp />)
 * })
 * ```
 */
export class TuiRenderer extends Context.Service<TuiRenderer, TuiRendererService>()('TuiRenderer') {
  /**
   * Render a React element to the terminal.
   */
  static render = (element: ReactElement): Effect.Effect<void, never, TuiRenderer> =>
    TuiRenderer.use((r) => r.render(element))

  /**
   * Append content to the static region.
   */
  static appendStatic = (lines: readonly string[]): Effect.Effect<void, never, TuiRenderer> =>
    TuiRenderer.use((r) => r.appendStatic(lines))

  /**
   * Unmount the React tree.
   */
  static unmount: Effect.Effect<void, never, TuiRenderer> = TuiRenderer.use((r) => r.unmount)

  /**
   * Create a scoped layer that manages the TuiRenderer lifecycle.
   *
   * The renderer is automatically cleaned up when the scope closes.
   *
   * @param terminal - Terminal or stream to render to (defaults to process.stdout)
   */
  static scoped = (
    terminal?: Terminal | TerminalLike,
  ): Layer.Layer<TuiRenderer, never, Scope.Scope> =>
    Layer.effect(
      TuiRenderer,
      Effect.gen(function* () {
        const target = terminal ?? process.stdout
        const root = createRoot({ terminalOrStream: target })

        // Register cleanup when scope closes
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            root.unmount()
          }),
        )

        return {
          render: (element: ReactElement) =>
            Effect.sync(() => {
              root.render(element)
            }),

          appendStatic: (_lines: readonly string[]) =>
            // Note: appendStatic is handled internally by the Static component
            // This is a no-op placeholder for direct static content injection
            Effect.void,

          unmount: Effect.sync(() => {
            root.unmount()
          }),

          root,
        }
      }),
    )

  /**
   * Create a layer that uses process.stdout.
   * Automatically cleans up when the scope closes.
   */
  static live: Layer.Layer<TuiRenderer, never, Scope.Scope> = TuiRenderer.scoped()
}
