import { DateTime, Duration, Effect, Metric, Option, Redacted, Schema, Stream } from 'effect'
import { describe, expect, it } from 'vitest'

import { expectTrace } from '@overeng/utils-dev/otelite'

const NonNegativeInt = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
)

import {
  type FleetServiceBinding,
  OtelAttr,
  OtelAttrEncodeError,
  OtelAttrPlanError,
  OtelAttrs,
  OtelAttributeKey,
  OtelMetric,
  OtelMetricName,
  OtelOperation,
  OtelServiceName,
  OtelSpan,
  OtelSpanName,
  ServiceIdentity,
  ServiceNameFromParts,
  serviceIdentityFromBinding,
} from './mod.ts'

describe('OTEL schema names', () => {
  it('exports branded refined schemas for contract names and keys', async () => {
    await expect(
      Effect.runPromise(Schema.decodeUnknownEffect(OtelAttributeKey)('service.name')),
    ).resolves.toBe('service.name')
    await expect(
      Effect.runPromise(Schema.decodeUnknownEffect(OtelAttributeKey)('notion-react.page_id')),
    ).resolves.toBe('notion-react.page_id')
    await expect(
      Effect.runPromise(Schema.decodeUnknownEffect(OtelSpanName)('notion-md.pull-page')),
    ).resolves.toBe('notion-md.pull-page')
    await expect(
      Effect.runPromise(Schema.decodeUnknownEffect(OtelMetricName)('restate_invocations_total')),
    ).resolves.toBe('restate_invocations_total')
    await expect(
      Effect.runPromise(Schema.decodeUnknownEffect(OtelServiceName)('notion-md-cli')),
    ).resolves.toBe('notion-md-cli')
  })

  it('rejects invalid contract names and attribute keys at definition time', async () => {
    await expect(
      Effect.runPromise(
        Effect.result(
          OtelAttrs.define(
            Schema.Struct({
              value: OtelAttr.string({ key: 'bad key' }),
            }),
          ),
        ),
      ),
    ).resolves.toMatchObject({
      _tag: 'Failure',
      failure: expect.any(OtelAttrPlanError),
    })

    const SpanAttrs = OtelAttrs.defineSync(
      Schema.Struct({
        label: OtelAttr.string({ key: 'span.label', metadata: { role: 'span.label' } }),
      }),
    )

    expect(() => OtelSpan.define({ name: ' ', attributes: SpanAttrs })).toThrow(OtelAttrPlanError)
    expect(() =>
      OtelOperation.define({
        name: 'bad\noperation',
        schema: Schema.Struct({ value: OtelAttr.string({ key: 'test.value' }) }),
        label: ({ value }) => value,
      }),
    ).toThrow(OtelAttrPlanError)
    expect(() =>
      OtelMetric.counter({
        name: 'bad metric',
        labels: Schema.Struct({
          status: OtelAttr.literal('status', 'ok', 'failed'),
        }),
      }),
    ).toThrow(OtelAttrPlanError)
  })
})

describe('ServiceIdentity', () => {
  it('decodes a valid identity into branded name/namespace/version', async () => {
    const identity = await Effect.runPromise(
      Schema.decodeUnknownEffect(ServiceIdentity)({
        name: 'megarepo',
        namespace: 'overeng',
        version: '1.2.3',
      }),
    )
    expect(identity).toEqual({ name: 'megarepo', namespace: 'overeng', version: '1.2.3' })
  })

  it('rejects an invalid (non-pattern) service name', async () => {
    await expect(
      Effect.runPromise(
        Effect.result(
          Schema.decodeUnknownEffect(ServiceIdentity)({
            name: 'bad name',
            namespace: 'overeng',
            version: '1.0.0',
          }),
        ),
      ),
    ).resolves.toMatchObject({ _tag: 'Failure' })
  })

  it('rejects empty namespace/version', async () => {
    for (const bad of [
      { name: 'svc', namespace: '', version: '1.0.0' },
      { name: 'svc', namespace: 'overeng', version: '' },
    ]) {
      await expect(
        Effect.runPromise(Effect.result(Schema.decodeUnknownEffect(ServiceIdentity)(bad))),
      ).resolves.toMatchObject({ _tag: 'Failure' })
    }
  })
})

