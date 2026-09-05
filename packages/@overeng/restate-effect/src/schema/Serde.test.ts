import { it as fcIt } from '@effect/vitest'
import * as restate from '@restatedev/restate-sdk'
import { Schema } from 'effect'
import * as FastCheck from 'effect/testing/FastCheck'
import { describe, expect, it } from 'vitest'

import { normalizeStateSchema } from '../authoring/RestateContext.ts'
import { Restate } from './Annotations.ts'
import { aesGcmCipher } from './Redaction.ts'
import { effectSerde, ingressSerde, internalSerde } from './Serde.ts'

const textDecoder = new TextDecoder()
const textEncoder = new TextEncoder()

describe('effectSerde', () => {
  it('round-trips a plain struct', () => {
    const schema = Schema.Struct({ name: Schema.String, age: Schema.Finite })
    const serde = effectSerde({ schema })
    const value = { name: 'Sarah', age: 42 }
    const bytes = serde.serialize(value)
    expect(serde.deserialize(bytes)).toStrictEqual(value)
    expect(serde.contentType).toBe('application/json')
    expect(serde.jsonSchema).toBeDefined()
  })

  it('handles a transformed schema where encoded ≠ decoded', () => {
    /* Date <-> ISO string: encode produces the wire (`I`) shape, decode
     * reconstructs the rich (`A`) value. */
    const schema = Schema.Struct({ at: Schema.DateFromString })
    const serde = effectSerde({ schema })
    const value = { at: new Date('2026-06-08T12:00:00.000Z') }

    const bytes = serde.serialize(value)
    const wire = JSON.parse(new TextDecoder().decode(bytes)) as { at: string }
    expect(wire.at).toBe('2026-06-08T12:00:00.000Z')

    const back = serde.deserialize(bytes)
    expect(back.at).toBeInstanceOf(Date)
    expect(back.at.getTime()).toBe(value.at.getTime())
  })

  it('round-trips a branded schema', () => {
    const UserId = Schema.String.pipe(Schema.brand('UserId'))
    const schema = Schema.Struct({ id: UserId })
    const serde = effectSerde({ schema })
    const value = { id: Schema.decodeSync(UserId)('u_1') }
    expect(serde.deserialize(serde.serialize(value))).toStrictEqual(value)
  })

  it('honors the Restate.serde annotation contentType override', () => {
    const schema = Restate.serde({
      self: Schema.Struct({ n: Schema.Finite }),
      options: { contentType: 'application/vnd.custom+json' },
    })
    expect(effectSerde({ schema }).contentType).toBe('application/vnd.custom+json')
  })

  it('throws TerminalError(400) on a malformed INGRESS input', () => {
    const serde = ingressSerde({ schema: Schema.Struct({ n: Schema.Finite }) })
    const badBytes = new TextEncoder().encode(JSON.stringify({ n: 'not-a-number' }))
    try {
      serde.deserialize(badBytes)
      expect.unreachable('expected a TerminalError')
    } catch (error) {
      expect(error).toBeInstanceOf(restate.TerminalError)
      expect((error as restate.TerminalError).code).toBe(400)
    }
  })

  it('rethrows a raw defect (not a TerminalError) on a malformed INTERNAL slot', () => {
    /* A corrupt-journal decode failure must NOT become a 400 to the caller. */
    const serde = internalSerde({ schema: Schema.Struct({ n: Schema.Finite }) })
    const badBytes = new TextEncoder().encode(JSON.stringify({ n: 'not-a-number' }))
    try {
      serde.deserialize(badBytes)
      expect.unreachable('expected a thrown defect')
    } catch (error) {
      expect(error).not.toBeInstanceOf(restate.TerminalError)
    }
  })
})

