import { Schema } from 'effect'

import {
  CasUri,
  Codec,
  ContentDigest,
  MediaType,
  type ContentDescriptor,
} from '@overeng/content-address'

const NonNegativeInt = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
)

/** Opaque native profile kind, e.g. `cpuprofile`, `tsc-trace`, or `cargo-timings`. */
export const OtelScrapeProfileType = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.brand('OtelScrape.ProfileType'),
  Schema.annotate({ identifier: 'OtelScrape.ProfileType' }),
)
export type OtelScrapeProfileType = typeof OtelScrapeProfileType.Type

/** Flat span payload for a content-addressed native profile artifact. */
export const OtelScrapeProfileLink = Schema.Struct({
  type: OtelScrapeProfileType,
  digest: ContentDigest,
  uri: CasUri,
  byteLength: NonNegativeInt,
  mediaType: MediaType,
  codec: Schema.optional(Codec),
  schemaVersion: Schema.optional(NonNegativeInt),
  ui: Schema.optional(Schema.NonEmptyString.pipe(Schema.check(Schema.isTrimmed()))),
}).annotate({ identifier: 'OtelScrape.ProfileLink' })
export type OtelScrapeProfileLink = typeof OtelScrapeProfileLink.Type

/** Build the VRS-defined flat profile link from the reusable content descriptor. */
export const otelScrapeProfileLinkFromDescriptor = ({
  type,
  descriptor,
  uri,
  ui,
}: {
  readonly type: string
  readonly descriptor: ContentDescriptor
  readonly uri: CasUri
  readonly ui?: string
}): OtelScrapeProfileLink =>
  Schema.decodeUnknownSync(OtelScrapeProfileLink)({
    type,
    digest: descriptor.digest,
    uri,
    byteLength: descriptor.byteLength,
    mediaType: descriptor.mediaType,
    ...(descriptor.codec === undefined ? {} : { codec: descriptor.codec }),
    ...(descriptor.schemaVersion === undefined ? {} : { schemaVersion: descriptor.schemaVersion }),
    ...(ui === undefined ? {} : { ui }),
  })
