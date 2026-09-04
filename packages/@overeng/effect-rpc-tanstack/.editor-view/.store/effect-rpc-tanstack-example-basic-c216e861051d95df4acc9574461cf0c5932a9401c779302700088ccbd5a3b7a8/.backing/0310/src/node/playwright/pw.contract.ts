/**
 * SEAM member contract for the `pw.*` telemetry namespace (decision 0005) — the OWN observability
 * of `@overeng/utils`' Effect-Playwright helpers (`src/node/playwright/*`), authored via the
 * Layer-2 `@overeng/otel-contract/registry` surface. This is the single home for the `pw.*`
 * telemetry catalog + signals: the Weaver registry projection AND the runtime encoders (the
 * playwright helper modules) both derive from it (SC-R13/R14).
 *
 * This is a `*.contract.ts` seam file, so it is exempt from the `otel-contract-in-seam-file` lint
 * and MUST be registered in the root aggregator's `memberSeamPaths` (a colocated no-orphan-seam
 * test asserts this).
 *
 * SCOPE — `pw` namespace only. All keys are already namespaced `pw.*` (no bare-key renames). Note
 * the `pw.*` keys are heavily camelCase (`pw.testId`, `pw.waitUntil`, `pw.viewport.width`,
 * `pw.step.parentSpan._tag`) — UNLIKE the snake_case fleet namespaces. These are the existing wire
 * keys and are preserved verbatim (behavior-preserving); `weaver registry check --future` accepts
 * them (empirically verified), so no rename is required.
 *
 * SINGLE REGISTERED SIGNAL: only `pw.wait.until` is a STATIC-name span carrying its own catalog
 * attributes, so it is the one projected span signal. Everything else in playwright telemetry is
 * either:
 *   - a DYNAMIC-NAME bridge span (`tryPw`'s per-op span, `Pw.Step.step`'s per-step span) whose name
 *     varies at runtime → no stable single-signal projection → stays legacy inline
 *     `OtelOperation.define` in `op.ts` / `step.ts`, rebuilding its encoder from the SAME catalog
 *     schemas exported here; its keys reach the catalog via `docOnlyAttributes` (SC-DQ5/SC-R13), or
 *   - a LABEL-ONLY static span (`pw.page.url`, `pw.page.isClosed`) with ZERO catalog attributes —
 *     weaver rejects an attribute-less span group, so these stay legacy inline in `page.ts` (there
 *     is nothing for the registry to hold; their only field is the runtime-only `span.label`), or
 *   - an ANNOTATE-only bundle (`OtelSpan.annotate` on the current span). The DSL exposes no
 *     sub-encoder, so each annotate bundle is a standalone `OtelAttrs.defineSync` reusing the SAME
 *     `attr.*` schema objects (byte-identical encode). Their keys land in the catalog via
 *     `docOnlyAttributes` (SC-R13 catalog completeness).
 *
 * TOOL-LOCAL OBSERVATION: playwright telemetry is arguably tool-local (test-harness scoped, like
 * otelite per decision 0007) rather than fleet-shared semconv. It is migrated anyway — it flows
 * through `@overeng/otel-contract` and benefits from the single SSOT — but its `pw.*` keys are not
 * expected to be referenced across the fleet.
 */
import { Schema } from 'effect'

import { OtelAttr, OtelAttrs } from '@overeng/otel-contract'
import { attr, defineOtelContract, operation, required } from '@overeng/otel-contract/registry'

// ---------------------------------------------------------------------------
// attributes (annotated Effect Schemas; the pw.* catalog SSOT)
// ---------------------------------------------------------------------------

// -- wait (referenced by the `pw.wait.until` signal) --
/** Stable identifier for a polling wait loop. */
export const PwWaitLabel = attr.string({
  key: 'pw.wait.label',
  cardinality: 'high',
  brief: 'Stable identifier for a polling wait loop.',
  stability: 'development',
  examples: ['sidebar-visible'],
})

/** Delay between retry attempts (Duration string). */
export const PwWaitPollInterval = attr.string({
  key: 'pw.wait.pollInterval',
  cardinality: 'bounded',
  brief: 'Delay between retry attempts (Duration string).',
  stability: 'development',
  examples: ['Duration(500 millis)'],
})

/** Maximum time to wait before failing (Duration string). */
export const PwWaitTimeout = attr.string({
  key: 'pw.wait.timeout',
  cardinality: 'bounded',
  brief: 'Maximum time to wait before failing (Duration string).',
  stability: 'development',
  examples: ['Duration(30 seconds)'],
})

// -- wait attempt (annotate-only) --
/** 1-based attempt number of a polling wait loop. */
export const PwWaitAttempt = attr.number({
  key: 'pw.wait.attempt',
  weaverType: 'int',
  cardinality: 'low',
  brief: '1-based attempt number of a polling wait loop.',
  stability: 'development',
  examples: [1, 2],
})

