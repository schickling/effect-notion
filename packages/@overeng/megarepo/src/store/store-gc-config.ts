/**
 * GC reclamation config (three timers, decision 0008).
 *
 * Defaults are conservative-generous because the cold population is dominated
 * by worktrees much older than the windows. A host may override any subset via
 * `$STORE/.state/gc-config.json`; provided keys are merged over the defaults and
 * unknown/invalid files fall back to the defaults (never fail the gc path).
 */

import { isAbsolute, normalize } from 'node:path'

import { Effect, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { type PlatformError } from 'effect/PlatformError'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import * as Observability from '../core/observability.ts'

const DAY_MS = 24 * 60 * 60 * 1000

/** Canonical generated directories which may be considered by store GC. */
export const STORE_GC_GENERATED_ARTIFACTS = [
  'node_modules',
  '.devenv/pnpm-store-pure-v1',
  '.pnpm-store',
  '.direnv',
  'target',
  'buck-out',
  'dist',
  'build',
  '.next',
  '.turbo',
] as const

/** Generated-artifact directory class accepted by the bounded GC planner. */
export type StoreGcGeneratedArtifact = (typeof STORE_GC_GENERATED_ARTIFACTS)[number]

/** Default time without filesystem activity before an artifact can be planned. */
export const DEFAULT_GENERATED_ARTIFACT_RETENTION_MS = DAY_MS

/** Default: a worktree must be absent from ALL live sets this long before archive eligibility. */
export const DEFAULT_ABSENCE_GRACE_MS = 14 * DAY_MS

/** Default: do not archive until at least this long after the PR's `mergedAt`. */
export const DEFAULT_POST_MERGE_GRACE_MS = 7 * DAY_MS

/** Default: an archived worktree is reaped once it has been archived this long. */
export const DEFAULT_ARCHIVE_RETENTION_MS = 30 * DAY_MS

/** Fully-resolved reclamation timers in epoch-ms durations. */
export interface StoreGcConfig {
  readonly absenceGraceMs: number
  readonly postMergeGraceMs: number
  readonly archiveRetentionMs: number
  readonly generatedArtifacts: {
    readonly enabled: boolean
    readonly retentionMs: number
    readonly allowlist: ReadonlyArray<StoreGcGeneratedArtifact>
    readonly agentLivenessManifest?: string | undefined
    /**
     * Epoch that admits an `st2.workspace-activity.v1` snapshot: a snapshot is
     * evidence only when it was produced for THIS catalog and host, so a fresh
     * snapshot from another fleet epoch can never be trusted.
     */
    readonly agentLivenessEpoch?: { readonly catalog: string; readonly host: string } | undefined
  }
}

/** Defaults applied when no override file is present (or it is invalid). */
export const DEFAULT_STORE_GC_CONFIG: StoreGcConfig = {
  absenceGraceMs: DEFAULT_ABSENCE_GRACE_MS,
  postMergeGraceMs: DEFAULT_POST_MERGE_GRACE_MS,
  archiveRetentionMs: DEFAULT_ARCHIVE_RETENTION_MS,
  generatedArtifacts: {
    enabled: false,
    retentionMs: DEFAULT_GENERATED_ARTIFACT_RETENTION_MS,
    allowlist: STORE_GC_GENERATED_ARTIFACTS,
  },
} as const

/** On-disk override shape: every key optional; only provided keys override defaults. */
const StoreGcConfigOverride = Schema.Struct({
  absenceGraceMs: Schema.optional(Schema.Finite),
  postMergeGraceMs: Schema.optional(Schema.Finite),
  archiveRetentionMs: Schema.optional(Schema.Finite),
  generatedArtifacts: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean),
      retentionMs: Schema.optional(Schema.Finite),
      allowlist: Schema.optional(Schema.Array(Schema.Literals([...STORE_GC_GENERATED_ARTIFACTS]))),
      agentLivenessManifest: Schema.optional(Schema.String),
      agentLivenessEpoch: Schema.optional(
        Schema.Struct({ catalog: Schema.String, host: Schema.String }),
      ),
    }),
  ),
})

