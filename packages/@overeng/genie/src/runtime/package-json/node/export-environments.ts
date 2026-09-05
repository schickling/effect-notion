import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { isBuiltin } from 'node:module'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

import ts from 'typescript'

import type { ExportEnvironmentContract, PackageJsonValidationRuntime } from '../mod.ts'
import type { ValidationIssue } from '../validation.ts'

type ExportsEntry = string | Record<string, string>

type EnvironmentProfile = {
  conditions: readonly string[]
  forbiddenImports: readonly string[]
  forbiddenGlobals: readonly string[]
  typecheck?: {
    lib: readonly string[]
    types: readonly string[]
    customConditions?: readonly string[]
    moduleResolution?: 'Bundler' | 'NodeNext'
  }
}

type GraphResult = {
  files: readonly string[]
  issues: readonly ValidationIssue[]
}

/** Which compiler backend proves an export's type closure — the bundled `tsgo` or a `custom` binary. */
export type ExportTypeProofCompilerKind = 'tsgo' | 'custom'

/** A resolved type-proof compiler: the binary path plus its inferred/declared kind. */
export type ExportTypeProofCompiler = {
  path: string
  kind: ExportTypeProofCompilerKind
}

/** Node-runtime knobs for package.json export validation (e.g. overriding the type-proof compiler). */
export type NodePackageJsonValidationRuntimeOptions = {
  typeProofCompiler?: ExportTypeProofCompiler
  /**
   * Where proof results and staged proof tsconfigs are written. Defaults to the
   * validated repository's own `.devenv/task-cache`, which requires a writable
   * checkout; a caller validating a read-only tree (a build-system input view)
   * names a writable directory instead.
   */
  proofCacheDir?: string
}

const validatorVersion = 'package-json-export-environments-v2'

const builtinEnvironmentProfiles: Record<string, EnvironmentProfile> = {
  'isomorphic-es2024': {
    conditions: ['import', 'default'],
    forbiddenImports: ['node:*', 'bun', 'bun:*'],
    forbiddenGlobals: ['Bun', 'process', 'window', 'document'],
    typecheck: { lib: ['lib.es2024.d.ts'], types: [] },
  },
  node: {
    conditions: ['node', 'import', 'default'],
    forbiddenImports: [],
    forbiddenGlobals: [],
    typecheck: { lib: ['lib.es2024.d.ts'], types: ['node'] },
  },
  bun: {
    conditions: ['bun', 'import', 'default'],
    forbiddenImports: [],
    forbiddenGlobals: [],
    typecheck: { lib: ['lib.es2024.d.ts'], types: ['bun'] },
  },
  browser: {
    conditions: ['browser', 'import', 'default'],
    forbiddenImports: ['node:*', 'bun', 'bun:*'],
    forbiddenGlobals: ['Bun', 'process'],
    typecheck: { lib: ['lib.es2024.d.ts', 'lib.dom.d.ts'], types: [] },
  },
  webworker: {
    conditions: ['worker', 'browser', 'import', 'default'],
    forbiddenImports: ['node:*', 'bun', 'bun:*'],
    forbiddenGlobals: ['Bun', 'process', 'window', 'document'],
    typecheck: { lib: ['lib.es2024.d.ts', 'lib.webworker.d.ts'], types: [] },
  },
  workerd: {
    conditions: ['workerd', 'worker', 'browser', 'import', 'default'],
    forbiddenImports: ['node:*', 'bun', 'bun:*'],
    forbiddenGlobals: ['Bun', 'process', 'window', 'document'],
    typecheck: {
      lib: ['lib.es2024.d.ts', 'lib.webworker.d.ts'],
      types: ['@cloudflare/workers-types'],
      customConditions: ['workerd'],
      moduleResolution: 'Bundler',
    },
  },
  'react-native': {
    conditions: ['react-native', 'import', 'default'],
    forbiddenImports: ['node:*', 'bun', 'bun:*'],
    forbiddenGlobals: ['Bun', 'window', 'document'],
    typecheck: {
      lib: ['lib.es2024.d.ts'],
      types: ['react-native'],
      customConditions: ['react-native'],
      moduleResolution: 'Bundler',
    },
  },
}

