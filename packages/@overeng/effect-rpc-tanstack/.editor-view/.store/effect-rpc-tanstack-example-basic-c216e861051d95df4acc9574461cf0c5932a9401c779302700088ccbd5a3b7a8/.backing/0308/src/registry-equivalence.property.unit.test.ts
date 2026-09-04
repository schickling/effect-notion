/**
 * PROTOTYPE (weaver-semconv follow-up) — the CONSOLIDATED, durable engine-equivalence proof for
 * SC-R14, over the neutral `acme.*` demo fixture. This ONE test subsumes the durable core that the
 * 13 per-package `*.observability.equivalence.unit.test.ts` migration witnesses each re-prove: that
 * the Layer-2 registry derivation (`attr`/`span`/`metric`/`operation` → `OtelAttrs.defineSync` /
 * `OtelMetric` / `OtelOperation.define`) produces byte-identical runtime encoders to an INDEPENDENT,
 * hand-authored baseline built straight from otel-contract's Layer-1 primitives
 * (`OtelAttr`/`OtelAttrs`/`OtelOperation`).
 *
 * It is the property-based upgrade of the example-based checks already in `registry.unit.test.ts`,
 * extended to cover the OPERATION product path (derived span label) the example test omits. It is a
 * DURABLE engine invariant — the demo fixture is authored HERE (not a frozen copy of migrated
 * member code), so it never rots into a per-package change-detector; a fixture edit changes both
 * sides at once, deliberately.
 *
 * PROTOTYPE NOTE: the real version should use `@effect/vitest` `it.prop` with `Schema` arbitraries
 * (as the per-package witnesses do), which requires adding `@effect/vitest` to this Layer-1 package
 * via `package.json.genie.ts`. To keep this prototype dependency-free it enumerates the
 * optional-present/absent × enum branch matrix deterministically instead — same branch coverage,
 * plain vitest.
 */
import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { OtelAttr, OtelAttrs, OtelOperation, type OtelOperationDefinition } from './mod.ts'
import { ProbeOperation, ProbeSpan, ProbesTotal } from './registry-demo.contract.ts'

// ---- independent hand-authored baselines (mirror registry-demo.contract.ts from raw primitives) ----
const spanBaseline = OtelAttrs.defineSync(
  Schema.Struct({
    probeName: OtelAttr.string({ key: 'acme.probe.name', metadata: { cardinality: 'bounded' } }),
    region: Schema.optional(OtelAttr.literal('acme.region', 'us_east', 'us_west', 'eu_central')),
    attempt: Schema.optional(
      OtelAttr.number({ key: 'acme.attempt', metadata: { cardinality: 'low' } }),
    ),
    httpMethod: Schema.optional(
      OtelAttr.string({ key: 'http.request.method', metadata: { cardinality: 'low' } }),
    ),
  }),
)

const metricBaseline = OtelAttrs.defineSync(
  Schema.Struct({
    probeName: OtelAttr.string({ key: 'acme.probe.name', metadata: { cardinality: 'bounded' } }),
    region: Schema.optional(OtelAttr.literal('acme.region', 'us_east', 'us_west', 'eu_central')),
  }),
)

const operationBaseline = OtelOperation.define({
  name: 'acme.operation',
  schema: Schema.Struct({
    probeName: OtelAttr.string({ key: 'acme.probe.name', metadata: { cardinality: 'bounded' } }),
    label: OtelAttr.drop(Schema.NonEmptyString),
  }),
  label: (v: { probeName: string }) => `acme:${v.probeName}`,
})

// ---- enumerated branch matrix (present/absent × enum) standing in for Schema arbitraries ----
const regions = ['us_east', 'us_west', 'eu_central'] as const

const spanInputs = regions.flatMap((region) =>
  [true, false].flatMap((hasRegion) =>
    [true, false].flatMap((hasAttempt) =>
      [true, false].map((hasHttp) =>
        Object.assign(
          { probeName: `liveness` },
          hasRegion === true ? { region } : {},
          hasAttempt === true ? { attempt: 3 } : {},
          hasHttp === true ? { httpMethod: `GET` } : {},
        ),
      ),
    ),
  ),
)

const metricInputs = regions.flatMap((region) => [
  { probeName: 'readiness' },
  { probeName: 'readiness', region },
])

describe('registry derivation ≡ raw otel-contract primitives (SC-R14 engine invariant)', () => {
  it.each(spanInputs)('SPAN: derived .encodeSync ≡ hand-authored baseline — %o', (input) => {
    expect(ProbeSpan.encoder.encodeSync(input as never)).toStrictEqual(
      spanBaseline.encodeSync(input as never),
    )
  })

  it.each(metricInputs)(
    'METRIC: derived .encodeLabelsSync ≡ hand-authored baseline — %o',
    (input) => {
      expect(ProbesTotal.metric.encodeLabelsSync(input as never)).toStrictEqual(
        metricBaseline.encodeSync(input as never),
      )
    },
  )

  it('OPERATION: derived .operation.encodeSync ≡ baseline (incl. derived span.label + drop field)', () => {
    const input = { probeName: 'liveness', label: 'ignored-source' }
    const derived = (ProbeOperation.operation as OtelOperationDefinition<never>).encodeSync(
      input as never,
    )
    const baseline = (operationBaseline as OtelOperationDefinition<never>).encodeSync(
      input as never,
    )
    expect(derived).toStrictEqual(baseline)
    expect(derived['span.label']).toBe('acme:liveness')
  })

  it('derived and baseline agree on emitted attribute keys (span + metric labels)', () => {
    expect([...ProbeSpan.encoder.keys].toSorted()).toStrictEqual([...spanBaseline.keys].toSorted())
    expect([...ProbesTotal.encoder.keys].toSorted()).toStrictEqual(
      [...metricBaseline.keys].toSorted(),
    )
  })
})