/** Parsed `gc-config.json` override: every timer optional. */
export type StoreGcConfigOverride = Schema.Schema.Type<typeof StoreGcConfigOverride>

const validDuration = ({
  value,
  fallback,
}: {
  value: number | undefined
  fallback: number
}): number =>
  value !== undefined && Number.isFinite(value) === true && value >= 0 ? value : fallback

const normalizedAbsolutePath = (path: string): string | undefined =>
  isAbsolute(path) === true && normalize(path) === path ? path : undefined

/** Relative path of the override file within the store. */
export const GC_CONFIG_RELATIVE_PATH = '.state/gc-config.json'

const gcConfigPath = (storeBasePath: AbsoluteDirPath) =>
  EffectPath.ops.join(storeBasePath, EffectPath.unsafe.relativeFile(GC_CONFIG_RELATIVE_PATH))

/**
 * Merge a parsed override over the defaults.
 *
 * Only keys actually present in the override take effect; `undefined` keys keep
 * the default. Pure so it is the unit-tested seam for the merge contract.
 */
export const mergeStoreGcConfig = (override: StoreGcConfigOverride): StoreGcConfig => {
  const agentLivenessManifest =
    override.generatedArtifacts?.agentLivenessManifest === undefined
      ? undefined
      : normalizedAbsolutePath(override.generatedArtifacts.agentLivenessManifest)
  const overrideEpoch = override.generatedArtifacts?.agentLivenessEpoch
  // Both halves are load-bearing; a half-configured epoch admits nothing.
  const agentLivenessEpoch =
    overrideEpoch === undefined ||
    normalizedAbsolutePath(overrideEpoch.catalog) === undefined ||
    overrideEpoch.host.length === 0
      ? undefined
      : { catalog: overrideEpoch.catalog, host: overrideEpoch.host }
  return {
    absenceGraceMs: validDuration({
      value: override.absenceGraceMs,
      fallback: DEFAULT_STORE_GC_CONFIG.absenceGraceMs,
    }),
    postMergeGraceMs: validDuration({
      value: override.postMergeGraceMs,
      fallback: DEFAULT_STORE_GC_CONFIG.postMergeGraceMs,
    }),
    archiveRetentionMs: validDuration({
      value: override.archiveRetentionMs,
      fallback: DEFAULT_STORE_GC_CONFIG.archiveRetentionMs,
    }),
    generatedArtifacts: {
      enabled:
        override.generatedArtifacts?.enabled ?? DEFAULT_STORE_GC_CONFIG.generatedArtifacts.enabled,
      retentionMs: validDuration({
        value: override.generatedArtifacts?.retentionMs,
        fallback: DEFAULT_STORE_GC_CONFIG.generatedArtifacts.retentionMs,
      }),
      allowlist: [
        ...new Set(
          override.generatedArtifacts?.allowlist ??
            DEFAULT_STORE_GC_CONFIG.generatedArtifacts.allowlist,
        ),
      ],
      ...(agentLivenessManifest === undefined ? {} : { agentLivenessManifest }),
      ...(agentLivenessEpoch === undefined ? {} : { agentLivenessEpoch }),
    },
  }
}

/**
 * Load the effective gc config from `$STORE/.state/gc-config.json`.
 *
 * Absent file ⇒ defaults. Unreadable or invalid file ⇒ defaults (the gc path
 * must not fail on a malformed override; defaults are the safe fallback).
 */
export const loadStoreGcConfig = ({
  storeBasePath,
}: {
  storeBasePath: AbsoluteDirPath
}): Effect.Effect<StoreGcConfig, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = gcConfigPath(storeBasePath)
    const override = yield* fs.readFileString(path).pipe(
      Effect.flatMap((content) =>
        Schema.decodeEffect(Schema.fromJsonString(StoreGcConfigOverride))(content),
      ),
      Effect.orElseSucceed(() => ({}) as StoreGcConfigOverride),
    )
    return mergeStoreGcConfig(override)
  }).pipe(
    Observability.withLabelSpan({ name: 'megarepo/store/gc/load-config', labelValue: 'gc-config' }),
  )
