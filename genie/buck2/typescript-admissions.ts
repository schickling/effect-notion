import { pnpmWorkspaceMemberPaths } from '../packages.ts'
import { buck2TypeScriptAdmission as effectSocketAdmission } from '../../context/effect/socket/BUCK.genie.ts'
import { buck2TypeScriptAdmission as opentuiAdmission } from '../../context/opentui/BUCK.genie.ts'
import { buck2TypeScriptAdmission as agentSessionIngestAdmission } from '../../packages/@overeng/agent-session-ingest/BUCK.genie.ts'
import { buck2TypeScriptAdmission as buck2ToolsAdmission } from '../../packages/@overeng/buck2-tools/BUCK.genie.ts'
import { buck2TypeScriptAdmission as ciToolsAdmission } from '../../packages/@overeng/ci-tools/BUCK.genie.ts'
import { buck2TypeScriptAdmission as contentAddressAdmission } from '../../packages/@overeng/content-address/BUCK.genie.ts'
import { buck2TypeScriptAdmission as effectAiClaudeCliAdmission } from '../../packages/@overeng/effect-ai-claude-cli/BUCK.genie.ts'
import { buck2TypeScriptAdmission as effectDistributedLockAdmission } from '../../packages/@overeng/effect-distributed-lock/BUCK.genie.ts'
import { buck2TypeScriptAdmission as effectPathAdmission } from '../../packages/@overeng/effect-path/BUCK.genie.ts'
import { buck2TypeScriptAdmission as effectReactAdmission } from '../../packages/@overeng/effect-react/BUCK.genie.ts'
import { buck2TypeScriptAdmission as effectRpcTanstackAdmission } from '../../packages/@overeng/effect-rpc-tanstack/BUCK.genie.ts'
import { buck2TypeScriptAdmission as effectRpcTanstackBasicAdmission } from '../../packages/@overeng/effect-rpc-tanstack/examples/basic/BUCK.genie.ts'
import { buck2TypeScriptAdmission as effectSchemaFormAriaAdmission } from '../../packages/@overeng/effect-schema-form-aria/BUCK.genie.ts'
import { buck2TypeScriptAdmission as effectSchemaFormAdmission } from '../../packages/@overeng/effect-schema-form/BUCK.genie.ts'
import { buck2TypeScriptAdmission as genieAdmission } from '../../packages/@overeng/genie/BUCK.genie.ts'
import { buck2TypeScriptAdmission as kdlEffectAdmission } from '../../packages/@overeng/kdl-effect/BUCK.genie.ts'
import { buck2TypeScriptAdmission as kdlAdmission } from '../../packages/@overeng/kdl/BUCK.genie.ts'
import { buck2TypeScriptAdmission as megarepoAdmission } from '../../packages/@overeng/megarepo/BUCK.genie.ts'
import { buck2TypeScriptAdmission as notionCliAdmission } from '../../packages/@overeng/notion-cli/BUCK.genie.ts'
import { buck2TypeScriptAdmission as notionCoreAdmission } from '../../packages/@overeng/notion-core/BUCK.genie.ts'
import { buck2TypeScriptAdmission as notionDatasourceSyncAdmission } from '../../packages/@overeng/notion-datasource-sync/BUCK.genie.ts'
import { buck2TypeScriptAdmission as notionEffectClientAdmission } from '../../packages/@overeng/notion-effect-client/BUCK.genie.ts'
import { buck2TypeScriptAdmission as notionEffectSchemaAdmission } from '../../packages/@overeng/notion-effect-schema/BUCK.genie.ts'
import { buck2TypeScriptAdmission as notionMdAdmission } from '../../packages/@overeng/notion-md/BUCK.genie.ts'
import { buck2TypeScriptAdmission as notionPropertyWriteAdmission } from '../../packages/@overeng/notion-property-write/BUCK.genie.ts'
import { buck2TypeScriptAdmission as notionReactAdmission } from '../../packages/@overeng/notion-react/BUCK.genie.ts'
import { buck2TypeScriptAdmission as npmReleaseAdmission } from '../../packages/@overeng/npm-release/BUCK.genie.ts'
import { buck2TypeScriptAdmission as otelContractAdmission } from '../../packages/@overeng/otel-contract/BUCK.genie.ts'
import { buck2TypeScriptAdmission as oxcConfigAdmission } from '../../packages/@overeng/oxc-config/BUCK.genie.ts'
import { buck2TypeScriptAdmission as ptyEffectAdmission } from '../../packages/@overeng/pty-effect/BUCK.genie.ts'
import { buck2TypeScriptAdmission as reactInspectorAdmission } from '../../packages/@overeng/react-inspector/BUCK.genie.ts'
import { buck2TypeScriptAdmission as restateEffectAdmission } from '../../packages/@overeng/restate-effect/BUCK.genie.ts'
import { buck2TypeScriptAdmission as stylexTokensAdmission } from '../../packages/@overeng/stylex-tokens/BUCK.genie.ts'
import { buck2TypeScriptAdmission as tuiCoreAdmission } from '../../packages/@overeng/tui-core/BUCK.genie.ts'
import { buck2TypeScriptAdmission as tuiReactAdmission } from '../../packages/@overeng/tui-react/BUCK.genie.ts'
import { buck2TypeScriptAdmission as tuiStoriesAdmission } from '../../packages/@overeng/tui-stories/BUCK.genie.ts'
import { buck2TypeScriptAdmission as utilsDevAdmission } from '../../packages/@overeng/utils-dev/BUCK.genie.ts'
import { buck2TypeScriptAdmission as utilsAdmission } from '../../packages/@overeng/utils/BUCK.genie.ts'
import {
  buck2TestCollectionTargetSuffix,
  discoverCollectableTestModules,
} from './typescript-package-projection.ts'
import type {
  Buck2TypeScriptPackageProjection,
  Buck2TypeScriptPackageTestTarget,
  Buck2TypeScriptProjectAuthorityMetadata,
} from './typescript-package-projection.ts'

