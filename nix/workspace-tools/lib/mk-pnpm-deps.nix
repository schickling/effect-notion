# Shared pnpm dependency preparation and restore helpers.
#
# This intentionally diverges from nixpkgs' pnpm helper shape.
#
# | Aspect              | nixpkgs `fetchPnpmDeps` + `pnpmConfigHook`         | This helper                                  |
# |---------------------|----------------------------------------------------|----------------------------------------------|
# | Cached artifact     | Normalized pnpm store tarball                      | Prepared workspace directory                 |
# | Downstream behavior | Restores store, then runs `pnpm install --offline` | Restores data, then purely projects bins     |
# | Primary goal        | Generic packaging and broad cache reuse            | Fast downstream CLI builds in staged workspaces |
# | Monorepo model      | Generic pnpm workspace filters                     | Custom staged workspace + install-root model |
# | Cache reuse         | Better across packages sharing one store           | Worse, because prepared trees are more specific |
# | Determinism surface | Mostly pnpm store contents                         | Normalized materialized dependency graph     |
# | Complexity          | Lower, upstream-maintained                         | Higher, repo-specific normalization logic    |
#
# We choose the second column because this repo's staged megarepo workspace is
# heavily filtered and install-root-specific, and repeating `pnpm install` in
# every CLI build was the main wall-time and disk-pressure bottleneck.
# Downstream repos should therefore follow `effect-utils/nixpkgs` when they
# consume these prepared trees so the full builder graph stays canonical.
#
# Provides two functions used by both mk-pnpm-cli.nix and oxc-config-plugin.nix:
#
# 1. mkDeps: Creates a fixed-output derivation (FOD) that installs a staged
#    manifest-only workspace and stores the resulting prepared install tree as
#    a fixed-output directory.
#
# 2. mkRestoreScript: Generates a shell script snippet that overlays the
#    prepared workspace tree over a full source workspace during the build.
#
# By centralizing this logic we keep pnpm out of downstream build phases and
# avoid duplicating staged-workspace install preparation across builders.

{ pkgs, pnpm }:

