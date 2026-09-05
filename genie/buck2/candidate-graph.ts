import { javaScriptProductPublications } from './javascript-product-registry.ts'
import {
  authoritativeBuck2TypeScriptAdmissions,
  buck2TypeScriptAuthorityProjects,
  editorViewConsumerPackagePaths,
} from './typescript-admissions.ts'

/**
 * The complete Buck candidate graph, in the exact terms of the registries that own it.
 *
 * 03-materialization DQ1 asks whether CI can obtain the WHOLE candidate graph from the
 * shared cache, so this list is derived, never retyped: adding a package, an additional
 * typecheck project, or a product extends the proof automatically instead of silently
 * leaving a new action outside it.
 *
 * The five classes and why each is a distinct authority:
 *   typecheck          every root TypeScript project transferred to a package-local target,
 *                      including additional (non-default) project files
 *   dist               every package whose declarations and dist overlay Buck owns; strictly
 *                      smaller than the typecheck set because a typechecked package need not
 *                      emit
 *   editor_view_inputs one per admission: the editor projection surface the flip covers
 *   products           the tracked deployable products (same authority the tracked Buck
 *                      product tree is published from)
 *   support tools      the two cell-level Rust support tools every projection depends on
 */
const supportToolLabels = ['//buck2/toolchains:archive_tool', '//buck2/toolchains:product_tool']

/** Labels grouped by class, before cell qualification and de-duplication. */
export const buck2CandidateGraphClasses = {
  typecheck: buck2TypeScriptAuthorityProjects.map(({ typecheckTarget }) => typecheckTarget),
  dist: authoritativeBuck2TypeScriptAdmissions.map(({ distTarget }) => distTarget),
  editorViewInputs: editorViewConsumerPackagePaths.map((path) => `//${path}:editor_view_inputs`),
  products: javaScriptProductPublications.map(({ label }) => label),
  supportTools: supportToolLabels,
} as const satisfies Record<string, readonly string[]>

/** Cell-qualified, de-duplicated, byte-sorted labels. Buck accepts each of these directly. */
export const buck2CandidateGraphLabels: readonly string[] = [
  ...new Set(
    Object.values(buck2CandidateGraphClasses)
      .flat()
      .map((label) => `effect_utils${label}`),
  ),
].toSorted((left, right) => Buffer.from(left).compare(Buffer.from(right)))

/** Per-class unique label counts, asserted by the CI generator tests. */
export const buck2CandidateGraphClassCounts: Readonly<Record<string, number>> = Object.fromEntries(
  Object.entries(buck2CandidateGraphClasses).map(([name, labels]) => [
    name,
    new Set(labels).size,
  ]),
)
