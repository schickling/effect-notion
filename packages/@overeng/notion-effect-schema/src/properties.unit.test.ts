import { Effect, Option, Schema } from 'effect'
import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import { NotionSchema } from './mod.ts'

// -----------------------------------------------------------------------------
// Title Property Tests
// -----------------------------------------------------------------------------

Vitest.describe('Title', () => {
  const sampleTitleProperty = {
    id: 'title',
    type: 'title' as const,
    title: [
      {
        type: 'text' as const,
        text: { content: 'Hello World', link: null },
        annotations: {
          bold: false,
          italic: false,
          strikethrough: false,
          underline: false,
          code: false,
          color: 'default' as const,
        },
        plain_text: 'Hello World',
        href: null,
      },
    ],
  }

  Vitest.describe('NotionSchema.title', () => {
    Vitest.it.effect('decodes title property to string', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.title)(sampleTitleProperty)
        expect(result).toBe('Hello World')
      }),
    )

    Vitest.it.effect('handles empty title array', () =>
      Effect.gen(function* () {
        const emptyTitle = { ...sampleTitleProperty, title: [] }
        const result = yield* Schema.decodeEffect(NotionSchema.title)(emptyTitle)
        expect(result).toBe('')
      }),
    )

    Vitest.it.effect('concatenates multiple rich text segments', () =>
      Effect.gen(function* () {
        const multiSegment = {
          ...sampleTitleProperty,
          title: [
            {
              type: 'text' as const,
              text: { content: 'Hello ', link: null },
              annotations: {
                bold: false,
                italic: false,
                strikethrough: false,
                underline: false,
                code: false,
                color: 'default' as const,
              },
              plain_text: 'Hello ',
              href: null,
            },
            {
              type: 'text' as const,
              text: { content: 'World', link: null },
              annotations: {
                bold: true,
                italic: false,
                strikethrough: false,
                underline: false,
                code: false,
                color: 'default' as const,
              },
              plain_text: 'World',
              href: null,
            },
          ],
        }
        const result = yield* Schema.decodeEffect(NotionSchema.title)(multiSegment)
        expect(result).toBe('Hello World')
      }),
    )
  })

  Vitest.describe('NotionSchema.titleWriteFromString', () => {
    Vitest.it.effect('encodes string to title write payload', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.titleWriteFromString)('Test Title')
        expect(result).toEqual({
          title: [{ type: 'text', text: { content: 'Test Title' } }],
        })
      }),
    )

    Vitest.it.effect('roundtrip: encode and decode', () =>
      Effect.gen(function* () {
        const original = 'My Page Title'
        const encoded = yield* Schema.decodeEffect(NotionSchema.titleWriteFromString)(original)
        const decoded = yield* Schema.encodeEffect(NotionSchema.titleWriteFromString)(encoded)
        expect(decoded).toBe(original)
      }),
    )

    Vitest.it.effect('handles empty string', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.titleWriteFromString)('')
        expect(result).toEqual({
          title: [{ type: 'text', text: { content: '' } }],
        })
      }),
    )
  })

  Vitest.describe('NotionSchema.titleWrite schema', () => {
    Vitest.it.effect('validates valid title write payload', () =>
      Effect.gen(function* () {
        const payload = {
          title: [{ type: 'text' as const, text: { content: 'Test' } }],
        }
        const result = yield* Schema.decodeEffect(NotionSchema.titleWrite)(payload)
        expect(result).toEqual(payload)
      }),
    )

    Vitest.it.effect('accepts title with link', () =>
      Effect.gen(function* () {
        const payload = {
          title: [
            {
              type: 'text' as const,
              text: {
                content: 'Click here',
                link: { url: 'https://example.com' },
              },
            },
          ],
        }
        const result = yield* Schema.decodeEffect(NotionSchema.titleWrite)(payload)
        expect(result).toEqual(payload)
      }),
    )
  })
})

// -----------------------------------------------------------------------------
// Rich Text Property Tests
// -----------------------------------------------------------------------------

