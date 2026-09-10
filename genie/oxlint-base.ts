/**
 * Shared oxlint configuration base.
 *
 * Provides common rules, categories, and overrides that can be extended by repo-specific configs.
 */

import type {
  OxlintConfigArgs,
  OxlintOverride,
} from '../packages/@overeng/genie/src/runtime/mod.ts'

type OxlintRuleSeverity = 'off' | 'warn' | 'error'

type OtelOxlintRulesArgs = {
  /** Severity for raw Effect/Stream OTEL span primitives. */
  readonly rawOtel: OxlintRuleSeverity
  /**
   * Severity for OTel semantic-convention contract constructors used outside a `*.contract.ts`
   * seam file (decision 0005). Ships WARN-only; flips per-namespace to ERROR as the registry
   * migration proceeds. Defaults to `off`.
   */
  readonly contractSeam?: OxlintRuleSeverity
  /**
   * Reserved for the second enforcement tier, after `OtelOperation` fully
   * replaces product-code `OtelSpan.unsafe*` usage.
   */
  readonly unsafeContract?: OxlintRuleSeverity
}

type StylexOxlintRulesArgs = {
  /** Severity for the whole StyleX enforcement set. Defaults to `error`. */
  readonly severity?: OxlintRuleSeverity
}

/** Standard ignore patterns for oxlint across all repos */
export const baseOxlintIgnorePatterns = [
  '**/node_modules/**',
  '**/.pnpm/**',
  '**/.pnpm-store/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/.wrangler/**',
  '**/.vercel/**',
  '**/.netlify/**',
  '**/.astro/**',
  '**/.nitro/**',
  '**/.tanstack/**',
  '**/.devenv/**',
  '**/tmp/**',
  '**/playwright-report/**',
  '**/test-results/**',
  '**/nix/**',
  '**/wip/**',
  '**/.vite/**',
  '**/patches/**',
  '**/.cache/**',
  '**/.turbo/**',
] as const

/** Standard plugins enabled across all repos */
export const baseOxlintPlugins = ['import', 'typescript', 'unicorn', 'oxc', 'react'] as const

/** Standard category severity levels */
export const baseOxlintCategories = {
  correctness: 'error',
  suspicious: 'warn',
  pedantic: 'off',
  perf: 'warn',
  style: 'off',
  restriction: 'off',
} as const satisfies OxlintConfigArgs['categories']

/**
 * Shared OTEL lint policy helper.
 *
 * Repos should use this instead of spelling raw rule names inline so the
 * cross-megarepo rollout can move from warn to error without policy drift.
 */
export const otelOxlintRules = ({
  rawOtel,
  contractSeam = 'off',
}: OtelOxlintRulesArgs): OxlintOverride['rules'] =>
  ({
    'overeng/no-raw-otel-primitives': rawOtel,
    'overeng/otel-contract-in-seam-file': contractSeam,
  }) satisfies OxlintOverride['rules']

/**
 * CSS properties whose value IS a colour, enumerated explicitly.
 *
 * A colour-shaped glob (`*olor*`) is NOT usable here, measured: it also matches
 * `colorScheme`, `colorAdjust`, `forcedColorAdjust`, `printColorAdjust` and
 * `colorInterpolation`, which take keywords and would be wrongly banned.
 *
 * Deliberately excluded even though they do take colours: `fill`, `stroke`,
 * `floodColor`, `stopColor` and `scrollbarColor`. Each legitimately accepts a
 * value an allowlist would reject — `none`, an `url(#fragment)` paint reference,
 * or a pair — so limiting them would produce false positives.
 * `overeng/stylex-no-raw-color` still covers colour literals in those values.
 */
export const stylexColorProperties = [
  'accentColor',
  'backgroundColor',
  'borderBlockColor',
  'borderBlockEndColor',
  'borderBlockStartColor',
  'borderBottomColor',
  'borderColor',
  'borderInlineColor',
  'borderInlineEndColor',
  'borderInlineStartColor',
  'borderLeftColor',
  'borderRightColor',
  'borderTopColor',
  'caretColor',
  'color',
  'columnRuleColor',
  'outlineColor',
  'textDecorationColor',
  'textEmphasisColor',
  'WebkitTapHighlightColor',
] as const

