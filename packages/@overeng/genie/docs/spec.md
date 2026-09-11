# Genie Specification

This document specifies the `@overeng/genie` subsystem in `effect-utils`. It builds on [requirements.md](./requirements.md).

## Status

Active

## Scope

This spec defines:

- the public operating modes of the `genie` CLI
- the source and target file conventions for `.genie.ts` generators
- the boundary between build-time CLI code and runtime generator code
- the package export boundary between thin artifact builders and explicit
  composition helpers
- import resolution, including megarepo-aware `#mr/...` imports
- the end-to-end generation and check pipeline
- package-json-owned export environment contracts

This spec does not define:

- the detailed API contract of each individual runtime factory such as `package-json` or `tsconfig-json`
- project-specific composition policy such as package catalogs, private
  defaults, patch sets, or Nix/FOD closure policy
- the packaging and hash-refresh mechanics of the Nix CLI wrappers outside the `genie` package itself
- repository-local task wiring beyond the prerequisite boundary that ensures bootstrap members exist before Genie-backed tasks run

The package-level context and current module-boundary docs remain:

- [../README.md](../README.md)
- [../src/build/README.md](../src/build/README.md)
- [../src/runtime/README.md](../src/runtime/README.md)

Subsystems (own VRS, nested):

- [generators/](./generators/spec.md) — the shared contract for genie **generators**:
  genie artifact domains that project multi-language bindings (TS/Rust/Effect) from one
  typed TS source of truth, drift-gated. Its first child,
  [generators/01-otel-semconv/](./generators/01-otel-semconv/spec.md),
  covers OpenTelemetry semantic-convention registries via OTel Weaver.

## Public Surface

Genie exposes two coupled surfaces:

| Surface                                | Role                                                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `genie` CLI                            | discovers `.genie.ts` files, loads them, validates them, renders outputs, and reports status              |
| runtime libraries under `src/runtime/` | provide pure or mostly-pure factories and helpers imported by `.genie.ts` source files                    |
| package subpath exports                | communicate abstraction level for thin builders, explicit composition helpers, node-only helpers, and SDK |

The package export contract is:

| Export                         | Role                                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------- |
| `@overeng/genie`               | thin runtime API for artifact builders, primitive helpers, and shared types                  |
| `@overeng/genie/composition`   | explicit reusable cross-artifact composition helpers that consume semantic inputs or `meta`  |
| `@overeng/genie/node`          | node-resident helpers that may read the filesystem, spawn tools, or otherwise need Node APIs |
| `@overeng/genie/cli` / `./sdk` | build-time CLI and programmatic SDK surfaces                                                 |

The CLI supports four operating modes:

| Mode     | Trigger     | Behavior                                                  |
| -------- | ----------- | --------------------------------------------------------- |
| generate | default     | writes generated targets to disk                          |
| check    | `--check`   | verifies generated targets are already up to date         |
| dry-run  | `--dry-run` | computes target content and diffs without writing         |
| watch    | `--watch`   | watches `.genie.ts` files and regenerates changed targets |

Generated targets are read-only by default. `--writeable` opts out of that protection.

## Source and Target Model

Every generator source is a `*.genie.ts` file colocated with its generated target. The target path is derived mechanically by removing the `.genie.ts` suffix.

Examples:

| Source                              | Target                     |
| ----------------------------------- | -------------------------- |
| `package.json.genie.ts`             | `package.json`             |
| `tsconfig.json.genie.ts`            | `tsconfig.json`            |
| `.github/workflows/ci.yml.genie.ts` | `.github/workflows/ci.yml` |

Genie treats the `.genie.ts` source as the source of truth. Direct edits to generated files are non-authoritative and are expected to be overwritten by the next generation run.

The generator default export must resolve to a `GenieOutput<TData, TMeta>` shape:

- `data` is the canonical emitted value
- `meta` carries non-emitted composition data
- `stringify(ctx)` renders the final file content

Factories must propagate composition metadata through `meta` instead of reverse-engineering data back out of generated files.

## Build and Runtime Boundary

Genie is split into two execution domains:

| Domain                    | Directory      | Constraint                                                                     |
| ------------------------- | -------------- | ------------------------------------------------------------------------------ |
| build-time CLI            | `src/build/`   | bundled into the native CLI binary; normal build-time dependencies are allowed |
| runtime generator library | `src/runtime/` | dynamically imported by `.genie.ts` modules; npm dependencies are disallowed   |

