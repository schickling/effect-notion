import {
  githubWorkflow,
  type ActionlintConfig,
  type GitHubWorkflowArgs,
} from '../../packages/@overeng/genie/src/runtime/mod.ts'
import { RUNNER_PROFILES, type RunnerProfile } from '../ci.ts'

export { RUNNER_PROFILES, type RunnerProfile }

// =============================================================================
// Shared Config
// =============================================================================

/** Self-hosted NixOS runner labels (x86_64-linux, e.g. dev3) */
export const linuxX64Runner = ['sh-linux-x64', 'nix'] as const

/** Self-hosted NixOS runner labels (aarch64-linux, e.g. dev4) */
export const linuxArm64Runner = ['sh-linux-arm64', 'nix'] as const

/** Self-hosted macOS runner labels (aarch64-darwin, e.g. mbp2021) */
export const darwinArm64Runner = ['sh-darwin-arm64', 'nix'] as const

/** Namespace Linux runner with 288 GB for paired base/head Nix closures. */
export const namespaceLinuxX64PairedPerfRunner = 'nscloud-ubuntu-24.04-amd64-16x64-with-features'

/** Label prefix of a Namespace runner PROFILE, which is the only label kind that takes feature suffixes. */
export const namespaceProfileLabelPrefix = 'namespace-profile-'

/**
 * Suffix a raw Namespace MACHINE label must carry for its companion `namespace-features:`
 * label to be honored. A raw label without it silently ignores requested features.
 */
export const namespaceFeaturesCapableLabelSuffix = '-with-features'

/**
 * Namespace privileged-container feature.
 *
 * Bubblewrap refuses `pivot_root` inside the default unprivileged Namespace container, so
 * every job that executes a sandboxed Buck TypeScript action has to request privileged
 * mode: https://namespace.so/docs/reference/github-actions/runner-configuration
 *
 * The feature is spelled as `container.privileged=true` in exactly one of two places, and
 * they are NOT interchangeable: appended to a `namespace-profile-*` label with `;`, or as
 * an entry of the companion `namespace-features:` label for a raw runner label.
 */
export const namespacePrivilegedContainerFeature = 'container.privileged=true'

/** `;`-suffix form, valid only on a `namespace-profile-*` label. */
export const namespacePrivilegedContainerSuffix = `;${namespacePrivilegedContainerFeature}`

/** The privileged-container label for one Namespace profile. */
export const namespacePrivilegedProfile = (profile: RunnerProfile | (string & {})) =>
  `${profile}${namespacePrivilegedContainerSuffix}`

/** All self-hosted runner labels — derived from the runner constants above + RUNNER_PROFILES */
const SELF_HOSTED_RUNNER_LABELS = [
  ...new Set([
    ...RUNNER_PROFILES,
    ...linuxX64Runner,
    ...linuxArm64Runner,
    ...darwinArm64Runner,
    namespaceLinuxX64PairedPerfRunner,
    // Privileged PROFILE variant of the Linux Namespace profile that runs sandboxed Buck
    // actions: actionlint resolves a literal label, so the suffixed profile is admitted too.
    // The raw `nscloud-*` label never takes a suffix — its feature rides the
    // `namespace-features:` label — so no suffixed raw form is admitted here.
    namespacePrivilegedProfile('namespace-profile-linux-x86-64'),
  ]),
] as const

/** Default actionlint config with all known self-hosted runner labels */
export const defaultActionlintConfig: ActionlintConfig = {
  selfHostedRunnerLabels: SELF_HOSTED_RUNNER_LABELS,
}

/** Standard shell defaults for CI run steps */
export const bashShellDefaults = {
  run: { shell: 'bash' },
} as const

/**
 * Standard CI environment variables.
 * GITHUB_TOKEN is exported for tools that need it as a shell env var (e.g. gh CLI, nix auth).
 * Nix eval policy is enforced at step runtime by helpers like
 * `validateNixStoreStep` and `runDevenvTasksBefore`, which append
 * `restrict-eval = false` while preserving inherited NIX_CONFIG values.
 */
export const standardCIEnv = {
  FORCE_SETUP: '1',
  CI: 'true',
  BUCK2_NO_REMOTE_CACHE: '1',
  GITHUB_TOKEN: '${{ github.token }}',
} as const

