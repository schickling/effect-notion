/** Utilities for filtering GitHub Actions log output. */

/** Lines of trailing context returned when no structured error is found. */
const FALLBACK_CONTEXT_LINES = 10

/** Indented lines kept from *before* an `error:` line (Nix prints the "while …" trace there). */
const MAX_LEADING_CONTEXT_LINES = 4

/** How far back to look for those leading context lines. */
const LEADING_CONTEXT_SCAN = 8

const isGenericError = (line: string): boolean => /Process completed with exit code/.test(line)

/**
 * A real error line starts with `error:` (Nix, cargo, tsc), possibly indented.
 * A mid-line `error:` is prose or a quoted command, not a failure.
 */
const startsWithError = (text: string): boolean => /^\s*error:/.test(text)

/**
 * Strip GitHub Actions line decoration: the timestamp prefix
 * (e.g. `2026-01-01T00:00:00.1234567Z `), ANSI styling and the trailing `\r`
 * of CRLF logs, preserving indentation.
 */
const undecorate = (line: string): string =>
  line
    .replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /, '')
    // oxlint-disable-next-line no-control-regex -- strips ANSI SGR sequences that GitHub keeps in raw logs
    .replace(/\u001B\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\r+$/, '')

/**
 * Downstream failures Nix reports for every dependent derivation. Only called
 * for lines that already satisfy `startsWithError`, so the indented `Reason:` /
 * `Output paths:` continuations are skipped by the caller's scan, not here.
 */
const isCascadeNoise = (stripped: string): boolean =>
  stripped.startsWith("error: Cannot build '") ||
  stripped.startsWith('error: Build failed due to failed dependency')

/** An undecorated log line plus whether it belongs to a step's echoed script. */
interface LogLine {
  readonly text: string
  readonly isScriptEcho: boolean
}

/**
 * Undecorate every line and mark the ones inside a step's echoed script
 * (`##[group]Run …` up to `##[endgroup]`). GitHub prints the whole `run:`
 * template there, so an `error:` inside it is source text — the step has not
 * executed yet — and must never be reported as a failure.
 */
const toLogLines = (logText: string): LogLine[] => {
  const result: LogLine[] = []
  let inScriptEcho = false
  for (const raw of logText.split('\n')) {
    const text = undecorate(raw)
    if (text.startsWith('##[group]')) {
      /**
       * Any group header closes the previous echo and only `Run …` opens a new
       * one, so an unbalanced or nested marker cannot swallow the rest of the log.
       */
      inScriptEcho = text.startsWith('##[group]Run ')
      result.push({ text, isScriptEcho: inScriptEcho })
      continue
    }
    if (text.startsWith('##[endgroup]')) {
      result.push({ text, isScriptEcho: inScriptEcho })
      inScriptEcho = false
      continue
    }
    result.push({ text, isScriptEcho: inScriptEcho })
  }
  return result
}

/** Which tier of {@link extractErrorTiers} produced the lines. */
type ErrorTier = 'gh-error' | 'nix-error' | 'tail'

/** Extracted error lines plus the tier that produced them. */
interface ErrorExtraction {
  readonly lines: string[]
  readonly tier: ErrorTier
}

/**
 * Extract error lines from GitHub Actions log text, reporting which tier won so
 * callers can tell a match from a fallback.
 *
 * Echoed step scripts are excluded from every tier — `run:` templates that
 * contain `echo "::error::…"` are source, not failures.
 *
 * `gh-error`: `##[error]` lines (GitHub Actions native errors).
 * `nix-error`: Nix `error:` blocks — includes indented continuation lines
 *         (e.g. `specified:` / `got:` after a hash mismatch) and
 *         deduplicates cascade noise (`Cannot build`, `Build failed`).
 * `tail`: The last lines leading up to the final `##[error]` marker (the
 *         failing step's tail), or the end of the log when there is none. This
 *         tier always yields something unless every line is an echo or blank.
 */
