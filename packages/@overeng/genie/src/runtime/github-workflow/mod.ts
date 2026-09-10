import { createGenieOutput, type GenieActionlintConfig, type GenieContext } from '../core.ts'
import type { GenieOutput, Strict } from '../mod.ts'
import * as yaml from '../utils/yaml.ts'
import type { GenieValidationIssue } from '../validation/mod.ts'

/** Configuration for actionlint validation in `githubWorkflow()` (alias of {@link GenieActionlintConfig}). */
export type ActionlintConfig = GenieActionlintConfig

/**
 * Type-safe GitHub Actions workflow generator
 * Reference: https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions
 */

type Expression = `\${{ ${string} }}`

type EventTrigger =
  | 'branch_protection_rule'
  | 'check_run'
  | 'check_suite'
  | 'create'
  | 'delete'
  | 'deployment'
  | 'deployment_status'
  | 'discussion'
  | 'discussion_comment'
  | 'fork'
  | 'gollum'
  | 'issue_comment'
  | 'issues'
  | 'label'
  | 'merge_group'
  | 'milestone'
  | 'page_build'
  | 'project'
  | 'project_card'
  | 'project_column'
  | 'public'
  | 'pull_request'
  | 'pull_request_comment'
  | 'pull_request_review'
  | 'pull_request_review_comment'
  | 'pull_request_target'
  | 'push'
  | 'registry_package'
  | 'release'
  | 'repository_dispatch'
  | 'schedule'
  | 'status'
  | 'watch'
  | 'workflow_call'
  | 'workflow_dispatch'
  | 'workflow_run'

type PushPullRequestTriggerConfig = {
  branches?: string[]
  'branches-ignore'?: string[]
  paths?: string[]
  'paths-ignore'?: string[]
  tags?: string[]
  'tags-ignore'?: string[]
  /** Activity types for `pull_request` / `pull_request_target`; `push` has none. */
  types?: string[]
}

type ScheduleTrigger = {
  cron: string
}

type WorkflowDispatchInput = {
  description?: string
  required?: boolean
  default?: string | boolean | number
  type?: 'boolean' | 'choice' | 'environment' | 'string' | 'number'
  options?: string[]
}

type WorkflowDispatchConfig = {
  inputs?: Record<string, WorkflowDispatchInput>
}

type WorkflowCallInput = {
  description?: string
  required?: boolean
  default?: string | boolean | number
  type: 'boolean' | 'number' | 'string'
}

type WorkflowCallSecret = {
  description?: string
  required?: boolean
}

type WorkflowCallOutput = {
  description?: string
  value: string
}

type WorkflowCallConfig = {
  inputs?: Record<string, WorkflowCallInput>
  outputs?: Record<string, WorkflowCallOutput>
  secrets?: Record<string, WorkflowCallSecret>
}

type WorkflowRunConfig = {
  workflows: string[]
  types?: ('completed' | 'requested' | 'in_progress')[]
  branches?: string[]
  'branches-ignore'?: string[]
}

type RepositoryDispatchConfig = {
  types?: string[]
}

/** Sentinel selecting an event trigger with no branch/path/type filters (see `githubWorkflowEvent.all`). */
export type GitHubWorkflowEventAll = {
  readonly _tag: 'GitHubWorkflowEventAll'
}

/** GitHub Actions event trigger sentinels. */
export const githubWorkflowEvent = {
  /** Run for every occurrence of the event without branch/path/type filters. */
  all: { _tag: 'GitHubWorkflowEventAll' },
} satisfies {
  all: GitHubWorkflowEventAll
}

const isGitHubWorkflowEventAll = (value: unknown): value is GitHubWorkflowEventAll =>
  typeof value === 'object' &&
  value !== null &&
  '_tag' in value &&
  value._tag === githubWorkflowEvent.all._tag

type GitHubWorkflowEventAllTrigger = null | GitHubWorkflowEventAll

type OnConfig = {
  [K in EventTrigger]?: K extends 'push' | 'pull_request' | 'pull_request_target'
    ? PushPullRequestTriggerConfig | GitHubWorkflowEventAllTrigger
    : K extends 'schedule'
      ? ScheduleTrigger[]
      : K extends 'workflow_dispatch'
        ? WorkflowDispatchConfig | GitHubWorkflowEventAllTrigger
        : K extends 'workflow_call'
          ? WorkflowCallConfig | GitHubWorkflowEventAllTrigger
          : K extends 'workflow_run'
            ? WorkflowRunConfig
            : K extends 'repository_dispatch'
              ? RepositoryDispatchConfig | GitHubWorkflowEventAllTrigger
              : GitHubWorkflowEventAllTrigger
}

