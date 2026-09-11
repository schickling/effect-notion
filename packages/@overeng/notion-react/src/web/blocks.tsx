import { Children, isValidElement } from 'react'
import type { ReactElement, ReactNode } from 'react'

import type {
  BookmarkProps,
  BreadcrumbProps,
  BulletedListItemProps,
  CalloutProps,
  ChildPageProps,
  CodeProps,
  ColumnListProps,
  ColumnProps,
  EmbedProps,
  EquationProps,
  HeadingProps,
  LinkToPageProps,
  MediaProps,
  NumberedListItemProps,
  PageCover,
  PageIcon,
  PageProps,
  ParagraphProps,
  PassthroughProps,
  QuoteProps,
  RawProps,
  TableProps,
  TableRowProps,
  ToDoProps,
  ToggleProps,
} from '../components/props.ts'
import { useNotionUrl } from '../renderer/url-provider.ts'
import { KatexRender } from './katex.tsx'
import { ShikiRender } from './shiki.tsx'

/**
 * DOM-rendered mirrors of `../components/blocks.ts`.
 *
 * Prop shapes are shared via `../components/props.ts` so any drift between the
 * Notion-host output and the web preview surfaces as a type error.
 *
 * Styling is carried by `./styles.css` under `.notion-page`. Import it once at
 * the app/Storybook root:
 *
 *     import '@overeng/notion-react/web/styles.css'
 *
 * DOM patterns mirror `react-notion-x@v7.10.0` (`packages/react-notion-x/src/
 * block.tsx`) so the vendored CSS contract holds.
 */

/**
 * Root wrapper mirrors react-notion-x's DOM structure.
 * `.notion` applies font-family + color resets; `.notion-page` holds tokens;
 * `.notion-page-content` is the flex-column that makes inline-display blocks
 * (e.g. `.notion-h`) stack vertically.
 */
export const Page = ({ children, icon, cover }: PageProps) => {
  const headings = collectHeadings(children)
  const hasCover = cover !== undefined && cover !== null
  const hasIcon = icon !== undefined && icon !== null
  const pageClass = [
    'notion-page',
    hasCover ? 'notion-page-has-cover' : 'notion-page-no-cover',
    hasIcon ? 'notion-page-has-icon' : 'notion-page-no-icon',
    hasIcon && icon.type === 'emoji' ? 'notion-page-has-text-icon' : '',
    hasIcon && icon.type !== 'emoji' ? 'notion-page-has-image-icon' : '',
  ]
    .filter((c) => c !== '')
    .join(' ')
  return (
    <div className="notion notion-app">
      {hasCover ? renderPageCover(cover) : null}
      <div className={pageClass}>
        {hasIcon ? (
          <div className="notion-page-icon-wrapper">{renderPageIcon(icon, 'large')}</div>
        ) : null}
        <div className="notion-page-content">{groupBlocks(children, headings)}</div>
      </div>
    </div>
  )
}

type TocEntry = { readonly id: string; readonly title: string; readonly level: 1 | 2 | 3 | 4 }

const headingLevelOf = (type: unknown): 1 | 2 | 3 | 4 | undefined => {
  if (type === Heading1) return 1
  if (type === Heading2) return 2
  if (type === Heading3) return 3
  if (type === Heading4) return 4
  return undefined
}

const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

const childrenToPlainText = (node: ReactNode): string => {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(childrenToPlainText).join('')
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode }
    return childrenToPlainText(props.children)
  }
  return ''
}

const collectHeadings = (children: ReactNode): readonly TocEntry[] => {
  const out: TocEntry[] = []
  for (const child of Children.toArray(children)) {
    if (!isValidElement(child)) continue
    const level = headingLevelOf(child.type)
    if (level === undefined) continue
    const title = childrenToPlainText((child.props as { children?: ReactNode }).children).trim()
    if (title === '') continue
    out.push({ id: slugify(title), title, level })
  }
  return out
}

// rnx renders `text` blocks as <div>, not <p> — keeps margin behavior consistent
// with the rest of the block stack and matches the vendored CSS contract.
export const Paragraph = ({ children }: ParagraphProps) => (
  <div className="notion-text">{children}</div>
)

