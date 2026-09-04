/** Encodes a 32-bit number to 4 bytes (big-endian) */
export const encodeNumberTo4Bytes = (num: number): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(4)
  bytes[0] = num >> 24
  bytes[1] = num >> 16
  bytes[2] = num >> 8
  bytes[3] = num
  return bytes
}

/** Decodes 4 bytes to a 32-bit number (big-endian) */
export const decode4BytesToNumber = (bytes: Uint8Array<ArrayBuffer>): number => {
  return (bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!
}

/** Concatenates multiple byte arrays into a single Uint8Array */
export const concatBytes = (
  ...arrays: (Uint8Array<ArrayBuffer> | Uint8ClampedArray)[]
): Uint8Array<ArrayBuffer> => {
  const totalSize = arrays.reduce((acc, array) => acc + array.byteLength, 0)

  const result = new Uint8Array(totalSize)

  for (let i = 0, offset = 0; i < arrays.length; i++) {
    const array = arrays[i]!
    const arraySize = array.byteLength
    result.set(array, offset)
    offset += arraySize
  }

  return result
}

/**
 * Ensures a Uint8Array is backed by an ArrayBuffer (not SharedArrayBuffer or other ArrayBufferLike).
 * This is necessary for TypeScript 5.9+ compatibility where Uint8Array<ArrayBuffer> is required
 * for many Web APIs.
 */
export const ensureUint8ArrayBuffer = (array: Uint8Array): Uint8Array<ArrayBuffer> => {
  if (array.buffer instanceof ArrayBuffer) {
    return array as Uint8Array<ArrayBuffer>
  }
  // Copy to ensure ArrayBuffer backing if it's SharedArrayBuffer or other ArrayBufferLike
  const buffer = new ArrayBuffer(array.byteLength)
  const result = new Uint8Array(buffer)
  result.set(array)
  return result
}

/**
 * Encodes text to UTF-8 bytes backed by an ArrayBuffer.
 * Replaces the need for `textEncoder.encode(text) as Uint8Array<ArrayBuffer>` pattern.
 */
export const textEncodeToArrayBuffer = (text: string): Uint8Array<ArrayBuffer> => {
  const encoded = new TextEncoder().encode(text)
  return ensureUint8ArrayBuffer(encoded)
}

/**
 * Type guard to check if a Uint8Array is backed by an ArrayBuffer.
 */
export const isUint8ArrayBuffer = (array: Uint8Array): array is Uint8Array<ArrayBuffer> => {
  return array.buffer instanceof ArrayBuffer
}

/**
 * Converts any Uint8Array to one backed by an ArrayBuffer.
 * Safer alternative to type assertions.
 */
export const toUint8ArrayBuffer = (array: Uint8Array): Uint8Array<ArrayBuffer> => {
  if (isUint8ArrayBuffer(array) === true) {
    return array
  }
  // Copy to ensure ArrayBuffer backing
  const buffer = new ArrayBuffer(array.byteLength)
  const result = new Uint8Array(buffer)
  result.set(array)
  return result
}
