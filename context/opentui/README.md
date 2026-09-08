# OpenTUI Examples

Runnable examples demonstrating OpenTUI patterns for building terminal user interfaces with React.

## Understanding OpenTUI

OpenTUI is a React-based terminal UI library. It uses a custom React reconciler to render components to the terminal using flexbox-like layout. The core abstraction is a `CliRenderer` that manages terminal I/O and provides dimensions, keyboard input, and mouse events.

**Core concepts**

- `createCliRenderer()` creates the renderer that controls the terminal
- `createRoot(renderer)` creates a React root for rendering components
- Components use `<box>` for layout and `<text>` for content
- The renderer exposes `width`, `height`, and event emitters for input

**Layout model**

```
<box flexDirection="column" padding={1} gap={1}>
  <text>Header</text>
  <box flexDirection="row">
    <box width="50%"><text>Left</text></box>
    <box flexGrow={1}><text>Right</text></box>
  </box>
</box>
```

- `flexDirection`: "column" (vertical) or "row" (horizontal)
- `padding`: inner padding in characters
- `gap`: spacing between children
- `borderStyle`: "single" for box borders
- `height`: explicit height in rows (crucial for filling space)

**Important:** `<box flexDirection="row">` with multiple `<text>` children does NOT render them inline on the same line. Each `<text>` still renders on its own line. For side-by-side content, wrap each `<text>` in a `<box>` with width constraints. For multi-color text on a single line, use `StyledText` (see below).

**Text styling:** Use inline elements for text formatting:

```tsx
<text fg="cyan">
  <b>Bold text</b>, <i>italic</i>, <u>underline</u>
</text>
```

Available: `<b>`, `<strong>`, `<i>`, `<em>`, `<u>`

**Multi-color text on a single line:** Use `StyledText` with the `content` prop:

```tsx
import { t, green, yellow, bold, dim } from "@opentui/core"

// Build styled text with multiple colors
const styledText = t`${green("●")} ${bold("Hello")} ${dim("world")}`

// Pass via content prop (NOT as children)
<text content={styledText} />
```

Available style functions: `black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`, `bold`, `dim`, `italic`, `underline`, `strikethrough`, `bgRed`, `bgGreen`, etc.

**Important:** Do NOT pass `StyledText` as children - it will error with "Objects are not valid as a React child". Always use the `content` prop.

## Scrollable Content

Use `<scrollbox>` for content that exceeds the viewport:

```tsx
<box flexDirection="column" height={terminalHeight}>
  <text>Header (fixed)</text>

  <scrollbox flexGrow={1} scrollY={true} scrollX={false}>
    {/* Content taller than viewport will be scrollable */}
    <box flexDirection="column">
      {items.map((item) => (
        <text key={item.id}>{item.name}</text>
      ))}
    </box>
  </scrollbox>

  <text>Footer (fixed)</text>
</box>
```

**Key props:**

- `scrollY={true}` - Enable vertical scrolling
- `scrollX={true}` - Enable horizontal scrolling
- `flexGrow={1}` - Fill available space
- `stickyScroll={true}` - Auto-scroll to bottom when new content added

Mouse wheel scrolling works automatically. No manual scroll handling needed.

## Terminal Dimensions

**Problem:** `process.stdout.rows/columns` may return `undefined` when OpenTUI controls the terminal.

**Solution:** Get dimensions from the renderer:

```tsx
const renderer = await createCliRenderer()
console.log(renderer.width, renderer.height) // actual terminal size
```

**Reactive updates via resize event:**

```tsx
// CliRenderer extends EventEmitter but types don't expose it
;(renderer as unknown as NodeJS.EventEmitter).on('resize', () => {
  console.log('New size:', renderer.width, renderer.height)
})
```

**React hook pattern:**

```tsx
const useTerminalDimensions = (renderer: CliRenderer) => {
  const [dims, setDims] = useState({ width: renderer.width, height: renderer.height })

  useEffect(() => {
    const handler = () => setDims({ width: renderer.width, height: renderer.height })
    ;(renderer as unknown as NodeJS.EventEmitter).on('resize', handler)
    return () => {
      ;(renderer as unknown as NodeJS.EventEmitter).off('resize', handler)
    }
  }, [renderer])

  return dims
}
```

## Dynamic Height

**Problem:** Boxes only take the space their content needs by default.

**Solution:** Use explicit `height` prop to fill available space:

```tsx
// Won't fill available space
<box flexDirection="column">
  {items.map(item => <text>{item}</text>)}
</box>

// Will take exactly 20 rows
<box flexDirection="column" height={20}>
  {items.map(item => <text>{item}</text>)}
</box>
```

