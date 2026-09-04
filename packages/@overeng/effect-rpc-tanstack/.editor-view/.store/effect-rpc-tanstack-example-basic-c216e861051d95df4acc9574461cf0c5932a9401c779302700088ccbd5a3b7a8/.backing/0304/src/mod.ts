import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { Effect, Schema } from 'effect'

/** Branded SHA-256 content digest in lowercase-hex `sha256:<64 hex>` form. */
export const ContentDigest = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
  Schema.brand('ContentAddress.ContentDigest'),
  Schema.annotate({ identifier: 'ContentAddress.ContentDigest' }),
)
export type ContentDigest = typeof ContentDigest.Type

/** Location-independent CAS retrieval URI in `cas:sha256/<byte>/<rest>` form. */
export const CasUri = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^cas:sha256\/[a-f0-9]{2}\/[a-f0-9]{62}$/)),
  Schema.brand('ContentAddress.CasUri'),
  Schema.annotate({ identifier: 'ContentAddress.CasUri' }),
)
export type CasUri = typeof CasUri.Type

const NonNegativeInt = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
)

/** Branded non-empty media (MIME) type describing the encoded byte payload. */
export const MediaType = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.brand('ContentAddress.MediaType'),
  Schema.annotate({ identifier: 'ContentAddress.MediaType' }),
)
export type MediaType = typeof MediaType.Type

/** Branded codec tag naming the byte-encoding scheme (e.g. `canonical-json`). */
export const Codec = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.brand('ContentAddress.Codec'),
  Schema.annotate({ identifier: 'ContentAddress.Codec' }),
)
export type Codec = typeof Codec.Type

/** Self-describing content-address record: digest + byte length + media type (optional codec/schema version). */
export const ContentDescriptor = Schema.TaggedStruct('ContentDescriptor', {
  digest: ContentDigest,
  byteLength: NonNegativeInt,
  mediaType: MediaType,
  codec: Schema.optional(Codec),
  schemaVersion: Schema.optional(NonNegativeInt),
}).annotate({ identifier: 'ContentAddress.ContentDescriptor' })
export type ContentDescriptor = typeof ContentDescriptor.Type

/** One child object referenced by a manifest, optionally with a stable logical path and role. */
export const ContentManifestEntry = Schema.Struct({
  descriptor: ContentDescriptor,
  logicalPath: Schema.optional(Schema.NonEmptyString.pipe(Schema.check(Schema.isTrimmed()))),
  role: Schema.optional(Schema.NonEmptyString.pipe(Schema.check(Schema.isTrimmed()))),
}).annotate({ identifier: 'ContentAddress.ContentManifestEntry' })
export type ContentManifestEntry = typeof ContentManifestEntry.Type

/** Versioned CAS manifest containing descriptors for a logical artifact or artifact set. */
export const ContentManifest = Schema.TaggedStruct('ContentManifest', {
  schemaVersion: Schema.Literal(1),
  role: Schema.NonEmptyString.pipe(Schema.check(Schema.isTrimmed())),
  createdAt: Schema.optional(Schema.DateTimeUtcFromString),
  entries: Schema.Array(ContentManifestEntry),
}).annotate({ identifier: 'ContentAddress.ContentManifest' })
export type ContentManifest = typeof ContentManifest.Type

/** Durable pin record that points a mutable name at an immutable manifest descriptor. */
export const ContentPin = Schema.TaggedStruct('ContentPin', {
  schemaVersion: Schema.Literal(1),
  target: ContentDescriptor,
}).annotate({ identifier: 'ContentAddress.ContentPin' })
export type ContentPin = typeof ContentPin.Type

/** Local filesystem-backed content store rooted at an absolute directory. */
export interface FileSystemContentStore {
  readonly _tag: 'FileSystemContentStore'
  readonly root: string
}

