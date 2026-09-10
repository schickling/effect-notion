import { Option, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import type { PropertySchema } from '@overeng/notion-effect-schema'
import { NotionSchema } from '@overeng/notion-effect-schema'

import { generateSchemaCode } from './codegen.ts'
import type { DatabaseInfo, PropertyInfo } from './introspect.ts'

const makeProperty = (info: Omit<PropertyInfo, 'schema'>): PropertyInfo => {
  const schemaBase = {
    id: info.id,
    name: info.name,
    description: null,
  }

  const schema: PropertySchema = (() => {
    switch (info.type) {
      case 'number':
        return { ...schemaBase, _tag: 'number', number: { format: 'number' } }
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
      case 'formula':
        return {
          ...schemaBase,
          _tag: 'formula',
          formula: { expression: info.formula?.expression ?? '' },
        }
      case 'relation':
        return {
          ...schemaBase,
          _tag: 'relation',
          relation: info.relation ?? {
            database_id: '00000000-0000-0000-0000-000000000000',
            type: 'single_property',
            single_property: {},
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

describe('integration', () => {
  it('should generate valid TypeScript code that compiles', async () => {
    const properties = [
      { id: 'title-prop', name: 'Name', type: 'title' },
      { id: 'text-prop', name: 'Description', type: 'rich_text' },
      { id: 'num-prop', name: 'Count', type: 'number' },
      { id: 'check-prop', name: 'Done', type: 'checkbox' },
      { id: 'select-prop', name: 'Status', type: 'select' },
    ] satisfies Array<Omit<PropertyInfo, 'schema'>>

    const dbInfo: DatabaseInfo = {
      id: 'test-db-id',
      name: 'Test Database',
      url: 'https://notion.so/test-db',
      properties: properties.map(makeProperty),
    }

    const code = generateSchemaCode({ dbInfo, schemaName: 'TestDatabase' })

    // Verify it's valid TypeScript (basic smoke test)
    expect(code).toContain(
      "import { NotionSchema, notionPropertyMeta, Schema } from '@overeng/notion-effect-schema'",
    )
    expect(code).toContain('export const TestDatabasePageProperties')
    expect(code).toContain('export type TestDatabasePageProperties')

    // Verify usage is correct
    expect(code).toContain('Name: NotionSchema.title.annotate({ [notionPropertyMeta]')
    expect(code).toContain(
      'Description: NotionSchema.richTextOption.annotate({ [notionPropertyMeta]',
    )
    expect(code).toContain('Count: NotionSchema.numberOption.annotate({ [notionPropertyMeta]')
    expect(code).toContain('Done: NotionSchema.checkbox.annotate({ [notionPropertyMeta]')
    expect(code).toContain('Status: NotionSchema.select().annotate({ [notionPropertyMeta]')
  })

  it('should generate schemas that can decode actual Notion API responses', () => {
    // Create a test schema matching what would be generated
    const TestPageProperties = Schema.Struct({
      Name: NotionSchema.title,
      Description: NotionSchema.richTextOption,
      Count: NotionSchema.numberOption,
      Done: NotionSchema.checkbox,
      Status: NotionSchema.select(),
    })

    // Mock Notion API property response (with proper structure including required fields)
    const mockProperties = {
      Name: {
        id: 'title-prop',
        type: 'title' as const,
        title: [
          {
            type: 'text' as const,
            text: { content: 'Test Task', link: null },
            plain_text: 'Test Task',
            annotations: {
              bold: false,
              italic: false,
              strikethrough: false,
              underline: false,
              code: false,
              color: 'default' as const,
            },
            href: null,
          },
        ],
      },
      Description: {
        id: 'text-prop',
        type: 'rich_text' as const,
        rich_text: [
          {
            type: 'text' as const,
            text: { content: 'Description text', link: null },
            plain_text: 'Description text',
            annotations: {
              bold: false,
              italic: false,
              strikethrough: false,
              underline: false,
              code: false,
              color: 'default' as const,
            },
            href: null,
          },
        ],
      },
      Count: {
        id: 'num-prop',
        type: 'number' as const,
        number: 42,
      },
      Done: {
        id: 'check-prop',
        type: 'checkbox' as const,
        checkbox: true,
      },
      Status: {
        id: 'select-prop',
        type: 'select' as const,
        select: {
          id: 'status-id',
          name: 'In Progress',
          color: 'blue' as const,
        },
      },
    }

    // Decode the properties (this verifies the schema actually works)
    const decoded = Schema.decodeSync(TestPageProperties)(mockProperties)

    // Verify the decoded result
    expect(decoded.Name).toBe('Test Task')
    expect(Option.getOrNull(decoded.Description)).toBe('Description text')
    expect(Option.getOrNull(decoded.Count)).toBe(42)
    expect(decoded.Done).toBe(true)
    expect(Option.isSome(decoded.Status)).toBe(true)
  })

  it('should generate write schemas that work with Notion API', () => {
    const properties = [
      { id: 'prop1', name: 'Name', type: 'title' },
      { id: 'prop2', name: 'Status', type: 'select' },
      { id: 'prop3', name: 'Done', type: 'checkbox' },
    ] satisfies Array<Omit<PropertyInfo, 'schema'>>

    const dbInfo: DatabaseInfo = {
      id: 'test-db-id',
      name: 'Test',
      url: 'https://notion.so/test',
      properties: properties.map(makeProperty),
    }

    const code = generateSchemaCode({
      dbInfo,
      schemaName: 'Test',
      options: { includeWrite: true },
    })

    // Verify write schema uses nested Write API
    expect(code).toContain('Name: NotionSchema.titleWriteFromString')
    expect(code).toContain('Status: NotionSchema.selectWriteFromName')
    expect(code).toContain('Done: NotionSchema.checkboxWriteFromBoolean')

    // Verify write schemas can decode simple types
    const TestPageWrite = Schema.Struct({
      Name: NotionSchema.titleWriteFromString,
      Status: NotionSchema.selectWriteFromName,
      Done: NotionSchema.checkboxWriteFromBoolean,
    })

    const inputData = {
      Name: 'New Task',
      Status: 'Todo',
      Done: false,
    }

    // Decode the simple types into Notion API format
    const decoded = Schema.decodeSync(TestPageWrite)(inputData)

    // Verify the decoded result has the correct Notion API format
    expect(decoded.Name).toHaveProperty('title')
    expect(decoded.Name.title).toBeInstanceOf(Array)
    expect(decoded.Name.title[0]).toMatchObject({
      type: 'text',
      text: { content: 'New Task' },
    })

    expect(decoded.Status).toHaveProperty('select')
    expect(decoded.Status.select).toMatchObject({ name: 'Todo' })

    expect(decoded.Done).toHaveProperty('checkbox')
    expect(decoded.Done.checkbox).toBe(false)
  })

  it('should handle all supported property types without errors', () => {
    const properties = [
      { id: '1', name: 'Title', type: 'title' },
      { id: '2', name: 'Text', type: 'rich_text' },
      { id: '3', name: 'Number', type: 'number' },
      { id: '4', name: 'Select', type: 'select' },
      { id: '5', name: 'MultiSelect', type: 'multi_select' },
      { id: '6', name: 'Status', type: 'status' },
      { id: '7', name: 'Date', type: 'date' },
      { id: '8', name: 'People', type: 'people' },
      { id: '9', name: 'Files', type: 'files' },
      { id: '10', name: 'Checkbox', type: 'checkbox' },
      { id: '11', name: 'URL', type: 'url' },
      { id: '12', name: 'Email', type: 'email' },
      { id: '13', name: 'Phone', type: 'phone_number' },
      { id: '14', name: 'Formula', type: 'formula' },
      { id: '15', name: 'Relation', type: 'relation' },
      { id: '16', name: 'CreatedTime', type: 'created_time' },
      { id: '17', name: 'CreatedBy', type: 'created_by' },
      { id: '18', name: 'LastEditedTime', type: 'last_edited_time' },
      { id: '19', name: 'LastEditedBy', type: 'last_edited_by' },
      { id: '20', name: 'UniqueId', type: 'unique_id' },
    ] satisfies Array<Omit<PropertyInfo, 'schema'>>

    const dbInfo: DatabaseInfo = {
      id: 'test',
      name: 'Test',
      url: 'https://notion.so/test',
      properties: properties.map(makeProperty),
    }

    // Should not throw
    const code = generateSchemaCode({ dbInfo, schemaName: 'AllTypes' })
    expect(code).toBeTruthy()
    expect(code.length).toBeGreaterThan(0)

    // Verify all transforms are included
    expect(code).toContain('NotionSchema.title')
    expect(code).toContain('NotionSchema.richTextOption')
    expect(code).toContain('NotionSchema.numberOption')
    expect(code).toContain('NotionSchema.select()')
    expect(code).toContain('NotionSchema.multiSelect()')
    expect(code).toContain('NotionSchema.status()')
    expect(code).toContain('NotionSchema.dateOption')
    expect(code).toContain('NotionSchema.peopleIds')
    expect(code).toContain('NotionSchema.filesUrls')
    expect(code).toContain('NotionSchema.checkbox')
    expect(code).toContain('NotionSchema.urlOption')
    expect(code).toContain('NotionSchema.emailOption')
    expect(code).toContain('NotionSchema.phoneNumberOption')
    expect(code).toContain('NotionSchema.formulaRaw')
    expect(code).toContain('NotionSchema.relationIds')
    expect(code).toContain('NotionSchema.createdTimeDate')
    expect(code).toContain('NotionSchema.createdByRaw')
    expect(code).toContain('NotionSchema.lastEditedTimeDate')
    expect(code).toContain('NotionSchema.lastEditedByRaw')
    expect(code).toContain('NotionSchema.uniqueIdProperty')
  })
})
