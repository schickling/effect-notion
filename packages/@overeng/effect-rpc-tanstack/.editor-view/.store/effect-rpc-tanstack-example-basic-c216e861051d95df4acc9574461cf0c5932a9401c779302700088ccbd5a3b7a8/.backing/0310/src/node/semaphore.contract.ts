/**
 * SEAM member contract for the `semaphore.*` telemetry namespace (decision 0005) — the OWN
 * observability of `@overeng/utils`' file-system distributed-semaphore backing
 * (`src/node/file-system-backing.ts`), authored via the Layer-2 `@overeng/otel-contract/registry`
 * surface. This is the single home for the `semaphore.*` catalog + signals: the Weaver registry
 * projection AND the runtime encoders both derive from it (SC-R13/R14).
 *
 * This is a `*.contract.ts` seam file, so it is exempt from the `otel-contract-in-seam-file` lint
 * and MUST be registered in the root aggregator's `memberSeamPaths` (a colocated no-orphan-seam
 * test asserts this).
 *
 * Placement: `src/node/` (utils has a dep-free `isomorphic/` zone, but `file-system-backing.ts`
 * lives under `node/` and already imports `@overeng/otel-contract` at runtime, so this file's
 * `./registry` import is runtime-safe here).
 *
 * SCOPE — `semaphore` namespace only. Both keys are already namespaced `semaphore.*` (NO bare-key
 * renames). Both operations are STATIC-name spans carrying catalog attributes, so both project as
 * registered `span` signals (no dynamic-name bridge / doc-only attribute needed).
 */
import { Schema } from 'effect'

import { OtelAttr } from '@overeng/otel-contract'
import { attr, defineOtelContract, operation, required } from '@overeng/otel-contract/registry'

// ---------------------------------------------------------------------------
// attributes (annotated Effect Schemas; the semaphore.* catalog SSOT)
// ---------------------------------------------------------------------------

/** Semaphore key (lock name) an operation acts on. */
export const SemaphoreKey = attr.string({
  key: 'semaphore.key',
  cardinality: 'high',
  brief: 'Semaphore key (lock name) an operation acts on.',
  stability: 'development',
  examples: ['deploy-lock', 'migration/2026-07-01'],
})

/** Holder id whose lock is being force-revoked. */
export const SemaphoreTargetHolderId = attr.string({
  key: 'semaphore.target_holder_id',
  cardinality: 'high',
  brief: 'Holder id whose lock is being force-revoked.',
  stability: 'development',
  examples: ['holder-42', 'ci-runner-7'],
})

// ---------------------------------------------------------------------------
// signals (operations: static-name spans; label derived from a runtime-only field)
// ---------------------------------------------------------------------------

/** The runtime-only span-label source field (dropped from attribute output; SC-T03). */
const labelField = { label: OtelAttr.drop(Schema.NonEmptyString) } as const
const labelOf = (v: { label: string }): string => v.label

/** `FileSystemBacking.semaphore.key` — a keyed semaphore acquire/release/etc. */
export const SemaphoreKeyOperation = operation({
  id: 'span.semaphore.key',
  name: 'FileSystemBacking.semaphore.key',
  brief: 'A keyed file-system semaphore operation.',
  stability: 'development',
  span_kind: 'internal',
  attributes: {
    key: required(SemaphoreKey),
  },
  labelFields: labelField,
  label: labelOf,
})

/** `FileSystemBacking.semaphore.forceRevoke` — force-revoke a specific holder's lock. */
export const SemaphoreForceRevokeOperation = operation({
  id: 'span.semaphore.force_revoke',
  name: 'FileSystemBacking.semaphore.forceRevoke',
  brief: "Force-revoke a specific holder's lock on a semaphore key.",
  stability: 'development',
  span_kind: 'internal',
  attributes: {
    key: required(SemaphoreKey),
    targetHolderId: required(SemaphoreTargetHolderId),
  },
  labelFields: labelField,
  label: labelOf,
})

// ---------------------------------------------------------------------------
// contract seam (namespace `semaphore`, derived).
// ---------------------------------------------------------------------------

export default defineOtelContract({
  memberPath: 'packages/@overeng/utils',
  displayName: 'Semaphore Attributes',
  signals: [SemaphoreKeyOperation, SemaphoreForceRevokeOperation],
})
