/**
 * Root aggregator (design-time) for the first-party OTel semantic-convention registry.
 *
 * Imports every member seam contract, projects each to a Layer-1 fragment (via
 * `@overeng/otel-contract` `./registry`), and composes them into ONE Weaver registry (via
 * `@overeng/genie` `./composition`, which enforces namespace uniqueness + global ref
 * integrity). Computes the provenance fingerprints HERE — `node:crypto` is available at
 * design time; genie's dep-free Layer 1 never hashes.
 *
 * This module is imported by the sibling `*.genie.ts` emitters; the genie engine renders one
 * output file per emitter (manifest / attributes / signals / TS + Rust constants). It is
 * deliberately NOT a `.genie.ts` (it emits nothing itself). Emitters are one-liners over the
 * exported {@link weaver} bundle (design A').
 *
 * NOTE: `@overeng/otel-contract` cannot import `@overeng/genie` (genie depends on it — a
 * project-reference cycle), so the two `RegistryFragment` type mirrors meet HERE; this
 * module's typecheck is the drift guard between them.
 */
import { createHash } from 'node:crypto'

import ciToolsContract from '../../packages/@overeng/ci-tools/src/deploy-domain.contract.ts'
import cliContract from '../../packages/@overeng/genie/src/core/cli.contract.ts'
import genieContract from '../../packages/@overeng/genie/src/core/genie.contract.ts'
import { registryFromMembers } from '../../packages/@overeng/genie/src/runtime/composition/mod.ts'
import type {
  Provenance,
  WeaverRegistryBundle,
} from '../../packages/@overeng/genie/src/runtime/weaver/mod.ts'
import { signalNames } from '../../packages/@overeng/genie/src/runtime/weaver/mod.ts'
import gitContract from '../../packages/@overeng/megarepo/src/git.contract.ts'
import megarepoContract from '../../packages/@overeng/megarepo/src/megarepo.contract.ts'
import nixContract from '../../packages/@overeng/megarepo/src/nix.contract.ts'
import notionDatasourceSyncContract from '../../packages/@overeng/notion-datasource-sync/src/observability/notion-datasource.contract.ts'
import notionEffectClientContract from '../../packages/@overeng/notion-effect-client/src/notion-effect-client.contract.ts'
import notionMdContract from '../../packages/@overeng/notion-md/src/notion-md.contract.ts'
import notionReactContract from '../../packages/@overeng/notion-react/src/notion-react.contract.ts'
import demoContract from '../../packages/@overeng/otel-contract/src/registry-demo.contract.ts'
import { fragment } from '../../packages/@overeng/otel-contract/src/registry.ts'
import ptyContract from '../../packages/@overeng/pty-effect/src/pty.contract.ts'
import restateContract from '../../packages/@overeng/restate-effect/src/observability/restate.contract.ts'
import cmdContract from '../../packages/@overeng/utils/src/node/cmd.contract.ts'
import pwContract from '../../packages/@overeng/utils/src/node/playwright/pw.contract.ts'
import semaphoreContract from '../../packages/@overeng/utils/src/node/semaphore.contract.ts'

// --- pinned semantic inputs (all change the emitted output → part of the fingerprint) ---
export const PINNED_WEAVER_VERSION = '0.26.1'
export const PINNED_UPSTREAM_SEMCONV_VERSION = 'v1.44.0'
/** Bump when the emitter's output shape changes (independent of the authored registry). */
export const GENERATOR_VERSION = '1'

/**
 * The member seam files composed into this registry. The no-orphan-seam check (a colocated
 * test) globs every `*.contract.ts` on disk and asserts each appears here — the completeness
 * guarantee the path-based lint structurally cannot provide (decision 0005).
 */
