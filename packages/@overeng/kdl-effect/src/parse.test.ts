import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { parseKdl } from './parse.ts'

describe('parseKdl', () => {
  describe('decode', () => {
    it('decodes simple struct', () => {
      const MySchema = Schema.Struct({
        name: Schema.String,
        age: Schema.Finite,
      })

      const result = Schema.decodeSync(parseKdl(MySchema))('name "Alice"\nage 30')
      expect(result).toEqual({ name: 'Alice', age: 30 })
    })

    it('decodes nested struct', () => {
      const MySchema = Schema.Struct({
        members: Schema.Record(Schema.String, Schema.String),
      })

      const result = Schema.decodeSync(parseKdl(MySchema))('members {\n  foo "bar"\n  baz "qux"\n}')
      expect(result).toEqual({ members: { foo: 'bar', baz: 'qux' } })
    })

    it('normalizes scalar to array when Schema expects array', () => {
      const MySchema = Schema.Struct({
        items: Schema.Array(Schema.String),
      })

      const result = Schema.decodeSync(parseKdl(MySchema))('items "hello"')
      expect(result).toEqual({ items: ['hello'] })
    })

    it('normalizes optional arrays nested in Schema classes', () => {
      class Nested extends Schema.Class<Nested>('Nested')({
        items: Schema.optional(Schema.Array(Schema.String)),
      }) {}
      const Outer = Schema.Struct({ nested: Nested })
      expect(Schema.decodeSync(parseKdl(Outer))('nested { items "a" }')).toEqual({
        nested: { items: ['a'] },
      })
    })

    it('handles multiple same-name nodes as array', () => {
      const MySchema = Schema.Struct({
        items: Schema.Array(Schema.String),
      })

      const result = Schema.decodeSync(parseKdl(MySchema))('items "a"\nitems "b"\nitems "c"')
      expect(result).toEqual({ items: ['a', 'b', 'c'] })
    })

    it('converts KDL parse errors to ParseError (not thrown)', () => {
      const MySchema = Schema.Struct({ name: Schema.String })

      expect(() => Schema.decodeSync(parseKdl(MySchema))('{')).toThrow()

      /* Verify it's a SchemaError (v4 renamed ParseError), not an InvalidKdlError */
      try {
        Schema.decodeSync(parseKdl(MySchema))('{')
      } catch (e) {
        expect(e).toBeInstanceOf(Error)
        expect((e as Error).name).toBe('SchemaError')
      }
    })

    it('decodes booleans and null', () => {
      const MySchema = Schema.Struct({
        enabled: Schema.Boolean,
        value: Schema.NullOr(Schema.String),
      })

      const result = Schema.decodeSync(parseKdl(MySchema))('enabled #true\nvalue #null')
      expect(result).toEqual({ enabled: true, value: null })
    })

    it('decodes optional fields', () => {
      const MySchema = Schema.Struct({
        name: Schema.String,
        age: Schema.optional(Schema.Finite),
      })

      const result = Schema.decodeSync(parseKdl(MySchema))('name "Alice"')
      expect(result).toEqual({ name: 'Alice' })
    })
  })

  describe('encode', () => {
    it('encodes simple struct to KDL', () => {
      const MySchema = Schema.Struct({
        name: Schema.String,
        age: Schema.Finite,
      })

      const kdl = Schema.encodeUnknownSync(parseKdl(MySchema))({ name: 'Alice', age: 30 })
      expect(typeof kdl).toBe('string')

      /* Round-trip: decode the encoded KDL back */
      const decoded = Schema.decodeSync(parseKdl(MySchema))(kdl)
      expect(decoded).toEqual({ name: 'Alice', age: 30 })
    })

    it('round-trips nested struct', () => {
      const MySchema = Schema.Struct({
        members: Schema.Record(Schema.String, Schema.String),
      })

      const original = { members: { foo: 'bar', baz: 'qux' } }
      const kdl = Schema.encodeUnknownSync(parseKdl(MySchema))(original)
      const decoded = Schema.decodeSync(parseKdl(MySchema))(kdl)
      expect(decoded).toEqual(original)
    })

    it('round-trips null values', () => {
      const MySchema = Schema.Struct({
        value: Schema.NullOr(Schema.String),
      })

      const original = { value: null }
      const kdl = Schema.encodeUnknownSync(parseKdl(MySchema))(original)
      const decoded = Schema.decodeSync(parseKdl(MySchema))(kdl)
      expect(decoded).toEqual(original)
    })

    it('round-trips arrays', () => {
      const MySchema = Schema.Struct({
        items: Schema.Array(Schema.String),
      })

      const original = { items: ['a', 'b', 'c'] }
      const kdl = Schema.encodeUnknownSync(parseKdl(MySchema))(original)
      const decoded = Schema.decodeSync(parseKdl(MySchema))(kdl)
      expect(decoded).toEqual(original)
    })
  })

  describe('edge cases', () => {
    it('decodes empty children block as empty object', () => {
      const MySchema = Schema.Struct({
        settings: Schema.Record(Schema.String, Schema.Unknown),
      })

      const result = Schema.decodeSync(parseKdl(MySchema))('settings {}')
      expect(result).toEqual({ settings: {} })
    })

    it('decodes node with properties and empty children', () => {
      const MySchema = Schema.Struct({
        vscode: Schema.Struct({
          enabled: Schema.Boolean,
        }),
      })

      const result = Schema.decodeSync(parseKdl(MySchema))('vscode enabled=#true {}')
      expect(result).toEqual({ vscode: { enabled: true } })
    })

    it('normalizes nested arrays inside array elements', () => {
      const MySchema = Schema.Struct({
        items: Schema.Array(Schema.Struct({ tags: Schema.Array(Schema.String) })),
      })

      const result = Schema.decodeSync(parseKdl(MySchema))('items {\n  tags "a"\n}')
      expect(result).toEqual({ items: [{ tags: ['a'] }] })
    })

    it('normalizes record values with array schemas', () => {
      const MySchema = Schema.Struct({
        groups: Schema.Record(Schema.String, Schema.Array(Schema.String)),
      })

      const result = Schema.decodeSync(parseKdl(MySchema))('groups {\n  admin "alice"\n}')
      expect(result).toEqual({ groups: { admin: ['alice'] } })
    })
  })
})