// -- op / try / expect (dynamic-name bridge + annotate-only) --
/** Stable Playwright operation identifier a bridged span wraps. */
export const PwOp = attr.string({
  key: 'pw.op',
  cardinality: 'high',
  brief: 'Stable Playwright operation identifier a bridged span wraps.',
  stability: 'development',
  examples: ['pw.page.goto', 'pw.context.cookies'],
})

/** Short operation name for a generic `Pw.try` wrapper. */
export const PwTryOp = attr.string({
  key: 'pw.try.op',
  cardinality: 'high',
  brief: 'Short operation name for a generic `Pw.try` wrapper.',
  stability: 'development',
  examples: ['set-viewport'],
})

/** Short assertion name for a `Pw.expect` wrapper. */
export const PwExpectAssertion = attr.string({
  key: 'pw.expect.assertion',
  cardinality: 'high',
  brief: 'Short assertion name for a `Pw.expect` wrapper.',
  stability: 'development',
  examples: ['sidebar-visible'],
})

// -- step (dynamic-name bridge) --
/** Whether the span is a Playwright `test.step` boundary. */
export const PwStep = attr.boolean({
  key: 'pw.step',
  brief: 'Whether the span is a Playwright `test.step` boundary.',
  stability: 'development',
})

/** Name of a Playwright `test.step` boundary. */
export const PwStepName = attr.string({
  key: 'pw.step.name',
  cardinality: 'high',
  brief: 'Name of a Playwright `test.step` boundary.',
  stability: 'development',
  examples: ['Custom operation'],
})

/** Effect-span `_tag` of the parent enclosing a `test.step` boundary. */
export const PwStepParentSpanTag = attr.string({
  key: 'pw.step.parentSpan._tag',
  cardinality: 'bounded',
  brief: 'Effect-span _tag of the parent enclosing a test.step boundary.',
  stability: 'development',
  examples: ['Some'],
})

// -- locator + page: shared timeout (annotate-only) --
/** Operation timeout in milliseconds. */
export const PwTimeoutMs = attr.number({
  key: 'pw.timeout.ms',
  weaverType: 'int',
  cardinality: 'high',
  brief: 'Operation timeout in milliseconds.',
  stability: 'development',
  examples: [5000],
})

// -- locator (annotate-only) --
/** Length of a value written into an input. */
export const PwValueLen = attr.number({
  key: 'pw.value.len',
  weaverType: 'int',
  cardinality: 'high',
  brief: 'Length of a value written into an input.',
  stability: 'development',
  examples: [12],
})

/** Length of text typed into a locator. */
export const PwTextLen = attr.number({
  key: 'pw.text.len',
  weaverType: 'int',
  cardinality: 'high',
  brief: 'Length of text typed into a locator.',
  stability: 'development',
  examples: [12],
})

/** Per-key typing delay in milliseconds. */
export const PwDelayMs = attr.number({
  key: 'pw.delay.ms',
  weaverType: 'int',
  cardinality: 'high',
  brief: 'Per-key typing delay in milliseconds.',
  stability: 'development',
  examples: [50],
})

/** Jitter applied before an interaction in milliseconds. */
export const PwJitterMs = attr.number({
  key: 'pw.jitter.ms',
  weaverType: 'int',
  cardinality: 'high',
  brief: 'Jitter applied before an interaction in milliseconds.',
  stability: 'development',
  examples: [250],
})

/** Keyboard key pressed on a locator. */
export const PwKey = attr.string({
  key: 'pw.key',
  cardinality: 'bounded',
  brief: 'Keyboard key pressed on a locator.',
  stability: 'development',
  examples: ['Enter', 'Escape'],
})

/** CSS or Playwright selector for a locator. */
export const PwSelector = attr.string({
  key: 'pw.selector',
  cardinality: 'high',
  brief: 'CSS or Playwright selector for a locator.',
  stability: 'development',
  examples: ['#submit'],
})

/** ARIA role a locator matches. */
export const PwRole = attr.string({
  key: 'pw.role',
  cardinality: 'bounded',
  brief: 'ARIA role a locator matches.',
  stability: 'development',
  examples: ['button', 'link'],
})

/** Accessible name a locator matches. */
export const PwName = attr.string({
  key: 'pw.name',
  cardinality: 'high',
  brief: 'Accessible name a locator matches.',
  stability: 'development',
  examples: ['Submit'],
})

/** Test id a locator matches. */
export const PwTestId = attr.string({
  key: 'pw.testId',
  cardinality: 'high',
  brief: 'Test id a locator matches.',
  stability: 'development',
  examples: ['submit-btn'],
})