Vitest.describe('RichText Property', () => {
  const sampleRichTextProperty = {
    id: 'rich_text',
    type: 'rich_text' as const,
    rich_text: [
      {
        type: 'text' as const,
        text: { content: 'Sample text', link: null },
        annotations: {
          bold: false,
          italic: false,
          strikethrough: false,
          underline: false,
          code: false,
          color: 'default' as const,
        },
        plain_text: 'Sample text',
        href: null,
      },
    ],
  }

  Vitest.describe('NotionSchema.richTextString', () => {
    Vitest.it.effect('decodes rich text property to string', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.richTextString)(
          sampleRichTextProperty,
        )
        expect(result).toBe('Sample text')
      }),
    )
  })

  Vitest.describe('NotionSchema.richTextOption', () => {
    Vitest.it.effect('returns Some for non-empty text', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.richTextOption)(
          sampleRichTextProperty,
        )
        expect(Option.isSome(result)).toBe(true)
        expect(Option.getOrNull(result)).toBe('Sample text')
      }),
    )

    Vitest.it.effect('returns None for empty text', () =>
      Effect.gen(function* () {
        const emptyProp = { ...sampleRichTextProperty, rich_text: [] }
        const result = yield* Schema.decodeEffect(NotionSchema.richTextOption)(emptyProp)
        expect(Option.isNone(result)).toBe(true)
      }),
    )

    Vitest.it.effect('returns None for whitespace-only text', () =>
      Effect.gen(function* () {
        const whitespaceProp = {
          ...sampleRichTextProperty,
          rich_text: [
            {
              type: 'text' as const,
              text: { content: '   ', link: null },
              annotations: {
                bold: false,
                italic: false,
                strikethrough: false,
                underline: false,
                code: false,
                color: 'default' as const,
              },
              plain_text: '   ',
              href: null,
            },
          ],
        }
        const result = yield* Schema.decodeEffect(NotionSchema.richTextOption)(whitespaceProp)
        expect(Option.isNone(result)).toBe(true)
      }),
    )
  })

  Vitest.describe('NotionSchema.richTextWriteFromString', () => {
    Vitest.it.effect('encodes string to rich text write payload', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.richTextWriteFromString)(
          'Test content',
        )
        expect(result).toEqual({
          rich_text: [{ type: 'text', text: { content: 'Test content' } }],
        })
      }),
    )

    Vitest.it.effect('roundtrip: encode and decode', () =>
      Effect.gen(function* () {
        const original = 'Some text content'
        const encoded = yield* Schema.decodeEffect(NotionSchema.richTextWriteFromString)(original)
        const decoded = yield* Schema.encodeEffect(NotionSchema.richTextWriteFromString)(encoded)
        expect(decoded).toBe(original)
      }),
    )
  })

  Vitest.describe('NotionSchema.richTextNonEmpty', () => {
    Vitest.it.effect('returns string for non-empty text', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.richTextNonEmpty)(
          sampleRichTextProperty,
        )
        expect(result).toBe('Sample text')
      }),
    )

    Vitest.it.effect('fails for empty text', () =>
      Effect.gen(function* () {
        const emptyProp = { ...sampleRichTextProperty, rich_text: [] }
        const result = yield* Schema.decodeEffect(NotionSchema.richTextNonEmpty)(emptyProp).pipe(
          Effect.result,
        )
        expect(result._tag).toBe('Failure')
      }),
    )
  })
})

// -----------------------------------------------------------------------------
// Number Property Tests
// -----------------------------------------------------------------------------

Vitest.describe('Number Property', () => {
  const sampleNumberProperty = {
    id: 'number',
    type: 'number' as const,
    number: 42,
  }

  const nullNumberProperty = {
    id: 'number',
    type: 'number' as const,
    number: null,
  }

  Vitest.describe('NotionSchema.number', () => {
    Vitest.it.effect('decodes non-null number', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.number)(sampleNumberProperty)
        expect(result).toBe(42)
      }),
    )

    Vitest.it.effect('fails on null number', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.number)(nullNumberProperty).pipe(
          Effect.flip,
        )
        expect(result).toBeDefined()
      }),
    )

    Vitest.it.effect('decodes decimal numbers', () =>
      Effect.gen(function* () {
        const decimalProp = { ...sampleNumberProperty, number: 3.14 }
        const result = yield* Schema.decodeEffect(NotionSchema.number)(decimalProp)
        expect(result).toBe(3.14)
      }),
    )
  })

  Vitest.describe('NotionSchema.numberOption', () => {
    Vitest.it.effect('returns Some for non-null number', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.numberOption)(sampleNumberProperty)
        expect(Option.isSome(result)).toBe(true)
        expect(Option.getOrNull(result)).toBe(42)
      }),
    )

    Vitest.it.effect('returns None for null number', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.numberOption)(nullNumberProperty)
        expect(Option.isNone(result)).toBe(true)
      }),
    )
  })

  Vitest.describe('NotionSchema.numberWriteFromNumber', () => {
    Vitest.it.effect('encodes number to write payload', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.numberWriteFromNumber)(100)
        expect(result).toEqual({ number: 100 })
      }),
    )

    Vitest.it.effect('encodes null to write payload', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.numberWriteFromNumber)(null)
        expect(result).toEqual({ number: null })
      }),
    )

    Vitest.it.effect('roundtrip: encode and decode', () =>
      Effect.gen(function* () {
        const original = 99
        const encoded = yield* Schema.decodeEffect(NotionSchema.numberWriteFromNumber)(original)
        const decoded = yield* Schema.encodeEffect(NotionSchema.numberWriteFromNumber)(encoded)
        expect(decoded).toBe(original)
      }),
    )
  })
})

