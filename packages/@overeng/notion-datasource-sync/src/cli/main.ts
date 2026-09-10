#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { NodeRuntime } from '@effect/platform-node'
import * as NodeContext from '@effect/platform-node/NodeServices'
import { Effect, Layer, Option, Redacted, Schema, Stream } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'

import {
  NOTION_API_VERSION,
  NOTION_TOKEN_ENV_VARS,
  NotionConfigLive,
  NotionHttpTelemetry,
  parseNotionUuid,
  type NotionHttpTelemetryEvent,
} from '@overeng/notion-effect-client'
import {
  NmdStateStore,
  NmdStateStoreLive,
  NotionMdGateway,
  NotionMdGatewayLive,
} from '@overeng/notion-md'
import { ServiceIdentity } from '@overeng/otel-contract'
import { resolveCliVersion } from '@overeng/utils/node/cli-version'
import { otelEndpointFromConfig, withTelemetry } from '@overeng/utils/node/otel'

import { makeUnsupportedPageBodySyncPort } from '../body/adapter.ts'
import {
  makeNotionMdMaterializingLocalWorkspacePort,
  makeNotionMdPageBodySyncPort,
} from '../body/notion-md.ts'
import { CanonicalPropertyValue, QueryContract } from '../core/commands.ts'
import { NonEmptyTrimmedString } from '../core/domain.ts'
import {
  AbsolutePath,
  DatabaseId,
  DataSourceId,
  Hash,
  PageId,
  PropertyId,
  WorkspaceRelativePath,
  type CapabilityName,
  type WorkspaceRelativePath as WorkspaceRelativePathType,
} from '../core/domain.ts'
import { WorkspaceNamespaceError, WorkspaceNotTracked } from '../core/errors.ts'
import type {
  BodySyncError,
  LocalStorageError,
  LocalStoreError,
  NotionGatewayError,
} from '../core/errors.ts'
import { SyncEventId, SyncRootId, type SyncRootId as SyncRootIdType } from '../core/events.ts'
import {
  LocalWorkspacePort,
  NotionDataSourceGateway,
  PageBodySyncPort,
  type LocalWorkspacePortShape,
  type NotionDataSourceGatewayShape,
  type PageBodySyncPortShape,
} from '../core/ports.ts'
import { SyncProgress, type SyncProgressEvent } from '../core/progress.ts'
import { readUserActionSurface, type UserActionSurface } from '../core/result-envelope.ts'
import type { SignalInboxStatus } from '../core/signals.ts'
import { readOneShotSyncStatus, type OneShotSyncStatus } from '../core/status.ts'
import {
  makeWatchDaemonWakeNotifier,
  runWatchDaemon,
  type WatchDaemonMode,
  type WatchDaemonRunResult,
  type WatchDaemonWakeNotifier,
} from '../daemon/watch.ts'
import {
  exportReplica,
  ReplicaExportError,
  type ReplicaExportFormat,
  type ReplicaExportResult,
} from '../export/replica-export.ts'
import {
  allGatewayCapabilities,
  makeGatewayError,
  makeNotionApiContract,
  type GatewayOperation,
} from '../gateway/gateway.ts'
import {
  makeNotionEffectClientGatewayClient,
  makeNotionDataSourceGatewayFromClient,
  NotionDataSourceGatewayLive,
  type NotionGatewayClient,
} from '../gateway/notion.ts'
import {
  dataDirectoryName,
  dataFilePath,
  dataFileRelativePath,
  hiddenStateDirectoryName,
  loadWorkspaceManifest,
  manifestPath,
  pagesDirRelativePath,
  stateSqlitePath,
  writeWorkspaceManifestSync,
  type AuthorityMode,
  type WorkspaceManifestDataSourceV1,
  type WorkspaceManifestV1,
} from '../local/manifest.ts'
import { bodyPathForRowInDir, filesystemLocalWorkspacePortLayer } from '../local/workspace.ts'
import {
  annotateSpan,
  otelServiceNameForCliArgv,
  otelCorrelationSpanAttributes,
  otelServiceNames,
  processRoleForCliCommand,
  shortSpanId,
  spanAttr,
  spanAttributes,
  spanLabel,
  spanNames,
  statusSpanAttributes,
  withSpan,
} from '../observability/observability.ts'
import {
  convergeLocalSurfaces,
  type LocalIdentity,
  type PropertyConvergenceVerdict,
} from '../planner/local-convergence.ts'
import type { PlannerIntent } from '../planner/planner.ts'
import {
  forgetPageCommand,
  listUserCommandSurface,
  resolveConflictCommand,
  restorePageCommand,
  type ConflictResolutionChoice,
  type UserCommandResultEnvelope,
} from '../planner/user-commands.ts'
import {
  applyReplicaConflictResolutions,
  projectReplicaFromSyncStore,
  readPendingReplicaChanges,
  readReplicaCellBases,
  replicaChangesToPlannerIntents,
  settleReplicaChangesAfterSync,
} from '../replica/replica.ts'
import {
  type CompactionDecision,
  openNotionSyncStore,
  type NotionSyncStore,
  type WorkspaceBindingRow,
} from '../store/store.ts'
import { buildPropertyConvergenceInputs } from '../sync/local-convergence-inputs.ts'
import { makeConflictRaisedEvent, type SchemaPropertyObservation } from '../sync/observation.ts'
import {
  establishFromNotion,
  initOneShotSync,
  pullOneShotSync,
  pushOneShotSync,
  syncOneShot,
  type EstablishFromNotionResult,
  type OneShotPullResult,
  type OneShotPushResult,
  type OneShotSyncResult,
} from '../sync/sync.ts'
import {
  startNotionWebhookReceiver,
  type NotionWebhookReceiverHandle,
  type NotionWebhookReceiverStatus,
} from '../webhook/receiver.ts'
import {
  makeManualWebhookRelayProvider,
  makeTailscaleFunnelProvider,
  type TailscaleProcessRunner,
  type WebhookRelayExposure,
} from '../webhook/tailscale.ts'
import { renderDatasourceSyncCompletions, type CompletionShell } from './effect-command.ts'

const buildStamp = '__CLI_BUILD_STAMP__'
const cliVersion = resolveCliVersion({
  baseVersion: '0.1.0',
  buildStamp,
})

/**
 * Body path for a page within a tracked source's page directory
 * (`pages/v1/<name>/<title-slug>--<pageId>.nmd`). The title is synthesized from
 * the page id at observation time (the row title is not threaded here), matching
 * the legacy `defaultBodyPathForPage` filename convention but rooted in the
 * source's `pages_dir`. Falls back to a bare `pages/v1/<name>/page-<id>.nmd` if
 * the canonical filename is somehow rejected.
 */
const bodyPathForPageInSourceDir = ({
  pagesDir,
  pageId,
}: {
  readonly pagesDir: string
  readonly pageId: PageId
}): WorkspaceRelativePathType => {
  const decision = bodyPathForRowInDir({ pagesDir, title: `page-${pageId}`, pageId })
  return decision._tag === 'blocked'
    ? decode({ schema: WorkspaceRelativePath, value: `${pagesDir}/page-${pageId}.nmd` })
    : decision.path
}

const remoteObservationContext = (context: CliContext) => ({
  ...(context.requiredCapabilities === undefined
    ? {}
    : { requiredCapabilities: context.requiredCapabilities }),
  ...(context.materializeBodies === undefined
    ? {}
    : { materializeBodies: context.materializeBodies }),
  // Tracked workspace: materialize `.nmd` page files under the source's
  // `pages/v1/<name>` directory (one page directory per source). A standalone
  // `--sqlite` file has no page directory and keeps the legacy root-level path.
  ...(context.sourcePagesDir === undefined
    ? {}
    : {
        bodyPathForPage: (pageId: PageId): WorkspaceRelativePathType =>
          bodyPathForPageInSourceDir({ pagesDir: context.sourcePagesDir!, pageId }),
      }),
})

/**
 * Tagged union of all commands the CLI accepts.
 *
 * Each variant carries only the flags that are meaningful for that sub-command.
 * Use `parseCliCommand` to decode raw `argv` into this type.
 */
export type CliCommand =
  | {
      readonly _tag: 'init'
      readonly dataSourceId: DataSourceId
      readonly workspaceRoot: AbsolutePath
      readonly dryRun?: boolean
    }
  | { readonly _tag: 'pull' }
  | { readonly _tag: 'push'; readonly dryRun?: boolean }
  | {
      readonly _tag: 'sync'
      readonly workspaceRoot?: AbsolutePath
      readonly dryRun?: boolean
      readonly watch?: boolean
      readonly statePath?: string
      readonly maxCycles?: number
      readonly watchPriority?: WatchDaemonMode
      readonly webhook?: 'none' | 'tailscale' | 'manual'
      readonly webhookRequired?: boolean
      readonly nonInteractive?: boolean
    }
  | {
      readonly _tag: 'sync-from-notion'
      readonly dataSourceId: DataSourceId
      readonly remoteRef: NotionRemoteRef
      readonly workspaceRoot: AbsolutePath
      readonly dryRun?: boolean
      readonly limit?: number
    }
  | {
      /**
       * `track` is the adoption verb (decision 0004): it adopts a Notion data
       * source into a workspace and is the canonical workspace-establish command.
       * It is the ONLY command that accepts `--mode`; the chosen authority mode is
       * persisted into `notion.workspace.v1.json`. Shares the establish machinery
       * of `sync-from-notion`.
       */
      readonly _tag: 'track'
      readonly dataSourceId: DataSourceId
      readonly remoteRef: NotionRemoteRef
      readonly workspaceRoot: AbsolutePath
      /** Workspace authority mode persisted to the manifest. Defaults to `shared`. */
      readonly authorityMode: AuthorityMode
      readonly dryRun?: boolean
      readonly limit?: number
    }
  | {
      readonly _tag: 'export'
      readonly outputPath: AbsolutePath
      readonly workspaceRoot?: AbsolutePath
      /**
       * `--refresh` re-observes the established binding through
       * remote-observation/project-only work before exporting (CLI-R02). Export
       * does not accept a remote id or database URL: it operates on the existing
       * data file only; `track` is the adoption verb. Refresh requires an
       * already-bound store.
       */
      readonly refresh?: boolean
      readonly format: ReplicaExportFormat
      readonly requireClean?: boolean
      /**
       * Dry-run suppresses the export output-file write (CLI-R02): the export
       * plan and counts are still computed from real reads, but no file is
       * written. With `--refresh`, the remote re-observation and projection
       * writes are likewise suppressed (the plan is reported, nothing persists).
       */
      readonly dryRun?: boolean
    }
  | { readonly _tag: 'status'; readonly workspaceRoot?: AbsolutePath }
  | { readonly _tag: 'conflicts-list' }
  | {
      readonly _tag: 'conflicts-resolve'
      readonly conflictId: SyncEventId
      readonly choice: ConflictResolutionChoice
      readonly dryRun?: boolean
    }
  | {
      readonly _tag: 'forget'
      readonly pageId: PageId
      readonly dryRun?: boolean
    }
  | {
      readonly _tag: 'restore'
      readonly pageId: PageId
      readonly dryRun?: boolean
    }
  | { readonly _tag: 'doctor' }

/**
 * Resolved runtime context shared across all CLI command handlers.
 *
 * Produced by `parseCliContext` from `argv`; holds the open sync store, root / data-source IDs,
 * workspace root, query contract, schema properties, and optional tuning knobs.
 */
export type CliContext = {
  readonly store: NotionSyncStore
  /**
   * Path to the control-plane sync store. For a tracked workspace this is the
   * hidden `.notion/v1/state.sqlite`; for a standalone `--sqlite <file>` it is
   * that single file (which then also holds the public projection — unified).
   */
  readonly storePath?: string
  /**
   * Path to the public projection / CDC data file (`data/v1/<source>.sqlite`).
   * Equal to `storePath` in the standalone `--sqlite` case (unified projection),
   * distinct from it for a tracked workspace (control-plane file split, decision 0020).
   */
  readonly replicaPath?: string
  readonly rootId: SyncRootIdType
  readonly dataSourceId: DataSourceId
  readonly workspaceRoot: AbsolutePath
  /**
   * Workspace-wide authority mode read from `notion.workspace.v1.json` for a
   * tracked workspace (decisions 0015, 0019). Threads into the planner's
   * per-property `writeMode`: `remote` makes local edits drift, `local`/`shared`
   * reach the property-write proof. Absent for a standalone `--sqlite` file or an
   * untracked establish run; the planner then keeps its `shared` default.
   */
  readonly authorityMode?: AuthorityMode
  /**
   * Workspace-relative page directory for the tracked source (`pages/v1/<name>`),
   * from the manifest. Materialized `.nmd` page files land under here so a tracked
   * source's Markdown surface lives at `pages/v1/<name>/...` (one page directory
   * per source). Absent for a standalone `--sqlite` file, which keeps the legacy
   * workspace-root body path.
   */
  readonly sourcePagesDir?: string
  readonly queryContract: QueryContract
  readonly schemaProperties?: ReadonlyArray<SchemaPropertyObservation>
  readonly requiredCapabilities?: ReadonlyArray<CapabilityName>
  readonly materializeBodies?: boolean
  readonly rowLimit?: number
  readonly maxExecutorSteps?: number
  readonly leaseToken?: string
  readonly leaseDurationMs?: number
  readonly now?: () => Date
  readonly tailscaleProcessRunner?: TailscaleProcessRunner
  readonly webhookReceiverHostname?: string
  readonly webhookReceiverPort?: number
  readonly webhookReceiverPath?: string
  readonly webhookReceiverStarted?: (status: NotionWebhookReceiverStatus) => void
  readonly pendingManifestSource?: EstablishManifestSource
}

type EstablishManifestSource = {
  readonly workspaceRoot: AbsolutePath
  readonly name: string
  readonly dataSourceId: DataSourceId
  readonly databaseId: string
  readonly authorityMode?: AuthorityMode
}

const identityKeyOf = (identity: LocalIdentity): string => {
  switch (identity.kind) {
    case 'property':
      return `property ${identity.pageId} ${identity.propertyId}`
    case 'body':
      return `body ${identity.pageId}`
  }
}

const intentIdentityKey = (intent: PlannerIntent): string | undefined => {
  switch (intent._tag) {
    case 'property-edit':
      return `property ${intent.pageId} ${intent.propertyId}`
    case 'body-edit':
      return `body ${intent.pageId}`
    default:
      return undefined
  }
}