export type { Buck2TypeScriptProjectAuthorityMetadata } from './typescript-package-projection.ts'

const compareAuthorityStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

/** Buck TypeScript projection input. Every admitted workspace package receives an editor view. */
export type Buck2TypeScriptAdmission = Buck2TypeScriptPackageProjection

/** Derived command and root-project data for every Buck-authoritative TypeScript project. */
export type AuthoritativeBuck2TypeScriptProject = Buck2TypeScriptProjectAuthorityMetadata & {
  readonly packagePath: string
  readonly projectPath: string
  readonly typecheckTarget: `//${string}:${string}`
}

/** Declaration-producing subset consumed by the dist publisher and member manifest. */
export type AuthoritativeBuck2TypeScriptDeclaration = AuthoritativeBuck2TypeScriptProject & {
  readonly declarationEntrypoint: string
  readonly distTarget: `//${string}:dist`
}

/** Semantic registry for every package admitted to the Buck TypeScript projection. */
export const buck2TypeScriptAdmissions = {
  effectSocket: effectSocketAdmission,
  opentui: opentuiAdmission,
  agentSessionIngest: agentSessionIngestAdmission,
  buck2Tools: buck2ToolsAdmission,
  ciTools: ciToolsAdmission,
  contentAddress: contentAddressAdmission,
  effectAiClaudeCli: effectAiClaudeCliAdmission,
  effectDistributedLock: effectDistributedLockAdmission,
  effectPath: effectPathAdmission,
  effectReact: effectReactAdmission,
  effectRpcTanstack: effectRpcTanstackAdmission,
  effectRpcTanstackBasic: effectRpcTanstackBasicAdmission,
  effectSchemaForm: effectSchemaFormAdmission,
  effectSchemaFormAria: effectSchemaFormAriaAdmission,
  genie: genieAdmission,
  kdl: kdlAdmission,
  kdlEffect: kdlEffectAdmission,
  megarepo: megarepoAdmission,
  notionCli: notionCliAdmission,
  notionCore: notionCoreAdmission,
  notionDatasourceSync: notionDatasourceSyncAdmission,
  notionEffectClient: notionEffectClientAdmission,
  notionEffectSchema: notionEffectSchemaAdmission,
  notionMd: notionMdAdmission,
  notionPropertyWrite: notionPropertyWriteAdmission,
  notionReact: notionReactAdmission,
  npmRelease: npmReleaseAdmission,
  otelContract: otelContractAdmission,
  oxcConfig: oxcConfigAdmission,
  ptyEffect: ptyEffectAdmission,
  reactInspector: reactInspectorAdmission,
  restateEffect: restateEffectAdmission,
  stylexTokens: stylexTokensAdmission,
  tuiCore: tuiCoreAdmission,
  tuiReact: tuiReactAdmission,
  tuiStories: tuiStoriesAdmission,
  utils: utilsAdmission,
  utilsDev: utilsDevAdmission,
} as const satisfies Record<string, Buck2TypeScriptAdmission>

