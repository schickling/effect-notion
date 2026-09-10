import { Effect, Schema } from 'effect'

import {
  SessionArtifactDecodeError,
  SessionArtifactReadError,
  SessionCheckpointDecodeError,
  SessionSourceDiscoveryError,
} from '../errors.ts'
import { readFileContentVersion } from '../files/content-version.ts'
import type { SessionSourceAdapter } from '../schema/core.ts'
import {
  ArtifactDescriptor,
  IngestionCheckpoint,
  NonNegativeInt,
  SourceId,
} from '../schema/core.ts'

const OpenCodeSessionRow = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  directory: Schema.String,
  title: Schema.String,
  version: Schema.String,
  time_created: NonNegativeInt,
  time_updated: NonNegativeInt,
  time_archived: Schema.optional(Schema.NullOr(NonNegativeInt)),
}).annotate({ identifier: 'AgentSessionIngest.OpenCodeSessionRow' })

const OpenCodeSessionDiscoveryRow = Schema.Struct({
  id: Schema.String,
  time_archived: Schema.NullOr(NonNegativeInt),
}).annotate({ identifier: 'AgentSessionIngest.OpenCodeSessionDiscoveryRow' })

const OpenCodeMessageRow = Schema.Struct({
  id: Schema.String,
  session_id: Schema.String,
  time_created: NonNegativeInt,
  time_updated: NonNegativeInt,
  data: Schema.Unknown,
}).annotate({ identifier: 'AgentSessionIngest.OpenCodeMessageRow' })

const OpenCodePartRow = Schema.Struct({
  id: Schema.String,
  session_id: Schema.String,
  time_created: NonNegativeInt,
  time_updated: NonNegativeInt,
  data: Schema.Unknown,
}).annotate({ identifier: 'AgentSessionIngest.OpenCodePartRow' })

const OpenCodeMessageData = Schema.Struct({
  role: Schema.String,
  time: Schema.optional(Schema.Unknown),
  parentID: Schema.optional(Schema.String),
  modelID: Schema.optional(Schema.String),
  providerID: Schema.optional(Schema.String),
  mode: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  path: Schema.optional(
    Schema.Struct({
      cwd: Schema.String,
      root: Schema.optional(Schema.String),
    }),
  ),
  summary: Schema.optional(Schema.Unknown),
}).annotate({ identifier: 'AgentSessionIngest.OpenCodeMessageData' })

const OpenCodeMessageRecord = Schema.TaggedStruct('OpenCodeMessage', {
  id: Schema.String,
  sessionId: Schema.String,
  timeCreated: NonNegativeInt,
  timeUpdated: NonNegativeInt,
  data: OpenCodeMessageData,
}).annotate({ identifier: 'AgentSessionIngest.OpenCodeMessageRecord' })

const OpenCodePartToolData = Schema.Struct({
  type: Schema.Literal('tool'),
  callID: Schema.String,
  tool: Schema.String,
  state: Schema.Struct({
    status: Schema.String,
    input: Schema.Unknown,
    output: Schema.optional(Schema.Unknown),
    title: Schema.optional(Schema.String),
    metadata: Schema.optional(Schema.Unknown),
    time: Schema.optional(Schema.Unknown),
  }),
}).annotate({ identifier: 'AgentSessionIngest.OpenCodePartToolData' })

const OpenCodePartTextData = Schema.Struct({
  type: Schema.Literal('text'),
  text: Schema.String,
}).annotate({ identifier: 'AgentSessionIngest.OpenCodePartTextData' })

const OpenCodePartReasoningData = Schema.Struct({
  type: Schema.Literal('reasoning'),
  text: Schema.String,
  metadata: Schema.optional(Schema.Unknown),
}).annotate({ identifier: 'AgentSessionIngest.OpenCodePartReasoningData' })

const OpenCodePartStepStartData = Schema.Struct({
  type: Schema.Literal('step-start'),
  text: Schema.optional(Schema.String),
}).annotate({ identifier: 'AgentSessionIngest.OpenCodePartStepStartData' })