/**
 * SM5c shared-mode local convergence (R06). Reconciles the SQLite `pages`
 * property edits against the page's `.nmd` frontmatter BEFORE remote planning:
 *
 * - agreeing surfaces coalesce to the single existing SQLite intent (the `.nmd`
 *   side carries no intent, so no double-apply) and a `converged` verdict that
 *   leaves the write unblocked;
 * - diverging surfaces produce a `disagrees` verdict (returned here and threaded
 *   into `pushOneShotSync` as `convergenceVerdicts`, where `applyConvergenceVerdicts`
 *   overlays it onto `PropertySurfaceSnapshot.localConvergence` so the planner
 *   blocks the property write through the shared proof core as
 *   `LocalSurfaceDisagreement`) AND a `ConflictRaised` event in the read-only
 *   `conflicts` view.
 *
 * PROPERTY identities are blocked by that planner guard, so their intents are NOT
 * pre-filtered here — pre-filtering would remove them before planning and the
 * guard would never fire (the block would silently degrade to a side-channel
 * intent drop, masked behind `attemptedPatchPageProperties === 0`).
 *
 * Scope: only the PROPERTY surface is observed today. BODY identities have no
 * `localConvergence` proof field, so the engine cannot block them through the
 * planner; their only block path is the intent-filter retained below. Body facts
 * are also not yet produced by `buildPropertyConvergenceInputs`, so body
 * convergence is engine-ready but NOT production-observed — a follow-up (body
 * materialization is entangled with sidecar identity). Page lifecycle
 * (archive/restore) is NOT a convergence identity: it reaches the planner through
 * the CDC `row_archive`/`row_restore` intents, never this engine.
 *
 * ACTIVE on production data (SM5d): a datasource pull materializes the writable
 * frontmatter properties into the pulled `.nmd` (see `observation.ts`
 * `writableFrontmatterProperties` + `materializeBody`), so `nmdPropertyFacts` reads
 * a real property surface and this path converges actual pulled pages, not just
 * hand-authored `.nmd`.
 *
 * Runs in `shared` mode ONLY; `local`/`remote` return the intents unchanged with
 * no verdicts (single-source mirror, `not-applicable`).
 */
const runLocalConvergenceForPush = ({
  context,
  changes,
  replicaPath,
  intents,
  dryRun,
}: {
  readonly context: CliContext
  readonly changes: readonly { readonly kind: string }[]
  readonly replicaPath: string
  readonly intents: ReadonlyArray<PlannerIntent>
  readonly dryRun?: boolean
}): {
  readonly verdicts: ReadonlyArray<PropertyConvergenceVerdict>
  readonly intents: ReadonlyArray<PlannerIntent>
} => {
  if (
    context.authorityMode !== 'shared' ||
    context.sourcePagesDir === undefined ||
    replicaPath === ':memory:'
  ) {
    return { verdicts: [], intents }
  }

  const bases = readReplicaCellBases(replicaPath)
  const { dataFileEdits, nmdFacts } = buildPropertyConvergenceInputs({
    workspaceRoot: context.workspaceRoot,
    pagesDir: context.sourcePagesDir,
    changes: changes as never,
    bases,
  })
  if (dataFileEdits.length === 0 && nmdFacts.length === 0) {
    return { verdicts: [], intents }
  }

  const result = convergeLocalSurfaces({ authorityMode: 'shared', dataFileEdits, nmdFacts })
  if (result._tag !== 'shared') return { verdicts: [], intents }

  // Raise each local PROPERTY conflict into the read-only `conflicts` view via the
  // normal ConflictRaised rail (decision 0005 — never a page-adjacent file). Only
  // PROPERTY conflicts flow here: body is single-surface and adapter-owned
  // (decision 0021), so the convergence engine is never fed a body fact and never
  // produces a body conflict on this path.
  if (dryRun !== true) {
    for (const outcome of result.outcomes) {
      if (outcome._tag !== 'local-conflict' || outcome.identity.kind !== 'property') continue
      const { conflict, identity } = outcome
      context.store.appendEventWithResult(
        makeConflictRaisedEvent({
          rootId: context.rootId,
          pageId: identity.pageId,
          propertyId: identity.propertyId,
          surface: conflict.localSurface,
          baseHash: conflict.baseHash ?? conflict.localHash ?? conflict.remoteHash!,
          localHash: conflict.localHash ?? conflict.remoteHash!,
          remoteHash: conflict.remoteHash ?? conflict.localHash!,
          conflictKind: 'property',
          message: conflict.message,
        }),
      )
    }
  }

  // Diverged PROPERTY identities are blocked by the planner itself: the
  // `disagrees` verdict overlays `PropertySurfaceSnapshot.localConvergence`
  // (via `convergenceVerdicts → applyConvergenceVerdicts`), so the shared proof
  // core blocks the write as `LocalSurfaceDisagreement`. We must NOT pre-filter
  // those intents here — doing so removes them before planning, so the guard
  // never fires and the block silently degrades to a side-channel intent drop.
  //
  // BODY identities carry no `localConvergence` proof field, so the verdict
  // cannot block them through the planner. For those the intent drop is the only
  // block, so we keep filtering them (they are not yet wired through the planner
  // — see the body convergence follow-up).
  const blocked = new Set(
    result.blockedIdentities.filter((identity) => identity.kind !== 'property').map(identityKeyOf),
  )
  const filtered = intents.filter((intent) => {
    const key = intentIdentityKey(intent)
    return key === undefined || blocked.has(key) === false
  })

  return { verdicts: result.propertyVerdicts, intents: filtered }
}

/** Environment variables read by `makeCliRuntimeLayer` to obtain the Notion API token. */
export type CliRuntimeEnv = {
  readonly NOTION_API_TOKEN?: string
  readonly NOTION_TOKEN?: string
}

/**
 * Dependency injection overrides for the CLI runtime layer.
 *
 * Allows callers (library consumers, tests) to substitute custom gateway, body-sync,
 * or workspace implementations instead of the default live/filesystem adapters.
 */
export type CliRuntimeOptions = {
  readonly env?: CliRuntimeEnv
  readonly gateway?: NotionDataSourceGatewayShape
  readonly gatewayClient?: NotionGatewayClient
  readonly body?: PageBodySyncPortShape
  readonly workspace?: LocalWorkspacePortShape
}

const normalizeAbsolutePath = (value: string): AbsolutePath =>
  decode({ schema: AbsolutePath, value: isAbsolute(value) === true ? value : resolve(value) })

const defaultSqlitePath = ({
  workspaceRoot,
  databaseId,
}: {
  readonly workspaceRoot: AbsolutePath
  readonly databaseId: string
}): AbsolutePath =>
  decode({
    schema: AbsolutePath,
    value: dataFilePath({ workspaceRoot, name: databaseId }),
  })

/**
 * Resolves the public projection / CDC data file. For a tracked workspace this
 * is the data file (distinct from the control-plane store); for a standalone
 * `--sqlite` file it falls back to the store path (unified). decision 0020.
 */
const replicaPathForContext = (context: CliContext): string | undefined =>
  context.replicaPath ?? context.storePath

const projectReplicaIfWritable = ({
  context,
  dryRun,
}: {
  readonly context: CliContext
  readonly dryRun?: boolean
}): void => {
  if (dryRun === true || context.storePath === undefined || context.storePath === ':memory:') return
  const replicaPath = replicaPathForContext(context)
  if (replicaPath === undefined || replicaPath === ':memory:') return
  projectReplicaFromSyncStore({
    syncStorePath: context.storePath,
    replicaPath,
    rootId: context.rootId,
  })
}

const statusWithReplicaPending = ({
  context,
  status,
}: {
  readonly context: CliContext
  readonly status: OneShotSyncStatus
}): OneShotSyncStatus => {
  const replicaPath = replicaPathForContext(context)
  if (
    replicaPath === undefined ||
    replicaPath === ':memory:' ||
    existsSync(replicaPath) === false
  ) {
    return status
  }

  const db = new DatabaseSync(replicaPath, { readOnly: true })
  try {
    const row = db
      .prepare(
        `SELECT pending_local_changes, conflicts_open
         FROM sync_status
         LIMIT 1`,
      )
      .get() as
      | {
          readonly pending_local_changes: number | bigint
          readonly conflicts_open: number | bigint
        }
      | undefined
    if (row === undefined) return status

    const pending = status.counts.pending + Number(row.pending_local_changes)
    const conflict = status.counts.conflict + Number(row.conflicts_open)
    const state: OneShotSyncStatus['state'] =
      conflict > 0
        ? 'conflict'
        : status.counts.blocked > 0
          ? 'blocked'
          : pending > 0
            ? 'pending'
            : 'clean'

    return {
      ...status,
      state,
      counts: {
        ...status.counts,
        clean: state === 'clean' ? 1 : 0,
        pending,
        conflict,
      },
    }
  } finally {
    db.close()
  }
}

const rootIdForDataSource = (dataSourceId: DataSourceId): SyncRootIdType =>
  decode({ schema: SyncRootId, value: `data-source:${dataSourceId}` })

const fullReplicaQueryContract = (): QueryContract =>
  decode({
    schema: QueryContract,
    value: {
      _tag: 'QueryContract',
      apiVersion: NOTION_API_VERSION,
      filter: null,
      sorts: [],
      pageSize: 100,
      highWatermark: null,
      membershipScope: 'all-data-source-rows',
    },
  })

/** Tagged reference to a Notion entity used as the adoption source — either a Notion data source or a Notion database that owns one. */
export type NotionRemoteRef =
  | {
      readonly _tag: 'data-source'
      readonly dataSourceId: DataSourceId
      readonly sourceDatabaseId?: string
    }
  | { readonly _tag: 'database'; readonly databaseId: string }

const parseNotionDataSourceRef = (value: string): DataSourceId => {
  return decode({ schema: DataSourceId, value: parseNotionUuid(value) ?? value })
}

const notionUrlKind = (value: string): 'data-source' | 'database' | undefined => {
  if (/^https?:\/\//iu.test(value) === false) return undefined

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }

  const pathname = url.pathname.toLowerCase()
  const searchParams = new Set([...url.searchParams.keys()].map((key) => key.toLowerCase()))
  if (
    pathname.includes('/data_sources/') === true ||
    pathname.includes('/data-source/') === true ||
    pathname.includes('/datasources/') === true ||
    searchParams.has('data_source') === true ||
    searchParams.has('data_source_id') === true
  ) {
    return 'data-source'
  }
  if (
    pathname.includes('/databases/') === true ||
    url.hostname.toLowerCase().endsWith('notion.so') === true
  ) {
    return 'database'
  }
  return undefined
}

const parseNotionRemoteRef = (value: string): NotionRemoteRef => {
  const id = parseNotionDataSourceRef(value)
  if (notionUrlKind(value) === 'database') {
    return { _tag: 'database', databaseId: id }
  }
  return { _tag: 'data-source', dataSourceId: id }
}

/** Aggregated health check result from the `doctor` command: sync status, compaction decision, and user-action surface. */
export type DoctorResult = {
  readonly _tag: 'DoctorResult'
  readonly clean: boolean
  readonly status: OneShotSyncStatus
  readonly compaction: CompactionDecision
  readonly surface: UserActionSurface
}

/** Runtime webhook health reported by `sync --watch`. */
export type SyncWatchWebhookStatus =
  | {
      readonly _tag: 'WebhookDisabled'
      readonly provider: 'none'
      readonly signals: SignalInboxStatus
    }
  | {
      readonly _tag: 'WebhookManualStatus'
      readonly provider: 'manual'
      readonly state: 'running'
      readonly message: string
      readonly receiver: NotionWebhookReceiverStatus
      readonly exposure: WebhookRelayExposure
      readonly signals: SignalInboxStatus
    }
  | {
      readonly _tag: 'WebhookTailscaleStatus'
      readonly provider: 'tailscale'
      readonly state: 'running' | 'degraded'
      readonly message: string
      readonly receiver: NotionWebhookReceiverStatus
      readonly exposure?: WebhookRelayExposure
      readonly signals: SignalInboxStatus
    }

/** Result envelope returned after a bounded `sync --watch` daemon run. */
export type SyncWatchRunResult = {
  readonly _tag: 'SyncWatchRunResult'
  readonly webhook: SyncWatchWebhookStatus
  readonly daemon: WatchDaemonRunResult
}

type ActiveWatchWebhook = {
  readonly status: SyncWatchWebhookStatus
  readonly wakeNotifier: WatchDaemonWakeNotifier | undefined
  readonly close: () => Promise<void>
}

/**
 * Successful JSON output envelope written to `stdout` by every CLI command.
 *
 * Always carries the current sync `status` and `surface` so consumers can inspect
 * workspace health without a separate `status` call. `ok` is `true` iff the sync
 * state is `clean`.
 */
export type CliResultEnvelope<TResult = unknown> = {
  readonly _tag: 'CliResultEnvelope'
  readonly version: 'v1'
  readonly command: CliCommand['_tag']
  readonly ok: boolean
  readonly rootId: SyncRootIdType
  readonly status: OneShotSyncStatus
  readonly surface: UserActionSurface
  readonly result: TResult
}

/** Error JSON envelope written to `stderr` when a CLI command fails, carrying a `_tag` and `message`. */
export type CliErrorEnvelope = {
  readonly _tag: 'CliErrorEnvelope'
  readonly version: 'v1'
  readonly ok: false
  readonly error: {
    readonly _tag: string
    readonly message: string
  }
}

/** Thrown during argument parsing when a required flag is missing, invalid, or unsupported. */
export class CliArgumentError extends Schema.TaggedError<CliArgumentError>()('CliArgumentError', {
  message: Schema.String,
}) {}

/**
 * Narrow a thrown value from the synchronous CLI parsers into the typed
 * `CliArgumentError` channel. The parsers only ever `throw new CliArgumentError`;
 * any other thrown value is a programming defect, so we re-throw it and let
 * `Effect.try` surface it as a defect rather than an expected failure.
 */
const cliArgumentErrorFromThrow = (cause: unknown): CliArgumentError => {
  if (cause instanceof CliArgumentError) return cause
  throw cause
}

/**
 * Narrow a thrown value from `parseCliContext` into its typed failure channel.
 * Unlike the argument parsers, `parseCliContext` performs workspace discovery
 * (`discoverSelfContainedStore` → `requireCompatibleWorkspaceNamespace`) and so
 * legitimately throws `WorkspaceNotTracked` (untracked workspace) and
 * `WorkspaceNamespaceError` (mixed/unknown/inconsistent namespace) in addition
 * to `CliArgumentError`. These are all expected CLI failures that must reach the
 * top-level `renderCliErrorJson` envelope as failures, not defects. Any other
 * thrown value is a programming defect and is re-thrown for `Effect.try` to
 * surface as such.
 */
const cliContextErrorFromThrow = (
  cause: unknown,
): CliArgumentError | WorkspaceNotTracked | WorkspaceNamespaceError => {
  if (cause instanceof CliArgumentError) return cause
  if (cause instanceof WorkspaceNotTracked) return cause
  if (cause instanceof WorkspaceNamespaceError) return cause
  throw cause
}

const isWatchCommand = (command: CliCommand): boolean =>
  command._tag === 'sync' && command.watch === true

/** Returns the OTel service name for the given parsed command — `sync --watch` maps to the daemon service, all others to the CLI service. */
export const serviceNameForCliCommand = (command: CliCommand): string =>
  isWatchCommand(command) === true ? otelServiceNames.daemon : otelServiceNames.cli

