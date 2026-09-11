import { Schema } from 'effect'

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
