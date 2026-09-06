import type {
  DatabaseInfo,
  NotionPropertyType,
  PropertyInfo,
  PropertyTransformConfig,
} from './introspect.ts'

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** Options for code generation */
export interface GenerateOptions {
  /** Include Write schemas for creating/updating pages */
  readonly includeWrite?: boolean
  /** Generate typed literal unions for select/status options */
  readonly typedOptions?: boolean
  /** Include Notion property metadata annotations */
  readonly schemaMeta?: boolean
  /** Property-specific transform configuration */
  readonly transforms?: PropertyTransformConfig
  /** Version of the generator CLI/package (included in generated header comment) */
  readonly generatorVersion?: string
  /** Generate a typed database API wrapper */
  readonly includeApi?: boolean
  /** Explicit schema name override (included in header if different from database name) */
  readonly schemaNameOverride?: string
}

/** Options for generating schema code */
export interface GenerateSchemaCodeOptions {
  /** Database info from introspection */
  readonly dbInfo: DatabaseInfo
  /** Name for the generated schema */
  readonly schemaName: string
  /** Additional generation options */
  readonly options?: GenerateOptions
}

/** Options for generating API code */
export interface GenerateApiCodeOptions {
  /** Database info from introspection */
  readonly dbInfo: DatabaseInfo
  /** Name for the generated schema */
  readonly schemaName: string
  /** The schema filename (e.g., 'artworks.gen.ts') for correct import path */
  readonly schemaFileName: string
  /** Additional generation options */
  readonly options?: GenerateOptions
}

// -----------------------------------------------------------------------------
// Transform Mappings
// -----------------------------------------------------------------------------

/** Available transforms for each property type */
export const PROPERTY_TRANSFORMS: Record<NotionPropertyType, readonly string[]> = {
  title: ['raw', 'asString'],
  rich_text: ['raw', 'asString', 'asOption'],
  number: ['raw', 'asNumber', 'asOption'],
  select: ['raw', 'asOption', 'asName'],
  multi_select: ['raw', 'asOptions', 'asNames'],
  status: ['raw', 'asName', 'asOption'],
  date: ['raw', 'asDate', 'asOption'],
  people: ['raw', 'asIds'],
  files: ['raw', 'asUrls'],
  checkbox: ['raw', 'asBoolean'],
  url: ['raw', 'asString', 'asOption'],
  email: ['raw', 'asString', 'asOption'],
  phone_number: ['raw', 'asString', 'asOption'],
  formula: ['raw', 'asBoolean', 'asDate', 'asNumber', 'asString'],
  relation: ['raw', 'asIds', 'asSingle', 'asSingleOption', 'asSingleId', 'asSingleIdOption'],
  rollup: ['raw', 'asArray', 'asBoolean', 'asDate', 'asNumber', 'asString'],
  created_time: ['raw', 'asDate'],
  created_by: ['raw'],
  last_edited_time: ['raw', 'asDate'],
  last_edited_by: ['raw'],
  unique_id: ['raw'],
  verification: ['raw'],
  button: ['raw'],
} as const

/** Default transform for each property type */
export const DEFAULT_TRANSFORMS: Record<NotionPropertyType, string> = {
  title: 'asString',
  rich_text: 'asOption',
  number: 'asOption',
  select: 'asOption',
  multi_select: 'asOptions',
  status: 'asOption',
  date: 'asOption',
  people: 'asIds',
  files: 'asUrls',
  checkbox: 'asBoolean',
  url: 'asOption',
  email: 'asOption',
  phone_number: 'asOption',
  formula: 'raw',
  relation: 'asIds',
  rollup: 'raw',
  created_time: 'asDate',
  created_by: 'raw',
  last_edited_time: 'asDate',
  last_edited_by: 'raw',
  unique_id: 'raw',
  verification: 'raw',
  button: 'raw',
}

/** Property type to NotionSchema transform mapping (read) */
export const NOTION_SCHEMA_TRANSFORM_KEYS: Partial<
  Record<NotionPropertyType, Record<string, string>>