The runtime layer must stay lightweight and loadable in arbitrary repository contexts because `.genie.ts` files import it directly during evaluation. The build layer may own TUI concerns, CLI option parsing, process orchestration, and other binary-local concerns.

## Composition Boundary

Artifact-specific generators are responsible for modeling and rendering one
artifact or domain. For example, `packageJson(...)` models package manifest
authoring and `tsconfigJson(...)` models TypeScript configuration authoring.
They must not hide cross-generator inference inside their normal rendering
path.

Reusable cross-artifact behavior belongs in explicit helpers, exposed through
named package subpaths. The first shared subpath is
`@overeng/genie/composition`.

Admission to `@overeng/genie/composition` requires that a helper:

- is reusable across repositories;
- consumes explicit semantic inputs or `GenieOutput.meta`;
- remains bootstrap-safe when imported by `.genie.ts` sources;
- avoids encoding a specific repository's package catalog, patch set, private
  defaults, Nix/FOD closure policy, or comparable local policy.

`GenieOutput.meta` is the structured channel for non-emitted composition facts.
It stores stable semantic facts such as workspace identity and dependency
relationships. Projection helpers compute target-location-dependent output
values, such as relative paths, from those facts and render context instead of
requiring producer generators to store rendered projection data.

### TypeScript Reference Composition

`@overeng/genie/composition` provides `tsconfigReferencesFromPackages(...)`.
The helper projects TypeScript `references` entries from package workspace
metadata while keeping `tsconfigJson(...)` a thin `tsconfig.json` builder.

The helper accepts:

- a `from` package carrying workspace metadata for the package whose
  `tsconfig.json` is being authored;
- an optional package list, defaulting to `from.meta.workspace.deps`;
- optional `{ package, tsconfig }` entries when the caller wants the helper to
  apply TypeScript project-reference target eligibility from known tsconfig
  data;
- an optional project-local predicate for policy that is not reusable Genie
  semantics.

The helper must:

- render deterministic, sorted reference paths;
- compute relative paths from semantic workspace identity and package member
  paths;
- route foreign-repo packages through the composed `repos/<repo>/<member>`
  logical path;
- skip targets whose supplied tsconfig data explicitly sets
  `compilerOptions.noEmit: true` or `compilerOptions.composite: false`;
- avoid filesystem reads so it remains valid in the runtime composition layer.

## Import Resolution

Genie must resolve three classes of imports used by `.genie.ts` sources:

- normal Node/TypeScript relative and package imports
- repository-local helper imports
- megarepo member imports using the `#mr/<member>/...` prefix

Megarepo member resolution follows this precedence order:

1. `GENIE_MEMBER_OVERRIDE_MAP`
2. a local member root derived from the importing repository
3. `GENIE_MEMBER_SOURCE_MAP`

Local member root resolution follows this order:

1. discover the enclosing repository root by walking upward from the importer path
2. if `megarepo.lock` exists and contains the member, derive the expected global store worktree path from the locked URL and ref
3. if that derived path exists, use it
4. otherwise fall back to `repos/<member>` if present

This means Genie can resolve `#mr/...` imports against the lock-pinned global megarepo store without requiring the local `repos/` symlink tree, as long as the referenced member worktree already exists in the store.

Genie does not materialize missing megarepo members itself. Repository task wiring is responsible for ensuring required bootstrap members exist before Genie-backed tasks run.

## Bootstrap-Safe Import-Closure Check

Satisfies R06 (runtime independence of the transitive closure) and R30 (bootstrap-closure enforcement). The check walks the transitive _runtime_ import closure of every `.genie.ts` source and reports any source that reaches a package unavailable before install, with the importer chain.

**Walk.** For each `.genie.ts` root, a breadth-first walk follows only bootstrap-safe edges. Edges are extracted per file from TypeScript 7's process-backed project snapshots and decoded AST, covering `import`/`export … from`, `export *`, and dynamic `import('…')` with a string-literal argument. The per-file edge set is memoized globally, since the runtime graph is identical across roots.

