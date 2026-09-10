import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Schema } from 'effect'

import {
  bodySurfaceKey,
  databaseMetadataSurfaceKey,
  dataSourceMetadataSurfaceKey,
  dataSourceMetadataHash,
  pageSurfaceKey,
  propertySurfaceKey,
  schemaSurfaceKey,
} from '../core/canonical.ts'
import {
  BodyPushCommand,
  CanonicalDataSourceMetadata,
  CanonicalPropertyValue,
  CreatePageCommand,
  PatchDatabaseMetadataCommand,
  PatchDataSourceMetadataCommand,
  PatchPagePropertiesCommand,
  RestorePageCommand,
  TrashPageCommand,
} from '../core/commands.ts'
import {
  CommandId,
  DatabaseId,
  DataSourceId,
  Hash,
  PageId,
  PropertyId,
  WorkspaceRelativePath,
} from '../core/domain.ts'
import { IdempotencyKey, SyncEventId, type SyncRootId } from '../core/events.ts'
import type { AuthorityMode } from '../local/manifest.ts'
import { convergenceFormHash } from '../planner/nmd-property-facts.ts'
import type { PlanDecision, PlannerIntent } from '../planner/planner.ts'
import { resolveConflictCommand } from '../planner/user-commands.ts'
import { BodyProjectionPayload, hashStoreBytes, pageLifecycleHash } from '../store/projections.ts'
import type { NotionSyncStore } from '../store/store.ts'

type SqlRow = Record<string, unknown>
const decodeBodyProjectionPayloadJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(BodyProjectionPayload),
)

/** Schema version stored in the replica's `PRAGMA user_version`. */
export const replicaSchemaVersion = 1

/** Inputs for projecting the sync store into a user-facing SQLite replica. */
export type ProjectReplicaOptions = {
  readonly syncStorePath: string
  readonly replicaPath: string
  readonly rootId: SyncRootId
}

/** Local replica change row representing a pending CDC entry awaiting planning. */
export type ReplicaLocalChange = {
  readonly changeId: string
  readonly kind:
    | 'cell_patch'
    | 'row_archive'
    | 'row_restore'
    | 'row_create'
    | 'body_patch'
    | 'metadata_patch'
    | 'schema_patch'
    | 'file_attach'
    | 'view_change'
    | 'conflict_resolution'
  readonly dataSourceId: string
  readonly pageId: string | undefined
  readonly propertyId: string | undefined
  readonly valueJson: string | undefined
  readonly baseHash: string | undefined
  readonly status: string
  readonly bodyPath: string | undefined
  readonly localBodyHash: string | undefined
  readonly localBodyContent: string | undefined
  readonly metadataResourceType: string | undefined
  readonly databaseId: string | undefined
  readonly titlePlainText: string | undefined
  readonly descriptionPlainText: string | undefined
  readonly schemaOperationJson: string | undefined
  readonly fileAssetId: string | undefined
  readonly fileAction: string | undefined
  readonly fileName: string | undefined
  readonly fileExternalUrl: string | undefined
  readonly conflictId: string | undefined
  readonly resolutionAction: string | undefined
  readonly localRowId: string | undefined
  readonly clientRequestKey: string | undefined
  readonly remotePageId: string | undefined
}

type ReplicaChangeStatus =
  | 'pending'
  | 'queued'
  | 'planned'
  | 'applied'
  | 'conflict'
  | 'unsupported'
  | 'rejected'
  | 'needs_reconciliation'

/** Inputs for marking user-selected replica conflict resolutions as settled in the local replica. */
export type ApplyReplicaConflictResolutionsOptions = {
  readonly changes: readonly ReplicaLocalChange[]
  readonly replicaPath: string
  readonly store: NotionSyncStore
  readonly rootId: SyncRootId
  readonly dryRun?: boolean
  /**
   * Workspace-wide authority mode (decisions 0015, 0019), forwarded to
   * `resolveConflictCommand`. Today CDC `conflict_resolution` rows only ever
   * resolve `keep-remote` (local/manual actions short-circuit as `unsupported`
   * before planning), and `keep-remote` enqueues no remote write — so no drift
   * can occur yet. Threading the mode here keeps the CDC path consistent with the
   * `conflicts resolve` command and fails closed (`RemoteAuthoritativeDrift`) the
   * moment local/manual CDC resolution becomes executable.
   */
  readonly authorityMode?: AuthorityMode
}

/** Inputs for reconciling planner decisions back into local replica change rows. */
export type SettleReplicaChangesOptions = {
  readonly changes: readonly ReplicaLocalChange[]
  readonly replicaPath: string
  readonly store: NotionSyncStore
  readonly rootId: SyncRootId
  readonly decisions: readonly PlanDecision[]
  readonly dryRun?: boolean
}

const readString = ({ row, key }: { readonly row: SqlRow; readonly key: string }): string => {
  const value = row[key]
  if (typeof value !== 'string') throw new Error(`Expected SQLite column ${key} to be a string`)
  return value
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
  if (typeof value !== 'string') throw new Error(`Expected SQLite column ${key} to be a string`)
  return value
}

const ensureReplicaColumn = ({
  db,
  table,
  column,
  definition,
}: {
  readonly db: DatabaseSync
  readonly table: string
  readonly column: string
  readonly definition: string
}): void => {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as SqlRow[]
  const exists = columns.some((row) => readString({ row, key: 'name' }) === column)
  if (exists === false) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}

const readNumber = ({ row, key }: { readonly row: SqlRow; readonly key: string }): number => {
  const value = row[key]
  if (typeof value !== 'number') throw new Error(`Expected SQLite column ${key} to be a number`)
  return value
}

const decode = <TSchema extends Schema.Codec<any, any, never>>({
  schema,
  value,
}: {
  readonly schema: TSchema
  readonly value: unknown
}): typeof schema.Type => Schema.decodeUnknownSync(schema)(value)

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`
const quoteStringLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`

const pagesViewName = 'pages'
const schemaViewName = 'schema'
const schemaPropertiesViewName = 'schema_properties'
const changesViewName = 'changes'
const conflictsViewName = 'conflicts'
const syncStatusViewName = 'sync_status'
const pendingReplicaChangeStatusesSql = "'pending', 'queued', 'planned'"
const pendingReplicaChangesCountSql = `(SELECT count(*) FROM ${quoteIdentifier(changesViewName)} WHERE status IN (${pendingReplicaChangeStatusesSql}))`
// `resolving` is a frozen-but-unresolved lifecycle conflict (keep-local awaiting a
// settled re-assert); it must count as not-clean so the public conflicts_open count
// and the `conflicted` workspace status reflect it, matching the main store's
// freeze/compaction/status surfaces (#775 M2a').
const openReplicaConflictsCountSql = `(SELECT count(*) FROM _nds_replica_conflicts WHERE state IN ('open', 'resolving'))`

const rowsSystemColumns = [
  '_page_id',
  '_data_source_id',
  '_local_page_id',
  '_client_request_key',
  '_origin',
  '_properties_hash',
  '_in_trash',
  '_moved_out',
  '_local_delete_candidate',
  '_sync_status',
  '_observed_event_id',
  '_observed_at',
  '_updated_at',
] as const

const sqliteKeywords = new Set([
  'ABORT',
  'ACTION',
  'ADD',
  'AFTER',
  'ALL',
  'ALTER',
  'ANALYZE',
  'AND',
  'AS',
  'ASC',
  'ATTACH',
  'AUTOINCREMENT',
  'BEFORE',
  'BEGIN',
  'BETWEEN',
  'BY',
  'CASCADE',
  'CASE',
  'CAST',
  'CHECK',
  'COLLATE',
  'COLUMN',
  'COMMIT',
  'CONFLICT',
  'CONSTRAINT',
  'CREATE',
  'CROSS',
  'CURRENT_DATE',
  'CURRENT_TIME',
  'CURRENT_TIMESTAMP',
  'DATABASE',
  'DEFAULT',
  'DEFERRABLE',
  'DEFERRED',
  'DELETE',
  'DESC',
  'DETACH',
  'DISTINCT',
  'DROP',
  'EACH',
  'ELSE',
  'END',
  'ESCAPE',
  'EXCEPT',
  'EXCLUSIVE',
  'EXISTS',
  'EXPLAIN',
  'FAIL',
  'FOR',
  'FOREIGN',
  'FROM',
  'FULL',
  'GLOB',
  'GROUP',
  'HAVING',
  'IF',
  'IGNORE',
  'IMMEDIATE',
  'IN',
  'INDEX',
  'INDEXED',
  'INITIALLY',
  'INNER',
  'INSERT',
  'INSTEAD',
  'INTERSECT',
  'INTO',
  'IS',
  'ISNULL',
  'JOIN',
  'KEY',
  'LEFT',
  'LIKE',
  'LIMIT',
  'MATCH',
  'NATURAL',
  'NO',
  'NOT',
  'NOTNULL',
  'NULL',
  'OF',
  'OFFSET',
  'ON',
  'OR',
  'ORDER',
  'OUTER',
  'PLAN',
  'PRAGMA',
  'PRIMARY',
  'QUERY',
  'RAISE',
  'RECURSIVE',
  'REFERENCES',
  'REGEXP',
  'REINDEX',
  'RELEASE',
  'RENAME',
  'REPLACE',
  'RESTRICT',
  'RETURNING',
  'RIGHT',
  'ROLLBACK',
  'ROW',
  'ROWS',
  'SAVEPOINT',
  'SELECT',
  'SET',
  'TABLE',
  'TEMP',
  'TEMPORARY',
  'THEN',
  'TO',
  'TRANSACTION',
  'TRIGGER',
  'UNION',
  'UNIQUE',
  'UPDATE',
  'USING',
  'VACUUM',
  'VALUES',
  'VIEW',
  'VIRTUAL',
  'WHEN',
  'WHERE',
  'WINDOW',
  'WITH',
  'WITHOUT',
])

const slugForView = (value: string): string => {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
  return slug.length === 0 ? 'data_source' : slug
}

/**
 * Install the replica schema + CDC triggers (DROP/CREATE TABLE/VIEW/TRIGGER,
 * ALTER migrations, backfill INSERTs, and `PRAGMA user_version`).
 *
 * Assumes an active write transaction: the caller is responsible for the
 * surrounding `BEGIN`/`COMMIT`/`ROLLBACK` so the whole schema commits
 * atomically. The connection-level PRAGMAs that cannot run inside a
 * transaction (`foreign_keys`, `journal_mode = WAL`) are applied by the
 * `createReplicaSchema` entry point, not here; only `PRAGMA user_version`
 * (which commits with the schema) stays inside this DDL.
 */
