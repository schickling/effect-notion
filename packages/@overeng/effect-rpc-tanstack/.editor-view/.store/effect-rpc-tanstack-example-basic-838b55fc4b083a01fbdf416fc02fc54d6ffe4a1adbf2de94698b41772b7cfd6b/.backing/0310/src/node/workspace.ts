import path from 'node:path'

import { Context, Effect, Layer } from 'effect'

import { shouldNeverHappen } from '../isomorphic/mod.ts'

/** Workspace path string (alias for documentation clarity). */
export type WorkspaceInfo = string

/** Current working directory. */
export class CurrentWorkingDirectory extends Context.Service<
  CurrentWorkingDirectory,
  WorkspaceInfo
>()('CurrentWorkingDirectory') {
  /** Layer that captures the process cwd once. */
  static live = Layer.effect(
    CurrentWorkingDirectory,
    Effect.sync(() => process.cwd()),
  )

  /** Override CWD for tests or nested invocations. */
  static fromPath = (cwd: string) => Layer.succeed(CurrentWorkingDirectory, cwd)
}

/** Workspace root (env required). */
export class EffectUtilsWorkspace extends Context.Service<EffectUtilsWorkspace, WorkspaceInfo>()(
  'EffectUtilsWorkspace',
) {
  /** Resolve from WORKSPACE_ROOT env. */
  static live = Layer.effect(
    EffectUtilsWorkspace,
    Effect.sync(() => {
      const root = process.env.WORKSPACE_ROOT ?? shouldNeverHappen('WORKSPACE_ROOT is not set')
      return root
    }),
  )

  /** Provide a fixed workspace root. */
  static fromPath = (root: string) => Layer.succeed(EffectUtilsWorkspace, root)

  /** Derive a CurrentWorkingDirectory layer from the workspace root (with optional subpath). */
  static toCwd = (/** Relative path to the workspace root */ subPath?: string) =>
    Layer.effect(
      CurrentWorkingDirectory,
      Effect.gen(function* () {
        const root = yield* EffectUtilsWorkspace
        return path.join(root, subPath ?? '')
      }),
    )
}
