/**
 * ANSI escape code utilities for terminal manipulation.
 *
 * These are low-level building blocks for terminal rendering.
 * For higher-level styled text, see tui-react or implement locally.
 */

// =============================================================================
// Cursor Movement
// =============================================================================

/** Move cursor up N lines */
export const cursorUp = (n = 1): string => (n > 0 ? `${CSI}${n}A` : '')

/** Move cursor down N lines */
export const cursorDown = (n = 1): string => (n > 0 ? `${CSI}${n}B` : '')

/** Move cursor to column N (1-based) */
export const cursorToColumn = (n = 1): string => `${CSI}${n}G`

/** Save cursor position */
export const cursorSave = (): string => `${CSI}s`

/** Restore cursor position */
export const cursorRestore = (): string => `${CSI}u`

// =============================================================================
// Line Operations
// =============================================================================

/** Clear entire line */
export const clearLine = (): string => `${CSI}2K`

/** Clear from cursor to end of line */
export const clearToEndOfLine = (): string => `${CSI}0K`

/** Clear from cursor to start of line */
export const clearToStartOfLine = (): string => `${CSI}1K`

/** Clear entire screen */
export const clearScreen = (): string => `${CSI}2J`

/** Move cursor to home position (1,1) */
export const cursorHome = (): string => `${CSI}H`

/** Clear screen and move cursor to home - useful for full reset */
export const clearScreenAndHome = (): string => `${CSI}2J${CSI}H`

/**
 * Generate sequence to clear N lines above cursor.
 * Moves up, clears each line, then returns to original position.
 */
export const clearLinesAbove = (n: number): string => {
  if (n <= 0) return ''
  let seq = ''
  for (let i = 0; i < n; i++) {
    seq += cursorUp(1) + clearLine()
  }
  return seq
}

// =============================================================================
// Cursor Visibility
// =============================================================================

/** Hide cursor */
export const hideCursor = (): string => `${CSI}?25l`

/** Show cursor */
export const showCursor = (): string => `${CSI}?25h`

// =============================================================================
// Synchronized Output (CSI 2026)
// =============================================================================

/**
 * Begin synchronized output.
 *
 * Tells the terminal to buffer output until endSyncOutput() is called,
 * enabling flicker-free updates. Supported by iTerm2, Kitty, Alacritty, WezTerm, etc.
 *
 * Terminals that don't support this will simply ignore the sequence.
 */
export const beginSyncOutput = (): string => `${CSI}?2026h`

/**
 * End synchronized output.
 *
 * Tells the terminal to flush the buffer and render all pending output at once.
 */
export const endSyncOutput = (): string => `${CSI}?2026l`

// =============================================================================
// ANSI Stripping
// =============================================================================

/**
 * Regex matching ANSI escape sequences:
 * - CSI sequences (colors, styles, cursor movement)
 * - DEC private-mode CSI sequences (e.g. `\x1b[?25l` cursor hide, `\x1b[?2026h` sync output)
 * - OSC sequences terminated by BEL (hyperlinks, titles)
 * - Charset selection (e.g. `\x1b(B`)
 * - Keypad modes (`\x1b=`, `\x1b>`)
 */
