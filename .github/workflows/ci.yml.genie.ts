import {
  RUNNER_PROFILES,
  type RunnerProfile,
  bashShellDefaults,
  cachixCliBuildStep,
  cachixStep,
  checkoutStep,
  cleanupEffectUtilsCompositionStep,
  prepareCiScriptsStep,
  prepareEffectUtilsCompositionStep,
  notifyAlignmentJob,
  evictCachedPnpmDepsStep,
  pnpmBuilderContractStep,
  preparePinnedDevenvStep,
  installNixStep,
  runDevenvTasksBefore,
  standardCIEnv,
  ciWorkflow,
  ciMeasurementBaselineCheckoutStep,
  ciMeasurementBaselineWorkflowDispatchInputs,
  ciMeasurementNotBaselineBackfillPredicate,
  ciMeasurementSubjectEnv,
  ciMeasurementsArtifactStep,
  compareCiMeasurementsStep,
  defaultNixClosureMeasurementBuckets,
  devenvPerfJob,
  downloadPreviousGitHubArtifactStep,
  namespaceLinuxX64PairedPerfRunner,
  namespaceRunner,
  nixClosureMeasurementSteps,
  sourceShapeMeasurementStep,
  validateColdPnpmDepsStep,
  nixDiagnosticsArtifactStep,
  workflowReportCommentBodyStep,
  workflowReportCollectorStep,
  workflowReportPublisherStep,
  deployPreviewWorkflowReportPathOutputName,
  netlifyDeployStep,
  nixCacheSetupStep,
  validateNixStoreStep,
  withCiSourceRoot,
  defaultRefPolicyCheckJob,
} from '../../genie/ci-workflow.ts'
import { type CoreCIJobName } from '../../genie/ci.ts'
import { type GitHubWorkflowArgs } from '../../packages/@overeng/genie/src/runtime/mod.ts'

const workflowReportFlakeRef =
  "github:${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name || github.repository }}/${{ github.event_name == 'pull_request' && github.head_ref || github.ref_name }}#ci-tools"

const trustedCachixStep = {
  ...cachixStep({
    name: 'overeng-effect-utils',
    authToken: '${{ secrets.CACHIX_AUTH_TOKEN }}',
  }),
  if: "github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')",
} as const

const baseSteps = [
  checkoutStep(),
  installNixStep(),
  ciMeasurementBaselineCheckoutStep,
  prepareEffectUtilsCompositionStep,
  cachixCliBuildStep,
  trustedCachixStep,
  prepareCiScriptsStep,
  preparePinnedDevenvStep,
  validateNixStoreStep,
  evictCachedPnpmDepsStep({
    flakeRef: '.#oxlint-npm',
    name: 'Evict cached pnpm deps for oxlint-npm',
  }),
  /**
   * Temporary debug switch for #272 to validate failure-path diagnostics without waiting for a real flake.
   * Remove once #201/#272 are root-caused and diagnostics instrumentation is removed.
   */
  {
    name: 'Force diagnostics failure (debug)',
    if: "${{ github.event_name == 'workflow_dispatch' && (inputs.debug_force_nix_diagnostics_failure == true || inputs.debug_force_nix_diagnostics_failure == 'true') }}",
    shell: 'bash',
    run: [
      'diag_dir="${NIX_STORE_DIAGNOSTICS_DIR:-${RUNNER_TEMP:-/tmp}/composition-state/nix-store-diagnostics-missing}"',
      'mkdir -p "$diag_dir"',
      'cat > "$diag_dir/synthetic-signature.log" <<\'EOF\'',
      'Failed to convert config.cachix to JSON',
      '... while evaluating the option `cachix.package`',
      "error: path '/nix/store/synthetic-invalid-path' is not valid",
      'EOF',
      'echo "::warning::Intentional failure for diagnostics validation (#272)"',
      'exit 1',
    ].join('\n'),
  },
] as const

const failureReminderStep = {
  name: 'Failure note',
  if: 'failure()',
  shell: 'bash',
  run: [
    'echo "If this looks like Namespace runner Nix store corruption (e.g. \\"... is not valid\\", \\"config.cachix\\", \\"cachix.package\\"), add the run link + full nix-store output to:"',
    'echo "  https://github.com/overengineeringstudio/effect-utils/issues/201"',
  ].join('\n'),
} as const

const liveNetlifyCiToolsPreflightStep = {
  id: 'live-netlify-preflight',
  name: 'Check live Netlify ci-tools E2E secrets',
  shell: 'bash',
  env: {
    NETLIFY_AUTH_TOKEN: '${{ secrets.NETLIFY_AUTH_TOKEN }}',
    NETLIFY_SITE_ID: '${{ secrets.NETLIFY_SITE_ID }}',
  },
  run: [
    'if [ -z "${NETLIFY_AUTH_TOKEN:-}" ] || [ -z "${NETLIFY_SITE_ID:-}" ]; then',
    '  echo "::notice::Skipping live Netlify ci-tools E2E because NETLIFY_AUTH_TOKEN or NETLIFY_SITE_ID is unavailable"',
    '  echo "run=false" >> "$GITHUB_OUTPUT"',
    '  exit 0',
    'fi',
    'echo "run=true" >> "$GITHUB_OUTPUT"',
  ].join('\n'),
} as const

const liveNetlifyCiToolsIf = "steps.live-netlify-preflight.outputs.run == 'true'"

const andLiveNetlifyCiToolsIf = (condition: string) => {
  const trimmed = condition.trim()
  const unwrapped =
    trimmed.startsWith('${{') === true && trimmed.endsWith('}}') === true
      ? trimmed.slice(3, -2).trim()
      : trimmed
  return `${unwrapped} && ${liveNetlifyCiToolsIf}`
}

const onlyWhenLiveNetlifyCiTools = <Step extends Record<string, unknown>>(step: Step) => ({
  ...step,
  if:
    typeof step.if === 'string' && step.if.length > 0
      ? andLiveNetlifyCiToolsIf(step.if)
      : liveNetlifyCiToolsIf,
})

const liveNetlifyCiToolsE2EStep = {
  name: 'Live Netlify ci-tools E2E',
  shell: 'bash',
  env: {
    CI_TOOLS_NETLIFY_LIVE: '1',
    NETLIFY_AUTH_TOKEN: '${{ secrets.NETLIFY_AUTH_TOKEN }}',
    NETLIFY_SITE_ID: '${{ secrets.NETLIFY_SITE_ID }}',
  },
  run: withCiSourceRoot(
    [
      'netlify_pkg="$(nix build --no-link --print-out-paths .#netlify-cli)"',
      'export CI_TOOLS_LIVE_NETLIFY_BIN="$netlify_pkg/bin/netlify"',
      'DEVENV_TASK_PASSTHROUGH=1 DEVENV_TUI=false "${DEVENV_BIN:?DEVENV_BIN not set}" tasks run buck2:editor:publish',
      'DEVENV_TUI=false "${DEVENV_BIN:?DEVENV_BIN not set}" shell --no-reload -- bun test packages/@overeng/ci-tools/src/deploy-netlify.live.e2e.test.ts',
    ].join('\n'),
  ),
} as const

const liveVercelCiToolsPreflightStep = {
  id: 'live-vercel-preflight',
  name: 'Check live Vercel ci-tools E2E secrets',
  shell: 'bash',
  env: {
    VERCEL_TOKEN: '${{ secrets.VERCEL_TOKEN }}',
    VERCEL_PROJECT_ID: '${{ secrets.VERCEL_PROJECT_ID }}',
    VERCEL_ORG_ID: '${{ secrets.VERCEL_ORG_ID }}',
    VERCEL_SCOPE: '${{ secrets.VERCEL_SCOPE }}',
  },
  run: [
    'if [ -z "${VERCEL_TOKEN:-}" ] || [ -z "${VERCEL_PROJECT_ID:-}" ] || [ -z "${VERCEL_ORG_ID:-}" ] || [ -z "${VERCEL_SCOPE:-}" ]; then',
    '  echo "::notice::Skipping live Vercel ci-tools E2E because VERCEL_TOKEN, VERCEL_PROJECT_ID, VERCEL_ORG_ID, or VERCEL_SCOPE is unavailable"',
    '  echo "run=false" >> "$GITHUB_OUTPUT"',
    '  exit 0',
    'fi',
    'echo "run=true" >> "$GITHUB_OUTPUT"',
  ].join('\n'),
} as const

