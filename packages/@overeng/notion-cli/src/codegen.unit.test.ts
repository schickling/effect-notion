import { describe, expect, it } from 'vitest'

import type { PropertySchema } from '@overeng/notion-effect-schema'

import {
  generateApiCode,
  generateSchemaCode,
  getAvailableTransforms,
  getDefaultTransform,
  isReadOnlyProperty,
  PROPERTY_TRANSFORMS,
} from './codegen.ts'
import type { DatabaseInfo, NotionPropertyType, PropertyInfo } from './introspect.ts'

const makeProperty = (info: Omit<PropertyInfo, 'schema'>): PropertyInfo => {
  const description = info.description ?? null

  const schemaBase = {
    id: info.id,
    name: info.name,
    description,
  }

  const schema: PropertySchema = (() => {
    switch (info.type) {
      case 'number':
        return {
          ...schemaBase,
          _tag: 'number',
          number: { format: info.number?.format ?? 'number' },
        }
      case 'select':
        return {
          ...schemaBase,
          _tag: 'select',
          select: { options: info.select?.options ?? [] },
        }
      case 'multi_select':
        return {
          ...schemaBase,
          _tag: 'multi_select',
          multi_select: { options: info.multi_select?.options ?? [] },
        }
      case 'status':
        return {
          ...schemaBase,
          _tag: 'status',
          status: {
            options: info.status?.options ?? [],
            groups: info.status?.groups ?? [],
          },
        }
      case 'relation':
        return {
          ...schemaBase,
          _tag: 'relation',
          relation: {
            database_id: info.relation?.database_id ?? 'db',
            type: info.relation?.type ?? 'single_property',
            single_property: info.relation?.single_property ?? {},
            ...(info.relation?.dual_property !== undefined
              ? { dual_property: info.relation.dual_property }
              : {}),
          },
        }
      case 'rollup':
        return {
          ...schemaBase,
          _tag: 'rollup',
          rollup: {
            relation_property_name: info.rollup?.relation_property_name ?? 'Relation',
            relation_property_id: info.rollup?.relation_property_id ?? 'relation',
            rollup_property_name: info.rollup?.rollup_property_name ?? 'Rollup',
            rollup_property_id: info.rollup?.rollup_property_id ?? 'rollup',
            function: info.rollup?.function ?? 'count',
          },
        }
      case 'formula':
        return {
          ...schemaBase,
          _tag: 'formula',
          formula: { expression: info.formula?.expression ?? '' },
        }
      case 'unique_id':
        return {
          ...schemaBase,
          _tag: 'unique_id',
          unique_id: { prefix: null },
        }
      default:
        return { ...schemaBase, _tag: info.type }
    }
  })()

  return { ...info, schema }
}

