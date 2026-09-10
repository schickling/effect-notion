import type { ParserFlags } from '../flags.ts'
import { storeLocation as _storeLocation } from '../locations.ts'
import { Document } from '../model/document.ts'
import { Entry } from '../model/entry.ts'
import { Identifier } from '../model/identifier.ts'
import { Node } from '../model/node.ts'
import { Tag } from '../model/tag.ts'
import { Value } from '../model/value.ts'
import type { NumberFormat } from '../model/value.ts'
import {
  postProcessMultilineRawStringValue,
  postProcessMultilineStringValue,
  postProcessRawStringValue,
  postProcessStringValue,
} from '../string-utils.ts'
import { InvalidKdlError } from './internal-error.ts'
import type { Token, TokenType } from './token.ts'

export interface ParserCtx {
  text: string
  current: IteratorResult<Token, void>
  tokens: Iterator<Token, void>
  lastToken: Token
  storeLocations: boolean
  errors: InvalidKdlError[]
  flags: ParserFlags
}

export const pop = (ctx: ParserCtx): void => {
  if (!ctx.current.done) {
    ctx.lastToken = ctx.current.value
  }

  ctx.current = ctx.tokens.next()

  const errors = !ctx.current.done && ctx.current.value.errors
  if (errors) {
    ctx.errors.push(...errors)
  }
}

export const consume = (ctx: ParserCtx, tokenType: TokenType): Token | undefined => {
  if (!ctx.current.done && ctx.current.value.type === tokenType) {
    const token = ctx.current.value
    pop(ctx)
    return token
  }
  return undefined
}

export const mkError = (ctx: ParserCtx | Token, message: string): InvalidKdlError => {
  const token =
    'current' in ctx
      ? ((ctx as ParserCtx).current.value ?? (ctx as ParserCtx).lastToken)
      : (ctx as Token)
  return new InvalidKdlError(message, { token })
}

export const storeLocation = (
  ctx: ParserCtx,
  value: Value | Identifier | Tag | Entry | Node | Document,
  start: Token,
  end: Token = start,
): void => {
  if (ctx.storeLocations) {
    _storeLocation(value, start, end)
  }
}

export const concatenate = (one = '', two = '', three = ''): string | undefined =>
  one + two + three || undefined

export const createParserCtx = (
  text: string,
  tokens: Iterable<Token>,
  options: { storeLocations?: boolean; flags: ParserFlags },
): ParserCtx => {
  const iterator = tokens[Symbol.iterator]()

  return {
    text,
    tokens: iterator,
    current: iterator.next(),
    storeLocations: options.storeLocations ?? false,
    lastToken: {
      type: 'eof' as TokenType,
      text: '',
      start: { offset: 0, line: 1, column: 1 },
      end: { offset: 0, line: 1, column: 1 },
      errors: undefined,
    },
    errors: [],
    flags: options.flags,
  }
}

export const finalize = (ctx: ParserCtx, fatalError?: unknown): void => {
  if (!fatalError && !ctx.current.done && ctx.current.value.type !== 'eof') {
    fatalError = mkError(
      ctx,
      `Unexpected token ${JSON.stringify(ctx.current.value.text)}, did you forget to quote an identifier?`,
    )
  }

  const errors = ctx.errors ?? []

  if (fatalError != null) {
    if (fatalError instanceof InvalidKdlError) {
      if (fatalError.errors) {
        errors.push(...fatalError.errors)
      } else {
        errors.push(fatalError)
      }
    } else {
      errors.push(
        new InvalidKdlError(
          `An unexpected error occurred, ${String(fatalError)}, this is likely a bug in the KDL parser`,
        ),
      )
    }
  }

  if (errors.length) {
    if (errors.length === 1) {
      throw errors[0]
    } else {
      throw new InvalidKdlError('Encountered multiple errors', { errors })
    }
  }
}

const getKeywordValue = (keyword: string): boolean | null | number | undefined => {
  switch (keyword) {
    case '#null':
      return null
    case '#true':
      return true
    case '#false':
      return false
    case '#inf':
      return Infinity
    case '#-inf':
      return -Infinity
    case '#nan':
      return NaN
    default:
      return undefined
  }
}

const isKeywordlikeIdent = (ident: string): boolean =>
  ident === 'inf' ||
  ident === '-inf' ||
  ident === 'nan' ||
  ident === 'true' ||
  ident === 'false' ||
  ident === 'null'

