/**
 * JSON helpers for tests.
 *
 * Thin wrappers over `Schema.fromJsonString(Schema.Unknown)` so test fixtures encode
 * and assertions decode JSON through the schema path (no raw `JSON.parse` /
 * `JSON.stringify`). Behavior matches the plain JSON primitives for the opaque
 * fixture shapes exercised here.
 */

import { Schema } from 'effect'

const JsonValue = Schema.fromJsonString(Schema.Unknown)

/** Encode an arbitrary JSON-serializable value to a JSON string (no indentation). */
export const encodeJson = (value: unknown): string => Schema.encodeSync(JsonValue)(value)

/** Decode a JSON string to an unknown value (throws on invalid JSON, like `JSON.parse`). */
export const decodeJson = (content: string): unknown => Schema.decodeSync(JsonValue)(content)
