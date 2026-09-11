import { Context, Effect, Layer } from 'effect'

/**
 * Stable, CLI-facing stage vocabulary for a write-path sync (R43). These ids are
 * a presentation contract distinct from the OTEL span names (which stay on the
 * `notion_md.*` namespace, decision 0018); a stage may map to several spans or
 * none.
 */
export type ProgressStageId = 'observe' | 'write-body' | 'write-title' | 'settle'

/** A single staged transition the engine emits to the reporter. */
export interface ProgressStage {
  readonly id: ProgressStageId
  readonly label: string
  readonly message?: string
}

/**
 * The render seam (R45): the engine emits purpose-tagged stage transitions; the
 * provided Layer decides whether/how to render. Every method returns
 * `Effect.Effect<void>` so a renderer can do I/O, and the no-op/absent Layer
 * makes the whole surface zero-cost and behavior-neutral.
 */
export interface ProgressReporterShape {
  readonly stageActive: (stage: ProgressStage) => Effect.Effect<void>
  readonly stageSucceed: (stage: ProgressStage) => Effect.Effect<void>
  readonly stageSkip: (stage: ProgressStage) => Effect.Effect<void>
  readonly stageFail: (stage: ProgressStage) => Effect.Effect<void>
  /** Free-form stderr note for the "+ warn" outcomes (drift auto-merge / conflict). */
  readonly note: (message: string) => Effect.Effect<void>
}

/** Render seam for staged write-path sync progress (decision 0018, R43–R45).
 * Defaults lazily to a no-op reporter when not explicitly provided; an explicit
 * `Layer.succeed`/`Effect.provideService` always wins. */
export const ProgressReporter: Context.Reference<ProgressReporterShape> =
  Context.Reference<ProgressReporterShape>('ProgressReporter', {
    defaultValue: () => ({
      stageActive: () => Effect.void,
      stageSucceed: () => Effect.void,
      stageSkip: () => Effect.void,
      stageFail: () => Effect.void,
      note: () => Effect.void,
    }),
  })

/**
 * Emit a reporter call without adding to the engine's `R`, and swallowing ALL
 * failures and defects (R45): a render glitch can never change a result or exit
 * code. Reading the Reference contributes nothing to `R`, so the engine stays
 * render-agnostic; without an explicit provision the lazy default is a silent
 * no-op.
 */
const emit = (f: (r: ProgressReporterShape) => Effect.Effect<void>): Effect.Effect<void> =>
  Effect.flatMap(ProgressReporter, f).pipe(Effect.ignoreCause)

/** Emit an `active` transition for a stage. */
export const reportStageActive = (stage: ProgressStage): Effect.Effect<void> =>
  emit((r) => r.stageActive(stage))

/** Emit a `succeed` transition for a stage. */
export const reportStageSucceed = (stage: ProgressStage): Effect.Effect<void> =>
  emit((r) => r.stageSucceed(stage))

/** Emit a `skip` transition for a stage (a no-op step the user should still see). */
export const reportStageSkip = (stage: ProgressStage): Effect.Effect<void> =>
  emit((r) => r.stageSkip(stage))

/** Emit a `fail` transition for a stage. */
export const reportStageFail = (stage: ProgressStage): Effect.Effect<void> =>
  emit((r) => r.stageFail(stage))

/** Emit a free-form stderr note (the drift auto-merge / conflict warnings). */
export const reportNote = (message: string): Effect.Effect<void> => emit((r) => r.note(message))

/**
 * Wrap an effect as a single stage: emit `active` before it runs, `succeed`
 * (with the optional done message) on success, and `fail` on error. Preserves
 * the wrapped effect's `A`/`E`/`R` exactly — the emit helpers are
 * `Effect<void, never, never>`, so the engine's signatures do not change.
 */
// oxlint-disable-next-line overeng/named-args -- data-last Effect combinator (stage config + wrapped effect)
export const withStage = <A, E, R>(
  stage: { readonly id: ProgressStageId; readonly label: string; readonly doneMessage?: string },
  eff: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  reportStageActive(stage).pipe(
    Effect.andThen(eff),
    Effect.tap(() =>
      reportStageSucceed(
        stage.doneMessage === undefined ? stage : { ...stage, message: stage.doneMessage },
      ),
    ),
    Effect.tapCause(() => reportStageFail(stage)),
  )

/** Write a single line to stderr (no animated control sequences). */
const writeLine = (line: string): Effect.Effect<void> =>
  Effect.sync(() => void process.stderr.write(`${line}\n`))

/**
 * Live stderr-line renderer (decision 0018 "static line" rung): tasteful
 * sequential lines, no cursor control. Deliberately NOT the animated
 * `@overeng/tui-react` `TaskList` — `edit` returns from a full-screen editor
 * that owned the TTY, and a mounting TUI would fight the terminal; sequential
 * lines also sidestep the #787 module-load TDZ (no `createTuiApp`). The
 * `ProgressReporter` Tag seam lets the animated `TaskList` Layer drop in later
 * with no engine re-touch.
 */
export const ProgressReporterStderrLines: Layer.Layer<never> = Layer.succeed(ProgressReporter, {
  stageActive: (stage) => writeLine(`  · ${stage.label} …`),
  stageSucceed: (stage) =>
    writeLine(
      stage.message === undefined ? `  ✓ ${stage.label}` : `  ✓ ${stage.label}  ${stage.message}`,
    ),
  stageSkip: (stage) => writeLine(`  · ${stage.label} (skipped)`),
  stageFail: (stage) => writeLine(`  ✗ ${stage.label}`),
  note: (message) => writeLine(`note: ${message}`),
} satisfies ProgressReporterShape)

/**
 * Explicit no-op Layer for tests/clarity. (The Reference default already no-ops;
 * this just makes the intent provable.)
 */
export const ProgressReporterNoop: Layer.Layer<never> = Layer.succeed(ProgressReporter, {
  stageActive: () => Effect.void,
  stageSucceed: () => Effect.void,
  stageSkip: () => Effect.void,
  stageFail: () => Effect.void,
  note: () => Effect.void,
} satisfies ProgressReporterShape)