const detectNumberFormat = (text: string): NumberFormat => {
  const hasDecimal = text.includes('.')
  const hasExponent = /[eE]/.test(text)
  if (hasDecimal && hasExponent) return 'float-exponent'
  if (hasDecimal) return 'float'
  if (hasExponent) return 'int-exponent'
  return 'integer'
}

const parseNonStringValue = (ctx: ParserCtx): Value | undefined => {
  const { value: token } = ctx.current
  let value: number | boolean | null | undefined
  let representation: string | undefined
  let suffixTag: string | undefined
  let suffixTagRepresentation: string | undefined
  let checkSeparatedSuffix = false
  let numberFormat: NumberFormat | undefined

  switch (token?.type) {
    case 'number-with-suffix' as TokenType:
      {
        if (!ctx.flags.experimentalSuffixedNumbers) {
          throw new InvalidKdlError(
            'Unreachable code: got a suffixed number from the tokenizer but the suffixed number flag is not set',
            { token },
          )
        }

        const startOfSuffix = token.text.search(/[^0-9._]/)

        representation = token.text.slice(0, startOfSuffix)
        value = Number.parseFloat(representation.replaceAll('_', ''))
        suffixTagRepresentation = suffixTag = token.text.slice(startOfSuffix)
        numberFormat = detectNumberFormat(representation)

        if (isKeywordlikeIdent(suffixTag)) {
          ctx.errors.push(
            mkError(
              ctx,
              `Invalid suffix ${suffixTag}, values that look like keywords cannot be used as suffix`,
            ),
          )
        }
      }
      break
    case 'number-binary':
      checkSeparatedSuffix = true
      value = Number.parseInt(token.text.slice(2).replaceAll('_', ''), 2)
      break
    case 'number-octal':
      checkSeparatedSuffix = true
      value = Number.parseInt(token.text.slice(2).replaceAll('_', ''), 8)
      break
    case 'number-decimal':
      checkSeparatedSuffix = true
      value = Number.parseFloat(token.text.replaceAll('_', ''))
      numberFormat = detectNumberFormat(token.text)
      break
    case 'number-hexadecimal':
      checkSeparatedSuffix = true
      value = Number.parseInt(token.text.slice(2).replaceAll('_', ''), 16)
      break
    case 'keyword-or-hashed-ident':
      value = getKeywordValue(token.text) as typeof value

      if (value === undefined) {
        value = null

        if (getKeywordValue(token.text.toLowerCase()) !== undefined) {
          ctx.errors.push(
            mkError(
              ctx,
              `Invalid keyword ${token.text}, keywords are case sensitive, write ${token.text.toLowerCase()} instead`,
            ),
          )
        } else {
          switch (token.text.toLowerCase()) {
            case '#nul':
            case '#nill':
              ctx.errors.push(mkError(ctx, `Invalid keyword ${token.text}, did you mean #null?`))
              break
            case '#fals':
            case '#fasle':
              ctx.errors.push(mkError(ctx, `Invalid keyword ${token.text}, did you mean #false?`))
              break
            case '#ture':
            case '#treu':
              ctx.errors.push(mkError(ctx, `Invalid keyword ${token.text}, did you mean #true?`))
              break
            case '#ifn':
              ctx.errors.push(mkError(ctx, `Invalid keyword ${token.text}, did you mean #inf?`))
              break
            case '#-ifn':
              ctx.errors.push(mkError(ctx, `Invalid keyword ${token.text}, did you mean #-inf?`))
              break
            default:
              ctx.errors.push(
                mkError(
                  ctx,
                  `Invalid keyword ${token.text}, surround it with quotes to use a string`,
                ),
              )
          }
        }
      }
      break
    default:
      return undefined
  }

  pop(ctx)

  const tagToken = ctx.flags.experimentalSuffixedNumbers && consume(ctx, 'keyword-or-hashed-ident')
  if (tagToken) {
    if (checkSeparatedSuffix) {
      suffixTagRepresentation = tagToken.text
      if (getKeywordValue(suffixTagRepresentation) !== undefined) {
        ctx.errors.push(
          mkError(
            tagToken,
            `Invalid number suffix ${suffixTagRepresentation}, did you forget a space between the number and the keyword?`,
          ),
        )
      }
      suffixTag = suffixTagRepresentation.slice(1)
    } else if (suffixTag) {
      ctx.errors.push(
        mkError(tagToken, 'Unexpected hashed suffix, a number can only have one suffix'),
      )
    } else if (typeof value === 'number') {
      ctx.errors.push(
        mkError(tagToken, 'Unexpected hashed suffix, you cannot place suffixes on number keywords'),
      )
    } else {
      ctx.errors.push(
        mkError(tagToken, 'Unexpected hashed suffix, you can only place suffixes on numbers'),
      )
    }
  }

  const result = new Value(value!)
  result.representation = representation ?? token!.text
  result.numberFormat = numberFormat
  storeLocation(ctx, result, token!)

  if (suffixTag) {
    const resultTag = new Tag(suffixTag)
    resultTag.representation = suffixTagRepresentation
    resultTag.suffix = true
    storeLocation(ctx, resultTag, ctx.lastToken)

    result.tag = resultTag
  }

  return result
}

