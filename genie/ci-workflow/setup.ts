import type { GitHubWorkflowArgs } from '../../packages/@overeng/genie/src/runtime/mod.ts'
import type { RunnerProfile } from '../ci.ts'
import { applyMegarepoLockStep } from './megarepo.ts'
import {
  bashShellDefaults,
  cachixHostsFromBinaryCaches,
  defaultCiRuntimeScriptsDir,
  jobLocalCiDiagnosticsDir,
  nixBinaryCachesExtraConf,
  resolveDevenvRevScriptFor,
  linuxX64Runner,
  runDevenvTasksBefore,
  shellSingleQuote,
  standardCIEnv,
  withGcRaceRetry,
  preparedCiRuntimeScriptsDir,
  ciNixCachePath,
  ciNixCacheRoot,
  ciPnpmHome,
  ciPnpmStatePaths,
  ciPnpmStore,
  withCiSourceRoot,
  type NixBinaryCache,
} from './shared.ts'

type WorkflowJob = GitHubWorkflowArgs['jobs'][string]
type WorkflowStep = WorkflowJob['steps'][number]

const evictOutPathShellLines = [
  '      if nix path-info "$outPath" >/dev/null 2>&1; then',
  '        echo "evicting cached: $(basename "$outPath")"',
  '        if ! nix store delete --ignore-liveness "$outPath" >/dev/null 2>&1; then',
  '          echo "::error::failed to evict cached pnpm-deps output: $outPath"',
  '          exit 1',
  '        fi',
  '        if nix path-info "$outPath" >/dev/null 2>&1; then',
  '          echo "::error::cached pnpm-deps output still present after eviction: $outPath"',
  '          exit 1',
  '        fi',
  '      fi',
] as const

const withEachPnpmDepsDrvShellLines = ({
  flakeRef,
  bodyLines,
}: {
  flakeRef: string
  bodyLines: readonly string[]
}) =>
  [
    `targetRef=${shellSingleQuote(flakeRef)}`,
    'entriesJson=$(mktemp)',
    'if nix eval --json "$targetRef.passthru.depsBuildEntries" >"$entriesJson" 2>/dev/null; then',
    "  while IFS=$'\\t' read -r attrName drv; do",
    '    [ -n "$drv" ] || continue',
    ...bodyLines,
    '  done < <(jq -r \'.[] | [.attrName, (.drvPath // "")] | @tsv\' "$entriesJson")',
    'else',
    '  topDrv=$(nix path-info --derivation "$targetRef" 2>/dev/null || true)',
    '  if [ -n "$topDrv" ]; then',
    '    while IFS= read -r drv; do',
    '      [ -n "$drv" ] || continue',
    '      attrName=""',
    ...bodyLines,
    '    done < <(nix-store -qR "$topDrv" 2>/dev/null | grep "pnpm-deps-[a-z0-9-]*-v[0-9].*\\.drv$" || true)',
    '  fi',
    'fi',
    'rm -f "$entriesJson"',
  ] as const

/** Evict cached pnpm-deps fixed-output outputs so CI re-derives them fresh. */
export const evictCachedPnpmDepsStep = ({
  flakeRef,
  name = 'Evict cached pnpm deps',
}: {
  flakeRef: string
  name?: string
}) => ({
  name,
  shell: 'bash',
  run: withCiSourceRoot(
    withEachPnpmDepsDrvShellLines({
      flakeRef,
      bodyLines: [
        '    while IFS= read -r outPath; do',
        '      [ -n "$outPath" ] || continue',
        ...evictOutPathShellLines,
        '    done < <(nix-store -q --outputs "$drv" 2>/dev/null || true)',
      ],
    }).join('\n'),
  ),
})

/**
 * Namespace runner with run ID-based affinity to prevent queue jumping.
 * Adds a run ID label so runners spawned for one workflow run
 * don't steal jobs from other runs.
 */
export const namespaceRunner = ({
  profile,
  runId,
}: {
  profile: RunnerProfile | (string & {})
  runId: string
}) => [profile, `namespace-features:github.run-id=${runId}`] as const

// =============================================================================
// Step Atoms
// =============================================================================

/** Node-24-safe major of the shared checkout action. */
export const defaultCheckoutActionRef = 'actions/checkout@v6'

/**
 * Immutable commit pins of the SAME action majors the defaults name, for jobs that
 * hold a credential while a third-party action is on the critical path.
 *
 * A floating major tag is mutable: whoever can move `v6` can run new code inside a job
 * that mints a tailnet-capable OIDC token. Only credential-bearing jobs pay the pinning
 * cost (a pinned action never picks up upstream fixes until someone repins it), so the
 * ordinary lanes deliberately keep their major tags.
 */
export const credentialBearingActionPins = {
  checkout: 'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803',
  determinateNix:
    'DeterminateSystems/determinate-nix-action@021c8a1bd3570eb21f5c20a054812b0c4d9ca614',
  cachix: 'cachix/cachix-action@38b082610b782e7e93e209c35fd730d399dee866',
} as const

/** Checkout repository via actions/checkout, by floating major unless `actionRef` pins it. */
export const checkoutStep = ({
  actionRef = defaultCheckoutActionRef,
  ...checkoutWith
}: {
  repository?: string
  ref?: string
  path?: string
  /** Immutable `owner/repo@sha` pin; required for credential-bearing jobs. */
  actionRef?: string
} = {}) => ({
  uses: actionRef,
  with: { 'persist-credentials': false, ...checkoutWith },
})

/**
 * Synthesize the disposable decision-0020 workspace used by effect-utils CI.
 *
 * The actions checkout remains untouched for action cleanup and artifact paths.
 * Every source-dependent command after this step runs from the branch-attached
 * owned member at `repos/effect-utils`.
 */
export const prepareEffectUtilsCompositionStep = {
  name: 'Prepare effect-utils composition',
  // Invoked through `bash` rather than executed: the script's `#!/usr/bin/env bash` shebang
  // needs an `/usr/bin/env` that a contained execution environment does not have, and the
  // interpreter is the same one GitHub's default `run:` shell already provides.
  run: 'bash "$GITHUB_WORKSPACE/genie/ci-scripts/prepare-effect-utils-composition.sh"',
} as const

/** Always remove the per-job synthesized workspace, worktree registration, and store. */
export const cleanupEffectUtilsCompositionStep = {
  name: 'Cleanup effect-utils composition',
  if: 'always()',
  run: 'bash "$GITHUB_WORKSPACE/genie/ci-scripts/cleanup-effect-utils-composition.sh"',
} as const