/** Text a locator matches. */
export const PwText = attr.string({
  key: 'pw.text',
  cardinality: 'high',
  brief: 'Text a locator matches.',
  stability: 'development',
  examples: ['Sign in'],
})

/** Label text a locator matches. */
export const PwLabel = attr.string({
  key: 'pw.label',
  cardinality: 'high',
  brief: 'Label text a locator matches.',
  stability: 'development',
  examples: ['Email'],
})

/** Placeholder text a locator matches. */
export const PwPlaceholder = attr.string({
  key: 'pw.placeholder',
  cardinality: 'high',
  brief: 'Placeholder text a locator matches.',
  stability: 'development',
  examples: ['you@example.com'],
})

// -- page (annotate-only) --
/** Target URL a navigation goes to. */
export const PwUrl = attr.string({
  key: 'pw.url',
  cardinality: 'high',
  brief: 'Target URL a navigation goes to.',
  stability: 'development',
  examples: ['https://example.com'],
})

/** Navigation wait strategy. */
export const PwWaitUntil = attr.string({
  key: 'pw.waitUntil',
  cardinality: 'bounded',
  brief: 'Navigation wait strategy.',
  stability: 'development',
  examples: ['load', 'networkidle'],
})

/** Load state waited for. */
export const PwLoadState = attr.string({
  key: 'pw.loadState',
  cardinality: 'bounded',
  brief: 'Load state waited for.',
  stability: 'development',
  examples: ['domcontentloaded', 'networkidle'],
})

/** URL pattern waited for (string / RegExp source / predicate marker). */
export const PwUrlMatch = attr.string({
  key: 'pw.urlMatch',
  cardinality: 'high',
  brief: 'URL pattern waited for (string / RegExp source / predicate marker).',
  stability: 'development',
  examples: ['/dashboard'],
})

/** Minimum jitter delay in milliseconds. */
export const PwJitterMsMin = attr.number({
  key: 'pw.jitter.msMin',
  weaverType: 'int',
  cardinality: 'high',
  brief: 'Minimum jitter delay in milliseconds.',
  stability: 'development',
  examples: [120],
})

/** Maximum jitter delay in milliseconds. */
export const PwJitterMsMax = attr.number({
  key: 'pw.jitter.msMax',
  weaverType: 'int',
  cardinality: 'high',
  brief: 'Maximum jitter delay in milliseconds.',
  stability: 'development',
  examples: [420],
})

/** Viewport width in pixels. */
export const PwViewportWidth = attr.number({
  key: 'pw.viewport.width',
  weaverType: 'int',
  cardinality: 'high',
  brief: 'Viewport width in pixels.',
  stability: 'development',
  examples: [1200],
})

/** Viewport height in pixels. */
export const PwViewportHeight = attr.number({
  key: 'pw.viewport.height',
  weaverType: 'int',
  cardinality: 'high',
  brief: 'Viewport height in pixels.',
  stability: 'development',
  examples: [800],
})

/** Filesystem path a screenshot is written to. */
export const PwScreenshotPath = attr.string({
  key: 'pw.screenshot.path',
  cardinality: 'high',
  brief: 'Filesystem path a screenshot is written to.',
  stability: 'development',
  examples: ['tmp/screenshot.png'],
})

/** Whether a screenshot captures the full page. */
export const PwScreenshotFullPage = attr.boolean({
  key: 'pw.screenshot.fullPage',
  brief: 'Whether a screenshot captures the full page.',
  stability: 'development',
})

// -- context (annotate-only) --
/** Number of cookies read from / added to a browser context. */
export const PwCookieCount = attr.number({
  key: 'pw.cookie.count',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Number of cookies read from / added to a browser context.',
  stability: 'development',
  examples: [3],
})

/** URL(s) a cookie query is scoped to. */
export const PwCookiesUrl = attr.string({
  key: 'pw.cookies.url',
  cardinality: 'high',
  brief: 'URL(s) a cookie query is scoped to.',
  stability: 'development',
  examples: ['https://example.com'],
})

/** Filesystem path a browser context storage state is written to. */
export const PwStorageStatePath = attr.string({
  key: 'pw.storageState.path',
  cardinality: 'high',
  brief: 'Filesystem path a browser context storage state is written to.',
  stability: 'development',
  examples: ['tmp/state.json'],
})

// ---------------------------------------------------------------------------
// signal (the ONE static-name-with-attributes operation)
// ---------------------------------------------------------------------------

/** The runtime-only span-label source field. */
const labelField = { label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()) } as const