const parseString = (ctx: ParserCtx): [string, string, Token] | undefined => {
  if (ctx.current.done) {
    return undefined
  }

  const { value: token } = ctx.current
  let result: [string, string, Token] | undefined
  switch (token.type) {
    case 'identifier-string':
      pop(ctx)
      if (isKeywordlikeIdent(token.text)) {
        ctx.errors.push(
          mkError(
            ctx,
            `Invalid keyword "${token.text}", add a leading # to use the keyword or surround with quotes to make it a string`,
          ),
        )
      }
      result = [token.text, token.text, token]
      break
    case 'quoted-string':
      pop(ctx)
      result = [
        postProcessStringValue(ctx.errors, token.text.slice(1, -1), token),
        token.text,
        token,
      ]
      break
    case 'multiline-quoted-string':
      pop(ctx)
      result = [
        postProcessMultilineStringValue(ctx.errors, token.text.slice(3, -3), token),
        token.text,
        token,
      ]
      break
    case 'raw-string': {
      pop(ctx)
      const raw = token.text
      const quoteIndex = raw.indexOf('"')
      result = [
        postProcessRawStringValue(ctx.errors, raw.slice(quoteIndex + 1, -(quoteIndex + 1)), token),
        raw,
        token,
      ]
      break
    }
    case 'multiline-raw-string': {
      pop(ctx)
      const raw = token.text
      const quoteIndex = raw.indexOf('"')
      result = [
        postProcessMultilineRawStringValue(
          ctx.errors,
          raw.slice(quoteIndex + 3, -(quoteIndex + 3)),
          token,
        ),
        raw,
        token,
      ]
      break
    }
    default:
      return undefined
  }

  if (consume(ctx, 'keyword-or-hashed-ident')) {
    ctx.errors.push(
      mkError(
        ctx.lastToken,
        getKeywordValue(ctx.lastToken.text) === undefined
          ? 'Unexpected hashed suffix on a string, you can only place suffixes on numbers'
          : 'Unexpected keyword, did you forget to add whitespace?',
      ),
    )
  }

  return result
}

export const parseIdentifier = (ctx: ParserCtx): Identifier | undefined => {
  const name = parseString(ctx)
  if (!name) {
    return undefined
  }

  const result = new Identifier(name[0])
  result.representation = name[1]
  storeLocation(ctx, result, name[2], ctx.lastToken)
  return result
}

export const parseValue = (ctx: ParserCtx): Value | undefined => {
  const value = parseNonStringValue(ctx)
  if (value) {
    return value
  }

  const string = parseString(ctx)
  if (!string) {
    return undefined
  }

  const result = new Value(string[0])
  result.representation = string[1]
  storeLocation(ctx, result, string[2], ctx.lastToken)
  return result
}

export const parseSingleLineComment = (ctx: ParserCtx): string | undefined => {
  const comment = consume(ctx, 'comment-single')
  if (!comment) {
    return undefined
  }

  const { value: newlineToken } = ctx.current
  pop(ctx)

  return comment.text + (newlineToken?.text ?? '')
}

export const parseMultilineComment = (ctx: ParserCtx): string | undefined =>
  consume(ctx, 'comment-multi')?.text

const parseWs = (ctx: ParserCtx): Token | string | undefined =>
  consume(ctx, 'inline-whitespace') ?? parseMultilineComment(ctx)