const issue = ({
  packageName,
  dependency,
  message,
  rule,
}: {
  packageName: string
  dependency: string
  message: string
  rule: string
}): ValidationIssue => ({
  severity: 'error',
  packageName,
  dependency,
  message,
  rule,
})

const matchesForbiddenImport = ({
  specifier,
  pattern,
}: {
  specifier: string
  pattern: string
}): boolean => {
  if (pattern === 'node:*' && isBuiltin(specifier) === true) return true
  if (pattern.endsWith('*') === true) return specifier.startsWith(pattern.slice(0, -1))
  return specifier === pattern
}

const resolveRelativeImport = ({
  fromFile,
  specifier,
}: {
  fromFile: string
  specifier: string
}): string | undefined => {
  if (specifier.startsWith('.') === false) return undefined
  const resolved = path.resolve(path.dirname(fromFile), specifier)
  if (existsSync(resolved) === true && statSync(resolved).isFile() === true) return resolved

  const parsed = path.parse(resolved)
  const sourceExtensionsForRuntimeExtension: Record<string, readonly string[]> = {
    '.js': ['.ts', '.tsx'],
    '.jsx': ['.tsx', '.ts'],
    '.mjs': ['.mts', '.ts'],
    '.cjs': ['.cts', '.ts'],
  }
  const sourceExtensions = sourceExtensionsForRuntimeExtension[parsed.ext]
  if (sourceExtensions !== undefined) {
    const sourceBase = path.join(parsed.dir, parsed.name)
    for (const extension of sourceExtensions) {
      const candidate = `${sourceBase}${extension}`
      if (existsSync(candidate) === true) return candidate
    }
  }

  for (const suffix of ['.ts', '.tsx', '.mts', '.cts', '/mod.ts', '/index.ts']) {
    const candidate = `${resolved}${suffix}`
    if (existsSync(candidate) === true) return candidate
  }
  return undefined
}

