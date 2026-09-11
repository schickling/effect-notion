# Workspace Editor Authority

Date: 2026-09-11 — Host: dev3 (x86_64-linux) — Buck2 2026-09-01.

## Question

Does the package-local editor mechanism cover the complete admitted workspace,
and can a real package consumer resolve through the published Buck view without
a root dependency installation?

## Method

1. Derived the editor plan and ownership requirement from the root source-generator
   consumer plus the canonical workspace package registry.
2. Queried Buck for every `:editor_view_inputs` target under the effect-utils
   cell.
3. Built the tui-core manifest, published its finite declared-root snapshot,
   and ran the staleness checker against that snapshot.
4. Temporarily removed the repository-root `node_modules` link and ran tsgo
   against tui-core's package tsconfig through its published package-local view.
5. Built and published the oxc-config view, then ran the repository-wide Buck
   static aggregate. This exercises a JavaScript lint plugin loaded from the
   source checkout while its dependency resolves through package-local
   `node_modules`.
6. Published the root source-generator view from the committed graph, ran
   `genie:check`, regenerated the two expected changed authority projections,
   and proved all 148 generated files fresh.
7. Replayed authoritative publication from the fresh graph and checked every
   root and package view.
8. Ran the native PTY source complement through the package view with an
   immutable Nix `node-pty` resolver hook rather than mutating `node_modules`.
9. Ran the focused orchestration, ownership, publication, retention,
   package-projection, generator-census, pnpm-module, and static-authority checks.

## Result

- The source registry exposes 38 package editor manifests and the root
  source-generator consumer, for 39 authoritative consumers. The nested
  `effect-rpc-tanstack/examples/basic` package is independently admitted; its
  parent static source set excludes `examples/basic/**`, so ownership does not
  overlap.
- Tui-core publish and immediate check both succeeded. With root
  `node_modules` absent, `tsgo --noEmit -p packages/@overeng/tui-core/tsconfig.json`
  exited 0.
- The first static run failed because oxc-config had no package-local view and
  therefore could not resolve `@stylexjs/eslint-plugin`. Publishing the
  oxc-config view fixed that real consumer boundary. The unchanged
  `effect_utils//buck2/static:check` invocation then succeeded.
- Committed-graph bootstrap published 39 views. Root `node_modules` became
  `.editor-view/root/node_modules`; source-side Genie ran through it without a
  root package-manager install. Fresh-graph publication and the independent
  checker both covered all 39 consumers.
- A committed-tree cold archive with no `node_modules` ran all 42 marked
  bootstrap-phase generators through the existing packaged Genie binary; none
  errored.
- The native PTY complement passed 23 tests with one skipped through the Nix
  resolver hook. The combined editor/generator suite passed 109 tests with
  3,533 assertions; the pnpm module smoke suite passed; the complete Buck
  static authority built successfully.
- Nix syntax evaluation of `devenv.nix` and both changed task modules succeeded.
  Direct module evaluation proved both Nix hash-check prerequisite arrays empty
  when dependency publication is disabled. No Nix build or devenv task
  invocation was run because available root space remained below the enforced
  200 GB policy floor.

## Conclusion

The workspace publication product is derived from one complete
root-plus-package registry rather than package-specific task wiring. Runtime
evidence covers committed-graph bootstrap, source-generation freshness,
fresh-graph publication and checking, root-install-independent TypeScript and
JavaScript consumers, and native source tests without mutable dependency-tree
grafting. The previous continuously attached Neovim/vtsls soak remains the live
language-server evidence for the same atomic pointer and settle-signal mechanism.

## VRS Impact

Closes the package and root source-generator surface of decision 0015,
supersedes the old `tui-core`-only task contract, and completes the root
package-manager installation producer deletion. Decision 0030 records the
narrow committed-graph bootstrap exception that keeps source freshness
non-circular.