/** Immutable v4 pin of the Tailscale join action. */
export const tailscaleActionRef = 'tailscale/github-action@306e68a486fd2350f2bfc3b19fcd143891a4a2d8'

/** Explicit Tailscale client version installed by the pinned action. */
export const tailscaleClientVersion = '1.94.2'

/**
 * Join an ephemeral tailnet node for the duration of one job, authenticating with the
 * job's GitHub OIDC token instead of a stored Tailscale secret.
 *
 * Least privilege by construction: there is no long-lived credential to leak, the
 * Tailscale-side federated identity is pinned to this repository's issuer and subject and
 * to the single tag it may mint, the node is ephemeral (it disappears when the runner
 * does), and no tailnet host, address, or key material appears in the generated workflow.
 * The client id and audience are non-secret repository configuration, so they travel as
 * `vars.*` rather than `secrets.*`. The job must carry `permissions: id-token: write` for
 * the action to be able to mint the OIDC token at all.
 *
 * The action itself is pinned by commit, not by tag: this is the step that spends the
 * OIDC token, so a mutable `v4` would let whoever can move the tag run code next to the
 * credential. The Tailscale client version is likewise explicit rather than `latest`, so
 * a job cannot silently change which tailnet client joined the cache lane.
 */
export const tailnetEphemeralConnectStep = ({
  clientId,
  audience,
  tags,
  name = 'Join ephemeral tailnet',
}: {
  /** Tailscale federated-identity client id; non-secret, passed as `oauth-client-id`. */
  readonly clientId: string
  /** OIDC audience the Tailscale federated identity expects. */
  readonly audience: string
  readonly tags: string
  readonly name?: string
}) => ({
  name,
  // v4 (306e68a486fd2350f2bfc3b19fcd143891a4a2d8)
  uses: tailscaleActionRef,
  with: {
    'oauth-client-id': clientId,
    audience,
    tags,
    version: tailscaleClientVersion,
  },
})

/** Drop the ephemeral tailnet node even when the job failed. */
export const tailnetEphemeralDisconnectStep = {
  name: 'Leave ephemeral tailnet',
  if: 'always()',
  shell: 'bash',
  run: 'command -v tailscale >/dev/null 2>&1 && tailscale logout || true',
} as const

/**
 * Refuse to start a shared-cache lane whose cache is unconfigured or unreachable.
 *
 * Deliberately placed BEFORE the composition overlay: the endpoint has to be in the
 * generated root buckconfig before the first Buck invocation, so an outage must be
 * detected before that config is written rather than after a build silently degrades.
 */
export const buck2SharedCachePreflightStep = {
  name: 'Preflight shared Buck cache',
  run: 'bash "$GITHUB_WORKSPACE/genie/ci-scripts/buck2-cache-preflight.sh"',
} as const

/**
 * Directory the lane script fills with one `log what-uploaded --format json` record list
 * per evidence block. It is the artifact path below and the script's own default, so the
 * retained provenance and the uploaded artifact can never point at different directories.
 */
export const buck2SharedCacheProvenanceDir = '${{ runner.temp }}/buck2-cache-provenance'

/**
 * Retain the FULL uploaded-digest list, not just the summary count.
 *
 * The step summary carries a count, which cannot answer "which digests did this dispatch
 * write". `always()` because a failed assertion is exactly when the digest list matters,
 * and `warn` because a leg that dies before its first build legitimately has nothing to
 * upload and must fail on its own error rather than on a missing artifact.
 */
export const buck2SharedCacheProvenanceArtifactStep = {
  name: 'Upload uploaded-digest provenance',
  if: 'always()',
  uses: 'actions/upload-artifact@v4' as const,
  with: {
    name: 'buck2-cache-provenance-${{ github.job }}-run-${{ github.run_id }}-attempt-${{ github.run_attempt }}',
    path: buck2SharedCacheProvenanceDir,
    'if-no-files-found': 'warn',
    'retention-days': 14,
  },
} as const

/** Bounded machine-readable DQ4 evidence emitted by the opt-in capacity lane. */
export const buck2CapacityEvidenceDir = '${{ runner.temp }}/buck2-capacity-evidence'
export const buck2CapacityEvidenceArtifactStep = {
  name: 'Upload Buck2 capacity evidence',
  if: 'always()',
  uses: 'actions/upload-artifact@v4' as const,
  with: {
    name: 'buck2-capacity-${{ github.job }}-run-${{ github.run_id }}-attempt-${{ github.run_attempt }}',
    path: `${buck2CapacityEvidenceDir}/capacity.json`,
    'if-no-files-found': 'error',
    'retention-days': 14,
  },
} as const

/**
 * One leg of the shared-cache evidence lane. Every assertion is made by
 * `genie/ci-scripts/buck2-cache-lane.sh` from Buck's own `log what-ran` /
 * `log what-uploaded` records, never from wall time or exit code alone.
 */
export const buck2SharedCacheLaneStep = ({
  name,
  mode,
  args,
  env,
}: {
  readonly name: string
  readonly mode: 'publish' | 'restore' | 'miss' | 'outage' | 'capacity'
  readonly args: readonly string[]
  readonly env?: Record<string, string>
}) => ({
  name,
  ...(env === undefined ? {} : { env }),
  shell: 'bash',
  // Multi-line on purpose: a single-line `run` mixing shell double quotes with
  // shell-single-quoted arguments is not reliably round-tripped by the YAML emitter's
  // scalar-style heuristic, while a literal block scalar is emitted verbatim.
  run: [
    'set -euo pipefail',
    [
      'bash "$GITHUB_WORKSPACE/genie/ci-scripts/buck2-cache-lane.sh"',
      mode,
      ...args.map((arg) => shellSingleQuote(arg)),
    ].join(' '),
  ].join('\n'),
})

export const prepareCiScriptsStep = {
  name: 'Prepare CI helper scripts',
  shell: 'bash',
  run: withCiSourceRoot(
    [
      'set -euo pipefail',
      `scripts_src=${shellSingleQuote(defaultCiRuntimeScriptsDir)}`,
      `scripts_dst=${shellSingleQuote(preparedCiRuntimeScriptsDir)}`,
      'if [ ! -d "$scripts_src" ]; then',
      '  echo "::error::CI helper script directory is missing: $scripts_src"',
      '  exit 1',
      'fi',
      'rm -rf "$scripts_dst"',
      'mkdir -p "$scripts_dst"',
      'cp -R "$scripts_src/." "$scripts_dst/"',
      'rm -f "$scripts_dst"/*.genie.ts',
      'chmod +x "$scripts_dst"/*.sh',
    ].join('\n'),
  ),
} as const