const liveVercelCiToolsIf = "steps.live-vercel-preflight.outputs.run == 'true'"

const andLiveVercelCiToolsIf = (condition: string) => {
  const trimmed = condition.trim()
  const unwrapped =
    trimmed.startsWith('${{') === true && trimmed.endsWith('}}') === true
      ? trimmed.slice(3, -2).trim()
      : trimmed
  return `${unwrapped} && ${liveVercelCiToolsIf}`
}

const onlyWhenLiveVercelCiTools = <Step extends Record<string, unknown>>(step: Step) => ({
  ...step,
  if:
    typeof step.if === 'string' && step.if.length > 0
      ? andLiveVercelCiToolsIf(step.if)
      : liveVercelCiToolsIf,
})

const liveVercelCiToolsE2EStep = {
  name: 'Live Vercel ci-tools E2E',
  shell: 'bash',
  env: {
    CI_TOOLS_VERCEL_LIVE: '1',
    VERCEL_TOKEN: '${{ secrets.VERCEL_TOKEN }}',
    VERCEL_PROJECT_ID: '${{ secrets.VERCEL_PROJECT_ID }}',
    VERCEL_ORG_ID: '${{ secrets.VERCEL_ORG_ID }}',
    VERCEL_TEAM_ID: '${{ secrets.VERCEL_TEAM_ID }}',
    VERCEL_SCOPE: '${{ secrets.VERCEL_SCOPE }}',
    VERCEL_AUTOMATION_BYPASS_SECRET: '${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}',
  },
  run: withCiSourceRoot(
    [
      'vercel_pkg="$(nix build --no-link --print-out-paths .#vercel-cli)"',
      'export CI_TOOLS_LIVE_VERCEL_BIN="$vercel_pkg/bin/vercel"',
      'DEVENV_TASK_PASSTHROUGH=1 DEVENV_TUI=false "${DEVENV_BIN:?DEVENV_BIN not set}" tasks run buck2:editor:publish',
      'DEVENV_TUI=false "${DEVENV_BIN:?DEVENV_BIN not set}" shell --no-reload -- bun test packages/@overeng/ci-tools/src/deploy-vercel.live.e2e.test.ts',
    ].join('\n'),
  ),
} as const

const storybookPreviewBundlePath =
  '${{ runner.temp }}/workflow-reports/storybook-preview-bundle.json'
const storybookPreviewCommentBodyPath =
  '${{ runner.temp }}/workflow-reports/storybook-preview-comment.md'
const storybookPreviewSummaryPath =
  '${{ runner.temp }}/workflow-reports/storybook-preview-summary.md'

/** Verify shell activation is mutation-free and exposes the native Buck command. */
const verifyOtelShellEntryStep = {
  name: 'Verify mutation-free shell entry',
  shell: 'bash' as const,
  run: withCiSourceRoot(
    [
      runDevenvTasksBefore('otel:test'),
      'command -v script >/dev/null 2>&1',
      'tmp_log="$(mktemp)"',
      'before="$(git status --porcelain=v1)"',
      `printf 'command -v buck2\nexit\n' | script -qefc '"${'${DEVENV_BIN:?DEVENV_BIN not set}'}" shell --no-reload' "$tmp_log"`,
      'grep -q \'/bin/buck2\' "$tmp_log"',
      '! grep -q \'\\[otel\\] Using\' "$tmp_log"',
      'test "$(git status --porcelain=v1)" = "$before"',
      'rm -f "$tmp_log"',
    ].join('\n'),
  ),
} as const

/**
 * Temporary diagnostics summary for #272.
 * Remove once #201/#272 are root-caused and we can return to a minimal CI flow.
 */
const nixDiagnosticsSummaryStep = {
  name: 'Nix diagnostics summary',
  if: 'failure()',
  shell: 'bash',
  run: [
    'diag_dir="${NIX_STORE_DIAGNOSTICS_DIR:-}"',
    'if [ -z "$diag_dir" ] || [ ! -d "$diag_dir" ]; then',
    '  echo "## Nix Store Diagnostics" >> "$GITHUB_STEP_SUMMARY"',
    '  echo "" >> "$GITHUB_STEP_SUMMARY"',
    '  echo "No diagnostics directory found (validation may have failed before capture)." >> "$GITHUB_STEP_SUMMARY"',
    '  exit 0',
    'fi',
    '',
    '{',
    '  echo "## Nix Store Diagnostics"',
    '  echo ""',
    '  echo "Temporary instrumentation for #272; remove after root cause is confirmed and CI is stable."',
    '  echo ""',
    '  echo "- Diagnostics directory: \\`$diag_dir\\`"',
    '  echo "- Tracking issue: https://github.com/overengineeringstudio/effect-utils/issues/272"',
    '} >> "$GITHUB_STEP_SUMMARY"',
    '',
    'markers_file="${RUNNER_TEMP:-/tmp}/nix-store-signature-markers.txt"',
    'grep -R -n -E "config\\\\.cachix|cachix\\\\.package|error: path \'/nix/store/.+ is not valid" --exclude="$(basename "$markers_file")" "$diag_dir" > "$markers_file" || true',
    '',
    'if [ -s "$markers_file" ]; then',
    '  {',
    '    echo ""',
    '    echo "### Signature markers"',
    "    echo '```text'",
    '    head -n 120 "$markers_file"',
    "    echo '```'",
    '  } >> "$GITHUB_STEP_SUMMARY"',
    'else',
    '  echo "" >> "$GITHUB_STEP_SUMMARY"',
    '  echo "- No signature markers found in captured diagnostics." >> "$GITHUB_STEP_SUMMARY"',
    'fi',
  ].join('\n'),
} as const

const jobTimeoutMinutes = 30

/**
 * `schedule` exists only for the nightly deterministic measurement snapshot of
 * `main`: the two deterministic measurement lanes and the aggregate report.
 * Product lanes carry this guard so a cron never re-runs the product matrix.
 */
const notNightlyMeasurementIf = "github.event_name != 'schedule'"

const normalCiIf = `\${{ (${ciMeasurementNotBaselineBackfillPredicate}) && ${notNightlyMeasurementIf} }}`
const trustedSecretCiIf = `\${{ (${ciMeasurementNotBaselineBackfillPredicate}) && github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch') }}`

/** Deterministic measurement lanes also feed the nightly snapshot. */
const measurementLaneIf = `\${{ ${ciMeasurementNotBaselineBackfillPredicate} }}`

/**
 * The paired wall-clock lane runs only when explicitly requested by an operator.
 * It stays outside automatic PR, push, and scheduled cadence because its advisory
 * evidence does not affect those events' outcomes.
 */
const devenvPerfLaneIf = `\${{ github.event_name == 'workflow_dispatch' }}`

/**
 * The report aggregates whichever measurement lanes ran on `main`: the two
 * deterministic lanes on push/schedule, and all three lanes on dispatch. A
 * skipped `devenv-perf` must not skip the report, so the condition inspects
 * `needs` results instead of relying on implicit success.
 */
const measurementReportIf = [
  '${{ !cancelled()',
  `&& (${ciMeasurementNotBaselineBackfillPredicate})`,
  "&& github.ref == 'refs/heads/main'",
  "&& (github.event_name == 'push' || github.event_name == 'workflow_dispatch' || github.event_name == 'schedule')",
  "&& needs.devenv-perf.result != 'failure'",
  "&& needs.nix-closure-sizes.result != 'failure'",
  "&& needs.source-shape.result != 'failure' }}",
].join(' ')

