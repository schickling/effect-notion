/**
 * Normalized pnpm store assembly (decision 0030).
 *
 * Three modes replace the single per-importer closure assembly:
 *
 * - `entry` materializes one store entry: exactly one own-package copy plus
 *   relative metadata links to sibling entries. One entry exists per
 *   peer-resolved snapshot for the whole repository, so no dependency bytes are
 *   duplicated per consumer.
 * - `scc` assembles one strongly connected component in a single action. Every
 *   member keeps a distinct pnpm virtual-store namespace and back-edges are
 *   relative links between those namespaces.
 * - `view` materializes one importer's dependency view. A view contains only
 *   directories and symlinks; it never copies a dependency byte.
 *
 * Every link is relative, so a materialized tree survives relocation of its
 * common root. Containment is fail-closed: an undeclared, absolute, escaping,
 * or dangling target is rejected rather than materialized.
 *
 * This module is the sole pnpm materialization runner: the normalized store
 * replaced the per-importer closure assembly outright.
 */
import {
  copyFile,
  link,
  lstat,
  mkdir,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const fail = (message: string): never => {
  throw new Error(`pnpm store assembly: ${message}`)
}

const assertPortablePath = ({
  value,
  field,
}: {
  readonly value: string
  readonly field: string
}): string => {
  if (
    value.length === 0 ||
    value.includes('\\') === true ||
    value.includes('\0') === true ||
    isAbsolute(value) === true
  ) {
    fail(`${field} must be a non-empty portable relative path: ${JSON.stringify(value)}`)
  }
  if (
    value.split('/').some((component) => component === '' || component === '.' || component === '..')
  ) {
    fail(`${field} must be normalized: ${JSON.stringify(value)}`)
  }
  return value
}

const assertStoreKey = ({
  value,
  field,
}: {
  readonly value: string
  readonly field: string
}): string => {
  assertPortablePath({ value, field })
  if (value.includes('/') === true)
    fail(`${field} must be one virtual-store path component: ${value}`)
  return value
}

const isInside = ({
  root,
  candidate,
}: {
  readonly root: string
  readonly candidate: string
}): boolean => {
  const fromRoot = relative(root, candidate)
  return (
    fromRoot === '' ||
    (fromRoot.startsWith(`..${sep}`) === false &&
      fromRoot !== '..' &&
      isAbsolute(fromRoot) === false)
  )
}

/** Copies one declared tree, hardlinking files and preserving contained links. */
const materializeTree = async ({
  source,
  destination,
}: {
  readonly source: string
  readonly destination: string
}): Promise<void> => {
  const sourceRoot = await realpath(source)
  if ((await lstat(sourceRoot)).isDirectory() === false)
    fail(`source tree is not a directory: ${source}`)

  const visit = async ({
    currentSource,
    currentDestination,
  }: {
    readonly currentSource: string
    readonly currentDestination: string
  }): Promise<void> => {
    const metadata = await lstat(currentSource)
    if (metadata.isDirectory() === true) {
      await mkdir(currentDestination, { recursive: true })
      const entries = (await readdir(currentSource)).toSorted((left, right) =>
        Buffer.from(left).compare(Buffer.from(right)),
      )
      for (const entry of entries) {
        await visit({
          currentSource: join(currentSource, entry),
          currentDestination: join(currentDestination, entry),
        })
      }
      return
    }
    await mkdir(dirname(currentDestination), { recursive: true })
    if (metadata.isFile() === true) {
      try {
        await link(currentSource, currentDestination)
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'EXDEV') throw error
        await copyFile(currentSource, currentDestination)
      }
      return
    }
    if (metadata.isSymbolicLink() === true) {
      const target = await readlink(currentSource)
      if (isAbsolute(target) === true)
        fail(`source symlink has an absolute target: ${currentSource} -> ${target}`)
      if (isInside({ root: sourceRoot, candidate: resolve(dirname(currentSource), target) }) === false)
        fail(`source symlink target escapes its declared tree: ${currentSource} -> ${target}`)
      let canonicalTarget: string
      try {
        canonicalTarget = await realpath(currentSource)
      } catch (error) {
        if (error instanceof Error && 'code' in error) {
          if (error.code === 'ELOOP')
            fail(`source symlink target is cyclic: ${currentSource} -> ${target}`)
          if (error.code === 'ENOENT' || error.code === 'ENOTDIR')
            fail(`source symlink target is dangling: ${currentSource} -> ${target}`)
        }
        throw error
      }
      if (isInside({ root: sourceRoot, candidate: canonicalTarget }) === false)
        fail(`source symlink chained target escapes its declared tree: ${currentSource} -> ${target}`)
      await symlink(target, currentDestination)
      return
    }
    fail(`source tree contains an unsupported entry: ${currentSource}`)
  }

  await visit({ currentSource: sourceRoot, currentDestination: destination })
}
/**
 * Creates one relative symlink and proves its target exists within its declared
 * backing root. `containedIn` additionally bounds links owned by one artifact.
 */