/** Mint a GitHub App installation token for downstream private-repo fetches. */
export const githubAppInstallationTokenStep = (opts: {
  id: string
  appId: string
  privateKey: string
  owner: string
  repositories: readonly [string, ...string[]]
  name?: string
}) => ({
  id: opts.id,
  name: opts.name ?? `Mint ${opts.owner} GitHub App token`,
  uses: 'actions/create-github-app-token@v3' as const,
  with: {
    'app-id': opts.appId,
    'private-key': opts.privateKey,
    owner: opts.owner,
    repositories: opts.repositories.join(','),
  },
})

/**
 * Build shell env bindings for a GitHub token.
 *
 * Use this on later run steps when self-hosted wrappers or ad hoc git/nix
 * invocations must authenticate with the minted installation token.
 */
export const githubAccessTokenEnv = (tokenExpression: string) => ({
  GITHUB_TOKEN: tokenExpression,
  GH_TOKEN: tokenExpression,
})

/**
 * Attach a GitHub token env binding to an existing workflow step.
 *
 * This is the supported way to pass an installation token through later steps.
 * GitHub Actions does not allow overriding `GITHUB_*` variables via `$GITHUB_ENV`.
 */
export const withGitHubAccessTokenEnv = <
  TStep extends {
    env?: Record<string, string>
  },
>({
  step,
  tokenExpression,
}: {
  step: TStep
  tokenExpression: string
}): TStep => ({
  ...step,
  env: {
    ...step.env,
    ...githubAccessTokenEnv(tokenExpression),
  },
})

const withPrivateCachixReadAuthCommand = ({
  command,
  cacheHosts,
}: {
  command: string
  cacheHosts: readonly string[]
}) => {
  if (cacheHosts.length === 0) {
    return command
  }

  return [
    'if [ -z "${CACHIX_AUTH_TOKEN:-}" ]; then',
    '  echo "::error::CACHIX_AUTH_TOKEN is not set"',
    '  exit 1',
    'fi',
    'cachix_netrc="$(mktemp "${RUNNER_TEMP:-/tmp}/cachix-netrc.XXXXXX")"',
    'trap \'rm -f "$cachix_netrc"\' EXIT',
    'chmod 600 "$cachix_netrc"',
    `for host in ${cacheHosts.map(shellSingleQuote).join(' ')}; do`,
    `  printf 'machine %s\\npassword %s\\n' "$host" "$CACHIX_AUTH_TOKEN" >> "$cachix_netrc"`,
    'done',
    'if [ -n "${NIX_CONFIG:-}" ]; then',
    '  NIX_CONFIG_WITH_APPEND=$(printf \'%s\\n%s\' "$NIX_CONFIG" "netrc-file = $cachix_netrc")',
    'else',
    '  NIX_CONFIG_WITH_APPEND="netrc-file = $cachix_netrc"',
    'fi',
    'export NIX_CONFIG="$NIX_CONFIG_WITH_APPEND"',
    command,
  ].join('\n')
}

/**
 * Attach job-local Cachix read auth to a shell step.
 *
 * This keeps private cache pull auth local to the step instead of relying on
 * host-global netrc state owned by the runner image.
 */
export const withPrivateCachixReadAuth = <
  TStep extends {
    run: string
    env?: Record<string, string>
  },
>({
  step,
  ...opts
}: {
  step: TStep
  authTokenExpression: string
  binaryCaches: readonly NixBinaryCache[]
}): TStep => {
  const cacheHosts = cachixHostsFromBinaryCaches(opts.binaryCaches)
  if (cacheHosts.length === 0) {
    return step
  }

  return {
    ...step,
    env: {
      ...step.env,
      CACHIX_AUTH_TOKEN: opts.authTokenExpression,
    },
    run: withPrivateCachixReadAuthCommand({
      command: step.run,
      cacheHosts,
    }),
  }
}

/**
 * Append a GitHub access token line to NIX_CONFIG for later shell steps.
 *
 * This only updates `NIX_CONFIG`. Use `withGitHubAccessTokenEnv(...)` when the
 * same token also needs to be visible to self-hosted runner wrappers or other
 * tools that read `GITHUB_TOKEN` / `GH_TOKEN` from the step environment.
 */
export const appendGitHubAccessTokenToNixConfigStep = (opts: {
  tokenExpression: string
  name?: string
}) => ({
  name: opts.name ?? 'Export GitHub access token for Nix',
  shell: 'bash' as const,
  run: [
    `token=${shellSingleQuote(opts.tokenExpression)}`,
    'if [ -n "${NIX_CONFIG:-}" ]; then',
    '  printf "NIX_CONFIG<<EOF\\n%s\\naccess-tokens = github.com=%s\\nEOF\\n" "$NIX_CONFIG" "$token" >> "$GITHUB_ENV"',
    'else',
    '  printf "NIX_CONFIG<<EOF\\naccess-tokens = github.com=%s\\nEOF\\n" "$token" >> "$GITHUB_ENV"',
    'fi',
  ].join('\n'),
})

/** Node-24-safe major of the Determinate Nix installer action. */
export const defaultInstallNixActionRef = 'DeterminateSystems/determinate-nix-action@v3'

/**
 * Install Nix via DeterminateSystems/determinate-nix-action.
 * Includes shared binary caches and github.com access-tokens
 * by default. On self-hosted where Nix is pre-installed, this action is a no-op
 * and extra-conf is silently skipped — the runner's nix wrapper handles
 * access-tokens there by reading GITHUB_TOKEN from the environment.
 *
 * `actionRef` exists so credential-bearing jobs can pin the installer by commit
 * (`credentialBearingActionPins.determinateNix`) instead of a movable major tag.
 */
