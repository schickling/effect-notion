import { Cause, Effect, Exit, Schema, Stream } from 'effect'
import { type RpcMessage, Rpc, RpcGroup, RpcClient } from 'effect/unstable/rpc'
import { describe, expect, it, vi } from 'vitest'

import {
  fetchFromWebHandler,
  InvalidRequestIdError,
  layerClient,
  validateRequestId,
} from './client.ts'
import { makeHandler } from './server.ts'

describe('effect-rpc-tanstack client', () => {
  it('supports a custom fetch transport', async () => {
    const GetGreeting = Rpc.make('GetGreeting', {
      payload: {},
      success: Schema.String,
      error: Schema.Never,
    })

    const Api = RpcGroup.make(GetGreeting)
    const handlers = Api.toLayer(
      Effect.succeed(
        Api.of({
          GetGreeting: () => Effect.succeed('hello'),
        }),
      ),
    )

    const { handler, dispose } = makeHandler({
      group: Api,
      handlerLayer: handlers,
    })

    const fetch = vi.fn(fetchFromWebHandler(handler))

    try {
      const greeting = await Effect.gen(function* () {
        const client = yield* RpcClient.make(Api)
        return yield* client.GetGreeting({})
      }).pipe(
        Effect.provide(
          layerClient({
            url: 'http://localhost/api/rpc',
            fetch,
            requestInit: { credentials: 'include' },
          }),
        ),
        Effect.scoped,
        Effect.runPromise,
      )

      expect(greeting).toBe('hello')
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(fetch.mock.calls[0]?.[1]?.credentials).toBe('include')
    } finally {
      await dispose()
    }
  })

  it('streams responses through a custom fetch transport', async () => {
    const StreamNumbers = Rpc.make('StreamNumbers', {
      payload: {},
      success: Schema.Finite,
      stream: true,
    })

    const Api = RpcGroup.make(StreamNumbers)
    const handlers = Api.toLayer(
      Effect.succeed(
        Api.of({
          StreamNumbers: () => Stream.make(1, 2, 3),
        }),
      ),
    )

    const { handler, dispose } = makeHandler({
      group: Api,
      handlerLayer: handlers,
    })

    try {
      const numbers = await Effect.gen(function* () {
        const client = yield* RpcClient.make(Api)
        return yield* client.StreamNumbers({}).pipe(Stream.runCollect)
      }).pipe(
        Effect.provide(
          layerClient({
            url: 'http://localhost/api/rpc',
            fetch: fetchFromWebHandler(handler),
          }),
        ),
        Effect.scoped,
        Effect.runPromise,
      )

      expect(numbers).toEqual([1, 2, 3])
    } finally {
      await dispose()
    }
  })
})

describe('client request-id policy', () => {
  it('accepts non-empty string ids', () => {
    expect(validateRequestId('req-1')).toBe('req-1')
  })

  it('accepts non-negative number and bigint ids', () => {
    expect(validateRequestId(1)).toBe(1)
    expect(validateRequestId(1n)).toBe(1n)
    expect(validateRequestId(0n)).toBe(0n)
  })

  it('rejects empty string ids with a typed error', () => {
    try {
      validateRequestId('')
      throw new Error('expected validateRequestId to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidRequestIdError)
      expect((error as InvalidRequestIdError)._tag).toBe('InvalidRequestIdError')
      expect((error as InvalidRequestIdError).id).toBe('')
    }
  })

  it('rejects negative bigint ids with a typed error', () => {
    try {
      validateRequestId(-1n)
      throw new Error('expected validateRequestId to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidRequestIdError)
      expect((error as InvalidRequestIdError).id).toBe(-1n)
    }
  })

  it('fails requests whose generated id violates the policy instead of sending them', async () => {
    const GetGreeting = Rpc.make('GetGreeting', {
      payload: {},
      success: Schema.String,
      error: Schema.Never,
    })

    const Api = RpcGroup.make(GetGreeting)
    const handlers = Api.toLayer(
      Effect.succeed(
        Api.of({
          GetGreeting: () => Effect.succeed('hello'),
        }),
      ),
    )

    const { handler, dispose } = makeHandler({
      group: Api,
      handlerLayer: handlers,
    })

    const fetch = vi.fn(fetchFromWebHandler(handler))

    try {
      const exit = await Effect.gen(function* () {
        const client = yield* RpcClient.make(Api, {
          generateRequestId: () => '' as RpcMessage.RequestId,
        })
        return yield* client.GetGreeting({})
      }).pipe(
        Effect.provide(layerClient({ url: 'http://localhost/api/rpc', fetch })),
        Effect.scoped,
        Effect.exit,
        Effect.runPromise,
      )

      expect(fetch).not.toHaveBeenCalled()
      const defect = Exit.isFailure(exit) === true ? Cause.squash(exit.cause) : undefined
      expect(defect).toBeInstanceOf(InvalidRequestIdError)
    } finally {
      await dispose()
    }
  })
})
