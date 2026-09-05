import {
  RUNNER_PROFILES,
  type RunnerProfile,
  bashShellDefaults,
  buck2CapacityEvidenceArtifactStep,
  buck2SharedCacheLaneStep,
  buck2SharedCachePreflightStep,
  buck2SharedCacheProvenanceArtifactStep,
  cachixCliBuildStep,
  cachixStep,
  checkoutStep,
  cleanupEffectUtilsCompositionStep,
  prepareCiScriptsStep,
  prepareEffectUtilsCompositionStep,
  notifyAlignmentJob,
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
  nixDiagnosticsArtifactStep,
  workflowReportCommentBodyStep,
  workflowReportCollectorStep,
  workflowReportPublisherStep,
  deployPreviewWorkflowReportPathOutputName,
  netlifyDeployStep,
  validateNixStoreStep,
  withCiSourceRoot,
  defaultRefPolicyCheckJob,
  tailnetEphemeralConnectStep,
  tailnetEphemeralDisconnectStep,
} from '../../genie/ci-workflow.ts'
import { type CoreCIJobName, perfLaneLabel } from '../../genie/ci.ts'
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

/** Execute only the Buck binary belonging to the prepared composition. */
const runBuck2 = (...args: readonly string[]) =>
  [
    'workspace="${EFFECT_UTILS_WORKSPACE_ROOT:?EFFECT_UTILS_WORKSPACE_ROOT not set}"',
    'buck2="$workspace/.megarepo/bin/buck2"',
    'test -x "$buck2"',
    `cd "$workspace" && "$buck2" ${args.join(' ')}`,
  ].join('\n')
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
  name: 'Live Netlify ci-tools Buck E2E',
  shell: 'bash',
  env: {
    CI_TOOLS_NETLIFY_LIVE: '1',
    NETLIFY_AUTH_TOKEN: '${{ secrets.NETLIFY_AUTH_TOKEN }}',
    NETLIFY_SITE_ID: '${{ secrets.NETLIFY_SITE_ID }}',
  },
  run: runBuck2(
    'test',
    'effect_utils//packages/@overeng/ci-tools:test_netlify_live',
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
  name: 'Live Vercel ci-tools Buck E2E',
  shell: 'bash',
  env: {
    CI_TOOLS_VERCEL_LIVE: '1',
    VERCEL_TOKEN: '${{ secrets.VERCEL_TOKEN }}',
    VERCEL_PROJECT_ID: '${{ secrets.VERCEL_PROJECT_ID }}',
    VERCEL_ORG_ID: '${{ secrets.VERCEL_ORG_ID }}',
    VERCEL_SCOPE: '${{ secrets.VERCEL_SCOPE }}',
  },
  run: runBuck2(
    'test',
    'effect_utils//packages/@overeng/ci-tools:test_vercel_live',
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
 * The `labeled` pull-request activity type exists only so `ci:perf` can opt one pull
 * request into the paired wall-clock lane. It does not change the commit under test, so
 * every other lane ignores it — a label must never re-run product CI or duplicate a
 * measurement artifact for a SHA that was already measured.
 */
const notPerfLabelEventIf =
  "!(github.event_name == 'pull_request' && github.event.action == 'labeled')"

/**
 * `schedule` exists only for the nightly measurement snapshot of `main`: the paired
 * `devenv-perf` lane, the two deterministic measurement lanes, and the aggregate report.
 * Product lanes carry this guard so a cron never re-runs the product matrix.
 */
const notNightlyMeasurementIf = "github.event_name != 'schedule'"

const normalCiIf = `\${{ (${ciMeasurementNotBaselineBackfillPredicate}) && ${notNightlyMeasurementIf} && ${notPerfLabelEventIf} }}`
const trustedSecretCiIf = `\${{ (${ciMeasurementNotBaselineBackfillPredicate}) && github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch') }}`

/** Deterministic measurement lanes: like `normalCiIf`, but they also feed the nightly snapshot. */
const measurementLaneIf = `\${{ (${ciMeasurementNotBaselineBackfillPredicate}) && ${notPerfLabelEventIf} }}`

/**
 * `source-shape` also produces the subject artifact for a measurement baseline backfill,
 * so unlike the other measurement lanes it keeps the backfill dispatch path.
 */
const sourceShapeLaneIf = `\${{ ${notPerfLabelEventIf} }}`

/**
 * The paired wall-clock lane. Nightly trend telemetry on `main`, an operator dispatch
 * (including a measurement baseline backfill), or a pull request that carries `ci:perf`.
 * Deliberately not on every push: 35 advisory minutes per run bought nothing that a
 * targeted per-admission probe plus a daily trend series does not.
 */
const devenvPerfLaneIf = `\${{ github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' || (github.event_name == 'pull_request' && contains(github.event.pull_request.labels.*.name, '${perfLaneLabel}')) }}`

/**
 * The report aggregates whichever measurement lanes ran on `main`: all three nightly, the
 * two deterministic ones on a push. A skipped `devenv-perf` must not skip the report, so
 * the condition inspects `needs` results instead of relying on implicit success.
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


/**
 * Audit the native npm dependency policy against the lockfile (issue #807).
 * Install-free: depends only on `pnpm-lock.yaml` and the genie policy source.
 */
const nativeDepPolicyAuditStep = {
  name: 'Audit native dependency policy',
  shell: 'bash',
  run: withCiSourceRoot(
    'nix run nixpkgs#bun -- genie/ci-scripts/native-dep-policy-audit.ts',
  ),
} as const

// Core product jobs keyed by the shared Genie CI source of truth.
const jobs = {
  typecheck: job({
    step: {
      name: 'Type check Buck package products',
      run: runBuck2('build', "'filter(\":typecheck$\", effect_utils//...)'"),
    },
    extraSteps: [verifyOtelShellEntryStep],
  }),
  lint: job({
    step: {
      name: 'Generated freshness + format + lint',
      run: runDevenvTasksBefore('lint:check'),
    },
  }),
  test: multiPlatformJob({
    name: 'Sandbox admission and Buck unit tests',
    run: runDevenvTasksBefore('buck2:sandbox-gate:fresh', 'test:run'),
  }),
  'test-megarepo-cold-gc': job({
    step: {
      name: 'Megarepo cold-GC Buck test',
      run: runBuck2(
        'test',
        'effect_utils//packages/@overeng/megarepo:test_megarepo_cold_gc',
      ),
    },
  }),
  'pnpm-regression': job({
    step: {
      name: 'Install-free lock maintenance validation',
      run: runDevenvTasksBefore('pnpm:check-lockfile'),
    },
    extraSteps: [nativeDepPolicyAuditStep],
  }),
  'bundle-smoke': job({
    step: {
      name: 'Buck candidate and pty-effect bundle smoke tests',
      run: runBuck2(
        'test',
        "'filter(\"candidate-smoke$\", effect_utils//packages/@overeng/...)' effect_utils//packages/@overeng/pty-effect:bundle_smoke_candidate",
      ),
    },
  }),
  buck2: job({
    step: {
      name: 'Buck2 toolchain surface and Nix bridge',
      run: runDevenvTasksBefore('buck2:check'),
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
} satisfies Record<CoreCIJobName, unknown>

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
    ...(producedBy === undefined
      ? {}
      : { if: `\${{ needs.${producedBy}.result == 'success' }}` }),
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
    description: 'the packaged Genie CLI closure',
    system: 'x86_64-linux',
  },
  {
    installable: '.#megarepo',
    id: 'megarepo_package',
    name: 'megarepo',
    label: 'Megarepo package',
    group: 'packages',
    path: ['nix', 'closures', 'packages', 'megarepo'],
    description: 'the packaged megarepo CLI closure',
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

// =============================================================================
// Shared-Buck-cache evidence lane (03-materialization DQ1)
// =============================================================================
//
// Three jobs, because the question has three independent legs and one job cannot
// answer them:
//
//   buck2-cache-publish  builds the COMPLETE candidate graph against the named candidate
//                        instance, then creates exactly ONE dispatch-unique probe action
//                        from a run-id/run-attempt nonce and requires that probe to
//                        execute locally AND upload. The graph build itself asserts no
//                        local work: a graph that is already cached is a correct state,
//                        and requiring fresh local work there would make the lane fail
//                        on every dispatch after the first.
//   buck2-cache-restore  lands on a DIFFERENT ephemeral runner with an empty buck-out
//                        and a different absolute composition prefix (the prepare script
//                        keys `store_root` on `${GITHUB_JOB}`), so it doubles as the
//                        REUSE-R02 relocation clause. It restores the complete candidate
//                        graph with ZERO local commands, then reproduces the SAME
//                        dispatch-unique probe and requires it to be a pure cache hit:
//                        that hit is the cross-job transfer proof. A second, distinct
//                        nonce then proves a genuinely NEW miss uploads and comes back.
//   buck2-cache-outage   composes with the remote cache DISABLED and enables the
//                        unroutable endpoint only for the one step whose failure is the
//                        assertion, so the leg observes Buck refusing to proceed instead
//                        of dying in the composition overlay.
//
// Cache identity reaches Buck only through buckconfig FILES: the generated root
// buckconfig written by `compositionCacheSections` during the composition overlay, and —
// for the outage step alone — a root `.buckconfig.local` the lane writes and removes.
// `-c buck2_re_client.*` is NOT an option: CLI overrides never reach the RE client.

/**
 * Explicitly named candidate instance. It is a generator constant, not an input, so no
 * dispatch or repository variable can point this lane at the production namespace.
 *
 * This buys attribution, NOT isolation. One unmangled cache server is shared with the
 * trusted CI lane: CAS bytes are digest-verified and cannot be forged by another writer,
 * while the ActionCache mapping is mutable and last-writer-wins. What the name gives is
 * "this lane writes no production-namespace action keys", never "this lane cannot read or
 * be affected by production bytes" (REUSE-R06).
 */
const buck2CacheCandidateInstance = 'effect-utils-dq1-candidate'

/** Endpoint is repository configuration. No tailnet host or port is committed here. */
const buck2CacheEndpointExpression = '${{ vars.BUCK2_CACHE_ENDPOINT }}'

/**
 * RFC 2606 reserves `.invalid`, so this endpoint can never resolve to a real cache and
 * the outage leg cannot accidentally pass by reaching something. It names no real host.
 */
const buck2CacheOutageEndpoint = 'grpc://buck2-cache-outage.invalid:1'

/**
 * The complete Buck candidate graph reaches the lane as the generated
 * `genie/ci-scripts/buck2-candidate-graph.txt` (127 labels: 39 typecheck, 38 dist,
 * 38 editor_view_inputs, 10 products, 2 support tools), read from the COMPOSED member so
 * the graph under proof always belongs to the revision being built.
 */
const buck2CandidateGraphFile = 'genie/ci-scripts/buck2-candidate-graph.txt'

/**
 * Nonce carrier for both probes: the smallest declared candidate closure in the manifest.
 * A probe appends a nonce comment, builds the one label, and reverts the file.
 */
const buck2CacheNonceCarrier = 'packages/@overeng/oxc-config/src/mod.ts'
const buck2CacheNonceLabel = 'effect_utils//packages/@overeng/oxc-config:oxc-config-candidate'

/**
 * ONE dispatch-stable nonce shared by publish and restore. Stable so both jobs derive the
 * same action key, and unique per dispatch (run id plus attempt) so publish always has
 * exactly one new action to execute and upload without depending on cache state.
 */
const buck2CacheProbeNonce = '${{ github.run_id }}-${{ github.run_attempt }}'

/**
 * The independent miss leg needs a nonce the transfer probe has never published, or its
 * "miss" would just be the probe's hit. The script refuses the two being equal.
 */
const buck2CacheMissNonce = 'miss-${{ github.run_id }}-${{ github.run_attempt }}'

/**
 * Operator-dispatched only, and dispatchable on any branch of THIS repository.
 *
 * `workflow_dispatch` is itself the authorization boundary: triggering it requires write
 * access and a ref that exists in this repository, so a fork can never reach it and no
 * fork-controlled code ever mints a tailnet-capable OIDC token. Restricting the lane to
 * `refs/heads/main` on top of that would be circular — DQ1 has to pass BEFORE the change
 * that carries the lane can merge, and a main-only guard makes the lane unrunnable until
 * after the thing it gates has already landed. `push`, `pull_request`, and `schedule` are
 * deliberately absent, so the lane still never runs on a pull request or on every commit.
 */
const buck2CacheLaneIf = `\${{ github.event_name == 'workflow_dispatch' && (inputs.run_buck2_cache_probe == true || inputs.run_buck2_cache_probe == 'true') }}`
const buck2CapacityLaneIf = `\${{ github.event_name == 'workflow_dispatch' && (inputs.run_buck2_capacity_probe == true || inputs.run_buck2_capacity_probe == 'true') }}`
const buck2CapacityRunnerProfile: RunnerProfile = 'namespace-profile-linux-x86-64'
const buck2CapacityTimeoutMinutes = 240
const buck2CapacityJobConcurrency = 1
const buck2CapacityLaneEnv = {
  ...standardCIEnv,
  BUCK2_CAPACITY_RUNNER_PROFILE: buck2CapacityRunnerProfile,
  BUCK2_CAPACITY_TIMEOUT_MINUTES: String(buck2CapacityTimeoutMinutes),
  BUCK2_CAPACITY_JOB_CONCURRENCY: String(buck2CapacityJobConcurrency),
}

/**
 * The only place in this repository that clears the CI-wide `BUCK2_NO_REMOTE_CACHE=1`.
 * The endpoint and the instance name are always supplied together; `mr apply` refuses
 * half a pair rather than defaulting the other half.
 *
 * The provenance directory is deliberately NOT set here. Job-level `env` cannot read the
 * `runner` context, so `${{ runner.temp }}` would not expand; the lane script defaults to
 * `$RUNNER_TEMP/buck2-cache-provenance`, which is the same directory
 * `buck2SharedCacheProvenanceDir` names for the upload step, where the context IS legal.
 */
const buck2CacheLaneEnv = (endpoint: string) => ({
  ...standardCIEnv,
  BUCK2_NO_REMOTE_CACHE: '',
  BUCK2_CACHE_ENDPOINT: endpoint,
  BUCK2_CACHE_INSTANCE_NAME: buck2CacheCandidateInstance,
})

/**
 * Outage leg job env: the repo-wide disable STAYS on, so the composition overlay runs
 * pure-local and cannot fail against the unroutable endpoint. The endpoint is supplied by
 * the assertion step alone.
 */
const buck2CacheOutageJobEnv = {
  ...standardCIEnv,
  BUCK2_CACHE_INSTANCE_NAME: buck2CacheCandidateInstance,
}

/**
 * Non-secret federated-identity configuration. The client id and audience identify the
 * Tailscale federated identity that trusts this repository's GitHub OIDC issuer; the
 * credential itself is the per-job OIDC token, which never exists at rest.
 */
const tailscaleFederatedClientIdExpression = '${{ vars.TS_FEDERATED_CLIENT_ID }}'
const tailscaleFederatedAudienceExpression = '${{ vars.TS_FEDERATED_AUDIENCE }}'

const buck2CacheLaneJob = ({
  env,
  tailnet,
  timeoutMinutes,
  laneSteps,
  needs,
  condition = buck2CacheLaneIf,
  runnerProfile = 'namespace-profile-linux-x86-64',
}: {
  readonly env: Record<string, string>
  readonly tailnet: boolean
  readonly timeoutMinutes: number
  readonly laneSteps: readonly Record<string, unknown>[]
  readonly needs?: readonly string[]
  readonly condition?: string
  readonly runnerProfile?: RunnerProfile
}) => ({
  if: condition,
  ...(needs === undefined ? {} : { needs: [...needs] }),
  'runs-on': namespaceRunner({
    profile: runnerProfile,
    runId: '${{ github.run_id }}',
  }),
  'timeout-minutes': timeoutMinutes,
  defaults: bashShellDefaults,
  // `id-token: write` is granted per job and only where it is actually spent: minting the
  // GitHub OIDC token that authenticates the tailnet join. The outage leg never joins the
  // tailnet, so it stays read-only.
  permissions: tailnet
    ? ({ contents: 'read', 'id-token': 'write' } as const)
    : ({ contents: 'read' } as const),
  env,
  steps: [
    checkoutStep(),
    installNixStep(),
    // Route first: the composition overlay's first Buck invocation already needs the
    // cache reachable, and the preflight has to fail before that config is written.
    ...(tailnet
      ? [
          tailnetEphemeralConnectStep({
            clientId: tailscaleFederatedClientIdExpression,
            audience: tailscaleFederatedAudienceExpression,
            tags: 'tag:ci-buck2-cache',
          }),
          buck2SharedCachePreflightStep,
        ]
      : []),
    prepareEffectUtilsCompositionStep,
    cachixCliBuildStep,
    trustedCachixStep,
    ...laneSteps,
    ...(tailnet ? [tailnetEphemeralDisconnectStep] : []),
    failureReminderStep,
  ],
})

// Non-core jobs are kept outside the typed product-job block but still tracked
// in genie/ci.ts for required-check policy.
const extraJobs: Record<string, any> = {
  // Empirical install-free authority: build the declared Buck Genie product,
  // run its bootstrap phase in a no-node_modules committed tree, then use the
  // same product to check lock-derived projections without pnpm or registry IO.
  'bootstrap-cold-proof': job({
    step: {
      name: 'Bootstrap cold-proof (R32)',
      run: [
        'BUN="$("${DEVENV_BIN:?DEVENV_BIN not set}" shell --no-reload -- printenv DEVENV_PROFILE)/bin/bun"',
        'export BUN',
        runDevenvTasksBefore('bootstrap:cold-proof'),
      ].join('\n'),
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
          task: 'genie:run',
          label: 'Buck Genie product generation',
          group: 'genie',
          description: 'Runs generation through the declared Buck Genie candidate product.',
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
          label: 'Buck Genie product freshness',
          group: 'genie',
          description: 'Checks generated files through the declared Buck Genie candidate product.',
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
    if: sourceShapeLaneIf,
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
        // The paired lane's trend series is the nightly `schedule` run, so a `push` scan
        // would burn its whole candidate budget on runs that never carried the artifact.
        candidateEvents: ['schedule'],
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
  'buck2-cache-publish': buck2CacheLaneJob({
    env: buck2CacheLaneEnv(buck2CacheEndpointExpression),
    tailnet: true,
    timeoutMinutes: 90,
    laneSteps: [
      buck2SharedCacheLaneStep({
        name: 'Populate the candidate cache instance',
        mode: 'publish',
        args: [buck2CandidateGraphFile, buck2CacheNonceCarrier, buck2CacheNonceLabel],
        env: { BUCK2_CACHE_NONCE: buck2CacheProbeNonce },
      }),
      buck2SharedCacheProvenanceArtifactStep,
    ],
  }),
  'buck2-cache-restore': buck2CacheLaneJob({
    env: buck2CacheLaneEnv(buck2CacheEndpointExpression),
    tailnet: true,
    timeoutMinutes: 90,
    needs: ['buck2-cache-publish'],
    laneSteps: [
      buck2SharedCacheLaneStep({
        name: 'Restore the complete candidate graph and the published probe',
        mode: 'restore',
        args: [buck2CandidateGraphFile, buck2CacheNonceCarrier, buck2CacheNonceLabel],
        env: { BUCK2_CACHE_NONCE: buck2CacheProbeNonce },
      }),
      buck2SharedCacheLaneStep({
        name: 'Upload and restore a deliberate miss',
        mode: 'miss',
        args: [buck2CacheNonceCarrier, buck2CacheNonceLabel],
        env: { BUCK2_CACHE_MISS_NONCE: buck2CacheMissNonce },
      }),
      buck2SharedCacheProvenanceArtifactStep,
    ],
  }),
  'buck2-cache-outage': buck2CacheLaneJob({
    // The job composes with the repo-wide `BUCK2_NO_REMOTE_CACHE=1` still in force, so
    // the overlay never talks to the unroutable endpoint; only the assertion step below
    // clears it and supplies the endpoint.
    env: buck2CacheOutageJobEnv,
    // No tailnet and no preflight on purpose: the preflight would short-circuit before
    // Buck ever ran, and this leg exists to observe Buck itself refusing to proceed.
    tailnet: false,
    timeoutMinutes: 30,
    laneSteps: [
      buck2SharedCacheLaneStep({
        name: 'Assert a hard failure against an unreachable cache',
        mode: 'outage',
        args: [buck2CacheNonceLabel],
        env: {
          BUCK2_NO_REMOTE_CACHE: '',
          BUCK2_CACHE_ENDPOINT: buck2CacheOutageEndpoint,
        },
      }),
    ],
  }),
  'buck2-capacity': buck2CacheLaneJob({
    condition: buck2CapacityLaneIf,
    env: buck2CapacityLaneEnv,
    runnerProfile: buck2CapacityRunnerProfile,
    tailnet: false,
    timeoutMinutes: buck2CapacityTimeoutMinutes,
    laneSteps: [
      buck2SharedCacheLaneStep({
        name: 'Measure cache-disabled Buck2 candidate capacity',
        mode: 'capacity',
        args: [buck2CandidateGraphFile],
      }),
      buck2CapacityEvidenceArtifactStep,
    ],
  }),
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
    // `labeled` is present only so applying `ci:perf` materializes the paired
    // wall-clock lane for a pull request that is already open; every other lane
    // guards against label events because they do not change the commit under test.
    pull_request: { types: ['opened', 'reopened', 'synchronize', 'labeled'] },
    // Nightly measurement snapshot of `main` (03:17 UTC): the paired `devenv-perf`
    // lane, the two deterministic measurement lanes, and `ci/measurements-report`.
    // This is the trend series the report compares against, and the only cadence on
    // which the 35-minute paired lane is paid.
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
        run_buck2_cache_probe: {
          description:
            'Run the opt-in shared-Buck-cache probe lanes (03-materialization DQ1): publish, restore + deliberate miss, and the fail-closed outage leg. Requires vars.BUCK2_CACHE_ENDPOINT plus the vars.TS_FEDERATED_CLIENT_ID / vars.TS_FEDERATED_AUDIENCE tailnet federated identity (no Tailscale secret exists); the outage leg deliberately fails its Buck build and still reports success.',
          required: false,
          default: false,
          type: 'boolean',
        },
        run_buck2_capacity_probe: {
          description:
            'Run the opt-in cache-disabled DQ4 capacity probe on the Namespace Linux x86_64 candidate runner. Emits measurements only; it applies no pass thresholds.',
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