// -----------------------------------------------------------------------------
// Checkbox Property Tests
// -----------------------------------------------------------------------------

Vitest.describe('Checkbox Property', () => {
  const checkedProperty = {
    id: 'checkbox',
    type: 'checkbox' as const,
    checkbox: true,
  }

  const uncheckedProperty = {
    id: 'checkbox',
    type: 'checkbox' as const,
    checkbox: false,
  }

  Vitest.describe('NotionSchema.checkbox', () => {
    Vitest.it.effect('decodes checked checkbox', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.checkbox)(checkedProperty)
        expect(result).toBe(true)
      }),
    )

    Vitest.it.effect('decodes unchecked checkbox', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.checkbox)(uncheckedProperty)
        expect(result).toBe(false)
      }),
    )
  })

  Vitest.describe('NotionSchema.checkboxWriteFromBoolean', () => {
    Vitest.it.effect('encodes true to write payload', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.checkboxWriteFromBoolean)(true)
        expect(result).toEqual({ checkbox: true })
      }),
    )

    Vitest.it.effect('encodes false to write payload', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.checkboxWriteFromBoolean)(false)
        expect(result).toEqual({ checkbox: false })
      }),
    )

    Vitest.it.effect('roundtrip: encode and decode', () =>
      Effect.gen(function* () {
        const original = true
        const encoded = yield* Schema.decodeEffect(NotionSchema.checkboxWriteFromBoolean)(original)
        const decoded = yield* Schema.encodeEffect(NotionSchema.checkboxWriteFromBoolean)(encoded)
        expect(decoded).toBe(original)
      }),
    )
  })
})

// -----------------------------------------------------------------------------
// Select Property Tests
// -----------------------------------------------------------------------------

Vitest.describe('Select Property', () => {
  const selectedProperty = {
    id: 'select',
    type: 'select' as const,
    select: {
      id: 'opt-123',
      name: 'High',
      color: 'red' as const,
    },
  }

  const nullSelectProperty = {
    id: 'select',
    type: 'select' as const,
    select: null,
  }

  Vitest.describe('NotionSchema.select', () => {
    Vitest.it.effect('returns Some with option', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.select())(selectedProperty)
        expect(Option.isSome(result)).toBe(true)
        expect(Option.getOrNull(result)?.name).toBe('High')
      }),
    )

    Vitest.it.effect('returns None for null select', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.select())(nullSelectProperty)
        expect(Option.isNone(result)).toBe(true)
      }),
    )
  })

  Vitest.describe('NotionSchema.select(...).pipe(NotionSchema.asName)', () => {
    const Allowed = Schema.Literals(['High', 'Low'])

    Vitest.it.effect('returns Some with allowed name', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(
          NotionSchema.select(Allowed).pipe(NotionSchema.asName),
        )(selectedProperty)
        expect(Option.isSome(result)).toBe(true)
        expect(Option.getOrNull(result)).toBe('High')
      }),
    )

    Vitest.it.effect('fails when option name is not allowed', () =>
      Effect.gen(function* () {
        const invalidProperty = {
          ...selectedProperty,
          select: { ...selectedProperty.select, name: 'Medium' },
        }
        const result = yield* Schema.decodeEffect(
          NotionSchema.select(Allowed).pipe(NotionSchema.asName),
        )(invalidProperty).pipe(Effect.result)
        expect(result._tag).toBe('Failure')
      }),
    )
  })

  Vitest.describe('NotionSchema.select(...).pipe(NotionSchema.asNullable)', () => {
    Vitest.it.effect('returns option for selected property', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(
          NotionSchema.select().pipe(NotionSchema.asNullable),
        )(selectedProperty)
        expect(result?.name).toBe('High')
      }),
    )

    Vitest.it.effect('returns null for null select', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(
          NotionSchema.select().pipe(NotionSchema.asNullable),
        )(nullSelectProperty)
        expect(result).toBeNull()
      }),
    )
  })

  Vitest.describe('NotionSchema.selectWriteFromName', () => {
    Vitest.it.effect('encodes option name to write payload', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.selectWriteFromName)('Medium')
        expect(result).toEqual({ select: { name: 'Medium' } })
      }),
    )

    Vitest.it.effect('encodes null to write payload', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.selectWriteFromName)(null)
        expect(result).toEqual({ select: null })
      }),
    )

    Vitest.it.effect('roundtrip: encode and decode', () =>
      Effect.gen(function* () {
        const original = 'Low'
        const encoded = yield* Schema.decodeEffect(NotionSchema.selectWriteFromName)(original)
        const decoded = yield* Schema.encodeEffect(NotionSchema.selectWriteFromName)(encoded)
        expect(decoded).toBe(original)
      }),
    )
  })
})