const SchemaPropertyObservationJson = Schema.Struct({
  propertyId: PropertyId,
  name: Schema.optional(NonEmptyTrimmedString),
  type: Schema.optional(NonEmptyTrimmedString),
  configHash: Hash,
  writeClass: Schema.Literals(['writable', 'computed', 'unsupported']),
  configJson: Schema.optional(Schema.String),
}).annotate({ identifier: 'NotionDatasourceSync.Cli.SchemaPropertyObservationJson' })

const capabilityNames = new Set<CapabilityName>(allGatewayCapabilities)

const decode = <TSchema extends Schema.Codec<any, any, never>>({
  schema,
  value,
}: {
  readonly schema: TSchema
  readonly value: unknown
}): typeof schema.Type => Schema.decodeUnknownSync(schema)(value)

const decodeJson = <TSchema extends Schema.Codec<any, any, never>>({
  schema,
  value,
}: {
  readonly schema: TSchema
  readonly value: string
}): typeof schema.Type =>
  Schema.decodeUnknownSync(schema)(Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(value))

const withOptionalRuntimeOptions = (context: CliContext) => ({
  ...(context.maxExecutorSteps === undefined ? {} : { maxExecutorSteps: context.maxExecutorSteps }),
  ...(context.leaseToken === undefined ? {} : { leaseToken: context.leaseToken }),
  ...(context.leaseDurationMs === undefined ? {} : { leaseDurationMs: context.leaseDurationMs }),
})

const withOptionalCommandOptions = ({
  command,
  context,
}: {
  readonly command: { readonly dryRun?: boolean }
  readonly context: CliContext
}) => ({
  ...(command.dryRun === undefined ? {} : { dryRun: command.dryRun }),
  ...(context.now === undefined ? {} : { now: context.now }),
})

const withOptionalObservationLimit = (context: CliContext): { readonly rowLimit?: number } =>
  context.rowLimit === undefined ? {} : { rowLimit: context.rowLimit }

const writePendingManifestAfterEstablish = (context: CliContext): void => {
  if (context.pendingManifestSource !== undefined) {
    writeEstablishedWorkspaceManifest(context.pendingManifestSource)
  }
}

// Watch daemon state is hidden implementation state (R02): it always lives under
// the versioned `.notion/v1` namespace, never inside the public `data/v1` SQL
// surface dir alongside the data file.
const defaultWatchStatePath = (context: CliContext): string =>
  join(context.workspaceRoot, hiddenStateDirectoryName, 'watch.json')

const defaultWebhookReceiverPort = 39231
const defaultWebhookReceiverPathPrefix = '/notion-datasource-sync/webhook/notion'

const makeDefaultWebhookReceiverPath = (): string =>
  `${defaultWebhookReceiverPathPrefix}/${randomUUID()}`

// oxlint-disable-next-line overeng/named-args -- implements TailscaleProcessRunner callback shape.
const defaultTailscaleProcessRunner: TailscaleProcessRunner = (command, args) =>
  new Promise((resolveProcess) => {
    execFile(command, [...args], { timeout: 5_000 }, (error, stdout, stderr) => {
      if (error === null) {
        resolveProcess({ exitCode: 0, stdout, stderr })
        return
      }
      const maybeExitCode =
        typeof error === 'object' && 'code' in error && typeof error.code === 'number'
          ? error.code
          : 1
      resolveProcess({
        exitCode: maybeExitCode,
        stdout,
        stderr,
      })
    })
  })

const signalStatus = (context: CliContext): SignalInboxStatus =>
  context.store.readSignalStatus(context.rootId)

const closeWebhookResources = async ({
  receiver,
  providerStop,
}: {
  readonly receiver: NotionWebhookReceiverHandle | undefined
  readonly providerStop: (() => Promise<void>) | undefined
}) => {
  try {
    await providerStop?.()
  } finally {
    await receiver?.close()
  }
}

const setupWatchWebhook = ({
  command,
  context,
}: {
  readonly command: Extract<CliCommand, { readonly _tag: 'sync' }>
  readonly context: CliContext
}): Effect.Effect<ActiveWatchWebhook, CliArgumentError> => {
  const provider = command.webhook ?? 'none'
  if (provider === 'none') {
    if (command.webhookRequired === true) {
      return Effect.fail(
        new CliArgumentError({
          message:
            'sync --watch --webhook-required requires --webhook tailscale or --webhook manual',
        }),
      )
    }
    return Effect.succeed({
      status: {
        _tag: 'WebhookDisabled',
        provider: 'none',
        signals: signalStatus(context),
      },
      wakeNotifier: undefined,
      close: async () => {},
    })
  }

  return Effect.flatMap(Effect.context<never>(), (effectContext) =>
    Effect.tryPromise({
      try: async () => {
        const wakeNotifier = makeWatchDaemonWakeNotifier()
        const receiver = await startNotionWebhookReceiver({
          rootId: context.rootId,
          store: context.store,
          ...(context.webhookReceiverHostname === undefined
            ? {}
            : { hostname: context.webhookReceiverHostname }),
          port: context.webhookReceiverPort ?? defaultWebhookReceiverPort,
          path: context.webhookReceiverPath ?? makeDefaultWebhookReceiverPath(),
          onSignalEnqueued: () => wakeNotifier.wake(),
          effectContext,
        })
        context.webhookReceiverStarted?.(receiver)

        if (provider === 'manual') {
          const manual = makeManualWebhookRelayProvider({
            publicUrl: receiver.url,
            localTarget: `${receiver.hostname}:${receiver.port.toString()}`,
            path: receiver.path,
          })
          const exposure = await manual.start()
          return {
            status: {
              _tag: 'WebhookManualStatus',
              provider: 'manual',
              state: 'running',
              message:
                'Manual webhook receiver is running locally; configure an external relay to deliver Notion webhooks to the callback URL.',
              receiver,
              exposure,
              signals: signalStatus(context),
            },
            wakeNotifier,
            close: () => closeWebhookResources({ receiver, providerStop: manual.stop }),
          } satisfies ActiveWatchWebhook
        }

        const tailscale = makeTailscaleFunnelProvider({
          localPort: receiver.port,
          path: receiver.path,
          run: context.tailscaleProcessRunner ?? defaultTailscaleProcessRunner,
        })
        let shouldStopTailscale = false
        try {
          const exposure = await tailscale.start()
          shouldStopTailscale = true
          return {
            status: {
              _tag: 'WebhookTailscaleStatus',
              provider: 'tailscale',
              state: 'running',
              message:
                'Tailscale Funnel is exposing the local webhook receiver; webhook hints still require reconciliation before planning.',
              receiver,
              exposure,
              signals: signalStatus(context),
            },
            wakeNotifier,
            close: () =>
              closeWebhookResources({
                receiver,
                providerStop: shouldStopTailscale === true ? tailscale.stop : undefined,
              }),
          } satisfies ActiveWatchWebhook
        } catch (cause) {
          if (cause instanceof CliArgumentError) throw cause
          if (command.webhookRequired === true) {
            await closeWebhookResources({ receiver, providerStop: undefined })
            throw new CliArgumentError({
              message: 'sync --watch --webhook-required could not start Tailscale Funnel',
            })
          }
          return {
            status: {
              _tag: 'WebhookTailscaleStatus',
              provider: 'tailscale',
              state: 'degraded',
              message:
                'Local webhook receiver is running, but Tailscale Funnel could not be started; continuing with polling reconciliation.',
              receiver,
              signals: signalStatus(context),
            },
            wakeNotifier,
            close: () => closeWebhookResources({ receiver, providerStop: undefined }),
          } satisfies ActiveWatchWebhook
        }
      },
      catch: (cause) =>
        cause instanceof CliArgumentError
          ? cause
          : new CliArgumentError({
              message: 'Unable to initialize sync --watch webhook status',
            }),
    }),
  )
}

const envelope = <TResult>({
  command,
  context,
  result,
}: {
  readonly command: CliCommand['_tag']
  readonly context: CliContext
  readonly result: TResult
}): CliResultEnvelope<TResult> => {
  const status = readOneShotSyncStatus({ store: context.store, rootId: context.rootId })
  return {
    _tag: 'CliResultEnvelope',
    version: 'v1',
    command,
    ok: status.state === 'clean',
    rootId: context.rootId,
    status,
    surface: readUserActionSurface({ store: context.store, rootId: context.rootId }),
    result,
  }
}

type CliCommandRuntimeResult = CliResultEnvelope<
  | OneShotSyncStatus
  | EstablishFromNotionResult
  | OneShotPullResult
  | OneShotPushResult
  | OneShotSyncResult
  | WatchDaemonRunResult
  | SyncWatchRunResult
  | UserCommandResultEnvelope
  | ReplicaExportResult
  | DoctorResult
>

type CliCommandRuntimeError =
  | LocalStoreError
  | NotionGatewayError
  | BodySyncError
  | LocalStorageError
  | ReplicaExportError
  | CliArgumentError

const runCliCommandEffect = ({
  command,
  context,
}: {
  readonly command: CliCommand
  readonly context: CliContext
}): Effect.Effect<
  CliCommandRuntimeResult,
  CliCommandRuntimeError,
  NotionDataSourceGateway | PageBodySyncPort | LocalWorkspacePort