const job = ({
  step,
  extraSteps = [],
}: {
  step: { name: string; run: string }
  extraSteps?: readonly any[]
}) => ({
  if: normalCiIf,
  'runs-on': namespaceRunner({
    profile: 'namespace-profile-linux-x86-64',
    runId: '${{ github.run_id }}',
  }),
  'timeout-minutes': jobTimeoutMinutes,
  defaults: bashShellDefaults,
  env: standardCIEnv,
  steps: [
    ...baseSteps,
    ...extraSteps,
    step,
    nixDiagnosticsSummaryStep,
    nixDiagnosticsArtifactStep(),
    failureReminderStep,
  ],
})

const multiPlatformJob = (step: { name: string; run: string }) => ({
  if: normalCiIf,
  strategy: {
    'fail-fast': false,
    matrix: {
      runner: [...RUNNER_PROFILES],
    },
  },
  'runs-on': namespaceRunner({
    profile: '${{ matrix.runner }}' as RunnerProfile,
    runId: '${{ github.run_id }}',
  }),
  'timeout-minutes': jobTimeoutMinutes,
  defaults: bashShellDefaults,
  env: standardCIEnv,
  steps: [
    ...baseSteps,
    step,
    nixDiagnosticsSummaryStep,
    nixDiagnosticsArtifactStep(),
    failureReminderStep,
  ],
})

// Checkout exemption inventory: nix-fod-check is a strict flake/FOD lane. It
// deliberately runs no devenv task, Buck command, or composition-dependent helper.
const strictNixJobBaseSteps = [
  checkoutStep(),
  installNixStep(),
  ciMeasurementBaselineCheckoutStep,
  nixCacheSetupStep,
  cachixCliBuildStep,
  cachixStep({ name: 'overeng-effect-utils' }),
  prepareCiScriptsStep,
] as const

const multiPlatformStrictNixJob = (step: ReturnType<typeof validateColdPnpmDepsStep>) => ({
  if: normalCiIf,
  strategy: {
    'fail-fast': false,
    matrix: {
      runner: [...RUNNER_PROFILES],
    },
  },
  'runs-on': namespaceRunner({
    profile: '${{ matrix.runner }}' as RunnerProfile,
    runId: '${{ github.run_id }}',
  }),
  'timeout-minutes': jobTimeoutMinutes,
  defaults: bashShellDefaults,
  env: standardCIEnv,
  steps: [
    ...strictNixJobBaseSteps,
    step,
    nixDiagnosticsSummaryStep,
    nixDiagnosticsArtifactStep(),
    failureReminderStep,
  ],
})

/**
 * Audit the native npm dependency policy against the lockfile (issue #807).
 * Install-free: depends only on `pnpm-lock.yaml` and the genie policy source.
 */
const nativeDepPolicyAuditStep = {
  name: 'Audit native dependency policy',
  shell: 'bash',
  run: withCiSourceRoot(
    [
      'set -euo pipefail',
      'audit=genie/ci-scripts/native-dep-policy-audit.ts',
      'if command -v bun >/dev/null 2>&1; then',
      '  bun "$audit"',
      'else',
      '  nix run nixpkgs#bun -- "$audit"',
      'fi',
    ].join('\n'),
  ),
} as const

// Core product jobs keyed by the shared Genie CI source of truth.
const jobs: Record<CoreCIJobName, ReturnType<typeof job> | ReturnType<typeof multiPlatformJob>> = {
  // Buck is the single TypeScript check and declaration authority.
  typecheck: job({
    step: {
      name: 'Type check (Buck)',
      run: runDevenvTasksBefore('buck2:check'),
    },
    extraSteps: [verifyOtelShellEntryStep],
  }),
  lint: job({
    step: {
      name: 'Format + lint',
      // Keep generated-file freshness authoritative in CI. The lint task's
      // execIfModified filter remains only a local fast path.
      run: runDevenvTasksBefore('genie:check', 'lint:check'),
    },
  }),
  // Bounded unit-test execution is Buck-owned: `test:run` waits on the single `test:buck2:unit`
  // invocation, source-only packages, and each lane's exact unbounded complement. Explicit
  // live/e2e owners remain separate jobs. The baseline gate reads Buck collection artifacts and
  // retained source summaries, and also proves every lane's recorded census exactly matches its
  // actual collection. CI must not shard this lane: the gate needs both partitions in one job.
  test: multiPlatformJob({
    name: 'Unit tests',
    run: runDevenvTasksBefore('test:run'),
  }),
  'test-playwright-utils': job({
    step: {
      name: 'Utils Playwright tests',
      run: runDevenvTasksBefore('test:pw:utils'),
    },
  }),
  'test-playwright-tui-react': job({
    step: {
      name: 'TUI React Playwright tests',
      run: runDevenvTasksBefore('test:pw:tui-react'),
    },
  }),
  'test-megarepo-cold-gc': job({
    step: {
      name: 'Megarepo cold-GC tests',
      run: runDevenvTasksBefore('test:megarepo-cold-gc'),
    },
  }),
  // Verify the surviving pnpm FOD hash (pnpmDepsHash + localDeps) is up to date.
  // After the Buck product cutover the nix-cli registry is no longer a fan-out over seven CLI
  // FODs: the repository CLIs are wrapped from the immutable Buck product manifest and have no
  // source builder or hash left to check. `.#oxlint-npm` (the pnpm-built oxlint plugin bundle)
  // is the one entry that remains.
  'nix-check': multiPlatformJob({
    name: 'Nix hash check',
    run: runDevenvTasksBefore('nix:check'),
  }),
  // Force a fresh local rebuild of the exported pnpm FOD to catch a stale hash that normal CI
  // can otherwise mask via store/substituter reuse. `.#oxc-config-plugin-pnpm-deps` is the only
  // such attribute left — every CLI `*-pnpm-deps` FOD went away with its source builder — so
  // this is a single cold build, not a list that is expected to grow again.
  'nix-fod-check': multiPlatformStrictNixJob(
    validateColdPnpmDepsStep({
      flakeRefs: ['.#oxc-config-plugin-pnpm-deps'],
      substituters: ['https://cache.nixos.org'],
    }),
  ),
  'pnpm-builder-contract': job({
    step: pnpmBuilderContractStep({
      builderFile: 'nix/workspace-tools/lib/mk-pnpm-deps.nix',
    }),
    // Audit the native npm dependency policy (issue #807) in the same lane that
    // guards the pnpm builder contract. Runs install-free against the lockfile
    // and the genie policy source, both present here without node_modules.
    extraSteps: [nativeDepPolicyAuditStep],
  }),
  // After the cutover `mk-pnpm-cli` has no in-repo CLI consumer left: it is exercised only by
  // its own contract suite here and, through `mk-pnpm-deps.nix`, by the oxc-config plugin FOD.
  // That makes this lane the sole remaining guard on the shared pnpm deps helper.
  'pnpm-regression': job({
    step: {
      name: 'pnpm regression suite',
      run: withCiSourceRoot(
        [
          'bash genie/ci-scripts/nix-gc-race-retry.test.sh',
          'bash genie/ci-scripts/ci-measurement-comparison.test.sh',
          'bash genie/ci-scripts/native-dep-policy-audit.test.sh',
          'bash nix/workspace-tools/lib/mk-pnpm-cli/tests/run.sh --skip-genie --skip-megarepo --skip-devenv-shell --skip-downstream-megarepo',
        ].join('\n'),
      ),
    },
  }),
  'bundle-smoke': job({
    step: {
      name: 'Bundle smoke tests',
      run: runDevenvTasksBefore('bundle:smoke'),
    },
  }),
  cargo: job({
    step: {
      name: 'Cargo build + test + clippy + fmt',
      run: runDevenvTasksBefore('cargo:check'),
    },
  }),
  // Additive Weaver semantic-conventions gates, in one lane (GEN-R09 block-vs-degrade): each
  // `weaver:*` task BLOCKS on a validation failure but DEGRADES to a warning (exit 0) if the
  // weaver flake / upstream semconv FOD is unavailable, so it never wedges the product lanes.
  //   - weaver:check      (SC-R10) registry schema/policy validation
  //   - weaver:diff       (SC-R11) compat-diff vs the merge-base baseline (blocks on a REMOVED
  //                        attribute/signal). Needs baseline history: the fetch step below
  //                        un-shallows the checkout so `merge-base origin/main HEAD` resolves —
  //                        without it weaver:diff silently degrades (nothing to diff against).
  //   - weaver:live-check (SC-R12) e2e: emitted OTLP conforms to the registry
  weaver: job({
    extraSteps: [
      {
        name: 'Fetch baseline history for weaver:diff (SC-R11)',
        run: withCiSourceRoot(
          [
            'set -uo pipefail',
            '# weaver:diff needs the merge-base with origin/main; the default checkout is shallow.',
            'git fetch --no-tags --prune --unshallow origin 2>/dev/null \\',
            '  || git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main 2>/dev/null \\',
            '  || true',
          ].join('\n'),
        ),
      },
    ],
    step: {
      name: 'Weaver registry gates (check + diff + live-check)',
      run: runDevenvTasksBefore('weaver:check', 'weaver:diff', 'weaver:live-check'),
    },
  }),
}

