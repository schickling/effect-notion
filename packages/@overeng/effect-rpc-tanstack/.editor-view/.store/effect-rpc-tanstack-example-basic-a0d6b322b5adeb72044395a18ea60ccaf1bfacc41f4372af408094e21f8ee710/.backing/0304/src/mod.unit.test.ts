import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DateTime, Effect, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  CasUriDescriptorMismatchError,
  ContentDescriptorMismatchError,
  ContentManifest,
  ContentObjectMissingError,
  InvalidManifestDescriptorError,
  InvalidManifestRecordError,
  InvalidCasUriError,
  UnsafePinNameError,
  UnsupportedCasSchemeError,
  UnsupportedDigestAlgorithmError,
  canonicalJsonCodec,
  canonicalJsonMediaType,
  canonicalJsonString,
  casUriForDescriptor,
  descriptorForCanonicalJson,
  descriptorForUtf8,
  getBytes,
  getPinnedManifestDescriptor,
  hashCanonicalJson,
  hasBytes,
  hasPin,
  makeFileSystemContentStore,
  objectPathForDigest,
  pinManifest,
  putBytes,
  putManifest,
  resolveCasUri,
  utf8Bytes,
  verifyDescriptor,
} from './mod.ts'

const Payload = Schema.Struct({
  alpha: Schema.String,
  nested: Schema.Struct({
    zed: Schema.Finite,
    beta: Schema.Array(Schema.String),
  }),
}).annotate({ identifier: 'ContentAddressTest.Payload' })

