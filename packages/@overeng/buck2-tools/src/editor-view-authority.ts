import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstatSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { workspaceDependencyAuthoritySchema } from './editor-view.ts'
import type { WorkspaceDependencyAuthority } from './editor-view.ts'
import {
  parseBuckOwnershipQuery,
  parseGitCandidatePaths,
  requireRepositoryRelativePath,
} from './owned-files.ts'
import { canonicalizeParent } from './real-path.ts'

type CommandInvocation = {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
}

type CommandResult = {
  readonly status: number | null
  readonly stdout: Uint8Array
  readonly stderr: Uint8Array
}

/** Injectable command boundary for focused authority-census tests. */
export type EditorViewAuthorityCommandRunner = (invocation: CommandInvocation) => CommandResult

/** Inputs joining the semantic package registry to Buck's ownership census. */
export type WriteEditorViewAuthorityOptions = {
  readonly repoRoot: string
  readonly workspaceRoot: string
  readonly requiredPackages: readonly string[]
  readonly cell: string
  readonly buck2: string
  readonly git: string
  readonly output: string
  readonly runCommand?: EditorViewAuthorityCommandRunner
}

const fail = (message: string): never => {
  throw new Error(`editor view authority: ${message}`)
}

const compareBytes = ({ left, right }: { left: string; right: string }): number =>
  Buffer.from(left).compare(Buffer.from(right))

const isUnknownArray = (value: unknown): value is readonly unknown[] =>
  Array.isArray(value) === true

const requirePackagePaths = (value: unknown): readonly string[] => {
  const entries =
    isUnknownArray(value) === true
      ? value
      : fail('editor consumer admission registry must be an array')
  const paths = entries.map((entry) => {
    if (entry === '.') return entry
    return typeof entry === 'string'
      ? requireRepositoryRelativePath(entry)
      : fail('editor consumer admission registry contains a non-string package path')
  })
  if (paths.length === 0) fail('editor consumer admission registry must not be empty')
  const sorted = paths.toSorted((left, right) => compareBytes({ left, right }))
  if (new Set(sorted).size !== sorted.length)
    fail('editor consumer admission registry repeats a package path')
  return sorted
}

