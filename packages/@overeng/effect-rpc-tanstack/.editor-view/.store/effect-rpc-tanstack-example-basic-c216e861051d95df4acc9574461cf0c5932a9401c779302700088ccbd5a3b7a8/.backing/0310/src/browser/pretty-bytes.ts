/**
 * Simple utility to format bytes as human-readable strings.
 * Based on the common pretty-bytes pattern.
 */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'] as const

/**
 * Formats a byte count as a human-readable string.
 *
 * @example
 * ```ts
 * prettyBytes(1024) // "1 KB"
 * prettyBytes(1234567) // "1.18 MB"
 * prettyBytes(0) // "0 B"
 * ```
 */
export const prettyBytes = (bytes: number): string => {
  if (Number.isFinite(bytes) === false) {
    throw new TypeError(`Expected a finite number, got ${typeof bytes}: ${bytes}`)
  }

  const isNegative = bytes < 0
  const absoluteBytes = Math.abs(bytes)

  if (absoluteBytes === 0) {
    return '0 B'
  }

  const exponent = Math.min(Math.floor(Math.log10(absoluteBytes) / 3), UNITS.length - 1)
  const value = absoluteBytes / 1000 ** exponent
  const unit = UNITS[exponent]!

  const formatted = value.toLocaleString('en-US', {
    maximumFractionDigits: 2,
  })

  return `${isNegative === true ? '-' : ''}${formatted} ${unit}`
}