const OpenCodePartStepFinishData = Schema.Struct({
  type: Schema.Literal('step-finish'),
  reason: Schema.optional(Schema.String),
  snapshot: Schema.optional(Schema.String),
  cost: Schema.optional(Schema.Finite),
  tokens: Schema.optional(Schema.Unknown),
}).annotate({ identifier: 'AgentSessionIngest.OpenCodePartStepFinishData' })

const OpenCodePartPatchData = Schema.Struct({
  type: Schema.Literal('patch'),
  patch: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Unknown),
}).annotate({ identifier: 'AgentSessionIngest.OpenCodePartPatchData' })

const OpenCodePartFileData = Schema.Struct({
  type: Schema.Literal('file'),
  path: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Unknown),
}).annotate({ identifier: 'AgentSessionIngest.OpenCodePartFileData' })

const OpenCodePartSubtaskData = Schema.Struct({
  type: Schema.Literal('subtask'),
  metadata: Schema.optional(Schema.Unknown),
}).annotate({ identifier: 'AgentSessionIngest.OpenCodePartSubtaskData' })

const OpenCodePartCompactionData = Schema.Struct({
  type: Schema.Literal('compaction'),
  metadata: Schema.optional(Schema.Unknown),
}).annotate({ identifier: 'AgentSessionIngest.OpenCodePartCompactionData' })

const OpenCodePartGenericData = Schema.Struct({
  type: Schema.String,
}).annotate({ identifier: 'AgentSessionIngest.OpenCodePartGenericData' })

const OpenCodePartData = Schema.Union([
  OpenCodePartToolData,
  OpenCodePartTextData,
  OpenCodePartReasoningData,
  OpenCodePartStepStartData,
  OpenCodePartStepFinishData,
  OpenCodePartPatchData,
  OpenCodePartFileData,
  OpenCodePartSubtaskData,
  OpenCodePartCompactionData,
  OpenCodePartGenericData,
]).annotate({ identifier: 'AgentSessionIngest.OpenCodePartData' })

const OpenCodePartRecord = Schema.TaggedStruct('OpenCodePart', {
  id: Schema.String,
  sessionId: Schema.String,
  timeCreated: NonNegativeInt,
  timeUpdated: NonNegativeInt,
  data: OpenCodePartData,
}).annotate({ identifier: 'AgentSessionIngest.OpenCodePartRecord' })

const OpenCodeSessionRecord = Schema.TaggedStruct('OpenCodeSession', {
  session: OpenCodeSessionRow,
}).annotate({ identifier: 'AgentSessionIngest.OpenCodeSessionRecord' })

/**
 * Source-of-truth record union for OpenCode native SQLite session storage.
 *
 * References:
 * - Database: `~/.local/share/opencode/opencode.db`
 * - Tables: `session`, `message`, `part`
 */
export const OpenCodeRecord = Schema.Union([
  OpenCodeSessionRecord,
  OpenCodeMessageRecord,
  OpenCodePartRecord,
]).annotate({ identifier: 'AgentSessionIngest.OpenCodeRecord' })
export type OpenCodeRecord = typeof OpenCodeRecord.Type

type SqliteValue = string | number | bigint | Uint8Array | null

interface SqliteQueryArgs {
  readonly sql: string
  readonly params?: ReadonlyArray<SqliteValue>
}

interface ReadonlySqliteDatabase {
  readonly get: (args: SqliteQueryArgs) => unknown
  readonly all: (args: SqliteQueryArgs) => ReadonlyArray<unknown>
  readonly close: () => void
}

interface BunSqliteQuery {
  readonly get: (...params: ReadonlyArray<SqliteValue>) => unknown
  readonly all: (...params: ReadonlyArray<SqliteValue>) => ReadonlyArray<unknown>
}

interface BunSqliteDatabase {
  readonly query: (sql: string) => BunSqliteQuery
  readonly close: () => void
}

interface BunSqliteModule {
  readonly Database: new (
    path: string,
    options: {
      readonly: boolean
    },
  ) => BunSqliteDatabase
}

const hasBunRuntime = () => 'Bun' in globalThis

