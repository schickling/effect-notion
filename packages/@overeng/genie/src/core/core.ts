import os from 'node:os'
import path from 'node:path'

import { Effect, FileSystem, Option, Ref } from 'effect'
import type { Path } from 'effect'
import type { PlatformError } from 'effect/PlatformError'
import type * as CommandExecutor from 'effect/unstable/process/ChildProcessSpawner'

import { assertNever } from '@overeng/utils'

import { formatValidationIssues } from '../runtime/package-json/validation.ts'
import { findGenieFiles } from './discovery.ts'
import { GenieGenerationFailedError } from './errors.ts'
import { type GenieEventBus, emit } from './events.ts'
import {
  checkFile,
  checkFileDetailed,
  errorOriginatesInFile,
  findCatalogConflictError,
  generateFile,
  type LoadedGenieFile,
  isTdzError,
} from './generation.ts'
import * as Observability from './observability.ts'
import { type GeneratorPhase, parseGeneratorPhase } from './phase.ts'
import type { GenieFileStatus, GenieSummary } from './schema.ts'
import type { GenerateSuccess } from './types.ts'
import { runGenieValidation } from './validation.ts'

// ---------------------------------------------------------------------------
// Shared helpers (used by both core and CLI watch mode)
// ---------------------------------------------------------------------------

/** Convention paths for oxfmt config relative to workspace root (checked in order) */
export const OXFMT_CONFIG_CONVENTION_PATHS = ['.oxfmtrc.json', 'oxfmt.json']

/** Resolve the oxfmt config path: explicit option → convention paths → none */
export const resolveOxfmtConfigPath = Effect.fn('resolveOxfmtConfigPath')(function* ({
  explicitPath,
  cwd,
}: {
  explicitPath: Option.Option<string>
  cwd: string
}) {
  yield* Observability.annotatePath({ label: 'oxfmt', path: cwd })
  if (Option.isSome(explicitPath) === true) return explicitPath
  const fs = yield* FileSystem.FileSystem
  for (const conventionPath of OXFMT_CONFIG_CONVENTION_PATHS) {
    const fullPath = path.join(cwd, conventionPath)
    if ((yield* fs.exists(fullPath)) === true) return Option.some(fullPath)
  }
  return Option.none()
})

/** Map generation result tag to file status */
export const mapResultToStatus = (result: { _tag: string }): GenieFileStatus => {
  switch (result._tag) {
    case 'created':
      return 'created'
    case 'updated':
      return 'updated'
    case 'unchanged':
      return 'unchanged'
    case 'skipped':
      return 'skipped'
    default:
      return 'error'
  }
}

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/** Internal options passed to the core generation pipeline. */
export type CoreGenerateOptions = {
  cwd: string
  readOnly: boolean
  dryRun: boolean
  oxfmtConfigPath: Option.Option<string>
  /** When set, restrict generation to generators declaring this phase (R31). Absent ⇒ all phases. */
  phase?: GeneratorPhase | undefined
  /** Defer cross-file validation to a mandatory later step in a repair transaction. */
  validate?: boolean | undefined
}

/** Internal options passed to the core check (up-to-date verification) pipeline. */
export type CoreCheckOptions = {
  cwd: string
  oxfmtConfigPath: Option.Option<string>
  /** When set, restrict the check to generators declaring this phase (R31). Absent ⇒ all phases. */
  phase?: GeneratorPhase | undefined
}

/** Aggregate result of a full generation run including per-file outcomes and summary counts. */
export type GenieGenerateResult = {
  summary: GenieSummary
  files: Array<GenerateSuccess>
}

// ---------------------------------------------------------------------------
// Shared orchestration
// ---------------------------------------------------------------------------

/**
 * Discover genie files, assert no duplicate targets, and (when a phase is requested) restrict the
 * set to generators declaring that phase.
 *
 * Duplicate-target rejection runs over the FULL discovered set before phase filtering so a
 * duplicate is caught regardless of the active phase. Phase selection then reads each source's
 * static `// @genie-bootstrap` flag ({@link parseGeneratorPhase}) — no import — so a `bootstrap`-phase
 * run never has to load a `design-time` generator (which would need the runtime graph).
 */
