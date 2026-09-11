import { Schema } from 'effect'

import { hashCanonicalJson } from '@overeng/content-address'

import type { CanonicalDataSourceMetadata, QueryRowsInput } from './commands.ts'
import {
  hashFromContentDigest,
  type DatabaseId,
  type DataSourceId,
  type PageId,
  type PropertyId,
} from './domain.ts'
import { SurfaceKey } from './events.ts'

/** Decode an arbitrary string into a branded `SurfaceKey` — throws on malformed input. */
export const surfaceKey = (value: string): SurfaceKey => Schema.decodeSync(SurfaceKey)(value)

/** Surface key for a page's top-level property surface (`page:<id>`). */
export const pageSurfaceKey = (pageId: PageId): SurfaceKey => surfaceKey(`page:${pageId}`)

/** Surface key scoped to a single property on a page (`page:<id>:property:<id>`). */
export const propertySurfaceKey = ({
  pageId,
  propertyId,
}: {
  readonly pageId: PageId
  readonly propertyId: PropertyId
}): SurfaceKey => surfaceKey(`page:${pageId}:property:${propertyId}`)

/** Surface key for the markdown body of a page (`page:<id>:body`). */
export const bodySurfaceKey = (pageId: PageId): SurfaceKey => surfaceKey(`page:${pageId}:body`)

/** Surface key for a schema property within a data source (`data-source:<id>:schema:<propId>`). */
export const schemaSurfaceKey = ({
  dataSourceId,
  propertyId,
}: {
  readonly dataSourceId: DataSourceId
  readonly propertyId: PropertyId
}): SurfaceKey => surfaceKey(`data-source:${dataSourceId}:schema:${propertyId}`)

/** Surface key for data-source metadata such as title and description. */
export const dataSourceMetadataSurfaceKey = (dataSourceId: DataSourceId): SurfaceKey =>
  surfaceKey(`data-source:${dataSourceId}:metadata`)

/** Surface key for database/container metadata such as title and description. */
export const databaseMetadataSurfaceKey = (databaseId: DatabaseId): SurfaceKey =>
  surfaceKey(`database:${databaseId}:metadata`)

/** Surface key for a local file path (`path:<path>`); used in path-claim conflict detection. */
export const pathSurfaceKey = (path: string): SurfaceKey => surfaceKey(`path:${path}`)

/** Surface key for a query contract within a data source; the hash encodes the full contract so changing any query parameter invalidates prior checkpoints. */
export const querySurfaceKey = ({
  dataSourceId,
  queryContractHash,
}: {
  readonly dataSourceId: DataSourceId
  readonly queryContractHash: string
}): SurfaceKey => surfaceKey(`data-source:${dataSourceId}:query:${queryContractHash}`)

/** SHA-256 hash for canonicalized datasource-sync contract and surface data. */
export const canonicalHash = (value: unknown) =>
  hashFromContentDigest(hashCanonicalJson({ schema: Schema.Unknown, value }))

/** Hash data-source metadata independently from the property schema surface. */
export const dataSourceMetadataHash = (metadata: CanonicalDataSourceMetadata) =>
  canonicalHash(metadata)

/** Hash the query contract fields that define durable query membership identity. */
export const queryContractHash = ({
  input,
  apiVersion,
}: {
  readonly input: QueryRowsInput
  readonly apiVersion: string
}) =>
  canonicalHash({
    apiVersion,
    dataSourceId: input.dataSourceId,
    queryContract: {
      apiVersion: input.queryContract.apiVersion,
      filter: input.queryContract.filter,
      membershipScope: input.queryContract.membershipScope,
      pageSize: input.queryContract.pageSize,
      sorts: input.queryContract.sorts,
    },
  })