const addRelativeLink = async ({
  containedIn,
  linkPath,
  targetPath,
  targetRoot,
}: {
  readonly containedIn: string | undefined
  readonly linkPath: string
  readonly targetPath: string
  readonly targetRoot: string
}): Promise<void> => {
  const absoluteLink = resolve(linkPath)
  const absoluteTarget = resolve(targetPath)
  if (
    containedIn !== undefined &&
    (isInside({ root: containedIn, candidate: absoluteLink }) === false ||
      isInside({ root: containedIn, candidate: absoluteTarget }) === false)
  ) {
    fail(`link escapes its assembled root: ${linkPath} -> ${targetPath}`)
  }
  let canonicalTarget: string
  try {
    canonicalTarget = await realpath(absoluteTarget)
  } catch (error) {
    if (error instanceof Error && 'code' in error) {
      if (error.code === 'ELOOP') fail(`link target is cyclic: ${linkPath} -> ${targetPath}`)
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR')
        fail(`link target is dangling: ${linkPath} -> ${targetPath}`)
    }
    throw error
  }
  const canonicalTargetRoot = await realpath(targetRoot)
  if (isInside({ root: canonicalTargetRoot, candidate: canonicalTarget }) === false)
    fail(`link target canonically escapes its declared tree: ${linkPath} -> ${targetPath}`)
  const target = relative(dirname(absoluteLink), absoluteTarget)
  if (target.length === 0 || isAbsolute(target) === true)
    fail(`could not form relative link: ${linkPath} -> ${targetPath}`)
  await mkdir(dirname(absoluteLink), { recursive: true })
  await symlink(target, absoluteLink)
}

const requireDeclaredTree = async ({
  field,
  path,
}: {
  readonly field: string
  readonly path: string
}): Promise<string> => {
  const metadata = await lstat(path).catch(() => undefined)
  if (metadata === undefined || metadata.isDirectory() === false)
    fail(`${field} names undeclared tree ${JSON.stringify(path)}`)
  return realpath(path)
}

const withStaging = async ({
  output,
  build,
}: {
  readonly output: string
  readonly build: (stage: string) => Promise<void>
}): Promise<void> => {
  const target = resolve(output)
  const stage = `${target}.stage-${process.pid}-${crypto.randomUUID()}`
  try {
    await mkdir(stage, { recursive: false })
    await build(stage)
    await rename(stage, target)
  } catch (error) {
    await rm(stage, { recursive: true, force: true })
    throw error
  }
}

/** A resolved link from an assembled namespace to a declared foreign entry. */
export type StoreEntryLink = {
  readonly entryDir: string
  readonly name: string
  readonly packageName: string
}

/** A nested `.bin` link derived from a declared dependency's own executables. */
export type StoreBinLink = StoreEntryLink & { readonly executable: string }

