# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- **@overeng/utils**: `@overeng/utils/node/storybook/gate` — a reusable
  story-driven visual and accessibility gate. Every story becomes a browser
  test that renders, plays, checks accessibility and compares a screenshot
  against a baseline derived from a git ref rather than committed. Three
  settings are non-default because each ecosystem default fails silently:
  comparator `threshold: 0` with `includeAA: true` (pixelmatch defaults to a
  perceptual `0.1` and to ignoring anti-aliased pixels, so a one-pixel radius
  change passes), `parameters.a11y.test: 'error'` (the default `'todo'` only
  warns, and the parameter is inert unless `@storybook/addon-a11y` is
  registered — hence the new `a11y` flag on `createDomStorybookConfig`), and
  ref-derived baselines, because host fonts move one to three thousand pixels
  per story and make a committed baseline valid only on the machine that wrote
  it. The gate reports added, removed and changed stories, and reports failures
  that already existed at the baseline ref separately so it answers "did this
  change make it worse" on packages that carry debt. Measured on
  `effect-schema-form-aria`: 39 stories, clean tree reports zero; a one-pixel
  border radius is caught on exactly the two affected stories at 85 and 81
  differing pixels, with no false positives on the other 37. Runnable as
  `@overeng/utils/node/storybook/gate/cli` — a check every target has to write
  its own driver for is not the working visual check R08 asks for.

- **@overeng/utils**: the story gate can no longer report success over an
  unusable baseline. It subtracts failures present at both refs so it answers
  "did this change make it worse" on packages carrying drift — but with no
  floor, a run where every story failed at the baseline produced an empty
  regression list *by construction* and reported no regressions over a total
  loss of styling. Measured at 212/212 failed on one app and 708/942 on another.
  Now: missing-reference is detected before the pre-existing skip that swallowed
  it; stories whose baseline image does not exist are `uncovered`, derived from
  the filesystem rather than from message text, and force a failure; zero passes
  at the baseline is a hard failure; and the summary line leads with the
  baseline pass count, because the defect turned on a summary that said "no
  regressions" over a report that said otherwise. No fraction threshold: a
  quarter passing is degraded but still informative, and a badly-set fraction
  would reject that along with the broken case.
- **@overeng/utils**: the gate freezes motion before first paint. The screenshot
  matcher waits for two consecutive identical frames, which a transition firing
  once on mount straddles — measured, and it is transitions rather than
  animations: every `Button` variant failed while `Avatar` and `Badge` passed,
  and Button at rest carries only `transition-colors duration-150`. Confirmed
  sufficient by an A/B with the accessibility addon disabled, which changed
  nothing. Stories on surfaces no freeze can settle — a live WebGL canvas never
  produces two identical frames — declare `parameters.storyGate.unstable` and
  are reported as `excluded` rather than failing at baseline and silently
  poisoning the subtraction.
  Known limitation: on a package with no animations and only 150ms transitions,
  the freeze makes roughly two runs in five report one to three spurious pixel
  diffs where the same package was stable at zero before it. Measured across
  twelve runs and independently controlled at the pre-freeze commit. The failure
  is a false ALARM rather than a false pass — it never lets a regression
  through — but the gate is not yet trustworthy enough to gate a merge on
  unattended, and the cause is unresolved.
- **@overeng/utils**: `createStylexVitePlugins` now declares a structural return
  type rather than vite's nominal `Plugin`. Naming vite's own type published
  effect-utils' bundler major as part of the contract: a consumer on a different
  Vite major could not accept the value at all, failing on internals as
  incidental as `PluginContextMeta.rolldownVersion`. Since every plugin member
  except `name` is optional in both majors, one required `name` stays assignable
  to `PluginOption` everywhere while imposing nothing.
- **@overeng/oxc-config**: StyleX enforcement, as two deliberately complementary
  layers. New first-party rules `overeng/stylex-no-raw-color` (bans raw colour
  literals as values inside `stylex.create`, including colours embedded in
  composite values such as `boxShadow` and gradients, while leaving the token
  layer — `defineConsts`/`defineVars`/`createTheme` — alone) and
  `overeng/stylex-outline-focus-visible-only` (reserves `outline`,
  `outlineOffset` and `outlineColor` for the focus-visible state, so a selection
  or pressed state cannot silently outrank the focus ring). The upstream
  `@stylexjs/eslint-plugin` rules are adopted alongside them under their
  documented `@stylexjs/*` names via a new namespace-shim plugin entry;
  `stylexOxlintRules` in `genie/oxlint-base.ts` is the shared policy, and it
  enumerates colour properties explicitly because a `*olor*` glob also matches
  five keyword-valued properties. Upstream value limits are per-property and
  cannot see inside a composite value, which is why both layers ship.
  The pilot package `effect-schema-form-aria` — the reference implementation the
  pattern was derived from — fails the enforcement the pattern produced, in 17
  places. Each site carries a per-line `oxlint-disable-next-line` with a reason
  rather than a file-scoped override, so new code there is still gated
  (issue #1171).

- **@overeng/utils**: `createStylexVitePlugins` takes `useCSSLayers`, and
  `@overeng/effect-schema-form-aria` turns it on. Unlayered output was never a
  preference — it is what lets converted code beat a utility framework's
  layered utilities without any ordering work — so the option defaults OFF and
  the flip is per target, on the target that has left the framework. Nothing
  outside this repo changes.
  The audit that gates the flip, stated in full because the answer was not the
  expected one. Utility framework: none — no `package.json` in the repo names
  one. StyleX consumers: exactly one, `@overeng/effect-schema-form-aria`, plus
  the token package itself. Global stylesheets: five CSS files, of which three
  (`notion-react`'s katex, vendored-notion and styles) belong to a package that
  does not use StyleX and never shares a document with one here, one
  (`effect-schema-form-aria/src/styles.css`) only re-exports the fifth, and the
  fifth is `@overeng/stylex-tokens/preflight.css`.
  **That last one is why "Tailwind-free" was not sufficient.** The reset was
  unlayered and sets `box-sizing`, `margin`, `padding` and `border` on `*`.
  Layered CSS loses to *any* unlayered CSS, so flipping layers on without
  touching it would have handed those four properties to the reset on every
  component in the package — silently, and in the direction the migration is
  supposed to prevent. The reset now declares itself in `overeng.reset` and the
  compiler is configured with `before: ['overeng.reset']`, so the emitted
  `@layer overeng.reset, priority1, ...;` statement fixes the order by
  declaration rather than by which stylesheet the browser parses first — the
  same "do not depend on injection order" rule the token layer already follows.
- **genie**: the CI workflow generator proves that every helper script a
  generated step invokes is a script it actually emits. `prepareCiScriptsStep`
  copies the *consuming* repository's `genie/ci-scripts/` into the job-local
  `composition-state/ci-runtime/`, and only `ciWorkflowSupportFiles` puts files
  there, so a step naming a script that merely happens to be hand-committed in
  this repo resolves here and exits 127 in every consumer. That is how
  `.../ci-runtime/resolve-devenv-ci.sh` failed 14 of 15 jobs on
  schickling/schickling.dev#178 (run 33752627726) while this repo's own CI
  stayed green: the assertion that existed checked the step *mentioned* the
  script, never that a consumer could resolve it. Three scans now close the
  class — generator-source references through any `*ScriptsDir`,
  `composition-state/ci-runtime/...` references in the generated workflows, and
  `$script_dir/...` siblings sourced by an emitted script — and each failure
  names the unavailable script together with the file that asks for it.

### Fixed

- **@overeng/tui-react**: stop truncating `runResult` values and JSON error
  payloads when a CLI exits non-zero. These exit-path writes now go straight to
  fd 1 through a synchronous writer that handles short writes, `EAGAIN`, and
  `EPIPE`. This avoids the asynchronous stdout queue that `process.exit` can
  discard while preserving the existing `Console`-based state-output contract.
- **@overeng/tui-react**: JSON-mode logs no longer land on stdout followed by a
  stray `undefined` line on stderr. `Logger.consolePretty()` prints by itself and
  returns `void`, so wrapping it in `Logger.withConsoleError` logged the pretty
  line to stdout and then passed `undefined` to `console.error`. The stderr
  routing now uses the `Logger.LogToStderr` reference, which is what
  `consolePretty` actually reads — the documented `{ stderr: true }` option is
  inert in `effect@4.0.0-rc.111`.
- **@overeng/megarepo**: `--worktree-mode auto` once again selects the mode from
  workspace context: deterministic commit worktrees in standard CI jobs, and
  tracking worktrees locally or for composition. Composition apply accepts a
  redundant `--all` while continuing to reject member filters and explicit
  commit mode. Shared CI callers no longer need to repeat this CLI policy. The
  generated devenv resolver is also consolidated into one runtime script
  without changing its repair or diagnostics behavior.
- **@overeng/effect-schema-form-aria**: the pilot package's three independent
  drift findings are resolved together, because all three were waiting on the
  same prerequisite — a working visual gate for this package. The seventeen
  per-line `oxlint-disable` suppressions are gone and all eight StyleX rules
  gate the package again.
  **Raw colours become semantic tokens**: `on-primary` for foregrounds drawn on
  `primary`, and `shadow-raised` for popover elevation, defaulting to the
  `shadows.lg` scale step. **`primary` moves `blue500` -> `blue600`**, which is
  the accessibility fix rather than a palette preference: the gate failed ten of
  thirty-nine stories because white text on the selected segment measured
  3.76:1 against AA's 4.5:1, and `blue600` measures 5.25:1. Renaming the literal
  alone would have preserved the violation behind a better name.
  **Thirteen deprecated top-level pseudo-class sites move into condition
  objects.** Every site was reviewed for a competing state rather than
  translated mechanically, because nesting a pseudo-class changes which
  condition wins. Eleven set a property nothing else touches; the two that
  compete — the segmented control's and the list option's background under hover
  versus selection — now resolve by `stylex.props` argument order, with the
  selected style restating the hover value because a later unconditional
  `backgroundColor` does not replace an earlier one under a `:hover` key.
  **Focus moves to the accessible-component library's focus-visible state**
  (native `:focus-visible` on the one plain `<input>`), so a pointer click no
  longer paints a keyboard focus ring. The ring is still drawn with `boxShadow`
  rather than converted to `outline`: the partitioning invariant already holds
  and no story renders a focused element, so repainting it would be a change the
  gate structurally cannot adjudicate.
  **State resolution stops re-deriving what the component knows.** The checkbox
  read its own `value` prop; selection lives on the CheckboxButton, an ancestor
  of the styled box, so it now comes from React Aria's render prop. The
  segmented control and list options applied one of two mutually exclusive style
  objects, hover rule included, and now apply one additive override.
  **The eleventh gate failure was structural, not colour**: React Aria's
  `Header` renders `<header>`, which outside sectioning content is a `banner`
  landmark, so nested field groups produced two banners. The label is a plain
  element now and the group carries the accessible name it lacked.
  Adjudicated against the gate: 20 stories changed, 18 of them the intended
  `43,127,255 -> 21,93,252` recolour confined to selected segments, checkbox
  boxes and the accent tick. The other two are the gate's own sub-pixel fringe,
  proven by recapturing the *unchanged* baseline tree and reproducing both
  diffs identically (689 and 693 pixels, max channel delta 2). Zero
  accessibility failures remain, and the condition-nesting, ordered-argument and
  landmark changes moved no pixels at all. Closes #1171.

- **nix/oxlint-with-plugins.nix**: three fixes to the oxlint wrapper.
  `jsPlugins` entries other than ours are no longer discarded, so third-party JS
  plugins can load beside `@overeng/oxc-config` (previously any such plugin
  failed to resolve, and consumers grew local workarounds). `oxlint --config X`
  with the config flag FIRST no longer exits 1 with no output at all — the
  argument-rewrite loop used `((i++))`, which returns status 1 when `i` is 0 and
  aborted the wrapper under `set -o errexit`, indistinguishable from a lint
  failure in CI. And `OVERENG_OXC_CONFIG_PLUGIN` now overrides the injected
  plugin path, so rule development can lint against live plugin source instead of
  the Nix build-time snapshot (a newly added rule previously reported "not found
  in plugin 'overeng'"). Covered by
  `nix/devenv-modules/tasks/shared/tests/oxlint-plugin-injection.test.sh`.

### Changed

- **Buck2 TypeScript admissions**: transfer typecheck and declaration authority
  for the remaining independent library packages (effect-path, kdl, oxc-config,
  npm-release, effect-ai-claude-cli, agent-session-ingest, effect-react,
  effect-rpc-tanstack, pty-effect, restate-effect, ci-tools,
  effect-schema-form, react-inspector). Each package leaves both root
  TypeScript solutions; public type conditions consume Buck declarations while
  runtime defaults remain at source.

- **CI**: the paired `devenv-perf` wall-clock lane no longer runs on every pull
  request. It now runs on a nightly `schedule` against `main`, on operator
  `workflow_dispatch`, and on a pull request carrying the new `ci:perf` label.
  Measured on three consecutive `ci.yml` runs the lane took 35.0 / 35.7 / 35.0
  minutes against a 37.4-minute whole-run wall clock while `compare: false`,
  `regressionMode: 'warn'` and `prComment.enabled: false` meant it neither
  blocked a regression nor reported one — so it was pure critical path. The lane
  is unchanged otherwise: same runner, same probes, same observation ids, so the
  trend series is continuous. Consequently it is no longer a required status
  check (a lane that does not run on every pull request reports no check run, so
  branch protection would wait forever), `ci/measurements-report` now runs on the
  nightly cadence as well and tolerates a skipped perf lane, and the report's
  perf baseline scan reads `schedule` runs via the new `candidateEvents` option
  on `downloadPreviousGitHubArtifactStep` instead of `push` runs. Per-admission
  benchmark evidence moves to a targeted probe recorded with the admission; see
  `context/ci-measurements.md` "Lane Cadence".
- **buck2 hub**: a Go toolchain and a content-addressed Go module supply. The
  hub declares a `go` `ToolchainAuthority` and `toolchains//:go_bootstrap`, and
  third-party Go code arrives as one `sha256`-pinned `http_archive` per module
  version over the immutable module-proxy zip — no `vendorHash` fixed-output
  derivation, no `go mod download` in an action, `GOPROXY=off` as the
  fail-closed term. Measured on a real ~16 MB service: cold build 9.8 s,
  `Commands: 32`, 100 % cross-root cache reuse with a byte-identical artifact,
  and a binary within 0.05 % of the `buildGoModule` output it replaces.
  The Go distribution is the **official release archive** (`nix/go.nix`:
  `fetchurl` per platform against the `sha256` go.dev publishes, statically
  linked, no patchelf, no strip), not `pkgs.go`. nixpkgs patches Go's own stdlib
  sources with absolute store paths, so every product it compiles inherits them
  and the artifact scan rejects it at import. Measured on one program, identical
  sources and flags, Go 1.26.5 both ways:

      pkgs.go            2 store refs (mailcap/etc/mime.types, tzdata/share/zoneinfo/)   3,026,743 B
      official archive   0 store refs                                                    3,026,751 B

  Removing nixpkgs' store paths removes the guarantee they provided, so
  `go_vendored_binary` now takes a required, defaultless `host_data`: `"embedded"`
  appends the `timetzdata` build tag (zone database linked in, +411 KB) and
  asserts the product owns its MIME table; `"unused"` asserts it does neither.
  Measured reason: with the unpatched stdlib, zone lookup succeeds only by
  accident of NixOS shipping `/etc/zoneinfo`, while
  `mime.TypeByExtension(".woff2")` returns `""`. Ratified as
  [decision 0029](./context/buck2/.decisions/0029-official-go-release-toolchain.md).

- **buck2 hub / @overeng/megarepo**: a consumer cell can now use plain prelude
  rules against the hub's capability-backed tools, and the hub's own toolchain
  package parses inside a read-only mount. The hub's root package declares
  prelude's conventional toolchains — `rust`, `cxx`, `python_bootstrap` as
  native `toolchain_alias` onto `//buck2/toolchains:*`, `genrule` as prelude's
  own `system_genrule_toolchain` — which the composition root's
  `[cell_aliases] toolchains = <hub>` makes resolve from every member cell.
  Before: `buck2 build dotfiles//gen:probe` from a foreign cell died with
  `Unknown target 'genrule' from package 'effect_utils//'`; after: BUILD
  SUCCEEDED in 1.9 s, `cquery deps(effect_utils//rust/third-party:adler2-2)`
  returns 57 configured nodes, and a prelude `rust_binary` in a consumer cell
  compiles and runs. Prelude's internal Rust tools are bootstrap-interpreter
  targets, so this needed a fourth conventional toolchain and a new
  `python-bootstrap` capability rather than upstream's ambient bootstrap
  toolchain, which resolves a bare interpreter basename off the ambient PATH.
  Ratified as
  [decision 0028](./context/buck2/.decisions/0028-hermetic-python-bootstrap-for-consumer-cells.md).
  The #1056 Python-absence gate
  (`nix/devenv-modules/tasks/shared/tests/buck2-no-python-actions.test.sh`)
  narrows accordingly: it was one regex refusing every Python token, and is now
  an enumerated allowlist for the Nix-realized bootstrap interpreter — the rule,
  the `toolchains//:python_bootstrap` target, the capability id, its projected
  `.buck2/capabilities` entry and the `/nix/store/<realization>/bin/python3`
  shape — over an explicit refusal list of 17 forms (ambient system
  bootstrap/wheel/remote toolchains, every `python_*` action rule,
  `prelude//python:`, an interpreter bound to a bare basename, `env` lookups,
  Python shebangs, CPython itself), each with its own negative case, plus a
  catch-all that refuses any unenumerated spelling.
  **Breaking manifest change:** `ToolchainAuthority` gains a required, total
  `provides` list of the capabilities that realize the kind (`bun → [bun]`,
  `tsgo → [effect-tsgo]`, `pnpm → []`), because kinds and executables have
  different arities. Provided tool ids share the duplicate-detection namespace
  with member-owned capabilities, and the member-override refusal now covers
  them. Every `buck2-member.json` must declare `provides`.
- **@overeng/megarepo**: mr's composition capability resolver is the sole
  producer of `.buck2/capabilities`. It projects authority-provided capabilities
  alongside member-owned ones, so the same 20-tool projection reaches every
  read-only mount and, through `mr apply`, the owned member.
  `scripts/buck2-capability-project.sh`, its 212-line test, and the 100 lines of
  `devenv.nix` wiring that drove it from `enterShell` are deleted; the five
  Buck-invoking devenv tasks are ordered after `mr:apply` instead. Three
  producers with two disagreeing tool sets and two generation digests become one
  producer plus one atomic installer, one tool set, one digest — net −249 lines.
  Adding the two new tools moves `GENERATION`, and `support_tool` derives its
  input label from the whole-projection generation, so capability-consuming
  actions re-key once.

- **@overeng/stylex-preset -> @overeng/stylex-tokens**: the shared StyleX
  package is renamed to say what it durably is — our design-token package — and
  is now browser-pure. Its generated manifest declares no build-tool dependency
  at all: `@stylexjs/unplugin`, `unplugin` and `vite` are gone. Third-party
  attribution for the vendored scales is retained. The package fell out of 16
  packages' workspace closures as a result (18 -> 2), because `@overeng/utils`
  needed it only to wire the Storybook factory.
  **Compiled class names change.** A `defineConsts` value inlines its literal,
  but the atomic class hash still incorporates the constant's package-qualified
  identity: after the rename, `font-size:.875rem` moved from `.xox1hw9` to
  `.x1aa13qb` while the declaration stayed byte-identical. Emitted rules are
  unchanged as a multiset (92 rules, identical after masking hashed
  identifiers); only names and intra-priority ordering move. Markup baselines in
  `effect-schema-form-aria` were regenerated for that reason.
  If you had a worktree installed before this rename, delete the leftover
  `packages/@overeng/stylex-preset/` directory. Only its gitignored `dist` and
  `node_modules` survive, so `git status` stays clean while the labels generator
  keeps walking it and re-adding a `system:stylex-preset` label, and
  `lint:check:genie` then fails on drift that is not in the tree.
- **@overeng/utils**: owns StyleX build integration at
  `@overeng/utils/node/stylex`, and compiled CSS now enters the bundle as a
  virtual CSS module imported by each named entry rather than by picking an
  emitted asset by filename. Upstream's picker tries a caller predicate, then an
  unhashed `index.css`, then `style.css`, then silently falls back to the first
  CSS asset and exits zero — which on a route-chunked build can strand every
  rule in a lazy chunk. Its two asset-picking hooks are dropped; the dev path,
  which already used a virtual module upstream, is untouched. Side effect of
  going through the module graph: the rules are minified with everything else
  (`effect-schema-form-aria` stylesheet 7096 -> 6167 bytes, same 92 rules;
  Storybook 7084 -> 6155). A build that compiles rules no entry imports now
  fails instead of shipping unstyled output.
- **@overeng/utils**: `createDomStorybookConfig` drops its `stylex` option and
  gains `a11y`. The StyleX flag was redundant wherever the app's own Vite config
  registers the plugin — the builder merges that config, and enabling the flag
  as well produced byte-identical CSS from a second plugin instance.

### Fixed

- **CI performance evidence**: run every gated probe's configured warmup against
  both base and head worktrees, and report per-probe run counts, cumulative
  head/base time, medians, paired deltas, and measured-time share in the GitHub
  Actions summary.

- **CI performance gate**: keep `devenv-perf` merge-blocking while giving its
  pull-request-only paired base/head plan a 90-minute budget and a 288 GB
  Namespace runner that can retain both Nix closures. Gate-disabled diagnostics
  no longer run a baseline sample that cannot contribute evidence.

- **Megarepo devenv tasks**: select commit worktrees for lock-based bootstrap
  and tracking worktrees for shared branch mutation tasks. The source-mode `mr`
  wrapper now receives the same pinned composition runtime as the packaged CLI.
  Buck capability projection and TypeScript materialization wait for workspace
  reconciliation, so forced CI task graphs cannot project stale capabilities or
  start Buck while `mr` holds the workspace update lock.

- **@overeng/megarepo**: macOS refused cp-a first-publish and exchange renames
  while the staged and published R6 roots were protected as `0555`, even though
  their shared parent was writable. The Darwin rename boundary now opens and
  verifies the transaction-recorded directory inodes, makes only those roots
  writable for the rename, and restores `0555` through the same file
  descriptors on success or failure. Physical Darwin behavior is no longer
  disabled when a test injects Linux policy, and the R6 and overlay fault
  fixtures perform their synthetic renames with the same protected-root
  discipline. Recovery re-protects transaction-bound roots before R6
  inspection, so a crash during the short writable window cannot make a writable
  mount valid.

- **@overeng/megarepo**: the cp-a mount rename primitives ran with
  `stdio: 'ignore'`, so a failure reached CI as a bare `GNU mv no-clobber first
publish exited 1` with nothing to diagnose it by. `CpAMemberMountError` now
  carries the command's stderr, the exact argv, the resolved binary — whose Nix
  store path names the coreutils version — and the mode and owner of every path
  the rename touches, so `Permission denied` does not hide which permission
  check failed.

- **@overeng/megarepo tests**: composition refuses non-canonical paths on
  purpose — R6 identity, owned-worktree acquisition and the private-scratch
  ownership guard all require the physical path — but eight integration fixtures
  rooted their trees at a raw temporary directory, which on macOS is under the
  `/var` -> `/private/var` symlink. Every one of those guards then refused a
  fixture that real callers would have satisfied: 56 failures across 8 files.
  The fixtures now root at the physical temporary directory, the way
  `createStoreFixture` already did, via a shared
  `test-utils/temp-root.ts`. No guard is weakened; production is unchanged.

- **CI composition scripts**: `cleanup-effect-utils-composition.sh` derived its
  store, workspace and worktree paths from `MEGAREPO_STORE`/`RUNNER_TEMP`
  verbatim but compared them against Git, which always answers with resolved
  paths. On macOS, where the runner temp sits under the `/var` ->
  `/private/var` symlink, the worktree-identity guards could never match and
  `set -e` aborted a legitimate cleanup with exit 1. The script now resolves the
  store root and runner temp once and re-derives from them, so every comparison
  is same-namespace; no guard is weakened. `bootstrap-cold-proof.sh` had the
  same asymmetry in a guard that fails on match, where it silently stopped
  matching rather than failing loudly.

- **buck2 package trees**: the `package_tree` runner was staged into its action
  as a single file, so the `./real-path.ts` import the containment fix added
  resolved against a directory that did not contain it and every
  `:package_tree` action died with `Cannot find module`. `runtime` now points
  at a `filegroup` that co-locates the runner with its complete relative-import
  closure, and the rule takes a `runtime_entry` naming the module to execute.
  A new `genie:buck2:test` task runs the Buck2 genie suite — which nothing ran
  before, so its guards were inert — and a new guard walks the relative-import
  closure of every staged runner and fails when it is not declared.

- **buck2 toolchains**: `bun` and `effect-tsgo` were the only two tools bypassing
  the `.buck2/capabilities` projection, carrying hand-written `/nix/store` paths
  per platform instead. The `x86_64-linux` tsgo pin had gone stale against the
  current nixpkgs, so it was never realized on a CI runner and every TypeScript
  Buck action died with a bare `Error at spawn` (ENOENT) — the shared cause of
  the red `typecheck` and `buck2` jobs. Both tools are now projected from live
  Nix realizations like the Rust and support tools, so the per-platform maps are
  gone and cannot go stale. The three host-platform helpers that had drifted
  apart (one spelled the macOS key `aarch64-darwin`, the projection and the
  other two `aarch64-macos`) are consolidated into a single exported
  `host_capability_platform`. Toolchain identity is in the action key, so this
  invalidates cached TypeScript actions once. `buck2:editor-authority` and
  `buck2:typescript:materialize-dist` invoke Buck but did not depend on
  `buck2:capabilities:project`; they now do, so the projection the toolchains
  read is ordered rather than incidental.

- **@overeng/buck2-tools**: path-containment checks compared a canonicalized
  path against a non-canonicalized one, so every check failed wherever the
  repository root is reached through a symlink — including macOS, where `/tmp`
  is a symlink to `/private/tmp`, which is why `test (macos-arm64)` was red
  and Linux was green. `editor-view-authority` (authority output),
  `editor-view` (consumer cache) and `package-tree` (chained symlink targets)
  and `editor-view` (workspace authority manifest) now canonicalize both sides
  through a shared helper that resolves the deepest existing ancestor, so it
  works on paths that do not exist yet. Caller-supplied paths canonicalize
  everything above the final component and keep that component verbatim, so the
  later "must not be a symlink" guards still fire. Where no ancestor is a symlink the helper is the identity, so
  behaviour on a non-symlinked root is unchanged. The materializer shell test
  likewise states its expectation in the same resolved form the materializer's
  `pwd -P` produces.

- **buck2 materializer tests**: `assert_no_staging` in
  `nix/devenv-modules/tasks/shared/tests/typescript-materialize-dist.test.sh`
  used `compgen -G`, a programmable-completion builtin the non-interactive
  nixpkgs `bash` is built without. The assertion exited 127 and was a silent
  no-op on every platform. It now iterates the glob directly and actually
  fails when the materializer leaves a `.dist-buck2.*` staging directory
  behind.

### Changed

- **@overeng/utils**: transfer TypeScript typecheck and declaration emit to
  Buck. All 13 public type conditions consume Buck declarations, 16 legacy
  project references are removed, and tui-react consumes utils through its
  Buck dist instead of a source-sibling copy.

- **@overeng/content-address, @overeng/effect-distributed-lock,
  @overeng/otel-contract**: transfer TypeScript typecheck and declaration emit
  to Buck as one dependency-closed layer. Their package trees consume
  authoritative workspace declarations through Buck dist edges, and 17 legacy
  project references are removed.

- **@overeng/utils-dev, @overeng/stylex-preset**: transfer TypeScript
  typecheck and declaration emit to Buck as the first dependency-layer
  admission. Public type conditions consume Buck declarations, explicit
  handwritten declarations are copied as action inputs, legacy project
  references are removed, and tui-react consumes utils-dev through its Buck
  dist instead of a source-sibling copy.

- **Buck2 TypeScript admissions**: localize admission declarations in each
  package's `BUCK.genie.ts` and derive root TypeScript authority, member dist
  overlays, declaration materialization, and Buck check targets from the same
  typed registry. tui-core and tui-react remain the only authoritative
  packages; future dependency-layer admissions no longer require coordinated
  hardcoded task and manifest edits.

- **@overeng/megarepo**: `src/lib/` is gone; its 100 files now sit in
  responsibility directories (`core/`, `composition/{acquisition,mounts,overlays,capabilities,root,apply}/`,
  `store/`, `sync/`, `generators/`) per the hierarchy ratified in
  `context/megarepo/spec.md`. Pure moves plus relative-import rewrites — no
  behavior change, no public-surface change (`.`, `./buck2-manifest` and
  `./cli` are unchanged). `core/` provably imports nothing from
  `composition/`. The `member-mount-r6` and `member-mount-cp-a` module headers
  now explain their codenames and why they are two modules rather than one.
- **workflow-report devenv module**: Resolve packages from the module-provided
  `pkgs` set so consumers can evaluate the module from a pure store source.
- **@overeng/utils, @overeng/tui-core, @overeng/tui-react**: Effect 4 idiom
  adoption. `base64` is now a thin facade over upstream `Encoding` (net -107
  lines; invalid input throws `Encoding.EncodingError` instead of `DOMException`
  and unpadded base64 is rejected). `FileLogger` rebuilds its sink on
  `Logger.toFile` with byte-identical on-disk output. One canonical
  `stripAnsi` lives in `@overeng/tui-core` (superset regex incl. DEC
  private-mode CSI, charset, and keypad escapes); tui-react re-exports it. New
  shared `nonEmptyTrimmedString` schema helper (`NonEmptyString` +
  `check(isTrimmed())`), adopted by agent-session-ingest,
  notion-datasource-sync, ci-tools, and notion-effect-client;
  content-address stays dependency-free to avoid a utils ->
  otel-contract -> content-address -> utils cycle.
- **@overeng/notion-effect-client, @overeng/notion-effect-schema,
  @overeng/notion-cli**: response-only page and database APIs now accept
  `Schema.Decoder`; generated schemas import the package's re-exported `Schema`
  namespace and use the explicit Effect 4 async decode/encode helpers.
- **@overeng/notion-effect-client**: the request throttle reads
  `RateLimiter.ConsumeResult.delay` directly (the double-Clock measurement and
  the `isRateLimiterError` catch-to-die workaround are gone; e2e wait assertions
  tightened to exact values). `mapHttpClientError` now discriminates
  retryability by transport reason (`invalid_request` vs `service_unavailable`)
  with unchanged wire envelopes. New opt-in `NotionTracerHeaderFilterLive`
  layer re-expresses the retired v3 span-header allowlist as the upstream
  `HttpClient.TracerHeaderFilter` reference, enabling verbose Notion traffic
  spans without core patches.
- **All CLIs (mr, genie, notion, notion-md, tui-stories, ci-tools,
  npm-release)**: version/help/error rendering now comes from upstream
  `CliOutput`/`GlobalFlag` via `Command.runWith({ version })`. The
  `CliVersion.enrichErrors` descriptor-clone hack is deleted (errors are never
  mutated; version stamps are appended at render time). `notion --version` now
  prints the upstream `notion v0.1.0` format; validation errors gain
  ` (name version)` stamps. A JSON-stdout guard (incl. the schema command's
  `--output-mode`) keeps validation help off stdout for JSON/NDJSON modes;
  `resolveCliBuildIdentity` is unchanged.
- **Buck2 dependency closure**: generate a lockfile-derived, platform-filtered
  pnpm graph with hash-pinned fetch, safe extraction, patched-package support,
  and relocatable importer assembly; move tui-core and tui-react to the new
  provider and delete the ambient-store deploy, normalization, descriptor, and
  CI cache lanes.
- **Buck2 composition**: remove generated stub cells, move toolchains under
  `buck2/`, make hub labels cell-relative, add fail-closed member-root and
  shared-hub-pin guards, and transactionally prune obsolete generated files.
- **Buck2 editor views**: enforce whole-workspace authority, content-settled
  atomic publication, read-only snapshots with external caches, and bounded
  rollback-safe snapshot retention.
- **Buck2 tooling**: add the `buck-owned-files/v1` census, remove the final
  Prelude CPython registration, and export the stable
  `@overeng/megarepo/buck2-manifest` facade.

- **VRS (megarepo)**: establish the `context/megarepo/` sub-VRS for the
  megarepo tool. Adds `vision.md` (the problem, intended future, boundaries,
  and success criteria), `spec.md` (the tool's two responsibilities — repo
  arrangement and workspace ownership — the composition state machine, the
  CLI surface, and the ratified target source hierarchy), `ontology.md`
  (absorbs and supersedes the package's store-GC glossary, adds the
  workspace-ownership vocabulary, and flags the R6 / `COMP-R06` shorthand
  collision), and ratified `requirements.md` (MR-A01–A03, MR-T01–T03,
  MR-R01–R11) derived only from already-ratified sources. Decision records
  0001/0006/0007/0008/0009 migrate from
  `packages/@overeng/megarepo/docs/decisions` with their numbering and gap
  preserved; the package's `docs/decisions/*` and `docs/glossary.md` are left
  as pointer stubs. `context/buck2/05-composition/` remains the buck2-facing
  composition contract (`COMP-R*`) and is referenced, never restated.
  Docs-only.
- **VRS (buck2)**: ratify decision 0023 — Rust third-party sources become
  Buck-fetched `http_archive` targets via non-vendored Reindeer (sha256 from
  `Cargo.lock`); decisions 0017/0019 amended; two 2026-08-30 experiment
  records added; roadmap Phase 5 updated.
- **VRS (buck2)**: ratify decision 0022 — dependency materialization becomes a
  lockfile-derived declared closure (per-package fetch/extract targets,
  per-importer assembly, no ambient store, no install step); decision 0015
  superseded in mechanism; DEPS-A02/T01/R02/R04/R07/R08 re-tensed; roadmap
  gains Phase 2b; three 2026-08-30 experiment records and open questions added.

- **Buck2 Rust products**: admit all five Cargo workspace members through one
  strict generated Buck projection, bind native Rust/C++ toolchains to exact
  Nix capabilities, and prove real `otelite` then `otel-scrape` BuildProducts
  through independent fail-closed Nix imports. Cargo and source-building Nix
  producers remain available until a later authority-transfer change.

- **Buck2 Rust graph**: generate one strict non-vendored Reindeer dependency
  graph from the authoritative five-member Cargo workspace, fetch 126
  hash-pinned crate archives directly through Buck, and delete the Nix vendor
  projection and vendored-only fixups.
- **VRS (buck2)**: ratify BUCK-R15 (net complexity accounting) and BUCK-R16
  (benchmark evidence): every phase reconciles a build-machinery deletion
  ledger with amortization rationale, and every admission records warm/cold
  timings, cache hit rate, and CI wall-clock deltas as widening gates.
- **@overeng/tui-react**: transfer root typecheck and declaration emit authority
  to reusable Buck package targets, consuming tui-core through its Buck `dist`
  boundary, publishing declaration overlays and export type conditions from
  Buck output, and deleting tui-react from the root TypeScript check/emit
  producers while preserving source runtime exports and the transitional editor
  root install.

- **@overeng/megarepo**: cut Buck workspaces over to decision-0020 composition: one acquired writable owned member, canonical clean detached locked sources, immutable verified `cp -a` mounts, secret-free Nix execution and trusted mr-owned TypeScript capability projection, lockfile-preserving exact Nix capabilities, inode-checked owned projection publication, atomic overlays, fresh-root bootstrap plus root-authority-last updates, composition-aware pin/status/orphan/liveness handling, reference-only ignored legacy members, and no bare-member `.buckconfig`.

- **@overeng/megarepo**: make the first real read-only-member composition
  satisfy its R6 and Buck bootstrap contracts: publish fresh root authority
  before its first dist overlay, normalize resolved capability projections to
  immutable source modes with cleanup-safe release, and keep the synthetic
  `.buck2/capabilities` container outside repository identity.

- **Buck2 cache policy**: materialize `BUCK2_NO_REMOTE_CACHE=1` into the
  synthesized root before its first overlay action, make execution platforms
  consume that root policy, and preserve the toggle through the CI composition
  environment boundary.
- **CI**: run every devenv, Buck, TypeScript, lint, test, cargo, and Genie lane from a disposable decision-0020 synthesized workspace while retaining the immutable actions checkout for cleanup and checkout-only artifacts; keep pnpm and Nix cache state at stable runner-temporary paths projected into the owned member.
- **CI admission**: move repeated devenv resolution/repair logic into a prepared
  runtime script and enforce GitHub's 500 kB workflow limit. The generated CI
  workflow drops from 518,102 to 466,190 bytes, leaving 33,810 bytes below the
  enforced admission ceiling.

### Removed

- **context/effect-4/**: the flip-era migration docs (alignment register, idiom
  catalog, differential recipes, ops manuals). The executable
  baseline-collection gate moved to
  `@overeng/utils-dev/check-baseline-test-collection.ts`. The empty
  `utilsPatches` projection registry is gone from genie config.
- Retire the dormant Buck closure-compiler and package-evidence regime, including
  its unused Buck rules, Rust tools, Nix capabilities, and projection tests;
  retain the live archive/product bridge and real tui-core TypeScript actions.

- **@overeng/utils, @overeng/genie, @overeng/notion-md**: apply the watch-recursion
  design study for effect@4.0.0-rc.111 (recursion is opt-in again). New
  `watchScoped` helper in `@overeng/utils/node` wraps `FileSystem.watch` with an
  explicit `{ recursive: true }`, resolves event paths against each root,
  filters by absolute-path scope, coalesces bursts into deduped batches over a
  250 ms window (configurable), and ties watcher cleanup to the stream scope;
  watcher failures propagate through the stream. The utils file-system semaphore
  backing's `onPermitsReleased` now watches via the helper (recursive, explicit)
  with unchanged failure semantics. Genie `--watch` embraces recursion — closing
  the latent blindness to nested `*.genie.ts` edits — and regenerates each
  250 ms burst as a single TUI cycle instead of one cycle per event; watch-stream
  errors are surfaced in the TUI. notion-md single-file watch pins
  `{ recursive: false }` explicitly and keeps its exact-path filter; batch watch
  collapses the per-parent-dir watchers into one recursive watch rooted at the
  deepest common ancestor of the targets.

- **@overeng/stylex-preset**: add the shared StyleX Vite integration,
  parity-preserving preflight, and typed Tailwind-compatible design scales.
  The token definitions are vendored from `tailwind-stylex@0.1.1` with MIT
  attribution so downstream repositories do not inherit the new package as a
  supply-chain dependency.
- **@overeng/effect-schema-form-aria**: styling now uses StyleX
  (`@stylexjs/stylex`) through a package-local semantic token layer
  (`src/tokens.stylex.ts`, exported as `tokens`) whose raw scales come from
  `@overeng/stylex-preset`. Selection styling uses React Aria render-prop
  `className` instead of Tailwind group/data variants. Consumers import the
  required reset from `@overeng/effect-schema-form-aria/styles.css`; the
  publication build emits that reset and compiled component rules together.
  Byte-identical markup baselines were regenerated with hashed StyleX class names.

- **@overeng/effect-schema-form-aria**: anchor semantic color defaults to named
  Tailwind-compatible palette steps (`neutral900`, the gray scale, and
  `blue500`) instead of raw hex values. This intentionally updates rendered
  colors while leaving component token usage unchanged.

- **@overeng/effect-rpc-tanstack**: client request-id policy — `layerClient`
  now validates outgoing RPC request ids at the client boundary. Non-empty
  strings and non-negative, finite numbers/bigints are accepted (v4 interop);
  malformed ids fail with the new typed `InvalidRequestIdError` instead of
  reaching the wire (`validateRequestId` is exported for direct use). See
  `rpc-request-id-policy` in `context/effect-4/alignment-register.md`.
- Fix lazy Buck stage-0 recovery to snapshot only its fingerprinted source inputs, keep unrelated Cargo product manifests out of tool derivations, and retain the observability gate when shell-entry setup is disabled.

- Harden Buck foundation review contracts by recording explicit revision and execution-platform receipt identity, redacting password aliases, validating schema-v3 provenance, preserving mutation-free observability checks, narrowing generated-file markings, and leasing in-flight publications against future collection.
- Preserve pre-identity Buck receipt and dry-run compatibility while hardening dynamic ELF metadata boundaries, inspector failures, and artifact-seam mutation proofs.
- Parse dynamic ELF dependency delimiters and version-need sections structurally, including non-numeric symbol versions without admitting local definition noise.
- Preserve fixed-marker PT_INTERP paths and complete whitespace-bearing version-need names when inspecting dynamic ELF artifacts.
- Bind Buck comparison receipts to the same repository revision and execution platform, preserve delimiter-like ELF version names, and keep the Rust toolchain flake call aligned with its minimal config API.

- **Buck2/devenv fast path**: make shell activation independent of Buck and
  repository setup, expose the pinned Buck client through a source-mode local
  launcher, lazily resolve stage-0 tools only for consuming tasks, and classify
  warm shell versus warm Buck as separate benchmark workloads.

- **Generated Buck contracts**: bind generator and schema identities into
  semantic projection fingerprints, record exact projection sources, make
  commentless Genie outputs participate in freshness state, enforce Genie
  freshness unconditionally in CI, and distinguish immutable benchmark
  evidence and review-visible Cargo topology from collapsible generated noise.
- **Generated contract verification**: teach the Buck launcher to verify schema
  3 provenance fingerprints, cover direct and nested Genie ownership from one
  Nix input list, make warm fingerprints use exact Git glob semantics, and keep
  provenance ordering locale-independent. Generated bytes are authoritative;
  read-only modes remain a local generation guardrail because Git cannot
  preserve ordinary write bits across checkout.
- **Repository-wide**: atomic Effect 4 cohort flip to `effect@4.0.0-rc.111`
  (with `@effect/platform-node`, `@effect/vitest`, `@effect/opentelemetry`,
  `@effect/atom-react`, all rc.111). Platform, CLI, RPC, Schema, AI, Cluster,
  Workflow, SQL and Atom reactivity are now core modules
  (`effect` / `effect/unstable/*`). Services use the v4 `Context.Service`
  model; error handling uses `Effect.catch`/`catchCause`; forks are
  `forkChild`/`forkDetach`; wire formats preserved via `DateFromString`/
  `DateTimeUtcFromString`. The mixed-major duplicate exception and the v3
  http.client span-header patch are retired — known behavior changes and
  follow-ups were tracked in the retired `context/effect-4/` migration docs (git history).
- **@overeng/tui-react, @overeng/megarepo**: `stripAnsi` now strips DEC
  private-mode CSI sequences (e.g. `\x1b[?25l`/`\x1b[?25h` cursor visibility,
  `\x1b[?2026h`/`\x1b[?2026l` synchronized output) that every Effect rc.111
  `Prompt` frame emits under a PTY — previously these raw escape bytes leaked
  into "plain text" output in colors-off (`ci`/`log`/`ci-plain`) modes. The
  rc.111 Prompt PTY transcript bytes (shorter SGR/reset sequences) are now
  deliberately baselined in megarepo's real-PTY gate.
- **context/effect-4**: record rc.111 contract decisions in the alignment
  register and retire their stale statuses: cli-C rendering/stdout differences
  are accepted under the locked full-rebaseline decision (v4 help, version,
  and validation rendering on all audited binaries, no compatibility shims);
  filesystem-watch recursion is resolved upstream at rc.111
  (`WatchOptions.recursive` opt-in again, Node backend defaults to false); and
  `effect-rpc-tanstack` stays single-current-format; independently deployed
  consumers own same-contract rollout, explicit browser cache/open-tab
  handling, and live HTTP RPC plus SSR `Exit` boundary evidence (#979).
  Docs-only change.
- **@overeng/tui-react, @overeng/tui-stories, @overeng/effect-react,
  @overeng/effect-schema-form, @overeng/effect-schema-form-aria**: migrate to
  effect@4.0.0-rc.111. Schema AST introspection updated to v4 node kinds
  (`String`/`Number`/`Boolean`/`Objects`/`Arrays`, `Undefined` union members;
  refinements are now checks, transformations are `encoding` links) with
  title/description reads via `SchemaAST.resolveTitle`/`resolveDescription`;
  variadic `Schema.Union`/`Schema.Literal` → array-form
  `Schema.Union([...])`/`Schema.Literals([...])`; services migrated from
  `Context.Tag` to `Context.Service` (accessor `.use`, static layers);
  `Runtime.Runtime` removed — the React provider now stores a
  `Context.Context` and runs effects via `Effect.runForkWith`; `Cause`
  accessors replaced (`findErrorOption`/`findDefect`, `hasInterrupts`),
  `Effect.tapErrorCause` → `tapCause`, `Effect.fork` → `forkChild`,
  `Exit.isInterrupted` → `hasInterrupts`, `SubscriptionRef.changes(ref)`
  standalone form; CLI moved to `effect/unstable/cli` (`Flag.string`,
  `Command.runWith`, repetition via `between`) and bins provide
  `NodeServices.layer`. tui-react's `testModeLayer` binds the Effect Console
  service to the caller's global console (effect 4 vitest otherwise scopes
  tests to its own TestConsole), and TUI app runs reset module-level atoms to
  their configured initial state so consecutive runs don't inherit prior
  mutations. Cross-major wire baselines rebaselined for effect 4 drift:
  keyword schemas no longer carry built-in `title`/`description` annotations,
  CLI help/validation prose renders on stdout with new formatting, schema
  decode failure prose follows the v4 formatter, and SubscriptionRef change
  streams emit the initial value at subscribe time.
- **@overeng/ci-tools**: restored trim validation of provider outputs at the
  deploy boundaries — Netlify CLI/site JSON (`deploy_id`, `site_name`, `name`,
  `account_slug`) and Vercel project JSON (`id`, `name`) now reject
  whitespace-only values as invalid provider output instead of accepting them.

- **@overeng/content-address, @overeng/kdl-effect, @overeng/otel-contract**:
  migrate to effect@4.0.0-rc.111. `Schema.pattern`/`maxLength`/
  `NonEmptyTrimmedString` replaced by v4 checks (`check(isPattern(...))`,
  `check(isMaxLength(...))`, `NonEmptyString.pipe(check(isTrimmed()))`);
  `Schema.Defect` → `Schema.Defect()`; `AnyNoContext` constraints →
  `Schema.Codec<any>`; kdl-effect's KDL codec rebuilt on `Schema.decodeTo` +
  `SchemaGetter` (v4 removed `transformOrFail`/`ParseResult`) with the AST
  normalizer ported to the v4 node kinds (`Arrays`/`Objects`, `encoding`
  links, `Suspend.thunk`); otel-contract's weaver registry annotation walk and
  metric bridge updated (AST `representation.id` declarations,
  `Metric.update` with `withAttributes`, `Metric.snapshot`, `Result`
  instead of `Either`); `ServiceIdentity` remains a plain v4 Struct so
  downstream `decodeSync` consumers are unaffected.

- **@overeng/utils-dev, @overeng/utils**: finish the effect@4.0.0-rc.111 migration
  for `utils-dev` and the residual `utils` sources/tests. Highlights: OTLP moved
  from `@effect/opentelemetry` to `effect/unstable/observability`
  (`OtlpTracer`/`OtlpSerialization`/`Otlp.layerJson`); `@effect/platform`
  surfaces moved into Effect core (`effect/unstable/http`,
  `effect/unstable/process`, `effect/FileSystem`) with `NodeContext.layer`
  replaced by `NodeServices.layer` and platform `Command` replaced by
  `ChildProcessSpawner`; services migrated from `Effect.Service` (accessors,
  `.Default`) to `Context.Service` with explicit static layers; FastCheck now
  imports from `effect/testing/FastCheck`; schema codecs renamed per v4
  (`decodeUnknownEffect`, `fromJsonString`, `Literals`, `.annotate`);
  `Duration.Input`, `Cause.TimeoutError`, `Effect.callback`/`forkChild`/
  `andThen`/`catch`, string-union `LogLevel`, and `Metric.update`/
  `withAttributes` replace their removed v3 counterparts.

- **@overeng/utils**: `rewriteHelpSubcommand` now takes and returns pure user
  args instead of full `process.argv`. Callers must slice off the node/script
  positions themselves (e.g. `rewriteHelpSubcommand(process.argv.slice(2))`);
  passing full argv would silently misparse a leading `help` argument. The
  behavior mapping `help <subcmd> [args...]` -> `<subcmd> --help [args...]` is
  unchanged.
- **@overeng/notion-datasource-sync, @overeng/notion-md,
  @overeng/notion-effect-client, @overeng/tui-react**: migrate optional
  service tags to effect@4 `Context.Reference` with lazy defaults
  (`SyncProgress`, `ProgressReporter`, `NotionHttpTelemetry`,
  `NotionThrottle`, `ViewOutputStreamTag`; plus tui-react's internal
  skip-mode flag). Absent provisions now resolve lazily to the same no-op /
  pass-through / stdout defaults the old `Effect.serviceOption` branches
  produced; explicit layers and `provideService` still win. The tags are
  plain `Context.Reference` values now, not classes — type-level references
  must use the exported shape types (e.g. `ProgressReporterShape`,
  `NotionThrottleShape`) instead of the tag name.

### Fixed

- **@overeng/ci-tools**: handle Vercel `already in use` alias collisions
  deterministically: resolve the current holder on collision, succeed when it
  is a deployment of the same commit, recheck once for a same-project holder,
  and fail fast with an actionable error naming the remedy when the host is
  held outside the project (`AliasAssignmentFailed` carries the classified
  inner failure and attempt count; workflow-report records report true
  attempts).

### Added

- **@overeng/utils-dev**: add a shared `normalizeCliOutput` helper at the
  `./cli-contract` export for CLI contract baselines. Each masking policy
  (ANSI, log timestamps, checkout root, local-source suffix) is an explicit
  option defaulting to `false`, so consumers state their policy instead of
  drifting between copies; five contract suites now consume it.

- **@overeng/notion-react**: export `NodeKey`, the encoder for the
  `k:<blockKey>` / `p:<index>` node keys the reconciler assigns to
  candidate/cache tree entries (#1121). The internal key derivation now
  routes through the same encoder, so consumers that construct or index
  into a `CacheTree` out-of-band can no longer drift from the scheme
  `buildCandidateTree` / `diff` actually produce.

- **@overeng/notion-react**: add `adopt()`, fail-closed adoption of an
  existing rendered page (#1093). A stateless consumer whose renderer cache
  did not survive can rebuild the `CacheTree` a prior `sync()` would have
  persisted from (candidate JSX, pageId, live observation) alone — zero
  Notion mutations in every outcome, refusal paths included. Binding is
  strictly positional (`blockKey` is never stored in Notion; keys flow
  candidate-side only); every bound pair is verified — block content through
  the readback oracle, `child_page`/root `<Page>` title/icon/cover claims
  per field via `pages.retrieve` — and every divergence is collected into
  one typed `AdoptionRefusedError` (`ChildCountMismatch`, `TypeMismatch`,
  `ContentDrift`, `UnverifiableContent`, `PageMetaDrift`, `RootTrashed`).
  `onContentDrift: 'adopt-live'` keeps structural checks fail-closed but
  records a live marker at drifted nodes so the next ordinary `sync()`
  emits exactly the minimal repairing updates, after which strict
  re-adoption reaches the zero-op fixpoint.
- **@overeng/notion-react**: add `pageLifecycle: 'managed' | 'append-only'` on
  `sync()`/`plan()` (#1124). `'append-only'` guarantees a sync never archives,
  moves, or reorders a page and never creates one out of tail position in its
  parent's page-sibling run — for irreplaceable live trees whose page identity
  carries grants. One pure post-diff predicate fails the whole sync before any
  op applies with `NotionSyncError { reason: 'page-lifecycle-violation',
violations }` (the offending `DiffOp[]`); block ops and page content
  (`updatePage`) stay fully managed. `plan()` reports the same violations in
  `SyncPlan.lifecycleViolations` without failing, and #1100 crash-recovery
  adoption (read + cache-save) stays legal under the mode.
- **@overeng/notion-react**: add the readback verification oracle (#1123).
  `compareReadback({candidate, observed})` folds server-observed block JSON
  and rendered candidate trees into one canonical form and compares them by
  hash, absorbing Notion's response-shape deltas (decorated/re-segmented rich
  text, explicit defaults, provider-injected fields). Ships with
  `compareReadbackPage` for the page title/icon/cover envelope and
  `observeBlockTree`, a GET-only walk producing the observed tree. Readback
  hashes are a **separate hash space** from `CacheNode.hash` — never compare
  across the two. Masking is candidate-contextual (no context-free observed
  hash exists): unclaimed provider-owned fields, uploaded-media signed URLs,
  and built-in-icon rewrites are masked and documented rather than compared
  best-effort. `child_page` blocks compare by title identity; sub-pages get
  their own per-page readback pass.
- **@overeng/notion-react**: add `plan()`, a read-only companion to `sync()`
  (#1122). It computes the exact op sequence a sync would apply — through the
  same pre-flight and diff code path, root-page metadata update included —
  with zero writes: no Notion mutation, no cache save. `SyncPlan.empty` is a
  post-publication fixpoint oracle. `staleness: 'live' | 'cache-only'` picks
  between sync's GET-only shallow pre-flight (detects out-of-band drift) and
  a zero-request pure cache×JSX check. `onEvent` emits the retrieve op events
  and one `PlanComputed` from the existing `SyncEvent` union.
- **devenv pnpm / Genie**: add root-local, read-only source generations for
  composed workspaces. Aggregate roots declare cross-repository source inputs,
  Genie projects matching `file:` overrides, and the shared pnpm transaction
  publishes and validates one bounded generation without mutating canonical
  repository source.

- **@overeng/notion-react**: add an experimental read-only JSX →
  Notion-enhanced-Markdown projection at the new `@overeng/notion-react/markdown`
  entry point (#1097). `renderToNotionMarkdown(element)` reuses the production
  candidate-tree render pass and returns `{ body, diagnostics }`; lossy
  constructs (colors, upload-only media, flattened columns/child pages,
  unsupported `Raw` blocks) emit typed diagnostics instead of disappearing
  silently. The body composes with `@overeng/notion-md`'s `renderNmdFile` for
  `.nmd` envelopes. Experimental: spellings and the diagnostics contract may
  change until a real consumer proves the output.
- **@overeng/utils**: allow shared Playwright web-server configs to pass typed
  environment variables to the server process.
- **@overeng/megarepo**: add a read-only `mr store gc --generated-artifacts
--dry-run` planner for safely identifying stale ignored build artifacts. The
  planner requires external agent-liveness evidence and fails closed on
  uncertain cleanliness, ignore status, or bounded filesystem traversal.

- **Buck2 build-product contract**: add a pure exact validator and canonical
  descriptor digest for the shared Buck-to-Nix product envelope. Runtime is a
  required tagged union, invocation evidence is excluded from semantic product
  identity, and the importer now requires an independently supplied descriptor
  digest and rejects every runtime until its real inspector exists. This removes
  the synthetic shell import as evidence of an admitted portable product; the
  input-plan fixture is now labeled `buck2-package-evidence` rather than
  masquerading as a build product. Descriptor paths reject CR/LF bytes, fixed
  canonical conformance vectors guard identity, and archive scanning rejects
  non-padding bytes or concatenated archives after the first end marker.
- **Rust workspace authority**: compose `otelite` and `otel-scrape` under one
  native Cargo workspace, shared lockfile, and repository toolchain declaration.
  Member manifests inherit only semantically identical requests; the Nix bridge
  keeps each package's source local while including the exact workspace contract.
- **Buck2 build foundation**: add generated package-local Buck targets, an exact
  pnpm closure compiler with content/context/task identities, deterministic
  package evidence archives, a Nix-exported portable-toolchain boundary, and a
  hardened Buck-artifact-to-Nix import bridge. A thin Nix-built launcher retains
  Buck reports and emits fail-closed receipts; devenv exposes local-only E2E and
  benchmark gates. Remote cache access and remote execution stay disabled until
  authoritative package materialization, trust, and cross-platform gates pass.
- **Buck2 system design**: specify sibling foundation slices with explicit
  product joins, OCI as untrusted product transport, reviewed exact-child Nix
  pins, sealed admission bundles, independent durability and restore proof,
  zero-network activation, conservative collection, separate reuse planes, and
  an admitted on-demand Prelude CPython action-toolchain bootstrap boundary.
- **Buck2 Rust platform prototype**: add explicit x86_64 Linux glibc-dynamic and
  musl-static target boundaries plus a local-only, Nix-store Rust toolchain
  probe that produces and inspects a self-contained static PIE. Bind the probe
  to an exact Buck execution constraint and one Nix-authored toolchain config
  so platform claims cannot silently fall back or drift from tool identities.
  Use nixpkgs' version-matched prebuilt musl Rust toolchain instead of rebuilding
  the target standard library from source in each uncached CI environment, and
  retain a task-scoped GC root until all Buck invocations finish.
- **genie/ci-workflow**: allow CI consumers to select the devenv lock file used
  by the pinned-devenv preparation and Nix-store validation steps.
- **@overeng/effect-path**: add Effect 3 cross-major baselines for PathInfo schema
  encoding, convention parser failure partitions, and path operation byte output.
- **@overeng/tui-stories**: add Effect 3 cross-major baselines for schema-encoded
  JSON, NDJSON timeline output, and durable output-state decode failures.

- Add a shared CI helper for job-local Cargo targets and `sccache` servers on
  multi-identity self-hosted runners.
- **genie/ci-workflow**: let default-ref policy consumers explicitly admit
  immutable commit refs for named `*-legacy` megarepo members, while keeping
  branches, tags, and ordinary members on the canonical default ref.
- **@overeng/effect-rpc-tanstack**: capture Effect 3 cross-major baselines for
  SSR `Exit` JSON encoding and native HTTP RPC NDJSON request/response failure
  partitions.
- **@overeng/effect-react**: capture Effect 3 cross-major runtime baselines for
  provider layer construction/provision, scope teardown, retry behavior, and
  external-store subscriber observations.

### Changed

- **genie/ci-workflow**: decide PR snapshot authorization in the tested
  predicate. Both the `authorize` and the pre-publish recheck now invoke
  `isAuthorizedSnapshotState` through a new `authorize` CLI mode instead of
  restating the decision in bash, so the code gating publication is the code the
  boundary suite covers. The fork trust label becomes a required
  `--trust-label` argument rather than a hardcoded constant, and an empty label
  fails loudly instead of silently matching nothing. The validator is sparse
  checked out at `github.workflow_sha`, never from the pull request under
  evaluation.

### Fixed

- **@overeng/notion-react**: verify warm-cache block identities recursively
  through renderer-owned nested blocks and child-page scopes. A stale nested
  cache now reconciles untracked live descendants instead of appending
  duplicates, while opaque synced-block children remain untouched. Promised
  but transiently empty child lists retry and fail closed on exhaustion;
  recursive and retry requests are reflected exactly in retrieve metrics and
  `SyncEnd.opCount`. Unambiguously keyed child pages moved out of band between
  renderer-owned parents retain their durable page ID, key, and subtree instead
  of being archived and recreated; destination-scope key collisions take the
  safe rebuild fallback instead of producing an invalid cache. Independent
  page-order retention is likewise limited to child-page scopes; root and
  ordinary-block child scopes keep full mixed-kind ordering. The persisted
  `CacheTree` exactly reflects the identities left live and an immediate
  identical sync emits zero mutations.

- **@overeng/genie/semver**: match trailing `x`, `X`, and `*` range wildcards
  by their specified major and minor components.

- **Nix prepared dependencies**: normalize ordinary, non-injected local
  `file:` packages through pnpm's exact package-map locator before removing
  transient Source Input aliases. Restored CLI workspaces now resolve the
  logical package manifest and source instead of an empty virtual-store target;
  the declared alias manifest owns the source-path boundary while nested peer
  context remains opaque, and the prepared artifact layout advances to `v19`.
- **@overeng/notion-react**: checkpoint each successful sub-page identity before
  resolving inline descendants, then checkpoint the resolved subtree, so a
  crash after `pages.create` retries with the same stable page id instead of
  creating a duplicate.

- **devenv observability verification**: enable native Devenv task activities
  during trace capture while preserving task stderr and a diagnostic copy.

- **genie/ci-workflow**: preserve prepared CI helper scripts between workflow
  steps by staging their runtime artifacts in the job workspace without their
  generator sources, and reject every helper consumer unless preparation
  follows the final workspace-cleaning checkout and Nix installation.

- **Buck2 pnpm prototype scope**: retain the exact lock-derived contextual
  dependency plan for `tui-core` while keeping it explicitly non-admitted. The
  prototype does not fetch, unpack, normalize, or materialize package archives.
- **Buck2 lazy stage-0 cache**: retain realized Nix tools with per-fingerprint
  GC roots, validate cached resolver ABI, semantic identity, tool keys, and root
  bindings before reuse, and bound retries when semantic inputs keep changing.
- **Buck2 foundation contraction**: run the destructive invalidation RED/GREEN
  proof in a disposable Buck project instead of mutating a shared tracked
  fixture. Correct the VRS boundary from rule-load-time CPython to Prelude's
  on-demand Python action toolchain, make the launcher and synthetic package
  E2E documentation match their current receipt-only and
  `admission=not-attempted` behavior, and record the shared-workspace Rust
  helper contraction gates without claiming a premature admission verdict.
- **Buck2 Rust stage-0 tools**: replace repository-owned Python action helpers
  with fine-grained Rust workspace members, independently realize them through
  Nix, inject immutable executables into Buck action keys, and prove the real
  Nix-to-Buck staging path under a hostile ambient `PATH`. Cargo's native
  workspace inventory now drives build, test, clippy, and formatting gates;
  scratch benchmarks ignore ambient Git hooks while retaining exact detached
  revision isolation.
- **genie/weaver**: wrap long generated TypeScript constant declarations so
  generated registry projections remain formatter-clean without hand edits.
- **Buck2 evidence safety**: accept generated v2 closure projections, redact
  prefixed credential assignments, reject duplicate archive members before
  extraction, insert launcher evidence flags before Buck argument passthrough,
  reject reused receipt run IDs, and make failed mutation baselines produce
  no-verdict samples. Prune optional-branch orphans, stream retained-log
  descriptors, restore in-place mutations across signals, recognize Buck global
  options including attached numeric verbosity, keep host-stamped package actions
  local, structurally redact credential-key values and authorization schemes with
  their CLI credentials, including auth and credential-named key segments,
  reject invalid materialization counters, require every exported symlink target
  to use the same portable normalized form as the Buck importer, and reject
  unknown descriptor fields, duplicate, control-bearing, or non-canonical
  entrypoints, reserved importer metadata, oversized, non-block-aligned, or sparse
  portable-tool archives, and bytes after the tar end marker.
- **devenv pnpm installs**: refresh nixpkgs so pnpm runs on Node 24.18.1,
  avoiding the Darwin Node 24.15 teardown hang after a completed workspace
  materialization.
- **devenv observability verification**: validate the task trace independently
  of unrelated setup traces captured from devenv, and keep `otel-scrape`
  warning-clean across platform-specific backends and ambient trace links.

- **@overeng/genie/package-json**: allow consumers to materialize selected
  cross-repository workspace dependencies with the `file:` protocol. This lets
  pnpm resolve singleton peers such as Effect from the consuming install graph
  instead of following a foreign repository symlink with a second physical
  peer installation.

- **@overeng/utils-dev/otelite**: make live capture inspection poll for the
  observable row condition for up to 500 ms. This absorbs exporter scheduling
  and OTLP round-trip delay on contended CI hosts without consumer-specific
  sleeps, while still bounding genuinely empty captures.

- Allow pnpm-state cache consumers to narrow the lockfile hash expression, avoiding recursive workspace scans after dependency projection.

- **devenv deploy tasks**: make the reusable Netlify and Vercel task modules
  compose their shared workflow-report task dependency. Generated preview
  workflows can now collect and publish deploy records without every consumer
  duplicating a `workflow-report.nix` import.

- **@overeng/ci-tools / Netlify previews**: add an explicit
  `unauthorizedPolicy=skip` task input for optional PR previews. Unauthorized
  provider responses still fail by default and for production deploys; shared
  PR workflow composition opts into a structured skipped record so consumers
  no longer duplicate provider-error string matching in workflow generators.

- **devenv-modules**: remove `lint:nix:workflow-commands` and correct the task-output
  documentation. The guard was added on the belief that devenv discards a task's stdout, so a
  workflow command emitted there never reached the runner. That was measured in a shell with
  `CLAUDECODE=1`, which puts devenv in implicit AI-agent quiet mode — a mode that never applies
  on a GitHub runner. Measured on `ubuntu-latest`: a `::warning::` from a task's stdout becomes
  an annotation with no opt-in at all, identically to one from stderr or from the step itself.
  The existing `>&2` redirects are kept — stderr is a fine channel for diagnostics and churning
  them back would buy nothing — but they are a style choice now, not a requirement.

- **devenv observability**: add a lightweight `devenvModules.observability`
  adapter that captures native devenv OTLP/gRPC and effect-utils OTLP/HTTP task
  spans in one isolated otelite trace. Consumers get consistent
  `otel:profile:<name>` / `otel:verify:<name>` tasks and project attribution
  without copying shell/Nix orchestration or importing the full local
  Collector/Tempo/Grafana stack.
  The shared setup module also gains `skipNonInteractive`, removing the need
  for consumers to replace `setup:gate` (and accidentally drop its tracing)
  just to keep non-interactive shell entry cheap.
- **@overeng/ci-tools**: add `ci-tools quarantine validate|announce`, so a repo can hold a
  known-failing test target non-blocking without its required check lying about it. The repo owns
  the ledger contents; ci-tools owns what an entry means — the schema (target, reason, tracking
  issue, expiry), the expiry rule, and the announcement. A malformed `expires` counts as expired:
  comparison is lexicographic, so a free-form string would otherwise sort above every real date and
  turn a typo into a permanent quarantine. `announce` resolves the key against the ledger and
  rejects an entry applied to a target it does not declare, then writes the job-summary line and
  emits the `::warning::` annotation on stdout, the channel GitHub documents for workflow
  commands.
- **npm-release**: New `@overeng/npm-release` package — the decision layer for verifying that an
  npm registry actually serves what a release published. `npm publish` exiting zero does not mean
  the release is live: the version may not have propagated, the served tarball may not be the
  artifact that was packed, or the dist-tag may still resolve to the previous version, so
  `npm install` keeps serving the old release. `registryVerification` classifies those into `ok` /
  `pending` / `mismatch`, separating retryable propagation from terminal disagreement (a published
  npm version is immutable, so a wrong artifact can never become right). Zero dependencies and no
  `effect` peer, following the `@overeng/kdl` / `@overeng/kdl-effect` split — the classification is
  pure logic, testable offline and reusable from any publisher regardless of its runtime or Effect
  major. VRS in `context/npm-release/`. Extracted from three separate hand-rolled implementations
  across livestore and livestore-contrib, two of which were missing the dist-tag check entirely
  (livestorejs/livestore#1504, livestorejs/livestore-contrib#27).
- **devenv-modules**: GitHub workflow commands emitted by tasks now go to stderr. devenv does not
  forward a task's stdout, so `echo "::warning::…"` there never reached the runner — it produced no
  annotation and no log group. That silently affected the two `::notice::` emits in
  `workflow-report` and the `::group::`/`::endgroup::` pairs in `context` and `pnpm`, so CI log
  grouping from inside a task had never worked. Adds `lint:nix:workflow-commands` (wired into
  `lint:nix`) to fail on any unredirected emit under `nix/devenv-modules`, and documents the
  channel in `nix/devenv-modules/tasks/README.md`. Consumers writing their own tasks should apply
  the same rule. Fixes #968.

- **@overeng/megarepo**: `mr apply` now fails when it leaves a pinned member drifted from
  `megarepo.lock`. Previously every path returning `skipped` exited 0, so apply could report
  success over a workspace that disagreed with the lock that produced it — invisible because
  `repos/` is gitignored and `mr:lock-sync-check` compares lock against lock, never workspace
  against lock. Commit and tag worktrees are pinned materializations and now report an error
  naming both revisions; branch worktrees stay a skip, since co-development deliberately moves
  `HEAD` ahead of the lock. The dirty-worktree protection is unchanged — apply still refuses to
  clobber uncommitted work, it just no longer claims success while doing so. Fixes #962; this is
  the root cause behind livestorejs/livestore#1467 and #1168.

- **genie/ci-workflow**: add opt-in megarepo store caching — `applyMegarepoLockStep({ cacheableStore: true })`
  pins `MEGAREPO_STORE` to a stable `cacheableMegarepoStore` path, and reusable
  `restoreMegarepoStoreStep({ skip })` / `saveMegarepoStoreStep({ skip })` (actions/cache keyed on the
  consumer's `megarepo.lock`, partitioned by the `skip` set so a partial store never poisons a full
  job) go around it so CI jobs stop cold-cloning large members (e.g. `effect-ts/effect`)
  every run. The default `jobLocalMegarepoStore` (run-scoped) is unchanged; caching requires the stable
  path because GitHub derives an actions/cache _version_ from the path, so a run-scoped path never
  restores. Validated end-to-end in a consumer (restore hits, one deduped cache). Default behavior for
  existing consumers is untouched.

- **@overeng/megarepo**: make the git subprocess deadline operation-aware. A single flat
  30s bound killed large bare clones (e.g. `effect-ts/effect`, ~140MB pack) that
  legitimately run longer under CI contention, while still needing to stay tight for
  local ops. Network subcommands (`clone`/`fetch`/`pull`/`push`/`ls-remote`) now get a
  generous 10min default, tunable via the single `MEGAREPO_GIT_NETWORK_TIMEOUT_MS` knob;
  local ops keep a fixed 30s bound. Removes the prior flat-era `MEGAREPO_GIT_COMMAND_TIMEOUT_MS`
  knob (its only consumer, the cold-GC test task, no longer needs it). Fixes intermittent
  `git clone ... timed out after 30000ms` failures in downstream consumers (livestore#1473).

- **@overeng/react-inspector v9**: make Effect 4 schema inspection native to
  the public `ObjectInspector`; `schema` remains optional for ordinary values.
  Remove the coexistence HOCs and avoid a permanent Effect-specific adapter
  package. Consumers that still require Effect 3 remain on the independent v8
  release line until they upgrade.

- **@overeng/otel-contract**: add additive, optional per-entry `owner` / `source` /
  `constName` metadata to the `./registry` authoring surface (`AttrDef`, `SignalDef`,
  `WeaverAttrMeta`, every `attr.*` / `span` / `metric` / `operation` builder, plus
  `toAttrDef` and the `fragment` projection). `defineOtelContract` accepts contract-level
  `defaultOwner` / `defaultSource` defaults applied to every projected entry that does not
  override them. `@overeng/genie`'s Layer-1 `AttrDef` / `SignalDef` carry the same additive
  optional fields so the metadata stays typed through `registryFromMembers` composition into
  the registry downstream consumers read; the fields are non-normative to weaver (renderers
  ignore them) so generated YAML/TS/Rust output is unchanged. Fully backward compatible — the
  projected registry is byte-identical for contracts that set none of the new fields.

- **devenv / ts:emit**: move no-check emit to tsgo and split the aggregate
  TypeScript graph into `tsconfig.check.json` for full type-check coverage and
  `tsconfig.emit.json` for emit-capable projects only. This removes the
  `tscBin` task-module argument and the JS TypeScript runtime parser from
  `ts.nix` while preserving noEmit project coverage in `ts:check` (#943).

- **@overeng/utils**: move distributed-lock exports behind the
  `@overeng/utils/lock` subpath so the general isomorphic barrel no longer
  forces lock dependencies on unrelated consumers.

- **react-inspector / Effect 4**: align the development dependency and peer
  floor to Effect `4.0.0-beta.99`, anchor injected test helpers to the separate
  Effect 3 catalog, and fail generation if either cohort's exact identity drifts
  (#937).

- Harden shared CI devenv resolution against host GC races: retry the proven
  invalid-store-path signature once after client-local cache repair, root the
  resolved closure for the job lifetime, and leave Nix daemon recovery to host
  supervision instead of restarting the shared daemon from CI jobs.
- Fix megarepo Nix lock validation for current and legacy members that share one repository while preserving fail-closed ambiguity checks.

### Fixed

- **devenv / ts:emit**: resolve project references with filesystem directory
  checks so dotted directory names map to `tsconfig.json`, and treat an
  all-`noEmit` reference graph as successful no-work instead of invoking the
  compiler with an empty build root.
- **@overeng/utils**: restore the downstream `@effect/platform` patch
  projection in the generated package manifest after vendoring
  `effect-distributed-lock`.
- **@overeng/effect-distributed-lock**: vendor the used non-Redis
  `effect-distributed-lock` subset as first-party source and stop scoped
  semaphore keepAlive refreshes before holder release, preventing file-system
  lock resurrection during `mr store gc`.
- **devenv / pnpm**: separate frozen-install and lockfile-mutation pnpm
  binaries. `pnpm:update` now uses the last verified-safe pnpm 11 lock mutator
  (11.5.1), rejects affected 11.5.2-11.x overrides at Nix evaluation, and
  fails closed with lock restoration if a retained package record loses
  `hasBin`. Root updates also replace the Genie/catalog circular dependency
  with an explicit transaction: generate projections with validation deferred,
  repair the lock, then require full `genie --check` validation.
- **react-inspector / Effect 4**: preserve exact-optional public metadata types
  across Effect 4 schema decoding, and compile the migrated schema surface as a
  strict downstream consumer in the workspace typecheck graph.
- **react-inspector / Effect 4**: align the package's development and build
  runtime with its `^4.0.0-beta.97` peer contract so declarations and tests use
  the same Effect version as LiveStore DevTools.
- **react-inspector / Effect 4**: migrate schema inspection, Lineage annotations,
  and Storybook fixtures to Effect 4. The package now consumes the application's
  Effect 4 instance through a peer dependency instead of bundling a private
  Effect runtime, preventing cross-major schema AST crashes in LiveStore
  Devtools.
- **pnpm / dependency identity**: make pnpm the explicit authority for
  live package dependency edges. Dependency projection and repair may no
  longer invent nested links by scanning the store or choosing a target by
  package name; declared compatibility extensions continue through generated
  `packageExtensions`. Live virtual topology now lives exclusively under each
  Materialization Root's `node_modules/.pnpm`. Repair discards one root-local
  graph and reinvokes its
  canonical pnpm install, eliminating shared graph registries and coordinated
  multi-root repair. The complete disposable pnpm Store Cache may be shared
  inside one same-user trust boundary, but it never owns dependency edges.
  Prepared workspace normalization now relinks injected
  packages only through pnpm's exact locator mapping. Record the mixed Effect 3
  / Effect 4 counterexample and
  add coverage for root-local graph authority and the supported extension path.
  Replace the flat dependency-materialization glossary with a federated
  ontology that separates root-owned state, profile identity, graph authority,
  projections, and storage policy. Remove the unused live profile artifact and
  storage presets; Nix prepared-dependency and Buck2 evidence retain the existing
  `profileKey` compatibility boundary. Remove the GVS-only
  `enableGlobalVirtualStore` and `gvsTypeExtensions` generator APIs.
- **pnpm / cross-worktree cache reuse**: share pnpm's complete disposable Store
  Cache (content-addressed files plus its derived index) across mutually trusted
  local worktrees while keeping GVS disabled and every dependency graph under
  its own root. Let pnpm's native `auto` import policy select clone, hardlink, or
  copy, fail closed on Linux when the cache cannot provide same-device zero-copy
  reuse, keep CI caches job-local, and leave Nix prepared dependencies on their
  independent content-addressed path. Root repair never prunes the host cache;
  focused two-root tests prove zero-download reuse, distinct virtual stores,
  offline rematerialization, native-package isolation, and the explicit
  same-user hardlink trust boundary.
- **devenv cli-guard ownership**: drop the remaining self-consumer
  `lib.lowPrio effectTsgo` / `lib.lowPrio pnpmPkg` boilerplate. Passing
  `tsBinPkg` / `pnpmPkg` to the task modules is sufficient because the guards
  exec the real binaries by absolute store path under passthrough.
- **ci-tools / Vercel**: add first-class production-domain support to the shared
  Vercel deploy path. `ci-tools deploy vercel --production-domain <host>` now
  aliases production deployments to canonical custom domains, reports those
  domains in workflow-report evidence, and uses the canonical domain as the
  final URL for live verification. The devenv Vercel task module threads
  `deployment.productionDomains` through to `ci-tools`, so downstream repos can
  keep custom domains in generated deploy-surface config instead of one-off
  dashboard state.
- **devenv / genie**: replace the shared Genie task module's raw
  `_module.args.geniePkg` / `_module.args.genieInputGlobs` contract with
  declared `effectUtils.genie.package` and `effectUtils.genie.extraInputGlobs`
  options. This keeps packaged Genie consumption on a stable module API and lets
  downstream repos import the module without compatibility shims.
- **genie / bootstrap**: narrow the packaged `genie-bootstrap-closure-check`
  derivation to the checker entrypoint, its first-party runtime sources, Bun,
  and the TypeScript tarball declared by `@overeng/genie`. The checker now walks
  source-tree `.genie.ts` files directly instead of shelling out to Git, and no
  longer goes through the root `mkPnpmCli`/pnpm fixed-output dependency surface,
  keeping the bootstrap proof boundary separate from the normal Genie runtime.
- **genie / bootstrap**: make the shared `bootstrap-closure:check` devenv task
  run a packaged effect-utils checker against the importing repo root via
  `--root`, so downstream repos can reuse the zero-tolerance bootstrap gate
  without carrying local wrapper scripts or relying on ambient Bun/package-manager
  module resolution.
- **notion-cli**: `schema generate <id> -o schema.gen.ts` now writes the file
  again. The `generate` command registered both a file `--output`/`-o` option
  and the shared TUI render-mode option, which also claimed `--output`/`-o`, so
  the render-mode choice validator shadowed the file path and rejected it. The
  TUI render mode on `generate` now uses a distinct `--output-mode` flag (no
  `-o` alias), leaving `--output`/`-o` for the output file. Added a parse-level
  test asserting `-o` resolves to the file path. (`introspect`/`diff`/
  `generate-config` keep the shared render-mode `--output`/`-o`; they have no
  file option to collide with.)
- **megarepo / CI**: refresh the nested `effect` lock to the reachable upstream
  `main` commit so downstream cold `mr apply --all` jobs no longer fail before
  tests with an unavailable locked commit.
- **ci-tools / genie**: fix the mechanically-fixable bootstrap-closure violations
  at the source (this drove the interim baseline from 79 entries down to the 5
  `genie/weaver-registry/*.genie.ts` residual; the baseline is then removed
  entirely by the generator-phase change below). The wide `@overeng/ci-tools`
  barrel (`src/mod.ts`) `export *`ed the runtime `./deploy-*` encoders alongside
  the bootstrap-safe workflow-report constants/types, so genie helpers importing
  the safe symbols dragged `effect` into their bootstrap closure (73 violations);
  the safe surface is extracted into a new dependency-free
  `ci-tools/src/workflow-report.ts` (re-exported by `mod.ts`, so runtime
  consumers are unaffected) and the genie helpers repointed there. Separately,
  `tsconfig.all.json.genie.ts` imported the wide `@overeng/genie/node` barrel
  (which re-exports the `typescript`-importing closure walker), now narrowed to
  the bootstrap-safe `node/tsconfig-from-packages.ts` module (1 violation). The
  5 weaver-registry generators reach `effect` because the OTel semconv contracts
  are Effect-Schema by design and render post-install; decision 0004 classes them
  `design-time` (out of the bootstrap-closure scope by declaration, not baseline).
- **CI / cargo**: move standalone Rust crate build/test/clippy/fmt semantics into
  the `cargo:check` devenv task and make the generated cargo CI lane call that
  task, ensuring the `node-cpuprofile` integration test runs with the devenv
  Node toolchain instead of a Rust-only CI PATH.
- **devenv / lint**: mark the `check:*:trace` wrappers as intentionally raw
  `otel-run` entrypoints for the trace audit, and apply the repo formatter to the
  OTEL/Vitest context docs.
- **devenv / lint**: make `devenv:trace-audit` self-contained by referencing its
  Nix-provided scanner and marker-check binaries instead of relying on ambient
  `rg`, `head`, `tail`, or `grep` in `PATH`.

### Added

- **genie / weaver**: TS constants generation now exports prefixed
  `METRIC_*` and `SPAN_*` name constants, plus `MetricName` and `SpanName`
  unions, so telemetry producers can import generated names without colliding
  with existing unprefixed attribute-key constants.
- **genie / check**: bootstrap-safe import-closure gate (`bootstrap-closure:check`).
  A `.genie.ts` and everything it transitively imports at RUNTIME must be importable
  from a fresh checkout BEFORE install; a generator that reaches a runtime-only
  package (e.g. through a wide barrel that `export *`s a module importing `effect`)
  breaks `genie:run` on a fresh clone. The shared `checkBootstrapClosure` walker
  (reusing TypeScript's parser/resolver plus genie's own `#`/`#mr` resolution, and
  excluding type-only edges) is exported from `@overeng/genie/node`; a bun entry
  (`genie/ci-scripts/bootstrap-closure-check.ts`) runs it over the tracked
  `// @genie-bootstrap`-marked `.genie.ts` sources with ZERO TOLERANCE (no baseline,
  no allowlist — `design-time` generators are out of scope by declaration; see the
  generator-phase entry below). Wired into `check:all` (not `check:quick`). The walker imports
  genie's resolver via the effect-free `core/import-map/sync-resolver.ts` (only
  `node:fs`/`node:path`), so it is itself importable pre-install (`typescript` +
  node builtins only) and usable by nix-packaged-genie downstream members.

- **genie / bootstrap**: generator phase + empirical cold-proof (decision 0004,
  issue #884). Each `.genie.ts` declares its phase with a valueless `// @genie-bootstrap`
  flag comment (mirroring `@ts-nocheck` grammar; `design-time` is the default, no
  marker), read statically without importing the generator. `genie --phase bootstrap`
  restricts a run to the marked set (the 35 `package.json.genie.ts` + `pnpm-workspace.yaml.genie.ts`).
  Bootstrap-safety is now **demonstrated, not asserted**: `bootstrap:cold-proof`
  (`genie/ci-scripts/bootstrap-cold-proof.sh`, devenv task + CI lane) builds the
  self-contained packaged Genie CLI (`.#genie`, deps baked into the store), runs
  `genie --phase bootstrap` in a fresh `node_modules`-free `git archive` tree, then
  `pnpm install --frozen-lockfile`, asserting both succeed and that the marked set
  actually ran. `bootstrap-closure:check` stays as fast local feedback in `check:all`.
  Supersedes the interim `genie:bootstrap`-before-`pnpm:install` task edge, which
  arbitrated nothing (source-mode genie can't run cold; committed outputs satisfy
  install regardless) and is removed.
- **devenv / otel**: `otel-run` — a `time`-like wrapper that runs any command
  under a fresh root trace and prints its Grafana URL. Derives the root label
  from argv (`devenv tasks run X` → `X`), mints a fresh trace id (`--join` to
  nest in the ambient trace instead), and **probes for a reachable OTLP endpoint**
  (the configured one, then the local ingress) so spans actually land instead of
  hitting a dead devenv-local collector. Plus `check:quick:trace` /
  `check:all:trace` tasks (`otel-run devenv tasks run check:quick|all`) — so
  getting a trace URL for a check run is a one-liner.
- **otel-scrape**: `deadnix` adapter (`src/adapters/deadnix.rs`) — a diagnostics
  adapter over `deadnix --output-format json` (NDJSON), mirroring oxlint. Dead-code
  findings become public-safe events (hashed filename + line; symbol names, paths,
  and columns never reach a sink) plus a `deadnix.findings` count; otel-scrape
  re-renders a human summary. Wired onto `lint:nix:deadcode`. Added purely as a
  module + registry entry (no `lib.rs` dispatch change), exercising the adapter
  framework.
- **otel-scrape**: adapter fleet VRS under `context/otel-scrape/adapters/` — the
  supported/candidate matrix, per-adapter requirements+spec leaves (oxlint,
  pnpm, deadnix, nix, vitest, node-cpuprofile) with source-of-truth references,
  and the fleet audit decisions.
- **devenv tasks**: `lint:check:format` (oxfmt) and `lint:nix:format` (nixfmt)
  opt into otel-scrape as `adapter="none"`, so each emits a timed, named command
  span beneath its task span when traced (bare otherwise). Behavioral test
  `otel-scrape-oxfmt-wrap.test.sh` covers the `mkLintExec` nested-`sh` wrap.
- **otel-scrape**: Root trace surfacing (decision 0020, R31). When `otel-scrape`
  mints the trace root and telemetry is active, it prints the trace identity to
  stderr at end of run so agents and humans can open or correlate the trace
  without querying the backend first. With `--trace-url-template <tmpl>` /
  `OTEL_SCRAPE_TRACE_URL_TEMPLATE` (a backend-agnostic `{traceId}` placeholder
  template) and a successful export it prints a resolvable link; otherwise it
  prints the bare `trace:<id>`. OSC 8 hyperlink on a TTY, plain text when piped.
  Terminal-only — never written to the summary or OTLP sinks. Bound to export
  success, not the child exit code. Pure passthrough stays silent (R04);
  `--trace-link off` / `OTEL_SCRAPE_TRACE_LINK=off` disables it.

- **Buck tui-core editor view**: expose the canonical Stage-1 descriptor and add scoped, fail-closed hardlink snapshot publication and validation without rewiring global consumers or removing the root pnpm install.
- **oxc-config Nix package**: expose the prepared pnpm dependency boundary, source-owned hash metadata, and Evergreen FOD graph under the canonical `oxc-config` flake package.
- Add an evidence-derived pnpm 11.8 deploy-tree normalizer that removes nondeterministic metadata, rewrites absolute command shims, prunes dangling dependency links, and fails closed on residual staging paths or symlinks.
- Record an aarch64-linux Buck-owned Vite development-launch experiment proving
  exact closure launch, live local and workspace HMR, external writable caches,
  concurrent instances, signal teardown, restart, and zero application-local
  `node_modules`, while keeping Vite transformation and process supervision as
  separate authorities.
- Harden dynamic ELF metadata boundaries, inspector failures, and artifact-seam
  mutation proofs, including structural dependency delimiters, version-need
  sections, fixed-marker `PT_INTERP` paths, and whitespace-bearing version
  names.
- **Buck2 gate hermeticity**: resolve every external tool invoked by the
  capability-projection, projection-test, and foundation graph-check gates via
  explicit `_BIN` bindings exported from Nix store paths instead of ambient
  `PATH` lookup, and retain Buck stderr evidence when the foundation
  platform-mismatch audit fails so the rejection reason stays diagnosable.
- **Buck2 platform-mismatch proof**: run the local-only host rejection gate as a
  disposable-probe script instead of against the shared repository tree. The
  probe builds a throwaway Buck project outside the repository (an ancestor
  `.buckconfig` otherwise claims the project root), projects simulated
  aarch64-linux executor capabilities into it from the exact Nix stage0
  realizations, and asserts that analyzing a package target declared
  `x86_64-linux` under `--fake-arch aarch64` fails with the exact package_task
  mismatch diagnostic before any action executes, retaining stderr evidence on
  any other outcome.
- **Buck2 foundation identity**: keep the executor-capability cell at a stable
  daemon-visible path with immutable generations, prove same-daemon capability
  invalidation, and make root provider loads explicit across cells. Model the
  affected Genie and CI tools prepared-dependency snapshots as platform-neutral;
  exact aarch64-linux Genie realization remains pending.
- **@overeng/notion-md**: `track <page> <existing-directory>` now materializes a
  remote-authoritative child-page tree as separate `.nmd` files plus an authority-tagged workspace
  manifest. Non-recursive directory status plans the same tree engine; ordinary directory sync
  refreshes content and reconciles recorded additions, page-ID moves, and deletions only across
  manifest and frontmatter-proven ownership. Dry-run validates every remote node without writing,
  and a different root cannot repurpose an established workspace. Child placeholders become
  relative local navigation links without entering the remote push baseline, while local-authority
  user links remain authored content. Hierarchical tree watch is rejected; `--recursive` remains
  flat file watch. Unicode titles produce stable ASCII paths with German umlaut transliteration.
  File and missing-path tracking is unchanged.

- **genie semantic-conventions generator (M1) / @overeng/genie + @overeng/otel-contract**:
  First genie generator for OpenTelemetry semantic-convention registries.
  - Layer 1 (`@overeng/genie` `src/runtime/weaver`, dep-free): a faithful typed model of the
    Weaver `groups:` registry + deterministic renderers (manifest / attributes / signals YAML,
    TS + Rust name constants) using genie's own YAML stringifier. `registryFromMembers` +
    `orphanSeamPaths` land in `@overeng/genie/composition`.
  - Layer 2 (`@overeng/otel-contract` new `./registry` subpath): Effect-Schema authoring
    (`attr`/`span`/`metric`/`operation`, `defineOtelContract`, the AST→fragment projector) atop
    the runtime primitives, with derived namespace + catalog, `refExternal` foreign-ref marking,
    and `Schema.TaggedError` author-time validation. Verified out of the runtime `.` bundle.
  - Weaver gate: `weaver:check` devenv task (wired into `check:all` + a dedicated CI lane) runs
    `weaver registry check --future` (pinned from-source flake, v0.24.2) against the emitted
    registry, resolving the pinned upstream OTel semconv (v1.37.0) hermetically via a Nix FOD.
    Block-vs-degrade: validation failures block; weaver unavailability degrades to a warning.
  - Provenance: per-file input fingerprint (sha256 over registry source + generator + pinned
    weaver + pinned upstream semconv), split so doc-only edits re-hash only the YAML outputs.
  - `overeng/otel-contract-in-seam-file` oxlint rule (WARN-only) + the no-orphan-seam aggregator
    check make contract discoverability structural (decision 0005).
- **genie semantic-conventions Rust target (M2) / @overeng/genie**: Finalized the Layer-1 Rust
  emitter (`renderRustConstants`) for Rust telemetry _producers_ (decision 0007). Emits idiomatic,
  deterministic (sorted), rustfmt-clean const modules — separate `attribute` / `span` / `metric`
  modules (collision-proof by construction) with a `pub const <SCREAMING_SNAKE>: &str` per name
  plus an `ALL: &[&str]` slice — covering own attribute keys, span ids, and metric names. Wired one
  committed `.rs` output (`genie/weaver-registry/constants.rs`) via `constants.rs.genie.ts` alongside the
  TS constants, with a dedicated Rust-identity fingerprint (attr keys + span ids + metric names) so
  a signal rename re-hashes only the `.rs` and a doc-only edit churns neither binding. Proven by a
  synthetic ~25-name `otel_scrape.*` fixture (authored via the real Layer-2 seam) with a test
  asserting determinism, full name coverage, and valid/rustfmt-clean Rust (rustc + rustfmt,
  skip-if-absent).
- **genie semantic-conventions first-namespace migration (M3) / @overeng/genie**: Migrated genie's
  OWN telemetry (the `genie.*` namespace, 12 attribute keys + 8 span operations) fully onto the
  registry seam. A new `packages/@overeng/genie/src/core/genie.contract.ts` authors the catalog +
  operations via the Layer-2 `@overeng/otel-contract/registry` surface; `src/core/observability.ts`
  is re-pointed at the DERIVED `OtelOperation` product APIs (SC-R13/R14) with emit behavior
  unchanged (same keys, encode, span names, and the `genie/command` root span, preserved via
  `.withRoot`). Registered in the root aggregator's `memberSeamPaths`; the composed registry now
  emits `genie.attributes.yaml` alongside `acme` and passes `weaver registry check --future`.
  Encoder equivalence is raised from `deepStrictEqual` to a **property-based** proof through the
  real `OtelOperation` surface (`@effect/vitest` `it.prop` + `Schema` arbitraries over the
  optional/label branches). `overeng/otel-contract-in-seam-file` is flipped to **ERROR** for
  genie's telemetry paths (rest of repo stays WARN; staged per decision 0005). The dynamic-name
  `cli.mode` root span (`genie/<cliMode>`, a foreign `cli.*` namespace) stays a documented legacy
  inline op — no stable single-signal projection — deferred to a future `cli` namespace member.
- **genie semantic-conventions evolution gates (SC-R11, SC-R12) / @overeng/genie**: Two additive
  weaver gates alongside `weaver:check`. `weaver:diff` (SC-R11) runs `weaver registry diff` against
  the `origin/main`..`HEAD` merge-base baseline (materialized offline via git, upstream held
  constant) and blocks a PR that REMOVES a shipped attribute/signal; it is JSON-payload based
  (`--format json`, block on `changes.*[].type == "removed"`) because `weaver registry diff` exits
  0 even for breaking changes. A rename recorded weaver-native — old key retained + `deprecated:
{ reason: renamed, renamed_to }` — surfaces as `type: "renamed"` and passes with no custom gate
  logic (decision 0009). `weaver:live-check` (SC-R12) captures registry-conformant OTLP emitted
  from a first-party site and asserts `weaver registry live-check` accepts it. Both degrade to a
  warning when weaver/git is unavailable (GEN-R09); `weaver:diff` joins `check:all`, `live-check`
  runs in the CI `weaver` lane only (subprocess/timing e2e).
- **genie semantic-conventions rename representation (decision 0009) / @overeng/genie**: Attribute
  renames use the weaver-native `deprecated: renamed_to` form (retain the old key marked deprecated
  for a dated sunset window), empirically chosen over a drop-old-key `deprecatedAlias.was` shape
  because `weaver registry diff` classifies the former as a native `type: "renamed"` and the latter
  as a breaking removal (`.experiments/2026-07-03-weaver-rename-diff.md`).

### Fixed

- **otel-scrape**: Export spans when `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`
  is requested instead of disabling export. The OTLP/HTTP receiver routes by
  request `Content-Type` (not the client's protocol env), and `/v1/traces`
  accepts `application/json`, so otel-scrape now sends its JSON payload and
  prints a `note:` rather than `trace export is disabled`. `grpc` stays disabled
  (a genuinely different transport this HTTP/JSON exporter cannot speak). This
  unblocks adapter spans reaching the collector in the fleet's protobuf-configured
  environments.
- **devenv tasks**: `lint:check:format` no longer fails when run under tracing.
  `mkLintExec`'s empty-selection swallow keyed on an exact stderr match, which the
  otel-scrape wrapper's own stderr line broke for an all-ignored batch. The swallow
  now keys on oxfmt's exit code 2 **and** the diagnostic substring — robust to any
  extra wrapper stderr — so a genuine parse error (exit 2, no diagnostic) and a
  formatting diff (exit 1) still fail. (Also corrects the old exact-match, which
  never matched real oxfmt's longer message.)

### Changed

- **@overeng/notion-cli**: Default generated Notion relation properties to
  `relationIds` even when Notion reports `single_property` relation metadata.
  Explicit single-relation transforms remain available through transform
  configuration for schemas that intentionally require scalar cardinality.

- **otel-scrape**: Refactored the adapters into a per-tool module framework
  (`src/adapters/`): a `ToolAdapter` trait + `ADAPTERS` registry, with oxlint,
  vitest, and node-cpuprofile each in their own module. `lib.rs` dispatch is now
  registry-driven (`adapter_for(...).map_or(...)`) with no per-adapter-name
  `match`; injection is dynamic via `prepare`/`AdapterPrep` hooks. Adding an
  adapter is now one `src/adapters/<tool>.rs` + one `ADAPTERS` entry + registry
  JSON, so adapters can be developed and maintained in parallel. Pure
  behavior-preserving restructure — `tests/cli.rs` output byte-identical.
- **otel-scrape / devenv**: Make effect-utils' own devenv tasks cooperate with
  the trace model (decision 0018). The task span (`otel-span devenv.task.exec` /
  `devenv.task.status`) owns the task level; the blanket per-task `otel-scrape`
  wrapper is removed (it produced one meaningless generic `bash` span above every
  real task span). A new `trace.instr { adapter ? "none"; name; }` helper wraps a
  clean concrete command BENEATH the task span, yielding a named command span
  (`tsgo`, `oxlint`, `node`, ...). Adapters fire where the structured-source
  contract (decision 0017) is met: oxlint is instrumented `adapter=oxlint` with a
  presence-gated `--format=json` (otel-scrape re-renders a human summary), vitest
  `adapter=vitest` (side-channel; human reporter output preserved), and tsc/tsgo
  `adapter=none` (compiler-only wrap keeps the honest `tsgo` span name with the
  TypeScript phase spans as task-siblings). The `trace.instr` arrays are empty when
  otel-scrape is absent, so downstream repos importing these modules run unchanged.

- Refined `otel-scrape` VRS and release docs for helper-backed exact process observation, including Linux cgroup-scoped run authority, macOS Endpoint Security validation gates, and runner-class support-matrix evidence.

- **genie semantic-conventions encoder-equivalence proof — consolidated / @overeng/otel-contract**:
  Retired the 13 per-namespace `*.observability.equivalence.unit.test.ts` bridges in favor of one
  strengthened mechanism proof over the `./registry` seam (`registry.unit.test.ts` +
  `registry-equivalence.property.unit.test.ts`), covering the union of encoder shapes (enum /
  template / optional / redacted / json / drop, metric-label rejection, requirement-level
  projection). Genuinely-unique non-equivalence assertions (genie's trimmed `span.label` +
  non-finite rejection) are preserved in a new `genie/src/core/observability.unit.test.ts`.

- **@overeng/megarepo tests**: Disable Git auto-maintenance in the hermetic
  test gitconfig so detached `git maintenance run --auto` processes cannot race
  scoped temp-directory cleanup on macOS CI.

- **genie semantic-conventions registry — genie-idiomatic emit + relocation / @overeng/genie**:
  Reworked the first-party registry to a builder-per-target API and moved it under `genie/`.
  - New dep-free `weaver*` builder family in `@overeng/genie` `src/runtime/weaver`
    (`weaverManifest` / `weaverAttributes` / `weaverSignals` / `weaverTsConstants` /
    `weaverRustConstants`) over a `WeaverRegistryBundle` (composed registry + the three split
    provenance fingerprints + whole-registry integrity issues). Each `.genie.ts` emitter is now a
    one-liner over the aggregator's exported `weaver` bundle; `weaverManifest` surfaces
    namespace-uniqueness / dangling-ref issues via `validate` so `genie:check` still blocks.
  - Collapsed the per-namespace `<ns>.attributes.yaml` emitters into a single `attributes.yaml`
    (new `renderAttributes` emits all groups as multiple `attribute_group` entries in one file).
    Adding a namespace no longer needs a new `.genie.ts`. The fixed emitted set is now
    `{manifest, attributes, signals}.yaml` + `constants.{ts,rs}`.
  - Moved the registry directory `weaver-registry/` → `genie/weaver-registry/` (updated the
    `weaver:check` task `registryDir`, its YAML copy glob, the no-orphan-seam test path, the
    oxlint ignore glob, and `REGISTRY_SOURCE`). Emitted YAML/TS/Rust content is unchanged apart
    from the `registry-source:` provenance-header path (fingerprints are identical).

- **devenv deploy tasks / @overeng/ci-tools**: Centralize deploy-preview
  workflow-report and GitHub output emission in `ci-tools`, including
  provider-owned skip records, URL outputs, and task metadata, so generated CI
  delegates deploy behavior through devenv tasks.

- **devenv deploy tasks / @overeng/ci-tools**: Keep manual CI runs from failing
  the Netlify deploy job when no deploy branch runs, and capture verbose Vercel
  CLI output with an explicit buffer.

- **devenv deploy tasks / @overeng/ci-tools**: Remove the obsolete Nix deploy
  metadata and alias helpers now that `ci-tools` is the single workflow-report
  record authority.

- **devenv workflow-report tasks / @overeng/ci-tools**: Add reusable
  `workflow-report:*` devenv tasks for bundle collection, comment rendering,
  and PR comment publication, and regenerate CI to delegate deploy-preview
  reporting through those tasks.

- **devenv deploy tasks / @overeng/ci-tools**: Move Vercel build-mode
  `vercel pull` / `vercel build` orchestration, root-directory patching,
  temporary install-command overrides, and prebuilt output validation into
  `ci-tools deploy vercel`, leaving the devenv task as thin config delegation.

- **devenv deploy tasks / Nix**: Package the Netlify and Vercel provider CLIs
  as first-party fixed-output npm derivations (`netlify-cli` 26.1.0 and
  `vercel` 54.18.5) and make shared deploy tasks default to those store paths
  instead of runtime `bunx`/stale nixpkgs CLI resolution.

- **devenv deploy tasks / Nix**: Trim the Netlify and Vercel provider CLI
  derivations by installing and pruning their npm package graphs without
  optional dependencies and skipping dependency rebuild scripts during
  packaging.

- **CI**: Collapse guarded live Netlify and Vercel deploy E2Es into one shared
  live deploy job with common setup.

- **@overeng/genie**: Validate documented GitHub Actions limits for static
  matrix expansion, check runs per check suite, and explicit job timeouts.

- **@overeng/genie**: Fail generated GitHub workflow validation above the
  observed 512 KiB Actions admission limit and warn when workflows approach it,
  so oversized workflows are caught by `genie:check` before GitHub silently
  skips PR runs.

- **genie/ci-workflow**: Move the Nix transient-failure retry implementation
  out of generated workflow YAML and into checked-in CI scripts, keeping
  `runDevenvTasksBefore(...)` as the Genie composition API while shrinking the
  generated CI workflow well below GitHub's admission limit.

- **genie / GitHub rulesets**: Require every non-advisory generated CI lane in
  branch protection, including default-ref, bundle smoke, cargo, CI
  measurement, and integration lanes, while keeping reporting-only jobs
  advisory.

- **devenv test tasks**: Bound package test fanout while preserving
  package-specific prerequisites, so native-link setup is preserved without
  re-entering Devenv's upstream task graph in parallel.

- **devenv test tasks / @overeng/megarepo**: Give the isolated cold-GC
  integration task explicit Vitest timeout headroom and per-test timing output
  for slow CI runners while keeping the package-wide default timeout unchanged.

- **nix packages / @overeng/genie**: Refresh the Genie, Megarepo, TUI Stories,
  and Notion MD pnpm-deps fixed-output hashes and keep the native dependency
  policy audit install-free by splitting the policy into a lightweight module.

- **tests**: Give repo Vitest tasks and `@overeng/ci-tools` process-spawning
  E2Es CI timeout headroom, and keep the pty-effect roundtrip fixture alive
  long enough for loaded Linux runners to attach reliably.

### Added

- **otel-scrape**: Complete `span.cli` semantic-convention conformance
  (decision 0016, M25.1): emit the REQUIRED raw `process.pid` (never hashed,
  not trust-gated); set `error.type=_OTHER` and a bounded, non-sensitive span
  `Status.message` (`process exited with code <n>` / `process terminated by
signal <NAME>`) on non-zero exit; bound `process.executable.name` / the span
  name via a documented low-cardinality derivation (safe-charset basename,
  nix-store hash prefix stripped, pathological names collapsed to `<binary>`);
  derive span end time from a monotonic nanosecond delta so fast commands are
  no longer zero-width or whole-millisecond-quantized; and set the
  instrumentation-scope `version` plus a default resource `service.version` to
  otel-scrape's crate version.

- **otel-scrape**: Correlate traces to a build and enrich adapter events
  (decision 0019, H5). Derive a `machineVersion` (`<version>+<rev>[-dirty]`)
  from a flake-injected `CLI_BUILD_STAMP` (following the shared build-identity
  contract in `@overeng/utils` `cli-version`) and emit it as the
  instrumentation-scope `version`, the default resource `service.version`, and
  `telemetry.sdk.version` — superseding the bare crate version so a trace ties
  to a commit — and print it from `--version`. Add
  `schema_url=https://opentelemetry.io/schemas/1.37.0` on the resource and
  scope. The oxlint adapter event now carries the public `rule` id and `line`
  in both the OTLP and summary sinks (the filename stays hashed). The default
  `service.version` is gated on `service.name` being otel-scrape's own default,
  so a user/harness `--service-name` (or `OTEL_SERVICE_NAME`) no longer has
  otel-scrape's build stamped onto its service identity.

- **otel-scrape**: Add the per-named-sink command-identity trust gate
  (decision 0015): `--trusted-sink otlp|summary` (repeatable; env alias
  `OTEL_SCRAPE_TRUSTED_SINK` pinned to the OTLP target only) emits raw
  `command.argv`/`command.cwd` into the named sink alone. The default stays
  hashed-only and the local summary is hard-public-safe — an OTLP assertion
  never covers it. A byte-level non-leak regression test enforces the
  invariant.

- **@overeng/content-address**: Add filesystem-backed CAS primitives with
  descriptor-addressed writes, `cas:` URI resolution, canonical JSON manifests,
  and validated manifest pins as local retention roots.

- **otel-scrape**: Add the initial Rust crate skeleton with passthrough command
  execution, W3C `traceparent` root-or-join propagation, stable hashed command
  evidence, file-only JSON summaries, flake/devenv wiring, and cargo CI gates.

- **otel-scrape**: Add a generated telemetry registry with a JSON source of
  truth and Rust/TypeScript projections for wrapper schemas, span names,
  attribute keys, and profile fields.

- **otel-scrape**: Add the first real adapter slice for `oxlint --format=json`,
  preserving stdout while recording diagnostic events and a generated
  `oxlint.diagnostics` metric in summary evidence.

- **otel-scrape / @overeng/otel-contract**: Add CAS-backed profile artifact
  links, a reusable `OtelScrapeProfileLink` schema, and CLI support for writing
  profile blobs, run manifests, and pins under an explicit CAS root.

- **otel-scrape**: Add the `node-cpuprofile` adapter, which enables Node/V8 CPU
  profiling for wrapped Node commands, validates produced `.cpuprofile`
  artifacts, stores them through the CAS lane, and emits sanitized profile-link
  evidence.

- **otel-scrape / @overeng/otel-contract**: Add a consumer-neutral E2E fixture
  that captures a real `node-cpuprofile` wrapper run through `otelite`, decodes
  the emitted profile link with the TypeScript contract, and resolves the
  linked artifact from CAS.

- **otel-scrape**: Document the current stable CLI surface, summary/export modes,
  adapter support policy, CAS artifact handoff, privacy guarantees, and current
  support matrix, including the explicit non-claim for release-grade descendant
  process-tree spans until exact backend validation lands.

- **otel-scrape**: Add the public VRS for an effect-utils-owned process wrapper
  that turns build/dev tool executions into OTEL spans, events, metrics, and
  content-addressed profile links.

- **otel-scrape**: Add explicit degraded direct-child process observation
  evidence in summary JSON and OTLP export, including a validation fixture that
  proves descendant workloads are not reported as release-grade process trees.

- **otel-scrape**: Add an opt-in Linux `ptrace-experimental` process backend
  that observes fork/vfork/clone, exec, and exit events for a traced child tree
  and validates exact descendant evidence with a compiled process-DAG fixture.

- **otel-scrape / devenv**: Wire `otel-scrape` into effect-utils devenv
  task execution, status checks, Storybook processes, Netlify/SecretSpec tasks,
  and aggregate gates via the shared `trace.nix` task wrapper. Local task runs
  now write summary evidence under `tmp/otel-scrape/summaries` by
  default and `check:*` runs a source audit to catch new unwrapped task scripts.

- **otel-scrape**: Document the adapter admission policy and exact process
  helper boundary. New build-tool adapters stay rejected until they land as a
  vertical slice with a structured source contract, passthrough preservation,
  privacy and degraded-mode tests, classification justification, generated
  contract updates, and consumer evidence for cross-package/profile contracts.
  Default exact process-tree support remains helper-gated rather than ptrace or
  sampled snapshots.

- **otel-scrape**: Add the wrapper-side `helper-stream` process backend contract,
  including `--process-helper-socket` / `OTEL_SCRAPE_PROCESS_HELPER_SOCKET`
  parsing and fail-closed degraded evidence until a validated privileged helper
  stream proves exact lifecycle coverage.

- **otel-scrape**: Implement the `helper-stream` NDJSON parser and fake-helper
  E2E contract tests. Exact process evidence now requires a complete,
  same-run, version-matched lifecycle stream; helper loss, sequence gaps,
  run-id mismatch, version mismatch, timestamp/order violations, multiple roots,
  disconnects, and incomplete lifecycle data degrade explicitly.

- **otel-scrape**: Support the official OpenTelemetry trace-export environment
  variable surface for the first-party OTLP/HTTP JSON exporter, including
  trace-specific endpoint precedence, resource attributes, service-name
  precedence, headers, timeout, SDK/exporter disable flags, and explicit
  unsupported-protocol handling.

- **@overeng/utils-dev / @overeng/megarepo**: Add reusable `otelite`
  trace/metrics/log diagnostic JSON writers and make store fixture setup emit
  typed OTEL spans through the production bounded git runner, so CI fixture
  stalls can produce inspectable trace evidence.

- **@overeng/genie**: Document the intended package export type-proof
  architecture: strict proofs should use an explicit compiler executable
  boundary (`tsgo` by default, custom only by explicit override) instead of
  dynamic TypeScript module imports or staged `node_modules` plumbing.

- **context/ci-tools**: Start the issue #868 VRS kickoff by restoring the
  non-protected CI tools spec/glossary/source-of-truth decision and recording a
  Phase 0 deploy-preview inventory note for workflow-report, Netlify, and
  Vercel migration surfaces.

- **@overeng/workflow-report**: Add a hermetic CLI E2E test that runs the real
  `workflow-report` entrypoint through Bun, collects marked deploy-preview
  records, renders managed comment output, and finds the managed comment ID
  through file-based CLI boundaries.

- **devenv deploy tasks**: Add fake-provider E2E coverage for the generated
  Netlify and Vercel deploy task scripts, proving PR aliasing, task output
  metadata, workflow-report record emission, Vercel prebuilt static packaging,
  Netlify diagnostic behavior, malformed provider output failures, missing PR
  input failures, and missing local static output failures without real provider
  credentials.

- **@overeng/ci-tools**: Hard-rename the workflow-report CLI package and Nix
  flake output to `@overeng/ci-tools` / `#ci-tools`, keeping the report helpers
  under the `ci-tools workflow-report ...` command surface and regenerating CI
  to call the new binary boundary.

- **@overeng/ci-tools**: Add the first deploy domain model with versioned
  Effect schemas for deploy inputs/results, tagged deploy failure taxonomy,
  retryability derivation, redacted workflow-report record builders, and
  privacy/cardinality-safe OTEL span attribute metadata for deploy operations.

- **@overeng/ci-tools**: Add the Phase 3 Netlify provider adapter with typed
  command-runner boundaries, schema-decoded deploy JSON, guarded live E2E
  aliases, redacted failure classification, and fake-runner coverage for
  unauthorized, missing-project, malformed-output, and aliased deploy paths.

- **@overeng/ci-tools**: Add a guarded live Netlify E2E that deploys a local
  static fixture through `ci-tools deploy netlify`, verifies marker content on
  the served alias, records cleanup status, and runs in CI only when Netlify
  secrets are available.

- **@overeng/ci-tools**: Add the Phase 4 Vercel provider adapter with API-first
  project diagnostics, local Build Output API static packaging, prod/PR/preview
  alias semantics, redacted failure records, fake-provider E2E coverage, and a
  guarded live E2E that verifies served marker content through Vercel's
  automation protection-bypass header and records best-effort alias cleanup.

- **devenv deploy tasks / @overeng/ci-tools**: Move shared Netlify and Vercel
  deploy tasks onto thin `ci-tools deploy ...` launchers, add task-output
  environment metadata for deploy URLs, preserve Vercel build-output deploy
  mode, and cover the task scripts through real-CLI E2E fixtures with fake
  provider endpoints.

- **context/ci-tools / @overeng/ci-tools**: Restore the CI tools vision and
  requirements VRS documents, update the spec for the current task-output,
  CLI-output, and provider-boundary contracts, and move provider API lookup plus
  live verification HTTP calls onto the Effect platform `HttpClient`.

- **@overeng/genie**: Add the explicit `@overeng/genie/composition` subpath for
  reusable cross-artifact composition helpers. The first helper,
  `tsconfigReferencesFromPackages`, projects TypeScript project references from
  package workspace metadata while keeping `tsconfigJson(...)` as a thin
  artifact builder.

- **@overeng/megarepo / CI**: Isolate the cold named-branch GC integration
  matrix into its own CI task and add deterministic git subprocess timeouts
  with OTEL `git.timeout_ms` span attributes so stuck GC probes fail with the
  offending command instead of Vitest's generic per-test timeout.

- **@overeng/megarepo / devenv tasks**: Add an explicit `--lock-sync` policy
  to `mr apply` / `mr fetch --apply`, including `--lock-sync off` for
  non-mutating workspace materialization, and add a shared `mr:setup` devenv
  task that applies committed root members without fetching remotes or rewriting
  lock files. `mr:check` now depends on `mr:setup` and points missing-member
  repair hints at setup instead of the lower-level `mr:apply` task. Source-mode
  repo wiring now orders `mr:setup` after package installation like the other
  megarepo tasks.

- **@overeng/genie**: Add package-json-owned export environment contracts for
  JavaScript package entries. `exportEntry(...)` attaches non-emitted runtime
  and type-level environment metadata to generated package exports, while the
  package-json validator owns the Node-only static import/global scanner,
  strict TypeScript proof, and cache-backed fast path for constrained
  environments such as Node, browsers, Workers, Workerd, and React Native.
  Contracts now cover the repository's package exports, including conditional
  browser/node entries and patterned source exports, replacing the previous
  one-off Genie entry-purity test.

- **@overeng/genie**: Add an opt-in package-json export contract coverage
  policy. `definePackageJson({ validation })` can now bake warning/error
  pressure into a repo's package-json generator, while per-call options remain
  available as overrides. The policy reports package exports that are not
  annotated with `exportEntry(...)`, supports glob ignores for staged
  migrations, reuses Genie validation warnings, and stays package-json-owned so
  shared repos can migrate toward JavaScript environment contracts without
  adding Genie core semantics. effect-utils' internal Genie surface now uses the
  configured generator in warning mode.

- **@overeng/genie / CI**: Add the `githubWorkflowEvent.all` trigger sentinel
  so GitHub workflow generators can request an unfiltered event without raw
  `null` in authoring code. The main CI workflow now uses it to run for pull
  requests targeting any base branch, while keeping push CI restricted to
  `main`.

- **@overeng/megarepo, @overeng/tui-stories**: Refresh stale fixed-output
  dependency hashes after the stacked PR workflow/API change altered prepared
  dependency closures.

- **devenv/lint-oxc**: Make `lintPaths` the single lint surface contract.
  oxlint/oxfmt tasks now enumerate tracked plus untracked non-ignored files via
  `git ls-files` and always run instead of delegating change detection to
  devenv's `execIfModified` glob walker. The shared lint module is kept
  repo-agnostic; effect-utils-specific source policy checks live in local task
  modules. Per-tool file filters include the broader Oxc-supported extension
  sets, including `.mts`/`.cts` for oxlint and additional oxfmt-supported
  formats such as JSON5, SCSS/Less, MDX, GraphQL, and Handlebars.

- **devenv task-module tests**: Add a dedicated `devenv-modules:test` task for
  shell tests colocated under `nix/devenv-modules/tasks/shared/tests`, and wire
  it into `test:run` so shared task-module regressions run in the normal CI unit
  test job.

- **@overeng/notion-effect-client**: Add `NotionMarkdown.markdownToBlocks`,
  an AST-based selected-GFM Markdown importer that emits Notion append/create
  block payloads for paragraphs, headings, dividers, lists, task lists, code,
  quotes, and tables. The importer shares the same Notion-flavored remark/GFM
  setup as canonical Markdown so downstream packages can delete hand-rolled
  Markdown parsers and consume one block-payload contract.

### Fixed

- **otel-scrape**: Preserve the wrapped command's exit code when optional
  summary file writing fails after the child process exits, while still
  reporting the summary write failure on stderr.

- **@overeng/content-address**: Require manifest pins to target stored canonical
  JSON manifest bytes and allow safe pin path segments that merely start with
  dots, while still rejecting real parent segments.

- **CI**: Keep the standalone Nix retry helper aligned with the generated
  workflow helper for missing daemon-socket failures, and cover the daemon
  retry path in helper tests.

- **@overeng/pty-effect**: Stabilize the daemon env override live test on macOS
  by keeping the short-lived PTY session alive long enough for peek/attach
  assertions.

- **@overeng/genie**: Emit Starlark `#` generated-file headers for Buck2
  `BUCK`, `.bzl`, and `.bxl` outputs.

- **@overeng/genie**: Keep peer repo Genie authoring helpers from importing
  engine-only validation internals by sourcing repo-context helpers directly
  instead of through the broad node runtime entry.

- **@overeng/genie**: Run strict package export type proofs through an explicit
  compiler executable, with Nix-packaged Genie wired to the pinned `tsgo`
  binary and source-mode validation discovering `tsgo` on `PATH`.
  `lib.mkCliPackages` now threads the same pinned compiler into the Genie
  package, and missing compiler executables are reported as validation issues
  instead of crashing cache-key computation.

- **@overeng/genie**: Tighten package-json export environment validation so
  constrained profiles reject bare Node builtin imports, follow extensionless
  directory entrypoints, and resolve overlapping conditional exports in emitted
  condition order.

- **@overeng/genie**: Ship `typescript` as a runtime dependency so the CLI's
  JSONC validation path resolves outside the repo development shell.

- **@overeng/genie / devenv tests**: Refresh the pnpm fixed-output hashes for
  the new Genie `./node` entry closure and the follow-up runtime dependency
  lockfile change, and isolate the `ts-otelite` e2e test from ambient task trace
  context so `devenv-modules:test` remains deterministic when run under traced
  `devenv tasks`.

- **devenv/lint-oxc, CLI package builders**: Treat an `oxfmt` chunk that becomes
  empty after formatter config ignores as no work while preserving failures for
  real formatter errors, and generate packaged CLI completions without assuming
  every CLI accepts the shared `--log-level none` option.

- **@overeng/megarepo**: Share canonical nested-megarepo traversal state across
  recursive commands and key visited roots by resolved worktree identity, so
  `mr status --all` and `mr ls --all` stop at symlink cycles instead of
  recursing through ever-growing `repos/` paths.

- **devenv/pnpm**: Keep the cached `pnpm-install-contract.json` writable even
  when the generated source file is read-only, so repeated `pnpm:install` runs
  can update `.devenv/task-cache` instead of failing on the preserved generated
  file mode.

- **Bundle smoke CI gate**: Add a Vite/Rollup-based smoke check for
  `@overeng/pty-effect` public entries so bundler-resolution ESM export
  mismatches in runtime dependencies fail in CI before downstream consumers hit
  them. Mark `pnpm-install-contract.json` as generated in Git attributes.

- **devenv/lint**: Add a local `lint:check:asset-import-needs-type-reference`
  task (wired into `lint:check`) that fails when a compiled, exported source file imports an asset
  (`import '...css|scss|sass|less'`) without a `/// <reference>` directive to make the ambient
  `*.css` declaration travel into downstream TS checks (TS2882, #837). It runs out-of-band over
  tracked + untracked source (an in-oxlint rule would itself be suppressible by an `oxlint-disable`,
  which is how this regressed), so no disable directive — next-line, same-line, or file-level — can
  bypass it. Exempts the globs where side-effect imports are allowed and not type-checked downstream
  (`.storybook/**`, `*.gen.*`, `*.d.ts`, `*.test.*`, `*.stories.*`).

- **Dependency materialization VRS hierarchy**: Move the reusable pnpm install,
  projection, Nix prepared-deps, store-authority, Buck2 evidence, and
  observability contracts into `context/dependency-materialization/` as a
  composed VRS hierarchy. The root DMP contract now stays mechanism-agnostic,
  while child specs own live pnpm state, `.bin` projection, prepared FOD
  purity, hash evidence, native package boundaries, shared-store repair/GC,
  and build-log producer facts. The hierarchy now includes a verification
  subsystem with a timeless evidence-intake contract for graduating prototype,
  downstream, CI, and historical change evidence into effect-utils-owned
  fixture, proof, real-workload, and cross-system evidence tiers. Imported
  research references now live in self-contained dot-prefixed companion
  directories instead of the normative spec. The VRS now records that the
  strict prepared-deps purity scan transition uses one convergent `v18`
  prepared artifact version bump and hash refresh, rather than report-only or
  profile-gated legacy scan modes, and that FOD run evidence belongs to
  generated repair or CI output rather than committed per-target witness files.
  The FOD hash evidence spec separates structural proof from value proof so
  shared hashes remain preferred only when measured outputs converge.

- **Dependency materialization profile contract**: Extend the generated
  `pnpm-install-contract.json` with a stable `dependency-materialization-profile/v0`
  section covering identity inputs, store traits, native build policy inputs,
  and the Buck2 boundary. The pnpm helper tests now prove profile emission and
  refuse raw pruning for shared `store/v11/files` pools, forcing coordinated
  repair plans instead of one-worktree cleanup. Successful live `pnpm:install`
  runs also emit profile and registry evidence in the install cache so future
  doctor/repair tasks can reason from registered materialization roots instead
  of probing pnpm's private store layout directly. A shared aggregate registry
  tracks all roots that point at the same files pool, while new `pnpm:doctor`,
  `pnpm:repair-plan`, and explicit `pnpm:repair` tasks consume that evidence to
  refuse raw pruning of shared files pools and force-rebuild every live
  registered root instead. Repair planning now refreshes from the shared
  registry, profile changes replace stale root rows, and repair execution uses
  the same pure install policy as `pnpm:install`. Prepared-deps profile keys
  now include content freshness digests for staged manifests and inherited root
  patch authority, and
  `mk-pnpm-cli` exposes a Buck2-facing evidence adapter that consumes the same
  prepared-deps profiles without owning live pnpm materialization. It also
  exposes generated FOD hash repair targets so repair tooling can discover
  direct prepared-deps attrs and hash paths without adding per-package witness
  files.

- **pnpm install contract proof**: Add a generated `pnpm-install-contract.json`
  artifact that makes the long-term pnpm/Nix/Buck2 install contract explicit:
  pnpm owns `store/v11/{files,links,projects}`, GVS `links` are treated as a
  rebuildable dependency-graph projection, fixed-output Nix dependency prep does
  not consume live GVS projections, and Buck2 integration should key from the
  generated contract plus the lockfile rather than from pnpm's private
  `node_modules` layout. `pnpm:install` now hashes the structured
  `gvsLinkContract` JSON section for GVS relink invalidation instead of parsing
  rendered `pnpm-workspace.yaml`, and helper tests cover the prior false
  positive where policy-only changes were classified as `gvs-link` drift.

- **@overeng/oxc-config native `overeng/storybook/*` rules**: Reimplement the
  seven Storybook CSF best-practice rules (`meta-satisfies-type`,
  `default-exports`, `story-exports`, `csf-component`, `hierarchy-separator`,
  `no-redundant-story-name`, `prefer-pascal-case`) as native `overeng` oxlint
  JS-plugin rules instead of re-exporting them from `eslint-plugin-storybook`.
  This restores the enforcement temporarily removed in #804 and permanently
  drops the `eslint-plugin-storybook` dependency (the only remaining consumer of
  that catalog entry). Each rule carries a source-of-truth reference to its
  upstream `eslint-plugin-storybook@10.4.6` rule plus resync notes, and the now
  unreferenced `eslint-plugin-storybook` and `oxfmt` catalog entries are
  removed. Intentional deviations from upstream (scope-analysis-dependent
  autofixes are detection-only; `hierarchy-separator`'s `|`→`/` fix is kept) are
  documented per rule.
- **Clean devenv OTEL task model** (#377): `dt`, devenv task wrappers, shell
  entry, pnpm cache-miss status spans, and TypeScript diagnostics now use a
  single `service.name=effect-utils-devenv` resource with stable operation span
  names (`dt.run`, `devenv.shell.entry`, `devenv.task.exec`,
  `devenv.task.status`, `typescript.project.check`,
  `typescript.build.aggregate`). Task identity moved to typed span attributes
  such as `task.name`, `task.phase`, and `task.cached`; raw forwarded `dt`
  arguments are no longer recorded. `ts:check`/`ts:build` emit typed
  `typescript.*`, `compiler.*`, and `diagnostics.*` attributes through
  `otel-span emit-span` for both `tsgo` and JS `tsc`, with spool-only delivery
  and task-context propagation covered. The dashboards now query operation span
  names plus `span.task.name` / `span.ts.project.name`, and the new
  `ts-otelite-e2e.test.sh` proof covers the full
  `dt.run -> devenv.task.exec -> typescript.*` tree through real otelite.

- **native dependency policy audit**: Add `nativeDependencyPolicy`, a tagged
  source-of-truth classification in `genie/external.ts` for every native npm
  dependency family (nix-grafted, denied-lifecycle-build, pure-package-artifact).
  The generated pnpm `allowBuilds` denylist is now derived from it so the
  denylist and audit cannot drift. A new install-free CI audit
  (`genie/ci-scripts/native-dep-policy-audit.ts`, wired into the
  `pnpm-builder-contract` job) diffs the lockfile against the policy and fails
  on drift: a CPU/OS/libc-gated native family with no policy entry, a
  non-defensive policy package that disappeared, or a nix-grafted entry whose
  `via` file is missing. Because pnpm lockfile v9 dropped `requiresBuild` and the
  builder-contract job restores no `node_modules`, the pnpm build-script ledger
  is unavailable; detecting a brand-new lifecycle-built package that is neither
  gated-native nor in the policy is therefore out of scope, with the policy as
  the source of truth (#807).

### Fixed

- **@overeng/react-inspector**: Omit absent schema tooltip and lineage metadata
  instead of materializing optional fields as `undefined`, so downstream
  `exactOptionalPropertyTypes` checks can compile the source-linked package.

- **@overeng/notion-effect-client**: Preserve Markdown importer semantics for
  soft-wrapped paragraphs, common JavaScript/TypeScript code-fence aliases, and
  loose list item child blocks when producing Notion append/create payloads.

- **Patch projection scope**: Keep the `@myobie/pty` xterm serialize patch in
  effect-utils' root workspace config only, so downstream
  `createPnpmPatchedDependencies` consumers do not inherit a pty-only patch and
  trip pnpm's unused-patch validation.

- **@overeng/tui-react**: Fix downstream `TS2882` for `TuiStoryPreview`'s
  `import '@xterm/xterm/css/xterm.css'`. The `*.css` ambient that types the side-effect import is
  now referenced from the importing file via a `/// <reference path>` directive (to a shipped
  `src/storybook/asset-modules.d.ts`), so the declaration travels into every program that compiles
  the file — including downstream source-linked TS checks. Previously the ambient lived in floating
  `.d.ts` files loaded only by this repo's own tsconfig `include` globs, so it did not ride along
  when a downstream consumer compiled the source via `exports`-resolution. Removes those floating
  declarations (`types/css.d.ts`, `tui-react/src/types/css.d.ts`) and their `include` references
  across the `genie`, `megarepo`, `notion-cli`, and `tui-stories` tsconfigs. The bundler still
  injects the stylesheet natively — no runtime or codegen change.

### Changed

- **devenv/tasks**: Remove the `dt` task wrapper and make native
  `devenv tasks run <task>` the only task entrypoint. Task tracing now uses
  `devenv.task.exec` / `devenv.task.status` as the canonical span shape,
  dashboards are renamed to `devenv-*`, and guard passthrough now uses the
  task-neutral `DEVENV_TASK_PASSTHROUGH` environment variable.

- **@overeng/restate-effect**: Make the Restate real-server test harness use
  request identity and structured SDK log capture. The harness now generates an
  ephemeral ED25519 request-identity keypair per native-server boot, starts
  `restate-server` with the private key, and serves each SDK endpoint with the
  derived `publickeyv1_...` identity key, removing unauthenticated-handler
  warnings at the source. `EndpointOptions.sdkLogger` threads a structured SDK
  logger into `createEndpointHandler({ logger })`, and the harness captures SDK
  SYSTEM/JOURNAL/USER records through `harness.sdkLogs.records()` instead of
  relying on stderr or `RESTATE_LOGGING=ERROR`. Expected terminal domain failures
  remain available as `TerminalError` log params with code/metadata, so the bridge
  keeps terminal/retryable/defect semantics intact while making integration test
  output quiet and inspectable.

- **@overeng/restate-effect**: Route the scheduled durability SIGKILL test's SDK
  endpoint diagnostics through structured log capture as well. The test now keeps
  the expected HTTP/2 abort evidence from killing `restate-server` mid wake-mode
  wait, while avoiding misleading raw stderr noise in CI.

- **Restate integration port allocation**: Bind in-process handler endpoints on
  port `0` and register the actual kernel-assigned URL, while keeping batch +
  retry allocation for the native `restate-server` child process ports that must
  be passed by number.

- **CI test task ordering**: Make shared devenv task-module tests wait for `pnpm:install` so
  source-mode CLI shell tests cannot race dependency materialization under
  `test:run --mode before`.

- **CI alignment notification**: Keep the `notify-alignment` dispatch limited to
  trusted push events so fork pull requests without `MEGAREPO_ALIGNMENT_TOKEN`
  do not run the coordinator dispatch job and fail with GitHub `401`.

- **CI measurement reporting**: Skip PR comment publication for fork pull
  requests that cannot write comments/assets, while keeping measurement summaries
  and artifacts. Chart asset fallbacks now re-render the comment from structured
  URLs instead of editing Markdown with brittle `sed` ranges.

- **Genie compiled import staging cleanup**: Scope compiled-binary `.genie.ts`
  import staging directories to the dynamic import lifetime so successful and
  failing compiled runs no longer leave `genie-import-*` directories in the
  process temp directory. Add a compiled Genie CLI shell regression test that
  runs against an isolated `TMPDIR` and verifies the staging directory is
  removed after repeated runs (#824).

- **Effect-LSP diagnostics are now a strict quality gate** (#811): The
  `@effect/language-service` plugin config in `genie/external.ts` is an explicit,
  intent-revealing gate policy driven by a single `effectDiagnosticsGate` toggle,
  now ENABLED: an Effect warning OR suggestion anywhere in the workspace fails the
  `tsgo --build` exit code (errors always gate). The gate rides the existing
  type-check over the project graph — no extra compiler pass — so it is enforced
  by `ts:check` / `ts:check:strict`, hence `dt check:quick` / `dt check:all` and
  the CI `typecheck` lane; `--force` is not required (Effect diagnostics replay
  from `.tsbuildinfo`). To enable it, all 822 pre-existing Effect diagnostics
  (389 warnings + 433 suggestions) were burned down to zero with idiomatic,
  behavior-preserving fixes (typed error channels via `Schema.TaggedError`,
  `Schema.parseJson` over raw JSON, single `Effect.provide`/correct `Layer`
  construction, `Effect.orElseSucceed` / `Effect.void` / `Schema.TaggedStruct`,
  etc.); a small number of genuinely un-nameable sites (framework dynamic-dispatch
  boundaries, type-level negative-assertion files) carry narrow justified
  `@effect-diagnostics … :off` / `:skip-file` waivers. `missingEffectContext` /
  `missingEffectError` keep their upstream default `error` severity; the dead
  `reportSuggestionsAsWarningsInTsc` flag was dropped (it does not exist in
  tsgo / LS 0.86.2). **Alignment heads-up**: this is the shared
  `baseTsconfigCompilerOptions`, so peer repos that consume it inherit the gate on
  their next effect-utils bump; a repo not yet clean can locally set
  `ignoreEffect{Warnings,Suggestions}InTscExitCode` back to `true` until it
  converges.

- **OTEL trace-structure contract**: Tighten the offline trace-structure
  negative test so orphan detection uses a syntactically valid but missing
  parent span ID. Invalid span IDs are now left to the helper's input
  validation path, keeping graph-shape assertions separate from argument
  validation.

- **devenv cli-guard ownership**: Make the cli-guard nudge-wrappers the
  deterministic owners of their command names so the devenv buildEnv no longer
  emits nondeterministic `collision between ...` warnings (#808). Each guard now
  exec's the real binary by absolute store path under `DT_PASSTHROUGH=1` instead
  of grepping `$PATH`, so the real packages (`genie`, `mr`, `oxlint`, `oxfmt`,
  `nixfmt`, `deadnix`, `tsgo`, `pnpm`) no longer need to be competing top-level
  profile providers. Reals are threaded into the task modules via `*Pkg` args
  (`tsBinPkg`, `oxlintPkg`, `mrPkg`, `pnpmPkg`, `geniePkg`). `effect-tsgo`
  and `pnpm` stay on `$PATH` at `lib.lowPrio` to keep their `effect-tsgo`/`pnpx`
  siblings reachable. `realBin` is optional with the previous `$PATH`-grep
  retained as the fallback, so the `fromTasks`/`mkCliGuard` API and unthreaded
  guards (`vitest`, `playwright`) are backward compatible. The exported
  `tasks.genie` module stays a bare-path standard module — `geniePkg` is an
  optional module argument (threaded via `_module.args.geniePkg`), so downstream
  `imports = [ inputs.effect-utils.devenvModules.tasks.genie ]` is unaffected.

- **repo dependency/toolchain refresh**: Upgrade the Nix, pnpm, TypeScript, lint,
  test, Storybook/Vite, React, OpenTelemetry, OpenTUI, and Effect 3-line
  dependency set to current major-compatible versions while deliberately not
  moving to Effect 4. Live installs now use Nix-managed pnpm 11 with global
  virtual store enabled, install scripts and dependency scripts disabled, strict
  store verification, and a pure workspace-local store; fixed-output Nix prep
  keeps an isolated virtual store as the reproducible exception because GVS
  projections point at the builder-local pnpm store. Native packages that are
  needed at runtime are supplied through Nix/custom package derivations, and
  Storybook oxlint rule exports are temporarily removed until the upstream
  ESLint 10 plugin stack is compatible again. Refresh the affected CLI
  `pnpm-deps` fixed-output hashes so cold Nix prep validates after the lockfile
  and pnpm policy changes, explicitly deny `fsevents` build approval, and
  document the boundary between Nix-owned lifecycle-built native addons and
  locked fixed-output prebuilt optional native packages. The `genie` CLI now
  formats through the Nix-wrapped `oxfmt` executable instead of bundling the npm
  `oxfmt` module, keeping optional formatter plugins out of the compiled CLI
  closure. CI's shared Nix retry wrapper now repairs and retries a missing
  multi-user Nix daemon socket, matching the existing transient Nix store/fetch
  retry policy. Storybook is now declared as depending on this workspace's
  `@storybook/react-vite` framework package via pnpm package extensions, so
  Storybook's dynamic preset loading works under pnpm's global virtual store;
  refresh the lockfile and affected `pnpm-deps` fixed-output hashes for that
  package-extension checksum change. The pty-effect native-package linking task
  now resolves the active pnpm global virtual store path and skips an absent
  `links` projection instead of assuming the default workspace store exists
  while source-mode `mr` tasks now wait for `pnpm:install` before resolving
  their package graph, removing a check:quick task-order race in CI perf probes
  and the Genie perf probe now uses the supported `genie:check` task instead of
  raw Bun execution through shell entry
  (#804).

- **devenv TypeScript tasks**: Move the normal workspace TypeScript check/build
  path to the Nix-managed `tsgo` binary, so `ts:check`, `ts:check:strict`,
  `ts:build`, `ts:build-watch`, and `ts:clean` run on the TypeScript 7 native
  compiler track. `ts:emit` keeps using JavaScript `tsc` for its compiler-API
  tsconfig filtering and no-check emit path. The old standalone
  `ts-effect-lsp` compatibility module is removed because Effect diagnostics
  are now part of the normal tsgo-backed check path.

- **@overeng/genie**: Make `findGenieFiles` return stable repo-relative
  `.genie.ts` paths, with generation/check orchestration resolving them at the
  filesystem boundary. Discovery tests now assert through a canonical-relative
  helper so symlinked roots and macOS `/var` realpath aliases cannot skew path
  expectations.

- **repo**: Add a no-op Hypermerge production canary for schickling/dotfiles#1072.

- **Notion docs**: Ratify the durable Notion DB Markdown Sync VRS decisions into
  `context/notion-db-markdown-sync/decisions/0014` through `0026` and remove the
  provisional `decisions/proposed` ledger.

- **repo-wide (oxlint enforcement)**: Made the oxlint gate strict now that every rule is at zero repo-wide. Promoted the swept rules `overeng/named-args`, `overeng/explicit-boolean-compare`, `overeng/exports-first`, `func-style`, and `no-await-in-loop` from `warn` to `error` in `genie/oxlint-base.ts` (`overeng/jsdoc-require-exports` was already `error`), and flipped `denyWarnings = false` → `true` in `devenv.nix` so ANY warning now fails CI — enforced identically in CI and the local `lint:check` pre-commit gate, so the gate can never silently regress. To reach a clean zero, the 7 residual non-`overeng` advisory warnings were resolved principledly: `unicorn/prefer-array-find` (a split-into-all-tokens false positive) and `unicorn/consistent-function-scoping` on the otelite `inspectArgs` helper got justified inline `oxlint-disable`s; the pure `millisToNanos` converter in restate `Runtime.ts` was hoisted to module scope; `oxc/no-barrel-file` was scoped off for `utils/node/otel.ts` + `otel-attrs.ts` (intentional `./node/otel` entry / contract-convenience barrels, like the already-exempt `mod.ts`); and `import/no-cycle` was scoped off for `restate-effect/src/testing/**` (a benign barrel-induced test-infra cycle, cf. the kdl port waiver). Result: `oxlint … .` reports 0 warnings / 0 errors and `dt lint:check` (now `--deny-warnings`) is green; `genie --check` byte-identical, `dt ts:check` clean. (#771)
- **repo-root `genie/` tooling, @overeng/oxc-config, @overeng/megarepo, @overeng/notion-md**: Drove the final batch of `overeng` oxlint warnings (27: named-args + explicit-boolean-compare + exports-first) to zero across these targets — no lint-rule, `.genie.ts` generator, `genie/oxlint-base.ts`, or `.oxlintrc.json` change, and no runtime/OTEL-bridge/generated-config-output change (`genie --check` stays byte-identical). `overeng/named-args`: user-defined functions with 2+ positional parameters were converted to a single options object (parameter names + type parameters preserved verbatim) with all call sites updated in lockstep — the ten CI-workflow generator helpers in `genie/` (`appendGitHubEnvLine`, `annotationLine`, `ciJobConcurrency`, `withDefaultJobConcurrency`, `withGitHubAccessTokenEnv`, `withPrivateCachixReadAuth`, `nixCachePrimaryKey`, `vercelDeployStep`, plus `job`/`downloadCurrentMeasurementArtifactStep` in `.github/workflows/ci.yml.genie.ts`), the three internal `no-raw-otel-primitives.ts` AST helpers in `oxc-config` (`trackEffectImport`/`rawOtelCallSource`/`rawOtelNamespaceCallSource` — visitor callbacks themselves stay single-param), the `trustedWith`/`trustedAnnotate` span helpers in `megarepo` `cli`/`lib` observability and the file-local `walk` recursion in `lib/store.ts`, and the `withOperation`/`annotateAttrs` span helpers in `notion-md` (matching the existing `notion-effect-client` `{ operation, attributes }` / `{ attributes, value }` convention) with their ~50 in-package call sites; the exported `withLabelSpan`/`withRepoPathSpan` cross-module call sites in `git.ts`/`store*.ts`/`nix-lock/mod.ts` were updated in lockstep. The genie source-asserting tests in `@overeng/genie` were updated to the new call syntax (body-string and export-existence assertions left intact). `overeng/explicit-boolean-compare`: genuine strict booleans got explicit comparisons (`strict === true` in `store-liveness.ts`, `dryRun === true` in `store/mod.ts`, `bodyIsEmpty === true` in `editor-surface.ts`). One waiver: `editorTeardown` in `notion-md/cli.ts` implements Effect's positional `Teardown` `(exit, onExit)` interface required by `NodeRuntime.runMain`, so it carries an inline `oxlint-disable-next-line`; the `cli.ts` `exports-first` warning was fixed by moving the exported `runCliMain` above its non-exported helpers. The repo-wide `dt ts:check`, `oxfmt --check`, `genie --check` (byte-identical), and the authoritative type-aware oxlint (all `overeng` rules at zero) stay green; the megarepo (606), notion-md (198), oxc-config (280), and genie (274) vitest suites pass. (#771)

- **@overeng/otel-contract, @overeng/utils, @overeng/content-address**: Drove the `overeng/named-args` oxlint warnings (12 + 8 + 3) to zero across the three core libs on the calling-convention axis — no lint-rule, genie-source, or `.oxlintrc.json` change, and no telemetry-contract / hashing / playwright-span semantics change. 23 user-defined functions with 2+ positional parameters were converted to a single options object (parameter names and type parameters preserved verbatim), with all in-package and cross-package call sites updated in lockstep. In `otel-contract/src/mod.ts`: the widely-consumed `OtelAttr` attribute DSL (`string`/`boolean`/`number`/`json`, the `metadata` default preserved as an optional destructured property); the metric-emission API on the `OtelEffect{Counter,Histogram,Gauge}` interfaces AND their runtime bridges (`incrementBy`/`trustedIncrementBy`/`record`/`trustedRecord`/`set`/`trustedSet`, converted interface-signature + closure + return-object in lockstep); and the internal `taggedMetric`/`invalidMetricLabel` helpers. In `content-address/src/mod.ts`: `canonicalJsonString`/`canonicalJsonBytes`/`hashCanonicalJson` (`value`'s type re-expressed as `Schema.Schema.Type<TSchema>` so it no longer depends on a positional `schema` binding). In `utils`: the seven file-local `trustedWith` span helpers (browser `BroadcastLogger`, node `ActiveHandlesDebugger`/`cmd`, playwright `op`/`page`/`wait`/`step`) and the exported `withFreePort`. Because these are core exported surfaces, cross-package call sites were updated in `@overeng/restate-effect` (`observability/contract.ts` + `observability/Metrics.ts`), `@overeng/megarepo` (`cli/observability.ts`), `@overeng/notion-effect-client` (`body-evidence.ts`), and `@overeng/notion-datasource-sync` (`core/canonical.ts`). Zero waivers: nothing here implements an external interface (the rule's only waiver criterion). `tsc` per package, the repo-wide `dt ts:check` (the cross-package call-site safety net), `oxfmt --check`, and the authoritative type-aware oxlint (named-args at zero in all three packages, 0 errors) stay green; the content-address (4), utils (143), otel-contract (37), and restate-effect (170, against a native restate-server) vitest suites pass. (#771)

- **@overeng/restate-effect, repo-root `genie/` tooling**: Drove the `overeng/explicit-boolean-compare` oxlint warnings (38) to zero on the readability axis — no lint-rule, `.genie.ts` generator, `genie/oxlint-base.ts`, or `.oxlintrc.json` change, and no runtime/durability/journaling, OTEL-bridge (decision 0007), or generated-config-output change (`genie --check` stays byte-identical: 75 generated files unchanged). Each operand was type-confirmed before fixing rather than mechanically appended with `=== true`: genuine strict booleans (`compare`/`trustNeedsAdmission` defaulted via `?? true`/`= false` in `genie/ci-workflow/measurements.ts` + `merge-queue.ts`; `retryable`/`stops`/`wakeOn`/`stopByCount(...)` in `Scheduled.ts`; `Response.ok`; `Schema.Boolean` fields like `decision.ok`/`approved`/`wedge`/`done`; the `serverAvailable` probe; boolean-returning predicates) became `=== true` / `=== false`. The `gatePolicy.enabled` operand (spread-widened to `boolean | undefined` but always set at runtime) took `=== true` to preserve "absent ≡ not enabled", matching the file's existing `=== true` usage. 31 sites in restate-effect (src, examples, integration tests) and 7 in the root genie CI-workflow tooling; zero justified disables. `tsc`, `oxfmt`, and the authoritative type-aware oxlint (explicit-boolean-compare at zero in both targets, no errors) stay green; the full restate-effect vitest suite passes (170 tests, 0 skipped — the integration lanes ran against a native `restate-server`). (#771)

- **@overeng/restate-effect**: Drove the `overeng/named-args` oxlint warnings (148) to zero on the calling-convention axis — no lint-rule, genie-source, or `.oxlintrc.json` change, and no runtime/durability/journaling or OTEL-bridge (decision 0007) semantics change. 141 user-defined functions with 2+ positional parameters were converted to a single options object (parameter names preserved verbatim) across src, examples, and tests, with their internal and cross-module call sites updated in lockstep; the builder oracle in `capability-inference.types.ts` confirmed the `const` type-parameter inference survives destructuring. 7 sites were waived with inline `oxlint-disable-next-line` because the positional signature is structurally fixed by an interface this code implements rather than calls: the materialized SDK handler `(ctx, input)` in `Endpoint.ts`, the `Random.Random` methods `nextRange`/`nextIntBetween` in `Runtime.ts`, and the `restate.Context`/`ObjectContext` methods `sleep`/`resolveAwakeable`/`rejectAwakeable`/`set` in `TestContext.ts`. SDK/ingress positional calls the package merely invokes (e.g. `client.workflowSubmit`, `ctx.resolveAwakeable`) were left positional. Exported functions changed calling convention, so this is breaking for external callers (passing positionally must become a single options object); no in-repo cross-package call site required updating (there are none). `tsc`, `oxfmt`, and the authoritative type-aware oxlint (named-args at zero, no errors) stay green; the full vitest suite passes (170 tests, 0 skipped — the integration lanes ran against a native `restate-server`). (#771)
- **@overeng/notion-effect-client, @overeng/notion-core, @overeng/pty-effect, @overeng/tui-react, @overeng/notion-datasource-sync, @overeng/notion-cli, @overeng/genie**: Drove the `overeng/named-args` oxlint warnings to zero across these seven leaf packages on the calling-convention axis — no lint-rule, genie-source, or `.oxlintrc.json` change, and no runtime/OTEL-bridge (decision 0007) semantics change. 17 user-defined functions with 2+ positional parameters were converted to a single options object (parameter names and type parameters preserved verbatim), with all in-package internal and cross-module call sites updated in lockstep: the `withOperation`/`annotateAttrs`/`pushProcessorData`/`treeEntries` helpers in `notion-effect-client`; `daysInMonth`/`compareNotionApiVersions` in `notion-core/constants.ts`; the `trustedWith`/`trustedAnnotate`/`withSchemaVersion` OTEL + projection helpers in `genie`; `trustedWith`/`withPtyNameSpan`/`withPtyOperationSpan`/`withPtyWaitSpan` in `pty-effect`; and the exported `bodyIdentityEquals` in `notion-datasource-sync` (call sites in `body/adapter.ts` + `body/notion-md.ts`). The two `notion-core` `includesLiteral` type-guards were curried rather than object-destructured because a `value is TValue` type predicate cannot bind to a destructured property. Two functions were waived with inline `oxlint-disable-next-line` because their positional `(exit, onExit)` signature is structurally fixed by Effect's `Teardown` interface they implement and pass to `NodeRuntime.runMain`: `tuiTeardown` (`tui-react`) and `editorTeardown` (`notion-cli`). No exported function in these packages has an out-of-package (core-lib/contended) call site, so no cross-package signature change was needed. `@overeng/oxc-config`'s 3 remaining named-args are all internal helpers inside the `no-raw-otel-primitives.ts` rule file, which is out of scope here. `tsc` (per package), `oxfmt`, and the authoritative type-aware oxlint (named-args at zero in these seven packages, no errors) stay green; each package's vitest suite passes (notion-datasource-sync has env-gated integration skips). (#771)
- **@overeng/utils-dev, @overeng/utils, @overeng/notion-core, @overeng/notion-effect-client, @overeng/genie, @overeng/otel-contract**: Drove three file-local oxlint rules to zero across these packages on the readability axis — no lint-rule, genie-source, or `.oxlintrc.json` change, and no function-signature, call-site, or runtime-semantics change. `overeng/explicit-boolean-compare` (9): replaced implicit boolean coercion with explicit comparisons matching each operand's actual type — genuine-boolean `!fn(...)`/`if (x)` became `fn(...) === false`/`=== true` (the `matchesMetricValue`/`matchesAttrs`/`matchesSelector` selector helpers in `utils-dev`, `settled`/`collided` in `utils/node/net.ts`, `droppedNotRoundTripSafe` in `notion-core/body-fidelity.ts`); the `notion-effect-client` rate-limit ternary kept its `Option.isSome` aliased-narrowing through the `=== true` form (verified `rateLimit.value` still type-narrows). `eslint/func-style` (9): converted `function` declarations to arrow-function consts where no hoisting/`this`/generator constraint applied — the six `projection-artifact/mod.ts` runtime helpers in `genie` (all references deferred inside closures, so the const reorder is safe) and the three `withOperation`/`withRootOperation`/`withOperationStream` nested builders in `otel-contract/src/mod.ts` (defined before the return object that exposes them). `overeng/exports-first`: no in-scope occurrence. Zero justified disables. `tsc` (per package), `oxfmt`, and the authoritative type-aware oxlint stay green; the touched packages' vitest suites pass except for pre-existing otelite-binary / `WORKSPACE_ROOT`-env-gated tests in files not touched here. (#771)
- **@overeng/notion-effect-client**: Stop enabling GFM autolink literals in canonical Markdown. The canonicalizer now composes only the GFM features it needs (tables, task-list items, strikethrough), so bare URLs and email-shaped text remain plain text instead of being rewritten to angle autolinks; this fixes the `FAST_CHECK_SEED=199297095` idempotence failure (`0@.A` -> `<0@.A>` -> `<<0@.A>>`) and avoids lossy Notion preview-link text canonicalization. Refresh the affected pnpm lock/package-closure hashes. (#771)
- **@overeng/utils-dev**: Add a reusable Vitest fast-check replay setup that reads `FAST_CHECK_SEED` and `FAST_CHECK_PATH`, so CI-reported property-test failures can be replayed locally without editing the failing test. Adopt it in `@overeng/notion-md` unit tests and refresh the affected `notion-cli` pnpm-deps FOD hash after the generated package export change. (#771)
- **@overeng/notion-effect-client**: Drove the `overeng/jsdoc-require-exports` oxlint warnings (16) to zero on the docs/visibility axis — no lint-rule, genie-source, or `.oxlintrc.json` change, and no client/OTEL/body-evidence-semantics change. Reachability from the published entry (`src/mod.ts`, transitively following its re-export chains) plus cross-module/test imports was the discriminator across three files. The four `internal/otel.ts` span helpers (`withNotionHttpSpan`/`annotateNotionHttpRateLimitSpan`/`withNotionDatabasesQuerySpan`/`withNotionPagesRetrieveSpan`) are imported by sibling modules (`internal/http.ts`, `databases.ts`, `pages.ts`) so they kept their `export` and gained span-name/label-rule JSDoc. In `body-observation.ts` the `mod.ts`-reachable `NotionBodyObservation`/`observeFromSnapshots`/`NotionBody` gained concise invariant-carrying JSDoc, while the standalone `observe` (in no entry, imported nowhere by name, reached only via the `NotionBody` object) was un-exported. In `body-evidence.ts` the five `mod.ts`-reachable symbols (`BodyEvidenceFingerprint`/`RemoteBodyObservationEvidence`/`fingerprintBodyEvidence`/`makeRemoteBodyObservationEvidence`/`descriptorDigest`) gained JSDoc (e.g. the fingerprint excludes the volatile `observedAt` so re-observing unchanged content is stable); the module-internal `BodyCompletenessEvidence` const+type and the `BodyEvidenceBlockTree` type were un-exported; and the dead `bodyEvidenceDescriptorDefaults` const — unreachable AND referenced nowhere — was deleted (with its now-unused `canonicalJsonMediaType`/`canonicalJsonCodec` imports). Buckets: 3 un-export, 10 real-doc, 1 delete. No symbol left the published API surface; `tsc`/`oxfmt`/the full vitest suite (137 tests; one otelite-CLI-spawning span-shape test skipped as it requires the out-of-PATH `otelite` binary) stay green. (#771)
- **@overeng/content-address**: Drove the `overeng/jsdoc-require-exports` oxlint warnings (19) to zero on the docs/visibility axis — no lint-rule, genie-source, or `.oxlintrc.json` change, and no hashing/content-address-semantics change. The package is a single-file library whose published entry IS `src/mod.ts`, so every warned symbol is directly exported from the entry AND imported by downstream packages — all reachable. Each therefore stayed exported and gained a concise, non-trivial one-line JSDoc carrying a real invariant or gotcha rather than a name restatement (e.g. `ContentDigest` is lowercase-hex `sha256:<64 hex>`; `canonicalJsonString`/`hashCanonicalJson` sort object keys so the digest is stable across key-insertion order; `canonicalJsonBytes` is the exact bytes hashed; `verifyDescriptor` fails closed via `ContentDescriptorMismatchError` on digest or byte-length disagreement; `objectPathForDigest` splits on the first hex byte to avoid huge flat dirs; `descriptorForCanonicalJson` requires an explicit `schemaVersion`). Zero un-exports, zero deletions. `tsc`/`oxfmt`/the full vitest suite (4 tests) stay green. (#771)
- **@overeng/genie**: Drove the `overeng/jsdoc-require-exports` oxlint warnings (28) to zero on the docs/visibility axis — no lint-rule, genie-config-source, or `.oxlintrc.json` change, and no runtime/generation/OTEL-semantics change. Reachability from the published entries (`.` → `runtime/mod.ts`, `./cli`, `./sdk`) was the discriminator. The seven `projection-artifact/mod.ts` exports are all re-exported via `export *` from `runtime/mod.ts`, so they stayed exported and gained concise, non-trivial one-line JSDoc (e.g. `ProjectionJsonObject` rejects top-level arrays/primitives; `projectionArtifact.json` emits stable schema-versioned JSON while keeping typed `.data`; `defineProjectionValidator` is an inference-pinning identity helper). `core/observability.ts` is module-internal (in no entry) and consumed only via `import * as Observability`, so a symbol is reachable iff accessed as `Observability.<name>` (or the one named `withCliModeSpan` import in `build/mod.tsx`); the thirteen reachable `with*Span`/`annotate*`/`relativePath` helpers kept their `export` and gained span-name/label-rule JSDoc, while eight module-internal `*Span`/`*Attrs` operation/schema consts that build their paired wrapper in the same file but are never accessed externally were un-exported (`commandSpan`, `fileSpan`, `pathAttrs`, `oxfmtAttrs`, `validationSpan`, `atomicWriteSpan`, `importMapResolverSpan`, `targetLockAttrs`). No symbol left the published API surface; zero deletions; `tsc`/`oxfmt`/the full vitest suite (268 tests) stay green. (#771)

- **@overeng/notion-core**: Drove the `overeng/jsdoc-require-exports` oxlint warnings (25) to zero on the docs/visibility axis — no lint-rule, genie-source, or `.oxlintrc.json` change, and no runtime/Notion-API-schema-semantics change. Reachability from the single published entry (`mod.ts`) was the discriminator: every warned symbol across `ids.ts`, `properties.ts`, `colors.ts`, `constants.ts`, and `body-fidelity.ts` is re-exported from `mod.ts`, so all stayed exported and gained a concise, non-trivial one-line JSDoc carrying a real invariant or gotcha rather than a name restatement (e.g. `NotionUuid` is canonical dashed form; `SELECT_COLORS` is the solid-only subset with no `*_background` variants; `NOTICON_COLORS` adds `lightgray` and omits backgrounds; `BodyLossyReason`/`BodyCompleteness` carry the R30/R38 round-trip verdict; `stableBodyFidelityStringify` sorts object keys for stable hashing). Zero un-exports, zero deletions. `tsc`/`oxfmt`/the full vitest suite stay green. (#771)

- **@overeng/notion-md**: Drove the `overeng/jsdoc-require-exports` oxlint warnings to zero on the docs/visibility axis, using reachability from the published surface (`mod.ts` / `./cli` / `./cli-program`) plus cross-module/test imports as the discriminator — no lint-rule, genie-source, or `.oxlintrc.json` change, and no runtime/rendering/reconciliation/API-shape change. `observability.ts` is module-internal (not in any entry) and consumed only as `import * as Observability`, so a symbol is reachable iff accessed as `Observability.<name>`. Thirteen `*Attrs` schema consts that build their paired `Operation`/span in the same file but are never accessed externally were un-exported (`pageAttrs`, `parentPageAttrs`, `dataSourceAttrs`, `pathAttrs`, `pathRecursiveAttrs`, `pathPlanAttrs`, `pathSyncAttrs`, `pagePathAttrs`, `pushSpanAttrs`, `stateFileAttrs`, `objectRoleAttrs`, `markdownUpdateAttrs`, `metadataUpdateAttrs`). Four exported encoder helpers (`page`/`parentPage`/`path`/`pagePath`) were dead — unreachable AND never called internally — so un-exporting them would trip `no-unused-vars`; deleted instead (with the now-unused `node:path` `basename` import). The reachable surface gained concise one-line JSDoc carrying span name / label rule / invariant: the namespace-reachable spans (`StatusPathSpan`…`GatewayArchivePageSpan`, `stateFileSpan`), `withOperation`/`annotateAttrs`, the externally-referenced `*Attrs` (`statusAttrs`/`pushResultAttrs`/`syncResultAttrs`/`objectHashAttrs`/`pushDecisionAttrs`/`pushMarkdownCommandAttrs`/`pushDecisionMarkdownCommandAttrs`), the five `body-facade.ts` body-snapshot interfaces re-exported from `mod.ts`, `remoteMarkdownFromBodyObservation` (`live.ts`, test-reachable), and `buildFrontmatterV2` (`sync.ts`, in `mod.ts`). No symbol left the published API surface; `tsc`/`oxfmt`/the full vitest suite (198 tests) stay green. (#771)

- **@overeng/notion-datasource-sync**: Drove the `overeng/jsdoc-require-exports` oxlint warnings (17) to zero on the docs/visibility axis — no lint-rule, genie-source, or `.oxlintrc.json` change, and no sync-semantics/behavior change. Reachability from the published entries (`.` → `src/mod.ts`'s `export *` splat of `core/domain.ts`; the `./body/notion-md`, `./local`, and re-exported `./local/sidecar.ts` surfaces) plus cross-module imports was the discriminator. Every warned symbol was reachable, so all kept their `export` and gained a concise, non-trivial one-line JSDoc carrying a real invariant or gotcha: the ten `core/domain.ts` body-identity helpers (`hashFromContentDigest`/`bodyEvidenceFingerprintFromContentDigest` reinterpret an existing content-address digest without rehashing; `bodyIdentityDigest` is evidence-fingerprint-when-present else rendered-digest; `renderedBodyDigest` ignores evidence; `bodyDescriptorForDigest` carries `byteLength: 0` since the bytes are absent; `evidenceBackedBodyIdentity` keeps lossy renders distinguishable), the `./local` `FilesystemWorkspaceSidecar` schema/type re-export, the three cross-module `local/sidecar.ts` exports (`metadataDirectoryName` is the hidden, scan-skipped metadata dir; `pageSidecarDirectoryName`; `makeFilesystemWorkspaceSidecar` derives the own-write suppression token), and the two `body/notion-md.ts` structural `*Like` adapter types that decouple this package from the exact upstream `@overeng/notion-md` body shape. Zero un-exports, zero deletions. `tsc`/`oxfmt`/the full vitest suite (441 tests) stay green. (#771)
- **@overeng/utils**: Drove the `overeng/jsdoc-require-exports` oxlint warnings (4) to zero in `src/node/otel.ts` on the docs/visibility axis — no lint-rule, genie-source, or `.oxlintrc.json` change, and no telemetry-foundation (`withTelemetry`/`Shape`/`makeOtelCliLayer`/`sampleResource`) behavior or shape change. All four warned symbols are reachable from the published `./node/otel` entry (`makeOtelCliLayer` is also imported by downstream CLIs; the three option interfaces are the parameter types of the exported `withTelemetry`/`sampleResource`/`sampleGauge` functions, so they stay in the `.d.ts` surface), so none were un-exported or deleted. `makeOtelCliLayer`'s warning was a misattached doc: its rich block comment had been orphaned when the `defaultShutdownTimeoutMs` helper (with its own JSDoc) was inserted between the doc and the function — moving the helper above the doc block re-attaches the existing documentation rather than adding a new comment. The three options interfaces (`TelemetryLayerOptions`, `SampleResourceOptions`, `SampleGaugeOptions`) gained a concise one-line JSDoc naming their consuming function and the inputs they carry (their members were already documented). Buckets: 0 un-export, 4 real-doc (1 re-attach + 3 new), 0 delete. No symbol left the published API surface; `tsc`/`oxfmt` stay green and the non-otelite vitest suite passes (137 tests; 6 otelite/`WORKSPACE_ROOT`-env-gated tests skipped, as they require the out-of-PATH `otelite` binary + devenv env that is broken on this branch). (#771)
- **@overeng/megarepo**: Add the default-enabled, clean-only `mr store gc`
  archival path for `ref_mismatch` worktrees from decision 0008. A mismatch may
  be archived only when both refs pass default/live guards, the worktree is
  clean, local work is remote-reachable, no stash exists, and absence grace has
  elapsed. Archives record both the store path ref and actual HEAD branch,
  detach the archive, and preserve branch refs instead of guessing which name to
  delete; JSON output exposes `pathRef`/`actualHeadBranch`, and GC span tallies
  now include archived/reaped/kept counts for fleet verification.

- **@overeng/megarepo**: Drove the `overeng/jsdoc-require-exports` oxlint warnings in `lib/observability.ts` + `cli/observability.ts` to zero by treating reachability from the package's published/imported surface as the fix axis. The two observability modules are consumed only as namespace imports (`import * as Observability` / `LibObservability`), and neither is re-exported from `mod.ts` or the CLI entry — so a symbol is reachable iff it is accessed as `Observability.<name>` by some consumer (verified per-symbol, disambiguating the overloaded `Observability` alias, which resolves to `cli/observability.ts` from `cli/commands/*` but to `lib/observability.ts` from `lib/*`). The reachable `with*Span`/`annotate*` span helpers (plus `shortPath`) kept their `export` and gained a concise one-line JSDoc stating the span name / label rule / invariant. The unreachable module-internal `*Attrs` schema consts (used only to build their paired `Operation` in the same file) were un-exported (drop `export`). Seven exported encoder helpers (`label`/`repoPath`/`worktreePath`/`workspaceRoot`/`storeWorktree`/`storeSource`/`pathLabel`) were dead — unreachable AND never called internally — so merely un-exporting them would trip `no-unused-vars`; they were deleted instead (with the now-unused `node:path` import). No lint-rule, genie-source, or `.oxlintrc.json` change; `tsc`/`oxfmt`/the full vitest suite are unaffected. (#771)

- **@overeng/restate-effect**: Drove the `overeng/jsdoc-require-exports` oxlint warnings (26) to zero on the docs/visibility axis, treating reachability from the package's four published entries (`mod.ts` / `./otel` / `./admin` / `./testing`) and cross-module/test imports as the discriminator — no lint-rule, genie-source, `.oxlintrc.json`, or runtime/OTEL-semantics change (decision 0007 untouched). Three module-internal observability schema/array consts that were unreachable AND used only to build their paired definition in the same file were un-exported (`trustOtelContract`, `RestateOperationAttributes`, `RestateDurationMetricBoundariesMs`). The reachable surface gained concise, non-trivial one-line JSDoc carrying purpose/invariant: the six baseline `Metric` re-exports, the `Boundary*Attrs`/`RestateMetrics`/`restateOperation`/`withRestateOperation` observability seams, the `Scheduled` companion const/type pairs (`Schedule`/`OnCycleError`/`WakePayload`/`StatusOutput`/`ScheduledConfig`/`RestateScheduled`), `ContractSerdeFactory`, and the `Restate` namespace. Three already-rich block comments that the JSDoc rule missed were upgraded `/*`→`/**` (`RestateIngress`, `RestateTestHarness`, `RestateTestEnv` Tags), and the `endpoint/layer` `eslint-disable` line moved above its JSDoc so the doc re-attaches. No symbol left the published API surface; `tsc`/`oxfmt`/the full vitest suite (170 tests) stay green. (#771)

- **@overeng/utils-dev**: Drove the `overeng/jsdoc-require-exports` oxlint warnings (41) to zero across the otelite test-harness modules (`otelite/otel.ts`, `trace-expect.ts`, `signal-expect.ts`, `test-harness.ts`) on the docs-only axis — no lint-rule, genie-source, `.oxlintrc.json`, or harness-behavior change (the test↔prod SIBLING convergence stays intact). Reachability was the discriminator: as the universal test-harness leaf, almost every export is public via the `./otelite` entry (which transitively re-exports the matcher DSL, selectors, errors, `OteliteTestHarness`, and the `capture*` helpers) or, for the five `withOtelite*Span` span helpers in `otel.ts`, reachable as cross-module imports from `Otelite.ts`/`test-harness.ts`. No symbol was unreachable, so all 41 kept their `export` and gained a concise, non-trivial one-line JSDoc carrying a real invariant or gotcha (e.g. matchers stringify primitives because otelite rows are flat strings; `null` matches the literal `'null'`; `spanLabelPolicy` defaults to `required`; `withOteliteRootSpan` forces a fresh trace) rather than a name restatement. Zero un-exports, zero deletions. `tsc` (utils-dev + the `@overeng/utils` consumer), `oxfmt`, and the full vitest suite (30 tests) stay green. (#771)

- **@overeng/otel-contract**: Add a public `<project>-<role>` service-name / resource-identity shape helper. `ServiceNameFromParts` (a `Schema.transformOrFail(ServiceNameParts, OtelServiceName)`) builds `service.name = `${project}-${role}``from typed parts, validated in two load-bearing layers:`project`/`role`decode as plain`NonEmptyTrimmedString`(rejecting empty/whitespace) BEFORE the joined string decodes through the existing`OtelServiceName`brand — because`OtelServiceName`'s pattern admits a trailing hyphen, an empty `role`would otherwise compose to`"<project>-"`and silently pass a single decode.`FleetServiceBinding` is the public type-seam: a plain-`string` `{ project, role, namespace, version }`interface describing the SHAPE a private fleet config supplies (this repo owns the TYPE + constructor; a private repo supplies the VALUES — zero fleet values here, fields unbranded so decode stays at the edge).`serviceIdentityFromBinding(binding)`assembles a validated`ServiceIdentity`from a binding, removing the hand-rolled`Schema.decode(ServiceIdentity)({ name: `${project}-${role}`, … })`at composition roots. Parts are plain (not branded) — the lightest typing that still rejects empties, since the composed`OtelServiceName`decode already enforces the naming law (decision 0003 in`@overeng/utils/docs/vrs/.decisions/`). (#771)
- **@overeng/otel-contract**: Drove the `overeng/jsdoc-require-exports` oxlint warnings (10) to zero on the docs/visibility axis — no lint-rule, genie-source, or `.oxlintrc.json` change, and no schema/brand/cardinality/`no-raw-otel-primitives`-boundary change. The package is a single-file telemetry contract whose published entry IS `src/mod.ts`, so every warned symbol is directly exported from the entry (and depended on by every downstream package) — all reachable. Each therefore stayed exported and gained a concise, non-trivial one-line JSDoc carrying the brand law or instrument invariant rather than a name restatement: the four name brands encode their distinct pattern rules (`OtelAttributeKey`/`OtelServiceName` are letter-led `[A-Za-z0-9_.:-]`; `OtelSpanName` admits any printable ASCII incl. spaces/punctuation; `OtelMetricName` is Prometheus-style and may lead with `_`/`:`), `OtelMetricInstrumentKind` selects which definition/runtime bridge applies, `OtelHistogramDefinition`/`OtelGaugeDefinition` narrow the metric definition (histogram adds bucket `boundaries`; gauge is last-set), and `OtelEffect{Counter,Histogram,Gauge}Metric` alias the underlying Effect runtime each contract drives. Zero un-exports, zero deletions. `tsc`/`oxfmt`/the full vitest suite stay green. (#771)
- **@overeng/megarepo**: Reframed the store-root `_`-prefix membership guard (`shouldSkipStoreRootEntry` in `lib/store.ts`) as the PRIMARY, intentional boundary between member namespaces (`<host>/<owner>/<repo>/`) and non-member co-tenant dirs that legitimately share the store root — not a temporary band-aid awaiting a writer-side fix. The `_iso/<slug>/` entries that the store walk skips are continuously written by external isolation tooling (PR-verification isolated worktree checkouts; each a worktree _client_ with a `.git` FILE pointing at a bare, plus a full working tree), i.e. a production runtime co-tenant, not a test/bench artifact — so the read-side skip is the correct, durable contract and is KEPT, with its comment corrected to say so. The `listRepos` layout regression test now also exercises the real `_iso/<slug>` worktree-client shape (`.git` file + working tree), proving the `_`-prefix root skip excludes it (and never descends its working tree) BEFORE the `.git` shape is ever inspected. The co-tenant _writer_ lives outside this package (in the isolation tooling that owns the `_iso/` namespace); the store-side membership boundary is the in-scope, principled fix. (#771)

- **@overeng/notion-md**: Compacted the VRS decision log by removing six superseded `.decisions/` records and redirecting every citation to the surviving decision. The reconciler/placeholder design — `0005` inline id-carrying placeholders, `0010` visible-placeholder deletion, `0011` block-level reconciliation, `0014` reconciliation-as-universal-push-engine, `0015` renderer-symmetric Markdown↔block converter — is wholly superseded by **decision 0016** (refuse lossy pages), and the `0013` stateless in-buffer schema fingerprint by **decision 0017** (ephemeral file-engine session, drift detected from the engine's base snapshot). The six records were deleted rather than tombstoned (their rationale lives in `experiments.md`), and all references — the `schema-snapshot.ts` doc-comment, the `01-editor`/`04-fidelity`/`06-data-source` spec/requirements, `experiments.md`, `README.md`, and the surviving decision records `0003`/`0008`/`0009`/`0016`/`0017`/`0019` — were redirected to the superseding decision (as a live link where one is cited, or as historical prose naming the superseded concept). `0016`/`0017` were tightened to state the supersession once, and the duplicated "Refined by 0017" blockquotes on `0003`/`0008`/`0009` trimmed to one line. No decision IDs were renumbered; the six deleted IDs simply disappear (decision log is now 13 records: `0001`–`0004`, `0006`–`0009`, `0012`, `0016`–`0019`). Zero links resolve to a deleted record. Docs-only — no library surface change.

- **@overeng/notion-datasource-sync**: Body is SINGLE-SURFACE and ADAPTER-OWNED with a resolution path (#775, decision 0021). Revises the earlier "unify body convergence through the engine" milestone (M2b): routing the `.nmd` BODY surface through the `convergeLocalSurfaces` engine was a FALSE SYMMETRY — `.nmd` is the only local body surface, so the engine always saw a single body fact and added no handling the body adapter does not already do (dead-weight ceremony plus a latent `body-body-delegated` stuck-state). PART A removes the inert engine routing: the `nmdBodyFact` builder + its `convergeLocalSurfaces` call in `pushOneShotSync`'s body loop (`src/sync/sync.ts`), the engine-detected `body-body-delegated` `conflictKind` from `ConflictRaised` (`src/core/events.ts`) and `ConflictProjectionRow.kind` (`src/store/store.ts`), and the `raiseConvergenceConflicts` body-raise extension in `src/cli/main.ts` (reverted to a property-only inline loop). The convergence engine is now PROPERTY-only; the body adapter is the sole body authority (`conflictKind: 'body'`, raised from `planLocalChange` → `BodyConflict`). The generic `classifyConflict` body-vs-body classifier and the property/lifecycle conflict machinery are UNTOUCHED. PART B adds the body conflict resolution path (the real, reachable gap — the adapter `body` conflict was previously refused by `conflict-commands.ts` as a null-`propertyId` non-lifecycle conflict). A new `resolveBodyConflict` branch (`src/planner/conflict-commands.ts`, mirroring `resolveLifecycleConflict`): `keep-local` re-asserts the local `.nmd` body by re-enqueueing a `BodyPushCommand` against the current body pointer (routed through the planner so the body-edit guards apply; settles via the body settle handler); `keep-remote` accepts the remote body — the `ConflictResolved` store apply gains a `body` arm that retires the conflict and records the re-materialization intent by clearing `sidecar_identity_proven` on the body pointer. That intent is CONSUMED on the next pull: `pullOneShotSync` collects every body pointer whose `sidecarIdentityProven` is false and passes them as `forceMaterializePageIds` to `observeRemoteDataSource`, which overrides the mirror path's global `materializeBodyArtifacts: false` suppression for exactly those pages, so the still-diverged local `.nmd` IS rewritten from the remote observation (a deferred remote effect, exactly as the lifecycle keep-remote arm defers its reconvergence) rather than the divergence persisting silently. Body has no engine-mergeable value (it is content), so resolution is re-push / re-materialize, NOT a value merge. Covered by e2e tests: a reachable adapter `body` conflict is raised AND resolvable (keep-local re-enqueues a `BodyPushCommand`; keep-remote resets sidecar identity, clears, and a follow-up suppressed-mirror pull STILL re-materializes the page — proving the intent is consumed) with replay determinism, plus the property convergence + lifecycle conflict + broader sync e2e suites stay green (regression). Ratified as decision 0021.

- **@overeng/notion-datasource-sync**: Make lifecycle (trash-state) conflict detection BIDIRECTIONAL, completing decision 0026 for the trash surface (#775, XC-R02/REPLICA-R12). The prior implementation caught only the `RowObserved` direction (remote RESTORE after a settled local ARCHIVE). This adds the symmetric TOMBSTONE direction: a remote TRASH after a settled local RESTORE. A remote trash does not arrive as a `RowObserved` (a trashed page drops out of `data_source.query`) — it arrives as `TombstoneRecorded(reason='remote_trash')`, which previously silently set `_nds_row.in_trash = 1`, overriding a settled local restore. A new `tombstoneLifecycleDivergenceEvents` detector (`src/sync/sync.ts`) runs at the disappearance/absence append seam in `pullOneShotSync`: for a `TombstoneRecorded(remote_trash)` (`R = 1`) it computes the SETTLED local target `L` via `readSettledLifecycleTarget` and, when `L = 0` (settled RESTORE) diverges from `R`, appends a `ConflictRaised(conflictKind: 'lifecycle', remoteInTrash: true)` plus the `PendingIntentShadowViolation` diagnostic at a LOWER sequence than the tombstone — exactly mirroring the `RowObserved` seam. `L = undefined` (no settled intent) or `L = 1` (matches `R`) stays benign (the false-positive guard). The tombstone's `in_trash = 1` apply (`src/store/store.ts`) is now gated on the SAME `#hasOpenLifecycleConflict` check the `RowObserved` apply uses, so a settled local restore (`in_trash = 0`) is not silently flipped while the conflict is open/resolving. Resolution is unchanged and direction-agnostic: `keep-remote` adopts the recorded `remoteInTrash` (= 1, tombstone stands), `keep-local` re-asserts `L = 0` via a re-enqueued `RestorePage` (the `resolving` state holds the freeze until it settles). Replay-pure (the `ConflictRaised` precedes the tombstone; no `L` recomputation in the apply path). Ratified as decision 0026; its SCOPE note now states the conflict is bidirectional and the "symmetric direction out of scope / deferred to periodic reconcile" wording is removed.

- **@overeng/notion-datasource-sync**: Final-pass traceability + ADR reconciliation for the lifecycle and body convergence rails (#775). Register two concrete scenarios in `src/testing/scenarios.ts`: `NDS-L3-lifecycle-divergence-conflict` (`requirementIds: ['R82']`, guard `PendingIntentShadowViolation`, `src/e2e/sqlite-storage-contract.e2e.test.ts`) for the decision-0026 remote-restore-after-settled-archive conflict, and `NDS-L3-body-convergence-rail` (`guards: []`, `src/e2e/local-convergence-production.e2e.test.ts`) for the FORWARD-LOOKING, production-inert `body-body-delegated` rail (a constructed second body surface drives the engine body-divergence fact + conflict-rail projection (page-keyed, null property_id) + per-surface blocking — NOT a production body conflict; the complementary no-`in_trash`-freeze isolation is covered separately in `src/store/store.unit.test.ts`). Reconcile `PendingIntentShadowViolation`'s genuine coverage: it was claimed on `NDS-L3-realistic-local-remote-conflict` (and `NDS-L4-bidi-clean-outbound-after-remote-observation`), but those tests never reference the guard — it is wired in `sync.ts` and asserted only in the lifecycle-conflict tests, so `guardScenarioIds` is repointed to the new lifecycle scenario and the overclaimed `guards:` entries are stripped (requirement coverage on those scenarios is unchanged). The `R82` `unmapped-requirement` residual is removed now that the lifecycle scenario maps it. ADR `0021-body-is-single-surface-and-adapter-owned` gains a Consequences note clarifying that (a) the rendered-digest base applies to the ENGINE's local-divergence fact ONLY — the conflict/intent/command bases correctly stay on the evidence digest because `guardStaleSurfaceBase` compares against the evidence-space projection — and (b) a `body-body-delegated` conflict is currently UNRESOLVABLE through the user-action surface (`conflict-commands.ts` refuses null-`propertyId` non-`lifecycle` conflicts) while still counting as not-clean / blocking compaction, a prerequisite to address before a second body surface is wired. No production code changed.

- **@overeng/notion-datasource-sync**: Extend the `ExpiringFileUrl` file-durability guard to catch obviously-expiring EXTERNAL URLs, not just Notion-hosted files (#775, decision 0024 upgrade — part 3). Durability is a property of the URL, not its source: previously any `externalUrl` was treated as durable, so an S3 presigned link, an Azure SAS, or a GCS signed URL was attached as "durable" even though it expires just like a Notion-hosted signed link. A new pure `isExpiringExternalUrl(url)` helper (`src/planner/property-proof.ts`) detects OBVIOUS presign/expiry signatures in the URL query string (case-insensitively): AWS S3 (`X-Amz-Signature`/`X-Amz-Expires`/`X-Amz-Credential`), Azure SAS (`sig` with `se`/`st`), GCS signed (`X-Goog-Signature`/`X-Goog-Expires`), and generic shapes (`Signature`+`Expires`, a unix-ts `Expires`, `token`+`exp`). `evaluateDesiredFileReferences` now classifies a flagged external URL as non-durable and routes it through the SAME existing `guardExpiringFileUrl` (mapping it to the `notion-hosted`/no-`stableRef` snapshot the guard blocks — reuse, not a re-implemented block), so it surfaces as `BlockedByGuard`/`ExpiringFileUrl` at planning. A durable external URL (no expiring signature, including benign query params like `?utm_source=`/`?v=2`/a bare `?token=` API key) stays allowed; a Notion-hosted file (no `externalUrl`) stays blocked. Detection is deliberately CONSERVATIVE to avoid false-positives on durable URLs that merely carry benign params; a malformed/non-parseable URL carries no detectable signature and is treated as durable (fail-OPEN in the SIGNATURE detector — `isExpiringExternalUrl` returns `false`, never throws — while the no-`externalUrl` path still fails closed independently). RESIDUAL: non-obvious non-durability (a plain durable-looking URL that 404s tomorrow) stays undetectable. The `NDS-L1-expiring-file-url-property-write` scenario coverage note is broadened to the URL-durability framing. Ratified as decision 0024.

- **@overeng/notion-datasource-sync**: Wire the `ExpiringFileUrl` guard onto property `files` writes (#775 M3b, decision 0024 part 2). The guard had been defined and unit-tested before this production dispatch. A new pure `evaluateDesiredFileReferences` (`src/planner/property-proof.ts`) inspects the desired `files` property value at the property-write planning seam and FAILS CLOSED when any `CanonicalFileValue` lacks an `externalUrl`: a `CanonicalFileValue` is durable identity only with an `externalUrl` (projected from the remote `file.external.url`), whereas a Notion-HOSTED file is canonicalized to `name` + `identityHash` with its signed/expiring `file.file.url` intentionally dropped — so a missing `externalUrl` IS the "notion-hosted, no stable durable ref" case the guard names. Per file it builds a `FileReferenceSnapshot` and delegates the verdict to the existing `guardExpiringFileUrl` (reuse, not a re-implemented block). The planner pushes this decision into `baseGuards` right after `evaluatePropertyWrite` (`src/planner/planner.ts`), so a notion-hosted files write that the property-write core ALLOWS (tag-fit is a no-op — a `files` value fits a `files` column) is surfaced as `BlockedByGuard`/`ExpiringFileUrl` by `firstBlocked`; an external durable URL proceeds, and an empty `files: []` (a clear) and every non-`files` write allow. REACHABILITY: this is the external-URL-only `files` seam — the encode path already fails closed generically (`unsupported_remote_shape`) when any file lacks `externalUrl`; this change makes that same case fail EARLIER and SPECIFICALLY with `ExpiringFileUrl` at planning. It is reachable via a pulled notion-hosted file round-tripped back as a write (pull → canonicalize to name+hash with no `externalUrl` → the signed URL is gone → writing it back as durable identity is exactly the unsafe case). `CanonicalFileValue` has no `file_upload_id` field, so a durable pre-uploaded `notion_file` cannot be represented at this seam — every non-external file blocks, the correct fail-closed posture. The `ExpiringFileUrl` `placeholder-guard-scenario` residual is promoted to a concrete `NDS-L1-expiring-file-url-property-write` scenario (`requirementIds: ['R20', 'R52', 'R59']`, guard `ExpiringFileUrl`) in `src/testing/scenarios.ts` and the placeholder removed, so the traceability self-test shows real coverage. Ratified as decision 0024.
- **@overeng/notion-datasource-sync**: Unify body convergence through the engine (#775 M2b, decision 0021). The `.nmd` BODY surface now routes through the same `convergeLocalSurfaces` engine as properties for LOCAL divergence only, with per-surface blocking and a RENDERED-digest base — while the body ADAPTER stays authoritative for everything remote. A new `nmdBodyFact` builder (`src/sync/local-convergence-inputs.ts`) emits a body `NmdDesiredFact` with `desiredHash = observation.contentHash` (already rendered space) and `baseHash = renderedBodyDigest(snapshot body pointer)`, gated on actual divergence so an unedited pulled `.nmd` (evidence digest differs, rendered identical) does NOT false-diverge. The engine pass runs in `pushOneShotSync`'s body loop (observation locality — `observation.contentHash` is a sidecar-entangled raw-file hash the CLI cannot reproduce), purely additive: `.nmd` is the only local body surface today (the SQLite `body_patch` channel stays dormant), so the engine always sees ONE body fact → `single-surface` → no conflict, no block in production, and the bespoke edit-detection + the adapter's full remote-staleness/safety gate (lossy / unknown-blocks / would-delete-children / synced-page / non-body-mutation) and `BodyPushCommand` construction still run on every surviving body intent (risk-#1 adapter-authoritative invariant, regression-guarded). The conflict rail is EXTENDED, not collapsed: a new `body-body-delegated` `conflictKind` (engine-detected local body divergence, distinct from the adapter's own remote `body` conflict) is added to `ConflictRaised` and `ConflictProjectionRow.kind`, page-keyed with a NULL `property_id` (no replica-schema change), raised through a now-extracted `raiseConvergenceConflicts` helper and projected to `_nds_replica_conflicts`. `#hasOpenLifecycleConflict` stays `lifecycle`-ONLY so a `body-body-delegated` conflict does NOT freeze `in_trash`. SCOPE: this milestone has NO production body-behavior change — the engine body pass is single-surface/inert, the builder base is inert in production, and the body intent/`_nds_body_pointer` projection stay on the EVIDENCE digest (the planner's `guardStaleSurfaceBase` compares the intent base against the evidence-based `currentHash`, so both must share that space; the rendered-digest base belongs ONLY to the engine's local-divergence builder). Everything added activates with the (forward-looking) second body surface. Ratified as decision 0021.

- **@overeng/notion-datasource-sync**: Treat page lifecycle (trash-state) divergence as a first-class conflict (#775 M2a'-2, decision 0026 parts 2 & 3, XC-R02/REPLICA-R12). A `RowObserved` whose remote trash state `R` diverges from the SETTLED local lifecycle target `L` is now CONFLICT-DETECTED instead of silently flipping `pages._in_trash` (silent last-writer-wins on a bidirectional surface). The motivating case: a local archive settles (remote trashed), then someone independently RESTORES the page in Notion; the next sync's `RowObserved` would have silently reset `_in_trash` to 0, overriding the user's archive intent. `L` is read from the SETTLED `TrashPage`/`RestorePage` outbox history (new `NotionSyncStore.readSettledLifecycleTarget`), NOT from the overloaded `_nds_row.in_trash` — reading `in_trash` for `L` would manufacture false-positive conflicts on benign remote changes. Detection runs at the shared `pullOneShotSync` ingestion seam (one-shot AND watch): on divergence it appends a `ConflictRaised(conflictKind: 'lifecycle', remoteInTrash: R)` plus the now-wired `PendingIntentShadowViolation` diagnostic at a LOWER sequence than the `RowObserved`, so the `RowObserved` apply freezes `in_trash` at the settled local target (gated on an OPEN lifecycle conflict for the page — discriminated by decoded `conflictKind`, so `body-body-delegated`'s null-`propertyId` conflicts do not trigger the freeze). Resolution mirrors property conflicts but on its own path: `keep-remote` reconverges `_nds_row.in_trash` to the recorded `remoteInTrash` (and clears the `remote_trash` tombstone when the remote target is active); `keep-local` re-asserts `L = !remoteInTrash` via a fresh `TrashPage`/`RestorePage` push (the F8 settle handler reconverges on settlement). The whole path is pure full-log replay (the persisted `ConflictRaised` precedes the `RowObserved`, no `L` recomputation in the apply path), so reprojection is deterministic. SCOPE: this entry landed the `RowObserved` direction (remote restore after local archive); the symmetric remote-trash-after-local-restore (tombstone) direction is now ALSO implemented (see the bidirectional-lifecycle-conflict entry above), so decision 0026 is realized in both directions on the one-shot full-scan path. An open lifecycle conflict stays open until resolved (no auto-close on a remote re-match), mirroring property conflicts. KNOWN LIMITATION: `keep-remote` resolves the conflict and reconverges `in_trash`, but the settled lifecycle history is unchanged, so `readSettledLifecycleTarget` still reports the old target; re-detection on a later sync re-derives the same `ConflictRaised` whose deterministic idempotency key is deduped (correct steady-state), but if that opening event is ever compacted away the conflict would re-raise — full settled-history reconciliation is deferred. Ratified as decision 0026.

- **@overeng/notion-md**: Make the media boundary's inert-by-construction invariant explicit and enforced (#775 M3a, decision 0024 Option B). The property-encoding boundary (`external_url` | `notion_file` | `local_file`) and the byte-backed media boundary (`storage.files` `NmdFileUnit`) are disjoint by type, so external/local property refs never ride the byte path and the media boundary stays durable "by construction". That invariant was previously held only by the current absence of a lowering path; it is now named and pinned. The load-bearing enforcement is `classifyMediaWrite`'s existing empty-`storage.files` requirement (any unit, regardless of `role`, fails closed — so a future change that lowered a property ref into a byte unit would be caught at the boundary rather than silently transferring bytes), plus a new `sync.e2e.test.ts` invariant test proving that pushing a page whose properties carry `external_url`/`notion_file` refs persists ZERO `storage.files` units and classifies as `inert`. The external-URL durability stance is documented as a known content-fidelity limitation (`docs/sync-safety.md` + the `external_url` encode site): v1 attaches the URL as-is and does NOT verify durability (it can 404/move) — the external analog of a Notion-hosted expiring file URL, with no guard in v1. Behavior-preserving for the already-working `external_url`/`notion_file` property writes; `local_file` stays refused on push. The `ExpiringFileUrl` and datasource-sync planner wiring are a separate later task (M3b).

- **@overeng/notion-datasource-sync**: Converge `in_trash` from the settled local lifecycle intent (closes the M2a F8 post-restore and watch-incremental gaps tracked as #698). The `RemoteWriteSettled` store handler now sets `_nds_row.in_trash = 1` on a settled `TrashPageCommand` and `_nds_row.in_trash = 0` (plus clearing the row's `remote_trash` tombstone) on a settled `RestorePageCommand`, in addition to the existing remote-trash tombstone reprojection. This fixes the post-restore staleness bug (a byte-identical `RowObserved` is deduped, so without settle-driven convergence `pages._in_trash` stayed 1 forever after a restore) and the watch-path divergence (the incremental scan never records a `remote_trash` tombstone, so a local archive on `sync --watch` previously left `_in_trash = 0`). The convergence is driven by the settle we know succeeded — independent of remote-disappearance classification — so it holds on both one-shot and watch with zero extra API calls (EFF-R01). Remote-initiated trash detection is unchanged (still the tombstone path plus watch's periodic full reconcile).

- **@overeng/notion-datasource-sync**: Add the observable API call-count budget (#775, decision 0025 Half 1, EFF-R01/R81). A new `otel.e2e` test counts `notion.api.request` spans under the one-shot sync span and asserts a falsifiable CEILING (a clean one-shot issues `<= 5` logical requests) plus the exact read-endpoint multiset (`preflightCapabilities`, `retrieveDataSource`, `queryRows`, `listDataSourceViews`, `retrievePage`), so a regression that adds a per-entity read is caught test-side; a no-change re-sync is asserted to issue no write operations. A production `notion_datasource_api_requests_total` counter (via `@overeng/otel-contract` `OtelMetric.effect.counter`, labelled only by the bounded `operation` endpoint) increments alongside the span at each gateway op for fleet visibility. The ceiling counts LOGICAL requests; the rate-limit half (throttle-wait / retry signals in `@overeng/notion-effect-client`) is a separate change.

- **@overeng/notion-effect-client**: Add observable rate-limit PRESSURE signals (#775, decision 0025 Half 2). Instrument the genuinely-new `rate_limit_wait_ms` signal — the time a logical request is blocked acquiring a throttle token — at the `NotionThrottle.apply` seam: the wait is measured around the `RateLimiter` gate (clock read outside the gate vs. the instant the token is granted), so it stays behavior-preserving (the limiter still wraps the request exactly as before, token accounting/pacing untouched) and concurrency-correct (each request measures its own wait in its own fiber). The wait is stamped on the request span (`notion.rate_limit.wait_ms`) and recorded as a `notion_rate_limit_wait_ms` histogram. Rate-limit pressure is promoted to `@overeng/otel-contract` `OtelMetric` counters labelled by bounded method+operation: `notion_http_attempts_total` (ACTUAL HTTP attempts incl. retries — distinct from Half 1's logical-request ceiling), and `notion_http_retry_after_total` / `notion_http_retry_after_ms_total` (count + summed ms of server-advised `Retry-After` backpressure). A new `*.e2e.test.ts` drives a stateful fault-injecting HTTP stub: a 429-then-200 sequence proves the HTTP-attempt count is 2 and `retry_after` is recorded with the retry attrs on the span, and a drained-throttle-bucket path proves `rate_limit_wait_ms` lands on the span and histogram. COUNT SEMANTICS (decision 0025): these are the rate-limit-pressure signals, explicitly distinct from Half 1's logical-request budget ceiling.

- **@overeng/notion-datasource-sync**: Land M2a F8 archive-restore round trip plus lifecycle cleanup. (F8) A `TombstoneRecorded` with `reason = 'remote_trash'` now reprojects `_nds_row.in_trash = 1`, so a remotely-trashed row stays a RESTORABLE row instead of reprojecting back to `in_trash = 0` (which made a 1→0 restore inexpressible). The fake gateway's `queryRows` now EXCLUDES trashed rows, matching real Notion (a trashed page vanishes from `data_source.query`) — which is what makes the disappearance→`remote_trash`→F8 reprojection path load-bearing. `RestorePageCommand` is now guarded symmetrically with the trash path: restoring a moved-out page blocks with `MoveOutNotDelete`, while a genuinely-trashed page proceeds. The vestigial `kind:'lifecycle'` convergence branch is removed from the local-surface convergence engine (page lifecycle reaches the planner through CDC `row_archive`/`row_restore` intents, never the engine). The `in_trash` projection still only converges on the one-shot full-scan path; post-restore and watch-incremental convergence are tracked as a follow-up (#698).

- **@overeng/notion-datasource-sync**: Close clear-cut #775 follow-ups. (F5) Shared-mode property writes are now gated by the real outbox read-after-write settlement verdict instead of a hard-coded `present` default — a second write to a `(page, property)` whose prior write has not settled blocks with `ReadAfterWriteMismatch`; `local`/`remote` modes stay `not-required`. (F7) `createReplicaSchema` installs the replica schema and its CDC triggers inside one `BEGIN IMMEDIATE` transaction (with a `createReplicaSchemaInTransaction` inner for the projection path that already holds a transaction), so a mid-install failure leaves no partial schema and triggers can never exist without their tables. (F2) Three declared-but-unwired guard names (`LinkedDataSourceUnsupported`, `StoreMigrationBlocked`, `PageTimestampWakeupOnly`) move from the active `GuardName` vocabulary into `reservedGuardNames` so the traceability matrix stops implying test coverage for them, and bodies-on `.nmd` dry-run suppression gains a falsifiable proof (`NDS-L4-dry-run-suppression-nmd-bodies`).

- **@overeng/notion-md**: Route datasource-scoped property writes through the shared `@overeng/notion-property-write` core via a new standalone live proof provider (`makeStandaloneLiveProof`). For a page whose parent is a Notion data source, each writable property is evaluated against a freshly re-read data-source schema + live page (stable property identity, write class, base completeness, relation availability) before the write proceeds; green paths evaluate to `allowed()` so existing behavior is unchanged, blocked verdicts surface as `NmdPropertyWriteBlockedError` instead of a silent property update, and a `source: remote` page refuses local property mutation as drift. The gateway gains a `retrieveDataSource` operation; standalone (non-datasource) pages keep their current path untouched. Full live schema-drift / relation-completeness coverage (Phase 8) is marked with `TODO(phase-8-live-l6)`.

- **@overeng/notion-md**: Detect data-source schema drift before a property write via an engine `schema_snapshot` (R14, decision 0017, impl-delta Group F). For a data-source-backed page, `pullPage` now retrieves the parent data source (`GET /v1/data_sources/{id}` via `page.parent.data_source_id`) and captures the **writable** property schema into the sidecar `data_source` binding: a canonical projection of `{ name, type, sorted option names }` sorted by property name, options only for `select`/`multi_select`/`status`, hashing **names not ids** (a rename is id-preserving), excluding ids/colors/descriptions/status-groups/timestamps/`created_by`/`last_edited_by`/`request_id`/computed properties. Before any property write the engine re-retrieves the live schema, recomputes the hash, and on drift refuses with `NmdSchemaDriftError` (exit 6) rather than risk Notion silently auto-creating a `select` option for an unknown value name — distinct from the exit-7 value/body conflict and **not** `--force`-able; resolve by re-pulling. This is the file-engine path `edit --frontmatter` reuses (no stateless in-buffer fingerprint, no `put --frontmatter`; the decision-0013 fingerprint subsystem is gone). Standalone (non-data-source) pages have no snapshot and skip the check. A benign color-only schema change does not trip; the five structural mutations (add/remove/rename/retype property, add option) do. Verified with deterministic projection/drift unit tests + fake-gateway engine tests, and live E2E on real Notion: a row's `page.parent` decodes as `data_source_id`, the sidecar binding is captured non-null, a benign property push round-trips, and after a live structural schema mutation a property push refuses with exit 6 without writing.

- **@overeng/utils + @overeng/utils-dev**: Add the timeless telemetry-foundation VRS (`@overeng/utils/docs/vrs/`: vision/requirements/spec + decisions 0001 pure-Effect OTLP front door, 0002 test-shape sibling convergence) capturing the as-built `withTelemetry` / `Shape` / `OtelConfig` / `sampleResource` surface, the `ServiceIdentity` → `service.{name,namespace,version}` resource mapping, and the schema-first `@overeng/otel-contract` boundary. Records the test-shape convergence OUTCOME: FULL convergence (otelite harness consuming the prod `withTelemetry({ shape: 'test' })` front door) is structurally infeasible because `@overeng/utils-dev` is the universal test-harness leaf — `utils` and `otel-contract` already carry `tsc --build` project references to it, so importing the front door (or `ServiceIdentity`) would close a reference cycle. The maximal clean convergence is applied instead: the harness's all-signals layer now mirrors `shapeDefaults('test')`'s 2000 ms shutdown ceiling (previously omitted) with a cross-reference, and test↔prod fidelity stays proven one level up by `otel-telemetry.test.ts` exercising the real front door against the same otelite receiver. This sibling has a DIFFERENT root cause from the restate `./otel` sibling (package dependency direction vs the `@opentelemetry/api` global registry), recorded distinctly. (#771)
- **@overeng/megarepo**: Fix two `mr store gc` correctness bugs. (1) `collectNestedWorktrees` (the `listWorktrees` ref-tree walk) had no depth bound — a worktree-less subtree (a stray dir or a broken worktree whose working tree survived a dropped `.git`) recursed to the filesystem's depth, the same unbounded-recursion OOM class already fixed in `listRepos`. It now caps descent at `STORE_REPO_WALK_MAX_DEPTH` (8) ref-name segments under `refs/heads/…` (real branch names nest only a few levels, so a legitimate worktree is never truncated), logging a warning at the cap; the `.git` worktree check still runs first so a worktree sitting exactly at the bound is found. (2) `--dry-run` performed a real mutating `git fetch --prune` in the cold-reclamation path, rewriting `refs/remotes/*` in `.bare` and violating dry-run's no-mutation contract. Dry-run now SKIPS the fetch entirely and classifies against the currently-present (last-known) `refs/remotes/*`; the TUI banner states remotes were not refreshed. Live (non-dry-run) behavior is unchanged: fetch, and on fetch failure keep all named worktrees with reason `fetch-failed`. Regression tests cover both (nested-worktree cap + real-state dry-run no-prune with a paired live-prune discriminator). (#771)

- **@overeng/megarepo**: Migrate the last raw `Effect.withSpan` sites in product code (the inline gc/git lib spans in `store-archive`, `store-fs-atomic`, `store-gc-config`, `store-gc-observations`, `store-lossless`, `store-pr-state`, `git`, and `store/mod.ts` — the gc helper modules were already schema-first) onto schema-first `OtelOperation` contracts defined in `lib/observability.ts`, so all megarepo telemetry now routes through the `@overeng/otel-contract` DSL. Span names, `span.label` expressions, and attribute keys are reproduced byte-identically (including the intentionally unprefixed keys `branch`/`reason`/`path`/`repoRoot`/`worktreePath`/`worktreeHead`/`store.repo`/`store.bare_repo.path`); the streaming `git/cmd` output-byte counters are untouched (no buffering reintroduced). With the megarepo product tree clean, `overeng/no-raw-otel-primitives` is now a strict zero-allowlist invariant there — the `raw-otel-boundary` boundary test is green with no megarepo entry in `allowedRawOtelFiles` and no megarepo exemption in the oxlint config. (#771)

- **@overeng/megarepo**: Migrate the `mr store gc` RSS gauge + sampler + telemetry test onto the telemetry foundation primitives. The `megarepo_store_gc_rss_bytes` gauge is now defined through the schema-first `OtelMetric.gauge` contract (branded name + `repo_concurrency` label cardinality enforced) and emitted via the `OtelMetric.effect.gauge` bridge's `trustedSet` (schema-encoded label, no raw `MetricLabel`); the hand-rolled `Effect.withClock(Clock.make())` + `Schedule.spaced` sampler is replaced by the `sampleResource` primitive, which owns the real-clock tick and the telemetry-off no-op gate — so the call site in `store/mod.ts` drops its `Effect.serviceOption(OtelConfig)` double-gate (the `OtelConfig` requirement is discharged inside `sampleStoreGcRss`, keeping it out of the gc command's `R` so the bulk suites stay layer-free). The OTEL instrumentation test moves from a hand-rolled `Otelite.capture` + manual `inspect` loops to `OteliteTestHarness.runInProcessAllSignals` + the `expectTrace`/`expectMetrics` DSL, asserting the same contract (six gc phase spans, a `git/cmd` span with `git.output.bytes`, and the RSS gauge value>0 with a `repo_concurrency` label) and staying non-vacuous. Metric name + label semantics are unchanged. (#771)

- **@overeng/restate-effect**: Bind the `./otel` bridge's service identity to the shared `@overeng/otel-contract` brands. `service.name` is decoded through `OtelServiceName` (and `service.version` through `OtelServiceVersion` when set) at the resource-construction edge — the one place restate's raw config strings become branded — so restate obeys the SAME naming law as the CLIs (`makeOtelCliLayer`) and a malformed name is a defect at the composition root rather than a silent backend surprise. Consistency-only: the runtime mechanism (`NodeTracerProvider` + global registration, `unwrapScoped`, the `acquireRelease(provider.shutdown())` flush finalizer) is unchanged, and the public `OtelResourceConfig` / `layerConfig` plumbing stays raw `string`. restate sets name + version, not `service.namespace`, so no namespace binding is added. (#771)

- **@overeng/restate-effect + @overeng/utils**: Document restate's `./otel` provider-registration layer (`NodeTracerProvider` + `provider.register()` + global `AsyncLocalStorageContextManager`) as a DELIBERATE, structurally-required SIBLING of the shared `withTelemetry` / `makeOtelCliLayer` foundation — not a convergence gap. Restate's hook/bridge/observer read the active span through the `@opentelemetry/api` GLOBAL (`trace.getActiveSpan()`), so restate needs a globally-registered SDK provider; the shared path is pure-Effect `Otlp.layerJson`, which never touches the global registry. Bolting an SDK provider onto the shared `service` shape would double-export against `Otlp.layerJson` (split/duplicated traces) and drag `@opentelemetry/sdk-*` + a process-global onto every CLI consumer. Recorded in restate-effect decision 0007 with a one-line cross-reference comment at the `Otlp.layerJson` site in `@overeng/utils/src/node/otel.ts`. The shared `ServiceIdentity` struct from `@overeng/otel-contract` was NOT adopted at restate's identity-decode edge: the struct REQUIRES `service.namespace` (and a non-optional `version`), which restate does not set, so restate keeps decoding the individual `OtelServiceName` / `OtelServiceVersion` brands — adopting the struct would force a namespace invention / public-API change deliberately deferred. Docs/comment only; no runtime, type, or public-API change. (#771)

- **@overeng/utils + CLIs**: Migrate the remaining CLIs (genie, notion-md, notion-cli, workflow-report, notion-datasource-sync) onto the typed front door `withTelemetry({ identity, shape: 'cli', endpoint })`, each building a branded `ServiceIdentity` at its composition edge (so a raw-string service name is a `tsc` error). notion-datasource-sync's dynamic per-subcommand name folds into the branded path. With every consumer now on `identity`, the legacy `serviceName: string` option is **removed** from `makeOtelCliLayer` (clean break — `identity` is now required; no shim). (#771)
- **@overeng/otel-contract + @overeng/utils**: Add a typed `ServiceIdentity` (branded `OtelServiceName` + `OtelServiceNamespace` + `OtelServiceVersion`) and accept it on `makeOtelCliLayer` via a new `identity` option that stamps `service.{name,namespace,version}` onto the OTLP resource of ALL signals (traces, metrics, logs). `OTEL_RESOURCE_ATTRIBUTES`/`OTEL_SERVICE_NAME` env inheritance is preserved (explicit identity wins on collision, env-only attrs survive — covered by a new otelite-capture test). The legacy `serviceName: string` option still works (now optional; it will be `@deprecated` + removed once the remaining CLIs migrate to `identity`); `mr.ts` is migrated to the typed `identity` as the reference consumer (a raw-string name is now a `tsc` error on that path). The other five CLIs keep `serviceName` and compile unchanged. Tradeoff: providing neither `identity` nor `serviceName` is a runtime defect (`Layer.die`), not a compile error. (#771)

- **@overeng/utils-dev**: `makeOtelVitestLayer` now builds its in-process OTLP exporter via `Layer.suspend` (was `Layer.unwrapEffect(Effect.sync(...))`), matching prod `otel.ts` and using the scope-correct primitive for a lazily-built exporter. A new test (`otel-vitest-flush.test.ts`) locks the flush-on-shutdown guarantee: with a 60s export interval the span only lands AFTER the layer scope closes (pre=0 / post>0). (#771)

- **@overeng/utils + @overeng/megarepo**: Make OTLP shutdown-flush config-free. `makeOtelCliLayer`'s `shutdownTimeout` is now a safety _ceiling_ with a TTY-aware default (30s non-interactive / 10s interactive TTY) instead of a flat `2000`, and `mr.ts` drops its `50ms` override. The flush is a scope finalizer Effect awaits to completion, so the cap never adds latency on a healthy collector (exit ≈ one round-trip) and only bounds the worst case when the collector is black-holed; a too-small override interrupts the in-flight export and silently drops the final batch (the real bug behind "the gauge sometimes didn't land"). Export intervals are mid-run granularity only — the final batch flushes on scope close regardless. (#771)

- **@overeng/tui-react**: `runTuiMain` now exits **130** on signal interruption (Ctrl-C), the shell convention, via a custom `runMain` `teardown` that honors the `process.exitCode = 130` the interrupt branch sets (the default teardown forced 0 on a signal, clobbering it); uncaught failures still map to 1, success to 0. The shutdown-flush + exit-code contract is captured in `docs/spec.md` (Lifecycle & Cleanup) and `docs/.decisions/0001-shutdown-flush-contract.md`, and locked by a fast deterministic regression test (`test/integration/cli-shutdown-flush.test.ts`): natural exit awaits + lands the flush and is fast, a signal exits 130 and bails fast, success exits 0. (#771)

- **@overeng/utils-dev/otelite**: Resolve the `otelite` binary from `OTELITE_BIN` before falling back to `PATH`, and document the plain-shell Nix workflow for focused wrapper tests.

- **@overeng/otel-contract**: Add a schema-first GAUGE primitive to the `OtelMetric` family, mirroring counter/histogram: `OtelMetric.gauge` brands the metric name (`OtelMetricName`), takes a low/bounded-cardinality label schema with the same cardinality enforcement, and `OtelMetric.effect.gauge` exposes a typed Effect `Metric` runtime bridge whose `set`/`trustedSet` drive a gauge up and down (`Metric.set` on a tagged `Metric.gauge`). New `OtelGaugeDefinition` / `OtelEffectGauge` / `OtelEffectGaugeMetric` types and an `instrument: 'gauge'` metadata kind. This is the sanctioned path for the existing `mr store gc` RSS gauge; banning raw `Metric.gauge`/`Metric.set` in `no-raw-otel-primitives` is deferred to the Phase-2 consumer migration so the rule flip lands atomically with the only raw-gauge call site. (#771)

- **@overeng/utils**: Add the principled telemetry front door. `withTelemetry` / `TelemetryLayer({ identity, shape, endpoint })` wraps `makeOtelCliLayer` with a `Shape ∈ {cli, service, test}` that picks the correct export/flush defaults per CLI vs long-lived service vs deterministic test — so consumers select intent, not raw interval/timeout knobs. A `sampleResource` (+ `sampleGauge`) primitive generalizes the per-consumer RSS-gauge sampler: it forks a fiber that ticks on REAL wall time (`Effect.withClock(Clock.make())`) and is a NO-OP when telemetry is off (gated on the `OtelConfig` marker via `telemetryEnabled` / `whenTelemetryEnabled`), so no consumer re-derives the clock-decoupling or the double-`Option` gate. `makeOtelCliLayer` + the legacy `serviceName` path stay intact and exported. (#771)

- **@overeng/utils-dev/otelite**: Extend the in-process otelite capture layer from traces-only to ALL THREE signals (traces + metrics + logs), wired via the combined `Otlp.layerJson` (correct per-signal URL suffixing) under `Layer.suspend`. A new `runInProcessAllSignals` harness captures and asserts spans + metrics (counter/gauge) + `Effect.log` lines in one program against an ephemeral otelite receiver, so the shipped `expectMetrics`/`expectLogs` matchers are finally usable in-process (previously they had no in-process emission path and metric/log tests had to hand-roll the prod exporter). (#771)

- **@overeng/otel-contract**: Add branded/refined OTEL name schemas (`OtelAttributeKey`, `OtelSpanName`, `OtelMetricName`, `OtelServiceName`), validate contract names/keys at definition time, add an Effect `Metric` runtime bridge for schema-first metric contracts, and extend the raw-OTEL lint rule to ban raw Effect `Metric.*` APIs outside approved contract/test boundaries.

- **OTEL devenv module**: Stop requiring the retired legacy `otel` CLI in `OTEL_MODE=system`; dashboard refresh is now best-effort when a compatible legacy CLI is present, while shell setup still succeeds with the shared system stack.

- **@overeng/otelite-effect → @overeng/utils-dev/otelite**: Folded the standalone `@overeng/otelite-effect` wrapper package into `@overeng/utils-dev` as a new `./otelite` subpath export and deleted the standalone package. The wrapper is a dev/test util with no non-test consumer, and `utils-dev` already declares every dependency it needs (`@effect/platform`, `@effect/platform-node`, `@effect/opentelemetry`, `@effect/vitest`) and already uses subpath exports — co-locating it removes a `utils-dev ⇄ otelite-effect` cycle. The source moved to `packages/@overeng/utils-dev/src/otelite/` and the tests (incl. the D1 wire-level e2e) to `src/otelite/*.test.ts`. The public API is unchanged; consumers now import from `@overeng/utils-dev/otelite`. The `Otelite` service tag and the `Otelite*` error tags are renamespaced to `@overeng/utils-dev/otelite/*`. The tests still run the real nix-built `otelite` binary on `PATH` (provided by the dev shell). See `context/otelite/decisions/0015`.

- **CI / Nix packages**: Refresh the stale `genie`, `megarepo`, `notion-md`, and `tui-stories` pnpm fixed-output hashes after the schema-first OTEL contract change updated the workspace dependency closure.

- **@overeng/notion-md**: Move the v-next public CLI to `track` / `status` / `sync`: `track` is now the only page-id bootstrap command, `sync`/`status` operate on local self-describing files, write-capable paths support `--dry-run`, and `sync --watch` routes through the same source-aware reconcile engine as one-shot sync.

- **@overeng/notion-md**: Add explicit v-next destructive sync modes for unsupported-block deletion (`--allow-delete-unknown-blocks`) and literal Roughdraft markup writes (`--allow-review-markup`), validate referenced object-store payloads on v-next reads, and add `sync --gc-objects` with dry-run planning for unreachable content-addressed objects.

- **@overeng/notion-md**: Complete the v-next source-dispatched sync contract by requiring explicit `.nmd` `source`, removing legacy sync helpers from the public package surface, preserving watch as a first-class reconcile path, adding live watch and OTEL span verification, and aligning VRS/user docs with the stateless Mirror Sync vs base-backed Shared Sync split.

- **@overeng/notion-md**: Refresh the fidelity corpus from live Notion through repeatable capture tooling, add live corpus verification, and fold Notion's lossless code-fence language alias expansion (`js`/`ts` → `javascript`/`typescript`) into the semantic-equivalence oracle while keeping JavaScript and TypeScript fences distinct.

- **@overeng/notion-md**: Add schema-decoded Notion webhook trigger ingestion for watch mode. Page webhook payloads normalize to secret-safe trigger signals and feed the existing batch watch queue as `webhook` reasons; comment events are decoded and classified as an explicit non-body boundary until comments API/client support exists.

- **CI / Nix packages**: Refresh the `oxc-config`, `genie`, `megarepo`, and `notion-cli` pnpm fixed-output hashes to the values observed by PR #780 CI/local proof so lint, typecheck, test, and FOD validation jobs can realize their Nix dependencies again.

- **@overeng/megarepo tests**: Make the missing-remote sync error fixture deterministic by using a local `file://` clone failure instead of a fake GitHub SSH remote, and give the heavier cold store-GC liveness/archive integration case its own timeout budget.

- **@overeng/restate-effect tests**: Run Vitest files serially for the native `restate-server` integration suite so full-repo checks do not cross wires between concurrently booted SDK deployments.

- **CI / Nix packages**: Refresh the stale `workflow-report` pnpm fixed-output hash so the Storybook preview reporting step can build `#workflow-report` again after the branch rebase updated the workspace dependency closure.

- **@overeng/restate-effect**: Made `Restate.run`'s type HONEST. A durable `ctx.run` step carries NO catchable typed failure: the inner effect runs via `Runtime.runPromise` inside `ctx.run`, so a typed `Effect.fail` only REJECTS the step (Restate retries; a give-up maps to a `RestateError` DEFECT) and never reaches the outer failure channel — the old `run<A, E, R>(…): Effect<A, E, …>` advertised a typed `E` that `catchTag`/`catchAll` would typecheck against but that could never fire. `run` is now `run<A, R>(name, effect: Effect<A, never, R>, options?): Effect<A, never, …>`, and `runExit` is `runExit<A, R>(…): Effect<Exit<A>, never, …>` — the honest OBSERVATION form, whose failure channel is `never` (an observed failure is a defect/interrupt `Cause`, not a phantom typed `E`). Domain errors now belong in the HANDLER body (classify the step's result there) or are encoded as VALUES inside the step; to force a durable retry, DIE inside the step. A passed typed-`E` inner effect is now a COMPILE error (negative-type assertion in `capability-inference.types.ts`). Callers reconciled: the saga integration test's failing `pay` step `Effect.die`s (was `Effect.fail`), and `examples/12-self-reschedule.ts`'s `pollComposedSource` returns a tagged VALUE with `E = never` (classified in the cycle body, unchanged). `examples/14-http-error-classification.ts` already used the die-the-step / classify-in-body strategies; only its prose was corrected. VRS: decision 0003 (#4 — corrects the earlier "keep the inner `E` flowing through `run`"), 03-effect-runtime / 04-error-boundary specs, the guide handbook, and a DEFERRED typed-failure-transport `run` note (an encoded `fail(E)` journaled via an error schema). No dependency changes.
- **@overeng/restate-effect**: Centralized the contract-invocation policy into ONE boundary (`clients/InvocationPolicy.ts`, decision 0020), fixing two P2 client bugs by construction + the architectural root cause behind them. The annotation-derived transport facts — input/output serde (incl. the `Restate.sensitive`-field redaction transform), the `Restate.idempotencyKey`-field extraction, and the SDK opts bag — were previously assembled SEPARATELY in every adapter (endpoint materialization, each ingress client, the in-handler service-to-service clients, AND the testing harness, which built its own parallel `effectSerde`), so annotation support was partial by construction. **Fixed P2 bugs**: (1) `RestateIngress.call` (stateless Service) built its serdes WITHOUT the `RedactionCipher`, so a contract with a `Restate.sensitive` field was un-callable through ingress (the encode threw `RedactionCipherMissingError`) even though `objectCall` and the served handler both encrypted it; (2) the Service `call` passed no idempotency key, so a `Restate.idempotencyKey` input field did NOT dedupe a retry (unlike `objectCall`/`objectSend`). Now EVERY adapter — endpoint `handlerOpts`, all ingress paths (`call`/`objectCall`/`objectSend`/`workflowSubmit`/`workflowAttach`/`workflowOutput`/`workflowCall`/`result`/`resolveAwakeable`), the in-handler `callRpc`/`sendRpc`, AND the harness ingress + `stateOf` — consumes the one policy, so an annotation behaves consistently at every public entrypoint and `RestateIngress` carries the optional cipher (resolved from a `RestateRedaction` layer in context). `materialize*` now also VALIDATES annotation placement and FAILS LOUDLY when `Restate.idempotencyKey`/`Restate.sensitive` is applied to the input STRUCT instead of a FIELD (a silent no-op otherwise), or when two fields carry `Restate.idempotencyKey`. Covered server-free (`Annotations.test.ts` placement validation; `options-surfacing.test.ts` materialize-rejection) and against a native `restate-server` (`clients/contract-policy.integration.test.ts`: the invariant matrix over Service × Object × Workflow / call·send·attach — `sensitive` round-trips encrypted, `idempotencyKey` dedupes, terminal error decodes — verified to FAIL on the pre-fix code for both P2 findings). VRS: decision 0020, 02-schema-serde / 05-clients / 09-testing specs. No new dependencies; all 164 package tests green. KNOWN LIMITATION (since FIXED, see the later Fixed entry): the synchronous in-handler `callDescriptor` (used inside `Restate.all([...])`) cannot resolve the ambient cipher at construction time, so a `sensitive`-field redaction on a descriptor-issued peer call was not applied. Now resolved by threading the cipher through `Descriptor.issue` at issue time.
- **@overeng/restate-effect**: Internal `src/` reorganized into ten named subsystem subdirs (`authoring/`, `schema/`, `runtime/`, `error/`, `clients/`, `scheduling/`, `endpoint/`, `observability/`, `testing/`, `admin/`) so the code layout mirrors the VRS subsystem taxonomy. `Endpoint.ts` is split into the error-boundary classification + capability-marker machinery (`error/Boundary.ts`: `classifyOutcome` / `toTerminal` / `provideHandlerCaps` / the `Boundary*` types) and the serving/materialize layer (`endpoint/Endpoint.ts`); the shared bare admin client (`AdminApi.ts`) moves under `admin/`. Pure refactor: `mod.ts` stays the root barrel and the public export surface is unchanged — `.` / `./otel` / `./testing` / `./admin` resolve to the same exported symbols (the `package.json` `exports` map now points at the new internal paths). No behavior change; all 134 tests green.
- **@overeng/restate-effect**: VRS design docs restructured into the ten numeric subsystem dirs (`docs/vrs/01-authoring/` … `10-admin/`), mirroring the `src/` subsystem taxonomy. `docs/vrs/spec.md` is now a thin architecture index (Status + Scope + the architecture diagram + the cross-cutting Deferred + Open-design-question lists + a table linking each subsystem `spec.md`); the §-section bodies moved into each subsystem's `spec.md`, and the requirement bullets distributed into each subsystem's `requirements.md` PRESERVING the global IDs (R01–R39 / A01–A11 / T01–T08 — one ID per subsystem, never renumbered, so every cross-reference still resolves). Root `requirements.md` keeps only the cross-cutting faithful-binding stance + the global Assumptions/Tradeoffs; `vision.md` + `glossary.md` stay whole at root (inherited downward). `docs/vrs/decisions/` renamed to `docs/vrs/.decisions/` (dot-prefixed per `/sk-vrs`; `git mv` preserves history, all 0001–0019 records unchanged in content). External path references updated to the new locations (`README.md`, `docs/guide/*`, `src/schema/{Serde,Annotations}.ts` doc-comment links, intra-VRS cross-links, epic #757). Docs-only — no library surface change.

- **genie/ci-workflow**: Skip workflow-report PR comment publishing for fork
  pull requests after writing the job summary, so preview-reporting jobs do not
  fail when GitHub downgrades the `pull_request` token to read-only.

- **@overeng/genie**: Give the entry-purity compiler test an explicit timeout
  so Linux CI load does not fail the semantic guard under Vitest's default 5s
  test timeout.

- **@overeng/notion-md / @overeng/notion-datasource-sync**: Address PR review regressions for datasource body/property settlement and workspace establishment. Verified body-push settlement now preserves existing `.nmd` writable frontmatter properties, `--sqlite data/v1/<source>.sqlite` selects the matching manifest source in multi-source workspaces, and `track` writes `notion.workspace.v1.json` only after successful establishment. Public SQLite replicas now treat macOS `/var` and `/private/var` temp-path aliases as the same workspace for move detection, avoiding false `moved` status while still detecting copied data files. Also makes GFM autolink canonicalization idempotent for generated canonical bodies.

- **@overeng/notion-datasource-sync**: `keep-local` resolution of a lifecycle conflict now STAYS FROZEN until the re-assert settles, closing a durable silent last-writer-wins hole (#775 M2a'-2, XC-R02). Previously `keep-local` fully `resolved` the conflict and enqueued a re-assert (`TrashPage`/`RestorePage`); if the remote had actively diverged (e.g. it restored the page), that re-assert push BLOCKS (`StaleSurfaceBase`/tombstone-safety) and never settles. On the next sync, re-detecting the SAME local/remote divergence produces a byte-identical idempotency-keyed `ConflictRaised` (key = `conflict:<surface>:<localHash>:<remoteHash>`, lifecycle hashes are independent of `propertiesHash`) that dedups against the already-`resolved` conflict, so the freeze gate saw NO open lifecycle conflict and the `RowObserved` apply silently flipped `_nds_row.in_trash` to the remote value — the exact XC-R02 violation the feature prevents. Fix ("stay frozen until the re-assert settles"): a new `resolving` conflict state (schema v8, migrated by recreating the pure-projection `_nds_conflict` CHECK) — `keep-local` on a lifecycle conflict moves to `resolving` (NOT `resolved`) and keeps its re-assert enqueue; the `#hasOpenLifecycleConflict` freeze gate (and the compaction-safety + status-count surfaces) treat BOTH `open` AND `resolving` lifecycle conflicts as freeze-active, so `in_trash` stays at the local target `L` while the re-assert is pending/blocked; the `RemoteWriteSettled` F8 handler transitions `resolving` → `resolved` ONLY when the re-asserted `TrashPage`/`RestorePage` genuinely settles (L re-established remotely, divergence gone), replay-deterministically by piggybacking the in_trash reconvergence. A re-detected same-divergence `ConflictRaised` still dedups, but because the `resolving` conflict keeps the freeze active there is no silent flip — the conflict stays visibly unresolved. `keep-remote` is unchanged (still resolves and reconverges to the remote target). SUPERSEDES the M2a'-2 KNOWN LIMITATION about `keep-local` (the re-detected-after-resolution case is now safe by construction, not merely deduped). Covered by a kill-test (keep-local + blocked re-assert + second sync with a novel `propertiesHash`: conflict count stays 1, state `resolving`, `_in_trash` stays at L, no silent flip), a settle test (re-assert settles → `resolving` → `resolved`), and replay-determinism + keep-remote regression tests.

- **@overeng/notion-md**: Make the SM6.2 comment-write boundary mutation-implying instead of presence-based. The guard previously blocked any push/pull/shared write to a page that merely HAS comments — including a body-only edit — but `updateMarkdown({_tag:'replace_content'})` writes only body content and is structurally incapable of creating/editing/resolving a Notion comment, so that block was fictitious and over-blocked legitimate body edits on commented pages. `classifyCommentWrite` now compares the comment inventory the write would PRODUCE against the current inventory and blocks only on a genuine add/remove/modify; for today's body-only write paths `produced === current`, so a body edit on a commented page proceeds (`pushed`/`pulled`/`shared-merged`) and the named `CommentWriteUnsupported` guard is a dormant fail-closed gate that trips only when a real comment-mutation path is ever wired. The `shared` comment guard moved from the top of `reconcileSharedFile` into the `merge`/`force` write branches (symmetric to how single-source guards scope to push/pull), so the `noop` shared branch no longer evaluates it. Block-detection coverage lives at the classifier-unit level (the dormant block path is not reachable end-to-end today); the `NmdNonBodyWriteBlockedError.fileIds` JSDoc now documents that the field carries the offending unit ids — file or comment — discriminated by `guard`.
- **@overeng/notion-effect-client, @overeng/notion-md**: Canonicalize hosted-media URLs so media-bearing bodies are idempotent and pushable (R36, decision 0007). Notion-hosted media (`type: "file"`) renders with an expiring signed S3 URL whose `X-Amz-*`/signature/`Expires` query params rotate on every pull, making the rendered body hash volatile (breaking `cat`→`put` idempotence and staling base hashes with zero edits) and causing `update_content`/`replace_content` pushes on media pages to be rejected by the post-push `semanticEquivalent` gate. A shared `canonicalizeMediaUrl` (and `canonicalizeMediaUrlsInMarkdown`) in `notion-effect-client` strips only the volatile signature/expiry query-param family by name (origin + path + any benign params kept). The renderer applies it in `getBlockUrl`'s Notion-hosted `file.url` branch so pull/`cat` output is deterministic; `canonical-markdown.ts` applies the identical function inside `canonicalizeBlockMarkdown`/`semanticEquivalent` so the gate compares the same canonical form. External (stable) URLs — including ones carrying a benign query param — are left untouched. Verified with deterministic unit tests (signed→canonical, rotated-signature equality, external-with-query untouched) and live E2E on real Notion: a hosted+external-media page's body hash is stable across two no-op pulls and a no-op push is not rejected by the post-push gate.
- **@overeng/notion-core, @overeng/notion-md**: Fix silent body-data loss on push for renderable-but-not-round-trip-safe blocks (R38, #785). The body-fidelity classifier (`classifyBodyCompleteness`) previously flagged only API-`unsupported` blocks, so `child_database` (`[embedded db]()`), `table_of_contents` (`[TOC]`), `synced_block`, `child_page`-in-body, and degraded `bookmark`/`embed`/`link_preview`/`breadcrumb`/`link_to_page` classified `complete`. They render to Markdown that Notion re-parses as a plain paragraph on push, so editing an _unrelated_ paragraph and pushing silently destroyed the untouched block (live-proven on real Notion; affected file `sync`, not just the planned editor). The classifier now also flags a curated set of known not-round-trip-safe types (criterion: body-Markdown rendering does not reparse to the same block — a type set because notion-core is pure and the endpoint/independent renderings agree, so a suffix heuristic can't catch them), surfaces the offending types in the lossy verdict, and the shared refusal gate (`assertRemoteMarkdownComplete`) refuses such pages at the pull on every surface (`cat`/`put`/`edit`/file `sync`) with a message naming the block class and pointing to the Notion UI (`NmdRemoteBodyLossyError`, exit 3). `child_page` has a dual role: a child page that is a tree node (its own `.nmd` file) is tolerated via `tolerateTreeChildPages` on the tree path while still being refused as a single page's body block, and any _other_ lossy block on the same tree node is still refused. Verified with deterministic classifier/gate unit + fake-gateway tests and live E2E (lossy page refused at pull, representable page still round-trips). Hosted/external media stays representable (decision 0007).
- **@overeng/notion-cli**: Fix the umbrella `notion` binary crashing at startup for every command with `ReferenceError: Cannot access 'createTuiApp' before initialization` (#787). `runRootCli` (`cli.ts`) imports the three command trees concurrently via `Promise.all`, and each schema/db renderer's `app.ts` built its `*App` by calling `createTuiApp(...)` as a module-load side-effect. Under Bun's concurrent async module evaluation that top-level call reached the shared `@overeng/tui-react` module graph while it was still mid-initialization, so a re-exported binding (`createTuiApp`, then its body's `createInterruptedAction`, …) was in the temporal dead zone. Root cause is the module-load side-effect, not a barrel export-order/TDZ bug and not a circular import (verified: the only barrel self-imports are JSDoc; converting `createTuiApp` to a hoisted function only relocated the crash to the next top-level const). Fix: all five renderer `app.ts` modules (`Diff`/`GenerateConfig`/`Generate`/`Introspect`/`Info`) now construct their `*App` lazily via a memoized `get*App()` accessor instead of at module top level, so no `createTuiApp(...)` runs during import; the shared `tokenOption`/`resolveNotionToken` helpers also moved out of `schema/mod.ts` so the concurrently imported `db` tree no longer reads a schema export while that module is still evaluating. The memoization preserves the previous single-instance (one registry/atom set) semantics. Confined to `notion-cli` — no change to shared `@overeng/tui-react`. Regression test (`src/concurrent-import.unit.test.ts`) spawns the umbrella's concurrent `Promise.all` import path under Bun (the binary's runtime) and asserts no TDZ crash; verified RED on the pre-fix code and GREEN after.
- **@overeng/notion-effect-client**: Restrict `canonicalizeMediaUrlsInMarkdown` to known Notion-media hosts so an external signed URL is preserved (PR #786 review, P1). The Markdown-string canonicalization path — run by `canonicalizeBlockMarkdown` on both pull and push — previously stripped the volatile `X-Amz-*`/signature/`Expires` params from _any_ signed-looking URL by param name, so an external private-S3 image embedded by URL would lose its load-bearing credentials and, because canonicalization now runs on both wire boundaries, could be surfaced and then persisted broken. Unlike the renderer (`getBlockUrl`, which only canonicalizes `type: "file"` URLs), the string path cannot see `file` vs `external`, so it now gates on a Notion-media host allowlist (`prod-files-secure.s3.us-west-2.amazonaws.com`, `file.notion.so`, `*.notion.so`, `*.notion-static.com`, and the older `s3.../secure.notion-static.com/...` bucket-in-path form); non-Notion hosts are left untouched. `canonicalizeMediaUrl` itself stays host-agnostic (the renderer feeds it only known-hosted `file` URLs, so its idempotence guarantee is unchanged). Regression test: an external signed S3 URL on a different bucket host inside Markdown is preserved verbatim.
- **@overeng/notion-effect-client**: Declare `@overeng/utils` as a runtime dependency (PR #786 review, P2). `config.ts` imports `sha256Hex` (`notionTokenFingerprint`) from `@overeng/utils` in production code, but the package listed it only as a dev/peer dependency, so a standalone install could fail to resolve it at runtime. Moved `utilsPkg` into the generated runtime `dependencies` (`package.json.genie.ts` + `dt genie:run`). The regeneration also reconciled a pre-existing stale generated `package.json` — a leftover external `peerDependencies` block the current genie source no longer emits — which had drifted the lockfile and broke the frozen-lockfile Nix build.
- **@overeng/notion-cli**: Apply the editor exit-code teardown to the umbrella `notion edit` alias (PR #786 review, P2). The standalone `notion-md` binary maps tagged editor failures to the scriptable exit codes (3 lossy / 6 schema-drift / 8 abort, …) via a `runMain` teardown, but the umbrella `notion` root used the default teardown, so `notion edit` collapsed those to the generic exit 1 — diverging from `notion-md edit` for scripts. The umbrella now wires the same `editorExitCode` teardown; safe for the non-editor commands (`editorExitCode` falls back to 1 for any unmapped failure and 0 on success, matching the previous default), with Ctrl+C now mapping to 130 consistent with the standalone binary. Runtime e2e of the umbrella binary remains gated on #787.
- **@overeng/megarepo**: `mr store gc` / `mr store status` no longer OOM the host on a worktree with a large untracked tree (decision 0007, bounded memory). The dirt path (`git status --porcelain --untracked-files=all`) previously buffered the full subprocess output through an O(n²) per-chunk `Uint8Array` concat (10.3 MB / 64k untracked files → 269 MB peak; 80 MB → OOM); under `mr store status`' 64-way fan-out that compounded to multi-GB. Now: `runGitCommand`'s output concat is a single O(n) allocation, and the three unbounded parsers (`getWorktreeStatus` / `getWorktreeRemovalStatus` dirt count, `listWorktrees`, `revListUnpushed`) fold their stdout line-by-line through a streaming `Sink` at constant memory via a new `streamGitCommandLines` helper (which preserves `GitCommandError` exit-code/stderr semantics — naked `Command.streamLines` drops both). `changesCount` stays EXACT (count Sink), so verdicts are byte-for-byte unchanged. A new subprocess-isolated memory regression (`git-memory.integration.test.ts`) asserts the dirt path stays under a constant per-process RSS growth — it FAILS on the old O(n²) code (~225 MB) and passes on the streaming path (~40 MB) (#771).
- **@overeng/megarepo**: `mr store gc` is now instrumented and its per-repo concurrency is tunable, so the memory↔throughput operating point can be fixed experimentally via OTEL (decision 0007). Per-repo concurrency is read from `MEGAREPO_GC_REPO_CONCURRENCY` (default 4, fixed by the OTEL sweep — see the operating-point entry below; back-pressure stays structural via bounded `Stream.mapEffect`, and reconcile-all + per-worktree locks keep cross-megarepo safety regardless of the value). New phase spans `megarepo/store/gc/{collect-liveness,list-repos,collect-worktrees,resolve-pr,cold-reclaim,legacy-sweep}` carry `repo.count`/`worktree.count`/`repo_concurrency`; each git subprocess gets a `git/cmd` span with `git.output.bytes`/`git.output.lines` (from scalar streaming counters, never a buffer); and a `megarepo_store_gc_rss_bytes` gauge samples `process.memoryUsage().rss` across the run, labelled by `repo_concurrency` so a sweep yields one comparable series per operating point. The RSS sampler fiber forks only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (zero overhead otherwise). Progressive gc dispatch no longer copies the whole results array (`results: [...results]`) on every batch — the read-only accumulator is passed by reference; the `-o json` document schema is unchanged. Verdicts are unchanged at any concurrency (#771).
- **@overeng/utils + @overeng/megarepo**: Resolve the OTLP endpoint at the composition root instead of reading `process.env` ambiently in library/command code, so tests need ZERO OTEL env handling (decision 0007). `makeOtelCliLayer` becomes a pure function of an explicit `endpoint: Option<string>` (when provided it is authoritative and the layer never reads `process.env`; an env fallback is retained for callers not yet migrated) and stays `Layer.suspend` so exporter finalizers still flush on shutdown. A new `otelEndpointFromConfig` helper resolves the endpoint via Effect `Config.option(Config.string('OTEL_EXPORTER_OTLP_ENDPOINT'))` at the binary edge; the layer also provides the resolved endpoint as an `OtelConfig` context tag, which the `mr store gc` RSS-sampler gate now reads via `Effect.serviceOption` rather than `process.env['OTEL_EXPORTER_OTLP_ENDPOINT']`. The megarepo bulk test suite is now hermetic by construction — it runs `mrCommand` without `makeOtelCliLayer`, so no exporter exists and the sampler gate is a no-op regardless of any ambient endpoint — and the prior `delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT` workaround in the test setupFile is removed (verified: env set + no test handling ⇒ zero `POST /v1/{traces,metrics}` reached a listener, full suite green, no hang). The otelite capture test passes its receiver's endpoint explicitly into the layer (no env mutation). This is a reusable cross-project pattern for any env-derived config; the other `makeOtelCliLayer` call sites (genie, workflow-report, notion-datasource-sync, notion-md, notion-cli) keep the env fallback and can migrate incrementally (#771).
- **@overeng/megarepo**: Fix the gc operating point at `MEGAREPO_GC_REPO_CONCURRENCY` default **4**, proven by an end-to-end OTEL sweep (decision 0007). On a 1200-worktree isolated store with a `gh`-latency shim, wall time was 25.2 s → 11.4 s (2.2×) from concurrency 1 → 4; 4 → 8 added ~7% and 8 → 32 sat at the run-to-run noise floor, while peak process-tree RSS stayed ~537 → 633 MB (flat, sub-GB) — throughput is the binding constraint and its knee is 4. Two latent instrumentation defects were fixed along the way: (1) the `megarepo_store_gc_rss_bytes` sampler coupled its `Schedule.spaced` cadence to the ambient clock, so a zero-sleep decision clock (in tests) turned it — and the OTLP exporter's reader fibers — into a hot loop; the sampler now ticks on real wall time via `Effect.withClock(Clock.make())`, decoupled from gc's decision clock. (2) The exporter's `metricsExportInterval` is now tunable (`@overeng/utils` `makeOtelCliLayer`) and set to 1 s in the `mr` binary, so the gauge flushes within a short run instead of being undersampled by the 10 s default. A new in-process otelite-capture test (`src/cli/store-gc-otel.integration.test.ts`) stands up an ephemeral OTLP receiver, runs gc through the real exporter, and asserts the six phase spans, a `git/cmd` span carrying `git.output.bytes`, and the RSS gauge (value > 0, `repo_concurrency` label) all land — non-vacuous (RED when the sampler is stubbed or a phase renamed). Bulk verdict tests stay hermetic w.r.t. OTLP; telemetry-asserting tests opt back in with their own receiver (#771).
- **@overeng/megarepo**: Cold `mr store gc` now never reclaims a repo's **default branch** (read offline from the bare's `HEAD`), independent of PR state or liveness. Dry-run validation against the real store found a vendored dependency's `main` worktree archive-eligible via a `headRefName=main` PR-join false-positive while not in any recorded live set; the guard (keep reason `default-branch`, decision 0004) closes the `main`/`master` hazard as a belt-and-suspenders complement to the cross-megarepo veto (#771).
- **@overeng/megarepo**: Harden the cold named-branch `mr store gc` reclamation path against an adversarial review. (1) **Archive freed no branch for production worktrees**: a production `refs/heads/*` worktree is NON-DETACHED, so after `git worktree move` the moved worktree still has the branch checked out and `git branch -D` is REFUSED (`cannot delete branch used by worktree`), leaving the branch unfreed and a later `mr apply` re-add broken (invariant 4). Fixed by detaching the moved worktree's HEAD (`git checkout --detach`, new `Git.detachWorktreeHead`) before freeing the ref; covered by a new integration test using a non-detached worktree (the prior fixtures only used `--detach`, masking the defect). (2) **Liveness registry writes were non-atomic**: `refreshWorkspaceRegistry` and the under-lock reconcile rewrite used plain `writeFileString`, so a torn read during a concurrent gc reconcile could drop a workspace's live-set veto (decision 0002 hard veto); both now route through `writeFileAtomic`. (3) **Partial-archive mis-reporting**: once the move succeeded the result is now `archived` with the real `recoverPath` (post-move branch-free + README steps are best-effort-but-reported via a warning), instead of falsely reporting `error`/"left intact". The `.archive/README.md` append is now an atomic write. New tests cover the archive-time live-set veto re-check, `loadStoreGcConfig` file load + corrupt-file degradation, a CLOSED-PR archive, dry-run reap intent, the unclean-reconcile grace withholding/restart, and `writeFileAtomic` temp-cleanup on a rename failure (#771).

- **@overeng/genie**: Respect repository ignore rules during `.genie.ts`
  discovery, so ignored local state such as nested agent worktrees does not
  become ambient generation input while untracked non-ignored generator sources
  are still discovered. Checked-out Git submodules are now included in the
  tracked discovery path as well.

- **@overeng/otelite**: Honor durability-before-ack — flush each export to the kernel before the 200/OK. `tokio::fs::File` buffers writes, so `write_all` alone did NOT guarantee the bytes reached the kernel before the sink acked; an independent reader (or a crash) before the next flush could miss them, contradicting R05 ("flush … before acking") and the `append_line` doc's own "durably reaching the kernel before returning" promise. This surfaced as a CI flake in the `durable_before_ack` gate (a read immediately after the 200 occasionally saw an empty file under thread contention — reproduced ~1/60 at 16 test threads). Fix: `SignalFile::append_line` / `append_json` now `flush()` after `write_all`, before returning. This is a flush, not an fsync — `sync_all` (physical-disk durability) stays deferred to shutdown, so the M2 "no per-export fsync under the lock" throughput decision is preserved. Verified: 0 failures over 200 × 16-thread runs (was ~1/60).
- **@overeng/otelite**: Make the HTTP-JSON metrics receive path lossless, fixing two silent data-loss bugs a stress test surfaced. The upstream `opentelemetry-proto` `with-serde` deserialize — which the receiver used to BUILD the proto value the sink then re-serialized — silently drops several metric JSON shapes: a `sum`/`gauge` `NumberDataPoint` whose int64 value is the default string form (`"asInt":"7"`) lost its value entirely (captured null), and a regular `histogram` metric was dropped down to `{name,description,unit,metadata}` (its data oneof gone). Both returned HTTP 200 + bumped `counts.metrics` → a silent mis-capture that violates the lossless + "loud, never silent" contracts (decisions/0011). Fix: on the JSON metrics path, `with-serde` still runs purely as the dialect VALIDATOR (Err → 400 + `note_rejected`, gate unchanged), but on success the receiver now persists the VALIDATED RAW JSON body verbatim (re-emitted through `serde_json::Value` via the new `Sink::write_metrics_json`, counting metrics from the JSON structure) instead of the lossy proto re-serialization. Since the body is already canonical OTLP/JSON and `inspect` walks raw JSON, the JSON metrics path is now lossless for string-int64 sums/gauges, regular histograms, AND exponential histograms — the last also RESOLVING the previously-documented exp-histogram-on-JSON limitation for the receive path. Traces/logs JSON paths and all protobuf/gRPC paths are unchanged (already lossless). New gates (real receiver, no mocks): an HTTP-JSON round-trip of a string-int64 sum + histogram + exponential histogram all survive receive → capture → `inspect`; cross-transport equivalence extended to metrics (the same logical string-int64-sum + histogram over HTTP-JSON vs HTTP-protobuf vs gRPC flattens to equivalent `inspect` rows, the proto/gRPC fixture built natively to avoid the lossy `with-serde` source); and a loud-rejection guard that a malformed metrics JSON body still 400s + is captured nowhere. KNOWN RESIDUAL: the upstream metrics `with-serde` is more lenient than the trace one, so for metrics the JSON dialect gate is effectively structural (malformed JSON / hard field-type mismatches), tolerating some non-default dialect shapes (numeric int64 nanos, string enums) rather than rejecting them loudly — a stricter metrics dialect gate is a follow-up (#769, #772).

### Added

- **@overeng/notion-effect-client / @overeng/notion-md**: Add optional `property_descriptors` field to `NmdFrontmatterV2` — compact, non-authoritative property identity hints (property_id, property_type, data_source_id, config_hash) embedded in `.nmd` frontmatter for datasource page files. Decoded strictly (unknown fields rejected, R13); field is absent for standalone pages and omitted from encoded output when not set (R10). `buildFrontmatterV2` in `sync.ts` gates descriptor emission on datasource parent presence. Standalone validity enforced: a descriptor-bearing `.nmd` round-trips via the standard `notion-md` parse path (R03). `docs/file-format.md` updated with a Property Descriptors section.

- **@overeng/megarepo**: `mr store gc` now reclaims **cold** named-branch (`refs/heads/*`) worktrees, the dominant store accumulation that default gc previously protected unconditionally. A named worktree is reclaimed only after passing layered, short-circuiting gates: (1) a hard cross-megarepo live-set veto (`collectStoreLiveSet`, store-wide — a `repos/` symlink alone never protects; only a recorded `livePaths` entry does); (2) staleness — the branch's GitHub PR is merged or closed (an open PR, no PR, or any `gh`/resolver failure ⇒ keep); (3) a lossless floor — every local commit is reachable on a remote (`git rev-list <head> --not --remotes` empty after `fetch --prune`), no stash, no unpushed commits, and a per-repo fetch failure keeps all of that repo's worktrees; (4) three grace timers tracked against a persisted observation ledger — _absence grace_ (default 14d) for every cold worktree, plus a _post-merge grace_ (default 7d after `mergedAt`) for merged branches (closed-unmerged has no post-close grace). Capture is two-phase: a qualifying worktree is `git worktree move`d to `<repo>/.archive/<branch>--<ISO8601>/` and its local ref freed (so `mr apply` re-materializes it), then **reaped** (hard-deleted) once it ages past the _archive retention TTL_ (default 30d); gc also reaps pre-existing `.archive/` worktrees it formerly ignored. Timers are overridable via `$STORE/.state/gc-config.json`. Before any deletion gc reconciles ALL registered workspaces (not just the current one), and `mr apply`/`sync`/`pull`/`pin` now refresh the liveness record — closing a bug where a repinned-but-unre-registered workspace's _live_ worktree could be deleted; reconcile-all fails safe (a present-but-unreadable workspace keeps its last-known live paths, and grace is not advanced for an unclean reconcile). Archive and reap both re-check the live-set veto under the worktree lock immediately before acting. Provably lossless and conservative: absence of evidence never licenses deletion. `mr store gc --json` results gain `archived`/`reaped`/`kept` statuses with a stable `reason` tag and (for `archived`) a `recoverPath`. `--all` is unchanged (nuclear, live-set-bypassing). Design in `docs/decisions/0001`–`0006`, terms in `docs/glossary.md`, spec in `docs/spec.md` (#771).
- **@overeng/otel-contract**: Add the schema-first OTEL operation and metric-contract DSL (`OtelOperation`, `OtelMetric`, `OtelSpan.withStream`, attribute builders, compiled metadata, `encodeSync`, and checked dynamic span-map annotations) and migrate product instrumentation across the repo off raw `Effect.withSpan` / `Stream.withSpan` / `Effect.annotateCurrentSpan` and normal `unsafe*` contract calls. The contract remains runtime-light: it owns schema-backed names, labels, attributes, cardinality metadata, and encoders, while package-local code keeps exporter/provider setup, service identity, Restate replay gates, and runtime-specific bridges. `@overeng/oxc-config` now ships `overeng/no-raw-otel-primitives` with generated rollout config, `@overeng/utils-dev/otelite` gains reusable metric/log expectation helpers, and `restate-effect` adopts the same idiom for internal spans while preserving hook-owned Restate spans and replay-aware metrics.

- **@overeng/utils/node/otel-attrs**: Add schema-first OTEL attribute and span contracts (`OtelAttr`, `OtelAttrs`, `OtelSpan`) plus otelite expectation helpers that derive span assertions from the same compiled attribute encoders used by runtime instrumentation. Ambiguous encodings fail closed unless explicitly annotated, redacted values only support redacted/drop policies, and span definitions require the dedicated `OtelAttr.spanLabel()` contract.

- **@overeng/utils-dev/otelite**: Add an Effect-native otelite test harness and trace assertion DSL. `OteliteTestHarness` wraps scoped `Otelite.capture` lifetimes, in-process OTLP exporter wiring, serialized env-backed capture setup, flush-before-inspect helpers, and ergonomic `captureTest` / `captureInProcessTrace` / `captureEnvTrace` helpers. `expectTrace` adds runner-agnostic span assertions for service/name/attribute matching, `span.label` enforcement, and same-trace topology checks.
- **@overeng/utils-dev/otelite**: Add a vitest ↔ otelite capture bridge that wires an in-process `Otelite.capture` receiver to a vitest test's OTLP trace exporter, so spans emitted IN-PROCESS through the normal `@effect/opentelemetry` `OtlpTracer` layer land in a capture the test can assert over. `makeOteliteCaptureLayer(options?)` is a scoped `Layer` that boots ONE receiver, exposes its `CaptureHandle` via the new `OteliteCapture` `Context.Tag`, AND installs the trace exporter pointed at `${handle.endpoints.http}/v1/traces`; used with `@effect/vitest`'s `layer(...)` it gives a PER-FILE lifecycle (one receiver per test file, shared across that file's tests; tests disambiguate by a unique `service.name` / span name) — the cheap default per decision 0015, with per-test available by giving each `layer(...)` its own instance. A test does `const cap = yield* OteliteCapture; …; yield* cap.inspect({ signal: 'traces', name })`. `flushCaptureSpans()` force-flushes the exporter (the emitter's job) before inspecting. Silent-failure guard: a misrouted exporter (the `/v1/traces` suffix bug, see Fixed) lands nothing, so the demonstrator's non-zero `inspect`/`span_count` assertions FAIL the test rather than pass vacuously. Real-binary tests emit a span in-process through the REAL exporter and assert it round-trips, plus a regression that a bare un-suffixed URL captures nothing (#769, #772).
- **@overeng/notion-effect-client**: Add a real-consumer span-assertion demonstrator (D3, decision 0015) co-located in this client's own test suite (`src/test/otelite-span-shape.test.ts`). It drives the REAL instrumented query path (`NotionDatabases.query` → `executeRequest` → `Effect.withSpan('NotionHttp.POST')`) against a STUB upstream — a `HttpClient.make(...)` answering the one `POST /data_sources/{id}/query` endpoint with a canned empty paginated list + `x-ratelimit-remaining`/`x-request-id` headers — under the `@overeng/utils-dev/otelite` capture bridge, with NO secrets and NO network. It asserts the emitted span shape: exactly one `NotionHttp.POST` span carrying the templated `notion.http.route` = `/data_sources/{data_source_id}/query` + `notion.http.method`/`operation`/`status_code` (200) + `notion.rate_limit.remaining` (42); exactly one auto `http.client POST` child from `@effect/platform` whose `url.path` proves the stub served the request; a non-zero `span_count` (silent-export guard); and a public-repo leak guard that NO captured span attribute carries an `authorization` header or the token value (`@effect/platform` records only a header subset and excludes Authorization). The churn-coupled `notion.http.*` assertions sit next to the instrumentation that churns; the bridge stays a lean shared helper. The shadowing gotcha (the bridge re-exports the exporter's `FetchHttpClient` as `HttpClient.HttpClient`) is resolved by providing the stub to the effect-under-test directly (`Effect.provide`, innermost-wins) so the consumer sees the stub. Runs the real nix-built `otelite` binary on `PATH` (#769, #772).
- **@overeng/utils-dev/otelite**: Add a scoped in-process `Otelite.capture` primitive for harnesses that own the system-under-test lifecycle themselves (vs `run`, which spawns the child). `capture(options?)` spawns `otelite capture` with piped stdin/stdout and yields a scoped `CaptureHandle` (`endpoints`, `outDir`, `inspect`, `summary`). It learns the ephemeral receiver endpoints by decoding the FIRST stdout line against a new `EndpointsEvent`/`otelite.endpoints/v1` `Schema` — dispatching on the `schema` tag, never string-scraping. Closing the scope stops the receiver by closing the child's stdin (EOF), drains in-flight exports, and resolves `handle.summary` (the final `otelite.summary/v1` line); teardown is interrupt-safe so an interrupted scope leaves no orphaned child. The handle's `inspect` pins `src` to the out-dir and does a small bounded short-poll retry on a transient 0-row read (the receiver writes each export straight to the file with `write_all` before acking, so a captured span is durable immediately — but an independent reader can briefly observe 0 rows from pure scheduler/fs-visibility latency). Real-binary tests raw-POST a known OTLP/JSON span and assert the typed `SpanRow` round-trips through `inspect` and `summary.counts.spans` (#769, #772).
- **@overeng/notion-datasource-sync**: Replace legacy body hash pointers with typed `BodyIdentity`/`BodyProjectionPayload` semantics so remote body evidence, rendered content digests, safety, materialization, and OTel body attributes have explicit ownership boundaries and cleaner replay/testing contracts (#766).
- **@overeng/content-address + Notion body sync**: Add reusable content-address primitives (`ContentDigest`, `ContentDescriptor`, canonical JSON hashing, descriptor verification) and use Notion body observation evidence fingerprints for guarded body planning and settlement.
- **@overeng/otelite**: Incubate a coordination-free local OTLP capture tool for E2E and instrumentation tests — effect-utils' first Rust package. Native receiver (HTTP json+proto + gRPC) runs a child with `OTEL_*` env, captures canonical OTLP/JSON, and feeds `inspect` for assertions; a typed Effect wrapper sits on top. M1a lands the Nix build lane (`nix build .#otelite`, `nix run .#otelite`). VRS in `context/otelite/`; epic in #772 (#769).
- **@overeng/otelite-effect**: Add a thin, Effect-native wrapper package around the `otelite` CLI (M9). Shells out via `@effect/platform` `Command` (no `node:child_process`), decodes the CLI's seven `otelite.<name>/v1` JSON schemas with `Schema`, and exposes an `Otelite` `Effect.Service` with `run` (scoped capture of a child) and `inspect` (typed rows or summary per signal). otelite's `sysexits.h` exit-code taxonomy maps onto tagged errors (`OteliteSpawnError`, `OteliteChildFailed`, `OteliteCliError`, `OteliteDecodeError`). The CLI JSON output is the single source of truth — the wrapper never reimplements capture/inspect. Tests run the real nix-built binary (#769, #772). Adds a real end-to-end test (D1): a hand-instrumented Effect emitter (a `@effect/platform` `HttpClient` POST of a known OTLP/JSON span, no OTel SDK / no new deps) runs as the child under `Otelite.run`, and the span round-trips back out through the typed `inspect` (`SpanRow` + `TraceSummary`, `Schema`-validated) — closing the wrapper↔binary loop on the wire.
- **@overeng/otelite**: Close the test-coverage gaps the stress-test pass surfaced, and generalize the example goldens into laws. (A) Targeted end-to-end gates for paths only unit-tested before: gRPC now drives metrics AND logs (not just traces) through the receiver; an exponential histogram round-trips the protobuf receive path → capture → `inspect --signal metrics` (the JSON path drops it, an upstream gap); and a SIGINT mid-`run` (whole-process-group Ctrl-C) is a regression guard proving otelite swallows its own signal, lets the child take it, drains, and still emits the summary reporting `128+SIGINT`. (B) Property-based invariants (`proptest`, dev-only) for the two derivation paths whose one real bug (the OK-span error miscount) motivated them: `derive_spanmetrics` (`calls` partition the spans; ERROR subset = status code 2; one `duration` per dimension; buckets sum to count; min≤mean≤max) and `inspect::summarize` (span/error/zero-duration counts match the population regardless of order/grouping). 43 crate tests green; `nix build .#otelite` `doCheck` runs them in-sandbox (#769, #772).
- **@overeng/notion-core + @overeng/notion-effect-client**: Add shared Notion body-fidelity vocabulary and live Markdown/block-tree observation so downstream packages can distinguish complete remote bodies from lossy endpoint output.
- **@overeng/restate-effect**: Docs-refinement pass + the HTTP error-classification consumer recipe. (1) A new verified example `examples/14-http-error-classification.ts` (+ `src/error/http-error-classification.integration.test.ts`) shows an `HttpClient` call classifying real HTTP outcomes into the typed error channel — 400/403/404 → terminal domain errors, a malformed 200 body → a terminal `MalformedUpstream`, 429/5xx/timeout → the `Restate.retryable` `UpstreamUnavailable` with the 429's `Retry-After` projected — across BOTH transient-retry strategies (Restate's durable STEP retry vs. a caller-visible `backing-off` handler retry), making explicit the journal footgun that a transient outcome must NOT be committed to a `Restate.run` step (a replay re-serves the stale transient instead of re-fetching). Driven end-to-end against a native `restate-server` via a tiny in-process upstream (8 assertions). A guide section in `docs/guide/schema-and-errors.md` teaches the recipe; the spec mention is in `docs/vrs/04-error-boundary/spec.md`. (2) An end-to-end idempotency recipe in `docs/guide/durable-steps.md` threads ONE producer identity (intent-id → Virtual-Object key → Workflow id → send dedupe key) through `Restate.idempotencyKey`, with the different-key-per-layer misuse called out. (3) Docs friction fixes: the `runDescriptor` thunk-vs-`run`-Effect distinction (determinism/durable-steps), the `@effect/platform-node` peer-dep install step beside the first `serve` (getting-started/endpoint), a worked Service+Object-on-one-endpoint `AppR`-union example (endpoint), the durable-promise-key-vs-signal-name clarification (constructs), the named-class `retryable` `retryAfter` projection (annotations). (4) Repointed the 13 guide → `src/` links left dangling by the subsystem-subdir reorg (e.g. `src/cancellation.integration.test.ts` → `src/runtime/cancellation.integration.test.ts`). Docs + one example; no library surface change.
- **@overeng/restate-effect**: Optional/nullable State (migration-blocker) + two typing papercuts (epic #757). (1) **Optional/nullable State** — a state field declared `Schema.optional(S)` (a nullable cursor, e.g. a `highWatermark` watermark) is now expressible AND `stateOf`-readable end-to-end. Restate State is K/V, so an ABSENT key reads back as `undefined` and writing `undefined` REMOVES the key: `State.set(key, undefined)` ≡ `State.clear(key)` in handlers, and the test `stateOf` proxies (`RestateTestHarness.stateOf` / `RestateTestEnv.stateOf`, mock AND real) gained the same `set(undefined)`-removes semantics plus a `clear(key)` method. `State.for` stores the optional field's inner present-value schema for serde (`normalizeStateSchema` strips `undefined`), so a write only ever encodes a present `T` and a read of an absent key returns `undefined` without hitting the serde — ONE pattern that type-checks under BOTH `tsc` (`exactOptionalPropertyTypes`) and the bundler (a bare top-level `Schema.UndefinedOr` handler RETURN is not, since `JSONSchema.make` rejects it; a nullable value belongs in State or a struct field). `AnyImplementation` / `materializeObject` / `materializeWorkflow` widened from `Record<string, Schema>` to `StateSchemas` so an optional-state Object/Workflow materializes. (2) **`domainState` accepts `Schema.optional`** — `RestateScheduled.make` (`Restate.pollLoop`) `domainState` is now `StateSchemas` (shared State-schema handling), so a poll-loop cursor can be nullable. (3) **Typed cycle error channel without a cast** — `CycleEffect`/`ScheduledConfig`/`make` gained a `CycleE` type param tied to `errorSchema`'s decoded type, so the cycle's error channel is `RestateError | CycleE` and a typed cycle `Effect.fail`s its declared error and composes WITHOUT the prior `as unknown as` cast (the composed-daemon example's cast is removed; the loop's `runCycle` absorbs the declared `E` through `classifyOutcome`). (4) **Safe-by-default span projection** — `Restate.annotateSpanFrom(schema, value, pick?)` projects a decoded struct to span attributes and STRIPS every `Restate.sensitive`/`redacted` field (even if explicitly `pick`ed), using the same `findSensitiveFields` walk the serde redaction uses — closing the leak path the free-form `Restate.annotateSpan` (raw primitives, can't detect sensitivity) otherwise left open, so a redacted value can never reach a span by accident. Covered server-free (in-memory `TestContext` nullable State set/get/clear via the real combinators; `RestateTestEnv` mock backend; `annotateSpanFrom` strips sensitive incl. when picked) AND against a native `restate-server` (`RestateTestEnv.real` nullable State end-to-end through `stateOf` + handler; an optional `domainState` cursor advances then clears in a pollLoop). VRS: 01-authoring (optional/nullable State), 02-schema-serde (State value normalization), 06-scheduling (`domainState` optional + typed cycle `E`), 08-observability (`annotateSpanFrom` redaction rule); `docs/guide` constructs/observability/annotations updated. No new dependencies; all 140 package tests green.
- **@overeng/utils**: Shared SSOT helpers used by `@overeng/restate-effect`'s Core S cleanups (additive, dependency-free). (1) `@overeng/utils/node`'s new `net.ts` exports `freePort()` (the single "ask the OS for a free TCP port" helper, previously hand-copied 4× across the playwright config factory's `findAvailablePort` and the restate-effect test harness — all of which shared the same TOCTOU race), plus `freePorts(count)` (allocate N DISTINCT ports as one batch — holds every `:0` listener open until all are read, so the OS cannot hand the same port to two of them, unlike `Promise.all([freePort()×N])`) and `withFreePort(fn, { retries? })` (run a bind-by-number consumer against a fresh port, RETRYING on `EADDRINUSE` — the TOCTOU-closing path for a child process that cannot be handed an already-listening socket). (2) `@overeng/utils` (isomorphic) `formatReasonMessage({ reason, label?, method?, cause? })` is the SSOT for the tagged-error `get message()` body our errors hand-copy (space-join `reason` + optional `[label]` + `(method)` + `: <cause.message>`), preserving the existing `RestateError`/`PtyError` output verbatim. Covered by `src/node/net.unit.test.ts` (6) + `src/isomorphic/string.unit.test.ts` (5).
- **@overeng/restate-effect**: Code-reuse / SSOT cleanups + the `freePort` TOCTOU fix (Core S). (1) Deleted the now-dead `test/restate-server.ts` (subsumed by `./testing`'s productized `startServer`) and the unused `test/test-utils.ts` — both were imported by nothing (~190 lines removed). (2) The four hand-copied `freePort` port-0 helpers (`testing.ts`, the two gone test files, and `@overeng/utils`'s playwright `findAvailablePort`) — plus a 5th in `scheduled-durability.integration.test.ts` — now all consume the single `@overeng/utils/node` `freePort`/`freePorts`. **The shared TOCTOU is fixed where it bites:** the native `restate-server` boot allocates its 3 listener ports via the collision-free `freePorts(3)` batch and the whole boot is RETRIED on a port collision (detected via an `address in use` / `EADDRINUSE` signature in the server's early-exit logs) with a fresh batch — so a co-tenant grabbing a port in the bind-release gap (the `Address in use` parallel-boot flake) just retries instead of redding the lane. Verified by running the integration lane under 8–12 parallel server boots × 8 repeats with zero collision failures. (3) `RestateError.message` now delegates to `@overeng/utils`'s `formatReasonMessage` (behavior-preserving). (4) `Serde.ts`'s inline `new TextEncoder()` byte encoding is replaced with `@overeng/utils`'s `textEncodeToArrayBuffer` (the byte-encoding SSOT). `@overeng/utils` is now a peer + dev workspace dep of `@overeng/restate-effect` (mirroring `notion-effect-client`), so utils's peer surface propagates to the consumer rather than bloating this dependency-light core. No behavior change; all 134 package tests green.
- **@overeng/restate-effect**: Admin / management API (`./admin`) + Molty operating-a-deployment runbook + workflow-id/idempotency-key span stamping (Core M, decision 0018, spec §16). A new OPT-IN `./admin` subpath (dependency-light, like `./otel` / `./testing`) exports a `RestateAdmin` Tag + `layer({ adminUrl, apiKey? })` / `layerConfig()` MIRRORING the `RestateIngress` pattern (decision 0016) but bound to the ADMIN url — every operation an Effect failing with `RestateError({ reason: 'AdminFailed' })`. Operations map 1:1 onto the restate-server admin REST API (verified against 1.6.2, admin-api-version 3): **invocations** `cancel` / `kill` / `pause` / `resume` / `purge` / `purgeJournal` / `delete` (`PATCH|DELETE /invocations/{id}[/{verb}]`) + `restartAsNew({ from?, deployment? })` (restart-from-journal-prefix); **deployments** `registerDeployment` / `listDeployments` / `getDeployment` / `updateDeployment` (`POST|GET|PATCH /deployments[/{id}]`); **introspection** `query(sql, rowSchema)` (a THIN TYPED PASSTHROUGH — the caller supplies the SQL AND the row Schema since the binding does not own the `sys_*` shapes; a decode mismatch → `AdminFailed`) / `queryRaw(sql)` over `POST /query`. The raw HTTP lives in ONE bare-client module (`AdminApi.ts`) that BOTH `./admin` and the harness (`./testing`'s `stateOf` + deployment registration) consume — lifting the harness's previously-duplicated fetch-against-admin code so the two never drift. **Trust boundary** documented prominently: the admin API is unauthenticated by default (never expose publicly; bearer `Redacted` `apiKey` for a secured/Cloud endpoint) and less stable than the SDK protocol (pinned to 1.6.2). **Observability (#5):** the boundary now ALSO auto-stamps `restate.workflow.id` (the Workflow key) and `restate.idempotency.key` (the original-invocation `idempotency-key` header) on the attempt span — so a consumer slices on the end-to-end identity without hand-rolling them; both are identity values, never a redacted FIELD (a small `BoundaryObserver` seam change in `Endpoint.ts` + the `./otel` stamper). Verified server-free (`src/admin.test.ts`: per-op method/path/auth + typed-query decode-failure; `src/observability.test.ts`: the two new attrs via an in-memory `SpanExporter`) and against a real native server (`src/admin.integration.test.ts`: list deployments + a typed `/query` round-trip, QUERY an incident object's State, and surface + cancel a wedged delivery). The Molty runbook recipe is `examples/13-admin-operations.ts` (an `incident` Virtual Object + a `delivery` Workflow that wedges); the guide page is `docs/guide/admin-operations.md`. Version caveats found against 1.6.2: the BULK/BATCH invocation verbs do NOT exist (they 405 — a later-server feature), and a Workflow `run` blocked on a long durable wait reports `status = 'running'` (not `suspended`), so "stuck delivery" is non-terminal-ranked-by-retries. "Admin / management wrappers" is removed from the spec's Deferred list. No new dependencies.
- **@overeng/restate-effect**: Swappable mock⟷real `RestateTestEnv` façade + the eight real-server e2e coverage gaps (decision 0017, spec §11). `./testing` now exports `RestateTestEnv`: ONE `Context.Tag` whose surface is the CONTRACT-ADDRESSED invocation level (`invokeService(contract, method, input)` / `invokeObject` / `submitWorkflow` / `signalWorkflow` / `attachWorkflow` / `stateOf` / `resolveAwakeable` / `kind`), with TWO Layer impls satisfying the same Tag — `RestateTestEnv.mock({ services, appLayer })` (in-process, no journal, no server, ms) and `RestateTestEnv.real({ services, appLayer, alwaysReplay?, disableRetries? })` (a thin wrapper over `RestateTestHarness`) — so the SAME test body (authored ONLY against `RestateTestEnv`) runs on either backend via `it.each(['mock', 'real'])`. The load-bearing property: `invoke*` carries `RestateError | ErrorOf` (the TYPED declared error) on BOTH backends, so `catchTag(DomainError)` compiles AND recovers identically — the mock recovers the typed `E` by round-tripping the failure through the contract's `error` schema (the SAME decode an ingress caller performs on a terminal body). This also made the bound harness `ingress.callTyped`/`objectCallTyped` typed form the default invoke (the precise typed-error union no longer widens; the old escape to the standalone `callTyped` is gone). The mock reuses the package's real building blocks (NOT a re-implementation): the captured `Runtime<AppR>`, the in-memory `makeTestContext` (extended with a shared awakeable registry so a `resolveAwakeable` from OUTSIDE a handler completes a suspended one), the new shared `Endpoint.provideHandlerCaps` per-kind marker provision (the single source of truth, now also used by the real `materialize*` boundary — they cannot drift), the journaled `determinismLayer`, and the boundary's `classifyOutcome`; per-key State `Map`s give object/workflow key isolation for free. The lower-level `RestateTestHarness` + `makeTestContextLayer` primitives stay available (additive). `RestateTestHarness` gains `registerDeployment({ services, appLayer })` (serve + register a SECOND endpoint VERSION on a fresh ephemeral port — multi-deployment upgrade) and endpoint observability wiring on `layer` (`hooks` / `inboundBridge` / `boundaryObserver`). Fills the eight previously-unproven real-server e2e gaps with native-server integration tests: (1) in-handler service→service `Restate.call` / `Restate.send` (cross-invocation); (2) deterministic durable concurrency `Restate.all`/`race` (source-order tuple despite resolution order); (3) multi-deployment version upgrade (two deployments coexist, a new invocation routes to the latest — the full suspend-straddle-upgrade cross-version replay is a documented follow-up); (4) `runExit` saga-compensation (a failed durable step observed as an `Exit` defect → a compensating step); (5) `disableRetries` fail-fast vs retry as an assertion + the `Restate.retryable` + `retryAfter` projection driving retries; (6) `sensitive`-field redaction ON THE WIRE (a raw ingress response holds ciphertext for the field + decrypts back; a missing cipher fails loudly, never plaintext); (7) OTel exactly-once per-invocation metrics + attempt-span reparenting under REAL `alwaysReplay`; (8) `DurablePromise.peek` (non-blocking durable-promise read). A parametrized `src/test-env.integration.test.ts` proves the same body on both backends; the eight gaps live in dedicated `*.integration.test.ts`. VRS: decision 0017, spec §11.6 + the §11.3 layering table (the mock backend is the unit row promoted to a contract-addressed surface), `docs/guide/testing.md` (the `RestateTestEnv` section + mock-vs-real matrix + a consolidated `makeTestContextLayer` options table), and the glossary. No new dependencies.
- **@overeng/restate-effect**: Effect-idiom fixes — replay-aware logging, secured ingress auth, request identity, property-based serde (decisions 0015, 0016; R37–R39). (1) **Logger → `ctx.console` bridge** (decision 0015): a per-invocation `loggerLayer(ctx)` is now provided over every handler effect ALONGSIDE the determinism layer, replacing Effect's default logger so an in-handler `Effect.log*` writes to the invocation's replay-aware `ctx.console` — suppressed during replay (no more re-emitting the same line on every replay/attempt, the bug a `globalThis.console`-backed logger has), level-controlled via `RESTATE_LOGGING`, and stamped with invocation context. The line is formatted by Effect's own `logfmtLogger` (so `Effect.annotateLogs`/spans ride along); only the sink changes. On the CORE `.` export (no `./otel`). The endpoint's own startup log is outside a handler and unaffected. (2) **Secured ingress auth** (decision 0016, R38): `RestateIngress.layer` keeps the literal `{ url }` primitive and gains `apiKey?: Redacted<string>` (+ extra `headers`), sent as `Authorization: Bearer …` so a SECURED / Restate Cloud ingress is reachable (impossible before); the key is a `Redacted` so it never prints. `RestateIngress.layerConfig()` is the `Config`-then-literal wrapper reading `RESTATE_INGRESS_URL` + an optional `Config.redacted('RESTATE_INGRESS_KEY')`. (3) **Request identity** (decision 0016, R39): `EndpointOptions.identityKeys?: ReadonlyArray<string>` (ED25519 v1 public keys) threads into `createEndpointHandler({ identityKeys })` → the SDK's `withIdentityV1`, so the SDK rejects unsigned/unauthorized inbound requests — closing the unauthenticated handler-endpoint hole (pure passthrough). `EndpointOptions.port` now also accepts `number | Config<number>` (resolved on layer acquisition; `layer`/`serve`'s channel becomes `RestateError | ConfigError`), and `RestateOtel.layerConfig` reads `OTEL_SERVICE_NAME`/`OTEL_EXPORTER_OTLP_ENDPOINT` and hands the resolved endpoint to a caller-supplied exporter `build` (the OTLP exporter package stays the consumer's choice — not in the closure). (4) **Property-based serde round-trips** (spec §11.4, now REAL): `@effect/vitest` `it.prop` derives a `fast-check` `Arbitrary` per schema and asserts `deserialize(serialize(x))` equivalent to `x` via `Schema.equivalence` (not `toStrictEqual`) for a plain struct, a transformed schema, an optional state field (`normalizeStateSchema`), and the redaction transform (`encrypt(decrypt(x)) ≡ x` by value, fresh IV per encrypt) — closing the previously-false §11.4 "first-class" claim; JSON-unrepresentable `NaN`/`±Infinity` are excluded via `Schema.Finite` (not round-trippable by design). A parity guard asserts the journaled `Random` overrides every generator method of the default `Random` (catching a future silent determinism hole). The BLOCKING `docs/guide/observability.md` snippet that imported the undeclared `@opentelemetry/exporter-metrics-otlp-http` is fixed to match `examples/09-otel.ts` (`PeriodicExportingMetricReader` + `InMemoryMetricExporter` from `@opentelemetry/sdk-metrics`), and a LOGGING section documents the new bridge. All covered server-free (`src/Runtime.test.ts`, `src/Serde.test.ts`, `src/identity.test.ts`, `src/client-ingress.test.ts`, `src/otel.test.ts`). No new dependencies.
- **@overeng/restate-effect**: Composed `pollLoop` — Retry-After re-arm + webhook wake (decision 0012). `RestateScheduled.make` (`Restate.pollLoop`) now composes two opt-in behaviors. `errorSchema` declares the cycle's error union (annotated `Restate.retryable`/`Restate.terminal`) and routes a cycle failure through the boundary's `classifyOutcome` (the single source of truth): a `retryable` member RE-ARMS the next cycle after its projected `retryAfter` floor (read off the failing instance, e.g. a 429's `retryAfterMillis`) with the cursor AND iteration FROZEN — the same logical cycle retries, not an advance — while a `terminal` member / defect falls to `onCycleError`; `maxRetryBackoffs` (default unbounded) caps consecutive backoffs before demoting to the policy. In the default no-wake shape the backoff is a delayed self-send (generation-bumped, so the pre-armed `fixedDelay` send no-ops), so the per-key write lock is RELEASED during the backoff and `stop` mid-backoff stays prompt (measured ~3ms into a 3000ms backoff). `wake: true` opts the inter-cycle wait into `Restate.race([sleepDescriptor(delay), wake.descriptor])`: each cycle opens a fresh awakeable, persists its id (`wakeId`, a SHARED read-only handler so a webhook can read it under the held lock) and threads the wake reason to the next cycle as `wokenBy`; an ingress `resolveAwakeable` cuts the wait short and the next cycle fires with delay 0. The id ROTATES per cycle; a stale id resolves harmlessly. Documented tradeoff: wake mode HOLDS the write lock during the wait (exclusive `stop`/`start` queue behind it, bounded by the sleep leg) — pair wake with short `retryAfter` floors; the no-wake shape is wedge-free. The two shapes are materialized as two distinct `cycle` bodies. This also fixes a general boundary-correctness bug: `classifyOutcome` now reads the `terminal`/`retryable` annotation PER UNION MEMBER (resolving the matching member for the actual failing error) rather than off the un-annotated `Schema.Union` node — without this every retryable union member silently mis-classified as terminal. Covered server-free (union-member classification in `error-transport.test.ts`) and against a native `restate-server` (`scheduled-compose.integration.test.ts`: Retry-After re-arm + no-wedge stop mid-backoff + terminal-member skip + wake early-fire/rotation/stale-id-harmless; `scheduled-durability.integration.test.ts`: SIGKILL mid inter-cycle wait resumes after restart). The verified composed `notion-watch`-style daemon lives in `examples/12-self-reschedule.ts`; `docs/guide/scheduling.md` has the worked example.
- **@overeng/restate-effect**: In-memory `TestContext` + harness ergonomics + durability lint (#5, decision 0013). `./testing` now exports a FAITHFUL in-memory `RestateContext` (`makeTestContext` / `makeTestContextLayer`) for SERVER-FREE unit tests of handler LOGIC + State transitions — a real in-memory implementation, NOT a stub: State is a real `Map` round-tripped through the same `effectSerde` the handler uses, `ctx.run(name, …)` executes once and MEMOIZES by name (journaled-once: a re-`run` returns the stored value), `ctx.date`/`ctx.rand` are deterministic (seeded), `ctx.sleep` is a controllable no-op, and the layer provides the SAME capability-marker subset the real boundary provides per `handlerKind` (so a `State.set` in a read-only handler is still a compile error). Provide it over the real handler effect and assert on the result AND the State `Map`. It deliberately does NOT model durability/replay, single-writer/per-key concurrency, or cross-handler/cross-invocation effects (`call`/`send`/`reschedule`/delayed self-send/`pollLoop`/cross-invocation durable promises) — documented (JSDoc + README + decision 0013 + spec §11.5) as NOT a substitute for `RestateTestHarness` (the real native server). `withRestateServer({ services, appLayer })` collapses the copy-pasted ~25-line `beforeAll`/`afterAll` scope/ingress boilerplate into `setup`/`teardown` + a `harness()` accessor; the six endpoint-based integration tests (awakeable, cancellation, object, end-to-end, workflow) plus the self-reschedule suite are migrated onto it. `liveSleep` / `withLiveClock` test utils pin an `Effect.sleep` / sub-program to a live `Clock` so wall-clock waits coordinating with the native server elapse under `@effect/vitest`'s virtual `TestClock`. The `overeng/no-non-durable-wait` oxlint rule is enabled on handler `src/` (alongside `no-raw-nondeterminism`), exempting test + harness/testing infra files. Determinism-hazard claims verified at the type level (`capability-inference.types.ts`): a nested journaled op inside `Restate.run` is already a COMPILE error via the run-scrubbing (no new rule needed); gating a `Restate.run` on a journaled `State.get` is deterministic (a non-hazard, left legal). Covered by `src/TestContext.test.ts` (server-free handler/State unit tests against the real combinators).
- **@overeng/restate-effect**: Self-reschedule — durable daemons as a chain of delayed self-sends (#4, decision 0012). `Restate.reschedule({ contract, method, input, delayMillis })` is the typed durable self-send building block: a keyed handler re-arms one of its own handlers via a delayed one-way send (reads `Restate.key`; capability-gated to keyed handlers via `ObjectKey`; journaled → idempotent under replay). `RestateScheduled.make` (alias `Restate.pollLoop`) is a narrow durable recurring-loop primitive: it materializes a Virtual Object that runs ONE bounded `cycle` of the user's work then re-arms via a delayed self-send, so each invocation has a bounded journal (does not grow with cycle count) and crash/restart durability is free (the pending timer survives a restart). Ships `fixedDelay` scheduling, `onCycleError` (default `skipToNext`; also `stopLoop`), stop via `stopWhen`/`maxIterations`/in-cycle `{ stop: true }`, a `start`/`stop`/`status` control surface (`status` is a shared read-only query; the internal `cycle` is `ingressPrivate`), a generation token that invalidates stale delayed timers without a timer handle, and the SAFE re-arm-before-fallible-work ordering (a re-arm journaled before a failure is still delivered, so the loop survives a failing cycle). There is intentionally NO `retryCycle` knob — per-cycle durable retry belongs inside a BOUNDED `Restate.run` (Restate journals a give-up a primitive cannot honestly re-run, and an unbounded `Restate.run` wedges the per-key write lock so `start`/`stop` block). `fixedRate`/`cron`/runtime reconfigure are deferred. The README + `examples/12-self-reschedule.ts` make the p99 latency teaching prominent (a durable daemon uses a one-way send + delayed self-send, never a blocking `call` — measured 18.4s p99). Covered by `src/scheduled.integration.test.ts` against a native `restate-server`: basic recurrence + exactly-once, `maxIterations`/data-driven stop, stop→restart, generation idempotency (a duplicate `start` never overlaps), `skipToNext`/`stopLoop` policies, the `reschedule` building block, and the README example end-to-end.
- **@overeng/restate-effect**: Fix `makeJournaledClock` dropping `Clock.sleep` (Runtime). The journaled per-invocation `Clock` was built via `{ ...Clock.make(), … }`, but `sleep` (and the sync `unsafeCurrentTime*`) live on the Clock PROTOTYPE, not as own-enumerable properties — the object spread silently DROPPED `sleep`, so a bare in-handler `Effect.sleep` threw `clock.sleep is not a function` (it surfaced as a retry loop under load). Rebuilt prototype-preservingly (`Object.assign(Object.create(getPrototypeOf(base)), base, overrides)`) so `sleep` and the `[ClockTypeId]` brand survive while the time reads stay journaled. Regression test added: an in-handler `Effect.sleep` now runs without throwing. Real package defect found under load.
- **@overeng/restate-effect**: End-user documentation for the stable surface (Phase 6). A README covering the mental model, a first Service end-to-end, the three constructs (Service, Virtual Object + typed State, Workflow + durable promises), Schema I/O + the typed error boundary, determinism (journaled `Clock`/`Random`, `Restate.run`, explicit durable waits), durable steps/calls/awakeables + idempotency, cancellation/lifecycle, the endpoint/`serve`, the `./otel` bridge, the `./testing` harness, and an API reference for `.`/`./otel`/`./testing`. Every README snippet is a real compiled-and-run example: the runnable `.ts` files live in `examples/` (covered by `dt ts:check`), and `src/examples.integration.test.ts` drives the example contracts/impls through the `./testing` harness against a native `restate-server` (under `dt check:all`), so a doc snippet that stopped compiling or running fails CI. Grill-in-flux ergonomics (the exact `retryAfter` syntax, automatic durable-combinator-infra-failure-to-defect, awakeables joining `Restate.race`, the self-reschedule helper, a server-free mock context) are left as clearly-marked `TODO(refinement)` stubs for the refinement pass. Docs-only — no library surface change.
- **@overeng/restate-effect**: Completes the v1 Schema-annotation set and the retry surfacing. `Restate.retention({ idempotency?, journal?, workflow? })` on a contract or handler I/O schema is read at `materialize` and mapped to the SDK `idempotencyRetention`/`journalRetention`/`workflowRetention` options (explicit builder `options` win); the R35 service/handler option surface (`inactivityTimeout`/`abortTimeout`/`ingressPrivate`/`enableLazyState`/`explicitCancellation`) is now wired for stateless Services too (handler-level via `HandlerSpec.options`, service-level via the contract's third arg). `Restate.sensitive` (alias `Restate.redacted`) on a struct FIELD is consumed by `effectSerde` as an encrypt-at-encode / decrypt-at-decode TRANSFORM, read ONCE off the pre-transform property signatures (decision 0011): the annotated field is ciphertext on the wire/journal while every other field stays plaintext, round-tripping back to plaintext on decode. The cipher is a pluggable Effect service `RestateRedaction` (`Context.Tag`, a synchronous `{ encrypt, decrypt }` byte cipher) resolved once from the captured runtime context at `materialize`; `aesGcmRedactionLayer(key)` / `aesGcmCipher(key)` provide an AES-256-GCM reference (random IV per encrypt, self-describing `iv‖tag‖ct` layout, `node:crypto`). A schema with a sensitive field but no `RestateRedaction` provided fails with a clear `RedactionCipherMissingError` at encode/decode — never silent plaintext. This is field-level redaction in the serde (the only layer with field structure); the whole-value `JournalValueCodec` stays deferred. Retry surfacing (decision 0006): a typed `retryPolicy` (`maxAttempts`/`initialIntervalMillis`/`maxIntervalMillis`/`exponentiationFactor`/`onMaxAttempts: 'pause'|'kill'`) and an `asTerminalError` hook on service/handler options map to the SDK `RetryPolicy`/`asTerminalError`; `Restate.run` gains an optional `RunRetryOptions` (`maxRetryAttempts`/`maxRetryDuration`/intervals/factor) threaded into `ctx.run(name, action, options)`. Durable retries remain Restate's — `Effect.retry`/`Schedule` are for pure logic only (the `overeng/no-raw-nondeterminism` lint guards). No new dependencies. Covered by server-free unit/contract tests: ciphertext-on-the-wire for the annotated field + plaintext for others + round-trip + missing-cipher failure (XOR and AES ciphers), retention/retry/`asTerminalError` mapped onto the materialized SDK definition options, and `RunRetryOptions` reaching `ctx.run`.
- **@overeng/restate-effect**: Docker-free, Effect-native testing harness behind an opt-in `./testing` subpath export (`RestateTestHarness`). `RestateTestHarness.layer({ services, appLayer, alwaysReplay?, disableRetries? })` is ONE scoped `Layer` that, on acquire, allocates an isolated temp base dir + EPHEMERAL ports for every listener (server ingress/admin/node-to-node AND the SDK endpoint, OS port-0, parallel-safe — R27), spawns the native `restate-server` (binary via `RESTATE_SERVER_BIN` or `nix/restate.nix`) with the optional determinism env (`alwaysReplay` → `RESTATE_WORKER__INVOKER__INACTIVITY_TIMEOUT=0s`; `disableRetries` → `RESTATE_DEFAULT_RETRY_POLICY__MAX_ATTEMPTS=1` + `..._ON_MAX_ATTEMPTS=kill`), polls admin `/health` + partition-readiness, serves the consumer's endpoint (their `appLayer` threaded into the served runtime so handler `R` is satisfied) on its ephemeral port, and registers the deployment; on release (same scope, reverse order) it closes the endpoint → SIGTERM/SIGKILL the server → removes the base dir, surfacing buffered server logs on any startup failure. The harness exposes a typed `ingress` (the `RestateIngress` call surface — Services/Objects/Workflows — pre-bound to the spawned server so tests never thread `RestateIngress`) and `stateOf(contract, key)` → a typed `StateProxy` (`get`/`getAll`/`set`/`setAll`, key+value typed against the contract's `state` block, via `effectSerde` over the Admin API: JSON-mode `/query` hex-decode for reads, `POST /services/{name}/state` byte-array `new_state` for writes) for seeding pre-conditions and asserting post-conditions without going through a handler. No new runtime deps (no Apache Arrow — JSON content negotiation instead). Consumers wire `@effect/vitest` themselves. Covered by a consumer-style integration test (Virtual Object + injected `appLayer`, `stateOf` seed/assert round-trip + key isolation, and an `alwaysReplay` replay-stability run) that gracefully skips when no native `restate-server` is available.
- **@overeng/restate-effect**: OpenTelemetry bridge behind an opt-in `./otel` subpath export (`RestateOtel`). `RestateOtel.layer({ resource, exporter | spanProcessor })` builds ONE OTel `TracerProvider` and registers it as the API global AND installs a global `AsyncLocalStorageContextManager` (via `provider.register()`) — the load-bearing prerequisite, since `@effect/opentelemetry`'s `NodeSdk.layer` registers neither, leaving the hook's `trace.getActiveSpan()` undefined and Effect spans orphaned. The same provider is shared with Effect's tracer, so `Effect.withSpan` and Restate's spans use one provider. `RestateOtel.withOtel(endpointOptions)` attaches `@restatedev/restate-sdk-opentelemetry`'s `openTelemetryHook` service-level on every materialized service (the hook owns the replay-aware `attempt`/`run` spans + inbound W3C extraction) and wires the per-invocation inbound bridge: at handler entry it reads the active attempt span and reparents the Effect program under it (`Tracer.withSpanContext`), so caller → `ingress_invoke` → `invoke` → `attempt` → Effect spans form one coherent trace. Exactly-once-on-replay telemetry is steered through `Restate.run` (the load-bearing seam); an `isReplaying` accessor is also exposed but documented as version-fragile (it reads the SDK's internal `isProcessing`). The core `EndpointOptions` gains dep-light `hooks?`/`inboundBridge?` seams (restate types + a pure transform — no otel dep in the core `.` export). The otel packages are scoped to the `./otel` subpath as peers; the `@opentelemetry/sdk-*` catalog pins are bumped 2.2.0 → 2.7.1 to satisfy `@restatedev/restate-sdk-opentelemetry`'s `@opentelemetry/core >= 2.6.0` peer. Covered by a server-free contract test (in-memory `SpanExporter`) asserting the one-trace parent linkage and exactly-once `run` spans / suppressed replay events.
- **@overeng/restate-effect**: Initial POC of an Effect-idiomatic wrapper around the Restate TypeScript SDK (`@restatedev/restate-sdk` 1.14.5). Provides `effectSerde` (Effect `Schema` ↔ Restate `Serde`, with malformed payloads mapped to a non-retryable `TerminalError(400)`), a per-invocation `RestateContext` `Context.Tag` with durable `run`/`sleep` combinators, declarative Schema-typed service authoring (`RestateService.make`/`handler`), and the endpoint as a scoped (graceful-shutdown) `Layer` plus a `serve` entrypoint. Domain `Schema.TaggedError`s map to Restate `TerminalError`s (no retry, `_tag` metadata) while defects propagate for SDK retry. Covered by a Docker-free integration test against a native `restate-server`. Scope: stateless services only — Virtual Objects, Workflows, awakeables, sagas, and the full OTel trace-context bridge are out of scope.
- **@overeng/restate-effect**: Determinism layer + cancellation↔interruption. Each handler invocation now runs under a journaled Effect `Clock` (`currentTimeMillis`/`currentTimeNanos` ← `ctx.date`; the sync `unsafeCurrentTime*` reads ← a per-attempt frozen base seeded once from `ctx.date.now()` at entry, so they are replay-stable and do not advance mid-attempt) and `Random` (← `ctx.rand`), so default Effect time/random reads are correct-by-construction under replay; durable waits stay the explicit `Restate.sleep`/`timeout`/`race` combinators (no `Clock.sleep` remap). The `overeng/no-raw-nondeterminism` oxlint rule is enabled on source handler code (`src/`, tests exempt). A Restate cancellation now surfaces as an Effect interruption at the next durable await point: `acquireRelease`/`onInterrupt` finalizers and compensations run, the interruption maps to a `CancelledError` (terminal, not retried) rather than a retried defect, and `Request.attemptCompletedSignal` is bridged to attempt-scoped finalization. Adds `Restate.cancel` / `Restate.onCancellation`. Fixes a latent issue where durable-combinator rejections wrapped `CancelledError`/suspension into a retryable `RestateError` defect, causing cancelled invocations to be silently retried.
- **@overeng/genie**: Add `projectionArtifact.json()` for schema-versioned deterministic JSON projections, with generic validation hooks and reusable duplicate-value validators for TS-authored data projected into committed JSON.
- **Notion docs**: Add lightweight package-level VRS requirements/spec docs for `@overeng/notion-core`, `@overeng/notion-effect-schema`, and `@overeng/notion-effect-client`; align the broader Notion VRS docs with implementation reality while keeping package READMEs user-facing.
- **@overeng/notion-core**: Add a dependency-free shared primitive package for Notion API constants, UUID helpers, color/property tuples, property write-class classification, and raw rich-text plain-text extraction.
- **devenv-modules/tasks/changesets**: New shared task module providing `release:changeset:check-bodies`, which rejects malformed Changesets where the YAML frontmatter has no package bumps **and** the body is empty. Catches `changeset add --empty` invocations whose `---\n---\n` placeholder was never filled in. Consume via `(inputs.effect-utils.devenvModules.tasks.changesets { })` in `devenv.nix`. Ported from livestorejs/livestore#1269.
- **@overeng/notion-cli**: Consolidate the Notion command surface under the packaged `notion` binary, including `notion db` replica commands, reusable `notion md` command composition, shared `--version` identity, and Nix/devenv exposure.
- **@overeng/notion-datasource-sync**: Add a standalone Notion datasource sync package with Effect/Schema contracts, a self-contained SQLite replica (`<database-id>.sqlite`), planner/guard/conflict logic, fake and live Notion gateways, NotionMD body integration, one-shot and watch sync surfaces, progress UI, OpenTelemetry instrumentation, and broad fake/live E2E coverage.
- **@overeng/notion-datasource-sync**: Add guarded public SQLite write surfaces for rows, metadata, relations, archive/restore, body pushes, conflict resolution, external URL file attachment staging, view diagnostics, explicit `sync_status.state` buckets, and replica-derived `notion db export`.
- **@overeng/notion-datasource-sync**: Add live demo and verification support for provisioned synthetic Notion fixtures, durable scratch cleanup ledgers, read-after-write body settlement, request/rate-limit telemetry, and credential-free manifest guard coverage.
- **@overeng/notion-md**: Add a public body-only facade for adapters to observe, read, materialize, verified-replace, and settle `.nmd` bodies without depending on sync internals.
- **@overeng/notion-md**: Add path-level `statusPath`/`planPath`/`syncPath` APIs that route file, directory-tree, and flat batch targets through the same contract as the CLI, with library-level guards that reject single-file operations on managed tree members.
- **@overeng/notion-md**: Keep the recursive tree engine behind the path-level API by exporting `syncPath`/`planPath` as the public surface instead of the lower-level `syncTree` operation.
- **@overeng/notion-md**: Include created page identity (`pageId` and `url`) in applied tree `create` results, and document the valid unbound tree `.nmd` shape for local-first page creation.
- **@overeng/notion-md**: Preserve authored directory-tree child indexes when parent bodies contain block-level `<page>` anchors, support URL-less placeholder anchors for newly created children, and fail closed on missing, duplicate, or dangling child anchors.
- **@overeng/react-inspector**: Lineage annotation namespace (#687). New `Lineage` module with `SourceOfTruth | Derived | Projection | Cache | Mirror | External | Computed` tagged union, plus composable companion annotations (`Authority`, `Freshness`, `ForeignKey`). All annotations are self-describing Effect Schemas with ergonomic `pipe`-style constructors (`Lineage.derivedFrom`, `Lineage.cache`, `Lineage.authority`, etc.). The schema-aware renderer surfaces a small superscript glyph next to annotated field names and a dedicated `LINEAGE` / `AUTHORITY` / `FRESHNESS` / `REF` block in the schema tooltip. `SchemaInfo` gains an optional `lineage: LineageBundle` field. Source-field path references in `Derived.from` carry `data-lineage-target` attributes for future jump-to-source wiring. Round-trip-tested via vitest.
- **@overeng/react-inspector**: Map/Set container labels (#686). `Schema.Map({key, value})` renders as `Map<K, V>(N)`, `Schema.Set(T)` as `Set<T>(N)`, plus the `Readonly*` variants. Detected via the `effect/annotation/TypeConstructor` annotation on `Declaration` ASTs.
- **@overeng/react-inspector**: Runtime tagged-union narrowing (#686). When a field's declared schema is `Schema.Union(A, B, C)` of `_tag`-discriminated variants and the runtime value carries a matching `_tag`, the inspector narrows the display (name, tooltip, container label, nested field resolution) to the matched variant. Narrowing happens on every path segment, not just the leaf, so nested fields under a tagged union resolve through the matched variant. `SchemaProvider` gains a `rootData` prop and the context exposes a new `getContextForPathWithValue(path, value)` method.
- **@overeng/react-inspector**: Schema-derived container labels for arrays, records, and tuples (#686). Arrays show `Array<Item>(N)` instead of `Array(N)`, records show `Record<string, Money>` instead of `Object`, tuples show `[string, number, boolean]`. Named array/record schemas (`.annotations({ identifier: ... })`) take precedence over the constructed label. `SchemaInfo` gains a `containerLabel?: string` field. `getFieldSchema` now falls back to `indexSignature.type` so per-field schema resolution works inside records.
- **@overeng/react-inspector**: Rich schema annotation tooltips. Hovering or keyboard-focusing a field name (or struct type badge) now shows a tooltip surfacing `description`, `examples`, `default`, refinement-derived constraints (min/max/length/pattern/format/...), and possible values for `Literal` / `Enums` / `Union`-of-literal / `TemplateLiteral` ASTs. Replaces the previous native `title=` attribute. New exports: `SchemaTooltip`, `SchemaInfo`, `getSchemaInfo`, `getConstraintsFromJSONSchema`, `getPossibleValuesFromAST`. `getFieldSchema` no longer eagerly unwraps refinement/transformation wrappers so user-supplied annotations on those wrappers reach the tooltip.
- **@overeng/genie**: `githubLabels()` runtime primitive for declarative GitHub Issue/PR label management (color, description, deprecation, legacy migrations). Consumed by `mq-cli repo labels` in `schickling/dotfiles`.
- **genie/external.ts**: Shared label catalog exports (`commonLabels`, `mqLabels`, `andonLabels`, `deprecatedDefaults`, `legacyMigrations`) for cross-repo label IaC. Effect-utils self-applies via `.github/labels.json.genie.ts`.
- **@overeng/notion-effect-client**: Add database create/update/archive helpers and switch live Notion integration tests to provision isolated per-run fixtures under `NOTION_TEST_PARENT_PAGE_ID` instead of relying on stale hard-coded workspace page/database IDs.
- **@overeng/notion-md**: Add managed workspace materialization. `sync <dir> --from-remote --root <page-id-or-url>` establishes a workspace from a Notion page tree, and later `sync <dir>` materializes newly discovered remote child pages while reusing the existing guarded one-page sync engine.
- **@overeng/notion-react**: JSX-driven page operations for root `<Page>` and sub-page `<ChildPage>` (#618). Root `<Page>` accepts `title` / `icon` / `cover` and drives `pages.update` on the sync root. `<ChildPage>` becomes a first-class sync boundary with `title` / `icon` / `cover` / `children` / `blockKey`; the sync driver emits and executes `createPage`, `updatePage`, `archivePage`, and `movePage` via `NotionPages.*` with inline block packing (depth ≤ 2, ≤ 100 blocks), tail block ops scoped to the new page, and partial-create rollback on tail failure. Each sub-page is its own sync boundary with its own `blockKey` namespace, and `diff()` descends recursively through retained sub-pages.
- **@overeng/notion-react**: Opt-in `reorderSiblings` on `sync()` (#618 phase 4d). Intra-parent `<ChildPage>` reorder lands via a single `reorderPages` op that the driver realizes with 2N `pages.move` roundtrips through a holding parent (Notion's `pages.move` rejects same-parent, but a trip out and back bumps the page to the end of the original parent's `child_page` block list). Accepts `true` (library auto-provisions and archives a scratch page per sync-with-reorder) or `{ holdingParentId }` (caller-owned lifecycle). Default `false` preserves the pre-4d contract: retained-but-reshuffled siblings still emit same-parent `movePage`, the API rejects, and the driver swallows the validation error.
- **@overeng/notion-cli**: Expose `notion` binary via Nix flake (`packages.${system}.notion-cli`) so consuming repos can add it to their `$PATH` without managing JS module resolution themselves
- **@overeng/pty-effect/client**: Add PTY client support for session tags, `getSession`, `gc`, `updateTags`, `sendData`, `queryStats`, `readRecentEvents`, and live event following
- **@overeng/notion-effect-schema**: Add `NamedIcon` (type: `"icon"`) variant to `Icon` union for native Notion icons (noticons) (#543)
- **@overeng/notion-effect-schema**: Add `NoticonColor` schema for named icon color palette
- **@overeng/notion-effect-schema**: Add `heading_4`, `tab`, and `meeting_notes` block types to `BlockType`
- **@overeng/notion-effect-schema**: Add optional `is_locked` field to `Page` and `DatabaseSchema`
- **@overeng/notion-effect-client**: Add `BlockInsertPosition` tagged union (`after_block`, `start`, `end`) for block insertion
- **@overeng/notion-effect-schema**: Add full `DataSourceSchema` for `GET /data_sources/:id` (properties, parent, database_parent, etc.)
- **@overeng/notion-effect-schema**: Add `PageMarkdown`, `Comment`, `CommentParent`, `View`, `ViewType` schemas
- **@overeng/notion-effect-schema**: Add `RelativeDate` schema type for query filter values (`today`, `tomorrow`, etc.)
- **@overeng/notion-effect-client**: Add `NotionDataSources` module with `retrieve()`, `create()`, `update()`
- **@overeng/notion-effect-client**: Add `NotionComments` module with `create()`, `list()`, `listStream()`
- **@overeng/notion-effect-client**: Add `NotionViews` module with `retrieve()`, `list()`, `listStream()`, `create()`, `update()`, `delete()`
- **@overeng/notion-effect-client**: Add `getParagraphIcon()` helper for tab paragraph block icons
- **@overeng/notion-effect-client**: Add `NotionCustomEmojis` module with `list()` for workspace custom emojis
- **@overeng/notion-effect-client**: Add `NotionPages.getMarkdown()` and `NotionPages.updateMarkdown()` for server-side markdown API
- **@overeng/notion-effect-client**: Add `NotionPages.move()` for moving pages between parents
- **@overeng/notion-effect-client**: Add `markdown` option to `CreatePageOptions` (alternative to `children`)
- **@overeng/notion-effect-client**: Add `is_locked` and `erase_content` to `UpdatePageOptions`
- **@overeng/notion-effect-client**: Add `filterProperties` and `inTrash` to data source query options
- **@overeng/notion-effect-client**: Add strict `.nmd` frontmatter schemas and a storage-size classifier for Notion enhanced Markdown sync metadata
- **@overeng/notion-md**: Add prototype `notion-md` CLI package for self-contained `.nmd` pull/status/push flows with guarded conflict detection and sidecar escalation tests
- **@overeng/notion-md**: Add live Notion E2E coverage for pull/status/push/conflict detection and wire it into the Notion integration CI job
- **@overeng/notion-md**: Expose `notion-md` as a Nix flake package with managed pnpm dependency hash refresh support
- **@overeng/notion-md**: Harden push safety for unknown blocks, Roughdraft review markup, body conflicts with base snapshots, and explicit typed property writes
- **@overeng/notion-md**: Add conservative automatic three-way body merge for non-overlapping line edits, insertions, and deletions
- **@overeng/notion-md**: Replace ad hoc sidecar/base files with strict frontmatter object refs and an Effect-native content-addressed `.notion-md` state store
- **@overeng/notion-md**: Use Notion Markdown `update_content` for proven unique body edits, with guarded `replace_content` fallback and live Notion E2E coverage
- **@overeng/notion-md**: Extract body merge/update planning into a focused pure module with unit coverage
- **@overeng/notion-md docs**: Consolidate scattered research/spec notes into the package-local VRS docs under `packages/@overeng/notion-md/docs/vrs/`
- **@overeng/notion-md docs**: Add package-local usage docs for getting started, CLI workflows, `.nmd` format, sync safety, and troubleshooting
- **@overeng/notion-md**: Add a durable Notion live E2E run ledger and a committed demo `.nmd` fixture synced with the automated Notion showcase page
- **@overeng/notion-md**: Push modeled page metadata from strict frontmatter, including page lock/trash state plus writable icon and cover shapes, and add typed `place`/`verification` property frontmatter values
- **@overeng/notion-md docs**: Fold the remaining VRS design decisions into `spec.md` and remove the companion question log
- **@overeng/notion-md**: Add a TUI Storybook for CLI output states and wire it into the shared Storybook task registry
- **@overeng/tui-stories**: Export `tui-stories` CLI as a Nix package via the flake (#525)

### Fixed

- **@overeng/utils-dev/node-vitest**: Fix `makeOtelVitestLayer` posting traces to the WRONG URL, which made the OTLP trace exporter self-disable SILENTLY. `OtlpTracer.layer({ url })` (and `OtlpLogger`/`OtlpMetrics`) POSTs `url` VERBATIM through the shared `otlpExporter` (`HttpClientRequest.post(url)`) — only the combined `Otlp.layer({ baseUrl })` appends the `/v1/traces` signal path (via `appendUrl`). `makeOtelVitestLayer` passed a BARE base endpoint as the tracer `url`, so the exporter POSTed to the receiver root, 404'd, and disabled itself — traces never landed, with no error. Now it builds the full traces URL via a new exported `otlpTracesUrl(baseEndpoint)` (`${endpoint}/v1/traces`, trailing-slash normalized), the single source of truth the bridge and a regression test both lock. `makeOtelVitestLayer` also gains an additive `endpoint` option (explicit base URL, wins over `endpointEnvVar`) so the capture bridge can point it at the in-process receiver; existing env-var callers are unaffected (#769, #772).
- **@overeng/notion-effect-client**: Make live `NotionBody.observe` fail closed across concurrent remote edits by bracketing Markdown and block-tree reads with page metadata retrieval, retrying unstable observation windows up to three total attempts, and returning `NotionBodyObservationChangedError` when all attempts see `last_edited_time` change (#761).
- **@overeng/notion-md + @overeng/notion-datasource-sync**: Fail closed when a remote Notion Markdown body observation is lossy, including endpoint truncation, empty endpoint bodies with non-empty rendered evidence, unknown blocks, unsupported body inventory, or rendered suffix content omitted after dividers and toggleable headings, so partial bodies are not adopted as clean `.nmd` bases or settled through datasource-sync body guards (#759).
- **@overeng/notion-md**: Adopt block-tree-rendered Markdown, not endpoint Markdown reparsed through CommonMark, as the live pull clean-base body so divider/heading-dense pages do not turn paragraph blocks into `##` headings (#763).
- **@overeng/restate-effect**: Route the standalone blocking durable awaits — the awakeable `promise` and the durable-promise `get`/`peek` — through the shared `awaitDurable` seam (PR #760, two Codex P1 review threads). They previously wrapped EVERY rejection into a `RestateError` defect via `tryPromise + orDie`, bypassing the seam `run`/`sleep`/`timeout`/`all`/`race`/`any` use to classify cancellation/suspension/terminal/infra. The load-bearing fix: a `DurablePromise.reject` (and `Awakeable.reject` / `ingress.rejectAwakeable`) now makes the awaiting `get`/`promise` fail TERMINALLY — the rejection's `TerminalError` terminalizes the awaiter VERBATIM (R33/R34) instead of degrading into a retried infra defect (which Restate retried forever). Cancellation of these awaits now interrupts (finalizers run, mapped to a non-retried `CancelledError`) rather than being wrapped into a retried defect. `awaitDurable` gains an opt-in `'terminal-reject'` mode for this (the `run`/`sleep` infra paths keep a `ctx.run` give-up's `TerminalError` as an infra defect, since a step give-up is infra, not a domain reject). The doc comment that claimed the old code terminalized a reject verbatim (it did not) is corrected to match. Covered by `src/suspension.integration.test.ts` against a native `restate-server`: a `DurablePromise.reject` terminalizes the awaiting `get` and the `run` is NOT retried (the decisive falsifier — the bug retried forever / timed out), plus suspend-and-resume contract tests for the awakeable and durable-promise awaits under `alwaysReplay` + `disableRetries`. VRS: decision 0003, spec §1.3/§9.1.2, glossary.
- **@overeng/restate-effect**: Route the in-handler peer `Restate.call` (`call`/`objectClient`/`workflowClient`) through the shared `awaitDurable` seam, and thread the redaction cipher into descriptor-issued peer calls — closing the third Codex P1 review thread and the descriptor-redaction KNOWN LIMITATION from the contract-invocation-policy change (PR #760). (1) **Suspension/cancellation preserved for in-handler calls**: `callRpc` previously wrapped the `ctx.genericCall` `InvocationPromise` in `Effect.tryPromise`, so an unresolved peer call's SUSPENSION sentinel (the invocation must park and resume on the result) or a `CancelledError` was converted into a `RestateError` defect — degrading a park-and-resume into a defect→retry and swallowing cancellation. It now routes through `awaitDurable` in `'terminal-reject'` mode: a suspension re-throws verbatim (the SDK parks/resumes), a cancellation interrupts, and a callee `TerminalError` terminalizes the caller VERBATIM (R34) instead of becoming a retried infra defect (which Restate retried forever). A peer call carries no typed failure, so `Restate.call`/`objectClient`/`workflowClient` are now honestly typed `Effect<A, never, RestateContext>` (matching the descriptor call path and `Restate.run`). (2) **Descriptor-path redaction**: `Restate.callDescriptor`/`objectCallDescriptor` built their serdes with NO cipher, so a `Restate.sensitive` field on a descriptor-issued peer call inside `Restate.all`/`race`/`any` threw `RedactionCipherMissingError` even with a `RestateRedaction` layer present. The cipher is now resolved at ISSUE time by the effectful combinator and threaded through `Descriptor.issue` (a descriptor builder is synchronous and cannot resolve the ambient cipher itself), so the descriptor path encrypts a sensitive field identically to the direct `callRpc` path (decision 0020). Covered by `src/suspension.integration.test.ts` (a callee that fails terminally terminalizes the caller's call, NOT retried — the decisive falsifier, alongside the durable-promise/awakeable cases) and `src/schema/redaction.integration.test.ts` (a descriptor peer call with a sensitive field round-trips through `Restate.all` under a real `restate-server`). VRS: decision 0003/0020.
- **@overeng/restate-effect**: Fix an intermittent `pollLoop` integration flake (`scheduled.integration.test.ts` "basic recurrence") under high CPU contention. The "exactly-once" check `domain n === control-plane iteration` was sampled mid-flight from two non-atomic ingress reads against a still-advancing loop, so a cycle landing between the reads made `n` lead `iteration` by one. The primitive is correct (cycles are strictly serialized and run exactly once — verified, no extra/duplicate cycle); the assertion was the wrong invariant. Moved the equality check to quiescence (after `stop`, when both counters are frozen) so it stays a full `n === iteration` invariant without any tolerance band or sleep band-aid.
- **@overeng/notion-md**: Guard unified tree sync planning and destructive operations by reporting dry-run moves, blocking missing-file trash unless forced, checking tree `replace_content` races, and documenting the explicit tree/flat-batch CLI contract.
- **@overeng/notion-md**: Deduplicate `--from-remote` materialized paths for colliding Notion titles, strip derived child anchors from tree file bodies while preserving composed baselines, and keep tree sync pinned to the current strict index schema.
- **CI / Nix packages**: Refresh stale pnpm fixed-output hashes for `oxc-config`, `genie`, `notion-cli`, `notion-md`, `megarepo`, `workflow-report`, and `tui-stories`; register `notion-core` in workspace checks; format PR-touched files and keep oxlint fatal for error-level diagnostics while the existing warning backlog is tracked separately.
- **secretspec**: Keep the public repository secretspec limited to environment variable declarations by removing machine-specific secret locator metadata.
- **genie/ci-workflow**: Match managed workflow report PR comments by hidden `stateId` before patching so independent reports sharing the default marker cannot overwrite each other.
- **devenv/tasks/shared/pnpm**: Share live and fixed-output pnpm install policy, cap live install concurrency to match the prepared-workspace builder, and accept Darwin pnpm teardown exits only after materialization is proven complete.
- **@overeng/megarepo**: Keep store/test integration fixtures independent of user tag-signing Git config by creating fixture tags with `--no-sign`, avoid slow filesystem-watch semaphore acquisition in store locks, let `mr store gc --output json` take the final-state path directly, merge `git worktree list` with the on-disk store layout so GC never drops real worktrees from discovery, and run the megarepo Vitest suite with file parallelism disabled because the in-process CLI integration harness mutates global `process.env` and stdio.
- **devenv/tasks/shared/nix-cli**: Run aggregate `nix:check` package hash validations sequentially so CI does not fan out multiple full root-workspace pnpm FOD rebuilds at once on Darwin.
- **nix/workspace-tools**: Tighten pnpm child/network concurrency inside fixed-output pnpm deps builds and cap Darwin Node heap during the install step so macOS CI is less likely to die with an unstructured `Killed: 9` while materializing whole-workspace install roots.
- **@overeng/pty-effect**: Make the server-mode attach/read integration test wait briefly before emitting its marker so slower Linux CI runners do not miss one-shot startup output during initial attach replay.
- **@overeng/notion-datasource-sync**: Keep public SQLite replicas coherent after direct cell edits by routing row changes through canonical CDC, refreshing scalar readback, and failing closed for invalid or unsupported mutations.
- **@overeng/notion-datasource-sync**: Add the missing exported API JSDoc and explicit boolean comparisons that kept `lint` and `devenv-perf` red on PR #683.

- **nix/oxc-config-plugin**: Refresh the `oxc-config` pnpm fixed-output hash so `oxlint` can build again in CI and `lint` / `devenv-perf` stop failing on the stale dependency boundary.

- **nix packages**: Refresh stale pnpm dependency hashes for the Genie, megarepo, tui-stories, and notion-md CLI packages.
- **nix packages**: Refresh the stale `megarepo`, `tui-stories`, `notion-md`, and `workflow-report` pnpm dependency hashes so `nix-check`, `nix-fod-check`, closure-size, and Storybook-report CI jobs use the current dependency closures again.
- **nix packages**: Refresh the stale `notion-cli` pnpm dependency hash after adding the datasource-sync runtime to the packaged workspace.
- **genie/packages**: Include `@overeng/notion-datasource-sync` in the internal package catalog so generated workspace dependency metadata covers the new package.
- **pnpm task**: Bound macOS CI pnpm install heap usage and tolerate Darwin teardown exit 137 only after node_modules materialization is complete.
- **devenv/tasks/shared/pnpm**: Share live and fixed-output pnpm install policy, cap live install concurrency to match the prepared-workspace builder, and accept Darwin pnpm teardown exits only after materialization is proven complete.
- **@overeng/notion-datasource-sync**: Improve watch and remote-adoption reliability by classifying absence candidates with direct retrieval, clearing stale repair markers, honoring gateway retry pacing, and reusing complete checkpoints for lower-latency incremental polling.
- **@overeng/notion-effect-client**: Parse `retry-after` rate-limit header even when `x-ratelimit-remaining` is absent, so rate-limit retry guidance is preserved whenever headers provide it.
- **@overeng/notion-effect-client**: Parse `Retry-After` HTTP-date values as well as seconds and clamp malformed/negative values to zero, so retry backoff avoids invalid or ambiguous rate-limit guidance.
- **@overeng/notion-datasource-sync**: Harden public SQLite `changes` semantics for row create/archive/restore, cell writes, body pushes, metadata/schema/conflict-resolution tables, coalesced repeated edits, ambiguous create outcomes, and fail-closed `people`/`files` direct edits.
- **@overeng/notion-cli**: Gate database export live fixture tests on writable fixture configuration and provision shared Notion integration fixtures before reading `TEST_IDS`, avoiding accidental live API calls with empty IDs when only `NOTION_API_TOKEN` is present.
- **nix/oxc-config-plugin**: Refresh the pnpm dependency fixed-output hash so the devenv shell can realize the oxlint package used by `check:all`.
- **@overeng/tui-react**: Let Effect CLI own Ctrl-C entrypoint handling for `run(App, handler)`. Apps whose action schema includes `Interrupted` now dispatch it during normal Effect interruption finalization, map interrupt-only CLI exits to code 130, and suppress noisy interrupt-only error output in `runTuiMain`.
- **@overeng/megarepo**: Stop store repository discovery from walking internal scratch roots like `tmp` before scanning repos, yield during repository discovery so Effect interruption can propagate promptly, and tighten CLI OTel flush timing so interrupted TTY commands return quickly while still exporting traces.
- **@overeng/megarepo**: Improve `mr store gc --dry-run --output tty` progress UX with early phase updates, heartbeat refreshes, realtime worktree discovery/active-check counts, explicit interrupted output, exit code 130 for Ctrl-C, and more granular OTel spans for removal status checks. GC removal checks now use a single `git status --untracked-files=normal` dirty preflight before the upstream check, avoiding expensive recursive untracked-file enumeration while still failing closed for dirty worktrees.
- **@overeng/megarepo**: Make store GC worktree discovery layout-authoritative across branch, tag, and commit ref roots, and add OTel/log visibility when `git worktree list` cannot be read.
- **@overeng/megarepo**: Avoid recursive `mr fetch --apply --all` hangs when nested apply falls back from a detached branch worktree to an already-created commit worktree.
- **@overeng/megarepo**: Make `mr store gc` data-loss safe for shared stores.
  - Tracks workspace liveness in a store-local registry and protects both active `repos/*` symlink targets and lock-derived `refs/heads/*` / `refs/commits/*` paths.
  - Keeps named `refs/heads/*` and `refs/tags/*` worktrees by default while reclaiming clean unrooted `refs/commits/*` worktrees.
  - Removes the temporary managed/unmanaged store metadata model and the `--include-unleased` GC mode.
  - Forces untracked-file detection during worktree status checks so user/global Git config cannot hide untracked work from GC.
  - Skips worktrees whose git status cannot be inspected unless `--force` is passed, preserving the fail-closed deletion policy.
  - Acquires worktree locks before removal and reports deletion errors as `error` instead of `removed`.
  - Discovers store repositories by `.bare/` presence instead of assuming only `host/owner/repo` paths, traverses discovery concurrently, skips dirty checks for named refs protected by default, streams GC progress through TTY/NDJSON output, avoids recursive worktree-content scans during GC discovery, prunes Git worktree metadata once per repo after safe removals, and adds OTel spans for GC, liveness, and repo discovery.
- **@overeng/react-inspector**: Render the schema display name exactly once in collapsed schema-aware object previews (#684). `SchemaAwareObjectPreview` is now the single owner of the schema title (rendered in the object-description slot, italicized when sourced from a `title`/`identifier` annotation); the collapsed branch in `SchemaAwareNodeRenderer` no longer prefixes a duplicate copy. Fixes `0: Source Origin Summary Source Origin Summary {…}` → `0: Source Origin Summary {…}`.
- **@overeng/notion-cli**: Gate `db dump` live fixture tests on writable fixture configuration and provision shared Notion integration fixtures before reading `TEST_IDS`, avoiding accidental live API calls with empty IDs when only `NOTION_API_TOKEN` is present.
- **nix/oxc-config-plugin**: Refresh the pnpm dependency fixed-output hash so the devenv shell can realize the oxlint package used by `check:all`.
- **devenv/tasks/shared/nix-cli**: Make `dt nix:hash:*` update nested `depsBuilds.".".hash` entries used by `mkPnpmCli`
  - Lets CLI package hash refreshes converge again after repo-root `pnpm-lock.yaml` changes instead of looping until max iterations
  - Restores the intended `dt nix:hash:genie` workflow for package-version bumps that only need the fixed-output deps hash refreshed
- **@overeng/notion-react**: Route `<ChildPage>` title updates through `pages.update` instead of `blocks.update` (#618). Notion's `PATCH /v1/blocks/{id}` rejects a `{ child_page: { title } }` body with `validation_error`; the sync driver now emits `PATCH /v1/pages/{id}` with a properly-shaped `title` property for `child_page` updates.
- **@overeng/pty-effect/client**: Fix flaky timeout in `followEvents` (#577) — `asyncScoped`'s setup ran lazily inside the forked consumer fiber, missing events fired before the fiber started. Replaced with `Stream.asyncPush` (setup still lazy, but `emit.single` is now correctly synchronous for `fs.watch` callbacks). Test updated to watch `session_exit` instead of `session_start`, since `EventFollower.watchFile` starts reading at the current end-of-file when a new session is discovered, making `session_start` unreachable via live following.
- **@overeng/notion-md**: Verify content-addressed object bytes exactly, reject object-store inventory mismatches, and emit structured watch errors as compact JSON lines
- **@overeng/notion-md**: Allow property-only pushes across concurrent remote body edits, clear stale unknown-block storage after destructive replacements, and normalize object-ref path checks cross-platform
- **@overeng/notion-md**: Route watch file events through Effect Platform `FileSystem.watch` while preserving scoped cancellation, polling, debounce, and recoverable sync-error behavior
- **@overeng/notion-md**: Add batch multi-file and recursive folder orchestration for `status`, `push`, and `sync`, including duplicate page-id preflight, per-file result envelopes, bounded concurrency, and multi-file watch mode
- **@overeng/notion-md docs**: Add a recursive workspace demo template that shows multi-file folder sync setup without committing placeholder pages as live targets
- **@overeng/notion-md**: Give CLI subprocess e2e checks explicit timeouts so CI load does not fail the help-path smoke test at Vitest's default 5s limit

### Changed

- **@overeng/restate-effect**: Relocate the VRS design docs (vision/requirements/spec/glossary + the `decisions/` records) into a `docs/vrs/` subdir, separating the design docs from the user-facing README/`examples`. Intra-VRS relative links are preserved (the whole tree moved together); external references (README, `src/Serde.ts`, `src/Annotations.ts`) updated to the new `docs/vrs/` paths. Docs-only — no library surface change.
- **@overeng/restate-effect**: Sharpen the durable surface (refinement Core A). (1) The durable combinators (`Restate.run`/`sleep`/`timeout`/`all`/`race`/`any`/`State.*`/`Awakeable.make().promise`) now have a CLEAN typed `E` — they carry NO `RestateError`. An infra failure is `Effect.die`'d at the single `awaitDurable` seam and classified at the boundary (transient → Restate retries; terminally-failed step → fail), so the no-op `catchTag('RestateError', Effect.die)` is gone and only the inner effect's own domain `E` flows through `Restate.run` (`Restate.run(name, action: Effect<A,Ea,R>) → Effect<A, Ea, R'>`). `Restate.run` journals the raw success value (not a wrapped `Exit`). Adds `Restate.runExit(name, effect) → Effect<Exit<A,E>>` as the opt-in observe form for compensation/sagas (the infra failure is a `Cause.Die` carrying the `RestateError`). The `IngressFailed` client surface (`Restate.call`/`send`, ingress) keeps its typed `RestateError` (it pairs with the typed decode helper). Aligns the impl with decision 0003. (2) Every durable op now exposes a DESCRIPTOR for the deterministic combinators: `Awakeable.make(S).descriptor`, `Restate.callDescriptor`/`objectCallDescriptor`, alongside the existing `runDescriptor`/`sleepDescriptor`/`DurablePromise.for(S).getDescriptor` — so an awakeable joins `Restate.all`/`race`/`any` in journal-source order (replacing the in-process `Effect.raceFirst` workaround that lost determinism). (3) `Restate.retryable({ retryAfter })` accepts `number | Duration | ((error) => number | Duration | undefined)` — a static shorthand OR an instance projection read off the actual failing error at the boundary (e.g. a 429's `e.retryAfterMillis`), mirroring `idempotencyKey`. (4) Papercuts: `State.for` accepts `Schema.optional` fields; the `StateRead`/`StateWrite`/`DurablePromise` capability markers carry descriptive brands so a violation reads like the missing capability; the boundary validates a thrown failure against the declared `error` union (`Schema.encodeUnknownEither`) and surfaces a non-match as a defect (no silent mis-encode). (5) Type frictions: a heterogeneous-`AppR` `services` array now typechecks (the `_Implementation._AppR` phantom is covariant + `layer`/`serve` infer the `AppR` UNION via an `AppROf<Services>` extractor); `./testing` `harness.ingress.*` preserves the precise per-call typed-error + success channels (the `BindLast` wrapper that collapsed `ErrorOf` is replaced by explicit generic `BoundIngress` signatures derived from the `*Of` helpers). VRS: decisions 0003 + 0011 and spec §5/§6/§6.2/§7/§13 updated; README/`examples` `TODO(refinement)` stubs for retryAfter, the clean-error-channel ergonomics, and awakeables-in-`race` filled with verified examples. No new dependencies; `dt check:all` green.
- **@overeng/utils + @overeng/notion-md + @overeng/notion-datasource-sync**: Deduplicate SHA-256 content hashing onto the shared isomorphic `sha256Hex` helper in `@overeng/utils`, dropping direct `node:crypto` use in `notion-md` (`sha256Digest`) and `notion-datasource-sync` (`hashStoreBytes`). Output is byte-identical; the hashing is now browser-capable.
- **@overeng/utils + @overeng/notion-md + @overeng/notion-datasource-sync**: Extract one canonical `titleSlug` into `@overeng/utils/isomorphic/string` and converge both Notion workspace path generators onto it. `notion-md` adopts the NFC-normalized, 120-char-capped slug semantics for newly generated page paths (existing manifest-recorded paths are unaffected).
- **@overeng/notion-effect-client + @overeng/notion-cli + @overeng/notion-md + @overeng/notion-datasource-sync**: Consolidate Notion token resolution into a single `resolveNotionToken` (returning `Redacted`) plus a `NotionTokenMissing` tagged error in `@overeng/notion-effect-client`, replacing three independent resolvers across the `notion`, `notion md`, and `notion db` CLIs. The accepted env-var set (`NOTION_API_TOKEN` → `NOTION_TOKEN`) is now a single source of truth.
- **@overeng/notion-effect-schema**: Unify the markdown and HTML rich-text annotation formatters behind one shared ordering combinator (`applyAnnotations`); output is unchanged.
- **@overeng/notion-effect-schema + @overeng/notion-effect-client**: Reuse dependency-free Notion constants, literal tuples, UUID helpers, property classification, and raw rich-text helpers from `@overeng/notion-core` while preserving existing schema/client public exports.
- **@overeng/notion-effect-schema + @overeng/notion-datasource-sync**: Promote the bidirectional Notion property-value codec and write-class taxonomy into `@overeng/notion-effect-schema` (`CanonicalPropertyValue`, `makeCanonicalCodec({ hash })`, `decode`/`encodeCanonicalPropertyValue`, `propertyWriteClassFromType`, `Canonical{Decode,Encode}Error`), with hashing injected by the caller so the schema package owns the data semantics while `notion-datasource-sync` keeps the hashing policy. nds now delegates property decode/encode to it and keeps only its sync-domain projection/guards; the canonical id brands (`Notion.PropertyId` / `Notion.PageId` / `Notion.PropertyName`) live in the schema package and are aliased by nds. Canonical JSON output — and therefore content hashes — is byte-identical.
- **@overeng/notion-effect-client + @overeng/notion-datasource-sync**: Consolidate Notion API mechanics into the client. Add an optional composable request-throttle layer (`NotionThrottle` / `NotionThrottleLive`, token-bucket via `RateLimiter`, applied once per logical request rather than per retry) and move the rate-limit classification (`isRateLimited` / `retryAfterMillis`) onto `NotionApiError`. The datasource-sync gateway drops its hand-rolled global throttle and configures the client layer instead, with production wiring keeping the existing 3 rps. Replace the unused `paginatedStream` with a `paginate` helper over the mapped `PaginatedResult` shape (optional initial cursor + item/page emit modes) and migrate all cursor-pagination sites (client `views`/`databases`, gateway views/rows/page-property) onto it.
- **genie/external.ts**: Drop `injectWorkspacePackages: true` from the shared `commonPnpmPolicySettings`. The setting is required for effect-utils' own pure Nix/FOD package closure model, but downstream consumers without that model lose visibility to workspace `devDependencies` / `peerDependencies` at type-check time once pnpm injects copies of each workspace package without their dev/peer closures (see livestorejs/livestore#1271). The setting now lives on `commonPnpmWorkspaceData` in `genie/internal.ts`, so effect-utils' own root yaml still materializes injected workspace packages while peer repos spreading `commonPnpmPolicySettings` keep pnpm's default symlink resolution. Repos that want injection can add `injectWorkspacePackages: true` explicitly in their own `pnpm-workspace.yaml` (or extend `commonPnpmPolicySettings` with it).
- **@overeng/notion-datasource-sync docs**: Compact standalone VRS decision records into the active requirements/spec/capability-boundary documents and remove release/checklist artifacts from the VRS companion docs.
- **@overeng/notion-datasource-sync + @overeng/notion-md**: Route the NotionMD-backed body adapter through the public body facade and centralized datasource-sync sidecar helpers, removing direct `.nmd` parsing/materialization glue from datasource-sync while preserving body-only semantics.
- **@overeng/notion-effect-client / @overeng/notion-md**: Share canonical `.notion-md` object-store paths, sync-state paths, object refs, and storage-size thresholds from the NMD schema layer so local metadata decisions derive from one source of truth.
- **@overeng/notion-md**: Breaking CLI simplification: collapse the user-facing page workflow around `sync` and `status`; replace the old explicit `pull` / `push` entrypoints with `sync <page-id-or-url> <file.nmd>` for bootstrap and guarded `sync <file.nmd>` for reconciliation.
- **@overeng/notion-md**: Remove legacy compatibility paths for batch `push` and local-first `page_id: null` page creation; existing Notion pages must be materialized with `sync <page-id-or-url> <target>`.
- **@overeng/pty-effect/client**: `spawnDaemon` now delegates to `@myobie/pty.spawnDaemon` instead of duplicating the daemon spawn pipeline. The Bun-on-Node case is routed through upstream's new `launcher` option (still honors `NODE_BIN`). Eliminates a divergent in-house spawn path so consumers automatically inherit upstream improvements such as bundle-safe spawn (myobie/pty#38). Public API and `PtyDaemonSpec` schema unchanged.
- **@overeng/notion-react**: `<Page>` and `<ChildPage>` accept `icon={null}` and `cover={null}` as explicit clear sentinels (#618). Dropping the prop is still "no claim" (preserves server state); passing `null` emits `pages.update({icon: null})` / `pages.update({cover: null})`. On a fresh page with no prior icon/cover, `null` is a no-op.
- **@overeng/notion-react**: Same-parent `<ChildPage>` creates are now sequential — JSX order is preserved 1:1 on the server (#618). Parallel `pages.create` under a common parent yields nondeterministic `child_page` ordering; the driver issues sequential POSTs so no post-create re-fetch is needed. T08 (formerly "concurrent sibling-page order is not authoritative") is now a normative invariant; the deferred `ensureSiblingOrder` sync option is dropped.
- **@overeng/notion-react**: `CACHE_SCHEMA_VERSION` bumped `2 → 3` to accommodate per-page cache subtrees (#618). v2 caches fall through the existing `"schema-mismatch"` cold path — transparent, no caller action required. The first sync after upgrade may emit one spurious metadata update per sub-page as response-normalized title/icon/cover is recomputed.
- **genie/ci-workflow**: Unify Vercel CI job generation behind a single `vercelDeployJobs()` helper
  - Removes the separate static-job and job-merge helpers now that task-level deploy mode is already unified in `vercel.nix`
  - Lets consumers mix build-mode and static-mode deploys in one project list and attach per-project pre-deploy setup like Vercel git-author configuration
- **deps**: Upgrade `@myobie/pty` from the old git-pinned fork to the published `0.8.0` release line
- **@overeng/notion-effect-client**: Upgrade Notion API version from `2022-06-28` to `2026-03-11`
- **@overeng/notion-effect-schema**: Remove `archived` field from `DatabaseSchema`, `Page`, and `Block` schemas (replaced by `in_trash` in API 2026-03-11)
- **@overeng/notion-effect-client**: Replace `after` parameter with `position` object in `AppendBlockChildrenOptions`
- **@overeng/notion-effect-client**: Replace `archived` with `in_trash` in `UpdatePageOptions` and `archive()` method
- **@overeng/notion-effect-client**: Remove `archived` from `TypedPage` interface (use `inTrash` instead)
- **@overeng/notion-effect-client**: Add named icon variant to `CreatePageOptions` and `UpdatePageOptions` icon types
- **@overeng/notion-effect-client**: Unify file upload API version with shared `NOTION_API_VERSION` constant
- **@overeng/notion-effect-client**: Update search filter from `'database'` to `'data_source'` (API 2025-09-03+ change)
- **@overeng/notion-effect-client**: Migrate database query from `/databases/:id/query` to `/data_sources/:id/query` (`databaseId` → `dataSourceId`)
- **@overeng/notion-effect-schema**: Add `data_source_id` parent variant to `PageParent` schema
- **@overeng/notion-effect-schema**: Add `data_source_id` parent variant to `BlockParent` schema for blocks returned from data-source-backed pages.
- **@overeng/notion-effect-schema**: Rename `DataSource` → `DataSourceRef` for lightweight reference in `DatabaseSchema.data_sources`
- **@overeng/notion-effect-client**: Widen `SchemaHelpers` to accept both `DatabaseSchema` and `DataSourceSchema`
- **@overeng/notion-md**: Use `NOTION_API_TOKEN` as the only Notion credential environment variable across code, docs, tests, and SecretSpec

### Fixed

- **genie/ci-workflow**: Add a shared step decorator for job-local private Cachix read auth
  - Creates a per-step netrc file and appends `netrc-file` to `NIX_CONFIG` instead of relying on runner-global Determinate state
  - Lets downstream repos decorate `devenv` and deploy run steps without exposing the Cachix token to unrelated actions
- **devenv/tasks/shared/vercel.nix**: Preserve dotfiles when packaging static prebuilt output for Vercel deploys
  - Copies `staticDir/.` into `.vercel/output/static/` instead of globbing `staticDir/*`, so hidden assets and config files are not silently dropped
- **@overeng/notion-effect-client**: Raise user integration-test timeouts to tolerate current Notion API latency in CI
- **@overeng/notion-cli**: Fix introspection pipeline to read properties from data source (API 2026-03-11 no longer returns properties on `GET /databases/:id`)
- **@overeng/pty-effect/client**: Keep daemon spawning on PTY's published client API while updating the wrapper to the current session/tag/event surface and preserving attach runtime context

### Changed

- **deps**: Upgrade all Effect ecosystem packages (+2 minor each): `effect` 3.19.19 → 3.21.0, `@effect/platform` 0.94.5 → 0.96.0, `@effect/ai` 0.33.2 → 0.35.0, and 12 other `@effect/*` packages to latest
- **nix**: Update `tsgo` flake input to `Effect-TS/tsgo@24a8a96` (2026-03-30)
- **nix/workspace-tools**: Replace committed per-package normalized pnpm lockfiles with direct staged installs from the authoritative root lockfile
  - Keeps the full pnpm 11 multi-document root lockfile intact inside staged workspaces instead of checking in derived `pnpm-lock.normalized.yaml` files
  - Keeps `manage-package-manager-versions=false` so pinned Nix pnpm builds stay sandbox-safe without self-bootstrapping another pnpm under `$HOME`
  - Removes first-party `pnpm-lock.normalized.yaml` artifacts from `genie` and `megarepo`

### Fixed

- **devenv/tasks/shared/ts.nix**: Make `ts:check:strict` inherit repo-local `ts:check.after` dependencies
  - Preserves consumer generators like `contentlayer:build` when strict typecheck is used as the CI gate
  - Prevents downstream repos from regressing when they already extend `ts:check` with extra build prerequisites
- **genie/external**: Export the shared `@effect-atom/atom` peer-version allowlist in megarepo pnpm policy
  - Keeps downstream repos on `strictPeerDependencies: true` while allowing the Effect version ranges already used inside effect-utils itself
  - Prevents consumer workspace installs from failing on the known pre-1.0 peer ranges declared by `@effect-atom/atom`
- **genie/external**: Export the full shared patch registry to peer repos
  - Adds the `node-pty@1.1.0` patch to `createPnpmPatchedDependencies()` / `pnpmPatchedDependencies()`
  - Unblocks composed-root `pnpm-workspace.yaml` generation in downstream megarepos that import `@overeng/utils`
- **@overeng/genie**: Use cwd-relative lock directory instead of shared `/tmp/genie-locks/` to fix `EACCES` errors in multi-user CI environments (#520)
- **@overeng/tui-react**: Format timeline timestamps as human-readable durations (e.g. `6m 18s / 16m 21s`) instead of raw seconds (`377.9s / 980.6s`) in `TuiStoryPreview` (#472)
- **devenv/tasks**: make warm shell bootstrap commit-scoped and remove `ts:emit` from shell entry
  - Adds an outer `setup:auto` cache so warm `devenv shell` skips unchanged bootstrap work instead of traversing `pnpm:install`, `genie:run`, and `mr:apply` on every entry
  - Switches shell bootstrap from `mr:sync` to initial `mr:apply` so a fresh worktree is normalized without fetching on every shell
  - Replaces setup fingerprint tool-version probes with resolved tool-identity hashing so warm shells do not pay `pnpm`, `genie`, or `mr` CLI startup just to validate unchanged setup inputs
  - Speeds up warm task status paths by using direct `mr status`, fingerprint-based `genie:run` caching, a one-process `pnpm:install` projection hash that preserves the previous structural guarantees, and a `ts:emit` graph that excludes `noEmit` references at emit time
  - Hardens the fast paths by making the outer cache only track setup inputs while each task still verifies its own outputs before skipping
- **devenv/otel**: update `devenv` to the upstream `v2.1` tag and move OTEL shell-entry notices onto `devenv.messages`
  - Resolves OTEL mode, dashboard sync, and Grafana trace-link construction in a dedicated shell-entry task instead of ad-hoc `enterShell` output
  - Auto-displays the OTEL shell-entry message through upstream task messages while keeping `otel-trace` as a lightweight re-open helper
  - Scrubs ambient task trace context before emitting `devenv/shell:entry` so the shell root span cannot self-parent or collide with later `dt` root spans
  - Emits `devenv/shell:entry` via the pinned store path for `otel-span` so tracing still works before `enterShell` PATH mutations are fully visible
- **@overeng/genie**: Validate GitHub Actions `runs-on` labels before emitting workflow YAML
  - Fails `genie` when workflow jobs serialize non-string, empty, or stale placeholder runner labels like `null` / `...=undefined`
  - Prevents CI helper API drift from silently generating invalid workflow files that only fail later in GitHub Actions
- **@overeng/megarepo**: Harden store against broken worktree remnants (#423)
  - `hasWorktree` now checks for `.git` file existence instead of just directory existence, so broken partial worktrees are properly detected and recreated
  - Lock-protected worktree creation cleans up broken directory remnants and prunes stale git worktree bookkeeping before recreating
  - Fix semaphore creation race in `StoreLock` using `SynchronizedRef` for atomic get-or-create
- **flake / nix/workspace-tools**: Document and regression-test strict downstream reuse of effect-utils' canonical nixpkgs input
  - Adds downstream flake-input and `devenv` fixture coverage for standalone and `repos/effect-utils`-prefixed consumers
  - Makes the intended contract explicit: downstream repos should follow `effect-utils/nixpkgs` instead of overriding effect-utils to their ambient nixpkgs
- **@overeng/megarepo**: Skip pre-flight hygiene checks in apply mode (#423)
  - Apply mode self-heals all store issues (missing bare repos, broken worktrees, ref mismatches)
  - Eliminates races in `--all` mode where concurrent nested syncs modify shared store state while sibling pre-flight checks observe it
  - Simplifies `runPreflightChecks` to lock-mode-only (removes `mode`/`commitMode` parameters and exception lists)

- **devenv/tasks/shared/nix-cli**: Update multiple stale Nix FOD hashes per `dt nix:hash:*` iteration
  - Adds `nix build --keep-going` to surface all fixed-output hash mismatches from one build
  - Parses and applies multiple reported hash updates in one pass instead of only the first mismatch
  - Adds regression coverage for mixed main-hash and local-dependency hash updates
- **nix/workspace-tools/mk-pnpm-deps / mk-pnpm-cli / oxc-config-plugin**: Switch Nix-contained pnpm builds to precomputed relocatable install trees
  - Prepares the staged workspace install tree once inside the fixed-output derivation instead of restoring a vendored pnpm store and rerunning `pnpm install` in downstream builds
  - Normalizes pnpm's absolute-path and timestamp metadata so the prepared tree stays deterministic across repeated builds
  - Restores the prepared tree into the real workspace and relocates pnpm path placeholders before Bun-based build steps run
- **nix/workspace-tools/mk-pnpm-deps**: Drop pnpm bookkeeping metadata from prepared install trees
  - Removes `.modules.yaml` and `.pnpm-workspace-state-v1.json` from the archived prepared tree because downstream Nix builders restore the tree and go straight to Bun instead of rerunning pnpm
  - Eliminates the remaining runner-specific pnpm metadata nondeterminism that was still flipping prepared-tree hashes across CI environments
- **nix/workspace-tools/mk-pnpm-cli**: Keep `pnpm` available in prepared-tree build environments
  - Restores `pnpm` to `nativeBuildInputs` so downstream packages can keep using `pnpm exec ...` in `postBuild` hooks after the install tree is precomputed
  - Gives pnpm a writable HOME and disables package-manager self-bootstrap in the builder so `pnpm exec` remains sandbox-safe and does not try to install a different pnpm version under `/homeless-shelter`
  - Fixes downstream CLI packages with asset builds layered on top of `mkPnpmCli`, such as `op-proxy` and `factory`
- **CI workflow / genie/ci-workflow**: Evict cached pnpm-deps outputs before CI jobs resolve `oxlint-npm`
  - Avoids stale fixed-output pnpm cache entries masking the validated prepared-install-tree hash on CI runners
  - Applies the cache bust to each job that resolves the shared Nix toolchain so `nix-check` and the faster task jobs agree on the same fresh deps output
- **@overeng/genie**: Fail `genie --check` when inherited peer deps use ranged local install versions
  - Allows ranged `peerDependencies`
  - Requires explicit local install versions in `dependencies` / `devDependencies` / `optionalDependencies`
- **@overeng/megarepo**: Handle stale locked commits during `mr sync --pull`
  - Prevents recursive sync from aborting when nested pinned members reference commits that no longer exist
  - Allows `mr sync --pull --force` to recover pinned branch members by resolving the tracked ref head
  - Adds regression coverage for recursive `--pull --all` with nested stale pinned lock entries
- **devenv/lint**: Adopt `execIfModified` negation patterns and drop the obsolete full-workspace lint install dependency
  - Excludes vendored/generated trees like `node_modules` during lint cache invalidation
  - Keeps `oxlint` install-free by using the bundled Nix JS plugin instead of the source plugin path
  - Retains the package-local `genie` install dependency because `genie --check` still runs via the repo's source-mode CLI
- **devenv/tasks/shared/check.nix**: Give aggregate check tasks explicit no-op commands so `devenv tasks run check:*` actually traverses their dependencies
  - Prevents current `devenv` from treating `check:quick` / `check:all` as skipped `No command` wrappers
  - Restores the intended shared quick-check entrypoint for downstream repos
- **Effect TypeScript tooling**: Pin the exported `effect-tsgo` flake input back to the last known-good upstream revision
  - Reverts the `tsgo` flake lock refresh after confirming `Effect-TS/tsgo@df2eaaa` currently fails to build its own `effect-tsgo` package
  - Keeps downstream `devenv` shells green until the upstream patch set catches up again
- **nix/workspace-tools/mk-pnpm-cli**: Build pnpm CLIs from filtered aggregate-root workspaces instead of package-level deploy closures
  - Moves patched dependency path discovery out of Nix evaluation and into the staging derivation
  - Preserves lockfile-driven patch staging for root and external install roots without recursive eval-time YAML walks
  - Unblocks downstream composed flake evaluation that was previously overflowing in `parsePatchedDependencyPaths`
  - Stages the target package and its workspace closure under one canonical root workspace
  - Installs dependencies at that staged root with the same aggregate lockfile model used by local dev
  - Compiles the target entrypoint with Bun from the staged package directory, reducing coupling to bespoke deploy-time workspace surgery
  - Narrows pnpm deps fetching to the staged root lockfile, closure package manifests, and referenced patch files
  - Removes legacy deploy-specific behavior and normalizes the store against the staged aggregate workspace input
  - Keeps the smoke harness focused on real Nix builds of the `genie` and `megarepo` packages
- **@overeng/tui-react**: Add `@types/react` and `@types/react-reconciler` to peer dependencies
  - Consumers need these type packages to type-check the `.tsx` source exports
- **devenv/tasks/shared/vercel.nix**: Export deploy URLs as task output env vars and fail fast when URL extraction fails
  - Captures Vercel CLI output inside task execution and extracts the deployment URL deterministically
  - Writes `VERCEL_DEPLOY_URL` and `VERCEL_DEPLOY_URL_<DEPLOYMENT_NAME>` via `DEVENV_TASK_OUTPUT_FILE`
  - Enables CI callers to consume deploy URLs from structured task output instead of brittle log scraping

### Changed

- **devenv/tasks/shared/ts-effect-lsp.nix**: document the tracked future unification of the standalone Effect LSP task with `ts:check`
  - Adds a linked TODO for collapsing the separate task once the main workspace TypeScript check becomes `Effect-TS/tsgo`-backed
- **@overeng/genie**: tighten pnpm workspace SSOT around package seeds
  - Removes `extraPackages` from `pnpmWorkspaceYaml.root(...)` and the matching `additionalMemberPaths` graph helper escape hatch
  - Removes committed package-level `pnpm-workspace.yaml` projections in favor of internal build-time package closures
  - Removes `pnpmWorkspaceYaml.manual(...)` and `packageJson.aggregate(...)`; all root projection now goes through `pnpmWorkspaceYaml.root(...)` and `packageJson.aggregateFromPackages(...)` with explicit `repoName`
  - Adds `extraMembers` as an exceptional escape hatch for non-genie-managed workspace members (e.g. standalone examples in livestore) — prefer real package generators over `extraMembers` whenever possible
  - Stops `genie/external.ts` from depending on internal workspace-graph helpers and documents the seed-only aggregate model
- **Effect TypeScript tooling**: switch local language-service integration to Nix-provided `effect-tsgo`
  - Repoints the dev environment to upstream `Effect-TS/tsgo`
  - Renames generator helpers/comments to describe the current tsgo-based model
  - Keeps the `@effect/language-service` tsconfig plugin entry only as the current upstream tsgo configuration channel
- **pnpm/dev workspace**: Switch dev installs to a generated repo-root hoisted pnpm workspace
  - Adds generated root `package.json` and `pnpm-workspace.yaml` with explicit workspace members
  - Makes `pnpm:install` own the repo-root install state and keeps the repo-root `pnpm-lock.yaml` as the only authoritative lockfile
  - Updates package-scoped task execution to use `pnpm exec` so Vitest, Storybook, and Vite resolve against the active workspace topology
  - Derives package closures for Nix/tooling at build time instead of committing package-level `pnpm-workspace.yaml` files
  - Clarifies in the install spec that the current symlinked `repos/*` Megarepo realization keeps imported members on a cross-repo `link:` boundary rather than making them aggregate-root workspace importers
- **@overeng/utils**: Make Storybook `viteFinal` typing opt-in generic for linked Vite workspaces
  - Keeps the default helper API free of foreign Vite types
  - Lets consumers opt into their own local `vite` config type when they need a typed `viteFinal` hook
- **devenv/tasks/shared/vercel.nix**: Switch to prebuilt deploy mode (`vercel pull` -> `vercel build` -> `vercel deploy --prebuilt`)
  - Replaces direct `vercel deploy <dir>` with local prebuilt workflow for deterministic deploys
  - Replaces `path`/`outputDir` deployment config with `cwd` (defaults to `"."`)
  - Adds `vercel pull` step to fetch project settings and env for the target environment
  - Adds `vercel build` step to produce `.vercel/output` locally before deploying
- **@overeng/genie / @overeng/notion-cli**: Source inherited install-time dependency versions from the Genie catalog instead of copied peer ranges
  - Keeps `peerDependencies` ranged for consumers
  - Makes the catalog the single source of truth for concrete local install versions

### Added

- **devenv/tasks/shared/ts-effect-lsp.nix**: add reusable `ts:effect-lsp` tsgo diagnostics task
  - Exports `effect-tsgo` from the flake package set for downstream devenv consumers
  - Keeps the task standalone so repos can opt into Effect diagnostics without conflating them with stylistic lint
- **@overeng/genie**: Added `githubAction` runtime generator for type-safe `action.yml` generation
- **docs/bun**: Document the upstream nested-workspace `patchedDependencies` blocker and link the Bun issue
- **docs/bun**: Note the Bun-only local workspace fork workaround for patched dependencies
- **@overeng/effect-rpc-tanstack**: Add custom fetch transport support to `layerClient`
  - Allows SSR callers to reuse Effect's built-in `FetchHttpClient` with an injected fetch implementation
  - Adds `fetchFromWebHandler(...)` for adapting colocated web handlers to fetch-compatible transport
  - Avoids app-local reimplementation of Effect HTTP request body/stream handling
- **docs/node-modules-install**: Clarify the pnpm GVS requirement for single-instance JS/TS dependency identity and add install-performance requirements

### Removed

- **devenv/tasks/shared/ts.nix**: remove the legacy `ts:patch-lsp` patching flow from the shared TypeScript task module
  - Drops the `lspPatchCmd`, `lspPatchAfter`, and `lspPatchDir` parameters from the exported shared task API
  - Removes stale shell-entry and OTEL references to `ts:patch-lsp`
- **devenv/tasks/shared/setup.nix**: Remove `setup:opt:*` wrapper tasks and `setup:optional` gate
  - Optional tasks now use native `@complete` dependency suffix instead of nested `devenv tasks run` wrappers
  - Eliminates 6x shell re-evaluation, ~5.9s trace gap, fork-bomb guards, and filesystem locks
  - The workaround for `cachix/devenv#2480` is no longer needed since we use `devenv shell` (not direnv)
- **nix/workspace-tools**: Remove compatibility-only Nix surface from CLI builders/tasks
  - Drops the dead `packageJsonDepsHash` argument from both `mk-pnpm-cli` and exported `mk-bun-cli`
  - Removes the deprecated `devenvModules.tasks.git-hooks-fix` export and deletes its module

### Fixed

- **CI diagnostics**: add temporary root-cause instrumentation for Nix store corruption flakes (`#272`)
  - `validateNixStoreStep` now captures full verify/repair/devenv logs and runner fingerprint into a diagnostics directory
  - Failed jobs now add a compact diagnostics summary and upload a diagnostics artifact for triage
  - Added a temporary `workflow_dispatch` debug switch to force a controlled CI failure and verify diagnostics summary/artifact behavior end-to-end
  - Marked as temporary with explicit cleanup intent once root cause is identified and CI is stable
- **devenv/tasks/shared/ts.nix**: Fix `ts:emit` missing `--build` flag
  - `tscWithDiagnostics` was called without `--build`, causing tsc to treat `tsconfig.all.json` as a source file
  - Previously masked by `setup:opt:*` wrappers silently swallowing the failure
- **beads packaging**: Avoid long emulated builds by using patched prebuilt `bd` release binaries (v0.55.4)
  - `nix/beads.nix` now fetches release tarballs instead of compiling Go sources under QEMU
  - Linux binaries are patched with Nix loader/RPATH (`icu74`) so Dolt-enabled `bd` runs correctly
- **@overeng/genie**: `genie --check` now fails fast on fatal `.genie.ts` import/build errors and marks interrupted sibling checks as canceled
  - Prevents indefinite stalls when a sibling check remains in-flight after a fatal import/build failure
  - Final JSON/TUI failure state is reconciled from `GenieGenerationFailedError.files` to avoid stale `active` entries
- **beads packaging/tasks**: Fix `bd` Dolt startup failures on macOS by building with CGO enabled and updating beads task/hook invocations for current CLI flags
  - `nix/beads.nix` now builds `bd` from source (`buildGo126Module`) with CGO + ICU/SQLite inputs instead of prebuilt no-CGO release tarballs
  - `nix/devenv-modules/tasks/shared/beads.nix` now uses Dolt-directory bootstrap checks and removes deprecated `--no-daemon/--no-db` flag usage

### Changed

- **genie/ci-workflow**: Switch CI helpers to lock-pinned `DEVENV_BIN` instead of PATH `devenv`
  - Replaced `installDevenvFromLockStep` with `preparePinnedDevenvStep` and made task commands use `"$DEVENV_BIN"`
  - `validateNixStoreStep` now runs `devenv info` with `restrict-eval = false` appended in `NIX_CONFIG`
  - `runDevenvTasksBefore` now forwards that unrestricted `NIX_CONFIG` to all `devenv tasks run ...` calls
  - `standardCIEnv` now defaults `NIX_CONFIG` to `restrict-eval = false` for CI jobs, and validation/tasks use that shared default

- **@overeng/megarepo**: Scope nested `megarepo.lock` reconciliation to recursive sync mode
  - `mr sync` now syncs direct member lock artifacts only (`flake.lock` / `devenv.lock`)
  - Nested `megarepo.lock` reconciliation now runs only with `mr sync --all`

- **devenv/tasks/shared/megarepo.nix**: Make `megarepo:sync` always run with `--frozen`
  - Prevents shell-entry and routine task runs from rewriting `megarepo.lock`
  - Adds `megarepo:sync:update` for intentional non-frozen lockfile updates

- **devenv/dt**: Remove CI/non-interactive TUI suppression workaround now that devenv auto-disables TUI in CI
  - Dropped manual `DEVENV_TUI=false` handling and PTY stderr piping from `dt`
  - Updated failure re-run hints to use `devenv tasks run ... --mode before` without `--no-tui`

- **@overeng/genie**: Reduce duplicate check-time work by reusing loaded genie modules between content verification and validation
  - Added `loadGenieFile` / `checkFileDetailed` in core generation to return reusable module/context metadata
  - `checkAll` now passes preloaded modules into `runGenieValidation` instead of re-importing every `.genie.ts`
  - Switched formatting hot path to in-process `oxfmt` API with CLI fallback, eliminating per-file formatter process spawn in normal operation

- **devenv/otel-span**: Consolidate `otel-span` and `otel-emit-span` into single CLI with subcommands
  - `otel-span run <service> <span-name> [opts] -- <cmd>` replaces bare `otel-span <service> ...`
  - `otel-span emit` replaces `otel-emit-span` (reads OTLP JSON from stdin)
  - Breaking: subcommand is now required

- **devenv/otel.nix**: Hard-cut system-mode dashboard sync compatibility
  - `OTEL_MODE=system` now fails shell entry when `OTEL_STATE_DIR`, `OTEL_EXPORTER_OTLP_ENDPOINT`, or `otel` CLI is missing
  - Removed `OTEL_DASHBOARDS_DIR` shell env export
  - Removed shell-side `extraDashboards` merge logic; `extraDashboards` is now rejected in system mode

- **devenv/otel.nix**: Replace `curl` with file spool (`otlpjsonfilereceiver`) in `otel-span`
  - Spans are written to `$OTEL_SPAN_SPOOL_DIR/spans.jsonl` instead of HTTP POST
  - Collector picks up spans via `otlpjsonfilereceiver` (500ms poll, delete after read)
  - Falls back to `curl` if spool dir not available
  - Reduces per-span overhead from ~58ms to <1ms

### Fixed

- **devenv/otel-span**: Emit boolean attributes and manage task trace context
  - `--attr` now serializes `true`/`false` values as `boolValue` (aligns dashboard TraceQL filters)
  - `otel-span` reads `OTEL_TASK_TRACEPARENT` (preferred over `TRACEPARENT`) and exports both for child processes
  - This isolates task traces from stale shell `TRACEPARENT` values caused by devenv shell re-evaluations

- **devenv/dt**: Simplify trace context propagation
  - `dt` now clears `TRACEPARENT` and delegates context management entirely to `otel-span`
  - Removes manual trace/span ID generation that was previously duplicated between `dt.nix` and `otel-span`

- **devenv/otel-span**: Add `--status-attr KEY` flag for status check spans
  - Derives bool attribute from exit code (0=true, non-zero=false)
  - Forces span status to OK (status checks aren't errors, exit 1 means "not cached")
  - Used by `trace.status` to set `task.cached` without masking the real exit code

- **devenv/tasks/lib/trace.nix**: Trace status checks with method and sub-trace support
  - `trace.status` now accepts a `method` parameter (`"binary"`, `"hash"`, `"path"`)
  - Status body runs INSIDE `otel-span` (not post-hoc) so sub-programs inherit TRACEPARENT
  - Binary status checks (e.g. `genie --check`, `mr status`) now produce child spans
  - `task.cached` is derived from exit code via `--status-attr` (no explicit bool passing)
  - Each real status execution gets its own span (no deduplication — duplicate spans from devenv's
    shell re-evaluations accurately reflect what actually happened)

- **devenv/tasks/shared/lint-oxc.nix**: Wire up `genieCoverageExcludes` and add `genieCoverageFiles` (#198)
  - `genieCoverageExcludes` was accepted but never applied; now uses git pathspec exclusion
  - New `genieCoverageFiles` parameter (default: `["package.json" "tsconfig.json"]`) makes checked file types configurable
  - Removed dead `defaultExcludes`/`excludeArgs` code from obsolete `find`-based approach
  - Made doc examples more generic (removed `@overeng`-specific paths)

### Added

- **genie**: Add programmatic TS SDK (`@overeng/genie/sdk`) for calling genie's generate/check
  logic from TypeScript without the CLI. Core orchestration extracted into shared `core.ts` using
  PubSub + Stream event bus pattern, consumed by both CLI (TUI progress) and SDK (silent).

- **genie**: Split `src/build/` into `src/core/` (shared, no TUI deps), `src/build/` (CLI/TUI),
  and `src/sdk/` (programmatic API). Each export path now maps 1:1 to a directory. SDK consumers
  no longer need `jsx` in their tsconfig.

- **devenv/tasks/shared/worktree-guard.nix**: Git hook to enforce worktree workflow
  - Refuses commits on the default branch (detected via `refs/remotes/<remote>/HEAD` with fallback)
  - Optionally refuses commits from the primary worktree
  - Detects megarepo store worktrees and prevents commits when the path-implied ref doesn't match `HEAD`

- **devenv/tasks/shared/ts.nix**: Add `ts:emit` task (`tsc --build --noCheck`) and use it for shell entry
  - Keeps `ts:build` as the typechecked build
  - Improves shell entry performance by skipping full type checking during emit
  - Shell entry now runs `ts:patch-lsp` separately; `ts:emit` no longer depends on patching so it can be used standalone
- **devenv/otel.nix**: TRACEPARENT propagation for shell entry waterfall tracing
  - `setup:gate` generates root TRACEPARENT for shell entry traces
  - `setup:save-hash` emits a `devenv:shell:entry` root span
  - `trace.nix` generates fallback TRACEPARENT when not already set
  - Enables end-to-end waterfall view in Grafana Tempo for shell startup

- **devenv.nix**: Nix eval visibility and cold-start detection
  - `SHELL_ENTRY_TIME_NS` captured at enterShell start
  - `shell:ready` marker span with `cold_start` attribute
  - `dt.nix` adds `shell.ready_ms` attribute for eval+setup time tracking

- **devenv/otel.nix**: `otel:test` task for shell-level unit tests
  - Validates JSON format, TRACEPARENT propagation, spool write, and fallback
  - Runs offline (~2s) without requiring `devenv up`

- **@overeng/otel-cli**: Spool file verification in `otel debug test`
  - Tests both HTTP and file spool delivery paths end-to-end
  - Gracefully skips spool test when `OTEL_SPAN_SPOOL_DIR` not set

- **@overeng/genie**: Validate `pnpmWorkspaceYaml` rejects absolute paths in `packages` during `genie:check` (#152)

- **@overeng/otel-cli**: New Effect CLI package for OTEL stack diagnostics and trace exploration
  - `otel health` — per-component health status (Grafana, Tempo, Collector)
  - `otel trace ls` — tabular trace listing with TraceQL query filtering
  - `otel trace inspect` — span tree with ASCII waterfall visualization
  - `otel metrics ls/query/tags` — TraceQL metrics querying with sparkline rendering
  - `otel api` — raw HTTP calls to Grafana, Tempo, Collector APIs
  - `otel debug test/dashboards` — E2E smoke tests and dashboard inspection

- **devenv/otel.nix**: Full OTEL observability stack as reusable devenv module
  - OTEL Collector + Grafana Tempo + Grafana with hash-based deterministic port allocation
  - Auto-provisioned dashboards via Grafonnet (Jsonnet DSL) build pipeline
  - `otel-span` shell helper for wrapping commands in OTLP trace spans
  - Compatible with Effect OTEL layers (same env var/protocol)

- **devenv/tasks/lib/trace.nix**: Task tracing helper with cache status tracking
  - `trace.exec` wraps task exec scripts with `otel-span` for child span emission
  - `trace.status` emits spans with `task.cached=true` for cached tasks
  - Applied to all shared task modules (ts, genie, lint, pnpm, test, megarepo, etc.)

- **devenv/otel/dashboards**: 6 Grafonnet dashboards with manual grid positioning
  - Overview, dt Task Performance, Shell Entry, pnpm Install Deep-Dive, TS App Traces, dt Duration Trends
  - dt-tasks dashboard with cache status filtering (executed vs cached)

- **@overeng/utils**: `node/otel` module for Effect-native OTEL instrumentation in CLI apps
  - `makeOtelCliLayer()` wires OTLP exporter with W3C TRACEPARENT propagation from `dt` tasks
  - Zero overhead when `OTEL_EXPORTER_OTLP_ENDPOINT` is not set

- **devenv**: Netlify deploy tasks for storybook preview deployments
  - New shared `netlify.nix` task module with `netlify:deploy:<name>` per-package tasks
  - Supports prod, PR preview (alias), and local draft deploy modes via `--input` flags
  - CI job `deploy-storybooks` deploys all 7 storybooks on PRs and pushes to main
  - Replaces Vercel-based storybook deployments

- **@overeng/tui-react**: Standalone `run` function with dual (data-first/data-last) API (#129)
  - `run(app, handler, { view })` replaces `Effect.scoped(Effect.gen(function* () { const tui = yield* app.run(view); ... }))`
  - Scope managed internally — consumers no longer need `Effect.scoped`
  - Error type `E` inferred from handler (no explicit error schema needed)
  - Added `TuiAppTypeId` brand and `isTuiApp` predicate for runtime type detection

### Fixed

- **devenv/lint**: Simplify `lint:check:format` by reverting to direct `oxfmt --check` invocation (#157)
  - Removed `git ls-files` complexity — oxfmt's directory walker already excludes `node_modules`
  - Added `pnpm:install` dependency to ensure stable `node_modules` state during formatting
  - Investigation confirmed `experimentalSortImports` uses string-based classification (no filesystem reads)

- **@effect/language-service/TypeScript config**: Elevate `missedPipeableOpportunity` diagnostics to warnings
  - `missedPipeableOpportunity` now emits as `warning` so Effect LSP findings are visible in non-IDE CLI typechecks
  - Keeps `ts:check` in `--noEmit` mode while preserving the existing `ts:check`/`ts:build` behavior split (#218)

- **CI/storybook**: Fix storybook builds used by Netlify preview deploys
  - Stub `@opentui/*` in `@overeng/genie` Storybook build (OpenTUI requires Bun runtime)
  - Fix `@overeng/tui-react` examples importing `src/mod.ts` (actual entry is `src/mod.tsx`)

- **CI/deploy-storybooks**: Make Netlify preview deploys more reliable
  - Run the deploy job on `ubuntu-latest` (avoids flaky Namespace runner Nix store state)
  - `netlify:deploy:*` now depends on `storybook:build:*` so deploys always have build output

- **@overeng/tui-react**: Fix `OutputCauseSchema` using `Schema.Never` for error field (#129)
  - Changed `error: Schema.Never` to `error: Schema.Defect` in `OutputCauseSchema`
  - Previously, typed errors (e.g. `GenieGenerationFailedError`) caused `ParseError: Expected never` during JSON encoding, masking the real error

### Changed

- **devenv/tasks**: Optimized `check:quick` by prioritizing utils package install
  - Moved utils and utils-dev to front of install queue for earlier `ts:patch-lsp` start
  - `check:quick` improved from ~18-28s to ~14-15s through better task parallelism

- **devenv/ts.nix**: Per-project tsc tracing via `--extendedDiagnostics` parsing
  - When OTEL is available, `ts:check` and `ts:build` emit per-project child spans with timing attributes
  - ~3% overhead when active, zero overhead when OTEL unavailable
  - Renamed `ts:watch` to `ts:build-watch`

- **@overeng/tui-react**, **@overeng/megarepo**, **@overeng/notion-cli**, **@overeng/genie**: Migrated all consumers to standalone `run` API (#129)
  - All command files now use `run(App, handler, { view })` instead of manual `Effect.scoped` + `app.run()`
  - Updated test utilities (`runTestCommand`) to not require `Scope.Scope`

- **@overeng/tui-react**: Automatic log capture for progressive-visual modes (breaking change)
  - `outputModeLayer()` now captures all Effect logs and `console.*` output in tty/ci/alt-screen modes
  - Captured logs accessible via `useCapturedLogs()` hook in React components
  - Prevents accidental log output from corrupting TUI terminal rendering
  - Console methods (`log`, `error`, `warn`, `info`, `debug`) are scoped and restored on cleanup
  - New `LogCapture.ts` module with `createLogCapture()`, `CapturedLogsProvider`, `useCapturedLogs()`
  - New example `06-log-capture/` demonstrating the feature
  - Updated spec.md with log capture documentation

- **@overeng/utils-dev**: New package with enhanced Vitest utilities for Effect-based testing
  - `makeWithTestCtx` / `withTestCtx` for automatic layer provisioning, OTEL integration, and timeouts
  - `asProp` for property-based testing with shrinking phase visibility
  - Migrated 22 test files across 7 packages to the new pattern

- **@overeng/genie**: GitHub Repository Ruleset generator (`githubRuleset`)
  - Type-safe configuration for GitHub Repository Rulesets via the REST API
  - Full support for all 22 rule types with comprehensive JSDoc documentation
  - Generates JSON config applied via `gh api repos/{owner}/{repo}/rulesets`
  - Added ruleset configuration for effect-utils protecting the main branch

### Changed

- **devenv/ts.nix**: Centralized Effect Language Service patching via `ts:patch-lsp` task
  - Removed per-package `postinstall: 'effect-language-service patch'` scripts from all 15 packages
  - Added `lspPatchCmd` parameter to `ts.nix` that creates a `ts:patch-lsp` task
  - Fixes consumer install failures for published packages (e.g. `@overeng/react-inspector`)
- Effect LSP patching now runs automatically before `ts:check`, `ts:build-watch`, `ts:build`

- **devenv/ts.nix**: Use package-local patched tsc binary for Effect Language Service diagnostics
  - Added `tscBin` parameter (default: `"tsc"`) to specify a patched TypeScript binary
  - Nix-provided tsc is unpatched and silently skips Effect plugin diagnostics
  - `ts:clean` uses Nix tsc (always available, doesn't need the patch)

- **@overeng/megarepo**, **@overeng/tui-react**: Migrated tests from async/await to `@effect/vitest`
  - All Effect-based tests now use `it.effect()` pattern instead of `async () => { await Effect.runPromise(...) }`
  - Provides better stack traces, fiber-aware timeouts, and cleaner Effect integration
  - See [#92](https://github.com/overengineeringstudio/effect-utils/issues/92)

- **@overeng/megarepo**: Simplified nix integration - removed workspace generator
  - Removed `mr generate nix` command and `.envrc.generated.megarepo` file
  - Removed `.direnv/megarepo-nix/workspace` mirror directory
  - Removed `MEGAREPO_ROOT_*`, `MEGAREPO_MEMBERS`, `MEGAREPO_NIX_WORKSPACE` env vars
  - Use `DEVENV_ROOT` (provided by devenv) instead of `MEGAREPO_ROOT_NEAREST`
  - Simplified `.envrc` to just `use devenv` (no generated file needed)

- **@overeng/megarepo**: Split `pnpmDepsHash` by platform to fix Linux/Darwin store divergence

- **@overeng/megarepo**: Nix lock sync is now auto-detected and uses top-level config
  - **Breaking**: Moved from `generators.nix.lockSync` to top-level `lockSync` config
  - Lock sync is now **auto-detected**: enabled if `devenv.lock` or `flake.lock` exists in megarepo root
  - No configuration needed for the common case; set `lockSync.enabled: false` to opt-out
  - Removed vestigial `NixGeneratorConfig` and `generators.nix` config options

- **nix/devenv-modules/tasks/shared/megarepo.nix**: Simplified megarepo tasks
  - Removed `megarepo:generate` task (no longer needed)
  - Simplified `megarepo:check` to just verify repos/ directory exists
  - Tasks no longer check for `.envrc.generated.megarepo` or workspace flake

### Fixed

- **@overeng/megarepo**: Configure fetch refspec when cloning bare repos (#111)
  - `git clone --bare` doesn't set `remote.origin.fetch`, breaking `git push --force-with-lease`
  - Now `cloneBare` configures `+refs/heads/*:refs/remotes/origin/*` after clone
  - Ensures remote tracking refs are created on fetch for proper git workflows

- **@overeng/tui-react**: Strengthen JSON schema typing in `TuiApp` unit tests
  - Replaced generic JSON parsing and `any` casts with schema-encoded helpers

- **@overeng/genie**: Fix YAML serializer producing empty output with matrix strategy
  - When GitHub Actions workflows use `${{ }}` expressions inside inline arrays (e.g., `runs-on: [${{ matrix.runner }}]`), oxfmt fails to parse the YAML
  - The `formatWithOxfmt` function now returns original content when oxfmt produces empty output
  - Closes [#108](https://github.com/overengineeringstudio/effect-utils/issues/108)

- **nix/devenv-modules/tasks/shared/test.nix**: Self-contained test tasks - each package uses its own vitest
  - Previously test tasks shared a vitest binary from `@overeng/utils`, violating self-contained packages requirements (R1-R5)
  - Now each package runs tests using `node_modules/.bin/vitest` from its own dependencies
  - Added `vitest.config.ts` to packages that were missing one: effect-path, effect-rpc-tanstack, genie, notion-cli, notion-effect-client, notion-effect-schema
  - Removed deprecated `vitestBin`, `vitestConfig`, and `vitestInstallTask` parameters from test module
  - This ensures packages are independently testable without cross-package dependencies

- **nix/devenv-modules/tasks/shared/nix-cli.nix**: Preflight lockfile/package.json fingerprint checks in `nix:check`
  - Prevents warmed Nix stores from masking stale hashes
  - Makes `nix:check` deterministic in CI vs local runs (R5)

- **nix/workspace-tools/lib/mk-pnpm-cli.nix**: Deterministic pnpm store tarball creation
  - Normalizes tar output (stable ordering + fixed timestamps)
  - Strips non-deterministic pnpm store `checkedAt` metadata
  - Prevents pnpm deps hash churn across CI runs
- **nix/workspace-tools/lib/mk-pnpm-cli.nix**: Force `supportedArchitectures` in Nix pnpm installs
  - Ensures pnpm store hashes remain stable across macOS/Linux (R5)
- **nix/workspace-tools/lib/mk-pnpm-cli.nix**: Generate pnpm store with recursive install
  - Aligns store generation scope with offline install (R6)
  - Prevents missing tarballs during `nix:check` for multi-package workspaces
- **nix/workspace-tools/lib/mk-pnpm-cli.nix**: Force dev dependencies during pnpm store generation
  - Avoids production-only installs that drop dev-only tarballs
  - Fixes `ERR_PNPM_NO_OFFLINE_TARBALL` in `nix build`/`nix:check`

### Removed

- **@overeng/mono**: Removed package entirely — all functionality is now covered by devenv tasks (`dt`). The package had zero consumers across all repos.

### Infrastructure

- **pnpm workspaces**: Hoist React-family packages in React-enabled workspaces to prevent duplicate React instances during local dev

- **nix/workspace-tools/lib/mk-pnpm-cli.nix**: Added `packageJsonDepsHash` parameter to fix build failures
  - `build.nix` files were passing `packageJsonDepsHash` but the function didn't accept it
  - Fixes `nix flake check` failures and downstream repo devenv shell issues
  - Renamed from `depsHash` to `packageJsonDepsHash` for clarity (breaking change)

- **nix/workspace-tools/lib/mk-bun-cli.nix**: Added `lockfileHash` and `packageJsonDepsHash` parameters for consistency
  - Both CLI builders now support the same fingerprint hash interface
  - Enables `nix:check:quick` to work uniformly across both build types

- **nix/devenv-modules/tasks/shared/nix-cli.nix**: Fixed missing task dependencies and improved error messages
  - `nix:check:*` tasks now depend on `pnpm:install` (full workspace)
  - Previously only depended on per-package install, causing failures when other packages had stale lockfiles
  - Added clear error messages for stale lockfiles with actionable fix instructions
  - Detects `ERR_PNPM_OUTDATED_LOCKFILE` and suggests `dt pnpm:update && dt nix:hash`

- **nix/devenv-modules/tasks/shared/pnpm.nix**: Added `pnpm:update` task
  - Runs `pnpm install --no-frozen-lockfile` in all packages to update lockfiles
  - Use when adding new dependencies that cause `ERR_PNPM_OUTDATED_LOCKFILE` errors
  - Now depends on `genie:run` so generated package.json files are up to date

- **nix/devenv-modules/tasks/shared/pnpm.nix**: Renamed `pnpm:clean-lock-files` to `pnpm:reset-lock-files`
  - Makes it clear this is a destructive, last-resort operation

- **nix/devenv-modules/tasks/shared/check.nix**: Updated check task semantics
  - `check:quick` - Fast development checks (genie, typecheck, lint, nix-fingerprint only)
  - `check:all` - Comprehensive validation including full `nix flake check`
  - `check:packages` - New task to validate allPackages matches filesystem

- **nix/devenv-modules/tasks/local/workspace-check.nix**: New local validation task
  - Validates that `allPackages` in devenv.nix matches actual filesystem packages
  - Prevents Nix build failures from unmanaged packages with stale lockfiles
  - Located in `local/` directory (effect-utils specific, not for reuse)

- **nix/devenv-modules/tasks**: Reorganized into `shared/` and `local/` directories
  - `shared/` - Reusable tasks meant for other repos via flake input
  - `local/` - Effect-utils specific tasks (not exported in flake.nix)
  - Added README.md documenting the organization

- **nix/devenv-modules/tasks/shared/check.nix**: Added `extraChecks` parameter
  - Allows repos to inject additional check tasks (e.g., `workspace:check`)
  - Maintains reusability while enabling local customization

- **devenv.nix**: Updated taskModules to use `shared/` directory paths
  - Fixed regression where local paths weren't updated after directory restructure

- **devenv.nix**: Added missing `packages/@overeng/tui-react` to `allPackages`

### Fixed

- **genie/internal**: Ensure `pnpmWorkspaceYaml` is locally imported so `pnpmWorkspaceReact` does not throw a ReferenceError

### Added

- **@overeng/effect-rpc-tanstack**: New package for Effect RPC integration with TanStack Start
  - `createRpcHandler` - Create server function handlers from Effect handlers
  - `createRpcHandlerWithLayer` - Handler with Effect Layer dependency injection
  - `wrapHandler` - Wrap handlers for proper error handling
  - `rpcValidator` - Schema validator for TanStack Start server functions
  - `RpcRequest/RpcResponse/RpcSuccess/RpcFailure/RpcDefect` - Protocol types
  - `RpcDefectError` - Client-side error type for unexpected server errors
  - Basic example with TanStack Start app and Playwright tests

### Changed

- **@overeng/utils**: Updated the distributed-lock dependency and patched root exports to avoid loading optional Redis support.

- **@overeng/notion-effect-cli**: Migrated config from JSON to TypeScript (breaking change)
  - Config file is now `notion-schema-gen.config.ts` instead of `.notion-schema-gen.json`
  - Databases are now keyed by their Notion ID instead of an array
  - New `defineConfig` helper with full type checking and autocompletion
  - New typed `transforms` helpers (e.g., `transforms.status.asString`) instead of string literals
  - New `outputDir` option for base output directory (paths are relative to it)
  - Import config helpers from `@overeng/notion-effect-cli/config`
  - CLI now requires Bun runtime for native TypeScript config loading

- **@overeng/notion-effect-cli**: Adopted type-safe file paths from `@overeng/effect-path` (breaking change)
  - `DatabaseConfig.output` now requires `RelativeFilePath` - use `file()` helper
  - `SchemaGenConfig.outputDir` now requires `RelativeDirPath` - use `dir()` helper
  - Import `file` and `dir` helpers from `@overeng/notion-effect-cli/config`
  - Internal path operations now use `EffectPath.ops.*` instead of `node:path`
  - Removed `Path.Path` service dependency from Effect requirements

- **Monorepo CLI**: Replaced Biome with oxc toolchain (oxlint + oxfmt)
  - Removed `@biomejs/biome` dependency
  - `mono lint` now uses oxlint exclusively
  - `mono fmt [--check]` - Format code with oxfmt (Prettier-compatible, 30× faster)
  - `mono check` now includes format verification
  - Added shared oxlint/oxfmt configuration via `@overeng/oxc-config` package

- **@overeng/oxc-config**: New package for shared oxlint + oxfmt configuration
  - Base config with sensible defaults for TypeScript/Effect projects
  - Rules: `import/no-dynamic-require` (warn), `oxc/no-barrel-file` (warn, except `mod.ts`), `overeng/named-args` (warn), `import/no-commonjs` (error), `import/no-cycle` (warn), `func-style` (warn, prefer expressions/arrows)
  - Re-exports only allowed from `mod.ts` entry point files
  - Custom `overeng/named-args` rule enforces named arguments pattern (options objects), with automatic exemptions for callbacks, rest params, and Effect patterns

### Added

- **@overeng/utils**: Force revoke / lock stealing for file-system semaphore backing
  - `forceRevoke(options, key, holderId)` - Forcibly revoke a specific holder's permits
  - `forceRevokeAll(options, key)` - Revoke all holders for a semaphore key
  - `listHolders(options, key)` - List active holders with permit counts and expiry times
  - `HolderInfo` type for holder information
  - `HolderNotFoundError` for when target holder doesn't exist
  - See upstream feature request: https://github.com/ethanniser/effect-distributed-lock/issues/9

- **@overeng/notion-effect-schema**: New `PropertySchema` discriminated union for typed database property definitions
  - Full support for all 23 Notion property types using `Schema.TaggedStruct`
  - `SelectOptionConfig`, `StatusGroupConfig` for select/multi-select/status options
  - `NumberFormat`, `RollupFunction` enums
  - All property schemas exported individually (e.g., `SelectPropertySchema`, `RelationPropertySchema`)

- **@overeng/notion-effect-client**: New `SchemaHelpers` module for database schema introspection
  - `getProperties({ schema })` - Get all properties as typed `PropertySchema[]`
  - `getProperty({ schema, name })` - Get single property by name
  - `getPropertyByTag({ schema, name, tag })` - Get property filtered by type
  - `getSelectOptions({ schema, property })` - Get select property options
  - `getMultiSelectOptions({ schema, property })` - Get multi-select options
  - `getStatusOptions({ schema, property })` - Get status options
  - `getAnySelectOptions({ schema, property })` - Get options from any select-like property
  - `getRelationTarget({ schema, property })` - Get relation target database info
  - `getFormulaExpression({ schema, property })` - Get formula expression
  - `getNumberFormat({ schema, property })` - Get number format
  - `getRollupConfig({ schema, property })` - Get rollup configuration
  - `getUniqueIdPrefix({ schema, property })` - Get unique ID prefix

### Changed

- **@overeng/notion-effect-schema**: Renamed `Database` to `DatabaseSchema` for clarity (breaking change)
  - The type represents the schema/structure of a database, not the data itself

- **@overeng/notion-effect-cli**: Refactored introspect.ts to use new typed `PropertySchema` from schema package
  - Removed manual property type definitions in favor of shared schemas

- **@overeng/notion-effect-cli**: Generated schemas now include Effect Schema annotations
  - Schemas include `identifier` and `description` annotations for better debugging/tooling
  - Property fields with descriptions now have JSDoc comments instead of inline comments
  - Typed options (when `--typed-options` is used) also include `identifier` annotations

- Renamed **@overeng/notion-effect-schema-gen** to **@overeng/notion-effect-cli** to support more general-purpose CLI functionality
  - Binary name changed from `notion-effect-schema-gen` to `notion-effect-cli`
  - All commands remain the same: `generate`, `introspect`, `generate-config`, `diff`

### Added

- **@overeng/utils**: Workspace helpers (`CurrentWorkingDirectory`, `EffectUtilsWorkspace`) and command utilities (`cmd`, `cmdText`) with optional log capture/retention
- **Monorepo CLI**: Added `mono` CLI for streamlined development workflow
  - `mono build` - Build all packages
  - `mono test [--unit|--integration] [--watch]` - Run tests with filtering options
  - `mono lint [--fix]` - Check formatting and run oxlint
  - `mono ts [--watch] [--clean]` - TypeScript type checking
  - `mono clean` - Remove build artifacts
  - `mono check` - Run all checks (ts + fmt + lint + test)
  - Available directly in PATH via `scripts/bin/mono` wrapper
  - VSCode tasks.json for easy command palette integration
  - CI-aware output with GitHub Actions log grouping

- **@overeng/notion-effect-client**: Block helpers and Markdown converter improvements
  - `BlockHelpers` namespace with typed utilities for custom transformers:
    - `getRichText(block)` - Extract rich text content
    - `getCaption(block)` - Get media block captions
    - `getUrl(block)` - Get URL from image/video/file/embed/bookmark blocks
    - `isTodoChecked(block)` - Check to-do status
    - `getCodeLanguage(block)` - Get code block language
    - `getCalloutIcon(block)` - Get callout emoji
    - `getChildPageTitle(block)` / `getChildDatabaseTitle(block)` - Get titles
    - `getTableRowCells(block)` - Get table row cells
    - `getEquationExpression(block)` - Get equation expression
  - `BlockWithData` type for blocks with type-specific data
  - All helpers also exported as standalone functions
  - Rich Text utilities: `toPlainText`, `toMarkdown`, `toHtml` via `RichTextUtils`
  - Recursive block fetching: `NotionBlocks.retrieveAllNested` (flat stream), `NotionBlocks.retrieveAsTree` (tree)
  - Markdown converter: `NotionMarkdown.pageToMarkdown`, `NotionMarkdown.treeToMarkdown`, `NotionMarkdown.blocksToMarkdown`
  - Custom transformer support for all 27 block types

- **@overeng/react-inspector**: Added as git submodule for Effect Schema-aware data inspection
  - DevTools-style object/table/DOM inspectors for React
  - Enriched display of Effect Schema types with type names and custom formatting
  - Runs on port 9001 (separate from effect-schema-form-aria Storybook on 6006)
  - Maintains its own tooling (tsup, ESLint) - excluded from monorepo biome config

### Documentation

- **@overeng/notion-effect-cli**: Added comprehensive README with usage examples for CLI and programmatic API

### Added

- **@overeng/notion-effect-cli**: `diff` command for detecting schema drift
  - Compares current Notion database schema against an existing generated TypeScript file
  - Reports added properties (new in Notion), removed properties (no longer in Notion), and type changes
  - `--file` / `-f`: Path to existing generated schema file (required)
  - `--exit-code`: Exit with code 1 if differences found (useful for CI)
  - Parses generated schema files to extract property definitions
  - Displays formatted diff output with summary

- **@overeng/notion-effect-client**: Schema-aware typed queries and page retrieval
  - `TypedPage<T>` interface combining page metadata with decoded properties
  - `PageDecodeError` for schema decoding failures
  - `NotionDatabases.query()`: Now accepts optional `schema` parameter for typed results
  - `NotionDatabases.queryStream()`: Now accepts optional `schema` parameter for typed streaming
  - `NotionPages.retrieve()`: Now accepts optional `schema` parameter for typed retrieval
  - All methods return `TypedPage<T>` when schema is provided, with `id`, `createdTime`, `url`, `properties`, and `_raw` access

- **@overeng/notion-effect-cli**: Database API wrapper generation
  - `--include-api` / `-a` flag: Generate typed database API wrapper alongside schema
  - Generated API file includes:
    - `query()`: Stream-based query with auto-pagination
    - `queryAll()`: Collect all results
    - `get()`: Retrieve single page by ID
    - `create()`: Create page (when `--include-write` enabled)
    - `update()`: Update page (when `--include-write` enabled)
    - `archive()`: Archive page
  - Config file support: `includeApi` option in database and defaults config
  - API file written to `{output}.api.ts` (e.g., `tasks.ts` → `tasks.api.ts`)

### Fixed

- **@overeng/notion-effect-schema**: Fixed `BlockSchema` to preserve type-specific properties
  - Block objects now correctly retain their type-specific data (e.g., `block.paragraph`, `block.heading_1`)
  - Previously, decoding would strip these properties, breaking markdown conversion and block helpers
- **@overeng/notion-effect-client**: Removed yieldable-error `Effect.fail` usage and simplified search result literal schema
- **@overeng/notion-effect-cli**: Replaced global `Error` failures with tagged config/token errors

- **@overeng/notion-effect-cli**: Critical fixes to generated schema code
  - Fixed import references to use correct transform namespaces (e.g., `Title`, `Select`, `Num` instead of `TitleProperty`, `SelectProperty`, `NumberProperty`)
  - Fixed write schema generation to use nested Write APIs (e.g., `Title.Write.fromString` instead of `TitleWriteFromString`)
  - Generated schemas now correctly work with `@overeng/notion-effect-schema` package
  - Added integration tests verifying generated schemas decode/encode properly with actual Notion API data structures
  - Added runtime validation helpers to generated code:
    - Read helpers: `decode{Name}Properties`, `decode{Name}PropertiesEffect`
    - Write helpers: `decode{Name}Write`, `decode{Name}WriteEffect`, `encode{Name}Write`, `encode{Name}WriteEffect`

### Changed

- Renamed all packages from `@schickling` scope to `@overeng` scope
- TypeScript builds now emit ESM JavaScript to `dist/` with source maps and declaration maps.
- Property "read" transforms are now decode-only; write payloads are modeled separately via `*Write` schemas / transforms.
- Notion HTTP client retry behavior:
  - Treats request-body JSON encoding failures as typed `NotionApiError` (instead of defects).
  - Respects `retry-after` on 429 responses when retrying.
- Updated dependencies to latest versions (effect ^3.19.13, @effect/platform ^0.94.0)
- Moved all dependencies to pnpm catalog for centralized version management
- Updated pnpm catalog versions (Effect 3.19.14, @effect/platform 0.94.1, TypeScript 5.9.3, Vite 7.3.0, Vitest 3.2.4, Tailwind 4.1.18) and added @effect/rpc for peer compatibility

### Added

- **@overeng/effect-react**: React integration for Effect runtime
  - `makeReactAppLayer` for layer-based app initialization with React
  - `useServiceContext` hook for accessing Effect services from React components
  - `LoadingState` context for tracking app initialization progress
  - `ServiceContext` utilities for running effects with a provided runtime
  - React hooks: `useAsyncEffectUnsafe`, `useInterval`, `useStateRefWithReactiveInput`
  - `cuid` and `slug` utilities for generating unique IDs

- **@overeng/effect-schema-form**: Headless form component for Effect Schemas
  - Schema introspection utilities (`analyzeSchema`, `getStructProperties`, `analyzeTaggedStruct`)
  - Field type detection: string, number, boolean, literal, struct, unknown
  - Context + hooks API pattern for custom rendering
  - `SchemaFormProvider` for design system integration
  - `useSchemaForm` hook for building custom form UIs
  - Support for optional fields, tagged structs, and literal unions
  - `formatLiteralLabel` utility for human-readable label formatting

- **@overeng/effect-schema-form-aria**: Styled React Aria implementation
  - Pre-configured `AriaSchemaForm` component with accessible UI
  - `ariaRenderers` object for use with `SchemaFormProvider`
  - Individual styled components: `TextField`, `NumberField`, `BooleanField`, `LiteralField`
  - `FieldGroup` and `FieldWrapper` layout components
  - Tailwind CSS styling with design token support
  - Automatic segmented control/select switching for literal fields

- **@overeng/notion-effect-cli**: Full CLI implementation for schema generation
  - `generate` subcommand: Introspects a Notion database and generates Effect schemas
    - `--output` / `-o`: Output file path for generated schema
    - `--name` / `-n`: Custom name for the generated schema (defaults to database title)
    - `--token` / `-t`: Notion API token (defaults to NOTION_API_TOKEN env var)
    - `--transform`: Per-property transform configuration (e.g., `Status=raw`)
    - `--dry-run` / `-d`: Preview generated code without writing to file
    - `--include-write` / `-w`: Include Write schemas for creating/updating pages
    - `--typed-options`: Generate typed literal unions for select/status options
  - `introspect` subcommand: Displays database schema information
  - `generate-config` subcommand: Generates schemas for all databases from config
  - Config file support (`.notion-schema-gen.json`) for multi-database projects
  - Configurable property transforms per type (raw, asString, asOption, asNumber, etc.)
  - Support for all 21 Notion property types with sensible defaults
  - Improved PascalCase handling that preserves existing casing
  - Auto-formatting with Biome when available
  - Uses Effect FileSystem and Path for file operations
  - Generated code includes proper Effect Schema imports and type exports
  - Deterministic code generation (no timestamps); header includes generator version
  - Comprehensive unit tests for code generation functionality

- **@overeng/notion-effect-schema**: Core Notion object schemas
  - `Database`, `Page`, `Block` with full field definitions
  - Parent types: `DatabaseParent`, `PageParent`, `BlockParent`
  - File objects: `ExternalFile`, `NotionFile`, `FileObject`
  - Icon types: `EmojiIcon`, `CustomEmojiIcon`, `Icon`
  - Block type enum covering all 27 Notion block types
  - `DataSource` for database data sources

- **@overeng/notion-effect-schema**: Comprehensive Effect schemas
  - Foundation schemas: `NotionUUID`, `ISO8601DateTime`, `NotionColor`, `SelectColor`
  - Rich text support: `RichText`, `TextAnnotations`, `MentionRichText`, `EquationRichText`
  - User schemas: `Person`, `Bot`, `PartialUser`, `User` union
  - Property schemas with:
    - decode transforms (e.g. `Title.asString`, `Num.asNumber`, `Select.asStringRequired`)
    - write payload schemas/transforms for page create/update (e.g. `TitleWrite`, `SelectWrite`, `PeopleWrite`)
  - Custom `docsPath` annotation linking each schema to official Notion API docs
  - Proper Effect `Option` handling for nullable/optional fields

- **@overeng/notion-effect-client**: Comprehensive test suite with real API integration
  - Unit tests for internal HTTP utilities
    - `parseRateLimitHeaders`, `buildRequest`, `get`, `post` functions
    - `NotionApiError.isRetryable` logic
    - Pagination utilities: `paginationParams`, `toPaginatedResult`, `paginatedStream`
  - Integration tests for service modules (skipped when no token)
    - Databases: `retrieve`, `query`, `queryStream` with filters and pagination
    - Pages: `retrieve`, `create`, `update`, `archive`
    - Blocks: `retrieve`, `retrieveChildren`, `retrieveChildrenStream`, `append`, `update`, `delete`
    - Users: `me`, `list`, `listStream`, `retrieve`
    - Search: `search`, `searchStream` with filters and sorting
  - `describe.skipIf` pattern for graceful skipping when no API token
  - Separate `test:unit` and `test:integration` npm scripts

## [0.1.0] - 2025-08-03

Initial release of effect-notion monorepo.

### Added

- **@overeng/notion-effect-schema**: Effect schemas for the Notion HTTP API
- **@overeng/notion-effect-client**: Effect-native HTTP client for the Notion API
- **@overeng/notion-effect-cli**: CLI tool for schema generation

### Infrastructure

- Initial monorepo setup with pnpm workspaces
- TypeScript configuration with project references
- Modern ESM-first package structure