type PermissionLevel = 'read' | 'write' | 'none'

type Permissions =
  | 'read-all'
  | 'write-all'
  | {
      actions?: PermissionLevel
      attestations?: PermissionLevel
      checks?: PermissionLevel
      contents?: PermissionLevel
      deployments?: PermissionLevel
      'id-token'?: PermissionLevel
      issues?: PermissionLevel
      discussions?: PermissionLevel
      packages?: PermissionLevel
      pages?: PermissionLevel
      'pull-requests'?: PermissionLevel
      'repository-projects'?: PermissionLevel
      'security-events'?: PermissionLevel
      statuses?: PermissionLevel
    }

type Environment = {
  name: string
  url?: string
}

type Matrix = {
  include?: Array<Record<string, unknown>>
  exclude?: Array<Record<string, unknown>>
} & Record<string, unknown[] | undefined>

type Strategy = {
  matrix?: Matrix | Expression
  'fail-fast'?: boolean | Expression
  'max-parallel'?: number | Expression
}

type Container = {
  image: string
  credentials?: {
    username: string
    password: string
  }
  env?: Record<string, string>
  ports?: number[]
  volumes?: string[]
  options?: string
}

type Service = {
  image: string
  credentials?: {
    username: string
    password: string
  }
  env?: Record<string, string>
  ports?: (number | string)[]
  volumes?: string[]
  options?: string
}

type StepBase = {
  id?: string
  name?: string
  if?: string
  env?: Record<string, string>
  'continue-on-error'?: boolean | Expression
  'timeout-minutes'?: number | Expression
  'working-directory'?: string
}

type RunStep = StepBase & {
  run: string
  shell?: 'bash' | 'pwsh' | 'python' | 'sh' | 'cmd' | 'powershell' | string
}

type UsesStep = StepBase & {
  uses: string
  with?: Record<string, string | number | boolean>
}

type Step = RunStep | UsesStep

type Defaults = {
  run?: {
    shell?: string
    'working-directory'?: string
  }
}

type Concurrency = {
  group: string
  'cancel-in-progress'?: boolean | Expression
}

type JobWithSteps = {
  name?: string
  'runs-on': string | string[]
  needs?: string | string[]
  if?: string
  permissions?: Permissions
  environment?: string | Environment
  concurrency?: string | Concurrency
  outputs?: Record<string, string>
  env?: Record<string, string>
  defaults?: Defaults
  steps: Step[]
  'timeout-minutes'?: number | Expression
  strategy?: Strategy
  'continue-on-error'?: boolean | Expression
  container?: string | Container
  services?: Record<string, Service>
}

/**
 * Reusable workflow call job — a job that delegates to another workflow via
 * `uses:`. No `runs-on`/`steps`; instead it consumes the called workflow's
 * `on.workflow_call.inputs` (via `with:`) and exposes its declared outputs
 * to dependent jobs via `needs.<job-id>.outputs.<output-name>`.
 *
 * GitHub workflow_call reference:
 * https://docs.github.com/en/actions/sharing-automations/reusing-workflows
 */
type JobWithUses = {
  name?: string
  uses: string
  needs?: string | string[]
  if?: string
  permissions?: Permissions
  with?: Record<string, string | number | boolean>
  secrets?: 'inherit' | Record<string, string>
  strategy?: Strategy
  concurrency?: string | Concurrency
}

type Job = JobWithSteps | JobWithUses

const isJobWithUses = (job: Job): job is JobWithUses => 'uses' in job

/** Arguments for generating a GitHub Actions workflow file */
export type GitHubWorkflowArgs = {
  /** Workflow name displayed in GitHub UI */
  name?: string
  /** Event triggers for the workflow */
  on: OnConfig | EventTrigger | EventTrigger[]
  /** Workflow-level permissions */
  permissions?: Permissions
  /** Environment variables for all jobs */
  env?: Record<string, string>
  /** Default settings for all jobs */
  defaults?: Defaults
  /** Concurrency settings */
  concurrency?: string | Concurrency
  /** Jobs to run */
  jobs: Record<string, Job>
  /** Workflow run name */
  'run-name'?: string
  /** actionlint validation config — pass `false` to disable, or provide runner labels / ignore patterns */
  actionlint?: ActionlintConfig | false
}