/** Raised by {@link verifyDescriptor} when bytes fail the descriptor's digest or byte-length check (fail-closed). */
export class ContentDescriptorMismatchError extends Schema.TaggedError<ContentDescriptorMismatchError>()(
  'ContentDescriptorMismatchError',
  {
    expectedDigest: ContentDigest,
    actualDigest: ContentDigest,
    expectedByteLength: NonNegativeInt,
    actualByteLength: NonNegativeInt,
    mediaType: MediaType,
    message: Schema.String,
  },
) {}

/** Raised when an object addressed by a descriptor is absent from the store. */
export class ContentObjectMissingError extends Schema.TaggedError<ContentObjectMissingError>()(
  'ContentObjectMissingError',
  {
    path: Schema.String,
    digest: ContentDigest,
    message: Schema.String,
  },
) {}

/** Raised when a mutable pin name has no record in the store. */
export class ContentPinMissingError extends Schema.TaggedError<ContentPinMissingError>()(
  'ContentPinMissingError',
  {
    name: Schema.String,
    path: Schema.String,
    message: Schema.String,
  },
) {}

/** Raised when filesystem access fails while reading or writing the store. */
export class ContentStoreIoError extends Schema.TaggedError<ContentStoreIoError>()(
  'ContentStoreIoError',
  {
    operation: Schema.String,
    path: Schema.String,
    cause: Schema.Defect(),
    message: Schema.String,
  },
) {}

/** Raised when a CAS URI and caller-provided descriptor identify different objects. */
export class CasUriDescriptorMismatchError extends Schema.TaggedError<CasUriDescriptorMismatchError>()(
  'CasUriDescriptorMismatchError',
  {
    uri: CasUri,
    expectedDigest: ContentDigest,
    uriDigest: ContentDigest,
    message: Schema.String,
  },
) {}

/** Raised when a `cas:` URI has the right scheme and algorithm but invalid object-path syntax. */
export class InvalidCasUriError extends Schema.TaggedError<InvalidCasUriError>()(
  'InvalidCasUriError',
  {
    uri: Schema.String,
    cause: Schema.Defect(),
    message: Schema.String,
  },
) {}

/** Raised when resolving a URI whose scheme is not `cas`. */
export class UnsupportedCasSchemeError extends Schema.TaggedError<UnsupportedCasSchemeError>()(
  'UnsupportedCasSchemeError',
  {
    uri: Schema.String,
    scheme: Schema.String,
    message: Schema.String,
  },
) {}

/** Raised when resolving a CAS URI whose digest algorithm is not supported. */
export class UnsupportedDigestAlgorithmError extends Schema.TaggedError<UnsupportedDigestAlgorithmError>()(
  'UnsupportedDigestAlgorithmError',
  {
    uri: Schema.String,
    algorithm: Schema.String,
    message: Schema.String,
  },
) {}

/** Raised when a pin name is empty, absolute, or contains unsafe path segments. */
export class UnsafePinNameError extends Schema.TaggedError<UnsafePinNameError>()(
  'UnsafePinNameError',
  {
    name: Schema.String,
    message: Schema.String,
  },
) {}

/** Raised when a pin target is not a canonical JSON ContentManifest descriptor. */
export class InvalidManifestDescriptorError extends Schema.TaggedError<InvalidManifestDescriptorError>()(
  'InvalidManifestDescriptorError',
  {
    digest: ContentDigest,
    mediaType: MediaType,
    codec: Schema.optional(Codec),
    schemaVersion: Schema.optional(NonNegativeInt),
    message: Schema.String,
  },
) {}

/** Raised when a pin file cannot be decoded as a versioned ContentPin record. */
export class InvalidPinRecordError extends Schema.TaggedError<InvalidPinRecordError>()(
  'InvalidPinRecordError',
  {
    name: Schema.String,
    path: Schema.String,
    cause: Schema.Defect(),
    message: Schema.String,
  },
) {}

/** Raised when descriptor-addressed manifest bytes cannot be decoded as a ContentManifest. */
export class InvalidManifestRecordError extends Schema.TaggedError<InvalidManifestRecordError>()(
  'InvalidManifestRecordError',
  {
    digest: ContentDigest,
    cause: Schema.Defect(),
    message: Schema.String,
  },
) {}