/**
 * Cancel superseded CI jobs for the same event, ref, and job id.
 *
 * This is intentionally job-level, not workflow-level. GitHub can wedge
 * workflow_dispatch runs before job creation; when that happens, the run has no
 * check runs, no logs, and the API may return 500 for cancellation. Keeping
 * concurrency at job level lets workflow evaluation materialize visible jobs
 * before any scarce-runner throttling applies.
 *
 * Code validation is a branch-protection signal for the latest PR head. Keeping
 * older code-triggered pull_request jobs alive can consume scarce runners after
 * a newer head exists, so jobs with the same id still cancel superseded work.
 *
 * Measurement baseline backfills are keyed by their subject ref and do not
 * cancel in-progress runs so several historical refs can be backfilled without
 * canceling each other.
 *
 * Manual dispatches are intentionally keyed by run id. They are operator probes
 * and baseline/debug tools, not the authoritative PR-comment path.
 *
 * Merge-queue label churn is different: only the mq:ci-admitted label event is
 * allowed to materialize full PR CI. Other label events do not change the
 * commit under test and must not cancel an already-running validation run.
 */
type CiConcurrencyOptions = {
  readonly matrix?: boolean
  readonly measurementBaselineBackfill?: boolean
}

const ciConcurrencyScope = (opts?: Pick<CiConcurrencyOptions, 'measurementBaselineBackfill'>) =>
  opts?.measurementBaselineBackfill === true
    ? "${{ github.event_name == 'workflow_dispatch' && inputs.measurement_baseline_ref != '' && format('measurement-baseline-{0}', inputs.measurement_baseline_ref) || (github.event_name == 'workflow_dispatch' && format('manual-run-{0}', github.run_id) || (github.event_name == 'pull_request' && (github.event.action == 'labeled' || github.event.action == 'unlabeled') && format('label-{0}', github.event.label.name) || 'code')) }}"
    : "${{ github.event_name == 'workflow_dispatch' && format('manual-run-{0}', github.run_id) || (github.event_name == 'pull_request' && (github.event.action == 'labeled' || github.event.action == 'unlabeled') && format('label-{0}', github.event.label.name) || 'code') }}"

const ciCancelInProgress = (opts?: Pick<CiConcurrencyOptions, 'measurementBaselineBackfill'>) =>
  opts?.measurementBaselineBackfill === true
    ? "${{ !(github.event_name == 'workflow_dispatch' && inputs.measurement_baseline_ref != '') && (github.event_name != 'pull_request' || (github.event.action != 'labeled' && github.event.action != 'unlabeled')) }}"
    : "${{ github.event_name != 'pull_request' || (github.event.action != 'labeled' && github.event.action != 'unlabeled') }}"

export const ciJobConcurrency = ({ jobId, ...opts }: { jobId: string } & CiConcurrencyOptions) =>
  ({
    group:
      '${{ github.workflow }}-${{ github.event_name }}-${{ github.ref }}-' +
      ciConcurrencyScope(opts) +
      `-${jobId}` +
      (opts?.matrix === true ? '-${{ strategy.job-index }}' : ''),
    'cancel-in-progress': ciCancelInProgress(opts),
  }) as const

const isMatrixJob = (job: GitHubWorkflowArgs['jobs'][string]) =>
  typeof job.strategy === 'object' && job.strategy !== null && 'matrix' in job.strategy

const workflowDispatchBaselineRefInput = {
  description:
    'Optional ref/SHA to checkout before running CI measurement jobs. Used to backfill comparable baseline artifacts.',
  required: false,
  default: '',
  type: 'string',
} as const

const withJobConcurrencyDispatchInputs = (
  on: GitHubWorkflowArgs['on'],
): GitHubWorkflowArgs['on'] => {
  if (
    typeof on !== 'object' ||
    on === null ||
    !('workflow_dispatch' in on) ||
    on.workflow_dispatch === null
  ) {
    return on
  }

  return {
    ...on,
    workflow_dispatch: {
      ...on.workflow_dispatch,
      inputs: {
        measurement_baseline_ref: workflowDispatchBaselineRefInput,
        ...on.workflow_dispatch.inputs,
      },
    },
  }
}

const supportsMeasurementBaselineBackfill = (on: GitHubWorkflowArgs['on']) =>
  typeof on === 'object' &&
  on !== null &&
  'workflow_dispatch' in on &&
  on.workflow_dispatch !== null