/**
 * Shared StyleX lint policy: two complementary enforcement layers.
 *
 * **Upstream** (`@stylexjs/*`, loaded via the namespace shim in
 * `@overeng/oxc-config`) owns general style validation. Its per-property value
 * limits are what close the core hazard: with a colour property limited to an
 * allowlist, a literal colour errors while a semantic token reference from a
 * `*.stylex.ts` module passes untouched. `sort-keys` is deliberately NOT enabled
 * — it fights the `property-specificity` resolution the design relies on.
 *
 * **First-party** (`overeng/stylex-*`) owns what per-property limits structurally
 * cannot reach. A value limit is keyed on one property, so it cannot see a colour
 * embedded in a composite value; measured, a colour inside a `boxShadow` and
 * inside a gradient both passed upstream validation. Banning composite properties
 * outright is not viable because they need literal offsets.
 *
 * The overlap on plain colour properties is kept on purpose: an array `limit`
 * drops its custom `reason` from the diagnostic, so only the first-party message
 * names the remedy.
 *
 * See the stylex spec's "Enforcement" section and decision 0005 Amendment 2.
 */
export const stylexOxlintRules = ({
  severity = 'error',
}: StylexOxlintRulesArgs = {}): OxlintOverride['rules'] =>
  ({
    'overeng/stylex-no-raw-color': severity,
    'overeng/stylex-outline-focus-visible-only': severity,

    '@stylexjs/valid-styles': [
      severity,
      {
        propLimits: Object.fromEntries(
          stylexColorProperties.map((property) => [
            property,
            {
              // Unioned by upstream with the CSS-wide keywords and `null`, so
              // unsetting a colour still works. Everything else — including a
              // hand-written `var()` — must come through a token reference.
              limit: ['transparent', 'currentColor', 'currentcolor'],
              // Currently dropped from the diagnostic for array limits; kept so
              // it appears if upstream starts rendering it.
              reason: 'Read colours from a semantic token exported by a `*.stylex.ts` module.',
            },
          ]),
        ),
      },
    ] as const,
    '@stylexjs/valid-shorthands': severity,
    '@stylexjs/no-unused': severity,
    '@stylexjs/no-legacy-contextual-styles': severity,
    '@stylexjs/no-lookahead-selectors': severity,
    '@stylexjs/enforce-extension': severity,
  }) satisfies OxlintOverride['rules']

