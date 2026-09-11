import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { Schema } from 'effect'

import { NOTION_API_VERSION } from '@overeng/notion-effect-client'

import { pageSurfaceKey, propertySurfaceKey } from '../core/canonical.ts'
import { RemoteWritePlanPayload, type RemoteWriteCommand } from '../core/commands.ts'
import {
  BodyPointer,
  bodyPointerIdentityDigest,
  CapabilityName,
  CommandId,
  DatabaseId,
  DataSourceId,
  Hash,
  type NotionRequestId,
  PageId,
  PropertyId,
  QueryCursor,
  WorkspaceRelativePath,
} from '../core/domain.ts'
import { LocalStoreError } from '../core/errors.ts'
import {
  IdempotencyKey,
  SurfaceKey,
  SyncEvent,
  SyncEventId,
  SyncRootId as SyncRootIdSchema,
  type SyncRootId,
} from '../core/events.ts'
import { GuardName } from '../core/guards.ts'
import {
  SignalExternalId,
  SignalId,
  SignalKind,
  SignalProvider,
  SignalState,
  type ClaimSignalInput,
  type EnqueueSignalInput,
  type ReleaseSignalInput,
  type SettleSignalInput,
  type SignalInboxStatus,
  type SignalInboxRecord,
} from '../core/signals.ts'
import type { PlannerProjectionSnapshot } from '../planner/planner.ts'
import {
  computePayloadHash,
  computeProjectionDigest,
  DataSourceProjectionPayload,
  BodyProjectionPayload,
  isCompactionBlockingOutboxState,
  OutboxState,
  PropertyCheckpointProjectionPayload,
  QueryAbsenceProjectionPayload,
  QueryCheckpointProjectionPayload,
  RowProjectionPayload,
  type ProjectionDigestInput,
} from './projections.ts'
import {
  clearProjectionTablesSql,
  createStoreSchemaSql,
  PROJECTOR_VERSION,
  rootScopedProjectionTables,
  STORE_SCHEMA_VERSION,
} from './schema.ts'

type SqlRow = Record<string, unknown>

/** Active SQLite PRAGMA values read back after the store is opened. */
export type SqliteStoreSettings = {
  readonly journalMode: string
  readonly foreignKeys: boolean
  readonly busyTimeoutMs: number
}

/** Options for opening or creating a `NotionSyncStore`. `now` is injectable for deterministic testing. */
export type OpenNotionSyncStoreOptions = {
  readonly path: string
  readonly busyTimeoutMs?: number
  readonly now?: () => Date
}

/** Record in `_nds_projection_metadata` tracking the projector version and event sequence at which a projection was last rebuilt. */
export type ProjectionMetadata = {
  readonly rootId: SyncRootId
  readonly projectorVersion: string
  readonly highWaterSequence: bigint
  readonly digest: Hash
}

/** A row from the `_nds_outbox` projection table, representing a pending or settled remote-write command. */
export type OutboxProjectionRow = {
  readonly commandId: string
  readonly commandKey: string
  readonly intentEventId: string
  readonly surface: string | undefined
  readonly commandTag: string
  readonly state: OutboxState
  readonly baseHash: string | undefined
  readonly desiredHash: string | undefined
  readonly attemptCount: number
  readonly leaseToken: string | undefined
  readonly settlementEventId: string | undefined
}

/** A row from `_nds_conflict`, representing an open or resolved three-way sync conflict. */
export type ConflictProjectionRow = {
  readonly conflictId: SyncEventId
  readonly pageId: PageId | undefined
  readonly propertyId: PropertyId | undefined
  readonly surface: SurfaceKey | undefined
  readonly state: 'open' | 'resolving' | 'resolved' | 'superseded' | 'ignored'
  readonly kind:
    | 'same-property'
    | 'property'
    | 'body'
    | 'schema'
    | 'delete-vs-edit'
    | 'lifecycle'
    | 'path'
    | 'relation'
    | 'permission'
    | undefined
  readonly baseHash: Hash | undefined
  readonly localHash: Hash | undefined
  readonly remoteHash: Hash | undefined
  /** Remote trash target for `lifecycle` conflicts; `undefined` for other kinds. The local target `L` is recoverable as `!remoteInTrash`. */
  readonly remoteInTrash: boolean | undefined
  readonly message: string | undefined
  readonly openedEventId: SyncEventId
  readonly resolutionEventId: SyncEventId | undefined
}

/** A row from `_nds_guard_block`, representing an active guard block that halted sync progress. */
export type GuardBlockProjectionRow = {
  readonly blockId: string
  readonly surface: SurfaceKey | undefined
  readonly guard: GuardName
  readonly message: string
  readonly eventId: SyncEventId
}

/** A row from `_nds_tombstone`, representing a page classified as deleted or moved out of the tracked data source. */
export type TombstoneProjectionRow = {
  readonly pageId: PageId
  readonly classification:
    | 'unclassified'
    | 'remote_trash'
    | 'moved_out'
    | 'moved_between_tracked_sources'
    | 'inaccessible'
    | 'unknown'
  readonly reason: string
  readonly eventId: SyncEventId
}

/** A row from `_nds_query_scan_checkpoint` tracking pagination state for an ongoing or completed data-source query scan. */
export type QueryCheckpointRow = {
  readonly dataSourceId: DataSourceId
  readonly queryContractHash: Hash
  readonly nextCursor: QueryCursor | null
  readonly complete: boolean
  readonly cappedAtLimit: boolean
  readonly contractChanged: boolean
  readonly highWatermark: typeof Schema.DateTimeUtcFromString.Type | null
  readonly eventId: SyncEventId
}

/** Parameters for atomically claiming an _nds_outbox command for execution under a _nds_lease. */
export type OutboxClaimOptions = {
  readonly rootId: SyncRootId
  readonly leaseToken: string
  readonly leaseDurationMs: number
}

/** An _nds_outbox command that has been atomically claimed for execution, including its decoded payload and the attempt event already written to the log. */
export type ClaimedOutboxCommand = {
  readonly rootId: SyncRootId
  readonly commandId: CommandId
  readonly commandKey: IdempotencyKey
  readonly intentEventId: SyncEventId
  readonly surface: SurfaceKey
  readonly commandTag: string
  readonly command: RemoteWriteCommand | undefined
  readonly baseHash: Hash | undefined
  readonly desiredHash: Hash
  readonly preflight: ReadonlyArray<GuardName>
  readonly attempt: number
  readonly leaseToken: string
  readonly previousState: OutboxState
  readonly attemptState: Extract<
    OutboxState,
    'running' | 'retryable' | 'blocked' | 'fenced' | 'ambiguous'
  >
  readonly attemptEvent: Extract<SyncEvent, { readonly _tag: 'RemoteWriteAttempted' }>
}

/** Input for recording the mid-flight state of an _nds_outbox command attempt (running, retryable, blocked, fenced, ambiguous). */
export type OutboxAttemptStateInput = {
  readonly rootId: SyncRootId
  readonly commandId: CommandId
  readonly commandKey: IdempotencyKey
  readonly surface: SurfaceKey
  readonly attempt: number
  readonly attemptState: Extract<
    OutboxState,
    'running' | 'retryable' | 'blocked' | 'fenced' | 'ambiguous'
  >
  readonly leaseToken?: string
  readonly guard?: GuardName
  readonly retryAfterMillis?: number
  readonly idempotencyKey?: IdempotencyKey
}

/** Input for marking an _nds_outbox command as successfully settled after a verified remote write. */
export type OutboxSettlementInput = {
  readonly rootId: SyncRootId
  readonly commandId: CommandId
  readonly commandKey: IdempotencyKey
  readonly surface: SurfaceKey
  readonly commandTag: string
  readonly requestId: NotionRequestId
  readonly desiredHash: Hash
  readonly observedHash: Hash
  readonly bodyPointer?: BodyPointer
  readonly createdPageId?: PageId
  readonly settlementKind: 'verified-success' | 'verified-no-op'
  readonly idempotencyKey?: IdempotencyKey
}

/** A guard-identified reason why compaction cannot proceed right now. */
export type CompactionBlocker = {
  readonly guard: GuardName
  readonly message: string
}

/** Tagged union indicating whether event-log compaction may proceed or is blocked by in-flight _nds_outbox commands. */
export type CompactionDecision =
  | { readonly _tag: 'allowed' }
  | { readonly _tag: 'blocked'; readonly blockers: readonly CompactionBlocker[] }

/** Aggregated health summary across all projection tables, used for status reporting and liveness checks. */
export type StoreStatusProjection = {
  readonly outbox: {
    readonly queued: number
    readonly running: number
    readonly retryable: number
    readonly blocked: number
    readonly settled: number
    readonly fenced: number
    readonly ambiguous: number
  }
  readonly conflicts: {
    readonly open: number
  }
  readonly tombstones: {
    readonly unclassified: number
  }
  readonly guards: {
    readonly blocked: number
  }
  readonly capabilities: {
    readonly unsupported: number
  }
  readonly checkpoints: {
    readonly incompleteQueries: number
    readonly cappedQueries: number
    readonly changedQueryContracts: number
    readonly incompleteProperties: number
  }
  readonly projections: {
    readonly dataSources: number
    readonly rows: number
    readonly properties: number
    readonly bodies: number
  }
  readonly signals: SignalInboxStatus
}

/** Stored binding between a self-contained SQLite replica and its Notion sync root. */
export type WorkspaceBindingRow = {
  readonly rootId: SyncRootId
  readonly dataSourceId: DataSourceId
  readonly databaseId: DatabaseId | undefined
  readonly workspaceRoot: string
  readonly storeIdentity: string
}

const decodeEventFromJson = Schema.decodeSync(Schema.fromJsonString(SyncEvent))
const encodeEvent = Schema.encodeSync(SyncEvent)
const decodeCapabilityName = Schema.decodeUnknownSync(CapabilityName)
const decodeDataSourceId = Schema.decodeSync(DataSourceId)
const decodeDatabaseId = Schema.decodeSync(DatabaseId)
const decodeHash = Schema.decodeSync(Hash)
const decodeIdempotencyKey = Schema.decodeUnknownSync(IdempotencyKey)
const decodePageId = Schema.decodeSync(PageId)
const decodePropertyId = Schema.decodeSync(PropertyId)
const decodeQueryCursor = Schema.decodeSync(QueryCursor)
const decodeWorkspaceRelativePath = Schema.decodeUnknownSync(WorkspaceRelativePath)
const decodeRemoteWritePlanPayload = Schema.decodeUnknownSync(
  Schema.fromJsonString(RemoteWritePlanPayload),
)
const decodeSurfaceKey = Schema.decodeUnknownSync(SurfaceKey)
const decodeSyncEventId = Schema.decodeSync(SyncEventId)
const decodeDataSourceProjectionPayload = Schema.decodeUnknownSync(
  Schema.fromJsonString(DataSourceProjectionPayload),
)
const decodeRowProjectionPayload = Schema.decodeUnknownSync(
  Schema.fromJsonString(RowProjectionPayload),
)
const decodeBodyProjectionPayload = Schema.decodeUnknownSync(
  Schema.fromJsonString(BodyProjectionPayload),
)
const encodeBodyProjectionPayload = Schema.encodeSync(BodyProjectionPayload)
const encodeBodyPointer = Schema.encodeSync(BodyPointer)
const decodePropertyCheckpointProjectionPayload = Schema.decodeUnknownSync(
  Schema.fromJsonString(PropertyCheckpointProjectionPayload),
)
const decodeQueryCheckpointProjectionPayload = Schema.decodeUnknownSync(
  Schema.fromJsonString(QueryCheckpointProjectionPayload),
)
const decodeQueryAbsenceProjectionPayload = Schema.decodeUnknownSync(
  Schema.fromJsonString(QueryAbsenceProjectionPayload),
)
const decodeConflictPayloadMessage = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ message: Schema.optional(Schema.String) })),
)

const projectionName = 'core'

const decodePayload = <TValue>({
  event,
  decode,
}: {
  readonly event: SyncEvent
  readonly decode: (value: unknown) => TValue
}): TValue | undefined => {
  try {
    return decode(event.payload.canonicalJson)
  } catch {
    return undefined
  }
}

const parsePropertySurface = (
  surface: string | undefined,
): { readonly pageId: string; readonly propertyId: string } | undefined => {
  if (surface === undefined) return undefined
  const match = /^page:([^:]+):property:(.+)$/.exec(surface)
  if (match === null) return undefined

  return { pageId: match[1]!, propertyId: match[2]! }
}

const readString = ({ row, key }: { readonly row: SqlRow; readonly key: string }): string => {
  const value = row[key]
  if (typeof value === 'string') return value
  throw new LocalStoreError({
    operation: 'read-sqlite-row',
    message: `Expected SQLite column ${key} to be a string`,
  })
}

const readOptionalString = ({
  row,
  key,
}: {
  readonly row: SqlRow
  readonly key: string
}): string | undefined => {
  const value = row[key]
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string') return value
  throw new LocalStoreError({
    operation: 'read-sqlite-row',
    message: `Expected SQLite column ${key} to be a string when present`,
  })
}

const readInteger = ({ row, key }: { readonly row: SqlRow; readonly key: string }): bigint => {
  const value = row[key]
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isInteger(value) === true) return BigInt(value)
  throw new LocalStoreError({
    operation: 'read-sqlite-row',
    message: `Expected SQLite column ${key} to be an integer`,
  })
}

const readBoolean = ({ row, key }: { readonly row: SqlRow; readonly key: string }): boolean => {
  const value = row[key]
  if (value === 0 || value === 0n) return false
  if (value === 1 || value === 1n) return true
  throw new LocalStoreError({
    operation: 'read-sqlite-row',
    message: `Expected SQLite column ${key} to be a boolean integer`,
  })
}

const readOutboxState = ({
  row,
  key,
}: {
  readonly row: SqlRow
  readonly key: string
}): OutboxState => Schema.decodeUnknownSync(OutboxState)(readString({ row, key }))

/**
 * The non-empty `pendingLocal` projection the store hands to the planner for a
 * single `(pageId, propertyId)`. Anchored to the planner's `PropertySurfaceSnapshot`
 * so the carried `state` stays the single source of truth for the settlement gate.
 */
type PropertyPendingLocalIntent = NonNullable<
  PlannerProjectionSnapshot['properties'][number]['pendingLocal']
>

const readConflictState = ({
  row,
  key,
}: {
  readonly row: SqlRow
  readonly key: string
}): ConflictProjectionRow['state'] =>
  Schema.decodeUnknownSync(
    Schema.Literals(['open', 'resolving', 'resolved', 'superseded', 'ignored']),
  )(readString({ row, key }))

