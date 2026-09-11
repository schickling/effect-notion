import { CI_JOB_NAMES, type CIJobName } from '../ci.ts'

export type BuckAuthorityTranche = 'static' | 'editor' | 'rust' | 'consumer'

export type OperationDisposition =
  | 'buck-owned'
  | `buck-pending:${BuckAuthorityTranche}`
  | `outside-by-policy:${string}`

export const developerOperationDispositions = {
  'buck2:check': 'buck-owned',
  'buck2:editor:publish': 'outside-by-policy:workspace-publication',
  'buck2:typescript:materialize-dist': 'outside-by-policy:workspace-publication',
  'check:all': 'outside-by-policy:cross-boundary-aggregate',
  'check:quick': 'outside-by-policy:cross-boundary-aggregate',
  'genie:check': 'outside-by-policy:stage-zero-bootstrap-freshness',
  'genie:run': 'outside-by-policy:authoring-mutation',
  'genie:watch': 'outside-by-policy:long-lived-watcher',
  'lint:check': 'outside-by-policy:includes-stage-zero-freshness',
  'lint:fix': 'outside-by-policy:authoring-mutation',
  'nix:build': 'outside-by-policy:nix-realization',
  'nix:build:genie': 'outside-by-policy:nix-realization',
  'nix:check': 'outside-by-policy:nix-evaluation',
  'test:<pkg>': 'outside-by-policy:aggregate-includes-policy-excluded-tests',
  'test:genie': 'outside-by-policy:aggregate-includes-policy-excluded-tests',
  'test:integration': 'outside-by-policy:secret-service-integration',
  'test:run': 'outside-by-policy:aggregate-includes-policy-excluded-tests',
  'test:utils': 'outside-by-policy:aggregate-includes-policy-excluded-tests',
  'test:watch': 'outside-by-policy:long-lived-watcher',
} as const satisfies Record<string, OperationDisposition>

export type DeveloperOperation = keyof typeof developerOperationDispositions

export const ciOperationDispositions = {
  'bootstrap-cold-proof': 'outside-by-policy:bootstrap-integration',
  'bundle-smoke': 'buck-owned',
  cargo: 'outside-by-policy:aggregate-includes-rust-quality-gates',
  'ci-measurements-report': 'outside-by-policy:ci-control-plane',
  'default-ref-policy': 'outside-by-policy:pre-composition-trust-gate',
  'deploy-storybooks': 'outside-by-policy:live-deployment',
  'devenv-perf': 'outside-by-policy:operator-benchmark',
  lint: 'outside-by-policy:includes-stage-zero-freshness',
  'nix-check': 'outside-by-policy:nix-evaluation',
  'nix-closure-sizes': 'outside-by-policy:nix-realization',
  'nix-fod-check': 'outside-by-policy:nix-realization',
  'notify-alignment': 'outside-by-policy:ci-control-plane',
  'pnpm-builder-contract': 'outside-by-policy:nix-builder-contract',
  'pnpm-regression': 'outside-by-policy:nix-builder-contract',
  'source-shape': 'outside-by-policy:ci-measurement-with-run-timestamp',
  test: 'outside-by-policy:aggregate-includes-policy-excluded-tests',
  'test-integration-notion': 'outside-by-policy:secret-service-integration',
  'test-integration-restate': 'outside-by-policy:service-integration',
  'test-live-deploy-ci-tools': 'outside-by-policy:live-deployment',
  'test-megarepo-cold-gc': 'outside-by-policy:filesystem-integration',
  'test-playwright-tui-react': 'outside-by-policy:browser-integration',
  'test-playwright-utils': 'outside-by-policy:browser-integration',
  typecheck: 'buck-owned',
  weaver: 'outside-by-policy:aggregate-includes-change-relative-and-live-integration',
} as const satisfies Record<CIJobName, OperationDisposition>

export const operationDispositionProjection = {
  developerOperations: Object.entries(developerOperationDispositions).map(
    ([operation, disposition]) => ({ operation, disposition }),
  ),
  ciOperations: CI_JOB_NAMES.map((operation) => ({
    operation,
    disposition: ciOperationDispositions[operation],
  })),
} as const