// -----------------------------------------------------------------------------
// Multi-Select Property Tests
// -----------------------------------------------------------------------------

Vitest.describe('MultiSelect Property', () => {
  const multiSelectProperty = {
    id: 'multi_select',
    type: 'multi_select' as const,
    multi_select: [
      { id: 'opt-1', name: 'Tag1', color: 'blue' as const },
      { id: 'opt-2', name: 'Tag2', color: 'green' as const },
    ],
  }

  const emptyMultiSelectProperty = {
    id: 'multi_select',
    type: 'multi_select' as const,
    multi_select: [],
  }

  Vitest.describe('NotionSchema.multiSelect', () => {
    Vitest.it.effect('decodes to array of options', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.multiSelect())(multiSelectProperty)
        expect(result).toHaveLength(2)
        expect(result[0]?.name).toBe('Tag1')
      }),
    )

    Vitest.it.effect('handles empty array', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.multiSelect())(
          emptyMultiSelectProperty,
        )
        expect(result).toEqual([])
      }),
    )
  })

  Vitest.describe('NotionSchema.multiSelect(...).pipe(NotionSchema.asNames)', () => {
    const Allowed = Schema.Literals(['Tag1', 'Tag2'])

    Vitest.it.effect('decodes to array of allowed names', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(
          NotionSchema.multiSelect(Allowed).pipe(NotionSchema.asNames),
        )(multiSelectProperty)
        expect(result).toEqual(['Tag1', 'Tag2'])
      }),
    )

    Vitest.it.effect('fails when option name is not allowed', () =>
      Effect.gen(function* () {
        const invalidProperty = {
          ...multiSelectProperty,
          multi_select: [{ ...multiSelectProperty.multi_select[0], name: 'Tag3' }],
        }
        const result = yield* Schema.decodeEffect(
          NotionSchema.multiSelect(Allowed).pipe(NotionSchema.asNames),
        )(invalidProperty).pipe(Effect.result)
        expect(result._tag).toBe('Failure')
      }),
    )
  })

  Vitest.describe('NotionSchema.multiSelectWriteFromNames', () => {
    Vitest.it.effect('encodes names to write payload', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.multiSelectWriteFromNames)([
          'A',
          'B',
          'C',
        ])
        expect(result).toEqual({
          multi_select: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
        })
      }),
    )

    Vitest.it.effect('handles empty array', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.multiSelectWriteFromNames)([])
        expect(result).toEqual({ multi_select: [] })
      }),
    )

    Vitest.it.effect('roundtrip: encode and decode', () =>
      Effect.gen(function* () {
        const original = ['X', 'Y', 'Z']
        const encoded = yield* Schema.decodeEffect(NotionSchema.multiSelectWriteFromNames)(original)
        const decoded = yield* Schema.encodeEffect(NotionSchema.multiSelectWriteFromNames)(encoded)
        expect(decoded).toEqual(original)
      }),
    )
  })
})

// -----------------------------------------------------------------------------
// Status Property Tests
// -----------------------------------------------------------------------------