const readTombstoneClassification = ({
  row,
  key,
}: {
  readonly row: SqlRow
  readonly key: string
}): TombstoneProjectionRow['classification'] =>
  Schema.decodeUnknownSync(
    Schema.Literals([
      'unclassified',
      'remote_trash',
      'moved_out',
      'moved_between_tracked_sources',
      'inaccessible',
      'unknown',
    ]),
  )(readString({ row, key }))

const readSignalState = ({
  row,
  key,
}: {
  readonly row: SqlRow
  readonly key: string
}): SignalState => Schema.decodeUnknownSync(SignalState)(readString({ row, key }))

const readCount = ({
  row,
  key,
}: {
  readonly row: SqlRow | undefined
  readonly key: string
}): number => (row === undefined ? 0 : Number(readInteger({ row, key })))

const stringifyJson = (value: unknown): string => JSON.stringify(value)

const currentIso = (now: () => Date): string => now().toISOString()

const eventPayload = (canonicalJson: string): SyncEvent['payload'] => ({
  _tag: 'VersionedJson',
  codecVersion: 'v1',
  canonicalJson,
})

const makeEventId = (parts: ReadonlyArray<string | number>): SyncEventId =>
  decodeSyncEventId(parts.map((part) => String(part).replaceAll(':', '-')).join(':'))

const decodePlanCommand = (event: SyncEvent): RemoteWriteCommand | undefined =>
  decodePayload({ event: event, decode: decodeRemoteWritePlanPayload })?.command

const assertSupportedSchemaVersion = (db: DatabaseSync): void => {
  const migrationHistoryTable = db
    .prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table' AND name = '_nds_migration_history'`,
    )
    .get()

  if (migrationHistoryTable === undefined) return

  const latestKnownMigration = db
    .prepare(
      `SELECT MAX(schema_version) AS schema_version
       FROM _nds_migration_history`,
    )
    .get()
  const schemaVersion = latestKnownMigration?.schema_version

  if (schemaVersion === null || schemaVersion === undefined) return

  if (typeof schemaVersion !== 'bigint' && typeof schemaVersion !== 'number') {
    throw new LocalStoreError({
      operation: 'run-migrations',
      message: `Store schema version is unknown; refusing to migrate to supported version ${STORE_SCHEMA_VERSION}`,
    })
  }

  if (schemaVersion > STORE_SCHEMA_VERSION) {
    throw new LocalStoreError({
      operation: 'run-migrations',
      message: `Store schema version ${schemaVersion.toString()} is newer than supported version ${STORE_SCHEMA_VERSION}`,
    })
  }
}

const preflightMigrationSafety = (path: string): void => {
  if (path === ':memory:' || existsSync(path) === false) return

  const db = new DatabaseSync(path, { readOnly: true, readBigInts: true })
  try {
    assertSupportedSchemaVersion(db)
  } finally {
    db.close()
  }
}

const capabilityProjectionIsScopedByDataSource = (db: DatabaseSync): boolean =>
  db
    .prepare(`PRAGMA table_info('_nds_capability')`)
    .all()
    .some((row) => row.name === 'data_source_id' && Number(row.pk) > 0)

const bodyPointerProjectionStoresProjectionPayload = (db: DatabaseSync): boolean =>
  db
    .prepare(`PRAGMA table_info('_nds_body_pointer')`)
    .all()
    .some((row) => row.name === 'body_projection_json')

/**
 * True when the `_nds_conflict` CHECK constraint already admits the `resolving`
 * state (schema v8, #775 M2a'-2). Existing stores created with `CREATE TABLE IF
 * NOT EXISTS` keep their old CHECK, which rejects `resolving` writes, so the open
 * path must recreate the (pure-projection) table and replay.
 */
const conflictProjectionAdmitsResolving = (db: DatabaseSync): boolean => {
  const row = db
    .prepare(`SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = '_nds_conflict'`)
    .get()
  const sql = row === undefined ? undefined : readOptionalString({ row, key: 'sql' })
  return sql !== undefined && sql.includes("'resolving'")
}

/**
 * SQLite-backed store for the notion-datasource-sync event log and projections.
 *
 * Holds the append-only `_nds_sync_event` log plus all derived projection tables.
 * Runs migrations on open and exposes synchronous read/write methods used by
 * the sync engine. Opened via `openNotionSyncStore`.
 */
export class NotionSyncStore {
  readonly #db: DatabaseSync
  readonly #now: () => Date
  readonly settings: SqliteStoreSettings