/** Error union for filesystem-backed content-address store operations. */
export type ContentAddressError =
  | ContentDescriptorMismatchError
  | ContentObjectMissingError
  | ContentPinMissingError
  | ContentStoreIoError
  | CasUriDescriptorMismatchError
  | InvalidCasUriError
  | UnsupportedCasSchemeError
  | UnsupportedDigestAlgorithmError
  | UnsafePinNameError
  | InvalidManifestDescriptorError
  | InvalidPinRecordError
  | InvalidManifestRecordError

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()
const decodeDigest = Schema.decodeUnknownSync(ContentDigest)
const decodeCasUri = Schema.decodeUnknownSync(CasUri)
const decodeMediaType = Schema.decodeUnknownSync(MediaType)
const decodeCodec = Schema.decodeUnknownSync(Codec)
const decodeDescriptor = Schema.decodeUnknownSync(ContentDescriptor)

/** Codec tag stamped on descriptors hashed via the canonical-JSON encoding. */
export const canonicalJsonCodec = decodeCodec('canonical-json')
/** Media type for canonical-JSON payloads. */
export const canonicalJsonMediaType = decodeMediaType('application/json')
/** Default media type for plain UTF-8 text payloads. */
export const utf8TextMediaType = decodeMediaType('text/plain; charset=utf-8')

/** Encode a string to its UTF-8 byte representation. */
export const utf8Bytes = (value: string): Uint8Array => textEncoder.encode(value)

/** Compute the SHA-256 {@link ContentDigest} of raw bytes. */
export const hashBytes = (bytes: Uint8Array): ContentDigest =>
  decodeDigest(`sha256:${bytesToHex(sha256(bytes))}`)

/** Hash a string by its UTF-8 bytes; equivalent to `hashBytes(utf8Bytes(value))`. */
export const hashUtf8 = (value: string): ContentDigest => hashBytes(utf8Bytes(value))

const canonicalizeJson = (value: unknown): string => {
  if (value === undefined) return '"[undefined]"'

  if (
    value !== null &&
    typeof value === 'object' &&
    'toJSON' in value &&
    typeof value.toJSON === 'function'
  ) {
    return canonicalizeJson(value.toJSON())
  }

  if (Array.isArray(value) === true) {
    return `[${value.map((item) => canonicalizeJson(item)).join(',')}]`
  }

  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      // Deterministic UTF-16 code-unit key order (locale-independent): `localeCompare`
      // depends on the host ICU/collation, which would let the same value canonicalize
      // to different byte orderings on different machines and break content addressing.
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalizeJson(item)}`)
      .join(',')}}`
  }

  return JSON.stringify(value)
}

/** Encode `value` and render it as canonical JSON with object keys sorted, for stable hashing across key-insertion order. */
export const canonicalJsonString = <TSchema extends Schema.Codec<any>>({
  schema,
  value,
}: {
  readonly schema: TSchema
  readonly value: Schema.Schema.Type<TSchema>
}): string => canonicalizeJson(Schema.encodeSync(schema)(value))

/** UTF-8 bytes of {@link canonicalJsonString} — the exact bytes that get hashed. */
export const canonicalJsonBytes = <TSchema extends Schema.Codec<any>>({
  schema,
  value,
}: {
  readonly schema: TSchema
  readonly value: Schema.Schema.Type<TSchema>
}): Uint8Array => utf8Bytes(canonicalJsonString({ schema, value }))

/** Content digest of a value's canonical-JSON encoding; stable regardless of object key order. */
export const hashCanonicalJson = <TSchema extends Schema.Codec<any>>({
  schema,
  value,
}: {
  readonly schema: TSchema
  readonly value: Schema.Schema.Type<TSchema>
}): ContentDigest => hashBytes(canonicalJsonBytes({ schema, value }))