describe('effectSerde wire baselines (cross-major invariant)', () => {
  const WireBaseline = Schema.Struct({
    at: Schema.DateFromString,
    note: Schema.optional(Schema.String),
    nullable: Schema.NullOr(Schema.String),
    empty: Schema.String,
    tags: Schema.Array(Schema.String),
    nested: Schema.Struct({
      impossibleDate: Schema.String,
      unicode: Schema.String,
    }),
  })

  it('serializes representative input bytes with stable key order and null/absent partition', () => {
    const serde = effectSerde({ schema: WireBaseline })
    const value = {
      at: new Date('2026-06-08T12:00:00.000Z'),
      nullable: null,
      empty: '',
      tags: ['alpha', 'ümlaut', '2026-02-31'],
      nested: {
        impossibleDate: '2026-02-31',
        unicode: 'Grüße 東京',
      },
    }

    const bytes = serde.serialize(value)

    expect(textDecoder.decode(bytes)).toMatchInlineSnapshot(
      `"{"at":"2026-06-08T12:00:00.000Z","nullable":null,"empty":"","tags":["alpha","ümlaut","2026-02-31"],"nested":{"impossibleDate":"2026-02-31","unicode":"Grüße 東京"}}"`,
    )
    expect(JSON.stringify(serde.deserialize(bytes))).toMatchInlineSnapshot(
      `"{"at":"2026-06-08T12:00:00.000Z","nullable":null,"empty":"","tags":["alpha","ümlaut","2026-02-31"],"nested":{"impossibleDate":"2026-02-31","unicode":"Grüße 東京"}}"`,
    )
  })

  it('serializes undefined input as empty bytes without a JSON content type', () => {
    const serde = effectSerde({ schema: Schema.Void })

    expect(serde.contentType).toBeUndefined()
    expect(textDecoder.decode(serde.serialize(undefined))).toMatchInlineSnapshot(`""`)
    expect(serde.deserialize(new Uint8Array())).toBeUndefined()
  })

  // Pins the v3 HTTP 400 parser rendering; #978's stable decode-error envelope
  // replaces this transport text when it lands.
  it('captures ingress decode failure transport bytes for invalid input', () => {
    const serde = ingressSerde({ schema: Schema.Struct({ n: Schema.Finite }) })
    const decodeFailure = (wire: string): restate.TerminalError => {
      try {
        serde.deserialize(textEncoder.encode(wire))
        return expect.unreachable(`expected TerminalError for ${wire}`)
      } catch (error) {
        expect(error).toBeInstanceOf(restate.TerminalError)
        return error as restate.TerminalError
      }
    }

    /* A schema mismatch renders entirely through Effect's issue formatter, so
     * the whole envelope is this package's own output and pins byte-exactly. */
    const wrongType = decodeFailure(JSON.stringify({ n: 'not-a-number' }))
    expect(
      JSON.stringify({
        code: wrongType.code,
        message: wrongType.message,
        metadata: wrongType.metadata ?? null,
      }),
    ).toMatchInlineSnapshot(
      `"{"code":400,"message":"serde decode failed: Expected number\\n  at [\\"n\\"]","metadata":{}}"`,
    )

    /* Malformed JSON never reaches the schema: the detail is the host engine's
     * own `SyntaxError.message` — "Unexpected end of JSON input" on V8,
     * "JSON Parse error: Unexpected EOF" on JavaScriptCore. Only the envelope
     * this package renders around it is a contract, so pin exactly that and
     * leave the engine's wording to the engine. */
    const malformedJson = decodeFailure('{"n":')
    expect(malformedJson.code).toBe(400)
    expect(malformedJson.metadata ?? null).toStrictEqual({})
    expect(malformedJson.message).toMatch(/^serde decode failed: .+/)
  })

  // Internal decode failure must stay outside #978's stable ingress 400
  // envelope; re-baseline only after confirming that partition survives.
  it('keeps internal decode failures out of the ingress 400 transport partition', () => {
    const serde = internalSerde({ schema: Schema.Struct({ n: Schema.Finite }) })

    try {
      serde.deserialize(textEncoder.encode(JSON.stringify({ n: 'not-a-number' })))
      expect.unreachable('expected a raw parse failure')
    } catch (error) {
      expect(
        JSON.stringify({
          terminal: error instanceof restate.TerminalError,
          message: error instanceof Error ? error.message : String(error),
        }),
      ).toMatchInlineSnapshot(`"{"terminal":false,"message":"Expected number\\n  at [\\"n\\"]"}"`)
    }
  })
})

describe('State.for optional field serde (papercut)', () => {
  it('a plain Schema state field passes through normalize unchanged', () => {
    const serde = effectSerde({ schema: normalizeStateSchema(Schema.Finite) })
    expect(serde.deserialize(serde.serialize(42))).toBe(42)
  })

  it('a Schema.optional state field round-trips its value type via the recovered schema', () => {
    /* `State.for({ note: Schema.optional(Schema.String) })` — the optional field's
     * value schema is recovered from the PropertySignature AST so the State serde
     * round-trips a present value. (Absent state is read as `undefined` by the
     * State combinator, which never reaches the serde.) */
    const serde = effectSerde({ schema: normalizeStateSchema(Schema.optional(Schema.String)) })
    expect(serde.deserialize(serde.serialize('hi'))).toBe('hi')
  })
})

