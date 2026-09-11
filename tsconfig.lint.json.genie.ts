import { rootTsconfigProjects } from './genie/tsconfig-projects.ts'
import { tsconfigJson, type TSConfigArgs } from './packages/@overeng/genie/src/runtime/mod.ts'

/** Non-producing project graph spanning all Buck-owned projects for oxlint's type-aware rules. */
export default tsconfigJson({
  files: [],
  references: rootTsconfigProjects
    .map((project) => ({ path: `./${project.path}` }))
    .toSorted((left, right) => left.path.localeCompare(right.path)),
} satisfies TSConfigArgs)