export const installNixStep = (opts?: {
  binaryCaches?: readonly NixBinaryCache[]
  extraConf?: string
  githubAccessTokenExpression?: string
  summarize?: boolean
  actionRef?: string
}) => ({
  name: 'Install Nix',
  uses: opts?.actionRef ?? defaultInstallNixActionRef,
  with: {
    'extra-conf': [
      /**
       * TODO: Remove explicit experimental-features override once upstream ca-derivations issues are resolved
       * @see https://github.com/NixOS/nix/issues/12361
       * @see https://github.com/cachix/devenv/issues/2364
       */
      'experimental-features = nix-command flakes',
      /** Trust flake-level nixConfig (e.g. additional repo-local substituters) */
      'accept-flake-config = true',
      nixBinaryCachesExtraConf(opts?.binaryCaches ?? []),
      `access-tokens = github.com=${opts?.githubAccessTokenExpression ?? '${{ github.token }}'}`,
      ...(opts?.extraConf !== undefined ? [opts.extraConf] : []),
    ].join('\n'),
    summarize: opts?.summarize ?? true,
  },
})

/**
 * Provide the cachix CLI to subsequent steps from a /nix/store output.
 *
 * Must run before `cachixStep` in the same job. cachix-action's
 * `which.sync('cachix', { nothrow: true })` short-circuit then skips its
 * built-in installer, so the binary stays a /nix/store path and the runner's
 * nix profile is never mutated.
 */
export const cachixCliBuildStep = {
  name: 'Provide cachix CLI from nixpkgs',
  shell: 'bash',
  run: [
    'set -euo pipefail',
    'out=$(nix build --no-link --print-out-paths nixpkgs#cachix)',
    'echo "$out/bin" >> "$GITHUB_PATH"',
  ].join('\n'),
} as const

/** Node-24-safe major of the Cachix action. */
export const defaultCachixActionRef = 'cachix/cachix-action@v17'

/**
 * Enable a Cachix binary cache. Requires `cachixCliBuildStep` earlier in the job.
 *
 * `actionRef` lets credential-bearing jobs pin the action by commit
 * (`credentialBearingActionPins.cachix`) instead of a movable major tag.
 */
export const cachixStep = (opts: { name: string; authToken?: string; actionRef?: string }) => ({
  name: 'Enable Cachix cache',
  uses: opts.actionRef ?? defaultCachixActionRef,
  with: {
    name: opts.name,
    ...(opts.authToken !== undefined ? { authToken: opts.authToken } : {}),
  },
})

/**
 * Prepare lock-pinned devenv metadata from devenv.lock.
 */
export const preparePinnedDevenvStepFor = (lockFile = 'devenv.lock') =>
  ({
    name: 'Use pinned devenv from lock',
    run: withCiSourceRoot(`${resolveDevenvRevScriptFor(lockFile)}
echo "DEVENV_REV=$DEVENV_REV" >> "$GITHUB_ENV"
echo "Pinned devenv rev: $DEVENV_REV"`),
    shell: 'bash',
  }) as const

export const preparePinnedDevenvStep = preparePinnedDevenvStepFor()

/**
 * Export the canonical CI pnpm paths once so every later shell step shares the
 * same job-local home and content store. Writable virtual topology stays under
 * the workspace root.
 */
export const pnpmStateSetupStep = {
  name: 'Isolate pnpm state',
  shell: 'bash',
  run: withCiSourceRoot(
    [
      'set -euo pipefail',
      `mkdir -p "${ciPnpmStore}" "${ciPnpmHome}" .devenv`,
      'member_store=.devenv/pnpm-store-pure-v1',
      'if [ -L "$member_store" ]; then',
      `  if [ "$(readlink "$member_store")" != "${ciPnpmStore}" ]; then`,
      '    echo "::error::owned member pnpm store symlink has the wrong target: $member_store" >&2',
      '    exit 1',
      '  fi',
      'elif [ -e "$member_store" ]; then',
      '  echo "::error::refusing non-symlink owned member pnpm store path: $member_store" >&2',
      '  exit 1',
      'else',
      `  ln -s "${ciPnpmStore}" "$member_store"`,
      'fi',
      `echo "PNPM_STORE_DIR=${ciPnpmStore}" >> "$GITHUB_ENV"`,
      `echo "PNPM_CONFIG_STORE_DIR=${ciPnpmStore}" >> "$GITHUB_ENV"`,
      `echo "PNPM_HOME=${ciPnpmHome}" >> "$GITHUB_ENV"`,
    ].join('\n'),
  ),
} as const

/**
 * Export the canonical workspace-local Nix cache root so later steps share the
 * same mutable client cache surface across one CI job.
 */
export const nixCacheSetupStep = {
  name: 'Isolate nix cache',
  shell: 'bash',
  run: [
    `mkdir -p "${ciNixCachePath}"`,
    `echo "XDG_CACHE_HOME=${ciNixCacheRoot}" >> "$GITHUB_ENV"`,
  ].join('\n'),
} as const

/**
 * Export the job-local CI diagnostics directory once so later steps can
 * collect runner pressure snapshots and install logs in one place.
 */
export const ciDiagnosticsSetupStep = {
  name: 'Prepare CI diagnostics',
  shell: 'bash',
  run: `mkdir -p "${jobLocalCiDiagnosticsDir}"
echo "CI_DIAGNOSTICS_DIR=${jobLocalCiDiagnosticsDir}" >> "$GITHUB_ENV"`,
} as const

const runnerPressureSnapshotScript = [
  'set -euo pipefail',
  'mkdir -p "$CI_DIAGNOSTICS_DIR"',
  'pressure_file="$CI_DIAGNOSTICS_DIR/runner-pressure.txt"',
  '{',
  '  echo "timestamp_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"',
  '  echo "runner_name=${RUNNER_NAME:-unknown}"',
  '  echo "runner_os=${RUNNER_OS:-unknown}"',
  '  echo "runner_arch=${RUNNER_ARCH:-unknown}"',
  '  echo "github_job=${GITHUB_JOB:-unknown}"',
  '  echo',
  '  uptime',
  '  echo',
  '  if command -v free >/dev/null 2>&1; then',
  '    free -h',
  '  elif [ -r /proc/meminfo ]; then',
  '    cat /proc/meminfo',
  '  elif command -v vm_stat >/dev/null 2>&1; then',
  '    vm_stat',
  '    if command -v memory_pressure >/dev/null 2>&1; then',
  '      echo',
  '      memory_pressure || true',
  '    fi',
  '  else',
  '    echo "memory stats unavailable on runner"',
  '  fi',
  '  echo',
  '  if [ -r /proc/pressure/memory ]; then',
  '    cat /proc/pressure/memory',
  '  fi',
  '  echo',
  '  df -h /',
  '  echo',
  '  if command -v ps >/dev/null 2>&1; then',
  '    if ps -eo pid,ppid,user,%cpu,%mem,etime,stat,comm --sort=-%cpu >/dev/null 2>&1; then',
  '      ps -eo pid,ppid,user,%cpu,%mem,etime,stat,comm --sort=-%cpu | head -15',
  '    else',
  '      ps -axo pid,ppid,user,%cpu,%mem,etime,stat,comm -r | head -15',
  '    fi',
  '  else',
  '    echo "ps unavailable on runner"',
  '  fi',
  '} | tee "$pressure_file"',
  'if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then',
  '  {',
  '    echo "### Runner pressure"',
  '    echo ""',
  '    echo "```text"',
  '    tail -20 "$pressure_file"',
  '    echo "```"',
  '  } >> "$GITHUB_STEP_SUMMARY"',
  'fi',
].join('\n')

