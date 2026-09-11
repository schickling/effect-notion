# Notion Top TypeScript Authority Transfer

Status: accepted
Date: 2026-09-03

## Question

Can `@overeng/notion-md`, `@overeng/notion-react`,
`@overeng/notion-datasource-sync`, and `@overeng/notion-cli` transfer
TypeScript typecheck and declaration-emit authority to Buck as the top layer of
the notion projection chain, and can the stacked follow-up complete full
exclusivity by deleting the 16 stale dependent project-reference edges the
base transfer deferred?

## Method

Each top package-local `BUCK.genie.ts` admission gained authority metadata
(`projectFile: 'tsconfig.json'`, `declarationEntrypoint: 'src/mod.d.ts'`) and
switched every notion workspace sibling from content-tracked `sourceRoots` to
same-cell Buck `dist` targets (15 swaps: md 4, react 2, datasource-sync 5,
cli 4 — including the intra-top md/datasource-sync siblings, which become
authoritative in this same commit, mirroring how the base commit switched
effect-client's siblings to the just-authorized base packages). Root
check/emit solutions, the member-manifest dist overlays, and the per-package
`dist` entrypoint assertions regenerated from the same admissions via
`devenv tasks run genie:run`.

Entrypoint verification (no guessing): the transfer brief assumed single `.`
exports, but all four tops are multi-export packages (md: `.`, `./cli`,
`./cli-program`; react: `.`, `./markdown`, `./renderer`, `./o11y`,
`./o11y/effect`, `./o11y/otel`, `./web` + css; datasource-sync: 20 subpaths;
cli: `.`, `./config`). The entrypoint follows the `.` export only — every top
package's `.` resolves to `./src/mod.ts` (read from each
`package.json.genie.ts` `exports` block), each `src/mod.ts` exists on disk,
each package tsconfig spreads the shared `packageTsconfigCompilerOptions`
(`composite`, `rootDir: '.'`, `outDir: './dist'`, no per-package override), so
the Buck emit produces `dist/src/mod.d.ts`. This mirrors the already-
authoritative multi-export `@overeng/utils`, which asserts only its `.`
declaration (`src/isomorphic/mod.d.ts`) among 12+ exports, and matches the
base single-export packages exactly.

Per-edge companion changes mirror what #1193 did per dependent edge:
deletion-only. All 16 deleted targets are declared workspace (dev)deps of
their importers, so `tsc` keeps resolving them through `node_modules` without
any `package.json` edit. `noEmit: true` was added to all 8 notion tsconfigs —
the 4 tops per the authority precedent (utils/content-address/otel-contract
all went write-free in their authority commit) and the 4 base packages per
the base note's explicit deferral ("the `package.json` dist-types rewrites
and `noEmit` flip ... follow the middle-layer precedent in the same
follow-up"). No `package.json` sources were touched.

## Result

- **Regen PASS:** `genie:run` touched exactly the expected files — 4 top
  `BUCK.genie.ts` sources, 4 regenerated `BUCK` projections
  (`declaration_entrypoint` + 15 sibling source-to-`dist` swaps),
  `buck2-member.json` (+4 dist overlays, 8 notion overlays total),
  8 `tsconfig.json.genie.ts` sources + 8 regenerated `tsconfig.json`
  (16 edges deleted, 8 `noEmit` flips), `tsconfig.check.json` and
  `tsconfig.emit.json` (27→23 refs each). No unrelated drift, no editor-view
  changes.
- **Freshness PASS:** `devenv tasks run genie:check --no-tui` exits 0.
- **Unit PASS:** `devenv tasks run genie:buck2:test --no-tui` — 25 pass, 0 fail
  across 5 files; both authority unit tests derive expectations dynamically, so
  no test-expectation updates were required.
- **Structural PASS:** all 8 generated tsconfigs parse with `noEmit: true`,
  intact `composite`/`rootDir`/`outDir` layout, and every surviving reference
  target present on disk.
