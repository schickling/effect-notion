// devenv task Duration Trends dashboard
// Time-series charts tracking task durations over time with percentiles.
//
// Uses TraceQL metrics (Tempo local_blocks) to compute p50/p95/p99
// from raw trace spans. Requires:
//   - Tempo metrics_generator with local_blocks processor
//   - Grafana datasource with traceqlMetrics: true
//
// Main tasks tracked:
//   - check:quick (the most common developer workflow)
//   - buck2:check (bounded TypeScript, test, and product authority)
//   - buck2:editor:* (dependency projection)
//   - genie:run (config generation)
//   - lint:check (linting)
//   - test:run (test execution)
//   - mr:fetch-apply (repo synchronization)
//   - nix:build, nix:check (Nix operations)
local g = import 'g.libsonnet';
local lib = import 'lib.libsonnet';
local at = lib.at;

// =========================================================================
// Helper: create a duration percentile time series panel for a specific task
// =========================================================================
local taskDurationPanel(title, taskFilter, h=8) =
  lib.durationTimeSeries(
    title,
    [
      lib.tempoMetricsQuery(
        '{resource.service.name="effect-utils-devenv" && name="devenv.task.exec" && span.task.name=~"' + taskFilter + '"} | quantile_over_time(duration, 0.5) by (span.task.name)',
        'p50',
      ),
      lib.tempoMetricsQuery(
        '{resource.service.name="effect-utils-devenv" && name="devenv.task.exec" && span.task.name=~"' + taskFilter + '"} | quantile_over_time(duration, 0.95) by (span.task.name)',
        'p95',
      ),
      lib.tempoMetricsQuery(
        '{resource.service.name="effect-utils-devenv" && name="devenv.task.exec" && span.task.name=~"' + taskFilter + '"} | quantile_over_time(duration, 0.99) by (span.task.name)',
        'p99',
      ),
    ],
  );

// Helper: create a rate panel (invocations/min)
local taskRatePanel(title, taskFilter) =
  g.panel.timeSeries.new(title)
  + g.panel.timeSeries.queryOptions.withTargets([
    lib.tempoMetricsQuery(
      '{resource.service.name="effect-utils-devenv" && name="devenv.task.exec" && span.task.name=~"' + taskFilter + '"} | rate() by (span.task.name)',
      'A',
    ),
  ])
  + g.panel.timeSeries.standardOptions.withUnit('cpm')
  + g.panel.timeSeries.fieldConfig.defaults.custom.withLineWidth(1)
  + g.panel.timeSeries.fieldConfig.defaults.custom.withFillOpacity(20);

// Helper: task execution duration panel
local taskExecDurationPanel(title, taskFilter) =
  lib.durationTimeSeries(
    title,
    [
      lib.tempoMetricsQuery(
        '{resource.service.name="effect-utils-devenv" && name="devenv.task.exec" && span.task.name=~"' + taskFilter + '"} | quantile_over_time(duration, 0.5)',
        'p50',
      ),
      lib.tempoMetricsQuery(
        '{resource.service.name="effect-utils-devenv" && name="devenv.task.exec" && span.task.name=~"' + taskFilter + '"} | quantile_over_time(duration, 0.95)',
        'p95',
      ),
      lib.tempoMetricsQuery(
        '{resource.service.name="effect-utils-devenv" && name="devenv.task.exec" && span.task.name=~"' + taskFilter + '"} | quantile_over_time(duration, 0.99)',
        'p99',
      ),
    ],
  );

// Y positions for layout (each row header is 1 unit, content is 8 units)
local y = {
  // Row 1: Top-level overview
  overviewRow: 0,
  overviewContent: 1,
  // Row 2: check:quick (most common workflow)
  checkQuickRow: 9,
  checkQuickContent: 10,
  // Row 3: Dependency views + Genie
  editorRow: 18,
  editorContent: 19,
  // Row 4: Lint Components
  lintRow: 27,
  lintContent: 28,
  // Row 5: Test Execution
  testRow: 36,
  testContent: 37,
  // Row 6: Nix Operations
  nixRow: 45,
  nixContent: 46,
  // Row 7: Megarepo + Other
  megarepoRow: 54,
  megarepoContent: 55,
  // Row 8: Shell Entry Performance
  shellRow: 63,
  shellContent: 64,
  // Row 9: Per-package editor view times
  packageEditorRow: 72,
  packageEditorContent: 73,
};