export const parseEscline = (ctx: ParserCtx): string | undefined => {
  const start = consume(ctx, 'escline')
  if (!start) {
    return undefined
  }

  while (parseWs(ctx)) {}

  if (!parseSingleLineComment(ctx) && !consume(ctx, 'newline') && !consume(ctx, 'eof')) {
    ctx.errors.push(
      mkError(
        ctx,
        `Expected newline or single-line comment after backslash but got ${ctx.current.value?.text ?? 'EOF'}`,
      ),
    )
  }

  return ctx.text.slice(start.start.offset, ctx.lastToken.end.offset)
}

const parseLineSpace = (ctx: ParserCtx): string | undefined => {
  const start = ctx.lastToken.end

  while (
    consume(ctx, 'newline')?.text ??
    parseSingleLineComment(ctx) ??
    parseWs(ctx) ??
    parseEscline(ctx)
  ) {}

  if (ctx.lastToken.end === start) {
    return undefined
  }

  return ctx.text.slice(start.offset, ctx.lastToken.end.offset)
}

export const parseNodeSpace = (ctx: ParserCtx): string | undefined => {
  const start = ctx.lastToken.end

  while (parseWs(ctx) ?? parseEscline(ctx)) {}

  if (ctx.lastToken.end === start) {
    return undefined
  }

  return ctx.text.slice(start.offset, ctx.lastToken.end.offset)
}

export const parseTag = (ctx: ParserCtx): Tag | undefined => {
  const start = consume(ctx, 'open-paren')
  if (!start) {
    return undefined
  }

  const leading = parseNodeSpace(ctx)

  let name: [string, string, ...unknown[]] | undefined = parseString(ctx)

  if (!name && ctx.current.value) {
    const location = ctx.current.value
    if (parseLineSpace(ctx)) {
      ctx.errors.push(mkError(location, 'This type of whitespace is not allowed inside a tag'))
    }
    name = parseString(ctx)
  }

  if (!name) {
    if (parseNonStringValue(ctx)) {
      ctx.errors.push(mkError(ctx, 'Invalid tag, did you forget to quote a string?'))
      name = ['error', 'error']
    }
  }

  if (!name) {
    throw mkError(ctx, 'Invalid tag, did you forget to quote a string?')
  }

  const trailing = parseNodeSpace(ctx)

  let end = consume(ctx, 'close-paren')

  if (!end && ctx.current.value) {
    const location = ctx.current.value
    if (parseLineSpace(ctx)) {
      ctx.errors.push(mkError(location, 'This type of whitespace is not allowed inside a tag'))
    }
    end = consume(ctx, 'close-paren')
  }

  if (!end) {
    throw mkError(ctx, 'Invalid tag, did you forget to quote a string?')
  }

  const result = new Tag(name[0] as string)
  result.representation = name[1] as string

  result.leading = leading
  result.trailing = trailing

  storeLocation(ctx, result, start, ctx.lastToken)
  return result
}

export const parseNodeTerminator = (ctx: ParserCtx): string | undefined =>
  parseSingleLineComment(ctx) ??
  consume(ctx, 'newline')?.text ??
  consume(ctx, 'semicolon')?.text ??
  consume(ctx, 'eof')?.text

export const parseNodeChildren = (ctx: ParserCtx): Document | undefined => {
  if (!consume(ctx, 'open-brace')) {
    return undefined
  }

  const document = parseDocumentBody(ctx)

  if (!consume(ctx, 'close-brace')) {
    throw mkError(ctx, 'Invalid node children')
  }

  return document
}