// Source-shape/report aggregation intentionally use actions-checkout paths. Producers that
// execute source commands write artifacts below the synthesized owned member instead.
const sourceShapeMeasurementsDir = 'tmp/source-shape-ci'
const effectUtilsMemberTmpDir = '${{ env.EFFECT_UTILS_MEMBER_ROOT }}/tmp'
// Intentional actions-checkout artifact path: devenvPerfJob owns ARTIFACT_DIR at job scope,
// where neither `env` nor `runner` contexts are available; source commands still run in the member.
const devenvPerfMeasurementsDir = '${{ github.workspace }}/tmp/devenv-perf-ci'
const nixClosureMeasurementsDir = `${effectUtilsMemberTmpDir}/nix-closure-ci`
const ciMeasurementReportDir = 'tmp/ci-measurement-report'

/**
 * `actions/download-artifact` fails when the named artifact does not exist, so a producer
 * lane that did not run in this event needs `producedBy` — the report then aggregates the
 * lanes that did run instead of failing on the ones that did not.
 */
const downloadCurrentMeasurementArtifactStep = ({
  artifactName,
  outputDir,
  producedBy,
}: {
  artifactName: string
  outputDir: string
  producedBy?: string
}) =>
  ({
    name: `Download current measurement artifact: ${artifactName}`,
    ...(producedBy === undefined ? {} : { if: `\${{ needs.${producedBy}.result == 'success' }}` }),
    uses: 'actions/download-artifact@v4',
    with: {
      name: artifactName,
      path: outputDir,
    },
  }) as const

const ciMeasurementReportToolStep = {
  name: 'Provide CI measurement report tools',
  shell: 'bash',
  run: [
    'set -euo pipefail',
    'for out in $(nix build --no-link --print-out-paths nixpkgs#jq nixpkgs#nodejs nixpkgs#gh nixpkgs#resvg); do',
    '  echo "$out/bin" >> "$GITHUB_PATH"',
    'done',
  ].join('\n'),
} as const

const nixClosureMeasurementTargets = [
  {
    installable: '.#genie',
    id: 'genie_package',
    name: 'genie',
    label: 'Genie package',
    group: 'packages',
    path: ['nix', 'closures', 'packages', 'genie'],
    description: 'the Genie CLI closure wrapped from the immutable Buck product manifest',
    system: 'x86_64-linux',
  },
  {
    installable: '.#megarepo',
    id: 'megarepo_package',
    name: 'megarepo',
    label: 'Megarepo package',
    group: 'packages',
    path: ['nix', 'closures', 'packages', 'megarepo'],
    description: 'the megarepo CLI closure wrapped from the immutable Buck product manifest',
    system: 'x86_64-linux',
  },
  {
    installable: '.#oxlint-npm',
    id: 'oxlint_npm_package',
    name: 'oxlint-npm',
    label: 'oxlint npm package',
    group: 'packages',
    path: ['nix', 'closures', 'packages', 'oxlint-npm'],
    description: 'the packaged oxlint npm compatibility wrapper closure',
    system: 'x86_64-linux',
  },
] as const

