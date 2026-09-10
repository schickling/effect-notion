/**
 * Node-only bootstrap-safe import-closure check for genie generator sources.
 *
 * A `.genie.ts` file (and every helper it transitively imports at RUNTIME) must be importable from a
 * fresh checkout BEFORE package-manager install state exists. A generator that transitively reaches a
 * runtime-only package — e.g. through a wide barrel that `export *`s a module importing `effect` — pulls
 * that package into the generator's bootstrap import closure and breaks `genie:run` on a fresh clone.
 *
 * This walker reuses TypeScript's own parser and module resolution through the TypeScript 7 compiler API
 * ({@link runTsFileAnalysis}) — the bug-prone parts — and injects genie's OWN `#`/`#mr` resolution
 * ({@link resolveImportMapSpecifierForImporterSync}) so lock-pinned megarepo-member imports resolve exactly as
 * genie resolves them at bootstrap. It owns only the transitive walk and the bootstrap policy. It never descends
 * into `node_modules`: a bare (non-relative, non-`#`, non-`node:`-builtin) specifier is a closure boundary — the
 * reported violation — not an edge to follow, so the check has no dependency on install state and never parses a
 * `.d.ts` closure.
 *
 * Type-only edges (`import type`, `export type`, and per-specifier `{ type X }`) are erased at runtime and
 * are excluded from the closure.
 */

import { existsSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import path from 'node:path'

import type {
  NamedExportBindings,
  NamedImportBindings,
  Node,
  SourceFile,
  StringLiteral,
} from 'typescript/unstable/ast'
import {
  isCallExpression,
  isExportDeclaration,
  isImportDeclaration,
  isNamedExports,
  isNamedImports,
  isNamespaceImport,
  isStringLiteral,
  SyntaxKind,
} from 'typescript/unstable/ast'

import {
  isImportMapSpecifier,
  resolveImportMapSpecifierForImporterSync,
} from '../../core/import-map/sync-resolver.ts'
import { runTsFileAnalysis } from './ts-api.ts'
import type { TsFileAnalysis, TsFileAnalysisSession } from './ts-api.ts'

/** A transitive edge from a `.genie.ts` source to a runtime-only package, with the importer chain. */
export type BootstrapClosureViolation = {
  /** The offending `.genie.ts` source (absolute path). */
  source: string
  /** The runtime-only specifier reached (e.g. `effect`, `@effect/platform`, `typescript`). */
  specifier: string
  /** The importer chain `[source, ...intermediates, terminalFile]` — absolute paths, ending at the file that imports `specifier`. */
  chain: readonly string[]
}

/** The result of {@link checkBootstrapClosure}: the violations found plus every source that was walked. */
export type BootstrapClosureResult = {
  /** One violation per `.genie.ts` source that transitively reaches a runtime-only package (shortest chain). */
  violations: readonly BootstrapClosureViolation[]
  /** Every `.genie.ts` source that was walked. */
  checkedSources: readonly string[]
}

const isRelativeSpecifier = (specifier: string): boolean =>
  specifier.startsWith('./') === true || specifier.startsWith('../') === true

/** A node builtin is always importable pre-install, so it is bootstrap-safe with or without the `node:` prefix. */
const isNodeBuiltin = (specifier: string): boolean =>
  specifier.startsWith('node:') === true || isBuiltin(specifier) === true

/**
 * A specifier is a bootstrap violation iff it is a bare package name — i.e. not relative, not a `#`/`#mr`
 * import-map specifier (which genie resolves to on-disk source), and not a node builtin. First-party source
 * reached via relative / `#` / `#mr` paths is allowed; anything landing on a bare package name is forbidden.
 */
const isViolationSpecifier = (specifier: string): boolean =>
  isRelativeSpecifier(specifier) === false &&
  isImportMapSpecifier(specifier) === false &&
  isNodeBuiltin(specifier) === false

/** True when every named binding carries an inline `type` keyword (`import { type A, type B }`), making the whole edge type-only. */
const allNamedBindingsAreTypeOnly = (
  bindings: NamedImportBindings | NamedExportBindings | undefined,
): boolean => {
  if (bindings === undefined) return false
  if (isNamedImports(bindings) === true || isNamedExports(bindings) === true) {
    const { elements } = bindings
    return elements.length > 0 && elements.every((element) => element.isTypeOnly === true)
  }
  return false
}

/** Extract the RUNTIME (value, non-type-only) module specifier literals a source file imports/re-exports/dynamically-imports. */
const runtimeSpecifiersOf = (sourceFile: SourceFile): readonly StringLiteral[] => {
  const specifiers: StringLiteral[] = []

  const visit = (node: Node): void => {
    // import ... from 'x'
    if (isImportDeclaration(node) === true && isStringLiteral(node.moduleSpecifier) === true) {
      const clause = node.importClause
      // `import type ...` (phaseModifier === TypeKeyword) is fully type-only; `import defer ...`
      // (DeferKeyword) is a runtime edge. A value default binding (`import helper, { type X }`) or a
      // namespace import (`import * as x`) is a runtime edge even when every named binding is
      // inline-`type`, so those must NOT be skipped.
      const hasValueDefault = clause?.name !== undefined
      const isNamespaceBinding =
        clause?.namedBindings !== undefined && isNamespaceImport(clause.namedBindings) === true
      const typeOnly =
        clause?.phaseModifier === SyntaxKind.TypeKeyword ||
        (hasValueDefault === false &&
          isNamespaceBinding === false &&
          allNamedBindingsAreTypeOnly(clause?.namedBindings) === true)
      if (typeOnly === false) specifiers.push(node.moduleSpecifier)
    }

    // export ... from 'x'  (covers `export * from` and `export { ... } from`)
    if (
      isExportDeclaration(node) === true &&
      node.moduleSpecifier !== undefined &&
      isStringLiteral(node.moduleSpecifier) === true
    ) {
      const typeOnly = node.isTypeOnly === true || allNamedBindingsAreTypeOnly(node.exportClause)
      if (typeOnly === false) specifiers.push(node.moduleSpecifier)
    }

    // dynamic import('x') with a string-literal argument
    if (isCallExpression(node) === true && node.expression.kind === SyntaxKind.ImportKeyword) {
      const [first] = node.arguments
      if (first !== undefined && isStringLiteral(first) === true) specifiers.push(first)
    }

    node.forEachChild((child) => {
      visit(child)
      return undefined
    })
  }

  visit(sourceFile)
  return specifiers
}

/**
 * Resolve a bootstrap-safe specifier (relative or `#`/`#mr`) to an absolute file path, using genie's own
 * resolver for `#`/`#mr` and the compiler's resolution for relative paths. Bare specifiers are never resolved
 * (they are violations, not edges to follow) so this never touches `node_modules`.
 */
const resolveFollowableSpecifier = async ({
  specifier,
  importerFile,
  analysis,
}: {
  specifier: StringLiteral
  importerFile: string
  analysis: TsFileAnalysis
}): Promise<string | undefined> =>
  isImportMapSpecifier(specifier.text) === true
    ? resolveImportMapSpecifierForImporterSync({
        specifier: specifier.text,
        importerPath: importerFile,
      })
    : await analysis.resolveModuleSpecifier(specifier)

/**
 * Walk the transitive runtime import closure of each `.genie.ts` source and report those that reach a
 * runtime-only package, with the shortest importer chain to the offending edge.
 */
export const checkBootstrapClosure = async ({
  genieFiles,
}: {
  /** Absolute paths of the `.genie.ts` sources to check. */
  genieFiles: readonly string[]
}): Promise<BootstrapClosureResult> => {
  /** Per-file analysis, memoized globally — the runtime import graph is identical across all roots. */
  type FileEdges = {
    /** Bare runtime-only specifiers directly imported by this file (closure boundaries). */
    readonly violationSpecifiers: readonly string[]
    /** Absolute paths of first-party files this file imports at runtime (edges to follow). */
    readonly followTargets: readonly string[]
  }
  const edgesCache = new Map<string, FileEdges>()
  const edgesOf = async ({
    file,
    session,
  }: {
    file: string
    session: TsFileAnalysisSession
  }): Promise<FileEdges> => {
    const cached = edgesCache.get(file)
    if (cached !== undefined) return cached
    const violationSpecifiers: string[] = []
    const followTargets: string[] = []
    const analysis = existsSync(file) === true ? await session.analyze(file) : undefined
    if (analysis !== undefined) {
      const resolutions = await Promise.all(
        runtimeSpecifiersOf(analysis.sourceFile).map(async (specifier) => ({
          specifier: specifier.text,
          resolved:
            isRelativeSpecifier(specifier.text) === true ||
            isImportMapSpecifier(specifier.text) === true
              ? await resolveFollowableSpecifier({
                  specifier,
                  importerFile: file,
                  analysis,
                })
              : undefined,
        })),
      )
      for (const { specifier, resolved } of resolutions) {
        if (isViolationSpecifier(specifier) === true) violationSpecifiers.push(specifier)
        else if (resolved !== undefined) followTargets.push(resolved)
      }
    }
    const edges: FileEdges = { violationSpecifiers, followTargets }
    edgesCache.set(file, edges)
    return edges
  }

  /** BFS from a root; returns the shortest chain to the first runtime-only specifier, or undefined. */
  const findViolation = async ({
    root,
    session,
  }: {
    root: string
    session: TsFileAnalysisSession
  }): Promise<BootstrapClosureViolation | undefined> => {
    const seen = new Set<string>()
    const queue: (readonly string[])[] = [[root]]
    const visitNext = async (): Promise<BootstrapClosureViolation | undefined> => {
      const chain = queue.shift()
      if (chain === undefined) return undefined
      const current = chain[chain.length - 1]!
      if (seen.has(current) === true) return visitNext()
      seen.add(current)

      const { violationSpecifiers, followTargets } = await edgesOf({ file: current, session })
      if (violationSpecifiers.length > 0) {
        return { source: root, specifier: violationSpecifiers[0]!, chain }
      }
      for (const target of followTargets) {
        if (seen.has(target) === false) queue.push([...chain, target])
      }
      return visitNext()
    }

    return visitNext()
  }

  const sortedGenieFiles = [...genieFiles].toSorted()
  const violations = await runTsFileAnalysis({
    cwd: process.cwd(),
    use: async (session) => {
      const found: BootstrapClosureViolation[] = []
      const visitRoot = async (index: number): Promise<void> => {
        const root = sortedGenieFiles[index]
        if (root === undefined) return
        const violation = await findViolation({ root, session })
        if (violation !== undefined) found.push(violation)
        return visitRoot(index + 1)
      }
      await visitRoot(0)
      return found
    },
  })

  return { violations, checkedSources: sortedGenieFiles }
}

/** Format a violation's importer chain as a repo-relative `source -> barrel -> runtime -> pkg` diagnostic. */
export const formatViolationChain = ({
  violation,
  repoRoot,
}: {
  violation: BootstrapClosureViolation
  repoRoot: string
}): string => {
  const rel = (absolutePath: string): string => path.relative(repoRoot, absolutePath)
  const links = [...violation.chain.map(rel), violation.specifier]
  return links.join('\n    -> ')
}
