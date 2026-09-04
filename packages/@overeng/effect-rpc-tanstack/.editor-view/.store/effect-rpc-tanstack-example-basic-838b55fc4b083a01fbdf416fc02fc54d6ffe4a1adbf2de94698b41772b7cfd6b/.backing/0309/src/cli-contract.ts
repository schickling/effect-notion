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

/**
 * Absolute path prefix of an installed dependency, up to and including its last
 * `node_modules/` segment. The prefix depends on how dependencies were
 * materialized (a pnpm virtual store, a Buck dependency view, a hoisted tree),
 * while the package-relative remainder does not.
 */
const MODULE_PATH_PREFIX_PATTERN = /\/\S*\/node_modules\//gu

/** Replacement token written into the baseline in place of a log timestamp. */
export const TIME_TOKEN = '[time]'

/** Replacement token written into the baseline in place of the checkout root. */
export const REPO_TOKEN = '<repo>'

/** Replacement token written into the baseline in place of a dependency-install prefix. */
export const MODULE_PATH_TOKEN = '<node_modules>/'

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
   * Mask the absolute install prefix of dependency paths (everything up to and
   * including the last `node_modules/` segment) as `<node_modules>/`, so the
   * dependency materialization layout — pnpm virtual store, Buck dependency
   * view, hoisted tree — does not gate the baseline while the
   * package-relative file, line, and column still do. Default: `false`.
   */
  readonly modulePaths?: boolean | undefined
}

/**
 * Normalizes raw CLI stdout/stderr for snapshot comparison against a contract
 * baseline. See {@link NormalizeCliOutputPolicy} for the per-option masking
 * policy; the ` — running from local source (...)` version suffix is always
 * masked.
 *
 * @example
 * normalizeCliOutput({ input: result.stdout, ansi: true, time: true, modulePaths: true, repoRoot })
 */
export const normalizeCliOutput = ({
  input,
  ansi = false,
  time = false,
  modulePaths = false,
  repoRoot,
}: NormalizeCliOutputPolicy): string => {
  let output = input
  if (ansi === true) output = output.replace(ANSI_PATTERN, '')
  if (time === true) output = output.replace(LOG_TIME_PATTERN, TIME_TOKEN)
  if (modulePaths === true) output = output.replace(MODULE_PATH_PREFIX_PATTERN, MODULE_PATH_TOKEN)
  if (repoRoot !== undefined) {
    if (repoRoot === '') throw new Error('normalizeCliOutput: repoRoot must be non-empty')
    output = output.replaceAll(repoRoot, REPO_TOKEN)
  }
  return output.replace(LOCAL_SOURCE_SUFFIX_PATTERN, '')
}
