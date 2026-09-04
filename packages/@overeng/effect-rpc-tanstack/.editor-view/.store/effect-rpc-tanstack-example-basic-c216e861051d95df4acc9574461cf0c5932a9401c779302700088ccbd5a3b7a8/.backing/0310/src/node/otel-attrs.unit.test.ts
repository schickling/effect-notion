import { DateTime, Duration, Effect, Option, Redacted, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { expectTrace } from '@overeng/utils-dev/otelite'

import {
  OtelAttr,
  OtelAttrEncodeError,
  OtelAttrPlanError,
  OtelAttrs,
  OtelSpan,
} from './otel-attrs.ts'

describe('OtelAttrs', () => {
  it('derives primitive, literal, uuid, option, date, duration, and explicit array attributes', async () => {
    const Attrs = Schema.Struct({
      label: Schema.NonEmptyString.pipe(Schema.check(Schema.isTrimmed()), OtelAttr.spanLabel()),
      requestId: Schema.String.pipe(
        Schema.check(Schema.isUUID()),
        OtelAttr.key({ key: 'request.id' }),
      ),
      outcome: Schema.Literals(['approved', 'denied', 'timeout']).pipe(
        OtelAttr.key({ key: 'op.outcome' }),
      ),
      count: Schema.Int.pipe(
        Schema.check(Schema.isGreaterThanOrEqualTo(0)),
        OtelAttr.key({ key: 'op.count' }),
      ),
      cacheHit: Schema.Boolean.pipe(OtelAttr.key({ key: 'op.cache_hit' })),
      maybeShard: Schema.OptionFromNullOr(Schema.String).pipe(OtelAttr.key({ key: 'op.shard' })),
      at: Schema.DateTimeUtc.pipe(OtelAttr.key({ key: 'op.at' })),
      latency: Schema.DurationFromMillis.pipe(OtelAttr.key({ key: 'op.latency_ms' })),
      tags: Schema.Array(Schema.String).pipe(OtelAttr.key({ key: 'op.tags', encode: 'json' })),
    })
    const attrs = await Effect.runPromise(OtelAttrs.define(Attrs))
    const at = DateTime.makeUnsafe('2026-06-11T10:00:00.000Z')

    await expect(
      Effect.runPromise(
        attrs.encode({
          label: 'submit',
          requestId: '123e4567-e89b-12d3-a456-426614174000',
          outcome: 'approved',
          count: 2,
          cacheHit: false,
          maybeShard: Option.some('dev3'),
          at,
          latency: Duration.millis(42),
          tags: ['safe', 'bounded'],
        }),
      ),
    ).resolves.toEqual({
      'span.label': 'submit',
      'request.id': '123e4567-e89b-12d3-a456-426614174000',
      'op.outcome': 'approved',
      'op.count': 2,
      'op.cache_hit': false,
      'op.shard': 'dev3',
      'op.at': '2026-06-11T10:00:00.000Z',
      'op.latency_ms': 42,
      'op.tags': '["safe","bounded"]',
    })

    await expect(
      Effect.runPromise(
        attrs.encode({
          label: 'submit',
          requestId: '123e4567-e89b-12d3-a456-426614174000',
          outcome: 'approved',
          count: 2,
          cacheHit: false,
          maybeShard: Option.none(),
          at,
          latency: Duration.millis(42),
          tags: [],
        }),
      ),
    ).resolves.not.toHaveProperty('op.shard')
  })

  it('rejects unsafe schemas unless policy is explicit', async () => {
    await expect(
      Effect.runPromise(
        Effect.result(
          OtelAttrs.define(
            Schema.Struct({
              nested: Schema.Struct({ id: Schema.String }).pipe(OtelAttr.key({ key: 'nested' })),
            }),
          ),
        ),
      ),
    ).resolves.toMatchObject({
      _tag: 'Failure',
      failure: expect.any(OtelAttrPlanError),
    })

    await expect(
      Effect.runPromise(
        Effect.result(
          OtelAttrs.define(
            Schema.Struct({
              secret: Schema.Redacted(Schema.String).pipe(OtelAttr.key({ key: 'secret' })),
            }),
          ),
        ),
      ),
    ).resolves.toMatchObject({
      _tag: 'Failure',
      failure: expect.any(OtelAttrPlanError),
    })

    await expect(
      Effect.runPromise(
        Effect.result(
          OtelAttrs.define(
            Schema.Struct({
              tags: Schema.Array(Schema.String).pipe(OtelAttr.key({ key: 'tags' })),
            }),
          ),
        ),
      ),
    ).resolves.toMatchObject({
      _tag: 'Failure',
      failure: expect.any(OtelAttrPlanError),
    })
  })

  it('allows explicit redacted and json policies', async () => {
    const Attrs = Schema.Struct({
      secret: Schema.Redacted(Schema.String).pipe(
        OtelAttr.key({ key: 'secret', encode: 'redacted' }),
      ),
      nested: Schema.Struct({ id: Schema.String }).pipe(
        OtelAttr.key({ key: 'nested', encode: 'json' }),
      ),
    })
    const attrs = await Effect.runPromise(OtelAttrs.define(Attrs))

    await expect(
      Effect.runPromise(
        attrs.encode({
          secret: Redacted.make('do-not-leak'),
          nested: { id: 'n1' },
        }),
      ),
    ).resolves.toEqual({
      secret: '<redacted>',
      nested: '{"id":"n1"}',
    })
  })

  it('only allows redacted-safe policies for redacted values', async () => {
    await expect(
      Effect.runPromise(
        Effect.result(
          OtelAttrs.define(
            Schema.Struct({
              secret: Schema.Redacted(Schema.String).pipe(
                OtelAttr.key({ key: 'secret', encode: 'json' }),
              ),
            }),
          ),
        ),
      ),
    ).resolves.toMatchObject({
      _tag: 'Failure',
      failure: expect.any(OtelAttrPlanError),
    })

    const attrs = await Effect.runPromise(
      OtelAttrs.define(
        Schema.Struct({
          secret: Schema.Redacted(Schema.String).pipe(
            OtelAttr.key({ key: 'secret', encode: 'drop' }),
          ),
        }),
      ),
    )

    await expect(
      Effect.runPromise(attrs.encode({ secret: Redacted.make('do-not-leak') })),
    ).resolves.toEqual({})
  })

  it('surfaces encoding errors on the error channel', async () => {
    const Attrs = Schema.Struct({
      count: Schema.Finite.pipe(OtelAttr.key({ key: 'count' })),
    })
    const attrs = await Effect.runPromise(OtelAttrs.define(Attrs))

    await expect(
      Effect.runPromise(Effect.result(attrs.encode({ count: Number.NaN }))),
    ).resolves.toMatchObject({
      _tag: 'Failure',
      failure: expect.any(OtelAttrEncodeError),
    })
  })

  it('validates explicit policy inputs before encoding', async () => {
    const Attrs = Schema.Struct({
      asJson: Schema.Struct({ id: Schema.String }).pipe(
        OtelAttr.key({ key: 'json', encode: 'json' }),
      ),
      asString: Schema.Int.pipe(
        Schema.check(Schema.isGreaterThanOrEqualTo(0)),
        OtelAttr.key({ key: 'string', encode: 'string' }),
      ),
      asNumber: Schema.Int.pipe(
        Schema.check(Schema.isGreaterThanOrEqualTo(0)),
        OtelAttr.key({ key: 'number', encode: 'number' }),
      ),
      asBoolean: Schema.Boolean.pipe(OtelAttr.key({ key: 'boolean', encode: 'boolean' })),
      secret: Schema.Redacted(Schema.String).pipe(
        OtelAttr.key({ key: 'secret', encode: 'redacted' }),
      ),
    })
    const attrs = await Effect.runPromise(OtelAttrs.define(Attrs))

    const invalidInputs = [
      {
        asJson: { id: 1 },
        asString: 1,
        asNumber: 1,
        asBoolean: true,
        secret: Redacted.make('ok'),
      },
      {
        asJson: { id: 'ok' },
        asString: -1,
        asNumber: 1,
        asBoolean: true,
        secret: Redacted.make('ok'),
      },
      {
        asJson: { id: 'ok' },
        asString: 1,
        asNumber: Number.NaN,
        asBoolean: true,
        secret: Redacted.make('ok'),
      },
      {
        asJson: { id: 'ok' },
        asString: 1,
        asNumber: 1,
        asBoolean: 'true',
        secret: Redacted.make('ok'),
      },
      {
        asJson: { id: 'ok' },
        asString: 1,
        asNumber: 1,
        asBoolean: true,
        secret: Redacted.make(1),
      },
    ]
    const results = await Promise.all(
      invalidInputs.map((invalid) =>
        Effect.runPromise(Effect.result(attrs.encode(invalid as never))),
      ),
    )

    for (const result of results) {
      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: expect.any(OtelAttrEncodeError),
      })
    }
  })

  it('feeds compiled attributes into otelite trace expectations', async () => {
    const attrs = await Effect.runPromise(
      OtelAttrs.define(
        Schema.Struct({
          label: Schema.String.pipe(OtelAttr.spanLabel()),
          count: Schema.Int.pipe(
            Schema.check(Schema.isGreaterThanOrEqualTo(0)),
            OtelAttr.key({ key: 'retry.count' }),
          ),
        }),
      ),
    )
    const span = OtelSpan.define({ name: 'rpc.op.submit', attributes: attrs })
    const trace = expectTrace([
      {
        schema: 'otelite.span/v1',
        service: 'op-proxy',
        name: 'rpc.op.submit',
        trace_id: 'trace-1',
        span_id: 'span-1',
        parent_span_id: null,
        start_unix_nano: '1',
        end_unix_nano: '2',
        duration_ms: 1,
        status_code: 0,
        attrs: {
          'span.label': 'read',
          'retry.count': '2',
        },
      },
    ])

    expect(
      trace.expectAttributes({
        attributes: attrs,
        match: { label: 'read', count: 2 },
      }),
    ).toHaveLength(1)
    expect(
      trace.expectSpan({
        span,
        match: { label: 'read', count: 2 },
      }).span_id,
    ).toBe('span-1')
  })
})

