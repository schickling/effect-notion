import { describe, expect, it } from 'vitest'

import { auditFocusOrder } from './focus-order.ts'

/**
 * Selectors taken verbatim from measured builds rather than invented, so the
 * detector is tested against the shape it has to recognise in the field. `x3` /
 * `x6` here stand for the repeated `:not(#\#)` guard StyleX emits.
 */
const notHash = ':not(#\\#)'
const guard = (times: number): string => notHash.repeat(times)

describe('auditFocusOrder', () => {
  it('flags a hover rule emitted after a focus rule at equal specificity', () => {
    // The measured condition, found independently in two production builds: the
    // focus-visible rule is emitted FIRST, so at equal specificity the later
    // hover rule wins — the inverse of what Tailwind shipped.
    const css = `
      .x1k0qq7x:focus-visible${guard(3)}{background-color:blue}
      .xwz2t7n:hover${guard(3)}{background-color:red}
    `
    const report = auditFocusOrder(css)

    expect({
      verdict: report.verdict,
      properties: report.exposed.map((pair) => pair.property),
    }).toEqual({ verdict: 'order-exposed', properties: ['background-color'] })
  })

  it('does not flag a pair that differs in specificity', () => {
    // A pair at differing specificity is decided by the cascade and is not
    // exposed at all. Reporting it would be noise, and a detector that cries
    // wolf gets switched off — which is worse than not having it.
    const css = `
      .x1k0qq7x:focus-visible${guard(3)}{background-color:blue}
      .xwz2t7n:hover${guard(6)}{background-color:red}
    `
    expect(auditFocusOrder(css).verdict).toBe('clean')
  })

  it('does not flag rules that touch different properties', () => {
    // The property-partitioning invariant in action: reserving `outline` for
    // focus-visible and leaving hover on `background-color` makes the collision
    // structurally impossible. This is the leaf-property granularity that
    // matters — matching style-key objects instead manufactures collisions.
    const css = `
      .x9v5kkp:focus-visible${guard(3)}{outline-style:solid}
      .x3uv5t3:hover${guard(3)}{background-color:red}
    `
    expect(auditFocusOrder(css).verdict).toBe('clean')
  })

  it('treats an attribute condition as no native focus rule at all', () => {
    // React Aria's `[data-focus-visible]` is an attribute condition, not a
    // pseudo-class, so the misspelled table entry cannot apply to it. The
    // verdict is `vacuous` rather than `clean`, and the distinction is the
    // honest one: this build has no native focus-visible rule to be outranked,
    // which is a different fact from "the ordering was checked and is fine".
    const css = `
      .x1si7t0b[data-focus-visible]${guard(6)}{background-color:blue}
      .xwz2t7n:hover${guard(6)}{background-color:red}
    `
    expect(auditFocusOrder(css).verdict).toBe('vacuous')
  })

  it('does not flag a hover rule emitted BEFORE the focus rule', () => {
    // Order is the whole question. Hover first at equal specificity means focus
    // wins, which is the desired behaviour and not a finding.
    const css = `
      .xwz2t7n:hover${guard(3)}{background-color:red}
      .x1k0qq7x:focus-visible${guard(3)}{background-color:blue}
    `
    expect(auditFocusOrder(css).verdict).toBe('clean')
  })

  it('refuses to report a clean result when it parsed nothing', () => {
    // THE PROPERTY WORTH MORE THAN THE SPECIFICITY MODEL. One agent produced
    // exactly this failure — a scan reporting zero hover rules on a page
    // carrying an entire utility framework, because `cssRules` threw on a
    // cross-origin sheet and the loop silently continued. It printed
    // identically to a clean result. "I did not look" must not be reportable as
    // "I looked and it is clean".
    const report = auditFocusOrder('')

    expect({ verdict: report.verdict, parsedRules: report.parsedRules }).toEqual({
      verdict: 'unparseable',
      parsedRules: 0,
    })
  })

  it('distinguishes a vacuous pass from a clean one', () => {
    // No native focus rule exists to be outranked. That is a genuine pass, but
    // for a different reason than "the ordering is fine", and conflating the two
    // would hide a build that simply has no focus styling at all.
    const report = auditFocusOrder(`.xwz2t7n:hover${guard(3)}{background-color:red}`)

    expect({ verdict: report.verdict, hoverRules: report.hoverRules, focusRules: 0 }).toEqual({
      verdict: 'vacuous',
      hoverRules: 1,
      focusRules: 0,
    })
  })

  it('reports liveness counts even when exposed', () => {
    // The counts precede interpretation, so a reader can tell a real audit from
    // one that matched almost nothing before trusting the verdict.
    const css = `
      .a:focus-visible${guard(3)}{background-color:blue}
      .b:hover${guard(3)}{background-color:red}
      .c:hover${guard(3)}{color:green}
    `
    const report = auditFocusOrder(css)

    expect({ hoverRules: report.hoverRules, focusRules: report.focusRules }).toEqual({
      hoverRules: 2,
      focusRules: 1,
    })
  })

  it('catches a pair split across two rules, which a source audit misses', () => {
    // The reason this reads the artefact. In source these two could live in
    // different style objects, or in different ordered `stylex.props` arguments,
    // so a source-level intersection comes back empty while the emitted rules
    // still compete on one property.
    const css = `
      .focusOnly:focus-visible${guard(3)}{background-color:blue}
      .someOtherObject:hover${guard(3)}{background-color:red}
    `
    expect(auditFocusOrder(css).verdict).toBe('order-exposed')
  })
})
