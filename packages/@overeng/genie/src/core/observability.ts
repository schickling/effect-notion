import path from 'node:path'

import { Effect, Schema } from 'effect'

import {
  OtelAttr,
  OtelAttrs,
  OtelOperation,
  type OtelAttrEncodeError,
  type OtelOperationDefinition,
} from '@overeng/otel-contract'

import { CliMode } from './cli.contract.ts'
import {
  AtomicWriteOperation,
  CommandOperation,
  FileOperation,
  ImportMapResolverOperation,
  OxfmtOperation,
  PathOperation,
  TargetLockOperation,
  ValidationOperation,
} from './genie.contract.ts'

const basename = (filePath: string): string =>
  filePath.split(/[\\/]/).findLast((part) => part.length > 0) ?? filePath

/** Span-label-friendly path: cwd-relative with forward slashes, falling back to the basename when outside cwd. */
export const relativePath = ({ cwd, filePath }: { cwd: string; filePath: string }): string => {
  const relative = path.relative(cwd, filePath).split(path.sep).join('/')
  return relative.length > 0 ? relative : basename(filePath)
}

const trustOtelContract = <A, E, R>(
  effect: Effect.Effect<A, E | OtelAttrEncodeError, R>,
): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.catch((error) =>
      typeof error === 'object' &&
      error !== null &&
      '_tag' in error &&
      error._tag === 'OtelAttrEncodeError'
        ? Effect.die(error)
        : Effect.fail(error as E),
    ),
  ) as Effect.Effect<A, E, R>

const trustedWith =
  <S extends Schema.Codec<any>>({
    operation,
    attributes,
  }: {
    operation: OtelOperationDefinition<S>
    attributes: Schema.Schema.Type<S>
  }): (<A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    trustOtelContract<A, E, R>(operation.with({ attributes, effect }))

/** Like {@link trustedWith} but forces a ROOT span (used for the top-level `genie/command`). */
const trustedWithRoot =
  <S extends Schema.Codec<any>>({
    operation,
    attributes,
  }: {
    operation: OtelOperationDefinition<S>
    attributes: Schema.Schema.Type<S>
  }): (<A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    trustOtelContract<A, E, R>(operation.withRoot({ attributes, effect }))

const trustedAnnotate = <S extends Schema.Codec<any>>({
  operation,
  attributes,
}: {
  operation: OtelOperationDefinition<S>
  attributes: Schema.Schema.Type<S>
}): Effect.Effect<void> => trustOtelContract<void, never, never>(operation.annotate(attributes))

// genie.* operations are DERIVED from the registered seam contract (`./genie.contract.ts`,
// namespace `genie`) — the single SSOT for both the Weaver registry projection and these
// runtime encoders (SC-R13/R14). Each `*.operation` is the real `OtelOperation.define` product
// surface; only the runtime wrappers below (attribute shaping, root-span selection) live here.
const commandSpan = CommandOperation.operation
const fileSpan = FileOperation.operation
const pathOperation = PathOperation.operation
const oxfmtOperation = OxfmtOperation.operation
const validationSpan = ValidationOperation.operation
const atomicWriteSpan = AtomicWriteOperation.operation
const importMapResolverSpan = ImportMapResolverOperation.operation
const targetLockOperation = TargetLockOperation.operation

// The `cli.mode` root span (`genie/<cliMode>`) stays a LEGACY inline bridge: its span name is
// DYNAMIC (varies by CLI mode), so it has no stable single-signal registry projection (SC-DQ5). Its
// `cli.mode` key is now catalogued in the `cli` namespace seam (`./cli.contract.ts`); the encoder
// below rebuilds from that IMPORTED catalog schema (identical encode — proven by the equivalence
// test) so the `cli.*` catalog is the single SSOT (SC-R13/R14).
const cliModeAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    cliMode: CliMode,
  }),
)

const cliModeOperation = (cliMode: string) =>
  OtelOperation.define({
    name: `genie/${cliMode}`,
    attributes: cliModeAttrs,
    label: ({ label }) => label,
  })

/** Wraps an effect in the root `genie/<cliMode>` span; the operation name varies by CLI mode (generate/check/watch/dry-run). */
export const withCliModeSpan = (cliMode: string) =>
  trustedWith({ operation: cliModeOperation(cliMode), attributes: { label: cliMode, cliMode } })

/** Wraps an effect in the `genie/command` span; optional attributes are omitted (not encoded as undefined) when absent. */
export const withCommandSpan = ({
  label,
  cwd,
  readOnly,
  dryRun,
  concurrency,
}: {
  label: string
  cwd: string
  readOnly?: boolean
  dryRun?: boolean
  concurrency?: number
}) =>
  trustedWithRoot({
    operation: commandSpan,
    attributes: {
      label,
      cwd,
      ...(readOnly === undefined ? {} : { readOnly }),
      ...(dryRun === undefined ? {} : { dryRun }),
      ...(concurrency === undefined ? {} : { concurrency }),
    },
  })

