/**
 * DEMO member seam — the `acme.*` telemetry contract (a neutral example vendor namespace),
 * authored via the Layer 2 `./registry` surface. Proves the M1 mechanism end-to-end and
 * exercises every Weaver fidelity delta the gate must round-trip:
 *   - `deprecated: { reason: 'renamed', renamed_to }`  (structured deprecation)
 *   - a multi-member enum with per-member `stability`   (weaver 0.24.2 requires it)
 *   - a `template[...]` dynamic-key attribute
 *   - a `conditionally_required` ref
 *   - an UPSTREAM ref (`http.request.method`) resolved via the manifest dependency
 *
 * This is a SEAM file (`*.contract.ts`): it is the single home for its package's contract
 * (decision 0005). For M1 self-containment + typecheck coverage it is co-located in
 * `@overeng/otel-contract`; real members live in their own packages' seam files.
 */
import { Schema } from 'effect'

import { OtelAttr } from './mod.ts'
import {
  attr,
  conditionally,
  defineOtelContract,
  metric,
  operation,
  recommended,
  refExternal,
  required,
  span,
} from './registry.ts'

// ---- attributes (annotated Effect Schemas; they are the SSOT) ----
/** The name of the acme health probe. */
export const AcmeProbeName = attr.string({
  key: 'acme.probe.name',
  cardinality: 'bounded',
  brief: 'The name of the acme health probe.',
  stability: 'development',
  examples: ['liveness', 'readiness'],
})

/** The acme deployment region (enum). */
export const AcmeRegion = attr.enum({
  key: 'acme.region',
  values: ['us_east', 'us_west', 'eu_central'],
  briefs: { us_east: 'US East.', us_west: 'US West.', eu_central: 'EU Central.' },
  brief: 'The acme deployment region.',
  stability: 'development',
})

/** The attempt number for the probe (1-based). */
export const AcmeAttempt = attr.number({
  key: 'acme.attempt',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'The attempt number for the probe (1-based).',
  stability: 'development',
  examples: [1, 2],
})

/** Structured deprecation (renamed) — exercises the `deprecated:` object form. */
export const AcmeProbeLabel = attr.string({
  key: 'acme.probe.label',
  cardinality: 'bounded',
  brief: 'Deprecated: use acme.probe.name.',
  stability: 'development',
  examples: ['liveness'],
  deprecated: { reason: 'renamed', renamed_to: 'acme.probe.name' },
})

/** template[...] attribute — dynamic per-probe header keys. Exercises the template path. */
export const AcmeRequestHeader = attr.template({
  key: 'acme.request.header',
  templateType: 'string',
  cardinality: 'high',
  brief: 'Dynamic request header values, keyed by header name.',
  stability: 'development',
  examples: ['application/json'],
})

/**
 * UPSTREAM OTel attribute REFERENCED (not redefined) — resolved via the manifest dependency.
 * Authored as a lightweight placeholder so the signal can reference the key; the foreign `http.*`
 * key makes the projector classify it as a ref, not a definition.
 */
export const HttpRequestMethod = attr.string({
  key: 'http.request.method',
  cardinality: 'low',
  brief: '(upstream OTel) HTTP request method.',
  stability: 'stable',
  examples: ['GET', 'POST'],
})

// ---- signals ----

/** span — refs the catalog; required/conditional/recommended map to encoder optionality. */
export const ProbeSpan = span({
  id: 'span.acme.probe',
  kind: 'server',
  brief: 'An acme health probe.',
  stability: 'development',
  attributes: {
    probeName: required(AcmeProbeName),
    // conditionally_required — exercises the object requirement-level form.
    region: conditionally({ schema: AcmeRegion, when: 'If the deployment region is known.' }),
    attempt: recommended(AcmeAttempt),
    // upstream ref — http.request.method resolved via the manifest dependency (foreign key).
    httpMethod: refExternal({ schema: HttpRequestMethod, requirement: 'recommended' }),
  },
})

/** metric — its labels reference the SAME catalog attributes as the span (decision 0003). */
export const ProbesTotal = metric({
  id: 'metric.acme.probes',
  name: 'acme.probes',
  instrument: 'counter',
  unit: '{probe}',
  brief: 'Acme probes by name and region.',
  stability: 'development',
  labels: {
    probeName: required(AcmeProbeName),
    region: recommended(AcmeRegion),
  },
})

/** histogram — exercises unit + boundaries authoring. */
export const ProbeDuration = metric({
  id: 'metric.acme.probe.duration',
  name: 'acme.probe.duration',
  instrument: 'histogram',
  unit: 's',
  brief: 'Acme probe wall-clock duration.',
  stability: 'development',
  boundaries: [0.005, 0.05, 0.5, 5],
  labels: {
    probeName: required(AcmeProbeName),
  },
})

/** operation — label EXTRACTOR fn; the label-source field is runtime-only, absent from registry. */
export const ProbeOperation = operation({
  id: 'span.acme.operation',
  name: 'acme.operation',
  brief: 'An acme operation with a derived span label.',
  stability: 'development',
  span_kind: 'internal',
  attributes: {
    probeName: required(AcmeProbeName),
  },
  labelFields: {
    label: OtelAttr.drop(Schema.NonEmptyString),
  },
  label: (v: { probeName: string }) => `acme:${v.probeName}`,
})

export default defineOtelContract({
  memberPath: 'packages/@overeng/otel-contract',
  displayName: 'Acme Attributes',
  signals: [ProbeSpan, ProbesTotal, ProbeDuration, ProbeOperation],
  // a doc-only attr not referenced by any signal — proves the derived catalog includes doc-only:
  docOnlyAttributes: [AcmeProbeLabel, AcmeRequestHeader],
})
