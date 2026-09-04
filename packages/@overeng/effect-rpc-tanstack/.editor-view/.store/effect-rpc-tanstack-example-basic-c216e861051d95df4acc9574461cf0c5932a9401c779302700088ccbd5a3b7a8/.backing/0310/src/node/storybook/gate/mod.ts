/**
 * Story-driven visual + accessibility gate.
 *
 * `createStoryGateConfig` builds the Vitest configuration a package's
 * `vitest.gate.config.ts` exports; `runStoryGate` derives the baseline from a
 * git ref and runs both sides on one host.
 *
 * @module
 */

export {
  baselineDirEnvVar,
  createStoryGateConfig,
  manifestEnvVar,
  type StoryGateConfigOptions,
  type StoryGateTheme,
} from './project.ts'
export {
  runStoryGate,
  type StoryGateChange,
  type StoryGateChangeKind,
  type StoryGateReport,
  type StoryGateRunOptions,
} from './run.ts'
