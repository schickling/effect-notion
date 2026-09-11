import { Effect, Fiber, Redacted, Result, Schema } from 'effect'
import { adjust as testClockAdjust } from 'effect/testing/TestClock'
import type * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest'
import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import { NotionApiError } from './error.ts'
import {
  NOTION_FILE_UPLOAD_PART_SIZE_BYTES,
  NOTION_FILE_UPLOAD_SINGLE_PART_MAX_BYTES,
  NotionFiles,
} from './files.ts'
import { createTestLayer, type MockResponse, sampleResponses } from './test/test-utils.ts'

const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))

type Recorded = {
  readonly method: string
  readonly path: string
  readonly contentType: string | undefined
  readonly formData: FormData | undefined
  readonly json: unknown
}

const recordRequest = (request: HttpClientRequest.HttpClientRequest): Recorded => {
  const body = request.body
  return {
    method: request.method,
    path: new URL(request.url).pathname,
    contentType: request.headers['content-type'],
    formData: body._tag === 'FormData' ? body.formData : undefined,
    json: body._tag === 'Uint8Array' ? decodeJson(new TextDecoder().decode(body.body)) : undefined,
  }
}

const fileUploadBody = (opts: { readonly id: string; readonly status: string }) => ({
  object: 'file_upload' as const,
  id: opts.id,
  status: opts.status,
  filename: 'doc.pdf',
  content_type: 'application/pdf',
  content_length: null,
  upload_url: `https://api.notion.com/v1/file_uploads/${opts.id}/send`,
})

const filePart = (formData: FormData): Blob => {
  const value = formData.get('file')
  if (value instanceof Blob) {
    return value
  }
  throw new Error('form-data has no `file` part')
}

const partNumbers = (recorded: ReadonlyArray<Recorded>): ReadonlyArray<string | null> =>
  recorded
    .filter((entry) => entry.path.endsWith('/send'))
    .map((entry) => {
      const value = entry.formData?.get('part_number')
      return typeof value === 'string' ? value : null
    })

Vitest.describe('NotionFiles.upload single-part flow', () => {
  Vitest.it.effect('stays single-part at exactly the 20 MiB boundary', () => {
    const recorded: Recorded[] = []

    return Effect.gen(function* () {
      const uploadId = yield* NotionFiles.upload({
        content: new Uint8Array(NOTION_FILE_UPLOAD_SINGLE_PART_MAX_BYTES),
        filename: 'doc.pdf',
        contentType: 'application/pdf',
      })

      expect(uploadId).toBe('upload-1')
      expect(recorded.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
        'POST /v1/file_uploads',
        'POST /v1/file_uploads/upload-1/send',
      ])
      expect(recorded[0]?.json).toEqual({
        mode: 'single_part',
        filename: 'doc.pdf',
        content_type: 'application/pdf',
      })
      // No `part_number` for single-part sends, and the boundary is not exceeded.
      expect(partNumbers(recorded)).toEqual([null])
      expect(filePart(recorded[1]?.formData ?? new FormData()).size).toBe(
        NOTION_FILE_UPLOAD_SINGLE_PART_MAX_BYTES,
      )
      // Form-data requests must not carry a client-set JSON content type.
      expect(recorded[1]?.contentType).toBeUndefined()
    }).pipe(
      Effect.provide(
        createTestLayer((request) => {
          const entry = recordRequest(request)
          recorded.push(entry)
          return {
            status: 200,
            body: fileUploadBody({
              id: 'upload-1',
              status: entry.path.endsWith('/send') === true ? 'uploaded' : 'pending',
            }),
          }
        }),
      ),
    )
  })

  Vitest.it.effect('uploads only the window of a Uint8Array subview', () => {
    const recorded: Recorded[] = []
    const backing = new Uint8Array([9, 9, 9, 1, 2, 3, 4, 9, 9])
    const view = backing.subarray(3, 7)

    return Effect.gen(function* () {
      yield* NotionFiles.upload({
        content: view,
        filename: 'doc.pdf',
        contentType: 'application/pdf',
      })

      const blob = filePart(recorded[1]?.formData ?? new FormData())
      const bytes = new Uint8Array(yield* Effect.promise(() => blob.arrayBuffer()))
      expect([...bytes]).toEqual([1, 2, 3, 4])
    }).pipe(
      Effect.provide(
        createTestLayer((request) => {
          const entry = recordRequest(request)
          recorded.push(entry)
          return {
            status: 200,
            body: fileUploadBody({
              id: 'upload-1',
              status: entry.path.endsWith('/send') === true ? 'uploaded' : 'pending',
            }),
          }
        }),
      ),
    )
  })
})

