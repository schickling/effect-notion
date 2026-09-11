import { defaultRefPolicyCheckScript } from './default-ref-policy-script.ts'
import { shellSingleQuote } from './shared.ts'

/** Ephemeral per-job megarepo store path scoped to the CI run/attempt/job */
export const jobLocalMegarepoStore =
  '${{ runner.temp }}/megarepo-store/${{ github.run_id }}/${{ github.run_attempt }}/${{ github.job }}'

/**
 * Stable megarepo store path for consumers that cache the store (see {@link restoreMegarepoStoreStep}).
 *
 * GitHub derives an `actions/cache` *version* from the cache `path`, so a run-scoped path
 * (like {@link jobLocalMegarepoStore}) yields a new version every run and restores **never hit**;
 * each job also writes a duplicate. This stable runner-temp path keeps the version stable across
 * runs, so restores hit and GitHub's reserve dedups the concurrent saves. Safe: GitHub runs one job per (ephemeral) runner,
 * so `runner.temp` is already per-job; a persistent runner's sequential jobs just reuse the warm
 * store. Opt in via `applyMegarepoLockStep({ cacheableStore: true })`.
 */
export const cacheableMegarepoStore = '${{ runner.temp }}/megarepo-store'

/**
 * `actions/cache` key for the megarepo store, keyed on the consumer's root `megarepo.lock` and
 * **partitioned by the skip set**. Jobs that skip different members produce different store
 * contents; without partitioning they collide on one key, so a partial store (from a skipping
 * job) would be restored by a full job that then re-clones the omitted member — and, because the
 * exact restore reports `cache-hit=true`, never republishes the enriched store, re-cloning every
 * run. Pass the SAME `skip` here as to {@link applyMegarepoLockStep}.
 */
const megarepoStoreCacheKey = (skip?: readonly string[]): string => {
  const scope =
    skip === undefined || skip.length === 0
      ? 'full'
      : `skip-${[...skip]
          .toSorted()
          .join('.')
          .replace(/[^a-zA-Z0-9._-]/g, '_')}`
  // Concatenate (not a template literal) so the GitHub `${{ … }}` expressions stay literal.
  return 'megarepo-store-v1-${{ runner.os }}-' + scope + "-${{ hashFiles('megarepo.lock') }}"
}

/**
 * Restore the {@link cacheableMegarepoStore} BEFORE the sync step (use with
 * `applyMegarepoLockStep({ cacheableStore: true })`). On a hit `mr apply` finds the pinned member
 * commits already present and no-ops instead of cold-cloning large members from GitHub. Pass the
 * same `skip` as the sync step so the cache identity matches the store contents. Pairs with
 * {@link saveMegarepoStoreStep}. A restored store re-applies cleanly (git/mr reuse the bares).
 */
export const restoreMegarepoStoreStep = (opts?: { skip?: readonly string[] }) => ({
  name: 'Restore megarepo store',
  id: 'restore-megarepo-store',
  uses: 'actions/cache/restore@v4',
  with: { path: cacheableMegarepoStore, key: megarepoStoreCacheKey(opts?.skip) },
})

/**
 * Save the {@link cacheableMegarepoStore} AFTER the sync step, guarded on a cold restore. Pass the
 * same `skip` as {@link restoreMegarepoStoreStep} / {@link applyMegarepoLockStep}.
 */
export const saveMegarepoStoreStep = (opts?: { skip?: readonly string[] }) => ({
  name: 'Save megarepo store',
  if: "${{ success() && steps.restore-megarepo-store.outputs.cache-hit != 'true' }}",
  uses: 'actions/cache/save@v4',
  with: { path: cacheableMegarepoStore, key: megarepoStoreCacheKey(opts?.skip) },
})

const appendGitHubPathLine = (valueExpression: string) =>
  `printf '%s\\n' ${valueExpression} >> "$GITHUB_PATH"`

const appendGitHubEnvLine = ({
  name,
  valueExpression,
}: {
  name: string
  valueExpression: string
}) => `printf '${name}=%s\\n' ${valueExpression} >> "$GITHUB_ENV"`

/**
 * Install the megarepo CLI into a job-local bin directory.
 *
 * Uses the effect-utils commit from megarepo.lock when available so setup-time
 * `mr` has the same CLI contract as the shared task module used later by
 * devenv. This avoids stale self-hosted runner profile state shadowing the
 * pinned package.
 */
export const installMegarepoStep = {
  name: 'Install megarepo CLI',
  run: `EU_REV=$(jq -r '.members["effect-utils"].commit // empty' megarepo.lock 2>/dev/null || true)
if [ -n "$EU_REV" ]; then
  MR_REF="github:overengineeringstudio/effect-utils/$EU_REV#megarepo"
else
  MR_REF="github:overengineeringstudio/effect-utils#megarepo"
fi

MR_OUT=$(nix build --no-link --print-out-paths "$MR_REF")
MR_BIN_DIR="\${RUNNER_TEMP:-/tmp}/megarepo-bin"
mkdir -p "$MR_BIN_DIR"
ln -sf "$MR_OUT/bin/mr" "$MR_BIN_DIR/mr"
if [ -n "\${GITHUB_PATH:-}" ]; then
  ${appendGitHubPathLine('"$MR_BIN_DIR"')}
else
  export PATH="$MR_BIN_DIR:$PATH"
fi
"$MR_BIN_DIR/mr" --version`,
  shell: 'bash',
} as const