> = {
  title: { raw: 'titleRaw', asString: 'title' },
  rich_text: {
    raw: 'richTextRaw',
    asString: 'richTextString',
    asOption: 'richTextOption',
  },
  number: { raw: 'numberRaw', asNumber: 'number', asOption: 'numberOption' },
  select: {
    raw: 'select.asNullable',
    asOption: 'select',
    asName: 'select.asName',
  },
  multi_select: {
    raw: 'multiSelect',
    asOptions: 'multiSelect',
    asNames: 'multiSelect.asNames',
  },
  status: {
    raw: 'status.asNullable',
    asName: 'status.asName',
    asOption: 'status',
  },
  date: { raw: 'dateRaw', asDate: 'dateDate', asOption: 'dateOption' },
  people: { raw: 'peopleRaw', asIds: 'peopleIds' },
  files: { raw: 'filesRaw', asUrls: 'filesUrls' },
  checkbox: { raw: 'checkboxRaw', asBoolean: 'checkbox' },
  url: { raw: 'urlRaw', asString: 'urlString', asOption: 'urlOption' },
  email: { raw: 'emailRaw', asString: 'emailString', asOption: 'emailOption' },
  phone_number: {
    raw: 'phoneNumberRaw',
    asString: 'phoneNumberString',
    asOption: 'phoneNumberOption',
  },
  formula: {
    raw: 'formulaRaw',
    asBoolean: 'formulaBoolean',
    asDate: 'formulaDate',
    asNumber: 'formulaNumber',
    asString: 'formulaString',
  },
  relation: {
    raw: 'relationProperty',
    asIds: 'relationIds',
    asSingle: 'relationSingle',
    asSingleOption: 'relationSingleOption',
    asSingleId: 'relationSingleId',
    asSingleIdOption: 'relationSingleIdOption',
  },
  rollup: {
    raw: 'rollupRaw',
    asArray: 'rollupArray',
    asBoolean: 'rollupBoolean',
    asDate: 'rollupDate',
    asNumber: 'rollupNumber',
    asString: 'rollupString',
  },
  created_time: { raw: 'createdTimeRaw', asDate: 'createdTimeDate' },
  created_by: { raw: 'createdByRaw', asId: 'createdById' },
  last_edited_time: { raw: 'lastEditedTimeRaw', asDate: 'lastEditedTimeDate' },
  last_edited_by: { raw: 'lastEditedByRaw', asId: 'lastEditedById' },
  unique_id: {
    raw: 'uniqueIdProperty',
    asString: 'uniqueIdString',
    asNumber: 'uniqueIdNumber',
  },
}

const ROLLUP_NUMBER_FUNCTIONS = new Set([
  'count',
  'count_values',
  'unique',
  'show_unique',
  'sum',
  'average',
  'median',
  'min',
  'max',
  'range',
  'percent_empty',
  'percent_not_empty',
  'percent_checked',
  'percent_unchecked',
])

const ROLLUP_BOOLEAN_FUNCTIONS = new Set(['empty', 'not_empty', 'checked', 'unchecked'])

const ROLLUP_DATE_FUNCTIONS = new Set(['earliest_date', 'latest_date', 'date_range'])

const inferRollupTransform = (property: PropertyInfo): string | undefined => {
  const fn = property.rollup?.function
  if (fn === undefined) return undefined

  if (fn === 'show_original') return 'asArray'
  if (ROLLUP_BOOLEAN_FUNCTIONS.has(fn) === true) return 'asBoolean'
  if (ROLLUP_DATE_FUNCTIONS.has(fn) === true) return 'asDate'
  if (ROLLUP_NUMBER_FUNCTIONS.has(fn) === true) return 'asNumber'

  return undefined
}

const inferDefaultTransform = (property: PropertyInfo): string => {
  if (property.type === 'rollup') {
    const rollupTransform = inferRollupTransform(property)
    if (rollupTransform !== undefined) return rollupTransform
  }

  return DEFAULT_TRANSFORMS[property.type] ?? 'raw'
}

/** Property type to NotionSchema write transform mapping */
const WRITE_TRANSFORM_KEYS: Partial<Record<NotionPropertyType, string>> = {
  title: 'titleWriteFromString',
  rich_text: 'richTextWriteFromString',
  number: 'numberWriteFromNumber',
  select: 'selectWriteFromName',
  multi_select: 'multiSelectWriteFromNames',
  status: 'statusWriteFromName',
  date: 'dateWriteFromStart',
  people: 'peopleWriteFromIds',
  files: 'filesWriteFromUrls',
  checkbox: 'checkboxWriteFromBoolean',
  url: 'urlWriteFromString',
  email: 'emailWriteFromString',
  phone_number: 'phoneNumberWriteFromString',
  relation: 'relationWriteFromIds',
}

/** Read-only property types (cannot be written) */
const READ_ONLY_PROPERTIES = new Set([
  'formula',
  'rollup',
  'created_time',
  'created_by',
  'last_edited_time',
  'last_edited_by',
  'unique_id',
  'verification',
  'button',
])

// -----------------------------------------------------------------------------
// Code Generation Helpers
// -----------------------------------------------------------------------------

/**
 * Convert a string to PascalCase, preserving existing casing for already-cased words.
 * Examples:
 * - "my-test-database" -> "MyTestDatabase"
 * - "TestDatabase" -> "TestDatabase" (preserved)
 * - "my test DB" -> "MyTestDb"
 */