export const createReplicaSchemaInTransaction = (db: DatabaseSync): void => {
  const localChangesSchema = db
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = '_nds_replica_local_changes'`,
    )
    .get() as SqlRow | undefined
  const needsLocalChangesStatusMigration =
    typeof localChangesSchema?.sql === 'string' &&
    (!localChangesSchema.sql.includes("'rejected'") ||
      !localChangesSchema.sql.includes("'queued'") ||
      !localChangesSchema.sql.includes("'body_patch'") ||
      !localChangesSchema.sql.includes("'metadata_patch'") ||
      !localChangesSchema.sql.includes("'schema_patch'") ||
      !localChangesSchema.sql.includes("'file_attach'") ||
      !localChangesSchema.sql.includes("'view_change'") ||
      !localChangesSchema.sql.includes("'conflict_resolution'"))
  if (needsLocalChangesStatusMigration === true) {
    db.exec(`ALTER TABLE _nds_replica_local_changes RENAME TO _nds_replica_local_changes_legacy;`)
  }

  // SM5c: add the name-only `convergence_hash` column to a pre-existing replica
  // (the table is fully DELETE+re-INSERTed on every projection, so a nullable
  // add backfills on the next projection — no data migration needed).
  const cellsSchema = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = '_nds_replica_cells'`)
    .get() as SqlRow | undefined
  if (
    typeof cellsSchema?.sql === 'string' &&
    cellsSchema.sql.includes('convergence_hash') === false
  ) {
    db.exec(`ALTER TABLE _nds_replica_cells ADD COLUMN convergence_hash TEXT;`)
  }

  db.exec(`
    DROP TRIGGER IF EXISTS _nds_replica_cells_direct_value_update_intent;
    DROP TRIGGER IF EXISTS _nds_replica_cells_guard_direct_value_update;
    DROP TRIGGER IF EXISTS _nds_replica_cells_guard_direct_value_shape;
    DROP TRIGGER IF EXISTS _nds_replica_cells_guard_direct_complex_update;
    DROP TRIGGER IF EXISTS _nds_replica_cells_guard_direct_relation_update;
    DROP TRIGGER IF EXISTS _nds_replica_cells_block_identity_update;
    DROP TRIGGER IF EXISTS _nds_replica_cells_block_delete;
    DROP TRIGGER IF EXISTS _nds_replica_rows_archive_restore_intent;
    DROP TRIGGER IF EXISTS _nds_replica_rows_block_insert;
    DROP TRIGGER IF EXISTS _nds_replica_rows_block_identity_update;
    DROP TRIGGER IF EXISTS _nds_replica_rows_block_delete;
    DROP TRIGGER IF EXISTS _nds_replica_local_changes_mirror_cell_insert;
    DROP TRIGGER IF EXISTS _nds_replica_local_changes_mirror_row_insert;
    DROP TRIGGER IF EXISTS _nds_replica_cell_changes_mirror_local_insert;
    DROP TRIGGER IF EXISTS _nds_replica_row_changes_mirror_local_insert;
    DROP TRIGGER IF EXISTS _nds_replica_cell_changes_mirror_local_update;
    DROP TRIGGER IF EXISTS _nds_replica_row_changes_mirror_local_update;
    DROP TRIGGER IF EXISTS _nds_replica_row_creates_mirror_row_change_insert;
    DROP TRIGGER IF EXISTS _nds_replica_row_creates_mirror_row_change_update;
    DROP TRIGGER IF EXISTS _nds_replica_body_changes_mirror_local_insert;
    DROP TRIGGER IF EXISTS _nds_replica_body_changes_mirror_local_update;
    DROP TRIGGER IF EXISTS _nds_replica_metadata_changes_mirror_local_insert;
    DROP TRIGGER IF EXISTS _nds_replica_metadata_changes_mirror_local_update;
    DROP TRIGGER IF EXISTS _nds_replica_schema_changes_mirror_local_insert;
    DROP TRIGGER IF EXISTS _nds_replica_schema_changes_mirror_local_update;
    DROP TRIGGER IF EXISTS _nds_replica_file_changes_mirror_local_insert;
    DROP TRIGGER IF EXISTS _nds_replica_file_changes_mirror_local_update;
    DROP TRIGGER IF EXISTS _nds_replica_view_changes_mirror_local_insert;
    DROP TRIGGER IF EXISTS _nds_replica_view_changes_mirror_local_update;
    DROP TRIGGER IF EXISTS _nds_replica_conflict_resolutions_mirror_local_insert;
    DROP TRIGGER IF EXISTS _nds_replica_conflict_resolutions_mirror_local_update;
    DROP VIEW IF EXISTS debug_bodies;
    DROP VIEW IF EXISTS debug_cells;
    DROP VIEW IF EXISTS debug_data_sources;
    DROP VIEW IF EXISTS debug_databases;
    DROP VIEW IF EXISTS debug_views;
    DROP VIEW IF EXISTS ${quoteIdentifier(syncStatusViewName)};
    DROP VIEW IF EXISTS ${quoteIdentifier(conflictsViewName)};
    DROP VIEW IF EXISTS ${quoteIdentifier(changesViewName)};
    DROP VIEW IF EXISTS ${quoteIdentifier(schemaPropertiesViewName)};
    DROP VIEW IF EXISTS ${quoteIdentifier(schemaViewName)};

    PRAGMA user_version = ${replicaSchemaVersion.toString()};

    CREATE TABLE IF NOT EXISTS _nds_replica_data_sources (
      data_source_id TEXT PRIMARY KEY,
      root_id TEXT NOT NULL,
      parent_database_id TEXT,
      schema_hash TEXT NOT NULL,
      metadata_hash TEXT,
      metadata_json TEXT,
      title_plain_text TEXT,
      description_plain_text TEXT,
      observed_event_id TEXT NOT NULL,
      observed_at TEXT,
      updated_at TEXT NOT NULL,
      -- Materialized from the control-plane _nds_workspace_binding at projection
      -- time so the public schema view stays standalone-queryable once the
      -- control plane moves to .notion/v1/state.sqlite (DD-A/DD-B, decision 0020).
      workspace_binding_database_id TEXT,
      workspace_root TEXT
    );

    CREATE TABLE IF NOT EXISTS _nds_replica_databases (
      database_id TEXT PRIMARY KEY,
      data_source_id TEXT NOT NULL,
      root_id TEXT NOT NULL,
      metadata_hash TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      title_plain_text TEXT,
      description_plain_text TEXT,
      observed_event_id TEXT NOT NULL,
      observed_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS _nds_replica_properties (
      data_source_id TEXT NOT NULL,
      property_id TEXT NOT NULL,
      property_name TEXT NOT NULL,
      property_type TEXT NOT NULL,
      config_hash TEXT NOT NULL,
      schema_hash TEXT NOT NULL,
      write_class TEXT NOT NULL,
      schema_ordinal INTEGER NOT NULL DEFAULT 0,
      config_json TEXT,
      observed_event_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (data_source_id, property_id)
    );

    CREATE TABLE IF NOT EXISTS _nds_replica_property_column_plan (
      data_source_id TEXT NOT NULL,
      property_id TEXT NOT NULL,
      property_name TEXT NOT NULL,
      column_name TEXT NOT NULL,
      property_type TEXT NOT NULL,
      write_class TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      is_scalar_read_supported INTEGER NOT NULL CHECK (is_scalar_read_supported IN (0, 1)),
      is_rows_write_supported INTEGER NOT NULL CHECK (is_rows_write_supported IN (0, 1)),
      null_write_behavior TEXT NOT NULL,
      config_json TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (data_source_id, property_id),
      UNIQUE (data_source_id, column_name)
    );

    CREATE TABLE IF NOT EXISTS _nds_replica_views (
      view_id TEXT PRIMARY KEY,
      database_id TEXT NOT NULL,
      data_source_id TEXT NOT NULL,
      root_id TEXT NOT NULL,
      view_name TEXT NOT NULL,
      view_type TEXT NOT NULL,
      view_hash TEXT NOT NULL,
      view_json TEXT NOT NULL,
      observed_event_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS _nds_replica_rows (
      data_source_id TEXT NOT NULL,
      page_id TEXT PRIMARY KEY,
      properties_hash TEXT NOT NULL,
      in_trash INTEGER NOT NULL CHECK (in_trash IN (0, 1)),
      moved_out INTEGER NOT NULL CHECK (moved_out IN (0, 1)),
      local_delete_candidate INTEGER NOT NULL CHECK (local_delete_candidate IN (0, 1)),
      observed_event_id TEXT NOT NULL,
      observed_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS _nds_replica_cells (
      data_source_id TEXT NOT NULL,
      page_id TEXT NOT NULL,
      property_id TEXT NOT NULL,
      property_name TEXT NOT NULL,
      property_type TEXT NOT NULL,
      value_json TEXT,
      value_text TEXT,
      value_number REAL,
      value_boolean INTEGER CHECK (value_boolean IN (0, 1) OR value_boolean IS NULL),
      base_hash TEXT NOT NULL,
      remote_hash TEXT NOT NULL,
      -- Name-only convergence hash of the observed value (id/color stripped from
      -- select/status options, cleared number/date folded to empty), so the
      -- pristine base compares in the SAME space the .nmd frontmatter surface can
      -- reach. Distinct from remote_hash (the full-canonical remote-write base).
      -- SM5c local convergence; see convergenceFormHash.
      convergence_hash TEXT,
      availability TEXT NOT NULL,
      write_class TEXT NOT NULL,
      observed_event_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (page_id, property_id)
    );

    CREATE TABLE IF NOT EXISTS _nds_replica_relation_targets (
      data_source_id TEXT NOT NULL,
      property_id TEXT NOT NULL,
      target_page_id TEXT NOT NULL,
      observed_from_page_id TEXT NOT NULL,
      observed_event_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (data_source_id, property_id, target_page_id)
    );

    CREATE TABLE IF NOT EXISTS _nds_replica_bodies (
      page_id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      base_hash TEXT NOT NULL,
      current_hash TEXT NOT NULL,
      sidecar_identity_proven INTEGER NOT NULL,
      body_projection_json TEXT NOT NULL,
      observed_event_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS _nds_replica_cell_changes (
      change_id TEXT PRIMARY KEY,
      data_source_id TEXT NOT NULL,
      page_id TEXT NOT NULL,
      property_id TEXT NOT NULL,
      value_json TEXT NOT NULL,
      base_hash TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending',
        'queued',
        'planned',
        'applied',
        'conflict',
        'unsupported',
        'rejected',
        'needs_reconciliation'
      )),
      unsupported_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS _nds_replica_row_changes (
      change_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('row_archive', 'row_restore', 'row_create')),
      data_source_id TEXT NOT NULL,
      page_id TEXT,
      value_json TEXT,
      base_hash TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending',
        'queued',
        'planned',
        'applied',
        'conflict',
        'unsupported',
        'rejected',
        'needs_reconciliation'
      )),
      unsupported_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS _nds_replica_row_creates (
      change_id TEXT PRIMARY KEY,
      data_source_id TEXT NOT NULL,
      local_row_id TEXT NOT NULL,
      client_request_key TEXT NOT NULL,
      initial_values_json TEXT NOT NULL CHECK (json_valid(initial_values_json)),
      base_schema_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending',
        'queued',
        'planned',
        'applied',
        'conflict',
        'unsupported',
        'rejected',
        'needs_reconciliation'
      )),
      remote_page_id TEXT,
      unsupported_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (data_source_id, local_row_id),
      UNIQUE (data_source_id, client_request_key)
    );

    CREATE TABLE IF NOT EXISTS _nds_replica_body_changes (
      change_id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL,
      body_path TEXT,
      local_body_hash TEXT NOT NULL,
      local_body_content TEXT,
      base_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending',
        'queued',
        'planned',
        'applied',
        'conflict',
        'unsupported',
        'rejected',
        'needs_reconciliation'
      )),
      unsupported_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS _nds_replica_metadata_changes (
      change_id TEXT PRIMARY KEY,
      data_source_id TEXT NOT NULL,
      database_id TEXT,
      resource_type TEXT NOT NULL DEFAULT 'data_source' CHECK (resource_type IN ('data_source', 'database')),
      title_plain_text TEXT,
      description_plain_text TEXT,
      base_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending',
        'queued',
        'planned',
        'applied',
        'conflict',
        'unsupported',
        'rejected',
        'needs_reconciliation'
      )),
      unsupported_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CHECK (title_plain_text IS NOT NULL OR description_plain_text IS NOT NULL)
    );

    CREATE TABLE IF NOT EXISTS _nds_replica_schema_changes (
      change_id TEXT PRIMARY KEY,
      data_source_id TEXT NOT NULL,
      operation_json TEXT NOT NULL,
      base_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending',
        'queued',
        'planned',
        'applied',
        'conflict',
        'unsupported',
        'rejected',
        'needs_reconciliation'
      )),
      unsupported_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CHECK (json_valid(operation_json))
    );

    CREATE TABLE IF NOT EXISTS _nds_replica_file_assets (
      asset_id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL CHECK (source_type IN ('external_url', 'local_upload')),
      name TEXT NOT NULL,
      external_url TEXT,
      local_path TEXT,
      content_hash TEXT,
      byte_length INTEGER,
      mime_type TEXT,
      _nds_replica_file_upload_id TEXT,
      upload_status TEXT,
      expires_at TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'pending_upload', 'uploaded', 'expired', 'failed', 'unsupported')),
      unsupported_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CHECK (
        (source_type = 'external_url' AND external_url IS NOT NULL AND _nds_replica_file_upload_id IS NULL)
        OR (source_type = 'local_upload' AND local_path IS NOT NULL AND content_hash IS NOT NULL)
      )
    );

    CREATE TABLE IF NOT EXISTS _nds_replica_file_changes (
      change_id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('attach_external_url', 'attach_upload')),
      data_source_id TEXT NOT NULL,
      page_id TEXT NOT NULL,
      property_id TEXT NOT NULL,
      base_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending',
        'queued',
        'planned',
        'applied',
        'conflict',
        'unsupported',
        'rejected',
        'needs_reconciliation'
      )),
      unsupported_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS _nds_replica_view_changes (
      change_id TEXT PRIMARY KEY,
      action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),
      view_id TEXT,
      database_id TEXT,
      data_source_id TEXT,
      view_name TEXT,
      view_type TEXT,
      filter_json TEXT,
      sorts_json TEXT,
      configuration_json TEXT,
      base_hash TEXT,
      destructive_ack TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending',
        'queued',
        'planned',
        'applied',
        'conflict',
        'unsupported',
        'rejected',
        'needs_reconciliation'
      )),
      unsupported_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CHECK (filter_json IS NULL OR json_valid(filter_json)),
      CHECK (sorts_json IS NULL OR json_valid(sorts_json)),
      CHECK (configuration_json IS NULL OR json_valid(configuration_json))
    );

    CREATE TABLE IF NOT EXISTS _nds_replica_conflict_resolutions (
      resolution_id TEXT PRIMARY KEY,
      conflict_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('choose_remote', 'abandon_local', 'retry_after_refresh', 'choose_local', 'manual_value')),
      value_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending',
        'queued',
        'planned',
        'applied',
        'conflict',
        'unsupported',
        'rejected',
        'needs_reconciliation'
      )),
      unsupported_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CHECK (value_json IS NULL OR json_valid(value_json))
    );

    CREATE TABLE IF NOT EXISTS _nds_replica_local_changes (
      change_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN (
        'cell_patch',
        'row_archive',
        'row_restore',
        'row_create',
        'body_patch',
        'metadata_patch',
        'schema_patch',
        'file_attach',
        'view_change',
        'conflict_resolution'
      )),
      data_source_id TEXT NOT NULL,
      page_id TEXT,
      property_id TEXT,
      value_json TEXT,
      base_hash TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending',
        'queued',
        'planned',
        'applied',
        'conflict',
        'unsupported',
        'rejected',
        'needs_reconciliation'
      )),
      unsupported_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS _nds_replica_conflicts (
      conflict_id TEXT PRIMARY KEY,
      page_id TEXT,
      property_id TEXT,
      state TEXT NOT NULL,
      base_hash TEXT,
      local_hash TEXT,
      remote_hash TEXT,
      opened_event_id TEXT NOT NULL,
      resolution_event_id TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS _nds_replica_sync_status (
      root_id TEXT PRIMARY KEY,
      data_sources INTEGER NOT NULL,
      pages INTEGER NOT NULL,
      cells INTEGER NOT NULL,
      bodies INTEGER NOT NULL,
      conflicts_open INTEGER NOT NULL,
      pending_local_changes INTEGER NOT NULL,
      -- Control-plane aggregate counts materialized from state.sqlite at
      -- projection time (DD-B, decision 0020): the sync_status view reads ONLY this
      -- projection table so the data file never ATTACHes the control plane.
      pending_outbox INTEGER NOT NULL DEFAULT 0,
      blocked_outbox INTEGER NOT NULL DEFAULT 0,
      guard_blocks INTEGER NOT NULL DEFAULT 0,
      unclassified_tombstones INTEGER NOT NULL DEFAULT 0,
      unsupported_capabilities INTEGER NOT NULL DEFAULT 0,
      incomplete_hydration INTEGER NOT NULL DEFAULT 0,
      -- Resolved workspace root, materialized so the view keeps move-detection
      -- (pragma_database_list self-join) without joining the control plane.
      workspace_root TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE VIEW IF NOT EXISTS _nds_replica_rows_effective AS
      SELECT
        data_source_id,
        page_id,
        NULL AS local_row_id,
        'remote' AS origin,
        properties_hash,
        in_trash,
        moved_out,
        local_delete_candidate,
        'applied' AS sync_status,
        observed_event_id,
        observed_at,
        updated_at
      FROM _nds_replica_rows
      UNION ALL
      SELECT
        data_source_id,
        remote_page_id AS page_id,
        local_row_id,
        'local_create' AS origin,
        NULL AS properties_hash,
        0 AS in_trash,
        0 AS moved_out,
        0 AS local_delete_candidate,
        status AS sync_status,
        NULL AS observed_event_id,
        NULL AS observed_at,
        updated_at
            FROM _nds_replica_row_creates
            WHERE status IN ('pending', 'queued', 'planned')
        OR (
          remote_page_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM _nds_replica_rows observed
            WHERE observed.page_id = _nds_replica_row_creates.remote_page_id
          )
        );

    CREATE VIEW IF NOT EXISTS _nds_replica_cells_effective AS
      SELECT
        data_source_id,
        page_id,
        NULL AS local_row_id,
        'remote' AS origin,
        property_id,
        property_name,
        property_type,
        value_json,
        value_text,
        value_number,
        value_boolean,
        base_hash,
        remote_hash,
        availability,
        write_class,
        'applied' AS sync_status,
        observed_event_id,
        updated_at
      FROM _nds_replica_cells
      UNION ALL
      SELECT
        c.data_source_id,
        c.remote_page_id AS page_id,
        c.local_row_id,
        'local_create' AS origin,
        p.property_id,
        p.property_name,
        p.property_type,
        json_extract(values_by_property.value, '$') AS value_json,
        CASE json_extract(values_by_property.value, '$._tag')
          WHEN 'title' THEN json_extract(values_by_property.value, '$.plainText')
          WHEN 'rich_text' THEN json_extract(values_by_property.value, '$.plainText')
          WHEN 'select' THEN json_extract(values_by_property.value, '$.option.name')
          WHEN 'status' THEN json_extract(values_by_property.value, '$.option.name')
          WHEN 'email' THEN json_extract(values_by_property.value, '$.value')
          WHEN 'url' THEN json_extract(values_by_property.value, '$.value')
          WHEN 'phone_number' THEN json_extract(values_by_property.value, '$.value')
          ELSE NULL
        END AS value_text,
        CASE
          WHEN json_extract(values_by_property.value, '$._tag') = 'number'
          THEN json_extract(values_by_property.value, '$.value')
          ELSE NULL
        END AS value_number,
        CASE
          WHEN json_extract(values_by_property.value, '$._tag') = 'checkbox'
          THEN CASE WHEN json_extract(values_by_property.value, '$.checked') THEN 1 ELSE 0 END
          ELSE NULL
        END AS value_boolean,
        c.base_schema_hash AS base_hash,
        c.base_schema_hash AS remote_hash,
        'local-create' AS availability,
        p.write_class,
        c.status AS sync_status,
        NULL AS observed_event_id,
        c.updated_at
      FROM _nds_replica_row_creates c
      JOIN json_each(c.initial_values_json) AS values_by_property
      JOIN _nds_replica_properties p
        ON p.data_source_id = c.data_source_id
       AND p.property_id = values_by_property.key
      WHERE c.status IN ('pending', 'queued', 'planned', 'needs_reconciliation')
        OR (
          c.remote_page_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM _nds_replica_rows observed
            WHERE observed.page_id = c.remote_page_id
          )
        );

    CREATE VIEW IF NOT EXISTS ${quoteIdentifier(schemaViewName)} AS
      SELECT
        ds.data_source_id,
        ds.root_id,
        COALESCE(ds.workspace_binding_database_id, ds.parent_database_id) AS database_id,
        ds.parent_database_id,
        ds.workspace_root,
        ds.schema_hash,
        ds.metadata_hash,
        ds.title_plain_text,
        ds.description_plain_text,
        ds.observed_event_id,
        ds.observed_at,
        ds.updated_at,
        CASE
          WHEN (SELECT count(*) FROM _nds_replica_data_sources) = 1 THEN 1
          ELSE 0
        END AS is_primary_rows_source
      FROM _nds_replica_data_sources ds;

    CREATE VIEW IF NOT EXISTS ${quoteIdentifier(schemaPropertiesViewName)} AS
      SELECT
        p.data_source_id,
        p.schema_hash,
        ds.observed_event_id AS data_source_observed_event_id,
        ds.observed_at AS data_source_observed_at,
        p.observed_event_id AS property_observed_event_id,
        p.updated_at,
        p.property_id,
        p.property_name,
        plan.column_name,
        p.property_type,
        p.write_class,
        plan.ordinal,
        COALESCE(plan.is_scalar_read_supported, 0) AS is_scalar_read_supported,
        COALESCE(plan.is_rows_write_supported, 0) AS is_rows_write_supported,
        COALESCE(plan.null_write_behavior, 'unsupported') AS null_write_behavior,
        p.config_json
      FROM _nds_replica_properties p
      JOIN _nds_replica_data_sources ds ON ds.data_source_id = p.data_source_id
      LEFT JOIN _nds_replica_property_column_plan plan
        ON plan.data_source_id = p.data_source_id AND plan.property_id = p.property_id;

    CREATE VIEW IF NOT EXISTS ${quoteIdentifier(changesViewName)} AS
      SELECT
        local.change_id,
        local.kind,
        local.data_source_id,
        local.page_id,
        local.property_id,
        local.value_json,
        local.base_hash,
        local.status,
        local.unsupported_reason,
        row_create.local_row_id,
        row_create.client_request_key,
        row_create.remote_page_id,
        local.created_at,
        local.updated_at
      FROM _nds_replica_local_changes local
      LEFT JOIN _nds_replica_row_creates row_create
        ON row_create.change_id = local.change_id;

    CREATE VIEW IF NOT EXISTS ${quoteIdentifier(conflictsViewName)} AS
      SELECT * FROM _nds_replica_conflicts;

    CREATE VIEW IF NOT EXISTS ${quoteIdentifier(syncStatusViewName)} AS
      WITH status_counts AS (
        SELECT
          status.root_id,
          status.data_sources,
          status.pages,
          status.cells,
          status.bodies,
          ${openReplicaConflictsCountSql} AS conflicts_open,
          ${pendingReplicaChangesCountSql} AS pending_local_changes,
          (SELECT count(*) FROM ${quoteIdentifier(changesViewName)} WHERE status = 'conflict') AS conflicted_local_changes,
          (SELECT count(*) FROM ${quoteIdentifier(changesViewName)} WHERE status = 'unsupported') AS unsupported_local_changes,
          (SELECT count(*) FROM ${quoteIdentifier(changesViewName)} WHERE status = 'needs_reconciliation') AS reconciliation_local_changes,
          -- DD-B (decision 0020): control-plane counts are materialized into this
          -- projection table at projection time; the view never reaches the
          -- control plane (which now lives in .notion/v1/state.sqlite).
          status.pending_outbox,
          status.blocked_outbox,
          status.guard_blocks,
          status.unclassified_tombstones,
          status.unsupported_capabilities,
          status.incomplete_hydration,
          status.workspace_root,
          status.updated_at
        FROM _nds_replica_sync_status status
      )
      SELECT
        status.root_id,
        status.data_sources,
        status.pages,
        status.cells,
        status.bodies,
        status.conflicts_open,
        status.pending_local_changes,
        status.conflicted_local_changes,
        status.unsupported_local_changes,
        status.reconciliation_local_changes,
        status.pending_outbox,
        status.blocked_outbox,
        status.guard_blocks,
        status.unclassified_tombstones,
        status.unsupported_capabilities,
        status.incomplete_hydration,
        CASE
          WHEN status.conflicts_open + status.conflicted_local_changes > 0 THEN 'conflicted'
          WHEN status.unsupported_local_changes + status.unsupported_capabilities > 0 THEN 'unsupported'
          WHEN status.reconciliation_local_changes + status.blocked_outbox + status.guard_blocks + status.unclassified_tombstones > 0 THEN 'degraded'
          WHEN status.incomplete_hydration > 0 THEN 'incomplete'
          WHEN status.pending_local_changes + status.pending_outbox > 0 THEN 'pending'
          ELSE 'clean'
        END AS state,
        status.updated_at,
        -- Move-detection stays a self-join on this file's own main database
        -- (no ATTACH); workspace_root is the value materialized at projection
        -- time, so a file relocated AFTER projection still reports moved.
        -- macOS may expose the same temp path as either /var/... or
        -- /private/var/... across Node and SQLite, so treat those aliases as
        -- the same workspace root while preserving moved-copy detection.
        CASE
          WHEN status.workspace_root IS NULL THEN 'unbound'
          WHEN instr(database_list.file, status.workspace_root || '/') > 0 THEN 'bound'
          WHEN status.workspace_root LIKE '/private/var/%'
            AND instr(database_list.file, substr(status.workspace_root, 9) || '/') > 0 THEN 'bound'
          WHEN status.workspace_root LIKE '/var/%'
            AND instr(database_list.file, '/private' || status.workspace_root || '/') > 0 THEN 'bound'
          ELSE 'moved'
        END AS workspace_status
      FROM status_counts status
      JOIN pragma_database_list AS database_list ON database_list.name = 'main';

    CREATE VIEW IF NOT EXISTS debug_data_sources AS
      SELECT * FROM _nds_replica_data_sources;
    CREATE VIEW IF NOT EXISTS debug_databases AS
      SELECT * FROM _nds_replica_databases;
    CREATE VIEW IF NOT EXISTS debug_views AS
      SELECT * FROM _nds_replica_views;
    CREATE VIEW IF NOT EXISTS debug_cells AS
      SELECT * FROM _nds_replica_cells;
    CREATE VIEW IF NOT EXISTS debug_bodies AS
      SELECT * FROM _nds_replica_bodies;

    CREATE INDEX IF NOT EXISTS _nds_replica_cells_data_source_property_idx
      ON _nds_replica_cells(data_source_id, property_id);
    CREATE INDEX IF NOT EXISTS _nds_replica_cells_text_idx ON _nds_replica_cells(value_text);
    CREATE INDEX IF NOT EXISTS _nds_replica_relation_targets_property_idx
      ON _nds_replica_relation_targets(data_source_id, property_id, target_page_id);
    CREATE INDEX IF NOT EXISTS _nds_replica_cell_changes_pending_idx
      ON _nds_replica_cell_changes(status, data_source_id, page_id, property_id);
    CREATE INDEX IF NOT EXISTS _nds_replica_row_changes_pending_idx
      ON _nds_replica_row_changes(status, data_source_id, page_id);
    CREATE INDEX IF NOT EXISTS _nds_replica_row_creates_pending_idx
      ON _nds_replica_row_creates(status, data_source_id, client_request_key);
    CREATE INDEX IF NOT EXISTS _nds_replica_body_changes_pending_idx
      ON _nds_replica_body_changes(status, page_id);
    CREATE INDEX IF NOT EXISTS _nds_replica_metadata_changes_pending_idx
      ON _nds_replica_metadata_changes(status, data_source_id);
    CREATE INDEX IF NOT EXISTS _nds_replica_schema_changes_pending_idx
      ON _nds_replica_schema_changes(status, data_source_id);
    CREATE INDEX IF NOT EXISTS _nds_replica_file_changes_pending_idx
      ON _nds_replica_file_changes(status, data_source_id, page_id, property_id);
    CREATE INDEX IF NOT EXISTS _nds_replica_view_changes_pending_idx
      ON _nds_replica_view_changes(status, data_source_id, view_id);
    CREATE INDEX IF NOT EXISTS _nds_replica_conflict_resolutions_pending_idx
      ON _nds_replica_conflict_resolutions(status, conflict_id);
    CREATE INDEX IF NOT EXISTS _nds_replica_local_changes_pending_idx
      ON _nds_replica_local_changes(status, data_source_id, page_id);

    CREATE TRIGGER IF NOT EXISTS _nds_replica_cells_guard_direct_value_update
    BEFORE UPDATE OF value_json ON _nds_replica_cells
    FOR EACH ROW
    WHEN NEW.value_json IS NOT OLD.value_json AND OLD.write_class != 'writable'
    BEGIN
      SELECT RAISE(ABORT, '_nds_replica_cells.value_json is writable only for writable Notion properties');
    END;

    CREATE TRIGGER IF NOT EXISTS _nds_replica_cells_guard_direct_value_shape
    BEFORE UPDATE OF value_json ON _nds_replica_cells
    FOR EACH ROW
    WHEN NEW.value_json IS NOT OLD.value_json
      AND CASE
        WHEN NEW.value_json IS NULL THEN 1
        WHEN json_valid(NEW.value_json) = 0 THEN 1
        WHEN json_extract(NEW.value_json, '$._tag') = 'empty' THEN 0
        WHEN json_extract(NEW.value_json, '$._tag') IN ('title', 'rich_text')
          THEN CASE WHEN json_type(NEW.value_json, '$.plainText') = 'text' THEN 0 ELSE 1 END
        WHEN json_extract(NEW.value_json, '$._tag') = 'number'
          THEN CASE WHEN json_type(NEW.value_json, '$.value') IN ('integer', 'real') THEN 0 ELSE 1 END
        WHEN json_extract(NEW.value_json, '$._tag') = 'checkbox'
          THEN CASE WHEN json_type(NEW.value_json, '$.checked') IN ('true', 'false') THEN 0 ELSE 1 END
        WHEN json_extract(NEW.value_json, '$._tag') = 'date'
          THEN CASE WHEN json_type(NEW.value_json, '$.start') = 'text'
            AND (json_type(NEW.value_json, '$.end') IS NULL OR json_type(NEW.value_json, '$.end') IN ('text', 'null'))
            THEN 0 ELSE 1 END
        WHEN json_extract(NEW.value_json, '$._tag') IN ('select', 'status')
          THEN CASE WHEN json_type(NEW.value_json, '$.option') = 'null'
            OR (json_type(NEW.value_json, '$.option') = 'object' AND json_type(NEW.value_json, '$.option.name') = 'text')
            THEN 0 ELSE 1 END
        WHEN json_extract(NEW.value_json, '$._tag') = 'multi_select'
          THEN CASE WHEN json_type(NEW.value_json, '$.options') = 'array' THEN 0 ELSE 1 END
        WHEN json_extract(NEW.value_json, '$._tag') = 'relation'
          THEN CASE WHEN json_type(NEW.value_json, '$.pageIds') = 'array' THEN 0 ELSE 1 END
        WHEN json_extract(NEW.value_json, '$._tag') = 'people'
          THEN CASE WHEN json_type(NEW.value_json, '$.userIds') = 'array' THEN 0 ELSE 1 END
        WHEN json_extract(NEW.value_json, '$._tag') = 'files'
          THEN CASE WHEN json_type(NEW.value_json, '$.files') = 'array' THEN 0 ELSE 1 END
        WHEN json_extract(NEW.value_json, '$._tag') IN ('email', 'url', 'phone_number')
          THEN CASE WHEN json_type(NEW.value_json, '$.value') IN ('text', 'null') THEN 0 ELSE 1 END
        ELSE 1
      END = 1
    BEGIN
      SELECT RAISE(ABORT, '_nds_replica_cells.value_json must be canonical Notion property value JSON');
    END;

    CREATE TRIGGER IF NOT EXISTS _nds_replica_cells_guard_direct_complex_update
    BEFORE UPDATE OF value_json ON _nds_replica_cells
    FOR EACH ROW
    WHEN NEW.value_json IS NOT OLD.value_json
      AND json_valid(NEW.value_json)
      AND (
        OLD.property_type IN ('people', 'files')
        OR json_extract(NEW.value_json, '$._tag') IN ('people', 'files')
      )
    BEGIN
      SELECT RAISE(ABORT, 'people and files current-state edits require typed CDC staging; direct _nds_replica_cells.value_json updates are fail-closed');
    END;

    CREATE TRIGGER IF NOT EXISTS _nds_replica_cells_guard_direct_relation_update
    BEFORE UPDATE OF value_json ON _nds_replica_cells
    FOR EACH ROW
    WHEN NEW.value_json IS NOT OLD.value_json
      AND OLD.property_type = 'relation'
      AND json_extract(NEW.value_json, '$._tag') = 'relation'
      AND (
        OLD.availability != 'complete'
        OR json_extract(OLD.value_json, '$._tag') != 'relation'
        OR json_array_length(NEW.value_json, '$.pageIds') > 100
        OR EXISTS (
          SELECT 1
          FROM json_each(NEW.value_json, '$.pageIds') AS desired
          WHERE NOT EXISTS (
            SELECT 1
            FROM json_each(OLD.value_json, '$.pageIds') AS observed
            WHERE observed.value = desired.value
          )
          AND NOT EXISTS (
            SELECT 1
            FROM _nds_replica_relation_targets rt
            WHERE rt.data_source_id = OLD.data_source_id
              AND rt.property_id = OLD.property_id
              AND rt.target_page_id = desired.value
          )
        )
      )
    BEGIN
      SELECT RAISE(ABORT, 'relation value_json direct edits require a complete observed base and observed accessible relation targets');
    END;

    CREATE TRIGGER IF NOT EXISTS _nds_replica_cells_direct_value_update_intent
    AFTER UPDATE OF value_json ON _nds_replica_cells
    FOR EACH ROW
    WHEN NEW.value_json IS NOT OLD.value_json
    BEGIN
      UPDATE _nds_replica_cells
      SET
        value_text =
          CASE
            WHEN NEW.value_json IS NOT NULL AND json_valid(NEW.value_json) THEN
              CASE json_extract(NEW.value_json, '$._tag')
                WHEN 'title' THEN json_extract(NEW.value_json, '$.plainText')
                WHEN 'rich_text' THEN json_extract(NEW.value_json, '$.plainText')
                WHEN 'select' THEN json_extract(NEW.value_json, '$.option.name')
                WHEN 'status' THEN json_extract(NEW.value_json, '$.option.name')
                WHEN 'email' THEN json_extract(NEW.value_json, '$.value')
                WHEN 'url' THEN json_extract(NEW.value_json, '$.value')
                WHEN 'phone_number' THEN json_extract(NEW.value_json, '$.value')
                ELSE NULL
              END
            ELSE NULL
          END,
        value_number =
          CASE
            WHEN NEW.value_json IS NOT NULL
              AND json_valid(NEW.value_json)
              AND json_extract(NEW.value_json, '$._tag') = 'number'
              AND json_type(NEW.value_json, '$.value') IN ('integer', 'real')
            THEN json_extract(NEW.value_json, '$.value')
            ELSE NULL
          END,
        value_boolean =
          CASE
            WHEN NEW.value_json IS NOT NULL
              AND json_valid(NEW.value_json)
              AND json_extract(NEW.value_json, '$._tag') = 'checkbox'
              AND json_type(NEW.value_json, '$.checked') IN ('true', 'false')
            THEN CASE WHEN json_extract(NEW.value_json, '$.checked') THEN 1 ELSE 0 END
            ELSE NULL
          END,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE page_id = OLD.page_id AND property_id = OLD.property_id;

      UPDATE _nds_replica_cell_changes
      SET
        value_json = NEW.value_json,
        base_hash = OLD.base_hash,
        status = 'pending',
        unsupported_reason = NULL,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE page_id = OLD.page_id
        AND property_id = OLD.property_id
        AND status IN ('pending', 'queued');

      INSERT INTO _nds_replica_cell_changes (
        change_id,
        data_source_id,
        page_id,
        property_id,
        value_json,
        base_hash
      )
      SELECT
        'cell:' || OLD.page_id || ':' || OLD.property_id || ':' || lower(hex(randomblob(8))),
        OLD.data_source_id,
        OLD.page_id,
        OLD.property_id,
        NEW.value_json,
        OLD.base_hash
      WHERE changes() = 0;

    END;

    CREATE TRIGGER IF NOT EXISTS _nds_replica_cells_block_identity_update
    BEFORE UPDATE OF data_source_id, page_id, property_id, base_hash, remote_hash, write_class ON _nds_replica_cells
    FOR EACH ROW
    BEGIN
      SELECT RAISE(ABORT, '_nds_replica_cells identity/hash columns are read-only; edit value_json to queue a local change');
    END;

    CREATE TRIGGER IF NOT EXISTS _nds_replica_cells_block_delete
    BEFORE DELETE ON _nds_replica_cells
    FOR EACH ROW
    BEGIN
      SELECT RAISE(ABORT, 'deleting _nds_replica_cells is unsafe; use _nds_replica_rows.in_trash or _nds_replica_local_changes for explicit destructive intents');
    END;

    CREATE TRIGGER IF NOT EXISTS _nds_replica_rows_archive_restore_intent
    AFTER UPDATE OF in_trash ON _nds_replica_rows
    FOR EACH ROW
    WHEN NEW.in_trash IS NOT OLD.in_trash
    BEGIN
      UPDATE _nds_replica_row_changes
      SET
        status = 'rejected',
        unsupported_reason = 'Superseded by later direct row lifecycle edit.',
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE page_id = OLD.page_id
        AND status IN ('pending', 'queued');

      INSERT INTO _nds_replica_row_changes (
        change_id,
        kind,
        data_source_id,
        page_id,
        base_hash
      )
      SELECT
        'row:' || OLD.page_id || ':' || CASE WHEN NEW.in_trash = 1 THEN 'archive' ELSE 'restore' END || ':' || lower(hex(randomblob(8))),
        CASE WHEN NEW.in_trash = 1 THEN 'row_archive' ELSE 'row_restore' END,
        OLD.data_source_id,
        OLD.page_id,
        OLD.properties_hash;

    END;

    CREATE TRIGGER IF NOT EXISTS _nds_replica_rows_block_identity_update
    BEFORE UPDATE OF data_source_id, page_id, properties_hash, moved_out, local_delete_candidate ON _nds_replica_rows
    FOR EACH ROW
    BEGIN
      SELECT RAISE(ABORT, '_nds_replica_rows identity/hash columns are read-only; edit in_trash to queue an archive/restore intent');
    END;

    CREATE TRIGGER IF NOT EXISTS _nds_replica_rows_block_insert
    BEFORE INSERT ON _nds_replica_rows
    FOR EACH ROW
    BEGIN
      SELECT RAISE(ABORT, '_nds_replica_rows is observed remote state; insert into _nds_replica_row_creates to create a Notion row');
    END;

    CREATE TRIGGER IF NOT EXISTS _nds_replica_rows_block_delete
    BEFORE DELETE ON _nds_replica_rows
    FOR EACH ROW
    BEGIN
      SELECT RAISE(ABORT, 'deleting _nds_replica_rows is unsafe; set in_trash=1 or insert an explicit local change intent');
    END;

    CREATE TRIGGER IF NOT EXISTS _nds_replica_cell_changes_mirror_local_insert
    AFTER INSERT ON _nds_replica_cell_changes
    FOR EACH ROW
    BEGIN
      INSERT OR IGNORE INTO _nds_replica_local_changes (
        change_id,
        kind,
        data_source_id,
        page_id,
        property_id,
        value_json,
        base_hash,
        status,
        unsupported_reason,
        created_at,
        updated_at
      ) VALUES (
        NEW.change_id,
        'cell_patch',
        NEW.data_source_id,
        NEW.page_id,
        NEW.property_id,
        NEW.value_json,
        NEW.base_hash,
        NEW.status,
        NEW.unsupported_reason,
        NEW.created_at,
        NEW.updated_at
      );
    END;

    CREATE TRIGGER IF NOT EXISTS _nds_replica_cell_changes_mirror_local_update
    AFTER UPDATE ON _nds_replica_cell_changes
    FOR EACH ROW
    BEGIN
      UPDATE _nds_replica_local_changes
      SET
        value_json = NEW.value_json,
        base_hash = NEW.base_hash,
        status = NEW.status,
        unsupported_reason = NEW.unsupported_reason,
        updated_at = NEW.updated_at
      WHERE change_id = NEW.change_id;
    END;

    CREATE TRIGGER IF NOT EXISTS _nds_replica_row_changes_mirror_local_insert
    AFTER INSERT ON _nds_replica_row_changes
    FOR EACH ROW
    BEGIN
      INSERT OR IGNORE INTO _nds_replica_local_changes (
        change_id,
        kind,
        data_source_id,
        page_id,
        value_json,
        base_hash,
        status,
        unsupported_reason,
        created_at,
        updated_at
      ) VALUES (
        NEW.change_id,
        NEW.kind,
        NEW.data_source_id,
        NEW.page_id,
        NEW.value_json,
        NEW.base_hash,
        NEW.status,
        NEW.unsupported_reason,
        NEW.created_at,
        NEW.updated_at
      );
    END;

    CREATE TRIGGER IF NOT EXISTS _nds_replica_row_changes_mirror_local_update
    AFTER UPDATE ON _nds_replica_row_changes
    FOR EACH ROW
    BEGIN
      UPDATE _nds_replica_local_changes
      SET
        kind = NEW.kind,
        page_id = NEW.page_id,
        value_json = NEW.value_json,
        base_hash = NEW.base_hash,
        status = NEW.status,
        unsupported_reason = NEW.unsupported_reason,
        updated_at = NEW.updated_at
      WHERE change_id = NEW.change_id;
    END;

    CREATE TRIGGER IF NOT EXISTS _nds_replica_row_creates_mirror_row_change_insert
    AFTER INSERT ON _nds_replica_row_creates
    FOR EACH ROW
    BEGIN
      INSERT OR IGNORE INTO _nds_replica_row_changes (
        change_id,
        kind,
        data_source_id,
        page_id,
        value_json,
        base_hash,
        status,
        unsupported_reason,
        created_at,
        updated_at
      ) VALUES (
        NEW.change_id,
        'row_create',
        NEW.data_source_id,
        NEW.remote_page_id,
        NEW.initial_values_json,
        NEW.base_schema_hash,
        NEW.status,
        NEW.unsupported_reason,
        NEW.created_at,
        NEW.updated_at
      );
    END;

    CREATE TRIGGER IF NOT EXISTS _nds_replica_row_creates_mirror_row_change_update
    AFTER UPDATE ON _nds_replica_row_creates
    FOR EACH ROW
    BEGIN
      UPDATE _nds_replica_row_changes
      SET
        page_id = NEW.remote_page_id,
        value_json = NEW.initial_values_json,
        base_hash = NEW.base_schema_hash,
        status = NEW.status,
        unsupported_reason = NEW.unsupported_reason,
        updated_at = NEW.updated_at
      WHERE change_id = NEW.change_id;
    END;

    CREATE TRIGGER IF NOT EXISTS _nds_replica_body_changes_mirror_local_insert
    AFTER INSERT ON _nds_replica_body_changes
    FOR EACH ROW
    BEGIN
      INSERT OR IGNORE INTO _nds_replica_local_changes (
        change_id,
        kind,
        data_source_id,
        page_id,
        value_json,
        base_hash,
        status,
        unsupported_reason,
        created_at,
        updated_at
      ) VALUES (
        NEW.change_id,
        'body_patch',
        '',
        NEW.page_id,
        json_object(
          'body_path', NEW.body_path,
          'local_body_hash', NEW.local_body_hash,
          'local_body_content', NEW.local_body_content
        ),
        NEW.base_hash,
        NEW.status,
        NEW.unsupported_reason,
        NEW.created_at,
        NEW.updated_at
      );
    END;

    CREATE TRIGGER IF NOT EXISTS _nds_replica_body_changes_mirror_local_update
    AFTER UPDATE ON _nds_replica_body_changes
    FOR EACH ROW
    BEGIN
      UPDATE _nds_replica_local_changes
      SET
        value_json = json_object(
          'body_path', NEW.body_path,
          'local_body_hash', NEW.local_body_hash,
          'local_body_content', NEW.local_body_content
        ),
        base_hash = NEW.base_hash,
        status = NEW.status,
        unsupported_reason = NEW.unsupported_reason,
        updated_at = NEW.updated_at
      WHERE change_id = NEW.change_id;
    END;

    CREATE TRIGGER IF NOT EXISTS _nds_replica_metadata_changes_mirror_local_insert
    AFTER INSERT ON _nds_replica_metadata_changes
    FOR EACH ROW
    BEGIN
      INSERT OR IGNORE INTO _nds_replica_local_changes (
        change_id,
        kind,
        data_source_id,
        value_json,
        base_hash,
        status,
        unsupported_reason,
        created_at,
        updated_at
      ) VALUES (
        NEW.change_id,
        'metadata_patch',
        NEW.data_source_id,
        json_object(
          'resource_type', NEW.resource_type,
          'title_plain_text', NEW.title_plain_text,
          'description_plain_text', NEW.description_plain_text
        ),
        NEW.base_hash,
        NEW.status,
        NEW.unsupported_reason,
        NEW.created_at,
        NEW.updated_at
      );
    END;

    CREATE TRIGGER IF NOT EXISTS _nds_replica_metadata_changes_mirror_local_update
    AFTER UPDATE ON _nds_replica_metadata_changes
    FOR EACH ROW
    BEGIN
      UPDATE _nds_replica_local_changes
      SET
        value_json = json_object(
          'resource_type', NEW.resource_type,
          'title_plain_text', NEW.title_plain_text,
          'description_plain_text', NEW.description_plain_text
        ),
        base_hash = NEW.base_hash,
        status = NEW.status,
        unsupported_reason = NEW.unsupported_reason,
        updated_at = NEW.updated_at
      WHERE change_id = NEW.change_id;
    END;

    CREATE TRIGGER IF NOT EXISTS _nds_replica_schema_changes_mirror_local_insert
    AFTER INSERT ON _nds_replica_schema_changes
    FOR EACH ROW
    BEGIN
      INSERT OR IGNORE INTO _nds_replica_local_changes (
        change_id,
        kind,
        data_source_id,
        value_json,
        base_hash,
        status,
        unsupported_reason,
        created_at,
        updated_at
      ) VALUES (
        NEW.change_id,
        'schema_patch',
        NEW.data_source_id,
        NEW.operation_json,
        NEW.base_hash,
        NEW.status,
        NEW.unsupported_reason,
        NEW.created_at,
        NEW.updated_at
      );
    END;

    CREATE TRIGGER IF NOT EXISTS _nds_replica_schema_changes_mirror_local_update
    AFTER UPDATE ON _nds_replica_schema_changes
    FOR EACH ROW
    BEGIN
      UPDATE _nds_replica_local_changes
      SET
        value_json = NEW.operation_json,
        base_hash = NEW.base_hash,
        status = NEW.status,
        unsupported_reason = NEW.unsupported_reason,
        updated_at = NEW.updated_at
      WHERE change_id = NEW.change_id;
    END;

    CREATE TRIGGER IF NOT EXISTS _nds_replica_file_changes_mirror_local_insert
    AFTER INSERT ON _nds_replica_file_changes
    FOR EACH ROW
    BEGIN
      INSERT OR IGNORE INTO _nds_replica_local_changes (
        change_id,
        kind,
        data_source_id,
        page_id,
        property_id,
        value_json,
        base_hash,
        status,
        unsupported_reason,
        created_at,
        updated_at
      ) VALUES (
        NEW.change_id,
        'file_attach',
        NEW.data_source_id,
        NEW.page_id,
        NEW.property_id,
        json_object('asset_id', NEW.asset_id, 'action', NEW.action),
        NEW.base_hash,
        NEW.status,
        NEW.unsupported_reason,
        NEW.created_at,
        NEW.updated_at
      );
    END;

    CREATE TRIGGER IF NOT EXISTS _nds_replica_file_changes_mirror_local_update
    AFTER UPDATE ON _nds_replica_file_changes
    FOR EACH ROW
    BEGIN
      UPDATE _nds_replica_local_changes
      SET
        value_json = json_object('asset_id', NEW.asset_id, 'action', NEW.action),
        base_hash = NEW.base_hash,
        status = NEW.status,
        unsupported_reason = NEW.unsupported_reason,
        updated_at = NEW.updated_at
      WHERE change_id = NEW.change_id;
    END;

    CREATE TRIGGER IF NOT EXISTS _nds_replica_view_changes_mirror_local_insert
    AFTER INSERT ON _nds_replica_view_changes
    FOR EACH ROW
    BEGIN
      INSERT OR IGNORE INTO _nds_replica_local_changes (
        change_id,
        kind,
        data_source_id,
        value_json,
        base_hash,
        status,
        unsupported_reason,
        created_at,
        updated_at
      ) VALUES (
        NEW.change_id,
        'view_change',
        COALESCE(NEW.data_source_id, ''),
        json_object(
          'action', NEW.action,
          'view_id', NEW.view_id,
          'database_id', NEW.database_id,
          'view_name', NEW.view_name,
          'view_type', NEW.view_type,
          'filter_json', NEW.filter_json,
          'sorts_json', NEW.sorts_json,
          'configuration_json', NEW.configuration_json,
          'destructive_ack', NEW.destructive_ack
        ),
        NEW.base_hash,
        NEW.status,
        NEW.unsupported_reason,
        NEW.created_at,
        NEW.updated_at
      );
    END;

    CREATE TRIGGER IF NOT EXISTS _nds_replica_view_changes_mirror_local_update
    AFTER UPDATE ON _nds_replica_view_changes
    FOR EACH ROW
    BEGIN
      UPDATE _nds_replica_local_changes
      SET
        data_source_id = COALESCE(NEW.data_source_id, ''),
        value_json = json_object(
          'action', NEW.action,
          'view_id', NEW.view_id,
          'database_id', NEW.database_id,
          'view_name', NEW.view_name,
          'view_type', NEW.view_type,
          'filter_json', NEW.filter_json,
          'sorts_json', NEW.sorts_json,
          'configuration_json', NEW.configuration_json,
          'destructive_ack', NEW.destructive_ack
        ),
        base_hash = NEW.base_hash,
        status = NEW.status,
        unsupported_reason = NEW.unsupported_reason,
        updated_at = NEW.updated_at
      WHERE change_id = NEW.change_id;
    END;

    CREATE TRIGGER IF NOT EXISTS _nds_replica_conflict_resolutions_mirror_local_insert
    AFTER INSERT ON _nds_replica_conflict_resolutions
    FOR EACH ROW
    BEGIN
      INSERT OR IGNORE INTO _nds_replica_local_changes (
        change_id,
        kind,
        data_source_id,
        value_json,
        status,
        unsupported_reason,
        created_at,
        updated_at
      ) VALUES (
        NEW.resolution_id,
        'conflict_resolution',
        '',
        json_object(
          'conflict_id', NEW.conflict_id,
          'action', NEW.action,
          'value_json', NEW.value_json
        ),
        NEW.status,
        NEW.unsupported_reason,
        NEW.created_at,
        NEW.updated_at
      );
    END;

    CREATE TRIGGER IF NOT EXISTS _nds_replica_conflict_resolutions_mirror_local_update
    AFTER UPDATE ON _nds_replica_conflict_resolutions
    FOR EACH ROW
    BEGIN
      UPDATE _nds_replica_local_changes
      SET
        value_json = json_object(
          'conflict_id', NEW.conflict_id,
          'action', NEW.action,
          'value_json', NEW.value_json
        ),
        status = NEW.status,
        unsupported_reason = NEW.unsupported_reason,
        updated_at = NEW.updated_at
      WHERE change_id = NEW.resolution_id;
    END;

    CREATE TRIGGER IF NOT EXISTS _nds_replica_local_changes_mirror_cell_insert
    AFTER INSERT ON _nds_replica_local_changes
    FOR EACH ROW
    WHEN NEW.kind = 'cell_patch'
    BEGIN
      INSERT OR IGNORE INTO _nds_replica_cell_changes (
        change_id,
        data_source_id,
        page_id,
        property_id,
        value_json,
        base_hash,
        status,
        unsupported_reason,
        created_at,
        updated_at
      ) VALUES (
        NEW.change_id,
        NEW.data_source_id,
        NEW.page_id,
        NEW.property_id,
        NEW.value_json,
        NEW.base_hash,
        NEW.status,
        NEW.unsupported_reason,
        NEW.created_at,
        NEW.updated_at
      );
    END;

    CREATE TRIGGER IF NOT EXISTS _nds_replica_local_changes_mirror_row_insert
    AFTER INSERT ON _nds_replica_local_changes
    FOR EACH ROW
    WHEN NEW.kind IN ('row_archive', 'row_restore', 'row_create')
    BEGIN
      INSERT OR IGNORE INTO _nds_replica_row_changes (
        change_id,
        kind,
        data_source_id,
        page_id,
        value_json,
        base_hash,
        status,
        unsupported_reason,
        created_at,
        updated_at
      ) VALUES (
        NEW.change_id,
        NEW.kind,
        NEW.data_source_id,
        NEW.page_id,
        NEW.value_json,
        NEW.base_hash,
        NEW.status,
        NEW.unsupported_reason,
        NEW.created_at,
        NEW.updated_at
      );
    END;
  `)

  ensureReplicaColumn({
    db,
    table: '_nds_replica_data_sources',
    column: 'parent_database_id',
    definition: 'TEXT',
  })
  ensureReplicaColumn({
    db,
    table: '_nds_replica_data_sources',
    column: 'metadata_json',
    definition: 'TEXT',
  })
  ensureReplicaColumn({
    db,
    table: '_nds_replica_data_sources',
    column: 'title_plain_text',
    definition: 'TEXT',
  })
  ensureReplicaColumn({
    db,
    table: '_nds_replica_data_sources',
    column: 'description_plain_text',
    definition: 'TEXT',
  })
  ensureReplicaColumn({
    db,
    table: '_nds_replica_metadata_changes',
    column: 'database_id',
    definition: 'TEXT',
  })
  ensureReplicaColumn({
    db,
    table: '_nds_replica_file_assets',
    column: 'local_path',
    definition: 'TEXT',
  })
  ensureReplicaColumn({
    db,
    table: '_nds_replica_file_assets',
    column: 'byte_length',
    definition: 'INTEGER',
  })
  ensureReplicaColumn({
    db,
    table: '_nds_replica_file_assets',
    column: 'mime_type',
    definition: 'TEXT',
  })
  ensureReplicaColumn({
    db,
    table: '_nds_replica_file_assets',
    column: 'expires_at',
    definition: 'TEXT',
  })
  ensureReplicaColumn({
    db,
    table: '_nds_replica_file_assets',
    column: 'retry_count',
    definition: 'INTEGER NOT NULL DEFAULT 0',
  })
  ensureReplicaColumn({
    db,
    table: '_nds_replica_file_assets',
    column: 'last_error',
    definition: 'TEXT',
  })
  ensureReplicaColumn({
    db,
    table: '_nds_replica_properties',
    column: 'schema_ordinal',
    definition: 'INTEGER NOT NULL DEFAULT 0',
  })
  ensureReplicaColumn({
    db,
    table: '_nds_replica_properties',
    column: 'config_json',
    definition: 'TEXT',
  })

  if (needsLocalChangesStatusMigration === true) {
    db.exec(`
      INSERT OR IGNORE INTO _nds_replica_local_changes (
        change_id,
        kind,
        data_source_id,
        page_id,
        property_id,
        value_json,
        base_hash,
        status,
        unsupported_reason,
        created_at,
        updated_at
      )
      SELECT
        change_id,
        kind,
        data_source_id,
        page_id,
        property_id,
        value_json,
        base_hash,
        status,
        unsupported_reason,
        created_at,
        updated_at
      FROM _nds_replica_local_changes_legacy;

      DROP TABLE _nds_replica_local_changes_legacy;
    `)
  }

  db.exec(`
    INSERT OR IGNORE INTO _nds_replica_cell_changes (
      change_id,
      data_source_id,
      page_id,
      property_id,
      value_json,
      base_hash,
      status,
      unsupported_reason,
      created_at,
      updated_at
    )
    SELECT
      change_id,
      data_source_id,
      page_id,
      property_id,
      value_json,
      base_hash,
      status,
      unsupported_reason,
      created_at,
      updated_at
    FROM _nds_replica_local_changes
    WHERE kind = 'cell_patch'
      AND page_id IS NOT NULL
      AND property_id IS NOT NULL
      AND value_json IS NOT NULL;

    INSERT OR IGNORE INTO _nds_replica_row_changes (
      change_id,
      kind,
      data_source_id,
      page_id,
      value_json,
      base_hash,
      status,
      unsupported_reason,
      created_at,
      updated_at
    )
    SELECT
      change_id,
      kind,
      data_source_id,
      page_id,
      value_json,
      base_hash,
      status,
      unsupported_reason,
      created_at,
      updated_at
    FROM _nds_replica_local_changes
    WHERE kind IN ('row_archive', 'row_restore', 'row_create');
  `)
}

