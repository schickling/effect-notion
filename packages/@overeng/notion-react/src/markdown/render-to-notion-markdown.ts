import type { ReactNode } from 'react'

import { notionObjectUrl } from '@overeng/notion-effect-schema'

import type { RichTextItem } from '../renderer/flatten-rich-text.ts'
import { buildCandidateTree } from '../renderer/sync-diff.ts'
import type { CandidateNode, CandidateTree } from '../renderer/sync-diff.ts'

/**
 * Why a projected construct lost information on its way to Markdown. The body
 * is always produced; diagnostics describe what a reader must not assume is
 * losslessly represented.
 */
export type MarkdownDiagnosticKind =
  | 'unsupported-block'
  | 'media-without-url'
  | 'color-dropped'
  | 'flattened'

export interface MarkdownDiagnostic {
  readonly kind: MarkdownDiagnosticKind
  readonly message: string
}

export interface NotionMarkdownResult {
  readonly body: string
  readonly diagnostics: readonly MarkdownDiagnostic[]
}

interface WalkState {
  readonly diagnostics: MarkdownDiagnostic[]
}

const indentLines = ({ text, spaces }: { text: string; spaces: number }): string =>
  text
    .split('\n')
    .map((line) => (line === '' ? line : `${' '.repeat(spaces)}${line}`))
    .join('\n')

const quoteLines = (text: string): string =>
  text
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n')

const escapeTableCell = (text: string): string =>
  text.replaceAll('|', '\\|').replaceAll('\n', '<br>')

const escapeLinkLabel = (text: string): string => text.replaceAll('[', '\\[').replaceAll(']', '\\]')

/**
 * Escape a Markdown link destination so an unbalanced parenthesis or space
 * cannot terminate it early. Parentheses are backslash-escaped (CommonMark
 * decodes them back into the URL); destinations containing whitespace are
 * angle-wrapped with inner `<`, `>`, `\` escaped.
 */
const escapeLinkDestination = (url: string): string =>
  /\s/.test(url)
    ? `<${url.replace(/([<>\\])/g, '\\$1')}>`
    : url.replaceAll('(', '\\(').replaceAll(')', '\\)')

// -----------------------------------------------------------------------------
// Inline rich text -> Markdown
// -----------------------------------------------------------------------------

/**
 * Resolve the mention discriminator. Authored `<Mention>` envelopes may omit
 * the API-level `type` key entirely (e.g. `{ user: {... } }`, as used across
 * the web stories), so fall back to key inference before giving up.
 */
const resolveMentionType = (mention: Record<string, unknown>): string | undefined => {
  if (typeof mention.type === 'string') return mention.type
  if (mention.user !== undefined) return 'user'
  if (mention.page !== undefined) return 'page'
  if (mention.database !== undefined) return 'database'
  if (mention.date !== undefined) return 'date'
  if (mention.link_preview !== undefined) return 'link_preview'
  if (mention.template_mention !== undefined) return 'template_mention'
  return undefined
}

const renderMention = (opts: {
  item: Extract<RichTextItem, { type: 'mention' }>
  state: WalkState
}): string => {
  const { item, state } = opts
  const mention = item.mention as Record<string, unknown>
  // Escape before any branch interpolates the label into Markdown syntax so
  // authored punctuation like '[Q3]' or '*ops*' survives verbatim.
  const rawPlain = typeof item.plain_text === 'string' ? item.plain_text : ''
  const plain = escapeInlineMetacharacters(rawPlain)
  // Response-shaped rich text carries the resolved link at the item level;
  // authored mentions have no href and degrade to plain text.
  const hrefValue = (item as { href?: unknown }).href
  const href = typeof hrefValue === 'string' ? hrefValue : undefined
  const type = resolveMentionType(mention)
  switch (type) {
    case 'user':
      // Authored plainText frequently already carries the '@' prefix; never
      // double it. Bare names get the dialect's '@' prefix.
      return plain.startsWith('@') || plain === '' ? plain || '@user' : `@${plain}`
    case 'page':
    case 'database': {
      const label = plain !== '' ? plain : `@${type}`
      if (typeof href === 'string') return `[${label}](${escapeLinkDestination(href)})`
      // Authored mentions carry an id but no href; resolve a deterministic
      // notion.so URL offline so the mention's identity survives.
      const id = (mention[type] as { id?: unknown } | undefined)?.id
      return typeof id === 'string' && id !== ''
        ? `[${label}](${escapeLinkDestination(notionObjectUrl(id))})`
        : label
    }
    case 'date': {
      const date = (mention.date ?? {}) as { start?: unknown; end?: unknown }
      const start = typeof date.start === 'string' ? date.start : ''
      const end = typeof date.end === 'string' ? date.end : undefined
      return end !== undefined ? `${start} \u2192 ${end}` : start
    }
    case 'link_preview': {
      const url = (mention.link_preview as { url?: unknown } | undefined)?.url
      if (typeof url !== 'string') return plain
      const label = plain !== '' ? plain : url || '@link_preview'
      return `[${label}](${escapeLinkDestination(url)})`
    }
    case 'template_mention': {
      const tm = (mention.template_mention ?? {}) as Record<string, unknown>
      if (tm.template_mention_date !== undefined) return `@${String(tm.template_mention_date)}`
      return '@me'
    }
    default:
      state.diagnostics.push({
        kind: 'unsupported-block',
        message: `mention of type ${String(mention.type)} rendered as plain text`,
      })
      return plain
  }
}