const withDefaultJobConcurrency = ({
  jobs,
  ...opts
}: { jobs: GitHubWorkflowArgs['jobs'] } & Pick<
  CiConcurrencyOptions,
  'measurementBaselineBackfill'
>): GitHubWorkflowArgs['jobs'] =>
  Object.fromEntries(
    Object.entries(jobs).map(([jobId, job]) => [
      jobId,
      job.concurrency === undefined
        ? { ...job, concurrency: ciJobConcurrency({ jobId, ...opts, matrix: isMatrixJob(job) }) }
        : job,
    ]),
  )

export const ciWorkflowConcurrency = {
  group:
    '${{ github.workflow }}-${{ github.event_name }}-${{ github.ref }}-' + ciConcurrencyScope(),
  'cancel-in-progress': ciCancelInProgress(),
} as const

/**
 * Standard wrapper for composed CI workflows.
 *
 * This keeps cancellation policy centralized in `effect-utils`. Repos can still
 * override the workflow-level policy by passing an explicit `concurrency`
 * field, and individual jobs can opt out or provide their own `concurrency`.
 */
export const ciWorkflow = (args: GitHubWorkflowArgs) =>
  (({ concurrency, actionlint, jobs, on, ...rest }) =>
    githubWorkflow({
      ...rest,
      on: concurrency === undefined ? withJobConcurrencyDispatchInputs(on) : on,
      ...(concurrency === undefined ? {} : { concurrency }),
      actionlint: actionlint ?? defaultActionlintConfig,
      jobs:
        concurrency === undefined
          ? withDefaultJobConcurrency({
              jobs,
              measurementBaselineBackfill: supportsMeasurementBaselineBackfill(on),
            })
          : jobs,
    }))(args)

export type NixConfigOptions = {
  unrestrictedEval?: boolean
  extraLines?: readonly string[]
}

export type NixBinaryCache = {
  readonly uri: string
  readonly publicKey: string
}

export const devenvBinaryCache = {
  uri: 'https://devenv.cachix.org',
  publicKey: 'devenv.cachix.org-1:w1cLUi8dv3hnoSPGAuibQv+f9TZLr6cv/Hm9XgU50cw=',
} as const satisfies NixBinaryCache

/** Build a binary-cache descriptor for a Cachix cache. */
export const cachixBinaryCache = (opts: { name: string; publicKey: string }): NixBinaryCache => ({
  uri: `https://${opts.name}.cachix.org`,
  publicKey: opts.publicKey,
})

const dedupeBinaryCaches = (caches: readonly NixBinaryCache[]) => [
  ...new Map(caches.map((cache) => [cache.uri, cache])).values(),
]

export const cachixHostsFromBinaryCaches = (caches: readonly NixBinaryCache[]) => [
  ...new Set(
    caches.flatMap((cache) => {
      const host = new URL(cache.uri).host
      return host.endsWith('.cachix.org') === true ? [host] : []
    }),
  ),
]

/** Render `extra-conf` lines for one or more binary caches. */
export const nixBinaryCachesExtraConf = (caches: readonly NixBinaryCache[]) => {
  const resolvedCaches = dedupeBinaryCaches([devenvBinaryCache, ...caches])
  return [
    `extra-substituters = ${resolvedCaches.map((cache) => cache.uri).join(' ')}`,
    `extra-trusted-public-keys = ${resolvedCaches.map((cache) => cache.publicKey).join(' ')}`,
  ].join('\n')
}

export const devenvBinRef = '"${DEVENV_BIN:?DEVENV_BIN not set}"'

export const shellSingleQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`

export const resolveDevenvRevScriptFor = (
  lockFile = 'devenv.lock',
) => `DEVENV_REV=$(jq -r .nodes.devenv.locked.rev ${shellSingleQuote(lockFile)})
if [ -z "$DEVENV_REV" ] || [ "$DEVENV_REV" = "null" ]; then
  printf '::error::%s missing .nodes.devenv.locked.rev\\n' ${shellSingleQuote(lockFile)}
  exit 1