/** Standard rules shared across all repos */
export const baseOxlintRules = {
  // Disallow dynamic import() and require() - helps with static analysis and bundling
  'import/no-dynamic-require': ['warn', { esmodule: true }],

  // Disallow re-exports except in mod.ts entry points
  'oxc/no-barrel-file': ['warn', { threshold: 0 }],

  // Enforce named arguments (options objects) instead of positional parameters.
  // Enforced (error): product code is swept clean; test DSLs / external-interface
  // impls are exempted by override or inline disable.
  'overeng/named-args': 'error',

  // Disallow CommonJS (require/module.exports) - enforce ESM
  'import/no-commonjs': 'error',

  // Detect circular dependencies
  'import/no-cycle': 'warn',

  // Avoid sequential awaits in loops; enforced (error). Tests + intentional
  // retry/poll loops are exempted by override or inline disable.
  'no-await-in-loop': 'error',

  // oxlint 1.82 introduced `no-underscore-dangle` in the `suspicious` category
  // (1.39 did not implement it), which reports ~1.8k sites here — nearly all of
  // them `_tag`, Effect's tagged-union discriminant. The rule keeps its value
  // for names we DO own, so it stays enabled with an explicit allow list for the
  // identifiers whose spelling belongs to someone else:
  //   - `_tag`: Effect's discriminant, present on every tagged struct/error.
  //   - `_page_id`, `_nds_outbox`: Notion API and NDS outbox wire names.
  //   - `_idleTimeout`, `_getActiveHandles`, `_getActiveRequests`: undocumented
  //     Node internals the active-handle debugger reads.
  //   - `__stylexCollectCss`: the global `@stylexjs/unplugin` installs for CSS
  //     collection, read by the node StyleX bridge.
  //   - `try_`, `expect_`, `PtySpec_`: trailing underscore because `try`/`expect`
  //     are reserved/shadowing and `PtySpec` is the type of the same name.
  // The repo's OTHER underscore idiom — `_x` for an intentionally unused binding,
  // which `no-unused-vars` requires — is relaxed per file class in the overrides
  // below, not globally, so a new dangling name in `src` is still reported.
  'no-underscore-dangle': [
    'warn',
    {
      allow: [
        '_tag',
        '_page_id',
        '_nds_outbox',
        '_idleTimeout',
        '_getActiveHandles',
        '_getActiveRequests',
        '__stylexCollectCss',
        'try_',
        'expect_',
        'PtySpec_',
      ],
    },
  ],

  // Prefer function expressions over declarations. Enforced (error).
  'func-style': ['error', 'expression', { allowArrowFunctions: true }],

  // Enforce explicit boolean-literal comparisons in condition positions. Enforced (error).
  'overeng/explicit-boolean-compare': 'error',

  // Enforce exported declarations come before non-exported declarations. Enforced (error).
  'overeng/exports-first': 'error',

  // Require JSDoc comments on exported declarations. Enforced (error): every
  // published package `src` export must carry JSDoc. Non-API surfaces (test
  // files, stories, config, genie tooling, examples, incubation waivers) are
  // exempted by the overrides below / in the repo-specific config.
  'overeng/jsdoc-require-exports': 'error',

  // Enforce proper type imports
  'typescript/consistent-type-imports': 'warn',

  // Two type-aware rules that arrive with oxlint 1.82: 1.39 could not speak the
  // tsgolint 7 protocol, so `--type-aware` reported nothing at all and neither
  // rule was ever enforced here. Both are off for reasons specific to this
  // codebase's idioms, not to reduce noise:
  //
  // `consistent-return` reports 252 sites, and the shape is almost always an
  // exhaustive `switch` over an Effect tagged union where every case returns.
  // `noImplicitReturns` is on (genie/external.ts) and `tsgo` is green, so the
  // compiler already proves those functions always return; the rule only wants
  // an unreachable trailing `return` after the switch.
  //
  // `no-unnecessary-type-parameters` reports 50 sites, starting with the
  // `TypeEq<A, B>` identity trick in `@overeng/utils`, where the single-use
  // `<T>` IS the mechanism being tested. Its remaining reports are generic
  // signatures whose parameter counts are public API, so "fixing" them would
  // be an API change rather than a cleanup.
  'typescript/consistent-return': 'off',
  'typescript/no-unnecessary-type-parameters': 'off',

  // OTEL raw primitive enforcement is enabled through generated repo overrides.
  'overeng/no-raw-otel-primitives': 'off',
  // OTel contract seam-file enforcement (decision 0005) — enabled WARN-only via repo overrides.
  'overeng/otel-contract-in-seam-file': 'off',

  // Don't enforce type vs interface
  'typescript/consistent-type-definitions': 'off',

  // Disallow usage of deprecated APIs (requires --type-aware)
  'typescript/no-deprecated': 'error',

  // =============================================================================
  // Type-aware rules - temporarily disabled
  // These rules require --type-aware mode. Re-enable incrementally after cleanup.
  // =============================================================================

  // TODO: Re-enable - warns about unsafe type assertions (325 occurrences)
  'typescript/no-unsafe-type-assertion': 'off',

  // TODO: Re-enable - detects unnecessary type arguments (54 occurrences)
  'typescript/no-unnecessary-type-arguments': 'off',

  // TODO: Re-enable - detects unnecessary type assertions (48 occurrences)
  'typescript/no-unnecessary-type-assertion': 'off',

  // Keep off — conflicts with overeng/explicit-boolean-compare (team prefers explicit comparisons)
  'typescript/no-unnecessary-boolean-literal-compare': 'off',

  // TODO: Re-enable - detects misused spread operators (18 occurrences)
  'typescript/no-misused-spread': 'off',

  // TODO: Re-enable - detects redundant type constituents (12 occurrences)
  'typescript/no-redundant-type-constituents': 'off',

  // TODO: Re-enable - detects floating promises (9 occurrences)
  'typescript/no-floating-promises': 'off',

  // TODO: Re-enable - detects improper toString usage (6 occurrences)
  'typescript/no-base-to-string': 'off',

  // TODO: Re-enable - detects unsafe enum comparisons (5 occurrences)
  'typescript/no-unsafe-enum-comparison': 'off',

  // TODO: Re-enable - detects unbound methods (4 occurrences)
  'typescript/unbound-method': 'off',

  // TODO: Re-enable - restricts template expression types (3 occurrences)
  'typescript/restrict-template-expressions': 'off',

  // TODO: Re-enable - detects duplicate type constituents (3 occurrences)
  'typescript/no-duplicate-type-constituents': 'off',

  // TODO: Re-enable - detects unsafe unary minus (1 occurrence)
  'typescript/no-unsafe-unary-minus': 'off',

  // TODO: Re-enable - detects unnecessary template expressions (1 occurrence)
  'typescript/no-unnecessary-template-expression': 'off',

  // =============================================================================
  // React rules
  // =============================================================================

  // Not needed with react-jsx transform (React 17+)
  'react/react-in-jsx-scope': 'off',

  // Enforce rules of hooks — promote from pedantic (off) to error
  'react/rules-of-hooks': 'error',

  // React Compiler rules require compiler-compatible component idioms that this codebase has not adopted.
  'react/globals': 'off',
  'react/immutability': 'off',
  'react/purity': 'off',
  'react/refs': 'off',
  'react/set-state-in-effect': 'off',
  // The rest of the same family, enabled by category in oxlint 1.82. The first
  // two are also strict supersets of the classic hooks rules kept below, so
  // leaving them on reports every rules-of-hooks / exhaustive-deps defect twice
  // under two different rule ids. `capitalized-calls` and `memo-dependencies`
  // read plain capitalized helpers (Effect `Schema.Struct`, TUI `Text`) and
  // hand-written memo dependency lists as compiler inputs, which they are not.
  'react/hooks': 'off',
  'react/exhaustive-effect-dependencies': 'off',
  'react/memo-dependencies': 'off',
  'react/capitalized-calls': 'off',

  // Warn on missing/extra hook dependencies
  'react/exhaustive-deps': 'warn',
} as const satisfies OxlintConfigArgs['rules']

