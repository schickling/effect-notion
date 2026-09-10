{ lib }:

rec {
  # Live devenv installs and fixed-output dependency preparation should agree
  # on the resource-sensitive pnpm knobs. Keep this list small: these flags
  # define install purity and Darwin pressure limits, while callers still own
  # their lockfile mode and store path.
  liveInstallPolicyFlags = [
    "--ignore-scripts"
    "--config.side-effects-cache=false"
    "--config.verify-store-integrity=true"
    "--config.strict-store-pkg-content-check=true"
    "--config.child-concurrency=1"
    "--config.network-concurrency=4"
    "--config.enable-global-virtual-store=false"
    "--config.virtual-store-dir=node_modules/.pnpm"
    "--pm-on-fail=ignore"
  ];

  # The fixed-output builder writes policy through .npmrc because pnpm
  # rejects some workspace-scoped keys via `pnpm config set --global`. The
  # prepared tree is restored directly by downstream builds. Live and prepared
  # installs therefore use the same root-local virtual topology.
  workspacePrepNpmrcLines = packageImportMethod: [
    "virtual-store-dir=node_modules/.pnpm"
    "package-import-method=${packageImportMethod}"
    "ignore-scripts=true"
    "side-effects-cache=false"
    "verify-store-integrity=true"
    "strict-store-pkg-content-check=true"
    "enable-global-virtual-store=false"
    "pm-on-fail=ignore"
    "manage-package-manager-versions=false"
    "verify-deps-before-run=false"
    "node-linker=isolated"
    "child-concurrency=1"
    "network-concurrency=4"
  ];

  workspacePrepNpmrc =
    packageImportMethod:
    lib.concatMapStrings (line: "${line}\n") (workspacePrepNpmrcLines packageImportMethod);

  # Before appending builder-local policy, strip equivalent user/workspace
  # settings. Otherwise absolute store paths or different linker settings can
  # leak from the source workspace into what should be a reusable prepared tree.
  npmrcPolicyKeys = [
    "store-dir"
    "virtual-store-dir"
    "enable-global-virtual-store"
    "global-virtual-store-dir"
    "state-dir"
    "cache-dir"
    "package-import-method"
    "node-linker"
    "ignore-scripts"
    "side-effects-cache"
    "side-effects-cache-readonly"
    "verify-store-integrity"
    "strict-store-pkg-content-check"
    "pm-on-fail"
    "manage-package-manager-versions"
    "verify-deps-before-run"
    "child-concurrency"
    "network-concurrency"
  ];

  # pnpm-workspace.yaml uses camelCase for the same policy surface that .npmrc
  # spells in kebab-case. Keep the scrub list beside npmrcPolicyKeys so adding
  # a new shared install knob updates both source surfaces together.
  workspaceYamlPolicyKeys = [
    "storeDir"
    "virtualStoreDir"
    "enableGlobalVirtualStore"
    "globalVirtualStoreDir"
    "stateDir"
    "cacheDir"
    "packageImportMethod"
    "nodeLinker"
    "optimisticRepeatInstall"
    "verifyDepsBeforeRun"
    "sideEffectsCache"
    "sideEffectsCacheReadonly"
    "verifyStoreIntegrity"
    "strictStorePkgContentCheck"
    "ignoreScripts"
    "pmOnFail"
    "managePackageManagerVersions"
    "childConcurrency"
    "networkConcurrency"
  ];

  # On Darwin, whole-workspace materialization can push pnpm's Node process into
  # kernel/libuv teardown failures after the install has already produced the
  # usable node_modules tree. The heap cap lowers that pressure without changing
  # the dependency artifact contract.
  darwinNodeOptionsShell = ''
    export NODE_OPTIONS="''${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=1536"
  '';

  # Accept only the Darwin teardown abort that has been observed and recovered
  # with the complete shared pnpm store. SIGKILL (137) is deliberately not
  # normalized: it provides no exact shared-index recovery evidence.
  darwinCompletedMaterializationCheckShell =
    {
      statusVar,
      logFileVar,
      isDarwinShell ? "1",
    }:
    let
      statusRef = "$" + statusVar;
      logFileRef = "$" + logFileVar;
    in
    ''[ "${statusRef}" -eq 134 ] && [ ${isDarwinShell} = "1" ] && grep -qE 'Progress: .* done$' "${logFileRef}" && [ -d node_modules/.pnpm ] && [ -f node_modules/.modules.yaml ]'';
}