const runCommandDefault: EditorViewAuthorityCommandRunner = ({ command, args, cwd }) => {
  const result = spawnSync(command, args, { cwd, maxBuffer: 16 * 1024 * 1024 })
  if (result.error !== undefined) fail(`cannot run ${command}: ${result.error.message}`)
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

const requireCommandSuccess = ({
  command,
  result,
}: {
  readonly command: string
  readonly result: CommandResult
}): void => {
  if (result.status === 0) return
  const stderr = Buffer.from(result.stderr).toString('utf8').trim()
  fail(
    `${command} exited ${result.status === null ? 'without a status' : result.status}${stderr === '' ? '' : `: ${stderr}`}`,
  )
}

const writeAuthorityAtomically = ({
  output,
  authority,
}: {
  output: string
  authority: WorkspaceDependencyAuthority
}): void => {
  const parent = dirname(output)
  const parentStatus = lstatSync(parent)
  if (parentStatus.isDirectory() === false || parentStatus.isSymbolicLink() === true)
    fail(`output parent must be a real directory: ${parent}`)
  if (realpathSync(parent) !== parent) fail(`output parent path contains symbolic links: ${parent}`)
  const candidate = `${output}.candidate-${randomUUID().replaceAll('-', '')}`
  try {
    writeFileSync(candidate, `${JSON.stringify(authority, undefined, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    })
    renameSync(candidate, output)
  } finally {
    rmSync(candidate, { force: true })
  }
}

/** Derive and atomically publish exact whole-workspace Buck dependency authority. */
export const writeEditorViewAuthority = async ({
  repoRoot,
  workspaceRoot,
  requiredPackages: rawRequiredPackages,
  cell,
  buck2,
  git,
  output,
  runCommand = runCommandDefault,
}: WriteEditorViewAuthorityOptions): Promise<WorkspaceDependencyAuthority> => {
  if (/^[A-Za-z0-9_]+$/.test(cell) === false)
    fail(`cell must be a portable Buck cell name: ${cell}`)
  if (isAbsolute(buck2) === false) fail(`Buck2 must be an absolute path: ${buck2}`)
  if (isAbsolute(git) === false) fail(`Git must be an absolute path: ${git}`)
  const logicalRepoRoot = resolve(repoRoot)
  const logicalWorkspaceRoot = resolve(workspaceRoot)
  const canonicalRepoRoot = realpathSync(logicalRepoRoot)
  // `output` may arrive as an absolute path in a different namespace than the
  // canonical repository root (macOS `/tmp` vs `/private/tmp`), in which case
  // `resolve` returns it unchanged and the containment check below compares two
  // namespaces. Canonicalize it, and publish through the canonical form so the
  // atomic rename lands in the directory the containment check admitted.
  const outputPath = canonicalizeParent(resolve(canonicalRepoRoot, output))
  const outputFromRepo = relative(canonicalRepoRoot, outputPath)
  if (
    isAbsolute(outputFromRepo) === true ||
    outputFromRepo === '..' ||
    outputFromRepo.startsWith('../') === true
  )
    fail(`authority output escapes repository: ${outputPath}`)
  const pathFromWorkspace = relative(logicalWorkspaceRoot, logicalRepoRoot)
  if (
    isAbsolute(pathFromWorkspace) === true ||
    pathFromWorkspace === '..' ||
    pathFromWorkspace.startsWith('../') === true
  )
    fail(`repository root is outside workspace root: ${canonicalRepoRoot}`)
  const repoPrefix =
    pathFromWorkspace === '' ? '' : `${requireRepositoryRelativePath(pathFromWorkspace)}/`
  const requiredPackages = requirePackagePaths(rawRequiredPackages)

  const gitResult = runCommand({
    command: git,
    args: ['ls-files', '--cached', '-z', '--', ':(glob)**/package.json'],
    cwd: canonicalRepoRoot,
  })
  requireCommandSuccess({ command: git, result: gitResult })
  const trackedPaths = new Set(parseGitCandidatePaths(gitResult.stdout))
  const repositoryPackageManifests = requiredPackages.map((packagePath) =>
    packagePath === '.' ? 'package.json' : `${packagePath}/package.json`,
  )
  for (const manifest of repositoryPackageManifests)
    if (trackedPaths.has(manifest) === false)
      fail(`required editor consumer manifest is not tracked: ${manifest}`)
  const candidates = repositoryPackageManifests.map((path) => `${repoPrefix}${path}`)
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'editor-view-authority-'))
  const argumentFile = join(temporaryDirectory, 'package-manifests')
  try {
    writeFileSync(argumentFile, `${candidates.join('\n')}\n`, { mode: 0o600 })
    const ownershipResult = runCommand({
      command: buck2,
      args: ['uquery', '--output-format', 'json', 'owner(%s)', `@${argumentFile}`],
      cwd: logicalWorkspaceRoot,
    })
    requireCommandSuccess({ command: buck2, result: ownershipResult })
    const ownersByCandidate = parseBuckOwnershipQuery({
      candidates,
      stdout: ownershipResult.stdout,
    })
    const ownedPackages = requiredPackages.filter((packagePath, index) => {
      const candidate = candidates[index] ?? fail(`missing ownership candidate for ${packagePath}`)
      const owners =
        ownersByCandidate.get(candidate) ?? fail(`missing Buck ownership for ${candidate}`)
      const expectedOwner =
        packagePath === '.' ? `${cell}//:package.json` : `${cell}//${packagePath}:package.json`
      return owners.includes(expectedOwner)
    })
    const missing = requiredPackages.filter(
      (packagePath) => ownedPackages.includes(packagePath) === false,
    )
    if (missing.length > 0)
      fail(
        `whole-workspace dependency authority mismatch: missing=${JSON.stringify(missing)} extra=[]`,
      )
    const authority: WorkspaceDependencyAuthority = {
      schema: workspaceDependencyAuthoritySchema,
      requiredPackages,
      ownedPackages,
    }
    writeAuthorityAtomically({ output: outputPath, authority })
    return authority
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}
