{ pkgs }:

pkgs.buildNpmPackage (finalAttrs: {
  pname = "netlify-cli";
  version = "27.5.0";

  src = pkgs.lib.cleanSourceWith {
    src = ./.;
    filter =
      path: _type:
      builtins.elem (baseNameOf path) [
        "package.json"
        "package-lock.json"
      ];
  };
  npmDepsHash = "sha256-rOE88s1Ar8lpofvupX9IQJoz/JW/ZyE+YgLNq0dOa+k=";

  dontNpmBuild = true;
  npmInstallFlags = [ "--omit=optional" ];
  npmPruneFlags = [ "--omit=optional" ];
  npmRebuildFlags = [ "--ignore-scripts" ];
  nativeBuildInputs = [ pkgs.makeWrapper ];

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/bin" "$out/lib/netlify-cli"
    cp -R node_modules package.json package-lock.json "$out/lib/netlify-cli/"

    makeWrapper ${pkgs.nodejs_24}/bin/node "$out/bin/netlify" \
      --add-flags "$out/lib/netlify-cli/node_modules/netlify-cli/bin/run.js"
    ln -s "$out/bin/netlify" "$out/bin/ntl"

    runHook postInstall
  '';

  passthru.tests.version = pkgs.runCommand "${finalAttrs.pname}-version-test" { } ''
    export HOME="$TMPDIR/home"
    export XDG_CONFIG_HOME="$TMPDIR/config"
    mkdir -p "$HOME" "$XDG_CONFIG_HOME"
    ${finalAttrs.finalPackage}/bin/netlify --version
    touch "$out"
  '';

  meta = {
    description = "Netlify command line interface";
    homepage = "https://docs.netlify.com/api-and-cli-guides/cli-guides/get-started-with-cli/";
    license = pkgs.lib.licenses.mit;
    mainProgram = "netlify";
  };
})