const headingClass = (level: 1 | 2 | 3 | 4) => `notion-h notion-h${level}`

const HeadingTag = ({
  level,
  children,
}: {
  readonly level: 1 | 2 | 3 | 4
  readonly children?: ReactNode
}): ReactElement => {
  const inner = <span className="notion-h-title">{children}</span>
  const id = slugify(childrenToPlainText(children).trim())
  const anchorId = id === '' ? undefined : id
  switch (level) {
    case 1:
      return (
        <h1 id={anchorId} className={headingClass(1)}>
          {inner}
        </h1>
      )
    case 2:
      return (
        <h2 id={anchorId} className={headingClass(2)}>
          {inner}
        </h2>
      )
    case 3:
      return (
        <h3 id={anchorId} className={headingClass(3)}>
          {inner}
        </h3>
      )
    case 4:
      return (
        <h4 id={anchorId} className={headingClass(4)}>
          {inner}
        </h4>
      )
  }
}

/**
 * Toggleable headings reuse the rnx `<details class="notion-toggle">` shape so
 * vendored `.notion-toggle` styling applies. The header tag goes inside
 * `<summary>`; nested children render in the body div, which rnx leaves
 * unstyled aside from the indent rule `.notion-toggle > div { margin-left }`.
 */
const heading =
  (level: 1 | 2 | 3 | 4) =>
  ({ children, toggleable, body, defaultOpen }: HeadingProps) => {
    if (toggleable === true) {
      return (
        <details className="notion-toggle" open={defaultOpen ?? false}>
          <summary>
            <HeadingTag level={level}>{children}</HeadingTag>
          </summary>
          <div>{body}</div>
        </details>
      )
    }
    return <HeadingTag level={level}>{children}</HeadingTag>
  }

export const Heading1 = heading(1)
export const Heading2 = heading(2)
export const Heading3 = heading(3)
export const Heading4 = heading(4)

/**
 * List items render as plain `<li>` and are grouped into a single `<ul>` / `<ol>`
 * by `groupBlocks` (applied in `Page` / `Column`). Standalone usage outside a
 * grouping container falls back to a self-contained one-item list.
 */
export const BulletedListItem = ({ children }: BulletedListItemProps) => (
  <ul className="notion-list notion-list-disc">
    <li>{children}</li>
  </ul>
)

export const NumberedListItem = ({ children }: NumberedListItemProps) => (
  <ol className="notion-list notion-list-numbered">
    <li>{children}</li>
  </ol>
)

/**
 * Walk children and merge consecutive `BulletedListItem` / `NumberedListItem`
 * elements into a single `<ul>` / `<ol>`, preventing rnx's numbered-list
 * triple-numbering (umbrella #83 / effect-utils#589).
 */
const groupBlocks = (children: ReactNode, headings: readonly TocEntry[] = []): ReactNode => {
  const items = Children.toArray(children)
  const out: ReactNode[] = []
  let run: { tag: 'ul' | 'ol'; className: string; items: ReactElement[] } | undefined
  const flush = () => {
    if (run === undefined) return
    const Tag = run.tag
    out.push(
      <Tag key={`group-${out.length}`} className={run.className}>
        {run.items.map((el, idx) => (
          // eslint-disable-next-line react/no-array-index-key -- list items have no stable identity
          <li key={el.key ?? `li-${idx}`}>{(el.props as { children?: ReactNode }).children}</li>
        ))}
      </Tag>,
    )
    run = undefined
  }
  for (const child of items) {
    const kind = listItemKind(child)
    if (kind !== undefined && isValidElement(child)) {
      const spec =
        kind === 'bulleted'
          ? { tag: 'ul' as const, className: 'notion-list notion-list-disc' }
          : { tag: 'ol' as const, className: 'notion-list notion-list-numbered' }
      if (run === undefined || run.tag !== spec.tag) {
        flush()
        run = { ...spec, items: [] }
      }
      run.items.push(child)
    } else if (isValidElement(child) && child.type === TableOfContents) {
      flush()
      out.push(
        <RenderedTableOfContents key={child.key ?? `toc-${out.length}`} entries={headings} />,
      )
    } else {
      flush()
      out.push(child)
    }
  }
  flush()
  return out
}

