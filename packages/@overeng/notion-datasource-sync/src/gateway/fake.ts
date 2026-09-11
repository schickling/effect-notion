import { Effect, Layer, Schema, Stream } from 'effect'

import {
  dataSourceMetadataHash,
  queryContractHash as computeQueryContractHash,
} from '../core/canonical.ts'
import {
  CanonicalDataSourceMetadata,
  CreatePageResult as CreatePageResultSchema,
} from '../core/commands.ts'
import type {
  CreatePageCommand,
  CreatePageResult,
  PagePropertyItemPage,
  PatchDatabaseMetadataCommand,
  PatchDataSourceMetadataCommand,
  PatchDataSourceSchemaCommand,
  PatchPagePropertiesCommand,
  QueryRowsPage,
  RetrievePagePropertyInput,
  RestorePageCommand,
  TrashPageCommand,
} from '../core/commands.ts'
import {
  PageId,
  PagePropertyItem,
  PageSnapshot,
  QueryCursor,
  RowPageSnapshot,
  type CapabilityName,
  type DataSourceId,
  type DataSourceSnapshot,
  type DataSourceViewSnapshot,
  type NotionApiContract,
  type PageSnapshot as PageSnapshotType,
  PropertyId,
  type RowPageSnapshot as RowPageSnapshotType,
} from '../core/domain.ts'
import type { NotionGatewayError } from '../core/errors.ts'
import { NotionDataSourceGateway, type NotionDataSourceGatewayShape } from '../core/ports.ts'
import {
  shortSpanId,
  spanAttr,
  spanLabel,
  withSpan,
  withStreamSpan,
} from '../observability/observability.ts'
import { hashStoreBytes } from '../store/projections.ts'
import {
  makeCapabilityPreflightResult,
  makeGatewayError,
  makeNotionApiContract,
  makeNotionDataSourceGateway,
  notionRequestId,
} from './gateway.ts'

/** Seeded property item list for a single property in the fake gateway. */
export type FakePagePropertyItems = {
  readonly propertyId: PropertyId
  readonly items: ReadonlyArray<PagePropertyItem>
}

/** A single page entry seeded into the fake gateway, including its snapshot, row, and optional property item pages. */
export type FakeNotionPageRecord = {
  readonly snapshot: PageSnapshotType
  readonly row: RowPageSnapshotType
  readonly propertyItems?: ReadonlyArray<FakePagePropertyItems>
  readonly visibleInFilteredQueries?: boolean
}

/** Full configuration for the in-memory fake gateway — data sources, pages, pagination limits, and fault-injection flags. */
export type FakeNotionDataSourceGatewayConfig = {
  readonly configuredApiVersion?: string
  readonly apiContract?: NotionApiContract
  readonly clientVersion?: string
  readonly supportedCapabilities?: ReadonlyArray<CapabilityName>
  readonly dataSources: ReadonlyArray<DataSourceSnapshot>
  readonly pages: ReadonlyArray<FakeNotionPageRecord>
  readonly views?: ReadonlyArray<DataSourceViewSnapshot>
  readonly queryResultCap?: number
  readonly queryPageLimit?: number
  readonly pagePropertyPageSize?: number
  readonly permissionAmbiguousDataSourceIds?: ReadonlyArray<DataSourceId>
  readonly permissionAmbiguousPageIds?: ReadonlyArray<PageId>
  readonly readAfterWriteMismatchPageIds?: ReadonlyArray<PageId>
}

type MutablePageRecord = {
  snapshot: PageSnapshotType
  row: RowPageSnapshotType
  readonly propertyItems: ReadonlyArray<FakePagePropertyItems>
  readonly visibleInFilteredQueries: boolean
}

const pageKey = (pageId: PageId): string => pageId
const dataSourceKey = (dataSourceId: DataSourceId): string => dataSourceId
const propertyKey = (propertyId: PropertyId): string => propertyId

const cursorForOffset = (offset: number): QueryCursor => QueryCursor.make(`offset:${offset}`)