const findForbiddenGlobals = ({
  file,
  source,
  profile,
  packageName,
  exportPath,
}: {
  file: string
  source: string
  profile: EnvironmentProfile
  packageName: string
  exportPath: string
}): ValidationIssue[] => {
  if (profile.forbiddenGlobals.length === 0) return []

  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const issues: ValidationIssue[] = []
  const forbiddenGlobals = new Set(profile.forbiddenGlobals)

  const addBindingNames = ({
    target,
    name,
  }: {
    target: Set<string>
    name: ts.BindingName
  }): void => {
    if (ts.isIdentifier(name) === true) {
      target.add(name.text)
      return
    }
    for (const element of name.elements) {
      if (ts.isBindingElement(element) === true) addBindingNames({ target, name: element.name })
    }
  }

  const isScopeBoundary = (node: ts.Node): boolean =>
    ts.isSourceFile(node) === true ||
    ts.isBlock(node) === true ||
    ts.isModuleBlock(node) === true ||
    ts.isCaseBlock(node) === true ||
    ts.isCatchClause(node) === true ||
    ts.isFunctionLike(node) === true

  const collectScopeDeclarations = (node: ts.Node): Set<string> => {
    const declarations = new Set<string>()
    if (ts.isFunctionLike(node) === true) {
      for (const parameter of node.parameters) {
        addBindingNames({ target: declarations, name: parameter.name })
      }
    }
    if (ts.isCatchClause(node) === true && node.variableDeclaration !== undefined) {
      addBindingNames({ target: declarations, name: node.variableDeclaration.name })
    }

    const visitDeclaration = (child: ts.Node): void => {
      if (child !== node && isScopeBoundary(child) === true) return
      if (ts.isImportSpecifier(child) === true) declarations.add(child.name.text)
      if (ts.isImportClause(child) === true && child.name !== undefined)
        declarations.add(child.name.text)
      if (ts.isNamespaceImport(child) === true) declarations.add(child.name.text)
      if (ts.isVariableDeclaration(child) === true)
        addBindingNames({ target: declarations, name: child.name })
      if (
        (ts.isFunctionDeclaration(child) === true ||
          ts.isClassDeclaration(child) === true ||
          ts.isInterfaceDeclaration(child) === true ||
          ts.isTypeAliasDeclaration(child) === true) &&
        child.name !== undefined
      ) {
        declarations.add(child.name.text)
      }
      ts.forEachChild(child, visitDeclaration)
    }

    ts.forEachChild(node, visitDeclaration)
    return declarations
  }

  const isDeclarationName = (node: ts.Identifier): boolean => {
    const parent = node.parent
    return (
      parent !== undefined &&
      ((ts.isBindingElement(parent) === true && parent.name === node) ||
        (ts.isImportSpecifier(parent) === true && parent.name === node) ||
        (ts.isImportClause(parent) === true && parent.name === node) ||
        (ts.isNamespaceImport(parent) === true && parent.name === node) ||
        (ts.isVariableDeclaration(parent) === true && parent.name === node) ||
        (ts.isFunctionDeclaration(parent) === true && parent.name === node) ||
        (ts.isParameter(parent) === true && parent.name === node) ||
        (ts.isClassDeclaration(parent) === true && parent.name === node) ||
        (ts.isInterfaceDeclaration(parent) === true && parent.name === node) ||
        (ts.isTypeAliasDeclaration(parent) === true && parent.name === node))
    )
  }

  const isPropertyName = (node: ts.Identifier): boolean => {
    const parent = node.parent
    return (
      parent !== undefined &&
      ((ts.isPropertyAccessExpression(parent) === true && parent.name === node) ||
        (ts.isPropertyAssignment(parent) === true && parent.name === node) ||
        (ts.isPropertyDeclaration(parent) === true && parent.name === node) ||
        (ts.isMethodDeclaration(parent) === true && parent.name === node) ||
        (ts.isExportSpecifier(parent) === true && parent.name === node))
    )
  }

  const visit = ({ node, scopes }: { node: ts.Node; scopes: readonly Set<string>[] }): void => {
    const nextScopes =
      isScopeBoundary(node) === true ? [...scopes, collectScopeDeclarations(node)] : scopes

    if (
      ts.isIdentifier(node) === true &&
      forbiddenGlobals.has(node.text) === true &&
      isDeclarationName(node) === false &&
      isPropertyName(node) === false &&
      nextScopes.some((scope) => scope.has(node.text)) === false
    ) {
      issues.push(
        issue({
          packageName,
          dependency: exportPath,
          message: `${path.relative(process.cwd(), file)} references forbidden global "${node.text}" for this export environment.`,
          rule: 'package-json-export-environment-global',
        }),
      )
    }
    ts.forEachChild(node, (child) => visit({ node: child, scopes: nextScopes }))
  }

  visit({ node: sourceFile, scopes: [] })
  return issues
}

const scanGraph = ({
  entry,
  profile,
  packageName,
  exportPath,
}: {
  entry: string
  profile: EnvironmentProfile
  packageName: string
  exportPath: string
}): GraphResult => {
  const seen = new Set<string>()
  const pending = [entry]
  const issues: ValidationIssue[] = []

  while (pending.length > 0) {
    const file = pending.pop()
    if (file === undefined || seen.has(file) === true) continue
    seen.add(file)

    const source = readFileSync(file, 'utf8')
    const preprocessed = ts.preProcessFile(source, true, true)

    for (const imported of preprocessed.importedFiles) {
      const specifier = imported.fileName
      const forbiddenPattern = profile.forbiddenImports.find((pattern) =>
        matchesForbiddenImport({ specifier, pattern }),
      )
      if (forbiddenPattern !== undefined) {
        issues.push(
          issue({
            packageName,
            dependency: exportPath,
            message: `${path.relative(process.cwd(), file)} imports "${specifier}", which is forbidden by this export environment.`,
            rule: 'package-json-export-environment-import',
          }),
        )
        continue
      }

      const resolved = resolveRelativeImport({ fromFile: file, specifier })
      if (resolved !== undefined) pending.push(resolved)
    }

    issues.push(...findForbiddenGlobals({ file, source, profile, packageName, exportPath }))
  }

  return { files: [...seen].toSorted(), issues }
}