- **Typecheck gate DEFERRED to CI:** no `tsc` is installed in this worktree
  (`node_modules` absent, no `tsc` on PATH) and full `ts:check` is repo-heavy
  with no package-scoped task available — same deferral as the base transfer.
  CI `buck2:check` proves the four new `typecheck` targets and `check:quick`
  proves declaration publication before the surviving 23-ref root check.

### Deletion ledger — notion top layer (16 deleted)

Top→base edges (12), all targets Buck-authoritative since the base commit:

- `notion-md`: `../notion-core`, `../notion-effect-client`,
  `../notion-effect-schema`, `../notion-property-write` (4; refs now `[]`)
- `notion-react`: `../notion-effect-client`, `../notion-effect-schema`
  (2; keeps `../notion-md`)
- `notion-datasource-sync`: `../notion-core`, `../notion-effect-client`,
  `../notion-effect-schema`, `../notion-property-write`
  (4; keeps `../notion-md`)
- `notion-cli`: `../notion-effect-client`, `../notion-effect-schema`
  (2; keeps `../effect-path`, `../notion-datasource-sync`, `../notion-md`)

Intra-base edges (4), completing the base layer's exclusivity:

- `notion-effect-schema`: `../notion-core` (1; refs now `[]`)
- `notion-property-write`: `../notion-effect-schema` (1; refs now `[]`)
- `notion-effect-client`: `../notion-core`, `../notion-effect-schema`
  (2; refs now `[]`)
- `notion-core`: already `[]`; `noEmit` flip only.

### Left in place (5, not stale under the 16-edge scope)

- 4 intra-top edges (`notion-react → ../notion-md`,
  `notion-datasource-sync → ../notion-md`,
  `notion-cli → ../notion-md`, `../notion-datasource-sync`): their targets
  become authoritative in this same commit, so they are newly stale rather
  than base-deferred; kept to hold this commit to the 16-edge scope. Each
  target is a declared dep, so a follow-up can delete them deletion-only.
- 1 non-notion edge (`notion-cli → ../effect-path`): target is not
  Buck-authoritative (`effect-path/BUCK.genie.ts` has no `authority` block),
  so the edge is still load-bearing for build ordering.

### Remaining dual-resolution debt (reported, not done)

No `package.json` `exports` gained dist-backed `types` conditions (brief:
prefer not to). `tsc` therefore still resolves the 8 notion packages from
source while Buck compiles from `dist` — dual resolution, but sole
production: with `noEmit` on all 8, `tsc` emits nothing and Buck is the only
`dist` producer. The `types`-condition rewrite for all 8 packages (plus the 4
intra-top edge deletions above) is a clean deletion-only follow-up.

### Speed/complexity deltas

- Root solutions: 27→23 refs each (−8 refs total across check+emit).
- Project-reference edges: −16 deleted (12 top→base, 4 intra-base).
- Buck sibling edges: 15 source-tree consumptions replaced by `dist` targets.
- Dual producers eliminated: 8 (`noEmit` on all 8 notion packages; Buck sole
  `dist` producer).
- Build-speed timing: not measured locally (no local Buck build run; CI
  `buck2:check` owns the timing evidence).

## Conclusion

The notion projection chain now satisfies Buck-first TypeScript authority end
to end: root solutions list no notion package, all 8 `dist` overlays are
published, all 8 package trees consume each other through Buck declarations,
all 16 base-deferred edges are deleted, and no `tsc` invocation emits notion
`dist` output. Full source-vs-dist type-identity (dist `types` conditions +
4 intra-top edge deletions) remains as scoped follow-up debt.

## VRS Impact

Discharges the top half of the notion projection-chain authority transfer
(top #1205, stacked on base #1204). BUCK-R06, BUCK-R07, BUCK-R09, BUCK-R12,
and BUCK-R16 are re-evidenced for the admission. No requirement change is
needed; the 4 intra-top edges plus 8-package dist-`types` rewrite are tracked
as follow-up scope.
