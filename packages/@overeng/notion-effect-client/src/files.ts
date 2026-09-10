/**
 * Notion File Uploads API.
 *
 * Single-part flow (content ≤ 20 MiB):
 * 1. `POST /v1/file_uploads` with `mode: 'single_part'` (JSON) → status `pending`
 * 2. `POST /v1/file_uploads/{id}/send` with the whole file (form-data) → status `uploaded`
 *
 * Multipart flow (content > 20 MiB):
 * 1. `POST /v1/file_uploads` with `mode: 'multi_part'` + `number_of_parts` → status `pending`
 * 2. `POST /v1/file_uploads/{id}/send` once per part with a 1-based `part_number`
 *    (form-data); the upload stays `pending` between parts
 * 3. `POST /v1/file_uploads/{id}/complete` (JSON) → status `uploaded`
 *
 * The returned upload ID is then referenced from a `pdf` or `file` block.
 *
 * Every request goes through the shared `executeRequest` path, so retry,
 * throttling, telemetry, spans, and Notion error decoding are identical to the
 * rest of the client.
 *
 * There is no abort/delete endpoint: an upload whose parts were not completed
 * simply stays `pending` until its server-side `expiry_time` and can never be
 * attached, so a failed multipart upload needs no cleanup call.
 *
 * @see https://developers.notion.com/reference/create-a-file-upload
 */

import { Effect, Option, Schema } from 'effect'

import { NotionApiError } from './error.ts'
import { post, postFormData } from './internal/http.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Largest content Notion accepts through the single-part flow (20 MiB). */
export const NOTION_FILE_UPLOAD_SINGLE_PART_MAX_BYTES = 20 * 1024 * 1024

/**
 * Part size used for multipart uploads (10 MiB).
 *
 * Notion requires every part except the last to be 5–20 MiB and recommends
 * 10 MiB.
 */
export const NOTION_FILE_UPLOAD_PART_SIZE_BYTES = 10 * 1024 * 1024

/**
 * Default client-side upload ceiling (64 MiB).
 *
 * A conservative guard so an accidental multi-gigabyte buffer fails locally
 * instead of after a long upload; callers raise or lower it per call via
 * {@link UploadFileOptions.maxBytes}. This is not the workspace limit.
 */
export const NOTION_FILE_UPLOAD_DEFAULT_MAX_BYTES = 64 * 1024 * 1024

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** Lifecycle status of a Notion file upload object. */
const FileUploadStatus = Schema.Literals(['pending', 'uploaded', 'expired', 'failed']).annotate({
  identifier: 'NotionFileUpload.Status',
})
type FileUploadStatus = typeof FileUploadStatus.Type

/** Fields of the `file_upload` object this client depends on. */
const FileUploadResponse = Schema.Struct({
  id: Schema.String,
  status: FileUploadStatus,
  filename: Schema.NullOr(Schema.String),
  content_type: Schema.NullOr(Schema.String),
  content_length: Schema.NullOr(Schema.Finite),
}).annotate({ identifier: 'NotionFileUpload' })
type FileUploadResponse = typeof FileUploadResponse.Type