/** One normalized store entry: one own-package copy plus metadata edges. */
export type StoreEntryOptions = {
  readonly bins: readonly StoreBinLink[]
  readonly dependencies: readonly StoreEntryLink[]
  readonly output: string
  readonly packageName: string
  readonly packageTree: string
}

/**
 * Materializes one store entry below a literal `node_modules` ancestor.
 *
 * The own package is copied so `realpath` of
 * `<out>/node_modules/<packageName>` stays inside this entry and Node's
 * ancestor walk finds sibling dependency links in that same `node_modules`.
 */
export const assembleStoreEntry = async (options: StoreEntryOptions): Promise<void> => {
  assertPortablePath({ value: options.packageName, field: 'package name' })
  await withStaging({
    output: options.output,
    build: async (stage) => {
      const nodeModules = join(stage, 'node_modules')
      await materializeTree({
        source: options.packageTree,
        destination: join(nodeModules, options.packageName),
      })
      const seen = new Set<string>()
      for (const dependency of options.dependencies) {
        assertPortablePath({ value: dependency.name, field: 'dependency name' })
        assertPortablePath({ value: dependency.packageName, field: 'dependency package name' })
        if (seen.has(dependency.name) === true) fail(`duplicate dependency ${dependency.name}`)
        seen.add(dependency.name)
        const entryDir = await requireDeclaredTree({
          field: 'dependency',
          path: dependency.entryDir,
        })
        await addRelativeLink({
          containedIn: undefined,
          linkPath: join(nodeModules, dependency.name),
          targetPath: join(entryDir, dependency.packageName),
          targetRoot: entryDir,
        })
      }
      for (const bin of options.bins) {
        assertPortablePath({ value: bin.name, field: 'bin name' })
        assertPortablePath({ value: bin.executable, field: 'bin executable' })
        const entryDir = await requireDeclaredTree({ field: 'bin', path: bin.entryDir })
        await addRelativeLink({
          containedIn: undefined,
          linkPath: join(nodeModules, '.bin', bin.name),
          targetPath: join(entryDir, bin.packageName, bin.executable),
          targetRoot: entryDir,
        })
      }
    },
  })
}

/** One member of a strongly connected component and its own package bytes. */
export type SccMember = {
  readonly packageName: string
  readonly packageTree: string
  readonly storeKey: string
}

/** A back-edge between two members of the same component. */
export type SccInternalEdge = {
  readonly name: string
  readonly sourceStoreKey: string
  readonly targetStoreKey: string
}

/** An edge from one component member to a declared entry outside the group. */
export type SccExternalEdge = StoreEntryLink & { readonly sourceStoreKey: string }

/** A `.bin` link owned by one component member. */
export type SccBinEdge = {
  readonly executable: string
  readonly name: string
  readonly sourceStoreKey: string
  readonly targetStoreKey: string
}

/** A `.bin` link from one component member to an entry outside the group. */
export type SccExternalBinEdge = SccExternalEdge & { readonly executable: string }

/** Inputs for assembling one strongly connected component in one action. */
export type SccOptions = {
  readonly bins: readonly SccBinEdge[]
  readonly external: readonly SccExternalEdge[]
  readonly externalBins: readonly SccExternalBinEdge[]
  readonly internal: readonly SccInternalEdge[]
  readonly members: readonly SccMember[]
  readonly output: string
}

const memberNodeModules = ({
  root,
  storeKey,
}: {
  readonly root: string
  readonly storeKey: string
}): string => join(root, assertStoreKey({ value: storeKey, field: 'member key' }), 'node_modules')

/**
 * Assembles one component so its cycle resolves without breaking a package.
 *
 * Members keep distinct `<storeKey>/node_modules/<packageName>` namespaces, so
 * two members of one component never collide and never lose their identity.
 * Duplicate namespaces, an edge to an undeclared member, and an escaping or
 * absolute link are all rejected.
 */
