# Foundation-Layer TypeScript Authority Transfer

Date: 2026-09-02 — Linux x86_64 — Buck2 pin 2026-08-22.

## Question

Can `@overeng/utils-dev` and `@overeng/stylex-preset` transfer TypeScript typecheck and declaration emit to Buck in one dependency-layer PR while each package retains exclusive authority, package-specific invalidation evidence, and its own deletion-ledger entry?

## Method

Both package-local `BUCK.genie.ts` declarations gained authority metadata. Package export type conditions now resolve to Buck-emitted declarations while runtime defaults remain at source, and both ordinary tsconfigs are write-free. Explicit package-local `.d.ts` sources are action-keyed and copied into the emitted dist so stylex-preset's handwritten Vite declaration crosses the same authority boundary. The generated member manifest publishes both dist overlays. The root TypeScript solutions and all dependent project configs were regenerated after deleting legacy project-reference edges. tui-react's Buck package tree now consumes utils-dev through `//packages/@overeng/utils-dev:dist` instead of a source-sibling copy.

The four package targets (`typecheck` and `dist` for both packages) were built together and repeated without changes. A deliberate `number`-to-`string` error was injected separately into `utils-dev/src/cli-contract.ts` and `stylex-preset/src/tokens.stylex.ts`, then each source was restored. A changelog-only mutation exercised irrelevant invalidation. For a fresh warm-cache context, the daemon was stopped and the composition root's generated Buck state was removed before rebuilding. A final run used an otherwise empty environment with a fresh writable HOME and a minimal system/devenv PATH. The `check:quick` task graph materialized declarations before the surviving root TypeScript check.

## Result

- **Target suite PASS:** the initial four-target build succeeded. `utils-dev` emitted `src/node-vitest/mod.d.ts`, `src/node-vitest/setup-fast-check.d.ts`, `src/otelite/mod.d.ts`, and `src/cli-contract.d.ts`; stylex-preset emitted `src/tokens.stylex.d.ts` and copied `src/vite-types.d.ts` into the action output.
- **Warm no-op PASS:** the unchanged repeat completed in 0.3 s with zero network traffic and no executed actions.
- **Fresh warm-cache context PASS:** after daemon shutdown and generated-state removal, 149/149 commands were cache hits, zero commands executed locally, and the Buck build completed in 3.8 s.
- **Hostile environment PASS:** with an empty environment, fresh writable HOME, and minimal PATH, 149/149 commands were cache hits, zero commands executed locally, and the build completed in 2.3 s.
- **Relevant mutation — utils-dev PASS:** Buck reported TS2322 in `src/cli-contract.ts`; restoring the source returned the target to green.
- **Relevant mutation — stylex-preset PASS:** Buck reported TS2322 in `src/tokens.stylex.ts`; restoring the source returned the target to green.
- **Irrelevant mutation PASS:** a `CHANGELOG.md`-only change completed in 1.03 s with no commands or network traffic.
- **Buck target gate PASS:** after declaration-copy integration,
  `CI=1 devenv tasks run buck2:check --no-tui` completed successfully in 5m51s
  with all authoritative typecheck targets.
- **Integrated bridge PASS:** the final
  `CI=1 devenv tasks run check:quick --no-tui` completed successfully in 3m12s;
  its dependency graph materialized all authoritative declarations before the
  surviving root TypeScript check.
- **Generated and Nix authority PASS:** `devenv tasks run genie:check --no-tui` passed after Evergreen refreshed the seven affected root-workspace pnpm FOD hashes.

### Deletion ledger — `@overeng/utils-dev`

- Removed utils-dev from both generated root TypeScript solutions.
- Deleted 25 dependent project-reference edges.
- Replaced tui-react's content-tracked utils-dev source sibling with its Buck `dist` edge.
- Pointed all four public TypeScript export conditions at `dist/src/**/*.d.ts` and made the ordinary tsconfig write-free.
- No package-local standalone check/build task existed to delete. `src/check-baseline-test-collection.ts` remains because it validates task collection rather than compiling utils-dev.

### Deletion ledger — `@overeng/stylex-preset`

- Deleted the two dependent project-reference edges in utils and effect-schema-form-aria.
- Pointed both TypeScript-backed exports at their `dist/src/*.d.ts` files, copied the handwritten Vite declaration as an explicit action input, preserved JS/CSS runtime exports, and made the ordinary tsconfig write-free.
- stylex-preset was not a root solution project before admission, so no root-solution entry or standalone package check/build task existed to delete. Buck is now its repository check and declaration producer.

## Conclusion

The foundation dependency layer satisfies exclusive TypeScript authority and the admission budgets for both packages. Each package has an independent failure control and deletion ledger even though the packages land together. The next dependency layer can consume utils-dev only through its Buck declarations.

## VRS Impact

Discharges the next two Phase-3 package admissions under the dependency-layer PR strategy. BUCK-R06, BUCK-R07, BUCK-R09, BUCK-R12, and BUCK-R16 are re-evidenced for both transfers. No requirement change is needed.
