# pnpm lock maintenance tasks
#
# The authoritative pnpm-lock.yaml remains developer-maintained, while runtime
# dependency realization belongs to Buck. The old live node_modules tasks are
# available only through enableLegacyInstall for downstream migrations.
#
# Provides by default:
# - pnpm:check-lockfile
# - pnpm:update
# - pnpm:dedupe
# - pnpm:reset-lock-files
{
  packages,
  workspaceRoot ? ".",
  taskNamePrefix ? "pnpm",
  taskSuffix ? null,
  globalCache ? true,
  frozenInCi ? true,
  installFlags ? [ ],
  # The live root node_modules realization is retired by default. Downstream
  # repositories that have not admitted their consumers to Buck must opt in.
  enableLegacyInstall ? false,
  legacyAmbientPnpm ? false,
  # Canonical package-source directories consumed from outside this
  # Materialization Root. Each path is staged once under root-owned `.devenv`
  # state before pnpm realizes Package Instances from it.
  sourceInputPaths ? [ ],
  preInstall ? "",
  postInstallProjection ? "",
  installAfter ? [ ],
  updateAfter ? [ ],
  dedupeAfter ? [ ],
  cleanAfter ? [ ],
  resetLockFilesAfter ? [ ],
  # Explicit package-manager and generated-file CLI products.
  #
  # `mkPnpmPkg` is a *constructor* (`{ pkgs }: derivation`), not a built
  # derivation. Callers are devenv modules whose own `pkgs` is only available
  # through `_module.args`; building the package in the caller's `let` and
  # passing the derivation would force `_module.args.pkgs` while devenv is
  # still collecting module `imports`, which is an evaluation recursion.
  # Passing the constructor keeps the pinned package construction inside this
  # module, where it is applied to this module's own `pkgs` lazily.
  mkPnpmPkg ? null,
  geniePkg ? null,
  # Dedicated binary allowed to rewrite pnpm-lock.yaml.
  pnpmLockMutatorPkg ? null,
}:
{
  lib,
  config,
  pkgs,
  ...
}:
let
  trace = import ../lib/trace.nix { inherit lib; };
  cliGuard = import ../lib/cli-guard.nix { inherit pkgs; };
  # Applied with this module's own `pkgs`; only forced when `packages` is
  # evaluated, never while the enclosing module list is being collected.
  pnpmPkg = if mkPnpmPkg == null then null else mkPnpmPkg { inherit pkgs; };
  cache = import ../lib/cache.nix { inherit config; };
  workspaceCacheName =
    if workspaceRoot == "." then
      "root"
    else
      builtins.replaceStrings [ "/" "." ] [ "-" "_" ] workspaceRoot;
  cacheRoot =
    if workspaceRoot == "." then
      cache.mkCachePath "pnpm-install"
    else
      cache.mkCachePath "pnpm-install/${workspaceCacheName}";
  workspaceRootAbs =
    if workspaceRoot == "." then config.devenv.root else "${config.devenv.root}/${workspaceRoot}";
  defaultPnpmHome =
    if workspaceRoot == "." then
      "${config.devenv.root}/.devenv/pnpm-home"
    else
      "${config.devenv.root}/.devenv/pnpm-home/${workspaceCacheName}";
  jobLocalPnpmStoreDir =
    if workspaceRoot == "." then
      "${config.devenv.root}/.devenv/pnpm-store-pure-v1"
    else
      "${config.devenv.root}/.devenv/pnpm-store-pure-v1/${workspaceCacheName}";
  installTaskName =
    if taskSuffix == null then
      "${taskNamePrefix}:install"
    else
      "${taskNamePrefix}:install:${taskSuffix}";
  updateTaskName =
    if taskSuffix == null then "${taskNamePrefix}:update" else "${taskNamePrefix}:update:${taskSuffix}";
  dedupeTaskName =
    if taskSuffix == null then "${taskNamePrefix}:dedupe" else "${taskNamePrefix}:dedupe:${taskSuffix}";
  checkLockTaskName =
    if taskSuffix == null then
      "${taskNamePrefix}:check-lockfile"
    else
      "${taskNamePrefix}:check-lockfile:${taskSuffix}";
  cleanTaskName =
    if taskSuffix == null then "${taskNamePrefix}:clean" else "${taskNamePrefix}:clean:${taskSuffix}";
  doctorTaskName =
    if taskSuffix == null then "${taskNamePrefix}:doctor" else "${taskNamePrefix}:doctor:${taskSuffix}";
  repairTaskName =
    if taskSuffix == null then "${taskNamePrefix}:repair" else "${taskNamePrefix}:repair:${taskSuffix}";
  migrateLegacyStoreTaskName =
    if taskSuffix == null then
      "${taskNamePrefix}:store:migrate-legacy"
    else
      "${taskNamePrefix}:store:migrate-legacy:${taskSuffix}";
  resetLockFilesTaskName =
    if taskSuffix == null then
      "${taskNamePrefix}:reset-lock-files"
    else
      "${taskNamePrefix}:reset-lock-files:${taskSuffix}";
  pnpmTaskHelpersScript = pkgs.writeText "pnpm-task-helpers.sh" (
    builtins.readFile ./pnpm-task-helpers.sh
  );
  nodeModulesProjectionScript = pkgs.writeText "check-node-modules-projection-health.cjs" (
    builtins.readFile ./check-node-modules-projection-health.cjs
  );
  stageSourceInputsScript = pkgs.writeText "stage-pnpm-source-inputs.mjs" (
    builtins.readFile ./stage-pnpm-source-inputs.mjs
  );
  sourceStagePath = ".devenv/pnpm-source-inputs";
  pnpmInstallPolicy = import ../../../workspace-tools/lib/pnpm-install-policy.nix { inherit lib; };
  effectivePnpmLockMutatorPkg =
    if pnpmLockMutatorPkg != null then
      pnpmLockMutatorPkg
    else
      import ../../../pnpm-lock-mutator.nix { inherit pkgs; };
  pnpmLockMutatorVersion = effectivePnpmLockMutatorPkg.version or "unknown";
  # Only inspect caller-provided overrides eagerly. Forcing the default
  # derivation here would force the module's `pkgs` argument while devenv is
  # still assembling `_module.args`, causing an evaluation recursion.
  pnpmLockMutatorOverrideVersion =
    if pnpmLockMutatorPkg == null then "11.5.1" else pnpmLockMutatorPkg.version or "unknown";
  pnpmLockMutatorOverrideIsSupported =
    pnpmLockMutatorPkg == null || pnpmLockMutatorOverrideVersion == "11.5.1";
  genieBin =
    if geniePkg != null then
      "${geniePkg}/bin/genie"
    else
      throw "pnpm.nix requires geniePkg for repo-root lock maintenance";

  flock = "${pkgs.flock}/bin/flock";
  installFlagsString = lib.escapeShellArgs installFlags;
  liveRealizationPolicyFlags = installFlags ++ pnpmInstallPolicy.liveInstallPolicyFlags;
  liveRealizationPolicyFlagsString = lib.escapeShellArgs liveRealizationPolicyFlags;
  lockMaintenancePolicyFlagsString = lib.escapeShellArgs [
    "--config.confirmModulesPurge=false"
    "--ignore-scripts"
    "--config.side-effects-cache=false"
    "--config.verify-store-integrity=true"
    "--config.strict-store-pkg-content-check=true"
    "--child-concurrency=1"
    "--network-concurrency=4"
    "--pm-on-fail=ignore"
  ];
  pureInstallFlags =
    installFlags
    ++ [
      (if frozenInCi then "--frozen-lockfile" else "--no-frozen-lockfile")
    ]
    ++ pnpmInstallPolicy.liveInstallPolicyFlags;
  pureInstallFlagsString = lib.escapeShellArgs pureInstallFlags;

  packageNameToPath = builtins.listToAttrs (
    builtins.filter (x: x != null) (
      map (
        path:
        let
          pkgJsonPath = "${workspaceRootAbs}/${path}/package.json";
          pkgJsonExists = builtins.pathExists pkgJsonPath;
          pkgJson = if pkgJsonExists then builtins.fromJSON (builtins.readFile pkgJsonPath) else { };
          name = pkgJson.name or null;
        in
        if name != null then
          {
            inherit name;
            value = path;
          }
        else
          null
      ) packages
    )
  );

  getInjectedDeps =
    path:
    let
      pkgJsonPath = "${workspaceRootAbs}/${path}/package.json";
      pkgJsonExists = builtins.pathExists pkgJsonPath;
      pkgJson = if pkgJsonExists then builtins.fromJSON (builtins.readFile pkgJsonPath) else { };
      depsMeta = pkgJson.dependenciesMeta or { };
      injectedNames = builtins.filter (name: (depsMeta.${name}.injected or false) == true) (
        builtins.attrNames depsMeta
      );
    in
    builtins.filter (p: p != null) (map (name: packageNameToPath.${name} or null) injectedNames);

  injectedSourcePaths = lib.unique (lib.concatMap getInjectedDeps packages);

  normalizedSourceInputPaths = map (
    path:
    assert lib.assertMsg (
      path != ""
      && path != "."
      && !(lib.hasPrefix "/" path)
      && !(lib.hasPrefix "../" path)
      && !(lib.hasInfix "/../" path)
      && !(lib.hasSuffix "/.." path)
    ) "sourceInputPaths entries must be non-empty relative paths without parent traversal";
    path
  ) (lib.unique sourceInputPaths);
  sourceInputPathsOverlap = lib.any (
    left:
    lib.any (
      right: left != right && (lib.hasPrefix "${left}/" right || lib.hasPrefix "${right}/" left)
    ) normalizedSourceInputPaths
  ) normalizedSourceInputPaths;

  manifestPaths = lib.concatMapStringsSep " " (path: ''"${path}/package.json"'') packages;
  packageNodeModulesPaths = map (
    path: if path == "." then "node_modules" else "${path}/node_modules"
  ) packages;
  nodeModulesPaths = lib.concatMapStringsSep " " lib.escapeShellArg packageNodeModulesPaths;
  healthCheckNodeModulesPaths = lib.concatStringsSep " " (
    map lib.escapeShellArg (lib.unique ([ "node_modules" ] ++ packageNodeModulesPaths))
  );
  lockFilePaths = ''"pnpm-lock.yaml"'';

  loadPnpmTaskHelpersFn = ''
    # Reuse the exact same helper implementations in task execution and shell
    # tests so cleanup refactors cannot silently drift the two code paths apart.
    source ${lib.escapeShellArg pnpmTaskHelpersScript}
  '';
  ensureLocalPnpmHomeFn = ''
    # Keep root-owned package-manager state workspace-local. The complete pnpm
    # package store is shared, including pnpm's concurrency-safe derived index.
    if [ ${lib.escapeShellArg workspaceRoot} = "." ]; then
      if [ -z "''${PNPM_HOME:-}" ]; then
        export PNPM_HOME=${lib.escapeShellArg defaultPnpmHome}
      fi
    elif [ -z "''${PNPM_HOME:-}" ]; then
      export PNPM_HOME=${lib.escapeShellArg defaultPnpmHome}
    else
      case "$PNPM_HOME" in
        */${workspaceCacheName}) ;;
        *) export PNPM_HOME="$PNPM_HOME/${workspaceCacheName}" ;;
      esac
    fi
  '';
  configurePnpmStorageFn = ''
    configure_pnpm_storage \
      ${lib.escapeShellArg "${pkgs.nodejs}/bin/node"} \
      ${lib.escapeShellArg workspaceRootAbs} \
      ${lib.escapeShellArg jobLocalPnpmStoreDir} \
      ${lib.boolToString pkgs.stdenv.hostPlatform.isLinux}
  '';
  managedPnpmMutationPrologue = ''
    ${loadPnpmTaskHelpersFn}
    ${ensureLocalPnpmHomeFn}
    ${configurePnpmStorageFn}
    mkdir -p ${lib.escapeShellArg cacheRoot}

    lockfile=${lib.escapeShellArg "${cacheRoot}/pnpm-install.lock"}
    exec 200>"$lockfile"
    if ! ${flock} -w 600 200; then
      echo "[pnpm] Materialization-root mutation lock timeout after 600s: $lockfile" >&2
      echo "[pnpm] Another managed pnpm mutation may be stuck" >&2
      exit 1
    fi

    pnpm_home_lockfile="''${PNPM_HOME:-${cacheRoot}}/.effect-utils-pnpm-install.lock"
    mkdir -p "$(dirname "$pnpm_home_lockfile")"
    exec 201>"$pnpm_home_lockfile"
    if ! ${flock} -w 600 201; then
      echo "[pnpm] PNPM_HOME mutation lock timeout after 600s: $pnpm_home_lockfile" >&2
      echo "[pnpm] Another managed pnpm mutation sharing this PNPM_HOME may be stuck" >&2
      exit 1
    fi

    # Installs sharing a Store Cache take compatible shared admission leases.
    # Host-owned maintenance takes the exclusive counterpart, so pruning can
    # never race pnpm while independent Materialization Roots stay concurrent.
    acquire_pnpm_store_cache_lease ${lib.escapeShellArg flock} shared "$npm_config_store_dir" 600

    assert_pnpm_storage_capacity \
      ${lib.escapeShellArg "${pkgs.nodejs}/bin/node"} \
      "$npm_config_store_dir" \
      ${lib.escapeShellArg workspaceRootAbs}
  '';

  stageSourceInputs = lib.optionalString (normalizedSourceInputPaths != [ ]) ''
    ${pkgs.nodejs}/bin/node ${lib.escapeShellArg stageSourceInputsScript} \
      publish \
      ${lib.escapeShellArg workspaceRootAbs} \
      ${lib.escapeShellArg sourceStagePath} \
      ${lib.escapeShellArgs normalizedSourceInputPaths}
  '';
  checkSourceInputs = lib.optionalString (normalizedSourceInputPaths != [ ]) ''
    ${pkgs.nodejs}/bin/node ${lib.escapeShellArg stageSourceInputsScript} \
      check \
      ${lib.escapeShellArg workspaceRootAbs} \
      ${lib.escapeShellArg sourceStagePath} \
      ${lib.escapeShellArgs normalizedSourceInputPaths}
  '';
  gcSourceInputs = lib.optionalString (normalizedSourceInputPaths != [ ]) ''
    ${pkgs.nodejs}/bin/node ${lib.escapeShellArg stageSourceInputsScript} \
      gc \
      ${lib.escapeShellArg workspaceRootAbs} \
      ${lib.escapeShellArg sourceStagePath} \
      ${lib.escapeShellArgs normalizedSourceInputPaths}
  '';

  computeWorkspaceStateHash = ''
    compute_workspace_state_hash() {
      {
        cat package.json
        cat pnpm-workspace.yaml
        cat pnpm-lock.yaml
        if [ -f .npmrc ]; then
          cat .npmrc
        fi

        for manifest in ${manifestPaths}; do
          if [ -f "$manifest" ]; then
            cat "$manifest"
          fi
        done

        for injected_dir in ${lib.concatMapStringsSep " " (path: ''"${path}"'') injectedSourcePaths}; do
          emit_dir_state "$injected_dir"
        done

      } | compute_hash
    }
  '';

  computeInstallStateHashFn = ''
    compute_install_state_hash() {
      local workspace_state_hash
      workspace_state_hash="$(compute_workspace_state_hash)"

      {
        printf '%s\n' ${lib.escapeShellArg pkgs.pnpm.version}
        printf '%s\n' "$workspace_state_hash"
        printf '%s\n' "$npm_config_store_dir"
        printf '%s\n' "$PNPM_PACKAGE_IMPORT_METHOD"
        printf '%s\n' ${lib.escapeShellArg (builtins.toJSON installFlags)}
        printf '%s\n' ${lib.escapeShellArg preInstall}
        printf '%s\n' ${lib.escapeShellArg postInstallProjection}
        printf '%s\n' ${lib.escapeShellArg (builtins.toJSON normalizedSourceInputPaths)}
      } | compute_hash
    }
  '';
  computeProjectionStateHashFn = ''
    compute_projection_state_hash() {
      # Keep the warm-path fingerprint semantics identical while avoiding the
      # shell pipeline's per-link process overhead. The helper hashes the same
      # ordered line stream that the previous bash implementation produced.
      NODE_MODULES_HELPER_MODE="projection-hash" \
      PNPM_ROOT_MODULES_YAML="node_modules/.modules.yaml" \
      NODE_MODULES_DIRS="$(printf '%s\n' node_modules ${nodeModulesPaths})" \
      ${pkgs.nodejs}/bin/node ${lib.escapeShellArg nodeModulesProjectionScript}
    }
  '';

  runPnpmInstallFn = ''
    reject_impure_pnpm_install_args() {
      local arg
      for arg in "$@"; do
        case "$arg" in
          --no-frozen-lockfile | --frozen-lockfile=false | \
          --fix-lockfile | --lockfile-only | --no-lockfile | \
          --config.frozen-lockfile=false | --config.frozen-lockfile | \
          --no-ignore-scripts | --ignore-scripts=false | \
          --config.ignore-scripts=false | --config.ignore-scripts | \
          --config.ignore-dep-scripts=false | --config.ignore-dep-scripts | \
          --config.side-effects-cache=true | --config.side-effects-cache | --side-effects-cache | \
          --side-effects-cache-readonly | --config.side-effects-cache-readonly=true | --config.side-effects-cache-readonly | \
          --no-verify-store-integrity | --verify-store-integrity=false | \
          --config.verify-store-integrity=false | --config.verify-store-integrity | \
          --strict-store-pkg-content-check=false | --no-strict-store-pkg-content-check | \
          --config.strict-store-pkg-content-check=false | --config.strict-store-pkg-content-check | \
          --config.manage-package-manager-versions=true | --config.manage-package-manager-versions | \
          --config.enable-global-virtual-store=true | --enable-global-virtual-store | \
          --config.global-virtual-store-dir=* | --config.global-virtual-store-dir | \
          --global-virtual-store-dir=* | --global-virtual-store-dir | \
          --config.virtual-store-dir=* | --config.virtual-store-dir | \
          --virtual-store-dir=* | --virtual-store-dir | \
          --pm-on-fail=* | --pm-on-fail | --config.pm-on-fail=* | --config.pm-on-fail | \
          --config.package-import-method=* | --config.package-import-method | --package-import-method=* | --package-import-method | \
          --config.store-dir=* | --config.store-dir | --store-dir=* | --store-dir)
            echo "[pnpm] Refusing impure install argument: $arg" >&2
            exit 1
            ;;
        esac
      done
    }

    run_pnpm_install() {
      local install_args
      reject_impure_pnpm_install_args "$@" ${installFlagsString}
      install_args=(
        install
        "$@"
        ${pureInstallFlagsString}
        "--config.package-import-method=$PNPM_PACKAGE_IMPORT_METHOD"
        "--config.store-dir=$npm_config_store_dir"
      )

      ${lib.optionalString pkgs.stdenv.hostPlatform.isDarwin ''
        if [ -n "''${CI:-}" ]; then
          ${pnpmInstallPolicy.darwinNodeOptionsShell}
        fi
      ''}

      if [ -z "''${CI:-}" ]; then
        pnpm "''${install_args[@]}"
        return
      fi

      local diagnostics_dir
      diagnostics_dir="''${CI_DIAGNOSTICS_DIR:-${cacheRoot}/diagnostics}"
      mkdir -p "$diagnostics_dir"

      local log_file
      log_file="$diagnostics_dir/pnpm-install.log"

      echo "[pnpm] Running install; full log: $log_file"
      local rc
      set +e
      ${lib.optionalString pkgs.stdenv.hostPlatform.isDarwin ''
        # GitHub-hosted macOS runners can kill pnpm after APFS materialization
        # has completed. Bound the node heap like the fixed-output builder does
        # so teardown pressure does not fail otherwise-complete installs.
        export NODE_OPTIONS="''${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=1536"
      ''}
      pnpm "''${install_args[@]}" > "$log_file" 2>&1
      rc="$?"
      set -e
      if [ "$rc" -eq 0 ]; then
        return
      fi

      ${lib.optionalString pkgs.stdenv.hostPlatform.isDarwin ''
        if ${
          pnpmInstallPolicy.darwinCompletedMaterializationCheckShell {
            statusVar = "rc";
            logFileVar = "log_file";
          }
        }; then
          echo "[pnpm] Install completed materialization before darwin install teardown; continuing after node teardown exit $rc" >&2
          return
        fi
      ''}

      local classification="pnpm install failure"
      local evidence=""

      if grep -Eq 'ERR_PNPM_(META_)?FETCH_FAIL|Socket timeout|request to .* failed|fetch.*failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN' "$log_file"; then
        classification="registry/network fetch failure"
        evidence="$(grep -Em1 'ERR_PNPM_(META_)?FETCH_FAIL|Socket timeout|request to .* failed|fetch.*failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN' "$log_file" || true)"
      elif grep -Eq 'ERR_PNPM_WORKSPACE_PKG_NOT_FOUND' "$log_file"; then
        classification="workspace package mismatch"
        evidence="$(grep -Em1 'ERR_PNPM_WORKSPACE_PKG_NOT_FOUND' "$log_file" || true)"
      fi

      if [ -n "''${GITHUB_ACTIONS:-}" ]; then
        echo "::group::pnpm install failure diagnostics" >&2
      fi

      echo "[pnpm] Install failed: $classification" >&2
      echo "[pnpm] Exit code: $rc" >&2
      echo "[pnpm] Workspace: ${lib.escapeShellArg workspaceRootAbs}" >&2
      echo "[pnpm] Log: $log_file" >&2
      if [ -n "$evidence" ]; then
        echo "[pnpm] Evidence: $evidence" >&2
      fi
      echo "[pnpm] Last 120 log lines:" >&2
      tail -120 "$log_file" >&2 || true

      if [ -n "''${GITHUB_STEP_SUMMARY:-}" ]; then
        {
          echo "### pnpm install failed"
          echo ""
          echo "- Classification: $classification"
          echo "- Exit code: $rc"
          if [ -n "$evidence" ]; then
            echo "- Evidence: \`$evidence\`"
          fi
          echo "- Log artifact: \`$log_file\`"
        } >> "$GITHUB_STEP_SUMMARY"
      fi

      if [ -n "''${GITHUB_ACTIONS:-}" ]; then
        echo "::endgroup::" >&2
      fi

      return "$rc"
    }
  '';
  runPnpmLockMutatorFn = ''
    collect_lockfile_package_records() {
      local mode="$1"
      local lockfile="$2"

      [ -f "$lockfile" ] || return 0
      awk -v mode="$mode" '
        /^packages:$/ { in_packages = 1; next }
        in_packages && /^[^ ]/ { exit }
        in_packages && /^  [^ ]/ {
          package_key = $0
          sub(/^  /, "", package_key)
          sub(/:$/, "", package_key)
          if (mode == "all") print package_key
          next
        }
        in_packages && /^    hasBin: true$/ && mode == "has-bin" { print package_key }
      ' "$lockfile" | LC_ALL=C sort -u
    }

    run_pnpm_lock_mutator() {
      local state_dir
      local had_lockfile=0
      local status

      state_dir="$(mktemp -d)"
      if [ -f pnpm-lock.yaml ]; then
        had_lockfile=1
        cp pnpm-lock.yaml "$state_dir/pnpm-lock.yaml.before"
        collect_lockfile_package_records has-bin pnpm-lock.yaml > "$state_dir/has-bin.before"
      else
        : > "$state_dir/has-bin.before"
      fi

      set +e
      ${lib.escapeShellArg "${effectivePnpmLockMutatorPkg}/bin/pnpm"} install --fix-lockfile --lockfile-only \
        ${lockMaintenancePolicyFlagsString} \
        --config.store-dir="$npm_config_store_dir"
      status=$?
      set -e

      if [ "$status" -ne 0 ]; then
        if [ "$had_lockfile" -eq 1 ]; then
          cp "$state_dir/pnpm-lock.yaml.before" pnpm-lock.yaml
        else
          rm -f pnpm-lock.yaml
        fi
        rm -rf "$state_dir"
        return "$status"
      fi

      collect_lockfile_package_records all pnpm-lock.yaml > "$state_dir/packages.after"
      collect_lockfile_package_records has-bin pnpm-lock.yaml > "$state_dir/has-bin.after"
      comm -12 "$state_dir/has-bin.before" "$state_dir/packages.after" > "$state_dir/retained-has-bin"
      comm -23 "$state_dir/retained-has-bin" "$state_dir/has-bin.after" > "$state_dir/stripped-has-bin"

      if [ -s "$state_dir/stripped-has-bin" ]; then
        echo "[pnpm] Lockfile mutator ${pnpmLockMutatorVersion} stripped hasBin from retained package records:" >&2
        sed 's/^/  - /' "$state_dir/stripped-has-bin" >&2
        echo "[pnpm] Restoring pnpm-lock.yaml; see https://github.com/pnpm/pnpm/issues/6600" >&2
        if [ "$had_lockfile" -eq 1 ]; then
          cp "$state_dir/pnpm-lock.yaml.before" pnpm-lock.yaml
        else
          rm -f pnpm-lock.yaml
        fi
        rm -rf "$state_dir"
        return 1
      fi

      rm -rf "$state_dir"
    }
  '';

  allTasks = {
    "${installTaskName}" = {
      guard = "pnpm";
      description = "Install the pnpm workspace at ${workspaceRoot} from its authoritative lockfile";
      after = installAfter;
      exec = trace.exec installTaskName ''
        set -euo pipefail
        cd ${lib.escapeShellArg workspaceRootAbs}
        ${managedPnpmMutationPrologue}
        # This cache tracks the effective install state, not just workspace
        # manifests. The virtual dependency graph itself is root-local.
        hash_file="${cacheRoot}/install-state.hash"
        projection_hash_file="${cacheRoot}/projection-state.hash"
        contract_state_file="${cacheRoot}/pnpm-install-contract.json"
        storage_state_file="${cacheRoot}/pnpm-storage-state"

        ${computeWorkspaceStateHash}
        ${computeInstallStateHashFn}
        ${computeProjectionStateHashFn}
        ${stageSourceInputs}
        ${preInstall}
        ${runPnpmInstallFn}

        _pnpm_install_contract_file="$PWD/pnpm-install-contract.json"
        if [ ! -f "$_pnpm_install_contract_file" ]; then
          _pnpm_install_contract_file=""
          ${lib.optionalString (workspaceRoot == ".") ''
            echo "[pnpm] Missing generated pnpm-install-contract.json at repo root" >&2
            echo "[pnpm] Run: devenv tasks run genie:run" >&2
            exit 1
          ''}
          : # A nested downstream root may not emit profile evidence yet.
        fi

        _force_install=false

        if ! check_node_modules_links_healthy ${pkgs.nodejs}/bin/node ${lib.escapeShellArg nodeModulesProjectionScript} ${healthCheckNodeModulesPaths}; then
          echo "[pnpm] node_modules projection is stale, purging install state"
          purge_node_modules node_modules ${nodeModulesPaths}
          _force_install=true
        fi

        if [ "$_force_install" = true ]; then
          run_pnpm_install --force
        else
          run_pnpm_install
        fi

        if ! check_node_modules_links_healthy ${pkgs.nodejs}/bin/node ${lib.escapeShellArg nodeModulesProjectionScript} ${healthCheckNodeModulesPaths}; then
          echo "[pnpm] node_modules projection is still unhealthy after install" >&2
          exit 1
        fi

        ${gcSourceInputs}

        ${postInstallProjection}

        if ! check_node_modules_links_healthy ${pkgs.nodejs}/bin/node ${lib.escapeShellArg nodeModulesProjectionScript} ${healthCheckNodeModulesPaths}; then
          echo "[pnpm] node_modules projection is unhealthy after the root-owned post-install projection" >&2
          exit 1
        fi

        if [ -n "''${_pnpm_install_contract_file:-}" ]; then
          rm -f "$contract_state_file"
          cp "$_pnpm_install_contract_file" "$contract_state_file"
          chmod u+w "$contract_state_file" 2>/dev/null || true
        else
          rm -f "$contract_state_file"
        fi

        cache_value="$(compute_install_state_hash)"
        ${cache.writeCacheFile ''"$hash_file"''}

        cache_value="$(compute_projection_state_hash)"
        ${cache.writeCacheFile ''"$projection_hash_file"''}

        cache_value="$(printf '%s\n%s\n' "$npm_config_store_dir" "$PNPM_PACKAGE_IMPORT_METHOD")"
        ${cache.writeCacheFile ''"$storage_state_file"''}
      '';
      status = trace.status installTaskName "hash" ''
        set -euo pipefail
        cd ${lib.escapeShellArg workspaceRootAbs}
        ${loadPnpmTaskHelpersFn}
        ${ensureLocalPnpmHomeFn}
        ${configurePnpmStorageFn}
        hash_file="${cacheRoot}/install-state.hash"
        projection_hash_file="${cacheRoot}/projection-state.hash"
        contract_state_file="${cacheRoot}/pnpm-install-contract.json"
        storage_state_file="${cacheRoot}/pnpm-storage-state"

        _pnpm_install_contract_file="$PWD/pnpm-install-contract.json"
        if [ ! -f "$_pnpm_install_contract_file" ]; then
          _pnpm_install_contract_file=""
          ${lib.optionalString (workspaceRoot == ".") ''
            echo "[pnpm] Missing generated pnpm-install-contract.json at repo root" >&2
            echo "[pnpm] Run: devenv tasks run genie:run" >&2
            emit_pnpm_install_miss_span ${lib.escapeShellArg installTaskName} "contract_missing"
            exit 1
          ''}
        fi

        if [ ! -d node_modules ] || [ ! -f pnpm-lock.yaml ] || [ ! -f "$hash_file" ] || [ ! -f "$projection_hash_file" ] || [ ! -f "$storage_state_file" ] || [ ! -f node_modules/.modules.yaml ]; then
          emit_pnpm_install_miss_span ${lib.escapeShellArg installTaskName} "bootstrap"
          exit 1
        fi

        ${lib.optionalString (normalizedSourceInputPaths != [ ]) ''
          if ! (
            ${checkSourceInputs}
          ); then
            emit_pnpm_install_miss_span ${lib.escapeShellArg installTaskName} "source_inputs"
            exit 1
          fi
        ''}

        current_storage_state="$(printf '%s\n%s\n' "$npm_config_store_dir" "$PNPM_PACKAGE_IMPORT_METHOD")"
        if [ "$current_storage_state" != "$(cat "$storage_state_file")" ]; then
          emit_pnpm_install_miss_span ${lib.escapeShellArg installTaskName} "storage_policy"
          exit 1
        fi

        if [ "''${DEVENV_SETUP_OUTER_CACHE_HIT:-0}" = "1" ]; then
          # The stored projection digest was written only after the full health
          # oracle passed. Compare the complete realization evidence instead of
          # repeating module resolution for every cached downstream task.
          ${computeProjectionStateHashFn}
          current_projection_hash="$(compute_projection_state_hash)"
          stored_projection_hash="$(cat "$projection_hash_file")"
          if [ "$current_projection_hash" != "$stored_projection_hash" ]; then
            emit_pnpm_install_miss_span ${lib.escapeShellArg installTaskName} "projection"
            exit 1
          fi
          exit 0
        fi

        ${computeWorkspaceStateHash}
        ${computeInstallStateHashFn}
        ${computeProjectionStateHashFn}
        current_hash="$(compute_install_state_hash)"
        current_projection_hash="$(compute_projection_state_hash)"
        stored_hash="$(cat "$hash_file")"
        stored_projection_hash="$(cat "$projection_hash_file")"
        if [ "$current_hash" != "$stored_hash" ]; then
          if [ -f "$contract_state_file" ] && [ -n "''${_pnpm_install_contract_file:-}" ]; then
            _miss_reason="$(classify_pnpm_contract_change ${pkgs.nodejs}/bin/node "$contract_state_file" "$_pnpm_install_contract_file" || printf '%s\n' unknown)"
          else
            _miss_reason="unknown"
          fi
          emit_pnpm_install_miss_span ${lib.escapeShellArg installTaskName} "$_miss_reason"
          exit 1
        fi
        if [ "$current_projection_hash" != "$stored_projection_hash" ]; then
          emit_pnpm_install_miss_span ${lib.escapeShellArg installTaskName} "projection"
          exit 1
        fi
        exit 0
      '';
    };

    "${updateTaskName}" = {
      guard = "pnpm";
      description = "Update the authoritative pnpm lockfile at ${workspaceRoot}";
      after = updateAfter;
      exec = trace.exec updateTaskName ''
        set -euo pipefail
        cd ${lib.escapeShellArg workspaceRootAbs}
        ${managedPnpmMutationPrologue}
        ${stageSourceInputs}
        ${runPnpmLockMutatorFn}
        ${lib.optionalString (workspaceRoot == ".") ''
          # Projection can change the catalog that the lockfile must satisfy.
          # Defer cross-file validation only until the safe mutator has repaired
          # that lock; the final check below is mandatory.
          ${genieBin} --defer-validation
        ''}
        run_pnpm_lock_mutator
        ${lib.optionalString (workspaceRoot == ".") ''
          ${genieBin} --check
        ''}
        ${gcSourceInputs}
        echo "Repo-root lockfile updated. Refresh Nix FOD hashes with the repo workflow."
      '';
    };

    "${dedupeTaskName}" = {
      guard = "pnpm";
      description = "Collapse in-range duplicate versions in the pnpm lockfile at ${workspaceRoot}";
      after = (if workspaceRoot == "." then [ "genie:run" ] else [ ]) ++ dedupeAfter;
      exec = trace.exec dedupeTaskName ''
        set -euo pipefail
        cd ${lib.escapeShellArg workspaceRootAbs}
        ${managedPnpmMutationPrologue}
        ${stageSourceInputs}
        pnpm dedupe --lockfile-only ${lockMaintenancePolicyFlagsString} \
          --config.store-dir="$npm_config_store_dir"
        ${gcSourceInputs}
        echo "Lockfile deduped. Re-run genie:check to verify the catalog duplicate gate; bless any upstream-locked residuals via catalogDuplicateExceptions."
      '';
    };

    "${checkLockTaskName}" = {
      guard = "pnpm";
      description = "Verify package manifests match the authoritative pnpm lockfile without realizing node_modules";
      exec = trace.exec checkLockTaskName ''
        set -euo pipefail
        cd ${lib.escapeShellArg workspaceRootAbs}
        ${managedPnpmMutationPrologue}
        pnpm install --lockfile-only --frozen-lockfile --ignore-scripts \
          --config.confirmModulesPurge=false \
          --config.side-effects-cache=false \
          --config.store-dir="$npm_config_store_dir"
      '';
    };

    "${cleanTaskName}" = {
      guard = "pnpm";
      description = "Remove node_modules for the pnpm workspace at ${workspaceRoot}";
      after = cleanAfter;
      exec = trace.exec cleanTaskName ''
        set -euo pipefail
        cd ${lib.escapeShellArg workspaceRootAbs}
        ${loadPnpmTaskHelpersFn}
        ${ensureLocalPnpmHomeFn}
        ${configurePnpmStorageFn}

        purge_node_modules node_modules ${nodeModulesPaths}
      '';
    };

    "${doctorTaskName}" = {
      guard = "pnpm";
      description = "Inspect existing dependency materialization evidence for the pnpm workspace at ${workspaceRoot}";
      exec = trace.exec doctorTaskName ''
        set -euo pipefail
        cd ${lib.escapeShellArg workspaceRootAbs}
        ${loadPnpmTaskHelpersFn}

        if [ -d node_modules/.pnpm ] && check_node_modules_links_healthy ${pkgs.nodejs}/bin/node ${lib.escapeShellArg nodeModulesProjectionScript} ${healthCheckNodeModulesPaths}; then
          doctor_decision="healthy"
          doctor_reason="root-local-graph-healthy"
        else
          doctor_decision="repair-root"
          doctor_reason="root-local-graph-unhealthy"
        fi
        ${pkgs.nodejs}/bin/node - "$PWD" "$doctor_decision" "$doctor_reason" <<'EOF'
        const [root, decision, reason] = process.argv.slice(2)
        console.log(JSON.stringify({ phase: 'doctor', root, decision, reason }))
        EOF
      '';
    };

    "${repairTaskName}" = {
      guard = "pnpm";
      description = "Discard and rematerialize the root-local pnpm dependency graph at ${workspaceRoot}";
      exec = trace.exec repairTaskName ''
        set -euo pipefail
        cd ${lib.escapeShellArg workspaceRootAbs}
        ${loadPnpmTaskHelpersFn}
        purge_node_modules node_modules ${nodeModulesPaths}
        rm -f \
          "${cacheRoot}/install-state.hash" \
          "${cacheRoot}/projection-state.hash" \
          "${cacheRoot}/pnpm-storage-state"
        echo "[pnpm] Discarded root-local dependency graph; reinvoking ${installTaskName}"
        exec devenv tasks run ${lib.escapeShellArg installTaskName}
      '';
    };

    "${migrateLegacyStoreTaskName}" = {
      guard = "pnpm";
      description = "Replace the recognized legacy pnpm files bridge with a self-contained Store Cache";
      exec = trace.exec migrateLegacyStoreTaskName ''
        set -euo pipefail
        if [ -n "''${CI:-}" ]; then
          echo "[pnpm] Legacy host Store Cache migration is unavailable in CI" >&2
          exit 1
        fi
        ${loadPnpmTaskHelpersFn}
        store_dir="''${PNPM_SHARED_STORE_DIR:-$HOME/.local/share/pnpm/store-shared-v1}"
        expected_legacy_files="$HOME/.local/share/pnpm/shared-files/v11"
        acquire_pnpm_store_cache_lease ${lib.escapeShellArg flock} exclusive "$store_dir" 600
        migrate_legacy_pnpm_store_cache "$store_dir" "$expected_legacy_files"
      '';
    };

    "${resetLockFilesTaskName}" = {
      description = "Remove the pnpm lock file at ${workspaceRoot} (last resort)";
      after = resetLockFilesAfter;
      exec = trace.exec resetLockFilesTaskName ''
        cd ${lib.escapeShellArg workspaceRootAbs}
        rm -f ${lockFilePaths}
      '';
    };
  };
  enabledTasks =
    if enableLegacyInstall then
      allTasks
    else
      builtins.removeAttrs allTasks [
        installTaskName
        cleanTaskName
        doctorTaskName
        repairTaskName
        migrateLegacyStoreTaskName
      ];

