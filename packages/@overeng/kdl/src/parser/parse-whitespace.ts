/**
 * Whitespace parser functions that output structured objects rather than strings.
 * Used for detailed whitespace analysis (e.g. formatting tools).
 */

import type { Document } from '../model/document.ts'
import type { Entry } from '../model/entry.ts'
import type { Node } from '../model/node.ts'
import {
  consume,
  createParserCtx,
  mkError,
  parseEscline,
  parseMultilineComment,
  parseBaseNode,
  parseNodeChildren,
  parseNodePropOrArg,
  parseSingleLineComment,
  parseNodeTerminator,
  concatenate,
  type ParserCtx,
} from './parse.ts'
import type { Token } from './token.ts'

export interface LineSpaceBom {
  type: 'bom'
  text: string
}
export interface LineSpaceNewline {
  type: 'newline'
  text: string
}
export interface LineSpaceSpace {
  type: 'space'
  text: string
}
export interface LineSpaceSingleline {
  type: 'singleline'
  text: string
}
export interface LineSpaceMultiline {
  type: 'multiline'
  text: string
}

export type LineSpace =
  | LineSpaceBom
  | LineSpaceNewline
  | LineSpaceSpace
  | LineSpaceSingleline
  | LineSpaceMultiline

export interface NodeSpaceLineEscape {
  type: 'line-escape'
  text: string
}
export interface NodeSpaceSpace {
  type: 'space'
  text: string
}
export interface NodeSpaceMultiline {
  type: 'multiline'
  text: string
}

export type NodeSpace = NodeSpaceLineEscape | NodeSpaceSpace | NodeSpaceMultiline

export interface SlashDashInDocument {
  type: 'slashdash'
  preface: NodeSpace[]
  value: Node
}

export interface SlashDashInNode {
  type: 'slashdash'
  preface: NodeSpace[]
  value: Entry | Document
}

export type WhitespaceInDocument = Array<LineSpace | SlashDashInDocument>
export type WhitespaceInNode = Array<NodeSpace | SlashDashInNode>

const repeat = <T>(ctx: ParserCtx, fn: (ctx: ParserCtx) => T | undefined): T[] | undefined => {
  const parts: T[] = []
  let part: T | undefined

  while ((part = fn(ctx))) {
    parts.push(part)
  }

  return parts.length > 0 ? parts : undefined
}

const parseLineSpace = (ctx: ParserCtx): LineSpace | undefined => {
  {
    const bom = consume(ctx, 'bom')
    if (bom) {
      return { type: 'bom', text: bom.text }
    }
  }

  {
    const newLine = consume(ctx, 'newline')
    if (newLine) {
      return { type: 'newline', text: newLine.text }
    }
  }

  {
    const inlineWhitespace = consume(ctx, 'inline-whitespace')
    if (inlineWhitespace) {
      return { type: 'space', text: inlineWhitespace.text }
    }
  }

  {
    const singleLineComment = parseSingleLineComment(ctx)
    if (singleLineComment) {
      return { type: 'singleline', text: singleLineComment }
    }
  }

  {
    const multilineComment = parseMultilineComment(ctx)
    if (multilineComment) {
      return { type: 'multiline', text: multilineComment }
    }
  }

  return undefined
}

const parseNodeSpace = (ctx: ParserCtx): NodeSpace | undefined => {
  {
    const escLine = parseEscline(ctx)
    if (escLine) {
      return { type: 'line-escape', text: escLine }
    }
  }

  {
    const inlineWhitespace = consume(ctx, 'inline-whitespace')
    if (inlineWhitespace) {
      return { type: 'space', text: inlineWhitespace.text }
    }
  }

  {
    const multilineComment = parseMultilineComment(ctx)
    if (multilineComment) {
      return { type: 'multiline', text: multilineComment }
    }
  }

  return undefined
}

export const parseWhitespaceInDocument = (ctx: ParserCtx): WhitespaceInDocument => {
  const result: WhitespaceInDocument = []

  while (true) {
    {
      const part = parseLineSpace(ctx)
      if (part) {
        result.push(part)
        continue
      }
    }

    {
      const part = consume(ctx, 'slashdash')?.text
      if (part) {
        const preface = repeat(ctx, parseNodeSpace) ?? []

        const node = parseBaseNode(ctx)
        if (!node) {
          throw mkError(ctx, 'Invalid slashdash, expected a commented node')
        }

        node.trailing = concatenate(
          node.trailing,
          repeat(ctx, parseNodeSpace)
            ?.map((v) => v.text)
            .join(''),
          parseNodeTerminator(ctx),
        )

        result.push({ type: 'slashdash', preface, value: node })
        continue
      }
    }

    break
  }

  return result
}

const parseNodeSpaceSlashDash = (ctx: ParserCtx): [SlashDashInNode, string] | undefined => {
  const slashdash = consume(ctx, 'slashdash')
  if (slashdash == null) {
    return undefined
  }

  let part: NodeSpace | undefined
  const preface: NodeSpace[] = []
  while ((part = parseNodeSpace(ctx))) {
    preface.push(part)
  }

  let value: Entry | Document | undefined
  let finalSpace = ''
  const tmp1 = parseNodePropOrArg(ctx)
  if (tmp1) {
    value = tmp1[0]
    if (tmp1[1]) {
      finalSpace = tmp1[1]
    }
  } else {
    const tmp2 = parseNodeChildren(ctx)
    if (tmp2) {
      value = tmp2
    } else {
      throw mkError(
        slashdash,
        "Couldn't find argument, property, or children that were commented by slashdash",
      )
    }
  }

  return [{ type: 'slashdash', preface, value: value! }, finalSpace]
}

export const parseWhitespaceInNode = (ctx: ParserCtx): WhitespaceInNode => {
  const result: WhitespaceInNode = []

  while (true) {
    const part = parseNodeSpace(ctx)
    if (!part) {
      break
    }

    let endsWithPlainSpace = true
    result.push(part)

    while (endsWithPlainSpace) {
      const slashDash = parseNodeSpaceSlashDash(ctx)
      if (!slashDash) {
        break
      }

      result.push(slashDash[0])
      if (slashDash[1][0]) {
        result.push(
          ...parseWhitespaceInNode(
            createParserCtx(slashDash[1][0], tokenizeForWhitespace(slashDash[1][0], ctx), {
              flags: ctx.flags,
            }),
          ),
        )
      }
      endsWithPlainSpace = !!slashDash[1][0]
    }
  }

  return result
}

/**
 * Stub for tokenizing whitespace strings within the whitespace parser.
 * This requires the tokenize function to be available. We import it lazily
 * to avoid circular dependency issues.
 */
let registeredTokenize:
  | ((text: string, options: { flags: ParserCtx['flags'] }) => Iterable<Token>)
  | undefined

export const setTokenizeForWhitespace = (
  fn: (text: string, options: { flags: ParserCtx['flags'] }) => Iterable<Token>,
): void => {
  registeredTokenize = fn
}

const tokenizeForWhitespace = (text: string, ctx: ParserCtx): Iterable<Token> => {
  if (!registeredTokenize) {
    throw new Error('tokenize function not registered for whitespace parser')
  }
  return registeredTokenize(text, { flags: ctx.flags })
}
