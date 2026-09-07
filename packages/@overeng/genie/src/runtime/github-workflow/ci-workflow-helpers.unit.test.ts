import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/** Reads one Buck-declared immutable tool path; nothing resolves through an ambient PATH. */
const requireTool = (name: string): string => {
  const tool = process.env[name]
  if (tool === undefined || tool === '')
    throw new Error(`declared test tool is unavailable: ${name}`)
  return tool
}

/**
 * This suite executes the CI scripts and workflow fragments it asserts over, so the shell,
 * `git`, and the `wc` the fake `nix` fixtures count attempts with are declared tools of the
 * root Buck test target, never bare command names resolved from the caller's environment.
 */
const bashBin = requireTool('BASH_BIN')
const gitBin = requireTool('GIT_BIN')
const wcBin = requireTool('WC_BIN')
const devenvModuleToolsBin = requireTool('DEVENV_MODULE_TOOLS_BIN')

const ciWorkflowSource = [
  'ci-workflow.ts',
  'ci-workflow/shared.ts',
  'ci-workflow/setup.ts',
  'ci-workflow/measurements.ts',
  'ci-workflow/reporting.ts',
  'ci-workflow/megarepo.ts',
  'ci-workflow/merge-queue.ts',
  'ci-workflow/deploy.ts',
]
  .map((file) =>
    readFileSync(new URL(['../../../../../../genie', file].join('/'), import.meta.url), 'utf8'),
  )
  .join('\n')
const generatedWorkflowSource = readFileSync(
  new URL(['../../../../../../.github/workflows', 'ci.yml.genie.ts'].join('/'), import.meta.url),
  'utf8',
)
const generatedCiWorkflowYamlSource = readFileSync(
  new URL(['../../../../../../.github/workflows', 'ci.yml'].join('/'), import.meta.url),
  'utf8',
)
const generatedRepoSettings = JSON.parse(
  readFileSync(
    new URL(['../../../../../../.github', 'repo-settings.json'].join('/'), import.meta.url),
    'utf8',
  ),
) as {
  rules: Array<{
    type: string
    parameters?: {
      required_status_checks?: Array<{ context: string }>
    }
  }>
}
/**
 * The tracked-Buck-product spec is generated from the same product manifest the CI
 * candidate graph is derived from, and it is a committed generated artifact. Reading it as
 * data keeps this package from importing across its own `rootDir`.
 */
const trackedBuckProducts = JSON.parse(
  readFileSync(
    new URL(['../../../../../../nix/buck2-products', 'products.json'].join('/'), import.meta.url),
    'utf8',
  ),
) as { products: Array<{ label: string }> }
/**
 * TypeScript authority registry: the authority for the typecheck, dist, and editor-view
 * classes of the candidate graph. Read as data for the same rootDir reason.
 */
