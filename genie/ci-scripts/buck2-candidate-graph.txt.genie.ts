import { createGenieOutput } from '../../packages/@overeng/genie/src/runtime/core.ts'
import { buck2CandidateGraphLabels } from '../buck2/candidate-graph.ts'

/**
 * The complete Buck candidate graph as one label per line, consumed by
 * `genie/ci-scripts/buck2-cache-lane.sh`.
 *
 * A file rather than an inline argument list: 127 labels inlined twice into `ci.yml` would
 * add ~18 KB of generated YAML against a 460 KB admission-size warning threshold, and a
 * single generated artifact is what the CI generator tests assert coverage against.
 */
const content = `${buck2CandidateGraphLabels.join('\n')}\n`

export default createGenieOutput({
  data: buck2CandidateGraphLabels,
  stringify: () => content,
})