const normalizeWorkflowOn = (on: GitHubWorkflowArgs['on']): GitHubWorkflowArgs['on'] => {
  if (typeof on !== 'object' || on === null || Array.isArray(on) === true) return on

  return Object.fromEntries(
    Object.entries(on).map(([eventName, eventConfig]) => [
      eventName,
      isGitHubWorkflowEventAll(eventConfig) === true ? null : eventConfig,
    ]),
  ) as GitHubWorkflowArgs['on']
}

const invalidRunnerLabelPattern = /(^|[=:])(undefined|null)$/
const githubExpressionStart = '${{'
const githubExpressionEnd = '}}'
// Documented GitHub Actions limits:
// https://docs.github.com/en/actions/reference/limits
const githubWorkflowMatrixJobLimit = 256
const githubWorkflowCheckRunsPerSuiteLimit = 50_000
const githubWorkflowAdmissionSizeLimitBytes = 500_000
const githubWorkflowAdmissionSizeWarnBytes = 460_000
const githubHostedJobTimeoutMinutesLimit = 6 * 60
const selfHostedJobTimeoutMinutesLimit = 5 * 24 * 60
const githubHostedRunnerLabels = new Set([
  'windows-latest',
  'windows-latest-8-cores',
  'windows-2025',
  'windows-2025-vs2026',
  'windows-2022',
  'windows-11-arm',
  'ubuntu-slim',
  'ubuntu-latest',
  'ubuntu-latest-4-cores',
  'ubuntu-latest-8-cores',
  'ubuntu-latest-16-cores',
  'ubuntu-24.04',
  'ubuntu-24.04-arm',
  'ubuntu-22.04',
  'ubuntu-22.04-arm',
  'macos-latest',
  'macos-latest-xlarge',
  'macos-latest-large',
  'macos-26-intel',
  'macos-26-xlarge',
  'macos-26-large',
  'macos-26',
  'macos-15-intel',
  'macos-15-xlarge',
  'macos-15-large',
  'macos-15',
  'macos-14-xlarge',
  'macos-14-large',
  'macos-14',
])

const validateRunsOn = ({
  jobName,
  runsOn,
  location,
}: {
  jobName: string
  runsOn: unknown
  location: string
}): GenieValidationIssue[] => {
  const labels = Array.isArray(runsOn) === true ? runsOn : [runsOn]
  const issues: GenieValidationIssue[] = []

  if (labels.length === 0) {
    issues.push({
      severity: 'error',
      packageName: location,
      dependency: `jobs.${jobName}.runs-on`,
      message: `jobs.${jobName}.runs-on must include at least one runner label.`,
      rule: 'github-workflow-runs-on-empty',
    })
    return issues
  }

  for (const [index, label] of labels.entries()) {
    const dependency = `jobs.${jobName}.runs-on[${index}]`
    if (typeof label !== 'string') {
      issues.push({
        severity: 'error',
        packageName: location,
        dependency,
        message: `jobs.${jobName}.runs-on must serialize to string labels, got ${String(label)}.`,
        rule: 'github-workflow-runs-on-non-string',
      })
      continue
    }

    if (label.trim() === '') {
      issues.push({
        severity: 'error',
        packageName: location,
        dependency,
        message: `jobs.${jobName}.runs-on labels must not be empty.`,
        rule: 'github-workflow-runs-on-empty-label',
      })
      continue
    }

    if (invalidRunnerLabelPattern.test(label) === true) {
      issues.push({
        severity: 'error',
        packageName: location,
        dependency,
        message: `jobs.${jobName}.runs-on contains a stale placeholder label (${label}). This usually means a CI helper API drifted and serialized undefined/null into the workflow.`,
        rule: 'github-workflow-runs-on-placeholder',
      })
    }
  }

  return issues
}

/**
 * TODO: Remove this validator once upstream ca-derivations issues are resolved
 * (NixOS/nix#12361, cachix/devenv#2364)
 */