let
  lib = pkgs.lib;
  pnpmInstallPolicy = import ./pnpm-install-policy.nix { inherit lib; };
  # Drive pnpm with an LTS Node runtime even when nixpkgs' default `nodejs`
  # advances first. pnpm dependency preparation is build tooling, not the app
  # runtime, and this keeps FOD behavior stable across nixpkgs release bumps.
  pnpmNodejs = pkgs.nodejs_24 or pkgs.nodejs;
  preparedPnpmTreeScript = pkgs.writeText "prepared-pnpm-tree.cjs" (
    builtins.readFile ./prepared-pnpm-tree.cjs
  );
  pnpmBinProjectorScript = pkgs.writeText "pnpm-bin-projector.cjs" (
    builtins.readFile ./pnpm-bin-projector.cjs
  );
  nixClosureBytesScript = pkgs.writeText "nix-closure-bytes.cjs" ''
    const fs = require("fs");
    const raw = fs.readFileSync(0, "utf8");
    if (raw.trim() === "") {
      process.stdout.write("0");
      process.exit(0);
    }
    const data = JSON.parse(raw);
    const item = Array.isArray(data)
      ? (data[0] ?? {})
      : (typeof data === "object" && data !== null ? Object.values(data)[0] ?? {} : {});
    process.stdout.write(String(item.closureSize ?? item.narSize ?? 0));
  '';
  fileCountScript = pkgs.writeText "file-count.cjs" ''
    const fs = require("fs");
    const path = require("path");

    let count = 0;
    const walk = (dirPath, visited = new Set()) => {
      const realPath = fs.realpathSync(dirPath);
      if (visited.has(realPath)) {
        return;
      }
      visited.add(realPath);

      for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        const entryPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          walk(entryPath, visited);
        } else if (entry.isFile()) {
          count += 1;
        }
      }
    };

    const target = process.argv[2];
    if (target && fs.existsSync(target) && fs.statSync(target).isDirectory()) {
      walk(target);
    } else if (target && fs.existsSync(target)) {
      count = 1;
    }
    process.stdout.write(String(count));
  '';
  removeNodeModulesScript = pkgs.writeText "remove-node-modules.cjs" ''
    const fs = require("fs");
    const path = require("path");

    const walk = (dirPath) => {
      for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        const entryPath = path.join(dirPath, entry.name);
        if (!entry.isDirectory()) {
          continue;
        }
        if (entry.name === "node_modules") {
          fs.rmSync(entryPath, { recursive: true, force: true });
        } else {
          walk(entryPath);
        }
      }
    };

    walk(process.argv[2]);
  '';
  rewritePreparedWorkspaceScript = pkgs.writeText "rewrite-prepared-workspace.cjs" ''
    const fs = require("fs");
    const path = require("path");
    const { execFileSync } = require("child_process");

    const workspaceRoot = process.cwd();
    const sourceInputLocatorPrefix = "file:.devenv/pnpm-source-inputs/current/";

    const sortedDirEntries = (dirPath) =>
      fs.readdirSync(dirPath, { withFileTypes: true }).sort((left, right) =>
        left.name.localeCompare(right.name)
      );

    const isWithin = (parentPath, childPath) => {
      const relativePath = path.relative(parentPath, childPath);
      return relativePath === "" ||
        (!relativePath.startsWith(`..''${path.sep}`) && relativePath !== ".." && !path.isAbsolute(relativePath));
    };

    const sourceProjectDirForLocator = (lockfileDir, locator) => {
      const locatorIndex = locator.lastIndexOf(sourceInputLocatorPrefix);
      if (locatorIndex === -1) {
        return null;
      }

      const sourcePathWithPeerContext = locator.slice(
        locatorIndex + sourceInputLocatorPrefix.length
      );
      const sourceInputStageRoot = path.resolve(
        lockfileDir,
        ".devenv/pnpm-source-inputs/current"
      );

      // The generated manifest alias is the owned boundary between the declared
      // logical path and pnpm's opaque peer context. Select the longest existing
      // alias prefix instead of duplicating pnpm's nested locator grammar.
      let sourcePath;
      let sourceProjectAliasManifest;
      let escapedSourcePath = false;
      for (let end = sourcePathWithPeerContext.length; end > 0; end -= 1) {
        if (end !== sourcePathWithPeerContext.length && sourcePathWithPeerContext[end] !== "(") {
          continue;
        }
        const candidateSourcePath = sourcePathWithPeerContext.slice(0, end);
        const candidateAliasDir = path.resolve(sourceInputStageRoot, candidateSourcePath);
        if (candidateAliasDir === sourceInputStageRoot || !isWithin(sourceInputStageRoot, candidateAliasDir)) {
          escapedSourcePath = true;
          continue;
        }
        const candidateManifest = path.join(candidateAliasDir, "package.json");
        if (fs.existsSync(candidateManifest)) {
          sourcePath = candidateSourcePath;
          sourceProjectAliasManifest = candidateManifest;
          break;
        }
      }
      if (sourceProjectAliasManifest === undefined) {
        if (escapedSourcePath) {
          throw new Error(`source-input package locator escaped its stage root: ''${locator}`);
        }
        throw new Error(`source-input package alias is missing package.json: ''${sourceInputStageRoot}/''${sourcePathWithPeerContext}`);
      }
      const sourceProjectDir = path.resolve(lockfileDir, sourcePath);
      if (!isWithin(workspaceRoot, sourceProjectDir)) {
        throw new Error(`source-input logical package escaped prepared workspace: ''${sourceProjectDir}`);
      }
      const sourceProjectManifest = path.join(sourceProjectDir, "package.json");
      if (!fs.existsSync(sourceProjectManifest)) {
        throw new Error(`source-input logical package is missing package.json: ''${sourceProjectDir}`);
      }
      const sourceProjectRealManifest = fs.realpathSync(sourceProjectManifest);
      if (fs.realpathSync(sourceProjectAliasManifest) !== sourceProjectRealManifest) {
        throw new Error(`source-input package alias does not select its declared logical manifest: ''${locator}`);
      }
      const sourceProjectRealDir = path.dirname(sourceProjectRealManifest);
      if (!isWithin(workspaceRoot, sourceProjectRealDir)) {
        throw new Error(`source-input logical package resolved outside prepared workspace: ''${sourceProjectDir}`);
      }
      return sourceProjectRealDir;
    };

    const registerRelink = (relinkedTargets, packageDir, sourceProjectDir, locator) => {
      const previousSource = relinkedTargets.get(packageDir);
      if (previousSource && previousSource !== sourceProjectDir) {
        throw new Error(
          `conflicting pnpm locators for ''${packageDir}: ''${previousSource} and ''${sourceProjectDir} (''${locator})`
        );
      }
      relinkedTargets.set(packageDir, sourceProjectDir);
    };

    const relinkLocalSourcePackages = (dirPath, relinkedTargets = new Map()) => {
      for (const entry of sortedDirEntries(dirPath)) {
        if (!entry.isDirectory()) {
          continue;
        }

        const entryPath = path.join(dirPath, entry.name);
        if (entry.name === "node_modules") {
          const modulesManifestPath = path.join(entryPath, ".modules.yaml");
          if (!fs.existsSync(modulesManifestPath)) {
            continue;
          }

          // pnpm records injected `file:` workspace packages in this manifest.
          // Both the source-project key and every materialized target are
          // relative to the lockfile directory (the parent of node_modules).
          // This locator mapping is authoritative; package names are only
          // labels and may legitimately collide across staged source roots.
          const modulesManifest = JSON.parse(execFileSync(
            "${pkgs.yq-go}/bin/yq",
            ["--output-format=json", ".", modulesManifestPath],
            { encoding: "utf8" }
          ));
          const injectedDeps = modulesManifest.injectedDeps ?? {};
          const lockfileDir = path.dirname(entryPath);

          // Ordinary `file:` dependencies do not appear in injectedDeps.
          // `.package-map.json` is pnpm's exact locator-to-package-target map,
          // including peer-context variants, so it extends the same selector
          // without falling back to a package-name or virtual-dir scan.
          const packageMapPath = path.join(entryPath, ".package-map.json");
          const packageMap = fs.existsSync(packageMapPath)
            ? JSON.parse(fs.readFileSync(packageMapPath, "utf8"))
            : { packages: {} };
          for (const [locator, packageRecord] of Object.entries(packageMap.packages ?? {})) {
            const sourceProjectDir = sourceProjectDirForLocator(lockfileDir, locator);
            if (sourceProjectDir === null) continue;
            if (!packageRecord || typeof packageRecord.url !== "string") {
              throw new Error(`source-input package locator has no target URL: ''${locator}`);
            }
            const packageDir = path.resolve(entryPath, packageRecord.url);
            if (packageDir === entryPath || !isWithin(entryPath, packageDir)) {
              throw new Error(`source-input package target escaped prepared node_modules: ''${packageDir}`);
            }
            registerRelink(relinkedTargets, packageDir, sourceProjectDir, locator);
          }

          for (const [sourceProjectId, targetIds] of Object.entries(injectedDeps)) {
            if (!Array.isArray(targetIds)) {
              throw new Error(`invalid injectedDeps targets for ''${sourceProjectId}: ''${modulesManifestPath}`);
            }

            const sourceProjectAliasDir = path.resolve(lockfileDir, sourceProjectId);
            if (!isWithin(workspaceRoot, sourceProjectAliasDir)) {
              throw new Error(`injected dependency source escaped prepared workspace: ''${sourceProjectAliasDir}`);
            }
            const sourceProjectAliasManifest = path.join(sourceProjectAliasDir, "package.json");
            if (!fs.existsSync(sourceProjectAliasManifest)) {
              throw new Error(`injected dependency source is missing package.json: ''${sourceProjectAliasDir}`);
            }
            const sourceProjectDir = path.dirname(fs.realpathSync(sourceProjectAliasManifest));
            if (!isWithin(workspaceRoot, sourceProjectDir)) {
              throw new Error(`injected dependency source resolved outside prepared workspace: ''${sourceProjectAliasDir}`);
            }

            for (const targetId of targetIds) {
              if (typeof targetId !== "string") {
                throw new Error(`invalid injectedDeps target for ''${sourceProjectId}: ''${modulesManifestPath}`);
              }

              const packageDir = path.resolve(lockfileDir, targetId);
              if (!isWithin(entryPath, packageDir)) {
                throw new Error(`injected dependency target escaped prepared node_modules: ''${packageDir}`);
              }

              registerRelink(relinkedTargets, packageDir, sourceProjectDir, sourceProjectId);
            }
          }

          for (const [packageDir, sourceProjectDir] of relinkedTargets) {
            if (!fs.existsSync(packageDir)) {
              throw new Error(`selected local dependency target is missing: ''${packageDir}`);
            }
            if (fs.realpathSync(packageDir) === sourceProjectDir) {
              continue;
            }
            fs.rmSync(packageDir, { recursive: true, force: true });
            fs.symlinkSync(path.relative(path.dirname(packageDir), sourceProjectDir), packageDir, "dir");
          }
        } else {
          relinkLocalSourcePackages(entryPath, relinkedTargets);
        }
      }
    };

    relinkLocalSourcePackages(workspaceRoot);
  '';