/** Build a {@link ContentDescriptor} from raw bytes, hashing them and recording their byte length and media type. */
export const descriptorForBytes = ({
  bytes,
  mediaType,
  codec,
  schemaVersion,
}: {
  readonly bytes: Uint8Array
  readonly mediaType: MediaType | string
  readonly codec?: Codec | string
  readonly schemaVersion?: number
}): ContentDescriptor =>
  decodeDescriptor({
    _tag: 'ContentDescriptor',
    digest: hashBytes(bytes),
    byteLength: bytes.byteLength,
    mediaType,
    ...(codec === undefined ? {} : { codec }),
    ...(schemaVersion === undefined ? {} : { schemaVersion }),
  })

/** Build a descriptor for a UTF-8 string, defaulting the media type to {@link utf8TextMediaType}. */
export const descriptorForUtf8 = ({
  value,
  mediaType = utf8TextMediaType,
  codec,
  schemaVersion,
}: {
  readonly value: string
  readonly mediaType?: MediaType | string
  readonly codec?: Codec | string
  readonly schemaVersion?: number
}): ContentDescriptor =>
  descriptorForBytes({
    bytes: utf8Bytes(value),
    mediaType,
    ...(codec === undefined ? {} : { codec }),
    ...(schemaVersion === undefined ? {} : { schemaVersion }),
  })

/** Build a descriptor for a value's canonical-JSON encoding; stamps the canonical-JSON codec and media type and requires an explicit `schemaVersion`. */
export const descriptorForCanonicalJson = <TSchema extends Schema.Codec<any>>({
  schema,
  value,
  schemaVersion,
}: {
  readonly schema: TSchema
  readonly value: typeof schema.Type
  readonly schemaVersion: number
}): ContentDescriptor =>
  descriptorForBytes({
    bytes: canonicalJsonBytes({ schema, value }),
    mediaType: canonicalJsonMediaType,
    codec: canonicalJsonCodec,
    schemaVersion,
  })

/** Re-hash bytes and fail with {@link ContentDescriptorMismatchError} if digest or byte length disagree with the descriptor. */
export const verifyDescriptor = Effect.fn('ContentAddress.verifyDescriptor')(function* ({
  descriptor,
  bytes,
}: {
  readonly descriptor: ContentDescriptor
  readonly bytes: Uint8Array
}) {
  const actualDigest = hashBytes(bytes)
  if (actualDigest !== descriptor.digest || bytes.byteLength !== descriptor.byteLength) {
    return yield* new ContentDescriptorMismatchError({
      expectedDigest: descriptor.digest,
      actualDigest,
      expectedByteLength: descriptor.byteLength,
      actualByteLength: bytes.byteLength,
      mediaType: descriptor.mediaType,
      message: 'Content bytes do not match descriptor digest or byte length',
    })
  }
})

/** Derive a fan-out object-store path (`sha256/<first 2 hex>/<rest>`) from a digest, splitting on the first hex byte to avoid huge flat dirs. */
export const objectPathForDigest = (digest: ContentDigest | string): string => {
  const hex = Schema.decodeUnknownSync(ContentDigest)(digest).slice('sha256:'.length)
  return `sha256/${hex.slice(0, 2)}/${hex.slice(2)}`
}

/** Convert a fan-out object path back into its branded SHA-256 digest. */
export const digestForObjectPath = (objectPath: string): ContentDigest => {
  const match = /^sha256\/([a-f0-9]{2})\/([a-f0-9]{62})$/.exec(objectPath)
  if (match === null) {
    throw new Error(`Invalid content-address object path: ${objectPath}`)
  }
  return decodeDigest(`sha256:${match[1]}${match[2]}`)
}

/** Convert a digest into its stable `cas:` retrieval URI. */
export const casUriForDigest = (digest: ContentDigest | string): CasUri =>
  decodeCasUri(`cas:${objectPathForDigest(digest)}`)

/** Convert a content descriptor into the `cas:` URI for its digest. */
export const casUriForDescriptor = (descriptor: ContentDescriptor): CasUri =>
  casUriForDigest(descriptor.digest)

/** Extract the fan-out object path from a valid CAS URI. */
export const objectPathForCasUri = (uri: CasUri | string): string =>
  decodeCasUri(uri).slice('cas:'.length)