const resolveExportTarget = ({
  entry,
  profile,
}: {
  entry: ExportsEntry
  profile: EnvironmentProfile
}): string | undefined => {
  if (typeof entry === 'string') return entry
  const supportedConditions = new Set(profile.conditions)
  for (const [condition, target] of Object.entries(entry)) {
    if (supportedConditions.has(condition) === false) continue
    if (typeof target === 'string') return target
  }
  return undefined
}

const escapeRegExp = (input: string): string => input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const walkFiles = (root: string): readonly string[] => {
  if (existsSync(root) === false) return []
  const pending = [root]
  const files: string[] = []
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined) continue
    const stat = statSync(current)
    if (stat.isDirectory() === true) {
      for (const child of readdirSync(current)) {
        pending.push(path.join(current, child))
      }
    } else if (stat.isFile() === true) {
      files.push(current)
    }
  }
  return files.toSorted()
}

const resolveTargetEntries = ({
  cwd,
  location,
  target,
}: {
  cwd: string
  location: string
  target: string
}): readonly string[] => {
  const absoluteTarget = path.resolve(cwd, location, target)
  if (target.includes('*') === false)
    return existsSync(absoluteTarget) === true ? [absoluteTarget] : []

  const wildcardIndex = absoluteTarget.indexOf('*')
  const basePrefix = absoluteTarget.slice(0, wildcardIndex)
  const baseDir = basePrefix.endsWith(path.sep) === true ? basePrefix : path.dirname(basePrefix)
  const targetPattern = new RegExp(`^${escapeRegExp(absoluteTarget).replaceAll('\\*', '.*')}$`)

  return walkFiles(baseDir).filter((file) => targetPattern.test(file))
}

const defaultProofCacheRoot = (cwd: string): string =>
  path.join(cwd, '.devenv/task-cache/genie-package-json-export-environments')

const sha256 = (content: string): string => createHash('sha256').update(content).digest('hex')

const outputText = (part: unknown): string => {
  if (typeof part === 'string') return part
  if (Buffer.isBuffer(part) === true) return part.toString('utf8')
  return ''
}

const nonEmptyOutput = (part: string): boolean => part.trim() !== ''

const executableExists = (file: string): boolean => {
  try {
    return existsSync(file) === true && statSync(file).isFile() === true
  } catch {
    return false
  }
}

const resolveExecutableFromPath = (name: string): string | undefined => {
  const pathEnv = process.env.PATH
  if (pathEnv === undefined) return undefined
  for (const dir of pathEnv.split(path.delimiter)) {
    if (dir === '') continue
    const candidate = path.join(dir, name)
    if (executableExists(candidate) === true) return candidate
  }
  return undefined
}

const inferCompilerKind = (compilerPath: string): ExportTypeProofCompilerKind =>
  path.basename(compilerPath).startsWith('tsgo') === true ? 'tsgo' : 'custom'

const resolveTypeProofCompiler = (
  configured: ExportTypeProofCompiler | undefined,
): ExportTypeProofCompiler | undefined => {
  if (configured !== undefined) return configured

  const envCompiler = process.env.GENIE_EXPORT_TYPE_PROOF_COMPILER
  if (envCompiler !== undefined && envCompiler !== '') {
    return { path: envCompiler, kind: inferCompilerKind(envCompiler) }
  }

  const tsgo = resolveExecutableFromPath('tsgo')
  if (tsgo !== undefined) return { path: tsgo, kind: 'tsgo' }

  return undefined
}