/** JSON request body for creating a file upload. */
type CreateFileUploadRequest = {
  readonly mode: 'single_part' | 'multi_part'
  readonly filename: string
  readonly content_type: string
  /** Required for `multi_part`, omitted for `single_part`. */
  readonly number_of_parts?: number
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options for uploading a file to Notion */
export interface UploadFileOptions {
  /** File content as bytes */
  readonly content: Uint8Array
  /** Filename including extension (max 900 bytes) */
  readonly filename: string
  /** MIME content type (e.g. "application/pdf") */
  readonly contentType: string
  /**
   * Client-side upload ceiling in bytes; content above it fails before any
   * HTTP call. Defaults to {@link NOTION_FILE_UPLOAD_DEFAULT_MAX_BYTES}.
   */
  readonly maxBytes?: number
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const uploadError = (opts: { readonly message: string; readonly path: string }): NotionApiError =>
  new NotionApiError({
    status: 400,
    code: 'validation_error',
    message: opts.message,
    retryAfterSeconds: Option.none(),
    requestId: Option.none(),
    url: Option.some(`/v1${opts.path}`),
    method: Option.some('POST'),
  })

/**
 * Guards a state transition: every step of the flow has exactly one legal
 * server-side status, so an unexpected one (`expired`, `failed`, or a
 * premature `uploaded`) must abort the flow instead of being carried into the
 * next call.
 */
const expectStatus = (opts: {
  readonly response: FileUploadResponse
  readonly expected: FileUploadStatus
  readonly path: string
  readonly step: string
}): Effect.Effect<FileUploadResponse, NotionApiError> =>
  opts.response.status === opts.expected
    ? Effect.succeed(opts.response)
    : Effect.fail(
        uploadError({
          message: `Notion file upload ${opts.step} returned status "${opts.response.status}", expected "${opts.expected}"`,
          path: opts.path,
        }),
      )

const sendPart = (opts: {
  readonly uploadId: string
  readonly chunk: Uint8Array
  readonly filename: string
  readonly contentType: string
  /** 1-based part number; omitted for single-part uploads. */
  readonly partNumber?: number
}) => {
  const formData = new FormData()
  /* Preserve the caller view's byteOffset/byteLength. Constructing a fresh
   * view over an ArrayBuffer does not copy; SharedArrayBuffer input is copied
   * only because DOM BlobPart requires an ArrayBuffer-backed view. Passing
   * `chunk.buffer` directly would upload unrelated prefix/suffix bytes. */
  const blobBytes: Uint8Array<ArrayBuffer> =
    opts.chunk.buffer instanceof ArrayBuffer
      ? new Uint8Array(opts.chunk.buffer, opts.chunk.byteOffset, opts.chunk.byteLength)
      : new Uint8Array(opts.chunk)
  formData.append('file', new Blob([blobBytes], { type: opts.contentType }), opts.filename)
  if (opts.partNumber !== undefined) {
    formData.append('part_number', String(opts.partNumber))
  }

  return postFormData({
    path: `/file_uploads/${opts.uploadId}/send`,
    formData,
    responseSchema: FileUploadResponse,
  })
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Upload a file to Notion.
 *
 * Creates a file upload object, sends the file data (single-part, or in 10 MiB
 * parts above 20 MiB), and returns the upload ID that can be referenced in
 * `pdf` or `file` blocks.
 *
 * @example
 * ```ts
 * const uploadId = yield* NotionFiles.upload({
 *   content: pdfBytes,
 *   filename: 'document.pdf',
 *   contentType: 'application/pdf',
 *   maxBytes: 64 * 1024 * 1024,
 * })
 *
 * // Use in a pdf block for inline preview:
 * yield* NotionBlocks.append({
 *   blockId: pageId,
 *   children: [{
 *     type: 'pdf',
 *     pdf: { type: 'file_upload', file_upload: { id: uploadId } },
 *   }],
 * })
 * ```
 */
export const upload = Effect.fn('NotionFiles.upload')(function* (opts: UploadFileOptions) {
  const totalBytes = opts.content.byteLength
  const maxBytes = opts.maxBytes ?? NOTION_FILE_UPLOAD_DEFAULT_MAX_BYTES

  if (Number.isSafeInteger(maxBytes) === false || maxBytes < 0) {
    return yield* uploadError({
      message: `maxBytes must be a non-negative safe integer, received ${maxBytes}`,
      path: '/file_uploads',
    })
  }

  /* Bound check before any HTTP call: a rejected upload must cost zero
   * requests and zero uploaded bytes. */
  if (totalBytes > maxBytes) {
    return yield* uploadError({
      message: `File "${opts.filename}" is ${totalBytes} bytes, exceeding the ${maxBytes}-byte upload limit`,
      path: '/file_uploads',
    })
  }

  const multipart = totalBytes > NOTION_FILE_UPLOAD_SINGLE_PART_MAX_BYTES
  const numberOfParts =
    multipart === true ? Math.ceil(totalBytes / NOTION_FILE_UPLOAD_PART_SIZE_BYTES) : undefined

  const createBody: CreateFileUploadRequest = {
    mode: multipart === true ? 'multi_part' : 'single_part',
    filename: opts.filename,
    content_type: opts.contentType,
    ...(numberOfParts === undefined ? {} : { number_of_parts: numberOfParts }),
  }

  const created = yield* post({
    path: '/file_uploads',
    body: createBody,
    responseSchema: FileUploadResponse,
  }).pipe(
    Effect.flatMap((response) =>
      expectStatus({ response, expected: 'pending', path: '/file_uploads', step: 'create' }),
    ),
  )

  if (numberOfParts === undefined) {
    yield* sendPart({
      uploadId: created.id,
      chunk: opts.content,
      filename: opts.filename,
      contentType: opts.contentType,
    }).pipe(
      Effect.flatMap((response) =>
        expectStatus({
          response,
          expected: 'uploaded',
          path: `/file_uploads/${created.id}/send`,
          step: 'send',
        }),
      ),
    )

    return created.id
  }

  /* Parts are sent sequentially: Notion allows concurrency, but the shared
   * throttle serializes requests anyway and sequential sends keep the failure
   * point (and progress) unambiguous. */
  for (let partNumber = 1; partNumber <= numberOfParts; partNumber++) {
    const start = (partNumber - 1) * NOTION_FILE_UPLOAD_PART_SIZE_BYTES
    const end = Math.min(start + NOTION_FILE_UPLOAD_PART_SIZE_BYTES, totalBytes)

    yield* sendPart({
      uploadId: created.id,
      chunk: opts.content.subarray(start, end),
      filename: opts.filename,
      contentType: opts.contentType,
      partNumber,
    }).pipe(
      Effect.flatMap((response) =>
        expectStatus({
          response,
          expected: 'pending',
          path: `/file_uploads/${created.id}/send`,
          step: `send part ${partNumber}/${numberOfParts}`,
        }),
      ),
    )
  }

  yield* post({
    path: `/file_uploads/${created.id}/complete`,
    body: {},
    responseSchema: FileUploadResponse,
  }).pipe(
    Effect.flatMap((response) =>
      expectStatus({
        response,
        expected: 'uploaded',
        path: `/file_uploads/${created.id}/complete`,
        step: 'complete',
      }),
    ),
  )

  return created.id
})

// ---------------------------------------------------------------------------
// Namespace export
// ---------------------------------------------------------------------------

/** Notion file upload operations */
export const NotionFiles = { upload } as const