/** Rules to disable for generated files */
export const generatedFilesRules = {
  'func-style': 'off',
  'import/no-commonjs': 'off',
  'import/no-named-as-default': 'off',
  'import/no-unassigned-import': 'off',
  'oxc/no-barrel-file': 'off',
  'oxc/no-map-spread': 'off',
  'overeng/exports-first': 'off',
  'overeng/jsdoc-require-exports': 'off',
  'overeng/named-args': 'off',
  'overeng/no-raw-otel-primitives': 'off',
  'unicorn/consistent-function-scoping': 'off',
} as const satisfies OxlintOverride['rules']

/** Standard overrides shared across all repos */
export const baseOxlintOverrides = [
  // Allow re-exports in mod.ts entry point files
  {
    files: ['**/mod.ts'],
    rules: { 'oxc/no-barrel-file': 'off' },
  },
  // Storybook story files (*.stories.*)
  {
    files: ['**/*.stories.tsx', '**/*.stories.ts', '**/*.stories.jsx'],
    rules: {
      // Relaxed rules for story files
      'overeng/exports-first': 'off',
      'overeng/jsdoc-require-exports': 'off',
      // Storybook CSF best practices (native overeng/storybook/* rules)
      'overeng/storybook/meta-satisfies-type': 'error',
      'overeng/storybook/default-exports': 'error',
      'overeng/storybook/story-exports': 'warn',
      'overeng/storybook/csf-component': 'warn',
      'overeng/storybook/hierarchy-separator': 'warn',
      'overeng/storybook/no-redundant-story-name': 'warn',
      'overeng/storybook/prefer-pascal-case': 'warn',
    },
  },
  // Storybook story fixtures (stories/_fixtures.ts, stories/_*.ts)
  {
    files: ['**/stories/_*.ts', '**/stories/_*.tsx'],
    rules: {
      'overeng/exports-first': 'off',
      'overeng/jsdoc-require-exports': 'off',
      // Story fixtures bind renderer output they only need for its type or for
      // one assertion, and mark the unused halves with the repo's `_x` prefix.
      'no-underscore-dangle': 'off',
    },
  },
  // Storybook config files (.storybook/*) - not story files
  {
    files: ['**/.storybook/**'],
    rules: {
      'overeng/exports-first': 'off',
      'overeng/jsdoc-require-exports': 'off',
      'import/no-unassigned-import': 'off',
    },
  },
  // Config files don't need JSDoc
  {
    files: ['**/vitest.config.ts', '**/vite.config.ts', '**/playwright.config.ts'],
    rules: { 'overeng/jsdoc-require-exports': 'off' },
  },
  // Test files have more relaxed rules
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx', '**/test/**'],
    rules: {
      'overeng/named-args': 'off',
      'overeng/no-raw-otel-primitives': 'off',
      'unicorn/no-array-sort': 'off',
      'unicorn/consistent-function-scoping': 'off',
      'require-yield': 'off',
      // Sequential awaits in a loop (polling deadlines, ordered setup/assertions)
      // are idiomatic and correct in tests; parallelizing them is pointless or
      // wrong. Tests are not throughput-critical, so the advisory is relaxed here.
      'no-await-in-loop': 'off',
      // Test files carry the two underscore/shadow idioms this repo relies on:
      // `_x` for a binding kept for shape but intentionally unused (which
      // `no-unused-vars` requires), and harnesses that hand a scoped `it` (or
      // `resolve`, `provider`) back into a callback, deliberately shadowing the
      // imported one. Both are reported by rules new to oxlint 1.82.
      'no-underscore-dangle': 'off',
      'no-shadow': 'off',
    },
  },
  // Declaration files can use inline import() type annotations
  {
    files: ['**/*.d.ts'],
    rules: { 'typescript/consistent-type-imports': 'off' },
  },
  // Generated files (*.gen.*)
  {
    files: ['**/*.gen.*'],
    rules: generatedFilesRules,
  },
] as const satisfies OxlintConfigArgs['overrides']