describe('codegen', () => {
  describe('generateApiCode', () => {
    it('resolves the query target at runtime', () => {
      const dbInfo: DatabaseInfo = {
        id: 'test-db-id',
        name: 'Test Database',
        url: 'https://notion.so/test-db',
        properties: (
          [{ id: 'title-prop', name: 'Name', type: 'title' }] satisfies Array<
            Omit<PropertyInfo, 'schema'>
          >
        ).map(makeProperty),
      }

      const code = generateApiCode({
        dbInfo,
        schemaName: 'TestDatabase',
        schemaFileName: 'test-database.gen.ts',
      })

      expect(code).toContain(`import { Effect, Stream } from 'effect'`)
      expect(code).toContain(`NotionDatabases.resolveQueryTarget({ databaseId: DATABASE_ID })`)
      expect(code).toContain(`dataSourceId: queryTarget.dataSourceId`)
    })

    it('uses the exported write type alias instead of typeof', () => {
      const dbInfo: DatabaseInfo = {
        id: 'test-db-id',
        name: 'Test Database',
        url: 'https://notion.so/test-db',
        properties: (
          [{ id: 'title-prop', name: 'Name', type: 'title' }] satisfies Array<
            Omit<PropertyInfo, 'schema'>
          >
        ).map(makeProperty),
      }

      const code = generateApiCode({
        dbInfo,
        schemaName: 'TestDatabase',
        schemaFileName: 'test-database.gen.ts',
        options: { includeWrite: true },
      })

      expect(code).not.toContain(`typeof TestDatabasePageWrite.Type`)
      expect(code).toContain(`export const create = (properties: TestDatabasePageWrite) =>`)
      expect(code).toContain(
        `export const update = (pageId: string, properties: Partial<TestDatabasePageWrite>) =>`,
      )
      expect(code).toContain(
        `    properties: encodeTestDatabaseWrite(properties as TestDatabasePageWrite),`,
      )
    })

    it('imports the write type with a type-only specifier', () => {
      const dbInfo: DatabaseInfo = {
        id: 'pdf-db-id',
        name: 'PDF Document',
        url: 'https://notion.so/pdf-document',
        properties: (
          [{ id: 'title-prop', name: 'Name', type: 'title' }] satisfies Array<
            Omit<PropertyInfo, 'schema'>
          >
        ).map(makeProperty),
      }

      const code = generateApiCode({
        dbInfo,
        schemaName: 'PDF Document',
        schemaFileName: 'pdf-document.gen.ts',
        options: { includeWrite: true },
      })

      // `PdfDocumentPageWrite` only ever appears in type positions, so it must be
      // imported with a `type` specifier (verbatimModuleSyntax / consistent-type-imports).
      expect(code).toContain(`import { Effect, Stream } from 'effect'

import { NotionDatabases, NotionPages, type TypedPage } from '@overeng/notion-effect-client'

import {
  PdfDocumentPageProperties,
  type PdfDocumentPageWrite,
  encodePdfDocumentWrite,
} from './pdf-document.gen.ts'`)
      expect(code).toContain(
        `export const queryAll = (options?: QueryOptions) => query(options).pipe(Stream.runCollect)`,
      )
      expect(code).toContain(
        `export const update = (pageId: string, properties: Partial<PdfDocumentPageWrite>) =>`,
      )
      expect(code).toContain(
        `export const archive = (pageId: string) => NotionPages.archive({ pageId })`,
      )
      // Schemas and encoders stay value imports.
      expect(code).toContain(`schema: PdfDocumentPageProperties,`)
      expect(code).toContain(`properties: encodePdfDocumentWrite(properties),`)
    })
    it('selects generated layouts that match the shared 100-column print width', () => {
      const dbInfo: DatabaseInfo = {
        id: 'test-db-id',
        name: 'Test',
        url: 'https://notion.so/test',
        properties: (
          [{ id: 'title-prop', name: 'Name', type: 'title' }] satisfies Array<
            Omit<PropertyInfo, 'schema'>
          >
        ).map(makeProperty),
      }

      const shortCode = generateApiCode({
        dbInfo,
        schemaName: 'Test',
        schemaFileName: 'test.gen.ts',
        options: { includeWrite: true },
      })
      const longCode = generateApiCode({
        dbInfo,
        schemaName: 'Engineering Onboarding Checklist',
        schemaFileName: 'engineering-onboarding-checklist.gen.ts',
        options: { includeWrite: true },
      })

      expect(shortCode).toContain(
        `import { TestPageProperties, type TestPageWrite, encodeTestWrite } from './test.gen.ts'`,
      )
      expect(longCode).toContain(`export const update = (
  pageId: string,
  properties: Partial<EngineeringOnboardingChecklistPageWrite>,
) =>`)
      expect(longCode).toContain(`export type EngineeringOnboardingChecklistPage =
  TypedPage<EngineeringOnboardingChecklistPageProperties>`)
      expect(longCode).toContain(`    properties: encodeEngineeringOnboardingChecklistWrite(
      properties as EngineeringOnboardingChecklistPageWrite,
    ),`)
    })
  })

  describe('generateSchemaCode', () => {
    it('should generate basic schema for a simple database', () => {
      const dbInfo: DatabaseInfo = {
        id: 'test-db-id',
        name: 'Test Database',
        url: 'https://notion.so/test-db',
        properties: (
          [
            { id: 'title-prop', name: 'Name', type: 'title' },
            { id: 'text-prop', name: 'Description', type: 'rich_text' },
            { id: 'num-prop', name: 'Count', type: 'number' },
            { id: 'check-prop', name: 'Done', type: 'checkbox' },
          ] satisfies Array<Omit<PropertyInfo, 'schema'>>
        ).map(makeProperty),
      }

      const code = generateSchemaCode({ dbInfo, schemaName: 'TestDatabase' })

      expect(code).toMatchInlineSnapshot(`
        "// AUTO-GENERATED FILE - DO NOT EDIT MANUALLY
        // Generated by notion-effect-schema-gen
        // Database: Test Database
        // ID: test-db-id
        // URL: https://notion.so/test-db

        import { NotionSchema, notionPropertyMeta, Schema } from '@overeng/notion-effect-schema'

        // -----------------------------------------------------------------------------
        // Read Schema
        // -----------------------------------------------------------------------------

        /**
         * Schema for reading pages from the "Test Database" database.
         */
        export const TestDatabasePageProperties = Schema.Struct({
          Name: NotionSchema.title.annotate({ [notionPropertyMeta]: { _tag: 'title', id: 'title-prop', name: 'Name', description: null } }),
          Description: NotionSchema.richTextOption.annotate({ [notionPropertyMeta]: { _tag: 'rich_text', id: 'text-prop', name: 'Description', description: null } }),
          Count: NotionSchema.numberOption.annotate({ [notionPropertyMeta]: { _tag: 'number', id: 'num-prop', name: 'Count', description: null, number: { format: 'number' } } }),
          Done: NotionSchema.checkbox.annotate({ [notionPropertyMeta]: { _tag: 'checkbox', id: 'check-prop', name: 'Done', description: null } }),
        }).annotate({
          identifier: 'TestDatabasePageProperties',
          description: 'Read schema for Test Database database pages',
        })

        export type TestDatabasePageProperties = typeof TestDatabasePageProperties.Type

        /**
         * Decode properties from unknown data (throws on failure).
         */
        export const decodeTestDatabaseProperties = Schema.decodeUnknownSync(TestDatabasePageProperties)

        /**
         * Decode properties from unknown data (returns Effect).
         */
        export const decodeTestDatabasePropertiesEffect = Schema.decodeUnknownEffect(TestDatabasePageProperties)
        "
      `)
    })

    it('should include generator version when provided', () => {
      const dbInfo: DatabaseInfo = {
        id: 'test-db-id',
        name: 'Test Database',
        url: 'https://notion.so/test-db',
        properties: (
          [{ id: 'title-prop', name: 'Name', type: 'title' }] satisfies Array<
            Omit<PropertyInfo, 'schema'>
          >
        ).map(makeProperty),
      }

      const code = generateSchemaCode({
        dbInfo,
        schemaName: 'TestDatabase',
        options: { generatorVersion: '0.1.0' },
      })

      expect(code).toMatchInlineSnapshot(`
        "// AUTO-GENERATED FILE - DO NOT EDIT MANUALLY
        // Generated by notion-effect-schema-gen v0.1.0
        // Database: Test Database
        // ID: test-db-id
        // URL: https://notion.so/test-db

        import { NotionSchema, notionPropertyMeta, Schema } from '@overeng/notion-effect-schema'

        // -----------------------------------------------------------------------------
        // Read Schema
        // -----------------------------------------------------------------------------

        /**
         * Schema for reading pages from the "Test Database" database.
         */
        export const TestDatabasePageProperties = Schema.Struct({
          Name: NotionSchema.title.annotate({ [notionPropertyMeta]: { _tag: 'title', id: 'title-prop', name: 'Name', description: null } }),
        }).annotate({
          identifier: 'TestDatabasePageProperties',
          description: 'Read schema for Test Database database pages',
        })

        export type TestDatabasePageProperties = typeof TestDatabasePageProperties.Type

        /**
         * Decode properties from unknown data (throws on failure).
         */
        export const decodeTestDatabaseProperties = Schema.decodeUnknownSync(TestDatabasePageProperties)

        /**
         * Decode properties from unknown data (returns Effect).
         */
        export const decodeTestDatabasePropertiesEffect = Schema.decodeUnknownEffect(TestDatabasePageProperties)
        "
      `)
    })

    it('should handle property names with special characters', () => {
      const dbInfo: DatabaseInfo = {
        id: 'test-db-id',
        name: 'Test',
        url: 'https://notion.so/test',
        properties: (
          [
            { id: 'prop1', name: 'Due Date', type: 'date' },
            { id: 'prop2', name: 'Project Name', type: 'title' },
            { id: 'prop3', name: "User's Choice", type: 'select' },
          ] satisfies Array<Omit<PropertyInfo, 'schema'>>
        ).map(makeProperty),
      }

      const code = generateSchemaCode({ dbInfo, schemaName: 'Test' })

      expect(code).toMatchInlineSnapshot(`
        "// AUTO-GENERATED FILE - DO NOT EDIT MANUALLY
        // Generated by notion-effect-schema-gen
        // Database: Test
        // ID: test-db-id
        // URL: https://notion.so/test

        import { NotionSchema, notionPropertyMeta, Schema } from '@overeng/notion-effect-schema'

        // -----------------------------------------------------------------------------
        // Read Schema
        // -----------------------------------------------------------------------------

        /**
         * Schema for reading pages from the "Test" database.
         */
        export const TestPageProperties = Schema.Struct({
          'Due Date': NotionSchema.dateOption.annotate({ [notionPropertyMeta]: { _tag: 'date', id: 'prop1', name: 'Due Date', description: null } }),
          'Project Name': NotionSchema.title.annotate({ [notionPropertyMeta]: { _tag: 'title', id: 'prop2', name: 'Project Name', description: null } }),
          'User\\'s Choice': NotionSchema.select().annotate({ [notionPropertyMeta]: { _tag: 'select', id: 'prop3', name: 'User\\'s Choice', description: null, select: { options: [] } } }),
        }).annotate({
          identifier: 'TestPageProperties',
          description: 'Read schema for Test database pages',
        })

        export type TestPageProperties = typeof TestPageProperties.Type

        /**
         * Decode properties from unknown data (throws on failure).
         */
        export const decodeTestProperties = Schema.decodeUnknownSync(TestPageProperties)

        /**
         * Decode properties from unknown data (returns Effect).
         */
        export const decodeTestPropertiesEffect = Schema.decodeUnknownEffect(TestPageProperties)
        "
      `)
    })

    it('should respect custom transform configuration', () => {
      const dbInfo: DatabaseInfo = {
        id: 'test-db-id',
        name: 'Test',
        url: 'https://notion.so/test',
        properties: (
          [
            { id: 'prop1', name: 'Status', type: 'select' },
            { id: 'prop2', name: 'Tags', type: 'multi_select' },
            { id: 'prop3', name: 'Website', type: 'url' },
          ] satisfies Array<Omit<PropertyInfo, 'schema'>>
        ).map(makeProperty),
      }

      const code = generateSchemaCode({
        dbInfo,
        schemaName: 'Test',
        options: {
          transforms: { Status: 'raw', Tags: 'raw', Website: 'asString' },
        },
      })

      expect(code).toMatchInlineSnapshot(`
        "// AUTO-GENERATED FILE - DO NOT EDIT MANUALLY
        // Generated by notion-effect-schema-gen
        // Database: Test
        // ID: test-db-id
        // URL: https://notion.so/test
        // @config { transforms: { Status: raw, Tags: raw, Website: asString } }

        import { NotionSchema, notionPropertyMeta, Schema } from '@overeng/notion-effect-schema'

        // -----------------------------------------------------------------------------
        // Read Schema
        // -----------------------------------------------------------------------------

        /**
         * Schema for reading pages from the "Test" database.
         */
        export const TestPageProperties = Schema.Struct({
          Status: NotionSchema.select().pipe(NotionSchema.asNullable).annotate({ [notionPropertyMeta]: { _tag: 'select', id: 'prop1', name: 'Status', description: null, select: { options: [] } } }),
          Tags: NotionSchema.multiSelect().annotate({ [notionPropertyMeta]: { _tag: 'multi_select', id: 'prop2', name: 'Tags', description: null, multi_select: { options: [] } } }),
          Website: NotionSchema.urlString.annotate({ [notionPropertyMeta]: { _tag: 'url', id: 'prop3', name: 'Website', description: null } }),
        }).annotate({
          identifier: 'TestPageProperties',
          description: 'Read schema for Test database pages',
        })

        export type TestPageProperties = typeof TestPageProperties.Type

        /**
         * Decode properties from unknown data (throws on failure).
         */
        export const decodeTestProperties = Schema.decodeUnknownSync(TestPageProperties)

        /**
         * Decode properties from unknown data (returns Effect).
         */
        export const decodeTestPropertiesEffect = Schema.decodeUnknownEffect(TestPageProperties)
        "
      `)
    })

    it('should fall back to default transform for invalid config', () => {
      const dbInfo: DatabaseInfo = {
        id: 'test-db-id',
        name: 'Test',
        url: 'https://notion.so/test',
        properties: (
          [{ id: 'prop1', name: 'Status', type: 'select' }] satisfies Array<
            Omit<PropertyInfo, 'schema'>
          >
        ).map(makeProperty),
      }

      const code = generateSchemaCode({
        dbInfo,
        schemaName: 'Test',
        options: {
          transforms: { Status: 'invalidTransform' },
        },
      })

      expect(code).toContain('Status: NotionSchema.select()')
    })

    it('should convert name to PascalCase', () => {
      const dbInfo: DatabaseInfo = {
        id: 'test-db-id',
        name: 'Test',
        url: 'https://notion.so/test',
        properties: (
          [{ id: 'prop1', name: 'Title', type: 'title' }] satisfies Array<
            Omit<PropertyInfo, 'schema'>
          >
        ).map(makeProperty),
      }

      const code = generateSchemaCode({
        dbInfo,
        schemaName: 'my-test-database',
      })

      expect(code).toContain('export const MyTestDatabasePageProperties')
      expect(code).toContain('export type MyTestDatabasePageProperties')
    })

    it('should include property descriptions as comments', () => {
      const dbInfo: DatabaseInfo = {
        id: 'test-db-id',
        name: 'Test',
        url: 'https://notion.so/test',
        properties: (
          [
            {
              id: 'prop1',
              name: 'Status',
              type: 'select',
              description: 'Current task status',
            },
          ] satisfies Array<Omit<PropertyInfo, 'schema'>>
        ).map(makeProperty),
      }

      const code = generateSchemaCode({ dbInfo, schemaName: 'Test' })

      expect(code).toMatchInlineSnapshot(`
        "// AUTO-GENERATED FILE - DO NOT EDIT MANUALLY
        // Generated by notion-effect-schema-gen
        // Database: Test
        // ID: test-db-id
        // URL: https://notion.so/test

        import { NotionSchema, notionPropertyMeta, Schema } from '@overeng/notion-effect-schema'

        // -----------------------------------------------------------------------------
        // Read Schema
        // -----------------------------------------------------------------------------

        /**
         * Schema for reading pages from the "Test" database.
         */
        export const TestPageProperties = Schema.Struct({
          /** Current task status */
          Status: NotionSchema.select().annotate({ [notionPropertyMeta]: { _tag: 'select', id: 'prop1', name: 'Status', description: 'Current task status', select: { options: [] } } }),
        }).annotate({
          identifier: 'TestPageProperties',
          description: 'Read schema for Test database pages',
        })

        export type TestPageProperties = typeof TestPageProperties.Type

        /**
         * Decode properties from unknown data (throws on failure).
         */
        export const decodeTestProperties = Schema.decodeUnknownSync(TestPageProperties)

        /**
         * Decode properties from unknown data (returns Effect).
         */
        export const decodeTestPropertiesEffect = Schema.decodeUnknownEffect(TestPageProperties)
        "
      `)
    })

    it('emits valid single-quoted property descriptions without escaping double quotes', () => {
      const dbInfo: DatabaseInfo = {
        id: 'test-db-id',
        name: 'Test',
        url: 'https://notion.so/test',
        properties: (
          [
            {
              id: 'prop1',
              name: 'Status',
              type: 'select',
              description: `He said "don't"; path C:\\tmp; line one\nline two; template \${value}`,
            },
          ] satisfies Array<Omit<PropertyInfo, 'schema'>>
        ).map(makeProperty),
      }

      const code = generateSchemaCode({ dbInfo, schemaName: 'Test' })

      expect(code).toContain(
        `description: 'He said "don\\'t"; path C:\\\\tmp; line one\\nline two; template \${value}'`,
      )
    })

    it('should handle all property types with default transforms', () => {
      const propertyTypes: Array<{
        type: PropertyInfo['type']
        expected: string
      }> = [
        { type: 'title', expected: 'NotionSchema.title' },
        { type: 'rich_text', expected: 'NotionSchema.richTextOption' },
        { type: 'number', expected: 'NotionSchema.numberOption' },
        { type: 'select', expected: 'NotionSchema.select()' },
        { type: 'multi_select', expected: 'NotionSchema.multiSelect()' },
        { type: 'status', expected: 'NotionSchema.status()' },
        { type: 'date', expected: 'NotionSchema.dateOption' },
        { type: 'people', expected: 'NotionSchema.peopleIds' },
        { type: 'files', expected: 'NotionSchema.filesUrls' },
        { type: 'checkbox', expected: 'NotionSchema.checkbox' },
        { type: 'url', expected: 'NotionSchema.urlOption' },
        { type: 'email', expected: 'NotionSchema.emailOption' },
        { type: 'phone_number', expected: 'NotionSchema.phoneNumberOption' },
        { type: 'formula', expected: 'NotionSchema.formulaRaw' },
        { type: 'relation', expected: 'NotionSchema.relationIds' },
        { type: 'rollup', expected: 'NotionSchema.rollupRaw' },
        { type: 'created_time', expected: 'NotionSchema.createdTimeDate' },
        { type: 'created_by', expected: 'NotionSchema.createdByRaw' },
        {
          type: 'last_edited_time',
          expected: 'NotionSchema.lastEditedTimeDate',
        },
        { type: 'last_edited_by', expected: 'NotionSchema.lastEditedByRaw' },
        { type: 'unique_id', expected: 'NotionSchema.uniqueIdProperty' },
      ]

      for (const { type, expected } of propertyTypes) {
        const dbInfo: DatabaseInfo = {
          id: 'test',
          name: 'Test',
          url: 'https://notion.so/test',
          properties: (
            [{ id: 'prop', name: 'Prop', type }] satisfies Array<Omit<PropertyInfo, 'schema'>>
          ).map(makeProperty),
        }

        const code = generateSchemaCode({ dbInfo, schemaName: 'Test' })
        expect(code).toContain(`Prop: ${expected}`)
      }
    })

    it('should infer cardinality-independent relation defaults and rollup metadata transforms', () => {
      const dbInfo: DatabaseInfo = {
        id: 'test',
        name: 'Test',
        url: 'https://notion.so/test',
        properties: (
          [
            {
              id: 'rel',
              name: 'Owner',
              type: 'relation',
              relation: {
                database_id: 'db-id',
                type: 'single_property',
                single_property: {},
              },
            },
            {
              id: 'rollup',
              name: 'Total',
              type: 'rollup',
              rollup: {
                relation_property_name: 'Rel',
                relation_property_id: 'rel',
                rollup_property_name: 'Amount',
                rollup_property_id: 'amount',
                function: 'sum',
              },
            },
          ] satisfies Array<Omit<PropertyInfo, 'schema'>>
        ).map(makeProperty),
      }

      const code = generateSchemaCode({ dbInfo, schemaName: 'Test' })
      expect(code).toContain('Owner: NotionSchema.relationIds')
      expect(code).toContain('Total: NotionSchema.rollupNumber')
    })

    it('should handle unknown property types gracefully', () => {
      const dbInfo: DatabaseInfo = {
        id: 'test-db-id',
        name: 'Test',
        url: 'https://notion.so/test',
        properties: (
          [
            {
              id: 'prop1',
              name: 'Unknown',
              type: 'button' as PropertyInfo['type'],
            },
          ] satisfies Array<Omit<PropertyInfo, 'schema'>>
        ).map(makeProperty),
      }

      const code = generateSchemaCode({ dbInfo, schemaName: 'Test' })

      expect(code).toContain('Unknown: Schema.Unknown')
    })
  })

  describe('getAvailableTransforms', () => {
    it('should return available transforms for each type', () => {
      expect(getAvailableTransforms('title')).toContain('raw')
      expect(getAvailableTransforms('title')).toContain('asString')

      expect(getAvailableTransforms('select')).toContain('raw')
      expect(getAvailableTransforms('select')).toContain('asOption')
      expect(getAvailableTransforms('select')).toContain('asName')

      expect(getAvailableTransforms('checkbox')).toContain('raw')
      expect(getAvailableTransforms('checkbox')).toContain('asBoolean')
    })

    it('should return raw for unknown types', () => {
      expect(getAvailableTransforms('unknown')).toEqual(['raw'])
    })
  })

  describe('getDefaultTransform', () => {
    it('should return correct defaults', () => {
      expect(getDefaultTransform('title')).toBe('asString')
      expect(getDefaultTransform('number')).toBe('asOption')
      expect(getDefaultTransform('checkbox')).toBe('asBoolean')
      expect(getDefaultTransform('select')).toBe('asOption')
      expect(getDefaultTransform('formula')).toBe('raw')
    })

    it('should return raw for unknown types', () => {
      expect(getDefaultTransform('unknown')).toBe('raw')
    })
  })

  describe('PROPERTY_TRANSFORMS', () => {
    it('should have transforms defined for all common property types', () => {
      const expectedTypes = [
        'title',
        'rich_text',
        'number',
        'select',
        'multi_select',
        'status',
        'date',
        'people',
        'files',
        'checkbox',
        'url',
        'email',
        'phone_number',
        'formula',
        'relation',
        'rollup',
        'created_time',
        'created_by',
        'last_edited_time',
        'last_edited_by',
        'unique_id',
        'verification',
        'button',
      ] as const satisfies readonly NotionPropertyType[]

      for (const type of expectedTypes) {
        expect(PROPERTY_TRANSFORMS[type]).toBeDefined()
        expect(PROPERTY_TRANSFORMS[type]).toContain('raw')
      }
    })
  })

  describe('isReadOnlyProperty', () => {
    it('should return true for read-only properties', () => {
      expect(isReadOnlyProperty('formula')).toBe(true)
      expect(isReadOnlyProperty('rollup')).toBe(true)
      expect(isReadOnlyProperty('created_time')).toBe(true)
      expect(isReadOnlyProperty('created_by')).toBe(true)
      expect(isReadOnlyProperty('last_edited_time')).toBe(true)
      expect(isReadOnlyProperty('last_edited_by')).toBe(true)
      expect(isReadOnlyProperty('unique_id')).toBe(true)
    })

    it('should return false for writable properties', () => {
      expect(isReadOnlyProperty('title')).toBe(false)
      expect(isReadOnlyProperty('rich_text')).toBe(false)
      expect(isReadOnlyProperty('number')).toBe(false)
      expect(isReadOnlyProperty('select')).toBe(false)
      expect(isReadOnlyProperty('checkbox')).toBe(false)
    })
  })

  describe('generateSchemaCode with options', () => {
    it('should generate Write schema when includeWrite is true', () => {
      const dbInfo: DatabaseInfo = {
        id: 'test-db-id',
        name: 'Test',
        url: 'https://notion.so/test',
        properties: (
          [
            { id: 'prop1', name: 'Name', type: 'title' },
            { id: 'prop2', name: 'Status', type: 'select' },
            { id: 'prop3', name: 'CreatedAt', type: 'created_time' },
          ] satisfies Array<Omit<PropertyInfo, 'schema'>>
        ).map(makeProperty),
      }

      const code = generateSchemaCode({
        dbInfo,
        schemaName: 'Test',
        options: { includeWrite: true },
      })

      expect(code).toMatchInlineSnapshot(`
        "// AUTO-GENERATED FILE - DO NOT EDIT MANUALLY
        // Generated by notion-effect-schema-gen
        // Database: Test
        // ID: test-db-id
        // URL: https://notion.so/test
        // @config { includeWrite: true }

        import { NotionSchema, notionPropertyMeta, Schema } from '@overeng/notion-effect-schema'

        // -----------------------------------------------------------------------------
        // Read Schema
        // -----------------------------------------------------------------------------

        /**
         * Schema for reading pages from the "Test" database.
         */
        export const TestPageProperties = Schema.Struct({
          Name: NotionSchema.title.annotate({ [notionPropertyMeta]: { _tag: 'title', id: 'prop1', name: 'Name', description: null } }),
          Status: NotionSchema.select().annotate({ [notionPropertyMeta]: { _tag: 'select', id: 'prop2', name: 'Status', description: null, select: { options: [] } } }),
          CreatedAt: NotionSchema.createdTimeDate.annotate({ [notionPropertyMeta]: { _tag: 'created_time', id: 'prop3', name: 'CreatedAt', description: null } }),
        }).annotate({
          identifier: 'TestPageProperties',
          description: 'Read schema for Test database pages',
        })

        export type TestPageProperties = typeof TestPageProperties.Type

        /**
         * Decode properties from unknown data (throws on failure).
         */
        export const decodeTestProperties = Schema.decodeUnknownSync(TestPageProperties)

        /**
         * Decode properties from unknown data (returns Effect).
         */
        export const decodeTestPropertiesEffect = Schema.decodeUnknownEffect(TestPageProperties)

        // -----------------------------------------------------------------------------
        // Write Schema
        // -----------------------------------------------------------------------------

        /**
         * Schema for creating/updating pages in the "Test" database.
         * Note: Read-only properties (formula, rollup, created_time, etc.) are excluded.
         */
        export const TestPageWrite = Schema.Struct({
          Name: NotionSchema.titleWriteFromString,
          Status: NotionSchema.selectWriteFromName,
        }).annotate({
          identifier: 'TestPageWrite',
          description: 'Write schema for Test database pages',
        })

        export type TestPageWrite = typeof TestPageWrite.Type

        /**
         * Decode write data from simple types (throws on failure).
         */
        export const decodeTestWrite = Schema.decodeUnknownSync(TestPageWrite)

        /**
         * Decode write data from simple types (returns Effect).
         */
        export const decodeTestWriteEffect = Schema.decodeUnknownEffect(TestPageWrite)

        /**
         * Encode write data back to simple types (throws on failure).
         */
        export const encodeTestWrite = Schema.encodeSync(TestPageWrite)

        /**
         * Encode write data back to simple types (returns Effect).
         */
        export const encodeTestWriteEffect = Schema.encodeEffect(TestPageWrite)
        "
      `)
    })

    it('should generate typed options when typedOptions is true', () => {
      const dbInfo: DatabaseInfo = {
        id: 'test-db-id',
        name: 'Test',
        url: 'https://notion.so/test',
        properties: (
          [
            {
              id: 'prop1',
              name: 'Status',
              type: 'select',
              select: {
                options: [
                  { id: '1', name: 'Not Started', color: 'gray' },
                  { id: '2', name: 'In Progress', color: 'blue' },
                  { id: '3', name: 'Done', color: 'green' },
                ],
              },
            },
            {
              id: 'prop2',
              name: 'Priority',
              type: 'multi_select',
              multi_select: {
                options: [
                  { id: '1', name: 'High', color: 'red' },
                  { id: '2', name: 'Low', color: 'gray' },
                ],
              },
            },
          ] satisfies Array<Omit<PropertyInfo, 'schema'>>
        ).map(makeProperty),
      }

      const code = generateSchemaCode({
        dbInfo,
        schemaName: 'Test',
        options: { typedOptions: true },
      })

      expect(code).toMatchInlineSnapshot(`
        "// AUTO-GENERATED FILE - DO NOT EDIT MANUALLY
        // Generated by notion-effect-schema-gen
        // Database: Test
        // ID: test-db-id
        // URL: https://notion.so/test
        // @config { typedOptions: true }

        import { NotionSchema, notionPropertyMeta, Schema } from '@overeng/notion-effect-schema'

        // -----------------------------------------------------------------------------
        // Typed Options
        // -----------------------------------------------------------------------------

        /** Options for "Status" property */
        export const TestStatusOption = Schema.Literals(['Done', 'In Progress', 'Not Started']).annotate({
          identifier: 'TestStatusOption'
        })
        export type TestStatusOption = typeof TestStatusOption.Type

        /** Options for "Priority" property */
        export const TestPriorityOption = Schema.Literals(['High', 'Low']).annotate({
          identifier: 'TestPriorityOption'
        })
        export type TestPriorityOption = typeof TestPriorityOption.Type


        // -----------------------------------------------------------------------------
        // Read Schema
        // -----------------------------------------------------------------------------

        /**
         * Schema for reading pages from the "Test" database.
         */
        export const TestPageProperties = Schema.Struct({
          Status: NotionSchema.select(TestStatusOption).annotate({ [notionPropertyMeta]: { _tag: 'select', id: 'prop1', name: 'Status', description: null, select: { options: [{ id: '1', name: 'Not Started', color: 'gray', description: null }, { id: '2', name: 'In Progress', color: 'blue', description: null }, { id: '3', name: 'Done', color: 'green', description: null }] } } }),
          Priority: NotionSchema.multiSelect(TestPriorityOption).annotate({ [notionPropertyMeta]: { _tag: 'multi_select', id: 'prop2', name: 'Priority', description: null, multi_select: { options: [{ id: '1', name: 'High', color: 'red', description: null }, { id: '2', name: 'Low', color: 'gray', description: null }] } } }),
        }).annotate({
          identifier: 'TestPageProperties',
          description: 'Read schema for Test database pages',
        })

        export type TestPageProperties = typeof TestPageProperties.Type

        /**
         * Decode properties from unknown data (throws on failure).
         */
        export const decodeTestProperties = Schema.decodeUnknownSync(TestPageProperties)

        /**
         * Decode properties from unknown data (returns Effect).
         */
        export const decodeTestPropertiesEffect = Schema.decodeUnknownEffect(TestPageProperties)
        "
      `)
    })

    it('should preserve PascalCase in names', () => {
      const dbInfo: DatabaseInfo = {
        id: 'test',
        name: 'Test',
        url: 'https://notion.so/test',
        properties: (
          [{ id: 'prop', name: 'Title', type: 'title' }] satisfies Array<
            Omit<PropertyInfo, 'schema'>
          >
        ).map(makeProperty),
      }

      expect(generateSchemaCode({ dbInfo, schemaName: 'MyDatabase' })).toContain(
        'MyDatabasePageProperties',
      )
      expect(generateSchemaCode({ dbInfo, schemaName: 'TestDB' })).toContain('TestDBPageProperties')
      expect(generateSchemaCode({ dbInfo, schemaName: 'my-test-db' })).toContain(
        'MyTestDbPageProperties',
      )
    })

    it('should not include @config comment when no options are set', () => {
      const dbInfo: DatabaseInfo = {
        id: 'test-db-id',
        name: 'Test',
        url: 'https://notion.so/test',
        properties: (
          [{ id: 'prop1', name: 'Name', type: 'title' }] satisfies Array<
            Omit<PropertyInfo, 'schema'>
          >
        ).map(makeProperty),
      }

      const code = generateSchemaCode({ dbInfo, schemaName: 'Test' })

      expect(code).not.toContain('@config')
    })

    it('should include @config comment with all options', () => {
      const dbInfo: DatabaseInfo = {
        id: 'test-db-id',
        name: 'Test',
        url: 'https://notion.so/test',
        properties: (
          [{ id: 'prop1', name: 'Name', type: 'title' }] satisfies Array<
            Omit<PropertyInfo, 'schema'>
          >
        ).map(makeProperty),
      }

      const code = generateSchemaCode({
        dbInfo,
        schemaName: 'Test',
        options: {
          includeWrite: true,
          typedOptions: true,
          includeApi: true,
          transforms: { Status: 'asOption', Priority: 'asName' },
          schemaNameOverride: 'MyCustomName',
        },
      })

      expect(code).toMatchInlineSnapshot(`
        "// AUTO-GENERATED FILE - DO NOT EDIT MANUALLY
        // Generated by notion-effect-schema-gen
        // Database: Test
        // ID: test-db-id
        // URL: https://notion.so/test
        // @config { name: MyCustomName, includeWrite: true, typedOptions: true, includeApi: true, transforms: { Status: asOption, Priority: asName } }

        import { NotionSchema, notionPropertyMeta, Schema } from '@overeng/notion-effect-schema'

        // -----------------------------------------------------------------------------
        // Read Schema
        // -----------------------------------------------------------------------------

        /**
         * Schema for reading pages from the "Test" database.
         */
        export const TestPageProperties = Schema.Struct({
          Name: NotionSchema.title.annotate({ [notionPropertyMeta]: { _tag: 'title', id: 'prop1', name: 'Name', description: null } }),
        }).annotate({
          identifier: 'TestPageProperties',
          description: 'Read schema for Test database pages',
        })

        export type TestPageProperties = typeof TestPageProperties.Type

        /**
         * Decode properties from unknown data (throws on failure).
         */
        export const decodeTestProperties = Schema.decodeUnknownSync(TestPageProperties)

        /**
         * Decode properties from unknown data (returns Effect).
         */
        export const decodeTestPropertiesEffect = Schema.decodeUnknownEffect(TestPageProperties)

        // -----------------------------------------------------------------------------
        // Write Schema
        // -----------------------------------------------------------------------------

        /**
         * Schema for creating/updating pages in the "Test" database.
         * Note: Read-only properties (formula, rollup, created_time, etc.) are excluded.
         */
        export const TestPageWrite = Schema.Struct({
          Name: NotionSchema.titleWriteFromString,
        }).annotate({
          identifier: 'TestPageWrite',
          description: 'Write schema for Test database pages',
        })

        export type TestPageWrite = typeof TestPageWrite.Type

        /**
         * Decode write data from simple types (throws on failure).
         */
        export const decodeTestWrite = Schema.decodeUnknownSync(TestPageWrite)

        /**
         * Decode write data from simple types (returns Effect).
         */
        export const decodeTestWriteEffect = Schema.decodeUnknownEffect(TestPageWrite)

        /**
         * Encode write data back to simple types (throws on failure).
         */
        export const encodeTestWrite = Schema.encodeSync(TestPageWrite)

        /**
         * Encode write data back to simple types (returns Effect).
         */
        export const encodeTestWriteEffect = Schema.encodeEffect(TestPageWrite)
        "
      `)
    })

    it('should quote special characters in transform keys', () => {
      const dbInfo: DatabaseInfo = {
        id: 'test-db-id',
        name: 'Test',
        url: 'https://notion.so/test',
        properties: (
          [{ id: 'prop1', name: 'Name', type: 'title' }] satisfies Array<
            Omit<PropertyInfo, 'schema'>
          >
        ).map(makeProperty),
      }

      const code = generateSchemaCode({
        dbInfo,
        schemaName: 'Test',
        options: {
          transforms: { 'Due Date': 'asOption', 'My Status': 'raw' },
        },
      })

      expect(code).toContain(
        '// @config { transforms: { "Due Date": asOption, "My Status": raw } }',
      )
    })
  })
})
