import { operationDispositionProjection } from './genie/buck2/operation-dispositions.ts'
import {
  projectionArtifact,
  projectionValidators,
} from './packages/@overeng/genie/src/runtime/mod.ts'

/**
 * Inspectable authority ledger for every public developer command root and generated CI job.
 *
 * Rows are deliberately dispositions, not task wiring: Buck-owned work is distinguished from
 * scheduled transfer and explicit policy exclusions without pretending cross-boundary orchestration
 * is a hermetic build action. Coverage tests fail when either public surface grows without a row.
 */
export default projectionArtifact.json({
  schemaVersion: 1,
  data: operationDispositionProjection,
  validators: [
    projectionValidators.uniqueValues({
      rule: 'buck2-operation-disposition-unique-developer-operation',
      label: 'buck2-operation-dispositions.json',
      values: ({ data }) => data.developerOperations.map(({ operation }) => operation),
    }),
    projectionValidators.uniqueValues({
      rule: 'buck2-operation-disposition-unique-ci-operation',
      label: 'buck2-operation-dispositions.json',
      values: ({ data }) => data.ciOperations.map(({ operation }) => operation),
    }),
  ],
})