export const assembleStoreScc = async (options: SccOptions): Promise<void> => {
  const members = new Map<string, SccMember>()
  for (const member of options.members) {
    assertStoreKey({ value: member.storeKey, field: 'member key' })
    assertPortablePath({ value: member.packageName, field: 'member package name' })
    if (members.has(member.storeKey) === true)
      fail(`duplicate member namespace ${member.storeKey}`)
    members.set(member.storeKey, member)
  }
  if (members.size < 1) fail('a component must declare at least one member')

  const requireMember = ({ field, storeKey }: { field: string; storeKey: string }): SccMember =>
    members.get(storeKey) ??
    fail(`${field} names ${JSON.stringify(storeKey)} which is outside the declared component`)

  await withStaging({
    output: options.output,
    build: async (stage) => {
      for (const member of [...members.values()].toSorted((left, right) =>
        left.storeKey < right.storeKey ? -1 : 1,
      )) {
        await materializeTree({
          source: member.packageTree,
          destination: join(
            memberNodeModules({ root: stage, storeKey: member.storeKey }),
            member.packageName,
          ),
        })
      }
      for (const edge of options.internal) {
        assertPortablePath({ value: edge.name, field: 'component edge name' })
        const source = requireMember({ field: 'component edge source', storeKey: edge.sourceStoreKey })
        const target = requireMember({ field: 'component edge target', storeKey: edge.targetStoreKey })
        await addRelativeLink({
          containedIn: stage,
          linkPath: join(memberNodeModules({ root: stage, storeKey: source.storeKey }), edge.name),
          targetPath: join(
            memberNodeModules({ root: stage, storeKey: target.storeKey }),
            target.packageName,
          ),
          targetRoot: stage,
        })
      }
      for (const edge of options.external) {
        assertPortablePath({ value: edge.name, field: 'external edge name' })
        assertPortablePath({ value: edge.packageName, field: 'external edge package name' })
        const source = requireMember({
          field: 'external edge source',
          storeKey: edge.sourceStoreKey,
        })
        const entryDir = await requireDeclaredTree({ field: 'external edge', path: edge.entryDir })
        await addRelativeLink({
          containedIn: undefined,
          linkPath: join(memberNodeModules({ root: stage, storeKey: source.storeKey }), edge.name),
          targetPath: join(entryDir, edge.packageName),
          targetRoot: entryDir,
        })
      }
      for (const bin of options.bins) {
        assertPortablePath({ value: bin.name, field: 'component bin name' })
        assertPortablePath({ value: bin.executable, field: 'component bin executable' })
        const source = requireMember({ field: 'component bin source', storeKey: bin.sourceStoreKey })
        const target = requireMember({ field: 'component bin target', storeKey: bin.targetStoreKey })
        await addRelativeLink({
          containedIn: stage,
          linkPath: join(
            memberNodeModules({ root: stage, storeKey: source.storeKey }),
            '.bin',
            bin.name,
          ),
          targetPath: join(
            memberNodeModules({ root: stage, storeKey: target.storeKey }),
            target.packageName,
            bin.executable,
          ),
          targetRoot: stage,
        })
      }
      for (const bin of options.externalBins) {
        assertPortablePath({ value: bin.name, field: 'external bin name' })
        assertPortablePath({ value: bin.executable, field: 'external bin executable' })
        const source = requireMember({ field: 'external bin source', storeKey: bin.sourceStoreKey })
        const entryDir = await requireDeclaredTree({ field: 'external bin', path: bin.entryDir })
        await addRelativeLink({
          containedIn: undefined,
          linkPath: join(
            memberNodeModules({ root: stage, storeKey: source.storeKey }),
            '.bin',
            bin.name,
          ),
          targetPath: join(entryDir, bin.packageName, bin.executable),
          targetRoot: entryDir,
        })
      }
    },
  })
}

