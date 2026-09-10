import { createServer, type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'

import { type Context, Effect, Result, Schema } from 'effect'

import { DataSourceId, PageId } from '../core/domain.ts'
import type { SyncRootId } from '../core/events.ts'
import {
  SignalExternalId,
  SignalId,
  SignalPayloadJson,
  SignalProvider,
  type EnqueueSignalInput,
} from '../core/signals.ts'
import { spanAttr, withSpan } from '../observability/observability.ts'
import type { NotionSyncStore } from '../store/store.ts'
import {
  type NotionWebhookRejectionReason,
  type NotionWebhookSignal,
  parseNotionWebhookRequest,
} from './notion.ts'
import type { WebhookRelayExposure, WebhookRelayProvider } from './tailscale.ts'

/** Configuration for the local HTTP receiver that accepts Notion webhook POSTs. */
export type NotionWebhookReceiverConfig = {
  readonly rootId: SyncRootId
  readonly store: NotionSyncStore
  readonly hostname?: string
  readonly port?: number
  readonly path?: string
  readonly verificationToken?: string
  readonly maxBodyBytes?: number
  readonly onSignalEnqueued?: (
    result: Extract<NotionWebhookDeliveryResult, { readonly _tag: 'signal-enqueued' }>,
  ) => void
  /**
   * Optional Effect context captured from the calling Effect pipeline.
   * When provided, each webhook delivery is wrapped in a `notion_datasource.webhook.intake`
   * span so that intake attributes (outcome, event type, page/data-source IDs) flow through
   * the configured tracer. Without it the delivery still works — spans are simply not emitted.
   */
  readonly effectContext?: Context.Context<never>
}

/** Current local receiver state and loopback callback target. */
export type NotionWebhookReceiverStatus = {
  readonly url: string
  readonly hostname: string
  readonly port: number
  readonly path: string
  readonly localTarget: string
  readonly verificationConfigured: boolean
  readonly closed: boolean
}

/** Started receiver handle with status inspection and idempotent cleanup. */
export type NotionWebhookReceiverHandle = NotionWebhookReceiverStatus & {
  readonly status: () => NotionWebhookReceiverStatus
  readonly close: () => Promise<void>
  readonly getVerificationToken: () => string | undefined
}

/** Receiver runtime configuration including an optional public relay provider factory. */
export type NotionWebhookReceiverRuntimeConfig = NotionWebhookReceiverConfig & {
  readonly makeRelayProvider?: (receiver: NotionWebhookReceiverStatus) => WebhookRelayProvider
}

/** Started receiver plus optional relay provider lifecycle handle. */
export type NotionWebhookReceiverRuntimeHandle = {
  readonly receiver: NotionWebhookReceiverHandle
  readonly relayProvider: WebhookRelayProvider | undefined
  readonly relayExposure: WebhookRelayExposure | undefined
  readonly status: () => NotionWebhookReceiverRuntimeStatus
  readonly close: () => Promise<void>
}

/** Combined local receiver and public relay runtime status. */
export type NotionWebhookReceiverRuntimeStatus = {
  readonly receiver: NotionWebhookReceiverStatus
  readonly relayExposure: WebhookRelayExposure | undefined
}

/** Result of handling one local Notion webhook HTTP request. */
export type NotionWebhookDeliveryResult =
  | {
      readonly _tag: 'verification-token-observed'
      readonly verificationToken: string
    }
  | {
      readonly _tag: 'signal-enqueued'
      readonly signalId: SignalId
      readonly inserted: boolean
      /** Notion event type string (e.g. `'page.created'`) — for OTEL attribution only, never used for routing. */
      readonly eventType: string
      /** Page ID from the webhook signal — for OTEL attribution only. */
      readonly pageId: string | undefined
      /** Data-source ID from the webhook signal — for OTEL attribution only. */
      readonly dataSourceId: string | undefined
    }
  | {
      readonly _tag: 'rejected'
      readonly reason: NotionWebhookDeliveryRejectionReason
    }

/** Rejection reasons surfaced by the local Notion webhook receiver. */
export type NotionWebhookDeliveryRejectionReason =
  | NotionWebhookRejectionReason
  | 'missing-runtime-verification-token'
  | 'verification-token-already-configured'
  | 'request-body-too-large'
  | 'method-not-allowed'
  | 'path-not-found'

const defaultHostname = '127.0.0.1'
const defaultPath = '/notion-datasource-sync/webhook/notion'
const defaultMaxBodyBytes = 256 * 1024

const normalizePath = (path: string | undefined): string => {
  if (path === undefined || path.length === 0) return defaultPath
  return path.startsWith('/') === true ? path : `/${path}`
}

const signalPayloadJson = (signal: NotionWebhookSignal): SignalPayloadJson =>
  Schema.decodeSync(SignalPayloadJson)(
    JSON.stringify({
      provider: signal.provider,
      eventId: signal.eventId,
      eventType: signal.eventType,
      occurredAt: signal.occurredAt,
      apiVersion: signal.apiVersion,
      attemptNumber: signal.attemptNumber,
      entity: signal.entity,
      pageId: signal.pageId,
      dataSourceId: signal.dataSourceId,
      databaseId: signal.databaseId,
      subscriptionId: signal.subscriptionId,
      workspaceId: signal.workspaceId,
      integrationId: signal.integrationId,
      isAggregated: signal.isAggregated,
    }),
  )

const decodeOptional = <TValue>({
  schema,
  value,
}: {
  readonly schema: Schema.Codec<TValue, string>
  readonly value: string | undefined
}): TValue | undefined => {
  if (value === undefined) return undefined
  const decoded = Schema.decodeResult(schema)(value)
  return Result.isSuccess(decoded) === true ? decoded.success : undefined
}

/** Convert a secret-safe Notion webhook signal into the durable signal-inbox contract. */
export const signalInputFromNotionWebhookSignal = ({
  rootId,
  signal,
}: {
  readonly rootId: SyncRootId
  readonly signal: NotionWebhookSignal
}): EnqueueSignalInput => {
  const dataSourceId = decodeOptional({ schema: DataSourceId, value: signal.dataSourceId })
  const pageId = decodeOptional({ schema: PageId, value: signal.pageId })
  return {
    rootId,
    signalId: Schema.decodeSync(SignalId)(`webhook:notion:${signal.eventId}`),
    provider: Schema.decodeSync(SignalProvider)('notion-webhook'),
    externalId: Schema.decodeSync(SignalExternalId)(`notion:${signal.eventId}`),
    kind: 'remote-change',
    payloadJson: signalPayloadJson(signal),
    ...(dataSourceId === undefined ? {} : { dataSourceId }),
    ...(pageId === undefined ? {} : { pageId }),
  }
}

/**
 * Map a `NotionWebhookDeliveryResult` to a stable `webhookOutcome` attribute value
 * suitable for the `notion_datasource.webhook.intake` span.
 */
const webhookOutcomeFromResult = (result: NotionWebhookDeliveryResult): string => {
  if (result._tag === 'verification-token-observed') return 'verification'
  if (result._tag === 'rejected') return 'rejected'
  return result.inserted === true ? 'enqueued' : 'duplicate'
}

/** Parse, verify, normalize, and persist one Notion webhook delivery as a daemon wake signal. */
export const handleNotionWebhookDelivery = ({
  rawBody,
  headers,
  rootId,
  store,
  verificationToken,
}: {
  readonly rawBody: string | Uint8Array
  readonly headers: IncomingHttpHeaders
  readonly rootId: SyncRootId
  readonly store: NotionSyncStore
  readonly verificationToken: string | undefined
}): NotionWebhookDeliveryResult => {
  const parsed = parseNotionWebhookRequest({
    rawBody,
    headers,
    ...(verificationToken === undefined ? {} : { verificationToken }),
  })
  if (parsed._tag === 'NotionWebhookRejected') return { _tag: 'rejected', reason: parsed.reason }
  if (parsed._tag === 'NotionWebhookVerification') {
    if (verificationToken !== undefined) {
      return { _tag: 'rejected', reason: 'verification-token-already-configured' }
    }
    return {
      _tag: 'verification-token-observed',
      verificationToken: parsed.verificationToken,
    }
  }
  if (verificationToken === undefined) {
    return { _tag: 'rejected', reason: 'missing-runtime-verification-token' }
  }

  const enqueued = store.enqueueSignal(
    signalInputFromNotionWebhookSignal({ rootId, signal: parsed.signal }),
  )
  return {
    _tag: 'signal-enqueued',
    signalId: enqueued.signal.signalId,
    inserted: enqueued.inserted,
    eventType: parsed.signal.eventType,
    pageId: parsed.signal.pageId,
    dataSourceId: parsed.signal.dataSourceId,
  }
}

const readRequestBody = async ({
  request,
  maxBodyBytes,
}: {
  readonly request: IncomingMessage
  readonly maxBodyBytes: number
}): Promise<Uint8Array | { readonly _tag: 'too-large' }> => {
  const chunks: Uint8Array[] = []
  let byteLength = 0
  for await (const chunk of request) {
    const bytes =
      typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk)
    byteLength += bytes.byteLength
    if (byteLength > maxBodyBytes) return { _tag: 'too-large' }
    chunks.push(bytes)
  }
  const body = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

/** Start a local HTTP receiver for Notion webhooks. The raw request body is never logged or persisted. */
export const startNotionWebhookReceiver = async (
  config: NotionWebhookReceiverConfig,
): Promise<NotionWebhookReceiverHandle> => {
  const hostname = config.hostname ?? defaultHostname
  const path = normalizePath(config.path)
  const maxBodyBytes = config.maxBodyBytes ?? defaultMaxBodyBytes
  let verificationToken = config.verificationToken
  let closed = false
  let closing: Promise<void> | undefined

  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? hostname}`)
      if (requestUrl.pathname !== path) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: false, reason: 'path-not-found' }))
        return
      }
      if (request.method !== 'POST') {
        response.writeHead(405, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: false, reason: 'method-not-allowed' }))
        return
      }

      const rawBody = await readRequestBody({ request, maxBodyBytes })
      if ('_tag' in rawBody) {
        response.writeHead(413, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: false, reason: 'request-body-too-large' }))
        return
      }

      const result = handleNotionWebhookDelivery({
        rawBody,
        headers: request.headers,
        rootId: config.rootId,
        store: config.store,
        verificationToken,
      })

      // When an Effect context is present, emit the intake span with outcome/attribution
      // attributes. Awaited so the span is deterministically recorded before the response
      // is sent; errors are swallowed so a tracer failure can never 500 a delivery.
      if (config.effectContext !== undefined) {
        const outcome = webhookOutcomeFromResult(result)
        await Effect.runPromise(
          Effect.void.pipe(
            withSpan({
              span: 'webhookIntake',
              attributes: {
                [spanAttr.spanLabel]: 'webhook',
                [spanAttr.webhookOutcome]: outcome,
                ...(result._tag === 'rejected'
                  ? { [spanAttr.webhookRejectionReason]: result.reason }
                  : {}),
                ...(result._tag === 'signal-enqueued'
                  ? { [spanAttr.webhookEventType]: result.eventType }
                  : {}),
                ...(result._tag === 'signal-enqueued' && result.pageId !== undefined
                  ? { [spanAttr.pageId]: result.pageId }
                  : {}),
                ...(result._tag === 'signal-enqueued' && result.dataSourceId !== undefined
                  ? { [spanAttr.dataSourceId]: result.dataSourceId }
                  : {}),
              },
            }),
            Effect.provide(config.effectContext),
          ),
        ).catch(() => {})
      }

      if (result._tag === 'verification-token-observed') {
        verificationToken = result.verificationToken
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true, type: 'verification-token-observed' }))
        return
      }
      if (result._tag === 'signal-enqueued') {
        config.onSignalEnqueued?.(result)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true, inserted: result.inserted }))
        return
      }

      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: false, reason: result.reason }))
    } catch {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: false, reason: 'receiver-error' }))
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port ?? 0, hostname, () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address() as AddressInfo
  const status = (): NotionWebhookReceiverStatus => ({
    url: `http://${hostname}:${address.port.toString()}${path}`,
    hostname,
    port: address.port,
    path,
    localTarget: `localhost:${address.port.toString()}`,
    verificationConfigured: verificationToken !== undefined,
    closed,
  })

  return {
    ...status(),
    status,
    close: async () => {
      if (closed === true) return
      if (closing !== undefined) return closing
      closing = new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)))
      })
      try {
        await closing
      } finally {
        closed = true
      }
    },
    getVerificationToken: () => verificationToken,
  }
}

/** Start a receiver and optional relay provider with one finalizer-safe lifecycle handle. */
export const startNotionWebhookReceiverRuntime = async (
  config: NotionWebhookReceiverRuntimeConfig,
): Promise<NotionWebhookReceiverRuntimeHandle> => {
  const receiver = await startNotionWebhookReceiver(config)
  let relayProvider: WebhookRelayProvider | undefined
  let relayExposure: WebhookRelayExposure | undefined
  let closed = false
  let closing: Promise<void> | undefined

  try {
    relayProvider = config.makeRelayProvider?.(receiver.status())
    relayExposure = await relayProvider?.start()
  } catch (cause) {
    await receiver.close()
    throw cause
  }

  const close = async (): Promise<void> => {
    if (closed === true) return
    if (closing !== undefined) return closing
    closing = (async () => {
      try {
        await relayProvider?.stop()
      } finally {
        await receiver.close()
        closed = true
      }
    })()
    return closing
  }

  return {
    receiver,
    relayProvider,
    relayExposure,
    status: () => ({ receiver: receiver.status(), relayExposure }),
    close,
  }
}
