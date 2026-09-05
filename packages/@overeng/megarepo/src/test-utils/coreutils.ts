import { constants } from 'node:fs'
import { access, lstat, realpath } from 'node:fs/promises'
import * as NodePath from 'node:path'

import { compositionRuntimeEnvironmentNames } from '../composition/apply/composition-runtime.ts'
import { requireToolFrom } from './require-tool.ts'

const toolNames = ['cp', 'mv'] as const
type CoreutilsTool = (typeof toolNames)[number]

/** Buck declares the pinned coreutils members these tests spawn; nothing is looked up on PATH. */
const declaredToolNames = { cp: 'CP_BIN', mv: 'MV_BIN' } as const

const validateExecutable = async ({
  name,
  path,
  source,
}: {
  readonly name: CoreutilsTool
  readonly path: string
  readonly source: string
}): Promise<string> => {
  if (
    NodePath.isAbsolute(path) === false ||
    NodePath.normalize(path) !== path ||
    NodePath.basename(path) !== name
  ) {
    throw new TypeError(`${source} must provide an exact normalized absolute ${name} path`)
  }
  const target = await realpath(path)
  const info = await lstat(target)
  if (info.isFile() === false) {
    throw new TypeError(`${source} ${name} target is not a regular file: ${target}`)
  }
  await access(target, constants.X_OK)
  return path
}

/**
 * Resolve exact cp/mv paths from a complete composition-runtime injection, otherwise from the
 * Buck-declared `CP_BIN`/`MV_BIN` tool paths. There is no PATH fallback.
 */
export const resolvePinnedCoreutils = async ({
  env = process.env,
}: {
  readonly env?: Readonly<Record<string, string | undefined>>
} = {}): Promise<{ readonly cpPath: string; readonly mvPath: string }> => {
  const injected = {
    cp: env[compositionRuntimeEnvironmentNames.cpPath],
    mv: env[compositionRuntimeEnvironmentNames.mvPath],
  }
  const injectedCount = toolNames.filter((name) => injected[name] !== undefined).length
  if (injectedCount !== 0 && injectedCount !== toolNames.length) {
    throw new TypeError('Pinned coreutils injection must provide both cp and mv')
  }
  if (injectedCount === toolNames.length) {
    return {
      cpPath: await validateExecutable({
        name: 'cp',
        path: injected.cp!,
        source: compositionRuntimeEnvironmentNames.cpPath,
      }),
      mvPath: await validateExecutable({
        name: 'mv',
        path: injected.mv!,
        source: compositionRuntimeEnvironmentNames.mvPath,
      }),
    }
  }

  return {
    cpPath: await validateExecutable({
      name: 'cp',
      path: requireToolFrom({ env, name: declaredToolNames.cp }),
      source: declaredToolNames.cp,
    }),
    mvPath: await validateExecutable({
      name: 'mv',
      path: requireToolFrom({ env, name: declaredToolNames.mv }),
      source: declaredToolNames.mv,
    }),
  }
}
