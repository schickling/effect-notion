import React, { createContext, useContext, useMemo } from 'react'
import type { FC, ReactNode } from 'react'

import {
  type SchemaAnnotations,
  type SchemaInfo,
  type SchemaRegistry,
  type SchemaView,
  getAnnotations,
  getFieldSchema,
  getArrayElementSchema,
  createSchemaRegistry,
  registerSchema,
  lookupSchema,
  formatWithPretty,
  getDisplayName,
  getSchemaInfo,
  narrowUnionByTag,
} from './effectSchema.tsx'

export interface SchemaContextValue {
  /** The current schema for the data being inspected */
  schema: SchemaView | undefined
  /** The root schema (stays constant during tree traversal) */
  rootSchema: SchemaView | undefined
  /** Registry of schemas for looking up by constructor name */
  registry: SchemaRegistry
  /** Get annotations for the current schema */
  getAnnotations: () => SchemaAnnotations
  /** Get display name for the current value (from schema annotations) */
  getDisplayName: () => string | undefined
  /** Get description for the current value (from schema annotations) */
  getDescription: () => string | undefined
  /** Get the full display-ready schema info bundle for the current schema */
  getSchemaInfo: () => SchemaInfo | undefined
  /** Format a value using schema's pretty annotation */
  formatValue: (value: unknown) => string | undefined
  /** Get schema context for a child field */
  getFieldContext: (fieldName: string) => SchemaContextValue
  /** Get schema context for array elements */
  getElementContext: () => SchemaContextValue
  /** Look up a schema by name from registry */
  lookupByName: (name: string) => SchemaView | undefined
  /** Get schema for a path like "$.address.street" or "$[0].name" */
  getSchemaForPath: (path: string) => SchemaView | undefined
  /** Get schema context for a path */
  getContextForPath: (path: string) => SchemaContextValue
  /**
   * Like {@link getContextForPath}, but also narrows tagged unions on the
   * leaf using the runtime value's `_tag`. Callers that have the rendered
   * value in scope should prefer this so tooltips, display names, and
   * container labels reflect the matched union member rather than the
   * union as a whole.
   *
   * @see https://github.com/overengineeringstudio/effect-utils/issues/686
   */
  getContextForPathWithValue: (path: string, value: unknown) => SchemaContextValue
}

const defaultContextValue: SchemaContextValue = {
  schema: undefined,
  rootSchema: undefined,
  registry: createSchemaRegistry(),
  getAnnotations: () => ({}),
  getDisplayName: () => undefined,
  getDescription: () => undefined,
  getSchemaInfo: () => undefined,
  formatValue: () => undefined,
  getFieldContext: () => defaultContextValue,
  getElementContext: () => defaultContextValue,
  lookupByName: () => undefined,
  getSchemaForPath: () => undefined,
  getContextForPath: () => defaultContextValue,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- signature stays in sync with the runtime variant
  getContextForPathWithValue: (_path: string, _value: unknown) => defaultContextValue,
}

const SchemaContext = createContext<SchemaContextValue>(defaultContextValue)

export interface SchemaProviderProps {
  children: ReactNode
  /** Schema for the data being inspected */
  schema?: SchemaView | undefined
  /** Additional schemas to register for lookup by name */
  schemas?: ReadonlyArray<SchemaView> | undefined
  /**
   * Root runtime value being inspected. When provided, path-based context
   * lookups walk the value in lockstep with the schema and narrow any
   * intermediate tagged-union (`Schema.Union([A, B, C])` with `_tag`
   * literals) to the matching variant. Without this, only the leaf union
   * gets narrowed.
   *
   * @see https://github.com/overengineeringstudio/effect-utils/issues/686
   */
  rootData?: unknown
}

/**
 * Parse a TreeView path into segments.
 * Paths look like: "$", "$.address", "$.items.0", "$.items.0.name"
 */
const parsePathSegments = (path: string): string[] => {
  if (path === '$') return []
  // Remove leading "$." and split by "."
  const withoutRoot = path.startsWith('$.') === true ? path.slice(2) : path.slice(1)
  return withoutRoot.split('.')
}

/**
 * Resolve a schema by traversing path segments from root schema.
 *
 * When `rootData` is provided, the resolver walks the runtime value in
 * lockstep with the schema and narrows any intermediate `Schema.Union(...)`
 * by the runtime `_tag`. Without this, nested fields under a tagged union
 * (e.g. `$.event.changedFields`) would resolve against the union as a whole
 * and miss the variant-specific child schemas.
 *
 * @see https://github.com/overengineeringstudio/effect-utils/issues/686
 */
