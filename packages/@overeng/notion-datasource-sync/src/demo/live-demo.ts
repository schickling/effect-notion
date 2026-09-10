import { Result, Schema } from 'effect'

import { NonEmptyTrimmedString } from '../core/domain.ts'

/** Stable keys for the durable Notion datasource-sync demo domains. */
export const NotionDatasourceSyncDemoDataSourceKey = Schema.Literals([
  'projects',
  'incidents',
  'customers',
  'activity',
])

export type NotionDatasourceSyncDemoDataSourceKey =
  typeof NotionDatasourceSyncDemoDataSourceKey.Type

/** Separates read-only verification from the guarded public synthetic fixture provisioner. */
export const NotionDatasourceSyncLiveFixtureLane = Schema.Literals([
  'read-only-verifier',
  'provisioner',
])

export type NotionDatasourceSyncLiveFixtureLane = typeof NotionDatasourceSyncLiveFixtureLane.Type

const NotionId = Schema.String.check(
  Schema.isPattern(
    /^[0-9a-f]{32}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  ),
)

const NotionUrl = Schema.String.check(Schema.isPattern(/^https:\/\/www\.notion\.so\//))

/** Expected live Notion database/data-source shape for one demo domain. */
export const NotionDatasourceSyncDemoDataSourceSchema = Schema.Struct({
  key: NotionDatasourceSyncDemoDataSourceKey,
  title: NonEmptyTrimmedString,
  databaseId: NotionId,
  databaseUrl: NotionUrl,
  dataSourceId: NotionId,
  expectedRows: Schema.Finite,
  expectedPropertyNames: Schema.Array(NonEmptyTrimmedString),
  fastReplica: Schema.Boolean,
}).annotate({ identifier: 'NotionDatasourceSync.DemoDataSource' })

export type NotionDatasourceSyncDemoDataSource =
  typeof NotionDatasourceSyncDemoDataSourceSchema.Type

/** Safety contract for the lane that may write demo fixture IDs back into the public manifest. */
export const NotionDatasourceSyncDemoProvisionerContractSchema = Schema.Struct({
  lane: Schema.Literal('provisioner'),
  ownedBy: Schema.Literal('notion-datasource-sync-demo-provisioner'),
  writes: Schema.Literal('public-synthetic-fixtures-only'),
  emittedIds: Schema.Literal('env-or-public-synthetic-manifest'),
  requiredMarker: NonEmptyTrimmedString,
}).annotate({ identifier: 'NotionDatasourceSync.DemoProvisionerContract' })

/** Durable online demo page plus every child data source the package verifies. */
export const NotionDatasourceSyncDemoManifestSchema = Schema.Struct({
  apiVersion: Schema.Literal(1),
  fixtureKind: Schema.Literal('public-synthetic'),
  pageId: NotionId,
  pageUrl: NotionUrl,
  readOnlyContract: Schema.Struct({
    lane: Schema.Literal('read-only-verifier'),
    minDurableRows: Schema.Finite,
    localFullReplica: Schema.Literal('explicit-opt-in'),
  }),
  provisionerContract: NotionDatasourceSyncDemoProvisionerContractSchema,
  dataSources: Schema.Array(NotionDatasourceSyncDemoDataSourceSchema),
}).annotate({ identifier: 'NotionDatasourceSync.DemoManifest' })

export type NotionDatasourceSyncDemoManifest = typeof NotionDatasourceSyncDemoManifestSchema.Type

/** Child database identity discovered from a live synthetic demo page before local verification syncs it. */
export type NotionDatasourceSyncDemoChildDatabase = {
  readonly databaseId: string
  readonly title: string
  readonly dataSourceId: string
}

const NotionApiFailureBodySchema = Schema.Struct({
  object: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Finite),
  code: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
}).annotate({ identifier: 'NotionDatasourceSync.DemoApiFailureBody' })

const decodeNotionApiFailureBody = (
  body: string | undefined,
): typeof NotionApiFailureBodySchema.Type | undefined => {
  if (body === undefined) return undefined
  const decoded = Schema.decodeResult(Schema.fromJsonString(NotionApiFailureBodySchema))(body)
  return Result.isSuccess(decoded) === true ? decoded.success : undefined
}

/** Format live demo access failures without echoing raw Notion response bodies, request IDs, integration IDs, or object IDs. */
export const formatNotionDatasourceSyncDemoAccessFailure = ({
  operation,
  targetAlias,
  status,
  body,
  code,
}: {
  readonly operation: string
  readonly targetAlias: string
  readonly status?: number | undefined
  readonly body?: string | undefined
  readonly code?: string | undefined
}): string => {
  const parsed = decodeNotionApiFailureBody(body)
  const resolvedStatus = status ?? parsed?.status
  const resolvedCode = code ?? parsed?.code ?? 'unknown'
  const statusText = resolvedStatus === undefined ? 'unavailable' : resolvedStatus.toString()
  const sharingHint =
    resolvedStatus === 404 && resolvedCode === 'object_not_found'
      ? 'share the durable synthetic demo page and every child database/data source with the configured Notion integration, or update the local demo manifest/config to point at an accessible synthetic fixture'
      : 'verify the configured Notion integration can read the durable synthetic demo page, child databases, and data sources'

  return [
    `Notion live demo access check failed: operation=${operation} target=${targetAlias}.`,
    `status=${statusText} code=${resolvedCode}.`,
    `blocker=${sharingHint}.`,
  ].join(' ')
}

const minimumDurableReadOnlyRows = 500

/** Source-of-truth manifest for the public automated datasource-sync demo page. */
export const notionDatasourceSyncDemoManifest = {
  apiVersion: 1,
  fixtureKind: 'public-synthetic',
  pageId: '36cf141b18dc803b98ebd21f2a243453',
  pageUrl:
    'https://www.notion.so/overeng-notion-datasource-sync-demo-automated-36cf141b18dc803b98ebd21f2a243453',
  readOnlyContract: {
    lane: 'read-only-verifier',
    minDurableRows: minimumDurableReadOnlyRows,
    localFullReplica: 'explicit-opt-in',
  },
  provisionerContract: {
    lane: 'provisioner',
    ownedBy: 'notion-datasource-sync-demo-provisioner',
    writes: 'public-synthetic-fixtures-only',
    emittedIds: 'env-or-public-synthetic-manifest',
    requiredMarker: 'notion datasource sync automated demo',
  },
  dataSources: [
    {
      key: 'projects',
      title: 'notion datasource sync demo projects',
      databaseId: 'dcd16fba-737e-4c30-b5d0-e16c60e76537',
      databaseUrl: 'https://www.notion.so/dcd16fba737e4c30b5d0e16c60e76537',
      dataSourceId: '3a936610-2e39-436a-98b3-438caca366b5',
      expectedRows: 12,
      expectedPropertyNames: [
        'Name',
        'State',
        'Budget',
        'Strategic',
        'Kickoff',
        'Teams',
        'Summary',
        'Brief',
      ],
      fastReplica: true,
    },
    {
      key: 'incidents',
      title: 'notion datasource sync demo incidents',
      databaseId: '52c6cfd2-48e5-4298-9498-689e972ed89f',
      databaseUrl: 'https://www.notion.so/52c6cfd248e542989498689e972ed89f',
      dataSourceId: '3d4e761b-4e03-4c3e-967e-1ef2ed698d6a',
      expectedRows: 30,
      expectedPropertyNames: ['Name', 'Severity', 'Open', 'Started', 'Impact', 'Systems', 'Notes'],
      fastReplica: true,
    },
    {
      key: 'customers',
      title: 'notion datasource sync demo customers',
      databaseId: '74172538-64bd-41d0-8377-9d9a1c3c2118',
      databaseUrl: 'https://www.notion.so/7417253864bd41d083779d9a1c3c2118',
      dataSourceId: '6b0e86c4-df36-42fd-9f63-4a694c271542',
      expectedRows: 48,
      expectedPropertyNames: [
        'Name',
        'Plan',
        'ARR',
        'Renewal',
        'Contacted',
        'Regions',
        'Health',
        'Email',
        'Phone',
      ],
      fastReplica: true,
    },
    {
      key: 'activity',
      title: 'notion datasource sync demo activity events',
      databaseId: '348fc8eb-40e3-46e6-a0b5-0eeda00ba4c4',
      databaseUrl: 'https://www.notion.so/348fc8eb40e346e6a0b50eeda00ba4c4',
      dataSourceId: '5fbd8d54-7ea2-46ca-a8b5-784a1bb147c3',
      expectedRows: 500,
      expectedPropertyNames: [
        'Name',
        'Segment',
        'Sequence',
        'Automated',
        'EventDate',
        'Labels',
        'Payload',
      ],
      fastReplica: false,
    },
  ],
} as const satisfies NotionDatasourceSyncDemoManifest

/** Decode and validate the demo manifest schema without requiring credentials. */
export const decodeNotionDatasourceSyncDemoManifest = Schema.decodeUnknownSync(
  NotionDatasourceSyncDemoManifestSchema,
)

/** Enforce the committed public synthetic fixture contract before any read-only verifier or provisioner lane consumes it. */
export const assertNotionDatasourceSyncDemoManifestContract = ({
  value,
  lane,
}: {
  readonly value: unknown
  readonly lane: NotionDatasourceSyncLiveFixtureLane
}): NotionDatasourceSyncDemoManifest => {
  const manifest = decodeNotionDatasourceSyncDemoManifest(value)
  const keys = manifest.dataSources.map((dataSource) => dataSource.key)
  const duplicateKey = keys.find((key, index) => keys.indexOf(key) !== index)
  if (duplicateKey !== undefined) {
    throw new Error(`notion datasource sync demo manifest has duplicate key ${duplicateKey}`)
  }

  const durableReadOnlySources = manifest.dataSources.filter(
    (dataSource) => dataSource.expectedRows >= manifest.readOnlyContract.minDurableRows,
  )
  if (durableReadOnlySources.length === 0) {
    throw new Error(
      `notion datasource sync demo manifest must include a durable read-only fixture with at least ${manifest.readOnlyContract.minDurableRows.toString()} rows`,
    )
  }
  if (durableReadOnlySources.some((dataSource) => dataSource.fastReplica) === true) {
    throw new Error('durable read-only 500+ row fixtures must stay out of the fast replica lane')
  }
  for (const dataSource of manifest.dataSources) {
    if (dataSource.expectedRows < 1) {
      throw new Error(`notion datasource sync demo fixture ${dataSource.key} must have rows`)
    }
    if (dataSource.expectedPropertyNames.includes('Name') === false) {
      throw new Error(`notion datasource sync demo fixture ${dataSource.key} must expose Name`)
    }
  }

  if (lane === 'provisioner') {
    if (manifest.fixtureKind !== 'public-synthetic') {
      throw new Error('provisioner lane may only consume public synthetic fixture manifests')
    }
    if (manifest.provisionerContract.writes !== 'public-synthetic-fixtures-only') {
      throw new Error('provisioner lane must be scoped to public synthetic fixtures only')
    }
  }

  return manifest
}

/** Resolve live demo data-source IDs from stable synthetic database titles without requiring those IDs to be committed. */
export const resolveNotionDatasourceSyncDemoDataSources = ({
  manifest,
  childDatabases,
}: {
  readonly manifest: NotionDatasourceSyncDemoManifest
  readonly childDatabases: ReadonlyArray<NotionDatasourceSyncDemoChildDatabase>
}): ReadonlyArray<NotionDatasourceSyncDemoDataSource> =>
  manifest.dataSources.map((expected) => {
    const matches = childDatabases.filter((database) => database.title === expected.title)
    if (matches.length === 0) {
      throw new Error(`live demo page is missing child database ${expected.key}`)
    }
    if (matches.length > 1) {
      throw new Error(`live demo page has duplicate child database ${expected.key}`)
    }
    const [database] = matches
    if (database === undefined) {
      throw new Error(`live demo page is missing child database ${expected.key}`)
    }
    return {
      ...expected,
      databaseId: database.databaseId,
      databaseUrl: `https://www.notion.so/${database.databaseId.replaceAll('-', '')}`,
      dataSourceId: database.dataSourceId,
    }
  })

/** Demo data sources small enough for the default live local-replica verifier. */
export const notionDatasourceSyncFastDemoDataSources =
  assertNotionDatasourceSyncDemoManifestContract({
    value: notionDatasourceSyncDemoManifest,
    lane: 'read-only-verifier',
  }).dataSources.filter((dataSource) => dataSource.fastReplica)

/** All demo data sources, including the opt-in high-cardinality activity replica. */
export const notionDatasourceSyncFullDemoDataSources =
  assertNotionDatasourceSyncDemoManifestContract({
    value: notionDatasourceSyncDemoManifest,
    lane: 'read-only-verifier',
  }).dataSources
