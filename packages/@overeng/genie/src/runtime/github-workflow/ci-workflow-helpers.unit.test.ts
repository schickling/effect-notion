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
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

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

const generatedCiJobKeys = Array.from(
  (generatedCiWorkflowYamlSource.split('\njobs:\n')[1] ?? '').matchAll(/^  ([a-zA-Z0-9_-]+):$/gm),
  ([, jobKey]) => jobKey,
).filter((jobKey): jobKey is string => jobKey !== undefined)

const advisoryCheckContexts = new Set(['ci/measurements-report', 'notify-alignment'])
// Opt-in lanes (see OPT_IN_CI_JOB_NAMES in genie/ci.ts) are non-advisory but do not run on
// every pull request, so branch protection cannot require them: a skipped lane reports no
// check run at all and a required-but-absent context would wait forever.
const optInCheckContexts = new Set(['devenv-perf'])
const matrixCheckJobs = new Set(['test', 'nix-check', 'nix-fod-check'])
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
      `#!/usr/bin/env bash\nprintf 'attempt\\n' >> "$NIX_ATTEMPTS"\necho 'ordinary failure' >&2\nexit 23\n`,
    )
    chmodSync(join(bin, 'nix'), 0o755)
    try {
      const result = spawnSync(
        'bash',
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
      `#!/usr/bin/env bash
set -euo pipefail
attempt=1
if [ -f "$NIX_ATTEMPTS" ]; then attempt=$(( $(wc -l < "$NIX_ATTEMPTS") + 1 )); fi
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
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$NIX_REPAIRS"\nexit 0\n`,
    )
    chmodSync(join(bin, 'nix'), 0o755)
    chmodSync(join(bin, 'nix-store'), 0o755)
    try {
      const result = spawnSync(
        'bash',
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
    expect(ciWorkflowSource).toContain("uses: 'actions/checkout@v6' as const")
    expect(ciWorkflowSource).toContain("uses: 'cachix/cachix-action@v17' as const")
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
    expect(generatedWorkflowSource).toContain('.#netlify-cli')
    expect(generatedWorkflowSource).toContain('.#vercel-cli')
    expect(generatedWorkflowSource).not.toContain('nixpkgs#netlify-cli')
    expect(generatedWorkflowSource).not.toContain('bunx vercel')
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
    expect(generatedCiWorkflowYamlSource).toContain('}}-test-${{ strategy.job-index }}')
    expect(generatedCiWorkflowYamlSource).toContain('}}-nix-check-${{ strategy.job-index }}')
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
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
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
      spawnSync('git', ['config', field], {
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
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'printf \'%s|%s\\n\' "$PWD" "$*" >> "$FAKE_NIX_LOG"',
        'if [ "$*" != "build --no-link --print-out-paths .#megarepo" ]; then exit 64; fi',
        'printf \'%s\\n\' "$FAKE_MR_OUT"',
      ].join('\n'),
    )
    writeFileSync(
      join(mrOut, 'bin', 'mr'),
      [
        '#!/usr/bin/env bash',
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
        'if git -C "$workspace/repos/effect-utils" rev-parse --is-inside-work-tree >/dev/null 2>&1; then exit 0; fi',
        'bare="$MEGAREPO_STORE/github.com/overengineeringstudio/effect-utils/.bare"',
        'staged="$workspace.owned"',
        'git --git-dir="$bare" worktree move "$workspace" "$staged"',
        'mkdir -p "$workspace/repos" "$workspace/.megarepo/bin"',
        'git --git-dir="$bare" worktree move "$staged" "$workspace/repos/effect-utils"',
        'printf \'{}\\n\' > "$workspace/.megarepo-owned-worktree.json"',
        'printf \'{}\\n\' > "$workspace/.megarepo/composition-generation.json"',
        'printf \'[cells]\\n\' > "$workspace/.buckconfig"',
        'printf \'#!/usr/bin/env bash\\nexit 0\\n\' > "$workspace/.megarepo/bin/buck2"',
        'chmod +x "$workspace/.megarepo/bin/buck2"',
        'mkdir -p "$MEGAREPO_STORE/reference-effect"',
        'ln -s "$MEGAREPO_STORE/reference-effect" "$workspace/repos/effect"',
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
    return spawnSync('bash', ['-c', prepareEffectUtilsCompositionStep.run], {
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
    return spawnSync('bash', ['-c', cleanupEffectUtilsCompositionStep.run], {
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
          spawnSync('git', ['-C', workspace, 'rev-parse', '--is-inside-work-tree']).status,
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
      'nix-fod-check',
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

  it('keeps the Nix cache stable without projecting an ambient pnpm store', () => {
    expect(generatedCiWorkflowYamlSource).not.toContain(
      '${{ runner.temp }}/composition-state/pnpm-store-pure-v1',
    )
    expect(generatedCiWorkflowYamlSource).toContain(
      '${{ runner.temp }}/composition-state/nix-cache',
    )
    expect(generatedCiWorkflowYamlSource).not.toContain(
      '${{ runner.temp }}/composition-state/${{ github.run_id }}',
    )
    expect(buckToolchainsSource).not.toContain('store_dir =')
  })
})