export const parseNodePropOrArg = (ctx: ParserCtx): [Entry, string | undefined] | undefined => {
  const start = ctx.current.value as Token

  {
    const tag = parseTag(ctx)
    if (tag) {
      const betweenTagAndValue = parseNodeSpace(ctx)
      const value = parseValue(ctx)
      if (!value) {
        throw mkError(ctx, 'Invalid argument')
      }

      if (value.tag) {
        ctx.errors.push(
          mkError(ctx.lastToken, 'A number suffix cannot be combined with a regular tag'),
        )
      }

      value.tag = tag
      value.betweenTagAndValue = betweenTagAndValue

      const entry = new Entry(value, null)

      storeLocation(ctx, value, start, ctx.lastToken)
      storeLocation(ctx, entry, start, ctx.lastToken)

      let trailing = parseNodeSpace(ctx)
      if (consume(ctx, 'equals')) {
        ctx.errors.push(
          mkError(
            ctx.lastToken,
            typeof value.value === 'string'
              ? 'Unexpected equals sign, properties are name=(tag)value not (tag)name=value'
              : 'Unexpected equals sign',
          ),
        )
        trailing = concatenate(trailing, parseNodeSpace(ctx)) || ' '
      }

      return [entry, trailing]
    }
  }

  {
    const value = parseNonStringValue(ctx)
    if (value) {
      const entry = new Entry(value, null)
      storeLocation(ctx, entry, start, ctx.lastToken)

      let trailing = parseNodeSpace(ctx)
      if (consume(ctx, 'equals')) {
        ctx.errors.push(
          mkError(
            ctx.lastToken,
            'Unexpected equals sign, did you forget to quote the property name?',
          ),
        )
        trailing = concatenate(trailing, parseNodeSpace(ctx)) || ' '
      }

      return [entry, trailing]
    }
  }

  const nameOrValue = parseString(ctx)
  if (!nameOrValue) {
    return undefined
  }

  const beforeEquals = parseNodeSpace(ctx)

  const equals = consume(ctx, 'equals')
  if (!equals) {
    const value = new Value(nameOrValue[0])
    value.representation = nameOrValue[1]
    storeLocation(ctx, value, nameOrValue[2])

    const entry = new Entry(value, null)
    storeLocation(ctx, entry, start, ctx.lastToken)

    return [entry, beforeEquals]
  }

  const name = new Identifier(nameOrValue[0])
  name.representation = nameOrValue[1]
  storeLocation(ctx, name, nameOrValue[2])

  const afterEquals = parseNodeSpace(ctx)

  const tag = parseTag(ctx)
  const afterTag = tag && parseNodeSpace(ctx)

  const value = parseValue(ctx)
  if (!value) {
    throw mkError(ctx, 'Expected a value')
  }

  if (tag) {
    if (value.tag) {
      ctx.errors.push(
        mkError(ctx.lastToken, 'A number suffix cannot be combined with a regular tag'),
      )
    }

    value.tag = tag
    value.betweenTagAndValue = afterTag
  }

  const entry = new Entry(value, name)
  storeLocation(ctx, entry, start, ctx.lastToken)
  entry.equals = concatenate(beforeEquals, equals.text, afterEquals)

  return [entry, undefined]
}

export const parseNodePropOrArgWithSpace = (ctx: ParserCtx): Entry | undefined => {
  let leading = parseNodeSpace(ctx) ?? ''

  let tmp: string | undefined
  while ((tmp = parseSlashdash(ctx))) {
    const start = ctx.lastToken.end
    const propOrArg = parseNodePropOrArg(ctx)
    if (!propOrArg) {
      throw mkError(ctx, 'Expected a property or argument')
    }

    const space = propOrArg[1] ?? parseNodeSpace(ctx)
    if (!space) {
      throw mkError(ctx, 'Expected space after slashdashed property or argument')
    }

    leading = leading + tmp + ctx.text.slice(start.offset, ctx.lastToken.end.offset)
  }

  const firstEntry = parseNodePropOrArg(ctx)
  if (!firstEntry) {
    return undefined
  }

  let trailing = firstEntry[1] ?? parseNodeSpace(ctx) ?? ''

  while ((tmp = parseSlashdash(ctx))) {
    const start = ctx.lastToken.end
    const propOrArg = parseNodePropOrArg(ctx)
    if (!propOrArg) {
      throw mkError(ctx, 'Expected a property or argument')
    }

    const space = propOrArg[1] ?? parseNodeSpace(ctx)
    if (!space) {
      break
    }

    trailing = trailing + tmp + ctx.text.slice(start.offset, ctx.lastToken.end.offset)
  }

  const entry = firstEntry[0]

  entry.leading = leading
  entry.trailing = trailing

  return entry
}

const parseSlashdash = (ctx: ParserCtx): string | undefined => {
  const text = consume(ctx, 'slashdash')?.text
  if (!text) {
    return undefined
  }

  return concatenate(text, parseLineSpace(ctx))
}