/** Extract the SHA-256 content digest from a valid CAS URI. */
export const digestForCasUri = (uri: CasUri | string): ContentDigest =>
  digestForObjectPath(objectPathForCasUri(uri))

const decodeCasUriEffect = Effect.fn('ContentAddress.decodeCasUri')(function* ({
  uri,
}: {
  readonly uri: CasUri | string
}) {
  const raw = String(uri)
  const schemeIndex = raw.indexOf(':')
  const scheme = schemeIndex === -1 ? '' : raw.slice(0, schemeIndex)
  if (scheme !== 'cas') {
    return yield* new UnsupportedCasSchemeError({
      uri: raw,
      scheme,
      message: 'Only cas: artifact URIs are supported',
    })
  }
  const algorithm = raw.slice('cas:'.length).split('/', 1)[0] ?? ''
  if (algorithm !== 'sha256') {
    return yield* new UnsupportedDigestAlgorithmError({
      uri: raw,
      algorithm,
      message: 'Only sha256 CAS object paths are supported',
    })
  }
  return yield* Effect.try({
    try: () => decodeCasUri(uri),
    catch: (cause) =>
      new InvalidCasUriError({
        uri: raw,
        cause,
        message: 'CAS URI must match cas:sha256/<first-byte>/<remaining-31-bytes>',
      }),
  })
})

/** Construct a filesystem store rooted at an absolute version of `root`. */
export const makeFileSystemContentStore = ({
  root,
}: {
  readonly root: string
}): FileSystemContentStore => ({ _tag: 'FileSystemContentStore', root: resolve(root) })

const safeJoin = ({
  root,
  relativePath,
}: {
  readonly root: string
  readonly relativePath: string
}) => {
  const fullPath = resolve(root, relativePath)
  const back = relative(root, fullPath)
  if (
    back === '' ||
    back === '..' ||
    back.startsWith(`..${sep}`) === true ||
    isAbsolute(back) === true
  ) {
    throw new Error(`Path escapes content store root: ${relativePath}`)
  }
  return fullPath
}

const objectPathForStore = ({
  store,
  descriptor,
}: {
  readonly store: FileSystemContentStore
  readonly descriptor: ContentDescriptor
}): string => safeJoin({ root: store.root, relativePath: objectPathForDigest(descriptor.digest) })

const catchIo =
  ({ operation, path }: { readonly operation: string; readonly path: string }) =>
  (cause: unknown) =>
    new ContentStoreIoError({
      operation,
      path,
      cause,
      message: `Content-address store ${operation} failed for ${path}`,
    })

const writeFileAtomic = Effect.fn('ContentAddress.writeFileAtomic')(function* ({
  path,
  bytes,
}: {
  readonly path: string
  readonly bytes: Uint8Array | string
}) {
  const tempPath = `${path}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`
  yield* Effect.tryPromise({
    try: () => mkdir(dirname(path), { recursive: true }),
    catch: catchIo({ operation: 'mkdir', path: dirname(path) }),
  })
  yield* Effect.tryPromise({
    try: () => writeFile(tempPath, bytes),
    catch: catchIo({ operation: 'write', path: tempPath }),
  }).pipe(
    Effect.tapError(() =>
      Effect.tryPromise({
        try: () => rm(tempPath, { force: true }),
        catch: catchIo({ operation: 'cleanup', path: tempPath }),
      }).pipe(Effect.ignore),
    ),
  )
  yield* Effect.tryPromise({
    try: () => rename(tempPath, path),
    catch: catchIo({ operation: 'rename', path }),
  }).pipe(
    Effect.tapError(() =>
      Effect.tryPromise({
        try: () => rm(tempPath, { force: true }),
        catch: catchIo({ operation: 'cleanup', path: tempPath }),
      }).pipe(Effect.ignore),
    ),
  )
})