/**
 * Install the replica schema + CDC triggers atomically on a fresh connection.
 *
 * Applies the two connection-level PRAGMAs that cannot run inside a transaction
 * (`foreign_keys`, `journal_mode = WAL`), then runs the full DDL inside a single
 * `BEGIN IMMEDIATE`/`COMMIT` so the schema, triggers, and `PRAGMA user_version`
 * stamp commit together — closing the pre-existing non-transactional window
 * where a crash mid-DDL could leave tables without their CDC triggers. On any
 * failure the transaction is rolled back and the error rethrown, leaving the
 * database untouched. Callers that already hold an open write transaction must
 * use `createReplicaSchemaInTransaction` instead to avoid an illegal nested
 * `BEGIN`.
 */
export const createReplicaSchema = (db: DatabaseSync): void => {
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('BEGIN IMMEDIATE')
  try {
    createReplicaSchemaInTransaction(db)
    db.exec('COMMIT')
  } catch (cause) {
    db.exec('ROLLBACK')
    throw cause
  }
}

const clearProjectedReplicaTables = (db: DatabaseSync): void => {
  db.exec(`
    DROP TRIGGER IF EXISTS _nds_replica_cells_direct_value_update_intent;
    DROP TRIGGER IF EXISTS _nds_replica_cells_guard_direct_value_update;
    DROP TRIGGER IF EXISTS _nds_replica_cells_guard_direct_complex_update;
    DROP TRIGGER IF EXISTS _nds_replica_cells_block_identity_update;
    DROP TRIGGER IF EXISTS _nds_replica_cells_block_delete;
    DROP TRIGGER IF EXISTS _nds_replica_rows_archive_restore_intent;
    DROP TRIGGER IF EXISTS _nds_replica_rows_block_insert;
    DROP TRIGGER IF EXISTS _nds_replica_rows_block_identity_update;
    DROP TRIGGER IF EXISTS _nds_replica_rows_block_delete;
    DROP TRIGGER IF EXISTS _nds_replica_local_changes_mirror_cell_insert;
    DROP TRIGGER IF EXISTS _nds_replica_local_changes_mirror_row_insert;
    DROP TRIGGER IF EXISTS _nds_replica_cell_changes_mirror_local_insert;
    DROP TRIGGER IF EXISTS _nds_replica_row_changes_mirror_local_insert;
    DROP TRIGGER IF EXISTS _nds_replica_file_changes_mirror_local_insert;
    DROP TRIGGER IF EXISTS rows_update;
    DROP TRIGGER IF EXISTS rows_insert;
    DROP TRIGGER IF EXISTS rows_delete;
    DROP TRIGGER IF EXISTS _nds_pages_update;
    DROP TRIGGER IF EXISTS _nds_pages_insert;
    DROP TRIGGER IF EXISTS _nds_pages_delete;
    DROP VIEW IF EXISTS ${quoteIdentifier(pagesViewName)};

    DELETE FROM _nds_replica_data_sources;
    DELETE FROM _nds_replica_databases;
    DELETE FROM _nds_replica_views;
    DELETE FROM _nds_replica_properties;
    DELETE FROM _nds_replica_property_column_plan;
    DELETE FROM _nds_replica_rows;
    DELETE FROM _nds_replica_cells;
    DELETE FROM _nds_replica_relation_targets;
    DELETE FROM _nds_replica_bodies;
    DELETE FROM _nds_replica_conflicts;
    DELETE FROM _nds_replica_sync_status;
  `)
}