const toPascalCase = (str: string): string => {
  // Split on non-alphanumeric characters
  const words = str.split(/[^a-zA-Z0-9]+/).filter(Boolean)

  return words
    .map((word) => {
      // If word is all uppercase and longer than 1 char, treat as acronym
      if (word.length > 1 && word === word.toUpperCase()) {
        return word.charAt(0) + word.slice(1).toLowerCase()
      }
      // If word already starts with uppercase, preserve it (likely already PascalCase)
      if (word.charAt(0) === word.charAt(0).toUpperCase() && word.length > 1) {
        return word
      }
      // Otherwise, capitalize first letter
      return word.charAt(0).toUpperCase() + word.slice(1)
    })
    .join('')
}

/**
 * Sanitize a property name for use as a TypeScript key
 */
const sanitizePropertyKey = (name: string): string => {
  // If it's a valid identifier, use it as-is
  if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name) === true) {
    return name
  }
  // Otherwise, quote it
  return toSingleQuotedStringLiteral(name)
}

/**
 * Sanitize an option name for use in a Schema.Literal
 */
const sanitizeLiteralValue = (name: string): string => {
  return toSingleQuotedStringLiteral(name)
}

const toSingleQuotedStringLiteral = (value: string): string => {
  const json = JSON.stringify(value)
  const inner = json.slice(1, -1)
  return `'${inner.replaceAll('\\"', '"').replaceAll("'", "\\'")}'`
}

const sanitizeLineComment = (comment: string): string =>
  comment.replaceAll('\r\n', ' ').replaceAll('\n', ' ').replaceAll('\r', ' ')

/**
 * Generate a valid TypeScript identifier from a property name
 */
const toIdentifier = (name: string): string => {
  return toPascalCase(name).replace(/[^a-zA-Z0-9_$]/g, '')
}

const toTopLevelIdentifier = (name: string): string => {
  const identifier = toIdentifier(name)
  if (/^[a-zA-Z_$]/.test(identifier) === true) {
    return identifier
  }
  return `_${identifier}`
}

const formatNotionSchemaCall = (options: { name: string; typeName?: string }): string =>
  `NotionSchema.${options.name}${options.typeName !== undefined ? `(${options.typeName})` : '()'}`

const formatMetaValue = (value: unknown): string => {
  if (value === null) return 'null'
  if (typeof value === 'string') return toSingleQuotedStringLiteral(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value) === true) {
    return `[${value.map(formatMetaValue).join(', ')}]`
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([key, val]) => `${key}: ${formatMetaValue(val)}`)
    return `{ ${entries.join(', ')} }`
  }
  return 'Schema.Unknown'
}

const normalizeOptionDescription = (description: string | null | undefined): string | null =>
  description ?? null

const normalizeSelectOptions = (
  options: readonly {
    id: string
    name: string
    color: string
    description?: string | null | undefined
  }[],
) =>
  options.map((option) => ({
    id: option.id,
    name: option.name,
    color: option.color,
    description: normalizeOptionDescription(option.description),
  }))

const normalizeStatusGroups = (
  groups: readonly {
    id: string
    name: string
    color: string
    option_ids: readonly string[]
  }[],
) =>
  groups.map((group) => ({
    id: group.id,
    name: group.name,
    color: group.color,
    option_ids: group.option_ids,
  }))

const buildPropertyMeta = (property: PropertyInfo): Record<string, unknown> => {
  const schema = property.schema
  const base = {
    _tag: schema._tag,
    id: schema.id,
    name: schema.name,
    description: normalizeOptionDescription(schema.description),
  }

  switch (schema._tag) {
    case 'number':
      return { ...base, number: { format: schema.number.format } }
    case 'select':
      return {
        ...base,
        select: { options: normalizeSelectOptions(schema.select.options) },
      }
    case 'multi_select':
      return {
        ...base,
        multi_select: {
          options: normalizeSelectOptions(schema.multi_select.options),
        },
      }
    case 'status':
      return {
        ...base,
        status: {
          options: normalizeSelectOptions(schema.status.options),
          groups: normalizeStatusGroups(schema.status.groups),
        },
      }
    case 'relation': {
      const relation: Record<string, unknown> = {
        database_id: schema.relation.database_id,
        type: schema.relation.type,
      }
      if (schema.relation.single_property !== undefined) {
        relation.single_property = schema.relation.single_property
      }
      if (schema.relation.dual_property !== undefined) {
        relation.dual_property = schema.relation.dual_property
      }
      return { ...base, relation }
    }
    case 'rollup':
      return {
        ...base,
        rollup: {
          relation_property_name: schema.rollup.relation_property_name,
          relation_property_id: schema.rollup.relation_property_id,
          rollup_property_name: schema.rollup.rollup_property_name,
          rollup_property_id: schema.rollup.rollup_property_id,
          function: schema.rollup.function,
        },
      }
    case 'formula':
      return { ...base, formula: { expression: schema.formula.expression } }
    case 'unique_id':
      return { ...base, unique_id: { prefix: schema.unique_id.prefix } }
    default:
      return base
  }
}