const validateDeterminateNixExtraConf = ({
  args,
  location,
}: {
  args: GitHubWorkflowArgs
  location: string
}): GenieValidationIssue[] => {
  const issues: GenieValidationIssue[] = []

  for (const [jobName, job] of Object.entries(args.jobs)) {
    if (isJobWithUses(job) === true) continue
    for (const [stepIndex, step] of job.steps.entries()) {
      if ('uses' in step === false) continue
      if (step.uses.startsWith('DeterminateSystems/determinate-nix-action') === false) continue

      const extraConf = step.with?.['extra-conf']
      if (typeof extraConf === 'string' && extraConf.includes('experimental-features') === true)
        continue

      issues.push({
        severity: 'warning',
        packageName: location,
        dependency: `jobs.${jobName}.steps[${stepIndex}]`,
        message: `jobs.${jobName}.steps[${stepIndex}] uses DeterminateSystems/determinate-nix-action without "experimental-features" in extra-conf. Determinate Nix enables ca-derivations by default which causes store path validity failures with devenv. Add "experimental-features = nix-command flakes" to extra-conf.`,
        rule: 'github-workflow-determinate-nix-extra-conf',
      })
    }
  }

  return issues
}

const containsNestedGitHubExpression = (value: string) => {
  const trimmed = value.trim()
  if (trimmed.startsWith(githubExpressionStart) === false) return false

  const firstExpressionClose = trimmed.indexOf(githubExpressionEnd, githubExpressionStart.length)
  if (firstExpressionClose === -1) return false

  const nestedExpressionStart = trimmed.indexOf(githubExpressionStart, githubExpressionStart.length)
  if (nestedExpressionStart === -1) return false

  return nestedExpressionStart < firstExpressionClose
}

const validateGitHubExpressionStrings = ({
  value,
  dependency,
  location,
}: {
  value: unknown
  dependency: string
  location: string
}): GenieValidationIssue[] => {
  if (typeof value === 'string') {
    if (containsNestedGitHubExpression(value) === false) return []

    return [
      {
        severity: 'error',
        packageName: location,
        dependency,
        message: `${dependency} contains a nested GitHub Actions expression. GitHub does not allow \`${githubExpressionStart} ... ${githubExpressionEnd}\` inside another expression. Precompute the fallback string in TypeScript instead of nesting expressions in YAML.`,
        rule: 'github-workflow-expression-nesting',
      },
    ]
  }

  if (Array.isArray(value) === true) {
    return value.flatMap((item, index) =>
      validateGitHubExpressionStrings({
        value: item,
        dependency: `${dependency}[${index}]`,
        location,
      }),
    )
  }

  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, entryValue]) =>
      validateGitHubExpressionStrings({
        value: entryValue,
        dependency: dependency === '' ? key : `${dependency}.${key}`,
        location,
      }),
    )
  }

  return []
}

const staticMatrixJobCount = (strategy: Strategy | undefined): number | undefined => {
  const matrix = strategy?.matrix
  if (matrix === undefined || typeof matrix === 'string') return 1

  let product = 1
  for (const [key, value] of Object.entries(matrix)) {
    if (key === 'include' || key === 'exclude') continue
    if (Array.isArray(value) === false) return undefined
    product *= value.length
    if (product > githubWorkflowCheckRunsPerSuiteLimit) return product
  }

  const includeCount = Array.isArray(matrix.include) === true ? matrix.include.length : 0
  return product + includeCount
}

const isGitHubHostedRunsOn = (runsOn: string | string[]) => {
  const labels = Array.isArray(runsOn) === true ? runsOn : [runsOn]
  return labels.some((label) => githubHostedRunnerLabels.has(label))
}