// Non-core jobs are kept outside the typed product-job block but still tracked
// in genie/ci.ts for required-check policy.
const extraJobs: Record<string, any> = {
  /**
   * Fresh-checkout PR-A proof. This deliberately uses only a GitHub-hosted runner,
   * public caches, read-only permissions, and inert commands: it can validate product
   * and editor machinery from an untrusted fork without publication authority.
   */
  'pr-a-inert-buck': {
    if: `\${{ github.event_name == 'pull_request' && github.event.action != 'labeled' }}`,
    'runs-on': 'ubuntu-latest',
    'timeout-minutes': jobTimeoutMinutes,
    defaults: bashShellDefaults,
    permissions: { contents: 'read' },
    env: {
      FORCE_SETUP: '1',
      CI: 'true',
      BUCK2_NO_REMOTE_CACHE: '1',
    },
    steps: [
      checkoutStep(),
      installNixStep(),
      cachixCliBuildStep,
      cachixStep({ name: 'overeng-effect-utils' }),
      prepareEffectUtilsCompositionStep,
      prepareCiScriptsStep,
      preparePinnedDevenvStep,
      validateNixStoreStep,
      {
        name: 'Check generated sources',
        run: runDevenvTasksBefore('genie:check'),
      },
      {
        name: 'Run focused normalized, projection, and runner tests',
        run: withCiSourceRoot(
          [
            'set -euo pipefail',
            '"${DEVENV_BIN:?DEVENV_BIN not set}" shell -- bun test \\',
            '  genie/buck2/typescript-package-projection.unit.test.ts \\',
            '  genie/buck2/javascript-candidates.unit.test.ts \\',
            '  packages/@overeng/buck2-tools/src/package-command-runner.unit.test.ts',
          ].join('\n'),
        ),
      },
      {
        // Two workspace-tools contract suites bound the release-manifest boundary from both
        // sides: the publisher (source of the manifest) and the importer (its only consumer).
        // `buck2:nix-bridge:check` still owns the bridge/build-product suites through devenv.
        name: 'Check product publisher and manifest import contracts',
        run: withCiSourceRoot(
          [
            'set -euo pipefail',
            '"${DEVENV_BIN:?DEVENV_BIN not set}" shell -- env -u GITHUB_EVENT_NAME bash nix/workspace-tools/lib/tests/buck2-release-products.sh "$PWD"',
            '"${DEVENV_BIN:?DEVENV_BIN not set}" shell -- bash nix/workspace-tools/lib/tests/javascript-product-import.sh "$PWD"',
          ].join('\n'),
        ),
      },
      {
        name: 'Reject tracked product and editor payload bytes',
        run: withCiSourceRoot(
          [
            'set -euo pipefail',
            "tracked_editor=$(git ls-files -- '**/.editor-view/**' '.editor-view/**')",
            `tracked_product=$(git ls-files -- 'nix/buck2-products/**' | grep -Ev '^nix/buck2-products/(default\\.nix|manifest\\.json|publish\\.sh)$' || true)`,
            'if [ -n "$tracked_editor$tracked_product" ]; then',
            '  printf \'Tracked inert payload bytes are forbidden:\\n%s\\n%s\\n\' "$tracked_editor" "$tracked_product" >&2',
            '  exit 1',
            'fi',
          ].join('\n'),
        ),
      },
      {
        name: 'Query and build representative inert Buck targets',
        run: withCiSourceRoot(
          [
            'set -euo pipefail',
            '"${DEVENV_BIN:?DEVENV_BIN not set}" shell -- bash -euo pipefail -c \'',
            '  cd "${EFFECT_UTILS_WORKSPACE_ROOT:?EFFECT_UTILS_WORKSPACE_ROOT not set}"',
            '  buck="$PWD/.megarepo/bin/buck2"',
            '  "$buck" query effect_utils//packages/@overeng/ci-tools:ci-tools-candidate',
            '  "$buck" query effect_utils//:editor_view_inputs',
            '  "$buck" build \\',
            '    effect_utils//packages/@overeng/ci-tools:ci-tools-candidate \\',
            '    effect_utils//:editor_view_inputs',
            "'",
          ].join('\n'),
        ),
      },
    ],
  },
  /**
   * Trusted-only proof that a freshly materialized Buck context can consume an
   * action uploaded by an independent local context through the tailnet cache.
   */
  'trusted-buck2-remote-cache-proof': {
    if: trustedSecretCiIf,
    'runs-on': namespaceRunner({
      profile: 'namespace-profile-linux-x86-64',
      runId: '${{ github.run_id }}',
    }),
    'timeout-minutes': jobTimeoutMinutes,
    defaults: bashShellDefaults,
    permissions: { contents: 'read' },
    env: {
      ...standardCIEnv,
      // Composition only suppresses remote-cache projection for the exact value `1`.
      BUCK2_NO_REMOTE_CACHE: '0',
    },
    steps: [
      checkoutStep(),
      installNixStep(),
      prepareEffectUtilsCompositionStep,
      prepareCiScriptsStep,
      preparePinnedDevenvStep,
      validateNixStoreStep,
      {
        name: 'Prove fresh-root remote action and test-cache hits',
        env: {
          BUCK2_REMOTE_CACHE_BASIC_AUTH: '${{ secrets.BUCK2_REMOTE_CACHE_BASIC_AUTH }}',
        },
        run: [
          'set -euo pipefail',
          'proof_script="${RUNNER_TEMP:?RUNNER_TEMP not set}/buck2-remote-cache-proof.sh"',
          `trap 'rm -f "$proof_script"' EXIT`,
          `cat > "$proof_script" <<'BUCK2_REMOTE_CACHE_PROOF'`,
          'set -euo pipefail',
          'if [ -z "${BUCK2_REMOTE_CACHE_BASIC_AUTH:-}" ]; then',
          '  echo "::error::BUCK2_REMOTE_CACHE_BASIC_AUTH is required for the trusted remote-cache proof"',
          '  exit 1',
          'fi',
          'cd "${EFFECT_UTILS_WORKSPACE_ROOT:?EFFECT_UTILS_WORKSPACE_ROOT not set}"',
          'buck="$PWD/.megarepo/bin/buck2"',
          'context_b="${RUNNER_TEMP:?RUNNER_TEMP not set}/buck2-remote-cache-proof-context-b"',
          'target="effect_utils//packages/@overeng/ci-tools:ci-tools-candidate"',
          'test_target="effect_utils//packages/@overeng/content-address:test"',
          'proof_source="${EFFECT_UTILS_MEMBER_ROOT:?EFFECT_UTILS_MEMBER_ROOT not set}/packages/@overeng/ci-tools/bin/ci-tools.ts"',
          'test_proof_source="${EFFECT_UTILS_MEMBER_ROOT:?EFFECT_UTILS_MEMBER_ROOT not set}/packages/@overeng/content-address/src/mod.unit.test.ts"',
          `printf '%s\\n' '' "// trusted remote-cache proof \${GITHUB_RUN_ID:?GITHUB_RUN_ID not set}-\${GITHUB_RUN_ATTEMPT:?GITHUB_RUN_ATTEMPT not set}" >> "$proof_source"`,
          `printf '%s\\n' '' "// trusted test-cache proof \${GITHUB_RUN_ID:?GITHUB_RUN_ID not set}-\${GITHUB_RUN_ATTEMPT:?GITHUB_RUN_ATTEMPT not set}" >> "$test_proof_source"`,
          'evidence_a="${RUNNER_TEMP:?RUNNER_TEMP not set}/buck2-remote-cache-proof-a.jsonl"',
          'test_evidence_a="${RUNNER_TEMP:?RUNNER_TEMP not set}/buck2-test-cache-proof-a.jsonl"',
          'evidence_b="${RUNNER_TEMP:?RUNNER_TEMP not set}/buck2-remote-cache-proof-b.jsonl"',
          'test_evidence_b="${RUNNER_TEMP:?RUNNER_TEMP not set}/buck2-test-cache-proof-b.jsonl"',
          'test_evidence_c="${RUNNER_TEMP:?RUNNER_TEMP not set}/buck2-test-cache-proof-c.jsonl"',
          `trap 'rm -f "$evidence_a" "$test_evidence_a" "$evidence_b" "$test_evidence_b" "$test_evidence_c"; rm -rf "$context_b"' EXIT`,
          '',
          '# Context A has run-unique source inputs, executes locally, and uploads to the remote cache.',
          '# The composition wrapper fixes --isolation-dir, so freshness comes from daemon and state removal.',
          '"$buck" kill',
          'rm -rf buck-out',
          '"$buck" build --local-only "$target"',
          '"$buck" log show --recent 1 > "$evidence_a"',
          `if ! jq -e 'select(.Event.data.SpanEnd.data.ActionExecution as $action | $action.execution_kind == "ACTION_EXECUTION_KIND_LOCAL" and $action.cache_upload_result == "UPLOAD_RESULT_UPLOADED")' "$evidence_a" >/dev/null; then`,
          '  echo "::error::Context A did not report a successful upload for a locally executed action"',
          '  exit 1',
          'fi',
          '"$buck" test --target-platforms effect_utils//buck2/platforms:host_platform --local-only "$test_target"',
          '"$buck" log show --recent 1 > "$test_evidence_a"',
          `if ! jq -e 'select(.Event.data.SpanEnd.data.TestRun.command_report.details.command_kind.command.LocalCommand)' "$test_evidence_a" >/dev/null; then`,
          '  echo "::error::Context A did not execute the representative unit-test lane locally"',
          '  exit 1',
          'fi',
          '',
          '# Context B is a second composed root with a fresh daemon and materializer over identical inputs.',
          '"$buck" kill',
          'rm -rf buck-out "$context_b"',
          'mkdir -p "$context_b/.buck2" "$context_b/.megarepo" "$context_b/repos/effect-utils"',
          'cp -a .buckconfig .buckroot BUCK megarepo.kdl "$context_b/"',
          'cp -a .buck2/capabilities "$context_b/.buck2/"',
          'cp -a .megarepo/bin "$context_b/.megarepo/"',
          'tar -C repos/effect-utils \\',
          `  --exclude='./.devenv' \\`,
          `  --exclude='./.git' \\`,
          `  --exclude='./buck-out' \\`,
          `  --exclude='./node_modules' \\`,
          `  --exclude='./packages/.editor-view' \\`,
          `  --exclude='./target' \\`,
          `  --exclude='./tmp' \\`,
          `  --exclude='*/__pycache__' \\`,
          `  --exclude='*/dist' \\`,
          `  --exclude='*/node_modules' \\`,
          `  --exclude='*/target' \\`,
          '  -cf - . | tar -C "$context_b/repos/effect-utils" -xf -',
          'cd "$context_b"',
          'buck="$PWD/.megarepo/bin/buck2"',
          '',
          '# Buck event data must classify the independent build as a remote action-cache hit.',
          '"$buck" build --local-only "$target"',
          '"$buck" log show --recent 1 > "$evidence_b"',
          `if ! jq -e 'select(.Event.data.SpanEnd.data.ActionExecution.execution_kind == "ACTION_EXECUTION_KIND_ACTION_CACHE")' "$evidence_b" >/dev/null; then`,
          '  echo "::error::Context B did not report a remote action-cache hit"',
          '  exit 1',
          'fi',
          `if jq -e 'select(.Event.data.SpanEnd.data.ActionExecution.execution_kind as $kind | $kind == "ACTION_EXECUTION_KIND_LOCAL" or $kind == "ACTION_EXECUTION_KIND_REMOTE" or $kind == "ACTION_EXECUTION_KIND_LOCAL_DEP_FILE" or $kind == "ACTION_EXECUTION_KIND_LOCAL_ACTION_CACHE" or $kind == "ACTION_EXECUTION_KIND_LOCAL_WORKER" or $kind == "ACTION_EXECUTION_KIND_REMOTE_WORKER")' "$evidence_b" >/dev/null; then`,
          '  echo "::error::Context B executed an action or reused local action state instead of relying on the remote action cache"',
          '  exit 1',
          'fi',
          '',
          '# The representative unit test must pass from the remote test cache without a local test command.',
          '"$buck" test --target-platforms effect_utils//buck2/platforms:host_platform --local-only "$test_target"',
          '"$buck" log show --recent 1 > "$test_evidence_b"',
          `if ! jq -e 'select(.Event.data.Instant.data.TestResult.name == "effect_utils//packages/@overeng/content-address:test" and .Event.data.Instant.data.TestResult.status == 1)' "$test_evidence_b" >/dev/null; then`,
          '  echo "::error::Context B did not report the cached representative unit test as passing"',
          '  exit 1',
          'fi',
          `if jq -e 'select(.Event.data.SpanEnd.data.TestRun.command_report.details.command_kind.command.LocalCommand)' "$test_evidence_b" >/dev/null; then`,
          '  echo "::error::Context B executed the representative unit test locally instead of using the remote test cache"',
          '  exit 1',
          'fi',
          '',
          '# A source file outside the representative target graph must not change its test action key.',
          `printf '%s\\n' '' "// trusted irrelevant-mutation proof \${GITHUB_RUN_ID:?GITHUB_RUN_ID not set}-\${GITHUB_RUN_ATTEMPT:?GITHUB_RUN_ATTEMPT not set}" >> repos/effect-utils/README.md`,
          '"$buck" test --target-platforms effect_utils//buck2/platforms:host_platform --local-only "$test_target"',
          '"$buck" log show --recent 1 > "$test_evidence_c"',
          `if ! jq -e 'select(.Event.data.Instant.data.TestResult.name == "effect_utils//packages/@overeng/content-address:test" and .Event.data.Instant.data.TestResult.status == 1)' "$test_evidence_c" >/dev/null; then`,
          '  echo "::error::The irrelevant mutation prevented the cached representative unit test from passing"',
          '  exit 1',
          'fi',
          `if jq -e 'select(.Event.data.SpanEnd.data.TestRun.command_report.details.command_kind.command.LocalCommand)' "$test_evidence_c" >/dev/null; then`,
          '  echo "::error::The irrelevant mutation changed the representative unit-test action key"',
          '  exit 1',
          'fi',
          'echo "Fresh-root remote action and test-cache proof passed"',
          'BUCK2_REMOTE_CACHE_PROOF',
          '"${DEVENV_BIN:?DEVENV_BIN not set}" shell -- bash "$proof_script"',
        ].join('\n'),
      },
    ],
  },
  // bootstrap:cold-proof (R32) — the empirical authority for the bootstrap-safe import-closure
  // contract (issue #884). In a fresh, no-node_modules tree of the committed source it runs the
  // `.#genie` CLI (after the cutover a wrapper around the immutable Buck product manifest rather
  // than a source build, so this lane no longer warms a source FOD) with `--phase bootstrap`,
  // then `pnpm install --frozen-lockfile` against the registry, asserting both
  // succeed. This exercises the exact pre-install path; `bootstrap-closure:check` (in `check:all`) is
  // the static fast-feedback pre-check. Separate lane because it is heavier than the product checks.
  'bootstrap-cold-proof': job({
    step: {
      name: 'Bootstrap cold-proof (R32)',
      run: runDevenvTasksBefore('bootstrap:cold-proof'),
    },
  }),
  'devenv-perf': {
    if: devenvPerfLaneIf,
    ...devenvPerfJob({
      runsOn: namespaceRunner({
        profile: namespaceLinuxX64PairedPerfRunner,
        runId: '${{ github.run_id }}',
      }),
      artifactName: 'devenv-perf',
      artifactDir: devenvPerfMeasurementsDir,
      baselineSeedRuns: [
        [
          ['25959801150', '655', 'df0420cd0397ffc6928d3c6ccc9c23052d6bc255'],
          ['25959802067', '657', '62833cba5d83b1c13462728edeafa684e61c006f'],
          ['25959802958', '656', '21029998522a0e9435df151259611650fb948a20'],
          ['25959803805', '651', '95515f971b27ef279e39c982f52e46cf9e8270e9'],
          ['25959804678', '654', '58e96b9a2b87b3703de6920b6d9571f3805d0171'],
          ['25959805512', '653', 'd1cca16339f19d7e1a27b001edc4c2c7ecd13dc4'],
          ['25959806473', '652', 'acd6c63f5e235e7e5f2710fc62b2231e0ba904a6'],
          ['25959807303', '648', 'a5a07703ff951fb7396a40844e9491d88ed40edf'],
          ['25959808097', '649', '360ff47c59a206064711dfcb6c610afd0e6b0d53'],
          ['25959808775', '647', '8d1810b2c359ae95f245e56329018aab5020f8c0'],
          ['25959809449', '646', '89e1396766ccd2a813680acd440cb78f540ca6c1'],
          ['25959810069', '643', '239715520370436901a3f2218d162dc7b12f4b4c'],
          ['25959810666', '641', '6b3751b4684ba45f496f1a1bff8b86ef6ba8275b'],
          ['25959811321', '640', 'fed50ae2502ac0a65395bbef5af43fcf384d5d04'],
          ['25959811864', '639', '0e03df2c6f20e4d154f286fd69a4e2980d21a12d'],
          ['25959812634', '636', '7efdbee4b571f2c80f5b6173bc9a84b51fbef5eb'],
          ['25959813189', '638', '350d1b98baa943dcae63412eeffded7b5160bc8a'],
          ['25959813761', '637', 'f25336193b9f6b042eb027eca27acc4cc75a69d6'],
          ['25959814335', '634', '4ba441d4ad8b6c49e9ee03d9cdfd2f04a129b714'],
          ['25959814835', '632', '1ad5fd735c7f45ad5e07c8033e5b68a642ada69c'],
        ].map(([runId, pr, sha]) => ({
          runId,
          label: `PR #${pr}`,
          sha,
          source: 'manual-backfill',
          artifacts: ['devenv-perf'],
          notes:
            'Backfilled with the current measurement workflow for the effect-utils #658 rollout.',
        })),
      ],
      baselineMaxRuns: 20,
      // Wall-clock measurements are advisory until they have paired same-run
      // base/head evidence. Deterministic measurements such as closure sizes
      // can still use budget-style gates in consuming repos.
      regressionMode: 'warn',
      env: ciMeasurementSubjectEnv,
      setupSteps: baseSteps,
      taskProbes: [
        {
          task: 'buck2:editor:publish',
          label: 'Editor dependency publication',
          group: 'workspace setup',
          description: 'Publishes the complete Buck-owned editor dependency surface.',
          warmupRepetitions: 1,
          repetitions: 5,
        },
        {
          task: 'genie:run',
          label: 'Genie run task',
          group: 'genie',
          description: 'Runs the normal devenv genie:run task including its declared dependencies.',
          warmupRepetitions: 1,
          repetitions: 5,
        },
        {
          task: 'check:quick',
          id: 'task_check_quick_warm',
          label: 'Warm cached check:quick',
          group: 'quality gates',
          path: ['quality gates', 'check:quick'],
          description:
            'Runs the fast local quality gate through devenv after a warmup. This measures the cached no-op path and task/status orchestration overhead.',
          dimensions: {
            workload: 'cached-no-op',
            taskCacheMode: 'warm',
          },
          warmupRepetitions: 1,
          repetitions: 5,
        },
        {
          task: 'check:quick',
          id: 'task_check_quick_forced',
          label: 'Forced check:quick',
          group: 'quality gates',
          path: ['quality gates', 'check:quick'],
          description:
            'Runs the fast local quality gate through devenv with task-cache refresh. This measures the developer-facing quick-check workload rather than the cached no-op path.',
          dimensions: {
            workload: 'forced-task-cache',
            taskCacheMode: 'refresh',
          },
          extraArgs: ['--refresh-task-cache'],
          warmupRepetitions: 0,
          repetitions: 3,
        },
      ],
      probes: [
        {
          id: 'genie_check_task',
          label: 'Genie check task',
          group: 'genie',
          description: 'Runs the supported Genie check task without shell-entry overhead.',
          warmupRepetitions: 1,
          repetitions: 5,
          command: ['$DEVENV_BIN', 'tasks', 'run', 'genie:check'],
        },
      ],
      permissions: { actions: 'read', contents: 'read' },
      compare: false,
      prComment: {
        enabled: false,
        title: 'Devenv Performance',
        maxRows: 8,
        maxHistory: 20,
      },
    }),
    'timeout-minutes': 90,
  },
  'nix-closure-sizes': {
    if: measurementLaneIf,
    'runs-on': namespaceRunner({
      profile: 'namespace-profile-linux-x86-64',
      runId: '${{ github.run_id }}',
    }),
    'timeout-minutes': jobTimeoutMinutes,
    defaults: bashShellDefaults,
    permissions: { actions: 'read', contents: 'read' },
    env: ciMeasurementSubjectEnv,
    steps: [
      ...baseSteps,
      ...nixClosureMeasurementSteps({
        artifactName: 'nix-closure-measurements',
        artifactDir: nixClosureMeasurementsDir,
        baselineMaxRuns: 20,
        targets: nixClosureMeasurementTargets,
        buckets: defaultNixClosureMeasurementBuckets,
        compare: false,
        regressionMode: 'warn',
        prComment: {
          enabled: false,
          title: 'Nix Closure Measurements',
          maxRows: 8,
          maxHistory: 20,
        },
      }),
      nixDiagnosticsSummaryStep,
      nixDiagnosticsArtifactStep(),
      failureReminderStep,
    ],
  },
  // Checkout exemption: source-shape measures actions-checkout bytes only; it runs no devenv/Buck.
  'source-shape': {
    'runs-on': namespaceRunner({
      profile: 'namespace-profile-linux-x86-64',
      runId: '${{ github.run_id }}',
    }),
    'timeout-minutes': jobTimeoutMinutes,
    defaults: bashShellDefaults,
    permissions: { actions: 'read', contents: 'read' },
    env: ciMeasurementSubjectEnv,
    steps: [
      checkoutStep(),
      ciMeasurementBaselineCheckoutStep,
      sourceShapeMeasurementStep({
        artifactDir: `${sourceShapeMeasurementsDir}/current/effect-utils`,
        targetId: 'effect_utils',
        targetName: 'effect-utils',
        targetLabel: 'effect-utils repository',
        targetGroup: 'source',
        targetPath: ['source', 'effect-utils'],
        scopes: [
          {
            id: 'genie_ci_workflow',
            label: 'Genie CI workflow helpers',
            group: 'source / ci',
            path: ['source', 'effect-utils', 'genie', 'ci-workflow'],
            includePaths: ['genie/ci-workflow', '.github/workflows/ci.yml.genie.ts'],
            includeExtensions: ['.ts'],
          },
          {
            id: 'genie_runtime',
            label: 'Genie runtime',
            group: 'source / genie',
            path: ['source', 'effect-utils', 'packages', 'genie'],
            includePaths: ['packages/@overeng/genie/src'],
            includeExtensions: ['.ts', '.tsx'],
          },
          {
            id: 'nix_workspace_tools',
            label: 'Nix workspace tools',
            group: 'source / nix',
            path: ['source', 'effect-utils', 'nix', 'workspace-tools'],
            includePaths: ['nix/workspace-tools'],
            includeExtensions: ['.nix'],
          },
        ],
      }),
      ciMeasurementsArtifactStep({
        artifactName: 'source-shape',
        path: sourceShapeMeasurementsDir,
      }),
    ],
  },
  // Checkout exemption: report aggregation uses only Nix-provided tools and downloaded artifacts.
  'ci-measurements-report': {
    name: 'ci/measurements-report',
    if: measurementReportIf,
    needs: ['devenv-perf', 'nix-closure-sizes', 'source-shape'],
    'runs-on': namespaceRunner({
      profile: 'namespace-profile-linux-x86-64',
      runId: '${{ github.run_id }}',
    }),
    'timeout-minutes': jobTimeoutMinutes,
    defaults: bashShellDefaults,
    permissions: { actions: 'read', contents: 'read' },
    env: ciMeasurementSubjectEnv,
    steps: [
      checkoutStep(),
      installNixStep(),
      ciMeasurementReportToolStep,
      downloadCurrentMeasurementArtifactStep({
        artifactName: 'devenv-perf',
        outputDir: `${ciMeasurementReportDir}/current/devenv-perf`,
        producedBy: 'devenv-perf',
      }),
      downloadCurrentMeasurementArtifactStep({
        artifactName: 'nix-closure-measurements',
        outputDir: `${ciMeasurementReportDir}/current/nix-closure-measurements`,
      }),
      downloadCurrentMeasurementArtifactStep({
        artifactName: 'source-shape',
        outputDir: `${ciMeasurementReportDir}/current/source-shape`,
      }),
      downloadPreviousGitHubArtifactStep({
        artifactName: 'devenv-perf',
        outputDir: `${ciMeasurementReportDir}/baseline/devenv-perf`,
        // The paired lane's trend series now comes from explicit dispatches, so a
        // schedule scan would only consume candidates that cannot carry the artifact.
        candidateEvents: ['workflow_dispatch'],
        maxRuns: 20,
      }),
      downloadPreviousGitHubArtifactStep({
        artifactName: 'nix-closure-measurements',
        outputDir: `${ciMeasurementReportDir}/baseline/nix-closure-measurements`,
        maxRuns: 20,
      }),
      downloadPreviousGitHubArtifactStep({
        artifactName: 'source-shape',
        outputDir: `${ciMeasurementReportDir}/baseline/source-shape`,
        seedRuns: [
          {
            runId: '26085158592',
            label: 'main baseline',
            sha: 'ce7cf8f8ebfaa1da6c7e9122cd195a5f95ce2fca',
            source: 'manual-backfill',
            artifacts: ['source-shape'],
            notes:
              'Backfilled with the current measurement workflow for the effect-utils #658 rollout.',
          },
        ],
        maxRuns: 20,
      }),
      compareCiMeasurementsStep({
        currentDir: `${ciMeasurementReportDir}/current`,
        baselineDir: `${ciMeasurementReportDir}/baseline`,
        outputFile: `${ciMeasurementReportDir}/measurement-comparison.json`,
        regressionMode: 'warn',
        prComment: {
          enabled: true,
          title: 'CI Measurements',
          maxRows: 16,
          maxHistory: 20,
        },
      }),
      ciMeasurementsArtifactStep({
        artifactName: 'ci-measurements-report',
        path: ciMeasurementReportDir,
      }),
    ],
  },
  /** Integration tests for Notion API (requires package-specific Notion token secrets) */
  'test-integration-notion': {
    if: trustedSecretCiIf,
    'runs-on': namespaceRunner({
      profile: 'namespace-profile-linux-x86-64',
      runId: '${{ github.run_id }}',
    }),
    'timeout-minutes': 90,
    defaults: bashShellDefaults,
    env: standardCIEnv,
    steps: [
      ...baseSteps,
      {
        name: 'Notion integration tests',
        env: {
          NOTION_API_TOKEN: '${{ secrets.NOTION_API_TOKEN }}',
          NOTION_TEST_PARENT_PAGE_ID: '${{ secrets.NOTION_TEST_PARENT_PAGE_ID }}',
          NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID:
            '${{ secrets.NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID || secrets.NOTION_TEST_PARENT_PAGE_ID }}',
          NOTION_DATASOURCE_SYNC_E2E_LEDGER_PAGE_ID:
            '${{ secrets.NOTION_DATASOURCE_SYNC_E2E_LEDGER_PAGE_ID }}',
          NOTION_DATASOURCE_SYNC_DEMO_PAGE_ID:
            "${{ github.event_name == 'workflow_dispatch' && (inputs.run_datasource_sync_demo == true || inputs.run_datasource_sync_demo == 'true') && secrets.NOTION_DATASOURCE_SYNC_DEMO_PAGE_ID || '' }}",
        },
        run: runDevenvTasksBefore('test:notion-integration'),
      },
      nixDiagnosticsSummaryStep,
      nixDiagnosticsArtifactStep(),
      failureReminderStep,
    ],
  },
  /**
   * Integration tests for restate-effect against a native restate-server.
   * The server is provisioned via nix/restate.nix and resolved through
   * RESTATE_SERVER_BIN inside the devenv shell — no secrets required. Runs as a
   * dedicated, serialized lane (its own job) because the suite boots a real
   * server child process; the package's ts/lint/unit are already covered by the
   * aggregate jobs above.
   */
  'test-integration-restate': {
    if: normalCiIf,
    concurrency: {
      group:
        'test-integration-restate-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}',
      'cancel-in-progress': true,
    },
    'runs-on': namespaceRunner({
      profile: 'namespace-profile-linux-x86-64',
      runId: '${{ github.run_id }}',
    }),
    'timeout-minutes': 60,
    defaults: bashShellDefaults,
    env: standardCIEnv,
    steps: [
      ...baseSteps,
      {
        name: 'Restate integration tests',
        run: runDevenvTasksBefore('test:restate-integration'),
      },
      nixDiagnosticsSummaryStep,
      nixDiagnosticsArtifactStep(),
      failureReminderStep,
    ],
  },
  'test-live-deploy-ci-tools': {
    if: trustedSecretCiIf,
    concurrency: {
      group:
        'test-live-deploy-ci-tools-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}',
      'cancel-in-progress': true,
    },
    'runs-on': namespaceRunner({
      profile: 'namespace-profile-linux-x86-64',
      runId: '${{ github.run_id }}',
    }),
    'timeout-minutes': 30,
    defaults: bashShellDefaults,
    env: standardCIEnv,
    steps: [
      ...baseSteps,
      liveNetlifyCiToolsPreflightStep,
      liveVercelCiToolsPreflightStep,
      onlyWhenLiveNetlifyCiTools(liveNetlifyCiToolsE2EStep),
      onlyWhenLiveVercelCiTools(liveVercelCiToolsE2EStep),
      nixDiagnosticsSummaryStep,
      nixDiagnosticsArtifactStep(),
      failureReminderStep,
    ],
  },
}

