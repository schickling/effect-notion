import { Effect, Result, Schema } from 'effect'
import { expect } from 'vitest'

import {
  DataSourceSchema,
  DatabaseSchema,
  NotionSchema,
  notionPropertyMeta,
} from '@overeng/notion-effect-schema'
import { shouldNeverHappen } from '@overeng/utils'
import { Vitest } from '@overeng/utils-dev/node-vitest'

import { SchemaHelpers } from './schema-helpers.ts'

const makeDatabase = (properties: Record<string, unknown>) =>
  Schema.decodeSync(DatabaseSchema)({
    object: 'database',
    id: 'db-id',
    created_time: '2025-01-01T00:00:00.000Z',
    created_by: { object: 'user', id: 'user-id' },
    last_edited_time: '2025-01-01T00:00:00.000Z',
    last_edited_by: { object: 'user', id: 'user-id' },
    title: [],
    description: [],
    icon: null,
    cover: null,
    parent: { type: 'workspace', workspace: true },
    url: 'https://notion.so/db',
    in_trash: false,
    is_inline: false,
    public_url: null,
    properties,
  })

const makeDataSource = (properties: Record<string, unknown>) =>
  Schema.decodeSync(DataSourceSchema)({
    object: 'data_source',
    id: 'data-source-id',
    title: [],
    description: [],
    icon: null,
    cover: null,
    parent: { type: 'database_id', database_id: 'db-id' },
    database_parent: { type: 'workspace', workspace: true },
    properties,
    is_inline: false,
    in_trash: false,
    url: 'https://notion.so/data-source',
    public_url: null,
    created_time: '2025-01-01T00:00:00.000Z',
    created_by: { object: 'user', id: 'user-id' },
    last_edited_time: '2025-01-01T00:00:00.000Z',
    last_edited_by: { object: 'user', id: 'user-id' },
  })

Vitest.describe('SchemaHelpers', () => {
  Vitest.describe('getProperties', () => {
    Vitest.it('decodes typed property definitions directly from a raw property record', () => {
      const props = SchemaHelpers.getPropertiesFromRecord({
        B: { id: 'prop-b', type: 'title', title: {} },
        A: { id: 'prop-a', type: 'checkbox', checkbox: {} },
        Unknown: { id: 'prop-x', type: 'made_up', made_up: {} },
      })

      expect(props.map((p) => [p.name, p._tag])).toEqual([
        ['A', 'checkbox'],
        ['B', 'title'],
      ])
    })

    Vitest.it('decodes typed property definitions from database schema properties', () => {
      const db = makeDatabase({
        B: { id: 'prop-b', type: 'title', title: {} },
        A: {
          id: 'prop-a',
          type: 'select',
          select: {
            options: [
              { id: 'opt-1', name: 'Done', color: 'green' },
              { id: 'opt-2', name: 'Todo', color: 'gray' },
            ],
          },
        },
        Unknown: { id: 'prop-x', type: 'made_up', made_up: {} },
      })

      const props = SchemaHelpers.getProperties({ schema: db })

      expect(props.map((p) => p.name)).toEqual(['A', 'B'])

      const first = props[0]
      if (first === undefined) {
        return shouldNeverHappen('Expected at least one property')
      }

      expect(first._tag).toBe('select')
      if (first._tag !== 'select') {
        return shouldNeverHappen('Expected first property to be select', first)
      }

      expect(first.select.options.map((o) => o.name)).toEqual(['Done', 'Todo'])
    })
  })

  Vitest.describe('validateProperties', () => {
    Vitest.it.effect('succeeds when required properties exist', () =>
      Effect.gen(function* () {
        const db = makeDatabase({
          Name: { id: 'prop-name', type: 'title', title: {} },
          Amount: {
            id: 'prop-amount',
            type: 'number',
            number: { format: 'number' },
          },
        })

        yield* SchemaHelpers.validateProperties({
          schema: db,
          databaseId: 'db-id',
          required: [
            { name: 'Name', tag: 'title' },
            { name: 'Amount', tag: 'number' },
          ],
        })
      }),
    )

    Vitest.it.effect('fails when required properties are missing', () =>
      Effect.gen(function* () {
        const db = makeDatabase({
          Name: { id: 'prop-name', type: 'title', title: {} },
        })

        const result = yield* SchemaHelpers.validateProperties({
          schema: db,
          databaseId: 'db-id',
          required: [
            { name: 'Name', tag: 'title' },
            { name: 'Amount', tag: 'number' },
          ],
        }).pipe(Effect.result)

        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result) === true) {
          expect(result.failure.missing.map((m) => m.name)).toEqual(['Amount'])
        }
      }),
    )
  })

  Vitest.describe('validatePropertiesFromSchema', () => {
    Vitest.it.effect('accepts a data source schema as the validation source', () =>
      Effect.gen(function* () {
        const dataSource = makeDataSource({
          Name: { id: 'prop-name', type: 'title', title: {} },
          Amount: {
            id: 'prop-amount',
            type: 'number',
            number: { format: 'number' },
          },
        })

        yield* SchemaHelpers.validatePropertiesFromSchema({
          schema: Schema.Struct({
            Name: NotionSchema.title.annotate({
              [notionPropertyMeta]: {
                _tag: 'title',
                id: 'prop-name',
                name: 'Name',
                description: null,
              },
            }),
            Amount: NotionSchema.numberOption.annotate({
              [notionPropertyMeta]: {
                _tag: 'number',
                id: 'prop-amount',
                name: 'Amount',
                description: null,
                number: { format: 'number' },
              },
            }),
          }),
          databaseId: 'db-id',
          schemaSource: dataSource,
        })
      }),
    )
  })

  Vitest.describe('getRelationTargetOrFail', () => {
    Vitest.it.effect('returns relation target when available', () =>
      Effect.gen(function* () {
        const db = makeDatabase({
          Customer: {
            id: 'prop-customer',
            type: 'relation',
            relation: {
              database_id: 'target-db',
              type: 'single_property',
              single_property: {},
            },
          },
        })

        const target = yield* SchemaHelpers.getRelationTargetOrFail({
          schema: db,
          databaseId: 'db-id',
          property: 'Customer',
        })

        expect(target.databaseId).toBe('target-db')
        expect(target.type).toBe('single_property')
      }),
    )

    Vitest.it.effect('fails when relation target is missing', () =>
      Effect.gen(function* () {
        const db = makeDatabase({
          Customer: { id: 'prop-customer', type: 'title', title: {} },
        })

        const result = yield* SchemaHelpers.getRelationTargetOrFail({
          schema: db,
          databaseId: 'db-id',
          property: 'Customer',
        }).pipe(Effect.result)

        expect(Result.isFailure(result)).toBe(true)
      }),
    )
  })
})