/**
 * Capture a quick runner pressure snapshot before the install starts.
 *
 * This does not fail the job. It gives the later failure summary and artifact
 * enough context to tell whether pnpm timed out under host pressure.
 */
export const captureRunnerPressureStep = {
  name: 'Capture runner pressure',
  shell: 'bash',
  run: runnerPressureSnapshotScript,
} as const

const pnpmInstallFailureSummaryScript = [
  'classify_pnpm_failure() {',
  '  local log_file="$1"',
  '  local signature="unknown"',
  '  local evidence=""',
  '  if grep -Eq "ERR_PNPM_META_FETCH_FAIL|ERR_PNPM_FETCH_FAIL|Socket timeout|ECONNRESET|EAI_AGAIN" "$log_file"; then',
  '    signature="registry/network fetch"',
  '    evidence="$(grep -Em1 \x27ERR_PNPM_META_FETCH_FAIL|ERR_PNPM_FETCH_FAIL|Socket timeout|ECONNRESET|EAI_AGAIN\x27 "$log_file" || true)"',
  '  elif grep -Eq "ERR_PNPM_WORKSPACE_PKG_NOT_FOUND" "$log_file"; then',
  '    signature="workspace package mismatch"',
  '    evidence="$(grep -Em1 \x27ERR_PNPM_WORKSPACE_PKG_NOT_FOUND\x27 "$log_file" || true)"',
  '  fi',
  '  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then',
  '    {',
  '      echo "### pnpm install failed"',
  '      echo ""',
  '      echo "- Classification: $signature"',
  '      echo "- Evidence: \\`$evidence\\`"',
  '      echo "- Log artifact: \\`$CI_DIAGNOSTICS_DIR/pnpm-install.log\\`"',
  '      echo ""',
  '      echo "```text"',
  '      tail -80 "$log_file"',
  '      echo "```"',
  '    } >> "$GITHUB_STEP_SUMMARY"',
  '  fi',
  '  echo "::warning::pnpm install failed ($signature); see $CI_DIAGNOSTICS_DIR/pnpm-install.log"',
  '}',
].join('\n')

/**
 * Run the repo-root pnpm install while teeing the full log to the diagnostics
 * directory and summarizing failures in the job output.
 */
export const pnpmInstallWithDiagnosticsStep = () =>
  ({
    name: 'Install pnpm dependencies',
    shell: 'bash',
    run: [
      'set -euo pipefail',
      'mkdir -p "$CI_DIAGNOSTICS_DIR"',
      'log_file="$CI_DIAGNOSTICS_DIR/pnpm-install.log"',
      'set +e',
      '(',
      runDevenvTasksBefore('pnpm:install'),
      ') 2>&1 | tee "$log_file"',
      'rc=${PIPESTATUS[0]}',
      'set -e',
      'if [ "$rc" -ne 0 ]; then',
      pnpmInstallFailureSummaryScript,
      '  classify_pnpm_failure "$log_file"',
      'fi',
      'exit "$rc"',
    ].join('\n'),
  }) as const

const nixCachePrimaryKey = ({
  keyPrefix,
  hashFilesExpression,
}: {
  keyPrefix: string
  hashFilesExpression: string
}) => `${keyPrefix}-${'${{ runner.os }}'}-${'${{ runner.arch }}'}-${hashFilesExpression}`

/**
 * Restore the shared workspace-local Nix cache before expensive eval/build work.
 *
 * The default cache authority keys off the lockfiles that affect Nix inputs and
 * repo composition. Consumers can override the key prefix or hash expression
 * when a narrower surface is more appropriate.
 */
export const restoreNixCacheStep = (opts?: {
  keyPrefix?: string
  stepId?: string
  path?: string
  hashFilesExpression?: string
}) => {
  const keyPrefix = opts?.keyPrefix ?? 'nix-cache-v1'
  const path = opts?.path ?? ciNixCachePath
  const hashFilesExpression =
    opts?.hashFilesExpression ?? "${{ hashFiles('devenv.lock', 'flake.lock', 'megarepo.lock') }}"

  return {
    id: opts?.stepId ?? 'restore-nix-cache',
    name: 'Restore nix cache',
    uses: 'actions/cache/restore@v4' as const,
    with: {
      path,
      key: nixCachePrimaryKey({ keyPrefix, hashFilesExpression }),
      'restore-keys': `${keyPrefix}-${'${{ runner.os }}'}-${'${{ runner.arch }}'}-`,
    },
  }
}

/**
 * Save the shared workspace-local Nix cache after the main task graph runs.
 *
 * Reuses the primary key emitted by the restore step so the save path stays
 * aligned with the exact cache authority evaluated earlier in the job.
 */
export const saveNixCacheStep = (opts?: { restoreStepId?: string; path?: string }) => {
  const restoreStepId = opts?.restoreStepId ?? 'restore-nix-cache'
  const path = opts?.path ?? ciNixCachePath

  return {
    name: 'Save nix cache',
    if: `\${{ always() && steps.${restoreStepId}.outputs.cache-primary-key != '' }}`,
    uses: 'actions/cache/save@v4' as const,
    with: {
      path,
      key: `\${{ steps.${restoreStepId}.outputs.cache-primary-key }}`,
    },
  }
}

/**
 * Shared pnpm-state cache contract version.
 *
 * Composed into every pnpm-state key as `${keyPrefix}-${version}-...`, so one
 * bump here flips the cold-rebuild for the whole stack at once while each repo
 * keeps its own `keyPrefix` namespace (e.g. `livestore-pnpm-state`). Bumping
 * forces a one-time cold rebuild for every consumer, so treat a change as a
 * coordinated stack-wide event.
 */