/** `pw.wait.until` — a polling "wait until ready" loop. */
export const PwWaitOperation = operation({
  id: 'span.pw.wait.until',
  name: 'pw.wait.until',
  brief: 'A polling "wait until ready" loop.',
  stability: 'development',
  span_kind: 'internal',
  attributes: {
    waitLabel: required(PwWaitLabel),
    pollInterval: required(PwWaitPollInterval),
    timeout: required(PwWaitTimeout),
  },
  labelFields: labelField,
  label: (v: { label: string }): string => v.label,
})

// ---------------------------------------------------------------------------
// annotate-only encoders (standalone; reuse the SAME attr schemas → identical encode).
// `OtelSpan.annotate` attaches these to whatever span is current at the call site.
// ---------------------------------------------------------------------------

/** Locator interaction attributes (annotated onto the current span). */
export const PwLocatorAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    timeoutMs: Schema.optional(PwTimeoutMs),
    valueLen: Schema.optional(PwValueLen),
    textLen: Schema.optional(PwTextLen),
    delayMs: Schema.optional(PwDelayMs),
    jitterMs: Schema.optional(PwJitterMs),
    key: Schema.optional(PwKey),
    selector: Schema.optional(PwSelector),
    role: Schema.optional(PwRole),
    name: Schema.optional(PwName),
    testId: Schema.optional(PwTestId),
    text: Schema.optional(PwText),
    label: Schema.optional(PwLabel),
    placeholder: Schema.optional(PwPlaceholder),
  }),
)

/** Page navigation attributes (annotated onto the current span). */
export const PwPageAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    url: Schema.optional(PwUrl),
    waitUntil: Schema.optional(PwWaitUntil),
    loadState: Schema.optional(PwLoadState),
    timeoutMs: Schema.optional(PwTimeoutMs),
    urlMatch: Schema.optional(PwUrlMatch),
    jitterMsMin: Schema.optional(PwJitterMsMin),
    jitterMsMax: Schema.optional(PwJitterMsMax),
    viewportWidth: Schema.optional(PwViewportWidth),
    viewportHeight: Schema.optional(PwViewportHeight),
    screenshotPath: Schema.optional(PwScreenshotPath),
    screenshotFullPage: Schema.optional(PwScreenshotFullPage),
  }),
)

/** Browser context attributes (annotated onto the current span). */
export const PwContextAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    cookieCount: Schema.optional(PwCookieCount),
    cookiesUrl: Schema.optional(PwCookiesUrl),
    storageStatePath: Schema.optional(PwStorageStatePath),
  }),
)

/** Wait-attempt attribute (annotated onto the current span per retry). */
export const PwWaitAttemptAttrs = OtelAttrs.defineSync(Schema.Struct({ attempt: PwWaitAttempt }))

/** Generic `Pw.try` attribute (annotated onto the current span). */
export const PwTryAttrs = OtelAttrs.defineSync(Schema.Struct({ op: PwTryOp }))

/** `Pw.expect` attribute (annotated onto the current span). */
export const PwExpectAttrs = OtelAttrs.defineSync(Schema.Struct({ assertion: PwExpectAssertion }))

// ---------------------------------------------------------------------------
// contract seam (namespace `pw`, derived).
// ---------------------------------------------------------------------------

export default defineOtelContract({
  memberPath: 'packages/@overeng/utils',
  displayName: 'Playwright Attributes',
  signals: [PwWaitOperation],
  // Keys reaching the catalog ONLY via an annotate-only bundle or a dynamic-name / label-only
  // bridge span (no static single-signal open-ref carries them). Catalog completeness (SC-R13).
  docOnlyAttributes: [
    // annotate-only: PwWaitAttemptAttrs
    PwWaitAttempt,
    // dynamic-name bridge: tryPw's per-op span (op.ts)
    PwOp,
    // annotate-only: PwTryAttrs / PwExpectAttrs
    PwTryOp,
    PwExpectAssertion,
    // dynamic-name bridge: Pw.Step.step's per-step span (step.ts)
    PwStep,
    PwStepName,
    PwStepParentSpanTag,
    // annotate-only: PwLocatorAttrs
    PwTimeoutMs,
    PwValueLen,
    PwTextLen,
    PwDelayMs,
    PwJitterMs,
    PwKey,
    PwSelector,
    PwRole,
    PwName,
    PwTestId,
    PwText,
    PwLabel,
    PwPlaceholder,
    // annotate-only: PwPageAttrs
    PwUrl,
    PwWaitUntil,
    PwLoadState,
    PwUrlMatch,
    PwJitterMsMin,
    PwJitterMsMax,
    PwViewportWidth,
    PwViewportHeight,
    PwScreenshotPath,
    PwScreenshotFullPage,
    // annotate-only: PwContextAttrs
    PwCookieCount,
    PwCookiesUrl,
    PwStorageStatePath,
  ],
})