const listItemKind = (child: ReactNode): 'bulleted' | 'numbered' | undefined => {
  if (!isValidElement(child)) return undefined
  if (child.type === BulletedListItem) return 'bulleted'
  if (child.type === NumberedListItem) return 'numbered'
  return undefined
}

/**
 * SVG check icon copied from `react-notion-x/src/icons/check.tsx` (MIT,
 * Travis Fischer). Inlined here — single use, avoids per-icon files.
 */
const CheckSvg = () => (
  <svg viewBox="0 0 14 14">
    <path d="M5.5 12L14 3.5 12.5 2l-7 7-4-4.003L0 6.499z" />
  </svg>
)

/**
 * To-do checkbox markup follows rnx (`block.tsx` case 'to_do' +
 * `components/checkbox.tsx`): the strike-through lives on
 * `.notion-to-do-body` so the checkbox stays visible.
 */
export const ToDo = ({ children, checked }: ToDoProps) => {
  const isChecked = checked === true
  return (
    <div className="notion-to-do">
      <div className="notion-to-do-item">
        <span className="notion-property notion-property-checkbox">
          {isChecked ? (
            <div className="notion-property-checkbox-checked">
              <CheckSvg />
            </div>
          ) : (
            <div className="notion-property-checkbox-unchecked" />
          )}
        </span>
        <div className={`notion-to-do-body${isChecked ? ' notion-to-do-checked' : ''}`}>
          {children}
        </div>
      </div>
    </div>
  )
}

export const Toggle = ({ children, title, defaultOpen }: ToggleProps) => (
  <details className="notion-toggle" open={defaultOpen ?? false}>
    <summary>{title ?? ''}</summary>
    <div>{children}</div>
  </details>
)

export const Code = ({ children, language }: CodeProps) => (
  <ShikiRender language={language}>{children}</ShikiRender>
)

export const Quote = ({ children }: QuoteProps) => (
  <blockquote className="notion-quote">{children}</blockquote>
)

/**
 * Callout follows rnx: `<div class="notion-callout">` (not `<aside>`),
 * page-icon-inline class on the icon, `_co` color suffix to hit the
 * vendored callout-background rules (distinct from text-color rules).
 */
const renderCalloutIcon = (icon: NonNullable<CalloutProps['icon']>): ReactNode => {
  if (typeof icon === 'string') return icon
  return <img src={icon.external} alt="" className="notion-page-icon-image" />
}

/**
 * Render a Notion {@link PageIcon} envelope.
 *
 * `size: 'large'` → hero-sized icon above the page title (matches Notion's own
 * web UI, which positions the icon above the first block).
 * `size: 'inline'` → 1em-sized inline icon for {@link ChildPage} links.
 *
 * `custom_emoji` only carries an id in the request-shape; absent a workspace
 * emoji registry on the client, we render a neutral text fallback so the slot
 * is not empty.
 */
const renderPageIcon = (icon: PageIcon | null | undefined, size: 'large' | 'inline'): ReactNode => {
  if (icon === null || icon === undefined) return null
  const imgClass =
    size === 'large'
      ? 'notion-page-icon notion-page-icon-image'
      : 'notion-page-icon notion-page-icon-image notion-page-icon-inline'
  const textClass =
    size === 'large' ? 'notion-page-icon' : 'notion-page-icon notion-page-icon-inline'
  switch (icon.type) {
    case 'emoji':
      return <span className={textClass}>{icon.emoji}</span>
    case 'external':
      return <img src={icon.external.url} alt="" className={imgClass} />
    case 'custom_emoji':
      // No URL resolver on the client: surface the id-scoped fallback rather
      // than a broken image. Hosts with a custom-emoji registry can swap this.
      return (
        <span className={textClass} title={`custom_emoji:${icon.custom_emoji.id}`}>
          🙂
        </span>
      )
  }
}

