# Nix CLI build, FOD validation, and flake validation tasks
#
# Usage in devenv.nix:
#   imports = [
#     (inputs.effect-utils.devenvModules.tasks.nix-cli {
#       cliPackages = [
#         {
#           name = "genie";
#           flakeRef = ".#genie";
#           hashSource = "packages/@overeng/genie/nix/build.nix";
#           lockfile = "pnpm-lock.yaml";
#         }
#       ];
#     })
#   ];
#
# Provides:
#   - nix:build - Build all CLI packages
#   - nix:build:<name> - Build specific package
#   - nix:check - Check if any CLI hashes are stale (full build per package)
#   - nix:check:quick - Fast lockfile + package.json fingerprint check (for check:quick)
#   - nix:flake:check - Full flake validation (builds all packages, for check:all)
#
# Lockfile and Package.json Fingerprint Checks (nix:check:quick):
#   Each hashSource stores two fingerprint hashes for fast stale detection:
#
#   1. `lockfileHash` - SHA256 of pnpm-lock.yaml when pnpmDepsHash was last computed.
#      Detects lockfile changes without hash updates. This catches most stale hash
#      scenarios and runs in <1s vs 80-120s for full nix build.
#
#   2. `packageJsonDepsHash` - SHA256 of package.json dependency fields (dependencies,
#      devDependencies, peerDependencies). Detects when package.json deps changed
#      but lockfile wasn't updated (forgetting to run `pnpm install`).
#
#   Trade-off: May have rare false positives (cosmetic changes) or false negatives
#   (patch files changed). CI runs full `nix:flake:check` as backup.
#
# nix:flake:check vs nix:check:
#   - nix:check - Validates individual CLI package hashes (per-package builds)
#   - nix:flake:check - Runs `nix flake check` (validates entire flake, all packages)
{
  cliPackages ? [ ],
}:
{ pkgs, lib, ... }:
let
  trace = import ../lib/trace.nix { inherit lib; };
  hashSourceHelpers = ''
    read_hash_from_file() {
      local hashKey="$1"
      local hashSourcePath="$2"
      local packageName="$3"

      if grep -qE "(^|[[:space:]])(\"$packageName\"|$packageName)\\s*=" "$hashSourcePath"; then
        HASH_KEY="$hashKey" PKG_NAME="$packageName" ${pkgs.perl}/bin/perl -0777 -ne '
          my $pkg = $ENV{"PKG_NAME"};
          my $key = $ENV{"HASH_KEY"};
          my $attr = qr/(?:\Q$pkg\E|"\Q$pkg\E")/;
          if (/($attr\s*=\s*\{.*?\b\Q$key\E\s*=\s*)"([^"]+)"/s) {
            print $2;
          }
        ' "$hashSourcePath"
      else
        local directHash
        directHash=$(grep -oE "$hashKey\\s*=\\s*\"sha256-[^\"]+\"" "$hashSourcePath" | grep -oE 'sha256-[^"]+' | head -1 || true)
        if [ -n "$directHash" ]; then
          printf '%s\n' "$directHash"
          return
        fi

        if [ "$hashKey" = "bunDepsHash" ] || [ "$hashKey" = "pnpmDepsHash" ]; then
          ${pkgs.perl}/bin/perl -0777 -ne '
            if (/depsBuilds\s*=\s*\{.*?"\."\s*=\s*\{.*?\bhash\s*=\s*"([^"]+)"/s) {
              print $1;
            }
          ' "$hashSourcePath"
        fi
      fi
    }
  '';

  # Script to check if hash is stale (for CI)
  # Detects both Nix hash mismatch and custom bun.lock staleness check
  checkHashScript = pkgs.writeShellScript "check-hash" ''
    set -euo pipefail

    flakeRef="$1"
    name="$2"
    hashSource="''${3-}"
    lockfile="''${4-}"
    packageJson="''${5-}"

    ${hashSourceHelpers}

    # Preflight: ensure lockfile/package.json fingerprints match hashSource
    # This avoids false passes on warmed Nix stores (R5: deterministic checks).
    if [ -n "$hashSource" ] && [ -n "$lockfile" ] && [ -f "$lockfile" ]; then
      if [ -z "$packageJson" ]; then
        packageJson="$(dirname "$lockfile")/package.json"
      fi

      currentLockfileHash="sha256-$(${pkgs.nix}/bin/nix-hash --type sha256 --base64 "$lockfile")"
      storedLockfileHash=$(read_hash_from_file "lockfileHash" "$hashSource" "$name")

      if [ -z "$storedLockfileHash" ]; then
        echo "⚠ $name: no lockfileHash in hashSource, skipping lockfile check"
      elif [ "$currentLockfileHash" != "$storedLockfileHash" ]; then
        echo "✗ $name: lockfile changed (refresh Nix FOD hashes for $name)"
        echo "  stored:  $storedLockfileHash"
        echo "  current: $currentLockfileHash"
        exit 1
      fi

      if [ -f "$packageJson" ]; then
        tmpDeps=$(mktemp)
        ${pkgs.jq}/bin/jq -cS '{dependencies, devDependencies, peerDependencies}' "$packageJson" > "$tmpDeps"
        currentPackageJsonDepsHash="sha256-$(${pkgs.nix}/bin/nix-hash --type sha256 --base64 "$tmpDeps")"
        rm "$tmpDeps"

        storedPackageJsonDepsHash=$(read_hash_from_file "packageJsonDepsHash" "$hashSource" "$name")

        if [ -z "$storedPackageJsonDepsHash" ]; then
          echo "⚠ $name: no packageJsonDepsHash in hashSource, skipping deps check"
        elif [ "$currentPackageJsonDepsHash" != "$storedPackageJsonDepsHash" ]; then
          echo "✗ $name: package.json deps changed (run: pnpm install, then refresh Nix FOD hashes for $name)"
          echo "  stored:  $storedPackageJsonDepsHash"
          echo "  current: $currentPackageJsonDepsHash"
          exit 1
        fi
      fi
    fi

    # [CI-only] Evict cached pnpm-deps FOD outputs so Nix must re-derive them.
    # Cachix can serve stale FOD outputs (keyed by declared hash, not build
    # inputs), masking hash staleness. Evicting the specific outputs forces a
    # fresh build whose actual hash is compared against the declared hash.
    # NOTE: We evict only the FOD outputs (not all deps) so transitive
    # dependencies can still be substituted from cache.
    # TODO(nix-ca): Remove once content-addressed derivations are stable (NixOS/nix#6623).
    if [ -n "''${CI:-}" ]; then
      topDrv=$(${pkgs.nix}/bin/nix path-info --derivation "$flakeRef" 2>/dev/null || true)
      if [ -n "$topDrv" ]; then
        for drv in $(${pkgs.nix}/bin/nix-store -qR "$topDrv" 2>/dev/null | grep "pnpm-deps-[a-z0-9]*-v[0-9].*\.drv$" || true); do
          for outPath in $(${pkgs.nix}/bin/nix-store -q --outputs "$drv" 2>/dev/null || true); do
            if ${pkgs.nix}/bin/nix path-info "$outPath" >/dev/null 2>&1; then
              echo "  evicting cached: $(basename "$outPath")"
              ${pkgs.nix}/bin/nix store delete --ignore-liveness "$outPath" >/dev/null 2>&1 || true
            fi
          done
        done
      fi
    fi

    if output=$(${pkgs.nix}/bin/nix build "$flakeRef" --no-link --option substituters "https://cache.nixos.org" 2>&1); then
      echo "✓ $name: up to date"
      exit 0
    fi

    # Check for Nix hash mismatch
    if echo "$output" | grep -qE 'got:\s+sha256-'; then
      mismatchDrv=$(printf '%s\n' "$output" | ${pkgs.perl}/bin/perl -ne '
        if (/hash mismatch in fixed-output derivation \x27([^\x27]+)\x27/) {
          print "$1\n";
          exit 0;
        }
      ' | head -1 || true)
      gotHash=$(echo "$output" | grep -oE 'got:\s+sha256-[A-Za-z0-9+/=]+' | grep -oE 'sha256-[A-Za-z0-9+/=]+' | head -1 || true)
      expectedHash=$(echo "$output" | grep -oE 'specified:\s+sha256-[A-Za-z0-9+/=]+' | grep -oE 'sha256-[A-Za-z0-9+/=]+' | head -1 || true)
      echo "✗ $name: deps hash is stale (refresh Nix FOD hashes for $name)"
      if [ -n "$expectedHash" ]; then
        echo "  expected: $expectedHash"
      fi
      if [ -n "$gotHash" ]; then
        echo "  got:      $gotHash"
      fi
      if [ -n "$mismatchDrv" ]; then
        echo "  drv:      $mismatchDrv"
        if drvJson=$(${pkgs.nix}/bin/nix derivation show "$mismatchDrv" 2>/dev/null); then
          # Newer Nix versions return the derivation map at the top level,
          # while older ones nest it under `.derivations`. Accept both so
          # stale-hash diagnostics stay informative instead of failing with a
          # secondary jq error.
          echo "$drvJson" | ${pkgs.jq}/bin/jq -r '
            ((.derivations // .) | to_entries[0]?.value?.env?) // {}
            | {
                system,
                src,
                nativeBuildInputs,
                outputHash
              }
            | to_entries[]
            | "  \(.key): \(.value)"
          ' || true
        fi
      fi
      exit 1
    fi

    if echo "$output" | grep -q 'lockfileHash is stale'; then
      echo "✗ $name: lockfileHash is stale (refresh Nix FOD hashes for $name)"
      exit 1
    fi

    # Check for custom bun.lock staleness
    if echo "$output" | grep -q 'deps hash is stale'; then
      echo "✗ $name: lockfile changed, deps hash is stale (refresh Nix FOD hashes for $name)"
      exit 1
    fi

    # Check for pnpm lockfile staleness (new deps added but not locked)
    if echo "$output" | grep -qE 'ERR_PNPM_OUTDATED_LOCKFILE|lockfile.*not up to date'; then
      echo "✗ $name: pnpm lockfile is stale (new deps added but not locked)"
      echo ""
      echo "To fix:"
      echo "  1. Run: devenv tasks run pnpm:update     # Update the repo-root pnpm lockfile"
      echo "  2. Refresh Nix FOD hashes for $name"
      echo "  3. Commit: pnpm-lock.yaml changes and hashSource updates"
      echo ""
      exit 1
    fi

    if echo "$output" | grep -qi 'ERR_PNPM_NO_OFFLINE_TARBALL'; then
      echo "✗ $name: prepared pnpm install tree is stale or incomplete"
      echo ""
      echo "To fix:"
      echo "  1. Refresh prepared install FODs for $name"
      echo "  2. If lockfiles changed: devenv tasks run pnpm:update"
      echo ""
      exit 1
    fi

    echo "✗ $name: build failed"
    echo "$output"
    exit 1
  '';

  # Script for quick lockfile/deps fingerprint check (for check:quick)
  # Checks two things:
  # 1. lockfileHash - detects lockfile changes without hash update
  # 2. packageJsonDepsHash - detects package.json changes without lockfile update
  quickCheckScript = pkgs.writeShellScript "check-lockfile-hash" ''
    set -euo pipefail

    name="$1"
    hashSource="$2"
    lockfile="$3"
    packageJson="''${4-}"

    ${hashSourceHelpers}

    if [ -z "$packageJson" ]; then
      packageJson="$(dirname "$lockfile")/package.json"
    fi
    failed=false

    # Check 1: lockfileHash (lockfile changed without hash update)
    currentLockfileHash=$(${pkgs.nix}/bin/nix-hash --type sha256 --base64 "$lockfile" 2>/dev/null || echo "")
    if [ -z "$currentLockfileHash" ]; then
      echo "⚠ $name: lockfile not found ($lockfile), skipping lockfile check"
    else
      currentLockfileHash="sha256-$currentLockfileHash"
      storedLockfileHash=$(read_hash_from_file "lockfileHash" "$hashSource" "$name")

      if [ -z "$storedLockfileHash" ]; then
        echo "⚠ $name: no lockfileHash in hashSource, skipping lockfile check"
      elif [ "$currentLockfileHash" != "$storedLockfileHash" ]; then
        echo "✗ $name: lockfile changed (refresh Nix FOD hashes for $name)"
        echo "  stored:  $storedLockfileHash"
        echo "  current: $currentLockfileHash"
        failed=true
      fi
    fi

    # Check 2: packageJsonDepsHash (package.json deps changed without lockfile update)
    if [ -f "$packageJson" ]; then
      tmpDeps=$(mktemp)
      ${pkgs.jq}/bin/jq -cS '{dependencies, devDependencies, peerDependencies}' "$packageJson" > "$tmpDeps"
      currentPackageJsonDepsHash="sha256-$(${pkgs.nix}/bin/nix-hash --type sha256 --base64 "$tmpDeps")"
      rm "$tmpDeps"

      storedPackageJsonDepsHash=$(read_hash_from_file "packageJsonDepsHash" "$hashSource" "$name")

      if [ -z "$storedPackageJsonDepsHash" ]; then
        echo "⚠ $name: no packageJsonDepsHash in hashSource, skipping deps check"
      elif [ "$currentPackageJsonDepsHash" != "$storedPackageJsonDepsHash" ]; then
        echo "✗ $name: package.json deps changed (run: pnpm install, then refresh Nix FOD hashes for $name)"
        echo "  stored:  $storedPackageJsonDepsHash"
        echo "  current: $currentPackageJsonDepsHash"
        failed=true
      fi
    fi

    if [ "$failed" = true ]; then
      exit 1
    fi

    echo "✓ $name: lockfile and deps unchanged"
  '';

  mkBuildTask = pkg: {
    "nix:build:${pkg.name}" = {
      description = "Build ${pkg.name} Nix package";
      exec = trace.exec "nix:build:${pkg.name}" "${pkgs.nix}/bin/nix build '${pkg.flakeRef}' --no-link -L";
    };
  };

  mkCheckTask = pkg: {
    "nix:check:${pkg.name}" = {
      description = "Check if ${pkg.name} hash is stale (full build)";
      exec = trace.exec "nix:check:${pkg.name}" "${checkHashScript} '${pkg.flakeRef}' '${pkg.name}' '${pkg.hashSource}' '${pkg.lockfile or ""}' '${pkg.packageJson or ""}'";
    };
  };

  # Quick check using lockfile fingerprint (for check:quick)
  mkQuickCheckTask =
    pkg:
    lib.optionalAttrs (pkg ? lockfile) {
      "nix:check:quick:${pkg.name}" = {
        description = "Quick lockfile check for ${pkg.name}";
        exec = trace.exec "nix:check:quick:${pkg.name}" "${quickCheckScript} '${pkg.name}' '${pkg.hashSource}' '${pkg.lockfile}' '${pkg.packageJson or ""}'";
      };
    };

  # Full hash validation rebuilds whole prepared pnpm dependency roots. Running
  # every CLI package at once is faster on large Linux builders but can exceed
  # Darwin runner memory; keep package validation sequential at the aggregate
  # task while leaving per-package tasks available for targeted checks.
  sequentialNixCheckScript = pkgs.writeShellScript "nix-check-all" (
    lib.concatStringsSep "\n" (
      [
        "set -euo pipefail"
      ]
      ++ map (
        pkg:
        "${checkHashScript} '${pkg.flakeRef}' '${pkg.name}' '${pkg.hashSource}' '${pkg.lockfile or ""}' '${pkg.packageJson or ""}'"
      ) cliPackages
    )
  );

  # Filter packages that have lockfile defined
  packagesWithLockfile = builtins.filter (p: p ? lockfile) cliPackages;

  hasPackages = cliPackages != [ ];

in
lib.mkIf hasPackages {
  tasks = lib.mkMerge (
    # Per-package tasks
    (map mkBuildTask cliPackages)
    ++ (map mkCheckTask cliPackages)
    ++ (map mkQuickCheckTask packagesWithLockfile)
    ++
      # Aggregate tasks
      [
        {
          "nix:build" = {
            description = "Build all CLI Nix packages";
            after = map (p: "nix:build:${p.name}") cliPackages;
          };

          "nix:check" = {
            description = "Check if any CLI hashes are stale (for CI, full build)";
            exec = trace.exec "nix:check" "${sequentialNixCheckScript}";
          };

          "nix:check:quick" = {
            description = "Quick lockfile fingerprint check for all CLI packages";
            after = map (p: "nix:check:quick:${p.name}") packagesWithLockfile;
          };

          "nix:flake:check" = {
            description = "Full nix flake validation (builds all flake packages)";
            exec = trace.exec "nix:flake:check" "${pkgs.nix}/bin/nix flake check";
          };
        }
      ]
  );
}