const deployJobs: Record<string, any> = {
  'deploy-storybooks': {
    if: trustedSecretCiIf,
    'runs-on': namespaceRunner({
      profile: 'namespace-profile-linux-x86-64',
      runId: '${{ github.run_id }}',
    }),
    'timeout-minutes': jobTimeoutMinutes,
    // No `needs` — run in parallel with other jobs for faster feedback
    permissions: { contents: 'read' },
    defaults: bashShellDefaults,
    env: {
      ...standardCIEnv,
    },
    steps: [
      ...baseSteps,
      { ...netlifyDeployStep(), env: { NETLIFY_AUTH_TOKEN: '${{ secrets.NETLIFY_AUTH_TOKEN }}' } },
      workflowReportCollectorStep({
        workflowReportFlakeRef,
        bundleId: 'storybook-preview',
        inputPaths: [`\${{ steps.deploy.outputs.${deployPreviewWorkflowReportPathOutputName} }}`],
        outputPath: storybookPreviewBundlePath,
        allowMissingInput: true,
      }),
      workflowReportCommentBodyStep({
        workflowReportFlakeRef,
        bundlePath: storybookPreviewBundlePath,
        commentBodyPath: storybookPreviewCommentBodyPath,
        summaryPath: storybookPreviewSummaryPath,
        title: 'Storybook Previews',
        noRecordsMessage: 'No storybooks were deployed.',
        stateId: 'storybook-preview',
        entryId:
          "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}",
        entryLabel:
          "${{ github.event_name == 'pull_request' && format('PR {0}', github.event.pull_request.number) || 'prod' }}",
      }),
      workflowReportPublisherStep({
        workflowReportFlakeRef,
        commentBodyPath: storybookPreviewCommentBodyPath,
        summaryPath: storybookPreviewSummaryPath,
        stateId: 'storybook-preview',
      }),
      nixDiagnosticsSummaryStep,
      nixDiagnosticsArtifactStep(),
      failureReminderStep,
    ],
  },
} as const