/** Generate the schema field expression for a property (read) */
const generatePropertyField = (options: {
  property: PropertyInfo
  transformConfig: PropertyTransformConfig
  typedOptions: { enabled: boolean; typeName?: string }
  schemaMeta: boolean
}): string => {
  const { property, transformConfig, typedOptions, schemaMeta } = options
  const transformKeys = NOTION_SCHEMA_TRANSFORM_KEYS[property.type]
  if (transformKeys === undefined) {
    return 'Schema.Unknown'
  }

  const configuredTransform = transformConfig[property.name]
  const availableTransforms = PROPERTY_TRANSFORMS[property.type] ?? ['raw']

  const defaultTransform = inferDefaultTransform(property)

  const transform =
    configuredTransform !== undefined && availableTransforms.includes(configuredTransform) === true
      ? configuredTransform
      : defaultTransform

  const typedOptionName = typedOptions.typeName
  if (property.type === 'select') {
    const base = formatNotionSchemaCall(
      typedOptionName !== undefined
        ? { name: 'select', typeName: typedOptionName }
        : { name: 'select' },
    )
    const metaSuffix =
      schemaMeta === true
        ? `.annotate({ [notionPropertyMeta]: ${formatMetaValue(buildPropertyMeta(property))} })`
        : ''
    if (transform === 'asName') {
      return `${base}.pipe(NotionSchema.asName)${metaSuffix}`
    }
    if (transform === 'raw') {
      return `${base}.pipe(NotionSchema.asNullable)${metaSuffix}`
    }
    return `${base}${metaSuffix}`
  }

  if (property.type === 'status') {
    const base = formatNotionSchemaCall(
      typedOptionName !== undefined
        ? { name: 'status', typeName: typedOptionName }
        : { name: 'status' },
    )
    const metaSuffix =
      schemaMeta === true
        ? `.annotate({ [notionPropertyMeta]: ${formatMetaValue(buildPropertyMeta(property))} })`
        : ''
    if (transform === 'asName') {
      return `${base}.pipe(NotionSchema.asName)${metaSuffix}`
    }
    if (transform === 'raw') {
      return `${base}.pipe(NotionSchema.asNullable)${metaSuffix}`
    }
    return `${base}${metaSuffix}`
  }

  if (property.type === 'multi_select') {
    const base = formatNotionSchemaCall(
      typedOptionName !== undefined
        ? { name: 'multiSelect', typeName: typedOptionName }
        : { name: 'multiSelect' },
    )
    const metaSuffix =
      schemaMeta === true
        ? `.annotate({ [notionPropertyMeta]: ${formatMetaValue(buildPropertyMeta(property))} })`
        : ''
    if (transform === 'asNames') {
      return `${base}.pipe(NotionSchema.asNames)${metaSuffix}`
    }
    return `${base}${metaSuffix}`
  }

  const transformKey = transformKeys[transform]
  if (transformKey === undefined) {
    return 'Schema.Unknown'
  }

  const value = `NotionSchema.${transformKey}`
  return schemaMeta === true
    ? `${value}.annotate({ [notionPropertyMeta]: ${formatMetaValue(buildPropertyMeta(property))} })`
    : value
}

/**
 * Generate the write schema field expression for a property
 */
const generateWritePropertyField = (property: PropertyInfo): string | null => {
  if (READ_ONLY_PROPERTIES.has(property.type) === true) {
    return null
  }

  const transformKey = WRITE_TRANSFORM_KEYS[property.type]
  if (transformKey === undefined) {
    return null
  }

  return `NotionSchema.${transformKey}`
}

// -----------------------------------------------------------------------------
// Typed Options Generation
// -----------------------------------------------------------------------------

/** Generate typed literal union for select/multi_select/status options */
const generateTypedOptions = (opts: {
  property: PropertyInfo
  pascalName: string
}): { typeName: string; code: string } | null => {
  const { property, pascalName } = opts
  let options: readonly { name: string }[] | undefined

  if (property.type === 'select' && property.select?.options !== undefined) {
    options = property.select.options
  } else if (property.type === 'multi_select' && property.multi_select?.options !== undefined) {
    options = property.multi_select.options
  } else if (property.type === 'status' && property.status?.options !== undefined) {
    options = property.status.options
  }

  if (options === undefined || options.length === 0) {
    return null
  }

  const propIdentifier = toIdentifier(property.name)
  const typeName = `${pascalName}${propIdentifier}Option`

  const literals = options
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .map((o) => sanitizeLiteralValue(o.name))
    .join(', ')

  const descPart =
    property.description !== undefined
      ? `,\n  description: ${toSingleQuotedStringLiteral(property.description)},`
      : ''
  const code = `export const ${typeName} = Schema.Literals([${literals}]).annotate({
  identifier: '${typeName}'${descPart}
})
export type ${typeName} = typeof ${typeName}.Type`

  return { typeName, code }
}

