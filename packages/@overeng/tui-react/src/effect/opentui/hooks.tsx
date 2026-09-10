/**
 * OpenTUI Integration Hooks
 *
 * Hooks for integrating Effect state management with OpenTUI components.
 * Bridges SubscriptionRef state and PubSub events with OpenTUI's hooks.
 *
 * **Usage:**
 * ```tsx
 * /** @jsxImportSource @opentui/react *\/
 *
 * import { useOState, useOKeyboard, useOResize } from '@overeng/tui-react/opentui'
 *
 * function Dashboard({ stateRef, eventPubSub }) {
 *   const state = useOState(stateRef)
 *   useOKeyboard(eventPubSub)
 *   useOResize(eventPubSub)
 *
 *   return <box>Current: {state.count}</box>
 * }
 * ```
 *
 * @module
 */

// Import types from our type declarations (works whether OpenTUI is installed or not)
import type { KeyEvent } from '@opentui/core'
import { Effect, Fiber, PubSub, Stream, SubscriptionRef } from 'effect'
import { useState, useEffect, useCallback, useRef } from 'react'

import { keyEvent, resizeEvent, type InputEvent } from '../events.ts'

// =============================================================================
// useOState - Subscribe to SubscriptionRef from OpenTUI component
// =============================================================================

/**
 * Subscribe to a SubscriptionRef and get reactive state updates.
 *
 * This hook bridges Effect's SubscriptionRef with React's state system,
 * allowing OpenTUI components to reactively update when state changes.
 *
 * @param ref - SubscriptionRef to subscribe to
 * @returns Current state value
 *
 * @example
 * ```tsx
 * function Counter({ stateRef }) {
 *   const count = useOState(stateRef)
 *   return <text>Count: {count}</text>
 * }
 * ```
 */