const parseCursor = ({
  cursor,
  operation,
}: {
  readonly cursor: QueryCursor | null
  readonly operation: 'queryRows' | 'retrievePageProperty'
}): Effect.Effect<number, NotionGatewayError> => {
  if (cursor === null) {
    return Effect.succeed(0)
  }

  const match = /^offset:(\d+)$/.exec(cursor)

  return match?.[1] === undefined
    ? Effect.fail(
        makeGatewayError({
          operation,
          message: `Unsupported fake gateway cursor: ${cursor}`,
        }),
      )
    : Effect.succeed(Number.parseInt(match[1], 10))
}

const readRequestId = (sequence: number) => notionRequestId(`fake-req-${sequence}`)

const fakeGatewaySpan = (input: {
  readonly operation: string
  readonly apiVersion: string
  readonly dataSourceId?: DataSourceId
  readonly pageId?: PageId
}) => {
  const entityId = input.pageId ?? input.dataSourceId

  return {
    [spanAttr.spanLabel]: spanLabel(
      input.operation,
      entityId === undefined ? undefined : shortSpanId(entityId),
    ),
    [spanAttr.processRole]: 'fake-gateway',
    [spanAttr.operation]: input.operation,
    [spanAttr.apiVersion]: input.apiVersion,
    [spanAttr.dataSourceId]: input.dataSourceId,
    [spanAttr.pageId]: input.pageId,
  }
}

const hasPageId = ({
  pageIds,
  pageId,
}: {
  readonly pageIds: ReadonlySet<string>
  readonly pageId: PageId
}): boolean => pageIds.has(pageKey(pageId))
const hasDataSourceId = ({
  dataSourceIds,
  dataSourceId,
}: {
  readonly dataSourceIds: ReadonlySet<string>
  readonly dataSourceId: DataSourceId
}): boolean => dataSourceIds.has(dataSourceKey(dataSourceId))
const encodeDateTimeUtc = Schema.encodeSync(Schema.DateTimeUtcFromString)

const findDataSource = ({
  dataSources,
  dataSourceId,
  operation,
}: {
  readonly dataSources: Map<string, DataSourceSnapshot>
  readonly dataSourceId: DataSourceId
  readonly operation:
    | 'retrieveDataSource'
    | 'queryRows'
    | 'createPage'
    | 'patchDataSourceSchema'
    | 'patchDataSourceMetadata'
    | 'patchDatabaseMetadata'
}): Effect.Effect<DataSourceSnapshot, NotionGatewayError> => {
  const snapshot = dataSources.get(dataSourceKey(dataSourceId))

  return snapshot === undefined
    ? Effect.fail(
        makeGatewayError({
          operation,
          dataSourceId,
          guard: 'PermissionAmbiguous',
          message: `Data source is unavailable or not shared: ${dataSourceId}`,
        }),
      )
    : Effect.succeed(snapshot)
}

const findPage = ({
  pages,
  pageId,
  operation,
}: {
  readonly pages: Map<string, MutablePageRecord>
  readonly pageId: PageId
  readonly operation:
    | 'retrievePage'
    | 'retrievePageProperty'
    | 'patchPageProperties'
    | 'createPage'
    | 'trashPage'
    | 'restorePage'
}): Effect.Effect<MutablePageRecord, NotionGatewayError> => {
  const page = pages.get(pageKey(pageId))

  return page === undefined
    ? Effect.fail(
        makeGatewayError({
          operation,
          pageId,
          guard: 'PermissionAmbiguous',
          message: `Page is unavailable or not shared: ${pageId}`,
        }),
      )
    : Effect.succeed(page)
}

const validatePageSize = ({
  operation,
  pageSize,
  dataSourceId,
  pageId,
}: {
  readonly operation: 'queryRows' | 'retrievePageProperty'
  readonly pageSize: number
  readonly dataSourceId?: DataSourceId
  readonly pageId?: PageId
}): Effect.Effect<number, NotionGatewayError> =>
  Number.isInteger(pageSize) === true && pageSize >= 1 && pageSize <= 100
    ? Effect.succeed(pageSize)
    : Effect.fail(
        makeGatewayError({
          operation,
          ...(dataSourceId === undefined ? {} : { dataSourceId }),
          ...(pageId === undefined ? {} : { pageId }),
          guard: 'UnsupportedRemoteShape',
          message: `Invalid Notion pagination page size: ${pageSize}`,
        }),
      )

