/**
 * Minimal semver range checker for npm peer dependency validation.
 *
 * Supports the subset of semver ranges actually used by npm peer dependencies:
 * `^`, `~`, `>=X <Y`, `>=X`, `||` disjunction, `*`, and bare versions.
 */

/** Parsed semver version as a `[major, minor, patch]` tuple. */
export type SemVer = readonly [major: number, minor: number, patch: number]

/** Parse a version string like `1.2.3` into a `[major, minor, patch]` tuple. */
export const parseVersion = (version: string): SemVer => {
  // Prerelease/build suffixes (`4.0.0-rc.111`, `1.2.3+build`) must not leak
  // into the numeric tuple: `Number('0-rc')` is NaN and poisons comparisons.
  const release = version.split('-', 1)[0]!.split('+', 1)[0]!
  const cleaned = release.replace(/\.x/g, '.0')
  const parts = cleaned.split('.').map(Number)
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0] as const
}

// oxlint-disable-next-line overeng/named-args
const cmp = (a: SemVer, b: SemVer): number =>
  a[0] !== b[0] ? a[0] - b[0] : a[1] !== b[1] ? a[1] - b[1] : a[2] - b[2]

// oxlint-disable-next-line overeng/named-args
const gte = (a: SemVer, b: SemVer): boolean => cmp(a, b) >= 0
// oxlint-disable-next-line overeng/named-args
const lt = (a: SemVer, b: SemVer): boolean => cmp(a, b) < 0

/**
 * Check if a concrete version satisfies a single comparator (no `||`).
 *
 * Pre-1.0 caret semantics: `^0.Y.Z` means `>=0.Y.Z <0.(Y+1).0`.
 * This is the key behavior that catches `@effect-atom/atom` declaring
 * `^0.58.0` which does NOT cover `0.60.0`.
 */
// oxlint-disable-next-line overeng/named-args
const satisfiesSingle = (version: string, range: string): boolean => {
  const v = parseVersion(version)
  const trimmed = range.trim()

  if (trimmed === '*') return true

  const parts = trimmed.split('.')
  const wildcardIndex = parts.findIndex((part) => part === 'x' || part === 'X' || part === '*')
  if (
    wildcardIndex !== -1 &&
    parts.length <= 3 &&
    parts.slice(0, wildcardIndex).every((part) => /^(?:0|[1-9]\d*)$/.test(part)) === true &&
    parts.slice(wildcardIndex).every((part) => part === 'x' || part === 'X' || part === '*') ===
      true
  ) {
    return parts.slice(0, wildcardIndex).every((part, index) => v[index] === Number(part))
  }

  if (trimmed.startsWith('^') === true) {
    const r = parseVersion(trimmed.slice(1))
    if (gte(v, r) === false) return false
    if (r[0] > 0) return v[0] === r[0]
    if (r[1] > 0) return v[0] === 0 && v[1] === r[1]
    return v[0] === 0 && v[1] === 0 && v[2] === r[2]
  }

  if (trimmed.startsWith('~') === true) {
    const r = parseVersion(trimmed.slice(1))
    return v[0] === r[0] && v[1] === r[1] && v[2] >= r[2]
  }

  /* `>=X.Y.Z <A.B.C` compound range */
  if (trimmed.startsWith('>=') === true && trimmed.includes('<') === true) {
    const comparators = trimmed.split(/\s+/)
    const lo = parseVersion(comparators[0]!.slice(2))
    const hiPart = comparators.find(
      (p) => p.startsWith('<') === true && p.startsWith('<=') === false,
    )
    if (hiPart !== undefined) return gte(v, lo) && lt(v, parseVersion(hiPart.slice(1)))
  }

  /* `>=X.Y.Z` standalone */
  if (trimmed.startsWith('>=') === true) return gte(v, parseVersion(trimmed.slice(2)))

  /* Bare version — exact match */
  return version === trimmed
}

/** Check if a concrete version satisfies a range (handles `||` disjunction). */
// oxlint-disable-next-line overeng/named-args -- positional version+range mirrors node-semver API
export const satisfiesRange = (version: string, range: string): boolean =>
  range.split('||').some((part) => satisfiesSingle(version, part.trim()))
