import { sha1 } from '@noble/hashes/legacy.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

const textEncoder = new TextEncoder()
const toHashBytes = (data: string | Uint8Array): Uint8Array =>
  typeof data === 'string' ? textEncoder.encode(data) : data

/** Computes SHA-256 hash and returns it as a hex string */
export const sha256Hex = (data: string | Uint8Array): string =>
  bytesToHex(sha256(toHashBytes(data)))

/** Computes SHA-1 hash and returns it as a hex string */
export const sha1Hex = (data: string | Uint8Array): string => bytesToHex(sha1(toHashBytes(data)))