/**
 * Escape characters that would otherwise be interpreted as Markdown inline
 * syntax when they appear in authored plain text. Applied to unannotated
 * text runs before the serializer adds its own wrappers, so authored
 * literals like `# not a heading` or `*not italic*` survive verbatim.
 * `$` is deliberately not escaped: stock CommonMark/GFM render it literally,
 * and escaping every shell-style `$VAR` would destroy review readability.
 */
const escapeInlineMetacharacters = (text: string): string =>
  text
    .replaceAll(/([\\`*_[\]<>~])/g, '\\$1')
    .replace(/!(?=\[)/g, '\\!')
    // Neutralize entity-looking sequences so '&copy;' stays literal; a bare
    // '&' that cannot begin an entity renders fine and stays untouched.
    .replace(/&(?=[a-zA-Z]+;|#\d+;|#[xX][0-9a-fA-F]+;)/g, '\\&')

/**
 * Escape line-initial block-structure markers (headings, quotes, list items,
 * thematic breaks) that would restructure the body if left verbatim.
 */
const escapeBlockStarts = (text: string): string =>
  text
    .split('\n')
    .map((line) => {
      const match = line.match(
        /^(\s*)(#{1,6}(?:\s|$)|>(?:\s|$)|[-*+](?:\s|$)|\d{1,9}[.)](?:\s|$)|[-*_]{3,}\s*$)/,
      )
      if (match === null) return line
      return `${match[1]}\\${match[2]}${line.slice(match[0].length)}`
    })
    .join('\n')

/** Apply annotation wrappers + color diagnostics uniformly to any inner string. */
const wrapWithAnnotations = (opts: {
  core: string
  /** Unescaped source text; used verbatim inside code spans (backslashes are literal there). */
  rawCore?: string
  annotations: RichTextItem['annotations']
  state: WalkState
}): string => {
  const { core, rawCore, annotations, state } = opts
  if (annotations.color !== 'default') {
    state.diagnostics.push({
      kind: 'color-dropped',
      message: `text color ${annotations.color} dropped`,
    })
  }
  let wrapped: string
  if (annotations.code === true) {
    // CommonMark renders backslashes literally inside code spans and closes
    // the span at an equal-length backtick run, so use the raw source and a
    // delimiter strictly longer than any embedded run. Content that starts or
    // ends with a backtick needs padding spaces to stay inside the span.
    const raw = rawCore ?? core
    const longestRun = Math.max(0, ...[...raw.matchAll(/`+/g)].map((m) => m[0].length))
    const delim = '`'.repeat(Math.max(1, longestRun + 1))
    const padded = raw.startsWith('`') || raw.endsWith('`') ? ` ${raw} ` : raw
    wrapped = `${delim}${padded}${delim}`
  } else {
    wrapped = core
  }
  if (annotations.bold === true) wrapped = `**${wrapped}**`
  if (annotations.italic === true) wrapped = `*${wrapped}*`
  if (annotations.strikethrough === true) wrapped = `~~${wrapped}~~`
  if (annotations.underline === true) wrapped = `<u>${wrapped}</u>`
  return wrapped
}

