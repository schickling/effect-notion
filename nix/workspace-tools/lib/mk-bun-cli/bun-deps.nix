{
  pkgs,
  pnpm,
  name,
  bunDepsHash,
  depsManager,
  pnpmDepsHash,
  stageWorkspace,
  packageDir,
  localDependencies,
  localDependenciesInstallScript,
  localDependenciesCopyScript,
}:

let
  lib = pkgs.lib;
  isPnpm = depsManager == "pnpm";
  depsHash = if isPnpm then pnpmDepsHash else bunDepsHash;
  lockFileName = if isPnpm then "pnpm-lock.yaml" else "bun.lock";
  lockHashFile = if isPnpm then ".source-pnpm-lock-hash" else ".source-bun-lock-hash";
  installInputs =
    if isPnpm then
      [
        pnpm
        pkgs.nodejs_24
        pkgs.cacert
      ]
    else
      [
        pkgs.bun
        pkgs.cacert
      ];
in
if depsHash == null then
  throw "mk-bun-cli: deps hash is required"
else if depsManager != "bun" && depsManager != "pnpm" then
  throw "mk-bun-cli: depsManager must be \"bun\" or \"pnpm\""
else
  pkgs.stdenvNoCC.mkDerivation {
    name = "${name}-${depsManager}-deps";
    nativeBuildInputs = installInputs;

    outputHashMode = "recursive";
    outputHashAlgo = "sha256";
    outputHash = depsHash;

    dontUnpack = true;
    dontFixup = true;
    dontCheckForBrokenSymlinks = true;

    buildPhase = ''
      set -euo pipefail

      export HOME=$PWD
      cache_dir="$PWD/bun-cache"
      mkdir -p "$cache_dir"
      export XDG_CACHE_HOME="$cache_dir"
      export NODE_ENV=development
      export NPM_CONFIG_PRODUCTION=false
      export npm_config_production=false
      export NPM_CONFIG_OMIT=
      export npm_config_omit=

      if ${lib.boolToString (!isPnpm)}; then
        export BUN_INSTALL_CACHE_DIR="$cache_dir"
        export BUN_INSTALL_TMP_DIR="$PWD/bun-tmp"
        export BUN_TMPDIR="$BUN_INSTALL_TMP_DIR"
      else
        export PNPM_HOME="$PWD/pnpm-home"
        export PNPM_STORE_DIR="$PWD/pnpm-store"
        export npm_config_store_dir="$PNPM_STORE_DIR"
        export npm_config_pm_on_fail=ignore
        export npm_config_side_effects_cache=false
        export npm_config_verify_store_integrity=true
        export npm_config_strict_store_pkg_content_check=true
        export npm_config_package_import_method=clone-or-copy
        export NPM_CONFIG_NODE_LINKER=hoisted
      fi

      ${stageWorkspace}

      # Wrap bun install to emit actionable hints when lockfiles drift.
      deps_install_checked() {
        local dep_path="$1"
        local dep_name="$2"
        local lock_path="$dep_path/${lockFileName}"
        local log_name
        log_name="$(printf '%s' "$dep_name" | tr '/@' '__')"
        local install_log="$PWD/${depsManager}-install-$log_name.log"
        if ${lib.boolToString (!isPnpm)}; then
          # Use --ignore-scripts to avoid /usr/bin/env shebang failures in Nix sandbox.
          # See the stack-level Nix/devenv CI policy docs.
          bun install \
            --cwd "$dep_path" \
            --frozen-lockfile \
            --linker=hoisted \
            --backend=copyfile \
            --no-cache \
            --ignore-scripts 2>&1 | tee "$install_log"
        else
          (
            cd "$dep_path"
            # Use --ignore-scripts to avoid /usr/bin/env shebang failures in Nix sandbox.
            # See the stack-level Nix/devenv CI policy docs.
            pnpm install \
              --frozen-lockfile \
              --force \
              --shamefully-hoist \
              --ignore-scripts \
              --config.side-effects-cache=false \
              --config.verify-store-integrity=true \
              --config.strict-store-pkg-content-check=true \
              --config.package-import-method=clone-or-copy \
              --pm-on-fail=ignore \
              --config.store-dir="$PNPM_STORE_DIR"
          ) 2>&1 | tee "$install_log"
        fi
        if [ "''${PIPESTATUS[0]:-0}" -ne 0 ]; then
          local lock_mtime
          lock_mtime="$(stat -c '%y' "$lock_path" 2>/dev/null || stat -f '%Sm' -t '%Y-%m-%d %H:%M:%S' "$lock_path" 2>/dev/null || echo "unknown")"
          echo "mk-bun-cli: ${depsManager} install failed for $dep_name" >&2
          echo "mk-bun-cli: ${lockFileName} mtime: $lock_mtime" >&2
          if grep -q "lockfile had changes" "$install_log"; then
            echo "mk-bun-cli: ${lockFileName} changed while deps hash is frozen" >&2
          fi
          echo "mk-bun-cli: deps hash may be stale; refresh Nix FOD hashes for ${name}" >&2
          exit 1
        fi
      }

      package_path="$workspace/${packageDir}"
      if [ ! -f "$package_path/package.json" ]; then
        echo "mk-bun-cli: missing package.json in ${packageDir}" >&2
        exit 1
      fi
      if [ ! -f "$package_path/${lockFileName}" ]; then
        echo "mk-bun-cli: missing ${lockFileName} in ${packageDir} (workspace expects self-contained packages)" >&2
        exit 1
      fi

      # Store lock hash before install so we can detect staleness later.
      sha256sum "$package_path/${lockFileName}" | cut -d' ' -f1 > "$PWD/${lockHashFile}"

      deps_install_checked "$package_path" "${name}"

      ${lib.optionalString (localDependencies != [ ]) localDependenciesInstallScript}
    '';

    installPhase = ''
      set -euo pipefail
      package_path="$PWD/workspace/${packageDir}"
      mkdir -p "$out"

      # Copy the source lock hash for staleness detection.
      cp "$PWD/${lockHashFile}" "$out/${lockHashFile}"

      if [ -d "$package_path/node_modules" ]; then
        cp -R -L "$package_path/node_modules" "$out/node_modules"
      fi

      ${lib.optionalString (localDependencies != [ ]) localDependenciesCopyScript}
    '';
  }