const parseGenerateOptions = (
  options: GenerateOptions | undefined,
): Required<
  Pick<GenerateOptions, 'includeWrite' | 'typedOptions' | 'includeApi' | 'schemaMeta'>
> & {
  transforms: PropertyTransformConfig
  generatorVersion?: string
  schemaNameOverride?: string
} => {
  if (options === undefined) {
    return {
      includeWrite: false,
      typedOptions: false,
      schemaMeta: true,
      includeApi: false,
      transforms: {},
    }
  }

  return {
    includeWrite: options.includeWrite ?? false,
    typedOptions: options.typedOptions ?? false,
    schemaMeta: options.schemaMeta ?? true,
    includeApi: options.includeApi ?? false,
    transforms: options.transforms ?? {},
    ...(options.generatorVersion !== undefined
      ? { generatorVersion: options.generatorVersion }
      : {}),
    ...(options.schemaNameOverride !== undefined
      ? { schemaNameOverride: options.schemaNameOverride }
      : {}),
  }
}

/**
 * Format a value for the config comment line.
 * Uses unquoted keys where possible for readability.
 */
const formatConfigValue = (value: unknown): string => {
  if (typeof value === 'boolean' || typeof value === 'number') {
    return String(value)
  }
  if (typeof value === 'string') {
    // Quote strings that need it (contain spaces, special chars, etc.)
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value) === true) {
      return value
    }
    return JSON.stringify(value)
  }
  if (typeof value === 'object' && value !== null) {
    if (Array.isArray(value) === true) {
      return `[${value.map(formatConfigValue).join(', ')}]`
    }
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => {
        const key = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k) === true ? k : JSON.stringify(k)
        return `${key}: ${formatConfigValue(v)}`
      })
    return `{ ${entries.join(', ')} }`
  }
  return String(value)
}

/**
 * Generate the @config comment line with generation options.
 */
const generateConfigComment = (options: {
  includeWrite: boolean
  typedOptions: boolean
  schemaMeta: boolean
  includeApi: boolean
  transforms: PropertyTransformConfig
  schemaNameOverride: string | undefined
}): string => {
  const config: Record<string, unknown> = {}

  if (options.schemaNameOverride !== undefined) {
    config.name = options.schemaNameOverride
  }
  if (options.includeWrite === true) {
    config.includeWrite = true
  }
  if (options.typedOptions === true) {
    config.typedOptions = true
  }
  if (options.includeApi === true) {
    config.includeApi = true
  }
  if (options.schemaMeta === false) {
    config.schemaMeta = false
  }
  if (Object.keys(options.transforms).length > 0) {
    config.transforms = options.transforms
  }

  if (Object.keys(config).length === 0) {
    return ''
  }

  return `// @config ${formatConfigValue(config)}`
}

// -----------------------------------------------------------------------------
// Main Code Generation
// -----------------------------------------------------------------------------