/** Fetch latest refs and apply megarepo workspace. */
export const syncMegarepoWorkspaceStep = (opts?: { skip?: string[] }) => {
  const args = ['mr', 'fetch', '--apply']
  const skipCsv = opts?.skip?.join(',')
  if (skipCsv !== undefined && skipCsv !== '') args.push('--skip', shellSingleQuote(skipCsv))
  return {
    name: 'Sync megarepo dependencies',
    env: { MEGAREPO_STORE: jobLocalMegarepoStore },
    run: `mkdir -p "$MEGAREPO_STORE"
echo "Using job-local megarepo store: $MEGAREPO_STORE"
if [ -n "${'${GITHUB_ENV:-}'}" ]; then
  ${appendGitHubEnvLine({ name: 'MEGAREPO_STORE', valueExpression: '"$MEGAREPO_STORE"' })}
fi
${args.join(' ')}`,
    shell: 'bash',
  }
}

/**
 * Sync megarepo state using the locked effect-utils commit from megarepo.lock.
 * CI must use `apply --all` so the workspace stays on the checked-in lock
 * shape instead of silently drifting to newer branch heads during job setup.
 * Resolves the CLI inline with `nix run` to avoid `nix profile install`
 * conflicts on self-hosted runners.
 */
export const applyMegarepoLockStep = (opts?: { skip?: string[]; cacheableStore?: boolean }) => {
  const megarepoStore =
    opts?.cacheableStore === true ? cacheableMegarepoStore : jobLocalMegarepoStore
  const skipCsv = opts?.skip?.join(',') ?? ''
  const skipArgs = skipCsv === '' ? '' : `--skip ${shellSingleQuote(skipCsv)}`
  const quotedSkipCsv = shellSingleQuote(skipCsv)
  const exportSkipMembersScript =
    skipCsv === ''
      ? ''
      : `if [ -n "${'${GITHUB_ENV:-}'}" ]; then
  ${appendGitHubEnvLine({ name: 'MEGAREPO_SKIP_MEMBERS', valueExpression: quotedSkipCsv })}
fi`
  return {
    name: 'Sync megarepo dependencies',
    env: { MEGAREPO_STORE: megarepoStore },
    run: `EU_REV=$(jq -r '.members["effect-utils"].commit' megarepo.lock)
if [ -z "$EU_REV" ] || [ "$EU_REV" = "null" ]; then
  echo '::error::megarepo.lock missing members["effect-utils"].commit'
  exit 1
fi
mkdir -p "$MEGAREPO_STORE"
echo "Using job-local megarepo store: $MEGAREPO_STORE"
if [ -n "${'${GITHUB_ENV:-}'}" ]; then
  ${appendGitHubEnvLine({ name: 'MEGAREPO_STORE', valueExpression: '"$MEGAREPO_STORE"' })}
fi
${exportSkipMembersScript}
nix run "github:overengineeringstudio/effect-utils/$EU_REV#megarepo" -- apply --all${skipArgs !== '' ? ` ${skipArgs}` : ''}`,
    shell: 'bash',
  }
}

export type DefaultRefPolicyCheckStepOptions = {
  readonly firstPartyOwners?: readonly string[]
  readonly defaultRef?: string
  readonly defaultRefs?: Readonly<Record<string, string>>
  readonly verifyReachable?: boolean
  readonly normalizeGitBranchRefs?: boolean
  /**
   * Permit an explicitly named `*-legacy` megarepo member to use an immutable
   * 40- or 64-character commit ref. This is intentionally narrower than a
   * general ref allowlist: branch refs and non-legacy members still fail.
   */
  readonly allowLegacyMemberCommitRefs?: boolean
}

/** Fail before composition when first-party megarepo/flake/devenv inputs target non-default refs. */
export const defaultRefPolicyCheckStep = (opts: DefaultRefPolicyCheckStepOptions = {}) => ({
  name: 'Check first-party default refs',
  env: {
    FIRST_PARTY_OWNERS_JSON: JSON.stringify(
      opts.firstPartyOwners ?? ['schickling', 'overengineeringstudio'],
    ),
    DEFAULT_REF: opts.defaultRef ?? 'main',
    DEFAULT_REFS_JSON: JSON.stringify(opts.defaultRefs ?? {}),
    VERIFY_REACHABLE: opts.verifyReachable === true ? '1' : '0',
    NORMALIZE_GIT_BRANCH_REFS: opts.normalizeGitBranchRefs === true ? '1' : '0',
    ALLOW_LEGACY_MEMBER_COMMIT_REFS: opts.allowLegacyMemberCommitRefs === true ? '1' : '0',
  },
  run: `nix shell nixpkgs#nodejs_24 -c node <<'NODE'
${defaultRefPolicyCheckScript}
NODE`,
  shell: 'bash',
})