**Dynamic calculation pattern:**

```tsx
const App = () => {
  const { height } = useTerminalDimensions(renderer)

  // Account for fixed UI elements
  const fixedUi = 4 // header, footer, padding
  const listHeight = Math.max(5, height - fixedUi)

  return (
    <box flexDirection="column">
      <text>Header</text>
      <List maxItems={listHeight} />
      <text>Footer</text>
    </box>
  )
}
```

## Keyboard Input

```tsx
renderer.keyInput.on('keypress', (key: { name: string; ctrl: boolean }) => {
  if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
    cleanup()
  }
  if (key.name === 'up') {
    // handle up arrow
  }
})
```

## Effect Atoms Integration

For complex state, use `@effect-atom/atom` with OpenTUI:

```tsx
import { Registry } from '@effect-atom/atom'
import { RegistryContext, useAtomValue } from '@effect-atom/atom-react'
import { Atom } from '@effect-atom/atom'

const countAtom = Atom.make(0)

const App = () => {
  const count = useAtomValue(countAtom)
  return <text>Count: {count}</text>
}

const main = async () => {
  const renderer = await createCliRenderer()
  const root = createRoot(renderer)
  const registry = Registry.make()

  // CRITICAL: Subscribe to atoms to keep them alive
  registry.subscribe(countAtom, () => {})

  // Update atoms from keyboard handlers
  renderer.keyInput.on('keypress', (key) => {
    if (key.name === 'up') {
      registry.set(countAtom, registry.get(countAtom) + 1)
    }
  })

  root.render(
    <RegistryContext.Provider value={registry}>
      <App />
    </RegistryContext.Provider>,
  )
}
```

## Effect Runtime Integration

For async operations with dependency injection, combine atoms with Effect runtime:

```tsx
import { Effect, Layer, ManagedRuntime, Runtime, Fiber, Cause } from 'effect'

// Define a service
class MyService extends Effect.Service<MyService>()('MyService', {
  effect: Effect.succeed({ doWork: () => Effect.sleep('100 millis') }),
}) {}

// Create runtime from Layer
const AppLayer = Layer.mergeAll(MyService.Default)
const managedRuntime = ManagedRuntime.make(AppLayer)
const runtime = await Effect.runPromise(managedRuntime.runtimeEffect)

// Effect runner with error handling (pattern from @overeng/effect-react)
function createEffectRunner(
  runtime: Runtime.Runtime<MyService>,
  onError: (cause: Cause.Cause<never>) => void,
) {
  return (effect: Effect.Effect<void, never, MyService>) => {
    const fiber = effect.pipe(
      Effect.tapErrorCause((cause) => Effect.sync(() => onError(cause))),
      Effect.withSpan('ui.effect', { root: true }),
      Runtime.runFork(runtime),
    )
    // Return cancel function
    return () => Effect.runFork(Fiber.interrupt(fiber))
  }
}

// Use in keyboard handler
renderer.keyInput.on('keypress', (key) => {
  if (key.name === 'space') {
    runEffect(
      Effect.gen(function* () {
        registry.set(statusAtom, 'loading')
        const svc = yield* MyService
        yield* svc.doWork()
        registry.set(statusAtom, 'done')
      }).pipe(Effect.withSpan('my.action')),
    )
  }
})
```

**Key patterns:**

- `ManagedRuntime` handles Layer lifecycle
- Effect runner wraps effects with spans and error handling
- Atoms bridge Effect results to React state
- Cancel function enables cleanup on unmount

## Cleanup

Always clean up properly:

```tsx
const cleanup = () => {
  root.unmount()
  renderer.destroy()
  process.stdin.pause() // OpenTUI bug: destroy() doesn't pause stdin
  registry?.dispose()
}
```

## TTY Detection

Only use TUI in interactive terminals:

```tsx
const isTTY = () => Boolean(process.stdout.isTTY && process.stderr.isTTY)

if (isTTY()) {
  // Use TUI renderer
} else {
  // Use console/log renderer for CI
}
```

## Examples

**Simple counter**

```bash
bun examples/simple-counter.tsx
```

Basic OpenTUI + React with auto-incrementing counter.

**Dynamic height**

```bash
bun examples/dynamic-height.tsx
```

Demonstrates terminal dimension handling and resize events. Resize your terminal to see the list adjust.

**Effect atoms + keyboard**

```bash
bun examples/effect-atoms-keyboard.tsx
```

Shows Effect integration with ManagedRuntime, Layer-based DI, atoms for reactive state, and structured effect execution with spans. Use ↑/↓ to change count, r to reset, q to quit.

## Quickstart

```bash
bun install
bun examples/simple-counter.tsx
```