/** Derives labels and project identity rather than duplicating them in package-local metadata. */
export const deriveBuck2TypeScriptAuthority = ({
  authority,
  packagePath,
}: Pick<Buck2TypeScriptAdmission, 'packagePath'> & {
  readonly authority: Buck2TypeScriptProjectAuthorityMetadata
}): AuthoritativeBuck2TypeScriptProject => {
  const projectPath = authority.projectPath ?? packagePath
  const typecheckTargetName =
    authority.typecheckTargetName ?? (projectPath === packagePath ? 'typecheck' : undefined)
  if (typecheckTargetName === undefined) {
    throw new Error(`Additional TypeScript project ${projectPath} must name its typecheck target`)
  }
  return {
    ...authority,
    packagePath,
    projectPath,
    typecheckTarget: `//${packagePath}:${typecheckTargetName}`,
  }
}

/** Registry-ordered root projects whose TypeScript checking is Buck-owned. */
export const authoritativeBuck2TypeScriptProjects: readonly AuthoritativeBuck2TypeScriptProject[] =
  Object.values(buck2TypeScriptAdmissions).flatMap(
    (admission: Buck2TypeScriptAdmission): readonly AuthoritativeBuck2TypeScriptProject[] =>
      admission.authorities.map((authority) =>
        deriveBuck2TypeScriptAuthority({
          authority,
          packagePath: admission.packagePath,
        }),
      ),
  )

/** Projects whose authority includes one published declaration surface. */
export const authoritativeBuck2TypeScriptDeclarations: readonly AuthoritativeBuck2TypeScriptDeclaration[] =
  authoritativeBuck2TypeScriptProjects.flatMap((project) =>
    project.declarationEntrypoint === undefined
      ? []
      : [
          {
            ...project,
            declarationEntrypoint: project.declarationEntrypoint,
            distTarget: `//${project.packagePath}:dist`,
          },
        ],
  )

/** Dist overlays derived from the declaration-producing project subset. */
export const buck2TypeScriptDistOverlays = authoritativeBuck2TypeScriptDeclarations
  .map(({ distTarget, packagePath }) => ({
    target: distTarget,
    destination: `${packagePath}/dist`,
  }))
  .toSorted((left, right) => compareAuthorityStrings(left.destination, right.destination))

/** Cell every generated bridge label is qualified with; Buck resolves nothing relative. */
const buck2Cell = 'effect_utils'
/** Target name of a package's default lane; it carries the unsuffixed task name. */
const defaultTestTargetName = 'test'

/**
 * One declared test lane resolved to the labels and task names its consumers address.
 *
 * This is a projection of the package-local declarations, never a second registry: a lane
 * exists here because some `BUCK.genie.ts` declares it, and its Buck labels are the ones the
 * same declaration renders.
 */