  constructor(options: OpenNotionSyncStoreOptions) {
    const busyTimeoutMs = options.busyTimeoutMs ?? 5_000
    preflightMigrationSafety(options.path)
    this.#now = options.now ?? (() => new Date())
    this.#db = new DatabaseSync(options.path, {
      enableForeignKeyConstraints: true,
      timeout: busyTimeoutMs,
      readBigInts: true,
    })

    this.#db.exec('PRAGMA foreign_keys = ON')
    this.#db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`)

    try {
      this.#runMigrations()
    } catch (cause) {
      this.#db.close()
      throw cause
    }

    const journalModeRow = this.#db.prepare('PRAGMA journal_mode = WAL').get() ?? {}
    const foreignKeysRow = this.#db.prepare('PRAGMA foreign_keys').get() ?? {}

    this.settings = {
      journalMode: String(
        journalModeRow.journal_mode ?? journalModeRow['journal_mode = WAL'] ?? '',
      ),
      foreignKeys: readBoolean({
        row: { enabled: foreignKeysRow.foreign_keys ?? 0 },
        key: 'enabled',
      }),
      busyTimeoutMs,
    }
  }

  close(): void {
    this.#db.close()
  }

  appendEvent(event: SyncEvent): SyncEvent {
    return this.appendEventWithResult(event).event
  }

  appendEventWithResult(event: SyncEvent): {
    readonly event: SyncEvent
    readonly inserted: boolean
  } {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const result = this.#appendEventWithResultInTransaction(event)
      this.#db.exec('COMMIT')
      return result
    } catch (cause) {
      this.#db.exec('ROLLBACK')
      throw cause
    }
  }

  claimNextOutboxCommand(options: OutboxClaimOptions): ClaimedOutboxCommand | undefined {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#ensureRoot(options.rootId)
      const leaseCutoff = new Date(this.#now().getTime() - options.leaseDurationMs).toISOString()
      const row = this.#db
        .prepare(
          `SELECT
             _nds_outbox.command_id,
             _nds_outbox.command_key,
             _nds_outbox.intent_event_id,
             _nds_outbox.surface,
             _nds_outbox.command_tag,
             _nds_outbox.state,
             _nds_outbox.base_hash,
             _nds_outbox.desired_hash,
             _nds_outbox.preflight_json,
             _nds_outbox.attempt_count,
             _nds_outbox.retry_after_at,
             _nds_outbox.updated_at,
             event.event_json
           FROM _nds_outbox
           JOIN _nds_sync_event event
             ON event.root_id = _nds_outbox.root_id
            AND event.idempotency_key = _nds_outbox.command_key
            AND event.event_type = 'RemoteWritePlanned'
           WHERE _nds_outbox.root_id = ?
             AND _nds_outbox.settlement_event_id IS NULL
             AND (
               _nds_outbox.state IN ('queued', 'ambiguous')
               OR (_nds_outbox.state = 'retryable'
                   AND (_nds_outbox.retry_after_at IS NULL OR _nds_outbox.retry_after_at <= ?))
               OR (_nds_outbox.state = 'running' AND _nds_outbox.updated_at <= ?)
             )
           ORDER BY _nds_outbox.updated_at, _nds_outbox.command_id
           LIMIT 1`,
        )
        .get(options.rootId, currentIso(this.#now), leaseCutoff)

      if (row === undefined) {
        this.#db.exec('COMMIT')
        return undefined
      }

      const previousState = readOutboxState({ row: row, key: 'state' })
      const attempt = Number(readInteger({ row: row, key: 'attempt_count' })) + 1
      const attemptState = previousState === 'running' ? 'ambiguous' : 'running'
      const commandId = readString({ row: row, key: 'command_id' })
      const commandKey = decodeIdempotencyKey(readString({ row: row, key: 'command_key' }))
      const surface = decodeSurfaceKey(readString({ row: row, key: 'surface' }))
      const plannedEvent = decodeEventFromJson(readString({ row: row, key: 'event_json' }))
      const attemptEvent = this.#appendOutboxAttemptStateInTransaction({
        rootId: options.rootId,
        commandId: Schema.decodeSync(CommandId)(commandId),
        commandKey,
        surface,
        attempt,
        attemptState,
        leaseToken: options.leaseToken,
        idempotencyKey: decodeIdempotencyKey(`attempt:${commandId}:${attempt}`),
      })

      this.#db.exec('COMMIT')

      return {
        rootId: options.rootId,
        commandId: Schema.decodeSync(CommandId)(commandId),
        commandKey,
        intentEventId: decodeSyncEventId(readString({ row: row, key: 'intent_event_id' })),
        surface,
        commandTag: readString({ row: row, key: 'command_tag' }),
        command: decodePlanCommand(plannedEvent),
        baseHash:
          readOptionalString({ row: row, key: 'base_hash' }) === undefined
            ? undefined
            : decodeHash(readString({ row: row, key: 'base_hash' })),
        desiredHash: decodeHash(readString({ row: row, key: 'desired_hash' })),
        preflight: Schema.decodeSync(Schema.fromJsonString(Schema.Array(GuardName)))(
          readString({ row: row, key: 'preflight_json' }),
        ),
        attempt,
        leaseToken: options.leaseToken,
        previousState,
        attemptState,
        attemptEvent,
      }
    } catch (cause) {
      this.#db.exec('ROLLBACK')
      throw cause
    }
  }

  isOutboxLeaseActive({
    rootId,
    commandId,
    leaseToken,
  }: {
    readonly rootId: SyncRootId
    readonly commandId: CommandId
    readonly leaseToken: string
  }): boolean {
    const row = this.#db
      .prepare(
        `SELECT state, lease_token, settlement_event_id
         FROM _nds_outbox
         WHERE root_id = ? AND command_id = ?`,
      )
      .get(rootId, commandId)

    return (
      row !== undefined &&
      readOutboxState({ row: row, key: 'state' }) === 'running' &&
      readOptionalString({ row: row, key: 'lease_token' }) === leaseToken &&
      readOptionalString({ row: row, key: 'settlement_event_id' }) === undefined
    )
  }

  appendOutboxAttemptState(input: OutboxAttemptStateInput): SyncEvent {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const event = this.#appendOutboxAttemptStateInTransaction(input)
      this.#db.exec('COMMIT')
      return event
    } catch (cause) {
      this.#db.exec('ROLLBACK')
      throw cause
    }
  }

  appendOutboxSettlement(input: OutboxSettlementInput): SyncEvent {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const bodyPointer =
        input.bodyPointer === undefined ? undefined : encodeBodyPointer(input.bodyPointer)
      const event = this.#appendEventInTransaction(
        Schema.decodeSync(SyncEvent)({
          _tag: 'RemoteWriteSettled',
          eventId: makeEventId(['settled', input.commandId, input.settlementKind]),
          rootId: input.rootId,
          sequence: '0',
          codecVersion: 'v1',
          family: 'CommandSettled',
          eventType: 'RemoteWriteSettled',
          idempotencyKey: input.idempotencyKey ?? `settled:${input.commandId}`,
          surface: input.surface,
          causedByEventIds: [],
          payloadHash: decodeHash('sha256:'.padEnd(71, '0')),
          payload: eventPayload(
            stringifyJson({
              commandId: input.commandId,
              settlementKind: input.settlementKind,
              desiredHash: input.desiredHash,
              observedHash: input.observedHash,
              ...(bodyPointer === undefined ? {} : { bodyPointer }),
              ...(input.createdPageId === undefined ? {} : { createdPageId: input.createdPageId }),
            }),
          ),
          observedAt: currentIso(this.#now),
          commandId: input.commandId,
          commandTag: input.commandTag,
          requestId: input.requestId,
          desiredHash: input.desiredHash,
          observedHash: input.observedHash,
          ...(input.createdPageId === undefined ? {} : { createdPageId: input.createdPageId }),
          ...(bodyPointer === undefined ? {} : { bodyPointer }),
          settlementKind: input.settlementKind,
        }),
      )
      this.#db.exec('COMMIT')
      return event
    } catch (cause) {
      this.#db.exec('ROLLBACK')
      throw cause
    }
  }

  replay(rootId: SyncRootId): readonly SyncEvent[] {
    return this.#eventRows(rootId).map((row) =>
      decodeEventFromJson(readString({ row: row, key: 'event_json' })),
    )
  }

  clearProjectionTables(): void {
    this.#db.exec(clearProjectionTablesSql)
  }

  rebuildProjections(rootId: SyncRootId): ProjectionMetadata {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const metadata = this.#rebuildProjectionsInTransaction(rootId)
      this.#db.exec('COMMIT')
      return metadata
    } catch (cause) {
      this.#db.exec('ROLLBACK')
      throw cause
    }
  }

  readProjectionMetadata(rootId: SyncRootId): ProjectionMetadata | undefined {
    const row = this.#db
      .prepare(
        `SELECT root_id, projector_version, high_water_sequence, digest
         FROM _nds_projection_metadata
         WHERE root_id = ? AND projection_name = ?`,
      )
      .get(rootId, projectionName)

    if (row === undefined) return undefined

    return {
      rootId,
      projectorVersion: readString({ row: row, key: 'projector_version' }),
      highWaterSequence: readInteger({ row: row, key: 'high_water_sequence' }),
      digest: decodeHash(readString({ row: row, key: 'digest' })),
    }
  }

  readWorkspaceBinding(rootId: SyncRootId): WorkspaceBindingRow | undefined {
    const row = this.#db
      .prepare(
        `SELECT root_id, data_source_id, database_id, workspace_root, store_identity
         FROM _nds_workspace_binding
         WHERE root_id = ?`,
      )
      .get(rootId)

    if (row === undefined) return undefined

    return {
      rootId,
      dataSourceId: decodeDataSourceId(readString({ row, key: 'data_source_id' })),
      databaseId:
        readOptionalString({ row, key: 'database_id' }) === undefined
          ? undefined
          : decodeDatabaseId(readString({ row, key: 'database_id' })),
      workspaceRoot: readString({ row, key: 'workspace_root' }),
      storeIdentity: readString({ row, key: 'store_identity' }),
    }
  }

  readQueryCheckpoint(input: {
    readonly rootId: SyncRootId
    readonly dataSourceId: DataSourceId
    readonly queryContractHash: Hash
  }): QueryCheckpointRow | undefined {
    const row = this.#db
      .prepare(
        `SELECT data_source_id,
                query_contract_hash,
                next_cursor,
                complete,
                capped_at_limit,
                contract_changed,
                high_watermark,
                event_id
         FROM _nds_query_scan_checkpoint
         WHERE root_id = ?
           AND data_source_id = ?
           AND query_contract_hash = ?`,
      )
      .get(input.rootId, input.dataSourceId, input.queryContractHash)

    if (row === undefined) return undefined

    const nextCursor = readOptionalString({ row: row, key: 'next_cursor' })
    const highWatermark = readOptionalString({ row: row, key: 'high_watermark' })

    return {
      dataSourceId: decodeDataSourceId(readString({ row: row, key: 'data_source_id' })),
      queryContractHash: decodeHash(readString({ row: row, key: 'query_contract_hash' })),
      nextCursor: nextCursor === undefined ? null : decodeQueryCursor(nextCursor),
      complete: readBoolean({ row: row, key: 'complete' }),
      cappedAtLimit: readBoolean({ row: row, key: 'capped_at_limit' }),
      contractChanged: readBoolean({ row: row, key: 'contract_changed' }),
      highWatermark:
        highWatermark === undefined
          ? null
          : Schema.decodeSync(Schema.DateTimeUtcFromString)(highWatermark),
      eventId: decodeSyncEventId(readString({ row: row, key: 'event_id' })),
    }
  }

  readLatestCompleteQueryCheckpoint(input: {
    readonly rootId: SyncRootId
    readonly dataSourceId: DataSourceId
  }): QueryCheckpointRow | undefined {
    const row = this.#db
      .prepare(
        `SELECT data_source_id,
                query_contract_hash,
                next_cursor,
                complete,
                capped_at_limit,
                contract_changed,
                high_watermark,
                event_id
         FROM _nds_query_scan_checkpoint
         WHERE root_id = ?
           AND data_source_id = ?
           AND complete = 1
           AND capped_at_limit = 0
           AND contract_changed = 0
           AND high_watermark IS NOT NULL
         ORDER BY high_watermark DESC, updated_at DESC
         LIMIT 1`,
      )
      .get(input.rootId, input.dataSourceId)

    if (row === undefined) return undefined

    const nextCursor = readOptionalString({ row: row, key: 'next_cursor' })
    const highWatermark = readOptionalString({ row: row, key: 'high_watermark' })

    return {
      dataSourceId: decodeDataSourceId(readString({ row: row, key: 'data_source_id' })),
      queryContractHash: decodeHash(readString({ row: row, key: 'query_contract_hash' })),
      nextCursor: nextCursor === undefined ? null : decodeQueryCursor(nextCursor),
      complete: readBoolean({ row: row, key: 'complete' }),
      cappedAtLimit: readBoolean({ row: row, key: 'capped_at_limit' }),
      contractChanged: readBoolean({ row: row, key: 'contract_changed' }),
      highWatermark:
        highWatermark === undefined
          ? null
          : Schema.decodeSync(Schema.DateTimeUtcFromString)(highWatermark),
      eventId: decodeSyncEventId(readString({ row: row, key: 'event_id' })),
    }
  }

  computeCurrentProjectionDigest(rootId: SyncRootId): Hash {
    return computeProjectionDigest(this.#projectionDigestInputs(rootId))
  }

  readOutbox(rootId: SyncRootId): readonly OutboxProjectionRow[] {
    return this.#db
      .prepare(
        `SELECT
           command_id,
           command_key,
           intent_event_id,
           surface,
           command_tag,
           state,
           base_hash,
           desired_hash,
           attempt_count,
           lease_token,
           settlement_event_id
         FROM _nds_outbox
         WHERE root_id = ?
         ORDER BY command_id`,
      )
      .all(rootId)
      .map((row) => ({
        commandId: readString({ row: row, key: 'command_id' }),
        commandKey: readString({ row: row, key: 'command_key' }),
        intentEventId: readString({ row: row, key: 'intent_event_id' }),
        surface: readOptionalString({ row: row, key: 'surface' }),
        commandTag: readString({ row: row, key: 'command_tag' }),
        state: readOutboxState({ row: row, key: 'state' }),
        baseHash: readOptionalString({ row: row, key: 'base_hash' }),
        desiredHash: readOptionalString({ row: row, key: 'desired_hash' }),
        attemptCount: Number(readInteger({ row: row, key: 'attempt_count' })),
        leaseToken: readOptionalString({ row: row, key: 'lease_token' }),
        settlementEventId: readOptionalString({ row: row, key: 'settlement_event_id' }),
      }))
  }

  enqueueSignal(input: EnqueueSignalInput): {
    readonly signal: SignalInboxRecord
    readonly inserted: boolean
  } {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#ensureRoot(input.rootId)
      const existing = this.#db
        .prepare(
          `SELECT *
           FROM _nds_signal_inbox
           WHERE root_id = ? AND provider = ? AND external_id = ?`,
        )
        .get(input.rootId, input.provider, input.externalId)

      if (existing !== undefined) {
        this.#db.exec('COMMIT')
        return {
          signal: this.#signalRecord({ rootId: input.rootId, row: existing }),
          inserted: false,
        }
      }

      const now = currentIso(this.#now)
      this.#db
        .prepare(
          `INSERT INTO _nds_signal_inbox (
             root_id,
             signal_id,
             provider,
             external_id,
             kind,
             payload_json,
             data_source_id,
             page_id,
             state,
             attempt_count,
             created_at,
             updated_at
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
        )
        .run(
          input.rootId,
          input.signalId,
          input.provider,
          input.externalId,
          input.kind ?? 'remote-change',
          input.payloadJson ?? '{}',
          input.dataSourceId ?? null,
          input.pageId ?? null,
          now,
          now,
        )

      const row = this.#db
        .prepare(
          `SELECT *
           FROM _nds_signal_inbox
           WHERE root_id = ? AND signal_id = ?`,
        )
        .get(input.rootId, input.signalId)

      if (row === undefined) {
        throw new LocalStoreError({
          operation: 'enqueue-signal',
          message: `Signal ${input.signalId} was not readable after insert`,
        })
      }

      this.#db.exec('COMMIT')
      return { signal: this.#signalRecord({ rootId: input.rootId, row }), inserted: true }
    } catch (cause) {
      this.#db.exec('ROLLBACK')
      throw cause
    }
  }

  claimNextSignal(input: ClaimSignalInput): SignalInboxRecord | undefined {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#ensureRoot(input.rootId)
      const now = currentIso(this.#now)
      const leaseCutoff = new Date(
        this.#now().getTime() - (input.leaseDurationMs ?? 60_000),
      ).toISOString()
      const candidate = this.#db
        .prepare(
          `SELECT *
           FROM _nds_signal_inbox
           WHERE root_id = ?
             AND (
               state = 'pending'
               OR (state = 'claimed' AND claimed_at <= ?)
             )
           ORDER BY updated_at, signal_id
           LIMIT 1`,
        )
        .get(input.rootId, leaseCutoff)

      if (candidate === undefined) {
        this.#db.exec('COMMIT')
        return undefined
      }

      const signalId = readString({ row: candidate, key: 'signal_id' })
      this.#db
        .prepare(
          `UPDATE _nds_signal_inbox
           SET state = 'claimed',
               attempt_count = attempt_count + 1,
               lease_token = ?,
               claimed_at = ?,
               processed_at = NULL,
               updated_at = ?
           WHERE root_id = ? AND signal_id = ?`,
        )
        .run(input.leaseToken, now, now, input.rootId, signalId)

      const row = this.#db
        .prepare(
          `SELECT *
           FROM _nds_signal_inbox
           WHERE root_id = ? AND signal_id = ?`,
        )
        .get(input.rootId, signalId)

      if (row === undefined) {
        throw new LocalStoreError({
          operation: 'claim-signal',
          message: `Signal ${signalId} was not readable after claim`,
        })
      }

      this.#db.exec('COMMIT')
      return this.#signalRecord({ rootId: input.rootId, row })
    } catch (cause) {
      this.#db.exec('ROLLBACK')
      throw cause
    }
  }

  settleSignal(input: SettleSignalInput): void {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const now = currentIso(this.#now)
      this.#db
        .prepare(
          `UPDATE _nds_signal_inbox
           SET state = 'processed',
               lease_token = NULL,
               processed_at = ?,
               last_error = NULL,
               updated_at = ?
           WHERE root_id = ?
             AND signal_id = ?
             AND state = 'claimed'
             AND lease_token = ?`,
        )
        .run(now, now, input.rootId, input.signalId, input.leaseToken)
      this.#db.exec('COMMIT')
    } catch (cause) {
      this.#db.exec('ROLLBACK')
      throw cause
    }
  }

  releaseSignal(input: ReleaseSignalInput): void {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const now = currentIso(this.#now)
      this.#db
        .prepare(
          `UPDATE _nds_signal_inbox
           SET state = ?,
               lease_token = NULL,
               last_error = ?,
               updated_at = ?
           WHERE root_id = ?
             AND signal_id = ?
             AND state = 'claimed'
             AND lease_token = ?`,
        )
        .run(
          input.failed === true ? 'failed' : 'pending',
          input.error,
          now,
          input.rootId,
          input.signalId,
          input.leaseToken,
        )
      this.#db.exec('COMMIT')
    } catch (cause) {
      this.#db.exec('ROLLBACK')
      throw cause
    }
  }

  readSignals(rootId: SyncRootId): readonly SignalInboxRecord[] {
    return this.#db
      .prepare(
        `SELECT *
         FROM _nds_signal_inbox
         WHERE root_id = ?
         ORDER BY created_at, signal_id`,
      )
      .all(rootId)
      .map((row) => this.#signalRecord({ rootId, row }))
  }

  readSignalStatus(rootId: SyncRootId): SignalInboxStatus {
    const rows = this.#db
      .prepare(
        `SELECT state, COUNT(*) AS count
         FROM _nds_signal_inbox
         WHERE root_id = ?
         GROUP BY state`,
      )
      .all(rootId)
    const status = { pending: 0, claimed: 0, processed: 0, failed: 0 } satisfies SignalInboxStatus

    for (const row of rows) {
      status[readSignalState({ row, key: 'state' })] = Number(readInteger({ row, key: 'count' }))
    }

    return status
  }

  readConflicts(rootId: SyncRootId): readonly ConflictProjectionRow[] {
    return this.#db
      .prepare(
        `SELECT
           conflict.conflict_id,
           conflict.page_id,
           conflict.property_id,
           conflict.state,
           conflict.base_hash,
           conflict.local_hash,
           conflict.remote_hash,
           conflict.opened_event_id,
           conflict.resolution_event_id,
           opened.event_json
         FROM _nds_conflict conflict
         JOIN _nds_sync_event opened
           ON opened.root_id = conflict.root_id
          AND opened.event_id = conflict.opened_event_id
         WHERE conflict.root_id = ?
         ORDER BY conflict.state, conflict.page_id, conflict.property_id, conflict.conflict_id`,
      )
      .all(rootId)
      .map((row) => {
        const openedEvent = decodeEventFromJson(readString({ row: row, key: 'event_json' }))
        const surface =
          openedEvent.surface === null ? undefined : decodeSurfaceKey(openedEvent.surface)
        const kind =
          openedEvent._tag === 'ConflictRaised'
            ? openedEvent.propertyId !== undefined
              ? 'same-property'
              : openedEvent.conflictKind
            : undefined
        const message =
          openedEvent._tag === 'ConflictRaised'
            ? decodeConflictPayloadMessage(openedEvent.payload.canonicalJson).message
            : undefined
        const remoteInTrash =
          openedEvent._tag === 'ConflictRaised' ? openedEvent.remoteInTrash : undefined

        return {
          conflictId: decodeSyncEventId(readString({ row: row, key: 'conflict_id' })),
          pageId:
            readOptionalString({ row: row, key: 'page_id' }) === undefined
              ? undefined
              : decodePageId(readString({ row: row, key: 'page_id' })),
          propertyId:
            readOptionalString({ row: row, key: 'property_id' }) === undefined
              ? undefined
              : decodePropertyId(readString({ row: row, key: 'property_id' })),
          surface,
          state: readConflictState({ row: row, key: 'state' }),
          kind,
          baseHash:
            readOptionalString({ row: row, key: 'base_hash' }) === undefined
              ? undefined
              : decodeHash(readString({ row: row, key: 'base_hash' })),
          localHash:
            readOptionalString({ row: row, key: 'local_hash' }) === undefined
              ? undefined
              : decodeHash(readString({ row: row, key: 'local_hash' })),
          remoteHash:
            readOptionalString({ row: row, key: 'remote_hash' }) === undefined
              ? undefined
              : decodeHash(readString({ row: row, key: 'remote_hash' })),
          remoteInTrash,
          message,
          openedEventId: decodeSyncEventId(readString({ row: row, key: 'opened_event_id' })),
          resolutionEventId:
            readOptionalString({ row: row, key: 'resolution_event_id' }) === undefined
              ? undefined
              : decodeSyncEventId(readString({ row: row, key: 'resolution_event_id' })),
        }
      })
  }

  /**
   * The local lifecycle target `L` for a page, derived from the latest SETTLED
   * `TrashPage`/`RestorePage` command in the outbox: `1` (TrashPage settled),
   * `0` (RestorePage settled), or `undefined` (no settled lifecycle intent).
   *
   * This is the authoritative source of `L` for lifecycle-divergence detection
   * (decision 0026). It deliberately does NOT read `_nds_row.in_trash`, which is
   * overloaded — written by `RowObserved`, `TombstoneRecorded`, AND settled local
   * intent — so reading it for `L` would manufacture false-positive conflicts on
   * benign remote changes. The settlement is identified by a non-null
   * `settlement_event_id`; ordering is by the SETTLEMENT event's `sequence` (last
   * wins), with `command_id` as a deterministic tiebreaker. (CDC/replica intents
   * are not always materialized in `_nds_sync_event`, but every settled command
   * has a `RemoteWriteSettled` row, so the settlement-event join is total.)
   */
  readSettledLifecycleTarget({
    rootId,
    pageId,
  }: {
    readonly rootId: SyncRootId
    readonly pageId: PageId
  }): boolean | undefined {
    const row = this.#db
      .prepare(
        `SELECT _nds_outbox.command_tag
         FROM _nds_outbox
         JOIN _nds_sync_event AS settlement_event
           ON settlement_event.root_id = _nds_outbox.root_id
          AND settlement_event.event_id = _nds_outbox.settlement_event_id
         WHERE _nds_outbox.root_id = ?
           AND _nds_outbox.surface = ?
           AND _nds_outbox.command_tag IN ('TrashPage', 'RestorePage')
           AND _nds_outbox.settlement_event_id IS NOT NULL
         ORDER BY settlement_event.sequence DESC, _nds_outbox.command_id DESC
         LIMIT 1`,
      )
      .get(rootId, pageSurfaceKey(pageId))

    if (row === undefined) return undefined
    return readString({ row, key: 'command_tag' }) === 'TrashPage'
  }

  readGuardBlocks(rootId: SyncRootId): readonly GuardBlockProjectionRow[] {
    return this.#db
      .prepare(
        `SELECT block_id, surface, guard, message, event_id
         FROM _nds_guard_block
         WHERE root_id = ?
         ORDER BY guard, surface, block_id`,
      )
      .all(rootId)
      .map((row) => ({
        blockId: readString({ row: row, key: 'block_id' }),
        surface:
          readOptionalString({ row: row, key: 'surface' }) === undefined
            ? undefined
            : decodeSurfaceKey(readString({ row: row, key: 'surface' })),
        guard: Schema.decodeUnknownSync(GuardName)(readString({ row: row, key: 'guard' })),
        message: readString({ row: row, key: 'message' }),
        eventId: decodeSyncEventId(readString({ row: row, key: 'event_id' })),
      }))
  }

  readTombstones(rootId: SyncRootId): readonly TombstoneProjectionRow[] {
    return this.#db
      .prepare(
        `SELECT page_id, classification, reason, event_id
         FROM _nds_tombstone
         WHERE root_id = ?
         ORDER BY classification, page_id`,
      )
      .all(rootId)
      .map((row) => ({
        pageId: decodePageId(readString({ row: row, key: 'page_id' })),
        classification: readTombstoneClassification({ row: row, key: 'classification' }),
        reason: readString({ row: row, key: 'reason' }),
        eventId: decodeSyncEventId(readString({ row: row, key: 'event_id' })),
      }))
  }

  readPlannerProjectionSnapshot(rootId: SyncRootId): PlannerProjectionSnapshot {
    const apiRow = this.#db
      .prepare(
        `SELECT api_version
         FROM _nds_api_contract
         WHERE root_id = ?
         ORDER BY updated_at DESC, api_version
         LIMIT 1`,
      )
      .get(rootId)
    const binding = this.readWorkspaceBinding(rootId)
    const capabilityRows =
      binding === undefined
        ? this.#db
            .prepare(
              `SELECT capability, supported
               FROM _nds_capability
               WHERE root_id = ?
               ORDER BY capability`,
            )
            .all(rootId)
        : this.#db
            .prepare(
              `SELECT capability, supported
               FROM _nds_capability
               WHERE root_id = ? AND data_source_id = ?
               ORDER BY capability`,
            )
            .all(rootId, binding.dataSourceId)
    const requiredCapabilities = capabilityRows.map((row) =>
      decodeCapabilityName(readString({ row: row, key: 'capability' })),
    )
    const supportedCapabilities = capabilityRows
      .filter((row) => readBoolean({ row: row, key: 'supported' }))
      .map((row) => decodeCapabilityName(readString({ row: row, key: 'capability' })))

    const pendingProperties = this.#pendingPropertyIntents(rootId)

    return {
      rootId,
      api: {
        configuredApiVersion:
          apiRow === undefined
            ? NOTION_API_VERSION
            : readString({ row: apiRow, key: 'api_version' }),
        compatibilityProof: apiRow === undefined ? 'missing' : 'present',
      },
      capabilities: {
        required: requiredCapabilities,
        supported: supportedCapabilities,
        preflight:
          capabilityRows.length > 0 &&
          capabilityRows.every((row) => readBoolean({ row: row, key: 'supported' })) === true
            ? 'passed'
            : 'failed',
      },
      metadata: Array.from(
        this.#db
          .prepare(
            `SELECT event_json
             FROM _nds_sync_event
             WHERE root_id = ? AND event_type = 'DataSourceMetadataObserved'
             ORDER BY sequence`,
          )
          .all(rootId)
          .reduce((accumulator, row) => {
            const event = JSON.parse(readString({ row: row, key: 'event_json' })) as {
              readonly dataSourceId?: unknown
              readonly metadataHash?: unknown
            }
            if (typeof event.dataSourceId === 'string' && typeof event.metadataHash === 'string') {
              accumulator.set(event.dataSourceId, event.metadataHash)
            }
            return accumulator
          }, new Map<string, string>())
          .entries(),
      ).map(([dataSourceId, metadataHash]) => ({
        dataSourceId: decodeDataSourceId(dataSourceId),
        metadataHash: decodeHash(metadataHash),
      })),
      databaseMetadata: Array.from(
        this.#db
          .prepare(
            `SELECT event_json
             FROM _nds_sync_event
             WHERE root_id = ? AND event_type = 'DataSourceMetadataObserved'
             ORDER BY sequence`,
          )
          .all(rootId)
          .reduce((accumulator, row) => {
            const event = JSON.parse(readString({ row: row, key: 'event_json' })) as {
              readonly dataSourceId?: unknown
              readonly parentDatabaseId?: unknown
              readonly metadataHash?: unknown
            }
            if (
              typeof event.dataSourceId === 'string' &&
              typeof event.parentDatabaseId === 'string' &&
              typeof event.metadataHash === 'string'
            ) {
              accumulator.set(event.parentDatabaseId, {
                dataSourceId: event.dataSourceId,
                metadataHash: event.metadataHash,
              })
            }
            return accumulator
          }, new Map<string, { readonly dataSourceId: string; readonly metadataHash: string }>())
          .entries(),
      ).map(([databaseId, metadata]) => ({
        databaseId: decodeDatabaseId(databaseId),
        dataSourceId: decodeDataSourceId(metadata.dataSourceId),
        metadataHash: decodeHash(metadata.metadataHash),
      })),
      schema: this.#db
        .prepare(
          `SELECT data_source_id, property_id, schema_hash, config_hash, write_class
           FROM _nds_schema_property
           WHERE root_id = ?
           ORDER BY data_source_id, property_id`,
        )
        .all(rootId)
        .map((row) => ({
          dataSourceId: decodeDataSourceId(readString({ row: row, key: 'data_source_id' })),
          propertyId: decodePropertyId(readString({ row: row, key: 'property_id' })),
          schemaHash: decodeHash(readString({ row: row, key: 'schema_hash' })),
          configHash: decodeHash(readString({ row: row, key: 'config_hash' })),
          writeClass: Schema.decodeUnknownSync(
            Schema.Literals(['writable', 'computed', 'unsupported']),
          )(readString({ row: row, key: 'write_class' })),
        })),
      rows: this.#db
        .prepare(
          `SELECT page_id, data_source_id, properties_hash, in_trash, moved_out, local_delete_candidate
           FROM _nds_row
           WHERE root_id = ?
           ORDER BY data_source_id, page_id`,
        )
        .all(rootId)
        .map((row) => ({
          pageId: decodePageId(readString({ row: row, key: 'page_id' })),
          dataSourceId: decodeDataSourceId(readString({ row: row, key: 'data_source_id' })),
          propertiesHash: decodeHash(readString({ row: row, key: 'properties_hash' })),
          inTrash: readBoolean({ row: row, key: 'in_trash' }),
          movedOut: readBoolean({ row: row, key: 'moved_out' }),
          localDeleteCandidate: readBoolean({ row: row, key: 'local_delete_candidate' }),
        })),
      properties: this.#db
        .prepare(
          `SELECT page_id, property_id, base_hash, remote_hash, availability
           FROM _nds_property_shadow
           WHERE root_id = ?
           ORDER BY page_id, property_id`,
        )
        .all(rootId)
        .map((row) => {
          const pageId = decodePageId(readString({ row: row, key: 'page_id' }))
          const propertyId = decodePropertyId(readString({ row: row, key: 'property_id' }))

          return {
            pageId,
            propertyId,
            baseHash: decodeHash(readString({ row: row, key: 'base_hash' })),
            remoteHash: decodeHash(readString({ row: row, key: 'remote_hash' })),
            availability: Schema.decodeUnknownSync(
              Schema.Literals([
                'complete',
                'computed',
                'unsupported',
                'paginated-incomplete',
                'relation-target-inaccessible',
                'related-data-source-unshared',
              ]),
            )(readString({ row: row, key: 'availability' })),
            pendingLocal: pendingProperties.get(`${pageId}\0${propertyId}`),
          }
        }),
      bodies: this.#db
        .prepare(
          `SELECT
             page_id,
             path,
             base_hash,
             current_hash,
             sidecar_identity_proven,
             own_write_materialization_ids_json,
             body_projection_json
           FROM _nds_body_pointer
           WHERE root_id = ?
           ORDER BY page_id`,
        )
        .all(rootId)
        .map((row) => {
          const payload = decodeBodyProjectionPayload(
            readString({ row: row, key: 'body_projection_json' }),
          )
          return {
            pageId: decodePageId(readString({ row: row, key: 'page_id' })),
            path: readString({ row: row, key: 'path' }),
            baseHash: decodeHash(readString({ row: row, key: 'base_hash' })),
            currentHash: decodeHash(readString({ row: row, key: 'current_hash' })),
            pointer: payload.pointer,
            sidecarIdentityProven: readBoolean({ row: row, key: 'sidecar_identity_proven' }),
            ownWriteMaterializationIds: Schema.decodeSync(
              Schema.fromJsonString(Schema.Array(Schema.String)),
            )(readString({ row: row, key: 'own_write_materialization_ids_json' })),
            safety: payload.safety,
          }
        }),
      tombstones: this.#readTombstones(rootId),
      queries: this.#readQuerySurfaces(rootId),
      pathClaims: this.#db
        .prepare(
          `SELECT relative_path, page_id, state
           FROM _nds_path_claim
           WHERE root_id = ?
           ORDER BY relative_path`,
        )
        .all(rootId)
        .map((row) => ({
          path: readString({ row: row, key: 'relative_path' }),
          ownerPageId: decodePageId(readString({ row: row, key: 'page_id' })),
          released: readString({ row: row, key: 'state' }) === 'released',
        })),
      localWorkspace: [],
      remoteChanges: [],
    }
  }

  getCompactionDecision(rootId: SyncRootId): CompactionDecision {
    const blockers: CompactionBlocker[] = []
    const metadata = this.readProjectionMetadata(rootId)
    const currentDigest = this.computeCurrentProjectionDigest(rootId)

    if (metadata === undefined || metadata.digest !== currentDigest) {
      blockers.push({
        guard: 'CheckpointDigestMismatch',
        message: 'Projection metadata digest does not match replayed event digest',
      })
    }

    const outboxRows = this.#db
      .prepare(
        `SELECT command_id, state, lease_token
         FROM _nds_outbox
         WHERE root_id = ?`,
      )
      .all(rootId)

    for (const row of outboxRows) {
      const state = readOutboxState({ row: row, key: 'state' })
      const leaseToken = readOptionalString({ row: row, key: 'lease_token' })
      if (
        isCompactionBlockingOutboxState(state) === true ||
        (state !== 'settled' && leaseToken !== undefined)
      ) {
        blockers.push({
          guard: 'CompactionUnsafe',
          message: `Outbox command ${readString({ row: row, key: 'command_id' })} is ${state}`,
        })
      }
    }

    // `resolving` lifecycle conflicts are still freeze-active (#775 M2a'-2): the
    // freeze gate JOINs the opened `ConflictRaised` event, so compaction must not
    // GC that event while the re-assert is pending/blocked or the freeze would
    // silently vanish on the next replay.
    const openConflict = this.#db
      .prepare(
        `SELECT conflict_id
         FROM _nds_conflict
         WHERE root_id = ? AND state IN ('open', 'resolving')
         ORDER BY conflict_id
         LIMIT 1`,
      )
      .get(rootId)

    if (openConflict !== undefined) {
      blockers.push({
        guard: 'CompactionUnsafe',
        message: `Conflict ${readString({ row: openConflict, key: 'conflict_id' })} is still open`,
      })
    }

    const unclassifiedTombstone = this.#db
      .prepare(
        `SELECT page_id
         FROM _nds_tombstone
         WHERE root_id = ? AND classification = 'unclassified'
         ORDER BY page_id
         LIMIT 1`,
      )
      .get(rootId)

    if (unclassifiedTombstone !== undefined) {
      blockers.push({
        guard: 'CompactionUnsafe',
        message: `Tombstone for page ${readString({ row: unclassifiedTombstone, key: 'page_id' })} is unclassified`,
      })
    }

    return blockers.length === 0 ? { _tag: 'allowed' } : { _tag: 'blocked', blockers }
  }

  readStatusProjection(rootId: SyncRootId): StoreStatusProjection {
    const outboxRows = this.#db
      .prepare(
        `SELECT state, COUNT(*) AS count
         FROM _nds_outbox
         WHERE root_id = ?
         GROUP BY state`,
      )
      .all(rootId)
    const _nds_outbox = {
      queued: 0,
      running: 0,
      retryable: 0,
      blocked: 0,
      settled: 0,
      fenced: 0,
      ambiguous: 0,
    } satisfies StoreStatusProjection['outbox']

    for (const row of outboxRows) {
      _nds_outbox[readOutboxState({ row: row, key: 'state' })] = Number(
        readInteger({ row: row, key: 'count' }),
      )
    }

    return {
      outbox: _nds_outbox,
      conflicts: {
        // `resolving` lifecycle conflicts (#775 M2a'-2) are still unresolved and
        // freeze-active, so they count as `open` for the human-facing status —
        // the conflict must stay visibly unresolved until the re-assert settles.
        open: readCount({
          row: this.#db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM _nds_conflict
               WHERE root_id = ? AND state IN ('open', 'resolving')`,
            )
            .get(rootId),
          key: 'count',
        }),
      },
      tombstones: {
        unclassified: readCount({
          row: this.#db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM _nds_tombstone
               WHERE root_id = ? AND classification = 'unclassified'`,
            )
            .get(rootId),
          key: 'count',
        }),
      },
      guards: {
        blocked: readCount({
          row: this.#db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM _nds_guard_block
               WHERE root_id = ?`,
            )
            .get(rootId),
          key: 'count',
        }),
      },
      capabilities: {
        unsupported: readCount({
          row: this.#db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM _nds_capability
               WHERE root_id = ? AND supported = 0`,
            )
            .get(rootId),
          key: 'count',
        }),
      },
      checkpoints: {
        incompleteQueries: readCount({
          row: this.#db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM _nds_query_scan_checkpoint
               WHERE root_id = ? AND complete = 0`,
            )
            .get(rootId),
          key: 'count',
        }),
        cappedQueries: readCount({
          row: this.#db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM _nds_query_scan_checkpoint
               WHERE root_id = ? AND capped_at_limit = 1`,
            )
            .get(rootId),
          key: 'count',
        }),
        changedQueryContracts: readCount({
          row: this.#db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM _nds_query_scan_checkpoint
               WHERE root_id = ? AND contract_changed = 1`,
            )
            .get(rootId),
          key: 'count',
        }),
        incompleteProperties: readCount({
          row: this.#db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM _nds_page_property_checkpoint
               WHERE root_id = ? AND complete = 0`,
            )
            .get(rootId),
          key: 'count',
        }),
      },
      projections: {
        dataSources: readCount({
          row: this.#db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM _nds_data_source
               WHERE root_id = ?`,
            )
            .get(rootId),
          key: 'count',
        }),
        rows: readCount({
          row: this.#db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM _nds_row
               WHERE root_id = ?`,
            )
            .get(rootId),
          key: 'count',
        }),
        properties: readCount({
          row: this.#db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM _nds_property_shadow
               WHERE root_id = ?`,
            )
            .get(rootId),
          key: 'count',
        }),
        bodies: readCount({
          row: this.#db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM _nds_body_pointer
               WHERE root_id = ?`,
            )
            .get(rootId),
          key: 'count',
        }),
      },
      signals: this.readSignalStatus(rootId),
    }
  }

  replaceProjectionDigestForRepairTest({
    rootId,
    digest,
  }: {
    readonly rootId: SyncRootId
    readonly digest: Hash
  }): void {
    this.#db
      .prepare(
        `UPDATE _nds_projection_metadata
         SET digest = ?
         WHERE root_id = ? AND projection_name = ?`,
      )
      .run(digest, rootId, projectionName)
  }

  #appendEventInTransaction(event: SyncEvent): SyncEvent {
    return this.#appendEventWithResultInTransaction(event).event
  }

  #appendEventWithResultInTransaction(event: SyncEvent): {
    readonly event: SyncEvent
    readonly inserted: boolean
  } {
    this.#ensureRoot(event.rootId)

    const existing = this.#db
      .prepare(
        `SELECT event_json
         FROM _nds_sync_event
         WHERE root_id = ? AND idempotency_key = ?`,
      )
      .get(event.rootId, event.idempotencyKey)

    if (existing !== undefined) {
      return {
        event: decodeEventFromJson(readString({ row: existing, key: 'event_json' })),
        inserted: false,
      }
    }

    const sequence = this.#nextSequence(event.rootId)
    const encodedOriginalEvent = encodeEvent(event)
    const eventWithAssignedFields = Schema.decodeSync(SyncEvent)({
      ...encodedOriginalEvent,
      sequence: sequence.toString(),
      payloadHash: computePayloadHash(event),
    })
    const encodedEvent = encodeEvent(eventWithAssignedFields)

    this.#db
      .prepare(
        `INSERT INTO _nds_sync_event (
           root_id,
           sequence,
           event_id,
           codec_version,
           family,
           event_type,
           idempotency_key,
           surface,
           caused_by_event_ids_json,
           payload_hash,
           payload_json,
           event_json,
           observed_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        encodedEvent.rootId,
        sequence,
        encodedEvent.eventId,
        encodedEvent.codecVersion,
        encodedEvent.family,
        encodedEvent.eventType,
        encodedEvent.idempotencyKey,
        encodedEvent.surface,
        stringifyJson(encodedEvent.causedByEventIds),
        encodedEvent.payloadHash,
        stringifyJson(encodedEvent.payload),
        stringifyJson(encodedEvent),
        encodedEvent.observedAt,
      )

    this.#rebuildProjectionsInTransaction(event.rootId)
    return { event: eventWithAssignedFields, inserted: true }
  }

  #appendOutboxAttemptStateInTransaction(
    input: OutboxAttemptStateInput,
  ): Extract<SyncEvent, { readonly _tag: 'RemoteWriteAttempted' }> {
    const event = this.#appendEventInTransaction(
      Schema.decodeSync(SyncEvent)({
        _tag: 'RemoteWriteAttempted',
        eventId: makeEventId(['attempt', input.commandId, input.attempt, input.attemptState]),
        rootId: input.rootId,
        sequence: '0',
        codecVersion: 'v1',
        family: 'CommandAttempted',
        eventType: 'RemoteWriteAttempted',
        idempotencyKey:
          input.idempotencyKey ??
          `attempt:${input.commandId}:${input.attempt}:${input.attemptState}`,
        surface: input.surface,
        causedByEventIds: [],
        payloadHash: decodeHash('sha256:'.padEnd(71, '0')),
        payload: eventPayload(
          stringifyJson({
            commandId: input.commandId,
            attempt: input.attempt,
            attemptState: input.attemptState,
            guard: input.guard,
            retryAfterMillis: input.retryAfterMillis,
          }),
        ),
        observedAt: currentIso(this.#now),
        commandId: input.commandId,
        attempt: input.attempt,
        attemptState: input.attemptState,
        ...(input.leaseToken === undefined ? {} : { leaseToken: input.leaseToken }),
        ...(input.guard === undefined ? {} : { guard: input.guard }),
        ...(input.retryAfterMillis === undefined
          ? {}
          : { retryAfterMillis: input.retryAfterMillis }),
      }),
    )

    if (event._tag !== 'RemoteWriteAttempted') {
      throw new LocalStoreError({
        operation: 'append-_nds_outbox-attempt',
        message: `Outbox attempt idempotency key resolved to unexpected event ${event._tag}`,
      })
    }

    return event
  }

  #signalRecord({
    rootId,
    row,
  }: {
    readonly rootId: SyncRootId
    readonly row: SqlRow
  }): SignalInboxRecord {
    const dataSourceId = readOptionalString({ row, key: 'data_source_id' })
    const pageId = readOptionalString({ row, key: 'page_id' })
    const leaseToken = readOptionalString({ row, key: 'lease_token' })
    const claimedAt = readOptionalString({ row, key: 'claimed_at' })
    const processedAt = readOptionalString({ row, key: 'processed_at' })
    const lastError = readOptionalString({ row, key: 'last_error' })

    return {
      rootId,
      signalId: Schema.decodeSync(SignalId)(readString({ row, key: 'signal_id' })),
      provider: Schema.decodeSync(SignalProvider)(readString({ row, key: 'provider' })),
      externalId: Schema.decodeSync(SignalExternalId)(readString({ row, key: 'external_id' })),
      kind: Schema.decodeUnknownSync(SignalKind)(readString({ row, key: 'kind' })),
      payloadJson: readString({ row, key: 'payload_json' }),
      state: readSignalState({ row, key: 'state' }),
      ...(dataSourceId === undefined ? {} : { dataSourceId: decodeDataSourceId(dataSourceId) }),
      ...(pageId === undefined ? {} : { pageId: decodePageId(pageId) }),
      attemptCount: Number(readInteger({ row, key: 'attempt_count' })),
      ...(leaseToken === undefined ? {} : { leaseToken }),
      ...(claimedAt === undefined ? {} : { claimedAt }),
      ...(processedAt === undefined ? {} : { processedAt }),
      ...(lastError === undefined ? {} : { lastError }),
      createdAt: readString({ row, key: 'created_at' }),
      updatedAt: readString({ row, key: 'updated_at' }),
    }
  }

  #runMigrations(): void {
    assertSupportedSchemaVersion(this.#db)

    this.#db.exec(createStoreSchemaSql)
    let replayProjections = false
    for (const statement of [
      `ALTER TABLE _nds_query_scan_checkpoint
       ADD COLUMN capped_at_limit INTEGER NOT NULL DEFAULT 0 CHECK (capped_at_limit IN (0, 1))`,
      `ALTER TABLE _nds_query_scan_checkpoint
       ADD COLUMN contract_changed INTEGER NOT NULL DEFAULT 0 CHECK (contract_changed IN (0, 1))`,
      `ALTER TABLE _nds_outbox
       ADD COLUMN retry_after_millis INTEGER`,
      `ALTER TABLE _nds_outbox
       ADD COLUMN retry_after_at TEXT`,
    ]) {
      try {
        this.#db.exec(statement)
      } catch (cause) {
        if (String(cause).includes('duplicate column name') === false) {
          throw cause
        }
      }
    }
    if (capabilityProjectionIsScopedByDataSource(this.#db) === false) {
      this.#db.exec(`
CREATE TABLE _nds_capability_v6 (
  root_id TEXT NOT NULL REFERENCES _nds_sync_root(root_id) ON DELETE CASCADE,
  capability TEXT NOT NULL,
  data_source_id TEXT NOT NULL,
  supported INTEGER NOT NULL CHECK (supported IN (0, 1)),
  request_id TEXT,
  checked_event_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (root_id, data_source_id, capability)
);
INSERT OR REPLACE INTO _nds_capability_v6 (
  root_id,
  capability,
  data_source_id,
  supported,
  request_id,
  checked_event_id,
  updated_at
)
SELECT
  root_id,
  capability,
  data_source_id,
  supported,
  request_id,
  checked_event_id,
  updated_at
FROM _nds_capability;
DROP TABLE _nds_capability;
ALTER TABLE _nds_capability_v6 RENAME TO _nds_capability;
`)
    }
    if (bodyPointerProjectionStoresProjectionPayload(this.#db) === false) {
      this.#db.exec(`
DROP TABLE _nds_body_pointer;
CREATE TABLE _nds_body_pointer (
  root_id TEXT NOT NULL REFERENCES _nds_sync_root(root_id) ON DELETE CASCADE,
  page_id TEXT NOT NULL,
  path TEXT NOT NULL,
  base_hash TEXT NOT NULL,
  current_hash TEXT NOT NULL,
  sidecar_identity_proven INTEGER NOT NULL CHECK (sidecar_identity_proven IN (0, 1)),
  own_write_materialization_ids_json TEXT NOT NULL,
  body_projection_json TEXT NOT NULL,
  observed_event_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (root_id, page_id)
);
`)
      replayProjections = true
    }
    if (conflictProjectionAdmitsResolving(this.#db) === false) {
      // Recreate the pure-projection `_nds_conflict` table so its CHECK admits the
      // `resolving` lifecycle state (#775 M2a'-2). Safe to drop+rebuild from the
      // event log; replay below re-derives all conflict rows.
      this.#db.exec(`
DROP TABLE _nds_conflict;
CREATE TABLE _nds_conflict (
  root_id TEXT NOT NULL REFERENCES _nds_sync_root(root_id) ON DELETE CASCADE,
  conflict_id TEXT NOT NULL,
  page_id TEXT,
  property_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('open', 'resolving', 'resolved', 'superseded', 'ignored')),
  base_hash TEXT,
  local_hash TEXT,
  remote_hash TEXT,
  opened_event_id TEXT NOT NULL,
  resolution_event_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (root_id, conflict_id)
);
`)
      replayProjections = true
    }
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO _nds_migration_history (schema_version, migration_name, applied_at)
         VALUES (?, ?, ?)`,
      )
      .run(STORE_SCHEMA_VERSION, 'conflict-resolving-state', currentIso(this.#now))

    if (replayProjections === true) {
      for (const row of this.#db.prepare(`SELECT root_id FROM _nds_sync_root`).all()) {
        this.#rebuildProjectionsInTransaction(
          Schema.decodeUnknownSync(SyncRootIdSchema)(row.root_id),
        )
      }
    }
  }

  #ensureRoot(rootId: SyncRootId): void {
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO _nds_sync_root (root_id, created_at, store_identity, settings_json)
         VALUES (?, ?, ?, ?)`,
      )
      .run(rootId, currentIso(this.#now), `store:${rootId}`, '{}')
  }

  #nextSequence(rootId: SyncRootId): bigint {
    const row = this.#db
      .prepare(
        `SELECT COALESCE(MAX(sequence), 0) AS sequence
         FROM _nds_sync_event
         WHERE root_id = ?`,
      )
      .get(rootId)

    return readInteger({ row: row ?? { sequence: 0n }, key: 'sequence' }) + 1n
  }

  #eventRows(rootId: SyncRootId): readonly SqlRow[] {
    return this.#db
      .prepare(
        `SELECT sequence, event_id, payload_hash, event_json
         FROM _nds_sync_event
         WHERE root_id = ?
         ORDER BY sequence, event_id`,
      )
      .all(rootId)
  }

  #projectionDigestInputs(rootId: SyncRootId): readonly ProjectionDigestInput[] {
    return this.#eventRows(rootId).map((row) => ({
      sequence: readInteger({ row: row, key: 'sequence' }),
      eventId: readString({ row: row, key: 'event_id' }),
      payloadHash: readString({ row: row, key: 'payload_hash' }),
    }))
  }

  /**
   * Whether the page has a freeze-active `lifecycle` conflict (decision 0026,
   * #775 M2a'-2). Used by the `RowObserved` apply to freeze `_nds_row.in_trash`.
   * Both `open` AND `resolving` count: a `keep-local` resolution moves the
   * conflict to `resolving` and re-asserts the local target via a Trash/Restore
   * push that may BLOCK if the remote actively diverged. Keeping the freeze active
   * while `resolving` ensures `in_trash` stays at the local target L until the
   * re-assert genuinely settles (F8 then transitions to `resolved`) — never a
   * silent last-writer-wins flip to the remote value. The `lifecycle`
   * discriminator is recovered by decoding the opened `ConflictRaised` event and
   * reading `conflictKind` — `property_id IS NULL` alone is NOT sufficient because
   * `body` conflicts also have a null `property_id`, and freezing `in_trash` on an
   * open body conflict would be a bug.
   */
  #hasOpenLifecycleConflict({
    rootId,
    pageId,
  }: {
    readonly rootId: SyncRootId
    readonly pageId: PageId
  }): boolean {
    const rows = this.#db
      .prepare(
        `SELECT opened.event_json
         FROM _nds_conflict conflict
         JOIN _nds_sync_event opened
           ON opened.root_id = conflict.root_id
          AND opened.event_id = conflict.opened_event_id
         WHERE conflict.root_id = ?
           AND conflict.page_id = ?
           AND conflict.state IN ('open', 'resolving')`,
      )
      .all(rootId, pageId)

    return rows.some((row) => {
      const openedEvent = decodeEventFromJson(readString({ row: row, key: 'event_json' }))
      return openedEvent._tag === 'ConflictRaised' && openedEvent.conflictKind === 'lifecycle'
    })
  }

  #pendingPropertyIntents(rootId: SyncRootId): ReadonlyMap<string, PropertyPendingLocalIntent> {
    const pending = new Map<string, PropertyPendingLocalIntent>()

    const rows = this.#db
      .prepare(
        `SELECT
           _nds_outbox.intent_event_id,
           _nds_outbox.surface,
           _nds_outbox.desired_hash,
           _nds_outbox.state
         FROM _nds_outbox
         LEFT JOIN _nds_sync_event AS intent_event
           ON intent_event.root_id = _nds_outbox.root_id
          AND intent_event.event_id = _nds_outbox.intent_event_id
         LEFT JOIN _nds_sync_event AS planned_event
           ON planned_event.root_id = _nds_outbox.root_id
          AND planned_event.event_type = 'RemoteWritePlanned'
          AND planned_event.idempotency_key = _nds_outbox.command_key
         WHERE _nds_outbox.root_id = ?
           AND _nds_outbox.command_tag = 'PatchPageProperties'
           AND _nds_outbox.settlement_event_id IS NULL
           AND _nds_outbox.state IN ('queued', 'running', 'retryable', 'blocked', 'ambiguous')
         ORDER BY COALESCE(intent_event.sequence, planned_event.sequence), _nds_outbox.command_id`,
      )
      .all(rootId)

    for (const row of rows) {
      const surface = parsePropertySurface(readOptionalString({ row: row, key: 'surface' }))
      if (surface === undefined) continue

      const state = readOutboxState({ row: row, key: 'state' })
      // The query's WHERE clause restricts `state` to the pending-intent subset
      // (queued/running/retryable/blocked/ambiguous); `settled`/`fenced` cannot
      // appear, so this narrowing is exhaustive for the projection type.
      if (state === 'settled' || state === 'fenced') continue

      pending.set(`${surface.pageId}\0${surface.propertyId}`, {
        intentEventId: decodeSyncEventId(readString({ row: row, key: 'intent_event_id' })),
        targetHash: decodeHash(readString({ row: row, key: 'desired_hash' })),
        state,
      })
    }

    return pending
  }

  #readTombstones(rootId: SyncRootId): PlannerProjectionSnapshot['tombstones'] {
    return this.#db
      .prepare(
        `SELECT
           tombstone.page_id,
           tombstone.classification,
           absence.data_source_id,
           absence.query_contract_hash,
           absence.direct_retrieve
         FROM _nds_tombstone tombstone
         LEFT JOIN _nds_query_absence absence
           ON absence.root_id = tombstone.root_id
          AND absence.page_id = tombstone.page_id
          AND absence.evidence_event_id = tombstone.event_id
         WHERE tombstone.root_id = ?
         ORDER BY tombstone.page_id, absence.data_source_id, absence.query_contract_hash`,
      )
      .all(rootId)
      .map((row) => {
        const pageId = readString({ row: row, key: 'page_id' })
        const classification = readString({ row: row, key: 'classification' })
        const state =
          classification === 'unclassified'
            ? 'candidate'
            : classification === 'remote_trash'
              ? 'remote-trash'
              : classification === 'moved_out' || classification === 'moved_between_tracked_sources'
                ? 'moved-out'
                : classification === 'inaccessible' || classification === 'unknown'
                  ? classification
                  : 'none'
        const directRetrieve =
          row.direct_retrieve === null || row.direct_retrieve === undefined
            ? classification === 'remote_trash'
              ? 'in-trash'
              : classification === 'moved_out' || classification === 'moved_between_tracked_sources'
                ? 'moved-out'
                : classification === 'inaccessible' || classification === 'unknown'
                  ? classification
                  : 'not-run'
            : Schema.decodeUnknownSync(
                Schema.Literals([
                  'not-run',
                  'accessible',
                  'in-trash',
                  'moved-out',
                  'permission-ambiguous',
                  'inaccessible',
                  'unknown',
                ]),
              )(readString({ row: row, key: 'direct_retrieve' }))

        return {
          pageId: decodePageId(pageId),
          dataSourceId:
            row.data_source_id === null || row.data_source_id === undefined
              ? undefined
              : decodeDataSourceId(readString({ row: row, key: 'data_source_id' })),
          queryContractHash:
            row.query_contract_hash === null || row.query_contract_hash === undefined
              ? undefined
              : decodeHash(readString({ row: row, key: 'query_contract_hash' })),
          state,
          directRetrieve,
        }
      })
  }

  #readQuerySurfaces(rootId: SyncRootId): PlannerProjectionSnapshot['queries'] {
    return this.#db
      .prepare(
        `SELECT
           absence.data_source_id,
           absence.page_id,
           absence.query_contract_hash,
           absence.classified,
           absence.membership_scope,
           absence.filtered,
           absence.direct_retrieve,
           checkpoint.complete,
           checkpoint.capped_at_limit,
           checkpoint.contract_changed
         FROM _nds_query_absence absence
         LEFT JOIN _nds_query_scan_checkpoint checkpoint
           ON checkpoint.root_id = absence.root_id
          AND checkpoint.data_source_id = absence.data_source_id
          AND checkpoint.query_contract_hash = absence.query_contract_hash
         WHERE absence.root_id = ?
         ORDER BY absence.data_source_id, absence.page_id, absence.query_contract_hash`,
      )
      .all(rootId)
      .map((row) => ({
        dataSourceId: decodeDataSourceId(readString({ row: row, key: 'data_source_id' })),
        pageId: decodePageId(readString({ row: row, key: 'page_id' })),
        queryContractHash: decodeHash(readString({ row: row, key: 'query_contract_hash' })),
        completeness: {
          terminal:
            row.complete === null || row.complete === undefined
              ? false
              : readBoolean({ row: row, key: 'complete' }),
          cappedAtLimit:
            row.capped_at_limit === null || row.capped_at_limit === undefined
              ? false
              : readBoolean({ row: row, key: 'capped_at_limit' }),
          contractChanged:
            row.contract_changed === null || row.contract_changed === undefined
              ? false
              : readBoolean({ row: row, key: 'contract_changed' }),
        },
        absence: {
          classified: readBoolean({ row: row, key: 'classified' }),
          membershipScope: Schema.decodeUnknownSync(
            Schema.Literals(['all-data-source-rows', 'explicit-filter']),
          )(readString({ row: row, key: 'membership_scope' })),
          filtered: readBoolean({ row: row, key: 'filtered' }),
          directRetrieve: Schema.decodeUnknownSync(
            Schema.Literals([
              'not-run',
              'accessible',
              'in-trash',
              'moved-out',
              'permission-ambiguous',
              'inaccessible',
              'unknown',
            ]),
          )(readString({ row: row, key: 'direct_retrieve' })),
        },
      }))
  }

  #rebuildProjectionsInTransaction(rootId: SyncRootId): ProjectionMetadata {
    this.#clearProjectionTablesForRoot(rootId)

    for (const event of this.replay(rootId)) {
      this.#applyEvent(event)
    }

    const digestInputs = this.#projectionDigestInputs(rootId)
    const highWaterSequence = digestInputs.at(-1)?.sequence ?? 0n
    const digest = computeProjectionDigest(digestInputs)

    this.#db
      .prepare(
        `INSERT INTO _nds_projection_metadata (
           root_id,
           projection_name,
           projector_version,
           high_water_sequence,
           digest,
           rebuilt_at
         )
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(root_id, projection_name) DO UPDATE SET
           projector_version = excluded.projector_version,
           high_water_sequence = excluded.high_water_sequence,
           digest = excluded.digest,
           rebuilt_at = excluded.rebuilt_at`,
      )
      .run(
        rootId,
        projectionName,
        PROJECTOR_VERSION,
        highWaterSequence,
        digest,
        currentIso(this.#now),
      )

    return { rootId, projectorVersion: PROJECTOR_VERSION, highWaterSequence, digest }
  }

  #clearProjectionTablesForRoot(rootId: SyncRootId): void {
    for (const table of rootScopedProjectionTables) {
      this.#db.prepare(`DELETE FROM ${table} WHERE root_id = ?`).run(rootId)
    }
  }

  #applyQueryAbsenceEvidence({
    event,
    defaultClassified,
  }: {
    readonly event: Extract<
      SyncEvent,
      { readonly _tag: 'TombstoneCandidateObserved' | 'TombstoneRecorded' }
    >
    readonly defaultClassified: boolean
  }): void {
    const payload = decodePayload({ event: event, decode: decodeQueryAbsenceProjectionPayload })
    if (
      payload?.dataSourceId === undefined ||
      payload.queryContractHash === undefined ||
      (payload.pageId !== undefined && payload.pageId !== event.pageId)
    ) {
      return
    }

    const directRetrieve =
      payload.directRetrieve ??
      (event._tag === 'TombstoneRecorded'
        ? event.reason === 'remote_trash'
          ? 'in-trash'
          : event.reason === 'moved_out' || event.reason === 'moved_between_tracked_sources'
            ? 'moved-out'
            : event.reason
        : 'not-run')

    this.#db
      .prepare(
        `INSERT INTO _nds_query_absence (
           root_id,
           data_source_id,
           page_id,
           query_contract_hash,
           classified,
           membership_scope,
           filtered,
           direct_retrieve,
           evidence_event_id,
           updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(root_id, data_source_id, page_id, query_contract_hash) DO UPDATE SET
           classified = excluded.classified,
           membership_scope = excluded.membership_scope,
           filtered = excluded.filtered,
           direct_retrieve = excluded.direct_retrieve,
           evidence_event_id = excluded.evidence_event_id,
           updated_at = excluded.updated_at`,
      )
      .run(
        event.rootId,
        payload.dataSourceId,
        event.pageId,
        payload.queryContractHash,
        (payload.classified ?? defaultClassified) === true ? 1 : 0,
        payload.membershipScope ?? 'all-data-source-rows',
        payload.filtered === true ? 1 : 0,
        directRetrieve,
        event.eventId,
        currentIso(this.#now),
      )
  }

  #applyEvent(event: SyncEvent): void {
    switch (event._tag) {
      case 'SyncBindingRecorded':
        this.#db
          .prepare(
            `INSERT INTO _nds_workspace_binding (
               root_id,
               data_source_id,
               workspace_root,
               store_identity,
               binding_event_id,
               updated_at
             )
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(root_id) DO UPDATE SET
               data_source_id = excluded.data_source_id,
               workspace_root = excluded.workspace_root,
               store_identity = excluded.store_identity,
               binding_event_id = excluded.binding_event_id,
               updated_at = excluded.updated_at`,
          )
          .run(
            event.rootId,
            event.dataSourceId,
            event.workspaceRoot,
            event.storeIdentity,
            event.eventId,
            currentIso(this.#now),
          )
        break
      case 'DataSourceMetadataObserved':
        if (event.parentDatabaseId !== undefined) {
          this.#db
            .prepare(
              `UPDATE _nds_workspace_binding
               SET database_id = ?, metadata_event_id = ?, updated_at = ?
               WHERE root_id = ? AND data_source_id = ?`,
            )
            .run(
              event.parentDatabaseId,
              event.eventId,
              currentIso(this.#now),
              event.rootId,
              event.dataSourceId,
            )
        }
        break
      case 'ApiContractObserved':
        this.#db
          .prepare(
            `INSERT INTO _nds_api_contract (
               root_id,
               api_version,
               client_version,
               supported_capabilities_json,
               proof_event_id,
               updated_at
             )
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(root_id, api_version) DO UPDATE SET
               client_version = excluded.client_version,
               supported_capabilities_json = excluded.supported_capabilities_json,
               proof_event_id = excluded.proof_event_id,
               updated_at = excluded.updated_at`,
          )
          .run(
            event.rootId,
            event.apiContract.apiVersion,
            event.apiContract.clientVersion,
            stringifyJson(event.apiContract.supportedCapabilities),
            event.eventId,
            currentIso(this.#now),
          )
        break
      case 'CapabilityPreflightChecked':
        this.#db
          .prepare(
            `INSERT INTO _nds_capability (
               root_id,
               capability,
               data_source_id,
               supported,
               request_id,
               checked_event_id,
               updated_at
             )
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(root_id, data_source_id, capability) DO UPDATE SET
               data_source_id = excluded.data_source_id,
               supported = excluded.supported,
               request_id = excluded.request_id,
               checked_event_id = excluded.checked_event_id,
               updated_at = excluded.updated_at`,
          )
          .run(
            event.rootId,
            event.capability,
            event.dataSourceId,
            event.supported === true ? 1 : 0,
            event.requestId ?? null,
            event.eventId,
            currentIso(this.#now),
          )
        break
      case 'DataSourceObserved': {
        const payload = decodePayload({ event: event, decode: decodeDataSourceProjectionPayload })
        this.#db
          .prepare(
            `INSERT INTO _nds_data_source (
               root_id,
               data_source_id,
               request_id,
               schema_hash,
               observed_event_id,
               observed_at,
               updated_at
             )
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(root_id, data_source_id) DO UPDATE SET
               request_id = excluded.request_id,
               schema_hash = excluded.schema_hash,
               observed_event_id = excluded.observed_event_id,
               observed_at = excluded.observed_at,
               updated_at = excluded.updated_at`,
          )
          .run(
            event.rootId,
            event.dataSourceId,
            event.requestId,
            event.schemaHash,
            event.eventId,
            Schema.encodeSync(Schema.DateTimeUtcFromString)(event.observedAt),
            currentIso(this.#now),
          )

        if (payload?.schemaProperties !== undefined) {
          this.#db
            .prepare(
              `DELETE FROM _nds_schema_property
               WHERE root_id = ? AND data_source_id = ?`,
            )
            .run(event.rootId, event.dataSourceId)

          for (const property of payload.schemaProperties) {
            this.#db
              .prepare(
                `INSERT INTO _nds_schema_property (
                   root_id,
                   data_source_id,
                   property_id,
                   schema_hash,
                   config_hash,
                   write_class,
                   observed_event_id,
                   updated_at
                 )
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(root_id, data_source_id, property_id) DO UPDATE SET
                   schema_hash = excluded.schema_hash,
                   config_hash = excluded.config_hash,
                   write_class = excluded.write_class,
                   observed_event_id = excluded.observed_event_id,
                   updated_at = excluded.updated_at`,
              )
              .run(
                event.rootId,
                event.dataSourceId,
                property.propertyId,
                event.schemaHash,
                property.configHash,
                property.writeClass,
                event.eventId,
                currentIso(this.#now),
              )
          }
        }

        break
      }
      case 'DataSourceSchemaObserved': {
        const payload = decodePayload({ event: event, decode: decodeDataSourceProjectionPayload })
        this.#db
          .prepare(
            `DELETE FROM _nds_schema_property
             WHERE root_id = ? AND data_source_id = ?`,
          )
          .run(event.rootId, event.dataSourceId)

        for (const property of payload?.schemaProperties ?? event.schemaProperties) {
          this.#db
            .prepare(
              `INSERT INTO _nds_schema_property (
                 root_id,
                 data_source_id,
                 property_id,
                 schema_hash,
                 config_hash,
                 write_class,
                 observed_event_id,
                 updated_at
               )
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(root_id, data_source_id, property_id) DO UPDATE SET
                 schema_hash = excluded.schema_hash,
                 config_hash = excluded.config_hash,
                 write_class = excluded.write_class,
                 observed_event_id = excluded.observed_event_id,
                 updated_at = excluded.updated_at`,
            )
            .run(
              event.rootId,
              event.dataSourceId,
              property.propertyId,
              event.schemaHash,
              property.configHash,
              property.writeClass,
              event.eventId,
              currentIso(this.#now),
            )
        }
        break
      }
      case 'RowObserved': {
        const payload = decodePayload({ event: event, decode: decodeRowProjectionPayload })
        // Lifecycle-conflict suppression (decision 0026): when an open `lifecycle`
        // conflict exists for this page, a `RowObserved` must NOT overwrite the
        // settled local lifecycle target — keep the existing `in_trash`. Properties,
        // body, moved-out, etc. still converge unconditionally. This is replay-pure:
        // the gating ConflictRaised is persisted at a LOWER sequence (appended at
        // detection time), so reprojection sees the open conflict before this
        // RowObserved applies. The suppression is a pure function of the persisted
        // open-conflict row — no `L` recomputation happens in the apply path.
        const freezeInTrash = this.#hasOpenLifecycleConflict({
          rootId: event.rootId,
          pageId: event.pageId,
        })
        this.#db
          .prepare(
            `INSERT INTO _nds_row (
               root_id,
               data_source_id,
               page_id,
               properties_hash,
               in_trash,
               moved_out,
               local_delete_candidate,
               observed_event_id,
               observed_at,
               updated_at
             )
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(root_id, page_id) DO UPDATE SET
               data_source_id = excluded.data_source_id,
               properties_hash = excluded.properties_hash,
               in_trash = ${freezeInTrash === true ? '_nds_row.in_trash' : 'excluded.in_trash'},
               moved_out = excluded.moved_out,
               local_delete_candidate = excluded.local_delete_candidate,
               observed_event_id = excluded.observed_event_id,
               observed_at = excluded.observed_at,
               updated_at = excluded.updated_at`,
          )
          .run(
            event.rootId,
            event.dataSourceId,
            event.pageId,
            event.propertiesHash,
            event.inTrash === true ? 1 : 0,
            payload?.movedOut === true ? 1 : 0,
            payload?.localDeleteCandidate === true ? 1 : 0,
            event.eventId,
            Schema.encodeSync(Schema.DateTimeUtcFromString)(event.observedAt),
            currentIso(this.#now),
          )

        if (event.bodyPointer !== undefined) {
          const path = decodeWorkspaceRelativePath(payload?.bodyPath ?? `page:${event.pageId}:body`)
          const safety = event.bodyPointer.safety
          const bodyProjectionPayload = encodeBodyProjectionPayload({
            _tag: 'BodyProjectionPayload',
            schemaVersion: 1,
            pointer: event.bodyPointer,
            safety,
            materialization: {
              path,
              sidecarIdentityProven: payload?.sidecarIdentityProven === true,
              ownWriteMaterializationIds: payload?.ownWriteMaterializationIds ?? [],
            },
          })
          const bodyHash = bodyPointerIdentityDigest(event.bodyPointer)
          this.#db
            .prepare(
              `INSERT INTO _nds_body_pointer (
                 root_id,
                 page_id,
                 path,
                 base_hash,
                 current_hash,
                 sidecar_identity_proven,
                 own_write_materialization_ids_json,
                 body_projection_json,
                 observed_event_id,
                 updated_at
               )
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(root_id, page_id) DO UPDATE SET
                 path = excluded.path,
                 current_hash = excluded.current_hash,
                 sidecar_identity_proven = excluded.sidecar_identity_proven,
                 own_write_materialization_ids_json = excluded.own_write_materialization_ids_json,
                 body_projection_json = excluded.body_projection_json,
                 observed_event_id = excluded.observed_event_id,
                 updated_at = excluded.updated_at`,
            )
            .run(
              event.rootId,
              event.pageId,
              path,
              bodyHash,
              bodyHash,
              payload?.sidecarIdentityProven === true ? 1 : 0,
              stringifyJson(payload?.ownWriteMaterializationIds ?? []),
              stringifyJson(bodyProjectionPayload),
              event.eventId,
              currentIso(this.#now),
            )
        }
        break
      }
      case 'RemoteWritePlanned':
        this.#db
          .prepare(
            `INSERT INTO _nds_outbox (
               root_id,
               command_id,
               command_key,
               intent_event_id,
               surface,
               command_tag,
               state,
               base_hash,
               desired_hash,
               preflight_json,
               attempt_count,
               lease_token,
               settlement_event_id,
               last_event_id,
               updated_at
             )
             VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, 0, NULL, NULL, ?, ?)
             ON CONFLICT(root_id, command_id) DO NOTHING`,
          )
          .run(
            event.rootId,
            event.commandId,
            event.commandKey,
            event.intentEventId,
            event.surface,
            event.commandTag,
            event.baseHash ?? null,
            event.desiredHash,
            stringifyJson(event.preflight),
            event.eventId,
            currentIso(this.#now),
          )
        break
      case 'RemoteWriteAttempted': {
        const existing = this.#db
          .prepare(
            `SELECT attempt_count, lease_token, settlement_event_id
             FROM _nds_outbox
             WHERE root_id = ? AND command_id = ?`,
          )
          .get(event.rootId, event.commandId)

        if (
          existing !== undefined &&
          readOptionalString({ row: existing, key: 'settlement_event_id' }) === undefined
        ) {
          const currentAttempt = Number(readInteger({ row: existing, key: 'attempt_count' }))
          const currentLeaseToken = readOptionalString({ row: existing, key: 'lease_token' })
          const eventMatchesCurrentLease =
            currentLeaseToken === undefined || event.leaseToken === currentLeaseToken

          if (event.attempt < currentAttempt) {
            break
          }

          if (event.attempt === currentAttempt && eventMatchesCurrentLease === false) {
            break
          }

          const retryAfterAt =
            event.attemptState === 'retryable' && event.retryAfterMillis !== undefined
              ? new Date(this.#now().getTime() + event.retryAfterMillis).toISOString()
              : null

          this.#db
            .prepare(
              `UPDATE _nds_outbox
               SET state = ?,
                   attempt_count = MAX(attempt_count, ?),
                   lease_token = ?,
                   retry_after_millis = ?,
                   retry_after_at = ?,
                   last_event_id = ?,
                   updated_at = ?
               WHERE root_id = ? AND command_id = ?`,
            )
            .run(
              event.attemptState,
              event.attempt,
              event.leaseToken ?? null,
              event.retryAfterMillis ?? null,
              retryAfterAt,
              event.eventId,
              currentIso(this.#now),
              event.rootId,
              event.commandId,
            )
        }
        break
      }
      case 'RemoteWriteSettled': {
        const existing = this.#db
          .prepare(
            `SELECT command_tag, state, desired_hash, attempt_count, settlement_event_id
             FROM _nds_outbox
             WHERE root_id = ? AND command_id = ?`,
          )
          .get(event.rootId, event.commandId)

        if (
          existing !== undefined &&
          readOptionalString({ row: existing, key: 'settlement_event_id' }) === undefined &&
          readString({ row: existing, key: 'command_tag' }) === event.commandTag &&
          readString({ row: existing, key: 'desired_hash' }) === event.desiredHash &&
          event.observedHash === event.desiredHash &&
          readInteger({ row: existing, key: 'attempt_count' }) > 0n &&
          (readOutboxState({ row: existing, key: 'state' }) === 'running' ||
            readOutboxState({ row: existing, key: 'state' }) === 'ambiguous')
        ) {
          this.#db
            .prepare(
              `UPDATE _nds_outbox
               SET state = 'settled',
                   lease_token = NULL,
                   settlement_event_id = ?,
                   last_event_id = ?,
                   updated_at = ?
               WHERE root_id = ?
                 AND command_id = ?
                 AND settlement_event_id IS NULL`,
            )
            .run(event.eventId, event.eventId, currentIso(this.#now), event.rootId, event.commandId)

          if (event.commandTag === 'BodyPush' && event.surface !== null) {
            const match = /^page:(?<pageId>.+):body$/u.exec(event.surface)
            const pageId = match?.groups?.pageId
            if (pageId !== undefined) {
              const currentBodyProjection = this.#db
                .prepare(
                  `SELECT body_projection_json
                   FROM _nds_body_pointer
                   WHERE root_id = ?
                     AND page_id = ?`,
                )
                .get(event.rootId, decodePageId(pageId))
              const currentBodyProjectionJson = readOptionalString({
                row: currentBodyProjection ?? {},
                key: 'body_projection_json',
              })
              const currentBodyProjectionPayload =
                currentBodyProjectionJson === undefined
                  ? undefined
                  : decodeBodyProjectionPayload(currentBodyProjectionJson)
              const bodyProjectionJson =
                event.bodyPointer === undefined || currentBodyProjectionPayload === undefined
                  ? undefined
                  : stringifyJson(
                      encodeBodyProjectionPayload({
                        _tag: 'BodyProjectionPayload',
                        schemaVersion: 1,
                        pointer: event.bodyPointer,
                        safety: event.bodyPointer.safety,
                        materialization: currentBodyProjectionPayload.materialization,
                      }),
                    )
              const projectionHash =
                event.bodyPointer === undefined
                  ? event.observedHash
                  : bodyPointerIdentityDigest(event.bodyPointer)
              this.#db
                .prepare(
                  `UPDATE _nds_body_pointer
                   SET base_hash = ?,
                       current_hash = ?,
                       body_projection_json = COALESCE(?, body_projection_json),
                       observed_event_id = ?,
                       updated_at = ?
                   WHERE root_id = ?
                     AND page_id = ?`,
                )
                .run(
                  projectionHash,
                  projectionHash,
                  bodyProjectionJson ?? null,
                  event.eventId,
                  currentIso(this.#now),
                  event.rootId,
                  decodePageId(pageId),
                )
            }
          }

          // F8: converge `_nds_row.in_trash` from the SETTLED LOCAL lifecycle
          // intent. This is driven by the settle we KNOW succeeded, independent of
          // remote-disappearance classification — so it holds on BOTH one-shot and
          // watch (the incremental scan never records a `remote_trash` tombstone),
          // and complements (does not replace) the tombstone path for
          // remote-initiated trash. Surface for Trash/Restore is `page:<pageId>`.
          if (
            (event.commandTag === 'TrashPage' || event.commandTag === 'RestorePage') &&
            event.surface !== null
          ) {
            const match = /^page:(?<pageId>[^:]+)$/u.exec(event.surface)
            const pageId = match?.groups?.pageId
            if (pageId !== undefined) {
              const decodedPageId = decodePageId(pageId)
              const inTrash = event.commandTag === 'TrashPage' ? 1 : 0
              this.#db
                .prepare(
                  `UPDATE _nds_row
                   SET in_trash = ?,
                       updated_at = ?
                   WHERE root_id = ? AND page_id = ?`,
                )
                .run(inTrash, currentIso(this.#now), event.rootId, decodedPageId)
              // #775 M2a'-2: a settled Trash/Restore re-establishes the local
              // lifecycle target L remotely, so any freeze-active `resolving`
              // lifecycle conflict on this page (raised by a `keep-local`
              // resolution) is now genuinely settled — transition it to
              // `resolved`. Only lifecycle keep-local ever reaches `resolving`, so
              // a page-scoped `state = 'resolving'` predicate is sufficient (no
              // kind JOIN). This piggybacks the in_trash reconvergence above, so it
              // replays deterministically in the same event-ordered apply.
              this.#db
                .prepare(
                  `UPDATE _nds_conflict
                   SET state = 'resolved',
                       updated_at = ?
                   WHERE root_id = ?
                     AND page_id = ?
                     AND state = 'resolving'`,
                )
                .run(currentIso(this.#now), event.rootId, decodedPageId)
              // On restore, clear the `remote_trash` tombstone so reprojection and
              // status no longer treat the now-active row as trashed. Scoped to
              // `remote_trash` — moved_out/inaccessible are not restorable trash.
              if (event.commandTag === 'RestorePage') {
                this.#db
                  .prepare(
                    `DELETE FROM _nds_tombstone
                     WHERE root_id = ? AND page_id = ? AND reason = 'remote_trash'`,
                  )
                  .run(event.rootId, decodedPageId)
              }
            }
          }
        }
        break
      }
      case 'ConflictRaised':
        this.#db
          .prepare(
            `INSERT INTO _nds_conflict (
               root_id,
               conflict_id,
               page_id,
               property_id,
               state,
               base_hash,
               local_hash,
               remote_hash,
               opened_event_id,
               resolution_event_id,
               updated_at
             )
             VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, NULL, ?)
             ON CONFLICT(root_id, conflict_id) DO NOTHING`,
          )
          .run(
            event.rootId,
            event.eventId,
            event.pageId,
            event.propertyId ?? null,
            event.baseHash,
            event.localHash,
            event.remoteHash,
            event.eventId,
            currentIso(this.#now),
          )
        break
      case 'ConflictResolved': {
        // Look up the opened `ConflictRaised` before the UPDATE so the resolution
        // target can depend on the conflict kind. A `keep-local` resolution of a
        // `lifecycle` conflict moves to `resolving` (NOT `resolved`): it re-asserts
        // the local target via a re-enqueued Trash/Restore push that may BLOCK
        // (tombstone-safety/DeleteVsEdit) if the remote actively diverged. Staying
        // `resolving` keeps the freeze active so `in_trash` cannot silently flip to
        // the remote value on the next sync (#775 M2a'-2). The F8 settle handler
        // transitions `resolving` -> `resolved` only once the re-assert genuinely
        // settles remotely (L re-established, divergence gone). All other cases
        // (property/body keep-local, and every keep-remote) go straight to
        // `resolved`.
        const resolveOpenedRow = this.#db
          .prepare(
            `SELECT opened.event_json
             FROM _nds_conflict conflict
             JOIN _nds_sync_event opened
               ON opened.root_id = conflict.root_id
              AND opened.event_id = conflict.opened_event_id
             WHERE conflict.root_id = ?
               AND conflict.conflict_id = ?`,
          )
          .get(event.rootId, event.conflictId)
        const resolveOpenedEvent =
          resolveOpenedRow === undefined
            ? undefined
            : decodeEventFromJson(readString({ row: resolveOpenedRow, key: 'event_json' }))
        const isLifecycleKeepLocal =
          event.resolutionChoice === 'keep-local' &&
          resolveOpenedEvent?._tag === 'ConflictRaised' &&
          resolveOpenedEvent.conflictKind === 'lifecycle'
        const resolvedState = isLifecycleKeepLocal === true ? 'resolving' : 'resolved'
        this.#db
          .prepare(
            `UPDATE _nds_conflict
             SET state = ?,
                 resolution_event_id = ?,
                 updated_at = ?
             WHERE root_id = ?
               AND conflict_id = ?
               AND state = 'open'`,
          )
          .run(resolvedState, event.eventId, currentIso(this.#now), event.rootId, event.conflictId)

        // Lifecycle keep-remote reconvergence (decision 0026). A lifecycle
        // conflict froze `_nds_row.in_trash` at the settled local target. On
        // `keep-remote` the projection must adopt the remote trash state recorded
        // on the opened `ConflictRaised` (`remoteInTrash`) — read from the recorded
        // boolean, never from the frozen `_nds_row.in_trash`. This is replay-pure
        // and deterministic; `keep-local` re-asserts the local target through a
        // re-enqueued Trash/Restore push that reconverges via the F8 settle handler.
        if (event.resolutionChoice === 'keep-remote') {
          const openedEvent = resolveOpenedEvent
          if (openedEvent !== undefined) {
            if (
              openedEvent._tag === 'ConflictRaised' &&
              openedEvent.conflictKind === 'lifecycle' &&
              openedEvent.remoteInTrash !== undefined
            ) {
              const remoteInTrash = openedEvent.remoteInTrash
              this.#db
                .prepare(
                  `UPDATE _nds_row
                   SET in_trash = ?,
                       updated_at = ?
                   WHERE root_id = ? AND page_id = ?`,
                )
                .run(
                  remoteInTrash === true ? 1 : 0,
                  currentIso(this.#now),
                  event.rootId,
                  event.pageId,
                )
              // Mirror the F8 restore arm: when the remote target is active, clear
              // the `remote_trash` tombstone so status and reprojection no longer
              // treat the now-active row as trashed.
              if (remoteInTrash === false) {
                this.#db
                  .prepare(
                    `DELETE FROM _nds_tombstone
                     WHERE root_id = ? AND page_id = ? AND reason = 'remote_trash'`,
                  )
                  .run(event.rootId, event.pageId)
              }
            }

            // Body keep-remote re-materialization intent (decision 0021). Body is
            // single-surface and adapter-owned: keep-remote accepts the remote body
            // and DROPS the local `.nmd` divergence. There is no engine-owned
            // mergeable value to reconverge in the projection (body is content), so
            // the intent is recorded by clearing `sidecar_identity_proven` on the
            // body pointer — the local sidecar is no longer trusted, so the next
            // pull re-materializes the `.nmd` from the remote observation (a deferred
            // remote effect, exactly as the lifecycle arm defers its reconvergence).
            // The conflict is already retired to `resolved` above.
            if (openedEvent._tag === 'ConflictRaised' && openedEvent.conflictKind === 'body') {
              this.#db
                .prepare(
                  `UPDATE _nds_body_pointer
                   SET sidecar_identity_proven = 0,
                       updated_at = ?
                   WHERE root_id = ? AND page_id = ?`,
                )
                .run(currentIso(this.#now), event.rootId, event.pageId)
            }
          }
        }
        break
      }
      case 'TombstoneCandidateObserved':
        const queryAbsencePayload = decodePayload({
          event: event,
          decode: decodeQueryAbsenceProjectionPayload,
        })
        if (queryAbsencePayload?.directRetrieve === 'accessible') {
          if (
            queryAbsencePayload.dataSourceId !== undefined &&
            queryAbsencePayload.queryContractHash !== undefined
          ) {
            this.#db
              .prepare(
                `DELETE FROM _nds_tombstone
                 WHERE root_id = ?
                   AND page_id = ?
                   AND event_id IN (
                     SELECT evidence_event_id
                     FROM _nds_query_absence
                     WHERE root_id = ?
                       AND data_source_id = ?
                       AND page_id = ?
                       AND query_contract_hash = ?
                   )`,
              )
              .run(
                event.rootId,
                event.pageId,
                event.rootId,
                queryAbsencePayload.dataSourceId,
                event.pageId,
                queryAbsencePayload.queryContractHash,
              )
          }
        } else {
          this.#db
            .prepare(
              `INSERT INTO _nds_tombstone (
                 root_id,
                 page_id,
                 classification,
                 reason,
                 event_id,
                 updated_at
               )
               VALUES (?, ?, 'unclassified', ?, ?, ?)
               ON CONFLICT(root_id, page_id) DO UPDATE SET
                 classification = 'unclassified',
                 reason = excluded.reason,
                 event_id = excluded.event_id,
                 updated_at = excluded.updated_at
               WHERE _nds_tombstone.classification = 'unclassified'`,
            )
            .run(event.rootId, event.pageId, event.reason, event.eventId, currentIso(this.#now))
        }
        this.#applyQueryAbsenceEvidence({ event, defaultClassified: false })
        break
      case 'TombstoneRecorded':
        this.#db
          .prepare(
            `INSERT INTO _nds_tombstone (
               root_id,
               page_id,
               classification,
               reason,
               event_id,
               updated_at
             )
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(root_id, page_id) DO UPDATE SET
               classification = excluded.classification,
               reason = excluded.reason,
               event_id = excluded.event_id,
               updated_at = excluded.updated_at`,
          )
          .run(
            event.rootId,
            event.pageId,
            event.reason,
            event.reason,
            event.eventId,
            currentIso(this.#now),
          )
        // F8: a remote trash must reproject as `in_trash = 1` so the row stays a
        // RESTORABLE row. `RowObserved` is the only other writer of `_nds_row.in_trash`,
        // but a trashed page drops out of `data_source.query`, so without this the row
        // would reproject to `in_trash = 0` and a 1->0 restore transition becomes
        // inexpressible. Scoped strictly to `remote_trash`; moved_out/inaccessible/unknown
        // are removals from scope, not restorable trash.
        //
        // Lifecycle-conflict suppression (decision 0026, tombstone direction): when
        // an open `lifecycle` conflict exists for this page, the remote trash must
        // NOT silently flip the settled local restore target (in_trash = 0) to 1 —
        // keep the existing `in_trash`. Same gate the `RowObserved` apply uses, and
        // replay-pure: the gating `ConflictRaised` is persisted at a LOWER sequence
        // (appended at detection time), so reprojection sees the open conflict
        // before this tombstone applies.
        if (
          event.reason === 'remote_trash' &&
          this.#hasOpenLifecycleConflict({ rootId: event.rootId, pageId: event.pageId }) === false
        ) {
          this.#db
            .prepare(
              `UPDATE _nds_row
               SET in_trash = 1,
                   updated_at = ?
               WHERE root_id = ? AND page_id = ?`,
            )
            .run(currentIso(this.#now), event.rootId, event.pageId)
        }
        this.#applyQueryAbsenceEvidence({ event, defaultClassified: true })
        break
      case 'GuardBlocked':
        this.#db
          .prepare(
            `INSERT INTO _nds_guard_block (
               root_id,
               block_id,
               surface,
               guard,
               message,
               event_id,
               updated_at
             )
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(root_id, block_id) DO UPDATE SET
               surface = excluded.surface,
               guard = excluded.guard,
               message = excluded.message,
               event_id = excluded.event_id,
               updated_at = excluded.updated_at`,
          )
          .run(
            event.rootId,
            event.idempotencyKey,
            event.surface ?? null,
            event.guard,
            event.message,
            event.eventId,
            currentIso(this.#now),
          )
        break
      case 'PathClaimed':
        this.#db
          .prepare(
            `INSERT INTO _nds_path_claim (
               root_id,
               relative_path,
               page_id,
               state,
               claim_event_id,
               updated_at
             )
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(root_id, relative_path) DO UPDATE SET
               page_id = excluded.page_id,
               state = excluded.state,
               claim_event_id = excluded.claim_event_id,
               updated_at = excluded.updated_at`,
          )
          .run(
            event.rootId,
            event.relativePath,
            event.pageId,
            event.claimState,
            event.eventId,
            currentIso(this.#now),
          )
        break
      case 'RowForgotten':
        this.#db
          .prepare(`DELETE FROM _nds_row WHERE root_id = ? AND page_id = ?`)
          .run(event.rootId, event.pageId)
        this.#db
          .prepare(`DELETE FROM _nds_property_shadow WHERE root_id = ? AND page_id = ?`)
          .run(event.rootId, event.pageId)
        this.#db
          .prepare(`DELETE FROM _nds_body_pointer WHERE root_id = ? AND page_id = ?`)
          .run(event.rootId, event.pageId)
        this.#db
          .prepare(`DELETE FROM _nds_tombstone WHERE root_id = ? AND page_id = ?`)
          .run(event.rootId, event.pageId)
        this.#db
          .prepare(`DELETE FROM _nds_query_absence WHERE root_id = ? AND page_id = ?`)
          .run(event.rootId, event.pageId)
        this.#db
          .prepare(`DELETE FROM _nds_path_claim WHERE root_id = ? AND page_id = ?`)
          .run(event.rootId, event.pageId)
        this.#db
          .prepare(
            `UPDATE _nds_outbox
             SET state = 'fenced',
                 lease_token = NULL,
                 last_event_id = ?,
                 updated_at = ?
             WHERE root_id = ?
               AND settlement_event_id IS NULL
               AND (
                 surface = ?
                 OR surface LIKE ?
               )`,
          )
          .run(
            event.eventId,
            currentIso(this.#now),
            event.rootId,
            `page:${event.pageId}`,
            `page:${event.pageId}:%`,
          )
        // A forgotten page leaves sync scope entirely, so any unsettled conflict
        // on it (including a freeze-active `resolving` lifecycle conflict, #775
        // M2a'-2) is ignored.
        this.#db
          .prepare(
            `UPDATE _nds_conflict
             SET state = 'ignored',
                 resolution_event_id = ?,
                 updated_at = ?
             WHERE root_id = ?
               AND page_id = ?
               AND state IN ('open', 'resolving')`,
          )
          .run(event.eventId, currentIso(this.#now), event.rootId, event.pageId)
        break
      case 'QueryScanCheckpointRecorded': {
        const payload = decodePayload({
          event: event,
          decode: decodeQueryCheckpointProjectionPayload,
        })
        this.#db
          .prepare(
            `INSERT INTO _nds_query_scan_checkpoint (
               root_id,
               data_source_id,
               query_contract_hash,
               next_cursor,
               complete,
               capped_at_limit,
               contract_changed,
               high_watermark,
               event_id,
               updated_at
             )
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(root_id, data_source_id, query_contract_hash) DO UPDATE SET
               next_cursor = excluded.next_cursor,
               complete = excluded.complete,
               capped_at_limit = excluded.capped_at_limit,
               contract_changed = excluded.contract_changed,
               high_watermark = excluded.high_watermark,
               event_id = excluded.event_id,
               updated_at = excluded.updated_at`,
          )
          .run(
            event.rootId,
            event.dataSourceId,
            event.queryContractHash,
            event.nextCursor ?? null,
            event.complete === true ? 1 : 0,
            payload?.cappedAtLimit === true ? 1 : 0,
            payload?.contractChanged === true ? 1 : 0,
            event.highWatermark === null
              ? null
              : Schema.encodeSync(Schema.DateTimeUtcFromString)(event.highWatermark),
            event.eventId,
            currentIso(this.#now),
          )
        if (event.complete === true) {
          this.#db
            .prepare(
              `DELETE FROM _nds_query_scan_checkpoint
               WHERE root_id = ?
                 AND data_source_id = ?
                 AND query_contract_hash != ?
                 AND NOT EXISTS (
                   SELECT 1
                   FROM _nds_query_absence absence
                   WHERE absence.root_id = _nds_query_scan_checkpoint.root_id
                     AND absence.data_source_id = _nds_query_scan_checkpoint.data_source_id
                     AND absence.query_contract_hash = _nds_query_scan_checkpoint.query_contract_hash
                 )`,
            )
            .run(event.rootId, event.dataSourceId, event.queryContractHash)
        }
        break
      }
      case 'PagePropertyCheckpointRecorded': {
        const payload = decodePayload({
          event: event,
          decode: decodePropertyCheckpointProjectionPayload,
        })
        this.#db
          .prepare(
            `INSERT INTO _nds_page_property_checkpoint (
               root_id,
               page_id,
               property_id,
               next_cursor,
               complete,
               value_hash,
               event_id,
               updated_at
             )
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(root_id, page_id, property_id) DO UPDATE SET
               next_cursor = excluded.next_cursor,
               complete = excluded.complete,
               value_hash = excluded.value_hash,
               event_id = excluded.event_id,
               updated_at = excluded.updated_at`,
          )
          .run(
            event.rootId,
            event.pageId,
            event.propertyId,
            event.nextCursor ?? null,
            event.complete === true ? 1 : 0,
            event.valueHash ?? null,
            event.eventId,
            currentIso(this.#now),
          )
        if (event.valueHash !== undefined) {
          this.#db
            .prepare(
              `INSERT INTO _nds_property_shadow (
                 root_id,
                 page_id,
                 property_id,
                 base_hash,
                 remote_hash,
                 availability,
                 observed_event_id,
                 updated_at
               )
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(root_id, page_id, property_id) DO UPDATE SET
                 base_hash = CASE
                   WHEN NOT EXISTS (
                     SELECT 1
                     FROM _nds_outbox pending
                     WHERE pending.root_id = excluded.root_id
                       AND pending.command_tag = 'PatchPageProperties'
                       AND pending.surface = ?
                       AND pending.settlement_event_id IS NULL
                       AND pending.state IN ('queued', 'running', 'retryable', 'blocked', 'ambiguous')
                   )
                     THEN excluded.remote_hash
                   ELSE _nds_property_shadow.base_hash
                 END,
                 remote_hash = excluded.remote_hash,
                 availability = excluded.availability,
                 observed_event_id = excluded.observed_event_id,
                 updated_at = excluded.updated_at`,
            )
            .run(
              event.rootId,
              event.pageId,
              event.propertyId,
              payload?.baseHash ?? event.valueHash,
              event.valueHash,
              payload?.availability ??
                (event.complete === true ? 'complete' : 'paginated-incomplete'),
              event.eventId,
              currentIso(this.#now),
              propertySurfaceKey({ pageId: event.pageId, propertyId: event.propertyId }),
            )
        } else {
          this.#db
            .prepare(
              `UPDATE _nds_property_shadow
               SET availability = ?,
                   observed_event_id = ?,
                   updated_at = ?
               WHERE root_id = ?
                 AND page_id = ?
                 AND property_id = ?`,
            )
            .run(
              payload?.availability ??
                (event.complete === true ? 'complete' : 'paginated-incomplete'),
              event.eventId,
              currentIso(this.#now),
              event.rootId,
              event.pageId,
              event.propertyId,
            )
        }
        break
      }
      case 'LocalIntentAccepted':
      case 'DecodeDriftBlocked':
        break
    }
  }
}

/** Open (or create) a `NotionSyncStore` at the given path, running any pending schema migrations. */
export const openNotionSyncStore = (options: OpenNotionSyncStoreOptions): NotionSyncStore =>
  new NotionSyncStore(options)
