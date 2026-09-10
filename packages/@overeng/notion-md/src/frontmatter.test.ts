import { Effect, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import type { NmdFrontmatterV2 } from '@overeng/notion-effect-client'
import { PropertyDescriptors } from '@overeng/notion-effect-schema'

import { parseNmdFile, renderNmdFile } from './frontmatter.ts'

const pageId = '00000000-0000-4000-8000-000000000001'
const dataSourceId = '00000000-0000-4000-8000-000000000010'
const configHash = `sha256:${'b'.repeat(64)}`

const frontmatter: NmdFrontmatterV2 = {
  notion_md: {
    version: 2,
    api_version: '2026-03-11',
    object: 'page',
    source: 'local',
    page_id: pageId,
    url: 'https://www.notion.so/test',
    parent: { _tag: 'page', id: pageId },
    page: {
      title: 'Probe',
      icon: null,
      cover: null,
      in_trash: false,
      is_locked: false,
    },
    properties: {},
  },
}

/** Decoded via the shared strict decoder so keys carry the PropertyName brand. */
const descriptors = Schema.decodeSync(PropertyDescriptors, { onExcessProperty: 'error' })({
  Status: {
    property_id: 'prop_status_abc',
    property_name: 'Status',
    property_type: 'select',
    data_source_id: dataSourceId,
    config_hash: configHash,
  },
})

const frontmatterWithDescriptors: NmdFrontmatterV2 = {
  notion_md: {
    version: 2,
    api_version: '2026-03-11',
    object: 'page',
    source: 'shared',
    page_id: pageId,
    parent: { _tag: 'data_source', id: dataSourceId },
    page: {
      title: 'Datasource page',
      icon: null,
      cover: null,
      in_trash: false,
      is_locked: false,
    },
    properties: {},
    property_descriptors: descriptors,
  },
}

const parse = (content: string) => Effect.runPromise(parseNmdFile({ path: 'probe.nmd', content }))

describe('notion-md frontmatter parsing', () => {
  it('normalizes CRLF files into canonical Markdown bodies', async () => {
    const content = renderNmdFile({ frontmatter, body: '# Probe\r\n\r\nBody' }).replaceAll(
      '\n',
      '\r\n',
    )

    await expect(parse(content)).resolves.toMatchObject({
      body: '# Probe\n\nBody\n',
    })
  })

  it('rejects missing frontmatter markers', async () => {
    await expect(parse('# Probe\n\nBody')).rejects.toThrow(
      'Failed to parse strict .nmd frontmatter',
    )
  })

  it('rejects excess frontmatter properties', async () => {
    const content = renderNmdFile({ frontmatter, body: '# Probe\n\nBody' }).replace(
      '"notion_md":',
      '"extra": true,\n  "notion_md":',
    )

    await expect(parse(content)).rejects.toThrow('Failed to parse strict .nmd frontmatter')
  })
})

describe('notion-md frontmatter — property_descriptors standalone validity (R03)', () => {
  it('descriptor-bearing .nmd round-trips via the standalone parse path', async () => {
    const body = '# Datasource page\n\nBody content.\n'
    const content = renderNmdFile({ frontmatter: frontmatterWithDescriptors, body })
    const parsed = await parse(content)

    const statusDescriptor = Object.values(
      parsed.frontmatter.notion_md.property_descriptors ?? {},
    )[0]
    expect(statusDescriptor?.property_id).toBe('prop_status_abc')
    expect(statusDescriptor?.property_type).toBe('select')
    expect(parsed.body).toBe(body)
  })

  it('descriptor-free .nmd round-trips via the standalone parse path', async () => {
    const body = '# Standalone page\n\nBody content.\n'
    const content = renderNmdFile({ frontmatter, body })
    const parsed = await parse(content)

    expect(parsed.frontmatter.notion_md.property_descriptors).toBeUndefined()
    expect(parsed.body).toBe(body)
  })

  it('rendered descriptor-bearing file omits property_descriptors for standalone frontmatter', () => {
    const content = renderNmdFile({ frontmatter, body: 'body\n' })
    const parsed = JSON.parse(content.slice(4, content.indexOf('\n---\n', 4)))
    expect(Object.keys(parsed.notion_md)).not.toContain('property_descriptors')
  })

  it('rendered descriptor-bearing file includes property_descriptors for datasource frontmatter', () => {
    const content = renderNmdFile({ frontmatter: frontmatterWithDescriptors, body: 'body\n' })
    const parsed = JSON.parse(content.slice(4, content.indexOf('\n---\n', 4)))
    expect(parsed.notion_md).toHaveProperty('property_descriptors')
    expect(parsed.notion_md.property_descriptors['Status'].property_id).toBe('prop_status_abc')
  })

  it('rejects unknown field inside a descriptor via the standalone parse path (fail-closed)', async () => {
    const content = renderNmdFile({ frontmatter: frontmatterWithDescriptors, body: 'body\n' })
    const tampered = content.replace(
      '"config_hash"',
      '"settlement_proof": "injected",\n          "config_hash"',
    )
    await expect(parse(tampered)).rejects.toThrow('Failed to parse strict .nmd frontmatter')
  })
})

describe('notion-md frontmatter wire baselines (cross-major invariant)', () => {
  const richFrontmatter: NmdFrontmatterV2 = {
    notion_md: {
      version: 2,
      api_version: '2026-03-11',
      object: 'page',
      source: 'shared',
      page_id: pageId,
      url: null,
      parent: { _tag: 'data_source', id: dataSourceId, database_id: pageId },
      page: {
        title: 'Frontmatter 世界',
        icon: null,
        cover: {
          type: 'file',
          file: {
            url: 'https://example.com/cover.png',
            expiry_time: '2026-02-31T00:00:00.000Z',
          },
        },
        in_trash: false,
        is_locked: false,
      },
      properties: {
        Name: { _tag: 'title', value: 'Frontmatter 世界' },
        Due: {
          _tag: 'date',
          value: { start: '2026-02-31', end: null, time_zone: null },
        },
        Window: {
          _tag: 'date',
          value: { start: '2026-05-25T10:15:30.000Z', end: '2026-05-26', time_zone: null },
        },
        EmptySelect: { _tag: 'select', value: '' },
        NullStatus: { _tag: 'status', value: null },
        NaNAsText: { _tag: 'rich_text', value: 'NaN' },
        Attachments: {
          _tag: 'files',
          value: [
            {
              _tag: 'local_file',
              path: 'assets/résumé.pdf',
              content_hash: `sha256:${'1'.repeat(64)}`,
            },
            { _tag: 'external_url', url: 'https://example.com/résumé.pdf' },
          ],
        },
      },
      property_descriptors: descriptors,
    },
  }

  const rendered = () =>
    renderNmdFile({
      frontmatter: richFrontmatter,
      body: '# Frontmatter 世界\r\n\r\nBody with unicode résumé.\r\n',
    })

  it('renders the persisted .nmd envelope to byte-identical JSON frontmatter', () => {
    expect(rendered()).toMatchInlineSnapshot(`
      "---
      {
        "notion_md": {
          "version": 2,
          "api_version": "2026-03-11",
          "object": "page",
          "source": "shared",
          "page_id": "00000000-0000-4000-8000-000000000001",
          "url": null,
          "parent": {
            "_tag": "data_source",
            "id": "00000000-0000-4000-8000-000000000010",
            "database_id": "00000000-0000-4000-8000-000000000001"
          },
          "page": {
            "title": "Frontmatter 世界",
            "icon": null,
            "cover": {
              "type": "file",
              "file": {
                "url": "https://example.com/cover.png",
                "expiry_time": "2026-02-31T00:00:00.000Z"
              }
            },
            "in_trash": false,
            "is_locked": false
          },
          "properties": {
            "Name": {
              "_tag": "title",
              "value": "Frontmatter 世界"
            },
            "Due": {
              "_tag": "date",
              "value": {
                "start": "2026-02-31",
                "end": null,
                "time_zone": null
              }
            },
            "Window": {
              "_tag": "date",
              "value": {
                "start": "2026-05-25T10:15:30.000Z",
                "end": "2026-05-26",
                "time_zone": null
              }
            },
            "EmptySelect": {
              "_tag": "select",
              "value": ""
            },
            "NullStatus": {
              "_tag": "status",
              "value": null
            },
            "NaNAsText": {
              "_tag": "rich_text",
              "value": "NaN"
            },
            "Attachments": {
              "_tag": "files",
              "value": [
                {
                  "_tag": "local_file",
                  "path": "assets/résumé.pdf",
                  "content_hash": "sha256:1111111111111111111111111111111111111111111111111111111111111111"
                },
                {
                  "_tag": "external_url",
                  "url": "https://example.com/résumé.pdf"
                }
              ]
            }
          },
          "property_descriptors": {
            "Status": {
              "property_id": "prop_status_abc",
              "property_name": "Status",
              "property_type": "select",
              "data_source_id": "00000000-0000-4000-8000-000000000010",
              "config_hash": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
            }
          }
        }
      }
      ---

      # Frontmatter 世界

      Body with unicode résumé.
      "
    `)
  })

  it('parses the persisted .nmd envelope and re-renders byte-identically', async () => {
    const parsed = await parse(rendered().replaceAll('\n', '\r\n'))
    expect(JSON.stringify(parsed.frontmatter)).toMatchInlineSnapshot(
      `"{"notion_md":{"version":2,"api_version":"2026-03-11","object":"page","source":"shared","page_id":"00000000-0000-4000-8000-000000000001","url":null,"parent":{"_tag":"data_source","id":"00000000-0000-4000-8000-000000000010","database_id":"00000000-0000-4000-8000-000000000001"},"page":{"title":"Frontmatter 世界","icon":null,"cover":{"type":"file","file":{"url":"https://example.com/cover.png","expiry_time":"2026-02-31T00:00:00.000Z"}},"in_trash":false,"is_locked":false},"properties":{"Name":{"_tag":"title","value":"Frontmatter 世界"},"Due":{"_tag":"date","value":{"start":"2026-02-31","end":null,"time_zone":null}},"Window":{"_tag":"date","value":{"start":"2026-05-25T10:15:30.000Z","end":"2026-05-26","time_zone":null}},"EmptySelect":{"_tag":"select","value":""},"NullStatus":{"_tag":"status","value":null},"NaNAsText":{"_tag":"rich_text","value":"NaN"},"Attachments":{"_tag":"files","value":[{"_tag":"local_file","path":"assets/résumé.pdf","content_hash":"sha256:1111111111111111111111111111111111111111111111111111111111111111"},{"_tag":"external_url","url":"https://example.com/résumé.pdf"}]}},"property_descriptors":{"Status":{"property_id":"prop_status_abc","property_name":"Status","property_type":"select","data_source_id":"00000000-0000-4000-8000-000000000010","config_hash":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}}}"`,
    )
    expect(renderNmdFile(parsed)).toBe(rendered())
  })

  it('captures the parse failure partition as stable JSON', async () => {
    const failureJson = async (content: string) => {
      try {
        await parse(content)
      } catch (error) {
        const frontmatterError = error as {
          readonly _tag?: string
          readonly path?: string
          readonly message?: string
          readonly cause?: unknown
        }
        const cause = String(frontmatterError.cause)
        return JSON.stringify({ message: frontmatterError.message, cause })
      }
      throw new Error('Expected parse failure')
    }
    const invalidCases = {
      malformedJson: '---\n{"notion_md": \n---\n',
      remoteWithoutPageId: rendered()
        .replace('"source": "shared"', '"source": "remote"')
        .replace(`"page_id": "${pageId}"`, '"page_id": null'),
      descriptorExcessProperty: rendered().replace(
        '"config_hash":',
        '"extra": true,\n          "config_hash":',
      ),
      invalidRelativePath: rendered().replace('assets/résumé.pdf', '../résumé.pdf'),
      invalidSha256: rendered().replace(`sha256:${'1'.repeat(64)}`, 'sha256:not-hex'),
    }

    expect(await failureJson('# Missing frontmatter\n')).toMatchInlineSnapshot(
      `"{"message":"Failed to parse strict .nmd frontmatter in probe.nmd","cause":"Error: Expected \`.nmd\` frontmatter to start with \`---\`"}"`,
    )
    expect(
      Object.fromEntries(
        await Promise.all(
          Object.entries(invalidCases).map(async ([name, content]) => [
            name,
            await failureJson(content),
          ]),
        ),
      ),
    ).toMatchInlineSnapshot(`
      {
        "descriptorExcessProperty": "{"message":"Failed to parse strict .nmd frontmatter in probe.nmd","cause":"SchemaError(Expected no excess property\\n  at [\\"notion_md\\"][\\"property_descriptors\\"][\\"Status\\"][\\"extra\\"])"}",
        "invalidRelativePath": "{"message":"Failed to parse strict .nmd frontmatter in probe.nmd","cause":"SchemaError(Expected a non-empty relative path without parent traversal\\n  at [\\"notion_md\\"][\\"properties\\"][\\"Attachments\\"][\\"value\\"][0][\\"path\\"])"}",
        "invalidSha256": "{"message":"Failed to parse strict .nmd frontmatter in probe.nmd","cause":"SchemaError(Expected a string matching the RegExp ^sha256:[a-f0-9]{64}$\\n  at [\\"notion_md\\"][\\"properties\\"][\\"Attachments\\"][\\"value\\"][0][\\"content_hash\\"])"}",
        "malformedJson": "{"message":"Failed to parse strict .nmd frontmatter in probe.nmd","cause":"SchemaError(Expected a valid JSON string)"}",
        "remoteWithoutPageId": "{"message":"Failed to parse strict .nmd frontmatter in probe.nmd","cause":"SchemaError(source: remote requires a page_id (only source: local may be unbound / create-on-push)\\n  at [\\"notion_md\\"][\\"page_id\\"])"}",
      }
    `)
  })
})