const discoverAndValidate = Effect.fn('genie/discoverAndValidate')(function* (
  cwd: string,
  phase?: GeneratorPhase | undefined,
) {
  yield* Observability.annotatePath({ label: 'discover', path: cwd })
  const discoveredFiles = yield* findGenieFiles(cwd)
  const genieFiles = discoveredFiles.map((file) => path.resolve(cwd, file))

  const targetCounts = new Map<string, number>()
  for (const genieFilePath of genieFiles) {
    const targetFilePath = genieFilePath.replace('.genie.ts', '')
    targetCounts.set(targetFilePath, (targetCounts.get(targetFilePath) ?? 0) + 1)
  }
  const duplicateTargets = Array.from(targetCounts.entries()).filter(([, count]) => count > 1)
  assertNever({
    condition: duplicateTargets.length === 0,
    msg: () =>
      `Duplicate genie targets detected: ${duplicateTargets
        .map(([target, count]) => `${target} (${count}x)`)
        .join(', ')}`,
  })

  if (phase === undefined) return genieFiles

  const fs = yield* FileSystem.FileSystem
  const selected: string[] = []
  for (const genieFilePath of genieFiles) {
    const sourceText = yield* fs.readFileString(genieFilePath)
    if (parseGeneratorPhase(sourceText) === phase) selected.push(genieFilePath)
  }
  return selected
})

/** Compute summary counts from a list of successes and a failure count. */
const computeSummary = ({
  successes,
  failedCount,
}: {
  successes: Array<GenerateSuccess>
  failedCount: number
}): GenieSummary => ({
  created: successes.filter((s) => s._tag === 'created').length,
  updated: successes.filter((s) => s._tag === 'updated').length,
  unchanged: successes.filter((s) => s._tag === 'unchanged').length,
  skipped: successes.filter((s) => s._tag === 'skipped').length,
  failed: failedCount,
})

/** Run validation and emit error event on failure. Returns the error effect if validation fails. */
const runValidationOrFail = Effect.fn('genie/runValidationOrFail')(function* ({
  cwd,
  genieFiles,
  preloadedFiles,
}: {
  cwd: string
  genieFiles?: ReadonlyArray<string>
  preloadedFiles?: ReadonlyArray<LoadedGenieFile>
}) {
  yield* Observability.annotatePath({ label: 'validate', path: cwd })
  const validationResult = yield* runGenieValidation({
    cwd,
    ...(genieFiles !== undefined ? { genieFiles } : {}),
    ...(preloadedFiles !== undefined ? { preloadedFiles } : {}),
  }).pipe(Effect.result)
  if (validationResult._tag === 'Failure') {
    const error = validationResult.failure
    const message = error instanceof Error ? error.message : String(error)
    yield* emit({ _tag: 'Error', message })
    return yield* new GenieGenerationFailedError({
      failedCount: 1,
      message,
      files: [],
    })
  }

  const warnings = validationResult.success
  if (warnings.length > 0) {
    const formatted = formatValidationIssues(warnings)
    yield* emit({ _tag: 'ValidationWarnings', message: formatted })
  }
})

/** Generate files from all discovered .genie.ts sources. */
export const generateAll = ({
  cwd,
  readOnly,
  dryRun,
  oxfmtConfigPath,
  phase,
  validate = true,
}: CoreGenerateOptions): Effect.Effect<
  GenieGenerateResult,
  GenieGenerationFailedError | PlatformError,
  FileSystem.FileSystem | Path.Path | CommandExecutor.ChildProcessSpawner | GenieEventBus