const renderInlineItem = (opts: { item: RichTextItem; state: WalkState }): string => {
  const { item, state } = opts
  // Mentions and equations carry their annotation frame on the item itself
  // (flattenRichText bakes it in), so route through the same wrapper as text.
  if (item.type === 'equation') {
    return wrapWithAnnotations({
      core: `$${item.equation.expression}$`,
      annotations: item.annotations,
      state,
    })
  }
  if (item.type === 'mention') {
    return wrapWithAnnotations({
      core: renderMention({ item, state }),
      annotations: item.annotations,
      state,
    })
  }

  const [, leading = '', core = '', trailing = ''] =
    item.text.content.match(/^(\s*)([\s\S]*?)(\s*)$/) ?? []
  if (core === '') return item.text.content

  const wrapped = wrapWithAnnotations({
    core: escapeBlockStarts(escapeInlineMetacharacters(core)),
    rawCore: core,
    annotations: item.annotations,
    state,
  })

  const withAnnotations = `${leading}${wrapped}${trailing}`
  return item.text.link === null
    ? withAnnotations
    : `[${withAnnotations}](${escapeLinkDestination(item.text.link.url)})`
}

const renderRichText = (opts: { items: readonly RichTextItem[]; state: WalkState }): string =>
  opts.items.map((item) => renderInlineItem({ item, state: opts.state })).join('')

/** Plain-text concatenation for contexts where Markdown annotations must not apply (code fences). */
/** Does this item carry formatting a code fence cannot represent? */
const hasCodeUnrepresentableFormatting = (item: RichTextItem): boolean => {
  if (item.type !== 'text') return true
  if (item.text.link !== null) return true
  const ann = item.annotations
  return (
    ann.bold === true ||
    ann.italic === true ||
    ann.strikethrough === true ||
    ann.underline === true ||
    ann.color !== 'default'
  )
}

const renderPlainText = (items: readonly RichTextItem[]): string =>
  items
    .map((item) => {
      if (item.type === 'text') return item.text.content
      if (item.type === 'equation') return item.equation.expression
      return typeof item.plain_text === 'string' ? item.plain_text : ''
    })
    .join('')

// -----------------------------------------------------------------------------
// Block tree -> Markdown
// -----------------------------------------------------------------------------

const renderUrlBlock = (opts: { node: CandidateNode; state: WalkState }): string => {
  const { node, state } = opts
  const captionItems = Array.isArray(node.props.caption)
    ? (node.props.caption as RichTextItem[])
    : []
  // Markdown links cannot nest, so caption links flatten to their inner text
  // before the caption becomes a label of the media link.
  let captionHadLink = false
  const caption = captionItems
    .map((item) => {
      if (item.type === 'text' && item.text.link !== null) {
        captionHadLink = true
        return renderInlineItem({ item: { ...item, text: { ...item.text, link: null } }, state })
      }
      return renderInlineItem({ item, state })
    })
    .join('')
  if (captionHadLink) {
    state.diagnostics.push({
      kind: 'flattened',
      message: `${node.type} caption link flattened to plain text`,
    })
  }
  const url = typeof node.props.url === 'string' ? node.props.url : undefined

  if (url === undefined && node.props.file_upload !== undefined) {
    const id = (node.props.file_upload as { id?: unknown }).id
    state.diagnostics.push({
      kind: 'media-without-url',
      message: `${node.type} references file_upload ${String(id)} which has no resolvable URL offline`,
    })
    return `<!-- ${node.type}: unresolvable upload ${String(id)} -->`
  }
  if (url === undefined) {
    const external = (node.props.external as { url?: unknown } | undefined)?.url
    if (typeof external !== 'string') {
      state.diagnostics.push({
        kind: 'media-without-url',
        message: `${node.type} has no source URL`,
      })
      return `<!-- ${node.type}: missing source -->`
    }
    return renderResolvedUrl({ type: node.type, url: external, caption })
  }
  return renderResolvedUrl({ type: node.type, url, caption })
}

const renderResolvedUrl = (opts: { type: string; url: string; caption: string }): string => {
  const { type, url, caption } = opts
  // Caption text already flowed through renderRichText, which escapes
  // Markdown metacharacters; escaping again would double the backslashes.
  const label = caption !== '' ? caption : null
  switch (type) {
    case 'image':
      return `![${label ?? ''}](${escapeLinkDestination(url)})`
    case 'video':
      return `[${label ?? 'Video'}](${escapeLinkDestination(url)})`
    case 'audio':
      return `[${label ?? 'Audio'}](${escapeLinkDestination(url)})`
    case 'pdf':
      return `[${label ?? 'PDF'}](${escapeLinkDestination(url)})`
    case 'file':
      return `[${label ?? 'File'}](${escapeLinkDestination(url)})`
    case 'bookmark':
      return `[${label ?? escapeLinkLabel(url)}](${escapeLinkDestination(url)})`
    case 'embed':
      return `[${label ?? 'Embed'}](${escapeLinkDestination(url)})`
    default:
      return `[${label ?? type}](${escapeLinkDestination(url)})`
  }
}