const resolveSchemaForSegments = (
  rootSchema: SchemaView | undefined,
  segments: string[],
  rootData: unknown,
  hasData: boolean,
): SchemaView | undefined => {
  if (rootSchema === undefined) return undefined
  let current: SchemaView | undefined = rootSchema
  let value: unknown = rootData

  for (const segment of segments) {
    if (current === undefined) return undefined

    if (hasData === true) {
      const narrowedAst = narrowUnionByTag(current.ast, value)
      if (narrowedAst !== current.ast) {
        current = { ast: narrowedAst }
      }
    }

    // Check if segment is a numeric index (array access)
    if (/^\d+$/.test(segment) === true) {
      current = getArrayElementSchema(current)
      if (hasData === true && Array.isArray(value) === true) {
        value = (value as ReadonlyArray<unknown>)[Number(segment)]
      } else if (hasData === true) {
        value = undefined
      }
    } else {
      current = getFieldSchema(current, segment)
      if (hasData === true && value !== null && typeof value === 'object' && segment in value) {
        value = (value as Record<string, unknown>)[segment]
      } else if (hasData === true) {
        value = undefined
      }
    }
  }

  return current
}

/** Create a context value for a given schema and registry */
const createContextValue = (
  schema: SchemaView | undefined,
  registry: SchemaRegistry,
  rootSchema: SchemaView | undefined,
  rootDataHolder: { hasData: boolean; data: unknown },
): SchemaContextValue => {
  const effectiveRootSchema = rootSchema ?? schema

  const ctx: SchemaContextValue = {
    schema,
    rootSchema: effectiveRootSchema,
    registry,
    getAnnotations: () => (schema !== undefined ? getAnnotations(schema) : {}),
    getDisplayName: () =>
      schema !== undefined ? getDisplayName(getAnnotations(schema)) : undefined,
    getDescription: () => (schema !== undefined ? getAnnotations(schema).description : undefined),
    getSchemaInfo: () => (schema !== undefined ? getSchemaInfo(schema) : undefined),
    formatValue: (value: unknown) =>
      schema !== undefined ? formatWithPretty(value, getAnnotations(schema)) : undefined,
    getFieldContext: (fieldName: string) => {
      if (schema === undefined)
        return createContextValue(undefined, registry, effectiveRootSchema, rootDataHolder)
      const fieldSchema = getFieldSchema(schema, fieldName)
      return createContextValue(fieldSchema, registry, effectiveRootSchema, rootDataHolder)
    },
    getElementContext: () => {
      if (schema === undefined)
        return createContextValue(undefined, registry, effectiveRootSchema, rootDataHolder)
      const elementSchema = getArrayElementSchema(schema)
      return createContextValue(elementSchema, registry, effectiveRootSchema, rootDataHolder)
    },
    lookupByName: (name: string) => lookupSchema(registry, name),
    getSchemaForPath: (path: string) => {
      const segments = parsePathSegments(path)
      return resolveSchemaForSegments(
        effectiveRootSchema,
        segments,
        rootDataHolder.data,
        rootDataHolder.hasData,
      )
    },
    getContextForPath: (path: string) => {
      const segments = parsePathSegments(path)
      const pathSchema = resolveSchemaForSegments(
        effectiveRootSchema,
        segments,
        rootDataHolder.data,
        rootDataHolder.hasData,
      )
      return createContextValue(pathSchema, registry, effectiveRootSchema, rootDataHolder)
    },
    getContextForPathWithValue: (path: string, value: unknown) => {
      const segments = parsePathSegments(path)
      const pathSchema = resolveSchemaForSegments(
        effectiveRootSchema,
        segments,
        rootDataHolder.data,
        rootDataHolder.hasData,
      )
      if (pathSchema === undefined) {
        return createContextValue(undefined, registry, effectiveRootSchema, rootDataHolder)
      }
      const narrowedAst = narrowUnionByTag(pathSchema.ast, value)
      const narrowedSchema = narrowedAst === pathSchema.ast ? pathSchema : { ast: narrowedAst }
      return createContextValue(narrowedSchema, registry, effectiveRootSchema, rootDataHolder)
    },
  }

  return ctx
}

const EMPTY_SCHEMAS: ReadonlyArray<SchemaView> = Object.freeze([])

export const SchemaProvider: FC<SchemaProviderProps> = ({
  children,
  schema,
  schemas = EMPTY_SCHEMAS,
  rootData,
}) => {
  const hasData = rootData !== undefined
  const value = useMemo(() => {
    const registry = createSchemaRegistry()

    if (schema !== undefined) {
      registerSchema(registry, schema)
    }

    for (const s of schemas) {
      registerSchema(registry, s)
    }

    return createContextValue(schema, registry, undefined, { hasData, data: rootData })
  }, [schema, schemas, hasData, rootData])

  return <SchemaContext.Provider value={value}>{children}</SchemaContext.Provider>
}

export const useSchemaContext = (): SchemaContextValue => {
  return useContext(SchemaContext)
}

/** Hook to get schema-derived display info for a value */
export const useSchemaDisplayInfo = (
  value: unknown,
  fieldName?: string,
): {
  displayName: string | undefined
  formattedValue: string | undefined
  hasSchema: boolean
} => {
  const ctx = useSchemaContext()

  const effectiveCtx = fieldName !== undefined ? ctx.getFieldContext(fieldName) : ctx

  const displayName = effectiveCtx.getDisplayName()
  const formattedValue = effectiveCtx.formatValue(value)

  return {
    displayName,
    formattedValue,
    hasSchema: effectiveCtx.schema !== undefined,
  }
}