const verifyManifestDescriptor = Effect.fn('ContentAddress.verifyManifestDescriptor')(function* ({
  descriptor,
}: {
  readonly descriptor: ContentDescriptor
}) {
  if (
    descriptor.mediaType !== canonicalJsonMediaType ||
    descriptor.codec !== canonicalJsonCodec ||
    descriptor.schemaVersion !== 1
  ) {
    return yield* new InvalidManifestDescriptorError({
      digest: descriptor.digest,
      mediaType: descriptor.mediaType,
      ...(descriptor.codec === undefined ? {} : { codec: descriptor.codec }),
      ...(descriptor.schemaVersion === undefined
        ? {}
        : { schemaVersion: descriptor.schemaVersion }),
      message: 'Manifest pins must target canonical JSON ContentManifest descriptors',
    })
  }
})

const decodeContentPinJson = Schema.decodeUnknownSync(Schema.fromJsonString(ContentPin))
const decodeContentManifestJson = Schema.decodeUnknownSync(Schema.fromJsonString(ContentManifest))

/** Store bytes under their descriptor-derived object path and return the descriptor. */
export const putBytes = Effect.fn('ContentAddress.putBytes')(function* ({
  store,
  bytes,
  mediaType,
  codec,
  schemaVersion,
}: {
  readonly store: FileSystemContentStore
  readonly bytes: Uint8Array
  readonly mediaType: MediaType | string
  readonly codec?: Codec | string
  readonly schemaVersion?: number
}) {
  const descriptor = descriptorForBytes({
    bytes,
    mediaType,
    ...(codec === undefined ? {} : { codec }),
    ...(schemaVersion === undefined ? {} : { schemaVersion }),
  })
  yield* writeFileAtomic({ path: objectPathForStore({ store, descriptor }), bytes })
  return descriptor
})

/** Read bytes for a descriptor and fail closed if the object content no longer matches. */
export const getBytes = Effect.fn('ContentAddress.getBytes')(function* ({
  store,
  descriptor,
}: {
  readonly store: FileSystemContentStore
  readonly descriptor: ContentDescriptor
}) {
  const path = objectPathForStore({ store, descriptor })
  const bytes = yield* Effect.tryPromise({
    try: () => readFile(path),
    catch: (cause) => {
      const code =
        typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined
      if (code === 'ENOENT') {
        return new ContentObjectMissingError({
          path,
          digest: descriptor.digest,
          message: `Content object is missing for digest ${descriptor.digest}`,
        })
      }
      return catchIo({ operation: 'read', path })(cause)
    },
  })
  const normalizedBytes = new Uint8Array(bytes)
  yield* verifyDescriptor({ descriptor, bytes: normalizedBytes })
  return normalizedBytes
})

/** Check whether the descriptor-addressed object currently exists as a file. */
export const hasBytes = Effect.fn('ContentAddress.hasBytes')(function* ({
  store,
  descriptor,
}: {
  readonly store: FileSystemContentStore
  readonly descriptor: ContentDescriptor
}) {
  const path = objectPathForStore({ store, descriptor })
  return yield* Effect.tryPromise({
    try: async () => {
      try {
        const entry = await stat(path)
        return entry.isFile()
      } catch (cause) {
        const code =
          typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined
        if (code === 'ENOENT') return false
        throw cause
      }
    },
    catch: catchIo({ operation: 'stat', path }),
  })
})

/** Resolve a CAS URI only when it agrees with the expected descriptor, then read the bytes. */
export const resolveCasUri = Effect.fn('ContentAddress.resolveCasUri')(function* ({
  store,
  uri,
  descriptor,
}: {
  readonly store: FileSystemContentStore
  readonly uri: CasUri | string
  readonly descriptor: ContentDescriptor
}) {
  const decodedUri = yield* decodeCasUriEffect({ uri })
  const uriDigest = digestForCasUri(decodedUri)
  if (uriDigest !== descriptor.digest) {
    return yield* new CasUriDescriptorMismatchError({
      uri: decodedUri,
      expectedDigest: descriptor.digest,
      uriDigest,
      message: 'CAS URI object path does not match descriptor digest',
    })
  }
  return yield* getBytes({ store, descriptor })
})

