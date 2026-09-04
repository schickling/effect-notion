import { Effect, Exit, Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/unstable/rpc'
import { describe, expect, it } from 'vitest'

import { encodeExit, decodeExit, makeEffectLoaderResult } from './router.ts'
import { makeHandler } from './server.ts'

class GreetingError extends Schema.TaggedError<GreetingError>()('GreetingError', {
  reason: Schema.Literals(['missing-user', 'blocked']),
  userId: Schema.String,
}) {}

const GetGreeting = Rpc.make('GetGreeting', {
  payload: {
    userId: Schema.String,
    note: Schema.NullOr(Schema.String),
  },
  success: Schema.Struct({
    message: Schema.String,
    empty: Schema.String,
    unicode: Schema.String,
  }),
  error: GreetingError,
})

const Api = RpcGroup.make(GetGreeting)

const encodeJsonBytes = (value: unknown): string => JSON.stringify(value, null, 2)

const jsonWireRoundTrip = (value: unknown) => {
  const encoded = encodeJsonBytes(value)
  const decoded = JSON.parse(encoded) as unknown
  const reencoded = encodeJsonBytes(decoded)

  return {
    encoded,
    decoded,
    reencoded,
    byteIdentical: reencoded === encoded,
  }
}

const requestBytes = (value: unknown): string => `${JSON.stringify(value)}\n`

const rpcPost = async ({
  handler,
  body,
}: {
  readonly handler: (request: Request) => Promise<Response>
  readonly body: string
}) => {
  const request = new Request('http://localhost/api/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/ndjson' },
    body,
  })
  const response = await handler(request)

  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    body: await response.text(),
  }
}

const decodeExitFailure = (encoded: unknown) => {
  try {
    return {
      _tag: 'decoded' as const,
      value: decodeExit(encoded as Parameters<typeof decodeExit>[0]),
    }
  } catch (error) {
    return {
      _tag: 'failed' as const,
      error: error instanceof Error ? String(error) : String(error),
    }
  }
}

describe('effect-rpc-tanstack RPC wire baselines (cross-major invariant)', () => {
  // These bytes pin the package's single current SSR Exit format. #979 records
  // consumer-owned coordinated rollout and cache policy; there is no dual decoder.
  it('captures SSR Exit JSON bytes and re-encoded identity', () => {
    const exits = {
      success: encodeExit(
        Exit.succeed({
          message: 'hello ß',
          empty: '',
          nested: { absentIsOmitted: undefined, explicitNull: null },
        }),
      ),
      failure: encodeExit(Exit.fail(new GreetingError({ reason: 'missing-user', userId: '' }))),
      defect: encodeExit(Exit.die(new Error('loader defect ß'))),
    }

    const successResult = makeEffectLoaderResult<typeof exits.success, GreetingError>(exits.success)
    const failureResult = makeEffectLoaderResult<unknown, GreetingError>(exits.failure)
    const defectResult = makeEffectLoaderResult<unknown, unknown>(exits.defect)

    expect({
      wire: jsonWireRoundTrip(exits),
      decoded: {
        successGetOrThrow: successResult.getOrThrow(),
        failureError: failureResult.error,
        failureMatch: failureResult.match<unknown>({
          onSuccess: (value) => ({ _tag: 'success', value }),
          onFailure: (error) => ({ _tag: error._tag, reason: error.reason, userId: error.userId }),
        }),
        defectMatch: defectResult.match<unknown>({
          onSuccess: (value) => ({ _tag: 'success', value }),
          onFailure: (error) => ({ _tag: 'failure', error }),
          onDefect: (defect) => ({
            _tag: 'defect',
            message: defect instanceof Error ? defect.message : String(defect),
          }),
        }),
      },
      failures: {
        invalidExitTag: decodeExitFailure({ _tag: 'NotAnExit', value: null }),
        missingFailureCause: decodeExitFailure({ _tag: 'Failure' }),
      },
    }).toMatchSnapshot()
  })

  // These bytes pin the package's single current HTTP RPC format. #979 records
  // consumer-owned coordinated rollout and cache policy; there is no dual decoder.
  it('captures HTTP RPC NDJSON bytes and failure partition', async () => {
    const handlers = Api.toLayer(
      Effect.succeed(
        Api.of({
          GetGreeting: ({ userId, note }) =>
            userId === ''
              ? Effect.fail(new GreetingError({ reason: 'missing-user', userId }))
              : Effect.succeed({
                  message: `hello ${userId}`,
                  empty: note ?? '',
                  unicode: 'Grüße ß',
                }),
        }),
      ),
    )

    const { handler, dispose } = makeHandler({
      group: Api,
      handlerLayer: handlers,
      disableTracing: true,
    })

    const requests = {
      success: requestBytes({
        _tag: 'Request',
        id: '1',
        tag: 'GetGreeting',
        payload: { userId: 'ada-ß', note: null },
        headers: [],
      }),
      domainFailure: requestBytes({
        _tag: 'Request',
        id: '2',
        tag: 'GetGreeting',
        payload: { userId: '', note: '' },
        headers: [],
      }),
      invalidPayload: requestBytes({
        _tag: 'Request',
        id: '3',
        tag: 'GetGreeting',
        payload: { userId: 123, note: undefined },
        headers: [],
      }),
      unknownTag: requestBytes({
        _tag: 'Request',
        id: '4',
        tag: 'UnknownRpc',
        payload: {},
        headers: [],
      }),
      invalidEnvelope: `${JSON.stringify({ _tag: 'Request', id: '5' })}\n`,
      invalidId: requestBytes({
        _tag: 'Request',
        id: 'req-invalid-id',
        tag: 'GetGreeting',
        payload: { userId: 'ada-ß', note: null },
        headers: [],
      }),
    }

    try {
      const responses = {
        success: await rpcPost({ handler, body: requests.success }),
        domainFailure: await rpcPost({ handler, body: requests.domainFailure }),
        invalidPayload: await rpcPost({ handler, body: requests.invalidPayload }),
        unknownTag: await rpcPost({ handler, body: requests.unknownTag }),
        invalidEnvelope: await rpcPost({ handler, body: requests.invalidEnvelope }),
        invalidId: await rpcPost({ handler, body: requests.invalidId }),
      }

      expect({
        requests,
        responses,
        requestWire: jsonWireRoundTrip(requests),
        responseWire: jsonWireRoundTrip(responses),
      }).toMatchSnapshot()
    } finally {
      await dispose()
    }
  })
})