export type Buck2TestLane = {
  /** Fully qualified inventory label; only Vitest lanes have one. */
  readonly collectionTarget?: string
  /** Package-relative paths removed from the lane's Buck selection. */
  readonly excludes: readonly string[]
  /** Devenv package slug — the last segment of `packagePath`, which names its task. */
  readonly packageName: string
  readonly packagePath: string
  readonly runner: Buck2TypeScriptPackageTestTarget['runner']
  /** Explicit source task for exceptional unbounded files. */
  readonly sourceOwners: Readonly<Record<string, string>>
  /** Full package test census staged into the lane's package tree. */
  readonly testFiles: readonly string[]
  /** Package-relative files selected before the lane's excludes apply. */
  readonly selectedTestFiles: readonly string[]
  /** Fully qualified execution label. */
  readonly target: string
  /** Devenv task that owns this lane's bounded execution. */
  readonly taskName: string
  /** Additional ordering of the derived unbounded complement task. */
  readonly unboundedAfter: readonly string[]
  /** Exact files owned by the derived unbounded complement task. */
  readonly unboundedFiles: readonly string[]
  /** Derived complement task; absent when every unbounded file has an explicit owner. */
  readonly unboundedTaskName?: string
}

/** Resolves one declared lane of one admitted package into its addressable form. */
export const deriveBuck2TestLane = ({
  packagePath,
  target,
  testFiles,
}: {
  readonly packagePath: string
  readonly target: Buck2TypeScriptPackageTestTarget
  readonly testFiles: readonly string[]
}): Buck2TestLane => {
  const packageName = packagePath.slice(packagePath.lastIndexOf('/') + 1)
  const taskName =
    target.name === defaultTestTargetName
      ? `test:${packageName}`
      : `test:${packageName}:${target.name}`
  const orderedTestFiles = [...testFiles].toSorted(compareAuthorityStrings)
  const requestedTestFiles =
    target.testFiles === undefined || target.testFiles.length === 0
      ? orderedTestFiles
      : target.testFiles
  const selectedTestFiles = [...requestedTestFiles].toSorted(compareAuthorityStrings)
  const excludes = [...(target.excludes ?? [])].toSorted(compareAuthorityStrings)
  const sourceOwners = Object.fromEntries(
    Object.entries(target.sourceOwners ?? {}).toSorted(([left], [right]) =>
      compareAuthorityStrings(left, right),
    ),
  )
  if (new Set(orderedTestFiles).size !== orderedTestFiles.length) {
    throw new Error(`${packagePath}:${target.name} test census contains a duplicate`)
  }
  if (new Set(selectedTestFiles).size !== selectedTestFiles.length) {
    throw new Error(`${packagePath}:${target.name} test selection contains a duplicate`)
  }
  if (new Set(excludes).size !== excludes.length) {
    throw new Error(`${packagePath}:${target.name} excludes contain a duplicate`)
  }
  const testFileSet = new Set(orderedTestFiles)
  for (const file of selectedTestFiles) {
    if (testFileSet.has(file) === false) {
      throw new Error(
        `${packagePath}:${target.name} selects ${file}, which is outside its test census`,
      )
    }
  }
  const selected = new Set(selectedTestFiles)
  for (const file of excludes) {
    if (selected.has(file) === false) {
      throw new Error(
        `${packagePath}:${target.name} excludes ${file}, which its lane does not select`,
      )
    }
  }
  const excluded = new Set(excludes)
  const sourceFiles = orderedTestFiles.filter(
    (file) => selected.has(file) === false || excluded.has(file) === true,
  )
  const sourceFileSet = new Set(sourceFiles)
  const sourceTaskNamePattern = /^[a-z0-9][a-z0-9:-]*$/
  for (const [file, owner] of Object.entries(sourceOwners)) {
    if (sourceFileSet.has(file) === false) {
      throw new Error(`${packagePath}:${target.name} assigns ${file}, which is not source-owned`)
    }
    if (sourceTaskNamePattern.test(owner) === false) {
      throw new Error(`${packagePath}:${target.name} assigns ${file} to unsafe task ${owner}`)
    }
  }
  const unboundedFiles = sourceFiles.filter((file) => sourceOwners[file] === undefined)
  const unboundedAfter = [...(target.unboundedAfter ?? [])]
  if (new Set(unboundedAfter).size !== unboundedAfter.length) {
    throw new Error(`${packagePath}:${target.name} unbounded ordering contains a duplicate`)
  }
  for (const dependency of unboundedAfter) {
    if (sourceTaskNamePattern.test(dependency) === false) {
      throw new Error(`${packagePath}:${target.name} has unsafe unbounded dependency ${dependency}`)
    }
  }
  if (unboundedFiles.length === 0 && unboundedAfter.length > 0) {
    throw new Error(`${packagePath}:${target.name} has unbounded ordering but no unbounded files`)
  }
  const label = `${buck2Cell}//${packagePath}:${target.name}`
  return {
    ...(target.runner === 'vitest'
      ? { collectionTarget: `${label}${buck2TestCollectionTargetSuffix}` }
      : {}),
    excludes,
    packageName,
    packagePath,
    runner: target.runner,
    selectedTestFiles,
    sourceOwners,
    target: label,
    taskName,
    testFiles: orderedTestFiles,
    unboundedAfter,
    unboundedFiles,
    ...(unboundedFiles.length === 0 ? {} : { unboundedTaskName: `${taskName}:unbounded` }),
  }
}

