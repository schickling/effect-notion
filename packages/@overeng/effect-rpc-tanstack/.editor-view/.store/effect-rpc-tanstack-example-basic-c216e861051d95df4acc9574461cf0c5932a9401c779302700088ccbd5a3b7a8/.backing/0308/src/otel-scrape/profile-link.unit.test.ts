import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { Effect, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  ContentManifest,
  casUriForDescriptor,
  getPinnedManifestDescriptor,
  makeFileSystemContentStore,
  pinManifest,
  putBytes,
  putManifest,
  resolveCasUri,
  utf8Bytes,
} from '@overeng/content-address'

import {
  OtelScrapeProfileLink,
  otelScrapeAttributeKeys,
  otelScrapeProfileLinkFromDescriptor,
} from '../mod.ts'

const execFileAsync = promisify(execFile)

/** Reads one Buck-declared immutable tool path; nothing resolves through an ambient PATH. */
const requireTool = (name: string): string => {
  const tool = process.env[name]
  if (tool === undefined || tool === '')
    throw new Error(`declared test tool is unavailable: ${name}`)
  return tool
}

const startOteliteCapture = async ({
  otelite,
  out,
}: {
  readonly otelite: string
  readonly out: string
}) => {
  const child = spawn(otelite, ['capture', '--out', out], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')

  let stdout = ''
  let stderr = ''
  let endpointsLine:
    | {
        readonly resolve: (line: string) => void
        readonly reject: (cause: Error) => void
      }
    | undefined
  const endpointsReady = new Promise<string>((resolve, reject) => {
    endpointsLine = { resolve, reject }
  })

  child.stdout.on('data', (chunk: string) => {
    stdout += chunk
    const lineEnd = stdout.indexOf('\n')
    if (lineEnd >= 0 && endpointsLine !== undefined) {
      endpointsLine.resolve(stdout.slice(0, lineEnd))
      endpointsLine = undefined
    }
  })
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })
  child.once('error', (cause) => {
    endpointsLine?.reject(cause)
    endpointsLine = undefined
  })
  child.once('exit', (code) => {
    if (endpointsLine !== undefined) {
      endpointsLine.reject(new Error(`otelite capture exited before endpoints: ${code}`))
      endpointsLine = undefined
    }
  })

  const endpoints = JSON.parse(await endpointsReady)
  expect(endpoints.schema).toBe('otelite.endpoints/v1')

  return {
    endpoints: { http: endpoints.http as string },
    stop: async () => {
      child.stdin.end()
      const [code] = (await once(child, 'exit')) as [number | null]
      if (code !== 0) {
        throw new Error(`otelite capture failed with ${code}: ${stderr}`)
      }
      const summaryLine = stdout
        .trim()
        .split('\n')
        .find((line) => line.includes('"otelite.summary/v1"'))
      if (summaryLine === undefined) {
        throw new Error(`otelite capture did not emit a summary: ${stdout}`)
      }
      return JSON.parse(summaryLine)
    },
  }
}

const attrValue = (
  attrs: ReadonlyArray<{ readonly key?: unknown; readonly value?: Record<string, unknown> }>,
  key: string,
) => {
  const value = attrs.find((attr) => attr.key === key)?.value
  return value?.stringValue ?? value?.intValue ?? value?.doubleValue ?? value?.boolValue
}

