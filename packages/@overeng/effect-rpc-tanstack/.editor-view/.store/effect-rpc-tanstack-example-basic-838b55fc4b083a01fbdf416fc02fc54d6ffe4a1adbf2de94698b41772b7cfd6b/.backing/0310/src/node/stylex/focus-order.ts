import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/**
 * Detector for the StyleX `:focus-visible` / `:focus-within` priority defect, run
 * against a BUILT stylesheet rather than against source.
 *
 * The defect, in `@stylexjs/shared@0.19.0/lib/utils/property-priorities.js`: the
 * two hyphenated pseudo-classes are spelled camelCase in the priority table
 * (`:focusVisible`, `:focusWithin`) but every lookup keys on the literal CSS
 * text, so both fall through to the unknown-pseudo default of 40 while `:hover`
 * sits at 130. Hover therefore outranks focus-visible — the inverse of Tailwind,
 * which emits focus-visible after hover at equal specificity. A conversion that
 * looks correct silently inverts shipped behaviour, with no compile error, no
 * lint error and nothing for a type checker to see.
 *
 * WHY THE ARTEFACT AND NOT THE SOURCE. A source-level audit looks for one
 * property object carrying both keys, which misses a pair split across two style
 * objects or across ordered `stylex.props` arguments — those still compete as
 * atomic rules in the cascade. Reading the emitted stylesheet also forces the
 * right granularity on you: there are no style keys in CSS, only leaf
 * properties, so it cannot manufacture the false collisions that matching
 * style-key objects produces.
 *
 * SCOPE. Right for compiled atomic output; do NOT point it at hand-written CSS.
 * The specificity model counts the repeated `:not(#\#)` guard as ids and lumps
 * classes, attributes and pseudo-classes into one bucket, which is faithful to
 * StyleX's own output and to nothing else.
 *
 * On a dev page it will parse the framework's whole utility layer plus tool
 * chrome, so PAIR COUNT IS NOT SEVERITY there. Point it at a production
 * stylesheet. If you must use a live page, collect the stylesheet TEXT: `cssRules`
 * THROWS on a cross-origin sheet, so the obvious `try { … } catch { continue }`
 * skips real rules and returns a clean result for the wrong reason — the same
 * absence-shaped false pass the liveness line below exists to prevent.
 *
 * Written and validated by SmallAppSurfaces.MiscSurface, which measured two
 * independent builds as order-exposed before handing it over.
 *
 * @module
 */

/** StyleX encodes rule priority as repetitions of `:not(#\#)`. */
const notHash = ':not(#\\#)'

/** One emitted rule, reduced to what the audit needs. */
interface EmittedRule {
  readonly selector: string
  /** Leaf property names the rule sets. */
  readonly properties: readonly string[]
  /** Byte offset, which is emission order. */
  readonly order: number
}

/** One hover rule that outranks a focus rule on a shared property. */
export interface ExposedPair {
  readonly property: string
  readonly focusSelector: string
  readonly hoverSelector: string
  readonly focusOrder: number
  readonly hoverOrder: number
}

/** What the audit found, including whether it looked at anything at all. */
export interface FocusOrderReport {
  /**
   * Liveness, and it is the first field for the same reason it is the first line
   * of output: a detector that found nothing because it PARSED nothing must not
   * read as a clean bill of health. One agent independently produced exactly that
   * failure — a run reporting zero hover rules on a page carrying an entire
   * utility framework — and caught it only because the number was implausible.
   */
  readonly parsedRules: number
  readonly hoverRules: number
  readonly focusRules: number
  readonly exposed: readonly ExposedPair[]
  /**
   * `'unparseable'` when nothing parsed, so a caller cannot mistake it for
   * `'clean'`. `'vacuous'` means no native focus rule exists to be outranked.
   */
  readonly verdict: 'unparseable' | 'vacuous' | 'clean' | 'order-exposed'
}

/**
 * Specificity of a StyleX atomic selector, as `<ids>,<everything else>`.
 *
 * Only used to decide whether two rules TIE. A pair at differing specificity is
 * decided by the cascade and is not exposed at all, so pairing it would be noise.
 */
const specificityOf = (selector: string): string => {
  const ids = selector.split(notHash).length - 1
  const rest =
    (selector.match(/\.[A-Za-z0-9_-]+/g) ?? []).length +
    (selector.match(/:(?!not\()[a-z-]+/g) ?? []).length +
    (selector.match(/\[[^\]]+\]/g) ?? []).length
  return `${ids},${rest}`
}

const parseRules = (css: string): readonly EmittedRule[] => {
  const rules: EmittedRule[] = []
  for (const match of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    const selector = (match[1] ?? '').trim()
    const body = (match[2] ?? '').trim()
    if (selector.startsWith('@') === true || body === '') continue
    const properties = body
      .split(';')
      .map((declaration) => declaration.split(':')[0]?.trim() ?? '')
      .filter((property) => property !== '')
    rules.push({ selector, properties, order: match.index })
  }
  return rules
}

/**
 * Attribute conditions such as `[data-focus-visible]` are a different condition
 * kind and never reach the priority table, so they are not part of this defect.
 */