export const pnpmStateCacheVersion = 'v3'

/** Default pnpm-state key namespace when a repo does not set its own. */
export const defaultPnpmStateKeyPrefix = 'pnpm-state'

const defaultPnpmStateHashFilesExpression = "${{ hashFiles('**/pnpm-lock.yaml') }}"

const pnpmStateCachePrimaryKey = (args: { keyPrefix: string; hashFilesExpression: string }) =>
  `${args.keyPrefix}-${pnpmStateCacheVersion}-${'${{ runner.os }}'}-${'${{ runner.arch }}'}-${args.hashFilesExpression}`

/**
 * Restore the workspace-local pnpm state snapshot before any install work runs.
 *
 * Live pnpm state must use exact-key semantics. Prefix fallback restore keys
 * are not part of the supported contract for mutable pnpm state because they
 * blur the authority boundary between the current lockfile graph and older
 * warmed state.
 *
 * Order this AFTER checkout: the workspace-relative store (`.devenv/pnpm-store-pure-v1` /
 * `.pnpm-home`) is gitignored, so a restore placed before checkout would be
 * wiped by checkout's clean.
 */
export const restorePnpmStateStep = (opts?: {
  keyPrefix?: string
  hashFilesExpression?: string
  stepId?: string
  path?: string
}) => {
  const keyPrefix = opts?.keyPrefix ?? defaultPnpmStateKeyPrefix
  const hashFilesExpression = opts?.hashFilesExpression ?? defaultPnpmStateHashFilesExpression
  const path = opts?.path ?? ciPnpmStatePaths

  return {
    id: opts?.stepId ?? 'restore-pnpm-state',
    name: 'Restore pnpm state',
    uses: 'actions/cache/restore@v4' as const,
    with: {
      path,
      // The fetched state contents are platform-specific, so the cache must
      // isolate both OS and CPU architecture to avoid cross-platform corruption.
      key: pnpmStateCachePrimaryKey({ keyPrefix, hashFilesExpression }),
    },
  }
}

/**
 * Save the job-local pnpm state after the main task graph runs.
 *
 * Save only after prior steps succeeded. This avoids publishing partial or
 * corrupt live state after a failed dependency preparation step.
 */
export const savePnpmStateStep = (opts?: {
  keyPrefix?: string
  hashFilesExpression?: string
  restoreStepId?: string
  path?: string
}) => {
  const keyPrefix = opts?.keyPrefix ?? defaultPnpmStateKeyPrefix
  const hashFilesExpression = opts?.hashFilesExpression ?? defaultPnpmStateHashFilesExpression
  const restoreStepId = opts?.restoreStepId ?? 'restore-pnpm-state'
  const path = opts?.path ?? ciPnpmStatePaths

  return {
    name: 'Save pnpm state',
    if: `\${{ success() && steps.${restoreStepId}.outputs.cache-hit != 'true' }}`,
    uses: 'actions/cache/save@v4' as const,
    with: {
      path,
      // Reuse the same primary key expression as restore. GitHub Actions does
      // not allow nesting `${{ ... }}` inside a fallback string of another
      // expression, so deriving the key once in TypeScript keeps the emitted
      // workflow expression valid.
      key: pnpmStateCachePrimaryKey({ keyPrefix, hashFilesExpression }),
    },
  }
}

/**
 * pnpm-state publisher post-steps for a repo's own hand-rolled `job()` factory.
 *
 * Returns the save step only when this job is the designated publisher, else
 * `[]`, so a local factory can gate its single save call by spreading:
 *
 *   steps: [...baseSteps, step, ...pnpmStatePublisherPostSteps({ publish })]
 *
 * pnpm state uses exact-key, single-writer semantics: exactly one job per
 * `(os, arch, lockfile)` key should publish; every other job restores only.
 * Defaults to `publish: false` so a repo must name its publisher — forgetting
 * degrades to cold installs (slower CI), never to the concurrent multi-writer
 * saves that exhaust self-hosted runner disk. Matrix / multi-lockfile-graph
 * repos may publish from several jobs (one per closure).
 */
export const pnpmStatePublisherPostSteps = (opts?: {
  publish?: boolean
  save?: Parameters<typeof savePnpmStateStep>[0]
}): readonly ReturnType<typeof savePnpmStateStep>[] =>
  opts?.publish === true ? [savePnpmStateStep(opts?.save)] : []

/**
 * Shared self-hosted CI setup for repos that prepare a devenv workspace,
 * restore warmed mutable state, and run `pnpm:install` before the main task.
 *
 * This composes the existing step atoms into one standard contract so
 * downstream repos can delete local workflow glue instead of reassembling the
 * same Nix/pnpm/diagnostics sequence by hand.
 */
export const standardSelfHostedPnpmCiPrepSteps = (opts?: {
  checkout?: Parameters<typeof checkoutStep>[0]
  installNix?: Parameters<typeof installNixStep>[0]
  restoreNixCache?: Parameters<typeof restoreNixCacheStep>[0]
  applyMegarepoLock?: false | Parameters<typeof applyMegarepoLockStep>[0]
  restorePnpmState?: Parameters<typeof restorePnpmStateStep>[0]
  includeDiagnostics?: boolean
}) =>
  [
    checkoutStep(opts?.checkout),
    installNixStep(opts?.installNix),
    prepareCiScriptsStep,
    preparePinnedDevenvStep,
    nixCacheSetupStep,
    restoreNixCacheStep(opts?.restoreNixCache),
    validateNixStoreStep,
    ...(opts?.applyMegarepoLock === false ? [] : [applyMegarepoLockStep(opts?.applyMegarepoLock)]),
    pnpmStateSetupStep,
    ciDiagnosticsSetupStep,
    ...(opts?.includeDiagnostics === false ? [] : [captureRunnerPressureStep]),
    restorePnpmStateStep(opts?.restorePnpmState),
    pnpmInstallWithDiagnosticsStep(),
  ] as const

/**
 * Shared self-hosted CI tail for repos that save warmed mutable state and keep
 * pnpm / runner diagnostics attached to the finished job.
 */