**API server.** Every TypeScript 7 session (this check and the export-environment scans) spawns a compiler process whose JSON-RPC protocol is versioned with the npm client, so the server MUST be the `@typescript/typescript-<platform>` executable published with the pinned `typescript` version. Source mode lets the client resolve that binary itself; a `tsgo` on `PATH` is never used, because the dev shell exposes the Effect-TS fork, whose revision reports zero projects (`no project found for file`). `GENIE_TYPESCRIPT_API_SERVER` is the explicit override, and both Nix packages (the Genie CLI, the standalone checker) set it to the pinned platform executable — a compiled bundle cannot resolve the optional package on disk. This is independent of `GENIE_EXPORT_TYPE_PROOF_COMPILER`, which stays the Effect-TS `tsgo`.

**Resolution.** The check reuses genie's own resolvers so a specifier resolves exactly as it does at bootstrap: `#`/`#mr` specifiers go through {@link resolveImportMapSpecifierForImporterSync} (lock-pinned member identity, per _Import Resolution_ above); relative specifiers use the owning configured or inferred TypeScript 7 project. Bare specifiers are never followed — they are closure boundaries, not edges — so the walk never descends into `node_modules`.

**Policy.** An edge is a violation iff its specifier is a bare package name — not relative, not a `#`/`#mr` import-map specifier, and not a node builtin (with or without the `node:` prefix; builtins are always importable pre-install). Consequences:

- First-party source reached via relative / `#` / `#mr` paths is allowed (it resolves to on-disk `.ts`).
- A bare first-party workspace specifier (e.g. `@overeng/ci-tools`) IS a violation, because a bare specifier is not resolvable before install; cross-package generator imports must use a relative path or `#mr`.
- **Type-only edges are excluded** — `import type`, `export type`, `export type *`, and fully per-specifier `{ type X }` — because they are erased at runtime.

**Diagnostic.** Each violation reports the importer chain `source -> barrel -> runtime -> pkg` from the generator source down to the offending import.

**Scope: bootstrap-phase generators only (zero-tolerance).** The gate is scoped to generators declared `bootstrap`-phase (see _Generator Phase and Empirical Cold-Proof_ below); `design-time` generators are out of scope **by declaration**, not by allowlist. It fails on ANY bootstrap-phase violation — there is no baseline and no ratchet. The residual weaver generators (`genie/weaver-registry/*.genie.ts`) reach `effect` because the OTel semantic-convention contracts are Effect-Schema by design (`@overeng/otel-contract/src/registry.ts` imports `Schema` from `effect`); they are `design-time` (unmarked) and therefore structurally excluded rather than baselined. The check runs as a devenv task (`bootstrap-closure:check`) wired into `check:all` (not `check:quick`) — an existing check-flow surface, not a new Genie CLI subcommand. The `checkBootstrapClosure` walker is exported from `@overeng/genie/node`, so downstream megarepo members can enforce the same contract over their own bootstrap-phase `.genie.ts` (whose closures do reach into effect-utils via `#mr/effect-utils/...`).

This gate is **fast local feedback** (R30), not the sole authority: it proves that each _already-marked_ bootstrap generator is closure-clean, but it cannot prove the marked _set_ is complete. The authority is the empirical cold-proof (`bootstrap:cold-proof`, R32, below), which actually runs the marked set cold and then installs.

Relates to DQ1: this is the validate-only flavor of the preflight phase DQ1 anticipates; it detects unavailable closures but does not itself materialize members.

## Generator Phase and Empirical Cold-Proof

Satisfies R31 (generator phase) and R32 (empirical bootstrap verification); realizes decision 0004.

**Phase declaration (static, no import).** Each generator has a phase — `bootstrap` or `design-time` — declared by a `// @genie-bootstrap` flag comment in the `.genie.ts` source: a valueless, namespace-prefixed pragma mirroring TypeScript grammar (`@ts-nocheck`/`@ts-check`). `design-time` is the default (no marker). The phase is read from the raw source text (`parseGeneratorPhase`, `src/core/phase.ts`) with no import and no TypeScript parse: importing a `design-time` generator would itself require the runtime graph (e.g. `effect`), which is exactly what is unavailable before install. A per-file flag (rather than a filename rule like "every `package.json.genie.ts` is bootstrap") is deliberate: R32 forbids a hardcoded catalog of install-input filenames, so the mark is an explicit per-generator declaration, not an inferred convention. In effect-utils the bootstrap set is the 35 `package.json.genie.ts` sources plus `pnpm-workspace.yaml.genie.ts` (36 generators); everything else — including weaver — is `design-time`.