/** Store a canonical JSON ContentManifest and return its content descriptor. */
export const putManifest = Effect.fn('ContentAddress.putManifest')(function* ({
  store,
  manifest,
}: {
  readonly store: FileSystemContentStore
  readonly manifest: ContentManifest
}) {
  return yield* putBytes({
    store,
    bytes: canonicalJsonBytes({ schema: ContentManifest, value: manifest }),
    mediaType: canonicalJsonMediaType,
    codec: canonicalJsonCodec,
    schemaVersion: manifest.schemaVersion,
  })
})

const pinPathForName = Effect.fn('ContentAddress.pinPathForName')(function* ({
  store,
  name,
}: {
  readonly store: FileSystemContentStore
  readonly name: string
}) {
  if (
    name.trim() === '' ||
    name.includes('\0') === true ||
    name.split(/[\\/]/u).some((part) => part === '..' || part === '.' || part === '') === true
  ) {
    return yield* new UnsafePinNameError({
      name,
      message: 'Pin names must be non-empty relative paths without empty or parent segments',
    })
  }
  return safeJoin({ root: join(store.root, 'pins'), relativePath: name.split(/[\\/]/u).join(sep) })
})

/** Atomically update a mutable pin name to point at an immutable manifest descriptor. */
export const pinManifest = Effect.fn('ContentAddress.pinManifest')(function* ({
  store,
  name,
  manifestDescriptor,
}: {
  readonly store: FileSystemContentStore
  readonly name: string
  readonly manifestDescriptor: ContentDescriptor
}) {
  const path = yield* pinPathForName({ store, name })
  yield* verifyManifestDescriptor({ descriptor: manifestDescriptor })
  const manifestBytes = yield* getBytes({ store, descriptor: manifestDescriptor })
  yield* Effect.try({
    try: () => {
      const source = textDecoder.decode(manifestBytes)
      const manifest = decodeContentManifestJson(source)
      if (source !== canonicalJsonString({ schema: ContentManifest, value: manifest })) {
        throw new Error('Manifest JSON is not canonical')
      }
    },
    catch: (cause) =>
      new InvalidManifestRecordError({
        digest: manifestDescriptor.digest,
        cause,
        message: 'Manifest descriptor bytes are not a valid ContentManifest JSON document',
      }),
  })
  const pin = ContentPin.make({ schemaVersion: 1, target: manifestDescriptor })
  yield* writeFileAtomic({
    path,
    bytes: `${canonicalJsonString({ schema: ContentPin, value: pin })}\n`,
  })
})

/** Read and validate the manifest descriptor currently addressed by a pin name. */
export const getPinnedManifestDescriptor = Effect.fn('ContentAddress.getPinnedManifestDescriptor')(
  function* ({ store, name }: { readonly store: FileSystemContentStore; readonly name: string }) {
    const path = yield* pinPathForName({ store, name })
    const source = yield* Effect.tryPromise({
      try: () => readFile(path, 'utf8'),
      catch: (cause) => {
        const code =
          typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined
        if (code === 'ENOENT') {
          return new ContentPinMissingError({
            name,
            path,
            message: `Content pin is missing for ${name}`,
          })
        }
        return catchIo({ operation: 'read-pin', path })(cause)
      },
    })
    const pin = yield* Effect.try({
      try: () => decodeContentPinJson(source),
      catch: (cause) =>
        new InvalidPinRecordError({
          name,
          path,
          cause,
          message: 'Pin record is not a valid ContentPin JSON document',
        }),
    })
    yield* verifyManifestDescriptor({ descriptor: pin.target })
    return pin.target
  },
)

/** Check whether a valid pin path exists as a file without decoding its contents. */
export const hasPin = Effect.fn('ContentAddress.hasPin')(function* ({
  store,
  name,
}: {
  readonly store: FileSystemContentStore
  readonly name: string
}) {
  const path = yield* pinPathForName({ store, name })
  return yield* Effect.tryPromise({
    try: async () => {
      try {
        const entry = await stat(path)
        return entry.isFile()
      } catch (cause) {
        const code =
          typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined
        if (code === 'ENOENT') return false
        throw cause
      }
    },
    catch: catchIo({ operation: 'stat', path }),
  })
})