Vitest.describe('Status Property', () => {
  const statusProperty = {
    id: 'status',
    type: 'status' as const,
    status: {
      id: 'stat-123',
      name: 'In Progress',
      color: 'yellow' as const,
    },
  }

  const nullStatusProperty = {
    id: 'status',
    type: 'status' as const,
    status: null,
  }

  Vitest.describe('NotionSchema.status', () => {
    Vitest.it.effect('returns Some with status option', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.status())(statusProperty)
        expect(Option.isSome(result)).toBe(true)
        expect(Option.getOrNull(result)?.name).toBe('In Progress')
      }),
    )

    Vitest.it.effect('returns None for null status', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.status())(nullStatusProperty)
        expect(Option.isNone(result)).toBe(true)
      }),
    )
  })

  Vitest.describe('NotionSchema.status(...).pipe(NotionSchema.asName)', () => {
    const Allowed = Schema.Literals(['In Progress', 'Blocked'])

    Vitest.it.effect('returns Some with allowed status name', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(
          NotionSchema.status(Allowed).pipe(NotionSchema.asName),
        )(statusProperty)
        expect(Option.isSome(result)).toBe(true)
        expect(Option.getOrNull(result)).toBe('In Progress')
      }),
    )

    Vitest.it.effect('fails when status name is not allowed', () =>
      Effect.gen(function* () {
        const invalidProperty = {
          ...statusProperty,
          status: { ...statusProperty.status, name: 'Done' },
        }
        const result = yield* Schema.decodeEffect(
          NotionSchema.status(Allowed).pipe(NotionSchema.asName),
        )(invalidProperty).pipe(Effect.result)
        expect(result._tag).toBe('Failure')
      }),
    )
  })

  Vitest.describe('NotionSchema.status(...).pipe(NotionSchema.asNullable)', () => {
    Vitest.it.effect('returns status option for selected status', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(
          NotionSchema.status().pipe(NotionSchema.asNullable),
        )(statusProperty)
        expect(result?.name).toBe('In Progress')
      }),
    )

    Vitest.it.effect('returns null for null status', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(
          NotionSchema.status().pipe(NotionSchema.asNullable),
        )(nullStatusProperty)
        expect(result).toBeNull()
      }),
    )
  })

  Vitest.describe('NotionSchema.statusWriteFromName', () => {
    Vitest.it.effect('encodes status name to write payload', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.statusWriteFromName)('Done')
        expect(result).toEqual({ status: { name: 'Done' } })
      }),
    )

    Vitest.it.effect('roundtrip: encode and decode', () =>
      Effect.gen(function* () {
        const original = 'Blocked'
        const encoded = yield* Schema.decodeEffect(NotionSchema.statusWriteFromName)(original)
        const decoded = yield* Schema.encodeEffect(NotionSchema.statusWriteFromName)(encoded)
        expect(decoded).toBe(original)
      }),
    )
  })
})

// -----------------------------------------------------------------------------
// Formula Property Tests
// -----------------------------------------------------------------------------

Vitest.describe('Formula Property', () => {
  const numberFormulaProperty = {
    id: 'formula',
    type: 'formula' as const,
    formula: {
      type: 'number' as const,
      number: 42,
    },
  }

  const stringFormulaProperty = {
    id: 'formula',
    type: 'formula' as const,
    formula: {
      type: 'string' as const,
      string: 'hello',
    },
  }

  const booleanFormulaProperty = {
    id: 'formula',
    type: 'formula' as const,
    formula: {
      type: 'boolean' as const,
      boolean: true,
    },
  }

  const dateFormulaProperty = {
    id: 'formula',
    type: 'formula' as const,
    formula: {
      type: 'date' as const,
      date: {
        start: '2024-01-15',
        end: null,
        time_zone: null,
      },
    },
  }

  Vitest.describe('NotionSchema.formulaNumber', () => {
    Vitest.it.effect('decodes number formula', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.formulaNumber)(numberFormulaProperty)
        expect(result).toBe(42)
      }),
    )

    Vitest.it.effect('fails for non-number formula', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.formulaNumber)(
          stringFormulaProperty,
        ).pipe(Effect.result)
        expect(result._tag).toBe('Failure')
      }),
    )
  })

  Vitest.describe('NotionSchema.formulaString', () => {
    Vitest.it.effect('decodes string formula', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.formulaString)(stringFormulaProperty)
        expect(result).toBe('hello')
      }),
    )

    Vitest.it.effect('fails for non-string formula', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.formulaString)(
          numberFormulaProperty,
        ).pipe(Effect.result)
        expect(result._tag).toBe('Failure')
      }),
    )
  })

  Vitest.describe('NotionSchema.formulaBoolean', () => {
    Vitest.it.effect('decodes boolean formula', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.formulaBoolean)(
          booleanFormulaProperty,
        )
        expect(result).toBe(true)
      }),
    )
  })

  Vitest.describe('NotionSchema.formulaDate', () => {
    Vitest.it.effect('decodes date formula', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.formulaDate)(dateFormulaProperty)
        expect(result.start).toBe('2024-01-15')
      }),
    )
  })
})

// -----------------------------------------------------------------------------
// Rollup Property Tests
// -----------------------------------------------------------------------------

