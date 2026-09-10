import { NodeRuntime } from '@effect/platform-node'
import { Duration, Effect, Fiber, Schema, Stream } from 'effect'
import type { Socket as SocketType } from 'effect/unstable/socket/Socket'
import {
  CloseEvent,
  layerWebSocketConstructorGlobal,
  makeWebSocket,
  toChannelString,
} from 'effect/unstable/socket/Socket'

/**
 * Example: WebSocket JSON client with schema validation.
 *
 * Demonstrates:
 * - `Schema.parseJson` for safe decoding/encoding
 * - typed request/response handling
 * - graceful close after messages
 */
/** WebSocket endpoint for the JSON server. */
const url = 'ws://127.0.0.1:8791'

/** Convert socket messages into a Stream of text frames. */
const socketTextStream = (socket: SocketType) =>
  Stream.fromIterable<Uint8Array | string | CloseEvent>([]).pipe(
    Stream.pipeThroughChannel(toChannelString(socket)),
  )

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

/** Encode a typed client message to JSON. */
const encodeClientMessage = Effect.fn('ws-json.encode')(function* (message: ClientMessage) {
  return yield* Schema.encodeEffect(Schema.fromJsonString(ClientMessageSchema))(message)
})

/** Decode a JSON string into a typed server response. */
const decodeServerMessage = Effect.fn('ws-json.decode')(function* (raw: string) {
  const message: ServerMessage = yield* Schema.decodeEffect(
    Schema.fromJsonString(ServerMessageSchema),
  )(raw)
  return message
})

/** Connect, send typed messages, and decode typed responses. */
const runClient = Effect.gen(function* () {
  const socket = yield* makeWebSocket(url, {
    openTimeout: Duration.seconds(5),
  })

  return yield* Effect.scoped(
    Effect.gen(function* () {
      /** Writer is scoped to the connection lifecycle. */
      const write = yield* socket.writer

      /** Emit a ping then an echo message, then close cleanly. */
      const sendLoop = Effect.gen(function* () {
        const ping: ClientMessage = { _tag: 'ping', id: crypto.randomUUID() }
        const echo: ClientMessage = { _tag: 'echo', text: 'hello json' }

        const pingJson = yield* encodeClientMessage(ping)
        const echoJson = yield* encodeClientMessage(echo)

        yield* write(pingJson)
        yield* Effect.sleep(Duration.millis(300))
        yield* write(echoJson)
        yield* Effect.sleep(Duration.millis(300))
        yield* write(new CloseEvent(1000, 'done'))
      }).pipe(Effect.withSpan('ws-json.client.send'))

      const receive = socketTextStream(socket).pipe(
        Stream.mapEffect((text) =>
          decodeServerMessage(text).pipe(
            Effect.tap((decoded) => Effect.log(decoded)),
            Effect.catch((error) => Effect.logError({ message: 'invalid server message', error })),
          ),
        ),
        Stream.runDrain,
      )

      const sendFiber = yield* Effect.forkScoped(sendLoop)
      const result = yield* receive
      yield* Fiber.join(sendFiber)
      return result
    }),
  ).pipe(Effect.withSpan('ws-json.client.scope'))
}).pipe(Effect.withSpan('ws-json.client'))

const program = runClient.pipe(Effect.provide(layerWebSocketConstructorGlobal))

/**
 * Expected logs (example):
 * - { _tag: "pong", id: "<uuid>", receivedAt: <timestamp> }
 * - { _tag: "echoed", text: "hello json" }
 */
NodeRuntime.runMain(program)