/** Wraps per-file generation in the `genie/file` span; label defaults to the cwd-relative target path when omitted. */
export const withFileSpan = ({
  label,
  cwd,
  genieFilePath,
  targetFilePath,
  readOnly,
  dryRun,
}: {
  label?: string
  cwd: string
  genieFilePath: string
  targetFilePath: string
  readOnly?: boolean
  dryRun?: boolean
}) =>
  trustedWith({
    operation: fileSpan,
    attributes: {
      label: label ?? relativePath({ cwd, filePath: targetFilePath }),
      cwd,
      genieFilePath,
      targetFilePath,
      ...(readOnly === undefined ? {} : { readOnly }),
      ...(dryRun === undefined ? {} : { dryRun }),
    },
  })

/** Wraps a single atomic file write in the `atomicWriteFile` span, labelled by the target's basename. */
export const withAtomicWriteSpan = ({
  targetFilePath,
  mode,
}: {
  targetFilePath: string
  mode?: number
}) =>
  trustedWith({
    operation: atomicWriteSpan,
    attributes: {
      label: basename(targetFilePath),
      targetFilePath,
      ...(mode === undefined ? {} : { mode }),
    },
  })

/** Pre-applied wrapper for the `genie.registerImportMapResolver` span (no per-call attributes beyond the fixed label). */
export const withImportMapResolverSpan = trustedWith({
  operation: importMapResolverSpan,
  attributes: { label: 'import-map' },
})

/** Wraps the cross-file validation pass in the `genie/runValidation` span. */
export const withValidationSpan = ({
  cwd,
  requirePackageJsonValidate,
  fileCount,
  preloadedFileCount,
}: {
  cwd: string
  requirePackageJsonValidate: boolean
  fileCount?: number
  preloadedFileCount?: number
}) =>
  trustedWith({
    operation: validationSpan,
    attributes: {
      label: 'validate',
      cwd,
      requirePackageJsonValidate,
      ...(fileCount === undefined ? {} : { fileCount }),
      ...(preloadedFileCount === undefined ? {} : { preloadedFileCount }),
    },
  })

/** Annotates the current span with `genie/command` attributes (in-place, no child span). */
export const annotateCommand = ({
  label,
  cwd,
  readOnly,
  dryRun,
  concurrency,
}: {
  label: string
  cwd: string
  readOnly?: boolean
  dryRun?: boolean
  concurrency?: number
}) =>
  trustedAnnotate({
    operation: commandSpan,
    attributes: {
      label,
      cwd,
      ...(readOnly === undefined ? {} : { readOnly }),
      ...(dryRun === undefined ? {} : { dryRun }),
      ...(concurrency === undefined ? {} : { concurrency }),
    },
  })

/** Annotates the current span with `genie/file` attributes; label defaults to the cwd-relative target path. */
export const annotateFile = ({
  label,
  cwd,
  genieFilePath,
  targetFilePath,
  readOnly,
  dryRun,
}: {
  label?: string
  cwd: string
  genieFilePath: string
  targetFilePath: string
  readOnly?: boolean
  dryRun?: boolean
}) =>
  trustedAnnotate({
    operation: fileSpan,
    attributes: {
      label: label ?? relativePath({ cwd, filePath: targetFilePath }),
      cwd,
      genieFilePath,
      targetFilePath,
      ...(readOnly === undefined ? {} : { readOnly }),
      ...(dryRun === undefined ? {} : { dryRun }),
    },
  })

/** Annotates the current span with `genie/runValidation` attributes (in-place). */
export const annotateValidation = ({
  cwd,
  requirePackageJsonValidate,
  fileCount,
  preloadedFileCount,
}: {
  cwd: string
  requirePackageJsonValidate: boolean
  fileCount?: number
  preloadedFileCount?: number
}) =>
  trustedAnnotate({
    operation: validationSpan,
    attributes: {
      label: 'validate',
      cwd,
      requirePackageJsonValidate,
      ...(fileCount === undefined ? {} : { fileCount }),
      ...(preloadedFileCount === undefined ? {} : { preloadedFileCount }),
    },
  })

/** Annotates the current span with a single `genie.path` attribute; label defaults to the path's basename. */
export const annotatePath = ({ label, path: filePath }: { label?: string; path: string }) =>
  trustedAnnotate({
    operation: pathOperation,
    attributes: { label: label ?? basename(filePath), path: filePath },
  })

/** Annotates the current span with `genie/target-lock` attributes, labelled by the cwd-relative target path. */
export const annotateTargetLock = ({
  cwd,
  targetFilePath,
}: {
  cwd: string
  targetFilePath: string
}) =>
  trustedAnnotate({
    operation: targetLockOperation,
    attributes: {
      label: relativePath({ cwd, filePath: targetFilePath }),
      cwd,
      targetFilePath,
    },
  })

/** Annotates the current span with `genie/oxfmt` attributes; `hasConfig` records whether an oxfmt config was resolved. */
export const annotateOxfmt = ({
  targetFilePath,
  hasConfig,
}: {
  targetFilePath: string
  hasConfig: boolean
}) =>
  trustedAnnotate({
    operation: oxfmtOperation,
    attributes: {
      label: basename(targetFilePath),
      targetFilePath,
      hasConfig,
    },
  })