export const memberSeamPaths = [
  'packages/@overeng/ci-tools/src/deploy-domain.contract.ts',
  'packages/@overeng/genie/src/core/cli.contract.ts',
  'packages/@overeng/genie/src/core/genie.contract.ts',
  'packages/@overeng/megarepo/src/git.contract.ts',
  'packages/@overeng/megarepo/src/megarepo.contract.ts',
  'packages/@overeng/megarepo/src/nix.contract.ts',
  'packages/@overeng/notion-datasource-sync/src/observability/notion-datasource.contract.ts',
  'packages/@overeng/notion-effect-client/src/notion-effect-client.contract.ts',
  'packages/@overeng/notion-md/src/notion-md.contract.ts',
  'packages/@overeng/notion-react/src/notion-react.contract.ts',
  'packages/@overeng/otel-contract/src/registry-demo.contract.ts',
  'packages/@overeng/pty-effect/src/pty.contract.ts',
  'packages/@overeng/restate-effect/src/observability/restate.contract.ts',
  'packages/@overeng/utils/src/node/cmd.contract.ts',
  'packages/@overeng/utils/src/node/playwright/pw.contract.ts',
  'packages/@overeng/utils/src/node/semaphore.contract.ts',
] as const

const contracts = [
  ciToolsContract,
  cliContract,
  genieContract,
  gitContract,
  megarepoContract,
  nixContract,
  notionDatasourceSyncContract,
  notionEffectClientContract,
  notionMdContract,
  notionReactContract,
  demoContract,
  ptyContract,
  restateContract,
  cmdContract,
  pwContract,
  semaphoreContract,
]

// Build members: each member contributes its fragment on the non-emitted `meta.registry`
// channel (a minimal GenieOutput — no per-member slice is emitted for M1).
const members = contracts.map((c) => {
  const f = fragment(c)
  return { data: f, stringify: () => '', meta: { registry: f } }
})

const composition = registryFromMembers({
  members,
  name: 'acme-effect-utils',
  description: 'First-party OpenTelemetry semantic-convention registry (effect-utils).',
  schemaUrl: 'https://opentelemetry.io/schemas/acme/0.1.0',
  upstream: [
    {
      // Pinned upstream OTel semconv. weaver resolves `http.*` refs against this dependency.
      // The `weaver:check` task materializes it hermetically as a local FS path (SC-A03,
      // confirmed working with 0.24.2). The committed string is the portable git-URL form.
      dependency: {
        name: 'otel',
        registry_path: `https://github.com/open-telemetry/semantic-conventions.git@${PINNED_UPSTREAM_SEMCONV_VERSION}[model]`,
      },
      providesNamespaces: ['http'],
    },
  ],
})

export const registry = composition.registry
export const compositionIssues = composition.issues

// --- provenance fingerprints (GEN-R07), split so doc-only edits don't churn const targets ---
const sha256 = (value: unknown): string =>
  `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`

const versionInputs = {
  weaver: PINNED_WEAVER_VERSION,
  upstream: PINNED_UPSTREAM_SEMCONV_VERSION,
  generator: GENERATOR_VERSION,
}

/** Identity = the exact names the TS/Rust const targets encode (no doc prose). */
const identityKeys = registry.groups
  .flatMap((g) => g.attributes.map((a) => a.id))
  .toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0))
const identityNames = {
  attributeKeys: identityKeys,
  ...signalNames(registry),
}

/** Doc fingerprint: the FULL registry (brief/stability/examples/notes/deprecated) → YAML headers. */
export const docFingerprint = sha256({ registry, ...versionInputs })
/** Identity fingerprint: constant names only → TS/Rust const headers (a prose edit must not churn these). */
export const identityFingerprint = sha256({ ...identityNames, ...versionInputs })

export const REGISTRY_SOURCE = 'genie/weaver-registry/registry.ts'
export const docProvenance: Provenance = { source: REGISTRY_SOURCE, fingerprint: docFingerprint }
export const identityProvenance: Provenance = {
  source: REGISTRY_SOURCE,
  fingerprint: identityFingerprint,
}

/** The own namespaces, all collapsed into ONE `attributes.yaml` (adding a namespace needs no new emitter). */
export const namespaces = registry.groups.map((g) => g.namespace)

/**
 * The complete design-time input every `*.genie.ts` emitter consumes (design A'): the composed
 * registry, the three split provenance fingerprints, and the whole-registry integrity issues.
 * Each emitter is a one-liner over this bundle (e.g. `export default weaverSignals(weaver)`).
 */
export const weaver: WeaverRegistryBundle = {
  registry,
  docProvenance,
  identityProvenance,
  issues: compositionIssues,
}
