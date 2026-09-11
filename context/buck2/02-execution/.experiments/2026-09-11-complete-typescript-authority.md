# Complete TypeScript Authority

Status: accepted
Date: 2026-09-11

## Question

Can Buck become the sole TypeScript checker and declaration producer for every repository project, including independent strict-consumer projects and the source tools that generate the Buck graph, without retaining a root compiler fallback?

## Method

The package-local TypeScript projection now declares one or more project authorities. Each project owns its project file and typecheck target; at most one project in a package may own declaration publication. One registry derives the complete check plan and its declaration-producing subset.

The transfer admitted the ten-project residual: the two context examples, effect-schema-form-aria, the effect-rpc-tanstack basic example, React Inspector's independent strict consumer, buck2-tools, Genie, kdl-effect, megarepo, and tui-stories. The old root check and emit solutions and their devenv tasks were deleted in the same tranche. The remaining root `tsconfig.lint.json` is a lint program, not a compiler producer.

Bootstrap-critical projects use an explicit stage-zero boundary: the already available source Genie executable writes the committed Buck graph before Buck analysis. No Buck target generates the graph that defines itself. Once generated, Genie, kdl-effect, megarepo, buck2-tools, and tui-stories are checked and emitted only by their package-local Buck targets.

Proof used the synthesized composition at `/tmp/effect-utils-unit-proof-fresh`, the composition-owned Buck wrapper, pinned Bun/effect-tsgo toolchains, and local-only execution. The declaration runtime then built and atomically published every emitting target. A negative control inserted `const buckAuthorityNegativeProof: string = 42` into the admitted socket project, built only that package's typecheck target, restored the source, and rebuilt the target.

## Result

- **Complete registry PASS:** the authority registry contains 39 unique TypeScript projects. Its declaration subset contains 35 unique publishers.
- **Complete check PASS:** `typescript-authority-runtime.ts build` successfully built the complete 39-project check plan plus the governed test/toolchain targets in the synthesized composition. The final post-cleanup proof executed 72 local commands in 47.33 seconds, used no remote execution, and reported `BUILD SUCCEEDED`.
- **Strict consumer PASS:** `effect_utils//packages/@overeng/react-inspector:strict_consumer_typecheck` built successfully as an independent project target.
- **Declaration publication PASS:** `typescript-authority-runtime.ts materialize-dist` built and atomically published all 35 declaration targets. Every target reported `BUILD SUCCEEDED`; total wall time was 89.65 seconds. Publication validates each declared entrypoint before accepting the tree.
- **Negative control PASS:** the socket mutation failed `effect_utils//context/effect/socket:typecheck` with TS2322, `Type 'number' is not assignable to type 'string'`. After restoration, the same target succeeded.
- **Authority unit PASS:** the projection, admission, runtime-plan, and runtime-closure suites passed 55/55 tests. The declaration runner suite passed 12/12 tests. The focused atomic publisher cases passed 4/4 rollback and replacement scenarios.
- **Legacy deletion PASS:** the active devenv, CI, editor-task, README, AGENTS, and script surfaces contain no positive invocation of `ts:check`, `ts:check:strict`, `ts:build`, `ts:build-watch`, `ts:emit`, `tsconfig.check.json`, or `tsconfig.emit.json`. The task-graph guard retains those names only to assert that they are absent.
- **Bootstrap boundary PASS:** direct stage-zero Genie generation completed before the synthetic Buck proof. All five bootstrap-critical projects participate in the successful 39-project Buck plan; there is no root TypeScript execution path to mask a failed Buck project.

### Deliberate constraints

- The shared exported Nix TypeScript task module remains available to downstream repositories. This repository no longer imports it; deleting a reusable downstream API is not part of transferring this repository's authority.
- Declaration publication remains a deliberate filesystem projection outside the Buck action. Buck is the only producer; the wrapper only validates and atomically swaps Buck output into package `dist` paths consumed by source tools and editors.
- Full local Nix builds were not run because the host root filesystem was at its safety threshold. The proof instead used direct generator execution, unit suites, the synthesized Buck runtime, explicit negative causality, and end-to-end declaration publication.

## Conclusion

The repository has one TypeScript producer. Buck checks all 39 projects and emits all 35 declaration products; strict-consumer and bootstrap-critical projects are first-class targets rather than exceptions. Root compiler execution, residual project membership, source-mode declaration fallback, and duplicate check/emit task edges are absent.

## VRS Impact

Completes the TypeScript execution portion of BUCK-R06, BUCK-R09, BUCK-R12, and BUCK-R16. Static-operation, editor-view/root-install, platform/Rust, and composed-consumer authority remain separate tranches.
