/**
 * SEAM member contract for the `cmd.*` telemetry namespace (decision 0005) — the OWN observability
 * of `@overeng/utils`' command runner (`src/node/cmd.ts`), authored via the Layer-2
 * `@overeng/otel-contract/registry` surface. This is the single home for the `cmd.*` telemetry
 * catalog + signals: the Weaver registry projection AND the runtime encoders (`src/node/cmd.ts`)
 * both derive from it (SC-R13/R14).
 *
 * This is a `*.contract.ts` seam file, so it is exempt from the `otel-contract-in-seam-file` lint
 * and MUST be registered in the root aggregator's `memberSeamPaths` (a colocated no-orphan-seam
 * test asserts this).
 *
 * Placement: `src/node/` (utils has a dep-free `isomorphic/` zone, but `cmd.ts` lives under
 * `node/` and already imports `@overeng/otel-contract` at runtime, so this file's `./registry`
 * import is runtime-safe here).
 *
 * SCOPE — `cmd` namespace only. All keys are already namespaced `cmd.*` (no bare-key renames).
 * Every `cmd.*` operation is a STATIC-name span with ≥1 catalog attribute, so all three project as
 * registered signals (no dynamic-name bridge / doc-only attribute needed).
 *
 * `cmd.args` is JSON-encoded (`encode: 'json'`) — the runtime emits a JSON *string*, so its
 * declared Weaver type is `string` (not `string[]`). The `attr.*` DSL exposes no json builder, so
 * it is authored directly from `OtelAttr.json` + the exported `WeaverAttrAnnotationId` (exactly
 * what the DSL's private `annotateWeaver` does), keeping the change contained to this one attribute.
 */
import { Schema } from 'effect'

import { OtelAttr } from '@overeng/otel-contract'
import {
  WeaverAttrAnnotationId,
  attr,
  defineOtelContract,
  operation,
  recommended,
  required,
} from '@overeng/otel-contract/registry'

// ---------------------------------------------------------------------------
// attributes (annotated Effect Schemas; the cmd.* catalog SSOT)
// ---------------------------------------------------------------------------

/** Working directory a command runs in. */
export const CmdCwd = attr.string({
  key: 'cmd.cwd',
  cardinality: 'high',
  brief: 'Working directory a command runs in.',
  stability: 'development',
  examples: ['/home/user/project'],
})

/** Executable a command invokes (argv[0]). */
export const CmdCommand = attr.string({
  key: 'cmd.command',
  cardinality: 'high',
  brief: 'Executable a command invokes (argv[0]).',
  stability: 'development',
  examples: ['git', 'ls'],
})

/**
 * Command arguments, JSON-encoded (`encode: 'json'` → a JSON string on the wire). Declared Weaver
 * type `string`. Authored directly (not via the `attr.*` DSL) because the DSL has no json builder.
 */
export const CmdArgs = OtelAttr.json({
  key: 'cmd.args',
  schema: Schema.Array(Schema.String),
  metadata: { cardinality: 'high' },
}).annotate({
  [WeaverAttrAnnotationId]: {
    brief: 'Command arguments (JSON-encoded array of strings).',
    stability: 'development',
    weaverType: 'string',
    examples: ['["-la","/tmp"]'],
  },
})

/** Directory a command mirrors its output into (canonical log file lives here). */
export const CmdLogDir = attr.string({
  key: 'cmd.log_dir',
  cardinality: 'high',
  brief: 'Directory a command mirrors its output into (canonical log file lives here).',
  stability: 'development',
  examples: ['/home/user/project/.logs'],
})

/** Canonical log file path a command writes to when logging is enabled. */
export const CmdLogPath = attr.string({
  key: 'cmd.log_path',
  cardinality: 'high',
  brief: 'Canonical log file path a command writes to when logging is enabled.',
  stability: 'development',
  examples: ['/home/user/project/.logs/dev.log'],
})

/** Whether the command is executed through a subshell. */
export const CmdShell = attr.boolean({
  key: 'cmd.shell',
  brief: 'Whether the command is executed through a subshell.',
  stability: 'development',
})

// ---------------------------------------------------------------------------
// signals (operations: static-name spans; label derived from a runtime-only field)
// ---------------------------------------------------------------------------

/** The runtime-only span-label source field shared by every cmd operation. */
const labelField = { label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()) } as const
const labelOf = (v: { label: string }): string => v.label

/** `cmd.run` — run a command to completion and return its exit code. */
export const CmdRunOperation = operation({
  id: 'span.cmd.run',
  name: 'cmd.run',
  brief: 'Run a command to completion and return its exit code.',
  stability: 'development',
  span_kind: 'internal',
  attributes: {
    cwd: required(CmdCwd),
    command: required(CmdCommand),
    args: required(CmdArgs),
    logDir: recommended(CmdLogDir),
    shell: required(CmdShell),
  },
  labelFields: labelField,
  label: labelOf,
})

/** `cmd.collect` — run a command and collect its buffered stdout. */
export const CmdCollectOperation = operation({
  id: 'span.cmd.collect',
  name: 'cmd.collect',
  brief: 'Run a command and collect its buffered stdout.',
  stability: 'development',
  span_kind: 'internal',
  attributes: {
    cwd: recommended(CmdCwd),
    shell: required(CmdShell),
  },
  labelFields: labelField,
  label: labelOf,
})

/** `cmd.run-with-logging` — run a command, mirroring output to a canonical log file. */
export const CmdLoggingOperation = operation({
  id: 'span.cmd.run_with_logging',
  name: 'cmd.run-with-logging',
  brief: 'Run a command, mirroring output to a canonical log file.',
  stability: 'development',
  span_kind: 'internal',
  attributes: {
    cwd: required(CmdCwd),
    logPath: required(CmdLogPath),
    shell: required(CmdShell),
  },
  labelFields: labelField,
  label: labelOf,
})

// ---------------------------------------------------------------------------
// contract seam (namespace `cmd`, derived).
// ---------------------------------------------------------------------------

export default defineOtelContract({
  memberPath: 'packages/@overeng/utils',
  displayName: 'Command Runner Attributes',
  signals: [CmdRunOperation, CmdCollectOperation, CmdLoggingOperation],
})