const compilerVersion = (compiler: ExportTypeProofCompiler): string => {
  const result = spawnSync(compiler.path, ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return [
    compiler.kind,
    compiler.path,
    outputText(result.stdout).trim(),
    outputText(result.stderr).trim(),
    result.error?.message ?? '',
  ].join('\n')
}

const proofCacheKey = ({
  files,
  cacheInputs,
  contract,
  profile,
  compiler,
}: {
  files: readonly string[]
  cacheInputs: readonly string[]
  contract: ExportEnvironmentContract
  profile: EnvironmentProfile
  compiler: ExportTypeProofCompiler
}): string => {
  const hash = createHash('sha256')
  hash.update(validatorVersion)
  hash.update('\n')
  hash.update(compilerVersion(compiler))
  hash.update('\n')
  hash.update(JSON.stringify(contract))
  hash.update('\n')
  hash.update(JSON.stringify(profile))
  for (const file of cacheInputs) {
    hash.update('\n')
    hash.update(file)
    hash.update('\n')
    hash.update(existsSync(file) === true ? sha256(readFileSync(file, 'utf8')) : '(missing)')
  }
  for (const file of files) {
    hash.update('\n')
    hash.update(file)
    hash.update('\n')
    hash.update(sha256(readFileSync(file, 'utf8')))
  }
  return hash.digest('hex')
}

const hasCachedProof = ({ cacheRoot, key }: { cacheRoot: string; key: string }): boolean =>
  existsSync(path.join(cacheRoot, `${key}.ok`))

const writeCachedProof = ({ cacheRoot, key }: { cacheRoot: string; key: string }): void => {
  mkdirSync(cacheRoot, { recursive: true })
  writeFileSync(path.join(cacheRoot, `${key}.ok`), 'ok\n')
}

const tsconfigLibName = (lib: string): string =>
  lib
    .replace(/^lib\./, '')
    .replace(/\.d\.ts$/, '')
    .replace(/\b[a-z]/g, (char) => char.toUpperCase())

const writeProofTsconfig = ({
  cacheRoot,
  entry,
  profile,
}: {
  cacheRoot: string
  entry: string
  profile: EnvironmentProfile
}): { dir: string; path: string } => {
  mkdirSync(cacheRoot, { recursive: true })
  const dir = mkdtempSync(path.join(cacheRoot, 'proof-'))
  const configPath = path.join(dir, 'tsconfig.json')
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        compilerOptions: {
          lib: profile.typecheck?.lib.map(tsconfigLibName) ?? [],
          types: profile.typecheck?.types ?? [],
          strict: true,
          noEmit: true,
          module: 'NodeNext',
          moduleResolution: profile.typecheck?.moduleResolution ?? 'NodeNext',
          allowImportingTsExtensions: true,
          skipLibCheck: true,
          ...(profile.typecheck?.customConditions === undefined
            ? {}
            : { customConditions: profile.typecheck.customConditions }),
        },
        files: [entry],
      },
      null,
      2,
    )}\n`,
  )
  return { dir, path: configPath }
}

const runTypeProofCompiler = ({
  compiler,
  configPath,
  cwd,
}: {
  compiler: ExportTypeProofCompiler
  configPath: string
  cwd: string
}): { ok: true } | { ok: false; output: string } => {
  const result = spawnSync(compiler.path, ['--project', configPath, '--pretty', 'false'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status === 0) return { ok: true }
  return {
    ok: false,
    output: [result.stdout, result.stderr, result.error?.message]
      .map(outputText)
      .filter(nonEmptyOutput)
      .join('\n')
      .trim(),
  }
}

const typecheck = ({
  cwd,
  cacheRoot,
  entry,
  files,
  cacheInputs,
  contract,
  profile,
  compiler,
  packageName,
  exportPath,
}: {
  cwd: string
  cacheRoot: string
  entry: string
  files: readonly string[]
  cacheInputs: readonly string[]
  contract: ExportEnvironmentContract
  profile: EnvironmentProfile
  compiler: ExportTypeProofCompiler | undefined
  packageName: string
  exportPath: string
}): { issues: ValidationIssue[]; cache: { hits: number; misses: number } } => {
  if (contract.typeProof !== 'strict') return { issues: [], cache: { hits: 0, misses: 0 } }
  if (profile.typecheck === undefined) {
    return {
      cache: { hits: 0, misses: 0 },
      issues: [
        issue({
          packageName,
          dependency: exportPath,
          message: `Environment "${contract.environment}" does not define a TypeScript proof profile.`,
          rule: 'package-json-export-environment-type-profile',
        }),
      ],
    }
  }
  if (compiler === undefined) {
    return {
      cache: { hits: 0, misses: 0 },
      issues: [
        issue({
          packageName,
          dependency: exportPath,
          message:
            'Strict TypeScript environment proof requires a compiler executable. Provide GENIE_EXPORT_TYPE_PROOF_COMPILER or install tsgo on PATH.',
          rule: 'package-json-export-environment-type-compiler',
        }),
      ],
    }
  }

  const key = proofCacheKey({ files, cacheInputs, contract, profile, compiler })
  if (hasCachedProof({ cacheRoot, key }) === true)
    return { issues: [], cache: { hits: 1, misses: 0 } }

  const proofConfig = writeProofTsconfig({ cacheRoot, entry, profile })
  try {
    const result = runTypeProofCompiler({ compiler, configPath: proofConfig.path, cwd })
    if (result.ok === true) {
      writeCachedProof({ cacheRoot, key })
      return { issues: [], cache: { hits: 0, misses: 1 } }
    }

    return {
      cache: { hits: 0, misses: 1 },
      issues: [
        issue({
          packageName,
          dependency: exportPath,
          message: `TypeScript environment proof failed for "${contract.environment}" using ${compiler.kind}: ${result.output}`,
          rule: 'package-json-export-environment-type-proof',
        }),
      ],
    }
  } finally {
    rmSync(proofConfig.dir, { recursive: true, force: true })
  }
}

/** Package-json-owned node validation runtime injected during Genie validation. */
export const createNodePackageJsonValidationRuntime = ({
  typeProofCompiler: configuredTypeProofCompiler,
  proofCacheDir,
}: NodePackageJsonValidationRuntimeOptions = {}): PackageJsonValidationRuntime => ({
  validateExportEnvironments: (args) => {
    const start = performance.now()
    const issues: ValidationIssue[] = []
    let hits = 0
    let misses = 0
    const typeProofCompiler = resolveTypeProofCompiler(configuredTypeProofCompiler)
    const proofCacheRoot = proofCacheDir ?? defaultProofCacheRoot(args.cwd)

    for (const [exportPath, contracts] of Object.entries(args.contracts)) {
      for (const contract of contracts) {
        const profile = builtinEnvironmentProfiles[contract.environment]
        if (profile === undefined) {
          issues.push(
            issue({
              packageName: args.packageName,
              dependency: exportPath,
              message: `Unknown export environment "${contract.environment}".`,
              rule: 'package-json-export-environment-unknown',
            }),
          )
          continue
        }

        const exportEntry = args.exports[exportPath]
        if (exportEntry === undefined) continue

        const target = resolveExportTarget({ entry: exportEntry, profile })
        if (target === undefined) {
          issues.push(
            issue({
              packageName: args.packageName,
              dependency: exportPath,
              message: `Export "${exportPath}" has no target for environment "${contract.environment}" using conditions ${profile.conditions.join(', ')}.`,
              rule: 'package-json-export-environment-target',
            }),
          )
          continue
        }

        const entries = resolveTargetEntries({
          cwd: args.cwd,
          location: args.location,
          target,
        })
        if (entries.length === 0) {
          issues.push(
            issue({
              packageName: args.packageName,
              dependency: exportPath,
              message: `Export "${exportPath}" target does not exist: ${path.relative(args.cwd, path.resolve(args.cwd, args.location, target))}`,
              rule: 'package-json-export-environment-target-exists',
            }),
          )
          continue
        }

        for (const entry of entries) {
          const graph = scanGraph({
            entry,
            profile,
            packageName: args.packageName,
            exportPath,
          })
          issues.push(...graph.issues)

          const typecheckResult = typecheck({
            cwd: args.cwd,
            cacheRoot: proofCacheRoot,
            entry,
            files: graph.files,
            cacheInputs: [
              path.join(args.cwd, 'pnpm-lock.yaml'),
              path.join(args.cwd, 'package.json'),
              path.join(args.cwd, args.location, 'package.json'),
              path.join(args.cwd, args.location, 'tsconfig.json'),
            ],
            contract,
            profile,
            compiler: typeProofCompiler,
            packageName: args.packageName,
            exportPath,
          })
          hits += typecheckResult.cache.hits
          misses += typecheckResult.cache.misses
          issues.push(...typecheckResult.issues)
        }
      }
    }

    return {
      issues,
      durationMs: performance.now() - start,
      cache: { hits, misses },
    }
  },
})

/** Package-json-owned node validation runtime injected during Genie validation. */
export const nodePackageJsonValidationRuntime: PackageJsonValidationRuntime =
  createNodePackageJsonValidationRuntime()