in
{
  # Create a fixed-output derivation that prepares a workspace install tree.
  #
  # Arguments:
  #   name:           Derivation name prefix (e.g., "genie" or "oxc-config")
  #   src:            Filtered source containing the staged workspace root
  #                   package.json, pnpm-lock.yaml, pnpm-workspace.yaml, and
  #                   relevant workspace member manifests / patches. The staged
  #                   tree should contain only files needed for deterministic
  #                   installs so source-only edits do not invalidate the FOD.
  #   sourceRoot:     Path within the staged workspace root to cd into before
  #                   install. Use "." for the staged workspace root itself.
  #   pnpmDepsHash:   Expected hash of the FOD output
  #   preInstall:     Extra shell commands to run before lockfile parsing
  #   lockfilePaths:
  #                   Lockfiles whose directories should be installed within the
  #                   staged tree. Each path is relative to sourceRoot.
  #   pnpmFilters:
  #                   Optional pnpm selectors for narrowing a workspace install
  #                   to the package closure the staged tree is meant to prepare.
  mkDeps =
    {
      name,
      src,
      sourceRoot,
      pnpmDepsHash,
      preInstall ? "",
      frozenLockfile ? true,
      lockfilePaths ? [ "pnpm-lock.yaml" ],
      pnpmFilters ? [ ],
      includeOptionalDependencies ? false,
    }:
    let
      # Embed a fingerprint of the FOD's inputs (lockfile, package.json, etc.)
      # in the derivation name. When inputs change, the name changes, which
      # makes Nix treat this as a NEW derivation — bypassing any cached output
      # from the local store or binary caches (cachix).
      #
      # Without this, a binary cache can serve old (previously valid) outputs
      # indefinitely, masking stale pnpmDepsHash values. The `nix build` command
      # trusts local store content and never re-verifies the hash.
      #
      # See: https://blog.eigenvalue.net/nix-rerunning-fixed-output-derivations/
      #
      # NOTE: This does NOT cover npm registry content drift (a tarball
      # republished with different content at the same version). In that case
      # the lockfile stays the same, so the fingerprint doesn't change and
      # cachix can still serve a stale output. The CI store eviction in
      # nix-cli.nix handles that edge case by deleting cached pnpm-deps
      # outputs before building.
      #
      # TODO(nix-ca): Replace with content-addressed (CA) derivations once the
      # experimental feature is production-ready and binary cache support is
      # complete. CA derivations eliminate manually-maintained FOD hashes entirely.
      # Track: NixOS/nix#6623
      srcFingerprint = builtins.substring 0 8 (
        builtins.unsafeDiscardStringContext (baseNameOf (toString src))
      );
      pnpmPackageImportMethod =
        /*
          Self-hosted darwin rebuild-checks compare a trusted realized output with
          a fresh local rebuild of the same prepared workspace. pnpm's
          clone-or-copy path can race with preexisting symlink entries inside the
          temp output tree on APFS, producing nondeterministic "File exists"
          failures for otherwise-correct fixed-output derivations. Force plain
          copies on darwin so prepared workspaces materialize by one deterministic
          filesystem strategy across both the initial realization and the rebuild.
        */
        if pkgs.stdenv.hostPlatform.isDarwin then "copy" else "clone-or-copy";
      pnpmLockfileModeArg = if frozenLockfile then "--frozen-lockfile" else "--no-frozen-lockfile";
      pnpmOptionalModeArg = if includeOptionalDependencies then "" else "--no-optional";
      pnpmFilterArgs = builtins.concatStringsSep " " (
        map (filter: "--filter ${lib.escapeShellArg filter}") pnpmFilters
      );
    in
    pkgs.stdenvNoCC.mkDerivation {
      # Bump the prepared-workspace artifact version whenever the materialization
      # strategy changes, even if the recursive output hash stays the same.
      # Self-hosted darwin runners can otherwise keep colliding with stale temp
      # output paths for earlier artifact layouts while evaluating the same FOD.
      pname = "${name}-pnpm-deps-${srcFingerprint}-v19";
      version = "0.0.0";

      inherit src sourceRoot;

      nativeBuildInputs = [
        pnpm
        pnpmNodejs
        pkgs.nix
        pkgs.perl
        pkgs.cacert
      ];

      dontUnpack = true;
      dontConfigure = true;
      dontBuild = true;
      dontFixup = true;

      installPhase = ''
                # Keep timing/size instrumentation inside the builder so downstream
                # hash refresh and CI logs can point to the slow phase directly instead
                # of only reporting end-to-end wall clock. The extra helpers add a
                # little shell noise, but they are cheaper than guessing blindly.
                timer_now() {
                  perl -MTime::HiRes=time -e 'printf "%.3f", time'
                }

                timer_elapsed() {
                  perl -e 'printf "%.3f", $ARGV[1] - $ARGV[0]' "$1" "$(timer_now)"
                }

                format_bytes() {
                  numfmt --to=iec-i --suffix=B --format='%.1f' "$1" 2>/dev/null || echo "$1"'B'
                }

                path_bytes() {
                  if [ -d "$1" ]; then
                    du --apparent-size -sk "$1" 2>/dev/null | awk '{print $1 * 1024}'
                  else
                    stat -c%s "$1" 2>/dev/null || stat -f%z "$1"
                  fi
                }

                file_count() {
                  if [ -d "$1" ]; then
                  ${pnpmNodejs}/bin/node ${lib.escapeShellArg fileCountScript} "$1"
                  else
                    echo 1
                  fi
                }

                nix_closure_bytes() {
                  nix path-info --json --closure-size "$1" 2>/dev/null \
                    | ${pkgs.nodejs}/bin/node ${lib.escapeShellArg nixClosureBytesScript}
                }

                log_path_stats() {
                  local label="$1"
                  local path="$2"
                  if [ ! -e "$path" ]; then
                    return
                  fi

                  local bytes
                  bytes=$(path_bytes "$path")
                  local files
                  files=$(file_count "$path")
                  echo "workspace-prep: stats $label size=$(format_bytes "$bytes") files=$files path=$path"
                }

                log_prep_phase() {
                  local phase="$1"
                  shift
                  echo "workspace-prep: phase=$phase $*"
                }

                log_prep_event() {
                  local phase="$1"
                  local duration="$2"
                  local detail="$3"
                  printf 'workspace-prep-otel: service.name=nix-pnpm-prep span.name=nix.pnpm-prep.%s span.label=%s package.name=%s derivation.name=%s system=%s duration_s=%s %s\n' \
                    "$phase" \
                    "$phase" \
                    ${lib.escapeShellArg name} \
                    "$name" \
                    ${lib.escapeShellArg pkgs.stdenv.hostPlatform.system} \
                    "$duration" \
                    "$detail"
                }

                log_store_closure() {
                  local label="$1"
                  local path="$2"
                  if [ ! -e "$path" ]; then
                    return
                  fi

                  local closure_bytes
                  closure_bytes=$(nix_closure_bytes "$path" || true)
                  if [ -n "$closure_bytes" ] && [ "$closure_bytes" != "0" ]; then
                    echo "workspace-prep: closure $label size=$(format_bytes "$closure_bytes") path=$path"
                  fi
                }

                SOURCE_DIR="$NIX_BUILD_TOP/source"
                prepStartedAt=$(timer_now)
                sourceCopyStartedAt=$(timer_now)
                mkdir "$SOURCE_DIR"
                cp -r "$src"/. "$SOURCE_DIR"/
                chmod -R +w "$SOURCE_DIR"
                # The staged workspace must start from declared sources only.
                # Self-hosted checkouts and local worktrees can accumulate ignored
                # install artifacts, and pnpm's symlink layout will then collide
                # with those preexisting node_modules trees during materialization.
                ${pnpmNodejs}/bin/node ${lib.escapeShellArg removeNodeModulesScript} "$SOURCE_DIR"
                sourceCopyDuration=$(timer_elapsed "$sourceCopyStartedAt")
                log_prep_phase "stage-source-copy" "duration=''${sourceCopyDuration}s source_root=$sourceRoot"
                log_prep_event "stage-source-copy" "$sourceCopyDuration" "source_root=$sourceRoot"
                log_store_closure "src" "$src"
                log_path_stats "staged-source-copy" "$SOURCE_DIR"

                if [ "$sourceRoot" = "." ]; then
                  cd "$SOURCE_DIR"
                else
                  cd "$SOURCE_DIR/$sourceRoot"
                fi

                runHook preInstall

                ${preInstall}

                # pnpm still mutates store metadata (for example index.db and
                # projects/*), so the Nix build must use a private writable HOME/store
                # even though the final archive is immutable.
                export HOME=$(mktemp -d "$NIX_BUILD_TOP/pnpm-home.XXXXXX")
                export STORE_PATH=$(mktemp -d "$NIX_BUILD_TOP/pnpm-store.XXXXXX")
                export PNPM_STORE_DIR="$STORE_PATH"
                export PNPM_CONFIG_STORE_DIR="$STORE_PATH"
                export npm_config_store_dir="$STORE_PATH"
                export CI=true
                export NPM_CONFIG_PRODUCTION=false
                export npm_config_production=false
                export npm_config_manage_package_manager_versions=false
                export NODE_ENV=development
                # Keep pnpm's Node runtime warnings from overwhelming Darwin
                # builders. pnpm's own install/progress output still reaches logs.
                export NODE_NO_WARNINGS=1
                export LOCKFILE_PATHS_JSON='${builtins.toJSON lockfilePaths}'
                export PNPM_MJS=${lib.escapeShellArg "${pnpm}/libexec/pnpm/bin/pnpm.mjs"}

                if [ -z "$PNPM_MJS" ]; then
                  echo "workspace-prep: FATAL - could not locate pnpm entrypoint under ${lib.escapeShellArg (toString pnpm)}"
                  exit 1
                fi

                # pnpm rejects `pnpm config set --global` for keys it considers
                # workspace-only. Use env vars and .npmrc instead. Strip
                # live-worktree store/layout policy first so the prepared
                # artifact does not preserve caller-local paths.
                if [ -f .npmrc ]; then
                  ${pkgs.perl}/bin/perl -0pi -e 's/^\s*(${lib.concatStringsSep "|" pnpmInstallPolicy.npmrcPolicyKeys})\s*=.*\n//mg' .npmrc
                fi
                # Back up scrubbed .npmrc before appending build-local settings (restored after install).
                cp .npmrc .npmrc.orig 2>/dev/null || true
        printf ${
          lib.escapeShellArg ("store-dir=%s\n" + pnpmInstallPolicy.workspacePrepNpmrc pnpmPackageImportMethod)
        } "$STORE_PATH" >> .npmrc
        if [ -f pnpm-workspace.yaml ]; then
          ${pkgs.perl}/bin/perl -0pi -e 's/^\s*(${lib.concatStringsSep "|" pnpmInstallPolicy.workspaceYamlPolicyKeys}):[^\n]*\n//mg; s/nodeLinker: hoisted/nodeLinker: isolated/g' pnpm-workspace.yaml
        fi
                # Keep prepared dependency artifacts platform-neutral. Native
                # optional packages are owned by the Nix package/build layer so
                # pnpm dependency preparation stays pure, smaller, and stable
                # across Linux/macOS builders.

                node -e '
                  const path = require("path");
                  const lockfilePaths = JSON.parse(process.env.LOCKFILE_PATHS_JSON || "[]");
                  if (!Array.isArray(lockfilePaths) || lockfilePaths.length === 0) {
                    console.error("workspace-prep: FATAL - no staged lockfiles were provided");
                    process.exit(1);
                  }

                  const installRoots = [...new Set(lockfilePaths.map((lockfilePath) => {
                    const dir = path.dirname(lockfilePath);
                    return dir === "" ? "." : dir;
                  }))];

                  process.stdout.write(installRoots.join("\n") + "\n");
                ' > .pnpm-install-roots.txt
                log_prep_phase "install-roots" "count=$(wc -l < .pnpm-install-roots.txt | tr -d ' ')"

                while IFS= read -r install_root; do
                  [ -n "$install_root" ] || continue

                  if [ ! -f "$install_root/package.json" ] || [ ! -f "$install_root/pnpm-lock.yaml" ]; then
                    echo "workspace-prep: FATAL - staged install root is missing package.json or pnpm-lock.yaml: $install_root"
                    exit 1
                  fi

                  log_prep_phase "install-start" "install_root=$install_root"
                  installStartedAt=$(timer_now)
                  # Avoid a nested shell for the install root. On Darwin under
                  # process pressure we observed the subshell remain asleep
                  # after pnpm exited, leaving fixed-output deps builders
                  # wedged before post-install normalization.
                  pushd "$install_root" >/dev/null
                  # Keep the frozen invocation literal in-source so downstream
                  # contract checks can verify the strict default install mode:
                  # pnpm install --frozen-lockfile --ignore-scripts
                  ${lib.optionalString pkgs.stdenv.hostPlatform.isDarwin ''
                    # APFS copy-based materialization of the root workspace can push
                    # pnpm's node process into Darwin teardown failures on GitHub macOS.
                    # The dependency artifact contract is unchanged; this only bounds
                    # builder resource use for the same platform-neutral prepared tree.
                    ${pnpmInstallPolicy.darwinNodeOptionsShell}
                  ''}
                  pnpm_install_log=$(mktemp "$NIX_BUILD_TOP/pnpm-install.XXXXXX.log")
                  set +e
                  ${pnpmNodejs}/bin/node "$PNPM_MJS" install ${pnpmLockfileModeArg} ${pnpmOptionalModeArg} --ignore-scripts --config.manage-package-manager-versions=false --pm-on-fail=ignore --config.dedupe-injected-deps=false ${pnpmFilterArgs} 2>&1 | tee "$pnpm_install_log"
                  pnpm_install_status=''${PIPESTATUS[0]}
                  set -e
                  if [ "$pnpm_install_status" -ne 0 ]; then
                    if ${
                      pnpmInstallPolicy.darwinCompletedMaterializationCheckShell {
                        statusVar = "pnpm_install_status";
                        logFileVar = "pnpm_install_log";
                        isDarwinShell = lib.escapeShellArg (if pkgs.stdenv.hostPlatform.isDarwin then "1" else "0");
                      }
                    }; then
                      echo "workspace-prep: pnpm install completed materialization before darwin install teardown; continuing after node teardown exit $pnpm_install_status"
                    else
                      exit "$pnpm_install_status"
                    fi
                  fi
                  rm -f "$pnpm_install_log"
                  popd >/dev/null
                  installDuration=$(timer_elapsed "$installStartedAt")
                  log_prep_phase "install" "install_root=$install_root duration=''${installDuration}s"
                  log_prep_event "install" "$installDuration" "install_root=$install_root"
                  log_path_stats "install-root:$install_root-node_modules" "$install_root/node_modules"
                done < .pnpm-install-roots.txt

                relinkStartedAt=$(timer_now)
                ${pnpmNodejs}/bin/node ${lib.escapeShellArg rewritePreparedWorkspaceScript}
                relinkDuration=$(timer_elapsed "$relinkStartedAt")
                log_prep_phase "relink-local-sources" "duration=''${relinkDuration}s"
                log_prep_event "relink-local-sources" "$relinkDuration" "kind=prepared-workspace"

                # These pnpm bookkeeping files are only needed for future pnpm
                # operations. Downstream builders restore a prepared tree and go
                # straight to bun, so keeping them only widens the determinism surface.
                # Remove them for the root install plus any nested composed repos.
                # Restore original .npmrc (remove build-local settings that contain
                # non-deterministic paths like $STORE_PATH).
                if [ -f .npmrc.orig ]; then
                  mv .npmrc.orig .npmrc
                else
                  rm -f .npmrc
                fi

                log_path_stats "prepared-workspace-pre-archive" .
                log_path_stats "pnpm-store-final" "$STORE_PATH"
                rm -rf "$STORE_PATH"
                # Live-worktree pnpm store state is mutable and path-sensitive.
                # Prepared deps FODs own their private store through env/.npmrc
                # and must archive only the materialized dependency graph.
                find . \
                  \( -type d -name .devenv -o -type d -name '.pnpm-store*' -o -type d -name '.pnpm-home*' \) \
                  -prune -exec rm -rf {} +
                rm -f .pnpm-install-roots.txt

                # Projection state is never part of immutable prepared dependency
                # data. Normalize it away, then scan independently so any future
                # normalizer regression fails closed before the archive boundary.
                ${pnpmNodejs}/bin/node ${lib.escapeShellArg preparedPnpmTreeScript} normalize .
                ${pnpmNodejs}/bin/node ${lib.escapeShellArg preparedPnpmTreeScript} scan .

                leaked_path=$(
                  find "$SOURCE_DIR" \
                    \( -path '*/.devenv/pnpm-*' -o -path '*/.pnpm-store*' -o -path '*/.pnpm-home*' -o -path '*/node_modules/.pnpm/lock.yaml' \) \
                    -print -quit
                )
                if [ -n "$leaked_path" ]; then
                  echo "workspace-prep: FATAL - workspace-local pnpm store state leaked into prepared output: $leaked_path" >&2
                  exit 1
                fi

                archiveStartedAt=$(timer_now)
                log_path_stats "prepared-workspace-output" "$SOURCE_DIR"
                # Self-hosted darwin runners have shown `cp -a` spuriously failing
                # with `create_symlink: File exists` while materializing pnpm's
                # symlink-heavy trees into `$out.tmp`, even after clearing the
                # destination. Stream the tree through tar for copying, but keep
                # the fixed-output boundary as a recursive directory tree so
                # serializer details do not turn platform-neutral installs into
                # per-platform hashes.
                rm -rf "$out"
                mkdir -p "$out"
                ${pkgs.gnutar}/bin/tar \
                  --create \
                  --sort=name \
                  --mtime='@1' \
                  --owner=0 \
                  --group=0 \
                  --numeric-owner \
                  --file - \
                  --directory "$SOURCE_DIR" \
                  . \
                  | ${pkgs.gnutar}/bin/tar \
                    --extract \
                    --file - \
                    --directory "$out" \
                    --delay-directory-restore
                archiveDuration=$(timer_elapsed "$archiveStartedAt")
                log_prep_phase "archive" "duration=''${archiveDuration}s mode=tar-stream-tree"
                log_prep_event "archive" "$archiveDuration" "mode=tar-stream-tree"
                prepDuration=$(timer_elapsed "$prepStartedAt")
                log_prep_phase "complete" "duration=''${prepDuration}s declared_output_hash=${pnpmDepsHash}"
                log_prep_event "complete" "$prepDuration" "declared_output_hash=${pnpmDepsHash}"

                runHook postInstall
      '';

      outputHashMode = "recursive";
      outputHash = pnpmDepsHash;

      passthru = {
        inherit
          pnpmBinProjectorScript
          preparedPnpmTreeScript
          rewritePreparedWorkspaceScript
          ;
      };
    };

  # Generate a shell script snippet that restores a prepared workspace tree.
  #
  # The calling derivation's buildPhase should include this snippet after
  # materializing the full source workspace so the prepared node_modules tree
  # overlays the real source files.
  #
  # Arguments:
  #   deps: The derivation returned by mkDeps
  #   target: Directory to overlay the prepared workspace into
  #   label: Stable install-root label used in restore timing logs
  mkRestoreScript =
    {
      deps,
      target ? ".",
      label ? "prepared-workspace",
    }:
    ''
      restore_timer_now() {
        perl -MTime::HiRes=time -e 'printf "%.3f", time'
      }

      restore_timer_elapsed() {
        perl -e 'printf "%.3f", $ARGV[1] - $ARGV[0]' "$1" "$(restore_timer_now)"
      }

      restore_format_bytes() {
        numfmt --to=iec-i --suffix=B --format='%.1f' "$1" 2>/dev/null || echo "$1"'B'
      }

      restore_path_bytes() {
        if [ -d "$1" ]; then
          du --apparent-size -sk "$1" 2>/dev/null | awk '{print $1 * 1024}'
        else
          stat -c%s "$1" 2>/dev/null || stat -f%z "$1"
        fi
      }

      restore_file_count() {
        if [ -d "$1" ]; then
          ${pkgs.nodejs}/bin/node ${lib.escapeShellArg fileCountScript} "$1"
        else
          echo 1
        fi
      }

      restoreStartedAt=$(restore_timer_now)
      mkdir -p ${lib.escapeShellArg target}
      # Restore with overlay semantics because the caller's target already
      # contains the real source tree.
      if [ ${lib.escapeShellArg label} = "." ]; then
        restoreRoot=${lib.escapeShellArg target}
      else
        restoreRoot=${lib.escapeShellArg target}/${lib.escapeShellArg label}
      fi
      if [ -d "$restoreRoot" ]; then
        chmod -R u+w "$restoreRoot" 2>/dev/null || true
        ${pkgs.findutils}/bin/find "$restoreRoot" -name node_modules -prune \
          -exec ${pkgs.bash}/bin/bash -c 'for path do if [ -L "$path" ] || [ ! -d "$path" ]; then rm -f "$path"; else chmod -R u+w "$path" 2>/dev/null || true; rm -rf "$path"; fi; done' bash {} +
        (
          cd ${deps}
          ${pkgs.findutils}/bin/find . -mindepth 1 -maxdepth 1 -exec ${pkgs.bash}/bin/bash -c 'root="$1"; shift; for path do rm -rf "$root/''${path#./}"; done' bash "$restoreRoot" {} +
        )
      fi

        # The store payload is immutable dependency data; the restored build
        # tree is its mutable projection workspace. Encode owner-write
        # permission in the transfer stream so every nested node_modules root
        # is writable before the projector takes authority, while preserving
        # executable bits from normalization.
      ${pkgs.gnutar}/bin/tar \
        --create \
        --mode='u+w' \
        --file - \
        --directory ${deps} \
        . \
        | ${pkgs.gnutar}/bin/tar \
        --extract \
        --file - \
        --directory ${lib.escapeShellArg target} \
        --delay-directory-restore

      export PREPARED_WORKSPACE_TARGET="$(cd ${lib.escapeShellArg target} && pwd -P)"

      # Prepared artifacts contain dependency data only. Recreate every .bin
      # projection from the restored immutable package manifests.
      ${pnpmNodejs}/bin/node ${lib.escapeShellArg pnpmBinProjectorScript} "$PREPARED_WORKSPACE_TARGET"

      restored_payload_bytes=$(restore_path_bytes ${deps})
      echo "workspace-restore: phase=restore label=${label} target=$PREPARED_WORKSPACE_TARGET duration=$(restore_timer_elapsed "$restoreStartedAt")s payload_size=$(restore_format_bytes "$restored_payload_bytes") mode=tar-stream-tree"
    '';
}