/**
 * Render a Notion {@link PageCover} envelope.
 *
 * `external` → `<img>` using the public URL.
 * `file_upload` → placeholder stub. The client cannot resolve an upload id to a
 * URL without a round-trip to `files.retrieve`; hosts that need this should
 * pre-resolve before handing the prop to the web mirror.
 */
const renderPageCover = (cover: PageCover | null | undefined): ReactNode => {
  if (cover === null || cover === undefined) return null
  if (cover.type === 'external') {
    return <img className="notion-page-cover" src={cover.external.url} alt="" />
  }
  return (
    <div
      className="notion-page-cover notion-page-cover-placeholder"
      title={`file_upload:${cover.file_upload.id}`}
    />
  )
}

export const Callout = ({ children, icon, color }: CalloutProps) => (
  <div className={`notion-callout${color !== undefined ? ` notion-${color}_co` : ''}`}>
    {icon !== undefined ? (
      <div className="notion-page-icon-inline">{renderCalloutIcon(icon)}</div>
    ) : null}
    <div className="notion-callout-text">{children}</div>
  </div>
)

export const Divider = () => <hr className="notion-hr" />

const mediaUrl = (p: MediaProps): string | undefined => p.url ?? p.src

export const Image = (props: MediaProps) => {
  const url = mediaUrl(props)
  if (url === undefined) return <div className="notion-media notion-image notion-empty">image</div>
  return (
    <figure className="notion-media notion-image">
      <img src={url} alt="" />
      {props.caption !== undefined ? <figcaption>{props.caption}</figcaption> : null}
    </figure>
  )
}

export const Video = (props: MediaProps) => (
  <figure className="notion-media notion-video">
    <video src={mediaUrl(props)} controls />
    {props.caption !== undefined ? <figcaption>{props.caption}</figcaption> : null}
  </figure>
)

export const Audio = (props: MediaProps) => (
  <figure className="notion-media notion-audio">
    <audio src={mediaUrl(props)} controls />
    {props.caption !== undefined ? <figcaption>{props.caption}</figcaption> : null}
  </figure>
)

export const File = (props: MediaProps) => (
  <a className="notion-media notion-file" href={mediaUrl(props) ?? '#'}>
    file
  </a>
)

export const Pdf = (props: MediaProps) => (
  <a className="notion-media notion-pdf" href={mediaUrl(props) ?? '#'}>
    pdf
  </a>
)

/**
 * Bookmark follows rnx DOM: `<a class="notion-bookmark"><div><div
 * class="notion-bookmark-link"><div class="notion-bookmark-link-text"/>
 * </div></div></a>`. Rich previews (title, description, thumbnail) are
 * tracked by task #76 and render as placeholders until then.
 */
export const Bookmark = ({ url }: BookmarkProps) => (
  <a className="notion-bookmark" href={url} target="_blank" rel="noreferrer noopener">
    <div>
      <div className="notion-bookmark-link">
        <div className="notion-bookmark-link-text">{url}</div>
      </div>
    </div>
  </a>
)

export const Embed = ({ url }: EmbedProps) => (
  <div className="notion-embed">
    <a href={url}>{url}</a>
  </div>
)

export const Equation = ({ expression }: EquationProps) => (
  <KatexRender expression={expression} displayMode={true} />
)

// Outer scroll-wrap is our addition (rnx wraps tables one level higher in
// the block tree we don't model). Documented divergence in design-decisions.md.
export const Table = ({ children }: TableProps) => (
  <div className="notion-simple-table-wrap">
    <table className="notion-simple-table">
      <tbody>{children}</tbody>
    </table>
  </div>
)

export const TableRow = ({ cells }: TableRowProps) => (
  <tr className="notion-simple-table-row">
    {cells.map((cell, i) => (
      // eslint-disable-next-line @eslint-react/no-array-index-key
      <td key={i}>{cell}</td>
    ))}
  </tr>
)

export const ColumnList = ({ children }: ColumnListProps) => (
  <div className="notion-column-list">{children}</div>
)

export const Column = ({ children, widthRatio }: ColumnProps) => (
  <div
    className="notion-column"
    style={widthRatio === undefined ? undefined : { flexGrow: widthRatio, flexBasis: 0 }}
  >
    {groupBlocks(children)}
  </div>
)

