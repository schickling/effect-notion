import { readdirSync, readFileSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'

import { createScanner, SyntaxKind } from 'typescript/unstable/ast'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(import.meta.dirname, '../../..', '..')
const packagesRoot = resolve(repoRoot, 'packages/@overeng')

const rawOtelCall = /\b(?:Effect|Stream)\.(?:withSpan|annotateCurrentSpan)\s*\(/g
const rawMetricCall = /\bMetric\.(?:counter|histogram|tagged|increment|incrementBy|update)\s*\(/g

const allowedRawOtelFiles = new Set([
  'packages/@overeng/otel-contract/src/mod.ts',
  'packages/@overeng/notion-datasource-sync/src/observability/observability.ts',
  'packages/@overeng/oxc-config/src/no-raw-otel-primitives.ts',
  'packages/@overeng/utils-dev/src/otelite/otel.ts',
])

const allowedRawMetricFiles = new Set([
  ...allowedRawOtelFiles,
  // v4: `Metric.update` is the only emission API; utils/node/otel.ts is the shared
  // runtime bridge layer that owns raw emission on behalf of the contracts.
  'packages/@overeng/utils/src/node/otel.ts',
])

const isProductionSource = (path: string) =>
  path.endsWith('.ts') &&
  path.includes('/src/') &&
  path.includes('/node_modules/') === false &&
  path.includes('/dist/') === false &&
  path.includes('/examples/') === false &&
  path.includes('/__tests__/') === false &&
  /\.(?:test|unit\.test|integration\.test|e2e\.test)\.ts$/.test(path) === false

const sourceFiles = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir).flatMap((entry) => {
    if (entry === 'node_modules' || entry === 'dist') return []
    const path = resolve(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory() === true) return sourceFiles(path)
    return isProductionSource(path) === true ? [path] : []
  })

/**
 * Tokens after which a `/` continues an expression (division) instead of opening a regex literal.
 * Every other token — operators, punctuation, keywords such as `return` — may be followed by one.
 * `}` is deliberately absent: a statement-leading regex after a block is real, division after an
 * object literal or block is not.
 */
const divisionFollows = new Set<SyntaxKind>([
  SyntaxKind.Identifier,
  SyntaxKind.PrivateIdentifier,
  SyntaxKind.NumericLiteral,
  SyntaxKind.BigIntLiteral,
  SyntaxKind.StringLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.TemplateTail,
  SyntaxKind.RegularExpressionLiteral,
  SyntaxKind.CloseParenToken,
  SyntaxKind.CloseBracketToken,
  SyntaxKind.PlusPlusToken,
  SyntaxKind.MinusMinusToken,
  SyntaxKind.ThisKeyword,
  SyntaxKind.SuperKeyword,
  SyntaxKind.TrueKeyword,
  SyntaxKind.FalseKeyword,
  SyntaxKind.NullKeyword,
])

/**
 * Blank out comments while preserving every other byte offset.
 *
 * TypeScript's scanner is context-free, so `scan()` alone mis-reads two constructs and the loop must
 * re-scan them: a `/` that opens a regex literal comes back as a division token (`/https?:\/\//` then
 * looks like a line comment and blanks the real code behind it), and a template stops at its first
 * `${` (the `}` that closes the substitution comes back as a brace, so the trailing template text is
 * scanned as code and a real comment after it survives unblanked). `reScanSlashToken()` and
 * `reScanTemplateToken(false)` — driven off the previous significant token and the brace depth each
 * open substitution started at — are what give the scan that context.
 *
 * TypeScript 7's scanner parks on a zero-width `PrivateIdentifier` when it meets a `#` that starts
 * no private name, so the scan must step over that character by hand and resume; the pre-7 scanner
 * consumed it as an error token instead.
 */
const removeComments = (source: string): string => {
  const scanner = createScanner(false, undefined, source)
  const chunks: string[] = []
  let position = 0
  /** Last non-trivia token, which decides whether a `/` opens a regex literal. */
  let previous: SyntaxKind = SyntaxKind.Unknown
  let braceDepth = 0
  /** Brace depth each open template substitution started at: its `}` closes the span, not a block. */
  const templateSpans: number[] = []

  for (let token = scanner.scan(); token !== SyntaxKind.EndOfFile; token = scanner.scan()) {
    if (
      (token === SyntaxKind.SlashToken || token === SyntaxKind.SlashEqualsToken) &&
      divisionFollows.has(previous) === false
    ) {
      token = scanner.reScanSlashToken()
    } else if (token === SyntaxKind.OpenBraceToken) {
      braceDepth += 1
    } else if (token === SyntaxKind.CloseBraceToken) {
      if (templateSpans[templateSpans.length - 1] === braceDepth) {
        token = scanner.reScanTemplateToken(false)
        if (token === SyntaxKind.TemplateTail) templateSpans.pop()
      } else {
        braceDepth -= 1
      }
    }
    if (token === SyntaxKind.TemplateHead) templateSpans.push(braceDepth)

    const start = scanner.getTokenStart()
    const end = scanner.getTokenEnd()
    chunks.push(source.slice(position, start))
    if (end === start) {
      if (start >= source.length) break
      chunks.push(source.slice(start, start + 1))
      position = start + 1
      scanner.resetTokenState(position)
      previous = SyntaxKind.Unknown
      continue
    }
    const tokenText = source.slice(start, end)
    chunks.push(
      token === SyntaxKind.SingleLineCommentTrivia || token === SyntaxKind.MultiLineCommentTrivia
        ? tokenText.replace(/[^\r\n]/g, ' ')
        : tokenText,
    )
    position = end
    if (token < SyntaxKind.FirstTriviaToken || token > SyntaxKind.LastTriviaToken) previous = token
  }
  chunks.push(source.slice(position))
  return chunks.join('')
}

describe('raw OTEL boundary', () => {
  it('routes production span instrumentation through schema-backed helpers', () => {
    const violations = sourceFiles(packagesRoot).flatMap((path) => {
      const relativePath = relative(repoRoot, path)
      if (allowedRawOtelFiles.has(relativePath) === true) return []

      const source = removeComments(readFileSync(path, 'utf8'))
      return [...source.matchAll(rawOtelCall)].map((match) => `${relativePath}:${match[0]}`)
    })

    expect(violations).toEqual([])
  })

  it('routes production metric instrumentation through schema-backed helpers', () => {
    const violations = sourceFiles(packagesRoot).flatMap((path) => {
      const relativePath = relative(repoRoot, path)
      if (allowedRawMetricFiles.has(relativePath) === true) return []

      const source = removeComments(readFileSync(path, 'utf8'))
      return [...source.matchAll(rawMetricCall)].map((match) => `${relativePath}:${match[0]}`)
    })

    expect(violations).toEqual([])
  })
})

describe('removeComments', () => {
  const matches = (source: string, pattern: RegExp): readonly string[] =>
    [...removeComments(source).matchAll(pattern)].map((match) => match[0])

  it('keeps a raw OTEL call visible after a regex literal containing "//"', () => {
    const source = `export const run = (u: string, x: number) => /https?:\\/\\//.test(u) ? Effect.withSpan('boom')(x) : x\n`

    expect(matches(source, rawOtelCall)).toEqual(['Effect.withSpan('])
  })

  it('blanks a comment that follows an interpolated template', () => {
    const source = [
      'const url = (a: string) => `${a}/${a}/`',
      '// A doc note that mentions Effect.withSpan( and Metric.counter( but calls neither.',
      '',
    ].join('\n')

    expect(matches(source, rawOtelCall)).toEqual([])
    expect(matches(source, rawMetricCall)).toEqual([])
  })

  it('blanks a comment that follows a division expression', () => {
    const source =
      'const half = (total: number, count: number) => total / count // Metric.counter(\n'

    expect(matches(source, rawMetricCall)).toEqual([])
  })

  it('blanks comments and preserves every other byte offset', () => {
    const source = [
      '/* Effect.withSpan( */',
      'const pattern = /a\\/\\/b/',
      'const tagged = `${pattern}` // Effect.withSpan(',
      'const nested = (a: string) => `${`${a}`}/x/` // Metric.counter(',
      'const value = 1 // trailing',
      '',
    ].join('\n')
    const stripped = removeComments(source)

    expect(stripped.length).toBe(source.length)
    expect(matches(source, rawOtelCall)).toEqual([])
    expect(matches(source, rawMetricCall)).toEqual([])
    expect(stripped).toContain('const pattern = /a\\/\\/b/')
    expect(stripped).toContain('const value = 1 ')
    expect(stripped.split('\n').length).toBe(source.split('\n').length)
  })
})
