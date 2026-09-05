# tui-react Specification

> Terminal UI rendering for Effect-based CLI commands.

## Overview

CLI commands need to output to different contexts: interactive terminals, CI pipelines, scripted automation. This spec defines how commands expose state and how renderers consume it, enabling a single command implementation to work across all output modes.

**Core insight:** Decouple command logic from rendering by making state explicit and observable.

---

## Principles

### P1: State-First Design

Commands model state explicitly using Effect Schema. State is the single source of truth for all renderers.

### P2: Renderer-Agnostic Commands

Command implementation does not know which renderer will display output. Commands produce state; renderers consume it.

### P3: Schema-Driven Data

All state and events are defined with Effect Schema. JSON output uses `Schema.encode`, not `JSON.stringify`.

### P4: Bidirectional Communication

State flows down (command → renderer). Events flow up (renderer → command).

### P5: Modal Consistency

Output stays within its modality. JSON mode outputs only JSON, even for errors.

### P6: Graceful Degradation

Progressive rendering falls back to final output in non-TTY environments. Interactive falls back to passive.

### P7: Semantic Over Visual

JSON output represents semantic domain data, not visual structure.

---

## Output Modes

### Mode Dimensions

Output behavior is determined by a `RenderConfig` with these properties:

| Property      | Values           | Description                                      |
| ------------- | ---------------- | ------------------------------------------------ |
| **timing**    | `live` / `final` | Updates over time vs single output at completion |
| **animation** | `true` / `false` | Whether spinners/progress animate                |
| **colors**    | `true` / `false` | Whether ANSI color codes are used                |
| **altScreen** | `true` / `false` | Full-screen takeover vs inline                   |

### Available Modes

| Mode         | Timing | Animation | Colors | Alt Screen | Use Case                       |
| ------------ | ------ | --------- | ------ | ---------- | ------------------------------ |
| `tty`        | live   | ✓         | ✓      | ✗          | Interactive terminal (default) |
| `alt-screen` | live   | ✓         | ✓      | ✓          | Fullscreen TUI, dashboards     |
| `ci`         | live   | ✗         | ✓      | ✗          | CI with colors                 |
| `ci-plain`   | live   | ✗         | ✗      | ✗          | CI without colors              |
| `pipe`       | final  | ✗         | ✓      | ✗          | Piping to another command      |
| `log`        | final  | ✗         | ✗      | ✗          | Log files, plain output        |
| `json`       | final  | -         | -      | -          | Final JSON for scripting       |
| `ndjson`     | live   | -         | -      | -          | Streaming NDJSON               |

### Mode Selection

**CLI Option:** Commands use `--output` / `-o` to select the mode:

```bash
# Auto-detect from environment (default)
deploy                           # TTY → tty, Pipe → pipe, CI=true → ci

# Explicit mode selection
deploy --output tty              # Interactive with animations
deploy --output json             # Final JSON for scripting
deploy --output ndjson           # Streaming NDJSON
```

**Auto-detection:** When `--output auto` (the default):

- `TUI_VISUAL=1` → forces visual React mode (overrides all below)
- Coding agent detected → `json` (structured output agents can parse)
- TTY → `tty`
- TTY + `CI` env → `ci`
- Non-TTY + piped to process → `json` (machine-readable for downstream tools)
- Non-TTY + redirected to file → `pipe` (visual output for file storage)
- `NO_COLOR` environment variable → removes colors from detected mode
- `NO_UNICODE` environment variable → removes unicode from detected mode
- `TUI_PIPE_MODE=visual` → forces `pipe` mode (React output) in piped scenarios

**Agent detection:** Commands automatically detect when they're being executed by a coding agent (e.g. Claude Code, OpenCode, Amp, Cline, Codex CLI) by checking for well-known environment variables these tools inject into their shell sessions. The most prominent signal is the `AGENT` env var — a convention adopted by multiple tools (OpenCode sets `AGENT=1`, Amp sets `AGENT=amp`). When an agent is detected, the output defaults to `json` so the agent receives structured, machine-readable data instead of visual terminal output. This can be overridden with `TUI_VISUAL=1` or an explicit `--output` flag.

**Pipe detection:** When stdout is not a TTY, commands distinguish between two scenarios using `fs.fstatSync(1)`:

- **Piped to process** (`cmd | cat`): `isFIFO() = true` → defaults to `json` mode, assuming the consumer is another program that wants structured data
- **Redirected to file** (`cmd > file.txt`): `isFile() = true` → uses `pipe` mode, preserving visual output suitable for human review

This can be overridden with `TUI_PIPE_MODE=visual` to force React visual output even when piped, useful for commands like `cmd | less -R`.

**Validation & Fallbacks:**

- `alt-screen` + non-TTY → Falls back to `pipe`
- `tty` + non-TTY → Falls back to `pipe`
- `alt-screen` + Node.js (no OpenTUI) → Falls back to `tty`

### Mode Specifications

#### `tty` (Live Visual)

Real-time visual updates within terminal scrollback. Default for interactive terminals.

**Use cases:** Progress bars, sync status, build output

**Behavior:**

- Renders updates as state changes (subscribes to state changes)
- Static region for persistent logs above dynamic content
- Throttled renders to prevent terminal flooding (default: 16ms / ~60fps)
- Hidden cursor during rendering, restored on exit
- Synchronized output (CSI 2026) for flicker-free updates

**Constraints:**