// oxlint-disable-next-line import/no-dynamic-require -- dynamic import needed to avoid bundler resolution of bun:sqlite
const loadBunSqliteModule = () => import('bun:sqlite' as string) as Promise<BunSqliteModule>

const openReadonlySqliteDatabase = Effect.fn(
  'AgentSessionIngest.OpenCode.openReadonlySqliteDatabase',
)(
  (path: string): Effect.Effect<ReadonlySqliteDatabase, SessionArtifactReadError> =>
    Effect.tryPromise({
      try: async () => {
        if (hasBunRuntime() === true) {
          const { Database } = await loadBunSqliteModule()
          const database = new Database(path, { readonly: true })
          const runQuery = <TValue>(options: {
            readonly sql: string
            readonly params: ReadonlyArray<SqliteValue> | undefined
            readonly run: (query: BunSqliteQuery) => TValue
            readonly runWithOne: (query: BunSqliteQuery, first: SqliteValue) => TValue
            readonly runWithTwo: (
              query: BunSqliteQuery,
              first: SqliteValue,
              second: SqliteValue,
            ) => TValue
          }) => {
            const query = database.query(options.sql)
            if (options.params === undefined || options.params.length === 0)
              return options.run(query)
            if (options.params.length === 1) return options.runWithOne(query, options.params[0]!)
            if (options.params.length === 2)
              return options.runWithTwo(query, options.params[0]!, options.params[1]!)

            throw new Error('OpenCode adapter only supports up to two SQLite bind parameters')
          }

          return {
            get: ({ sql, params }) =>
              runQuery({
                sql,
                params,
                run: (query) => query.get(),
                runWithOne: (query, first) => query.get(first),
                runWithTwo: (query, first, second) => query.get(first, second),
              }),
            all: ({ sql, params }) =>
              runQuery({
                sql,
                params,
                run: (query) => query.all(),
                runWithOne: (query, first) => query.all(first),
                runWithTwo: (query, first, second) => query.all(first, second),
              }),
            close: () => database.close(),
          } satisfies ReadonlySqliteDatabase
        }

        const { DatabaseSync } = await import('node:sqlite')
        const database = new DatabaseSync(path, { readOnly: true })
        return {
          get: ({ sql, params }) => database.prepare(sql).get(...(params ?? [])),
          all: ({ sql, params }) => database.prepare(sql).all(...(params ?? [])),
          close: () => database.close(),
        } satisfies ReadonlySqliteDatabase
      },
      catch: (cause) =>
        new SessionArtifactReadError({
          message: 'Failed to open OpenCode session database',
          path,
          cause,
        }),
    }),
)

const withReadonlyDb = <TValue>(options: {
  readonly path: string
  readonly f: (database: ReadonlySqliteDatabase) => TValue
}): Effect.Effect<TValue, SessionArtifactReadError> =>
  Effect.acquireUseRelease(
    openReadonlySqliteDatabase(options.path),
    (database) =>
      Effect.try({
        try: () => options.f(database),
        catch: (cause) =>
          new SessionArtifactReadError({
            message: 'Failed to query OpenCode session database',
            path: options.path,
            cause,
          }),
      }),
    (database) =>
      Effect.sync(() => {
        database.close()
      }),
  )

const buildOpenCodeRecordKey = (options: {
  readonly kind: 'message' | 'part' | 'session'
  readonly id: string
}) => `${options.kind}:${options.id}`

const rankOpenCodeRecord = (record: OpenCodeRecord) =>
  record._tag === 'OpenCodeSession' ? 0 : record._tag === 'OpenCodeMessage' ? 1 : 2

const buildOpenCodeOrderKey = (options: { readonly rank: number; readonly recordKey: string }) =>
  `${String(options.rank).padStart(2, '0')}:${options.recordKey}`

const normalizeOpenCodeOrderKey = (lastRecordKey: string | undefined) => {
  if (lastRecordKey === undefined) return undefined
  if (/^\d{2}:/.test(lastRecordKey) === true) return lastRecordKey

  if (lastRecordKey.startsWith('session:') === true) {
    return buildOpenCodeOrderKey({ rank: 0, recordKey: lastRecordKey })
  }

  if (lastRecordKey.startsWith('message:') === true) {
    return buildOpenCodeOrderKey({ rank: 1, recordKey: lastRecordKey })
  }

  if (lastRecordKey.startsWith('part:') === true) {
    return buildOpenCodeOrderKey({ rank: 2, recordKey: lastRecordKey })
  }

  return lastRecordKey
}