describe('ServiceNameFromParts', () => {
  it('builds `<project>-<role>` and validates it through the OtelServiceName brand', async () => {
    const name = await Effect.runPromise(
      Schema.decodeEffect(ServiceNameFromParts)({ project: 'my-project', role: 'worker' }),
    )
    expect(name).toBe('my-project-worker')
    // The result is a real OtelServiceName (decodes through the brand unchanged).
    await expect(
      Effect.runPromise(Schema.decodeUnknownEffect(OtelServiceName)(name)),
    ).resolves.toBe('my-project-worker')
  })

  it('rejects an empty or whitespace part as a decode failure', async () => {
    // Trailing-hyphen trap: an empty role composes to `"my-project-"`, which the
    // OtelServiceName pattern alone admits — the part-level validation is what
    // makes this a failure.
    for (const bad of [
      { project: 'my-project', role: '' },
      { project: 'my-project', role: '   ' },
      { project: '', role: 'worker' },
      { project: '  ', role: 'worker' },
    ]) {
      await expect(
        Effect.runPromise(Effect.result(Schema.decodeEffect(ServiceNameFromParts)(bad))),
      ).resolves.toMatchObject({ _tag: 'Failure' })
    }
  })

  it('rejects a composed name that violates the naming law', async () => {
    // A leading digit project breaks the brand's `^[A-Za-z]` law once joined.
    await expect(
      Effect.runPromise(
        Effect.result(
          Schema.decodeEffect(ServiceNameFromParts)({ project: '1bad', role: 'worker' }),
        ),
      ),
    ).resolves.toMatchObject({ _tag: 'Failure' })
  })
})

