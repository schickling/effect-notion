/**
 * Root API for creating and managing a React tree in the terminal.
 *
 * This is analogous to ReactDOM.createRoot() but for terminal output.
 */

import React, { type ReactElement } from 'react'

import {
  InlineRenderer,
  resolveTerminal,
  type Terminal,
  type TerminalLike,
  type ExitMode,
} from '@overeng/tui-core'

import { ViewportProvider, type Viewport } from './hooks/useViewport.tsx'
import { renderTreeSimple, extractStaticContent } from './reconciler/output.ts'
import {
  TuiReconciler,
  flushPendingMicrotasks,
  type TuiContainer,
} from './reconciler/reconciler.ts'
import type { TuiStaticElement } from './reconciler/types.ts'
import { isStaticElement } from './reconciler/types.ts'
import { calculateLayout } from './reconciler/yoga-utils.ts'
import { truncateLines } from './truncate.ts'

// =============================================================================
// Types
// =============================================================================

/** Options for createRoot */
export interface CreateRootOptions {
  /**
   * Minimum milliseconds between renders.
   * Helps prevent excessive rendering for high-frequency state updates.
   * @default 16 (~60fps)
   */
  readonly throttleMs?: number

  /**
   * Maximum lines for the dynamic region.
   * Content exceeding this will be truncated with a "... N more lines" indicator.
   * @default 100
   */
  readonly maxDynamicLines?: number

  /**
   * Maximum lines to keep in the static region buffer.
   * Older lines are discarded when exceeded.
   * Set to Infinity to keep all lines (default).
   * @default Infinity
   */
  readonly maxStaticLines?: number
}

/** Options for unmount */
export interface UnmountOptions {
  /**
   * Exit mode controlling what happens to rendered output.
   * - `persist` (default): Keep all output visible (final render stays)
   * - `clear`: Remove all output (both static and dynamic)
   * - `clearDynamic`: Keep static logs, clear dynamic region
   */
  mode?: ExitMode
}

/** Root instance for rendering React elements to the terminal */
export interface Root {
  /** Render a React element */
  render: (element: ReactElement) => void
  /**
   * Unmount the React tree and cleanup.
   * @param options - Options controlling exit behavior
   */
  unmount: (options?: UnmountOptions) => void
  /**
   * Flush any pending renders synchronously.
   * Use this before unmount to ensure all state changes are rendered.
   */
  flush: () => void
  /**
   * Notify the root that the terminal has resized.
   * Triggers a re-render which will self-correct if dimensions changed.
   * Call this from ResizeObserver (browser) or process.stdout.on('resize') (Node).
   */
  resize: () => void
  /** Current viewport dimensions */
  readonly viewport: Viewport
}

// =============================================================================
// Implementation
// =============================================================================

/** Depth-first search for the first Static element in a rendered tree. */
const findStaticElement = (
  node: TuiStaticElement | { children?: unknown[] },
): TuiStaticElement | null => {
  if (isStaticElement(node as TuiStaticElement) === true) {
    return node as TuiStaticElement
  }
  if ('children' in node && Array.isArray(node.children) === true) {
    for (const child of node.children) {
      const found = findStaticElement(child as { children?: unknown[] })
      if (found !== null) return found
    }
  }
  return null
}

/**
 * Create a root for rendering React elements to the terminal.
 *
 * @example
 * ```tsx
 * const root = createRoot(process.stdout)
 * root.render(<App />)
 *
 * // Later, cleanup
 * root.unmount()
 * ```
 *
 * @example With options
 * ```tsx
 * const root = createRoot(process.stdout, {
 *   throttleMs: 32,        // ~30fps max
 *   maxDynamicLines: 50,   // Truncate if > 50 lines
 * })
 * ```
 */