const typescriptAuthorityManifest = JSON.parse(
  readFileSync(
    new URL(
      ['../../../../../../genie/buck2', 'typescript-authority-manifest.json'].join('/'),
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  authorityProjects: Array<{ typecheckTarget: string }>
  authoritativeAdmissions: Array<{ distTarget: string }>
  editorViewConsumerPackagePaths: string[]
}
/** The generated candidate-graph artifact the CI lane actually builds. */
const candidateGraphArtifact = readFileSync(
  new URL(
    ['../../../../../../genie/ci-scripts', 'buck2-candidate-graph.txt'].join('/'),
    import.meta.url,
  ),
  'utf8',
)
const vercelDeploySource = readFileSync(
  new URL(['../../../../../../genie/deploy-preview', 'vercel.ts'].join('/'), import.meta.url),
  'utf8',
)
const netlifyDeploySource = readFileSync(
  new URL(['../../../../../../genie/deploy-preview', 'netlify.ts'].join('/'), import.meta.url),
  'utf8',
)
const workflowReportCommandSource = readFileSync(
  new URL(
    ['../../../../../../packages/@overeng/ci-tools/src', 'cli-command.ts'].join('/'),
    import.meta.url,
  ),
  'utf8',
)
const nixGcRaceRetryScriptSource = readFileSync(
  new URL(
    ['../../../../../../genie/ci-scripts', 'nix-gc-race-retry.sh'].join('/'),
    import.meta.url,
  ),
  'utf8',
)
const prepareEffectUtilsCompositionScriptSource = readFileSync(
  new URL(
    ['../../../../../../genie/ci-scripts', 'prepare-effect-utils-composition.sh'].join('/'),
    import.meta.url,
  ),
  'utf8',
)
const cleanupEffectUtilsCompositionScriptSource = readFileSync(
  new URL(
    ['../../../../../../genie/ci-scripts', 'cleanup-effect-utils-composition.sh'].join('/'),
    import.meta.url,
  ),
  'utf8',
)
const netlifyTaskModuleSource = readFileSync(
  new URL(
    ['../../../../../../nix/devenv-modules/tasks/shared', 'netlify.nix'].join('/'),
    import.meta.url,
  ),
  'utf8',
)
const vercelTaskModuleSource = readFileSync(
  new URL(
    ['../../../../../../nix/devenv-modules/tasks/shared', 'vercel.nix'].join('/'),
    import.meta.url,
  ),
  'utf8',
)
const workflowReportTaskModuleSource = readFileSync(
  new URL(
    ['../../../../../../nix/devenv-modules/tasks/shared', 'workflow-report-module.nix'].join('/'),
    import.meta.url,
  ),
  'utf8',
)
const buckToolchainsSource = readFileSync(
  new URL(['../../../../../../buck2/toolchains', 'BUCK'].join('/'), import.meta.url),
  'utf8',
)
/**
 * The two buckconfig-emitting cache config paths the lane depends on: the developer shell
 * hook and the composition overlay. Read as text so this package asserts over the real
 * generators without importing across its own `rootDir`.
 */
const devenvSource = readFileSync(
  new URL(['../../../../../..', 'devenv.nix'].join('/'), import.meta.url),
  'utf8',
)
const compositionCommandSource = readFileSync(
  new URL(
    ['../../../../../../packages/@overeng/megarepo/src/cli/commands', 'composition.ts'].join('/'),
    import.meta.url,
  ),
  'utf8',
)

const generatedCiJobKeys = Array.from(
  (generatedCiWorkflowYamlSource.split('\njobs:\n')[1] ?? '').matchAll(/^  ([a-zA-Z0-9_-]+):$/gm),
  ([, jobKey]) => jobKey,
).filter((jobKey): jobKey is string => jobKey !== undefined)

const advisoryCheckContexts = new Set(['ci/measurements-report', 'notify-alignment'])
// Opt-in lanes (see OPT_IN_CI_JOB_NAMES in genie/ci.ts) are non-advisory but do not run on
// every pull request, so branch protection cannot require them: a skipped lane reports no
// check run at all and a required-but-absent context would wait forever.
const optInCheckContexts = new Set([
  'devenv-perf',
  'buck2-cache-publish',
  'buck2-cache-restore',
  'buck2-cache-outage',
  'buck2-capacity',
])
const matrixCheckJobs = new Set(['test'])
const matrixRunners = ['namespace-profile-linux-x86-64', 'namespace-profile-macos-arm64'] as const

const generatedNonAdvisoryCheckContexts = generatedCiJobKeys
  .flatMap((jobKey) => {
    if (jobKey === 'ci-measurements-report') return ['ci/measurements-report']
    if (matrixCheckJobs.has(jobKey) === true) {
      return matrixRunners.map((runner) => `${jobKey} (${runner})`)
    }
    return [jobKey]
  })
  .filter((context) => advisoryCheckContexts.has(context) === false)

const generatedRequiredCheckContexts =
  generatedRepoSettings.rules
    .find((rule) => rule.type === 'required_status_checks')
    ?.parameters?.required_status_checks?.map((check) => check.context) ?? []

const extractSourceBlock = (source: string, startMarker: string, endMarker: string) => {
  const start = source.indexOf(startMarker)
  if (start < 0) {
    throw new Error(`missing source block start: ${startMarker}`)
  }

  const end = source.indexOf(endMarker, start + startMarker.length)
  if (end < 0) {
    throw new Error(`missing source block end: ${endMarker}`)
  }

  return source.slice(start, end)
}

const generatedDevenvPerfJob = extractSourceBlock(
  generatedCiWorkflowYamlSource,
  '  devenv-perf:',
  '  nix-closure-sizes:',
)

const pnpmDepsScanSource = extractSourceBlock(
  ciWorkflowSource,
  'const withEachPnpmDepsDrvShellLines = ({',
  '/** Evict cached pnpm-deps fixed-output outputs so CI re-derives them fresh. */',
)

const coldFreshBuildSource = extractSourceBlock(
  ciWorkflowSource,
  '/** Evict any cached pnpm-deps outputs below a flake target and rebuild it against cache.nixos.org only. */',
  '/**\n * Guard the pnpm dependency-prep contract against regressions that would',
)

const restorePnpmStateStepSource = extractSourceBlock(
  ciWorkflowSource,
  'export const restorePnpmStateStep = (opts?: {',
  '/**\n * Save the job-local pnpm state after the main task graph runs.',
)

const validateNixStoreStepSource = extractSourceBlock(
  ciWorkflowSource,
  "export const validateNixStoreStepFor = (lockFile = 'devenv.lock') =>",
  '/**\n * Upload diagnostics captured by `validateNixStoreStep` as a CI artifact.',
)

const resolveDevenvScriptUrl = new URL(
  ['../../../../../../genie/ci-scripts', 'resolve-devenv.sh'].join('/'),
  import.meta.url,
)
const resolveDevenvScriptPath = fileURLToPath(resolveDevenvScriptUrl)
const resolveDevenvScript = readFileSync(resolveDevenvScriptUrl, 'utf8')

const applyMegarepoLockStepSource = extractSourceBlock(
  ciWorkflowSource,
  'export const applyMegarepoLockStep = (opts?: { skip?: string[]; cacheableStore?: boolean }) => {',
  'export type DefaultRefPolicyCheckStepOptions = {',
)
const defaultRefPolicyCheckStepSource = extractSourceBlock(
  ciWorkflowSource,
  'export type DefaultRefPolicyCheckStepOptions = {',
  '/** Fail when first-party megarepo/flake/devenv inputs target non-default refs. */',
)
const mergeQueueSource = extractSourceBlock(
  ciWorkflowSource,
  "export const mergeQueueAdmissionLabel = 'mq:ci-admitted' as const",
  'export const mergeQueueSemanticGateJob = ({',
)
const installMegarepoStepSource = extractSourceBlock(
  ciWorkflowSource,
  'export const installMegarepoStep = {',
  '/** Fetch latest refs and apply megarepo workspace. */',
)
const megarepoTaskModuleSource = readFileSync(
  new URL(
    ['../../../../../../nix/devenv-modules/tasks/shared', 'megarepo.nix'].join('/'),
    import.meta.url,
  ),
  'utf8',
)

describe('ci workflow retry helpers', () => {
  it('keeps non-advisory always-on workflow jobs required by branch protection', () => {
    const requiredCandidates = generatedNonAdvisoryCheckContexts.filter(
      (context) => optInCheckContexts.has(context) === false,
    )
    expect(new Set(generatedRequiredCheckContexts)).toEqual(new Set(requiredCandidates))
  })

  it('emits compact calls to the checked-in retry helper script', () => {
    expect(ciWorkflowSource).toContain("defaultCiRuntimeScriptsDir = 'genie/ci-scripts'")
    expect(ciWorkflowSource).toContain(
      'preparedCiRuntimeScriptsDir = `${ciCompositionStateRoot}/ci-runtime`',
    )
    expect(ciWorkflowSource).toContain('prepareCiScriptsStep')
    expect(ciWorkflowSource).toContain('rm -f "$scripts_dst"/*.genie.ts')
    expect(ciWorkflowSource).toContain('createRunDevenvTasksBefore')
    expect(ciWorkflowSource).toContain('run-with-nix-gc-race-retry.sh')
    expect(ciWorkflowSource).not.toContain('const nixGcRaceRetryScript = String.raw')
    expect(generatedCiWorkflowYamlSource).not.toContain('__nix_gc_retry_helper=$(mktemp)')
    expect(generatedCiWorkflowYamlSource).toContain('run-with-nix-gc-race-retry.sh')
    expect(nixGcRaceRetryScriptSource).toContain('run_nix_gc_race_retry')
    expect(nixGcRaceRetryScriptSource).toContain('mkfifo "$stdout_pipe" "$stderr_pipe"')
    expect(nixGcRaceRetryScriptSource).toContain('"$@" > "$stdout_pipe" 2> "$stderr_pipe"')
    expect(nixGcRaceRetryScriptSource).not.toContain('eval "$command"')
    expect(nixGcRaceRetryScriptSource).toContain("tr '\\r\\n' '  ' < \"$log\"")
    expect(nixGcRaceRetryScriptSource).not.toContain('repair_nix_daemon')
    expect(nixGcRaceRetryScriptSource).not.toContain('sudo systemctl')
    expect(nixGcRaceRetryScriptSource).not.toContain('sudo launchctl')
    expect(nixGcRaceRetryScriptSource).not.toContain("awk 'BEGIN { ORS=")
  })

  it('keeps the retry helper script path configurable for downstream workflows', () => {
    expect(ciWorkflowSource).toContain('createRunDevenvTasksBefore')
    expect(ciWorkflowSource).toContain('opts.scriptsDir === undefined')
    expect(ciWorkflowSource).not.toContain('if [ ! -x "$__genie_ci_retry_script" ]')
  })

  it('routes the devenv resolution step through the shared retry wrapper', () => {
    expect(validateNixStoreStepSource).toContain('withGcRaceRetry({')
    expect(validateNixStoreStepSource).toContain('label: `resolve devenv (${lockFile})`')
    expect(generatedCiWorkflowYamlSource).toContain(
      'bash "$__genie_ci_retry_script" \'resolve devenv (devenv.lock)\'',
    )
  })

  it('classifies an incompletely cached flake input as a bounded transient', () => {
    expect(nixGcRaceRetryScriptSource).toContain('saw_missing_flake_subpath')
    // Anchored on the guillemet-wrapped flake reference Nix prints, so a genuinely absent
    // store path reported with the same wording is not misread as transient.
    expect(nixGcRaceRetryScriptSource).toContain("flake_ref_open=$'\\302\\253'")
    expect(nixGcRaceRetryScriptSource).toContain("flake_ref_close=$'\\302\\273'")
    expect(nixGcRaceRetryScriptSource).toContain(
      "grep -o \"error:[[:space:]]*path '${flake_ref_open}[^']*${flake_ref_close}[^']*' does not exist\"",
    )
    // Determinate Nix versions these caches; the bare legacy names match nothing, and a
    // sqlite database removed without its -shm/-wal sidecars leaves a corrupt cache.
    expect(nixGcRaceRetryScriptSource).toContain(
      'nix_cache_root="${XDG_CACHE_HOME:-$HOME/.cache}/nix"',
    )
    expect(nixGcRaceRetryScriptSource).toContain('"$nix_cache_root"/tarball-cache-v*')
    expect(nixGcRaceRetryScriptSource).toContain('"$nix_cache_root"/gitv*')
    expect(nixGcRaceRetryScriptSource).toContain('"$nix_cache_root"/fetcher-cache-v*.sqlite*')
    // The same wording can describe a permanently removed path, so the repair is bounded.
    expect(nixGcRaceRetryScriptSource).toContain('missing_subpath_repairs')
    expect(nixGcRaceRetryScriptSource).toContain('[ "$missing_subpath_repairs" -ge 1 ]')
    expect(nixGcRaceRetryScriptSource).toContain(
      'rm -rf ~/.cache/nix/eval-cache-* "$nix_cache_root"/eval-cache-*',
    )
    // A second identical failure is an error carrying its own summary note and the
    // original exit code, never the generic no-transient-signature path.
    expect(nixGcRaceRetryScriptSource).toContain(
      '::error::Nix flake input subpath still missing for $task',
    )
    expect(nixGcRaceRetryScriptSource).toContain(
      'write_summary failure "Nix flake input subpath still missing after one cache repair',
    )
    // ASCII-only template: a guillemet in the generator can be re-encoded as an escape
    // sequence that String.raw would emit literally into the shipped script.
    expect(nixGcRaceRetryScriptSource).not.toContain('\\u00AB')
    expect(nixGcRaceRetryScriptSource).not.toContain('\u00AB')
  })

  it('prepares retry helpers before generated jobs use the prepared retry script', () => {
    const jobBlocks = generatedCiWorkflowYamlSource.split(/\n  [a-zA-Z0-9_-]+:\n/g).slice(1)

    for (const jobBlock of jobBlocks) {
      const helperIndex = jobBlock.indexOf(
        '${{ runner.temp }}/composition-state/ci-runtime/run-with-nix-gc-race-retry.sh',
      )
      if (helperIndex < 0) continue

      const checkoutIndex = jobBlock.indexOf('uses: actions/checkout@v6')
      const installNixIndex = jobBlock.indexOf('uses: DeterminateSystems/determinate-nix-action@v3')
      const prepareIndex = jobBlock.indexOf('Prepare CI helper scripts')
      const baselineCheckoutIndex = jobBlock.indexOf('Checkout CI measurement baseline ref')
      expect(checkoutIndex).toBeGreaterThanOrEqual(0)
      expect(checkoutIndex).toBeLessThan(helperIndex)
      expect(installNixIndex).toBeGreaterThanOrEqual(0)
      expect(installNixIndex).toBeLessThan(prepareIndex)
      expect(prepareIndex).toBeGreaterThanOrEqual(0)
      expect(prepareIndex).toBeLessThan(helperIndex)
      if (baselineCheckoutIndex >= 0) {
        expect(baselineCheckoutIndex).toBeLessThan(prepareIndex)
      }
    }
  })
})

describe('ci workflow reporting helpers', () => {
  it('keeps structured workflow report records on the marked JSONL path', () => {
    expect(ciWorkflowSource).toContain('encodeWorkflowReportRecordLine')
    expect(ciWorkflowSource).toContain('workflowReportProducerStep')
    expect(ciWorkflowSource).toContain('workflowReportCollectorStep')
    expect(ciWorkflowSource).toContain('workflowReportPublisherStep')
  })

  it('matches managed PR comments by hidden state ID before patching', () => {
    expect(ciWorkflowSource).toContain('workflow-report')
    expect(ciWorkflowSource).toContain('workflow-report:publish')
    expect(workflowReportTaskModuleSource).toContain('find-comment')
    expect(workflowReportTaskModuleSource).toContain(
      'workflow report PR comment skipped for fork pull request',
    )
    expect(workflowReportCommandSource).toContain(
      'workflow report comment body is missing managed state',
    )
    expect(workflowReportCommandSource).toContain('findWorkflowReportManagedComment')
    expect(ciWorkflowSource).toContain('WORKFLOW_REPORT_STATE_ID')
  })
})

describe('ci workflow pnpm cache defaults', () => {
  it('keeps pnpm home stable under runner composition state', () => {
    expect(ciWorkflowSource).toContain(
      'export const ciPnpmHome = `${ciCompositionStateRoot}/pnpm-home`',
    )
  })

  it('defaults the pnpm state helpers to restoring both home and auxiliary store state', () => {
    expect(ciWorkflowSource).toContain(
      'export const ciPnpmStatePaths = [ciPnpmHome, ciPnpmStore].join(',
    )
    expect(ciWorkflowSource).toContain('const path = opts?.path ?? ciPnpmStatePaths')
  })

  it('exports PNPM_CONFIG_STORE_DIR alongside pnpm store state', () => {
    expect(ciWorkflowSource).toContain(
      '`echo "PNPM_CONFIG_STORE_DIR=${ciPnpmStore}" >> "$GITHUB_ENV"`',
    )
  })

  it('uses exact-key pnpm state restore semantics with an explicit versioned prefix', () => {
    expect(restorePnpmStateStepSource).toContain(
      'const keyPrefix = opts?.keyPrefix ?? defaultPnpmStateKeyPrefix',
    )
    expect(restorePnpmStateStepSource).toContain(
      'const hashFilesExpression = opts?.hashFilesExpression ?? defaultPnpmStateHashFilesExpression',
    )
    expect(restorePnpmStateStepSource).toContain("name: 'Restore pnpm state'")
    expect(restorePnpmStateStepSource).not.toContain("'restore-keys':")
  })

  it('centralizes the pnpm state cache contract version at v3', () => {
    expect(ciWorkflowSource).toContain("export const pnpmStateCacheVersion = 'v3'")
    expect(ciWorkflowSource).toContain("export const defaultPnpmStateKeyPrefix = 'pnpm-state'")
    expect(ciWorkflowSource).toContain(
      `const defaultPnpmStateHashFilesExpression = "\${{ hashFiles('**/pnpm-lock.yaml') }}"`,
    )
    expect(ciWorkflowSource).toContain('`${args.keyPrefix}-${pnpmStateCacheVersion}-')
  })

  it('allows repositories to narrow pnpm state hashing without redefining cache steps', () => {
    expect(ciWorkflowSource).toContain('hashFilesExpression?: string')
    expect(ciWorkflowSource).toContain(
      'pnpmStateCachePrimaryKey({ keyPrefix, hashFilesExpression })',
    )
  })

  it('uses identical stable restore/save paths for pnpm and Nix caches', async () => {
    const { restoreNixCacheStep, restorePnpmStateStep, saveNixCacheStep, savePnpmStateStep } =
      await import(
        // oxlint-disable-next-line import/no-dynamic-require
        new URL('../../../../../../genie/ci-workflow/setup.ts', import.meta.url).href
      )
    const pnpmRestore = restorePnpmStateStep()
    const pnpmSave = savePnpmStateStep()
    const nixRestore = restoreNixCacheStep()
    const nixSave = saveNixCacheStep()
    expect(pnpmRestore.with.path).toBe(pnpmSave.with.path)
    expect(nixRestore.with.path).toBe(nixSave.with.path)
    expect(pnpmRestore.with.path).not.toContain('github.run_id')
    expect(nixRestore.with.path).not.toContain('github.run_id')
  })

  it('keeps the pnpm store definition stable without caching it in CI', () => {
    expect(ciWorkflowSource).toContain(
      'export const ciPnpmStore = `${ciCompositionStateRoot}/pnpm-store-pure-v1`',
    )
    expect(generatedCiWorkflowYamlSource).not.toContain(
      '${{ runner.temp }}/composition-state/pnpm-store-pure-v1',
    )
    expect(generatedCiWorkflowYamlSource).not.toContain('${{ github.workspace }}/.pnpm-store')
    expect(ciWorkflowSource).toContain(
      "ciCompositionStateRoot = '${{ runner.temp }}/composition-state'",
    )
  })

  it('exposes a callable single-publisher primitive and delegates the composer to it', () => {
    expect(ciWorkflowSource).toContain('export const pnpmStatePublisherPostSteps = (opts?: {')
    expect(ciWorkflowSource).toContain('export const withSinglePnpmStatePublisher = <')
    expect(ciWorkflowSource).toContain(
      'opts?.publish === true ? [savePnpmStateStep(opts?.save)] : []',
    )
    expect(ciWorkflowSource).toContain('...pnpmStatePublisherPostSteps({')
  })

  it('only saves pnpm state after prior steps succeed', () => {
    expect(ciWorkflowSource).toContain("name: 'Save pnpm state'")
    expect(ciWorkflowSource).toContain(
      "if: `\\${{ success() && steps.${restoreStepId}.outputs.cache-hit != 'true' }}`",
    )
  })

  it('cold-builds pnpm deps artifacts by evicting cached outputs before the second build', () => {
    expect(coldFreshBuildSource).toContain('installable="${drv}^*"')
    expect(coldFreshBuildSource).toContain('while IFS= read -r outPath; do')
    expect(coldFreshBuildSource).toContain(
      'done < <(nix path-info "$installable" 2>/dev/null || true)',
    )
    expect(coldFreshBuildSource).toContain('...evictOutPathShellLines')
    expect(ciWorkflowSource).toContain('nix store delete --ignore-liveness "$outPath"')
    expect(ciWorkflowSource).toContain(
      'echo "::error::cached pnpm-deps output still present after eviction: $outPath"',
    )
    expect(coldFreshBuildSource).toContain(
      'nix build --no-link "$installable" --option substituters "https://cache.nixos.org"',
    )
  })

  it('prefers explicit depsBuildEntries metadata before falling back to closure scanning', () => {
    expect(pnpmDepsScanSource).toContain('$targetRef.passthru.depsBuildEntries')
    expect(pnpmDepsScanSource).toContain('(.drvPath // "")')
    expect(pnpmDepsScanSource).toContain('grep "pnpm-deps-[a-z0-9-]*-v[0-9]')
  })

  it('keeps the diagnostics summary portable', () => {
    expect(generatedWorkflowSource).toContain('head -n 120 "$markers_file"')
    expect(generatedWorkflowSource).not.toContain('sed -n "1,120p" "$markers_file"')
  })

  it('captures process snapshots without leaking full argv', () => {
    expect(ciWorkflowSource).toContain('stat,comm --sort=-%cpu')
    expect(ciWorkflowSource).toContain('stat,comm -r | head -15')
    expect(ciWorkflowSource).not.toContain('stat,command --sort=-%cpu')
    expect(ciWorkflowSource).not.toContain('stat,command -r | head -15')
  })

  it('purges nix eval cache from the active XDG cache root during repair', () => {
    expect(resolveDevenvScript).toContain(
      'rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}"/nix/eval-cache-* ~/.cache/nix/eval-cache-*',
    )
  })

  it('quotes caller-selected devenv lock paths', () => {
    expect(ciWorkflowSource).toContain(
      'jq -r .nodes.devenv.locked.rev ${shellSingleQuote(lockFile)}',
    )
    expect(ciWorkflowSource).toContain(
      "printf '::error::%s missing .nodes.devenv.locked.rev\\\\n' ${shellSingleQuote(lockFile)}",
    )
  })

  it('retries initial devenv resolution once only for an extracted invalid store path', () => {
    expect(resolveDevenvScript).toContain('[ -n "$invalid_path" ] || return "$rc"')
    expect(resolveDevenvScript.match(/resolve_devenv_once/g)).toHaveLength(3)
    expect(resolveDevenvScript).toContain('nix-store --repair-path "$invalid_path"')
    expect(resolveDevenvScript).not.toContain('Failed to convert config.cachix to JSON')
    expect(resolveDevenvScript).not.toContain('Truncated tar archive')
  })

  it('preserves a non-signature resolution failure status without retrying', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-resolve-devenv-no-retry-'))
    const bin = join(root, 'bin')
    const attempts = join(root, 'attempts')
    const existingOutput = join(root, 'existing-output')
    const existingRootDir = join(root, 'genie-nix-gc-roots')
    const existingRoot = join(existingRootDir, 'devenv-no-retry-1-unit')
    mkdirSync(bin)
    mkdirSync(existingOutput)
    mkdirSync(existingRootDir)
    symlinkSync(existingOutput, existingRoot)
    writeFileSync(
      join(bin, 'nix'),
      `#!${bashBin}\nprintf 'attempt\\n' >> "$NIX_ATTEMPTS"\necho 'ordinary failure' >&2\nexit 23\n`,
    )
    chmodSync(join(bin, 'nix'), 0o755)
    try {
      const result = spawnSync(
        bashBin,
        ['-c', '. "$RESOLVE_DEVENV_SCRIPT"; DEVENV_REV=fixture; resolve_devenv'],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            GITHUB_JOB: 'unit',
            GITHUB_RUN_ATTEMPT: '1',
            GITHUB_RUN_ID: 'no-retry',
            NIX_ATTEMPTS: attempts,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            RESOLVE_DEVENV_SCRIPT: resolveDevenvScriptPath,
            RUNNER_TEMP: root,
          },
        },
      )
      expect(result.status).toBe(23)
      expect(readFileSync(attempts, 'utf8')).toBe('attempt\n')
      expect(readlinkSync(existingRoot)).toBe(existingOutput)
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it('repairs an invalid path and atomically roots the successful retry', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-resolve-devenv-retry-'))
    const bin = join(root, 'bin')
    const attempts = join(root, 'attempts')
    const roots = join(root, 'roots')
    const repairs = join(root, 'repairs')
    const summary = join(root, 'summary')
    const output = join(root, 'devenv-output')
    mkdirSync(bin)
    mkdirSync(output)
    writeFileSync(
      join(bin, 'nix'),
      `#!${bashBin}
set -euo pipefail
attempt=1
if [ -f "$NIX_ATTEMPTS" ]; then attempt=$(( $(${wcBin} -l < "$NIX_ATTEMPTS") + 1 )); fi
printf 'attempt\\n' >> "$NIX_ATTEMPTS"
out_link=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '--out-link' ]; then out_link="$2"; shift 2; else shift; fi
done
printf '%s\\n' "$out_link" >> "$NIX_ROOTS"
if [ "$attempt" -eq 1 ]; then
  echo "error: path '/nix/store/missing-fixture.drv' is not valid" >&2
  exit 17
fi
ln -s "$NIX_OUTPUT" "$out_link"
printf '%s\\n' "$NIX_OUTPUT"
`,
    )
    writeFileSync(
      join(bin, 'nix-store'),
      `#!${bashBin}\nprintf '%s\\n' "$*" >> "$NIX_REPAIRS"\nexit 0\n`,
    )
    chmodSync(join(bin, 'nix'), 0o755)
    chmodSync(join(bin, 'nix-store'), 0o755)
    try {
      const result = spawnSync(
        bashBin,
        ['-c', '. "$RESOLVE_DEVENV_SCRIPT"; DEVENV_REV=fixture; resolve_devenv'],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            GITHUB_JOB: 'unit',
            GITHUB_RUN_ATTEMPT: '1',
            GITHUB_RUN_ID: 'retry',
            GITHUB_STEP_SUMMARY: summary,
            NIX_ATTEMPTS: attempts,
            NIX_OUTPUT: output,
            NIX_REPAIRS: repairs,
            NIX_ROOTS: roots,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            RESOLVE_DEVENV_SCRIPT: resolveDevenvScriptPath,
            RUNNER_TEMP: root,
          },
        },
      )
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toBe(`${output}\n`)
      expect(readFileSync(attempts, 'utf8')).toBe('attempt\nattempt\n')
      const [firstRoot, secondRoot] = readFileSync(roots, 'utf8').trim().split('\n')
      expect(firstRoot).toBe(secondRoot)
      expect(readFileSync(repairs, 'utf8')).toContain(
        '--repair-path /nix/store/missing-fixture.drv',
      )
      expect(readlinkSync(firstRoot!)).toBe(output)
      expect(readFileSync(summary, 'utf8')).toContain('### Recovered Nix store lifecycle incident')
      expect(readFileSync(summary, 'utf8')).toContain('- Attempts: 2/2')
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it('roots the resolved devenv closure in runner job scratch space', () => {
    expect(resolveDevenvScript).toContain('${RUNNER_TEMP:-/tmp}/genie-nix-gc-roots')
    expect(resolveDevenvScript).toContain('--out-link "$DEVENV_GC_ROOT"')
    expect(resolveDevenvScript).not.toContain('rm -f "$DEVENV_GC_ROOT"')
    expect(resolveDevenvScript).toContain(
      '${GITHUB_RUN_ID:-local-$$}-${GITHUB_RUN_ATTEMPT:-0}-${GITHUB_JOB:-job}',
    )
    expect(resolveDevenvScript).toContain('[ ! "$DEVENV_GC_ROOT" -ef "$DEVENV_OUT" ]')
    expect(resolveDevenvScript).not.toContain('readlink -e')
    expect(validateNixStoreStepSource).toContain('resolve-devenv.sh')
    expect(validateNixStoreStepSource).not.toContain('resolve-devenv-ci.sh')
    // The invocation is now nested inside the retry wrapper's single-quoted command, so
    // the script reference carries the escaped inner quotes.
    expect(generatedCiWorkflowYamlSource).toContain(
      `'"'"'\${{ runner.temp }}/composition-state/ci-runtime/resolve-devenv.sh'"'"'`,
    )
    expect(generatedCiWorkflowYamlSource).not.toContain('resolve_devenv_once()')
    expect(
      existsSync(
        new URL(
          ['../../../../../../genie/ci-scripts', 'resolve-devenv-ci.sh'].join('/'),
          import.meta.url,
        ),
      ),
    ).toBe(false)
  })

  it('resolves the locked megarepo CLI through a git flake URL', () => {
    expect(applyMegarepoLockStepSource).toContain(
      'nix run "github:overengineeringstudio/effect-utils/$EU_REV#megarepo"',
    )
    expect(applyMegarepoLockStepSource).not.toContain(
      'nix run "github:overengineeringstudio/effect-utils?ref=$EU_REF&rev=$EU_REV#megarepo"',
    )
  })

  it('installs setup-time megarepo from the locked effect-utils commit without mutating nix profiles', () => {
    expect(installMegarepoStepSource).toContain(
      'MR_REF="github:overengineeringstudio/effect-utils/$EU_REV#megarepo"',
    )
    expect(installMegarepoStepSource).toContain(
      'MR_OUT=$(nix build --no-link --print-out-paths "$MR_REF")',
    )
    expect(installMegarepoStepSource).toContain('${appendGitHubPathLine(\'"$MR_BIN_DIR"\')}')
    expect(installMegarepoStepSource).not.toContain('nix profile install')
  })

  it('only exports skipped megarepo members when the CI lane actually skips members', () => {
    expect(applyMegarepoLockStepSource).toContain('MEGAREPO_SKIP_MEMBERS')
    expect(applyMegarepoLockStepSource).toContain("skipCsv === ''")
    expect(applyMegarepoLockStepSource).toContain(
      "appendGitHubEnvLine({ name: 'MEGAREPO_SKIP_MEMBERS', valueExpression: quotedSkipCsv })",
    )
  })

  it('keeps GitHub env/path printf newlines escaped in shared megarepo steps', () => {
    expect(ciWorkflowSource).toContain('const appendGitHubPathLine = (valueExpression: string)')
    expect(ciWorkflowSource).toContain('`printf \'%s\\\\n\' ${valueExpression} >> "$GITHUB_PATH"`')
    expect(ciWorkflowSource).toContain(
      '`printf \'${name}=%s\\\\n\' ${valueExpression} >> "$GITHUB_ENV"`',
    )
    expect(installMegarepoStepSource).not.toContain("printf '%s\n'")
    expect(applyMegarepoLockStepSource).not.toContain("printf 'MEGAREPO_STORE=%s\n'")
    expect(applyMegarepoLockStepSource).not.toContain("printf 'MEGAREPO_SKIP_MEMBERS=%s\n'")
    expect(generatedCiWorkflowYamlSource).not.toContain("printf '%s\n")
    expect(generatedCiWorkflowYamlSource).not.toContain("printf 'MEGAREPO_STORE=%s\n")
    expect(generatedCiWorkflowYamlSource).not.toContain("printf 'MEGAREPO_SKIP_MEMBERS=%s\n")
  })

  it('passes skipped megarepo members as one comma-separated CLI option', () => {
    expect(megarepoTaskModuleSource).toContain('MR_SKIP_ARGS+=(--skip "$_mr_skip_csv")')
    expect(megarepoTaskModuleSource).not.toContain('MR_SKIP_ARGS+=(--skip "$member")')
  })

  it('accepts current, historical, and nested mr ls success payloads', () => {
    expect(megarepoTaskModuleSource).toContain(
      '(.members // .value.members // .value.value.members // [])',
    )
    expect(megarepoTaskModuleSource).not.toContain('.value.members[].name')
  })

  it('normalizes GitHub branch refs through an explicit default-ref policy option', () => {
    expect(defaultRefPolicyCheckStepSource).toContain('normalizeGitBranchRefs?: boolean')
    expect(defaultRefPolicyCheckStepSource).toContain('NORMALIZE_GIT_BRANCH_REFS')
    expect(defaultRefPolicyCheckStepSource).toContain("ref.startsWith('refs/heads/')")
  })

  it('allows only explicitly opted-in immutable legacy member refs', () => {
    expect(defaultRefPolicyCheckStepSource).toContain('allowLegacyMemberCommitRefs?: boolean')
    expect(defaultRefPolicyCheckStepSource).toContain('ALLOW_LEGACY_MEMBER_COMMIT_REFS')
    expect(defaultRefPolicyCheckStepSource).toContain("memberName.endsWith('-legacy')")
    expect(defaultRefPolicyCheckStepSource).toContain(
      'const immutableCommitRef = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i',
    )
    expect(defaultRefPolicyCheckStepSource).toContain(
      'isAllowedLegacyMemberRef({ memberName, ref: normalizedRef })',
    )
  })

  it('retries temporary git repository cleanup after reachability checks', () => {
    expect(defaultRefPolicyCheckStepSource).toContain(
      'fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })',
    )
  })

  it('uses the same Nix-provided Node runtime for default-ref policy checks', () => {
    expect(ciWorkflowSource).toContain('nix shell nixpkgs#nodejs_24 -c node')
  })

  it('provides a dedicated default-ref policy job so regular jobs keep their signal', () => {
    expect(ciWorkflowSource).toContain('export const defaultRefPolicyCheckJob')
    expect(ciWorkflowSource).toContain('name === undefined ? {} : { name }')
    expect(ciWorkflowSource).toContain('defaultRefPolicyCheckStep(stepOpts)')
  })
})

describe('ci workflow merge queue helpers', () => {
  it('centralizes the Hypermerge semantic required checks and admission label expressions', () => {
    expect(mergeQueueSource).toContain('mergeQueueRequiredCIJobs')
    expect(mergeQueueSource).toContain('mq/admission')
    expect(mergeQueueSource).toContain('pr/quality')
    expect(mergeQueueSource).toContain('pr/topology')
    expect(mergeQueueSource).toContain('pr/freshness')
    expect(mergeQueueSource).toContain('pr/contract')
    expect(mergeQueueSource).toContain('mq:ci-admitted')
  })

  it('preserves label control-event concurrency for scarce self-hosted runners', () => {
    expect(mergeQueueSource).toContain('mergeQueueWorkflowConcurrency')
    expect(mergeQueueSource).toContain('mergeQueueWorkflowOn')
    expect(mergeQueueSource).toContain('merge_group: githubWorkflowEvent.all')
    expect(mergeQueueSource).toContain("format('label-{0}', github.event.label.name)")
    expect(mergeQueueSource).toContain(
      "github.event.action != 'labeled' && github.event.action != 'unlabeled'",
    )
  })

  it('exports reusable admission and semantic gate jobs', () => {
    expect(ciWorkflowSource).toContain('export const mergeQueueAdmissionGateJob')
    expect(ciWorkflowSource).toContain('export const mergeQueueAdmittedJob')
    expect(ciWorkflowSource).toContain('export const mergeQueueSemanticGateJob')
    expect(ciWorkflowSource).toContain('export const mergeQueueSemanticGateJobs')
    expect(ciWorkflowSource).toContain('trustNeedsAdmission: true')
    expect(ciWorkflowSource).toContain('requiredGateCheckName(name)')
  })

  it('hardens dynamic semantic gate names and admission-job permissions', async () => {
    const { mergeQueueAdmittedJob, mergeQueueWorkflowOn, requiredGateCheckName } = (await import(
      // oxlint-disable-next-line import/no-dynamic-require
      new URL('../../../../../../genie/ci-workflow/merge-queue.ts', import.meta.url).href
    )) as any

    expect(requiredGateCheckName("pr/quality's gate")).toBe(
      "${{ ((github.event_name != 'pull_request' || (github.event.action != 'labeled' && github.event.action != 'unlabeled') || (github.event.action == 'labeled' && github.event.label.name == 'mq:ci-admitted')) && (github.event_name != 'pull_request' || (contains(github.event.pull_request.labels.*.name, 'mq:ci-admitted') || (github.event.action == 'labeled' && github.event.label.name == 'mq:ci-admitted')))) && 'pr/quality''s gate' || 'pr/quality''s gate (control event)' }}",
    )

    const runsOn = ['sh-linux-x64', 'nix'] as const
    const admittedJob = mergeQueueAdmittedJob({
      runsOn,
      permissions: { actions: 'read' },
      steps: [{ name: 'Proof', run: 'true' }],
    })

    expect(admittedJob['runs-on']).toEqual(['sh-linux-x64', 'nix'])
    expect(admittedJob['runs-on']).not.toBe(runsOn)
    expect(admittedJob.permissions).toEqual({
      actions: 'read',
      contents: 'read',
      issues: 'read',
      'pull-requests': 'read',
    })
    expect(mergeQueueWorkflowOn()).toMatchObject({
      merge_group: { _tag: 'GitHubWorkflowEventAll' },
    })
  }, 20_000)
})

describe('ci workflow shared auth helpers', () => {
  it('supports minting GitHub App installation tokens for downstream private inputs', () => {
    expect(ciWorkflowSource).toContain('export const githubAppInstallationTokenStep')
    expect(ciWorkflowSource).toContain("uses: 'actions/create-github-app-token@v3' as const")
  })

  it('lets installNixStep override the GitHub access token expression', () => {
    expect(ciWorkflowSource).toContain('githubAccessTokenExpression?: string')
    expect(ciWorkflowSource).toContain(
      "access-tokens = github.com=${opts?.githubAccessTokenExpression ?? '${{ github.token }}'}",
    )
  })

  it('lets installNixStep disable Determinate summaries when runners reuse a preinstalled Nix', () => {
    expect(ciWorkflowSource).toContain('summarize?: boolean')
    expect(ciWorkflowSource).toContain('summarize: opts?.summarize ?? true')
  })

  it('exposes a dedicated env helper for self-hosted wrapper auth', () => {
    expect(ciWorkflowSource).toContain('export const githubAccessTokenEnv')
    expect(ciWorkflowSource).toContain('GITHUB_TOKEN: tokenExpression')
    expect(ciWorkflowSource).toContain('GH_TOKEN: tokenExpression')
    expect(ciWorkflowSource).toContain('export const withGitHubAccessTokenEnv')
  })

  it('can wrap shell steps with job-local private Cachix read auth', () => {
    expect(ciWorkflowSource).toContain('export const withPrivateCachixReadAuth')
    expect(ciWorkflowSource).toContain('CACHIX_AUTH_TOKEN: opts.authTokenExpression')
    expect(ciWorkflowSource).toContain(
      'cachix_netrc="$(mktemp "${RUNNER_TEMP:-/tmp}/cachix-netrc.XXXXXX")"',
    )
    expect(ciWorkflowSource).toContain('netrc-file = $cachix_netrc')
    expect(ciWorkflowSource).toContain('export NIX_CONFIG="$NIX_CONFIG_WITH_APPEND"')
  })

  it('only appends GitHub access tokens to NIX_CONFIG through GITHUB_ENV', () => {
    expect(ciWorkflowSource).toContain('export const appendGitHubAccessTokenToNixConfigStep')
    expect(ciWorkflowSource).toContain('access-tokens = github.com=%s')
    expect(ciWorkflowSource).not.toContain(
      'printf "GITHUB_TOKEN=%s\\nGH_TOKEN=%s\\n" "$token" "$token"',
    )
  })

  it('pins the shared CI actions to the Node-24-safe majors', () => {
    expect(ciWorkflowSource).toContain(
      "export const defaultCheckoutActionRef = 'actions/checkout@v6'",
    )
    expect(ciWorkflowSource).toContain(
      "export const defaultCachixActionRef = 'cachix/cachix-action@v17'",
    )
    expect(ciWorkflowSource).toContain(
      "export const defaultInstallNixActionRef = 'DeterminateSystems/determinate-nix-action@v3'",
    )
  })

  it('offers immutable commit pins of those same majors for credential-bearing jobs', () => {
    // A floating major is mutable, so the jobs that hold a credential while a
    // third-party action runs take the digest instead. Only those jobs pay the
    // repinning cost, which is why the defaults above stay on major tags.
    expect(ciWorkflowSource).toContain('export const credentialBearingActionPins')
    expect(ciWorkflowSource).toContain(
      "checkout: 'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803'",
    )
    expect(ciWorkflowSource).toContain(
      "'DeterminateSystems/determinate-nix-action@021c8a1bd3570eb21f5c20a054812b0c4d9ca614'",
    )
    expect(ciWorkflowSource).toContain(
      "cachix: 'cachix/cachix-action@38b082610b782e7e93e209c35fd730d399dee866'",
    )
  })

  it('provides cachix CLI from /nix/store on PATH instead of mutating the runner nix profile', () => {
    expect(ciWorkflowSource).toContain('export const cachixCliBuildStep')
    expect(ciWorkflowSource).toContain('nix build --no-link --print-out-paths nixpkgs#cachix')
    expect(ciWorkflowSource).toContain('echo "$out/bin" >> "$GITHUB_PATH"')
  })

  it('keeps cachixStep free of installCommand so cachix-action short-circuits via PATH', () => {
    const cachixStepSource = extractSourceBlock(ciWorkflowSource, 'export const cachixStep', '})\n')
    expect(cachixStepSource).not.toContain('installCommand')
    expect(cachixStepSource).not.toContain('nix profile install')
  })

  it('uses first-party Nix-packaged provider CLIs instead of runtime npm execution', () => {
    expect(netlifyTaskModuleSource).toContain('/nix/provider-clis/netlify-cli')
    expect(netlifyTaskModuleSource).toContain('netlifyBin ? null')
    expect(netlifyTaskModuleSource).not.toContain('pkgs.netlify-cli')
    expect(netlifyTaskModuleSource).not.toContain('bunx netlify-cli@24.11.3')
    expect(vercelTaskModuleSource).toContain('/nix/provider-clis/vercel-cli')
    expect(vercelTaskModuleSource).toContain('vercelCliPkg ? null')
    expect(vercelTaskModuleSource).not.toContain('bunx vercel')
    // Provider-CLI authority is the devenv task module, which defaults to the
    // first-party `nix/provider-clis/*` package (asserted above). The workflow
    // therefore builds no provider CLI of its own — it invokes the task, and
    // the contract it must keep is that no step reaches for a registry or
    // nixpkgs CLI at run time.
    expect(generatedCiWorkflowYamlSource).toContain('devenv tasks run netlify:deploy')
    expect(generatedWorkflowSource).not.toContain('nixpkgs#netlify-cli')
    expect(generatedWorkflowSource).not.toContain('nixpkgs#vercel-cli')
    expect(generatedWorkflowSource).not.toContain('bunx netlify')
    expect(generatedWorkflowSource).not.toContain('bunx vercel')
    expect(generatedWorkflowSource).not.toContain('npx netlify')
    expect(generatedWorkflowSource).not.toContain('npx vercel')
  })

  it('lets Vercel deploy jobs decorate the deploy run step', () => {
    expect(ciWorkflowSource).toContain('deployStepDecorator?: (')
    expect(ciWorkflowSource).toContain('project: VercelProject')
    expect(vercelDeploySource).toContain('opts.deployStepDecorator?.(')
    expect(vercelDeploySource).toContain(
      'vercelDeployStep({ project, runDevenvTasksBefore: opts.runDevenvTasksBefore })',
    )
  })

  it('does not require a Netlify workflow report on manual runs that do not deploy', () => {
    expect(netlifyDeploySource).toContain('deploy_ran=0')
    expect(netlifyDeploySource).toContain(
      'if [ "$deploy_ran" = "1" ] && [ ! -s "$workflow_report_path" ]; then',
    )
    expect(netlifyDeploySource).toContain(
      'echo "workflow_report_path=$workflow_report_path" >> "$GITHUB_OUTPUT"',
    )
  })
})

describe('ci workflow standard job helpers', () => {
  it('centralizes self-hosted devenv task job composition', () => {
    expect(ciWorkflowSource).toContain('export const devenvTaskStep')
    expect(ciWorkflowSource).toContain('export const standardSelfHostedDevenvTaskJob')
    expect(ciWorkflowSource).toContain('standardSelfHostedPnpmCiPrepSteps(prep)')
    expect(ciWorkflowSource).toContain('standardSelfHostedPnpmCiPostSteps(post)')
  })

  /**
   * `buck2 build`/`test`/`run` parse every positional as a target PATTERN, never as a query
   * expression — not even as the sole argument, where it dies in `Parsing target pattern`
   * with `Invalid target name '...)'`. A query must therefore be expanded by a separate
   * `uquery`, and the two ways that expansion can go wrong must stay distinguishable: a
   * FAILING query has to surface Buck's own nonzero exit, while a SUCCEEDING query that
   * matched nothing has to fail on its own, because `buck2 build` with an empty argv
   * succeeds and would fake a green lane.
   */
  it('expands Buck queries through uquery instead of passing them where a target pattern is parsed', () => {
    const invocations = [
      ...generatedCiWorkflowYamlSource.matchAll(
        /"\$buck2" (?<verb>build|test|run) (?<positionals>.*)$/gmu,
      ),
    ]
    expect(invocations.length).toBeGreaterThan(0)
    for (const invocation of invocations) {
      expect(invocation.groups?.positionals, invocation[0]).not.toContain('(')
    }

    // A plain command substitution propagates a nonzero `uquery` exit under `bash -e`.
    // `mapfile -t targets < <(...)` would swallow it, because `mapfile` reports its own
    // status and never the producer's, so the two failure modes would be conflated into
    // "matched no targets" — the wrong diagnostic and the wrong exit code.
    expect(generatedCiWorkflowYamlSource).not.toContain('mapfile -t targets < <(')
    const expansions = [
      ...generatedCiWorkflowYamlSource.matchAll(
        /targets_raw="\$\("\$buck2" uquery '(?<query>[^']+)'\)"/gmu,
      ),
    ]
    expect(expansions.map((expansion) => expansion.groups?.query)).toEqual([
      'filter(":typecheck$", effect_utils//...)',
      'filter("(candidate-smoke|bundle_smoke_candidate)$", effect_utils//packages/@overeng/...)',
    ])
    for (const expansion of expansions) {
      // Emptiness is checked on the captured output, so it can only be reached once the
      // query itself exited zero.
      expect(generatedCiWorkflowYamlSource, expansion[0]).toContain(
        `[ -n "$targets_raw" ] || { echo '::error::buck2 uquery matched no targets: ${expansion.groups?.query}'; exit 1; }`,
      )
    }
    // The array is split from the already-captured output, never from a fresh subshell.
    expect(
      generatedCiWorkflowYamlSource.split('mapfile -t targets <<< "$targets_raw"').length - 1,
    ).toBe(expansions.length)

    // `package_bin_check` returns no `ExternalRunnerTestInfo`, so the smoke candidates are
    // build-only; one query covers both candidate naming schemes that used to need a
    // query plus a hand-listed literal target.
    const bundleSmoke =
      generatedCiWorkflowYamlSource.split('  bundle-smoke:\n')[1]?.split(/^  [a-z]/mu)[0] ?? ''
    expect(bundleSmoke).toContain('"$buck2" build "${targets[@]}"')
    expect(bundleSmoke).not.toContain('"$buck2" test')
    // Both query lanes reach that shape through one generator helper.
    expect(generatedWorkflowSource).toContain('const buildBuck2QueryTargets = (query: string) =>')
    expect(generatedWorkflowSource.split('buildBuck2QueryTargets(').length - 1).toBe(2)
  })
})

describe('ci workflow namespace privileged containers', () => {
  const privilegedFeature = 'container.privileged=true'
  const runIdFeature = 'github.run-id=${{ github.run_id }}'
  const linuxProfile = 'namespace-profile-linux-x86-64'
  const rawPerfLabel = 'nscloud-ubuntu-24.04-amd64-16x64-with-features'

  /**
   * The exact `runs-on` label array of one generated job.
   *
   * Labels are scanned rather than string-matched so an assertion cannot pass on a
   * substring of a longer, differently-shaped label.
   */
  const generatedRunnerLabels = (jobKey: string): string[] => {
    const afterHeader = generatedCiWorkflowYamlSource.split(`\n  ${jobKey}:\n`)[1]
    if (afterHeader === undefined) throw new Error(`missing generated job: ${jobKey}`)
    const jobBody = afterHeader.split(/\n {2}[a-zA-Z0-9_-]+:\n/)[0] ?? ''
    const fromRunsOn = jobBody.slice(jobBody.indexOf('    runs-on:'))
    const flow = fromRunsOn.slice(fromRunsOn.indexOf('[') + 1, fromRunsOn.indexOf(']'))

    const labels: string[] = []
    let current = ''
    let quote: string | undefined
    for (const char of flow) {
      if (quote !== undefined) {
        if (char === quote) quote = undefined
        else current += char
        continue
      }
      if (char === "'" || char === '"') {
        quote = char
        continue
      }
      if (char === ',') {
        labels.push(current.trim())
        current = ''
        continue
      }
      current += char
    }
    if (current.trim() !== '') labels.push(current.trim())
    return labels.filter((label) => label !== '')
  }

  /** The job-level `env:` value of one generated job. */
  const generatedJobEnvValue = (jobKey: string, name: string) => {
    const afterHeader = generatedCiWorkflowYamlSource.split(`\n  ${jobKey}:\n`)[1]
    if (afterHeader === undefined) throw new Error(`missing generated job: ${jobKey}`)
    const jobBody = afterHeader.split(/\n {2}[a-zA-Z0-9_-]+:\n/)[0] ?? ''
    const line = jobBody.match(new RegExp(`^ {6}${name}: (.*)$`, 'm'))?.[1]
    if (line === undefined) throw new Error(`missing ${name} in job: ${jobKey}`)
    return line.replace(/^'(.*)'$/, '$1')
  }

  /**
   * The two admissible privileged label ARRAYS, one per Namespace label kind. They are not
   * interchangeable: `;container.privileged=true` is a feature suffix of a
   * `namespace-profile-*` label, while a raw runner label (`nscloud-*`) must stay verbatim
   * and carry the feature as an entry of the companion `namespace-features:` label.
   */
  const privilegedProfileLabels = [
    `${linuxProfile};${privilegedFeature}`,
    `namespace-features:${runIdFeature}`,
  ]
  const privilegedRawLabels = [
    rawPerfLabel,
    `namespace-features:${privilegedFeature};${runIdFeature}`,
  ]
  const unprivilegedProfileLabels = [linuxProfile, `namespace-features:${runIdFeature}`]

  /**
   * Every job whose payload executes a sandboxed Buck action: direct `runBuck2`, a devenv
   * task that shells out to `buck2`, or the dispatch-only DQ cache/capacity lanes.
   *
   * `lint` is here on empirical grounds: run 34047874617 failed its `lint:check` step with
   * `bwrap: pivot_root: Operation not permitted` across dist/typecheck targets, so the
   * generated-freshness prerequisites reach Buck actions even though `lint:check` itself
   * spells no `buck2` command.
   */
  const privilegedProfileJobs = [
    'typecheck',
    'lint',
    'test-megarepo-cold-gc',
    'bundle-smoke',
    'buck2',
    'weaver',
    'bootstrap-cold-proof',
    'test-integration-notion',
    'test-integration-restate',
    'test-live-deploy-ci-tools',
    'buck2-cache-publish',
    'buck2-cache-restore',
    'buck2-cache-outage',
    'buck2-capacity',
    'deploy-storybooks',
  ]

  /** Sandboxed-Buck jobs whose runner is not a plain literal profile label. */
  const privilegedRawLabelJobs = ['devenv-perf']
  const privilegedMatrixJobs = ['test']

  /** Jobs that run no Buck action, so they must keep the default unprivileged container. */
  const unprivilegedJobs = [
    'default-ref-policy',
    'pnpm-regression',
    'cargo',
    'nix-closure-sizes',
    'source-shape',
    'ci-measurements-report',
    'notify-alignment',
  ]

  it('emits the exact privileged profile-label array for every literal-profile Buck job', () => {
    // Bubblewrap's `pivot_root` is refused in the default unprivileged Namespace container,
    // so the fail-closed containment contract cannot run without this feature.
    for (const jobKey of privilegedProfileJobs) {
      expect(generatedRunnerLabels(jobKey), jobKey).toEqual(privilegedProfileLabels)
    }

    expect(
      privilegedProfileJobs.length +
        privilegedRawLabelJobs.length +
        privilegedMatrixJobs.length +
        unprivilegedJobs.length,
    ).toBe(generatedCiJobKeys.length)
  })

  it('keeps a raw runner label verbatim and moves the feature into namespace-features', () => {
    // `;container.privileged=true` is only valid on a `namespace-profile-*` label. The
    // paired perf lane runs on a raw Namespace runner label, so suffixing it would name a
    // runner that does not exist.
    for (const jobKey of privilegedRawLabelJobs) {
      expect(generatedRunnerLabels(jobKey), jobKey).toEqual(privilegedRawLabels)
    }
    expect(generatedCiWorkflowYamlSource).not.toContain(`${rawPerfLabel};${privilegedFeature}`)
  })

  it('emits the exact unprivileged array for every job with no Buck action', () => {
    for (const jobKey of unprivilegedJobs) {
      expect(generatedRunnerLabels(jobKey), jobKey).toEqual(unprivilegedProfileLabels)
    }
  })

  it('privileges only the Linux leg of the platform matrix', () => {
    expect(generatedRunnerLabels('test')).toEqual([
      `\${{ matrix.runner == '${linuxProfile}' && '${linuxProfile};${privilegedFeature}' || matrix.runner }}`,
      `namespace-features:${runIdFeature}`,
    ])
    // macOS never resolves to a privileged label anywhere in the workflow.
    expect(generatedCiWorkflowYamlSource).not.toContain(
      `namespace-profile-macos-arm64;${privilegedFeature}`,
    )
  })

  it('keeps the matrix values, and therefore the required check contexts, unchanged', () => {
    // GitHub derives the check name from the matrix VALUE, not from the resolved runner
    // label, so `test (namespace-profile-linux-x86-64)` survives the privileged runs-on.
    expect(generatedCiWorkflowYamlSource).toContain(`runner: [${matrixRunners.join(', ')}]`)
    for (const runner of matrixRunners) {
      expect(generatedRequiredCheckContexts).toContain(`test (${runner})`)
    }
  })

  it('derives measurement runner provenance from the labels actually requested', () => {
    // The paired perf lane records its runner class as the joined `runs-on` labels, so the
    // recorded provenance must be the raw-label form verbatim, feature label included.
    expect(generatedJobEnvValue('devenv-perf', 'RUNNER_CLASS')).toBe(privilegedRawLabels.join(','))
    // The profile-form measurement lanes derive their class from the runner context instead,
    // so no privileged feature may leak into their provenance.
    expect(generatedCiWorkflowYamlSource).toContain(
      "RUNNER_CLASS: '${{ runner.os }}-${{ runner.arch }}'",
    )
    for (const [jobKey, labels] of [
      ['nix-closure-sizes', unprivilegedProfileLabels],
      ['source-shape', unprivilegedProfileLabels],
    ] as const) {
      expect(generatedRunnerLabels(jobKey), jobKey).toEqual(labels)
    }
  })

  it('derives every privileged label from the shared generator helpers', () => {
    expect(ciWorkflowSource).toContain(
      `export const namespacePrivilegedContainerFeature = '${privilegedFeature}'`,
    )
    expect(ciWorkflowSource).toContain(
      'export const namespacePrivilegedContainerSuffix = `;${namespacePrivilegedContainerFeature}`',
    )
    expect(ciWorkflowSource).toContain(
      `export const namespaceProfileLabelPrefix = 'namespace-profile-'`,
    )
    expect(ciWorkflowSource).toContain('export const namespacePrivilegedProfile')
    expect(ciWorkflowSource).toContain('export const namespacePrivilegedMatrixProfile')
    // The label kind decides where the feature goes; the generator never hand-writes either
    // spelling.
    expect(ciWorkflowSource).toContain('profile.startsWith(namespaceProfileLabelPrefix)')
    expect(generatedWorkflowSource).not.toContain(privilegedFeature)
  })

  it('refuses privileged mode on a raw label that cannot honor namespace-features', async () => {
    // Dynamic on purpose: `genie/ci-workflow` lives outside this package's `rootDir`, so a
    // static import would break the package's own type-check boundary (same pattern as the
    // pnpm/Nix cache-step test above).
    const { namespaceRunner } = await import(
      // oxlint-disable-next-line import/no-dynamic-require
      new URL('../../../../../../genie/ci-workflow/setup.ts', import.meta.url).href
    )
    const runId = '${{ github.run_id }}'

    // A raw machine label only honors the companion `namespace-features:` label when it ends
    // with `-with-features`, so emitting the pair for any other raw label would silently
    // drop privileged mode and reintroduce the `pivot_root` failure.
    expect(() =>
      namespaceRunner({ profile: 'nscloud-ubuntu-24.04-amd64-16x64', runId, privileged: true }),
    ).toThrow(
      'namespaceRunner: privileged mode is unavailable on raw runner label "nscloud-ubuntu-24.04-amd64-16x64": a non-profile label must end with "-with-features" to honor namespace-features',
    )

    // The same label is fine unprivileged, and both valid privileged callers are unchanged.
    expect(namespaceRunner({ profile: 'nscloud-ubuntu-24.04-amd64-16x64', runId })).toEqual([
      'nscloud-ubuntu-24.04-amd64-16x64',
      `namespace-features:${runIdFeature}`,
    ])
    expect(namespaceRunner({ profile: rawPerfLabel, runId, privileged: true })).toEqual(
      privilegedRawLabels,
    )
    expect(namespaceRunner({ profile: linuxProfile, runId, privileged: true })).toEqual(
      privilegedProfileLabels,
    )
  })
})

describe('ci workflow devenv perf helpers', () => {
  it('exposes reusable devenv perf CI job helpers', () => {
    expect(ciWorkflowSource).toContain('export const devenvPerfJob')
    expect(ciWorkflowSource).toContain('export const devenvPerfBenchmarkStep')
    expect(ciWorkflowSource).toContain('export const devenvPerfArtifactStep')
    expect(ciWorkflowSource).toContain('export type CiMeasurementDescriptor')
    expect(ciWorkflowSource).toContain('export type DevenvPerfProbe')
    expect(ciWorkflowSource).toContain('export type DevenvPerfTaskProbe')
    expect(ciWorkflowSource).toContain('export const nixClosureMeasurementStep')
    expect(ciWorkflowSource).toContain('export const nixClosureMeasurementSteps')
    expect(ciWorkflowSource).toContain('export const nixClosureMeasurementsJob')
    expect(ciWorkflowSource).toContain('export const defaultNixClosureMeasurementBuckets')
    expect(ciWorkflowSource).toContain('export type NixClosureMeasurementBucket')
    expect(ciWorkflowSource).toContain('export type NixClosureMeasurementTarget')
  })

  it('emits the standard warm shell and task-list probes with native trace artifacts', () => {
    expect(generatedCiWorkflowYamlSource).toContain('devenv-perf:')
    expect(generatedCiWorkflowYamlSource).toContain('OTEL_SERVICE_NAME: devenv-perf-ci')
    expect(generatedCiWorkflowYamlSource).toContain(
      "measure 'shell_eval_traced' 'Shell eval with OTEL trace' 'devenv shell' 'Evaluates the dev shell with native devenv JSON tracing enabled.' '$ARTIFACT_DIR/traces/shell_eval_traced.json' '0' '1'",
    )
    expect(generatedCiWorkflowYamlSource).toContain('--trace-to')
    expect(generatedCiWorkflowYamlSource).toContain('json:file:$trace_file')
    expect(generatedCiWorkflowYamlSource).toContain('$ARTIFACT_DIR/traces/shell_eval_traced.json')
    expect(generatedCiWorkflowYamlSource).toContain(
      `paired_baseline_enabled="$(jq -r 'if .enabled == true then 1 else 0 end' <<<"$gate_policy")"`,
    )
    expect(generatedCiWorkflowYamlSource).toContain(
      `if [ "$phase" = "warmup" ] && [ "$CI_MEASUREMENT_PAIRED_ENABLED" -eq 1 ] && [ "$paired_baseline_enabled" -eq 1 ]; then`,
    )
    expect(generatedCiWorkflowYamlSource).toContain('subject:"base",phase:"warmup",status:$status')
    expect(generatedDevenvPerfJob).toContain('timeout-minutes: 90')
    expect(generatedDevenvPerfJob).toContain('nscloud-ubuntu-24.04-amd64-16x64-with-features')
    expect(generatedCiWorkflowYamlSource).toContain("measure 'shell_eval_warm' 'Warm shell eval'")
    expect(generatedCiWorkflowYamlSource).toContain("measure 'tasks_list' 'devenv tasks list'")
    expect(generatedCiWorkflowYamlSource).toContain(
      "'Loads the devenv processes command help path.' '' '1' '9'",
    )
  })

  it('writes a stable summary artifact for regression tracking', () => {
    expect(generatedCiWorkflowYamlSource).toContain('schemaVersion: $schemaVersion')
    expect(generatedCiWorkflowYamlSource).toContain('checks: ($timings[0] | map')
    expect(generatedCiWorkflowYamlSource).toContain('measurements.json')
    expect(generatedCiWorkflowYamlSource).toContain('--argjson schemaVersion 1')
    expect(generatedCiWorkflowYamlSource).toContain('effect-utils-ci-measurement')
    expect(generatedCiWorkflowYamlSource).toContain('devenv." + .id + ".duration')
    expect(generatedCiWorkflowYamlSource).toContain(
      'target: { kind: "devenv", id: "dev-shell", name: "dev-shell", label: "Dev shell", group: "devenv", system: $targetSystem }',
    )
    expect(generatedCiWorkflowYamlSource).toContain('probeLabel: .label')
    expect(generatedCiWorkflowYamlSource).toContain('sampleCount: (.statistics.sampleCount // 1)')
    expect(generatedCiWorkflowYamlSource).toContain(
      '| Probe | Runs | Head total | Base total | Head median | Paired delta | Measured share |',
    )
    expect(generatedCiWorkflowYamlSource).toContain(
      'map([.samples[]?.durationMs] | add // 0) | add',
    )
    expect(generatedCiWorkflowYamlSource).toContain('baselineSources')
    expect(generatedCiWorkflowYamlSource).toContain('low_baseline_count')
    expect(generatedCiWorkflowYamlSource).toContain('low_current_sample_count')
    expect(generatedCiWorkflowYamlSource).toContain('low_paired_sample_count')
    expect(generatedCiWorkflowYamlSource).toContain('readiness:$readiness')
    expect(generatedCiWorkflowYamlSource).toContain(
      'enforceable: (.enabledCount == .gateableCount)',
    )
    expect(generatedCiWorkflowYamlSource).toContain('within_baseline_range')
    expect(generatedCiWorkflowYamlSource).toContain(
      'elif $needsHistoricalBaselineCount and $baselineSources < ($policy.minBaselineSources // 1) then "low_baseline_count"',
    )
    expect(generatedCiWorkflowYamlSource).toContain(
      'elif $currentSamples < ($policy.minCurrentSamples // 1) then "low_current_sample_count"',
    )
    expect(generatedCiWorkflowYamlSource).toContain(
      'if ($gateable and $confidence == "threshold_exceeded") then $thresholdStatus',
    )
    expect(generatedCiWorkflowYamlSource).toContain(
      'elif ($canUseRobustBandSuppression and $thresholdStatus != "pass" and $withinRobustBand) then "within_robust_band"',
    )
    expect(ciWorkflowSource).toContain("label: 'Needs more baseline'")
    expect(ciWorkflowSource).toContain("label: 'Needs repeat'")
    expect(ciWorkflowSource).toContain("label: 'Needs paired evidence'")
    expect(ciWorkflowSource).toContain("label: 'Too small to matter'")
    expect(ciWorkflowSource).toContain("label: 'Within noise band'")
    expect(ciWorkflowSource).toContain("label: 'Meaningfully lower'")
    expect(generatedCiWorkflowYamlSource).toContain('RUNNER_CLASS:')
    expect(generatedCiWorkflowYamlSource).toContain('namespace-profile-linux-x86-64')
    expect(ciWorkflowSource).toContain('nix.closure.nar_size')
    expect(ciWorkflowSource).toContain('nix.closure.path_count')
    expect(ciWorkflowSource).toContain('nix.closure.bucket.nar_size')
    expect(ciWorkflowSource).toContain('artifact_file=${artifactFileAssignment}')
    expect(ciWorkflowSource).not.toContain('artifact_file=${shellSingleQuote(artifactFile)}')
    expect(ciWorkflowSource).toContain(
      'target: { kind: "nix-closure", id: $targetId, name: $targetName, label: $targetLabel, group: $targetGroup, path: $targetPath, system: $targetSystem }',
    )
    expect(ciWorkflowSource).toContain(
      'topPaths: ($closurePaths | sort_by(.narSize) | reverse | .[:30])',
    )
    expect(generatedCiWorkflowYamlSource).not.toContain('dev3')
    expect(generatedCiWorkflowYamlSource).not.toContain('perf-comparison.json')
    expect(generatedCiWorkflowYamlSource).not.toContain('DEVENV_PERF_REGRESSION_MODE')
    expect(generatedCiWorkflowYamlSource).toContain('devenv-perf-warm-median-v2')
    expect(generatedCiWorkflowYamlSource).toContain("CI_MEASUREMENT_PR_COMMENT_ENABLED: 'true'")
    expect(generatedCiWorkflowYamlSource).toContain(
      'CI_MEASUREMENT_PR_COMMENT_TITLE: CI Measurements',
    )
    expect(generatedCiWorkflowYamlSource).toContain('BASELINE_SEED_RUNS_JSON:')
    expect(generatedCiWorkflowYamlSource).toContain('BASELINE_REQUIRED_OBSERVATIONS_JSON:')
    expect(generatedCiWorkflowYamlSource).toContain('BASELINE_MAX_CANDIDATE_RUNS:')
    expect(generatedCiWorkflowYamlSource).toContain("measure 'task_check_quick_warm'")
    expect(generatedCiWorkflowYamlSource).toContain("measure 'task_check_quick_forced'")
    expect(generatedCiWorkflowYamlSource).not.toContain('"id":"devenv.task_check_quick.duration"')
    expect(ciWorkflowSource).toContain(
      'requiredObservations?: readonly CiMeasurementRequiredBaselineObservation[]',
    )
    expect(ciWorkflowSource).toContain('baselineMaxCandidateRuns?: number')
    expect(ciWorkflowSource).toContain('baseline_requirements_satisfied')
    expect(ciWorkflowSource).toContain('observationCounts: ($observationCounts[0] // null)')
    expect(generatedCiWorkflowYamlSource).toContain('"runId":"26085158592"')
    expect(generatedCiWorkflowYamlSource).toContain('"label":"main baseline"')
    expect(generatedCiWorkflowYamlSource).toContain('Upload devenv perf artifacts')
    expect(generatedCiWorkflowYamlSource).toContain('retention-days: 7')
    expect(generatedCiWorkflowYamlSource).toContain('retention-days: 14')
    expect(ciWorkflowSource).toContain("contents: 'write'")
    expect(ciWorkflowSource).toContain('seedRuns?: readonly CiMeasurementBaselineSeedRun[]')
    expect(ciWorkflowSource).toContain('seedRunIds?: readonly string[]')
    expect(ciWorkflowSource).toContain('baselineSeedRuns?: readonly CiMeasurementBaselineSeedRun[]')
    expect(ciWorkflowSource).toContain('baselineSeedRunIds?: readonly string[]')
    expect(ciWorkflowSource).not.toContain('measurement_pr_number:')
    expect(ciWorkflowSource).not.toContain('CI_MEASUREMENT_PR_COMMENT_PR_NUMBER')
    expect(ciWorkflowSource).toContain(
      'CI measurement PR comments are produced only by pull_request workflows',
    )
    expect(ciWorkflowSource).toContain('unable to publish required CI measurement PR comment')
    expect(ciWorkflowSource).toContain('seedRuns: ($seedRuns[0] // [])')
    expect(ciWorkflowSource).toContain('baselineProvenance: ($baselineProvenance[0] // null)')
    expect(ciWorkflowSource).toContain(
      '["devenvRev", "otelServiceName", "status", "probeLabel", "sampleCount", "measuredSampleCount"] | index($key) | not',
    )
    expect(ciWorkflowSource).toContain('chart_file="$comment_tmp_dir/perf-change-vs-baseline.svg"')
    expect(ciWorkflowSource).toContain(
      'chart_png_file="$comment_tmp_dir/perf-change-vs-baseline.png"',
    )
    expect(ciWorkflowSource).toContain(
      'chart_dark_png_file="$comment_tmp_dir/perf-change-vs-baseline-dark.png"',
    )
    expect(ciWorkflowSource).toContain(
      'No regressions. Comparable movement is below the semantic impact threshold; neutral rows are collapsed below.',
    )
    expect(generatedCiWorkflowYamlSource).toContain(
      'github.workflow }}-${{ github.event_name }}-${{ github.ref }}',
    )
    expect(generatedCiWorkflowYamlSource).not.toMatch(/^concurrency:/m)
    expect(generatedCiWorkflowYamlSource).toContain('concurrency:\n      group:')
    expect(generatedCiWorkflowYamlSource).toContain('}}-typecheck')
    expect(ciWorkflowSource).toContain('export const ciJobConcurrency = ({ jobId, ...opts }:')
    expect(ciWorkflowSource).toContain("opts?.matrix === true ? '-${{ strategy.job-index }}' : ''")
    expect(ciWorkflowSource).toContain('const isMatrixJob = (job: GitHubWorkflowArgs')
    // `test` is the repository's remaining matrix job: the strict `nix-check`
    // matrix went away with the source/FOD CLI producers it guarded, so the
    // per-index concurrency contract is asserted on the job that still exists.
    expect(generatedCiWorkflowYamlSource).toContain('}}-test-${{ strategy.job-index }}')
    expect(generatedCiWorkflowYamlSource).not.toContain('nix-check')
    expect(generatedCiWorkflowYamlSource).toContain("format('measurement-baseline-{0}'")
    expect(generatedCiWorkflowYamlSource).not.toContain("format('measurement-pr-{0}-run-{1}'")
    expect(generatedCiWorkflowYamlSource).not.toContain('inputs.measurement_pr_number')
    expect(generatedCiWorkflowYamlSource).toContain("format('manual-run-{0}', github.run_id)")
    expect(generatedCiWorkflowYamlSource).toContain("format('label-{0}', github.event.label.name)")
    expect(generatedCiWorkflowYamlSource).toContain(
      "inputs.measurement_baseline_ref != '') && (github.event_name != 'pull_request'",
    )
    expect(ciWorkflowSource).toContain(
      '| What changed? | Group | Probe | Baseline -> current | Raw change | Impact | Confidence |',
    )
    expect(ciWorkflowSource).toContain('const semanticGroupLabel = (row) =>')
    expect(ciWorkflowSource).toContain('groupedScanTables(visibleNonZeroImpactRows)')
    expect(ciWorkflowSource).toContain(
      'const zeroImpactRows = actionableComparableRows.filter(isZeroImpactRow)',
    )
    expect(ciWorkflowSource).toContain('<summary>Unchanged / 0-impact measurements (')
    expect(ciWorkflowSource).toContain('<summary>Source-of-truth JSON</summary>')
    expect(ciWorkflowSource).toContain('const sourceOfTruth = {')
    expect(ciWorkflowSource).toContain('No non-zero actionable measurement impact detected.')
    expect(ciWorkflowSource).toContain('readiness <code>')
    expect(ciWorkflowSource).toContain('renderPerfChangeSvg')
    expect(ciWorkflowSource).toContain('Actionable measurement impact')
    expect(ciWorkflowSource).toContain(
      '0 means no actionable PR impact; 1x reaches the warning budget.',
    )
    expect(ciWorkflowSource).toContain('@media (prefers-color-scheme: dark)')
    expect(ciWorkflowSource).toContain('.chart-bg { fill: #0d1117; }')
    expect(ciWorkflowSource).toContain('<picture>')
    expect(ciWorkflowSource).toContain('<source media="(prefers-color-scheme: dark)"')
    expect(ciWorkflowSource).toContain('[SVG source]')
    expect(ciWorkflowSource).toContain('ensure_ci_measurement_tool resvg resvg')
    expect(ciWorkflowSource).toContain('nixpkgs#dejavu_fonts')
    expect(ciWorkflowSource).toContain('DejaVu Sans')
    expect(ciWorkflowSource).toContain('https://raw.githubusercontent.com')
    expect(ciWorkflowSource).toContain('repo_private="$(gh api "repos/$repo"')
    expect(ciWorkflowSource).toContain('if [ "$repo_private" = "true" ]; then')
    expect(ciWorkflowSource).toContain('CI_MEASUREMENT_PR_COMMENT_PUBLIC_ASSET_COMMAND')
    expect(ciWorkflowSource).toContain('bash -c "$public_asset_command" _ "$chart_png_file" png')
    expect(ciWorkflowSource).toContain(
      'bash -c "$public_asset_command" _ "$chart_dark_png_file" png',
    )
    expect(ciWorkflowSource).toContain('gh api "repos/$repo/contents/$asset_svg_path"')
    expect(ciWorkflowSource).toContain('gh api "repos/$repo/contents/$asset_png_path"')
    expect(ciWorkflowSource).toContain('gh api "repos/$repo/contents/$asset_dark_png_path"')
    expect(ciWorkflowSource).toContain('base64 <"$chart_file" | tr -d \'\\n\'')
    expect(ciWorkflowSource).toContain('base64 <"$chart_png_file" | tr -d \'\\n\'')
    expect(ciWorkflowSource).toContain(
      'nix path-info --recursive --closure-size --json "$out_path"',
    )
    expect(ciWorkflowSource).toContain('nix.closure.serialized_nar_size')
  })
})

describe('effect-utils CI composition workspace', () => {
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync(gitBin, args, { cwd, encoding: 'utf8' })
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
    }
    return result.stdout.trim()
  }

  const makeFixture = (platform: 'Linux' | 'macOS') => {
    const root = mkdtempSync(join(tmpdir(), 'effect-utils-ci-composition-'))
    const checkout = join(root, 'checkout with spaces')
    const runnerTemp = join(root, `runner ${platform}`)
    const fakeBin = join(root, 'fake-bin')
    const mrOut = join(root, 'mr-out')
    const envFile = join(root, 'github-env')
    const nixLog = join(root, 'nix.log')
    const mrLog = join(root, 'mr.log')
    mkdirSync(checkout)
    mkdirSync(runnerTemp)
    mkdirSync(fakeBin)
    mkdirSync(join(mrOut, 'bin'), { recursive: true })
    writeFileSync(envFile, '')
    git(checkout, 'init', '--initial-branch=main')
    const configuredIdentity = (field: 'user.email' | 'user.name', fallback: string) =>
      spawnSync(gitBin, ['config', field], {
        cwd: checkout,
        encoding: 'utf8',
      }).stdout.trim() || fallback
    git(
      checkout,
      'config',
      'user.email',
      configuredIdentity('user.email', 'ci-fixture@example.invalid'),
    )
    git(checkout, 'config', 'user.name', configuredIdentity('user.name', 'CI Fixture'))
    writeFileSync(join(checkout, 'README'), 'fixture\n')
    mkdirSync(join(checkout, 'genie/ci-scripts'), { recursive: true })
    writeFileSync(
      join(checkout, 'genie/ci-scripts/prepare-effect-utils-composition.sh'),
      prepareEffectUtilsCompositionScriptSource,
    )
    writeFileSync(
      join(checkout, 'genie/ci-scripts/cleanup-effect-utils-composition.sh'),
      cleanupEffectUtilsCompositionScriptSource,
    )
    chmodSync(join(checkout, 'genie/ci-scripts/prepare-effect-utils-composition.sh'), 0o755)
    chmodSync(join(checkout, 'genie/ci-scripts/cleanup-effect-utils-composition.sh'), 0o755)
    git(
      checkout,
      'add',
      'README',
      'genie/ci-scripts/prepare-effect-utils-composition.sh',
      'genie/ci-scripts/cleanup-effect-utils-composition.sh',
    )
    git(checkout, 'commit', '-m', 'fixture')
    const sha = git(checkout, 'rev-parse', 'HEAD')

    writeFileSync(
      join(fakeBin, 'nix'),
      [
        `#!${bashBin}`,
        'set -euo pipefail',
        'printf \'%s|%s\\n\' "$PWD" "$*" >> "$FAKE_NIX_LOG"',
        'if [ "$*" != "build --no-link --print-out-paths .#megarepo" ]; then exit 64; fi',
        'printf \'%s\\n\' "$FAKE_MR_OUT"',
      ].join('\n'),
    )
    writeFileSync(
      join(mrOut, 'bin', 'mr'),
      [
        `#!${bashBin}`,
        'set -euo pipefail',
        'export AGENT_POLICY_BYPASS=1',
        'fake_root="$(cd "$(dirname "$0")/.." && pwd)"',
        'printf \'%s|%s|%s|%s\\n\' "$PWD" "$MEGAREPO_STORE" "${RUNNER_OS:-unset}" "$*" >> "$fake_root/../mr.log"',
        'if [ -f "$fake_root/fail" ]; then exit 37; fi',
        'workspace=',
        'while [ "$#" -gt 0 ]; do',
        '  if [ "$1" = --cwd ]; then workspace="$2"; shift 2; else shift; fi',
        'done',
        'test -n "$workspace"',
        `if ${gitBin} -C "$workspace/repos/effect-utils" rev-parse --is-inside-work-tree >/dev/null 2>&1; then exit 0; fi`,
        'bare="$MEGAREPO_STORE/github.com/overengineeringstudio/effect-utils/.bare"',
        'staged="$workspace.owned"',
        `${gitBin} --git-dir="$bare" worktree move "$workspace" "$staged"`,
        'mkdir -p "$workspace/repos" "$workspace/.megarepo/bin"',
        `${gitBin} --git-dir="$bare" worktree move "$staged" "$workspace/repos/effect-utils"`,
        'printf \'{}\\n\' > "$workspace/.megarepo-owned-worktree.json"',
        'printf \'{}\\n\' > "$workspace/.megarepo/composition-generation.json"',
        'printf \'[cells]\\n\' > "$workspace/.buckconfig"',
        `printf '#!${bashBin}\\nexit 0\\n' > "$workspace/.megarepo/bin/buck2"`,
        'chmod +x "$workspace/.megarepo/bin/buck2"',
        'mkdir -p "$MEGAREPO_STORE/reference-effect"',
        'ln -s "$MEGAREPO_STORE/reference-effect" "$workspace/repos/effect"',
        // Marker-file driven, not env driven: the composition step runs `mr` under
        // `env -i` with a fixed allowlist, so a fixture env var never reaches it.
        'if [ -f "$fake_root/dirty-member" ]; then',
        '  printf \'x\\n\' > "$workspace/repos/effect-utils/untracked-fixture.txt"',
        'fi',
      ].join('\n'),
    )
    chmodSync(join(fakeBin, 'nix'), 0o755)
    chmodSync(join(mrOut, 'bin', 'mr'), 0o755)

    const env = {
      ...process.env,
      AGENT_POLICY_BYPASS: '1',
      FAKE_MR_LOG: mrLog,
      FAKE_MR_OUT: mrOut,
      FAKE_NIX_LOG: nixLog,
      GITHUB_ENV: envFile,
      GITHUB_JOB: 'unit/job',
      GITHUB_RUN_ATTEMPT: '2',
      GITHUB_RUN_ID: '100',
      GITHUB_WORKSPACE: checkout,
      MEGAREPO_STORE: join(runnerTemp, 'megarepo-store/100/2/unit_job'),
      EFFECT_UTILS_CI_ORIGIN_URL: checkout,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      RUNNER_OS: platform,
      RUNNER_TEMP: runnerTemp,
    }
    return { checkout, env, envFile, mrLog, mrOut, nixLog, root, runnerTemp, sha }
  }

  const runComposition = async (
    fixture: ReturnType<typeof makeFixture>,
    overrides: NodeJS.ProcessEnv = {},
  ) => {
    if (overrides.FAKE_MR_FAIL === '1') writeFileSync(join(fixture.mrOut, 'fail'), '')
    const { prepareEffectUtilsCompositionStep } = await import(
      // oxlint-disable-next-line import/no-dynamic-require
      new URL('../../../../../../genie/ci-workflow/setup.ts', import.meta.url).href
    )
    return spawnSync(bashBin, ['-c', prepareEffectUtilsCompositionStep.run], {
      cwd: fixture.root,
      encoding: 'utf8',
      env: { ...fixture.env, ...overrides },
    })
  }

  const cleanupComposition = async (
    fixture: ReturnType<typeof makeFixture>,
    overrides: NodeJS.ProcessEnv = {},
  ) => {
    const { cleanupEffectUtilsCompositionStep } = await import(
      // oxlint-disable-next-line import/no-dynamic-require
      new URL('../../../../../../genie/ci-workflow/setup.ts', import.meta.url).href
    )
    return spawnSync(bashBin, ['-c', cleanupEffectUtilsCompositionStep.run], {
      cwd: fixture.root,
      encoding: 'utf8',
      env: { ...fixture.env, ...overrides },
    })
  }

  it.each(['Linux', 'macOS'] as const)(
    'keeps checkout immutable and synthesizes the exact owned member on %s',
    async (platform) => {
      const fixture = makeFixture(platform)
      try {
        const first = await runComposition(fixture)
        expect(first.status, first.stderr).toBe(0)
        const branch = 'ci-100-2-unit_job'
        const workspace = join(
          fixture.runnerTemp,
          'megarepo-store/100/2/unit_job/github.com/overengineeringstudio/effect-utils/refs/heads',
          branch,
        )
        const member = join(workspace, 'repos/effect-utils')
        expect(git(fixture.checkout, 'rev-parse', 'HEAD')).toBe(fixture.sha)
        expect(git(fixture.checkout, 'status', '--porcelain=v1', '--untracked-files=all')).toBe('')
        expect(git(member, 'rev-parse', 'HEAD')).toBe(fixture.sha)
        expect(git(member, 'symbolic-ref', 'HEAD')).toBe(`refs/heads/${branch}`)
        expect(git(member, 'merge-base', 'refs/remotes/origin/main', 'HEAD')).toBe(fixture.sha)
        expect(
          spawnSync(gitBin, ['-C', workspace, 'rev-parse', '--is-inside-work-tree']).status,
        ).not.toBe(0)
        expect(readFileSync(fixture.nixLog, 'utf8')).toBe(
          `${fixture.checkout}|build --no-link --print-out-paths .#megarepo\n`,
        )
        // The composition step runs `mr` under `env -i`, which drops PWD, so the
        // child shell reports the resolved working directory while every other
        // field is the path the runner handed in. Compare the first field in the
        // same resolved form; on a filesystem with no symlink above the fixture
        // this is the identity.
        expect(readFileSync(fixture.mrLog, 'utf8')).toContain(
          `${realpathSync(dirname(workspace))}|${join(fixture.runnerTemp, 'megarepo-store/100/2/unit_job')}|unset|--cwd ${workspace} apply --worktree-mode tracking --lock-sync off --output ci`,
        )
        expect(readFileSync(fixture.envFile, 'utf8')).toContain(
          `EFFECT_UTILS_MEMBER_ROOT=${member}\n`,
        )

        const repeated = await runComposition(fixture)
        expect(repeated.status, repeated.stderr).toBe(0)
        expect(git(member, 'rev-parse', 'HEAD')).toBe(fixture.sha)

        const secondEnv = join(fixture.root, 'github-env-second')
        writeFileSync(secondEnv, '')
        const secondStore = join(fixture.runnerTemp, 'megarepo-store/100/2/other-job')
        const second = await runComposition(fixture, {
          GITHUB_ENV: secondEnv,
          GITHUB_JOB: 'other-job',
          MEGAREPO_STORE: secondStore,
        })
        expect(second.status, second.stderr).toBe(0)
        const secondMember = join(
          fixture.runnerTemp,
          'megarepo-store/100/2/other-job/github.com/overengineeringstudio/effect-utils/refs/heads/ci-100-2-other-job/repos/effect-utils',
        )
        expect(git(secondMember, 'rev-parse', 'HEAD')).toBe(fixture.sha)
        const secondCleanup = await cleanupComposition(fixture, {
          GITHUB_JOB: 'other-job',
          MEGAREPO_STORE: secondStore,
        })
        expect(secondCleanup.status, secondCleanup.stderr).toBe(0)
        const cleanup = await cleanupComposition(fixture)
        expect(cleanup.status, cleanup.stderr).toBe(0)
        await expect(cleanupComposition(fixture)).resolves.toMatchObject({ status: 0 })
      } finally {
        rmSync(fixture.root, { force: true, recursive: true, maxRetries: 10, retryDelay: 20 })
      }
    },
    20_000,
  )

  it('cleans a registered partial workspace when composition apply fails', async () => {
    const fixture = makeFixture('Linux')
    try {
      const result = await runComposition(fixture, { FAKE_MR_FAIL: '1' })
      expect(result.status).toBe(37)
      expect(readFileSync(fixture.envFile, 'utf8')).not.toContain('EFFECT_UTILS_MEMBER_ROOT')
      expect(git(fixture.checkout, 'rev-parse', 'HEAD')).toBe(fixture.sha)
      expect(git(fixture.checkout, 'status', '--porcelain=v1', '--untracked-files=all')).toBe('')

      const store = fixture.env.MEGAREPO_STORE!
      const workspace = join(
        store,
        'github.com/overengineeringstudio/effect-utils/refs/heads/ci-100-2-unit_job',
      )
      expect(existsSync(join(workspace, '.megarepo-owned-worktree.json'))).toBe(false)
      expect(git(workspace, 'symbolic-ref', 'HEAD')).toBe('refs/heads/ci-100-2-unit_job')

      const cleanup = await cleanupComposition(fixture)
      expect(cleanup.status, cleanup.stderr).toBe(0)
      expect(existsSync(store)).toBe(false)
    } finally {
      rmSync(fixture.root, { force: true, recursive: true, maxRetries: 10, retryDelay: 20 })
    }
  }, 20_000)

  /**
   * `buck2:typescript:materialize-dist` publishes READ-ONLY Buck trees into the composed
   * member, and `git worktree remove` unlinks with the permissions it finds: a read-only
   * directory makes the unlink fail with `Permission denied` and strands the whole
   * job-local store. That is exactly how buck2 job 101579327940 failed with every prior
   * step green — cleanup alone.
   */
  it('removes a store whose published Buck trees are read-only', async () => {
    const fixture = makeFixture('Linux')
    const published: string[] = []
    try {
      const result = await runComposition(fixture)
      expect(result.status, result.stderr).toBe(0)
      const store = fixture.env.MEGAREPO_STORE!
      const workspace = join(
        store,
        'github.com/overengineeringstudio/effect-utils/refs/heads/ci-100-2-unit_job',
      )

      // A read-only FILE is still removable; a read-only DIRECTORY is what blocks the
      // unlink of its children, so both the member and the workspace root get one.
      for (const owner of [join(workspace, 'repos/effect-utils'), workspace]) {
        const tree = join(owner, 'dist-published')
        mkdirSync(tree, { recursive: true })
        writeFileSync(join(tree, 'mod.js'), 'export {}\n')
        chmodSync(join(tree, 'mod.js'), 0o444)
        chmodSync(tree, 0o555)
        published.push(tree)
      }

      const cleanup = await cleanupComposition(fixture)
      expect(cleanup.status, cleanup.stderr).toBe(0)
      expect(existsSync(store)).toBe(false)
    } finally {
      // A failing assertion leaves the read-only trees behind, and the fixture teardown
      // would then hit the very `Permission denied` under test.
      for (const tree of published) {
        if (existsSync(tree) === true) chmodSync(tree, 0o755)
      }
      rmSync(fixture.root, { force: true, recursive: true, maxRetries: 10, retryDelay: 20 })
    }
  }, 20_000)

  it('refuses a registered partial workspace on an unrelated branch', async () => {
    const fixture = makeFixture('Linux')
    try {
      const result = await runComposition(fixture, { FAKE_MR_FAIL: '1' })
      expect(result.status).toBe(37)
      const store = fixture.env.MEGAREPO_STORE!
      const workspace = join(
        store,
        'github.com/overengineeringstudio/effect-utils/refs/heads/ci-100-2-unit_job',
      )
      git(workspace, 'switch', '-c', 'unrelated')

      const cleanup = await cleanupComposition(fixture)
      expect(cleanup.status).not.toBe(0)
      expect(existsSync(workspace)).toBe(true)
      expect(git(workspace, 'symbolic-ref', 'HEAD')).toBe('refs/heads/unrelated')
    } finally {
      rmSync(fixture.root, { force: true, recursive: true, maxRetries: 10, retryDelay: 20 })
    }
  }, 20_000)

  /** Commit one member-visible symlink into the fixture checkout before composing. */
  const commitCheckoutSymlink = (checkout: string, name: string, target: string) => {
    symlinkSync(target, join(checkout, name))
    git(checkout, 'add', name)
    git(checkout, 'commit', '-m', `fixture symlink ${name}`)
  }

  const composedMemberPath =
    'megarepo-store/100/2/unit_job/github.com/overengineeringstudio/effect-utils/refs/heads/ci-100-2-unit_job/repos/effect-utils'

  it('accepts a relative in-tree member symlink next to the absolute locked-member link', async () => {
    const fixture = makeFixture('Linux')
    try {
      commitCheckoutSymlink(fixture.checkout, 'CLAUDE.md', 'README')
      const result = await runComposition(fixture)
      expect(result.status, result.stderr).toBe(0)
      const member = join(fixture.runnerTemp, composedMemberPath)
      expect(readlinkSync(join(member, 'CLAUDE.md'))).toBe('README')
      // The locked member is mounted through an ABSOLUTE symlink by design, and Buck
      // ignores it, so the guard must not refuse the composition over it.
      expect(readlinkSync(join(member, '../effect')).startsWith('/')).toBe(true)
      await cleanupComposition(fixture)
    } finally {
      rmSync(fixture.root, { force: true, recursive: true, maxRetries: 10, retryDelay: 20 })
    }
  }, 20_000)

  it('refuses an absolute tracked member symlink before any Buck upload', async () => {
    const fixture = makeFixture('Linux')
    try {
      commitCheckoutSymlink(fixture.checkout, 'absolute-link', join(fixture.root, 'mr-out'))
      const result = await runComposition(fixture)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('tracked member symlink is absolute')
      expect(readFileSync(fixture.envFile, 'utf8')).not.toContain('EFFECT_UTILS_MEMBER_ROOT')
      await cleanupComposition(fixture)
    } finally {
      rmSync(fixture.root, { force: true, recursive: true, maxRetries: 10, retryDelay: 20 })
    }
  }, 20_000)

  it('refuses a relative tracked member symlink that escapes the composed workspace', async () => {
    const fixture = makeFixture('Linux')
    try {
      const outsideTarget = join(fixture.runnerTemp, 'outside-member-target')
      mkdirSync(outsideTarget)
      commitCheckoutSymlink(
        fixture.checkout,
        'escaping-link',
        relative(join(fixture.runnerTemp, composedMemberPath), outsideTarget),
      )
      const result = await runComposition(fixture)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('tracked member symlink escapes the composed workspace')
      expect(readFileSync(fixture.envFile, 'utf8')).not.toContain('EFFECT_UTILS_MEMBER_ROOT')
      await cleanupComposition(fixture)
    } finally {
      rmSync(fixture.root, { force: true, recursive: true, maxRetries: 10, retryDelay: 20 })
    }
  }, 20_000)

  it('refuses a dangling tracked member symlink before any Buck upload', async () => {
    const fixture = makeFixture('Linux')
    try {
      // Nothing to resolve means nothing whose provenance could be checked, so a
      // dangling tracked link is a refusal rather than a pass. Asserted by running
      // the script, because the guard's `test -e` precedes portable `realpath`.
      commitCheckoutSymlink(fixture.checkout, 'dangling-link', 'missing-target')
      const result = await runComposition(fixture)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('tracked member symlink does not resolve')
      expect(readFileSync(fixture.envFile, 'utf8')).not.toContain('EFFECT_UTILS_MEMBER_ROOT')
      await cleanupComposition(fixture)
    } finally {
      rmSync(fixture.root, { force: true, recursive: true, maxRetries: 10, retryDelay: 20 })
    }
  }, 20_000)

  it('refuses a composed member that is not clean, since tracked scope assumes it', async () => {
    const fixture = makeFixture('Linux')
    try {
      writeFileSync(join(fixture.mrOut, 'dirty-member'), '')
      const result = await runComposition(fixture)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('composed member is not clean')
      expect(result.stderr).toContain('untracked-fixture.txt')
      expect(readFileSync(fixture.envFile, 'utf8')).not.toContain('EFFECT_UTILS_MEMBER_ROOT')
      await cleanupComposition(fixture)
    } finally {
      rmSync(fixture.root, { force: true, recursive: true, maxRetries: 10, retryDelay: 20 })
    }
  }, 20_000)

  it('orders every migrated job after composition and keeps the checkout exemptions explicit', () => {
    const jobsYaml = generatedCiWorkflowYamlSource.split('\njobs:\n')[1] ?? ''
    const blocks = new Map(
      Array.from(
        jobsYaml.matchAll(/^  ([a-zA-Z0-9_-]+):\n([\s\S]*?)(?=^  [a-zA-Z0-9_-]+:\n|$(?![\s\S]))/gm),
        ([, name, body]) => [name!, body!] as const,
      ),
    )
    const exemptions = new Set([
      'default-ref-policy',
      'source-shape',
      'ci-measurements-report',
      'notify-alignment',
    ])
    expect(
      [...blocks.keys()].filter(
        (name) => blocks.get(name)?.includes('Prepare effect-utils composition') !== true,
      ),
    ).toEqual([...exemptions])
    for (const [name, block] of blocks) {
      const taskIndex = block.indexOf('tasks run ')
      if (taskIndex < 0) continue
      expect(exemptions.has(name), name).toBe(false)
      const compositionIndex = block.indexOf('Prepare effect-utils composition')
      expect(compositionIndex, name).toBeGreaterThanOrEqual(0)
      expect(compositionIndex, name).toBeLessThan(taskIndex)
      expect(block.indexOf('Cleanup effect-utils composition'), name).toBeGreaterThan(taskIndex)
    }
    expect(generatedCiWorkflowYamlSource).not.toMatch(/^\s+(?:buck2|\.\/[^ ]*buck2)\s/m)
  })

  it('keeps pull-request source execution credentialless and read-only', () => {
    expect(ciWorkflowSource).toContain("'persist-credentials': false")
    expect(generatedCiWorkflowYamlSource).toContain('permissions:\n  contents: read')
    const typecheck = generatedCiWorkflowYamlSource.split('  typecheck:\n')[1] ?? ''
    expect(typecheck.indexOf('Prepare effect-utils composition')).toBeLessThan(
      typecheck.indexOf('Enable Cachix cache'),
    )
    expect(typecheck).toContain("github.ref == 'refs/heads/main'")
    for (const job of [
      'ci-measurements-report',
      'test-integration-notion',
      'test-live-deploy-ci-tools',
      'deploy-storybooks',
    ]) {
      const block =
        generatedCiWorkflowYamlSource.split(`  ${job}:\n`)[1]?.split(/^  [a-z]/m)[0] ?? ''
      expect(block, job).toContain("github.ref == 'refs/heads/main'")
    }
    expect(prepareEffectUtilsCompositionScriptSource).toContain('env -i \\')
    expect(prepareEffectUtilsCompositionScriptSource).not.toContain('GITHUB_TOKEN')
    expect(prepareEffectUtilsCompositionScriptSource).toContain(
      "'+refs/heads/main:refs/remotes/origin/main'",
    )
    const trustedRef = (event: string, ref: string) =>
      ref === 'refs/heads/main' && (event === 'push' || event === 'workflow_dispatch')
    expect(trustedRef('workflow_dispatch', 'refs/heads/feature')).toBe(false)
    expect(trustedRef('workflow_dispatch', 'refs/heads/main')).toBe(true)
    expect(trustedRef('pull_request', 'refs/heads/main')).toBe(false)
  })

  it('keeps job-local state free of an ambient pnpm store or per-run composition root', () => {
    expect(generatedCiWorkflowYamlSource).not.toContain(
      '${{ runner.temp }}/composition-state/pnpm-store-pure-v1',
    )
    expect(generatedCiWorkflowYamlSource).not.toContain(
      '${{ runner.temp }}/composition-state/${{ github.run_id }}',
    )
    expect(buckToolchainsSource).not.toContain('store_dir =')
  })

  it('runs live provider deploys as declared Buck targets, not workflow-local installs', () => {
    // The repository-local source/FOD CLI producers are gone: capabilities are
    // realized through composition, and every live provider lane is a declared
    // Buck test target. A workflow-local `nix build .#<provider>-cli` or a root
    // pnpm install would reintroduce exactly the ambient authority the cutover
    // removed.
    for (const target of [
      'effect_utils//packages/@overeng/ci-tools:test_netlify_live',
      'effect_utils//packages/@overeng/ci-tools:test_vercel_live',
    ]) {
      expect(generatedCiWorkflowYamlSource).toContain(`"$buck2" test ${target}`)
    }
    expect(generatedCiWorkflowYamlSource).not.toContain('nix build .#netlify-cli')
    expect(generatedCiWorkflowYamlSource).not.toContain('nix build .#vercel-cli')
    expect(generatedCiWorkflowYamlSource).not.toContain('tasks run pnpm:install')
  })

  it('owns build-product freshness through the Buck check task', () => {
    // `buck2:products:check` reconciles the tracked products and is a
    // prerequisite of the aggregate check, so CI asserts freshness by running
    // `buck2:check` rather than by a strict Nix lane over source CLI producers.
    expect(generatedCiWorkflowYamlSource).toContain('devenv tasks run buck2:check')
    expect(generatedCiWorkflowYamlSource).not.toContain('nix-fod-check')
  })
})