export const parseBaseNode = (ctx: ParserCtx): Node | undefined => {
  const startOfNode = ctx.current.value as Token

  const tag = parseTag(ctx)
  const betweenTagAndName = tag ? parseNodeSpace(ctx) : undefined

  const name = parseIdentifier(ctx)
  if (!name) {
    if (tag) {
      throw mkError(ctx, "Couldn't find node name")
    } else {
      return undefined
    }
  }

  let space = parseNodeSpace(ctx)
  let endsOnWhitespace = space != null
  let slashdash: string | undefined = parseSlashdash(ctx)
  const entries: Entry[] = []

  while (endsOnWhitespace || slashdash) {
    const start = ctx.lastToken.end

    const nextEntry = parseNodePropOrArg(ctx)
    if (!nextEntry) {
      break
    }

    if (slashdash) {
      endsOnWhitespace = (nextEntry[1] || parseNodeSpace(ctx)) != null
      space = concatenate(space, slashdash, ctx.text.slice(start.offset, ctx.lastToken.end.offset))

      slashdash = parseSlashdash(ctx)
    } else {
      const entry = nextEntry[0]
      entry.leading = space
      entries.push(entry)

      space = nextEntry[1] || parseNodeSpace(ctx)
      endsOnWhitespace = space != null
      slashdash = parseSlashdash(ctx)
    }
  }

  let possibleChildren: Document | undefined
  let spaceBeforeChildren: string | undefined

  while (true) {
    slashdash ??= parseSlashdash(ctx)
    const start = ctx.lastToken.end

    const parsedChildren = parseNodeChildren(ctx)
    if (!parsedChildren) {
      if (slashdash) {
        throw mkError(ctx, 'Unexpected slashdash')
      }
      break
    }

    if (slashdash) {
      space = concatenate(space, slashdash, ctx.text.slice(start.offset, ctx.lastToken.end.offset))
      slashdash = undefined
    } else {
      if (possibleChildren) {
        ctx.errors.push(mkError(ctx, 'A node can only have one children block'))
      }

      possibleChildren = parsedChildren
      spaceBeforeChildren = space ?? ''
      space = undefined
    }

    space = concatenate(space, parseNodeSpace(ctx))
  }

  const node = new Node(name, entries, possibleChildren ?? null)
  node.tag = tag ?? null
  node.betweenTagAndName = betweenTagAndName

  node.beforeChildren = spaceBeforeChildren
  node.trailing = space ?? ''

  storeLocation(ctx, node, startOfNode, ctx.lastToken)

  return node
}

export const parseNodeWithSpace = (ctx: ParserCtx): Node | undefined => {
  const leading = parseLineSpace(ctx)
  const node = parseBaseNode(ctx)
  if (!node) {
    return undefined
  }
  const trailing = concatenate(parseNodeTerminator(ctx), parseLineSpace(ctx))

  node.leading = concatenate(leading, node.leading)
  node.trailing = concatenate(node.trailing, trailing)

  return node
}

export const parseDocument = (ctx: ParserCtx): Document => {
  const bom = consume(ctx, 'bom')?.text

  const document = parseDocumentBody(ctx)

  if (!bom) {
    return document
  }

  if (document.nodes[0]) {
    document.nodes[0].leading = concatenate(bom, document.nodes[0].leading)
  } else {
    document.trailing = concatenate(bom, document.trailing)
  }

  return document
}

const parseDocumentBody = (ctx: ParserCtx): Document => {
  const startOfDocument = ctx.current.value as Token

  const nodes: Node[] = []

  let hasSeparator = true

  let space = parseLineSpace(ctx)

  while (hasSeparator) {
    const start = ctx.lastToken.end
    const slashdash = parseSlashdash(ctx)

    const node = parseBaseNode(ctx)
    if (!node) {
      if (slashdash) {
        throw mkError(ctx, 'Unexpected slashdash')
      }
      break
    }

    const trailing = parseNodeSpace(ctx)
    const terminator = parseNodeTerminator(ctx)

    if (slashdash) {
      space = concatenate(
        space,
        ctx.text.slice(start.offset, ctx.lastToken.end.offset),
        parseLineSpace(ctx),
      ) as string
    } else {
      node.trailing = concatenate(node.trailing, trailing, terminator) ?? ''
      nodes.push(node)

      node.leading = space ?? ''

      space = parseLineSpace(ctx)
    }

    hasSeparator = terminator != null
  }

  const document = new Document(nodes)
  storeLocation(ctx, document, startOfDocument, ctx.lastToken)

  document.trailing = space ?? ''
  return document
}