g.dashboard.new('devenv task Duration Trends')
+ g.dashboard.withUid('otel-devenv-task-duration-trends')
+ g.dashboard.withDescription('Track task duration over time with p50/p95/p99 percentiles — identify regressions and improvements')
+ g.dashboard.graphTooltip.withSharedCrosshair()
+ g.dashboard.withTimezone('browser')
+ g.dashboard.time.withFrom('now-3h')  // TraceQL metrics max range is 3h by default
+ g.dashboard.time.withTo('now')
+ g.dashboard.withPanels([

  // =========================================================================
  // Row 1: Overview — all devenv task executions
  // =========================================================================
  at(g.panel.row.new('Overview — All devenv task executions'), 0, y.overviewRow, 24, 1),

  // Top-level devenv task execution durations (the wall time users experience)
  at(
    lib.durationTimeSeries(
      'devenv task execution duration (p50 / p95 / p99)',
      [
        lib.tempoMetricsQuery(
          '{resource.service.name="effect-utils-devenv" && name="devenv.task.exec"} | quantile_over_time(duration, 0.5)',
          'p50',
        ),
        lib.tempoMetricsQuery(
          '{resource.service.name="effect-utils-devenv" && name="devenv.task.exec"} | quantile_over_time(duration, 0.95)',
          'p95',
        ),
        lib.tempoMetricsQuery(
          '{resource.service.name="effect-utils-devenv" && name="devenv.task.exec"} | quantile_over_time(duration, 0.99)',
          'p99',
        ),
      ],
    ),
    0, y.overviewContent, 16, 8,
  ),

  // Invocation rate
  at(
    taskRatePanel('devenv task execution rate', '.*')
    + { fieldConfig+: { defaults+: { unit: 'cpm' } } },
    16, y.overviewContent, 8, 8,
  ),

  // =========================================================================
  // Row 2: check:quick — the most common developer workflow
  // =========================================================================
  at(g.panel.row.new('check:quick — Most Common Workflow'), 0, y.checkQuickRow, 24, 1),

  at(
    taskExecDurationPanel('check:quick total duration (p50 / p95 / p99)', 'check:quick'),
    0, y.checkQuickContent, 12, 8,
  ),

  // check:quick sub-task breakdown
  at(
    taskDurationPanel(
      'check:quick sub-tasks (p50 / p95 / p99)',
      'buck2:check|lint:check:oxlint|lint:check:format|lint:check:genie|genie:run|nix:check:quick:.*|workspace:check',
    ),
    12, y.checkQuickContent, 12, 8,
  ),

  // =========================================================================
  // Row 3: Dependency Views + Genie
  // =========================================================================
  at(g.panel.row.new('Dependency Views + Config Generation'), 0, y.editorRow, 24, 1),

  at(
    taskDurationPanel('Editor dependency views (p50 / p95 / p99)', 'buck2:editor:bootstrap|buck2:editor:publish|buck2:editor:check'),
    0, y.editorContent, 12, 8,
  ),

  at(
    taskDurationPanel('genie:run duration (p50 / p95 / p99)', 'genie:run'),
    12, y.editorContent, 12, 8,
  ),

  // =========================================================================
  // Row 4: Lint Components
  // =========================================================================
  at(g.panel.row.new('Lint Components'), 0, y.lintRow, 24, 1),

  at(
    taskDurationPanel('lint:check:oxlint (p50 / p95 / p99)', 'lint:check:oxlint'),
    0, y.lintContent, 8, 8,
  ),

  at(
    taskDurationPanel('lint:check:format (oxfmt) (p50 / p95 / p99)', 'lint:check:format'),
    8, y.lintContent, 8, 8,
  ),

  at(
    taskDurationPanel('lint:check:genie (p50 / p95 / p99)', 'lint:check:genie'),
    16, y.lintContent, 8, 8,
  ),

  // =========================================================================
  // Row 5: Test Execution
  // =========================================================================
  at(g.panel.row.new('Test Execution'), 0, y.testRow, 24, 1),

  at(
    taskDurationPanel('test:* aggregate (p50 / p95 / p99)', 'test:.*'),
    0, y.testContent, 12, 8,
  ),

  // Per-package test breakdown
  at(
    taskDurationPanel(
      'Per-package test times (p50 / p95)',
      'test:megarepo|test:genie|test:tui-react|test:tui-core|test:utils|test:notion-cli|test:notion-effect-client|test:notion-effect-schema|test:effect-path|test:effect-rpc-tanstack|test:effect-ai-claude-cli|test:oxc-config',
    ),
    12, y.testContent, 12, 8,
  ),

  // =========================================================================
  // Row 6: Nix Operations
  // =========================================================================
  at(g.panel.row.new('Nix Operations'), 0, y.nixRow, 24, 1),

  at(
    taskDurationPanel('nix:build:* (p50 / p95 / p99)', 'nix:build:.*'),
    0, y.nixContent, 8, 8,
  ),

  at(
    taskDurationPanel('nix:check:quick:* (p50 / p95 / p99)', 'nix:check:quick:.*'),
    8, y.nixContent, 8, 8,
  ),

  // =========================================================================
  // Row 7: Megarepo + Other
  // =========================================================================
  at(g.panel.row.new('Megarepo + Other'), 0, y.megarepoRow, 24, 1),

  at(
    taskDurationPanel('mr:fetch-apply (p50 / p95 / p99)', 'mr:fetch-apply'),
    0, y.megarepoContent, 8, 8,
  ),

  at(
    taskDurationPanel('mr:check (p50 / p95 / p99)', 'mr:check'),
    8, y.megarepoContent, 8, 8,
  ),

  at(
    taskDurationPanel('workspace:check (p50 / p95 / p99)', 'workspace:check'),
    16, y.megarepoContent, 8, 8,
  ),

  // =========================================================================
  // Row 8: Shell Entry Performance
  // =========================================================================
  at(g.panel.row.new('Shell Entry Performance'), 0, y.shellRow, 24, 1),

  // Shell entry uses the same service as task traces with a dedicated operation span.
  at(
    lib.durationTimeSeries(
      'Shell entry total time (p50 / p95 / p99)',
      [
        lib.tempoMetricsQuery(
          '{resource.service.name="effect-utils-devenv" && name="devenv.shell.entry"} | quantile_over_time(duration, 0.5)',
          'p50',
        ),
        lib.tempoMetricsQuery(
          '{resource.service.name="effect-utils-devenv" && name="devenv.shell.entry"} | quantile_over_time(duration, 0.95)',
          'p95',
        ),
        lib.tempoMetricsQuery(
          '{resource.service.name="effect-utils-devenv" && name="devenv.shell.entry"} | quantile_over_time(duration, 0.99)',
          'p99',
        ),
      ],
    ),
    0, y.shellContent, 12, 8,
  ),

  // Shell entry sub-tasks (setup:gate, optional tasks, devenv internals)
  at(
    taskDurationPanel(
      'Shell entry sub-tasks (p50 / p95)',
      'setup:gate|buck2:editor:bootstrap|genie:run|mr:apply|buck2:editor:publish|setup:completions|devenv:.*',
    ),
    12, y.shellContent, 12, 8,
  ),

  // =========================================================================
  // Row 9: Per-Package Editor Views
  // =========================================================================
  at(g.panel.row.new('Per-Package Editor View Times'), 0, y.packageEditorRow, 24, 1),

  at(
    taskDurationPanel(
      'Editor dependency view publication (p50 / p95)',
      'buck2:editor:publish|buck2:editor:check',
    ),
    0, y.packageEditorContent, 24, 8,
  ),

])