describe('effect-utils shared Buck cache lane (03-materialization DQ1)', () => {
  const cachePreflightScriptSource = readFileSync(
    new URL(
      ['../../../../../../genie/ci-scripts', 'buck2-cache-preflight.sh'].join('/'),
      import.meta.url,
    ),
    'utf8',
  )
  const cacheLaneScriptUrl = new URL(
    ['../../../../../../genie/ci-scripts', 'buck2-cache-lane.sh'].join('/'),
    import.meta.url,
  )
  const cacheLaneScriptPath = fileURLToPath(cacheLaneScriptUrl)
  const cacheLaneScriptSource = readFileSync(cacheLaneScriptUrl, 'utf8')
  const jobBlock = (job: string) =>
    generatedCiWorkflowYamlSource.split(`  ${job}:\n`)[1]?.split(/^  [a-z]/m)[0] ?? ''
  const publish = jobBlock('buck2-cache-publish')
  const restore = jobBlock('buck2-cache-restore')
  const outage = jobBlock('buck2-cache-outage')
  const capacity = jobBlock('buck2-capacity')
  /** The JOB-level `if:` (4-space indent), not a step `if:` and not the concurrency group. */
  const jobIf = (block: string) => block.match(/^ {4}if: (.*)$/mu)?.[1] ?? ''

  it('keeps the lane dispatch-only, fork-unreachable, and out of branch protection', () => {
    for (const [name, block] of [
      ['buck2-cache-publish', publish],
      ['buck2-cache-restore', restore],
      ['buck2-cache-outage', outage],
    ] as const) {
      // `workflow_dispatch` IS the authorization boundary: it needs write access and a ref
      // in this repository, so no fork-controlled code can ever mint a tailnet-capable
      // OIDC token. The lane is therefore dispatchable on any same-repo branch, which
      // breaks the proof-before-merge circularity, while still never running on a PR.
      expect(jobIf(block), name).toContain("github.event_name == 'workflow_dispatch'")
      expect(jobIf(block), name).toContain('inputs.run_buck2_cache_probe')
      expect(jobIf(block), name).not.toContain('pull_request')
      expect(jobIf(block), name).not.toContain("'push'")
      expect(jobIf(block), name).not.toContain("'schedule'")
      // No ref restriction: a main-only guard would make the lane unrunnable before the
      // change that carries it can merge, which is the circularity DQ1 must not have.
      expect(jobIf(block), name).not.toContain('github.ref')
      expect(generatedRequiredCheckContexts, name).not.toContain(name)
    }
    expect(generatedCiWorkflowYamlSource).toContain('run_buck2_cache_probe:')
  })

  it('reads the operational endpoint from repository configuration and commits no key material', () => {
    for (const [name, block] of [
      ['buck2-cache-publish', publish],
      ['buck2-cache-restore', restore],
    ] as const) {
      expect(block, name).toContain('BUCK2_CACHE_ENDPOINT: ${{ vars.BUCK2_CACHE_ENDPOINT }}')
      expect(block, name).not.toMatch(/BUCK2_CACHE_ENDPOINT: '?grpc:\/\/[a-z0-9]/u)
    }
    expect(publish).toContain('oauth-client-id: ${{ vars.TS_FEDERATED_CLIENT_ID }}')
    expect(publish).toContain('audience: ${{ vars.TS_FEDERATED_AUDIENCE }}')
    expect(publish).toContain("tags: 'tag:ci-buck2-cache'")
    // The scripts stay address-free: they read the endpoint from the environment.
    expect(cachePreflightScriptSource).not.toMatch(/grpc:\/\/[a-z0-9]/u)
    expect(cacheLaneScriptSource).not.toMatch(/grpc:\/\//u)
  })

  it('authenticates the tailnet join with workload identity, never a stored secret', () => {
    // Federation replaces the OAuth client secret entirely: the only credential is the
    // per-job GitHub OIDC token, so there is nothing at rest to leak or rotate.
    for (const [name, block] of [
      ['buck2-cache-publish', publish],
      ['buck2-cache-restore', restore],
    ] as const) {
      // Pinned by commit, not by a movable `v4` tag: this step spends the OIDC token.
      expect(block, name).toContain(
        'uses: tailscale/github-action@306e68a486fd2350f2bfc3b19fcd143891a4a2d8',
      )
      expect(block, name).toMatch(/version: '?1\.94\.2'?/u)
      expect(block, name).not.toContain('version: latest')
      // Every third-party action in a credential-bearing job is digest-pinned.
      expect(block, name).toContain(
        'uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803',
      )
      expect(block, name).toContain(
        'uses: DeterminateSystems/determinate-nix-action@021c8a1bd3570eb21f5c20a054812b0c4d9ca614',
      )
      expect(block, name).toContain(
        'uses: cachix/cachix-action@38b082610b782e7e93e209c35fd730d399dee866',
      )
      expect(block, name).not.toContain('uses: actions/checkout@v6')
      expect(block, name).toContain('oauth-client-id: ${{ vars.TS_FEDERATED_CLIENT_ID }}')
      expect(block, name).toContain('audience: ${{ vars.TS_FEDERATED_AUDIENCE }}')
      // The token has to be mintable in the job that spends it, and nowhere else.
      expect(block, name).toContain('id-token: write')
    }
    // The client id and audience are non-secret configuration; no Tailscale secret exists.
    expect(generatedCiWorkflowYamlSource).not.toContain('TS_OAUTH')
    expect(generatedCiWorkflowYamlSource).not.toContain('oauth-secret')
    expect(generatedCiWorkflowYamlSource).not.toContain('secrets.TS_')
    // Least privilege: the outage leg never joins the tailnet, so it never gets the token,
    // and the workflow default stays read-only rather than granting id-token globally.
    expect(outage).not.toContain('id-token')
    expect(generatedCiWorkflowYamlSource).toContain('permissions:\n  contents: read\n')
    expect(generatedCiWorkflowYamlSource.split('id-token: write').length - 1).toBe(2)
  })

  it('names an explicit candidate instance that cannot default to production', () => {
    for (const block of [publish, restore, outage]) {
      expect(block).toContain('BUCK2_CACHE_INSTANCE_NAME: effect-utils-dq1-candidate')
    }
    // A bare `instance_name: effect-utils` is the production namespace; the lane must never
    // resolve to it, and the instance name is a generator constant rather than an input.
    expect(generatedCiWorkflowYamlSource).not.toContain('BUCK2_CACHE_INSTANCE_NAME: effect-utils\n')
    expect(generatedCiWorkflowYamlSource).not.toContain('inputs.buck2_cache_instance')
  })

  it('routes cache config through buckconfig files, never through a Buck -c override', () => {
    expect(prepareEffectUtilsCompositionScriptSource).toContain(
      'BUCK2_CACHE_ENDPOINT="${BUCK2_CACHE_ENDPOINT:-}"',
    )
    expect(prepareEffectUtilsCompositionScriptSource).toContain(
      'BUCK2_CACHE_INSTANCE_NAME="${BUCK2_CACHE_INSTANCE_NAME:-}"',
    )
    // `-c buck2_re_client.*` never reaches the RE client, so no generated command line may
    // pretend to configure the cache that way.
    expect(generatedCiWorkflowYamlSource).not.toContain('buck2_re_client')
    expect(cacheLaneScriptSource).not.toMatch(/-c\s+buck2_re_client/u)
    // The lane writes exactly one buckconfig FILE, and only for the outage assertion.
    expect(cacheLaneScriptSource.split('[buck2_re_client]').length - 1).toBe(1)
    expect(cacheLaneScriptSource).toContain('override="$workspace/.buckconfig.local"')
    // Publisher and restore compose at different absolute prefixes for free, because the
    // synthesized store root is keyed on the job id (REUSE-R02 relocation clause).
    expect(prepareEffectUtilsCompositionScriptSource).toContain('${GITHUB_JOB:-job}')
  })

  it('covers the COMPLETE candidate graph, per class, with no drift', () => {
    // Expected classes, each from the registry that actually owns it.
    const typecheck = new Set(
      typescriptAuthorityManifest.authorityProjects.map(({ typecheckTarget }) => typecheckTarget),
    )
    const dist = new Set(
      typescriptAuthorityManifest.authoritativeAdmissions.map(({ distTarget }) => distTarget),
    )
    const editorViewInputs = new Set(
      typescriptAuthorityManifest.editorViewConsumerPackagePaths.map(
        (path) => `//${path}:editor_view_inputs`,
      ),
    )
    const products = new Set(trackedBuckProducts.products.map(({ label }) => label))
    const supportTools = new Set([
      '//buck2/toolchains:archive_tool',
      '//buck2/toolchains:product_tool',
    ])

    // Class sizes are pinned so a silent registry shrink cannot quietly narrow the proof.
    expect({
      typecheck: typecheck.size,
      dist: dist.size,
      editorViewInputs: editorViewInputs.size,
      products: products.size,
      supportTools: supportTools.size,
    }).toEqual({
      typecheck: 39,
      dist: 38,
      editorViewInputs: 38,
      products: 10,
      supportTools: 2,
    })
    for (const tool of supportTools) {
      expect(buckToolchainsSource).toContain(`name = "${tool.split(':')[1]}"`)
    }

    const expected = [
      ...new Set(
        [...typecheck, ...dist, ...editorViewInputs, ...products, ...supportTools].map(
          (label) => `effect_utils${label}`,
        ),
      ),
    ].toSorted((left, right) => Buffer.from(left).compare(Buffer.from(right)))
    expect(expected.length).toBe(127)

    const graphLabels = candidateGraphArtifact
      .split('\n')
      .filter((line) => /^[A-Za-z_][A-Za-z0-9_]*\/\/\S+$/u.test(line) === true)
    // Exact set equality in canonical order: no missing label, no extra label, no dupes.
    expect(graphLabels).toEqual(expected)

    // The lane consumes the generated artifact rather than an inlined list, so the YAML
    // stays small and the artifact above is the single thing coverage is asserted against.
    for (const block of [publish, restore]) {
      expect(block).toContain("'genie/ci-scripts/buck2-candidate-graph.txt'")
    }
    expect(publish).toContain('buck2-cache-lane.sh" publish')
    expect(restore).toContain('buck2-cache-lane.sh" restore')
    expect(cacheLaneScriptSource).toContain('read_graph_labels')
    expect(cacheLaneScriptSource).toContain('candidate graph file declares no labels')
    // A graph that is already fully cached is a valid publish state. Asserting fresh local
    // work or a nonzero upload over the GRAPH would make the lane fail on its second
    // dispatch, so the publish claim rests on the dispatch-unique probe instead.
    expect(cacheLaneScriptSource).not.toContain('population executed no local command')
    expect(cacheLaneScriptSource).not.toContain('the candidate instance was not populated')
    expect(cacheLaneScriptSource).toContain(
      'Deliberately NO local-execution or upload assertion over the graph',
    )
  })

  it('proves cross-job transfer with ONE dispatch-stable probe nonce', () => {
    expect(restore).toContain('needs: [buck2-cache-publish]')
    // Same nonce expression in both jobs: stable so the two runners derive the same action
    // key, unique per dispatch so publish always has exactly one new action to upload.
    const probeNonce = "BUCK2_CACHE_NONCE: '${{ github.run_id }}-${{ github.run_attempt }}'"
    expect(publish).toContain(probeNonce)
    expect(restore).toContain(probeNonce)
    expect(generatedWorkflowSource).toContain(
      "const buck2CacheProbeNonce = '${{ github.run_id }}-${{ github.run_attempt }}'",
    )
    // Both legs drive the same carrier and the same single label, or they would not be
    // reproducing one action.
    for (const block of [publish, restore]) {
      expect(block).toContain("'packages/@overeng/oxc-config/src/mod.ts'")
      expect(block).toContain("'effect_utils//packages/@overeng/oxc-config:oxc-config-candidate'")
    }
    // Publish requires the probe to be genuinely new work that lands in the cache.
    expect(cacheLaneScriptSource).toContain(
      'the dispatch-unique probe executed no local command, so this dispatch published no action of its own',
    )
    expect(cacheLaneScriptSource).toContain(
      'the dispatch-unique probe uploaded zero digests, so CI cannot write to the shared cache',
    )
    // Restore requires that exact action to arrive over the cache, with zero local work.
    expect(cacheLaneScriptSource).toContain(
      'the dispatch-unique probe published by the publish job produced zero cache hits here, so no action crossed the job boundary',
    )
    expect(cacheLaneScriptSource).toContain(
      'a complete candidate graph must be a pure cache restore',
    )
    // The nonce never survives the step: a dirty member would poison later evidence.
    expect(cacheLaneScriptSource).toContain('trap revert_nonce_carrier EXIT')
    expect(cacheLaneScriptSource).toContain('git -C "$member" checkout -- "$NONCE_CARRIER"')
  })

  it('gives the independent miss leg a distinct nonce and demands local work', () => {
    expect(restore).toContain('buck2-cache-lane.sh" miss')
    expect(restore).toContain(
      "BUCK2_CACHE_MISS_NONCE: 'miss-${{ github.run_id }}-${{ github.run_attempt }}'",
    )
    expect(generatedWorkflowSource).toContain(
      "const buck2CacheMissNonce = 'miss-${{ github.run_id }}-${{ github.run_attempt }}'",
    )
    // Structural, not just conventional: the script refuses the two nonces being equal.
    expect(cacheLaneScriptSource).toContain(
      'BUCK2_CACHE_MISS_NONCE must differ from BUCK2_CACHE_NONCE',
    )
    expect(cacheLaneScriptSource).toContain(
      'the nonce did not force any local execution, so it is not a deliberate miss',
    )
    expect(cacheLaneScriptSource).toContain(
      'the deliberate miss uploaded zero digests, so CI cannot write to the cache',
    )
    // The wipe touches only this composition's isolation dir.
    expect(cacheLaneScriptSource).toContain('rm -rf "$workspace/buck-out/megarepo"')
    expect(cacheLaneScriptSource).not.toMatch(/rm -rf "\$workspace"\s/u)
  })

  it('retains the full uploaded-digest list as a bounded artifact, not just a count', () => {
    // The count in the summary cannot answer "which digests did this dispatch write", so
    // the record list is saved before it is counted and shipped as an artifact.
    expect(cacheLaneScriptSource).toContain('save_uploaded_digests')
    expect(cacheLaneScriptSource).toMatch(/\| jq -s '\.' > "\$destination"/u)
    expect(cacheLaneScriptSource).toContain(
      'BUCK2_CACHE_PROVENANCE_DIR:-${RUNNER_TEMP:-/tmp}/buck2-cache-provenance',
    )
    // Summaries reference the retained file and the artifact that carries it.
    expect(cacheLaneScriptSource).toContain('Uploaded-digest provenance:')
    expect(cacheLaneScriptSource).toContain(
      'provenance_artifact="buck2-cache-provenance-${GITHUB_JOB:-job}-run-${GITHUB_RUN_ID:-local}-attempt-${GITHUB_RUN_ATTEMPT:-0}"',
    )
    // Both cache-writing legs upload it with bounded retention. The directory is NOT set
    // as job-level env: `env:` at job level cannot read the `runner` context, so
    // `${{ runner.temp }}` would travel to the script unexpanded. The script defaults to
    // `$RUNNER_TEMP/...` instead, and only the upload step (where the context is legal)
    // names the same directory through the generator constant.
    for (const [name, block] of [
      ['buck2-cache-publish', publish],
      ['buck2-cache-restore', restore],
    ] as const) {
      expect(block, name).not.toContain('BUCK2_CACHE_PROVENANCE_DIR')
      const jobEnv = block.split('    steps:')[0] ?? ''
      expect(jobEnv, name).not.toContain('runner.temp')
      expect(block, name).toContain('name: Upload uploaded-digest provenance')
      expect(block, name).toContain("path: '${{ runner.temp }}/buck2-cache-provenance'")
      expect(block, name).toContain('retention-days: 14')
      expect(block, name).toContain(
        "name: 'buck2-cache-provenance-${{ github.job }}-run-${{ github.run_id }}-attempt-${{ github.run_attempt }}'",
      )
    }
    expect(ciWorkflowSource).toContain(
      "export const buck2SharedCacheProvenanceDir = '${{ runner.temp }}/buck2-cache-provenance'",
    )
    // The script default and the artifact path have to be the same directory, or the
    // artifact would be empty while the evidence sat somewhere else.
    expect(ciWorkflowSource).toContain('path: buck2SharedCacheProvenanceDir')
    expect(generatedWorkflowSource).not.toContain('BUCK2_CACHE_PROVENANCE_DIR')
  })

  it('refuses composed symlinks that break upload provenance, before any upload', () => {
    const script = prepareEffectUtilsCompositionScriptSource
    // Prefix leg: a path component that hops to a foreign absolute location would publish
    // digests whose provenance is not the tree under proof.
    expect(script).toContain('assert_no_absolute_symlink_traversal() {')
    expect(script).toContain('composed path traverses an absolute symlink')
    // Fail-closed: an unreadable symlink is a refusal, not a skip.
    expect(script).toContain('cannot read a symlink on the composed path')
    // The prefix leg must not claim relative links cannot escape; `../../outside` does.
    expect(script).not.toContain('they cannot leave the composed prefix')
    expect(script).toContain('(`../../outside` escapes)')
    // Content leg: every TRACKED member symlink must be relative AND resolve inside the
    // composed workspace. Absolute, escaping, and dangling links are all refusals.
    expect(script).toContain('assert_member_symlinks_stay_inside_workspace() {')
    expect(script).toContain('git -C "$member" ls-files -s -z')
    expect(script).toContain('[ "$mode" = 120000 ] || continue')
    expect(script).toContain('tracked member symlink is absolute')
    expect(script).toContain('tracked member symlink escapes the composed workspace')
    expect(script).toContain('tracked member symlink does not resolve')
    expect(script).toContain('! -e "$member/$link"')
    expect(script).toContain('realpath "$member/$link"')
    // Tracked-only scope is sound only if the member carries nothing else, so that premise
    // is asserted rather than assumed.
    expect(script).toContain(
      'composed member is not clean, so tracked content is not the whole member tree',
    )
    // Ordering: prefix check before the overlay (the first upload-enabled Buck
    // invocation), then cleanliness, then the tracked-symlink check on the composed member.
    const beforeOverlay = script.indexOf('assert_no_absolute_symlink_traversal "$workspace_root"')
    const overlay = script.indexOf('apply --worktree-mode')
    const memberPrefix = script.indexOf('assert_no_absolute_symlink_traversal "$member_root"')
    const clean = script.indexOf('git -C "$member_root" status --porcelain=v1')
    const memberLinks = script.indexOf(
      'assert_member_symlinks_stay_inside_workspace "$member_root" "$workspace_root"',
    )
    expect(beforeOverlay).toBeGreaterThan(0)
    expect(beforeOverlay).toBeLessThan(overlay)
    expect(memberPrefix).toBeGreaterThan(overlay)
    expect(clean).toBeGreaterThan(memberPrefix)
    expect(memberLinks).toBeGreaterThan(clean)
  })

  it('bounds the upload batch size in every buckconfig the cache lane can produce', () => {
    // 4 MiB, stated rather than inherited, in the composition path, the developer shell
    // path, and the outage override the lane writes.
    expect(compositionCommandSource).toContain("{ key: 'max_total_batch_size', value: '4194304' }")
    expect(devenvSource).toContain('max_total_batch_size = 4194304')
    expect(cacheLaneScriptSource).toContain("printf 'max_total_batch_size = 4194304\\n'")
    for (const source of [compositionCommandSource, devenvSource, cacheLaneScriptSource]) {
      let stated = 0
      for (const [, digits] of source.matchAll(/max_total_batch_size\D*(\d+)/gu)) {
        stated += 1
        expect(Number(digits)).toBeLessThanOrEqual(4 * 1024 * 1024)
      }
      expect(stated).toBeGreaterThan(0)
    }
  })

  it('reads its evidence from Buck native logs rather than wall time or exit code', () => {
    expect(cacheLaneScriptSource).toContain('log what-ran --format json')
    expect(cacheLaneScriptSource).toContain('log what-uploaded --format json')
    expect(cacheLaneScriptSource).toContain('log summary')
    expect(cacheLaneScriptSource).toContain('.reproducer.executor == $executor')
    // remote_enabled stays false: any remotely executed command fails the lane.
    expect(cacheLaneScriptSource).toContain('require_no_remote_execution')
  })

  it('fails closed on outage at its own assertion, never in the composition', () => {
    // The outage leg deliberately points at an unroutable RFC 2606 name and must observe
    // Buck itself refusing, so it carries neither the tailnet join nor the preflight.
    expect(outage).not.toContain('tailscale/github-action')
    expect(outage).not.toContain('Preflight shared Buck cache')
    expect(outage).toContain('buck2-cache-lane.sh" outage')
    // The COMPOSITION runs with the cache disabled: the overlay's own Buck work must not
    // be the thing that dies against the unreachable endpoint, or the leg would "pass"
    // without ever reaching the assertion it exists to make.
    const outageJobEnv = outage.split('    steps:')[0] ?? ''
    expect(outageJobEnv).toContain("BUCK2_NO_REMOTE_CACHE: '1'")
    expect(outageJobEnv).not.toContain('BUCK2_CACHE_ENDPOINT')
    expect(generatedWorkflowSource).toContain('const buck2CacheOutageJobEnv = {')
    // The endpoint is enabled by the assertion step alone, and it is the only step there.
    const assertionStep =
      outage.split('      - name: Assert a hard failure against an unreachable cache\n')[1] ?? ''
    expect(assertionStep).toContain("BUCK2_NO_REMOTE_CACHE: ''")
    expect(assertionStep).toContain("BUCK2_CACHE_ENDPOINT: 'grpc://buck2-cache-outage.invalid:1'")
    expect(outage.indexOf('grpc://buck2-cache-outage.invalid:1')).toBeGreaterThan(
      outage.indexOf('Prepare effect-utils composition'),
    )
    // The override is a buckconfig file the lane writes for that step and then removes,
    // and it refuses to clobber an existing one.
    expect(cacheLaneScriptSource).toContain('refusing to clobber an existing root cache override')
    expect(cacheLaneScriptSource).toContain('drop_override() { rm -f "$override"; }')
    expect(cacheLaneScriptSource).toContain('trap drop_override EXIT')
    expect(cacheLaneScriptSource).toContain(
      'a cache outage must never degrade into a silent local build',
    )
    // Recovery is printed for an operator, never applied by the lane itself.
    expect(cacheLaneScriptSource).toContain('deliberately NOT run here')
    expect(cacheLaneScriptSource).not.toMatch(/^\s*export BUCK2_NO_REMOTE_CACHE=/mu)
    expect(cachePreflightScriptSource).not.toMatch(/^\s*export BUCK2_NO_REMOTE_CACHE=/mu)
    // Every other lane keeps the repo-wide disable; only the two cache-writing jobs and
    // the outage assertion step clear it.
    expect(generatedCiWorkflowYamlSource).toContain("BUCK2_NO_REMOTE_CACHE: '1'")
    expect(generatedCiWorkflowYamlSource.split("BUCK2_NO_REMOTE_CACHE: ''").length - 1).toBe(3)
  })

  it('keeps the generated workflow derived from its Genie source', () => {
    // Every lane invocation in the YAML must be reachable from a generator constant, so a
    // hand-edited ci.yml cannot drift into a different proof than the source describes.
    for (const literal of [
      "const buck2CandidateGraphFile = 'genie/ci-scripts/buck2-candidate-graph.txt'",
      "const buck2CacheNonceCarrier = 'packages/@overeng/oxc-config/src/mod.ts'",
      "const buck2CacheNonceLabel = 'effect_utils//packages/@overeng/oxc-config:oxc-config-candidate'",
      "const buck2CacheOutageEndpoint = 'grpc://buck2-cache-outage.invalid:1'",
      "const buck2CacheCandidateInstance = 'effect-utils-dq1-candidate'",
    ]) {
      expect(generatedWorkflowSource).toContain(literal)
    }
    // The generator drives all three legs through one helper and one step atom.
    expect(generatedWorkflowSource.split('buck2CacheLaneJob({').length - 1).toBe(4)
    expect(generatedWorkflowSource).toContain('buck2SharedCacheProvenanceArtifactStep')
    expect(generatedWorkflowSource).not.toContain('actions/upload-artifact')
    // Modes reach the script only through the typed step atom's union.
    expect(ciWorkflowSource).toContain(
      "readonly mode: 'publish' | 'restore' | 'miss' | 'outage' | 'capacity'",
    )
    for (const [mode, block] of [
      ['publish', publish],
      ['restore', restore],
      ['miss', restore],
      ['outage', outage],
      ['capacity', capacity],
    ] as const) {
      expect(block, mode).toContain(`buck2-cache-lane.sh" ${mode} `)
    }
    // And the lane script implements exactly those five modes, no more.
    for (const mode of ['publish', 'restore', 'miss', 'outage', 'capacity']) {
      expect(cacheLaneScriptSource).toMatch(new RegExp(`^  ${mode}\\)$`, 'mu'))
    }
    expect(cacheLaneScriptSource).toContain('fail "unknown mode: $mode"')
  })

  it('wires an independent manual Namespace Linux x86_64 capacity job', () => {
    expect(generatedCiWorkflowYamlSource).toContain('run_buck2_capacity_probe:')
    expect(jobIf(capacity)).toContain("github.event_name == 'workflow_dispatch'")
    expect(jobIf(capacity)).toContain('inputs.run_buck2_capacity_probe')
    expect(jobIf(capacity)).not.toContain('inputs.run_buck2_cache_probe')
    expect(capacity).toContain('namespace-profile-linux-x86-64')
    expect(capacity).toContain("BUCK2_NO_REMOTE_CACHE: '1'")
    expect(capacity).not.toContain('BUCK2_CACHE_ENDPOINT')
    expect(capacity).not.toContain('tailscale/github-action')
    // The Namespace image installs Nix with sandboxing off, and the composition overlay
    // builds the declared Coreutils wrappers: without this the lane cannot compose at all.
    expect(capacity).toContain('sandbox = true')
    // Only credential-bearing jobs carry digest pins, so this leg keeps the majors.
    expect(capacity).toContain('uses: actions/checkout@v6')
    expect(capacity).not.toContain('actions/checkout@d23441a4')
    // Publication is a direct Buck invocation, so this lane needs no Devenv at all.
    expect(capacity).not.toContain('name: Resolve devenv')
    expect(capacity).not.toContain('DEVENV_BIN')
    expect(capacity).toContain('BUCK2_CAPACITY_RUNNER_PROFILE: namespace-profile-linux-x86-64')
    expect(capacity).toContain("BUCK2_CAPACITY_TIMEOUT_MINUTES: '240'")
    expect(capacity).toContain("BUCK2_CAPACITY_JOB_CONCURRENCY: '1'")
    expect(capacity).toContain(
      `buck2-cache-lane.sh" capacity 'genie/ci-scripts/buck2-candidate-graph.txt'`,
    )
    expect(generatedRequiredCheckContexts).not.toContain('buck2-capacity')
  })

  it('sequences prerequisites, cold graph, publication, cold curve, then warm rebuild', () => {
    const capacityMode = cacheLaneScriptSource.slice(
      cacheLaneScriptSource.indexOf('  capacity)'),
      cacheLaneScriptSource.indexOf('  outage)'),
    )
    const prerequisites = capacityMode.indexOf('prepare_editor_publication')
    const cold = capacityMode.indexOf('run_capacity_build cold-full')
    const publication = capacityMode.indexOf('run_editor_publication')
    const curve = capacityMode.indexOf(
      'for class in supportTools editorViewInputs typecheck dist products',
    )
    const warm = capacityMode.indexOf('run_capacity_build warm-full')
    expect(prerequisites).toBeGreaterThan(0)
    expect(cold).toBeGreaterThan(prerequisites)
    expect(publication).toBeGreaterThan(cold)
    expect(curve).toBeGreaterThan(publication)
    expect(warm).toBeGreaterThan(curve)
    // Publication is the direct, fully argument-stated buck-watch invocation: no Devenv
    // task graph runs after the cold observation, and sources are proven unmutated.
    expect(cacheLaneScriptSource).toContain(
      '"$buck2" run effect_utils//scripts:buck-watch -- publish',
    )
    expect(cacheLaneScriptSource).toContain('--snapshot-retention "$capacity_snapshot_retention"')
    expect(cacheLaneScriptSource).toContain(
      "fail 'editor publication mutated tracked member sources'",
    )
    expect(cacheLaneScriptSource).not.toContain('tasks run buck2:typescript:publish-editor-views')
    expect(cacheLaneScriptSource).not.toContain('DEVENV_BIN')
    // Authority is a prerequisite, so it is paid before the first cold observation and its
    // Buck work is discarded by the wipe that follows.
    expect(cacheLaneScriptSource).toContain(
      '"$buck2" run effect_utils//scripts:editor-view-authority --',
    )
    expect(capacityMode.indexOf('wipe_owned_buck_state')).toBeGreaterThan(prerequisites)
    // Each curve point is an independent COLD cumulative build.
    expect(cacheLaneScriptSource).toContain(
      '      wipe_owned_buck_state\n      run_capacity_build "curve-$class"',
    )
    expect(cacheLaneScriptSource).toContain('coldCumulative: true')
    expect(cacheLaneScriptSource).toContain('previousRawCumulative: {')
    expect(cacheLaneScriptSource).toContain(
      '(($measurement.wallTimeMs - $previous_wall) / $class_label_count)',
    )
    // Exact sorted set equality against the generated list, not just a count.
    expect(cacheLaneScriptSource).toContain(
      '[ "$(printf \'%s\\n\' "${capacity_cumulative[@]}" | sort)" = "$(printf \'%s\\n\' "${GRAPH_LABELS[@]}" | sort)" ]',
    )
    expect(cacheLaneScriptSource).toContain('--local-only --no-remote-cache')
    expect(cacheLaneScriptSource).toContain(
      "fail 'capacity requires composition-owned BUCK2_NO_REMOTE_CACHE=1'",
    )
    expect(cacheLaneScriptSource).toContain("fail 'editor publication uploaded remote evidence'")
    // Product labels are classified explicitly and an unmatched label is a refusal.
    expect(cacheLaneScriptSource).toContain('*:*-candidate) capacity_products+=("$label") ;;')
    expect(cacheLaneScriptSource).toContain(
      'fail "candidate graph label belongs to no capacity class: $label"',
    )
  })

  it('emits every DQ4 dimension without inventing a threshold', () => {
    for (const field of [
      'coldFullCandidateGraph',
      'editorPublication',
      'combinedCold',
      'physicalConsumedPeakBytes',
      'physicalConsumedDeltaBytes',
      'minAvailableBytes',
      'peakHostUsedBytes',
      'retainedLogicalBytes',
      'repositoryTotalBytes',
      'retainedGenerationCount',
      'actionDurationP95Ms',
      'stagingActionDurationP95Ms',
      'marginalCurve',
      'warmFullCandidateGraph',
      'remoteEvidence',
      'runnerProfile',
      'jobTimeoutMinutes',
      'jobConcurrency',
      'marginalSlope',
      'wallTimeMsPerAddedLabel',
      'retainedBuckOutBytesPerAddedLabel',
      'retainedOutputBytesPerAddedLabel',
      'localActionCountPerAddedLabel',
      'requestedSampleIntervalMs',
      'observedIntervalMsMin',
      'observedIntervalMsMax',
      'observedIntervalMsMean',
      'timeoutHeadroomMs',
      'reflink',
      'actionDurationField',
      'classLabelCounts',
    ]) {
      expect(cacheLaneScriptSource, field).toContain(field)
    }
    expect(cacheLaneScriptSource).toContain('thresholds: null')
    expect(cacheLaneScriptSource).toContain(
      "fail 'candidate graph has no admitted editor packages'",
    )
    expect(cacheLaneScriptSource).toContain(
      'fail "editor package published no retained snapshot generation: $package"',
    )
    // Sampling is O(1) in-phase; `du` is a phase-boundary logical measurement only.
    expect(cacheLaneScriptSource).toContain('df -B1 --output=avail "$workspace"')
    expect(cacheLaneScriptSource).toContain("sed -n 's/^MemAvailable:")
    expect(cacheLaneScriptSource).toContain(
      'phaseBoundaryDisk: "GNU du -s -B1 at phase boundaries only',
    )
    expect(cacheLaneScriptSource).not.toContain('capacity_disk_bytes')
    expect(cacheLaneScriptSource).toContain('cp --reflink=always')
    expect(cacheLaneScriptSource).toContain('buck2 log what-ran --format json')
    expect(cacheLaneScriptSource).toContain('| .duration | duration_ms')
  })

  it('uploads only the bounded JSON and leaves teardown to owned idempotent cleanup', () => {
    expect(capacity).toContain('name: Upload Buck2 capacity evidence')
    expect(capacity).toContain("path: '${{ runner.temp }}/buck2-capacity-evidence/capacity.json'")
    expect(capacity).toContain('if-no-files-found: error')
    expect(capacity).toContain('retention-days: 14')
    expect(capacity).toContain('name: Cleanup effect-utils composition')
    expect(capacity.indexOf('name: Cleanup effect-utils composition')).toBeGreaterThan(
      capacity.indexOf('name: Upload Buck2 capacity evidence'),
    )
    expect(cacheLaneScriptSource).toContain('trap capacity_cleanup EXIT')
    expect(cacheLaneScriptSource).toContain('wipe_owned_buck_state')
    expect(cacheLaneScriptSource).not.toContain('rm -rf "$member"')
  })

  it('proves the outage control-then-treatment with a connection signature', () => {
    const outageMode = cacheLaneScriptSource.slice(cacheLaneScriptSource.indexOf('  outage)'))
    const control = outageMode.indexOf('control: building the label with the remote cache disabled')
    const wipe = outageMode.indexOf('wipe_owned_buck_state')
    const override = outageMode.indexOf('} > "$override"')
    const treatment = outageMode.indexOf('the build SUCCEEDED against an unreachable cache')
    expect(control).toBeGreaterThan(0)
    expect(wipe).toBeGreaterThan(control)
    expect(override).toBeGreaterThan(wipe)
    expect(treatment).toBeGreaterThan(override)
    // The control build must succeed with the cache disabled, or the treatment failure
    // could be a broken target rather than an outage.
    expect(cacheLaneScriptSource).toContain(
      "fail 'the control build failed with the cache disabled, so this runner cannot prove anything about an outage'",
    )
    // A bare nonzero exit is explicitly insufficient: the captured output must name the
    // remote-cache / RE connection.
    expect(cacheLaneScriptSource).toContain('outage_signature=')
    expect(cacheLaneScriptSource).toContain('grep -Eiq -- "$outage_signature" "$outage_log"')
    expect(cacheLaneScriptSource).toContain(
      "fail 'the build failed WITHOUT a remote-cache/RE connection signature, so this is an unrelated failure rather than the cache outage under proof'",
    )
    for (const signature of ['re_client', 'action_cache', 'grpc', 'Connection refused']) {
      expect(cacheLaneScriptSource, signature).toContain(signature)
    }
  })

  it('invokes the committed lane scripts through bash for composition portability', () => {
    for (const script of ['buck2-cache-preflight.sh', 'buck2-cache-lane.sh']) {
      expect(ciWorkflowSource, script).toContain(
        `bash "$GITHUB_WORKSPACE/genie/ci-scripts/${script}"`,
      )
    }
    for (const block of [publish, restore, outage, capacity]) {
      expect(block).toContain('bash "$GITHUB_WORKSPACE/genie/ci-scripts/buck2-cache-lane.sh"')
    }
    // Every lane invocation goes through `bash`, so none is left as a bare exec of the
    // committed script file.
    expect(generatedCiWorkflowYamlSource).not.toMatch(
      /^\s*"\$GITHUB_WORKSPACE\/genie\/ci-scripts\/buck2-cache-(lane|preflight)\.sh"/mu,
    )
  })

  it('executes capacity cache-disabled beside an ordinary buckconfig and cleans owned state', () => {
    const root = mkdtempSync(join(tmpdir(), 'buck2-capacity-lane-'))
    const workspace = join(root, 'workspace')
    const member = join(workspace, 'repos', 'effect-utils')
    const runnerTemp = join(root, 'runner-temp')
    const resultDir = join(runnerTemp, 'buck2-capacity-evidence')
    const buck2 = join(workspace, '.megarepo', 'bin', 'buck2')
    const systemTools = join(root, 'system-tools')
    const graph = join(member, 'graph.txt')
    try {
      mkdirSync(dirname(buck2), { recursive: true })
      mkdirSync(join(member, 'packages', 'app'), { recursive: true })
      mkdirSync(runnerTemp, { recursive: true })
      mkdirSync(systemTools)
      writeFileSync(
        join(systemTools, 'lscpu'),
        `#!${bashBin}\nprintf 'Model name: Fixture CPU\\n'\n`,
      )
      writeFileSync(join(systemTools, 'nproc'), `#!${bashBin}\nprintf '8\\n'\n`)
      chmodSync(join(systemTools, 'lscpu'), 0o755)
      chmodSync(join(systemTools, 'nproc'), 0o755)
      writeFileSync(
        join(workspace, '.buckconfig.local'),
        '[buck2_re_client]\naction_cache_address = grpc://ordinary-developer-cache.invalid:1\n',
      )
      writeFileSync(
        graph,
        [
          'effect_utils//buck2/toolchains:archive_tool',
          'effect_utils//packages/app:editor_view_inputs',
          'effect_utils//packages/app:typecheck',
          'effect_utils//packages/app:dist',
          'effect_utils//packages/app:app-candidate',
          '',
        ].join('\n'),
      )
      writeFileSync(
        buck2,
        `#!${bashBin}
set -euo pipefail
workspace=${JSON.stringify(workspace)}
ops=${JSON.stringify(join(root, 'ops.log'))}
case "\${1:-}" in
  build)
    shift
    printf 'build %s\\n' "$*" >> "$ops"
    mkdir -p "$workspace/buck-out/megarepo/art" "$workspace/buck-out/megarepo/tmp"
    printf output > "$workspace/buck-out/megarepo/art/output"
    ;;
  run)
    shift
    printf 'run %s\\n' "$*" >> "$ops"
    target="\${1:-}"
    case "$target" in
      effect_utils//scripts:editor-view-authority)
        output=''
        while [ "$#" -gt 0 ]; do
          if [ "$1" = '--output' ]; then output="\${2:-}"; fi
          shift
        done
        [ -n "$output" ] || exit 3
        mkdir -p "$(dirname "$output")"
        printf '%s\\n' '{"schema":"effect-utils/workspace-dependency-authority/v1"}' > "$output"
        ;;
      effect_utils//scripts:buck-watch)
        store=${JSON.stringify(join(member, 'packages', '.editor-view', '.store', `app-${'a'.repeat(64)}`))}
        mkdir -p "$store/node_modules"
        printf snapshot > "$store/node_modules/value"
        printf '%s\\n' '{"schema":"effect-utils/editor-view/v2","package":"packages/app"}' > "$store/editor-view.json"
        ;;
      *) exit 2 ;;
    esac
    ;;
  log)
    case "\${2:-}" in
      what-ran)
        printf '%s\\n' '{"reason":"build","identity":"package_view fixture","reproducer":{"executor":"Local","details":{"env":{"BUCK_SCRATCH_PATH":"buck-out/megarepo/tmp"}}},"duration":"1.5ms"}'
        ;;
      what-uploaded) ;;
      *) exit 2 ;;
    esac
    ;;
  kill) ;;
  *) exit 2 ;;
esac
`,
      )
      chmodSync(buck2, 0o755)
      expect(spawnSync(gitBin, ['init', '-q'], { cwd: member }).status).toBe(0)
      const authorEmail = '261620128+schickling-assistant@users.noreply.github.com'
      const authorName = 'schickling-assistant'
      expect(spawnSync(gitBin, ['config', 'user.email', authorEmail], { cwd: member }).status).toBe(
        0,
      )
      expect(spawnSync(gitBin, ['config', 'user.name', authorName], { cwd: member }).status).toBe(0)
      expect(spawnSync(gitBin, ['add', '.'], { cwd: member }).status).toBe(0)
      const commitResult = spawnSync(
        gitBin,
        ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'],
        { cwd: member, encoding: 'utf8' },
      )
      expect(commitResult.status, commitResult.stderr).toBe(0)

      const result = spawnSync(bashBin, [cacheLaneScriptPath, 'capacity', 'graph.txt'], {
        cwd: member,
        encoding: 'utf8',
        env: {
          ...process.env,
          BUCK2_CAPACITY_RESULT_DIR: resultDir,
          BUCK2_CAPACITY_RUNNER_PROFILE: 'namespace-profile-linux-x86-64',
          BUCK2_CAPACITY_TIMEOUT_MINUTES: '240',
          BUCK2_CAPACITY_JOB_CONCURRENCY: '1',
          BUCK2_CAPACITY_SAMPLE_MS: '10',
          BUCK2_NO_REMOTE_CACHE: '1',
          PATH: [systemTools, dirname(devenvModuleToolsBin), process.env.PATH]
            .filter(Boolean)
            .join(delimiter),
          BUCK2_CAPACITY_SNAPSHOT_RETENTION: '3',
          GITHUB_STEP_SUMMARY: join(root, 'summary.md'),
          EFFECT_UTILS_MEMBER_ROOT: member,
          EFFECT_UTILS_WORKSPACE_ROOT: workspace,
          RUNNER_TEMP: runnerTemp,
        },
      })
      expect(result.status, result.stderr).toBe(0)
      const evidence = JSON.parse(readFileSync(join(resultDir, 'capacity.json'), 'utf8'))
      expect(evidence.graph.labelCount).toBe(5)
      expect(evidence.editorSnapshots.packages).toEqual([
        expect.objectContaining({ package: 'packages/app', retainedGenerationCount: 1 }),
      ])
      expect(evidence.marginalCurve).toHaveLength(5)
      expect(evidence.warmFullCandidateGraph.actions.remoteExecutionActionCount).toBe(0)
      expect(evidence.remoteEvidence).toEqual({
        importedActionCount: 0,
        remoteExecutionActionCount: 0,
        uploadedDigestCount: 0,
      })
      expect(evidence.runner).toMatchObject({
        runnerProfile: 'namespace-profile-linux-x86-64',
        jobTimeoutMinutes: 240,
        jobConcurrency: 1,
      })
      expect(evidence.marginalCurve[0]).toMatchObject({ coldCumulative: true })
      expect(evidence.marginalCurve[0].previousRawCumulative).toEqual({
        wallTimeMs: 0,
        localActionCount: 0,
        retainedBuckOutBytes: 0,
        retainedOutputBytes: 0,
      })
      expect(evidence.marginalCurve[1].previousRawCumulative.localActionCount).toBe(
        evidence.marginalCurve[0].actions.localActionCount,
      )
      expect(evidence.marginalCurve[0].marginalSlope).toEqual({
        wallTimeMsPerAddedLabel: expect.any(Number),
        localActionCountPerAddedLabel: 1,
        retainedBuckOutBytesPerAddedLabel: expect.any(Number),
        retainedOutputBytesPerAddedLabel: expect.any(Number),
      })
      expect(typeof evidence.runner.filesystem.reflink.supported).toBe('boolean')
      expect(evidence.budget.jobTimeoutMs).toBe(240 * 60000)
      expect(evidence.budget.timeoutHeadroomMs).toBeLessThan(evidence.budget.jobTimeoutMs)
      expect(evidence.coldFullCandidateGraph.host.sampling.observedIntervalMsMean).toBeGreaterThan(
        0,
      )
      expect(evidence.coldFullCandidateGraph.host.filesystem).toMatchObject({
        physicalConsumedPeakBytes: expect.any(Number),
        physicalConsumedDeltaBytes: expect.any(Number),
      })
      expect(evidence.coldFullCandidateGraph.host.memory.minAvailableBytes).toBeGreaterThan(0)
      const ops = readFileSync(join(root, 'ops.log'), 'utf8').trimEnd().split('\n')
      // Authority is the FIRST Buck operation, before any measured build.
      expect(ops[0]).toContain('run effect_utils//scripts:editor-view-authority -- --repo-root')
      expect(ops.filter((line) => line.startsWith('build ')).length).toBe(7)
      for (const line of ops.filter((line) => line.startsWith('build '))) {
        expect(line).toContain('--local-only --no-remote-cache')
      }
      expect(ops.some((line) => line.includes('scripts:buck-watch -- publish'))).toBe(true)
      expect(ops.some((line) => line.includes('--snapshot-retention 3'))).toBe(true)
      expect(ops.join('\n')).not.toContain('publish-editor-views')
      expect(existsSync(join(member, '.devenv', 'editor-workspace-authority.json'))).toBe(true)
      expect(existsSync(join(workspace, 'buck-out', 'megarepo'))).toBe(false)
      expect(existsSync(join(workspace, '.buckconfig.local'))).toBe(true)
      expect(readFileSync(join(root, 'summary.md'), 'utf8')).toContain(
        'Buck2 capacity evidence (DQ4)',
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