const extractErrorTiers = (logText: string): ErrorExtraction => {
  const lines = toLogLines(logText)

  /** Tier 1: GitHub Actions ##[error] lines */
  const ghErrors = lines
    .filter((line) => !line.isScriptEcho && line.text.includes('##[error]'))
    .map((line) => line.text.replace(/.*##\[error\]/, '').trim())

  if (ghErrors.length > 0 && !ghErrors.every(isGenericError)) {
    return { lines: ghErrors, tier: 'gh-error' }
  }

  /** Tier 2: Nix error blocks with surrounding continuation lines */
  const nixBlocks: string[][] = []
  let cascadeCount = 0
  let consumedUntil = -1

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.isScriptEcho) continue
    const stripped = line.text
    if (!startsWithError(stripped) || stripped.includes('##[error]')) continue

    if (isCascadeNoise(stripped)) {
      /** Skip cascade lines and their continuations */
      cascadeCount++
      while (i + 1 < lines.length) {
        const nextStripped = lines[i + 1]!.text
        if (/^\s/.test(nextStripped) && !startsWithError(nextStripped)) {
          i++
        } else {
          break
        }
      }
      consumedUntil = i
      continue
    }

    /**
     * Root-cause error. Nix puts the useful part *before* the `error:` line
     * (`× Failed to realize …`, `… while waiting for the build environment
     * for '/nix/store/….drv'`), so collect indented leading context too.
     */
    const leading: string[] = []
    const scanFloor = Math.max(consumedUntil, i - 1 - LEADING_CONTEXT_SCAN)
    for (let back = i - 1; back > scanFloor && leading.length < MAX_LEADING_CONTEXT_LINES; back--) {
      const candidate = lines[back]!
      if (candidate.isScriptEcho) break
      if (candidate.text.trim().length === 0) continue
      if (!/^\s/.test(candidate.text) || startsWithError(candidate.text)) break
      leading.unshift(candidate.text)
    }

    const block = [...leading, stripped]
    while (i + 1 < lines.length) {
      const nextStripped = lines[i + 1]!.text
      if (/^\s/.test(nextStripped) && !startsWithError(nextStripped)) {
        block.push(nextStripped)
        i++
      } else {
        break
      }
    }
    consumedUntil = i
    nixBlocks.push(block)
  }

  if (nixBlocks.length > 0) {
    const result = nixBlocks.flat()
    if (cascadeCount > 0) {
      result.push(
        `(${cascadeCount} downstream build failure${cascadeCount === 1 ? '' : 's'} omitted)`,
      )
    }
    return { lines: result, tier: 'nix-error' }
  }

  /**
   * Tier 3: trailing context. Anchor on the last `##[error]` so the failing
   * step's output wins over post-job steps (upload-artifact, cleanup) that
   * would otherwise fill the tail.
   */
  let anchor = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (!line.isScriptEcho && line.text.includes('##[error]')) {
      anchor = i
      break
    }
  }

  const context = (anchor === -1 ? lines : lines.slice(0, anchor + 1))
    .filter((line) => !line.isScriptEcho && line.text.trim().length > 0)
    .map((line) => line.text)

  return { lines: context.slice(-FALLBACK_CONTEXT_LINES), tier: 'tail' }
}

/** Extract error lines from GitHub Actions log text (see {@link extractErrorTiers}). */
export const extractErrorLines = (logText: string): string[] => extractErrorTiers(logText).lines

/** Filter log lines by case-insensitive pattern. */
export const grepLines = ({ logText, pattern }: { logText: string; pattern: string }): string[] =>
  logText.split('\n').filter((line) => line.toLowerCase().includes(pattern.toLowerCase()))

/** Lines chosen for display plus an optional notice about why they were chosen. */
export interface LogSelection {
  readonly lines: string[]
  readonly notice: string | null
}

/**
 * Pick the lines to display for one job.
 *
 * `--error` always shows something: a structured match, else the tail of the
 * log, else the raw log — with a notice saying which, because "no error lines"
 * is itself a useful finding (e.g. a job killed by the runner, or output GitHub
 * never marked up). A `--grep` that matches nothing falls back to the raw log
 * for the same reason; an empty job header tells the reader nothing.
 */
export const selectLogLines = ({
  logText,
  errorOnly,
  grep,
}: {
  logText: string
  errorOnly: boolean
  grep?: string | undefined
}): LogSelection => {
  if (errorOnly) {
    const { lines, tier } = extractErrorTiers(logText)
    if (lines.length === 0) {
      return {
        lines: logText.split('\n'),
        notice: 'No error lines matched — showing the raw log instead.',
      }
    }
    return {
      lines,
      /** Tier 3 is the plain tail of the log, not a match — say so. */
      notice:
        tier === 'tail' ? 'No structured error lines found — showing the tail of the log.' : null,
    }
  }

  if (grep !== undefined) {
    const matches = grepLines({ logText, pattern: grep })
    return matches.length > 0
      ? { lines: matches, notice: null }
      : {
          lines: logText.split('\n'),
          notice: `No lines matched '${grep}' — showing the raw log instead.`,
        }
  }

  return { lines: logText.split('\n'), notice: null }
}
