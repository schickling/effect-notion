import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

type PolicyManifest = {
  readonly declaredPackages: readonly string[]
  readonly sourcePaths: readonly string[]
}

const assetImport = /^\s*import\s+['"][^'"]*\.(?:css|less|sass|scss)['"]/mu
const travellingReference = /^\s*\/\/\/\s*<reference\s/mu
const excludedAssetSource = /(?:\/\.storybook\/|\.gen\.|\.d\.ts$|\.test\.|\.stories\.)/u
const compiledSource = /^(?:context\/.*|packages\/.*\/src\/.*)\.tsx?$/u
const directPackageManifest = /^packages\/@overeng\/[^/]+\/package\.json$/u

/** Validate repository source policy against the declared Buck snapshot. */
export const checkRepositoryPolicy = async ({
  manifest,
  sourceRoot,
}: {
  readonly manifest: PolicyManifest
  readonly sourceRoot: string
}): Promise<{ readonly checkedAssetSources: number; readonly declaredPackages: number }> => {
  const sourcePaths = [...manifest.sourcePaths].toSorted()
  const assetSources = sourcePaths.filter(
    (sourcePath) =>
      compiledSource.test(sourcePath) && excludedAssetSource.test(sourcePath) === false,
  )
  const assetOffenders: string[] = []
  for (const sourcePath of assetSources) {
    const source = readFileSync(path.join(sourceRoot, sourcePath), 'utf8')
    if (assetImport.test(source) === true && travellingReference.test(source) === false) {
      assetOffenders.push(sourcePath)
    }
  }
  const sourcePathSet = new Set(sourcePaths)

  const generatedCoverageMissing = sourcePaths
    .filter(
      (sourcePath) =>
        sourcePath.startsWith('packages/') &&
        (path.posix.basename(sourcePath) === 'package.json' ||
          path.posix.basename(sourcePath) === 'tsconfig.json'),
    )
    .filter((sourcePath) => sourcePathSet.has(`${sourcePath}.genie.ts`) === false)

  const declaredPackages = [...manifest.declaredPackages].toSorted()
  const actualDirectPackages = sourcePaths
    .filter((sourcePath) => directPackageManifest.test(sourcePath))
    .map((sourcePath) => path.posix.dirname(sourcePath))
    .toSorted()
  const declaredDirectPackages = declaredPackages
    .filter((packagePath) => /^packages\/@overeng\/[^/]+$/u.test(packagePath))
    .toSorted()
  const declaredDirectPackageSet = new Set(declaredDirectPackages)
  const missingPackages = actualDirectPackages.filter(
    (packagePath) => declaredDirectPackageSet.has(packagePath) === false,
  )
  const nonexistentPackages = declaredPackages.filter(
    (packagePath) => sourcePathSet.has(`${packagePath}/package.json`) === false,
  )

  const failures = [
    ...(assetOffenders.length === 0
      ? []
      : [
          `Asset side-effect imports lack travelling type references:\n${assetOffenders.join('\n')}`,
        ]),
    ...(generatedCoverageMissing.length === 0
      ? []
      : [`Generated configuration sources are missing:\n${generatedCoverageMissing.join('\n')}`]),
    ...(missingPackages.length === 0
      ? []
      : [
          `Workspace packages are absent from the authority registry:\n${missingPackages.join('\n')}`,
        ]),
    ...(nonexistentPackages.length === 0
      ? []
      : [`Authority registry packages have no package.json:\n${nonexistentPackages.join('\n')}`]),
  ]
  if (failures.length > 0) throw new Error(failures.join('\n\n'))
  return { checkedAssetSources: assetSources.length, declaredPackages: declaredPackages.length }
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      manifest: { type: 'string' },
      output: { type: 'string' },
      source: { type: 'string' },
    },
    strict: true,
  })
  if (values.manifest === undefined) throw new Error('missing --manifest')
  if (values.output === undefined) throw new Error('missing --output')
  if (values.source === undefined) throw new Error('missing --source')
  const manifest = (await Bun.file(values.manifest).json()) as PolicyManifest
  const summary = await checkRepositoryPolicy({ manifest, sourceRoot: values.source })
  await Bun.write(
    values.output,
    `${JSON.stringify({ schema: 'effect-utils/repository-policy/v1', status: 'passed', ...summary }, null, 2)}\n`,
  )
}