const parsePayload = (payloadJson: string): unknown => {
  const decoded = JSON.parse(payloadJson) as { readonly canonicalJson?: unknown }
  return typeof decoded.canonicalJson === 'string' ? JSON.parse(decoded.canonicalJson) : {}
}

type DataSourceSchemaPropertyPayload = {
  readonly payload: Record<string, unknown>
  readonly ordinal: number
}

const latestDataSourcePayloads = ({
  syncDb,
  rootId,
}: {
  readonly syncDb: DatabaseSync
  readonly rootId: SyncRootId
}): Map<string, DataSourceSchemaPropertyPayload> => {
  const rows = syncDb
    .prepare(
      `SELECT payload_json
       FROM _nds_sync_event
       WHERE root_id = ? AND event_type IN ('DataSourceObserved', 'DataSourceSchemaObserved')
       ORDER BY sequence`,
    )
    .all(rootId) as SqlRow[]
  const result = new Map<string, DataSourceSchemaPropertyPayload>()
  for (const row of rows) {
    const payload = parsePayload(readString({ row, key: 'payload_json' }))
    if (typeof payload !== 'object' || payload === null) continue
    const properties = (payload as { readonly schemaProperties?: unknown }).schemaProperties
    if (Array.isArray(properties) === false) continue
    for (const [ordinal, property] of properties.entries()) {
      if (typeof property !== 'object' || property === null) continue
      const propertyId = (property as { readonly propertyId?: unknown }).propertyId
      if (typeof propertyId === 'string')
        result.set(propertyId, { payload: property as Record<string, unknown>, ordinal })
    }
  }
  return result
}

const latestPropertyValueJson = ({
  syncDb,
  rootId,
}: {
  readonly syncDb: DatabaseSync
  readonly rootId: SyncRootId
}): Map<string, string> => {
  const rows = syncDb
    .prepare(
      `SELECT event_json, payload_json
       FROM _nds_sync_event
       WHERE root_id = ? AND event_type = 'PagePropertyCheckpointRecorded'
       ORDER BY sequence`,
    )
    .all(rootId) as SqlRow[]
  const result = new Map<string, string>()
  for (const row of rows) {
    const payload = parsePayload(readString({ row, key: 'payload_json' }))
    if (typeof payload !== 'object' || payload === null) continue
    const valueJson = (payload as { readonly valueJson?: unknown }).valueJson
    if (typeof valueJson !== 'string') continue
    const event = JSON.parse(readString({ row, key: 'event_json' })) as {
      readonly pageId?: unknown
      readonly propertyId?: unknown
    }
    if (typeof event.pageId !== 'string' || typeof event.propertyId !== 'string') continue
    result.set(`${event.pageId}\0${event.propertyId}`, valueJson)
  }
  return result
}

const scalarColumns = (valueJson: string | undefined) => {
  if (valueJson === undefined) {
    return { text: undefined, number: undefined, boolean: undefined }
  }
  try {
    const value = JSON.parse(valueJson) as Record<string, unknown>
    switch (value._tag) {
      case 'title':
      case 'rich_text':
        return {
          text: typeof value.plainText === 'string' ? value.plainText : undefined,
          number: undefined,
          boolean: undefined,
        }
      case 'number':
        return {
          text: undefined,
          number: typeof value.value === 'number' ? value.value : undefined,
          boolean: undefined,
        }
      case 'checkbox':
        return {
          text: undefined,
          number: undefined,
          boolean: value.checked === true ? 1 : 0,
        }
      case 'select':
      case 'status':
        return {
          text:
            value.option !== null &&
            typeof value.option === 'object' &&
            typeof (value.option as Record<string, unknown>).name === 'string'
              ? ((value.option as Record<string, unknown>).name as string)
              : undefined,
          number: undefined,
          boolean: undefined,
        }
      case 'email':
      case 'url':
      case 'phone_number':
        return {
          text: typeof value.value === 'string' ? value.value : undefined,
          number: undefined,
          boolean: undefined,
        }
      default:
        return { text: undefined, number: undefined, boolean: undefined }
    }
  } catch {
    return { text: undefined, number: undefined, boolean: undefined }
  }
}

const normalizeRelationPageIds = (pageIds: ReadonlyArray<unknown>): ReadonlyArray<string> =>
  pageIds.map(String).toSorted((leftId, rightId) => leftId.localeCompare(rightId))

const relationValueSetEquals = ({
  leftJson,
  rightJson,
}: {
  readonly leftJson: string
  readonly rightJson: string
}): boolean => {
  try {
    const left = JSON.parse(leftJson) as { readonly _tag?: unknown; readonly pageIds?: unknown }
    const right = JSON.parse(rightJson) as { readonly _tag?: unknown; readonly pageIds?: unknown }
    if (left._tag !== 'relation' || right._tag !== 'relation') return false
    if (Array.isArray(left.pageIds) === false || Array.isArray(right.pageIds) === false)
      return false
    return (
      JSON.stringify(normalizeRelationPageIds(left.pageIds)) ===
      JSON.stringify(normalizeRelationPageIds(right.pageIds))
    )
  } catch {
    return false
  }
}

const cellValueMatches = ({
  observedJson,
  desiredJson,
}: {
  readonly observedJson: string | undefined
  readonly desiredJson: string
}): boolean =>
  observedJson === desiredJson ||
  (observedJson !== undefined &&
    relationValueSetEquals({ leftJson: observedJson, rightJson: desiredJson }) === true)

const settleAppliedCellChangesFromProjection = ({
  replicaDb,
  now,
}: {
  readonly replicaDb: DatabaseSync
  readonly now: string
}): void => {
  const changes = replicaDb
    .prepare(
      `SELECT change_id, page_id, property_id, value_json
       FROM _nds_replica_cell_changes
       WHERE status IN ('pending', 'queued', 'planned')`,
    )
    .all() as SqlRow[]
  for (const change of changes) {
    const cell = replicaDb
      .prepare(`SELECT value_json FROM _nds_replica_cells WHERE page_id = ? AND property_id = ?`)
      .get(
        readString({ row: change, key: 'page_id' }),
        readString({ row: change, key: 'property_id' }),
      ) as SqlRow | undefined
    if (
      cellValueMatches({
        observedJson:
          cell === undefined ? undefined : readOptionalString({ row: cell, key: 'value_json' }),
        desiredJson: readString({ row: change, key: 'value_json' }),
      }) === false
    )
      continue

    const changeId = readString({ row: change, key: 'change_id' })
    replicaDb
      .prepare(
        `UPDATE _nds_replica_cell_changes
         SET status = 'applied', unsupported_reason = NULL, updated_at = ?
         WHERE change_id = ?`,
      )
      .run(now, changeId)
    replicaDb
      .prepare(
        `UPDATE _nds_replica_local_changes
         SET status = 'applied', unsupported_reason = NULL, updated_at = ?
         WHERE change_id = ?`,
      )
      .run(now, changeId)
  }
}

const isRowsWritablePropertyType = (propertyType: string): boolean =>
  [
    'title',
    'rich_text',
    'number',
    'checkbox',
    'date',
    'select',
    'status',
    'email',
    'url',
    'phone_number',
  ].includes(propertyType)

const nullWriteBehaviorForPropertyType = (propertyType: string): string => {
  switch (propertyType) {
    case 'select':
    case 'status':
      return 'clear-option'
    case 'email':
    case 'url':
    case 'phone_number':
      return 'clear-value'
    case 'title':
    case 'rich_text':
    case 'number':
    case 'checkbox':
    case 'date':
      return 'reject-null'
    default:
      return 'unsupported'
  }
}

const propertyIdSuffix = (propertyId: string): string => {
  const suffix = propertyId
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, 24)
  return suffix.length === 0 ? 'property' : suffix
}

const safeRowsColumnBaseName = ({
  propertyName,
  propertyId,
}: {
  readonly propertyName: string
  readonly propertyId: string
}): string => {
  const trimmed = propertyName.trim()
  if (trimmed.length === 0 || trimmed.startsWith('_') === true)
    return `property_${propertyIdSuffix(propertyId)}`
  return trimmed
}

const planRowsColumnNames = (
  properties: readonly {
    readonly propertyId: string
    readonly propertyName: string
  }[],
): Map<string, string> => {
  const usedNames = new Set(rowsSystemColumns.map((column) => column.toLowerCase()))
  const result = new Map<string, string>()
  for (const property of properties) {
    const baseName = safeRowsColumnBaseName({
      propertyName: property.propertyName,
      propertyId: property.propertyId,
    })
    const keywordCollision = sqliteKeywords.has(baseName.toUpperCase())
    let columnName =
      keywordCollision === true ? `${baseName}_${propertyIdSuffix(property.propertyId)}` : baseName
    let lowerColumnName = columnName.toLowerCase()
    if (usedNames.has(lowerColumnName) === true) {
      columnName = `${baseName}_${propertyIdSuffix(property.propertyId)}`
      lowerColumnName = columnName.toLowerCase()
    }
    let attempt = 2
    while (
      usedNames.has(lowerColumnName) === true ||
      sqliteKeywords.has(columnName.toUpperCase()) === true
    ) {
      columnName = `${baseName}_${propertyIdSuffix(property.propertyId)}_${attempt.toString()}`
      lowerColumnName = columnName.toLowerCase()
      attempt += 1
    }
    usedNames.add(lowerColumnName)
    result.set(property.propertyId, columnName)
  }
  return result
}

const rowsColumnReadExpression = ({
  propertyId,
  propertyType,
  columnName,
}: {
  readonly propertyId: string
  readonly propertyType: string
  readonly columnName: string
}): string => {
  const valueExpression =
    propertyType === 'number'
      ? 'c.value_number'
      : propertyType === 'checkbox'
        ? 'c.value_boolean'
        : propertyType === 'date'
          ? "json_extract(c.value_json, '$.start')"
          : isRowsWritablePropertyType(propertyType) === true
            ? 'c.value_text'
            : 'c.value_json'
  return `(SELECT ${valueExpression}
          FROM _nds_replica_cells_effective c
          WHERE c.data_source_id = r.data_source_id
            AND c.property_id = ${quoteStringLiteral(propertyId)}
            AND (
              c.page_id = r.page_id
              OR (c.local_row_id IS NOT NULL AND c.local_row_id = r.local_row_id)
            )
          LIMIT 1) AS ${quoteIdentifier(columnName)}`
}

const rowsValueReference = ({
  scope,
  columnName,
}: {
  readonly scope: 'NEW' | 'OLD'
  readonly columnName: string
}): string => `${scope}.${quoteIdentifier(columnName)}`

const optionNamesFromPropertyConfig = ({
  configJson,
  propertyType,
}: {
  readonly configJson: string | undefined
  readonly propertyType: string
}): readonly string[] => {
  if (configJson === undefined) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(configJson)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const payload = parsed as Record<string, unknown>
  const typed =
    typeof payload.configJson === 'string'
      ? (() => {
          try {
            const nested = JSON.parse(payload.configJson)
            return typeof nested === 'object' && nested !== null
              ? (nested as Record<string, unknown>)
              : payload
          } catch {
            return payload
          }
        })()
      : payload
  const container = typed[propertyType]
  if (typeof container !== 'object' || container === null) return []
  const options = (container as Record<string, unknown>).options
  if (Array.isArray(options) === false) return []
  return [
    ...new Set(
      options
        .map((option) =>
          typeof option === 'object' && option !== null && 'name' in option
            ? (option as { readonly name?: unknown }).name
            : undefined,
        )
        .filter((name): name is string => typeof name === 'string' && name.trim().length > 0),
    ),
  ].toSorted()
}

const rowsValueShapePredicate = ({
  columnName,
  configJson,
  propertyType,
}: {
  readonly columnName: string
  readonly configJson: string | undefined
  readonly propertyType: string
}): string => {
  const value = rowsValueReference({ scope: 'NEW', columnName })
  switch (propertyType) {
    case 'title':
    case 'rich_text':
    case 'date':
      return `${value} IS NOT NULL AND typeof(${value}) = 'text'`
    case 'number':
      return `${value} IS NOT NULL AND typeof(${value}) IN ('integer', 'real')`
    case 'checkbox':
      return `${value} IS NOT NULL AND typeof(${value}) = 'integer' AND ${value} IN (0, 1)`
    case 'select':
    case 'status': {
      const optionNames = optionNamesFromPropertyConfig({ configJson, propertyType })
      const optionGuard =
        optionNames.length === 0
          ? '0'
          : `${value} IN (${optionNames.map(quoteStringLiteral).join(', ')})`
      return `${value} IS NULL OR (typeof(${value}) = 'text' AND length(trim(${value})) > 0 AND ${optionGuard})`
    }
    case 'email':
    case 'url':
    case 'phone_number':
      return `${value} IS NULL OR typeof(${value}) = 'text'`
    default:
      return '0'
  }
}

const rowsCanonicalValueExpression = ({
  columnName,
  propertyType,
}: {
  readonly columnName: string
  readonly propertyType: string
}): string => {
  const value = rowsValueReference({ scope: 'NEW', columnName })
  switch (propertyType) {
    case 'title':
      return `json_object('_tag', 'title', 'plainText', ${value})`
    case 'rich_text':
      return `json_object('_tag', 'rich_text', 'plainText', ${value})`
    case 'number':
      return `json_object('_tag', 'number', 'value', ${value})`
    case 'checkbox':
      return `json_object('_tag', 'checkbox', 'checked', CASE WHEN ${value} THEN json('true') ELSE json('false') END)`
    case 'date':
      return `json_object('_tag', 'date', 'start', ${value}, 'end', NULL)`
    case 'select':
      return `json_object('_tag', 'select', 'option', CASE WHEN ${value} IS NULL THEN NULL ELSE json_object('_tag', 'CanonicalOptionValue', 'name', ${value}) END)`
    case 'status':
      return `json_object('_tag', 'status', 'option', CASE WHEN ${value} IS NULL THEN NULL ELSE json_object('_tag', 'CanonicalOptionValue', 'name', ${value}) END)`
    case 'email':
      return `json_object('_tag', 'email', 'value', ${value})`
    case 'url':
      return `json_object('_tag', 'url', 'value', ${value})`
    case 'phone_number':
      return `json_object('_tag', 'phone_number', 'value', ${value})`
    default:
      return 'NULL'
  }
}