> => {
  switch (command._tag) {
    case 'init':
      return Effect.sync(() =>
        envelope({
          command: command._tag,
          context,
          result: initOneShotSync({
            store: context.store,
            rootId: context.rootId,
            dataSourceId: command.dataSourceId,
            workspaceRoot: command.workspaceRoot,
            ...withOptionalCommandOptions({ command, context }),
          }),
        }),
      ).pipe(
        withSpan({
          span: 'syncInit',
          attributes: {
            [spanAttr.spanLabel]: spanLabel('init', shortSpanId(context.rootId)),
            [spanAttr.processRole]: processRoleForCliCommand(command._tag),
            [spanAttr.operation]: 'init',
            [spanAttr.rootId]: context.rootId,
            [spanAttr.dataSourceId]: command.dataSourceId,
            [spanAttr.dryRun]: command.dryRun === true,
          },
        }),
      )
    case 'pull':
      return pullOneShotSync({
        ...context,
        ...remoteObservationContext(context),
        ...withOptionalObservationLimit(context),
      }).pipe(
        Effect.tap(() => Effect.sync(() => projectReplicaIfWritable({ context }))),
        Effect.map((result) => envelope({ command: command._tag, context, result })),
      )
    // `track` is the canonical adoption verb; `sync-from-notion` is its legacy
    // alias. Both route through the same establish machinery. The authority mode
    // for `track` is persisted by `parseCliContext` into the manifest.
    case 'track':
    case 'sync-from-notion':
      return establishFromNotion({
        ...context,
        ...remoteObservationContext(context),
        ...withOptionalObservationLimit(context),
        dataSourceId: command.dataSourceId,
        workspaceRoot: command.workspaceRoot,
        ...withOptionalCommandOptions({ command, context }),
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (command.dryRun === true) return
            projectReplicaIfWritable({
              context,
              ...(command.dryRun === undefined ? {} : { dryRun: command.dryRun }),
            })
          }),
        ),
        Effect.tap(() => Effect.sync(() => writePendingManifestAfterEstablish(context))),
        Effect.map((result) => envelope({ command: command._tag, context, result })),
      )
    case 'push':
      return Effect.sync(() => {
        // CDC + planning intents target the public data file; the event log is
        // appended through `context.store` (control-plane state.sqlite). decision 0020.
        const replicaPath = replicaPathForContext(context)
        if (replicaPath === undefined)
          return {
            changes: [] as const,
            intents: [] as const,
            verdicts: [] as ReadonlyArray<PropertyConvergenceVerdict>,
            replicaPath: ':memory:',
          }
        if (existsSync(replicaPath) === false)
          return {
            changes: [] as const,
            intents: [] as const,
            verdicts: [] as ReadonlyArray<PropertyConvergenceVerdict>,
            replicaPath,
          }
        const changes = readPendingReplicaChanges(replicaPath)
        applyReplicaConflictResolutions({
          changes,
          replicaPath,
          store: context.store,
          rootId: context.rootId,
          ...(context.authorityMode === undefined ? {} : { authorityMode: context.authorityMode }),
          ...(command.dryRun === undefined ? {} : { dryRun: command.dryRun }),
        })
        const plannedIntents = replicaChangesToPlannerIntents({
          changes: changes.filter((change) => change.kind !== 'conflict_resolution'),
          replicaPath,
          ...(command.dryRun === undefined ? {} : { dryRun: command.dryRun }),
        })
        const converged = runLocalConvergenceForPush({
          context,
          changes,
          replicaPath,
          intents: plannedIntents,
          ...(command.dryRun === undefined ? {} : { dryRun: command.dryRun }),
        })
        return {
          changes,
          intents: converged.intents,
          verdicts: converged.verdicts,
          replicaPath,
        }
      }).pipe(
        Effect.flatMap(({ changes, intents, verdicts, replicaPath }) =>
          pushOneShotSync({
            ...context,
            ...withOptionalRuntimeOptions(context),
            ...withOptionalCommandOptions({ command, context }),
            localIntents: intents,
            ...(verdicts.length === 0 ? {} : { convergenceVerdicts: verdicts }),
          }).pipe(
            Effect.tap((result) =>
              Effect.sync(() =>
                settleReplicaChangesAfterSync({
                  changes,
                  replicaPath,
                  store: context.store,
                  rootId: context.rootId,
                  decisions: result.plan.decisions,
                  ...(command.dryRun === undefined ? {} : { dryRun: command.dryRun }),
                }),
              ),
            ),
          ),
        ),
        Effect.tap(() =>
          Effect.sync(() =>
            projectReplicaIfWritable({
              context,
              ...(command.dryRun === undefined ? {} : { dryRun: command.dryRun }),
            }),
          ),
        ),
        Effect.map((result) => envelope({ command: command._tag, context, result })),
      )
    case 'sync':
      if (command.watch === true) {
        // SM5.3 (CLI-R02): `sync --watch --dry-run` runs the daemon as an
        // observe/plan/report loop. The `dryRun` flag is threaded into
        // `runWatchDaemon`, which gates every loop-level durable effect (signal
        // claim/settle/release, daemon state file, replica settle/project, CDC
        // writes) and the inner pass (executor gate + materializeBodies:false),
        // so a dry-run observer never fences a real running daemon's signals or
        // mutates any surface.
        return setupWatchWebhook({ command, context }).pipe(
          Effect.flatMap((webhook) =>
            runWatchDaemon({
              ...context,
              ...remoteObservationContext(context),
              ...withOptionalObservationLimit(context),
              statePath: command.statePath ?? defaultWatchStatePath(context),
              ...(command.maxCycles === undefined ? {} : { maxCycles: command.maxCycles }),
              ...(command.watchPriority === undefined ? {} : { mode: command.watchPriority }),
              ...(webhook.wakeNotifier === undefined ? {} : { wakeNotifier: webhook.wakeNotifier }),
              ...(command.dryRun === undefined ? {} : { dryRun: command.dryRun }),
              ...withOptionalRuntimeOptions(context),
            }).pipe(
              Effect.map((daemon) =>
                envelope({
                  command: command._tag,
                  context,
                  result:
                    command.webhook === undefined || command.webhook === 'none'
                      ? daemon
                      : ({
                          _tag: 'SyncWatchRunResult',
                          webhook: webhook.status,
                          daemon,
                        } satisfies SyncWatchRunResult),
                }),
              ),
              Effect.ensuring(
                Effect.tryPromise({
                  try: webhook.close,
                  catch: (cause) =>
                    new CliArgumentError({
                      message: `Unable to stop sync --watch webhook resources: ${String(cause)}`,
                    }),
                }).pipe(Effect.ignore),
              ),
            ),
          ),
        )
      }
      if (command.workspaceRoot !== undefined) {
        const binding = readOneShotSyncStatus({
          store: context.store,
          rootId: context.rootId,
        }).binding
        if (binding === undefined) {
          return Effect.fail(
            new CliArgumentError({
              message: `Workspace ${command.workspaceRoot} has no recorded binding; establish it with track <id-or-url> <workspace-root> before running sync <workspace-root>`,
            }),
          )
        }
        if (
          binding.dataSourceId !== context.dataSourceId ||
          binding.workspaceRoot !== context.workspaceRoot
        ) {
          return Effect.fail(
            new CliArgumentError({
              message: `Workspace config/store binding mismatch for ${command.workspaceRoot}; refusing to sync`,
            }),
          )
        }
      }
      return Effect.sync(() => {
        // CDC + planning intents target the public data file; the event log is
        // appended through `context.store` (control-plane state.sqlite). decision 0020.
        const replicaPath = replicaPathForContext(context)
        if (replicaPath === undefined)
          return { changes: [] as const, intents: [] as const, replicaPath: ':memory:' }
        if (existsSync(replicaPath) === false)
          return { changes: [] as const, intents: [] as const, replicaPath }
        const changes = readPendingReplicaChanges(replicaPath)
        applyReplicaConflictResolutions({
          changes,
          replicaPath,
          store: context.store,
          rootId: context.rootId,
          ...(context.authorityMode === undefined ? {} : { authorityMode: context.authorityMode }),
          ...(command.dryRun === undefined ? {} : { dryRun: command.dryRun }),
        })
        const intents = replicaChangesToPlannerIntents({
          changes: changes.filter((change) => change.kind !== 'conflict_resolution'),
          replicaPath,
          ...(command.dryRun === undefined ? {} : { dryRun: command.dryRun }),
        })
        return { changes, intents, replicaPath }
      }).pipe(
        Effect.flatMap(({ changes, intents, replicaPath }) =>
          syncOneShot({
            ...context,
            ...remoteObservationContext(context),
            ...withOptionalObservationLimit(context),
            ...withOptionalRuntimeOptions(context),
            ...withOptionalCommandOptions({ command, context }),
            localIntents: intents,
          }).pipe(
            Effect.tap((result) =>
              Effect.sync(() =>
                settleReplicaChangesAfterSync({
                  changes,
                  replicaPath,
                  store: context.store,
                  rootId: context.rootId,
                  decisions: result.push.plan.decisions,
                  ...(command.dryRun === undefined ? {} : { dryRun: command.dryRun }),
                }),
              ),
            ),
          ),
        ),
        Effect.tap(() =>
          Effect.sync(() =>
            projectReplicaIfWritable({
              context,
              ...(command.dryRun === undefined ? {} : { dryRun: command.dryRun }),
            }),
          ),
        ),
        Effect.map((result) => envelope({ command: command._tag, context, result })),
      )
    case 'export': {
      // `--refresh` re-observes the established binding only (no establish, no
      // remote ref): export operates on the existing data file (CLI-R02). Under
      // `--dry-run`, the re-observation and projection are suppressed so the
      // refresh/export plan is reported without persisting anything.
      const refresh =
        command.refresh !== true
          ? Effect.void
          : pullOneShotSync({
              ...context,
              ...remoteObservationContext(context),
              ...withOptionalObservationLimit(context),
              ...(command.dryRun === undefined ? {} : { dryRun: command.dryRun }),
            }).pipe(Effect.asVoid)

      return refresh.pipe(
        Effect.tap(() =>
          Effect.sync(() =>
            projectReplicaIfWritable({
              context,
              ...(command.dryRun === undefined ? {} : { dryRun: command.dryRun }),
            }),
          ),
        ),
        Effect.flatMap(() =>
          Effect.try({
            try: () => {
              // Export reads the public projection surface from the data file.
              const replicaPath = replicaPathForContext(context)
              if (replicaPath === undefined || replicaPath === ':memory:') {
                throw new ReplicaExportError('export requires a file-backed SQLite replica')
              }
              return exportReplica({
                replicaPath,
                outputPath: command.outputPath,
                format: command.format,
                ...(command.requireClean === undefined
                  ? {}
                  : { requireClean: command.requireClean }),
                ...(command.dryRun === undefined ? {} : { dryRun: command.dryRun }),
              })
            },
            catch: (cause) =>
              cause instanceof ReplicaExportError ? cause : new ReplicaExportError(String(cause)),
          }),
        ),
        Effect.map((result) => envelope({ command: command._tag, context, result })),
      )
    }
    case 'status':
      if (command.workspaceRoot !== undefined) {
        const binding = readOneShotSyncStatus({
          store: context.store,
          rootId: context.rootId,
        }).binding
        if (
          binding !== undefined &&
          (binding.dataSourceId !== context.dataSourceId ||
            binding.workspaceRoot !== context.workspaceRoot)
        ) {
          return Effect.fail(
            new CliArgumentError({
              message: `Workspace config/store binding mismatch for ${command.workspaceRoot}; refusing to read status`,
            }),
          )
        }
      }
      return Effect.sync(() =>
        envelope({
          command: command._tag,
          context,
          result: statusWithReplicaPending({
            context,
            status: readOneShotSyncStatus({ store: context.store, rootId: context.rootId }),
          }),
        }),
      )
    case 'conflicts-list':
      return Effect.sync(() =>
        envelope({
          command: command._tag,
          context,
          result: listUserCommandSurface({ store: context.store, rootId: context.rootId }),
        }),
      )
    case 'conflicts-resolve':
      return Effect.sync(() => {
        const result = resolveConflictCommand({
          store: context.store,
          rootId: context.rootId,
          conflictId: command.conflictId,
          choice: command.choice,
          // Authority mode must reach the conflict-resolution planner: a
          // `keep-local`/`manual` resolution in a `remote`-mode workspace is
          // refused as `RemoteAuthoritativeDrift` (decisions 0014, 0019).
          ...(context.authorityMode === undefined ? {} : { authorityMode: context.authorityMode }),
          ...withOptionalCommandOptions({ command, context }),
        })
        // Reproject the public data file so a lifecycle `keep-remote` resolution
        // (decision 0026) — which reconverges `_nds_row.in_trash` in the apply
        // path — is immediately reflected in the public `pages._in_trash`,
        // instead of remaining stale until the next sync.
        projectReplicaIfWritable({
          context,
          ...(command.dryRun === undefined ? {} : { dryRun: command.dryRun }),
        })
        return envelope({ command: command._tag, context, result })
      })
    case 'forget':
      return Effect.sync(() =>
        envelope({
          command: command._tag,
          context,
          result: forgetPageCommand({
            store: context.store,
            rootId: context.rootId,
            pageId: command.pageId,
            ...withOptionalCommandOptions({ command, context }),
          }),
        }),
      )
    case 'restore':
      return Effect.sync(() =>
        envelope({
          command: command._tag,
          context,
          result: restorePageCommand({
            store: context.store,
            rootId: context.rootId,
            pageId: command.pageId,
            ...withOptionalCommandOptions({ command, context }),
          }),
        }),
      )
    case 'doctor':
      return Effect.sync(() => {
        const status = readOneShotSyncStatus({ store: context.store, rootId: context.rootId })
        const compaction = context.store.getCompactionDecision(context.rootId)
        const surface = readUserActionSurface({ store: context.store, rootId: context.rootId })
        const result: DoctorResult = {
          _tag: 'DoctorResult',
          clean:
            status.state === 'clean' &&
            compaction._tag === 'allowed' &&
            surface.conflicts.length === 0 &&
            surface.guards.length === 0 &&
            surface.tombstones.length === 0 &&
            surface.outbox.length === 0,
          status,
          compaction,
          surface,
        }
        return envelope({ command: command._tag, context, result })
      })
  }
}

/**
 * Runs a parsed `CliCommand` against the provided context under the `notion_datasource.cli` span.
 *
 * Annotates the span with correlation attributes, command identity, and final status before returning
 * a `CliResultEnvelope`. Requires `NotionDataSourceGateway`, `PageBodySyncPort`, and `LocalWorkspacePort`
 * in the Effect context.
 */
export const runCliCommand = Effect.fn(spanNames.cliCommand, {
  attributes: spanAttributes({
    [spanAttr.spanLabel]: 'command',
    [spanAttr.processRole]: 'cli',
  }),
})(
  (
    command: CliCommand,
    context: CliContext,
  ): Effect.Effect<
    CliCommandRuntimeResult,
    CliCommandRuntimeError,
    NotionDataSourceGateway | PageBodySyncPort | LocalWorkspacePort
  > =>
    Effect.gen(function* () {
      yield* annotateSpan({
        ...otelCorrelationSpanAttributes({
          agentRunId: process.env.OTEL_AGENT_RUN_ID,
          resourceAttributes: process.env.OTEL_RESOURCE_ATTRIBUTES,
        }),
        [spanAttr.spanLabel]: spanLabel(command._tag),
        [spanAttr.command]: command._tag,
        [spanAttr.processRole]: processRoleForCliCommand(command._tag, {
          watch: isWatchCommand(command),
        }),
        [spanAttr.rootId]: context.rootId,
        [spanAttr.dataSourceId]: context.dataSourceId,
        [spanAttr.dryRun]: 'dryRun' in command ? command.dryRun === true : undefined,
        [spanAttr.maxCycles]:
          command._tag === 'sync' && command.watch === true ? command.maxCycles : undefined,
      })
      const result = yield* runCliCommandEffect({ command, context })
      yield* annotateSpan({
        ...statusSpanAttributes(result.status),
        [spanAttr.result]: result.ok === true ? 'ok' : result.status.state,
      })
      return result
    }),
)

// JSON.stringify replacer must be (key, value) — fixed external API.
// oxlint-disable-next-line overeng/named-args
const cliJsonReplacer = (_key: string, value: unknown): unknown =>
  typeof value === 'bigint' ? value.toString() : value

/** Serialize a `CliResultEnvelope` to a pretty-printed JSON string with a trailing newline for stdout — BigInt values are stringified for JSON safety. */
export const renderCliResultJson = (result: CliResultEnvelope): string =>
  `${JSON.stringify(result, cliJsonReplacer, 2)}\n`

/** Serializes any thrown error into a `CliErrorEnvelope` JSON string with a trailing newline for stderr. */
export const renderCliErrorJson = (error: unknown): string => {
  const errorEnvelope: CliErrorEnvelope = {
    _tag: 'CliErrorEnvelope',
    version: 'v1',
    ok: false,
    error: {
      _tag:
        typeof error === 'object' &&
        error !== null &&
        '_tag' in error &&
        typeof error._tag === 'string'
          ? error._tag
          : error instanceof Error
            ? error.name
            : 'CliError',
      message:
        typeof error === 'object' &&
        error !== null &&
        'message' in error &&
        typeof error.message === 'string'
          ? error.message
          : String(error),
    },
  }
  return `${JSON.stringify(errorEnvelope, cliJsonReplacer, 2)}\n`
}

/** Render the top-level help text for the Node-backed `notion db` command surface. */
export const renderCliHelpText = (): string => `notion db

Notion database replica sync.

Supported runtime:
  notion db ...            Packaged Node-backed entrypoint from Nix/devenv

Commands:
  track                   Adopt a Notion data source into a workspace (the adoption verb)
  sync                    Reconcile an established workspace, or run the watch daemon with --watch
  export                  Export rows, schema, and sync metadata from SQLite
  status                  Print workspace sync status
  conflicts list          List unresolved conflicts
  conflicts resolve       Resolve a conflict
  forget                  Archive/forget a page locally
  restore                 Restore a forgotten page locally
  doctor                  Print diagnostics

Common options:
  --sqlite <path>         SQLite store path
  --root-id <id>          Sync root id
  --data-source-id <id>   Notion data source id
  --workspace-root <dir>  Local workspace root
  --output <path>         Export output path for export
  --dry-run               Validate without mutating local or remote state
  --help                  Show this help
  --version               Show build/version identity

Unsupported source/Bun execution is expected to fail closed. Use the packaged
Node-backed notion db path for replica workflows.
`

const isHelpArgv = (argv: ReadonlyArray<string>): boolean =>
  argv.length === 0 || argv.includes('--help') || argv.includes('-h')

const isVersionArgv = (argv: ReadonlyArray<string>): boolean =>
  argv.length === 1 && argv[0] === '--version'

const completionShells = new Set<CompletionShell>(['bash', 'fish', 'sh', 'zsh'])

const parseCompletionShell = (value: string | undefined): CompletionShell | undefined => {
  if (value === undefined) return undefined
  return completionShells.has(value as CompletionShell) === true
    ? (value as CompletionShell)
    : undefined
}

const completionShellFromArgv = (argv: ReadonlyArray<string>): CompletionShell | undefined => {
  const [first, second] = argv
  if (first === '--completions') return parseCompletionShell(second)
  if (first === 'completion') return parseCompletionShell(second)
  return undefined
}

const booleanFlags = new Set([
  'dry-run',
  'help',
  'no-materialize-bodies',
  'non-interactive',
  'require-clean',
  'watch',
  'webhook-required',
])

const parseFlags = (argv: ReadonlyArray<string>): Map<string, string | true> => {
  const flags = new Map<string, string | true>()
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (item?.startsWith('--') !== true) continue
    const key = item.slice(2)
    if (flags.has(key) === true) {
      throw new CliArgumentError({ message: `Repeated --${key} is not supported` })
    }
    const next = argv[index + 1]
    if (booleanFlags.has(key) === false && next !== undefined && next.startsWith('--') === false) {
      flags.set(key, next)
      index += 1
    } else {
      flags.set(key, true)
    }
  }
  return flags
}

const parsePositionals = (argv: ReadonlyArray<string>): ReadonlyArray<string> => {
  const positionals: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (item?.startsWith('--') === true) {
      const next = argv[index + 1]
      if (
        booleanFlags.has(item.slice(2)) === false &&
        next !== undefined &&
        next.startsWith('--') === false
      )
        index += 1
      continue
    }
    if (item !== undefined) positionals.push(item)
  }
  return positionals
}

const requiredFlag = ({
  flags,
  name,
}: {
  readonly flags: Map<string, string | true>
  readonly name: string
}): string => {
  const value = flags.get(name)
  if (typeof value === 'string' && value.length > 0) return value
  throw new CliArgumentError({ message: `Missing required --${name}` })
}

