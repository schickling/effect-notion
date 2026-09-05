/**
 * Buck declares every host executable a test may spawn as `tools = { ENV_NAME: <support_tool> }`.
 * The runner exports each name as an exact `/nix/store/<realization>/bin/<exe>` path, so tests
 * name tools through these variables only — never through an ambient PATH lookup.
 */

/** Reads one Buck-declared immutable tool path out of an explicit environment. */
export const requireToolFrom = ({
  env,
  name,
}: {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly name: string
}): string => {
  const tool = env[name]
  if (tool === undefined || tool === '')
    throw new Error(`declared test tool is unavailable: ${name}`)
  return tool
}

/** Reads one Buck-declared immutable tool path; nothing resolves through an ambient PATH. */
export const requireTool = (name: string): string => requireToolFrom({ env: process.env, name })