Vitest.describe('Rollup Property', () => {
  const numberRollupProperty = {
    id: 'rollup',
    type: 'rollup' as const,
    rollup: {
      type: 'number' as const,
      number: 7,
    },
  }

  const stringRollupProperty = {
    id: 'rollup',
    type: 'rollup' as const,
    rollup: {
      type: 'string' as const,
      string: 'hello',
    },
  }

  const booleanRollupProperty = {
    id: 'rollup',
    type: 'rollup' as const,
    rollup: {
      type: 'boolean' as const,
      boolean: true,
    },
  }

  const dateRollupProperty = {
    id: 'rollup',
    type: 'rollup' as const,
    rollup: {
      type: 'date' as const,
      date: {
        start: '2024-01-15',
        end: null,
        time_zone: null,
      },
    },
  }

  const arrayRollupProperty = {
    id: 'rollup',
    type: 'rollup' as const,
    rollup: {
      type: 'array' as const,
      array: ['a', 'b'],
    },
  }

  Vitest.describe('NotionSchema.rollupNumber', () => {
    Vitest.it.effect('decodes number rollup', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.rollupNumber)(numberRollupProperty)
        expect(result).toBe(7)
      }),
    )

    Vitest.it.effect('fails for non-number rollup', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.rollupNumber)(
          stringRollupProperty,
        ).pipe(Effect.result)
        expect(result._tag).toBe('Failure')
      }),
    )
  })

  Vitest.describe('NotionSchema.rollupString', () => {
    Vitest.it.effect('decodes string rollup', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.rollupString)(stringRollupProperty)
        expect(result).toBe('hello')
      }),
    )
  })

  Vitest.describe('NotionSchema.rollupBoolean', () => {
    Vitest.it.effect('decodes boolean rollup', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.rollupBoolean)(booleanRollupProperty)
        expect(result).toBe(true)
      }),
    )
  })

  Vitest.describe('NotionSchema.rollupDate', () => {
    Vitest.it.effect('decodes date rollup', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.rollupDate)(dateRollupProperty)
        expect(result.start).toBe('2024-01-15')
      }),
    )
  })

  Vitest.describe('NotionSchema.rollupArray', () => {
    Vitest.it.effect('decodes array rollup', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.rollupArray)(arrayRollupProperty)
        expect(result).toEqual(['a', 'b'])
      }),
    )
  })
})

// -----------------------------------------------------------------------------
// Date Property Tests
// -----------------------------------------------------------------------------

Vitest.describe('Date Property', () => {
  const dateProperty = {
    id: 'date',
    type: 'date' as const,
    date: {
      start: '2024-01-15',
      end: null,
      time_zone: null,
    },
  }

  const nullDateProperty = {
    id: 'date',
    type: 'date' as const,
    date: null,
  }

  Vitest.describe('NotionSchema.dateOption', () => {
    Vitest.it.effect('returns Some with date value', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.dateOption)(dateProperty)
        expect(Option.isSome(result)).toBe(true)
        const value = Option.getOrNull(result)
        expect(value?.start).toBe('2024-01-15')
      }),
    )

    Vitest.it.effect('returns None for null date', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.dateOption)(nullDateProperty)
        expect(Option.isNone(result)).toBe(true)
      }),
    )
  })

  Vitest.describe('NotionSchema.requiredMessage', () => {
    const schema = NotionSchema.dateOption.pipe(NotionSchema.requiredMessage('Date is required'))

    Vitest.it.effect('returns date value', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(schema)(dateProperty)
        expect(result.start).toBe('2024-01-15')
      }),
    )

    Vitest.it.effect('fails for null date', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(schema)(nullDateProperty).pipe(Effect.result)
        expect(result._tag).toBe('Failure')
      }),
    )
  })

  Vitest.describe('NotionSchema.dateDate', () => {
    Vitest.it.effect('parses start date to Date object', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.dateDate)(dateProperty)
        expect(Option.isSome(result)).toBe(true)
        const date = Option.getOrNull(result)
        expect(date).toBeInstanceOf(Date)
        expect(date?.toISOString()).toContain('2024-01-15')
      }),
    )

    Vitest.it.effect('returns None for null date', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.dateDate)(nullDateProperty)
        expect(Option.isNone(result)).toBe(true)
      }),
    )
  })

  Vitest.describe('NotionSchema.dateWriteFromStart', () => {
    Vitest.it.effect('encodes date string to write payload', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.dateWriteFromStart)('2024-06-01')
        expect(result).toEqual({ date: { start: '2024-06-01' } })
      }),
    )

    Vitest.it.effect('roundtrip: encode and decode', () =>
      Effect.gen(function* () {
        const original = '2024-12-25'
        const encoded = yield* Schema.decodeEffect(NotionSchema.dateWriteFromStart)(original)
        const decoded = yield* Schema.encodeEffect(NotionSchema.dateWriteFromStart)(encoded)
        expect(decoded).toBe(original)
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// Required Helpers
// ---------------------------------------------------------------------------

Vitest.describe('NotionSchema.nullable', () => {
  const schema = Schema.NullOr(Schema.String).pipe(
    NotionSchema.nullable({
      valueSchema: Schema.String,
      message: 'String is required',
    }),
  )

  Vitest.it.effect('returns value when present', () =>
    Effect.gen(function* () {
      const result = yield* Schema.decodeEffect(schema)('hello')
      expect(result).toBe('hello')
    }),
  )

  Vitest.it.effect('fails for null', () =>
    Effect.gen(function* () {
      const result = yield* Schema.decodeEffect(schema)(null).pipe(Effect.result)
      expect(result._tag).toBe('Failure')
    }),
  )
})

// -----------------------------------------------------------------------------
// URL Property Tests
// -----------------------------------------------------------------------------

Vitest.describe('URL Property', () => {
  const urlProperty = {
    id: 'url',
    type: 'url' as const,
    url: 'https://example.com',
  }

  const nullUrlProperty = {
    id: 'url',
    type: 'url' as const,
    url: null,
  }

  Vitest.describe('NotionSchema.urlOption', () => {
    Vitest.it.effect('returns Some with URL', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.urlOption)(urlProperty)
        expect(Option.isSome(result)).toBe(true)
        expect(Option.getOrNull(result)).toBe('https://example.com')
      }),
    )

    Vitest.it.effect('returns None for null URL', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.urlOption)(nullUrlProperty)
        expect(Option.isNone(result)).toBe(true)
      }),
    )
  })

  Vitest.describe('NotionSchema.urlWriteFromString', () => {
    Vitest.it.effect('encodes URL string to write payload', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.urlWriteFromString)(
          'https://notion.so',
        )
        expect(result).toEqual({ url: 'https://notion.so' })
      }),
    )

    Vitest.it.effect('roundtrip: encode and decode', () =>
      Effect.gen(function* () {
        const original = 'https://github.com'
        const encoded = yield* Schema.decodeEffect(NotionSchema.urlWriteFromString)(original)
        const decoded = yield* Schema.encodeEffect(NotionSchema.urlWriteFromString)(encoded)
        expect(decoded).toBe(original)
      }),
    )
  })
})