const optionalFlag = ({
  flags,
  name,
}: {
  readonly flags: Map<string, string | true>
  readonly name: string
}): string | undefined => {
  const value = flags.get(name)
  return typeof value === 'string' ? value : undefined
}

const positiveIntegerFlag = ({
  flags,
  name,
}: {
  readonly flags: Map<string, string | true>
  readonly name: string
}): number | undefined => {
  const value = flags.get(name)
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new CliArgumentError({ message: `Missing value for --${name}` })
  }

  if (/^[1-9][0-9]*$/.test(value) === false) {
    throw new CliArgumentError({
      message: `--${name} must be a positive integer`,
    })
  }

  const parsed = Number(value)
  if (Number.isSafeInteger(parsed) === true && parsed > 0) return parsed

  throw new CliArgumentError({
    message: `--${name} must be a positive integer`,
  })
}

const watchPriorityFlag = (flags: Map<string, string | true>): WatchDaemonMode | undefined => {
  const priority = optionalFlag({ flags, name: 'watch-priority' })
  if (priority === undefined) return undefined
  switch (priority) {
    case 'development':
    case 'normal':
    case 'low-priority':
      return priority
    default:
      throw new CliArgumentError({
        message: '--watch-priority must be one of: development, normal, low-priority',
      })
  }
}

/**
 * Parses the authority `--mode` flag accepted ONLY by `track`. The chosen mode
 * (`local`, `remote`, or `shared`) is persisted workspace-wide in the manifest.
 *
 * The default is `remote` (the VRS mirror-adoption default, cli/spec.md): it is
 * safe-by-default because a Notion-authoritative workspace blocks local property
 * writes as drift, so an omitted `--mode` cannot accidentally mutate Notion.
 * `shared` is deliberately NOT the default: its convergence/settlement guards
 * stay dormant until SM5, so defaulting to it would run with those checks off.
 * Established commands reject `--mode` entirely (see `rejectPerRunAuthorityMode`).
 */
const authorityModeFlag = (flags: Map<string, string | true>): AuthorityMode => {
  const mode = optionalFlag({ flags, name: 'mode' })
  if (mode === undefined) return 'remote'
  switch (mode) {
    case 'local':
    case 'remote':
    case 'shared':
      return mode
    default:
      throw new CliArgumentError({
        message: '--mode must be one of: local, remote, shared',
      })
  }
}

/**
 * Authority mode is workspace-wide and set only by `track` (decisions 0003,
 * 0010): established commands reject a per-run `--mode` instead of silently
 * ignoring it.
 */
const rejectPerRunAuthorityMode = (flags: Map<string, string | true>): void => {
  if (flags.has('mode') === true) {
    throw new CliArgumentError({
      message:
        'authority mode is workspace-wide; set it with `track --mode`; established commands do not accept --mode',
    })
  }
}

const webhookProviderFlag = (
  flags: Map<string, string | true>,
): 'none' | 'tailscale' | 'manual' | undefined => {
  const provider = optionalFlag({ flags, name: 'webhook' })
  if (provider === undefined) {
    if (flags.has('webhook') === true) {
      throw new CliArgumentError({
        message: '--webhook must be one of: none, tailscale, manual',
      })
    }
    return undefined
  }
  switch (provider) {
    case 'none':
    case 'tailscale':
    case 'manual':
      return provider
    default:
      throw new CliArgumentError({
        message: '--webhook must be one of: none, tailscale, manual',
      })
  }
}

const optionalLimitFlag = (flags: Map<string, string | true>): number | undefined => {
  const limit = positiveIntegerFlag({ flags, name: 'limit' })
  const maxRows = positiveIntegerFlag({ flags, name: 'max-rows' })
  if (limit !== undefined && maxRows !== undefined) {
    throw new CliArgumentError({ message: 'Use only one of --limit or --max-rows' })
  }
  return limit ?? maxRows
}

const exportFormatFlag = (flags: Map<string, string | true>): ReplicaExportFormat => {
  const format = optionalFlag({ flags, name: 'format' }) ?? 'ndjson'
  switch (format) {
    case 'ndjson':
    case 'json':
      return format
    default:
      throw new CliArgumentError({ message: '--format must be one of: ndjson, json' })
  }
}

const capabilityListFlag = ({
  flags,
  name,
}: {
  readonly flags: Map<string, string | true>
  readonly name: string
}): ReadonlyArray<CapabilityName> | undefined => {
  const value = flags.get(name)
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CliArgumentError({ message: `Missing value for --${name}` })
  }

  const capabilities = value
    .split(',')
    .map((capability) => capability.trim())
    .filter((capability) => capability.length > 0)

  const invalid = capabilities.find(
    (capability) => capabilityNames.has(capability as CapabilityName) === false,
  )
  if (invalid !== undefined) {
    throw new CliArgumentError({
      message: `Unsupported capability in --${name}: ${invalid}`,
    })
  }

  return [...new Set(capabilities)] as ReadonlyArray<CapabilityName>
}

const parseChoice = (flags: Map<string, string | true>): ConflictResolutionChoice => {
  const strategy = optionalFlag({ flags, name: 'strategy' }) ?? 'keep-remote'
  switch (strategy) {
    case 'keep-remote':
      return { _tag: 'keep-remote' }
    case 'keep-local':
    case 'manual': {
      const value = decodeJson({
        schema: CanonicalPropertyValue,
        value: requiredFlag({ flags, name: 'value-json' }),
      })
      return {
        _tag: strategy,
        value,
      }
    }
    default:
      throw new CliArgumentError({
        message: `Unsupported conflict strategy: ${strategy}`,
      })
  }
}

/**
 * Parses raw `argv` into a typed `CliCommand`.
 *
 * Throws `CliArgumentError` for missing required flags, unknown commands,
 * or invalid flag values. Does not validate semantic context (store path, IDs, etc.).
 */
export const parseCliCommand = (argv: ReadonlyArray<string>): CliCommand => {
  const flags = parseFlags(argv)
  const words = parsePositionals(argv)
  const [command, subcommand] = words
  // Authority `--mode` is accepted ONLY by `track`; every other command rejects
  // a per-run override before any further parsing (decisions 0015, 0019).
  if (command !== 'track') rejectPerRunAuthorityMode(flags)
  switch (command) {
    case 'track': {
      const remote = words[1]
      if (remote === undefined) {
        throw new CliArgumentError({
          message: 'track requires a Notion data source or database URL positional argument',
        })
      }
      const workspace = words[2]
      if (workspace === undefined) {
        throw new CliArgumentError({
          message: 'track requires a workspace root positional argument',
        })
      }
      if (words.length > 3) {
        throw new CliArgumentError({
          message: 'track accepts exactly a remote ref and a workspace root positional argument',
        })
      }
      const limit = optionalLimitFlag(flags)
      if (limit !== undefined && flags.has('dry-run') === false) {
        throw new CliArgumentError({
          message: '--limit is only supported with track --dry-run',
        })
      }
      const remoteRef = parseNotionRemoteRef(remote)
      return {
        _tag: 'track',
        dataSourceId:
          remoteRef._tag === 'data-source'
            ? remoteRef.dataSourceId
            : decode({ schema: DataSourceId, value: remoteRef.databaseId }),
        remoteRef,
        workspaceRoot: normalizeAbsolutePath(workspace),
        authorityMode: authorityModeFlag(flags),
        dryRun: flags.has('dry-run'),
        ...(limit === undefined ? {} : { limit }),
      }
    }
    // `init`, `pull`, and `push` are internal reconciliation phases, not public
    // commands (CLI-R01). The internal functions (`initOneShotSync`,
    // `pullOneShotSync`, `pushOneShotSync`) remain; `track` and established
    // `sync` drive them. Reject the public verbs with a clean-break message.
    case 'init':
    case 'pull':
    case 'push':
      throw new CliArgumentError({
        message: `${command} is an internal reconciliation phase, not a public command; use \`sync\``,
      })
    case 'sync': {
      // `sync --from-notion` was the legacy adoption alias; adoption is now
      // `track` (CLI-R01). Reject it with the migration message before any
      // further parsing.
      if (flags.has('from-notion') === true) {
        throw new CliArgumentError({
          message:
            'sync --from-notion has been removed; use `track <id-or-url> <root> --mode <local|remote|shared>` to adopt a Notion data source',
        })
      }
      if (words.length > 2) {
        throw new CliArgumentError({
          message: 'sync accepts at most one workspace root positional argument',
        })
      }
      const watch = flags.has('watch')
      if (watch === false) {
        if (flags.has('state') === true) {
          throw new CliArgumentError({ message: '--state is only supported with sync --watch' })
        }
        if (flags.has('max-cycles') === true) {
          throw new CliArgumentError({
            message: '--max-cycles is only supported with sync --watch',
          })
        }
        if (flags.has('watch-priority') === true) {
          throw new CliArgumentError({
            message: '--watch-priority is only supported with sync --watch',
          })
        }
        if (flags.has('webhook') === true) {
          throw new CliArgumentError({ message: '--webhook is only supported with sync --watch' })
        }
        if (flags.has('webhook-required') === true) {
          throw new CliArgumentError({
            message: '--webhook-required is only supported with sync --watch',
          })
        }
        if (flags.has('non-interactive') === true) {
          throw new CliArgumentError({
            message: '--non-interactive is only supported with sync --watch',
          })
        }
      }
      const statePath = optionalFlag({ flags, name: 'state' })
      const maxCycles = positiveIntegerFlag({ flags, name: 'max-cycles' })
      const watchPriority = watchPriorityFlag(flags)
      const webhook = webhookProviderFlag(flags)
      // CLI-R02: a `sync --watch --dry-run` is a non-interfering observer that
      // writes NOTHING durable. A webhook receiver, however, enqueues durable
      // signals on delivery (`handleNotionWebhookDelivery` → `store.enqueueSignal`,
      // unconditionally — there is no dry-run path in the receiver), so running
      // one under dry-run would violate the guarantee. Reject at parse time,
      // before any receiver starts, rather than threading dry-run into the
      // receiver: a dry-run observer should not run a network receiver at all.
      if (
        watch === true &&
        flags.has('dry-run') === true &&
        webhook !== undefined &&
        webhook !== 'none'
      ) {
        throw new CliArgumentError({
          message:
            'sync --watch --dry-run cannot run a webhook receiver (it would enqueue durable signals); use --webhook none for a dry-run watch',
        })
      }
      return {
        _tag: 'sync',
        ...(words[1] === undefined ? {} : { workspaceRoot: normalizeAbsolutePath(words[1]) }),
        dryRun: flags.has('dry-run'),
        ...(watch === false ? {} : { watch: true }),
        ...(statePath === undefined ? {} : { statePath }),
        ...(maxCycles === undefined ? {} : { maxCycles }),
        ...(watchPriority === undefined ? {} : { watchPriority }),
        ...(webhook === undefined ? {} : { webhook }),
        ...(flags.has('webhook-required') === false ? {} : { webhookRequired: true }),
        ...(flags.has('non-interactive') === false ? {} : { nonInteractive: true }),
      }
    }
    case 'export': {
      if (words.length > 2) {
        throw new CliArgumentError({
          message: 'export accepts at most one workspace root positional argument',
        })
      }
      // Export does not accept a remote id or database URL (CLI-R02): the
      // legacy `export --from-notion <ref>` surface is removed. `--refresh` is a
      // boolean that re-observes the established binding before exporting; use
      // `track` first to adopt a remote source.
      if (flags.has('from-notion') === true) {
        throw new CliArgumentError({
          message:
            'export does not accept --from-notion; use `track <id-or-url> <root>` to adopt, then `export --refresh` to re-observe the established binding',
        })
      }
      if (flags.has('limit') === true || flags.has('max-rows') === true) {
        throw new CliArgumentError({ message: 'export does not support --limit or --max-rows' })
      }
      return {
        _tag: 'export',
        outputPath: normalizeAbsolutePath(requiredFlag({ flags, name: 'output' })),
        ...(words[1] === undefined ? {} : { workspaceRoot: normalizeAbsolutePath(words[1]) }),
        ...(flags.has('refresh') === false ? {} : { refresh: true }),
        format: exportFormatFlag(flags),
        ...(flags.has('require-clean') === false ? {} : { requireClean: true }),
        dryRun: flags.has('dry-run'),
      }
    }
    case 'status':
      if (words.length > 2) {
        throw new CliArgumentError({
          message: 'status accepts at most one workspace root positional argument',
        })
      }
      return {
        _tag: 'status',
        ...(words[1] === undefined ? {} : { workspaceRoot: normalizeAbsolutePath(words[1]) }),
      }
    case 'conflicts':
      if (subcommand === 'list') return { _tag: 'conflicts-list' }
      if (subcommand === 'resolve') {
        return {
          _tag: 'conflicts-resolve',
          conflictId: decode({
            schema: SyncEventId,
            value: requiredFlag({ flags, name: 'conflict-id' }),
          }),
          choice: parseChoice(flags),
          dryRun: flags.has('dry-run'),
        }
      }
      break
    case 'forget':
      return {
        _tag: 'forget',
        pageId: decode({ schema: PageId, value: requiredFlag({ flags, name: 'page-id' }) }),
        dryRun: flags.has('dry-run'),
      }
    case 'restore':
      return {
        _tag: 'restore',
        pageId: decode({ schema: PageId, value: requiredFlag({ flags, name: 'page-id' }) }),
        dryRun: flags.has('dry-run'),
      }
    case 'doctor':
      return { _tag: 'doctor' }
  }
  throw new CliArgumentError({
    message:
      'Expected one of: track, sync, export, status, conflicts list, conflicts resolve, forget, restore, doctor',
  })
}

type DiscoveredSelfContainedStore = {
  /** Control-plane store file (`.notion/v1/state.sqlite` for a tracked workspace). */
  readonly storePath: AbsolutePath
  /**
   * Public projection / CDC data file (`data/v1/<source>.sqlite`). Distinct from
   * `storePath` for a tracked workspace; equal to it for a standalone `--sqlite`
   * file (unified projection). decision 0020.
   */
  readonly dataFilePath: AbsolutePath
  readonly rootId: SyncRootIdType
  readonly dataSourceId: DataSourceId
  readonly workspaceRoot: AbsolutePath
  /**
   * Workspace-relative page directory for this tracked source (`pages/v1/<name>`,
   * from the manifest's `data_sources[].pages_dir`). Materialized `.nmd` page
   * files land under here, one page directory per tracked source (epic R: each
   * tracked data source owns exactly one data file and one page directory).
   * Absent for a standalone `--sqlite` file, which has no versioned layout and
   * keeps the legacy workspace-root body path.
   */
  readonly pagesDir?: string
}