const withEffectUtilsCompositionCleanup = (jobMap: Record<string, any>) =>
  Object.fromEntries(
    Object.entries(jobMap).map(([name, ciJob]) => {
      const steps = ciJob.steps as readonly any[] | undefined
      return [
        name,
        steps?.some((step) => step.name === prepareEffectUtilsCompositionStep.name) === true
          ? {
              ...ciJob,
              steps: [...steps, cleanupEffectUtilsCompositionStep],
            }
          : ciJob,
      ]
    }),
  )

// oxlint-disable-next-line overeng/exports-first -- generated entrypoint is assembled after its job atoms
export default ciWorkflow({
  name: 'CI',
  on: {
    push: { branches: ['main'] },
    pull_request: { types: ['opened', 'reopened', 'synchronize'] },
    // Nightly deterministic measurement snapshot of `main` (03:17 UTC):
    // `nix-closure-sizes`, `source-shape`, and `ci/measurements-report`.
    // Product lanes and the dispatch-only `devenv-perf` lane do not run.
    schedule: [{ cron: '17 3 * * *' }],
    workflow_dispatch: {
      inputs: {
        ...ciMeasurementBaselineWorkflowDispatchInputs,
        run_datasource_sync_demo: {
          description:
            'Run the credentialed notion-datasource-sync demo showcase in the Notion integration lane. Requires NOTION_DATASOURCE_SYNC_DEMO_PAGE_ID.',
          required: false,
          default: false,
          type: 'boolean',
        },
        debug_force_nix_diagnostics_failure: {
          description:
            'Temporary debug switch (#272): force post-validation failure to verify diagnostics artifact + summary',
          required: false,
          default: false,
          type: 'boolean',
        },
      },
    },
  },
  permissions: { contents: 'read' },
  jobs: withEffectUtilsCompositionCleanup({
    // Keep default-ref/source-policy separate from product checks: downstream
    // validation branches should fail one authority job, not obscure
    // lint/typecheck/test signal.
    // Checkout exemption: policy scans checkout authority files and never invokes devenv or Buck.
    'default-ref-policy': {
      // A cron carries no code change, so the source-policy scan has nothing to say.
      if: `\${{ ${notNightlyMeasurementIf} }}`,
      ...defaultRefPolicyCheckJob({
        // Keep this tiny policy job on the same Namespace runner class as the
        // rest of CI so source-policy enforcement does not wait on legacy labels.
        runsOn: namespaceRunner({
          profile: 'namespace-profile-linux-x86-64',
          runId: '${{ github.run_id }}',
        }),
        // LiveStore intentionally uses dev as its trunk branch.
        defaultRefs: { 'livestorejs/livestore': 'dev' },
      }),
    },
    ...jobs,
    ...extraJobs,
    ...deployJobs,
    'notify-alignment': {
      ...notifyAlignmentJob({
        targetRepo: 'schickling/megarepo-all',
        needs: [...Object.keys(jobs), ...Object.keys(deployJobs)],
        runner: [
          'namespace-profile-linux-x86-64',
          'namespace-features:github.run-id=${{ github.run_id }}',
        ],
      }),
    },
  }),
} satisfies GitHubWorkflowArgs)
