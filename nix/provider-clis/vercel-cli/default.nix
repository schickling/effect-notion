{ pkgs }:

pkgs.buildNpmPackage (finalAttrs: {
  pname = "vercel-cli";
  version = "59.11.7";

  src = pkgs.lib.cleanSourceWith {
    src = ./.;
    filter =
      path: _type:
      builtins.elem (baseNameOf path) [
        "package.json"
        "package-lock.json"
      ];
  };
  npmDepsHash = "sha256-oaD0HMwJnlFoEoHal47qqsmagE7OnAt/rCqE61FC67M=";

  dontNpmBuild = true;
  npmRebuildFlags = [ "--ignore-scripts" ];
  nativeBuildInputs = [ pkgs.makeWrapper ];

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/bin" "$out/lib/vercel-cli"
    cp -R node_modules package.json package-lock.json "$out/lib/vercel-cli/"

    makeWrapper ${pkgs.nodejs_24}/bin/node "$out/bin/vercel" \
      --add-flags "$out/lib/vercel-cli/node_modules/vercel/dist/vc.js"
    ln -s "$out/bin/vercel" "$out/bin/vc"

    runHook postInstall
  '';

  passthru.tests.version = pkgs.runCommand "${finalAttrs.pname}-version-test" { } ''
    ${finalAttrs.finalPackage}/bin/vercel --version
    touch "$out"
  '';

  meta = {
    description = "Vercel command line interface";
    homepage = "https://vercel.com/docs/cli";
    license = pkgs.lib.licenses.asl20;
    mainProgram = "vercel";
  };
})
