import { Effect } from 'effect'

import { NotionDatabases, NotionDataSources, SchemaHelpers } from '@overeng/notion-effect-client'
import type {
  NumberFormat,
  PropertySchema,
  PropertySchemaTag,
  RollupFunction,
  SelectOptionConfig,
  StatusGroupConfig,
} from '@overeng/notion-effect-schema'

// -----------------------------------------------------------------------------
// Types (re-exported for backwards compatibility and convenience)
// -----------------------------------------------------------------------------

/** Supported Notion property types */
export type NotionPropertyType = PropertySchemaTag

/** Select/multi-select option */
export type SelectOption = SelectOptionConfig

/** Status group */
export type StatusGroup = StatusGroupConfig

/** Number format */
export type { NumberFormat }

/** Relation configuration */
export interface RelationConfig {
  readonly database_id: string
  readonly type: 'single_property' | 'dual_property'
  readonly single_property?: Record<string, never> | undefined
  readonly dual_property?:
    | {
        readonly synced_property_id: string
        readonly synced_property_name: string
      }
    | undefined
}

/** Rollup configuration */
export interface RollupConfig {
  readonly relation_property_name: string
  readonly relation_property_id: string
  readonly rollup_property_name: string
  readonly rollup_property_id: string
  readonly function: RollupFunction
}

/** Formula configuration */
export interface FormulaConfig {
  readonly expression: string
}

/** Introspected property information */
export interface PropertyInfo {
  readonly id: string
  readonly name: string
  readonly type: NotionPropertyType
  readonly description?: string | undefined
  readonly schema: PropertySchema
  readonly select?: { readonly options: readonly SelectOption[] }
  readonly multi_select?: { readonly options: readonly SelectOption[] }
  readonly status?: {
    readonly options: readonly SelectOption[]
    readonly groups: readonly StatusGroup[]
  }
  readonly relation?: RelationConfig
  readonly rollup?: RollupConfig
  readonly formula?: FormulaConfig
  readonly number?: { readonly format: NumberFormat }
}

/** Database introspection result */
export interface DatabaseInfo {
  readonly id: string
  readonly name: string
  readonly url: string
  readonly properties: readonly PropertyInfo[]
}

/** Property transform configuration - maps property names to transforms */
export type PropertyTransformConfig = Record<string, string>

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const sortByName = <TItem extends { name: string }>(items: readonly TItem[]): TItem[] =>
  items.toSorted((a, b) => a.name.localeCompare(b.name))

/** Convert PropertySchema to PropertyInfo */
const toPropertyInfo = (prop: PropertySchema): PropertyInfo => {
  const base: PropertyInfo = {
    id: prop.id,
    name: prop.name,
    type: prop._tag,
    description: prop.description ?? undefined,
    schema: prop,
  }

  switch (prop._tag) {
    case 'select':
      return { ...base, select: { options: sortByName(prop.select.options) } }
    case 'multi_select':
      return {
        ...base,
        multi_select: { options: sortByName(prop.multi_select.options) },
      }
    case 'status':
      return {
        ...base,
        status: {
          options: sortByName(prop.status.options),
          groups: prop.status.groups,
        },
      }
    case 'relation':
      return {
        ...base,
        relation: {
          database_id: prop.relation.database_id,
          type: prop.relation.type,
          single_property: prop.relation.single_property,
          dual_property: prop.relation.dual_property,
        },
      }
    case 'rollup':
      return {
        ...base,
        rollup: {
          relation_property_name: prop.rollup.relation_property_name,
          relation_property_id: prop.rollup.relation_property_id,
          rollup_property_name: prop.rollup.rollup_property_name,
          rollup_property_id: prop.rollup.rollup_property_id,
          function: prop.rollup.function,
        },
      }
    case 'formula':
      return { ...base, formula: { expression: prop.formula.expression } }
    case 'number':
      return { ...base, number: { format: prop.number.format } }
    default:
      return base
  }
}

// -----------------------------------------------------------------------------
// Introspection
// -----------------------------------------------------------------------------

/**
 * Introspect a Notion database and return its schema information.
 */
export const introspectDatabase = Effect.fnUntraced(function* (databaseId: string) {
  const db = yield* NotionDatabases.retrieve({ databaseId })

  const name = db.title.map((t) => t.plain_text).join('') || 'UnnamedDatabase'

  // In API 2026-03-11, properties live on the data source, not the database
  const firstDataSourceId = db.data_sources?.[0]?.id
  const propertiesSource =
    firstDataSourceId !== undefined
      ? yield* NotionDataSources.retrieve({ dataSourceId: firstDataSourceId })
      : db

  const typedProperties = SchemaHelpers.getProperties({ schema: propertiesSource })
  const properties = typedProperties.map(toPropertyInfo)

  return {
    id: db.id,
    name,
    url: db.url,
    properties,
  }
})