**Phase-selected running.** `genie --phase <bootstrap|design-time>` restricts a `generate`/`check`/`dry-run` to generators of that phase (discovery reads the flag of each discovered source and filters; absent the flag, all phases run). Duplicate-target rejection still runs over the full discovered set before filtering. The normal post-install `genie:run` runs all phases.

**No install-ordering edge.** There is deliberately no `genie:bootstrap`-before-`pnpm:install` task edge. An earlier form wired `pnpm:install.after = [ "genie:bootstrap" ]` so install would regenerate the bootstrap inputs first, on the theory that install would then arbitrate completeness. Implementation showed it arbitrates nothing here: the `genie` on `PATH` is the source-mode CLI (`bun bin/genie.tsx`), whose build layer resolves `effect`/`@effect/platform-node`/`@overeng/*` from `node_modules`, so it cannot run cold (the task cold-guarded to a no-op on a fresh clone); and generated outputs are committed (T01), so install finds a `package.json`/`pnpm-workspace.yaml` on disk regardless of whether its generator ran or is even marked. The edge therefore enforced nothing while adding cost to every warm install (a full `genie --phase bootstrap` generate + strict-tsgo validation) and a new failure mode (a genie flake now failing the most-depended-on task). It was removed; bootstrap-safety is instead **demonstrated empirically**.

**The cold-proof is the authority (R32).** `bootstrap:cold-proof` (`genie/ci-scripts/bootstrap-cold-proof.sh`, devenv task + CI lane) is the load-bearing enforcement:

1. Realize the **self-contained packaged Genie CLI** (`.#genie`) — a `bun --compile` binary with its deps baked into the store, so it runs with no `node_modules`. (Unlike source-mode genie, it can run cold.)
2. `git archive HEAD` a **`node_modules`-free tree** of the committed source into a temp dir _outside_ the repo (so bun/pnpm cannot walk up into the repo's `node_modules`).
3. Run `genie --phase bootstrap` **cold** in that tree. Success proves every bootstrap generator's transitive runtime closure is importable pre-install — a reach into `effect`/`@effect/*`/`@overeng/otel-contract` would throw on import and fail this step. Non-vacuity is asserted by cross-checking the number of generators run (via `--output json`) against the `// @genie-bootstrap`-marked set counted independently from the tree, and by rejecting any per-file `error` status.
4. Run `pnpm install --frozen-lockfile` in that tree. Success proves the cold-regenerated install inputs match the committed lockfile exactly.

This exercises the exact pre-install path and turns bootstrap-safety from _asserted_ into _demonstrated_. The cold generate also runs validation, including the strict tsgo export-type proof on genie's isomorphic `.` entry (`src/runtime/mod.ts`) — which is itself bootstrap-safe (its type closure reaches no `node_modules`-resident types), so the proof compiles standalone in the cold tree.

**Accepted residual (completeness, open).** A _new_ install-input generator that forgets `// @genie-bootstrap` silently escapes both the static gate and the cold-proof (the cold-proof runs the _marked_ set; a forgotten mark plus a committed output means install still succeeds). Closing this structurally would need either uncommitted outputs (infeasible — the nix genie is built _from_ the committed `package.json`; deadlock) or a hardcoded "install-input" completeness catalog (rejected by R32 as unprincipled). The gap is low-risk (new generators inherit bootstrap-safe builders; the all-phase `genie:check` drift gate still catches output staleness) and is left open, closeable later with the hardcoded check only if it ever bites.

The net contract: `bootstrap-closure:check` is fast local feedback on the _safety_ of the marked set (zero-tolerance, static), `bootstrap:cold-proof` is the empirical authority that the marked set actually runs cold and installs, and the all-phase `genie:check` drift gate enforces _output freshness_.

## Discovery and Validation

The core pipeline begins by recursively discovering `*.genie.ts` files beneath the working directory.

Discovery is repository-bounded. Inside a Git worktree, Genie asks Git for the
tracked `.genie.ts` sources plus untracked `.genie.ts` sources that are not
ignored by the repository's normal exclude rules. This keeps local scratch state
such as nested agent worktrees out of the generation input while still including
untracked `.genie.ts` files that are not ignored and may be about to be
committed. Outside a Git worktree, Genie falls back to recursive filesystem
discovery with known non-source directories skipped.

Discovery must enforce these invariants before generation begins:

- each source maps to exactly one target
- no two sources may claim the same target path

After discovery, Genie runs repository-wide validation before reporting success. Validation warnings are emitted to the event stream and surfaced in the UI, but hard validation failures abort the run.

Validation context may carry an opaque `validation` extension registry. Genie
core owns only the registry transport; each domain owns the shape and semantics
of its entry. The `package-json` domain uses `validation.packageJson` for
node-side package manifest checks that need dependency-backed JavaScript tooling.

## Package Export Environment Contracts

The package-json generator supports non-emitted environment contracts on package
exports. Authors attach a contract next to the export target:

```ts
exports: {
  '.': exportEntry('./src/runtime/mod.ts', {
    environment: 'isomorphic-es2024',
    typeProof: 'strict',
  }),
  './node': exportEntry('./src/runtime/node/mod.ts', {
    environment: 'node',
  }),
  './cuid': exportEntry(
    {
      browser: './src/cuid/cuid.browser.ts',
      node: './src/cuid/cuid.node.ts',
      default: './src/cuid/mod.ts',
    },
    [{ environment: 'browser' }, { environment: 'node' }],
  ),
  './testing/*': exportEntry('./src/testing/*.ts', {
    environment: 'node',
    published: false,
  }),
}
```

`exportEntry(target, contract | contracts)` is an authoring helper. A single
export can carry multiple contracts when different package export conditions
select different source files. Pattern targets with `*` expand to matching
source files during validation. Source-only exports that are intentionally
absent from `publishConfig.exports` declare `published: false`. The emitted
`package.json` remains ordinary package.json:

```json
{
  "exports": {
    ".": "./src/runtime/mod.ts",
    "./node": "./src/runtime/node/mod.ts",
    "./cuid": {
      "browser": "./src/cuid/cuid.browser.ts",
      "node": "./src/cuid/cuid.node.ts",
      "default": "./src/cuid/mod.ts"
    },
    "./testing/*": "./src/testing/*.ts"
  }
}
```

The contract is stored only in the generator's structured metadata as
`meta.exportContracts`. That metadata lets package-json validation check the
source export without exposing Genie-specific keys to package managers.

Repositories can opt into migration pressure for missing contracts by defining a
configured package-json generator once in their shared Genie helper:

```ts
export const packageJson = definePackageJson({
  validation: {
    exportEnvironmentContracts: {
      coverage: 'warn',
      ignore: ['./legacy'],
    },
  },
})
```

Call sites then keep using the normal package-json authoring API:

```ts
export default packageJson(
  {
    name: '@myorg/package',
    exports: {
      '.': exportEntry('./src/mod.ts', { environment: 'isomorphic-es2024' }),
      './legacy': './src/legacy.ts',
    },
  },
  compositionOrMeta,
)
```

`coverage: 'warn'` emits Genie validation warnings for uncontracted exports and
keeps `genie --check` non-blocking. `coverage: 'error'` fails validation.
`coverage: 'off'` is the default for compatibility. Ignores match export
subpaths exactly or with the same `*`/`**` glob syntax used by package-json
validation helpers. A call may pass a third options argument to override the
configured defaults for an exceptional package. The policy is owned by
package-json validation rather than Genie core, and the heavier node/type proof
runtime still runs only for exports that actually declare contracts.

Package-json pure validation owns structural checks:

- every contracted export subpath must exist in emitted `exports`
- if `publishConfig.exports` is present, contracted source subpaths must be
  mirrored there unless the contract declares `published: false`

The package-json node validation runtime owns JavaScript environment checks. It
is deliberately isolated below `src/runtime/package-json/node/` so pure runtime
imports do not value-import TypeScript or node-only modules. The validator:

- resolves the export target for the contract's environment conditions
- expands patterned export targets to matching source files before scanning
- scans the transitive relative source import graph for forbidden imports and
  forbidden globals
- runs a TypeScript environment proof only when the contract requests
  `typeProof: 'strict'`
- caches successful strict proofs under
  `.devenv/task-cache/genie-package-json-export-environments/`

Strict TypeScript environment proofs run through an explicit compiler
executable, not through the TypeScript JavaScript program API. The node runtime
can be constructed with `createNodePackageJsonValidationRuntime({ typeProofCompiler })`.
Without an explicit option, source-mode validation resolves
`GENIE_EXPORT_TYPE_PROOF_COMPILER`, then `tsgo` from `PATH`. Nix-packaged Genie
sets `GENIE_EXPORT_TYPE_PROOF_COMPILER` to the flake-pinned `tsgo` binary in its
wrapper. The validator writes a temporary proof
`tsconfig.json`, invokes the compiler with no emit, reports compiler output as
Genie validation issues, and removes the temporary config after the proof run.

Built-in environment profiles are data, not core behavior. The initial profile
set covers `isomorphic-es2024`, `node`, `bun`, `browser`, `webworker`,
`workerd`, and `react-native`. Profiles define export-condition preference,
forbidden imports/globals, and optional TypeScript proof settings.

## Generation Pipeline

The non-watch pipeline is:

1. normalize the working directory to its real path
2. resolve the active `oxfmt` config path from the explicit CLI option or the standard convention paths
3. discover `.genie.ts` files and reject duplicate targets
4. emit a complete discovered-file list to the event bus
5. load and generate all discovered files concurrently
6. collect per-file successes and failures
7. if temporal dead zone failures were seen, re-check files sequentially to isolate root causes
8. emit final summary counts and fail the run if any file failed

Concurrent generation is the default behavior for throughput. Sequential revalidation exists only as an error-analysis path for ambiguous module-initialization failures.

Check mode reuses the same file loading model but verifies the rendered output against the existing target instead of writing.

## Watch Mode

Watch mode is CLI-specific and intentionally simpler than the full batch pipeline:

1. watch the resolved working directory
2. filter for changes to `*.genie.ts` files
3. re-discover sources so newly added files enter the working set
4. regenerate the changed file
5. mark unchanged files explicitly in the UI summary

Watch mode is only valid for writable generation, not for `--check` or `--dry-run`.

## Output Semantics

Genie-generated files must preserve these semantics:

- target content is rendered from the canonical `GenieOutput`
- supported file types are formatted consistently, including `oxfmt` integration where applicable
- generated files may carry source headers when the output format supports them
- read-only mode is the default safety mechanism for generated targets

The CLI reports per-file status using the normalized statuses:

- `created`
- `updated`
- `unchanged`
- `skipped`
- `error`

Batch completion also reports an aggregate summary across those statuses.

## Error Model

Generation failures are file-oriented but reported at both file and run level.

The run-level failure contract is:

- the event stream reports file start, completion, validation warnings, and terminal completion or error states
- any run with one or more file failures exits with `GenieGenerationFailedError`
- catalog conflicts and TDZ-style import failures are promoted into clearer root-cause reporting instead of surfacing only the first incidental stack trace

This keeps CI-facing `genie --check` behavior strict while still making interactive failures diagnosable.

## Integration Boundary with Devenv and Megarepo

Genie assumes that any source-imported bootstrap members are already available before execution begins.

The shared task boundary is:

- repositories that need bootstrap members wire `mr:bootstrap` into `genie:prepare`
- all Genie-backed tasks depend on `genie:prepare`

This keeps the bootstrap requirement centralized at one task boundary rather than duplicating the same megarepo prerequisite across every Genie task name.

`genie:prepare` (the shared prerequisite hook) is a read-only prerequisite that `genie:run`/`genie:check`/`genie:watch` depend on; it ensures bootstrap members exist before Genie-backed tasks run. It is unrelated to the generator _phase_ concept: there is no pre-install generation task in the devenv graph (see _Generator Phase and Empirical Cold-Proof_ — bootstrap-safety is proven by `bootstrap:cold-proof`, not by an install-ordering edge).

## Design Questions

- **DQ1 Self-hydrating `#mr` imports:** Genie currently resolves existing lock-pinned member worktrees but does not materialize missing ones. A future design may move bootstrap from external task wiring into the import resolver or a dedicated preflight phase if that can be done without hiding expensive or surprising side effects.