describe('serviceIdentityFromBinding', () => {
  it('assembles a ServiceIdentity that stamps the right service.* attributes', async () => {
    const binding: FleetServiceBinding = {
      project: 'my-project',
      role: 'worker',
      namespace: 'acme',
      version: '1.2.3',
    }
    const identity = await Effect.runPromise(serviceIdentityFromBinding(binding))
    expect(identity).toEqual({ name: 'my-project-worker', namespace: 'acme', version: '1.2.3' })
    // Re-decoding through the struct confirms the result is a valid ServiceIdentity.
    await expect(
      Effect.runPromise(Schema.decodeUnknownEffect(ServiceIdentity)(identity)),
    ).resolves.toEqual(identity)
  })

  it('fails on a malformed part/namespace/version at the edge', async () => {
    for (const bad of [
      { project: 'my-project', role: '', namespace: 'acme', version: '1.0.0' },
      { project: 'my-project', role: 'worker', namespace: '', version: '1.0.0' },
      { project: 'my-project', role: 'worker', namespace: 'acme', version: '' },
    ] satisfies ReadonlyArray<FleetServiceBinding>) {
      await expect(
        Effect.runPromise(Effect.result(serviceIdentityFromBinding(bad))),
      ).resolves.toMatchObject({ _tag: 'Failure' })
    }
  })
})

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
      count: NonNegativeInt.pipe(OtelAttr.key({ key: 'op.count' })),
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
      // @effect-diagnostics-next-line schemaNumber:off -- deliberately accepts non-finite values; this test encodes NaN to assert the error-channel path
      count: Schema.Number.pipe(OtelAttr.key({ key: 'count' })),
    })
    const attrs = await Effect.runPromise(OtelAttrs.define(Attrs))

    await expect(
      Effect.runPromise(Effect.result(attrs.encode({ count: Number.NaN }))),
    ).resolves.toMatchObject({
      _tag: 'Failure',
      failure: expect.any(OtelAttrEncodeError),
    })
  })

  it('preserves typed contract errors in sync APIs', async () => {
    expect(() =>
      OtelAttrs.defineSync(
        Schema.Struct({
          nested: Schema.Struct({ id: Schema.String }).pipe(OtelAttr.key({ key: 'nested' })),
        }),
      ),
    ).toThrow(OtelAttrPlanError)

    const attrs = await Effect.runPromise(
      OtelAttrs.define(
        Schema.Struct({
          // @effect-diagnostics-next-line schemaNumber:off -- intentionally uses Schema.Number so NaN reaches encodeSync/unsafeEncode below
          count: Schema.Number.pipe(OtelAttr.key({ key: 'count' })),
        }),
      ),
    )

    expect(() => attrs.encodeSync({ count: Number.NaN })).toThrow(OtelAttrEncodeError)
    expect(() => attrs.unsafeEncode({ count: Number.NaN })).toThrow(OtelAttrEncodeError)
  })

  it('validates explicit policy inputs before encoding', async () => {
    const Attrs = Schema.Struct({
      asJson: Schema.Struct({ id: Schema.String }).pipe(
        OtelAttr.key({ key: 'json', encode: 'json' }),
      ),
      asString: NonNegativeInt.pipe(OtelAttr.key({ key: 'string', encode: 'string' })),
      asNumber: NonNegativeInt.pipe(OtelAttr.key({ key: 'number', encode: 'number' })),
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
          count: NonNegativeInt.pipe(OtelAttr.key({ key: 'retry.count' })),
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

  it('exposes compiled metadata for docs, lint, and future metric contracts', async () => {
    const attrs = await Effect.runPromise(
      OtelAttrs.define(
        Schema.Struct({
          label: Schema.NonEmptyString.pipe(Schema.check(Schema.isTrimmed()), OtelAttr.spanLabel()),
          outcome: OtelAttr.literal('op.outcome', 'success', 'retryable', 'terminal'),
          cacheHit: OtelAttr.boolean({ key: 'op.cache_hit' }),
          requestId: OtelAttr.string({ key: 'request.id', metadata: { cardinality: 'high' } }),
          payload: OtelAttr.json({
            key: 'op.payload',
            schema: Schema.Struct({ id: Schema.String }),
          }),
        }),
      ),
    )

    expect(attrs.fields).toMatchInlineSnapshot(`
      [
        {
          "astTag": "String",
          "attrKey": "span.label",
          "encodePolicy": "auto",
          "optional": false,
          "role": "span.label",
          "sourceKey": "label",
        },
        {
          "astTag": "Union",
          "attrKey": "op.outcome",
          "cardinality": "bounded",
          "encodePolicy": "auto",
          "optional": false,
          "sourceKey": "outcome",
        },
        {
          "astTag": "Boolean",
          "attrKey": "op.cache_hit",
          "cardinality": "low",
          "encodePolicy": "auto",
          "optional": false,
          "sourceKey": "cacheHit",
        },
        {
          "astTag": "String",
          "attrKey": "request.id",
          "cardinality": "high",
          "encodePolicy": "auto",
          "optional": false,
          "sourceKey": "requestId",
        },
        {
          "astTag": "Objects",
          "attrKey": "op.payload",
          "encodePolicy": "json",
          "optional": false,
          "sourceKey": "payload",
        },
      ]
    `)
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

  it('wraps streams with schema-backed attributes', async () => {
    const span = OtelSpan.defineSync({
      name: 'test.stream',
      schema: Schema.Struct({
        label: OtelAttr.string({ key: 'span.label', metadata: { role: 'span.label' } }),
        count: OtelAttr.number({ key: 'stream.count' }),
      }),
    })

    await expect(
      Effect.runPromise(
        Stream.fromIterable([1, 2]).pipe(
          OtelSpan.withStream({ span, attributes: { label: 'items', count: 2 } }),
          Stream.runCollect,
        ),
      ),
    ).resolves.toBeDefined()
  })
})

describe('OtelOperation', () => {
  it('defines the normal user-facing operation API without a schema-level span label', async () => {
    const PullPage = OtelOperation.define({
      name: 'notion-md.pull-page',
      schema: Schema.Struct({
        pageId: OtelAttr.string({ key: 'notion_md.page_id', metadata: { cardinality: 'high' } }),
        basename: OtelAttr.string({ key: 'notion_md.path.basename' }),
        cacheHit: OtelAttr.boolean({ key: 'notion_md.cache_hit' }),
        outcome: OtelAttr.literal('notion_md.outcome', 'created', 'updated', 'skipped'),
      }),
      label: ({ basename }) => basename,
    })

    await expect(
      Effect.runPromise(
        PullPage.encode({
          pageId: 'page-1',
          basename: 'README.md',
          cacheHit: true,
          outcome: 'updated',
        }),
      ),
    ).resolves.toEqual({
      'span.label': 'README.md',
      'notion_md.page_id': 'page-1',
      'notion_md.path.basename': 'README.md',
      'notion_md.cache_hit': true,
      'notion_md.outcome': 'updated',
    })

    await expect(
      Effect.runPromise(
        PullPage.with({
          attributes: {
            pageId: 'page-1',
            basename: 'README.md',
            cacheHit: true,
            outcome: 'updated',
          },
          effect: Effect.succeed('ok'),
        }),
      ),
    ).resolves.toBe('ok')

    await expect(
      Effect.runPromise(
        Effect.succeed('ok').pipe(
          PullPage.with({
            pageId: 'page-1',
            basename: 'README.md',
            cacheHit: true,
            outcome: 'updated',
          }),
        ),
      ),
    ).resolves.toBe('ok')

    expect(PullPage.metadata).toMatchObject({
      kind: 'operation',
      name: 'notion-md.pull-page',
      root: false,
      derivesSpanLabel: true,
      attributeKeys: [
        'notion_md.page_id',
        'notion_md.path.basename',
        'notion_md.cache_hit',
        'notion_md.outcome',
        'span.label',
      ],
    })
  })

  it('rejects empty derived labels', async () => {
    const Operation = OtelOperation.define({
      name: 'test.empty-label',
      schema: Schema.Struct({
        value: OtelAttr.string({ key: 'test.value' }),
      }),
      label: () => '   ',
    })

    await expect(
      Effect.runPromise(Effect.result(Operation.encode({ value: 'ok' }))),
    ).resolves.toMatchObject({
      _tag: 'Failure',
      failure: expect.any(OtelAttrEncodeError),
    })
  })

  it('wraps root spans and streams through the operation contract', async () => {
    const Operation = OtelOperation.define({
      name: 'test.operation.stream',
      schema: Schema.Struct({
        value: OtelAttr.string({ key: 'test.value' }),
      }),
      label: ({ value }) => value,
    })

    await expect(
      Effect.runPromise(
        Operation.withRoot({
          attributes: { value: 'root' },
          effect: Effect.succeed('ok'),
        }),
      ),
    ).resolves.toBe('ok')

    await expect(
      Effect.runPromise(
        Stream.fromIterable(['a', 'b']).pipe(
          Operation.withStream({ value: 'stream' }),
          Stream.runCollect,
        ),
      ),
    ).resolves.toBeDefined()
  })
})

describe('OtelMetric', () => {
  it('defines runtime-light counter metadata with schema-backed labels', async () => {
    const Invocations = OtelMetric.counter({
      name: 'restate_invocations_total',
      description: 'Restate invocations by service, handler, and outcome.',
      unit: '1',
      labels: Schema.Struct({
        service: OtelAttr.string({ key: 'restate.service', metadata: { cardinality: 'bounded' } }),
        handler: OtelAttr.string({ key: 'restate.handler', metadata: { cardinality: 'bounded' } }),
        outcome: OtelAttr.literal(
          'restate.outcome',
          'success',
          'terminal',
          'retryable',
          'cancelled',
        ),
        cacheHit: OtelAttr.boolean({ key: 'restate.cache_hit' }),
      }),
    })

    await expect(
      Effect.runPromise(
        Invocations.encodeLabels({
          service: 'notion-sync',
          handler: 'pull',
          outcome: 'success',
          cacheHit: true,
        }),
      ),
    ).resolves.toEqual({
      'restate.service': 'notion-sync',
      'restate.handler': 'pull',
      'restate.outcome': 'success',
      'restate.cache_hit': true,
    })

    expect(Invocations.metadata).toMatchInlineSnapshot(`
      {
        "description": "Restate invocations by service, handler, and outcome.",
        "instrument": "counter",
        "kind": "metric",
        "labelKeys": [
          "restate.service",
          "restate.handler",
          "restate.outcome",
          "restate.cache_hit",
        ],
        "labels": [
          {
            "astTag": "String",
            "attrKey": "restate.service",
            "cardinality": "bounded",
            "encodePolicy": "auto",
            "optional": false,
            "sourceKey": "service",
          },
          {
            "astTag": "String",
            "attrKey": "restate.handler",
            "cardinality": "bounded",
            "encodePolicy": "auto",
            "optional": false,
            "sourceKey": "handler",
          },
          {
            "astTag": "Union",
            "attrKey": "restate.outcome",
            "cardinality": "bounded",
            "encodePolicy": "auto",
            "optional": false,
            "sourceKey": "outcome",
          },
          {
            "astTag": "Boolean",
            "attrKey": "restate.cache_hit",
            "cardinality": "low",
            "encodePolicy": "auto",
            "optional": false,
            "sourceKey": "cacheHit",
          },
        ],
        "name": "restate_invocations_total",
        "unit": "1",
      }
    `)

    await expect(
      Effect.runPromise(
        Invocations.tagPairs({
          service: 'notion-sync',
          handler: 'pull',
          outcome: 'success',
          cacheHit: true,
        }),
      ),
    ).resolves.toEqual([
      ['restate.service', 'notion-sync'],
      ['restate.handler', 'pull'],
      ['restate.outcome', 'success'],
      ['restate.cache_hit', 'true'],
    ])

    await expect(
      Effect.runPromise(
        Invocations.trustedTagPairs({
          service: 'notion-sync',
          handler: 'pull',
          outcome: 'success',
          cacheHit: true,
        }),
      ),
    ).resolves.toEqual([
      ['restate.service', 'notion-sync'],
      ['restate.handler', 'pull'],
      ['restate.outcome', 'success'],
      ['restate.cache_hit', 'true'],
    ])
  })

  it('defines histogram metadata without owning runtime emission', () => {
    const labels = OtelMetric.labels(
      Schema.Struct({
        operation: OtelAttr.literal('operation', 'pull', 'push'),
      }),
    )
    const DurationMs = OtelMetric.histogram({
      name: 'operation_duration_ms',
      description: 'Operation duration.',
      unit: 'ms',
      boundaries: [10, 50, 100, 500, 1000],
      labels,
    })

    expect(DurationMs).not.toHaveProperty('increment')
    expect(DurationMs).not.toHaveProperty('record')
    expect(DurationMs.metadata).toMatchObject({
      kind: 'metric',
      instrument: 'histogram',
      name: 'operation_duration_ms',
      unit: 'ms',
      labelKeys: ['operation'],
      boundaries: [10, 50, 100, 500, 1000],
    })
  })

  it('defines gauge metadata without owning runtime emission', () => {
    const RssBytes = OtelMetric.gauge({
      name: 'store_gc_rss_bytes',
      description: 'Resident set size sampled during a run.',
      unit: 'By',
      labels: Schema.Struct({
        operation: OtelAttr.literal('operation', 'gc', 'status'),
      }),
    })

    expect(RssBytes).not.toHaveProperty('set')
    expect(RssBytes.metadata).toMatchObject({
      kind: 'metric',
      instrument: 'gauge',
      name: 'store_gc_rss_bytes',
      unit: 'By',
      labelKeys: ['operation'],
    })
  })

  it('brands and decodes gauge metric names', async () => {
    const Gauge = OtelMetric.gauge({
      name: 'store_gc_rss_bytes',
      labels: Schema.Struct({
        operation: OtelAttr.literal('operation', 'gc', 'status'),
      }),
    })
    expect(Gauge.name).toBe('store_gc_rss_bytes')
    await expect(
      Effect.runPromise(Schema.decodeUnknownEffect(OtelMetricName)(Gauge.name)),
    ).resolves.toBe('store_gc_rss_bytes')
    expect(() => OtelMetric.gauge({ name: ' ', labels: Schema.Struct({}) })).toThrow()
  })

  it('rejects high-cardinality and unspecified-cardinality gauge labels', () => {
    expect(() =>
      OtelMetric.gauge({
        name: 'bad_gauge',
        labels: Schema.Struct({
          path: OtelAttr.string({ key: 'path', metadata: { cardinality: 'high' } }),
        }),
      }),
    ).toThrow(OtelAttrPlanError)

    expect(() =>
      OtelMetric.gauge({
        name: 'bad_gauge',
        labels: Schema.Struct({
          path: OtelAttr.string({ key: 'path' }),
        }),
      }),
    ).toThrow(OtelAttrPlanError)
  })

  it('bridges schema-first gauges to tagged Effect metrics that go up and down', async () => {
    const Gauge = OtelMetric.gauge({
      name: 'otel_contract_test_bridge_rss_bytes',
      description: 'Test gauge bridge.',
      unit: 'By',
      labels: Schema.Struct({
        operation: OtelAttr.literal('operation', 'gc', 'status'),
      }),
    })
    const bridge = OtelMetric.effect.gauge(Gauge)

    const snapshotValue = async () => {
      const entry = (await Effect.runPromise(Metric.snapshot)).find((candidate) => {
        if (candidate.id !== 'otel_contract_test_bridge_rss_bytes') return false
        return candidate.attributes?.operation === 'gc'
      })
      return (entry?.state as { readonly value?: number } | undefined)?.value
    }

    await Effect.runPromise(bridge.set({ labels: { operation: 'gc' }, value: 100 }))
    expect(await snapshotValue()).toBe(100)

    await Effect.runPromise(bridge.trustedSet({ labels: { operation: 'gc' }, value: 25 }))
    expect(await snapshotValue()).toBe(25)
  })

  it('bridges schema-first counters to tagged Effect metrics', async () => {
    const Counter = OtelMetric.counter({
      name: 'otel_contract_test_bridge_counter_total',
      description: 'Test counter bridge.',
      labels: Schema.Struct({
        service: OtelAttr.string({ key: 'service', metadata: { cardinality: 'bounded' } }),
        cacheHit: OtelAttr.boolean({ key: 'cache_hit' }),
      }),
    })
    const bridge = OtelMetric.effect.counter(Counter)

    await Effect.runPromise(
      Effect.all(
        [
          bridge.incrementBy({ labels: { service: 'api', cacheHit: true }, amount: 2 }),
          bridge.trustedIncrement({ service: 'api', cacheHit: true }),
        ],
        { discard: true },
      ),
    )

    const pair = (await Effect.runPromise(Metric.snapshot)).find((entry) => {
      if (entry.id !== 'otel_contract_test_bridge_counter_total') return false
      return entry.attributes?.service === 'api' && entry.attributes?.cache_hit === 'true'
    })
    expect(pair?.state).toMatchObject({ count: 3 })
  })

  it('bridges schema-first histograms to tagged Effect metrics', async () => {
    const Histogram = OtelMetric.histogram({
      name: 'otel_contract_test_bridge_duration_ms',
      description: 'Test histogram bridge.',
      unit: 'ms',
      boundaries: [10, 100, 1000],
      labels: Schema.Struct({
        route: OtelAttr.literal('route', 'sync', 'async'),
      }),
    })
    const bridge = OtelMetric.effect.histogram(Histogram)

    await Effect.runPromise(bridge.trustedRecord({ labels: { route: 'sync' }, value: 42 }))

    const pair = (await Effect.runPromise(Metric.snapshot)).find((entry) => {
      if (entry.id !== 'otel_contract_test_bridge_duration_ms') return false
      return entry.attributes?.route === 'sync'
    })
    expect(pair?.state).toMatchObject({ count: 1, min: 42, max: 42, sum: 42 })
  })

  it('rejects high-cardinality and unspecified-cardinality metric labels', () => {
    expect(() =>
      OtelMetric.labels(
        Schema.Struct({
          workflowId: OtelAttr.string({
            key: 'restate.workflow.id',
            metadata: { cardinality: 'high' },
          }),
        }),
      ),
    ).toThrow(OtelAttrPlanError)

    expect(() =>
      OtelMetric.labels(
        Schema.Struct({
          service: OtelAttr.string({ key: 'restate.service' }),
        }),
      ),
    ).toThrow(OtelAttrPlanError)
  })

  it('rejects invalid histogram boundaries', () => {
    expect(() =>
      OtelMetric.histogram({
        name: 'bad_histogram',
        boundaries: [10, 5],
        labels: Schema.Struct({
          status: OtelAttr.literal('status', 'ok', 'failed'),
        }),
      }),
    ).toThrow(OtelAttrPlanError)

    expect(() =>
      OtelMetric.histogram({
        name: 'nan_histogram',
        boundaries: [Number.NaN],
        labels: Schema.Struct({
          status: OtelAttr.literal('status', 'ok', 'failed'),
        }),
      }),
    ).toThrow(OtelAttrPlanError)
  })
})