/** Generates TypeScript code for an Effect schema from database info */
// oxlint-disable-next-line eslint(func-style) -- public API
export function generateSchemaCode(opts: GenerateSchemaCodeOptions): string {
  const { dbInfo, schemaName, options } = opts
  const {
    includeWrite,
    typedOptions,
    schemaMeta,
    transforms,
    generatorVersion,
    schemaNameOverride,
  } = parseGenerateOptions(options)

  const pascalName = toTopLevelIdentifier(schemaName)

  // Generate typed options if enabled
  const typedOptionsDefs: Array<{
    property: PropertyInfo
    typeName: string
    code: string
  }> = []
  if (typedOptions === true) {
    for (const prop of dbInfo.properties) {
      const result = generateTypedOptions({ property: prop, pascalName })
      if (result !== null) {
        typedOptionsDefs.push({ property: prop, ...result })
      }
    }
  }
  const typedOptionsByPropertyName = new Map(
    typedOptionsDefs.map((def) => [def.property.name, def.typeName]),
  )

  // Generate read property fields
  const readPropertyFields = dbInfo.properties
    .map((prop) => {
      const key = sanitizePropertyKey(prop.name)
      const typeName = typedOptionsByPropertyName.get(prop.name)
      const field = generatePropertyField({
        property: prop,
        transformConfig: transforms,
        typedOptions: {
          enabled: typedOptions,
          ...(typeName !== undefined ? { typeName } : {}),
        },
        schemaMeta,
      })
      // Add JSDoc comment if description is available
      const jsdoc =
        prop.description !== undefined ? `  /** ${sanitizeLineComment(prop.description)} */\n` : ''
      return `${jsdoc}  ${key}: ${field},`
    })
    .join('\n')

  // Generate write property fields (excluding read-only)
  const writePropertyFields =
    includeWrite === true
      ? dbInfo.properties
          .map((prop) => {
            const writeField = generateWritePropertyField(prop)
            if (writeField === null) return null
            const key = sanitizePropertyKey(prop.name)
            // Add JSDoc comment if description is available
            const jsdoc =
              prop.description !== undefined
                ? `  /** ${sanitizeLineComment(prop.description)} */\n`
                : ''
            return `${jsdoc}  ${key}: ${writeField},`
          })
          .filter(Boolean)
          .join('\n')
      : ''

  // Build the config comment
  const configComment = generateConfigComment({
    includeWrite,
    typedOptions,
    schemaMeta,
    includeApi: options?.includeApi ?? false,
    transforms,
    schemaNameOverride,
  })

  // Build the code
  const lines: string[] = [
    `// AUTO-GENERATED FILE - DO NOT EDIT MANUALLY`,
    `// Generated by notion-effect-schema-gen${generatorVersion !== undefined ? ` v${generatorVersion}` : ''}`,
    `// Database: ${dbInfo.name}`,
    `// ID: ${dbInfo.id}`,
    `// URL: ${dbInfo.url}`,
    ...(configComment !== '' ? [configComment] : []),
    ``,
    `import { NotionSchema${schemaMeta === true ? ', notionPropertyMeta' : ''}, Schema } from '@overeng/notion-effect-schema'`,
  ]

  // Add typed options definitions
  if (typedOptionsDefs.length > 0) {
    lines.push(``)
    lines.push(`// -----------------------------------------------------------------------------`)
    lines.push(`// Typed Options`)
    lines.push(`// -----------------------------------------------------------------------------`)
    lines.push(``)
    for (const def of typedOptionsDefs) {
      lines.push(`/** Options for "${def.property.name}" property */`)
      lines.push(def.code)
      lines.push(``)
    }
  }

  // Read schema
  lines.push(``)
  lines.push(`// -----------------------------------------------------------------------------`)
  lines.push(`// Read Schema`)
  lines.push(`// -----------------------------------------------------------------------------`)
  lines.push(``)
  lines.push(`/**`)
  lines.push(` * Schema for reading pages from the "${dbInfo.name}" database.`)
  lines.push(` */`)
  lines.push(`export const ${pascalName}PageProperties = Schema.Struct({`)
  lines.push(readPropertyFields)
  lines.push(`}).annotate({`)
  lines.push(`  identifier: '${pascalName}PageProperties',`)
  lines.push(`  description: 'Read schema for ${dbInfo.name} database pages',`)
  lines.push(`})`)
  lines.push(``)
  lines.push(`export type ${pascalName}PageProperties = typeof ${pascalName}PageProperties.Type`)

  // Runtime validation helpers for read schema
  lines.push(``)
  lines.push(`/**`)
  lines.push(` * Decode properties from unknown data (throws on failure).`)
  lines.push(` */`)
  lines.push(
    `export const decode${pascalName}Properties = Schema.decodeUnknownSync(${pascalName}PageProperties)`,
  )
  lines.push(``)
  lines.push(`/**`)
  lines.push(` * Decode properties from unknown data (returns Effect).`)
  lines.push(` */`)
  lines.push(
    `export const decode${pascalName}PropertiesEffect = Schema.decodeUnknownEffect(${pascalName}PageProperties)`,
  )

  // Write schema (if enabled)
  if (includeWrite === true && writePropertyFields !== '') {
    lines.push(``)
    lines.push(`// -----------------------------------------------------------------------------`)
    lines.push(`// Write Schema`)
    lines.push(`// -----------------------------------------------------------------------------`)
    lines.push(``)
    lines.push(`/**`)
    lines.push(` * Schema for creating/updating pages in the "${dbInfo.name}" database.`)
    lines.push(` * Note: Read-only properties (formula, rollup, created_time, etc.) are excluded.`)
    lines.push(` */`)
    lines.push(`export const ${pascalName}PageWrite = Schema.Struct({`)
    lines.push(writePropertyFields)
    lines.push(`}).annotate({`)
    lines.push(`  identifier: '${pascalName}PageWrite',`)
    lines.push(`  description: 'Write schema for ${dbInfo.name} database pages',`)
    lines.push(`})`)
    lines.push(``)
    lines.push(`export type ${pascalName}PageWrite = typeof ${pascalName}PageWrite.Type`)

    // Runtime validation helpers for write schema
    lines.push(``)
    lines.push(`/**`)
    lines.push(` * Decode write data from simple types (throws on failure).`)
    lines.push(` */`)
    lines.push(
      `export const decode${pascalName}Write = Schema.decodeUnknownSync(${pascalName}PageWrite)`,
    )
    lines.push(``)
    lines.push(`/**`)
    lines.push(` * Decode write data from simple types (returns Effect).`)
    lines.push(` */`)
    lines.push(
      `export const decode${pascalName}WriteEffect = Schema.decodeUnknownEffect(${pascalName}PageWrite)`,
    )
    lines.push(``)
    lines.push(`/**`)
    lines.push(` * Encode write data back to simple types (throws on failure).`)
    lines.push(` */`)
    lines.push(`export const encode${pascalName}Write = Schema.encodeSync(${pascalName}PageWrite)`)
    lines.push(``)
    lines.push(`/**`)
    lines.push(` * Encode write data back to simple types (returns Effect).`)
    lines.push(` */`)
    lines.push(
      `export const encode${pascalName}WriteEffect = Schema.encodeEffect(${pascalName}PageWrite)`,
    )
  }

  lines.push(``)

  return lines.join('\n')
}

