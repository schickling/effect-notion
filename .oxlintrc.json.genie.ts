import {
  baseOxlintCategories,
  baseOxlintIgnorePatterns,
  baseOxlintOverrides,
  baseOxlintPlugins,
  baseOxlintRules,
  otelOxlintRules,
  stylexOxlintRules,
} from './genie/oxlint-base.ts'
import { oxlintConfig, type OxlintConfigArgs } from './packages/@overeng/genie/src/runtime/mod.ts'

/** Path to custom oxlint rules plugin */
const OXC_PLUGIN_PATH = './packages/@overeng/oxc-config/src/mod.ts'

/**
 * Path to the `@stylexjs` namespace shim, which re-exports the upstream
 * `@stylexjs/eslint-plugin` rules. A second plugin entry rather than the bare
 * package specifier, because upstream ships no `meta.name` and a bare specifier
 * only resolves from the root `node_modules`, which this aggregate root cannot
 * carry a dependency in. See that file's header.
 */
const STYLEX_UPSTREAM_PLUGIN_PATH = './packages/@overeng/oxc-config/src/stylex-upstream-plugin.ts'

export default oxlintConfig({
  plugins: baseOxlintPlugins,
  jsPlugins: [OXC_PLUGIN_PATH, STYLEX_UPSTREAM_PLUGIN_PATH],
  categories: baseOxlintCategories,
  rules: {
    ...baseOxlintRules,
    // StyleX enforcement, both layers (decision 0005 Amendment 2). Repo-wide
    // rather than scoped, so a target becomes gated the moment it starts using
    // StyleX — the rules are inert in files that never call the StyleX API.
    ...stylexOxlintRules(),
  },
  ignorePatterns: [
    ...baseOxlintIgnorePatterns,
    // The emitted Weaver registry directory: generated YAML/TS bindings + thin codegen glue
    // (aggregator + per-file `.genie.ts` emitters). Freshness is enforced by `genie:check`;
    // exclude from lint like other generated-output trees. Real member contracts live in their
    // package `src` (fully linted, incl. the seam-file rule).
    'genie/weaver-registry/**',
  ],
  overrides: [
    ...baseOxlintOverrides,
    // Genie runtime must be dependency-free (issue #138)
    {
      files: ['**/genie/src/runtime/**'],
      rules: { 'overeng/no-external-imports': 'error' },
    },
    {
      files: ['**/genie/src/runtime/**/*.test.ts'],
      rules: { 'overeng/no-external-imports': 'off' },
    },
    {
      files: ['**/genie/src/runtime/package-json/node/**'],
      rules: { 'overeng/no-external-imports': 'off' },
    },
    {
      // These post-install node tools legitimately use the TypeScript compiler
      // API: ts-api owns the process-backed session and bootstrap-closure uses
      // it to walk each generator's runtime import closure. Neither belongs to
      // the dependency-free bootstrap-generation runtime.
      files: [
        '**/genie/src/runtime/node/bootstrap-closure.ts',
        '**/genie/src/runtime/node/ts-api.ts',
      ],
      rules: { 'overeng/no-external-imports': 'off' },
    },
    // jsdoc-require-exports is ENFORCED as `error` (base rule, oxlint-base.ts):
    // every published package `src` export must carry JSDoc. The exemptions here
    // + the base test/story/config exemptions keep non-API surfaces off.
    //
    // config-generation tooling (the `genie/` dirs + `*.genie.ts` generator
    // sources) and illustrative `examples/` code are not published API, so the
    // rule is scoped off there. `**/genie/**` also matches the `@overeng/genie`
    // PACKAGE, which IS published API — the next override re-enables it for that
    // package's `src` so its surface stays covered (overrides apply in order).
    {
      files: ['**/genie/**', '**/*.genie.ts', '**/examples/**'],
      rules: { 'overeng/jsdoc-require-exports': 'off' },
    },
    {
      files: ['packages/@overeng/genie/src/**'],
      rules: { 'overeng/jsdoc-require-exports': 'warn' },
    },
    // oxlint 1.82's `no-underscore-dangle` reports the repo's `_x` marker for a
    // binding that exists for its shape but is intentionally unused — which
    // `no-unused-vars` requires to be underscore-prefixed. Two surfaces are
    // built almost entirely out of such bindings: `*.types.ts` files, whose
    // whole content is type-level inference assertions (`const _runOk: Expect<...>`),
    // and `examples/`, where a binding illustrates a shape it never uses. The
    // base config relaxes the same rule for tests and story fixtures.
    {
      files: ['**/*.types.ts', '**/examples/**'],
      rules: { 'no-underscore-dangle': 'off' },
    },
    // The otelite test-assertion harness is a fluent matcher DSL
    // (`attr.predicate('label', pred)`, `expectTrace(...).expectOne(...)`) where
    // positional arguments read idiomatically and an options object would make
    // every OTEL-test assertion across the repo more verbose. It is already
    // rawOtel-exempt test-assertion infra (above), so exempt it from named-args
    // too — the convention governs product API, not the test DSL.
    {
      files: ['**/utils-dev/src/otelite/**'],
      rules: { 'overeng/named-args': 'off' },
    },
    // `utils/src/node/otel.ts` is the `./node/otel` subpath entry and
    // `otel-attrs.ts` a deliberate convenience barrel re-exporting the OTEL
    // contract for node consumers — intentional entry barrels (like `mod.ts`,
    // already exempt). The only code "fix" is de-barreling = breaking the public
    // import surface, so the barrel rule is scoped off for these two files.
    {
      files: ['**/utils/src/node/otel.ts', '**/utils/src/node/otel-attrs.ts'],
      rules: { 'oxc/no-barrel-file': 'off' },
    },
    // This file is the package's intentional public schema subpath. Keep the
    // public contract explicit instead of de-barreling the consumer-facing API.
    {
      files: ['**/react-inspector/src/schema/mod.tsx'],
      rules: { 'oxc/no-barrel-file': 'off' },
    },
    // restate-effect's `./testing` harness has a benign barrel-induced cycle:
    // `testing.ts` aggregates and re-exports `RestateTestEnv`, which imports the
    // harness back from `testing.ts`. Test-infra aggregation, not a runtime
    // import cycle; scope `no-cycle` off here (cf. the kdl port's waiver).
    {
      files: ['**/restate-effect/src/testing/**'],
      rules: { 'import/no-cycle': 'off' },
    },
    // effect-utils: production code must use schema-backed OTEL contracts instead
    // of raw Effect/Stream span primitives. Keep boundary/runtime/test exceptions
    // narrow and explicit so repo-wide adoption remains mechanically checkable.
    {
      files: ['packages/@overeng/*/src/**/*.ts', 'packages/@overeng/*/src/**/*.tsx'],
      // `contractSeam: 'warn'` ships the seam-file completeness lint (decision 0005) WARN-only;
      // it self-exempts `*.contract.ts` seam files and flips per-namespace to ERROR later.
      rules: otelOxlintRules({ rawOtel: 'error', contractSeam: 'warn' }),
    },
    // M3 staged flip (decision 0005): the `genie.*` namespace is fully seam-authored, so its
    // telemetry paths enforce `otel-contract-in-seam-file` at ERROR (a planted genie contract
    // outside a `*.contract.ts` seam file fails lint). The rest of the repo stays WARN until each
    // namespace migrates. The rule self-exempts `*.contract.ts`; the test-file override BELOW turns
    // it off again for genie's `*.test.ts`, matching the repo-wide test exemption (order matters).
    {
      files: ['packages/@overeng/genie/src/**/*.ts', 'packages/@overeng/genie/src/**/*.tsx'],
      rules: otelOxlintRules({ rawOtel: 'error', contractSeam: 'error' }),
    },
    {
      files: [
        'packages/@overeng/otel-contract/src/**',
        'packages/@overeng/utils-dev/src/otelite/**',
        'packages/@overeng/*/src/**/*.test.ts',
        'packages/@overeng/*/src/**/*.test.tsx',
        'packages/@overeng/*/src/**/*.spec.ts',
        'packages/@overeng/*/src/**/*.spec.tsx',
        'packages/@overeng/*/src/**/*.unit.test.ts',
        'packages/@overeng/*/src/**/*.unit.test.tsx',
        'packages/@overeng/*/src/**/*.integration.test.ts',
        'packages/@overeng/*/src/**/*.integration.test.tsx',
        'packages/@overeng/*/src/**/*.e2e.test.ts',
        'packages/@overeng/*/src/**/*.e2e.test.tsx',
        'packages/@overeng/*/src/**/*.gen.ts',
        'packages/@overeng/*/src/**/*.gen.tsx',
      ],
      rules: otelOxlintRules({ rawOtel: 'off' }),
    },
    // restate-effect: ban raw nondeterminism in SOURCE handler code (R20, decision
    // 0004). The journaled Clock/Random + explicit durable combinators are the
    // primary guarantee; this lint is an advisory backstop. Scoped to `src/` only —
    // the follow-up override re-disables it for test setup + the `./testing`
    // harness so they can use Date.now / random freely.
    {
      files: ['**/restate-effect/src/**'],
      rules: {
        'overeng/no-raw-nondeterminism': 'error',
        // Ban non-durable Effect.sleep/timeout in handler src (steer to
        // Restate.sleep/timeout, which journal a durable timer that survives
        // suspension/replay). EXEMPT for the same test + harness/testing infra
        // files below — that lifecycle code (live-clock sleeps, in-memory context)
        // is not a durable handler.
        'overeng/no-non-durable-wait': 'error',
      },
    },
    {
      files: [
        '**/restate-effect/src/**/*.test.ts',
        '**/restate-effect/src/**/*.test.tsx',
        // The `./testing` harness manages the native restate-server lifecycle
        // (poll deadlines, ephemeral ports, the live-clock sleep util) — server
        // infra, not handler code. The in-memory TestContext is likewise test infra.
        '**/restate-effect/src/testing/testing.ts',
        '**/restate-effect/src/testing/TestContext.ts',
        '**/restate-effect/test/**',
      ],
      rules: {
        'overeng/no-raw-nondeterminism': 'off',
        'overeng/no-non-durable-wait': 'off',
        // The testing harness polls the restate-server lifecycle (deadlines,
        // readiness) with intentionally sequential awaits in a loop.
        'no-await-in-loop': 'off',
      },
    },
    // effect-utils specific: react-inspector is a fork with its own style
    {
      files: ['**/react-inspector/**'],
      rules: {
        'func-style': 'off',
        'overeng/named-args': 'off',
        'unicorn/no-new-array': 'off',
        'unicorn/no-array-sort': 'off',
        'unicorn/consistent-function-scoping': 'off',
        'import/no-named-as-default': 'off',
        'overeng/exports-first': 'off',
        'overeng/jsdoc-require-exports': 'off',
        // oxlint reports this rule's strictNullChecks precondition at byte 0,
        // before inline suppression comments can apply. react-inspector keeps
        // package-local relaxed TypeScript settings while the fork is upstreamed.
        'typescript/no-useless-default-assignment': 'off',
      },
    },
    // notion-react: incubation lint waiver (tracked in #599; remove before GA)
    {
      files: ['**/notion-react/**'],
      rules: {
        'overeng/jsdoc-require-exports': 'off',
        'overeng/explicit-boolean-compare': 'off',
        'overeng/named-args': 'off',
        'overeng/exports-first': 'off',
        'overeng/storybook/csf-component': 'off',
        'no-await-in-loop': 'off',
      },
    },
    // KDL parser uses control chars in regexes (KDL spec whitespace/newline matching),
    // generator functions (can't be arrow), and has a structural document<->node cycle
    // KDL packages: ported from @bgotink/kdl — relaxed rules for the port
    {
      files: ['**/kdl/src/**', '**/kdl-effect/src/**'],
      rules: {
        'no-control-regex': 'off',
        'func-style': 'off',
        'import/no-cycle': 'off',
        'overeng/jsdoc-require-exports': 'off',
        'overeng/explicit-boolean-compare': 'off',
        'overeng/exports-first': 'off',
        'overeng/named-args': 'off',
      },
    },
  ],
} satisfies OxlintConfigArgs)