export const createRoot = ({
  terminalOrStream,
  options = {},
}: {
  terminalOrStream: Terminal | TerminalLike
  options?: CreateRootOptions
}): Root => {
  const { throttleMs = 16, maxDynamicLines = 100, maxStaticLines = Infinity } = options

  // Resolve terminal interface once, share with renderer
  const terminal = resolveTerminal(terminalOrStream)
  const renderer = new InlineRenderer({ terminal })

  // Viewport state
  let viewport: Viewport = {
    columns: terminal.columns,
    rows: terminal.rows,
  }

  // Throttling state
  let lastRenderTime = 0
  let pendingRender = false
  let renderScheduled = false

  // Static line tracking (for maxStaticLines and viewport height calculation)
  let staticLineCount = 0

  // Track if disposed (to prevent rendering after unmount)
  let disposed = false

  // Track last rendered width for self-correcting resize detection
  let lastRenderedWidth = terminal.columns

  // Track last rendered element for re-rendering in flush
  let lastRenderedElement: ReactElement | null = null

  // Auto-rerender on terminal resize (Node.js only).
  // Listen on the passed stream when it exposes an `on`/`off` pair (i.e. a
  // Node `WriteStream`). Previously this was hardcoded to `process.stdout`,
  // which silently ignored resizes when the caller rendered to e.g.
  // `process.stderr`.
  const resizeHandler = () => {
    if (disposed === false) scheduleRender()
  }
  const streamMaybe = terminalOrStream as { on?: Function; off?: Function }
  const resizeEmitter =
    typeof streamMaybe.on === 'function' && typeof streamMaybe.off === 'function'
      ? (streamMaybe as {
          on: (ev: string, fn: () => void) => void
          off: (ev: string, fn: () => void) => void
        })
      : null
  if (resizeEmitter !== null) {
    resizeEmitter.on('resize', resizeHandler)
  }

  // Microtask batching for render scheduling.
  // React's reconciler can trigger multiple commit phases for a single update
  // (e.g., empty commit → remove element → create new element). By batching
  // renders via microtask, we ensure we only render once after React completes
  // all its work for the current update cycle.
  let microtaskScheduled = false

  // Container that holds the root of the tree
  const container: TuiContainer = {
    root: null,
    onRender: () => {
      if (disposed === true) return

      // Use microtask batching to ensure React completes all commit phases
      // before we render. Without this, we might render intermediate states
      // (e.g., empty container during a recreate operation).
      if (microtaskScheduled === false) {
        microtaskScheduled = true
        queueMicrotask(() => {
          microtaskScheduled = false
          if (disposed === false) {
            scheduleRender()
          }
        })
      }
    },
  }

  // Cast reconciler to include methods that exist at runtime but are missing from
  // @types/react-reconciler. These are stable React internals used by Ink and other
  // custom renderers for synchronous rendering control.
  const reconciler = TuiReconciler as typeof TuiReconciler & {
    /** Synchronously update the container (unlike updateContainer which is async) */
    updateContainerSync: typeof TuiReconciler.updateContainer
    /** Flush all pending synchronous work */
    flushSyncWork: () => void
    /** Flush passive effects (useEffect, useSyncExternalStore subscriptions) */
    flushPassiveEffects: () => boolean
  }

  // Create the fiber root
  const fiberRoot = reconciler.createContainer(
    container,
    0, // LegacyRoot
    null, // hydrationCallbacks
    false, // isStrictMode
    null, // concurrentUpdatesByDefaultOverride
    '', // identifierPrefix
    () => {}, // onUncaughtError
    () => {}, // onCaughtError
    () => {}, // onRecoverableError
    () => {}, // onDefaultTransitionIndicator
  )

  /** Find Static element and reset its committedCount for full re-render */
  const resetStaticCommittedCount = (): void => {
    if (container.root === null) return

    const staticEl = findStaticElement(container.root as unknown as { children?: unknown[] })
    if (staticEl !== null) {
      staticEl.committedCount = 0
    }
  }

  /** Schedule a render with throttling */
  const scheduleRender = (): void => {
    if (disposed === true) return

    if (throttleMs <= 0) {
      // No throttling
      doRender()
      return
    }

    const now = Date.now()
    const elapsed = now - lastRenderTime

    if (elapsed >= throttleMs) {
      // Enough time has passed, render immediately
      doRender()
      lastRenderTime = now
      pendingRender = false
    } else if (renderScheduled === false) {
      // Schedule render for later
      renderScheduled = true
      pendingRender = true
      setTimeout(() => {
        renderScheduled = false
        if (pendingRender === true) {
          doRender()
          lastRenderTime = Date.now()
          pendingRender = false
        }
      }, throttleMs - elapsed)
    } else {
      // Already scheduled, just mark as pending
      pendingRender = true
    }
  }

  /** Perform the actual render */
  const doRender = (): void => {
    if (container.root === null) {
      renderer.render([])
      return
    }

    // Update viewport (terminal might have resized)
    viewport = {
      columns: terminal.columns,
      rows: terminal.rows,
    }

    const width = viewport.columns

    // Self-correcting resize detection: if width changed, reset everything
    // This prevents ghost lines from differential rendering with stale positions
    if (width !== lastRenderedWidth) {
      lastRenderedWidth = width
      resetStaticCommittedCount()
      staticLineCount = 0
      renderer.reset()
    }

    // Handle static content first (before computing budget so staticLineCount is up to date)
    const staticResult = extractStaticContent({ root: container.root, width })
    if (staticResult.lines.length > 0) {
      let linesToAppend = staticResult.lines

      // Apply maxStaticLines limit
      if (maxStaticLines !== Infinity) {
        const newTotal = staticLineCount + linesToAppend.length
        if (newTotal > maxStaticLines) {
          const allowedNew = Math.max(0, maxStaticLines - staticLineCount)
          if (allowedNew < linesToAppend.length) {
            linesToAppend = linesToAppend.slice(-allowedNew)
          }
        }
      }

      if (linesToAppend.length > 0) {
        const truncatedStaticLines = truncateLines({ lines: linesToAppend, width })
        renderer.appendStatic(truncatedStaticLines)
      }

      staticLineCount += linesToAppend.length
      if (maxStaticLines !== Infinity) {
        staticLineCount = Math.min(staticLineCount, maxStaticLines)
      }

      if (staticResult.element !== null && isStaticElement(staticResult.element) === true) {
        ;(staticResult.element as TuiStaticElement).committedCount = staticResult.newItemCount
      }
    }

    // Compute hard budget: rows - 1 (for trailing cursor line) - static lines consumed.
    // This is the superconsole pattern (saturating_sub).
    const effectiveMaxLines = Math.min(
      maxDynamicLines,
      Math.max(1, viewport.rows - 1 - staticLineCount),
    )

    // Calculate layout with height constraint so yoga can distribute space
    // via flexShrink (large sections shrink, fixed elements keep their lines).
    calculateLayout({ node: container.root.yogaNode, width, height: effectiveMaxLines })

    // Render to lines. Both maxLines and yoga height clipping enforce the budget.
    let lines = renderTreeSimple({ root: container.root, width, maxLines: effectiveMaxLines })

    // Safety net: hard-truncate if lines still exceed budget (should rarely trigger
    // with yoga constraint + render clipping, but catches edge cases).
    if (lines.length > effectiveMaxLines) {
      const hiddenCount = lines.length - effectiveMaxLines + 1
      lines = lines.slice(0, effectiveMaxLines - 1)
      lines.push(`... ${hiddenCount} more line${hiddenCount > 1 ? 's' : ''}`)
    }

    // Truncate lines horizontally to prevent soft wrapping.
    lines = truncateLines({ lines, width })

    renderer.render(lines)
  }

  /** Wrap element with viewport provider */
  const wrapWithProviders = (element: ReactElement): ReactElement => {
    return React.createElement(
      ViewportProvider,
      {
        viewport,
        onResize: (newViewport: Viewport) => {
          viewport = newViewport
        },
      },
      element,
    )
  }

  /**
   * Flush pending React work and render the current state synchronously.
   *
   * This is critical for progressive output modes (tty, ci) where we need to ensure
   * all state changes are reflected in the output before unmounting. The flush process:
   *
   * 1. Flush passive effects (useEffect, useSyncExternalStore subscriptions)
   * 2. Flush sync work and microtasks
   * 3. Re-render to pick up any state changes triggered by effects
   * 4. Render to terminal
   */
  const doFlush = (): void => {
    if (disposed === true) return

    // Flush React work repeatedly. React's reconciler can schedule work across
    // multiple phases (sync work, passive effects, microtasks). We need to keep
    // flushing until all work is complete.
    for (let i = 0; i < 20; i++) {
      reconciler.flushPassiveEffects()
      reconciler.flushSyncWork()
      flushPendingMicrotasks()
    }

    // Re-render to pick up state changes from effects (e.g., useSyncExternalStore
    // subscriptions or useEffect callbacks that called setState).
    if (lastRenderedElement !== null) {
      reconciler.updateContainerSync(
        wrapWithProviders(lastRenderedElement),
        fiberRoot,
        null,
        () => {},
      )
      for (let i = 0; i < 20; i++) {
        reconciler.flushPassiveEffects()
        reconciler.flushSyncWork()
        flushPendingMicrotasks()
      }
    }

    // Cancel any pending throttled/microtask-batched render since we're rendering now
    pendingRender = false
    renderScheduled = false
    microtaskScheduled = false

    // Render the React tree to terminal output
    doRender()
    lastRenderTime = Date.now()
  }

  return {
    render: (element: ReactElement) => {
      // Store for re-rendering in flush()
      lastRenderedElement = element
      // Use updateContainerSync for synchronous rendering
      // This ensures the render completes before returning, which is needed
      // for proper flush behavior in progressive modes
      reconciler.updateContainerSync(wrapWithProviders(element), fiberRoot, null, () => {})
      reconciler.flushSyncWork()
    },
    unmount: (unmountOptions?: UnmountOptions) => {
      // Flush pending React work and render final state before unmounting
      // This ensures all dispatched state updates are visible in the output
      doFlush()

      // Mark as disposed to prevent any more renders
      disposed = true
      // Remove resize listener from the stream we attached to.
      if (resizeEmitter !== null) {
        resizeEmitter.off('resize', resizeHandler)
      }
      // Dispose renderer (preserves content for persist mode)
      renderer.dispose({ mode: unmountOptions?.mode ?? 'persist' })
      // Clean up React internals (won't trigger render due to disposed flag)
      reconciler.updateContainerSync(null, fiberRoot, null, () => {})
      reconciler.flushSyncWork()
    },
    flush: doFlush,
    resize: () => {
      // Just schedule a render - doRender() will detect the width change
      // and self-correct by resetting state if needed
      if (disposed === false) scheduleRender()
    },
    get viewport() {
      return viewport
    },
  }
}