/**
 * Every declared test lane, byte-sorted by execution label.
 *
 * The single semantic source for who runs what: `buck2:check` builds these and their
 * inventory siblings, and the generated `buck2-test-authority.json` bridge hands the same
 * rows to the source-side tasks. A lane cannot be added to one consumer and not the other.
 */
export const buck2TestLanes: readonly Buck2TestLane[] = Object.values(buck2TypeScriptAdmissions)
  .flatMap((admission: Buck2TypeScriptAdmission): readonly Buck2TestLane[] => {
    const testFiles = discoverCollectableTestModules({
      packagePath: admission.packagePath,
      sourceRoots: admission.sourceRoots,
    })
    return (admission.tests ?? []).map((target) =>
      deriveBuck2TestLane({ packagePath: admission.packagePath, target, testFiles }),
    )
  })
  .toSorted((left, right) => compareAuthorityStrings(left.target, right.target))
for (const parent of buck2TestLanes) {
  const child = buck2TestLanes.find(
    (candidate) =>
      candidate !== parent && candidate.packagePath.startsWith(`${parent.packagePath}/`),
  )
  if (child !== undefined) {
    throw new Error(
      `Buck test authority does not support nested lane packages: ${parent.packagePath} contains ${child.packagePath}`,
    )
  }
}

/**
 * Every Buck test target the admitted packages declare, byte-sorted and fully qualified.
 *
 * `buck2:check` builds these beside the typecheck targets so a declared lane cannot rot: its
 * rule, its staged package tree, and its attested tools are proven to analyse and stage on
 * every check.
 */
export const buck2TypeScriptTestTargets: readonly string[] = buck2TestLanes.map(
  ({ target }) => target,
)

/**
 * Inventory targets of every Vitest lane, byte-sorted and fully qualified.
 *
 * `buck2:check` builds these too: the bounded selection a source-side task reports comes from
 * these artifacts, so an inventory that stops analysing is a broken gate, not a silent one.
 */
export const buck2TypeScriptTestCollectionTargets: readonly string[] = buck2TestLanes.flatMap(
  ({ collectionTarget }) => (collectionTarget === undefined ? [] : [collectionTarget]),
)

/** Byte-sorted package paths whose Buck dependency trees publish editor views. */
export const editorViewConsumerPackagePaths = Object.values(buck2TypeScriptAdmissions)
  .map((admission) => admission.packagePath)
  .toSorted(compareAuthorityStrings)
const editorViewPackageSet = new Set(editorViewConsumerPackagePaths)
const workspacePackageSet = new Set(pnpmWorkspaceMemberPaths)
const missingEditorViews = pnpmWorkspaceMemberPaths.filter(
  (packagePath) => editorViewPackageSet.has(packagePath) === false,
)
const nonWorkspaceEditorViews = editorViewConsumerPackagePaths.filter(
  (packagePath) => workspacePackageSet.has(packagePath) === false,
)
if (missingEditorViews.length > 0 || nonWorkspaceEditorViews.length > 0) {
  throw new Error(
    `Editor view authority must cover every pnpm workspace package exactly once: missing=${JSON.stringify(missingEditorViews)} extra=${JSON.stringify(nonWorkspaceEditorViews)}`,
  )
}