const validateDocumentedGitHubLimits = ({
  args,
  location,
}: {
  args: GitHubWorkflowArgs
  location: string
}): GenieValidationIssue[] => {
  const issues: GenieValidationIssue[] = []
  let staticCheckRunCount = 0

  for (const [jobName, job] of Object.entries(args.jobs)) {
    const matrixJobCount = staticMatrixJobCount(job.strategy)
    if (matrixJobCount !== undefined) {
      staticCheckRunCount += matrixJobCount

      if (matrixJobCount > githubWorkflowMatrixJobLimit) {
        issues.push({
          severity: 'error',
          packageName: location,
          dependency: `jobs.${jobName}.strategy.matrix`,
          message: `jobs.${jobName}.strategy.matrix statically expands to ${matrixJobCount} jobs, exceeding GitHub Actions' documented ${githubWorkflowMatrixJobLimit}-job matrix limit.`,
          rule: 'github-workflow-matrix-job-limit',
        })
      }
    }

    const timeoutMinutes = job['timeout-minutes']
    if (typeof timeoutMinutes === 'number') {
      const githubHosted = isGitHubHostedRunsOn(job['runs-on'])
      const timeoutLimit =
        githubHosted === true
          ? githubHostedJobTimeoutMinutesLimit
          : selfHostedJobTimeoutMinutesLimit
      if (timeoutMinutes > timeoutLimit) {
        issues.push({
          severity: 'warning',
          packageName: location,
          dependency: `jobs.${jobName}.timeout-minutes`,
          message: `jobs.${jobName}.timeout-minutes is ${timeoutMinutes}, but GitHub Actions documents a ${timeoutLimit}-minute execution limit for ${githubHosted === true ? 'GitHub-hosted' : 'self-hosted'} jobs. The job can be terminated before this timeout is reached.`,
          rule: 'github-workflow-job-timeout-limit',
        })
      }
    }
  }

  if (staticCheckRunCount > githubWorkflowCheckRunsPerSuiteLimit) {
    issues.push({
      severity: 'error',
      packageName: location,
      dependency: 'jobs',
      message: `Workflow statically declares at least ${staticCheckRunCount} check runs, exceeding GitHub Actions' documented ${githubWorkflowCheckRunsPerSuiteLimit} check-runs-per-check-suite limit.`,
      rule: 'github-workflow-check-runs-per-suite-limit',
    })
  }

  return issues
}

const utf8ByteLength = (value: string) => {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index) ?? 0
    if (codePoint > 0xffff) index += 1
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4
  }
  return bytes
}

const formatBytes = (bytes: number) => `${bytes.toLocaleString('en-US')} bytes`

const validateGitHubWorkflowAdmissionSize = ({
  yamlContent,
  location,
}: {
  yamlContent: string
  location: string
}): GenieValidationIssue[] => {
  const sizeBytes = utf8ByteLength(yamlContent)

  if (sizeBytes > githubWorkflowAdmissionSizeLimitBytes) {
    return [
      {
        severity: 'error',
        packageName: location,
        dependency: 'workflow',
        message: `Workflow serializes to ${formatBytes(sizeBytes)}, exceeding the observed GitHub Actions workflow admission limit of ${formatBytes(githubWorkflowAdmissionSizeLimitBytes)}. GitHub can silently skip creating runs for oversized workflow files; reduce generated YAML size before pushing.`,
        rule: 'github-workflow-admission-size-limit',
      },
    ]
  }

  if (sizeBytes >= githubWorkflowAdmissionSizeWarnBytes) {
    return [
      {
        severity: 'warning',
        packageName: location,
        dependency: 'workflow',
        message: `Workflow serializes to ${formatBytes(sizeBytes)}, leaving ${formatBytes(githubWorkflowAdmissionSizeLimitBytes - sizeBytes)} before the observed GitHub Actions workflow admission limit of ${formatBytes(githubWorkflowAdmissionSizeLimitBytes)}.`,
        rule: 'github-workflow-admission-size-margin',
      },
    ]
  }

  return []
}

const preparedCiRuntimeScriptsPath = '${{ github.workspace }}/.genie-ci-runtime/'
const prepareCiScriptsStepName = 'Prepare CI helper scripts'

const stepName = (step: Step): string | undefined =>
  typeof step.name === 'string' ? step.name : undefined

const stepRun = (step: Step): string | undefined =>
  'run' in step && typeof step.run === 'string' ? step.run : undefined

const stepUses = (step: Step): string | undefined =>
  'uses' in step && typeof step.uses === 'string' ? step.uses : undefined

const checkoutCleansWorkspaceRoot = (step: Step): boolean => {
  if (stepUses(step)?.startsWith('actions/checkout@') !== true) return false
  if (!('with' in step) || step.with === undefined) return true

  const path = step.with.path
  const clean = step.with.clean
  const normalizedPath = typeof path === 'string' ? path.trim() : undefined
  const checkoutAtWorkspaceRoot =
    normalizedPath === undefined ||
    normalizedPath === '' ||
    normalizedPath === '.' ||
    normalizedPath === './' ||
    normalizedPath.startsWith('${{')
  const cleanDisabled = clean === false || clean === 'false'
  return checkoutAtWorkspaceRoot === true && cleanDisabled === false
}