/** A first-hop link from an importer view to a declared workspace tree. */
export type ViewWorkspaceLink = {
  readonly name: string
  readonly workspaceDir: string
}

/** Inputs for one metadata-only importer dependency view. */
export type StoreViewOptions = {
  readonly bins: readonly StoreBinLink[]
  readonly links: readonly StoreEntryLink[]
  readonly output: string
  readonly workspaceLinks: readonly ViewWorkspaceLink[]
}

/**
 * Materializes one importer dependency view from declared store entries.
 *
 * The view holds only directories and relative symlinks: the transitive closure
 * is reachable through each entry's own sibling links, so a consumer never
 * receives a second copy of a dependency.
 */
export const assembleStoreView = async (options: StoreViewOptions): Promise<void> => {
  await withStaging({
    output: options.output,
    build: async (stage) => {
      const seen = new Set<string>()
      const claim = (name: string): void => {
        if (seen.has(name) === true) fail(`duplicate view link ${name}`)
        seen.add(name)
      }
      for (const entry of options.links) {
        assertPortablePath({ value: entry.name, field: 'view link name' })
        assertPortablePath({ value: entry.packageName, field: 'view link package name' })
        claim(entry.name)
        const entryDir = await requireDeclaredTree({ field: 'view link', path: entry.entryDir })
        await addRelativeLink({
          containedIn: undefined,
          linkPath: join(stage, entry.name),
          targetPath: join(entryDir, entry.packageName),
          targetRoot: entryDir,
        })
      }
      for (const workspace of options.workspaceLinks) {
        assertPortablePath({ value: workspace.name, field: 'view workspace name' })
        claim(workspace.name)
        const workspaceDir = await requireDeclaredTree({
          field: 'view workspace',
          path: workspace.workspaceDir,
        })
        await addRelativeLink({
          containedIn: undefined,
          linkPath: join(stage, workspace.name),
          targetPath: workspaceDir,
          targetRoot: workspaceDir,
        })
      }
      for (const bin of options.bins) {
        assertPortablePath({ value: bin.name, field: 'view bin name' })
        assertPortablePath({ value: bin.executable, field: 'view bin executable' })
        const entryDir = await requireDeclaredTree({ field: 'view bin', path: bin.entryDir })
        await addRelativeLink({
          containedIn: undefined,
          linkPath: join(stage, '.bin', bin.name),
          targetPath: join(entryDir, bin.packageName, bin.executable),
          targetRoot: entryDir,
        })
      }
    },
  })
}

const takeArguments = ({
  args,
  count,
  flag,
  index,
}: {
  readonly args: readonly string[]
  readonly count: number
  readonly flag: string
  readonly index: number
}): readonly string[] => {
  const values = args.slice(index + 1, index + 1 + count)
  if (values.length !== count) fail(`${flag} requires ${count} value(s)`)
  return values
}

/**
 * Resolves the single declared source of one entry's package bytes.
 *
 * `--package-tree` is the hash-pinned registry extraction; `--package-override`
 * is an immutable absolute directory (a Nix-built native addon) that replaces
 * it for every importer of that one normalized entry. Declaring both, or
 * neither, is a projection bug rather than a runtime condition.
 */
const requirePackageSource = ({
  packageOverride,
  packageTree,
}: {
  readonly packageOverride: string | undefined
  readonly packageTree: string | undefined
}): string => {
  if (packageTree !== undefined && packageOverride !== undefined)
    fail('--package-tree and --package-override are mutually exclusive')
  if (packageOverride === undefined) return packageTree ?? fail('missing --package-tree')
  if (isAbsolute(packageOverride) === false)
    fail(`--package-override must be an absolute directory: ${JSON.stringify(packageOverride)}`)
  return packageOverride
}

