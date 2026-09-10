import { createHash } from 'node:crypto'

import { type DateTime, Cause, Effect, Exit, Option, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  CanonicalEncodeError,
  encodeCanonicalPatch,
  makeCanonicalCodec,
} from './canonical-codec.ts'
import {
  type CanonicalPropertyValue,
  type PageId,
  propertyWriteClassFromType,
} from './canonical.ts'

/**
 * Replica of the consuming sync package's `canonicalHash` (stableStringify +
 * sha256, `sha256:`-prefixed). The codec takes the hasher injected; this mirror
 * lets the golden assertions reproduce the exact `valueHash`/`identityHash`
 * bytes captured from the production decode path.
 */
const stableStringify = (value: unknown): string => {
  if (value === undefined) return '"[undefined]"'
  if (
    value !== null &&
    typeof value === 'object' &&
    'toJSON' in value &&
    typeof (value as { toJSON: unknown }).toJSON === 'function'
  ) {
    return stableStringify((value as { toJSON: () => unknown }).toJSON())
  }
  if (Array.isArray(value) === true) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/** Extracts the typed error channel from a failed `Effect.runPromiseExit` result (v4 Cause shape). */
const exitError = (exit: Exit.Exit<unknown, unknown>): CanonicalEncodeError | undefined =>
  Exit.isFailure(exit) === true
    ? Option.getOrUndefined(
        Cause.findErrorOption(exit.cause) as Option.Option<CanonicalEncodeError>,
      )
    : undefined

const canonicalHash = (value: unknown): string =>
  `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`

const codec = makeCanonicalCodec({ hash: canonicalHash })

/**
 * Each fixture is a raw Notion `properties` record. The expected map is keyed by
 * the resulting property key with the canonical `JSON.stringify` bytes as value
 * (empty object = the entry is deliberately dropped). Captured from the previous
 * nds decode implementation prior to the move — byte-for-byte.
 */
const goldenMatrix: Record<
  string,
  { readonly props: Record<string, unknown>; readonly expected: Record<string, string> }
> = {
  'title-present': {
    props: {
      Title: {
        id: 'p-title',
        type: 'title',
        title: [{ plain_text: 'Hello ' }, { plain_text: 'World' }],
      },
    },
    expected: { 'p-title': '{"_tag":"title","plainText":"Hello World"}' },
  },
  'title-missing-array': {
    props: { Title: { id: 'p-title', type: 'title', title: null } },
    expected: {},
  },
  'title-empty-array': {
    props: { Title: { id: 'p-title', type: 'title', title: [] } },
    expected: { 'p-title': '{"_tag":"title","plainText":""}' },
  },
  'rich-present': {
    props: {
      Rich: {
        id: 'p-rich',
        type: 'rich_text',
        rich_text: [{ plain_text: 'a' }, { plain_text: 'b' }],
      },
    },
    expected: { 'p-rich': '{"_tag":"rich_text","plainText":"ab"}' },
  },
  'rich-missing-array': {
    props: { Rich: { id: 'p-rich', type: 'rich_text', rich_text: 42 } },
    expected: {},
  },
  'number-present': {
    props: { Num: { id: 'p-num', type: 'number', number: 3.14 } },
    expected: { 'p-num': '{"_tag":"number","value":3.14}' },
  },
  'number-null': {
    props: { Num: { id: 'p-num', type: 'number', number: null } },
    expected: { 'p-num': '{"_tag":"empty"}' },
  },
  'number-zero': {
    props: { Num: { id: 'p-num', type: 'number', number: 0 } },
    expected: { 'p-num': '{"_tag":"number","value":0}' },
  },
  'checkbox-true': {
    props: { Chk: { id: 'p-chk', type: 'checkbox', checkbox: true } },
    expected: { 'p-chk': '{"_tag":"checkbox","checked":true}' },
  },
  'checkbox-false': {
    props: { Chk: { id: 'p-chk', type: 'checkbox', checkbox: false } },
    expected: { 'p-chk': '{"_tag":"checkbox","checked":false}' },
  },
  'checkbox-missing': {
    props: { Chk: { id: 'p-chk', type: 'checkbox' } },
    expected: { 'p-chk': '{"_tag":"checkbox","checked":false}' },
  },
  'date-start-end': {
    props: { D: { id: 'p-date', type: 'date', date: { start: '2026-05-25', end: '2026-05-26' } } },
    expected: { 'p-date': '{"_tag":"date","start":"2026-05-25","end":"2026-05-26"}' },
  },
  'date-start-only': {
    props: { D: { id: 'p-date', type: 'date', date: { start: '2026-05-25', end: null } } },
    expected: { 'p-date': '{"_tag":"date","start":"2026-05-25","end":null}' },
  },
  'date-start-no-end-field': {
    props: { D: { id: 'p-date', type: 'date', date: { start: '2026-05-25' } } },
    expected: { 'p-date': '{"_tag":"date","start":"2026-05-25","end":null}' },
  },
  'date-null': {
    props: { D: { id: 'p-date', type: 'date', date: null } },
    expected: { 'p-date': '{"_tag":"empty"}' },
  },
  'date-no-start': {
    props: { D: { id: 'p-date', type: 'date', date: { end: '2026-05-26' } } },
    expected: { 'p-date': '{"_tag":"empty"}' },
  },
  'select-full': {
    props: {
      S: { id: 'p-sel', type: 'select', select: { id: 'o1', name: 'Doing', color: 'blue' } },
    },
    expected: {
      'p-sel':
        '{"_tag":"select","option":{"_tag":"CanonicalOptionValue","id":"o1","name":"Doing","color":"blue"}}',
    },
  },
  'select-no-id-color': {
    props: { S: { id: 'p-sel', type: 'select', select: { name: 'Todo' } } },
    expected: {
      'p-sel': '{"_tag":"select","option":{"_tag":"CanonicalOptionValue","name":"Todo"}}',
    },
  },
  'select-null': {
    props: { S: { id: 'p-sel', type: 'select', select: null } },
    expected: { 'p-sel': '{"_tag":"select","option":null}' },
  },
  'status-full': {
    props: {
      St: { id: 'p-st', type: 'status', status: { id: 'o2', name: 'In progress', color: 'green' } },
    },
    expected: {
      'p-st':
        '{"_tag":"status","option":{"_tag":"CanonicalOptionValue","id":"o2","name":"In progress","color":"green"}}',
    },
  },
  'status-null': {
    props: { St: { id: 'p-st', type: 'status', status: null } },
    expected: { 'p-st': '{"_tag":"status","option":null}' },
  },
  'multi-mixed': {
    props: {
      M: {
        id: 'p-multi',
        type: 'multi_select',
        multi_select: [
          { name: 'Backend' },
          { id: 'o3', name: 'API', color: 'blue' },
          'not-an-object',
        ],
      },
    },
    expected: {
      'p-multi':
        '{"_tag":"multi_select","options":[{"_tag":"CanonicalOptionValue","name":"Backend"},{"_tag":"CanonicalOptionValue","id":"o3","name":"API","color":"blue"}]}',
    },
  },
  'multi-empty': {
    props: { M: { id: 'p-multi', type: 'multi_select', multi_select: [] } },
    expected: { 'p-multi': '{"_tag":"multi_select","options":[]}' },
  },
  'multi-missing': {
    props: { M: { id: 'p-multi', type: 'multi_select', multi_select: null } },
    expected: { 'p-multi': '{"_tag":"multi_select","options":[]}' },
  },
  'relation-two': {
    props: {
      R: {
        id: 'p-rel',
        type: 'relation',
        relation: [{ id: 'page-a' }, { id: 'page-b' }, { foo: 1 }],
      },
    },
    expected: { 'p-rel': '{"_tag":"relation","pageIds":["page-a","page-b"]}' },
  },
  'relation-empty': {
    props: { R: { id: 'p-rel', type: 'relation', relation: [] } },
    expected: { 'p-rel': '{"_tag":"relation","pageIds":[]}' },
  },
  'relation-missing': {
    props: { R: { id: 'p-rel', type: 'relation', relation: null } },
    expected: { 'p-rel': '{"_tag":"relation","pageIds":[]}' },
  },
  'people-two': {
    props: {
      P: {
        id: 'p-people',
        type: 'people',
        people: [{ id: 'user-1' }, { id: 'user-2' }, { name: 'x' }],
      },
    },
    expected: { 'p-people': '{"_tag":"people","userIds":["user-1","user-2"]}' },
  },
  'people-empty': {
    props: { P: { id: 'p-people', type: 'people', people: [] } },
    expected: { 'p-people': '{"_tag":"people","userIds":[]}' },
  },
  'people-missing': {
    props: { P: { id: 'p-people', type: 'people', people: null } },
    expected: { 'p-people': '{"_tag":"people","userIds":[]}' },
  },
  'files-external': {
    props: {
      F: {
        id: 'p-files',
        type: 'files',
        files: [{ name: 'doc.pdf', external: { url: 'https://x/doc.pdf' } }],
      },
    },
    expected: {
      'p-files':
        '{"_tag":"files","files":[{"_tag":"CanonicalFileValue","name":"doc.pdf","identityHash":"sha256:b2181123edc68b45d312c3ac371d949ddbbf3599f3264f077f94090972774c5f","externalUrl":"https://x/doc.pdf"}]}',
    },
  },
  'files-notion-hosted': {
    props: {
      F: {
        id: 'p-files',
        type: 'files',
        files: [{ name: 'img.png', file: { url: 'https://notion/img.png' } }],
      },
    },
    expected: {
      'p-files':
        '{"_tag":"files","files":[{"_tag":"CanonicalFileValue","name":"img.png","identityHash":"sha256:979a9ee3089bee9958cb95db976a3525d5e83d22e33d094e06d356c08dd33cd6"}]}',
    },
  },
  'files-mixed-and-nameless': {
    props: {
      F: {
        id: 'p-files',
        type: 'files',
        files: [
          { name: 'a.txt', external: { url: 'https://x/a.txt' } },
          { name: '' },
          { external: { url: 'y' } },
        ],
      },
    },
    expected: {
      'p-files':
        '{"_tag":"files","files":[{"_tag":"CanonicalFileValue","name":"a.txt","identityHash":"sha256:fda0c96145950e44a83f2e8950da1b9d39a719306e96c77379e20121cd77fd6c","externalUrl":"https://x/a.txt"}]}',
    },
  },
  'files-empty': {
    props: { F: { id: 'p-files', type: 'files', files: [] } },
    expected: { 'p-files': '{"_tag":"files","files":[]}' },
  },
  'files-missing': {
    props: { F: { id: 'p-files', type: 'files', files: null } },
    expected: { 'p-files': '{"_tag":"files","files":[]}' },
  },
  'email-present': {
    props: { E: { id: 'p-email', type: 'email', email: 'ada@example.com' } },
    expected: { 'p-email': '{"_tag":"email","value":"ada@example.com"}' },
  },
  'email-null': {
    props: { E: { id: 'p-email', type: 'email', email: null } },
    expected: { 'p-email': '{"_tag":"email","value":null}' },
  },
  'url-present': {
    props: { U: { id: 'p-url', type: 'url', url: 'https://notion.so' } },
    expected: { 'p-url': '{"_tag":"url","value":"https://notion.so"}' },
  },
  'url-null': {
    props: { U: { id: 'p-url', type: 'url', url: null } },
    expected: { 'p-url': '{"_tag":"url","value":null}' },
  },
  'phone-present': {
    props: { Ph: { id: 'p-phone', type: 'phone_number', phone_number: '+1 555' } },
    expected: { 'p-phone': '{"_tag":"phone_number","value":"+1 555"}' },
  },
  'phone-null': {
    props: { Ph: { id: 'p-phone', type: 'phone_number', phone_number: null } },
    expected: { 'p-phone': '{"_tag":"phone_number","value":null}' },
  },
  formula: {
    props: { Fo: { id: 'p-formula', type: 'formula', formula: { type: 'number', number: 7 } } },
    expected: {
      'p-formula':
        '{"_tag":"computed","valueHash":"sha256:27a344990a7203d682ad8f4072252649609e9e9a15f9a71b80dc325fdfb1f1df"}',
    },
  },
  rollup: {
    props: {
      Ro: {
        id: 'p-rollup',
        type: 'rollup',
        rollup: { type: 'number', number: 12, function: 'sum' },
      },
    },
    expected: {
      'p-rollup':
        '{"_tag":"computed","valueHash":"sha256:f789b82597abfa277b67c7679b0b8acbf6a62189c33c1720be10521ed8017422"}',
    },
  },
  'created-time': {
    props: { Ct: { id: 'p-ct', type: 'created_time', created_time: '2026-01-01T00:00:00.000Z' } },
    expected: {
      'p-ct':
        '{"_tag":"computed","valueHash":"sha256:1c70cc7d7f55673a946a6168737b6442dffc8c575a27767dbeafa4a30b8837ab"}',
    },
  },
  'created-by': {
    props: { Cb: { id: 'p-cb', type: 'created_by', created_by: { id: 'user-9', object: 'user' } } },
    expected: {
      'p-cb':
        '{"_tag":"computed","valueHash":"sha256:19d32e89c473d08c9cb4a72da2fee56e4d6c51228d1c8922d65bd54f342ab30f"}',
    },
  },
  'last-edited-time': {
    props: {
      Le: { id: 'p-le', type: 'last_edited_time', last_edited_time: '2026-02-02T00:00:00.000Z' },
    },
    expected: {
      'p-le':
        '{"_tag":"computed","valueHash":"sha256:afffe5dd5d2a876167fc85d8b5216957be6369141d583ab2e9c989e8d2b443bc"}',
    },
  },
  'last-edited-by': {
    props: {
      Lb: { id: 'p-lb', type: 'last_edited_by', last_edited_by: { id: 'user-8', object: 'user' } },
    },
    expected: {
      'p-lb':
        '{"_tag":"computed","valueHash":"sha256:5acb5b20507dc5804ad8ea4529e2baf543a61476af591aed27a4b925280ab546"}',
    },
  },
  'unique-id-dropped': {
    props: { Ui: { id: 'p-ui', type: 'unique_id', unique_id: { prefix: 'TASK', number: 5 } } },
    expected: {},
  },
  'verification-dropped': {
    props: { Ve: { id: 'p-ve', type: 'verification', verification: { state: 'verified' } } },
    expected: {},
  },
  'button-dropped': {
    props: { Bt: { id: 'p-bt', type: 'button', button: {} } },
    expected: {},
  },
  'unknown-type-dropped': {
    props: { Un: { id: 'p-un', type: 'something_new', something_new: { x: 1 } } },
    expected: {},
  },
  'no-type-field-dropped': {
    props: { Nt: { id: 'p-nt', foo: 'bar' } },
    expected: {},
  },
  'fallback-key-no-id': {
    props: { 'Fallback Name': { type: 'number', number: 99 } },
    expected: { 'Fallback Name': '{"_tag":"number","value":99}' },
  },
}

describe('canonical decode (golden byte-identity)', () => {
  // The decoder passes the raw input key straight through; the consuming package
  // (nds) derives the PropertyId-based key. The hashed contract is the *value*
  // bytes, so the golden assertion compares the sorted list of decoded value
  // JSON strings against the captured golden values (key-independent).
  for (const [name, { props, expected }] of Object.entries(goldenMatrix)) {
    it(`decodes ${name} to byte-identical canonical JSON`, async () => {
      const decoded = await Effect.runPromise(codec.decodePageProperties(props))
      const decodedValues = Object.values(decoded).map((value) => JSON.stringify(value))
      const expectedValues = Object.values(expected)
      expect(decodedValues.toSorted()).toEqual(expectedValues.toSorted())
    })
  }

  it('decode returns Option.none for dropped types', async () => {
    const dropped = await Effect.runPromise(codec.decode({ id: 'x', type: 'button', button: {} }))
    expect(Option.isNone(dropped)).toBe(true)
  })
})

describe('canonical wire baselines (cross-major invariant)', () => {
  it('decodes a representative property map to byte-identical canonical JSON', async () => {
    const decoded = await Effect.runPromise(
      codec.decodePageProperties({
        Title: {
          id: 'title-id',
          type: 'title',
          title: [{ plain_text: 'Hello ' }, { plain_text: '世界' }],
        },
        Due: {
          id: 'date-id',
          type: 'date',
          date: { start: '2026-05-25T10:15:30.000Z' },
        },
        'Impossible Date': {
          id: 'bad-date-id',
          type: 'date',
          date: { start: '2026-02-31' },
        },
        'Absent Date': {
          id: 'empty-date-id',
          type: 'date',
          date: null,
        },
        Select: {
          id: 'select-id',
          type: 'select',
          select: { id: 'option-id', name: '', color: 'blue' },
        },
        'Select Without Option Id': {
          id: 'select-name-id',
          type: 'select',
          select: { name: 'Backlog' },
        },
        Email: {
          id: 'email-id',
          type: 'email',
          email: null,
        },
        File: {
          id: 'file-id',
          type: 'files',
          files: [{ name: 'résumé.pdf', external: { url: 'https://example.com/résumé.pdf' } }],
        },
        'Dropped Unsupported': {
          id: 'button-id',
          type: 'button',
          button: {},
        },
      }),
    )

    expect(JSON.stringify(decoded)).toMatchInlineSnapshot(
      `"{"Title":{"_tag":"title","plainText":"Hello 世界"},"Due":{"_tag":"date","start":"2026-05-25T10:15:30.000Z","end":null},"Impossible Date":{"_tag":"date","start":"2026-02-31","end":null},"Absent Date":{"_tag":"empty"},"Select":{"_tag":"select","option":{"_tag":"CanonicalOptionValue","id":"option-id","name":"","color":"blue"}},"Select Without Option Id":{"_tag":"select","option":{"_tag":"CanonicalOptionValue","name":"Backlog"}},"Email":{"_tag":"email","value":null},"File":{"_tag":"files","files":[{"_tag":"CanonicalFileValue","name":"résumé.pdf","identityHash":"sha256:06673ae69feae64882e27bccbd3a018924435dc16321bcf11613cbaad6952dd1","externalUrl":"https://example.com/résumé.pdf"}]}}"`,
    )
  })

  it('encodes a representative write patch to byte-identical Notion JSON', async () => {
    const patch = await Effect.runPromise(
      encodeCanonicalPatch({
        title: { _tag: 'title', plainText: 'Hello 世界' },
        dateWithEnd: {
          _tag: 'date',
          start: dateTimeUtc('2026-05-25T10:15:30.000Z'),
          end: dateTimeUtc('2026-05-26T10:15:30.000Z'),
        },
        dateWithoutEnd: {
          _tag: 'date',
          start: dateTimeUtc('2026-05-25T00:00:00.000Z'),
          end: null,
        },
        selectFull: { _tag: 'select', option: opt('', { id: 'option-id', color: 'blue' }) },
        selectNameOnly: { _tag: 'select', option: opt('Backlog') },
        selectNull: { _tag: 'select', option: null },
        multi: {
          _tag: 'multi_select',
          options: [opt('Plain'), opt('Colored', { id: 'colored-id', color: 'green' })],
        },
        emailNull: { _tag: 'email', value: null },
        file: {
          _tag: 'files',
          files: [
            {
              _tag: 'CanonicalFileValue',
              name: 'résumé.pdf',
              identityHash: 'sha256:ignored-by-encoder',
              externalUrl: 'https://example.com/résumé.pdf',
            },
          ],
        },
      }),
    )

    expect(JSON.stringify(patch)).toMatchInlineSnapshot(
      `"{"title":{"title":[{"type":"text","text":{"content":"Hello 世界"}}]},"dateWithEnd":{"date":{"start":"2026-05-25T10:15:30.000Z","end":"2026-05-26T10:15:30.000Z"}},"dateWithoutEnd":{"date":{"start":"2026-05-25T00:00:00.000Z"}},"selectFull":{"select":{"id":"option-id","name":"","color":"blue"}},"selectNameOnly":{"select":{"name":"Backlog"}},"selectNull":{"select":null},"multi":{"multi_select":[{"name":"Plain"},{"id":"colored-id","name":"Colored","color":"green"}]},"emailNull":{"email":null},"file":{"files":[{"type":"external","name":"résumé.pdf","external":{"url":"https://example.com/résumé.pdf"}}]}}"`,
    )
  })

  it('captures the encode failure partition as stable JSON', async () => {
    const failureJson = async (value: CanonicalPropertyValue) => {
      const exit = await Effect.runPromiseExit(encodeCanonicalPatch({ value }))
      const error = exitError(exit)
      expect(error).toBeInstanceOf(CanonicalEncodeError)
      return JSON.stringify({
        _tag: error?._tag,
        tag: error?.tag,
        reason: error?.reason,
        message: error?.message,
      })
    }

    expect(await failureJson({ _tag: 'computed', valueHash: 'sha256:abc' })).toMatchInlineSnapshot(
      `"{"_tag":"Notion.CanonicalEncodeError","tag":"computed","reason":"computed","message":"Computed Notion properties cannot be written"}"`,
    )
    expect(await failureJson({ _tag: 'files', files: [] })).toMatchInlineSnapshot(
      `"{"_tag":"Notion.CanonicalEncodeError","tag":"files","reason":"unsupported_remote_shape","message":"Files property writes require explicit external URL or modeled file_upload identity for every file"}"`,
    )
    expect(await failureJson({ _tag: 'empty' })).toMatchInlineSnapshot(
      `"{"_tag":"Notion.CanonicalEncodeError","tag":"empty","reason":"unsupported_remote_shape","message":"Canonical empty property writes need additional remote shape information"}"`,
    )
  })
})

const dateTimeUtc = (iso: string): DateTime.Utc =>
  Schema.decodeSync(Schema.DateTimeUtcFromString)(iso)

type Opt = Extract<CanonicalPropertyValue, { _tag: 'select' }>['option'] & object

const opt = (name: string, extra: { readonly id?: string; readonly color?: string } = {}): Opt =>
  ({
    _tag: 'CanonicalOptionValue',
    ...(extra.id === undefined ? {} : { id: extra.id }),
    name,
    ...(extra.color === undefined ? {} : { color: extra.color }),
  }) as Opt

describe('canonical encode (Notion write-payload matrix)', () => {
  it('encodes the supported writable property matrix', async () => {
    const patch = await Effect.runPromise(
      encodeCanonicalPatch({
        title: { _tag: 'title', plainText: 'Task title' },
        rich: { _tag: 'rich_text', plainText: 'Longer note' },
        number: { _tag: 'number', value: 42 },
        checkbox: { _tag: 'checkbox', checked: true },
        date: {
          _tag: 'date',
          start: dateTimeUtc('2026-05-25T10:00:00.000Z'),
          end: dateTimeUtc('2026-05-26T10:00:00.000Z'),
        },
        select: { _tag: 'select', option: opt('Doing', { id: 'opt-1' }) },
        'select-null': { _tag: 'select', option: null },
        multi: {
          _tag: 'multi_select',
          options: [opt('Backend'), opt('API', { id: 'opt-2', color: 'blue' })],
        },
        status: { _tag: 'status', option: opt('In progress') },
        relation: {
          _tag: 'relation',
          pageIds: ['related-page-1', 'related-page-2'].map((id) => id as PageId),
        },
        people: { _tag: 'people', userIds: ['user-1', 'user-2'] },
        email: { _tag: 'email', value: 'ada@example.com' },
        url: { _tag: 'url', value: 'https://developers.notion.com/' },
        phone: { _tag: 'phone_number', value: '+1 555 0100' },
        'email-null': { _tag: 'email', value: null },
        'url-null': { _tag: 'url', value: null },
        'phone-null': { _tag: 'phone_number', value: null },
      }),
    )

    expect(patch).toEqual({
      title: { title: [{ type: 'text', text: { content: 'Task title' } }] },
      rich: { rich_text: [{ type: 'text', text: { content: 'Longer note' } }] },
      number: { number: 42 },
      checkbox: { checkbox: true },
      date: { date: { start: '2026-05-25T10:00:00.000Z', end: '2026-05-26T10:00:00.000Z' } },
      select: { select: { id: 'opt-1', name: 'Doing' } },
      'select-null': { select: null },
      multi: { multi_select: [{ name: 'Backend' }, { id: 'opt-2', name: 'API', color: 'blue' }] },
      status: { status: { name: 'In progress' } },
      relation: { relation: [{ id: 'related-page-1' }, { id: 'related-page-2' }] },
      people: { people: [{ id: 'user-1' }, { id: 'user-2' }] },
      email: { email: 'ada@example.com' },
      url: { url: 'https://developers.notion.com/' },
      phone: { phone_number: '+1 555 0100' },
      'email-null': { email: null },
      'url-null': { url: null },
      'phone-null': { phone_number: null },
    })
  })

  it('encodes date with null end by omitting the end field', async () => {
    const patch = await Effect.runPromise(
      encodeCanonicalPatch({
        d: { _tag: 'date', start: dateTimeUtc('2026-05-25T00:00:00.000Z'), end: null },
      }),
    )
    expect(patch).toEqual({ d: { date: { start: '2026-05-25T00:00:00.000Z' } } })
  })

  it('encodes external files and omits absent option id/color', async () => {
    const patch = await Effect.runPromise(
      encodeCanonicalPatch({
        files: {
          _tag: 'files',
          files: [
            {
              _tag: 'CanonicalFileValue',
              name: 'a.txt',
              identityHash: 'sha256:x',
              externalUrl: 'https://x/a.txt',
            },
          ],
        },
      }),
    )
    expect(patch).toEqual({
      files: { files: [{ type: 'external', name: 'a.txt', external: { url: 'https://x/a.txt' } }] },
    })
  })

  it('fails computed property writes with reason computed', async () => {
    const exit = await Effect.runPromiseExit(
      encodeCanonicalPatch({ f: { _tag: 'computed', valueHash: 'sha256:abc' } }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    const error = exitError(exit)
    expect(error).toBeInstanceOf(CanonicalEncodeError)
    expect(error?.reason).toBe('computed')
  })

  it('fails non-external files with reason unsupported_remote_shape', async () => {
    const exit = await Effect.runPromiseExit(
      encodeCanonicalPatch({ f: { _tag: 'files', files: [] } }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    const error = exitError(exit)
    expect(error).toBeInstanceOf(CanonicalEncodeError)
    expect(error?.reason).toBe('unsupported_remote_shape')
  })

  it('fails empty canonical value with reason unsupported_remote_shape', async () => {
    const exit = await Effect.runPromiseExit(encodeCanonicalPatch({ e: { _tag: 'empty' } }))
    expect(Exit.isFailure(exit)).toBe(true)
    const error = exitError(exit)
    expect(error?.reason).toBe('unsupported_remote_shape')
  })
})

describe('propertyWriteClassFromType', () => {
  const cases: ReadonlyArray<[string, 'writable' | 'computed' | 'unsupported']> = [
    ['title', 'writable'],
    ['rich_text', 'writable'],
    ['number', 'writable'],
    ['checkbox', 'writable'],
    ['date', 'writable'],
    ['select', 'writable'],
    ['multi_select', 'writable'],
    ['status', 'writable'],
    ['email', 'writable'],
    ['url', 'writable'],
    ['phone_number', 'writable'],
    ['relation', 'writable'],
    ['people', 'writable'],
    ['files', 'writable'],
    ['formula', 'computed'],
    ['rollup', 'computed'],
    ['created_time', 'computed'],
    ['created_by', 'computed'],
    ['last_edited_time', 'computed'],
    ['last_edited_by', 'computed'],
    ['unique_id', 'computed'],
    ['verification', 'computed'],
    ['button', 'unsupported'],
    ['something_new', 'unsupported'],
  ]
  for (const [type, expected] of cases) {
    it(`classifies ${type} as ${expected}`, () => {
      expect(propertyWriteClassFromType(type)).toBe(expected)
    })
  }
})