export { queryContractHash } from '../core/canonical.ts'

/**
 * Create an in-memory `NotionDataSourceGatewayShape` for testing.
 *
 * Simulates pagination, permission ambiguity, stale-base rejection, and
 * read-after-write mismatches. Mutable page state supports multi-step test flows.
 */
export const makeFakeNotionDataSourceGateway = (
  config: FakeNotionDataSourceGatewayConfig,
): NotionDataSourceGatewayShape => {
  const apiContract =
    config.apiContract ??
    makeNotionApiContract({
      ...(config.clientVersion === undefined ? {} : { clientVersion: config.clientVersion }),
      ...(config.supportedCapabilities === undefined
        ? {}
        : { supportedCapabilities: config.supportedCapabilities }),
    })
  const dataSources = new Map(
    config.dataSources.map((snapshot) => [dataSourceKey(snapshot.dataSourceId), snapshot]),
  )
  const pages = new Map(
    config.pages.map((record) => [
      pageKey(record.snapshot.pageId),
      {
        snapshot: record.snapshot,
        row: record.row,
        propertyItems: record.propertyItems ?? [],
        visibleInFilteredQueries: record.visibleInFilteredQueries ?? true,
      },
    ]),
  )
  const views = config.views ?? []
  const permissionAmbiguousPageIds = new Set(
    (config.permissionAmbiguousPageIds ?? []).map((pageId) => pageKey(pageId)),
  )
  const permissionAmbiguousDataSourceIds = new Set(
    (config.permissionAmbiguousDataSourceIds ?? []).map((sourceId) => dataSourceKey(sourceId)),
  )
  const readAfterWriteMismatchPageIds = new Set(
    (config.readAfterWriteMismatchPageIds ?? []).map((pageId) => pageKey(pageId)),
  )
  const queryResultCap = config.queryResultCap ?? Number.POSITIVE_INFINITY
  const queryPageLimit = config.queryPageLimit ?? Number.POSITIVE_INFINITY
  const pagePropertyPageSize = config.pagePropertyPageSize ?? 100
  let requestSequence = 0

  const nextRequestId = () => readRequestId(++requestSequence)

  return makeNotionDataSourceGateway({
    ...(config.configuredApiVersion === undefined
      ? {}
      : { configuredApiVersion: config.configuredApiVersion }),
    apiContract,
    preflightCapabilities: (input) =>
      Effect.succeed(makeCapabilityPreflightResult({ input, apiContract })).pipe(
        withSpan({
          span: 'fakeGatewayRequest',
          attributes: fakeGatewaySpan({
            operation: 'preflightCapabilities',
            apiVersion: apiContract.apiVersion,
            dataSourceId: input.dataSourceId,
          }),
        }),
      ),
    retrieveDataSource: (id) =>
      hasDataSourceId({ dataSourceIds: permissionAmbiguousDataSourceIds, dataSourceId: id }) ===
      true
        ? Effect.fail(
            makeGatewayError({
              operation: 'retrieveDataSource',
              dataSourceId: id,
              guard: 'PermissionAmbiguous',
              message: `Data source retrieval is permission ambiguous: ${id}`,
            }),
          )
        : findDataSource({ dataSources, dataSourceId: id, operation: 'retrieveDataSource' }).pipe(
            withSpan({
              span: 'fakeGatewayRequest',
              attributes: fakeGatewaySpan({
                operation: 'retrieveDataSource',
                apiVersion: apiContract.apiVersion,
                dataSourceId: id,
              }),
            }),
          ),
    queryRows: (input) =>
      Stream.fromEffect(
        (hasDataSourceId({
          dataSourceIds: permissionAmbiguousDataSourceIds,
          dataSourceId: input.dataSourceId,
        }) === true
          ? Effect.fail(
              makeGatewayError({
                operation: 'queryRows',
                dataSourceId: input.dataSourceId,
                guard: 'PermissionAmbiguous',
                message: `Data source query is permission ambiguous: ${input.dataSourceId}`,
              }),
            )
          : findDataSource({
              dataSources,
              dataSourceId: input.dataSourceId,
              operation: 'queryRows',
            })
        ).pipe(
          Effect.andThen(
            validatePageSize({
              operation: 'queryRows',
              pageSize: input.queryContract.pageSize,
              dataSourceId: input.dataSourceId,
            }),
          ),
          Effect.zipWith(
            parseCursor({ cursor: input.startCursor, operation: 'queryRows' }),
            (pageSize, startOffset) => ({
              pageSize,
              startOffset,
            }),
          ),
          Effect.map(({ pageSize, startOffset }): ReadonlyArray<QueryRowsPage> => {
            const highWatermark =
              input.queryContract.highWatermark === null
                ? undefined
                : encodeDateTimeUtc(input.queryContract.highWatermark)
            const allRows = [...pages.values()]
              .filter((page) => page.snapshot.dataSourceId === input.dataSourceId)
              // Real Notion excludes trashed pages from `data_source.query`: an
              // archived page vanishes from the query window entirely. Modelling that
              // here is what makes the F8 disappearance->tombstone->reprojection path
              // load-bearing (a trashed row drops out, gets reclassified as remote
              // trash, and stays restorable).
              .filter((page) => page.row.inTrash !== true)
              .filter(
                (page) =>
                  input.queryContract.membershipScope === 'all-data-source-rows' ||
                  page.visibleInFilteredQueries === true,
              )
              .filter(
                (page) =>
                  highWatermark === undefined ||
                  encodeDateTimeUtc(page.row.lastEditedTime) >= highWatermark,
              )
              .toSorted((left, right) => {
                const edited = encodeDateTimeUtc(left.row.lastEditedTime).localeCompare(
                  encodeDateTimeUtc(right.row.lastEditedTime),
                )
                return edited === 0
                  ? pageKey(left.row.pageId).localeCompare(pageKey(right.row.pageId))
                  : edited
              })
              .map((page) =>
                Object.assign(
                  {
                    _tag: 'QueriedRow' as const,
                    pageId: page.row.pageId,
                    propertiesHash: page.row.propertiesHash,
                    lastEditedTime: page.row.lastEditedTime,
                    inTrash: page.row.inTrash,
                  },
                  page.snapshot.dataSourceId === undefined
                    ? {}
                    : { dataSourceId: page.snapshot.dataSourceId },
                  page.snapshot.propertyValuesJson === undefined
                    ? {}
                    : { propertyValuesJson: page.snapshot.propertyValuesJson },
                ),
              )
            const cap = Math.max(0, Math.min(queryResultCap, allRows.length))
            const cappedAtLimit = allRows.length > cap
            const visibleRows = allRows.slice(0, cap)
            const result: QueryRowsPage[] = []

            for (
              let offset = startOffset;
              offset < visibleRows.length || result.length === 0;
              offset += pageSize
            ) {
              const rows = visibleRows.slice(offset, offset + pageSize)
              const nextOffset = offset + rows.length
              const hasMore = nextOffset < visibleRows.length
              result.push({
                _tag: 'QueryRowsPage',
                apiVersion: apiContract.apiVersion,
                requestId: nextRequestId(),
                queryContractHash: computeQueryContractHash({
                  input,
                  apiVersion: apiContract.apiVersion,
                }),
                rows,
                nextCursor: hasMore === true ? cursorForOffset(nextOffset) : null,
                hasMore,
                cappedAtLimit: cappedAtLimit && hasMore === false,
              })

              if (hasMore === false) {
                break
              }
            }

            return result.slice(0, queryPageLimit)
          }),
        ),
      ).pipe(Stream.flatMap((queryPages) => Stream.fromIterable(queryPages))),
    retrievePage: (id) =>
      hasPageId({ pageIds: permissionAmbiguousPageIds, pageId: id }) === true
        ? Effect.fail(
            makeGatewayError({
              operation: 'retrievePage',
              pageId: id,
              guard: 'PermissionAmbiguous',
              message: `Page retrieval is permission ambiguous: ${id}`,
            }),
          )
        : findPage({ pages, pageId: id, operation: 'retrievePage' }).pipe(
            Effect.map((page) => page.snapshot),
            withSpan({
              span: 'fakeGatewayRequest',
              attributes: fakeGatewaySpan({
                operation: 'retrievePage',
                apiVersion: apiContract.apiVersion,
                pageId: id,
              }),
            }),
          ),
    retrievePageProperty: (input: RetrievePagePropertyInput) =>
      Stream.fromEffect(
        (hasPageId({ pageIds: permissionAmbiguousPageIds, pageId: input.pageId }) === true
          ? Effect.fail(
              makeGatewayError({
                operation: 'retrievePageProperty',
                pageId: input.pageId,
                guard: 'PermissionAmbiguous',
                message: `Page property retrieval is permission ambiguous: ${input.pageId}`,
              }),
            )
          : findPage({ pages, pageId: input.pageId, operation: 'retrievePageProperty' })
        ).pipe(
          Effect.zipWith(
            validatePageSize({
              operation: 'retrievePageProperty',
              pageSize: pagePropertyPageSize,
              pageId: input.pageId,
            }),
            (page, pageSize) => ({ page, pageSize }),
          ),
          Effect.flatMap((page) =>
            parseCursor({ cursor: input.startCursor, operation: 'retrievePageProperty' }).pipe(
              Effect.flatMap(
                (
                  startOffset,
                ): Effect.Effect<ReadonlyArray<PagePropertyItemPage>, NotionGatewayError> => {
                  const propertyItems = page.page.propertyItems.find(
                    (property) =>
                      propertyKey(property.propertyId) === propertyKey(input.propertyId),
                  )

                  if (propertyItems === undefined) {
                    return Effect.fail(
                      makeGatewayError({
                        operation: 'retrievePageProperty',
                        pageId: page.page.snapshot.pageId,
                        guard: 'CurrentSurfaceMissing',
                        message: `Page property is unavailable or not shared: ${input.propertyId}`,
                      }),
                    )
                  }

                  const items = propertyItems.items
                  const result: PagePropertyItemPage[] = []

                  for (
                    let offset = startOffset;
                    offset < items.length || result.length === 0;
                    offset += page.pageSize
                  ) {
                    const pageItems = items.slice(offset, offset + page.pageSize)
                    const nextOffset = offset + pageItems.length
                    const hasMore = nextOffset < items.length
                    result.push({
                      _tag: 'PagePropertyItemPage',
                      apiVersion: apiContract.apiVersion,
                      requestId: nextRequestId(),
                      pageId: input.pageId,
                      propertyId: input.propertyId,
                      items: pageItems,
                      nextCursor: hasMore === true ? cursorForOffset(nextOffset) : null,
                      hasMore,
                    })

                    if (hasMore === false) {
                      break
                    }
                  }

                  return Effect.succeed(result)
                },
              ),
            ),
          ),
        ),
      ).pipe(Stream.flatMap((propertyPages) => Stream.fromIterable(propertyPages))),
    listDataSourceViews: (input) =>
      Stream.fromIterable(
        views.filter(
          (view) =>
            view.databaseId === input.databaseId && view.dataSourceId === input.dataSourceId,
        ),
      ).pipe(
        withStreamSpan({
          span: 'fakeGatewayRequest',
          attributes: fakeGatewaySpan({
            operation: 'listDataSourceViews',
            apiVersion: apiContract.apiVersion,
            dataSourceId: input.dataSourceId,
          }),
        }),
      ),
    patchPageProperties: (command: PatchPagePropertiesCommand) =>
      findPage({ pages, pageId: command.pageId, operation: 'patchPageProperties' }).pipe(
        Effect.flatMap((page) => {
          if (page.snapshot.propertiesHash !== command.basePropertiesHash) {
            return Effect.fail(
              makeGatewayError({
                operation: 'patchPageProperties',
                pageId: command.pageId,
                guard: 'StaleSurfaceBase',
                message: `Patch base does not match current page properties: ${command.pageId}`,
              }),
            )
          }

          const requestId = nextRequestId()

          if (
            hasPageId({ pageIds: readAfterWriteMismatchPageIds, pageId: command.pageId }) === false
          ) {
            const propertiesHash = hashStoreBytes(
              `page-properties\t${command.pageId}\t${command.commandId}\t${Object.keys(
                command.propertyPatch,
              )
                .toSorted()
                .join(',')}`,
            )
            page.snapshot = PageSnapshot.make({ ...page.snapshot, propertiesHash, requestId })
            page.row = RowPageSnapshot.make({ ...page.row, propertiesHash })
            for (const [propertyId, value] of Object.entries(command.propertyPatch)) {
              if (value._tag !== 'relation') continue
              const decodedPropertyId = Schema.decodeSync(PropertyId)(propertyId)
              const mutablePropertyItems = page.propertyItems as Array<
                (typeof page.propertyItems)[number]
              >
              const existingIndex = page.propertyItems.findIndex(
                (property) => propertyKey(property.propertyId) === propertyId,
              )
              const relationItems = {
                propertyId: decodedPropertyId,
                items: value.pageIds.map((relatedPageId, index) =>
                  PagePropertyItem.make({
                    _tag: 'PagePropertyItem',
                    pageId: command.pageId,
                    propertyId: decodedPropertyId,
                    itemHash: hashStoreBytes(
                      `relation-item\t${command.pageId}\t${propertyId}\t${relatedPageId}\t${index}`,
                    ),
                    valueHash: hashStoreBytes(`relation-value\t${relatedPageId}`),
                    valueJson: JSON.stringify({ id: relatedPageId }),
                  }),
                ),
              }
              if (existingIndex === -1) mutablePropertyItems.push(relationItems)
              else mutablePropertyItems[existingIndex] = relationItems
            }
          }

          return Effect.succeed(requestId)
        }),
      ),
    createPage: (command: CreatePageCommand) =>
      findDataSource({
        dataSources,
        dataSourceId: command.dataSourceId,
        operation: 'createPage',
      }).pipe(
        Effect.flatMap((dataSource) => {
          if (dataSource.schemaHash !== command.baseSchemaHash) {
            return Effect.fail(
              makeGatewayError({
                operation: 'createPage',
                dataSourceId: command.dataSourceId,
                guard: 'StaleSurfaceBase',
                message: `Create base does not match current data source schema: ${command.dataSourceId}`,
              }),
            )
          }
          const requestId = nextRequestId()
          const pageId = PageId.make(`fake-created-${command.clientRequestKey}`)
          const propertiesHash = hashStoreBytes(
            `page-create\t${command.dataSourceId}\t${command.commandId}\t${JSON.stringify(
              command.initialProperties,
            )}`,
          )
          const lastEditedTime = Schema.decodeSync(Schema.DateTimeUtcFromString)(
            new Date().toISOString(),
          )
          pages.set(pageKey(pageId), {
            snapshot: PageSnapshot.make({
              _tag: 'PageSnapshot',
              pageId,
              requestId,
              propertiesHash,
              observedAt: lastEditedTime,
              inTrash: false,
            }),
            row: RowPageSnapshot.make({
              _tag: 'RowPageSnapshot',
              pageId,
              propertiesHash,
              lastEditedTime,
              inTrash: false,
            }),
            propertyItems: [],
            visibleInFilteredQueries: true,
          })
          return Effect.succeed(
            CreatePageResultSchema.make({
              _tag: 'CreatePageResult',
              requestId,
              pageId,
              propertiesHash,
            }) satisfies CreatePageResult,
          )
        }),
      ),
    patchDataSourceSchema: (command: PatchDataSourceSchemaCommand) =>
      findDataSource({
        dataSources,
        dataSourceId: command.dataSourceId,
        operation: 'patchDataSourceSchema',
      }).pipe(
        Effect.flatMap((snapshot) => {
          if (snapshot.schemaHash !== command.baseSchemaHash) {
            return Effect.fail(
              makeGatewayError({
                operation: 'patchDataSourceSchema',
                dataSourceId: command.dataSourceId,
                guard: 'StaleSurfaceBase',
                message: `Schema patch base does not match current data source schema: ${command.dataSourceId}`,
              }),
            )
          }

          if (command.operations.length === 0) {
            return Effect.fail(
              makeGatewayError({
                operation: 'patchDataSourceSchema',
                dataSourceId: command.dataSourceId,
                guard: 'UnsupportedRemoteShape',
                message:
                  'Schema patch requires at least one supported operation (AddProperty, RenameProperty, or AddSelectOptions)',
              }),
            )
          }

          const requestId = nextRequestId()
          const operationFingerprint = command.operations
            .map((operation) => {
              switch (operation._tag) {
                case 'AddProperty':
                  return `add:${operation.name}:${operation.definition._tag}`
                case 'RenameProperty':
                  return `rename:${operation.propertyId}:${operation.newName}`
                case 'AddSelectOptions':
                  return `add-options:${operation.propertyId}:existing=${operation.existingOptions
                    .map((option) => option.name)
                    .join('|')}:new=${operation.newOptions.map((option) => option.name).join('|')}`
              }
            })
            .join(';')
          dataSources.set(dataSourceKey(command.dataSourceId), {
            ...snapshot,
            requestId,
            schemaHash: hashStoreBytes(
              `data-source-schema\t${command.dataSourceId}\t${command.commandId}\t${Object.keys(
                command.schemaPatch,
              )
                .toSorted()
                .join(',')}\t${operationFingerprint}`,
            ),
          })

          return Effect.succeed(requestId)
        }),
      ),
    patchDataSourceMetadata: (command: PatchDataSourceMetadataCommand) =>
      findDataSource({
        dataSources,
        dataSourceId: command.dataSourceId,
        operation: 'patchDataSourceMetadata',
      }).pipe(
        Effect.flatMap((snapshot) => {
          if (snapshot.metadataHash === undefined) {
            return Effect.fail(
              makeGatewayError({
                operation: 'patchDataSourceMetadata',
                dataSourceId: command.dataSourceId,
                guard: 'CurrentSurfaceMissing',
                message: `Metadata projection is missing for data source: ${command.dataSourceId}`,
              }),
            )
          }

          if (snapshot.metadataHash !== command.baseMetadataHash) {
            return Effect.fail(
              makeGatewayError({
                operation: 'patchDataSourceMetadata',
                dataSourceId: command.dataSourceId,
                guard: 'StaleSurfaceBase',
                message: `Metadata patch base does not match current data source metadata: ${command.dataSourceId}`,
              }),
            )
          }

          const requestId = nextRequestId()
          const currentMetadata =
            snapshot.metadataJson === undefined
              ? ({
                  _tag: 'CanonicalDataSourceMetadata',
                  titlePlainText: snapshot.metadataTitlePlainText ?? '',
                  descriptionPlainText: snapshot.metadataDescriptionPlainText ?? '',
                  icon: { _tag: 'none' },
                } satisfies CanonicalDataSourceMetadata)
              : Schema.decodeSync(Schema.fromJsonString(CanonicalDataSourceMetadata))(
                  snapshot.metadataJson,
                )
          const nextMetadata: CanonicalDataSourceMetadata = {
            ...currentMetadata,
            ...(command.metadataPatch.titlePlainText === undefined
              ? {}
              : { titlePlainText: command.metadataPatch.titlePlainText }),
            ...(command.metadataPatch.descriptionPlainText === undefined
              ? {}
              : { descriptionPlainText: command.metadataPatch.descriptionPlainText }),
          }
          dataSources.set(dataSourceKey(command.dataSourceId), {
            ...snapshot,
            requestId,
            metadataHash: dataSourceMetadataHash(nextMetadata),
            metadataJson: JSON.stringify(nextMetadata),
            metadataTitlePlainText: nextMetadata.titlePlainText,
            metadataDescriptionPlainText: nextMetadata.descriptionPlainText,
          })

          return Effect.succeed(requestId)
        }),
      ),
    patchDatabaseMetadata: (command: PatchDatabaseMetadataCommand) =>
      findDataSource({
        dataSources,
        dataSourceId: command.dataSourceId,
        operation: 'patchDatabaseMetadata',
      }).pipe(
        Effect.flatMap((snapshot) => {
          if (snapshot.metadataHash === undefined) {
            return Effect.fail(
              makeGatewayError({
                operation: 'patchDatabaseMetadata',
                dataSourceId: command.dataSourceId,
                guard: 'CurrentSurfaceMissing',
                message: `Database metadata projection is missing for data source: ${command.dataSourceId}`,
              }),
            )
          }

          if (snapshot.metadataHash !== command.baseMetadataHash) {
            return Effect.fail(
              makeGatewayError({
                operation: 'patchDatabaseMetadata',
                dataSourceId: command.dataSourceId,
                guard: 'StaleSurfaceBase',
                message: `Database metadata patch base does not match current metadata: ${command.databaseId}`,
              }),
            )
          }

          const requestId = nextRequestId()
          const currentMetadata =
            snapshot.metadataJson === undefined
              ? ({
                  _tag: 'CanonicalDataSourceMetadata',
                  titlePlainText: snapshot.metadataTitlePlainText ?? '',
                  descriptionPlainText: snapshot.metadataDescriptionPlainText ?? '',
                  icon: { _tag: 'none' },
                } satisfies CanonicalDataSourceMetadata)
              : Schema.decodeSync(Schema.fromJsonString(CanonicalDataSourceMetadata))(
                  snapshot.metadataJson,
                )
          const nextMetadata: CanonicalDataSourceMetadata = {
            ...currentMetadata,
            ...(command.metadataPatch.titlePlainText === undefined
              ? {}
              : { titlePlainText: command.metadataPatch.titlePlainText }),
            ...(command.metadataPatch.descriptionPlainText === undefined
              ? {}
              : { descriptionPlainText: command.metadataPatch.descriptionPlainText }),
          }
          dataSources.set(dataSourceKey(command.dataSourceId), {
            ...snapshot,
            requestId,
            metadataHash: dataSourceMetadataHash(nextMetadata),
            metadataJson: JSON.stringify(nextMetadata),
            metadataTitlePlainText: nextMetadata.titlePlainText,
            metadataDescriptionPlainText: nextMetadata.descriptionPlainText,
          })

          return Effect.succeed(requestId)
        }),
      ),
    trashPage: (command: TrashPageCommand) =>
      findPage({ pages, pageId: command.pageId, operation: 'trashPage' }).pipe(
        Effect.flatMap((page) => {
          if (page.snapshot.propertiesHash !== command.basePropertiesHash) {
            return Effect.fail(
              makeGatewayError({
                operation: 'trashPage',
                pageId: command.pageId,
                guard: 'StaleSurfaceBase',
                message: `Trash base does not match current page properties: ${command.pageId}`,
              }),
            )
          }

          const requestId = nextRequestId()
          page.snapshot = PageSnapshot.make({ ...page.snapshot, requestId, inTrash: true })
          page.row = RowPageSnapshot.make({ ...page.row, inTrash: true })
          return Effect.succeed(requestId)
        }),
      ),
    restorePage: (command: RestorePageCommand) =>
      findPage({ pages, pageId: command.pageId, operation: 'restorePage' }).pipe(
        Effect.flatMap((page) => {
          if (page.snapshot.propertiesHash !== command.basePropertiesHash) {
            return Effect.fail(
              makeGatewayError({
                operation: 'restorePage',
                pageId: command.pageId,
                guard: 'StaleSurfaceBase',
                message: `Restore base does not match current page properties: ${command.pageId}`,
              }),
            )
          }

          const requestId = nextRequestId()
          page.snapshot = PageSnapshot.make({ ...page.snapshot, requestId, inTrash: false })
          page.row = RowPageSnapshot.make({ ...page.row, inTrash: false })
          return Effect.succeed(requestId)
        }),
      ),
  })
}

/** Effect Layer that provides `NotionDataSourceGateway` backed by the fake in-memory implementation. */
export const makeFakeNotionDataSourceGatewayLayer = (
  config: FakeNotionDataSourceGatewayConfig,
): Layer.Layer<NotionDataSourceGateway> =>
  Layer.succeed(NotionDataSourceGateway, makeFakeNotionDataSourceGateway(config))
