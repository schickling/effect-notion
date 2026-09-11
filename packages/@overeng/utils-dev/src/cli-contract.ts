/**
 * Shared normalization for CLI contract baselines (`cli.contract.test.ts`).
 *
 * Each option masks one machine-specific token class; options default to
 * `false`, so each consumer states an explicit policy and silent drift between
 * copies cannot happen. The local-source version suffix is always masked,
 * because every contract test needs it regardless of policy.
 */

/** Broad ANSI/ECMA-48 control-sequence matcher used by the CLI contract baselines. */
const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex -- CLI contract snapshots intentionally normalize terminal control bytes.
  /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/gu

const LOG_TIME_PATTERN = /^\[\d{2}:\d{2}:\d{2}\.\d{3}\]/gmu

/** Version suffix appended by locally checked-out CLIs (` — running from local source (...)`). */
const LOCAL_SOURCE_SUFFIX_PATTERN = / — running from local source \([^)]+\)/gu
const EFFECT_CLI_FIBER_PATTERN = /(?<=ERROR \(#)\d+(?=\): ~effect\/cli\/)/gu

const EFFECT_CLI_FRAME_PATTERN =
  /effect@4\.0\.0-rc\.\d+\/node_modules\/effect\/dist\/unstable\/cli\/Command\.js:\d+:\d+/gu

/** Replacement token written into the baseline in place of a log timestamp. */
export const TIME_TOKEN = '[time]'

/** Replacement token written into the baseline in place of the checkout root. */
export const REPO_TOKEN = '<repo>'

/** Raw CLI output plus the explicit masking policy applied before baseline comparison. */
export interface NormalizeCliOutputPolicy {
  /** Raw CLI stdout/stderr captured from the spawned contract run. */
  readonly input: string
  /**
   * Strip ANSI control sequences so colour/styling changes do not gate the
   * baseline. Default: `false`.
   */
  readonly ansi?: boolean | undefined
  /**
   * Mask `[HH:MM:SS.mmm]` log timestamps as `[time]` so log timing does not
   * gate the baseline. Default: `false`.
   */
  readonly time?: boolean | undefined
  /**
   * Replace occurrences of the given checkout-root path with `<repo>` so
   * machine-specific absolute paths (e.g. embedded stack frames) do not gate
   * the baseline. Root discovery stays caller-specific. Default: not applied.
   */
  readonly repoRoot?: string | undefined
  /**
   * Mask volatile Effect CLI fiber ids, package prerelease versions, and
   * internal source positions. Default: `false`.
   */
  readonly effectCliInternals?: boolean | undefined
}

/**
 * Normalizes raw CLI stdout/stderr for snapshot comparison against a contract
 * baseline. See {@link NormalizeCliOutputPolicy} for the per-option masking
 * policy; the ` — running from local source (...)` version suffix is always
 * masked.
 *
 * @example
 * normalizeCliOutput({ input: result.stdout, ansi: true, time: true, repoRoot })
 */
export const normalizeCliOutput = ({
  input,
  ansi = false,
  time = false,
  repoRoot,
  effectCliInternals = false,
}: NormalizeCliOutputPolicy): string => {
  let output = input
  if (ansi === true) output = output.replace(ANSI_PATTERN, '')
  if (time === true) output = output.replace(LOG_TIME_PATTERN, TIME_TOKEN)
  if (repoRoot !== undefined) {
    if (repoRoot === '') throw new Error('normalizeCliOutput: repoRoot must be non-empty')
    output = output.replaceAll(repoRoot, REPO_TOKEN)
  }
  if (effectCliInternals === true) {
    output = output
      .replace(EFFECT_CLI_FIBER_PATTERN, '<fiber>')
      .replace(
        EFFECT_CLI_FRAME_PATTERN,
        'effect@<version>/node_modules/effect/dist/unstable/cli/Command.js:<line>:<column>',
      )
  }
  return output.replace(LOCAL_SOURCE_SUFFIX_PATTERN, '')
}
