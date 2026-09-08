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

const removeComments = (source: string): string => {
  const scanner = createScanner(false, undefined, source)
  const chunks: string[] = []
  let position = 0
  for (let token = scanner.scan(); token !== SyntaxKind.EndOfFile; token = scanner.scan()) {
    const start = scanner.getTokenStart()
    chunks.push(source.slice(position, start))
    const tokenText = source.slice(start, scanner.getTokenEnd())
    chunks.push(
      token === SyntaxKind.SingleLineCommentTrivia || token === SyntaxKind.MultiLineCommentTrivia
        ? tokenText.replace(/[^\r\n]/g, ' ')
        : tokenText,
    )
    position = scanner.getTokenEnd()
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