> =>
  Effect.gen(function* () {
    const genieFiles = yield* discoverAndValidate(cwd, phase)

    if (genieFiles.length === 0) {
      const summary = computeSummary({ successes: [], failedCount: 0 })
      yield* emit({ _tag: 'Complete', summary })
      return { summary, files: [] }
    }

    yield* emit({
      _tag: 'FilesDiscovered',
      files: genieFiles.map((fp) => ({
        path: fp,
        relativePath: path.relative(cwd, fp.replace('.genie.ts', '')),
      })),
    })

    // Generate all files concurrently
    const results = yield* Effect.forEach(
      genieFiles,
      (genieFilePath) =>
        Effect.gen(function* () {
          yield* emit({ _tag: 'FileStarted', path: genieFilePath })

          const result = yield* generateFile({
            genieFilePath,
            cwd,
            readOnly,
            dryRun,
            oxfmtConfigPath,
          }).pipe(Effect.result)

          if (result._tag === 'Success') {
            const status = mapResultToStatus(result.success)
            yield* emit({
              _tag: 'FileCompleted',
              path: genieFilePath,
              status,
              ...(result.success._tag === 'updated' && result.success.diffSummary !== undefined
                ? { message: result.success.diffSummary }
                : {}),
            })
          } else {
            yield* emit({
              _tag: 'FileCompleted',
              path: genieFilePath,
              status: 'error',
              message: result.failure.message,
            })
          }

          return result
        }),
      { concurrency: 'unbounded' },
    )

    const successes = results.filter((r) => r._tag === 'Success').map((r) => r.success)
    const failures = results.filter((r) => r._tag === 'Failure').map((r) => r.failure)

    // Surface CatalogConflictError from initial failures before TDZ re-validation
    const catalogConflict = failures
      .map((f) => findCatalogConflictError(f.cause))
      .find((e) => e !== undefined)

    // Handle TDZ errors with sequential re-validation
    const hasTdzErrors = failures.some((f) => isTdzError(f.cause))

    if (failures.length > 0 && hasTdzErrors === true) {
      const revalidateErrors: Array<{
        genieFilePath: string
        error: ReturnType<typeof checkFile> extends Effect.Effect<any, infer E, any> ? E : never
        isRootCause: boolean
      }> = []

      for (const genieFilePath of genieFiles) {
        const result = yield* checkFile({ genieFilePath, cwd, oxfmtConfigPath }).pipe(Effect.result)

        if (result._tag === 'Failure') {
          revalidateErrors.push({
            genieFilePath,
            error: result.failure,
            isRootCause: errorOriginatesInFile({ error: result.failure, filePath: genieFilePath }),
          })
        }
      }

      const rootCauses = revalidateErrors.filter((e) => e.isRootCause)
      const dependentCount = revalidateErrors.length - rootCauses.length

      // Update state with revalidated errors
      for (const { genieFilePath, error, isRootCause } of revalidateErrors) {
        yield* emit({
          _tag: 'FileCompleted',
          path: genieFilePath,
          status: 'error',
          message: isRootCause === true ? error.message : 'Failed due to dependency error',
        })
      }

      const summary = computeSummary({ successes, failedCount: revalidateErrors.length })
      yield* emit({ _tag: 'Complete', summary })

      const catalogConflictHint =
        catalogConflict !== undefined ? `\n\nRoot cause: ${catalogConflict.message}` : ''

      return yield* new GenieGenerationFailedError({
        failedCount: revalidateErrors.length,
        message: `${rootCauses.length} root cause error(s), ${dependentCount} dependent failure(s)${catalogConflictHint}`,
        files: genieFiles.map((p) => {
          const reErr = revalidateErrors.find((e) => e.genieFilePath === p)
          return {
            path: p,
            relativePath: path.relative(cwd, p.replace('.genie.ts', '')),
            status: (reErr !== undefined ? 'error' : 'unchanged') as GenieFileStatus,
            message:
              reErr !== undefined
                ? reErr.isRootCause === true
                  ? reErr.error.message
                  : 'Failed due to dependency error'
                : undefined,
          }
        }),
      })
    }

    // No TDZ errors
    const summary = computeSummary({ successes, failedCount: failures.length })

    if (summary.failed > 0) {
      yield* emit({ _tag: 'Complete', summary })
      return yield* new GenieGenerationFailedError({
        failedCount: summary.failed,
        message: `${summary.failed} file(s) failed to generate`,
        files: genieFiles.map((p, i) => {
          const resultEither = results[i]!
          if (resultEither._tag === 'Success') {
            return {
              path: p,
              relativePath: path.relative(cwd, p.replace('.genie.ts', '')),
              status: mapResultToStatus(resultEither.success),
            }
          }
          return {
            path: p,
            relativePath: path.relative(cwd, p.replace('.genie.ts', '')),
            status: 'error' as GenieFileStatus,
            message: resultEither.failure.message,
          }
        }),
      })
    }

    // Run validation hooks after successful generation
    if (dryRun === false && validate === true) {
      yield* runValidationOrFail({ cwd, genieFiles })
    }

    yield* emit({ _tag: 'Complete', summary })
    return { summary, files: successes }
  }).pipe(
    Observability.withCommandSpan({
      label: dryRun === true ? 'dry-run' : readOnly === true ? 'generate' : 'generate-writable',
      cwd,
      readOnly,
      dryRun,
    }),
  )

