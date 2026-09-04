/// <reference lib="dom" />

/**
 * Browser detection utilities.
 * Based on user agent parsing for identifying browser environments.
 */

/** Detected browser type from user agent parsing */
export type DetectedBrowser = 'Opera' | 'Chrome' | 'Safari' | 'Firefox' | 'Edge' | 'Unknown'

/**
 * Detects the current browser based on the user agent string.
 * Returns 'Unknown' if the browser cannot be identified or if not in a browser environment.
 *
 * @example
 * ```ts
 * const browser = detectBrowserName()
 * if (browser === 'Safari') {
 *   // Safari-specific handling
 * }
 * ```
 */
export const detectBrowserName = (): DetectedBrowser => {
  if (typeof navigator === 'undefined' || navigator.userAgent === undefined) {
    return 'Unknown'
  }

  const ua = navigator.userAgent

  // Order matters: check more specific patterns first
  const isOpera = ua.includes('OP') || ua.includes('Opera')
  const isEdge = ua.includes('Edg') || ua.includes('Trident')
  const isChrome = ua.includes('Chrome') && isOpera === false && isEdge === false
  const isSafari =
    ua.includes('Safari') && isChrome === false && isOpera === false && isEdge === false
  const isFirefox = ua.includes('Firefox')

  if (isOpera === true) return 'Opera'
  if (isEdge === true) return 'Edge'
  if (isChrome === true) return 'Chrome'
  if (isSafari === true) return 'Safari'
  if (isFirefox === true) return 'Firefox'

  return 'Unknown'
}

/**
 * Checks if the current environment is a browser.
 */
export const isBrowser = (): boolean =>
  typeof window !== 'undefined' && typeof navigator !== 'undefined'
