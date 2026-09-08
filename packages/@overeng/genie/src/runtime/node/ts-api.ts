/**
 * Node-only boundary over the TypeScript 7 compiler API (`typescript/unstable/*`).
 *
 * TypeScript 7 ships the Go compiler as the only implementation: the npm package's `.` entry carries
 * version metadata alone, and the classic in-process API (`ts.createSourceFile`, `ts.createProgram`,
 * `ts.transpileModule`, `ts.preProcessFile`, `ts.resolveModuleName`, `ts.sys`) no longer exists. The
 * replacement is a session against the bundled `tsgo` binary: `new API(...)` spawns it, snapshots hold
 * projects, and `Program.getSourceFile` returns a real AST decoded locally, so `node.forEachChild` and
 * the `typescript/unstable/ast` type guards still do the walking in-process.
 *
 * Two shapes cover every first-party consumer:
 *
 * - {@link withTsFileAnalysis} — analyze files that live on disk and belong to no project we control
 *   (`.genie.ts` sources, published `dist` closures). Files are opened LSP-style, so the server picks
 *   the ancestor `tsconfig.json` when there is one and an inferred project otherwise, and module
 *   specifiers resolve exactly as the compiler resolves them for that file.
 * - {@link withTsVirtualProject} — type-check in-memory sources against a synthesized config, replacing
 *   the old `createCompilerHost`/`createProgram` override dance.
 *
 * Both own the session lifetime: the `tsgo` child process is always closed, including on throw.
 */

import path from 'node:path'

import type { Node, SourceFile, StringLiteral } from 'typescript/unstable/ast'
import type { Diagnostic } from 'typescript/unstable/sync'
import { API } from 'typescript/unstable/sync'

/** A file opened for analysis: its AST plus the module resolution of the project that owns it. */
export type TsFileAnalysis = {
  /** The parsed source file. */
  readonly sourceFile: SourceFile
  /**
   * Absolute path the given module specifier resolves to, or `undefined` when it does not resolve
   * (an unresolvable bare specifier, or an ambient/virtual module with no declaration file).
   */
  readonly resolveModuleSpecifier: (moduleSpecifier: StringLiteral) => string | undefined
}

/** Analysis session over files that are opened one at a time, LSP-style. */
export type TsFileAnalysisSession = {
  /** Open `file` (idempotent) and return its AST plus resolver, or `undefined` when it is not analyzable. */
  readonly analyze: (file: string) => TsFileAnalysis | undefined
}

/** Run `use` against a TypeScript 7 session that analyzes on-disk files, closing the compiler process afterwards. */
export const withTsFileAnalysis = <A>({
  cwd,
  use,
}: {
  /** Working directory the compiler resolves relative paths and ancestor configs against. */
  cwd: string
  use: (session: TsFileAnalysisSession) => A
}): A => {
  const api = new API({ cwd })
  try {
    const opened = new Set<string>()
    // The newest snapshot owns the projects and ASTs: opening a file supersedes the previous
    // snapshot, so nodes must always be read out of the snapshot the open produced.
    let snapshot = api.updateSnapshot()

    const analyze = (file: string): TsFileAnalysis | undefined => {
      if (opened.has(file) === false) {
        opened.add(file)
        snapshot = api.updateSnapshot({ openFiles: [file] })
      }
      const project = snapshot.getDefaultProjectForFile(file)
      if (project === undefined) return undefined
      const sourceFile = project.program.getSourceFile(file)
      if (sourceFile === undefined) return undefined
      return {
        sourceFile,
        resolveModuleSpecifier: (moduleSpecifier) =>
          project.checker.getSymbolAtLocation(moduleSpecifier)?.declarations[0]?.path,
      }
    }

    return use({ analyze })
  } finally {
    api.close()
  }
}

/** Run `use` against a project synthesized from in-memory sources, closing the compiler process afterwards. */
export const withTsVirtualProject = <A>({
  root,
  files,
  compilerOptions,
  rootFiles,
  use,
}: {
  /** Absolute directory the synthesized config lives in; `files` keys are resolved against it. */
  root: string
  /** In-memory sources keyed by path (absolute, or relative to `root`). */
  files: ReadonlyMap<string, string>
  /** `compilerOptions` for the synthesized config, in tsconfig (string-enum) spelling. */
  compilerOptions: Readonly<Record<string, unknown>>
  /** Root file paths of the synthesized project, in the same spelling as the `files` keys. */
  rootFiles: ReadonlyArray<string>
  use: (project: TsVirtualProject) => A
}): A => {
  const absolute = (file: string): string => path.resolve(root, file)
  const overlay = new Map([...files].map(([file, text]) => [absolute(file), text]))
  const configPath = absolute('tsconfig.genie-virtual.json')
  const configText = JSON.stringify({ compilerOptions, files: rootFiles.map(absolute) })
  const overlayDirectories = new Set(
    [configPath, ...overlay.keys()].map((file) => path.dirname(file)),
  )

  const api = new API({
    cwd: root,
    // `undefined` means "fall through to the real filesystem", which is what the bundled `lib.*.d.ts`
    // files and any real dependency of an in-memory source need.
    fs: {
      readFile: (file) => (file === configPath ? configText : overlay.get(file)),
      fileExists: (file) =>
        file === configPath || overlay.has(file) === true ? true : undefined,
      directoryExists: (directory) => (overlayDirectories.has(directory) === true ? true : undefined),
    },
  })
  try {
    const snapshot = api.updateSnapshot({ openProjects: [configPath] })
    const project = snapshot.getProject(configPath)
    if (project === undefined) {
      throw new Error(`TypeScript API did not open the synthesized project ${configPath}`)
    }
    return use({
      diagnosticMessages: () => [
        ...project.program.getConfigFileParsingDiagnostics(),
        ...project.program.getProgramDiagnostics(),
        ...project.program.getSyntacticDiagnostics(),
        ...project.program.getSemanticDiagnostics(),
      ].map(formatDiagnostic),
    })
  } finally {
    api.close()
  }
}

/** A synthesized in-memory project. */
export type TsVirtualProject = {
  /** Config, program-wide, syntactic and semantic diagnostics as flattened messages. */
  readonly diagnosticMessages: () => ReadonlyArray<string>
}

/**
 * Flatten a diagnostic and its message chain into one newline-joined message — the TypeScript 7
 * equivalent of `ts.flattenDiagnosticMessageText`, which took the classic `messageText` union.
 */
export const formatDiagnostic = (diagnostic: Diagnostic): string =>
  [
    diagnostic.text,
    ...(diagnostic.messageChain ?? []).map((nested) => formatDiagnostic(nested)),
  ].join('\n')

/** Depth-first walk of `node` and every descendant, in source order. */
export const forEachDescendant = (node: Node, visit: (node: Node) => void): void => {
  node.forEachChild((child) => {
    visit(child)
    forEachDescendant(child, visit)
    return undefined
  })
}