- No input handling (passive mode)
- Content must fit within viewport (see [Viewport Constraints](#viewport-constraints))
- Static content cannot be "unwritten" once rendered

**Example output:**

```
[deploy] Validating configuration...   ← Static
[deploy] Configuration valid           ← Static
● Deploying 2/4 services               ← Dynamic (updates in place)
  ✓ api-server (healthy)
  ◐ web-client (starting)
```

#### `alt-screen` (Fullscreen TUI)

Full-screen interactive application using alternate screen buffer. **Implemented via [OpenTUI](https://github.com/anomalyco/opentui)**.

**Use cases:** Dashboards, file browsers, interactive selection

**Runtime Requirements:**

- **Bun runtime required** - OpenTUI uses native bindings
- Install: `bun add @opentui/core @opentui/react`

**Behavior:**

- Enters alternate screen buffer on start, exits on unmount
- Renders to fixed viewport dimensions (full terminal)
- Handles keyboard input via `useKeyboard` hook
- Handles terminal resize via `useOnResize` hook

**Constraints:**

- Requires TTY (cannot work in pipes)
- Must restore original screen on exit
- No scrollback (alternate buffer is isolated)
- Different component set than inline mode

#### `ci` and `ci-plain` (CI Modes)

Live visual output optimized for CI environments.

| Mode       | Colors | Description         |
| ---------- | ------ | ------------------- |
| `ci`       | ✓      | CI with ANSI colors |
| `ci-plain` | ✗      | Plain text only     |

**Behavior:**

- Live updates (timing: `live`)
- No cursor manipulation or screen clearing
- No spinners (animation disabled)

#### `pipe` and `log` (Final Visual)

Single visual output rendered at command completion.

| Mode   | Colors | Description                              |
| ------ | ------ | ---------------------------------------- |
| `pipe` | ✓      | Final output with colors (for `less -R`) |
| `log`  | ✗      | Final output without colors              |

**Behavior:**

- Waits for command completion (final state)
- Renders final state once to stdout
- No cursor manipulation

#### `json` (Final JSON)

Structured JSON output at command completion.

**Use cases:** Scripting, CI integration, tool chaining (`jq`)

**Behavior:**

- Waits for command completion
- Outputs single JSON object to stdout
- Uses `Schema.encode` for serialization
- **All logging goes to stderr** (keeps stdout clean for JSON parsing)

**Constraints:**

- Strict JSON only: no plain text, no ANSI codes on stdout
- Single output: exactly one JSON object per invocation
- Errors as JSON: errors must be JSON, not plain text
- Newline terminated
- **stdout = data only**: No log messages, progress indicators, or error traces on stdout

**Stream Contract:**

| Stream   | Content                            |
| -------- | ---------------------------------- |
| `stdout` | JSON data only (single object)     |
| `stderr` | Log messages, errors, debug output |

**Format:**

```json
{
  "_tag": "Complete",
  "services": [{ "name": "api-server", "result": "updated", "duration": 1024 }],
  "totalDuration": 3421
}
```

#### `ndjson` (Streaming JSON)

Streaming JSON output (NDJSON format) as state changes.

**Use cases:** Real-time monitoring, log aggregation, agent consumption

**Behavior:**

- Outputs one JSON object per line as state changes
- Uses `Schema.encode` for each state emission
- Flushes after each line for real-time streaming
- **All logging goes to stderr** (keeps stdout clean for JSON parsing)

**Stream Contract:**

| Stream   | Content                                |
| -------- | -------------------------------------- |
| `stdout` | JSON lines only (one per state change) |
| `stderr` | Log messages, errors, debug output     |

**Default format (full state snapshots):**

```
{"_tag":"Progress","service":"api-server","phase":"pulling"}
{"_tag":"Progress","service":"api-server","phase":"healthy"}
{"_tag":"Complete","services":[...],"duration":3421}
```

**Event-based format (with `NdjsonConfig`):**

When `createTuiApp` is configured with a `ndjson` option, intermediate lines
emit mapped events instead of full state snapshots. This reduces output size
for apps with large state that changes incrementally (e.g. CI monitors, deploy tools).

```typescript
const App = createTuiApp({
  stateSchema,
  actionSchema,
  initial,
  reducer,
  ndjson: {
    eventSchema: MyEvent,
    fromAction: ({ action, prevState }) => [
      /* events */
    ],
  },
})
```

Stream contract with events:

```
Line 1 (initial):   {"count":0}                         ← full state snapshot
Line 2 (event):     {"_tag":"Incremented","newCount":1}  ← event from fromAction
Line 3 (event):     {"_tag":"Incremented","newCount":2}  ← event from fromAction
Line 4 (final):     {"_tag":"Success","count":2}         ← wrapped final state
```

- **Line 1**: Full state snapshot (for consumer bootstrapping)
- **Intermediate lines**: Events produced by `fromAction({ action, prevState })`
- **Final line**: `Success`/`Failure` wrapper with full state (unchanged)

### Log Capture (Progressive Modes)

In progressive-visual modes (`tty`, `ci`, `ci-plain`, `alt-screen`), accidental `console.log` or `Effect.log` calls would corrupt TUI terminal output by writing directly to stdout/stderr. To prevent this, `outputModeLayer()` automatically captures all log output for these modes.

**What gets captured:**

| Source                   | Captured | Original destination            |
| ------------------------ | -------- | ------------------------------- |
| `Effect.log()`           | Yes      | stdout (default logger)         |
| `Effect.logDebug()`      | Yes      | stdout (default logger)         |
| `Effect.logWarning()`    | Yes      | stdout (default logger)         |
| `Effect.logError()`      | Yes      | stdout (default logger)         |
| `console.log()`          | Yes      | stdout                          |
| `console.info()`         | Yes      | stdout                          |
| `console.debug()`        | Yes      | stdout                          |
| `console.warn()`         | Yes      | stderr                          |
| `console.error()`        | Yes      | stderr                          |
| `process.stdout.write()` | No       | stdout (TUI renderer uses this) |

**How it works:**

1. `outputModeLayer()` creates a scoped `LogCaptureHandle` for progressive modes
2. The Effect default logger is replaced with a capturing logger
3. All `console.*` methods are overridden to capture instead of print
4. Captured entries are stored in a `SubscriptionRef<readonly TuiLogEntry[]>`
5. React components access captured logs via `useCapturedLogs()` hook
6. On scope finalization, original console methods are restored

> **Note:** Only one log capture may be active per process. Overlapping or nested captures are not supported.

**Stream contract for progressive-visual modes:**

| Stream   | Content                                                      |
| -------- | ------------------------------------------------------------ |
| `stdout` | TUI renderer output only (via `process.stdout.write`)        |
| `stderr` | Empty for Effect logs + console (native writes not captured) |
| Captured | Effect logs + console output (via `useCapturedLogs()`)       |

**Rendering captured logs:**

```tsx
import { useCapturedLogs, Static, Text } from '@overeng/tui-react'

function MyView({ stateAtom }) {
  const state = useTuiAtomValue(stateAtom)
  const logs = useCapturedLogs()

  return (
    <>
      <Static items={logs}>
        {(log) => (
          <Text key={log.id} dim>
            [{log.level}] {log.message}
          </Text>
        )}
      </Static>
      <Text>Dynamic content: {state.count}</Text>
    </>
  )
}
```

**Mode-specific behavior:**

| Mode category               | Log behavior                          |
| --------------------------- | ------------------------------------- |
| Progressive React           | Captured → `useCapturedLogs()` (auto) |
| JSON (`json`, `ndjson`)     | Redirected to stderr (unchanged)      |
| Final React (`pipe`, `log`) | No capture (single render at end)     |

---

## Architecture

### Data Flow

State management uses Effect Atom with an Elm-style reducer pattern:

```
┌─────────────────────────────────────────────────────────────────┐
│                        Command Logic                             │
│                        (Effect.gen)                              │
│                                                                  │
│   tui.dispatch({ _tag: 'SetProgress', services: [...] })        │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                    yield* DeployApp.run(<View stateAtom={...} />)
                                │
                                ▼
                    ┌───────────────────────────────┐
                    │       createTuiApp            │
                    │                               │
                    │   stateAtom ◀── reducer(s,a) │
                    │       │                       │
                    │       ▼                       │
                    │   useTuiAtomValue(stateAtom)  │
                    │                               │
                    │   actionStream ──▶ command   │
                    └───────────────┬───────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    │                               │
                    ▼                               ▼
          ┌─────────────────┐           ┌─────────────────┐
          │  Visual Modes   │           │   JSON Modes    │
          │  (React render) │           │  (Schema.encode)│
          └─────────────────┘           └─────────────────┘
```

**Atom-based views enable:**

- Same view component in CLI, Storybook, and tests
- No `connected-view.tsx` wrapper needed
- Fine-grained reactivity - propagate atoms down, materialize late with `useTuiAtomValue`
- Derived atoms via `Atom.map` for focused subscriptions

### State & Actions

Commands define state and actions using Effect Schema with a pure reducer:

```typescript
import { Schema } from 'effect'

// State schema (tagged union)
const DeployState = Schema.Union(
  Schema.TaggedStruct('Idle', {}),
  Schema.TaggedStruct('Progress', {
    services: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        status: Schema.Literal('pending', 'deploying', 'healthy'),
      }),
    ),
  }),
  Schema.TaggedStruct('Complete', {
    services: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        result: Schema.Literal('updated', 'unchanged'),
        duration: Schema.Number,
      }),
    ),
    totalDuration: Schema.Number,
  }),
)

// Action schema (tagged union)
const DeployAction = Schema.Union(
  Schema.TaggedStruct('StartDeploy', {
    services: Schema.Array(Schema.String),
  }),
  Schema.TaggedStruct('UpdateService', {
    name: Schema.String,
    status: Schema.Literal('pending', 'deploying', 'healthy'),
  }),
  Schema.TaggedStruct('Complete', {
    results: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        result: Schema.Literal('updated', 'unchanged'),
        duration: Schema.Number,
      }),
    ),
    totalDuration: Schema.Number,
  }),
)

// Pure reducer function
const deployReducer = (state: DeployState, action: DeployAction): DeployState => {
  switch (action._tag) {
    case 'StartDeploy':
      return {
        _tag: 'Progress',
        services: action.services.map((name) => ({ name, status: 'pending' as const })),
      }
    case 'UpdateService':
      if (state._tag !== 'Progress') return state
      return {
        ...state,
        services: state.services.map((s) =>
          s.name === action.name ? { ...s, status: action.status } : s,
        ),
      }
    case 'Complete':
      return { _tag: 'Complete', services: action.results, totalDuration: action.totalDuration }
  }
}
```

### Events (Renderer → Command)

For interactive modes, renderers publish input events via PubSub:

```typescript
const KeyEvent = Schema.TaggedStruct('Event.Key', {
  key: Schema.String,
  ctrl: Schema.optional(Schema.Boolean),
})

const ResizeEvent = Schema.TaggedStruct('Event.Resize', {
  rows: Schema.Number,
  cols: Schema.Number,
})

// Create PubSub with replay buffer for late subscribers
const eventPubSub = yield * PubSub.unbounded<InputEvent>({ replay: 16 })
```

---

## Rendering

### Rendering Pipeline

```
React Tree → TuiReconciler → Yoga Layout → Lines → InlineRenderer → Terminal
```

**Key features:**

- Differential line rendering (only changed lines written)
- Static/dynamic regions (logs persist above progress)
- Synchronized output (CSI 2026) for flicker-free updates
- Automatic resize handling

### Viewport

Components access terminal dimensions via hook:

```typescript
const { columns, rows } = useViewport()
```

Viewport updates automatically on terminal resize.

### Viewport Constraints

Differential rendering relies on cursor positioning to update content in place. Two conditions break cursor positioning and must be prevented:

#### Horizontal Constraint: Prevent Soft Wrapping

When a line exceeds terminal width, the terminal wraps it to the next row. This breaks column math—the renderer thinks it wrote 1 line but the terminal shows 2+.

**Protection:** Lines are automatically truncated to `viewport.columns` before rendering. Long lines are cut off rather than wrapped.

#### Vertical Constraint: Prevent Scrolling

When content exceeds terminal height, the terminal scrolls—pushing content above the visible area. The cursor cannot reach scrolled-off content, so differential updates fail (the renderer tries to move up N lines, but the cursor can only reach row 1).

**Protection:** Dynamic content is automatically limited to `viewport.rows - 1` lines. Excess content is truncated with a "... N more lines" indicator.

#### Viewport-Aware Components

For better UX, components should handle overflow gracefully rather than relying on hard truncation. Use `useViewport()` to adapt content:

```typescript
const FileList = ({ files }: { files: readonly File[] }) => {
  const { rows } = useViewport()

  // Calculate available lines (reserve space for header, footer, etc.)
  const availableLines = Math.max(1, rows - 4)

  if (files.length <= availableLines) {
    return <>{files.map(f => <FileItem key={f.path} file={f} />)}</>
  }

  // Prioritize important items (errors, active) when truncating
  const sorted = sortByPriority(files)
  const visible = sorted.slice(0, availableLines - 1)
  const hidden = sorted.slice(availableLines - 1)

  return (
    <>
      {visible.map(f => <FileItem key={f.path} file={f} />)}
      <Text dim>... {hidden.length} more files ({summarize(hidden)})</Text>
    </>
  )
}
```

**Priority patterns for overflow:**

1. Always show errors and active items
2. Show recently changed items
3. Collapse unchanged/pending items into summary
4. Provide counts by status in overflow indicator

### Static & Dynamic Regions

```
┌────────────────────────────────────────────────┐
│ [INFO] Starting sync...                        │ ← Static region
│ [WARN] effect-utils: Missing lockfile          │   (grows downward, persists)
├────────────────────────────────────────────────┤
│ ● Syncing repositories...                      │ ← Dynamic region
│   ✓ effect                                     │   (updated in place)
│   ◐ livestore                                  │
└────────────────────────────────────────────────┘
```

**Static region:** Content rendered via `<Static>` is printed once and persists in terminal scrollback. Cannot be updated or removed.

**Dynamic region:** Content that updates in place using differential rendering. Limited to viewport height.

### Alternate Screen Rendering

For `alt-screen` mode, rendering uses [OpenTUI](https://github.com/anomalyco/opentui):

```
React Tree → OpenTUI Reconciler → Yoga Layout → CliRenderer → Alternate Buffer
```

**Key differences from inline:**

- Full-screen alternate buffer (no scrollback)
- Built-in keyboard handling (`useKeyboard`)
- Built-in resize handling (`useOnResize`)
- Focus management for interactive elements

---

## Components

### Core Elements

| Component     | Inline | Alternate | Purpose                                    |
| ------------- | ------ | --------- | ------------------------------------------ |
| `<Box>`       | ✓      | ✓         | Flexbox container                          |
| `<Text>`      | ✓      | ✓         | Styled text (color, bold, dim, etc.)       |
| `<Static>`    | ✓      | -         | Content that persists above dynamic region |
| `<Spinner>`   | ✓      | ✓         | Animated progress indicator                |
| `<ScrollBox>` | -      | ✓         | Scrollable container                       |
| `<Input>`     | -      | ✓         | Text input field                           |

### Static Region (Inline Only)

Content in `<Static>` is rendered once and persists in terminal scrollback:

```tsx
<>
  <Static items={logs}>
    {(log) => (
      <Text key={log.id} dim>
        [{log.time}] {log.message}
      </Text>
    )}
  </Static>
  <Box>
    <Spinner /> Processing...
  </Box>
</>
```

### Capability Detection

```typescript
import { useCapability, IfCapability } from '@overeng/tui-react/universal'

function MyView({ state }) {
  return (
    <Box>
      <IfCapability capability="static" fallback={<Text>Logs: {state.logs.length}</Text>}>
        <Static items={state.logs}>
          {log => <Text key={log.id} dim>{log.message}</Text>}
        </Static>
      </IfCapability>
    </Box>
  )
}
```

| Capability   | Inline | Alternate | Description           |
| ------------ | ------ | --------- | --------------------- |
| `static`     | ✓      | -         | Persistent log region |
| `scrollable` | -      | ✓         | Scrollable containers |
| `input`      | -      | ✓         | Text input fields     |
| `focus`      | -      | ✓         | Focus management      |

---

## CLI Integration

### createTuiApp Pattern

Commands use `createTuiApp` with Elm architecture (State + Action + Reducer) and atom-based views:

```typescript
import { Atom } from '@effect-atom/atom'
import * as Cli from '@effect/cli'
import { createTuiApp, useTuiAtomValue, outputOption, outputModeLayer, Box, Text, Spinner } from '@overeng/tui-react'

// 1. Define the app (state + reducer)
const DeployApp = createTuiApp({
  stateSchema: DeployState,
  actionSchema: DeployAction,
  initial: { _tag: 'Idle' },
  reducer: deployReducer,
})

// 2. View receives stateAtom, subscribes internally
function DeployView({ stateAtom }: { stateAtom: Atom.Atom<DeployState> }) {
  const state = useTuiAtomValue(stateAtom)

  if (state._tag === 'Progress') {
    return (
      <Box flexDirection="column">
        <Spinner /><Text> Deploying...</Text>
        {state.services.map(s => (
          <Text key={s.name}>{s.status === 'healthy' ? '✓' : '○'} {s.name}</Text>
        ))}
      </Box>
    )
  }
  return <Text color="green">✓ Complete</Text>
}

// 3. Command runs app with view
const deployCommand = Cli.Command.make(
  'deploy',
  { output: outputOption, services: servicesOption },
  ({ output, services }) =>
    Effect.gen(function* () {
      // Pass stateAtom to view - same pattern in CLI, Storybook, tests
      const tui = yield* DeployApp.run(<DeployView stateAtom={DeployApp.stateAtom} />)

      // Dispatch actions (sync, not Effect!)
      tui.dispatch({ _tag: 'StartDeploy', services: services.split(',') })

      for (const service of services.split(',')) {
        tui.dispatch({ _tag: 'UpdateService', name: service, status: 'deploying' })
        yield* Effect.sleep('500 millis')
        tui.dispatch({ _tag: 'UpdateService', name: service, status: 'healthy' })
      }

      tui.dispatch({ _tag: 'Complete', results: [...], totalDuration: 1500 })
    }).pipe(
      Effect.scoped,
      Effect.provide(outputModeLayer(output))
    )
)
```

**Key benefits of atom-based views:**

- Same view works in CLI, Storybook, and tests
- No `connected-view.tsx` wrapper needed
- Fine-grained reactivity via derived atoms

### Mode Behavior

| Mode           | Behavior                                        |
| -------------- | ----------------------------------------------- |
| `tty` / `ci`   | Renders React component, re-renders on dispatch |
| `pipe` / `log` | Renders once at end (final visual)              |
| `json`         | Outputs final state as JSON when scope closes   |
| `ndjson`       | Streams state as NDJSON after each dispatch     |

---

## Lifecycle & Cleanup

### Lifecycle Phases

```
Initialize → Setup Renderer → Run Command → Cleanup → Exit
```

Signals (SIGINT, SIGTERM) can interrupt any phase. Cleanup always runs.

### Exit Modes

When unmounting, control what happens to rendered output:

| Mode           | Dynamic Region | Static Region | Use Case                   |
| -------------- | -------------- | ------------- | -------------------------- |
| `persist`      | Keep           | Keep          | Show final state (default) |
| `clear`        | Clear          | Clear         | Clean exit, no trace       |
| `clearDynamic` | Clear          | Keep          | Keep logs, remove progress |

```typescript
// Let scope close - uses default (persist)
// Or explicit:
yield * tui.unmount({ mode: 'clear' })
```

### Interrupt Handling (Ctrl+C)

If your `ActionSchema` includes `Schema.TaggedStruct('Interrupted', {...})`, the system automatically dispatches it on Ctrl+C:

```typescript
const MyAction = Schema.Union(
  Schema.TaggedStruct('SetProgress', { value: Schema.Number }),
  Schema.TaggedStruct('Interrupted', {}), // ← System dispatches on Ctrl+C
)

// View renders interrupted state
const MyView = ({ stateAtom }: { stateAtom: Atom.Atom<MyState> }) => {
  const state = useTuiAtomValue(stateAtom)
  if (state._tag === 'Interrupted') {
    return <Text color="yellow">⚠ Operation cancelled</Text>
  }
  // ...
}
```

### Terminal State Restoration

Renderers guarantee terminal restoration:

| Renderer  | Cleanup                                       |
| --------- | --------------------------------------------- |
| Inline    | Restore cursor, reset styles, apply exit mode |
| Alternate | Exit alt buffer, restore cursor               |
| JSON      | Flush buffer, trailing newline                |

### Shutdown Flush & Exit Codes

`runTuiMain` shuts down as fast as possible once any pending telemetry flush has
completed, and never relies on a fixed timeout on the happy path. The contract:

- **Flush is a scope finalizer, awaited to completion.** On natural exit, the
  OTLP/telemetry exporter's flush runs as a scope finalizer that Effect awaits;
  process exit happens as soon as it finishes — exit latency ≈ one collector
  round-trip, with no fixed wait added.
- **The shutdown cap is a ceiling, never a floor.** `makeOtelCliLayer`'s
  `shutdownTimeout` bounds only the worst case (a black-holed collector); it
  costs nothing when the collector is healthy. It defaults TTY-aware (30s
  non-interactive / 10s interactive) and must not be set to a small per-CLI
  override — a too-small cap interrupts the in-flight export and silently drops
  the final batch.
- **Ctrl-C bails fast.** The flush finalizer stays interruptible, so a signal
  during a slow or dead-collector flush escapes the cap in milliseconds.
- **Exit codes.** A signal-interrupted run exits **130** (shell convention); an
  uncaught failure exits 1; success exits 0. The code is derived from the fiber
  `Exit` — `runTuiMain` leaves an interrupt in the error channel and its
  `teardown` delegates to `Runtime.defaultTeardown` — never from the mutable
  global `process.exitCode`, so a stale ambient value cannot turn a clean
  success non-zero. On success the ambient `process.exitCode` IS forwarded,
  because that is the declared channel for `createTuiApp`'s `exitCode` mapper.

See `.decisions/0001-shutdown-flush-contract.md` for the competing-goals
resolution and the regression test
(`test/integration/cli-shutdown-flush.test.ts`).

---

## Error Handling

### Mode-Specific Error Output

| Mode            | Error Handling                              |
| --------------- | ------------------------------------------- |
| `tty`           | Clear dynamic region, print error, exit     |
| `alt-screen`    | Exit alternate screen, print to main screen |
| `ci`/`ci-plain` | Print formatted error                       |
| `json`          | Output JSON error object                    |
| `ndjson`        | Output JSON error line, close stream        |

### Error Format (JSON)

```json
{
  "_tag": "Error",
  "code": "DEPLOY_FAILED",
  "message": "Failed to deploy service",
  "details": { "service": "api-server", "reason": "Health check timeout" }
}
```

---

## Testing

### Testing Reducers

Reducers are pure functions, easily testable:

```typescript
test('reducer handles UpdateService', () => {
  const state: DeployState = {
    _tag: 'Progress',
    services: [{ name: 'api', status: 'pending' }],
  }
  const action: DeployAction = { _tag: 'UpdateService', name: 'api', status: 'healthy' }

  const next = deployReducer(state, action)

  expect(next.services[0]).toEqual({ name: 'api', status: 'healthy' })
})
```

### Testing Command Logic

```typescript
test('deploy dispatches correct actions', async () => {
  const actions: DeployAction[] = []

  await Effect.gen(function* () {
    const tui = yield* useTuiState({ ... })

    yield* tui.actions.pipe(
      Stream.runCollect,
      Effect.map(chunk => actions.push(...Chunk.toArray(chunk))),
      Effect.fork,
    )

    yield* runDeployLogic(tui, ['api-server'])
  }).pipe(Effect.scoped, Effect.provide(jsonLayer), Effect.runPromise)

  expect(actions.map(a => a._tag)).toContain('StartDeploy')
})
```

### Testing React Components

```typescript
import { Atom, Registry } from '@effect-atom/atom'
import { TestRenderer, TuiRegistryContext } from '@overeng/tui-react/test'

test('deploy view renders progress', () => {
  const renderer = TestRenderer.create()
  const registry = Registry.make()
  const stateAtom = Atom.make<DeployState>({
    _tag: 'Progress',
    services: [{ name: 'api-server', status: 'healthy' }],
  })

  renderer.render(
    <TuiRegistryContext.Provider value={registry}>
      <DeployView stateAtom={stateAtom} />
    </TuiRegistryContext.Provider>
  )

  expect(renderer.toText()).toContain('✓ api-server')
})
```

---

## API Reference

### createRoot

Creates a root for rendering React elements to the terminal.

```typescript
interface CreateRootOptions {
  /** Min ms between renders. Default: 16 (~60fps) */
  throttleMs?: number
  /** Max lines for dynamic region. Default: 100 */
  maxDynamicLines?: number
  /** Max static lines to buffer. Default: Infinity */
  maxStaticLines?: number
}

interface Root {
  /** Render a React element */
  render: (element: ReactElement) => void
  /** Unmount and cleanup. Automatically flushes pending work. */
  unmount: (options?: { mode?: ExitMode }) => void
  /** Flush pending React work synchronously */
  flush: () => void
  /** Notify of terminal resize */
  resize: () => void
  /** Current viewport dimensions */
  readonly viewport: { columns: number; rows: number }
}

const root = createRoot({ terminalOrStream: process.stdout, options: { throttleMs: 16 } })
root.render(<App />)
root.unmount()
```

### createTuiApp

Factory for TUI applications with Elm-style state management and atom-based reactivity.

```typescript
interface TuiAppConfig<S, A> {
  readonly stateSchema: Schema.Schema<S>
  readonly actionSchema: Schema.Schema<A>
  readonly initial: S
  readonly reducer: (params: { state: S; action: A }) => S
}

interface TuiApp<S, A> {
  /** Run the app with a view element */
  readonly run: (view: ReactElement) => Effect.Effect<TuiApi<S, A>, never, Scope.Scope | OutputMode>
  /** State atom - pass to views for reactive subscriptions */
  readonly stateAtom: Atom.Writable<S>
}

interface TuiApi<S, A> {
  readonly dispatch: (action: A) => void
  readonly getState: () => S
  readonly stateRef: SubscriptionRef.SubscriptionRef<S>
  readonly actions: Stream.Stream<A>
  readonly unmount: (options?: { mode?: ExitMode }) => Effect.Effect<void>
}
```

### useTuiAtomValue

Hook for subscribing to an atom's value within a TUI component.

```typescript
// In a view component
const MyView = ({ stateAtom }: { stateAtom: Atom.Atom<MyState> }) => {
  const state = useTuiAtomValue(stateAtom)
  return <Text>{state.message}</Text>
}
```

### View Component Pattern

Views receive a `stateAtom` prop and subscribe internally using `useTuiAtomValue`:

```typescript
import { Atom } from '@effect-atom/atom'
import { useTuiAtomValue } from '@overeng/tui-react'

interface MyViewProps {
  stateAtom: Atom.Atom<MyState>
}

const MyView = ({ stateAtom }: MyViewProps) => {
  const state = useTuiAtomValue(stateAtom)

  // Render based on state
  return <Text>{state.message}</Text>
}

// Usage in CLI:
const tui = yield* MyApp.run(<MyView stateAtom={MyApp.stateAtom} />)

// Usage in Storybook (TuiStoryPreview creates atom internally):
<TuiStoryPreview View={MyView} initialState={mockState} ... />

// Usage in tests:
const registry = Registry.make()
const stateAtom = Atom.make(testState)
<TuiRegistryContext.Provider value={registry}>
  <MyView stateAtom={stateAtom} />
</TuiRegistryContext.Provider>
```

**Benefits of this pattern:**

- Same view component works everywhere (CLI, Storybook, tests)
- No `connected-view.tsx` wrapper needed
- Fine-grained reactivity via derived atoms
- Clear data flow: atom → useTuiAtomValue → render

### outputOption & outputModeLayer

CLI option and layer for output mode selection.

```typescript
// Standard --output / -o option
const outputOption: Cli.Options<OutputModeValue>

// Create layer from option value
// For JSON modes, this also configures stderr logging
const outputModeLayer: (value: OutputModeValue) => Layer<OutputMode>

type OutputModeValue =
  | 'auto'
  | 'tty'
  | 'alt-screen'
  | 'ci'
  | 'ci-plain'
  | 'pipe'
  | 'log'
  | 'json'
  | 'ndjson'
```

**Note:** `outputModeLayer` configures logging behavior per mode:

- **Progressive modes** (`tty`, `ci`, `ci-plain`, `alt-screen`): Captures all Effect logs and `console.*` output to prevent TUI corruption. Access captured logs in components via `useCapturedLogs()`.
- **JSON modes** (`json`, `ndjson`): Redirects the Effect logger to stderr, keeping stdout clean for JSON data.
- **Final modes** (`pipe`, `log`): No special log handling (single render at end).

### runTuiMain

Helper for running TUI CLI applications as the main entry point with proper error handling.

```typescript
import { NodeRuntime } from '@effect/platform-node'
import { runTuiMain, outputModeLayer } from '@overeng/tui-react'

// Run the CLI with proper error handling
const program = Cli.Command.run(myCommand, { name: 'my-cli', version: '1.0.0' })(process.argv).pipe(
  Effect.provide(outputModeLayer('auto')),
)

runTuiMain(NodeRuntime)(program)
```

**What it does:**

1. Writes errors to stderr (not stdout) to avoid polluting JSON output
2. Disables `runMain`'s built-in error reporting to prevent double-logging
3. Preserves exit codes from errors

**Why use it:** When using `NodeRuntime.runMain` directly, errors are logged to stdout via the pretty logger. This breaks JSON output parsing when commands fail. `runTuiMain` ensures errors go to stderr while keeping stdout clean for JSON data.

### useCapturedLogs

Hook for accessing log entries captured by the automatic log capture system.

```typescript
const logs: readonly TuiLogEntry[] = useCapturedLogs()
```

Returns captured log entries in progressive-visual modes. Returns an empty array if no capture is active (JSON modes, final modes, tests without capture).

Each `TuiLogEntry` contains:

```typescript
interface TuiLogEntry {
  id: number
  level: string // 'INFO', 'DEBUG', 'WARNING', 'ERROR'
  message: string
  timestamp: Date
  fiberId: string
  annotations: Record<string, unknown>
  span?: string
}
```

### useViewport

Hook for accessing terminal dimensions.

```typescript
interface Viewport {
  columns: number
  rows: number
}

const { columns, rows } = useViewport()
```

### Types

```typescript
type ExitMode = 'persist' | 'clear' | 'clearDynamic'

interface RenderConfig {
  timing: 'live' | 'final'
  animation: boolean
  colors: boolean
  altScreen: boolean
}

// View props pattern - views receive stateAtom
interface MyViewProps<S> {
  stateAtom: Atom.Atom<S>
}
```

---

## Complete Example

A full deploy command using Effect CLI with tui-react and atom-based views:

```typescript
import { Atom } from '@effect-atom/atom'
import * as Cli from '@effect/cli'
import { NodeContext, NodeRuntime } from '@effect/platform-node'
import { Effect, Schema, Duration } from 'effect'
import { createTuiApp, useTuiAtomValue, outputOption, outputModeLayer, Box, Text, Spinner, Static, useViewport } from '@overeng/tui-react'

// State & Action schemas
const DeployState = Schema.Union(
  Schema.TaggedStruct('Idle', {}),
  Schema.TaggedStruct('Progress', {
    services: Schema.Array(Schema.Struct({
      name: Schema.String,
      status: Schema.Literal('pending', 'deploying', 'healthy'),
    })),
    logs: Schema.Array(Schema.String),
  }),
  Schema.TaggedStruct('Complete', {
    services: Schema.Array(Schema.Struct({
      name: Schema.String,
      result: Schema.Literal('updated', 'unchanged'),
      duration: Schema.Number,
    })),
    logs: Schema.Array(Schema.String),
    totalDuration: Schema.Number,
  }),
  Schema.TaggedStruct('Interrupted', {}),
)

type DeployState = Schema.Schema.Type<typeof DeployState>

const DeployAction = Schema.Union(
  Schema.TaggedStruct('AddLog', { message: Schema.String }),
  Schema.TaggedStruct('StartDeploy', { services: Schema.Array(Schema.String) }),
  Schema.TaggedStruct('UpdateService', { name: Schema.String, status: Schema.Literal('pending', 'deploying', 'healthy') }),
  Schema.TaggedStruct('Finish', { results: Schema.Array(Schema.Struct({ name: Schema.String, result: Schema.Literal('updated', 'unchanged'), duration: Schema.Number })), totalDuration: Schema.Number }),
  Schema.TaggedStruct('Interrupted', {}),
)

// Reducer
const deployReducer = ({ state, action }: { state: DeployState; action: typeof DeployAction.Type }): DeployState => {
  switch (action._tag) {
    case 'AddLog':
      if (!('logs' in state)) return state
      return { ...state, logs: [...state.logs, action.message] } as DeployState
    case 'StartDeploy':
      return { _tag: 'Progress', services: action.services.map(name => ({ name, status: 'pending' as const })), logs: [] }
    case 'UpdateService':
      if (state._tag !== 'Progress') return state
      return { ...state, services: state.services.map(s => s.name === action.name ? { ...s, status: action.status } : s) }
    case 'Finish':
      if (state._tag !== 'Progress') return state
      return { _tag: 'Complete', services: action.results, logs: state.logs, totalDuration: action.totalDuration }
    case 'Interrupted':
      return { _tag: 'Interrupted' }
  }
}

// Create the app
const DeployApp = createTuiApp({
  stateSchema: DeployState,
  actionSchema: DeployAction,
  initial: { _tag: 'Idle' } as DeployState,
  reducer: deployReducer,
})

// View receives stateAtom, subscribes internally
function DeployView({ stateAtom }: { stateAtom: Atom.Atom<DeployState> }) {
  const state = useTuiAtomValue(stateAtom)
  const { rows } = useViewport()

  if (state._tag === 'Idle') return null
  if (state._tag === 'Interrupted') return <Text color="yellow">⚠ Operation cancelled</Text>

  const logs = 'logs' in state ? state.logs : []

  return (
    <>
      <Static items={logs}>
        {(log, i) => <Text key={i} dim>[deploy] {log}</Text>}
      </Static>

      {state._tag === 'Progress' && (
        <Box flexDirection="column">
          <Text>Deploying {state.services.filter(s => s.status === 'healthy').length}/{state.services.length}</Text>
          <ServiceList services={state.services} maxRows={rows - 4} />
        </Box>
      )}

      {state._tag === 'Complete' && (
        <Text color="green">✓ Deployed {state.services.length} services in {(state.totalDuration / 1000).toFixed(1)}s</Text>
      )}
    </>
  )
}

// Viewport-aware service list
function ServiceList({ services, maxRows }) {
  if (services.length <= maxRows) {
    return <>{services.map(s => <ServiceItem key={s.name} service={s} />)}</>
  }

  // Prioritize: deploying > healthy > pending
  const sorted = [...services].sort((a, b) => {
    const priority = { deploying: 0, healthy: 1, pending: 2 }
    return priority[a.status] - priority[b.status]
  })

  const visible = sorted.slice(0, maxRows - 1)
  const hidden = sorted.slice(maxRows - 1)

  return (
    <>
      {visible.map(s => <ServiceItem key={s.name} service={s} />)}
      <Text dim>... {hidden.length} more services</Text>
    </>
  )
}

function ServiceItem({ service }) {
  return (
    <Box paddingLeft={2}>
      {service.status === 'healthy' && <Text color="green">✓ </Text>}
      {service.status === 'deploying' && <><Spinner /><Text> </Text></>}
      {service.status === 'pending' && <Text dim>○ </Text>}
      <Text>{service.name}</Text>
    </Box>
  )
}

// Command - uses DeployApp.run() with atom-based view
const deployCommand = Cli.Command.make(
  'deploy',
  { output: outputOption, services: Cli.Options.text('services').pipe(Cli.Options.withAlias('s')) },
  ({ output, services }) =>
    Effect.gen(function* () {
      const serviceList = services.split(',').map(s => s.trim())
      const startTime = Date.now()

      // Pass stateAtom to view - same pattern works in CLI, Storybook, tests
      const tui = yield* DeployApp.run(<DeployView stateAtom={DeployApp.stateAtom} />)

      tui.dispatch({ _tag: 'StartDeploy', services: serviceList })

      for (const service of serviceList) {
        tui.dispatch({ _tag: 'AddLog', message: `Deploying ${service}...` })
        tui.dispatch({ _tag: 'UpdateService', name: service, status: 'deploying' })
        yield* Effect.sleep(Duration.millis(500 + Math.random() * 500))
        tui.dispatch({ _tag: 'UpdateService', name: service, status: 'healthy' })
      }

      tui.dispatch({ _tag: 'Finish', results: serviceList.map(name => ({ name, result: 'updated' as const, duration: 500 })), totalDuration: Date.now() - startTime })
    }).pipe(Effect.scoped, Effect.provide(outputModeLayer(output)))
)

// Run
Cli.Command.run(deployCommand, { name: 'deploy', version: '1.0.0' })(process.argv).pipe(
  Effect.provide(NodeContext.layer),
  NodeRuntime.runMain,
)
```

---

## Appendix

### Key Decisions

| Decision           | Choice                      | Rationale                              |
| ------------------ | --------------------------- | -------------------------------------- |
| CLI integration    | `@effect/cli`               | Leverage existing framework            |
| State primitive    | `@effect-atom/atom`         | Better React integration, sync updates |
| State updates      | Reducer-only (Elm)          | Predictable, testable                  |
| Mode selection     | `OutputMode` service        | Layer-based, composable                |
| Inline reconciler  | Custom (`react-reconciler`) | Full control, no ink dependency        |
| Alternate renderer | OpenTUI                     | Production-ready, same Yoga layout     |
| Layout             | Yoga                        | Proven flexbox implementation          |
| Output diffing     | Line-level                  | Simple, sufficient for CLI             |
| Truncation         | Automatic at render layer   | Prevents cursor positioning bugs       |

### References

**Design:**

- [Design Exploration](https://gist.github.com/schickling/98a66ff02e5ab8ade54b418118046c00)
- [Implementation Plan](../tasks/2026-01-28-effect-cli-integration/plan.md)

**Research:**

- [pi-tui](./research/pi-tui.md) - Inline TUI framework
- [OpenTUI](./research/opentui.md) - Full-screen TUI library
- [Yoga Layout](./research/yoga-layout.md) - Flexbox layout engine

**External:**

- [Effect Atom GitHub](https://github.com/tim-smart/effect-atom)
- [OpenTUI GitHub](https://github.com/anomalyco/opentui)
- [Yoga Documentation](https://yogalayout.dev/)
