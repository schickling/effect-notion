import { NodeRuntime } from '@effect/platform-node'
import { layerWebSocket } from '@effect/platform-node/NodeSocketServer'
import { Effect, Schema, Stream } from 'effect'
import type { CloseEvent, Socket as SocketType } from 'effect/unstable/socket/Socket'
import { toChannelString } from 'effect/unstable/socket/Socket'
import type { Address } from 'effect/unstable/socket/SocketServer'
import { SocketServer } from 'effect/unstable/socket/SocketServer'

/**
 * Example: WebSocket JSON server with schema validation.
 *
 * Demonstrates:
 * - `Schema.parseJson` for safe decoding
 * - tagged unions for protocol design
 * - error logging on invalid payloads
 */
/** Error surfaced when the client payload does not match the schema. */
class InvalidClientMessageError extends Schema.TaggedError<InvalidClientMessageError>()(
  'InvalidClientMessageError',
  {
    cause: Schema.Defect(),
    message: Schema.String,
    raw: Schema.String,
  },
) {}

/** Tagged union for client -> server messages. */
const ClientMessageSchema = Schema.Union([
  Schema.TaggedStruct('ping', {
    id: Schema.String,
  }),
  Schema.TaggedStruct('echo', {
    text: Schema.String,
  }),
])

type ClientMessage = typeof ClientMessageSchema.Type

/** Tagged union for server -> client responses. */
const ServerMessageSchema = Schema.Union([
  Schema.TaggedStruct('pong', {
    id: Schema.String,
    receivedAt: Schema.Finite,
  }),
  Schema.TaggedStruct('echoed', {
    text: Schema.String,
  }),
])

type ServerMessage = typeof ServerMessageSchema.Type

/** Decode a JSON string into a typed client message. */
const decodeClientMessage = Effect.fn('ws-json.decode')(function* (raw: string) {
  return yield* Schema.decodeEffect(Schema.fromJsonString(ClientMessageSchema))(raw).pipe(
    Effect.map((message) => {
      const decoded: ClientMessage = message
      return decoded
    }),
    Effect.mapError(
      (cause) =>
        new InvalidClientMessageError({
          cause,
          raw,
          message: 'Failed to decode client message',
        }),
    ),
  )
})

/** Encode a typed server message to JSON. */
const encodeServerMessage = Effect.fn('ws-json.encode')(function* (message: ServerMessage) {
  return yield* Schema.encodeEffect(Schema.fromJsonString(ServerMessageSchema))(message)
})

/** Normalize socket address for logs. */
const formatAddress = (address: Address) =>
  address._tag === 'TcpAddress' ? `${address.hostname}:${address.port}` : address.path

/** Handle a connection with schema-validated JSON messages. */
const handleConnection = Effect.fn('ws-json.connection')(function* (socket: SocketType) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      /** Writer is scoped to the connection lifecycle. */
      const write = yield* socket.writer

      const handleMessage = (text: string) =>
        decodeClientMessage(text).pipe(
          Effect.flatMap((message) => {
            const response: ServerMessage =
              message._tag === 'ping'
                ? { _tag: 'pong', id: message.id, receivedAt: Date.now() }
                : { _tag: 'echoed', text: message.text }

            return encodeServerMessage(response).pipe(Effect.flatMap((json) => write(json)))
          }),
          Effect.catch((error) => Effect.logError({ message: 'invalid message', error })),
        )

      const receive = Stream.fromIterable<Uint8Array | string | CloseEvent>([]).pipe(
        Stream.pipeThroughChannel(toChannelString(socket)),
        Stream.mapEffect((text) => handleMessage(text)),
        Stream.runDrain,
      )

      yield* Effect.log('client connected')
      return yield* receive
    }),
  ).pipe(Effect.withSpan('ws-json.connection.scope'))
})

/** Run the websocket JSON server using the provided SocketServer. */
const runServer = Effect.gen(function* () {
  const socketServer = yield* SocketServer
  yield* Effect.log(`listening on ${formatAddress(socketServer.address)}`)
  return yield* socketServer.run(handleConnection)
}).pipe(Effect.withSpan('ws-json.server'))

const program = runServer.pipe(Effect.provide(layerWebSocket({ port: 8791 })))

/**
 * Expected logs (example):
 * - listening on :::8791
 * - client connected
 */
NodeRuntime.runMain(program)
