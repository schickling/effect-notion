import { Option } from 'effect'
import type * as Cause from 'effect/Cause'

import { compactFormatError } from '@overeng/tui-react/node'

/**
 * Exit status for a failure that is *not* a CI verdict: auth, network, a bug in
 * this tool. The verdict codes are decided by the renderers' `exitCode` mappers
 * (0 pass, 1 fail, 2 timeout, 3 no checks) and 130 is Ctrl-C, so a caller — a
 * script or an agent — can only tell "the tool broke" from "CI is red" if the
 * tool-failure case has a code of its own.
 */
export const TOOL_FAILURE_EXIT_CODE = 4

/**
 * Env var the agent `gh` wrapper sets before it routes a `gh run *` call here.
 * Its value names the router; only its presence changes what we print.
 */
export const ROUTED_FROM_ENV_VAR = 'GH_CI_UTILS_ROUTED_FROM'

/**
 * The wrapper `exec`s into this tool, so a routed agent has no shell left to be
 * told that the raw CLI is still reachable — we have to say it ourselves.
 */
const escapeHatchLine =
  "the raw GitHub CLI is available as 'gh-real ...' (e.g. 'gh-real run view --log-failed <run-id>')"

/**
 * Render the stderr block for a tool failure: one compact line naming the error
 * (no `/$bunfs/root/...` stack an agent cannot act on), plus the `gh-real`
 * escape hatch when the call arrived through the agent `gh` wrapper.
 */
export const renderToolFailure = ({
  cause,
  routedFrom,
}: {
  cause: Cause.Cause<unknown>
  routedFrom: string | undefined
}): string => {
  const message = Option.getOrElse(
    compactFormatError(cause),
    () => 'gh-ci-utils failed without reporting an error',
  )
  // An exported-but-empty env var is not a router; treat it as absent.
  return routedFrom === undefined || routedFrom.length === 0
    ? message
    : `${message}\n${escapeHatchLine}`
}
