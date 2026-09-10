{ pkgs, pnpm }:

{
  name,
  entry,
  packageDir,
  workspaceRoot,
  evalWorkspaceRoot ?
    if builtins.isAttrs workspaceRoot && workspaceRoot ? evalWorkspaceRoot then
      workspaceRoot.evalWorkspaceRoot
    else
      workspaceRoot,
  workspaceSources ? { },
  evalWorkspaceSources ? workspaceSources,
  depsBuilds,
  binaryName ? name,
  gitRev ? "unknown",
  commitTs ? 0,
  dirty ? false,
  prodInstall ? false,
  smokeTestArgs ? [ "--help" ],
  generateCompletions ? true,
  extraBunBuildArgs ? [ ],
  installRuntimeWorkspace ? false,
  # Nix-owned native Node packages to link into the restored workspace during
  # CLI bundling. This keeps pnpm dependency preparation platform-neutral while
  # still supporting packages that resolve native bindings by npm package name.
  nativeNodePackages ? [ ],
}:

let
  lib = pkgs.lib;
  pnpmDepsHelper = import ./mk-pnpm-deps.nix { inherit pkgs pnpm; };
  dependencyProfile = import ./dependency-materialization-profile.nix { inherit lib; };
  # Closure-completeness guardrail (#807). Partially applied with the shared
  # native-optional-families detector source; each install root gets a check
  # derivation exposed via passthru.nativeBindingClosureChecks.<attrName>.
  # Filtered genie source so the check's sibling imports resolve during
  # `bun build`: `../native-dependency-policy.ts` (the single policy registry)
  # and `./native-dep-policy-lib.ts` (shared key helpers). A bare file
  # store-path cannot see its siblings inside the pkgs.bun check derivation.
  nativeBindingClosureCheckFactory = import ./mk-native-binding-closure-check.nix {
    inherit pkgs;
    genieSrc = lib.fileset.toSource {
      root = ../../../genie;
      fileset = lib.fileset.unions [
        ../../../genie/native-dependency-policy.ts
        ../../../genie/ci-scripts/native-dep-policy-lib.ts
        ../../../genie/ci-scripts/native-binding-closure-check.ts
      ];
    };
  };
  inheritRootPatchedDependenciesScript = pkgs.writeText "inherit-root-patched-dependencies.cjs" ''
    const fs = require("node:fs");
    const path = require("node:path");

    const [authorityDir, installDir] = process.argv.slice(2);
    if (!authorityDir || !installDir) {
      console.error("usage: inherit-root-patched-dependencies.cjs <authority-dir> <install-dir>");
      process.exit(1);
    }

    const stripYamlQuotes = (key) =>
      key.startsWith("'") && key.endsWith("'") ? key.slice(1, -1) : key;

    const parsePackageNameVersion = (packageKey) => {
      const atIndex = packageKey.startsWith("@")
        ? packageKey.indexOf("@", 1)
        : packageKey.indexOf("@");
      if (atIndex === -1) return undefined;
      const version = packageKey.slice(atIndex + 1);
      const suffixIndex = version.indexOf("(");
      return {
        name: packageKey.slice(0, atIndex),
        version,
        baseVersion: suffixIndex === -1 ? version : version.slice(0, suffixIndex),
        suffix: suffixIndex === -1 ? "" : version.slice(suffixIndex),
      };
    };

    const findTopLevelSection = (lines, sectionName) => {
      const startIndex = lines.findIndex((line) => line === sectionName + ":");
      if (startIndex === -1) return undefined;
      let endIndex = lines.length;
      for (let index = startIndex + 1; index < lines.length; index += 1) {
        const line = lines[index];
        if (line.trim() !== "" && /^\S/.test(line)) {
          endIndex = index;
          break;
        }
      }
      return { startIndex, endIndex };
    };

    const parseWorkspacePatchedDependencyPaths = (workspaceYaml) => {
      const lines = workspaceYaml.split("\n");
      const section = findTopLevelSection(lines, "patchedDependencies");
      if (section === undefined) return new Map();

      return new Map(
        lines
          .slice(section.startIndex + 1, section.endIndex)
          .map((line) => line.match(/^  (.+?):\s*(.+)$/))
          .filter((match) => match !== null)
          .map((match) => [stripYamlQuotes(match[1]), match[2].trim()])
      );
    };

    const parsePatchedDependencies = (lockfile, workspaceYaml) => {
      const lines = lockfile.split("\n");
      const section = findTopLevelSection(lines, "patchedDependencies");
      if (section === undefined) return [];

      const workspacePaths = parseWorkspacePatchedDependencyPaths(workspaceYaml);
      const entries = [];
      let index = section.startIndex + 1;
      while (index < section.endIndex) {
        const match = lines[index].match(/^  (.+?):\s*(.*)$/);
        if (match === null) {
          index += 1;
          continue;
        }

        const key = stripYamlQuotes(match[1]);
        const parsed = parsePackageNameVersion(key);
        let hash = match[2].trim() === "" ? undefined : match[2].trim();
        let patchPath = workspacePaths.get(key);
        index += 1;
        while (index < section.endIndex && lines[index].startsWith("    ")) {
          const hashMatch = lines[index].match(/^    hash:\s*(.+)$/);
          const pathMatch = lines[index].match(/^    path:\s*(.+)$/);
          if (hashMatch !== null) hash = hashMatch[1].trim();
          if (pathMatch !== null) patchPath = pathMatch[1].trim();
          index += 1;
        }

        if (parsed !== undefined && hash !== undefined && patchPath !== undefined) {
          entries.push({ key, ...parsed, hash, path: patchPath });
        }
      }

      return entries;
    };

    const parseExistingPatchedDependencyKeys = (lockfile) => {
      const lines = lockfile.split("\n");
      const section = findTopLevelSection(lines, "patchedDependencies");
      if (section === undefined) return new Set();
      return new Set(
        lines
          .slice(section.startIndex + 1, section.endIndex)
          .map((line) => line.match(/^  (.+?):/))
          .filter((match) => match !== null)
          .map((match) => stripYamlQuotes(match[1]))
      );
    };

    const parseLockfileSelectors = (lockfile) => {
      const lines = lockfile.split("\n");
      const selectors = [];

      for (const sectionName of ["packages", "snapshots"]) {
        const section = findTopLevelSection(lines, sectionName);
        if (section === undefined) continue;
        for (let index = section.startIndex + 1; index < section.endIndex; index += 1) {
          const match = lines[index].match(/^  (.+?):/);
          if (match !== null) selectors.push(stripYamlQuotes(match[1]));
        }
      }

      const importers = findTopLevelSection(lines, "importers");
      if (importers !== undefined) {
        let currentDependencyName;
        for (let index = importers.startIndex + 1; index < importers.endIndex; index += 1) {
          const dependencyMatch = lines[index].match(/^      (.+):$/);
          if (dependencyMatch !== null) {
            currentDependencyName = stripYamlQuotes(dependencyMatch[1]);
            continue;
          }

          const versionMatch = lines[index].match(/^        version: ([^\s]+).*$/);
          if (versionMatch !== null && currentDependencyName !== undefined) {
            selectors.push(currentDependencyName + "@" + versionMatch[1]);
          }
        }
      }

      return selectors;
    };

    const selectorMatchesEntry = (selector, entry) => {
      const parsed = parsePackageNameVersion(selector);
      return parsed !== undefined && parsed.name === entry.name && parsed.baseVersion === entry.version;
    };

    const insertPatchedDependencyLockEntries = (lockfile, entries) => {
      if (entries.length === 0) return lockfile;
      const lines = lockfile.split("\n");
      const section = findTopLevelSection(lines, "patchedDependencies");
      const rendered = entries.flatMap((entry) => [
        "  '" + entry.key + "': " + entry.hash,
      ]);

      if (section !== undefined) {
        lines.splice(section.endIndex, 0, ...rendered);
        return lines.join("\n");
      }

      const importersIndex = lines.findIndex((line) => line === "importers:");
      const insertionIndex = importersIndex === -1 ? lines.length : importersIndex;
      lines.splice(insertionIndex, 0, "patchedDependencies:", ...rendered, "");
      return lines.join("\n");
    };

    const rewriteLockfilePatchVersions = (lockfile, entries) => {
      if (entries.length === 0) return lockfile;
      const byNameVersion = new Map(entries.map((entry) => [entry.name + "@" + entry.version, entry]));
      const lines = lockfile.split("\n");
      const importers = findTopLevelSection(lines, "importers");
      if (importers !== undefined) {
        let currentDependencyName;
        for (let index = importers.startIndex + 1; index < importers.endIndex; index += 1) {
          const dependencyMatch = lines[index].match(/^      (.+):$/);
          if (dependencyMatch !== null) {
            currentDependencyName = stripYamlQuotes(dependencyMatch[1]);
            continue;
          }

          const versionMatch = lines[index].match(/^        version: ([^\s(]+)(.*)$/);
          if (versionMatch === null || currentDependencyName === undefined) continue;
          const entry = byNameVersion.get(currentDependencyName + "@" + versionMatch[1]);
          if (entry === undefined || versionMatch[2].includes("patch_hash=")) continue;
          lines[index] = "        version: " + versionMatch[1] + "(patch_hash=" + entry.hash + ")" + versionMatch[2];
        }
      }

      const duplicatePatchedSectionEntries = (sectionName) => {
        const section = findTopLevelSection(lines, sectionName);
        if (section === undefined) return;
        const existing = new Set();
        for (let index = section.startIndex + 1; index < section.endIndex; index += 1) {
          const match = lines[index].match(/^  (\S.+?):/);
          if (match !== null) existing.add(stripYamlQuotes(match[1]));
        }

        for (let index = section.endIndex - 1; index > section.startIndex; index -= 1) {
          const match = lines[index].match(/^  (\S.+?):(.*)$/);
          if (match === null) continue;
          const key = stripYamlQuotes(match[1]);
          const parsed = parsePackageNameVersion(key);
          if (parsed === undefined || key.includes("patch_hash=")) continue;
          const entry = byNameVersion.get(parsed.name + "@" + parsed.baseVersion);
          if (entry === undefined) continue;

          const patchedKey = parsed.name + "@" + parsed.baseVersion + "(patch_hash=" + entry.hash + ")" + parsed.suffix;
          if (existing.has(patchedKey)) continue;

          let blockEnd = section.endIndex;
          for (let cursor = index + 1; cursor < section.endIndex; cursor += 1) {
            if (lines[cursor].match(/^  (\S.+?):/) !== null) {
              blockEnd = cursor;
              break;
            }
          }

          const block = lines.slice(index, blockEnd);
          block[0] = "  '" + patchedKey + "':" + match[2];
          lines.splice(blockEnd, 0, ...block);
          existing.add(patchedKey);
        }
      }

      duplicatePatchedSectionEntries("packages");
      duplicatePatchedSectionEntries("snapshots");

      return lines.join("\n");
    };

    const insertWorkspacePatchEntries = (workspaceYaml, entries) => {
      if (entries.length === 0) return workspaceYaml;
      const lines = workspaceYaml.split("\n");
      const section = findTopLevelSection(lines, "patchedDependencies");
      const rendered = entries.map((entry) => "  '" + entry.key + "': .root-patches/" + entry.path);

      if (section !== undefined) {
        lines.splice(section.endIndex, 0, ...rendered);
        return lines.join("\n");
      }

      const insertionIndex = (() => {
        const preferred = ["allowUnusedPatches:", "packageExtensions:", "peerDependencyRules:", "allowBuilds:", "supportedArchitectures:"];
        for (const header of preferred) {
          const index = lines.findIndex((line) => line === header);
          if (index !== -1) return index;
        }
        return lines.length;
      })();
      lines.splice(insertionIndex, 0, "patchedDependencies:", ...rendered, "");
      return lines.join("\n");
    };

    const rootLockfile = fs.readFileSync(path.join(authorityDir, "pnpm-lock.yaml"), "utf8");
    const rootWorkspaceYaml = fs.readFileSync(path.join(authorityDir, "pnpm-workspace.yaml"), "utf8");
    const targetRoot = installDir;
    const targetLockfilePath = path.join(targetRoot, "pnpm-lock.yaml");
    const targetWorkspaceYamlPath = path.join(targetRoot, "pnpm-workspace.yaml");
    const targetLockfile = fs.readFileSync(targetLockfilePath, "utf8");
    const targetWorkspaceYaml = fs.readFileSync(targetWorkspaceYamlPath, "utf8");
    const existingKeys = parseExistingPatchedDependencyKeys(targetLockfile);
    const targetSelectors = parseLockfileSelectors(targetLockfile);
    const inheritedEntries = parsePatchedDependencies(rootLockfile, rootWorkspaceYaml).filter(
      (entry) =>
        !existingKeys.has(entry.key) &&
        targetSelectors.some((selector) => selectorMatchesEntry(selector, entry)) &&
        fs.existsSync(path.join(targetRoot, ".root-patches", entry.path))
    );

    if (inheritedEntries.length === 0) {
      fs.rmSync(path.join(targetRoot, ".root-patches"), { recursive: true, force: true });
      process.exit(0);
    }

    const nextTargetLockfile = rewriteLockfilePatchVersions(
      insertPatchedDependencyLockEntries(targetLockfile, inheritedEntries),
      inheritedEntries
    );
    const nextTargetWorkspaceYaml = insertWorkspacePatchEntries(targetWorkspaceYaml, inheritedEntries);

    fs.writeFileSync(targetLockfilePath, nextTargetLockfile);
    fs.writeFileSync(targetWorkspaceYamlPath, nextTargetWorkspaceYaml);
    console.error(
      "workspace-prep: phase=inherit-root-patched-dependencies install_root=" +
        installDir +
        " count=" +
        inheritedEntries.length +
        " packages=" +
        inheritedEntries.map((entry) => entry.key).join(",")
    );
  '';

  isDerivationOutput =
    sourceRoot: builtins.isAttrs sourceRoot && sourceRoot ? outPath && sourceRoot ? drvPath;

  coerceSourceRoot =
    sourceRoot:
    if builtins.isAttrs sourceRoot && builtins.hasAttr "outPath" sourceRoot then
      sourceRoot.outPath
    else if builtins.isPath sourceRoot then
      sourceRoot
    else
      builtins.toPath sourceRoot;

  workspaceRootPath = coerceSourceRoot workspaceRoot;
  workspaceRootIsDerivationOutput = isDerivationOutput workspaceRoot;
  evalWorkspaceRootPath = coerceSourceRoot evalWorkspaceRoot;

  sourcePathFilter =
    path: type:
    let
      name = baseNameOf path;
    in
    # Keep caller-local pnpm/devenv/git state out of FOD source identity; the
    # builder recreates the tiny mutable install state from checked-in inputs.
    !(builtins.elem name [
      ".devenv"
      ".git"
      "node_modules"
    ])
    && !(name == "result" && type == "symlink");

  normalizeSourceRoot =
    prefix: sourceRoot:
    if isDerivationOutput sourceRoot then
      coerceSourceRoot sourceRoot
    else
      let
        rawPath = coerceSourceRoot sourceRoot;
        normalizedName = lib.strings.sanitizeDerivationName (lib.replaceStrings [ "/" ] [ "-" ] prefix);
        sanitizedPath = builtins.path {
          path = rawPath;
          filter = sourcePathFilter;
          name = normalizedName;
        };
      in
      pkgs.runCommand normalizedName { inherit sanitizedPath; } ''
        mkdir -p "$out"
        cp -R "$sanitizedPath"/. "$out"/
      '';

  workspaceRootFullSourceRoot = normalizeSourceRoot "workspace-root" workspaceRoot;
  workspaceSourceRawRoots = lib.mapAttrs (_: coerceSourceRoot) workspaceSources;
  workspaceSourceIsDerivationOutput = lib.mapAttrs (_: isDerivationOutput) workspaceSources;
  workspaceSourceRoots = lib.mapAttrs normalizeSourceRoot workspaceSources;
  workspaceSourcePrefixesByLengthAsc = lib.sort (
    left: right: lib.stringLength left < lib.stringLength right
  ) (builtins.attrNames workspaceSourceRoots);
  workspaceSourcePrefixesByLengthDesc = lib.reverseList workspaceSourcePrefixesByLengthAsc;

  hasInstallRoot =
    sourceRoot:
    builtins.pathExists (sourceRoot + "/package.json")
    && builtins.pathExists (sourceRoot + "/pnpm-lock.yaml");

  resolveSourceFor =
    relPath:
    let
      matchesPrefix =
        candidate:
        if candidate == "." || candidate == "" then
          true
        else
          relPath == candidate || lib.hasPrefix "${candidate}/" relPath;
      prefix = lib.findFirst matchesPrefix null workspaceSourcePrefixesByLengthDesc;
      sourceRoot = if prefix == null then workspaceRootPath else workspaceSourceRawRoots.${prefix};
      fullSourceRoot =
        if prefix == null then workspaceRootFullSourceRoot else workspaceSourceRoots.${prefix};
      evalSourceRoot =
        if prefix == null then
          evalWorkspaceRootPath
        else
          evalWorkspaceSourceRawRoots.${prefix} or workspaceSourceRawRoots.${prefix};
      sourceIsDerivationOutput =
        if prefix == null then
          workspaceRootIsDerivationOutput
        else
          workspaceSourceIsDerivationOutput.${prefix};
      sourceRelPath =
        if prefix == null then
          relPath
        else if prefix == "." || prefix == "" then
          relPath
        else if relPath == prefix then
          "."
        else
          lib.removePrefix "${prefix}/" relPath;
    in
    {
      evalSourcePath =
        if sourceRelPath == "." then evalSourceRoot else evalSourceRoot + "/${sourceRelPath}";
      inherit prefix evalSourceRoot;
      inherit sourceRoot fullSourceRoot sourceRelPath;
      inherit sourceIsDerivationOutput;
    };

  normalizedEvalWorkspaceSources = lib.mapAttrs (
    _: sourceRoot:
    if builtins.isAttrs sourceRoot && sourceRoot ? evalWorkspaceRoot then
      sourceRoot.evalWorkspaceRoot
    else
      sourceRoot
  ) evalWorkspaceSources;
  evalWorkspaceSourceRawRoots = lib.mapAttrs (_: coerceSourceRoot) normalizedEvalWorkspaceSources;
  evalWorkspaceSourcePrefixesByLengthAsc = lib.sort (
    left: right: lib.stringLength left < lib.stringLength right
  ) (builtins.attrNames evalWorkspaceSourceRawRoots);
  evalWorkspaceSourcePrefixesByLengthDesc = lib.reverseList evalWorkspaceSourcePrefixesByLengthAsc;

  resolveEvalSourceFor =
    relPath:
    let
      matchesPrefix =
        candidate:
        if candidate == "." || candidate == "" then
          true
        else
          relPath == candidate || lib.hasPrefix "${candidate}/" relPath;
      prefix = lib.findFirst matchesPrefix null evalWorkspaceSourcePrefixesByLengthDesc;
      sourceRoot =
        if prefix == null then evalWorkspaceRootPath else evalWorkspaceSourceRawRoots.${prefix};
      sourceRelPath =
        if prefix == null then
          relPath
        else if prefix == "." || prefix == "" then
          relPath
        else if relPath == prefix then
          "."
        else
          lib.removePrefix "${prefix}/" relPath;
    in
    if sourceRelPath == "." then sourceRoot else sourceRoot + "/${sourceRelPath}";

  snapshotPath =
    namePrefix: path:
    let
      snapshotName = lib.strings.sanitizeDerivationName (lib.replaceStrings [ "/" ] [ "-" ] namePrefix);
      sanitizedPath = builtins.path {
        path = path;
        filter = sourcePathFilter;
        name = snapshotName;
      };
    in
    pkgs.runCommand snapshotName { inherit sanitizedPath; } ''
      cp "$sanitizedPath" "$out"
    '';

  absoluteFileSourcePathFor =
    relPath:
    let
      resolved = resolveSourceFor relPath;
      rawPath =
        if resolved.sourceRelPath == "." then
          resolved.sourceRoot
        else
          resolved.sourceRoot + "/${resolved.sourceRelPath}";
    in
    if resolved.sourceIsDerivationOutput then rawPath else snapshotPath relPath rawPath;

  absoluteDirectorySourcePathFor =
    relPath:
    let
      resolved = resolveSourceFor relPath;
    in
    if resolved.sourceRelPath == "." then
      resolved.fullSourceRoot
    else
      resolved.fullSourceRoot + "/${resolved.sourceRelPath}";

  rootPnpmInstallContractPath = evalWorkspaceRootPath + "/pnpm-install-contract.json";
  rootPnpmInstallContract =
    if builtins.pathExists rootPnpmInstallContractPath then
      builtins.fromJSON (builtins.readFile rootPnpmInstallContractPath)
    else
      { };
  rootWorkspaceManifestContract = rootPnpmInstallContract.workspaceManifestContract or { };
  hasDeclaredSourceInputStagePath = rootWorkspaceManifestContract ? sourceInputStagePath;
  hasDeclaredSourceInputPaths = rootWorkspaceManifestContract ? sourceInputPaths;
  declaredSourceInputStagePath = rootWorkspaceManifestContract.sourceInputStagePath or null;
  declaredSourceInputPaths = rootWorkspaceManifestContract.sourceInputPaths or null;
  canonicalSourceInputStagePath = ".devenv/pnpm-source-inputs/current";
  hasSourceInputProjectionContract = hasDeclaredSourceInputStagePath || hasDeclaredSourceInputPaths;
  validRelativeSourceInputPath =
    path:
    builtins.isString path
    && path != ""
    && !(lib.hasPrefix "/" path)
    && path != "."
    && path != ".."
    && !(lib.hasPrefix "../" path)
    && !(lib.hasInfix "/../" path)
    && !(lib.hasSuffix "/.." path);
  _validateSourceInputProjectionContract =
    if !hasSourceInputProjectionContract then
      true
    else if hasDeclaredSourceInputStagePath != hasDeclaredSourceInputPaths then
      throw "mk-pnpm-cli: workspaceManifestContract must declare sourceInputStagePath and sourceInputPaths together"
    else if declaredSourceInputStagePath != canonicalSourceInputStagePath then
      throw "mk-pnpm-cli: workspaceManifestContract.sourceInputStagePath must be ${canonicalSourceInputStagePath}"
    else if !builtins.isList declaredSourceInputPaths then
      throw "mk-pnpm-cli: workspaceManifestContract.sourceInputPaths must be a list"
    else if !(builtins.all validRelativeSourceInputPath declaredSourceInputPaths) then
      throw "mk-pnpm-cli: workspaceManifestContract.sourceInputPaths entries must be non-empty relative paths without parent traversal"
    else if lib.unique declaredSourceInputPaths != declaredSourceInputPaths then
      throw "mk-pnpm-cli: workspaceManifestContract.sourceInputPaths entries must be unique"
    else
      true;
  declaredSourceInputPathsValidated =
    assert _validateSourceInputProjectionContract;
    if hasSourceInputProjectionContract then declaredSourceInputPaths else [ ];
  stageRootSourceInputManifestAliasesCmd = lib.optionalString hasSourceInputProjectionContract (
    builtins.concatStringsSep "\n" (
      map (sourcePath: ''
        logical_dir="$out"/${lib.escapeShellArg sourcePath}
        alias_dir="$out"/${lib.escapeShellArg "${declaredSourceInputStagePath}/${sourcePath}"}
        if [ -f "$logical_dir/package.json" ]; then
          mkdir -p "$alias_dir"
          ln -s "$(realpath --relative-to="$alias_dir" "$logical_dir/package.json")" "$alias_dir/package.json"
        fi
      '') declaredSourceInputPathsValidated
    )
  );

  # Read workspace closure dirs from the generated package.json ($genie.workspaceClosureDirs).
  # Pre-computed by genie at generation time, avoiding import-from-derivation (IFD).
  # Future alternative: NixOS/nix#15380 (builtins.wasm) could compute this natively at eval time.
  packageJsonPath = resolveEvalSourceFor "${packageDir}/package.json";
  packageJson = builtins.fromJSON (builtins.readFile packageJsonPath);
  packageVersion = packageJson.version or "0.0.0";

  rootPnpmWorkspaceYamlPath = evalWorkspaceRootPath + "/pnpm-workspace.yaml";
  rootPnpmWorkspaceYaml = builtins.readFile rootPnpmWorkspaceYamlPath;

  # Workspace-local store settings are for live worktrees. Nix dependency
  # prep owns its private store path through env/.npmrc so prepared outputs
  # cannot archive a caller's local store.
  prepLocalPnpmSettingPrefixes = [
    "cacheDir"
    "enableGlobalVirtualStore"
    "globalVirtualStoreDir"
    "nodeLinker"
    "optimisticRepeatInstall"
    "packageImportMethod"
    "pmOnFail"
    "sideEffectsCache"
    "sideEffectsCacheReadonly"
    "stateDir"
    "storeDir"
    "strictStorePkgContentCheck"
    "virtualStoreDir"
    "verifyDepsBeforeRun"
    "verifyStoreIntegrity"
  ];
  prepLocalNpmrcSettingPrefixes = [
    "cache-dir"
    "enable-global-virtual-store"
    "global-virtual-store-dir"
    "node-linker"
    "package-import-method"
    "pm-on-fail"
    "side-effects-cache"
    "side-effects-cache-readonly"
    "state-dir"
    "store-dir"
    "strict-store-pkg-content-check"
    "verify-deps-before-run"
    "verify-store-integrity"
    "virtual-store-dir"
  ];
  stripPrepLocalPnpmSettings =
    lines:
    builtins.filter (
      l:
      let
        trimmed = lib.trim l;
      in
      !(builtins.any (prefix: lib.hasPrefix prefix trimmed) prepLocalPnpmSettingPrefixes)
    ) lines;
  stripPrepLocalNpmrcSettings =
    lines:
    builtins.filter (
      l:
      let
        trimmed = lib.trim l;
      in
      !(builtins.any (
        prefix: (lib.hasPrefix "${prefix}=" trimmed) || (lib.hasPrefix "${prefix} " trimmed)
      ) prepLocalNpmrcSettingPrefixes)
    ) lines;

  workspaceSuffixLines =
    workspaceYaml:
    let
      dropUntilPackagesHeader =
        lines:
        if lines == [ ] then
          throw "mk-pnpm-cli: pnpm-workspace.yaml is missing packages:"
        else if lib.hasPrefix "packages:" (lib.trim (builtins.head lines)) then
          lib.tail lines
        else
          dropUntilPackagesHeader (lib.tail lines);

      dropPackageBlock =
        lines:
        if lines == [ ] then
          [ ]
        else
          let
            line = builtins.head lines;
            trimmed = lib.trim line;
          in
          if trimmed == "" || lib.hasPrefix "-" trimmed || lib.hasPrefix " " line then
            dropPackageBlock (lib.tail lines)
          else
            lines;

    in
    stripPrepLocalPnpmSettings (
      dropPackageBlock (dropUntilPackagesHeader (lib.splitString "\n" workspaceYaml))
    );

  formatWorkspaceYaml =
    packageDirs: suffixLines:
    let
      packagesBlock = builtins.concatStringsSep "\n" (
        [ "packages:" ] ++ map (dir: "  - ${dir}") packageDirs
      );
      suffix = builtins.concatStringsSep "\n" suffixLines;
    in
    if suffix == "" then "${packagesBlock}\n" else "${packagesBlock}\n\n${suffix}\n";

  workspaceClosureDirs =
    let
      genieData = packageJson."$genie" or { };
    in
    if !(genieData ? workspaceClosureDirs) then
      throw "mk-pnpm-cli: ${packageDir}/package.json missing $genie.workspaceClosureDirs (run: devenv tasks run genie:run)"
    else if !(lib.elem packageDir genieData.workspaceClosureDirs) then
      throw "mk-pnpm-cli: $genie.workspaceClosureDirs does not contain packageDir (${packageDir})"
    else
      genieData.workspaceClosureDirs;
  workspaceMembers = builtins.filter (dir: dir != packageDir) workspaceClosureDirs;

  resolvedWorkspaceMembers = map (
    dir:
    let
      resolved = resolveSourceFor dir;
    in
    {
      inherit dir;
      inherit resolved;
      sourcePath =
        if resolved.sourceRelPath == "." then
          resolved.sourceRoot
        else
          resolved.sourceRoot + "/${resolved.sourceRelPath}";
      evalSourcePath = resolved.evalSourcePath;
    }
  ) workspaceMembers;
  externalInstallRootItems = builtins.filter (item: item != null) (
    map (
      item:
      let
        prefixRootHasWorkspace =
          item.resolved.prefix != null
          && builtins.pathExists (item.resolved.evalSourceRoot + "/pnpm-workspace.yaml")
          && hasInstallRoot item.resolved.evalSourceRoot;
        memberHasInstallRoot = hasInstallRoot item.evalSourcePath;
      in
      if item.resolved.prefix == null then
        null
      else if prefixRootHasWorkspace then
        {
          installDir = item.resolved.prefix;
          installSourceRoot = item.resolved.sourceRoot;
          evalInstallSourceRoot = item.resolved.evalSourceRoot;
          memberDir = item.dir;
          sourceRelMemberDir = item.resolved.sourceRelPath;
        }
      else if memberHasInstallRoot then
        {
          installDir = item.dir;
          installSourceRoot = item.sourcePath;
          evalInstallSourceRoot = item.evalSourcePath;
          memberDir = item.dir;
          sourceRelMemberDir = ".";
        }
      else
        null
    ) resolvedWorkspaceMembers
  );

  externalInstallRoots = lib.sort (left: right: left.installDir < right.installDir) (
    map
      (
        installDir:
        let
          items = builtins.filter (item: item.installDir == installDir) externalInstallRootItems;
          installSourceRoot = (builtins.head items).installSourceRoot;
          evalInstallSourceRoot = (builtins.head items).evalInstallSourceRoot;
          hasWorkspaceYaml = builtins.pathExists (evalInstallSourceRoot + "/pnpm-workspace.yaml");
          sourcePnpmWorkspaceYaml =
            if hasWorkspaceYaml then builtins.readFile (evalInstallSourceRoot + "/pnpm-workspace.yaml") else "";
        in
        {
          inherit installDir installSourceRoot;
          inherit sourcePnpmWorkspaceYaml;
          memberDirs = lib.unique (map (item: item.memberDir) items);
          sourceRelMemberDirs = lib.unique (map (item: item.sourceRelMemberDir) items);
          filteredPnpmWorkspaceYaml =
            if hasWorkspaceYaml then
              formatWorkspaceYaml (lib.unique (map (item: item.sourceRelMemberDir) items)) (
                workspaceSuffixLines sourcePnpmWorkspaceYaml
              )
            else
              formatWorkspaceYaml [ "." ] [ ];
        }
      )
      (
        lib.sort (left: right: left < right) (
          lib.unique (map (item: item.installDir) externalInstallRootItems)
        )
      )
  );
  stagedWorkspaceMembers =
    let
      externallyOwnedDirs = lib.concatMap (root: root.memberDirs) externalInstallRoots;
    in
    lib.unique (
      [ packageDir ] ++ builtins.filter (dir: !(lib.elem dir externallyOwnedDirs)) workspaceMembers
    );
  allExternallyOwnedDirs =
    (map (root: root.installDir) externalInstallRoots)
    ++ (lib.concatMap (root: root.memberDirs) externalInstallRoots);
  aggregateOwnedWorkspaceClosureDirs = builtins.filter (
    dir: !(lib.elem dir allExternallyOwnedDirs)
  ) workspaceClosureDirs;

  # Dependency preparation already gives each external install root its own
  # dedicated deps-build. Keep the aggregate root workspace scoped to the
  # members it actually owns; otherwise pnpm validates external member manifests
  # against the aggregate root lockfile and reports false stale-lock failures.
  filteredRootPnpmWorkspaceYaml = formatWorkspaceYaml aggregateOwnedWorkspaceClosureDirs (
    workspaceSuffixLines rootPnpmWorkspaceYaml
  );

  # These are the files that define dependency identity for the aggregate root.
  # Keep this list narrow so source-only edits do not invalidate prepared deps,
  # but broad enough that any manifest / workspace policy drift still does.
  rootWorkspaceFiles = [
    "package.json"
    "pnpm-lock.yaml"
  ];
  optionalRootWorkspaceFiles = [
    ".npmrc"
    "pnpm-install-contract.json"
    "tsconfig.base.json"
  ];
  installRootScopedPath =
    installDir: relPath: if installDir == "." then relPath else "${installDir}/${relPath}";
  existingSourceFiles =
    relPaths:
    builtins.filter (relPath: builtins.pathExists (resolveSourceFor relPath).evalSourcePath) relPaths;
  # Expose a stable, CLI-friendly attr key while keeping the real install dir
  # in `dir`. This avoids leaking path separators into flake package names and
  # keeps downstream tooling simple.
  installRootAttrName =
    installDir:
    if installDir == "." then
      "root"
    else
      lib.strings.sanitizeDerivationName (lib.replaceStrings [ "/" ] [ "-" ] installDir);
  # Name the prepared-deps fixed-output derivation by its dependency profile
  # (install dir + member set) instead of the consumer's CLI name, so that
  # byte-identical profiles shared by many consumers collapse to one in-store
  # derivation rather than N consumer-named copies of the same content. The FOD
  # output hash is content-addressed, so this rename is hash-neutral: only the
  # store-path name changes, which is exactly what enables the deduplication.
  #
  # The profile key includes content freshness digests for the staged manifests
  # and inherited root patch authority, so the derivation name is still
  # consumer-invariant for byte-identical install roots but moves when the
  # prepared tree's dependency inputs move.
  installRootDepsDerivationName =
    root:
    "${lib.strings.sanitizeDerivationName (lib.replaceStrings [ "/" ] [ "-" ] root.installDir)}-deps-${
      builtins.substring 0 12 (installRootProfileKey root)
    }";
  installRootMemberDirs =
    root:
    if root ? memberDirs then
      lib.sort (left: right: left < right) root.memberDirs
    else
      [ root.installDir ];
  profileManifestInputsForRoot =
    root:
    let
      scopedFile = installRootScopedPath root.installDir;
      memberPackageJsons = map (dir: "${dir}/package.json") (
        builtins.filter (dir: dir != root.installDir) (installRootMemberDirs root)
      );
    in
    if root.installDir == "." then
      rootWorkspaceFiles
      ++ existingSourceFiles optionalRootWorkspaceFiles
      ++ [ "pnpm-workspace.yaml" ]
      ++ (map (dir: "${dir}/package.json") aggregateOwnedWorkspaceClosureDirs)
    else
      (map scopedFile rootWorkspaceFiles)
      ++ existingSourceFiles (map scopedFile optionalRootWorkspaceFiles)
      ++ [ (scopedFile "pnpm-workspace.yaml") ]
      ++ memberPackageJsons;
  rootPatchedDependenciesSection =
    lockfileContent:
    let
      lines = lib.splitString "\n" lockfileContent;
      startIndex = lib.lists.findFirstIndex (line: line == "patchedDependencies:") null lines;
    in
    if startIndex == null then
      ""
    else
      let
        rest = lib.lists.drop (startIndex + 1) lines;
        endOffset = lib.lists.findFirstIndex (
          line: line != "" && !(lib.hasPrefix " " line)
        ) (builtins.length rest) rest;
      in
      builtins.concatStringsSep "\n" (lib.lists.take endOffset rest);
  profileFreshnessInputsForRoot =
    root:
    let
      manifestInputs = profileManifestInputsForRoot root;
      manifestDigests = builtins.listToAttrs (
        map (relPath: {
          name = relPath;
          value = builtins.hashFile "sha256" (resolveEvalSourceFor relPath);
        }) manifestInputs
      );
      rootPatchAuthority =
        if root.installDir == "." then
          { }
        else
          {
            rootPatchedDependenciesSection = builtins.hashString "sha256" (
              rootPatchedDependenciesSection (builtins.readFile (resolveEvalSourceFor "pnpm-lock.yaml"))
            );
          };
    in
    {
      inherit manifestDigests rootPatchAuthority;
    };
  installRootProfile =
    root:
    dependencyProfile.mkPreparedDepsProfile {
      installDir = root.installDir;
      memberDirs = installRootMemberDirs root;
      lockfilePath = installRootScopedPath root.installDir "pnpm-lock.yaml";
      attrName = installRootAttrName root.installDir;
      depsHash = depsBuildHashForInstallRoot root.installDir;
      manifestInputs = profileManifestInputsForRoot root;
      freshnessInputs = profileFreshnessInputsForRoot root;
      policy = {
        packageImportMethod = if pkgs.stdenv.hostPlatform.isDarwin then "copy" else "clone-or-copy";
      };
    };
  /**
    Generic identity for a filtered install-root dependency boundary.

    This does not try to name downstream reuse profiles like "tui" or "full".
    Upstream only exposes the authoritative filtered member set plus a stable
    key derived from that set. Downstream repos can then decide whether a
    repeated boundary is worth naming and sharing for amortization.
  */
  installRootProfileKey = root: (installRootProfile root).profileKey;

  /**
    `depsBuilds` is the canonical source of truth for prepared pnpm artifacts.

    Each install root gets one fixed-output derivation, and the downstream CLI
    derivation depends on those prepared artifacts directly. That means the
    artifact hash already is the effective dependency fingerprint for downstream
    rebuilds: if the prepared tree changes, the store path changes and the CLI
    rebuilds; if it does not change, the CLI can reuse the cached deps build.

    A second builder-level fingerprint would only help faster preflight stale
    checks. It would not improve correctness, reuse, or downstream invalidation,
    so that concern stays in tooling rather than the builder contract.
  */
  depsBuildEntries = map (
    installDir:
    let
      entry = builtins.getAttr installDir depsBuilds;
    in
    if !(builtins.isAttrs entry && entry ? hash && builtins.isString entry.hash) then
      throw "mk-pnpm-cli: depsBuilds.${installDir} must be { hash = \"sha256-...\"; }"
    else
      {
        dir = installDir;
        inherit (entry) hash;
      }
  ) (builtins.attrNames depsBuilds);

  depsBuildHashForInstallRoot =
    installDir:
    if !(builtins.hasAttr installDir depsBuilds) then
      throw "mk-pnpm-cli: depsBuilds is missing an entry for install root ${installDir}"
    else
      let
        entry = builtins.getAttr installDir depsBuilds;
      in
      if !(builtins.isAttrs entry && entry ? hash && builtins.isString entry.hash) then
        throw "mk-pnpm-cli: depsBuilds.${installDir} must be { hash = \"sha256-...\"; }"
      else
        entry.hash;

  # Per-install-root opt-in: carry the workspace's declared optional native
  # bindings (pure-package-artifact families: @rolldown/binding-*, @esbuild/*,
  # lightningcss, oxc, ...) into this root's prepared deps FOD by dropping
  # `--no-optional`, bounded by pnpm-workspace.yaml `supportedArchitectures`.
  # Default stays false so bun-built CLIs that never load a native binding keep
  # small, platform-neutral prepared trees (backward-compatible). A consumer
  # whose build or runtime resolves such a binding from the isolated pnpm store
  # (e.g. `vite build` -> rolldown) sets this true; the native-binding closure
  # check then asserts every declared triple is present.
  includeOptionalDependenciesForInstallRoot =
    installDir:
    let
      entry = builtins.getAttr installDir depsBuilds;
    in
    entry.includeOptionalDependencies or false;

  mkdirOutParentCmd =
    relPath:
    let
      parent = builtins.dirOf relPath;
    in
    if parent == "." then ''mkdir -p "$out"'' else ''mkdir -p "$out/${parent}"'';

  copyFileCmd =
    relPath:
    let
      srcPath = absoluteFileSourcePathFor relPath;
    in
    ''
      ${mkdirOutParentCmd relPath}
      cp ${lib.escapeShellArg (toString srcPath)} "$out/${relPath}"
    '';

  copyDirCmd =
    relPath:
    let
      srcPath = absoluteDirectorySourcePathFor relPath;
    in
    ''
      ${mkdirOutParentCmd relPath}
      cp -R ${lib.escapeShellArg (toString srcPath)} "$out/${builtins.dirOf relPath}/"
      chmod -R +w "$out/${relPath}"
    '';

  copyOptionalFileCmd =
    relPath:
    let
      evalSrcPath = resolveEvalSourceFor relPath;
    in
    if builtins.pathExists evalSrcPath then
      if builtins.baseNameOf relPath == ".npmrc" then
        let
          # Local .npmrc may point at a developer-specific pure store path.
          # Strip those knobs so deps FODs remain portable across worktrees.
          npmrcFile = pkgs.writeText "npmrc" (
            builtins.concatStringsSep "\n" (
              stripPrepLocalNpmrcSettings (lib.splitString "\n" (builtins.readFile evalSrcPath))
            )
          );
        in
        ''
          ${mkdirOutParentCmd relPath}
          cp ${lib.escapeShellArg npmrcFile} "$out/${relPath}"
        ''
      else
        ''
          if [ -f ${lib.escapeShellArg (toString (absoluteFileSourcePathFor relPath))} ]; then
            ${copyFileCmd relPath}
          fi
        ''
    else
      "";

  writeWorkspaceYamlCmd =
    installDir: workspaceYaml:
    let
      targetPath = installRootScopedPath installDir "pnpm-workspace.yaml";
      workspaceYamlFile = pkgs.writeText "pnpm-workspace.yaml" workspaceYaml;
    in
    ''
      ${mkdirOutParentCmd targetPath}
      cp ${workspaceYamlFile} "$out/${targetPath}"
    '';

  /**
    Parse patch file paths from pnpm-workspace.yaml (pnpm 11+ format).
    In pnpm 11, patchedDependencies are declared in pnpm-workspace.yaml as:
      patchedDependencies:
        name@version: path/to/patch.patch
    The value after `: ` is the patch file path relative to the workspace root.
  */
  parseWorkspacePatchPaths =
    workspaceYamlContent:
    let
      lines = lib.splitString "\n" workspaceYamlContent;
      collect =
        {
          inBlock,
          paths,
        }:
        remaining:
        if remaining == [ ] then
          paths
        else
          let
            line = builtins.head remaining;
            rest = lib.tail remaining;
            trimmed = lib.trim line;
          in
          if !inBlock then
            if lib.hasPrefix "patchedDependencies:" trimmed then
              collect {
                inBlock = true;
                inherit paths;
              } rest
            else
              collect {
                inherit inBlock paths;
              } rest
          else if trimmed == "" then
            paths
          else if builtins.substring 0 1 line != " " && builtins.substring 0 1 line != "\t" then
            paths
          else
            let
              colonIdx = lib.stringLength (builtins.head (builtins.split ":" trimmed));
              value = lib.trim (builtins.substring (colonIdx + 1) (lib.stringLength trimmed) trimmed);
              isPatchPath = lib.hasSuffix ".patch" value;
            in
            if isPatchPath then
              collect {
                inherit inBlock;
                paths = paths ++ [ value ];
              } rest
            else
              collect {
                inherit inBlock paths;
              } rest;
    in
    collect {
      inBlock = false;
      paths = [ ];
    } lines;

  /**
    Copy patch files referenced by a workspace, resolving each patch path to an
    exact staged input so source-only edits outside the patch files themselves
    do not invalidate dependency preparation.
  */
  copyResolvedPatchFilesCmd =
    {
      sourcePrefix ? "",
      workspaceYamlContent,
      targetPrefix,
    }:
    let
      patchPaths = parseWorkspacePatchPaths workspaceYamlContent;
      copyOnePatch =
        relPath:
        let
          sourceRelPath = if sourcePrefix == "" then relPath else "${sourcePrefix}/${relPath}";
          srcPath = absoluteFileSourcePathFor sourceRelPath;
          targetRelPath = if targetPrefix == "" then relPath else "${targetPrefix}/${relPath}";
          srcPathArg = lib.escapeShellArg (toString srcPath);
          targetRelPathArg = lib.escapeShellArg targetRelPath;
          targetParentArg = lib.escapeShellArg (builtins.dirOf targetRelPath);
        in
        ''
          target_patch=${targetRelPathArg}
          target_parent=${targetParentArg}
          mkdir -p "$out/$target_parent"
          chmod -R +w "$out/$target_parent" 2>/dev/null || true
          cp ${srcPathArg} "$out/$target_patch"
        '';
    in
    builtins.concatStringsSep "\n" (map copyOnePatch patchPaths);

  stageExternalInstallRootManifestOnlyCmd =
    root:
    builtins.concatStringsSep "\n" (
      (map (file: copyFileCmd (installRootScopedPath root.installDir file)) rootWorkspaceFiles)
      ++ (map (
        file: copyOptionalFileCmd (installRootScopedPath root.installDir file)
      ) optionalRootWorkspaceFiles)
      ++ (map (dir: copyFileCmd "${dir}/package.json") (
        builtins.filter (dir: dir != root.installDir) root.memberDirs
      ))
      ++ [
        (writeWorkspaceYamlCmd root.installDir root.filteredPnpmWorkspaceYaml)
        (copyResolvedPatchFilesCmd {
          sourcePrefix = root.installDir;
          workspaceYamlContent = root.sourcePnpmWorkspaceYaml;
          targetPrefix = root.installDir;
        })
      ]
    );

  # The aggregate root owns the top-level lockfile plus any workspace members
  # not delegated to nested install roots. It still stages external install-root
  # manifests so the aggregate lockfile can resolve linked workspace packages
  # against the exact member set that will exist in the final composed build.
  rootDepsSrc = pkgs.runCommand "${name}-pnpm-deps-src" { } (
    ''
      set -euo pipefail
      mkdir -p "$out"
    ''
    + builtins.concatStringsSep "\n" (map copyFileCmd rootWorkspaceFiles)
    + builtins.concatStringsSep "\n" (map copyOptionalFileCmd optionalRootWorkspaceFiles)
    + writeWorkspaceYamlCmd "." filteredRootPnpmWorkspaceYaml
    + builtins.concatStringsSep "\n" (
      map (dir: copyFileCmd "${dir}/package.json") aggregateOwnedWorkspaceClosureDirs
    )
    + copyResolvedPatchFilesCmd {
      sourcePrefix = "";
      workspaceYamlContent = rootPnpmWorkspaceYaml;
      targetPrefix = "";
    }
    + builtins.concatStringsSep "\n" (map stageExternalInstallRootManifestOnlyCmd externalInstallRoots)
    + stageRootSourceInputManifestAliasesCmd
  );

  # Each external install root gets its own manifest-only derivation and its
  # own prepared deps artifact. This is the key reuse boundary for composed
  # workspaces: root-only changes should not force a full reinstall of
  # `repos/effect-utils`, while changes inside that nested workspace should
  # still invalidate its own prepared tree deterministically.
  externalInstallRootDeps = map (
    root:
    let
      depsSrc = pkgs.runCommand "${installRootDepsDerivationName root}-pnpm-deps-src" { } (
        ''
          set -euo pipefail
          mkdir -p "$out"
        ''
        + stageExternalInstallRootManifestOnlyCmd root
        + copyResolvedPatchFilesCmd {
          sourcePrefix = "";
          workspaceYamlContent = rootPnpmWorkspaceYaml;
          targetPrefix = "${root.installDir}/.root-patches";
        }
        + ''
          mkdir -p "$out/.root-patch-authority"
          cp ${lib.escapeShellArg (toString (absoluteFileSourcePathFor "pnpm-lock.yaml"))} "$out/.root-patch-authority/pnpm-lock.yaml"
          cp ${lib.escapeShellArg (toString (absoluteFileSourcePathFor "pnpm-workspace.yaml"))} "$out/.root-patch-authority/pnpm-workspace.yaml"
        ''
      );
      lockfilePath = installRootScopedPath root.installDir "pnpm-lock.yaml";
      depsBuild = pnpmDepsHelper.mkDeps {
        name = installRootDepsDerivationName root;
        src = depsSrc;
        sourceRoot = ".";
        lockfilePaths = [ lockfilePath ];
        # Fixed-output dependency preparation must not let pnpm repair or
        # resolve the staged lockfile inside the sandbox. If a synthetic
        # install root is stale, fail here and fix the staged lockfile source.
        frozenLockfile = true;
        preInstall = ''
          chmod -R +w .
          ${pkgs.nodejs}/bin/node ${inheritRootPatchedDependenciesScript} .root-patch-authority ${lib.escapeShellArg root.installDir}
          rm -rf .root-patch-authority
        '';
        includeOptionalDependencies = includeOptionalDependenciesForInstallRoot root.installDir;
        pnpmDepsHash = depsBuildHashForInstallRoot root.installDir;
      };
    in
    root
    // {
      attrName = installRootAttrName root.installDir;
      inherit depsSrc lockfilePath depsBuild;
    }
  ) externalInstallRoots;

  # Keep the aggregate root as a first-class install root alongside any nested
  # composed roots. Final restoration simply overlays each prepared tree into
  # the full workspace snapshot in a deterministic order.
  rootInstallRoot = {
    attrName = "root";
    installDir = ".";
    lockfilePath = "pnpm-lock.yaml";
    depsSrc = rootDepsSrc;
    depsBuild = pnpmDepsHelper.mkDeps {
      inherit name;
      pnpmDepsHash = depsBuildHashForInstallRoot ".";
      src = rootDepsSrc;
      sourceRoot = ".";
      lockfilePaths = [ "pnpm-lock.yaml" ];
      includeOptionalDependencies = includeOptionalDependenciesForInstallRoot ".";
      # Fixed-output dependency preparation must be a pure materialization of
      # the staged manifests and lockfile. Unfrozen installs can rewrite the
      # effective dependency graph and produce hash ping-pong across builders.
      frozenLockfile = true;
      preInstall = ''
        chmod -R +w .
      '';
    };
  };
  depsInstallRoots = [ rootInstallRoot ] ++ externalInstallRootDeps;
  installRootDirs = map (root: root.installDir) depsInstallRoots;
  unknownDepsBuildDirs = builtins.filter (dir: !(lib.elem dir installRootDirs)) (
    builtins.attrNames depsBuilds
  );
  _validateInstallRootHashContract =
    if unknownDepsBuildDirs != [ ] then
      throw "mk-pnpm-cli: depsBuilds contains unknown install roots"
    else if builtins.length depsInstallRoots == 0 then
      throw "mk-pnpm-cli: expected at least one install root"
    else if builtins.any (installDir: !(builtins.hasAttr installDir depsBuilds)) installRootDirs then
      throw ''
        mk-pnpm-cli: depsBuilds must provide one { hash = "..."; } entry per install root.
        discovered install roots: ${builtins.toJSON installRootDirs}
        provided depsBuild keys: ${builtins.toJSON (builtins.attrNames depsBuilds)}
        example:
          depsBuilds = {
            "." = { hash = "sha256-..."; };
          };
      ''
    else
      true;
  depsBuildsByInstallRoot = builtins.listToAttrs (
    map (root: {
      name = root.attrName;
      value = root.depsBuild;
    }) depsInstallRoots
  );
  dependencyMaterializationProfiles = map installRootProfile depsInstallRoots;
  dependencyMaterializationEvidence = dependencyProfile.mkEvidence {
    packageName = packageJson.name;
    inherit packageDir;
    profiles = dependencyMaterializationProfiles;
  };
  fodHashRepairTargets = map (
    root:
    let
      profile = installRootProfile root;
      depsHash = depsBuildHashForInstallRoot root.installDir;
    in
    {
      schemaVersion = 1;
      kind = "dependency-fod-hash-repair-target";
      producer = "effect-utils.mk-pnpm-cli";
      subject = {
        packageName = packageJson.name;
        inherit packageDir;
      };
      inherit (root) attrName installDir lockfilePath;
      memberDirs = installRootMemberDirs root;
      profileKey = profile.profileKey;
      declaredHash = depsHash;
      depsDrvPath = root.depsBuild.drvPath;
      hashPath = [
        "depsBuilds"
        root.installDir
        "hash"
      ];
      inputs = profile.inputs;
      freshness = profile.freshness;
      traits = profile.traits;
    }
  ) depsInstallRoots;
  buck2DependencyMaterializationEvidence = dependencyProfile.mkBuck2Evidence {
    packageName = packageJson.name;
    inherit packageDir;
    evidence = dependencyMaterializationEvidence;
  };
  depsSrcByInstallRoot = builtins.listToAttrs (
    map (root: {
      name = root.attrName;
      value = root.depsSrc;
    }) depsInstallRoots
  );

  materializeWorkspace =
    {
      nameSuffix,
      manifestOnly,
    }:
    pkgs.runCommand "${name}-${nameSuffix}" { } (
      ''
        set -euo pipefail
        mkdir -p "$out"
      ''
      + builtins.concatStringsSep "\n" (map copyFileCmd rootWorkspaceFiles)
      + builtins.concatStringsSep "\n" (map copyOptionalFileCmd optionalRootWorkspaceFiles)
      + writeWorkspaceYamlCmd "." filteredRootPnpmWorkspaceYaml
      + builtins.concatStringsSep "\n" (
        map (
          root:
          builtins.concatStringsSep "\n" (
            (
              # `manifestOnly` is used for dependency preparation, where we want
              # the narrowest possible invalidation boundary. The full workspace
              # snapshot is used later by the actual CLI build, where source
              # files are needed but dependency prep should already be cached.
              if manifestOnly then
                (map (file: copyFileCmd "${root.installDir}/${file}") rootWorkspaceFiles)
                ++ (map (file: copyOptionalFileCmd "${root.installDir}/${file}") optionalRootWorkspaceFiles)
                ++ (map (dir: copyFileCmd "${dir}/package.json") (
                  builtins.filter (dir: dir != root.installDir) root.memberDirs
                ))
              else if lib.elem root.installDir root.memberDirs then
                [ (copyDirCmd root.installDir) ]
              else
                (map (file: copyFileCmd "${root.installDir}/${file}") rootWorkspaceFiles)
                ++ (map (file: copyOptionalFileCmd "${root.installDir}/${file}") optionalRootWorkspaceFiles)
                ++ (map copyDirCmd (builtins.filter (dir: dir != root.installDir) root.memberDirs))
            )
            ++ [
              (writeWorkspaceYamlCmd root.installDir root.filteredPnpmWorkspaceYaml)
            ]
          )
        ) externalInstallRoots
      )
      + builtins.concatStringsSep "\n" (
        if manifestOnly then
          map (dir: copyFileCmd "${dir}/package.json") aggregateOwnedWorkspaceClosureDirs
        else
          map copyDirCmd aggregateOwnedWorkspaceClosureDirs
      )
      + copyResolvedPatchFilesCmd {
        sourcePrefix = "";
        workspaceYamlContent = rootPnpmWorkspaceYaml;
        targetPrefix = "";
      }
      + builtins.concatStringsSep "\n" (
        map (
          root:
          copyResolvedPatchFilesCmd {
            sourcePrefix = root.installDir;
            workspaceYamlContent = root.sourcePnpmWorkspaceYaml;
            targetPrefix = root.installDir;
          }
        ) externalInstallRoots
      )
    );

  workspaceClosureSrc = materializeWorkspace {
    nameSuffix = "workspace";
    manifestOnly = false;
  };

  entryRelativeToPackage =
    if lib.hasPrefix "${packageDir}/" entry then
      lib.removePrefix "${packageDir}/" entry
    else
      throw "mk-pnpm-cli: entry must be inside packageDir (${packageDir}): ${entry}";

  dirtyStr = if dirty then "true" else "false";
  nixStampJson = ''{\"type\":\"nix\",\"version\":\"${packageVersion}\",\"rev\":\"${gitRev}\",\"commitTs\":${toString commitTs},\"dirty\":${dirtyStr}}'';
  smokeTestArgsStr = lib.escapeShellArgs smokeTestArgs;

  /**
    Post-restore dedup: symlink overlapping .pnpm entries from external install
    roots to the aggregate root's copies. pnpm's .pnpm dir names are
    content-addressed (<name>@<version>_<peer-hash>), so matching names guarantee
    identical content — safe to deduplicate unconditionally.

    Each Nix install root owns an isolated .pnpm topology. This dedup step
    shares already-selected immutable package content without creating a
    second dependency-edge selector.

    Without this, bun's bundler treats each physical copy as a distinct module,
    creating duplicate singletons (TagProto, GenericTag, Context.Tag registries)
    that break cross-root service resolution at runtime.
  */
  dedupPnpmScript =
    if externalInstallRoots == [ ] then
      ""
    else
      let
        perRootScript =
          root:
          let
            installDirDepth = builtins.length (lib.splitString "/" root.installDir);
            # Symlink targets resolve relative to the parent directory (.pnpm/),
            # so we go up: .pnpm + node_modules + installDir segments.
            upCount = installDirDepth + 2;
            relPrefix = lib.concatStringsSep "/" (builtins.genList (_: "..") upCount) + "/node_modules/.pnpm";
          in
          ''
            ext_pnpm="workspace/${root.installDir}/node_modules/.pnpm"
            if [ -d "$ext_pnpm" ]; then
              chmod u+w "$ext_pnpm" 2>/dev/null || true
              for entry in "$ext_pnpm"/*/; do
                [ -d "$entry" ] || continue
                entry_name="$(basename "$entry")"
                if [ -d "$agg_pnpm/$entry_name" ] && [ ! -L "''${entry%/}" ]; then
                  chmod -R u+w "''${entry%/}" 2>/dev/null || true
                  rm -rf "''${entry%/}"
                  ln -s "${relPrefix}/$entry_name" "''${entry%/}"
                  dedup_count=$((dedup_count + 1))
                fi
              done
            fi
          '';
      in
      ''
        dedupStartedAt=$(timer_now)
        dedup_count=0
        agg_pnpm="workspace/node_modules/.pnpm"

        ${builtins.concatStringsSep "\n" (map perRootScript externalInstallRoots)}

        log_cli_phase "dedup-pnpm" "duration=$(timer_elapsed "$dedupStartedAt")s deduped=$dedup_count external_roots=${toString (builtins.length externalInstallRoots)}"
      '';

  nativeNodePackageEntries = builtins.concatStringsSep "\n" (
    map (
      nativePackage:
      "${lib.escapeShellArg nativePackage.name}\t${lib.escapeShellArg nativePackage.package}"
    ) nativeNodePackages
  );

  linkNativeNodePackagesScript =
    if nativeNodePackages == [ ] then
      ""
    else
      let
        externalRootNodeModulesDirs = builtins.concatStringsSep "\n" (
          map (
            root: ''native_node_modules_dirs+=("$NIX_BUILD_TOP/workspace/${root.installDir}/node_modules")''
          ) externalInstallRoots
        );
      in
      ''
        nativePackageLinkStartedAt=$(timer_now)
        native_node_modules_dirs=("$NIX_BUILD_TOP/workspace/node_modules")
        ${externalRootNodeModulesDirs}

        native_package_count=0
        while IFS=$'\t' read -r native_package_name native_package_path; do
          [ -n "$native_package_name" ] || continue
          native_package_count=$((native_package_count + 1))
          for node_modules_dir in "''${native_node_modules_dirs[@]}"; do
            [ -d "$node_modules_dir" ] || continue
            target="$node_modules_dir/$native_package_name"
            chmod u+w "$node_modules_dir" "$(dirname "$target")" 2>/dev/null || true
            mkdir -p "$(dirname "$target")"
            rm -rf "$target"
            ln -s "$native_package_path" "$target"
          done
          log_cli_phase "link-native-node-package" "package=$native_package_name"
        done < <(printf '%s\n' ${lib.escapeShellArg nativeNodePackageEntries})

        log_cli_phase "link-native-node-packages" "duration=$(timer_elapsed "$nativePackageLinkStartedAt")s packages=$native_package_count node_modules_dirs=''${#native_node_modules_dirs[@]}"
      '';

in
assert _validateInstallRootHashContract;
pkgs.stdenv.mkDerivation {
  inherit name;

  nativeBuildInputs = [
    pkgs.bun
    pkgs.nix
    pkgs.nodejs
    pkgs.perl
    pnpm
  ];

  dontUnpack = true;
  dontFixup = true;
  passthru = {
    depsSrc = rootDepsSrc;
    inherit
      depsSrcByInstallRoot
      depsBuildsByInstallRoot
      buck2DependencyMaterializationEvidence
      dependencyMaterializationEvidence
      dependencyMaterializationProfiles
      fodHashRepairTargets
      inheritRootPatchedDependenciesScript
      ;
    installRoots = map (root: {
      inherit (root) attrName installDir lockfilePath;
      memberDirs = installRootMemberDirs root;
      profileKey = installRootProfileKey root;
    }) depsInstallRoots;
    depsBuildEntries = map (root: {
      dir = root.installDir;
      attrName = root.attrName;
      drvPath = root.depsBuild.drvPath;
      memberDirs = installRootMemberDirs root;
      profileKey = installRootProfileKey root;
      hash = depsBuildHashForInstallRoot root.installDir;
      freshness = (installRootProfile root).freshness;
    }) depsInstallRoots;
    # One closure-completeness check per install root, keyed by the same
    # normalized attrName as depsBuildsByInstallRoot (installDir "." -> "root").
    # Consumers wire e.g. `checks.<system>.<name> = cli.nativeBindingClosureChecks.root;`.
    # Engagement is warn-mode unless the root opted into includeOptionalDependencies.
    nativeBindingClosureChecks = builtins.listToAttrs (
      map (root: {
        name = root.attrName;
        value = nativeBindingClosureCheckFactory {
          depsBuild = root.depsBuild;
          name = "${name}-${root.attrName}";
          installDir = root.installDir;
          includeOptionalDependencies = includeOptionalDependenciesForInstallRoot root.installDir;
        };
      }) depsInstallRoots
    );
  };

  buildPhase = ''
    set -euo pipefail
    runHook preBuild

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

    log_cli_phase() {
      local phase="$1"
      shift
      echo "cli-build: phase=$phase cli=${binaryName} package=${packageDir} $*"
    }

    buildStartedAt=$(timer_now)
    log_cli_phase "start" "install_roots=${toString (builtins.length depsInstallRoots)}"

    echo "Copying filtered aggregate workspace..."
    workspaceCopyStartedAt=$(timer_now)
    cp -r ${workspaceClosureSrc} workspace
    chmod -R +w workspace
    log_cli_phase "workspace-copy" "duration=$(timer_elapsed "$workspaceCopyStartedAt")s"

    ${builtins.concatStringsSep "\n" (
      map (
        root:
        pnpmDepsHelper.mkRestoreScript {
          deps = root.depsBuild;
          target = "workspace";
          label = root.installDir;
        }
      ) depsInstallRoots
    )}
    chmod u+w workspace workspace/.npmrc 2>/dev/null || true
    chmod -R u+w workspace/${packageDir} 2>/dev/null || true

    ${dedupPnpmScript}

    ${linkNativeNodePackagesScript}

    cd workspace

    # Keep pnpm itself deterministic for workspace-prep helpers while exposing a
    # shared wrapper for already-installed workspace binaries in postBuild hooks.
    export HOME=$(mktemp -d "$NIX_BUILD_TOP/pnpm-home.XXXXXX")
    export PNPM_HOME="$HOME/.local/share/pnpm"
    export WORKSPACE_ROOT_BIN_DIR="$NIX_BUILD_TOP/workspace/node_modules/.bin"
    mkdir -p "$PNPM_HOME"
    printf 'pm-on-fail=ignore\n' >> .npmrc
    run_workspace_bin() {
      local bin_name="$1"
      shift
      local package_bin_dir="$PWD/node_modules/.bin"

      if [ -x "$package_bin_dir/$bin_name" ]; then
        "$package_bin_dir/$bin_name" "$@"
      elif [ -x "$WORKSPACE_ROOT_BIN_DIR/$bin_name" ]; then
        "$WORKSPACE_ROOT_BIN_DIR/$bin_name" "$@"
      else
        echo "error: workspace binary '$bin_name' not found in $package_bin_dir or $WORKSPACE_ROOT_BIN_DIR" >&2
        exit 127
      fi
    }

    cd ${packageDir}

    if [ -f "${entryRelativeToPackage}" ]; then
      stampStartedAt=$(timer_now)
      substituteInPlace "${entryRelativeToPackage}" \
        --replace-quiet "const buildStamp = '__CLI_BUILD_STAMP__'" "const buildStamp = '${nixStampJson}'"
      log_cli_phase "stamp-build-metadata" "duration=$(timer_elapsed "$stampStartedAt")s entry=${entryRelativeToPackage}"
    fi

    echo "Building CLI..."
    mkdir -p output
    bunBuildStartedAt=$(timer_now)
    bun build ${entryRelativeToPackage} --compile ${lib.concatStringsSep " " extraBunBuildArgs} --outfile=output/${binaryName}
    binaryBytes=$(path_bytes "output/${binaryName}")
    log_cli_phase "bun-build" "duration=$(timer_elapsed "$bunBuildStartedAt")s binary_size=$(format_bytes "$binaryBytes")"

    if [ -n "${smokeTestArgsStr}" ]; then
      echo "Running smoke test..."
      smokeStartedAt=$(timer_now)
      NODE_PATH="$NIX_BUILD_TOP/workspace/node_modules" ./output/${binaryName} ${smokeTestArgsStr}
      log_cli_phase "smoke-test" "duration=$(timer_elapsed "$smokeStartedAt")s args=${lib.escapeShellArg (builtins.concatStringsSep " " smokeTestArgs)}"
    fi

    log_cli_phase "build-complete" "duration=$(timer_elapsed "$buildStartedAt")s"

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install_timer_now() {
      perl -MTime::HiRes=time -e 'printf "%.3f", time'
    }

    install_timer_elapsed() {
      perl -e 'printf "%.3f", $ARGV[1] - $ARGV[0]' "$1" "$(install_timer_now)"
    }

    install_format_bytes() {
      numfmt --to=iec-i --suffix=B --format='%.1f' "$1" 2>/dev/null || echo "$1"'B'
    }

    installStartedAt=$(install_timer_now)
    mkdir -p "$out/bin"
    cp "$NIX_BUILD_TOP/workspace/${packageDir}/output/${binaryName}" "$out/bin/"
    ${lib.optionalString installRuntimeWorkspace ''
      mkdir -p "$out/libexec"
      cp -R "$NIX_BUILD_TOP/workspace" "$out/libexec/workspace"
    ''}
    installedBytes=$(du --apparent-size -sk "$out/bin/${binaryName}" 2>/dev/null | awk '{print $1 * 1024}')
    installedBytes=''${installedBytes:-0}
    echo "cli-build: phase=install cli=${binaryName} package=${packageDir} duration=$(install_timer_elapsed "$installStartedAt")s installed_size=$(install_format_bytes "$installedBytes")"

    ${lib.optionalString generateCompletions ''
      # Generate shell completions. Effect CLIs commonly support `--log-level none`,
      # but package builders must also work for CLIs that expose completions without
      # that logging flag.
      mkdir -p "$out/share/fish/vendor_completions.d"
      mkdir -p "$out/share/bash-completion/completions"
      mkdir -p "$out/share/zsh/site-functions"

      generate_completion() {
        shell_name="$1"
        target="$2"
        output_file="$(mktemp)"
        stderr_file="$(mktemp)"

        if "$out/bin/${binaryName}" --log-level none --completions "$shell_name" > "$output_file" 2>"$stderr_file"; then
          mv "$output_file" "$target"
          rm -f "$stderr_file"
          return 0
        fi

        if "$out/bin/${binaryName}" --completions "$shell_name" > "$output_file" 2>"$stderr_file"; then
          mv "$output_file" "$target"
          rm -f "$stderr_file"
          return 0
        fi

        echo "mk-pnpm-cli: warning: failed to generate $shell_name completions for ${binaryName}" >&2
        cat "$stderr_file" >&2
        rm -f "$output_file" "$stderr_file"
      }

      generate_completion fish "$out/share/fish/vendor_completions.d/${binaryName}.fish"
      generate_completion bash "$out/share/bash-completion/completions/${binaryName}"
      generate_completion zsh "$out/share/zsh/site-functions/_${binaryName}"
    ''}
    runHook postInstall
  '';
}