/** Check that all generated files are up to date. */
export const checkAll = ({
  cwd,
  oxfmtConfigPath,
  phase,
}: CoreCheckOptions): Effect.Effect<
  void,
  GenieGenerationFailedError | PlatformError,
  FileSystem.FileSystem | Path.Path | CommandExecutor.ChildProcessSpawner | GenieEventBus
> =>
  Effect.gen(function* () {
    const checkConcurrency = Math.max(
      1,
      Math.min(
        typeof os.availableParallelism === 'function'
          ? os.availableParallelism()
          : os.cpus().length,
        12,
      ),
    )
    yield* Observability.annotateCommand({
      label: 'check',
      cwd,
      concurrency: checkConcurrency,
    })

    const genieFiles = yield* discoverAndValidate(cwd, phase)

    if (genieFiles.length === 0) {
      yield* emit({ _tag: 'Complete', summary: computeSummary({ successes: [], failedCount: 0 }) })
      return
    }

    yield* emit({
      _tag: 'FilesDiscovered',
      files: genieFiles.map((fp) => ({
        path: fp,
        relativePath: path.relative(cwd, fp.replace('.genie.ts', '')),
      })),
    })

    type FileCheckResult =
      | {
          _tag: 'success'
          path: string
          loadedGenieFile: LoadedGenieFile
        }
      | {
          _tag: 'error'
          path: string
          message: string
        }

    type FatalCheckFailure = {
      _tag: 'FatalCheckFailure'
      path: string
      message: string
    }

    const completedPathsRef = yield* Ref.make(new Set<string>())
    const resultByPathRef = yield* Ref.make(new Map<string, FileCheckResult>())

    const completeFile = Effect.fn('genie/checkAll/completeFile')(function* ({
      path: filePath,
      result,
    }: {
      path: string
      result: FileCheckResult
    }) {
      yield* Observability.annotateFile({
        label: Observability.relativePath({ cwd, filePath }),
        cwd,
        genieFilePath: filePath,
        targetFilePath: filePath.replace('.genie.ts', ''),
      })
      yield* emit({
        _tag: 'FileCompleted',
        path: filePath,
        status: result._tag === 'success' ? ('unchanged' as const) : ('error' as const),
        ...(result._tag === 'error' ? { message: result.message } : {}),
      })
      yield* Ref.update(resultByPathRef, (prev) => {
        const next = new Map(prev)
        next.set(filePath, result)
        return next
      })
      yield* Ref.update(completedPathsRef, (prev) => {
        const next = new Set(prev)
        next.add(filePath)
        return next
      })
    })

    const checkResult = yield* Effect.forEach(
      genieFiles,
      (genieFilePath) =>
        Effect.gen(function* () {
          yield* emit({ _tag: 'FileStarted', path: genieFilePath })

          const result = yield* checkFileDetailed({ genieFilePath, cwd, oxfmtConfigPath }).pipe(
            Effect.result,
          )

          if (result._tag === 'Success') {
            yield* completeFile({
              path: genieFilePath,
              result: {
                _tag: 'success',
                path: genieFilePath,
                loadedGenieFile: result.success.loadedGenieFile,
              },
            })
            return
          }

          const errorResult: FileCheckResult = {
            _tag: 'error',
            path: genieFilePath,
            message: result.failure.message,
          }
          yield* completeFile({ path: genieFilePath, result: errorResult })

          if (result.failure._tag === 'GenieCheckError') {
            return
          }

          return yield* Effect.fail<FatalCheckFailure>({
            _tag: 'FatalCheckFailure',
            path: genieFilePath,
            message: result.failure.message,
          })
        }),
      { concurrency: checkConcurrency },
    ).pipe(Effect.result)

    if (checkResult._tag === 'Failure') {
      const completedPaths = yield* Ref.get(completedPathsRef)
      const interruptedPaths = genieFiles.filter((p) => !completedPaths.has(p))

      for (const interruptedPath of interruptedPaths) {
        yield* completeFile({
          path: interruptedPath,
          result: {
            _tag: 'error',
            path: interruptedPath,
            message: 'Cancelled due to fatal error in another file',
          },
        })
      }

      const allResults = yield* Ref.get(resultByPathRef)
      const failed = Array.from(allResults.values()).filter((r) => r._tag === 'error').length
      const unchanged = Array.from(allResults.values()).filter((r) => r._tag === 'success').length

      const summary: GenieSummary = {
        created: 0,
        updated: 0,
        unchanged,
        skipped: 0,
        failed,
      }
      yield* emit({ _tag: 'Complete', summary })

      return yield* new GenieGenerationFailedError({
        failedCount: failed,
        message:
          interruptedPaths.length > 0
            ? `Fatal check error in ${path.relative(cwd, checkResult.failure.path)}; interrupted ${interruptedPaths.length} sibling file(s)`
            : `Fatal check error in ${path.relative(cwd, checkResult.failure.path)}`,
        files: genieFiles.map((p) => {
          const r = allResults.get(p)
          return {
            path: p,
            relativePath: path.relative(cwd, p.replace('.genie.ts', '')),
            status: (r?._tag === 'success' ? 'unchanged' : 'error') as GenieFileStatus,
            message: r?._tag === 'error' ? r.message : undefined,
          }
        }),
      })
    }

    const resultByPath = yield* Ref.get(resultByPathRef)
    const failed = Array.from(resultByPath.values()).filter((r) => r._tag === 'error').length

    if (failed > 0) {
      const summary: GenieSummary = {
        created: 0,
        updated: 0,
        unchanged: Array.from(resultByPath.values()).filter((r) => r._tag === 'success').length,
        skipped: 0,
        failed,
      }
      yield* emit({ _tag: 'Complete', summary })
      return yield* new GenieGenerationFailedError({
        failedCount: failed,
        message: `${failed} file(s) are out of date`,
        files: genieFiles.map((p) => {
          const r = resultByPath.get(p)
          return {
            path: p,
            relativePath: path.relative(cwd, p.replace('.genie.ts', '')),
            status: (r?._tag === 'success' ? 'unchanged' : 'error') as GenieFileStatus,
            message: r?._tag === 'error' ? r.message : undefined,
          }
        }),
      })
    }

    const preloadedFiles = Array.from(resultByPath.values())
      .filter((result): result is Extract<FileCheckResult, { _tag: 'success' }> => {
        return result._tag === 'success'
      })
      .map((result) => result.loadedGenieFile)

    yield* runValidationOrFail({ cwd, genieFiles, preloadedFiles })

    const summary: GenieSummary = {
      created: 0,
      updated: 0,
      unchanged: preloadedFiles.length,
      skipped: 0,
      failed: 0,
    }
    yield* emit({ _tag: 'Complete', summary })
  }).pipe(
    Observability.withCommandSpan({
      label: 'check',
      cwd,
    }),
  )