export const LinkToPage = ({ pageId }: LinkToPageProps) => {
  const resolved = useNotionUrl({ pageId })
  const href = resolved?.href ?? `#${pageId}`
  return (
    <a className="notion-page-link" href={href} target={resolved?.target} rel={resolved?.rel}>
      ↗ page {pageId}
    </a>
  )
}

/**
 * Marker component. The real render happens in `groupBlocks`, which walks
 * sibling blocks to collect headings and replaces any `<TableOfContents/>`
 * with a `RenderedTableOfContents` populated from the surrounding context.
 */
export const TableOfContents = () => (
  <nav className="notion-table-of-contents" aria-label="table of contents" />
)

const RenderedTableOfContents = ({ entries }: { readonly entries: readonly TocEntry[] }) => {
  if (entries.length === 0) {
    return <nav className="notion-table-of-contents" aria-label="table of contents" />
  }
  const minLevel = Math.min(...entries.map((e) => e.level))
  return (
    <nav className="notion-table-of-contents" aria-label="table of contents">
      {entries.map((e) => (
        <a
          key={e.id}
          className="notion-table-of-contents-item"
          href={`#${e.id}`}
          style={{ paddingLeft: `${(e.level - minLevel) * 24 + 6}px` }}
        >
          <span className="notion-table-of-contents-item-body">{e.title}</span>
        </a>
      ))}
    </nav>
  )
}

export const ChildPage = ({ title, icon, children, blockKey }: ChildPageProps) => {
  // Ergonomic title surface accepts plain string or a PageTitleSpan[] — the
  // DOM mirror only renders a preview so we flatten span content here.
  const label =
    title === undefined
      ? 'Untitled'
      : typeof title === 'string'
        ? title
        : title.map((s) => s.text.content).join('')
  // Cover is intentionally not rendered on child-page links — matches Notion's
  // own UX, which only surfaces the icon + title on the inline link chip.
  const iconNode =
    icon === undefined || icon === null ? (
      <span className="notion-page-icon-inline">📄</span>
    ) : (
      <span className="notion-page-icon-inline">{renderPageIcon(icon, 'inline')}</span>
    )
  // `blockKey` doubles as the pageId hint we hand to the URL resolver — it is
  // the author-visible identity of the sub-page in the renderer. Without a
  // `blockKey` we have no pageId to resolve; the anchor falls back to `"#"` so
  // the visual affordance (hover/focus) is preserved but the link is inert.
  const resolved = useNotionUrl({ pageId: blockKey ?? '' })
  const hasLink = blockKey !== undefined && resolved !== undefined
  const href = hasLink ? resolved.href : '#'
  const chip = (
    <a
      className="notion-page-link"
      href={href}
      target={hasLink ? resolved.target : undefined}
      rel={hasLink ? resolved.rel : undefined}
    >
      {iconNode}
      <span>{label}</span>
    </a>
  )
  return (
    <div className="notion-child-page">
      {chip}
      {children !== undefined && children !== null && children !== false ? (
        <div className="notion-page-children">{children}</div>
      ) : null}
    </div>
  )
}

export const Raw = <TType extends string>({ type, content }: RawProps<TType>) => (
  <div className="notion-raw" data-type={type}>
    <code>{JSON.stringify(content)}</code>
  </div>
)

export const Template = ({ content }: PassthroughProps) => <Raw type="template" content={content} />
export const LinkPreview = ({ content }: PassthroughProps) => (
  <Raw type="link_preview" content={content} />
)
export const SyncedBlock = ({ content }: PassthroughProps) => (
  <Raw type="synced_block" content={content} />
)
export const ChildDatabase = ({ content }: PassthroughProps) => (
  <Raw type="child_database" content={content} />
)

const EMPTY_BREADCRUMB_CONTENT: unknown = Object.freeze({})

export const Breadcrumb = ({ content = EMPTY_BREADCRUMB_CONTENT }: BreadcrumbProps) => (
  <Raw type="breadcrumb" content={content} />
)
