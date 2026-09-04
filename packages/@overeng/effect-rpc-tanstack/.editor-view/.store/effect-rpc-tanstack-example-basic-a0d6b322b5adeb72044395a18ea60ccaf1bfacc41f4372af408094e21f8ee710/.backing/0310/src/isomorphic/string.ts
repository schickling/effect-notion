import { Schema } from 'effect'

/**
 * Schema for a non-empty string with no leading or trailing whitespace.
 *
 * The shared definition for the wire-level identifier/idempotency-key contract
 * that several packages hand-rolled as `NonEmptyString` + `isTrimmed`.
 * Compose with `Schema.brand` / `Schema.annotate` at each call site.
 */
export const nonEmptyTrimmedString = Schema.NonEmptyString.pipe(Schema.check(Schema.isTrimmed()))

/** Converts the first character of a string to lowercase */
export const lowercaseFirstChar = (str: string) => str.charAt(0).toLowerCase() + str.slice(1)

/** Converts the first character of a string to uppercase */
export const uppercaseFirstChar = (str: string) => str.charAt(0).toUpperCase() + str.slice(1)

/**
 * Render a non-`Error` cause defensively.
 *
 * Some causes have no primitive conversion path — e.g. null-prototype defect
 * objects under Effect 4 or a hostile `toString` — and `String()` throws
 * instead of rendering. Degrade to the cause's own `message`, then to JSON, so
 * error formatting can never be the crash itself.
 */
const renderCause = (cause: unknown): string => {
  try {
    return String(cause)
  } catch {
    /* Some causes have no primitive conversion path — e.g. null-prototype
     * defect objects under Effect 4 or a hostile `toString` — and `String()`
     * throws instead of rendering. Degrade to the cause's own `message`, then
     * to JSON, so error formatting itself can never be the crash. */
    if (typeof cause === 'object' && cause !== null && 'message' in cause) {
      const { message } = cause
      if (typeof message === 'string') return message
    }
    try {
      return JSON.stringify(cause) ?? '[unrenderable cause]'
    } catch {
      return '[unrenderable cause]'
    }
  }
}

/**
 * Format the human-readable `message` for a tagged "reason" error.
 *
 * The SSOT for the `get message()` body our tagged errors hand-copy (e.g.
 * `RestateError`, `PtyError`): space-join the `reason` discriminator, an optional
 * `[label]` (a key/name that scopes the failure), the `(method)` that failed, and
 * `: <cause.message>` (or `: <String(cause)>` for a non-`Error` cause, falling
 * back to `cause.message` / JSON when the value has no primitive conversion
 * path — e.g. null-prototype defect objects under Effect 4). Omitted
 * parts are dropped. The cause segment is space-separated like the others, so it
 * reads `... (method) : message` — preserving the existing `RestateError` /
 * `PtyError` output verbatim (this is a behavior-preserving consolidation).
 *
 * ```ts
 * formatReasonMessage({ reason: 'IngressFailed', method: 'call', cause: err })
 * // → "IngressFailed (call) : connection refused"
 * formatReasonMessage({ reason: 'WriteFailed', label: 'sess-1', method: 'press' })
 * // → "WriteFailed [sess-1] (press)"
 * ```
 */
export const formatReasonMessage = (input: {
  readonly reason: string
  readonly label?: string | undefined
  readonly method?: string | undefined
  readonly cause?: unknown
}): string => {
  const parts: string[] = [input.reason]
  if (input.label !== undefined) parts.push(`[${input.label}]`)
  if (input.method !== undefined) parts.push(`(${input.method})`)
  if (input.cause instanceof Error) parts.push(`: ${input.cause.message}`)
  else if (input.cause !== undefined) parts.push(`: ${renderCause(input.cause)}`)
  return parts.join(' ')
}

const GERMAN_ASCII: Readonly<Record<string, string>> = {
  ä: 'ae',
  ö: 'oe',
  ü: 'ue',
  Ä: 'Ae',
  Ö: 'Oe',
  Ü: 'Ue',
  ß: 'ss',
  ẞ: 'Ss',
}

/**
 * Converts a title into a URL-safe lowercase ASCII slug (max 120 chars).
 *
 * German letters are transliterated before NFKD decomposition so their
 * conventional vowel survives; remaining combining marks are removed.
 * Non-alphanumeric runs become single hyphens; leading/trailing hyphens are trimmed.
 * Returns `"untitled"` for blank or all-punctuation titles.
 */
export const titleSlug = (title: string): string => {
  const slug = title
    .replace(/[äöüÄÖÜßẞ]/gu, (letter) => GERMAN_ASCII[letter] ?? letter)
    .normalize('NFKD')
    .replace(/\p{Mark}+/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
    .replace(/-+$/g, '')

  return slug.length > 0 ? slug : 'untitled'
}
