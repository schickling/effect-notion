/**
 * How the gate's project annotation stack is assembled.
 *
 * Its own module so the shape can be asserted without loading `./setup.ts`,
 * which only resolves inside a Storybook-built Vitest browser project (it
 * imports the builder's virtual project-annotations module and `vitest/browser`
 * through `./annotations.ts`).
 *
 * @module
 */

/**
 * The layer that pins one themed project's Storybook globals.
 *
 * The key is `initialGlobals`, NOT `globals`. Storybook 10.6 reads a project
 * annotation's `initialGlobals` as the starting global state and ignores an
 * unknown `globals` key entirely, so a stack built with `globals` renders every
 * theme project with the preview's default globals — two projects, identical
 * screenshots, and a gate that reports a passing dark theme it never rendered.
 */
export interface GateGlobalsAnnotation {
  readonly initialGlobals: Record<string, unknown>
}

/**
 * Order the annotation layers the gate installs.
 *
 * Later layers win in Storybook's composition, so the theme pin and the gate's
 * own play/loader wrapper both sit after the consumer's preview annotations.
 */
export const composeGateProjectAnnotations = <Annotation extends object>({
  base,
  initialGlobals,
  gate,
}: {
  /** The consumer preview's annotations, as the builder hands them over. */
  readonly base: Annotation | readonly Annotation[]
  /** Globals to pin for this project; empty when the gate runs unthemed. */
  readonly initialGlobals: Record<string, unknown>
  readonly gate: Annotation
}): readonly (Annotation | GateGlobalsAnnotation)[] => [
  ...(Array.isArray(base) === true ? (base as readonly Annotation[]) : [base as Annotation]),
  { initialGlobals },
  gate,
]
