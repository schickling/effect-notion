import { Schema } from 'effect'

// Placeholder for Effect schemas for Notion API primitives
// This will include schemas for CheckboxElement, TextElement, etc.

export const CheckboxElement = Schema.Struct({
  type: Schema.Literal('checkbox'),
  checkbox: Schema.Boolean,
})

export type TCheckboxElement = typeof CheckboxElement.Type

// TODO: Add more Notion primitive schemas
// - TextElement
// - NumberElement
// - SelectElement
// - MultiSelectElement
// - DateElement
// - PersonElement
// - FileElement
// - RelationElement
// - FormulaElement
// - RollupElement
// - CreatedTimeElement
// - CreatedByElement
// - LastEditedTimeElement
// - LastEditedByElement