in
assert lib.assertMsg pnpmLockMutatorOverrideIsSupported ''
  pnpm lock mutator version ${pnpmLockMutatorOverrideVersion} is not supported.
  Set a derivation versioned as the verified-safe pnpm 11.5.1 pin;
  other versions require explicit verification and an allowlist change.
'';
assert lib.assertMsg (!sourceInputPathsOverlap) "sourceInputPaths entries must not overlap";
# Checked against the constructor, never the built derivation: forcing the
# derivation here would force this module's `pkgs` argument during import
# collection and recurse through `_module.args`.
assert lib.assertMsg (mkPnpmPkg != null || legacyAmbientPnpm) ''
  pnpm.nix requires mkPnpmPkg ({ pkgs }: derivation); set legacyAmbientPnpm =
  true only for an explicitly legacy downstream shell that intentionally
  resolves pnpm from PATH.
'';
{
  packages = cliGuard.fromTasks {
    tasks = enabledTasks;
    reals = lib.optionalAttrs (mkPnpmPkg != null) { pnpm = pnpmPkg; };
  };

  enterShell = lib.mkIf (globalCache && workspaceRoot == ".") ''
    export PNPM_HOME="''${PNPM_HOME:-${config.devenv.root}/.devenv/pnpm-home}"
    source ${lib.escapeShellArg pnpmTaskHelpersScript}
    ${configurePnpmStorageFn}
    export npm_config_cache="$HOME/.cache/pnpm"
    export npm_config_pm_on_fail=ignore
  '';

  tasks = cliGuard.stripGuards enabledTasks;
}