/** Parses Buck action arguments and runs the selected store assembly mode. */
export const runStoreAssemblyCli = async (args: readonly string[]): Promise<void> => {
  let mode: string | undefined
  let output: string | undefined
  let packageName: string | undefined
  let packageOverride: string | undefined
  let packageTree: string | undefined
  const dependencies: StoreEntryLink[] = []
  const bins: StoreBinLink[] = []
  const links: StoreEntryLink[] = []
  const workspaceLinks: ViewWorkspaceLink[] = []
  const members: SccMember[] = []
  const internal: SccInternalEdge[] = []
  const external: SccExternalEdge[] = []
  const memberBins: SccBinEdge[] = []
  const memberExternalBins: SccExternalBinEdge[] = []

  for (let index = 0; index < args.length; ) {
    const flag = args[index]
    const take = (count: number): readonly string[] => {
      const values = takeArguments({ args, count, flag: flag ?? '', index })
      index += count + 1
      return values
    }
    if (flag === '--mode') mode = take(1)[0]
    else if (flag === '--output') output = take(1)[0]
    else if (flag === '--package-name') packageName = take(1)[0]
    else if (flag === '--package-tree') packageTree = take(1)[0]
    else if (flag === '--package-override') packageOverride = take(1)[0]
    else if (flag === '--dependency') {
      const [name, target, entryDir] = take(3) as [string, string, string]
      dependencies.push({ entryDir, name, packageName: target })
    } else if (flag === '--bin') {
      const [name, target, entryDir, executable] = take(4) as [string, string, string, string]
      bins.push({ entryDir, executable, name, packageName: target })
    } else if (flag === '--link') {
      const [name, target, entryDir] = take(3) as [string, string, string]
      links.push({ entryDir, name, packageName: target })
    } else if (flag === '--workspace-link') {
      const [name, workspaceDir] = take(2) as [string, string]
      workspaceLinks.push({ name, workspaceDir })
    } else if (flag === '--member') {
      const [storeKey, name, tree] = take(3) as [string, string, string]
      members.push({ packageName: name, packageTree: tree, storeKey })
    } else if (flag === '--member-dependency') {
      const [sourceStoreKey, name, targetStoreKey] = take(3) as [string, string, string]
      internal.push({ name, sourceStoreKey, targetStoreKey })
    } else if (flag === '--member-external') {
      const [sourceStoreKey, name, target, entryDir] = take(4) as [string, string, string, string]
      external.push({ entryDir, name, packageName: target, sourceStoreKey })
    } else if (flag === '--member-bin') {
      const [sourceStoreKey, name, targetStoreKey, executable] = take(4) as [
        string,
        string,
        string,
        string,
      ]
      memberBins.push({ executable, name, sourceStoreKey, targetStoreKey })
    } else if (flag === '--member-external-bin') {
      const [sourceStoreKey, name, target, entryDir, executable] = take(5) as [
        string,
        string,
        string,
        string,
        string,
      ]
      memberExternalBins.push({
        entryDir,
        executable,
        name,
        packageName: target,
        sourceStoreKey,
      })
    } else {
      fail(`unknown argument ${JSON.stringify(flag)}`)
    }
  }

  const requiredOutput = output ?? fail('missing --output')
  if (mode === 'entry') {
    await assembleStoreEntry({
      bins,
      dependencies,
      output: requiredOutput,
      packageName: packageName ?? fail('missing --package-name'),
      packageTree: requirePackageSource({ packageOverride, packageTree }),
    })
    return
  }
  if (mode === 'scc') {
    await assembleStoreScc({
      bins: memberBins,
      externalBins: memberExternalBins,
      external,
      internal,
      members,
      output: requiredOutput,
    })
    return
  }
  if (mode === 'view') {
    await assembleStoreView({ bins, links, output: requiredOutput, workspaceLinks })
    return
  }
  fail(`--mode must be one of entry, scc, view: ${JSON.stringify(mode)}`)
}

if (import.meta.main === true) {
  try {
    await runStoreAssemblyCli(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