const parseOpenCodeRowData = Effect.fn('AgentSessionIngest.OpenCode.parseOpenCodeRowData')(
  (options: {
    readonly sourceId: string
    readonly artifactId: string
    readonly rawRow: unknown
    readonly rawData: unknown
    readonly message: string
  }) =>
    Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(String(options.rawData)).pipe(
      Effect.mapError(
        (cause) =>
          new SessionArtifactDecodeError({
            message: options.message,
            sourceId: options.sourceId,
            artifactId: options.artifactId,
            rawRecord: JSON.stringify(options.rawRow),
            cause,
          }),
      ),
    ),
)

/** Deduplicate streaming OpenCode part records, keeping only the last occurrence per part ID. */
export const collapseStreamingOpenCodeRecords = (
  records: ReadonlyArray<OpenCodeRecord>,
): ReadonlyArray<OpenCodeRecord> => {
  const lastPartIndex = new Map<string, number>()
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!
    if (record._tag === 'OpenCodePart') {
      lastPartIndex.set(record.id, i)
    }
  }

  return records.filter((record, index) => {
    if (record._tag !== 'OpenCodePart') return true
    return lastPartIndex.get(record.id) === index
  })
}

/**
 * Adapter for incremental ingestion of OpenCode session records from the local SQLite store.
 *
 * References:
 * - Native database: `~/.local/share/opencode/opencode.db`
 * - Source tables: `session`, `message`, `part`
 */