const renderTable = (opts: { node: CandidateNode; state: WalkState }): string => {
  const rows = opts.node.children.filter((child) => child.type === 'table_row')
  if (rows.length === 0) return ''
  // GFM has no first-column header flag; the authored distinction is lost.
  if (opts.node.props.has_row_header === true) {
    opts.state.diagnostics.push({
      kind: 'flattened',
      message: 'table row-header semantics dropped (no GFM spelling)',
    })
  }
  const cellsOf = (row: CandidateNode): string[] => {
    const cells = Array.isArray(row.props.cells) ? (row.props.cells as RichTextItem[][]) : []
    return cells.map((cell) => escapeTableCell(renderRichText({ items: cell, state: opts.state })))
  }
  // Render each row exactly once — cell rendering emits diagnostics, and
  // re-rendering for width/header derivation would duplicate them.
  const renderedRows = rows.map(cellsOf)
  const columnCount = Math.max(...renderedRows.map((cells) => cells.length))
  const pad = (cells: string[]): string[] => {
    const padded = [...cells]
    while (padded.length < columnCount) padded.push('')
    return padded
  }
  const hasColumnHeader = opts.node.props.has_column_header !== false
  const header = pad(
    hasColumnHeader ? renderedRows[0]! : Array.from({ length: columnCount }, () => ''),
  )
  const bodyRows = (hasColumnHeader ? renderedRows.slice(1) : renderedRows).map(pad)
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...bodyRows.map((row) => `| ${row.join(' | ')} |`),
  ]
  return lines.join('\n')
}

const unsupportedPlaceholder = (opts: {
  node: CandidateNode
  reason: string
  state: WalkState
}): string => {
  opts.state.diagnostics.push({
    kind: 'unsupported-block',
    message: `${opts.node.type} block emitted as placeholder (${opts.reason})`,
  })
  return `<!-- unsupported block: ${opts.node.type} -->`
}

/**
 * Render one candidate node to an UNINDENTED Markdown fragment. Parents apply
 * indentation when embedding fragments under list markers or quotes.
 */