const readSelfContainedBinding = ({
  storePath,
  rootId,
}: {
  readonly storePath: string
  readonly rootId?: SyncRootIdType
}): WorkspaceBindingRow | undefined => {
  if (existsSync(storePath) === false) return undefined
  const db = new DatabaseSync(storePath, { readOnly: true })
  try {
    const requiredTables = [
      '_nds_sync_root',
      '_nds_sync_event',
      '_nds_workspace_binding',
      '_nds_projection_metadata',
    ] as const
    for (const table of requiredTables) {
      const row = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(table)
      if (row === undefined) return undefined
    }
    const row =
      rootId === undefined
        ? (db
            .prepare(
              `SELECT root_id, data_source_id, database_id, workspace_root, store_identity
               FROM _nds_workspace_binding
               ORDER BY updated_at DESC
               LIMIT 1`,
            )
            .get() as Record<string, unknown> | undefined)
        : (db
            .prepare(
              `SELECT root_id, data_source_id, database_id, workspace_root, store_identity
               FROM _nds_workspace_binding
               WHERE root_id = ?`,
            )
            .get(rootId) as Record<string, unknown> | undefined)
    if (row === undefined) return undefined
    return {
      rootId: decode({ schema: SyncRootId, value: row.root_id }),
      dataSourceId: decode({ schema: DataSourceId, value: row.data_source_id }),
      databaseId:
        typeof row.database_id === 'string'
          ? decode({ schema: DatabaseId, value: row.database_id })
          : undefined,
      workspaceRoot:
        typeof row.workspace_root === 'string'
          ? row.workspace_root
          : (() => {
              throw new CliArgumentError({
                message: `Corrupt datasource-sync binding in ${storePath}: missing workspace_root`,
              })
            })(),
      storeIdentity:
        typeof row.store_identity === 'string'
          ? row.store_identity
          : (() => {
              throw new CliArgumentError({
                message: `Corrupt datasource-sync binding in ${storePath}: missing store_identity`,
              })
            })(),
    }
  } finally {
    db.close()
  }
}

/**
 * Fail closed on an established but corrupt store. The control plane lives in
 * `storePath` (`.notion/v1/state.sqlite` for a tracked workspace) and the public
 * projection in `dataFilePath` (`data/v1/<source>.sqlite`). For a standalone
 * `--sqlite` file the two paths coincide and a single file is checked, exactly
 * as before the control-plane split. decision 0020.
 */
const validateSelfContainedSqlite = ({
  storePath,
  dataFilePath: dataFileSqlitePath,
}: {
  readonly storePath: string
  readonly dataFilePath: string
}): void => {
  // Control-plane tables (and the CDC triggers) live in the store file.
  const controlPlaneObjects = [
    ['table', '_nds_sync_root'],
    ['table', '_nds_sync_event'],
    ['table', '_nds_workspace_binding'],
    ['table', '_nds_projection_metadata'],
    ['table', '_nds_api_contract'],
    ['table', '_nds_body_pointer'],
    ['table', '_nds_capability'],
    ['table', '_nds_conflict'],
    ['table', '_nds_data_source'],
    ['table', '_nds_guard_block'],
    ['table', '_nds_outbox'],
    ['table', '_nds_property_shadow'],
    ['table', '_nds_query_absence'],
    ['table', '_nds_query_scan_checkpoint'],
    ['table', '_nds_row'],
    ['table', '_nds_schema_property'],
    ['table', '_nds_tombstone'],
  ] as const
  // Public views and the CDC write-intent triggers live in the data file.
  const dataFileObjects = [
    ['view', 'pages'],
    ['view', 'schema'],
    ['view', 'schema_properties'],
    ['view', 'changes'],
    ['view', 'conflicts'],
    ['view', 'sync_status'],
    ['trigger', '_nds_pages_update'],
    ['trigger', '_nds_pages_insert'],
    ['trigger', '_nds_pages_delete'],
  ] as const
  const assertObjects = ({
    path,
    objects,
  }: {
    readonly path: string
    readonly objects: ReadonlyArray<readonly [string, string]>
  }): void => {
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      for (const [type, name] of objects) {
        const found = db
          .prepare(`SELECT name FROM sqlite_master WHERE type = ? AND name = ?`)
          .get(type, name)
        if (found === undefined) {
          throw new CliArgumentError({
            message: `SQLite file ${path} is missing required ${type} ${name}; refusing to open`,
          })
        }
      }
    } finally {
      db.close()
    }
  }
  assertObjects({ path: storePath, objects: controlPlaneObjects })
  assertObjects({ path: dataFileSqlitePath, objects: dataFileObjects })
  // The CDC trigger floor is on the data file (where write-intent triggers live).
  const db = new DatabaseSync(dataFileSqlitePath, { readOnly: true })
  try {
    const triggerCount = db
      .prepare(`SELECT count(*) AS count FROM sqlite_master WHERE type = 'trigger'`)
      .get() as { readonly count?: unknown } | undefined
    // Floor calibrated to the data file's freshly-projected CDC/write-intent
    // trigger count (34 post control-plane split, decision 0020): dropping any one
    // trips this fail-closed guard.
    if (typeof triggerCount?.count !== 'number' || triggerCount.count < 34) {
      throw new CliArgumentError({
        message: `SQLite file ${dataFileSqlitePath} is missing required datasource-sync triggers; refusing to open`,
      })
    }
  } finally {
    db.close()
  }
}

/**
 * Fail closed on a workspace whose namespace is unknown or mixed. Must run
 * before any local edit is read as write intent. Returns the loaded manifest
 * result so callers can branch on `tracked` vs `untracked` without reloading.
 */
const requireCompatibleWorkspaceNamespace = (workspaceRoot: AbsolutePath) => {
  const result = loadWorkspaceManifest(workspaceRoot)
  if (result._tag === 'mixed-namespace') {
    throw new WorkspaceNamespaceError({
      guard: 'MixedWorkspaceNamespace',
      message: `Workspace ${workspaceRoot} mixes namespace versions (${result.offendingPaths.join(', ')}); resolve to a single namespace before running. The system will not migrate or reinterpret artifacts.`,
    })
  }
  if (result._tag === 'unknown-namespace') {
    throw new WorkspaceNamespaceError({
      guard: 'UnknownWorkspaceNamespace',
      message: `Workspace manifest ${result.manifestPath} is not a supported v1 namespace; refusing to open. ${result.reason}`,
    })
  }
  if (result._tag === 'invalid-linked-view') {
    throw new WorkspaceNamespaceError({
      guard: 'InvalidLinkedView',
      message: `Workspace manifest ${result.manifestPath} is inconsistent; refusing to open. ${result.reason}`,
    })
  }
  return result
}

/**
 * Writes (or updates) the v1 workspace manifest when an adoption command
 * (`track`, or the legacy `sync --from-notion`) establishes a tracked source.
 * Upserts the established source by `data_source_id`. The source `name` reuses
 * the database ID, so artifacts land at `data/v1/<databaseId>.sqlite` and
 * `pages/v1/<databaseId>` — the previous single-file location, relocated into
 * the versioned namespace.
 *
 * `authorityMode` is the workspace-wide authority mode. `track --mode` supplies
 * it explicitly (closing the SM2 M3 gap where adoption could not record a
 * complete manifest with an authority mode); the legacy `sync --from-notion`
 * path omits it and preserves any existing manifest mode, defaulting to
 * `remote` for a fresh workspace.
 *
 * Re-tracking is intentional reconfiguration: a second `track --mode <m>` on an
 * already-tracked workspace OVERWRITES the persisted `authority_mode` with `<m>`
 * (the legacy establish path, with `authorityMode` omitted, preserves it).
 */
const writeEstablishedWorkspaceManifest = (source: EstablishManifestSource): void => {
  const existing = loadWorkspaceManifest(source.workspaceRoot)
  const entry: WorkspaceManifestDataSourceV1 = {
    name: source.name,
    data_source_id: source.dataSourceId,
    database_id: source.databaseId,
    data_file: dataFileRelativePath(source.name),
    pages_dir: pagesDirRelativePath(source.name),
  }
  const priorSources =
    existing._tag === 'tracked'
      ? existing.manifest.data_sources.filter(
          (current) => current.data_source_id !== source.dataSourceId,
        )
      : []
  const manifest: WorkspaceManifestV1 = {
    namespace_version: 'v1',
    // Fresh-workspace default is `remote` (safe-by-default: blocks local writes
    // as drift); an explicit `track --mode` overrides, and an existing manifest's
    // mode is preserved when the legacy establish path omits `authorityMode`.
    authority_mode:
      source.authorityMode ??
      (existing._tag === 'tracked' ? existing.manifest.authority_mode : 'remote'),
    data_sources: [...priorSources, entry],
    ...(existing._tag === 'tracked' && existing.manifest.linked_views !== undefined
      ? { linked_views: existing.manifest.linked_views }
      : {}),
  }
  writeWorkspaceManifestSync({ workspaceRoot: source.workspaceRoot, manifest })
}

/**
 * Resolves the tracked data file for an established workspace from its v1
 * manifest. The manifest is the location source-of-truth; the binding in the
 * resolved SQLite file is then verified for integrity.
 */
const discoverSelfContainedStore = (workspaceRoot: AbsolutePath): DiscoveredSelfContainedStore => {
  const result = requireCompatibleWorkspaceNamespace(workspaceRoot)
  if (result._tag === 'untracked') {
    throw new WorkspaceNotTracked({
      message: `No workspace manifest at ${result.manifestPath}; this directory is not a tracked datasource workspace. Run track <database-url> ${workspaceRoot} to establish it.`,
    })
  }

  const sources = result.manifest.data_sources
  if (sources.length !== 1) {
    throw new CliArgumentError({
      message:
        sources.length === 0
          ? `Workspace manifest in ${workspaceRoot} tracks no data sources; run track <database-url> ${workspaceRoot}`
          : `Workspace manifest in ${workspaceRoot} tracks multiple data sources; pass --sqlite <path>`,
    })
  }

  const source = sources[0]!
  const dataFileAbsolutePath = join(workspaceRoot, source.data_file)
  const rootId = rootIdForDataSource(source.data_source_id)
  // The control plane lives in the hidden `.notion/v1/state.sqlite`; the public
  // data file holds only the projection. The binding moved with the control
  // plane, so integrity is verified against the state store. decision 0020.
  const storePath = stateSqlitePath(workspaceRoot)
  const binding = readSelfContainedBinding({ storePath, rootId })
  if (binding === undefined) {
    throw new CliArgumentError({
      message: `Workspace control-plane store ${storePath} is missing or has corrupt datasource-sync internals; pass --sqlite <path> after repair`,
    })
  }
  if (binding.workspaceRoot !== workspaceRoot) {
    throw new CliArgumentError({
      message: `SQLite binding workspace mismatch for ${storePath}; refusing to open it from ${workspaceRoot}`,
    })
  }
  if (binding.dataSourceId !== source.data_source_id) {
    throw new CliArgumentError({
      message: `Workspace control-plane store ${storePath} is bound to ${binding.dataSourceId} but the manifest declares ${source.data_source_id}; refusing to open`,
    })
  }
  return {
    storePath: decode({ schema: AbsolutePath, value: storePath }),
    dataFilePath: decode({ schema: AbsolutePath, value: dataFileAbsolutePath }),
    rootId,
    dataSourceId: binding.dataSourceId,
    workspaceRoot,
    pagesDir: source.pages_dir,
  }
}

const discoverExplicitSplitWorkspaceStore = ({
  explicitSqlitePath,
  workspaceRoot,
}: {
  readonly explicitSqlitePath: string
  readonly workspaceRoot: AbsolutePath
}): DiscoveredSelfContainedStore => {
  const result = requireCompatibleWorkspaceNamespace(workspaceRoot)
  if (result._tag === 'untracked') {
    throw new WorkspaceNotTracked({
      message: `No workspace manifest at ${result.manifestPath}; this directory is not a tracked datasource workspace. Run track <database-url> ${workspaceRoot} to establish it.`,
    })
  }

  const source = result.manifest.data_sources.find(
    (candidate) =>
      normalizeAbsolutePath(join(workspaceRoot, candidate.data_file)) === explicitSqlitePath,
  )
  if (source === undefined) {
    throw new CliArgumentError({
      message: `SQLite file ${explicitSqlitePath} is not declared in workspace manifest ${manifestPath(workspaceRoot)}`,
    })
  }

  const storePath = stateSqlitePath(workspaceRoot)
  const rootId = rootIdForDataSource(source.data_source_id)
  const binding = readSelfContainedBinding({ storePath, rootId })
  if (binding === undefined) {
    throw new CliArgumentError({
      message: `Workspace control-plane store ${storePath} is missing a binding for ${source.data_source_id}; refusing to open`,
    })
  }
  if (binding.workspaceRoot !== workspaceRoot) {
    throw new CliArgumentError({
      message: `SQLite binding workspace mismatch for ${storePath}; refusing to open it from ${workspaceRoot}`,
    })
  }
  if (binding.dataSourceId !== source.data_source_id) {
    throw new CliArgumentError({
      message: `Workspace control-plane store ${storePath} root ${rootId} is bound to ${binding.dataSourceId} but the manifest declares ${source.data_source_id}; refusing to open`,
    })
  }

  return {
    storePath: decode({ schema: AbsolutePath, value: storePath }),
    dataFilePath: decode({ schema: AbsolutePath, value: explicitSqlitePath }),
    rootId,
    dataSourceId: binding.dataSourceId,
    workspaceRoot,
    pagesDir: source.pages_dir,
  }
}

/**
 * Resolves an explicit `--sqlite <path>` to a control-plane store and a public
 * data file (decision 0020). Two cases:
 *
 * - The file is genuinely self-contained (carries its own control plane and
 *   binding): unified — both paths are the file, exactly as before the split.
 * - The file is a tracked workspace's data file (no embedded control plane):
 *   the control plane lives in the sibling `.notion/v1/state.sqlite`. The
 *   workspace root is derived from the fixed `<root>/data/v1/<name>.sqlite`
 *   layout and confirmed against the manifest's `data_file` before routing
 *   through `discoverSelfContainedStore`, which restores the namespace
 *   fail-closed path.
 */
const resolveExplicitSqliteStore = ({
  explicitSqlitePath,
  fallbackWorkspaceRoot,
}: {
  readonly explicitSqlitePath: string
  readonly fallbackWorkspaceRoot?: AbsolutePath
}): DiscoveredSelfContainedStore => {
  const binding = readSelfContainedBinding({ storePath: explicitSqlitePath })
  if (binding !== undefined) {
    // Self-contained file: control plane + projection live together (unified).
    const path = decode({ schema: AbsolutePath, value: explicitSqlitePath })
    return {
      storePath: path,
      dataFilePath: path,
      rootId: binding.rootId,
      dataSourceId: binding.dataSourceId,
      workspaceRoot:
        fallbackWorkspaceRoot ?? decode({ schema: AbsolutePath, value: binding.workspaceRoot }),
    }
  }
  // No embedded control plane: the file may be a split workspace's data file at
  // `<root>/data/v1/<name>.sqlite`. Derive the workspace root by stripping that
  // fixed suffix. When the file sits in the versioned data directory, route
  // through explicit manifest-source selection, which works for multi-source
  // workspaces and confirms the manifest tracks exactly this data file before
  // resolving the sibling control-plane store.
  const candidateRoot = dirname(dirname(dirname(explicitSqlitePath)))
  const inVersionedDataDir = join(candidateRoot, dataDirectoryName) === dirname(explicitSqlitePath)
  if (inVersionedDataDir === true) {
    const workspaceRoot = decode({ schema: AbsolutePath, value: candidateRoot })
    if (fallbackWorkspaceRoot !== undefined && workspaceRoot !== fallbackWorkspaceRoot) {
      throw new CliArgumentError({
        message: `SQLite file ${explicitSqlitePath} is under ${workspaceRoot}, but command workspace root is ${fallbackWorkspaceRoot}`,
      })
    }
    return discoverExplicitSplitWorkspaceStore({ explicitSqlitePath, workspaceRoot })
  }
  throw new CliArgumentError({
    message: `SQLite file ${explicitSqlitePath} is missing datasource-sync internals`,
  })
}

