import { Schema } from 'effect'

// TODO: Replace with proper utility function
const notYetImplemented = (): never => {
  throw new Error('Not yet implemented')
}

export const FileAttachment = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  files: Schema.Array(Schema.suspend(() => FileItem)),
}).annotations({ title: 'Notion.FileAttachment' })

export type FileAttachment = typeof FileAttachment.Type

export const FileAttachmentNonEmpty = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  files: Schema.NonEmptyArray(Schema.suspend(() => FileItem)),
}).annotations({ title: 'Notion.FileAttachmentNonEmpty' })

export type FileAttachmentNonEmpty = typeof FileAttachmentNonEmpty.Type

export const FileAttachmentSingle = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  files: Schema.Tuple(Schema.suspend(() => FileItem)),
}).annotations({ title: 'Notion.FileAttachmentSingle' })

export type FileAttachmentSingle = typeof FileAttachmentSingle.Type

export const FileItem = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  file: Schema.Struct({
    url: Schema.String,
    expiry_time: Schema.String,
  }),
}).annotations({ title: 'Notion.FileItem' })

export type FileItem = typeof FileItem.Type

export const RelationSingle = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal('relation'),
  relation: Schema.Tuple(Schema.Struct({ id: Schema.String })),
}).annotations({ title: 'Notion.Relation' })

export type RelationSingle = typeof RelationSingle.Type

export const NumberElement = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal('number'),
  number: Schema.NullOr(Schema.Number),
}).annotations({ title: 'Notion.NumberElement' })

export type NumberElement = typeof NumberElement.Type

export const NumberFromNumberElement = Schema.transform(NumberElement, Schema.NullOr(Schema.Number), {
  decode: (_) => _.number,
  encode: () => notYetImplemented(),
})

export const NumberFromNumberElementNonNull = NumberFromNumberElement.pipe(
  Schema.filter((_): _ is number => _ !== null),
)

export const FormulaElement = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal('formula'),
  formula: Schema.Struct({
    number: Schema.Number,
  }),
}).annotations({ title: 'Notion.FormulaElement' })

export type FormulaElement = typeof FormulaElement.Type

export const NumberFromFormulaElement = Schema.transform(FormulaElement, Schema.Number, {
  decode: (_) => _.formula.number,
  encode: () => notYetImplemented(),
})

export const RichTextElement = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal('rich_text'),
  rich_text: Schema.Array(Schema.suspend(() => RichText)),
}).annotations({ title: 'Notion.RichTextElement' })

export type RichTextElement = typeof RichTextElement.Type

export const StringFromRichTextElement = Schema.transform(RichTextElement, Schema.String, {
  decode: (_) => _.rich_text.map((_) => _.plain_text).join('\n'),
  encode: () => notYetImplemented(),
})

export const StringFromRichTextElementNonEmpty = StringFromRichTextElement.pipe(
  Schema.filter((_): _ is string => _.trim() !== ''),
)

export const CheckboxElement = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal('checkbox'),
  checkbox: Schema.Boolean,
}).annotations({ title: 'Notion.CheckboxElement' })

export type CheckboxElement = typeof CheckboxElement.Type

export const BooleanFromCheckboxElement = Schema.transform(CheckboxElement, Schema.Boolean, {
  decode: (_) => _.checkbox,
  encode: () => notYetImplemented(),
})

export const SelectElement = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal('select'),
  select: Schema.NullOr(Schema.suspend(() => SelectOption)),
}).annotations({ title: 'Notion.SelectElement' })

export type SelectElement = typeof SelectElement.Type

export const StringFromSelectElement = Schema.transform(SelectElement, Schema.NullOr(Schema.String), {
  decode: (_) => _.select?.name ?? null,
  encode: () => notYetImplemented(),
})

export const StringFromSelectElementNonNull = StringFromSelectElement.pipe(
  Schema.filter((_): _ is string => _ !== null),
)

export const StringLitFromSelectElement = <Literals extends ReadonlyArray<string | number | boolean>>(
  ...literals: Literals
) =>
  Schema.transform(SelectElement, Schema.NullOr(Schema.Literal(...literals)), {
    decode: (_) => _.select?.name ?? null,
    encode: () => notYetImplemented(),
  })

export const StringLitFromSelectElementNonNull = <Literals extends ReadonlyArray<string | number | boolean>>(
  ...literals: Literals
) => StringLitFromSelectElement(...literals).pipe(Schema.filter((_): _ is string => _ !== null))

export const MultiSelectElement = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal('multi_select'),
  multi_select: Schema.Array(Schema.suspend(() => SelectOption)),
}).annotations({ title: 'Notion.MultiSelectElement' })

export type MultiSelectElement = typeof MultiSelectElement.Type

export const TitleElement = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal('title'),
  title: Schema.NonEmptyArray(Schema.suspend(() => RichText)),
}).annotations({ title: 'Notion.TitleElement' })

export type TitleElement = typeof TitleElement.Type

export const StringFromTitleElement = Schema.transform(TitleElement, Schema.String, {
  decode: (_) =>
    _.title
      .filter((_) => _.plain_text !== '')
      .map((_) => _.plain_text)
      .join(' '),
  encode: () => notYetImplemented(),
})

export const RichText = Schema.Struct({
  type: Schema.String,
  text: Schema.Struct({
    content: Schema.String,
    link: Schema.NullOr(Schema.Any),
  }),
  annotations: Schema.Struct({
    bold: Schema.Boolean,
    italic: Schema.Boolean,
    strikethrough: Schema.Boolean,
    underline: Schema.Boolean,
    code: Schema.Boolean,
    color: Schema.String,
  }),
  plain_text: Schema.String,
  href: Schema.NullOr(Schema.Any),
}).annotations({ title: 'Notion.RichText' })

export type RichText = typeof RichText.Type

export const SelectOption = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  color: Schema.String,
}).annotations({ title: 'Notion.SelectOption' })

export type SelectOption = typeof SelectOption.Type

export const DateElement = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal('date'),
  date: Schema.NullOr(
    Schema.Struct({
      start: Schema.Date,
      end: Schema.NullOr(Schema.Date),
      time_zone: Schema.NullOr(Schema.String),
    }),
  ),
}).annotations({ title: 'Notion.DateElement' })

export type DateElement = typeof DateElement.Type

export const DateElementNonNull = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal('date'),
  date: Schema.Struct({
    start: Schema.Date,
    end: Schema.NullOr(Schema.Date),
    time_zone: Schema.NullOr(Schema.String),
  }),
}).annotations({ title: 'Notion.DateElementNonNull' })

export type DateElementNonNull = typeof DateElementNonNull.Type