export const standardSelfHostedPnpmCiPostSteps = (opts?: {
  /**
   * Designate this job as a pnpm-state publisher. Delegates to
   * `pnpmStatePublisherPostSteps`; defaults to `false` (restore-only). This
   * only reaches repos that compose their job via this shared helper — repos
   * with a hand-rolled `job()` factory must call `pnpmStatePublisherPostSteps`
   * (or `withSinglePnpmStatePublisher`) directly.
   */
  savePnpmState?: boolean
  savePnpmStateOptions?: Parameters<typeof savePnpmStateStep>[0]
  saveNixCache?: Parameters<typeof saveNixCacheStep>[0]
  includeDiagnosticsArtifact?: boolean
}) =>
  [
    ...pnpmStatePublisherPostSteps({
      publish: opts?.savePnpmState,
      save: opts?.savePnpmStateOptions,
    }),
    saveNixCacheStep(opts?.saveNixCache),
    ...(opts?.includeDiagnosticsArtifact === false ? [] : [ciDiagnosticsArtifactStep()]),
  ] as const

export const devenvTaskStep = (name: string, ...args: [string, ...string[]]) => ({
  name,
  run: runDevenvTasksBefore(...args),
})

export type StandardSelfHostedDevenvTaskJobOptions = Omit<
  WorkflowJob,
  'runs-on' | 'defaults' | 'env' | 'steps'
> & {
  readonly runsOn?: string | readonly string[]
  readonly defaults?: WorkflowJob['defaults']
  readonly env?: Record<string, string>
  readonly prepSteps?: readonly WorkflowStep[]
  readonly postSteps?: readonly WorkflowStep[]
  readonly prep?: Parameters<typeof standardSelfHostedPnpmCiPrepSteps>[0]
  readonly post?: Parameters<typeof standardSelfHostedPnpmCiPostSteps>[0]
  readonly step: WorkflowStep
}

export const standardSelfHostedDevenvTaskJob = ({
  runsOn = linuxX64Runner,
  defaults = bashShellDefaults,
  env = standardCIEnv,
  prepSteps,
  postSteps,
  prep,
  post,
  step,
  ...jobOptions
}: StandardSelfHostedDevenvTaskJobOptions): WorkflowJob => ({
  'runs-on': Array.isArray(runsOn) === true ? [...runsOn] : runsOn,
  defaults,
  env,
  steps: [
    ...(prepSteps ?? standardSelfHostedPnpmCiPrepSteps(prep)),
    step,
    ...(postSteps ?? standardSelfHostedPnpmCiPostSteps(post)),
  ],
  ...jobOptions,
})

/**
 * Stamp EXACTLY ONE job in a workflow job map as the pnpm-state publisher.
 *
 * Appends the save step to the named publisher and leaves every other job
 * restore-only, centralizing the single-writer invariant so a repo declares its
 * publisher once and cannot save on many jobs or none. Throws if the named job
 * is absent, or if any job already saves pnpm state (so this helper is the sole
 * authority). Repos whose jobs share one closure use this; matrix repos needing
 * several publishers spread `pnpmStatePublisherPostSteps` per job instead.
 */
export const withSinglePnpmStatePublisher = <
  TJobs extends Record<string, { steps: readonly WorkflowStep[] }>,
>({
  jobs,
  publisher,
  save,
}: {
  jobs: TJobs
  publisher: keyof TJobs & string
  save?: Parameters<typeof savePnpmStateStep>[0]
}): TJobs => {
  const publisherJob = jobs[publisher]
  if (publisherJob === undefined) {
    throw new Error(
      `withSinglePnpmStatePublisher: publisher job '${publisher}' is not in the job map`,
    )
  }
  for (const [name, job] of Object.entries(jobs)) {
    if (job.steps.some((step) => (step as { name?: string }).name === 'Save pnpm state') === true) {
      throw new Error(
        `withSinglePnpmStatePublisher: job '${name}' already saves pnpm state; remove per-job saves so exactly one publisher writes`,
      )
    }
  }
  return {
    ...jobs,
    [publisher]: { ...publisherJob, steps: [...publisherJob.steps, savePnpmStateStep(save)] },
  } as TJobs
}

/**
 * Upload CI diagnostics captured during the pnpm install / runner-pressure
 * steps as a single artifact on failure.
 */
export const ciDiagnosticsArtifactStep = (opts?: { if?: string; retentionDays?: number }) => ({
  name: 'Upload CI diagnostics artifact',
  if: opts?.if ?? "failure() && env.CI_DIAGNOSTICS_DIR != ''",
  uses: 'actions/upload-artifact@v4' as const,
  with: {
    name: 'ci-diagnostics-${{ github.job }}-${{ runner.os }}-run-${{ github.run_id }}-attempt-${{ github.run_attempt }}',
    path: '${{ env.CI_DIAGNOSTICS_DIR }}',
    'if-no-files-found': 'ignore',
    'retention-days': opts?.retentionDays ?? 14,
  },
})

/**
 * Validate exported pnpm fixed-output derivations by realizing them (which
 * may substitute from Cachix), then evicting the output and rebuilding from
 * scratch.
 *
 * FOD output paths are deterministic from the declared hash. If Cachix has a
 * previously-valid output (uploaded when the hash was correct), Nix substitutes
 * it without rebuilding — even if the hash is now stale. `--rebuild` also
 * must avoid shared-daemon-store heuristics. On CI runners, `nix store delete`
 * may succeed while the out path still appears valid due to lingering roots or
 * daemon-managed store state, which makes path-visibility checks flaky.
 *
 * The fix: realize once, then use `nix build --rebuild`. Nix rebuilds the FOD
 * and compares the result to the trusted store path directly. If the declared
 * hash is stale, the rebuild/check fails with the underlying hash mismatch.
 */
export const validateColdPnpmDepsStep = ({
  flakeRefs,
  name = 'Cold pnpm deps validation',
  substituters,
}: {
  flakeRefs: readonly [string, ...string[]]
  name?: string
  substituters?: readonly string[]
}) => ({
  name,
  shell: 'bash',
  run: (() => {
    const substituterArgs =
      substituters === undefined || substituters.length === 0
        ? ''
        : ` --option substituters ${shellSingleQuote(substituters.join(' '))}`

    const command = [
      'set -euo pipefail',
      `for attr in ${flakeRefs.map(shellSingleQuote).join(' ')}; do`,
      '  echo "::group::rebuild-check $attr"',
      '  # Step 1: Realize once (may substitute) so rebuild has a trusted output to compare against.',
      `  nix build --no-link "$attr"${substituterArgs}`,
      '  # Step 2: Rebuild and compare locally. This fails on stale fixed-output hashes without',
      '  # relying on whether a shared daemon store made the prior out path disappear.',
      `  nix build --no-link --rebuild "$attr"${substituterArgs}`,
      '  echo "::endgroup::"',
      'done',
    ].join('\n')

    return withCiSourceRoot(withGcRaceRetry({ command, label: name }))
  })(),
})