const sqlitePathFromFlags = (flags: Map<string, string | true>): string | undefined => {
  if (flags.has('store') === true) {
    throw new CliArgumentError({
      message:
        '--store has been removed; use --sqlite <path> for explicit self-contained database files',
    })
  }
  return optionalFlag({ flags, name: 'sqlite' })
}

const normalizeOptionalSqlitePath = (value: string | undefined): string | undefined =>
  value === undefined ? undefined : normalizeAbsolutePath(value)

/**
 * Parses `argv` into a `CliContext`, opening the sync store in the process.
 *
 * Discovers a self-contained SQLite file for workspace commands. Advanced commands may pass
 * `--sqlite`; legacy `--store` is rejected so callers do not depend on split-store paths.
 * Throws `CliArgumentError` for missing or invalid flags; the caller is responsible
 * for closing `context.store` when the command completes.
 */
export const parseCliContext = ({
  argv,
  resolvedCommand,
}: {
  readonly argv: ReadonlyArray<string>
  readonly resolvedCommand?: CliCommand
}): CliContext => {
  const flags = parseFlags(argv)
  const command = resolvedCommand ?? parseCliCommand(argv)
  const commandDryRun = 'dryRun' in command && command.dryRun === true
  const maxExecutorSteps = positiveIntegerFlag({ flags, name: 'max-executor-steps' })
  const requiredCapabilities = capabilityListFlag({ flags, name: 'required-capabilities' })
  const explicitSqlitePath = normalizeOptionalSqlitePath(sqlitePathFromFlags(flags))
  if (flags.has('query-contract-json') === true) {
    throw new CliArgumentError({
      message:
        '--query-contract-json is not supported by the product CLI; database-ID SQLite files are always full Notion database replicas',
    })
  }
  if (
    (command._tag === 'sync-from-notion' || command._tag === 'track') &&
    explicitSqlitePath !== undefined
  ) {
    const verb = command._tag === 'track' ? 'track' : 'sync --from-notion'
    throw new CliArgumentError({
      message: `${verb} always creates <workspace>/<database-id>.sqlite; --sqlite is only for established replica commands`,
    })
  }
  // Captured when a workspace-rooted command establishes a tracked source, so
  // the v1 manifest can be (re)written after the store is opened. `authorityMode`
  // is carried only by `track --mode`, which sets the workspace-wide mode.
  let establishManifestSource: EstablishManifestSource | undefined
  const discovered =
    command._tag === 'sync-from-notion' || command._tag === 'track'
      ? (() => {
          const databaseId =
            command.remoteRef._tag === 'database'
              ? command.remoteRef.databaseId
              : (command.remoteRef.sourceDatabaseId ?? command.dataSourceId)
          // Fail closed on a mixed or unknown namespace before establishing
          // anything. An absent manifest (untracked) is fine here: we create it.
          if (commandDryRun !== true) {
            requireCompatibleWorkspaceNamespace(command.workspaceRoot)
          }
          // `track` (and the legacy `sync --from-notion`) always establishes
          // inside a workspace (--sqlite is rejected above), so the control plane
          // lives in the hidden state.sqlite and the public projection in the
          // data file. decision 0020.
          const dataFile = defaultSqlitePath({ workspaceRoot: command.workspaceRoot, databaseId })
          const storePath = decode({
            schema: AbsolutePath,
            value: stateSqlitePath(command.workspaceRoot),
          })
          const existingBinding =
            commandDryRun === true || existsSync(storePath) === false
              ? undefined
              : readSelfContainedBinding({ storePath })
          // One `.notion/v1/state.sqlite` holds one binding row per tracked data
          // source (keyed by the derived `data-source:<id>` root id), so adding a
          // second source to the same workspace is allowed (VRS multi-source
          // workspace). The discriminator is the workspace root: every binding in
          // a given state store shares it, so a mismatch on the latest binding
          // signals a moved or copied control-plane store and is refused.
          if (
            existingBinding !== undefined &&
            existingBinding.workspaceRoot !== command.workspaceRoot
          )
            throw new CliArgumentError({
              message: `Control-plane store at ${storePath} is bound to workspace ${existingBinding.workspaceRoot}; refusing to establish ${command.dataSourceId} under ${command.workspaceRoot}`,
            })
          if (commandDryRun !== true) {
            establishManifestSource = {
              workspaceRoot: command.workspaceRoot,
              name: databaseId,
              dataSourceId: decode({ schema: DataSourceId, value: command.dataSourceId }),
              databaseId,
              // `track --mode` records the workspace-wide authority mode; the
              // legacy `sync --from-notion` path preserves the existing mode.
              ...(command._tag === 'track' ? { authorityMode: command.authorityMode } : {}),
            }
          }
          return {
            storePath: commandDryRun === true ? ':memory:' : storePath,
            dataFilePath: commandDryRun === true ? ':memory:' : dataFile,
            rootId: rootIdForDataSource(command.dataSourceId),
            dataSourceId: command.dataSourceId,
            workspaceRoot: command.workspaceRoot,
            // Establish/track materializes `.nmd` page files into the source's
            // page directory (`pages/v1/<name>`); the manifest establish path
            // writes the same `pages_dir`.
            pagesDir: pagesDirRelativePath(databaseId),
          }
        })()
      : (command._tag === 'sync' || command._tag === 'status' || command._tag === 'export') &&
          command.workspaceRoot !== undefined
        ? explicitSqlitePath === undefined
          ? discoverSelfContainedStore(command.workspaceRoot)
          : resolveExplicitSqliteStore({
              explicitSqlitePath,
              fallbackWorkspaceRoot: command.workspaceRoot,
            })
        : explicitSqlitePath !== undefined && flags.has('root-id') === false
          ? resolveExplicitSqliteStore({ explicitSqlitePath })
          : (() => {
              const storePath = explicitSqlitePath ?? requiredFlag({ flags, name: 'sqlite' })
              return {
                storePath,
                dataFilePath: storePath,
                rootId: decode({
                  schema: SyncRootId,
                  value: requiredFlag({ flags, name: 'root-id' }),
                }),
                dataSourceId: decode({
                  schema: DataSourceId,
                  value: requiredFlag({ flags, name: 'data-source-id' }),
                }),
                workspaceRoot: decode({
                  schema: AbsolutePath,
                  value: requiredFlag({ flags, name: 'workspace-root' }),
                }),
              }
            })()
  const rowLimit =
    command._tag === 'sync-from-notion' || command._tag === 'track' ? command.limit : undefined
  const baseQueryContract = fullReplicaQueryContract()
  const queryContract =
    rowLimit === undefined
      ? baseQueryContract
      : decode({
          schema: QueryContract,
          value: {
            ...baseQueryContract,
            pageSize: Math.min(baseQueryContract.pageSize, rowLimit),
          },
        })
  const schemaProperties =
    optionalFlag({ flags, name: 'schema-properties-json' }) === undefined
      ? undefined
      : (decodeJson({
          schema: Schema.Array(SchemaPropertyObservationJson),
          value: requiredFlag({ flags, name: 'schema-properties-json' }),
        }) as ReadonlyArray<SchemaPropertyObservation>)
  // Fail-closed chokepoint for write-intent commands (`sync`, `sync --watch`,
  // and `push` — `watch` is a `sync` variant) that resolve a data file via
  // `--sqlite`. Discovery already guards the workspace-rooted path, but the
  // `--sqlite` branches read `readPendingReplicaChanges` as write intent without
  // it; guarding here covers them before any file is opened or mutated. A
  // genuinely standalone `--sqlite` file (binding not inside a tracked
  // workspace) is exempt automatically: `requireCompatibleWorkspaceNamespace`
  // returns `untracked` for a workspace without a manifest instead of throwing.
  if ((command._tag === 'sync' || command._tag === 'push') && discovered.storePath !== ':memory:') {
    requireCompatibleWorkspaceNamespace(discovered.workspaceRoot)
  }
  if (discovered.storePath !== ':memory:') {
    mkdirSync(dirname(discovered.storePath), { recursive: true })
    mkdirSync(dirname(discovered.dataFilePath), { recursive: true })
    if (
      command._tag !== 'sync-from-notion' &&
      command._tag !== 'track' &&
      existsSync(discovered.storePath) === true
    ) {
      validateSelfContainedSqlite({
        storePath: discovered.storePath,
        dataFilePath: discovered.dataFilePath,
      })
    }
  }
  const store = openNotionSyncStore({ path: discovered.storePath })
  if (
    command._tag !== 'sync-from-notion' &&
    command._tag !== 'track' &&
    discovered.storePath !== ':memory:'
  ) {
    const binding = store.readWorkspaceBinding(discovered.rootId)
    if (binding === undefined) {
      store.close()
      throw new CliArgumentError({
        message: `SQLite file ${discovered.storePath} is missing _nds_workspace_binding; refusing to open`,
      })
    }
    if (
      binding.dataSourceId !== discovered.dataSourceId ||
      binding.workspaceRoot !== discovered.workspaceRoot
    ) {
      store.close()
      throw new CliArgumentError({
        message: `SQLite binding mismatch for ${discovered.storePath}; refusing to open`,
      })
    }
  }

  // Read the workspace-wide authority mode from the manifest. For a fresh
  // establish command, parse only carries the pending manifest entry; the command
  // writes it after remote establishment succeeds.
  const manifestResult =
    discovered.storePath === ':memory:'
      ? undefined
      : loadWorkspaceManifest(discovered.workspaceRoot)
  const authorityMode =
    establishManifestSource?.authorityMode ??
    (manifestResult !== undefined && manifestResult._tag === 'tracked'
      ? manifestResult.manifest.authority_mode
      : undefined)

  return {
    store,
    storePath: discovered.storePath,
    replicaPath: discovered.dataFilePath,
    rootId: discovered.rootId,
    dataSourceId: discovered.dataSourceId,
    workspaceRoot: discovered.workspaceRoot,
    queryContract,
    ...('pagesDir' in discovered && discovered.pagesDir !== undefined
      ? { sourcePagesDir: discovered.pagesDir }
      : {}),
    ...(authorityMode === undefined ? {} : { authorityMode }),
    ...(schemaProperties === undefined ? {} : { schemaProperties }),
    ...(requiredCapabilities === undefined ? {} : { requiredCapabilities }),
    ...(flags.has('no-materialize-bodies') === false && commandDryRun !== true
      ? {}
      : { materializeBodies: false }),
    ...(rowLimit === undefined ? {} : { rowLimit }),
    ...(establishManifestSource === undefined
      ? {}
      : { pendingManifestSource: establishManifestSource }),
    ...(maxExecutorSteps === undefined ? {} : { maxExecutorSteps }),
  }
}

const cliGatewayConfigurationError = (operation: GatewayOperation) =>
  makeGatewayError({
    operation,
    guard: 'CapabilityPreflightFailed',
    message:
      'Missing Notion API token for the live CLI gateway; set NOTION_API_TOKEN or NOTION_TOKEN, or use the library runner with an injected gateway client.',
  })

const tokenFromEnv = (env: CliRuntimeEnv): string | undefined => {
  for (const name of NOTION_TOKEN_ENV_VARS) {
    const value = env[name]
    if (value !== undefined && value.length > 0) {
      return value
    }
  }
  return undefined
}

const liveNotionClientFromEnv = (env: CliRuntimeEnv): NotionGatewayClient | undefined => {
  const envToken = tokenFromEnv(env)
  if (envToken === undefined) return undefined

  const liveBaseLayer = Layer.mergeAll(
    NotionConfigLive({
      authToken: Redacted.make(envToken),
      retryEnabled: true,
      maxRetries: 2,
      retryBaseDelay: 500,
    }),
    FetchHttpClient.layer,
  )

  return makeNotionEffectClientGatewayClient((effect) => effect.pipe(Effect.provide(liveBaseLayer)))
}

const resolveDatabaseDataSourceId = ({
  databaseId,
  client,
}: {
  readonly databaseId: string
  readonly client: NotionGatewayClient
}): Effect.Effect<
  { readonly dataSourceId: DataSourceId; readonly databaseId: string },
  CliArgumentError
> =>
  client.retrieveDatabase({ databaseId }).pipe(
    Effect.mapError(
      () =>
        new CliArgumentError({
          message:
            'Unable to retrieve the Notion database while resolving the adoption ref; verify the integration can access the database, or pass a data source ID directly.',
        }),
    ),
    Effect.flatMap((database) => {
      const dataSources = database.data_sources ?? []
      if (dataSources.length === 1) {
        const [dataSource] = dataSources
        return Effect.succeed({
          dataSourceId: decode({ schema: DataSourceId, value: dataSource?.id }),
          databaseId: String(database.id),
        })
      }
      return Effect.fail(
        new CliArgumentError({
          message:
            dataSources.length === 0
              ? 'The Notion database does not report any child data sources; verify the integration can access the database, or pass a data source ID directly.'
              : 'The Notion database has multiple child data sources; pass the desired data source ID directly.',
        }),
      )
    }),
  )

/** Resolve any `database`-tagged Notion remote refs on a CLI command into concrete `data-source` refs by querying the gateway — passes other commands through unchanged. */
export const resolveCliCommandNotionRefs = ({
  command,
  options = {},
}: {
  readonly command: CliCommand
  readonly options?: CliRuntimeOptions
}): Effect.Effect<CliCommand, CliArgumentError> => {
  // Only adoption (`track`, or the legacy `sync-from-notion`) carries a Notion
  // remote ref to resolve. Export operates on the existing binding and never
  // accepts a remote id/URL (CLI-R02), so it needs no resolution here.
  const databaseRef =
    (command._tag === 'sync-from-notion' || command._tag === 'track') &&
    command.remoteRef._tag === 'database'
      ? command.remoteRef
      : undefined

  if (databaseRef === undefined) {
    return Effect.succeed(command)
  }
  const client = options.gatewayClient ?? liveNotionClientFromEnv(options.env ?? process.env)
  if (client === undefined) {
    return Effect.fail(
      new CliArgumentError({
        message: `${command._tag === 'track' ? 'track' : 'sync'} received a Notion database URL, but no Notion client is configured to resolve its child data source; set NOTION_API_TOKEN/NOTION_TOKEN or pass a data source ID directly.`,
      }),
    )
  }
  const databaseId = databaseRef.databaseId
  return resolveDatabaseDataSourceId({
    databaseId,
    client,
  }).pipe(
    Effect.map((resolved) => ({
      ...command,
      dataSourceId: resolved.dataSourceId,
      remoteRef: {
        _tag: 'data-source' as const,
        dataSourceId: resolved.dataSourceId,
        sourceDatabaseId: resolved.databaseId,
      },
    })),
  )
}