describe('@overeng/content-address', () => {
  it('hashes canonical JSON independent of object key insertion order', () => {
    const left = Payload.make({ alpha: 'a', nested: { zed: 1, beta: ['b'] } })
    const right = { nested: { beta: ['b'], zed: 1 }, alpha: 'a' }

    expect(hashCanonicalJson({ schema: Payload, value: left })).toBe(
      hashCanonicalJson({ schema: Payload, value: right }),
    )
  })

  it('sorts canonical JSON object keys by UTF-16 code unit, not host locale', () => {
    // Keys where locale order diverges from code-unit order: en-US collation sorts
    // 'a' before 'B', but UTF-16 code units put 'B' (66) before 'a' (97). A
    // locale-sensitive comparator would canonicalize this differently per machine.
    const Record = Schema.Record(Schema.String, Schema.Finite)
    const rendered = canonicalJsonString({ schema: Record, value: { a: 1, B: 0 } })

    expect(rendered).toBe('{"B":0,"a":1}')
  })

  it('describes canonical JSON with descriptor metadata', () => {
    const descriptor = descriptorForCanonicalJson({
      schema: Payload,
      value: Payload.make({ alpha: 'a', nested: { zed: 1, beta: ['b'] } }),
      schemaVersion: 1,
    })

    expect(descriptor).toMatchObject({
      _tag: 'ContentDescriptor',
      mediaType: 'application/json',
      codec: 'canonical-json',
      schemaVersion: 1,
    })
    expect(descriptor.digest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(descriptor.byteLength).toBeGreaterThan(0)
  })

  it('verifies matching bytes and fails closed on mismatches', async () => {
    const descriptor = descriptorForUtf8({ value: 'hello' })

    await expect(
      Effect.runPromise(verifyDescriptor({ descriptor, bytes: utf8Bytes('hello') })),
    ).resolves.toBeUndefined()
    const mismatch = await Effect.runPromise(
      verifyDescriptor({ descriptor, bytes: utf8Bytes('HELLO') }).pipe(Effect.result),
    )
    expect(mismatch._tag).toBe('Failure')
    if (mismatch._tag === 'Failure') {
      expect(mismatch.failure).toBeInstanceOf(ContentDescriptorMismatchError)
    }
  })

  it('derives a stable object path segment from a digest', () => {
    expect(objectPathForDigest(`sha256:${'a'.repeat(64)}`)).toBe(`sha256/aa/${'a'.repeat(62)}`)
  })

  it('writes descriptor-addressed bytes and resolves them through a cas URI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'content-address-'))
    const store = makeFileSystemContentStore({ root })
    try {
      const descriptor = await Effect.runPromise(
        putBytes({
          store,
          bytes: utf8Bytes('profile-bytes'),
          mediaType: 'application/octet-stream',
        }),
      )
      const uri = casUriForDescriptor(descriptor)

      await expect(Effect.runPromise(hasBytes({ store, descriptor }))).resolves.toBe(true)
      await expect(Effect.runPromise(getBytes({ store, descriptor }))).resolves.toEqual(
        utf8Bytes('profile-bytes'),
      )
      await expect(Effect.runPromise(resolveCasUri({ store, uri, descriptor }))).resolves.toEqual(
        utf8Bytes('profile-bytes'),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails closed when cas URI and descriptor disagree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'content-address-'))
    const store = makeFileSystemContentStore({ root })
    try {
      const descriptor = await Effect.runPromise(
        putBytes({ store, bytes: utf8Bytes('left'), mediaType: 'text/plain' }),
      )
      const other = await Effect.runPromise(
        putBytes({ store, bytes: utf8Bytes('right'), mediaType: 'text/plain' }),
      )

      const mismatch = await Effect.runPromise(
        resolveCasUri({ store, uri: casUriForDescriptor(other), descriptor }).pipe(Effect.result),
      )

      expect(mismatch._tag).toBe('Failure')
      if (mismatch._tag === 'Failure') {
        expect(mismatch.failure).toBeInstanceOf(CasUriDescriptorMismatchError)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails with a typed error for invalid cas URIs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'content-address-'))
    const store = makeFileSystemContentStore({ root })
    try {
      const descriptor = await Effect.runPromise(
        putBytes({ store, bytes: utf8Bytes('left'), mediaType: 'text/plain' }),
      )

      const invalid = await Effect.runPromise(
        resolveCasUri({ store, uri: 'cas:sha256/aa/not-enough', descriptor }).pipe(Effect.result),
      )

      expect(invalid._tag).toBe('Failure')
      if (invalid._tag === 'Failure') {
        expect(invalid.failure).toBeInstanceOf(InvalidCasUriError)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('distinguishes unsupported cas schemes and digest algorithms', async () => {
    const root = await mkdtemp(join(tmpdir(), 'content-address-'))
    const store = makeFileSystemContentStore({ root })
    try {
      const descriptor = await Effect.runPromise(
        putBytes({ store, bytes: utf8Bytes('left'), mediaType: 'text/plain' }),
      )

      const unsupportedScheme = await Effect.runPromise(
        resolveCasUri({ store, uri: 'file:///tmp/profile', descriptor }).pipe(Effect.result),
      )
      const unsupportedAlgorithm = await Effect.runPromise(
        resolveCasUri({ store, uri: `cas:blake3/${'a'.repeat(64)}`, descriptor }).pipe(
          Effect.result,
        ),
      )

      expect(unsupportedScheme._tag).toBe('Failure')
      if (unsupportedScheme._tag === 'Failure') {
        expect(unsupportedScheme.failure).toBeInstanceOf(UnsupportedCasSchemeError)
      }
      expect(unsupportedAlgorithm._tag).toBe('Failure')
      if (unsupportedAlgorithm._tag === 'Failure') {
        expect(unsupportedAlgorithm.failure).toBeInstanceOf(UnsupportedDigestAlgorithmError)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps malformed sha256 cas paths as invalid URI errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'content-address-'))
    const store = makeFileSystemContentStore({ root })
    try {
      const descriptor = await Effect.runPromise(
        putBytes({ store, bytes: utf8Bytes('left'), mediaType: 'text/plain' }),
      )

      const invalid = await Effect.runPromise(
        resolveCasUri({ store, uri: 'cas:sha256/not-enough', descriptor }).pipe(Effect.result),
      )

      expect(invalid._tag).toBe('Failure')
      if (invalid._tag === 'Failure') {
        expect(invalid.failure).toBeInstanceOf(InvalidCasUriError)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('stores canonical manifests and writes manifest pins as retention roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'content-address-'))
    const store = makeFileSystemContentStore({ root })
    try {
      const artifact = await Effect.runPromise(
        putBytes({ store, bytes: utf8Bytes('profile'), mediaType: 'application/octet-stream' }),
      )
      const manifest = ContentManifest.make({
        schemaVersion: 1,
        role: 'otel-scrape-run',
        entries: [{ descriptor: artifact, logicalPath: 'profiles/profile.cpuprofile' }],
      })
      const manifestDescriptor = await Effect.runPromise(putManifest({ store, manifest }))

      expect(manifestDescriptor.mediaType).toBe(canonicalJsonMediaType)
      expect(manifestDescriptor.codec).toBe(canonicalJsonCodec)
      await Effect.runPromise(pinManifest({ store, name: 'runs/run-1', manifestDescriptor }))

      await expect(Effect.runPromise(hasPin({ store, name: 'runs/run-1' }))).resolves.toBe(true)
      const pinSource = await readFile(join(root, 'pins', 'runs', 'run-1'), 'utf8')
      expect(pinSource).toContain(manifestDescriptor.digest)
      await expect(
        Effect.runPromise(getPinnedManifestDescriptor({ store, name: 'runs/run-1' })),
      ).resolves.toMatchObject({ digest: manifestDescriptor.digest })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('round-trips manifests containing createdAt through the ISO-string wire codec', async () => {
    const root = await mkdtemp(join(tmpdir(), 'content-address-'))
    const store = makeFileSystemContentStore({ root })
    try {
      const artifact = await Effect.runPromise(
        putBytes({ store, bytes: utf8Bytes('profile'), mediaType: 'application/octet-stream' }),
      )
      const manifest = ContentManifest.make({
        schemaVersion: 1,
        role: 'otel-scrape-run',
        createdAt: DateTime.makeUnsafe('2026-08-24T00:00:00.000Z'),
        entries: [{ descriptor: artifact, logicalPath: 'profiles/profile.cpuprofile' }],
      })
      const manifestDescriptor = await Effect.runPromise(putManifest({ store, manifest }))

      const storedJson = new TextDecoder().decode(
        await Effect.runPromise(getBytes({ store, descriptor: manifestDescriptor })),
      )
      const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(ContentManifest))(storedJson)
      expect(decoded.createdAt).toBeDefined()
      expect(DateTime.toEpochMillis(decoded.createdAt!)).toBe(
        DateTime.toEpochMillis(manifest.createdAt!),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects unsafe pin names before writing store metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'content-address-'))
    const store = makeFileSystemContentStore({ root })
    try {
      const artifact = await Effect.runPromise(
        putBytes({ store, bytes: utf8Bytes('profile'), mediaType: 'application/octet-stream' }),
      )
      const unsafe = await Effect.runPromise(
        pinManifest({ store, name: '../escape', manifestDescriptor: artifact }).pipe(Effect.result),
      )
      const dot = await Effect.runPromise(
        pinManifest({ store, name: '.', manifestDescriptor: artifact }).pipe(Effect.result),
      )
      const dotted = await Effect.runPromise(
        pinManifest({ store, name: 'runs/.', manifestDescriptor: artifact }).pipe(Effect.result),
      )

      expect(unsafe._tag).toBe('Failure')
      if (unsafe._tag === 'Failure') {
        expect(unsafe.failure).toBeInstanceOf(UnsafePinNameError)
      }
      expect(dot._tag).toBe('Failure')
      if (dot._tag === 'Failure') {
        expect(dot.failure).toBeInstanceOf(UnsafePinNameError)
      }
      expect(dotted._tag).toBe('Failure')
      if (dotted._tag === 'Failure') {
        expect(dotted.failure).toBeInstanceOf(UnsafePinNameError)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('allows safe pin path segments that merely start with dots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'content-address-'))
    const store = makeFileSystemContentStore({ root })
    try {
      const manifest = ContentManifest.make({
        schemaVersion: 1,
        role: 'otel-scrape-run',
        entries: [],
      })
      const manifestDescriptor = await Effect.runPromise(putManifest({ store, manifest }))

      await expect(
        Effect.runPromise(pinManifest({ store, name: '..foo/run-1', manifestDescriptor })),
      ).resolves.toBeUndefined()
      await expect(Effect.runPromise(hasPin({ store, name: '..foo/run-1' }))).resolves.toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects direct blob descriptors as manifest pins', async () => {
    const root = await mkdtemp(join(tmpdir(), 'content-address-'))
    const store = makeFileSystemContentStore({ root })
    try {
      const artifact = await Effect.runPromise(
        putBytes({ store, bytes: utf8Bytes('profile'), mediaType: 'application/octet-stream' }),
      )
      const invalidPin = await Effect.runPromise(
        pinManifest({ store, name: 'runs/run-1', manifestDescriptor: artifact }).pipe(
          Effect.result,
        ),
      )

      expect(invalidPin._tag).toBe('Failure')
      if (invalidPin._tag === 'Failure') {
        expect(invalidPin.failure).toBeInstanceOf(InvalidManifestDescriptorError)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects manifest pins whose target object is not stored locally', async () => {
    const root = await mkdtemp(join(tmpdir(), 'content-address-'))
    const store = makeFileSystemContentStore({ root })
    try {
      const manifest = ContentManifest.make({
        schemaVersion: 1,
        role: 'otel-scrape-run',
        entries: [],
      })
      const missingDescriptor = descriptorForCanonicalJson({
        schema: ContentManifest,
        value: manifest,
        schemaVersion: 1,
      })

      const invalidPin = await Effect.runPromise(
        pinManifest({ store, name: 'runs/run-1', manifestDescriptor: missingDescriptor }).pipe(
          Effect.result,
        ),
      )

      expect(invalidPin._tag).toBe('Failure')
      if (invalidPin._tag === 'Failure') {
        expect(invalidPin.failure).toBeInstanceOf(ContentObjectMissingError)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects manifest pins whose stored target does not decode as a manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'content-address-'))
    const store = makeFileSystemContentStore({ root })
    try {
      const malformedManifestDescriptor = await Effect.runPromise(
        putBytes({
          store,
          bytes: utf8Bytes('{}'),
          mediaType: canonicalJsonMediaType,
          codec: canonicalJsonCodec,
          schemaVersion: 1,
        }),
      )

      const invalidPin = await Effect.runPromise(
        pinManifest({
          store,
          name: 'runs/run-1',
          manifestDescriptor: malformedManifestDescriptor,
        }).pipe(Effect.result),
      )

      expect(invalidPin._tag).toBe('Failure')
      if (invalidPin._tag === 'Failure') {
        expect(invalidPin.failure).toBeInstanceOf(InvalidManifestRecordError)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects manifest pins whose stored target is not canonical JSON', async () => {
    const root = await mkdtemp(join(tmpdir(), 'content-address-'))
    const store = makeFileSystemContentStore({ root })
    try {
      const manifest = ContentManifest.make({
        schemaVersion: 1,
        role: 'otel-scrape-run',
        entries: [],
      })
      const nonCanonicalManifestDescriptor = await Effect.runPromise(
        putBytes({
          store,
          bytes: utf8Bytes(
            `${canonicalJsonString({ schema: ContentManifest, value: manifest })}\n`,
          ),
          mediaType: canonicalJsonMediaType,
          codec: canonicalJsonCodec,
          schemaVersion: 1,
        }),
      )

      const invalidPin = await Effect.runPromise(
        pinManifest({
          store,
          name: 'runs/run-1',
          manifestDescriptor: nonCanonicalManifestDescriptor,
        }).pipe(Effect.result),
      )

      expect(invalidPin._tag).toBe('Failure')
      if (invalidPin._tag === 'Failure') {
        expect(invalidPin.failure).toBeInstanceOf(InvalidManifestRecordError)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