describe('otel-scrape profile links', () => {
  it('links profile bytes through CAS descriptors, URIs, manifests, and pins', async () => {
    const root = await mkdtemp(join(tmpdir(), 'otel-scrape-profile-link-'))
    const store = makeFileSystemContentStore({ root })

    try {
      const bytes = utf8Bytes('profile fixture')
      const descriptor = await Effect.runPromise(
        putBytes({
          store,
          bytes,
          mediaType: 'application/vnd.chrome.cpuprofile+json',
          schemaVersion: 1,
        }),
      )
      const uri = casUriForDescriptor(descriptor)
      const link = otelScrapeProfileLinkFromDescriptor({
        type: 'cpuprofile',
        descriptor,
        uri,
      })

      expect(Schema.decodeUnknownSync(OtelScrapeProfileLink)(link)).toEqual(link)
      expect(link).toMatchObject({
        type: 'cpuprofile',
        digest: descriptor.digest,
        uri,
        byteLength: bytes.byteLength,
        mediaType: 'application/vnd.chrome.cpuprofile+json',
        schemaVersion: 1,
      })

      const manifest = ContentManifest.make({
        schemaVersion: 1,
        role: 'otel-scrape-run',
        entries: [
          {
            descriptor,
            logicalPath: 'profiles/profile.cpuprofile',
            role: 'profile:cpuprofile',
          },
        ],
      })
      const manifestDescriptor = await Effect.runPromise(putManifest({ store, manifest }))
      await Effect.runPromise(
        pinManifest({
          store,
          name: 'otel-scrape/run-1',
          manifestDescriptor,
        }),
      )

      await expect(
        Effect.runPromise(getPinnedManifestDescriptor({ store, name: 'otel-scrape/run-1' })),
      ).resolves.toMatchObject({ digest: manifestDescriptor.digest })
      await expect(
        Effect.runPromise(resolveCasUri({ store, uri: link.uri, descriptor })),
      ).resolves.toEqual(bytes)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('decodes a real otel-scrape node-cpuprofile link captured by otelite', async () => {
    const root = await mkdtemp(join(tmpdir(), 'otel-scrape-e2e-'))
    const captureRoot = join(root, 'otelite')
    const casRoot = join(root, 'cas')
    const summaryPath = join(root, 'summary.json')
    const store = makeFileSystemContentStore({ root: casRoot })
    const privateArg = 'PRIVATE_E2E_ARG_MARKER'

    try {
      const otelite = requireTool('OTELITE_BIN')
      const otelScrape = requireTool('OTEL_SCRAPE_BIN')
      const capture = await startOteliteCapture({ otelite, out: captureRoot })
      const run = await execFileAsync(
        otelScrape,
        [
          '--adapter',
          'node-cpuprofile',
          '--summary-out',
          summaryPath,
          '--otlp-endpoint',
          capture.endpoints.http,
          '--service-name',
          'otel-scrape-contract-e2e',
          '--cas-root',
          casRoot,
          '--cas-pin',
          'runs/contract-e2e',
          '--',
          requireTool('NODE_BIN'),
          '-e',
          'for (let i = 0; i < 100000; i++) Math.sqrt(i); console.log(process.argv[1])',
          privateArg,
        ],
        { maxBuffer: 1024 * 1024 * 10 },
      )
      const captureSummary = await capture.stop()

      expect(run.stdout).toBe(`${privateArg}\n`)
      expect(run.stderr).not.toContain(privateArg)
      expect(captureSummary.counts).toMatchObject({ spans: 1, rejected: 0 })

      const summary = JSON.parse(await readFile(summaryPath, 'utf8'))
      expect(summary.child.exit_code).toBe(0)
      expect(summary.adapter.name).toBe('node-cpuprofile')
      expect(summary.artifacts.manifest).toMatchObject({
        pin: 'runs/contract-e2e',
        entryCount: 1,
      })
      expect(summary.artifacts.errors).toEqual([])

      const profileLink = Schema.decodeUnknownSync(OtelScrapeProfileLink)(
        summary.artifacts.profiles[0],
      )
      expect(profileLink.type).toBe('cpuprofile')
      expect(profileLink.byteLength).toBeGreaterThan(0)
      expect(profileLink.mediaType).toBe('application/octet-stream')

      const profileBytes = await Effect.runPromise(
        resolveCasUri({
          store,
          uri: profileLink.uri,
          descriptor: {
            _tag: 'ContentDescriptor',
            digest: profileLink.digest,
            byteLength: profileLink.byteLength,
            mediaType: profileLink.mediaType,
          },
        }),
      )
      const profile = JSON.parse(new TextDecoder().decode(profileBytes))
      expect(Array.isArray(profile.nodes)).toBe(true)
      expect(profile.nodes.length).toBeGreaterThan(0)

      const pinnedManifest = await Effect.runPromise(
        getPinnedManifestDescriptor({ store, name: 'runs/contract-e2e' }),
      )
      expect(pinnedManifest.digest).toBe(summary.artifacts.manifest.digest)

      const inspect = await execFileAsync(
        otelite,
        [
          'inspect',
          captureRoot,
          '--signal',
          'traces',
          '--service',
          'otel-scrape-contract-e2e',
          '--attr',
          `${otelScrapeAttributeKeys.otelScrapeSpanOrigin}=otel-scrape`,
          '--attr',
          `${otelScrapeAttributeKeys.processExecutableName}=node`,
        ],
        { maxBuffer: 1024 * 1024 * 10 },
      )
      const rows = inspect.stdout
        .trim()
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line))
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        schema: 'otelite.span/v1',
        service: 'otel-scrape-contract-e2e',
        name: 'node',
        attrs: {
          [otelScrapeAttributeKeys.otelScrapeSpanOrigin]: 'otel-scrape',
          [otelScrapeAttributeKeys.processExecutableName]: 'node',
        },
      })

      const rawCapture = await readFile(join(captureRoot, 'traces.ndjson'), 'utf8')
      const firstCaptureLine = rawCapture.trim().split('\n')[0]
      if (firstCaptureLine === undefined) {
        throw new Error('otelite trace capture was empty')
      }
      const otlpPayload = JSON.parse(firstCaptureLine)
      const span =
        otlpPayload.resourceSpans[0].scopeSpans[0].spans.find(
          (candidate: {
            readonly attributes?: ReadonlyArray<{
              readonly key?: unknown
              readonly value?: Record<string, unknown>
            }>
            readonly name?: unknown
          }) =>
            candidate.name === 'node' &&
            attrValue(candidate.attributes ?? [], otelScrapeAttributeKeys.otelScrapeSpanOrigin) ===
              'otel-scrape' &&
            attrValue(candidate.attributes ?? [], otelScrapeAttributeKeys.processExecutableName) ===
              'node',
        ) ?? {}
      const event = span.events.find(
        (candidate: { readonly name?: unknown }) => candidate.name === 'otel_scrape.profile.link',
      )
      expect(event).toBeDefined()
      const eventAttrs = event.attributes as ReadonlyArray<{
        readonly key?: unknown
        readonly value?: Record<string, unknown>
      }>
      const eventProfileLink = Schema.decodeUnknownSync(OtelScrapeProfileLink)({
        type: attrValue(eventAttrs, 'profile.type'),
        digest: attrValue(eventAttrs, 'profile.digest'),
        uri: attrValue(eventAttrs, 'profile.uri'),
        byteLength: Number(attrValue(eventAttrs, 'byteLength')),
        mediaType: attrValue(eventAttrs, 'mediaType'),
      })
      expect(eventProfileLink).toEqual(profileLink)

      const summaryJson = JSON.stringify(summary)
      const otlpJson = JSON.stringify(otlpPayload)
      expect(summaryJson).not.toContain(privateArg)
      expect(summaryJson).not.toContain(root)
      expect(summaryJson).not.toContain('100000')
      expect(otlpJson).not.toContain(privateArg)
      expect(otlpJson).not.toContain(root)
      expect(otlpJson).not.toContain('100000')
      expect(otlpJson).not.toContain(new TextDecoder().decode(profileBytes))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