/** Evict any cached pnpm-deps outputs below a flake target and rebuild it against cache.nixos.org only. */
export const coldFreshNixBuildStep = ({
  flakeRef,
  name = 'Cold fresh Nix build',
  extraArgs = [],
}: {
  flakeRef: string
  name?: string
  extraArgs?: readonly string[]
}) => ({
  name,
  shell: 'bash',
  run: withCiSourceRoot(
    [
      'set -euo pipefail',
      ...withEachPnpmDepsDrvShellLines({
        flakeRef,
        bodyLines: [
          '    installable="${drv}^*"',
          '    echo "cold-building pnpm deps: ${attrName:-$drv}"',
          '    nix build --no-link "$installable" --option substituters "https://cache.nixos.org" || true',
          '    while IFS= read -r outPath; do',
          '      [ -n "$outPath" ] || continue',
          ...evictOutPathShellLines,
          '    done < <(nix path-info "$installable" 2>/dev/null || true)',
          '    nix build --no-link "$installable" --option substituters "https://cache.nixos.org"',
        ],
      }),
      `nix build --no-link ${shellSingleQuote(flakeRef)}${extraArgs.length === 0 ? '' : ` ${extraArgs.map(shellSingleQuote).join(' ')}`} --option substituters "https://cache.nixos.org"`,
    ].join('\n'),
  ),
})

/**
 * Guard the pnpm dependency-prep contract against regressions that would
 * silently reintroduce package-manager self-bootstrap or implicit lockfile
 * normalization inside fixed-output builds.
 */
export const pnpmBuilderContractStep = ({
  builderFile = 'nix/workspace-tools/lib/mk-pnpm-deps.nix',
  policyFile = 'nix/workspace-tools/lib/pnpm-install-policy.nix',
  name = 'Guard pnpm builder contract',
}: {
  builderFile?: string
  policyFile?: string
  name?: string
}) => ({
  name,
  shell: 'bash',
  run: withCiSourceRoot(
    [
      'set -euo pipefail',
      `builder=${shellSingleQuote(builderFile)}`,
      `policy=${shellSingleQuote(policyFile)}`,
      'if [ ! -f "$builder" ]; then',
      '  echo "::error::missing pnpm deps builder: $builder"',
      '  exit 1',
      'fi',
      'if [ ! -f "$policy" ]; then',
      '  echo "::error::missing pnpm install policy: $policy"',
      '  exit 1',
      'fi',
      'for required in \\',
      "  'store-dir=%s' \\",
      "  'frozenLockfile ? true' \\",
      "  'pnpm install --frozen-lockfile --ignore-scripts'; do",
      '  if ! grep -Fq -- "$required" "$builder"; then',
      '    echo "::error::missing required pnpm builder contract fragment: $required"',
      '    exit 1',
      '  fi',
      'done',
      'for required in \\',
      "  'side-effects-cache=false' \\",
      "  'verify-store-integrity=true' \\",
      "  'package-import-method=${packageImportMethod}' \\",
      "  'pm-on-fail=ignore' \\",
      "  'strict-store-pkg-content-check=true' \\",
      "  'child-concurrency=1' \\",
      "  'network-concurrency=4'; do",
      '  if ! grep -Fq -- "$required" "$policy"; then',
      '    echo "::error::missing required pnpm policy contract fragment: $required"',
      '    exit 1',
      '  fi',
      'done',
      'for forbidden in \\',
      "  'package-import-method=hardlink' \\",
      "  'lockfile-only' \\",
      "  'pnpm add pnpm@'; do",
      '  if grep -Fq -- "$forbidden" "$builder" "$policy"; then',
      '    echo "::error::forbidden pnpm builder contract fragment present: $forbidden"',
      '    exit 1',
      '  fi',
      'done',
    ].join('\n'),
  ),
})

/**
 * Resolve the devenv binary and do a fast store-path validity check.
 *
 * Previously ran `devenv info` (~25s) as an eager canary to detect any store
 * corruption before tasks run. Now uses `nix-store --check-validity` (~1-2s)
 * which only verifies the devenv store path itself. If the store path is
 * invalid, runs a targeted repair on just that path and re-resolves.
 *
 * Still captures diagnostics dir + runner fingerprint for #272 instrumentation.
 *
 * @see https://github.com/namespacelabs/nscloud-setup/issues/8
 * @see https://github.com/overengineeringstudio/effect-utils/issues/272
 */
export const validateNixStoreStepFor = (lockFile = 'devenv.lock') =>
  ({
    name: 'Resolve devenv',
    // Routed through the shared retry wrapper: resolving devenv is the first step that
    // evaluates flake inputs, so it is where a transient store/input-cache failure lands
    // (`path '/nix/store/...' is not valid`, a truncated input tarball, an incompletely
    // cached flake input). Its own in-script repair covers only the devenv store path, so
    // without the wrapper any other transient signature fails the job outright.
    run: withGcRaceRetry({
      command: withCiSourceRoot(
        `${shellSingleQuote(`${preparedCiRuntimeScriptsDir}/resolve-devenv.sh`)} ${shellSingleQuote(lockFile)}`,
      ),
      label: `resolve devenv (${lockFile})`,
    }),
    shell: 'bash',
  }) as const

export const validateNixStoreStep = validateNixStoreStepFor()

/**
 * Upload diagnostics captured by `validateNixStoreStep` as a CI artifact.
 * Add this step after validation/task steps so failure-path data is retained.
 */
export const nixDiagnosticsArtifactStep = (opts?: { if?: string; retentionDays?: number }) => ({
  name: 'Upload Nix diagnostics artifact',
  if: opts?.if ?? "failure() && env.NIX_STORE_DIAGNOSTICS_DIR != ''",
  uses: 'actions/upload-artifact@v4' as const,
  with: {
    name: 'nix-store-diagnostics-${{ github.job }}-${{ runner.os }}-run-${{ github.run_id }}-attempt-${{ github.run_attempt }}',
    path: '${{ env.NIX_STORE_DIAGNOSTICS_DIR }}',
    'if-no-files-found': 'ignore',
    'retention-days': opts?.retentionDays ?? 14,
  },
})
