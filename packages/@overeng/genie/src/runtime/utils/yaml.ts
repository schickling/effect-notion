/**
 * Simple YAML stringifier for GitHub Actions workflows
 * Handles the subset of YAML features needed for workflows
 *
 * Comment support:
 * - Use `$comment` key in objects to add a comment before the object's content
 * - Comments are rendered as YAML comments (# prefix)
 */

const INDENT = '  '

/** Symbol for comment values that should render as YAML comments */
export const COMMENT_KEY = '$comment'

/**
 * A string whose entire content is a single `${{ … }}` GitHub Actions expression.
 * In block-style YAML (mapping values, sequence items) these can be emitted
 * unquoted — GitHub evaluates the expression either way, and unquoted is the
 * idiomatic style in workflow files.
 *
 * Flow sequences (inline `[a, b]` arrays) still need quoting because `{{` is
 * ambiguous with YAML flow-mapping syntax — that path uses `quoteString`
 * directly and is unaffected by this helper.
 */
const isPureExpression = (str: string): boolean => {
  const trimmed = str.trim()
  return trimmed.startsWith('${{') && trimmed.endsWith('}}') && trimmed.indexOf('${{', 3) === -1
}

const needsQuoting = ({ str, flow = false }: { str: string; flow?: boolean }): boolean => {
  if (str === '') return true
  if (str === 'true' || str === 'false' || str === 'null') return true
  if (/^\d+$/.test(str) === true || /^\d+\.\d+$/.test(str) === true) return true
  // Always quote strings containing ${{ - in flow sequences (inline arrays),
  // {{ is interpreted as nested flow mapping start, causing YAML parse errors.
  // GitHub Actions evaluates expressions inside quoted strings, so this is safe.
  if (str.includes('${{') === true) return true
  if (/^[{[\]!@#%&*|>?]/.test(str) === true) return true
  if (/[:#]/.test(str) === true) return true
  if (str.includes('\n') === true) return true
  // In FLOW context (inline arrays `[a, b]`), `{}[],` are structural delimiters, so a scalar
  // containing them mid-string (e.g. a route template `/v1/pages/{id}`) breaks the sequence.
  // They are harmless in block scalars (briefs with commas stay unquoted), so gate on `flow`.
  if (flow === true && /[{}[\],]/.test(str) === true) return true
  return false
}

/** Quote a key if it needs quoting (e.g., starts with @) */
const quoteKey = (key: string): string => (needsQuoting({ str: key }) === true ? `"${key}"` : key)

const quoteString = ({
  str,
  indent,
  flow = false,
}: {
  str: string
  indent: number
  flow?: boolean
}): string => {
  if (str.includes('\n') === true) {
    const linePrefix = INDENT.repeat(indent)
    return `|\n${str
      .split('\n')
      .map((line) => (line === '' ? '' : linePrefix + line))
      .join('\n')}`
  }
  if (needsQuoting({ str, flow }) === true) {
    // Prefer single quotes, fall back to double quotes if string contains single quotes
    if (str.includes("'") === true) {
      return `"${str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    }
    return `'${str}'`
  }
  return str
}

const stringifyValue = ({ value, indent }: { value: unknown; indent: number }): string => {
  if (value === null || value === undefined) {
    return 'null'
  }

  if (typeof value === 'boolean') {
    return value === true ? 'true' : 'false'
  }

  if (typeof value === 'number') {
    return String(value)
  }

  if (typeof value === 'string') {
    if (isPureExpression(value) === true) return value
    return quoteString({ str: value, indent })
  }

  if (Array.isArray(value) === true) {
    if (value.length === 0) return '[]'

    const isSimpleArray = value.every(
      (item) => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean',
    )

    if (isSimpleArray === true && value.length <= 5) {
      const items = value.map((item) =>
        typeof item === 'string' ? quoteString({ str: item, indent, flow: true }) : String(item),
      )
      return `[${items.join(', ')}]`
    }

    const prefix = INDENT.repeat(indent)
    return value
      .map(
        (item) => `\n${prefix}- ${stringifyValue({ value: item, indent: indent + 1 }).trimStart()}`,
      )
      .join('')
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value).filter(([k, v]) => v !== undefined && k !== COMMENT_KEY)
    if (entries.length === 0) return '{}'

    const prefix = INDENT.repeat(indent)
    const comment = (value as Record<string, unknown>)[COMMENT_KEY]
    const commentLines =
      comment !== undefined
        ? String(comment)
            .split('\n')
            .map((line) => `${prefix}# ${line}`)
            .join('\n') + '\n'
        : ''

    const lines = entries.map(([key, val]) => {
      const quotedKey = quoteKey(key)
      const stringifiedVal = stringifyValue({ value: val, indent: indent + 1 })
      if (
        typeof val === 'object' &&
        val !== null &&
        Array.isArray(val) === false &&
        Object.keys(val).length > 0
      ) {
        return `${prefix}${quotedKey}:\n${stringifiedVal}`
      }
      if (Array.isArray(val) === true && val.length > 0) {
        if (isSimpleInlineArray(val) === false) {
          // Dash format for complex/long arrays
          return `${prefix}${quotedKey}:${stringifiedVal}`
        }
        // Inline array - check if it needs wrapping to next line
        if (
          shouldWrapInlineArray({
            keyLength: quotedKey.length,
            arr: val,
            indent,
          }) === true
        ) {
          // Check if it should use multi-line inline format
          if (shouldUseMultilineInlineArray({ arr: val, indent: indent + 1 }) === true) {
            return `${prefix}${quotedKey}:\n${prefix}${INDENT}${formatMultilineInlineArray({ arr: val, indent: indent + 1 })}`
          }
          return `${prefix}${quotedKey}:\n${prefix}${INDENT}${stringifiedVal}`
        }
      }
      return `${prefix}${quotedKey}: ${stringifiedVal}`
    })

    return commentLines + lines.join('\n')
  }

  return String(value)
}

const isSimpleInlineArray = (arr: unknown[]): boolean => {
  if (arr.length > 5) return false
  return arr.every(
    (item) => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean',
  )
}

/** Max line width before wrapping inline arrays to next line */
const MAX_LINE_WIDTH = 100

/** Calculate the string length of an inline array representation */
const inlineArrayLength = (arr: unknown[]): number => {
  const items = arr.map((item) =>
    typeof item === 'string' ? quoteString({ str: item, indent: 0, flow: true }) : String(item),
  )
  return 2 + items.join(', ').length // 2 for brackets
}

/** Check if an inline array should be wrapped to the next line based on total line length */
const shouldWrapInlineArray = ({
  keyLength,
  arr,
  indent,
}: {
  keyLength: number
  arr: unknown[]
  indent: number
}): boolean => {
  const indentLength = indent * INDENT.length
  const totalLength = indentLength + keyLength + 2 + inlineArrayLength(arr) // 2 for ": "
  return totalLength > MAX_LINE_WIDTH
}

/** Check if an inline array should use multi-line format (one item per line) */
const shouldUseMultilineInlineArray = ({
  arr,
  indent,
}: {
  arr: unknown[]
  indent: number
}): boolean => {
  const singleLineLength = inlineArrayLength(arr)
  const indentLength = (indent + 1) * INDENT.length
  return indentLength + singleLineLength > MAX_LINE_WIDTH
}

/** Format an array as multi-line inline format with trailing comma */
const formatMultilineInlineArray = ({
  arr,
  indent,
}: {
  arr: unknown[]
  indent: number
}): string => {
  const baseIndent = INDENT.repeat(indent)
  const itemIndent = INDENT.repeat(indent + 1)
  const items = arr.map((item) =>
    typeof item === 'string'
      ? quoteString({ str: item, indent: indent + 1, flow: true })
      : String(item),
  )
  return `[\n${items.map((item) => `${itemIndent}${item},`).join('\n')}\n${baseIndent}]`
}

/**
 * Stringify a value to YAML format
 * Designed for GitHub Actions workflow files
 */
export const stringify = (value: unknown): string => {
  if (typeof value !== 'object' || value === null) {
    return stringifyValue({ value, indent: 0 })
  }

  const entries = Object.entries(value).filter(([k, v]) => v !== undefined && k !== COMMENT_KEY)

  // Handle top-level comment
  const comment = (value as Record<string, unknown>)[COMMENT_KEY]
  const headerComment =
    comment !== undefined
      ? String(comment)
          .split('\n')
          .map((line) => `# ${line}`)
          .join('\n') + '\n'
      : ''

  const lines = entries.map(([key, val]) => {
    const quotedKey = quoteKey(key)
    const stringifiedVal = stringifyValue({ value: val, indent: 1 })
    if (
      typeof val === 'object' &&
      val !== null &&
      Array.isArray(val) === false &&
      Object.keys(val).length > 0
    ) {
      return `${quotedKey}:\n${stringifiedVal}`
    }
    if (Array.isArray(val) === true && val.length > 0) {
      if (isSimpleInlineArray(val) === false) {
        // Dash format for complex/long arrays
        return `${quotedKey}:${stringifiedVal}`
      }
      // Inline array - check if it needs wrapping to next line
      if (
        shouldWrapInlineArray({
          keyLength: quotedKey.length,
          arr: val,
          indent: 0,
        }) === true
      ) {
        // Check if it should use multi-line inline format
        if (shouldUseMultilineInlineArray({ arr: val, indent: 1 }) === true) {
          return `${quotedKey}:\n${INDENT}${formatMultilineInlineArray({ arr: val, indent: 1 })}`
        }
        return `${quotedKey}:\n${INDENT}${stringifiedVal}`
      }
    }
    return `${quotedKey}: ${stringifiedVal}`
  })

  return headerComment + lines.join('\n\n') + '\n'
}