const renderNode = (opts: {
  node: CandidateNode
  ordinal: number | undefined
  state: WalkState
}): string => {
  const { node, ordinal, state } = opts
  const props = node.props
  const children = (nodes: readonly CandidateNode[], spaces: number): string => {
    const parts = renderNodes({ nodes, state })
    return parts.length === 0 ? '' : indentLines({ text: parts.join('\n\n'), spaces })
  }

  const richText = Array.isArray(props.rich_text) ? (props.rich_text as RichTextItem[]) : []

  switch (node.type) {
    case 'paragraph': {
      const own = renderRichText({ items: richText, state })
      if (node.children.length === 0) {
        // Empty paragraphs are deliberate blank blocks in Notion; Markdown
        // has no content spelling for one, so report the drop instead of
        // silently erasing it.
        if (own === '') {
          state.diagnostics.push({
            kind: 'flattened',
            message: 'empty paragraph dropped',
          })
        }
        return own
      }
      // Notion paragraphs can carry nested blocks; Markdown has no spelling
      // for "block nested under a paragraph", so children follow as sibling
      // blocks and the hierarchy loss is diagnosed (R33).
      state.diagnostics.push({
        kind: 'flattened',
        message: 'paragraph child blocks rendered as sibling blocks',
      })
      const inner = renderNodes({ nodes: node.children, state })
      return inner.length === 0 ? own : [own, ...inner].filter((s) => s !== '').join('\n\n')
    }
    case 'heading_1':
    case 'heading_2':
    case 'heading_3':
    case 'heading_4': {
      const level = Number(node.type.slice(-1))
      const heading = `${'#'.repeat(level)} ${renderRichText({ items: richText, state })}`
      // Emit before the toggleable early-return so colored toggleable
      // headings still report the dropped color. Explicit 'default' has
      // nothing to lose and must not be diagnosed.
      if (props.color !== undefined && props.color !== 'default') {
        state.diagnostics.push({
          kind: 'color-dropped',
          message: `heading color ${String(props.color)} dropped`,
        })
      }
      // The toggle affordance itself is lost even when the heading currently
      // has no children, so diagnose on is_toggleable alone.
      if (props.is_toggleable === true) {
        state.diagnostics.push({
          kind: 'flattened',
          message: `toggleable heading rendered as flat heading + following content`,
        })
        if (node.children.length > 0) {
          return [heading, renderNodes({ nodes: node.children, state }).join('\n\n')].join('\n\n')
        }
      }
      return heading
    }
    case 'bulleted_list_item': {
      const marker = '- '
      const nested = children(node.children, marker.length)
      // Blank line before nested content: without it CommonMark treats the
      // first child as lazy continuation of the item's paragraph.
      return nested === ''
        ? `${marker}${renderRichText({ items: richText, state })}`
        : `${marker}${renderRichText({ items: richText, state })}\n\n${nested}`
    }
    case 'numbered_list_item': {
      const n = ordinal ?? 1
      const marker = `${n}. `
      const nested = children(node.children, marker.length)
      return nested === ''
        ? `${marker}${renderRichText({ items: richText, state })}`
        : `${marker}${renderRichText({ items: richText, state })}\n\n${nested}`
    }
    case 'to_do': {
      const checkbox = props.checked === true ? '[x]' : '[ ]'
      const marker = `- ${checkbox} `
      const nested = children(node.children, marker.length)
      return nested === ''
        ? `${marker}${renderRichText({ items: richText, state })}`
        : `${marker}${renderRichText({ items: richText, state })}\n\n${nested}`
    }
    case 'toggle': {
      const title = renderRichText({ items: richText, state })
      const inner = renderNodes({ nodes: node.children, state })
      return inner.length === 0
        ? `<details>\n<summary>${title}</summary>\n</details>`
        : `<details>\n<summary>${title}</summary>\n\n${inner.join('\n\n')}\n\n</details>`
    }
    case 'quote':
    case 'callout': {
      let prefix = ''
      if (node.type === 'callout') {
        const icon = props.icon as { type?: unknown; emoji?: unknown } | null | undefined
        if (icon !== null && typeof icon === 'object' && icon.type === 'external') {
          // An external icon URL has no inline spelling in a blockquote;
          // dropping it silently would fabricate content (the default icon).
          state.diagnostics.push({ kind: 'flattened', message: 'callout external icon dropped' })
          prefix = ''
        } else {
          const emoji = icon?.emoji
          // Absent icons stay absent — the candidate carries no icon and
          // inventing a default would fabricate authored content.
          prefix = typeof emoji === 'string' ? `${emoji} ` : ''
        }
        if (props.color !== undefined && props.color !== 'default') {
          state.diagnostics.push({
            kind: 'color-dropped',
            message: `callout color ${String(props.color)} dropped`,
          })
        }
      }
      const own = quoteLines(`${prefix}${renderRichText({ items: richText, state })}`)
      const nested = children(node.children, 0)
      // '>' separator line splits quoted child blocks into distinct
      // paragraphs instead of one soft-wrapped quote paragraph.
      return nested === '' ? own : `${own}\n>\n${quoteLines(nested)}`
    }
    case 'code': {
      const code = renderPlainText(richText)
      // Fenced Markdown cannot preserve inline formatting; report its loss.
      if (richText.some(hasCodeUnrepresentableFormatting)) {
        state.diagnostics.push({
          kind: 'flattened',
          message: 'inline formatting dropped inside code block',
        })
      }
      // CommonMark closes a fence at a backtick run equal to the fence
      // length, so the fence must be strictly longer than any run inside.
      const longestRun = Math.max(0, ...[...code.matchAll(/`+/g)].map((m) => m[0].length))
      const fence = '`'.repeat(Math.max(3, longestRun + 1))
      // Newline-terminated content already separates from the closing fence;
      // appending another would add an empty line to the literal code.
      const body = code.endsWith('\n') ? code : `${code}\n`
      return `${fence}${typeof props.language === 'string' ? props.language : ''}\n${body}${fence}`
    }
    case 'divider':
      return '---'
    case 'equation':
      return `$$\n${typeof props.expression === 'string' ? props.expression : ''}\n$$`
    case 'table_of_contents':
      return '[TOC]'
    case 'image':
    case 'video':
    case 'audio':
    case 'file':
    case 'pdf':
    case 'bookmark':
    case 'embed':
      return renderUrlBlock({ node, state })
    case 'link_to_page':
      return `[Link to page](${escapeLinkDestination(notionObjectUrl(typeof props.page_id === 'string' ? props.page_id : ''))})`
    case 'table':
      return renderTable({ node, state })
    case 'column_list':
      state.diagnostics.push({
        kind: 'flattened',
        message: 'column layout flattened to sequential blocks',
      })
      return renderNodes({ nodes: node.children, state }).join('\n\n')
    case 'column':
      return renderNodes({ nodes: node.children, state }).join('\n\n')
    default: {
      if (node.nodeKind === 'page') {
        // Prefer the normalized title spans (covers both string and
        // span-array authored forms) over the raw prop.
        const spans = Array.isArray(node.title) ? node.title : undefined
        const spanText = spans
          ?.map((span) => {
            if (typeof span.plain_text === 'string') return span.plain_text
            const content = (span.text as { content?: unknown } | undefined)?.content
            return typeof content === 'string' ? content : ''
          })
          .join('')
        const title =
          spanText !== undefined && spanText !== ''
            ? spanText
            : typeof props.title === 'string'
              ? props.title
              : 'Untitled'
        state.diagnostics.push({
          kind: 'flattened',
          message: `child page boundary flattened: "${title}" rendered as bold label + inline content`,
        })
        const inner = renderNodes({ nodes: node.children, state })
        const label = `**${escapeInlineMetacharacters(title)}** (child page)`
        return inner.length === 0 ? label : `${label}\n\n${inner.join('\n\n')}`
      }
      if (richText.length > 0 || props.template !== undefined) {
        const own = renderRichText({ items: richText, state })
        const inner = renderNodes({ nodes: node.children, state })
        state.diagnostics.push({
          kind: 'unsupported-block',
          message: `${node.type} block rendered generically from rich_text`,
        })
        return inner.length === 0
          ? own
          : [own, inner.join('\n\n')].filter((s) => s !== '').join('\n\n')
      }
      return unsupportedPlaceholder({ node, reason: 'no Markdown spelling', state })
    }
  }
}

const renderNodes = (opts: { nodes: readonly CandidateNode[]; state: WalkState }): string[] => {
  const out: string[] = []
  let previousWasNumbered = false
  let counter = 0
  for (const node of opts.nodes) {
    let ordinal: number | undefined
    if (node.type === 'numbered_list_item') {
      counter = previousWasNumbered ? counter + 1 : 1
      ordinal = counter
      previousWasNumbered = true
    } else {
      previousWasNumbered = false
    }
    const md = renderNode({ node, ordinal, state: opts.state })
    if (md !== '') out.push(md)
  }
  return out
}

/**
 * Project authored JSX through the same normalized render/tree pass that feeds
 * Notion projection, then serialize the resulting candidate tree to a readable
 * Notion-enhanced-Markdown body. Pure, synchronous, and network-free.
 *
 * Read-only by contract: nothing here mutates Notion and no cache is read or
 * written. Constructs that cannot survive the projection emit diagnostics
 * instead of disappearing silently.
 *
 * @experimental Experimental surface (#1097): spellings and the diagnostics
 * contract may change until a real consumer (Blocky preview/export) has proven
 * the output and the fidelity matrix is complete. Do not treat the body as a
 * canonical Notion round-trip representation.
 */
export const renderToNotionMarkdown = (element: ReactNode): NotionMarkdownResult => {
  const tree: CandidateTree = buildCandidateTree(element, '__markdown__')
  const state: WalkState = { diagnostics: [] }
  // Root <Page> metadata belongs to the .nmd envelope / page properties, not
  // the body; report its omission so the result stays loss-accounted (R33).
  // buildCandidateTree records an empty rootPage for a bare <Page> wrapper,
  // so only diagnose when an actual metadata field was authored.
  const hasRootMetadata =
    tree.rootPage !== undefined &&
    (tree.rootPage.title !== undefined ||
      tree.rootPage.icon !== undefined ||
      tree.rootPage.cover !== undefined)
  if (hasRootMetadata) {
    state.diagnostics.push({
      kind: 'flattened',
      message:
        'root page metadata (title/icon/cover) omitted from body; carry it in the .nmd envelope or page properties',
    })
  }
  const parts = renderNodes({ nodes: tree.children, state })
  return { body: parts.join('\n\n'), diagnostics: state.diagnostics }
}