/** Get available transforms for a property type */
export const getAvailableTransforms = (propertyType: string): readonly string[] => {
  const isNotionPropertyType = (u: string): u is NotionPropertyType =>
    Object.hasOwn(PROPERTY_TRANSFORMS, u)

  if (isNotionPropertyType(propertyType) === true) {
    return PROPERTY_TRANSFORMS[propertyType] ?? ['raw']
  }
  return ['raw']
}

/** Get the default transform for a property type */
export const getDefaultTransform = (propertyType: string): string => {
  const isNotionPropertyType = (u: string): u is NotionPropertyType =>
    Object.hasOwn(DEFAULT_TRANSFORMS, u)

  if (isNotionPropertyType(propertyType) === true) {
    return DEFAULT_TRANSFORMS[propertyType] ?? 'raw'
  }
  return 'raw'
}

/** Check if a property type is read-only */
export const isReadOnlyProperty = (propertyType: string): boolean =>
  READ_ONLY_PROPERTIES.has(propertyType)

// -----------------------------------------------------------------------------
// API Code Generation
// -----------------------------------------------------------------------------

/** Generates TypeScript code for a typed database API wrapper */
// oxlint-disable-next-line eslint(func-style) -- public API
export function generateApiCode(opts: GenerateApiCodeOptions): string {
  const { dbInfo, schemaName, schemaFileName, options } = opts
  const {
    includeWrite,
    typedOptions,
    schemaMeta,
    transforms,
    generatorVersion,
    schemaNameOverride,
  } = parseGenerateOptions(options)

  const pascalName = toTopLevelIdentifier(schemaName)
  const schemaImportPath = `./${schemaFileName}`
  const generatedCodePrintWidth = 100
  const writeImport = `import { ${pascalName}PageProperties, type ${pascalName}PageWrite, encode${pascalName}Write } from '${schemaImportPath}'`
  const writeImportLines =
    writeImport.length <= generatedCodePrintWidth
      ? [writeImport]
      : [
          `import {`,
          `  ${pascalName}PageProperties,`,
          `  type ${pascalName}PageWrite,`,
          `  encode${pascalName}Write,`,
          `} from '${schemaImportPath}'`,
        ]
  const pageType = `export type ${pascalName}Page = TypedPage<${pascalName}PageProperties>`
  const pageTypeLines =
    pageType.length <= generatedCodePrintWidth
      ? [pageType]
      : [`export type ${pascalName}Page =`, `  TypedPage<${pascalName}PageProperties>`]
  const encodeCall = `    properties: encode${pascalName}Write(properties as ${pascalName}PageWrite),`
  const encodeCallLines =
    encodeCall.length <= generatedCodePrintWidth
      ? [encodeCall]
      : [
          `    properties: encode${pascalName}Write(`,
          `      properties as ${pascalName}PageWrite,`,
          `    ),`,
        ]

  // Build the config comment (same options as schema file, always includes includeApi: true)
  const configComment = generateConfigComment({
    includeWrite,
    typedOptions,
    schemaMeta,
    includeApi: true,
    transforms,
    schemaNameOverride,
  })

  const lines: string[] = [
    `// AUTO-GENERATED FILE - DO NOT EDIT MANUALLY`,
    `// Generated by notion-effect-schema-gen${generatorVersion !== undefined ? ` v${generatorVersion}` : ''}`,
    `// Database API wrapper for: ${dbInfo.name}`,
    `// ID: ${dbInfo.id}`,
    `// URL: ${dbInfo.url}`,
    ...(configComment !== '' ? [configComment] : []),
    ``,
    `import { Effect, Stream } from 'effect'`,
    ``,
    `import { NotionDatabases, NotionPages, type TypedPage } from '@overeng/notion-effect-client'`,
    ``,
    ...(includeWrite === true
      ? writeImportLines
      : [`import { ${pascalName}PageProperties } from '${schemaImportPath}'`]),
    ``,
    `/** Database ID for ${dbInfo.name} */`,
    `const DATABASE_ID = '${dbInfo.id}'`,
    ``,
    `// -----------------------------------------------------------------------------`,
    `// Query`,
    `// -----------------------------------------------------------------------------`,
    ``,
    `/** Query options */`,
    `export interface QueryOptions {`,
    `  readonly filter?: Record<string, unknown>`,
    `  readonly sorts?: ReadonlyArray<{`,
    `    readonly property?: string`,
    `    readonly timestamp?: 'created_time' | 'last_edited_time'`,
    `    readonly direction: 'ascending' | 'descending'`,
    `  }>`,
    `  readonly pageSize?: number`,
    `}`,
    ``,
    `/**`,
    ` * Query pages from the ${dbInfo.name} database.`,
    ` *`,
    ` * Returns a stream of typed pages with automatic pagination.`,
    ` */`,
    `export const query = (options?: QueryOptions) =>`,
    `  Stream.unwrap(`,
    `    NotionDatabases.resolveQueryTarget({ databaseId: DATABASE_ID }).pipe(`,
    `      Effect.map((queryTarget) =>`,
    `        NotionDatabases.queryStream({`,
    `          dataSourceId: queryTarget.dataSourceId,`,
    `          schema: ${pascalName}PageProperties,`,
    `          ...options,`,
    `        }),`,
    `      ),`,
    `    ),`,
    `  )`,
    ``,
    `/**`,
    ` * Query pages and collect all results.`,
    ` */`,
    `export const queryAll = (options?: QueryOptions) => query(options).pipe(Stream.runCollect)`,
    ``,
    `// -----------------------------------------------------------------------------`,
    `// Get`,
    `// -----------------------------------------------------------------------------`,
    ``,
    `/**`,
    ` * Get a single page by ID.`,
    ` */`,
    `export const get = (pageId: string) =>`,
    `  NotionPages.retrieve({`,
    `    pageId,`,
    `    schema: ${pascalName}PageProperties,`,
    `  })`,
    ``,
    ...pageTypeLines,
  ]

  // Add create/update if write schema is enabled
  if (includeWrite === true) {
    lines.push(``)
    lines.push(`// -----------------------------------------------------------------------------`)
    lines.push(`// Create`)
    lines.push(`// -----------------------------------------------------------------------------`)
    lines.push(``)
    lines.push(`/**`)
    lines.push(` * Create a new page in the ${dbInfo.name} database.`)
    lines.push(` */`)
    lines.push(`export const create = (properties: ${pascalName}PageWrite) =>`)
    lines.push(`  NotionPages.create({`)
    lines.push(`    parent: { type: 'database_id', database_id: DATABASE_ID },`)
    lines.push(`    properties: encode${pascalName}Write(properties),`)
    lines.push(`  })`)
    lines.push(``)
    lines.push(`// -----------------------------------------------------------------------------`)
    lines.push(`// Update`)
    lines.push(`// -----------------------------------------------------------------------------`)
    lines.push(``)
    lines.push(`/**`)
    lines.push(` * Update an existing page.`)
    lines.push(` */`)
    const updateSignature = `export const update = (pageId: string, properties: Partial<${pascalName}PageWrite>) =>`
    if (updateSignature.length <= generatedCodePrintWidth) {
      lines.push(updateSignature)
    } else {
      lines.push(`export const update = (`)
      lines.push(`  pageId: string,`)
      lines.push(`  properties: Partial<${pascalName}PageWrite>,`)
      lines.push(`) =>`)
    }
    lines.push(`  NotionPages.update({`)
    lines.push(`    pageId,`)
    lines.push(...encodeCallLines)
    lines.push(`  })`)
  }

  lines.push(``)
  lines.push(`// -----------------------------------------------------------------------------`)
  lines.push(`// Archive`)
  lines.push(`// -----------------------------------------------------------------------------`)
  lines.push(``)
  lines.push(`/**`)
  lines.push(` * Archive (soft-delete) a page.`)
  lines.push(` */`)
  lines.push(`export const archive = (pageId: string) => NotionPages.archive({ pageId })`)
  lines.push(``)

  return lines.join('\n')
}
