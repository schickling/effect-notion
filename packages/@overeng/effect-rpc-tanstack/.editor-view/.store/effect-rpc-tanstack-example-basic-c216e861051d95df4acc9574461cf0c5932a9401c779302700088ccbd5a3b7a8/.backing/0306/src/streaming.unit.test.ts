import { Effect, Schema } from 'effect'
import * as Stream from 'effect/Stream'
import { Rpc, RpcGroup } from 'effect/unstable/rpc'
import { describe, expect, it } from 'vitest'

import { makeHandler } from './server.ts'

describe('effect-rpc-tanstack streaming', () => {
  it('returns ndjson with chunk and exit messages for stream RPCs', async () => {
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

    const body = `${JSON.stringify({
      _tag: 'Request',
      id: '1',
      tag: 'StreamNumbers',
      payload: {},
      headers: [],
    })}\n`

    const request = new Request('http://localhost/api/rpc', {
      method: 'POST',
      headers: {
        'content-type': 'application/ndjson',
      },
      body,
    })

    try {
      const response = await handler(request)
      expect(response.headers.get('content-type')).toContain('application/ndjson')

      const text = await response.text()
      const messages = text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { _tag: string })

      const tags = new Set(messages.map((message) => message._tag))
      expect(tags.has('Chunk')).toBe(true)
      expect(tags.has('Exit')).toBe(true)
    } finally {
      await dispose()
    }
  })
})