/**
 * Property-based serde round-trips (docs/vrs/02-schema-serde/spec.md §1 + docs/vrs/09-testing/spec.md §3). The claim "`decode(encode(x))
 * ≡ x` over an `Arbitrary` derived from the schema is first-class" is made REAL
 * here: `@effect/vitest` `it.prop` derives a `fast-check` arbitrary from each
 * schema and asserts `deserialize(serialize(x))` is equivalent to `x` for every
 * generated value. Comparison uses `Schema.toEquivalence(schema)` — NOT
 * `toStrictEqual` — so transformed/branded values compare by their decoded VALUE,
 * the property that actually matters for a serde.
 */
describe('effectSerde property round-trips (docs/vrs/09-testing/spec.md §3)', () => {
  /* A plain struct of primitives. */
  const Plain = Schema.Struct({
    name: Schema.String,
    age: Schema.Int,
    active: Schema.Boolean,
    tags: Schema.Array(Schema.String),
  })
  fcIt.prop('round-trips a plain struct', [Schema.toArbitrary(Plain)(FastCheck)], ([value]) => {
    const serde = effectSerde({ schema: Plain })
    const eq = Schema.toEquivalence(Plain)
    expect(eq(serde.deserialize(serde.serialize(value)), value)).toBe(true)
  })

  /* A TRANSFORMED schema (encoded ≠ decoded): Date ↔ ISO, a bigint, a branded id. */
  const UserId = Schema.String.pipe(Schema.brand('UserId'))
  const Transformed = Schema.Struct({
    id: UserId,
    createdAt: Schema.DateFromString,
    score: Schema.BigIntFromString,
  })
  fcIt.prop(
    'round-trips a transformed schema (encoded ≠ decoded)',
    [Schema.toArbitrary(Transformed)(FastCheck)],
    ([value]) => {
      const serde = effectSerde({ schema: Transformed })
      const eq = Schema.toEquivalence(Transformed)
      expect(eq(serde.deserialize(serde.serialize(value)), value)).toBe(true)
    },
  )

  /* An OPTIONAL state field (the `normalizeStateSchema` papercut path): a present
   * value must round-trip through the recovered value schema. Constrained to a
   * FINITE number — `NaN`/`±Infinity` have no JSON representation (`JSON.stringify`
   * emits `null`), so they are outside the serde's round-trippable domain by
   * design, not a bug. */
  const FiniteValue = Schema.Finite
  const OptionalState = normalizeStateSchema(Schema.optional(FiniteValue))
  fcIt.prop(
    'round-trips an optional state field value (normalizeStateSchema)',
    [Schema.toArbitrary(FiniteValue)(FastCheck)],
    ([value]) => {
      const serde = effectSerde({ schema: OptionalState })
      const eq = Schema.toEquivalence(OptionalState)
      expect(eq(serde.deserialize(serde.serialize(value)), value)).toBe(true)
    },
  )

  /* CRITICAL: the redaction transform itself — `encrypt(decrypt(x)) ≡ x`. A fresh
   * IV per encrypt means the wire bytes differ each time, so the round-trip holds
   * by VALUE (the whole point of `Schema.toEquivalence` over byte equality). */
  const Redacted = Schema.Struct({
    to: Schema.String,
    body: Restate.sensitive(Schema.String),
    /* Finite — a redacted `NaN`/`±Infinity` JSON-stringifies to `null` inside the
     * cipher payload too, so it is outside the round-trippable domain by design. */
    pin: Restate.redacted(Schema.Finite),
  })
  const cipher = aesGcmCipher(new Uint8Array(32).fill(7))
  fcIt.prop(
    'round-trips the redaction transform by value (encrypt∘decrypt ≡ id)',
    [Schema.toArbitrary(Redacted)(FastCheck)],
    ([value]) => {
      const serde = effectSerde({ schema: Redacted, slot: 'internal', redaction: cipher })
      const eq = Schema.toEquivalence(Redacted)
      expect(eq(serde.deserialize(serde.serialize(value)), value)).toBe(true)
    },
  )
})