fi`

export const resolveDevenvRevScript = resolveDevenvRevScriptFor()

export const resolveDevenvFnScript = `DEVENV_GC_ROOT_DIR="${'${RUNNER_TEMP:-/tmp}'}/genie-nix-gc-roots"
DEVENV_GC_ROOT_ID=$(printf '%s' "${'${GITHUB_RUN_ID:-local-$$}'}-${'${GITHUB_RUN_ATTEMPT:-0}'}-${'${GITHUB_JOB:-job}'}" | tr -c 'A-Za-z0-9._-' '_')
DEVENV_GC_ROOT="$DEVENV_GC_ROOT_DIR/devenv-$DEVENV_GC_ROOT_ID"

resolve_devenv_once() {
  mkdir -p "$DEVENV_GC_ROOT_DIR"
  nix build \\
    --accept-flake-config \\
    --option extra-substituters ${devenvBinaryCache.uri} \\
    --option extra-trusted-public-keys ${devenvBinaryCache.publicKey} \\
    --out-link "$DEVENV_GC_ROOT" \\
    --print-out-paths \\
    "github:cachix/devenv/$DEVENV_REV#devenv"
}

resolve_devenv() {
  local invalid_path
  local log
  local rc

  log=$(mktemp)
  if resolve_devenv_once 2>"$log"; then
    cat "$log" >&2
    rm -f "$log"
    return 0
  else
    rc=$?
  fi
  cat "$log" >&2
  invalid_path=$(grep -E -o "error:[[:space:]]*path '/nix/store/[^']*'[[:space:]]*is not( a)? valid( store path)?" "$log" |
    head -1 | grep -o "/nix/store/[^']*" || true)
  rm -f "$log"
  [ -n "$invalid_path" ] || return "$rc"

  echo "::warning::devenv resolution hit an invalid Nix store path; clearing the client eval cache and retrying once: $invalid_path" >&2
  rm -rf "${'${XDG_CACHE_HOME:-$HOME/.cache}'}/nix/eval-cache-"* ~/.cache/nix/eval-cache-*
  nix-store --repair-path "$invalid_path" >/dev/null 2>&1 ||
    nix-store --realise "$invalid_path" >/dev/null 2>&1 || true
  if resolve_devenv_once; then
    if [ -n "${'${GITHUB_STEP_SUMMARY:-}'}" ]; then
      echo '### Recovered Nix store lifecycle incident' >> "$GITHUB_STEP_SUMMARY"
      echo "- Invalid path: $invalid_path" >> "$GITHUB_STEP_SUMMARY"
      echo '- Attempts: 2/2' >> "$GITHUB_STEP_SUMMARY"
    fi
    return 0
  else
    return $?
  fi
}`

/** Build extra-conf / NIX_CONFIG content for common Nix feature flags. */
export const nixExtraConf = (opts: NixConfigOptions = {}) =>
  [
    ...(opts.unrestrictedEval === true ? ['restrict-eval = false'] : []),
    ...(opts.extraLines ?? []),
  ].join('\n')

export const withAppendedNixConfig = ({
  command,
  opts = {},
}: {
  command: string
  opts?: NixConfigOptions
}) => {
  const extraConf = nixExtraConf(opts)
  if (extraConf === '') {
    return command
  }

  const quotedExtraConf = shellSingleQuote(extraConf)
  return `if [ -n "${'${NIX_CONFIG:-}'}" ]; then NIX_CONFIG_WITH_APPEND=$(printf '%s\\n%s' "$NIX_CONFIG" ${quotedExtraConf}); else NIX_CONFIG_WITH_APPEND=${quotedExtraConf}; fi; NIX_CONFIG="$NIX_CONFIG_WITH_APPEND" ${command}`
}

export const dollar = '$'

/** Stable runner scratch shared by one job's synthesized composition and mutable tool state. */
export const ciCompositionStateRoot = '${{ runner.temp }}/composition-state'

/** Stable pnpm home restored independently of the disposable synthesized workspace path. */
export const ciPnpmHome = `${ciCompositionStateRoot}/pnpm-home`

/** Stable pnpm content store projected into the owned member through a relative workspace symlink. */
export const ciPnpmStore = `${ciCompositionStateRoot}/pnpm-store-pure-v1`

/** Canonical stable pnpm state surface used by both cache restore and save. */
export const ciPnpmStatePaths = [ciPnpmHome, ciPnpmStore].join('\n')

/** Job-local CI diagnostics directory used for runner pressure snapshots and install logs. */
export const jobLocalCiDiagnosticsDir = `${ciCompositionStateRoot}/diagnostics/${'${{ github.job }}'}`

/** Stable mutable Nix client cache root, independent of CI run and workspace identity. */
export const ciNixCacheRoot = `${ciCompositionStateRoot}/nix-cache`

/** Default Nix cache path restored/saved by the shared CI cache helpers. */
export const ciNixCachePath = `${ciNixCacheRoot}/nix`

/**
 * Enter the source checkout selected for this shell step. Effect-utils CI exports
 * the synthesized owned member; downstream workflows fall back to checkout.
 */
export const ciSourceRoot = 'cd "${EFFECT_UTILS_MEMBER_ROOT:-${GITHUB_WORKSPACE:-$PWD}}"'

/** Run one source-dependent shell command from the canonical CI source root. */
export const withCiSourceRoot = (command: string) => `${ciSourceRoot} && ${command}`

export const runDevenvTasksBeforeWithOptions = (
  opts: NixConfigOptions,
  ...args: [string, ...string[]]
) =>
  withCiSourceRoot(
    withAppendedNixConfig({
      command: `DEVENV_TASK_PASSTHROUGH=1 DEVENV_TUI=false ${devenvBinRef} tasks run ${args.join(' ')}`,
      opts,
    }),
  )

export const defaultCiRuntimeScriptsDir = 'genie/ci-scripts'
export const preparedCiRuntimeScriptsDir = `${ciCompositionStateRoot}/ci-runtime`
export const prepareJobLocalRustState = `. "${preparedCiRuntimeScriptsDir}/prepare-job-local-rust-state.sh"`

export type GcRaceRetryOptions = {
  readonly command: string
  readonly label: string
  readonly scriptsDir?: string
}

/**
 * Retry wrapper for the Nix store validity race where `derivationStrict` fails
 * with `path '/nix/store/...' is not valid`.
 *
 * In practice this often surfaces through higher-level eval wrappers such as
 * `Failed to convert config.cachix to JSON` / `while evaluating the option
 * cachix.package` before the final invalid-store-path line appears. We treat
 * those as the same root cause and retry after realizing the missing path and
 * clearing the eval cache.
 *
 * Some runners also lose the multi-user Nix daemon socket after setup. Retry
 * those passively so host supervision can restore service; CI jobs must not
 * mutate the shared daemon. This daemon-socket sub-case is a distinct
 * runner-side failure mode and is not covered by the upstream refs below.
 *
 * TODO: Remove the store-validity-race retry once NixOS/nix#15469 and
 * DeterminateSystems/nix-src#395 are released. Reassess the daemon-socket retry
 * separately when host supervision exposes a stronger availability contract.
 * @see https://github.com/NixOS/nix/pull/15469
 * @see https://github.com/DeterminateSystems/nix-src/issues/395
 */
export const withGcRaceRetry = ({
  command,
  label,
  scriptsDir = preparedCiRuntimeScriptsDir,
}: GcRaceRetryOptions) => {
  const quotedCommand = shellSingleQuote(command)
  const quotedLabel = shellSingleQuote(label)
  const scriptPath = `${scriptsDir}/run-with-nix-gc-race-retry.sh`

  if (scriptsDir === defaultCiRuntimeScriptsDir) {
    return `bash ${shellSingleQuote(scriptPath)} ${quotedLabel} ${quotedCommand}`
  }

  return [
    `__genie_ci_retry_script=${shellSingleQuote(scriptPath)}`,
    `bash "$__genie_ci_retry_script" ${quotedLabel} ${quotedCommand}`,
  ].join('\n')
}

export const createRunDevenvTasksBefore =
  (opts: { readonly scriptsDir?: string } = {}) =>
  (...args: [string, ...string[]]) =>
    withGcRaceRetry({
      command: runDevenvTasksBeforeWithOptions({ unrestrictedEval: true }, ...args),
      label: `devenv tasks run ${args.join(' ')}`,
      ...(opts.scriptsDir === undefined ? {} : { scriptsDir: opts.scriptsDir }),
    })

/** Build a command that runs one or more devenv tasks with dependencies. */
export const runDevenvTasksBefore = createRunDevenvTasksBefore()