const isAttribute = (selector: string): boolean => /\[data-/.test(selector)

/**
 * Audit an emitted stylesheet for the ordering that makes the defect reachable.
 *
 * Order-exposed means any element carrying BOTH classes paints the hover value.
 * It does NOT mean such an element exists — that is a per-element question only
 * the producers and composition sites can answer, and this deliberately refuses
 * to guess at it.
 */
export const auditFocusOrder = (css: string): FocusOrderReport => {
  const rules = parseRules(css)
  const hover = rules.filter(
    (rule) => /:hover(?![\w-])/.test(rule.selector) && isAttribute(rule.selector) === false,
  )
  const focus = rules.filter(
    (rule) =>
      /:focus-visible(?![\w-])|:focus-within(?![\w-])/.test(rule.selector) &&
      isAttribute(rule.selector) === false,
  )

  const counts = { parsedRules: rules.length, hoverRules: hover.length, focusRules: focus.length }
  if (rules.length === 0) return { ...counts, exposed: [], verdict: 'unparseable' }
  if (focus.length === 0) return { ...counts, exposed: [], verdict: 'vacuous' }

  const exposed: ExposedPair[] = []
  for (const focusRule of focus) {
    const focusSpecificity = specificityOf(focusRule.selector)
    for (const hoverRule of hover) {
      if (specificityOf(hoverRule.selector) !== focusSpecificity) continue
      if (hoverRule.order <= focusRule.order) continue
      for (const property of focusRule.properties) {
        if (hoverRule.properties.includes(property) === false) continue
        exposed.push({
          property,
          focusSelector: focusRule.selector,
          hoverSelector: hoverRule.selector,
          focusOrder: focusRule.order,
          hoverOrder: hoverRule.order,
        })
      }
    }
  }

  return { ...counts, exposed, verdict: exposed.length === 0 ? 'clean' : 'order-exposed' }
}

/**
 * Human-readable report.
 *
 * Prints both fixes with the reason to prefer them, because a verdict channel
 * that cannot carry its own cause gets bypassed.
 */
export const formatFocusOrderReport = ({
  report,
  source,
}: {
  report: FocusOrderReport
  source: string
}): string => {
  const head = [
    `stylesheet: ${source}`,
    `LIVENESS: parsed ${report.parsedRules} rules; found ${report.hoverRules} :hover rules and ${report.focusRules} :focus-visible/:focus-within rules.`,
  ]

  if (report.verdict === 'unparseable') {
    return [
      ...head,
      'REFUSING TO REPORT: parsed zero rules. That is a parse failure, not a clean result.',
    ].join('\n')
  }
  if (report.verdict === 'vacuous') {
    return [
      ...head,
      'NOT EXPOSED (vacuously): this build emits no native :focus-visible/:focus-within rule.',
    ].join('\n')
  }
  if (report.verdict === 'clean') {
    return [
      ...head,
      'BUILD NOT ORDER-EXPOSED: no hover rule outranks a focus rule on a shared property.',
    ].join('\n')
  }

  const byProperty = new Map<string, ExposedPair[]>()
  for (const pair of report.exposed) {
    byProperty.set(pair.property, [...(byProperty.get(pair.property) ?? []), pair])
  }

  return [
    ...head,
    '',
    'BUILD IS ORDER-EXPOSED. For each property below, an element carrying BOTH classes',
    'paints the hover value while hovered AND keyboard-focused. Tailwind did the opposite.',
    ...[...byProperty].flatMap(([property, pairs]) => [
      `  ${property}: ${pairs.length} pair(s), e.g.`,
      `    focus @${pairs[0]?.focusOrder} ${pairs[0]?.focusSelector}`,
      `    hover @${pairs[0]?.hoverOrder} ${pairs[0]?.hoverSelector}`,
    ]),
    '',
    'This does NOT mean the app is broken: it means any element carrying both is.',
    'Step two is per-element and this cannot do it. Enumerate the producers of each focus',
    'class named above, then check whether any composition site also pulls in a :hover',
    'class for the same property. Bounded by the focus-rule count, not the pair count --',
    'most pairs are cross-component noise, and pair count is not severity.',
    '',
    'Two sound fixes. Both work because their correctness is INVARIANT UNDER THE PRIORITY',
    'TABLE\'S VALUES, which is the property to aim for. Note it is NOT "specificity instead',
    'of priority": the compiler materialises priority AS specificity by repeating',
    ':not(#\\#), so those are one axis, not two competing ones.',
    "  1. Add `':hover:focus-visible': <focus value>` to the same object. A compound key",
    '     sums its parts and all priorities are positive, so it always exceeds either',
    '     component whatever the numbers are.',
    '  2. Put the LOSING state on the `default` condition, e.g. lift hover into an ordered',
    '     stylex.props argument. `default` is the lowest priority by construction, so it',
    '     loses to any conditioned rule whatever the numbers are.',
    'Better still, move one state to a different property: then there is no pair at all,',
    'and no comment explaining a workaround for a bug that will be fixed.',
  ].join('\n')
}

/**
 * Runnable entry point, so this is a check that gets run rather than a library
 * nobody invokes.
 *
 * Exit codes are distinct on purpose: a parse failure returns `2`, never `0`,
 * because "I did not look" and "I looked and it is clean" must not share an exit
 * code. That is the same rule as the liveness line, enforced where CI reads it.
 */
export const runFocusOrderCli = (argv: readonly string[]): number => {
  const source = argv[0]
  if (source === undefined || argv.includes('--help') === true) {
    process.stdout.write(
      [
        'Usage: focus-order <path-to-built.css>',
        '',
        '  Audits an emitted StyleX stylesheet for the :focus-visible priority defect.',
        '  Point it at a PRODUCTION stylesheet: on a dev page it parses the whole utility',
        '  layer plus tool chrome, and pair count is not severity there.',
        '',
        '  Exit 0 clean or vacuous, 1 order-exposed, 2 nothing parsed.',
        '',
      ].join('\n'),
    )
    return 0
  }
  const report = auditFocusOrder(readFileSync(source, 'utf8'))
  process.stdout.write(`${formatFocusOrderReport({ report, source })}\n`)
  if (report.verdict === 'unparseable') return 2
  return report.verdict === 'order-exposed' ? 1 : 0
}

const entryPath = process.argv[1]
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  process.exitCode = runFocusOrderCli(process.argv.slice(2))
}
