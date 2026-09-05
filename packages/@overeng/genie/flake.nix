{
  description = "Genie CLI for generating config files from .genie.ts templates";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    effect-utils = {
      url = "path:../../..";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.flake-utils.follows = "flake-utils";
    };
  };

  outputs =
    {
      effect-utils,
      flake-utils,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (system: {
      packages.default = effect-utils.packages.${system}.genie;
    });
}