Vitest.describe('NotionFiles.upload multipart flow', () => {
  const oversized = () => {
    const content = new Uint8Array(NOTION_FILE_UPLOAD_SINGLE_PART_MAX_BYTES + 1)
    // Marker at the first byte of each expected 10 MiB part window.
    content[0] = 11
    content[NOTION_FILE_UPLOAD_PART_SIZE_BYTES] = 22
    content[2 * NOTION_FILE_UPLOAD_PART_SIZE_BYTES] = 33
    return content
  }

  Vitest.it.effect('creates a multipart upload, sends 1-based 10 MiB parts, then completes', () => {
    const recorded: Recorded[] = []

    return Effect.gen(function* () {
      const uploadId = yield* NotionFiles.upload({
        content: oversized(),
        filename: 'doc.pdf',
        contentType: 'application/pdf',
      })

      expect(uploadId).toBe('upload-1')
      expect(recorded.map((entry) => entry.path)).toEqual([
        '/v1/file_uploads',
        '/v1/file_uploads/upload-1/send',
        '/v1/file_uploads/upload-1/send',
        '/v1/file_uploads/upload-1/send',
        '/v1/file_uploads/upload-1/complete',
      ])
      expect(recorded[0]?.json).toEqual({
        mode: 'multi_part',
        filename: 'doc.pdf',
        content_type: 'application/pdf',
        number_of_parts: 3,
      })
      expect(partNumbers(recorded)).toEqual(['1', '2', '3'])

      const sends = recorded.filter((entry) => entry.path.endsWith('/send'))
      expect(sends.map((entry) => filePart(entry.formData ?? new FormData()).size)).toEqual([
        NOTION_FILE_UPLOAD_PART_SIZE_BYTES,
        NOTION_FILE_UPLOAD_PART_SIZE_BYTES,
        1,
      ])

      // Each part carries its own window, not the whole backing buffer.
      const firstBytes: number[] = []
      for (const entry of sends) {
        const blob = filePart(entry.formData ?? new FormData())
        const head = new Uint8Array(yield* Effect.promise(() => blob.slice(0, 1).arrayBuffer()))
        firstBytes.push(head[0] ?? -1)
      }
      expect(firstBytes).toEqual([11, 22, 33])
    }).pipe(
      Effect.provide(
        createTestLayer((request) => {
          const entry = recordRequest(request)
          recorded.push(entry)
          return {
            status: 200,
            body: fileUploadBody({
              id: 'upload-1',
              status: entry.path.endsWith('/complete') === true ? 'uploaded' : 'pending',
            }),
          }
        }),
      ),
    )
  })

  Vitest.it.effect('never completes when a part send reports a failed upload', () => {
    const recorded: Recorded[] = []

    return Effect.gen(function* () {
      const error = yield* NotionFiles.upload({
        content: oversized(),
        filename: 'doc.pdf',
        contentType: 'application/pdf',
      }).pipe(Effect.flip)

      expect(error).toBeInstanceOf(NotionApiError)
      expect(error.code).toBe('validation_error')
      expect(error.message).toContain('failed')
      // Create + first part only: the flow aborts instead of completing.
      expect(recorded.map((entry) => entry.path)).toEqual([
        '/v1/file_uploads',
        '/v1/file_uploads/upload-1/send',
      ])
    }).pipe(
      Effect.provide(
        createTestLayer((request) => {
          const entry = recordRequest(request)
          recorded.push(entry)
          return {
            status: 200,
            body: fileUploadBody({
              id: 'upload-1',
              status: entry.path.endsWith('/send') === true ? 'failed' : 'pending',
            }),
          }
        }),
      ),
    )
  })
})

