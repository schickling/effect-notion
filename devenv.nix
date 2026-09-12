{
  pkgs,
  inputs,
  config,
  lib,
  ...
}:
let
  # `git+file://` and not a bare path: `builtins.getFlake (toString ./.)`
  # parses as a `path:` flakeref, which copies the entire working directory —
  # gitignored `.devenv/` included, 546 MB / 25,142 files against 18 MB / 2,746
  # for the git-tracked view — into the store on every eval, and re-copies it
  # whenever devenv writes its own state. Measured 82.4 s -> 14.6 s median on a
  # forced eval-cache miss.
  #
  # The assertion is the other half. `git+file://` needs `./.` to be a real
  # worktree, and #1190 is what happens when it is not: config evaluated from a
  # store-backed source has no `.git`, and this expression dies where a bare
  # path would have limped on.
  repoFlake =
    assert lib.assertMsg (builtins.pathExists (./. + "/.git")) ''
      devenv.nix: `repoFlake` needs `./.` to be a real git worktree, and
      ${toString ./.} has no `.git`.

      This is the #1190 regression: `builtins.getFlake "git+file://…"` is fine
      while `./.` is a checkout and fails the moment this file is evaluated
      from a store path. If you moved config evaluation onto a store-backed
      source, pass that source in explicitly rather than re-deriving it here.
    '';
    builtins.getFlake "git+file://${toString ./.}";
  currentSystem = pkgs.stdenv.hostPlatform.system;
  flakePkgs = import repoFlake.inputs.nixpkgs { system = currentSystem; };
  trackedBuck2Products = import ./nix/buck2-products { pkgs = flakePkgs; };
  # `restate` ships under BSL-1.1; scope allowUnfree to just that package so the
  # rest of the closure stays free-only.
  restatePkgs = import repoFlake.inputs.nixpkgs {
    system = currentSystem;
    config.allowUnfreePredicate = pkg: builtins.elem (pkgs.lib.getName pkg) [ "restate" ];
  };
  restate = import ./nix/restate.nix { pkgs = restatePkgs; };
  cliBuildStamp = import ./nix/workspace-tools/lib/cli-build-stamp.nix { inherit pkgs; };
  # Use npm oxlint with NAPI bindings and the two tracked Buck plugin modules.
  oxlintNpm = import ./nix/oxlint-npm.nix {
    pkgs = flakePkgs;
    bun = flakePkgs.bun;
    products = trackedBuck2Products.products;
  };
  oxlintWithPlugins = import ./nix/oxlint-with-plugins.nix {
    inherit pkgs oxlintNpm;
  };
  nodePtyNative = import ./nix/node-pty-native.nix { inherit pkgs; };
  pnpmTaskHelpersScript = pkgs.writeText "pnpm-task-helpers.sh" (
    builtins.readFile ./nix/devenv-modules/tasks/shared/pnpm-task-helpers.sh
  );
  rustCrates = [
    {
      name = "otelite";
      path = "packages/@overeng/otelite";
    }
    {
      name = "otel-scrape";
      path = "packages/@overeng/otel-scrape";
    }
  ];
  grep = "${pkgs.gnugrep}/bin/grep";
  head = "${pkgs.coreutils}/bin/head";
  rg = "${pkgs.ripgrep}/bin/rg";
  tail = "${pkgs.coreutils}/bin/tail";
  trace = import ./nix/devenv-modules/tasks/lib/trace.nix { inherit lib; };

  # Shared task modules (from shared/ directory)
  taskModules = {
    genie = ./nix/devenv-modules/tasks/shared/genie.nix;
    worktree-guard = import ./nix/devenv-modules/tasks/shared/worktree-guard.nix;
    setup = import ./nix/devenv-modules/tasks/shared/setup.nix;
    check = import ./nix/devenv-modules/tasks/shared/check.nix;
    clean = import ./nix/devenv-modules/tasks/shared/clean.nix;
    test = import ./nix/devenv-modules/tasks/shared/test.nix;
    test-playwright = import ./nix/devenv-modules/tasks/shared/test-playwright.nix;
    storybook = import ./nix/devenv-modules/tasks/shared/storybook.nix;
    netlify = import ./nix/devenv-modules/tasks/shared/netlify.nix;
    workflow-report = import ./nix/devenv-modules/tasks/shared/workflow-report.nix;
    lint-genie = ./nix/devenv-modules/tasks/shared/lint-genie.nix;
    lint-nix = import ./nix/devenv-modules/tasks/shared/lint-nix.nix;
    nix-cli = import ./nix/devenv-modules/tasks/shared/nix-cli.nix;
    lint-oxc = import ./nix/devenv-modules/tasks/shared/lint-oxc.nix;
    bun = import ./nix/devenv-modules/tasks/shared/bun.nix;
    pnpm = import ./nix/devenv-modules/tasks/shared/pnpm.nix;
    megarepo = import ./nix/devenv-modules/tasks/shared/megarepo.nix;
    secretspec = import ./nix/devenv-modules/tasks/shared/secretspec.nix;
    bootstrap-closure = import ./nix/devenv-modules/tasks/shared/bootstrap-closure.nix;
    weaver = import ./nix/devenv-modules/tasks/shared/weaver.nix;
    weaver-diff = import ./nix/devenv-modules/tasks/shared/weaver-diff.nix;
    weaver-live-check = import ./nix/devenv-modules/tasks/shared/weaver-live-check.nix;
    weaver-version-smoke = import ./nix/devenv-modules/tasks/shared/weaver-version-smoke.nix;
    context = ./nix/devenv-modules/tasks/shared/context.nix;
    devenv-module-tests = ./nix/devenv-modules/tasks/local/devenv-module-tests.nix;
  };
  # Repository CLIs come from the reviewed Buck product boundary, not from a
  # source entrypoint that exists only here. The activated shell, the flake
  # outputs, and CI therefore run the same content-addressed bytes, so a task
  # cannot pass locally against a source tree and fail against the product.
  repoPackages = repoFlake.packages.${currentSystem};

  # Real packages backing guarded command names. The cli-guards own bin/<name>
  # and exec these via absolute store path under passthrough, so they are passed
  # as `*Pkg` reals to the task modules instead of also being top-level profile
  # providers (which would collide with the guards in buildEnv). See cli-guard.nix.
  pnpmPkg = import ./nix/pnpm.nix { inherit pkgs; };
  genieCli = repoPackages.genie;
  mrCli = repoPackages.megarepo;
  ciToolsCli = repoPackages.ci-tools;
  tuiStoriesCli = repoPackages.tui-stories;
  genieBootstrapClosureCheckCli = repoPackages.genie-bootstrap-closure-check;
  buck2Machine = import ./nix/buck2.nix { pkgs = flakePkgs; };
  buck2Stage0Definition = import ./nix/buck2-stage0-tools.nix { inherit pkgs; };

  # The generated root package manifest is the workspace package authority.
  # Consuming it here removes the former hand-maintained Nix package list and
  # makes Genie freshness the single stage-zero synchronization boundary.
  allPackages = (builtins.fromJSON (builtins.readFile ./package.json)).workspaces;

  packageTestQuarantine = { };
  validatedPackageTestQuarantine = lib.mapAttrs (
    name: quarantine:
    if quarantine ? reason && quarantine ? issue then
      quarantine
    else
      throw "packageTestQuarantine.${name} must include reason and issue"
  ) packageTestQuarantine;
  packagesRoot = ./. + "/packages/@overeng";
  hasTestFiles =
    root:
    let
      scan =
        dir:
        if builtins.pathExists dir then
          let
            entries = builtins.readDir dir;
            names = builtins.attrNames entries;
          in
          builtins.any (
            name:
            let
              entryType = entries.${name};
              child = dir + "/${name}";
            in
            if entryType == "regular" then
              builtins.match ".*\\.(spec|test)\\.(cjs|cts|js|jsx|mjs|mts|ts|tsx)" name != null
            else if entryType == "directory" then
              scan child
            else
              false
          ) names
        else
          false;
    in
    scan (root + "/src") || scan (root + "/test");
  # Packages that have Vitest tests are discovered from the filesystem. If a
  # package with tests is excluded, it must be visible debt in packageTestQuarantine.
  packagesWithTests =
    let
      packageNames = builtins.filter (
        name:
        let
          root = packagesRoot + "/${name}";
        in
        (builtins.readDir packagesRoot).${name} == "directory"
        && builtins.pathExists (root + "/package.json")
        && hasTestFiles root
        && !(builtins.hasAttr name validatedPackageTestQuarantine)
      ) (builtins.attrNames (builtins.readDir packagesRoot));
    in
    map (name: {
      path = "packages/@overeng/${name}";
      inherit name;
    }) packageNames;

  # Generated bridge between the package-local Buck test declarations and the devenv task
  # graph. It is the single semantic registry for which suites Buck executes; nothing here
  # re-derives lane membership — it only refuses a bridge that does not conform, because a
  # silently shrunken or malformed registry would hand admitted suites back to source Vitest.
  buck2TestAuthorityFile = ./buck2-test-authority.json;
  buck2TestAuthority = builtins.fromJSON (builtins.readFile buck2TestAuthorityFile);
  # Deliberate floor, not a derived value: shrinking the registry means editing this number.
  buck2TestAuthorityMinimumLanes = 34;
  buck2TestAuthorityLanes =
    if (buck2TestAuthority.schemaVersion or null) == 2 then
      buck2TestAuthority.lanes
    else
      throw "buck2-test-authority.json is not a schemaVersion 2 test authority";
  # Exactly the target-name shape the Buck projection accepts; keep in lockstep with it.
  testTargetNamePattern = "[a-z][a-z0-9_]*";
  normalizedRelativePath =
    value:
    value != ""
    && !(lib.hasInfix "\\" value)
    && builtins.all (segment: segment != "" && segment != "." && segment != "..") (
      lib.splitString "/" value
    );
  buck2TestLaneIssues =
    lane:
    let
      labelPrefix = "effect_utils//${lane.packagePath}:";
      hasLabelPrefix = lib.hasPrefix labelPrefix lane.target;
      targetName = lib.removePrefix labelPrefix lane.target;
      expectedTaskName =
        if !hasLabelPrefix || targetName == "test" then
          "test:${lane.packageName}"
        else
          "test:${lane.packageName}:${targetName}";
      sourceFiles = builtins.filter (
        file: !(builtins.elem file lane.selectedTestFiles) || builtins.elem file lane.excludes
      ) lane.testFiles;
      sourceOwnerFiles = builtins.attrNames lane.sourceOwners;
      expectedUnboundedFiles = builtins.filter (
        file: !(builtins.hasAttr file lane.sourceOwners)
      ) sourceFiles;
      taskNamePattern = "[a-z0-9][a-z0-9:-]*";
      validTaskName = value: builtins.match taskNamePattern value != null;
      prefix = "lane ${lane.target}: ";
    in
    lib.optional (!(normalizedRelativePath lane.packagePath)) (
      "${prefix}packagePath ${lane.packagePath} is not a normalized relative path"
    )
    ++ lib.optional (lane.packageName != lib.last (lib.splitString "/" lane.packagePath)) (
      "${prefix}packageName ${lane.packageName} is not the last segment of ${lane.packagePath}"
    )
    ++ lib.optional (!hasLabelPrefix || builtins.match testTargetNamePattern targetName == null) (
      "${prefix}target is not ${labelPrefix}<name> with a ${testTargetNamePattern} name"
    )
    ++ lib.optional (lane.taskName != expectedTaskName) (
      "${prefix}taskName ${lane.taskName} is not the derived ${expectedTaskName}"
    )
    ++ lib.optional (lane.testFiles == [ ]) "${prefix}testFiles is empty"
    ++ lib.optional (!(builtins.all normalizedRelativePath lane.testFiles)) (
      "${prefix}testFiles contains a non-normalized package-relative path"
    )
    ++ lib.optional (lane.testFiles != builtins.sort builtins.lessThan lane.testFiles) (
      "${prefix}testFiles is not byte-sorted"
    )
    ++ lib.optional (
      lib.unique lane.testFiles != lane.testFiles
    ) "${prefix}testFiles contains a duplicate"
    ++ lib.optional (lane.selectedTestFiles == [ ]) "${prefix}selectedTestFiles is empty"
    ++ lib.optional (!(builtins.all (file: builtins.elem file lane.testFiles) lane.selectedTestFiles)) (
      "${prefix}selectedTestFiles contains a file outside testFiles"
    )
    ++ lib.optional (
      lane.selectedTestFiles != builtins.sort builtins.lessThan lane.selectedTestFiles
    ) "${prefix}selectedTestFiles is not byte-sorted"
    ++ lib.optional (lib.unique lane.selectedTestFiles != lane.selectedTestFiles) (
      "${prefix}selectedTestFiles contains a duplicate"
    )
    ++ lib.optional (!(builtins.all (file: builtins.elem file lane.selectedTestFiles) lane.excludes)) (
      "${prefix}excludes contains a file outside selectedTestFiles"
    )
    ++ lib.optional (lane.excludes != builtins.sort builtins.lessThan lane.excludes) (
      "${prefix}excludes is not byte-sorted"
    )
    ++ lib.optional (lib.unique lane.excludes != lane.excludes) "${prefix}excludes contains a duplicate"
    ++ lib.optional (!(builtins.all (file: builtins.elem file sourceFiles) sourceOwnerFiles)) (
      "${prefix}sourceOwners contains a file that is not source-owned"
    )
    ++ lib.optional (!(builtins.all validTaskName (builtins.attrValues lane.sourceOwners))) (
      "${prefix}sourceOwners contains an unsafe task name"
    )
    ++ lib.optional (lane.unboundedFiles != expectedUnboundedFiles) (
      "${prefix}unboundedFiles is not the source census minus explicit sourceOwners"
    )
    ++ lib.optional (!(builtins.all validTaskName lane.unboundedAfter)) (
      "${prefix}unboundedAfter contains an unsafe task name"
    )
    ++ lib.optional (lib.unique lane.unboundedAfter != lane.unboundedAfter) (
      "${prefix}unboundedAfter contains a duplicate"
    )
    ++ lib.optional ((lane ? unboundedTaskName) != (lane.unboundedFiles != [ ])) (
      "${prefix}unboundedTaskName must be declared exactly when unboundedFiles is non-empty"
    )
    ++ lib.optional ((lane.unboundedFiles == [ ]) && (lane.unboundedAfter != [ ])) (
      "${prefix}unboundedAfter is non-empty without an unbounded complement"
    )
    ++ lib.optional (
      (lane ? unboundedTaskName) && lane.unboundedTaskName != "${lane.taskName}:unbounded"
    ) "${prefix}unboundedTaskName is not ${lane.taskName}:unbounded"
    ++ lib.optional (
      lane.runner == "vitest" && (lane.collectionTarget or null) != "${lane.target}_collect"
    ) "${prefix}vitest lane must declare collectionTarget ${lane.target}_collect"
    ++ lib.optional (lane.runner != "vitest" && lane ? collectionTarget) (
      "${prefix}${lane.runner} lane must not declare a collectionTarget"
    )
    ++ lib.optional (
      !(builtins.elem lane.runner [
        "bun"
        "shell"
        "vitest"
      ])
    ) ("${prefix}runner ${lane.runner} is not one of bun, shell, vitest");
  buck2TestAuthorityTargets = map (lane: lane.target) buck2TestAuthorityLanes;
  buck2TestAuthorityTaskNames = builtins.concatMap (
    lane: [ lane.taskName ] ++ lib.optional (lane ? unboundedTaskName) lane.unboundedTaskName
  ) buck2TestAuthorityLanes;
  buck2TestAuthorityCollectionTargets = builtins.concatMap (
    lane: lib.optional (lane ? collectionTarget) lane.collectionTarget
  ) buck2TestAuthorityLanes;
  buck2TestAuthorityIssues =
    builtins.concatMap buck2TestLaneIssues buck2TestAuthorityLanes
    ++
      lib.optional (builtins.length buck2TestAuthorityLanes < buck2TestAuthorityMinimumLanes)
        "registry declares ${toString (builtins.length buck2TestAuthorityLanes)} lanes, fewer than the ${toString buck2TestAuthorityMinimumLanes} it must carry"
    ++ lib.optional (
      buck2TestAuthorityTargets != builtins.sort builtins.lessThan buck2TestAuthorityTargets
    ) "lanes are not byte-sorted by target"
    ++ lib.optional (lib.unique buck2TestAuthorityTargets != buck2TestAuthorityTargets) (
      "lanes declare a duplicate target"
    )
    ++ lib.optional (
      builtins.length (lib.unique buck2TestAuthorityTaskNames)
      != builtins.length buck2TestAuthorityTaskNames
    ) "lanes declare a duplicate task name"
    ++ lib.optional (
      builtins.length (lib.unique buck2TestAuthorityCollectionTargets)
      != builtins.length buck2TestAuthorityCollectionTargets
    ) "lanes declare a duplicate collection target";
  discoveredTestPackagePaths = map (pkg: pkg.path) packagesWithTests;
  # A lane whose package carries no discovered Vitest tests (or is quarantined) means the
  # generated bridge and the filesystem have drifted apart; fail every consumer of the lanes
  # rather than relying on an unrelated source-task binding to force the assertion.
  buck2TestLanesWithoutSources = builtins.filter (
    lane: !(builtins.elem lane.packagePath discoveredTestPackagePaths)
  ) buck2TestAuthorityLanes;
  buck2TestLanes =
    assert lib.assertMsg (buck2TestAuthorityIssues == [ ]) ''
      buck2-test-authority.json is not a conformant test authority:
        ${lib.concatStringsSep "\n  " buck2TestAuthorityIssues}
    '';
    assert lib.assertMsg (buck2TestLanesWithoutSources == [ ]) ''
      buck2-test-authority.json declares lanes for packages with no discovered Vitest tests:
      ${lib.concatMapStringsSep ", " (lane: lane.packagePath) buck2TestLanesWithoutSources}
    '';
    buck2TestAuthorityLanes;
  buck2TestLanePackagePaths = map (lane: lane.packagePath) buck2TestLanes;
  # Buck executes every admitted bounded lane. Source Vitest keeps packages absent from the
  # authority and each lane's exact generic complement; explicit live/e2e owners run separately.
  sourceOnlyTestPackages = builtins.filter (
    pkg: !(builtins.elem pkg.path buck2TestLanePackagePaths)
  ) packagesWithTests;
  unboundedTestPackages = map (lane: {
    path = lane.packagePath;
    name = lib.removePrefix "test:" lane.unboundedTaskName;
    # Positional filters, so the complement schedules only its explicit unbounded files.
    vitestArgs = lib.concatStringsSep " " (map lib.escapeShellArg lane.unboundedFiles);
    after = lane.unboundedAfter;
  }) (builtins.filter (lane: lane.unboundedFiles != [ ]) buck2TestLanes);
  sourceTestPackages = sourceOnlyTestPackages ++ unboundedTestPackages;

  buck2BuildExec =
    { name, targets }:
    trace.exec name ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      export PATH=${
        lib.makeBinPath [
          pkgs.coreutils
          pkgs.watchman
        ]
      }
      workspace_root="$(${pkgs.coreutils}/bin/realpath "$root/../..")"
      buck="$workspace_root/.megarepo/bin/buck2"
      exec "$buck" build \
        --target-platforms effect_utils//buck2/platforms:host_platform \
        ${lib.concatStringsSep " \\\n        " targets}
    '';

  # Buck-invoking tasks discover the same pinned composed binary as `buck2:check`, so a lane
  # cannot run against a different Buck than the one the check gate proved.
  buck2UnitTestExec =
    { name, targets }:
    trace.exec name ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      export PATH=${
        lib.makeBinPath [
          pkgs.coreutils
          pkgs.watchman
        ]
      }
      workspace_root="$(${pkgs.coreutils}/bin/realpath "$root/../..")"
      buck="$workspace_root/.megarepo/bin/buck2"
      exec "$buck" test \
        --target-platforms effect_utils//buck2/platforms:host_platform \
        --local-only \
        ${lib.concatStringsSep " \\\n        " targets}
    '';
  # Standalone `test:<package>`: the Buck-owned bounded lane plus its source-owned complement,
  # so asking for one package's tests still runs all of that package's tests.
  buck2TestLaneTasks = lib.listToAttrs (
    map (
      lane:
      lib.nameValuePair lane.taskName {
        description = "Execute the bounded ${lane.packageName} unit-test lane under Buck";
        after = [ "mr:apply" ] ++ lib.optional (lane ? unboundedTaskName) lane.unboundedTaskName;
        exec = buck2UnitTestExec {
          name = lane.taskName;
          targets = [ lane.target ];
        };
      }
    ) buck2TestLanes
  );

  # Packages that have storybook (subset of allPackages)
  packagesWithStorybook = [
    {
      path = "packages/@overeng/tui-react";
      name = "tui-react";
      port = 6006;
    }
    {
      path = "packages/@overeng/megarepo";
      name = "megarepo";
      port = 6007;
    }
    {
      path = "packages/@overeng/genie";
      name = "genie";
      port = 6008;
    }
    {
      path = "packages/@overeng/effect-react";
      name = "effect-react";
      port = 6009;
    }
    {
      path = "packages/@overeng/effect-schema-form-aria";
      name = "effect-schema-form-aria";
      port = 6010;
    }
    {
      path = "packages/@overeng/react-inspector";
      name = "react-inspector";
      port = 6011;
    }
    {
      path = "packages/@overeng/notion-cli";
      name = "notion-cli";
      port = 6012;
    }
    {
      path = "packages/@overeng/tui-stories";
      name = "tui-stories";
      port = 6013;
    }
    {
      path = "packages/@overeng/notion-react";
      name = "notion-react";
      port = 6014;
    }
    {
      path = "packages/@overeng/notion-md";
      name = "notion-md";
      port = 6015;
    }
  ];
  packagesWithNetlifyPreview = lib.filter (pkg: pkg.name != "tui-stories") packagesWithStorybook;
  # Repository-specific semantic inputs read by Genie sources. The shared
  # Genie module already owns the direct and nested `.genie.ts` census; this
  # single list is composed into both its warm fingerprint and lint freshness.
  genieExtraInputGlobs = [
    "context/otel-scrape/telemetry-registry.json"
    "genie/buck2/*.ts"
    "packages/@overeng/buck2-tools/src/**/*.ts"
    "packages/@overeng/tui-core/src/**/*.ts"
    "packages/@overeng/tui-core/src/**/*.tsx"
    "packages/@overeng/tui-core/src/**/*.cts"
    "packages/@overeng/tui-core/src/**/*.mts"
    "packages/@overeng/tui-core/test/**/*.ts"
    "packages/@overeng/tui-core/test/**/*.tsx"
    "packages/@overeng/tui-core/test/**/*.cts"
    "packages/@overeng/tui-core/test/**/*.mts"
    "packages/@overeng/tui-react/src/**/*.ts"
    "packages/@overeng/tui-react/src/**/*.tsx"
    "packages/@overeng/tui-react/src/**/*.cts"
    "packages/@overeng/tui-react/src/**/*.mts"
    "packages/@overeng/tui-react/test/**/*.ts"
    "packages/@overeng/tui-react/test/**/*.tsx"
    "packages/@overeng/tui-react/test/**/*.cts"
    "packages/@overeng/tui-react/test/**/*.mts"
    "packages/@overeng/tui-react/examples/**/*.ts"
    "packages/@overeng/tui-react/examples/**/*.tsx"
    "packages/@overeng/tui-react/examples/**/*.cts"
    "packages/@overeng/tui-react/examples/**/*.mts"
    "packages/@overeng/utils/src/**/*.ts"
    "packages/@overeng/utils/src/**/*.tsx"
    "packages/@overeng/utils/src/**/*.cts"
    "packages/@overeng/utils/src/**/*.mts"
    "packages/@overeng/utils-dev/src/**/*.ts"
    "packages/@overeng/utils-dev/src/**/*.tsx"
    "packages/@overeng/utils-dev/src/**/*.cts"
    "packages/@overeng/utils-dev/src/**/*.mts"
    "pnpm-lock.yaml"
    "pnpm-workspace.yaml"
  ];
  composedWorkspaceRootPredicate = ''
    composed_workspace_root() {
      local member_root workspace_root branch_ref repo_root bare_repo common_dir admin_dir
      local backlink backlink_dir current_worktree current_branch registered_worktree registered_branch
      local matching_path_registrations matching_branch_registrations

      member_root="$(${pkgs.coreutils}/bin/realpath "$1")" || return 1
      workspace_root="$(${pkgs.coreutils}/bin/realpath "$member_root/../..")" || return 1
      [ "$member_root" = "$workspace_root/repos/effect-utils" ] || return 1
      [ -f "$member_root/.git" ] || return 1

      branch_ref="$(${pkgs.git}/bin/git -C "$member_root" symbolic-ref --quiet HEAD)" || return 2
      case "$branch_ref" in
        refs/heads/*) ;;
        *) return 1 ;;
      esac
      case "$workspace_root" in
        */"$branch_ref") repo_root="''${workspace_root%/"$branch_ref"}" ;;
        *) return 1 ;;
      esac
      bare_repo="$repo_root/.bare"
      [ -d "$bare_repo" ] || return 2
      common_dir="$(${pkgs.git}/bin/git -C "$member_root" rev-parse \
        --path-format=absolute --git-common-dir)" || return 2
      [ "$common_dir" = "$bare_repo" ] || return 2

      admin_dir="$(${pkgs.git}/bin/git -C "$member_root" rev-parse \
        --path-format=absolute --git-dir)" || return 2
      admin_dir="$(${pkgs.coreutils}/bin/realpath "$admin_dir")" || return 2
      [ "$(${pkgs.coreutils}/bin/dirname "$admin_dir")" = "$bare_repo/worktrees" ] ||
        return 2
      [ -f "$admin_dir/gitdir" ] || return 2
      backlink="$(<"$admin_dir/gitdir")"
      case "$backlink" in
        /*) ;;
        *) backlink="$admin_dir/$backlink" ;;
      esac
      backlink_dir="$(${pkgs.coreutils}/bin/realpath \
        "$(${pkgs.coreutils}/bin/dirname "$backlink")")" || return 2
      backlink="$backlink_dir/$(${pkgs.coreutils}/bin/basename "$backlink")"
      [ "$backlink" = "$member_root/.git" ] || return 2

      current_worktree=
      current_branch=
      registered_worktree=
      registered_branch=
      matching_path_registrations=0
      matching_branch_registrations=0
      while IFS= read -r -d "" field; do
        case "$field" in
          worktree\ *) current_worktree="''${field#worktree }" ;;
          branch\ *) current_branch="''${field#branch }" ;;
          "")
            if [ "$current_worktree" = "$member_root" ]; then
              registered_branch="$current_branch"
              matching_path_registrations=$((matching_path_registrations + 1))
            fi
            if [ "$current_branch" = "$branch_ref" ]; then
              registered_worktree="$current_worktree"
              matching_branch_registrations=$((matching_branch_registrations + 1))
            fi
            current_worktree=
            current_branch=
            ;;
        esac
      done < <(${pkgs.git}/bin/git --git-dir="$bare_repo" worktree list --porcelain -z)
      [ "$matching_path_registrations" -eq 1 ] || return 2
      [ "$matching_branch_registrations" -eq 1 ] || return 2
      [ "$registered_branch" = "$branch_ref" ] || return 2
      [ "$registered_worktree" = "$member_root" ] || return 2

      printf "%s\n" "$workspace_root"
    }
  '';
  editorViewExec =
    mode:
    trace.exec "buck2:editor:${mode}" ''
      set -euo pipefail
      ${composedWorkspaceRootPredicate}
      root="''${DEVENV_ROOT:-$PWD}"
      workspace_root="$(composed_workspace_root "$root")" || {
        identity_status=$?
        echo "buck2:editor:${mode} requires a composed megarepo workspace" >&2
        exit "$identity_status"
      }
      exec ${pkgs.bun}/bin/bun "$root/scripts/editor-view-authority.ts" ${mode} \
        --repo-root "$root" \
        --workspace-root "$workspace_root" \
        --cell effect_utils \
        --buck2 "$workspace_root/.megarepo/bin/buck2" \
        --git ${pkgs.git}/bin/git \
        --output "$root/.devenv/editor-workspace-authority.json" \
        --publisher "$root/packages/@overeng/buck2-tools/src/editor-view.ts" \
        --cp ${pkgs.coreutils}/bin/cp \
        --mv ${pkgs.coreutils}/bin/mv \
        --snapshot-retention 3
    '';
in
{
  imports = [
    # Git hook: prevent commits on default branch + enforce linked worktrees
    (taskModules.worktree-guard { })
    # OpenTelemetry observability stack (Collector + Tempo + Grafana)
    (import ./nix/devenv-modules/otel.nix { traceShellEntry = false; })
    # Hermetic native-devenv + effect-utils task-tree capture. Ambient mode
    # composes with the full stack above without importing it a second time.
    (import ./nix/devenv-modules/observability.nix {
      project = "effect-utils";
      # Shell-entry setup is intentionally absent. Profile an instantiated,
      # non-mutating task so check:all retains its trace integrity gate.
      profile = {
        name = "genie-check";
        task = "genie:check";
        mode = "single";
        smokeTask = "genie:check";
        smokeMode = "single";
        bridgeTask = "genie:check";
        # The verifier launches a nested, cache-refreshed task run. Keep it last
        # so its task-cache refresh cannot race sibling check:all work.
        prerequisiteTasks = [
          "bootstrap-closure:check"
          "buck2:check"
          "cargo:check"
          "dependency-materialization:evidence:check"
          "devenv:trace-audit"
          "lint:check"
          "lint:nix"
          "mr:check"
          "mr:lock-sync-check"
          "mr:source-policy-check"
          "nix:flake:check"
          "test:run"
          "weaver:check"
          "weaver:diff"
          "weaver:version-smoke"
          "workspace:check"
        ];
      };
      wireInto = [ "check:all" ];
    })
    # gh:apply-labels / gh:check-labels — reconcile .github/labels.json with live labels
    (import ./nix/devenv-modules/gh-labels.nix { repo = "overengineeringstudio/effect-utils"; })
    # Playwright browser drivers and environment setup
    inputs.playwright.devenvModules.default
    # Shared task modules
    taskModules.genie
    (taskModules.megarepo { mrPkg = mrCli; })
    (taskModules.lint-nix { })
    # No repository JavaScript package is source-built by Nix anymore. Import
    # the empty module contract to retain repository-wide flake validation.
    (taskModules.nix-cli { cliPackages = [ ]; })
    (taskModules.check {
      extraChecks = [
        "devenv:trace-audit"
        "workspace:check"
        "lint:nix"
      ];
      checkQuickTypecheckTask = "buck2:check";
      checkAllTypecheckTask = "buck2:check";
    })
    (taskModules.weaver { })
    # Wire the additive weaver gate into `check:all` only (not `check:quick`, which stays fast):
    # `after` list options merge across modules, so this appends without redefining check:all.
    { tasks."check:all".after = [ "weaver:check" ]; }
    # Bootstrap-safe import-closure gate (issue #884): fast local feedback for the bootstrap contract.
    # Fails (zero-tolerance, no baseline) on ANY `// @genie-bootstrap` generator whose transitive
    # runtime closure reaches a runtime-only package (which would break `genie --phase bootstrap` on a
    # fresh pre-install clone). Wired into `check:all` only (kept out of `check:quick`). The empirical
    # authority is `bootstrap:cold-proof` (R32); this static gate is its cheap pre-check.
    (taskModules.bootstrap-closure {
      checkerBin = "${genieBootstrapClosureCheckCli}/bin/genie-bootstrap-closure-check";
    })
    { tasks."check:all".after = [ "bootstrap-closure:check" ]; }
    # Compat-diff gate (SC-R11): blocks a PR that REMOVES a shipped registry attribute/signal.
    # PR-scoped (needs a merge-base baseline) — degrades to a warning locally on a fresh clone with
    # no `origin/main` merge-base; its load-bearing home is the CI `weaver` lane.
    (taskModules.weaver-diff { })
    { tasks."check:all".after = [ "weaver:diff" ]; }
    # Live-check e2e (SC-R12): emits registry-conformant OTLP from a first-party site, captures it,
    # and asserts `weaver registry live-check` accepts it (exit 0). Runs the scoped vitest e2e with
    # the hermetic weaver + semconv-model on env; degrades to a warning if weaver is unavailable.
    # Defined here so the CI `weaver` lane can invoke it, but deliberately NOT wired into `check:all`:
    # unlike the deterministic check/diff runs, this is a subprocess e2e (spawns otelite, binds an
    # ephemeral port, depends on export-flush timing), so it lives in CI rather than gating every
    # local `check:all` on capture reliability.
    (taskModules.weaver-live-check { })
    # Version-pin consistency smoke (SC-DQ4): catches weaver/semconv pin drift the content
    # gate (weaver:check) silently degrades past (a bumped version with a stale FOD hash).
    (taskModules.weaver-version-smoke { })
    { tasks."check:all".after = [ "weaver:version-smoke" ]; }
    (taskModules.clean { packages = allPackages; })
    # Pnpm remains only as a lockfile authoring tool. It cannot materialize a
    # workspace dependency graph or publish node_modules.
    (taskModules.pnpm {
      packages = allPackages;
      inherit pnpmPkg;
      materialize = false;
    })
    # Source-side Vitest is now only what Buck does not execute: packages outside the Buck
    # test registry and each admitted lane's exact excluded files. Retained JSON therefore
    # exists exactly where the baseline gate still needs a source report.
    (taskModules.test-playwright {
      playwrightPkg = inputs.playwright.packages.${currentSystem}.playwright;
      installTask = "buck2:editor:publish";
      packages = [
        {
          path = "packages/@overeng/utils";
          name = "utils";
        }
        {
          path = "packages/@overeng/tui-react";
          name = "tui-react";
        }
      ];
    })
    (taskModules.test {
      installTask = "buck2:editor:publish";
      packages = sourceTestPackages;
      extraTests = [
        "devenv-modules:test"
        "genie:buck2:test"
      ];
      packageConcurrency = 4;
      retainVitestJson = true;
    })
    # Per-lane Buck `test:<package>` tasks, each pulling in its unbounded complement.
    { tasks = buck2TestLaneTasks; }
    (taskModules.storybook {
      installTask = "buck2:editor:publish";
      packages = packagesWithStorybook;
    })
    (taskModules.netlify {
      siteName = "overeng-utils";
      siteId = "462d2440-fb38-4e69-8023-9c425d1e2132";
      ciToolsBin = "${ciToolsCli}/bin/ci-tools";
      deployments = map (pkg: {
        name = pkg.name;
        staticDir = "${pkg.path}/storybook-static";
        afterTask = "storybook:build:${pkg.name}";
        workspaceFilter = true;
      }) packagesWithNetlifyPreview;
    })
    # Workflow reports run as standalone CI control-plane steps, including when
    # a deploy is skipped. Use the hermetic package instead of relying on an
    # ambient source-workspace node_modules projection.
    (taskModules.workflow-report { ciToolsBin = "${ciToolsCli}/bin/ci-tools"; })
    (taskModules.lint-oxc {
      oxlintPkg = oxlintWithPlugins;
      lintPaths = [
        "packages"
        "scripts"
        "context"
      ];
      # Match both repo-root and nested Genie sources explicitly, then compose
      # the same repository-specific semantic inputs used by the warm-state
      # fingerprint. This is freshness scheduling, not output admission.
      geniePatterns = [
        "*.genie.ts"
        "**/*.genie.ts"
      ]
      ++ genieExtraInputGlobs;
      genieCoverageDirs = [ "packages" ];
      # Type-aware linting for typescript/no-deprecated rule
      tsconfig = "tsconfig.lint.json";
      # Type-aware lint consumes the declaration products Buck publishes.
      tsconfigAfterTasks = [ "buck2:typescript:materialize-dist" ];
      # Warning cleanup is complete: every oxlint rule is at zero repo-wide
      # (swept + key rules promoted to error; non-API surfaces exempted by
      # override). Lint is now fatal on ANY warning so the gate can never
      # silently regress — enforced identically in CI and the local pre-commit
      # gate (both run `lint:check`).
      denyWarnings = true;
    })
    # Setup task (auto-runs in enterShell)
    # Context example tasks
    taskModules.context
    (taskModules.setup {
      # Repository mutation is explicit. Shell entry activates only the Nix
      # environment, so its latency and availability are independent of Buck,
      # pnpm, Genie, megarepo state, and the repository revision.
      runOnEnterShell = false;
      requiredTasks = [ ];
      # Reuse the Genie semantic-input SSOT in the cheap Git-index outer
      # fingerprint so a warm shell cannot bypass projection invalidation.
      extraFingerprintGlobs = genieExtraInputGlobs;
      # Run the one ordered mutating entrypoint. Its internal task sequence
      # preserves generator/freshness/composition/publication happens-before.
      optionalTasks = [ "buck2:editor:materialize" ];
      completionsCliNames = [
        "genie"
        "mr"
      ];
    })
    (taskModules.secretspec { })
    taskModules.devenv-module-tests
    # Notion integration tests (requires NOTION_API_TOKEN)
    ./nix/devenv-modules/tasks/local/notion-integration-test.nix
    # Restate integration tests (native restate-server via RESTATE_SERVER_BIN)
    ./nix/devenv-modules/tasks/local/restate-integration-test.nix
  ];

  # The guarded `genie` command dispatches to this repository's own packaged
  # Genie product, which is also what downstream consumers set here.
  effectUtils.genie.package = genieCli;

  # The packaged Genie CLI is self-contained; generator sources resolve their
  # external imports through the committed-graph bootstrap editor views. This
  # stage-zero publication cannot report governed Buck evidence: genie:check
  # must first prove the graph fresh, then mr:apply and the authoritative
  # publisher replay it.
  tasks."genie:run".after = [ "buck2:editor:bootstrap" ];
  tasks."genie:check".after = [ "buck2:editor:bootstrap" ];
  tasks."lint:check:genie".after = [ "buck2:editor:bootstrap" ];
  tasks."genie:watch".after = [ "buck2:editor:bootstrap" ];
  tasks."lint:check:lockfile".description =
    lib.mkForce "Verify lockfile and package specifiers through source-side Genie freshness";
  tasks."lint:check:lockfile".after = lib.mkForce [ "genie:check" ];
  tasks."lint:check:lockfile".exec = lib.mkForce (
    trace.exec "lint:check:lockfile" "exec genie --check"
  );
  tasks."lint:fix:oxlint".after = [ "buck2:editor:publish" ];
  tasks."devenv-modules:test".after = lib.mkForce [ "buck2:editor:publish" ];
  tasks."test:restate-integration".after = lib.mkForce [ "buck2:editor:publish" ];
  tasks."test:notion-integration:notion-effect-client".after = lib.mkForce [ "buck2:editor:publish" ];
  tasks."test:notion-integration:notion-cli".after = lib.mkForce [ "buck2:editor:publish" ];
  tasks."test:notion-integration:notion-datasource-sync".after = lib.mkForce [
    "buck2:editor:publish"
  ];
  tasks."test:notion-integration:notion-md".after = lib.mkForce [ "buck2:editor:publish" ];
  tasks."test:notion-integration:notion-react".after = lib.mkForce [ "buck2:editor:publish" ];
  tasks."weaver:live-check".after = lib.mkForce [ "buck2:editor:publish" ];
  tasks."test:pty-effect:unbounded".env = {
    NODE_PTY_NATIVE_PACKAGE = "${nodePtyNative}/node_modules/node-pty";
    NODE_OPTIONS = "--import=${./. + "/packages/@overeng/pty-effect/test/node-pty-native-hook.ts"}";
  };

  # Read-only formatting and linting are Buck actions over the exact generated
  # source manifest. Mutation remains source-side under lint:fix.
  tasks."lint:check:format".after = lib.mkForce [ "mr:apply" ];
  tasks."lint:check:format".exec = lib.mkForce (buck2BuildExec {
    name = "lint:check:format";
    targets = [ "effect_utils//buck2/static:check_format" ];
  });
  tasks."lint:check:oxlint".after = lib.mkForce [ "mr:apply" ];
  tasks."lint:check:oxlint".exec = lib.mkForce (buck2BuildExec {
    name = "lint:check:oxlint";
    targets = [ "effect_utils//buck2/static:check_lint" ];
  });
  tasks."lint:check:asset-import-needs-type-reference" = {
    after = [ "mr:apply" ];
    description = "Require travelling type references for compiled asset imports through Buck";
    exec = buck2BuildExec {
      name = "lint:check:asset-import-needs-type-reference";
      targets = [ "effect_utils//buck2/static:check_policy" ];
    };
  };
  tasks."lint:check".after = lib.mkAfter [ "lint:check:asset-import-needs-type-reference" ];
  tasks."lint:check:genie:coverage".after = lib.mkForce [ "mr:apply" ];
  tasks."lint:check:genie:coverage".exec = lib.mkForce (buck2BuildExec {
    name = "lint:check:genie:coverage";
    targets = [ "effect_utils//buck2/static:check_policy" ];
  });
  tasks."workspace:check" = {
    after = [ "mr:apply" ];
    description = "Validate generated workspace package inventory through Buck";
    exec = buck2BuildExec {
      name = "workspace:check";
      targets = [ "effect_utils//buck2/static:check_policy" ];
    };
  };

  # Non-`.genie.ts` sources share one list with the lint freshness scheduler.
  effectUtils.genie.extraInputGlobs = genieExtraInputGlobs;

  packages = [
    buck2Stage0Definition.archive-tool
    pkgs.nodejs_24
    pkgs.bun
    pkgs.typescript
    pkgs.flock # Cross-process locking for setup tasks (see setup.nix)
    # Buck's admitted event backend; avoids pnpm alias staleness and whole-tree
    # crawler races under concurrent repository tools.
    pkgs.watchman
    # restate-server (+ restate CLI) on $PATH for restate-effect integration tests.
    restate
    # Use the packaged wrapper so `notion db ...` runs on Node 24 with node:sqlite.
    repoPackages.notion-cli
    # Rust binaries on PATH for local smoke tests and downstream wrappers.
    repoPackages.otelite
    repoPackages.otel-scrape
    # Nix-distributed Buck binary used by direct repository tasks.
    buck2Machine
    buck2Stage0Definition.product
    cliBuildStamp.package
    ciToolsCli
    tuiStoriesCli
    # Rust toolchain for the standalone Rust crates.
    # Stage-zero Nix providers use pkgs.rustPlatform; local validation keeps
    # cargo/clippy/rustfmt/rust-analyzer aligned with nixpkgs' stable Rust.
    pkgs.cargo
    pkgs.rustc
    pkgs.clippy
    pkgs.reindeer
    pkgs.rustfmt
    pkgs.rust-analyzer
  ];

  # actionlint binary path for genie's workflow validation (also used by tests)
  env.GENIE_ACTIONLINT_BIN = "${pkgs.actionlint}/bin/actionlint";
  env.BUCK2_BIN = "${buck2Machine}/bin/buck2";
  env.BUCK2_MACHINE_VERSION = buck2Machine.version;
  # Source-mode mr must receive the same pinned composition runtime as the
  # packaged wrapper; refreshed tasks can invoke composition from owned members.
  env.MR_COMPOSITION_CP_BIN = "${pkgs.coreutils}/bin/cp";
  env.MR_COMPOSITION_BUCK2_BIN = "${buck2Machine}/bin/buck2";
  env.MR_COMPOSITION_BUCK2_PROTOCOL = "facebook/buck2-cli/2026-09-01";
  env.MR_COMPOSITION_SYSTEM = currentSystem;
  env.MR_COMPOSITION_PLATFORM = if pkgs.stdenv.hostPlatform.isDarwin then "darwin" else "linux";
  env.MR_COMPOSITION_GIT_BIN = "${pkgs.git}/bin/git";
  env.MR_COMPOSITION_WATCHMAN_BIN = "${pkgs.watchman}/bin/watchman";
  env.MR_CAPABILITY_NIX_BIN = "${pkgs.nix}/bin/nix";
  env.MR_CAPABILITY_MV_BIN = "${pkgs.coreutils}/bin/mv";

  # restate-server binary path for restate-effect integration tests (test/test-utils.ts
  # reads RESTATE_SERVER_BIN to locate the native server, else falls back to $PATH).
  env.RESTATE_SERVER_BIN = "${restate}/bin/restate-server";

  # Genie and mr run from packaged products, but the generated projection still defines
  # the graph mr composes. Generation freshness is therefore a source-side stage-zero
  # prerequisite: a stale graph must fail before reconciliation can publish it to Buck.
  # The composed-root mutators also remain serialized behind mr:setup.
  tasks."mr:setup".after = [ "mr:bootstrap" ];
  tasks."mr:apply".after = [
    "genie:check"
    "mr:setup"
  ];

  # buck2-tools executes inside pinned Bun actions and exercises Bun.YAML/Bun.which.
  # Keep its package gate on that runtime rather than Vitest's Node process.
  tasks."test:buck2-tools".description = lib.mkForce "Run buck2-tools tests under pinned Bun";
  tasks."test:buck2-tools".env = {
    CP_BIN = "${pkgs.coreutils}/bin/cp";
    MV_BIN = "${pkgs.coreutils}/bin/mv";
    FALSE_BIN = "${pkgs.coreutils}/bin/false";
  };
  tasks."test:buck2-tools".exec = lib.mkForce (
    trace.exec "test:buck2-tools" ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      cd "$root/packages/@overeng/buck2-tools"
      exec ${pkgs.bun}/bin/bun test src/*.test.ts
    ''
  );

  # The Buck2 genie projection suite lives outside packages/@overeng, so the
  # per-package `test:<pkg>` tasks and the root Vitest projects list both miss
  # it. Give it its own task and hang it off `test:run`, or the projection and
  # staged-runtime guards never run. Like test:buck2-tools it runs under pinned
  # Bun: the pnpm-lock projection it imports reads Bun.YAML.
  tasks."genie:buck2:test" = {
    description = "Run the Buck2 genie projection and staged-runtime guards under pinned Bun";
    after = [ "buck2:editor:publish" ];
    exec = trace.exec "genie:buck2:test" ''
      set -euo pipefail
      cd "''${DEVENV_ROOT:-$PWD}"
      # Directory, not a flat glob: genie/buck2/vitest.config.ts includes
      # `**/*.unit.test.ts`, and Bun discovers recursively the same way.
      exec ${pkgs.bun}/bin/bun test genie/buck2/
    '';
    execIfModified = [
      "BUCK"
      "genie/buck2/**/*.ts"
      "packages/@overeng/buck2-tools/src/**/*.ts"
    ];
  };

  # Empirical authority for the minimal generator phase that must run before
  # any dependency view exists. The design-time source closure is proven by
  # buck2:editor:bootstrap followed by genie:check.
  tasks."bootstrap:cold-proof" = {
    description = "Prove the marked bootstrap Genie generators run without node_modules";
    exec = trace.exec "bootstrap:cold-proof" ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      exec bash "$root/genie/ci-scripts/bootstrap-cold-proof.sh"
    '';
  };

  tasks."test:megarepo-cold-gc" = {
    after = [ "buck2:editor:publish" ];
    description = "Run isolated megarepo cold-GC integration tests";
    cwd = "packages/@overeng/megarepo";
    exec = trace.exec "test:megarepo-cold-gc" ''
      set -euo pipefail
      source ${lib.escapeShellArg pnpmTaskHelpersScript}
      run_package_bin vitest vitest run src/cli/store-gc-cold.integration.test.ts --reporter verbose --testTimeout 240000
    '';
    execIfModified = [
      "packages/@overeng/megarepo/src/**/*.ts"
      "packages/@overeng/megarepo/src/**/*.tsx"
      "packages/@overeng/megarepo/vitest.config.ts"
    ];
  };

  tasks."bundle:smoke" = {
    after = [ "mr:apply" ];
    description = "Bundle representative public entries through Buck with Vite/Rollup";
    exec = buck2UnitTestExec {
      name = "bundle:smoke";
      targets = [ "effect_utils//packages/@overeng/pty-effect:bundle_smoke" ];
    };
  };

  tasks."gh:apply-settings" = {
    after = [ "genie:run" ];
    exec = trace.exec "gh:apply-settings" ''
      set -euo pipefail
      ruleset_id=$(gh api repos/overengineeringstudio/effect-utils/rulesets --jq '.[0].id')
      gh api "repos/overengineeringstudio/effect-utils/rulesets/$ruleset_id" --method PUT --input .github/repo-settings.json
      echo "Applied repo-settings.json to ruleset $ruleset_id"
    '';
    description = "Apply .github/repo-settings.json to GitHub ruleset";
  };

  tasks."devenv:trace-audit" = {
    description = "Check active devenv task modules route every exec/status through trace.* (otel-span task span; concrete commands opt into otel-scrape via trace.instr)";
    exec = trace.exec "devenv:trace-audit" ''
      set -euo pipefail
      # Every active devenv task exec/status must route through the trace.nix
      # helpers (trace.exec / trace.status / trace.withStatus) so the otel-span
      # task span owns task identity. This audit greps for raw `exec =`/`status =`
      # attributes that do NOT go through trace.*.
      #
      # Every pattern uses POSIX bracket classes ([[:space:]], [.]) and NEVER a
      # backslash escape. A literal backslash-s / backslash-dot inside this Nix
      # indented string becomes a double-backslash that matches nothing, which
      # silently turns the whole audit vacuous (it always exits 0) — the exact
      # failure this rewrite fixes.
      #
      # Raw exec/status lines can be allowed only when they are annotated with
      # a `trace-audit-allow` marker comment IMMEDIATELY ABOVE the line.
      # There are currently no such exceptions: every thin `ci-tools`
      # delegation task (netlify/vercel deploys, workflow-report) routes through
      # trace.exec for a task span.
      # The marker is matched in a 2-line window (the line plus the one above),
      # so this stays robust to line shifts — no fragile file:line pins.
      marker='trace-audit-allow'
      violations=0
      while IFS= read -r hit; do
        file="''${hit%%:*}"
        rest="''${hit#*:}"
        lineno="''${rest%%:*}"
        if ${head} -n "$lineno" "$file" | ${tail} -n 2 | ${grep} -q "$marker"; then
          continue
        fi
        violations=1
        echo "BYPASS: $hit" >&2
      done < <(
        ${rg} -n '^[[:space:]]*(exec|status) = ' \
          devenv.nix \
          nix/devenv-modules/tasks/shared \
          nix/devenv-modules/tasks/local \
          -g '*.nix' \
          | ${rg} -v 'trace[.](exec|status)|exec = null|exec = if hasPackages then null else trace[.]exec|trace[.]withStatus'
      )
      if [ "$violations" -ne 0 ]; then
        echo "Found task exec/status scripts that bypass the trace.nix task span (trace.exec/status/withStatus)." >&2
        echo "Route them through trace.* or, if intentionally raw, add a 'trace-audit-allow' marker comment above the line with justification." >&2
        exit 1
      fi
    '';
  };

  tasks."cargo:test:buck2-foundation" = {
    description = "Run the Rust tests for the Buck2 foundation tools";
    exec = trace.exec "cargo:test:buck2-foundation" ''
      set -euo pipefail
      (
        cd rust
        cargo test --locked --package 'buck2-*'
      )
    '';
  };

  tasks."cargo:check" = {
    description = "Validate the shared Cargo workspace, then test, lint, and format-check each member";
    after = [ "cargo:test:buck2-foundation" ];
    exec = trace.exec "cargo:check" ''
      set -euo pipefail
      ${pkgs.bash}/bin/bash rust/workspace-contract.test.sh "$PWD"
      (
        cd rust
        cargo test --locked --workspace --exclude 'buck2-*'
        cargo clippy --locked --workspace --all-targets -- -D warnings
        cargo fmt --all --check
      )
    '';
  };

  tasks."buck2:rust-deps:generate" = {
    description = "Regenerate the non-vendored Reindeer graph from the Cargo workspace";
    exec = trace.exec "buck2:rust-deps:generate" ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      exec ${pkgs.bash}/bin/bash "$root/scripts/buck2-rust-deps.sh" generate \
        "$root" \
        ${pkgs.reindeer}/bin/reindeer \
        ${pkgs.cargo}/bin/cargo \
        ${pkgs.rustc}/bin/rustc
    '';
  };

  tasks."buck2:rust-deps:check" = {
    description = "Verify the non-vendored Reindeer graph matches Cargo inputs";
    exec = trace.exec "buck2:rust-deps:check" ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      exec ${pkgs.bash}/bin/bash "$root/scripts/buck2-rust-deps.sh" check \
        "$root" \
        ${pkgs.reindeer}/bin/reindeer \
        ${pkgs.cargo}/bin/cargo \
        ${pkgs.rustc}/bin/rustc
    '';
  };

  tasks."dependency-materialization:evidence:check" = {
    description = "Validate committed dependency-materialization benchmark and host-capability evidence";
    exec = trace.exec "dependency-materialization:evidence:check" ''
      ${pkgs.nodejs}/bin/node \
        context/dependency-materialization/07-verification/evidence/validate-storage-sharing-default.mjs
    '';
  };

  tasks."buck2:nix-bridge:check" = {
    description = "Check the strict build-product contract and fail-closed artifact importer";
    after = [ "mr:apply" ];
    exec = trace.exec "buck2:nix-bridge:check" ''
      set -euo pipefail
      ${pkgs.bash}/bin/bash nix/workspace-tools/lib/tests/buck2-build-product-contract.sh "$PWD"
      exec ${pkgs.bash}/bin/bash nix/workspace-tools/lib/tests/buck2-bridge.sh "$PWD"
    '';
  };

  tasks."buck2:editor:bootstrap" = {
    description = "Bootstrap source-generator dependencies from the committed Buck graph";
    after = [ "mr:setup" ];
    exec = editorViewExec "bootstrap";
  };

  # Authoring and declaration publication need generated projections to be
  # updated before freshness is checked, but standalone genie:check must remain
  # mutation-free. Keep that mutating sequence in one explicit entrypoint
  # rather than adding global edges between genie:run and genie:check.
  tasks."buck2:editor:materialize" = {
    description = "Regenerate, freshness-check, recompose, and publish every editor dependency view in order";
    exec = trace.exec "buck2:editor:materialize" ''
      set -euo pipefail
      export DEVENV_TUI=false
      devenv tasks run mr:setup
      devenv tasks run buck2:editor:bootstrap --mode single
      devenv tasks run genie:run --mode single
      devenv tasks run genie:check --mode single
      devenv tasks run mr:apply --mode single
      devenv tasks run buck2:editor:publish --mode single
    '';
  };

  tasks."buck2:editor:authority" = {
    description = "Prove complete Buck ownership of every workspace editor dependency view";
    after = [ "mr:apply" ];
    exec = editorViewExec "authority";
  };

  tasks."buck2:editor:publish" = {
    description = "Atomically publish every Buck-owned workspace editor dependency view";
    after = [ "mr:apply" ];
    exec = editorViewExec "publish";
  };

  tasks."buck2:editor:check" = {
    description = "Fail when any published workspace editor dependency view is stale";
    after = [ "mr:apply" ];
    exec = editorViewExec "check";
  };

  tasks."buck2:editor:recover-lock" = {
    description = "Recover the shared editor publication lock with its exact owner token";
    exec = trace.exec "buck2:editor:recover-lock" ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      package="''${EDITOR_VIEW_PACKAGE:?set EDITOR_VIEW_PACKAGE to a workspace package path}"
      token="''${EDITOR_VIEW_LOCK_TOKEN:?set EDITOR_VIEW_LOCK_TOKEN to the owner token printed by publish}"
      ${pkgs.bun}/bin/bun "$root/packages/@overeng/buck2-tools/src/editor-view.ts" recover-lock \
        --repo-root "$root" \
        --package "$package" \
        --token "$token"
    '';
  };

  tasks."buck2:typescript:materialize-dist" = {
    description = "Atomically materialize all Buck-owned TypeScript declarations";
    after = [ "buck2:editor:materialize" ];
    exec = trace.exec "buck2:typescript:materialize-dist" ''
      set -euo pipefail
      ${composedWorkspaceRootPredicate}
      root="''${DEVENV_ROOT:-$PWD}"
      export PATH=${
        lib.makeBinPath [
          pkgs.coreutils
          pkgs.watchman
        ]
      }
      workspace_root="$(composed_workspace_root "$root")" || {
        identity_status=$?
        echo "buck2:typescript:materialize-dist requires a composed megarepo workspace" >&2
        exit "$identity_status"
      }
      export WORKSPACE_ROOT="$workspace_root"
      export BUCK2_BIN="$WORKSPACE_ROOT/.megarepo/bin/buck2"
      exec ${pkgs.bun}/bin/bun "$root/genie/buck2/typescript-authority-runtime.ts" \
        materialize-dist "$root" ${pkgs.bash}/bin/bash
    '';
  };

  tasks."buck2:task-guards:check" = {
    description = "Check TypeScript publication failure paths and evaluated task ordering";
    exec = trace.exec "buck2:task-guards:check" ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      ${pkgs.bash}/bin/bash "$root/nix/devenv-modules/tasks/shared/tests/typescript-materialize-dist.test.sh"
      DEVENV_TASKS_JSON="$root/.devenv/gc/task-config-devenv-config-task-config" \
        NODE_BIN=${pkgs.nodejs}/bin/node exec ${pkgs.bash}/bin/bash \
        "$root/nix/devenv-modules/tasks/shared/tests/devenv-task-graph.test.sh"
    '';
  };

  tasks."buck2:check" = {
    description = "Build every admitted TypeScript check, declared test lane, and the archive/product Buck2 surface";
    after = [
      "mr:apply"
      "buck2:nix-bridge:check"
      "buck2:task-guards:check"
      "buck2:rust-deps:check"
    ];
    exec = trace.exec "buck2:check" ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      export PATH=${
        lib.makeBinPath [
          pkgs.coreutils
          pkgs.watchman
        ]
      }
      workspace_root="$(${pkgs.coreutils}/bin/realpath "$root/../..")"
      buck="$workspace_root/.megarepo/bin/buck2"
      "$buck" audit providers \
        --target-platforms effect_utils//buck2/platforms:host_platform \
        effect_utils//buck2/toolchains:cross_cell_provider_identity \
        effect_utils//buck2/toolchains:cross_cell_product_identity
      exec ${pkgs.bun}/bin/bun "$root/genie/buck2/typescript-authority-runtime.ts" \
        build "$buck"
    '';
  };

  # One Buck invocation executes every admitted bounded lane. This is what `test:run` waits on;
  # the per-lane `test:<package>` tasks (imported above) exist for standalone use and are not
  # part of that graph, so no suite is scheduled twice.
  tasks."test:buck2:unit" = {
    description = "Execute every admitted bounded unit-test lane under Buck";
    after = [ "mr:apply" ];
    exec = buck2UnitTestExec {
      name = "test:buck2:unit";
      targets = map (lane: lane.target) buck2TestLanes;
    };
  };

  tasks."check:all".after = [
    "cargo:check"
    "dependency-materialization:evidence:check"
  ];

  # `test:run` is the aggregate: the single Buck invocation for every bounded lane, plus the
  # source-only and unbounded-complement Vitest tasks the shared module wired into its `after`.
  # The baseline-collection gate then runs last and reads both kinds of evidence.
  tasks."test:run".after = [ "test:buck2:unit" ];
  tasks."test:run".exec = lib.mkForce (
    trace.exec "test:run" ''
      set -euo pipefail
      root="''${DEVENV_ROOT:-$PWD}"
      export PATH=${
        lib.makeBinPath [
          pkgs.coreutils
          pkgs.watchman
        ]
      }
      workspace_root="$(${pkgs.coreutils}/bin/realpath "$root/../..")"
      exec ${pkgs.bun}/bin/bun "$root/packages/@overeng/utils-dev/src/check-baseline-test-collection.ts" \
        --root "$root" \
        --buck2 "$workspace_root/.megarepo/bin/buck2" \
        --buck2-cwd "$workspace_root"
    ''
  );

  # Keep git-hook installation out of the shell-entry path.
  # If needed, install with `devenv tasks run devenv:git-hooks:install`.
  # TODO(cachix/git-hooks.nix#688): remove this once the upstream git-hooks.nix issue
  # is fixed; currently this workaround prevents shell-entry failures with core.hooksPath.
  tasks."devenv:git-hooks:install".before = lib.mkForce [ ];

  # Repo-local pnpm store for consistent local installs (not used by Nix builds).
  env.PNPM_STORE_DIR = "${config.devenv.root}/.devenv/pnpm-store-pure-v1";

  enterShell = ''
    export WORKSPACE_ROOT="$PWD"
    export PATH="$WORKSPACE_ROOT/node_modules/.bin:$PATH"
    ${cliBuildStamp.shellHook}
  '';

  git-hooks.enable = true;
  git-hooks.hooks.check-quick = {
    enable = true;
    entry = "DEVENV_TUI=false devenv tasks run check:quick";
    stages = [ "pre-commit" ];
    always_run = true;
    pass_filenames = false;
  };
}
