/**
 * Megarepo Generators
 *
 * Generators create/update configuration files in the megarepo based on its members.
 */

import { Effect } from 'effect'

import type { AbsoluteDirPath, AbsoluteFilePath, MegarepoConfig } from '../core/config.ts'
import { generateVscode } from './vscode.ts'

export * from '../composition/root/composition-root.ts'
export * from '../composition/root/composition-root-publisher.ts'
export * from './schema.ts'
export * from './vscode.ts'

/** Output types from generator functions */
export type GeneratorOutput = { readonly _tag: 'vscode'; readonly path: AbsoluteFilePath }

/** Options for running all generators */
export interface GenerateAllOptions {
  /** Path to the nearest megarepo root */
  readonly megarepoRoot: AbsoluteDirPath
  /** Path to the outermost megarepo root (unused but kept for API compat) */
  readonly outermostRoot: AbsoluteDirPath
  /** The megarepo config */
  readonly config: MegarepoConfig
}

/** Get list of generators that would run based on config */
export const getEnabledGenerators = (config: MegarepoConfig): string[] => {
  const generators: string[] = []
  if (config.generators?.vscode?.enabled === true) {
    generators.push('.vscode/megarepo.code-workspace')
  }
  if (config.generators?.composition?.enabled === true) {
    generators.push('.buckroot', '.buckconfig', '.watchmanconfig', 'BUCK', '.megarepo/bin/buck2')
  }
  return generators
}

/** Run all enabled generators and return their outputs */
export const generateAll = Effect.fn('megarepo/generate/all')((options: GenerateAllOptions) =>
  Effect.gen(function* () {
    const outputs: GeneratorOutput[] = []
    const vscodeEnabled = options.config.generators?.vscode?.enabled === true

    if (vscodeEnabled === true) {
      const vscodeResult = yield* generateVscode({
        megarepoRoot: options.megarepoRoot,
        config: options.config,
      })
      outputs.push({ _tag: 'vscode', path: vscodeResult.path })
    }

    return outputs
  }),
)
