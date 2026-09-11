import { buck2TestLanes } from './genie/buck2/typescript-admissions.ts'
import {
  projectionArtifact,
  projectionValidators,
} from './packages/@overeng/genie/src/runtime/mod.ts'

/**
 * Bridge between the Buck test authority and the source-side tasks that still drive it.
 *
 * Every row is derived from the package-local lane declaration that renders the Buck targets
 * it names, so a lane cannot exist on one side only. Nix, CI and the baseline collection
 * check read this file instead of restating the label, task and exclusion conventions; the
 * committed artifact is what makes those conventions inspectable in a diff.
 */
export default projectionArtifact.json({
  schemaVersion: 2,
  data: { lanes: buck2TestLanes },
  validators: [
    projectionValidators.uniqueValues({
      rule: 'buck2-test-authority-unique-target',
      label: 'buck2-test-authority.json',
      values: ({ data }) => data.lanes.map(({ target }) => target),
    }),
    projectionValidators.uniqueValues({
      rule: 'buck2-test-authority-unique-task',
      label: 'buck2-test-authority.json',
      values: ({ data }) =>
        data.lanes.flatMap(({ taskName, unboundedTaskName }) =>
          unboundedTaskName === undefined ? [taskName] : [taskName, unboundedTaskName],
        ),
    }),
    projectionValidators.uniqueValues({
      rule: 'buck2-test-authority-unique-collection-target',
      label: 'buck2-test-authority.json',
      values: ({ data }) =>
        data.lanes.flatMap(({ collectionTarget }) =>
          collectionTarget === undefined ? [] : [collectionTarget],
        ),
    }),
  ],
})