// -----------------------------------------------------------------------------
// Email Property Tests
// -----------------------------------------------------------------------------

Vitest.describe('Email Property', () => {
  const emailProperty = {
    id: 'email',
    type: 'email' as const,
    email: 'user@example.com',
  }

  const nullEmailProperty = {
    id: 'email',
    type: 'email' as const,
    email: null,
  }

  Vitest.describe('NotionSchema.emailOption', () => {
    Vitest.it.effect('returns Some with email', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.emailOption)(emailProperty)
        expect(Option.isSome(result)).toBe(true)
        expect(Option.getOrNull(result)).toBe('user@example.com')
      }),
    )

    Vitest.it.effect('returns None for null email', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.emailOption)(nullEmailProperty)
        expect(Option.isNone(result)).toBe(true)
      }),
    )
  })

  Vitest.describe('NotionSchema.emailWriteFromString', () => {
    Vitest.it.effect('encodes email string to write payload', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.emailWriteFromString)(
          'test@test.com',
        )
        expect(result).toEqual({ email: 'test@test.com' })
      }),
    )

    Vitest.it.effect('roundtrip: encode and decode', () =>
      Effect.gen(function* () {
        const original = 'alice@wonderland.com'
        const encoded = yield* Schema.decodeEffect(NotionSchema.emailWriteFromString)(original)
        const decoded = yield* Schema.encodeEffect(NotionSchema.emailWriteFromString)(encoded)
        expect(decoded).toBe(original)
      }),
    )
  })
})

// -----------------------------------------------------------------------------
// Phone Number Property Tests
// -----------------------------------------------------------------------------

Vitest.describe('PhoneNumber Property', () => {
  const phoneProperty = {
    id: 'phone_number',
    type: 'phone_number' as const,
    phone_number: '+1-555-123-4567',
  }

  const nullPhoneProperty = {
    id: 'phone_number',
    type: 'phone_number' as const,
    phone_number: null,
  }

  Vitest.describe('NotionSchema.phoneNumberOption', () => {
    Vitest.it.effect('returns Some with phone number', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.phoneNumberOption)(phoneProperty)
        expect(Option.isSome(result)).toBe(true)
        expect(Option.getOrNull(result)).toBe('+1-555-123-4567')
      }),
    )

    Vitest.it.effect('returns None for null phone number', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.phoneNumberOption)(nullPhoneProperty)
        expect(Option.isNone(result)).toBe(true)
      }),
    )
  })

  Vitest.describe('NotionSchema.phoneNumberWriteFromString', () => {
    Vitest.it.effect('encodes phone string to write payload', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.phoneNumberWriteFromString)(
          '+44-20-1234-5678',
        )
        expect(result).toEqual({ phone_number: '+44-20-1234-5678' })
      }),
    )

    Vitest.it.effect('roundtrip: encode and decode', () =>
      Effect.gen(function* () {
        const original = '+1-800-CALL-NOW'
        const encoded = yield* Schema.decodeEffect(NotionSchema.phoneNumberWriteFromString)(
          original,
        )
        const decoded = yield* Schema.encodeEffect(NotionSchema.phoneNumberWriteFromString)(encoded)
        expect(decoded).toBe(original)
      }),
    )
  })
})