const missingTokenCliGateway: NotionDataSourceGatewayShape = {
  apiContract: makeNotionApiContract({ supportedCapabilities: [] }),
  preflightCapabilities: () => Effect.fail(cliGatewayConfigurationError('preflightCapabilities')),
  retrieveDataSource: () => Effect.fail(cliGatewayConfigurationError('retrieveDataSource')),
  queryRows: () => Stream.fail(cliGatewayConfigurationError('queryRows')),
  retrievePage: () => Effect.fail(cliGatewayConfigurationError('retrievePage')),
  retrievePageProperty: () => Stream.fail(cliGatewayConfigurationError('retrievePageProperty')),
  patchPageProperties: () => Effect.fail(cliGatewayConfigurationError('patchPageProperties')),
  createPage: () => Effect.fail(cliGatewayConfigurationError('createPage')),
  patchDataSourceSchema: () => Effect.fail(cliGatewayConfigurationError('patchDataSourceSchema')),
  patchDataSourceMetadata: () =>
    Effect.fail(cliGatewayConfigurationError('patchDataSourceMetadata')),
  patchDatabaseMetadata: () => Effect.fail(cliGatewayConfigurationError('patchDatabaseMetadata')),
  trashPage: () => Effect.fail(cliGatewayConfigurationError('trashPage')),
  restorePage: () => Effect.fail(cliGatewayConfigurationError('restorePage')),
}

/**
 * Builds the Effect `Layer` that provides `NotionDataSourceGateway`, `PageBodySyncPort`,
 * and `LocalWorkspacePort` for a CLI command run.
 *
 * Gateway priority: explicit `options.gateway` > `options.gatewayClient` > live Notion client
 * (token from env) > stub that returns `CapabilityPreflightFailed` on every call.
 * Body sync and workspace materialization default to the live NotionMD adapters when the CLI
 * owns the live Notion runtime. Injected gateway/body/workspace ports keep their explicit
 * test or library semantics.
 */
export const makeCliRuntimeLayer = ({
  context,
  options = {},
}: {
  readonly context: CliContext
  readonly options?: CliRuntimeOptions
}): Layer.Layer<NotionDataSourceGateway | PageBodySyncPort | LocalWorkspacePort> => {
  const envToken = tokenFromEnv(options.env ?? process.env)
  const liveBaseLayer =
    envToken === undefined
      ? undefined
      : Layer.mergeAll(
          NotionConfigLive({
            authToken: Redacted.make(envToken),
            retryEnabled: true,
            maxRetries: 2,
            retryBaseDelay: 500,
          }),
          FetchHttpClient.layer,
        )
  const useLiveNotionMdBodyRuntime =
    liveBaseLayer !== undefined &&
    options.gateway === undefined &&
    options.gatewayClient === undefined &&
    options.body === undefined
  const notionMdLiveLayer =
    liveBaseLayer === undefined
      ? undefined
      : Layer.mergeAll(
          NotionMdGatewayLive.pipe(Layer.provide(liveBaseLayer)),
          NmdStateStoreLive.pipe(Layer.provide(NodeContext.layer)),
        )
  const gatewayLayer =
    options.gateway !== undefined
      ? Layer.succeed(NotionDataSourceGateway, options.gateway)
      : options.gatewayClient !== undefined
        ? Layer.succeed(
            NotionDataSourceGateway,
            makeNotionDataSourceGatewayFromClient({ client: options.gatewayClient }),
          )
        : liveBaseLayer === undefined
          ? Layer.succeed(NotionDataSourceGateway, missingTokenCliGateway)
          : NotionDataSourceGatewayLive.pipe(Layer.provide(liveBaseLayer))

  const bodyLayer =
    options.body !== undefined
      ? Layer.succeed(PageBodySyncPort, options.body)
      : useLiveNotionMdBodyRuntime === false || notionMdLiveLayer === undefined
        ? Layer.succeed(
            PageBodySyncPort,
            makeUnsupportedPageBodySyncPort({
              message:
                'No NotionMD PageBodySyncPort is configured for the CLI; body sync is fail-closed until the NotionMD adapter is injected.',
            }),
          )
        : Layer.effect(
            PageBodySyncPort,
            Effect.gen(function* () {
              const gateway = yield* NotionMdGateway
              const stateStore = yield* NmdStateStore
              return makeNotionMdPageBodySyncPort({
                root: context.workspaceRoot,
                gateway,
                stateStore,
              })
            }),
          ).pipe(Layer.provide(notionMdLiveLayer))

  const workspaceLayer =
    options.workspace !== undefined
      ? Layer.succeed(LocalWorkspacePort, options.workspace)
      : useLiveNotionMdBodyRuntime === true && notionMdLiveLayer !== undefined
        ? Layer.effect(
            LocalWorkspacePort,
            Effect.gen(function* () {
              const gateway = yield* NotionMdGateway
              const stateStore = yield* NmdStateStore
              return makeNotionMdMaterializingLocalWorkspacePort({
                root: context.workspaceRoot,
                gateway,
                stateStore,
              })
            }),
          ).pipe(Layer.provide(notionMdLiveLayer))
        : filesystemLocalWorkspacePortLayer({ root: context.workspaceRoot })

  return Layer.mergeAll(gatewayLayer, bodyLayer, workspaceLayer)
}

/** Convenience wrapper that runs `runCliCommand` with the runtime layer built by `makeCliRuntimeLayer`. */
export const runCliCommandWithRuntime = ({
  command,
  context,
  options = {},
}: {
  readonly command: CliCommand
  readonly context: CliContext
  readonly options?: CliRuntimeOptions
}) =>
  runCliCommand(command, context).pipe(Effect.provide(makeCliRuntimeLayer({ context, options })))

const syncProgressCommandTags = new Set<CliCommand['_tag']>([
  'track',
  'init',
  'pull',
  'push',
  'sync',
  'sync-from-notion',
  'export',
])

const shouldShowSyncProgress = (command: CliCommand): boolean =>
  syncProgressCommandTags.has(command._tag)

const rateLimitProgressEventFromHttp = (event: NotionHttpTelemetryEvent): SyncProgressEvent => {
  const rateLimit = Option.getOrUndefined(event.rateLimit)
  return {
    _tag: 'rate-limit',
    operation: event.operation,
    method: event.method,
    status: event.status,
    requestCount: event._tag === 'response' ? event.quotaCost : 0,
    ...(rateLimit === undefined ? {} : { remaining: rateLimit.remaining }),
    ...(rateLimit === undefined || rateLimit.resetAfterSeconds <= 0
      ? {}
      : { resetAfterSeconds: rateLimit.resetAfterSeconds }),
    ...(event._tag === 'retry' ? { retryDelayMs: event.delayMs } : {}),
  }
}

const renderPlainRateLimitProgress = (event: SyncProgressEvent): string | undefined => {
  if (event._tag !== 'rate-limit') {
    return undefined
  }
  const details = [
    `${event.method} ${event.operation}`,
    `status ${event.status.toString()}`,
    event.remaining === undefined ? undefined : `${event.remaining.toString()} quota remaining`,
    event.resetAfterSeconds === undefined ? undefined : `reset ${event.resetAfterSeconds}s`,
    event.retryDelayMs === undefined ? undefined : `retry ${Math.ceil(event.retryDelayMs / 1000)}s`,
  ].filter((item): item is string => item !== undefined)
  return details.join(' · ')
}

const runWithPlainSyncProgress = <A, E, R>({
  command,
  effect,
}: {
  readonly command: CliCommand
  readonly effect: Effect.Effect<A, E, R>
}): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.provideService(SyncProgress, {
      report: (event) =>
        Effect.sync(() => {
          const rateLimit = renderPlainRateLimitProgress(event)
          if (rateLimit !== undefined) {
            process.stderr.write(`notion db ${command._tag} rate ${rateLimit}\n`)
            return
          }
          const suffix =
            event._tag === 'query-page'
              ? ` ${event.rows.toString()} rows`
              : event._tag === 'hydrate-row'
                ? ` ${event.current.toString()}/${event.total.toString()} rows`
                : event._tag === 'executor-step'
                  ? ` ${event.current.toString()}/${event.max.toString()} write steps`
                  : ''
          const phase = event._tag === 'phase' ? event.phase : event._tag
          process.stderr.write(`notion db ${command._tag} ${phase}${suffix}\n`)
        }),
    }),
    Effect.provideService(NotionHttpTelemetry, {
      report: (event) =>
        Effect.sync(() => {
          const progressEvent = rateLimitProgressEventFromHttp(event)
          const rateLimit = renderPlainRateLimitProgress(progressEvent)
          if (rateLimit !== undefined) {
            process.stderr.write(`notion db ${command._tag} rate ${rateLimit}\n`)
          }
        }),
    }),
    Effect.tap(() =>
      Effect.sync(() => {
        process.stderr.write(`notion db ${command._tag} complete 100%\n`)
      }),
    ),
  )

const runWithCliSyncProgress = <A, E, R>({
  command,
  effect,
}: {
  readonly command: CliCommand
  readonly effect: Effect.Effect<A, E, R>
}): Effect.Effect<A, E, R> => {
  const loadTuiProgress = Effect.promise(() => import('./progress.ts')).pipe(
    Effect.flatMap((progressModule) =>
      Effect.promise(() => import('@overeng/tui-react')).pipe(
        Effect.flatMap((tuiReact) =>
          Effect.promise(() => import('@overeng/tui-react/node')).pipe(
            Effect.map((tuiReactNode) => ({ progressModule, tuiReact, tuiReactNode })),
          ),
        ),
      ),
    ),
    Effect.result,
  )

  return loadTuiProgress.pipe(
    Effect.flatMap((loaded) => {
      if (loaded._tag === 'Failure') {
        return runWithPlainSyncProgress({ command, effect })
      }
      const { progressModule, tuiReact, tuiReactNode } = loaded.success
      const progressApp = progressModule.createSyncProgressApp(command._tag)
      const progressView = progressModule.createSyncProgressView(progressApp)

      return Effect.scoped(
        progressApp.run(progressView).pipe(
          Effect.flatMap((tui) =>
            effect.pipe(
              Effect.provideService(SyncProgress, {
                report: (event) =>
                  Effect.sync(() => {
                    tui.dispatch({ _tag: 'ApplyEvent', event })
                  }),
              }),
              Effect.provideService(NotionHttpTelemetry, {
                report: (event) =>
                  Effect.sync(() => {
                    tui.dispatch({
                      _tag: 'ApplyEvent',
                      event: rateLimitProgressEventFromHttp(event),
                    })
                  }),
              }),
              Effect.tap(() =>
                Effect.sync(() => {
                  tui.dispatch({
                    _tag: 'ApplyEvent',
                    event: { _tag: 'phase', phase: 'complete' },
                  })
                }),
              ),
            ),
          ),
          Effect.provide(
            Layer.mergeAll(
              tuiReactNode.outputModeLayer('ci-plain'),
              Layer.succeed(tuiReact.ViewOutputStreamTag, process.stderr),
            ),
          ),
        ),
      )
    }),
  )
}

/**
 * Top-level CLI entry point: parses `argv`, rejects unsupported commands early, runs the command,
 * and writes the JSON result to `stdout`. The store is closed via `Effect.ensuring` regardless of outcome.
 *
 * When the module is executed directly (`import.meta.main`), it wires OTel and calls
 * `NodeRuntime.runMain`, writing errors as JSON to `stderr`.
 */
export const runCliMain = ({
  argv,
  options = {},
}: {
  readonly argv: ReadonlyArray<string>
  readonly options?: CliRuntimeOptions
}) =>
  Effect.gen(function* () {
    const completionShell = completionShellFromArgv(argv)
    if (completionShell !== undefined) {
      const completions = yield* renderDatasourceSyncCompletions({
        programName: 'notion db',
        shell: completionShell,
      })
      yield* Effect.sync(() => process.stdout.write(completions))
      return
    }

    if (isVersionArgv(argv) === true) {
      yield* Effect.sync(() => process.stdout.write(`${cliVersion}\n`))
      return
    }

    if (isHelpArgv(argv) === true) {
      yield* Effect.sync(() => process.stdout.write(renderCliHelpText()))
      return
    }

    const command = yield* Effect.try({
      try: () => parseCliCommand(argv),
      // `parseCliCommand` only ever throws `CliArgumentError`; anything else is a
      // programming defect and is surfaced as such rather than an expected failure.
      catch: cliArgumentErrorFromThrow,
    })

    const resolvedCommand = yield* resolveCliCommandNotionRefs({ command, options })
    const context = yield* Effect.try({
      try: () => parseCliContext({ argv, resolvedCommand }),
      // `parseCliContext` runs workspace discovery and can throw the expected
      // workspace errors in addition to `CliArgumentError`; keep them on the
      // failure channel so the top-level renderer emits a structured envelope.
      catch: cliContextErrorFromThrow,
    })
    const commandEffect = runCliCommandWithRuntime({ command: resolvedCommand, context, options })
    const effectWithProgress =
      shouldShowSyncProgress(resolvedCommand) === true
        ? runWithCliSyncProgress({ command: resolvedCommand, effect: commandEffect })
        : commandEffect

    yield* effectWithProgress.pipe(
      Effect.tap((result) => Effect.sync(() => process.stdout.write(renderCliResultJson(result)))),
      Effect.ensuring(Effect.sync(() => context.store.close())),
    )
  })

const serviceNameForArgv = (argv: ReadonlyArray<string>): string => {
  try {
    return serviceNameForCliCommand(parseCliCommand(argv))
  } catch {
    return otelServiceNameForCliArgv(argv)
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  // The CLI vs daemon service NAME is chosen per-subcommand (sync --watch ⇒
  // daemon), then decoded into a branded ServiceIdentity at the edge. The
  // process SHAPE stays `cli` regardless of the name — name is identity, shape
  // is export/flush mechanics.
  const identity = Schema.decodeSync(ServiceIdentity)({
    name: serviceNameForArgv(argv),
    namespace: 'overeng',
    version: cliVersion,
  })
  Effect.gen(function* () {
    const endpoint = yield* otelEndpointFromConfig()
    yield* runCliMain({ argv }).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => process.stderr.write(renderCliErrorJson(error))),
      ),
      Effect.scoped,
      Effect.provide(withTelemetry({ identity, shape: 'cli', endpoint })),
    )
  }).pipe(NodeRuntime.runMain({ disableErrorReporting: true }))
}