const rebuildCanonicalRowsSurface = (db: DatabaseSync): void => {
  db.exec(`
    DROP TRIGGER IF EXISTS rows_update;
    DROP TRIGGER IF EXISTS rows_insert;
    DROP TRIGGER IF EXISTS rows_delete;
    DROP VIEW IF EXISTS ${quoteIdentifier(pagesViewName)};
    DELETE FROM _nds_replica_property_column_plan;
  `)

  const dataSources = db
    .prepare(`SELECT data_source_id FROM _nds_replica_data_sources ORDER BY data_source_id`)
    .all() as SqlRow[]
  if (dataSources.length !== 1) return

  const dataSourceId = readString({ row: dataSources[0]!, key: 'data_source_id' })
  const properties = db
    .prepare(
      `SELECT property_id, property_name, property_type, write_class, config_json
       FROM _nds_replica_properties
       WHERE data_source_id = ?
       ORDER BY schema_ordinal, property_id`,
    )
    .all(dataSourceId) as SqlRow[]
  const plannedNames = planRowsColumnNames(
    properties.map((property) => ({
      propertyId: readString({ row: property, key: 'property_id' }),
      propertyName: readString({ row: property, key: 'property_name' }),
    })),
  )
  const now = new Date().toISOString()
  properties.forEach((property, index) => {
    const propertyId = readString({ row: property, key: 'property_id' })
    const propertyType = readString({ row: property, key: 'property_type' })
    const writeClass = readString({ row: property, key: 'write_class' })
    const isWriteSupported =
      writeClass === 'writable' && isRowsWritablePropertyType(propertyType) === true ? 1 : 0
    db.prepare(
      `INSERT INTO _nds_replica_property_column_plan (
         data_source_id, property_id, property_name, column_name, property_type, write_class,
         ordinal, is_scalar_read_supported, is_rows_write_supported, null_write_behavior,
         config_json, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      dataSourceId,
      propertyId,
      readString({ row: property, key: 'property_name' }),
      plannedNames.get(propertyId) ?? `property_${propertyIdSuffix(propertyId)}`,
      propertyType,
      writeClass,
      index,
      isRowsWritablePropertyType(propertyType) === true ? 1 : 0,
      isWriteSupported,
      nullWriteBehaviorForPropertyType(propertyType),
      readOptionalString({ row: property, key: 'config_json' }) ?? null,
      now,
    )
  })

  const plannedProperties = db
    .prepare(
      `SELECT property_id, property_type, column_name, is_rows_write_supported, config_json
       FROM _nds_replica_property_column_plan
       WHERE data_source_id = ?
       ORDER BY ordinal`,
    )
    .all(dataSourceId) as SqlRow[]
  const propertySelects = plannedProperties.map((property) =>
    rowsColumnReadExpression({
      propertyId: readString({ row: property, key: 'property_id' }),
      propertyType: readString({ row: property, key: 'property_type' }),
      columnName: readString({ row: property, key: 'column_name' }),
    }),
  )
  db.exec(`
    CREATE VIEW ${quoteIdentifier(pagesViewName)} AS
    SELECT
      ${propertySelects.length === 0 ? '' : `${propertySelects.join(',\n      ')},`}
      r.page_id AS ${quoteIdentifier('_page_id')},
      r.data_source_id AS ${quoteIdentifier('_data_source_id')},
      r.local_row_id AS ${quoteIdentifier('_local_page_id')},
      rc.client_request_key AS ${quoteIdentifier('_client_request_key')},
      r.origin AS ${quoteIdentifier('_origin')},
      r.properties_hash AS ${quoteIdentifier('_properties_hash')},
      r.in_trash AS ${quoteIdentifier('_in_trash')},
      r.moved_out AS ${quoteIdentifier('_moved_out')},
      r.local_delete_candidate AS ${quoteIdentifier('_local_delete_candidate')},
      r.sync_status AS ${quoteIdentifier('_sync_status')},
      r.observed_event_id AS ${quoteIdentifier('_observed_event_id')},
      r.observed_at AS ${quoteIdentifier('_observed_at')},
      r.updated_at AS ${quoteIdentifier('_updated_at')}
    FROM _nds_replica_rows_effective r
    LEFT JOIN _nds_replica_row_creates rc
      ON rc.data_source_id = r.data_source_id
     AND rc.local_row_id = r.local_row_id
    WHERE r.data_source_id = ${quoteStringLiteral(dataSourceId)};
  `)

  const systemGuards = rowsSystemColumns
    .filter((column) => column !== '_in_trash')
    .map(
      (column) =>
        `SELECT RAISE(ABORT, 'pages system columns are read-only except _in_trash')
         WHERE ${rowsValueReference({ scope: 'NEW', columnName: column })} IS NOT ${rowsValueReference({ scope: 'OLD', columnName: column })};`,
    )
  const propertyGuards = plannedProperties.map((property) => {
    const columnName = readString({ row: property, key: 'column_name' })
    const propertyType = readString({ row: property, key: 'property_type' })
    const isWriteSupported = readNumber({ row: property, key: 'is_rows_write_supported' }) === 1
    const changed = `${rowsValueReference({ scope: 'NEW', columnName })} IS NOT ${rowsValueReference({ scope: 'OLD', columnName })}`
    if (isWriteSupported === false) {
      return `SELECT RAISE(ABORT, 'pages property column is not supported for direct writes')
              WHERE ${changed};`
    }
    const configJson = readOptionalString({ row: property, key: 'config_json' })
    return `SELECT RAISE(ABORT, 'pages property column value is malformed or uses unsupported NULL behavior')
            WHERE ${changed} AND NOT (${rowsValueShapePredicate({ columnName, configJson, propertyType })});`
  })
  const propertyUpdates = plannedProperties
    .filter((property) => readNumber({ row: property, key: 'is_rows_write_supported' }) === 1)
    .map((property) => {
      const columnName = readString({ row: property, key: 'column_name' })
      const propertyId = readString({ row: property, key: 'property_id' })
      const valueExpression = rowsCanonicalValueExpression({
        columnName,
        propertyType: readString({ row: property, key: 'property_type' }),
      })
      const changed = `${rowsValueReference({ scope: 'NEW', columnName })} IS NOT ${rowsValueReference({ scope: 'OLD', columnName })}`
      return `UPDATE _nds_replica_cells
              SET value_json = ${valueExpression}
              WHERE page_id = OLD.${quoteIdentifier('_page_id')}
                AND property_id = ${quoteStringLiteral(propertyId)}
                AND ${changed};
              INSERT INTO _nds_replica_cell_changes (
                change_id, data_source_id, page_id, property_id, value_json, base_hash
              )
              SELECT
                'cell:' || OLD.${quoteIdentifier('_page_id')} || ':' || ${quoteStringLiteral(propertyId)} || ':' || lower(hex(randomblob(8))),
                ${quoteStringLiteral(dataSourceId)},
                OLD.${quoteIdentifier('_page_id')},
                ${quoteStringLiteral(propertyId)},
                ${valueExpression},
                NULL
              WHERE ${changed}
                AND NOT EXISTS (
                  SELECT 1
                  FROM _nds_replica_cells
                  WHERE page_id = OLD.${quoteIdentifier('_page_id')}
                    AND property_id = ${quoteStringLiteral(propertyId)}
                );`
    })
  const insertPropertyGuards = plannedProperties.map((property) => {
    const columnName = readString({ row: property, key: 'column_name' })
    const propertyType = readString({ row: property, key: 'property_type' })
    const isWriteSupported = readNumber({ row: property, key: 'is_rows_write_supported' }) === 1
    const newValue = rowsValueReference({ scope: 'NEW', columnName })
    if (isWriteSupported === false) {
      return `SELECT RAISE(ABORT, 'pages INSERT includes a property that is not supported for page-create CDC')
              WHERE ${newValue} IS NOT NULL;`
    }
    const configJson = readOptionalString({ row: property, key: 'config_json' })
    return `SELECT RAISE(ABORT, 'pages INSERT property value is malformed or uses unsupported NULL behavior')
            WHERE ${newValue} IS NOT NULL AND NOT (${rowsValueShapePredicate({ columnName, configJson, propertyType })});`
  })
  const insertValueRows = plannedProperties
    .filter((property) => readNumber({ row: property, key: 'is_rows_write_supported' }) === 1)
    .map((property) => {
      const columnName = readString({ row: property, key: 'column_name' })
      return `SELECT
                ${quoteStringLiteral(readString({ row: property, key: 'property_id' }))} AS property_id,
                CASE
                  WHEN ${rowsValueReference({ scope: 'NEW', columnName })} IS NULL THEN NULL
                  ELSE ${rowsCanonicalValueExpression({
                    columnName,
                    propertyType: readString({ row: property, key: 'property_type' }),
                  })}
                END AS value_json`
    })
  db.exec(`
    CREATE TRIGGER _nds_pages_update
    INSTEAD OF UPDATE ON ${quoteIdentifier(pagesViewName)}
    FOR EACH ROW
    BEGIN
      SELECT RAISE(ABORT, 'pages UPDATE only supports applied remote pages')
      WHERE OLD.${quoteIdentifier('_origin')} != 'remote';
      ${systemGuards.join('\n      ')}
      SELECT RAISE(ABORT, 'pages._in_trash must be 0 or 1')
      WHERE NEW.${quoteIdentifier('_in_trash')} IS NOT OLD.${quoteIdentifier('_in_trash')}
        AND (typeof(NEW.${quoteIdentifier('_in_trash')}) != 'integer' OR NEW.${quoteIdentifier('_in_trash')} NOT IN (0, 1));
      ${propertyGuards.join('\n      ')}
      UPDATE _nds_replica_rows
      SET in_trash = NEW.${quoteIdentifier('_in_trash')}
      WHERE page_id = OLD.${quoteIdentifier('_page_id')}
        AND NEW.${quoteIdentifier('_in_trash')} IS NOT OLD.${quoteIdentifier('_in_trash')};
      ${propertyUpdates.join('\n      ')}
    END;

    CREATE TRIGGER _nds_pages_insert
    INSTEAD OF INSERT ON ${quoteIdentifier(pagesViewName)}
    FOR EACH ROW
    BEGIN
      SELECT RAISE(ABORT, 'pages INSERT cannot create archived pages')
      WHERE NEW.${quoteIdentifier('_in_trash')} IS NOT NULL AND NEW.${quoteIdentifier('_in_trash')} != 0;
      ${rowsSystemColumns
        .filter(
          (column) =>
            !['_page_id', '_local_page_id', '_client_request_key', '_in_trash'].includes(column),
        )
        .map(
          (column) =>
            `SELECT RAISE(ABORT, 'pages INSERT system columns are generated by the replica')
             WHERE NEW.${quoteIdentifier(column)} IS NOT NULL;`,
        )
        .join('\n      ')}
      ${insertPropertyGuards.join('\n      ')}
      INSERT INTO _nds_replica_row_creates (
        change_id,
        data_source_id,
        local_row_id,
        client_request_key,
        initial_values_json,
        base_schema_hash
      )
      SELECT
        'row:create:' || lower(hex(randomblob(8))),
        ${quoteStringLiteral(dataSourceId)},
        COALESCE(NEW.${quoteIdentifier('_local_page_id')}, NEW.${quoteIdentifier('_page_id')}, 'local:' || lower(hex(randomblob(8)))),
        COALESCE(NEW.${quoteIdentifier('_client_request_key')}, NEW.${quoteIdentifier('_local_page_id')}, NEW.${quoteIdentifier('_page_id')}, 'client:' || lower(hex(randomblob(8)))),
        COALESCE(
          (
            SELECT json_group_object(property_id, json(value_json))
            FROM (
              ${insertValueRows.length === 0 ? 'SELECT NULL AS property_id, NULL AS value_json WHERE 0' : insertValueRows.join('\n              UNION ALL\n              ')}
            )
            WHERE value_json IS NOT NULL
          ),
          '{}'
        ),
        (SELECT schema_hash FROM _nds_replica_data_sources WHERE data_source_id = ${quoteStringLiteral(dataSourceId)});
    END;

    CREATE TRIGGER _nds_pages_delete
    INSTEAD OF DELETE ON ${quoteIdentifier(pagesViewName)}
    FOR EACH ROW
    BEGIN
      SELECT RAISE(ABORT, 'DELETE FROM pages is intentionally unsupported; update _in_trash for archive CDC');
    END;
  `)
}

const rebuildGeneratedViews = (db: DatabaseSync): void => {
  const existing = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'view' AND name LIKE '_nds_replica_view_%'`,
    )
    .all() as SqlRow[]
  for (const row of existing)
    db.exec(`DROP VIEW IF EXISTS ${quoteIdentifier(readString({ row, key: 'name' }))}`)

  const dataSources = db
    .prepare(`SELECT data_source_id FROM _nds_replica_data_sources ORDER BY data_source_id`)
    .all() as SqlRow[]
  for (const dataSource of dataSources) {
    const dataSourceId = readString({ row: dataSource, key: 'data_source_id' })
    const properties = db
      .prepare(
        `SELECT property_id, property_name
         FROM _nds_replica_properties
         WHERE data_source_id = ?
         ORDER BY property_name, property_id`,
      )
      .all(dataSourceId) as SqlRow[]
    const usedNames = new Map<string, number>()
    const columns = properties.map((property) => {
      const propertyId = readString({ row: property, key: 'property_id' })
      const baseName = readString({ row: property, key: 'property_name' })
      const count = usedNames.get(baseName) ?? 0
      usedNames.set(baseName, count + 1)
      const columnName = count === 0 ? baseName : `${baseName}_${propertyId.slice(0, 8)}`
      return `(SELECT value_text FROM _nds_replica_cells c WHERE c.page_id = r.page_id AND c.property_id = ${quoteStringLiteral(propertyId)}) AS ${quoteIdentifier(columnName)}`
    })
    const viewName = `_nds_replica_view_${slugForView(dataSourceId).slice(0, 48)}`
    db.exec(`
      CREATE VIEW ${quoteIdentifier(viewName)} AS
      SELECT
        r.page_id,
        r.data_source_id,
        r.in_trash,
        r.moved_out
        ${columns.length === 0 ? '' : `,\n        ${columns.join(',\n        ')}`}
      FROM _nds_replica_rows r
      WHERE r.data_source_id = ${quoteStringLiteral(dataSourceId)};
    `)
  }
  rebuildCanonicalRowsSurface(db)
}

/** Workspace binding materialized from the control plane for the public views. */
type ProjectionWorkspaceBinding = {
  readonly dataSourceId: string
  readonly databaseId: string | undefined
  readonly workspaceRoot: string
}

/**
 * Reads the root's workspace binding from the control-plane store. Returns
 * `undefined` when the store carries no binding (e.g. a freshly-discovered
 * source) so the public views fall back to `NULL` columns rather than failing.
 */
const readWorkspaceBindingForProjection = ({
  syncDb,
  rootId,
}: {
  readonly syncDb: DatabaseSync
  readonly rootId: string
}): ProjectionWorkspaceBinding | undefined => {
  const row = syncDb
    .prepare(
      `SELECT data_source_id, database_id, workspace_root
       FROM _nds_workspace_binding
       WHERE root_id = ?
       ORDER BY updated_at DESC
       LIMIT 1`,
    )
    .get(rootId) as SqlRow | undefined
  if (row === undefined) return undefined
  const workspaceRoot = readOptionalString({ row, key: 'workspace_root' })
  if (workspaceRoot === undefined) return undefined
  return {
    dataSourceId: readString({ row, key: 'data_source_id' }),
    databaseId: readOptionalString({ row, key: 'database_id' }),
    workspaceRoot,
  }
}

/** Control-plane aggregate counts materialized into `_nds_replica_sync_status`. */
type ControlPlaneStatusCounts = {
  readonly pendingOutbox: number
  readonly blockedOutbox: number
  readonly guardBlocks: number
  readonly unclassifiedTombstones: number
  readonly unsupportedCapabilities: number
  readonly incompleteHydration: number
}

/**
 * Computes the `sync_status` aggregate counts that source from control-plane
 * tables (DD-B, decision 0020). Run against the sync store (`state.sqlite` once the
 * control plane is split out) so the data file's `sync_status` view can read
 * only the materialized projection table.
 */
const readControlPlaneStatusCounts = ({
  syncDb,
  rootId,
}: {
  readonly syncDb: DatabaseSync
  readonly rootId: string
}): ControlPlaneStatusCounts => {
  const row = syncDb
    .prepare(
      `SELECT
         (SELECT count(*) FROM _nds_outbox WHERE root_id = ? AND state IN ('queued', 'running', 'retryable')) AS pending_outbox,
         (SELECT count(*) FROM _nds_outbox WHERE root_id = ? AND state IN ('blocked', 'fenced', 'ambiguous')) AS blocked_outbox,
         (SELECT count(*) FROM _nds_guard_block WHERE root_id = ?) AS guard_blocks,
         (SELECT count(*) FROM _nds_tombstone WHERE root_id = ? AND classification = 'unclassified') AS unclassified_tombstones,
         (SELECT count(*) FROM _nds_capability WHERE root_id = ? AND supported = 0) AS unsupported_capabilities,
         (
           (SELECT count(*) FROM _nds_query_scan_checkpoint WHERE root_id = ? AND complete = 0)
           + (SELECT count(*) FROM _nds_query_scan_checkpoint WHERE root_id = ? AND capped_at_limit = 1)
           + (SELECT count(*) FROM _nds_query_scan_checkpoint WHERE root_id = ? AND contract_changed = 1)
           + (SELECT count(*) FROM _nds_page_property_checkpoint WHERE root_id = ? AND complete = 0)
         ) AS incomplete_hydration`,
    )
    .get(rootId, rootId, rootId, rootId, rootId, rootId, rootId, rootId, rootId) as SqlRow
  return {
    pendingOutbox: readNumber({ row, key: 'pending_outbox' }),
    blockedOutbox: readNumber({ row, key: 'blocked_outbox' }),
    guardBlocks: readNumber({ row, key: 'guard_blocks' }),
    unclassifiedTombstones: readNumber({ row, key: 'unclassified_tombstones' }),
    unsupportedCapabilities: readNumber({ row, key: 'unsupported_capabilities' }),
    incompleteHydration: readNumber({ row, key: 'incomplete_hydration' }),
  }
}

/** Project the sync store's authoritative events into a user-facing SQLite replica. */
export const projectReplicaFromSyncStore = (options: ProjectReplicaOptions): void => {
  mkdirSync(dirname(options.replicaPath), { recursive: true })
  const unified = options.syncStorePath === options.replicaPath
  const syncDb = new DatabaseSync(options.syncStorePath, unified === true ? {} : { readOnly: true })
  const replicaDb = unified === true ? syncDb : new DatabaseSync(options.replicaPath)
  try {
    createReplicaSchema(replicaDb)
    const schemaPayloads = latestDataSourcePayloads({ syncDb, rootId: options.rootId })
    const valueJsonByCell = latestPropertyValueJson({ syncDb, rootId: options.rootId })
    // Materialize the control-plane workspace binding (lives in state.sqlite once
    // the control plane is split out) so the public `schema`/`sync_status` views
    // stay standalone-queryable against the data file (DD-A/DD-B, decision 0020).
    const workspaceBinding = readWorkspaceBindingForProjection({ syncDb, rootId: options.rootId })
    replicaDb.exec('BEGIN IMMEDIATE')
    try {
      clearProjectedReplicaTables(replicaDb)
      const now = new Date().toISOString()
      const metadataRows = syncDb
        .prepare(
          `SELECT event_json
           FROM _nds_sync_event
           WHERE root_id = ? AND event_type = 'DataSourceMetadataObserved'
           ORDER BY sequence`,
        )
        .all(options.rootId) as SqlRow[]
      const metadata = new Map<
        string,
        {
          readonly hash: string
          readonly parentDatabaseId: string | undefined
          readonly metadataJson: string | undefined
          readonly titlePlainText: string | undefined
          readonly descriptionPlainText: string | undefined
        }
      >()
      for (const row of metadataRows) {
        const event = JSON.parse(readString({ row, key: 'event_json' })) as {
          readonly dataSourceId?: unknown
          readonly parentDatabaseId?: unknown
          readonly metadataHash?: unknown
          readonly metadataJson?: unknown
          readonly titlePlainText?: unknown
          readonly descriptionPlainText?: unknown
        }
        if (typeof event.dataSourceId === 'string' && typeof event.metadataHash === 'string') {
          metadata.set(event.dataSourceId, {
            hash: event.metadataHash,
            parentDatabaseId:
              typeof event.parentDatabaseId === 'string' ? event.parentDatabaseId : undefined,
            metadataJson: typeof event.metadataJson === 'string' ? event.metadataJson : undefined,
            titlePlainText:
              typeof event.titlePlainText === 'string' ? event.titlePlainText : undefined,
            descriptionPlainText:
              typeof event.descriptionPlainText === 'string'
                ? event.descriptionPlainText
                : undefined,
          })
        }
      }

      for (const row of syncDb
        .prepare(
          `SELECT data_source_id, schema_hash, observed_event_id, observed_at, updated_at
           FROM _nds_data_source
           WHERE root_id = ?
           ORDER BY data_source_id`,
        )
        .all(options.rootId) as SqlRow[]) {
        const dataSourceId = readString({ row, key: 'data_source_id' })
        const metadataRow = metadata.get(dataSourceId)
        // The binding is root-keyed; it materializes onto exactly the data source
        // it names, matching the prior `binding.data_source_id = ds.data_source_id`
        // join (decision 0020). Other sources in a multi-source root carry no binding.
        const bindingForSource =
          workspaceBinding?.dataSourceId === dataSourceId ? workspaceBinding : undefined
        replicaDb
          .prepare(
            `INSERT INTO _nds_replica_data_sources (
               data_source_id, root_id, schema_hash, metadata_hash, metadata_json, title_plain_text,
               description_plain_text, parent_database_id, observed_event_id, observed_at, updated_at,
               workspace_binding_database_id, workspace_root
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            dataSourceId,
            options.rootId,
            readString({ row, key: 'schema_hash' }),
            metadataRow?.hash ?? null,
            metadataRow?.metadataJson ?? null,
            metadataRow?.titlePlainText ?? null,
            metadataRow?.descriptionPlainText ?? null,
            metadataRow?.parentDatabaseId ?? null,
            readString({ row, key: 'observed_event_id' }),
            readOptionalString({ row, key: 'observed_at' }) ?? null,
            readString({ row, key: 'updated_at' }),
            bindingForSource?.databaseId ?? null,
            bindingForSource?.workspaceRoot ?? null,
          )
        if (metadataRow?.parentDatabaseId !== undefined && metadataRow.metadataJson !== undefined) {
          replicaDb
            .prepare(
              `INSERT OR REPLACE INTO _nds_replica_databases (
                 database_id, data_source_id, root_id, metadata_hash, metadata_json,
                 title_plain_text, description_plain_text, observed_event_id, observed_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              metadataRow.parentDatabaseId,
              dataSourceId,
              options.rootId,
              metadataRow.hash,
              metadataRow.metadataJson,
              metadataRow.titlePlainText ?? null,
              metadataRow.descriptionPlainText ?? null,
              readString({ row, key: 'observed_event_id' }),
              readOptionalString({ row, key: 'observed_at' }) ?? null,
              readString({ row, key: 'updated_at' }),
            )
        }
      }

      for (const row of syncDb
        .prepare(
          `SELECT data_source_id, property_id, schema_hash, config_hash, write_class, observed_event_id, updated_at
           FROM _nds_schema_property
           WHERE root_id = ?
           ORDER BY data_source_id, property_id`,
        )
        .all(options.rootId) as SqlRow[]) {
        const propertyId = readString({ row, key: 'property_id' })
        const schemaPropertyPayload = schemaPayloads.get(propertyId)
        const payload = schemaPropertyPayload?.payload
        replicaDb
          .prepare(
            `INSERT INTO _nds_replica_properties (
               data_source_id, property_id, property_name, property_type, config_hash, schema_hash,
               write_class, schema_ordinal, config_json, observed_event_id, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            readString({ row, key: 'data_source_id' }),
            propertyId,
            typeof payload?.name === 'string' ? payload.name : propertyId,
            typeof payload?.type === 'string' ? payload.type : 'unknown',
            readString({ row, key: 'config_hash' }),
            readString({ row, key: 'schema_hash' }),
            readString({ row, key: 'write_class' }),
            schemaPropertyPayload?.ordinal ?? 0,
            payload === undefined ? null : JSON.stringify(payload),
            readString({ row, key: 'observed_event_id' }),
            readString({ row, key: 'updated_at' }),
          )
      }

      for (const row of syncDb
        .prepare(
          `SELECT event_json, observed_at
           FROM _nds_sync_event
           WHERE root_id = ? AND event_type = 'DataSourceViewObserved'
           ORDER BY sequence`,
        )
        .all(options.rootId) as SqlRow[]) {
        const event = JSON.parse(readString({ row, key: 'event_json' })) as {
          readonly dataSourceId?: unknown
          readonly databaseId?: unknown
          readonly viewId?: unknown
          readonly viewName?: unknown
          readonly viewType?: unknown
          readonly viewHash?: unknown
          readonly viewJson?: unknown
          readonly eventId?: unknown
        }
        if (
          typeof event.dataSourceId !== 'string' ||
          typeof event.databaseId !== 'string' ||
          typeof event.viewId !== 'string' ||
          typeof event.viewName !== 'string' ||
          typeof event.viewType !== 'string' ||
          typeof event.viewHash !== 'string' ||
          typeof event.viewJson !== 'string' ||
          typeof event.eventId !== 'string'
        ) {
          continue
        }
        replicaDb
          .prepare(
            `INSERT INTO _nds_replica_views (
               view_id, database_id, data_source_id, root_id, view_name, view_type, view_hash,
               view_json, observed_event_id, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(view_id) DO UPDATE SET
               database_id = excluded.database_id,
               data_source_id = excluded.data_source_id,
               root_id = excluded.root_id,
               view_name = excluded.view_name,
               view_type = excluded.view_type,
               view_hash = excluded.view_hash,
               view_json = excluded.view_json,
               observed_event_id = excluded.observed_event_id,
               updated_at = excluded.updated_at`,
          )
          .run(
            event.viewId,
            event.databaseId,
            event.dataSourceId,
            options.rootId,
            event.viewName,
            event.viewType,
            event.viewHash,
            event.viewJson,
            event.eventId,
            readOptionalString({ row, key: 'observed_at' }) ?? now,
          )
      }

      for (const row of syncDb
        .prepare(
          `SELECT data_source_id, page_id, properties_hash, in_trash, moved_out, local_delete_candidate,
                  observed_event_id, observed_at, updated_at
           FROM _nds_row
           WHERE root_id = ?
           ORDER BY data_source_id, page_id`,
        )
        .all(options.rootId) as SqlRow[]) {
        replicaDb
          .prepare(
            `INSERT INTO _nds_replica_rows (
               data_source_id, page_id, properties_hash, in_trash, moved_out, local_delete_candidate,
               observed_event_id, observed_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            readString({ row, key: 'data_source_id' }),
            readString({ row, key: 'page_id' }),
            readString({ row, key: 'properties_hash' }),
            readNumber({ row, key: 'in_trash' }),
            readNumber({ row, key: 'moved_out' }),
            readNumber({ row, key: 'local_delete_candidate' }),
            readString({ row, key: 'observed_event_id' }),
            readOptionalString({ row, key: 'observed_at' }) ?? null,
            readString({ row, key: 'updated_at' }),
          )
      }

      for (const row of syncDb
        .prepare(
          `SELECT
             ps.page_id,
             rp.data_source_id,
             ps.property_id,
             ps.base_hash,
             ps.remote_hash,
             ps.availability,
             ps.observed_event_id,
             ps.updated_at
           FROM _nds_property_shadow ps
           JOIN _nds_row rp ON rp.root_id = ps.root_id AND rp.page_id = ps.page_id
           WHERE ps.root_id = ?
           ORDER BY rp.data_source_id, ps.page_id, ps.property_id`,
        )
        .all(options.rootId) as SqlRow[]) {
        const pageId = readString({ row, key: 'page_id' })
        const propertyId = readString({ row, key: 'property_id' })
        const dataSourceId = readString({ row, key: 'data_source_id' })
        const property = replicaDb
          .prepare(
            `SELECT property_name, property_type, write_class
             FROM _nds_replica_properties
             WHERE data_source_id = ? AND property_id = ?`,
          )
          .get(dataSourceId, propertyId) as SqlRow | undefined
        const valueJson = valueJsonByCell.get(`${pageId}\0${propertyId}`)
        const scalar = scalarColumns(valueJson)
        // Name-only convergence base (SM5c): the cross-surface comparison space the
        // `.nmd` frontmatter can also reach (id/color stripped, cleared scalars
        // folded). Distinct from `remote_hash` (full-canonical remote-write base).
        const convergenceHashValue = valueJson === undefined ? null : convergenceFormHash(valueJson)
        replicaDb
          .prepare(
            `INSERT INTO _nds_replica_cells (
               data_source_id, page_id, property_id, property_name, property_type, value_json,
               value_text, value_number, value_boolean, base_hash, remote_hash, convergence_hash,
               availability, write_class, observed_event_id, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            dataSourceId,
            pageId,
            propertyId,
            property === undefined
              ? propertyId
              : readString({ row: property, key: 'property_name' }),
            property === undefined
              ? 'unknown'
              : readString({ row: property, key: 'property_type' }),
            valueJson ?? null,
            scalar.text ?? null,
            scalar.number ?? null,
            scalar.boolean ?? null,
            readString({ row, key: 'base_hash' }),
            readString({ row, key: 'remote_hash' }),
            convergenceHashValue,
            readString({ row, key: 'availability' }),
            property === undefined
              ? 'unsupported'
              : readString({ row: property, key: 'write_class' }),
            readString({ row, key: 'observed_event_id' }),
            readString({ row, key: 'updated_at' }),
          )
        if (valueJson !== undefined && property !== undefined) {
          const propertyType = readString({ row: property, key: 'property_type' })
          if (
            propertyType === 'relation' &&
            readString({ row, key: 'availability' }) === 'complete'
          ) {
            const parsed = JSON.parse(valueJson) as {
              readonly _tag?: unknown
              readonly pageIds?: unknown
            }
            if (parsed._tag === 'relation' && Array.isArray(parsed.pageIds) === true) {
              for (const targetPageId of parsed.pageIds) {
                if (typeof targetPageId !== 'string') continue
                replicaDb
                  .prepare(
                    `INSERT OR IGNORE INTO _nds_replica_relation_targets (
                       data_source_id, property_id, target_page_id, observed_from_page_id,
                       observed_event_id, updated_at
                     ) VALUES (?, ?, ?, ?, ?, ?)`,
                  )
                  .run(
                    dataSourceId,
                    propertyId,
                    targetPageId,
                    pageId,
                    readString({ row, key: 'observed_event_id' }),
                    readString({ row, key: 'updated_at' }),
                  )
              }
            }
          }
        }
      }

      for (const row of syncDb
        .prepare(
          `SELECT page_id, path, base_hash, current_hash, sidecar_identity_proven, body_projection_json,
                  observed_event_id, updated_at
           FROM _nds_body_pointer
           WHERE root_id = ?
           ORDER BY page_id`,
        )
        .all(options.rootId) as SqlRow[]) {
        replicaDb
          .prepare(
            `INSERT INTO _nds_replica_bodies (
               page_id, path, base_hash, current_hash, sidecar_identity_proven, body_projection_json,
               observed_event_id, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            readString({ row, key: 'page_id' }),
            readString({ row, key: 'path' }),
            readString({ row, key: 'base_hash' }),
            readString({ row, key: 'current_hash' }),
            readNumber({ row, key: 'sidecar_identity_proven' }),
            readString({ row, key: 'body_projection_json' }),
            readString({ row, key: 'observed_event_id' }),
            readString({ row, key: 'updated_at' }),
          )
      }

      for (const row of syncDb
        .prepare(
          `SELECT conflict_id, page_id, property_id, state, base_hash, local_hash, remote_hash,
                  opened_event_id, resolution_event_id, updated_at
           FROM _nds_conflict
           WHERE root_id = ?
           ORDER BY conflict_id`,
        )
        .all(options.rootId) as SqlRow[]) {
        replicaDb
          .prepare(
            `INSERT INTO _nds_replica_conflicts (
               conflict_id, page_id, property_id, state, base_hash, local_hash, remote_hash,
               opened_event_id, resolution_event_id, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            readString({ row, key: 'conflict_id' }),
            readOptionalString({ row, key: 'page_id' }) ?? null,
            readOptionalString({ row, key: 'property_id' }) ?? null,
            readString({ row, key: 'state' }),
            readOptionalString({ row, key: 'base_hash' }) ?? null,
            readOptionalString({ row, key: 'local_hash' }) ?? null,
            readOptionalString({ row, key: 'remote_hash' }) ?? null,
            readString({ row, key: 'opened_event_id' }),
            readOptionalString({ row, key: 'resolution_event_id' }) ?? null,
            readString({ row, key: 'updated_at' }),
          )
      }

      settleAppliedCellChangesFromProjection({ replicaDb, now })

      const counts = replicaDb
        .prepare(
          `SELECT
             (SELECT count(*) FROM _nds_replica_data_sources) AS data_sources,
             (SELECT count(*) FROM _nds_replica_rows) AS replica_rows,
             (SELECT count(*) FROM _nds_replica_cells) AS cells,
             (SELECT count(*) FROM _nds_replica_bodies) AS bodies,
             ${openReplicaConflictsCountSql} AS conflicts_open,
             ${pendingReplicaChangesCountSql} AS pending_local_changes`,
        )
        .get() as SqlRow
      // DD-B (decision 0020): aggregate counts sourced from control-plane tables are
      // computed against `syncDb` (state.sqlite) here and materialized into the
      // projection table, so the public `sync_status` view never reaches across
      // the file boundary.
      const controlPlaneCounts = readControlPlaneStatusCounts({
        syncDb,
        rootId: options.rootId,
      })
      replicaDb
        .prepare(
          `INSERT INTO _nds_replica_sync_status (
             root_id, data_sources, pages, cells, bodies, conflicts_open, pending_local_changes,
             pending_outbox, blocked_outbox, guard_blocks, unclassified_tombstones,
             unsupported_capabilities, incomplete_hydration, workspace_root, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          options.rootId,
          readNumber({ row: counts, key: 'data_sources' }),
          readNumber({ row: counts, key: 'replica_rows' }),
          readNumber({ row: counts, key: 'cells' }),
          readNumber({ row: counts, key: 'bodies' }),
          readNumber({ row: counts, key: 'conflicts_open' }),
          readNumber({ row: counts, key: 'pending_local_changes' }),
          controlPlaneCounts.pendingOutbox,
          controlPlaneCounts.blockedOutbox,
          controlPlaneCounts.guardBlocks,
          controlPlaneCounts.unclassifiedTombstones,
          controlPlaneCounts.unsupportedCapabilities,
          controlPlaneCounts.incompleteHydration,
          workspaceBinding?.workspaceRoot ?? null,
          now,
        )

      rebuildGeneratedViews(replicaDb)
      // Inside the open projection `BEGIN IMMEDIATE` (above): re-running the full
      // schema must not issue a nested `BEGIN`, so call the in-transaction form.
      createReplicaSchemaInTransaction(replicaDb)
      replicaDb.exec('COMMIT')
    } catch (error) {
      replicaDb.exec('ROLLBACK')
      throw error
    }
  } finally {
    if (unified === false) replicaDb.close()
    syncDb.close()
  }
}

/** Read the queue of pending local changes captured by the replica's CDC triggers. */
export const readPendingReplicaChanges = (replicaPath: string): readonly ReplicaLocalChange[] => {
  const db = new DatabaseSync(replicaPath)
  try {
    createReplicaSchema(db)
    return (
      db
        .prepare(
          `SELECT
             change_id,
             kind,
             data_source_id,
             page_id,
             property_id,
             value_json,
             base_hash,
             status,
             body_path,
             local_body_hash,
             local_body_content,
             metadata_resource_type,
             database_id,
             title_plain_text,
             description_plain_text,
             schema_operation_json,
             file_asset_id,
             file_action,
             file_name,
             file_external_url,
             conflict_id,
             resolution_action,
             local_row_id,
             client_request_key,
             remote_page_id,
             created_at
           FROM (
             SELECT
               change_id,
               'cell_patch' AS kind,
               data_source_id,
               page_id,
               property_id,
               value_json,
               base_hash,
               status,
               NULL AS body_path,
               NULL AS local_body_hash,
               NULL AS local_body_content,
               NULL AS metadata_resource_type,
               NULL AS database_id,
               NULL AS title_plain_text,
               NULL AS description_plain_text,
               NULL AS schema_operation_json,
               NULL AS file_asset_id,
               NULL AS file_action,
               NULL AS file_name,
               NULL AS file_external_url,
               NULL AS conflict_id,
               NULL AS resolution_action,
               NULL AS local_row_id,
               NULL AS client_request_key,
               NULL AS remote_page_id,
               created_at
             FROM _nds_replica_cell_changes
             WHERE status IN ('pending', 'queued')
             UNION ALL
             SELECT
               change_id,
               'row_create' AS kind,
               data_source_id,
               remote_page_id AS page_id,
               NULL AS property_id,
               initial_values_json AS value_json,
               base_schema_hash AS base_hash,
               status,
               NULL AS body_path,
               NULL AS local_body_hash,
               NULL AS local_body_content,
               NULL AS metadata_resource_type,
               NULL AS database_id,
               NULL AS title_plain_text,
               NULL AS description_plain_text,
               NULL AS schema_operation_json,
               NULL AS file_asset_id,
               NULL AS file_action,
               NULL AS file_name,
               NULL AS file_external_url,
               NULL AS conflict_id,
               NULL AS resolution_action,
               local_row_id,
               client_request_key,
               remote_page_id,
               created_at
             FROM _nds_replica_row_creates
             WHERE status IN ('pending', 'queued', 'planned', 'needs_reconciliation')
             UNION ALL
             SELECT
               change_id,
               kind,
               data_source_id,
               page_id,
               NULL AS property_id,
               value_json,
               base_hash,
               status,
               NULL AS body_path,
               NULL AS local_body_hash,
               NULL AS local_body_content,
               NULL AS metadata_resource_type,
               NULL AS database_id,
               NULL AS title_plain_text,
               NULL AS description_plain_text,
               NULL AS schema_operation_json,
               NULL AS file_asset_id,
               NULL AS file_action,
               NULL AS file_name,
               NULL AS file_external_url,
               NULL AS conflict_id,
               NULL AS resolution_action,
               NULL AS local_row_id,
               NULL AS client_request_key,
               NULL AS remote_page_id,
               created_at
             FROM _nds_replica_row_changes
             WHERE status IN ('pending', 'queued') AND kind != 'row_create'
             UNION ALL
             SELECT
               change_id,
               'body_patch' AS kind,
               '' AS data_source_id,
               page_id,
               NULL AS property_id,
               NULL AS value_json,
               base_hash,
               status,
               body_path,
               local_body_hash,
               local_body_content,
               NULL AS metadata_resource_type,
               NULL AS database_id,
               NULL AS title_plain_text,
               NULL AS description_plain_text,
               NULL AS schema_operation_json,
               NULL AS file_asset_id,
               NULL AS file_action,
               NULL AS file_name,
               NULL AS file_external_url,
               NULL AS conflict_id,
               NULL AS resolution_action,
               NULL AS local_row_id,
               NULL AS client_request_key,
               NULL AS remote_page_id,
               created_at
             FROM _nds_replica_body_changes
             WHERE status IN ('pending', 'queued')
             UNION ALL
             SELECT
               change_id,
               'metadata_patch' AS kind,
               data_source_id,
               NULL AS page_id,
               NULL AS property_id,
               NULL AS value_json,
               base_hash,
               status,
               NULL AS body_path,
               NULL AS local_body_hash,
               NULL AS local_body_content,
               resource_type AS metadata_resource_type,
               database_id,
               title_plain_text,
               description_plain_text,
               NULL AS schema_operation_json,
               NULL AS file_asset_id,
               NULL AS file_action,
               NULL AS file_name,
               NULL AS file_external_url,
               NULL AS conflict_id,
               NULL AS resolution_action,
               NULL AS local_row_id,
               NULL AS client_request_key,
               NULL AS remote_page_id,
               created_at
             FROM _nds_replica_metadata_changes
             WHERE status IN ('pending', 'queued')
             UNION ALL
             SELECT
               change_id,
               'schema_patch' AS kind,
               data_source_id,
               NULL AS page_id,
               NULL AS property_id,
               NULL AS value_json,
               base_hash,
               status,
               NULL AS body_path,
               NULL AS local_body_hash,
               NULL AS local_body_content,
               NULL AS metadata_resource_type,
               NULL AS database_id,
               NULL AS title_plain_text,
               NULL AS description_plain_text,
               operation_json AS schema_operation_json,
               NULL AS file_asset_id,
               NULL AS file_action,
               NULL AS file_name,
               NULL AS file_external_url,
               NULL AS conflict_id,
               NULL AS resolution_action,
               NULL AS local_row_id,
               NULL AS client_request_key,
               NULL AS remote_page_id,
               created_at
             FROM _nds_replica_schema_changes
             WHERE status IN ('pending', 'queued')
             UNION ALL
             SELECT
               fc.change_id,
               'file_attach' AS kind,
               fc.data_source_id,
               fc.page_id,
               fc.property_id,
               NULL AS value_json,
               fc.base_hash,
               fc.status,
               NULL AS body_path,
               NULL AS local_body_hash,
               NULL AS local_body_content,
               NULL AS metadata_resource_type,
               NULL AS database_id,
               NULL AS title_plain_text,
               NULL AS description_plain_text,
               NULL AS schema_operation_json,
               fc.asset_id AS file_asset_id,
               fc.action AS file_action,
               fa.name AS file_name,
               fa.external_url AS file_external_url,
               NULL AS conflict_id,
               NULL AS resolution_action,
               NULL AS local_row_id,
               NULL AS client_request_key,
               NULL AS remote_page_id,
               fc.created_at
             FROM _nds_replica_file_changes fc
             JOIN _nds_replica_file_assets fa ON fa.asset_id = fc.asset_id
             WHERE fc.status IN ('pending', 'queued')
             UNION ALL
             SELECT
               change_id,
               'view_change' AS kind,
               COALESCE(data_source_id, '') AS data_source_id,
               NULL AS page_id,
               NULL AS property_id,
               json_object(
                 'action', action,
                 'view_id', view_id,
                 'database_id', database_id,
                 'view_name', view_name,
                 'view_type', view_type,
                 'filter_json', filter_json,
                 'sorts_json', sorts_json,
                 'configuration_json', configuration_json,
                 'destructive_ack', destructive_ack
               ) AS value_json,
               base_hash,
               status,
               NULL AS body_path,
               NULL AS local_body_hash,
               NULL AS local_body_content,
               NULL AS metadata_resource_type,
               database_id,
               NULL AS title_plain_text,
               NULL AS description_plain_text,
               NULL AS schema_operation_json,
               NULL AS file_asset_id,
               NULL AS file_action,
               NULL AS file_name,
               NULL AS file_external_url,
               NULL AS conflict_id,
               NULL AS resolution_action,
               NULL AS local_row_id,
               NULL AS client_request_key,
               NULL AS remote_page_id,
               created_at
             FROM _nds_replica_view_changes
             WHERE status IN ('pending', 'queued')
             UNION ALL
             SELECT
               resolution_id AS change_id,
               'conflict_resolution' AS kind,
               '' AS data_source_id,
               NULL AS page_id,
               NULL AS property_id,
               value_json,
               NULL AS base_hash,
               status,
               NULL AS body_path,
               NULL AS local_body_hash,
               NULL AS local_body_content,
               NULL AS metadata_resource_type,
               NULL AS database_id,
               NULL AS title_plain_text,
               NULL AS description_plain_text,
               NULL AS schema_operation_json,
               NULL AS file_asset_id,
               NULL AS file_action,
               NULL AS file_name,
               NULL AS file_external_url,
               conflict_id,
               action AS resolution_action,
               NULL AS local_row_id,
               NULL AS client_request_key,
               NULL AS remote_page_id,
               created_at
             FROM _nds_replica_conflict_resolutions
             WHERE status IN ('pending', 'queued')
           )
           ORDER BY created_at, change_id`,
        )
        .all() as SqlRow[]
    ).map((row) => ({
      changeId: readString({ row, key: 'change_id' }),
      kind: Schema.decodeUnknownSync(
        Schema.Literals([
          'cell_patch',
          'row_archive',
          'row_restore',
          'row_create',
          'body_patch',
          'metadata_patch',
          'schema_patch',
          'file_attach',
          'view_change',
          'conflict_resolution',
        ]),
      )(readString({ row, key: 'kind' })),
      dataSourceId: readString({ row, key: 'data_source_id' }),
      pageId: readOptionalString({ row, key: 'page_id' }),
      propertyId: readOptionalString({ row, key: 'property_id' }),
      valueJson: readOptionalString({ row, key: 'value_json' }),
      baseHash: readOptionalString({ row, key: 'base_hash' }),
      status: readString({ row, key: 'status' }),
      bodyPath: readOptionalString({ row, key: 'body_path' }),
      localBodyHash: readOptionalString({ row, key: 'local_body_hash' }),
      localBodyContent: readOptionalString({ row, key: 'local_body_content' }),
      metadataResourceType: readOptionalString({ row, key: 'metadata_resource_type' }),
      databaseId: readOptionalString({ row, key: 'database_id' }),
      titlePlainText: readOptionalString({ row, key: 'title_plain_text' }),
      descriptionPlainText: readOptionalString({ row, key: 'description_plain_text' }),
      schemaOperationJson: readOptionalString({ row, key: 'schema_operation_json' }),
      fileAssetId: readOptionalString({ row, key: 'file_asset_id' }),
      fileAction: readOptionalString({ row, key: 'file_action' }),
      fileName: readOptionalString({ row, key: 'file_name' }),
      fileExternalUrl: readOptionalString({ row, key: 'file_external_url' }),
      conflictId: readOptionalString({ row, key: 'conflict_id' }),
      resolutionAction: readOptionalString({ row, key: 'resolution_action' }),
      localRowId: readOptionalString({ row, key: 'local_row_id' }),
      clientRequestKey: readOptionalString({ row, key: 'client_request_key' }),
      remotePageId: readOptionalString({ row, key: 'remote_page_id' }),
    }))
  } finally {
    db.close()
  }
}

/**
 * Observed-base value for one page property, read from the public data file's
 * `_nds_replica_cells` projection joined to its schema. Used by SM5c local
 * convergence to baseline-diff the `.nmd` frontmatter surface: a `.nmd` property
 * is only a desired fact when its canonical value differs from this base.
 */
export type ReplicaCellBase = {
  readonly pageId: string
  readonly dataSourceId: string
  readonly propertyId: string
  /** Visible property name (the `.nmd` frontmatter key); used for name → id resolution. */
  readonly propertyName: string
  readonly propertyType: string
  /**
   * Current canonical `value_json` for this cell. NOTE: a local `pages` edit
   * OVERWRITES this with the desired value, so it is NOT a pristine base — use
   * {@link remoteHash} for the convergence baseline.
   */
  readonly valueJson: string | undefined
  /**
   * Hash of the last REMOTE-observed canonical value (full canonical — keeps
   * select/status option id+color). This is the remote-WRITE base, NOT the
   * convergence base: it lives in a different space than the name-only `.nmd`
   * surface. Do not diff the `.nmd` value against this — use {@link convergenceHash}.
   */
  readonly remoteHash: string
  /**
   * Hash of the last remote-observed value folded into the NAME-ONLY convergence
   * space (`convergenceFormHash`: option id/color stripped, cleared scalars folded
   * to `empty`), so it compares like-with-like against a `.nmd` frontmatter value
   * (which structurally cannot carry id/color). A local `pages` edit does NOT
   * touch this, so it is the pristine convergence base the `.nmd` surface is
   * diffed against. `undefined` only for a non-scalar cell with no `value_json`,
   * which is never convergence-comparable.
   */
  readonly convergenceHash: string | undefined
}

/**
 * Read the observed per-property base values from the public data file. Returns
 * one entry per `(page_id, property_id)` cell, carrying the base `value_json` and
 * the visible property name so the caller can resolve a `.nmd` frontmatter
 * property (keyed by name) to its stable `property_id`.
 */
export const readReplicaCellBases = (replicaPath: string): readonly ReplicaCellBase[] => {
  const db = new DatabaseSync(replicaPath)
  try {
    createReplicaSchema(db)
    return (
      db
        .prepare(
          `SELECT
             c.page_id,
             c.data_source_id,
             c.property_id,
             c.value_json,
             c.remote_hash,
             c.convergence_hash,
             p.property_name,
             p.property_type
           FROM _nds_replica_cells c
           JOIN _nds_replica_properties p
             ON p.data_source_id = c.data_source_id AND p.property_id = c.property_id
           ORDER BY c.page_id, c.property_id`,
        )
        .all() as SqlRow[]
    ).map((row) => ({
      pageId: readString({ row, key: 'page_id' }),
      dataSourceId: readString({ row, key: 'data_source_id' }),
      propertyId: readString({ row, key: 'property_id' }),
      propertyName: readString({ row, key: 'property_name' }),
      propertyType: readString({ row, key: 'property_type' }),
      valueJson: readOptionalString({ row, key: 'value_json' }),
      remoteHash: readString({ row, key: 'remote_hash' }),
      convergenceHash: readOptionalString({ row, key: 'convergence_hash' }),
    }))
  } finally {
    db.close()
  }
}

/** Mark a replica change as planned, applied, rejected, or otherwise progressed. */
export const markReplicaChangeStatus = ({
  replicaPath,
  changeId,
  status,
  unsupportedReason,
}: {
  readonly replicaPath: string
  readonly changeId: string
  readonly status: Exclude<ReplicaChangeStatus, 'pending'>
  readonly unsupportedReason?: string
}): void => {
  const db = new DatabaseSync(replicaPath)
  try {
    createReplicaSchema(db)
    db.prepare(
      `UPDATE _nds_replica_local_changes
       SET status = ?, unsupported_reason = ?, updated_at = ?
       WHERE change_id = ?`,
    ).run(status, unsupportedReason ?? null, new Date().toISOString(), changeId)
    db.prepare(
      `UPDATE _nds_replica_cell_changes
       SET status = ?, unsupported_reason = ?, updated_at = ?
       WHERE change_id = ?`,
    ).run(status, unsupportedReason ?? null, new Date().toISOString(), changeId)
    db.prepare(
      `UPDATE _nds_replica_row_changes
       SET status = ?, unsupported_reason = ?, updated_at = ?
       WHERE change_id = ?`,
    ).run(status, unsupportedReason ?? null, new Date().toISOString(), changeId)
    db.prepare(
      `UPDATE _nds_replica_row_creates
       SET status = ?, unsupported_reason = ?, updated_at = ?
       WHERE change_id = ?`,
    ).run(status, unsupportedReason ?? null, new Date().toISOString(), changeId)
    db.prepare(
      `UPDATE _nds_replica_body_changes
       SET status = ?, unsupported_reason = ?, updated_at = ?
       WHERE change_id = ?`,
    ).run(status, unsupportedReason ?? null, new Date().toISOString(), changeId)
    db.prepare(
      `UPDATE _nds_replica_metadata_changes
       SET status = ?, unsupported_reason = ?, updated_at = ?
       WHERE change_id = ?`,
    ).run(status, unsupportedReason ?? null, new Date().toISOString(), changeId)
    db.prepare(
      `UPDATE _nds_replica_schema_changes
       SET status = ?, unsupported_reason = ?, updated_at = ?
       WHERE change_id = ?`,
    ).run(status, unsupportedReason ?? null, new Date().toISOString(), changeId)
    db.prepare(
      `UPDATE _nds_replica_file_changes
       SET status = ?, unsupported_reason = ?, updated_at = ?
       WHERE change_id = ?`,
    ).run(status, unsupportedReason ?? null, new Date().toISOString(), changeId)
    db.prepare(
      `UPDATE _nds_replica_view_changes
       SET status = ?, unsupported_reason = ?, updated_at = ?
       WHERE change_id = ?`,
    ).run(status, unsupportedReason ?? null, new Date().toISOString(), changeId)
    db.prepare(
      `UPDATE _nds_replica_conflict_resolutions
       SET status = ?, unsupported_reason = ?, updated_at = ?
       WHERE resolution_id = ?`,
    ).run(status, unsupportedReason ?? null, new Date().toISOString(), changeId)
  } finally {
    db.close()
  }
}

const markChange = ({
  replicaPath,
  dryRun,
  changeId,
  status,
  reason,
}: {
  readonly replicaPath: string
  readonly dryRun?: boolean | undefined
  readonly changeId: string
  readonly status: Exclude<ReplicaChangeStatus, 'pending'>
  readonly reason?: string
}): void => {
  if (dryRun === true) return
  markReplicaChangeStatus({
    replicaPath,
    changeId,
    status,
    ...(reason === undefined ? {} : { unsupportedReason: reason }),
  })
}

const conflictResolutionChoiceForChange = (
  change: ReplicaLocalChange,
): Parameters<typeof resolveConflictCommand>[0]['choice'] | string => {
  switch (change.resolutionAction) {
    case 'choose_remote':
    case 'abandon_local':
      return { _tag: 'keep-remote' }
    case 'choose_local':
    case 'manual_value':
      return 'choose_local/manual_value conflict resolution needs property-write post-hash reconciliation before SQLite CDC can execute it safely.'
    case 'retry_after_refresh':
      return 'retry_after_refresh needs a fresh pull/replan workflow before it can be executed from SQLite CDC.'
    default:
      return `Unsupported conflict resolution action: ${change.resolutionAction ?? 'unknown'}.`
  }
}

/** Apply pending conflict-resolution CDC rows through the store-backed user-command surface. */
export const applyReplicaConflictResolutions = ({
  changes,
  replicaPath,
  store,
  rootId,
  dryRun,
  authorityMode,
}: ApplyReplicaConflictResolutionsOptions): void => {
  for (const change of changes) {
    if (change.kind !== 'conflict_resolution') continue
    if (change.conflictId === undefined) {
      markChange({
        replicaPath,
        dryRun,
        changeId: change.changeId,
        status: 'rejected',
        reason: 'conflict_resolution requires conflict_id.',
      })
      continue
    }

    let conflictId: SyncEventId
    try {
      conflictId = decode({ schema: SyncEventId, value: change.conflictId })
    } catch {
      markChange({
        replicaPath,
        dryRun,
        changeId: change.changeId,
        status: 'rejected',
        reason: 'Invalid conflict_id in conflict_resolution.',
      })
      continue
    }

    const choice = conflictResolutionChoiceForChange(change)
    if (typeof choice === 'string') {
      markChange({
        replicaPath,
        dryRun,
        changeId: change.changeId,
        status:
          choice.startsWith('retry_after_refresh') === true ||
          choice.startsWith('Unsupported') === true ||
          choice.startsWith('choose_local/manual_value') === true
            ? 'unsupported'
            : 'rejected',
        reason: choice,
      })
      continue
    }

    const result = resolveConflictCommand({
      store,
      rootId,
      conflictId,
      choice,
      ...(authorityMode === undefined ? {} : { authorityMode }),
      ...(dryRun === undefined ? {} : { dryRun }),
    })
    const guard = result.planned.guards[0]
    if (guard !== undefined) {
      markChange({
        replicaPath,
        dryRun,
        changeId: change.changeId,
        status: 'conflict',
        reason: guard.message,
      })
      continue
    }

    markChange({
      replicaPath,
      dryRun,
      changeId: change.changeId,
      status: result.planned.commands.length > 0 ? 'planned' : 'applied',
    })
  }
}

const surfaceForReplicaChange = (change: ReplicaLocalChange): string | undefined => {
  if (
    change.kind === 'cell_patch' &&
    change.pageId !== undefined &&
    change.propertyId !== undefined
  ) {
    return propertySurfaceKey({
      pageId: decode({ schema: PageId, value: change.pageId }),
      propertyId: decode({ schema: PropertyId, value: change.propertyId }),
    })
  }
  if (
    (change.kind === 'row_archive' || change.kind === 'row_restore') &&
    change.pageId !== undefined
  ) {
    return pageSurfaceKey(decode({ schema: PageId, value: change.pageId }))
  }
  if (change.kind === 'body_patch' && change.pageId !== undefined) {
    return bodySurfaceKey(decode({ schema: PageId, value: change.pageId }))
  }
  if (change.kind === 'metadata_patch' && change.dataSourceId.length > 0) {
    if (change.metadataResourceType === 'database' && change.databaseId !== undefined) {
      return databaseMetadataSurfaceKey(decode({ schema: DatabaseId, value: change.databaseId }))
    }
    return dataSourceMetadataSurfaceKey(
      decode({ schema: DataSourceId, value: change.dataSourceId }),
    )
  }
  if (change.kind === 'schema_patch' && change.dataSourceId.length > 0) {
    return schemaSurfaceKey({
      dataSourceId: decode({ schema: DataSourceId, value: change.dataSourceId }),
      propertyId: decode({ schema: PropertyId, value: `replica:${change.changeId}` }),
    })
  }
  if (
    change.kind === 'file_attach' &&
    change.pageId !== undefined &&
    change.propertyId !== undefined
  ) {
    return propertySurfaceKey({
      pageId: decode({ schema: PageId, value: change.pageId }),
      propertyId: decode({ schema: PropertyId, value: change.propertyId }),
    })
  }
  if (change.kind === 'row_create' && change.dataSourceId.length > 0) {
    return schemaSurfaceKey({
      dataSourceId: decode({ schema: DataSourceId, value: change.dataSourceId }),
      propertyId: decode({ schema: PropertyId, value: `replica-create:${change.changeId}` }),
    })
  }
  return undefined
}

const decisionForReplicaChange = ({
  change,
  decisions,
}: {
  readonly change: ReplicaLocalChange
  readonly decisions: readonly PlanDecision[]
}): PlanDecision | undefined => {
  const commandId = `replica:${change.changeId}`
  const commandDecision = decisions.find(
    (decision) =>
      decision._tag === 'EnqueueCommands' &&
      decision.commands.some((command) => command.commandId === commandId),
  )
  if (commandDecision !== undefined) return commandDecision

  const surface = surfaceForReplicaChange(change)
  if (surface === undefined) return undefined
  return decisions.find(
    (decision) =>
      (decision._tag === 'BlockedByGuard' && decision.surface === surface) ||
      (decision._tag === 'OpenConflict' && decision.conflict.localSurface === surface),
  )
}

const settlementStatusForOutboxState = (
  state: ReturnType<NotionSyncStore['readOutbox']>[number]['state'],
): Exclude<ReplicaChangeStatus, 'pending'> => {
  switch (state) {
    case 'settled':
      return 'applied'
    case 'blocked':
    case 'fenced':
      return 'conflict'
    case 'queued':
    case 'running':
    case 'retryable':
    case 'ambiguous':
      return 'planned'
  }
}

const createdPageIdForCommand = ({
  store,
  rootId,
  commandId,
}: {
  readonly store: NotionSyncStore
  readonly rootId: SyncRootId
  readonly commandId: string
}): string | undefined => {
  const events = store
    .replay(rootId)
    .filter((event) => event._tag === 'RemoteWriteSettled' && event.commandId === commandId)
  const event = events.at(-1)
  return event?._tag === 'RemoteWriteSettled' ? event.createdPageId : undefined
}

/** Settle public replica CDC statuses from planner decisions and durable _nds_outbox state. */
export const settleReplicaChangesAfterSync = ({
  changes,
  replicaPath,
  store,
  rootId,
  decisions,
  dryRun,
}: SettleReplicaChangesOptions): void => {
  if (dryRun === true) return
  const outboxByCommandId = new Map(
    store.readOutbox(rootId).map((row) => [row.commandId, row] as const),
  )
  for (const change of changes) {
    if (change.kind === 'conflict_resolution') continue
    const decision = decisionForReplicaChange({ change, decisions })
    if (decision === undefined) {
      const _nds_outbox = outboxByCommandId.get(`replica:${change.changeId}`)
      if (_nds_outbox === undefined) continue
      if (change.kind === 'row_create' && _nds_outbox.state === 'ambiguous') {
        markChange({
          replicaPath,
          changeId: change.changeId,
          status: 'needs_reconciliation',
          reason:
            'Create command has an ambiguous remote outcome after an expired running attempt; manual reconciliation is required before retry.',
        })
        continue
      }
      if (change.kind === 'row_create' && _nds_outbox.state === 'settled') {
        const createdPageId = createdPageIdForCommand({
          store,
          rootId,
          commandId: _nds_outbox.commandId,
        })
        if (createdPageId === undefined) {
          markChange({
            replicaPath,
            changeId: change.changeId,
            status: 'needs_reconciliation',
            reason:
              'Create command settled without a durable created page id; manual reconciliation is required before retry.',
          })
          continue
        }
        const db = new DatabaseSync(replicaPath)
        try {
          createReplicaSchema(db)
          db.prepare(
            `UPDATE _nds_replica_row_creates
             SET remote_page_id = ?, status = 'applied', unsupported_reason = NULL, updated_at = ?
             WHERE change_id = ?`,
          ).run(createdPageId, new Date().toISOString(), change.changeId)
        } finally {
          db.close()
        }
        continue
      }
      markChange({
        replicaPath,
        changeId: change.changeId,
        status: settlementStatusForOutboxState(_nds_outbox.state),
        ...(_nds_outbox.state === 'blocked' || _nds_outbox.state === 'fenced'
          ? {
              reason:
                'Remote write was blocked during executor preflight; inspect sync status and _nds_outbox diagnostics.',
            }
          : {}),
      })
      continue
    }
    if (decision._tag === 'OpenConflict') {
      markChange({
        replicaPath,
        changeId: change.changeId,
        status: 'conflict',
        reason: decision.conflict.message,
      })
      continue
    }
    if (decision._tag === 'BlockedByGuard') {
      markChange({
        replicaPath,
        changeId: change.changeId,
        status:
          decision.guard === 'StaleSurfaceBase' || decision.guard === 'DeleteVsEdit'
            ? 'conflict'
            : 'unsupported',
        reason: decision.detail.summary,
      })
      continue
    }
    if (decision._tag !== 'EnqueueCommands') continue
    const command = decision.commands.find(
      (candidate) => candidate.commandId === `replica:${change.changeId}`,
    )
    if (command === undefined) continue
    const _nds_outbox = outboxByCommandId.get(command.commandId)
    if (_nds_outbox === undefined) continue
    if (change.kind === 'row_create' && _nds_outbox.state === 'ambiguous') {
      markChange({
        replicaPath,
        changeId: change.changeId,
        status: 'needs_reconciliation',
        reason:
          'Create command has an ambiguous remote outcome after an expired running attempt; manual reconciliation is required before retry.',
      })
      continue
    }
    if (change.kind === 'row_create' && _nds_outbox.state === 'settled') {
      const createdPageId = createdPageIdForCommand({
        store,
        rootId,
        commandId: command.commandId,
      })
      if (createdPageId === undefined) {
        markChange({
          replicaPath,
          changeId: change.changeId,
          status: 'needs_reconciliation',
          reason:
            'Create command settled without a durable created page id; manual reconciliation is required before retry.',
        })
        continue
      }
      const db = new DatabaseSync(replicaPath)
      try {
        createReplicaSchema(db)
        db.prepare(
          `UPDATE _nds_replica_row_creates
           SET remote_page_id = ?, status = 'applied', unsupported_reason = NULL, updated_at = ?
           WHERE change_id = ?`,
        ).run(createdPageId, new Date().toISOString(), change.changeId)
      } finally {
        db.close()
      }
      continue
    }
    markChange({
      replicaPath,
      changeId: change.changeId,
      status: settlementStatusForOutboxState(_nds_outbox.state),
      ...(_nds_outbox.state === 'blocked' || _nds_outbox.state === 'fenced'
        ? {
            reason:
              'Remote write was blocked during executor preflight; inspect sync status and _nds_outbox diagnostics.',
          }
        : {}),
    })
  }
}

/** Translate pending replica changes into planner intents the sync executor can consume. */
export const replicaChangesToPlannerIntents = ({
  changes,
  replicaPath,
  dryRun,
}: {
  readonly changes: readonly ReplicaLocalChange[]
  readonly replicaPath: string
  readonly dryRun?: boolean
}): readonly PlannerIntent[] => {
  const db = new DatabaseSync(replicaPath)
  try {
    createReplicaSchema(db)
    const intents: PlannerIntent[] = []
    for (const change of changes) {
      if (change.kind === 'row_create') {
        if (change.remotePageId !== undefined) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'planned',
            reason: 'Row create already has a remote_page_id and is waiting for observation.',
          })
          continue
        }
        if (
          change.valueJson === undefined ||
          change.baseHash === undefined ||
          change.clientRequestKey === undefined ||
          change.localRowId === undefined
        ) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'rejected',
            reason:
              'row_create requires initial_values_json, base_schema_hash, local_row_id, and client_request_key.',
          })
          continue
        }
        let dataSourceId: DataSourceId
        let baseSchemaHash: Hash
        let initialProperties: Record<PropertyId, CanonicalPropertyValue>
        try {
          dataSourceId = decode({ schema: DataSourceId, value: change.dataSourceId })
          baseSchemaHash = decode({ schema: Hash, value: change.baseHash })
          const parsed = JSON.parse(change.valueJson) as Record<string, unknown>
          initialProperties = Object.fromEntries(
            Object.entries(parsed).map(([propertyId, value]) => [
              decode({ schema: PropertyId, value: propertyId }),
              Schema.decodeUnknownSync(CanonicalPropertyValue)(value),
            ]),
          ) as Record<PropertyId, CanonicalPropertyValue>
        } catch {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'rejected',
            reason: 'row_create initial_values_json must map property ids to canonical values.',
          })
          continue
        }
        const dataSource = db
          .prepare(`SELECT schema_hash FROM _nds_replica_data_sources WHERE data_source_id = ?`)
          .get(change.dataSourceId) as SqlRow | undefined
        if (dataSource === undefined) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'rejected',
            reason: 'row_create targets a data source that is not present in the replica.',
          })
          continue
        }
        if (change.baseHash !== readString({ row: dataSource, key: 'schema_hash' })) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'conflict',
            reason: 'row_create has a stale base_schema_hash.',
          })
          continue
        }
        const properties = db
          .prepare(
            `SELECT property_id, property_type, write_class
             FROM _nds_replica_properties
             WHERE data_source_id = ?`,
          )
          .all(change.dataSourceId) as SqlRow[]
        const propertyById = new Map(
          properties.map((property) => [
            readString({ row: property, key: 'property_id' }),
            property,
          ]),
        )
        const hasTitle = properties.some(
          (property) =>
            readString({ row: property, key: 'property_type' }) === 'title' &&
            initialProperties[readString({ row: property, key: 'property_id' }) as PropertyId]
              ?._tag === 'title',
        )
        if (hasTitle === false) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'rejected',
            reason: 'row_create requires an initial title property value.',
          })
          continue
        }
        const unsupported = Object.entries(initialProperties).find(([propertyId, value]) => {
          const property = propertyById.get(propertyId)
          if (property === undefined) return true
          if (readString({ row: property, key: 'write_class' }) !== 'writable') return true
          const propertyType = readString({ row: property, key: 'property_type' })
          return (
            ['relation', 'people', 'files'].includes(propertyType) ||
            ['relation', 'people', 'files', 'computed', 'empty'].includes(value._tag)
          )
        })
        if (unsupported !== undefined) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'unsupported',
            reason:
              'row_create supports only writable scalar/select/status initial values; relation, people, files, empty, and computed values remain fail-closed.',
          })
          continue
        }
        const desiredHash = hashStoreBytes(change.valueJson)
        const commandId = decode({ schema: CommandId, value: `replica:${change.changeId}` })
        intents.push({
          _tag: 'row-create',
          intentEventId: decode({ schema: SyncEventId, value: `replica:${change.changeId}` }),
          commandKey: decode({
            schema: IdempotencyKey,
            value: `replica:create:${change.dataSourceId}:${change.clientRequestKey}`,
          }),
          surface: schemaSurfaceKey({
            dataSourceId,
            propertyId: decode({ schema: PropertyId, value: `replica-create:${change.changeId}` }),
          }),
          dataSourceId,
          command: CreatePageCommand.make({
            _tag: 'CreatePageCommand',
            commandId,
            dataSourceId,
            clientRequestKey: change.clientRequestKey,
            baseSchemaHash,
            initialProperties,
          }),
          baseHash: baseSchemaHash,
          desiredHash,
        })
        continue
      }
      if (change.kind === 'conflict_resolution') {
        markChange({
          replicaPath,
          dryRun,
          changeId: change.changeId,
          status: 'unsupported',
          reason:
            'Conflict resolution CDC requires store-backed execution; sync <workspace> handles it before planner-intent conversion.',
        })
        continue
      }
      if (change.kind === 'metadata_patch') {
        if (change.metadataResourceType === 'database') {
          if (change.baseHash === undefined) {
            markChange({
              replicaPath,
              dryRun,
              changeId: change.changeId,
              status: 'rejected',
              reason: 'database metadata_patch requires base_hash.',
            })
            continue
          }
          if (change.databaseId === undefined) {
            markChange({
              replicaPath,
              dryRun,
              changeId: change.changeId,
              status: 'rejected',
              reason: 'database metadata_patch requires database_id.',
            })
            continue
          }
          const database = db
            .prepare(
              `SELECT data_source_id, metadata_hash, metadata_json
               FROM _nds_replica_databases
               WHERE database_id = ?`,
            )
            .get(change.databaseId) as SqlRow | undefined
          if (database === undefined) {
            markChange({
              replicaPath,
              dryRun,
              changeId: change.changeId,
              status: 'rejected',
              reason:
                'database metadata_patch targets a database that is not present in the replica.',
            })
            continue
          }
          const metadataHash = readString({ row: database, key: 'metadata_hash' })
          const metadataJson = readString({ row: database, key: 'metadata_json' })
          const dataSourceIdString = readString({ row: database, key: 'data_source_id' })
          if (metadataHash !== change.baseHash) {
            markChange({
              replicaPath,
              dryRun,
              changeId: change.changeId,
              status: 'conflict',
              reason: 'database metadata_patch has a stale base_hash.',
            })
            continue
          }
          let databaseId: DatabaseId
          let dataSourceId: DataSourceId
          let baseMetadataHash: Hash
          let currentMetadata: CanonicalDataSourceMetadata
          try {
            databaseId = decode({ schema: DatabaseId, value: change.databaseId })
            dataSourceId = decode({ schema: DataSourceId, value: dataSourceIdString })
            baseMetadataHash = decode({ schema: Hash, value: change.baseHash })
            currentMetadata = Schema.decodeSync(Schema.fromJsonString(CanonicalDataSourceMetadata))(
              metadataJson,
            )
          } catch {
            markChange({
              replicaPath,
              dryRun,
              changeId: change.changeId,
              status: 'rejected',
              reason:
                'database metadata_patch contains invalid database_id, data_source_id, base_hash, or metadata_json.',
            })
            continue
          }
          const nextMetadata: CanonicalDataSourceMetadata = {
            ...currentMetadata,
            ...(change.titlePlainText === undefined
              ? {}
              : { titlePlainText: change.titlePlainText }),
            ...(change.descriptionPlainText === undefined
              ? {}
              : { descriptionPlainText: change.descriptionPlainText }),
          }
          const desiredHash = dataSourceMetadataHash(nextMetadata)
          const commandId = decode({ schema: CommandId, value: `replica:${change.changeId}` })
          intents.push({
            _tag: 'database-metadata-edit',
            intentEventId: decode({ schema: SyncEventId, value: `replica:${change.changeId}` }),
            commandKey: decode({ schema: IdempotencyKey, value: `replica:${change.changeId}` }),
            surface: databaseMetadataSurfaceKey(databaseId),
            databaseId,
            dataSourceId,
            command: PatchDatabaseMetadataCommand.make({
              _tag: 'PatchDatabaseMetadataCommand',
              commandId,
              databaseId,
              dataSourceId,
              baseMetadataHash,
              metadataPatch: {
                ...(change.titlePlainText === undefined
                  ? {}
                  : { titlePlainText: change.titlePlainText }),
                ...(change.descriptionPlainText === undefined
                  ? {}
                  : { descriptionPlainText: change.descriptionPlainText }),
              },
            }),
            baseHash: baseMetadataHash,
            desiredHash,
          })
          continue
        }
        if (change.metadataResourceType !== 'data_source') {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'unsupported',
            reason:
              'Database metadata CDC needs a separate database authority projection and remains fail-closed.',
          })
          continue
        }
        if (change.baseHash === undefined) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'rejected',
            reason: 'metadata_patch requires base_hash.',
          })
          continue
        }
        const dataSource = db
          .prepare(
            `SELECT metadata_hash, metadata_json
             FROM _nds_replica_data_sources
             WHERE data_source_id = ?`,
          )
          .get(change.dataSourceId) as SqlRow | undefined
        if (dataSource === undefined) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'rejected',
            reason: 'metadata_patch targets a data source that is not present in the replica.',
          })
          continue
        }
        const metadataHash = readOptionalString({ row: dataSource, key: 'metadata_hash' })
        const metadataJson = readOptionalString({ row: dataSource, key: 'metadata_json' })
        if (metadataHash === undefined || metadataJson === undefined) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'unsupported',
            reason:
              'metadata_patch requires canonical metadata projection before post-write hash reconciliation can be computed.',
          })
          continue
        }
        if (metadataHash !== change.baseHash) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'conflict',
            reason: 'metadata_patch has a stale base_hash.',
          })
          continue
        }
        let dataSourceId: DataSourceId
        let baseMetadataHash: Hash
        let currentMetadata: CanonicalDataSourceMetadata
        try {
          dataSourceId = decode({ schema: DataSourceId, value: change.dataSourceId })
          baseMetadataHash = decode({ schema: Hash, value: change.baseHash })
          currentMetadata = Schema.decodeSync(Schema.fromJsonString(CanonicalDataSourceMetadata))(
            metadataJson,
          )
        } catch {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'rejected',
            reason: 'metadata_patch contains invalid data_source_id, base_hash, or metadata_json.',
          })
          continue
        }
        const nextMetadata: CanonicalDataSourceMetadata = {
          ...currentMetadata,
          ...(change.titlePlainText === undefined ? {} : { titlePlainText: change.titlePlainText }),
          ...(change.descriptionPlainText === undefined
            ? {}
            : { descriptionPlainText: change.descriptionPlainText }),
        }
        const desiredHash = dataSourceMetadataHash(nextMetadata)
        const commandId = decode({ schema: CommandId, value: `replica:${change.changeId}` })
        intents.push({
          _tag: 'data-source-metadata-edit',
          intentEventId: decode({ schema: SyncEventId, value: `replica:${change.changeId}` }),
          commandKey: decode({ schema: IdempotencyKey, value: `replica:${change.changeId}` }),
          surface: dataSourceMetadataSurfaceKey(dataSourceId),
          dataSourceId,
          command: PatchDataSourceMetadataCommand.make({
            _tag: 'PatchDataSourceMetadataCommand',
            commandId,
            dataSourceId,
            baseMetadataHash,
            metadataPatch: {
              ...(change.titlePlainText === undefined
                ? {}
                : { titlePlainText: change.titlePlainText }),
              ...(change.descriptionPlainText === undefined
                ? {}
                : { descriptionPlainText: change.descriptionPlainText }),
            },
          }),
          baseHash: baseMetadataHash,
          desiredHash,
        })
        continue
      }
      if (change.kind === 'schema_patch') {
        markChange({
          replicaPath,
          dryRun,
          changeId: change.changeId,
          status: 'unsupported',
          reason:
            'Public schema CDC needs expected post-schema hash reconciliation before remote execution; use the dedicated schema command path until that projection exists.',
        })
        continue
      }
      if (change.kind === 'body_patch') {
        if (
          change.pageId === undefined ||
          change.baseHash === undefined ||
          change.localBodyHash === undefined
        ) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'rejected',
            reason: 'body_patch requires page_id, base_hash, and local_body_hash.',
          })
          continue
        }
        if (
          change.localBodyContent !== undefined &&
          hashStoreBytes(change.localBodyContent) !== change.localBodyHash
        ) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'rejected',
            reason: 'body_patch local_body_content does not match local_body_hash.',
          })
          continue
        }
        let pageId: PageId
        let baseHash: Hash
        let localBodyHash: Hash
        try {
          pageId = decode({ schema: PageId, value: change.pageId })
          baseHash = decode({ schema: Hash, value: change.baseHash })
          localBodyHash = decode({ schema: Hash, value: change.localBodyHash })
        } catch {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'rejected',
            reason: 'Invalid page_id, base_hash, or local_body_hash in body_patch.',
          })
          continue
        }
        const body = db
          .prepare(
            `SELECT path, current_hash, body_projection_json, sidecar_identity_proven
             FROM _nds_replica_bodies
             WHERE page_id = ?`,
          )
          .get(change.pageId) as SqlRow | undefined
        if (body === undefined) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'rejected',
            reason: 'body_patch targets a page body that is not present in the replica.',
          })
          continue
        }
        if (readNumber({ row: body, key: 'sidecar_identity_proven' }) !== 1) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'unsupported',
            reason: 'Body writes require a proven local sidecar identity.',
          })
          continue
        }
        if (change.baseHash !== readString({ row: body, key: 'current_hash' })) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'conflict',
            reason: 'body_patch has a stale base_hash.',
          })
          continue
        }
        let bodyProjectionPayload: BodyProjectionPayload
        try {
          bodyProjectionPayload = decodeBodyProjectionPayloadJson(
            readString({ row: body, key: 'body_projection_json' }),
          )
        } catch {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'unsupported',
            reason: 'Body safety metadata is not valid JSON.',
          })
          continue
        }
        const bodyPointer = bodyProjectionPayload.pointer
        intents.push({
          _tag: 'body-edit',
          intentEventId: decode({ schema: SyncEventId, value: `replica:${change.changeId}` }),
          commandKey: decode({ schema: IdempotencyKey, value: `replica:${change.changeId}` }),
          surface: bodySurfaceKey(pageId),
          pageId,
          command: BodyPushCommand.make({
            _tag: 'BodyPushCommand',
            commandId: decode({ schema: CommandId, value: `replica:${change.changeId}` }),
            pageId,
            baseBodyPointer: bodyPointer,
            nextBodyHash: localBodyHash,
            ...(change.bodyPath === undefined
              ? {}
              : {
                  localBodyPath: decode({ schema: WorkspaceRelativePath, value: change.bodyPath }),
                }),
            ...(change.localBodyContent === undefined
              ? {}
              : { localBodyContent: change.localBodyContent }),
          }),
          baseHash,
          desiredHash: localBodyHash,
        })
        continue
      }
      if (change.kind === 'file_attach') {
        if (
          change.pageId === undefined ||
          change.propertyId === undefined ||
          change.baseHash === undefined ||
          change.fileAssetId === undefined ||
          change.fileAction === undefined
        ) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'rejected',
            reason: 'file_attach requires page_id, property_id, asset_id, action, and base_hash.',
          })
          continue
        }
        if (change.fileAction !== 'attach_external_url') {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'unsupported',
            reason:
              'Only external URL file attachments are supported; local uploads need upload-id/status/retry modeling.',
          })
          continue
        }
        if (change.fileName === undefined || change.fileExternalUrl === undefined) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'rejected',
            reason: 'attach_external_url requires a file asset name and external_url.',
          })
          continue
        }
        let pageId: PageId
        let propertyId: PropertyId
        let baseHash: Hash
        try {
          pageId = decode({ schema: PageId, value: change.pageId })
          propertyId = decode({ schema: PropertyId, value: change.propertyId })
          decode({ schema: DataSourceId, value: change.dataSourceId })
          baseHash = decode({ schema: Hash, value: change.baseHash })
        } catch {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'rejected',
            reason: 'Invalid data_source_id, page_id, property_id, or base_hash in file_attach.',
          })
          continue
        }
        const cell = db
          .prepare(
            `SELECT c.value_json, c.base_hash, c.remote_hash, r.properties_hash,
                    p.config_hash, p.write_class, p.property_type
             FROM _nds_replica_cells c
             JOIN _nds_replica_rows r ON r.page_id = c.page_id
             JOIN _nds_replica_properties p
               ON p.data_source_id = c.data_source_id AND p.property_id = c.property_id
             WHERE c.page_id = ? AND c.property_id = ?`,
          )
          .get(change.pageId, change.propertyId) as SqlRow | undefined
        if (cell === undefined) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'rejected',
            reason: 'file_attach targets a cell that is not present in the replica.',
          })
          continue
        }
        if (
          readString({ row: cell, key: 'property_type' }) !== 'files' ||
          readString({ row: cell, key: 'write_class' }) !== 'writable'
        ) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'unsupported',
            reason: 'file_attach targets must be writable files properties.',
          })
          continue
        }
        if (change.baseHash !== readString({ row: cell, key: 'base_hash' })) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'conflict',
            reason: 'file_attach has a stale base_hash.',
          })
          continue
        }
        const currentValueJson = readOptionalString({ row: cell, key: 'value_json' })
        let currentValue: CanonicalPropertyValue
        if (
          currentValueJson === undefined ||
          currentValueJson === 'null' ||
          currentValueJson === '[]'
        ) {
          currentValue = { _tag: 'files', files: [] }
        } else {
          try {
            currentValue = decode({
              schema: Schema.fromJsonString(CanonicalPropertyValue),
              value: currentValueJson,
            })
          } catch {
            markChange({
              replicaPath,
              dryRun,
              changeId: change.changeId,
              status: 'unsupported',
              reason:
                'External file attach requires an empty canonical files cell; raw file payload preservation is not modeled.',
            })
            continue
          }
        }
        if (currentValue._tag !== 'files' || currentValue.files.length > 0) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'unsupported',
            reason:
              'External file attach is supported only for empty files properties until durable preservation of existing file identities is modeled.',
          })
          continue
        }
        if (change.fileExternalUrl.startsWith('https://') === false) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'rejected',
            reason: 'External file attachments require an https:// external_url.',
          })
          continue
        }
        const value: CanonicalPropertyValue = {
          _tag: 'files',
          files: [
            {
              _tag: 'CanonicalFileValue',
              name: change.fileName,
              identityHash: decode({
                schema: Hash,
                value: hashStoreBytes(
                  `external-file\t${change.fileName}\t${change.fileExternalUrl}`,
                ),
              }),
              externalUrl: change.fileExternalUrl,
            },
          ],
        }
        const valueJson = JSON.stringify(value)
        const commandId = decode({ schema: CommandId, value: `replica:${change.changeId}` })
        intents.push({
          _tag: 'property-edit',
          intentEventId: decode({ schema: SyncEventId, value: `replica:${change.changeId}` }),
          commandKey: decode({ schema: IdempotencyKey, value: `replica:${change.changeId}` }),
          surface: propertySurfaceKey({ pageId, propertyId }),
          pageId,
          propertyId,
          command: PatchPagePropertiesCommand.make({
            _tag: 'PatchPagePropertiesCommand',
            commandId,
            pageId,
            basePropertiesHash: decode({
              schema: Hash,
              value: readString({ row: cell, key: 'properties_hash' }),
            }),
            propertyPatch: { [propertyId]: value },
          }),
          baseHash,
          desiredHash: hashStoreBytes(valueJson),
          expectedPropertyConfigHash: decode({
            schema: Hash,
            value: readString({ row: cell, key: 'config_hash' }),
          }),
        })
        continue
      }
      if (change.kind === 'view_change') {
        markChange({
          replicaPath,
          dryRun,
          changeId: change.changeId,
          status: 'unsupported',
          reason:
            'Notion view write CDC needs stable post-write view hashes, cache/incomplete-query modeling, and scratch cleanup proof before execution.',
        })
        continue
      }
      if (change.pageId === undefined) {
        markChange({
          replicaPath,
          dryRun,
          changeId: change.changeId,
          status: 'rejected',
          reason: `${change.kind} requires page_id.`,
        })
        continue
      }
      let pageId: PageId
      try {
        pageId = decode({ schema: PageId, value: change.pageId })
        /* Validation only: a malformed `data_source_id` rejects the change below;
         * the decoded id itself is not needed on this path. */
        decode({ schema: DataSourceId, value: change.dataSourceId })
      } catch {
        markChange({
          replicaPath,
          dryRun,
          changeId: change.changeId,
          status: 'rejected',
          reason: 'Invalid data_source_id or page_id in local change.',
        })
        continue
      }
      const row = db
        .prepare(`SELECT properties_hash, in_trash FROM _nds_replica_rows WHERE page_id = ?`)
        .get(change.pageId) as SqlRow | undefined
      if (row === undefined) {
        markChange({
          replicaPath,
          dryRun,
          changeId: change.changeId,
          status: 'rejected',
          reason: 'Local change targets a row that is not present in the replica.',
        })
        continue
      }
      if (change.kind === 'row_restore') {
        if (
          change.baseHash !== undefined &&
          change.baseHash !== readString({ row, key: 'properties_hash' })
        ) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'conflict',
            reason: 'Local row lifecycle change has a stale base_hash.',
          })
          continue
        }
        const baseHash = decode({
          schema: Hash,
          value:
            change.baseHash ??
            pageLifecycleHash({ pageId, inTrash: readNumber({ row, key: 'in_trash' }) === 1 }),
        })
        const commandId = decode({ schema: CommandId, value: `replica:${change.changeId}` })
        intents.push({
          _tag: 'local-delete',
          intentEventId: decode({ schema: SyncEventId, value: `replica:${change.changeId}` }),
          commandKey: decode({ schema: IdempotencyKey, value: `replica:${change.changeId}` }),
          surface: pageSurfaceKey(pageId),
          pageId,
          command: RestorePageCommand.make({
            _tag: 'RestorePageCommand',
            commandId,
            pageId,
            basePropertiesHash: baseHash,
          }),
          baseHash,
          desiredHash: pageLifecycleHash({ pageId, inTrash: false }),
          explicitDestructiveIntent: true,
          policy: 'trustedRemoteTrash',
          directRetrieve: 'accessible',
        })
        continue
      }
      if (change.kind === 'row_archive') {
        if (
          change.baseHash !== undefined &&
          change.baseHash !== readString({ row, key: 'properties_hash' })
        ) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'conflict',
            reason: 'Local row lifecycle change has a stale base_hash.',
          })
          continue
        }
        const baseHash = decode({
          schema: Hash,
          value:
            change.baseHash ??
            pageLifecycleHash({ pageId, inTrash: readNumber({ row, key: 'in_trash' }) === 1 }),
        })
        const commandId = decode({ schema: CommandId, value: `replica:${change.changeId}` })
        const command = TrashPageCommand.make({
          _tag: 'TrashPageCommand',
          commandId,
          pageId,
          basePropertiesHash: baseHash,
        })
        intents.push({
          _tag: 'local-delete',
          intentEventId: decode({ schema: SyncEventId, value: `replica:${change.changeId}` }),
          commandKey: decode({ schema: IdempotencyKey, value: `replica:${change.changeId}` }),
          surface: pageSurfaceKey(pageId),
          pageId,
          command,
          baseHash,
          desiredHash: pageLifecycleHash({ pageId, inTrash: true }),
          explicitDestructiveIntent: true,
          policy: 'trustedRemoteTrash',
          directRetrieve: 'accessible',
        })
        continue
      }
      if (change.kind === 'cell_patch') {
        if (change.propertyId === undefined || change.valueJson === undefined) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'rejected',
            reason: 'cell_patch requires property_id and value_json.',
          })
          continue
        }
        let propertyId: PropertyId
        try {
          propertyId = decode({ schema: PropertyId, value: change.propertyId })
        } catch {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'rejected',
            reason: 'Invalid property_id in local change.',
          })
          continue
        }
        const cell = db
          .prepare(
            `SELECT c.base_hash, c.value_json, c.availability, r.properties_hash,
                    p.config_hash, p.write_class, p.property_type
             FROM _nds_replica_cells c
             JOIN _nds_replica_rows r ON r.page_id = c.page_id
             JOIN _nds_replica_properties p
               ON p.data_source_id = c.data_source_id AND p.property_id = c.property_id
             WHERE c.page_id = ? AND c.property_id = ?`,
          )
          .get(change.pageId, change.propertyId) as SqlRow | undefined
        if (cell === undefined) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'rejected',
            reason: 'Local change targets a cell that is not present in the replica.',
          })
          continue
        }
        if (readString({ row: cell, key: 'write_class' }) !== 'writable') {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'unsupported',
            reason: 'The target property is read-only or unsupported for replica writes.',
          })
          continue
        }
        const propertyType = readString({ row: cell, key: 'property_type' })
        if (['people', 'files'].includes(propertyType) === true) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'unsupported',
            reason:
              'People and file writes require full paginated base/staging proof before replica sync can apply them safely.',
          })
          continue
        }
        if (
          change.baseHash !== undefined &&
          change.baseHash !== readString({ row: cell, key: 'base_hash' })
        ) {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'conflict',
            reason: 'Local cell patch has a stale base_hash.',
          })
          continue
        }
        let value: CanonicalPropertyValue
        try {
          value = Schema.decodeSync(Schema.fromJsonString(CanonicalPropertyValue))(change.valueJson)
        } catch {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'rejected',
            reason: 'value_json is not valid canonical Notion property value JSON.',
          })
          continue
        }
        if (propertyType === 'relation') {
          if (readString({ row: cell, key: 'availability' }) !== 'complete') {
            markChange({
              replicaPath,
              dryRun,
              changeId: change.changeId,
              status: 'unsupported',
              reason:
                'Relation writes require a complete paginated base value before replacement-shaped writes are safe.',
            })
            continue
          }
          if (value._tag !== 'relation') {
            markChange({
              replicaPath,
              dryRun,
              changeId: change.changeId,
              status: 'rejected',
              reason: 'Relation property patches require canonical relation value_json.',
            })
            continue
          }
          const relationPropertyId = change.propertyId
          if (value.pageIds.length > 100) {
            markChange({
              replicaPath,
              dryRun,
              changeId: change.changeId,
              status: 'unsupported',
              reason: 'Relation writes are capped at 100 related pages by the Notion API.',
            })
            continue
          }
          let baseValue: CanonicalPropertyValue
          try {
            baseValue = Schema.decodeSync(Schema.fromJsonString(CanonicalPropertyValue))(
              readString({ row: cell, key: 'value_json' }),
            )
          } catch {
            markChange({
              replicaPath,
              dryRun,
              changeId: change.changeId,
              status: 'unsupported',
              reason:
                'Relation writes require a canonical observed relation base value from page-property pagination.',
            })
            continue
          }
          if (baseValue._tag !== 'relation') {
            markChange({
              replicaPath,
              dryRun,
              changeId: change.changeId,
              status: 'unsupported',
              reason:
                'Relation writes require a canonical observed relation base value from page-property pagination.',
            })
            continue
          }
          const addedPageIds = value.pageIds.filter(
            (pageIdValue) => baseValue.pageIds.includes(pageIdValue) === false,
          )
          const inaccessibleTarget = addedPageIds.find((pageIdValue) => {
            const target = db
              .prepare(
                `SELECT 1
                 FROM _nds_replica_relation_targets
                 WHERE data_source_id = ? AND property_id = ? AND target_page_id = ?
                 LIMIT 1`,
              )
              .get(change.dataSourceId, relationPropertyId, pageIdValue)
            return target === undefined
          })
          if (inaccessibleTarget !== undefined) {
            markChange({
              replicaPath,
              dryRun,
              changeId: change.changeId,
              status: 'unsupported',
              reason:
                'Relation additions require each new target to have been observed through the same relation property.',
            })
            continue
          }
        } else if (value._tag === 'relation') {
          markChange({
            replicaPath,
            dryRun,
            changeId: change.changeId,
            status: 'rejected',
            reason: 'Relation value_json can only patch relation properties.',
          })
          continue
        }
        const baseHash = decode({
          schema: Hash,
          value: change.baseHash ?? readString({ row: cell, key: 'base_hash' }),
        })
        const desiredHash =
          value._tag === 'relation'
            ? hashStoreBytes(
                JSON.stringify({
                  _tag: 'relation',
                  pageIds: value.pageIds.toSorted(),
                }),
              )
            : hashStoreBytes(change.valueJson)
        const commandId = decode({ schema: CommandId, value: `replica:${change.changeId}` })
        intents.push({
          _tag: 'property-edit',
          intentEventId: decode({ schema: SyncEventId, value: `replica:${change.changeId}` }),
          commandKey: decode({ schema: IdempotencyKey, value: `replica:${change.changeId}` }),
          surface: propertySurfaceKey({ pageId, propertyId }),
          pageId,
          propertyId,
          command: PatchPagePropertiesCommand.make({
            _tag: 'PatchPagePropertiesCommand',
            commandId,
            pageId,
            basePropertiesHash: decode({
              schema: Hash,
              value: readString({ row, key: 'properties_hash' }),
            }),
            propertyPatch: { [propertyId]: value },
          }),
          baseHash,
          desiredHash,
          expectedPropertyConfigHash: decode({
            schema: Hash,
            value: readString({ row: cell, key: 'config_hash' }),
          }),
        })
      }
    }
    return intents
  } finally {
    db.close()
  }
}