// -----------------------------------------------------------------------------
// Relation Property Tests
// -----------------------------------------------------------------------------

Vitest.describe('Relation Property', () => {
  const relationProperty = {
    id: 'relation',
    type: 'relation' as const,
    relation: [{ id: 'page-1' }, { id: 'page-2' }],
  }

  const singleRelationProperty = {
    id: 'relation',
    type: 'relation' as const,
    relation: [{ id: 'page-1' }],
  }

  Vitest.describe('NotionSchema.relationIds', () => {
    Vitest.it.effect('extracts page IDs', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.relationIds)(relationProperty)
        expect(result).toEqual(['page-1', 'page-2'])
      }),
    )
  })

  Vitest.describe('NotionSchema.relationSingle', () => {
    Vitest.it.effect('extracts single relation object', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.relationSingle)(
          singleRelationProperty,
        )
        expect(result).toEqual({ id: 'page-1' })
      }),
    )

    Vitest.it.effect('fails for multiple relations', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.relationSingle)(
          relationProperty,
        ).pipe(Effect.result)
        expect(result._tag).toBe('Failure')
      }),
    )
  })

  Vitest.describe('NotionSchema.relationSingleId', () => {
    Vitest.it.effect('extracts single relation ID', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.relationSingleId)(
          singleRelationProperty,
        )
        expect(result).toBe('page-1')
      }),
    )

    Vitest.it.effect('fails for multiple relations', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.relationSingleId)(
          relationProperty,
        ).pipe(Effect.result)
        expect(result._tag).toBe('Failure')
      }),
    )
  })

  Vitest.describe('NotionSchema.relationSingleOption', () => {
    Vitest.it.effect('returns Some for single relation', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.relationSingleOption)(
          singleRelationProperty,
        )
        expect(Option.isSome(result)).toBe(true)
        expect(Option.getOrThrow(result)).toEqual({ id: 'page-1' })
      }),
    )

    Vitest.it.effect('returns None for empty relation', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.relationSingleOption)({
          id: 'relation',
          type: 'relation' as const,
          relation: [],
        })
        expect(Option.isNone(result)).toBe(true)
      }),
    )

    Vitest.it.effect('fails for multiple relations', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.relationSingleOption)(
          relationProperty,
        ).pipe(Effect.result)
        expect(result._tag).toBe('Failure')
      }),
    )
  })

  Vitest.describe('NotionSchema.relationSingleIdOption', () => {
    Vitest.it.effect('returns Some for single relation', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.relationSingleIdOption)(
          singleRelationProperty,
        )
        expect(Option.isSome(result)).toBe(true)
        expect(Option.getOrThrow(result)).toBe('page-1')
      }),
    )

    Vitest.it.effect('returns None for empty relation', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.relationSingleIdOption)({
          id: 'relation',
          type: 'relation' as const,
          relation: [],
        })
        expect(Option.isNone(result)).toBe(true)
      }),
    )

    Vitest.it.effect('fails for multiple relations', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.relationSingleIdOption)(
          relationProperty,
        ).pipe(Effect.result)
        expect(result._tag).toBe('Failure')
      }),
    )
  })

  Vitest.describe('NotionSchema.relationWriteFromIds', () => {
    Vitest.it.effect('encodes page IDs to write payload', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(NotionSchema.relationWriteFromIds)([
          'rel-1',
          'rel-2',
        ])
        expect(result).toEqual({
          relation: [{ id: 'rel-1' }, { id: 'rel-2' }],
        })
      }),
    )

    Vitest.it.effect('roundtrip: encode and decode', () =>
      Effect.gen(function* () {
        const original = ['xyz-789', 'uvw-101']
        const encoded = yield* Schema.decodeEffect(NotionSchema.relationWriteFromIds)(original)
        const decoded = yield* Schema.encodeEffect(NotionSchema.relationWriteFromIds)(encoded)
        expect(decoded).toEqual(original)
      }),
    )
  })
})
