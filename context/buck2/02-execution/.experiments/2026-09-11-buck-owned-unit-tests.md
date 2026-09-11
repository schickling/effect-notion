# Buck-Owned Unit Tests

Status: accepted
Date: 2026-09-11

## Question

Can the repository transfer its bounded unit-test lanes from source-side Vitest tasks to Buck without losing tests, while keeping integration, live, browser, and other unbounded tests under explicit source-task ownership?

## Method

The package admission registry now declares each bounded lane beside its package-tree projection. Generation derives a versioned `buck2-test-authority.json` bridge from that registry. Every row records:

- the complete collectable test-file census for the package;
- the lane's exact selection and exclusions;
- the Buck execution and collection targets;
- exceptional source owners for integration or browser tasks;
- the remaining exact source-side complement and its required task ordering.

Generation rejects duplicate or nested lane packages until overlapping membership has an unambiguous first-class representation. Both the Nix importer and the baseline-collection decoder independently reject malformed, unsorted, incomplete, overlapping, or ownerless partitions.

Buck stages bounded tests in package trees with project references removed, runs pinned Bun and Vitest tools in scratch-only writable directories, rejects ambient inherited environment for collection, disables Vitest's own cache, and executes 32 lanes through one `buck2 test` aggregate. Source Vitest receives only exact positional complements. Existing dedicated Notion integration, megarepo cold-GC, Utils Playwright, and TUI React Playwright tasks own the exceptional files.

Test execution has one explicit temporary exception to the TypeScript-authority ordering rule: Genie, kdl-effect, megarepo, and tui-stories enter the bounded test partition before their declaration/typecheck projects transfer. Their test actions do not consume those projects' root `tsc` outputs; they execute staged source against the Buck-owned editor dependency view. All four execution and collection targets pass in the complete 32-lane proof, and their source-side whole-suite producers are removed by the same generated task cutover. The TypeScript tranche still owes declaration/typecheck authority for these projects, but no unit-test producer remains duplicated.

The baseline gate now compares three independent observations:

1. the repository filesystem census against every authority row;
2. every Vitest collection artifact against `selectedTestFiles - excludes`;
3. every baseline or cross-major suite against its Buck collection artifact or exact source-task JSON report.

Any missing file, additional collection, malformed artifact, unbuildable collection target, missing source report, or zero-test baseline fails closed.

## Result

- **Projection freshness PASS:** direct Genie generation updated the authority bridge, package BUCK files, CI workflow/settings, and workspace lint projections; `genie --check` reported 142/142 unchanged after regeneration.
- **Registry partition PASS:** schema version 2 carries 32 unique package lanes and a complete 420-file admitted-package census. Buck owns 282 bounded files; 115 files belong to exact generic source complements; 23 files belong to dedicated source tasks. A further 13 files live outside the admitted lanes, for 433 repository test files total.
- **Collection cold PASS:** a fresh local-only synthetic composition built all 32 collection targets in one invocation: 1,171 local actions, zero remote actions, 119 MiB downloaded tool inputs, and approximately 50 seconds wall time.
- **Collection exactness PASS:** all 32 artifacts exactly matched their authority selections. They recorded 4,292 tests across the 282 bounded files; no expected file was missing and no unowned file was collected.
- **Bounded execution PASS:** the same synthetic composition ran all 32 targets with `buck2 test --local-only`: 32 pass, 0 fail, 0 timeout, 0 fatal, 0 skipped, 0 omitted, 0 infrastructure failures, and 0 build failures.
- **Repeat execution PASS:** a second local-only run again passed all 32 targets with zero network traffic.
- **Decoder/unit PASS:** the baseline authority suite passed 51/51 tests, including schema version, normalization, sorting, uniqueness, duplicate/nested-lane rejection, explicit-source ownership, exact complement, and collection-artifact failure paths. Package-tree tests passed 16/16 under Bun, matching the production runner. The side-effecting gate also passes the `@overeng/utils-dev` Buck typecheck and executes with only declared Node APIs under its pinned Bun runtime.
- **Task graph PASS:** parse-only Nix validation succeeded. The evaluated task graph passed 96/96 structural assertions: acyclic, one Buck aggregate under `test:run`, source complement batches present, all 32 lane tasks ordered after workspace reconciliation, and every generic or exceptional source owner present.
- **Generated workflow budget PASS:** the workflow remains below GitHub's observed 500,000-byte admission limit at 468,495 bytes. Dedicated Utils and TUI React Playwright jobs and all five Notion integration package tasks are present in the generated graph.
- **Dedicated browser owners PASS:** Utils Playwright passed 3/3 tests and TUI React Playwright passed 19/19 tests. The reactivated TUI suite now exercises all seven current output tabs, timeline controls, terminal accessibility output, live atom updates, and resize-driven truncation without evaluating Node-only stdout modules in the browser.

### Ownership ledger

Buck-owned bounded partition:

- 32 package lanes;
- 282 files;
- 4,292 collected tests.

Source-owned admitted-package partition:

- 115 files in 15 exact `test:<package>:unbounded` complements;
- 23 files assigned to `test:megarepo-cold-gc`, four package-specific Notion integration tasks, `test:pw:utils`, or `test:pw:tui-react`.

Source-only package partition:

- 13 files outside the admitted lanes, in `@overeng/buck2-tools` and `@overeng/effect-schema-form-aria`.

The three counts are disjoint and total the 433-file repository census.

### Deliberate constraints

- Duplicate and nested lane packages are rejected in generation and the runtime decoder. Adding an overlapping lane is a hard failure, not ambiguous ownership.
- Dedicated integration and browser owners are outside the default `test:run` partition, matching their existing credential/runtime boundaries. If one of their files gains a baseline suite, the baseline gate requires that dedicated task's exact JSON report.
- Vitest collection is required to be cacheable and free of inherited environment. Its action identity contains every declared input; contradictory declarations fail generation before Buck analysis.
- Full Nix builds were not run locally because the host root filesystem was already at its safety threshold. Parse-only Nix validation, evaluated task-graph validation, synthetic Buck execution, and GitHub CI provide the non-destructive proof split.

## Conclusion

The transfer is lossless and fail-closed for the bounded unit-test surface. Buck is the sole executor for 32 declared lanes, source Vitest receives exact complements rather than whole admitted packages, and the generated authority bridge gives CI and the baseline gate one auditable partition. A test cannot move between those sides through an incidental Vitest-config edit: filesystem, registry, collection, and report evidence must all agree.

## VRS Impact

Advances BUCK-R06, BUCK-R09, BUCK-R12, and BUCK-R16 from analysis/build authority into test execution. It also establishes the ownership schema used by the remaining execution tranches: bounded work is declared in the admission registry, exceptional work names an existing source owner, and ambiguous partitions fail generation rather than relying on convention.