const STRIP_ANSI_REGEX =
  // oxlint-disable-next-line eslint/no-control-regex -- ANSI escape sequences are literally C0 control characters (ESC, BEL); matching them is the purpose
  /\x1b\[[0-9;]*[a-zA-Z]|\x1b\[\?[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][AB012]|\x1b[=>]/g

/**
 * Strip ANSI escape codes from a string.
 *
 * @param str - String potentially containing ANSI codes
 * @returns Plain text without ANSI codes
 *
 * @example
 * ```typescript
 * stripAnsi('\x1b[32mHello\x1b[0m') // => 'Hello'
 * ```
 */
export const stripAnsi = (str: string): string => str.replace(STRIP_ANSI_REGEX, '')

// =============================================================================
// Text Styles
// =============================================================================

/** Reset all styles */
export const reset = (): string => `${CSI}0m`

/** Bold text */
export const bold = (text: string): string => `${CSI}1m${text}${CSI}22m`

/** Dim text */
export const dim = (text: string): string => `${CSI}2m${text}${CSI}22m`

/** Normal intensity (resets bold/dim) - use when explicitly turning off dim */
export const normalIntensity = (): string => `${CSI}22m`

/** Italic text */
export const italic = (text: string): string => `${CSI}3m${text}${CSI}23m`

/** Underlined text */
export const underline = (text: string): string => `${CSI}4m${text}${CSI}24m`

/** Strikethrough text */
export const strikethrough = (text: string): string => `${CSI}9m${text}${CSI}29m`

/** Wrap text in an OSC 8 hyperlink (clickable in supported terminals) */
export const hyperlink = ({ url, text }: { url: string; text: string }): string =>
  `${OSC}8;;${url}\x07${text}${OSC}8;;\x07`

// =============================================================================
// Colors
// =============================================================================

/** Standard ANSI color names */
export type ColorName =
  | 'black'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white'
  | 'gray'
  | 'grey'
  // Bright variants
  | 'blackBright'
  | 'redBright'
  | 'greenBright'
  | 'yellowBright'
  | 'blueBright'
  | 'magentaBright'
  | 'cyanBright'
  | 'whiteBright'

/** 256-color palette color (0-255) */
export type Color256 = { ansi256: number }

/** True color RGB */
export type ColorRgb = { rgb: { r: number; g: number; b: number } }

/** Extended color type supporting named colors, 256-color palette, and true color */
export type Color = ColorName | Color256 | ColorRgb

/** Type guard for named color */
export const isColorName = (color: Color): color is ColorName => typeof color === 'string'

/** Type guard for 256-color */
export const isColor256 = (color: Color): color is Color256 =>
  typeof color === 'object' && 'ansi256' in color

/** Type guard for RGB color */
export const isColorRgb = (color: Color): color is ColorRgb =>
  typeof color === 'object' && 'rgb' in color

/** Apply foreground color */
export const fg = ({ color, text }: { color: Color; text: string }): string =>
  `${getFgCode(color)}${text}${CSI}39m`

/** Apply background color */
export const bg = ({ color, text }: { color: Color; text: string }): string =>
  `${getBgCode(color)}${text}${CSI}49m`

/** Get raw foreground ANSI code (without text wrapping) */
export const fgCode = (color: Color): string => getFgCode(color)

/** Get raw background ANSI code (without text wrapping) */
export const bgCode = (color: Color): string => getBgCode(color)

/** Reset foreground color */
export const fgReset = (): string => `${CSI}39m`

/** Reset background color */
export const bgReset = (): string => `${CSI}49m`

// =============================================================================
// Internal Constants and Helpers
// =============================================================================

/** CSI (Control Sequence Introducer) prefix */
const CSI = '\x1b['

/** OSC (Operating System Command) prefix */
const OSC = '\x1b]'

/** Color name to ANSI foreground code */
const fgCodes: Record<ColorName, number> = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  gray: 90,
  grey: 90,
  blackBright: 90,
  redBright: 91,
  greenBright: 92,
  yellowBright: 93,
  blueBright: 94,
  magentaBright: 95,
  cyanBright: 96,
  whiteBright: 97,
}

/** Color name to ANSI background code */
const bgCodes: Record<ColorName, number> = {
  black: 40,
  red: 41,
  green: 42,
  yellow: 43,
  blue: 44,
  magenta: 45,
  cyan: 46,
  white: 47,
  gray: 100,
  grey: 100,
  blackBright: 100,
  redBright: 101,
  greenBright: 102,
  yellowBright: 103,
  blueBright: 104,
  magentaBright: 105,
  cyanBright: 106,
  whiteBright: 107,
}

/** Get foreground ANSI escape sequence for a color */
const getFgCode = (color: Color): string => {
  if (isColorName(color) === true) {
    return `${CSI}${fgCodes[color]}m`
  }
  if (isColor256(color) === true) {
    return `${CSI}38;5;${color.ansi256}m`
  }
  if (isColorRgb(color) === true) {
    return `${CSI}38;2;${color.rgb.r};${color.rgb.g};${color.rgb.b}m`
  }
  return ''
}

/** Get background ANSI escape sequence for a color */
const getBgCode = (color: Color): string => {
  if (isColorName(color) === true) {
    return `${CSI}${bgCodes[color]}m`
  }
  if (isColor256(color) === true) {
    return `${CSI}48;5;${color.ansi256}m`
  }
  if (isColorRgb(color) === true) {
    return `${CSI}48;2;${color.rgb.r};${color.rgb.g};${color.rgb.b}m`
  }
  return ''
}