describe('OtelSpan', () => {
  it('wraps effects with schema-backed attributes', async () => {
    const Attrs = await Effect.runPromise(
      OtelAttrs.define(
        Schema.Struct({
          label: Schema.String.pipe(OtelAttr.spanLabel()),
        }),
      ),
    )
    const span = OtelSpan.define({ name: 'test.span', attributes: Attrs })

    await expect(
      Effect.runPromise(
        OtelSpan.with({
          span,
          attributes: { label: 'contract' },
          effect: Effect.succeed('ok'),
        }),
      ),
    ).resolves.toBe('ok')

    await expect(
      Effect.runPromise(
        Effect.succeed('ok').pipe(OtelSpan.with({ span, attributes: { label: 'pipe' } })),
      ),
    ).resolves.toBe('ok')
  })

  it('requires span.label at definition and runtime', async () => {
    const WithoutLabel = await Effect.runPromise(
      OtelAttrs.define(
        Schema.Struct({
          value: Schema.String.pipe(OtelAttr.key({ key: 'value' })),
        }),
      ),
    )
    expect(() => OtelSpan.define({ name: 'test.no-label', attributes: WithoutLabel })).toThrow(
      OtelAttrPlanError,
    )

    const AccidentalLabel = await Effect.runPromise(
      OtelAttrs.define(
        Schema.Struct({
          value: Schema.String.pipe(OtelAttr.key({ key: 'span.label' })),
        }),
      ),
    )
    expect(() =>
      OtelSpan.define({ name: 'test.accidental-label', attributes: AccidentalLabel }),
    ).toThrow(OtelAttrPlanError)

    const WithOptionalLabel = await Effect.runPromise(
      OtelAttrs.define(
        Schema.Struct({
          label: Schema.optional(Schema.String.pipe(OtelAttr.spanLabel())),
        }),
      ),
    )
    const span = OtelSpan.define({ name: 'test.optional-label', attributes: WithOptionalLabel })

    await expect(
      Effect.runPromise(
        Effect.result(
          OtelSpan.with({
            span,
            attributes: {},
            effect: Effect.succeed('ok'),
          }),
        ),
      ),
    ).resolves.toMatchObject({
      _tag: 'Failure',
      failure: expect.any(OtelAttrEncodeError),
    })
  })
})