Vitest.describe('NotionFiles.upload guards', () => {
  Vitest.it.effect('rejects content above maxBytes without issuing any request', () => {
    let calls = 0

    return Effect.gen(function* () {
      const error = yield* NotionFiles.upload({
        content: new Uint8Array(1024),
        filename: 'doc.pdf',
        contentType: 'application/pdf',
        maxBytes: 512,
      }).pipe(Effect.flip)

      expect(error).toBeInstanceOf(NotionApiError)
      expect(error.status).toBe(400)
      expect(error.code).toBe('validation_error')
      expect(error.message).toContain('1024 bytes')
      expect(error.message).toContain('512-byte')
      expect(calls).toBe(0)
    }).pipe(
      Effect.provide(
        createTestLayer(() => {
          calls += 1
          return { status: 200, body: fileUploadBody({ id: 'upload-1', status: 'pending' }) }
        }),
      ),
    )
  })

  Vitest.it.effect('aborts before sending when create does not return a pending upload', () => {
    const recorded: Recorded[] = []

    return Effect.gen(function* () {
      const error = yield* NotionFiles.upload({
        content: new Uint8Array(16),
        filename: 'doc.pdf',
        contentType: 'application/pdf',
      }).pipe(Effect.flip)

      expect(error.code).toBe('validation_error')
      expect(error.message).toContain('expired')
      expect(recorded.map((entry) => entry.path)).toEqual(['/v1/file_uploads'])
    }).pipe(
      Effect.provide(
        createTestLayer((request) => {
          recorded.push(recordRequest(request))
          return { status: 200, body: fileUploadBody({ id: 'upload-1', status: 'expired' }) }
        }),
      ),
    )
  })

  Vitest.it.effect('retries a retryable send failure through the shared executeRequest path', () =>
    Effect.gen(function* () {
      const recorded: Recorded[] = []
      let sendCalls = 0

      const fiber = yield* NotionFiles.upload({
        content: new Uint8Array(16),
        filename: 'doc.pdf',
        contentType: 'application/pdf',
      }).pipe(
        Effect.result,
        Effect.provide(
          createTestLayer(
            (request): MockResponse => {
              const entry = recordRequest(request)
              recorded.push(entry)
              if (entry.path.endsWith('/send') === false) {
                return {
                  status: 200,
                  body: fileUploadBody({ id: 'upload-1', status: 'pending' }),
                }
              }
              sendCalls += 1
              return sendCalls === 1
                ? {
                    status: 503,
                    body: sampleResponses.error(503, 'service_unavailable', 'Unavailable'),
                  }
                : { status: 200, body: fileUploadBody({ id: 'upload-1', status: 'uploaded' }) }
            },
            {
              authToken: Redacted.make('test-token'),
              retryEnabled: true,
              maxRetries: 3,
              retryBaseDelay: 1000,
            },
          ),
        ),
        Effect.forkChild,
      )

      yield* testClockAdjust('60 seconds')
      const result = yield* Fiber.join(fiber)

      expect(Result.isSuccess(result)).toBe(true)
      expect(sendCalls).toBe(2)
      expect(recorded.map((entry) => entry.path)).toEqual([
        '/v1/file_uploads',
        '/v1/file_uploads/upload-1/send',
        '/v1/file_uploads/upload-1/send',
      ])
    }),
  )
})
