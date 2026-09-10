import * as PosixPath from 'node:path/posix'

import { Schema } from 'effect'

/** Repository-relative subtree reserved for the capability projection. */
export const R6_CAPABILITIES_DESTINATION = '.buck2/capabilities' as const

const printableAscii = (value: string): boolean => /^[\x20-\x7e]+$/u.test(value)
const hasEmptyOrDotSegment = (value: string): boolean =>
  value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..') === true

/** Canonical member-relative Buck target producing one overlay artifact directory. */
export const DistOverlayTarget = Schema.String.check(
  Schema.makeFilter<string>((value) => {
    if (
      printableAscii(value) === false ||
      /\s/u.test(value) === true ||
      value.includes('\\') === true
    ) {
      return 'Expected a whitespace-free member-relative Buck label'
    }
    const match = /^\/\/([^:]+):([^:]+)$/u.exec(value)
    if (match === null) return 'Expected a member-relative Buck label //<package>:<target>'
    const buckPackage = match[1]!
    const target = match[2]!
    return PosixPath.normalize(buckPackage) !== buckPackage ||
      PosixPath.normalize(target) !== target ||
      hasEmptyOrDotSegment(buckPackage) === true ||
      hasEmptyOrDotSegment(target) === true
      ? 'Buck overlay labels may not contain empty, dot, or parent segments'
      : undefined
  }),
).annotate({ identifier: 'Megarepo.DistOverlayTarget' })

/** Canonical repository-relative destination for one overlay subtree. */
export const DistOverlayDestination = Schema.String.check(
  Schema.makeFilter<string>((value) => {
    if (
      printableAscii(value) === false ||
      value.startsWith('/') === true ||
      value.includes('\\') === true ||
      value.includes(',') === true ||
      PosixPath.normalize(value) !== value
    ) {
      return 'Expected a normalized member-relative POSIX overlay destination'
    }
    return hasEmptyOrDotSegment(value) === true
      ? 'Overlay destinations may not contain empty, dot, or parent segments'
      : undefined
  }),
).annotate({ identifier: 'Megarepo.DistOverlayDestination' })

/** One declared Buck-built distribution and its exact excluded destination subtree. */
export const DistOverlayDeclaration = Schema.Struct({
  target: DistOverlayTarget,
  destination: DistOverlayDestination,
}).annotate({ identifier: 'Megarepo.DistOverlayDeclaration' })
export type DistOverlayDeclaration = typeof DistOverlayDeclaration.Type

const compareCodeUnits = ({ left, right }: { left: string; right: string }): number =>
  left < right ? -1 : left > right ? 1 : 0

const darwinCaseFold = (value: string): string =>
  value.normalize('NFD').toUpperCase().toLowerCase().normalize('NFC')

const pathsOverlap = ({ left, right }: { left: string; right: string }): boolean => {
  const foldedLeft = darwinCaseFold(left)
  const foldedRight = darwinCaseFold(right)
  return (
    foldedLeft === foldedRight ||
    foldedLeft.startsWith(`${foldedRight}/`) ||
    foldedRight.startsWith(`${foldedLeft}/`)
  )
}

/**
 * Strictly validate declaration identity and destination ownership, then return canonical order.
 * Destinations are disjoint and may never capture the repository root or capability projection.
 */
export const canonicalizeDistOverlayDeclarations = (
  declarations: ReadonlyArray<DistOverlayDeclaration>,
): ReadonlyArray<DistOverlayDeclaration> => {
  const decoded = Schema.decodeSync(Schema.Array(DistOverlayDeclaration), {
    errors: 'all',
    onExcessProperty: 'error',
  })(declarations)
  const canonical = [...decoded].toSorted(
    (left, right) =>
      compareCodeUnits({ left: left.destination, right: right.destination }) ||
      compareCodeUnits({ left: left.target, right: right.target }),
  )
  const targets = new Set<string>()
  for (const [index, declaration] of canonical.entries()) {
    if (targets.has(declaration.target) === true) {
      throw new Error(`Duplicate dist overlay target: ${declaration.target}`)
    }
    targets.add(declaration.target)
    if (
      pathsOverlap({ left: declaration.destination, right: R6_CAPABILITIES_DESTINATION }) === true
    ) {
      throw new Error(
        `Dist overlay destination '${declaration.destination}' collides with '${R6_CAPABILITIES_DESTINATION}'`,
      )
    }
    const previous = canonical[index - 1]
    if (
      previous !== undefined &&
      pathsOverlap({ left: previous.destination, right: declaration.destination }) === true
    ) {
      throw new Error(
        `Dist overlay destinations overlap: '${previous.destination}' and '${declaration.destination}'`,
      )
    }
  }
  return canonical
}

/** True only when one declaration exactly owns the supplied target and destination. */
export const hasDeclaredDistOverlay = ({
  declarations,
  target,
  destination,
}: {
  declarations: ReadonlyArray<DistOverlayDeclaration>
  target: string
  destination: string
}): boolean =>
  declarations.some(
    (declaration) => declaration.target === target && declaration.destination === destination,
  )
