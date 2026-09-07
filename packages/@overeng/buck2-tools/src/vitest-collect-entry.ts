/**
 * Suite-enumeration entrypoint of one `vitest_collect` action.
 *
 * `vitest list` cannot be used directly: its CLI closes the Vitest context but, unlike
 * `vitest run`, never calls `exit()`, so a project whose config plugins keep a handle open writes
 * the artifact and then keeps the action alive forever. This entry drives the same public Vitest
 * node API the CLI drives, writes the same `{name, file}` records, and owns the exit, so a
 * declared build output always comes from an action that terminates.
 *
 * It runs under pinned Bun or the lane's declared Node (Node executes TypeScript directly), so
 * Vitest is resolved from the package view rather than from this file's location in the runner
 * tree, and the suite is imported by the same runtime that runs it.
 */
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** The Vitest node-API surface this entry drives, as `vitest/node` exposes it at runtime. */
type CollectedTest = {
  readonly fullName: string
  readonly module: { readonly moduleId: string }
  readonly result: () => { readonly state: string }
}

type CollectedModule = {
  readonly children: { readonly allTests: () => Iterable<CollectedTest> }
}

type VitestContext = {
  readonly collect: (filters: readonly string[]) => Promise<{
    readonly testModules: readonly CollectedModule[]
    readonly unhandledErrors: readonly unknown[]
  }>
  readonly close: () => Promise<void>
}

type VitestNodeApi = {
  readonly createVitest: (
    mode: string,
    options: Readonly<Record<string, unknown>>,
  ) => Promise<VitestContext>
}

const fail = (message: string): never => {
  throw new Error(`vitest collect: ${message}`)
}

type UnnormalizedCollectionEntry = {
  readonly file: string
  readonly name: string
}

/**
 * Converts Vitest's absolute module id to the artifact's stable package-relative POSIX path.
 *
 * The package tree is the declared action input and therefore the only admissible root. The
 * executor-specific prefix must never enter a cacheable artifact.
 */
export const normalizeCollectionFile = ({
  moduleId,
  packageTree,
}: {
  readonly moduleId: string
  readonly packageTree: string
}): string => {
  if (isAbsolute(moduleId) === false) {
    return fail(`test module path is not absolute: ${moduleId}`)
  }
  const fromPackageTree = relative(resolve(packageTree), moduleId)
  if (
    fromPackageTree.length === 0 ||
    isAbsolute(fromPackageTree) === true ||
    fromPackageTree === '..' ||
    fromPackageTree.startsWith(`..${sep}`) === true
  ) {
    return fail(`test module is outside the package tree: ${moduleId}`)
  }
  const portable = fromPackageTree.split(sep).join('/')
  if (
    portable.includes('\\') === true ||
    portable
      .split('/')
      .some((component) => component.length === 0 || component === '.' || component === '..') ===
      true
  ) {
    return fail(`test module path is not a normalized package-relative POSIX path: ${moduleId}`)
  }
  return portable
}

/** Serializes collection entries without executor-specific package-tree prefixes. */
export const collectionArtifactBytes = ({
  entries,
  packageTree,
}: {
  readonly entries: readonly UnnormalizedCollectionEntry[]
  readonly packageTree: string
}): string =>
  `${JSON.stringify(
    entries.map(({ file, name }) => ({
      file: normalizeCollectionFile({ moduleId: file, packageTree }),
      name,
    })),
    null,
    2,
  )}\n`

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2)
  const packageTree = resolve(argv[0] ?? fail('missing package tree'))
  const config = argv[1] ?? fail('missing config')
  const output = resolve(argv[2] ?? fail('missing output path'))
  const tests: string[] = []
  const excludes: string[] = []
  let index = 3
  while (index < argv.length) {
    const flag = argv[index]
    const value = argv[index + 1] ?? fail(`missing value for ${String(flag)}`)
    if (flag === '--test') tests.push(value)
    else if (flag === '--exclude') excludes.push(value)
    else fail(`unexpected argument: ${String(flag)}`)
    index += 2
  }

  // Exactly what `prepareVitest` sets before creating the context; a suite may branch on them
  // while it is being imported, so collection must observe the same environment as the run.
  process.env['TEST'] = 'true'
  process.env['VITEST'] = 'true'
  process.env['NODE_ENV'] ??= 'test'

  // The specifier is genuinely runtime-selected: this file lives in the Buck runner tree, which
  // declares no dependencies, and the Vitest that must enumerate the suite is the one inside the
  // lane's own package view. A static import would resolve against the runner tree and find none.
  const require = createRequire(join(packageTree, 'package.json'))
  // oxlint-disable-next-line eslint-plugin-import(no-dynamic-require) -- the enumerating Vitest lives in the lane's package view, resolved at runtime
  const api = (await import(pathToFileURL(require.resolve('vitest/node')).href)) as VitestNodeApi

  const context = await api.createVitest('list', {
    root: packageTree,
    config: join(packageTree, config),
    // Vite's default `bundle` config loader materializes the bundled config inside the read-only
    // package view; the module runner keeps config loading in memory instead.
    configLoader: 'runner',
    watch: false,
    run: true,
    cliExclude: excludes,
  })

  const { testModules, unhandledErrors } = await context.collect(tests)
  if (unhandledErrors.length > 0) {
    for (const error of unhandledErrors) console.error(error)
    await context.close()
    console.error('vitest collect: unhandled errors during test collection')
    process.exit(1)
  }

  // The same records `vitest list --json` writes, except `file` is normalized against the
  // declared package tree so cacheable bytes do not depend on the executor.
  const collected = testModules.flatMap((testModule) =>
    [...testModule.children.allTests()]
      .filter((test) => test.result().state !== 'skipped')
      .map((test) => ({ file: test.module.moduleId, name: test.fullName })),
  )
  await writeFile(output, collectionArtifactBytes({ entries: collected, packageTree }))
  await context.close()
  process.exit(0)
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  await main()
}