export const useOState = <S,>(ref: SubscriptionRef.SubscriptionRef<S>): S => {
  const [state, setState] = useState<S>(() => {
    // Get initial value synchronously
    return Effect.runSync(SubscriptionRef.get(ref))
  })

  useEffect(() => {
    // Subscribe to changes
    const fiber = Effect.runFork(
      SubscriptionRef.changes(ref).pipe(Stream.runForEach((s) => Effect.sync(() => setState(s)))),
    )

    return () => {
      void Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [ref])

  return state
}

// =============================================================================
// useOKeyboard - Bridge OpenTUI keyboard events to PubSub
// =============================================================================

/** Options for keyboard handler */
export interface UseOKeyboardOptions {
  /** Handle key release events (default: false) */
  release?: boolean
  /** Custom key handler (called in addition to PubSub publish) */
  onKey?: (key: KeyEvent) => void
}

/**
 * Bridge OpenTUI keyboard events to Effect PubSub.
 *
 * This hook must be used inside an OpenTUI component tree and requires
 * the `useKeyboard` hook from `@opentui/react` to be available.
 *
 * @param options.eventPubSub - PubSub to publish keyboard events to
 * @param options.options - Options for keyboard handling
 *
 * @example
 * ```tsx
 * function Dashboard({ eventPubSub }) {
 *   useOKeyboard({ eventPubSub })
 *   // ... keyboard events are now published to eventPubSub
 * }
 * ```
 */
export const useOKeyboard = ({
  eventPubSub,
  options = {},
}: {
  eventPubSub: PubSub.PubSub<InputEvent>
  options?: UseOKeyboardOptions
}): ((key: KeyEvent) => void) => {
  const { release: _release = false, onKey } = options ?? {}
  const pubSubRef = useRef(eventPubSub)
  pubSubRef.current = eventPubSub

  // We need to dynamically use OpenTUI's useKeyboard hook
  // This will only work inside an OpenTUI component tree
  useEffect(() => {
    // Check if we're in an OpenTUI context by trying to import
    import('@opentui/react')
      .then(() => {
        // The hook must be called at top level, so we can't dynamically call it
        // Instead, we document that users should use useKeyboard directly
        console.warn(
          "useOKeyboard: For best results, use OpenTUI's useKeyboard hook directly and call publishKeyEvent",
        )
      })
      .catch(() => {
        // OpenTUI not available, which is expected in non-Bun environments
      })
  }, [])

  const handleKey = useCallback(
    (key: KeyEvent) => {
      // Convert to our KeyEvent format and publish
      const event = keyEvent({
        key: key.name,
        ctrl: key.ctrl,
        alt: key.meta || key.option,
        shift: key.shift,
        meta: key.meta,
      })

      void Effect.runFork(PubSub.publish(pubSubRef.current, event))

      // Call custom handler if provided
      onKey?.(key)
    },
    [onKey],
  )

  // Hand the handler back to the caller. It used to be parked on the hook
  // function itself as an untyped `_handler` property, which nothing in the
  // tree ever read; returning it is the same capability, typed and reachable.
  return handleKey
}

/**
 * Create a keyboard event handler that publishes to PubSub.
 *
 * Use this with OpenTUI's useKeyboard hook directly:
 * ```tsx
 * import { useKeyboard } from '@opentui/react'
 * import { createKeyboardHandler } from '@overeng/tui-react/opentui'
 *
 * function Dashboard({ eventPubSub }) {
 *   useKeyboard(createKeyboardHandler({ eventPubSub }))
 * }
 * ```
 */
export const createKeyboardHandler = ({
  eventPubSub,
  onKey,
}: {
  eventPubSub: PubSub.PubSub<InputEvent>
  onKey?: (key: KeyEvent) => void
}): ((key: KeyEvent) => void) => {
  return (key: KeyEvent) => {
    const event = keyEvent({
      key: key.name,
      ctrl: key.ctrl,
      alt: key.meta || key.option,
      shift: key.shift,
      meta: key.meta,
    })

    void Effect.runFork(PubSub.publish(eventPubSub, event))
    onKey?.(key)
  }
}

// =============================================================================
// useOResize - Bridge OpenTUI resize events to PubSub
// =============================================================================

/**
 * Create a resize event handler that publishes to PubSub.
 *
 * Use this with OpenTUI's useOnResize hook directly:
 * ```tsx
 * import { useOnResize } from '@opentui/react'
 * import { createResizeHandler } from '@overeng/tui-react/opentui'
 *
 * function Dashboard({ eventPubSub }) {
 *   useOnResize(createResizeHandler({ eventPubSub }))
 * }
 * ```
 */
export const createResizeHandler = ({
  eventPubSub,
  onResize,
}: {
  eventPubSub: PubSub.PubSub<InputEvent>
  onResize?: (width: number, height: number) => void
}): ((width: number, height: number) => void) => {
  // oxlint-disable-next-line overeng/named-args -- callback signature required by external API
  return (width: number, height: number) => {
    const event = resizeEvent({ cols: width, rows: height })
    void Effect.runFork(PubSub.publish(eventPubSub, event))
    onResize?.(width, height)
  }
}

// =============================================================================
// useODispatch - Dispatch actions to update state
// =============================================================================

/**
 * Create a dispatch function for updating state via a reducer.
 *
 * @param options.ref - SubscriptionRef to update
 * @param options.reducer - Reducer function (state, action) => state
 * @returns Dispatch function
 *
 * @example
 * ```tsx
 * type Action = { type: 'increment' } | { type: 'decrement' }
 *
 * function Counter({ stateRef }) {
 *   const count = useOState(stateRef)
 *   const dispatch = useODispatch({
 *     ref: stateRef,
 *     reducer: ({ state, action }: { state: number; action: Action }) => {
 *       switch (action.type) {
 *         case 'increment': return state + 1
 *         case 'decrement': return state - 1
 *       }
 *     }
 *   })
 *
 *   return <text>Count: {count}</text>
 * }
 * ```
 */
export const useODispatch = <S, A>({
  ref,
  reducer,
}: {
  ref: SubscriptionRef.SubscriptionRef<S>
  reducer: (args: { state: S; action: A }) => S
}): ((action: A) => void) => {
  return useCallback(
    (action: A) => {
      void Effect.runFork(SubscriptionRef.update(ref, (state) => reducer({ state, action })))
    },
    [ref, reducer],
  )
}