const installNixInvalidatesPreparedCiRuntime = (step: Step): boolean =>
  stepUses(step)?.toLowerCase().startsWith('determinatesystems/determinate-nix-action@') === true

const validatePreparedCiRuntimeScriptsSetup = ({
  args,
  location,
}: {
  args: GitHubWorkflowArgs
  location: string
}): GenieValidationIssue[] => {
  const issues: GenieValidationIssue[] = []

  for (const [jobName, job] of Object.entries(args.jobs)) {
    let prepareIndex = -1
    let invalidatingStepIndex = -1

    for (const [index, step] of job.steps.entries()) {
      if (stepName(step) === prepareCiScriptsStepName) prepareIndex = index
      if (
        checkoutCleansWorkspaceRoot(step) === true ||
        installNixInvalidatesPreparedCiRuntime(step) === true
      ) {
        invalidatingStepIndex = index
      }
      if (stepRun(step)?.includes(preparedCiRuntimeScriptsPath) !== true) continue
      if (prepareIndex >= 0 && prepareIndex > invalidatingStepIndex) continue

      issues.push({
        severity: 'error',
        packageName: location,
        dependency: `jobs.${jobName}.steps[${index}]`,
        message: `jobs.${jobName} uses a prepared CI runtime helper under ${preparedCiRuntimeScriptsPath} without a preceding "${prepareCiScriptsStepName}" step after the final workspace-cleaning checkout and Nix installation.`,
        rule: 'github-workflow-prepared-ci-runtime-script-setup',
      })
    }
  }

  return issues
}

const validateWorkflow = ({
  args,
  yamlContent,
  ctx,
}: {
  args: GitHubWorkflowArgs
  yamlContent: string
  ctx: GenieContext
}): GenieValidationIssue[] => {
  const location = ctx.location
  const issues: GenieValidationIssue[] = []

  for (const [jobName, job] of Object.entries(args.jobs)) {
    // Reusable workflow call jobs (`uses:`) don't have their own `runs-on`;
    // the runner is determined by the called workflow.
    if (isJobWithUses(job) === true) continue
    issues.push(...validateRunsOn({ jobName, runsOn: job['runs-on'], location }))
  }

  issues.push(...validateDocumentedGitHubLimits({ args, location }))
  issues.push(...validateGitHubWorkflowAdmissionSize({ yamlContent, location }))
  issues.push(...validatePreparedCiRuntimeScriptsSetup({ args, location }))
  issues.push(...validateDeterminateNixExtraConf({ args, location }))
  issues.push(
    ...validateGitHubExpressionStrings({
      value: args,
      dependency: '',
      location,
    }),
  )

  // actionlint shells out to a binary (node-only), so it runs only when the engine injects the
  // `ctx.actionlint` capability. A typechecking consumer of the pure `.` entry never resolves the spawn runner.
  if (args.actionlint !== false && ctx.actionlint !== undefined) {
    const { issues: actionlintIssues } = ctx.actionlint({
      yaml: yamlContent,
      location,
      ...(args.actionlint !== undefined ? { config: args.actionlint } : {}),
    })
    issues.push(...actionlintIssues)
  }

  return issues
}

/**
 * Creates a GitHub Actions workflow YAML configuration.
 *
 * Returns a `GenieOutput` with the structured data accessible via `.data`
 * for composition with other genie files.
 *
 * @example
 * ```ts
 * export default githubWorkflow({
 *   name: "CI",
 *   on: {
 *     push: { branches: ["main"] },
 *     pull_request: { branches: ["main"] }
 *   },
 *   jobs: {
 *     build: {
 *       "runs-on": "ubuntu-latest",
 *       steps: [
 *         { uses: "actions/checkout@v4" },
 *         { run: "npm test" }
 *       ]
 *     }
 *   }
 * })
 * ```
 */
export const githubWorkflow = <const T extends GitHubWorkflowArgs>(
  args: Strict<T, GitHubWorkflowArgs>,
): GenieOutput<T> => {
  const normalizedArgs = { ...args, on: normalizeWorkflowOn(args.on) }
  const { actionlint: _actionlint, ...yamlArgs } = normalizedArgs
  return createGenieOutput({
    data: args,
    stringify: (_ctx) => yaml.stringify(yamlArgs),
    validate: (ctx) => {
      const yamlContent = yaml.stringify(yamlArgs)
      return validateWorkflow({ args: normalizedArgs, yamlContent, ctx })
    },
  })
}