export const makeOpenCodeAdapter = (options: {
  readonly databasePath: string
  readonly sourceId?: string
}): SessionSourceAdapter<OpenCodeRecord> => ({
  sourceId: Schema.decodeSync(SourceId)(options.sourceId ?? 'opencode'),
  discoverArtifacts: withReadonlyDb({
    path: options.databasePath,
    f: (database) =>
      database
        .all({
          sql: `
          select id, time_archived
          from session
          order by time_updated desc
        `,
        })
        .map((rawRow) => {
          const row = Schema.decodeUnknownSync(OpenCodeSessionDiscoveryRow)(rawRow)
          return Schema.decodeSync(ArtifactDescriptor)({
            sourceId: options.sourceId ?? 'opencode',
            artifactId: row.id,
            path: options.databasePath,
            status: row.time_archived === null ? 'stable' : 'finalized',
          })
        }),
  }).pipe(
    Effect.mapError(
      (cause) =>
        new SessionSourceDiscoveryError({
          message: 'Failed to discover OpenCode sessions',
          sourceId: options.sourceId ?? 'opencode',
          cause,
        }),
    ),
  ),
  ingestArtifact: ({ artifact, checkpoint }) =>
    Effect.gen(function* () {
      const contentVersion = yield* readFileContentVersion(artifact.path)
      const previousCursor =
        checkpoint?.cursor._tag === 'UpdatedAtCursor' ? checkpoint.cursor : undefined

      const sessionRow = yield* withReadonlyDb({
        path: artifact.path,
        f: (database) =>
          database.get({
            sql: `
              select id, slug, directory, title, version, time_created, time_updated, time_archived
              from session
              where id = ?
            `,
            params: [artifact.artifactId],
          }),
      })

      if (sessionRow == null) {
        return {
          artifact,
          records: [] as Array<OpenCodeRecord>,
          checkpoint: yield* Schema.decodeEffect(IngestionCheckpoint)({
            sourceId: artifact.sourceId,
            artifactId: artifact.artifactId,
            path: artifact.path,
            status: artifact.status,
            cursor: {
              _tag: 'UpdatedAtCursor',
              updatedAtEpochMs: previousCursor?.updatedAtEpochMs ?? 0,
              ...(previousCursor?.lastRecordKey !== undefined && {
                lastRecordKey: previousCursor.lastRecordKey,
              }),
              contentVersion,
            },
            updatedAtEpochMs: Date.now(),
          }).pipe(
            Effect.mapError(
              (cause) =>
                new SessionCheckpointDecodeError({
                  message: 'Failed to decode OpenCode checkpoint for missing session',
                  path: artifact.path,
                  cause,
                }),
            ),
          ),
        }
      }

      const session = yield* Schema.decodeUnknownEffect(OpenCodeSessionRow)(sessionRow).pipe(
        Effect.mapError(
          (cause) =>
            new SessionArtifactDecodeError({
              message: 'Failed to decode OpenCode session row',
              sourceId: artifact.sourceId,
              artifactId: artifact.artifactId,
              rawRecord: JSON.stringify(sessionRow),
              cause,
            }),
        ),
      )

      const resetToFullReplay =
        previousCursor !== undefined && session.time_updated < previousCursor.updatedAtEpochMs
      const watermark = resetToFullReplay === true ? 0 : (previousCursor?.updatedAtEpochMs ?? 0)

      const messageRows = yield* withReadonlyDb({
        path: artifact.path,
        f: (database) =>
          database.all({
            sql: `
              select id, session_id, time_created, time_updated, data
              from message
              where session_id = ? and time_updated >= ?
              order by time_updated asc, id asc
            `,
            params: [artifact.artifactId, watermark],
          }),
      })

      const partRows = yield* withReadonlyDb({
        path: artifact.path,
        f: (database) =>
          database.all({
            sql: `
              select id, session_id, time_created, time_updated, data
              from part
              where session_id = ? and time_updated >= ?
              order by time_updated asc, id asc
            `,
            params: [artifact.artifactId, watermark],
          }),
      })

      const sessionRecord = yield* Schema.decodeEffect(OpenCodeSessionRecord)({
        _tag: 'OpenCodeSession',
        session,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new SessionArtifactDecodeError({
              message: 'Failed to decode OpenCode session record',
              sourceId: artifact.sourceId,
              artifactId: artifact.artifactId,
              rawRecord: JSON.stringify(session),
              cause,
            }),
        ),
      )

      const messageRecords = yield* Effect.forEach(messageRows, (rawRow) => {
        const row = Schema.decodeUnknownSync(OpenCodeMessageRow)(rawRow)
        return parseOpenCodeRowData({
          sourceId: artifact.sourceId,
          artifactId: artifact.artifactId,
          rawRow: row,
          rawData: row.data,
          message: 'Failed to parse OpenCode message record JSON',
        }).pipe(
          Effect.flatMap((data) =>
            Schema.decodeUnknownEffect(OpenCodeMessageRecord)({
              _tag: 'OpenCodeMessage',
              id: row.id,
              sessionId: row.session_id,
              timeCreated: row.time_created,
              timeUpdated: row.time_updated,
              data,
            }),
          ),
          Effect.mapError(
            (cause) =>
              new SessionArtifactDecodeError({
                message: 'Failed to decode OpenCode message record',
                sourceId: artifact.sourceId,
                artifactId: artifact.artifactId,
                rawRecord: JSON.stringify(row),
                cause,
              }),
          ),
        )
      })

      const partRecords = yield* Effect.forEach(partRows, (rawRow) => {
        const row = Schema.decodeUnknownSync(OpenCodePartRow)(rawRow)
        return parseOpenCodeRowData({
          sourceId: artifact.sourceId,
          artifactId: artifact.artifactId,
          rawRow: row,
          rawData: row.data,
          message: 'Failed to parse OpenCode part record JSON',
        }).pipe(
          Effect.flatMap((data) =>
            Schema.decodeUnknownEffect(OpenCodePartRecord)({
              _tag: 'OpenCodePart',
              id: row.id,
              sessionId: row.session_id,
              timeCreated: row.time_created,
              timeUpdated: row.time_updated,
              data,
            }),
          ),
          Effect.mapError(
            (cause) =>
              new SessionArtifactDecodeError({
                message: 'Failed to decode OpenCode part record',
                sourceId: artifact.sourceId,
                artifactId: artifact.artifactId,
                rawRecord: JSON.stringify(row),
                cause,
              }),
          ),
        )
      })

      const orderedRecords = [
        ...(previousCursor === undefined ||
        resetToFullReplay === true ||
        session.time_updated > watermark
          ? [sessionRecord]
          : []),
        ...messageRecords,
        ...partRecords,
      ].toSorted((left, right) => {
        const leftTime =
          left._tag === 'OpenCodeSession' ? left.session.time_updated : left.timeUpdated
        const rightTime =
          right._tag === 'OpenCodeSession' ? right.session.time_updated : right.timeUpdated
        if (leftTime !== rightTime) return leftTime - rightTime

        const rankDiff = rankOpenCodeRecord(left) - rankOpenCodeRecord(right)
        if (rankDiff !== 0) return rankDiff

        const leftKey =
          left._tag === 'OpenCodeSession'
            ? buildOpenCodeRecordKey({ kind: 'session', id: left.session.id })
            : buildOpenCodeRecordKey({
                kind: left._tag === 'OpenCodeMessage' ? 'message' : 'part',
                id: left.id,
              })
        const rightKey =
          right._tag === 'OpenCodeSession'
            ? buildOpenCodeRecordKey({ kind: 'session', id: right.session.id })
            : buildOpenCodeRecordKey({
                kind: right._tag === 'OpenCodeMessage' ? 'message' : 'part',
                id: right.id,
              })
        return leftKey.localeCompare(rightKey)
      })
      const previousOrderKey = normalizeOpenCodeOrderKey(previousCursor?.lastRecordKey)

      const records = orderedRecords.filter((record) => {
        const recordTime =
          record._tag === 'OpenCodeSession' ? record.session.time_updated : record.timeUpdated
        const recordKey =
          record._tag === 'OpenCodeSession'
            ? buildOpenCodeRecordKey({ kind: 'session', id: record.session.id })
            : buildOpenCodeRecordKey({
                kind: record._tag === 'OpenCodeMessage' ? 'message' : 'part',
                id: record.id,
              })
        const orderKey = buildOpenCodeOrderKey({
          rank: rankOpenCodeRecord(record),
          recordKey,
        })

        return (
          recordTime > watermark ||
          (recordTime === watermark && orderKey > (previousOrderKey ?? ''))
        )
      })

      const nextWatermark = Math.max(
        session.time_updated,
        ...messageRecords.map((record) => record.timeUpdated),
        ...partRecords.map((record) => record.timeUpdated),
        previousCursor?.updatedAtEpochMs ?? 0,
      )
      const lastRecordKey =
        records.length === 0
          ? previousCursor?.lastRecordKey
          : (() => {
              const lastRecord = records[records.length - 1]
              if (lastRecord === undefined) return previousCursor?.lastRecordKey
              const recordKey =
                lastRecord._tag === 'OpenCodeSession'
                  ? buildOpenCodeRecordKey({ kind: 'session', id: lastRecord.session.id })
                  : buildOpenCodeRecordKey({
                      kind: lastRecord._tag === 'OpenCodeMessage' ? 'message' : 'part',
                      id: lastRecord.id,
                    })
              return buildOpenCodeOrderKey({
                rank: rankOpenCodeRecord(lastRecord),
                recordKey,
              })
            })()

      return {
        artifact,
        records,
        checkpoint: yield* Schema.decodeEffect(IngestionCheckpoint)({
          sourceId: artifact.sourceId,
          artifactId: artifact.artifactId,
          path: artifact.path,
          status: artifact.status,
          cursor: {
            _tag: 'UpdatedAtCursor',
            updatedAtEpochMs: nextWatermark,
            ...(lastRecordKey !== undefined && { lastRecordKey }),
            contentVersion,
          },
          updatedAtEpochMs: Date.now(),
        }).pipe(
          Effect.mapError(
            (cause) =>
              new SessionCheckpointDecodeError({
                message: 'Failed to decode OpenCode ingestion checkpoint',
                path: artifact.path,
                cause,
              }),
          ),
        ),
      }
    }),
})
